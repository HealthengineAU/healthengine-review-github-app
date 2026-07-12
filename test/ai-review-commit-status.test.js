import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getBotDisplayName,
  isBotUser,
  clampDescription,
  getBotKey,
  classifyBot,
  formatBotEntry,
} from "../lib/ai-review-commit-status.js";

// ---------------------------------------------------------------------------
// getBotDisplayName
// ---------------------------------------------------------------------------

test("getBotDisplayName: maps known bot logins to friendly names", () => {
  assert.equal(getBotDisplayName("augmentcode[bot]"), "Auggie");
  assert.equal(getBotDisplayName("Claude"), "Claude");
  assert.equal(getBotDisplayName("copilot-pull-request-reviewer[bot]"), "Copilot");
  assert.equal(getBotDisplayName("greptileai[bot]"), "Greptile");
  assert.equal(getBotDisplayName("linearb-bot[bot]"), "LinearB");
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
// clampDescription
// ---------------------------------------------------------------------------

test("clampDescription: leaves short strings untouched", () => {
  assert.equal(clampDescription("short"), "short");
});

test("clampDescription: keeps a 140-char string exactly (boundary)", () => {
  const s = "a".repeat(140);
  assert.equal(clampDescription(s), s);
});

test("clampDescription: truncates 141+ chars to 140 with an ellipsis", () => {
  const s = "a".repeat(200);
  const result = clampDescription(s);
  assert.equal(result.length, 140);
  assert.ok(result.endsWith("…"));
  assert.equal(result, "a".repeat(139) + "…");
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
});

test("getBotKey: null for unknown or missing logins", () => {
  assert.equal(getBotKey("dependabot[bot]"), null);
  assert.equal(getBotKey(null), null);
  assert.equal(getBotKey(undefined), null);
  assert.equal(getBotKey(""), null);
});

// ---------------------------------------------------------------------------
// classifyBot
// ---------------------------------------------------------------------------

function baseArgs(overrides = {}) {
  return {
    userId: 1,
    login: "augmentcode[bot]",
    displayName: "Auggie",
    botKey: "augment",
    comments: [],
    feedback: { total: 0, resolved: 0 },
    ...overrides,
  };
}

test("classifyBot: flags 'failed' when the last comment matches a failure detector", () => {
  const result = classifyBot(
    baseArgs({
      comments: [{ body: "Auggie is out of credits, unable to review" }],
    })
  );
  assert.equal(result.state, "failed");
});

test("classifyBot: failure detection only checks the LAST comment", () => {
  const result = classifyBot(
    baseArgs({
      comments: [
        { body: "out of credits" },
        { body: "here is my actual review" },
      ],
      feedback: { total: 2, resolved: 2 },
    })
  );
  assert.notEqual(result.state, "failed");
});

test("classifyBot: 'resolved' when all threads are resolved", () => {
  const result = classifyBot(baseArgs({ feedback: { total: 3, resolved: 3 } }));
  assert.equal(result.state, "resolved");
});

test("classifyBot: 'resolved' when there is no feedback at all (0 === 0)", () => {
  const result = classifyBot(baseArgs({ feedback: { total: 0, resolved: 0 } }));
  assert.equal(result.state, "resolved");
});

test("classifyBot: 'unresolved' when some threads remain open", () => {
  const result = classifyBot(baseArgs({ feedback: { total: 3, resolved: 1 } }));
  assert.equal(result.state, "unresolved");
});

test("classifyBot: no failure detector for the bot key → never 'failed'", () => {
  const result = classifyBot(
    baseArgs({
      botKey: "greptile", // no BOT_COMMENTS entry
      comments: [{ body: "out of credits, unable to review" }],
      feedback: { total: 1, resolved: 0 },
    })
  );
  assert.equal(result.state, "unresolved");
});

test("classifyBot: carries through identity fields", () => {
  const result = classifyBot(baseArgs({ userId: 42, login: "x", displayName: "X" }));
  assert.equal(result.userId, 42);
  assert.equal(result.login, "x");
  assert.equal(result.displayName, "X");
  assert.deepEqual(result.feedback, { total: 0, resolved: 0 });
});

// ---------------------------------------------------------------------------
// formatBotEntry
// ---------------------------------------------------------------------------

test("formatBotEntry: requested-review", () => {
  assert.equal(
    formatBotEntry({ state: "requested-review", displayName: "Auggie" }),
    "Requested Auggie"
  );
});

test("formatBotEntry: failed", () => {
  assert.equal(
    formatBotEntry({ state: "failed", displayName: "Copilot" }),
    "Copilot unable to review"
  );
});

test("formatBotEntry: unresolved shows acknowledged/total", () => {
  assert.equal(
    formatBotEntry({
      state: "unresolved",
      displayName: "Auggie",
      feedback: { resolved: 1, total: 3 },
    }),
    "Reviewed by Auggie (1/3 acknowledged)"
  );
});

test("formatBotEntry: resolved with feedback shows a checkmark and total", () => {
  assert.equal(
    formatBotEntry({
      state: "resolved",
      displayName: "Auggie",
      feedback: { resolved: 2, total: 2 },
    }),
    "✓ Reviewed by Auggie (2 acknowledged)"
  );
});

test("formatBotEntry: resolved with no feedback shows 'no feedback'", () => {
  assert.equal(
    formatBotEntry({
      state: "resolved",
      displayName: "Claude",
      feedback: { resolved: 0, total: 0 },
    }),
    "✓ Reviewed by Claude (no feedback)"
  );
});
