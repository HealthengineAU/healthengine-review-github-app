import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../lib/link-issue-keys.js";
import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";

const CONFIG = {
  issue_links: {
    automatic: true,
    rules: [
      { keys: ["ABC", "XY"], url: "https://example.atlassian.net/browse/$KEY-$NUMBER" },
      {
        keys: ["SESSION"],
        label: "session #$NUMBER",
        url: "https://github.com/example-org/example-repo/issues/$NUMBER",
      },
    ],
  },
};

function makePr({
  branch = "ABC-5752",
  title = "Reject malformed bearer tokens",
  body = "Malformed bearer tokens (empty strings, ...",
  draft = false,
} = {}) {
  return {
    pull_request: { number: 42, title, body, draft, head: { ref: branch }, user: { login: "someone" } },
  };
}

async function open(payload, { config = CONFIG, repo } = {}) {
  const { app, dispatch } = makeApp();
  register(app);
  const octokit = makeOctokit();
  await dispatch("pull_request.opened", makeContext({ octokit, payload, config, repo }));
  return octokit.calls.filter((c) => c.method === "rest.pulls.update");
}

test("pull_request.opened: the branch key is prepended to the description", async () => {
  const updates = await open(makePr());
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args.pull_number, 42);
  assert.equal(
    updates[0].args.body,
    "[ABC-5752](https://example.atlassian.net/browse/ABC-5752)\n\nMalformed bearer tokens (empty strings, ...",
  );
});

test("pull_request.opened: a description that already names the issue is untouched", async () => {
  const updates = await open(makePr({ body: "Fixes ABC-5752 — malformed bearer tokens." }));
  assert.equal(updates.length, 0);
});

test("pull_request.opened: a branch with no issue key is untouched", async () => {
  const updates = await open(makePr({ branch: "node-21", title: "Bump node to 21" }));
  assert.equal(updates.length, 0);
});

test("pull_request.opened: a key no rule claims is untouched", async () => {
  const updates = await open(makePr({ branch: "other-197-a11y-before", title: "a11y pass" }));
  assert.equal(updates.length, 0);
});

test("pull_request.opened: rules route each key to its own tracker", async () => {
  const updates = await open(makePr({ branch: "claude/some-session-220-storybook-port", title: "Storybook port" }));
  assert.equal(updates.length, 1);
  assert.ok(
    updates[0].args.body.startsWith(
      "[session #220](https://github.com/example-org/example-repo/issues/220)\n\n",
    ),
  );
});

test("pull_request.opened: the title supplies the key when the branch doesn't", async () => {
  const updates = await open(makePr({ branch: "bearer-token-guard", title: "XY-1183 - Reject malformed bearer tokens" }));
  assert.equal(updates.length, 1);
  assert.ok(updates[0].args.body.startsWith("[XY-1183](https://example.atlassian.net/browse/XY-1183)\n\n"));
});

test("pull_request.opened: drafts get the link too", async () => {
  const updates = await open(makePr({ draft: true }));
  assert.equal(updates.length, 1);
});

test("pull_request.opened: an empty description becomes the link alone", async () => {
  const updates = await open(makePr({ body: null }));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args.body, "[ABC-5752](https://example.atlassian.net/browse/ABC-5752)");
});

test("pull_request.opened: nothing happens without issue_links.automatic", async () => {
  const updates = await open(makePr(), { config: { issue_links: { rules: CONFIG.issue_links.rules } } });
  assert.equal(updates.length, 0);
});

test("pull_request.opened: nothing happens without rules", async () => {
  const updates = await open(makePr(), { config: { issue_links: { automatic: true } } });
  assert.equal(updates.length, 0);
});

test("pull_request.opened: nothing happens with no config at all", async () => {
  const updates = await open(makePr(), { config: null });
  assert.equal(updates.length, 0);
});

test("pull_request.opened: a repository the filter excludes is untouched", async () => {
  const updates = await open(makePr(), {
    repo: "legacy-monolith",
    config: {
      issue_links: {
        automatic: true,
        repositories: ["*", "!legacy-monolith"],
        rules: CONFIG.issue_links.rules,
      },
    },
  });
  assert.equal(updates.length, 0);
});
