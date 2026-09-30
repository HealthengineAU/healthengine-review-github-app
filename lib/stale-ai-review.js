// Lines added since the last AI review, diffing PR-diff to PR-diff so rebases and base merges don't count.

import { isBotUser } from "./ai-reviewers.js";
import { matchesFilterPatterns } from "./filter-patterns.js";

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map();

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

// GitHub omits `patch` on very large files; count their additions growth instead.
export function countLinesAddedSince(before, after, ignorePaths = []) {
  const counted = (file) => !matchesFilterPatterns(ignorePaths, file.filename);

  const addedLines = (files) => {
    const lines = new Map();
    for (const file of files) {
      if (!counted(file) || file.patch == null) continue;
      for (const line of file.patch.split("\n")) {
        if (!line.startsWith("+")) continue;
        const key = `${file.filename}\n${line}`;
        lines.set(key, (lines.get(key) ?? 0) + 1);
      }
    }
    return lines;
  };

  const reviewed = addedLines(before);
  let linesAdded = 0;
  for (const [key, count] of addedLines(after)) {
    linesAdded += Math.max(0, count - (reviewed.get(key) ?? 0));
  }

  const reviewedAdditions = new Map(before.map((file) => [file.filename, file.additions ?? 0]));
  for (const file of after) {
    if (!counted(file) || file.patch != null) continue;
    linesAdded += Math.max(0, (file.additions ?? 0) - (reviewedAdditions.get(file.filename) ?? 0));
  }

  const prAdditions = after.filter(counted).reduce((sum, file) => sum + (file.additions ?? 0), 0);

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

export async function measureStaleReview(octokit, { owner, repo, pr, reviews, staleReview }) {
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
      counts = countLinesAddedSince(before, after, staleReview.ignorePaths);
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

  const limit = Math.floor(Math.max(staleReview.minLines, (staleReview.percent / 100) * counts.prAdditions));

  return {
    reviewer: review.user.login,
    linesAdded: counts.linesAdded,
    limit,
    stale: counts.linesAdded > limit,
  };
}
