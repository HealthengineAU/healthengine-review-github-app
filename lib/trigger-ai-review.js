// Lets team members summon an Augment review with a bit of personality:
// commenting "roast me, auggie" (or any comment mentioning both "roast me"
// and "auggie") makes the bot reply with the literal `auggie review` trigger.
//
// This exists purely to make people laugh — the real work is done by the
// `auggie review` command we echo back.

import { loadAiReviewConfig } from "./config.js";

// Any of these phrases anywhere in the comment summons a review.
const TRIGGER_AUGMENT_PHRASES = /roast me.*auggie|auggie please/i;
const TRIGGER_COPILOT_PHRASES = /roast me.*copilot|copilot please|copilot review/i;
const TRIGGER_RANDOM_PHRASES = /^\s*`*\s*ai review\s*`*\s*$/i;

// Adding this label to a PR also summons a review; it's removed once handled.
const TRIGGER_LABEL = /ai[\s-]review/i;
const SKIP_TRIGGER_LABEL = /no|skip/i;

// Requesting a review from a team whose slug or display name contains
// "ai-review" / "AI Review" also summons a (random) review; the team request
// is removed once handled since it isn't a real reviewer.
const AI_REVIEW_TEAM = /ai[\s-]review/i;
const AUGGIE_REVIEW_TEAM = /auggie/i;

// GitHub's Copilot code-review bot, requested like any other reviewer.
const COPILOT_REVIEWER_LOGIN = "copilot-pull-request-reviewer[bot]";

// Auggie shows up under this login once its review comes back.
const AUGMENTCODE_BOT_LOGIN = /augmentcode/i;

// Don't fire if the comment is already an Augment/Augment-review trigger —
// no point summoning a review that's already being requested.
const ALREADY_TRIGGERING_AUGMENT_PHRASES = /auggie review|augment review|augmentcode review/i;

// Auggie tags its summary comment with this marker; including it in our summon
// reply makes Auggie post its summary in the same block to reduce noise.
const AUGMENT_SUMMARY_MARKER = "<!-- augment-pr-summary -->";

// While a review is in progress, the comment also carries this marker. Editing
// a comment in this state breaks Auggie, so we leave pending comments untouched.
const AUGMENT_PENDING_MARKER = "<!-- augment-pending -->";

const AUGMENT_SUMMON_REPLY = `**{•<sup><sup>"</sup></sup>•}**\n\nauggie review\n\n${AUGMENT_SUMMARY_MARKER}\n${AUGMENT_PENDING_MARKER}\n`;

function isBotUser(user) {
  return user?.type === "Bot" || user?.login?.endsWith("[bot]");
}

async function triggerAugmentReviewer(octokit, { owner, repo, issue_number }) {
  // Look for an existing Augment summary block on this PR.
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
  });
  const summaries = comments.filter((c) =>
    c.body?.includes(AUGMENT_SUMMARY_MARKER)
  );

  // A review is already in progress — don't summon another (and don't touch
  // the pending comment, since editing it breaks Auggie).
  if (summaries.some((c) => c.body.includes(AUGMENT_PENDING_MARKER))) {
    return;
  }

  // Any remaining summaries are from a completed review. Strip their marker so
  // the new summon block becomes the one Auggie posts its next summary into.
  for (const summary of summaries) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: summary.id,
      body: summary.body.replace(AUGMENT_SUMMARY_MARKER, ""),
    });
  }

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number,
    body: AUGMENT_SUMMON_REPLY,
  });
}

async function triggerCopilotReviewer(octokit, { owner, repo, issue_number }) {
  await octokit.rest.pulls.requestReviewers({
    owner,
    repo,
    pull_number: issue_number,
    reviewers: [COPILOT_REVIEWER_LOGIN],
  });
}

const AI_REVIEWER_TRIGGERS = [
  { provider: "augment", trigger: triggerAugmentReviewer },
  { provider: "copilot", trigger: triggerCopilotReviewer },
];

// Friendly display names for the providers we can actually summon.
const PROVIDER_DISPLAY_NAMES = {
  augment: "Auggie",
  claude: "Claude",
  copilot: "Copilot",
  greptile: "Greptile",
  linearb: "LinearB",
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

// Summon one of the enabled AI reviewers at random (Auggie or Copilot).
async function triggerRandomReviewer(octokit, { owner, repo, issue_number, config }) {
  const enabled = AI_REVIEWER_TRIGGERS.filter((t) => config.isProviderEnabled(t.provider));
  if (enabled.length === 0) {
    return;
  }
  const index = Math.floor(Math.random() * enabled.length);
  await enabled[index].trigger(octokit, { owner, repo, issue_number });
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
    });
  });

  app.on(["pull_request.labeled"], async (context) => {
    const { pull_request, label } = context.payload;

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
    });
  });

  app.on(["pull_request.review_requested"], async (context) => {
    const { pull_request, requested_team } = context.payload;

    if (!requested_team) {
      return;
    }

    const { owner, repo } = context.repo();

    const isAuggieRequested = AUGGIE_REVIEW_TEAM.test(requested_team.slug) || AUGGIE_REVIEW_TEAM.test(requested_team.name)
    const isAnyAIRequested = AI_REVIEW_TEAM.test(requested_team.slug) || AI_REVIEW_TEAM.test(requested_team.name);

    if (!isAuggieRequested && !isAnyAIRequested) {
      return;
    }

    const config = await loadAiReviewConfig(context);

    if (isAuggieRequested) {
      if (!config.isProviderEnabled("augment")) {
        // Auggie isn't enabled here: don't summon, but still clear the bogus
        // team request so it doesn't sit as a pending reviewer, and explain why.
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
          provider: "augment",
          config,
        });

        return;
      }

      // Explicitly summoning Auggie: trigger the review but leave the team
      // request in place. It's removed later
      await triggerAugmentReviewer(context.octokit, {
        owner,
        repo,
        issue_number: pull_request.number,
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
    });
  });

  app.on(["pull_request_review.submitted"], async (context) => {
    const { pull_request, review } = context.payload;

    if (!AUGMENTCODE_BOT_LOGIN.test(review.user?.login ?? "")) {
      return;
    }

    const teamSlugs = pull_request.requested_teams.map((team) => team.slug);
    const auggieTeamSlugs = teamSlugs.filter((teamSlug) => AUGGIE_REVIEW_TEAM.test(teamSlug));
  
    if (auggieTeamSlugs.length > 0) {
      try {
        await context.octokit.pulls.removeRequestedReviewers({
            ...context.pullRequest(),
          reviewers: [],
          team_reviewers: auggieTeamSlugs,
        });
      } catch {
        // swallow errors
      }
    }
  });
}
