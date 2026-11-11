import { loadAiReviewConfig } from "./config.js";
import { matchesFilterPatterns } from "./filter-patterns.js";

const MESSAGE = "Bot approvals don't count — a human needs to approve this pull request.";

export function shouldDismiss(review, patterns) {
  return (
    review?.state?.toLowerCase() === "approved" &&
    review.user?.type === "Bot" &&
    matchesFilterPatterns(patterns, review.user.login ?? "")
  );
}

export function register(app) {
  app.on("pull_request_review.submitted", async (context) => {
    const { review } = context.payload;
    if (review?.state?.toLowerCase() !== "approved") return;

    const config = await loadAiReviewConfig(context);
    if (!shouldDismiss(review, config.dismissBotApprovals.authors)) return;

    try {
      await context.octokit.rest.pulls.dismissReview({
        ...context.pullRequest(),
        review_id: review.id,
        message: MESSAGE,
      });
    } catch (err) {
      console.error(`[dismiss-bot-approvals] Failed to dismiss review ${review.id} by ${review.user.login}`, err);
    }
  });
}
