import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repository = "paperclipai/paperclip";
const workflowName = "PR merge review notification";
const shaPattern = /^[a-f0-9]{40}$/;
const minimumChecks = ["ci / verify", "ci / e2e"];
const gh = (args) => JSON.parse(execFileSync("gh", args, {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
  // Never allow command diagnostics or a response to reach the Actions log.
  stdio: ["ignore", "pipe", "pipe"],
}));
const api = (endpoint) => gh(["api", endpoint]);
const pages = (endpoint) => gh(["api", "--paginate", "--slurp", endpoint]).flat();
const query = `query($number:Int!, $endCursor:String) {
  repository(owner:"paperclipai", name:"paperclip") {
    pullRequest(number:$number) {
      number url state isDraft headRefOid baseRefOid baseRefName
      statusCheckRollup { contexts(first:100, after:$endCursor) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on CheckRun { name status conclusion checkSuite { workflowRun { workflow { name } } } }
          ... on StatusContext { context state }
        }
      } }
    }
  }
}`;

export function snapshot(number, request = gh) {
  let candidate;
  let cursor;
  const checks = [];
  do {
    const args = ["api", "graphql", "-f", `query=${query}`, "-F", `number=${number}`];
    if (cursor) args.push("-f", `endCursor=${cursor}`);
    const result = request(args);
    if (result.errors?.length) throw new Error("Incomplete check listing");
    const pr = result.data.repository.pullRequest;
    if (candidate && (pr.headRefOid !== candidate.headRefOid || pr.baseRefOid !== candidate.baseRefOid)) {
      throw new Error("Candidate changed during check pagination");
    }
    candidate = pr;
    const contexts = pr.statusCheckRollup.contexts;
    checks.push(...contexts.nodes.map((check) => ({ ...check,
      workflowName: check.checkSuite?.workflowRun?.workflow?.name,
    })));
    if (!contexts.pageInfo.hasNextPage) {
      if (checks.length !== contexts.totalCount) throw new Error("Incomplete check listing");
      break;
    }
    const next = contexts.pageInfo.endCursor;
    if (!next || next === cursor || checks.length >= contexts.totalCount) throw new Error("Incomplete check listing");
    cursor = next;
  } while (checks.length < 10_000);
  if (candidate.statusCheckRollup.contexts.pageInfo.hasNextPage) throw new Error("Check listing limit exceeded");
  return { ...candidate, statusCheckRollup: checks };
}

export function green(pr, requiredNames = minimumChecks) {
  if (pr.state !== "OPEN" || pr.isDraft || pr.baseRefName !== "master" ||
      !shaPattern.test(pr.headRefOid) || !shaPattern.test(pr.baseRefOid)) return false;
  const checks = pr.statusCheckRollup;
  if (!Array.isArray(checks) || checks.length === 0) return false;
  const relevant = checks.filter((check) => ![workflowName, "CI profile"].includes(check.workflowName));
  const passed = (check) => check.__typename === "StatusContext"
    ? check.state === "SUCCESS"
    : check.__typename === "CheckRun" && check.status === "COMPLETED" && check.conclusion === "SUCCESS";
  // A skipped routing lane is normal. A skipped required aggregate is not a pass.
  return relevant.every((check) => passed(check) || (check.__typename === "CheckRun" &&
      check.status === "COMPLETED" && check.conclusion === "SKIPPED")) &&
    [...new Set([...minimumChecks, ...requiredNames])].every((name) =>
      relevant.some((check) => (check.name ?? check.context) === name && passed(check)));
}

export async function deliver(pr, { url, token, fetcher = fetch } = {}) {
  if (!url || !token) return "unconfigured";
  try {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash ||
        !/^\/api\/routine-triggers\/public\/[a-f0-9]+\/fire$/.test(target.pathname)) return "invalid_configuration";
    const response = await fetcher(target, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${token}`,
        "Idempotency-Key": `pr-review:${repository}:${pr.number}:${pr.headRefOid}:${pr.baseRefOid}`,
      },
      // No PR title, body, comments, or executable instructions cross this boundary.
      body: JSON.stringify({ variables: {
        pr_url: `https://github.com/${repository}/pull/${pr.number}`,
        pr_number: String(pr.number), head_sha: pr.headRefOid, base_sha: pr.baseRefOid,
      } }),
    });
    // Do not read the response body: a proxy can echo the URL or credentials.
    await response.body?.cancel();
    return response.ok ? "delivered" : "not_delivered";
  } catch {
    // Fetch errors can contain the private URL. Keep the result fixed and quiet.
    return "not_delivered";
  }
}

export async function notify(event, { read = api, list = pages, view = snapshot, send = deliver } = {}) {
  if (event.repository?.full_name !== repository) return [];
  const run = event.workflow_run;
  if (run && (run.status !== "completed" || !["pull_request", "pull_request_target"].includes(run.event))) return [];
  const sha = run?.head_sha ?? event.check_run?.head_sha ?? event.sha;
  if (!shaPattern.test(sha)) return [];
  // Resolve forks through the commit API too: workflow_run.pull_requests can be empty.
  const associated = run?.pull_requests?.length ? run.pull_requests
    : list(`/repos/${repository}/commits/${sha}/pulls?per_page=100`);
  const required = read(`/repos/${repository}/rules/branches/master`)
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters.required_status_checks.map((check) => check.context));
  const outcomes = [];
  for (const number of new Set(associated.map((pr) => pr.number))) {
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const pr = view(number);
    // Target-context workflows use the base SHA. All other events must still
    // describe this PR's current head; an old successful run cannot trigger it.
    if ((run?.event !== "pull_request_target" && pr.headRefOid !== sha) || !green(pr, required)) continue;
    const fresh = view(number);
    if (fresh.headRefOid !== pr.headRefOid || fresh.baseRefOid !== pr.baseRefOid || !green(fresh, required)) continue;
    outcomes.push(await send(fresh));
  }
  return outcomes;
}

async function main() {
  try {
    const url = process.env.PAPERCLIP_PR_REVIEW_WEBHOOK_URL;
    const token = process.env.PAPERCLIP_PR_REVIEW_WEBHOOK_TOKEN;
    if (!url || !token) {
      console.log("PR review notification is not configured; skipped.");
      return;
    }
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const outcomes = await notify(event, { send: (pr) => deliver(pr, { url, token }) });
    console.log(outcomes.length ? `PR review notification: ${outcomes.join(", ")}.` : "No current green PR to notify.");
  } catch {
    console.log("PR review notification was unavailable; verification results are unchanged.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
