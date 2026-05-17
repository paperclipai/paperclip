import type { CrewbriefConfig } from "@paperclipai/shared";

interface EmailAddress {
  email: string;
  name?: string;
}

interface SendEmailInput {
  to: EmailAddress;
  subject: string;
  htmlBody: string;
  textBody?: string;
}

interface SendEmailResult {
  messageId: string | null;
  error: string | null;
}

type EmailProvider = "console" | "smtp" | "resend";

export function crewbriefEmailService(config: CrewbriefConfig) {
  const provider: EmailProvider = config.CREWBRIEF_EMAIL_PROVIDER;
  const fromEmail = config.CREWBRIEF_FROM_EMAIL;
  const fromName = config.CREWBRIEF_FROM_NAME;

  async function send(input: SendEmailInput): Promise<SendEmailResult> {
    switch (provider) {
      case "resend":
        return sendViaResend(input);
      case "smtp":
        return sendViaSmtp(input);
      case "console":
      default:
        return sendViaConsole(input);
    }
  }

  async function sendViaResend(input: SendEmailInput): Promise<SendEmailResult> {
    const apiKey = process.env.CREWBRIEF_RESEND_API_KEY;
    if (!apiKey) {
      return { messageId: null, error: "Resend API key not configured" };
    }
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${fromName} <${fromEmail}>`,
          to: [input.to.email],
          subject: input.subject,
          html: input.htmlBody,
          text: input.textBody,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { messageId: null, error: `Resend error ${res.status}: ${text}` };
      }
      const json = (await res.json()) as { id: string };
      return { messageId: json.id, error: null };
    } catch (err) {
      return { messageId: null, error: `Resend request failed: ${(err as Error).message}` };
    }
  }

  async function sendViaSmtp(input: SendEmailInput): Promise<SendEmailResult> {
    const host = config.CREWBRIEF_SMTP_HOST;
    if (!host) {
      return { messageId: null, error: "SMTP host not configured" };
    }
    return { messageId: null, error: "SMTP provider requires nodemailer; use console or resend providers" };
  }

  async function sendViaConsole(input: SendEmailInput): Promise<SendEmailResult> {
    console.log(
      JSON.stringify({
        type: "crewbrief_email",
        provider: "console",
        to: input.to.email,
        subject: input.subject,
        htmlBody: input.htmlBody,
      }),
    );
    return { messageId: `console-${Date.now()}`, error: null };
  }

  return { send };
}

export type CrewbriefEmailService = ReturnType<typeof crewbriefEmailService>;
