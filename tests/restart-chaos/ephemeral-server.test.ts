import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ephemeralServerEnvironment } from "./ephemeral-server.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(keyFilePath?: (root: string) => string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "chaos-ephemeral-"));
  roots.push(root);
  const configPath = path.join(root, "home", "instances", "default", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  const keyFile = keyFilePath ? keyFilePath(root) : path.join(path.dirname(configPath), "secrets", "master.key");
  await writeFile(configPath, JSON.stringify({ database: { connectionString: "postgres://u:p@127.0.0.1:5432/paperclip" },
    secrets: { localEncrypted: { keyFilePath: keyFile } } }));
  return { root, configPath, keyFile };
}

const storage = { PAPERCLIP_STORAGE_PROVIDER: "s3", PAPERCLIP_STORAGE_S3_BUCKET: "chaos-b", PAPERCLIP_STORAGE_S3_ENDPOINT: "http://127.0.0.1:9000",
  PAPERCLIP_STORAGE_S3_REGION: "us-east-1", PAPERCLIP_STORAGE_S3_PREFIX: "chaos/w1/" };

describe("ephemeralServerEnvironment", () => {
  it("builds the volume-free environment and keeps one master key across restarts", async () => {
    const { root, configPath, keyFile } = await fixture();
    const first = await ephemeralServerEnvironment({ configPath, temporaryRoot: root, extraEnvironment: storage });
    expect(first).toMatchObject({ PAPERCLIP_EPHEMERAL_SERVER: "true", PAPERCLIP_DURABLE_AGENT_FILES: "true", PAPERCLIP_SHARED_UI_ASSETS: "true",
      PAPERCLIP_DATABASE_LISTEN_URL: "postgres://u:p@127.0.0.1:5432/paperclip", RUN_LOG_S3_BUCKET: "chaos-b",
      RUN_LOG_S3_ENDPOINT: "http://127.0.0.1:9000", RUN_LOG_S3_REGION: "us-east-1", RUN_LOG_S3_PREFIX: "chaos/w1/run-logs" });
    expect(Buffer.from(first.PAPERCLIP_SECRETS_MASTER_KEY!, "base64")).toHaveLength(32);
    expect((await readFile(keyFile, "utf8")).trim()).toBe(first.PAPERCLIP_SECRETS_MASTER_KEY);
    const second = await ephemeralServerEnvironment({ configPath, temporaryRoot: root, extraEnvironment: storage });
    expect(second.PAPERCLIP_SECRETS_MASTER_KEY).toBe(first.PAPERCLIP_SECRETS_MASTER_KEY);
  });

  it("refuses a key file outside the wave's temporary root and a wave without object storage", async () => {
    const outside = await fixture(() => path.join(os.tmpdir(), "elsewhere", "master.key"));
    await expect(ephemeralServerEnvironment({ configPath: outside.configPath, temporaryRoot: outside.root, extraEnvironment: storage }))
      .rejects.toThrow("escapes its temporary root");
    const local = await fixture();
    await expect(ephemeralServerEnvironment({ configPath: local.configPath, temporaryRoot: local.root, extraEnvironment: {} }))
      .rejects.toThrow("--storage s3");
  });
});
