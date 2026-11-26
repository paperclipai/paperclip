import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";
import { getSecretProvider } from "../secrets/provider-registry.js";

// Protocol building blocks only: no publication worker or runtime registration
// is enabled here. The private codec authenticates persisted capabilities, while
// callers must reauthorize current source, actor,
// endpoint and policy, and persist each I/O intent/result under their own lease.
// Provider contracts (commercial personal chats, no Graph authorization added):
// https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4
// https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
const SCHEMA = "paperclip.teams.file-consent.v1";
const INSTALLED_HOOK = Symbol("paperclip.teams.file-consent.hook");
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_URL_LENGTH = 8192;
const opaqueId = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\x00-\x20\x7f]+$/);
const filename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) =>
      s === s.trim() &&
      !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(s) &&
      !s.endsWith("."),
  );
const tokenSchema = z.string().regex(/^pcfc_[A-Za-z0-9_-]{43}$/);
const bindingSchema = z
  .object({
    schema: z.literal(SCHEMA),
    companyId: z.uuid(),
    endpointId: z.uuid(),
    issueId: z.uuid(),
    publicationId: z.uuid(),
    attachmentId: z.uuid(),
    tenantId: z.uuid(),
    botAppId: z.uuid(),
    aadObjectId: z.uuid(),
    conversationId: opaqueId,
    userId: opaqueId,
    sourceGeneration: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z
      .number()
      .int()
      .positive()
      .max(Math.min(MAX_ATTACHMENT_BYTES, 60 * 1024 * 1024 - 1)),
    filename,
    token: tokenSchema,
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type TeamsFileConsentBinding = Readonly<z.infer<typeof bindingSchema>>;

export function createTeamsFileConsentBinding(
  input: Omit<TeamsFileConsentBinding, "schema" | "token">,
): TeamsFileConsentBinding {
  const parsed = bindingSchema.safeParse({
    ...input,
    schema: SCHEMA,
    token: `pcfc_${randomBytes(32).toString("base64url")}`,
  });
  if (!parsed.success) throw new Error("Invalid Teams file consent binding");
  return Object.freeze(parsed.data);
}

export function parseTeamsFileConsentBinding(
  input: unknown,
): TeamsFileConsentBinding | null {
  const parsed = bindingSchema.safeParse(input);
  return parsed.success ? Object.freeze(parsed.data) : null;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const privateContextSchema = z
  .object({
    companyId: z.uuid(),
    endpointId: z.uuid(),
    transferId: z.uuid(),
    authorityDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type TeamsFilePrivateContext = z.infer<typeof privateContextSchema>;
export type TeamsFileCiphertext = Record<string, unknown>;

async function sealPrivate(
  context: TeamsFilePrivateContext,
  purpose: string,
  value: unknown,
): Promise<TeamsFileCiphertext> {
  const parsed = privateContextSchema.safeParse(context);
  if (!parsed.success) throw new Error("Invalid Teams private state");
  try {
    const prepared = await getSecretProvider("local_encrypted").createSecret({
      value: JSON.stringify({
        schema: "paperclip.teams.file-private.v1",
        context: parsed.data,
        purpose,
        value,
      }),
    });
    return prepared.material;
  } catch {
    throw new Error("Teams private state could not be sealed");
  }
}

async function openPrivate(
  context: TeamsFilePrivateContext,
  purpose: string,
  material: TeamsFileCiphertext,
): Promise<unknown> {
  try {
    const parsedContext = privateContextSchema.parse(context);
    // Bound even corrupted database material before passing it to the provider.
    if (Buffer.byteLength(JSON.stringify(material)) > 128 * 1024)
      throw new Error();
    const plaintext = await getSecretProvider("local_encrypted").resolveVersion(
      { material, externalRef: null },
    );
    if (Buffer.byteLength(plaintext) > 64 * 1024) throw new Error();
    const envelope = z
      .object({
        schema: z.literal("paperclip.teams.file-private.v1"),
        context: privateContextSchema,
        purpose: z.string(),
        value: z.unknown(),
      })
      .strict()
      .parse(JSON.parse(plaintext));
    if (
      envelope.purpose !== purpose ||
      digest(envelope.context) !== digest(parsedContext)
    )
      throw new Error();
    return envelope.value;
  } catch {
    throw new Error("Teams private state could not be restored");
  }
}

export async function sealTeamsFileConsentBinding(
  context: TeamsFilePrivateContext,
  binding: TeamsFileConsentBinding,
) {
  const parsed = parseTeamsFileConsentBinding(binding);
  if (
    !parsed ||
    parsed.companyId !== context.companyId ||
    parsed.endpointId !== context.endpointId
  )
    throw new Error("Invalid Teams private binding");
  return sealPrivate(context, "binding", parsed);
}

export async function restoreTeamsFileConsentBinding(
  context: TeamsFilePrivateContext,
  material: TeamsFileCiphertext,
) {
  const binding = parseTeamsFileConsentBinding(
    await openPrivate(context, "binding", material),
  );
  if (
    !binding ||
    binding.companyId !== context.companyId ||
    binding.endpointId !== context.endpointId
  )
    throw new Error("Invalid Teams private binding");
  return binding;
}

export type TeamsFileConsentPhase =
  | "consent_pending"
  | "consent_sending"
  | "consent_unknown"
  | "awaiting_consent"
  | "upload_pending"
  | "uploading"
  | "upload_unknown"
  | "file_info_pending"
  | "file_info_sending"
  | "file_info_unknown"
  | "delivered"
  | "declined"
  | "expired";
export type TeamsFileConsentStep =
  | "send_consent"
  | "consent_confirmed"
  | "consent_uncertain"
  | "accept"
  | "decline"
  | "expire"
  | "start_upload"
  | "upload_confirmed"
  | "upload_uncertain"
  | "send_file_info"
  | "file_info_confirmed"
  | "file_info_uncertain";

// These are facts to persist, not authority to perform the next effect. Unknown
// POST/PUT results have no blind-resend edge. Status reconciliation is separate.
export function nextTeamsFileConsentPhase(
  phase: TeamsFileConsentPhase,
  step: TeamsFileConsentStep,
): TeamsFileConsentPhase | null {
  const transitions: Partial<
    Record<
      TeamsFileConsentPhase,
      Partial<Record<TeamsFileConsentStep, TeamsFileConsentPhase>>
    >
  > = {
    consent_pending: { send_consent: "consent_sending" },
    consent_sending: {
      consent_confirmed: "awaiting_consent",
      consent_uncertain: "consent_unknown",
    },
    awaiting_consent: {
      accept: "upload_pending",
      decline: "declined",
      expire: "expired",
    },
    upload_pending: { start_upload: "uploading" },
    uploading: {
      upload_confirmed: "file_info_pending",
      upload_uncertain: "upload_unknown",
    },
    file_info_pending: { send_file_info: "file_info_sending" },
    file_info_sending: {
      file_info_confirmed: "delivered",
      file_info_uncertain: "file_info_unknown",
    },
  };
  if (!Object.hasOwn(transitions, phase)) return null;
  const actions = transitions[phase]!;
  return Object.hasOwn(actions, step) ? actions[step]! : null;
}

export function teamsFileConsentProgress(phase: TeamsFileConsentPhase) {
  return {
    delivered: phase === "delivered",
    settled: ["delivered", "declined", "expired"].includes(phase),
    // Confirmed consent cards release the outbound FIFO while each file waits.
    releasesConversation: [
      "awaiting_consent",
      "delivered",
      "declined",
      "expired",
    ].includes(phase),
  };
}

export function buildTeamsFileConsentCard(binding: TeamsFileConsentBinding) {
  const validated = parseTeamsFileConsentBinding(binding);
  if (!validated) throw new Error("Invalid Teams file consent binding");
  return {
    contentType: "application/vnd.microsoft.teams.card.file.consent" as const,
    name: validated.filename,
    content: {
      description: "Allow Paperclip to upload this file to your OneDrive.",
      sizeInBytes: validated.byteSize,
      acceptContext: {
        schema: SCHEMA,
        token: validated.token,
        action: "accept" as const,
      },
      declineContext: {
        schema: SCHEMA,
        token: validated.token,
        action: "decline" as const,
      },
    },
  };
}

type UrlRejection = "invalid_upload_info" | "unsupported_upload_host";
function sharePointUrl(input: unknown, content = false): URL | UrlRejection {
  if (
    typeof input !== "string" ||
    input.length > MAX_URL_LENGTH ||
    /[\s\\\x00-\x1f\x7f]/.test(input)
  )
    return "invalid_upload_info";
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "invalid_upload_info";
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    (content && url.search)
  )
    return "invalid_upload_info";
  // Commercial M365 endpoint set 31 documents *.sharepoint.com. This is a
  // conservative supported family, NOT proof of recipient authorization or an
  // exhaustive Teams upload-host list. No inferred *.1drv.com/Azure expansion.
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+sharepoint\.com$/.test(
      url.hostname,
    ) ||
    url.hostname.length > 253
  )
    return "unsupported_upload_host";
  if (url.pathname === "/") return "invalid_upload_info";
  return url;
}

const uploadInfoSchema = z
  .object({
    name: filename,
    fileType: z.string().regex(/^[a-zA-Z0-9]{1,16}$/),
    uniqueId: opaqueId,
    uploadUrl: z.string().max(MAX_URL_LENGTH),
    contentUrl: z.string().max(MAX_URL_LENGTH),
    etag: z.string().max(1024).optional(),
  })
  .strict();
type UploadInfo = z.infer<typeof uploadInfoSchema>;

// Instances originate only in our authenticated App router hook. The private
// fields intentionally do not survive JSON, spreading, inspection or structured
// clone. Restart support must decrypt a bound private provider-state
// record, not reconstruct a capability from action/publication JSON.
class UploadCapability {
  #info: UploadInfo;
  #bindingDigest: string;
  #confirmed = false;
  #putStarted = false;
  #expiresAt: number;
  #byteSize: number;
  #sha256: string;
  constructor(info: UploadInfo, binding: TeamsFileConsentBinding) {
    this.#info = Object.freeze({ ...info });
    this.#bindingDigest = digest(binding);
    this.#expiresAt = Date.parse(binding.expiresAt);
    this.#byteSize = binding.byteSize;
    this.#sha256 = binding.sha256;
    Object.freeze(this);
  }
  toJSON() {
    return undefined;
  }
  async seal(
    context: TeamsFilePrivateContext,
    binding: TeamsFileConsentBinding,
  ) {
    if (
      !this.matches(binding) ||
      context.companyId !== binding.companyId ||
      context.endpointId !== binding.endpointId
    )
      throw new Error("Invalid Teams upload binding");
    return sealPrivate(context, "upload", {
      bindingDigest: digest(binding),
      info: this.#info,
      confirmed: this.#confirmed,
      putStarted: this.#putStarted,
    });
  }
  static async restore(
    context: TeamsFilePrivateContext,
    binding: TeamsFileConsentBinding,
    material: TeamsFileCiphertext,
  ) {
    if (
      context.companyId !== binding.companyId ||
      context.endpointId !== binding.endpointId
    )
      throw new Error("Invalid Teams upload binding");
    const value = z
      .object({
        bindingDigest: z.string(),
        info: uploadInfoSchema,
        confirmed: z.boolean(),
        putStarted: z.boolean(),
      })
      .strict()
      .parse(await openPrivate(context, "upload", material));
    if (
      value.bindingDigest !== digest(binding) ||
      value.info.name !== binding.filename ||
      typeof sharePointUrl(value.info.uploadUrl) === "string" ||
      typeof sharePointUrl(value.info.contentUrl, true) === "string" ||
      (value.confirmed && !value.putStarted)
    )
      throw new Error("Invalid Teams upload state");
    const result = new UploadCapability(value.info, binding);
    result.#confirmed = value.confirmed;
    result.#putStarted = value.putStarted;
    return result;
  }
  matches(binding: TeamsFileConsentBinding): boolean {
    return this.#bindingDigest === digest(binding);
  }
  fileInfo() {
    if (!this.#confirmed) throw new Error("Teams upload is not confirmed");
    return {
      contentType: "application/vnd.microsoft.teams.card.file.info" as const,
      name: this.#info.name,
      contentUrl: this.#info.contentUrl,
      content: { uniqueId: this.#info.uniqueId, fileType: this.#info.fileType },
    };
  }
  async exchange(
    operation: "put" | "status",
    bytes: Buffer | null,
    options: UploadRequestOptions,
  ): Promise<TeamsUploadOutcome> {
    if (
      (operation !== "put" && operation !== "status") ||
      options.byteSize !== this.#byteSize
    )
      throw new Error("Invalid Teams upload binding");
    // The capability is itself a security boundary; calling it directly cannot
    // bypass the outer convenience function's exact-byte checks or mutate a
    // caller-owned Buffer while current authorization is awaited.
    const snapshot =
      operation === "put" && Buffer.isBuffer(bytes) ? Buffer.from(bytes) : null;
    if (
      operation === "put" &&
      (!snapshot ||
        snapshot.length !== this.#byteSize ||
        createHash("sha256").update(snapshot).digest("hex") !== this.#sha256)
    )
      throw new Error("Teams upload bytes do not match consent");
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      await abortable(Promise.resolve().then(options.authorize), signal);
      signal.throwIfAborted();
      if (this.#expiresAt <= Date.now())
        return { kind: "uncertain", reason: "session_unavailable" };
      if (operation === "put") {
        if (this.#confirmed) return { kind: "uploaded" };
        if (this.#putStarted)
          return { kind: "uncertain", reason: "put_already_attempted" };
        this.#putStarted = true;
      }
      const response = await abortable(
        (options.request ?? guardedRemoteHttpFetch)(
          this.#info.uploadUrl,
          {
            method: operation === "put" ? "PUT" : "GET",
            redirect: "manual",
            signal,
            headers:
              operation === "put"
                ? {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": String(this.#byteSize),
                    "Content-Range": `bytes 0-${this.#byteSize - 1}/${this.#byteSize}`,
                  }
                : {},
            ...(operation === "put"
              ? { body: snapshot! as unknown as BodyInit }
              : {}),
          },
          {
            error: () => new Error("Teams upload transport rejected"),
            connectTimeoutMs: 10_000,
            responseTimeoutMs: 30_000,
          },
        ),
        signal,
      );
      const outcome = await classifyTeamsUploadResponse(
        operation,
        response,
        this.#byteSize,
        this.#info,
        signal,
      );
      if (outcome.kind === "uploaded") this.#confirmed = true;
      return outcome;
    } catch {
      // Even a timeout/connection loss may follow a successful final PUT. Never
      // echo upstream errors (which can contain the preauthenticated URL).
      return { kind: "uncertain", reason: "transport_or_authorization_failed" };
    } finally {
      clearTimeout(timer);
    }
  }
}
export type TeamsFileUploadCapability = UploadCapability;

const contextSchema = z
  .object({
    schema: z.literal(SCHEMA),
    token: tokenSchema,
    action: z.enum(["accept", "decline"]),
  })
  .strict();
const activitySchema = z.object({
  type: z.literal("invoke"),
  name: z.literal("fileConsent/invoke"),
  channelId: z.literal("msteams"),
  id: opaqueId,
  from: z.object({ id: opaqueId, aadObjectId: z.uuid() }),
  recipient: z.object({ id: opaqueId }),
  conversation: z.object({
    id: opaqueId,
    conversationType: z.literal("personal"),
    tenantId: z.uuid().optional(),
  }),
  channelData: z
    .object({
      tenant: z.object({ id: z.uuid() }).optional(),
      team: z.never().optional(),
      channel: z.never().optional(),
    })
    .optional(),
  replyToId: opaqueId.optional(),
  value: z
    .object({
      type: z.literal("fileUpload").optional(),
      action: z.enum(["accept", "decline"]),
      context: contextSchema,
      uploadInfo: z.unknown().optional(),
    })
    .strict(),
});

class ConsentEvent {
  #authentic = true;
  #upload: UploadInfo | UrlRejection | null;
  readonly uploadStatus: "available" | UrlRejection | "none";
  constructor(
    readonly companyId: string,
    readonly endpointId: string,
    readonly tenantId: string,
    readonly botAppId: string,
    readonly activityId: string,
    readonly conversationId: string,
    readonly userId: string,
    readonly aadObjectId: string,
    readonly action: "accept" | "decline",
    readonly token: string,
    readonly replyToId: string | null,
    upload: UploadInfo | UrlRejection | null,
  ) {
    this.#upload =
      typeof upload === "object" && upload
        ? Object.freeze({ ...upload })
        : upload;
    this.uploadStatus =
      upload === null
        ? "none"
        : typeof upload === "string"
          ? upload
          : "available";
    Object.freeze(this);
  }
  isHookEvent() {
    return this.#authentic;
  }
  async seal(
    context: TeamsFilePrivateContext,
    binding: TeamsFileConsentBinding,
  ) {
    if (
      !consentEventMatches(this, binding) ||
      context.companyId !== binding.companyId ||
      context.endpointId !== binding.endpointId
    )
      throw new Error("Invalid Teams consent scope");
    return sealPrivate(context, "response", {
      bindingDigest: digest(binding),
      activityId: this.activityId,
      action: this.action,
      replyToId: this.replyToId,
      upload: this.#upload,
    });
  }
  receiptDigest() {
    return digest({
      activityId: this.activityId,
      action: this.action,
      replyToId: this.replyToId,
      upload: this.#upload,
    });
  }
  static async restore(
    context: TeamsFilePrivateContext,
    binding: TeamsFileConsentBinding,
    material: TeamsFileCiphertext,
  ) {
    if (
      context.companyId !== binding.companyId ||
      context.endpointId !== binding.endpointId
    )
      throw new Error("Invalid Teams consent scope");
    const value = z
      .object({
        bindingDigest: z.string(),
        activityId: opaqueId,
        action: z.enum(["accept", "decline"]),
        replyToId: opaqueId.nullable(),
        upload: z.union([
          uploadInfoSchema,
          z.enum(["invalid_upload_info", "unsupported_upload_host"]),
          z.null(),
        ]),
      })
      .strict()
      .parse(await openPrivate(context, "response", material));
    if (
      value.bindingDigest !== digest(binding) ||
      (value.action === "decline" && value.upload !== null)
    )
      throw new Error("Invalid Teams response state");
    if (
      value.upload &&
      typeof value.upload !== "string" &&
      (typeof sharePointUrl(value.upload.uploadUrl) === "string" ||
        typeof sharePointUrl(value.upload.contentUrl, true) === "string")
    )
      throw new Error("Invalid Teams response state");
    return new ConsentEvent(
      binding.companyId,
      binding.endpointId,
      binding.tenantId,
      binding.botAppId,
      value.activityId,
      binding.conversationId,
      binding.userId,
      binding.aadObjectId,
      value.action,
      binding.token,
      value.replyToId,
      value.upload,
    );
  }
  bindUpload(
    binding: TeamsFileConsentBinding,
  ): UploadCapability | UrlRejection {
    if (!this.#upload || typeof this.#upload === "string")
      return this.#upload ?? "invalid_upload_info";
    if (
      this.action !== "accept" ||
      this.#upload.name !== binding.filename ||
      (
        [
          "companyId",
          "endpointId",
          "tenantId",
          "botAppId",
          "conversationId",
          "userId",
          "aadObjectId",
          "token",
        ] as const
      ).some((key) => this[key] !== binding[key])
    )
      return "invalid_upload_info";
    return new UploadCapability(this.#upload, binding);
  }
}
export type TeamsFileConsentEvent = ConsentEvent;

function consentEventMatches(
  event: TeamsFileConsentEvent,
  binding: TeamsFileConsentBinding,
): boolean {
  try {
    return (
      event instanceof ConsentEvent &&
      event.isHookEvent() &&
      (
        [
          "companyId",
          "endpointId",
          "tenantId",
          "botAppId",
          "conversationId",
          "userId",
          "aadObjectId",
          "token",
        ] as const
      ).every((key) => event[key] === binding[key])
    );
  } catch {
    return false;
  }
}

// Restoration is ONLY for ciphertext loaded from the exact locked transfer row.
// The context authenticates the complete current authority digest, not a caller
// supplied public action or a normalized provider payload.
export async function sealTeamsFileConsentEvent(
  context: TeamsFilePrivateContext,
  binding: TeamsFileConsentBinding,
  event: TeamsFileConsentEvent,
) {
  if (!consentEventMatches(event, binding))
    throw new Error("Invalid Teams consent scope");
  return event.seal(context, binding);
}
export async function restoreTeamsFileConsentEvent(
  context: TeamsFilePrivateContext,
  binding: TeamsFileConsentBinding,
  material: TeamsFileCiphertext,
) {
  try {
    return await ConsentEvent.restore(context, binding, material);
  } catch {
    throw new Error("Teams response state could not be restored");
  }
}
export async function sealTeamsFileUpload(
  context: TeamsFilePrivateContext,
  binding: TeamsFileConsentBinding,
  upload: TeamsFileUploadCapability,
) {
  if (!(upload instanceof UploadCapability))
    throw new Error("Invalid Teams upload state");
  return upload.seal(context, binding);
}
export async function restoreTeamsFileUpload(
  context: TeamsFilePrivateContext,
  binding: TeamsFileConsentBinding,
  material: TeamsFileCiphertext,
) {
  try {
    return await UploadCapability.restore(context, binding, material);
  } catch {
    throw new Error("Teams upload state could not be restored");
  }
}

/** A branded exact callback proves only that its issued card reached this user.
 * A durable send intent must precede accepting this alternative receipt. */
export function bindEarlyTeamsFileConsent(input: {
  event: TeamsFileConsentEvent;
  stored: unknown;
  current: unknown;
  phase: "consent_sending" | "consent_unknown";
  now: number;
}): TeamsConsentDecision {
  if (input.phase !== "consent_sending" && input.phase !== "consent_unknown")
    return { ok: false, reason: "not_awaiting_consent" };
  // No invented provider ID: explicit callback receipt is a separate variant.
  return bindTeamsFileConsent({
    ...input,
    phase: "awaiting_consent",
    cardReceipt: {
      kind: "authenticated_callback",
      activityId: input.event.activityId,
    },
  });
}
export interface TeamsConsentApp {
  on(
    event: "file.consent.accept" | "file.consent.decline",
    callback: (context: { activity: unknown }) => Promise<{ status: number }>,
  ): unknown;
}
export interface TeamsFileConsentHookOptions {
  companyId: string;
  endpointId: string;
  tenantId: string;
  botAppId: string;
  // "recorded" means the caller durably recorded the response, not that a file
  // was uploaded/published. No 2xx while that callback is still pending.
  // A response may precede the consent-card POST receipt or follow a lost POST
  // ACK. Persist that exact authenticated response in private encrypted state
  // for reconciliation; not_awaiting_consent is NOT permission to discard it or
  // resend the card. The durable transfer service owns that receipt transaction.
  onConsent(
    event: TeamsFileConsentEvent,
  ): Promise<"recorded" | "ignored" | "denied">;
}

/** Install only on the actual Teams SDK App, behind its service JWT verifier. */
export function installTeamsFileConsentHook(
  app: TeamsConsentApp,
  options: TeamsFileConsentHookOptions,
): void {
  const scope = z
    .object({
      companyId: z.uuid(),
      endpointId: z.uuid(),
      tenantId: z.uuid(),
      botAppId: z.uuid(),
    })
    .safeParse(options);
  const onConsent = options.onConsent;
  if (
    !scope.success ||
    typeof app.on !== "function" ||
    typeof onConsent !== "function"
  )
    throw new Error("Invalid Teams consent hook configuration");
  // Per-App ownership only: no process-global callback registry or credential
  // store. Reinitialization must not silently add duplicate effect callbacks.
  if (Object.hasOwn(app, INSTALLED_HOOK))
    throw new Error("Teams consent hook already installed");
  Object.defineProperty(app, INSTALLED_HOOK, { value: true });
  for (const action of ["accept", "decline"] as const)
    app.on(`file.consent.${action}`, async ({ activity }) => {
      const parsed = activitySchema.safeParse(activity);
      if (!parsed.success) return { status: 400 };
      const a = parsed.data;
      const tenant = a.conversation.tenantId ?? a.channelData?.tenant?.id;
      if (
        !tenant ||
        tenant !== scope.data.tenantId ||
        (a.channelData?.tenant?.id !== undefined &&
          a.channelData.tenant.id !== tenant) ||
        a.recipient.id !== `28:${scope.data.botAppId}` ||
        a.value.action !== action ||
        a.value.context.action !== action
      )
        return { status: 403 };
      let upload: UploadInfo | UrlRejection | null = null;
      if (action === "accept") {
        const info = uploadInfoSchema.safeParse(a.value.uploadInfo);
        if (!info.success) upload = "invalid_upload_info";
        else {
          const target = sharePointUrl(info.data.uploadUrl);
          const content = sharePointUrl(info.data.contentUrl, true);
          upload =
            typeof target === "string"
              ? target
              : typeof content === "string"
                ? content
                : info.data;
        }
      } else if (a.value.uploadInfo !== undefined) return { status: 400 };
      const event = new ConsentEvent(
        scope.data.companyId,
        scope.data.endpointId,
        tenant,
        scope.data.botAppId,
        a.id,
        a.conversation.id,
        a.from.id,
        a.from.aadObjectId,
        action,
        a.value.context.token,
        a.replyToId ?? null,
        upload,
      );
      try {
        const result = await onConsent(event);
        return {
          status:
            result === "recorded" || result === "ignored"
              ? 200
              : result === "denied"
                ? 403
                : 503,
        };
      } catch {
        return { status: 503 };
      }
    });
}

export type TeamsConsentDecision =
  | {
      ok: true;
      action: "accept";
      upload: TeamsFileUploadCapability;
      activityId: string;
    }
  | { ok: true; action: "decline"; activityId: string }
  | {
      ok: false;
      reason:
        | "invalid_binding"
        | "stale_binding"
        | "not_awaiting_consent"
        | "expired"
        | "wrong_scope"
        | UrlRejection;
    };

/** The current binding MUST be independently rederived under caller DB locks. */
export function bindTeamsFileConsent(input: {
  event: TeamsFileConsentEvent;
  stored: unknown;
  current: unknown;
  phase: TeamsFileConsentPhase;
  cardMessageId?: string;
  cardReceipt?: { kind: "authenticated_callback"; activityId: string };
  now: number;
}): TeamsConsentDecision {
  const stored = parseTeamsFileConsentBinding(input.stored);
  const current = parseTeamsFileConsentBinding(input.current);
  if (!stored || !current) return { ok: false, reason: "invalid_binding" };
  if (digest(stored) !== digest(current))
    return { ok: false, reason: "stale_binding" };
  if (input.phase !== "awaiting_consent")
    return { ok: false, reason: "not_awaiting_consent" };
  if (!Number.isFinite(input.now) || Date.parse(stored.expiresAt) <= input.now)
    return { ok: false, reason: "expired" };
  const event = input.event;
  if (
    !consentEventMatches(event, stored) ||
    (input.cardReceipt
      ? input.cardMessageId !== undefined ||
        input.cardReceipt.kind !== "authenticated_callback" ||
        input.cardReceipt.activityId !== event.activityId
      : !opaqueId.safeParse(input.cardMessageId).success ||
        (event.replyToId !== null && event.replyToId !== input.cardMessageId))
  )
    return { ok: false, reason: "wrong_scope" };
  if (event.action === "decline")
    return { ok: true, action: "decline", activityId: event.activityId };
  const upload = event.bindUpload(stored);
  if (typeof upload === "string") return { ok: false, reason: upload };
  return { ok: true, action: "accept", upload, activityId: event.activityId };
}

export type TeamsUploadOutcome =
  | { kind: "uploaded" }
  | {
      kind: "incomplete";
      expiresAt: string;
      missingRanges: Array<{ start: number; end: number }>;
    }
  | {
      kind: "uncertain";
      reason:
        | "transport_or_authorization_failed"
        | "response_invalid"
        | "session_unavailable"
        | "provider_response"
        | "put_already_attempted";
    };
interface UploadRequestOptions {
  authorize(): Promise<void>;
  byteSize: number;
  signal?: AbortSignal;
  /** Isolated test transport only; production uses DNS/socket-pinned egress. */
  request?: typeof guardedRemoteHttpFetch;
}

/** One bounded operation, never an implicit retry or new upload session. */
export async function exchangeTeamsFileUpload(
  input: {
    upload: TeamsFileUploadCapability;
    binding: TeamsFileConsentBinding;
    operation: "put" | "status";
    bytes?: Buffer;
  } & Omit<UploadRequestOptions, "byteSize">,
): Promise<TeamsUploadOutcome> {
  const binding = parseTeamsFileConsentBinding(input.binding);
  if (
    !binding ||
    !(input.upload instanceof UploadCapability) ||
    !input.upload.matches(binding)
  )
    throw new Error("Invalid Teams upload binding");
  const bytes =
    input.operation === "put" && Buffer.isBuffer(input.bytes)
      ? Buffer.from(input.bytes)
      : null;
  if (
    input.operation === "put" &&
    (!bytes ||
      bytes.length !== binding.byteSize ||
      createHash("sha256").update(bytes).digest("hex") !== binding.sha256)
  )
    throw new Error("Teams upload bytes do not match consent");
  if (Date.parse(binding.expiresAt) <= Date.now())
    return { kind: "uncertain", reason: "session_unavailable" };
  return input.upload.exchange(input.operation, bytes, {
    authorize: input.authorize,
    signal: input.signal,
    request: input.request,
    byteSize: binding.byteSize,
  });
}

export function buildTeamsUploadedFileCard(
  upload: TeamsFileUploadCapability,
  outcome: TeamsUploadOutcome,
) {
  if (!(upload instanceof UploadCapability) || outcome.kind !== "uploaded")
    throw new Error("Teams upload is not confirmed");
  return upload.fileInfo();
}

async function classifyTeamsUploadResponse(
  operation: "put" | "status",
  response: Response,
  byteSize: number,
  info: UploadInfo,
  signal: AbortSignal,
): Promise<TeamsUploadOutcome> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (reader) {
      signal.throwIfAborted();
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      length += result.value.length;
      if (length > MAX_RESPONSE_BYTES)
        throw new Error("Teams upload response too large");
      chunks.push(result.value);
    }
    if (
      operation === "put" &&
      (response.status === 200 || response.status === 201)
    ) {
      // Graph's final upload response is the committed driveItem. An HTML login
      // page or unrelated 2xx body is not a receipt for this file.
      if (
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        return { kind: "uncertain", reason: "response_invalid" };
      const parsed = z
        .object({
          id: opaqueId,
          size: z.number().int().nonnegative(),
          name: filename,
        })
        .safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (
        !parsed.success ||
        !sameDriveItemId(parsed.data.id, info.uniqueId) ||
        parsed.data.size !== byteSize ||
        parsed.data.name !== info.name
      )
        return { kind: "uncertain", reason: "response_invalid" };
      return { kind: "uploaded" };
    }
    if (
      (operation === "status" && response.status === 200) ||
      (operation === "put" && response.status === 202)
    ) {
      const parsed = z
        .object({
          expirationDateTime: z.iso.datetime(),
          nextExpectedRanges: z.array(z.string().max(40)).min(1).max(128),
        })
        .safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (
        !parsed.success ||
        Date.parse(parsed.data.expirationDateTime) <= Date.now()
      )
        return { kind: "uncertain", reason: "response_invalid" };
      const missingRanges: Array<{ start: number; end: number }> = [];
      for (const range of parsed.data.nextExpectedRanges) {
        const match = /^(0|[1-9]\d*)-(0|[1-9]\d*)?$/.exec(range);
        if (!match) return { kind: "uncertain", reason: "response_invalid" };
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : byteSize - 1;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          end >= byteSize ||
          (missingRanges.length && start <= missingRanges.at(-1)!.end)
        )
          return { kind: "uncertain", reason: "response_invalid" };
        missingRanges.push({ start, end });
      }
      return {
        kind: "incomplete",
        expiresAt: parsed.data.expirationDateTime,
        missingRanges,
      };
    }
    // A missing/expired session after a lost final PUT response does not prove
    // that the file was not committed. No blind retry or fabricated success.
    return {
      kind: "uncertain",
      reason:
        response.status === 404 || response.status === 410
          ? "session_unavailable"
          : "provider_response",
    };
  } catch {
    return { kind: "uncertain", reason: "response_invalid" };
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {});
    }
  }
}

function sameDriveItemId(actual: string, expected: string): boolean {
  const guid = /^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/;
  return (
    actual === expected ||
    (guid.test(actual) &&
      guid.test(expected) &&
      actual.toLowerCase() === expected.toLowerCase())
  );
}

/** Closed native attachment-card projections for the scoped runtime sender. */
export function parseTeamsFileConsentCard(
  input: unknown,
): ReturnType<typeof buildTeamsFileConsentCard> | null {
  const parsed = z
    .object({
      contentType: z.literal(
        "application/vnd.microsoft.teams.card.file.consent",
      ),
      name: filename,
      content: z
        .object({
          description: z.literal(
            "Allow Paperclip to upload this file to your OneDrive.",
          ),
          sizeInBytes: z
            .number()
            .int()
            .positive()
            .max(Math.min(MAX_ATTACHMENT_BYTES, 60 * 1024 * 1024 - 1)),
          acceptContext: contextSchema.extend({ action: z.literal("accept") }),
          declineContext: contextSchema.extend({
            action: z.literal("decline"),
          }),
        })
        .strict(),
    })
    .strict()
    .safeParse(input);
  if (
    !parsed.success ||
    parsed.data.content.acceptContext.token !==
      parsed.data.content.declineContext.token
  )
    return null;
  return parsed.data;
}

export function parseTeamsUploadedFileCard(
  input: unknown,
): ReturnType<typeof buildTeamsUploadedFileCard> | null {
  const parsed = z
    .object({
      contentType: z.literal("application/vnd.microsoft.teams.card.file.info"),
      name: filename,
      contentUrl: z.string().max(MAX_URL_LENGTH),
      content: z
        .object({
          uniqueId: opaqueId,
          fileType: z.string().regex(/^[a-zA-Z0-9]{1,16}$/),
        })
        .strict(),
    })
    .strict()
    .safeParse(input);
  if (
    !parsed.success ||
    typeof sharePointUrl(parsed.data.contentUrl, true) === "string"
  )
    return null;
  return parsed.data;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Teams upload deadline exceeded"));
    signal.addEventListener("abort", abort, { once: true });
    void operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
