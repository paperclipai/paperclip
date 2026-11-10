import { createHash } from "node:crypto";
import { inspect } from "node:util";
import * as dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindTeamsFileConsent,
  buildTeamsFileConsentCard,
  buildTeamsUploadedFileCard,
  createTeamsFileConsentBinding,
  exchangeTeamsFileUpload,
  installTeamsFileConsentHook,
  nextTeamsFileConsentPhase,
  parseTeamsFileConsentBinding,
  teamsFileConsentProgress,
  type TeamsConsentApp,
  type TeamsFileConsentBinding,
  type TeamsFileConsentEvent,
} from "./chat-teams-file-consent.js";
type UploadRequest = NonNullable<
  Parameters<typeof exchangeTeamsFileUpload>[0]["request"]
>;
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: vi.fn(async () => {
    throw new Error("No unmocked DNS in this fixture");
  }),
}));

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bytes = Buffer.from([0, 10, 13, 128, 255, 65]);
const binding = createTeamsFileConsentBinding({
  companyId: uuid(1),
  endpointId: uuid(2),
  issueId: uuid(3),
  publicationId: uuid(4),
  attachmentId: uuid(5),
  tenantId: uuid(6),
  botAppId: uuid(7),
  aadObjectId: uuid(8),
  userId: "29:synthetic-user",
  conversationId: "a:personal-conversation",
  sourceGeneration: 3,
  sourceDigest: "a".repeat(64),
  filename: "report.txt",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  byteSize: bytes.length,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});
const uploadUrl =
  "https://contoso-my.sharepoint.com/personal/user/_api/v2.0/drive/items/item/uploadSession?token=PRIVATE-UPLOAD-CANARY";
const contentUrl =
  "https://contoso-my.sharepoint.com/personal/user/Documents/report.txt";
const uploadInfo = {
  uploadUrl,
  contentUrl,
  uniqueId: "item-1",
  name: "report.txt",
  fileType: "txt",
};

function activity(
  action: "accept" | "decline" = "accept",
  info: unknown = uploadInfo,
) {
  return {
    type: "invoke",
    name: "fileConsent/invoke",
    channelId: "msteams",
    id: "activity-1",
    from: { id: binding.userId, aadObjectId: binding.aadObjectId },
    recipient: { id: `28:${binding.botAppId}` },
    conversation: {
      id: binding.conversationId,
      conversationType: "personal",
      tenantId: binding.tenantId,
    },
    channelData: { tenant: { id: binding.tenantId } },
    replyToId: "card-1",
    value: {
      type: "fileUpload",
      action,
      context: { schema: binding.schema, token: binding.token, action },
      ...(action === "accept" ? { uploadInfo: info } : {}),
    },
  };
}

// Unit-only adapter surrogate. The separate contract suite crosses the actual
// pinned SDK verifier/router; these direct callbacks do not prove authentication.
async function normalized(raw: unknown = activity()) {
  const handlers = new Map<
    string,
    (context: { activity: unknown }) => Promise<{ status: number }>
  >();
  const callback = vi.fn(
    async (_event: TeamsFileConsentEvent) => "recorded" as const,
  );
  const app: TeamsConsentApp = {
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  installTeamsFileConsentHook(app, { ...binding, onConsent: callback });
  const action =
    (raw as ReturnType<typeof activity>)?.value?.action === "decline"
      ? "decline"
      : "accept";
  const response = await handlers.get(`file.consent.${action}`)!({
    activity: raw,
  });
  return { response, event: callback.mock.calls[0]?.[0], callback };
}
function decide(
  event: TeamsFileConsentEvent,
  override: Record<string, unknown> = {},
) {
  return bindTeamsFileConsent({
    event,
    stored: binding,
    current: binding,
    phase: "awaiting_consent",
    cardMessageId: "card-1",
    now: Date.now(),
    ...override,
  });
}
async function accepted(info: unknown = uploadInfo) {
  const { event } = await normalized(activity("accept", info));
  const decision = decide(event!);
  if (!decision.ok || decision.action !== "accept")
    throw new Error("Invalid test consent");
  return decision.upload;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Teams personal file consent foundation", () => {
  it("creates a closed immutable binding and sends only an opaque action selector in the consent card", () => {
    expect(Object.isFrozen(binding)).toBe(true);
    expect(binding.token).toMatch(/^pcfc_[\w-]{43}$/);
    const card = buildTeamsFileConsentCard(binding);
    expect(card).toEqual({
      contentType: "application/vnd.microsoft.teams.card.file.consent",
      name: binding.filename,
      content: {
        description: expect.any(String),
        sizeInBytes: bytes.length,
        acceptContext: {
          schema: binding.schema,
          token: binding.token,
          action: "accept",
        },
        declineContext: {
          schema: binding.schema,
          token: binding.token,
          action: "decline",
        },
      },
    });
    for (const privateField of [
      binding.companyId,
      binding.attachmentId,
      binding.issueId,
      "uploadUrl",
      "contentUrl",
    ])
      expect(JSON.stringify(card)).not.toContain(privateField);
    expect(parseTeamsFileConsentBinding({ ...binding, uploadUrl })).toBeNull();
    expect(
      parseTeamsFileConsentBinding({
        ...binding,
        filename: "<img onerror=bad>.txt",
      }),
    ).toBeNull();
    expect(
      parseTeamsFileConsentBinding({ ...binding, byteSize: 0 }),
    ).toBeNull();
    expect(
      parseTeamsFileConsentBinding({ ...binding, sourceGeneration: -1 }),
    ).toBeNull();
  });

  it("does not install duplicate callbacks on the same App or reuse another endpoint's hook", () => {
    const on = vi.fn();
    const app = { on };
    const onConsent = vi.fn(async () => "recorded" as const);
    installTeamsFileConsentHook(app, { ...binding, onConsent });
    expect(() =>
      installTeamsFileConsentHook(app, {
        ...binding,
        endpointId: uuid(99),
        onConsent,
      }),
    ).toThrow("already installed");
    expect(on).toHaveBeenCalledTimes(2);
  });

  it("does not confuse confirmed consent or upload with visible file delivery", () => {
    expect(nextTeamsFileConsentPhase("consent_pending", "send_consent")).toBe(
      "consent_sending",
    );
    expect(
      nextTeamsFileConsentPhase("consent_sending", "consent_confirmed"),
    ).toBe("awaiting_consent");
    expect(teamsFileConsentProgress("awaiting_consent")).toEqual({
      delivered: false,
      settled: false,
      releasesConversation: true,
    });
    expect(nextTeamsFileConsentPhase("awaiting_consent", "accept")).toBe(
      "upload_pending",
    );
    expect(nextTeamsFileConsentPhase("uploading", "upload_confirmed")).toBe(
      "file_info_pending",
    );
    expect(teamsFileConsentProgress("file_info_pending").delivered).toBe(false);
    expect(
      nextTeamsFileConsentPhase("file_info_sending", "file_info_confirmed"),
    ).toBe("delivered");
    expect(teamsFileConsentProgress("delivered").delivered).toBe(true);
    for (const phase of ["declined", "expired"] as const) {
      expect(teamsFileConsentProgress(phase)).toEqual({
        delivered: false,
        settled: true,
        releasesConversation: true,
      });
      expect(nextTeamsFileConsentPhase(phase, "send_consent")).toBeNull();
    }
    for (const phase of [
      "consent_unknown",
      "upload_unknown",
      "file_info_unknown",
    ] as const) {
      expect(teamsFileConsentProgress(phase).releasesConversation).toBe(false);
      for (const step of [
        "send_consent",
        "start_upload",
        "send_file_info",
        "expire",
        "file_info_confirmed",
      ] as const)
        expect(nextTeamsFileConsentPhase(phase, step)).toBeNull();
    }
    expect(
      nextTeamsFileConsentPhase("awaiting_consent", "file_info_confirmed"),
    ).toBeNull();
    expect(
      nextTeamsFileConsentPhase("__proto__" as never, "toString" as never),
    ).toBeNull();
    expect(
      nextTeamsFileConsentPhase("awaiting_consent", "__proto__" as never),
    ).toBeNull();
  });

  it("binds a response to the exact current action and no other file, actor or source generation", async () => {
    const { event } = await normalized();
    expect(decide(event!)).toMatchObject({
      ok: true,
      action: "accept",
      activityId: "activity-1",
    });
    for (const [key, value] of Object.entries({
      companyId: uuid(91),
      endpointId: uuid(92),
      issueId: uuid(93),
      publicationId: uuid(94),
      attachmentId: uuid(95),
      tenantId: uuid(96),
      botAppId: uuid(97),
      aadObjectId: uuid(98),
      userId: "29:other",
      conversationId: "a:other",
      sourceGeneration: 4,
      sourceDigest: "b".repeat(64),
      sha256: "c".repeat(64),
      byteSize: 7,
      filename: "other.txt",
    }))
      expect(
        decide(event!, { current: { ...binding, [key]: value } }),
        key,
      ).toEqual({ ok: false, reason: "stale_binding" });
    expect(decide(event!, { phase: "uploading" })).toEqual({
      ok: false,
      reason: "not_awaiting_consent",
    });
    expect(decide(event!, { now: Date.parse(binding.expiresAt) })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(decide(event!, { cardMessageId: "another-card" })).toEqual({
      ok: false,
      reason: "wrong_scope",
    });
    expect(decide(JSON.parse(JSON.stringify(event)))).toEqual({
      ok: false,
      reason: "wrong_scope",
    });
    const { event: declined } = await normalized(activity("decline"));
    expect(decide(declined!)).toEqual({
      ok: true,
      action: "decline",
      activityId: "activity-1",
    });
  });

  it("retains normalization when an accept races the card receipt; it does not grant upload or card resend", async () => {
    const { event, callback } = await normalized();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(event).toMatchObject({
      action: "accept",
      token: binding.token,
      uploadStatus: "available",
    });
    for (const phase of ["consent_sending", "consent_unknown"] as const) {
      expect(decide(event!, { phase })).toEqual({
        ok: false,
        reason: "not_awaiting_consent",
      });
      expect(nextTeamsFileConsentPhase(phase, "accept")).toBeNull();
      expect(nextTeamsFileConsentPhase(phase, "send_consent")).toBeNull();
    }
    // The future durable caller buffers the encrypted capability, then may
    // reconsider this exact response after resolving the card receipt.
    expect(decide(event!)).toMatchObject({ ok: true, action: "accept" });
  });

  it.each([
    [
      "channel",
      (a: ReturnType<typeof activity>) => {
        a.conversation.conversationType = "channel";
      },
    ],
    [
      "missing personal scope",
      (a: ReturnType<typeof activity>) => {
        delete (a.conversation as Partial<typeof a.conversation>)
          .conversationType;
      },
    ],
    [
      "conflicting tenant",
      (a: ReturnType<typeof activity>) => {
        a.channelData.tenant.id = uuid(90);
      },
    ],
    [
      "foreign tenant",
      (a: ReturnType<typeof activity>) => {
        a.conversation.tenantId = uuid(90);
      },
    ],
    [
      "wrong bot",
      (a: ReturnType<typeof activity>) => {
        a.recipient.id = `28:${uuid(90)}`;
      },
    ],
    [
      "missing actor",
      (a: ReturnType<typeof activity>) => {
        a.from.aadObjectId = "";
      },
    ],
    [
      "action swap",
      (a: ReturnType<typeof activity>) => {
        a.value.context.action = "decline";
      },
    ],
    [
      "extra context",
      (a: ReturnType<typeof activity>) => {
        Object.assign(a.value.context, { uploadUrl });
      },
    ],
    [
      "contradictory personal team",
      (a: ReturnType<typeof activity>) => {
        Object.assign(a.channelData, { team: { id: "team-1" } });
      },
    ],
  ])("denies %s before a normalized callback", async (_name, mutate) => {
    const raw = activity();
    mutate(raw);
    const { callback, response } = await normalized(raw);
    expect(callback).not.toHaveBeenCalled();
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it.each([
    "https://sharepoint.com/upload",
    "https://evilsharepoint.com/upload",
    "https://contoso.sharepoint.com.evil.test/upload",
    "https://contoso.sharepoint.com./upload",
    "https://sn3302.up.1drv.com/upload",
    "https://127.0.0.1/upload",
    "https://[::1]/upload",
    "https://storageaccount.blob.core.windows.net/upload",
  ])("returns a non-leaking unsupported-host outcome for %s", async (url) => {
    const { event } = await normalized(
      activity("accept", {
        ...uploadInfo,
        uploadUrl: `${url}?secret=PRIVATE-UPLOAD-CANARY`,
      }),
    );
    expect(decide(event!)).toEqual({
      ok: false,
      reason: "unsupported_upload_host",
    });
    expect(JSON.stringify(event)).not.toContain("PRIVATE-UPLOAD-CANARY");
    expect(inspect(event)).not.toContain("PRIVATE-UPLOAD-CANARY");
  });

  it.each([
    { uploadUrl: "http://contoso.sharepoint.com/upload" },
    { uploadUrl: "https://contoso.sharepoint.com:444/upload" },
    { uploadUrl: "https://user:secret@contoso.sharepoint.com/upload" },
    { uploadUrl: `${uploadUrl}#fragment` },
    { uploadUrl: `${uploadUrl}\n` },
    { contentUrl: `${contentUrl}?secret=PRIVATE-UPLOAD-CANARY` },
    { uploadUrl: "x".repeat(8193) },
    { extra: "unknown" },
    { uniqueId: "" },
  ])(
    "rejects malformed or secret-bearing public descriptors %#",
    async (override) => {
      const { event } = await normalized(
        activity("accept", { ...uploadInfo, ...override }),
      );
      expect(decide(event!)).toEqual({
        ok: false,
        reason: "invalid_upload_info",
      });
    },
  );

  it("keeps a capability opaque and bounds it to the exact accepted binding", async () => {
    const upload = await accepted();
    expect(JSON.stringify({ upload })).toBe("{}");
    expect(inspect(upload)).not.toContain("PRIVATE-UPLOAD-CANARY");
    expect(() =>
      buildTeamsUploadedFileCard(upload, { kind: "uploaded" }),
    ).toThrow("not confirmed");
    const request = vi.fn();
    await expect(
      exchangeTeamsFileUpload({
        upload,
        binding: { ...binding, attachmentId: uuid(99) },
        operation: "put",
        bytes,
        authorize: async () => {},
        request,
      }),
    ).rejects.toThrow("binding");
    await expect(
      exchangeTeamsFileUpload({
        upload,
        binding,
        operation: "put",
        bytes: Buffer.from("edited"),
        authorize: async () => {},
        request,
      }),
    ).rejects.toThrow("bytes");
    expect(request).not.toHaveBeenCalled();
    await expect(
      upload.exchange("put", Buffer.from("edited"), {
        byteSize: binding.byteSize,
        authorize: async () => {},
        request,
      }),
    ).rejects.toThrow("bytes");
    await expect(
      upload.exchange("put", bytes, {
        byteSize: 1,
        authorize: async () => {},
        request,
      }),
    ).rejects.toThrow("binding");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([200, 201])(
    "uses exact bytes, no bearer, and a confirmed PUT %i before the file-info card",
    async (status) => {
      const upload = await accepted();
      const authorize = vi.fn(async () => {});
      const request = vi.fn<UploadRequest>(async () =>
        Response.json(
          { id: "item-1", name: "report.txt", size: bytes.length },
          { status },
        ),
      );
      const outcome = await exchangeTeamsFileUpload({
        upload,
        binding,
        operation: "put",
        bytes,
        authorize,
        request,
      });
      expect(outcome).toEqual({ kind: "uploaded" });
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]).toMatchObject([
        uploadUrl,
        {
          method: "PUT",
          redirect: "manual",
          body: bytes,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": "6",
            "Content-Range": "bytes 0-5/6",
          },
        },
        { connectTimeoutMs: 10_000, responseTimeoutMs: 30_000 },
      ]);
      expect(JSON.stringify(request.mock.calls[0]?.[1])).not.toMatch(
        /authorization/i,
      );
      expect(buildTeamsUploadedFileCard(upload, outcome)).toEqual({
        contentType: "application/vnd.microsoft.teams.card.file.info",
        name: "report.txt",
        contentUrl,
        content: { uniqueId: "item-1", fileType: "txt" },
      });
      await exchangeTeamsFileUpload({
        upload,
        binding,
        operation: "put",
        bytes,
        authorize,
        request,
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "<html>Sign in</html>",
    "",
    "{}",
    JSON.stringify({ id: "other", name: "report.txt", size: bytes.length }),
    JSON.stringify({ id: "item-1", name: "other.txt", size: bytes.length }),
    JSON.stringify({
      id: "item-1",
      name: "report.txt",
      size: bytes.length - 1,
    }),
    JSON.stringify({
      id: "item-1",
      name: "report.txt",
      size: String(bytes.length),
    }),
  ])(
    "does not treat unbound successful HTTP response %# as an uploaded file",
    async (body) => {
      const upload = await accepted();
      const request = vi.fn(
        async () =>
          new Response(body, {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
      );
      expect(
        await exchangeTeamsFileUpload({
          upload,
          binding,
          operation: "put",
          bytes,
          authorize: async () => {},
          request,
        }),
      ).toEqual({ kind: "uncertain", reason: "response_invalid" });
      expect(() =>
        buildTeamsUploadedFileCard(upload, { kind: "uploaded" }),
      ).toThrow();
    },
  );

  it("does not accept a non-JSON successful response as a driveItem receipt", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "item-1",
            name: "report.txt",
            size: bytes.length,
          }),
          { status: 201, headers: { "Content-Type": "text/html" } },
        ),
    );
    expect(
      await exchangeTeamsFileUpload({
        upload: await accepted(),
        binding,
        operation: "put",
        bytes,
        authorize: async () => {},
        request,
      }),
    ).toEqual({ kind: "uncertain", reason: "response_invalid" });
  });

  it("normalizes GUID case only, not case-sensitive opaque drive item IDs", async () => {
    const id = "aabbccdd-eeee-4444-aaaa-bbbbbbbbbbbb";
    const upload = await accepted({ ...uploadInfo, uniqueId: id });
    const request = vi.fn(async () =>
      Response.json(
        { id: id.toUpperCase(), name: "report.txt", size: bytes.length },
        { status: 201 },
      ),
    );
    expect(
      await exchangeTeamsFileUpload({
        upload,
        binding,
        operation: "put",
        bytes,
        authorize: async () => {},
        request,
      }),
    ).toEqual({ kind: "uploaded" });
    const opaque = await accepted({ ...uploadInfo, uniqueId: "SensitiveAbC" });
    const wrong = vi.fn(async () =>
      Response.json(
        { id: "sensitiveabc", name: "report.txt", size: bytes.length },
        { status: 201 },
      ),
    );
    expect(
      await exchangeTeamsFileUpload({
        upload: opaque,
        binding,
        operation: "put",
        bytes,
        authorize: async () => {},
        request: wrong,
      }),
    ).toEqual({ kind: "uncertain", reason: "response_invalid" });
  });

  it("snapshots bytes before asynchronous authorization and refuses concurrent duplicate PUTs", async () => {
    const upload = await accepted();
    const original = Buffer.from(bytes);
    let authorize!: () => void;
    const gate = new Promise<void>((resolve) => {
      authorize = resolve;
    });
    const request = vi.fn<UploadRequest>(async () =>
      Response.json(
        { id: "item-1", name: "report.txt", size: bytes.length },
        { status: 201 },
      ),
    );
    const first = upload.exchange("put", original, {
      byteSize: binding.byteSize,
      authorize: () => gate,
      request,
    });
    const second = upload.exchange("put", original, {
      byteSize: binding.byteSize,
      authorize: () => gate,
      request,
    });
    original.fill(0);
    authorize();
    const outcomes = await Promise.all([first, second]);
    expect(outcomes).toContainEqual({ kind: "uploaded" });
    expect(outcomes).toContainEqual({
      kind: "uncertain",
      reason: "put_already_attempted",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1].body).toEqual(bytes);
  });

  it("preserves a lost final PUT acknowledgement and does not resend or infer failure from status 404", async () => {
    const upload = await accepted();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error(uploadUrl))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const input = { upload, binding, authorize: async () => {}, request };
    expect(
      await exchangeTeamsFileUpload({ ...input, operation: "put", bytes }),
    ).toEqual({
      kind: "uncertain",
      reason: "transport_or_authorization_failed",
    });
    expect(
      await exchangeTeamsFileUpload({ ...input, operation: "put", bytes }),
    ).toEqual({ kind: "uncertain", reason: "put_already_attempted" });
    expect(
      await exchangeTeamsFileUpload({ ...input, operation: "status" }),
    ).toEqual({ kind: "uncertain", reason: "session_unavailable" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      headers: {},
    });
    expect(() =>
      buildTeamsUploadedFileCard(upload, { kind: "uploaded" }),
    ).toThrow();
  });

  it.each(["status", "put"] as const)(
    "recognizes bounded missing ranges for %s without claiming delivery or retrying",
    async (operation) => {
      const upload = await accepted();
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      const request = vi.fn(async () =>
        Response.json(
          { expirationDateTime: expiresAt, nextExpectedRanges: ["0-2", "5-"] },
          { status: operation === "put" ? 202 : 200 },
        ),
      );
      expect(
        await exchangeTeamsFileUpload({
          upload,
          binding,
          operation,
          bytes,
          authorize: async () => {},
          request,
        }),
      ).toEqual({
        kind: "incomplete",
        expiresAt,
        missingRanges: [
          { start: 0, end: 2 },
          { start: 5, end: 5 },
        ],
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [],
    ["0-6"],
    ["2-1"],
    ["0-2", "2-"],
    ["1-", "0-"],
    ["01-"],
    ["9007199254740992-"],
    Array(129).fill("0-"),
  ])(
    "rejects malformed, overlapping or excessive status ranges %#",
    async (ranges) => {
      const request = vi.fn(async () =>
        Response.json({
          expirationDateTime: binding.expiresAt,
          nextExpectedRanges: ranges,
        }),
      );
      expect(
        await exchangeTeamsFileUpload({
          upload: await accepted(),
          binding,
          operation: "status",
          authorize: async () => {},
          request,
        }),
      ).toEqual({ kind: "uncertain", reason: "response_invalid" });
    },
  );

  it.each([302, 400, 401, 403, 409, 429, 500])(
    "does not follow, resend, or claim success on PUT status %i",
    async (status) => {
      const request = vi.fn(
        async () =>
          new Response(uploadUrl, {
            status,
            headers: { location: "http://127.0.0.1/secret" },
          }),
      );
      const outcome = await exchangeTeamsFileUpload({
        upload: await accepted(),
        binding,
        operation: "put",
        bytes,
        authorize: async () => {},
        request,
      });
      expect(outcome).toEqual({
        kind: "uncertain",
        reason: "provider_response",
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(outcome)).not.toContain("PRIVATE-UPLOAD-CANARY");
    },
  );

  it("cancels an oversized response and bounds a stalled stream", async () => {
    const cancel = vi.fn();
    let request = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(65537));
            },
            cancel,
          }),
        ),
    );
    expect(
      await exchangeTeamsFileUpload({
        upload: await accepted(),
        binding,
        operation: "put",
        bytes,
        authorize: async () => {},
        request,
      }),
    ).toEqual({ kind: "uncertain", reason: "response_invalid" });
    expect(cancel).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    request = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    const pending = exchangeTeamsFileUpload({
      upload: await accepted(),
      binding,
      operation: "put",
      bytes,
      authorize: async () => {},
      request,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({
      kind: "uncertain",
      reason: "response_invalid",
    });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("rechecks expiry after delayed authorization and does not launch after an aborted authorization wait", async () => {
    vi.useFakeTimers();
    const request = vi.fn();
    const pending = exchangeTeamsFileUpload({
      upload: await accepted(),
      binding,
      operation: "put",
      bytes,
      authorize: () => new Promise<void>(() => {}),
      request,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({
      kind: "uncertain",
      reason: "transport_or_authorization_failed",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("checks consent expiry again after current authorization finishes", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const shortBinding = {
      ...binding,
      expiresAt: new Date(now + 20).toISOString(),
    };
    const { event } = await normalized();
    const decision = decide(event!, {
      stored: shortBinding,
      current: shortBinding,
    });
    if (!decision.ok || decision.action !== "accept")
      throw new Error("Invalid fixture");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn();
    const pending = exchangeTeamsFileUpload({
      upload: decision.upload,
      binding: shortBinding,
      operation: "put",
      bytes,
      authorize: () => gate,
      request,
    });
    await vi.advanceTimersByTimeAsync(21);
    release();
    expect(await pending).toEqual({
      kind: "uncertain",
      reason: "session_unavailable",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"])(
    "uses the real DNS-pinned guard to reject SharePoint DNS resolving to %s before upload",
    async (address) => {
      const lookup = vi
        .mocked(dns.lookup)
        .mockReset()
        .mockResolvedValue([
          { address, family: address === "::1" ? 6 : 4 },
        ] as never);
      const outcome = await exchangeTeamsFileUpload({
        upload: await accepted(),
        binding,
        operation: "put",
        bytes,
        authorize: async () => {},
      });
      expect(outcome).toEqual({
        kind: "uncertain",
        reason: "transport_or_authorization_failed",
      });
      expect(lookup).toHaveBeenCalledTimes(1);
    },
  );
});
