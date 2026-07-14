import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { SkillPolicyEditorPage, buildAdminsOnlyPreset, buildRestrictedAuthorsPreset } from "../src/ui/index.js";

const COMPANY_ID = "5cbe79ee-acb3-4597-896e-7662742593cd";

type BridgeGlobal = typeof globalThis & {
  __paperclipPluginBridge__?: { sdkUi: Record<string, unknown> };
};

function json(data: unknown, init?: ResponseInit) {
  return Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" }, ...init }));
}

function installBridge(overrides: Partial<Record<string, unknown>> = {}) {
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      useHostContext: () => ({ companyId: COMPANY_ID, companyPrefix: "PAP", projectId: null, entityId: null, entityType: null, userId: "user-board" }),
      usePluginData: () => ({ data: { status: "ready", pluginId: manifest.id, companyId: COMPANY_ID, checkedAt: new Date().toISOString() }, loading: false, error: null, refresh: () => undefined }),
      usePluginToast: () => vi.fn(),
      ...overrides,
    },
  };
}


let mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

async function renderUi(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return container;
}

async function waitForAssertion(assertion: () => void | Promise<void>, timeoutMs = 1_000) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await assertion();
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function textMatches(value: string, matcher: string | RegExp) {
  return typeof matcher === "string" ? value === matcher : matcher.test(value);
}

function getByText(matcher: string | RegExp) {
  const elements = Array.from(document.body.querySelectorAll("*"));
  const match = elements.find((element) => {
    const text = element.textContent?.trim() ?? "";
    if (!textMatches(text, matcher)) return false;
    return Array.from(element.children).every((child) => !textMatches(child.textContent?.trim() ?? "", matcher));
  });
  if (!match) throw new Error(`Unable to find text: ${matcher.toString()}`);
  return match as HTMLElement;
}

async function findByText(matcher: string | RegExp) {
  let element: HTMLElement | null = null;
  await waitForAssertion(() => {
    element = getByText(matcher);
  });
  return element as HTMLElement;
}

function getButton(name: string) {
  const button = Array.from(document.body.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim().includes(name));
  if (!button) throw new Error(`Unable to find button: ${name}`);
  return button as HTMLButtonElement;
}

async function findButton(name: string) {
  let button: HTMLButtonElement | null = null;
  await waitForAssertion(() => {
    button = getButton(name);
  });
  return button as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  element.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function installFetch(policy = { schemaVersion: 1, revision: 0, defaultEffect: "allow", rules: [], materialized: false }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/skill-policy/evaluate")) {
      return json({
        allowed: false,
        action: "skills.install",
        reason: "explicit_rule",
        policyRevision: 1,
        matchedRuleId: "deny-external-installs",
        remediation: "Contact a company administrator to change the skill policy.",
      });
    }
    if (url.includes("/skill-policy") && init?.method === "PUT") {
      return json({ ...JSON.parse(String(init.body)), revision: 1, materialized: true });
    }
    if (url.includes("/skill-policy") && init?.method === "DELETE") {
      return json({ schemaVersion: 1, revision: 0, defaultEffect: "allow", rules: [], materialized: false });
    }
    if (url.includes("/skill-policy")) return json(policy);
    if (url.includes("/agents")) return json([{ id: "00000000-0000-4000-8000-000000000001", name: "Engineer", role: "Engineer" }]);
    if (url.includes("/activity")) return json([{ id: "act-1", actorType: "user", actorId: "board", action: "company.skill_policy_replaced", entityType: "company_skill_policy", entityId: COMPANY_ID, details: { previousRevision: 0, newRevision: 1, ruleCount: 2 }, createdAt: new Date().toISOString() }]);
    return json({ error: "unhandled" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

describe("Paperclip EE plugin", () => {
  beforeEach(() => {
    installBridge();
    installFetch();
  });

  afterEach(() => {
    for (const { root, container } of mountedRoots) {
      root.unmount();
      container.remove();
    }
    mountedRoots = [];
    vi.restoreAllMocks();
    delete (globalThis as BridgeGlobal).__paperclipPluginBridge__;
  });

  it("declares an EE-only plugin page for skill policy administration", () => {
    expect(manifest.id).toBe("paperclipai.paperclip-ee");
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["ui.page.register", "companies.read"]));
    expect(manifest.ui?.slots?.[0]).toMatchObject({ type: "page", exportName: "SkillPolicyEditorPage" });
  });

  it("registers availability data from the worker", async () => {
    let handler: ((params: Record<string, unknown>) => Promise<unknown>) | null = null;
    await plugin.definition.setup({
      data: {
        register(key: string, nextHandler: (params: Record<string, unknown>) => Promise<unknown>) {
          expect(key).toBe("availability");
          handler = nextHandler;
        },
      },
    } as never);

    await expect(handler?.({ companyId: COMPANY_ID })).resolves.toMatchObject({
      status: "ready",
      pluginId: manifest.id,
      companyId: COMPANY_ID,
    });
  });

  it("builds safe presets without mutating the open core default", () => {
    expect(buildRestrictedAuthorsPreset()).toMatchObject({ defaultEffect: "allow" });
    expect(buildRestrictedAuthorsPreset().rules.some((rule) => rule.resources?.sourceTypes?.includes("external_package"))).toBe(true);
    expect(buildAdminsOnlyPreset()).toMatchObject({ defaultEffect: "deny" });
  });

  it("previews and saves a restricted-authors policy through the core policy endpoint", async () => {
    const { calls } = installFetch();
    await renderUi(<SkillPolicyEditorPage context={{} as never} />);

    expect(await findByText("Paperclip EE Skill Policy")).toBeTruthy();
    await click(await findButton("Restricted Authors"));
    await click(await findButton("Save policy"));

    await waitForAssertion(() => {
      const putCall = calls.find((call) => call.url.includes("/skill-policy") && call.init?.method === "PUT");
      expect(putCall).toBeTruthy();
      expect(JSON.parse(String(putCall?.init?.body))).toMatchObject({
        expectedRevision: 0,
        defaultEffect: "allow",
      });
      expect(JSON.parse(String(putCall?.init?.body)).rules).toHaveLength(2);
    });
  });

  it("renders denial explanations from core simulation responses", async () => {
    installFetch({
      schemaVersion: 1,
      revision: 1,
      defaultEffect: "allow",
      materialized: true,
      rules: [{ id: "deny-external-installs", priority: 10, effect: "deny", subject: { type: "all_agents" }, actions: ["skills.install"], resources: { sourceTypes: ["external_package"] } }],
    });
    await renderUi(<SkillPolicyEditorPage context={{} as never} />);

    await click(await findButton("simulate"));
    await click(await findButton("Explain"));

    expect(await findByText(/Matched explicit rule/)).toBeTruthy();
    expect(getByText(/Contact a company administrator/)).toBeTruthy();
  });

  it("shows a plugin load-failure state without claiming core skills are unavailable", async () => {
    installBridge({
      usePluginData: () => ({ data: null, loading: false, error: { code: "WORKER_ERROR", message: "upgrade failed" }, refresh: () => undefined }),
    });
    await renderUi(<SkillPolicyEditorPage context={{} as never} />);

    expect(getByText("Detailed policy editing is temporarily unavailable.")).toBeTruthy();
    expect(getByText(/Skill management still works in core/)).toBeTruthy();
  });
});
