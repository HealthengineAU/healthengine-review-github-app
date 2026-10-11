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
const ownerName = (handle) => {
  const [name, team] = handle.replace(/^@/, "").split("/");
  return team ? titleCase(team) : name;
};
export const ownerNames = (entries) => entries.map((entry) => entry.map(ownerName).join("/")).join(", ");

function teamMembership(octokit, org) {
  const teams = new Map();
  return async (reviewer, login) => {
    if (reviewer.login) return reviewer.login.toLowerCase() === login;
    if (!teams.has(reviewer.team)) {
      teams.set(
        reviewer.team,
        octokit
          .paginate(octokit.rest.teams.listMembersInOrg, { org, team_slug: reviewer.team, per_page: 100 })
          .then((members) => new Set(members.map((m) => m.login.toLowerCase()))),
      );
    }
    return (await teams.get(reviewer.team)).has(login);
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
    const ok = await some(reviewers, (r) => some(approvedBy, (login) => isIn(r, login)));
    (ok ? approved : pending).push({ entry, reviewers });
  }

  const asked = requested(timeline);
  const invites = pr.draft ? [] : pending.flatMap(({ reviewers }) => reviewers).filter((r) => !asked.has(r.key));
  if (invites.length > 0) {
    await octokit.rest.pulls.requestReviewers({
      owner,
      repo,
      pull_number,
      reviewers: invites.flatMap((r) => (r.login ? [r.login] : [])),
      team_reviewers: invites.flatMap((r) => (r.team ? [r.team] : [])),
    });
  }

  return { pending: pending.map((p) => p.entry), approved: approved.map((a) => a.entry), commentUrl: tagged[0].html_url };
}
