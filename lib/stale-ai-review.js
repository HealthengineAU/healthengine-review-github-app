// Lines added since the last AI review, diffing PR-diff to PR-diff so rebases and base merges don't count.

import {
  canSummonReviewer,
  getDiffSize,
  getLinesAdded,
  isBotUser,
  triggerRandomReviewer,
} from "./ai-reviewers.js";
import { isAutoReviewEligible } from "./auto-trigger-ai-review.js";
import { matchesFilterPatterns } from "./filter-patterns.js";

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map();

const INVITE_TTL_MS = 60 * 60_000;
const invited = new Map();

export function latestAiReview(reviews = []) {
  let latest = null;
  for (const review of reviews) {
    if (!isBotUser(review.user)) continue;
    if (!latest || new Date(review.submitted_at ?? 0) >= new Date(latest.submitted_at ?? 0)) {
      latest = review;
    }
  }
  return latest;
}

// GitHub omits `patch` on very large files; when either side lacks one, count additions growth instead.
export function countLinesAddedSince(before, after, ignorePaths = []) {
  const counted = (file) => !matchesFilterPatterns(ignorePaths, file.filename);
  const reviewedFiles = new Map(before.map((file) => [file.filename, file]));

  const addedLines = (patch) => {
    const lines = new Map();
    for (const line of patch.split("\n")) {
      if (line.startsWith("+")) lines.set(line, (lines.get(line) ?? 0) + 1);
    }
    return lines;
  };

  let linesAdded = 0;
  let prAdditions = 0;
  for (const file of after.filter(counted)) {
    const reviewedFile = reviewedFiles.get(file.filename);
    prAdditions += file.additions ?? 0;

    if (file.patch == null || (reviewedFile && reviewedFile.patch == null)) {
      linesAdded += Math.max(0, (file.additions ?? 0) - (reviewedFile?.additions ?? 0));
      continue;
    }

    const reviewed = addedLines(reviewedFile?.patch ?? "");
    for (const [line, count] of addedLines(file.patch)) {
      linesAdded += Math.max(0, count - (reviewed.get(line) ?? 0));
    }
  }

  return { linesAdded, prAdditions };
}

async function prFiles(octokit, { owner, repo, base, sha }) {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${sha}`,
    per_page: 1,
  });
  return data?.files ?? [];
}

export async function measureStaleReview(octokit, { owner, repo, pr, reviews, staleDetection }) {
  const review = latestAiReview(reviews);
  const reviewedSha = review?.commit_id;
  const headSha = pr.head?.sha;
  const base = pr.base?.ref;
  if (!reviewedSha || !headSha || !base || reviewedSha === headSha) return null;

  const key = `${owner}/${repo}:${base}:${reviewedSha}...${headSha}`;
  let counts = cache.get(key)?.expires > Date.now() ? cache.get(key).counts : null;

  if (!counts) {
    try {
      const [before, after] = await Promise.all([
        prFiles(octokit, { owner, repo, base, sha: reviewedSha }),
        prFiles(octokit, { owner, repo, base, sha: headSha }),
      ]);
      counts = countLinesAddedSince(before, after, staleDetection.ignorePaths);
    } catch (err) {
      console.warn(`[stale-review] Couldn't compare ${owner}/${repo}#${pr.number} against its last AI review`, err);
      return null;
    }

    const now = Date.now();
    for (const [cachedKey, entry] of cache) {
      if (entry.expires <= now) cache.delete(cachedKey);
    }
    cache.set(key, { expires: now + CACHE_TTL_MS, counts });
  }

  const limit = Math.floor(Math.max(staleDetection.minLines, (staleDetection.percent / 100) * counts.prAdditions));

  return {
    linesAdded: counts.linesAdded,
    limit,
    stale: counts.linesAdded > limit,
  };
}

export async function inviteReReview(octokit, { owner, repo, pr, config }) {
  if (!canSummonReviewer(config)) return;
  if (!isAutoReviewEligible({ aiReview: config.aiReview, repo, pr })) return;

  const key = `${owner}/${repo}#${pr.number}@${pr.head.sha}`;
  const now = Date.now();
  for (const [invitedKey, expires] of invited) {
    if (expires <= now) invited.delete(invitedKey);
  }
  if (invited.has(key)) return;
  invited.set(key, now + INVITE_TTL_MS);

  await triggerRandomReviewer(octokit, {
    owner,
    repo,
    issue_number: pr.number,
    config,
    diffSize: getDiffSize(pr),
    linesAdded: getLinesAdded(pr),
    actor: pr.user?.login,
  });
}
