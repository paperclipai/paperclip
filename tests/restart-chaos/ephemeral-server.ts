import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { databaseUrlFromConfig } from "./time-faults.js";

export async function ephemeralServerEnvironment(input: { configPath: string; temporaryRoot: string; extraEnvironment: Record<string, string> }): Promise<Record<string, string>> {
  const { configPath, temporaryRoot, extraEnvironment } = input;
  if (extraEnvironment.PAPERCLIP_STORAGE_PROVIDER !== "s3") throw new Error("--ephemeral-server needs the wave's object store (--storage s3)");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { secrets?: { localEncrypted?: { keyFilePath?: string } } };
  const keyFile = String(config.secrets?.localEncrypted?.keyFilePath ?? path.join(path.dirname(configPath), "secrets", "master.key"));
  if (!path.resolve(keyFile).startsWith(`${path.resolve(temporaryRoot)}${path.sep}`)) throw new Error("--ephemeral-server: the wave's master key file escapes its temporary root");
  let masterKey = await readFile(keyFile, "utf8").then(value => value.trim(), () => "");
  if (!masterKey) {
    masterKey = randomBytes(32).toString("base64");
    await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    await writeFile(keyFile, masterKey, { mode: 0o600, flag: "wx" });
  }
  return {
    PAPERCLIP_EPHEMERAL_SERVER: "true", PAPERCLIP_DURABLE_AGENT_FILES: "true", PAPERCLIP_SHARED_UI_ASSETS: "true",
    PAPERCLIP_DATABASE_LISTEN_URL: databaseUrlFromConfig(configPath), PAPERCLIP_SECRETS_MASTER_KEY: masterKey,
    RUN_LOG_S3_BUCKET: extraEnvironment.PAPERCLIP_STORAGE_S3_BUCKET!, RUN_LOG_S3_ENDPOINT: extraEnvironment.PAPERCLIP_STORAGE_S3_ENDPOINT!,
    RUN_LOG_S3_REGION: extraEnvironment.PAPERCLIP_STORAGE_S3_REGION!, RUN_LOG_S3_FORCE_PATH_STYLE: "true",
    RUN_LOG_S3_PREFIX: `${extraEnvironment.PAPERCLIP_STORAGE_S3_PREFIX ?? ""}run-logs`,
  };
}
