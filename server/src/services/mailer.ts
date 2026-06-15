import nodemailer from "nodemailer";

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
}

export interface MailerService {
  sendMail: (opts: MailOptions) => Promise<void>;
  isConfigured: () => boolean;
}

export function mailerService(): MailerService {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM ?? user;
  const port = Number(process.env.SMTP_PORT ?? "587");

  if (!host || !user || !pass) {
    return {
      sendMail: async (_opts: MailOptions) => { /* SMTP not configured */ },
      isConfigured: () => false,
    };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return {
    sendMail: async (opts: MailOptions) => {
      await transporter.sendMail({
        from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
      });
    },
    isConfigured: () => true,
  };
}
