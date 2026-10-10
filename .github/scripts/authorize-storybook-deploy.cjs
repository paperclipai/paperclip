// Run before building, and again inside the protected deployment job on reruns.
module.exports = async function authorizeStorybookDeploy({ github, context }) {
  const fail = (message) => { throw new Error(message); };
  if (context.repo.owner !== "paperclipai" || context.repo.repo !== "paperclip") {
    fail("Storybook publishing is restricted to paperclipai/paperclip.");
  }
  if (context.eventName !== "workflow_dispatch" || !context.ref.startsWith("refs/heads/")) {
    fail("Storybook publishing requires a manual run from a repository branch.");
  }

  // The selected branch must never be able to add itself to the allowlist.
  const { data: repository } = await github.rest.repos.get(context.repo);
  const { data: file } = await github.rest.repos.getContent({
    ...context.repo,
    path: ".github/CODEOWNERS",
    ref: repository.default_branch,
  });
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    fail("Cannot read the default branch CODEOWNERS file.");
  }
  const owners = new Set();
  for (const line of Buffer.from(file.content, "base64").toString("utf8").split(/\r?\n/)) {
    const fields = line.split("#", 1)[0].trim().split(/\s+/);
    for (const owner of fields.slice(1)) {
      // Individual GitHub accounts only. Teams/email entries do not grant access.
      if (/^@[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(owner)) {
        owners.add(owner.slice(1).toLowerCase());
      }
    }
  }
  if (owners.size === 0) fail("CODEOWNERS has no individual GitHub accounts.");
  for (const actor of [context.actor, process.env.GITHUB_TRIGGERING_ACTOR]) {
    if (!actor || !owners.has(actor.toLowerCase())) {
      fail(`Only default-branch CODEOWNERS may publish Storybook (${actor || "missing actor"}).`);
    }
  }

  // A branch can edit its workflow. Require a GitHub-enforced CODEOWNER review
  // as well, so editing this check cannot grant an outsider deployment access.
  const { data: environment } = await github.rest.repos.getEnvironment({
    ...context.repo,
    environment_name: "storybook-deploy",
  });
  const reviewers = environment.protection_rules
    ?.find((rule) => rule.type === "required_reviewers")?.reviewers;
  if (environment.can_admins_bypass !== false || !reviewers?.length ||
      reviewers.some(({ type, reviewer }) => type !== "User" || !owners.has(reviewer.login.toLowerCase()))) {
    fail("storybook-deploy must require CODEOWNER reviewers and disable administrator bypass.");
  }
};
