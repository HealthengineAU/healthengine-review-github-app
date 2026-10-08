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

// A comment that wakes an agent is answered twice: 👀 the moment it arrives,
// swapped for 👍 once the run is queued. The app reacts in seconds where a
// runner takes minutes to boot, and neither reaction means "done".
const SEEN_REACTION = "eyes";
const QUEUED_REACTION = "+1";

// Decoration only: a missing reaction is never worth failing a wake over, so
// nothing here throws and callers can ignore the result.
async function react(octokit, { owner, repo, commentId, content, reviewComment }) {
  const params = { owner, repo, comment_id: commentId, content };
  try {
    // Review comments are a separate id space; the issue-comment endpoint 404s.
    const { data } = reviewComment
      ? await octokit.rest.reactions.createForPullRequestReviewComment(params)
      : await octokit.rest.reactions.createForIssueComment(params);
    return data?.id ?? null;
  } catch (err) {
    console.error(`[agent-dispatch] ${content} failed for ${owner}/${repo} comment ${commentId}:`, err.status ?? err.message);
    return null;
  }
}

export function markSeen(octokit, { owner, repo, commentId, reviewComment }) {
  if (!commentId) return Promise.resolve(null);
  return react(octokit, { owner, repo, commentId, content: SEEN_REACTION, reviewComment });
}

// 👍 goes up before 👀 comes down, so the comment is never briefly unanswered.
// A failed dispatch leaves the 👀 standing: we did see it, nothing is queued.
export async function markQueued(octokit, { owner, repo, commentId, seenId, reviewComment }) {
  await react(octokit, { owner, repo, commentId, content: QUEUED_REACTION, reviewComment });
  if (!seenId) return;
  const params = { owner, repo, comment_id: commentId, reaction_id: seenId };
  try {
    if (reviewComment) {
      await octokit.rest.reactions.deleteForPullRequestComment(params);
    } else {
      await octokit.rest.reactions.deleteForIssueComment(params);
    }
  } catch {
    // A lingering 👀 is not news.
  }
}

export function wakeAgent(octokit, agent, { event, owner, repo, pr, actor, body, ackComment, ackReviewComment }) {
  const key = `${agent.name}:${repo}#${pr}:${event}`;
  const entry = pending.get(key);
  clearTimeout(entry?.timer);
  // Everyone who spoke during the debounce gets answered, even though the burst
  // wakes the agent once. Each value carries the 👀 to take back down, and which
  // id space it lives in — one burst can mix PR comments and inline review ones.
  const acks = entry?.acks ?? new Map();
  if (ackComment && !acks.has(ackComment)) {
    const reviewComment = Boolean(ackReviewComment);
    acks.set(ackComment, {
      seen: markSeen(octokit, { owner, repo, commentId: ackComment, reviewComment }),
      reviewComment,
    });
  }
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
      .then(() =>
        Promise.all(
          [...acks].map(async ([commentId, { seen, reviewComment }]) =>
            markQueued(octokit, { owner, repo, commentId, seenId: await seen, reviewComment }),
          ),
        ),
      )
      .catch((err) => {
        // Fail soft: a missing workflow or permission must never break review.
        console.error(`[agent-proxies] dispatch failed for ${key}:`, err.status ?? err.message);
      });
  }, agent.debounceMs);
  // Don't let a pending debounce keep the process alive.
  timer.unref?.();
  pending.set(key, { timer, acks });
}
