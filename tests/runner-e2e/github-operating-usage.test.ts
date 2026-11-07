import { expect, it } from "vitest";
import { readGitHubOperatingUsage } from "./github-operating-usage.js";

const now = Date.parse("2026-10-21T12:00:00Z"), sha = "a".repeat(40);
const run = { id: 123, repository: { id: 456, full_name: "paperclipai/paperclip" },
  path: ".github/workflows/runner-full-stack-e2e.yml", run_attempt: 1, status: "completed", conclusion: "failure", head_sha: sha,
  created_at: "2026-10-21T10:00:00Z", run_started_at: "2026-10-21T10:01:00Z", updated_at: "2026-10-21T10:10:00Z" };
const job = (id = 1) => ({ id, run_id: 123, run_attempt: 1, status: "completed", conclusion: "success", runner_id: 1,
  runner_name: "GitHub Actions 1", runner_group_name: "GitHub Actions", labels: ["ubuntu-latest"],
  started_at: "2026-10-21T10:01:00Z", completed_at: "2026-10-21T10:02:00Z", name: "unretained arbitrary user text" });
const artifact = { id: 9, workflow_run: { id: 123, head_sha: sha }, size_in_bytes: 1024, expired: false,
  created_at: "2026-10-21T10:03:00Z", expires_at: "2026-11-20T10:03:00Z", name: "unretained arbitrary artifact text" };
function api(overrides: Record<string, any> = {}) {
  const reads: string[] = [];
  return { reads, read: async (endpoint: string) => {
    reads.push(endpoint);
    if (endpoint === "repos/paperclipai/paperclip") return { id: 456, full_name: "paperclipai/paperclip", private: false, ...overrides.repo };
    if (endpoint.endsWith("/runs/123")) return { ...run, ...overrides.run, ...(reads.filter(row => row.endsWith("/runs/123")).length === 2 ? overrides.finalRun : {}) };
    if (endpoint.includes("/jobs?")) {
      const jobs = overrides.jobs ?? [job()];
      const page = Number(new URL(`https://api.github.com/${endpoint}`).searchParams.get("page"));
      return { total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100), ...overrides.jobPage };
    }
    if (endpoint.includes("/artifacts?")) return { total_count: 1, artifacts: [artifact], ...overrides.artifactPage };
    throw new Error("Unexpected read");
  } };
}

it("collects failed-run usage without equating job time, current rates or inventory with billed cost", async () => {
  const source = api();
  const usage = await readGitHubOperatingUsage("123", source.read, now);
  expect(usage).toMatchObject({ runAttempt: 1, sourceSha: sha, queueSeconds: 60, summedJobSeconds: 60,
    allStartedJobsStandardHosted: true, artifacts: { retainedBytes: 1024, lifetimeCoverage: "incomplete" },
    billing: { ciComputeUsd: null, artifactStorageUsd: null, publicStandardComputeRateUsdPerMinute: "0" } });
  expect(JSON.stringify(usage)).not.toContain("unretained");
  expect(source.reads).toHaveLength(5);
});

it("paginates all jobs and preserves nonstandard compute as unpriced", async () => {
  const jobs = Array.from({ length: 101 }, (_, index) => job(index + 1));
  jobs[100]!.runner_group_name = "custom-fleet";
  const source = api({ jobs });
  expect(await readGitHubOperatingUsage("123", source.read, now)).toMatchObject({ summedJobSeconds: 6060,
    allStartedJobsStandardHosted: false, billing: { publicStandardComputeRateUsdPerMinute: null } });
  expect(source.reads.some(endpoint => endpoint.includes("page=2"))).toBe(true);
  expect((await readGitHubOperatingUsage("123", api({ repo: { private: true } }).read, now)).billing.publicStandardComputeRateUsdPerMinute).toBeNull();
});

it("rejects changing, truncated, duplicated, misattributed, rerun and uncompleted evidence", async () => {
  for (const override of [{ run: { run_attempt: 2 } }, { run: { status: "in_progress" } }, { run: { path: "other.yml" } },
    { finalRun: { head_sha: "b".repeat(40) } }, { jobPage: { total_count: 2 } }, { jobs: [job(), job()] },
    { jobs: [{ ...job(), run_id: 999 }] }, { jobs: [{ ...job(), runner_id: null }] },
    { jobs: [{ ...job(), runner_id: undefined }] }, { jobs: [{ ...job(), conclusion: "skipped", runner_id: undefined }] },
    { jobs: [{ ...job(), completed_at: null }] }, { jobPage: { total_count: 1001 } },
    { artifactPage: { artifacts: [{ ...artifact, workflow_run: { id: 999, head_sha: sha } }] } },
    { artifactPage: { artifacts: [{ ...artifact, size_in_bytes: -1 }] } }]) {
    await expect(readGitHubOperatingUsage("123", api(override).read, now)).rejects.toThrow();
  }
});

it.each([0, null])("accounts skipped jobs with runner ID %s without requiring a fictitious VM", async (runnerId) => {
  const source = api({ jobs: [{ ...job(), conclusion: "skipped", runner_id: runnerId, started_at: null, completed_at: null }],
    artifactPage: { artifacts: [{ ...artifact, expired: true }] } });
  expect(await readGitHubOperatingUsage("123", source.read, now)).toMatchObject({ summedJobSeconds: 0,
    jobs: [{ runner: "not_started" }], artifacts: { retainedBytes: 0, inventory: [{ id: 9, expired: true }] } });
});
