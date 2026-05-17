import type { Db } from "@paperclipai/db";
import { and, eq, lte, gte, isNull } from "drizzle-orm";
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

  /* ───────── Sequence 1: Beta Welcome & Activation ───────── */

  seq1_email1: {
    subject: "Welcome to CrewBrief — your first briefing is waiting",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Welcome to CrewBrief</h1>
          <p>Hi ${v.name},</p>
          <p>Welcome to CrewBrief. You're now part of the beta — alongside 20+ operators already running safer, faster briefings.</p>
          <p><strong>Here's your 3-step start:</strong></p>
          <ol>
            <li><strong>Log in</strong> at <a href="${v.baseUrl}">crewbrief.avva.aero</a></li>
            <li><strong>Enter your first flight details</strong> — route, aircraft, crew</li>
            <li><strong>Generate your briefing</strong> — weather, NOTAMs, risk score, all in one place</li>
          </ol>
          <p>Your first briefing takes ~2 minutes. Try it now.</p>
          <p><a href="${v.baseUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Start My First Briefing →</a></p>
          <p>— The CrewBrief Team</p>
          <p style="color:#666;">P.S. Got questions? Just reply to this email. We read every one.</p>
        </div>`,
      text: `Welcome to CrewBrief\n\nHi ${v.name},\n\nWelcome to CrewBrief. You're now part of the beta — alongside 20+ operators already running safer, faster briefings.\n\nHere's your 3-step start:\n1. Log in at ${v.baseUrl}\n2. Enter your first flight details — route, aircraft, crew\n3. Generate your briefing — weather, NOTAMs, risk score, all in one place\n\nYour first briefing takes ~2 minutes. Try it now.\n${v.baseUrl}\n\n— The CrewBrief Team\n\nP.S. Got questions? Just reply to this email. We read every one.`,
    }),
  },
  seq1_email2: {
    subject: "3 features that make CrewBrief indispensable",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>3 features that make CrewBrief indispensable</h1>
          <p>Hi ${v.name},</p>
          <p>You've seen the basics. Here's what makes CrewBrief different:</p>
          <p><strong>1. Integrated FRAT (Flight Risk Assessment Tool)</strong><br/>Automatically scored from your route data. No separate spreadsheet.</p>
          <p><strong>2. Warning Catalog</strong><br/>Weather, NOTAMs, airspace restrictions — cross-referenced against your specific route.</p>
          <p><strong>3. Separate Cabin & Cockpit Briefings</strong><br/>One click. Tailored content for each crew role.</p>
          <p><a href="${v.baseUrl}/features" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Explore the Features →</a></p>
          <p>— The CrewBrief Team</p>
        </div>`,
      text: `3 features that make CrewBrief indispensable\n\nHi ${v.name},\n\nYou've seen the basics. Here's what makes CrewBrief different:\n\n1. Integrated FRAT — automatically scored from your route data.\n2. Warning Catalog — cross-referenced against your specific route.\n3. Separate Cabin & Cockpit Briefings — tailored for each crew role.\n\nExplore the Features: ${v.baseUrl}/features\n\n— The CrewBrief Team`,
    }),
  },
  seq1_email3: {
    subject: "How [Operator] cut briefing time by 60%",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>How operators cut briefing time by 60%</h1>
          <p>Hi ${v.name},</p>
          <blockquote style="border-left:4px solid #2563eb;padding-left:16px;margin:16px 0;color:#374151;">
            "We used to spend 20-30 minutes per leg pulling weather, NOTAMs, and fuel data from five different sources. Now it's one click and we're done."<br/>
            — Director of Ops
          </blockquote>
          <p>Since switching to CrewBrief, operators have:</p>
          <ul>
            <li>Reduced average briefing time from 22min → 8min</li>
            <li>Standardized risk assessment across all pilots</li>
            <li>Eliminated missed NOTAMs</li>
          </ul>
          <p><a href="${v.baseUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Generate Your Next Briefing →</a></p>
          <p>— The CrewBrief Team</p>
        </div>`,
      text: `How operators cut briefing time by 60%\n\nHi ${v.name},\n\n"${v.name ? `We used to spend 20-30 minutes per leg... Now it's one click and we're done." — Director of Ops` : 'CrewBrief cuts briefing time by 60%.'}"\n\nSince switching to CrewBrief, operators have:\n- Reduced average briefing time from 22min → 8min\n- Standardized risk assessment across all pilots\n- Eliminated missed NOTAMs\n\n${v.baseUrl}\n\n— The CrewBrief Team`,
    }),
  },
  seq1_email4: {
    subject: "Your first week with CrewBrief — here's what to try",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Your first week with CrewBrief</h1>
          <p>Hi ${v.name},</p>
          <p>You're a week in. Here's the checklist for getting the most out of your beta trial:</p>
          <ul>
            <li><input type="checkbox" disabled/> Generate 3 briefings for different route types</li>
            <li><input type="checkbox" disabled/> Invite a colleague — see the crew view together</li>
            <li><input type="checkbox" disabled/> Review your FRAT scores — compare with your current process</li>
          </ul>
          <p><a href="${v.baseUrl}/dashboard" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Open CrewBrief →</a></p>
          <p>Each one takes ~2 minutes. You'll see the full picture by briefing #3.</p>
          <p>— The CrewBrief Team</p>
        </div>`,
      text: `Your first week with CrewBrief\n\nHi ${v.name},\n\nYou're a week in. Here's the checklist:\n- Generate 3 briefings for different route types\n- Invite a colleague — see the crew view together\n- Review your FRAT scores — compare with your current process\n\n${v.baseUrl}/dashboard\n\n— The CrewBrief Team`,
    }),
  },
  seq1_email5: {
    subject: "Your beta trial is ready to upgrade",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Your beta trial is ready to upgrade</h1>
          <p>Hi ${v.name},</p>
          <p>You've had a week to experience CrewBrief. Now it's time to make it permanent.</p>
          <p><strong>Pro plan unlocks:</strong></p>
          <ul>
            <li>Unlimited briefings</li>
            <li>Priority email & phone support</li>
            <li>Advanced FRAT configuration</li>
            <li>Multi-crew coordination</li>
            <li>Custom briefing templates</li>
          </ul>
          <p><a href="${v.baseUrl}/pricing" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Upgrade to Pro →</a></p>
          <p>Still have questions? Reply to this email — happy to hop on a quick call.</p>
          <p>— The CrewBrief Team</p>
        </div>`,
      text: `Your beta trial is ready to upgrade\n\nHi ${v.name},\n\nYou've had a week to experience CrewBrief. Now it's time to make it permanent.\n\nPro plan unlocks:\n- Unlimited briefings\n- Priority email & phone support\n- Advanced FRAT configuration\n- Multi-crew coordination\n- Custom briefing templates\n\n${v.baseUrl}/pricing\n\n— The CrewBrief Team`,
    }),
  },

  /* ───────── Sequence 2: Cold Lead Re-engagement ───────── */

  seq2_email1: {
    subject: "We've been busy — here's what's new at CrewBrief",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>We've been busy</h1>
          <p>Hi ${v.name},</p>
          <p>It's been a couple of weeks. Since your last visit, we've shipped:</p>
          <ul>
            <li><strong>Faster briefings</strong> — load times cut in half</li>
            <li><strong>Improved NOTAM filtering</strong> — only what's relevant to your route</li>
            <li><strong>New integrations</strong> — more data sources added</li>
          </ul>
          <p>Come see what's changed. Your account is still active.</p>
          <p><a href="${v.baseUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Log In →</a></p>
          <p>— The CrewBrief Team</p>
        </div>`,
      text: `We've been busy\n\nHi ${v.name},\n\nIt's been a couple of weeks. Since your last visit, we've shipped:\n- Faster briefings — load times cut in half\n- Improved NOTAM filtering — only what's relevant to your route\n- New integrations — more data sources added\n\nCome see what's changed. Your account is still active.\n${v.baseUrl}\n\n— The CrewBrief Team`,
    }),
  },
  seq2_email2: {
    subject: "This one feature saves pilots 10+ minutes per briefing",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Automated FRAT Scoring</h1>
          <p>Hi ${v.name},</p>
          <p>The most popular CrewBrief feature? <strong>Automated FRAT scoring.</strong></p>
          <p>Instead of manually filling out a risk matrix, CrewBrief calculates your flight risk score automatically — pulling from route data, weather, crew experience, and aircraft type.</p>
          <blockquote style="border-left:4px solid #2563eb;padding-left:16px;margin:16px 0;color:#374151;">
            "I used to dread FRAT paperwork. Now it's done before I finish my coffee." — Captain
          </blockquote>
          <p><a href="${v.baseUrl}/features/frat" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Try FRAT Now →</a></p>
          <p>— The CrewBrief Team</p>
        </div>`,
      text: `Automated FRAT Scoring\n\nHi ${v.name},\n\nThe most popular CrewBrief feature? Automated FRAT scoring.\n\nInstead of manually filling out a risk matrix, CrewBrief calculates your flight risk score automatically — pulling from route data, weather, crew experience, and aircraft type.\n\n"${v.name ? `I used to dread FRAT paperwork. Now it's done before I finish my coffee." — Captain` : ''}"\n\nTry FRAT Now: ${v.baseUrl}/features/frat\n\n— The CrewBrief Team`,
    }),
  },
  seq2_email3: {
    subject: "Don't lose access — extend your trial",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Don't lose access</h1>
          <p>Hi ${v.name},</p>
          <p>We noticed you haven't logged in recently. We'd hate for you to miss out on what CrewBrief can do for your operation.</p>
          <p><strong>Here's a one-click trial extension</strong> — 14 more days, no commitment.</p>
          <p><a href="${v.baseUrl}/reactivate" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Extend My Trial →</a></p>
          <p>If CrewBrief isn't the right fit right now, no hard feelings. Just unsubscribe below.</p>
          <p>— The CrewBrief Team</p>
        </div>`,
      text: `Don't lose access\n\nHi ${v.name},\n\nWe noticed you haven't logged in recently. We'd hate for you to miss out.\n\nHere's a one-click trial extension — 14 more days, no commitment.\n${v.baseUrl}/reactivate\n\nIf CrewBrief isn't the right fit right now, no hard feelings.\n\n— The CrewBrief Team`,
    }),
  },

  /* ───────── Sequence 3: Trial-to-Paid Conversion ───────── */

  seq3_email1: {
    subject: "You've generated {briefingCount} briefings — nice work",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Your trial progress</h1>
          <p>Hi ${v.name},</p>
          <p>Quick check-in: you've generated <strong>${v.briefingCount || 0} briefings</strong> so far.</p>
          <p>Here's what you've accomplished:</p>
          <ul>
            <li>Routes briefed: ${v.routesCount || 0}</li>
            <li>Risk assessments completed: ${v.fratsCompleted || 0}</li>
            <li>Time saved: ~${v.timeSaved || 0} minutes (vs. manual briefing)</li>
          </ul>
          <p><strong>You're halfway through your trial.</strong> The Pro plan unlocks everything you've been using — plus priority support, custom templates, and crew management.</p>
          <p><a href="${v.baseUrl}/pricing" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">See Pro Plan Details →</a></p>
          <p>— The CrewBrief Team</p>
        </div>`,
      text: `Your trial progress\n\nHi ${v.name},\n\nQuick check-in: you've generated ${v.briefingCount || 0} briefings so far.\n\nRoutes briefed: ${v.routesCount || 0}\nRisk assessments completed: ${v.fratsCompleted || 0}\nTime saved: ~${v.timeSaved || 0} minutes\n\nYou're halfway through your trial. The Pro plan unlocks everything you've been using.\n\n${v.baseUrl}/pricing\n\n— The CrewBrief Team`,
    }),
  },
  seq3_email2: {
    subject: "Your trial ends in 4 days — here's what changes",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Your trial ends in 4 days</h1>
          <p>Hi ${v.name},</p>
          <p>Your CrewBrief trial ends in <strong>4 days</strong>. After that:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr style="background:#f3f4f6;"><th style="padding:8px;border:1px solid #d1d5db;">Feature</th><th style="padding:8px;border:1px solid #d1d5db;">Trial</th><th style="padding:8px;border:1px solid #d1d5db;">Pro</th></tr>
            <tr><td style="padding:8px;border:1px solid #d1d5db;">Briefings</td><td style="padding:8px;border:1px solid #d1d5db;">10 total</td><td style="padding:8px;border:1px solid #d1d5db;">Unlimited</td></tr>
            <tr><td style="padding:8px;border:1px solid #d1d5db;">FRAT scoring</td><td style="padding:8px;border:1px solid #d1d5db;">✓</td><td style="padding:8px;border:1px solid #d1d5db;">✓ Advanced config</td></tr>
            <tr><td style="padding:8px;border:1px solid #d1d5db;">Crew accounts</td><td style="padding:8px;border:1px solid #d1d5db;">1</td><td style="padding:8px;border:1px solid #d1d5db;">Unlimited</td></tr>
            <tr><td style="padding:8px;border:1px solid #d1d5db;">Support</td><td style="padding:8px;border:1px solid #d1d5db;">Email</td><td style="padding:8px;border:1px solid #d1d5db;">Priority + Phone</td></tr>
            <tr><td style="padding:8px;border:1px solid #d1d5db;">Templates</td><td style="padding:8px;border:1px solid #d1d5db;">Default</td><td style="padding:8px;border:1px solid #d1d5db;">Custom</td></tr>
          </table>
          <p><a href="${v.baseUrl}/upgrade" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Keep My Access →</a></p>
          <p>— The CrewBrief Team</p>
        </div>`,
      text: `Your trial ends in 4 days\n\nHi ${v.name},\n\nYour CrewBrief trial ends in 4 days. After that: briefings limited, crew accounts limited, and custom templates disabled.\n\nDon't lose access to your briefings. Upgrade keeps everything intact.\n${v.baseUrl}/upgrade\n\n— The CrewBrief Team`,
    }),
  },
  seq3_email3: {
    subject: "Your CrewBrief trial has ended — but here's a backup plan",
    buildBody: (v) => ({
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h1>Your trial has ended</h1>
          <p>Hi ${v.name},</p>
          <p>Your trial has ended, and your Pro features have been paused.</p>
          <p><strong>But here's the thing:</strong> we want you to succeed with CrewBrief. If you need more time to evaluate, we're happy to grant a <strong>7-day extension</strong> — just click below.</p>
          <p><a href="${v.baseUrl}/extend" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Extend Trial 7 Days →</a></p>
          <p>Or, if you're ready:</p>
          <p><a href="${v.baseUrl}/upgrade" style="background:#10b981;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Upgrade to Pro →</a></p>
          <p>Questions? Reply to this email. We'll get back to you within 2 hours.</p>
          <p>— The CrewBrief Team</p>
        </div>`,
      text: `Your trial has ended\n\nHi ${v.name},\n\nYour trial has ended, and your Pro features have been paused.\n\nBut here's the thing: we want you to succeed. If you need more time, click for a 7-day extension:\n${v.baseUrl}/extend\n\nOr upgrade to Pro:\n${v.baseUrl}/upgrade\n\n— The CrewBrief Team`,
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

  /* ───────── Sequence Definitions ───────── */

  const SEQUENCES: Array<{
    id: string;
    name: string;
    description: string;
    triggerDescription: string;
    emails: Array<{
      templateName: string;
      subject: string;
      delayDays: number;
    }>;
  }> = [
    {
      id: "seq1_beta_welcome",
      name: "Beta Welcome & Activation",
      description: "Activate new signups → generate first briefing → nurture to paid",
      triggerDescription: "New waitlist signup with status = activated",
      emails: [
        { templateName: "seq1_email1", subject: "Welcome to CrewBrief — your first briefing is waiting", delayDays: 0 },
        { templateName: "seq1_email2", subject: "3 features that make CrewBrief indispensable", delayDays: 1 },
        { templateName: "seq1_email3", subject: "How operators cut briefing time by 60%", delayDays: 3 },
        { templateName: "seq1_email4", subject: "Your first week with CrewBrief — here's what to try", delayDays: 5 },
        { templateName: "seq1_email5", subject: "Your beta trial is ready to upgrade", delayDays: 7 },
      ],
    },
    {
      id: "seq2_cold_reengagement",
      name: "Cold Lead Re-engagement",
      description: "Re-activate inactive signups (no login >14 days)",
      triggerDescription: "last_active_date >= 14 days, not paid",
      emails: [
        { templateName: "seq2_email1", subject: "We've been busy — here's what's new at CrewBrief", delayDays: 0 },
        { templateName: "seq2_email2", subject: "This one feature saves pilots 10+ minutes per briefing", delayDays: 3 },
        { templateName: "seq2_email3", subject: "Don't lose access — extend your trial", delayDays: 7 },
      ],
    },
    {
      id: "seq3_trial_conversion",
      name: "Trial-to-Paid Conversion",
      description: "Convert active trial users to paid subscribers",
      triggerDescription: "Trial day 5, lifecyclestage = opportunity, not yet paid",
      emails: [
        { templateName: "seq3_email1", subject: "You've generated {briefingCount} briefings — nice work", delayDays: 0 },
        { templateName: "seq3_email2", subject: "Your trial ends in 4 days — here's what changes", delayDays: 5 },
        { templateName: "seq3_email3", subject: "Your CrewBrief trial has ended — but here's a backup plan", delayDays: 9 },
      ],
    },
  ];

  async function enrollInSequence(
    entryId: string,
    email: string,
    entry: { id: string; name: string; email: string; queuePosition: number; referralCode: string; referralCount: number },
    sequenceId: string,
  ): Promise<string | null> {
    const seq = SEQUENCES.find((s) => s.id === sequenceId);
    if (!seq) return `Unknown sequence: ${sequenceId}`;

    const existing = await db
      .select()
      .from(crewbriefEmailLog)
      .where(
        and(
          eq(crewbriefEmailLog.waitlistEntryId, entryId),
          eq(crewbriefEmailLog.templateName, `${sequenceId}_enrolled`),
        ),
      )
      .limit(1);

    if (existing.length > 0) return null;

    const vars = buildTemplateVars(entry);

    for (const emailDef of seq.emails) {
      const sendAt = new Date(Date.now() + emailDef.delayDays * 24 * 60 * 60 * 1000);
      const eVars = { ...vars, briefingCount: "0", routesCount: "0", fratsCompleted: "0", timeSaved: "0" };
      await scheduleEmail(entryId, email, emailDef.templateName, eVars, sendAt);
    }

    await db.insert(crewbriefEmailLog).values({
      waitlistEntryId: entryId,
      email,
      templateName: `${sequenceId}_enrolled`,
      subject: `Enrolled in ${seq.name}`,
      status: "sent",
    });

    if (posthog.enabled) {
      await posthog.capture("sequence_enrolled", email, {
        sequence_name: seq.name,
        sequence_id: sequenceId,
        contact_id: entryId,
      });
    }

    return null;
  }

  async function checkSeq1Enrollments(): Promise<number> {
    const activated = await db
      .select()
      .from(crewbriefWaitlistEntries)
      .where(eq(crewbriefWaitlistEntries.status, "activated"))
      .limit(50);

    let enrolled = 0;
    for (const entry of activated) {
      const alreadySeq1 = await db
        .select()
        .from(crewbriefEmailLog)
        .where(
          and(
            eq(crewbriefEmailLog.waitlistEntryId, entry.id),
            eq(crewbriefEmailLog.templateName, "seq1_beta_welcome_enrolled"),
          ),
        )
        .limit(1);
      if (alreadySeq1.length > 0) continue;

      const err = await enrollInSequence(
        entry.id, entry.email,
        { id: entry.id, name: entry.name, email: entry.email, queuePosition: entry.queuePosition, referralCode: entry.referralCode, referralCount: entry.referralCount },
        "seq1_beta_welcome",
      );
      if (!err) enrolled++;
    }
    return enrolled;
  }

  async function checkSeq2Enrollments(): Promise<number> {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const inactives = await db
      .select()
      .from(crewbriefWaitlistEntries)
      .where(
        and(
          eq(crewbriefWaitlistEntries.status, "activated"),
          lte(crewbriefWaitlistEntries.createdAt, fourteenDaysAgo),
          isNull(crewbriefWaitlistEntries.lastActiveDate),
        ),
      )
      .limit(50);

    let enrolled = 0;
    for (const entry of inactives) {
      const alreadySeq2 = await db
        .select()
        .from(crewbriefEmailLog)
        .where(
          and(
            eq(crewbriefEmailLog.waitlistEntryId, entry.id),
            eq(crewbriefEmailLog.templateName, "seq2_cold_reengagement_enrolled"),
          ),
        )
        .limit(1);
      if (alreadySeq2.length > 0) continue;

      const err = await enrollInSequence(
        entry.id, entry.email,
        { id: entry.id, name: entry.name, email: entry.email, queuePosition: entry.queuePosition, referralCode: entry.referralCode, referralCount: entry.referralCount },
        "seq2_cold_reengagement",
      );
      if (!err) enrolled++;
    }
    return enrolled;
  }

  async function checkSeq3Enrollments(): Promise<number> {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const trialUsers = await db
      .select()
      .from(crewbriefWaitlistEntries)
      .where(
        and(
          eq(crewbriefWaitlistEntries.status, "activated"),
          lte(crewbriefWaitlistEntries.createdAt, fiveDaysAgo),
        ),
      )
      .limit(50);

    let enrolled = 0;
    for (const entry of trialUsers) {
      const alreadySeq3 = await db
        .select()
        .from(crewbriefEmailLog)
        .where(
          and(
            eq(crewbriefEmailLog.waitlistEntryId, entry.id),
            eq(crewbriefEmailLog.templateName, "seq3_trial_conversion_enrolled"),
          ),
        )
        .limit(1);
      if (alreadySeq3.length > 0) continue;

      const err = await enrollInSequence(
        entry.id, entry.email,
        { id: entry.id, name: entry.name, email: entry.email, queuePosition: entry.queuePosition, referralCode: entry.referralCode, referralCount: entry.referralCount },
        "seq3_trial_conversion",
      );
      if (!err) enrolled++;
    }
    return enrolled;
  }

  async function checkAllEnrollments(): Promise<{ seq1: number; seq2: number; seq3: number }> {
    const [seq1, seq2, seq3] = await Promise.all([
      checkSeq1Enrollments(),
      checkSeq2Enrollments(),
      checkSeq3Enrollments(),
    ]);
    return { seq1, seq2, seq3 };
  }

  async function handleEmailEvent(
    eventType: string,
    email: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    if (!posthog.enabled) return;
    await posthog.capture(eventType, email, properties);
  }

  return {
    getTemplate,
    sendNurtureEmail,
    handleWaitlistSignup,
    handleReferralConversion,
    handleBetaInvitation,
    handleBetaActivation,
    processScheduledEmails,
    checkAllEnrollments,
    enrollInSequence,
    handleEmailEvent,
    SEQUENCES,
  };
}

export type CrewbriefNurtureService = ReturnType<typeof crewbriefNurtureService>;
