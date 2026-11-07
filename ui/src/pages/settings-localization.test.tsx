import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { NotFoundPage } from "./NotFound";

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: [], selectedCompany: null }),
}));

const catalogs = import.meta.glob<{ default: Record<string, string> }>("../i18n/catalogs/*/settings.json", { eager: true });

async function instance(language: string) {
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    fallbackLng: "en",
    ns: ["settings"],
    defaultNS: "settings",
    resources: Object.fromEntries(Object.entries(catalogs).map(([path, module]) => [path.split("/").at(-2), { settings: module.default }])),
  });
  return i18n;
}

describe("settings localization", () => {
  it("subscribes every text-bearing settings surface to the settings namespace", () => {
    const pages = import.meta.glob<string>("./{CliAuth,BoardClaim,InviteLanding,InstanceAccess,InstanceGeneralSettings,InstanceExperimentalSettings,CompanySettings,CompanyAccess,ProfileSettings,UserProfile,Companies,NewAgent}.tsx", { query: "?raw", import: "default", eager: true });
    const onboarding = import.meta.glob<string>("../components/OnboardingWizard.tsx", { query: "?raw", import: "default", eager: true });
    expect(Object.keys(pages)).toHaveLength(12);
    expect(Object.keys(onboarding)).toHaveLength(1);
    for (const [path, source] of Object.entries({ ...pages, ...onboarding })) {
      expect(source, path).toContain('useTranslation("settings")');
    }
  });

  it("keeps English and Chinese message keys and interpolation variables in parity", () => {
    const flatten = (value: unknown, prefix = ""): Record<string, string> => Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => typeof entry === "string"
        ? [[prefix + key, entry]]
        : Object.entries(flatten(entry, `${prefix}${key}.`))),
    );
    const en = flatten(catalogs["../i18n/catalogs/en/settings.json"].default);
    const zh = flatten(catalogs["../i18n/catalogs/zh-CN/settings.json"].default);
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(zh[key].trim(), key).not.toBe("");
      expect(zh[key].match(/{{[^}]+}}/g)?.sort() ?? [], key).toEqual(en[key].match(/{{[^}]+}}/g)?.sort() ?? []);
    }
  });

  it("renders missing-organization guidance in the selected language without translating the requested prefix", async () => {
    const i18n = await instance("zh-CN");
    const render = () => renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/ACME/dashboard"]}>
          <NotFoundPage scope="invalid_company_prefix" requestedPrefix="ACME" />
        </MemoryRouter>
      </I18nextProvider>,
    );
    expect(render()).toContain("未找到组织");
    expect(render()).toContain("ACME");
    expect(render()).toContain("打开仪表盘");
    await i18n.changeLanguage("en");
    expect(render()).toContain("Organization not found");
    expect(render()).toContain("Open dashboard");
  });
});
