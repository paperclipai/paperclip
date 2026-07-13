import { createTransport } from "nodemailer";
import type { InviteEmailPayload, InviteEmailTransport } from "./invite-email.js";
import { setInviteEmailTransport } from "./invite-email.js";

// SMTP transport for the invite-email hook. Activates only when SMTP env
// configuration is present; otherwise the hook keeps its no-op transport and
// invites remain copy-link only.
export interface SmtpInviteEmailSettings {
  transport:
    | string
    | {
        host: string;
        port: number;
        secure: boolean;
        auth?: { user: string; pass: string };
      };
  from: string;
}

export function resolveSmtpSettingsFromEnv(
  env: NodeJS.ProcessEnv,
): SmtpInviteEmailSettings | null {
  const from = env.PAPERCLIP_SMTP_FROM?.trim();
  const url = env.PAPERCLIP_SMTP_URL?.trim();
  const host = env.PAPERCLIP_SMTP_HOST?.trim();
  if (!from || (!url && !host)) return null;
  if (url) {
    if (!/^(smtps?|direct):/i.test(url)) {
      throw new Error(
        "PAPERCLIP_SMTP_URL must start with smtp://, smtps://, or direct: — got an unrecognized scheme",
      );
    }
    return { transport: url, from };
  }

  const port = Number(env.PAPERCLIP_SMTP_PORT) || 587;
  const secure = env.PAPERCLIP_SMTP_SECURE === "true" || port === 465;
  const user = env.PAPERCLIP_SMTP_USER?.trim();
  return {
    transport: {
      host: host as string,
      port,
      secure,
      ...(user ? { auth: { user, pass: env.PAPERCLIP_SMTP_PASSWORD ?? "" } } : {}),
    },
    from,
  };
}

export interface InviteMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type InviteMailer = { sendMail(mail: InviteMail): Promise<unknown> };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInviteMail(from: string, payload: InviteEmailPayload & { email: string }): InviteMail {
  const company = payload.companyName ?? "a company";
  const roleLine = payload.role ? `You've been invited as ${payload.role}.\n\n` : "";
  const subject = payload.companyName
    ? `You've been invited to join ${company} on Paperclip`
    : "You've been invited to a company on Paperclip";
  const text =
    `You've been invited to join ${company} on Paperclip.\n\n` +
    roleLine +
    `Accept the invite:\n${payload.inviteUrl}\n\n` +
    "If you weren't expecting this invitation, you can ignore this email.";
  const html =
    `<p>You've been invited to join <strong>${escapeHtml(company)}</strong> on Paperclip.</p>` +
    (payload.role ? `<p>You've been invited as ${escapeHtml(payload.role)}.</p>` : "") +
    `<p><a href="${escapeHtml(payload.inviteUrl)}">Accept the invite</a></p>` +
    `<p>Or copy this link: ${escapeHtml(payload.inviteUrl)}</p>` +
    `<p>If you weren't expecting this invitation, you can ignore this email.</p>`;
  return { from, to: payload.email, subject, text, html };
}

export function createSmtpInviteEmailTransport(
  settings: SmtpInviteEmailSettings,
  createMailer: (transport: SmtpInviteEmailSettings["transport"]) => InviteMailer = (
    transport,
  ) => createTransport(transport as Parameters<typeof createTransport>[0]),
): InviteEmailTransport {
  const mailer = createMailer(settings.transport);
  return {
    async sendInviteEmail(payload: InviteEmailPayload): Promise<void> {
      if (!payload.email) return;
      await mailer.sendMail(renderInviteMail(settings.from, { ...payload, email: payload.email }));
    },
  };
}

export function registerSmtpInviteEmailTransportFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const settings = resolveSmtpSettingsFromEnv(env);
  if (!settings) return false;
  setInviteEmailTransport(createSmtpInviteEmailTransport(settings));
  return true;
}
