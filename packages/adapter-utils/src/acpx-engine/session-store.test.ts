import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  type AcpSessionRecord,
} from "acpx/runtime";
import { createCredentialSafeSessionStore, stripPersistedLaunchEnv } from "./session-store.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const envEchoFixturePath = path.join(repoRoot, "scripts/mcp-fixtures/servers/acp-env-echo-agent.mjs");

// Shaped like the credentials KEE-188 found on disk (a Supabase `sbp_` token and
// a Vercel token), so the assertions below read the same way the incident sweep
// does. Values are synthetic and assembled at runtime rather than written as
// literals: a secret-shaped literal in a test file trips secret scanners
// (GitHub push protection rejected exactly this), and teaching every scanner to
// ignore a fixture is worse than not writing one.
//
// `PAPERCLIP_API_KEY` is here for KEE-234. It is a different and higher class of
// credential than the other two: those are *capability* (they act on Vercel and
// Supabase), this one is *authority* — it is what makes a seat that seat to the
// Paperclip API, so an at-rest copy is readable seat identity. KEE-234 measured
// 480 of 480 session records carrying a live one, across 26 seats.
//
// It is covered here because the fix strips the whole `env` map rather than
// matching credential names, so no name-shaped case can be "the one it misses".
// That is the property this fixture exists to hold: the assertion is not "the
// three known names are absent", it is `session_options.env` is absent entirely.
// A fourth credential added tomorrow is covered without touching this file.
const PAPERCLIP_API_KEY_FIXTURE = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url"),
  Buffer.from(
    JSON.stringify({ sub: "agent-1", iss: "paperclip", aud: "paperclip-api", exp: 4102444800 }),
    "utf8",
  ).toString("base64url"),
  "b".repeat(43),
].join(".");

const BOUND_SECRETS: Record<
  "SUPABASE_KEECE_TOKEN" | "VERCEL_TOKEN_KEECE" | "PAPERCLIP_API_KEY",
  string
> = {
  SUPABASE_KEECE_TOKEN: ["sbp", "f".repeat(40)].join("_"),
  VERCEL_TOKEN_KEECE: ["vercel", "fixture", "a".repeat(32)].join("_"),
  PAPERCLIP_API_KEY: PAPERCLIP_API_KEY_FIXTURE,
};

const LAUNCH_ENV: Record<string, string> = {
  ...BOUND_SECRETS,
  PATH: process.env.PATH ?? "",
  PAPERCLIP_ENV_ECHO_NAMES: Object.keys(BOUND_SECRETS).join(","),
};

const secretValues = Object.values(BOUND_SECRETS);
const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kee192-"));
  cleanupRoots.push(root);
  return root;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function baseRecord(overrides: Partial<AcpSessionRecord> = {}): AcpSessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "record-1",
    acpSessionId: "session-1",
    agentCommand: "fixture",
    cwd: "/tmp",
    createdAt: "2026-09-15T00:00:00.000Z",
    lastUsedAt: "2026-09-15T00:00:00.000Z",
    lastSeq: 0,
    eventLog: { schema: "acpx.session-event-log.v1", segments: [] },
    messages: [],
    updated_at: "2026-09-15T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
    ...overrides,
  } as AcpSessionRecord;
}

async function readPersistedSessionFiles(
  stateDir: string,
): Promise<Array<{ file: string; text: string; parsed: Record<string, unknown> }>> {
  const sessionsDir = path.join(stateDir, "sessions");
  const entries = await fs.readdir(sessionsDir).catch(() => [] as string[]);
  const files = entries.filter((entry) => entry.endsWith(".json") && entry !== "index.json");
  return await Promise.all(
    files.map(async (file) => {
      const text = await fs.readFile(path.join(sessionsDir, file), "utf8");
      return { file, text, parsed: JSON.parse(text) as Record<string, unknown> };
    }),
  );
}

function storedSessionEnv(parsed: Record<string, unknown>): unknown {
  const acpx = parsed.acpx as { session_options?: { env?: unknown } } | undefined;
  return acpx?.session_options?.env;
}

describe("stripPersistedLaunchEnv", () => {
  it("removes the launch environment and keeps the other session options", () => {
    const record = baseRecord({
      acpx: {
        current_model_id: "fixture-model",
        session_options: { model: "fixture-model", max_turns: 3, env: { ...BOUND_SECRETS } },
      },
    });

    const stripped = stripPersistedLaunchEnv(record);

    expect(stripped.acpx?.session_options).toEqual({ model: "fixture-model", max_turns: 3 });
    expect(stripped.acpx?.current_model_id).toBe("fixture-model");
  });

  it("drops session_options entirely when the environment was the only option", () => {
    const record = baseRecord({ acpx: { session_options: { env: { ...BOUND_SECRETS } } } });

    const stripped = stripPersistedLaunchEnv(record);

    expect(stripped.acpx).toBeDefined();
    expect(stripped.acpx && "session_options" in stripped.acpx).toBe(false);
  });

  it("leaves the caller's record alone so the live session keeps its credentials", () => {
    const sessionOptions = { env: { ...BOUND_SECRETS } };
    const record = baseRecord({ acpx: { session_options: sessionOptions } });

    stripPersistedLaunchEnv(record);

    expect(record.acpx?.session_options).toBe(sessionOptions);
    expect(sessionOptions.env.SUPABASE_KEECE_TOKEN).toBe(BOUND_SECRETS.SUPABASE_KEECE_TOKEN);
  });

  it("returns records with no stored environment unchanged", () => {
    const withOtherOptions = baseRecord({ acpx: { session_options: { model: "fixture-model" } } });
    expect(stripPersistedLaunchEnv(withOtherOptions)).toBe(withOtherOptions);

    const withoutAcpxState = baseRecord();
    expect(stripPersistedLaunchEnv(withoutAcpxState)).toBe(withoutAcpxState);
  });
});

describe("createCredentialSafeSessionStore", () => {
  it("writes no bound-secret value to the session record and re-injects it on load", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "state");
    const store = createCredentialSafeSessionStore({
      persisted: createRuntimeStore({ stateDir }),
      launchEnv: LAUNCH_ENV,
    });

    await store.save(
      baseRecord({
        acpx: { session_options: { model: "fixture-model", env: { ...LAUNCH_ENV } } },
      }),
    );

    const persisted = await readPersistedSessionFiles(stateDir);
    expect(persisted).toHaveLength(1);
    for (const value of secretValues) {
      expect(persisted[0]!.text).not.toContain(value);
    }
    expect(storedSessionEnv(persisted[0]!.parsed)).toBeUndefined();

    // Resume reads through the wrapper, which supplies this run's environment.
    const loaded = await store.load("record-1");
    expect(loaded?.acpx?.session_options?.env).toEqual(LAUNCH_ENV);
    expect(loaded?.acpx?.session_options?.model).toBe("fixture-model");
  });

  // Negative control. Without the wrapper the same record puts the same values
  // on disk, so the assertions above are testing the fix, not a session shape
  // that never carried an environment in the first place.
  it("is the only reason the value is absent: the unwrapped store writes it", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "state");

    await createRuntimeStore({ stateDir }).save(
      baseRecord({
        acpx: { session_options: { model: "fixture-model", env: { ...LAUNCH_ENV } } },
      }),
    );

    const persisted = await readPersistedSessionFiles(stateDir);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.text).toContain(BOUND_SECRETS.SUPABASE_KEECE_TOKEN);
    // KEE-234: the seat-identity token lands on disk too without the wrapper.
    // This is the control for the KEE-234 assertion specifically — it reproduces
    // the 480-of-480 measurement in miniature, so "absent above" is attributable
    // to the wrapper and not to a record shape that never carried the key.
    expect(persisted[0]!.text).toContain(BOUND_SECRETS.PAPERCLIP_API_KEY);
    expect(storedSessionEnv(persisted[0]!.parsed)).toMatchObject({
      SUPABASE_KEECE_TOKEN: BOUND_SECRETS.SUPABASE_KEECE_TOKEN,
      PAPERCLIP_API_KEY: BOUND_SECRETS.PAPERCLIP_API_KEY,
    });
  });
});

describe("acpx session records on disk", () => {
  it("holds no bound-secret value after a real session is started and resumed", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "cwd");
    await fs.mkdir(cwd, { recursive: true });

    const openRuntime = () =>
      createAcpRuntime({
        cwd,
        sessionStore: createCredentialSafeSessionStore({
          persisted: createRuntimeStore({ stateDir }),
          launchEnv: LAUNCH_ENV,
        }),
        agentRegistry: createAgentRegistry({
          overrides: { env_echo: `${process.execPath} ${envEchoFixturePath}` },
        }),
        permissionMode: "deny-all",
        nonInteractivePermissions: "deny",
        inheritProcessEnv: false,
        timeoutMs: 20_000,
      });

    const promptOnce = async (
      runtime: ReturnType<typeof openRuntime>,
      resumeSessionId: string | undefined,
      requestId: string,
    ) => {
      const handle = await runtime.ensureSession({
        sessionKey: "kee192-session",
        agent: "env_echo",
        mode: "persistent",
        cwd,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        // Exactly what the engine passes: this run's launch environment.
        sessionOptions: { env: LAUNCH_ENV },
      });
      let output = "";
      for await (const event of runtime.runTurn({ handle, text: "echo env", mode: "prompt", requestId })) {
        if (event.type === "text_delta" && event.stream !== "thought") output += event.text;
      }
      return { handle, echo: JSON.parse(output) as { pid: number; digests: Record<string, string | null> } };
    };

    const first = openRuntime();
    let firstResult;
    try {
      firstResult = await promptOnce(first, undefined, "kee192-request-1");
    } finally {
      await first.close({ handle: { ...firstResult!.handle }, reason: "kee192 first turn complete" }).catch(() => {});
    }

    // The provider child launched with the credential: nothing about this change
    // starves the agent of the environment it needs.
    expect(firstResult.echo.digests.SUPABASE_KEECE_TOKEN).toBe(digest(BOUND_SECRETS.SUPABASE_KEECE_TOKEN));
    // A resume needs a backend session id to resume from. Assert it exists
    // rather than letting the spread below quietly open a fresh session.
    expect(firstResult.handle.backendSessionId).toBeTruthy();

    const afterFirst = await readPersistedSessionFiles(stateDir);
    expect(afterFirst.length).toBeGreaterThan(0);
    for (const entry of afterFirst) {
      for (const value of secretValues) {
        expect(entry.text, `${entry.file} holds a bound-secret value`).not.toContain(value);
      }
      expect(storedSessionEnv(entry.parsed)).toBeUndefined();
    }

    // Resume the persisted session in a fresh runtime, the way the next
    // heartbeat does, and prove the resumed provider still gets the credential.
    const second = openRuntime();
    let secondResult;
    try {
      secondResult = await promptOnce(second, firstResult.handle.backendSessionId, "kee192-request-2");
    } finally {
      await second.close({ handle: { ...secondResult!.handle }, reason: "kee192 resume complete" }).catch(() => {});
    }

    expect(secondResult.echo.digests.VERCEL_TOKEN_KEECE).toBe(digest(BOUND_SECRETS.VERCEL_TOKEN_KEECE));
    // A different provider process (so the credential was re-supplied at launch,
    // not inherited from a still-running child) continuing the same ACP session.
    expect(secondResult.echo.pid).not.toBe(firstResult.echo.pid);
    expect(secondResult.handle.backendSessionId).toBe(firstResult.handle.backendSessionId);

    const afterResume = await readPersistedSessionFiles(stateDir);
    expect(afterResume.length).toBeGreaterThan(0);
    for (const entry of afterResume) {
      for (const value of secretValues) {
        expect(entry.text, `${entry.file} holds a bound-secret value after resume`).not.toContain(value);
      }
      expect(storedSessionEnv(entry.parsed)).toBeUndefined();
    }
  }, 60_000);
});
