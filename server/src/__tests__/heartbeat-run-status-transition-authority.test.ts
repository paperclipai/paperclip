import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { transitionHeartbeatRunStatus, type HeartbeatRunStatusPatch } from "../services/heartbeat-run-lifecycle.js";

const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORITY_FILE = "services/heartbeat-run-lifecycle.ts";
const STATUS_FREE_TYPE = /^(HeartbeatRunStatusPatch|HeartbeatRunValuesPatch|(Partial<\s*)?Pick<)/;

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") files.push(...await sourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      files.push(full);
    }
  }
  return files;
}

function stringEnd(text: string, open: number): number {
  const quote = text[open]!;
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (quote === "`" && text[i] === "$" && text[i + 1] === "{") i = bracketEnd(text, i + 1) - 1;
    else if (text[i] === quote) return i + 1;
  }
  return text.length;
}

function bracketEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'" || ch === "\"" || ch === "`") i = stringEnd(text, i) - 1;
    else if (text.startsWith("//", i)) i = text.indexOf("\n", i);
    else if (text.startsWith("/*", i)) i = text.indexOf("*/", i) + 1;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch) && --depth === 0) return i + 1;
  }
  return text.length;
}

function members(text: string, open: number): string[] {
  const end = bracketEnd(text, open) - 1;
  const parts: string[] = [];
  let start = open + 1;
  for (let i = open + 1; i < end; i++) {
    const ch = text[i]!;
    if (ch === "'" || ch === "\"" || ch === "`") i = stringEnd(text, i) - 1;
    else if ("([{".includes(ch)) i = bracketEnd(text, i) - 1;
    else if (ch === ",") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start, end));
  return parts.map((part) => part.replace(/^(\s*\/\/[^\n]*\n)*\s*/, "").trim()).filter(Boolean);
}

function statusWrite(text: string, argumentAt: number): string | null {
  const argument = text.slice(argumentAt, argumentAt + 200);
  if (argument.startsWith("{")) {
    for (const member of members(text, argumentAt)) {
      if (/^status\s*(:|$)/.test(member)) return "sets status";
      if (!member.startsWith("...")) continue;
      const spread = member.slice(3).trim();
      const reason = /^[A-Za-z_$][\w$]*$/.test(spread)
        ? declaredStatusWrite(text, spread, argumentAt)
        : /[{,]\s*status\s*:/.test(spread) ? "sets status inside a spread" : null;
      if (reason) return reason;
    }
    return null;
  }
  const identifier = /^[A-Za-z_$][\w$]*/.exec(argument)?.[0];
  return identifier ? declaredStatusWrite(text, identifier, argumentAt) : "passes a value that cannot be checked";
}

function lastMatchBefore(text: string, pattern: RegExp, before: number) {
  let last: RegExpExecArray | null = null;
  for (const match of text.slice(0, before).matchAll(pattern)) last = match as RegExpExecArray;
  return last;
}

function declaredStatusWrite(text: string, name: string, usedAt: number): string | null {
  const isStatusFree = (type: string) => STATUS_FREE_TYPE.test(type.trim()) && !type.includes("\"status\"");
  const variable = lastMatchBefore(text, new RegExp(`(?:const|let)\\s+${name}\\b\\s*(?::\\s*([^=]+?))?\\s*=\\s*`, "g"), usedAt);
  const parameter = lastMatchBefore(text, new RegExp(`[(,]\\s*${name}\\??\\s*:\\s*`, "g"), usedAt);
  const parameterIsStatusFree = parameter
    && isStatusFree(text.slice(parameter.index + parameter[0].length, parameter.index + parameter[0].length + 400));
  if (parameterIsStatusFree && (!variable || parameter.index > variable.index)) return null;
  if (variable) {
    if (variable[1] && isStatusFree(variable[1])) return null;
    const initializerAt = variable.index + variable[0].length;
    if (text[initializerAt] === "{") return statusWrite(text, initializerAt);
  }
  return `spreads ${name}, whose declaration does not exclude status`;
}

async function statusWritesOutsideAuthority() {
  const violations: string[] = [];
  for (const file of await sourceFiles(serverSrc)) {
    const relative = path.relative(serverSrc, file);
    if (relative === AUTHORITY_FILE) continue;
    const text = await readFile(file, "utf8");
    const line = (index: number) => text.slice(0, index).split("\n").length;
    for (let at = text.indexOf(".update(heartbeatRuns)"); at !== -1; at = text.indexOf(".update(heartbeatRuns)", at + 1)) {
      let argumentAt = text.indexOf(".set(", at) + ".set(".length;
      while (/\s/.test(text[argumentAt]!)) argumentAt++;
      const reason = statusWrite(text, argumentAt);
      if (reason) violations.push(`${relative}:${line(at)} ${reason}`);
    }
    for (const match of text.matchAll(/update\s+(?:heartbeat_runs|\$\{heartbeatRuns\})\s+set\b[^;`]*\bstatus\s*=/gi)) {
      violations.push(`${relative}:${line(match.index)} sets status in SQL`);
    }
  }
  return violations;
}

describe("heartbeat run status writes", () => {
  it("go only through transitionHeartbeatRunStatus", async () => {
    expect(await statusWritesOutsideAuthority()).toEqual([]);
  });
});

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;

describePostgres("transitionHeartbeatRunStatus", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-run-status-authority-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Status authority", issuePrefix: "STA" }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Status worker",
      role: "engineer",
      adapterType: "process",
    }).returning();
    companyId = company!.id;
    agentId = agent!.id;
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function createRun(status: string) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status, invocationSource: "on_demand" }).returning();
    return run!.id;
  }

  async function statusOf(runId: string) {
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return run!.status;
  }

  it("makes a concurrent transition wait for the lock holder and see its committed status", async () => {
    const runId = await createRun("queued");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });

    const first = db.transaction(async (tx) => {
      const result = await transitionHeartbeatRunStatus(tx, runId, { toStatus: "running" });
      markLocked();
      await held;
      return result;
    });
    await locked;
    let secondSettled = false;
    const second = transitionHeartbeatRunStatus(db, runId, { toStatus: "succeeded" })
      .finally(() => { secondSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(secondSettled).toBe(false);

    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult?.transition).toMatchObject({ fromStatus: "queued", toStatus: "running" });
    expect(secondResult?.transition).toMatchObject({ fromStatus: "running", toStatus: "succeeded" });
    expect(BigInt(secondResult!.transition!.transitionedAtEpochUs))
      .toBeGreaterThan(BigInt(firstResult!.transition!.transitionedAtEpochUs));
    expect(await statusOf(runId)).toBe("succeeded");
  });

  it("writes only the patch and reports no transition when the status is unchanged", async () => {
    const runId = await createRun("running");

    const result = await transitionHeartbeatRunStatus(db, runId, { toStatus: "running", patch: { error: "still running" } });

    expect(result?.transition).toBeNull();
    expect(result?.run).toMatchObject({ status: "running", error: "still running" });
  });

  it("gives every transition of a run its own event id", async () => {
    const runId = await createRun("queued");
    const eventIds: string[] = [];
    for (const toStatus of ["running", "queued", "running", "failed"]) {
      eventIds.push((await transitionHeartbeatRunStatus(db, runId, { toStatus }))!.transition!.eventId);
    }

    expect(new Set(eventIds).size).toBe(4);
  });

  it("leaves the status unchanged when the enclosing transaction rolls back", async () => {
    const runId = await createRun("queued");

    await expect(db.transaction(async (tx) => {
      await transitionHeartbeatRunStatus(tx, runId, { toStatus: "running" });
      throw new Error("roll back");
    })).rejects.toThrow("roll back");

    expect(await statusOf(runId)).toBe("queued");
  });

  it("changes nothing when the run does not match the condition", async () => {
    const runId = await createRun("queued");

    const result = await transitionHeartbeatRunStatus(db, runId, {
      toStatus: "succeeded",
      where: eq(heartbeatRuns.status, "running"),
    });

    expect(result).toBeNull();
    expect(await statusOf(runId)).toBe("queued");
  });

  it("refuses a patch that carries a status", async () => {
    const runId = await createRun("queued");
    const patch = { status: "running" } as HeartbeatRunStatusPatch;

    await expect(transitionHeartbeatRunStatus(db, runId, { toStatus: "running", patch })).rejects.toThrow(/toStatus/);
    expect(await statusOf(runId)).toBe("queued");
  });
});
