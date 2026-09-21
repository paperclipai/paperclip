/**
 * Where the agent workspace is mounted in the pod. The value is also declared
 * to git as a safe directory, because the mount root belongs to root while the
 * container runs as uid 1000.
 */
const WORKSPACE_MOUNT_PATH = "/workspace";

export interface BuildJobManifestInput {
  namespace: string;
  jobName: string;
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
  activeDeadlineSec: number;
  ttlSecondsAfterFinished: number;
  imagePullSecrets?: string[];
}

export function buildJobManifest(input: BuildJobManifestInput): Record<string, unknown> {
  const podLabels = {
    ...input.labels,
    "paperclip.io/role": "agent",
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: input.jobName,
      namespace: input.namespace,
      labels: { ...input.labels },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: input.ttlSecondsAfterFinished,
      activeDeadlineSeconds: input.activeDeadlineSec,
      template: {
        metadata: { labels: podLabels },
        spec: {
          serviceAccountName: input.serviceAccountName,
          // Agent containers call back to paperclip-server via HTTPS egress;
          // they never call the Kubernetes API, so mounting an SA token is
          // unnecessary attack surface.
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
          ...(input.imagePullSecrets && input.imagePullSecrets.length > 0
            ? { imagePullSecrets: input.imagePullSecrets.map((name) => ({ name })) }
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
              command: ["/usr/bin/tini", "--", "/usr/local/bin/paperclip-agent-shim"],
              // HOME must point at a writable mount; the image's default
              // HOME is inside the readOnly root filesystem. Agent runtimes
              // can silently exit with code 0 and no output when HOME is
              // unwritable, so set this explicitly.
              env: [
                { name: "HOME", value: "/home/paperclip" },
                // The workspace mount root belongs to root, because `fsGroup`
                // sets the group and leaves the owner. Git refuses to work in a
                // repository whose worktree belongs to another user, so the
                // export step of a run fails with "detected dubious ownership".
                // Declare the mount as safe through the environment, which needs
                // no write to a git config file.
                //
                // `GIT_CONFIG_PARAMETERS` adds to the configuration git reads,
                // so an adapter that supplies its own `GIT_CONFIG_COUNT` entries
                // for credentials or URL rewriting keeps them. A fixed
                // `GIT_CONFIG_COUNT` here would replace that whole set instead.
                {
                  name: "GIT_CONFIG_PARAMETERS",
                  value: `'safe.directory=${WORKSPACE_MOUNT_PATH}'`,
                },
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
                requests: input.resources.requests ?? { cpu: "250m", memory: "512Mi" },
                limits: input.resources.limits ?? { cpu: "2", memory: "4Gi" },
              },
              volumeMounts: [
                { name: "workspace", mountPath: WORKSPACE_MOUNT_PATH },
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
