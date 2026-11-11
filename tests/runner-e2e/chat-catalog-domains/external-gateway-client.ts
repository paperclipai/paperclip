import { randomBytes } from "node:crypto";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type {
  ToolProfileWithDetails,
  ToolProfileEffectiveSummary,
  ToolRunDecisionLookup,
} from "../../../packages/shared/src/types/tool-access.js";
import { pollUntil } from "../api.js";
import {
  definition,
  externalObservation,
  observeExternal,
  root,
  checks,
  verifyRenderedReply,
} from "./external-support.js";
import {
  connectNotes,
  startNotesProvider,
  type NotesProvider,
} from "./external-provider.js";

interface PrivateFixture {
  provider: NotesProvider;
  key?: { id: string; token: string };
  session?: { sessionId: string; token: string };
}
const fixtures = new WeakMap<ChatCatalogContext, PrivateFixture>();
async function privateRequest(
  ctx: ChatCatalogContext,
  pathname: string,
  token: string,
  body?: unknown,
  session = false,
) {
  const url = new URL(pathname, ctx.input.api.baseURL);
  if (
    url.origin !== ctx.input.api.baseURL ||
    !url.pathname.startsWith("/api/tool-gateway/")
  )
    throw new Error("Scoped session probe escaped its fixture API");
  return fetch(url, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      ...(session
        ? { "x-paperclip-tool-gateway-token": token }
        : { Authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
/** Failure diagnostics are closed control-plane facts, never arbitrary upstream
 * error text. Unknown/secret-bearing fields are deliberately omitted. */
export function scopedSessionFailureDiagnostic(
  status: number,
  context: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId: string;
    observedRunStatusAtAdmission: string;
  },
  response: unknown,
) {
  const allowed = [
    "run_company_mismatch",
    "run_agent_mismatch",
    "run_inactive",
    "run_context_mismatch",
  ];
  const reason =
    response && typeof response === "object"
      ? (response as { reasonCode?: unknown }).reasonCode
      : undefined;
  return {
    httpStatus: status,
    companyId: context.companyId,
    agentId: context.agentId,
    runId: context.runId,
    issueId: context.issueId,
    observedRunStatusAtAdmission: context.observedRunStatusAtAdmission,
    reasonCode:
      typeof reason === "string" && allowed.includes(reason)
        ? reason
        : "unclassified",
    responseBodyRetained: false,
  };
}
export function gradeGatewayClient(value: unknown) {
  const c = checks(),
    o = externalObservation(value);
  c.add(
    "complete-scoped-client-evidence",
    !!o,
    "Actual assigned profile, run/task admission, independent discovery/denial and provider-read receipts are required.",
  );
  if (!o) return c.result();
  const effective = o.state.effective as
    ToolProfileEffectiveSummary | undefined;
  c.add(
    "intended-effective-profile",
    effective?.agentId === o.leadId &&
      effective.profiles.some((row) => row.id === o.state.profileId) &&
      effective.allowedTools.some((row) => row.id === o.state.readEntryId) &&
      !effective.allowedTools.some((row) => row.id === o.state.writeEntryId),
    "The saved launch profile grants its read action to this agent while excluding the write action.",
  );
  c.add(
    "actual-active-run-scoped-session",
    o.state.sessionCreated === true &&
      o.runs.some(
        (run) =>
          run.id === o.state.probeRunId &&
          run.agentId === o.leadId &&
          run.companyId === o.companyId,
      ) &&
      o.state.discoveredRead === true &&
      o.state.discoveredWrite === false,
    "A real agent bearer creates a session for the admitted source run/task and discovers only authorized actions.",
  );
  const decisions = o.state.decisions as ToolRunDecisionLookup[] | undefined;
  c.add(
    "model-performed-bounded-read",
    !!decisions &&
      decisions.some((row) =>
        row.decisions.some(
          (decision) =>
            decision.invocation.runId === row.runId &&
            decision.invocation.agentId === o.leadId &&
            decision.invocation.issueId === o.state.sourceIssueId &&
            decision.invocation.connectionId === o.state.connectionId &&
            decision.invocation.catalogEntryId === o.state.readEntryId &&
            decision.invocation.status === "succeeded",
        ),
      ) &&
      Number(o.state.providerReadCalls) >= 1 &&
      Number(o.state.providerReadCalls) <= 3 &&
      typeof o.state.marker === "string" &&
      o.reply.includes(o.state.marker),
    "The actual model run uses the real provider read and reports its unpredictable result; the oracle never performs that read.",
  );
  c.add(
    "disallowed-write-denied",
    o.state.writeProbeStatus === 403 &&
      ["deny_default", "deny_policy_block"].includes(
        String(o.state.writeProbeReason),
      ) &&
      o.state.providerWriteCalls === 0 &&
      o.state.written === null,
    "A real scoped-session write attempt is denied before provider execution.",
  );
  c.add(
    "no-private-token-disclosure",
    o.state.tokenScanComplete === true && o.state.privateTokenLeaked === false,
    "Scoped session and probe credentials never enter the persisted reply/run result.",
  );
  return c.result();
}
export const gatewayClientExternalCases = [
  definition(
    "gateways-profiles.connect-client",
    async (ctx) => {
      const marker = `Launch fixture result ${randomBytes(16).toString("hex")}`;
      const provider = await startNotesProvider(marker);
      const fixture: PrivateFixture = { provider };
      fixtures.set(ctx, fixture);
      try {
        const connection = await connectNotes(ctx, provider, "read-only");
        const profile = await ctx.input.api.post<ToolProfileWithDetails>(
          `${root(ctx)}/tools/profiles`,
          {
            profileKey: "launch",
            name: "Launch profile",
            defaultAction: "deny",
            entries: [
              {
                selectorType: "catalog_entry",
                effect: "include",
                connectionId: connection.connectionId,
                catalogEntryId: connection.read[0],
              },
              {
                selectorType: "catalog_entry",
                effect: "exclude",
                connectionId: connection.connectionId,
                catalogEntryId: connection.write[0],
              },
            ],
          },
        );
        await ctx.input.api.post(
          `${root(ctx)}/tools/profiles/${profile.id}/bind`,
          { targetType: "agent", targetId: ctx.input.fixtures.agent.id },
        );
        const access = await ctx.input.api.get<{
          access: {
            tools: Array<{ toolName: string; gatewayToolName: string }>;
          };
        }>(
          `/api/tool-connections/${connection.connectionId}/test-agents/${ctx.input.fixtures.agent.id}/access`,
        );
        const write = access.access.tools.find(
          (row) => row.toolName === "launch_update",
        );
        if (!write)
          throw new Error(
            "The excluded write action has no independently discoverable catalog identity",
          );
        return {
          connectionId: connection.connectionId,
          profileId: profile.id,
          readEntryId: connection.read[0],
          writeEntryId: connection.write[0],
          writeGatewayName: write.gatewayToolName,
          marker,
        };
      } catch (error) {
        fixtures.delete(ctx);
        await provider.close();
        throw error;
      }
    },
    gradeGatewayClient,
    {
      sourceFiles: [
        "chat-catalog-domains/external-gateway-client.ts",
        "chat-catalog-domains/external-provider.ts",
        "chat-catalog-domains/external-support.ts",
        "chat-catalog-domains/internal-support.ts",
        "chat-scenarios/gateways-profiles.yaml",
      ],
      async act(ctx, state) {
        const fixture = fixtures.get(ctx)!;
        const active = await pollUntil({
          label: "admitted source run for independent scoped denial probe",
          deadlineAt: Date.now() + 60_000,
          intervalMs: 100,
          load: async () => {
            await ctx.refreshIssue();
            return ctx.allRuns();
          },
          accept: (rows) =>
            rows.some(
              (row) =>
                row.agentId === ctx.input.fixtures.agent.id &&
                row.status === "running",
            ),
          reject: (rows) =>
            rows.length &&
            rows.every((row) =>
              ["succeeded", "failed", "cancelled", "timed_out"].includes(
                row.status,
              ),
            )
              ? "Source run settled before scoped-session probe admission"
              : undefined,
        });
        const run = active.find(
          (row) =>
            row.agentId === ctx.input.fixtures.agent.id &&
            row.status === "running",
        )!;
        const source = ctx.issue();
        if (!source || !ctx.input.privateSecrets)
          throw new Error(
            "Scoped client requires source identity and private redaction",
          );
        state.probeRunId = run.id;
        state.sourceIssueId = source.id;
        const key = await ctx.input.api.postSensitive<{
          id: string;
          token: string;
        }>(`/api/agents/${ctx.input.fixtures.agent.id}/keys`, {
          name: `scoped-client-probe-${ctx.input.nonce}`,
        });
        fixture.key = key;
        ctx.input.privateSecrets.push(key.token);
        const admitted = await privateRequest(
          ctx,
          "/api/tool-gateway/sessions",
          key.token,
          {
            companyId: ctx.input.fixtures.company.id,
            agentId: ctx.input.fixtures.agent.id,
            runId: run.id,
            issueId: source.id,
          },
        );
        if (admitted.status !== 201) {
          // Parse only in private memory and retain only the exact finite classifier.
          // In particular, never serialize arbitrary body/error/token fields.
          const response = (await admitted
            .json()
            .catch(() => undefined)) as unknown;
          const diagnostic = scopedSessionFailureDiagnostic(
            admitted.status,
            {
              companyId: ctx.input.fixtures.company.id,
              agentId: ctx.input.fixtures.agent.id,
              runId: run.id,
              issueId: source.id,
              observedRunStatusAtAdmission: run.status,
            },
            response,
          );
          await ctx.input.evidence(
            "chat-catalog-scoped-session-admission-failure.json",
            diagnostic,
          );
          throw new Error(
            `Active-run scoped session admission failed (HTTP ${diagnostic.httpStatus}; ${diagnostic.reasonCode}); response withheld`,
          );
        }
        fixture.session = (await admitted.json()) as {
          sessionId: string;
          token: string;
        };
        ctx.input.privateSecrets.push(fixture.session.token);
        state.sessionCreated = true;
        const listed = await privateRequest(
          ctx,
          "/api/tool-gateway/tools",
          fixture.session.token,
          undefined,
          true,
        );
        if (!listed.ok) {
          await listed.body?.cancel();
          throw new Error("Scoped tool discovery failed; response withheld");
        }
        const tools = (await listed.json()) as Array<{
          catalogEntryId?: string;
        }>;
        state.discoveredRead = tools.some(
          (row) => row.catalogEntryId === state.readEntryId,
        );
        state.discoveredWrite = tools.some(
          (row) => row.catalogEntryId === state.writeEntryId,
        );
        const denied = await privateRequest(
          ctx,
          "/api/tool-gateway/tools/call",
          fixture.session.token,
          {
            tool: state.writeGatewayName,
            parameters: { text: "This oracle write must be denied" },
          },
          true,
        );
        state.writeProbeStatus = denied.status;
        // Retain only the allowlisted policy code, never an arbitrary error body.
        const denial = (await denied.json()) as { reasonCode?: unknown };
        state.writeProbeReason = ["deny_default", "deny_policy_block"].includes(
          String(denial.reasonCode),
        )
          ? denial.reasonCode
          : "other";
      },
      async observe(ctx, state) {
        const fixture = fixtures.get(ctx);
        if (!fixture) throw new Error("Scoped synthetic fixture missing");
        state.effective = await ctx.input.api.get<ToolProfileEffectiveSummary>(
          `${root(ctx)}/tools/profiles/effective/agents/${ctx.input.fixtures.agent.id}`,
        );
        state.decisions = await Promise.all(
          (await ctx.allRuns()).map((run) =>
            ctx.input.api.get<ToolRunDecisionLookup>(
              `${root(ctx)}/tools/runs/${run.id}/decisions`,
            ),
          ),
        );
        state.providerReadCalls = fixture.provider.calls.filter(
          (row) =>
            row.method === "tools/call" &&
            row.name === "launch_read" &&
            row.authorized,
        ).length;
        state.providerWriteCalls = fixture.provider.calls.filter(
          (row) => row.method === "tools/call" && row.name === "launch_update",
        ).length;
        state.written = fixture.provider.written() ?? null;
        const o = await observeExternal(ctx, state);
        const tokens = [fixture.key?.token, fixture.session?.token].filter(
          (token): token is string => typeof token === "string",
        );
        state.tokenScanComplete = tokens.length === 2;
        state.privateTokenLeaked = tokens.some((token) =>
          JSON.stringify([o.reply, o.runs]).includes(token),
        );
        return { ...o, state };
      },
      async verifyResult(ctx, _state, value) {
        await verifyRenderedReply(ctx, value);
      },
      async cleanup(ctx, state) {
        const fixture = fixtures.get(ctx);
        fixtures.delete(ctx);
        try {
          if (fixture?.session && fixture.key) {
            const response = await privateRequest(
              ctx,
              `/api/tool-gateway/sessions/${fixture.session.sessionId}/revoke`,
              fixture.key.token,
              { companyId: ctx.input.fixtures.company.id },
            );
            if (!response.ok && response.status !== 404)
              throw new Error("Scoped fixture session revocation failed");
            await response.body?.cancel();
          }
          if (fixture?.key)
            await ctx.input.api.delete(
              `/api/agents/${ctx.input.fixtures.agent.id}/keys/${fixture.key.id}`,
              { allowNotFound: true },
            );
          if (typeof state.profileId === "string")
            await ctx.input.api.post(
              `${root(ctx)}/tools/profiles/${state.profileId}/unbind`,
              { targetType: "agent", targetId: ctx.input.fixtures.agent.id },
            );
          if (typeof state.connectionId === "string")
            await ctx.input.api.delete(
              `/api/tool-connections/${state.connectionId}`,
              { allowNotFound: true },
            );
        } finally {
          await fixture?.provider.close();
        }
      },
    },
  ),
];
