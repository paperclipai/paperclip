import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { installIdentitySession, type createAuthenticatedPerson } from "./identity-auth.js";
import { RunnerApi } from "../api.js";
import { createOwnedChatRunEvidenceObserver } from "../chat-run-evidence-observer.js";

type Person = Awaited<ReturnType<typeof createAuthenticatedPerson>>;
/** One case's real person transition. Session material remains in this closure;
 * all retained receipts contain public user/conversation identities only. */
export async function installCommentaryReader(ctx: ChatCatalogContext, person: Person, ownerId: string) {
  const { api, page } = ctx.input;
  if (ctx.scenario.id !== "activity.agent-feedback" || ctx.input.ownedRunEvidenceObserver)
    throw new Error("Commentary reader installation requires its exact unbound scenario");
  const original = await api.get<{ user?: { id: string } }>("/api/auth/get-session");
  if (original.user?.id !== ownerId || person.id === ownerId) throw new Error("Commentary needs distinct real owner and reader sessions");
  const cookies = await page.context().cookies(api.baseURL);
  if (!cookies.length) throw new Error("Commentary owner has no genuine browser session to restore");
  const cookie = cookies.map(row => `${row.name}=${row.value}`).join("; ");
  // A separate client freezes only the real owner's existing cookie. Its
  // mutation methods never escape: the approved observer exposes GETs only.
  const evidenceApi = new RunnerApi(page.context().request);
  evidenceApi.setBrowserSession(cookie);
  ctx.input.ownedRunEvidenceObserver = createOwnedChatRunEvidenceObserver(evidenceApi, ctx.input.fixtures.company.id);
  let restored = false;
  const restore = async () => {
    if (restored) return;
    await installIdentitySession(page.context(), api.baseURL, cookie);
    api.setBrowserSession(cookie);
    if ((await api.get<{ user?: { id: string } }>("/api/auth/get-session")).user?.id !== ownerId)
      throw new Error("Commentary owner session restoration did not preserve its real identity");
    restored = true;
  };
  try {
    await person.installSessionOn(page.context());
    person.bindApiSession(api);
    // Reload drops the previous person's cached React state as well as using
    // the newly installed genuine server session for all following UI requests.
    await page.reload({ waitUntil: "domcontentloaded" });
    const apiPerson = await api.get<{ user?: { id: string } }>("/api/auth/get-session");
    // Independently authenticate the actual browser jar, without recording the
    // auth DTO or cookie header in Playwright's API trace.
    const browserCookie = (await page.context().cookies(api.baseURL)).map(row => `${row.name}=${row.value}`).join("; ");
    const response = await fetch(new URL("/api/auth/get-session", api.baseURL), { redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Cookie: browserCookie, Origin: api.baseURL } });
    let browserPerson: { user?: { id: string } };
    try {
      if (!response.ok) throw new Error("Commentary browser session could not be independently read");
      browserPerson = await response.json();
    } finally { if (!response.bodyUsed) await response.body?.cancel(); }
    if (apiPerson.user?.id !== person.id || browserPerson.user?.id !== person.id)
      throw new Error("Commentary API and browser do not represent the same real reader");
    const source = await api.post<{ id: string; companyId: string; conversationUserId: string; conversationAgentId: string }>(
      `/api/companies/${ctx.input.fixtures.company.id}/chats/${ctx.input.fixtures.agent.id}`);
    await ctx.refreshIssue();
    if (source.companyId !== ctx.input.fixtures.company.id || source.conversationUserId !== person.id
      || source.conversationAgentId !== ctx.input.fixtures.agent.id || ctx.issue()?.id !== source.id)
      throw new Error("Canonical commentary conversation is not owned by its actual reader");
    const receipt = { ownerId, readerId: person.id, apiUserId: apiPerson.user.id, browserUserId: browserPerson.user.id,
      sourceIssueId: source.id, sourceConversationUserId: source.conversationUserId };
    await ctx.input.evidence("chat-catalog-commentary-reader-identity.json", receipt);
    return { receipt, restore };
  } catch (error) {
    await restore();
    throw error;
  }
}
