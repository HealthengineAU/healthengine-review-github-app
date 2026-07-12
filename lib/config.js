// Loads the .github provider configuration for a repository.
//
// Resolution (handled by Probot's context.config / octokit-plugin-config):
//   1. .github/healthengine-review.yml in the PR's repo (default branch only)
//   2. else the org's `.github` repo
//   3. else DEFAULT_CONFIG below
// Config files may also use `_extends` to inherit from another repo.

import { BOT } from "./ai-reviewers.js";

const CONFIG_FILE = "healthengine-review.yml";

// The providers we know about, from the shared reviewer identity module.
export const KNOWN_PROVIDERS = Object.values(BOT);

// No config anywhere → every provider is enabled (preserves prior behavior).
const DEFAULT_CONFIG = { providers: KNOWN_PROVIDERS };

const KNOWN_PROVIDER_SET = new Set(KNOWN_PROVIDERS);

// Automatic review invites (auto-trigger-ai-review.js): on by default, no
// exclusions, and only PRs up to 2000 changed lines.
const AUTO_REVIEW_DEFAULTS = {
  minDiffSize: 0,
  maxDiffSize: 2000,
};

// Cache resolved configs per repo for X minutes
const CACHE_TTL_MS = 8 * 60_000;
const configCache = new Map();

// Normalize a raw `providers` value into a clean Set of known providers, or
// null if the value is unusable (so the caller can fall back to the default).
export function normalizeProviders(raw) {
  if (!Array.isArray(raw)) return null;

  const providers = new Set();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const provider = entry.trim().toLowerCase();
    if (!provider) continue;
    if (!KNOWN_PROVIDER_SET.has(provider)) {
      console.warn(`[ai-reviews config] Ignoring unknown provider "${entry}"`);
      continue;
    }
    providers.add(provider);
  }

  return providers.size > 0 ? providers : null;
}

// Normalize a raw `auto_review` value into the settings the automatic trigger
// consumes. Unusable entries fall back to the defaults above.
export function normalizeAutoReview(raw) {
  const toNameSet = (value) => {
    const items = Array.isArray(value) ? value : [];
    return new Set(
      items
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    );
  };

  const toSize = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : fallback;

  return {
    enabled: raw?.enabled !== false,
    excludeRepos: toNameSet(raw?.exclude_repos),
    excludeAuthors: toNameSet(raw?.exclude_authors),
    minDiffSize: toSize(raw?.min_diff_size, AUTO_REVIEW_DEFAULTS.minDiffSize),
    maxDiffSize: toSize(raw?.max_diff_size, AUTO_REVIEW_DEFAULTS.maxDiffSize),
  };
}

export async function loadAiReviewConfig(context) {
  const { owner, repo } = context.repo();
  const cacheKey = `${owner}/${repo}`;

  const cached = configCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.config;
  }

  let raw;
  try {
    // Don't pass DEFAULT_CONFIG here: Probot merges defaults via deepmerge,
    // which concatenates arrays — so the default provider list would merge back
    // into a user's config and re-enable providers they disabled. We apply the
    // default ourselves below (normalizeProviders fallback) only when no config
    // file is found anywhere.
    raw = await context.config(CONFIG_FILE);
  } catch (err) {
    console.error(`[config] Failed to load ${CONFIG_FILE}`, err);
    raw = DEFAULT_CONFIG;
  }

  const providers =
    normalizeProviders(raw?.providers) ?? new Set(DEFAULT_CONFIG.providers);

  const config = {
    providers,
    autoReview: normalizeAutoReview(raw?.auto_review),
    isProviderEnabled(provider) {
      return providers.has(provider);
    },
  };

  configCache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, config });

  return config;
}
