// The manifest builders return Record<string, unknown> because the manifests go
// straight to the Kubernetes API. These views name only the fields the tests read.

export interface PodTemplateView {
  metadata: { labels: Record<string, string> };
  spec: {
    automountServiceAccountToken: boolean;
    restartPolicy: string;
    runtimeClassName?: string;
    imagePullSecrets?: { name: string }[];
    securityContext: {
      runAsNonRoot: boolean;
      runAsUser: number;
      fsGroupChangePolicy: string;
      seccompProfile: { type: string };
    };
    containers: {
      command: string[];
      envFrom: { secretRef: { name: string } }[];
      securityContext: {
        runAsNonRoot: boolean;
        readOnlyRootFilesystem: boolean;
        allowPrivilegeEscalation: boolean;
        capabilities: { drop: string[] };
      };
      volumeMounts: { mountPath: string }[];
    }[];
    volumes: { emptyDir?: unknown }[];
  };
}

export interface JobManifestView {
  apiVersion: string;
  kind: string;
  metadata: { labels: Record<string, string> };
  spec: {
    backoffLimit: number;
    ttlSecondsAfterFinished: number;
    activeDeadlineSeconds: number;
    template: PodTemplateView;
  };
}

export interface SandboxCrManifestView {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    ownerReferences?: unknown[];
  };
  spec: { podTemplate: PodTemplateView };
}

export interface NetworkPolicyEgressRuleView {
  to: {
    namespaceSelector?: { matchLabels?: Record<string, string> };
    podSelector?: { matchLabels?: Record<string, string> };
    ipBlock?: { cidr: string; except?: string[] };
  }[];
  ports?: { protocol: string; port: number }[];
}

export interface DenyAllPolicyView {
  metadata: { name: string };
  spec: {
    podSelector: Record<string, never>;
    policyTypes: string[];
    ingress?: unknown[];
    egress?: unknown[];
  };
}

export interface EgressAllowPolicyView {
  metadata: { name: string; ownerReferences?: unknown[] };
  spec: {
    podSelector: { matchLabels: Record<string, string> };
    egress: NetworkPolicyEgressRuleView[];
  };
}

export interface CiliumEgressRuleView {
  toEndpoints?: { matchLabels: Record<string, string> }[];
  toPorts?: { ports: { port: string }[] }[];
  toFQDNs?: { matchName: string }[];
  toCIDRSet?: { cidr: string }[];
}

export interface CiliumNetworkPolicyView {
  apiVersion: string;
  kind: string;
  metadata: { name: string; ownerReferences?: unknown[] };
  spec: {
    endpointSelector: { matchLabels: Record<string, string> };
    egress: CiliumEgressRuleView[];
  };
}
