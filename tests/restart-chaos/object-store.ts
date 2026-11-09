import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const MINIO_RELEASE = "RELEASE.2025-04-22T22-12-26Z";
export const DEFAULT_MINIO_BINARY = path.join(os.homedir(), ".cache", "paperclip", "tools", "minio", "minio");

export function minioBinary(environment: NodeJS.ProcessEnv = process.env): string | null {
  const candidate = environment.RESTART_CHAOS_MINIO_BIN || DEFAULT_MINIO_BINARY;
  return existsSync(candidate) ? candidate : null;
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

export interface ObjectStore {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  dataDir: string;
  stop(): Promise<void>;
}

export function objectStoreServerEnvironment(store: Pick<ObjectStore, "bucket" | "region" | "accessKeyId" | "secretAccessKey">,
  endpoint: string, prefix: string): Record<string, string> {
  return {
    PAPERCLIP_STORAGE_PROVIDER: "s3",
    PAPERCLIP_STORAGE_S3_BUCKET: store.bucket,
    PAPERCLIP_STORAGE_S3_REGION: store.region,
    PAPERCLIP_STORAGE_S3_ENDPOINT: endpoint,
    PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE: "true",
    PAPERCLIP_STORAGE_S3_PREFIX: prefix,
    AWS_ACCESS_KEY_ID: store.accessKeyId,
    AWS_SECRET_ACCESS_KEY: store.secretAccessKey,
    AWS_SESSION_TOKEN: "",
    AWS_CREDENTIAL_EXPIRATION: "",
    AWS_EC2_METADATA_DISABLED: "true",
  };
}

export async function startMinio(input: { binary: string; root: string; bucket?: string; readyTimeoutMs?: number }): Promise<ObjectStore> {
  const dataDir = path.join(input.root, "object-store");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const [port, consolePort] = [await freeLoopbackPort(), await freeLoopbackPort()];
  const accessKeyId = `chaos${randomBytes(6).toString("hex")}`;
  const secretAccessKey = randomBytes(24).toString("hex");
  const child: ChildProcess = spawn(input.binary, ["server", dataDir, "--address", `127.0.0.1:${port}`, "--console-address", `127.0.0.1:${consolePort}`, "--quiet"], {
    env: { PATH: process.env.PATH ?? "", HOME: input.root, MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey,
      MINIO_BROWSER: "off", MINIO_UPDATE: "off" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let spawnError: Error | null = null;
  child.on("error", error => { spawnError = error; });
  child.stderr?.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-4_000); });
  const endpoint = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (spawnError || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(10_000).then(() => { child.kill("SIGKILL"); return exited; })]);
  };
  const deadline = Date.now() + (input.readyTimeoutMs ?? 30_000);
  for (;;) {
    if (spawnError) throw new Error(`MinIO could not start from ${input.binary}: ${(spawnError as Error).message}`);
    if (child.exitCode !== null) throw new Error(`MinIO exited before it was ready (${child.exitCode}): ${stderr}`);
    const live = await fetch(`${endpoint}/minio/health/live`).then(response => response.ok).catch(() => false);
    if (live) break;
    if (Date.now() > deadline) { await stop(); throw new Error(`MinIO did not become ready: ${stderr}`); }
    await delay(200);
  }
  const bucket = input.bucket ?? `chaos-${randomBytes(4).toString("hex")}`;
  const region = "us-east-1";
  const { S3Client, CreateBucketCommand } = createRequire(new URL("../../server/package.json", import.meta.url))("@aws-sdk/client-s3");
  const client = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    await stop();
    throw error;
  } finally {
    client.destroy();
  }
  return { endpoint, bucket, region, accessKeyId, secretAccessKey, dataDir, stop };
}
