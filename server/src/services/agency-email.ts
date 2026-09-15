/**
 * AgencyEmailClient — injectable email service for agency trial lifecycle emails.
 *
 * In development (EMAIL_RELAY_URL unset) emails are logged to stdout.
 * In production, set EMAIL_RELAY_URL to an HTTP endpoint that accepts:
 *   POST { to, subject, html }
 * and EMAIL_RELAY_SECRET for bearer auth (optional).
 *
 * This keeps the service dependency-free while remaining injectable for tests.
 */

export type TrialEmailData = {
  trialId: string;
  contactEmail: string;
  contactName: string | null;
  agencyName: string;
  agencyCode: string;
  webhookUrl: string;
  trialEndsAt: Date;
  incidentCount: number;
  incidentCap: number;
};

export interface AgencyEmailClient {
  sendWelcome(data: TrialEmailData): Promise<void>;
  sendDay7(data: TrialEmailData): Promise<void>;
  sendDay25(data: TrialEmailData): Promise<void>;
  sendUpgradeConfirmation(data: TrialEmailData): Promise<void>;
}

// ---------------------------------------------------------------------------
// Dev (console) implementation
// ---------------------------------------------------------------------------

class ConsoleEmailClient implements AgencyEmailClient {
  private log(type: string, to: string, subject: string) {
    console.log(`[agency-email:${type}] to=${to} | ${subject}`);
  }
  async sendWelcome(d: TrialEmailData) {
    this.log("welcome", d.contactEmail, `Welcome to Solaris — trial started for ${d.agencyName}`);
  }
  async sendDay7(d: TrialEmailData) {
    this.log("day7", d.contactEmail, `7 days in — how is Solaris working for ${d.agencyName}?`);
  }
  async sendDay25(d: TrialEmailData) {
    this.log("day25", d.contactEmail, `5 days left on your Solaris trial — upgrade ${d.agencyName}`);
  }
  async sendUpgradeConfirmation(d: TrialEmailData) {
    this.log("upgrade", d.contactEmail, `${d.agencyName} upgraded to paid`);
  }
}

// ---------------------------------------------------------------------------
// HTTP relay implementation (production)
// ---------------------------------------------------------------------------

class HttpRelayEmailClient implements AgencyEmailClient {
  constructor(
    private readonly relayUrl: string,
    private readonly secret: string | undefined,
  ) {}

  private async send(to: string, subject: string, html: string): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.secret) headers["Authorization"] = `Bearer ${this.secret}`;
    const resp = await fetch(this.relayUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ to, subject, html }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Email relay error ${resp.status}: ${text}`);
    }
  }

  async sendWelcome(d: TrialEmailData) {
    const endsStr = d.trialEndsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    await this.send(
      d.contactEmail,
      `Welcome to Solaris — your 30-day trial for ${d.agencyName} has started`,
      `<p>Hi ${d.contactName ?? "there"},</p>
<p>Your Solaris sandbox trial for <strong>${d.agencyName}</strong> is active until <strong>${endsStr}</strong>.</p>
<h3>Your webhook details</h3>
<ul>
  <li><strong>Webhook URL:</strong> <code>${d.webhookUrl}</code></li>
  <li><strong>Agency code:</strong> <code>${d.agencyCode}</code></li>
</ul>
<p>Your trial includes up to <strong>${d.incidentCap.toLocaleString()} incidents</strong> of live CAD data.</p>
<p>Questions? Reply to this email and we will get back to you within one business day.</p>`,
    );
  }

  async sendDay7(d: TrialEmailData) {
    await this.send(
      d.contactEmail,
      `7 days in: how is Solaris working for ${d.agencyName}?`,
      `<p>Hi ${d.contactName ?? "there"},</p>
<p>It has been one week since <strong>${d.agencyName}</strong> connected to Solaris. You have processed <strong>${d.incidentCount.toLocaleString()}</strong> incidents so far.</p>
<p>Let us know if you have any questions or need help configuring your integration.</p>`,
    );
  }

  async sendDay25(d: TrialEmailData) {
    const endsStr = d.trialEndsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    await this.send(
      d.contactEmail,
      `5 days left on your Solaris trial — upgrade to keep ${d.agencyName} connected`,
      `<p>Hi ${d.contactName ?? "there"},</p>
<p>Your Solaris trial for <strong>${d.agencyName}</strong> expires on <strong>${endsStr}</strong> — just 5 days away.</p>
<p>You have processed <strong>${d.incidentCount.toLocaleString()}</strong> incidents. Upgrade now to keep your CAD integration live without interruption.</p>`,
    );
  }

  async sendUpgradeConfirmation(d: TrialEmailData) {
    await this.send(
      d.contactEmail,
      `${d.agencyName} is now a paid Solaris subscriber`,
      `<p>Hi ${d.contactName ?? "there"},</p>
<p>Thank you! <strong>${d.agencyName}</strong> has been upgraded to a paid Solaris subscription. Your CAD webhook integration will continue uninterrupted.</p>`,
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgencyEmailClient(): AgencyEmailClient {
  const relayUrl = process.env["EMAIL_RELAY_URL"];
  if (!relayUrl) return new ConsoleEmailClient();
  return new HttpRelayEmailClient(relayUrl, process.env["EMAIL_RELAY_SECRET"]);
}
