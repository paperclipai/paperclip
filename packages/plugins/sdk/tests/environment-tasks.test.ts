import {describe,expect,it} from "vitest";
import { environmentTaskOperationSchema, environmentTaskResultSchema, environmentTaskCredentialSchema, environmentRunnerHarnessLaunchProfileSchema } from "../src/environment-tasks.js";
const submit={kind:"submit",projectIds:[],bootstrapTicket:"synthetic",runner:{harness:"codex",protocolMin:1,protocolMax:3,runnerId:"runner",leaseId:"lease",runId:"run",sessionId:"session",turnId:"turn",itemId:"item"},
 launch:{runnerVersion:"fixture",runnerDigest:`sha256:${"a".repeat(64)}`,maxOutboxBytes:262144,p0ReserveBytes:65536,lifecyclePolicy:{mode:"warm",idleTimeoutMs:300000}}};
describe("task lifecycle policy",()=>{
 it("accepts bounded warm policy and the existing per-turn policy",()=>{
  expect(environmentTaskOperationSchema.parse(submit)).toEqual(submit);
  expect(environmentTaskOperationSchema.safeParse({...submit,launch:{...submit.launch,lifecyclePolicy:{mode:"per_turn",idleTimeoutMs:null}}}).success).toBe(true);
 });
 it.each([0,-1,86400001,null,1.5])("rejects invalid warm idle timeout %s",idleTimeoutMs=>{
  expect(environmentTaskOperationSchema.safeParse({...submit,launch:{...submit.launch,lifecyclePolicy:{mode:"warm",idleTimeoutMs}}}).success).toBe(false);
 });
});


const prepare = {
  kind: "prepare", projectIds: [], requirements: {
    schema: "paperclip.runner.launch-requirements.v1",
    identity: { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
      normalizedSessionId: "session", turnId: "turn", itemId: "item" },
    provider: "codex", model: "selected-model", instructions: "Verify the selected account.",
    runtimeContext: null, settings: {}, approvalPolicy: "never", readOnly: true,
    preparedConversation: false, includeCollaborationModeInstructions: false,
  },
};

describe("task hosted search restriction", () => {
  it("preserves Core's explicit restriction through plugin launch preparation", () => {
    const operation = { ...prepare, requirements: { ...prepare.requirements,
      settings: { disableCodexWebSearch: true } } };
    expect(environmentTaskOperationSchema.parse(operation)).toEqual(operation);
  });

  it("keeps the provider default when the restriction is absent", () => {
    expect(environmentTaskOperationSchema.parse(prepare)).toEqual(prepare);
  });

  it.each([false, null, 0, "true", "disabled"])("rejects a non-restricting flag value %s", disableCodexWebSearch => {
    expect(environmentTaskOperationSchema.safeParse({ ...prepare, requirements: { ...prepare.requirements,
      settings: { disableCodexWebSearch } } }).success).toBe(false);
  });

  it("continues rejecting unreviewed launch settings", () => {
    expect(environmentTaskOperationSchema.safeParse({ ...prepare, requirements: { ...prepare.requirements,
      settings: { disableCodexWebSearch: true, hostedSearchBillingMode: "unmetered" } } }).success).toBe(false);
  });
});

describe("Codex probe project-instruction policy", () => {
  it("preserves explicit suppression alongside the hosted-search restriction", () => {
    const operation = { ...prepare, requirements: { ...prepare.requirements,
      settings: { disableCodexProjectInstructions: true, disableCodexWebSearch: true } } };
    expect(environmentTaskOperationSchema.parse(operation)).toEqual(operation);
  });
  it.each([false, null, 0, "true"])("rejects an invalid suppression value %s", disableCodexProjectInstructions => {
    expect(environmentTaskOperationSchema.safeParse({ ...prepare, requirements: { ...prepare.requirements,
      settings: { disableCodexProjectInstructions } } }).success).toBe(false);
  });
});

describe("implementation-independent GitHub credential broker", () => {
  it("accepts capability data without an executable, script, or filesystem path", () => {
    const operation = { ...prepare, githubBroker: { url: "https://core.example.test/api", token: "runtime-capability" } };
    expect(environmentTaskOperationSchema.parse(operation)).toEqual(operation);
  });
  it.each(["invalid", "file:///tmp/broker", "https://user:password@core.example.test", "https://core.example.test?token=secret"])("rejects broker transport %s", url => {
    expect(environmentTaskOperationSchema.safeParse({ ...prepare, githubBroker: { url, token: "runtime-capability" } }).success).toBe(false);
  });
  it("rejects executable delivery as part of this contract", () => {
    expect(environmentTaskOperationSchema.safeParse({ ...prepare, githubBroker: {
      url: "https://core.example.test", token: "runtime-capability", script: "run-this" } }).success).toBe(false);
  });
});

describe("external native harness execution", () => {
  const identity = { harnessId: "example.native/synthetic", packageName: "@example/plugin-harness", version: "1.0.0",
    integrity: `sha256-${Buffer.alloc(32, 1).toString("base64")}`, protocolVersion: 1, runtimeDigest: `sha256:${"a".repeat(64)}` };
  const profile = { schema: "paperclip.harness-launch.v1", identity,
    command: { path: "/runtime/node", sha256: `sha256:${"b".repeat(64)}` },
    entrypoint: { path: "/runtime/package/main.js", sha256: `sha256:${"c".repeat(64)}` }, args: [], environmentKeys: ["SYNTHETIC_API_KEY"] };

  it("preserves admitted release, configuration, capabilities and prepared runtime authority", () => {
    const operation = { ...prepare, requirements: { ...prepare.requirements, provider: "extension",
      settings: { extensionRelease: identity, extensionConfig: { mode: "coding" }, extensionCapabilities: { interruption: true }, extensionCheckpoint: null } } };
    expect(environmentTaskOperationSchema.parse(operation)).toEqual(operation);
    const prepared = { kind: "prepared", taskId: "task", launch: { configurationId: "config", requirementsDigest: `sha256:${"d".repeat(64)}`,
      provider: { kind: "extension", release: identity }, extensionLaunchProfile: profile } };
    expect(environmentTaskResultSchema.parse(prepared)).toEqual(prepared);
    const submitted = { ...submit, runner: { ...submit.runner, harness: identity.harnessId },
      launch: { ...submit.launch, extensionLaunchProfile: profile },
      credential: { type: "harness-env", harnessId: identity.harnessId, environment: { SYNTHETIC_API_KEY: "synthetic" } } };
    expect(environmentTaskOperationSchema.parse(submitted)).toEqual(submitted);
  });

  it("requires package admission and keeps extension fields out of built-in provider settings", () => {
    expect(environmentTaskOperationSchema.safeParse({ ...prepare, requirements: { ...prepare.requirements, provider: "extension" } }).success).toBe(false);
    expect(environmentTaskOperationSchema.safeParse({ ...prepare, requirements: { ...prepare.requirements,
      settings: { extensionRelease: identity } } }).success).toBe(false);
    expect(environmentRunnerHarnessLaunchProfileSchema.safeParse({ ...profile, identity: { ...identity, protocolVersion: 2 } }).success).toBe(false);
    expect(environmentRunnerHarnessLaunchProfileSchema.safeParse({ ...profile, command: { ...profile.command, path: "relative-node" } }).success).toBe(false);
  });

  it.each(["PATH", "HOME", "NODE_OPTIONS", "PAPERCLIP_API_KEY", "LD_PRELOAD", "GIT_CONFIG_COUNT"])("rejects process-control credential key %s", key => {
    expect(environmentTaskCredentialSchema.safeParse({ type: "harness-env", harnessId: identity.harnessId, environment: { [key]: "synthetic" } }).success).toBe(false);
    expect(environmentRunnerHarnessLaunchProfileSchema.safeParse({ ...profile, environmentKeys: [key] }).success).toBe(false);
  });

  it("advertises support explicitly while preserving older environment descriptions", () => {
    const description = { kind: "description", taskId: "task", runner: { version: "1.0.0", digest: `sha256:${"a".repeat(64)}` } };
    expect(environmentTaskResultSchema.parse(description)).toEqual(description);
    expect(environmentTaskResultSchema.parse({ ...description, harnessExtensionVersion: 1 })).toHaveProperty("harnessExtensionVersion", 1);
    expect(environmentTaskResultSchema.safeParse({ ...description, harnessExtensionVersion: 2 }).success).toBe(false);
  });
});
