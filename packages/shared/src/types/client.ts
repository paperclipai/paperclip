import type { ClientStatus, ProjectStatus } from "../constants.js";

export interface ClientMetadata {
  cnpj?: string;
  [key: string]: unknown;
}

export interface ClientProjectMetadata {
  legacyProjectType?: string;
  legacyBillingType?: string;
  legacyAmountCents?: number;
  legacyLastPaymentAt?: string;
  [key: string]: unknown;
}

export interface Client {
  id: string;
  companyId: string;
  name: string;
  email: string | null;
  phone: string | null;
  contactName: string | null;
  notes: string | null;
  status: ClientStatus;
  metadata: ClientMetadata | null;
  linkedProjectCount?: number;
  activeProjectCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClientProject {
  id: string;
  companyId: string;
  clientId: string;
  projectId: string;
  projectNameOverride: string | null;
  status: ProjectStatus;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  tags: string[];
  metadata: ClientProjectMetadata | null;
  createdAt: string;
  updatedAt: string;
  /** Joined from projects table when available */
  projectName?: string;
}
