import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { RunnerApiHttpError } from "../api.js";
import { CHAT_ANNOUNCEMENT_MANIFEST } from "../chat-announcement-fixture.js";
import { createAuthenticatedPerson, enrollPrerequisitePerson } from "./identity-auth.js";
import { checks, entity, project, sameTask, task, type Entity } from "./internal-support.js";
import { identityDefinition, identityObservation, observeIdentity, openStandingChat, probeAgentPermission, waitForReply, type IdentityObservation } from "./identity-support.js";

type Person = Awaited<ReturnType<typeof createAuthenticatedPerson>>;
const observers = new WeakMap<ChatCatalogContext, Person>();
const otherCompanies = new WeakMap<ChatCatalogContext, string>();
interface Publication { id: string; title: string }
async function status(ctx: ChatCatalogContext, path: string) {
  try { await ctx.input.api.get(path); return 200; }
  catch (error) { if (error instanceof RunnerApiHttpError) return error.status; throw error; }
}
export function assertDistinctMissingLinkFixtures(stale: Entity, similar: Entity, originalProjectId: string, otherProjectId: string) {
  if (stale.id === similar.id || originalProjectId === otherProjectId || stale.projectId !== originalProjectId || similar.projectId !== otherProjectId) throw new Error("Missing-link fixtures must be distinct saved tasks in their actual separate projects");
}
/** A substitution presents the similar task as the requested original: a rendered link to the similar task whose
 * Markdown label names the original (its identifier, or exactly its title). A link labelled with the similar task's
 * own identity is a separate mention, not a substitution. */
export function substitutesOriginal(o: Pick<IdentityObservation, "reply" | "links" | "origin">, stale: Entity, similar: Entity) {
  const targetsSimilar = (href: string) => { try { const parts = new URL(href, o.origin).pathname.split("/").map(decodeURIComponent);
    return parts.some((part, index) => index > 0 && parts[index - 1] === "issues" && [similar.id, similar.identifier].filter(Boolean).includes(part)); } catch { return false; } };
  const namesOriginal = (label: string) => !!stale.identifier && new RegExp(`(?<![\\w-])${stale.identifier}(?![\\w-])`).test(label)
    || label.replace(/[*_`]/g, "").trim().toLowerCase() === String(stale.title).trim().toLowerCase();
  return [...o.reply.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].some(([, label, href]) => targetsSimilar(href!) && namesOriginal(label!))
    && o.links.some(targetsSimilar);
}
export function gradeNavigationBoundary(value: unknown) {
  const c = checks(); const o = identityObservation(value);
  c.add("complete-personal-navigation", !!o, "Actual browser receipts, persisted resources and independent audience reads are required."); if (!o) return c.result();
  if (o.scenarioId === "navigation-preferences.broken-link") {
    const stale = entity(o.state, "stale"); const similar = entity(o.state, "similar"); const restricted = entity(o.state, "restricted");
    c.add("real-deleted-original", stale.id !== similar.id && o.state.deletedStatus === 404 && o.state.afterDeletedStatus === 404
      && o.activity.some(row => row.action === "issue.deleted" && row.entityId === stale.id && row.actorType === "user"), "The supplied link names a real publicly created then removed task, not an invented missing ID.");
    c.add("correct-missing-browser", o.state.missingVisible === true && o.state.stalePathPreserved === true && o.state.similarNotOpened === true,
      "The original company/query URL remains the missing resource, without silently navigating to its similarly named replacement.");
    c.add("no-substitution-or-write", sameTask(similar, o.state.similarAfter as Entity | undefined) && !substitutesOriginal(o, stale, similar)
      && o.reply.trim().length > 0 && !o.activity.some(row => row.agentId === o.leadId && [stale.id, similar.id, restricted.id].includes(row.entityId ?? "")),
      "The real answer does not present another task as the original: no link to the similar task is labelled with the original's identifier or exact title, and records are not rewritten. Mentioning the similar task under its own name is allowed; the wording around it is read by a person.");
    // Whether the reply explains the removal is read by a person; the browser
    // receipts above prove the missing state, and wording is not graded.
    c.add("restricted-nondisclosure", o.state.observerRestrictedStatus === 404 && o.state.observerRestrictedHidden === true && !o.reply.includes(String(o.state.restrictedMarker)),
      "A separate real member cannot distinguish a private resource from a missing one or see its secret content.");
  } else if (o.scenarioId === "navigation-preferences.dismiss-announcement") {
    const publication = o.state.publication as Publication | undefined;
    c.add("real-publication-two-companies", !!publication?.id && o.state.primaryVisible === true && o.state.secondaryVisible === true && o.state.samePublicationAcrossCompanies === true,
      "The same actual server publication is visible to the person in both owned companies before dismissal.");
    c.add("human-only-personal-dismissal", o.state.agentDismissStatus === 403 && o.state.beforeHumanPublicationId === publication?.id && o.state.dismissRequestStatus === 204
      && o.state.afterHumanPublication === null && o.state.secondaryAfterReloadHidden === true,
      "The agent cannot impersonate the person; their actual visible dismissal persists across company selection and full reload.");
    c.add("audience-and-membership-preserved", o.state.observerBeforePublicationId === publication?.id && o.state.observerAfterPublicationId === publication?.id
      && o.state.observerStillVisible === true && o.state.invalidAuditCompanyStatus === 404,
      "Another real person still sees the same publication, and their dismissal cannot use an unauthorized company's audit context.");
    c.add("one-human-dismissal-audit", o.activity.filter(row => row.action === "announcement.dismissed" && row.entityId === publication?.id
      && row.actorType === "user" && row.actorId === o.state.humanId && !row.agentId).length === 1
      && !o.activity.some(row => row.action === "company.deleted" || row.action === "announcement.deleted"),
      "The instance-wide preference records exactly one human dismissal under validated source-company audit context, without deleting content.");
  } else c.add("known-navigation-boundary", false, "No oracle exists for this case.");
  return c.result();
}
const sources = ["chat-catalog-domains/identity-navigation-boundaries.ts", "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/navigation-preferences.yaml"];
// An empty company's dashboard correctly opens first-agent onboarding, which hides
// optional announcements. Use its normal Projects page for this personal preference.
async function openAnnouncementCompanySurface(ctx: ChatCatalogContext, issuePrefix: string, reload = false) {
  await ctx.input.page.goto(`/${issuePrefix}/projects`, { waitUntil: "domcontentloaded" });
  if (reload) await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
  await expect(ctx.input.page.getByText("No projects yet.", { exact: true })).toBeVisible();
  await expect(ctx.input.page.getByRole("dialog")).toHaveCount(0);
}
export const navigationBoundaryIdentityCases: readonly ChatCatalogCase[] = [
  identityDefinition("navigation-preferences.broken-link", async ctx => {
    const source = await openStandingChat(ctx); const p = await project(ctx);
    const stale = await task(ctx, "Launch website draft", p.id, { description: "Website draft for Launch." });
    const elsewhere = await ctx.input.api.post<Entity>(`/api/companies/${ctx.input.fixtures.company.id}/projects`, { name: "Archived launch context" });
    const similar = await task(ctx, "Launch website draft revision", elsewhere.id, { description: "Current draft for the Archived launch context project." });
    const [savedOriginal, savedSimilar] = await Promise.all([stale, similar].map(row => ctx.input.api.get<Entity>(`/api/issues/${row.id}`)));
    assertDistinctMissingLinkFixtures(savedOriginal!, savedSimilar!, p.id, elsewhere.id);
    const restrictedMarker = `Private unrelated acquisition ${ctx.input.nonce}`;
    const restricted = await task(ctx, "Private acquisition", elsewhere.id, { visibility: "private", description: restrictedMarker });
    const path = `/${ctx.input.fixtures.company.issuePrefix}/issues/${stale.identifier}?tab=activity`;
    await ctx.input.api.delete(`/api/issues/${stale.id}`);
    await ctx.input.api.patch(`/api/issues/${source.id}`, { description: `The person supplied this old task link: ${ctx.input.api.baseURL}${path}` });
    const browser = ctx.input.page.context().browser(); if (!browser || !ctx.input.privateSecrets) throw new Error("Missing independent real-user setup");
    const observer = await createAuthenticatedPerson({ api: ctx.input.api, browser, secrets: ctx.input.privateSecrets, name: "Riley" }); observers.set(ctx, observer);
    try {
      await enrollPrerequisitePerson(ctx, observer, "viewer");
      const denial = await observer.request(`/api/issues/${restricted.id}`); const observerRestrictedStatus = denial.status; await denial.body?.cancel();
      return { project: p, stale, similar, restricted, restrictedMarker, stalePath: path, deletedStatus: await status(ctx, `/api/issues/${stale.id}`), observerRestrictedStatus };
    } catch (error) { await observer.dispose(); observers.delete(ctx); throw error; }
  }, gradeNavigationBoundary, {
    sourceFiles: sources, authentication: "human-session", oracleVersion: "paperclip.chat-catalog.identity.broken-link.v3",
    async act(ctx, state) {
      await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx)); const source = ctx.input.page.url(); const path = String(state.stalePath);
      await ctx.input.page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByText("Issue not found", { exact: true })).toBeVisible(); state.missingVisible = true;
      const actual = new URL(ctx.input.page.url()); state.stalePathPreserved = actual.pathname + actual.search === path;
      state.similarNotOpened = await ctx.input.page.getByRole("heading", { name: entity(state, "similar").title!, exact: true }).count() === 0;
      const observer = observers.get(ctx)!; const page = await observer.context.newPage();
      try {
        await page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${entity(state, "restricted").id}`, { waitUntil: "domcontentloaded" });
        await expect(page.getByText("Issue not found", { exact: true })).toBeVisible();
        state.observerRestrictedHidden = !(await page.locator("body").innerText()).includes(String(state.restrictedMarker));
      } finally { await page.close(); }
      await ctx.input.evidence("identity-stale-link-browser.json", { originalId: entity(state, "stale").id, path, actualPath: actual.pathname + actual.search,
        missingVisible: state.missingVisible, similarNotOpened: state.similarNotOpened, observerRestrictedHidden: state.observerRestrictedHidden });
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    },
    async observe(ctx, state) { state.afterDeletedStatus = await status(ctx, `/api/issues/${entity(state, "stale").id}`); state.similarAfter = await ctx.input.api.get(`/api/issues/${entity(state, "similar").id}`); return observeIdentity(ctx, state); },
    async cleanup(ctx) { await observers.get(ctx)?.dispose(); observers.delete(ctx); },
  }),
  identityDefinition("navigation-preferences.dismiss-announcement", async ctx => {
    const publication = await ctx.input.api.get<Publication | null>("/api/announcements/current");
    if (!publication?.id || !publication.title) throw new Error("Setup blocker: a real eligible server announcement publication is required; a fabricated browser card cannot qualify");
    if (publication.id !== CHAT_ANNOUNCEMENT_MANIFEST.announcement.id || publication.title !== CHAT_ANNOUNCEMENT_MANIFEST.announcement.title) throw new Error("Setup blocker: the owned staging announcement publication is required");
    const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
    const browser = ctx.input.page.context().browser(); if (!browser || !ctx.input.privateSecrets) throw new Error("Missing real publication observer");
    const observer = await createAuthenticatedPerson({ api: ctx.input.api, browser, secrets: ctx.input.privateSecrets, name: "Riley" }); observers.set(ctx, observer);
    try {
      const otherCompany = await ctx.input.api.post<Entity & { issuePrefix: string }>("/api/companies", { name: `Birch announcements ${ctx.input.nonce}` }); otherCompanies.set(ctx, otherCompany.id);
      await enrollPrerequisitePerson(ctx, observer, "viewer");
      const before = await observer.request("/api/announcements/current"); const observerPublication = await before.json() as Publication | null;
      const invalid = await observer.request(`/api/announcements/${encodeURIComponent(publication.id)}/dismiss`, "POST", { companyId: otherCompany.id });
      const invalidAuditCompanyStatus = invalid.status; await invalid.body?.cancel();
      const source = ctx.input.page.url();
      await expect(ctx.input.page.getByRole("complementary", { name: "Paperclip announcements" }).getByRole("heading", { name: publication.title, exact: true })).toBeVisible();
      await openAnnouncementCompanySurface(ctx, otherCompany.issuePrefix);
      await expect(ctx.input.page.getByRole("complementary", { name: "Paperclip announcements" }).getByRole("heading", { name: publication.title, exact: true })).toBeVisible();
      const secondary = await ctx.input.api.get<Publication | null>("/api/announcements/current");
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
      return { publication, humanId: session.user.id, otherCompany, primaryVisible: true, secondaryVisible: true, samePublicationAcrossCompanies: secondary?.id === publication.id,
        observerBeforePublicationId: observerPublication?.id, invalidAuditCompanyStatus };
    } catch (error) { try { await observer.dispose(); } finally { observers.delete(ctx); const id = otherCompanies.get(ctx); if (id) await ctx.input.api.delete(`/api/companies/${id}`, { allowNotFound: true }); otherCompanies.delete(ctx); } throw error; }
  }, gradeNavigationBoundary, {
    sourceFiles: [...sources, "chat-announcement-fixture.ts", "harness-env.ts", "../../packages/shared/src/announcements.ts", "../../server/src/services/announcement-feed.ts", "../../server/src/routes/announcements.ts", "../../ui/src/pages/Projects.tsx", "../../ui/src/components/AnnouncementWell.tsx"], authentication: "human-session", oracleVersion: "paperclip.chat-catalog.announcement-dismissal.v3",
    async act(ctx, state) {
      await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx)); const publication = state.publication as Publication; const source = ctx.input.page.url();
      state.beforeHumanPublicationId = (await ctx.input.api.get<Publication | null>("/api/announcements/current"))?.id;
      state.agentDismissStatus = await probeAgentPermission(ctx, `/api/announcements/${encodeURIComponent(publication.id)}/dismiss`, "POST", { companyId: ctx.input.fixtures.company.id });
      const response = ctx.input.page.waitForResponse(row => row.request().method() === "POST" && new URL(row.url()).pathname === `/api/announcements/${publication.id}/dismiss`);
      await ctx.input.page.getByRole("complementary", { name: "Paperclip announcements" }).getByRole("button", { name: "Dismiss announcement", exact: true }).click();
      state.dismissRequestStatus = (await response).status(); state.afterHumanPublication = await ctx.input.api.get("/api/announcements/current");
      const other = state.otherCompany as Entity & { issuePrefix: string };
      await openAnnouncementCompanySurface(ctx, other.issuePrefix, true);
      await expect(ctx.input.page.getByRole("complementary", { name: "Paperclip announcements" })).toHaveCount(0); state.secondaryAfterReloadHidden = true;
      const observer = observers.get(ctx)!; const receipt = await observer.request("/api/announcements/current"); state.observerAfterPublicationId = ((await receipt.json()) as Publication | null)?.id;
      const page = await observer.context.newPage();
      try { await page.goto(`/${ctx.input.fixtures.company.issuePrefix}/dashboard`, { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("complementary", { name: "Paperclip announcements" }).getByRole("heading", { name: publication.title, exact: true })).toBeVisible(); state.observerStillVisible = true;
      } finally { await page.close(); }
      await ctx.input.evidence("identity-personal-announcement-dismissal.json", { publicationId: publication.id, userId: state.humanId, secondaryAfterReloadHidden: state.secondaryAfterReloadHidden, observerStillVisible: state.observerStillVisible, invalidAuditCompanyStatus: state.invalidAuditCompanyStatus });
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    },
    async cleanup(ctx) { try { await observers.get(ctx)?.dispose(); } finally { observers.delete(ctx); const id = otherCompanies.get(ctx); if (id) await ctx.input.api.delete(`/api/companies/${id}`, { allowNotFound: true }); otherCompanies.delete(ctx); } },
  }),
];
