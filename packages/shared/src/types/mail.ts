import type { CloudflareConnectionStatus, MailDomainStatus } from "../constants.js";

/**
 * A company's Cloudflare connection, projected for the API. The stored API-token
 * secret id is never exposed here.
 */
export interface CloudflareConnection {
  id: string;
  companyId: string;
  cfAccountId: string | null;
  status: CloudflareConnectionStatus;
  scopes: string[];
  verifiedAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/** A Cloudflare zone the human can attach (from the connected account). */
export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
}

/**
 * A domain attached for embedded email, projected for the API. Secret ids (DKIM
 * private key) are never exposed; the DKIM public key is published in DNS anyway.
 */
export interface MailDomain {
  id: string;
  companyId: string;
  domain: string;
  provider: string;
  cfZoneId: string | null;
  status: MailDomainStatus;
  dkimSelector: string;
  dkimPublicKey: string | null;
  mxConfigured: boolean;
  spfConfigured: boolean;
  dmarcConfigured: boolean;
  lastError: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}
