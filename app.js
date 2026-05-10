import { register as registerAIReviewCommitStatus } from "./lib/ai-review-commit-status.js";
import { register as registerStripAugmentLinks } from "./lib/strip-augment-links.js";

export default (app) => {
  registerAIReviewCommitStatus(app);
  registerStripAugmentLinks(app);
};
