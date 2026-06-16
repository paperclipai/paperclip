import type { CredentialType } from "../constants.js";
import type { QuotaWindow } from "./quota.js";

export interface ProviderCredential {
  id: string;
  companyId: string;
  name: string;
  type: CredentialType;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderCredentialQuota {
  credentialId: string;
  name: string;
  type: CredentialType;
  supported: boolean;
  ok: boolean;
  quotaWindows: QuotaWindow[];
  source?: string | null;
  cooldownUntil?: string | null;
  cooldownReason?: string | null;
  disabledAt?: string | null;
  error?: string;
  sampledAt: string;
}
