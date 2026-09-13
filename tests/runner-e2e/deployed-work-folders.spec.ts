import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { EnvironmentCapabilities } from "../../packages/shared/src/environment-support.js";
import type { SandboxWorkFolderManifest, WorkFolderSyncStatus } from "../../packages/shared/src/work-folders.js";
import { QUALIFIED_ACPX_RUNNER_MODELS } from "../../server/src/services/native-runtime/provider-profile.js";
import { pollUntil } from "./api.js";
import { DeployedStackApi, deployedAgentEngine, findDeployedWorkFile, loadDeployedStack } from "./deployed-stack.js";

import { repoAcceptancePrompt } from "./work-folder-acceptance-prompts.js";

const stack = loadDeployedStack();
const api = new DeployedStackApi(stack);
const folder = (scope: string, ownerId: string) => `/api/companies/${stack.companyId}/work-folders/${scope}/${encodeURIComponent(ownerId)}`;
test.beforeAll(async () => {
  const health = await api.json<{ commit: string }>("/api/health");
  expect(health.commit, "Only exercise the declared deployed candidate").toBe(stack.commit);
  const identity = await api.json<{ userId: string; companyIds: string[] }>("/api/cli-auth/me");
  expect(identity.userId, "The board token must belong to the manifest's responsible user").toBe(stack.userId);
  expect(identity.companyIds, "The board token must have access to the acceptance company").toContain(stack.companyId);
});

test("deployed candidate and complete supported adapter inventory", async ({}, info) => {
  const health = await api.json<{ commit: string }>("/api/health");
  expect(health.commit).toBe(stack.commit);
  const capabilities = await api.json<EnvironmentCapabilities>(`/api/companies/${stack.companyId}/environments/capabilities`);
  expect(capabilities.sandboxProviders.daytona?.supportsRunExecution).toBe(true);
  const adapters = await api.json<Array<{ type: string; disabled: boolean; capabilities: { supportsAcp: boolean } }>>("/api/adapters");
  const required: string[] = [];
  const excluded = new Set(stack.excludedAdapters?.map((entry) => entry.adapterType));
  for (const adapter of adapters.filter((entry) => !entry.disabled && !excluded.has(entry.type))) {
    if (capabilities.adapters.find((entry) => entry.adapterType === adapter.type)?.drivers.sandbox !== "supported") continue;
    if (adapter.type === "paperclip_runner") {
      required.push("paperclip_runner:codex", "paperclip_runner:opencode",
        ...Object.keys(QUALIFIED_ACPX_RUNNER_MODELS).map((name) => `paperclip_runner:acpx:${name}`));
    } else {
      required.push(`${adapter.type}:cli`);
      if (adapter.capabilities.supportsAcp) required.push(`${adapter.type}:acp`);
    }
  }
  const configured = new Set<string>();
  for (const profile of stack.profiles) {
    const agent = await api.json<{ adapterType: string; adapterConfig: Record<string, unknown> }>(`/api/agents/${profile.agentId}`);
    expect(agent.adapterType).toBe(profile.adapterType);
    expect(agent.adapterConfig.model).toBe(profile.model);
    const engine = deployedAgentEngine(agent);
    expect(engine, `${profile.id} must exercise its declared live engine`).toBe(profile.engine);
    configured.add(`${agent.adapterType}:${engine}`);
  }
  expect(required.filter((key) => !configured.has(key)), "Every exposed sandbox adapter/engine requires a qualified fixture").toEqual([]);
  await info.attach("deployed-candidate-and-inventory", { contentType: "application/json", body: Buffer.from(JSON.stringify({ stack, required }, null, 2)) });
});

for (const [scope, owner] of [["task", stack.taskId], ["agent", stack.agentId], ["project", stack.projectId], ["user", stack.userId]]) {
  test(`${scope} nested empty executable files, retry, trash and restoration`, async () => {
    const base = folder(scope!, owner!);
    const filename = `acceptance/${randomUUID()}/empty.sh`;
    const key = randomUUID();
    const write = () => api.request(`${base}/content?path=${encodeURIComponent(filename)}`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-File-Executable": "true", "Idempotency-Key": key }, body: "",
    });
    expect((await write()).ok).toBe(true);
    expect((await write()).ok).toBe(true);
    const file = (await findDeployedWorkFile(api, base, filename))!;
    expect(file).toMatchObject({ byteSize: 0, executable: true, deletedAt: null });
    const download = await api.request(`${base}/content?path=${encodeURIComponent(filename)}`);
    expect(download.status).toBe(200); expect((await download.arrayBuffer()).byteLength).toBe(0);
    await api.json(`${base}/operations`, "POST", { action: "delete", path: filename });
    expect((await api.request(`${base}/content?path=${encodeURIComponent(filename)}`)).status).toBe(404);
    expect((await findDeployedWorkFile(api, base, filename, true))?.id).toBe(file.id);
    await api.json(`${base}/operations`, "POST", { action: "restore", fileId: file.id });
    expect((await api.request(`${base}/content?path=${encodeURIComponent(filename)}`)).status).toBe(200);
  });
}


for (const profile of stack.profiles) {
  test(`${profile.id} preserves task-specific repo and file state across cold and warm runs`, async ({}, info) => {
    test.setTimeout(1_800_000);
    const nonce = randomUUID();
    const issue = await api.json<{ id: string; identifier: string }>(`/api/companies/${stack.companyId}/issues`, "POST", {
      title: `Work folder acceptance ${profile.id} ${nonce}`, projectId: stack.projectId,
      assigneeAgentId: profile.agentId, status: "todo",
      description: repoAcceptancePrompt(nonce, false),
    });
    await info.attach("task", { contentType: "application/json", body: Buffer.from(JSON.stringify({ profile: profile.id, ...issue })) });
    const base = folder("task", issue.id);
    const cold = await pollUntil({ label: `${profile.id} completed run and durable task file`, deadlineAt: Date.now() + 840_000,
      intervalMs: 5_000,
      load: async () => ({ issue: await api.json<{ status: string }>(`/api/issues/${issue.id}`),
        saves: await api.json<WorkFolderSyncStatus[]>(`${base}/sync`) }),
      accept: (state) => state.issue.status === "done" && state.saves.some((save) => !save.active && save.state === "saved" && save.lastSavedAt !== null),
      reject: (state) => state.saves.some((save) => save.state === "failed") ? "Work-folder save failed"
        : state.issue.status === "blocked" || state.issue.status === "cancelled" ? `Task ${issue.identifier} ended ${state.issue.status}` : undefined,
    });
    const content = await api.request(`${base}/content?path=acceptance.txt`);
    expect(content.status).toBe(200); expect(await content.text()).toBe(nonce);
    const coldRunIds = new Set(cold.saves.map((save) => save.runId));
    const coldSave = cold.saves.find((save) => !save.active && save.state === "saved")!;
    const coldRun = await api.json<{ status: string; contextSnapshot: { paperclipWorkFolders: SandboxWorkFolderManifest } }>(`/api/heartbeat-runs/${coldSave.runId}`);
    expect(coldRun.status, "A saved checkpoint must not hide a failed adapter run").toBe("succeeded");
    const coldManifest = coldRun.contextSnapshot.paperclipWorkFolders;
    expect(coldManifest.sandboxKey).toBeTruthy();
    const owners = {task: issue.id, agent: profile.agentId, user: stack.userId, project: stack.projectId};
    expect(coldManifest.responsibleUserId).toBe(stack.userId);
    for (const [scope, owner] of Object.entries(owners)) {
      const scoped = folder(scope, owner);
      const read = await api.request(`${scoped}/content?path=${encodeURIComponent(`roundtrip-${nonce}/message.txt`)}`);
      expect(read.status, `${profile.id} ${scope} durable bytes`).toBe(200);
      expect(await read.text()).toBe(nonce);
      expect(await findDeployedWorkFile(api, scoped, `roundtrip-${nonce}/empty.sh`)).toMatchObject({byteSize:0, executable:true});
    }

    await api.json(`/api/issues/${issue.id}`, "PATCH", { status: "todo", description: repoAcceptancePrompt(nonce, true) });
    const warm = await pollUntil({ label: `${profile.id} warm run preserves saved work`, deadlineAt: Date.now() + 840_000,
      intervalMs: 5_000,
      load: async () => ({ issue: await api.json<{ status: string }>(`/api/issues/${issue.id}`),
        saves: (await api.json<WorkFolderSyncStatus[]>(`${base}/sync`)).filter((save) => !coldRunIds.has(save.runId)) }),
      accept: (state) => state.issue.status === "done" && state.saves.some((save) => !save.active && save.state === "saved" && save.lastSavedAt !== null),
      reject: (state) => state.saves.some((save) => save.state === "failed") ? "Warm save failed"
        : ["blocked", "cancelled"].includes(state.issue.status) ? `Warm task ended ${state.issue.status}` : undefined,
    });
    const warmContent = await api.request(`${base}/content?path=warm.txt`);
    expect(warmContent.status).toBe(200); expect(await warmContent.text()).toBe(nonce);
    const warmSave = warm.saves.find((save) => !save.active && save.state === "saved")!;
    const warmRun = await api.json<{ status: string; contextSnapshot: { paperclipWorkFolders: SandboxWorkFolderManifest } }>(`/api/heartbeat-runs/${warmSave.runId}`);
    expect(warmRun.status, "The warm adapter run must also succeed").toBe("succeeded");
    const warmManifest = warmRun.contextSnapshot.paperclipWorkFolders;
    expect(warmManifest.sandboxKey, "Warm acceptance requires the same physical sandbox").toBe(coldManifest.sandboxKey);
    await info.attach("cold-and-warm-checkpoints", { contentType: "application/json", body: Buffer.from(JSON.stringify({ cold: cold.saves, warm: warm.saves, coldManifest, warmManifest })) });
  });
}

test("saves during two real 180-second intervals and flushes the final edit", async ({}, info) => {
  const profile = stack.profiles.find((entry) => entry.id === "legacy-codex")!;
  const nonce = randomUUID();
  const issue = await api.json<{ id: string; identifier: string }>(`/api/companies/${stack.companyId}/issues`, "POST", {
    title: `Real checkpoint intervals ${nonce}`, projectId: stack.projectId, assigneeAgentId: profile.agentId, status: "todo",
    description: [
      "Run a real timed persistence acceptance test. Execute the following shell sequence and wait for it to finish, keeping this task in progress throughout both sleeps. Use a tool timeout of at least 420 seconds, or poll its session until it exits. Do not shorten either sleep or mark the task complete early.",
      `printf '${nonce}:one' > "$HOME/task/interval.txt"; sleep 190; printf '${nonce}:two' > "$HOME/task/interval.txt"; sleep 190; printf '${nonce}:final' > "$HOME/task/interval.txt"`,
      "After the command exits successfully, complete the task. Do not print credentials.",
    ].join("\n"),
  });
  await info.attach("task", { contentType: "application/json", body: Buffer.from(JSON.stringify(issue)) });
  const base = folder("task", issue.id);
  const observations: Array<{ observedAt: string; phase: string; saves: WorkFolderSyncStatus[] }> = [];
  for (const phase of ["one", "two", "final"]) {
    const snapshot = await pollUntil({ label: `durable interval ${phase}`, deadlineAt: Date.now() + (phase === "one" ? 840_000 : 300_000), intervalMs: 3_000,
      load: async () => {
        const response = await api.request(`${base}/content?path=interval.txt`);
        return { content: response.ok ? await response.text() : null, saves: await api.json<WorkFolderSyncStatus[]>(`${base}/sync`),
          issue: await api.json<{ status: string }>(`/api/issues/${issue.id}`) };
      },
      accept: (state) => state.content === `${nonce}:${phase}` && state.saves.some((save) => save.state === "saved" && save.lastSavedAt !== null && save.active === (phase !== "final")),
      reject: (state) => state.saves.some((save) => save.state === "failed") ? "Timed checkpoint failed"
        : ["blocked", "cancelled"].includes(state.issue.status) ? `Timed task ended ${state.issue.status}` : undefined,
    });
    observations.push({ observedAt: new Date().toISOString(), phase, saves: snapshot.saves });
  }
  const first = observations[0]!.saves.find((save) => save.active)!;
  const second = observations[1]!.saves.find((save) => save.runId === first.runId)!;
  // Upload duration varies; completion times do not measure the timer cadence.
  // The host records checkpoint intent before transferring any files.
  const activity = await api.json<Array<{ action: string; runId: string | null; createdAt: string }>>(
    `/api/companies/${stack.companyId}/activity?entityType=heartbeat_run&entityId=${first.runId}&limit=100`,
  );
  const starts = activity.filter((entry) => entry.action === "work_folder.checkpoint" && entry.runId === first.runId)
    .map((entry) => Date.parse(entry.createdAt)).sort((a, b) => a - b);
  await info.attach("real-checkpoint-intervals", { contentType: "application/json", body: Buffer.from(JSON.stringify({ observations, starts }, null, 2)) });
  expect(starts.length).toBeGreaterThanOrEqual(3);
  expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(179_000);
  expect(starts[1]! - starts[0]!).toBeLessThan(210_000);
  expect(starts[0]!).toBeLessThanOrEqual(Date.parse(first.lastSavedAt!));
  expect(starts[1]!).toBeLessThanOrEqual(Date.parse(second.lastSavedAt!));
});
