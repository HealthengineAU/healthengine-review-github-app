import { test } from "node:test";
import assert from "node:assert/strict";

import { failedReviewRequester, isAugmentFailureComment } from "../lib/augment-fallback.js";

const OUT_OF_CREDITS =
  "Looks like you're out of credits for this review. Head to your account settings to top up and keep reviews running. https://app.augmentcode.com/account/subscription";

test("isAugmentFailureComment: recognises Auggie's out-of-credits reply", () => {
  assert.equal(
    isAugmentFailureComment({
      user: { login: "augmentcode[bot]", type: "Bot" },
      body: OUT_OF_CREDITS,
    }),
    true
  );
});

test("isAugmentFailureComment: ignores Auggie's ordinary comments", () => {
  assert.equal(
    isAugmentFailureComment({
      user: { login: "augmentcode[bot]", type: "Bot" },
      body: "<!-- augment-pr-summary -->\nAuggie PR Summary",
    }),
    false
  );
});

test("isAugmentFailureComment: ignores the same words from anyone else", () => {
  assert.equal(
    isAugmentFailureComment({
      user: { login: "jane", type: "User" },
      body: "auggie is out of credits again",
    }),
    false
  );
  assert.equal(
    isAugmentFailureComment({
      user: { login: "copilot-pull-request-reviewer[bot]", type: "Bot" },
      body: "Copilot wasn't able to review, out of credits",
    }),
    false
  );
});

test("failedReviewRequester: the last person to ask Auggie before it gave up", () => {
  const requester = failedReviewRequester(
    [
      { body: "auggie review", user: { login: "jane", type: "User" }, created_at: "2026-11-01T01:00:00Z" },
      { body: "roast me auggie", user: { login: "sam", type: "User" }, created_at: "2026-11-01T02:00:00Z" },
      { body: "auggie review", user: { login: "pr-bot[bot]", type: "Bot" }, created_at: "2026-11-01T03:00:00Z" },
    ],
    { failedAt: Date.parse("2026-11-01T04:00:00Z"), prAuthor: "kim" }
  );
  assert.equal(requester, "sam");
});

test("failedReviewRequester: ignores asks made after the failure", () => {
  const requester = failedReviewRequester(
    [
      { body: "auggie review", user: { login: "sam", type: "User" }, created_at: "2026-11-01T09:00:00Z" },
    ],
    { failedAt: Date.parse("2026-11-01T04:00:00Z"), prAuthor: "kim" }
  );
  assert.equal(requester, "kim");
});

test("failedReviewRequester: falls back to the PR author when the app did the asking", () => {
  const requester = failedReviewRequester([], {
    failedAt: Date.parse("2026-11-01T04:00:00Z"),
    prAuthor: "kim",
  });
  assert.equal(requester, "kim");
});
