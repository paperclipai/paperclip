import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Leave headroom for other environment entries and shell/provider wrappers.
// This is a transport threshold, never a limit on the wake's contents.
export const WAKE_PAYLOAD_INLINE_MAX_BYTES = 64 * 1024;
const PAYLOAD_KEY = "PAPERCLIP_WAKE_PAYLOAD_JSON";
const PATH_KEY = "PAPERCLIP_WAKE_PAYLOAD_PATH";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export interface WakePayloadDelivery {
  env: Record<string, string>;
  filePath: string | null;
  cleanup(): Promise<void>;
}

/** Execute a bounded shell command on the actual agent host, with no wake env. */
export type WakePayloadRemoteCommand = (script: string) => Promise<string>;

/**
 * The caller owns this delivery until the process/turn settles. Never accept a
 * path supplied by a payload or config, overwrite a shared scratch file, or
 * change the caller's env (which may be reused for probes/retries).
 */
export async function prepareWakePayloadEnv(
  input: Record<string, string>,
  remoteCommand?: WakePayloadRemoteCommand,
): Promise<WakePayloadDelivery> {
  const payload = input[PAYLOAD_KEY];
  const env = { ...input };
  // Inline contents take precedence over a stale file reference.
  if (payload !== undefined) delete env[PATH_KEY];
  // SSH/provider launchers can quote the environment inside another shell
  // command. Apostrophes expand at each layer, even for a small raw JSON value.
  const transportBytes = payload
    ? Buffer.byteLength(remoteCommand ? quote(quote(payload)) : payload, "utf8")
    : 0;
  if (!payload || transportBytes <= WAKE_PAYLOAD_INLINE_MAX_BYTES) {
    return { env, filePath: null, cleanup: async () => {} };
  }

  let directory: string;
  let filePath: string;
  let cleanup: () => Promise<void>;
  if (remoteCommand) {
    directory = `/tmp/paperclip-wake-${randomUUID()}`;
    filePath = `${directory}/payload.json`;
    // Do not remove a pre-existing path when exclusive creation fails.
    try {
      await remoteCommand(`umask 077 && mkdir -m 700 ${quote(directory)}`);
    } catch {
      throw new Error("Could not create the private wake payload directory.");
    }
    cleanup = async () => { await remoteCommand(`rm -rf -- ${quote(directory)}`); };
    try {
      await remoteCommand(`umask 077 && set -C && : > ${quote(filePath)}`);
      const encoded = Buffer.from(payload, "utf8").toString("base64");
      // Some providers turn stdin into a shell argument. Bound the transport
      // ourselves instead of trusting that stdin remains a stream end to end.
      for (let offset = 0; offset < encoded.length; offset += 16 * 1024) {
        await remoteCommand(
          `printf '%s' ${quote(encoded.slice(offset, offset + 16 * 1024))} | base64 -d >> ${quote(filePath)}`,
        );
      }
      await remoteCommand(`test "$(wc -c < ${quote(filePath)})" -eq ${Buffer.byteLength(payload, "utf8")}`);
    } catch {
      await cleanup().catch(() => {});
      // Provider errors can include the command (and thus a payload chunk).
      throw new Error("Could not deliver the complete wake payload file.");
    }
  } else {
    directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "paperclip-wake-"));
    filePath = path.join(directory, "payload.json");
    cleanup = () => fs.rm(directory, { recursive: true, force: true });
    try {
      await fs.chmod(directory, 0o700);
      await fs.writeFile(filePath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      await cleanup().catch(() => {});
      throw new Error("Could not deliver the complete wake payload file.");
    }
  }
  delete env[PAYLOAD_KEY];
  env[PATH_KEY] = filePath;
  return { env, filePath, cleanup };
}

export function renderWakePayloadFileNote(env: Record<string, string>): string {
  const filePath = env[PATH_KEY];
  if (!filePath) return "";
  return `The complete structured wake payload for this turn is in ${JSON.stringify(filePath)}. Read this JSON file if you need the structured wake context. This turn's path takes precedence over any older wake environment retained by a resumed session. The file is removed when this turn ends.`;
}
