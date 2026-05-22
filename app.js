import { register as registerAIReviewCommitStatus } from "./lib/ai-review-commit-status.js";
import { register as registerCleanAiReviewComments } from "./lib/clean-ai-review-comments.js";

export default (app) => {
  registerAIReviewCommitStatus(app);
  registerCleanAiReviewComments(app);
};
