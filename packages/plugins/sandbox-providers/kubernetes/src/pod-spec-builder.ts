/**
 * Where the agent workspace is mounted in the pod. The value is also declared
 * to git as a safe directory, because the mount root belongs to root while the
 * container runs as uid 1000.
 */
const WORKSPACE_MOUNT_PATH = "/workspace";

/**
 * Marks the workspace mount as a git safe directory, in the pod's own HOME.
 *
 * The mount root belongs to root, because `fsGroup` sets the group and leaves
 * the owner, while the container runs as uid 1000. Git refuses to work in a
 * repository whose worktree belongs to another user, so the export step of a
 * run fails with "detected dubious ownership".
 *
 * The setting is written to the config file rather than passed through
 * `GIT_CONFIG_*`: those variables replace or interfere with the configuration
 * an adapter supplies for credentials or URL rewriting. `--add` appends, so an
 * adapter that declares its own safe directories keeps them. A failure here
 * never blocks the container, which is why the command tolerates it.
 */
const GIT_SAFE_DIRECTORY_COMMAND = `git config --global --add safe.directory ${WORKSPACE_MOUNT_PATH} || true`;

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
              command: [
                "/usr/bin/tini",
                "--",
                "/bin/sh",
                "-c",
                `${GIT_SAFE_DIRECTORY_COMMAND}; exec /usr/local/bin/paperclip-agent-shim`,
              ],
              // HOME must point at a writable mount; the image's default
              // HOME is inside the readOnly root filesystem. Agent runtimes
              // can silently exit with code 0 and no output when HOME is
              // unwritable, so set this explicitly.
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
