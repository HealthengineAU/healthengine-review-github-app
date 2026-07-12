import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  KNOWN_PROVIDERS,
  normalizeAutoReview,
  normalizeProviders,
  loadAiReviewConfig,
} from "../lib/config.js";
import { matchesFilterPatterns } from "../lib/filter-patterns.js";

// Several tests here intentionally exercise the "unknown provider" and
// "config load failed" branches, which log via console.warn/error. Silence
// them so the expected noise doesn't clutter test output.
let originalWarn;
let originalError;
beforeEach(() => {
  originalWarn = console.warn;
  originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
});
afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
});

// ---------------------------------------------------------------------------
// normalizeProviders
// ---------------------------------------------------------------------------

test("normalizeProviders: returns null for non-arrays", () => {
  assert.equal(normalizeProviders(undefined), null);
  assert.equal(normalizeProviders(null), null);
  assert.equal(normalizeProviders("claude"), null);
  assert.equal(normalizeProviders({ providers: [] }), null);
});

test("normalizeProviders: returns null for an empty or all-invalid list", () => {
  assert.equal(normalizeProviders([]), null);
  assert.equal(normalizeProviders(["nonsense", "", "  "]), null);
  assert.equal(normalizeProviders([123, {}, null]), null);
});

test("normalizeProviders: keeps only known providers, lower-cased and trimmed", () => {
  const result = normalizeProviders(["  Claude ", "COPILOT", "augment"]);
  assert.ok(result instanceof Set);
  assert.deepEqual([...result].sort(), ["augment", "claude", "copilot"]);
});

test("normalizeProviders: drops unknown providers but keeps valid ones", () => {
  const result = normalizeProviders(["claude", "skynet"]);
  assert.deepEqual([...result], ["claude"]);
});

test("normalizeProviders: de-duplicates repeated providers", () => {
  const result = normalizeProviders(["claude", "claude", "Claude"]);
  assert.equal(result.size, 1);
});

test("normalizeProviders: every KNOWN_PROVIDER round-trips", () => {
  const result = normalizeProviders(KNOWN_PROVIDERS);
  assert.deepEqual([...result].sort(), [...KNOWN_PROVIDERS].sort());
});

// ---------------------------------------------------------------------------
// loadAiReviewConfig
// ---------------------------------------------------------------------------

// Build a fake Probot context whose repo() is unique per test (so the module's
// per-repo cache doesn't leak state between cases), and whose config() resolves
// or rejects with whatever the test provides.
let repoCounter = 0;
function makeContext({ configValue, configError } = {}) {
  const repo = `repo-${repoCounter++}`;
  return {
    repo: () => ({ owner: "acme", repo }),
    config: async () => {
      if (configError) throw configError;
      return configValue;
    },
  };
}

test("loadAiReviewConfig: uses providers from the config file", async () => {
  const ctx = makeContext({ configValue: { providers: ["claude", "copilot"] } });
  const config = await loadAiReviewConfig(ctx);
  assert.ok(config.isProviderEnabled("claude"));
  assert.ok(config.isProviderEnabled("copilot"));
  assert.equal(config.isProviderEnabled("augment"), false);
});

test("loadAiReviewConfig: falls back to all providers when no config file", async () => {
  const ctx = makeContext({ configValue: null });
  const config = await loadAiReviewConfig(ctx);
  for (const provider of KNOWN_PROVIDERS) {
    assert.ok(config.isProviderEnabled(provider), `${provider} should be enabled`);
  }
});

test("loadAiReviewConfig: falls back to all providers when the list is empty/invalid", async () => {
  const ctx = makeContext({ configValue: { providers: ["bogus"] } });
  const config = await loadAiReviewConfig(ctx);
  assert.equal(config.providers.size, KNOWN_PROVIDERS.length);
});

test("loadAiReviewConfig: falls back to defaults when config() throws", async () => {
  const ctx = makeContext({ configError: new Error("network down") });
  const config = await loadAiReviewConfig(ctx);
  assert.equal(config.providers.size, KNOWN_PROVIDERS.length);
});

test("loadAiReviewConfig: caches per repo (config() called once)", async () => {
  let calls = 0;
  const ctx = {
    repo: () => ({ owner: "acme", repo: "cache-repo" }),
    config: async () => {
      calls++;
      return { providers: ["claude"] };
    },
  };
  await loadAiReviewConfig(ctx);
  await loadAiReviewConfig(ctx);
  assert.equal(calls, 1);
});

test("loadAiReviewConfig: exposes a providers Set and isProviderEnabled()", async () => {
  const ctx = makeContext({ configValue: { providers: ["greptile"] } });
  const config = await loadAiReviewConfig(ctx);
  assert.ok(config.providers instanceof Set);
  assert.equal(typeof config.isProviderEnabled, "function");
  assert.ok(config.isProviderEnabled("greptile"));
});

// ---------------------------------------------------------------------------
// normalizeAutoReview
// ---------------------------------------------------------------------------

test("normalizeAutoReview: defaults for missing or junk values", () => {
  for (const raw of [undefined, null, {}, "nonsense", 42]) {
    const result = normalizeAutoReview(raw);
    assert.equal(result.enabled, true);
    // Branches default to the mainline trio…
    for (const branch of ["master", "main", "develop"]) {
      assert.ok(matchesFilterPatterns(result.branches, branch), branch);
    }
    assert.equal(matchesFilterPatterns(result.branches, "feature/x"), false);
    // …while repositories and authors default to match-everything.
    assert.ok(matchesFilterPatterns(result.repositories, "any-repo"));
    assert.ok(matchesFilterPatterns(result.authors, "anyone"));
    assert.equal(result.minDiffSize, 0);
    assert.equal(result.maxDiffSize, 2000);
  }
});

test("normalizeAutoReview: a pattern list replaces its default entirely", () => {
  const result = normalizeAutoReview({ branches: ["Release/*", "  main "] });
  assert.ok(matchesFilterPatterns(result.branches, "release/1.2"));
  assert.ok(matchesFilterPatterns(result.branches, "main"));
  assert.equal(matchesFilterPatterns(result.branches, "develop"), false);
});

test("normalizeAutoReview: negative patterns exclude", () => {
  const result = normalizeAutoReview({
    repositories: ["**", "!legacy-monolith"],
    authors: ["**", "!*-service-account"],
  });
  assert.ok(matchesFilterPatterns(result.repositories, "normal-repo"));
  assert.equal(matchesFilterPatterns(result.repositories, "Legacy-Monolith"), false);
  assert.ok(matchesFilterPatterns(result.authors, "david"));
  assert.equal(matchesFilterPatterns(result.authors, "deploy-service-account"), false);
});

test("normalizeAutoReview: empty/invalid pattern lists fall back to defaults", () => {
  for (const bad of [[], ["", 42, null], "main"]) {
    const result = normalizeAutoReview({ branches: bad, repositories: bad, authors: bad });
    assert.ok(matchesFilterPatterns(result.branches, "main"), `branches for ${JSON.stringify(bad)}`);
    assert.equal(matchesFilterPatterns(result.branches, "feature/x"), false);
    assert.ok(matchesFilterPatterns(result.repositories, "any-repo"), `repos for ${JSON.stringify(bad)}`);
    assert.ok(matchesFilterPatterns(result.authors, "anyone"), `authors for ${JSON.stringify(bad)}`);
  }
});

test("normalizeAutoReview: enabled:false is the kill switch", () => {
  assert.equal(normalizeAutoReview({ enabled: false }).enabled, false);
  assert.equal(normalizeAutoReview({ enabled: true }).enabled, true);
});

test("normalizeAutoReview: pattern entries are trimmed and junk is dropped", () => {
  const result = normalizeAutoReview({
    repositories: ["  My-Repo ", "", 42, null],
  });
  assert.ok(matchesFilterPatterns(result.repositories, "my-repo"));
  assert.equal(matchesFilterPatterns(result.repositories, "other-repo"), false);
});

test("normalizeAutoReview: diff bounds accept valid numbers, including 0", () => {
  const result = normalizeAutoReview({ min_diff_size: 5, max_diff_size: 100 });
  assert.equal(result.minDiffSize, 5);
  assert.equal(result.maxDiffSize, 100);
  assert.equal(normalizeAutoReview({ max_diff_size: 0 }).maxDiffSize, 0);
});

test("normalizeAutoReview: invalid diff bounds fall back to defaults", () => {
  for (const bad of ["500", -1, NaN, Infinity, {}, []]) {
    const result = normalizeAutoReview({ min_diff_size: bad, max_diff_size: bad });
    assert.equal(result.minDiffSize, 0, `min for ${String(bad)}`);
    assert.equal(result.maxDiffSize, 2000, `max for ${String(bad)}`);
  }
});

test("loadAiReviewConfig: exposes normalized autoReview settings", async () => {
  const ctx = makeContext({
    configValue: {
      providers: ["claude"],
      auto_review: { enabled: false, repositories: ["**", "!Legacy-Repo"] },
    },
  });
  const config = await loadAiReviewConfig(ctx);
  assert.equal(config.autoReview.enabled, false);
  assert.ok(matchesFilterPatterns(config.autoReview.repositories, "some-repo"));
  assert.equal(matchesFilterPatterns(config.autoReview.repositories, "legacy-repo"), false);
});

test("loadAiReviewConfig: autoReview defaults apply when the key is absent", async () => {
  const ctx = makeContext({ configValue: { providers: ["claude"] } });
  const config = await loadAiReviewConfig(ctx);
  assert.equal(config.autoReview.enabled, true);
  assert.equal(config.autoReview.maxDiffSize, 2000);
});
