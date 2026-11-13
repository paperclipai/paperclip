import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = "paperclipai/paperclip";
const repositoryId = 1170821064;
export const getGithub = (endpoint) => JSON.parse(execFileSync("gh", ["api", endpoint], {
  encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
}));

// This is deliberately the CI infrastructure owner list, not the union of
// unrelated documentation owners. Unsupported teams/ambiguous rules deny access.
export function ciOwners(contents) {
  const rules = contents.split(/\r?\n/).map((line) => line.split("#")[0].trim().split(/\s+/))
    .filter(([pattern]) => pattern === ".github/**" || pattern === "/.github/**");
  if (rules.length !== 1 || rules[0].length < 2
    || rules[0].slice(1).some((owner) => !/^@[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(owner))) {
    throw new Error("CI CODEOWNERS must have one explicit .github/** rule with individual GitHub users");
  }
  return rules[0].slice(1).map((owner) => owner.slice(1));
}

export function trustedOwnerIds(get = getGithub, trustedSha) {
  const sha = trustedSha || get(`/repos/${repository}/git/ref/heads/master`).object.sha;
  if (!/^[a-f\d]{40}$/.test(sha)) throw new Error("Invalid trusted CODEOWNERS revision");
  const file = get(`/repos/${repository}/contents/.github/CODEOWNERS?ref=${sha}`);
  if (file.encoding !== "base64") throw new Error("Cannot read trusted CODEOWNERS");
  return ciOwners(Buffer.from(file.content, "base64").toString("utf8")).map((login) => {
    const user = get(`/users/${login}`);
    if (user.type !== "User" || !Number.isSafeInteger(user.id) || user.id <= 0) {
      throw new Error("Cannot resolve a CI CODEOWNER identity");
    }
    return user.id;
  });
}

export function authorizedActors(run, ownerIds) {
  const allowed = (user) => user?.type === "User" && ownerIds.includes(user.id);
  return run.repository?.id === repositoryId && run.repository?.full_name === repository
    && allowed(run.actor) && allowed(run.triggering_actor);
}

export function associatedProfilePr(run, pulls, ownerIds) {
  if (!authorizedActors(run, ownerIds)) return undefined;
  return pulls.find((pr) => pr.base.repo.id === repositoryId && pr.base.repo.full_name === repository
    && pr.head.repo?.id === run.head_repository?.id && pr.head.sha === run.head_sha
    && pr.user?.type === "User" && ownerIds.includes(pr.user.id)
    && pr.labels.some((label) => label.name === "profile-ci"));
}

async function main() {
  let enabled = false;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (event.pull_request?.labels?.some((label) => label.name === "profile-ci")) {
      const runId = process.env.GITHUB_RUN_ID;
      const attempt = process.env.GITHUB_RUN_ATTEMPT;
      if (!/^\d+$/.test(runId) || !/^[1-9]\d*$/.test(attempt)) throw new Error("Invalid CI run identity");
      const run = getGithub(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}`);
      const pr = getGithub(`/repos/${repository}/pulls/${event.pull_request.number}`);
      enabled = run.event === "pull_request" && run.path === ".github/workflows/pr.yml"
        && Boolean(associatedProfilePr(run, [pr], trustedOwnerIds(getGithub, process.env.TRUSTED_PROFILE_SHA)));
    }
  } catch {
    console.log("::notice::CI profiling authorization could not be verified; profiling disabled.");
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `profile_ci=${enabled}\n`);
  console.log(`::notice::CI CODEOWNERS profiling authorization: ${enabled}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("CI profiling authorization failed"); process.exitCode = 1; });
}
