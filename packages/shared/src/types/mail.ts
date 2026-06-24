import type {
  CloudflareConnectionStatus,
  MailAddressKind,
  MailDomainStatus,
  MailMessageDirection,
  MailMessageStatus,
} from "../constants.js";

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

/** An email address on an attached mail domain. */
export interface MailAddress {
  id: string;
  companyId: string;
  domainId: string;
  agentId: string | null;
  localPart: string;
  address: string;
  kind: MailAddressKind;
  status: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/**
 * Reverse-DNS (PTR) health for the mail engine's sending IP. The PTR lives in the
 * host provider's `in-addr.arpa` zone (not Cloudflare), so it cannot be published
 * from Atelier; this surfaces its state so a human can fix it where it lives.
 */
export interface MailReverseDnsStatus {
  // `ok`: PTR matches the HELO hostname and forward-confirms (FCrDNS passes).
  // `mismatch`: a PTR exists but does not match / does not forward-confirm.
  // `missing`: the sending IP has no PTR at all.
  // `unconfigured`: MAIL_HOSTNAME is not set (mail engine not deployed yet).
  // `error`: the lookup could not complete (e.g. hostname does not resolve).
  status: "ok" | "mismatch" | "missing" | "unconfigured" | "error";
  // The hostname the server announces in HELO (MAIL_HOSTNAME); the expected PTR.
  hostname: string | null;
  // The sending IP the PTR was checked for.
  ip: string | null;
  // The PTR actually published for the IP (the first record), if any.
  ptr: string | null;
  // The PTR resolves back to the same IP (forward-confirmed reverse DNS).
  fcrdns: boolean;
  // The PTR equals the HELO hostname.
  matchesHostname: boolean;
  // Human-readable explanation / remediation for the current status.
  message: string;
  checkedAt: string;
}

/** A stored email message (inbound in phase 1; outbound in phase 2). */
export interface MailMessage {
  id: string;
  companyId: string;
  addressId: string;
  agentId: string | null;
  direction: MailMessageDirection;
  messageId: string | null;
  inReplyTo: string | null;
  fromAddr: string;
  toAddrs: string[];
  ccAddrs: string[];
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  status: MailMessageStatus;
  readAt: string | Date | null;
  createdAt: string | Date;
}
