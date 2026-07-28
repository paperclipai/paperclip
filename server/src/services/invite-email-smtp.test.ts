import { describe, expect, it, vi, afterEach } from "vitest";
import {
  resolveSmtpSettingsFromEnv,
  createSmtpInviteEmailTransport,
  registerSmtpInviteEmailTransportFromEnv,
  type InviteMail,
} from "./invite-email-smtp.js";
import {
  getInviteEmailTransport,
  noopInviteEmailTransport,
  setInviteEmailTransport,
} from "./invite-email.js";

describe("resolveSmtpSettingsFromEnv", () => {
  it("returns null when nothing is configured", () => {
    expect(resolveSmtpSettingsFromEnv({})).toBeNull();
  });

  it("returns null when a URL is set but FROM is missing", () => {
    expect(
      resolveSmtpSettingsFromEnv({ PAPERCLIP_SMTP_URL: "smtp://mail.example.com" }),
    ).toBeNull();
  });

  it("returns null when FROM is set but neither URL nor HOST is", () => {
    expect(
      resolveSmtpSettingsFromEnv({ PAPERCLIP_SMTP_FROM: "Paperclip <no-reply@example.com>" }),
    ).toBeNull();
  });

  it("prefers the connection URL when set", () => {
    const settings = resolveSmtpSettingsFromEnv({
      PAPERCLIP_SMTP_URL: "smtps://user:pass@mail.example.com:465",
      PAPERCLIP_SMTP_HOST: "ignored.example.com",
      PAPERCLIP_SMTP_FROM: "no-reply@example.com",
    });
    expect(settings).toEqual({
      transport: "smtps://user:pass@mail.example.com:465",
      from: "no-reply@example.com",
    });
  });

  it("builds transport options from discrete host vars with defaults", () => {
    const settings = resolveSmtpSettingsFromEnv({
      PAPERCLIP_SMTP_HOST: "mail.example.com",
      PAPERCLIP_SMTP_FROM: "no-reply@example.com",
    });
    expect(settings).toEqual({
      transport: { host: "mail.example.com", port: 587, secure: false },
      from: "no-reply@example.com",
    });
  });

  it("includes auth when a user is set and infers secure for port 465", () => {
    const settings = resolveSmtpSettingsFromEnv({
      PAPERCLIP_SMTP_HOST: "mail.example.com",
      PAPERCLIP_SMTP_PORT: "465",
      PAPERCLIP_SMTP_USER: "mailer",
      PAPERCLIP_SMTP_PASSWORD: "s3cret",
      PAPERCLIP_SMTP_FROM: "no-reply@example.com",
    });
    expect(settings).toEqual({
      transport: {
        host: "mail.example.com",
        port: 465,
        secure: true,
        auth: { user: "mailer", pass: "s3cret" },
      },
      from: "no-reply@example.com",
    });
  });

  it("honors an explicit PAPERCLIP_SMTP_SECURE=true on a non-465 port", () => {
    const settings = resolveSmtpSettingsFromEnv({
      PAPERCLIP_SMTP_HOST: "mail.example.com",
      PAPERCLIP_SMTP_SECURE: "true",
      PAPERCLIP_SMTP_FROM: "no-reply@example.com",
    });
    expect(settings?.transport).toMatchObject({ port: 587, secure: true });
  });

  it("throws a descriptive error for a URL without a recognized scheme", () => {
    expect(() =>
      resolveSmtpSettingsFromEnv({
        PAPERCLIP_SMTP_URL: "mail.example.com:587",
        PAPERCLIP_SMTP_FROM: "no-reply@example.com",
      }),
    ).toThrow(/PAPERCLIP_SMTP_URL must start with/);
  });
});

describe("createSmtpInviteEmailTransport", () => {
  const settings = { transport: "smtp://mail.example.com", from: "no-reply@example.com" };

  function capturingMailer() {
    const sent: InviteMail[] = [];
    const mailer = { sendMail: vi.fn(async (mail: InviteMail) => void sent.push(mail)) };
    return { sent, mailer };
  }

  it("sends a mail with company name, role, and invite link", async () => {
    const { sent, mailer } = capturingMailer();
    const transport = createSmtpInviteEmailTransport(settings, () => mailer);
    await transport.sendInviteEmail({
      email: "teammate@example.com",
      inviteUrl: "https://paperclip.example.com/i/abc",
      companyName: "Acme",
      role: "operator",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("no-reply@example.com");
    expect(sent[0].to).toBe("teammate@example.com");
    expect(sent[0].subject).toBe("You've been invited to join Acme on Paperclip");
    expect(sent[0].text).toContain("https://paperclip.example.com/i/abc");
    expect(sent[0].text).toContain("operator");
    expect(sent[0].html).toContain("https://paperclip.example.com/i/abc");
  });

  it("falls back to a generic subject and omits the role line when absent", async () => {
    const { sent, mailer } = capturingMailer();
    const transport = createSmtpInviteEmailTransport(settings, () => mailer);
    await transport.sendInviteEmail({
      email: "teammate@example.com",
      inviteUrl: "https://paperclip.example.com/i/abc",
      companyName: null,
      role: null,
    });
    expect(sent[0].subject).toBe("You've been invited to a company on Paperclip");
    expect(sent[0].text).not.toContain("as ");
  });

  it("does nothing when the payload has no recipient", async () => {
    const { sent, mailer } = capturingMailer();
    const transport = createSmtpInviteEmailTransport(settings, () => mailer);
    await transport.sendInviteEmail({
      email: null,
      inviteUrl: "https://paperclip.example.com/i/abc",
      companyName: "Acme",
      role: null,
    });
    expect(sent).toHaveLength(0);
  });

  it("escapes HTML in the company name", async () => {
    const { sent, mailer } = capturingMailer();
    const transport = createSmtpInviteEmailTransport(settings, () => mailer);
    await transport.sendInviteEmail({
      email: "teammate@example.com",
      inviteUrl: "https://paperclip.example.com/i/abc",
      companyName: "<img src=x>",
      role: null,
    });
    expect(sent[0].html).not.toContain("<img src=x>");
    expect(sent[0].html).toContain("&lt;img src=x&gt;");
  });
});

describe("registerSmtpInviteEmailTransportFromEnv", () => {
  afterEach(() => {
    setInviteEmailTransport(noopInviteEmailTransport);
  });

  it("leaves the noop transport and returns false when unconfigured", () => {
    expect(registerSmtpInviteEmailTransportFromEnv({})).toBe(false);
    expect(getInviteEmailTransport()).toBe(noopInviteEmailTransport);
  });

  it("registers an SMTP transport and returns true when configured", () => {
    const registered = registerSmtpInviteEmailTransportFromEnv({
      PAPERCLIP_SMTP_URL: "smtp://mail.example.com",
      PAPERCLIP_SMTP_FROM: "no-reply@example.com",
    });
    expect(registered).toBe(true);
    expect(getInviteEmailTransport()).not.toBe(noopInviteEmailTransport);
  });
});
