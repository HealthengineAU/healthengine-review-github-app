// Code owners of the stories found-pixel saw change (`<!-- ui-owners @org/team @org/a,@org/b -->`, any one owner of an
// entry approving for it), outside the PR author's own teams.

const HANDLE = String.raw`@[\w.-]+(?:\/[\w.-]+)?`;
const OWNERS_TAG = new RegExp(String.raw`<!-- ui-owners((?:\s+${HANDLE}(?:,${HANDLE})*)*)\s*-->`, "g");

export function parseOwners(bodies) {
  let tagged = false;
  const entries = new Map();
  for (const body of bodies) {
    for (const [, list] of (body ?? "").matchAll(OWNERS_TAG)) {
      tagged = true;
      for (const entry of list.trim().split(/\s+/).filter(Boolean)) entries.set(entry.toLowerCase(), entry.split(","));
    }
  }
  return tagged ? [...entries.values()] : null;
}

export function toReviewer(handle, org) {
  const [name, team] = handle.replace(/^@/, "").split("/");
  if (team) return name.toLowerCase() === org.toLowerCase() ? { key: `team:${team.toLowerCase()}`, team } : null;
  return { key: `user:${name.toLowerCase()}`, login: name };
}

export function requested(timeline) {
  const keys = new Set();
  for (const event of timeline) {
    if (event.event !== "review_requested") continue;
    if (event.requested_team?.slug) keys.add(`team:${event.requested_team.slug.toLowerCase()}`);
    if (event.requested_reviewer?.login) keys.add(`user:${event.requested_reviewer.login.toLowerCase()}`);
  }
  return keys;
}

// Approvals dismissed since still count.
export function approvers(reviews, timeline) {
  const dismissed = new Set(
    timeline
      .filter((e) => e.event === "review_dismissed" && e.dismissed_review?.state?.toLowerCase() === "approved")
      .map((e) => e.dismissed_review.review_id),
  );
  return new Set(
    reviews
      .filter((r) => r.state === "APPROVED" || dismissed.has(r.id))
      .flatMap((r) => (r.user?.login ? [r.user.login.toLowerCase()] : [])),
  );
}

const titleCase = (slug) => slug.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
export const ownerName = (handle) => {
  const [name, team] = handle.replace(/^@/, "").split("/");
  return team ? titleCase(team) : name;
};
const sameHandle = (a, b) => a.toLowerCase() === b.toLowerCase();
export const implied = (entry, entries) =>
  entries.some((other) => other.length < entry.length && other.every((h) => entry.some((e) => sameHandle(e, h))));
export const ownerNames = (entries) =>
  entries
    .filter((entry) => !implied(entry, entries))
    .map((entry) => entry.map(ownerName).join("/"))
    .join(", ");

// Team rosters rarely change, so skip refetching them on every UI Review status.
const TEAM_CACHE_TTL_MS = 15 * 60_000;
const teamCache = new Map();

function teamMembers(octokit, org, team) {
  const key = `${org}/${team}`.toLowerCase();
  const now = Date.now();
  const cached = teamCache.get(key);
  if (cached && cached.expires > now) return cached.members;

  const members = octokit
    .paginate(octokit.rest.teams.listMembersInOrg, { org, team_slug: team, per_page: 100 })
    .then((list) => new Set(list.map((m) => m.login.toLowerCase())));
  const entry = { expires: now + TEAM_CACHE_TTL_MS, members };
  teamCache.set(key, entry);
  members.catch(() => {
    if (teamCache.get(key) === entry) teamCache.delete(key);
  });
  return members;
}

function teamMembership(octokit, org) {
  return async (reviewer, login) => {
    if (reviewer.login) return reviewer.login.toLowerCase() === login;
    return (await teamMembers(octokit, org, reviewer.team)).has(login);
  };
}

async function some(items, predicate) {
  for (const item of items) if (await predicate(item)) return true;
  return false;
}

/**
 * Which owner entries still need a PR approval and which have one, or null when found-pixel isn't asking.
 * Invites the outstanding owners never asked before, once the PR isn't a draft.
 */
export async function checkCodeowners(octokit, { owner, repo, pr, comments }) {
  const tagged = comments.filter((c) => parseOwners([c.body]));
  const entries = parseOwners(tagged.map((c) => c.body));
  if (!entries) return null;

  const pull_number = pr.number;
  const [timeline, reviews] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listEventsForTimeline, { owner, repo, issue_number: pull_number, per_page: 100 }),
    octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number, per_page: 100 }),
  ]);
  const approvedBy = [...approvers(reviews, timeline)];
  const author = (pr.user?.login ?? "").toLowerCase();
  const isIn = teamMembership(octokit, owner);

  const pending = [];
  const approved = [];
  for (const entry of entries) {
    const reviewers = entry.map((handle) => toReviewer(handle, owner)).filter(Boolean);
    if (reviewers.length === 0 || (await some(reviewers, (r) => isIn(r, author)))) continue;
    let by = null;
    for (const login of approvedBy) if (!by && (await some(reviewers, (r) => isIn(r, login)))) by = login;
    (by ? approved : pending).push({ entry, reviewers, by });
  }

  const asked = requested(timeline);
  const invites = pr.draft ? [] : pending.flatMap(({ reviewers }) => reviewers).filter((r) => !asked.has(r.key));
  if (invites.length > 0) {
    try {
      await octokit.rest.pulls.requestReviewers({
        owner,
        repo,
        pull_number,
        reviewers: invites.flatMap((r) => (r.login ? [r.login] : [])),
        team_reviewers: invites.flatMap((r) => (r.team ? [r.team] : [])),
      });
    } catch (err) {
      console.error(`Code owner invite failed for ${owner}/${repo}#${pull_number}`, err.status ?? err.message);
    }
  }

  return {
    pending: pending.map((p) => p.entry),
    approved: approved.map((a) => a.entry),
    rows: [...pending, ...approved].map(({ entry, by }) => ({ entry, by })),
  };
}
