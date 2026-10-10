import { and, eq } from "drizzle-orm";
import {
  toolGovnaAuthorityOperations,
  type Db,
} from "@paperclipai/db";
import type { ToolUpstreamPending } from "@paperclipai/shared";
import {
  authorityImmutableBinding,
  authorityRequestHash,
  govnaAuthorityOperationService,
  type GovnaApprovalAuthorityConfig,
} from "./govna-approval-authority.js";
import {
  canonicalToolArguments,
  readSignedToolArgumentsPayload,
  signToolArguments,
} from "./tool-content-guards.js";

type AuthorityClient = {
  prepare(body: Record<string, unknown>, expected: Record<string, unknown>): Promise<{
    payload: Record<string, unknown>;
  }>;
  status(body: Record<string, unknown>, expected: Record<string, unknown>): Promise<{
    payload: Record<string, unknown>;
    ticket?: { compact: string; payload: Record<string, unknown> };
  }>;
  dispatch(input: {
    reservationId: string;
    operationId: string;
    requestHash: string;
    localClaimId: string;
    ticket: string;
  }): {
    endpoint: string;
    proof: string;
    metadata: { reservation_id: string; ticket: string };
  };
};

export type GovnaGatewayDisposition =
  | { kind: "pending"; invocationId: string; pending: ToolUpstreamPending }
  | { kind: "blocked"; invocationId: string; reasonCode: string; message: string }
  | {
      kind: "dispatch";
      invocationId: string;
      operationId: string;
      parameters: Record<string, unknown>;
      authority: {
        endpoint: string;
        proof: string;
        metadata: { reservation_id: string; ticket: string };
      };
    }
  | { kind: "terminal"; invocationId: string; state: string };

function objectArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Govna exact-call arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function pendingDisposition(input: {
  invocationId: string;
  payload: Record<string, unknown>;
}): GovnaGatewayDisposition {
  return {
    kind: "pending",
    invocationId: input.invocationId,
    pending: {
      kind: "approval",
      links: [{
        url: String(input.payload.approval_url),
        host: new URL(String(input.payload.approval_url)).host,
      }],
      executionId: String(input.payload.reservation_id),
      expiresAt: new Date(Number(input.payload.approval_expires_at) * 1000).toISOString(),
      message: String(input.payload.safe_summary),
    },
  };
}

export function govnaToolGatewayCoordinator(
  db: Db,
  options: {
    signingSecret?: string;
    assertCurrentAuthority: NonNullable<Parameters<typeof govnaAuthorityOperationService>[1]>["assertCurrentAuthority"];
  },
) {
  const operations = govnaAuthorityOperationService(db, {
    assertCurrentAuthority: options.assertCurrentAuthority,
  });

  async function prepareOrResume(input: {
    companyId: string;
    invocationId: string;
    connectionId: string;
    gatewayToolName: string;
    upstreamToolName: string;
    parameters: unknown;
    identityContextId?: string | null;
    config: GovnaApprovalAuthorityConfig;
    client: AuthorityClient;
  }): Promise<GovnaGatewayDisposition> {
    let [stored] = await db
      .select()
      .from(toolGovnaAuthorityOperations)
      .where(and(
        eq(toolGovnaAuthorityOperations.companyId, input.companyId),
        eq(toolGovnaAuthorityOperations.invocationId, input.invocationId),
      ));

    if (!stored) {
      const prepared = await operations.withPreparationLock({
        companyId: input.companyId,
        invocationId: input.invocationId,
        run: async (lockedDb) => {
          const [winner] = await lockedDb
            .select()
            .from(toolGovnaAuthorityOperations)
            .where(and(
              eq(toolGovnaAuthorityOperations.companyId, input.companyId),
              eq(toolGovnaAuthorityOperations.invocationId, input.invocationId),
            ));
          if (winner) return { operation: winner, payload: null };
          const parameters = objectArguments(input.parameters);
          const operationId = `paperclip:${input.invocationId}`;
          const requestHash = authorityRequestHash(input.upstreamToolName, parameters);
          const signedArguments = signToolArguments({
            invocationId: input.invocationId,
            toolName: input.gatewayToolName,
            canonicalArguments: canonicalToolArguments(parameters),
            executionOnApprove: true,
            identityContextId: input.identityContextId ?? undefined,
            signingSecret: options.signingSecret,
          });
          const body = {
            trust_revision: input.config.trustRevision,
            operation_id: operationId,
            host_context_id: input.config.hostContextId,
            local_policy_revision: input.config.localPolicyRevision,
            connection_generation: input.config.connectionGeneration,
            name: input.upstreamToolName,
            arguments: parameters,
          };
          const authority = await input.client.prepare(body, {
            operation_id: operationId,
            host_context_id: input.config.hostContextId,
            local_policy_revision: input.config.localPolicyRevision,
            connection_generation: input.config.connectionGeneration,
            resource: input.config.resource,
            tool_name: input.upstreamToolName,
            request_hash: requestHash,
            human_approval_required: true,
          });
          const lockedOperations = govnaAuthorityOperationService(lockedDb, {
            assertCurrentAuthority: options.assertCurrentAuthority,
          });
          const reserved = await lockedOperations.reserve({
            companyId: input.companyId,
            invocationId: input.invocationId,
            connectionId: input.connectionId,
            operationId,
            hostContextId: input.config.hostContextId,
            localPolicyRevision: input.config.localPolicyRevision,
            connectionGeneration: input.config.connectionGeneration,
            requestHash,
            signedArguments,
            authorityBinding: authority.payload,
            reservationId: String(authority.payload.reservation_id),
            approvalUrl: String(authority.payload.approval_url),
            safeSummary: String(authority.payload.safe_summary),
            approvalExpiresAt: new Date(Number(authority.payload.approval_expires_at) * 1000),
          });
          return { operation: reserved.operation, payload: authority.payload };
        },
      });
      if (prepared.payload) {
        return pendingDisposition({ invocationId: input.invocationId, payload: prepared.payload });
      }
      stored = prepared.operation;
      if (stored.state === "pending") {
        return pendingDisposition({ invocationId: input.invocationId, payload: stored.authorityBinding });
      }
    }

    const signed = readSignedToolArgumentsPayload({
      signedArguments: stored.signedArguments,
      invocationId: input.invocationId,
      toolName: input.gatewayToolName,
      signingSecret: options.signingSecret,
    });
    if (!signed) throw new Error("Govna stored exact-call arguments are invalid");
    const parameters = objectArguments(signed.arguments);
    if (authorityRequestHash(input.upstreamToolName, parameters) !== stored.requestHash) {
      throw new Error("Govna stored exact-call arguments changed");
    }
    if (stored.state !== "pending" && stored.state !== "approved") {
      return { kind: "terminal", invocationId: input.invocationId, state: stored.state };
    }
    const status = await input.client.status({
      reservation_id: stored.reservationId,
      operation_id: stored.operationId,
      trust_revision: input.config.trustRevision,
    }, authorityImmutableBinding(stored.authorityBinding));
    if (status.payload.state === "pending") {
      return pendingDisposition({ invocationId: input.invocationId, payload: status.payload });
    }
    if (status.payload.state !== "approved") {
      const terminalState = String(status.payload.state);
      if (terminalState === "denied" || terminalState === "expired" || terminalState === "revoked") {
        await operations.recordTerminalDecision({
          companyId: input.companyId,
          operationId: stored.operationId,
          state: terminalState,
        });
      }
      return { kind: "terminal", invocationId: input.invocationId, state: terminalState };
    }
    if (!status.ticket) {
      return {
        kind: "blocked",
        invocationId: input.invocationId,
        reasonCode: "govna_ticket_unavailable",
        message: "Govna approved this request but cannot mint a dispatch ticket for the current context.",
      };
    }
    const ticketGeneration = Number(status.ticket.payload.ticket_generation);
    await operations.approve({
      companyId: input.companyId,
      operationId: stored.operationId,
      reservationId: stored.reservationId,
      requestHash: stored.requestHash,
      localPolicyRevision: stored.localPolicyRevision,
      connectionGeneration: stored.connectionGeneration,
      ticketGeneration,
    });
    const claimed = await operations.claimDispatch({
      companyId: input.companyId,
      operationId: stored.operationId,
      reservationId: stored.reservationId,
      requestHash: stored.requestHash,
      localPolicyRevision: stored.localPolicyRevision,
      connectionGeneration: stored.connectionGeneration,
      ticketGeneration,
      ticketExpiresAt: Number(status.ticket.payload.exp),
    });
    return {
      kind: "dispatch",
      invocationId: input.invocationId,
      operationId: stored.operationId,
      parameters,
      authority: input.client.dispatch({
        reservationId: stored.reservationId,
        operationId: stored.operationId,
        requestHash: stored.requestHash,
        localClaimId: claimed.localClaimId!,
        ticket: status.ticket.compact,
      }),
    };
  }

  return { prepareOrResume, operations };
}
