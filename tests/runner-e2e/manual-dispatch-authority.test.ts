import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeManualDispatch } from "./manual-dispatch-authority.js";

const ids = ["activity.agent-feedback", "agents.choose-primary"].map(id => `chat-features.runner-opencode.local.${id}`);
const workflowSha = "a".repeat(40), targetSha = "b".repeat(40);
const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  PAPERCLIP_MANUAL_DISPATCH_AUTHORITY: "v1", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "paperclipai/paperclip", GITHUB_REF: "refs/heads/master",
  GITHUB_WORKFLOW_REF: "paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/master",
  GITHUB_SHA: workflowSha, TARGET_SHA: targetSha, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
  GITHUB_ACTOR: "owner", GITHUB_TRIGGERING_ACTOR: "owner", GITHUB_ACTOR_ID: "42",
  MANUAL_DISPATCH_ALLOWED_ACTOR_IDS: "[42,7]", MANUAL_PRIVATE_IDS: JSON.stringify(ids), ...overrides,
});
const event = (overrides: Record<string, unknown> = {}, inputs: Record<string, unknown> = {}) => ({
  ref: "refs/heads/master", sender: { id: 42 }, repository: { full_name: "paperclipai/paperclip", default_branch: "master" },
  inputs: { cadence: "manual", target_branch: "candidate", id: ids.join(","), ...inputs }, ...overrides,
});

describe("authorizeManualDispatch", () => {
  it("authorizes an allowlisted operator's manual dispatch for exactly its own cells", () => {
    const authority = authorizeManualDispatch(env(), event());
    expect(authority).toMatchObject({ workflowSha, targetSha, runId: "123", attempt: "1", launchBinding: "dispatcher", private: true });
    expect(authority.executionIds).toHaveLength(2);
    expect(authority.approvalSha256).toMatch(/^[a-f0-9]{64}$/);
    // Every job of the run derives the same identity.
    expect(authorizeManualDispatch(env(), event()).approvalSha256).toBe(authority.approvalSha256);
  });

  it.each([
    ["a scheduled run", env({ GITHUB_EVENT_NAME: "schedule" }), event()],
    ["a bounded cadence", env(), event({}, { cadence: "daily" })],
    ["an operator outside the allowlist", env({ GITHUB_ACTOR_ID: "99" }), event({ sender: { id: 99 } })],
    ["an empty allowlist", env({ MANUAL_DISPATCH_ALLOWED_ACTOR_IDS: "[]" }), event()],
    ["a rerun by another person", env({ GITHUB_TRIGGERING_ACTOR: "someone-else" }), event()],
    ["a second attempt", env({ GITHUB_RUN_ATTEMPT: "2" }), event()],
    ["a non-default workflow ref", env({ GITHUB_WORKFLOW_REF: "paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/feature" }), event()],
    ["a different workflow", env({ GITHUB_WORKFLOW_REF: "paperclipai/paperclip/.github/workflows/other.yml@refs/heads/master" }), event()],
    ["a sender who is not the actor", env(), event({ sender: { id: 7 } })],
    ["a missing target commit", env({ TARGET_SHA: "" }), event()],
    ["the authority switch unset", env({ PAPERCLIP_MANUAL_DISPATCH_AUTHORITY: undefined }), event()],
  ])("rejects %s", (_label, environment, payload) => {
    expect(() => authorizeManualDispatch(environment, payload)).toThrow();
  });

  it("rejects cells that differ from the dispatch's own selection", () => {
    expect(() => authorizeManualDispatch(env(), event({}, { id: ids[0] }))).toThrow(/differ/);
    expect(() => authorizeManualDispatch(env({ MANUAL_PRIVATE_IDS: JSON.stringify([ids[0]]) }), event())).toThrow(/differ/);
  });

  it("keeps the per-run cell limit", () => {
    const many = ["activity.agent-feedback", "activity.work-timeline", "companies.import-preview", "navigation-preferences.dismiss-announcement",
      "tasks.completion-with-gate", "tasks.private-task", "secrets.personal-secret", "agents.choose-primary", "access.cli-authorization"]
      .map(id => `chat-features.runner-opencode.local.${id}`);
    expect(() => authorizeManualDispatch(env({ MANUAL_PRIVATE_IDS: JSON.stringify(many) }), event({}, { id: many.join(",") }))).toThrow(/limit/);
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("actual prepare admits a dispatched cell without a stored approval and records the target launcher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-dispatch-prepare-")); roots.push(root);
  const target = path.join(root, "target"), modules = path.join(target, "tests/runner-e2e"); await mkdir(modules, { recursive: true });
  await writeFile(path.join(modules, "launch.ts"), "synthetic candidate launcher; never executed");
  for (const name of ["manual-private-handoff.ts", "manual-private-retention.ts", "manual-private-report-assets.ts"]) await copyFile(path.join(import.meta.dirname, name), path.join(modules, name));
  const eventPath = path.join(root, "event.json"), output = path.join(root, "outputs.txt");
  await writeFile(eventPath, JSON.stringify(event()));
  const trusted = path.resolve(import.meta.dirname, "../.."), require = createRequire(import.meta.url), tsx = require.resolve("tsx", { paths: [path.join(trusted, "server")] });
  const run = (extra: Record<string, string>) => spawnSync(process.execPath, ["--import", tsx, path.join(import.meta.dirname, "manual-private-transfer.ts"), "prepare"], {
    encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH, NODE_OPTIONS: "", NODE_PATH: "", ...env(), SELECTED_EXECUTION_ID: ids[0]!, GITHUB_EVENT_PATH: eventPath,
      TARGET_ROOT: target, RUNNER_TEMP: root, RUNNER_E2E_PRIVATE_HISTORY_S3_BUCKET: "private-bucket", GITHUB_OUTPUT: output, ...extra } as NodeJS.ProcessEnv,
  });
  const denied = run({ GITHUB_ACTOR_ID: "99" });
  expect(denied.status).toBe(1);
  await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  const admitted = run({});
  expect(admitted.error).toBeUndefined(); expect(admitted.status).toBe(0);
  const outputs = await readFile(output, "utf8");
  expect(outputs).toContain("session_policy=");
  const identityRoot = outputs.split("\n").find(line => line.startsWith("root="))!.slice(5);
  const identity = JSON.parse(await readFile(path.join(identityRoot, "identity.json"), "utf8"));
  expect(identity).toMatchObject({ launchBinding: "dispatcher", runId: "123", targetSha, executionIds: [ids[0]] });
  expect(identity.launchSha256).toMatch(/^[a-f0-9]{64}$/);
});
