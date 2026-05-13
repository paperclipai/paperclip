import type { V1Job } from "@kubernetes/client-node";

/**
 * Test-only helper that builds a minimal Job spec for the lifecycle integration
 * test. It mirrors the security context, labels and volume layout of
 * `buildAgentJob()` (PSS Restricted, workspace + tmp + env volumes, no
 * automount of the SA token), but swaps the agent-runtime images for busybox
 * and overrides the entrypoints with simple shell scripts.
 *
 * Purpose: prove the WIRING (PVC mount, ephemeral Secret env, log stream,
 * lifecycle, terminal-state mapping) against a real cluster without requiring
 * the agent-runtime images to be built/published. The agent-shim contract is
 * validated by the unit tests on `buildAgentJob()` and by Task 26's end-to-end
 * test.
 */
export interface BuildBusyboxTestJobInput {
  namespace: string;
  jobName: string;
  pvcName: string;
  envSecretName: string;
  /** Override the main container's command. Defaults to a quick "hello" + exit 0. */
  agentScript?: string;
  /** Override the init container's command. Defaults to a no-op echo. */
  initScript?: string;
  activeDeadlineSeconds?: number;
  /**
   * Override the main container's image. Defaults to `busybox:1.36`. Used by
   * the failure-modes test to inject a deliberately bogus image for the
   * ImagePullBackOff case.
   */
  image?: string;
  /**
   * Override the init container's image. Defaults to `busybox:1.36`. Same
   * rationale as `image` — lets the failure-modes test set a bogus init image
   * if needed.
   */
  initImage?: string;
  /**
   * Override the main container's `resources.limits.memory`. Defaults to
   * `64Mi`. Used by the OOMKilled test to drop the limit low enough that an
   * intentional allocation overshoots it.
   */
  memoryLimit?: string;
  /**
   * Override the main container's `resources.limits.cpu`. Defaults to `200m`.
   */
  cpuLimit?: string;
}

export function buildBusyboxTestJob(input: BuildBusyboxTestJobInput): V1Job {
  const restrictedSecurity = {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    seccompProfile: { type: "RuntimeDefault" as const },
  };
  const containerSecurity = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };

  const labels = { "paperclip.ai/test": "busybox-lifecycle" };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: input.jobName,
      namespace: input.namespace,
      labels,
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 30,
      activeDeadlineSeconds: input.activeDeadlineSeconds ?? 60,
      completions: 1,
      parallelism: 1,
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          terminationGracePeriodSeconds: 5,
          securityContext: restrictedSecurity,
          initContainers: [{
            name: "init",
            image: input.initImage ?? "busybox:1.36",
            command: ["sh", "-c", input.initScript ?? "ls -la /workspace; echo init-done"],
            volumeMounts: [
              { name: "workspace", mountPath: "/workspace" },
              { name: "tmp", mountPath: "/tmp" },
            ],
            securityContext: containerSecurity,
            resources: {
              requests: { cpu: "50m", memory: "32Mi" },
              limits: { cpu: "200m", memory: "64Mi" },
            },
          }],
          containers: [{
            name: "agent",
            image: input.image ?? "busybox:1.36",
            command: ["sh", "-c", input.agentScript ?? "echo hello from agent; sleep 1; exit 0"],
            volumeMounts: [
              { name: "workspace", mountPath: "/workspace" },
              { name: "tmp", mountPath: "/tmp" },
              { name: "env", mountPath: "/run/paperclip/env", readOnly: true },
            ],
            envFrom: [{ secretRef: { name: input.envSecretName } }],
            securityContext: containerSecurity,
            resources: {
              requests: { cpu: "50m", memory: "32Mi" },
              limits: {
                cpu: input.cpuLimit ?? "200m",
                memory: input.memoryLimit ?? "64Mi",
              },
            },
          }],
          volumes: [
            { name: "workspace", persistentVolumeClaim: { claimName: input.pvcName } },
            { name: "tmp", emptyDir: { sizeLimit: "64Mi" } },
            { name: "env", secret: { secretName: input.envSecretName, defaultMode: 0o400 } },
          ],
        },
      },
    },
  };
}
