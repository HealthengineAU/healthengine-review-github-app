import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractReferences,
  mentionsReference,
  missingReferences,
  withIssueLinks,
} from "../lib/link-issue-keys.js";
import { normalizeIssueLinkRules } from "../lib/config.js";

const RULES = normalizeIssueLinkRules([
  { keys: ["ABC", "XY", "TEAM", "PROJ"], url: "https://example.atlassian.net/browse/$KEY-$NUMBER" },
  { keys: ["THING-SESSION"], label: "session #$NUMBER", url: "https://github.com/example-org/example-repo/issues/$NUMBER" },
]);

const jira = (key, number) => ({
  token: `${key}-${number}`,
  label: `${key}-${number}`,
  url: `https://example.atlassian.net/browse/${key}-${number}`,
});

// ---------------------------------------------------------------------------
// extractReferences
// ---------------------------------------------------------------------------

test("extractReferences: finds a key at the start of a branch", () => {
  assert.deepEqual(extractReferences("ABC-5752-bearer-tokens", RULES), [jira("ABC", 5752)]);
  assert.deepEqual(extractReferences("ABC-5752", RULES), [jira("ABC", 5752)]);
});

test("extractReferences: finds a key mid-branch and upper-cases it", () => {
  assert.deepEqual(extractReferences("claude/xy-123-ticket", RULES), [jira("XY", 123)]);
  assert.deepEqual(extractReferences("someone/PROJ-123-describing-the-work", RULES), [jira("PROJ", 123)]);
  assert.deepEqual(extractReferences("Team-951", RULES), [jira("TEAM", 951)]);
});

test("extractReferences: a trailing sub-branch marker isn't part of the key", () => {
  assert.deepEqual(extractReferences("ABC-284a-soonest-appts", RULES), [jira("ABC", 284)]);
  assert.deepEqual(extractReferences("ABC-4770b", RULES), [jira("ABC", 4770)]);
  assert.deepEqual(extractReferences("ABC-1960-5", RULES), [jira("ABC", 1960)]);
});

test("extractReferences: keys no rule claims are ignored", () => {
  assert.deepEqual(extractReferences("node-21", RULES), []);
  assert.deepEqual(extractReferences("bump-hono-4-13-8", RULES), []);
  assert.deepEqual(extractReferences("f18-fighter/laravel-12-upgrade", RULES), []);
});

test("extractReferences: ignores version numbers and word fragments", () => {
  const anyKey = normalizeIssueLinkRules([{ keys: ["*"], url: "https://example.test/$KEY-$NUMBER" }]);
  assert.deepEqual(extractReferences("chore/bump-core-app-1.2.328", anyKey), []);
  assert.deepEqual(extractReferences("dependabot-npm_and_yarn-joi-17.13.8", anyKey), []);
  // No digits at all, so nothing looks like an issue.
  assert.deepEqual(extractReferences("abc-update-libphonenumber-c", anyKey), []);
  // The key must start on a boundary — "xabc-1" is not ABC-1.
  assert.deepEqual(extractReferences("xabc-1", RULES), []);
});

test("extractReferences: a key can span hyphens, so near-identical keys don't collide", () => {
  assert.deepEqual(extractReferences("claude/thing-session-220-storybook-port", RULES), [
    {
      token: "THING-SESSION-220",
      label: "session #220",
      url: "https://github.com/example-org/example-repo/issues/220",
    },
  ]);
  // Same trailing segment, different owner — no rule claims it.
  assert.deepEqual(extractReferences("claude/else-session-220-storybook-port", RULES), []);
  assert.deepEqual(extractReferences("session-220", RULES), []);
});

test("extractReferences: the longest key a rule claims wins", () => {
  const rules = normalizeIssueLinkRules([
    { keys: ["SESSION"], url: "https://example.test/short/$NUMBER" },
    { keys: ["THING-SESSION"], url: "https://example.test/long/$NUMBER" },
  ]);
  assert.equal(extractReferences("thing-session-220", rules)[0].url, "https://example.test/long/220");
  assert.equal(extractReferences("other-session-220", rules)[0].url, "https://example.test/short/220");
});

test("extractReferences: a key followed by a sentence still counts", () => {
  assert.deepEqual(extractReferences("ABC-123. Fix validation", RULES), [jira("ABC", 123)]);
  assert.deepEqual(extractReferences("ABC-123: fix validation", RULES), [jira("ABC", 123)]);
  assert.deepEqual(extractReferences("(ABC-123) fix validation", RULES), [jira("ABC", 123)]);
});

test("extractReferences: $key substitutes the lower-cased key", () => {
  const rules = normalizeIssueLinkRules([
    { keys: ["ABC"], label: "$key-$NUMBER", url: "https://example.test/$key/$NUMBER" },
  ]);
  assert.deepEqual(extractReferences("ABC-7", rules), [
    { token: "ABC-7", label: "abc-7", url: "https://example.test/abc/7" },
  ]);
});

test("extractReferences: dedupes and keeps order", () => {
  assert.deepEqual(
    extractReferences("ABC-1183 and XY-954, plus ABC-1183 again", RULES),
    [jira("ABC", 1183), jira("XY", 954)],
  );
});

test("extractReferences: non-strings yield nothing", () => {
  assert.deepEqual(extractReferences(undefined, RULES), []);
  assert.deepEqual(extractReferences(null, RULES), []);
});

// ---------------------------------------------------------------------------
// mentionsReference
// ---------------------------------------------------------------------------

test("mentionsReference: bare text, any case, and the link itself all count", () => {
  assert.equal(mentionsReference("Fixes ABC-5752 for good", jira("ABC", 5752)), true);
  assert.equal(mentionsReference("see abc-5752", jira("ABC", 5752)), true);
  assert.equal(
    mentionsReference("https://example.atlassian.net/browse/ABC-5752", jira("ABC", 5752)),
    true,
  );
});

test("mentionsReference: a url-only reference is spotted by its url", () => {
  const reference = {
    token: "SESSION-220",
    label: "session #220",
    url: "https://github.com/example-org/example-repo/issues/220",
  };
  assert.equal(mentionsReference("See https://github.com/example-org/example-repo/issues/220", reference), true);
  assert.equal(mentionsReference("See issue 220", reference), false);
});

test("mentionsReference: a longer neighbouring key doesn't count", () => {
  assert.equal(mentionsReference("ABC-57521 is a different issue", jira("ABC", 5752)), false);
  assert.equal(mentionsReference("", jira("ABC", 5752)), false);
  assert.equal(mentionsReference(null, jira("ABC", 5752)), false);
});

// ---------------------------------------------------------------------------
// missingReferences
// ---------------------------------------------------------------------------

test("missingReferences: branch key absent from the description", () => {
  assert.deepEqual(
    missingReferences({
      branch: "ABC-5752",
      title: "Reject malformed bearer tokens",
      body: "Malformed bearer tokens (empty strings, ...",
      rules: RULES,
    }),
    [jira("ABC", 5752)],
  );
});

test("missingReferences: a key already in the description is left to the tracker", () => {
  assert.deepEqual(
    missingReferences({
      branch: "ABC-5752",
      title: "ABC-5752 - Reject malformed bearer tokens",
      body: "Part of ABC-5752.",
      rules: RULES,
    }),
    [],
  );
});

test("missingReferences: takes references from the title too, branch first", () => {
  assert.deepEqual(
    missingReferences({
      branch: "ABC-1183-tracking",
      title: "XY-954 tracking uplift",
      body: "",
      rules: RULES,
    }),
    [jira("ABC", 1183), jira("XY", 954)],
  );
});

test("missingReferences: the same reference in branch and title is added once", () => {
  assert.deepEqual(
    missingReferences({ branch: "ABC-1183-tracking", title: "ABC-1183 tracking uplift", body: "", rules: RULES }),
    [jira("ABC", 1183)],
  );
});

// ---------------------------------------------------------------------------
// withIssueLinks
// ---------------------------------------------------------------------------

test("withIssueLinks: prepends the link above the existing description", () => {
  assert.equal(
    withIssueLinks({
      body: "Malformed bearer tokens (empty strings, ...",
      references: [jira("ABC", 5752)],
    }),
    "[ABC-5752](https://example.atlassian.net/browse/ABC-5752)\n\nMalformed bearer tokens (empty strings, ...",
  );
});

test("withIssueLinks: leading indentation in the description is preserved", () => {
  assert.equal(
    withIssueLinks({ body: "    indented code block\n", references: [jira("ABC", 5752)] }),
    "[ABC-5752](https://example.atlassian.net/browse/ABC-5752)\n\n    indented code block\n",
  );
  // Leading blank lines would otherwise stack up under the link.
  assert.equal(
    withIssueLinks({ body: "\n\nSummary.", references: [jira("ABC", 5752)] }),
    "[ABC-5752](https://example.atlassian.net/browse/ABC-5752)\n\nSummary.",
  );
});

test("withIssueLinks: an empty description becomes just the links", () => {
  assert.equal(
    withIssueLinks({ body: "", references: [jira("ABC", 951), jira("XY", 1183)] }),
    "[ABC-951](https://example.atlassian.net/browse/ABC-951) [XY-1183](https://example.atlassian.net/browse/XY-1183)",
  );
  assert.equal(
    withIssueLinks({ body: null, references: [jira("ABC", 951)] }),
    "[ABC-951](https://example.atlassian.net/browse/ABC-951)",
  );
});
