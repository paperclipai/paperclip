export interface JiraIntegration {
  id: string;
  companyId: string;
  name: string;
  hostUrl: string;
  usernameOrEmail: string;
  credentialSecretId: string;
  lastSyncAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  avatarUrl?: string;
}

export interface JiraStatus {
  id: string;
  name: string;
  categoryKey: string;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrl?: string;
}

export interface JiraAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentUrl: string;
}

export interface JiraIssuePreview {
  key: string;
  summary: string;
  status: string;
  priority: string;
  assignee: string | null;
  description?: string | null;
  comments?: string[];
  attachments?: JiraAttachment[];
}

export interface JiraImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}
