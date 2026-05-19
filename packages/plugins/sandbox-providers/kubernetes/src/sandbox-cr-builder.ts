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
}

export function buildSandboxCrManifest(
  input: BuildSandboxCrManifestInput,
): Record<string, unknown> {
  const podLabels: Record<string, string> = {
    ...input.labels,
    "paperclip.io/role": "agent",
    "paperclip.io/sandbox-name": input.sandboxName,
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
              // sleep infinity keeps the pod running; paperclip-server execs
              // commands into it via Kubernetes exec API. Tini as PID 1 for
              // proper signal forwarding and zombie reaping.
              command: [
                "/usr/bin/tini",
                "--",
                "/bin/sh",
                "-c",
                "sleep infinity",
              ],
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
