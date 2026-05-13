import { describe, it, expect } from "vitest";
import { buildAgentJob } from "../../src/orchestrator/job.js";

const baseInput = {
  namespace: "paperclip-acme",
  agentId: "a-uuid", agentSlug: "a-acme",
  runId: "r-1", runUlid: "01HZZZ",
  companyId: "c-uuid", companySlug: "acme",
  adapterType: "claude_local",
  image: "ghcr.io/paperclipai/agent-runtime-claude:v1",
  initImage: "ghcr.io/paperclipai/agent-runtime-base:v1",
  imagePullSecrets: ["paperclip-image-pull"],
  pvcName: "agent-a-acme-workspace",
  envSecretName: "agent-a-acme-run-01HZZZ-env",
  activeDeadlineSeconds: 1800,
  ttlSecondsAfterFinished: 300,
  workspaceStrategyJson: '{"kind":"git-clone","url":"https://github.com/acme/repo.git","ref":"main"}',
  runtimeCommandSpecJson: '{"command":"claude","args":[]}',
  paperclipPublicUrl: "https://paperclip.example.com",
};

describe("buildAgentJob", () => {
  it("matches the golden snapshot", () => {
    expect(buildAgentJob(baseInput)).toMatchSnapshot();
  });

  it("sets backoffLimit=0 (Paperclip owns retries)", () => {
    expect(buildAgentJob(baseInput).spec?.backoffLimit).toBe(0);
  });

  it("sets activeDeadlineSeconds from input", () => {
    expect(buildAgentJob(baseInput).spec?.activeDeadlineSeconds).toBe(1800);
  });

  it("disables ServiceAccount token auto-mount", () => {
    const job = buildAgentJob(baseInput);
    expect(job.spec?.template.spec?.automountServiceAccountToken).toBe(false);
  });

  it("uses tini as PID 1 with paperclip-agent-shim as the args", () => {
    const main = buildAgentJob(baseInput).spec?.template.spec?.containers.find((c) => c.name === "agent");
    expect(main?.command).toEqual(["/usr/bin/tini", "--"]);
    expect(main?.args?.[0]).toBe("/usr/local/bin/paperclip-agent-shim");
  });

  it("agent container has restricted PSS context", () => {
    const main = buildAgentJob(baseInput).spec?.template.spec?.containers.find((c) => c.name === "agent");
    expect(main?.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(main?.securityContext?.readOnlyRootFilesystem).toBe(true);
    expect(main?.securityContext?.capabilities?.drop).toEqual(["ALL"]);
  });

  it("init container projects PAPERCLIP_WORKSPACE_REQUEST env (the name workspace-init reads)", () => {
    const init = buildAgentJob(baseInput).spec?.template.spec?.initContainers?.find((c) => c.name === "workspace-init");
    // The init container's binary, paperclip-workspace-init, reads
    // process.env.PAPERCLIP_WORKSPACE_REQUEST (see tools/workspace-init).
    // A mismatch here causes every real production run to fail at the init
    // container with "PAPERCLIP_WORKSPACE_REQUEST not set".
    expect(init?.env?.find((e) => e.name === "PAPERCLIP_WORKSPACE_REQUEST")?.value).toBe(baseInput.workspaceStrategyJson);
    expect(init?.env?.find((e) => e.name === "PAPERCLIP_WORKSPACE_STRATEGY")).toBeUndefined();
  });

  it("emits an imagePullSecrets entry when supplied", () => {
    const job = buildAgentJob(baseInput);
    expect(job.spec?.template.spec?.imagePullSecrets).toEqual([{ name: "paperclip-image-pull" }]);
  });

  it("mounts runtime-command.json where paperclip-agent-shim reads it", () => {
    const main = buildAgentJob(baseInput).spec?.template.spec?.containers.find((c) => c.name === "agent");
    expect(main?.volumeMounts).toContainEqual({
      name: "env",
      mountPath: "/run/paperclip/runtime-command.json",
      subPath: "runtime-command.json",
      readOnly: true,
    });
  });
});
