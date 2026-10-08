import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_REVIEW_TEAM,
  AUGGIE_REVIEW_TEAM,
  AUGMENT_PENDING_MARKER,
  BOT,
  DUSTY_REVIEW_TEAM,
  detectPendingAiReviewRequests,
  getBotDisplayName,
  getBotKey,
  hasCompletedAiReview,
  hasPendingSummon,
  isBotUser,
  providerForReviewTeam,
  summonCommandProvider,
} from "../lib/ai-reviewers.js";

// ---------------------------------------------------------------------------
// getBotDisplayName
// ---------------------------------------------------------------------------

test("getBotDisplayName: maps known bot logins to friendly names", () => {
  assert.equal(getBotDisplayName("augmentcode[bot]"), "Auggie");
  assert.equal(getBotDisplayName("Claude"), "Claude");
  assert.equal(getBotDisplayName("copilot-pull-request-reviewer[bot]"), "Copilot");
  assert.equal(getBotDisplayName("greptileai[bot]"), "Greptile");
  assert.equal(getBotDisplayName("linearb-bot[bot]"), "LinearB");
  assert.equal(getBotDisplayName("dusty-the-robot[bot]"), "Dusty");
});

test("getBotDisplayName: falls back to the raw login when unknown", () => {
  assert.equal(getBotDisplayName("some-random-bot"), "some-random-bot");
});

test("getBotDisplayName: handles null/undefined login", () => {
  assert.equal(getBotDisplayName(null), null);
  assert.equal(getBotDisplayName(undefined), undefined);
});

// ---------------------------------------------------------------------------
// isBotUser
// ---------------------------------------------------------------------------

test("isBotUser: true for type Bot", () => {
  assert.ok(isBotUser({ type: "Bot" }));
});

test("isBotUser: true for logins ending in [bot]", () => {
  assert.ok(isBotUser({ login: "dependabot[bot]" }));
});

test("isBotUser: false for humans and missing users", () => {
  // Note: the predicate is used for truthiness, so it may return undefined
  // rather than a literal false for null-ish inputs.
  assert.ok(!isBotUser({ type: "User", login: "david" }));
  assert.ok(!isBotUser(null));
  assert.ok(!isBotUser(undefined));
  assert.ok(!isBotUser({}));
});

// ---------------------------------------------------------------------------
// getBotKey
// ---------------------------------------------------------------------------

test("getBotKey: extracts the provider key from a login", () => {
  assert.equal(getBotKey("augmentcode[bot]"), "augment");
  assert.equal(getBotKey("Copilot"), "copilot");
  assert.equal(getBotKey("greptileai[bot]"), "greptile");
  assert.equal(getBotKey("linearb-bot[bot]"), "linearb");
  assert.equal(getBotKey("claude[bot]"), "claude");
  assert.equal(getBotKey("dusty-the-robot[bot]"), "dusty");
});

test("getBotKey: null for unknown or missing logins", () => {
  assert.equal(getBotKey("dependabot[bot]"), null);
  assert.equal(getBotKey(null), null);
  assert.equal(getBotKey(undefined), null);
  assert.equal(getBotKey(""), null);
});

// ---------------------------------------------------------------------------
// Team matching
// ---------------------------------------------------------------------------

test("AI_REVIEW_TEAM / AUGGIE_REVIEW_TEAM / DUSTY_REVIEW_TEAM: team slug matching", () => {
  assert.ok(AI_REVIEW_TEAM.test("ai-review-team"));
  assert.ok(AI_REVIEW_TEAM.test("AI Review"));
  assert.ok(AUGGIE_REVIEW_TEAM.test("auggie-reviewers"));
  assert.ok(DUSTY_REVIEW_TEAM.test("dusty"));
  assert.equal(AUGGIE_REVIEW_TEAM.test("backend-team"), false);
  assert.equal(DUSTY_REVIEW_TEAM.test("backend-team"), false);
});

test("providerForReviewTeam: resolves a team to the provider it summons", () => {
  assert.equal(providerForReviewTeam({ slug: "auggie", name: "Auggie" }), BOT.Augment);
  assert.equal(providerForReviewTeam({ slug: "dusty", name: "Dusty" }), BOT.Dusty);
  assert.equal(providerForReviewTeam({ slug: "ai-review", name: "AI Review" }), null);
  assert.equal(providerForReviewTeam({ slug: "backend", name: "Backend" }), null);
  assert.equal(providerForReviewTeam(null), null);
});

// ---------------------------------------------------------------------------
// summonCommandProvider
// ---------------------------------------------------------------------------

test("summonCommandProvider: matches standalone summon commands", () => {
  assert.equal(summonCommandProvider("auggie review"), BOT.Augment);
  assert.equal(summonCommandProvider("Auggie Review"), BOT.Augment);
  assert.equal(summonCommandProvider("  augment review  "), BOT.Augment);
  assert.equal(summonCommandProvider("`auggie review`"), BOT.Augment);
  assert.equal(summonCommandProvider("augmentcode review"), BOT.Augment);
  assert.equal(summonCommandProvider("@HealthengineAU/dusty review"), BOT.Dusty);
  assert.equal(summonCommandProvider("@acme/dusty review"), BOT.Dusty);
  assert.equal(summonCommandProvider("@dusty review"), BOT.Dusty);
  assert.equal(summonCommandProvider("`@healthengineau/dusty review`"), BOT.Dusty);
});

test("summonCommandProvider: does not match mentions inside prose", () => {
  assert.equal(summonCommandProvider("please auggie review this"), null);
  assert.equal(summonCommandProvider("@HealthengineAU/dusty review this when you can"), null);
  // Unqualified: nothing wakes Dusty on it, so it must not read as pending.
  assert.equal(summonCommandProvider("dusty review"), null);
  // The summon-failed reply mentions the command but is not a live request.
  assert.equal(
    summonCommandProvider(
      "Hmm... Auggie still hasn't acknowledged. Try commenting `auggie review` manually."
    ),
    null
  );
  assert.equal(summonCommandProvider(null), null);
  assert.equal(summonCommandProvider(undefined), null);
});

// ---------------------------------------------------------------------------
// hasPendingSummon
// ---------------------------------------------------------------------------

const AUGGIE = { login: "augmentcode[bot]", type: "Bot", id: 77 };
const DUSTY = { login: "dusty-the-robot[bot]", type: "Bot", id: 88 };
const HUMAN = { login: "david", type: "User", id: 1 };

test("hasPendingSummon: pending marker comment reads as pending", () => {
  assert.ok(
    hasPendingSummon(BOT.Augment, {
      issueComments: [
        { user: AUGGIE, body: `${AUGMENT_PENDING_MARKER}\nSummoning...`, created_at: "2026-07-01T00:00:00Z" },
      ],
    })
  );
});

test("hasPendingSummon: unanswered summon command reads as pending", () => {
  assert.ok(
    hasPendingSummon(BOT.Augment, {
      issueComments: [
        { user: HUMAN, body: "auggie review", created_at: "2026-07-01T00:00:00Z" },
      ],
      reviews: [],
    })
  );
});

test("hasPendingSummon: an Augment review after the command clears it", () => {
  assert.equal(
    hasPendingSummon(BOT.Augment, {
      issueComments: [
        { user: HUMAN, body: "auggie review", created_at: "2026-07-01T00:00:00Z" },
      ],
      reviews: [
        { user: AUGGIE, submitted_at: "2026-07-01T00:05:00Z" },
      ],
    }),
    false
  );
});

test("hasPendingSummon: a command after the last Augment review re-requests", () => {
  assert.ok(
    hasPendingSummon(BOT.Augment, {
      issueComments: [
        { user: HUMAN, body: "auggie review", created_at: "2026-07-02T00:00:00Z" },
      ],
      reviews: [
        { user: AUGGIE, submitted_at: "2026-07-01T00:00:00Z" },
      ],
    })
  );
});

test("hasPendingSummon: an Augment comment after the command clears it", () => {
  assert.equal(
    hasPendingSummon(BOT.Augment, {
      issueComments: [
        { user: HUMAN, body: "auggie review", created_at: "2026-07-01T00:00:00Z" },
        { user: AUGGIE, body: "Here's my summary", created_at: "2026-07-01T00:03:00Z" },
      ],
    }),
    false
  );
});

test("hasPendingSummon: an unanswered Dusty summon reads as pending", () => {
  const issueComments = [
    { user: HUMAN, body: "@HealthengineAU/dusty review", created_at: "2026-07-01T00:00:00Z" },
  ];
  assert.ok(hasPendingSummon(BOT.Dusty, { issueComments }));
  // ...and Dusty answering clears it.
  assert.equal(
    hasPendingSummon(BOT.Dusty, {
      issueComments,
      reviews: [{ user: DUSTY, submitted_at: "2026-07-01T00:05:00Z" }],
    }),
    false
  );
  // Another provider's summon is not Dusty's.
  assert.equal(hasPendingSummon(BOT.Augment, { issueComments }), false);
  // Nor does a human whose login happens to carry the provider key answer it.
  assert.ok(
    hasPendingSummon(BOT.Dusty, {
      issueComments: [
        ...issueComments,
        { user: { login: "dusty-rhodes", type: "User" }, body: "nice", created_at: "2026-07-01T00:05:00Z" },
      ],
    })
  );
});

test("hasPendingSummon: nothing pending on a quiet PR", () => {
  assert.equal(hasPendingSummon(BOT.Augment, { issueComments: [], reviews: [] }), false);
  assert.equal(
    hasPendingSummon(BOT.Augment, {
      issueComments: [{ user: HUMAN, body: "nice work", created_at: "2026-07-01T00:00:00Z" }],
    }),
    false
  );
});

// ---------------------------------------------------------------------------
// detectPendingAiReviewRequests
// ---------------------------------------------------------------------------

const COPILOT_REVIEWER = {
  login: "copilot-pull-request-reviewer[bot]",
  type: "Bot",
  id: 9,
};

test("detectPendingAiReviewRequests: bot requested_reviewers become requests", () => {
  const requests = detectPendingAiReviewRequests({
    pr: { requested_reviewers: [COPILOT_REVIEWER, HUMAN] },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, "copilot");
  assert.equal(requests[0].displayName, "Copilot");
  assert.equal(requests[0].userId, 9);
});

test("detectPendingAiReviewRequests: the payload's requested_reviewer counts", () => {
  const requests = detectPendingAiReviewRequests({
    pr: { requested_reviewers: [] },
    requestedReviewer: { login: "Copilot", type: "Bot", id: 175728472 },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, "copilot");
  assert.equal(requests[0].userId, 175728472);
});

test("detectPendingAiReviewRequests: the payload's requested_reviewer isn't double counted", () => {
  const requests = detectPendingAiReviewRequests({
    pr: { requested_reviewers: [COPILOT_REVIEWER] },
    requestedReviewer: COPILOT_REVIEWER,
  });
  assert.equal(requests.length, 1);
});

test("detectPendingAiReviewRequests: auggie and ai-review team requests", () => {
  const requests = detectPendingAiReviewRequests({
    pr: {
      requested_teams: [
        { slug: "auggie-reviewers", name: "Auggie" },
        { slug: "ai-review", name: "AI Review" },
        { slug: "backend", name: "Backend" },
      ],
    },
  });
  assert.deepEqual(
    requests.map((r) => r.displayName).sort(),
    ["AI review", "Auggie"]
  );
});

test("detectPendingAiReviewRequests: a pending summon adds a single Auggie entry", () => {
  const requests = detectPendingAiReviewRequests({
    pr: { requested_teams: [{ slug: "auggie", name: "Auggie" }] },
    issueComments: [
      { user: HUMAN, body: "auggie review", created_at: "2026-07-01T00:00:00Z" },
    ],
  });
  // Team request + live summon de-dupe into one Auggie entry.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, "augment");
});

test("detectPendingAiReviewRequests: a dusty team request and its summon are one entry", () => {
  const requests = detectPendingAiReviewRequests({
    pr: { requested_teams: [{ slug: "dusty", name: "Dusty" }] },
    issueComments: [
      { user: HUMAN, body: "@HealthengineAU/dusty review", created_at: "2026-07-01T00:00:00Z" },
    ],
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, "dusty");
  assert.equal(requests[0].displayName, "Dusty");
});

test("detectPendingAiReviewRequests: dustyEnabled=false ignores summon comments", () => {
  const requests = detectPendingAiReviewRequests({
    pr: {},
    issueComments: [
      { user: HUMAN, body: "@HealthengineAU/dusty review", created_at: "2026-07-01T00:00:00Z" },
    ],
    dustyEnabled: false,
  });
  assert.deepEqual(requests, []);
});

test("detectPendingAiReviewRequests: augmentEnabled=false ignores summon comments", () => {
  const requests = detectPendingAiReviewRequests({
    pr: {},
    issueComments: [
      { user: HUMAN, body: "auggie review", created_at: "2026-07-01T00:00:00Z" },
    ],
    augmentEnabled: false,
  });
  assert.equal(requests.length, 0);
});

test("detectPendingAiReviewRequests: empty PR yields no requests", () => {
  assert.deepEqual(detectPendingAiReviewRequests({ pr: {} }), []);
});

test("detectPendingAiReviewRequests: a non-failing gitStream status means LinearB", () => {
  for (const state of ["pending", "success"]) {
    const requests = detectPendingAiReviewRequests({
      pr: {},
      statuses: [{ context: "gitStream.cm", state }],
    });
    assert.equal(requests.length, 1, `state ${state}`);
    assert.equal(requests[0].provider, "linearb");
    assert.equal(requests[0].displayName, "LinearB");
  }
});

test("detectPendingAiReviewRequests: failing gitStream statuses are not requests", () => {
  for (const state of ["failure", "error"]) {
    const requests = detectPendingAiReviewRequests({
      pr: {},
      statuses: [{ context: "gitStream.cm", state }],
    });
    assert.equal(requests.length, 0, `state ${state}`);
  }
});

test("detectPendingAiReviewRequests: unrelated statuses are ignored", () => {
  const requests = detectPendingAiReviewRequests({
    pr: {},
    statuses: [
      { context: "ci/build", state: "pending" },
      { context: "AI Review", state: "success" },
    ],
  });
  assert.equal(requests.length, 0);
});

test("detectPendingAiReviewRequests: linearbEnabled=false ignores gitStream", () => {
  const requests = detectPendingAiReviewRequests({
    pr: {},
    statuses: [{ context: "gitStream.cm", state: "pending" }],
    linearbEnabled: false,
  });
  assert.equal(requests.length, 0);
});

// ---------------------------------------------------------------------------
// hasCompletedAiReview
// ---------------------------------------------------------------------------

test("hasCompletedAiReview: bot-submitted reviews count", () => {
  assert.ok(hasCompletedAiReview([{ user: AUGGIE }]));
  assert.ok(hasCompletedAiReview([{ user: HUMAN }, { user: COPILOT_REVIEWER }]));
});

test("hasCompletedAiReview: human reviews and empty lists do not", () => {
  assert.equal(hasCompletedAiReview([{ user: HUMAN }]), false);
  assert.equal(hasCompletedAiReview([]), false);
  assert.equal(hasCompletedAiReview(), false);
});
