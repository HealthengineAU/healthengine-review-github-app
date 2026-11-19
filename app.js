import { register as registerAgentProxies } from "./lib/agent-proxies.js";
import { register as registerAIReviewCommitStatus } from "./lib/ai-review-commit-status.js";
import { register as registerAutoTriggerAiReview } from "./lib/auto-trigger-ai-review.js";
import { register as registerCleanAiReviewComments } from "./lib/clean-ai-review-comments.js";
import { register as registerDismissBotApprovals } from "./lib/dismiss-bot-approvals.js";
import { register as registerDustySlackProxy } from "./lib/dusty-slack-proxy.js";
import { register as registerIncidentCommand } from "./lib/incident/index.js";
import { register as registerLinkIssueKeys } from "./lib/link-issue-keys.js";
import { register as registerTriggerAiReview } from "./lib/trigger-ai-review.js";
import { register as registerUiReviewApprovals } from "./lib/ui-review-approvals.js";
import { withRateLimitLog } from "./lib/rate-limit-log.js";

// A crash drops every pending debounced update, so log stray rejections instead.
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

// Probot calls this with (app, { getRouter, cwd }) — getRouter is only present
// when running under the HTTP server, and is what mounts non-webhook routes.
export default (probotApp, options = {}) => {
  const app = withRateLimitLog(probotApp);
  registerAgentProxies(app);
  registerAIReviewCommitStatus(app);
  registerAutoTriggerAiReview(app);
  registerCleanAiReviewComments(app);
  registerDismissBotApprovals(app);
  registerDustySlackProxy(app, options);
  registerIncidentCommand(app, options);
  registerLinkIssueKeys(app);
  registerTriggerAiReview(app);
  registerUiReviewApprovals(app);
};
