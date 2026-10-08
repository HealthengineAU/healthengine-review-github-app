import { test } from "node:test";
import assert from "node:assert/strict";

import {
  approvedDescription,
  baseDescription,
  commentFingerprint,
  fingerprintOf,
  isUiReviewStatus,
  parseStamp,
  pendingDescription,
  renderStamp,
  suggestedLabel,
  withStamp,
  withoutFingerprint,
  withoutStamp,
} from "../lib/ui-review-approvals.js";

test("suggestedLabel is stable per PR number", () => {
  assert.equal(suggestedLabel(0), "gorgeous");
  assert.equal(suggestedLabel(4), "sublime");
  assert.equal(suggestedLabel(57), "splendid");
  assert.equal(suggestedLabel(57), suggestedLabel(57));
});

test("isUiReviewStatus matches the bare and suited contexts only", () => {
  assert.ok(isUiReviewStatus("UI Review"));
  assert.ok(isUiReviewStatus("UI Review (admin)"));
  assert.ok(!isUiReviewStatus("AI Review"));
  assert.ok(!isUiReviewStatus("UI Review extra"));
  assert.ok(!isUiReviewStatus(undefined));
});

test("fingerprintOf / withoutFingerprint read and strip the fp param", () => {
  const url = "https://visreg.he0.io/?r=catalyst&b=feature-x&fp=cb4f8904";
  assert.equal(fingerprintOf(url), "cb4f8904");
  assert.equal(withoutFingerprint(url), "https://visreg.he0.io/?r=catalyst&b=feature-x");
  assert.equal(fingerprintOf("https://visreg.he0.io/?r=catalyst"), null);
  assert.equal(fingerprintOf("not a url"), null);
  assert.equal(withoutFingerprint("not a url"), "not a url");
});

test("stamp round-trips through a comment body", () => {
  const body = "<!-- found-pixel-comment -->\n<!-- ui-review fp=cb4f8904 -->\n### 📘 UI Review\n\nDetected 3 stories changed";
  assert.equal(commentFingerprint(body), "cb4f8904");
  assert.equal(parseStamp(body), null);

  const stamped = withStamp(body, { by: "reececomo", name: 'Reece "RC" Como', fp: "cb4f8904" });
  assert.ok(stamped.endsWith(`\n<!-- ui-approved by=reececomo name="Reece 'RC' Como" fp=cb4f8904 -->`));
  assert.deepEqual(parseStamp(stamped), { by: "reececomo", name: "Reece 'RC' Como", fp: "cb4f8904" });

  const restamped = withStamp(stamped, { by: "alice", name: "Alice", fp: "1a2b3c4d" });
  assert.equal(restamped.match(/ui-approved/g).length, 1);
  assert.deepEqual(parseStamp(restamped), { by: "alice", name: "Alice", fp: "1a2b3c4d" });
  assert.equal(withoutStamp(restamped), body);
});

test("renderStamp / parseStamp tolerate a missing name", () => {
  assert.deepEqual(parseStamp("x <!-- ui-approved by=bob fp=1 --> y"), { by: "bob", name: "bob", fp: "1" });
  assert.equal(renderStamp({ by: "bob", name: "Bob", fp: "1" }), '<!-- ui-approved by=bob name="Bob" fp=1 -->');
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
