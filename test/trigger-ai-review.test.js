import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TRIGGER_AUGMENT_PHRASES,
  TRIGGER_COPILOT_PHRASES,
  TRIGGER_RANDOM_PHRASES,
  TRIGGER_LABEL,
  SKIP_TRIGGER_LABEL,
  ALREADY_TRIGGERING_AUGMENT_PHRASES,
} from "../lib/trigger-ai-review.js";

// ---------------------------------------------------------------------------
// Trigger phrase matching
// ---------------------------------------------------------------------------

test("TRIGGER_AUGMENT_PHRASES: matches summon phrases", () => {
  assert.ok(TRIGGER_AUGMENT_PHRASES.test("roast me, auggie"));
  assert.ok(TRIGGER_AUGMENT_PHRASES.test("Auggie please take a look"));
  assert.ok(TRIGGER_AUGMENT_PHRASES.test("ROAST ME AUGGIE")); // case-insensitive
});

test("TRIGGER_AUGMENT_PHRASES: does not match unrelated comments", () => {
  assert.equal(TRIGGER_AUGMENT_PHRASES.test("looks good to me"), false);
  assert.equal(TRIGGER_AUGMENT_PHRASES.test("roast me"), false); // needs 'auggie' too
});

test("TRIGGER_COPILOT_PHRASES: matches copilot summons", () => {
  assert.ok(TRIGGER_COPILOT_PHRASES.test("roast me copilot"));
  assert.ok(TRIGGER_COPILOT_PHRASES.test("copilot please"));
  assert.ok(TRIGGER_COPILOT_PHRASES.test("copilot review"));
});

test("TRIGGER_RANDOM_PHRASES: matches only a standalone 'ai review'", () => {
  assert.ok(TRIGGER_RANDOM_PHRASES.test("ai review"));
  assert.ok(TRIGGER_RANDOM_PHRASES.test("  AI Review  "));
  assert.ok(TRIGGER_RANDOM_PHRASES.test("`ai review`"));
  assert.equal(TRIGGER_RANDOM_PHRASES.test("please do an ai review now"), false);
});

test("TRIGGER_LABEL / SKIP_TRIGGER_LABEL: label gating", () => {
  assert.ok(TRIGGER_LABEL.test("ai-review"));
  assert.ok(TRIGGER_LABEL.test("AI Review"));
  assert.equal(SKIP_TRIGGER_LABEL.test("ai-review"), false);
  assert.ok(SKIP_TRIGGER_LABEL.test("no-ai-review"));
  assert.ok(SKIP_TRIGGER_LABEL.test("skip-ai-review"));
});

test("ALREADY_TRIGGERING_AUGMENT_PHRASES: recognises in-flight triggers", () => {
  assert.ok(ALREADY_TRIGGERING_AUGMENT_PHRASES.test("auggie review"));
  assert.ok(ALREADY_TRIGGERING_AUGMENT_PHRASES.test("augment review"));
  assert.ok(ALREADY_TRIGGERING_AUGMENT_PHRASES.test("augmentcode review"));
  assert.equal(ALREADY_TRIGGERING_AUGMENT_PHRASES.test("roast me auggie"), false);
});
