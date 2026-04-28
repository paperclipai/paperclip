import { logger } from "../middleware/logger.js";

const RESEND_API_URL = "https://api.resend.com/emails";

interface SendEmailOpts {
  to: string;
  subject: string;
  html: string;
}

async function sendEmail(opts: SendEmailOpts): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn("RESEND_API_KEY not set, skipping email send");
    return false;
  }

  const from = process.env.RESEND_FROM_EMAIL ?? "CARE <noreply@thecare.app>";

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, "Resend API error");
      return false;
    }

    return true;
  } catch (err) {
    logger.error({ err }, "Failed to send email via Resend");
    return false;
  }
}

export async function sendPilotConfirmationEmail(name: string, email: string): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Welcome to the CARE Pilot Program",
    html: `
      <h2>Welcome, ${escapeHtml(name)}!</h2>
      <p>Thank you for applying to the CARE pilot program. We've received your application and will be in touch soon.</p>
      <p>— The CARE Team</p>
    `,
  });
}

export async function sendPilotOpsNotification(
  name: string,
  email: string,
  practiceType: string,
): Promise<void> {
  const opsEmail = process.env.OPS_EMAIL;
  if (!opsEmail) {
    logger.warn("OPS_EMAIL not set, skipping ops notification");
    return;
  }

  await sendEmail({
    to: opsEmail,
    subject: `New Pilot Application: ${name}`,
    html: `
      <h2>New Pilot Application</h2>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Practice Type:</strong> ${escapeHtml(practiceType)}</p>
    `,
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
