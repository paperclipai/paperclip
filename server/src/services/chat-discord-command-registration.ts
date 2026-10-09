import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { DiscordBotIdentity } from "./chat-discord.js";

// https://docs.discord.com/developers/interactions/application-commands
// Global commands are required for BOT_DM. Never bulk overwrite an app's
// command set, and never request user-install/private-channel contexts.
const snowflake = z.string().regex(/^[1-9][0-9]{16,19}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ownerId = z.string().regex(/^[a-f0-9]{32}$/);
const scopeSchema = z
  .object({
    companyId: z.uuid(),
    endpointId: z.uuid(),
    applicationId: snowflake,
    guildId: snowflake,
  })
  .strict();
const fenceSchema = z
  .object({
    generation: z.number().int().min(0).max(2_147_483_647),
    credentialFingerprint: digest,
  })
  .strict();
const common = {
  schema: z.literal("paperclip.discord.command-registration.v1"),
  scope: scopeSchema,
  ownerId,
};
const attemptSchema = z
  .object({
    operation: z.enum(["create", "update"]),
    commandId: snowflake.nullable(),
    definitionDigest: digest,
    runtimeFence: fenceSchema,
  })
  .strict()
  .refine((a) => (a.operation === "create") === (a.commandId === null));
const stateSchema = z.discriminatedUnion("phase", [
  z.object({ ...common, phase: z.literal("prepared") }).strict(),
  z
    .object({
      ...common,
      phase: z.literal("attempted"),
      attempt: attemptSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      phase: z.literal("registered"),
      receipt: z
        .object({
          commandId: snowflake,
          version: snowflake,
          definitionDigest: digest,
        })
        .strict(),
    })
    .strict(),
]);
export type DiscordCommandRegistrationScope = z.infer<typeof scopeSchema>;
export type DiscordCommandRegistrationFence = z.infer<typeof fenceSchema>;
export type DiscordCommandRegistration = z.infer<typeof stateSchema>;
export type DiscordCommandRegistrationStage =
  "before_read" | "before_intent" | "before_write" | "before_receipt";
export type DiscordCommandRegistrationResult =
  | {
      kind: "registered";
      state: Extract<DiscordCommandRegistration, { phase: "registered" }>;
    }
  | {
      kind: "conflict";
      reason: "unowned_namespace" | "owned_command_changed" | "command_limit";
    }
  | {
      kind: "unknown";
      state: Extract<DiscordCommandRegistration, { phase: "attempted" }>;
      retryAfterSeconds?: number;
    }
  | {
      kind: "unavailable";
      reason: "request_failed" | "invalid_response";
      retryAfterSeconds?: number;
    };

function freezeState(
  state: DiscordCommandRegistration,
): DiscordCommandRegistration {
  Object.freeze(state.scope);
  if (state.phase === "attempted") {
    Object.freeze(state.attempt.runtimeFence);
    Object.freeze(state.attempt);
  }
  if (state.phase === "registered") Object.freeze(state.receipt);
  return Object.freeze(state);
}

/** The public marker is an identifier, never a credential or standalone proof. */
export function discordPaperclipCommandDefinition(publicOwnerId: string) {
  if (!ownerId.safeParse(publicOwnerId).success)
    throw new Error("Invalid Discord command owner identifier");
  return {
    type: 1,
    name: "paperclip",
    description: `Paperclip session controls [pc:${publicOwnerId}]`,
    options: [
      {
        type: 1,
        name: "status",
        description: "Show the current Paperclip task",
      },
      {
        type: 1,
        name: "new",
        description: "Start a new task in a DM or show new-thread guidance",
      },
      {
        type: 1,
        name: "close",
        description: "Close the current chat conversation",
      },
    ],
    default_member_permissions: null,
    integration_types: [0],
    contexts: [0, 1],
    nsfw: false,
  };
}

// One explicitly shipped prior definition. This is maintenance evidence only:
// it never enables command handling before a current definition is confirmed.
function priorCloseCopyDefinition(id: string) {
  const definition = discordPaperclipCommandDefinition(id);
  definition.options[2]!.description = "Close the current Paperclip task";
  return definition;
}

function definitionDigest(id: string, priorCloseCopy = false): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        priorCloseCopy
          ? priorCloseCopyDefinition(id)
          : discordPaperclipCommandDefinition(id),
      ),
    )
    .digest("hex");
}

/** Persist this prepared descriptor before calling reconcile; its CAS must
 * require that durable row. Do not mint a new owner to bypass a conflict. */
export function createDiscordCommandRegistration(
  scope: DiscordCommandRegistrationScope,
): DiscordCommandRegistration {
  const parsed = scopeSchema.safeParse(scope);
  if (!parsed.success)
    throw new Error("Invalid Discord command registration scope");
  return freezeState({
    schema: "paperclip.discord.command-registration.v1",
    scope: parsed.data,
    ownerId: randomBytes(16).toString("hex"),
    phase: "prepared",
  });
}

export function parseDiscordCommandRegistration(
  input: unknown,
  scope: DiscordCommandRegistrationScope,
  /** Maintenance only; prior attempted writes and arbitrary digests stay closed. */
  allowKnownPriorDefinition = false,
): DiscordCommandRegistration | null {
  const expected = scopeSchema.safeParse(scope);
  const parsed = stateSchema.safeParse(input);
  if (!expected.success || !parsed.success) return null;
  for (const key of Object.keys(
    expected.data,
  ) as (keyof DiscordCommandRegistrationScope)[]) {
    if (expected.data[key] !== parsed.data.scope[key]) return null;
  }
  const state = parsed.data;
  const storedDigest =
    state.phase === "attempted"
      ? state.attempt.definitionDigest
      : state.phase === "registered"
        ? state.receipt.definitionDigest
        : null;
  return storedDigest === null ||
    storedDigest === definitionDigest(state.ownerId) ||
    (allowKnownPriorDefinition &&
      state.phase === "registered" &&
      storedDigest === definitionDigest(state.ownerId, true))
    ? freezeState(state)
    : null;
}

export type ReconcileDiscordCommandRegistrationOptions = {
  state: unknown;
  scope: DiscordCommandRegistrationScope;
  verifiedIdentity: Pick<
    DiscordBotIdentity,
    "botExternalId" | "providerAccountId"
  >;
  runtimeFence: DiscordCommandRegistrationFence;
  botToken: string;
  fetch: typeof globalThis.fetch;
  /** Recheck the exact current app/endpoint/credential lease. No DB row locks
   * may remain held during HTTP. A local lease cannot fence an external admin. */
  authorize(stage: DiscordCommandRegistrationStage): Promise<void>;
  /** Durable compare-and-swap of the EXACT previous descriptor. Throw on any
   * conflict or unknown durability; never publish success from memory alone. */
  commit(
    expected: DiscordCommandRegistration,
    next: DiscordCommandRegistration,
  ): Promise<void>;
  requestTimeoutMs?: number;
};

const remoteCommandSchema = z
  .object({
    id: snowflake,
    application_id: snowflake,
    version: snowflake,
    type: z.number().int().min(1).max(4),
    name: z.string().min(1).max(32),
    description: z.string().max(100),
  })
  .passthrough();
type RemoteCommand = z.infer<typeof remoteCommandSchema>;
const emptyLocalizations = z
  .union([z.null(), z.object({}).strict()])
  .optional();
const optionSchema = z
  .object({
    type: z.literal(1),
    name: z.string().min(1).max(32),
    description: z.string().min(1).max(100),
    name_localizations: emptyLocalizations,
    description_localizations: emptyLocalizations,
    options: z.array(z.never()).max(0).optional(),
    required: z.literal(false).optional(),
  })
  .strict();

function exactDefinition(
  command: RemoteCommand,
  id: string,
  priorCloseCopy = false,
): boolean {
  const options = z.array(optionSchema).length(3).safeParse(command.options);
  if (
    !options.success ||
    command.guild_id !== undefined ||
    !emptyLocalizations.safeParse(command.name_localizations).success ||
    !emptyLocalizations.safeParse(command.description_localizations).success
  )
    return false;
  const normalized = {
    type: command.type,
    name: command.name,
    description: command.description,
    options: options.data.map(({ type, name, description }) => ({
      type,
      name,
      description,
    })),
    default_member_permissions: command.default_member_permissions ?? null,
    integration_types: command.integration_types,
    contexts: command.contexts,
    nsfw: command.nsfw ?? false,
  };
  return (
    JSON.stringify(normalized) ===
    JSON.stringify(
      priorCloseCopy
        ? priorCloseCopyDefinition(id)
        : discordPaperclipCommandDefinition(id),
    )
  );
}

function markedOwner(
  command: RemoteCommand,
  state: DiscordCommandRegistration,
): boolean {
  return (
    command.type === 1 &&
    command.name === "paperclip" &&
    command.application_id === state.scope.applicationId &&
    command.guild_id === undefined &&
    command.description.endsWith(`[pc:${state.ownerId}]`)
  );
}

class RequestFailure extends Error {
  constructor(
    readonly reason: "request_failed" | "invalid_response",
    readonly retryAfterSeconds?: number,
  ) {
    super(`Discord command registration ${reason}`);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new RequestFailure("request_failed"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function request(
  input: ReconcileDiscordCommandRegistrationOptions,
  method: "GET" | "POST" | "PATCH",
  commandId?: string,
): Promise<unknown> {
  const timeoutMs = input.requestTimeoutMs ?? 25_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25_000)
    throw new RequestFailure("invalid_response");
  const signal = AbortSignal.timeout(timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await abortable(
      input.fetch(
        `https://discord.com/api/v10/applications/${input.scope.applicationId}/commands${commandId ? `/${commandId}` : ""}`,
        {
          method,
          signal,
          redirect: "error",
          headers: {
            authorization: `Bot ${input.botToken}`,
            ...(method === "GET" ? {} : { "content-type": "application/json" }),
          },
          ...(method === "GET"
            ? {}
            : {
                body: JSON.stringify(
                  discordPaperclipCommandDefinition(
                    (input.state as DiscordCommandRegistration).ownerId,
                  ),
                ),
              }),
        },
      ),
      signal,
    );
    if (
      !response.body ||
      response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      throw new RequestFailure("invalid_response");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      // A full global list can contain 100 chat commands, 15 user commands,
      // 15 message commands and one entry-point command. Bound raw bytes too.
      if (length > 2 * 1024 * 1024)
        throw new RequestFailure("invalid_response");
      chunks.push(chunk.value);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RequestFailure("invalid_response");
    }
    if (!response.ok) {
      const value =
        body && typeof body === "object"
          ? (body as { retry_after?: unknown }).retry_after
          : undefined;
      const retry =
        response.status === 429 &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER
          ? value
          : undefined;
      throw new RequestFailure("request_failed", retry);
    }
    return body;
  } catch (error) {
    throw error instanceof RequestFailure
      ? error
      : new RequestFailure("request_failed");
  } finally {
    void reader?.cancel().catch(() => undefined);
  }
}

/**
 * Requires a current verified bot identity and caller-owned, app-scoped lease.
 * Discord POST is an UPSERT, not create-if-absent. The preflight GET prevents
 * known collisions but cannot fence a concurrent external administrator.
 * The public marker plus the independently persisted descriptor establishes
 * reconciliation identity; the marker alone never grants command ownership.
 * Unknown writes remain attempted until GET shows the exact expected command.
 * An absent command after timeout is NOT proof that the POST never committed.
 */
export async function reconcileDiscordCommandRegistration(
  input: ReconcileDiscordCommandRegistrationOptions,
): Promise<DiscordCommandRegistrationResult> {
  let state = parseDiscordCommandRegistration(input.state, input.scope, true);
  const runtimeFence = fenceSchema.safeParse(input.runtimeFence);
  if (
    !state ||
    !runtimeFence.success ||
    input.verifiedIdentity.botExternalId !== input.scope.applicationId ||
    input.verifiedIdentity.providerAccountId !== input.scope.guildId ||
    !input.botToken ||
    input.botToken.length > 4096 ||
    /[\r\n]/.test(input.botToken)
  ) {
    throw new Error("Invalid Discord command registration authority");
  }
  // The caller may retain its options while an authorization hook is held.
  // Snapshot the validated identity, credential and HTTP function before await.
  input = {
    ...input,
    scope: state.scope,
    state,
    runtimeFence: Object.freeze(runtimeFence.data),
    verifiedIdentity: Object.freeze({ ...input.verifiedIdentity }),
  };
  const authorize = async (stage: DiscordCommandRegistrationStage) => {
    try {
      await input.authorize(stage);
    } catch {
      throw new Error("Discord command registration authorization denied");
    }
  };
  const persist = async (next: DiscordCommandRegistration) => {
    freezeState(next);
    try {
      await input.commit(state!, next);
    } catch {
      throw new Error("Discord command registration persistence unproven");
    }
    state = next;
  };
  const settle = async (
    command: RemoteCommand,
  ): Promise<DiscordCommandRegistrationResult> => {
    const next: Extract<DiscordCommandRegistration, { phase: "registered" }> = {
      schema: state!.schema,
      scope: state!.scope,
      ownerId: state!.ownerId,
      phase: "registered",
      receipt: {
        commandId: command.id,
        version: command.version,
        definitionDigest: definitionDigest(state!.ownerId),
      },
    };
    freezeState(next);
    await authorize("before_receipt");
    if (JSON.stringify(state) !== JSON.stringify(next)) await persist(next);
    return { kind: "registered", state: next };
  };
  await authorize("before_read");
  let commands: RemoteCommand[];
  try {
    const parsed = z
      .array(remoteCommandSchema)
      .max(131)
      .safeParse(await request({ ...input, state }, "GET"));
    if (
      !parsed.success ||
      parsed.data.some(
        (command) =>
          command.application_id !== input.scope.applicationId ||
          command.guild_id !== undefined,
      ) ||
      new Set(parsed.data.map((command) => command.id)).size !==
        parsed.data.length
    )
      throw new RequestFailure("invalid_response");
    commands = parsed.data;
  } catch (error) {
    const failure =
      error instanceof RequestFailure
        ? error
        : new RequestFailure("invalid_response");
    return state.phase === "attempted"
      ? {
          kind: "unknown",
          state,
          ...(failure.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: failure.retryAfterSeconds }),
        }
      : {
          kind: "unavailable",
          reason: failure.reason,
          ...(failure.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: failure.retryAfterSeconds }),
        };
  }
  const namespace = commands.filter(
    (command) => command.type === 1 && command.name === "paperclip",
  );
  if (namespace.length > 1)
    return { kind: "unavailable", reason: "invalid_response" };
  const existing = namespace[0];
  if (state.phase === "attempted") {
    if (!existing) return { kind: "unknown", state };
    if (
      !markedOwner(existing, state) ||
      (state.attempt.commandId !== null &&
        state.attempt.commandId !== existing.id)
    ) {
      return { kind: "conflict", reason: "unowned_namespace" };
    }
    return exactDefinition(existing, state.ownerId)
      ? settle(existing)
      : { kind: "unknown", state };
  }
  if (state.phase === "prepared" && existing)
    return { kind: "conflict", reason: "unowned_namespace" };
  if (state.phase === "registered") {
    if (
      !existing ||
      existing.id !== state.receipt.commandId ||
      !markedOwner(existing, state)
    ) {
      return { kind: "conflict", reason: "owned_command_changed" };
    }
    if (exactDefinition(existing, state.ownerId)) return settle(existing);
    if (
      state.receipt.definitionDigest !== definitionDigest(state.ownerId) &&
      (existing.version !== state.receipt.version ||
        !exactDefinition(existing, state.ownerId, true))
    ) {
      // A software copy migration must not overwrite an operator's intervening
      // remote edit. Require the exact prior receipt and complete prior shape.
      return { kind: "conflict", reason: "owned_command_changed" };
    }
  } else if (commands.filter((command) => command.type === 1).length >= 100) {
    return { kind: "conflict", reason: "command_limit" };
  }
  const attempted: Extract<DiscordCommandRegistration, { phase: "attempted" }> =
    {
      schema: state.schema,
      scope: state.scope,
      ownerId: state.ownerId,
      phase: "attempted",
      attempt: {
        operation: state.phase === "prepared" ? "create" : "update",
        commandId: state.phase === "prepared" ? null : state.receipt.commandId,
        definitionDigest: definitionDigest(state.ownerId),
        runtimeFence: runtimeFence.data,
      },
    };
  await authorize("before_intent");
  await persist(attempted);
  await authorize("before_write");
  let command: RemoteCommand;
  try {
    const parsed = remoteCommandSchema.safeParse(
      await request(
        { ...input, state: attempted },
        attempted.attempt.operation === "create" ? "POST" : "PATCH",
        attempted.attempt.commandId ?? undefined,
      ),
    );
    if (
      !parsed.success ||
      !markedOwner(parsed.data, attempted) ||
      !exactDefinition(parsed.data, attempted.ownerId) ||
      (attempted.attempt.commandId !== null &&
        parsed.data.id !== attempted.attempt.commandId)
    )
      throw new RequestFailure("invalid_response");
    command = parsed.data;
  } catch (error) {
    const failure =
      error instanceof RequestFailure
        ? error
        : new RequestFailure("request_failed");
    return {
      kind: "unknown",
      state: attempted,
      ...(failure.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: failure.retryAfterSeconds }),
    };
  }
  return settle(command);
}
