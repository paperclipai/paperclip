import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubWebhookRecoveryError,
  getGitHubAppWebhookDelivery,
  getGitHubRecoveryComment,
  listGitHubAppWebhookDeliveries,
  readGitHubAppWebhookConfig,
  requestGitHubAppWebhookRedelivery,
  resyncGitHubAppWebhook,
} from "./chat-github-webhook-config.js";

const webhookUrl =
  "https://paperclip.example:8443/api/chat-webhooks/public-id/github";
const appToken = "test-app-jwt-private";
const webhookSecret = "test-webhook-secret-private";
const config = { url: webhookUrl, content_type: "json", insecure_ssl: "0" };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

function resync(fetch: typeof globalThis.fetch, url = webhookUrl) {
  return resyncGitHubAppWebhook({
    fetch,
    appToken,
    webhookSecret,
    webhookUrl: url,
  });
}

describe("GitHub App webhook reconnect", () => {
  it.each(["0", 0])(
    "reconciles only callback settings and accepts secure SSL %s",
    async (ssl) => {
      const fetch = vi.fn(async () =>
        json({ ...config, insecure_ssl: ssl, secret: "********" }),
      );
      await expect(resync(fetch)).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        "https://api.github.com/app/hook/config",
        {
          method: "PATCH",
          redirect: "error",
          signal: expect.any(AbortSignal),
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${appToken}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          body: JSON.stringify({ ...config, secret: webhookSecret }),
        },
      );
    },
  );

  it.each([302, 401, 403, 429, 500])(
    "does not expose provider bodies on HTTP %s",
    async (status) => {
      const fetch = vi.fn(async () =>
        json({ message: `${appToken} ${webhookSecret}` }, status),
      );
      const failure = await resync(fetch).catch(
        (error: Error) => error.message,
      );
      expect(failure).toContain(`HTTP ${status}`);
      expect(failure).not.toContain(appToken);
      expect(failure).not.toContain(webhookSecret);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("does not leak fetch/timeout details or automatically retry an uncertain mutation", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(`${appToken} ${webhookSecret}`);
    });
    await expect(resync(fetch)).rejects.toThrow(
      "configuration could not be confirmed",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { ...config, url: "https://unexpected.example/private-secret" },
    { ...config, content_type: "form" },
    { ...config, insecure_ssl: "1" },
    { ...config, insecure_ssl: false },
    {},
  ])(
    "fails closed when the applied configuration does not match",
    async (value) => {
      await expect(resync(async () => json(value))).rejects.toThrow(
        "did not confirm the expected secure Paperclip webhook",
      );
    },
  );

  it.each(["not-json-private-secret", "[]", "null", " ".repeat(32_769)])(
    "rejects unreadable/oversized successful bodies without echoing them",
    async (body) => {
      await expect(resync(async () => new Response(body))).rejects.toThrow(
        "GitHub returned an unreadable webhook configuration",
      );
    },
  );

  it.each([
    "http://paperclip.example/hook",
    "https://user:password@paperclip.example/hook",
    "https://paperclip.example/hook?private=secret",
    "https://paperclip.example/hook#secret",
  ])(
    "rejects unsafe callback inputs before sending credentials",
    async (url) => {
      const fetch = vi.fn(async () => json(config));
      await expect(resync(fetch, url)).rejects.toThrow(
        "configuration is incomplete",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

const deliveryId = "3841617089160847360";
const guid = "ab0f5340-abb3-11f1-9eed-2b258532ab82";
const deliveredAt = "2026-09-08T18:32:39.082Z";
const repositoryFullName = "paperclip/example";
const commentBody = "synthetic-private-comment-must-not-return";
const bodySha256 = createHash("sha256").update(commentBody).digest("hex");
const comment = {
  id: "9007199254740993",
  created_at: "2026-09-08T18:32:36Z",
  updated_at: "2026-09-08T18:32:36Z",
  body: commentBody,
  user: { id: "9007199254740995", type: "User", login: "private-login" },
  issue_url: "https://api.github.com/repos/paperclip/example/issues/3",
};
const delivery = {
  id: deliveryId,
  guid,
  delivered_at: deliveredAt,
  redelivery: false,
  status_code: 502,
  event: "issue_comment",
  action: "created",
  installation_id: "9007199254740997",
  repository_id: "9007199254740999",
  throttled_at: null,
};
const detail = {
  ...delivery,
  url: webhookUrl,
  request: {
    headers: { authorization: appToken, "x-hub-signature-256": webhookSecret },
    payload: {
      action: "created",
      installation: { id: delivery.installation_id },
      repository: { id: delivery.repository_id, full_name: repositoryFullName },
      issue: { id: "300", number: "3", body: "unrelated private task" },
      comment,
      sender: { id: comment.user.id },
    },
  },
  response: { payload: "private proxy error" },
};
// Serialize numeric IDs as genuine JSON numeric tokens without rounding them.
function losslessJson(value: unknown, headers?: HeadersInit) {
  return new Response(
    JSON.stringify(value).replace(
      /"(id|installation_id|repository_id|number)":"([0-9]+)"/g,
      '"$1":$2',
    ),
    { headers },
  );
}

describe("GitHub App webhook recovery HTTP boundaries", () => {
  afterEach(() => vi.useRealTimers());

  it("lists all statuses, retaining 64-bit IDs and only a validated next cursor", async () => {
    const fetch = vi.fn(async () =>
      losslessJson(
        [
          delivery,
          {
            ...delivery,
            id: "3841617677642645504",
            status_code: 202,
            redelivery: true,
          },
        ],
        {
          link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=abc%2Bdef%3D>; rel="next"',
        },
      ),
    );
    const result = await listGitHubAppWebhookDeliveries({ fetch, appToken });
    expect(result.deliveries.map((item) => [item.id, item.statusCode])).toEqual(
      [
        [deliveryId, 502],
        ["3841617677642645504", 202],
      ],
    );
    expect(result.deliveries[0]?.installationId).toBe(delivery.installation_id);
    expect(result.nextCursor).toBe("abc+def=");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/app/hook/deliveries?per_page=100",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("projects exact detail/comment identity and hashes without returning private payloads", async () => {
    const fetch = vi.fn(async () => losslessJson(detail));
    const result = await getGitHubAppWebhookDelivery({
      fetch,
      appToken,
      deliveryId,
    });
    expect(result).toMatchObject({
      id: deliveryId,
      guid,
      url: webhookUrl,
      payload: {
        repositoryFullName,
        installationId: delivery.installation_id,
        comment: {
          id: comment.id,
          userId: comment.user.id,
          bodySha256,
          issueNumber: "3",
        },
      },
    });
    for (const secret of [
      commentBody,
      appToken,
      webhookSecret,
      "private-login",
      "private proxy error",
      "unrelated private task",
    ]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(result).not.toHaveProperty("request");
  });

  it("reads only closed current config fields and never returns the masked secret", async () => {
    await expect(
      readGitHubAppWebhookConfig({
        fetch: async () => json({ ...config, secret: webhookSecret }),
        appToken,
      }),
    ).resolves.toEqual({
      url: webhookUrl,
      contentType: "json",
      insecureSsl: "0",
    });
  });

  it("requests the exact lossless delivery once and treats 202 only as accepted", async () => {
    const fetch = vi.fn(
      async () => new Response("ignored-private-response", { status: 202 }),
    );
    await expect(
      requestGitHubAppWebhookRedelivery({ fetch, appToken, deliveryId }),
    ).resolves.toEqual({ accepted: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      `https://api.github.com/app/hook/deliveries/${deliveryId}/attempts`,
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("does not retry an uncertain POST or expose its error/cause", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(`${appToken} ${webhookSecret}`);
    });
    const failure = await requestGitHubAppWebhookRedelivery({
      fetch,
      appToken,
      deliveryId,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubWebhookRecoveryError);
    expect(failure).toMatchObject({
      code: "github_webhook_recovery_transport",
      requestMayHaveBeenAccepted: true,
    });
    expect(String(failure)).not.toContain(appToken);
    expect(failure).not.toHaveProperty("cause");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("gets the current exact issue comment using only installation authority", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ token: "installation-test-token" }, 201))
      .mockResolvedValueOnce(losslessJson(comment))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await getGitHubRecoveryComment({
      fetch,
      appToken,
      installationId: delivery.installation_id,
      repositoryFullName,
      event: "issue_comment",
      commentId: comment.id,
    });
    expect(result).toMatchObject({
      id: comment.id,
      userId: comment.user.id,
      bodySha256,
      issueNumber: "3",
    });
    expect(fetch).toHaveBeenCalledWith(
      `https://api.github.com/repos/paperclip/example/issues/comments/${comment.id}`,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer installation-test-token",
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain(commentBody);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]).toEqual([
      `https://api.github.com/app/installations/${delivery.installation_id}/access_tokens`,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({
          repositories: ["example"],
          permissions: { issues: "read", pull_requests: "read" },
        }),
        headers: expect.objectContaining({
          authorization: `Bearer ${appToken}`,
        }),
      }),
    ]);
    expect(fetch.mock.calls[2]).toEqual([
      "https://api.github.com/installation/token",
      expect.objectContaining({
        method: "DELETE",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer installation-test-token",
        }),
      }),
    ]);
  });

  it.each([
    "0",
    "-1",
    "01",
    "1.2",
    "1e9",
    "18446744073709551616",
    "123/attempts",
    3841617089160847360,
  ])("rejects unsafe identifier %s before network access", async (id) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      requestGitHubAppWebhookRedelivery({
        fetch,
        appToken,
        deliveryId: id as string,
      }),
    ).rejects.toMatchObject({ code: "github_webhook_recovery_invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["1e18", "1.5", "-1", "18446744073709551616"])(
    "rejects noncanonical or out-of-range JSON ID token %s",
    async (id) => {
      const raw = JSON.stringify(delivery).replace(
        `"id":"${deliveryId}"`,
        `"id":${id}`,
      );
      await expect(
        listGitHubAppWebhookDeliveries({
          fetch: async () => new Response(`[${raw}]`),
          appToken,
        }),
      ).rejects.toMatchObject({
        code: "github_webhook_recovery_invalid_response",
      });
    },
  );

  it.each([
    "https://evil.example/app/hook/deliveries?cursor=abc",
    "https://api.github.com.evil.example/app/hook/deliveries?cursor=abc",
    "https://user:password@api.github.com/app/hook/deliveries?cursor=abc",
    "https://api.github.com/repos/private?cursor=abc",
    "https://api.github.com/app/hook/deliveries?cursor=abc&token=secret",
    "https://api.github.com/app/hook/deliveries?cursor=abc&cursor=def",
    "https://api.github.com/app/hook/deliveries?cursor=abc#secret",
  ])(
    "rejects untrusted pagination destination %s without another request",
    async (url) => {
      const fetch = vi.fn(async () =>
        losslessJson([delivery], { link: `<${url}>; rel="next"` }),
      );
      await expect(
        listGitHubAppWebhookDeliveries({ fetch, appToken }),
      ).rejects.toMatchObject({
        code: "github_webhook_recovery_invalid_response",
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("round-trips opaque validated cursors only as encoded query values", async () => {
    const fetch = vi.fn(async () => json([]));
    await listGitHubAppWebhookDeliveries({
      fetch,
      appToken,
      cursor: "v1:abc+def/==",
    });
    expect(fetch.mock.calls[0]).toEqual([
      "https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1%3Aabc%2Bdef%2F%3D%3D",
      expect.any(Object),
    ]);
    await expect(
      listGitHubAppWebhookDeliveries({
        fetch,
        appToken,
        cursor: "abc&token=private",
      }),
    ).rejects.toMatchObject({ code: "github_webhook_recovery_invalid_input" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([101, 1000])(
    "rejects %s deliveries rather than silently truncating scan evidence",
    async (count) => {
      await expect(
        listGitHubAppWebhookDeliveries({
          fetch: async () =>
            losslessJson(Array.from({ length: count }, () => delivery)),
          appToken,
        }),
      ).rejects.toMatchObject({
        code: "github_webhook_recovery_invalid_response",
      });
    },
  );

  it.each(["invalid-private-json", "null", "{}", " ".repeat(262_145)])(
    "rejects malformed or oversized metadata without echoing it",
    async (body) => {
      const failure = await listGitHubAppWebhookDeliveries({
        fetch: async () => new Response(body),
        appToken,
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "github_webhook_recovery_invalid_response",
      });
      expect(String(failure)).not.toContain("invalid-private-json");
    },
  );

  it("bounds streamed detail bytes even without Content-Length and cancels the reader", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
      },
      cancel,
    });
    await expect(
      getGitHubAppWebhookDelivery({
        fetch: async () => new Response(stream),
        appToken,
        deliveryId,
      }),
    ).rejects.toMatchObject({
      code: "github_webhook_recovery_invalid_response",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a changed exact delivery or credential-bearing callback", async () => {
    for (const value of [
      { ...detail, id: "3841617089160847361" },
      { ...detail, url: `${webhookUrl}?secret=private` },
    ]) {
      await expect(
        getGitHubAppWebhookDelivery({
          fetch: async () => losslessJson(value),
          appToken,
          deliveryId,
        }),
      ).rejects.toMatchObject({
        code: "github_webhook_recovery_invalid_response",
      });
    }
  });

  it.each([302, 401, 403, 404, 422, 429, 500, 502])(
    "returns only closed HTTP %s metadata and never follows/retries",
    async (status) => {
      const fetch = vi.fn(
        async () =>
          new Response(`${appToken}:${webhookSecret}`, {
            status,
            headers: { location: "https://evil.example", "retry-after": "60" },
          }),
      );
      const failure = await requestGitHubAppWebhookRedelivery({
        fetch,
        appToken,
        deliveryId,
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "github_webhook_recovery_http",
        statusCode: status,
        retryAfterMs: 60_000,
        requestMayHaveBeenAccepted: status >= 500,
      });
      expect(String(failure)).not.toContain(appToken);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ redirect: "error" }),
      );
    },
  );

  it("honors closed rate-limit reset metadata without returning header text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T18:00:00Z"));
    const response = new Response("private", {
      status: 403,
      headers: {
        "retry-after": "Tue, 08 Sep 2026 18:00:30 GMT",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Date.now() / 1000 + 90),
      },
    });
    await expect(
      listGitHubAppWebhookDeliveries({ fetch: async () => response, appToken }),
    ).rejects.toMatchObject({ retryAfterMs: 90_000 });
  });

  it.each(["fetch", "body"])(
    "enforces one bounded deadline for a stalled %s",
    async (stage) => {
      vi.useFakeTimers();
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        stage === "fetch"
          ? await new Promise<Response>(() => undefined)
          : new Response(new ReadableStream<Uint8Array>({ start() {} })),
      );
      const settled = listGitHubAppWebhookDeliveries({ fetch, appToken }).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await settled).toMatchObject({
        code: "github_webhook_recovery_transport",
        requestMayHaveBeenAccepted: false,
      });
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    },
  );

  it.each([404, 403])(
    "revokes the narrowed token after a current-comment HTTP %s failure",
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(json({ token: "installation-test-token" }, 201))
        .mockResolvedValueOnce(new Response("private denied", { status }))
        .mockRejectedValueOnce(new Error("private cleanup failure"));
      await expect(
        getGitHubRecoveryComment({
          fetch,
          appToken,
          installationId: delivery.installation_id,
          repositoryFullName,
          event: "issue_comment",
          commentId: comment.id,
        }),
      ).rejects.toMatchObject({
        code: "github_webhook_recovery_http",
        statusCode: status,
      });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[2]?.[0]).toBe(
        "https://api.github.com/installation/token",
      );
    },
  );

  it("uses the pull-comment route, validates its target, and revokes before returning", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ token: "installation-test-token" }, 201))
      .mockResolvedValueOnce(
        losslessJson({
          ...comment,
          issue_url: undefined,
          pull_request_url:
            "https://api.github.com/repos/paperclip/example/pulls/4",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      getGitHubRecoveryComment({
        fetch,
        appToken,
        installationId: delivery.installation_id,
        repositoryFullName,
        event: "pull_request_review_comment",
        commentId: comment.id,
      }),
    ).resolves.toMatchObject({ issueNumber: null, pullRequestNumber: "4" });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      `https://api.github.com/repos/paperclip/example/pulls/comments/${comment.id}`,
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { ...comment, id: "9007199254740994" },
    {
      ...comment,
      issue_url: "https://api.github.com/repos/other/repository/issues/3",
    },
    {
      ...comment,
      issue_url: "https://evil.example/repos/paperclip/example/issues/3",
    },
    { ...comment, issue_url: `${comment.issue_url}?secret=private` },
    { ...comment, body: null },
  ])(
    "denies changed current comment identity/body/target and still revokes",
    async (value) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(json({ token: "installation-test-token" }, 201))
        .mockResolvedValueOnce(losslessJson(value))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(
        getGitHubRecoveryComment({
          fetch,
          appToken,
          installationId: delivery.installation_id,
          repositoryFullName,
          event: "issue_comment",
          commentId: comment.id,
        }),
      ).rejects.toMatchObject({
        code: "github_webhook_recovery_invalid_response",
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    "owner/../private",
    "owner/repo?secret=private",
    "https://evil.example/repo",
    "owner/%2e%2e",
  ])("rejects unsafe repository %s before minting authority", async (name) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      getGitHubRecoveryComment({
        fetch,
        appToken,
        installationId: delivery.installation_id,
        repositoryFullName: name,
        event: "issue_comment",
        commentId: comment.id,
      }),
    ).rejects.toMatchObject({ code: "github_webhook_recovery_invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed if the runtime does not provide lossless numeric source text", async () => {
    const originalParse = JSON.parse;
    const response = losslessJson([delivery]);
    const parse = vi
      .spyOn(JSON, "parse")
      .mockImplementation((text, reviver) =>
        originalParse(
          text,
          reviver ? (key, value) => reviver(key, value) : undefined,
        ),
      );
    try {
      await expect(
        listGitHubAppWebhookDeliveries({
          fetch: async () => response,
          appToken,
        }),
      ).rejects.toMatchObject({
        code: "github_webhook_recovery_invalid_response",
      });
    } finally {
      parse.mockRestore();
    }
  });

  it("rejects invalid calendar dates instead of silently rolling the scan frontier forward", async () => {
    await expect(
      listGitHubAppWebhookDeliveries({
        fetch: async () =>
          losslessJson([{ ...delivery, delivered_at: "2026-02-30T18:00:00Z" }]),
        appToken,
      }),
    ).rejects.toMatchObject({
      code: "github_webhook_recovery_invalid_response",
    });
  });

  it("cancels a timed-out body reader as well as its fetch signal", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({ start() {}, cancel }),
    );
    const settled = listGitHubAppWebhookDeliveries({
      fetch: async () => response,
      appToken,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await settled).toMatchObject({
      code: "github_webhook_recovery_transport",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("revokes after a timed-out comment read without masking its original failure", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ token: "installation-test-token" }, 201))
      .mockImplementationOnce(
        async () => await new Promise<Response>(() => undefined),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const settled = getGitHubRecoveryComment({
      fetch,
      appToken,
      installationId: delivery.installation_id,
      repositoryFullName,
      event: "issue_comment",
      commentId: comment.id,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settled).toMatchObject({
      code: "github_webhook_recovery_transport",
      requestMayHaveBeenAccepted: false,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]?.[0]).toBe(
      "https://api.github.com/installation/token",
    );
  });

  it("bounds best-effort token revocation without exposing or changing a successful comment read", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ token: "installation-test-token" }, 201))
      .mockResolvedValueOnce(losslessJson(comment))
      .mockImplementationOnce(
        async () => await new Promise<Response>(() => undefined),
      );
    const settled = getGitHubRecoveryComment({
      fetch,
      appToken,
      installationId: delivery.installation_id,
      repositoryFullName,
      event: "issue_comment",
      commentId: comment.id,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled).toMatchObject({ id: comment.id, bodySha256 });
    expect(fetch.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
