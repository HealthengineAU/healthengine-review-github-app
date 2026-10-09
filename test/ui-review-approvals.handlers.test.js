import { test } from "node:test";
import assert from "node:assert/strict";

import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";
import { register } from "../lib/ui-review-approvals.js";

const SHA = "3897e0b2a142230837e29e68dc4b18a8d318166e";
const URL = (fp) => `https://visreg.he0.io/?r=catalyst&b=feature-x${fp ? `&fp=${fp}` : ""}`;
const STAMP = (fp, name = "Reece Como") => `<!-- ui-approved fp=${fp} by=reececomo name="${name}" -->`;

const LINES = {
  prompt: "> - [ ] **Approve Changes** - ✅ Check this box to confirm these changes",
  ticked: "> - [x] **Approve Changes** - ✅ Check this box to confirm these changes",
  approved: (login = "reececomo") => `> - [x] ~Approve Changes~ - Approved by @${login}`,
  unticked: "> - [ ] ~Approve Changes~ - Approved by @reececomo",
};

const COMMENT_URL = (id) => `https://github.com/acme/catalyst/pull/57#issuecomment-${id}`;

const toolComment = (id, fp, { line = LINES.prompt, stampFp, suite } = {}) => ({
  id,
  html_url: COMMENT_URL(id),
  body: [
    suite ? `<!-- visreg-comment:${suite} -->` : "<!-- found-pixel-comment -->",
    `<!-- ui-review fp=${fp} -->`,
    ...(line ? ["> [!Warning]", line, ""] : []),
    "## 📘 UI Review",
    ...(stampFp ? [STAMP(stampFp)] : []),
  ].join("\n"),
});
const rawComment = (id, fp, opts = {}) => toolComment(id, fp, { line: null, ...opts });
const approvedComment = (id, fp, opts = {}) => toolComment(id, fp, { line: LINES.approved(), stampFp: fp, ...opts });

const pr = ({ number = 57, state = "open" } = {}) => ({ number, state, head: { sha: SHA } });

const status = ({ context = "UI Review", state = "pending", description = "3 modified", fp = "cb4f8904" } = {}) => ({
  context, state, description, target_url: URL(fp),
});

const statusPayload = (overrides = {}) => ({ ...status(overrides), sha: SHA, repository: { name: "catalyst" } });

function setup({ prs = [pr()], current, comments = [], comment, statuses, user = { name: "Reece Como" } } = {}) {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit({
    "rest.repos.listPullRequestsAssociatedWithCommit": { data: prs },
    "rest.pulls.get": { data: current ?? prs[0] },
    "rest.issues.getComment": { data: comment },
    "paginate:rest.issues.listComments": comments,
    "paginate:rest.repos.listCommitStatusesForRef": statuses,
    "rest.users.getByUsername": { data: user },
  });
  const calls = (method) => octokit.calls.filter((c) => c.method === method).map((c) => c.args);
  const posted = () => calls("rest.repos.createCommitStatus").map((a) => [a.context, a.state, a.description, a.target_url]);
  return { dispatch, octokit, calls, posted, context: (payload) => makeContext({ octokit, payload, repo: "catalyst" }) };
}

// The event is the latest status for its context unless a test says otherwise.
const onStatus = (t, overrides = {}) => t.dispatch("status", t.context(statusPayload(overrides)));
const withEvent = (overrides = {}, others = []) => [status(overrides), ...others];

test("status: pending without an approval adds the checkbox and points the status at the comment", async () => {
  const t = setup({ comments: [rawComment(1, "cb4f8904")], statuses: withEvent() });
  await onStatus(t);
  assert.deepEqual(t.calls("rest.issues.updateComment").map((a) => [a.comment_id, a.body]), [[1, toolComment(1, "cb4f8904").body]]);
  assert.deepEqual(t.posted(), [["UI Review", "pending", "Approval needed - 3 modified", COMMENT_URL(1)]]);
  assert.equal(t.calls("rest.repos.createCommitStatus")[0].sha, SHA);
});

test("status: non-pending statuses, the app's own rewrites, statuses without fp, and other contexts are ignored", async () => {
  const t = setup({ statuses: withEvent() });
  await onStatus(t, { state: "success" });
  await onStatus(t, { description: "Approval needed - 3 modified" });
  await onStatus(t, { fp: null });
  await onStatus(t, { context: "AI Review" });
  assert.equal(t.octokit.calls.length, 0);
});

test("status: a stale event (the context has moved on) is ignored", async () => {
  const t = setup({
    comments: [rawComment(1, "cb4f8904", { stampFp: "cb4f8904" })],
    statuses: [status({ state: "error", description: "storybook-diff could not read this Storybook build", fp: null })],
  });
  await onStatus(t);
  assert.equal(t.posted().length, 0);
  assert.equal(t.calls("rest.issues.updateComment").length, 0);
});

test("status: no open PR at this head means nothing happens", async () => {
  const t = setup({ prs: [pr({ state: "closed" }), { ...pr(), head: { sha: "other" } }], statuses: withEvent() });
  await onStatus(t);
  assert.equal(t.posted().length, 0);
});

test("status: a stamp for the same fingerprint carries the approval forward", async () => {
  const t = setup({ comments: [rawComment(1, "cb4f8904", { stampFp: "cb4f8904" })], statuses: withEvent() });
  await onStatus(t);
  assert.deepEqual(t.calls("rest.issues.updateComment").map((a) => a.body), [approvedComment(1, "cb4f8904").body]);
  assert.deepEqual(t.posted(), [["UI Review", "success", "✓ Reviewed by Reece Como - 3 modified", URL("cb4f8904")]]);
});

test("status: an already approved comment is left alone", async () => {
  const t = setup({ comments: [approvedComment(1, "cb4f8904")], statuses: withEvent() });
  await onStatus(t);
  assert.equal(t.calls("rest.issues.updateComment").length, 0);
  assert.deepEqual(t.posted().map((p) => p[1]), ["success"]);
});

test("status: a stamp for a different fingerprint is dropped and the prompt added", async () => {
  const t = setup({ comments: [rawComment(1, "11111111", { stampFp: "cb4f8904" })], statuses: withEvent({ fp: "11111111" }) });
  await onStatus(t, { fp: "11111111" });
  assert.deepEqual(t.calls("rest.issues.updateComment").map((a) => a.body), [toolComment(1, "11111111").body]);
  assert.deepEqual(t.posted().map((p) => p[1]), ["pending"]);
});

test("status: found-pixel's fresh prompt with a carried stamp for the same fingerprint is approved", async () => {
  const t = setup({ comments: [toolComment(1, "cb4f8904", { stampFp: "cb4f8904" })], statuses: withEvent() });
  await onStatus(t);
  assert.deepEqual(t.calls("rest.issues.updateComment").map((a) => a.body), [approvedComment(1, "cb4f8904").body]);
  assert.deepEqual(t.posted(), [["UI Review", "success", "✓ Reviewed by Reece Como - 3 modified", URL("cb4f8904")]]);
});

test("status: a ticked box without a stamp stays pending and keeps the box", async () => {
  const t = setup({ comments: [toolComment(1, "cb4f8904", { line: LINES.ticked })], statuses: withEvent() });
  await onStatus(t);
  assert.equal(t.calls("rest.issues.updateComment").length, 0);
  assert.deepEqual(t.posted().map((p) => p[1]), ["pending"]);
});

test("status: without a comment for the fingerprint only the status is touched", async () => {
  const t = setup({ comments: [rawComment(1, "11111111")], statuses: withEvent() });
  await onStatus(t);
  assert.equal(t.calls("rest.issues.updateComment").length, 0);
  assert.deepEqual(t.posted(), [["UI Review", "pending", "Approval needed - 3 modified", URL("cb4f8904")]]);
});

test("status: each suite is approved by its own comment", async () => {
  const t = setup({
    comments: [rawComment(1, "cb4f8904"), approvedComment(2, "22222222", { suite: "admin" })],
    statuses: withEvent({ context: "UI Review (admin)", fp: "22222222" }),
  });
  await onStatus(t, { context: "UI Review (admin)", fp: "22222222" });
  assert.equal(t.calls("rest.issues.updateComment").length, 0);
  assert.deepEqual(t.posted(), [["UI Review (admin)", "success", "✓ Reviewed by Reece Como - 3 modified", URL("22222222")]]);
});

const editPayload = (from, to, { id = 1, login = "reececomo" } = {}) => ({
  comment: { id, body: to.body, html_url: COMMENT_URL(id) },
  changes: { body: { from: from.body } },
  issue: { number: 57, pull_request: {} },
  sender: { login, type: "User" },
});

const onEdit = (t, from, to, opts) => t.dispatch("issue_comment.edited", t.context(editPayload(from, to, opts)));

test("issue_comment.edited: ticking approves the comment and flips the pending statuses with its fingerprint", async () => {
  const ticked = toolComment(1, "cb4f8904", { line: LINES.ticked });
  const t = setup({
    comment: ticked,
    statuses: [
      { ...status({ description: "Approval needed - 3 modified" }), target_url: COMMENT_URL(1) },
      status({ context: "UI Review (admin)", description: "1 added", fp: "1a2b3c4d" }),
      status(),
      status({ context: "UI Review (done)", state: "success", description: "No changes", fp: null }),
    ],
  });
  await onEdit(t, toolComment(1, "cb4f8904"), ticked);

  assert.deepEqual(t.calls("rest.issues.updateComment").map((a) => [a.comment_id, a.body]), [[1, approvedComment(1, "cb4f8904").body]]);
  assert.deepEqual(t.posted(), [["UI Review", "success", "✓ Reviewed by Reece Como - 3 modified", URL("cb4f8904")]]);
});

test("issue_comment.edited: display names are sanitised and fall back to the login", async () => {
  const ticked = toolComment(1, "cb4f8904", { line: LINES.ticked });
  const t = setup({ comment: ticked, statuses: [status()], user: { name: null } });
  await onEdit(t, toolComment(1, "cb4f8904"), ticked);
  assert.equal(t.posted()[0][2], "✓ Reviewed by reececomo - 3 modified");

  const u = setup({ comment: ticked, statuses: [status()], user: { name: "Alice <alice@example.com>" } });
  await onEdit(u, toolComment(1, "cb4f8904"), ticked);
  assert.equal(u.posted()[0][2], "✓ Reviewed by Alice alice@example.com - 3 modified");
  assert.ok(u.calls("rest.issues.updateComment")[0].body.endsWith(STAMP("cb4f8904", "Alice alice@example.com")));
});

test("issue_comment.edited: unticking puts the comment back and reverts approved statuses", async () => {
  const unticked = toolComment(1, "cb4f8904", { line: LINES.unticked, stampFp: "cb4f8904" });
  const t = setup({
    comment: unticked,
    statuses: [
      status({ state: "success", description: "✓ Reviewed by Reece Como - 3 modified" }),
      status({ context: "UI Review (admin)", state: "success", description: "✓ Reviewed by Reece Como - 1 added", fp: "1a2b3c4d" }),
      status(),
      status({ context: "UI Review (admin)", description: "1 added", fp: "1a2b3c4d" }),
    ],
  });
  await onEdit(t, approvedComment(1, "cb4f8904"), unticked);

  assert.deepEqual(t.calls("rest.issues.updateComment").map((a) => a.body), [toolComment(1, "cb4f8904").body]);
  assert.deepEqual(t.posted(), [["UI Review", "pending", "Approval needed - 3 modified", COMMENT_URL(1)]]);
});

test("issue_comment.edited: rewrites that don't just toggle the box are ignored", async () => {
  const t = setup();
  await onEdit(t, toolComment(1, "cb4f8904", { line: LINES.ticked }), approvedComment(1, "cb4f8904"));
  await onEdit(t, toolComment(1, "cb4f8904", { line: LINES.unticked }), toolComment(1, "cb4f8904"));
  await onEdit(t, approvedComment(1, "cb4f8904"), toolComment(1, "cb4f8904", { stampFp: "cb4f8904" }));
  await onEdit(t, rawComment(1, "cb4f8904"), toolComment(1, "cb4f8904"));
  await onEdit(t, approvedComment(1, "cb4f8904"), toolComment(1, "1a2b3c4d"));
  await onEdit(t, { body: "hi" }, { body: "hello" });
  assert.equal(t.octokit.calls.length, 0);
});

test("issue_comment.edited: a stale event (the comment has moved on) does nothing", async () => {
  const t = setup({ comment: toolComment(1, "1a2b3c4d") });
  await onEdit(t, toolComment(1, "cb4f8904"), toolComment(1, "cb4f8904", { line: LINES.ticked }));
  assert.deepEqual(t.octokit.calls.map((c) => c.method), ["rest.issues.getComment"]);
});

test("issue_comment.edited: a closed PR does nothing", async () => {
  const ticked = toolComment(1, "cb4f8904", { line: LINES.ticked });
  const t = setup({ comment: ticked, current: pr({ state: "closed" }) });
  await onEdit(t, toolComment(1, "cb4f8904"), ticked);
  assert.deepEqual(t.octokit.calls.map((c) => c.method), ["rest.issues.getComment", "rest.pulls.get"]);
});
