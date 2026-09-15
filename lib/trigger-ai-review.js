// Manual AI-review triggers. Lets team members summon a review with a bit of
// personality: commenting "roast me, auggie" (or any comment mentioning both
// "roast me" and "auggie") makes the bot reply with the literal `auggie review`
// trigger. Also handles the `ai-review` label and AI-review team requests.
//
// Reviewer identity and the actual summoning live in ai-reviewers.js.

import {
  AI_REVIEW_TEAM,
  PROVIDER_DISPLAY_NAMES,
  getBotKey,
  getDiffSize,
  getLinesAdded,
  isBotUser,
  isProviderSummonable,
  providerForReviewTeam,
  triggerAugmentReviewer,
  triggerCopilotReviewer,
  triggerDustyReviewer,
  triggerRandomReviewer,
} from "./ai-reviewers.js";
import { loadAiReviewConfig } from "./config.js";

// Any of these phrases anywhere in the comment summons a review.
export const TRIGGER_AUGMENT_PHRASES = /roast me.*auggie|auggie please/i;
export const TRIGGER_COPILOT_PHRASES = /roast me.*copilot|copilot please|copilot review/i;
export const TRIGGER_RANDOM_PHRASES = /^\s*`*\s*ai review\s*`*\s*$|random ai review/i;

// Adding this label to a PR also summons a review; it's removed once handled.
export const TRIGGER_LABEL = /ai[\s-]review/i;
export const SKIP_TRIGGER_LABEL = /no|skip/i;

// Don't fire if the comment is already an Augment/Augment-review trigger —
// no point summoning a review that's already being requested.
export const ALREADY_TRIGGERING_AUGMENT_PHRASES = /auggie review|augment review|augmentcode review/i;

// How a provider-named team request summons its provider.
const PROVIDER_TRIGGERS = {
  augment: triggerAugmentReviewer,
  copilot: triggerCopilotReviewer,
  dusty: triggerDustyReviewer,
};

// Tell the requester a provider they explicitly summoned isn't enabled here.
async function notifyProviderDisabled(
  octokit,
  { owner, repo, issue_number, provider, config }
) {
  const name = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
  const currentProviderList = [...config.providers].map(p => ` - ${PROVIDER_DISPLAY_NAMES[p] ?? p}`).join("\n");
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number,
    body: `**${name}** is not currently available. Active providers ([source](https://github.com/${owner}/.github/blob/main/.github/healthengine-review.yml)) are:\n${currentProviderList || "- _None available!_"}`,
  });
}

export function register(app) {
  app.on(["issue_comment.created"], async (context) => {
    const { issue, comment } = context.payload;

    // Only on pull requests, and never react to our own/other bots' comments.
    if (!issue.pull_request) return;
    if (isBotUser(comment.user)) return;

    const { owner, repo } = context.repo();
    const { body } = comment;

    if (!body) return;
    if (ALREADY_TRIGGERING_AUGMENT_PHRASES.test(body)) return;

    const config = await loadAiReviewConfig(context);

    // An explicitly-summoned provider that isn't enabled here, or the random
    // pool when only generic phrases are used.
    let explicitProvider = null;
    let triggerReviewFn = null;

    if (TRIGGER_COPILOT_PHRASES.test(body)) {
      explicitProvider = "copilot";
      triggerReviewFn = triggerCopilotReviewer;
    } else if (TRIGGER_AUGMENT_PHRASES.test(body)) {
      explicitProvider = "augment";
      triggerReviewFn = triggerAugmentReviewer;
    } else if (TRIGGER_RANDOM_PHRASES.test(body)) {
      triggerReviewFn = triggerRandomReviewer;
    }

    if (!triggerReviewFn) return;

    if (explicitProvider && !config.isProviderEnabled(explicitProvider)) {
      await notifyProviderDisabled(context.octokit, {
        owner,
        repo,
        issue_number: issue.number,
        provider: explicitProvider,
        config,
      });

      // Acknowledge with 👎
      await context.octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: comment.id,
        content: "-1",
      });

      return;
    }

    // An issue_comment payload has no line counts, and without them the random
    // pick silently widens to every enabled provider, ignoring provider_groups.
    let sizes = null;
    if (triggerReviewFn === triggerRandomReviewer) {
      let pull_request = null;
      try {
        ({ data: pull_request } = await context.octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: issue.number,
        }));
      } catch {
        return;
      }
      const known = (v) => typeof v === "number" && Number.isFinite(v);
      if (!known(pull_request?.additions) || !known(pull_request?.deletions)) return;
      sizes = {
        diffSize: getDiffSize(pull_request),
        linesAdded: getLinesAdded(pull_request),
      };
    }

    // Acknowledge with 👍
    await context.octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: comment.id,
      content: "+1",
    });

    await triggerReviewFn(context.octokit, {
      owner,
      repo,
      issue_number: issue.number,
      config,
      actor: comment.user?.login,
      ...sizes,
    });
  });

  app.on(["pull_request.labeled"], async (context) => {
    const { pull_request, label, sender } = context.payload;

    const name = label?.name ?? "";

    if (!TRIGGER_LABEL.test(name) || SKIP_TRIGGER_LABEL.test(name)) {
      return;
    }

    const { owner, repo } = context.repo();

    // Remove the label so re-adding it can summon another review.
    await context.octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: pull_request.number,
      name,
    });

    const config = await loadAiReviewConfig(context);

    await triggerRandomReviewer(context.octokit, {
      owner,
      repo,
      issue_number: pull_request.number,
      config,
      diffSize: getDiffSize(pull_request),
      linesAdded: getLinesAdded(pull_request),
      actor: sender?.login,
    });
  });

  app.on(["pull_request.review_requested"], async (context) => {
    const { pull_request, requested_team, sender } = context.payload;

    if (!requested_team) {
      return;
    }

    const { owner, repo } = context.repo();

    const requestedProvider = providerForReviewTeam(requested_team);
    const isAnyAIRequested = AI_REVIEW_TEAM.test(requested_team.slug) || AI_REVIEW_TEAM.test(requested_team.name);

    if (!requestedProvider && !isAnyAIRequested) {
      return;
    }

    const config = await loadAiReviewConfig(context);

    if (requestedProvider) {
      if (!isProviderSummonable(config, requestedProvider)) {
        // Not available here: don't summon, but still clear the bogus team
        // request so it doesn't sit as a pending reviewer, and explain why.
        try {
          await context.octokit.pulls.removeRequestedReviewers({
            ...context.pullRequest(),
            reviewers: [],
            team_reviewers: [requested_team.slug],
          });
        } catch {
          // swallow errors
        }

        await notifyProviderDisabled(context.octokit, {
          owner,
          repo,
          issue_number: pull_request.number,
          provider: requestedProvider,
          config,
        });

        return;
      }

      // Explicitly summoned: trigger the review but leave the team request in
      // place. It's removed later
      await PROVIDER_TRIGGERS[requestedProvider](context.octokit, {
        owner,
        repo,
        issue_number: pull_request.number,
        config,
        actor: sender?.login,
      });

      return;
    }

    try {
      await context.octokit.pulls.removeRequestedReviewers({
        ...context.pullRequest(),
        reviewers: [],
        team_reviewers: [requested_team.slug],
      });
    } catch {
      // swallow errors
    }

    await triggerRandomReviewer(context.octokit, {
      owner,
      repo,
      issue_number: pull_request.number,
      config,
      diffSize: getDiffSize(pull_request),
      linesAdded: getLinesAdded(pull_request),
      actor: sender?.login,
    });
  });

  app.on(["pull_request_review.submitted"], async (context) => {
    const { pull_request, review } = context.payload;

    // Bots only: provider keys are login substrings, so a human login carrying
    // one would otherwise clear that provider's request.
    const provider = isBotUser(review.user) ? getBotKey(review.user?.login) : null;

    if (!provider) {
      return;
    }

    // The team request that summoned this provider has done its job.
    const teamSlugs = (pull_request.requested_teams || [])
      .filter((team) => providerForReviewTeam(team) === provider)
      .map((team) => team.slug);

    if (teamSlugs.length > 0) {
      try {
        await context.octokit.pulls.removeRequestedReviewers({
            ...context.pullRequest(),
          reviewers: [],
          team_reviewers: teamSlugs,
        });
      } catch {
        // swallow errors
      }
    }
  });
}
