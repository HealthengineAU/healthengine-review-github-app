// Posts an "AI Review" commit status summarizing which bots reviewed the PR
// and how many inline comments they left, or if a review has been requested.

const COMMIT_STATUS_CONTEXT = "AI Review";
const SKIP_LABEL = "skip-ai-review";

/** Login substring for matching -> Display name */
const BOT_DISPLAY_NAMES = {
  "augment": "Auggie",
  "claude": "Claude",
  "copilot": "Copilot",
  "greptile": "Greptile",
  "linear": "LinearB",
};

function getBotDisplayName(login) {
  for (const pattern in BOT_DISPLAY_NAMES) {
    if (login?.toLowerCase().includes(pattern)) {
      return BOT_DISPLAY_NAMES[pattern];
    }
  }

  return login;
}

function isBotUser(user) {
  return user?.type === "Bot" || user?.login?.endsWith("[bot]");
}

function joinReviewers(names) {
  return names.join(names.length <= 2 ? " and " : ", ");
}

async function updateAIReviewStatus(octokit, { owner, repo, pr }) {
  const pull_number = pr.number;
  const sha = pr.head.sha;

  if (pr.state === "closed") {
    return;
  }

  const hasSkipLabel = (pr.labels || []).some((label) => label.name === SKIP_LABEL);

  if (hasSkipLabel) {
    await octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state: "success",
      context: COMMIT_STATUS_CONTEXT,
      description: `Review skipped via "${SKIP_LABEL}" label`,
    });

    return;
  }

  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number,
    per_page: 50,
  });

  const botReviews = reviews.filter((review) => isBotUser(review.user));
  const botReviewRequestLogins = (pr.requested_reviewers || [])
    .filter((user) => isBotUser(user) && user.login)
    .map((user) => user.login);

  const anyBotReviewCompleted = botReviews.length > 0;
  const anyBotReviewRequested = botReviewRequestLogins.length > 0;

  let description;

  if (anyBotReviewCompleted) {
    const botLogins = new Set(botReviews.map((review) => review.user?.login).filter((l) => !!l));
    const botUserIds = new Set(botReviews.map((review) => review.user?.id).filter((id) => id != null));
    const botNames = [...botLogins].map(getBotDisplayName).sort();

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

    description = `Reviewed by ${joinReviewers(botNames)} (${summary})`;
  } else if (anyBotReviewRequested) {
    const reviewers = joinReviewers(botReviewRequestLogins.map(getBotDisplayName).sort());
    description = `Review by ${reviewers} requested`;
  } else {
    return;
  }

  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state: "success",
    context: COMMIT_STATUS_CONTEXT,
    description,
  });
}

export function register(app) {
  app.on([
    "pull_request.opened",
    "pull_request.ready_for_review",
    "pull_request.reopened",
    "pull_request.review_requested",
    "pull_request.synchronize",
  ], async (context) => {
    const { owner, repo } = context.repo();
    const pr = context.payload.pull_request;

    await updateAIReviewStatus(context.octokit, { owner, repo, pr });
  });

  app.on([
    "pull_request_review.submitted",
  ], async (context) => {
    const { pull_request: pr, review } = context.payload;

    if (!isBotUser(review.user)) {
      return;
    }
  
    const { owner, repo } = context.repo();

    await updateAIReviewStatus(context.octokit, { owner, repo, pr });
  });

  app.on([
    "pull_request_review_comment.created",
  ], async (context) => {
    const { pull_request: pr, comment } = context.payload;

    if (!isBotUser(comment.user)) {
      return;
    }

    const { owner, repo } = context.repo();

    await updateAIReviewStatus(context.octokit, { owner, repo, pr });
  });

  app.on([
    "pull_request.labeled",
  ], async (context) => {
    if (context.payload.label?.name !== SKIP_LABEL) {
      return;
    }

    const { owner, repo } = context.repo();
    const pr = context.payload.pull_request;

    await updateAIReviewStatus(context.octokit, { owner, repo, pr });
  });

  app.on([
    "pull_request.unlabeled",
  ], async (context) => {
    if (context.payload.label?.name !== SKIP_LABEL) {
      return;
    }

    const pr = context.payload.pull_request;
    const sha = pr.head.sha;
    const { owner, repo } = context.repo();

    // when label is just removed, we revert the check to
    // "pending" first so that the gate is reinstated
    await context.octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state: "pending",
      context: COMMIT_STATUS_CONTEXT,
      description: `"${SKIP_LABEL}" label removed`,
    });

    await updateAIReviewStatus(context.octokit, { owner, repo, pr });
  });

  app.on([
    "issue_comment.created",
  ], async (context) => {
    const { issue, comment } = context.payload;
    if (!issue.pull_request) {
      return;
    }

    if (!isBotUser(comment.user)) {
      return;
    }

    const { owner, repo } = context.repo();
    const { data: pr } = await context.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: issue.number,
    });

    await updateAIReviewStatus(context.octokit, { owner, repo, pr });
  });
}
