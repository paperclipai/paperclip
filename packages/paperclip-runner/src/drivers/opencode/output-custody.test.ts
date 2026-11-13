import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  OUTPUT_CUSTODY_DIRECTORY_ENV,
  OUTPUT_CUSTODY_KEYS_ENV,
  OUTPUT_CUSTODY_NONCE_ENV,
  outputCustodyValues,
  prepareOpenCodeOutputCustody,
  redactOpenCodeModelRequest,
  type OpenCodeOutputCustody,
} from "./output-custody.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const SECRET = "synthetic-delivered-secret-7f3a";
const PLAIN = "ordinary-configured-setting";

async function prepared(secrets = [{ name: "PUBLISHING_API_KEY", value: SECRET }]) {
  const root = await mkdtemp(join(tmpdir(), "paperclip-output-custody-"));
  roots.push(root);
  const environment = { PATH: process.env.PATH, PUBLISHING_API_KEY: SECRET, PLAIN_SETTING: PLAIN,
    MULTILINE_KEY: "-----BEGIN KEY-----\nline-one-material\nline-two-material\n-----END KEY-----" };
  const custody = await prepareOpenCodeOutputCustody({
    directory: join(root, "launch"), binDirectory: join(root, "bin"), configDirectory: join(root, "config"),
    environment, secrets,
  });
  return { root, environment, custody };
}

/** Run a command through the wrapper the way OpenCode does: `<shell> -c <command>`. */
async function shell(custody: OpenCodeOutputCustody, environment: NodeJS.ProcessEnv, command: string, options: { ready?: boolean } = {}) {
  if (options.ready !== false) {
    await writeFile(join(custody.environment[OUTPUT_CUSTODY_DIRECTORY_ENV]!, "ready"), custody.environment[OUTPUT_CUSTODY_NONCE_ENV]!);
  }
  try {
    const result = await run(custody.config.shell, ["-c", command], { env: { ...environment, ...custody.environment }, timeout: 10_000 });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

describe("OpenCode output custody", () => {
  it("is not prepared when no configured secret crosses, so older controllers keep today's launch", async () => {
    const { custody } = await prepared([]);
    expect(custody).toBeNull();
  });

  it("filters exact secret values from command output before OpenCode can capture it", async () => {
    const { custody, environment } = await prepared();
    const result = await shell(custody!, environment, `echo "key=$PUBLISHING_API_KEY"; echo "err $PUBLISHING_API_KEY" >&2; echo "$PLAIN_SETTING"; printf "tail-$PUBLISHING_API_KEY"; exit 7`);
    expect(result.code).toBe(7);
    expect(result.output).not.toContain(SECRET);
    expect(result.output).toContain("key=[REDACTED]");
    expect(result.output).toContain("err [REDACTED]");
    expect(result.output).toContain(PLAIN);
    expect(result.output).toContain("tail-[REDACTED]");
  });

  it("filters each line of a multi-line secret and keeps the exit status of a signalled command", async () => {
    const { custody, environment } = await prepared([{ name: "MULTILINE_KEY", value: "-----BEGIN KEY-----\nline-one-material\nline-two-material\n-----END KEY-----" }]);
    const result = await shell(custody!, environment, `printf '%s\\n' "$MULTILINE_KEY"; kill -TERM $$`);
    expect(result.output).not.toContain("line-one-material");
    expect(result.output).not.toContain("line-two-material");
    expect(result.code).toBe(143);
  });

  it("refuses to run commands until the plugin that protects file reads has started for this launch", async () => {
    const { root, custody, environment } = await prepared();
    const marker = join(root, "ran");
    const missing = await shell(custody!, environment, `touch ${marker}`, { ready: false });
    expect(missing.code).toBe(126);
    expect(missing.output).toContain("secret output protection is not active");
    await expect(stat(marker)).rejects.toThrow();
    await writeFile(join(custody!.environment[OUTPUT_CUSTODY_DIRECTORY_ENV]!, "ready"), "a-previous-launch");
    const stale = await run(custody!.config.shell, ["-c", `touch ${marker}`], { env: { ...environment, ...custody!.environment } }).catch(error => error);
    expect(stale.code).toBe(126);
    await expect(stat(marker)).rejects.toThrow();
  });

  it("does not let a background process hold a finished command open", async () => {
    const { custody, environment } = await prepared();
    const started = Date.now();
    const result = await shell(custody!, environment, `(sleep 5; echo late) & echo now`);
    expect(result.output.trim()).toBe("now");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("rewrites completed non-shell tool results in the plugin and marks this launch ready", async () => {
    const { custody, environment } = await prepared();
    const saved = { ...process.env };
    Object.assign(process.env, environment, custody!.environment);
    try {
      const module = await import(`${pathToFileURL(custody!.config.plugin[0]!.replace("file://", "")).href}?t=${Date.now()}`);
      const hooks = await module.PaperclipOutputCustody({});
      expect(await readFile(join(custody!.environment[OUTPUT_CUSTODY_DIRECTORY_ENV]!, "ready"), "utf8"))
        .toBe(custody!.environment[OUTPUT_CUSTODY_NONCE_ENV]);
      const output = { title: `read ${SECRET}`, output: `1: ${SECRET}\n2: ${PLAIN}`, metadata: { preview: [SECRET, { nested: SECRET }] },
        content: [{ type: "text", text: `mcp ${SECRET}` }] };
      await hooks["tool.execute.after"]({ tool: "read", sessionID: "s", callID: "c" }, output);
      expect(JSON.stringify(output)).not.toContain(SECRET);
      expect(output.output).toBe(`1: [REDACTED]\n2: ${PLAIN}`);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("names only secret keys and never writes a value to disk", async () => {
    const { root, custody } = await prepared();
    expect(custody!.environment[OUTPUT_CUSTODY_KEYS_ENV]).toBe("PUBLISHING_API_KEY");
    const files = await run("/bin/sh", ["-c", `grep -rl -- ${JSON.stringify(SECRET)} ${JSON.stringify(root)} || true`]);
    expect(files.stdout.trim()).toBe("");
  });

  it("keeps the executable wrapper byte-identical across launches", async () => {
    const first = await prepared();
    const second = await prepareOpenCodeOutputCustody({
      directory: join(first.root, "launch-2"), binDirectory: join(first.root, "bin"), configDirectory: join(first.root, "config"),
      environment: first.environment, secrets: [{ name: "PUBLISHING_API_KEY", value: SECRET }],
    });
    expect(second!.config.shell).toBe(first.custody!.config.shell);
    expect(second!.environment[OUTPUT_CUSTODY_NONCE_ENV]).not.toBe(first.custody!.environment[OUTPUT_CUSTODY_NONCE_ENV]);
  });
});

describe("model request redaction", () => {
  const values = outputCustodyValues([SECRET, "quote\"and\\slash-secret"]);
  it("removes raw and JSON-escaped secret values and leaves other bodies untouched", () => {
    const body = Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "tool", content: `x ${SECRET} y ${PLAIN} quote"and\\slash-secret` }] }));
    const redacted = redactOpenCodeModelRequest(body, values)!;
    expect(redacted.toString("utf8")).not.toContain(SECRET);
    expect(redacted.toString("utf8")).not.toContain("slash-secret");
    expect(JSON.parse(redacted.toString("utf8")).messages[0].content).toBe(`x [REDACTED] y ${PLAIN} [REDACTED]`);
    expect(redactOpenCodeModelRequest(Buffer.from(JSON.stringify({ model: "m", messages: [{ content: PLAIN }] })), values)).toBeNull();
  });
  it("changes only string values, never request structure", () => {
    const shaped = outputCustodyValues(["true", "model", "messages"]);
    const body = Buffer.from(JSON.stringify({ model: "m", stream: true, messages: [{ role: "tool", content: "flag=true" }] }));
    const redacted = JSON.parse(redactOpenCodeModelRequest(body, shaped)!.toString("utf8"));
    expect(redacted).toEqual({ model: "m", stream: true, messages: [{ role: "tool", content: "flag=[REDACTED]" }] });
    expect(redactOpenCodeModelRequest(Buffer.from(JSON.stringify({ model: "m", stream: true })), shaped)).toBeNull();
  });
  it("does not treat short values as secrets", () => {
    expect(outputCustodyValues(["abc", "true"])).toEqual(["true"]);
  });
});

describe("secrets custody cannot protect", () => {
  it.each([["a multi-line value whose lines are all short", "ab\ncd"], ["a short value", "abc"]])("refuses a launch with %s instead of leaving it unprotected", async (_label, value) => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-output-custody-short-"));
    roots.push(root);
    await expect(prepareOpenCodeOutputCustody({
      directory: join(root, "launch"), binDirectory: join(root, "bin"), configDirectory: join(root, "config"),
      environment: { PATH: process.env.PATH, SHORT_SECRET: value }, secrets: [{ name: "SHORT_SECRET", value }],
    })).rejects.toMatchObject({ code: "opencode_output_custody_unavailable" });
  });
});
