import {describe,expect,it} from "vitest";
import {environmentTaskOperationSchema,environmentTaskResultSchema} from "../src/environment-tasks.js";
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

describe("retained source launch fields", () => {
  it("uses the existing source identity and resume reference without a recovery mode", () => {
    for (const operation of [prepare, submit]) {
      const recovery = { ...operation, accountIdentity: "selected-account", resumeFrom: "source-task" };
      expect(environmentTaskOperationSchema.parse(recovery)).toEqual(recovery);
      expect(environmentTaskOperationSchema.safeParse({ ...recovery, recoveryPurpose: "source_reconcile" }).success).toBe(false);
    }
  });
});

describe("provider-specific source recovery capability", () => {
  const description = { kind: "description", taskId: "task", runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` } };
  it.each(["codexSourceRecoveryVersion", "acpxSourceRecoveryVersion"] as const)("accepts %s independently", key => {
    const advertised = { ...description, [key]: 1 };
    expect(environmentTaskResultSchema.parse(advertised)).toEqual(advertised);
    expect(environmentTaskResultSchema.safeParse({ ...description, [key]: 2 }).success).toBe(false);
  });
  it("accepts both or neither and rejects an unqualified recovery flag", () => {
    const both = { ...description, codexSourceRecoveryVersion: 1, acpxSourceRecoveryVersion: 1 };
    expect(environmentTaskResultSchema.parse(both)).toEqual(both);
    expect(environmentTaskResultSchema.parse(description)).toEqual(description);
    expect(environmentTaskResultSchema.safeParse({ ...description, sourceRecoveryVersion: 1 }).success).toBe(false);
  });
});

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

describe("configured environment", () => {
  const configured = { ...submit, configuredEnvironment: { STRIPE_SECRET_KEY: "fixture-value", EMPTY_OK: "" } };
  it("accepts bounded variables on submit and on a handoff resume", () => {
    expect(environmentTaskOperationSchema.parse(configured)).toEqual(configured);
    const identity = { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run", normalizedSessionId: "session", turnId: "turn", itemId: "item" };
    const resume = { kind: "resume", identity, bootstrapTicket: "synthetic", configuredEnvironment: { A: "1" } };
    expect(environmentTaskOperationSchema.parse(resume)).toEqual(resume);
  });
  it.each([
    ["an invalid name", { "1BAD": "x" }],
    ["a dashed name", { "BAD-NAME": "x" }],
    ["a NUL byte", { GOOD: "a\0b" }],
    ["too many variables", Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`K${index}`, "x"]))],
    ["an oversized value", { BIG: "x".repeat(65_536) }],
    ["an oversized total", Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`K${index}`, "x".repeat(60_000)]))],
  ])("rejects %s", (_label, configuredEnvironment) => {
    expect(environmentTaskOperationSchema.safeParse({ ...configured, configuredEnvironment }).success).toBe(false);
  });
  it("has no digest field", () => {
    expect(environmentTaskOperationSchema.safeParse({ ...configured, configuredEnvironmentDigest: `hmac-sha256:${"b".repeat(64)}` }).success).toBe(false);
  });
  it("lets a provider advertise support", () => {
    const description = { kind: "description", taskId: "task", runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` }, configuredEnvironmentVersion: 1 };
    expect(environmentTaskResultSchema.parse(description)).toEqual(description);
    expect(environmentTaskResultSchema.safeParse({ ...description, configuredEnvironmentVersion: 2 }).success).toBe(false);
  });
});
