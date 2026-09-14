// Poking an agent proxy: the one place that turns "something happened that
// agent cares about" into a workflow_dispatch on the target it configures.
//
// Shared by agent-proxies.js (activity the app observes) and ai-reviewers.js
// (a review the app summons on someone's behalf).

// Longest a forwarded comment/review body is allowed to be. GitHub caps
// workflow_dispatch inputs at 65,535 characters total; leave headroom for the
// other inputs.
const MAX_BODY = 60000;

// Coalesce a burst of events on the same (agent, repo, pr, kind) into a single
// dispatch: a reviewer leaving five line comments, or CI re-reporting a status,
// should wake the agent once. Module-level so it survives across deliveries.
const pending = new Map();

export function wakeAgent(octokit, agent, { event, repo, pr, actor, body }) {
  const key = `${agent.name}:${repo}#${pr}:${event}`;
  clearTimeout(pending.get(key));
  const timer = setTimeout(() => {
    pending.delete(key);
    octokit.rest.actions
      .createWorkflowDispatch({
        owner: agent.dispatch.owner,
        repo: agent.dispatch.repo,
        workflow_id: agent.dispatch.workflow,
        ref: agent.dispatch.ref,
        inputs: {
          event,
          repo,
          pr: String(pr),
          actor: actor || "system",
          body: (body ?? "").slice(0, MAX_BODY),
        },
      })
      .catch((err) => {
        // Fail soft: a missing workflow or permission must never break review.
        console.error(`[agent-proxies] dispatch failed for ${key}:`, err.status ?? err.message);
      });
  }, agent.debounceMs);
  // Don't let a pending debounce keep the process alive.
  timer.unref?.();
  pending.set(key, timer);
}
