// Notifies the CODEOWNERS owners of stories found-pixel saw change, when its PR comment asks
// (`<!-- ui-owners notify=<mention|invite> @org/team … -->`) and the PR is ready for review.

const OWNERS_TAG = /<!-- ui-owners notify=(mention|invite)((?:\s+@[\w.-]+(?:\/[\w.-]+)?)*)\s*-->/g;
const NOTIFIED_TAG = /<!-- ui-owners-notified((?:\s+@[\w.-]+(?:\/[\w.-]+)?)*)\s*-->/g;

const handles = (text) => text.trim().split(/\s+/).filter(Boolean);
const unique = (items) => [...new Set(items)];

export function parseOwners(bodies) {
  const owners = { mention: [], invite: [] };
  for (const body of bodies) {
    for (const [, notify, list] of (body ?? "").matchAll(OWNERS_TAG)) owners[notify].push(...handles(list));
  }
  return { mention: unique(owners.mention), invite: unique(owners.invite) };
}

export const parseNotified = (bodies) =>
  unique(bodies.flatMap((body) => [...(body ?? "").matchAll(NOTIFIED_TAG)].flatMap(([, list]) => handles(list))));

const ownersKey = (body) => JSON.stringify(parseOwners([body]));

// Ever requested or reviewed, so a removed request stays removed.
export function involved(timeline) {
  const seen = new Set();
  for (const event of timeline) {
    if (event.event === "review_requested") {
      if (event.requested_team?.slug) seen.add(`team:${event.requested_team.slug.toLowerCase()}`);
      if (event.requested_reviewer?.login) seen.add(`user:${event.requested_reviewer.login.toLowerCase()}`);
    } else if (event.event === "reviewed" && event.user?.login) {
      seen.add(`user:${event.user.login.toLowerCase()}`);
    }
  }
  return seen;
}

export function toReviewer(handle, org) {
  const [name, team] = handle.replace(/^@/, "").split("/");
  if (team) return name.toLowerCase() === org.toLowerCase() ? { key: `team:${team.toLowerCase()}`, team } : null;
  return { key: `user:${name.toLowerCase()}`, login: name };
}

export const renderMention = (owners, commentUrl) =>
  [
    `<!-- ui-owners-notified ${owners.join(" ")} -->`,
    `👀 ${owners.join(" ")} — this PR changes stories you own. See the [UI Review](${commentUrl}).`,
  ].join("\n");

async function notifyOwners(octokit, { owner, repo, pr }) {
  if (pr.state !== "open" || pr.draft) return;

  const issue_number = pr.number;
  const comments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 });
  const bodies = comments.map((c) => c.body ?? "");
  const wanted = parseOwners(bodies);
  if (wanted.mention.length === 0 && wanted.invite.length === 0) return;

  const timeline = await octokit.paginate(octokit.rest.issues.listEventsForTimeline, { owner, repo, issue_number, per_page: 100 });
  const skip = involved(timeline);
  skip.add(`user:${(pr.user?.login ?? "").toLowerCase()}`);
  for (const handle of parseNotified(bodies)) {
    const reviewer = toReviewer(handle, owner);
    if (reviewer) skip.add(reviewer.key);
  }
  const pending = (list) =>
    list.map((handle) => ({ handle, reviewer: toReviewer(handle, owner) })).filter(({ reviewer }) => reviewer && !skip.has(reviewer.key));

  const invites = pending(wanted.invite);
  if (invites.length > 0) {
    await octokit.rest.pulls.requestReviewers({
      owner,
      repo,
      pull_number: issue_number,
      reviewers: invites.flatMap(({ reviewer }) => (reviewer.login ? [reviewer.login] : [])),
      team_reviewers: invites.flatMap(({ reviewer }) => (reviewer.team ? [reviewer.team] : [])),
    });
    for (const { reviewer } of invites) skip.add(reviewer.key);
  }

  const mentions = pending(wanted.mention).map(({ handle }) => handle);
  if (mentions.length > 0) {
    const source = comments.find((c) => parseOwners([c.body]).mention.length > 0);
    await octokit.rest.issues.createComment({ owner, repo, issue_number, body: renderMention(mentions, source.html_url) });
  }
}

export function register(app) {
  app.on(["issue_comment.created", "issue_comment.edited"], async (context) => {
    const { comment, changes, issue } = context.payload;
    if (!issue?.pull_request || ownersKey(comment?.body) === ownersKey(changes?.body?.from ?? "")) return;

    const { owner, repo } = context.repo();
    const { data: pr } = await context.octokit.rest.pulls.get({ owner, repo, pull_number: issue.number });
    await notifyOwners(context.octokit, { owner, repo, pr });
  });

  app.on("pull_request.ready_for_review", async (context) => {
    const { owner, repo } = context.repo();
    await notifyOwners(context.octokit, { owner, repo, pr: context.payload.pull_request });
  });
}
