// Strips "Fix [This|All] in Augment" links from augmentcode[bot] comments.
// Author-scoped by content signature so a future bot rename still works.
//
// We only act once the real link is present. The "Generating..." placeholder
// state is left alone — Augment is about to edit the comment to add the link,
// and we'll catch it via the .edited webhook.

const AUGMENT_HOSTS = /(?:public\.augment-assets\.com|augmentcode\.com)/;

// Markdown image-link whose image src is on augment-assets and outer href is on augmentcode.
// Matches both "Fix This in Augment" (inline) and "Fix All in Augment" (review summary).
const AUGMENT_IMG_LINK =
  /\[!\[[^\]]*\]\([^)]*(?:public\.augment-assets\.com|augmentcode\.com)[^)]*\)\]\([^)]*augmentcode\.com[^)]*\)/g;

const EXTRA_BLANKS = /\n{3,}/g;

export function cleanAugmentBody(body) {
  if (!body || !AUGMENT_HOSTS.test(body)) return body;
  return body
    .replace(AUGMENT_IMG_LINK, "")
    .replace(EXTRA_BLANKS, "\n\n")
    .trimEnd();
}

export function isAugmentAuthored(user, body) {
  if (!user) return false;
  if (typeof user.login === "string" && /augment/i.test(user.login)) return true;
  // Content-based fallback in case the bot login changes.
  if (user.type === "Bot" && body && AUGMENT_HOSTS.test(body)) return true;
  return false;
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
    if (!isAugmentAuthored(review.user, review.body)) return;
    const cleaned = cleanAugmentBody(review.body);
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
    if (!isAugmentAuthored(comment.user, comment.body)) return;
    const cleaned = cleanAugmentBody(comment.body);
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

  // Issue comments — defensive net. Today's "Augment PR Summary" issue comment has no
  // Fix-in-Augment link, so this is a no-op until/unless Augment changes that.
  app.on([
    "issue_comment.created",
    "issue_comment.edited"
  ], async (context) => {
    const comment = context.payload.comment;
    if (!context.payload.issue?.pull_request) return;
    if (!isAugmentAuthored(comment.user, comment.body)) return;
    const cleaned = cleanAugmentBody(comment.body);
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
