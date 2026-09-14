// Shared AI-reviewer knowledge: which providers exist, how to recognise them
// in GitHub data (logins, teams, markers), how to summon them, and how to
// detect pending/completed AI review activity on a pull request.
//
// Used by the manual triggers (trigger-ai-review.js), the automatic trigger
// (auto-trigger-ai-review.js), and the commit status (ai-review-commit-status.js).

import { wakeAgent } from "./agent-dispatch.js";

/** Provider values MUST be matching substrings of github.login.toLowerCase() */
export const BOT = {
  Augment: "augment",
  Claude: "claude",
  Copilot: "copilot",
  Dusty: "dusty",
  Greptile: "greptile",
  LinearB: "linearb",
};

// Friendly display names for the providers we know about.
export const PROVIDER_DISPLAY_NAMES = {
  [BOT.Augment]: "Auggie",
  [BOT.Claude]: "Claude",
  [BOT.Copilot]: "Copilot",
  [BOT.Dusty]: "Dusty",
  [BOT.Greptile]: "Greptile",
  [BOT.LinearB]: "LinearB",
};

// Requesting a review from a team whose slug or display name contains
// "ai-review" / "AI Review" summons a (random) review; a team naming a
// provider summons that provider specifically.
export const AI_REVIEW_TEAM = /ai[\s-]review/i;
export const AUGGIE_REVIEW_TEAM = /auggie/i;
export const DUSTY_REVIEW_TEAM = /dusty/i;

const PROVIDER_REVIEW_TEAMS = [
  { provider: BOT.Augment, team: AUGGIE_REVIEW_TEAM },
  { provider: BOT.Dusty, team: DUSTY_REVIEW_TEAM },
];

// The provider a requested team summons, or null (the generic "AI Review"
// team included).
export function providerForReviewTeam(team) {
  const slug = team?.slug ?? "";
  const name = team?.name ?? "";
  return PROVIDER_REVIEW_TEAMS.find((t) => t.team.test(slug) || t.team.test(name))?.provider ?? null;
}

// GitHub's Copilot code-review bot, requested like any other reviewer.
export const COPILOT_REVIEWER_LOGIN = "copilot-pull-request-reviewer[bot]";

// Auggie shows up under this login once its review comes back.
export const AUGMENTCODE_BOT_LOGIN = /augmentcode/i;

// LinearB reviews arrive via gitStream, which reports its automation run as a
// "gitStream.cm" commit status. That status being present and not failing
// means a run (and the LinearB review it delivers) is in flight or done.
export const GITSTREAM_STATUS_CONTEXT = /gitstream/i;

// Auggie tags its summary comment with this marker; including it in our summon
// reply makes Auggie post its summary in the same block to reduce noise.
export const AUGMENT_SUMMARY_MARKER = "<!-- augment-pr-summary -->";

// While a review is in progress, the comment also carries this marker. Editing
// a comment in this state breaks Auggie, so we leave pending comments untouched.
export const AUGMENT_PENDING_MARKER = "<!-- augment-pending -->";

export const DUSTY_SUMMON_COMMENT = "@HealthengineAU/dusty review";

const AUGMENT_SUMMON_REPLY = "auggie review";
const AUGMENT_SUMMON_REPLY_EDIT = `${AUGMENT_SUMMARY_MARKER}\n${AUGMENT_PENDING_MARKER}\n**{•<sup><sup>"</sup></sup>•}** Summoning auggie review...`;
const AUGMENT_SUMMON_REPLY_FAILED = `${AUGMENT_SUMMARY_MARKER}\n**{•<sup><sup>"</sup></sup>•}** Hmm... If Auggie still hasn't acknowledged, try commenting \`auggie review\` manually`;

export function isBotUser(user) {
  return user?.type === "Bot" || user?.login?.endsWith("[bot]");
}

export function getBotKey(login) {
  const lower = login?.toLowerCase();
  if (!lower) return null;
  for (const key of Object.values(BOT)) {
    if (lower.includes(key)) return key;
  }
  return null;
}

export function getBotDisplayName(login) {
  for (const pattern in PROVIDER_DISPLAY_NAMES) {
    if (login?.toLowerCase().includes(pattern)) {
      return PROVIDER_DISPLAY_NAMES[pattern];
    }
  }

  return login;
}

// ---------------------------------------------------------------------------
// Summoning
// ---------------------------------------------------------------------------

export async function triggerAugmentReviewer(octokit, { owner, repo, issue_number }) {
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

  // We inject the summon into the request comment
  const SUMMON_COMMENT_INJECT_MARKERS_MS = 10_000;
  const CHECK_AUGGIE_REQUEST_FAILED_MS = 20_000;
  const summonComment = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number,
    body: AUGMENT_SUMMON_REPLY,
  });

  // update a few seconds later with the MARKERS comment
  setTimeout(() => {
    octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: summonComment.data.id,
      body: AUGMENT_SUMMON_REPLY_EDIT,
    }).catch((err) => {
      console.error(`Augment summon marker edit failed for ${owner}/${repo}#${issue_number}`, err);
    });
  }, SUMMON_COMMENT_INJECT_MARKERS_MS);

  // Check whether Auggie has acknowledged the summon by reacting.
  // If no react, then update the body to say it failed.
  setTimeout(() => {
    (async () => {
      const reactions = await octokit.paginate(
        octokit.rest.reactions.listForIssueComment,
        {
          owner,
          repo,
          comment_id: summonComment.data.id,
        }
      );

      const auggieReacted = reactions.some((r) =>
        AUGMENTCODE_BOT_LOGIN.test(r.user?.login ?? "")
      );

      if (!auggieReacted) {
        await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: summonComment.data.id,
          body: AUGMENT_SUMMON_REPLY_FAILED,
        });
      }
    })().catch((err) => {
      console.error(`Augment summon acknowledgement check failed for ${owner}/${repo}#${issue_number}`, err);
    });
  }, CHECK_AUGGIE_REQUEST_FAILED_MS);
}

export async function triggerCopilotReviewer(octokit, { owner, repo, issue_number }) {
  await octokit.rest.pulls.requestReviewers({
    owner,
    repo,
    pull_number: issue_number,
    reviewers: [COPILOT_REVIEWER_LOGIN],
  });
}

// Post the summon comment, then wake Dusty with it — the comment alone can't,
// since agent-proxies ignores bot-authored ones. `actor` is the person who
// asked: Dusty takes a mention from an org member, not from this app.
export async function triggerDustyReviewer(octokit, { owner, repo, issue_number, config, actor }) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number,
    body: DUSTY_SUMMON_COMMENT,
  });

  const agent = (config?.agents ?? []).find((a) => a.name.toLowerCase() === BOT.Dusty);
  if (!agent?.events.has("mention")) return;

  wakeAgent(octokit, agent, {
    event: "mention",
    repo,
    pr: issue_number,
    actor,
    body: DUSTY_SUMMON_COMMENT,
  });
}

const AI_REVIEWER_TRIGGERS = [
  { provider: BOT.Augment, trigger: triggerAugmentReviewer },
  { provider: BOT.Copilot, trigger: triggerCopilotReviewer },
  { provider: BOT.Dusty, trigger: triggerDustyReviewer },
];

// True when at least one summonable reviewer (Auggie, Copilot, Dusty) is enabled —
// lets callers skip work that would end in a triggerRandomReviewer no-op.
export function canSummonReviewer(config) {
  return AI_REVIEWER_TRIGGERS.some((t) => config.isProviderEnabled(t.provider));
}

// A PR's diff size (additions + deletions) — what the config's diff-size
// bounds and provider groups are measured against.
export function getDiffSize(pr) {
  return (pr?.additions ?? 0) + (pr?.deletions ?? 0);
}

// A PR's lines added (additions only) — what the provider groups'
// `min_lines_added` / `max_lines_added` bounds are measured against.
export function getLinesAdded(pr) {
  return pr?.additions ?? 0;
}

// Summon one of the enabled AI reviewers at random (Auggie, Copilot or Dusty).
// When the PR's size is known and `ai_review.provider_groups` has a band
// covering it, the pick is restricted to that band's summonable providers;
// otherwise every enabled provider is in the running.
export async function triggerRandomReviewer(octokit, { owner, repo, issue_number, config, diffSize, linesAdded, actor }) {
  const enabled = AI_REVIEWER_TRIGGERS.filter((t) => config.isProviderEnabled(t.provider));
  if (enabled.length === 0) {
    return;
  }

  const group = config.providersForSize?.({ diffSize, linesAdded });
  const grouped = group ? enabled.filter((t) => group.has(t.provider)) : [];
  const candidates = grouped.length > 0 ? grouped : enabled;

  const index = Math.floor(Math.random() * candidates.length);
  await candidates[index].trigger(octokit, { owner, repo, issue_number, config, actor });
}

// ---------------------------------------------------------------------------
// Request/review state detection
// ---------------------------------------------------------------------------

// A comment whose entire body is a provider's summon command ("auggie review",
// "@HealthengineAU/dusty review", optionally backticked). Exact-body on
// purpose: Auggie's summon-failed reply merely *mentions* `auggie review` and
// must not read as a live request.
const SUMMON_COMMANDS = {
  [BOT.Augment]: /^\s*`*\s*(?:auggie|augment|augmentcode) review\s*`*\s*$/i,
  [BOT.Dusty]: /^\s*`*\s*@?(?:healthengineau\/)?dusty review\s*`*\s*$/i,
};

// The provider a comment summons, or null when it isn't a summon command.
export function summonCommandProvider(body) {
  if (typeof body !== "string") return null;
  for (const [provider, command] of Object.entries(SUMMON_COMMANDS)) {
    if (command.test(body)) return provider;
  }
  return null;
}

// A summon is live when its command has no activity (review or comment) from
// that provider after it, or — Auggie only — a comment still carries the
// pending marker. Our own Auggie summon comment passes through the command,
// then the marker, then the summary or summon-failed reply. A typed command,
// and our Dusty summon, stay as-is: pending until the provider answers.
export function hasPendingSummon(provider, { issueComments = [], reviews = [] }) {
  let lastCommandAt = null;
  for (const comment of issueComments) {
    if (provider === BOT.Augment && comment.body?.includes(AUGMENT_PENDING_MARKER)) return true;
    if (summonCommandProvider(comment.body) === provider) {
      const at = new Date(comment.created_at ?? 0).getTime();
      if (lastCommandAt === null || at > lastCommandAt) lastCommandAt = at;
    }
  }
  if (lastCommandAt === null) return false;

  // Bots only: provider keys are login substrings, so a human login carrying
  // one would otherwise read as the provider answering.
  const byProvider = (user) => isBotUser(user) && getBotKey(user?.login) === provider;
  const activity = [
    ...reviews.filter((r) => byProvider(r.user)).map((r) => r.submitted_at),
    ...issueComments.filter((c) => byProvider(c.user)).map((c) => c.created_at),
  ];

  return !activity.some((ts) => new Date(ts ?? 0).getTime() >= lastCommandAt);
}

// AI reviews that have been requested but not yet delivered, from data the
// caller has already fetched. `statuses` are the head sha's commit statuses
// (latest per context). Returns [{ provider, userId?, login?, displayName }]
// de-duped by provider/user; `provider` is null for a generic "AI review"
// team request that hasn't resolved to a specific reviewer yet.
export function detectPendingAiReviewRequests({
  pr,
  requestedReviewer = null,
  issueComments = [],
  reviews = [],
  statuses = [],
  augmentEnabled = true,
  dustyEnabled = true,
  linearbEnabled = true,
}) {
  const requests = [];
  const seen = new Set();

  const add = (request) => {
    const keys = [request.provider ?? request.displayName?.toLowerCase(), request.userId]
      .filter((key) => key != null);
    if (keys.some((key) => seen.has(key))) return;
    for (const key of keys) seen.add(key);
    requests.push(request);
  };

  // Bots sitting in requested_reviewers (Copilot is requested like a human).
  // `requestedReviewer` is the reviewer from the review_requested payload,
  // which doesn't always show up in that PR's requested_reviewers yet.
  const requestedReviewers = [...(pr.requested_reviewers || [])];
  if (
    requestedReviewer
    && !requestedReviewers.some((user) => user.id === requestedReviewer.id)
  ) {
    requestedReviewers.push(requestedReviewer);
  }

  for (const user of requestedReviewers) {
    if (!isBotUser(user)) continue;
    add({
      provider: getBotKey(user.login),
      userId: user.id,
      login: user.login,
      displayName: getBotDisplayName(user.login),
    });
  }

  // Team-based requests: a provider-named team means that provider; an
  // "ai-review" team is a generic request (it gets swapped for a concrete
  // reviewer within seconds, but can linger in the payload that triggered
  // this update).
  for (const team of pr.requested_teams || []) {
    const provider = providerForReviewTeam(team);
    if (provider) {
      add({ provider, displayName: PROVIDER_DISPLAY_NAMES[provider] });
    } else if (AI_REVIEW_TEAM.test(team?.slug ?? "") || AI_REVIEW_TEAM.test(team?.name ?? "")) {
      add({ provider: null, displayName: "AI review" });
    }
  }

  // Comment-based summons (ours or a human's typed command). Skipped when the
  // provider is disabled so a dangling command can't read as pending.
  for (const [provider, enabled] of [[BOT.Augment, augmentEnabled], [BOT.Dusty, dustyEnabled]]) {
    if (enabled && hasPendingSummon(provider, { issueComments, reviews })) {
      add({ provider, displayName: PROVIDER_DISPLAY_NAMES[provider] });
    }
  }

  // LinearB via gitStream: a present, non-failing gitStream.cm status means a
  // run is in flight (or done) and its review follows.
  if (linearbEnabled) {
    const gitstream = statuses.find((status) =>
      GITSTREAM_STATUS_CONTEXT.test(status?.context ?? "")
    );
    if (gitstream && gitstream.state !== "failure" && gitstream.state !== "error") {
      add({ provider: BOT.LinearB, displayName: PROVIDER_DISPLAY_NAMES[BOT.LinearB] });
    }
  }

  return requests;
}

// Any bot-submitted formal review counts as a completed AI review — the same
// rule the commit status uses to qualify a bot as a reviewer.
export function hasCompletedAiReview(reviews = []) {
  return reviews.some((review) => isBotUser(review.user));
}
