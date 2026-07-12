import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanAugmentBody,
  isAugmentAuthored,
  cleanCopilotBody,
  isCopilotAuthored,
  cleanLinearbBody,
  isLinearbAuthored,
} from "../lib/clean-ai-review-comments.js";

// ---------------------------------------------------------------------------
// cleanAugmentBody
// ---------------------------------------------------------------------------

test("cleanAugmentBody: returns falsy bodies unchanged", () => {
  assert.equal(cleanAugmentBody(""), "");
  assert.equal(cleanAugmentBody(undefined), undefined);
  assert.equal(cleanAugmentBody(null), null);
});

test("cleanAugmentBody: leaves bodies with no augment markers untouched", () => {
  const body = "Just a normal comment with no bot content.";
  assert.equal(cleanAugmentBody(body), body);
});

test("cleanAugmentBody: strips the 'Fix This in Augment' image link", () => {
  const body =
    "Here is a problem.\n\n[![Fix This](https://public.augment-assets.com/x.png)](https://app.augmentcode.com/fix?id=1)";
  const cleaned = cleanAugmentBody(body);
  assert.ok(!cleaned.includes("augment-assets.com"));
  assert.ok(!cleaned.includes("augmentcode.com"));
  assert.equal(cleaned, "Here is a problem.");
});

test("cleanAugmentBody: strips the 'Fix All in Augment' review-summary link", () => {
  const body =
    "Summary text\n\n[![Fix All in Augment](https://augmentcode.com/badge.svg)](https://augmentcode.com/fix-all)";
  const cleaned = cleanAugmentBody(body);
  assert.ok(!cleaned.includes("augmentcode.com"));
});

test("cleanAugmentBody: removes the 'augment review' trigger footer", () => {
  const body =
    "Real review content.\n<h2></h2>\n\nComment `augment review` to trigger a new review at any time.";
  const cleaned = cleanAugmentBody(body);
  assert.equal(cleaned, "Real review content.");
});

test("cleanAugmentBody: removes the 'react with' feedback footer", () => {
  const body =
    "Review body here.\n<h2></h2>\n\nReact with 👍 or 👎 to give feedback.";
  const cleaned = cleanAugmentBody(body);
  assert.equal(cleaned, "Review body here.");
});

test("cleanAugmentBody: collapses an open PR summary <details> and adds expand hint", () => {
  const body =
    "<!-- augment-pr-summary -->\n<details open>\n<summary>Auggie PR Summary</summary>\nlots of detail\n</details>";
  const cleaned = cleanAugmentBody(body);
  assert.ok(!/<details open>/.test(cleaned), "open attribute should be dropped");
  assert.ok(cleaned.includes("(click to expand)"));
  assert.ok(cleaned.includes("Auggie PR Summary"));
});

test("cleanAugmentBody: collapses runs of 3+ blank lines to a single blank line", () => {
  const body =
    "<!-- augment-pr-summary -->\ntop\n\n\n\n\nbottom";
  const cleaned = cleanAugmentBody(body);
  assert.ok(!/\n{3,}/.test(cleaned));
});

test("cleanAugmentBody: is idempotent", () => {
  const body =
    "Problem.\n\n[![Fix This](https://public.augment-assets.com/x.png)](https://augmentcode.com/fix?id=1)\n<h2></h2>\n\nComment `augment review` to trigger a new review at any time.";
  const once = cleanAugmentBody(body);
  const twice = cleanAugmentBody(once);
  assert.equal(once, twice);
});

// ---------------------------------------------------------------------------
// isAugmentAuthored
// ---------------------------------------------------------------------------

test("isAugmentAuthored: matches by login substring (case-insensitive)", () => {
  assert.ok(isAugmentAuthored({ login: "augmentcode[bot]" }, ""));
  assert.ok(isAugmentAuthored({ login: "MyAugmentBot" }, ""));
});

test("isAugmentAuthored: content fallback for a bot posting augment asset links", () => {
  assert.ok(
    isAugmentAuthored(
      { login: "some-bot", type: "Bot" },
      "see https://public.augment-assets.com/x.png"
    )
  );
});

test("isAugmentAuthored: bot reposting the summary marker (without pending marker)", () => {
  assert.ok(
    isAugmentAuthored(
      { login: "relay-bot", type: "Bot" },
      "<!-- augment-pr-summary -->\nsummary"
    )
  );
});

test("isAugmentAuthored: does NOT match a pending summary repost", () => {
  assert.equal(
    isAugmentAuthored(
      { login: "relay-bot", type: "Bot" },
      "<!-- augment-pr-summary -->\n<!-- augment-pending -->\ngenerating"
    ),
    false
  );
});

test("isAugmentAuthored: false for humans and missing users", () => {
  assert.equal(isAugmentAuthored(null, "anything"), false);
  assert.equal(isAugmentAuthored({ login: "david", type: "User" }, "hello"), false);
  // A non-bot user with augment links in the body should not match on content.
  assert.equal(
    isAugmentAuthored(
      { login: "david", type: "User" },
      "https://public.augment-assets.com/x.png"
    ),
    false
  );
});

// ---------------------------------------------------------------------------
// cleanCopilotBody
// ---------------------------------------------------------------------------

test("cleanCopilotBody: returns falsy bodies unchanged", () => {
  assert.equal(cleanCopilotBody(""), "");
  assert.equal(cleanCopilotBody(undefined), undefined);
});

test("cleanCopilotBody: leaves bodies without the overview heading untouched", () => {
  const body = "Copilot said something without the heading.";
  assert.equal(cleanCopilotBody(body), body);
});

test("cleanCopilotBody: tiny one-liner PR case is not wrapped in <details>", () => {
  const body =
    "Preamble.\n## Pull request overview\nCopilot reviewed 2 out of 2 changed files in this pull request.";
  const cleaned = cleanCopilotBody(body);
  assert.ok(!cleaned.includes("<details>"));
  assert.ok(cleaned.includes("Copilot reviewed 2 out of 2"));
  assert.ok(cleaned.startsWith("Preamble."));
});

test("cleanCopilotBody: multi-line review is wrapped in a collapsed <details>", () => {
  const body =
    "Preamble.\n## Pull request overview\nLine one.\nLine two.\nLine three.";
  const cleaned = cleanCopilotBody(body);
  assert.ok(cleaned.includes("<details>"));
  assert.ok(cleaned.includes("Copilot PR Summary"));
  assert.ok(cleaned.includes("(click to expand)"));
  assert.ok(cleaned.includes("Line one."));
  assert.ok(cleaned.trimEnd().endsWith("</details>"));
});

test("cleanCopilotBody: single line containing <br> is treated as multi-line", () => {
  const body =
    "Pre.\n## Pull request overview\nSummary one<br>Summary two";
  const cleaned = cleanCopilotBody(body);
  assert.ok(cleaned.includes("<details>"));
});

// ---------------------------------------------------------------------------
// isCopilotAuthored
// ---------------------------------------------------------------------------

test("isCopilotAuthored: matches copilot logins case-insensitively", () => {
  assert.ok(isCopilotAuthored({ login: "Copilot" }));
  assert.ok(isCopilotAuthored({ login: "copilot-pull-request-reviewer[bot]" }));
});

test("isCopilotAuthored: false for non-copilot and malformed users", () => {
  assert.equal(isCopilotAuthored({ login: "augmentcode[bot]" }), false);
  assert.equal(isCopilotAuthored(null), false);
  assert.equal(isCopilotAuthored({}), false);
  assert.equal(isCopilotAuthored({ login: 123 }), false);
});

// ---------------------------------------------------------------------------
// cleanLinearbBody
// ---------------------------------------------------------------------------

test("cleanLinearbBody: returns falsy bodies unchanged", () => {
  assert.equal(cleanLinearbBody(""), "");
  assert.equal(cleanLinearbBody(null), null);
});

test("cleanLinearbBody: leaves bodies without the PR Review heading untouched", () => {
  const body = "LinearB said hi without the heading.";
  assert.equal(cleanLinearbBody(body), body);
});

test("cleanLinearbBody: tiny summary is not wrapped in <details>", () => {
  const body = "Intro.\n### ✨ PR Review\nAll good, no issues found.";
  const cleaned = cleanLinearbBody(body);
  assert.ok(!cleaned.includes("<details>"));
  assert.ok(cleaned.includes("All good"));
});

test("cleanLinearbBody: full review with issue sections is collapsed", () => {
  const body =
    "Intro.\n### ✨ PR Review\nFound issues:\n<details><summary>Issue 1</summary>details</details>\nGenerated by LinearB AI and added by gitStream";
  const cleaned = cleanLinearbBody(body);
  assert.ok(cleaned.includes("LinearB PR Summary"));
  assert.ok(cleaned.includes("(click to expand)"));
  assert.ok(cleaned.trimEnd().endsWith("</details>"));
});

// ---------------------------------------------------------------------------
// isLinearbAuthored
// ---------------------------------------------------------------------------

test("isLinearbAuthored: matches by login substring", () => {
  assert.ok(isLinearbAuthored({ login: "linearb-bot[bot]" }, ""));
});

test("isLinearbAuthored: content fallback via gitStream footer marker", () => {
  assert.ok(
    isLinearbAuthored(
      { login: "gitstream-cm[bot]", type: "Bot" },
      "…\nGenerated by LinearB AI and added by gitStream"
    )
  );
});

test("isLinearbAuthored: false for humans and unrelated bots", () => {
  assert.equal(isLinearbAuthored(null, "x"), false);
  assert.equal(isLinearbAuthored({ login: "david", type: "User" }, "hi"), false);
  assert.equal(
    isLinearbAuthored({ login: "gitstream-cm[bot]", type: "Bot" }, "no marker here"),
    false
  );
});
