// Posts an "AI Review" commit status summarizing which bots reviewed the PR
// and how many inline comments they left, or if a review has been requested.

const COMMIT_STATUS_CONTEXT = "AI Review";
const SKIP_LABEL = "skip-ai-review";
const DESCRIPTION_MAX_LENGTH = 140;
const UPDATE_DEBOUNCE_MS = 2000;

/** Provider values MUST be matching substrings of github.login.toLowerCase() */
const BOT = {
  Augment: "augment",
  Claude: "claude",
  Copilot: "copilot",
  Greptile: "greptile",
  LinearB: "linear",
};

const BOT_DISPLAY_NAMES = {
  [BOT.Augment]: "Auggie",
  [BOT.Claude]: "Claude",
  [BOT.Copilot]: "Copilot",
  [BOT.Greptile]: "Greptile",
  [BOT.LinearB]: "LinearB",
};

const COMMENT_TYPE = {
  Failed: "dnf",
  Reviewed: "reviewed",
  ApprovedNoFeedback: "approvedNoFeedback",
};

const BOT_COMMENTS = {
  [BOT.Augment]: {
    [COMMENT_TYPE.Failed]: /tokens to review|out of credits/,
    [COMMENT_TYPE.ApprovedNoFeedback]: /No suggestions at this time\./,
  },

  [BOT.Copilot]: {
    [COMMENT_TYPE.Failed]: /Copilot wasn't able|unable to review/,
    [COMMENT_TYPE.ApprovedNoFeedback]: /no comments|no new comments/,
  },
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

function clampDescription(description) {
  if (description.length <= DESCRIPTION_MAX_LENGTH) {
    return description;
  }
  return `${description.slice(0, DESCRIPTION_MAX_LENGTH - 1)}…`;
}

function getBotKey(login) {
  const lower = login?.toLowerCase();
  if (!lower) return null;
  for (const key of Object.values(BOT)) {
    if (lower.includes(key)) return key;
  }
  return null;
}

function classifyBot({ login, displayName, botKey, comments, feedbackTotal, feedbackResolved }) {
  const detector = botKey ? BOT_COMMENTS[botKey] : null;
  const lastBody = comments[comments.length - 1]?.body;

  if (detector?.[COMMENT_TYPE.Failed] && lastBody && detector[COMMENT_TYPE.Failed].test(lastBody)) {
    return { state: "failed", login, displayName, feedbackTotal, feedbackResolved };
  }

  if (detector?.[COMMENT_TYPE.ApprovedNoFeedback] && lastBody && detector[COMMENT_TYPE.ApprovedNoFeedback].test(lastBody)) {
    return { state: "approved-no-feedback", login, displayName, feedbackTotal, feedbackResolved };
  }

  if (feedbackTotal > 0 && feedbackResolved === feedbackTotal) {
    return { state: "approved", login, displayName, feedbackTotal, feedbackResolved };
  }

  return { state: "reviewed", login, displayName, feedbackTotal, feedbackResolved };
}

function formatBotEntry(entry) {
  if (entry.state === "requested-review") {
    return `requested review by ${entry.displayName}`;
  }

  if (entry.state === "failed") {
    return `${entry.displayName} unable to review`;
  }

  if (entry.state === "approved-no-feedback" || entry.feedbackTotal === 0) {
    return `reviewed by ${entry.displayName} (✓ no feedback)`;
  }

  if (entry.state === "approved") {
    return `reviewed by ${entry.displayName} (✓ ${entry.feedbackTotal} resolved)`;
  }

  return `feedback from ${entry.displayName} (${entry.feedbackResolved}/${entry.feedbackTotal} resolved)`;
}

// Coalesce bursts of webhook events (we sometimes see ~20 fire at once
// for the same PR) into a single trailing-edge update per PR.
const pendingUpdates = new Map();

function scheduleUpdateAIReviewStatus(octokit, args) {
  const key = `${args.owner}/${args.repo}#${args.pr.number}`;
  const existing = pendingUpdates.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    pendingUpdates.delete(key);
    updateAIReviewStatus(octokit, args).catch((err) => {
      console.error(`AI Review status update failed for ${key}`, err);
    });
  }, UPDATE_DEBOUNCE_MS);

  pendingUpdates.set(key, timer);
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
      description: clampDescription(`Review skipped via "${SKIP_LABEL}" label`),
    });

    return;
  }

  if (isBotUser(pr.user)) {
    await octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state: "success",
      context: COMMIT_STATUS_CONTEXT,
      description: clampDescription(`AI review skipped for author ${pr.user.login}`),
    });

    return;
  }

  // get feedback
  const [reviews, issueComments, reviewComments, threadsResult] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner, repo, pull_number, per_page: 50,
    }),
    octokit.paginate(octokit.rest.issues.listComments, {
      owner, repo, issue_number: pull_number, per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner, repo, pull_number, per_page: 100,
    }),
    octokit.graphql(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                comments(first: 1) { nodes { databaseId } }
              }
            }
          }
        }
      }`,
      { owner, repo, number: pull_number },
    ),
  ]);

  const reviewThreads = threadsResult?.repository?.pullRequest?.reviewThreads?.nodes || [];
  const reviewCommentsById = new Map(reviewComments.map((c) => [c.id, c]));

  // Group threads by the originating inline comment's author user.id.
  // Match by user.id, not login: Copilot's review user is "copilot-pull-request-reviewer[bot]"
  // but its inline comments are authored as "Copilot" — same id, different login.
  const threadsByAuthorId = new Map();
  for (const thread of reviewThreads) {
    const firstId = thread.comments?.nodes?.[0]?.databaseId;
    const userId = firstId != null ? reviewCommentsById.get(firstId)?.user?.id : null;
    if (userId == null) continue;
    const list = threadsByAuthorId.get(userId) || [];
    list.push(thread);
    threadsByAuthorId.set(userId, list);
  }

  // Bots qualify as reviewers only if they submitted a formal review.
  // Issue comments enrich the per-bot timeline so last-comment detectors fire correctly.
  const botActivity = new Map();
  for (const review of reviews) {
    if (!isBotUser(review.user) || review.user?.id == null) continue;
    const entry = botActivity.get(review.user.id) || { user: review.user, comments: [] };
    if (review.body) {
      entry.comments.push({ body: review.body, createdAt: review.submitted_at });
    }
    botActivity.set(review.user.id, entry);
  }
  for (const comment of issueComments) {
    if (!isBotUser(comment.user) || comment.user?.id == null) continue;
    const entry = botActivity.get(comment.user.id);
    if (!entry || !comment.body) continue;
    entry.comments.push({ body: comment.body, createdAt: comment.created_at });
  }
  for (const entry of botActivity.values()) {
    entry.comments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  const classifications = [];
  for (const [userId, entry] of botActivity) {
    const login = entry.user?.login;
    const threads = threadsByAuthorId.get(userId) || [];

    classifications.push(classifyBot({
      login,
      displayName: getBotDisplayName(login),
      botKey: getBotKey(login),
      comments: entry.comments,
      feedbackTotal: threads.length,
      feedbackResolved: threads.filter((t) => t.isResolved).length,
    }));
  }

  // add 
  const classifiedLogins = new Set(classifications.map((c) => c.login));
  const pendingReviewClassifications = (pr.requested_reviewers || [])
    .filter((user) => isBotUser(user) && user.login && !classifiedLogins.has(user.login))
    .map((user) => ({
      state: "requested-review",
      login: user.login,
      displayName: getBotDisplayName(user.login),
      comments: [],
      feedback: 0,
      feedbackResolved: 0,
    }));
  classifications.push(...pendingReviewClassifications);
  classifications.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const parts = classifications.map(formatBotEntry);

  let description;
  if (parts.length > 0) {
    // Sentence case
    const joined = parts.join(", ");
    description = joined.charAt(0).toUpperCase() + joined.slice(1);
  } else {
    return;
  }

  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state: "success",
    context: COMMIT_STATUS_CONTEXT,
    description: clampDescription(description),
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

    scheduleUpdateAIReviewStatus(context.octokit, { owner, repo, pr });
  });

  app.on([
    "pull_request_review.submitted",
  ], async (context) => {
    const { pull_request: pr, review } = context.payload;

    if (!isBotUser(review.user)) {
      return;
    }
  
    const { owner, repo } = context.repo();

    scheduleUpdateAIReviewStatus(context.octokit, { owner, repo, pr });
  });

  app.on([
    "pull_request_review_comment.created",
  ], async (context) => {
    const { pull_request: pr, comment } = context.payload;

    if (!isBotUser(comment.user)) {
      return;
    }

    const { owner, repo } = context.repo();

    scheduleUpdateAIReviewStatus(context.octokit, { owner, repo, pr });
  });

  app.on([
    "pull_request.labeled",
  ], async (context) => {
    if (context.payload.label?.name !== SKIP_LABEL) {
      return;
    }

    const { owner, repo } = context.repo();
    const pr = context.payload.pull_request;

    scheduleUpdateAIReviewStatus(context.octokit, { owner, repo, pr });
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
      description: clampDescription(`"${SKIP_LABEL}" label removed`),
    });

    scheduleUpdateAIReviewStatus(context.octokit, { owner, repo, pr });
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

    scheduleUpdateAIReviewStatus(context.octokit, { owner, repo, pr });
  });
}
