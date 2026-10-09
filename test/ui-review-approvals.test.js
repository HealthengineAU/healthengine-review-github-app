import { test } from "node:test";
import assert from "node:assert/strict";

const {
  approvalOf,
  approve,
  approvedDescription,
  baseDescription,
  fingerprintOf,
  isUiReviewStatus,
  parseStamp,
  pendingDescription,
  prompt,
  renderStamp,
  reviewState,
  unapprove,
} = await import("../lib/ui-review-approvals.js");

const LINES = {
  prompt: "> - [ ] **Approve Changes** - ✅ Check this box to confirm UI change approved",
  ticked: "> - [x] **Approve Changes** - ✅ Check this box to confirm UI change approved",
  approved: "> - [x] ~Approve Changes~ - Approved by @reececomo",
  unticked: "> - [ ] ~Approve Changes~ - Approved by @reececomo",
  reverted: "> - [ ] **Approve Changes**",
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

test("reviewState reads the fingerprint and checkbox in any form", () => {
  assert.deepEqual(reviewState(body("cb4f8904")), { fp: "cb4f8904", ticked: false });
  assert.deepEqual(reviewState(body("cb4f8904", "ticked")), { fp: "cb4f8904", ticked: true });
  assert.deepEqual(reviewState(body("cb4f8904", "approved")), { fp: "cb4f8904", ticked: true });
  assert.deepEqual(reviewState(body("cb4f8904", "unticked")), { fp: "cb4f8904", ticked: false });
  assert.deepEqual(reviewState(body("cb4f8904", "reverted")), { fp: "cb4f8904", ticked: false });
  assert.deepEqual(reviewState(body("cb4f8904").replace("[ ]", "[X]")), { fp: "cb4f8904", ticked: true });
  assert.equal(reviewState(raw("cb4f8904")), null);
  assert.equal(reviewState(LINES.ticked), null);
  assert.equal(reviewState(undefined), null);
});

test("prompt adds the checkbox under the fingerprint and drops a stale stamp", () => {
  assert.equal(prompt(raw("cb4f8904")), body("cb4f8904"));
  assert.equal(prompt(`${raw("cb4f8904")}\n${STAMP("1a2b3c4d")}`), body("cb4f8904"));
  assert.equal(prompt(body("cb4f8904", "reverted")), body("cb4f8904", "reverted"));
});

test("approve rewrites or adds the approved line and stamps; unapprove reverts", () => {
  const stamp = { fp: "cb4f8904", by: "reececomo", name: 'Reece "RC" <Como> $&' };
  const approved = approve(body("cb4f8904", "ticked"), stamp);
  assert.equal(approved, `${body("cb4f8904", "approved")}\n<!-- ui-approved fp=cb4f8904 by=reececomo name="Reece RC Como $&" -->`);
  assert.equal(approve(`${raw("cb4f8904")}\n${STAMP("cb4f8904")}`, stamp), approved);

  const restamped = approve(approved, { fp: "1a2b3c4d", by: "reececomo", name: "Reece" });
  assert.equal(restamped.match(/ui-approved/g).length, 1);
  assert.equal(parseStamp(restamped).fp, "1a2b3c4d");

  assert.equal(unapprove(approved.replace(LINES.approved, LINES.unticked)), body("cb4f8904", "reverted"));
});

test("approvalOf needs a stamp for the comment's fingerprint and no unticked box", () => {
  const approval = { fp: "cb4f8904", by: "reececomo", name: "Reece Como" };
  assert.deepEqual(approvalOf(`${body("cb4f8904", "approved")}\n${STAMP("cb4f8904")}`), approval);
  assert.deepEqual(approvalOf(`${raw("cb4f8904")}\n${STAMP("cb4f8904")}`), approval);
  assert.equal(approvalOf(`${body("cb4f8904", "unticked")}\n${STAMP("cb4f8904")}`), null);
  assert.equal(approvalOf(`${raw("1a2b3c4d")}\n${STAMP("cb4f8904")}`), null);
  assert.equal(approvalOf(body("cb4f8904", "ticked")), null);
});

test("parseStamp tolerates a missing name", () => {
  assert.deepEqual(parseStamp("x <!-- ui-approved fp=1 by=bob --> y"), { fp: "1", by: "bob", name: "bob" });
});

test("descriptions keep the tool's text under any prefix and stay within 140 chars", () => {
  assert.equal(baseDescription("3 modified"), "3 modified");
  assert.equal(baseDescription("Approve in the PR comment - 3 modified"), "3 modified");
  assert.equal(baseDescription("✓ Reviewed by Reece Como - 3 modified"), "3 modified");
  assert.equal(pendingDescription("✓ Reviewed by X - 1 added, 2 modified"), "Approve in the PR comment - 1 added, 2 modified");
  assert.equal(approvedDescription("Reece Como", "Approve in the PR comment - 3 modified"), "✓ Reviewed by Reece Como - 3 modified");
  const long = approvedDescription("A".repeat(100), "B".repeat(100));
  assert.equal(long.length, 140);
  assert.ok(long.endsWith("…"));
});
