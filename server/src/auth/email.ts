import { Resend } from "resend";

export type EmailSender = {
  sendVerificationEmail(to: string, url: string): Promise<void>;
  sendPasswordResetEmail(to: string, url: string): Promise<void>;
};

export function createEmailSender(apiKey: string, from: string): EmailSender {
  const resend = new Resend(apiKey);
  return {
    async sendVerificationEmail(to: string, url: string) {
      await resend.emails.send({
        from,
        to,
        subject: "Verify your email address",
        html: [
          "<p>Click the link below to verify your email address:</p>",
          `<p><a href="${url}">Verify email</a></p>`,
          "<p>If you didn't create an account, you can ignore this email.</p>",
        ].join("\n"),
      });
    },
    async sendPasswordResetEmail(to: string, url: string) {
      await resend.emails.send({
        from,
        to,
        subject: "Reset your password",
        html: [
          "<p>Click the link below to reset your password:</p>",
          `<p><a href="${url}">Reset password</a></p>`,
          "<p>This link expires in 1 hour. If you didn't request a password reset, you can ignore this email.</p>",
        ].join("\n"),
      });
    },
  };
}
