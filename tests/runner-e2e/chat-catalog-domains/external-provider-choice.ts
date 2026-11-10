import { expect } from "@playwright/test";
import { isDeepStrictEqual } from "node:util";
import type { AppDefinition } from "../../../packages/shared/src/types/app-definition.js";
import type { ConnectionIntentInteraction } from "../../../packages/shared/src/types/issue.js";
import { getAvailableConnectionMethods } from "../../../packages/shared/src/app-definitions.js";
import {
  definition,
  root,
  checks,
  externalObservation,
  observeExternal,
} from "./external-support.js";
import { waitForReply } from "./identity-support.js";
import { collectRunEvents } from "../run-observations.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
interface Gallery {
  apps: AppDefinition[];
  credentialSources: {
    vercelConnect: { available: boolean; reason: string | null };
  };
}
export function notionSetupChoices(gallery: Gallery) {
  const notion = gallery.apps.find((app) => app.slug === "notion"),
    methods = notion ? getAvailableConnectionMethods(notion) : [];
  const oauth = methods.find(
    (method) =>
      method.auth === "oauth" &&
      method.transport === "mcp_remote" &&
      method.defaults?.serverUrl === "https://mcp.notion.com/mcp",
  );
  const managed = gallery.credentialSources.vercelConnect;
  if (
    !oauth?.credentialSources?.vercelConnect?.services.includes("notion") ||
    managed.available ||
    !managed.reason
  )
    throw new Error(
      "Setup blocker: actual reviewed Notion catalog must offer official sign-in and supported unavailable Vercel Connect with its prerequisite",
    );
  return {
    methodKey: oauth.key,
    serverUrl: oauth.defaults!.serverUrl!,
    unavailableReason: managed.reason,
    advertisedChoices: {
      service: "notion",
      methodKey: oauth.key,
      auth: oauth.auth,
      transport: oauth.transport,
      whenToUse: oauth.whenToUse,
      serverUrl: oauth.defaults!.serverUrl!,
      alternative: {
        source: "vercel_connect",
        available: managed.available,
        reason: managed.reason,
      },
    },
  };
}
export function truthfulNotionChoices(reply: string, reason: string) {
  const offered =
    /notion/i.test(reply) &&
    /sign.?in|log.?in|authoriz|connect.*account/i.test(reply);
  const prerequisite =
    /vercel\s+connect/i.test(reply) &&
    (/disabled/i.test(reason)
      ? /disabled|enable|administrator|admin/i.test(reply)
      : /oidc|workload|token|configur/i.test(reply));
  return (
    offered &&
    prerequisite &&
    !/\b(?:I(?:['’]ve| have)?|we(?:['’]ve| have)?)\s+(?:already\s+)?connected\b|\bnotion\s+is\s+(?:now\s+)?connected\b/i.test(
      reply,
    )
  );
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
interface MessageEvent {
  seq?: number;
  runId?: string;
  companyId?: string;
  agentId?: string;
  eventType?: string;
  payload?: unknown;
}
export function publicChoiceMessages(
  events: MessageEvent[],
  expected: { companyId: string; agentId: string; runId: string },
) {
  return events.flatMap((event) => {
    const prp = record(record(event.payload).prpEvent),
      payload = record(prp.payload),
      item = record(payload.item);
    return event.companyId === expected.companyId &&
      event.agentId === expected.agentId &&
      event.runId === expected.runId &&
      prp.runId === expected.runId &&
      event.eventType === "item.completed" &&
      item.type === "agentMessage" &&
      item.status === "completed" &&
      ["commentary", "final_answer"].includes(String(item.phase)) &&
      typeof item.id === "string" &&
      typeof item.text === "string" &&
      item.text.length <= 12000
      ? [{ runId: expected.runId, eventId: item.id, body: item.text }]
      : [];
  });
}
export function intendedNotionCard(
  cards: ConnectionIntentInteraction[],
  expected: {
    companyId: string;
    issueId: string;
    agentId: string;
    humanId: string;
    runIds: string[];
  },
) {
  const matches = cards.filter(
    (c) =>
      c.kind === "connection_intent" &&
      c.status === "pending" &&
      c.companyId === expected.companyId &&
      c.issueId === expected.issueId &&
      c.createdByAgentId === expected.agentId &&
      c.addresseeUserId === expected.humanId &&
      c.payload.serviceSlug === "notion" &&
      !!c.sourceRunId &&
      expected.runIds.includes(c.sourceRunId),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
export function supportedNotionLink(
  link: string,
  origin: string,
  prefix: string,
  method: string,
) {
  try {
    const u = new URL(link, origin);
    return (
      u.origin === origin &&
      u.pathname === `/${prefix}/apps/connect` &&
      [u.searchParams.get("source"), u.searchParams.get("appKey")].includes(
        "notion",
      ) &&
      (!u.searchParams.has("method") || u.searchParams.get("method") === method)
    );
  } catch {
    return false;
  }
}
const visibleText = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
async function observeChoiceExplanation(
  ctx: ChatCatalogContext,
  state: Record<string, unknown>,
) {
  const runs = (await ctx.allRuns()).filter(
      (r) =>
        r.agentId === ctx.input.fixtures.agent.id && r.status === "succeeded",
    ),
    messages = [];
  for (const run of runs) {
    const events = await collectRunEvents<MessageEvent>((afterSeq, limit) =>
      ctx.input.api.getRunObservation(
        `/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`,
      ),
    );
    messages.push(
      ...publicChoiceMessages(events, {
        companyId: ctx.input.fixtures.company.id,
        agentId: ctx.input.fixtures.agent.id,
        runId: run.id,
      }),
    );
  }
  const selected = messages.find(
    (m) =>
      truthfulNotionChoices(m.body, String(state.unavailableReason)) &&
      m.body.trim(),
  );
  if (selected) {
    await expect(
      ctx.input.page
        .getByText(visibleText(selected.body), { exact: true })
        .first(),
    ).toBeVisible();
    state.choiceExplanation = selected;
    state.choiceExplanationVisible = true;
  }
}
export function completeAdvertisedNotionChoices(
  value: unknown,
  reason: unknown,
) {
  const c = record(value),
    a = record(c.alternative);
  return (
    c.service === "notion" &&
    c.methodKey === "mcp-oauth" &&
    c.auth === "oauth" &&
    c.transport === "mcp_remote" &&
    c.serverUrl === "https://mcp.notion.com/mcp" &&
    typeof c.whenToUse === "string" &&
    !!c.whenToUse.trim() &&
    a.source === "vercel_connect" &&
    a.available === false &&
    typeof reason === "string" &&
    !!reason.trim() &&
    a.reason === reason
  );
}
export function gradeProviderChoice(value: unknown) {
  const c = checks(),
    o = externalObservation(value);
  c.add(
    "complete-catalog-choice-evidence",
    !!o,
    "Actual public catalog choices, prerequisite and attributed human setup selection are required.",
  );
  if (!o) return c.result();
  const explanation = record(o.state.choiceExplanation),
    body = typeof explanation.body === "string" ? explanation.body : o.reply;
  c.add(
    "real-catalog-and-truthful-choices",
    o.state.catalogChoicesIndependentlyMatched === true &&
      completeAdvertisedNotionChoices(
        o.state.advertisedChoices,
        o.state.unavailableReason,
      ) &&
      typeof o.state.unavailableReason === "string" &&
      truthfulNotionChoices(body, o.state.unavailableReason) &&
      o.state.choiceExplanationVisible === true &&
      o.runs.some(
        (r) =>
          r.id === explanation.runId &&
          r.agentId === o.leadId &&
          r.status === "succeeded",
      ),
    "A real visible model message from the source native run explains the actual reviewed choices and unavailable prerequisite; a bare setup card cannot replace that answer.",
  );
  c.add(
    "directed-official-setup-path",
    o.state.modelDirectedNotionSetup === true &&
      ["inline-card", "method-link"].includes(String(o.state.selectionLane)) &&
      o.state.selectionAttributionMatched === true &&
      o.state.selectedNotionVisible === true &&
      o.state.signInControlVisible === true,
    "The person selects the attributed real inline request or supported actual method link, then sees the selected Notion setup without protocol substitution.",
  );
  c.add(
    "original-intent-retained-without-phantom-account",
    o.state.originalConversationRetained === true &&
      o.state.originalQueryRetained === true &&
      o.connections.length === 0,
    "The original task and exact query remain intact; no authorization or usable account is invented.",
  );
  return c.result();
}
export const providerChoiceExternalCases = [
  definition(
    "connection-setup.choose-provider",
    async (ctx) => {
      const choices = notionSetupChoices(
        await ctx.input.api.get<Gallery>(`${root(ctx)}/tools/gallery`),
      );
      const before = await ctx.input.api.get<{ connections: unknown[] }>(
        `${root(ctx)}/tools/connections`,
      );
      if (before.connections.length)
        throw new Error(
          "Catalog choice requires no existing account in the disposable company",
        );
      return {
        ...choices,
        humanId: (
          await ctx.input.api.get<{ user: { id: string } }>(
            "/api/auth/get-session",
          )
        ).user.id,
      };
    },
    gradeProviderChoice,
    {
      authentication: "human-session",
      sourceFiles: [
        "chat-catalog-domains/external-provider-choice.ts",
        "run-observations.ts",
        "chat-catalog-domains/external-support.ts",
        "chat-catalog-domains/internal-support.ts",
        "chat-catalog-domains/identity-support.ts",
        "../../packages/shared/src/app-definitions.ts",
        "../../packages/shared/src/app-definitions/notion.json",
        "../../ui/src/features/connections/ConnectionIntentInteractionBody.tsx",
        "../../ui/src/features/connections/ConnectionSetupFlow.tsx",
        "chat-scenarios/connection-setup.yaml",
      ],
      async verifySetup(ctx, state) {
        const actual = notionSetupChoices(
            await ctx.input.api.get<Gallery>(`${root(ctx)}/tools/gallery`),
          ),
          c = checks();
        c.add(
          "actual-reviewed-advertised-choices",
          isDeepStrictEqual(actual.advertisedChoices, state.advertisedChoices),
          "Independent public gallery retains reviewed Notion method identity and actual unsupported credential-source prerequisite.",
        );
        return c.result();
      },
      async act(ctx, state) {
        await waitForReply(ctx);
        await observeChoiceExplanation(ctx, state);
        if (!state.choiceExplanationVisible)
          throw new Error(
            "Actual visible source-run answer does not explain advertised Notion choices and unavailable prerequisite",
          );
        const o = await observeExternal(ctx, state),
          source = ctx.input.page.url(),
          issueId = ctx.issue()!.id,
          runs = await ctx.allRuns();
        const cards = await ctx.input.api.get<ConnectionIntentInteraction[]>(
            `/api/issues/${issueId}/interactions`,
          ),
          card = intendedNotionCard(cards, {
            companyId: o.companyId,
            issueId,
            agentId: o.leadId,
            humanId: String(state.humanId),
            runIds: runs
              .filter((r) => r.status === "succeeded")
              .map((r) => r.id),
          });
        if (card) {
          state.selectionLane = "inline-card";
          state.selectedIntentId = card.id;
          await ctx.input.page
            .locator(`[id=${JSON.stringify(`interaction-${card.id}`)}]`)
            .getByRole("button", { name: "Connect", exact: true })
            .click();
          await expect(ctx.input.page.getByRole("dialog")).toContainText(
            "Notion",
          );
        } else {
          const href = o.links.find((link) =>
            supportedNotionLink(
              link,
              o.origin,
              String(ctx.input.fixtures.company.issuePrefix),
              String(state.methodKey),
            ),
          );
          if (!href)
            throw new Error(
              "No attributed inline request or actual supported Notion method link",
            );
          state.selectionLane = "method-link";
          state.selectedMethodHref = href;
          await ctx.input.page
            .locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`)
            .first()
            .click();
          await expect(ctx.input.page.getByRole("main")).toContainText(
            "Notion",
          );
        }
        state.modelDirectedNotionSetup = true;
        state.selectedNotionVisible = true;
        const surface =
          state.selectionLane === "inline-card"
            ? ctx.input.page.getByRole("dialog")
            : ctx.input.page.getByRole("main");
        await expect(
          surface
            .getByRole("button", {
              name: /Continue to (?:Notion|sign in)|Sign in to Notion/,
            })
            .first(),
        ).toBeVisible();
        state.signInControlVisible = true;
        if (state.selectionLane === "inline-card")
          await surface
            .getByRole("button", { name: "Close", exact: true })
            .click();
        else
          await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
        await ctx.refreshIssue();
        state.originalConversationRetained = ctx.issue()?.id === issueId;
        const comments = await ctx.input.api.get<
          Array<{ body: string; authorUserId?: string }>
        >(`/api/issues/${issueId}/comments?order=asc`);
        state.originalQueryRetained = comments.some(
          (comment) =>
            comment.authorUserId === state.humanId &&
            comment.body === ctx.scenario.query,
        );
      },
      async observe(ctx, state) {
        const actual = notionSetupChoices(
          await ctx.input.api.get<Gallery>(`${root(ctx)}/tools/gallery`),
        );
        state.catalogChoicesIndependentlyMatched = isDeepStrictEqual(
          actual.advertisedChoices,
          state.advertisedChoices,
        );
        const o = await observeExternal(ctx, state);
        state.selectionAttributionMatched =
          state.selectionLane === "inline-card"
            ? intendedNotionCard(
                o.interactions as unknown as ConnectionIntentInteraction[],
                {
                  companyId: o.companyId,
                  issueId: ctx.issue()!.id,
                  agentId: o.leadId,
                  humanId: String(state.humanId),
                  runIds: o.runs
                    .filter((r) => r.status === "succeeded")
                    .map((r) => r.id),
                },
              )?.id === state.selectedIntentId
            : typeof state.selectedMethodHref === "string" &&
              o.links.includes(state.selectedMethodHref) &&
              supportedNotionLink(
                state.selectedMethodHref,
                o.origin,
                String(ctx.input.fixtures.company.issuePrefix),
                String(state.methodKey),
              );
        return { ...o, state };
      },
      async verifyResult(ctx, state) {
        const explanation = record(state.choiceExplanation);
        if (typeof explanation.body !== "string")
          throw new Error("Missing actual source-run choice explanation");
        await expect(
          ctx.input.page
            .getByText(visibleText(explanation.body), { exact: true })
            .first(),
        ).toBeVisible();
      },
    },
  ),
];
