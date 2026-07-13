export interface InviteEmailPayload {
  email: string | null;
  inviteUrl: string;
  companyName: string | null;
  role: "owner" | "admin" | "operator" | "viewer" | null;
}

export interface InviteEmailTransport {
  sendInviteEmail(payload: InviteEmailPayload): Promise<void>;
}

export const noopInviteEmailTransport: InviteEmailTransport = {
  async sendInviteEmail() {
    // No transport configured: invite stays link-copy only.
  },
};

// The Email workstream replaces this at startup via setInviteEmailTransport.
let activeTransport: InviteEmailTransport = noopInviteEmailTransport;

export function setInviteEmailTransport(transport: InviteEmailTransport): void {
  activeTransport = transport;
}

export function getInviteEmailTransport(): InviteEmailTransport {
  return activeTransport;
}

export async function inviteEmailHook(
  transport: InviteEmailTransport,
  payload: InviteEmailPayload,
): Promise<void> {
  if (!payload.email) return;
  try {
    await transport.sendInviteEmail(payload);
  } catch {
    // Delivery is best-effort; the copyable inviteUrl is always the fallback.
  }
}
