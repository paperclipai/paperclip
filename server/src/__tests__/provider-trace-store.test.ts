import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  assessProviderTraceEntries,
  providerTraceStore,
  providerTraceRequiredChannels,
  redactProviderTraceFrame,
} from "../services/provider-trace-store.js";

const mockUnlink = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("node:fs/promises", () => ({
  default: { unlink: mockUnlink },
}));
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));

function frame(payload: unknown) {
  return {
    kind: "frame",
    schema: "paperclip.provider_trace_frame.v1",
    frameId: 1,
    rawBase64: Buffer.from(JSON.stringify(payload)).toString("base64"),
  };
}

describe("provider trace redaction", () => {
  it("removes exact bytes and masks secret-shaped fields and values", () => {
    const redacted = redactProviderTraceFrame(
      frame({
        authorization: "Bearer exact-token-value",
        message: "sk-abcdefghijklmnopqrstuvwxyz",
        nested: { apiKey: "also-secret", safe: "visible" },
      }),
    );

    expect(redacted).not.toHaveProperty("rawBase64");
    expect(redacted.parsed).toEqual({
      authorization: "[withheld]",
      message: "[withheld]",
      nested: { apiKey: "[withheld]", safe: "visible" },
    });
    expect(redacted.withheldPaths).toEqual([
      "authorization",
      "message",
      "nested.apiKey",
    ]);
  });

  it("withholds reasoning item content while retaining routing metadata", () => {
    const redacted = redactProviderTraceFrame(
      frame({
        item: {
          id: "reason-1",
          type: "reasoning",
          status: "completed",
          summary: ["private chain"],
          encrypted_content: "ciphertext",
        },
      }),
    );

    expect(redacted.parsed).toEqual({
      item: {
        id: "reason-1",
        type: "reasoning",
        status: "completed",
        summary: "[withheld]",
        encrypted_content: "[withheld]",
      },
    });
    expect(redacted.withheldPaths).toContain("item.summary");
  });
});

describe("provider trace channel integrity", () => {
  it("requires each provider's actual native transport topology", () => {
    expect(providerTraceRequiredChannels("codex")).toEqual([
      "rust_native",
      "typescript_runnerd_rehydration",
    ]);
    expect(providerTraceRequiredChannels("opencode")).toEqual(["typescript_opencode_native"]);
    expect(providerTraceRequiredChannels("acpx")).toEqual(["typescript_acpx_native"]);
  });

  function completeChannel(channel: string, raw = Buffer.from("{}")) {
    return [
      {
        kind: "frame",
        debugChannel: channel,
        debugSequence: 1,
        frameId: 1,
        rawBase64: raw.toString("base64"),
        byteLength: raw.byteLength,
        digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      },
      {
        kind: "trace_status",
        debugChannel: channel,
        debugSequence: 2,
        acknowledgedDebugSequence: 1,
        status: "complete",
        reason: null,
      },
    ];
  }

  it("accepts independently sequenced and acknowledged debug channels", () => {
    expect(
      assessProviderTraceEntries([
        ...completeChannel("rust_native"),
        ...completeChannel("typescript_runnerd_rehydration"),
      ]),
    ).toEqual({ status: "complete", reason: null });
  });

  it("marks gaps, missing acknowledgements, and digest changes incomplete", () => {
    const gap = completeChannel("rust_native");
    gap[1]!.debugSequence = 3;
    expect(assessProviderTraceEntries(gap).reason).toBe(
      "trace_debug_sequence_gap:rust_native",
    );

    const noAck = completeChannel("rust_native").slice(0, 1);
    expect(assessProviderTraceEntries(noAck).reason).toBe(
      "trace_channel_ack_missing:rust_native",
    );

    const changed = completeChannel("rust_native");
    changed[0]!.rawBase64 = Buffer.from("changed").toString("base64");
    expect(assessProviderTraceEntries(changed).reason).toBe(
      "provider_frame_digest_mismatch",
    );
  });
});

describe("provider trace retention", () => {
  function expiredTraceRow() {
    return {
      id: "trace-1",
      runId: "run-1",
      companyId: "company-1",
      status: "complete",
      provider: "codex",
      traceRef: "11111111-1111-4111-8111-111111111111.ndjson",
      frameCount: 1,
      byteCount: 2,
      digest: "sha256:abc",
      reason: null,
      requestedBy: "user-1",
      createdAt: new Date("1999-12-30T12:00:00.000Z"),
      updatedAt: new Date("1999-12-30T12:00:00.000Z"),
      expiresAt: new Date("1999-12-31T12:00:00.000Z"),
      deletedAt: null as Date | null,
    };
  }

  function expiredTraceDb() {
    const row = expiredTraceRow();
    const returning = vi.fn(async () => [{
      ...row,
      status: "expired",
      deletedAt: new Date("2026-08-31T12:00:00.000Z"),
    }]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [row]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning })),
        })),
      })),
    };
    return { db, returning };
  }

  function statefulExpiredTraceDb() {
    let row = expiredTraceRow();
    const selectRows = () => [row];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const result = Promise.resolve(selectRows()) as Promise<Array<typeof row>> & {
              limit: (count: number) => Promise<Array<typeof row>>;
            };
            result.limit = vi.fn(async () => selectRows());
            return result;
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Partial<typeof row>) => ({
          where: vi.fn(() => {
            const execute = async () => {
              row = { ...row, ...values };
              return [row];
            };
            return {
              returning: execute,
              then: <TResult1 = Array<typeof row>, TResult2 = never>(
                onfulfilled?: ((value: Array<typeof row>) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
              ) => execute().then(onfulfilled, onrejected),
            };
          }),
        })),
      })),
    };
    return { db, row: () => row };
  }

  function finalizeExpiryRaceDb() {
    let row = {
      ...expiredTraceRow(),
      expiresAt: new Date("2999-12-31T12:00:00.000Z"),
    };
    const selectRows = () => [row];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => selectRows()),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Partial<typeof row>) => ({
          where: vi.fn(() => {
            const execute = async () => {
              if (values.status === "incomplete") {
                row = {
                  ...row,
                  status: "expired",
                  deletedAt: new Date("2000-01-01T00:00:00.000Z"),
                  expiresAt: new Date("1999-12-31T12:00:00.000Z"),
                };
                return [];
              }
              row = { ...row, ...values };
              return [row];
            };
            return {
              returning: execute,
              then: <TResult1 = Array<typeof row>, TResult2 = never>(
                onfulfilled?: ((value: Array<typeof row>) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
              ) => execute().then(onfulfilled, onrejected),
            };
          }),
        })),
      })),
    };
    return { db, row: () => row };
  }

  const rawReaders: Array<{
    name: string;
    read: (store: ReturnType<typeof providerTraceStore>) => Promise<unknown>;
  }> = [
    { name: "inspect", read: (store) => store.inspect("run-1", "company-1") },
    { name: "readExactEntries", read: (store) => store.readExactEntries("run-1", "company-1") },
    { name: "revealFrame", read: (store) => store.revealFrame("run-1", "company-1", 1) },
    { name: "download", read: (store) => store.download("run-1", "company-1") },
  ];

  it.each(rawReaders)("denies and expires raw trace access through $name", async ({ name, read }) => {
    mockUnlink.mockReset();
    mockUnlink.mockResolvedValue(undefined);
    const { db, returning } = expiredTraceDb();
    const store = providerTraceStore(db as never);

    const result = await read(store);

    expect(result).toEqual(name === "inspect" ? { trace: null, entries: [] } : null);
    expect(returning).toHaveBeenCalledOnce();
  });

  it("keeps an expired row denied and retries failed raw-file cleanup", async () => {
    const unlinkError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    mockUnlink.mockReset();
    mockUnlink.mockRejectedValueOnce(unlinkError).mockResolvedValue(undefined);
    const { db, row } = statefulExpiredTraceDb();
    const store = providerTraceStore(db as never);

    await expect(store.inspect("run-1", "company-1")).rejects.toThrow("permission denied");
    expect(row()).toMatchObject({ status: "expired", deletedAt: expect.any(Date) });

    await expect(store.inspect("run-1", "company-1")).resolves.toEqual({
      trace: null,
      entries: [],
    });
    expect(row().traceRef).toBe("00000000-0000-0000-0000-000000000000.ndjson");
  });

  it("never returns a writable capture path for an expired existing trace", async () => {
    mockUnlink.mockReset();
    mockUnlink.mockResolvedValue(undefined);
    const { db } = statefulExpiredTraceDb();
    const store = providerTraceStore(db as never);

    await expect(store.prepare({
      runId: "run-1",
      companyId: "company-1",
      provider: "codex",
      requestedBy: "user-1",
    })).rejects.toThrow("provider_trace_unavailable");
  });

  it("does not let concurrent finalization overwrite expiry or strand raw files", async () => {
    mockUnlink.mockReset();
    mockUnlink.mockResolvedValue(undefined);
    const { db, row } = finalizeExpiryRaceDb();
    const store = providerTraceStore(db as never);

    await expect(store.finalize("run-1", "company-1")).resolves.toBeNull();
    expect(row()).toMatchObject({
      status: "expired",
      deletedAt: expect.any(Date),
      traceRef: "00000000-0000-0000-0000-000000000000.ndjson",
    });
  });
});
