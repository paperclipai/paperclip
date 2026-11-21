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
  MAX_INBOUND_MEDIA_BYTES,
  MAX_START_LOGINS_PER_WINDOW,
  PENDING_LOGIN_TTL_MS,
  PLUGIN_ID,
  START_LOGIN_WINDOW_MS,
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
import {
  hasInboundBudget,
  inboundShapeAllowed,
  ingestInboundMessage,
  peekPeerMediaSlot,
  takeInboundMessageSlot,
  takePeerMediaSlot,
} from "./inbound.js";
import { idleLoginStatus, publicLoginStatus, reduceLogin } from "./login.js";
import { redactValue } from "./redaction.js";
import { authorizeSendText } from "./send.js";
import {
  deleteAccountSession,
  getAccountSession,
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
  TelegramConnectionPatch,
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
  cancelled: boolean;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  finished: Promise<void>;
};

type SettledLogin = {
  companyId: string;
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

function normalizeAllowedPeerIds(value: unknown[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = readString(item);
    if (!/^[1-9]\d{0,15}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 100) break;
  }
  return ids;
}

function requireCompanyId(value: unknown, fallback?: string | null): string {
  const companyId = readString(value) || readString(fallback);
  if (!companyId) throw new Error("companyId is required.");
  return companyId;
}

function assertConnectionManager(
  actor: { type?: string; companyId?: string | null } | undefined,
  companyId: string,
): void {
  if (actor?.type !== "user" || (actor.companyId != null && actor.companyId !== companyId)) {
    throw new Error("Only a board user can change Telegram account access.");
  }
}

export function createTelegramUserClientPlugin(deps: TelegramPluginDeps = {}) {
  const createClient = deps.createClient ?? createGramJsClientFactory();
  const liveByAccount = new Map<string, LiveTelegramAccount>();
  const pendingLogins = new Map<string, PendingLogin>();
  const loginResults = new Map<string, SettledLogin>();
  const startLoginHits = new Map<string, number[]>();
  const accountGenerations = new Map<string, number>();
  const accountGates = new Map<string, Promise<void>>();
  const reconnectJobs = new Set<Promise<void>>();
  const loginJobs = new Set<Promise<void>>();
  const inboundJobs = new Set<Promise<void>>();
  let pluginContext: PluginContext | null = null;
  let shuttingDown = false;

  const resolveCredentials: ResolveAppCredentials = async (companyId) => {
    if (deps.resolveAppCredentials) return deps.resolveAppCredentials(companyId);
    if (!pluginContext) throw new Error("Plugin is not started.");
    return resolveTelegramAppCredentials(pluginContext, companyId);
  };

  function liveAccountIds(): Set<string> {
    return new Set(liveByAccount.keys());
  }

  function accountGenerationKey(companyId: string, telegramUserId: string): string {
    return `${companyId}:${telegramUserId}`;
  }

  function accountGeneration(companyId: string, telegramUserId: string): number {
    return accountGenerations.get(accountGenerationKey(companyId, telegramUserId)) ?? 0;
  }

  function bumpAccountGeneration(companyId: string, telegramUserId: string): number {
    const next = accountGeneration(companyId, telegramUserId) + 1;
    accountGenerations.set(accountGenerationKey(companyId, telegramUserId), next);
    return next;
  }

  function withAccountGate<T>(companyId: string, telegramUserId: string, fn: () => Promise<T>): Promise<T> {
    const key = accountGenerationKey(companyId, telegramUserId);
    const previous = accountGates.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    accountGates.set(key, tail);
    return previous.then(fn, fn).finally(() => {
      release();
      if (accountGates.get(key) === tail) accountGates.delete(key);
    });
  }

  async function dropLive(companyId: string, telegramUserId: string, live?: LiveTelegramAccount): Promise<void> {
    const current = liveByAccount.get(telegramUserId);
    if (live && live !== current) await live.disconnect().catch(() => undefined);
    if (current && current.companyId === companyId && (!live || current === live)) {
      await current.disconnect().catch(() => undefined);
      liveByAccount.delete(telegramUserId);
    }
  }

  async function discardOwnedSession(
    ctx: PluginContext,
    companyId: string,
    account: { telegramUserId: string; username: string | null; displayName: string },
    secretId: string,
  ): Promise<void> {
    const current = await findConnection(ctx, companyId, account.telegramUserId, liveAccountIds());
    if (!secretId || current?.sessionSecretId !== secretId) return;
    await deleteAccountSession(ctx, companyId, secretId);
    const confirmed = await findConnection(ctx, companyId, account.telegramUserId, liveAccountIds());
    if (confirmed?.sessionSecretId !== secretId) return;
    await upsertConnection(ctx, {
      companyId,
      account,
      sessionSecretId: "",
      sessionConfigPath: "",
      paused: true,
    });
  }

  function clearStoredSession(
    ctx: PluginContext,
    companyId: string,
    account: { telegramUserId: string; username: string | null; displayName: string },
    secretId: string,
  ): Promise<void> {
    return withAccountGate(companyId, account.telegramUserId, () => discardOwnedSession(ctx, companyId, account, secretId));
  }

  function emitLogin(companyId: string, status: LoginStatus) {
    const ctx = pluginContext;
    if (!ctx) return;
    const channel = `${LOGIN_STREAM_CHANNEL}:${companyId}`;
    ctx.streams.open(channel, companyId);
    ctx.streams.emit(channel, { companyId, status: publicLoginStatus(status) });
    if ("loginId" in status && status.loginId) {
      const privateChannel = `${channel}:${status.loginId}`;
      ctx.streams.open(privateChannel, companyId);
      ctx.streams.emit(privateChannel, { companyId, status });
    }
  }

  function pendingLoginExpired(pending: PendingLogin, now = Date.now()): boolean {
    return now - pending.startedAt >= PENDING_LOGIN_TTL_MS;
  }

  function loginStillCurrent(pending: PendingLogin): boolean {
    return !shuttingDown
      && !pending.cancelled
      && !pendingLoginExpired(pending)
      && pendingLogins.get(pending.loginId) === pending;
  }

  function settleLogin(pending: PendingLogin, status: LoginStatus) {
    if (pending.timer) clearTimeout(pending.timer);
    pendingLogins.delete(pending.loginId);
    loginResults.set(pending.loginId, { companyId: pending.companyId, status });
    void pending.handle.abort().catch(() => undefined);
    emitLogin(pending.companyId, status);
  }

  function expirePendingLogin(pending: PendingLogin) {
    if (pendingLogins.get(pending.loginId) !== pending) return;
    pending.cancelled = true;
    settleLogin(pending, reduceLogin(pending.status, {
      type: "error",
      loginId: pending.loginId,
      message: "Telegram login expired.",
    }));
  }

  function allowStartLogin(companyId: string, now = Date.now()): boolean {
    const recent = (startLoginHits.get(companyId) ?? []).filter((at) => now - at < START_LOGIN_WINDOW_MS);
    if (recent.length >= MAX_START_LOGINS_PER_WINDOW) {
      startLoginHits.set(companyId, recent);
      return false;
    }
    recent.push(now);
    startLoginHits.set(companyId, recent);
    return true;
  }

  function replaceCompanyLogin(companyId: string): void {
    for (const pending of [...pendingLogins.values()]) {
      if (pending.companyId !== companyId) continue;
      pending.cancelled = true;
      settleLogin(pending, reduceLogin(pending.status, { type: "cancel", loginId: pending.loginId }));
    }
  }

  async function storedSessionCurrent(
    ctx: PluginContext,
    companyId: string,
    telegramUserId: string,
    secretId: string,
    generation: number,
  ): Promise<boolean> {
    if (shuttingDown || !secretId || accountGeneration(companyId, telegramUserId) !== generation) return false;
    const current = await findConnection(ctx, companyId, telegramUserId, liveAccountIds());
    if (accountGeneration(companyId, telegramUserId) !== generation) return false;
    return current?.sessionSecretId === secretId;
  }

  async function handleInbound(message: Parameters<typeof ingestInboundMessage>[2]) {
    const ctx = pluginContext;
    if (!ctx || !message.companyId || shuttingDown) return;
    // The update loop still carries the invocation that connected the account.
    // That invocation is released when connect returns, so each message opens
    // its own company scope instead of reusing the expired one.
    const job = ctx.runInCompanyBackground(message.companyId, () => acceptInbound(ctx, message));
    inboundJobs.add(job);
    void job.finally(() => {
      inboundJobs.delete(job);
    });
    await job;
  }

  async function acceptInbound(ctx: PluginContext, message: Parameters<typeof ingestInboundMessage>[2]) {
    const log = wrapLogger(ctx);
    const connection = await findConnection(ctx, message.companyId, message.accountId, liveAccountIds());
    if (!connection) {
      log.warn("Dropped inbound Telegram message for an unknown account", {
        companyId: message.companyId,
        accountId: message.accountId,
      });
      return;
    }
    const peerKey = `${message.companyId}:${message.accountId}:${message.peerId}`;
    const shapeAllowed = inboundShapeAllowed(connection, message);
    const text = message.text.trim();
    const wantsMedia = message.attachments.length > 0 || Boolean(message.loadAttachments);
    let keepingText = false;
    if (shapeAllowed && text.length > 0) {
      const textRoom = await hasInboundBudget(ctx, connection, { messages: 1, attachments: 0, bytes: 0 });
      if (!textRoom || !takeInboundMessageSlot(peerKey)) {
        log.warn("Dropped inbound Telegram message over the peer quota", {
          companyId: message.companyId,
          accountId: message.accountId,
        });
        return;
      }
      keepingText = true;
    }
    let attachments = message.attachments;
    let skippedMedia = false;
    if (message.loadAttachments) {
      attachments = [];
      const mediaRoom = shapeAllowed
        && peekPeerMediaSlot(peerKey)
        && await hasInboundBudget(ctx, connection, {
          messages: 0,
          attachments: 1,
          bytes: 1,
        });
      if (mediaRoom && takePeerMediaSlot(peerKey)) {
        try {
          const downloaded = await message.loadAttachments();
          const kept = [];
          for (const file of downloaded) {
            if (file.byteLength > MAX_INBOUND_MEDIA_BYTES || file.bytes.byteLength > MAX_INBOUND_MEDIA_BYTES) {
              skippedMedia = true;
              continue;
            }
            if (!(await hasInboundBudget(ctx, connection, {
              messages: 0,
              attachments: 1,
              bytes: file.byteLength,
            }))) {
              skippedMedia = true;
              continue;
            }
            kept.push(file);
          }
          attachments = kept;
          if (downloaded.length > 0 && kept.length === 0) skippedMedia = true;
        } catch (error) {
          skippedMedia = true;
          log.warn("Skipped inbound Telegram media", {
            companyId: message.companyId,
            accountId: message.accountId,
            message: error instanceof Error ? error.message : "unknown error",
          });
        }
      } else if (shapeAllowed && wantsMedia) {
        skippedMedia = true;
      }
    } else if (shapeAllowed && attachments.length > 0) {
      const bytes = attachments.reduce((sum, file) => sum + file.byteLength, 0);
      const mediaRoom = await hasInboundBudget(ctx, connection, {
        messages: 0,
        attachments: attachments.length,
        bytes,
      });
      if (!mediaRoom) {
        attachments = [];
        skippedMedia = true;
      }
    }
    if (!keepingText && shapeAllowed && attachments.length > 0) {
      const room = await hasInboundBudget(ctx, connection, { messages: 1, attachments: 0, bytes: 0 });
      if (!room || !takeInboundMessageSlot(peerKey)) {
        log.warn("Dropped inbound Telegram message over the peer quota", {
          companyId: message.companyId,
          accountId: message.accountId,
        });
        return;
      }
    }
    if (shapeAllowed && !keepingText && attachments.length === 0) return;
    const outboundText = skippedMedia && keepingText
      ? `${text}\n\nInbound media was skipped because the storage quota was reached.`
      : message.text;
    try {
      await ingestInboundMessage(ctx, connection, { ...message, text: outboundText, attachments });
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

  function launchReconnect(ctx: PluginContext, companyId?: string): Promise<void> {
    if (shuttingDown) return Promise.resolve();
    const log = wrapLogger(ctx);
    const work = companyId
      ? ctx.runInCompanyBackground(companyId, () => reconnectCompany(ctx, companyId))
      : reconnectAll(ctx);
    const job = work.catch((error: unknown) => {
      log.error("Failed to reconnect Telegram accounts", {
        message: error instanceof Error ? error.message : "unknown error",
      });
    });
    reconnectJobs.add(job);
    void job.finally(() => {
      reconnectJobs.delete(job);
    });
    return job;
  }

  async function reconnectCompany(ctx: PluginContext, companyId: string) {
    if (shuttingDown) return;
    const log = wrapLogger(ctx);
    const connections = await listConnections(ctx, companyId, liveAccountIds());
    if (shuttingDown) return;
    for (const connection of connections) {
      if (shuttingDown) return;
      if (liveByAccount.has(connection.telegramUserId)) continue;
      if (!connection.sessionSecretId) continue;
      const secretId = connection.sessionSecretId;
      const generation = accountGeneration(companyId, connection.telegramUserId);
      const session = await getAccountSession(
        ctx,
        companyId,
        connection.sessionSecretId,
        connection.sessionConfigPath || `plugin-secret.${connection.sessionSecretId}`,
      );
      if (
        shuttingDown
        || !session
        || accountGeneration(companyId, connection.telegramUserId) !== generation
      ) continue;
      try {
        const credentials = await resolveCredentials(companyId);
        const live = await createClient.connectFromSession({
          companyId,
          credentials,
          session,
          onInbound: handleInbound,
        });
        if (!(await storedSessionCurrent(ctx, companyId, connection.telegramUserId, secretId, generation))) {
          await live.disconnect().catch(() => undefined);
          continue;
        }
        await attachLiveSession(companyId, live);
        if (!(await storedSessionCurrent(ctx, companyId, connection.telegramUserId, secretId, generation))) {
          await dropLive(companyId, connection.telegramUserId, live);
          continue;
        }
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
    if (shuttingDown) return;
    const companyIds = await listKnownCompanyIds(ctx);
    for (const companyId of companyIds) {
      if (shuttingDown) return;
      await ctx.runInCompanyBackground(companyId, () => reconnectCompany(ctx, companyId));
    }
  }

  const plugin = definePlugin({
    multiCompanyConfig: true,
    async setup(ctx) {
      pluginContext = ctx;
      const log = wrapLogger(ctx);
      log.info("Telegram plugin setup");

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
          const settled = loginResults.get(loginId);
          if (settled && settled.companyId === companyId) return settled.status;
          return idleLoginStatus();
        }
        const pending = [...pendingLogins.values()].find((entry) => entry.companyId === companyId);
        if (pending) return publicLoginStatus(pending.status);
        const settled = [...loginResults.values()].reverse().find((entry) => entry.companyId === companyId);
        return publicLoginStatus(settled?.status ?? idleLoginStatus());
      });

      ctx.actions.register(ACTION_START_LOGIN, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        assertConnectionManager(actionCtx.actor, companyId);
        if (!allowStartLogin(companyId)) {
          throw new Error("Too many Telegram login attempts. Wait a minute and try again.");
        }
        replaceCompanyLogin(companyId);
        const credentials = await resolveCredentials(companyId);
        const loginId = randomUUID();
        let resolveFinished: () => void = () => undefined;
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
          cancelled: false,
          startedAt: Date.now(),
          finished: new Promise<void>((resolve) => {
            resolveFinished = resolve;
          }),
        };
        pending.timer = setTimeout(() => expirePendingLogin(pending), PENDING_LOGIN_TTL_MS);
        if (pending.timer.unref) pending.timer.unref();
        pendingLogins.set(loginId, pending);
        emitLogin(companyId, pending.status);
        let finished: Promise<void> = Promise.resolve();
        finished = ctx.runInCompanyBackground(companyId, async () => {
          let storedSecretId = "";
          let savedAccount: { telegramUserId: string; username: string | null; displayName: string } | null = null;
          try {
            if (!loginStillCurrent(pending)) return;
            const handle = await createClient.startQrLogin({
              credentials,
              onQr: (qr) => {
                if (!loginStillCurrent(pending)) return;
                pending.status = reduceLogin(pending.status, { type: "qr", loginId, qr });
                emitLogin(companyId, pending.status);
              },
              onPasswordRequired: (hint) => {
                if (!loginStillCurrent(pending)) return;
                pending.status = reduceLogin(pending.status, { type: "password_required", loginId, hint });
                emitLogin(companyId, pending.status);
              },
            });
            pending.handle = handle;
            if (!loginStillCurrent(pending)) {
              await handle.abort().catch(() => undefined);
              return;
            }
            const signedIn = await handle.waitUntilSignedIn();
            if (!loginStillCurrent(pending)) return;
            const generation = accountGeneration(companyId, signedIn.account.telegramUserId);
            let replacedSecretId = "";
            const kept = await withAccountGate(companyId, signedIn.account.telegramUserId, async () => {
              const existing = await findConnection(ctx, companyId, signedIn.account.telegramUserId, liveAccountIds());
              const stored = await putAccountSession(ctx, companyId, signedIn.session);
              storedSecretId = stored.secretId;
              savedAccount = signedIn.account;
              if (!loginStillCurrent(pending) || accountGeneration(companyId, signedIn.account.telegramUserId) !== generation) {
                await discardOwnedSession(ctx, companyId, signedIn.account, stored.secretId);
                return false;
              }
              await upsertConnection(ctx, {
                companyId,
                account: signedIn.account,
                sessionSecretId: stored.secretId,
                sessionConfigPath: stored.configPath,
              });
              if (
                existing?.sessionSecretId
                && existing.sessionSecretId !== stored.secretId
              ) {
                replacedSecretId = existing.sessionSecretId;
              }
              if (!loginStillCurrent(pending) || accountGeneration(companyId, signedIn.account.telegramUserId) !== generation) {
                await discardOwnedSession(ctx, companyId, signedIn.account, stored.secretId);
                return false;
              }
              return true;
            });
            if (!kept || !loginStillCurrent(pending)) return;
            const live = await createClient.connectFromSession({
              companyId,
              credentials,
              session: signedIn.session,
              onInbound: handleInbound,
            });
            if (
              !loginStillCurrent(pending)
              || !(await storedSessionCurrent(ctx, companyId, signedIn.account.telegramUserId, storedSecretId, generation))
            ) {
              await live.disconnect().catch(() => undefined);
              await clearStoredSession(ctx, companyId, signedIn.account, storedSecretId);
              return;
            }
            await attachLiveSession(companyId, live);
            if (
              !loginStillCurrent(pending)
              || !(await storedSessionCurrent(ctx, companyId, signedIn.account.telegramUserId, storedSecretId, generation))
            ) {
              await dropLive(companyId, signedIn.account.telegramUserId, live);
              await clearStoredSession(ctx, companyId, signedIn.account, storedSecretId);
              return;
            }
            if (replacedSecretId) {
              const supersededSecretId = replacedSecretId;
              await withAccountGate(companyId, signedIn.account.telegramUserId, async () => {
                const current = await findConnection(ctx, companyId, signedIn.account.telegramUserId, liveAccountIds());
                if (current?.sessionSecretId !== storedSecretId) return;
                await deleteAccountSession(ctx, companyId, supersededSecretId);
              });
            }
            settleLogin(pending, reduceLogin(pending.status, {
              type: "connected",
              loginId,
              account: signedIn.account,
            }));
            log.info("Telegram account connected", {
              companyId,
              telegramUserId: signedIn.account.telegramUserId,
            });
          } catch (error) {
            if (savedAccount && storedSecretId && !loginStillCurrent(pending)) {
              await clearStoredSession(ctx, companyId, savedAccount, storedSecretId).catch(() => undefined);
              return;
            }
            if (!loginStillCurrent(pending)) return;
            settleLogin(pending, reduceLogin(pending.status, {
              type: "error",
              loginId,
              message: error instanceof Error ? error.message : "Telegram login failed.",
            }));
          }
        }).catch((error: unknown) => {
          if (!loginStillCurrent(pending)) return;
          settleLogin(pending, reduceLogin(pending.status, {
            type: "error",
            loginId,
            message: error instanceof Error ? error.message : "Telegram login failed.",
          }));
        }).finally(() => {
          loginJobs.delete(finished);
          resolveFinished();
        });
        loginJobs.add(finished);
        pending.finished = finished;
        return { loginId, status: pending.status };
      });

      ctx.actions.register(ACTION_SUBMIT_PASSWORD, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        assertConnectionManager(actionCtx.actor, companyId);
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
        assertConnectionManager(actionCtx.actor, companyId);
        const loginId = readString(params.loginId);
        const pending = pendingLogins.get(loginId);
        if (!pending || pending.companyId !== companyId) return { status: idleLoginStatus() };
        pending.cancelled = true;
        await pending.handle.abort().catch(() => undefined);
        await pending.finished.catch(() => undefined);
        if (pendingLogins.get(loginId) === pending) pendingLogins.delete(loginId);
        const status = loginResults.get(loginId)?.status ?? reduceLogin(pending.status, { type: "cancel", loginId });
        loginResults.set(loginId, { companyId, status });
        emitLogin(companyId, status);
        return { status };
      });

      ctx.actions.register(ACTION_UPDATE_CONNECTION, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        assertConnectionManager(actionCtx.actor, companyId);
        const telegramUserId = readString(params.telegramUserId);
        const patch: TelegramConnectionPatch = {};
        if (params.assignedAgentId === null) patch.assignedAgentId = null;
        else if (readString(params.assignedAgentId)) patch.assignedAgentId = readString(params.assignedAgentId);
        if (typeof params.acceptUnlistedSenders === "boolean") {
          patch.acceptUnlistedSenders = params.acceptUnlistedSenders;
        }
        if (Array.isArray(params.allowedPeerIds)) {
          patch.allowedPeerIds = normalizeAllowedPeerIds(params.allowedPeerIds);
        }
        const connection = await patchConnection(ctx, companyId, telegramUserId, patch, liveAccountIds());
        return publicConnection(connection);
      });

      ctx.actions.register(ACTION_SET_PAUSED, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        assertConnectionManager(actionCtx.actor, companyId);
        const telegramUserId = readString(params.telegramUserId);
        const paused = Boolean(params.paused);
        const connection = await patchConnection(ctx, companyId, telegramUserId, { paused }, liveAccountIds());
        return publicConnection(connection);
      });

      ctx.actions.register(ACTION_DISCONNECT, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        assertConnectionManager(actionCtx.actor, companyId);
        const telegramUserId = readString(params.telegramUserId);
        const connection = await findConnection(ctx, companyId, telegramUserId, liveAccountIds());
        if (!connection) return { disconnected: false };
        bumpAccountGeneration(companyId, telegramUserId);
        await dropLive(companyId, telegramUserId);
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
          sessionConfigPath: "",
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
            required: ["text", "issueId"],
          },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const payload = (params ?? {}) as {
            text?: string;
            accountId?: string;
            peerId?: string;
            issueId?: string;
          };
          if (!payload.issueId) return { error: "A Telegram task is required." };
          const connections = await listConnections(ctx, runCtx.companyId, liveAccountIds());
          const issue = await ctx.issues.get(payload.issueId, runCtx.companyId);
          if (!issue || issue.originKind !== DIALOG_ORIGIN_KIND || !issue.originId) {
            return { error: "This issue is not a Telegram dialog." };
          }
          const authorized = authorizeSendText(connections, {
            companyId: runCtx.companyId,
            agentId: runCtx.agentId,
            accountId: payload.accountId,
            peerId: payload.peerId,
            issueOriginId: issue.originId,
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

      void launchReconnect(ctx);
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
      await launchReconnect(pluginContext, context?.companyId || undefined);
    },

    async onIdleDrain() {
      for (const pending of [...pendingLogins.values()]) {
        if (pendingLoginExpired(pending)) expirePendingLogin(pending);
      }
      if (reconnectJobs.size > 0 || loginJobs.size > 0 || inboundJobs.size > 0 || liveByAccount.size > 0 || pendingLogins.size > 0) return "present";
      return "none";
    },

    async onShutdown() {
      shuttingDown = true;
      await Promise.all([...inboundJobs].map((job) => job.catch(() => undefined)));
      await Promise.all([...reconnectJobs].map((job) => job.catch(() => undefined)));
      for (const pending of pendingLogins.values()) {
        pending.cancelled = true;
        if (pending.timer) clearTimeout(pending.timer);
        await pending.handle.abort().catch(() => undefined);
      }
      await Promise.all([...loginJobs].map((job) => job.catch(() => undefined)));
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
