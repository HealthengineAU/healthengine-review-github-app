// Label-based approval of the `UI Review` statuses found-pixel and visreg-images
// post; the fingerprint in their status URL and PR comment is what gets approved.

import { createHmac } from "node:crypto";

export const APPROVAL_LABELS = ["gorgeous", "magnificent", "splendid", "stunning", "sublime"];
const STATUS_CONTEXT = /^UI Review( \(.+\))?$/;
const FINGERPRINT_TAG = /<!-- ui-review fp=([0-9a-f]+) -->/;
const STAMP = /<!-- ui-approved\b([^>]*)-->/;
const OWN_PREFIX = /^(?:Label as "[a-z]+" to approve|✓ Reviewed by .*?) — /;
const DESCRIPTION_LIMIT = 140;

export const suggestedLabel = (prNumber) => APPROVAL_LABELS[prNumber % APPROVAL_LABELS.length];
export const isApprovalLabel = (name) => APPROVAL_LABELS.includes(name);
export const isUiReviewStatus = (statusContext) => STATUS_CONTEXT.test(statusContext ?? "");

export function fingerprintOf(url) {
  try {
    return new URL(url).searchParams.get("fp");
  } catch {
    return null;
  }
}

export const commentFingerprint = (body) => body?.match(FINGERPRINT_TAG)?.[1] ?? null;

export const signStamp = (commentId, fp) =>
  createHmac("sha256", process.env.WEBHOOK_SECRET ?? "").update(`${commentId}:${fp}`).digest("hex").slice(0, 16);

export function parseStamp(body) {
  const attrs = body?.match(STAMP)?.[1];
  if (attrs === undefined) return null;
  const by = attrs.match(/\bby=(\S+)/)?.[1] ?? "";
  const name = attrs.match(/\bname="([^"]*)"/)?.[1] ?? by;
  const fp = attrs.match(/\bfp=(\S+)/)?.[1] ?? "";
  const sig = attrs.match(/\bsig=(\S+)/)?.[1] ?? "";
  return { by, name, fp, sig };
}

export function validStamp(comment) {
  const stamp = parseStamp(comment.body);
  return stamp && stamp.sig === signStamp(comment.id, stamp.fp) ? stamp : null;
}

const safeName = (name) => name.replace(/[<>"]/g, "").replace(/--/g, "-").trim();

export const renderStamp = ({ by, name, fp, sig }) => `<!-- ui-approved by=${by} name="${safeName(name)}" fp=${fp} sig=${sig} -->`;

export function withStamp(body, stamp) {
  const line = renderStamp(stamp);
  return STAMP.test(body) ? body.replace(STAMP, line) : `${body}\n${line}`;
}

export const withoutStamp = (body) => body.replace(/\n?<!-- ui-approved\b[^>]*-->/, "");

export const baseDescription = (description) => (description ?? "").replace(OWN_PREFIX, "");

const clip = (text) => (text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 1)}…` : text);
export const pendingDescription = (label, description) => clip(`Label as "${label}" to approve — ${baseDescription(description)}`);
export const approvedDescription = (name, description) => clip(`✓ Reviewed by ${name} — ${baseDescription(description)}`);

async function uiReviewStatuses(octokit, owner, repo, sha) {
  const all = await octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, { owner, repo, ref: sha, per_page: 100 });
  const latest = new Map();
  for (const status of all) {
    if (isUiReviewStatus(status.context) && !latest.has(status.context)) latest.set(status.context, status);
  }
  return [...latest.values()];
}

async function toolComments(octokit, owner, repo, issue_number) {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number, per_page: 100,
  });
  return comments.filter((c) => FINGERPRINT_TAG.test(c.body ?? ""));
}

async function displayName(octokit, login) {
  try {
    const { data } = await octokit.rest.users.getByUsername({ username: login });
    return data?.name?.trim() || login;
  } catch {
    return login;
  }
}

function postStatus(octokit, owner, repo, status, { state, description }) {
  return octokit.rest.repos.createCommitStatus({
    owner, repo, sha: status.sha, context: status.context, state, description, target_url: status.target_url,
  });
}

async function clearApproval(octokit, owner, repo, pr, { sha, comments }) {
  for (const label of pr.labels.map((l) => l.name).filter(isApprovalLabel)) {
    await octokit.rest.issues.removeLabel({ owner, repo, issue_number: pr.number, name: label }).catch(() => {});
  }
  for (const comment of comments.filter((c) => STAMP.test(c.body))) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body: withoutStamp(comment.body) });
  }
  const label = suggestedLabel(pr.number);
  for (const status of await uiReviewStatuses(octokit, owner, repo, sha)) {
    if (!/^✓ Reviewed by /.test(status.description ?? "")) continue;
    await postStatus(octokit, owner, repo, { ...status, sha }, {
      state: "pending", description: pendingDescription(label, status.description),
    });
  }
}

export function register(app) {
  app.on("status", async (context) => {
    const { sha, state, context: statusContext, description, target_url, repository } = context.payload;
    if (!isUiReviewStatus(statusContext) || OWN_PREFIX.test(description ?? "")) return;
    const fp = fingerprintOf(target_url);
    if (!fp) return;

    const octokit = context.octokit;
    const { owner } = context.repo();
    const repo = repository.name;
    const { data: prs } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: sha });
    const pr = (prs ?? []).find((p) => p.state === "open" && p.head?.sha === sha);
    if (!pr) return;

    const latest = (await uiReviewStatuses(octokit, owner, repo, sha)).find((s) => s.context === statusContext);
    if (!latest || latest.state !== state || latest.target_url !== target_url || latest.description !== description) return;

    const status = { sha, context: statusContext, description, target_url };
    const labelled = pr.labels.some((l) => isApprovalLabel(l.name));
    if (!labelled) {
      if (state !== "pending") return;
      await postStatus(octokit, owner, repo, status, {
        state: "pending", description: pendingDescription(suggestedLabel(pr.number), description),
      });
      return;
    }

    const comments = await toolComments(octokit, owner, repo, pr.number);
    const approval = comments.map(validStamp).find((s) => s?.fp === fp);
    if (!approval) {
      await clearApproval(octokit, owner, repo, pr, { sha, comments });
      if (state === "pending") {
        await postStatus(octokit, owner, repo, status, {
          state: "pending", description: pendingDescription(suggestedLabel(pr.number), description),
        });
      }
      return;
    }
    if (state !== "pending") return;
    await postStatus(octokit, owner, repo, status, {
      state: "success", description: approvedDescription(approval.name, description),
    });
  });

  app.on("pull_request.labeled", async (context) => {
    const { label, sender } = context.payload;
    if (!isApprovalLabel(label?.name)) return;

    const octokit = context.octokit;
    const { owner, repo } = context.repo();
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: context.payload.pull_request.number });
    if (pr.state !== "open" || !pr.labels.some((l) => l.name === label.name)) return;

    const sha = pr.head.sha;
    const comments = await toolComments(octokit, owner, repo, pr.number);
    if (comments.length === 0) return;

    const by = sender.login;
    const name = safeName(await displayName(octokit, by));
    const approved = new Set();
    for (const comment of comments) {
      const fp = commentFingerprint(comment.body);
      approved.add(fp);
      await octokit.rest.issues.updateComment({
        owner, repo, comment_id: comment.id, body: withStamp(comment.body, { by, name, fp, sig: signStamp(comment.id, fp) }),
      });
    }

    for (const status of await uiReviewStatuses(octokit, owner, repo, sha)) {
      if (status.state !== "pending" || !approved.has(fingerprintOf(status.target_url))) continue;
      await postStatus(octokit, owner, repo, { ...status, sha }, {
        state: "success", description: approvedDescription(name, status.description),
      });
    }
  });

  app.on("pull_request.unlabeled", async (context) => {
    const { label, pull_request: pr, sender } = context.payload;
    if (!isApprovalLabel(label?.name) || sender?.type === "Bot") return;
    if (pr.labels.some((l) => isApprovalLabel(l.name))) return;

    const octokit = context.octokit;
    const { owner, repo } = context.repo();
    const comments = await toolComments(octokit, owner, repo, pr.number);
    await clearApproval(octokit, owner, repo, pr, { sha: pr.head.sha, comments });
  });
}
