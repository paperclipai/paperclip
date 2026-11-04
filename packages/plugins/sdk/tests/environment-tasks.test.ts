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

describe("stopped source reconciliation", () => {
  const recoveryPrepare = { ...prepare, accountIdentity: "selected-account", resumeFrom: "source-task", recoveryPurpose: "source_reconcile" };
  const recoverySubmit = { ...submit, accountIdentity: "selected-account", preparedLaunchId: "source-configuration", resumeFrom: "source-task", recoveryPurpose: "source_reconcile" };
  it("preserves the source purpose and existing source identity fields", () => {
    expect(environmentTaskOperationSchema.parse(recoveryPrepare)).toEqual(recoveryPrepare);
    expect(environmentTaskOperationSchema.parse(recoverySubmit)).toEqual(recoverySubmit);
    expect(environmentTaskResultSchema.parse({ kind: "description", taskId: "task", sourceRecoveryVersion: 1,
      runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` } })).toHaveProperty("sourceRecoveryVersion", 1);
  });
  it.each(["source", "account", "provider", "live-prior", "purpose"])("rejects invalid source preparation: %s", mode => {
    expect(environmentTaskOperationSchema.safeParse({ ...recoveryPrepare,
      ...(mode === "source" ? { resumeFrom: undefined } : {}),
      ...(mode === "account" ? { accountIdentity: undefined } : {}),
      ...(mode === "provider" ? { requirements: { ...prepare.requirements, provider: "acpx" } } : {}),
      ...(mode === "live-prior" ? { priorIdentity: prepare.requirements.identity } : {}),
      ...(mode === "purpose" ? { recoveryPurpose: "execution" } : {}),
    }).success).toBe(false);
  });
  it.each(["source", "account", "provider", "configuration", "launch", "purpose"])("rejects invalid source submission: %s", mode => {
    expect(environmentTaskOperationSchema.safeParse({ ...recoverySubmit,
      ...(mode === "source" ? { resumeFrom: undefined } : {}),
      ...(mode === "account" ? { accountIdentity: undefined } : {}),
      ...(mode === "provider" ? { runner: { ...submit.runner, harness: "claude" } } : {}),
      ...(mode === "configuration" ? { preparedLaunchId: undefined } : {}),
      ...(mode === "launch" ? { launch: undefined } : {}),
      ...(mode === "purpose" ? { recoveryPurpose: "execution" } : {}),
    }).success).toBe(false);
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
