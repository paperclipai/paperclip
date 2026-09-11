import { createHash } from "node:crypto";
import type { ModalElement, ModalResponse } from "chat";
import type {
  ChatSdkStatePersistence,
  ChatSdkStateScope,
} from "./chat-sdk-state.js";

const CORRECTION_TTL_MS = 10 * 60 * 1000;
const MAX_CAS_ATTEMPTS = 8;

/** Internal service response, never parsed from provider JSON. A modal-submit
 * cannot open a modal: this authorizes only a private error + reopen button. */
export interface DiscordModalCorrectionResponse {
  action: "errors";
  errors: Record<string, string>;
  paperclipDiscordCorrection: {
    version: 1;
    actionId: string;
    message: string;
  };
}

export interface DiscordQuestionFormDraftOwner {
  principalId: string;
  userId: string;
  externalUserId: string;
}

export interface DiscordQuestionFormCorrectionDraft extends DiscordQuestionFormDraftOwner {
  version: 1;
  conversationId: string;
  publicationId: string;
  providerMessageId: string;
  threadId: string;
  interactionId: string;
  openActionId: string;
  submitActionId: string;
  expiresAt: string;
  values: Record<string, string>;
}

const token = (value: unknown, prefix: string, length = 22): value is string =>
  typeof value === "string" &&
  new RegExp(`^${prefix}[A-Za-z0-9_-]{${length}}$`).test(value);

export function isDiscordQuestionFormCorrectionId(
  value: unknown,
): value is string {
  return token(value, "pcfr:", 43);
}

function correctionId(
  scope: ChatSdkStateScope,
  owner: DiscordQuestionFormDraftOwner,
  submitActionId: string,
) {
  if (!token(submitActionId, "pcfs:"))
    throw new Error("Invalid Discord form token");
  // Includes the high-entropy secret submit token, not merely public IDs. One
  // overwritable row per form+actor bounds retry storage without persisting a
  // Discord interaction token or raw callback envelope.
  return `pcfr:${createHash("sha256")
    .update(
      JSON.stringify([
        scope.companyId,
        scope.endpointId,
        submitActionId,
        owner.principalId,
        owner.userId,
        owner.externalUserId,
      ]),
    )
    .digest("base64url")}`;
}

function validDraft(
  value: unknown,
): value is DiscordQuestionFormCorrectionDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !==
    "conversationId,expiresAt,externalUserId,interactionId,openActionId,principalId,providerMessageId,publicationId,submitActionId,threadId,userId,values,version"
  )
    return false;
  if (
    row.version !== 1 ||
    !token(row.openActionId, "pcf:") ||
    !token(row.submitActionId, "pcfs:")
  )
    return false;
  if (
    ![
      row.conversationId,
      row.publicationId,
      row.providerMessageId,
      row.threadId,
      row.interactionId,
      row.principalId,
      row.userId,
      row.externalUserId,
    ].every(
      (field) =>
        typeof field === "string" && field.length > 0 && field.length <= 512,
    )
  )
    return false;
  if (
    typeof row.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(row.expiresAt))
  )
    return false;
  if (
    !row.values ||
    typeof row.values !== "object" ||
    Array.isArray(row.values)
  )
    return false;
  const entries = Object.entries(row.values);
  return (
    entries.length <= 5 &&
    entries.every(
      ([field, value]) =>
        token(field, "pcff:") &&
        typeof value === "string" &&
        value.length <= 4000,
    )
  );
}

function stateKey(actionId: string) {
  return `discord-question-correction:${actionId}`;
}

export async function retainDiscordQuestionFormCorrection(
  persistence: ChatSdkStatePersistence,
  scope: ChatSdkStateScope,
  input: Omit<
    DiscordQuestionFormCorrectionDraft,
    "version" | "expiresAt" | "values"
  > & {
    parentExpiresAt: string;
    modal: ModalElement;
    fieldErrors: Record<string, string>;
    values: Record<string, string>;
  },
  now = new Date(),
): Promise<DiscordModalCorrectionResponse> {
  const expiresAt = new Date(
    Math.min(
      Date.parse(input.parentExpiresAt),
      now.getTime() + CORRECTION_TTL_MS,
    ),
  );
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now ||
    input.modal.callbackId !== input.submitActionId ||
    input.modal.privateMetadata !== input.submitActionId ||
    input.modal.children.length < 1 ||
    input.modal.children.length > 5
  )
    throw new Error("Discord form correction is not current");
  const values: Record<string, string> = {};
  const messages: string[] = [
    "Please check your answers, then select Edit answers.",
  ];
  for (const child of input.modal.children) {
    if (child.type !== "text_input" && child.type !== "select")
      throw new Error("Unsupported Discord correction field");
    const value = input.values[child.id];
    const error = input.fieldErrors[child.id];
    // Both label and error are produced by canonical form validation, never
    // provider labels/error bodies. Opaque input IDs are not visible copy.
    if (error) messages.push(`${child.label}: ${error}`);
    if (typeof value !== "string") continue;
    if (child.type === "text_input") {
      const maximum = Math.min(child.maxLength ?? 4000, 4000);
      values[child.id] = value.slice(0, maximum);
      if (value.length > maximum)
        messages.push(
          `${child.label}: This draft was shortened to ${maximum} characters.`,
        );
    } else if (child.options.some((option) => option.value === value))
      values[child.id] = value;
  }
  const {
    modal: _modal,
    values: _values,
    fieldErrors: _errors,
    parentExpiresAt: _expiry,
    ...binding
  } = input;
  const draft: DiscordQuestionFormCorrectionDraft = {
    ...binding,
    version: 1,
    expiresAt: expiresAt.toISOString(),
    values,
  };
  if (!validDraft(draft)) throw new Error("Invalid Discord correction binding");
  const actionId = correctionId(scope, input, input.submitActionId);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const prior = await persistence.read(scope, stateKey(actionId));
    if (
      await persistence.compareAndSet({
        ...scope,
        key: stateKey(actionId),
        expectedVersion: prior?.version ?? null,
        value: draft,
        expiresAt,
      })
    ) {
      return {
        action: "errors",
        errors: input.fieldErrors,
        paperclipDiscordCorrection: {
          version: 1,
          actionId,
          message: messages.join("\n").slice(0, 1500),
        },
      };
    }
  }
  throw new Error("Discord correction draft ownership changed");
}

export async function loadDiscordQuestionFormCorrection(
  persistence: ChatSdkStatePersistence,
  scope: ChatSdkStateScope,
  actionId: string,
  owner: DiscordQuestionFormDraftOwner,
  threadId: string,
  now = new Date(),
): Promise<DiscordQuestionFormCorrectionDraft | null> {
  if (!isDiscordQuestionFormCorrectionId(actionId)) return null;
  const prior = await persistence.read(scope, stateKey(actionId));
  if (!prior) return null;
  const value = prior.value;
  if (
    !validDraft(value) ||
    !prior.expiresAt ||
    prior.expiresAt.getTime() !== Date.parse(value.expiresAt)
  )
    return null;
  if (prior.expiresAt <= now) {
    await persistence.deleteIfVersion({
      ...scope,
      key: stateKey(actionId),
      expectedVersion: prior.version,
    });
    return null;
  }
  if (
    value.principalId !== owner.principalId ||
    value.userId !== owner.userId ||
    value.externalUserId !== owner.externalUserId ||
    value.threadId !== threadId ||
    correctionId(scope, value, value.submitActionId) !== actionId
  )
    return null;
  return value;
}

export async function deleteDiscordQuestionFormCorrection(
  persistence: ChatSdkStatePersistence,
  scope: ChatSdkStateScope,
  owner: DiscordQuestionFormDraftOwner,
  submitActionId: string,
) {
  const key = stateKey(correctionId(scope, owner, submitActionId));
  const prior = await persistence.read(scope, key);
  if (prior)
    await persistence.deleteIfVersion({
      ...scope,
      key,
      expectedVersion: prior.version,
    });
}

/** Current Gateway route, independent of consumed SDK modal context. */
export function discordQuestionFormThreadId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const guild = value.guild_id;
  const channelId = value.channel_id;
  const channel = value.channel as
    { id?: unknown; type?: unknown; parent_id?: unknown } | undefined;
  const snowflake = (value: unknown): value is string =>
    typeof value === "string" && /^\d{17,20}$/.test(value);
  if (
    (guild !== "@me" && !snowflake(guild)) ||
    !snowflake(channelId) ||
    !channel ||
    channel.id !== channelId
  )
    return null;
  if (channel.type === 11 || channel.type === 12)
    return snowflake(channel.parent_id)
      ? `discord:${guild}:${channel.parent_id}:${channelId}`
      : null;
  return `discord:${guild}:${channelId}`;
}

export function discordQuestionFormCorrectionModal(
  modal: ModalElement,
  draft: DiscordQuestionFormCorrectionDraft,
): ModalElement | null {
  if (
    modal.callbackId !== draft.submitActionId ||
    modal.privateMetadata !== draft.submitActionId
  )
    return null;
  return {
    ...modal,
    children: modal.children.map((child) => {
      if (child.type === "text_input")
        return { ...child, initialValue: draft.values[child.id] ?? "" };
      if (child.type === "select") {
        const value = draft.values[child.id];
        return {
          ...child,
          ...(child.options.some((option) => option.value === value)
            ? { initialOption: value }
            : {}),
        };
      }
      return child;
    }),
  };
}

export const discordQuestionFormDenialResponse = (): ModalResponse => ({
  action: "errors",
  errors: {
    form: "This form is no longer authorized. Open the linked Paperclip task.",
  },
});
