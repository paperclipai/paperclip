import { expect } from "@playwright/test";
import type {
  ChatCatalogContext,
  ChatSlackIngressReceipt,
} from "../chat-catalog-contract.js";
import type {
  ChatActivityItem,
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
  waitForReply,
  probeAgentPermission,
} from "./identity-support.js";
import {
  selectedExternalBinding,
  selectedExternalCredential,
} from "./external-fixtures.js";
import {
  prepareSlackFixture,
  slackCompanionFields,
  type SlackMessage,
} from "./external-slack-fixture.js";
import {
  privateBrowserEntry,
  type PrivateBrowserReceipt,
} from "./external-private-browser.js";
import { privateSlackHumanConnect } from "./external-slack-human.js";
import {
  probeSlackAuthorization,
  type SlackAuthorizationReceipt,
} from "./external-slack-authorization.js";
export const slackRepairFields = [
  ...slackCompanionFields,
  "slackBrowserSessionEnv",
  "botTokenExpiresAt",
  "repairBotTokenEnv",
] as const;
type Fixture = Awaited<ReturnType<typeof prepareSlackFixture>>;
interface Local {
  fixture: Fixture;
  oldValid: SlackAuthorizationReceipt;
  expired: SlackAuthorizationReceipt;
  fresh: SlackAuthorizationReceipt;
  failedActivity: ChatActivityItem[];
  failedMessageId: string;
  credentialUi?: PrivateBrowserReceipt;
  wizardUi?: PrivateBrowserReceipt;
  source?: ChatSlackIngressReceipt;
  runId?: string;
  reply?: IssueComment;
  messages?: SlackMessage[];
  connectAt?: string | null;
  retryUi?: import("./external-slack-human-contract.js").SlackHumanConnectReceipt;
}
const fixtures = new WeakMap<ChatCatalogContext, Local>();
function owned(ctx: ChatCatalogContext) {
  const value = fixtures.get(ctx);
  if (!value) throw new Error("Actual expired Slack fixture missing");
  return value;
}
export function slackRepairGuidance(reply: string) {
  return (
    /slack/i.test(reply) &&
    /reconnect|repair|re.authori[sz]|authorization.*expired|expired.*authorization/i.test(
      reply,
    ) &&
    /you|human|admin|operator|settings|setup/i.test(reply) &&
    !reply
      .split(/[.!?;\n]+|\bbut\b/i)
      .some(
        (clause) =>
          !/\b(?:not|cannot|can't|before|once|after|until|will|would|need|must)\b/i.test(
            clause,
          ) &&
          (/\b(?:I|we)(?:['’]ve| have)?\s+(?:already\s+)?(?:reconnected|fixed|repaired|restored)\b/i.test(
            clause,
          ) ||
            /\b(?:slack|connection|replies)\s+(?:is|are)\s+(?:already\s+|now\s+)?(?:ready|working|repaired|restored)\b/i.test(
              clause,
            )),
      )
  );
}
interface Observation extends ExternalObservation {
  repair: {
    endpoint: ChatEndpoint;
    oldValid: SlackAuthorizationReceipt;
    expired: SlackAuthorizationReceipt;
    fresh: SlackAuthorizationReceipt;
    failedActivity: ChatActivityItem[];
    credentialUi?: PrivateBrowserReceipt;
    wizardUi?: PrivateBrowserReceipt;
    source?: ChatSlackIngressReceipt;
    sourceBound: boolean;
    runId?: string;
    reply?: IssueComment;
    messages: SlackMessage[];
    connectAt?: string | null;
    retryUi?: import("./external-slack-human-contract.js").SlackHumanConnectReceipt;
    principalUserId?: string | null;
    failedProviderCapture: boolean;
  };
}
export function gradeSlackRepair(value: unknown) {
  const c = checks(),
    o = externalObservation(value) as Observation | undefined,
    t = o?.repair;
  c.add(
    "real-expired-authorization-repair-evidence",
    !!o &&
      !!t &&
      !!t.endpoint &&
      Array.isArray(t.failedActivity) &&
      Array.isArray(t.messages),
    "Actual old-valid→token_expired proof, failed signed intake, real human reconnect and new delivery evidence are required.",
  );
  if (
    !o ||
    !t ||
    !t.endpoint ||
    !Array.isArray(t.failedActivity) ||
    !Array.isArray(t.messages)
  )
    return c.result();
  const first = o.phaseReplies.find(
      (row) => row.runId === o.state.initialRunId,
    ),
    last = o.phaseReplies
      .filter((row) => row.runId !== o.state.initialRunId)
      .at(-1),
    s = t.source,
    run = o.runs.find((row) => row.id === t.runId),
    e = t.endpoint;
  c.add(
    "qualified-real-expiry-not-invalid-fixture",
    t.oldValid?.ok === true &&
      t.oldValid.identityMatches === true &&
      t.expired?.ok === false &&
      t.expired.code === "token_expired" &&
      t.fresh?.ok === true &&
      t.fresh.identityMatches === true &&
      o.state.noSetupNative === true &&
      o.state.noSetupConversation === true &&
      o.state.failedSignedProviderDelivery === true &&
      t.failedActivity.some(
        (row) =>
          row.kind === "delivery" &&
          ["failed", "retry", "pending"].includes(row.status) &&
          /expired|invalid.auth|authentication|authorization|token/i.test(
            `${row.detail ?? ""} ${row.summary}`,
          ),
      ),
    "The actual previously working selected credential naturally expires; an independently valid same-bot repair credential exists, and a genuine signed delivery fails without pre-creating requested work.",
  );
  c.add(
    "board-only-correct-target-human-repair",
    !!first &&
      slackRepairGuidance(first.body) &&
      o.state.agentReconnectStatus === 403 &&
      o.state.directedEndpointId === e.id &&
      e.id === o.state.endpointId &&
      e.companyId === o.companyId &&
      e.assignedAgentId === o.leadId,
    "The actual first phase truthfully directs this endpoint's supported human repair; an agent cannot reconnect it or claim it was repaired before the human.",
  );
  c.add(
    "actual-reconnect-and-activation-ui",
    t.credentialUi?.endpointId === e.id &&
      t.credentialUi.slackCredentialUiVisible === true &&
      t.credentialUi.humanSubmittedSecurely === true &&
      t.credentialUi.storageClean === true &&
      t.credentialUi.processIsolation === true &&
      t.credentialUi.testRunnerAttached === false &&
      t.credentialUi.tracingEnabled === false &&
      t.credentialUi.videoEnabled === false &&
      t.credentialUi.apiStepRecorder === false &&
      t.credentialUi.credentialUiRejected !== true &&
      t.retryUi?.callbackRetryRequested === true &&
      t.retryUi.processIsolation === true &&
      t.retryUi.testRunnerAttached === false &&
      t.retryUi.tracingEnabled === false &&
      t.retryUi.videoEnabled === false &&
      t.retryUi.verifiedHumanId === o.state.senderUserId &&
      t.retryUi.verifiedWorkspaceId === o.state.workspaceId &&
      o.state.verificationClearedAfterReconnect === true &&
      !!e.setup.webhookVerifiedAt &&
      Date.parse(e.setup.webhookVerifiedAt) >=
        Number(o.state.repairVerificationStarted) - 1000 &&
      t.wizardUi?.endpointId === e.id &&
      t.wizardUi.activationUiVisible === true &&
      t.wizardUi.endpointActive === true &&
      t.wizardUi.identityWasAlreadyLinked === true &&
      t.wizardUi.processIsolation === true &&
      t.wizardUi.testRunnerAttached === false &&
      t.wizardUi.tracingEnabled === false &&
      t.wizardUi.videoEnabled === false &&
      t.wizardUi.apiStepRecorder === false &&
      t.wizardUi.paperclipUserId === o.state.currentHumanId &&
      t.principalUserId === o.state.currentHumanId &&
      !!t.connectAt &&
      e.status === "active" &&
      e.providerAccountId === o.state.workspaceId &&
      e.setup.step === "complete" &&
      !!e.setup.webhookVerifiedAt &&
      e.allowUnlinkedPeople === false,
    "The real protected Reconnect form verifies the same bot and a genuine new human connect receipt enables normal Continue/Done; the original person's identity and routing policy remain intact.",
  );
  c.add(
    "new-correct-thread-native-reply-after-repair",
    !!s &&
      t.sourceBound &&
      s.issueId !== o.state.canonicalIssueId &&
      s.provider.threadId === o.state.threadId &&
      !!run &&
      run.companyId === o.companyId &&
      run.agentId === o.leadId &&
      run.runtimeMode === "native" &&
      run.status === "succeeded" &&
      run.contextSnapshot?.issueId === s.issueId &&
      t.reply?.createdByRunId === run.id &&
      t.reply.authorAgentId === o.leadId &&
      !!t.reply.body.trim() &&
      t.messages.some(
        (row) =>
          row.ts === s.provider.canonicalMessageId &&
          row.text === s.query &&
          row.user === o.state.senderUserId,
      ) &&
      t.messages.some(
        (row) =>
          row.user === o.state.botUserId &&
          row.ts > s.provider.canonicalMessageId &&
          !!row.text?.trim(),
      ),
    "Healthy auth alone never proves repair: a newly signed message after actual human repair must persist in the intended thread, run natively and publish a real reply back there.",
  );
  c.add(
    "separate-honest-repair-confirmation",
    !!last &&
      /slack/i.test(last.body) &&
      /working|repaired|restored|reconnected|ready/i.test(last.body) &&
      !/(?:not|isn['’]t)\s+(?:yet\s+)?(?:working|repaired|restored|reconnected|ready)/i.test(
        last.body,
      ) &&
      o.runs.length === 3 &&
      o.runs.every(
        (row) =>
          row.companyId === o.companyId &&
          row.runtimeMode === "native" &&
          row.status === "succeeded" &&
          (row.id === t.runId ||
            (row.agentId === o.leadId &&
              row.contextSnapshot?.issueId === o.state.canonicalIssueId &&
              [o.state.initialRunId, last.runId].includes(row.id))),
      ) &&
      o.humanQueries.length === 2 &&
      o.endpoints.length === 1,
    "The later canonical reply belongs to its own run after actual new delivery; no replacement endpoint, indefinite retry or unrelated native work substitutes for repairing this endpoint.",
  );
  return c.result();
}
async function send(ctx: ChatCatalogContext, f: Fixture, query: string) {
  f.relay.expectCanonical(query, f.threadId);
  const start = f.provider.receipts.length,
    result = await f.provider.call<{
      ok: true;
      channel: string;
      ts: string;
      message: { user: string; text: string; thread_ts: string };
    }>("sender", "chat.postMessage", {
      channel: f.binding.prerequisites.channelId,
      thread_ts: f.threadId,
      text: query,
      unfurl_links: false,
      unfurl_media: false,
    });
  if (
    result.channel !== f.binding.prerequisites.channelId ||
    result.message.user !== f.binding.prerequisites.senderUserId ||
    result.message.text !== query ||
    result.message.thread_ts !== f.threadId
  )
    throw new Error(
      "Actual Slack repair probe changed the designated human/thread/text",
    );
  await pollUntil({
    label: "genuine signed Slack repair probe",
    deadlineAt: Date.now() + 30000,
    load: async () => f.relay.receipt(),
    accept: (row) => row.canonicalDeliveryCaptured,
  });
  return { messageId: result.ts, calls: f.provider.receipts.length - start };
}
export const slackRepairExternalCases = [
  definition(
    "chat-channels.repair-endpoint",
    async (ctx) => {
      const binding = selectedExternalBinding(ctx),
        expires = Date.parse(binding.prerequisites.botTokenExpiresAt ?? "");
      if (
        !Number.isFinite(expires) ||
        expires < Date.now() + 120000 ||
        expires > Date.now() + 480000
      )
        throw new Error(
          "Setup blocker: a designated rotating Slack bot credential must still be valid and naturally expire in the bounded two-to-eight-minute qualification window",
        );
      if (
        selectedExternalCredential(ctx, binding, "botTokenEnv") ===
        selectedExternalCredential(ctx, binding, "repairBotTokenEnv")
      )
        throw new Error(
          "Setup blocker: expiring and fresh repair Slack credentials must be distinct actual tokens",
        );
      const oldValid = await probeSlackAuthorization(
          ctx,
          binding,
          "botTokenEnv",
        ),
        fresh = await probeSlackAuthorization(
          ctx,
          binding,
          "repairBotTokenEnv",
        );
      if (
        !oldValid.ok ||
        !oldValid.identityMatches ||
        !fresh.ok ||
        !fresh.identityMatches
      )
        throw new Error(
          "Setup blocker: actual currently valid old and fresh same-bot Slack credentials are required",
        );
      const f = await prepareSlackFixture(ctx, {
        observeWithRepairCredential: true,
        useExistingAppCommand: true,
      });
      try {
        // Invalidate the qualified SDK generation while credentials are genuinely
        // valid; after natural expiry the next intake must exercise fresh auth reads.
        await ctx.input.api.post(`/api/chat-endpoints/${f.endpoint.id}/setup`, {
          action: "pause",
        });
        await ctx.input.api.post(`/api/chat-endpoints/${f.endpoint.id}/setup`, {
          action: "resume",
        });
        const expired = await pollUntil({
          label: "actual natural Slack token expiry",
          deadlineAt: expires + 30000,
          intervalMs: 5000,
          load: () => probeSlackAuthorization(ctx, binding, "botTokenEnv"),
          accept: (row) => !row.ok && row.code === "token_expired",
          reject: (row) =>
            !row.ok && row.code !== "token_expired"
              ? "Setup blocker: selected Slack token failed for a reason other than the required natural expiry"
              : undefined,
        });
        const query =
            "Please confirm this Slack connection can receive a message.",
          failed = await send(ctx, f, query);
        const failedActivity = await pollUntil({
          label:
            "actual expired Slack credential failed intake without native work",
          deadlineAt: Date.now() + 60000,
          intervalMs: 1000,
          load: async () => ({
            activity: await ctx.input.api.get<ChatActivityItem[]>(
              `/api/chat-endpoints/${f.endpoint.id}/activity`,
            ),
            runs: await ctx.allRuns(),
          }),
          accept: (value) =>
            value.runs.length === 0 &&
            value.activity.some(
              (row) =>
                row.kind === "delivery" &&
                ["failed", "retry", "pending"].includes(row.status) &&
                /expired|invalid.auth|authentication|authorization|token/i.test(
                  `${row.detail ?? ""} ${row.summary}`,
                ),
            ),
          reject: (value) =>
            value.runs.length
              ? "Setup blocker: the selected expired token did not qualify a failed-intake/no-native starting context"
              : undefined,
        });
        const conversations = await ctx.input.api.get<ChatConversation[]>(
          `/api/chat-endpoints/${f.endpoint.id}/conversations`,
        );
        if (conversations.length)
          throw new Error(
            "Setup blocker: expired Slack intake already created a conversation instead of the required failed starting context",
          );
        fixtures.set(ctx, {
          fixture: f,
          oldValid,
          expired,
          fresh,
          failedActivity: failedActivity.activity,
          failedMessageId: failed.messageId,
        });
        const chat = await openStandingChat(ctx);
        await ctx.input.api.patch(`/api/issues/${chat.id}`, {
          description: `The existing Slack endpoint is ${f.endpoint.id}, assigned to you. A real preflight delivery in its intended Slack conversation failed after its previously valid bot authorization naturally expired. The original thread remains ${f.threadId}; there is no new authorized conversation. Supported repair is /${ctx.input.fixtures.company.issuePrefix}/apps/chat/connect?provider=slack&purpose=chat&resume=${f.endpoint.id}&reconnect=1.`,
        });
        return {
          endpointId: f.endpoint.id,
          canonicalIssueId: chat.id,
          currentHumanId: (
            await ctx.input.api.get<{ user: { id: string } }>(
              "/api/auth/get-session",
            )
          ).user.id,
          workspaceId: binding.prerequisites.workspaceId,
          senderUserId: binding.prerequisites.senderUserId,
          botUserId: binding.prerequisites.botUserId,
          threadId: f.threadId,
          noSetupNative: failedActivity.runs.length === 0,
          noSetupConversation: conversations.length === 0,
          failedSignedProviderDelivery:
            f.relay.receipt().canonicalDeliveryCaptured,
        };
      } catch (error) {
        await f.cleanup();
        throw error;
      }
    },
    gradeSlackRepair,
    {
      authentication: "human-session",
      expectedRunCount: 3,
      minimumRunCount: 3,
      expectedHumanMessageCount: 2,
      turnTimeoutMs: 120000,
      attemptTimeoutMs: 1500000,
      externalInput: { provider: "slack", fields: slackRepairFields },
      sourceFiles: [
        "chat-catalog-domains/external-slack-repair.ts",
        "chat-catalog-domains/external-slack-authorization.ts",
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
        "../../server/src/services/chat-channels/configuration.ts",
        "../../server/src/services/chat-channels/slack/credentials.ts",
        "../../server/src/services/chat-channels/slack/commands.ts",
        "../../server/src/services/chat-channels.ts",
        "chat-scenarios/chat-channels.yaml",
      ],
      async verifySetup(ctx, state) {
        const local = owned(ctx),
          old = await probeSlackAuthorization(
            ctx,
            local.fixture.binding,
            "botTokenEnv",
          ),
          fresh = await probeSlackAuthorization(
            ctx,
            local.fixture.binding,
            "repairBotTokenEnv",
          ),
          ready =
            old.code === "token_expired" &&
            fresh.ok &&
            fresh.identityMatches &&
            (await ctx.allRuns()).length === 0;
        return {
          passed: ready,
          checks: [
            {
              id: "actual-expired-authorization-with-fresh-same-bot-repair",
              passed: ready,
              detail:
                "Natural provider token_expired is retained independently from the originally valid credential and no native work was admitted during qualification.",
            },
          ],
        };
      },
      async act(ctx, state) {
        await waitForReply(ctx);
        const local = owned(ctx),
          f = local.fixture,
          o = await observeExternal(ctx, state),
          first = o.phaseReplies.at(-1);
        if (!first || !slackRepairGuidance(first.body))
          throw new Error(
            "Unsupported or falsely completed repair advice cannot be rescued by the human fixture",
          );
        state.initialRunId = first.runId;
        const href = o.links.find((link) => {
          try {
            const u = new URL(link, o.origin);
            return (
              u.origin === o.origin &&
              u.pathname ===
                `/${ctx.input.fixtures.company.issuePrefix}/apps/chat/connect` &&
              u.searchParams.get("provider") === "slack" &&
              u.searchParams.get("resume") === f.endpoint.id &&
              u.searchParams.get("reconnect") === "1"
            );
          } catch {
            return false;
          }
        });
        if (!href)
          throw new Error(
            "Actual first phase must direct this exact existing endpoint's supported human Reconnect path",
          );
        state.directedEndpointId = f.endpoint.id;
        state.agentReconnectStatus = await probeAgentPermission(
          ctx,
          `/api/chat-endpoints/${f.endpoint.id}/setup`,
          "POST",
          { action: "reconnect" },
        );
        const repairURL = new URL(href, o.origin);
        repairURL.searchParams.set("purpose", "chat");
        repairURL.searchParams.set("stage", "credentials");
        local.credentialUi = await privateBrowserEntry({
          mode: "slack-endpoint-reconnect",
          companyId: ctx.input.fixtures.company.id,
          slackSetup: {
            endpointId: f.endpoint.id,
            agentId: ctx.input.fixtures.agent.id,
            workspaceId: f.binding.prerequisites.workspaceId!,
            signingSecret: selectedExternalCredential(
              ctx,
              f.binding,
              "signingSecretEnv",
            ),
          },
          baseURL: o.origin,
          setupURL: repairURL.href,
          providerURL: o.origin,
          credential: selectedExternalCredential(
            ctx,
            f.binding,
            "repairBotTokenEnv",
          ),
          cookies: await ctx.input.page.context().cookies(o.origin),
        });
        if (local.credentialUi.credentialUiRejected) {
          await ctx.input.evidence(
            "chat-catalog-Slack-repair-credential-UI-rejected.json",
            local.credentialUi,
          );
          throw new Error(
            "Product Slack Reconnect form rejected the actual selected rotating bot-token format; repair is incomplete",
          );
        }
        const configured = await ctx.input.api.get<ChatEndpoint>(
            `/api/chat-endpoints/${f.endpoint.id}`,
          ),
          repairVerificationStarted = Date.now();
        if (!configured.setup.webhookUrl || !configured.setup.command)
          throw new Error(
            "Actual saved Slack app callback/command missing during repair",
          );
        const selectedChannel = await f.provider.call<{
          ok: true;
          channel: { id: string; name: string };
        }>("bot", "conversations.info", {
          channel: f.binding.prerequisites.channelId,
        });
        if (selectedChannel.channel.id !== f.binding.prerequisites.channelId)
          throw new Error("Selected repair callback channel changed");
        state.repairVerificationStarted = repairVerificationStarted;
        state.verificationClearedAfterReconnect =
          !configured.setup.webhookVerifiedAt;
        local.retryUi = await privateSlackHumanConnect(
          {
            operation: "retry-callback",
            appId: f.binding.prerequisites.appId!,
            callbackURL: configured.setup.webhookUrl,
            workspaceId: f.binding.prerequisites.workspaceId!,
            channelId: f.binding.prerequisites.channelId!,
            channelName: selectedChannel.channel.name,
            senderUserId: f.binding.prerequisites.senderUserId!,
            command: configured.setup.command,
            sessionJson: selectedExternalCredential(
              ctx,
              f.binding,
              "slackBrowserSessionEnv",
            ),
          },
          ctx.input.privateSecrets!,
        );
        await pollUntil({
          label:
            "fresh actual provider-signed Slack URL verification after human Retry",
          deadlineAt: Date.now() + 60000,
          load: () =>
            ctx.input.api.get<ChatEndpoint>(
              `/api/chat-endpoints/${f.endpoint.id}`,
            ),
          accept: (row) =>
            !!row.setup.webhookVerifiedAt &&
            Date.parse(row.setup.webhookVerifiedAt) >=
              repairVerificationStarted - 1000,
        });
        const page = await ctx.input.page.context().newPage();
        try {
          await page.goto(
            `${o.origin}/${ctx.input.fixtures.company.issuePrefix}/apps/chat/connect?provider=slack&purpose=chat&resume=${f.endpoint.id}`,
            { waitUntil: "domcontentloaded" },
          );
          await page
            .getByRole("heading", {
              name: "Verify Slack connection",
              exact: true,
            })
            .waitFor();
          const verified = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname ===
                `/api/chat-endpoints/${f.endpoint.id}/setup` &&
              response.request().method() === "POST" &&
              response.ok(),
          );
          await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
          const response = await verified;
          if (response.request().postDataJSON()?.action !== "verify")
            throw new Error(
              "Real Slack verification UI submitted another operation",
            );
          await response.json();
        } finally {
          await page.close();
        }
        const endpoint = await ctx.input.api.get<ChatEndpoint>(
            `/api/chat-endpoints/${f.endpoint.id}`,
          ),
          command = endpoint.setup.command;
        if (!command)
          throw new Error("Actual saved Slack app command unavailable");
        f.relay.expectHumanConnect(command);
        const channel = await f.provider.call<{
          ok: true;
          channel: { id: string; name: string };
        }>("bot", "conversations.info", {
          channel: f.binding.prerequisites.channelId,
        });
        if (channel.channel.id !== f.binding.prerequisites.channelId)
          throw new Error("Selected repair channel changed");
        const since = Date.now();
        await privateSlackHumanConnect(
          {
            workspaceId: f.binding.prerequisites.workspaceId!,
            channelId: f.binding.prerequisites.channelId!,
            channelName: channel.channel.name,
            senderUserId: f.binding.prerequisites.senderUserId!,
            command,
            sessionJson: selectedExternalCredential(
              ctx,
              f.binding,
              "slackBrowserSessionEnv",
            ),
          },
          ctx.input.privateSecrets!,
        );
        await pollUntil({
          label: "new genuine signed Slack repair connect receipt",
          deadlineAt: Date.now() + 60000,
          load: () => f.readPrincipal(),
          accept: (row) =>
            f.relay.receipt().humanConnectCaptured &&
            !!row.lastConnectAt &&
            Date.parse(row.lastConnectAt) >= since - 1000,
        });
        const principal = await f.readPrincipal();
        local.wizardUi = await privateBrowserEntry({
          mode: "slack-wizard-resume",
          companyId: ctx.input.fixtures.company.id,
          slackIdentity: {
            endpointId: f.endpoint.id,
            principalId: f.principalId,
            userId: String(state.currentHumanId),
            externalDetail: principal.externalDetail,
            externalLabel: principal.externalLabel,
          },
          baseURL: o.origin,
          setupURL: `${o.origin}/${ctx.input.fixtures.company.issuePrefix}/apps/chat/connect?provider=slack&purpose=chat&resume=${f.endpoint.id}`,
          providerURL: o.origin,
          credential: "finite-Slack-repair-wizard-resume",
          cookies: await ctx.input.page.context().cookies(o.origin),
        });
        local.connectAt = (await f.readPrincipal()).lastConnectAt;
        f.relay.nextFilePhase();
        const query =
            "Please confirm you can reply in this same repaired Slack conversation. Do not start a separate task.",
          sent = await send(ctx, f, query);
        local.source = await f.resolveIngress(
          query,
          sent.messageId,
          sent.calls,
        );
        const runs = await pollUntil({
          label: "new same-thread real Slack native after actual repair",
          deadlineAt: Date.now() + 150000,
          intervalMs: 1000,
          load: () => ctx.allRuns(),
          accept: (rows) =>
            rows.length === 2 &&
            rows.some(
              (row) =>
                row.contextSnapshot?.issueId === local.source!.issueId &&
                row.agentId === ctx.input.fixtures.agent.id &&
                row.status === "succeeded" &&
                row.runtimeMode === "native",
            ),
          reject: (rows) =>
            rows.length > 2 ||
            rows.some((row) =>
              ["failed", "cancelled", "timed_out"].includes(row.status),
            )
              ? "Unexpected/failed native instead of repaired Slack delivery"
              : undefined,
        });
        local.runId = runs.find(
          (row) => row.contextSnapshot?.issueId === local.source!.issueId,
        )!.id;
        const comments = await ctx.input.api.get<IssueComment[]>(
          `/api/issues/${local.source.issueId}/comments?order=asc`,
        );
        local.reply = comments
          .filter(
            (row) =>
              row.createdByRunId === local.runId &&
              row.authorAgentId === ctx.input.fixtures.agent.id,
          )
          .at(-1);
        local.messages = await pollUntil({
          label: "actual new provider-thread reply after Slack repair",
          deadlineAt: Date.now() + 60000,
          intervalMs: 2000,
          load: () => f.readThread(f.threadId),
          accept: (rows) =>
            rows.some(
              (row) =>
                row.ts > sent.messageId &&
                row.user === f.binding.prerequisites.botUserId &&
                !!row.text?.trim(),
            ),
        });
        await ctx.input.evidence(
          "chat-catalog-Slack-actual-expiry-and-repair.json",
          {
            oldValid: local.oldValid,
            expired: local.expired,
            fresh: local.fresh,
            failedActivity: local.failedActivity,
            credentialUi: local.credentialUi,
            wizardUi: local.wizardUi,
            retryUi: local.retryUi,
            source: local.source,
            runId: local.runId,
            reply: local.reply,
            messages: local.messages,
          },
        );
        await sendChatMessage(ctx.input.page, ctx.scenario.query);
      },
      async observe(ctx, state) {
        const o = await observeExternal(ctx, state),
          local = owned(ctx),
          f = local.fixture,
          endpoint = await ctx.input.api.get<ChatEndpoint>(
            `/api/chat-endpoints/${f.endpoint.id}`,
          ),
          principal = await f.readPrincipal();
        let sourceBound = false;
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
            agentId: ctx.input.fixtures.agent.id,
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
        return {
          ...o,
          repair: {
            endpoint,
            oldValid: local.oldValid,
            expired: local.expired,
            fresh: local.fresh,
            failedActivity: local.failedActivity,
            credentialUi: local.credentialUi,
            wizardUi: local.wizardUi,
            retryUi: local.retryUi,
            source: local.source,
            sourceBound,
            runId: local.runId,
            reply: local.reply,
            messages: local.messages ?? [],
            connectAt: local.connectAt,
            principalUserId: principal.paperclipUserId,
            failedProviderCapture: state.failedSignedProviderDelivery === true,
          },
        } satisfies Observation;
      },
      async verifyResult(ctx, _state, value) {
        const o = value as Observation;
        await verifyRenderedReply(ctx, value);
        const page = await ctx.input.page.context().newPage();
        try {
          await page.goto(
            `${o.origin}/${ctx.input.fixtures.company.issuePrefix}/apps/chat/${o.repair.endpoint.id}/settings`,
            { waitUntil: "domcontentloaded" },
          );
          await expect(page.getByRole("main")).toBeVisible();
          await expect(
            page.getByText("Connected", { exact: true }).first(),
          ).toBeVisible();
        } finally {
          await page.close();
        }
      },
      async cleanup(ctx) {
        const local = fixtures.get(ctx);
        try {
          await local?.fixture.cleanup();
        } finally {
          fixtures.delete(ctx);
        }
      },
    },
  ),
];
