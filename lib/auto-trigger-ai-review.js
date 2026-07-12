// Automatically invites a random enabled AI reviewer when a pull request
// enters the ready state (opened non-draft, marked ready for review, or
// reopened) and no AI review has been completed or requested yet.
//
// The org can opt repos/authors out and bound the eligible diff size via the
// `auto_review` section of .github/healthengine-review.yml (see config.js).

import {
  BOT,
  SKIP_LABEL,
  detectPendingAiReviewRequests,
  hasCompletedAiReview,
  isBotUser,
  triggerRandomReviewer,
} from "./ai-reviewers.js";
import { loadAiReviewConfig } from "./config.js";

// The config gate: kill switch, repo/author exclusions, and diff-size bounds
// (inclusive, additions + deletions).
export function isAutoReviewEligible({ autoReview, repo, pr }) {
  if (!autoReview.enabled) return false;
  if (autoReview.excludeRepos.has(repo.toLowerCase())) return false;

  const author = pr.user?.login?.toLowerCase() ?? "";
  if (autoReview.excludeAuthors.has(author)) return false;

  const diffSize = (pr.additions ?? 0) + (pr.deletions ?? 0);
  return diffSize >= autoReview.minDiffSize && diffSize <= autoReview.maxDiffSize;
}

export function register(app) {
  app.on([
    "pull_request.opened",
    "pull_request.ready_for_review",
    "pull_request.reopened",
  ], async (context) => {
    const pr = context.payload.pull_request;

    // Drafts get their invite when they're marked ready; bot authors
    // (dependabot & co) are skipped just like the commit status skips them.
    if (pr.draft) return;
    if (isBotUser(pr.user)) return;
    if ((pr.labels || []).some((label) => label.name === SKIP_LABEL)) return;

    const { owner, repo } = context.repo();
    const config = await loadAiReviewConfig(context);

    if (!isAutoReviewEligible({ autoReview: config.autoReview, repo, pr })) {
      return;
    }

    // Anything already reviewed or in flight (a requested Copilot, an Auggie
    // summon, an AI-review team request) means no automatic invite. Matters
    // mostly for ready_for_review/reopened, where a review can predate the event.
    const pull_number = pr.number;
    const [reviews, issueComments] = await Promise.all([
      context.octokit.paginate(context.octokit.rest.pulls.listReviews, {
        owner, repo, pull_number, per_page: 50,
      }),
      context.octokit.paginate(context.octokit.rest.issues.listComments, {
        owner, repo, issue_number: pull_number, per_page: 100,
      }),
    ]);

    if (hasCompletedAiReview(reviews)) return;

    const pendingRequests = detectPendingAiReviewRequests({
      pr,
      issueComments,
      reviews,
      augmentEnabled: config.isProviderEnabled(BOT.Augment),
    });
    if (pendingRequests.length > 0) return;

    await triggerRandomReviewer(context.octokit, {
      owner,
      repo,
      issue_number: pull_number,
      config,
    });
  });
}
