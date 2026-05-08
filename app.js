const COMMIT_STATUS_CONTEXT = "AI Review";

/** Login substring -> Display name */
const DISPLAY_NAMES = {
  "augment": "Auggie",
  "claude": "Claude",
  "copilot": "Copilot",
  "greptile": "Grepile",
  "linear": "LinearB",
};

async function updateAIReviewStatus(octokit, { owner, repo, pull_number, sha }) {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number,
    per_page: 50,
  });

  const botReviews = reviews.filter((review) =>
    review.user?.type === "Bot" || review.user?.login?.endsWith("[bot]")
  );

  if (botReviews.length === 0) {
    return;
  }

  // reviewers
  const botLogins = new Set(botReviews.map((review) => review.user?.login).filter((l) => !!l));
  const botUserIds = new Set(botReviews.map((review) => review.user?.id).filter((id) => id != null));
  const botNames = [...botLogins].map((login) => {
    for (const pattern in DISPLAY_NAMES) {
      if (login.toLowerCase().includes(pattern)) {
        return DISPLAY_NAMES[pattern];
      }
    }

    return login;
  }).sort();

  const reviewers = botNames.join(botNames.length <= 2 ? " and " : ", ");

  // summary
  const reviewComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
  // Match by user.id, not login: Copilot's review user is "copilot-pull-request-reviewer[bot]"
  // but its inline comments are authored as "Copilot" — same id, different login.
  const feedbackCount = reviewComments.filter((c) => botUserIds.has(c.user?.id)).length;
  const summary = feedbackCount === 0
    ? "No feedback"
    : `${feedbackCount} feedback ${feedbackCount === 1 ? "comment" : "comments"}`;

  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state: "success",
    context: COMMIT_STATUS_CONTEXT,
    description: `Reviewed by ${reviewers} (${summary})`,
  });
}

export default (app) => {
  app.on([
    "pull_request_review_comment.created",
    "pull_request_review_thread.resolved",
    "pull_request_review.submitted",
    "pull_request.reopened",
    "pull_request.synchronize",
  ], async (context) => {
    const { owner, repo } = context.repo();
    const pr = context.payload.pull_request;

    await updateAIReviewStatus(context.octokit, {
      owner,
      repo,
      pull_number: pr.number,
      sha: pr.head.sha,
    });
  });
};
