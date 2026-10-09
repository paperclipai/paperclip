import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "chat";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  canonicalGitHubAttachmentUrl,
  githubAttachmentCommentRequest,
  githubAttachmentCommentFetch,
  githubAttachmentDiagnosticCode,
  githubAttachmentLocator,
  githubAttachmentLimitOmissions,
  githubPublicAttachmentsFromMessage,
  prepareGitHubPublicAttachment,
  rehydrateGitHubPublicAttachment,
  restoreGitHubAttachmentLimitOmissions,
  resolveGitHubCommentAttachmentTarget,
} from "./chat-github-attachments.js";
import { createChatSdkEndpointRuntime } from "./chat-sdk-runtime.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";

vi.mock("./remote-http-fetch.js", () => ({ guardedRemoteHttpFetch: vi.fn() }));
const request = vi.mocked(guardedRemoteHttpFetch);
const imageUrl =
  "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555";
const fileUrl = "https://github.com/user-attachments/files/31917991/proof.txt";
const threadId = "github:paperclipai/chat-e2e:issue:42";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
function message(overrides: Record<string, unknown> = {}): Message {
  return {
    id: "4242",
    threadId,
    formatted: {
      type: "root",
      children: [
        { type: "image", url: imageUrl },
        { type: "link", url: fileUrl },
      ],
    },
    raw: {
      type: "issue_comment",
      prNumber: 42,
      threadType: "issue",
      repository: { full_name: "paperclipai/chat-e2e" },
      comment: { id: 4242, body: `![Image](${imageUrl}) [proof](${fileUrl})` },
    },
    ...overrides,
  } as unknown as Message;
}
function attachment() {
  return githubPublicAttachmentsFromMessage(message())[0]!;
}
function fileAttachment() {
  return githubPublicAttachmentsFromMessage(message())[1]!;
}
afterEach(() => {
  vi.restoreAllMocks();
  request.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const signedImageUrl =
  "https://private-user-images.githubusercontent.com/123/456-11111111-2222-3333-4444-555555555555.png?jwt=header.payload.signature";
function canonicalComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 4242,
    url: "https://api.github.com/repos/paperclipai/chat-e2e/issues/comments/4242",
    issue_url: "https://api.github.com/repos/paperclipai/chat-e2e/issues/42",
    body: (message().raw as { comment: { body: string } }).comment.body,
    body_html: `<p><a href="${imageUrl}"><img src="${signedImageUrl}"></a><a href="${fileUrl}">proof</a></p>`,
    ...overrides,
  };
}

describe("GitHub exact-comment private image resolution", () => {
  it("imports the live-observed exact signed anchor and image after locator restart", async () => {
    const value = message();
    const raw = value.raw as { comment: { body: string } };
    raw.comment.body = `<img width="512" alt="Image" src="${imageUrl}" />`;
    const saved = JSON.parse(
      JSON.stringify(
        githubAttachmentLocator(githubPublicAttachmentsFromMessage(value)[0]!),
      ),
    );
    const recovered = rehydrateGitHubPublicAttachment(saved, {
      threadId,
      messageId: "4242",
    })!;
    const canonical = canonicalComment({
      body: raw.comment.body,
      body_html: `<a href="${signedImageUrl}"><img src="${signedImageUrl}"></a>`,
    });
    request.mockResolvedValueOnce(new Response("private", { status: 404 }));
    request.mockResolvedValueOnce(
      new Response(png, { headers: { "content-type": "image/png" } }),
    );
    const prepared = await prepareGitHubPublicAttachment(
      recovered,
      undefined,
      async () => canonical,
    );
    expect(await prepared.fetchData!()).toEqual(png);
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1]![0])).toBe(signedImageUrl);
    for (const [, init] of request.mock.calls) {
      expect(init.credentials).toBe("omit");
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(new Headers(init.headers).has("cookie")).toBe(false);
    }
    expect(JSON.stringify([saved, prepared])).not.toMatch(
      /jwt|body_html|private-user-images/,
    );
    expect(githubAttachmentLocator(recovered)).toEqual(saved);
  });
  it.each([
    [
      "duplicate_signed",
      `<a href="${signedImageUrl}"><img src="${signedImageUrl}"></a>`.repeat(2),
    ],
    [
      "mixed_original_signed",
      `<a href="${imageUrl}"><img src="${signedImageUrl}"></a><a href="${signedImageUrl}"><img src="${signedImageUrl}"></a>`,
    ],
    [
      "conflicting_jwt",
      `<a href="${signedImageUrl.replace("header", "other")}"><img src="${signedImageUrl}"></a>`,
    ],
    [
      "different_uuid",
      `<a href="${signedImageUrl}"><img src="${signedImageUrl.replace("11111111", "99999999")}"></a>`,
    ],
    [
      "different_host",
      `<a href="https://example.com/image"><img src="${signedImageUrl}"></a>`,
    ],
    [
      "multiple_images",
      `<a href="${signedImageUrl}"><img src="${signedImageUrl}"><img src="${signedImageUrl.replace("11111111", "99999999")}"></a>`,
    ],
    [
      "mixed_malformed_signed",
      `<a href="${imageUrl}"><img src="${signedImageUrl}"></a><a href="${signedImageUrl}"></a>`,
    ],
    [
      "extra_unanchored_image",
      `<a href="${signedImageUrl}"><img src="${signedImageUrl}"></a><img src="${signedImageUrl}">`,
    ],
    [
      "extra_query",
      `<a href="${signedImageUrl}&amp;token=extra"><img src="${signedImageUrl}&amp;token=extra"></a>`,
    ],
  ])(
    "denies ambiguous or untrusted live signed mapping %s",
    async (_name, body_html) => {
      const canonical = canonicalComment({ body_html });
      expect(
        resolveGitHubCommentAttachmentTarget(attachment(), canonical),
      ).toBeNull();
      request.mockResolvedValueOnce(new Response("private", { status: 404 }));
      await expect(
        prepareGitHubPublicAttachment(
          attachment(),
          undefined,
          async () => canonical,
        ),
      ).rejects.toMatchObject({ name: "GitHubAttachmentUnavailableError" });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a user-embedded signed URL even when the exact source-body hash matches", async () => {
    const value = message();
    const raw = value.raw as { comment: { body: string } };
    raw.comment.body += `\n<a href="${signedImageUrl}"><img src="${signedImageUrl}"></a>`;
    const image = githubPublicAttachmentsFromMessage(value)[0]!;
    const canonical = canonicalComment({
      body: raw.comment.body,
      body_html: `<a href="${signedImageUrl}"><img src="${signedImageUrl}"></a>`,
    });
    expect(resolveGitHubCommentAttachmentTarget(image, canonical)).toBeNull();
    request.mockResolvedValueOnce(new Response("private", { status: 404 }));
    await expect(
      prepareGitHubPublicAttachment(image, undefined, async () => canonical),
    ).rejects.toMatchObject({
      code: "github_attachment_canonical_target_denied",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(
    [
      [null, "response_unavailable"],
      [canonicalComment({ id: 9999 }), "source_mismatch"],
      [canonicalComment({ body: "changed source body" }), "body_mismatch"],
      [canonicalComment({ body_html: null }), "html_unavailable"],
      [canonicalComment({ body_html: "<p>No image</p>" }), "anchor_missing"],
      [
        canonicalComment({ body_html: `<a href="${imageUrl}"></a>` }),
        "image_count_invalid",
      ],
      [
        canonicalComment({
          body_html: `<a href="${imageUrl}"><img src="https://127.0.0.1/private?token=secret"></a>`,
        }),
        "target_denied",
      ],
      [
        canonicalComment({
          body_html: `<a href="${imageUrl}"><img src="${signedImageUrl}"></a><a href="${imageUrl}"><img src="${signedImageUrl}"></a>`,
        }),
        "mapping_ambiguous",
      ],
      [
        canonicalComment({ body_html: `<img src="${signedImageUrl}">` }),
        "image_without_source_anchor",
      ],
    ].map(([value, suffix]) => ({ value, suffix })),
  )(
    "returns only a closed diagnostic for canonical $suffix failure",
    async ({ value, suffix }) => {
      request.mockResolvedValueOnce(new Response("private", { status: 404 }));
      const error = await prepareGitHubPublicAttachment(
        attachment(),
        undefined,
        async () => value,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(error).toMatchObject({
        code: `github_attachment_canonical_${suffix}`,
        message: `github_attachment_canonical_${suffix}`,
      });
      expect(JSON.stringify(error)).not.toMatch(
        /https:|jwt|token|body_html|privatepayload/,
      );
      expect(request).toHaveBeenCalledTimes(1);
      expect(
        resolveGitHubCommentAttachmentTarget(attachment(), value),
      ).toBeNull();
    },
  );
  it("preserves only exact closed SDK cause codes with bounded traversal", () => {
    const code = "github_attachment_canonical_api_access_denied";
    expect(
      githubAttachmentDiagnosticCode(
        new Error(`outer ${signedImageUrl}`, {
          cause: new Error(code),
        }),
      ),
    ).toBe(code);
    expect(
      githubAttachmentDiagnosticCode(new Error(`${code}: ${signedImageUrl}`)),
    ).toBeNull();
    expect(
      githubAttachmentDiagnosticCode({
        message: code,
        request: { authorization: "secret" },
      }),
    ).toBeNull();
    const cyclic = new Error("unknown secret");
    cyclic.cause = cyclic;
    expect(githubAttachmentDiagnosticCode(cyclic)).toBeNull();
  });
  it.each([
    { version: 2 },
    { sourceBodySha256: "a".repeat(64) },
    { version: 3, sourceBodySha256: "a".repeat(64) },
    { version: 2, sourceBodySha256: "invalid" },
  ])("does not upgrade malformed legacy descriptors %j", (extra) => {
    const {
      version: _version,
      sourceBodySha256: _hash,
      ...legacy
    } = githubAttachmentLocator(attachment())!;
    expect(
      rehydrateGitHubPublicAttachment(
        { ...legacy, ...extra },
        { threadId, messageId: "4242" },
      ),
    ).toBeNull();
  });
  it("uses an exact source/body-bound canonical rendering after restart without persisting signed targets", async () => {
    const original = attachment();
    const saved = JSON.parse(JSON.stringify(githubAttachmentLocator(original)));
    const recovered = rehydrateGitHubPublicAttachment(saved, {
      threadId,
      messageId: "4242",
    })!;
    const resolve = vi.fn(async () => canonicalComment());
    request.mockResolvedValueOnce(new Response("private", { status: 404 }));
    request.mockResolvedValueOnce(
      new Response(png, { headers: { "content-type": "image/png" } }),
    );
    const prepared = await prepareGitHubPublicAttachment(
      recovered,
      undefined,
      resolve,
    );
    expect(await prepared.fetchData!()).toEqual(png);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(
      {
        url: canonicalComment().url,
        accept: "application/vnd.github.full+json",
      },
      expect.any(AbortSignal),
    );
    expect(String(request.mock.calls[1]![0])).toBe(signedImageUrl);
    for (const [, init] of request.mock.calls) {
      expect(init.credentials).toBe("omit");
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(new Headers(init.headers).has("cookie")).toBe(false);
    }
    expect(JSON.stringify(saved)).not.toContain("jwt");
    expect(JSON.stringify(prepared)).not.toContain("jwt");
    expect(githubAttachmentLocator(recovered)).toEqual(saved);
  });
  it("keeps old anonymous descriptors readable without granting canonical App reads", async () => {
    const original = githubAttachmentLocator(attachment())!;
    const { version: _version, sourceBodySha256: _hash, ...legacy } = original;
    const recovered = rehydrateGitHubPublicAttachment(legacy, {
      threadId,
      messageId: "4242",
    })!;
    const resolve = vi.fn();
    request.mockResolvedValueOnce(new Response("private", { status: 404 }));
    await expect(
      prepareGitHubPublicAttachment(recovered, undefined, resolve),
    ).rejects.toMatchObject({ code: "github_attachment_not_public" });
    expect(resolve).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(
      new Response(png, { headers: { "content-type": "image/png" } }),
    );
    expect(
      await (
        await prepareGitHubPublicAttachment(recovered)
      ).fetchData!(),
    ).toEqual(png);
  });
  it.each([
    { id: 4243 },
    { body: "edited body" },
    { issue_url: "https://api.github.com/repos/other/repo/issues/42" },
    {
      url: "https://api.github.com/repos/paperclipai/chat-e2e/issues/comments/4243",
    },
    {
      body_html: `<a href="${imageUrl}"><img src="${signedImageUrl}"><img src="${signedImageUrl}"></a>`,
    },
    {
      body_html: `<a href="${imageUrl}"><img src="${signedImageUrl}"></a><a href="${imageUrl}"><img src="${signedImageUrl}"></a>`,
    },
    { body_html: `<a href="${fileUrl}"><img src="${signedImageUrl}"></a>` },
    {
      body_html: `<a href="${imageUrl}"><img src="https://127.0.0.1/x?jwt=secret"></a>`,
    },
    {
      body_html: `<a href="${imageUrl}"><img src="${signedImageUrl.replace("11111111", "99999999")}"></a>`,
    },
    {
      body_html: `<a href="${imageUrl}"><img src="${signedImageUrl}&amp;token=extra"></a>`,
    },
  ])("denies mismatched or ambiguous canonical response %j", (override) => {
    expect(
      resolveGitHubCommentAttachmentTarget(
        attachment(),
        canonicalComment(override),
      ),
    ).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it("does not treat a private generic-file anchor as downloadable", async () => {
    const resolve = vi.fn(async () => canonicalComment());
    request.mockResolvedValue(new Response("private", { status: 404 }));
    await expect(
      prepareGitHubPublicAttachment(fileAttachment(), undefined, resolve),
    ).rejects.toMatchObject({
      code: "github_attachment_canonical_file_unsupported",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("uses the documented review-comment media type and exact review-root binding", () => {
    const value = message({
      threadId: "github:paperclipai/chat-e2e:42:rc:4000",
    });
    const raw = value.raw as Record<string, unknown>;
    raw.type = "review_comment";
    (raw.comment as Record<string, unknown>).in_reply_to_id = 4000;
    const image = githubPublicAttachmentsFromMessage(value)[0]!;
    const requestDescriptor = githubAttachmentCommentRequest(image)!;
    expect(requestDescriptor).toEqual({
      url: "https://api.github.com/repos/paperclipai/chat-e2e/pulls/comments/4242",
      accept: "application/vnd.github-commitcomment.full+json",
    });
    const response = canonicalComment({
      url: requestDescriptor.url,
      pull_request_url:
        "https://api.github.com/repos/paperclipai/chat-e2e/pulls/42",
      in_reply_to_id: 4000,
    });
    expect(resolveGitHubCommentAttachmentTarget(image, response)?.href).toBe(
      signedImageUrl,
    );
    expect(
      resolveGitHubCommentAttachmentTarget(image, {
        ...response,
        in_reply_to_id: 3999,
      }),
    ).toBeNull();
  });
  it("closes the authenticated fetch to one API route and never follows its redirects", async () => {
    const expected = githubAttachmentCommentRequest(attachment())!;
    const fetch = githubAttachmentCommentFetch(
      expected,
      new AbortController().signal,
    );
    for (const url of [
      signedImageUrl,
      expected.url + "?token=secret",
      expected.url.replace("4242", "4243"),
    ])
      await expect(fetch(url, { method: "GET" })).rejects.toMatchObject({
        code: "github_attachment_source_mismatch",
      });
    expect(request).not.toHaveBeenCalled();
    const forged = { ...expected, url: "https://evil.invalid/attachment" };
    await expect(
      githubAttachmentCommentFetch(forged, new AbortController().signal)(
        forged.url,
        {
          method: "GET",
          headers: { accept: forged.accept, authorization: "token test-only" },
        },
      ),
    ).rejects.toMatchObject({ code: "github_attachment_source_mismatch" });
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: signedImageUrl },
      }),
    );
    await expect(
      fetch(expected.url, {
        method: "GET",
        headers: { accept: expected.accept, authorization: "token test-only" },
      }),
    ).rejects.toMatchObject({
      code: "github_attachment_canonical_api_status_unexpected",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({
      redirect: "manual",
      credentials: "omit",
    });
  });
  it("bounds authenticated HTML response bytes and redacts provider errors", async () => {
    const expected = githubAttachmentCommentRequest(attachment())!;
    request.mockResolvedValue(
      new Response("x", {
        headers: {
          "content-type": "application/json",
          "content-length": "1048577",
        },
      }),
    );
    await expect(
      githubAttachmentCommentFetch(expected, new AbortController().signal)(
        expected.url,
        { method: "GET", headers: { accept: expected.accept } },
      ),
    ).rejects.toMatchObject({
      message: "github_attachment_canonical_api_too_large",
    });
    request.mockResolvedValue(new Response("private", { status: 404 }));
    await expect(
      prepareGitHubPublicAttachment(attachment(), undefined, async () => {
        throw new Error(signedImageUrl);
      }),
    ).rejects.toMatchObject({ message: "github_attachment_download_failed" });
  });
  it.each(["original", "signed"] as const)(
    "actual SDK App auth sends installation credentials only to fixed canonical comment API for %s anchor",
    async (shape) => {
      const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      const providerFetch = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          Response.json(
            {
              token: "ghs-test-only",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              permissions: { issues: "read" },
              repository_selection: "selected",
            },
            { status: 201 },
          ),
      );
      vi.stubGlobal("fetch", providerFetch);
      const canonical = canonicalComment({
        body_html: `<a href="${shape === "signed" ? signedImageUrl : imageUrl}"><img src="${signedImageUrl}"></a>`,
      });
      request.mockResolvedValue(Response.json(canonical));
      const runtime = createChatSdkEndpointRuntime({
        companyId: "company-test",
        endpointId: "endpoint-test",
        logger: "silent",
        callbacks: { onMessage() {} },
        persistence: {
          async compareAndSet() {
            return true;
          },
          async deleteIfVersion() {
            return true;
          },
          async read() {
            return null;
          },
        },
        providerConfig: {
          provider: "github",
          userName: "maya",
          credentials: {
            appId: "123",
            installationId: 2468,
            botUserId: 999,
            privateKey,
            webhookSecret: "test-only",
          },
        },
      });
      try {
        const result = await runtime.resolveGitHubAttachmentComment(
          githubAttachmentCommentRequest(attachment())!,
          new AbortController().signal,
        );
        expect(result).toEqual(canonical);
        expect(
          resolveGitHubCommentAttachmentTarget(attachment(), result)?.href,
        ).toBe(signedImageUrl);
        expect(providerFetch).toHaveBeenCalledTimes(1);
        expect(String(providerFetch.mock.calls[0]?.[0])).toBe(
          "https://api.github.com/app/installations/2468/access_tokens",
        );
        expect(request).toHaveBeenCalledTimes(1);
        expect(String(request.mock.calls[0]![0])).toBe(canonicalComment().url);
        expect(
          new Headers(request.mock.calls[0]![1].headers).get("authorization"),
        ).toBe("token ghs-test-only");
        request.mockResolvedValueOnce(new Response("private", { status: 404 }));
        request.mockResolvedValueOnce(Response.json(canonical));
        request.mockResolvedValueOnce(
          new Response(png, { headers: { "content-type": "image/png" } }),
        );
        const prepared = await prepareGitHubPublicAttachment(
          attachment(),
          undefined,
          (descriptor, signal) =>
            runtime.resolveGitHubAttachmentComment(descriptor, signal),
        );
        expect(await prepared.fetchData!()).toEqual(png);
        expect(request.mock.calls.slice(1).map(([url]) => String(url))).toEqual(
          [imageUrl, canonical.url, signedImageUrl],
        );
        for (const call of [request.mock.calls[1]!, request.mock.calls[3]!]) {
          expect(new Headers(call[1].headers).has("authorization")).toBe(false);
          expect(new Headers(call[1].headers).has("cookie")).toBe(false);
        }
        request.mockResolvedValueOnce(
          new Response("private response body", { status: 403 }),
        );
        await expect(
          runtime.resolveGitHubAttachmentComment(
            githubAttachmentCommentRequest(attachment())!,
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({
          message: "github_attachment_canonical_api_access_denied",
        });
        request.mockRejectedValueOnce(
          new Error(`private provider detail ${signedImageUrl}`),
        );
        await expect(
          runtime.resolveGitHubAttachmentComment(
            githubAttachmentCommentRequest(attachment())!,
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({
          message: "github_attachment_canonical_api_request_failed",
        });
      } finally {
        await runtime.shutdown();
      }
    },
  );
  it.each(["personal_token", "custom_host", "missing_installation"])(
    "does not resolve private attachments with %s authority",
    async (mode) => {
      const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      const providerFetch = vi.fn();
      vi.stubGlobal("fetch", providerFetch);
      const createRuntime = () =>
        createChatSdkEndpointRuntime({
          companyId: "company-test",
          endpointId: "endpoint-test",
          logger: "silent",
          callbacks: { onMessage() {} },
          persistence: {
            async compareAndSet() {
              return true;
            },
            async deleteIfVersion() {
              return true;
            },
            async read() {
              return null;
            },
          },
          providerConfig: {
            provider: "github",
            userName: "maya",
            credentials:
              mode === "personal_token"
                ? { token: "test-only-pat", webhookSecret: "test-only" }
                : {
                    appId: "123",
                    privateKey,
                    webhookSecret: "test-only",
                    botUserId: 999,
                    ...(mode === "missing_installation"
                      ? {}
                      : {
                          installationId: 2468,
                          apiUrl: "https://github.enterprise.invalid",
                        }),
                  },
          },
        });
      if (mode === "missing_installation") {
        expect(createRuntime).toThrow("Installation ID required");
        expect(providerFetch).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        return;
      }
      const runtime = createRuntime();
      try {
        await expect(
          runtime.resolveGitHubAttachmentComment(
            githubAttachmentCommentRequest(attachment())!,
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({
          code: "github_attachment_canonical_authority_unavailable",
        });
        expect(providerFetch).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
      } finally {
        await runtime.shutdown();
      }
    },
  );
});

describe("public GitHub attachment extraction", () => {
  it("extracts bounded current-comment references without fetching or carrying credentials", () => {
    const found = githubPublicAttachmentsFromMessage(message());
    expect(found).toHaveLength(2);
    expect(found[1]?.name).toBe("proof.txt");
    expect(found[0]?.fetchData).toBeUndefined();
    expect(githubAttachmentLocator(found[0]!)).toEqual({
      kind: "github_public_attachment",
      url: imageUrl,
      sourceThreadId: threadId,
      sourceMessageId: "4242",
      version: 2,
      sourceBodySha256: createHash("sha256")
        .update((message().raw as { comment: { body: string } }).comment.body)
        .digest("hex"),
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { id: "99" },
    { threadId: "github:other/repo:issue:42" },
    { threadId: "github:paperclipai/chat-e2e:issue:43" },
    { threadId: "github:paperclipai/chat-e2e:42:rc:4242" },
  ])("rejects forged source tuples %j", (override) => {
    expect(githubPublicAttachmentsFromMessage(message(override))).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
  it("does not import an AST URL absent from the actual current comment", () => {
    const value = message();
    (value.raw as { comment: { body: string } }).comment.body =
      "No file in this comment";
    expect(githubPublicAttachmentsFromMessage(value)).toEqual([]);
  });
  it("retains a bounded overflow count without extra descriptors or downloads", () => {
    const urls = Array.from(
      { length: 22 },
      (_, index) =>
        `https://github.com/user-attachments/files/${index + 1}/proof.txt`,
    );
    const value = message({
      formatted: {
        type: "root",
        children: [...urls, urls[0]!].map((url) => ({ type: "link", url })),
      },
    });
    (value.raw as { comment: { body: string } }).comment.body = urls.join("\n");
    expect(githubPublicAttachmentsFromMessage(value)).toHaveLength(20);
    expect(githubAttachmentLimitOmissions(value)).toBe(2);
    const restored = message();
    restoreGitHubAttachmentLimitOmissions(
      restored,
      JSON.parse(JSON.stringify(githubAttachmentLimitOmissions(value))),
    );
    expect(githubAttachmentLimitOmissions(restored)).toBe(2);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([-1, 0, 0.5, 10_001, Infinity, NaN, "2", {}, null])(
    "rejects malformed or unbounded omission counts %j",
    (count) => {
      const value = message();
      restoreGitHubAttachmentLimitOmissions(value, 2);
      restoreGitHubAttachmentLimitOmissions(value, count);
      expect(githubAttachmentLimitOmissions(value)).toBe(0);
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("handles HTML images and reference-style links but not code or unused definitions", () => {
    const value = message({
      formatted: {
        type: "root",
        children: [
          { type: "html", value: `<img width="400" src="${imageUrl}">` },
          { type: "linkReference", identifier: "proof" },
          { type: "definition", identifier: "proof", url: fileUrl },
          { type: "code", value: imageUrl },
          {
            type: "definition",
            identifier: "unused",
            url: imageUrl.replace("11111111", "99999999"),
          },
        ],
      },
    });
    (value.raw as { comment: { body: string } }).comment.body =
      `<img width="400" src="${imageUrl}"> [proof]\n[proof]: ${fileUrl}`;
    expect(githubPublicAttachmentsFromMessage(value)).toHaveLength(2);
  });
  it.each([
    imageUrl + "?jwt=private-secret",
    imageUrl + "#fragment",
    imageUrl.replace("https:", "http:"),
    imageUrl.replace("github.com", "github.com.evil.test"),
    imageUrl.replace("github.com", "user:secret@github.com"),
    imageUrl.replace("github.com", "github.com:8443"),
    "https://github.com/owner/repo/raw/main/file.png",
    "https://github.com/user-attachments/files/42/..%2fsecret",
    "https://127.0.0.1/user-attachments/files/42/file.txt",
  ])("rejects noncanonical or credential-bearing source %s", (url) => {
    expect(canonicalGitHubAttachmentUrl(url)).toBeNull();
  });
  it("rehydrates a stable descriptor only for the exact source after restart", () => {
    const original = attachment();
    const saved = JSON.parse(JSON.stringify(githubAttachmentLocator(original)));
    const recovered = rehydrateGitHubPublicAttachment(saved, {
      threadId,
      messageId: "4242",
    });
    expect(recovered).not.toBeNull();
    expect(githubAttachmentLocator(recovered!)).toEqual(saved);
    expect(
      rehydrateGitHubPublicAttachment(saved, { threadId, messageId: "4243" }),
    ).toBeNull();
    expect(
      rehydrateGitHubPublicAttachment(saved, {
        threadId: "github:other/repo:issue:42",
        messageId: "4242",
      }),
    ).toBeNull();
    expect(
      rehydrateGitHubPublicAttachment(
        { ...saved, authorization: "secret" },
        { threadId, messageId: "4242" },
      ),
    ).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("public GitHub attachment download", () => {
  it("imports exact public image bytes with actual MIME and a usable extension", async () => {
    request.mockResolvedValue(
      new Response(png, {
        headers: {
          "content-type": "image/png",
          "content-length": String(png.length),
        },
      }),
    );
    const result = await prepareGitHubPublicAttachment(attachment());
    expect(result).toMatchObject({
      type: "image",
      mimeType: "image/png",
      size: png.length,
    });
    expect(result.name).toMatch(/\.png$/);
    expect(await result.fetchData!()).toEqual(png);
    expect(request).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      }),
      expect.objectContaining({ allowPrivateNetwork: false }),
    );
    expect(Object.keys(request.mock.calls[0]![1].headers!)).toEqual([
      "accept",
      "user-agent",
    ]);
  });
  it("imports a public file and never persists a signed CDN redirect", async () => {
    const secretRedirect =
      "https://github-production-repository-file-5c1aeb.s3.amazonaws.com/42/file.txt?X-Amz-Signature=secret";
    request.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: secretRedirect },
      }),
    );
    request.mockResolvedValueOnce(
      new Response("exact public file", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
    const original = fileAttachment();
    const descriptor = JSON.stringify(githubAttachmentLocator(original));
    const result = await prepareGitHubPublicAttachment(original);
    expect(result).toMatchObject({
      name: "proof.txt",
      mimeType: "text/plain",
      type: "file",
    });
    expect((await result.fetchData!()).toString()).toBe("exact public file");
    expect(JSON.stringify(githubAttachmentLocator(original))).toBe(descriptor);
    expect(descriptor).not.toContain("Signature");
    expect(JSON.stringify(result)).not.toContain("secret");
    for (const [, init, guard] of request.mock.calls) {
      expect(init.credentials).toBe("omit");
      expect(init.headers).toEqual({
        accept: "*/*",
        "user-agent": "Paperclip/ChatAttachments",
      });
      expect(guard.allowPrivateNetwork).toBe(false);
    }
  });
  it.each([401, 403, 404])(
    "reports private/unavailable %s without credential retries",
    async (status) => {
      request.mockResolvedValue(
        new Response("secret provider body", { status }),
      );
      await expect(
        prepareGitHubPublicAttachment(attachment()),
      ).rejects.toMatchObject({
        code: "github_attachment_not_public",
        message: "github_attachment_not_public",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "https://localhost/file.png",
    "https://169.254.169.254/latest/meta-data/",
    "http://user-images.githubusercontent.com/file.png",
    "https://evil.test/file.png",
    "https://github.com/login",
    "https://user:secret@user-images.githubusercontent.com/file.png",
  ])("refuses unsafe redirects %s", async (location) => {
    request.mockResolvedValue(
      new Response(null, { status: 302, headers: { location } }),
    );
    await expect(
      prepareGitHubPublicAttachment(attachment()),
    ).rejects.toMatchObject({ code: "github_attachment_unsafe_redirect" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("bounds redirect count", async () => {
    request.mockImplementation(
      async () =>
        new Response(null, { status: 302, headers: { location: imageUrl } }),
    );
    await expect(
      prepareGitHubPublicAttachment(attachment()),
    ).rejects.toMatchObject({ code: "github_attachment_unsafe_redirect" });
    expect(request).toHaveBeenCalledTimes(4);
  });
  it.each([
    {
      body: "<html>login</html>",
      type: "text/html",
      code: "github_attachment_unsupported_type",
    },
    {
      body: "<!doctype html>login",
      type: "text/plain",
      code: "github_attachment_invalid_response",
    },
    {
      body: "not a png",
      type: "image/png",
      code: "github_attachment_invalid_response",
    },
    { body: "", type: "text/plain", code: "github_attachment_empty" },
    {
      body: "binary",
      type: "application/octet-stream",
      code: "github_attachment_unsupported_type",
    },
  ])(
    "rejects empty/error/wrong-MIME responses $code",
    async ({ body, type, code }) => {
      request.mockResolvedValue(
        new Response(body, { headers: { "content-type": type } }),
      );
      await expect(
        prepareGitHubPublicAttachment(fileAttachment()),
      ).rejects.toMatchObject({ code });
    },
  );
  it("rejects oversized Content-Length before reading the response", async () => {
    request.mockResolvedValue(
      new Response("small", {
        headers: {
          "content-type": "text/plain",
          "content-length": String(MAX_ATTACHMENT_BYTES + 1),
        },
      }),
    );
    await expect(
      prepareGitHubPublicAttachment(fileAttachment()),
    ).rejects.toMatchObject({ code: "github_attachment_too_large" });
  });
  it("caps streamed bytes even without Content-Length", async () => {
    request.mockResolvedValue(
      new Response(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), {
        headers: { "content-type": "text/plain" },
      }),
    );
    await expect(
      prepareGitHubPublicAttachment(fileAttachment()),
    ).rejects.toMatchObject({ code: "github_attachment_too_large" });
  });
  it("redacts network errors and denies unregistered attachments", async () => {
    request.mockRejectedValue(new Error("https://cdn.test?jwt=secret"));
    await expect(
      prepareGitHubPublicAttachment(attachment()),
    ).rejects.toMatchObject({ message: "github_attachment_download_failed" });
    await expect(
      prepareGitHubPublicAttachment({ type: "file", url: imageUrl }),
    ).rejects.toMatchObject({ code: "github_attachment_source_mismatch" });
  });
  it("uses the real DNS guard to reject a provider hostname resolving privately", async () => {
    const actual = await vi.importActual<
      typeof import("./remote-http-fetch.js")
    >("./remote-http-fetch.js");
    request.mockImplementation((url, init, options) =>
      actual.guardedRemoteHttpFetch(url, init, {
        ...options,
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        socketFactory: () => {
          throw new Error("must not dial a denied address");
        },
      }),
    );
    await expect(
      prepareGitHubPublicAttachment(attachment()),
    ).rejects.toMatchObject({ code: "github_attachment_download_failed" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("cancels a stalled response body at the total download deadline", async () => {
    const abort = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
    const cancel = vi.fn();
    request.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "text/plain" },
      }),
    );
    const result = prepareGitHubPublicAttachment(fileAttachment());
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    abort.abort(new Error("secret raw timeout detail"));
    await expect(result).rejects.toMatchObject({
      code: "github_attachment_download_failed",
      message: "github_attachment_download_failed",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("shares the batch deadline and never starts later requests after it expires", async () => {
    const batch = new AbortController();
    const cancel = vi.fn();
    request.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "text/plain" },
      }),
    );
    const first = prepareGitHubPublicAttachment(fileAttachment(), batch.signal);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    batch.abort(new Error("private deadline detail"));
    await expect(first).rejects.toMatchObject({
      code: "github_attachment_download_failed",
    });
    for (const next of [attachment(), fileAttachment()]) {
      await expect(
        prepareGitHubPublicAttachment(next, batch.signal),
      ).rejects.toMatchObject({
        code: "github_attachment_download_failed",
        message: "github_attachment_download_failed",
      });
    }
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
