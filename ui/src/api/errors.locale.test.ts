import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import { ApiError, apiErrorFromResponse } from "./api-error";
import { apiErrorMessage, apiErrorMessageSource, classifyError, describeError, errorCopy, errorCodes, isConnectivityError, isRawErrorCode } from "./errors";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("localized error presentation", () => {
  it.each([["en", "zh-CN"], ["zh-CN", "en"]])(
    "refreshes held ApiError product fallbacks after %s → %s",
    async (source, target) => {
      const cases = [
        { status: 401, kind: "auth", english: "Your session has ended. Sign in again to continue." },
        { status: 403, kind: "forbidden", english: "You don’t have permission to do that." },
        { status: 404, kind: "not_found", english: "This item doesn’t exist or was moved." },
        { status: 409, kind: "conflict", english: "This changed since you loaded it. Refresh and try again." },
        { status: 422, kind: "invalid", english: "Some details aren’t valid. Review them and try again." },
        { status: 500, kind: "unknown", english: "An unexpected error occurred. Please try again." },
      ];
      await i18n.changeLanguage(source);
      const held = cases.flatMap(({ status, kind, english }) =>
        [null, {}, { error: "vendor_unknown_code", details: { code: "raw_detail" } }].map(body => {
          const error = apiErrorFromResponse(new Response(null, { status, headers: { "Retry-After": "1.5" } }), body);
          const original = { ...error, message: error.message, stack: error.stack };
          expect(error.message).toBe(errorCopy(kind).body);
          return { error, original, kind, english };
        }),
      );
      await i18n.changeLanguage(target);
      for (const { error, original, kind, english } of held) {
        expect(describeError(error), `${source} → ${target}, ${error.status}, ${JSON.stringify(error.body)}`).toEqual({
          ...errorCopy(kind),
          retryable: kind === "unknown",
        });
        if (target === "en") expect(describeError(error).body).toBe(english);
        expect(classifyError(error)).toBe(kind);
        expect(error.status).toBe(original.status);
        expect(error.body).toBe(original.body);
        expect(error.code).toBe(original.code);
        expect(error.retryAfterMs).toBe(1500);
        expect(error.message).toBe(original.message);
        expect(error.stack).toBe(original.stack);
        expect(errorCodes(error)).toEqual(error.body ? (original.code ? ["vendor_unknown_code", "raw_detail"] : []) : []);
        expect(isConnectivityError(error)).toBe(false);
      }
    },
  );

  it.each([["en", "zh-CN"], ["zh-CN", "en"]])(
    "preserves held raw diagnostics after %s → %s, including product-copy collisions",
    async (source, target) => {
      await i18n.changeLanguage(source);
      const diagnostics = ["provider fixture: user-owned-name", errorCopy("not_found").body];
      const held = diagnostics.flatMap(diagnostic => [
        { diagnostic, error: apiErrorFromResponse(new Response(null, { status: 404 }), { error: diagnostic }) },
        { diagnostic, error: apiErrorFromResponse(new Response(null, { status: 404 }), { message: diagnostic, error: "vendor_unknown_code" }) },
        { diagnostic, error: new Error(diagnostic) },
      ]);
      held.push({ diagnostic: "custom vendor diagnostic", error: new ApiError("custom vendor diagnostic", 404, null) });
      await i18n.changeLanguage(target);
      for (const { diagnostic, error } of held) {
        expect(describeError(error).body).toBe(diagnostic);
        expect(error.message).toBe(diagnostic);
      }
    },
  );

  it.each([["en", "zh-CN"], ["zh-CN", "en"]])(
    "preserves hand-created ApiError product-copy diagnostics after %s → %s",
    async (source, target) => {
      await i18n.changeLanguage(source);
      const diagnostic = errorCopy("not_found").body;
      const manual = new ApiError(diagnostic, 404, null);
      const factory = apiErrorFromResponse(new Response(null, { status: 404 }), null);
      const original = { ...manual, message: manual.message, stack: manual.stack };
      expect(manual.message).toBe(factory.message);
      await i18n.changeLanguage(target);
      expect(describeError(manual)).toEqual({ ...errorCopy("not_found"), body: diagnostic, retryable: false });
      expect(describeError(factory)).toEqual({ ...errorCopy("not_found"), retryable: false });
      expect(manual.message).toBe(original.message);
      expect(manual.stack).toBe(original.stack);
      expect(manual.status).toBe(404);
      expect(manual.body).toBeNull();
      expect(manual.code).toBeNull();
      expect(manual.retryAfterMs).toBeNull();
      expect(Object.getOwnPropertyDescriptors(manual)).toEqual({
        ...Object.getOwnPropertyDescriptors(factory),
        message: Object.getOwnPropertyDescriptor(manual, "message"),
        stack: Object.getOwnPropertyDescriptor(manual, "stack"),
      });
      expect(classifyError(manual)).toBe("not_found");
      expect(errorCodes(manual)).toEqual([]);
      expect(isConnectivityError(manual)).toBe(false);
    },
  );

  it.each(["en", "zh-CN"])("tracks product-copy source without diagnostic text matching in %s", async locale => {
    await i18n.changeLanguage(locale);
    const collision = errorCopy("not_found").body;
    const cases = [
      { status: 404, body: null, message: collision, productCopy: true },
      { status: 404, body: {}, message: collision, productCopy: true },
      { status: 404, body: { error: "vendor_unknown_code" }, message: collision, productCopy: true },
      { status: 404, body: { error: collision }, message: collision, productCopy: false },
      { status: 404, body: { message: collision, error: "vendor_unknown_code" }, message: collision, productCopy: false },
      { status: 404, body: { message: "provider fixture: user-owned-name" }, message: "provider fixture: user-owned-name", productCopy: false },
      { status: 404, body: { error: "provider fixture: user-owned-name" }, message: "provider fixture: user-owned-name", productCopy: false },
      { status: 404, body: { error: "Request failed: 404" }, message: "Request failed: 404", productCopy: false },
      { status: 404, body: { message: "Request failed: 404" }, message: collision, productCopy: true },
      { status: 503, body: { error: collision }, message: collision, productCopy: false },
      { status: 503, body: { message: collision, error: "tenant_app_unavailable" }, message: errorCopy("tenant_app_unavailable").body, productCopy: true },
      { status: 404, body: { error: collision, code: "TIMEOUT" }, message: collision, productCopy: false },
    ];
    for (const { status, body, message, productCopy } of cases) {
      expect(apiErrorMessageSource(status, body)).toEqual({ message, productCopy });
      expect(apiErrorMessage(status, body)).toBe(message);
      expect(apiErrorFromResponse(new Response(null, { status }), body).message).toBe(message);
    }
  });

  it.each(["en", "zh-CN"])("keeps the apiErrorMessage string API compatible with the original resolver in %s", async locale => {
    await i18n.changeLanguage(locale);
    const bodies = [
      null, {}, [], "raw body", { error: "" }, { error: "  " }, { error: "vendor_unknown_code" },
      { error: "tenant_app_unavailable" }, { code: "TIMEOUT" }, { details: { code: "interaction_settled" } },
      { error: "Forbidden" }, { error: " provider fixture: user-owned-name " },
      { message: "provider fixture: user-owned-name" }, { error: errorCopy("not_found").body },
      { message: errorCopy("not_found").body, error: "vendor_unknown_code" },
      { error: "Request failed: 404" }, { message: "Request failed: 404" },
      { message: "Paperclip is temporarily unavailable. Please try again in a moment." },
    ];
    for (const status of [400, 401, 403, 404, 408, 409, 410, 412, 422, 425, 429, 500, 502, 503, 504]) {
      for (const body of bodies) {
        const value = body && typeof body === "object" && !Array.isArray(body) && "error" in body ? body.error : null;
        const raw = typeof value === "string" && value.trim() ? value.trim() : null;
        const original = raw && !isRawErrorCode(raw) ? raw : describeError({ status, body, code: raw }).body;
        expect(apiErrorMessage(status, body)).toBe(original);
      }
    }
  });

  it.each([["en", "zh-CN"], ["zh-CN", "en"]])(
    "retains the explicit legacy product-sentinel display rule after %s → %s without changing raw data",
    async (source, target) => {
      await i18n.changeLanguage(source);
      const sentinel = "Paperclip is temporarily unavailable. Please try again in a moment.";
      const messageBody = { message: sentinel };
      const errorBody = { error: sentinel };
      const errors = [
        new ApiError(sentinel, 404, null),
        apiErrorFromResponse(new Response(null, { status: 404 }), messageBody),
        apiErrorFromResponse(new Response(null, { status: 404 }), errorBody),
        new Error(sentinel),
      ];
      const originals = errors.map(error => ({
        message: error.message,
        stack: error.stack,
        descriptors: Object.getOwnPropertyDescriptors(error),
      }));
      const nearMatch = `${sentinel} Vendor trace: custom diagnostic`;
      const unknown = new ApiError(nearMatch, 404, { message: nearMatch });
      expect(apiErrorMessageSource(404, messageBody).productCopy).toBe(true);
      expect(apiErrorMessageSource(404, errorBody).productCopy).toBe(false);
      await i18n.changeLanguage(target);
      for (const [index, error] of errors.entries()) {
        const kind = index === 3 ? "unknown" : "not_found";
        expect(describeError(error)).toEqual({ ...errorCopy(kind), retryable: kind === "unknown" });
        expect(error.message).toBe(originals[index].message);
        expect(error.stack).toBe(originals[index].stack);
        expect(Object.getOwnPropertyDescriptors(error)).toEqual(originals[index].descriptors);
      }
      expect((errors[1] as ApiError).body).toBe(messageBody);
      expect((errors[2] as ApiError).body).toBe(errorBody);
      expect(messageBody.message).toBe(sentinel);
      expect(errorBody.error).toBe(sentinel);
      expect(describeError(unknown).body).toBe(nearMatch);
      expect(unknown.message).toBe(nearMatch);
    },
  );

  it("localizes known outages while retaining classification and raw codes", async () => {
    const body = { error: "tenant_app_unavailable", details: { code: "tenant_app_unavailable" } };
    await i18n.changeLanguage("zh-CN");
    const error = apiErrorFromResponse(new Response(null, { status: 503 }), body);
    expect(error.message).toBe("Paperclip 正在重启或更新，请稍后重试。");
    expect(error.code).toBe("tenant_app_unavailable");
    expect(error.body).toBe(body);
    expect(errorCodes(error)).toEqual(["tenant_app_unavailable"]);
    expect(classifyError(error)).toBe("transient");
    expect(isConnectivityError(error)).toBe(true);
    expect(describeError(error)).toEqual({ title: "正在重新连接 Paperclip", body: "Paperclip 正在重启或更新，请稍后重试。", retryable: true });
  });

  it("resolves error copy at call time instead of caching the previous language", async () => {
    expect(errorCopy("auth").title).toBe("Signed out");
    await i18n.changeLanguage("zh-CN");
    expect(errorCopy("auth")).toEqual({ title: "已退出登录", body: "会话已结束，请重新登录以继续。" });
    await i18n.changeLanguage("en");
    expect(errorCopy("auth").title).toBe("Signed out");
  });

  it("preserves unknown diagnostic details and uses a localized action title", async () => {
    const details = "provider fixture: user-owned-name";
    await i18n.changeLanguage("zh-CN");
    expect(describeError(new Error(details), { action: "保存文档" })).toEqual({ title: "无法保存文档", body: details, retryable: true });
    expect(apiErrorMessage(409, { error: details })).toBe(details);
  });

  it("keeps retry policy and status classification independent of language", async () => {
    const inputs = [new TypeError("Failed to fetch"), { status: 401 }, { status: 403 }, { status: 404 }, { status: 409 }, { status: 422 }, { status: 500 }, new DOMException("Aborted", "AbortError")];
    const english = inputs.map(error => [classifyError(error), describeError(error).retryable, isConnectivityError(error)]);
    await i18n.changeLanguage("zh-CN");
    expect(inputs.map(error => [classifyError(error), describeError(error).retryable, isConnectivityError(error)])).toEqual(english);
    expect(describeError({ status: 404 }).body).toBe("此条目不存在或已被移动。");
  });
});
