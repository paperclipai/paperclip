import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const label = "paperclip.runner-e2e.root";
const metadataPath = (root: string) => path.join(root, "docker-postgres.json");
const rootDigest = (root: string) => createHash("sha256").update(path.resolve(root)).digest("hex");
interface Fixture { schema: "paperclip.runner-e2e.docker-postgres.v1"; name: string; rootSha256: string; connectionString?: string }
interface ContainerInspection {
  Image: string;
  Config?: { Labels?: Record<string, string> };
  State?: { Running?: boolean };
  NetworkSettings?: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> };
}
async function metadata(root: string): Promise<Fixture | null> {
  const file = metadataPath(root);
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe Docker test database metadata");
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error("Unsafe Docker test database metadata");
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as Fixture;
    if (value.schema !== "paperclip.runner-e2e.docker-postgres.v1" || !/^paperclip-runner-e2e-[a-f0-9-]{36}$/.test(value.name) || value.rootSha256 !== rootDigest(root)) throw new Error("Docker test database ownership mismatch");
    return value;
  } finally { await handle.close(); }
}
async function inspect(fixture: Fixture): Promise<ContainerInspection | null> {
  let result;
  try { result = await exec("docker", ["inspect", fixture.name], { timeout: 15_000, maxBuffer: 1024 * 1024 }); }
  catch (error) { if (/No such (object|container)/i.test(String((error as { stderr?: string }).stderr))) return null; throw error; }
  const value = (JSON.parse(result.stdout) as ContainerInspection[])[0];
  if (value?.Config?.Labels?.[label] !== fixture.rootSha256) throw new Error("Refusing unrelated Docker test database");
  return value;
}
function databaseConnection(owned: ContainerInspection | null): string {
  const ports = owned?.NetworkSettings?.Ports?.["5432/tcp"];
  if (!owned?.State?.Running || ports?.length !== 1 || ports[0].HostIp !== "127.0.0.1" ||
    !/^[1-9][0-9]{0,4}$/.test(ports[0].HostPort) || Number(ports[0].HostPort) > 65535) throw new Error("Docker test database is not bound exclusively to loopback");
  return `postgres://paperclip@127.0.0.1:${ports[0].HostPort}/paperclip`;
}
export async function prepareDockerTestDatabase(root: string): Promise<string> {
  if (await metadata(root)) throw new Error("Docker test database already prepared");
  const fixture: Fixture = { schema: "paperclip.runner-e2e.docker-postgres.v1", name: `paperclip-runner-e2e-${randomUUID()}`, rootSha256: rootDigest(root) };
  // Persist ownership before creating a resource, so interrupted setup is cleanable.
  await writeFile(metadataPath(root), JSON.stringify(fixture), { flag: "wx", mode: 0o600 });
  await exec("docker", ["run", "--detach", "--name", fixture.name, "--label", `${label}=${fixture.rootSha256}`,
    "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=paperclip", "--env", "POSTGRES_DB=paperclip",
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--tmpfs", "/var/lib/postgresql/data:rw", "postgres:17"], { timeout: 60_000 });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      // TCP readiness excludes the entrypoint's temporary initialization server.
      await exec("docker", ["exec", fixture.name, "pg_isready", "-h", "127.0.0.1", "-U", "paperclip", "-d", "paperclip"], { timeout: 10_000 });
    } catch (error) {
      if (attempt === 99) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    const owned = await inspect(fixture);
    fixture.connectionString = databaseConnection(owned);
    // Keep the actual immutable image identity with the fixture evidence.
    await writeFile(metadataPath(root), JSON.stringify({ ...fixture, imageId: owned!.Image }), { mode: 0o600 });
    return fixture.connectionString;
  }
  throw new Error("Docker test database did not become ready");
}
export async function assertDockerTestDatabaseIsolation(root: string, connectionString: string): Promise<void> {
  const fixture = await metadata(root);
  if (!fixture || fixture.connectionString !== connectionString) throw new Error("Runner E2E external database is not fixture-owned");
  const owned = await inspect(fixture);
  if (connectionString !== databaseConnection(owned)) throw new Error("Runner E2E Docker database isolation changed");
}
export async function cleanupDockerTestDatabase(root: string): Promise<void> {
  const fixture = await metadata(root);
  if (!fixture || !await inspect(fixture)) return;
  await exec("docker", ["rm", "--force", "--volumes", fixture.name], { timeout: 30_000 });
  if (await inspect(fixture)) throw new Error("Docker test database survived cleanup");
}
