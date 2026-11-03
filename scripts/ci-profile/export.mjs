import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrace, traceUrl } from "./trace.mjs";
import { associatedProfilePr, authorizedActors, trustedOwnerIds } from "./authorize.mjs";

const repository = "paperclipai/paperclip";
const repoPath = `/repos/${repository}`;
const maxBytes = 32 * 1024 * 1024;
const gh = (args) => execFileSync("gh", ["api", ...args], { maxBuffer: maxBytes, timeout: 60_000 });
const get = (endpoint) => JSON.parse(gh([endpoint]).toString());
const pages = (endpoint, field) => JSON.parse(gh(["--paginate", "--slurp", endpoint]).toString())
  .flatMap((page) => field ? page[field] : page);

export async function sendEvents(events, apiKey, dataset, fetcher = fetch, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  if (!apiKey) throw new Error("HONEYCOMB_CI_API_KEY is not configured");
  const transient = new Set([429, 500, 502, 503, 504]);
  for (let offset = 0; offset < events.length; offset += 250) {
    let pending = events.slice(offset, offset + 250);
    for (let attempt = 0; pending.length; attempt += 1) {
      if (attempt >= 8) throw new Error(`Honeycomb did not accept ${pending.length} spans after retries`);
      const response = await fetcher(`https://api.honeycomb.io/1/batch/${encodeURIComponent(dataset)}`, {
        method: "POST", headers: { "X-Honeycomb-Team": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(pending), redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        if (!transient.has(response.status)) throw new Error(`Honeycomb export failed (HTTP ${response.status})`);
        await pause(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      const results = await response.json();
      if (!Array.isArray(results) || results.length !== pending.length) {
        throw new Error("Honeycomb returned an unexpected batch response");
      }
      const rejected = results.flatMap((result, index) => result.status === 202 ? [] : [{ event: pending[index], status: result.status }]);
      const permanent = rejected.find(({ status }) => !transient.has(status));
      if (permanent) throw new Error(`Honeycomb rejected ${rejected.length} spans (status ${permanent.status})`);
      pending = rejected.map(({ event }) => event);
      if (pending.length) await pause(Math.min(30_000, 1000 * 2 ** attempt));
    }
    // The full suite can exceed Honeycomb's burst allowance. Leave capacity
    // for the team's other telemetry rather than exhausting it in one export.
    if (offset + 250 < events.length) await pause(1000);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : null;
  const runId = event?.workflow_run?.id ?? arg("--run-id");
  const attempt = event?.workflow_run?.run_attempt ?? arg("--attempt");
  if (!/^\d+$/.test(String(runId)) || !/^[1-9]\d*$/.test(String(attempt))) {
    throw new Error("Provide --run-id and --attempt, or a workflow_run event");
  }
  const run = get(`${repoPath}/actions/runs/${runId}/attempts/${attempt}`);
  if (run.repository?.full_name !== repository || run.event !== "pull_request"
    || run.path !== ".github/workflows/pr.yml" || run.status !== "completed") {
    throw new Error("Only completed main PR workflow attempts can be profiled");
  }
  // GitHub often leaves workflow_run.pull_requests empty for fork PRs. Resolve
  // association through the head commit, then validate repo and exact head.
  const pulls = pages(`${repoPath}/commits/${run.head_sha}/pulls?per_page=100`);
  const historical = args.includes("--historical");
  if (historical && process.env.GITHUB_ACTIONS) throw new Error("Historical export is a local-only operation");
  const ownerIds = historical ? [] : trustedOwnerIds(get);
  if (process.env.GITHUB_ACTIONS) {
    const exporterId = process.env.GITHUB_RUN_ID;
    const exporterAttempt = process.env.GITHUB_RUN_ATTEMPT;
    if (!/^\d+$/.test(exporterId) || !/^[1-9]\d*$/.test(exporterAttempt)) throw new Error("Invalid exporter run identity");
    const exporter = get(`${repoPath}/actions/runs/${exporterId}/attempts/${exporterAttempt}`);
    if (!authorizedActors(exporter, ownerIds)) {
      console.log("Exporter actor is not a CI CODEOWNER; no data exported.");
      return;
    }
  }
  const pr = historical ? undefined : associatedProfilePr(run, pulls, ownerIds);
  if (!pr && !historical) {
    console.log("No CODEOWNERS-authorized profile-ci PR at this revision; no data exported.");
    return;
  }
  const jobs = pages(`${repoPath}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, "jobs");
  const artifacts = pages(`${repoPath}/actions/runs/${runId}/artifacts?per_page=100`, "artifacts")
    .filter((artifact) => artifact.name.startsWith(`ci-profile-${attempt}-`));
  // The run name snapshots selection at dispatch. A label added while an
  // ordinary run finishes must not retroactively select that earlier run.
  if (!historical && !run.display_title.startsWith("CI profile · PR #")) {
    console.log("This attempt was not selected for profiling; no data exported.");
    return;
  }
  const directory = mkdtempSync(path.join(tmpdir(), "paperclip-ci-export-"));
  const records = [];
  let bytes = 0;
  try {
    for (const artifact of artifacts) {
      if (artifact.expired || artifact.size_in_bytes > maxBytes) throw new Error("Timing artifact is expired or too large");
      const archive = path.join(directory, `${artifact.id}.zip`);
      writeFileSync(archive, gh([`${repoPath}/actions/artifacts/${artifact.id}/zip`]));
      const decoded = execFileSync("python3", [fileURLToPath(new URL("./read-artifact.py", import.meta.url)), archive], {
        encoding: "utf8", maxBuffer: maxBytes, timeout: 30_000,
      });
      bytes += Buffer.byteLength(decoded);
      if (bytes > 128 * 1024 * 1024) throw new Error("Run timing artifacts exceed 128 MiB; refusing to truncate the trace");
      for (const line of decoded.trim().split("\n").filter(Boolean)) records.push(JSON.parse(line));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const trace = buildTrace(run, jobs, records);
  trace.events[0].data["ci.profile_source"] = historical ? "historical" : "label";
  const dataset = process.env.HONEYCOMB_CI_DATASET || "paperclip-ci";
  const url = traceUrl(process.env.HONEYCOMB_TEAM || "paperclip", process.env.HONEYCOMB_ENVIRONMENT || "test", dataset, trace);
  if (arg("--output")) writeFileSync(arg("--output"), JSON.stringify(trace, null, 2));
  if (!args.includes("--dry-run")) {
    // Publish the completed root only after every child has been accepted.
    // A failed partial export must not advertise complete coverage.
    await sendEvents(trace.events.slice(1), process.env.HONEYCOMB_CI_API_KEY, dataset);
    await sendEvents([trace.events[0]], process.env.HONEYCOMB_CI_API_KEY, dataset);
  }
  const summary = [
    `### CI profile${pr ? ` for PR #${pr.number}` : " (historical job/step baseline)"}`,
    "", `[Open the full CI waterfall in Honeycomb](${url})`, "",
    `${trace.jobCount} jobs · ${(trace.wallMs / 1000).toFixed(1)} seconds elapsed · ${trace.events.length} spans`,
    "", `GitHub run: ${run.html_url}/attempts/${attempt}`, "",
    ...trace.warnings.map((warning) => `- ${warning}`),
    "", "The workflow root measures elapsed time. Parallel job durations must not be summed as elapsed time.", "",
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
