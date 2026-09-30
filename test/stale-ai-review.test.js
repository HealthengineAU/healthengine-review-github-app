import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { countLinesAddedSince, latestAiReview, measureStaleReview } from "../lib/stale-ai-review.js";
import { compileFilterPatterns } from "../lib/filter-patterns.js";
import { makeOctokit } from "./helpers/mock-github.js";

let originalWarn;
beforeEach(() => {
  originalWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = originalWarn;
});

const file = (filename, added, removed = []) => ({
  filename,
  additions: added.length,
  deletions: removed.length,
  patch: ["@@ -1,1 +1,1 @@", ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n"),
});

// ---------------------------------------------------------------------------
// countLinesAddedSince
// ---------------------------------------------------------------------------

test("countLinesAddedSince: an unchanged PR diff adds nothing (rebases, base merges)", () => {
  const files = [file("a.js", ["one", "two"])];
  assert.deepEqual(countLinesAddedSince(files, files), { linesAdded: 0, prAdditions: 2 });
});

test("countLinesAddedSince: counts only lines new since the review", () => {
  const before = [file("a.js", ["one", "two"])];
  const after = [file("a.js", ["one", "two", "three"]), file("b.js", ["four"])];
  assert.equal(countLinesAddedSince(before, after).linesAdded, 2);
});

test("countLinesAddedSince: an edited line counts once and removals count nothing", () => {
  const before = [file("a.js", ["one", "two", "three"])];
  const after = [file("a.js", ["one", "TWO"], ["old"])];
  assert.equal(countLinesAddedSince(before, after).linesAdded, 1);
});

test("countLinesAddedSince: repeated lines count by multiplicity", () => {
  const before = [file("a.js", ["}"])];
  const after = [file("a.js", ["}", "}", "}"])];
  assert.equal(countLinesAddedSince(before, after).linesAdded, 2);
});

test("countLinesAddedSince: ignored paths count towards neither side", () => {
  const ignore = compileFilterPatterns(["**.lock"]);
  const after = [file("a.js", ["one"]), file("composer.lock", ["x", "y", "z"])];
  assert.deepEqual(countLinesAddedSince([], after, ignore), { linesAdded: 1, prAdditions: 1 });
});

test("countLinesAddedSince: files without a patch fall back to additions growth", () => {
  const before = [{ filename: "big.sql", additions: 100, deletions: 0 }];
  const after = [{ filename: "big.sql", additions: 130, deletions: 0 }];
  assert.equal(countLinesAddedSince(before, after).linesAdded, 30);
});

// ---------------------------------------------------------------------------
// latestAiReview
// ---------------------------------------------------------------------------

test("latestAiReview: the most recent bot review, ignoring humans", () => {
  const reviews = [
    { user: { login: "copilot-pull-request-reviewer[bot]", type: "Bot" }, submitted_at: "2026-07-01T00:00:00Z", commit_id: "a" },
    { user: { login: "augmentcode[bot]", type: "Bot" }, submitted_at: "2026-07-02T00:00:00Z", commit_id: "b" },
    { user: { login: "david", type: "User" }, submitted_at: "2026-07-03T00:00:00Z", commit_id: "c" },
  ];
  assert.equal(latestAiReview(reviews).commit_id, "b");
  assert.equal(latestAiReview([reviews[2]]), null);
});

// ---------------------------------------------------------------------------
// measureStaleReview
// ---------------------------------------------------------------------------

const staleReview = { enabled: true, percent: 5, minLines: 2, ignorePaths: [] };
const copilotReview = (commit_id) => ({
  user: { login: "copilot-pull-request-reviewer[bot]", type: "Bot" },
  submitted_at: "2026-07-01T00:00:00Z",
  commit_id,
});

let prNumber = 0;
const makePr = () => ({ number: ++prNumber, head: { sha: "head" }, base: { ref: "main" } });

function compareOctokit(before, after) {
  return makeOctokit({
    "rest.repos.compareCommitsWithBasehead": ({ basehead }) => ({
      data: { files: basehead.endsWith("...head") ? after : before },
    }),
  });
}

const compareCalls = (octokit) =>
  octokit.calls.filter((c) => c.method === "rest.repos.compareCommitsWithBasehead");

test("measureStaleReview: nothing to measure when the review is on the head commit", async () => {
  const octokit = compareOctokit([], []);
  const result = await measureStaleReview(octokit, {
    owner: "acme", repo: "r1", pr: makePr(), reviews: [copilotReview("head")], staleReview,
  });
  assert.equal(result, null);
  assert.equal(compareCalls(octokit).length, 0);
});

test("measureStaleReview: stale once lines added exceed max(min_lines, percent%)", async () => {
  const lines = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const before = [file("a.js", lines(100, "a"))];
  const within = [file("a.js", [...lines(100, "a"), ...lines(5, "b")])];
  const beyond = [file("a.js", [...lines(100, "a"), ...lines(6, "b")])];

  const fresh = await measureStaleReview(compareOctokit(before, within), {
    owner: "acme", repo: "r2", pr: makePr(), reviews: [copilotReview("reviewed")], staleReview,
  });
  assert.deepEqual(fresh, { reviewer: "copilot-pull-request-reviewer[bot]", linesAdded: 5, limit: 5, stale: false });

  const stale = await measureStaleReview(compareOctokit(before, beyond), {
    owner: "acme", repo: "r2b", pr: makePr(), reviews: [copilotReview("reviewed")], staleReview,
  });
  assert.equal(stale.limit, 5);
  assert.equal(stale.stale, true);
});

test("measureStaleReview: min_lines floors the limit on small PRs", async () => {
  const before = [file("a.js", ["one"])];
  const after = [file("a.js", ["one", "two", "three"])];
  const result = await measureStaleReview(compareOctokit(before, after), {
    owner: "acme", repo: "r3", pr: makePr(), reviews: [copilotReview("reviewed")], staleReview,
  });
  assert.equal(result.limit, 2);
  assert.equal(result.stale, false);
});

test("measureStaleReview: results are cached per reviewed and head commit", async () => {
  const octokit = compareOctokit([], [file("a.js", ["one"])]);
  const pr = makePr();
  const args = { owner: "acme", repo: "r4", pr, reviews: [copilotReview("reviewed")], staleReview };
  await measureStaleReview(octokit, args);
  await measureStaleReview(octokit, args);
  assert.equal(compareCalls(octokit).length, 2);
  assert.deepEqual(
    compareCalls(octokit).map((c) => c.args.basehead).sort(),
    ["main...head", "main...reviewed"],
  );
});

test("measureStaleReview: a failed compare measures nothing", async () => {
  const octokit = makeOctokit({
    "rest.repos.compareCommitsWithBasehead": () => { throw new Error("Not Found"); },
  });
  const result = await measureStaleReview(octokit, {
    owner: "acme", repo: "r5", pr: makePr(), reviews: [copilotReview("reviewed")], staleReview,
  });
  assert.equal(result, null);
});
