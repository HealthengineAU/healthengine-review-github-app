// Checkbox approval of the `UI Review` statuses found-pixel posts; the app adds an
// "Approve Changes" checkbox to its PR comment, and ticking it approves that fingerprint.

const STATUS_CONTEXT = /^UI Review( \(.+\))?$/;
const FINGERPRINT_TAG = /<!-- ui-review fp=([0-9a-f]+) -->/;
const CHECKBOX = /^> - \[([ xX])\] ((?:\*\*Approve Changes\*\*|~Approve Changes~).*)$/m;
const PROMPT_LINE = "> - [ ] **Approve Changes** - ✅ Check this box to confirm these changes";
const approvedLine = (by) => `> - [x] ~Approve Changes~ - Approved by @${by}`;
const STAMP = /<!-- ui-approved\b([^>]*)-->/;
const PENDING_PREFIX = "Approval needed";
const APPROVED = /^✓ Reviewed by .*? - /;
const OWN_PREFIX = new RegExp(`^(?:${PENDING_PREFIX}|✓ Reviewed by .*?) - `);
const DESCRIPTION_LIMIT = 140;

export const isUiReviewStatus = (statusContext) => STATUS_CONTEXT.test(statusContext ?? "");

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

export const baseDescription = (description) => (description ?? "").replace(OWN_PREFIX, "");

const clip = (text) => (text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 1)}…` : text);
export const pendingDescription = (description) => clip(`${PENDING_PREFIX} - ${baseDescription(description)}`);
export const approvedDescription = (name, description) => clip(`✓ Reviewed by ${name} - ${baseDescription(description)}`);

// The latest status per context, and the latest one the tool posted (its URL carries the fingerprint).
async function uiReviewStatuses(octokit, owner, repo, sha) {
  const all = await octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, { owner, repo, ref: sha, per_page: 100 });
  const byContext = new Map();
  for (const status of all) {
    if (!isUiReviewStatus(status.context)) continue;
    const entry = byContext.get(status.context) ?? { latest: status, tool: null };
    if (!entry.tool && !OWN_PREFIX.test(status.description ?? "")) entry.tool = status;
    byContext.set(status.context, entry);
  }
  return [...byContext.values()];
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

function postStatus(octokit, owner, repo, { sha, context }, { state, description, target_url }) {
  return octokit.rest.repos.createCommitStatus({ owner, repo, sha, context, state, description, target_url });
}

export function register(app) {
  app.on("status", async (context) => {
    const { sha, state, context: statusContext, description, target_url, repository } = context.payload;
    if (state !== "pending" || !isUiReviewStatus(statusContext) || OWN_PREFIX.test(description ?? "")) return;
    const fp = fingerprintOf(target_url);
    if (!fp) return;

    const octokit = context.octokit;
    const { owner } = context.repo();
    const repo = repository.name;
    const { data: prs } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: sha });
    const pr = (prs ?? []).find((p) => p.state === "open" && p.head?.sha === sha);
    if (!pr) return;

    const latest = (await uiReviewStatuses(octokit, owner, repo, sha)).find((s) => s.latest.context === statusContext)?.latest;
    if (!latest || latest.state !== state || latest.target_url !== target_url || latest.description !== description) return;

    const comment = (await toolComments(octokit, owner, repo, pr.number)).find((c) => commentFingerprint(c.body) === fp);
    const approval = comment && approvalOf(comment.body);
    if (comment) {
      const body = approval ? approve(comment.body, approval) : prompt(comment.body);
      if (body !== comment.body) await octokit.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body });
    }
    await postStatus(octokit, owner, repo, { sha, context: statusContext }, approval
      ? { state: "success", description: approvedDescription(approval.name, description), target_url }
      : { state: "pending", description: pendingDescription(description), target_url: comment?.html_url ?? target_url });
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

    const sha = pr.head.sha;
    const statuses = (await uiReviewStatuses(octokit, owner, repo, sha)).filter((s) => s.tool && fingerprintOf(s.tool.target_url) === now.fp);
    if (now.ticked) {
      const by = sender.login;
      const name = safeName(await displayName(octokit, by));
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body: approve(current.body, { fp: now.fp, by, name }) });
      for (const { latest, tool } of statuses.filter((s) => s.latest.state === "pending")) {
        await postStatus(octokit, owner, repo, { sha, context: latest.context }, {
          state: "success", description: approvedDescription(name, latest.description), target_url: tool.target_url,
        });
      }
      return;
    }

    const reverted = unapprove(current.body);
    if (reverted !== current.body) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body: reverted });
    }
    for (const { latest } of statuses.filter((s) => s.latest.state === "success" && APPROVED.test(s.latest.description ?? ""))) {
      await postStatus(octokit, owner, repo, { sha, context: latest.context }, {
        state: "pending", description: pendingDescription(latest.description), target_url: comment.html_url,
      });
    }
  });
}
