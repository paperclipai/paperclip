import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { appDefinitionDisplayName, appDefinitionName, appDefinitionText } from "./app-definition-display";
import { APP_DEFINITION_COPY } from "./app-definition-copy";

// Exact reviewed exceptions: brands, protocol/credential examples, and canonical metadata.
// A source edit or a new display field must be reviewed instead of silently exempted.
const untranslated: Record<string, string> = {
  "agentmail.name": "AgentMail",
  "agentmail.methods.0.credentialFields.0.placeholder": "am_…",
  "airtable.name": "Airtable",
  "anthropic.name": "Anthropic",
  "anthropic.methods.1.keyPlacement.name": "ANTHROPIC_API_KEY",
  "api-key-generic.methods.0.keyPlacement.name": "Authorization",
  "arcade.name": "Arcade",
  "asana.name": "Asana",
  "bedrock.name": "Amazon Bedrock",
  "bedrock.methods.0.keyPlacement.name": "AWS_BEARER_TOKEN_BEDROCK",
  "beehiiv.name": "beehiiv",
  "bitly.name": "Bitly",
  "bitly.methods.1.keyPlacement.name": "Authorization",
  "box.name": "Box",
  "brex.name": "Brex",
  "browser-use-cloud.name": "Browser Use Cloud",
  "browser-use-cloud.methods.0.label": "Browser Use Cloud",
  "browser-use-cloud.methods.0.credentialFields.0.placeholder": "bu_…",
  "browser-use-cloud.methods.0.keyPlacement.name": "X-Browser-Use-API-Key",
  "candid.name": "Candid",
  "chat-completions-api.name": "Chat Completions API",
  "chat-completions-api.methods.0.keyPlacement.name": "OPENAI_API_KEY",
  "clickhouse.name": "ClickHouse",
  "clickhouse.methods.0.tenantFields.0.placeholder": "11e1031f-9a13-4cac-9bc7-d4ec9286ec17",
  "clickhouse.methods.0.tenantFields.0.transport.name": "x-service-id",
  "cloudflare.name": "Cloudflare",
  "cloudflare.methods.1.keyPlacement.name": "Authorization",
  "cloudinary.name": "Cloudinary",
  "coda.name": "Coda",
  "coda.methods.1.keyPlacement.name": "Authorization",
  "cognee.name": "Cognee",
  "cognee.methods.0.credentialFields.0.placeholder": "https://your-tenant.aws.cognee.ai",
  "cognee.methods.0.keyPlacement.name": "COGNEE_API_KEY",
  "composio.name": "Composio",
  "composio.methods.0.label": "Composio Connect",
  "context7.name": "Context7",
  "discord.name": "Discord",
  "discord.methods.0.credentialFields.1.placeholder": "123456789012345678",
  "discord.methods.0.credentialFields.2.placeholder": "123456789012345678",
  "egnyte.name": "Egnyte",
  "embat.name": "Embat",
  "enterpret.name": "Enterpret",
  "enterpret.methods.0.keyPlacement.name": "Authorization",
  "executor.name": "Executor",
  "fireflies.name": "Fireflies",
  "fireflies.methods.1.keyPlacement.name": "Authorization",
  "github-code-review-bot.methods.0.credentialFields.0.placeholder": "123456",
  "github-code-review-bot.methods.0.credentialFields.1.placeholder": "-----BEGIN RSA PRIVATE KEY-----",
  "github.name": "GitHub",
  "github.methods.1.credentialFields.0.placeholder": "github_pat_...",
  "github.methods.1.keyPlacement.name": "Authorization",
  "gmail.name": "Gmail",
  "google-calendar.name": "Google Calendar",
  "google-chat.name": "Google Chat",
  "google-docs.name": "Google Docs",
  "google-drive.name": "Google Drive",
  "google-people.name": "Google People",
  "google-sheets.name": "Google Sheets",
  "google-slides.name": "Google Slides",
  "google-workspace-search.name": "Google Workspace Search",
  "google.name": "Google Gemini",
  "google.methods.0.keyPlacement.name": "GEMINI_API_KEY",
  "honcho.name": "Honcho",
  "honcho.methods.0.keyPlacement.name": "Authorization",
  "hugging-face.name": "Hugging Face",
  "imessage-photon.name": "iMessage Photon",
  "jira.name": "Jira",
  "kernel.name": "Kernel",
  "kernel.methods.1.keyPlacement.name": "X-API-Key",
  "linear.name": "Linear",
  "local-falcon.name": "Local Falcon",
  "local.methods.0.keyPlacement.name": "OPENAI_API_KEY",
  "make.name": "Make",
  "manufact.name": "Manufact",
  "mem0.name": "Mem0",
  "mem0.methods.0.keyPlacement.name": "Authorization",
  "messages-api.name": "Messages API",
  "messages-api.methods.0.keyPlacement.name": "ANTHROPIC_API_KEY",
  "microsoft-teams.name": "Microsoft Teams",
  "microsoft-teams.methods.0.credentialFields.0.placeholder": "00000000-0000-0000-0000-000000000000",
  "microsoft-teams.methods.0.credentialFields.1.placeholder": "00000000-0000-0000-0000-000000000000",
  "miro.name": "Miro",
  "mixpanel.name": "Mixpanel",
  "neon.name": "Neon",
  "neon.methods.0.tenantFields.0.transport.name": "projectId",
  "neon.methods.0.tenantFields.1.transport.name": "readonly",
  "neon.methods.1.keyPlacement.name": "Authorization",
  "neon.methods.1.tenantFields.0.transport.name": "projectId",
  "neon.methods.1.tenantFields.1.transport.name": "readonly",
  "netlify.name": "Netlify",
  "notion.name": "Notion",
  "openai.name": "OpenAI",
  "openai.methods.1.keyPlacement.name": "OPENAI_API_KEY",
  "openrouter.name": "OpenRouter",
  "openrouter.methods.0.keyPlacement.name": "OPENROUTER_API_KEY",
  "oreilly.name": "O'Reilly",
  "oreilly.methods.1.keyPlacement.name": "Authorization",
  "pagerduty.name": "PagerDuty",
  "pagerduty.methods.0.keyPlacement.name": "Authorization",
  "pagerduty.methods.1.keyPlacement.name": "Authorization",
  "planetscale.name": "PlanetScale",
  "posthog.name": "PostHog",
  "posthog.methods.0.tenantFields.0.transport.name": "x-posthog-project-id",
  "posthog.methods.0.tenantFields.1.transport.name": "readonly",
  "posthog.methods.0.tenantFields.2.transport.name": "features",
  "posthog.methods.0.tenantFields.3.transport.name": "tools",
  "posthog.methods.0.tenantFields.4.transport.name": "mode",
  "posthog.methods.1.tenantFields.0.transport.name": "x-posthog-project-id",
  "posthog.methods.1.tenantFields.1.transport.name": "readonly",
  "posthog.methods.1.tenantFields.2.transport.name": "features",
  "posthog.methods.1.tenantFields.3.transport.name": "tools",
  "posthog.methods.1.tenantFields.4.transport.name": "mode",
  "posthog.methods.1.credentialFields.0.placeholder": "phx_...",
  "posthog.methods.1.keyPlacement.name": "Authorization",
  "postman.name": "Postman",
  "postman.methods.3.credentialFields.0.placeholder": "PMAK-...",
  "postman.methods.3.keyPlacement.name": "Authorization",
  "postman.methods.4.credentialFields.0.placeholder": "PMAK-...",
  "postman.methods.4.keyPlacement.name": "Authorization",
  "postman.methods.5.credentialFields.0.placeholder": "PMAK-...",
  "postman.methods.5.keyPlacement.name": "Authorization",
  "railway.name": "Railway",
  "razorpay.name": "Razorpay",
  "razorpay.methods.1.keyPlacement.name": "Authorization",
  "resend.name": "Resend",
  "responses-api.name": "Responses API",
  "responses-api.methods.0.keyPlacement.name": "OPENAI_API_KEY",
  "sanity.name": "Sanity",
  "sanity.methods.1.credentialFields.0.placeholder": "sk...",
  "sanity.methods.1.keyPlacement.name": "Authorization",
  "sentry.name": "Sentry",
  "shopify.name": "Shopify",
  "shopify.methods.0.tenantFields.0.placeholder": "your-store.myshopify.com",
  "shopify.methods.1.tenantFields.0.placeholder": "your-store.myshopify.com",
  "similarweb.name": "Similarweb",
  "similarweb.methods.0.keyPlacement.name": "api-key",
  "slack.name": "Slack",
  "slack.methods.1.credentialFields.0.placeholder": "xoxb-...",
  "stripe.name": "Stripe",
  "stripe.methods.1.credentialFields.0.placeholder": "sk_...",
  "stripe.methods.1.keyPlacement.name": "Authorization",
  "supabase.name": "Supabase",
  "supabase.methods.0.tenantFields.0.placeholder": "abcdefghijklmnopqrst",
  "supabase.methods.0.tenantFields.0.transport.name": "project_ref",
  "supabase.methods.0.tenantFields.1.transport.name": "read_only",
  "supabase.methods.0.tenantFields.2.placeholder": "database,docs",
  "supabase.methods.0.tenantFields.2.transport.name": "features",
  "supabase.methods.1.credentialFields.0.placeholder": "sbp_...",
  "supabase.methods.1.keyPlacement.name": "Authorization",
  "supabase.methods.1.tenantFields.0.placeholder": "abcdefghijklmnopqrst",
  "supabase.methods.1.tenantFields.0.transport.name": "project_ref",
  "supabase.methods.1.tenantFields.1.transport.name": "read_only",
  "supabase.methods.1.tenantFields.2.placeholder": "database,docs",
  "supabase.methods.1.tenantFields.2.transport.name": "features",
  "supermemory.name": "Supermemory",
  "telegram.name": "Telegram",
  "telegram.methods.0.credentialFields.0.placeholder": "123456789:AA...",
  "ticket-tailor.name": "Ticket Tailor",
  "ticktick.name": "TickTick",
  "todoist.name": "Todoist",
  "vercel.name": "Vercel",
  "webflow.name": "Webflow",
  "wix.name": "Wix",
  "xai.name": "Grok",
  "xai.methods.1.keyPlacement.name": "XAI_API_KEY",
  "xero.name": "Xero",
  "youcom.name": "You.com",
  "youcom.methods.1.keyPlacement.name": "Authorization",
  "zapier.name": "Zapier",
  "zep.name": "Zep"
};
const definitions = import.meta.glob("../../../../packages/shared/src/app-definitions/*.json", { eager: true, import: "default" }) as Record<string, Record<string, unknown>>;
const displayKeys = new Set(["name", "description", "label", "placeholder", "whenToUse", "guidanceMd", "title", "subtitle", "helpText", "helperMd", "actionLabel"]);
function displayEntries(object: Record<string, unknown>, path: string[] = []): Array<[string,string]> {
  return Object.entries(object).flatMap(([key, value]) => {
    const field = [...path, key].join(".");
    if (typeof value === "string") return displayKeys.has(key) || /\.(warnings|steps)\.\d+$/.test(field) || field === "availability.reason" ? [[field,value] as [string,string]] : [];
    return value && typeof value === "object" ? displayEntries(value as Record<string, unknown>, [...path,key]) : [];
  });
}
afterEach(async () => { await i18n.changeLanguage("en"); });
it("covers every built-in display field on the pinned source without changing canonical definitions", async () => {
  const original = JSON.stringify(definitions);
  for (const language of ["en", "ru", "en"]) {
    await i18n.changeLanguage(language);
    for (const definition of Object.values(definitions)) {
      const slug = String(definition.slug);
      for (const [field,source] of displayEntries(definition)) {
        const identity = slug + "." + field;
        if (untranslated[identity] === source) continue;
        expect(APP_DEFINITION_COPY[slug]?.[source], identity).toBeTruthy();
        const result = appDefinitionText(slug,source);
        if (language === "en") expect(result,identity).toBe(source);
        else {
          const reviewed = i18n.getResource("ru", "translation", APP_DEFINITION_COPY[slug]![source]!);
          expect(typeof reviewed, identity).toBe("string");
          expect(reviewed.length, identity).toBeGreaterThan(0);
          expect(result,identity).toBe(reviewed);
        }
        expect(appDefinitionText("custom-" + slug,source)).toBe(source);
        expect(appDefinitionText(slug,source + " [edited source]")).toBe(source + " [edited source]");
      }
      expect(appDefinitionText(slug,"__CUSTOM_ACCOUNT_NAME__")).toBe("__CUSTOM_ACCOUNT_NAME__");
    }
    expect(JSON.stringify(definitions)).toBe(original);
  }
});
it("localizes generic display names but leaves identity and custom names unchanged", async () => {
  const entries = Object.values(definitions).filter(d=>["api-key-generic","oauth-generic","local","github-code-review-bot"].includes(String(d.slug)));
  expect(entries.length).toBeGreaterThan(0);
  for (const language of ["en", "ru", "en"]) {
    await i18n.changeLanguage(language);
    for (const definition of entries) {
      const entry = definition as unknown as Parameters<typeof appDefinitionName>[0];
      expect(appDefinitionName(entry)).toBe(definition.name);
      if (language === "en") expect(appDefinitionDisplayName(entry)).toBe(definition.name);
      else expect(appDefinitionDisplayName(entry)).toMatch(/[А-Яа-яЁё]/);
      const custom = { ...definition, name: "My custom connector" } as unknown as typeof entry;
      expect(appDefinitionDisplayName(custom)).toBe("My custom connector");
    }
  }
});
