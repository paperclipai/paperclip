import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { appDefinitionDescription, appDefinitionText } from "./app-definition-display";
import { appCopyFor } from "@/lib/app-gallery-copy";

const oct5DisplaySources = [
  ["api-key-generic","Actions depend on the operator-supplied API and key; grant read/write on the required resources at the provider. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["bitly","Create/manage links in authorized groups. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["browser-use-cloud","Create/stop browser sessions and run browser tasks under the API key. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["cloudflare","Cloudflare API actions selected at provider consent or on the API token. Identity scopes alone do not grant account writes. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["coda","Modify documents/tables permitted by the account. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["cognee","Add/process knowledge and manage authorized datasets. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["fireflies","Use an API key for an account with write access to the meetings your agents need to share, rename, move or turn into soundbites. Paperclip cannot increase the key’s permissions."],
  ["github","Repository contents, issues, pull requests and other granted toolsets; selected repos and installation/PAT permissions apply. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["honcho","Create peers/sessions and save memory under the API key project. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["kernel","Launch/manage browsers, profiles, apps and browser automation. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["mem0","Add/update/delete memories under the API key account. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["neon","A Neon account. The hosted server grants broad project and database management, so use a development project and review write actions before connecting production data."],
  ["neon","Neon recommends its hosted server for development and testing. Review write and destructive actions before execution."],
  ["neon","Optional. Restrict this connection to one project. Copy the project ID from Neon Console → Project settings → General."],
  ["neon","Enable this to limit SQL to SELECT queries and schema inspection."],
  ["neon","Project, branch, compute, snapshot, SQL and schema changes within the key’s reach. A project-scoped key limits access to one project with Editor rights; personal and organization keys reach every project they can access. Paperclip cannot increase an existing key’s permissions."],
  ["oreilly","None: content discovery and retrieval. A read-only key is sufficient."],
  ["pagerduty","Incident and on-call changes require a full-access API key and role access. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["posthog","Analytics objects, feature flags, experiments, error triage and other enabled product actions. readonly/feature/tool filters remain enforced. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["postman","Collection/workspace/API actions supported by the selected minimal/code/full endpoint and account role. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["razorpay","Provider-authorized payment/account tools; financial policy gates remain. Live verification outstanding. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["sanity","Edit content permitted by project role; global is MCP authorization, not a bypass of project ACLs. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["similarweb","None: analytics retrieval; subscription entitlements apply. A read-only key is sufficient."],
  ["stripe","Account- and sandbox-specific writes selected during Stripe consent; financial approvals and restricted-key permissions remain. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["supabase","Project/database/environment/storage changes and Edge Function deployment. Project selection and optional read-only configuration remain authoritative. Create a key with read and write permissions for these actions; Paperclip cannot increase an existing key’s permissions."],
  ["youcom","None: search, contents and research tools (usage may be billed). A read-only key is sufficient."],
  [
    "asana",
    "Connect your Asana account with Paperclip's app."
  ],
  [
    "asana",
    "Sign in to Asana with Paperclip. Asana gives this connection access to the workspaces available to your account."
  ],
  [
    "asana",
    "Sign in with Asana"
  ],
  [
    "asana",
    "Create an MCP app in Asana, then add the callback URL below under OAuth. Under Manage distribution, select your workspace and save. API apps do not work with Asana MCP."
  ],
  [
    "browser-use-cloud",
    "Delegate browser tasks and watch them live in Paperclip."
  ],
  [
    "browser-use-cloud",
    "Use credentials from your provider account."
  ],
  [
    "browser-use-cloud",
    "Create an API key in [Browser Use settings](https://cloud.browser-use.com/settings) and paste it below. Your agents can browse websites while you watch and interact from the task's Browser tab."
  ],
  [
    "browser-use-cloud",
    "API key"
  ],
  [
    "github-code-review-bot",
    "Have an agent review pull requests and respond to GitHub mentions."
  ],
  [
    "github-code-review-bot",
    "Chat with an agent"
  ],
  [
    "github-code-review-bot",
    "Let people in GitHub start and continue work with one Paperclip agent."
  ],
  [
    "github-code-review-bot",
    "GitHub App ID"
  ],
  [
    "github-code-review-bot",
    "Private key (PEM)"
  ],
  [
    "github-code-review-bot",
    "Generate the webhook secret in Paperclip, then create one private GitHub App with active SSL-verified webhooks, Issues and Pull requests read/write permission, and the selectable issue_comment and pull_request_review_comment events. GitHub sends installation and installation_repositories automatically. Install the App only on repositories where people may mention the agent."
  ],
  [
    "github",
    "Give agents access to GitHub repositories, issues, and pull requests."
  ],
  [
    "github",
    "Connect GitHub"
  ],
  [
    "linear",
    "Connect Linear for issues and projects. Paperclip registers its own OAuth client with Linear's MCP server, so no developer-console setup is needed."
  ],
  [
    "neon",
    "Manage Postgres projects and branches, run SQL, and inspect schemas in Neon."
  ],
  [
    "neon",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "neon",
    "Connect Neon in the browser. Open Advanced to pin one project or enable read-only mode. Write tools start enabled and remain governed by Paperclip's action policies."
  ],
  [
    "neon",
    "Sign in with Neon"
  ],
  [
    "neon",
    "Pin to project ID"
  ],
  [
    "neon",
    "Optional Neon project ID"
  ],
  [
    "neon",
    "Read-only mode"
  ],
  [
    "neon",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "neon",
    "Use a customer-created Neon API key. Prefer a project-scoped key for one development project; personal and organization keys reach every project they can access. Write tools start enabled and remain governed by Paperclip's action policies."
  ],
  [
    "neon",
    "Use an API key"
  ],
  [
    "neon",
    "Neon API key"
  ],
  [
    "planetscale",
    "Read and write"
  ],
  [
    "planetscale",
    "Query and change the databases you authorize in PlanetScale."
  ],
  [
    "planetscale",
    "Read only"
  ],
  [
    "planetscale",
    "Inspect database performance with the insights-only server."
  ],
  [
    "airtable",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "api-key-generic",
    "Use credentials from your provider account."
  ],
  [
    "beehiiv",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "bitly",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "bitly",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "brex",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "candid",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "clickhouse",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "cloudflare",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "cloudflare",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "cloudinary",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "coda",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "coda",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "embat",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "fireflies",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "fireflies",
    "Use an API key"
  ],
  [
    "honcho",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "honcho",
    "Use an API key"
  ],
  [
    "hugging-face",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "kernel",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "kernel",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "local-falcon",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "manufact",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "mem0",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "miro",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "mixpanel",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "netlify",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "oreilly",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "oreilly",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "pagerduty",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "planetscale",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "postman",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "postman",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "razorpay",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "razorpay",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "resend",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "sanity",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "sanity",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "similarweb",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "slack",
    "Use this connection as an agent tool"
  ],
  [
    "slack",
    "Chat with an agent"
  ],
  [
    "slack",
    "Bot User OAuth Token"
  ],
  [
    "slack",
    "Signing Secret"
  ],
  [
    "stripe",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "stripe",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "supabase",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "supabase",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "ticktick",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "todoist",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "wix",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "youcom",
    "Use browser sign-in for the provider-hosted MCP server."
  ],
  [
    "youcom",
    "Use a restricted customer-owned key when browser sign-in is not suitable."
  ],
  [
    "youcom",
    "Use an API key"
  ]
] as const;

it("localizes the Oct 5 metadata delta and exact-copy backfills without changing upstream or custom text", async () => {
  for (const locale of ["en", "ru", "en"]) {
    await i18n.changeLanguage(locale);
    for (const [slug, source] of oct5DisplaySources) {
      const result = appDefinitionText(slug, source);
      if (locale === "en") expect(result, slug).toBe(source);
      else if (slug === "github-code-review-bot" && source === "GitHub App ID") expect(result).toBe("ID GitHub App");
      else expect(result, slug).toMatch(/[А-Яа-яЁё]/);
      expect(appDefinitionText(`custom-${slug}`, source)).toBe(source);
      expect(appDefinitionText(slug, `${source} Custom upstream revision`)).toBe(`${source} Custom upstream revision`);
    }
    for (const [slug, source] of [
      ["browser-use-cloud", "Browser Use Cloud"], ["browser-use-cloud", "bu_…"],
      ["github-code-review-bot", "-----BEGIN RSA PRIVATE KEY-----"],
      ["neon", "napi_..."], ["neon", "neon_project_key_..."],
      ["neon", "project_id"], ["planetscale", "read_write"],
    ]) expect(appDefinitionText(slug, source)).toBe(source);
    // The conjunction is UI copy; each credential prefix itself remains literal.
    expect(appDefinitionText("neon", "napi_... or neon_project_key_...")).toBe(
      locale === "ru" ? "napi_... или neon_project_key_..." : "napi_... or neon_project_key_...",
    );
  }
});

import agentmail from "../../../../packages/shared/src/app-definitions/agentmail.json";
import anthropic from "../../../../packages/shared/src/app-definitions/anthropic.json";
import openai from "../../../../packages/shared/src/app-definitions/openai.json";
import openrouter from "../../../../packages/shared/src/app-definitions/openrouter.json";
import photon from "../../../../packages/shared/src/app-definitions/imessage-photon.json";
import xai from "../../../../packages/shared/src/app-definitions/xai.json";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("built-in app display localization", () => {
  it.each([anthropic, openai, openrouter, xai])("localizes $slug AI account metadata without changing canonical values", async (definition) => {
    const original = JSON.stringify(definition);
    const sources = [definition.description];
    const aiMethods = definition.methods.filter((method) => "purpose" in method && method.purpose === "ai");
    expect(aiMethods.length).toBeGreaterThan(0);
    for (const method of aiMethods) {
      for (const [key, value] of Object.entries(method)) {
        if (["label", "whenToUse", "guidanceMd"].includes(key) && typeof value === "string") sources.push(value);
      }
      if ("credentialFields" in method) {
        for (const field of method.credentialFields ?? []) {
          sources.push(field.label);
          if (field.placeholder) sources.push(field.placeholder);
        }
      }
    }
    for (const language of ["en", "ru", "en"]) {
      await i18n.changeLanguage(language);
      for (const source of sources) {
        const rendered = appDefinitionText(definition.slug, source);
        if (language === "en") expect(rendered).toBe(source);
        else expect(rendered).toMatch(/[А-Яа-яЁё]/);
        expect(appDefinitionText(`custom-${definition.slug}`, source)).toBe(source);
      }
      for (const value of [definition.slug, definition.name, "ai-api_key", "ai-subscription", "runtime_auth", "api_key", "apiKey", "oauth", "subscription", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "Custom account guidance"]) {
        expect(appDefinitionText(definition.slug, value)).toBe(value);
      }
      expect(JSON.stringify(definition)).toBe(original);
    }
  });

  it("localizes Photon metadata while preserving the canonical schema and custom copy", async () => {
    const original = JSON.stringify(photon);
    const method = photon.methods[0]!;
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      for (const source of [photon.description, method.label, method.whenToUse, method.guidanceMd, method.credentialFields[0]!.label, method.credentialFields[0]!.placeholder]) {
        const rendered = appDefinitionText("imessage-photon", source);
        if (locale === "en") expect(rendered).toBe(source);
        else expect(rendered).toMatch(/[А-Яа-яЁё]/);
        expect(appDefinitionText("custom-photon", source)).toBe(source);
      }
      for (const value of ["imessage-photon", "projectSecret", "chat_sdk", "direct_message", "group_chat", "iMessage Photon", "Custom project description"]) {
        expect(appDefinitionText("imessage-photon", value)).toBe(value);
      }
      expect(JSON.stringify(photon)).toBe(original);
    }
  });
  it("translates the new AgentMail definition without editing its credential or protocol fields", async () => {
    const original = JSON.stringify(agentmail);
    const method = agentmail.methods[0]!;
    for (const language of ["en", "ru", "en"]) {
      await i18n.changeLanguage(language);
      for (const source of [agentmail.description, method.label, method.whenToUse, method.guidanceMd, method.credentialFields[0]!.label]) {
        const label = appDefinitionText("agentmail", source);
        if (language === "en") expect(label).toBe(source);
        else expect(label).toMatch(/[А-Яа-яЁё]/);
        expect(appDefinitionText("custom-agentmail", source)).toBe(source);
      }
      expect(appDefinitionText("agentmail", "am_…")).toBe("am_…");
      expect(appDefinitionText("agentmail", "A custom description")).toBe("A custom description");
      expect(JSON.stringify(agentmail)).toBe(original);
    }
  });
  it("requires both the app identity and the exact upstream source text", async () => {
    const source = "Read and update pages in your Notion workspace.";
    const entry = { slug: "notion", description: source } as Parameters<typeof appDefinitionDescription>[0];
    await i18n.changeLanguage("en");
    expect(appDefinitionDescription(entry)).toBe(source);
    await i18n.changeLanguage("ru");
    expect(appDefinitionDescription(entry)).toBe("Читайте и обновляйте страницы рабочего пространства Notion.");
    expect(appDefinitionText("custom-notion", source)).toBe(source);
    expect(appDefinitionText("notion", "Updated upstream wording")).toBe("Updated upstream wording");
    expect(entry?.description).toBe(source);
  });

  it("updates captured curated copy and keeps credential-shaped values untouched", async () => {
    await i18n.changeLanguage("en");
    const copy = appCopyFor("notion");
    expect(copy.tagline).toBe("Read and update pages in your workspace.");
    await i18n.changeLanguage("ru");
    expect(copy.tagline).not.toContain("Read and update");
    expect(appDefinitionText("posthog", "phx_...")).toBe("phx_...");
    expect(appDefinitionText("supabase", "database,docs")).toBe("database,docs");
    expect(appDefinitionText("google-drive", "Read & create")).toBe("Чтение и создание");
  });
});
