import { expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { CHAT_ANNOUNCEMENT_MANIFEST } from "../chat-announcement-fixture.js";
vi.mock("@playwright/test", () => ({ expect: (node: { visible(): boolean; count(): number }) => ({
  toBeVisible: async () => { if (!node.visible()) throw Error("Requested normal surface is not visible"); },
  toHaveCount: async (count: number) => { if (node.count() !== count) throw Error("Unexpected visible surface count"); },
}) }));
vi.mock("./identity-auth.js", () => ({ createAuthenticatedPerson: async ({ browser }: { browser: { person: unknown } }) => browser.person, enrollPrerequisitePerson: async () => {} }));
vi.mock("./identity-support.js", async importOriginal => ({ ...await importOriginal<typeof import("./identity-support.js")>(), waitForReply: async () => {}, probeAgentPermission: async () => 403 }));
import { navigationBoundaryIdentityCases } from "./identity-navigation-boundaries.js";
function fixture(fault?: "modal" | "unsettled projects" | "missing secondary publication" | "dismissal lost on reload" | "modal after reload" | "unsettled projects after reload") {
  const publication = CHAT_ANNOUNCEMENT_MANIFEST.announcement;
  let current = "/RUN/chats/source", dismissed = false, reloaded = false;
  const visits: string[] = [];
  function page(observer = false) {
    let path = current;
    const node = (visible: () => boolean) => ({ visible, count: () => Number(visible()), getByRole: (role: string, options: { name: string }) => role === "button" ? { click: async () => { expect(options.name).toBe("Dismiss announcement"); dismissed = true; } } : node(visible) });
    const modal = () => path === "/BIR/dashboard" || fault === "modal" || (reloaded && fault === "modal after reload");
    const p = {
      url: () => path,
      context: () => ({ browser: () => ({ person }) }),
      goto: async (value: string) => { path = value; current = value; visits.push(value); },
      reload: async () => { visits.push("reload:" + path); reloaded = true; if (fault === "dismissal lost on reload") dismissed = false; },
      getByText: (text: string) => node(() => text === "No projects yet." && path === "/BIR/projects" && fault !== "unsettled projects" && !(reloaded && fault === "unsettled projects after reload") && !modal()),
      getByRole: (role: string) => role === "dialog" ? node(modal) : node(() => !modal() && (observer || !dismissed) && !(path.startsWith("/BIR/") && fault === "missing secondary publication")),
      waitForResponse: async () => ({ status: () => 204 }), close: async () => {},
    };
    return p;
  }
  const person = { id: "riley", dispose: async () => {}, context: { newPage: async () => page(true) }, request: async (_path: string, method?: string) => ({ status: method === "POST" ? 404 : 200, json: async () => publication, body: { cancel: async () => {} } }) };
  const ctx = { input: { nonce: "owned", fixtures: { company: { id: "company", issuePrefix: "RUN" }, agent: { id: "ceo" } }, privateSecrets: [], page: page(), api: {
    get: async (path: string) => path === "/api/auth/get-session" ? { user: { id: "alex" } } : path === "/api/announcements/current" ? (dismissed ? null : publication) : Promise.reject(Error("Unexpected read")),
    post: async (path: string) => { expect(path).toBe("/api/companies"); return { id: "birch", issuePrefix: "BIR" }; }, delete: async () => {},
  }, evidence: async () => {} } } as unknown as ChatCatalogContext;
  return { ctx, visits, definition: navigationBoundaryIdentityCases[1]! };
}
it("the actual dismissal setup uses a settled ordinary second-company surface, then preserves real reload and independent-person proof", async () => {
  const f = fixture(); const state = await f.definition.setup(f.ctx);
  expect(state.secondaryVisible).toBe(true); expect(state.invalidAuditCompanyStatus).toBe(404);
  await f.definition.act!(f.ctx, state);
  expect(f.visits.filter(x => x.startsWith("/BIR/"))).toEqual(["/BIR/projects", "/BIR/projects"]);
  expect(f.visits).toContain("reload:/BIR/projects");
  expect(state.secondaryAfterReloadHidden).toBe(true); expect(state.observerStillVisible).toBe(true); expect(state.agentDismissStatus).toBe(403);
});
it.each(["modal", "unsettled projects", "missing secondary publication"] as const)("setup refuses %s rather than pretending the announcement was visible", async fault => {
  const f = fixture(fault); await expect(f.definition.setup(f.ctx)).rejects.toThrow();
});
it("a publication reappearing after the real secondary reload still fails", async () => {
  const f = fixture("dismissal lost on reload"), state = await f.definition.setup(f.ctx);
  await expect(f.definition.act!(f.ctx, state)).rejects.toThrow("Unexpected visible surface count");
  expect(state.secondaryAfterReloadHidden).not.toBe(true);
});

it.each(["modal after reload", "unsettled projects after reload"] as const)("does not mistake %s for a persisted dismissal", async fault => {
  const f = fixture(fault), state = await f.definition.setup(f.ctx);
  await expect(f.definition.act!(f.ctx, state)).rejects.toThrow();
  expect(state.secondaryAfterReloadHidden).not.toBe(true);
});
