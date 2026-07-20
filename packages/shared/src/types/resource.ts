export type ResourceType = "git";
export type ResourceStatus = "active" | "archived";
export type ResourceAttachmentMode = "input" | "output" | "input_output";
export type ResourceOutputAction = "none" | "push" | "pull_request";

export interface Resource {
  id: string;
  companyId: string;
  key: string;
  type: ResourceType;
  repository: string;
  sourcePath: string | null;
  defaultRef: string;
  mountPath: string;
  credentialRef: string | null;
  labels: Record<string, string>;
  status: ResourceStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResourceManifestAttachment {
  resourceId: string;
  mode: ResourceAttachmentMode;
  version?: string;
  output?: ResourceOutputConfig;
}

export interface ResourceOutputConfig {
  action: ResourceOutputAction;
  targetRef?: string;
  branch?: string;
  title?: string;
  body?: string;
}

export interface ResourceRunOverride {
  resourceId: string;
  version?: string;
}

export interface WorkflowResourceManifest {
  version: 1;
  resources: ResourceManifestAttachment[];
}

export interface ResourceVersionReference {
  resourceId: string;
  resourceKey: string;
  requestedRef: string;
  resolvedRef: string;
  commit: string;
  mountPath: string;
  published: boolean;
}

export type ResourceOutputStatus = "no_changes" | "discarded" | "pushed" | "pull_request_created";

export interface ResourceOutputResult {
  resourceId: string;
  inputCommit: string;
  outputCommit?: string;
  action: ResourceOutputAction;
  branch?: string;
  targetRef?: string;
  pullRequestId?: string;
  pullRequestUrl?: string;
  changedFiles?: string[];
  insertions?: number;
  deletions?: number;
  status: ResourceOutputStatus;
}
