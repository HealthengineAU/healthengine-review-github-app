// Strips "Fix [This|All] in Augment" links from augmentcode[bot] comments, and
// minimizes (collapses) PR-summary sections so they don't dominate the timeline.
//
// We only act once the real link is present. The "Generating..." placeholder
// state is left alone — Augment is about to edit the comment to add the link,
// and we'll catch it via the .edited webhook.

const AUGMENT_HOSTS = /(?:public\.augment-assets\.com|augmentcode\.com)/;
const AUGMENT_PR_SUMMARY_MARKER = /<!--\s*augment-pr-summary\s*-->/;

// Matches both "Fix This in Augment" (inline) and "Fix All in Augment" (review summary).
const AUGMENT_IMG_LINK =
  /\[!\[[^\]]*\]\([^)]*(?:public\.augment-assets\.com|augmentcode\.com)[^)]*\)\]\([^)]*augmentcode\.com[^)]*\)/g;

// Trailing "Comment `augment review` to trigger a new review" footer on
// pull_request_review bodies, including the empty <h2></h2> separator above it.
const AUGMENT_REVIEW_FOOTER =
  /\n<h2>\s*<\/h2>\s*\n+Comment `augment review` to trigger a new review at any time\./;

// Trailing "React with 👍/👎/🚀" feedback footer — same <h2></h2> separator,
// then a single-line prompt containing "react with" (wording may drift).
const AUGMENT_REACT_FOOTER =
  /\n<h2>\s*<\/h2>\s*\n+[^\n]*react with[^\n]*/i;

// Drop the `open` attribute so the Augment PR Summary starts collapsed, and
// append "(click to expand)" to the summary line since the section is no
// longer open by default.
const AUGMENT_PR_SUMMARY_DETAILS_OPEN =
  /(<!--\s*augment-pr-summary\s*-->\s*\n)<details open>(\s*<summary>[\s\S]*?)<\/summary>/;

const EXTRA_BLANKS = /\n{3,}/g;

export function cleanAugmentBody(body) {
  if (!body) return body;
  if (
    !AUGMENT_HOSTS.test(body) &&
    !AUGMENT_PR_SUMMARY_MARKER.test(body) &&
    !AUGMENT_REVIEW_FOOTER.test(body) &&
    !AUGMENT_REACT_FOOTER.test(body)
  ) {
    return body;
  }
  return body
    .replace(AUGMENT_IMG_LINK, "")
    .replace(AUGMENT_REVIEW_FOOTER, "")
    .replace(AUGMENT_REACT_FOOTER, "")
    .replace(AUGMENT_PR_SUMMARY_DETAILS_OPEN, "$1<details>\n<summary><b>{•<sup><sup>\"</sup></sup>•} Auggie PR Summary</b> <i>(click to expand)</i></summary>")
    .replace(EXTRA_BLANKS, "\n\n")
    .trimEnd();
}

export function isAugmentAuthored(user, body) {
  if (!user) return false;
  if (typeof user.login === "string" && /augment/i.test(user.login)) return true;
  // Content-based fallback in case the bot login changes.
  if (user.type === "Bot" && body && AUGMENT_HOSTS.test(body)) return true;
  // Any non-augment bot that is reposting the augment summary
  if (user.type === "Bot" && body && AUGMENT_PR_SUMMARY_MARKER.test(body)) return true;
  return false;
}

// Wrap Copilot's "## Pull request overview" section in <details> so it starts
// collapsed. Boundary: from the heading to the end of the body.
const COPILOT_OVERVIEW_HEADING = /^## Pull request overview\s*\n+/m;

export function cleanCopilotBody(body) {
  if (!body) return body;
  const match = body.match(COPILOT_OVERVIEW_HEADING);
  if (!match) return body;
  const before = body.slice(0, match.index);
  const rest = body.slice(match.index + match[0].length).trimEnd();

  // Tiny PR case: Copilot only posts a 1-liner summary
  // e.g. "Copilot reviewed 2 out of 2 changed files in this pull request."
  if (!rest.includes("\n") && !/<br\s*\/?>/i.test(rest)) {
    return `${before}${rest}`;
  }

  // Typical case: Copilot posted a long, detailed review summary
  return `${before}<details>\n<summary><b>:copilot: Copilot PR Summary</b> <i>(click to expand)</i></summary>\n\n<br>\n\n${rest}\n\n</details>`;
}

export function isCopilotAuthored(user) {
  if (!user) return false;
  if (typeof user.login !== "string") return false;
  return /copilot/i.test(user.login);
}

function cleanBody(user, body) {
  if (isAugmentAuthored(user, body)) return cleanAugmentBody(body);
  if (isCopilotAuthored(user)) return cleanCopilotBody(body);
  return body;
}

async function patchIfChanged({ original, cleaned, patch }) {
  if (cleaned === original) return;
  await patch();
}

export function register(app) {
  // Top-level review summary ("Review completed. N suggestions posted.")
  app.on([
    "pull_request_review.submitted",
    "pull_request_review.edited"
  ], async (context) => {
    const review = context.payload.review;
    const cleaned = cleanBody(review.user, review.body);
    const { owner, repo } = context.repo();
    await patchIfChanged({
      original: review.body,
      cleaned,
      patch: () =>
        context.octokit.rest.pulls.updateReview({
          owner,
          repo,
          pull_number: context.payload.pull_request.number,
          review_id: review.id,
          body: cleaned,
        }),
    });
  });

  // Inline review comments — .edited is critical: the link is filled in via edit.
  app.on([
    "pull_request_review_comment.created",
    "pull_request_review_comment.edited"
  ], async (context) => {
    const comment = context.payload.comment;
    const cleaned = cleanBody(comment.user, comment.body);
    const { owner, repo } = context.repo();
    await patchIfChanged({
      original: comment.body,
      cleaned,
      patch: () =>
        context.octokit.rest.pulls.updateReviewComment({
          owner,
          repo,
          comment_id: comment.id,
          body: cleaned,
        }),
    });
  });

  // Issue comments — Augment PR Summary lives here; Copilot may also post here.
  app.on([
    "issue_comment.created",
    "issue_comment.edited"
  ], async (context) => {
    const comment = context.payload.comment;
    if (!context.payload.issue?.pull_request) return;
    const cleaned = cleanBody(comment.user, comment.body);
    const { owner, repo } = context.repo();
    await patchIfChanged({
      original: comment.body,
      cleaned,
      patch: () =>
        context.octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: comment.id,
          body: cleaned,
        }),
    });
  });
}
