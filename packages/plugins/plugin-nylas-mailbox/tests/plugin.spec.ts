import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { FINANCE_GRANT_ID } from "../src/manifest.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_GRANT_ID = "00000000-0000-4000-8000-000000000099";
const API_KEY_REF = {
  type: "secret_ref" as const,
  secretId: "00000000-0000-4000-8000-000000000002",
  version: "latest" as const,
};
const ORIGINAL_UPPER_ENV = process.env.PAPERCLIP_NYLAS;
const ORIGINAL_LOWER_ENV = process.env.paperclip_nylas;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_UPPER_ENV === undefined) delete process.env.PAPERCLIP_NYLAS;
  else process.env.PAPERCLIP_NYLAS = ORIGINAL_UPPER_ENV;
  if (ORIGINAL_LOWER_ENV === undefined) delete process.env.paperclip_nylas;
  else process.env.paperclip_nylas = ORIGINAL_LOWER_ENV;
});

describe("Nylas finance mailbox plugin", () => {
  it("declares only read-connector capabilities and tools", () => {
    expect(manifest.capabilities).toEqual([
      "agent.tools.register",
      "http.outbound",
      "secrets.read-ref",
    ]);
    expect(manifest.instanceConfigSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        apiKey: { type: "object", format: "secret-ref" },
        grantId: { default: FINANCE_GRANT_ID },
      },
    });
    expect(manifest.tools?.map((tool) => tool.name)).toEqual([
      "nylas_search_messages",
      "nylas_get_message",
      "nylas_read_thread",
      "nylas_list_attachments",
      "nylas_download_attachment",
    ]);
    expect(manifest.tools?.every((tool) => !Object.hasOwn(tool.parametersSchema.properties ?? {}, "grantId"))).toBe(true);
  });

  it("requires a secret reference and validates the mailbox boundary", async () => {
    await expect(plugin.definition.onValidateConfig?.({ apiKey: API_KEY_REF })).resolves.toEqual({ ok: true });

    await expect(plugin.definition.onValidateConfig?.({
      apiKey: "must-not-be-stored-inline",
      grantId: FINANCE_GRANT_ID,
    })).resolves.toMatchObject({
      ok: false,
      errors: [expect.stringContaining("company secret")],
    });

    await expect(plugin.definition.onValidateConfig?.({
      apiKey: API_KEY_REF,
      grantId: "finance@example.com",
    })).resolves.toMatchObject({
      ok: false,
      errors: [expect.stringContaining("valid UUID")],
    });
  });

  it("uses PAPERCLIP_NYLAS when no company secret reference is configured", async () => {
    process.env.PAPERCLIP_NYLAS = "environment-api-key";
    delete process.env.paperclip_nylas;
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return jsonResponse({ data: [] });
    });
    const harness = createTestHarness({ manifest, config: {} });
    await plugin.definition.setup(harness.ctx);

    await expect(plugin.definition.onValidateConfig?.({})).resolves.toEqual({ ok: true });
    await harness.executeTool("nylas_search_messages", {}, { companyId: COMPANY_ID });

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer environment-api-key" });
    expect(calls[0].url.pathname).toContain(`/grants/${FINANCE_GRANT_ID}/`);
  });

  it("hard-binds message search to the configured grant and forwards bounded filters", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return jsonResponse({
        request_id: "request-1",
        data: [{
          id: "message-1",
          thread_id: "thread-1",
          subject: "Invoice 42",
          from: [{ name: "Vendor", email: "billing@example.com" }],
          to: [{ email: "finance@example.com" }],
          date: 1_721_000_000,
          unread: true,
          attachments: [{ id: "attachment-1", filename: "invoice.pdf", size: 12_345 }],
        }],
        next_cursor: "next-page",
      });
    });

    const harness = createTestHarness({
      manifest,
      config: { apiKey: API_KEY_REF, grantId: FINANCE_GRANT_ID, apiRegion: "us" },
    });
    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool<ToolResult>(
      "nylas_search_messages",
      {
        limit: 5,
        subject: "Invoice",
        unread: true,
        grantId: OTHER_GRANT_ID,
      },
      { companyId: COMPANY_ID },
    );

    expect(result.data).toMatchObject({
      messages: [{ id: "message-1", subject: "Invoice 42", unread: true }],
      nextCursor: "next-page",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe(`/v3/grants/${FINANCE_GRANT_ID}/messages`);
    expect(calls[0].url.pathname).not.toContain(OTHER_GRANT_ID);
    expect(Object.fromEntries(calls[0].url.searchParams)).toMatchObject({
      limit: "5",
      subject: "Invoice",
      unread: "true",
    });
    expect(calls[0].init?.headers).toMatchObject({
      Authorization: "Bearer resolved:[object Object]",
    });
  });

  it("reads a message and a complete thread from only the configured grant", async () => {
    const calls: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname.endsWith("/messages/message-1")) {
        return jsonResponse({ data: { id: "message-1", thread_id: "thread-1", subject: "Invoice", body: "<p>Attached.</p>" } });
      }
      if (url.pathname.endsWith("/threads/thread-1")) {
        return jsonResponse({ data: { id: "thread-1", subject: "Invoice", message_ids: ["message-1", "message-2"] } });
      }
      if (url.pathname.endsWith("/messages") && url.searchParams.get("thread_id") === "thread-1") {
        return jsonResponse({
          data: [
            { id: "message-2", thread_id: "thread-1", date: 20, body: "Second" },
            { id: "message-1", thread_id: "thread-1", date: 10, body: "First" },
          ],
          next_cursor: null,
        });
      }
      throw new Error(`Unexpected Nylas request: ${url}`);
    });

    const harness = createTestHarness({ manifest, config: { apiKey: API_KEY_REF } });
    await plugin.definition.setup(harness.ctx);

    const message = await harness.executeTool<ToolResult>("nylas_get_message", { messageId: "message-1" }, { companyId: COMPANY_ID });
    expect(message.data).toMatchObject({ message: { body: "<p>Attached.</p>", bodyTruncated: false } });

    const thread = await harness.executeTool<ToolResult>("nylas_read_thread", { threadId: "thread-1" }, { companyId: COMPANY_ID });
    expect(thread.data).toMatchObject({
      thread: { id: "thread-1", messageIds: ["message-1", "message-2"] },
      messages: [{ id: "message-1", body: "First" }, { id: "message-2", body: "Second" }],
    });
    expect(calls.every((url) => url.pathname.includes(`/grants/${FINANCE_GRANT_ID}/`))).toBe(true);
  });

  it("lists and downloads size-capped attachments", async () => {
    const bytes = Buffer.from("invoice-content", "utf8");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/messages/message-1")) {
        expect(url.searchParams.get("select")).toBe("attachments");
        return jsonResponse({
          data: {
            id: "message-1",
            attachments: [{
              id: "attachment-1",
              filename: "invoice.pdf",
              content_type: "application/pdf",
              size: bytes.byteLength,
              is_inline: false,
            }],
          },
        });
      }
      if (url.pathname.endsWith("/attachments/attachment-1/download")) {
        expect(url.searchParams.get("message_id")).toBe("message-1");
        return new Response(bytes, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": String(bytes.byteLength),
            "Content-Disposition": "attachment; filename=invoice.pdf",
          },
        });
      }
      throw new Error(`Unexpected Nylas request: ${url}`);
    });

    const harness = createTestHarness({
      manifest,
      config: { apiKey: API_KEY_REF, maxAttachmentBytes: 1_000 },
    });
    await plugin.definition.setup(harness.ctx);

    const listed = await harness.executeTool<ToolResult>("nylas_list_attachments", { messageId: "message-1" }, { companyId: COMPANY_ID });
    expect(listed.data).toMatchObject({
      attachments: [{ id: "attachment-1", filename: "invoice.pdf", contentType: "application/pdf" }],
    });

    const downloaded = await harness.executeTool<ToolResult>(
      "nylas_download_attachment",
      { messageId: "message-1", attachmentId: "attachment-1" },
      { companyId: COMPANY_ID },
    );
    expect(downloaded.data).toMatchObject({
      filename: "invoice.pdf",
      contentType: "application/pdf",
      byteSize: bytes.byteLength,
      encoding: "base64",
      content: bytes.toString("base64"),
    });
  });

  it("rejects oversized downloads before reading the response body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("too large", {
      status: 200,
      headers: { "Content-Length": "5000" },
    }));
    const harness = createTestHarness({
      manifest,
      config: { apiKey: API_KEY_REF, maxAttachmentBytes: 100 },
    });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.executeTool(
      "nylas_download_attachment",
      { messageId: "message-1", attachmentId: "attachment-1" },
      { companyId: COMPANY_ID },
    )).rejects.toThrow("above the configured 100-byte limit");
  });

  it("stops oversized downloads when the response omits content-length", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Buffer.alloc(200), { status: 200 }));
    const harness = createTestHarness({
      manifest,
      config: { apiKey: API_KEY_REF, maxAttachmentBytes: 100 },
    });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.executeTool(
      "nylas_download_attachment",
      { messageId: "message-1", attachmentId: "attachment-1" },
      { companyId: COMPANY_ID },
    )).rejects.toThrow("exceeds the configured 100-byte limit");
  });

  it("surfaces Nylas failures without exposing the resolved API key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      error: { type: "invalid_request_error", message: "Grant not found" },
    }, 404));
    const harness = createTestHarness({ manifest, config: { apiKey: API_KEY_REF } });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.executeTool(
      "nylas_get_message",
      { messageId: "missing" },
      { companyId: COMPANY_ID },
    )).rejects.toThrow("Nylas request failed: invalid_request_error: Grant not found");
  });
});
