// Hands the review to Dusty when Auggie says it can't do it — the out-of-credits
// reply being the case that prompted this. Without it an "auggie review" just
// stops there, and whoever asked has to notice and summon someone else.
//
// Only Auggie's own failure reply triggers the handoff, so a review that is
// merely slow is left alone.

import {
  AUGMENT_UNABLE_TO_REVIEW,
  AUGMENTCODE_BOT_LOGIN,
  BOT,
  isBotUser,
  isProviderSummonable,
  summonCommandProvider,
  triggerDustyReviewer,
} from "./ai-reviewers.js";
import { loadAiReviewConfig } from "./config.js";
import { TRIGGER_AUGMENT_PHRASES } from "./trigger-ai-review.js";

const at = (value) => new Date(value ?? 0).getTime();

export function isAugmentFailureComment(comment) {
  if (!isBotUser(comment?.user)) return false;
  if (!AUGMENTCODE_BOT_LOGIN.test(comment.user.login ?? "")) return false;
  return AUGMENT_UNABLE_TO_REVIEW.test(comment.body ?? "");
}

// Who the review was for: the last person to ask Auggie for one before it gave
// up, falling back to the PR author. Most summons come from this app rather
// than a typed comment, so the fallback is the common path — and Dusty needs a
// real org member behind the mention either way.
export function failedReviewRequester(comments, { failedAt, prAuthor }) {
  let requester = null;
  let requestedAt = null;
  for (const comment of comments) {
    if (isBotUser(comment.user)) continue;
    const body = comment.body ?? "";
    const asked = summonCommandProvider(body) === BOT.Augment || TRIGGER_AUGMENT_PHRASES.test(body);
    if (!asked) continue;
    const createdAt = at(comment.created_at);
    if (createdAt > failedAt) continue;
    if (requestedAt === null || createdAt >= requestedAt) {
      requestedAt = createdAt;
      requester = comment.user?.login ?? null;
    }
  }
  return requester ?? prAuthor ?? null;
}

export function register(app) {
  app.on(["issue_comment.created", "issue_comment.edited"], async (context) => {
    const { issue, comment } = context.payload;

    if (!issue?.pull_request) return;
    if (!isAugmentFailureComment(comment)) return;

    const { owner, repo } = context.repo();
    const config = await loadAiReviewConfig(context);

    if (!isProviderSummonable(config, BOT.Dusty)) return;

    const comments = await context.octokit.paginate(
      context.octokit.rest.issues.listComments,
      { owner, repo, issue_number: issue.number, per_page: 100 }
    );

    // Auggie edits this comment, and a failure can repeat across pushes, so the
    // handoff only happens once per failure: a Dusty summon already standing
    // after it means this has been dealt with.
    const failedAt = at(comment.created_at);
    const handedOff = comments.some(
      (c) => summonCommandProvider(c.body) === BOT.Dusty && at(c.created_at) >= failedAt
    );
    if (handedOff) return;

    // Dusty takes a mention from a person, not from this app, so a handoff with
    // nobody behind it would be dropped on arrival.
    const actor = failedReviewRequester(comments, {
      failedAt,
      prAuthor: issue.user?.login,
    });
    if (!actor) return;

    await triggerDustyReviewer(context.octokit, {
      owner,
      repo,
      issue_number: issue.number,
      config,
      actor,
    });
  });
}
