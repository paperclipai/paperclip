import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import {
  ACTION_CANCEL_LOGIN,
  ACTION_DISCONNECT,
  ACTION_SET_PAUSED,
  ACTION_START_LOGIN,
  ACTION_SUBMIT_PASSWORD,
  ACTION_UPDATE_CONNECTION,
  DATA_LOGIN_STATUS,
  DATA_OVERVIEW,
  DIALOG_ORIGIN_KIND,
  LOGIN_STREAM_CHANNEL,
  PLUGIN_ID,
  TOOL_SEND_TEXT,
} from "./constants.js";
import {
  findConnection,
  listConnections,
  listKnownCompanyIds,
  patchConnection,
  publicConnection,
  upsertConnection,
} from "./connections.js";
import { ingestInboundMessage } from "./inbound.js";
import { idleLoginStatus, reduceLogin } from "./login.js";
import { redactValue } from "./redaction.js";
import { authorizeSendText } from "./send.js";
import {
  deleteAccountSession,
  getAccountSession,
  newSessionSecretId,
  putAccountSession,
  resolveTelegramAppCredentials,
} from "./secrets.js";
import { createGramJsClientFactory } from "./telegram-gramjs.js";
import type {
  LiveTelegramAccount,
  LoginStatus,
  QrLoginHandle,
  ResolveAppCredentials,
  TelegramClientFactory,
} from "./types.js";

export type TelegramPluginDeps = {
  createClient?: TelegramClientFactory;
  resolveAppCredentials?: ResolveAppCredentials;
};

type PendingLogin = {
  companyId: string;
  loginId: string;
  handle: QrLoginHandle;
  status: LoginStatus;
};

function wrapLogger(ctx: PluginContext): PluginContext["logger"] {
  return {
    info(message, meta) {
      ctx.logger.info(message, redactValue(meta) as Record<string, unknown> | undefined);
    },
    warn(message, meta) {
      ctx.logger.warn(message, redactValue(meta) as Record<string, unknown> | undefined);
    },
    error(message, meta) {
      ctx.logger.error(message, redactValue(meta) as Record<string, unknown> | undefined);
    },
    debug(message, meta) {
      ctx.logger.debug(message, redactValue(meta) as Record<string, unknown> | undefined);
    },
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireCompanyId(value: unknown, fallback?: string | null): string {
  const companyId = readString(value) || readString(fallback);
  if (!companyId) throw new Error("companyId is required.");
  return companyId;
}

export function createTelegramUserClientPlugin(deps: TelegramPluginDeps = {}) {
  const createClient = deps.createClient ?? createGramJsClientFactory();
  const liveByAccount = new Map<string, LiveTelegramAccount>();
  const pendingLogins = new Map<string, PendingLogin>();
  let pluginContext: PluginContext | null = null;

  const resolveCredentials: ResolveAppCredentials = async (companyId) => {
    if (deps.resolveAppCredentials) return deps.resolveAppCredentials(companyId);
    if (!pluginContext) throw new Error("Plugin is not started.");
    return resolveTelegramAppCredentials(pluginContext, companyId);
  };

  function liveAccountIds(): Set<string> {
    return new Set(liveByAccount.keys());
  }

  function emitLogin(companyId: string, status: LoginStatus) {
    const ctx = pluginContext;
    if (!ctx) return;
    ctx.streams.emit(LOGIN_STREAM_CHANNEL, { companyId, status });
  }

  async function handleInbound(message: Parameters<typeof ingestInboundMessage>[2]) {
    const ctx = pluginContext;
    if (!ctx) return;
    const log = wrapLogger(ctx);
    const connection = await findConnection(ctx, message.companyId, message.accountId, liveAccountIds());
    if (!connection) {
      log.warn("Dropped inbound Telegram message for an unknown account", {
        companyId: message.companyId,
        accountId: message.accountId,
      });
      return;
    }
    try {
      await ingestInboundMessage(ctx, connection, message);
    } catch (error) {
      log.error("Failed to ingest Telegram inbound message", {
        companyId: message.companyId,
        accountId: message.accountId,
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  async function attachLiveSession(companyId: string, live: LiveTelegramAccount) {
    const existing = liveByAccount.get(live.account.telegramUserId);
    if (existing && existing.companyId !== companyId) {
      await live.disconnect().catch(() => undefined);
      throw new Error("That Telegram account is already connected.");
    }
    if (existing && existing !== live) {
      await existing.disconnect().catch(() => undefined);
    }
    liveByAccount.set(live.account.telegramUserId, live);
  }

  async function reconnectCompany(ctx: PluginContext, companyId: string) {
    const log = wrapLogger(ctx);
    const connections = await listConnections(ctx, companyId, liveAccountIds());
    for (const connection of connections) {
      if (liveByAccount.has(connection.telegramUserId)) continue;
      if (!connection.sessionSecretId) continue;
      const session = await getAccountSession(ctx, companyId, connection.sessionSecretId);
      if (!session) continue;
      try {
        const credentials = await resolveCredentials(companyId);
        const live = await createClient.connectFromSession({
          companyId,
          credentials,
          session,
          onInbound: handleInbound,
        });
        await attachLiveSession(companyId, live);
        log.info("Reconnected Telegram account from stored session", {
          companyId,
          telegramUserId: connection.telegramUserId,
        });
      } catch (error) {
        log.error("Failed to reconnect Telegram account", {
          companyId,
          telegramUserId: connection.telegramUserId,
          message: error instanceof Error ? error.message : "unknown error",
        });
      }
    }
  }

  async function reconnectAll(ctx: PluginContext) {
    const companyIds = await listKnownCompanyIds(ctx);
    for (const companyId of companyIds) {
      await reconnectCompany(ctx, companyId);
    }
  }

  const plugin = definePlugin({
    multiCompanyConfig: true,
    async setup(ctx) {
      pluginContext = ctx;
      const log = wrapLogger(ctx);
      log.info("Telegram plugin setup");
      await reconnectAll(ctx);

      ctx.data.register(DATA_OVERVIEW, async (params) => {
        const companyId = requireCompanyId(params.companyId);
        const connections = await listConnections(ctx, companyId, liveAccountIds());
        return {
          pluginId: PLUGIN_ID,
          credentialsConfigured: await credentialsConfigured(ctx, companyId),
          connections: connections.map(publicConnection),
        };
      });

      ctx.data.register(DATA_LOGIN_STATUS, async (params) => {
        const companyId = requireCompanyId(params.companyId);
        const loginId = readString(params.loginId);
        if (loginId) {
          const pending = pendingLogins.get(loginId);
          if (pending && pending.companyId === companyId) return pending.status;
        }
        const pending = [...pendingLogins.values()].find((entry) => entry.companyId === companyId);
        return pending?.status ?? idleLoginStatus();
      });

      ctx.actions.register(ACTION_START_LOGIN, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const credentials = await resolveCredentials(companyId);
        const loginId = randomUUID();
        const pending: PendingLogin = {
          companyId,
          loginId,
          handle: {
            async submitPassword() {
              throw new Error("Telegram login is still starting.");
            },
            async waitUntilSignedIn() {
              throw new Error("Telegram login is still starting.");
            },
            async abort() {},
          },
          status: reduceLogin(idleLoginStatus(), { type: "start", loginId }),
        };
        pendingLogins.set(loginId, pending);
        emitLogin(companyId, pending.status);
        const handle = await createClient.startQrLogin({
          credentials,
          onQr: (qr) => {
            const current = pendingLogins.get(loginId);
            if (!current) return;
            current.status = reduceLogin(current.status, { type: "qr", loginId, qr });
            emitLogin(companyId, current.status);
          },
          onPasswordRequired: (hint) => {
            const current = pendingLogins.get(loginId);
            if (!current) return;
            current.status = reduceLogin(current.status, { type: "password_required", loginId, hint });
            emitLogin(companyId, current.status);
          },
        });
        pending.handle = handle;
        void handle.waitUntilSignedIn()
          .then(async (signedIn) => {
            const secretId = newSessionSecretId();
            await putAccountSession(ctx, companyId, secretId, signedIn.session);
            await upsertConnection(ctx, {
              companyId,
              account: signedIn.account,
              sessionSecretId: secretId,
            });
            const live = await createClient.connectFromSession({
              companyId,
              credentials,
              session: signedIn.session,
              onInbound: handleInbound,
            });
            await attachLiveSession(companyId, live);
            pending.status = reduceLogin(pending.status, {
              type: "connected",
              loginId,
              account: signedIn.account,
            });
            emitLogin(companyId, pending.status);
            log.info("Telegram account connected", {
              companyId,
              telegramUserId: signedIn.account.telegramUserId,
            });
          })
          .catch((error: unknown) => {
            pending.status = reduceLogin(pending.status, {
              type: "error",
              loginId,
              message: error instanceof Error ? error.message : "Telegram login failed.",
            });
            emitLogin(companyId, pending.status);
          });
        return { loginId, status: pending.status };
      });

      ctx.actions.register(ACTION_SUBMIT_PASSWORD, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const loginId = readString(params.loginId);
        const password = typeof params.password === "string" ? params.password : "";
        const pending = pendingLogins.get(loginId);
        if (!pending || pending.companyId !== companyId) {
          throw new Error("No Telegram login is waiting for a password.");
        }
        if (!password) throw new Error("Cloud password is required.");
        await pending.handle.submitPassword(password);
        return { loginId, status: pending.status };
      });

      ctx.actions.register(ACTION_CANCEL_LOGIN, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const loginId = readString(params.loginId);
        const pending = pendingLogins.get(loginId);
        if (!pending || pending.companyId !== companyId) return { status: idleLoginStatus() };
        await pending.handle.abort().catch(() => undefined);
        pendingLogins.delete(loginId);
        const status = reduceLogin(pending.status, { type: "cancel", loginId });
        emitLogin(companyId, status);
        return { status };
      });

      ctx.actions.register(ACTION_UPDATE_CONNECTION, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const telegramUserId = readString(params.telegramUserId);
        const assignedAgentId = params.assignedAgentId === null
          ? null
          : readString(params.assignedAgentId) || undefined;
        const connection = await patchConnection(ctx, companyId, telegramUserId, {
          assignedAgentId: assignedAgentId === undefined ? undefined : assignedAgentId,
        }, liveAccountIds());
        return publicConnection(connection);
      });

      ctx.actions.register(ACTION_SET_PAUSED, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const telegramUserId = readString(params.telegramUserId);
        const paused = Boolean(params.paused);
        const connection = await patchConnection(ctx, companyId, telegramUserId, { paused }, liveAccountIds());
        return publicConnection(connection);
      });

      ctx.actions.register(ACTION_DISCONNECT, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const telegramUserId = readString(params.telegramUserId);
        const connection = await findConnection(ctx, companyId, telegramUserId, liveAccountIds());
        if (!connection) return { disconnected: false };
        const live = liveByAccount.get(telegramUserId);
        if (live && live.companyId === companyId) {
          await live.disconnect().catch(() => undefined);
          liveByAccount.delete(telegramUserId);
        }
        if (connection.sessionSecretId) {
          await deleteAccountSession(ctx, companyId, connection.sessionSecretId);
        }
        await upsertConnection(ctx, {
          companyId,
          account: {
            telegramUserId: connection.telegramUserId,
            username: connection.username,
            displayName: connection.displayName,
          },
          sessionSecretId: "",
          assignedAgentId: connection.assignedAgentId,
          paused: true,
        });
        return { disconnected: true };
      });

      ctx.tools.register(
        TOOL_SEND_TEXT,
        {
          displayName: "Send Telegram text",
          description: "Send a text reply to the Telegram chat bound to the current issue.",
          parametersSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
              accountId: { type: "string" },
              peerId: { type: "string" },
              issueId: { type: "string" },
            },
            required: ["text"],
          },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const payload = (params ?? {}) as {
            text?: string;
            accountId?: string;
            peerId?: string;
            issueId?: string;
          };
          const connections = await listConnections(ctx, runCtx.companyId, liveAccountIds());
          let issueOriginId: string | null = null;
          if (payload.issueId) {
            const issue = await ctx.issues.get(payload.issueId, runCtx.companyId);
            if (!issue || issue.originKind !== DIALOG_ORIGIN_KIND) {
              return { error: "This issue is not a Telegram dialog." };
            }
            issueOriginId = issue.originId ?? null;
          }
          const authorized = authorizeSendText(connections, {
            companyId: runCtx.companyId,
            agentId: runCtx.agentId,
            accountId: payload.accountId,
            peerId: payload.peerId,
            issueOriginId,
            text: payload.text ?? "",
          });
          if (!authorized.ok) return { error: authorized.error };
          const live = liveByAccount.get(authorized.accountId);
          if (!live || live.companyId !== runCtx.companyId) {
            return { error: "That Telegram account is not live in the plugin worker." };
          }
          await live.sendText(authorized.peerId, payload.text!.trim());
          return {
            content: "Sent Telegram message.",
            data: {
              accountId: authorized.accountId,
              peerId: authorized.peerId,
            },
          };
        },
      );
    },

    async onHealth(): Promise<PluginHealthDiagnostics> {
      return {
        status: "ok",
        message: "Telegram plugin ready",
        details: {
          liveAccounts: liveByAccount.size,
          pendingLogins: pendingLogins.size,
        },
      };
    },

    async onConfigChanged(_config, context) {
      if (!pluginContext) return;
      if (context?.companyId) await reconnectCompany(pluginContext, context.companyId);
      else await reconnectAll(pluginContext);
    },

    async onIdleDrain() {
      return liveByAccount.size > 0 || pendingLogins.size > 0 ? "present" : "none";
    },

    async onShutdown() {
      for (const pending of pendingLogins.values()) {
        await pending.handle.abort().catch(() => undefined);
      }
      pendingLogins.clear();
      for (const live of liveByAccount.values()) {
        await live.disconnect().catch(() => undefined);
      }
      liveByAccount.clear();
    },
  });

  return plugin;
}

async function credentialsConfigured(ctx: PluginContext, companyId: string): Promise<boolean> {
  try {
    await resolveTelegramAppCredentials(ctx, companyId);
    return true;
  } catch {
    return false;
  }
}

const plugin = createTelegramUserClientPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
