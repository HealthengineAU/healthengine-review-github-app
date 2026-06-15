import { register as registerAIReviewCommitStatus } from "./lib/ai-review-commit-status.js";
import { register as registerCleanAiReviewComments } from "./lib/clean-ai-review-comments.js";
import { register as registerTriggerAiReview } from "./lib/trigger-ai-review.js";

export default (app) => {
  registerAIReviewCommitStatus(app);
  registerCleanAiReviewComments(app);
  registerTriggerAiReview(app);
};
