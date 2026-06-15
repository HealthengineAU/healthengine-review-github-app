// Loads the `.github-bot-ai-reviewed-prs.yml` provider configuration for a repository.
//
// Resolution (handled by Probot's context.config / octokit-plugin-config):
//   1. .github/.github-bot-ai-reviewed-prs.yml in the PR's repo (default branch only)
//   2. else the org's `.github` repo
//   3. else DEFAULT_CONFIG below
// Config files may also use `_extends` to inherit from another repo.

const CONFIG_FILE = ".github-bot-ai-reviewed-prs.yml";

// Single source of truth for the providers we know about. Provider values MUST
// be matching substrings of github.login.toLowerCase() (see ai-review-commit-status.js).
export const KNOWN_PROVIDERS = [
  "augment",
  "claude",
  "copilot",
  "greptile",
  "linearb",
];

// No config anywhere → every provider is enabled (preserves prior behavior).
const DEFAULT_CONFIG = { providers: KNOWN_PROVIDERS };

const KNOWN_PROVIDER_SET = new Set(KNOWN_PROVIDERS);

// Normalize a raw `providers` value into a clean Set of known providers, or
// null if the value is unusable (so the caller can fall back to the default).
function normalizeProviders(raw) {
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

export async function loadAiReviewConfig(context) {
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

  return {
    providers,
    isProviderEnabled(provider) {
      return providers.has(provider);
    },
  };
}
