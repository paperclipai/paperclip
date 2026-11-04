import { createHash, randomBytes } from "node:crypto";
import { expect } from "@playwright/test";
import { chatCatalogAgentIsReady, type ChatCatalogContext } from "../chat-catalog-contract.js";
import type {
  CompanySecret,
  UserSecretDefinition,
} from "../../../packages/shared/src/types/secrets.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { collectRunEvents } from "../run-observations.js";
import {
  identityWorker,
  openStandingChat,
  probeAgentPermission,
  waitForReply,
  remainingIdentityObservationBudget,
} from "./identity-support.js";
import {
  createAuthenticatedPerson,
  enrollPrerequisitePerson,
} from "./identity-auth.js";
import { privateBrowserEntry } from "./external-private-browser.js";
import { secretTestEndpoint } from "./external-secret-endpoint.js";
import { solicitsChatCredential } from "./external-credential-language.js";
import {
  bytesContainSecret,
  privateScanJson,
  scanReachableSecretOutputs,
  sameSecretIdentity,
} from "./external-secret-scan.js";
import {
  definition,
  root,
  checks,
  externalObservation,
  observeExternal,
  verifyRenderedReply,
} from "./external-support.js";
import type { Entity } from "./internal-support.js";
type OwnEntry = {
  definition: UserSecretDefinition;
  secret: CompanySecret | null;
};
interface PrivateFixture {
  value: string;
  otherValue: string;
  other: Awaited<ReturnType<typeof createAuthenticatedPerson>>;
  endpoint: Awaited<ReturnType<typeof secretTestEndpoint>>;
}
const fixtures = new WeakMap<ChatCatalogContext, PrivateFixture>();
interface PersonalSetupAgent { id: string; companyId: string; lifecycleState: string; status: string; lifecycleError?: string | null; lifecycleHolds: string[]; adapterType: string; adapterConfig: Record<string, unknown> & { env?: Record<string, unknown> } }
const missingBindingLifecycleError = "Execution configuration check failed. Paperclip could not complete this step. It will retry automatically. If this continues, contact your instance administrator.";
export function personalSecretUnboundConfigHash(config: Record<string, unknown>): string {
  const env = { ...(config.env as Record<string, unknown> | undefined) }; delete env.PUBLISHING_API_KEY;
  return createHash("sha256").update(JSON.stringify({ ...config, env })).digest("hex");
}
/** A configured worker must be healthy before introducing the intentional missing value. */
export async function preparePersonalSecretWorker(ctx: ChatCatalogContext, id: string): Promise<PersonalSetupAgent> {
  const deadlineAt = Date.now() + Math.min(45_000, remainingIdentityObservationBudget(ctx));
  const agent = await pollUntil<PersonalSetupAgent>({ label: "personal-secret worker ready before required binding", deadlineAt, intervalMs: 500,
    load: () => ctx.input.api.get(`/api/agents/${id}`),
    accept: value => chatCatalogAgentIsReady(value), reject: value => value.lifecycleError ? "Personal-secret worker has an unrelated setup failure before its required binding" : undefined });
  remainingIdentityObservationBudget(ctx);
  if (agent.id !== id || agent.companyId !== ctx.input.fixtures.company.id || agent.adapterType !== "paperclip_runner" || Object.hasOwn(agent.adapterConfig.env ?? {}, "PUBLISHING_API_KEY")) throw new Error("Personal-secret prerequisite worker identity or initial binding differs");
  return agent;
}
/** This is a prospective saved-config resolution check. The exact missing user
 * secret response is raised before adapter execution or environment acquisition. */
export async function provePersonalSecretMissingBoundary(ctx: ChatCatalogContext, state: Record<string, unknown>, agent: PersonalSetupAgent): Promise<void> {
  remainingIdentityObservationBudget(ctx);
  const lead = await ctx.input.api.get<PersonalSetupAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
  if (!chatCatalogAgentIsReady(lead) || lead.id !== ctx.input.fixtures.agent.id || lead.companyId !== ctx.input.fixtures.company.id || lead.lifecycleError) throw new Error("Personal-secret CEO must remain independently ready");
  const ref = (agent.adapterConfig.env as Record<string, unknown> | undefined)?.PUBLISHING_API_KEY as { type?: string; key?: string; required?: boolean; allowMissingOverride?: boolean } | undefined;
  if (!["ready", "preparing", "verifying", "pausing"].includes(agent.lifecycleState) || !Array.isArray(agent.lifecycleHolds) || agent.lifecycleHolds.some(hold => hold !== "setup") || state.morganReadyBeforeRequiredBinding !== true || agent.id !== state.morganId || agent.companyId !== ctx.input.fixtures.company.id || agent.adapterType !== "paperclip_runner" || personalSecretUnboundConfigHash(agent.adapterConfig) !== state.morganUnboundConfigHash || ref?.type !== "user_secret_ref" || ref.key !== "PERSONAL_PUBLISHING_KEY" || ref.required !== true || ref.allowMissingOverride !== false || (agent.lifecycleError && agent.lifecycleError !== missingBindingLifecycleError)) throw new Error("Personal-secret worker has an unrelated lifecycle or configuration failure");
  const origin = ctx.input.api.baseURL, cookies = await ctx.input.page.context().cookies(origin);
  if (!cookies.length) throw new Error("Personal-secret setup probe requires the real current-person session");
  const response = await fetch(new URL(`/api/companies/${ctx.input.fixtures.company.id}/adapters/paperclip_runner/test-environment`, origin), { method: "POST", redirect: "error", signal: AbortSignal.timeout(Math.min(15_000, remainingIdentityObservationBudget(ctx))), headers: { "content-type": "application/json", Origin: origin, Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ") }, body: JSON.stringify({ agentId: agent.id, adapterConfig: agent.adapterConfig }) });
  try {
    let body: { code?: string; details?: { code?: string; definitionId?: string; responsibleUserId?: string } };
    try { body = await response.json(); } catch { throw new Error("Personal-secret setup response could not be verified; contents withheld"); }
    if (!body || typeof body !== "object" || response.status !== 422 || body.code !== "user_secret_missing" || body.details?.code !== "user_secret_missing" || body.details.definitionId !== state.definitionId || body.details.responsibleUserId !== state.currentPersonId) throw new Error("Personal-secret setup did not prove the exact current-person missing binding");
  } finally { if (!response.bodyUsed) await response.body?.cancel(); }
  remainingIdentityObservationBudget(ctx);
  state.currentOwnerMissingBindingVerified = true;
  await ctx.input.evidence("personal-secret-missing-binding-prerequisite.json", { agentId: agent.id, definitionId: state.definitionId, responsibleUserId: state.currentPersonId, status: 422, code: "user_secret_missing", unchangedWorkerConfiguration: true, controllerReady: true, prospectiveResolutionOnly: true });
}

export function personalSecretGuidance(reply: string) {
  return (
    /personal|your own|my secrets/i.test(reply) &&
    /publishing|publish/i.test(reply) &&
    /secure|settings|set (?:my|your) value/i.test(reply) &&
    !solicitsChatCredential(reply) &&
    !reply
      .split(/[.!?;\n]+|\bbut\b/i)
      .some(
        (clause) =>
          !/\b(?:not|cannot|can't|won't|never|do not|don't|before|once|after|until)\b/i.test(
            clause,
          ) &&
          (/\b(?:I|we)(?:['’]ve| have)?\s+(?:already\s+)?(?:set|saved|configured|connected|completed|reused)\b/i.test(
            clause,
          ) ||
            /\b(?:credential|value|key|setup)\s+(?:is|has been)\s+(?:already\s+|now\s+)?(?:ready|available|configured|saved|complete|set up)\b/i.test(
              clause,
            ) ||
            /\b(?:use|reuse|borrow)\b[^.!?\n]{0,70}\b(?:Riley|another person|someone else)/i.test(
              clause,
            )),
      )
  );
}
export function personalSecretConfirmation(reply: string) {
  return (
    !solicitsChatCredential(reply) &&
    reply
      .split(/[.!?;\n]+|\bbut\b/i)
      .some(
        (clause) =>
          /personal|publishing/i.test(clause) &&
          /configured|available|saved|ready|set up|succeeded|success|checked|200/i.test(
            clause,
          ) &&
          !/\b(?:not|cannot|can't|unavailable|missing|before|once|after|until|will|would|pending)\b/i.test(
            clause,
          ),
      )
  );
}
export function gradePersonalSecret(value: unknown) {
  const c = checks(),
    o = externalObservation(value);
  c.add(
    "real-personal-value-delivery",
    !!o,
    "A required definition, real separate owners, secure UI entry and independently authenticated admitted worker check are required.",
  );
  if (!o) return c.result();
  const initial = o.phaseReplies.find(
      (row) => row.runId === o.state.initialRunId,
    ),
    last = o.phaseReplies
      .filter((row) => row.runId !== o.state.initialRunId)
      .at(-1);
  c.add(
    "missing-own-required-credential-and-truthful-handoff",
    o.state.currentMissingBefore === true &&
      o.state.requiredReferenceBefore === true &&
      o.state.otherConfiguredBefore === true &&
      o.state.currentPersonId !== o.state.otherPersonId &&
      !!initial &&
      personalSecretGuidance(initial.body) &&
      o.state.agentValueCreateStatus === 403,
    "Another person's real stored value does not satisfy the current person's required publishing definition, and chat directs secure own-value entry before claiming completion.",
  );
  const secret = o.state.currentSecret as Partial<CompanySecret> | undefined;
  c.add(
    "actual-own-definition-and-private-ui",
    o.state.operatorChannel === "private-browser-personal-set-my-value" &&
      o.state.secureBrowserUntraced === true &&
      o.state.secretUiVisible === true &&
      o.state.humanSubmittedSecurely === true &&
      o.state.storageClean === true &&
      secret?.id === o.state.secretId &&
      secret?.companyId === o.companyId &&
      secret?.scope === "user" &&
      secret?.ownerUserId === o.state.currentPersonId &&
      secret?.userSecretDefinitionId === o.state.definitionId &&
      secret?.status === "active" &&
      o.activity.some(
        (row) =>
          row.entityId === secret.id &&
          row.action === "user_secret_value.created" &&
          row.actorType === "user" &&
          row.actorId === o.state.currentPersonId,
      ),
    "The current signed-in person uses the real definition-scoped Set my value form; the saved value and mutation actor independently agree.",
  );
  c.add(
    "admitted-task-receives-only-current-person-value",
    o.state.requiredReferenceAfter === true &&
      o.state.taskResponsibleUserId === o.state.currentPersonId &&
      o.state.taskAfterStatus === "done" &&
      o.state.workerReceiptBound === true &&
      o.runs.some(
        (run) =>
          run.id === o.state.workerRunId &&
          run.agentId === o.state.morganId &&
          run.runtimeMode === "native" &&
          run.status === "succeeded" &&
          run.contextSnapshot?.issueId === o.state.taskId,
      ) &&
      o.state.authorizedChecks === 1 &&
      o.state.unauthorizedChecks === 0 &&
      o.state.checkRunId === o.state.workerRunId &&
      o.state.checkAgentId === o.state.morganId,
    "Only a genuine native run for the person's task authenticates the controlled endpoint with their value; the alternate person's value cannot authenticate it.",
  );
  c.add(
    "other-owner-custody-preserved",
    o.state.otherMutationStatus === 404 &&
      o.state.otherUnchanged === true &&
      o.state.otherValueHiddenFromOwnList === true,
    "The current person cannot mutate the other person's personal secret through their owner route; that value remains unchanged and absent from the current-person list.",
  );
  c.add(
    "post-entry-confirmation-is-separate-and-sanitized",
    !!last &&
      o.runs.some(
        (run) => run.id === last.runId && run.status === "succeeded",
      ) &&
      personalSecretConfirmation(last.body) &&
      o.state.secretScanComplete === true &&
      o.state.secretLeaked === false,
    "A later actual model response confirms availability after secure entry and observed delivery, with private scans of both owners' values across task/source output and run events.",
  );
  return c.result();
}
export const personalSecretExternalCases = [
  definition(
    "secrets.personal-secret",
    async (ctx) => {
      const browser = ctx.input.page.context().browser(),
        secrets = ctx.input.privateSecrets;
      if (!browser || !secrets)
        throw new Error(
          "Personal credential requires real human sessions and private redaction",
        );
      const session = await ctx.input.api.get<{ user: { id: string } }>(
        "/api/auth/get-session",
      );
      if (!session.user?.id || session.user.id === "local-board")
        throw new Error("Personal credential needs the actual current human");
      const value = `owned-publishing-${randomBytes(32).toString("hex")}`,
        otherValue = `other-publishing-${randomBytes(32).toString("hex")}`;
      secrets.push(value, otherValue);
      const other = await createAuthenticatedPerson({
        api: ctx.input.api,
        browser,
        secrets,
        name: "Riley",
      });
      let endpoint: PrivateFixture["endpoint"] | undefined;
      try {
        await enrollPrerequisitePerson(ctx, other);
        const definition = await ctx.input.api.post<UserSecretDefinition>(
          `${root(ctx)}/user-secret-definitions`,
          {
            key: "PERSONAL_PUBLISHING_KEY",
            name: "Personal publishing credential",
            provider: "local_encrypted",
            usageGuidance:
              "Required for the responsible person's publishing task. Each person supplies their own value in secure My secrets settings.",
          },
        );
        const otherResponse = await other.request(
          `${root(ctx)}/me/user-secrets`,
          "POST",
          { definitionId: definition.id, value: otherValue },
        );
        if (otherResponse.status !== 201) {
          await otherResponse.body?.cancel();
          throw new Error(
            "Other person's real private value prerequisite failed; response withheld",
          );
        }
        const otherSecret = (await otherResponse.json()) as CompanySecret;
        const own = (
          await ctx.input.api.get<OwnEntry[]>(`${root(ctx)}/me/user-secrets`)
        ).find((row) => row.definition.id === definition.id);
        if (!own || own.secret)
          throw new Error(
            "Personal publishing definition must initially lack the current person's value",
          );
        const morgan = await identityWorker(ctx),
          agent = await preparePersonalSecretWorker(ctx, morgan.id);
        await ctx.input.api.patch(`/api/agents/${morgan.id}`, {
          adapterConfig: {
            ...agent.adapterConfig,
            env: {
              ...(agent.adapterConfig.env as Record<string, unknown>),
              PUBLISHING_API_KEY: {
                type: "user_secret_ref",
                key: definition.key,
                version: "latest",
                required: true,
                allowMissingOverride: false,
              },
            },
          },
        });
        endpoint = await secretTestEndpoint(
          ctx,
          morgan.id,
          value,
          "PUBLISHING_API_KEY",
        );
        fixtures.set(ctx, { value, otherValue, other, endpoint });
        const task = await ctx.input.api.post<
          Entity & { responsibleUserId: string }
        >(`${root(ctx)}/issues`, {
          title: "Personal publishing check",
          status: "backlog",
          assigneeAgentId: morgan.id,
          description: `Check the controlled publishing endpoint ${endpoint.url} using your authorized PUBLISHING_API_KEY runtime delivery. The helper node ${JSON.stringify(endpoint.scriptPath)} performs that one authenticated check without printing the credential. Report only the sanitized result in this task and finish. A required personal value must be set by the responsible person before this task starts.`,
        });
        if (task.responsibleUserId !== session.user.id)
          throw new Error(
            "Publishing task responsible identity must be the current human",
          );
        const chat = await openStandingChat(ctx);
        await ctx.input.api.patch(`/api/issues/${chat.id}`, {
          description: `This request concerns publishing task ${task.identifier ?? task.id}, assigned to Morgan. It is in backlog because the current responsible person has not set the required Personal publishing credential definition ${definition.id} (PERSONAL_PUBLISHING_KEY). Morgan's required PUBLISHING_API_KEY user-secret reference is already configured. Riley is another company member with their own separate personal value.`,
        });
        return {
          sourceIssueId: chat.id,
          morganReadyBeforeRequiredBinding: true,
          morganUnboundConfigHash: personalSecretUnboundConfigHash(agent.adapterConfig),
          definitionId: definition.id,
          currentPersonId: session.user.id,
          otherPersonId: other.id,
          otherSecretId: otherSecret.id,
          otherBefore: otherSecret,
          currentMissingBefore: true,
          otherConfiguredBefore:
            otherSecret.ownerUserId === other.id &&
            otherSecret.userSecretDefinitionId === definition.id,
          requiredReferenceBefore: true,
          morganId: morgan.id,
          taskId: task.id,
          taskResponsibleUserId: task.responsibleUserId,
          agentValueCreateStatus: await probeAgentPermission(
            ctx,
            `${root(ctx)}/me/user-secrets`,
            "POST",
            { definitionId: definition.id, value },
          ),
        };
      } catch (error) {
        fixtures.delete(ctx);
        await endpoint?.close();
        await other.dispose();
        throw error;
      }
    },
    gradePersonalSecret,
    {
      authentication: "human-session",
      oracleVersion: "paperclip.chat-catalog.personal-secret.v2",
      setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["current-owner-missing-required-personal-value"] },
      expectedRunCount: 3,
      minimumRunCount: 3,
      expectedHumanMessageCount: 2,
      attemptTimeoutMs: 660000,
      sourceFiles: [
        "chat-catalog-domains/external-personal-secret.ts",
        "chat-catalog-domains/external-secret-endpoint.ts",
        "chat-catalog-domains/external-private-browser.ts",
        "chat-catalog-domains/external-private-browser-worker.ts",
        "chat-catalog-domains/external-credential-language.ts",
        "chat-catalog-domains/external-secret-scan.ts",
        "chat-catalog-domains/identity-auth.ts",
        "chat-catalog-domains/identity-private-browser.ts",
        "chat-catalog-domains/identity-private-browser-worker.ts",
        "chat-catalog-domains/identity-wizard.ts",
        "chat-catalog-domains/identity-support.ts",
        "chat-catalog-domains/external-support.ts",
        "chat-catalog-domains/internal-support.ts",
        "run-observations.ts",
        "chat-flow.ts",
        "../../server/src/home-paths.ts",
        "../e2e/fetch-allowed-port.ts",
        "../../server/src/routes/secrets.ts",
        "../../server/src/services/secrets.ts",
        "../../server/src/services/heartbeat/run-preparation.ts",
        "../../ui/src/pages/secrets/SetMyUserSecretDialog.tsx",
        "chat-scenarios/secrets.yaml",
      ],
      async verifySetup(ctx, state) {
        const fixture = fixtures.get(ctx)!,
          session = await ctx.input.api.get<{ user: { id: string } }>(
            "/api/auth/get-session",
          ),
          agent = await ctx.input.api.get<PersonalSetupAgent>(`/api/agents/${state.morganId}`),
          ref = agent.adapterConfig.env?.PUBLISHING_API_KEY as
            | {
                type?: string;
                key?: string;
                required?: boolean;
                allowMissingOverride?: boolean;
              }
            | undefined;
        await provePersonalSecretMissingBoundary(ctx, state, agent);
        state.requiredReferenceBefore =
          ref?.type === "user_secret_ref" &&
          ref.key === "PERSONAL_PUBLISHING_KEY" &&
          ref.required === true &&
          ref.allowMissingOverride === false;
        state.currentMissingBefore = (
          await ctx.input.api.get<OwnEntry[]>(`${root(ctx)}/me/user-secrets`)
        ).some(
          (row) => row.definition.id === state.definitionId && !row.secret,
        );
        const otherResponse = await fixture.other.request(
          `${root(ctx)}/me/user-secrets`,
        );
        if (!otherResponse.ok) {
          await otherResponse.body?.cancel();
          throw new Error(
            "Other person's own-value prerequisite cannot be verified",
          );
        }
        const rows = (await otherResponse.json()) as OwnEntry[];
        state.otherConfiguredBefore = rows.some(
          (row) =>
            row.definition.id === state.definitionId &&
            row.secret?.id === state.otherSecretId &&
            row.secret?.ownerUserId === state.otherPersonId &&
            row.secret?.status === "active",
        );
        const task = await ctx.input.api.get<
            Entity & { responsibleUserId: string }
          >(`/api/issues/${state.taskId}`),
          passed =
            session.user.id === state.currentPersonId &&
            state.currentMissingBefore === true &&
            state.requiredReferenceBefore === true &&
            state.otherConfiguredBefore === true &&
            task.status === "backlog" &&
            task.assigneeAgentId === state.morganId &&
            task.responsibleUserId === state.currentPersonId &&
            (await ctx.allRuns()).length === 0;
        return {
          passed,
          checks: [
            {
              id: "current-owner-missing-required-personal-value",
              passed,
              detail:
                "Actual owner lists, authenticated identity, saved required user-secret reference and current-person backlog task are independently verified without dispatching work.",
            },
          ],
        };
      },
      async act(ctx, state) {
        const remaining = () => remainingIdentityObservationBudget(ctx);
        remaining();
        await waitForReply(ctx, ctx.observationDeadlineAt);
        remaining();
        const source = ctx.issue();
        if (!source || source.id !== state.sourceIssueId || source.companyId !== ctx.input.fixtures.company.id)
          throw new Error("Personal-secret initial response has the wrong conversation source");
        const [runs, comments] = await Promise.all([
          ctx.allRuns(),
          ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`, { timeout: remaining() }),
        ]);
        remaining();
        const canonical = comments.filter(comment => comment.companyId === source.companyId && comment.issueId === source.id
          && comment.authorUserId === state.currentPersonId && !comment.authorAgentId && !comment.createdByRunId
          && comment.body?.trim() === ctx.scenario.query.trim());
        const run = runs[0];
        if (ctx.issue()?.id !== source.id || source.conversationState !== "waiting" || runs.length !== 1 || !run
          || run.runtimeMode !== "native" || run.companyId !== source.companyId || run.agentId !== ctx.input.fixtures.agent.id
          || run.status !== "succeeded" || run.contextSnapshot?.issueId !== source.id || canonical.length !== 1
          || (run.contextSnapshot.taskId !== undefined && run.contextSnapshot.taskId !== source.id)
          || (run.nativeIssueId != null && run.nativeIssueId !== source.id)
          || run.contextSnapshot?.commentId !== canonical[0]?.id)
          throw new Error("Personal-secret initial response is not bound to its current person's canonical native request");
        const fixture = fixtures.get(ctx)!,
          initial = await observeExternal(ctx, state),
          reply = initial.phaseReplies.at(-1);
        remaining();
        if (initial.companyId !== source.companyId || !reply || reply.runId !== run.id
          || !comments.some(comment => comment.id === reply.commentId && comment.companyId === source.companyId
            && comment.issueId === source.id && comment.authorAgentId === run.agentId && comment.createdByRunId === run.id
            && comment.body?.trim() === reply.body.trim()) || !personalSecretGuidance(reply.body))
          throw new Error(
            "Personal setup must direct the current person's secure publishing value before human action",
          );
        state.initialRunId = reply.runId;
        if (
          (
            await ctx.input.api.get<OwnEntry[]>(`${root(ctx)}/me/user-secrets`)
          ).find((row) => row.definition.id === state.definitionId)?.secret
        )
          throw new Error(
            "Current person's value was created before secure human entry",
          );
        const path = `/${ctx.input.fixtures.company.issuePrefix}/company/settings/secrets`,
          link = initial.links.find((href) => {
            try {
              const url = new URL(href, initial.origin);
              return (
                url.origin === initial.origin &&
                url.pathname === path &&
                (!url.searchParams.has("definition") ||
                  url.searchParams.get("definition") === state.definitionId)
              );
            } catch {
              return false;
            }
          });
        if (!link)
          throw new Error(
            "Actual reply must direct the supported own-value settings path for this definition",
          );
        const url = new URL(link, initial.origin);
        url.searchParams.set("definition", String(state.definitionId));
        const receipt = await privateBrowserEntry({
          mode: "personal-secret-create",
          companyId: ctx.input.fixtures.company.id,
          personal: {
            definitionId: String(state.definitionId),
            userId: String(state.currentPersonId),
          },
          baseURL: initial.origin,
          setupURL: url.href,
          providerURL: "",
          credential: fixture.value,
          cookies: await ctx.input.page.context().cookies(initial.origin),
        });
        Object.assign(state, receipt, {
          operatorChannel: "private-browser-personal-set-my-value",
          secureBrowserUntraced:
            receipt.processIsolation &&
            receipt.testRunnerAttached === false &&
            receipt.apiStepRecorder === false &&
            receipt.tracingEnabled === false &&
            receipt.videoEnabled === false,
        });
        const denied = await fetch(
          new URL(
            `${root(ctx)}/me/user-secrets/${state.otherSecretId}`,
            initial.origin,
          ),
          {
            method: "PATCH",
            redirect: "error",
            signal: AbortSignal.timeout(15000),
            headers: {
              Origin: initial.origin,
              "content-type": "application/json",
              Cookie: (await ctx.input.page.context().cookies(initial.origin))
                .map((row) => `${row.name}=${row.value}`)
                .join("; "),
            },
            body: JSON.stringify({ status: "archived" }),
          },
        );
        state.otherMutationStatus = denied.status;
        await denied.body?.cancel();
        await ctx.input.api.patch(`/api/issues/${state.taskId}`, {
          status: "todo",
        });
        const result = await pollUntil({
          label:
            "current-person publishing credential actually delivered to Morgan",
          deadlineAt: Date.now() + 150000,
          intervalMs: 1000,
          load: async () => ({
            task: await ctx.input.api.get<Entity>(
              `/api/issues/${state.taskId}`,
            ),
            runs: (await ctx.allRuns()).filter(
              (run) => run.contextSnapshot?.issueId === state.taskId,
            ),
          }),
          accept: (v) =>
            v.runs.length === 1 &&
            v.runs[0]?.status === "succeeded" &&
            v.task.status === "done" &&
            fixture.endpoint.calls.some(
              (call) =>
                call.authorized &&
                call.runId === v.runs[0]?.id &&
                call.agentId === state.morganId,
            ),
          reject: (v) =>
            v.runs.length > 1 ||
            v.runs.some((run) =>
              ["failed", "cancelled", "timed_out"].includes(run.status),
            )
              ? "Personal publishing worker did not complete one actual credential check"
              : undefined,
        });
        state.workerRunId = result.runs[0]!.id;
        await sendChatMessage(ctx.input.page, ctx.scenario.query);
      },
      async observe(ctx, state) {
        const fixture = fixtures.get(ctx)!;
        const own = await ctx.input.api.get<OwnEntry[]>(
          `${root(ctx)}/me/user-secrets`,
        );
        state.currentSecret = own.find(
          (row) => row.definition.id === state.definitionId,
        )?.secret;
        state.otherValueHiddenFromOwnList = !own.some(
          (row) =>
            row.secret?.id === state.otherSecretId ||
            row.secret?.ownerUserId === state.otherPersonId,
        );
        const agent = await ctx.input.api.get<{
            adapterConfig: { env?: Record<string, unknown> };
          }>(`/api/agents/${state.morganId}`),
          ref = agent.adapterConfig.env?.PUBLISHING_API_KEY as
            | {
                type?: string;
                key?: string;
                required?: boolean;
                allowMissingOverride?: boolean;
              }
            | undefined;
        state.requiredReferenceAfter =
          ref?.type === "user_secret_ref" &&
          ref.key === "PERSONAL_PUBLISHING_KEY" &&
          ref.required === true &&
          ref.allowMissingOverride === false;
        const otherResponse = await fixture.other.request(
          `${root(ctx)}/me/user-secrets`,
        );
        if (!otherResponse.ok) {
          await otherResponse.body?.cancel();
          throw new Error(
            "Other-owner custody verification failed; body withheld",
          );
        }
        const other = ((await otherResponse.json()) as OwnEntry[]).find(
          (row) => row.definition.id === state.definitionId,
        )?.secret;
        state.otherUnchanged = sameSecretIdentity(
          state.otherBefore as CompanySecret,
          other ?? undefined,
        );
        const task = await ctx.input.api.get<
          Entity & { responsibleUserId: string }
        >(`/api/issues/${state.taskId}`);
        state.taskResponsibleUserId = task.responsibleUserId;
        state.taskAfterStatus = task.status;
        const comments = await ctx.input.api.get<Entity[]>(
          `/api/issues/${state.taskId}/comments?order=asc`,
        );
        state.workerReceiptBound = comments.some(
          (row) =>
            row.createdByRunId === state.workerRunId &&
            row.authorAgentId === state.morganId &&
            /success|succeed|200|ok/i.test(row.body ?? ""),
        );
        const checks = fixture.endpoint.calls.filter((call) => call.authorized);
        state.authorizedChecks = checks.length;
        state.unauthorizedChecks =
          fixture.endpoint.calls.length - checks.length;
        state.checkRunId = checks[0]?.runId;
        state.checkAgentId = checks[0]?.agentId;
        const o = await observeExternal(ctx, state),
          ids = new Set([ctx.issue()!.id, String(state.taskId)]);
        for (;;) {
          const size = ids.size;
          for (const task of o.tasks)
            if (task.parentId && ids.has(task.parentId)) ids.add(task.id);
          if (size === ids.size) break;
        }
        const events = [];
        for (const run of o.runs)
          events.push(
            ...(await collectRunEvents((afterSeq) =>
              privateScanJson(
                ctx,
                `/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`,
              ),
            )),
          );
        state.secretScanComplete = true;
        state.secretLeaked = false;
        for (const secret of [fixture.value, fixture.otherValue]) {
          const scan = await scanReachableSecretOutputs(ctx, [...ids], secret);
          state.secretScanComplete =
            state.secretScanComplete === true && scan.complete;
          state.secretLeaked =
            state.secretLeaked === true ||
            scan.leaked ||
            bytesContainSecret(
              Buffer.from(JSON.stringify([events, o.runs])),
              secret,
            );
        }
        return { ...o, state };
      },
      async verifyResult(ctx, state, value) {
        await verifyRenderedReply(ctx, value, String(state.initialRunId));
        const source = ctx.input.page.url();
        try {
          await ctx.input.page.goto(
            `/${ctx.input.fixtures.company.issuePrefix}/company/settings/secrets?definition=${state.definitionId}`,
            { waitUntil: "domcontentloaded" },
          );
          await expect(
            ctx.input.page.getByRole("button", {
              name: "Update my value",
              exact: true,
            }),
          ).toBeVisible();
        } finally {
          await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
        }
      },
      async cleanup(ctx, state) {
        const fixture = fixtures.get(ctx);
        fixtures.delete(ctx);
        try {
          if (typeof state.morganId === "string") {
            const agent = await ctx.input.api.get<{
                adapterConfig: Record<string, unknown>;
              }>(`/api/agents/${state.morganId}`),
              env = { ...(agent.adapterConfig.env as Record<string, unknown>) };
            delete env.PUBLISHING_API_KEY;
            await ctx.input.api.patch(`/api/agents/${state.morganId}`, {
              adapterConfig: { ...agent.adapterConfig, env },
            });
          }
          if (typeof state.secretId === "string")
            await ctx.input.api.delete(
              `${root(ctx)}/me/user-secrets/${state.secretId}`,
              { allowNotFound: true },
            );
          if (fixture && typeof state.otherSecretId === "string") {
            const response = await fixture.other.request(
              `${root(ctx)}/me/user-secrets/${state.otherSecretId}`,
              "DELETE",
            );
            await response.body?.cancel();
          }
          if (typeof state.definitionId === "string")
            await ctx.input.api.delete(
              `${root(ctx)}/user-secret-definitions/${state.definitionId}`,
              { allowNotFound: true },
            );
        } finally {
          await fixture?.endpoint.close();
          await fixture?.other.dispose();
        }
      },
    },
  ),
];
