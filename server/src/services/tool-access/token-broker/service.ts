import { nativeProviderCatalogFor } from "../../native-provider-catalogs.js";
import { restConnectorFor } from "../../connectors/rest-registry.js";
import { isBrowserUseConnection } from "../../browser-use-client.js";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrantMembers, connectionGrantDelegations, connectionGrants, companyMemberships, toolApplications, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import type { ConnectionTokenIssuanceOutcome, ConnectionTokenRequest, ConnectionTokenResponse } from "@paperclipai/shared";
import { forbidden, HttpError, unprocessable } from "../../../errors.js";
import { secretService } from "../../secrets.js";
import { toolAccessPolicyService } from "../../tool-access-policy.js";
import type { ToolAccessAudit } from "../audit.js";
import { createTokenBrokerAdmission, lockAuthorizedBrokerResponsibleMembership } from "./admission.js";
import { createTokenIssuanceRecorder } from "./issuance.js";
import { createConnectionTokenExchange } from "./exchange.js";
import { CONNECTION_TOKEN_MINT_TOOL_NAME, assertScopeSubset, bearerTokenHash, connectionTokenBrokerEnabled, defaultScopesForConnection, inferConnectionTokenPath, normalizeConnectionTokenScopes, parentScopesForConnection, requestedTtlSeconds } from "./configuration.js";
type TokenBrokerDependencies = {
  now: () => Date;
  secrets: ReturnType<typeof secretService>;
  policySvc: Pick<ReturnType<typeof toolAccessPolicyService>, "decide" | "writeAudit">;
  audit: ToolAccessAudit;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  ensureDefaultOrganizationGrant(connection: typeof toolConnections.$inferSelect): Promise<typeof connectionGrants.$inferSelect>;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

export function createConnectionTokenBroker(db: Db, { now, secrets, policySvc, audit, getConnectionRow, ensureDefaultOrganizationGrant }: TokenBrokerDependencies) {
  const { loadBrokerRunContext, enforceDefaultConnectionTokenRateLimit, hasExplicitConnectionTokenMintProfileGrant } = createTokenBrokerAdmission(db, now);
  const { recordConnectionTokenIssuance, auditConnectionTokenIssuance } = createTokenIssuanceRecorder(db, audit);
  const mintExchangeConnectionToken = createConnectionTokenExchange(now, secrets);
  async function getConnectionApplication(
    connection: typeof toolConnections.$inferSelect,
  ) {
    const [application] = await db
      .select()
      .from(toolApplications)
      .where(eq(toolApplications.id, connection.applicationId));
    return application ?? null;
  }
  return {
    loadBrokerRunContext,
    mintConnectionTokenForAgent: async (input: {
      connectionId: string;
      companyId: string;
      agentId: string;
      runId: string;
      body: ConnectionTokenRequest;
    }): Promise<ConnectionTokenResponse> => {
      const runContext = await loadBrokerRunContext({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
      });
      const connection = await getConnectionRow(
        input.connectionId,
        input.companyId,
      );
      const nativeProvider = nativeProviderCatalogFor(connection);
      if (nativeProvider) throw forbidden(`${nativeProvider.name} credentials stay in the governed tool gateway and cannot be exported.`);
      if (restConnectorFor(connection)) throw forbidden("Deployment connection credentials stay in the governed tool gateway and cannot be exported.");
      if (isBrowserUseConnection(connection)) throw forbidden("Browser Use credentials stay in the governed tool gateway and cannot be exported.");
      if (connection.connectionPurpose === "ai") throw unprocessable("AI credentials are available only through the runtime resolver");
      const application = await getConnectionApplication(connection);
      const brokerEnabled = connectionTokenBrokerEnabled(connection);
      const path = brokerEnabled
        ? inferConnectionTokenPath(connection, application)
        : "static";
      const requestedScope = normalizeConnectionTokenScopes(input.body.scope);
      const parentScopes = parentScopesForConnection(connection);
      const fallbackScopes = defaultScopesForConnection(connection);
      const issuedScope =
        requestedScope.length > 0
          ? requestedScope
          : fallbackScopes.length > 0
            ? fallbackScopes
            : parentScopes;
      const ttlSeconds = requestedTtlSeconds(input.body, connection);
      const attribution = {
        agentId: input.agentId,
        runId: input.runId,
        issueId: runContext.issueId,
        projectId: runContext.projectId,
        responsibleUserId: runContext.responsibleUserId,
      };

      const recordFailure = async (
        outcome: ConnectionTokenIssuanceOutcome,
        errorCode: string,
        details: Record<string, unknown> = {},
      ) => {
        await recordConnectionTokenIssuance({
          companyId: connection.companyId,
          applicationId: connection.applicationId,
          connectionId: connection.id,
          agentId: input.agentId,
          runId: input.runId,
          issueId: runContext.issueId,
          projectId: runContext.projectId,
          responsibleUserId: runContext.responsibleUserId,
          path,
          requestedScope,
          issuedScope,
          ttlSeconds: outcome === "use_env_lease" ? null : ttlSeconds,
          expiresAt: null,
          tokenHash: null,
          outcome,
          errorCode,
          metadata: details,
        });
        await auditConnectionTokenIssuance({
          companyId: connection.companyId,
          connectionId: connection.id,
          agentId: input.agentId,
          runId: input.runId,
          path,
          outcome,
          reasonCode: errorCode,
          details,
        });
      };

      const fail = async (
        status: number,
        message: string,
        outcome: ConnectionTokenIssuanceOutcome,
        errorCode: string,
        details: Record<string, unknown> = {},
      ): Promise<never> => {
        await recordFailure(outcome, errorCode, details);
        throw new HttpError(status, message, {
          code: errorCode,
          path,
          ...details,
        });
      };

      const [install] = await db
        .select({ id: toolConnectionInstalls.id })
        .from(toolConnectionInstalls)
        .where(
          and(
            eq(toolConnectionInstalls.companyId, connection.companyId),
            eq(toolConnectionInstalls.connectionId, connection.id),
            sql`((${toolConnectionInstalls.targetType} = 'company' and ${toolConnectionInstalls.targetId} = ${connection.companyId}) or (${toolConnectionInstalls.targetType} = 'agent' and ${toolConnectionInstalls.targetId} = ${input.agentId}))`,
          ),
        )
        .limit(1);
      if (!install) {
        await fail(
          403,
          `Connection ${connection.name} must be installed for this agent before it can mint a token`,
          "denied",
          "installation_required",
          {
            connection: {
              id: connection.id,
              uid: connection.uid,
              name: connection.name,
            },
            agentId: input.agentId,
            remediation: {
              action: "install_connection",
              targetType: "agent",
              targetId: input.agentId,
            },
          },
        );
      }

      if (
        runContext.run.activeIdentityContextId &&
        (connection.config.sourceTemplateKey === "github" ||
          connection.transportConfig?.sourceTemplateKey === "github")
      ) {
        await fail(
          409,
          "Use managed git, gh, or GitHub tools for this run",
          "denied",
          "managed_github_invocation_required",
        );
      }
      const requestedSubject = input.body.subject;
      if (
        requestedSubject?.type === "user" &&
        requestedSubject.userId !== runContext.responsibleUserId
      ) {
        await fail(
          403,
          "The agent run cannot act as the requested user",
          "denied",
          "subject_not_permitted",
          {
            connection: { uid: connection.uid },
            subject: requestedSubject,
          },
        );
      }

      const actingUserId = runContext.responsibleUserId;
      const autonomous =
        runContext.run.invocationSource === "automation" ||
        runContext.run.invocationSource === "timer";
      let subject: { type: "app" } | { type: "user"; userId: string } =
        connection.credentialPolicy === "shared" ||
        connection.credentialPolicy === "per_agent" ||
        !actingUserId
          ? { type: "app" as const }
          : { type: "user" as const, userId: actingUserId };
      let grant: typeof connectionGrants.$inferSelect | undefined;
      if (connection.credentialPolicy === "per_agent") {
        [grant] = await db
          .select()
          .from(connectionGrants)
          .where(
            and(
              eq(connectionGrants.companyId, connection.companyId),
              eq(connectionGrants.connectionId, connection.id),
              eq(connectionGrants.kind, "agent"),
              eq(connectionGrants.subjectAgentId, input.agentId),
            ),
          )
          .limit(1);
        if (!grant) {
          await fail(
            409,
            "This agent's dedicated authorization is required",
            "denied",
            "agent_authorization_required",
            {
              connection: { uid: connection.uid },
              agentId: input.agentId,
              remediation: {
                action: "start_agent_authorization",
                agentId: input.agentId,
              },
            },
          );
        }
      } else if (connection.credentialPolicy !== "shared" && actingUserId) {
        // Installation targets express the grant owner's consent to agent use;
        // the control-plane-resolved responsible user selects whose grant is in
        // force. A separate standing delegation is required only when no such
        // responsible user exists for unattended work.
        const [membership] = await db
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, connection.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, actingUserId),
              eq(companyMemberships.status, "active"),
            ),
          )
          .limit(1);
        if (!membership) {
          await fail(
            403,
            "The personal grant owner is not an active company member",
            "denied",
            "grant_owner_membership_inactive",
            {
              connection: {
                id: connection.id,
                uid: connection.uid,
                name: connection.name,
              },
              subject: { type: "user", userId: actingUserId },
              remediation: { action: "restore_membership_or_reconnect" },
            },
          );
        }
        [grant] = await db
          .select()
          .from(connectionGrants)
          .where(
            and(
              eq(connectionGrants.companyId, connection.companyId),
              eq(connectionGrants.connectionId, connection.id),
              eq(connectionGrants.kind, "user"),
              eq(connectionGrants.subjectUserId, actingUserId),
            ),
          )
          .limit(1);
      } else if (connection.credentialPolicy === "per_user" && autonomous) {
        const delegated = await db
          .select({ grant: connectionGrants })
          .from(connectionGrantDelegations)
          .innerJoin(
            connectionGrants,
            and(
              eq(connectionGrants.id, connectionGrantDelegations.grantId),
              eq(
                connectionGrants.companyId,
                connectionGrantDelegations.companyId,
              ),
            ),
          )
          .where(
            and(
              eq(connectionGrantDelegations.companyId, connection.companyId),
              eq(connectionGrantDelegations.agentId, input.agentId),
              eq(connectionGrants.connectionId, connection.id),
              eq(connectionGrants.kind, "user"),
            ),
          )
          .limit(2);
        if (delegated.length > 1) {
          await fail(
            409,
            "More than one delegated personal authorization matches this run",
            "denied",
            "subject_not_permitted",
            {
              connection: { uid: connection.uid },
              agentId: input.agentId,
            },
          );
        }
        grant = delegated[0]?.grant;
        if (grant?.subjectUserId)
          subject = { type: "user", userId: grant.subjectUserId };
      }
      if (!grant && connection.credentialPolicy === "per_user") {
        await fail(
          409,
          "User authorization is required",
          "denied",
          "user_authorization_required",
          {
            connection: { uid: connection.uid },
            subject: actingUserId
              ? { type: "user", userId: actingUserId }
              : { type: "app" },
            remediation: { action: "start_authorization" },
          },
        );
      }
      if (!grant) {
        grant = await ensureDefaultOrganizationGrant(connection);
      }

      if (
        grant.kind === "user" &&
        grant.subjectUserId &&
        grant.subjectUserId !== actingUserId
      ) {
        const [membership] = await db
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, connection.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, grant.subjectUserId),
              eq(companyMemberships.status, "active"),
            ),
          )
          .limit(1);
        if (!membership) {
          await fail(
            403,
            "The delegated personal grant owner is not an active company member",
            "denied",
            "grant_owner_membership_inactive",
            {
              connection: {
                id: connection.id,
                uid: connection.uid,
                name: connection.name,
              },
              subject,
              remediation: { action: "restore_membership_or_reconnect" },
            },
          );
        }
      }

      if (grant.kind === "organization") {
        const activeAudienceMember = actingUserId
          ? await db
              .select({ id: companyMemberships.id })
              .from(companyMemberships)
              .where(
                and(
                  eq(companyMemberships.companyId, connection.companyId),
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.principalId, actingUserId),
                  eq(companyMemberships.status, "active"),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
        const audience = await db
          .select({ subjectId: connectionGrantMembers.subjectId })
          .from(connectionGrantMembers)
          .where(
            and(
              eq(connectionGrantMembers.companyId, connection.companyId),
              eq(connectionGrantMembers.grantId, grant.id),
              eq(connectionGrantMembers.subjectType, "user"),
            ),
          );
        if (
          (actingUserId !== null && !activeAudienceMember) ||
          (audience.length > 0 &&
            (!actingUserId ||
              !audience.some((member) => member.subjectId === actingUserId)))
        ) {
          await fail(
            403,
            "The acting user is not in this grant's audience",
            "denied",
            "grant_audience_denied",
            {
              connection: { uid: connection.uid },
              subject,
              grantId: grant.id,
            },
          );
        }
      }

      if (grant.status !== "active") {
        const code =
          grant.status === "needs_reauthorization"
            ? "needs_reauthorization"
            : "grant_revoked";
        await fail(
          409,
          "The selected connection grant is not active",
          "denied",
          code,
          {
            connection: { uid: connection.uid },
            subject,
            grantId: grant.id,
            remediation: { action: "reauthorize" },
          },
        );
      }
      const requestedScopeSelectors = new Set(requestedScope);
      const matchingScopedRefs = grant.credentialSecretRefs.filter(
        (ref) => ref.keyScope && requestedScopeSelectors.has(ref.keyScope),
      );
      const selectedCredentialSecretRefs =
        matchingScopedRefs.length > 0
          ? grant.credentialSecretRefs.filter(
              (ref) =>
                !ref.keyScope || requestedScopeSelectors.has(ref.keyScope),
            )
          : grant.credentialSecretRefs.filter((ref) => !ref.keyScope);
      const rotateBefore = Date.now() + 14 * 24 * 60 * 60 * 1000;
      const expiringRef = selectedCredentialSecretRefs.find(
        (ref) => ref.expiresAt && Date.parse(ref.expiresAt) <= rotateBefore,
      );
      if (expiringRef && connection.healthStatus !== "degraded") {
        await db
          .update(toolConnections)
          .set({
            healthStatus: "degraded",
            healthMessage: `Rotate ${expiringRef.label ?? expiringRef.configPath} before it expires.`,
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, connection.id));
      }
      const credentialConnection = {
        ...connection,
        credentialSecretRefs: selectedCredentialSecretRefs,
      };

      if (!connection.enabled || connection.status !== "active") {
        await fail(
          409,
          "Connection is not active",
          "denied",
          "connection_not_active",
          {
            connectionStatus: connection.status,
            enabled: connection.enabled,
          },
        );
      }
      if (
        ["failed", "error", "missing_secret"].includes(connection.healthStatus)
      ) {
        await fail(
          409,
          "Connection credential needs attention",
          "denied",
          "credential_revoked",
          {
            healthStatus: connection.healthStatus,
            healthMessage: connection.healthMessage ?? null,
          },
        );
      }
      if (!brokerEnabled) {
        await fail(
          403,
          "Connection token broker is not enabled for this connection",
          "denied",
          "broker_not_enabled",
          {
            reason:
              "Connections must explicitly opt in with tokenBroker.enabled before agents can request brokered tokens.",
          },
        );
      }
      try {
        assertScopeSubset({ requestedScope: issuedScope, parentScopes });
      } catch {
        await fail(
          403,
          "Requested token scope exceeds the connection parent scope",
          "denied",
          "scope_exceeds_parent",
          {
            parentScopeCount: parentScopes.length,
          },
        );
      }

      const hasBrokerGrant = await hasExplicitConnectionTokenMintProfileGrant({
        companyId: connection.companyId,
        agentId: input.agentId,
        issueId: runContext.issueId,
        projectId: runContext.projectId,
        routineId: runContext.routineId,
      });
      if (!hasBrokerGrant) {
        await fail(
          403,
          "Connection token minting requires an explicit broker profile grant",
          "denied",
          "broker_mint_not_granted",
          {
            reason:
              "A connection-level profile grant is not sufficient for connection_token.mint.",
          },
        );
      }

      const decisionInput = {
        companyId: connection.companyId,
        actor: {
          actorType: "agent" as const,
          actorId: input.agentId,
          agentId: input.agentId,
        },
        runContext: {
          heartbeatRunId: input.runId,
          issueId: runContext.issueId,
          projectId: runContext.projectId,
          routineId: runContext.routineId,
        },
        request: {
          applicationId: connection.applicationId,
          connectionId: connection.id,
          providerType: "connection_token_broker",
          applicationKey: application?.applicationKey ?? null,
          upstreamToolName: CONNECTION_TOKEN_MINT_TOOL_NAME,
          riskLevel: "write",
          toolName: CONNECTION_TOKEN_MINT_TOOL_NAME,
          arguments: {
            path,
            scope: issuedScope,
            requestedTtlSeconds: input.body.requestedTtlSeconds ?? null,
          },
        },
        consumeRateLimit: true,
      };
      const decision = await policySvc.decide(decisionInput);
      await policySvc.writeAudit(decisionInput, decision);
      if (!decision.allowed) {
        await fail(
          decision.decision === "rate_limited" ? 429 : 403,
          decision.explanation,
          decision.decision === "rate_limited" ? "rate_limited" : "denied",
          decision.reasonCode,
          {
            decision: decision.decision,
            effectiveProfileIds: decision.effectiveProfileIds,
            matchedPolicyIds: decision.matchedPolicyIds,
            rateLimitState: decision.rateLimitState ?? null,
          },
        );
      }

      try {
        await enforceDefaultConnectionTokenRateLimit({
          connection,
          agentId: input.agentId,
          path,
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 429) {
          await fail(
            429,
            error.message,
            "rate_limited",
            "rate_limited",
            asRecord(error.details),
          );
        }
        throw error;
      }

      if (path === "static") {
        await recordFailure("use_env_lease", "use_env_lease", {
          reason:
            "Connection uses durable static credentials; broker token delivery is refused.",
        });
        return {
          status: "use_env_lease",
          code: "use_env_lease",
          connectionId: connection.id,
          connection: { id: connection.id, uid: connection.uid },
          grantId: grant.id,
          path: "static",
          message:
            "This connection uses static credentials. Use an audited environment lease projection instead.",
          scope: issuedScope,
          attribution,
        };
      }
      if (path === "oauth_access") {
        await fail(
          422,
          "OAuth access-token projection is disabled; configure a short-lived exchange mint path instead",
          "denied",
          "oauth_access_projection_disabled",
          {
            reason:
              "The broker must not return stored upstream OAuth bearer tokens directly.",
          },
        );
      }

      const selectedGrant = grant;
      try {
        const mintResult = await db.transaction(async (tx) => {
          await lockAuthorizedBrokerResponsibleMembership(
            {
              companyId: connection.companyId,
              responsibleUserId: runContext.responsibleUserId,
            },
            tx,
          );
          const minted = await mintExchangeConnectionToken(
            {
              connection: credentialConnection,
              application,
              agentId: input.agentId,
              runId: input.runId,
              issueId: runContext.issueId,
              responsibleUserId: runContext.responsibleUserId,
              scope: issuedScope,
              ttlSeconds,
            },
            secretService(tx),
          );
          const expiresAt = minted.expiresAt;
          const mintedScope = "scope" in minted ? minted.scope : issuedScope;
          const effectiveTtlSeconds = Math.max(
            1,
            Math.min(
              900,
              Math.ceil((expiresAt.getTime() - now().getTime()) / 1000),
            ),
          );
          const tokenHash = bearerTokenHash(minted.token);
          await recordConnectionTokenIssuance(
            {
              companyId: connection.companyId,
              applicationId: connection.applicationId,
              connectionId: connection.id,
              agentId: input.agentId,
              runId: input.runId,
              issueId: runContext.issueId,
              projectId: runContext.projectId,
              responsibleUserId: runContext.responsibleUserId,
              path,
              requestedScope,
              issuedScope: mintedScope,
              ttlSeconds: effectiveTtlSeconds,
              expiresAt,
              tokenHash,
              outcome: "success",
              metadata: { tokenRef: tokenHash, tokenType: minted.tokenType },
            },
            tx,
          );
          await tx
            .update(connectionGrants)
            .set({ lastUsedAt: new Date(), updatedAt: new Date() })
            .where(eq(connectionGrants.id, selectedGrant.id));
          return {
            minted,
            expiresAt,
            mintedScope,
            effectiveTtlSeconds,
            tokenHash,
          };
        });
        await auditConnectionTokenIssuance({
          companyId: connection.companyId,
          connectionId: connection.id,
          agentId: input.agentId,
          runId: input.runId,
          path,
          outcome: "success",
          details: {
            ttlSeconds: mintResult.effectiveTtlSeconds,
            scopeCount: mintResult.mintedScope.length,
            tokenRef: mintResult.tokenHash,
          },
        });
        return {
          status: "minted",
          connectionId: connection.id,
          connection: { id: connection.id, uid: connection.uid },
          grantId: selectedGrant.id,
          providerTenantId: selectedGrant.providerTenant?.externalId,
          path: "exchange",
          token: mintResult.minted.token,
          tokenType: mintResult.minted.tokenType,
          expiresAt: mintResult.expiresAt.toISOString(),
          ttlSeconds: mintResult.effectiveTtlSeconds,
          scope: mintResult.mintedScope,
          attribution,
        };
      } catch (error) {
        const details =
          error instanceof HttpError && asRecord(error.details).code
            ? asRecord(error.details)
            : {};
        const errorCode =
          typeof details.code === "string" ? details.code : "mint_failed";
        const outcome: ConnectionTokenIssuanceOutcome =
          errorCode === "upstream_error" ||
          errorCode === "upstream_token_missing"
            ? "upstream_error"
            : "failure";
        await recordFailure(outcome, errorCode, {
          ...details,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  };
}
