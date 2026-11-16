export type TailscaleConnection = { id: string; companyId: string; name: string; status: string };
export type TailscaleDeviceLogin = {
  connection: TailscaleConnection;
  expiresAt: string | null;
  authorizationUrl?: string;
  needsApproval?: boolean;
};
