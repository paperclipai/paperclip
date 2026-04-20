import type { CredentialType } from "../constants.js";

export interface ProviderCredential {
  id: string;
  companyId: string;
  name: string;
  type: CredentialType;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}
