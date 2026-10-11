import { test } from "node:test";
import assert from "node:assert/strict";

const {
  approvalOf,
  approve,
  fingerprintOf,
  isUiReviewStatus,
  parseStamp,
  prompt,
  renderStamp,
  reviewState,
  unapprove,
  uiReviewStatus,
} = await import("../lib/ui-review-approvals.js");

const LINES = {
  prompt: "> - [ ] **Changes reviewed** - ✅ Check this box to confirm these changes",
  ticked: "> - [x] **Changes reviewed** - ✅ Check this box to confirm these changes",
  approved: "> - [x] ~Changes reviewed~ - Reviewed by @reececomo",
  unticked: "> - [ ] ~Changes reviewed~ - Reviewed by @reececomo",
};
const raw = (fp) => `<!-- found-pixel-comment -->\n<!-- ui-review fp=${fp} -->\n## 📘 UI Review`;
const body = (fp, line = "prompt") =>
  `<!-- found-pixel-comment -->\n<!-- ui-review fp=${fp} -->\n> [!Warning]\n${LINES[line]}\n\n## 📘 UI Review`;
const STAMP = (fp) => `<!-- ui-approved fp=${fp} by=reececomo name="Reece Como" -->`;

test("isUiReviewStatus matches the bare and suited contexts only", () => {
  assert.ok(isUiReviewStatus("UI Review"));
  assert.ok(isUiReviewStatus("UI Review (admin)"));
  assert.ok(!isUiReviewStatus("AI Review"));
  assert.ok(!isUiReviewStatus("UI Review extra"));
  assert.ok(!isUiReviewStatus(undefined));
});

test("fingerprintOf reads the fp param", () => {
  assert.equal(fingerprintOf("https://visreg.he0.io/?r=catalyst&b=feature-x&fp=cb4f8904"), "cb4f8904");
  assert.equal(fingerprintOf("https://visreg.he0.io/?r=catalyst"), null);
  assert.equal(fingerprintOf("not a url"), null);
});

test("reviewState reads the fingerprint, checkbox and its label in any form", () => {
  const state = (line) => reviewState(body("cb4f8904", line));
  assert.deepEqual(state("prompt"), { fp: "cb4f8904", ticked: false, label: "**Changes reviewed** - ✅ Check this box to confirm these changes" });
  assert.deepEqual(state("ticked"), { ...state("prompt"), ticked: true });
  assert.deepEqual(state("approved"), { fp: "cb4f8904", ticked: true, label: "~Changes reviewed~ - Reviewed by @reececomo" });
  assert.deepEqual(state("unticked"), { ...state("approved"), ticked: false });
  assert.equal(reviewState(body("cb4f8904").replace("[ ]", "[X]")).ticked, true);
  assert.equal(reviewState(body("cb4f8904").replace("Changes reviewed", "Approve Changes")).ticked, false);
  assert.equal(reviewState(raw("cb4f8904")), null);
  assert.equal(reviewState(LINES.ticked), null);
  assert.equal(reviewState(undefined), null);
});

test("prompt adds the checkbox under the fingerprint and drops a stale stamp", () => {
  assert.equal(prompt(raw("cb4f8904")), body("cb4f8904"));
  assert.equal(prompt(`${raw("cb4f8904")}\n${STAMP("1a2b3c4d")}`), body("cb4f8904"));
  assert.equal(prompt(body("cb4f8904", "ticked")), body("cb4f8904", "ticked"));
});

test("approve rewrites or adds the approved line and stamps; unapprove reverts", () => {
  const stamp = { fp: "cb4f8904", by: "reececomo", name: 'Reece "RC" <Como> $&' };
  const approved = approve(body("cb4f8904", "ticked"), stamp);
  assert.equal(approved, `${body("cb4f8904", "approved")}\n<!-- ui-approved fp=cb4f8904 by=reececomo name="Reece RC Como $&" -->`);
  assert.equal(approve(`${raw("cb4f8904")}\n${STAMP("cb4f8904")}`, stamp), approved);

  const restamped = approve(approved, { fp: "1a2b3c4d", by: "reececomo", name: "Reece" });
  assert.equal(restamped.match(/ui-approved/g).length, 1);
  assert.equal(parseStamp(restamped).fp, "1a2b3c4d");

  assert.equal(unapprove(approved.replace(LINES.approved, LINES.unticked)), body("cb4f8904"));
});

test("approvalOf needs a stamp for the comment's fingerprint", () => {
  const approval = { fp: "cb4f8904", by: "reececomo", name: "Reece Como" };
  assert.deepEqual(approvalOf(`${body("cb4f8904", "approved")}\n${STAMP("cb4f8904")}`), approval);
  assert.deepEqual(approvalOf(`${body("cb4f8904")}\n${STAMP("cb4f8904")}`), approval);
  assert.deepEqual(approvalOf(`${raw("cb4f8904")}\n${STAMP("cb4f8904")}`), approval);
  assert.equal(approvalOf(`${raw("1a2b3c4d")}\n${STAMP("cb4f8904")}`), null);
  assert.equal(approvalOf(body("cb4f8904", "ticked")), null);
});

test("parseStamp tolerates a missing name", () => {
  assert.deepEqual(parseStamp("x <!-- ui-approved fp=1 by=bob --> y"), { fp: "1", by: "bob", name: "bob" });
});

test("uiReviewStatus combines a required review with outstanding code owners", () => {
  const tool = { state: "pending", description: "3 modified", target_url: "https://v/?fp=cb4f8904" };
  const status = (opts) => uiReviewStatus(tool, { commentUrl: "https://c", ...opts });
  const reece = { approval: { name: "Reece Como" } };
  const jarvis = [["@acme/jarvis"]];

  assert.deepEqual(status({ review: { approval: null } }), { state: "pending", description: "Review needed - 3 modified", target_url: "https://c" });
  assert.deepEqual(status({ review: reece }), { state: "success", description: "✓ Reviewed by Reece Como - 3 modified", target_url: tool.target_url });
  assert.equal(status({ review: reece, owners: { pending: jarvis, approved: [] } }).description, "Needs Jarvis code owner approval, Reviewed by Reece Como - 3 modified");
  assert.equal(status({ review: { approval: null }, owners: { pending: [["@acme/jarvis"], ["@reececomo"]], approved: [] } }).description, "Needs Jarvis, reececomo code owner approval, Review needed - 3 modified");
  assert.deepEqual(status({ review: reece, owners: { pending: [], approved: [["@acme/marketplace", "@acme/patient-accounts"]] } }), {
    state: "success",
    description: "✓ Reviewed by Reece Como, Approved by Marketplace/Patient Accounts - 3 modified",
    target_url: tool.target_url,
  });

  const done = { state: "success", description: "3 modified", target_url: "https://v" };
  assert.deepEqual(uiReviewStatus(done, { review: null, owners: { pending: jarvis, approved: [] }, commentUrl: "https://c" }), {
    state: "pending", description: "Needs Jarvis code owner approval - 3 modified", target_url: "https://c",
  });
  assert.deepEqual(uiReviewStatus(done, { review: null, owners: { pending: [], approved: [] } }), done);
  assert.deepEqual(uiReviewStatus(done, { review: null, owners: null }), done);
});

test("uiReviewStatus stays within 140 chars", () => {
  const tool = { state: "pending", description: "B".repeat(100), target_url: "https://v" };
  const long = uiReviewStatus(tool, { review: { approval: { name: "A".repeat(100) } } }).description;
  assert.equal(long.length, 140);
  assert.ok(long.endsWith("…"));
});
