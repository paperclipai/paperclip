import { describe, it, expect } from "vitest";
import { buildJobManifest } from "../../src/pod-spec-builder.js";

const baseInput = {
  namespace: "paperclip-acme",
  jobName: "r-01h00000000000000000000000",
  adapterType: "claude_local",
  image: "ghcr.io/paperclipai/agent-runtime-claude:v1",
  envSecretName: "r-01h00000000000000000000000-env",
  serviceAccountName: "paperclip-tenant-sa",
  labels: { "paperclip.io/run-id": "r1" },
  resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "2", memory: "4Gi" } },
  runtimeClassName: undefined,
  activeDeadlineSec: 3600,
  ttlSecondsAfterFinished: 900,
};

describe("buildJobManifest", () => {
  it("returns a Job manifest with the correct apiVersion and kind", () => {
    const job = buildJobManifest(baseInput);
    expect(job.apiVersion).toBe("batch/v1");
    expect(job.kind).toBe("Job");
  });

  it("sets Job-level lifecycle controls: backoffLimit=0, ttlSecondsAfterFinished, activeDeadlineSeconds", () => {
    const job = buildJobManifest({ ...baseInput, activeDeadlineSec: 1800, ttlSecondsAfterFinished: 600 });
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.ttlSecondsAfterFinished).toBe(600);
    expect(job.spec.activeDeadlineSeconds).toBe(1800);
  });

  it("sets the security context to non-root, drop ALL caps, read-only rootFS, seccomp RuntimeDefault", () => {
    const job = buildJobManifest(baseInput);
    const podSec = job.spec.template.spec.securityContext;
    expect(podSec.runAsNonRoot).toBe(true);
    expect(podSec.runAsUser).toBe(1000);
    expect(podSec.fsGroupChangePolicy).toBe("OnRootMismatch");
    expect(podSec.seccompProfile.type).toBe("RuntimeDefault");

    const container = job.spec.template.spec.containers[0];
    expect(container.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
  });

  it("wraps the entrypoint in tini for PID 1", () => {
    const job = buildJobManifest(baseInput);
    const container = job.spec.template.spec.containers[0];
    expect(container.command).toEqual(["/usr/bin/tini", "--", "/usr/local/bin/paperclip-agent-shim"]);
  });

  it("declares explicit writable emptyDir mounts for the standard agent paths", () => {
    const job = buildJobManifest(baseInput);
    const mounts = job.spec.template.spec.containers[0].volumeMounts;
    const mountPaths = mounts.map((m: { mountPath: string }) => m.mountPath).sort();
    expect(mountPaths).toEqual(["/home/paperclip", "/home/paperclip/.cache", "/tmp", "/workspace"]);

    const volumes = job.spec.template.spec.volumes;
    expect(volumes.every((v: { emptyDir?: unknown }) => v.emptyDir !== undefined)).toBe(true);
  });

  it("envFrom references the per-run secret", () => {
    const job = buildJobManifest(baseInput);
    const envFrom = job.spec.template.spec.containers[0].envFrom;
    expect(envFrom[0].secretRef.name).toBe(baseInput.envSecretName);
  });

  it("applies runtimeClassName when set", () => {
    const job = buildJobManifest({ ...baseInput, runtimeClassName: "kata-fc" });
    expect(job.spec.template.spec.runtimeClassName).toBe("kata-fc");
  });

  it("does not set runtimeClassName when unset", () => {
    const job = buildJobManifest(baseInput);
    expect(job.spec.template.spec.runtimeClassName).toBeUndefined();
  });

  it("sets pod restartPolicy=Never (required for Job)", () => {
    const job = buildJobManifest(baseInput);
    expect(job.spec.template.spec.restartPolicy).toBe("Never");
  });

  it("disables automountServiceAccountToken to avoid exposing an unnecessary SA token", () => {
    const job = buildJobManifest(baseInput);
    expect(job.spec.template.spec.automountServiceAccountToken).toBe(false);
  });

  it("applies the provided labels to both Job metadata and pod template", () => {
    const job = buildJobManifest(baseInput);
    expect(job.metadata.labels["paperclip.io/run-id"]).toBe("r1");
    expect(job.spec.template.metadata.labels["paperclip.io/run-id"]).toBe("r1");
    expect(job.spec.template.metadata.labels["paperclip.io/role"]).toBe("agent");
  });
});
