// The `UI Review` statuses found-pixel posts, held pending until their changes are reviewed: by ticking the
// "Changes Reviewed" checkbox the app adds to its PR comment (approving that fingerprint), and, with found-pixel's
// `codeowners` on, by a PR approval from each code owner of the changed stories.

import { checkCodeowners, ownerNames, parseOwners } from "./ui-review-owners.js";

const STATUS_CONTEXT = /^UI Review( \(.+\))?$/;
const FINGERPRINT_TAG = /<!-- ui-review fp=([0-9a-f]+) -->/;
const CHECKBOX = /^> - \[([ xX])\] ((?:\*\*Changes Reviewed\*\*|~Changes Reviewed~).*)$/m;
const PROMPT_LINE = "> - [ ] **Changes Reviewed** - ✅ Check this box to confirm these changes";
const approvedLine = (by) => `> - [x] ~Changes Reviewed~ - Reviewed by @${by}`;
const STAMP = /<!-- ui-approved\b([^>]*)-->/;
const REVIEW_NEEDED = "Review needed";
const OWN = /^(?:✓ |Needs |Review needed\b)/;
const DESCRIPTION_LIMIT = 140;

export const isUiReviewStatus = (statusContext) => STATUS_CONTEXT.test(statusContext ?? "");
const isOwnStatus = (description) => OWN.test(description ?? "");

export function fingerprintOf(url) {
  try {
    return new URL(url).searchParams.get("fp");
  } catch {
    return null;
  }
}

export const commentFingerprint = (body) => body?.match(FINGERPRINT_TAG)?.[1] ?? null;

export function reviewState(body) {
  const fp = body?.match(FINGERPRINT_TAG)?.[1];
  const [, box, label] = body?.match(CHECKBOX) ?? [];
  return fp && box ? { fp, ticked: box !== " ", label } : null;
}

export function parseStamp(body) {
  const attrs = body?.match(STAMP)?.[1];
  if (attrs === undefined) return null;
  const by = attrs.match(/\bby=(\S+)/)?.[1] ?? "";
  const name = attrs.match(/\bname="([^"]*)"/)?.[1] ?? by;
  const fp = attrs.match(/\bfp=(\S+)/)?.[1] ?? "";
  return { fp, by, name };
}

export function approvalOf(body) {
  const fp = commentFingerprint(body);
  const stamp = parseStamp(body);
  return fp && stamp?.fp === fp ? stamp : null;
}

const safeName = (name) => name.replace(/[<>"]/g, "").replace(/--/g, "-").trim();

export const renderStamp = ({ fp, by, name }) => `<!-- ui-approved fp=${fp} by=${by} name="${safeName(name)}" -->`;

const withCheckbox = (body, line) =>
  CHECKBOX.test(body) ? body.replace(CHECKBOX, line) : body.replace(FINGERPRINT_TAG, (tag) => `${tag}\n> [!Warning]\n${line}\n`);

const withoutStamp = (body) => body.replace(/\n?<!-- ui-approved\b[^>]*-->/, "");

export function approve(body, stamp) {
  const approved = withCheckbox(body, approvedLine(stamp.by));
  const line = renderStamp(stamp);
  return STAMP.test(approved) ? approved.replace(STAMP, () => line) : `${approved}\n${line}`;
}

export const unapprove = (body) => withoutStamp(withCheckbox(body, PROMPT_LINE));

export const prompt = (body) => withoutStamp(CHECKBOX.test(body) ? body : withCheckbox(body, PROMPT_LINE));

const clip = (text) => (text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 1)}…` : text);

export function uiReviewStatus(tool, { review, owners, commentUrl }) {
  const needs = owners?.pending ?? [];
  const approved = owners?.approved ?? [];
  const parts = [
    ...(needs.length > 0 ? [`Needs ${ownerNames(needs)} code owner approval`] : []),
    ...(review ? [review.approval ? `Reviewed by ${review.approval.name}` : REVIEW_NEEDED] : []),
    ...(approved.length > 0 ? [`Approved by ${ownerNames(approved)}`] : []),
  ];
  if (parts.length === 0) return { state: tool.state, description: tool.description, target_url: tool.target_url };
  const pending = needs.length > 0 || (review && !review.approval);
  return {
    state: pending ? "pending" : "success",
    description: clip(`${pending ? "" : "✓ "}${parts.join(", ")} - ${tool.description ?? ""}`),
    target_url: pending ? commentUrl ?? tool.target_url : tool.target_url,
  };
}

// The latest status per context, and the latest one the tool posted (its URL carries the fingerprint).
async function uiReviewStatuses(octokit, owner, repo, sha) {
  const all = await octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, { owner, repo, ref: sha, per_page: 100 });
  const byContext = new Map();
  for (const status of all) {
    if (!isUiReviewStatus(status.context)) continue;
    const entry = byContext.get(status.context) ?? { latest: status, tool: null };
    if (!entry.tool && !isOwnStatus(status.description)) entry.tool = status;
    byContext.set(status.context, entry);
  }
  return [...byContext.values()];
}

function listComments(octokit, owner, repo, issue_number) {
  return octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 });
}

async function displayName(octokit, login) {
  try {
    const { data } = await octokit.rest.users.getByUsername({ username: login });
    return data?.name?.trim() || login;
  } catch {
    return login;
  }
}

async function refresh(octokit, { owner, repo, pr, statuses, comments }) {
  const toolLogins = new Set(statuses.map((s) => s.tool?.creator?.login).filter(Boolean));
  const toolComments = comments.filter((c) => toolLogins.has(c.user?.login));
  const owners = await checkCodeowners(octokit, { owner, repo, pr, comments: toolComments });
  for (const { latest, tool } of statuses) {
    if (!tool || !["pending", "success"].includes(tool.state)) continue;
    const fp = fingerprintOf(tool.target_url);
    const comment = fp ? comments.find((c) => commentFingerprint(c.body) === fp) : undefined;
    const review = tool.state === "pending" && fp ? { approval: comment ? approvalOf(comment.body) : null } : null;
    const next = uiReviewStatus(tool, { review, owners, commentUrl: comment?.html_url ?? owners?.commentUrl });
    if (next.state === latest.state && next.description === latest.description && next.target_url === latest.target_url) continue;
    await octokit.rest.repos.createCommitStatus({ owner, repo, sha: pr.head.sha, context: latest.context, ...next });
  }
}

const replacing = (comments, comment) => [comment, ...comments.filter((c) => c.id !== comment.id)];

export function register(app) {
  app.on("status", async (context) => {
    const { sha, state, context: statusContext, description, target_url, repository } = context.payload;
    if (!isUiReviewStatus(statusContext) || isOwnStatus(description)) return;

    const octokit = context.octokit;
    const { owner } = context.repo();
    const repo = repository.name;
    const { data: prs } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: sha });
    const pr = (prs ?? []).find((p) => p.state === "open" && p.head?.sha === sha);
    if (!pr) return;

    const statuses = (await uiReviewStatuses(octokit, owner, repo, sha)).filter((s) => s.latest.context === statusContext);
    const latest = statuses[0]?.latest;
    if (!latest || latest.state !== state || latest.target_url !== target_url || latest.description !== description) return;

    let comments = await listComments(octokit, owner, repo, pr.number);
    const fp = fingerprintOf(target_url);
    const comment = fp && comments.find((c) => commentFingerprint(c.body) === fp);
    if (state === "pending" && comment) {
      const approval = approvalOf(comment.body);
      const body = approval ? approve(comment.body, approval) : prompt(comment.body);
      if (body !== comment.body) {
        await octokit.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body });
        comments = replacing(comments, { ...comment, body });
      }
    }
    await refresh(octokit, { owner, repo, pr, statuses, comments });
  });

  app.on("issue_comment.edited", async (context) => {
    const { comment, changes, issue, sender } = context.payload;
    const before = reviewState(changes?.body?.from);
    const after = reviewState(comment?.body);
    if (!issue?.pull_request || !before || !after || before.fp !== after.fp || before.label !== after.label || before.ticked === after.ticked) return;

    const octokit = context.octokit;
    const { owner, repo } = context.repo();
    const { data: current } = await octokit.rest.issues.getComment({ owner, repo, comment_id: comment.id });
    const now = reviewState(current.body);
    if (now?.fp !== after.fp || now.label !== after.label || now.ticked !== after.ticked) return;
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: issue.number });
    if (pr.state !== "open") return;

    const body = now.ticked
      ? approve(current.body, { fp: now.fp, by: sender.login, name: safeName(await displayName(octokit, sender.login)) })
      : unapprove(current.body);
    if (body !== current.body) await octokit.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body });

    const statuses = (await uiReviewStatuses(octokit, owner, repo, pr.head.sha)).filter(
      (s) => s.tool && fingerprintOf(s.tool.target_url) === now.fp,
    );
    const comments = replacing(await listComments(octokit, owner, repo, issue.number), { ...current, body });
    await refresh(octokit, { owner, repo, pr, statuses, comments });
  });

  app.on(
    ["pull_request.ready_for_review", "pull_request_review.submitted", "pull_request_review.dismissed"],
    async (context) => {
      const pr = context.payload.pull_request;
      const { owner, repo } = context.repo();
      if (pr.state !== "open") return;
      const comments = await listComments(context.octokit, owner, repo, pr.number);
      if (!parseOwners(comments.map((c) => c.body))) return;
      const statuses = await uiReviewStatuses(context.octokit, owner, repo, pr.head.sha);
      await refresh(context.octokit, { owner, repo, pr, statuses, comments });
    },
  );
}
