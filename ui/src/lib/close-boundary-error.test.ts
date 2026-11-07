// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import * as ui from "./localized-ui-error";
import { describeError, classifyError } from "@/api/errors";
import { MutationObserver } from "@tanstack/react-query";
import { createAppQueryClient, type MutationErrorToast } from "./query-client";

afterEach(async () => { await i18n.changeLanguage("en"); });
it("registers only explicit local origin, preserves original Error data and never matches colliding diagnostics", async () => {
  expect(typeof ui.localizeUiError).toBe("function");
  const original = new Error("Upload did not return a file URL");
  const before = Object.getOwnPropertyDescriptors(original);
  const known = ui.localizeUiError(original, { key: "final-boundary:missingFileUrl" });
  expect(known).toBe(original); expect(Object.getOwnPropertyDescriptors(original)).toEqual(before);
  for (const locale of ["zh-CN", "en", "zh-CN"]) {
    await i18n.changeLanguage(locale);
    expect(ui.describeUiError(known).body).toBe(locale === "en" ? original.message : "上传未返回文件 URL");
    for (const raw of [original.message, "上传未返回文件 URL", "Document locking is not available", "Some vendor / 原始 diagnostic"])
      expect(ui.describeUiError(new Error(raw)).body).toBe(raw);
    expect(Object.getOwnPropertyDescriptors(original)).toEqual(before);
    expect(classifyError(known)).toBe("unknown");
  }
});
it("adds render-time presentation to opted-in global mutation toasts without replaying requests", async () => {
  const toasts: MutationErrorToast[] = []; let calls = 0;
  const client = createAppQueryClient({ connectivity: { getSnapshot: () => ({ status: "online" } as never), reportError: () => {} }, notifyMutationError: toast => toasts.push(toast) });
  const cause = new Error("Manual vendor diagnostic");
  const mutation = new MutationObserver(client, { mutationFn: async () => { calls++; throw cause; }, meta: { errorToast: true } });
  await mutation.mutate().catch(() => {});
  expect(toasts).toHaveLength(1);
  expect(toasts[0].presentation?.error?.cause).toBe(cause);
  await i18n.changeLanguage("zh-CN");
  expect(ui.describeUiError(toasts[0].presentation!.error!.cause).title).toBe(describeError(cause).title);
  expect(toasts[0].body).toBe("Manual vendor diagnostic");
  await i18n.changeLanguage("en"); expect(calls).toBe(1); expect(mutation.getCurrentResult().error).toBe(cause);
  client.clear();
});
