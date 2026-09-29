import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { packageEvidence } from "./evidence.js";
import { runPiNativeFlow } from "./pi-native-flow.js";
import { sanitizeJson } from "./redaction.js";

// Drive the actual flow and packager without a browser, provider, or server.
// Only the external browser/API boundaries are scripted.
vi.mock("./user-actions.js", () => ({ createTaskThroughUi: vi.fn() }));
vi.mock("@playwright/test", () => ({
  expect: (actual: unknown, message?: string) => ({
    toBe: (expected: unknown) => expect(actual, message).toBe(expected),
    toBeVisible: async () => expect(actual, message).toEqual({ visible: true }),
  }),
}));

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

type FlowInput = Parameters<typeof runPiNativeFlow>[0];
async function fixture(options: { failComments?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-native-evidence-")); roots.push(root);
  const privateDir = join(root, "private"); const uploadDir = join(root, "upload");
  const workspacePath = join(root, "workspace"); const snapshots = join(privateDir, "snapshots");
  for (const directory of [workspacePath, snapshots, join(privateDir, "html-report"), join(privateDir, "blob-report")]) await mkdir(directory, { recursive: true });
  const execution = runnerMatrix.find(row => row.id === "pi-native.runner-acpx-pi.local.native-questions")!;
  const issue = { id: "issue-fixture", identifier: "PI-1", title: execution.task.buildTitle("fixture"), status: "done" };
  const run = { id: "run-fixture", status: "succeeded", runtimeMode: "native", createdAt: "2026-09-29T00:00:00Z" };
  const headers = ["Pi native color", "Pi native confirmation", "Pi native name", "Pi native draft"];
  let answered = 0; const typed: string[] = [];
  const interactions = () => headers.slice(0, Math.min(4, answered + 1)).map((header, index) => ({
    id: `question-${index}`, kind: "ask_user_questions", status: index < answered ? "answered" : "pending",
    sourceRunId: run.id, continuationPolicy: "none",
    payload: { runtimeRequestId: `native-${index}`, questionSet: { questions: [{ header }] } },
  }));
  const secret = "private-fixture-sentinel-value";
  const comments = [{ id: "comment-fixture", body: `Completed ${secret}` }];
  // A full first page requires the real collector to retain a second page.
  const eventRows = Array.from({ length: 1001 }, (_, index) => ({ seq: index + 1, eventType: "fixture" }));
  const paths: string[] = [];
  const api = {
    post: async () => ({ name: "Pi fixture project" }),
    get: async (path: string) => {
      paths.push(path);
      if (path === "/api/companies/company-fixture/issues?limit=100") return [issue];
      if (path === `/api/issues/${issue.id}`) return issue;
      if (path === "/api/companies/company-fixture/heartbeat-runs?limit=100") return [run];
      if (path === `/api/heartbeat-runs/${run.id}`) return run;
      if (path === `/api/issues/${issue.id}/interactions`) return interactions();
      if (path === `/api/issues/${issue.id}/comments`) {
        if (options.failComments) throw new Error("fixture comments unavailable");
        return comments;
      }
      if (path.startsWith(`/api/heartbeat-runs/${run.id}/events?`)) {
        const afterSeq = Number(new URL(path, "http://fixture.invalid").searchParams.get("afterSeq"));
        return eventRows.filter(row => row.seq > afterSeq).slice(0, 1000);
      }
      throw new Error(`Unexpected fixture API path ${path}`);
    },
  };
  const page = {
    goto: async () => {}, reload: async () => {},
    getByTestId: (id: string) => id === "issue-detail-header"
      ? { getByRole: () => ({ visible: true }) }
      : { last: () => ({ locator: () => ({ first: () => ({ fill: async (value: string) => { typed.push(value); } }) }) }) },
    getByRole: (role: string) => ({ last: () => ({ click: async () => {
      if (role !== "button") return;
      answered += 1;
      if (answered === 4) await writeFile(join(workspacePath, "pi-native-answers.json"), JSON.stringify([
        { status: "answered", optionId: "blue" }, { status: "negative_or_cancelled", confirmed: false },
        { status: "answered", value: typed[0] }, { status: "answered", value: typed[1] },
      ]));
    } }) }),
  };
  const evidence = async (name: string, data: unknown) => { await writeFile(join(snapshots, name), JSON.stringify(sanitizeJson(data, [secret]))); };
  const capture = vi.fn(async (_id: string, _label: string, file: string) => { await writeFile(join(privateDir, file), "fixture screenshot boundary"); });
  const input = {
    page: page as unknown as FlowInput["page"], api: api as unknown as FlowInput["api"],
    fixtures: { company: { id: "company-fixture", issuePrefix: "PI" }, agent: { name: "Pi fixture" }, environment: { id: "environment-fixture" } } as FlowInput["fixtures"],
    execution, nonce: "fixture", workspacePath, deadlineAt: Date.now() + 5000,
    restart: async () => { throw new Error("Unexpected restart"); }, observe: () => {}, capture, evidence,
  };
  for (const [file, content] of [["result.json", "{}"], ["snapshots/fixtures.json", "{}"], ["junit.xml", "<testsuites/>"], ["html-report/index.html", "fixture report"]]) await writeFile(join(privateDir, file!), content!);
  const blob = join(privateDir, "blob-report"); await writeFile(join(blob, "fixture.txt"), "unit fixture");
  execFileSync("zip", ["-q", "report.zip", "fixture.txt"], { cwd: blob });
  return { input, privateDir, uploadDir, snapshots, paths, capture, issue, run, secret };
}

describe("Pi native terminal evidence", () => {
  it("packages the actual successful native-question flow with durable API state and every event page", async () => {
    const f = await fixture();
    const result = await runPiNativeFlow(f.input);
    expect(result.checks).toHaveLength(15);
    expect(result.checks.every(check => check.passed)).toBe(true);
    const packaged = await packageEvidence({ privateDir: f.privateDir, uploadDir: f.uploadDir, secrets: [f.secret], expectPassScreenshot: true });
    expect(packaged.missing).toEqual([]); expect(packaged.leaks).toEqual([]);
    const raw = await readFile(join(f.uploadDir, "snapshots/api-state.json"), "utf8");
    expect(raw).not.toContain(f.secret);
    const state = JSON.parse(raw);
    expect(state.issue).toEqual(f.issue); expect(state.runs).toEqual([f.run]); expect(state.run).toEqual(f.run);
    expect(state.comments).toHaveLength(1); expect(state.comments[0].id).toBe("comment-fixture");
    expect(state.interactions).toHaveLength(4); expect(state.interactions.every((row: { status: string }) => row.status === "answered")).toBe(true);
    expect(state.runEventsByRun[0].runId).toBe(f.run.id);
    expect(state.runEventsByRun[0].events).toHaveLength(1001);
    expect(state.runEventsByRun[0].events.at(-1).seq).toBe(1001);
    expect(f.paths).toContain(`/api/heartbeat-runs/${f.run.id}/events?afterSeq=1000&limit=1000`);

    // The original failure remains a failure: Pi-specific evidence cannot
    // substitute for the mandatory generic terminal API snapshot.
    await rm(join(f.snapshots, "api-state.json"));
    const incomplete = await packageEvidence({ privateDir: f.privateDir, uploadDir: f.uploadDir, secrets: [f.secret], expectPassScreenshot: true });
    expect(incomplete.missing).toEqual(["snapshots/api-state.json"]);
  });

  it("fails capture when terminal API evidence is unavailable, retaining behavioral checks without declaring success", async () => {
    const f = await fixture({ failComments: true });
    await expect(runPiNativeFlow(f.input)).rejects.toThrow("fixture comments unavailable");
    const checks = JSON.parse(await readFile(join(f.snapshots, "pi-native-checks.json"), "utf8"));
    expect(checks.checks).toHaveLength(15);
    expect(checks.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
    expect(f.capture.mock.calls.some(([id]) => id === "final-state")).toBe(false);
    const packaged = await packageEvidence({ privateDir: f.privateDir, uploadDir: f.uploadDir, secrets: [f.secret], expectPassScreenshot: true });
    expect(packaged.missing).toEqual(["final-state.png", "snapshots/api-state.json"]);
  });
});
