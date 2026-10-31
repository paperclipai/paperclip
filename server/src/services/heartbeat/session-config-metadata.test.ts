import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiConnectionSessionCompatibilityInputs } from "../ai-connection-session.js";
import { prepareHeartbeatSession, type HeartbeatSessionPreparationInput } from "./session-preparation.js";
import { attachPaperclipSessionMetadataToSessionParams, buildEffectiveRunSessionConfigMetadata, createRunSessionConfigMetadataBuilder } from "./workspaces.js";

type MetadataInput = Parameters<typeof buildEffectiveRunSessionConfigMetadata>[0];

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "session-fingerprint-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

function input(config: Record<string, unknown> = {}): MetadataInput {
  return {
    adapterType: "paperclip_runner", effectiveAdapterConfig: config, agentRuntimeConfig: {}, issueOverrides: null,
    workspaceConfig: {}, environment: {}, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [],
  };
}

describe("attempt-local instruction fingerprint metadata", () => {
  it("reuses the read through real session preparation while restoring a legacy credential fingerprint", async () => {
    const file = path.join(root, "AGENTS.md");
    await fs.writeFile(file, "Session preparation instructions\n");
    const runtimeConfig = { instructionsRootPath: root, instructionsEntryFile: "AGENTS.md", model: "fixture-model",
      managedAiConnection: { mode: "responsible_user", identity: "credential" } };
    const preparation = {
      run: { createdAt: new Date() }, agent: { id: "agent", companyId: "company", adapterType: "paperclip_runner", runtimeConfig: {} },
      task: { context: {}, issueRef: null, issueContext: null, taskProjectContext: null, workspaceProjectContext: null,
        wakeCommentId: null, acceptedPlanContinuationWake: false, acceptedPlanWakeRoutingDecision: null },
      session: { taskSession: null, taskSessionDecodedParams: null, explicitResumeSessionParams: null,
        explicitResumeSessionDisplayId: null, sessionCodec: { deserialize: (value: Record<string, unknown> | null) => value } },
      config: { runtimeConfig, agentIdentity: undefined, issueAssigneeOverrides: null, originalAiIssueOverrides: null,
        managedAiRuntime: { identity: "credential", sessionIdentity: "credential:0" },
        aiBinding: { mode: "responsible_user", provider: "openai", method: "api_key" }, requestedAiBinding: undefined,
        secretManifest: [], runtimeSkillEntries: [], routineEnvContext: { env: null } },
      workspace: {}, environment: { environmentResolution: { source: "fixture" }, selectedEnvironmentId: null, selectedEnvironmentForConfig: null },
      getLatestAgentConfigRevision: async () => null,
    } as unknown as HeartbeatSessionPreparationInput;
    // This path needs no database queries: it uses the resolved account and saved session.
    const db = {} as Parameters<typeof prepareHeartbeatSession>[0];
    const previous = await prepareHeartbeatSession(db, preparation);
    preparation.config.runtimeConfig = { ...runtimeConfig, managedAiConnection: { ...runtimeConfig.managedAiConnection, sessionIdentity: "credential:0" } };
    preparation.session.taskSession = {
      id: "session", companyId: "company", agentId: "agent", adapterType: "paperclip_runner", taskKey: "task",
      sessionDisplayId: "saved-session", lastRunId: null, lastError: null, goalCapabilityJson: null, goalJson: null,
      goalStatus: null, goalDesiredState: null, goalSourceId: null, goalSourceCursor: null, goalRevision: 0,
      goalObservedAt: null, createdAt: new Date(), updatedAt: new Date(),
      sessionParamsJson: {
        ...attachPaperclipSessionMetadataToSessionParams({ sessionId: "saved-session" }, previous.configuredModel, previous.sessionConfigMetadata),
        paperclipAiCredentialIdentity: "credential",
      },
    };
    const reads = vi.spyOn(fs, "readFile");
    const resumed = await prepareHeartbeatSession(db, preparation);
    expect(resumed.sessionConfigMetadata.fingerprint).not.toBe(previous.sessionConfigMetadata.fingerprint);
    expect(resumed.resetTaskSession).toBe(false);
    expect(resumed.previousSessionParams).toMatchObject({ sessionId: "saved-session" });
    expect(reads.mock.calls.filter(([name]) => name === file)).toHaveLength(1);
    await fs.writeFile(file, "Changed instructions\n");
    expect((await prepareHeartbeatSession(db, preparation)).resetTaskSession).toBe(true);
    expect(reads.mock.calls.filter(([name]) => name === file)).toHaveLength(2);
  });

  it("hashes shared instructions once for concurrent AI compatibility candidates with identical fingerprints", async () => {
    const file = path.join(root, "AGENTS.md");
    await fs.writeFile(file, "Fixture instructions\n");
    const base = input({ instructionsRootPath: root, instructionsEntryFile: "AGENTS.md",
      managedAiConnection: { mode: "shared", identity: "credential", sessionIdentity: "credential:0" } });
    const candidates = aiConnectionSessionCompatibilityInputs({
      effectiveAdapterConfig: base.effectiveAdapterConfig, agentRuntimeConfig: {}, agentConfigRevision: null,
      issueOverrides: null, originalIssueOverrides: { model: "previous-model" },
      binding: { mode: "responsible_user", provider: "openai", method: "api_key" }, router: true,
      storedIdentity: "credential", sessionIdentity: "credential:0", credentialIdentity: "credential", revisions: [],
    });
    const inputs = [base, ...candidates.map(candidate => ({ ...base, ...candidate }))];
    expect(inputs.length).toBeGreaterThan(1);
    const reads = vi.spyOn(fs, "readFile");
    const expected = await Promise.all(inputs.map(buildEffectiveRunSessionConfigMetadata));
    expect(reads.mock.calls.filter(([name]) => name === file)).toHaveLength(inputs.length);
    reads.mockClear();
    const build = createRunSessionConfigMetadataBuilder();
    expect(await Promise.all(inputs.map(build))).toEqual(expected);
    expect(reads.mock.calls.filter(([name]) => name === file)).toHaveLength(1);
  });

  it("keeps distinct instruction paths, roots, entry files and bundle modes separate", async () => {
    await fs.writeFile(path.join(root, "AGENTS.md"), "Main instructions\n");
    await fs.writeFile(path.join(root, "OTHER.md"), "Other instructions\n");
    const configs = [
      { instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" },
      { instructionsRootPath: root, instructionsEntryFile: "OTHER.md" },
      { instructionsRootPath: root, instructionsFilePath: "AGENTS.md" },
      { instructionsRootPath: root, instructionsEntryFile: "AGENTS.md", instructionsBundleMode: "managed" },
      { instructionsRootPath: path.join(root, "missing"), instructionsEntryFile: "AGENTS.md" },
    ];
    const expected = await Promise.all(configs.map(config => buildEffectiveRunSessionConfigMetadata(input(config))));
    const build = createRunSessionConfigMetadataBuilder();
    expect(await Promise.all(configs.map(config => build(input(config))))).toEqual(expected);
    expect(await Promise.all(configs.map(config => build(input(config))))).toEqual(expected);
  });

  it("observes edited instructions in the next attempt and keeps standalone calls fresh", async () => {
    const file = path.join(root, "AGENTS.md");
    const config = input({ instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" });
    await fs.writeFile(file, "First revision\n");
    const first = await createRunSessionConfigMetadataBuilder()(config);
    await fs.writeFile(file, "Second revision\n");
    const second = await createRunSessionConfigMetadataBuilder()(config);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second).toEqual(await buildEffectiveRunSessionConfigMetadata(config));
    await fs.writeFile(file, "Third revision\n");
    expect((await buildEffectiveRunSessionConfigMetadata(config)).fingerprint).not.toBe(second.fingerprint);
  });

  it("does not reuse an unreadable result after a later attempt restores the file", async () => {
    const config = input({ instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" });
    const missing = await createRunSessionConfigMetadataBuilder()(config);
    expect(missing).toEqual(await buildEffectiveRunSessionConfigMetadata(config));
    await fs.writeFile(path.join(root, "AGENTS.md"), "Restored instructions\n");
    expect((await createRunSessionConfigMetadataBuilder()(config)).fingerprint).not.toBe(missing.fingerprint);
  });

  it("preserves root-bound rejection and does no file reads for unconfigured instructions", async () => {
    const reads = vi.spyOn(fs, "readFile");
    const build = createRunSessionConfigMetadataBuilder();
    const configs = [
      {}, { instructionsFilePath: path.join(root, "AGENTS.md") },
      { instructionsRootPath: root, instructionsEntryFile: "../outside.md" },
      { instructionsRootPath: "relative", instructionsEntryFile: "AGENTS.md" },
    ];
    for (const config of configs) expect(await build(input(config))).toEqual(await buildEffectiveRunSessionConfigMetadata(input(config)));
    expect(reads).not.toHaveBeenCalled();
  });
});
