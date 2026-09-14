// Forwards pull-request activity to autonomous "agent" proxies. An agent runs
// somewhere else (its own repo/workflow) and opens PRs under its own bot
// identity; this module notices activity that agent cares about — reviews and
// comments on its PRs, @-mentions anywhere, settled checks on its PRs — and
// pokes it via a workflow_dispatch so it can respond. Comments that wake an
// agent — including on issues in its own repo, which it watches itself — are
// answered with a reaction, since the app can react in seconds where a runner
// takes minutes.
//
// The app knows nothing about any specific agent. Every identity, trigger, and
// dispatch target comes from the `agents` block in .github/healthengine-review.yml
// (see config.js and normalizeAgents). With no agents configured, nothing here
// fires — the feature is dormant.

import { markQueued, wakeAgent } from "./agent-dispatch.js";
import { isBotUser } from "./ai-reviewers.js";
import { loadAiReviewConfig } from "./config.js";

const lc = (value) => (value ?? "").toLowerCase();

// --- Pure classifiers (no IO) — the routing rules, tested directly. ---------

// A formal review on the agent's own PR, from anyone but the agent itself.
// Humans AND bots count (AI reviewers are exactly the feedback worth acting
// on); approvals carry nothing to address.
export function classifyReview(agent, { prAuthor, reviewAuthor, state }) {
  if (!agent.events.has("review")) return null;
  if (lc(prAuthor) !== agent.botLower) return null;
  if (lc(reviewAuthor) === agent.botLower) return null;
  if (state === "approved") return null;
  return "review";
}

// A PR comment. On the agent's own PR it's feedback ("comment"); anywhere else
// it only counts if it @-mentions the agent ("mention"). Humans only — bots
// post screenshots and other no-op noise, and `ignore_users` covers service
// accounts that look like humans.
export function classifyComment(agent, { prAuthor, commentAuthor, isBot, body }) {
  if (isBot) return null;
  const author = lc(commentAuthor);
  if (author === agent.botLower) return null;
  if (agent.ignoreUsers.has(author)) return null;
  if (lc(prAuthor) === agent.botLower && agent.events.has("comment")) return "comment";
  if (agent.events.has("mention") && agent.mention?.test(body ?? "")) return "mention";
  return null;
}

// A settled commit status whose context the agent watches (e.g. buildkite/*).
// Only failure/error: pending has no outcome yet, and a green build is not work
// The PR-ownership check happens in the handler, once the PR is resolved.
export function classifyStatus(agent, { state, context }) {
  if (!agent.events.has("check")) return null;
  if (state !== "failure" && state !== "error") return null; // skip success/pending
  if (!agent.checks?.test(context ?? "")) return null;
  return "check";
}

// A human comment on an issue in the agent's OWN repo. Nothing to forward — the
// agent's workflows wake on those issue events directly (its sessions live
// there) — but it is still worth acknowledging. Closed issues wake nothing.
export function classifyOwnIssueComment(agent, { owner, repo, issueState, commentAuthor, isBot }) {
  if (isBot) return null;
  if (!agent.events.has("comment")) return null;
  if (lc(owner) !== lc(agent.dispatch.owner)) return null;
  if (lc(repo) !== lc(agent.dispatch.repo)) return null;
  if (issueState !== "open") return null;
  const author = lc(commentAuthor);
  if (author === agent.botLower) return null;
  if (agent.ignoreUsers.has(author)) return null;
  return "ack";
}

// --- Handlers ---------------------------------------------------------------

export function register(app) {
  // .edited included because some reviewers (Copilot Lite) deliver their review
  // body via an edit and never emit submitted; scheduleDispatch coalesces both.
  app.on(["pull_request_review.submitted", "pull_request_review.edited"], async (context) => {
    const { agents } = await loadAiReviewConfig(context);
    if (!agents.length) return;
    const { pull_request: pr, review, repository } = context.payload;
    for (const agent of agents) {
      const kind = classifyReview(agent, {
        prAuthor: pr.user?.login,
        reviewAuthor: review.user?.login,
        state: review.state,
      });
      if (!kind) continue;
      wakeAgent(context.octokit, agent, {
        event: kind, owner: context.repo().owner, repo: repository.name, pr: pr.number,
        actor: review.user?.login, body: review.body,
      });
    }
  });

  app.on("issue_comment.created", async (context) => {
    const { agents } = await loadAiReviewConfig(context);
    if (!agents.length) return;
    const { issue, comment, repository } = context.payload;
    const { owner } = context.repo();
    const isBot = isBotUser(comment.user);

    // Not a pull request: nothing to forward, but a comment on an issue in an
    // agent's own repo has already woken it, so acknowledge it. One reaction,
    // however many agents claim the repo — and straight to 👍, since GitHub
    // has already handed the event over.
    if (!issue.pull_request) {
      const woken = agents.some((agent) =>
        classifyOwnIssueComment(agent, {
          owner, repo: repository.name, issueState: issue.state,
          commentAuthor: comment.user?.login, isBot,
        }),
      );
      if (woken) {
        await markQueued(context.octokit, {
          owner, repo: repository.name, commentId: comment.id,
        });
      }
      return;
    }
    for (const agent of agents) {
      const kind = classifyComment(agent, {
        prAuthor: issue.user?.login,
        commentAuthor: comment.user?.login,
        isBot, body: comment.body,
      });
      if (!kind) continue;
      wakeAgent(context.octokit, agent, {
        event: kind, owner, repo: repository.name, pr: issue.number,
        actor: comment.user?.login, body: comment.body, ackComment: comment.id,
      });
    }
  });

  app.on("status", async (context) => {
    const { agents } = await loadAiReviewConfig(context);
    if (!agents.length) return;
    const { state, context: statusContext, sha, repository, sender } = context.payload;
    const watching = agents.filter((agent) =>
      classifyStatus(agent, { state, context: statusContext }),
    );
    if (!watching.length) return;

    const { owner } = context.repo();
    let prs;
    try {
      const res = await context.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner, repo: repository.name, commit_sha: sha,
      });
      prs = res.data ?? [];
    } catch (err) {
      console.error(`[agent-proxies] PR lookup failed for ${repository.name}@${sha}:`, err.status ?? err.message);
      return;
    }

    for (const agent of watching) {
      for (const pr of prs) {
        if (pr.state !== "open") continue;
        if (lc(pr.user?.login) !== agent.botLower) continue;
        wakeAgent(context.octokit, agent, {
          event: "check", owner, repo: repository.name, pr: pr.number,
          actor: sender?.login || "ci", body: `${state}: ${statusContext}`,
        });
      }
    }
  });
}
