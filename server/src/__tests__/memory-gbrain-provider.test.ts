import { describe, expect, it } from "vitest";
import {
  gbrainMemoryProvider,
  parseGbrainCallOutput,
  resolveGbrainBinPath,
  type ExecFileFn,
  type ExecFileResult,
  type GbrainMemoryProviderOptions,
} from "../services/memory/gbrain-provider.ts";

const FAKE_BIN = "/fake/bin/gbrain";
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const allowAccess = async () => {};
const denyAccess = async () => {
  throw new Error("ENOENT");
};

type RecordedCall = { file: string; args: string[]; options: { timeout: number; maxBuffer: number } };

function recordingExecFile(result: ExecFileResult | Error): { calls: RecordedCall[]; execFileFn: ExecFileFn } {
  const calls: RecordedCall[] = [];
  const execFileFn: ExecFileFn = async (file, args, options) => {
    calls.push({ file, args, options });
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, execFileFn };
}

function makeProvider(execFileFn: ExecFileFn, overrides: Partial<GbrainMemoryProviderOptions> = {}) {
  return gbrainMemoryProvider({
    binPath: FAKE_BIN,
    env: {},
    accessFn: allowAccess,
    execFileFn,
    ...overrides,
  });
}

describe("parseGbrainCallOutput", () => {
  it("parses plain JSON output", () => {
    expect(parseGbrainCallOutput('{"slug":"a"}')).toEqual({ ok: true, value: { slug: "a" } });
    expect(parseGbrainCallOutput(" [1,2] \n")).toEqual({ ok: true, value: [1, 2] });
  });

  it("skips CLI warnings printed before the JSON payload", () => {
    const stdout = 'WARN: embeddings model missing\nanother line\n[{"slug":"a","chunk_text":"t"}]\n';
    expect(parseGbrainCallOutput(stdout)).toEqual({
      ok: true,
      value: [{ slug: "a", chunk_text: "t" }],
    });
  });

  it("skips warning lines that start with a JSON-like bracket", () => {
    const stdout = '[warn] embeddings model missing\n{"slug":"a","compiled_truth":"t"}\n';
    expect(parseGbrainCallOutput(stdout)).toEqual({
      ok: true,
      value: { slug: "a", compiled_truth: "t" },
    });
  });

  it("rejects output without any JSON value", () => {
    expect(parseGbrainCallOutput("no json here")).toEqual({ ok: false });
    expect(parseGbrainCallOutput("")).toEqual({ ok: false });
  });
});

describe("resolveGbrainBinPath", () => {
  it("prefers the explicit binPath over the env override", async () => {
    const resolved = await resolveGbrainBinPath({
      binPath: "/config/gbrain",
      env: { PAPERCLIP_GBRAIN_BIN: "/env/gbrain" },
      accessFn: allowAccess,
    });
    expect(resolved).toBe("/config/gbrain");
  });

  it("falls back to PAPERCLIP_GBRAIN_BIN when no binPath is configured", async () => {
    const resolved = await resolveGbrainBinPath({
      env: { PAPERCLIP_GBRAIN_BIN: "/env/gbrain" },
      accessFn: async (filePath) => {
        if (filePath !== "/env/gbrain") throw new Error("ENOENT");
      },
    });
    expect(resolved).toBe("/env/gbrain");
  });

  it("returns null when no candidate is executable", async () => {
    const resolved = await resolveGbrainBinPath({ env: {}, accessFn: denyAccess });
    expect(resolved).toBeNull();
  });
});

describe("gbrainMemoryProvider.query", () => {
  it("builds the gbrain call arguments with top_k and expand:false", async () => {
    const { calls, execFileFn } = recordingExecFile({ stdout: "[]", stderr: "" });
    const provider = makeProvider(execFileFn);

    const result = await provider.query({ companyId: COMPANY_ID, query: "what happened", topK: 3, timeoutMs: 1234 });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(FAKE_BIN);
    expect(calls[0].args).toEqual([
      "call",
      "query",
      JSON.stringify({ query: "what happened", top_k: 3, expand: false }),
    ]);
    expect(calls[0].options.timeout).toBe(1234);
  });

  it("maps result rows to snippets and skips rows without a slug", async () => {
    const stdout = JSON.stringify([
      {
        slug: `paperclip/companies/${COMPANY_ID}/projects/alpha`,
        title: "Alpha",
        chunk_text: "alpha context",
        score: 0.87,
        stale: false,
      },
      { title: "no slug", chunk_text: "dropped" },
      { slug: `paperclip/companies/${COMPANY_ID}/notes/beta`, chunk_text: "beta context", stale: true },
    ]);
    const provider = makeProvider(recordingExecFile({ stdout, stderr: "" }).execFileFn);

    const result = await provider.query({ companyId: COMPANY_ID, query: "q" });

    expect(result).toMatchObject({
      ok: true,
      value: {
        snippets: [
          {
            slug: `paperclip/companies/${COMPANY_ID}/projects/alpha`,
            title: "Alpha",
            text: "alpha context",
            score: 0.87,
            stale: false,
          },
          { slug: `paperclip/companies/${COMPANY_ID}/notes/beta`, text: "beta context", score: null, stale: true },
        ],
      },
    });
  });

  it("drops snippets outside the requested company namespace", async () => {
    const stdout = JSON.stringify([
      { slug: `paperclip/companies/${OTHER_COMPANY_ID}/notes/leak`, chunk_text: "wrong company", score: 0.99 },
      { slug: `paperclip/companies/${COMPANY_ID}/notes/keep`, chunk_text: "right company", score: 0.8 },
    ]);
    const provider = makeProvider(recordingExecFile({ stdout, stderr: "" }).execFileFn);

    const result = await provider.query({ companyId: COMPANY_ID, query: "q" });

    expect(result).toMatchObject({
      ok: true,
      value: {
        snippets: [
          { slug: `paperclip/companies/${COMPANY_ID}/notes/keep`, text: "right company", score: 0.8 },
        ],
      },
    });
  });

  it("classifies killed processes as timeouts", async () => {
    const timeoutError = Object.assign(new Error("spawn killed"), {
      killed: true,
      signal: "SIGTERM",
    });
    const provider = makeProvider(recordingExecFile(timeoutError).execFileFn);

    const result = await provider.query({ companyId: COMPANY_ID, query: "q", timeoutMs: 50 });

    expect(result).toMatchObject({ ok: false, errorCode: "timeout" });
  });

  it("classifies non-zero exits as exec failures with stderr detail", async () => {
    const execError = Object.assign(new Error("Command failed with exit code 1"), {
      code: 1,
      stderr: "embeddings model missing",
    });
    const provider = makeProvider(recordingExecFile(execError).execFileFn);

    const result = await provider.query({ companyId: COMPANY_ID, query: "q" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("exec_failed");
      expect(result.errorMessage).toContain("embeddings model missing");
    }
  });

  it("returns bad_output when stdout has no JSON", async () => {
    const provider = makeProvider(recordingExecFile({ stdout: "garbage", stderr: "" }).execFileFn);

    const result = await provider.query({ companyId: COMPANY_ID, query: "q" });

    expect(result).toMatchObject({ ok: false, errorCode: "bad_output" });
  });

  it("returns unavailable without executing when no binary resolves", async () => {
    const { calls, execFileFn } = recordingExecFile({ stdout: "[]", stderr: "" });
    const provider = gbrainMemoryProvider({
      env: {},
      accessFn: denyAccess,
      execFileFn,
    });

    expect(await provider.isAvailable()).toBe(false);
    const result = await provider.query({ companyId: COMPANY_ID, query: "q" });
    expect(result).toMatchObject({ ok: false, errorCode: "unavailable" });
    expect(calls).toHaveLength(0);
  });
});

describe("gbrainMemoryProvider.capture", () => {
  it("builds the put_page call with slug, content, type, and tags", async () => {
    const { calls, execFileFn } = recordingExecFile({
      stdout: JSON.stringify({
        slug: `paperclip/companies/${COMPANY_ID}/runs/r1`,
        status: "created_or_updated",
        chunks: 2,
      }),
      stderr: "",
    });
    const provider = makeProvider(execFileFn);

    const result = await provider.capture({
      companyId: COMPANY_ID,
      slug: `paperclip/companies/${COMPANY_ID}/runs/r1`,
      content: "# Run summary",
      tags: ["paperclip", `company:${COMPANY_ID}`],
      timeoutMs: 9000,
    });

    expect(result).toMatchObject({ ok: true, value: { slug: `paperclip/companies/${COMPANY_ID}/runs/r1` } });
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe("call");
    expect(calls[0].args[1]).toBe("put_page");
    expect(JSON.parse(calls[0].args[2])).toEqual({
      slug: `paperclip/companies/${COMPANY_ID}/runs/r1`,
      content: "# Run summary",
      type: "note",
      tags: ["paperclip", `company:${COMPANY_ID}`],
    });
    expect(calls[0].options.timeout).toBe(9000);
  });

  it("falls back to the request slug when the CLI omits it", async () => {
    const provider = makeProvider(
      recordingExecFile({ stdout: JSON.stringify({ status: "created_or_updated" }), stderr: "" }).execFileFn,
    );

    const result = await provider.capture({
      companyId: COMPANY_ID,
      slug: `paperclip/companies/${COMPANY_ID}/notes/n1`,
      content: "text",
    });

    expect(result).toMatchObject({ ok: true, value: { slug: `paperclip/companies/${COMPANY_ID}/notes/n1` } });
  });

  it("rejects capture slugs outside the requested company namespace", async () => {
    const { calls, execFileFn } = recordingExecFile({ stdout: "{}", stderr: "" });
    const provider = makeProvider(execFileFn);

    const result = await provider.capture({
      companyId: COMPANY_ID,
      slug: `paperclip/companies/${OTHER_COMPANY_ID}/notes/n1`,
      content: "text",
    });

    expect(result).toMatchObject({ ok: false, errorCode: "exec_failed" });
    expect(calls).toHaveLength(0);
  });
});
