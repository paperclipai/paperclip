import type { AgnbJobDef } from "./types.js";
import { rssSync } from "./rss-sync.js";
// Rocket family
import { rocketPersonas } from "./rocket-personas.js";
import { rocketProducts } from "./rocket-products.js";
import { inboxSync } from "./inbox-sync.js";
import { previewLeadsJob } from "./preview-leads.js";
// LLM content family
import { blogAutoDrafter } from "./blog-auto-drafter.js";
import { changelogDrafter } from "./changelog-drafter.js";
import { newsletterDrafter } from "./newsletter-drafter.js";
import { gapAnalyzer } from "./gap-analyzer.js";
import { gapToIdea } from "./gap-to-idea.js";
import { negativeSignalWatch } from "./negative-signal-watch.js";
import { reviewsSync } from "./reviews-sync.js";
import { sovWatch } from "./sov-watch.js";
import { backlinkOutreachDrafter } from "./backlink-outreach-drafter.js";
import { crossChannelRepurpose } from "./cross-channel-repurpose.js";
import { contentAudit } from "./content-audit.js";
import { tagReplies } from "./tag-replies.js";
// SEO / scrapers family
import { gscRankTracker } from "./gsc-rank-tracker.js";
import { sitemapScraper } from "./sitemap-scraper.js";
import { backlinkProspector } from "./backlink-prospector.js";
import { backlinkHealth } from "./backlink-health.js";
import { linkStrength } from "./link-strength.js";
// Analytics / daily family
import { posthogSync } from "./posthog-sync.js";
import { hubspotDealsSync } from "./hubspot-deals-sync.js";
import { dailyBrief } from "./daily-brief.js";
import { dailyDigest } from "./daily-digest.js";
import { notificationDispatcher } from "./notification-dispatcher.js";
import { renewalReminders } from "./renewal-reminders.js";
// Hygiene / intake family
import { crmHygieneScan } from "./crm-hygiene-scan.js";
import { utmHygieneScan } from "./utm-hygiene-scan.js";
import { csvUpload } from "./csv-upload.js";
import { whatsappIntake } from "./whatsapp-intake.js";
import { linkedinPoster } from "./linkedin-poster.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * AGNB job registry — the worker jobs ported from the standalone app (Phase 5).
 * Cadences are sensible defaults (the original used an external cron service
 * with no in-repo schedule config).
 *
 * enabledByDefault: jobs with EXTERNAL WRITE/SEND/POST side-effects or heavy
 * external quota are default-OFF to avoid surprise live actions on a timer.
 * Enable them per-instance via POST /api/agnb/jobs/:key/toggle?enabled=true.
 * Every job also self-skips when its required env keys are unset.
 */
export const AGNB_JOBS: AgnbJobDef[] = [
  // ── reads / DB-writes / drafts — safe to run on a timer ──
  { key: "rss-sync", intervalMs: 6 * HOUR, handler: rssSync, enabledByDefault: true },
  { key: "rocket-personas", intervalMs: 12 * HOUR, handler: rocketPersonas, requiresEnv: ["ROCKETSDR_API_KEY"], enabledByDefault: true },
  { key: "rocket-products", intervalMs: 12 * HOUR, handler: rocketProducts, requiresEnv: ["ROCKETSDR_API_KEY"], enabledByDefault: true },
  { key: "inbox-sync", intervalMs: 30 * MIN, handler: inboxSync, requiresEnv: ["ROCKETSDR_API_KEY"], enabledByDefault: true },
  { key: "blog-auto-drafter", intervalMs: 1 * DAY, handler: blogAutoDrafter, requiresEnv: ["GEMINI_API_KEY"], enabledByDefault: false }, // disabled: blog drafting now owned by Paperclip "Blog" project agents (Content Strategist -> Blog Writer)
  { key: "changelog-drafter", intervalMs: 1 * DAY, handler: changelogDrafter, requiresEnv: ["GEMINI_API_KEY"], enabledByDefault: true },
  { key: "gap-analyzer", intervalMs: 1 * DAY, handler: gapAnalyzer, requiresEnv: ["GEMINI_API_KEY"], enabledByDefault: true },
  { key: "gap-to-idea", intervalMs: 1 * DAY, handler: gapToIdea, enabledByDefault: true },
  { key: "negative-signal-watch", intervalMs: 1 * HOUR, handler: negativeSignalWatch, enabledByDefault: true },
  { key: "reviews-sync", intervalMs: 1 * DAY, handler: reviewsSync, requiresEnv: ["SERPAPI_KEY"], enabledByDefault: true },
  { key: "sov-watch", intervalMs: 1 * DAY, handler: sovWatch, enabledByDefault: true },
  { key: "backlink-outreach-drafter", intervalMs: 1 * DAY, handler: backlinkOutreachDrafter, requiresEnv: ["GEMINI_API_KEY"], enabledByDefault: true },
  { key: "cross-channel-repurpose", intervalMs: 1 * DAY, handler: crossChannelRepurpose, enabledByDefault: true },
  { key: "content-audit", intervalMs: 1 * DAY, handler: contentAudit, enabledByDefault: true },
  { key: "tag-replies", intervalMs: 1 * HOUR, handler: tagReplies, requiresEnv: ["GEMINI_API_KEY"], enabledByDefault: true },
  { key: "gsc-rank-tracker", intervalMs: 1 * DAY, handler: gscRankTracker, enabledByDefault: true },
  { key: "sitemap-scraper", intervalMs: 1 * DAY, handler: sitemapScraper, enabledByDefault: true },
  { key: "backlink-prospector", intervalMs: 1 * DAY, handler: backlinkProspector, requiresEnv: ["GEMINI_API_KEY"], enabledByDefault: true },
  { key: "backlink-health", intervalMs: 6 * HOUR, handler: backlinkHealth, enabledByDefault: true },
  { key: "link-strength", intervalMs: 1 * DAY, handler: linkStrength, enabledByDefault: true },
  { key: "posthog-sync", intervalMs: 1 * HOUR, handler: posthogSync, requiresEnv: ["POSTHOG_PROJECT_ID", "POSTHOG_PERSONAL_API_KEY"], enabledByDefault: true },
  { key: "hubspot-deals-sync", intervalMs: 1 * HOUR, handler: hubspotDealsSync, requiresEnv: ["HUBSPOT_TOKEN"], enabledByDefault: true },
  { key: "daily-brief", intervalMs: 1 * DAY, handler: dailyBrief, enabledByDefault: true },
  { key: "daily-digest", intervalMs: 1 * DAY, handler: dailyDigest, enabledByDefault: true },
  { key: "renewal-reminders", intervalMs: 1 * DAY, handler: renewalReminders, enabledByDefault: true },
  { key: "crm-hygiene-scan", intervalMs: 1 * DAY, handler: crmHygieneScan, requiresEnv: ["HUBSPOT_TOKEN"], enabledByDefault: true },
  { key: "utm-hygiene-scan", intervalMs: 1 * DAY, handler: utmHygieneScan, enabledByDefault: true },
  { key: "whatsapp-intake", intervalMs: 15 * MIN, handler: whatsappIntake, requiresEnv: ["GEMINI_API_KEY"], enabledByDefault: true },

  // ── external WRITE/SEND/POST or heavy quota — default OFF, enable per instance ──
  { key: "notification-dispatcher", intervalMs: 10 * MIN, handler: notificationDispatcher, enabledByDefault: false },
  { key: "newsletter-drafter", intervalMs: 7 * DAY, handler: newsletterDrafter, requiresEnv: ["GEMINI_API_KEY"], enabledByDefault: false },
  { key: "linkedin-poster", intervalMs: 1 * HOUR, handler: linkedinPoster, enabledByDefault: false },
  { key: "preview-leads", intervalMs: 1 * DAY, handler: previewLeadsJob, requiresEnv: ["ROCKETSDR_API_KEY"], enabledByDefault: false },
  { key: "csv-upload", intervalMs: 1 * HOUR, handler: csvUpload, enabledByDefault: false },
];
