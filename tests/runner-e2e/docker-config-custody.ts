/** Test-host-only custody of the normal CLI doctor's required persisted DSN.
 * Return original file bytes with only the independently verified field value
 * removed for scanning. No file, credential root or other field is excluded. */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { readDockerDatabaseReceipt, type DockerRun } from "./docker-postgres.js";

export interface DockerConfigCustody {
  temporaryRoot: string;
  configPath: string;
  receiptPath: string;
  run?: DockerRun;
}
export function assertDockerCustodyMetadata(value: { uid: number; mode: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }, directory: boolean, uid = process.getuid?.()) {
  if (value.uid !== uid || value.isSymbolicLink() || (directory ? !value.isDirectory() || (value.mode & 0o777) !== 0o700 : !value.isFile() || (value.mode & 0o777) !== 0o600)) throw new Error("Unsafe owned Docker config custody metadata");
}
export async function readDockerConfigForSecretScan(home: string, input: DockerConfigCustody): Promise<string> {
  const { temporaryRoot: root, configPath } = input;
  const expectedHome = path.join(root, "paperclip-home"), relative = path.relative(expectedHome, configPath);
  if (home !== expectedHome || !/^instances\/runner-e2e-[A-Za-z0-9-]+\/config\.json$/.test(relative)) throw new Error("Docker config custody requires the exact owned instance path");
  for (const dir of [root, expectedHome, path.join(expectedHome, "instances"), path.dirname(configPath)]) {
    assertDockerCustodyMetadata(await lstat(dir), true);
    if (await realpath(dir) !== dir) throw new Error("Docker config custody path is not canonical");
  }
  const stat = await lstat(configPath); assertDockerCustodyMetadata(stat, false);
  if (stat.size > 1024 * 1024 || await realpath(configPath) !== configPath) throw new Error("Unsafe Docker config custody file");
  const receipt = await readDockerDatabaseReceipt(input.receiptPath, root, input.run);
  const text = await readFile(configPath, "utf8");
  let config: { database?: { mode?: string; connectionString?: string } };
  try { config = JSON.parse(text); } catch { throw new Error("Owned Docker config custody requires valid JSON; bytes withheld"); }
  if (config.database?.mode !== "postgres" || config.database.connectionString !== receipt.connectionString) throw new Error("Persisted Docker config differs from its owned database receipt");
  const literal = JSON.stringify(receipt.connectionString);
  const at = text.indexOf(literal);
  // A second encoded occurrence, duplicate JSON key or copied field cannot be
  // hidden by parsing/re-serialization. All remaining raw bytes are scanned.
  if (at < 0 || text.indexOf(literal, at + literal.length) !== -1 || !/"connectionString"\s*:\s*$/.test(text.slice(0, at))) throw new Error("Docker DSN custody is not one exact database field");
  const rest = text.slice(0, at) + '""' + text.slice(at + literal.length);
  const password = new URL(receipt.connectionString!).password;
  if (rest.includes(password) || rest.includes(receipt.connectionString!)) throw new Error("Docker credential occurs outside intended custody field");
  const after = await lstat(configPath);
  assertDockerCustodyMetadata(after, false);
  if (after.ino !== stat.ino || after.dev !== stat.dev || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) throw new Error("Docker config changed during custody scan");
  return rest;
}
