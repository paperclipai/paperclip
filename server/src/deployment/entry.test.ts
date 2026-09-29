import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, expect, it } from "vitest";
import { authUsers, companies, companyMemberships, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { paperclipConfigSchema } from "@paperclipai/shared";

const root = mkdtempSync(join(tmpdir(), "paperclip-deployment-entry-"));
const descriptorFile = join(root, "deployment.json");
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let adoptedCompanyId: string;
let port: number;
let child: ChildProcess | undefined;
let output = "";
const launch = (command: string) => spawn(process.execPath, [
  "--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
  fileURLToPath(new URL("../deployment-entry.ts", import.meta.url)), descriptorFile, command,
], { env: { ...process.env, UNRELATED_TEST_SECRET: "must-not-reach-server" }, stdio: ["ignore", "pipe", "pipe"] });
async function command(name: string) {
  const process = launch(name); let stdout = "", stderr = "";
  process.stdout!.on("data", (chunk) => { stdout += chunk; });
  process.stderr!.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(process, "exit");
  return { code, stdout, stderr };
}
async function stop() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  child = undefined;
}
beforeAll(async () => {
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const address = socket.address(); if (!address || typeof address === "string") throw new Error("Missing port");
  port = address.port; await new Promise<void>((resolve) => socket.close(() => resolve()));
  database = await startEmbeddedPostgresTestDatabase("paperclip-deployment-entry-db-");
  const db = createDb(database.connectionString);
  const [adopted] = await db.insert(companies).values({ name: "Existing company", issuePrefix: "EXIST" }).returning();
  adoptedCompanyId = adopted.id;
  const config = paperclipConfigSchema.parse({
    $meta: { version: 1, updatedAt: new Date().toISOString(), source: "configure" },
    server: { deploymentMode: "authenticated", exposure: "private", host: "127.0.0.1", port, serveUi: false },
    auth: { baseUrlMode: "explicit", publicBaseUrl: `http://localhost:${port}`, disableSignUp: true },
    database: { mode: "postgres", backup: { enabled: false } },
    logging: { mode: "file", logDir: join(root, "logs") },
    telemetry: { enabled: false },
  });
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ version: 1, owner: "entry-owner",
    companies: { example: { fields: { name: "Entry test" } }, other: { fields: { name: "Other company" } },
      adopted: { adopt: adoptedCompanyId, fields: { name: "Existing company" } } },
    projects: { main: { company: "example", fields: { name: "Main" } }, outside: { company: "example", fields: { name: "Outside bridge" } } },
    agents: { worker: { company: "example", fields: { name: "Bridge worker", adapterType: "hermes_gateway", adapterConfig: { apiBaseUrl: "http://127.0.0.1:1" } }, credentials: { apiKey: "gateway" } } },
    taskBridges: { ingress: { agent: "worker", project: "main", allowedAssignees: ["worker"], credential: "bridge" } },
  }));
  writeFileSync(join(root, "database"), database.connectionString, { mode: 0o600 });
  writeFileSync(join(root, "auth"), "entry-test-signing-secret-at-least-32-characters", { mode: 0o600 });
  writeFileSync(join(root, "password"), "entry-test-operator-password", { mode: 0o600 });
  writeFileSync(join(root, "bridge"), "entry-test-bridge-token-at-least-32-characters", { mode: 0o600 });
  writeFileSync(join(root, "gateway"), "fixture-gateway-token", { mode: 0o600 });
  writeFileSync(descriptorFile, JSON.stringify({ version: 1, home: root, instance: "entry", configFile: join(root, "config.json"),
    manifestFile: join(root, "manifest.json"), serverCredentials: { auth: join(root, "auth"), database: join(root, "database") },
    credentialFiles: { bridge: join(root, "bridge"), gateway: join(root, "gateway") },
    bootstrap: { email: "operator@example.test", name: "Entry operator", passwordFile: join(root, "password") } }));
}, 90000);
afterAll(async () => { await stop(); await database?.cleanup(); rmSync(root, { recursive: true, force: true }); });

it("runs the real launcher, authenticates, plans read-only and fences online apply", async () => {
  const db = createDb(database.connectionString);
  const initialPlan = await command("plan");
  expect(initialPlan.code, initialPlan.stderr).toBe(0);
  expect(JSON.parse(initialPlan.stdout).differences).toContainEqual(expect.objectContaining({
    kind: "company", key: "adopted", action: "adopt",
  }));
  expect(await db.select().from(authUsers)).toHaveLength(0);
  expect(await db.select().from(companyMemberships)).toHaveLength(0);
  child = launch("serve");
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child?.exitCode !== null) throw new Error(`Launcher exited: ${output}`);
    try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).status; } catch { return 0; }
  }, { timeout: 45000, interval: 500 }).toBe(200);
  const response = await fetch(`http://localhost:${port}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: `http://localhost:${port}` },
    body: JSON.stringify({ email: "operator@example.test", password: "entry-test-operator-password" }),
  });
  expect(response.status, await response.text()).toBe(200);
  const bindings = JSON.parse(readFileSync(join(root, "instances/entry/deployment-bindings.json"), "utf8")).bindings as Record<string, string>;
  expect(bindings["company/adopted"]).toBe(adoptedCompanyId);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const listed = await fetch(`http://localhost:${port}/api/companies?scope=accessible`, { headers: { cookie } });
  expect(listed.status).toBe(200);
  expect((await listed.json() as { id: string }[]).map((company) => company.id).sort()).toEqual([
    bindings["company/example"], bindings["company/other"], adoptedCompanyId,
  ].sort());
  expect((await fetch(`http://localhost:${port}/api/companies/${adoptedCompanyId}`, { headers: { cookie } })).status).toBe(200);
  const createIssue = (company: string, project: string) => fetch(`http://localhost:${port}/api/companies/${company}/issues`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer entry-test-bridge-token-at-least-32-characters" },
    body: JSON.stringify({ title: "Bridge request", status: "backlog", projectId: project, assigneeAgentId: bindings["agent/worker"] }),
  });
  const allowed = await createIssue(bindings["company/example"], bindings["project/main"]);
  expect(allowed.status, await allowed.text()).toBe(201);
  expect((await createIssue(bindings["company/example"], bindings["project/outside"])).status).toBe(403);
  expect((await createIssue(bindings["company/other"], bindings["project/main"])).status).toBe(403);
  const plan = await command("plan");
  expect(plan.code, plan.stderr).toBe(0);
  expect(JSON.parse(plan.stdout).differences).toEqual([]);
  expect((await command("check")).code).toBe(0);
  expect((await command("apply")).code).toBe(1);
  const environment = readFileSync(`/proc/${child!.pid}/environ`, "utf8");
  expect(environment).not.toContain("entry-test-signing-secret");
  expect(output).not.toContain("entry-test-signing-secret");
  expect(output).not.toContain("entry-test-operator-password");
  expect(output).toContain("set (runtime credential)");
  await stop();
  expect((await command("apply")).code).toBe(0);
}, 120000);

it("refuses HTTP port collisions instead of silently moving the instance", async () => {
  await stop();
  const occupied = createServer(); occupied.listen(port, "127.0.0.1"); await once(occupied, "listening");
  try { expect((await command("serve")).code).toBe(1); }
  finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
}, 30000);

it("rejects manifest owner changes and omissions without leaving the old fleet unmanaged", async () => {
  await stop();
  const originalManifest = readFileSync(join(root, "manifest.json"), "utf8");
  const originalDescriptor = readFileSync(descriptorFile, "utf8");
  try {
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ ...JSON.parse(originalManifest), owner: "another-owner" }));
    for (const name of ["plan", "check", "apply"]) expect((await command(name)).code).toBe(1);
    writeFileSync(join(root, "manifest.json"), originalManifest);
    writeFileSync(descriptorFile, JSON.stringify({ ...JSON.parse(originalDescriptor), manifestFile: undefined }));
    expect((await command("apply")).code).toBe(1);
  } finally {
    writeFileSync(join(root, "manifest.json"), originalManifest);
    writeFileSync(descriptorFile, originalDescriptor);
  }
  expect((await command("check")).code).toBe(0);
  const db = createDb(database.connectionString);
  await db.execute(sql`update instance_settings set general = '{"instance":"entry"}'::jsonb
    where singleton_key = 'deployment'`);
  const legacyPlan = await command("plan");
  expect(legacyPlan.code).toBe(0);
  expect(JSON.parse(legacyPlan.stdout).differences).toContainEqual({
    kind: "instance", key: "entry", action: "update", fields: ["owner"],
  });
  expect((await command("check")).code).toBe(2);
  expect((await command("apply")).code).toBe(0);
  expect((await command("check")).code).toBe(0);
}, 60000);

it("stops offline apply when its database lease is lost while reconciliation is blocked", async () => {
  await stop();
  const db = createDb(database.connectionString);
  const originalManifest = readFileSync(join(root, "manifest.json"), "utf8");
  const changed = JSON.parse(originalManifest);
  changed.companies.example.fields.name = "Should not be applied after lease loss";
  writeFileSync(join(root, "manifest.json"), JSON.stringify(changed));
  let signalLocked!: () => void;
  let releaseLock!: () => void;
  const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
  const unlock = new Promise<void>((resolve) => { releaseLock = resolve; });
  const blocker = db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(1735289201)`);
    signalLocked();
    await unlock;
  });
  const applying = launch("apply");
  let stderr = "";
  applying.stderr!.on("data", (chunk) => { stderr += chunk; });
  try {
    await locked;
    await expect.poll(async () => {
      const [row] = await db.execute(sql`select count(*)::int as count from pg_locks
        where locktype = 'advisory' and objid = 1735289202 and granted`);
      return Number(row?.count ?? 0);
    }, { timeout: 30000, interval: 100 }).toBe(1);
    const exited = once(applying, "exit");
    await db.execute(sql`select pg_terminate_backend(pid) from pg_locks
      where locktype = 'advisory' and objid = 1735289202 and granted`);
    const [code] = await exited;
    expect(code).toBe(1);
    expect(stderr).toContain("database lease was lost");
  } finally {
    if (applying.exitCode === null) {
      const exited = once(applying, "exit");
      applying.kill("SIGTERM");
      await exited;
    }
    releaseLock();
    await blocker;
    writeFileSync(join(root, "manifest.json"), originalManifest);
  }
  expect((await command("check")).code).toBe(0);
}, 60000);

it("fails closed for the unqualified remote-only profile before publishing readiness", async () => {
  await stop();
  const original = readFileSync(descriptorFile, "utf8");
  writeFileSync(descriptorFile, JSON.stringify({ ...JSON.parse(original), executionProfile: "remote-only" }));
  try {
    for (const name of ["serve", "plan", "apply", "check"]) {
      const failed = await command(name);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("remote-only execution is not yet qualified");
      expect(failed.stdout).toBe("");
    }
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  } finally { writeFileSync(descriptorFile, original); }
}, 30000);

it("refuses missing credentials and failed binding publication without readiness", async () => {
  await stop();
  for (const name of ["auth", "gateway"]) {
    const file = join(root, name), held = `${file}.held`;
    renameSync(file, held);
    try {
      expect((await command("serve")).code).toBe(1);
      await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
    } finally { renameSync(held, file); }
  }
  const bindings = join(root, "instances/entry/deployment-bindings.json"), held = `${bindings}.held`;
  renameSync(bindings, held);
  mkdirSync(bindings);
  writeFileSync(join(bindings, "barrier"), "publication barrier");
  try {
    expect((await command("serve")).code).toBe(1);
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  } finally { rmSync(bindings, { recursive: true }); renameSync(held, bindings); }
  expect((await command("check")).code).toBe(0);
}, 60000);

it("exits the real server when its database lease is lost", async () => {
  child = launch("serve");
  let logs = "";
  child.stdout!.on("data", (chunk) => { logs += chunk; });
  child.stderr!.on("data", (chunk) => { logs += chunk; });
  await expect.poll(async () => {
    if (child?.exitCode !== null) throw new Error(`Launcher exited: ${logs}`);
    try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).status; } catch { return 0; }
  }, { timeout: 45000, interval: 500 }).toBe(200);
  const exited = once(child, "exit");
  const db = createDb(database.connectionString);
  await db.execute(sql`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = 1735289202 and database = (select oid from pg_database where datname = current_database())`);
  const [code] = await exited;
  expect(code).toBe(1);
  child = undefined;
  await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  expect((await command("check")).code).toBe(0);
}, 60000);

it("refuses invalid provisioning before opening a listener", async () => {
  await stop();
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ version: 99, owner: "entry", companies: {} }));
  const failed = await command("serve");
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain("declarative startup failed");
  await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
}, 30000);
