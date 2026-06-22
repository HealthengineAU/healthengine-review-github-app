// Lets an authorized admin force-merge a pull request by commenting exactly
// `admin merge`.
//
// The set of people allowed to trigger this lives entirely in
// `.github/healthengine-review.yml` (`merge_admins`).
import { ProbotOctokit } from "probot";
import { loadAiReviewConfig } from "./config.js";

const MERGE_COMMAND = "admin merge";

function isBotUser(user) {
  return user?.type === "Bot" || user?.login?.endsWith("[bot]");
}

function normalizeCommand(body) {
  if (typeof body !== "string") return "";
  return body
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim()
    .toLowerCase();
}

let mergebotOctokit = null;

function getMergebotOctokit() {
  if (mergebotOctokit) return mergebotOctokit;

  const token = process.env.MERGEBOT_GITHUB_TOKEN;
  if (!token) {
    throw new Error("MERGEBOT_GITHUB_TOKEN is not set");
  }

  mergebotOctokit = new ProbotOctokit({ auth: { token } });
  return mergebotOctokit;
}

export function register(app) {
  app.on(["issue_comment.created"], async (context) => {
    const { issue, comment } = context.payload;

    // Pull requests only, and never react to bots (including ourselves).
    if (!issue.pull_request) return;
    if (isBotUser(comment.user)) return;

    if (normalizeCommand(comment.body) !== MERGE_COMMAND) return;

    const { owner, repo } = context.repo();
    const issue_number = issue.number;

    const config = await loadAiReviewConfig(context);

    // Only the logins configured in healthengine-review.yml may force a merge.
    if (!config.isMergeAdmin(comment.user.login)) {
      await context.octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: comment.id,
        content: "-1",
      });
      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number,
        body: `@${comment.user.login} you're not authorized to use \`admin merge\`. Authorized users are listed under \`merge_admins\` in [healthengine-review.yml](https://github.com/${owner}/.github/blob/main/.github/healthengine-review.yml).`,
      });
      return;
    }

    let mergebot;
    try {
      mergebot = getMergebotOctokit();
    } catch (err) {
      console.error("[mergebot] not configured", err);
      await context.octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: comment.id,
        content: "confused",
      });
      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number,
        body: "⚠️ `admin merge` is not configured (no `MERGEBOT_GITHUB_TOKEN`)",
      });
      return;
    }

    // Acknowledge the command before attempting the (slower) merge.
    await context.octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: comment.id,
      content: "+1",
    });

    try {
      // The bypass lives with the token's user, so a plain squash merge is all
      // that's needed to skip required/failing checks.
      await mergebot.rest.pulls.merge({
        owner,
        repo,
        pull_number: issue_number,
        merge_method: "squash",
      });

      await context.octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: comment.id,
        content: "rocket",
      });
    } catch (err) {
      console.error(`[mergebot] merge failed for ${owner}/${repo}#${issue_number}`, err);
      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number,
        body: `⚠️ Admin merge failed: ${err.message}`,
      });
    }
  });
}
