export interface IdentityBinding {
  id: string;
  platform: string;
  platformUserId: string;
  paperclipUserId: string;
  paperclipCompanyId: string;
  displayName: string | null;
  boundAt: Date;
  revokedAt: Date | null;
}

export interface MagicLinkPayload {
  platform: string;
  platformUserId: string;
  companyId: string;
  displayName: string | null;
}

export interface BindResult {
  binding: IdentityBinding;
  isNew: boolean;
}
