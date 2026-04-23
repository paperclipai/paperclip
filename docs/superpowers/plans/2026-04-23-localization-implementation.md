# Paperclip Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class `en` / `zh-CN` localization to Paperclip’s web UI and user-visible server responses, with an instance default language and optional company-level override.

**Architecture:** Extend the existing shared contracts so locale is part of instance general settings and company settings, then add a lightweight UI i18n provider and a server-side locale/error translation layer. Resolve effective locale from `company.localeOverride ?? instance.general.locale ?? "en"` so the same configuration model drives both browser copy and API error strings.

**Tech Stack:** TypeScript, React 19, TanStack Query, Express, Drizzle ORM, Zod, Vitest

---

## File Structure

### Shared contracts

- Create: `packages/shared/src/types/locale.ts`
- Modify: `packages/shared/src/types/company.ts`
- Modify: `packages/shared/src/types/instance.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/validators/company.ts`
- Modify: `packages/shared/src/validators/instance.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/localization.test.ts`

### Persistence and settings APIs

- Modify: `packages/db/src/schema/companies.ts`
- Create: `packages/db/src/migrations/0065_localization_settings.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `server/src/services/companies.ts`
- Modify: `server/src/services/instance-settings.ts`
- Modify: `server/src/routes/instance-settings.ts`
- Modify: `server/src/routes/companies.ts`
- Test: `server/src/__tests__/instance-settings-routes.test.ts`
- Test: `server/src/__tests__/company-branding-route.test.ts`

### UI i18n runtime

- Create: `ui/src/i18n/types.ts`
- Create: `ui/src/i18n/messages/en.ts`
- Create: `ui/src/i18n/messages/zh-CN.ts`
- Create: `ui/src/i18n/translate.ts`
- Create: `ui/src/context/I18nContext.tsx`
- Test: `ui/src/context/I18nContext.test.tsx`
- Modify: `ui/src/main.tsx`

### Settings UI

- Modify: `ui/src/pages/InstanceGeneralSettings.tsx`
- Modify: `ui/src/pages/CompanySettings.tsx`
- Modify: `ui/src/api/companies.ts`
- Test: `ui/src/pages/InstanceGeneralSettings.test.tsx`
- Test: `ui/src/pages/CompanySettings.test.tsx`

### Core translated UI surfaces

- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/EmptyState.tsx`
- Modify: `ui/src/components/Layout.tsx`
- Modify: `ui/src/components/Sidebar.tsx`
- Modify: `ui/src/components/SidebarSection.tsx`
- Modify: `ui/src/components/CommandPalette.tsx`
- Modify: `ui/src/pages/Dashboard.tsx`
- Modify: `ui/src/pages/Companies.tsx`
- Test: `ui/src/components/Layout.test.tsx`
- Test: `ui/src/components/CommandPalette.test.tsx`

### Server localization runtime

- Create: `server/src/i18n/messages/en.ts`
- Create: `server/src/i18n/messages/zh-CN.ts`
- Create: `server/src/i18n/types.ts`
- Create: `server/src/i18n/t.ts`
- Create: `server/src/i18n/resolve-locale.ts`
- Modify: `server/src/errors.ts`
- Modify: `server/src/middleware/error-handler.ts`
- Modify: `server/src/routes/instance-settings.ts`
- Modify: `server/src/routes/companies.ts`
- Modify: `server/src/routes/issues.ts`
- Test: `server/src/__tests__/instance-settings-routes.test.ts`
- Test: `server/src/__tests__/company-branding-route.test.ts`
- Test: `server/src/__tests__/error-handler.test.ts`

### Documentation and final verification

- Modify: `doc/SPEC-implementation.md`

## Task 1: Shared Locale Contracts

**Files:**
- Create: `packages/shared/src/types/locale.ts`
- Modify: `packages/shared/src/types/company.ts`
- Modify: `packages/shared/src/types/instance.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/validators/company.ts`
- Modify: `packages/shared/src/validators/instance.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/localization.test.ts`

- [ ] **Step 1: Write the failing shared contract test**

```ts
import { describe, expect, it } from "vitest";
import {
  instanceGeneralSettingsSchema,
  updateCompanySchema,
  supportedLocaleSchema,
} from "./index.js";

describe("localization contracts", () => {
  it("defaults the instance locale to english", () => {
    expect(instanceGeneralSettingsSchema.parse({}).locale).toBe("en");
  });

  it("accepts null company overrides and rejects unsupported locales", () => {
    expect(updateCompanySchema.parse({ localeOverride: null }).localeOverride).toBeNull();
    expect(() => supportedLocaleSchema.parse("fr")).toThrow(/Invalid enum value/);
  });
});
```

- [ ] **Step 2: Run the shared test to verify it fails**

Run: `pnpm --filter @paperclipai/shared exec vitest run src/localization.test.ts`
Expected: FAIL with missing exports such as `supportedLocaleSchema` and missing `locale` / `localeOverride` properties.

- [ ] **Step 3: Add locale types and validators with minimal surface area**

```ts
// packages/shared/src/types/locale.ts
export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
```

```ts
// packages/shared/src/validators/instance.ts
import { SUPPORTED_LOCALES } from "../types/locale.js";

export const supportedLocaleSchema = z.enum(SUPPORTED_LOCALES);

export const instanceGeneralSettingsSchema = z.object({
  locale: supportedLocaleSchema.default("en"),
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.default(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
  backupRetention: backupRetentionPolicySchema.default(DEFAULT_BACKUP_RETENTION),
}).strict();
```

```ts
// packages/shared/src/validators/company.ts
import { SUPPORTED_LOCALES } from "../types/locale.js";

const localeOverrideSchema = z.enum(SUPPORTED_LOCALES).nullable().optional();

export const updateCompanySchema = createCompanySchema
  .partial()
  .extend({
    localeOverride: localeOverrideSchema,
    status: z.enum(COMPANY_STATUSES).optional(),
  });
```

- [ ] **Step 4: Export the new locale contract everywhere it is consumed**

```ts
// packages/shared/src/types/company.ts
import type { SupportedLocale } from "./locale.js";

export interface Company {
  localeOverride: SupportedLocale | null;
}
```

```ts
// packages/shared/src/types/instance.ts
import type { SupportedLocale } from "./locale.js";

export interface InstanceGeneralSettings {
  locale: SupportedLocale;
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
}
```

```ts
// packages/shared/src/index.ts
export { SUPPORTED_LOCALES, type SupportedLocale } from "./types/locale.js";
export {
  supportedLocaleSchema,
  instanceGeneralSettingsSchema,
  patchInstanceGeneralSettingsSchema,
} from "./validators/index.js";
```

- [ ] **Step 5: Re-run the shared contract test**

Run: `pnpm --filter @paperclipai/shared exec vitest run src/localization.test.ts`
Expected: PASS with both locale assertions green.

- [ ] **Step 6: Typecheck the shared package**

Run: `pnpm --filter @paperclipai/shared typecheck`
Expected: PASS with no missing exports or type regressions.

- [ ] **Step 7: Commit**

```bash
git add \
  packages/shared/src/types/locale.ts \
  packages/shared/src/types/company.ts \
  packages/shared/src/types/instance.ts \
  packages/shared/src/types/index.ts \
  packages/shared/src/validators/company.ts \
  packages/shared/src/validators/instance.ts \
  packages/shared/src/validators/index.ts \
  packages/shared/src/index.ts \
  packages/shared/src/localization.test.ts
git commit -m "feat: add shared localization contracts"
```

## Task 2: Persist Locale Settings Through DB and Settings APIs

**Files:**
- Modify: `packages/db/src/schema/companies.ts`
- Create: `packages/db/src/migrations/0065_localization_settings.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `server/src/services/companies.ts`
- Modify: `server/src/services/instance-settings.ts`
- Modify: `server/src/routes/instance-settings.ts`
- Modify: `server/src/routes/companies.ts`
- Test: `server/src/__tests__/instance-settings-routes.test.ts`
- Test: `server/src/__tests__/company-branding-route.test.ts`

- [ ] **Step 1: Extend route tests to describe the new locale fields**

```ts
// server/src/__tests__/instance-settings-routes.test.ts
mockInstanceSettingsService.getGeneral.mockResolvedValue({
  locale: "en",
  censorUsernameInLogs: false,
  keyboardShortcuts: false,
  feedbackDataSharingPreference: "prompt",
  backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
});

it("allows local board users to update locale in general settings", async () => {
  const app = await createApp({
    type: "board",
    userId: "local-board",
    source: "local_implicit",
    isInstanceAdmin: true,
  });

  await request(app)
    .patch("/api/instance/settings/general")
    .send({ locale: "zh-CN" })
    .expect(200);

  expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({
    locale: "zh-CN",
  });
});
```

```ts
// server/src/__tests__/company-branding-route.test.ts
it("allows board callers to update a company locale override", async () => {
  mockCompanyService.getById.mockResolvedValue(createCompany());
  mockCompanyService.update.mockResolvedValue({
    ...createCompany(),
    localeOverride: "zh-CN",
  });

  const app = await createApp({
    type: "board",
    userId: "user-1",
    source: "local_implicit",
  });

  const res = await request(app)
    .patch("/api/companies/company-1")
    .send({ localeOverride: "zh-CN" });

  expect(res.status).toBe(200);
  expect(mockCompanyService.update).toHaveBeenCalledWith("company-1", {
    localeOverride: "zh-CN",
  });
});
```

- [ ] **Step 2: Run the route tests to verify they fail**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/instance-settings-routes.test.ts src/__tests__/company-branding-route.test.ts`
Expected: FAIL because the schemas/routes do not yet accept or return locale fields.

- [ ] **Step 3: Add DB storage and company selection support**

```ts
// packages/db/src/schema/companies.ts
export const companies = pgTable(
  "companies",
  {
    localeOverride: text("locale_override"),
    brandColor: text("brand_color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
```

```sql
-- packages/db/src/migrations/0065_localization_settings.sql
ALTER TABLE "companies"
ADD COLUMN IF NOT EXISTS "locale_override" text;
```

```ts
// server/src/services/companies.ts
const companySelection = {
  id: companies.id,
  name: companies.name,
  description: companies.description,
  localeOverride: companies.localeOverride,
  brandColor: companies.brandColor,
  logoAssetId: companyLogos.assetId,
  createdAt: companies.createdAt,
  updatedAt: companies.updatedAt,
};
```

- [ ] **Step 4: Normalize instance locale and allow settings routes to pass it through**

```ts
// server/src/services/instance-settings.ts
function normalizeGeneralSettings(raw: unknown): InstanceGeneralSettings {
  const parsed = instanceGeneralSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      locale: parsed.data.locale ?? "en",
      censorUsernameInLogs: parsed.data.censorUsernameInLogs ?? false,
      keyboardShortcuts: parsed.data.keyboardShortcuts ?? false,
      feedbackDataSharingPreference:
        parsed.data.feedbackDataSharingPreference ?? DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
      backupRetention: parsed.data.backupRetention ?? DEFAULT_BACKUP_RETENTION,
    };
  }
  return {
    locale: "en",
    censorUsernameInLogs: false,
    keyboardShortcuts: false,
    feedbackDataSharingPreference: DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
    backupRetention: DEFAULT_BACKUP_RETENTION,
  };
}
```

```ts
// server/src/routes/companies.ts
body = updateCompanySchema.parse(req.body);
const company = await svc.update(companyId, body);
```

- [ ] **Step 5: Generate the migration artifacts**

Run: `pnpm db:generate`
Expected: PASS with a new migration snapshot that includes `companies.locale_override`.

- [ ] **Step 6: Re-run the route tests**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/instance-settings-routes.test.ts src/__tests__/company-branding-route.test.ts`
Expected: PASS with locale writes flowing through both settings endpoints.

- [ ] **Step 7: Typecheck DB and server packages**

Run: `pnpm --filter @paperclipai/db typecheck && pnpm --filter @paperclipai/server typecheck`
Expected: PASS with the new schema field and settings shape compiled.

- [ ] **Step 8: Commit**

```bash
git add \
  packages/db/src/schema/companies.ts \
  packages/db/src/migrations/0065_localization_settings.sql \
  packages/db/src/migrations/meta/_journal.json \
  server/src/services/companies.ts \
  server/src/services/instance-settings.ts \
  server/src/routes/instance-settings.ts \
  server/src/routes/companies.ts \
  server/src/__tests__/instance-settings-routes.test.ts \
  server/src/__tests__/company-branding-route.test.ts
git commit -m "feat: persist localization settings"
```

## Task 3: Add the UI i18n Runtime and Wire It Into Settings

**Files:**
- Create: `ui/src/i18n/types.ts`
- Create: `ui/src/i18n/messages/en.ts`
- Create: `ui/src/i18n/messages/zh-CN.ts`
- Create: `ui/src/i18n/translate.ts`
- Create: `ui/src/context/I18nContext.tsx`
- Test: `ui/src/context/I18nContext.test.tsx`
- Modify: `ui/src/main.tsx`
- Modify: `ui/src/pages/InstanceGeneralSettings.tsx`
- Modify: `ui/src/pages/CompanySettings.tsx`
- Modify: `ui/src/api/companies.ts`
- Test: `ui/src/pages/InstanceGeneralSettings.test.tsx`
- Test: `ui/src/pages/CompanySettings.test.tsx`

- [ ] **Step 1: Write provider and settings-page tests first**

```tsx
// ui/src/context/I18nContext.test.tsx
it("prefers company locale overrides over the instance default", async () => {
  render(
    <I18nProvider
      instanceGeneral={{ locale: "en" } as any}
      selectedCompany={{ localeOverride: "zh-CN" } as any}
    >
      <Probe />
    </I18nProvider>,
  );

  expect(screen.getByText("zh-CN")).toBeTruthy();
  expect(document.documentElement.lang).toBe("zh-CN");
});
```

```tsx
// ui/src/pages/CompanySettings.test.tsx
expect(container.textContent).toContain("Follow instance default");
expect(container.textContent).toContain("English");
expect(container.textContent).toContain("简体中文");
```

- [ ] **Step 2: Run the UI tests to verify they fail**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/context/I18nContext.test.tsx src/pages/InstanceGeneralSettings.test.tsx src/pages/CompanySettings.test.tsx`
Expected: FAIL because the provider, locale dictionaries, and new settings controls do not exist yet.

- [ ] **Step 3: Implement the translation runtime with English fallback**

```ts
// ui/src/i18n/types.ts
import type { SupportedLocale } from "@paperclipai/shared";

export type MessageCatalog = Record<string, string>;
export type TranslateParams = Record<string, string | number>;
export type UiLocale = SupportedLocale;
```

```ts
// ui/src/i18n/translate.ts
export function translate(
  key: string,
  locale: UiLocale,
  catalogs: Record<UiLocale, MessageCatalog>,
  params?: TranslateParams,
) {
  const template = catalogs[locale][key] ?? catalogs.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, token) => String(params?.[token] ?? `{${token}}`));
}
```

```tsx
// ui/src/context/I18nContext.tsx
const effectiveLocale = selectedCompany?.localeOverride ?? instanceGeneral?.locale ?? "en";

useEffect(() => {
  document.documentElement.lang = effectiveLocale;
}, [effectiveLocale]);
```

- [ ] **Step 4: Wrap the app with the provider and expose translated language controls**

```tsx
// ui/src/main.tsx
<CompanyProvider>
  <I18nProvider>
    <EditorAutocompleteProvider>
      <ToastProvider>
        <LiveUpdatesProvider>
          <TooltipProvider>
            <BreadcrumbProvider>
              <SidebarProvider>
                <PanelProvider>
                  <PluginLauncherProvider>
                    <DialogProvider>
                      <App />
                    </DialogProvider>
                  </PluginLauncherProvider>
                </PanelProvider>
              </SidebarProvider>
            </BreadcrumbProvider>
          </TooltipProvider>
        </LiveUpdatesProvider>
      </ToastProvider>
    </EditorAutocompleteProvider>
  </I18nProvider>
</CompanyProvider>
```

```ts
// ui/src/api/companies.ts
data: Partial<
  Pick<
    Company,
    | "name"
    | "description"
    | "status"
    | "budgetMonthlyCents"
    | "requireBoardApprovalForNewAgents"
    | "feedbackDataSharingEnabled"
    | "localeOverride"
    | "brandColor"
    | "logoAssetId"
  >
>
```

- [ ] **Step 5: Add the language controls to instance and company settings**

```tsx
// ui/src/pages/InstanceGeneralSettings.tsx
<section className="rounded-xl border border-border bg-card p-5">
  <div className="space-y-1.5">
    <h2 className="text-sm font-semibold">{t("settings.instance.language.title")}</h2>
    <p className="max-w-2xl text-sm text-muted-foreground">
      {t("settings.instance.language.description")}
    </p>
  </div>
  <div className="mt-4 flex gap-2">
    {[
      { value: "en", label: "English" },
      { value: "zh-CN", label: "简体中文" },
    ].map((option) => (
      <Button
        key={option.value}
        variant={generalQuery.data?.locale === option.value ? "default" : "outline"}
        onClick={() => updateGeneralMutation.mutate({ locale: option.value as "en" | "zh-CN" })}
      >
        {option.label}
      </Button>
    ))}
  </div>
</section>
```

```tsx
// ui/src/pages/CompanySettings.tsx
<Field
  label={t("settings.company.language.title")}
  hint={t("settings.company.language.hint", { effective: effectiveLanguageLabel })}
>
  <select
    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
    value={selectedCompany.localeOverride ?? "__inherit__"}
    onChange={(event) =>
      generalMutation.mutate({
        name: companyName.trim(),
        description: description.trim() || null,
        brandColor: brandColor || null,
        localeOverride: event.target.value === "__inherit__" ? null : (event.target.value as "en" | "zh-CN"),
      })
    }
  >
    <option value="__inherit__">{t("settings.company.language.follow_instance")}</option>
    <option value="en">English</option>
    <option value="zh-CN">简体中文</option>
  </select>
</Field>
```

- [ ] **Step 6: Re-run the UI runtime and settings tests**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/context/I18nContext.test.tsx src/pages/InstanceGeneralSettings.test.tsx src/pages/CompanySettings.test.tsx`
Expected: PASS with locale inheritance, override, and document `lang` behavior verified.

- [ ] **Step 7: Typecheck the UI package**

Run: `pnpm --filter @paperclipai/ui typecheck`
Expected: PASS with the provider and settings pages compiled.

- [ ] **Step 8: Commit**

```bash
git add \
  ui/src/i18n/types.ts \
  ui/src/i18n/messages/en.ts \
  ui/src/i18n/messages/zh-CN.ts \
  ui/src/i18n/translate.ts \
  ui/src/context/I18nContext.tsx \
  ui/src/context/I18nContext.test.tsx \
  ui/src/main.tsx \
  ui/src/pages/InstanceGeneralSettings.tsx \
  ui/src/pages/InstanceGeneralSettings.test.tsx \
  ui/src/pages/CompanySettings.tsx \
  ui/src/pages/CompanySettings.test.tsx \
  ui/src/api/companies.ts
git commit -m "feat: add ui localization runtime"
```

## Task 4: Translate the Core Board UI

**Files:**
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/EmptyState.tsx`
- Modify: `ui/src/components/Layout.tsx`
- Modify: `ui/src/components/Sidebar.tsx`
- Modify: `ui/src/components/SidebarSection.tsx`
- Modify: `ui/src/components/CommandPalette.tsx`
- Modify: `ui/src/pages/Dashboard.tsx`
- Modify: `ui/src/pages/Companies.tsx`
- Test: `ui/src/components/Layout.test.tsx`
- Test: `ui/src/components/CommandPalette.test.tsx`

- [ ] **Step 1: Update the shell tests to assert translated copy**

```tsx
// ui/src/components/CommandPalette.test.tsx
vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    t: (key: string) => ({
      "command_palette.search_placeholder": "搜索事项、代理和项目...",
      "command_palette.pages.dashboard": "仪表盘",
    }[key] ?? key),
  }),
}));

expect(container.textContent).toContain("仪表盘");
```

```tsx
// ui/src/components/Layout.test.tsx
expect(document.documentElement.lang).toBe("en");
expect(container.textContent).not.toContain("Authenticated private");
```

- [ ] **Step 2: Run the shell tests to verify they fail**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/CommandPalette.test.tsx src/components/Layout.test.tsx`
Expected: FAIL because the components still inline English strings and do not consume the provider.

- [ ] **Step 3: Replace hardcoded strings in shared shell components with `t(...)`**

```tsx
// ui/src/components/Sidebar.tsx
const { t } = useI18n();

<button
  onClick={() => openNewIssue()}
  className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
>
  <SquarePen className="h-4 w-4 shrink-0" />
  <span className="truncate">{t("nav.new_issue")}</span>
</button>

<SidebarSection label={t("nav.section.work")}>
  <SidebarNavItem to="/issues" label={t("nav.issues")} icon={CircleDot} />
  <SidebarNavItem to="/routines" label={t("nav.routines")} icon={Repeat} />
  <SidebarNavItem to="/goals" label={t("nav.goals")} icon={Target} />
</SidebarSection>
```

```tsx
// ui/src/components/CommandPalette.tsx
<CommandInput
  placeholder={t("command_palette.search_placeholder")}
  value={query}
  onValueChange={setQuery}
/>
```

```tsx
// ui/src/components/EmptyState.tsx
const { t } = useI18n();
const actionLabel = actionKey ? t(actionKey) : action;
```

- [ ] **Step 4: Translate the high-traffic pages and route-entry copy**

```tsx
// ui/src/App.tsx
const title = matchedCompany
  ? t("onboarding.add_agent_title", { company: matchedCompany.name })
  : companies.length > 0
    ? t("onboarding.create_another_company_title")
    : t("onboarding.create_first_company_title");
```

```tsx
// ui/src/pages/Dashboard.tsx
if (!selectedCompanyId) {
  if (companies.length === 0) {
    return (
      <EmptyState
        icon={LayoutDashboard}
        message={t("dashboard.empty.create_first_company")}
        action={t("dashboard.empty.get_started")}
        onAction={openOnboarding}
      />
    );
  }
  return <EmptyState icon={LayoutDashboard} message={t("dashboard.empty.select_company")} />;
}
```

```tsx
// ui/src/pages/Companies.tsx
<Button size="sm" onClick={() => openOnboarding()}>
  <Plus className="h-3.5 w-3.5 mr-1.5" />
  {t("companies.new_company")}
</Button>
```

- [ ] **Step 5: Re-run the shell tests**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/CommandPalette.test.tsx src/components/Layout.test.tsx`
Expected: PASS with translated labels and no regressions in layout setup.

- [ ] **Step 6: Run the targeted UI page tests touched by these flows**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/pages/CompanyInvites.test.tsx src/pages/InviteLanding.test.tsx`
Expected: PASS, proving the provider integration did not break other query-heavy page renderers.

- [ ] **Step 7: Commit**

```bash
git add \
  ui/src/App.tsx \
  ui/src/components/EmptyState.tsx \
  ui/src/components/Layout.tsx \
  ui/src/components/Sidebar.tsx \
  ui/src/components/SidebarSection.tsx \
  ui/src/components/CommandPalette.tsx \
  ui/src/components/Layout.test.tsx \
  ui/src/components/CommandPalette.test.tsx \
  ui/src/pages/Dashboard.tsx \
  ui/src/pages/Companies.tsx
git commit -m "feat: localize core board ui"
```

## Task 5: Localize User-Visible Server Errors

**Files:**
- Create: `server/src/i18n/messages/en.ts`
- Create: `server/src/i18n/messages/zh-CN.ts`
- Create: `server/src/i18n/types.ts`
- Create: `server/src/i18n/t.ts`
- Create: `server/src/i18n/resolve-locale.ts`
- Modify: `server/src/errors.ts`
- Modify: `server/src/middleware/error-handler.ts`
- Modify: `server/src/routes/instance-settings.ts`
- Modify: `server/src/routes/companies.ts`
- Modify: `server/src/routes/issues.ts`
- Test: `server/src/__tests__/instance-settings-routes.test.ts`
- Test: `server/src/__tests__/company-branding-route.test.ts`
- Test: `server/src/__tests__/error-handler.test.ts`

- [ ] **Step 1: Add failing tests for localized error output**

```ts
// server/src/__tests__/error-handler.test.ts
it("serializes zod errors in chinese when req locale resolves to zh-CN", () => {
  const req = { method: "PATCH", originalUrl: "/api/companies/company-1", locale: "zh-CN" } as any;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
  const next = vi.fn();

  errorHandler(new ZodError([]), req, res, next);

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: "验证错误", details: [] });
});
```

```ts
// server/src/__tests__/company-branding-route.test.ts
expect(res.body.error).toContain("只有 CEO 代理");
```

- [ ] **Step 2: Run the server localization tests to verify they fail**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/error-handler.test.ts src/__tests__/instance-settings-routes.test.ts src/__tests__/company-branding-route.test.ts`
Expected: FAIL because the server only returns hardcoded English strings today.

- [ ] **Step 3: Implement locale resolution and catalog lookup**

```ts
// server/src/i18n/types.ts
import type { SupportedLocale } from "@paperclipai/shared";

export type ServerLocale = SupportedLocale;
export type MessageKey =
  | "errors.validation"
  | "errors.auth.board_required"
  | "errors.auth.instance_admin_required"
  | "errors.company.not_found"
  | "errors.company.ceo_only"
  | "errors.issue.not_found";
```

```ts
// server/src/i18n/resolve-locale.ts
export async function resolveRequestLocale(
  db: Db,
  companyId?: string,
): Promise<SupportedLocale> {
  const instance = instanceSettingsService(db);
  const general = await instance.getGeneral();
  if (!companyId) return general.locale ?? "en";

  const company = await companyService(db).getById(companyId);
  return company?.localeOverride ?? general.locale ?? "en";
}
```

- [ ] **Step 4: Add localized error helpers and use them in the targeted routes**

```ts
// server/src/errors.ts
export class HttpError extends Error {
  status: number;
  details?: unknown;
  key?: string;

  constructor(status: number, message: string, details?: unknown, key?: string) {
    super(message);
    this.status = status;
    this.details = details;
    this.key = key;
  }
}

export function forbidden(message = "Forbidden", key?: string) {
  return new HttpError(403, message, undefined, key);
}
```

```ts
// server/src/routes/instance-settings.ts
if (req.actor.type !== "board") {
  throw forbidden("Board access required", "errors.auth.board_required");
}
```

```ts
// server/src/routes/companies.ts
if (!company) {
  res.status(404).json({ error: t(locale, "errors.company.not_found") });
  return;
}
```

- [ ] **Step 5: Translate Zod and 500-class fallback responses in the error handler**

```ts
// server/src/middleware/error-handler.ts
if (err instanceof ZodError) {
  const locale = (req as Request & { locale?: SupportedLocale }).locale ?? "en";
  res.status(400).json({ error: t(locale, "errors.validation"), details: err.errors });
  return;
}

res.status(500).json({ error: t((req as any).locale ?? "en", "errors.internal") });
```

- [ ] **Step 6: Re-run the server localization tests**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/error-handler.test.ts src/__tests__/instance-settings-routes.test.ts src/__tests__/company-branding-route.test.ts`
Expected: PASS with localized `error` payloads for both `en` and `zh-CN`.

- [ ] **Step 7: Run the broader issues route smoke tests touched by the helper changes**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/issue-comment-cancel-routes.test.ts src/__tests__/issue-document-restore-routes.test.ts`
Expected: PASS, confirming the new helpers did not break existing issue-route error flows.

- [ ] **Step 8: Commit**

```bash
git add \
  server/src/i18n/messages/en.ts \
  server/src/i18n/messages/zh-CN.ts \
  server/src/i18n/types.ts \
  server/src/i18n/t.ts \
  server/src/i18n/resolve-locale.ts \
  server/src/errors.ts \
  server/src/middleware/error-handler.ts \
  server/src/routes/instance-settings.ts \
  server/src/routes/companies.ts \
  server/src/routes/issues.ts \
  server/src/__tests__/instance-settings-routes.test.ts \
  server/src/__tests__/company-branding-route.test.ts \
  server/src/__tests__/error-handler.test.ts
git commit -m "feat: localize server error responses"
```

## Task 6: Update the V1 Spec and Run Full Verification

**Files:**
- Modify: `doc/SPEC-implementation.md`

- [ ] **Step 1: Add a short V1 note describing locale behavior**

```md
## Board localization

Paperclip’s board UI and user-visible API error responses support `en` and `zh-CN`.
The effective locale resolves from `company.locale_override`, falling back to `instance_settings.general.locale`, then `en`.
This localization applies to Paperclip-owned product copy only, not user-authored content or external agent output.
```

- [ ] **Step 2: Run package-level typechecks before the expensive full suite**

Run: `pnpm --filter @paperclipai/shared typecheck && pnpm --filter @paperclipai/db typecheck && pnpm --filter @paperclipai/server typecheck && pnpm --filter @paperclipai/ui typecheck`
Expected: PASS across all touched packages.

- [ ] **Step 3: Run the complete test suite**

Run: `pnpm test:run`
Expected: PASS with all Vitest suites green.

- [ ] **Step 4: Run the full repo typecheck**

Run: `pnpm -r typecheck`
Expected: PASS with no cross-package export drift.

- [ ] **Step 5: Build the repo**

Run: `pnpm build`
Expected: PASS with server and UI production bundles generated successfully.

- [ ] **Step 6: Commit**

```bash
git add doc/SPEC-implementation.md
git commit -m "docs: record localization behavior"
```

## Self-Review

### Spec coverage

- Instance default locale: covered by Tasks 1-3
- Company override locale: covered by Tasks 1-3
- Core UI translation: covered by Task 4
- Localized user-visible server responses: covered by Task 5
- Docs and verification: covered by Task 6

### Placeholder scan

- No unresolved placeholders remain in tasks.
- Each code-changing step includes a concrete snippet or exact command.

### Type consistency

- Locale type is consistently named `SupportedLocale`
- Instance field is consistently named `locale`
- Company field is consistently named `localeOverride`
- Inheritance is consistently represented as `null`
