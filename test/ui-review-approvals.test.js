import { test } from "node:test";
import assert from "node:assert/strict";

process.env.WEBHOOK_SECRET = "test-secret";

const {
  approvedDescription,
  baseDescription,
  commentFingerprint,
  fingerprintOf,
  isUiReviewStatus,
  parseStamp,
  pendingDescription,
  renderStamp,
  signStamp,
  suggestedLabel,
  validStamp,
  withStamp,
  withoutStamp,
} = await import("../lib/ui-review-approvals.js");

test("suggestedLabel is stable per PR number", () => {
  assert.equal(suggestedLabel(0), "gorgeous");
  assert.equal(suggestedLabel(4), "sublime");
  assert.equal(suggestedLabel(57), "splendid");
});

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

test("stamp round-trips through a comment body and verifies its signature", () => {
  const body = "<!-- found-pixel-comment -->\n<!-- ui-review fp=cb4f8904 -->\n### 📘 UI Review\n\nDetected 3 stories changed";
  assert.equal(commentFingerprint(body), "cb4f8904");
  assert.equal(parseStamp(body), null);

  const sig = signStamp(42, "cb4f8904");
  const stamped = withStamp(body, { by: "reececomo", name: 'Reece "RC" <Como>', fp: "cb4f8904", sig });
  assert.ok(stamped.endsWith(`\n<!-- ui-approved by=reececomo name="Reece RC Como" fp=cb4f8904 sig=${sig} -->`));
  assert.deepEqual(parseStamp(stamped), { by: "reececomo", name: "Reece RC Como", fp: "cb4f8904", sig });
  assert.deepEqual(validStamp({ id: 42, body: stamped }), parseStamp(stamped));
  assert.equal(validStamp({ id: 43, body: stamped }), null);
  assert.equal(validStamp({ id: 42, body: stamped.replace("fp=cb4f8904 sig", "fp=deadbeef sig") }), null);

  const restamped = withStamp(stamped, { by: "alice", name: "Alice", fp: "1a2b3c4d", sig: "x" });
  assert.equal(restamped.match(/ui-approved/g).length, 1);
  assert.equal(parseStamp(restamped).fp, "1a2b3c4d");
  assert.equal(withoutStamp(restamped), body);
});

test("signStamp is 16 hex chars and depends on the comment id and fingerprint", () => {
  assert.match(signStamp(1, "a"), /^[0-9a-f]{16}$/);
  assert.notEqual(signStamp(1, "a"), signStamp(2, "a"));
  assert.notEqual(signStamp(1, "a"), signStamp(1, "b"));
});

test("renderStamp / parseStamp tolerate a missing name", () => {
  assert.deepEqual(parseStamp("x <!-- ui-approved by=bob fp=1 sig=s --> y"), { by: "bob", name: "bob", fp: "1", sig: "s" });
  assert.equal(renderStamp({ by: "bob", name: "Bob", fp: "1", sig: "s" }), '<!-- ui-approved by=bob name="Bob" fp=1 sig=s -->');
});

test("descriptions keep the tool's text under any prefix and stay within 140 chars", () => {
  assert.equal(baseDescription("3 modified"), "3 modified");
  assert.equal(baseDescription('Add "sublime" label — 3 modified'), "3 modified");
  assert.equal(baseDescription("Approved by Reece Como — 3 modified"), "3 modified");
  assert.equal(pendingDescription("sublime", "Approved by X — 1 added, 2 modified"), 'Add "sublime" label — 1 added, 2 modified');
  assert.equal(approvedDescription("Reece Como", 'Add "sublime" label — 3 modified'), "Approved by Reece Como — 3 modified");
  const long = approvedDescription("A".repeat(100), "B".repeat(100));
  assert.equal(long.length, 140);
  assert.ok(long.endsWith("…"));
});
