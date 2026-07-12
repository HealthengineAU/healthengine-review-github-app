// Loads the .github provider configuration for a repository.
//
// Resolution (handled by Probot's context.config / octokit-plugin-config):
//   1. .github/healthengine-review.yml in the PR's repo (default branch only)
//   2. else the org's `.github` repo
//   3. else DEFAULT_CONFIG below
// Config files may also use `_extends` to inherit from another repo.

import { BOT } from "./ai-reviewers.js";
import { compileFilterPatterns } from "./filter-patterns.js";

const CONFIG_FILE = "healthengine-review.yml";

// The providers we know about, from the shared reviewer identity module.
export const KNOWN_PROVIDERS = Object.values(BOT);

// No config anywhere → every provider is enabled (preserves prior behavior).
const DEFAULT_CONFIG = { providers: KNOWN_PROVIDERS };

const KNOWN_PROVIDER_SET = new Set(KNOWN_PROVIDERS);

// AI review settings (auto-trigger-ai-review.js). Automatic invites are
// OPT-IN: nothing fires unless the config sets `ai_review.automatic: true`.
// When on, they cover every repo and author, skip drafts, only target
// mainline branches, and cap at 2000 changed lines. The filter lists take
// GitHub-Actions-style patterns (see filter-patterns.js), e.g.
// repositories: ["*", "!legacy-monolith"]. Repo names and logins never
// contain "/", so "*" matches them all; branch patterns need "**" to span
// slashes (e.g. ["**", "!test/**"]).
const AI_REVIEW_DEFAULTS = {
  branches: ["master", "main", "develop"],
  repositories: ["*"],
  authors: ["*"],
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

// Normalize a raw `ai_review` value into the settings the automatic trigger
// consumes. Unusable entries fall back to the defaults above.
export function normalizeAiReview(raw) {
  // A missing/empty/invalid pattern list falls back to its default — an empty
  // list can't be expressed (leave `automatic` off instead).
  const toPatterns = (value, fallback) => {
    const items = Array.isArray(value)
      ? value
          .filter((entry) => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    return compileFilterPatterns(items.length > 0 ? items : fallback);
  };

  const toSize = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : fallback;

  return {
    automatic: raw?.automatic === true,
    draft: raw?.draft === true,
    branches: toPatterns(raw?.branches, AI_REVIEW_DEFAULTS.branches),
    repositories: toPatterns(raw?.repositories, AI_REVIEW_DEFAULTS.repositories),
    authors: toPatterns(raw?.authors, AI_REVIEW_DEFAULTS.authors),
    minDiffSize: toSize(raw?.min_diff_size, AI_REVIEW_DEFAULTS.minDiffSize),
    maxDiffSize: toSize(raw?.max_diff_size, AI_REVIEW_DEFAULTS.maxDiffSize),
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
    aiReview: normalizeAiReview(raw?.ai_review),
    isProviderEnabled(provider) {
      return providers.has(provider);
    },
  };

  configCache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, config });

  return config;
}
