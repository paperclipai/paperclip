import { expect } from "@playwright/test";
import type {
  ChatCatalogContext,
  ChatSlackIngressReceipt,
} from "../chat-catalog-contract.js";
import type {
  ChatEndpoint,
  ChatConversation,
  ExternalChannelBindingSummary,
} from "../../../packages/shared/src/types/chat-channels.js";
import type { IssueComment } from "../../../packages/shared/src/types/issue.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { slackIngressReceiptMatches } from "../chat-slack-ingress.js";
import {
  definition,
  checks,
  externalObservation,
  observeExternal,
  root,
  verifyRenderedReply,
  type ExternalObservation,
} from "./external-support.js";
import {
  openStandingChat,
  identityWorker,
  waitForReply,
  probeAgentPermission,
} from "./identity-support.js";
import { selectedExternalBinding } from "./external-fixtures.js";
import {
  slackProvider,
  assertSlackFixture,
  slackCompanionFields,
} from "./external-slack-provider.js";
import {
  prepareSlackFixture,
  type SlackMessage,
} from "./external-slack-fixture.js";
import type { Entity } from "./internal-support.js";
export const slackSetupFields = [
  ...slackCompanionFields,
  "slackBrowserSessionEnv",
] as const;
type Fixture = Awaited<ReturnType<typeof prepareSlackFixture>>;
interface Local {
  fixture?: Fixture;
  createdEndpointId?: string;
  represented: Entity;
  source?: ChatSlackIngressReceipt;
  sourceRunId?: string;
  sourceReply?: IssueComment;
  messages?: SlackMessage[];
}
const fixtures = new WeakMap<ChatCatalogContext, Local>();
function owned(ctx: ChatCatalogContext) {
  const local = fixtures.get(ctx);
  if (!local) throw new Error("Slack setup context missing");
  return local;
}
interface Observation extends ExternalObservation {
  slackSetup: {
    endpoint?: ChatEndpoint;
    source?: ChatSlackIngressReceipt;
    sourceBound: boolean;
    sourceRunId?: string;
    sourceReply?: IssueComment;
    messages: SlackMessage[];
    credentialUi?: Fixture["credentialUiReceipt"];
    identityUi?: Fixture["identityUiReceipt"];
    humanCommand?: Fixture["humanCommandReceipt"];
    signedConnect: boolean;
    lastConnectAt?: string | null;
    principalUserId?: string | null;
    principalStatus?: string;
  };
}
function affirmativeReady(reply: string) {
  return reply
    .split(/[.!?;\n]+|\bbut\b/i)
    .some(
      (clause) =>
        /ready|working|connected|configured|(?:is|are|now|already|has been|have been)\s+set up|(?:setup|connection)\s+(?:is\s+)?complete|can (?:now )?(?:message|talk|chat)/i.test(
          clause,
        ) &&
        !/^\s*(?:please\s+)?(?:connect|select|click|continue|set up|get)\b/i.test(
          clause,
        ) &&
        !/\b(?:not|isn['’]t|cannot|can't|never|before|once|after|until|pending|will|would|need|requires?|must)\b/i.test(
          clause,
        ),
    );
}
export function slackSetupGuidance(
  reply: string,
  represented: string,
  forMorgan: boolean,
) {
  return (
    /slack/i.test(reply) &&
    /connect|setup|set up|authorize|authorization|human|sign.in/i.test(reply) &&
    !affirmativeReady(reply) &&
    (!forMorgan || /Morgan/i.test(reply)) &&
    !(
      forMorgan && /connect (?:your|the) CEO|select (?:the )?CEO/i.test(reply)
    ) &&
    (!/select|represent/i.test(reply) ||
      new RegExp(represented.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(
        reply,
      ) ||
      !forMorgan)
  );
}
export function gradeSlackSetup(value: unknown) {
  const c = checks(),
    o = externalObservation(value) as Observation | undefined,
    t = o?.slackSetup;
  c.add(
    "actual-human-Slack-setup-evidence",
    !!o && !!t && Array.isArray(t.messages),
    "Actual saved endpoint, private credential/identity/wizard receipts, genuine signed connect and two-way native source are required.",
  );
  if (!o || !t || !Array.isArray(t.messages)) return c.result();
  const first = o.phaseReplies.find(
      (row) => row.runId === o.state.initialRunId,
    ),
    last = o.phaseReplies
      .filter((row) => row.runId !== o.state.initialRunId)
      .at(-1),
    e = t.endpoint,
    s = t.source,
    represented = o.state.represented as Entity | undefined,
    run = o.runs.find((row) => row.id === t.sourceRunId);
  c.add(
    "unconfigured-context-and-correct-human-handoff",
    o.state.noEndpointsBefore === true &&
      o.state.providerEnabledBefore === true &&
      !!represented &&
      !!first &&
      slackSetupGuidance(
        first.body,
        String(represented.name),
        o.scenarioId === "connection-setup.channel-prerequisites",
      ) &&
      o.state.agentEndpointCreateStatus === 403 &&
      o.state.createdByHumanUi === true,
    "Slack starts available without an endpoint; chat directs the correct represented agent and actual human-created existing-app setup instead of claiming premature readiness.",
  );
  c.add(
    "real-private-credential-form-and-normal-wizard-activation",
    !!e &&
      e.companyId === o.companyId &&
      e.provider === "slack" &&
      e.assignedAgentId === represented?.id &&
      e.providerAccountId === o.state.workspaceId &&
      e.status === "active" &&
      e.setup.step === "complete" &&
      !!e.setup.webhookVerifiedAt &&
      e.allowUnlinkedPeople === false &&
      t.credentialUi?.endpointId === e.id &&
      t.credentialUi.slackCredentialUiVisible === true &&
      t.credentialUi.humanSubmittedSecurely === true &&
      t.credentialUi.storageClean === true &&
      t.identityUi?.endpointId === e.id &&
      t.identityUi.identityConfirmed === true &&
      t.identityUi.identityUiVisible === true &&
      t.identityUi.activationUiVisible === true &&
      t.identityUi.endpointActive === true,
    "The actual protected existing-app form saves credentials, real callback verification completes and the human uses normal identity/Continue/Done controls; activation is independently saved rather than inferred from credential storage.",
  );
  c.add(
    "genuine-Slack-human-command-and-same-person-link",
    t.signedConnect === true &&
      t.humanCommand?.commandSubmitted === true &&
      t.humanCommand.verifiedWorkspaceId === o.state.workspaceId &&
      t.humanCommand.verifiedHumanId === o.state.senderUserId &&
      !!t.lastConnectAt &&
      !!e?.activatedAt &&
      Date.parse(t.lastConnectAt!) <= Date.parse(e.activatedAt!) &&
      t.principalStatus === "linked" &&
      t.principalUserId === o.state.currentHumanId &&
      t.identityUi?.paperclipUserId === o.state.currentHumanId &&
      t.identityUi?.processIsolation === true &&
      t.identityUi?.testRunnerAttached === false,
    "Only a real named Slack browser human, independently copied member ID, genuinely provider-signed connect command and persisted processed principal receipt authorize the same actual signed-in Paperclip person.",
  );
  c.add(
    "two-way-message-after-actual-activation",
    !!s &&
      t.sourceBound &&
      !!run &&
      run.companyId === o.companyId &&
      run.agentId === represented?.id &&
      run.contextSnapshot?.issueId === s.issueId &&
      run.runtimeMode === "native" &&
      run.status === "succeeded" &&
      t.sourceReply?.createdByRunId === run.id &&
      t.sourceReply.authorAgentId === represented?.id &&
      !!represented?.name &&
      t.sourceReply.body.includes(represented.name) &&
      t.messages.some(
        (message) =>
          message.ts === s.provider.canonicalMessageId &&
          message.user === o.state.senderUserId &&
          message.text === s.query,
      ) &&
      t.messages.some(
        (message) =>
          message.user === o.state.botUserId &&
          message.ts > s.provider.canonicalMessageId &&
          (message.text ?? "").includes(represented.name!),
      ),
    "An actual subsequent synthetic human message persists under the right company/sender/thread; the genuine represented-agent native reply is independently read back from that same provider thread.",
  );
  c.add(
    "separate-truthful-ready-confirmation-and-no-extra-work",
    !!last &&
      affirmativeReady(last.body) &&
      /slack/i.test(last.body) &&
      (o.scenarioId !== "connection-setup.channel-prerequisites" ||
        /Morgan/i.test(last.body)) &&
      o.runs.length === 3 &&
      o.runs.every(
        (row) =>
          row.companyId === o.companyId &&
          row.runtimeMode === "native" &&
          row.status === "succeeded" &&
          (row.id === t.sourceRunId ||
            (row.agentId === o.leadId &&
              row.contextSnapshot?.issueId === o.state.canonicalIssueId &&
              [o.state.initialRunId, last.runId].includes(row.id))),
      ) &&
      o.humanQueries.length === 2 &&
      o.endpoints.length === 1,
    "Only the two canonical Agent Chat phases and separately attributed two-way Slack probe run exist; the final ready claim follows actual delivery and does not manufacture an additional endpoint.",
  );
  return c.result();
}
function setupCase(
  id: "chat-channels.connect-slack" | "connection-setup.channel-prerequisites",
) {
  return definition(
    id,
    async (ctx) => {
      const prior = await ctx.input.api.get<{ enableChatConnectors?: boolean }>(
        "/api/instance/settings/experimental",
      );
      await ctx.input.api.patch("/api/instance/settings/experimental", {
        enableChatConnectors: true,
      });
      const represented =
        id === "connection-setup.channel-prerequisites"
          ? await identityWorker(ctx, "Morgan")
          : await ctx.input.api.get<Entity>(
              `/api/agents/${ctx.input.fixtures.agent.id}`,
            );
      const endpoints = await ctx.input.api.get<ChatEndpoint[]>(
        `${root(ctx)}/chat-endpoints`,
      );
      if (endpoints.length)
        throw new Error(
          "Slack setup requires an initially unconfigured disposable company",
        );
      fixtures.set(ctx, { represented });
      const chat = await openStandingChat(ctx);
      await ctx.input.api.patch(`/api/issues/${chat.id}`, {
        description: `Slack chat is enabled, but this company has no chat endpoint or linked sender. The requested represented agent is ${represented.name} (${represented.id}); that agent already has an eligible runtime. The signed-in human must connect their authorized disposable existing Slack app through supported chat setup.`,
      });
      return {
        represented,
        noEndpointsBefore: true,
        providerEnabledBefore: true,
        canonicalIssueId: chat.id,
        priorChatConnectors: prior.enableChatConnectors === true,
      };
    },
    gradeSlackSetup,
    {
      authentication: "human-session",
      expectedRunCount: 3,
      minimumRunCount: 3,
      expectedHumanMessageCount: 2,
      turnTimeoutMs: 120000,
      attemptTimeoutMs: 900000,
      externalInput: { provider: "slack", fields: slackSetupFields },
      sourceFiles: [
        "chat-catalog-domains/external-slack-setup.ts",
        "chat-catalog-domains/external-slack-fixture.ts",
        "chat-catalog-domains/external-slack-provider.ts",
        "chat-catalog-domains/external-slack-relay.ts",
        "chat-catalog-domains/external-slack-human.ts",
        "chat-catalog-domains/external-slack-human-worker.ts",
        "chat-catalog-domains/external-slack-human-contract.ts",
        "chat-catalog-domains/external-private-browser.ts",
        "chat-catalog-domains/external-private-browser-worker.ts",
        "chat-catalog-domains/external-slack-setup-private-contract.ts",
        "chat-catalog-domains/external-slack-identity-contract.ts",
        "chat-catalog-domains/external-fixtures.ts",
        "chat-catalog-domains/external-support.ts",
        "chat-catalog-domains/internal-support.ts",
        "chat-catalog-domains/identity-support.ts",
        "chat-slack-ingress.ts",
        "../../ui/src/pages/apps/chat/ChatEndpointSetup.tsx",
        "../../ui/src/pages/apps/chat/SlackIdentityStep.tsx",
        "../../ui/src/pages/apps/chat/slack/OwnSlackAppSetup.tsx",
        "../../server/src/services/chat-channels/setup-probes.ts",
        "../../server/src/services/chat-channels/slack/commands.ts",
        "../../server/src/services/chat-channels/slack/identity-links.ts",
        "../../server/src/services/chat-channels/identity-links.ts",
        "../../server/src/services/chat-channels.ts",
        `chat-scenarios/${id.split(".")[0]}.yaml`,
      ],
      async verifySetup(ctx, state) {
        const endpoints = await ctx.input.api.get<ChatEndpoint[]>(
            `${root(ctx)}/chat-endpoints`,
          ),
          enabled = await ctx.input.api.get<{ enableChatConnectors?: boolean }>(
            "/api/instance/settings/experimental",
          );
        const ready =
          endpoints.length === 0 &&
          enabled.enableChatConnectors === true &&
          (await ctx.allRuns()).length === 0;
        return {
          passed: ready,
          checks: [
            {
              id: "real-unconfigured-Slack-context",
              passed: ready,
              detail:
                "Actual available provider and company endpoint inventory have no configured route or native work.",
            },
          ],
        };
      },
      async act(ctx, state) {
        await waitForReply(ctx);
        const local = owned(ctx),
          initial = await observeExternal(ctx, state),
          first = initial.phaseReplies.at(-1);
        if (
          !first ||
          !slackSetupGuidance(
            first.body,
            String(local.represented.name),
            id === "connection-setup.channel-prerequisites",
          )
        )
          throw new Error(
            "Wrong represented-agent guidance or premature ready claim cannot be rescued by correct human setup",
          );
        state.initialRunId = first.runId;
        if (
          (
            await ctx.input.api.get<ChatEndpoint[]>(
              `${root(ctx)}/chat-endpoints`,
            )
          ).length
        )
          throw new Error(
            "An endpoint appeared before the required human creation",
          );
        const href = initial.links.find((link) => {
          try {
            const u = new URL(link, initial.origin);
            return (
              u.origin === initial.origin &&
              u.pathname ===
                `/${ctx.input.fixtures.company.issuePrefix}/apps/chat/connect` &&
              u.searchParams.get("provider") === "slack" &&
              (!u.searchParams.has("agentId") ||
                u.searchParams.get("agentId") === local.represented.id) &&
              !u.searchParams.has("resume")
            );
          } catch {
            return false;
          }
        });
        if (!href)
          throw new Error(
            "Slack human setup must be directed to its actual supported chat setup and requested agent",
          );
        state.agentEndpointCreateStatus = await probeAgentPermission(
          ctx,
          `${root(ctx)}/chat-endpoints`,
          "POST",
          { provider: "slack", assignedAgentId: local.represented.id },
        );
        const binding = selectedExternalBinding(ctx);
        assertSlackFixture(binding);
        const provider = slackProvider(ctx, binding),
          manifest = (
            await provider.call<{
              ok: true;
              manifest: {
                features?: { slash_commands?: Array<{ command: string }> };
              };
            }>("configuration", "apps.manifest.export", {
              app_id: binding.prerequisites.appId,
            })
          ).manifest;
        const commands =
          manifest.features?.slash_commands?.map((row) => row.command) ?? [];
        if (commands.length !== 1 || !/^\/[a-z0-9_-]{1,31}$/.test(commands[0]!))
          throw new Error(
            "Setup blocker: the designated existing app must expose one supported saved slash command",
          );
        const page = await ctx.input.page.context().newPage();
        try {
          await page.goto(href, { waitUntil: "domcontentloaded" });
          const purpose = page.getByRole("button", {
            name: /^Chat with an agent/,
          });
          if (await purpose.isVisible()) await purpose.click();
          await page
            .getByRole("heading", {
              name: "Which agent do you want to chat with?",
              exact: true,
            })
            .waitFor();
          const agentButton = page.getByRole("button", {
            name: String(local.represented.name),
            exact: true,
          });
          if (!(await agentButton.isVisible())) {
            await page
              .getByRole("button", {
                name: "Choose an active agent",
                exact: true,
              })
              .click();
            await page
              .getByRole("button", {
                name: `Select ${local.represented.name}`,
                exact: true,
              })
              .click();
          }
          await page
            .locator("summary")
            .filter({ hasText: /^Advanced$/ })
            .click();
          await page
            .getByLabel("Slash command", { exact: true })
            .fill(commands[0]!);
          const created = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname ===
                `${root(ctx)}/chat-endpoints` &&
              response.request().method() === "POST" &&
              response.status() === 201,
          );
          const own = page.getByRole("button", {
            name: "Use your own app",
            exact: true,
          });
          if (await own.isVisible()) await own.click();
          else
            await page
              .getByRole("button", { name: "Continue", exact: true })
              .click();
          const response = await created,
            endpoint = (await response.json()) as ChatEndpoint;
          local.createdEndpointId = endpoint.id;
          if (
            endpoint.companyId !== ctx.input.fixtures.company.id ||
            endpoint.provider !== "slack" ||
            endpoint.assignedAgentId !== local.represented.id
          )
            throw new Error(
              "Actual UI created another represented-agent/company endpoint",
            );
          const existing = page.getByRole("button", {
            name: "Use an existing app",
            exact: true,
          });
          await page
            .locator("details")
            .filter({ has: existing })
            .locator("summary")
            .click();
          const saved = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname ===
                `/api/chat-endpoints/${endpoint.id}` &&
              response.request().method() === "PATCH" &&
              response.ok(),
          );
          await existing.click();
          if (
            (await (await saved).json()).setup?.slackSetupMethod !== "existing"
          )
            throw new Error("Actual existing-app choice did not persist");
          state.createdByHumanUi = true;
        } finally {
          await page.close();
        }
        local.fixture = await prepareSlackFixture(ctx, {
          normalWizard: {
            endpointId: local.createdEndpointId!,
            agentId: local.represented.id,
          },
        });
        const f = local.fixture;
        state.workspaceId = f.binding.prerequisites.workspaceId;
        state.senderUserId = f.binding.prerequisites.senderUserId;
        state.botUserId = f.binding.prerequisites.botUserId;
        state.currentHumanId = (
          await ctx.input.api.get<{ user: { id: string } }>(
            "/api/auth/get-session",
          )
        ).user.id;
        const query =
          "Please say your exact Paperclip agent name and confirm you can reply in this same Slack conversation. Do not start a separate task.";
        f.relay.expectCanonical(query, f.threadId);
        const start = f.provider.receipts.length;
        const sent = await f.provider.call<{
          ok: true;
          channel: string;
          ts: string;
          message: { text: string; user: string; thread_ts: string };
        }>("sender", "chat.postMessage", {
          channel: f.binding.prerequisites.channelId,
          thread_ts: f.threadId,
          text: query,
          unfurl_links: false,
          unfurl_media: false,
        });
        if (
          sent.channel !== f.binding.prerequisites.channelId ||
          sent.message.user !== f.binding.prerequisites.senderUserId ||
          sent.message.text !== query ||
          sent.message.thread_ts !== f.threadId
        )
          throw new Error(
            "Actual two-way Slack probe changed sender/thread/text",
          );
        await pollUntil({
          label: "actual signed Slack post-activation message",
          deadlineAt: Date.now() + 30000,
          load: async () => f.relay.receipt(),
          accept: (row) => row.canonicalDeliveryCaptured,
        });
        local.source = await f.resolveIngress(
          query,
          sent.ts,
          f.provider.receipts.length - start,
        );
        const runs = await pollUntil({
          label: "genuine represented-agent Slack two-way native",
          deadlineAt: Date.now() + 150000,
          intervalMs: 1000,
          load: () => ctx.allRuns(),
          accept: (rows) =>
            rows.length === 2 &&
            rows.some(
              (row) =>
                row.agentId === local.represented.id &&
                row.contextSnapshot?.issueId === local.source!.issueId &&
                row.status === "succeeded" &&
                row.runtimeMode === "native",
            ),
          reject: (rows) =>
            rows.length > 2 ||
            rows.some((row) =>
              ["failed", "cancelled", "timed_out"].includes(row.status),
            )
              ? "Unexpected or failed real Slack setup probe native"
              : undefined,
        });
        local.sourceRunId = runs.find(
          (row) => row.contextSnapshot?.issueId === local.source!.issueId,
        )!.id;
        const comments = await ctx.input.api.get<IssueComment[]>(
          `/api/issues/${local.source.issueId}/comments?order=asc`,
        );
        local.sourceReply = comments
          .filter(
            (row) =>
              row.createdByRunId === local.sourceRunId &&
              row.authorAgentId === local.represented.id,
          )
          .at(-1);
        local.messages = await pollUntil({
          label: "actual represented-agent reply back to original Slack thread",
          deadlineAt: Date.now() + 60000,
          intervalMs: 2000,
          load: () => f.readThread(f.threadId),
          accept: (rows) =>
            rows.some(
              (row) =>
                row.user === f.binding.prerequisites.botUserId &&
                row.ts > sent.ts &&
                (row.text ?? "").includes(String(local.represented.name)),
            ),
        });
        await ctx.input.evidence("chat-catalog-slack-actual-human-setup.json", {
          credentialUi: f.credentialUiReceipt,
          identityUi: f.identityUiReceipt,
          humanCommand: f.humanCommandReceipt,
          signedConnect: f.relay.receipt().humanConnectCaptured,
          source: local.source,
          sourceRunId: local.sourceRunId,
          sourceReply: local.sourceReply,
          messages: local.messages,
        });
        await sendChatMessage(ctx.input.page, ctx.scenario.query);
      },
      async observe(ctx, state) {
        const o = await observeExternal(ctx, state),
          local = owned(ctx),
          f = local.fixture;
        let sourceBound = false;
        let endpoint: ChatEndpoint | undefined,
          principal: Awaited<ReturnType<Fixture["readPrincipal"]>> | undefined;
        if (f) {
          endpoint = await ctx.input.api.get<ChatEndpoint>(
            `/api/chat-endpoints/${f.endpoint.id}`,
          );
          principal = await f.readPrincipal();
          if (local.source) {
            const [conversations, binding, comments] = await Promise.all([
              ctx.input.api.get<ChatConversation[]>(
                `/api/chat-endpoints/${f.endpoint.id}/conversations`,
              ),
              ctx.input.api.get<ExternalChannelBindingSummary>(
                `/api/issues/${local.source.issueId}/chat-binding`,
              ),
              ctx.input.api.get<IssueComment[]>(
                `/api/issues/${local.source.issueId}/comments?order=asc`,
              ),
            ]);
            sourceBound = slackIngressReceiptMatches({
              receipt: local.source,
              query: local.source.query,
              companyId: ctx.input.fixtures.company.id,
              agentId: local.represented.id,
              endpoint,
              conversation: conversations.find(
                (row) => row.id === local.source!.conversationId,
              ),
              binding,
              comment: comments.find(
                (row) => row.id === local.source!.humanCommentId,
              ),
              links: [principal],
              linksEndpointId: endpoint.id,
              senderIdentity: f.senderIdentity,
            });
          }
        }
        return {
          ...o,
          slackSetup: {
            endpoint,
            source: local.source,
            sourceBound,
            sourceRunId: local.sourceRunId,
            sourceReply: local.sourceReply,
            messages: local.messages ?? [],
            credentialUi: f?.credentialUiReceipt,
            identityUi: f?.identityUiReceipt,
            humanCommand: f?.humanCommandReceipt,
            signedConnect: f?.relay.receipt().humanConnectCaptured === true,
            lastConnectAt: principal?.lastConnectAt,
            principalUserId: principal?.paperclipUserId,
            principalStatus: principal?.status,
          },
        } satisfies Observation;
      },
      async verifyResult(ctx, _state, value) {
        const o = value as Observation;
        await verifyRenderedReply(ctx, value);
        if (!o.slackSetup.endpoint)
          throw new Error("Actual activated Slack endpoint missing");
        const page = await ctx.input.page.context().newPage();
        try {
          await page.goto(
            `${o.origin}/${ctx.input.fixtures.company.issuePrefix}/apps/chat/${o.slackSetup.endpoint.id}/settings`,
            { waitUntil: "domcontentloaded" },
          );
          await expect(page.getByRole("main")).toContainText(
            String((o.state.represented as Entity).name),
          );
        } finally {
          await page.close();
        }
      },
      async cleanup(ctx, state) {
        const local = fixtures.get(ctx);
        try {
          if (local?.fixture) await local.fixture.cleanup();
          else if (local?.createdEndpointId)
            await ctx.input.api.post(
              `/api/chat-endpoints/${local.createdEndpointId}/setup`,
              { action: "remove" },
            );
        } finally {
          fixtures.delete(ctx);
          await ctx.input.api.patch("/api/instance/settings/experimental", {
            enableChatConnectors: state.priorChatConnectors === true,
          });
        }
      },
    },
  );
}
export const slackSetupExternalCases = [
  setupCase("chat-channels.connect-slack"),
  setupCase("connection-setup.channel-prerequisites"),
];
