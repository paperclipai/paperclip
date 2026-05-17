import type { Db } from "@paperclipai/db";
import { and, eq, lte } from "drizzle-orm";
import {
  crewbriefWaitlistEntries,
  crewbriefEmailLog,
  crewbriefHubspotSync,
} from "@paperclipai/db";
import type { CrewbriefConfig, EmailTemplateName } from "@paperclipai/shared";
import type { CrewbriefHubspotService } from "./crewbrief-hubspot.js";
import type { CrewbriefPosthogService } from "./crewbrief-posthog.js";
import type { CrewbriefEmailService } from "./crewbrief-email.js";

interface EmailTemplate {
  subject: string;
  buildBody: (vars: Record<string, string>) => { html: string; text: string };
}

const TEMPLATES: Record<string, EmailTemplate> = {
  waitlist_confirmation: {
    subject: "You're on the CrewBrief beta waitlist — spot #{queuePosition}",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Welcome to CrewBrief, ${v.name}!</h1>
          <p>You're <strong>#${v.queuePosition}</strong> on the beta waitlist.</p>
          <p>Share your referral link to move up:</p>
          <p><a href="${v.baseUrl}/join?ref=${v.referralCode}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">
            ${v.baseUrl}/join?ref=${v.referralCode}
          </a></p>
          <p>Referrals: ${v.referralCount || 0} | Priority at 3 | Insider at 5</p>
          <hr />
          <p style="color:#666;">Follow us on LinkedIn for beta announcements.</p>
        </div>`,
      text: `Welcome to CrewBrief, ${v.name}!\n\nYou're #${v.queuePosition} on the beta waitlist.\n\nShare your referral link to move up:\n${v.baseUrl}/join?ref=${v.referralCode}\n\nReferrals: ${v.referralCount || 0} | Priority at 3 | Insider at 5\n\nFollow us on LinkedIn for beta announcements.`,
    }),
  },
  referral_invite: {
    subject: "{referrerName} thinks you'd love CrewBrief — get early access",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>You're invited to CrewBrief!</h1>
          <p>${v.referrerName} thinks you'd love CrewBrief — the smartest way to get your flight briefings.</p>
          <p><a href="${v.baseUrl}/join?ref=${v.referralCode}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">
            Get Early Access
          </a></p>
        </div>`,
      text: `You're invited to CrewBrief!\n\n${v.referrerName} thinks you'd love CrewBrief — get early access at:\n${v.baseUrl}/join?ref=${v.referralCode}`,
    }),
  },
  beta_invitation: {
    subject: "Your CrewBrief beta access is ready",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Welcome to the CrewBrief Beta!</h1>
          <p>Your personalized access link: <a href="${v.baseUrl}/onboarding?token=${v.accessToken}">Start Onboarding</a></p>
          <h3>3 steps to your first briefing:</h3>
          <ol>
            <li>Set up your profile</li>
            <li>Configure your briefing preferences</li>
            <li>Generate your first briefing</li>
          </ol>
          <p>Need help? Reply to this email — we'll respond within 2 hours.</p>
        </div>`,
      text: `Welcome to the CrewBrief Beta!\n\nYour personalized access link: ${v.baseUrl}/onboarding?token=${v.accessToken}\n\n3 steps to your first briefing:\n1. Set up your profile\n2. Configure your briefing preferences\n3. Generate your first briefing\n\nNeed help? Reply to this email — we'll respond within 2 hours.`,
    }),
  },
  beta_welcome_day1: {
    subject: "Your first briefing — what to look for",
    buildBody: () => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Your first briefing is ready</h1>
          <p>Here's what to look for:</p>
          <ul>
            <li><strong>FRAT Score</strong> — Flight Risk Assessment Tool rating</li>
            <li><strong>Warning Codes</strong> — color-coded alerts for weather, NOTAMs, fuel</li>
            <li><strong>Route Analysis</strong> — route-specific risk factors</li>
          </ul>
          <p>Share feedback: reply to this email or use the in-briefing thumbs up/down.</p>
        </div>`,
      text: `Your first briefing is ready\n\nHere's what to look for:\n- FRAT Score — Flight Risk Assessment Tool rating\n- Warning Codes — color-coded alerts for weather, NOTAMs, fuel\n- Route Analysis — route-specific risk factors\n\nShare feedback: reply to this email or use the in-briefing thumbs up/down.`,
    }),
  },
  onboarding_tips_day2: {
    subject: "Tips for getting the most out of CrewBrief",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Getting the most out of CrewBrief</h1>
          <ul>
            <li>Set your preferred briefing time for automatic delivery</li>
            <li>Customize which sections to include (Weather, NOTAMs, Route, Fuel, FRAT, Crew Notices)</li>
            <li>Connect your schedule for automatic briefings</li>
          </ul>
          <p><a href="${v.baseUrl}/onboarding" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Update Preferences</a></p>
        </div>`,
      text: `Getting the most out of CrewBrief\n\n- Set your preferred briefing time for automatic delivery\n- Customize which sections to include\n- Connect your schedule for automatic briefings\n\nUpdate preferences: ${v.baseUrl}/onboarding`,
    }),
  },
  feature_spotlight_day4: {
    subject: "Feature spotlight — FRAT and risk assessment",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>FRAT & Risk Assessment</h1>
          <p>CrewBrief's FRAT (Flight Risk Assessment Tool) scores each briefing on key risk factors:</p>
          <ul>
            <li>Weather severity at departure, en-route, and destination</li>
            <li>NOTAM relevance to your specific flight</li>
            <li>Fuel considerations and alternates</li>
            <li>Crew fatigue and duty day limits</li>
          </ul>
          <p>Each factor gets a color-coded rating: <span style="color:#22c55e;">Low</span> · <span style="color:#eab308;">Medium</span> · <span style="color:#ef4444;">High</span></p>
        </div>`,
      text: `FRAT & Risk Assessment\n\nCrewBrief's FRAT scores each briefing on: weather severity, NOTAM relevance, fuel considerations, and crew fatigue. Each factor gets a color-coded rating: Low · Medium · High`,
    }),
  },
  week1_checkin_day7: {
    subject: "How's your first week?",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>How's your first week?</h1>
          <p>Reply with <strong>one thing</strong> we could improve. We read every response.</p>
          <p style="background:#f3f4f6;padding:16px;border-radius:8px;">
            "The thing I'd improve is..."
          </p>
          <p>Just hit reply — we'll take it from there.</p>
        </div>`,
      text: `How's your first week?\n\nReply with one thing we could improve. We read every response.\n\nJust hit reply — we'll take it from there.`,
    }),
  },
  conversion_30d: {
    subject: "Your beta period ends in 30 days — lock in CrewBrief at just $9.99",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Your beta period ends in 30 days</h1>
          <p>Lock in CrewBrief at <strong>$9.99 one-time</strong> or <strong>$4.99/month</strong> — beta pricing that won't last.</p>
          <p><a href="${v.baseUrl}/pricing" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Lock In Beta Pricing</a></p>
        </div>`,
      text: `Your beta period ends in 30 days\n\nLock in CrewBrief at $9.99 one-time or $4.99/month — beta pricing that won't last.\n\n${v.baseUrl}/pricing`,
    }),
  },
  conversion_14d: {
    subject: "Your beta discount expires in 2 weeks — $9.99 lifetime access won't last",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>2 weeks left for beta pricing</h1>
          <p><strong>$9.99 lifetime access</strong> won't be available again. Lock it in now.</p>
          <p><a href="${v.baseUrl}/pricing" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Lock In Beta Pricing</a></p>
        </div>`,
      text: `2 weeks left for beta pricing\n\n$9.99 lifetime access won't be available again. Lock it in now.\n\n${v.baseUrl}/pricing`,
    }),
  },
  conversion_7d: {
    subject: "Last chance for beta pricing — $9.99 one-time or $4.99/mo",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Last chance for beta pricing</h1>
          <p><strong>7 days remaining.</strong> Choose $9.99 one-time or $4.99/month — your choice.</p>
          <p><a href="${v.baseUrl}/pricing" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Choose Your Plan</a></p>
        </div>`,
      text: `Last chance for beta pricing\n\n7 days remaining. Choose $9.99 one-time or $4.99/month — your choice.\n\n${v.baseUrl}/pricing`,
    }),
  },
  beta_expired: {
    subject: "Your CrewBrief beta access has ended",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Your beta period has ended</h1>
          <p>Your data is retained for 90 days. Subscribe to continue using CrewBrief.</p>
          <p><a href="${v.baseUrl}/pricing" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Subscribe Now</a></p>
        </div>`,
      text: `Your beta period has ended\n\nYour data is retained for 90 days. Subscribe to continue using CrewBrief.\n\n${v.baseUrl}/pricing`,
    }),
  },
  reengagement_14d: {
    subject: "Still interested? Your spot is waiting",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>We miss you at CrewBrief</h1>
          <p>It's been a while since your last briefing. Your spot is waiting — generate a new briefing in under 30 seconds.</p>
          <p><a href="${v.baseUrl}/dashboard" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Go to Dashboard</a></p>
        </div>`,
      text: `We miss you at CrewBrief\n\nIt's been a while since your last briefing. Your spot is waiting — generate a new briefing in under 30 seconds.\n\n${v.baseUrl}/dashboard`,
    }),
  },
  exit_survey: {
    subject: "Help us improve CrewBrief",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Help us improve</h1>
          <p>We're sorry to see you go. Tell us what went wrong:</p>
          <p><a href="${v.baseUrl}/exit-survey" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Take Exit Survey</a></p>
          <p style="color:#666;">Your feedback helps us build a better CrewBrief for everyone.</p>
        </div>`,
      text: `Help us improve\n\nWe're sorry to see you go. Tell us what went wrong:\n${v.baseUrl}/exit-survey\n\nYour feedback helps us build a better CrewBrief for everyone.`,
    }),
  },
};

export function crewbriefNurtureService(
  db: Db,
  config: CrewbriefConfig,
  hubspot: CrewbriefHubspotService,
  posthog: CrewbriefPosthogService,
  emailSvc: CrewbriefEmailService,
) {
  function getTemplate(templateName: string): EmailTemplate | undefined {
    return TEMPLATES[templateName];
  }

  function buildTemplateVars(entry: {
    id: string;
    name: string;
    email: string;
    queuePosition: number;
    referralCode: string;
    referralCount: number;
  }, extra?: Record<string, string>): Record<string, string> {
    return {
      name: entry.name,
      email: entry.email,
      queuePosition: String(entry.queuePosition),
      referralCode: entry.referralCode,
      referralCount: String(entry.referralCount),
      baseUrl: config.CREWBRIEF_BASE_URL,
      ...extra,
    };
  }

  async function sendNurtureEmail(
    entryId: string,
    recipientEmail: string,
    templateName: string,
    vars: Record<string, string>,
  ): Promise<{ messageId: string | null; error: string | null }> {
    const template = TEMPLATES[templateName];
    if (!template) {
      return { messageId: null, error: `Unknown template: ${templateName}` };
    }

    const subject = template.subject.replace(
      /\{(\w+)\}/g,
      (_, key) => vars[key] ?? `{${key}}`,
    );
    const { html, text } = template.buildBody(vars);

    const result = await emailSvc.send({
      to: { email: recipientEmail },
      subject,
      htmlBody: html,
      textBody: text,
    });

    await db.insert(crewbriefEmailLog).values({
      waitlistEntryId: entryId,
      email: recipientEmail,
      templateName,
      subject,
      status: result.error ? "failed" : "sent",
      providerMessageId: result.messageId,
      errorMessage: result.error,
    });

    return result;
  }

  async function handleWaitlistSignup(entry: {
    id: string;
    name: string;
    email: string;
    queuePosition: number;
    referralCode: string;
    referralCount: number;
    role?: string;
    source?: string;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    utmTerm?: string | null;
    utmContent?: string | null;
  }): Promise<void> {
    const vars = buildTemplateVars(entry);
    await sendNurtureEmail(entry.id, entry.email, "waitlist_confirmation", vars);

    if (posthog.enabled) {
      const phProps: Record<string, unknown> = {
        email: entry.email,
        referral_code: entry.referralCode,
        queue_position: entry.queuePosition,
      };
      if (entry.role) phProps.operator_role = entry.role;
      if (entry.source) phProps.source = entry.source;
      if (entry.utmSource) phProps.utm_source = entry.utmSource;
      if (entry.utmMedium) phProps.utm_medium = entry.utmMedium;
      if (entry.utmCampaign) phProps.utm_campaign = entry.utmCampaign;
      if (entry.utmTerm) phProps.utm_term = entry.utmTerm;
      if (entry.utmContent) phProps.utm_content = entry.utmContent;
      await posthog.capture("waitlist_signup", entry.email, phProps);
    }

    if (hubspot.enabled) {
      const hsProps: Record<string, string> = {
        email: entry.email,
        name: entry.name,
        source_channel: entry.source ?? "Web Signup",
      };
      if (entry.utmCampaign) hsProps.utm_source_campaign = entry.utmCampaign;
      if (entry.utmMedium) hsProps.utm_source_medium = entry.utmMedium;
      if (entry.utmSource) hsProps.utm_source = entry.utmSource;
      await hubspot.upsertContact(entry.email, hsProps);
    }
  }

  async function handleReferralConversion(
    referrerEntry: {
      id: string;
      name: string;
      email: string;
      queuePosition: number;
      referralCode: string;
      referralCount: number;
    },
    refereeEmail: string,
  ): Promise<void> {
    const vars = buildTemplateVars(referrerEntry, {
      referrerName: referrerEntry.name,
      refereeEmail,
    });
    await sendNurtureEmail(referrerEntry.id, referrerEntry.email, "referral_invite", vars);

    if (posthog.enabled) {
      await posthog.capture("referral_conversion", referrerEntry.email, {
        referrer_email: referrerEntry.email,
        referee_email: refereeEmail,
        referral_code: referrerEntry.referralCode,
      });
    }
  }

  async function handleBetaInvitation(
    entry: {
      id: string;
      name: string;
      email: string;
      queuePosition: number;
      referralCode: string;
      referralCount: number;
    },
    accessToken: string,
  ): Promise<void> {
    const vars = buildTemplateVars(entry, { accessToken });
    await sendNurtureEmail(entry.id, entry.email, "beta_invitation", vars);

    await db
      .update(crewbriefWaitlistEntries)
      .set({ status: "invited", invitedAt: new Date() })
      .where(eq(crewbriefWaitlistEntries.id, entry.id));

    if (posthog.enabled) {
      await posthog.capture("beta_invitation_sent", entry.email, {
        user_email: entry.email,
        invitation_type: "email",
      });
    }

    if (hubspot.enabled) {
      await hubspot.upsertContact(entry.email, {
        email: entry.email,
        name: entry.name,
      });
    }
  }

  async function handleBetaActivation(
    entry: {
      id: string;
      name: string;
      email: string;
      queuePosition: number;
      referralCode: string;
      referralCount: number;
    },
  ): Promise<void> {
    await db
      .update(crewbriefWaitlistEntries)
      .set({ status: "activated", betaActivatedAt: new Date() })
      .where(eq(crewbriefWaitlistEntries.id, entry.id));

    const nDays: Array<{ template: string; delayDays: number }> = [
      { template: "beta_welcome_day1", delayDays: 1 },
      { template: "onboarding_tips_day2", delayDays: 2 },
      { template: "feature_spotlight_day4", delayDays: 4 },
      { template: "week1_checkin_day7", delayDays: 7 },
    ];

    for (const { template, delayDays } of nDays) {
      const vars = buildTemplateVars(entry);
      const sendAt = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000);
      await scheduleEmail(entry.id, entry.email, template, vars, sendAt);
    }

    if (posthog.enabled) {
      await posthog.capture("beta_activation", entry.email, {
        user_id: entry.id,
      });
    }

    if (hubspot.enabled) {
      await hubspot.upsertContact(entry.email, {
        email: entry.email,
        name: entry.name,
        trial_started: new Date().toISOString().split("T")[0],
      });
    }
  }

  async function scheduleEmail(
    entryId: string,
    email: string,
    templateName: string,
    vars: Record<string, string>,
    sendAt: Date,
  ): Promise<void> {
    await db.insert(crewbriefEmailLog).values({
      waitlistEntryId: entryId,
      email,
      templateName,
      subject: "(scheduled)",
      status: "scheduled",
      sentAt: sendAt,
    });
  }

  async function processScheduledEmails(): Promise<number> {
    const now = new Date();
    const scheduled = await db
      .select()
      .from(crewbriefEmailLog)
      .where(
        and(
          eq(crewbriefEmailLog.status, "scheduled"),
          lte(crewbriefEmailLog.sentAt, now),
        ),
      )
      .limit(50);

    let sent = 0;
    for (const log of scheduled) {
      const template = TEMPLATES[log.templateName];
      if (!template) {
        await db
          .update(crewbriefEmailLog)
          .set({ status: "failed", errorMessage: "Unknown template" })
          .where(eq(crewbriefEmailLog.id, log.id));
        continue;
      }

      let entryRow: { name: string; queuePosition: number; referralCode: string; referralCount: number } | null = null;
      if (log.waitlistEntryId) {
        const rows = await db
          .select({
            name: crewbriefWaitlistEntries.name,
            queuePosition: crewbriefWaitlistEntries.queuePosition,
            referralCode: crewbriefWaitlistEntries.referralCode,
            referralCount: crewbriefWaitlistEntries.referralCount,
          })
          .from(crewbriefWaitlistEntries)
          .where(eq(crewbriefWaitlistEntries.id, log.waitlistEntryId))
          .limit(1);
        entryRow = rows[0] ?? null;
      }

      const vars: Record<string, string> = {
        name: entryRow?.name ?? "",
        email: log.email,
        queuePosition: String(entryRow?.queuePosition ?? ""),
        referralCode: entryRow?.referralCode ?? "",
        referralCount: String(entryRow?.referralCount ?? 0),
        baseUrl: config.CREWBRIEF_BASE_URL,
      };

      const subject = template.subject.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
      const { html, text } = template.buildBody(vars);

      const result = await emailSvc.send({
        to: { email: log.email },
        subject,
        htmlBody: html,
        textBody: text,
      });

      await db
        .update(crewbriefEmailLog)
        .set({
          status: result.error ? "failed" : "sent",
          providerMessageId: result.messageId,
          errorMessage: result.error,
          subject,
        })
        .where(eq(crewbriefEmailLog.id, log.id));

      sent++;
    }
    return sent;
  }

  return {
    getTemplate,
    sendNurtureEmail,
    handleWaitlistSignup,
    handleReferralConversion,
    handleBetaInvitation,
    handleBetaActivation,
    processScheduledEmails,
  };
}

export type CrewbriefNurtureService = ReturnType<typeof crewbriefNurtureService>;
