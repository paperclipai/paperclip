import type { V1Job, V1Container, V1Volume } from "@kubernetes/client-node";
import {
  tenantBaseLabels, PAPERCLIP_AGENT_ID, PAPERCLIP_RUN_ID, PAPERCLIP_ROLE, ROLE_AGENT_RUNTIME,
} from "./labels.js";

export interface BuildJobInput {
  namespace: string;
  agentId: string;
  agentSlug: string;
  runId: string;
  runUlid: string;
  companyId: string;
  companySlug: string;
  adapterType: string;
  /** Image for the main container (e.g. ghcr.io/paperclipai/agent-runtime-claude:vX.Y.Z) */
  image: string;
  /** Image for the init container (always agent-runtime-base; baked-in workspace-init). */
  initImage: string;
  imagePullSecrets?: string[];
  pvcName: string;
  envSecretName: string;
  /** Resource requests/limits for the main container. */
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?:   { cpu?: string; memory?: string };
  };
  /** Hard ceiling for the run; clamped against ResourceQuota.maxRunSeconds upstream. */
  activeDeadlineSeconds: number;
  ttlSecondsAfterFinished: number;
  /** Workspace strategy serialized as JSON for the init container. */
  workspaceStrategyJson: string;
  /** AdapterRuntimeCommandSpec serialized as JSON for paperclip-agent-shim. */
  runtimeCommandSpecJson: string;
  paperclipPublicUrl: string;
  /** Trace context propagated into the pod. */
  traceparent?: string;
}

export function buildAgentJob(input: BuildJobInput): V1Job {
  const labels = {
    ...tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
    [PAPERCLIP_AGENT_ID]: input.agentId,
    [PAPERCLIP_RUN_ID]:   input.runId,
    [PAPERCLIP_ROLE]:     ROLE_AGENT_RUNTIME,
  };

  const volumes: V1Volume[] = [
    { name: "workspace", persistentVolumeClaim: { claimName: input.pvcName } },
    { name: "tmp", emptyDir: { sizeLimit: "1Gi" } },
    { name: "env", secret: { secretName: input.envSecretName, defaultMode: 0o400 } },
  ];

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

  const initContainer: V1Container = {
    name: "workspace-init",
    image: input.initImage,
    command: ["/usr/local/bin/paperclip-workspace-init"],
    env: [
      // workspace-init reads this env var; the name must match the constant
      // it expects (process.env.PAPERCLIP_WORKSPACE_REQUEST). The value is a
      // serialized WorkspaceRealizationRequest carrying version + source +
      // strategy. The internal field is named workspaceStrategyJson for
      // historical reasons; the wire-level env var is the contract.
      { name: "PAPERCLIP_WORKSPACE_REQUEST", value: input.workspaceStrategyJson },
      { name: "PAPERCLIP_WORKSPACE_ROOT", value: "/workspace" },
      { name: "PAPERCLIP_RUN_ID", value: input.runId },
      { name: "PAPERCLIP_PUBLIC_URL", value: input.paperclipPublicUrl },
      { name: "BOOTSTRAP_TOKEN", valueFrom: { secretKeyRef: { name: input.envSecretName, key: "BOOTSTRAP_TOKEN" } } },
    ],
    volumeMounts: [
      { name: "workspace", mountPath: "/workspace" },
      { name: "tmp", mountPath: "/tmp" },
    ],
    securityContext: containerSecurity,
    resources: {
      requests: { cpu: "200m", memory: "256Mi" },
      limits:   { cpu: "2",    memory: "1Gi"  },
    },
  };

  const mainContainer: V1Container = {
    name: "agent",
    image: input.image,
    imagePullPolicy: "IfNotPresent",
    workingDir: "/workspace",
    command: ["/usr/bin/tini", "--"],
    args: ["/usr/local/bin/paperclip-agent-shim", "--adapter", input.adapterType],
    env: [
      { name: "PAPERCLIP_RUN_ID", value: input.runId },
      { name: "PAPERCLIP_PUBLIC_URL", value: input.paperclipPublicUrl },
      ...(input.traceparent ? [{ name: "TRACEPARENT", value: input.traceparent }] : []),
    ],
    // BOOTSTRAP_TOKEN (and any other agent-shim secrets) are loaded from the
    // tenant env Secret; envFrom is the single source of truth for those keys.
    envFrom: [{ secretRef: { name: input.envSecretName } }],
    volumeMounts: [
      { name: "workspace", mountPath: "/workspace" },
      { name: "tmp", mountPath: "/tmp" },
      { name: "env", mountPath: "/run/paperclip/env", readOnly: true },
      { name: "env", mountPath: "/run/paperclip/runtime-command.json", subPath: "runtime-command.json", readOnly: true },
    ],
    resources: input.resources ?? {},
    securityContext: containerSecurity,
  };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `agent-${input.agentSlug}-run-${input.runUlid}`,
      namespace: input.namespace,
      labels,
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: input.ttlSecondsAfterFinished,
      activeDeadlineSeconds: input.activeDeadlineSeconds,
      completions: 1,
      parallelism: 1,
      podFailurePolicy: {
        rules: [
          { action: "FailJob", onPodConditions: [{ type: "PodHasNetwork", status: "False" }] },
          { action: "FailJob", onExitCodes: { containerName: "agent", operator: "In", values: [137] } },
        ],
      },
      template: {
        metadata: {
          labels,
          annotations: { "paperclip.ai/job-spec-version": "v1" },
        },
        spec: {
          automountServiceAccountToken: false,
          serviceAccountName: "paperclip-agent",
          restartPolicy: "Never",
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 30,
          securityContext: restrictedSecurity,
          imagePullSecrets: input.imagePullSecrets?.map((name) => ({ name })) ?? [],
          initContainers: [initContainer],
          containers: [mainContainer],
          volumes,
        },
      },
    },
  };
}

/** Apply (create) the Job. Returns the server-assigned UID for OwnerReference wiring. */
export async function createAgentJob(client: import("../types.js").KubernetesApiClient, job: V1Job): Promise<{ name: string; uid: string }> {
  const created = await client.batch.createNamespacedJob(job.metadata!.namespace!, job);
  return { name: created.body.metadata!.name!, uid: created.body.metadata!.uid! };
}
