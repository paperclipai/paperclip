/**
 * Builds a kubernetes-sigs/agent-sandbox Sandbox CR manifest.
 *
 * The Sandbox CR creates a long-lived pod (sleep infinity entrypoint) into
 * which paperclip-server can exec arbitrary commands. This solves the
 * architectural mismatch with the batch/v1 Job backend, which only supports
 * a single one-shot entrypoint — not the multi-command adapter-install pattern
 * used by paperclip-server.
 *
 * Security baseline is identical to buildJobManifest (pod-spec-builder.ts):
 * non-root, drop ALL caps, read-only rootFS, Tini PID 1, seccomp
 * RuntimeDefault, fsGroupChangePolicy OnRootMismatch, automountSAToken=false.
 *
 * NOTE: paperclip-server runs OUTSIDE the cluster, so we cannot set ownerReferences
 * on the Sandbox CR (the owner would need to be an in-cluster resource). The
 * release path is explicit delete via sandboxCrOrchestrator.release().
 */

export interface BuildSandboxCrManifestInput {
  namespace: string;
  sandboxName: string;
  adapterType: string;
  image: string;
  envSecretName: string;
  serviceAccountName: string;
  labels: Record<string, string>;
  resources: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  runtimeClassName?: string;
  imagePullSecrets?: string[];
  /**
   * Provider-side hard stop for a lease with a caller-requested deadline. A
   * crash or an outage on paperclip-server must not leave the pod running
   * past the attested expiry, so this bounds it independently of any
   * in-process cleanup. Omitted for leases without a requested deadline,
   * which keep a long-lived pod.
   */
  hardStop?: {
    /**
     * Absolute Unix-seconds deadline. The entrypoint sleeps until this instant
     * and then exits, which kills every exec'd process; after that a restart
     * exits immediately. Unlike `activeDeadlineSeconds`, this does not drift
     * by the pod's scheduling and image-pull delay.
     */
    atEpochSec: number;
    /** Backstop `activeDeadlineSeconds` (counted from pod start). */
    activeDeadlineSeconds: number;
  };
}

export function buildSandboxCrManifest(
  input: BuildSandboxCrManifestInput,
): Record<string, unknown> {
  const podLabels: Record<string, string> = {
    ...input.labels,
    "paperclip.io/role": "agent",
  };
  return {
    apiVersion: "agents.x-k8s.io/v1alpha1",
    kind: "Sandbox",
    metadata: {
      name: input.sandboxName,
      namespace: input.namespace,
      labels: { ...input.labels },
      // No ownerReferences: paperclip-server is out-of-cluster. Release is
      // explicit delete.
    },
    spec: {
      podTemplate: {
        metadata: {
          labels: podLabels,
        },
        spec: {
          serviceAccountName: input.serviceAccountName,
          // Agent containers call back to paperclip-server via HTTPS egress;
          // they never call the Kubernetes API, so mounting an SA token is
          // unnecessary attack surface.
          automountServiceAccountToken: false,
          // Sandbox controller requires restartPolicy: Always so the pod
          // stays running between exec calls.
          restartPolicy: "Always",
          ...(input.hardStop
            ? { activeDeadlineSeconds: input.hardStop.activeDeadlineSeconds }
            : {}),
          ...(input.runtimeClassName
            ? { runtimeClassName: input.runtimeClassName }
            : {}),
          ...(input.imagePullSecrets && input.imagePullSecrets.length > 0
            ? {
                imagePullSecrets: input.imagePullSecrets.map((name) => ({
                  name,
                })),
              }
            : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "agent",
              image: input.image,
              imagePullPolicy: "IfNotPresent",
              // sleep keeps the pod running; paperclip-server execs commands
              // into it via Kubernetes exec API. Tini as PID 1 for proper
              // signal forwarding and zombie reaping. With a hard stop, the
              // sleep ends at the absolute deadline and PID 1 exits, which
              // kills every exec'd process in the container's PID namespace.
              command: [
                "/usr/bin/tini",
                "--",
                "/bin/sh",
                "-c",
                input.hardStop ? hardStopEntrypoint(input.hardStop.atEpochSec) : "sleep infinity",
              ],
              // HOME must point at a writable mount; the image's default
               // HOME=/home/node is inside the readOnly root filesystem.
               // Claude (and most agent runtimes) silently exit with code 0
               // and no output when HOME is unwritable, so set this explicitly.
              env: [{ name: "HOME", value: "/home/paperclip" }],
              envFrom: [{ secretRef: { name: input.envSecretName } }],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: input.resources.requests ?? {
                  cpu: "250m",
                  memory: "512Mi",
                },
                limits: input.resources.limits ?? {
                  cpu: "2",
                  memory: "4Gi",
                },
              },
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "home", mountPath: "/home/paperclip" },
                { name: "cache", mountPath: "/home/paperclip/.cache" },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: { sizeLimit: "8Gi" } },
            { name: "home", emptyDir: { sizeLimit: "1Gi" } },
            { name: "cache", emptyDir: { sizeLimit: "1Gi" } },
            { name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
          ],
        },
      },
    },
  };
}

/**
 * Sleeps until an absolute Unix-seconds deadline, then exits. A container
 * restarted after the deadline exits immediately, so the sandbox cannot be
 * revived past the attested lease expiry by `restartPolicy: Always`.
 */
function hardStopEntrypoint(atEpochSec: number): string {
  if (!Number.isSafeInteger(atEpochSec) || atEpochSec <= 0) {
    throw new Error(`Invalid sandbox hard-stop deadline: ${atEpochSec}`);
  }
  return `deadline=${atEpochSec}; now=$(date +%s); [ "$now" -lt "$deadline" ] || exit 0; exec sleep "$((deadline - now))"`;
}
