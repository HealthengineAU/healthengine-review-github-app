// Logs remaining GitHub API quota; Probot already warns when a limit is hit.

const LOG_INTERVAL_MS = 5 * 60_000;
const LOW_QUOTA_LOG_INTERVAL_MS = 60_000;
const LOW_QUOTA_RATIO = 0.2;

const lastLoggedAt = new Map();
const hooked = new WeakSet();

export function logRateLimit(headers = {}, now = Date.now()) {
  const remaining = Number(headers["x-ratelimit-remaining"]);
  const limit = Number(headers["x-ratelimit-limit"]);
  if (!Number.isFinite(remaining) || !(limit > 0)) return;

  const resource = headers["x-ratelimit-resource"] ?? "core";
  const low = remaining / limit < LOW_QUOTA_RATIO;
  const interval = low ? LOW_QUOTA_LOG_INTERVAL_MS : LOG_INTERVAL_MS;
  if (now - (lastLoggedAt.get(resource) ?? -Infinity) < interval) return;

  lastLoggedAt.set(resource, now);
  (low ? console.warn : console.info)(`[rate-limit] ${resource}: ${remaining}/${limit} remaining`);
}

// Each webhook gets a fresh octokit shared by all its handlers, so hook it once on first use.
export function withRateLimitLog(app) {
  const wrapped = Object.create(app);
  wrapped.on = (events, handler) =>
    app.on(events, (context) => {
      const octokit = context?.octokit;
      if (octokit?.hook && !hooked.has(octokit)) {
        hooked.add(octokit);
        octokit.hook.after("request", (response) => logRateLimit(response?.headers));
      }
      return handler(context);
    });
  return wrapped;
}
