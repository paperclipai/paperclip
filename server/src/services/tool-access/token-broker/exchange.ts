import type { ActorInfo } from "../types.js";
import { toolApplications, toolConnections } from "@paperclipai/db";
import { badRequest, HttpError, unprocessable } from "../../../errors.js";
import { parseRemoteHttpEndpoint } from "../../remote-http-endpoint-guard.js";
import { guardedRemoteHttpFetch } from "../../remote-http-fetch.js";
import { secretService } from "../../secrets.js";

import { tokenBrokerHttpFetchOptions } from "./endpoint-policy.js";
import { readConfigString, readConfigStringArray, tokenBrokerConfig, isPagesTokenConnection, exchangeTokenUrl, pagesNamespaceFromScope } from "./configuration.js";
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

export function createConnectionTokenExchange(now: () => Date, secrets: ReturnType<typeof secretService>) {
  function accessContextForBroker(input: {
    connection: typeof toolConnections.$inferSelect;
    agentId: string;
    runId: string;
    issueId: string | null;
    actorSource?: ActorInfo["actorType"] | null;
    configPath: string;
  }) {
    return {
      consumerType: "tool_connection" as const,
      consumerId: input.connection.id,
      configPath: input.configPath,
      actorType: "agent" as const,
      actorId: input.agentId,
      actorSource: "agent_jwt" as const,
      issueId: input.issueId,
      heartbeatRunId: input.runId,
    };
  }

  function findBrokerCredentialRef(
    connection: typeof toolConnections.$inferSelect,
  ) {
    const broker = tokenBrokerConfig(connection);
    const configuredPath =
      readConfigString(broker, "parentCredentialConfigPath") ??
      readConfigString(broker, "credentialConfigPath") ??
      readConfigString(broker, "secretConfigPath");
    const configuredName =
      readConfigString(broker, "parentCredentialName") ??
      readConfigString(broker, "credentialName");
    const secretCandidates = connection.credentialSecretRefs.filter(
      (ref) =>
        ref.configPath !== "oauth.access_token" &&
        ref.configPath !== "oauth.refresh_token" &&
        ref.configPath !== "oauth.client_secret",
    );
    const secretRef = configuredPath
      ? connection.credentialSecretRefs.find(
          (ref) => ref.configPath === configuredPath,
        )
      : (secretCandidates.find(
          (ref) => ref.configPath === "credentials.deploy_token",
        ) ??
        secretCandidates.find(
          (ref) => ref.configPath === "pages.deploy_token",
        ) ??
        secretCandidates[0]);
    if (secretRef)
      return {
        kind: "secret_ref" as const,
        ref: secretRef,
        configPath: secretRef.configPath,
      };
    const credentialRef = configuredName
      ? connection.credentialRefs.find((ref) => ref.name === configuredName)
      : connection.credentialRefs[0];
    if (credentialRef)
      return {
        kind: "credential_ref" as const,
        ref: credentialRef,
        configPath: `credentials.${credentialRef.name}`,
      };
    return null;
  }

  async function resolveBrokerParentCredential(
    input: {
      connection: typeof toolConnections.$inferSelect;
      agentId: string;
      runId: string;
      issueId: string | null;
    },
    secretClient: ReturnType<typeof secretService> = secrets,
  ) {
    const ref = findBrokerCredentialRef(input.connection);
    if (!ref) {
      throw unprocessable(
        "Connection token exchange requires a vault-backed parent credential",
        {
          code: "parent_credential_missing",
        },
      );
    }
    if (ref.kind === "secret_ref") {
      return secretClient.resolveSecretValue(
        input.connection.companyId,
        ref.ref.secretId,
        ref.ref.versionSelector ?? "latest",
        {
          accessContext: accessContextForBroker({
            ...input,
            configPath: ref.configPath,
          }),
          bindingContext: accessContextForBroker({
            ...input,
            configPath: ref.configPath,
          }),
        },
      );
    }
    return secretClient.resolveSecretValue(
      input.connection.companyId,
      ref.ref.secretId,
      ref.ref.version ?? "latest",
      {
        accessContext: accessContextForBroker({
          ...input,
          configPath: ref.configPath,
        }),
        bindingContext: accessContextForBroker({
          ...input,
          configPath: ref.configPath,
        }),
      },
    );
  }

  async function mintExchangeConnectionToken(
    input: {
      connection: typeof toolConnections.$inferSelect;
      application: typeof toolApplications.$inferSelect | null;
      agentId: string;
      runId: string;
      issueId: string | null;
      responsibleUserId: string | null;
      scope: string[];
      ttlSeconds: number;
    },
    secretClient: ReturnType<typeof secretService> = secrets,
  ) {
    const isPages = isPagesTokenConnection(input.connection, input.application);
    const parentToken = await resolveBrokerParentCredential(
      input,
      secretClient,
    );
    const broker = tokenBrokerConfig(input.connection);
    const protocol =
      readConfigString(broker, "protocol") ??
      readConfigString(broker, "exchangeProtocol") ??
      (isPages ? "pages" : "generic");
    const url = exchangeTokenUrl(input.connection, isPages);
    const actor = {
      type: "agent",
      id: input.agentId,
      runId: input.runId,
      ...(input.responsibleUserId
        ? { onBehalfOf: `user:${input.responsibleUserId}` }
        : {}),
    };
    let response: Response;
    if (protocol === "rfc8693") {
      const body = new URLSearchParams();
      body.set("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange");
      body.set("subject_token", parentToken);
      body.set(
        "subject_token_type",
        readConfigString(broker, "subjectTokenType") ??
          "urn:ietf:params:oauth:token-type:access_token",
      );
      body.set("scope", input.scope.join(" "));
      const audience = readConfigString(broker, "audience");
      if (audience) body.set("audience", audience);
      body.set(
        "requested_token_type",
        readConfigString(broker, "requestedTokenType") ??
          "urn:ietf:params:oauth:token-type:access_token",
      );
      body.set(
        "actor_token",
        Buffer.from(JSON.stringify(actor)).toString("base64url"),
      );
      body.set(
        "actor_token_type",
        readConfigString(broker, "actorTokenType") ??
          "urn:ietf:params:oauth:token-type:jwt",
      );
      const endpoint = parseRemoteHttpEndpoint(url, (message, code) =>
        badRequest(message, { code }),
      );
      response = await guardedRemoteHttpFetch(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        },
        tokenBrokerHttpFetchOptions(endpoint),
      );
    } else {
      const namespace = isPages ? pagesNamespaceFromScope(input.scope) : null;
      const body =
        isPages && namespace
          ? {
              namespace,
              ttlSeconds: input.ttlSeconds,
              actions: ["publish"],
              actor,
            }
          : {
              scope: input.scope,
              ttlSeconds: input.ttlSeconds,
              actor,
              audience: readConfigString(broker, "audience"),
            };
      const endpoint = parseRemoteHttpEndpoint(url, (message, code) =>
        badRequest(message, { code }),
      );
      response = await guardedRemoteHttpFetch(
        endpoint,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${parentToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        tokenBrokerHttpFetchOptions(endpoint),
      );
    }
    const payload = (await response.json().catch(() => ({}))) as unknown;
    const record = asRecord(payload);
    if (!response.ok) {
      const code =
        typeof record.code === "string"
          ? record.code
          : typeof record.error === "string"
            ? record.error
            : "upstream_error";
      throw new HttpError(
        response.status === 401 || response.status === 403 ? 409 : 502,
        "Connection token exchange failed",
        {
          code:
            code === "parent_revoked" ? "credential_revoked" : "upstream_error",
          upstreamCode: code,
          upstreamStatus: response.status,
          upstreamRequestId:
            typeof record.requestId === "string" ? record.requestId : null,
        },
      );
    }
    const token =
      typeof record.token === "string"
        ? record.token
        : typeof record.access_token === "string"
          ? record.access_token
          : null;
    if (!token)
      throw new HttpError(
        502,
        "Connection token exchange did not return a token",
        { code: "upstream_token_missing" },
      );
    const expiresIn =
      typeof record.expires_in === "number"
        ? record.expires_in
        : Number(record.expires_in);
    const expiresAt =
      typeof record.expiresAt === "string" &&
      Number.isFinite(Date.parse(record.expiresAt))
        ? new Date(record.expiresAt)
        : typeof record.expires_at === "string" &&
            Number.isFinite(Date.parse(record.expires_at))
          ? new Date(record.expires_at)
          : new Date(
              now().getTime() +
                Math.min(
                  input.ttlSeconds,
                  Number.isFinite(expiresIn) && expiresIn > 0
                    ? expiresIn
                    : input.ttlSeconds,
                ) *
                  1000,
            );
    const responseScope =
      readConfigStringArray(record.scope).length > 0
        ? readConfigStringArray(record.scope)
        : input.scope;
    return {
      token,
      tokenType:
        typeof record.token_type === "string" ? record.token_type : "Bearer",
      expiresAt,
      scope: responseScope,
    };
  }
  return mintExchangeConnectionToken;
}
