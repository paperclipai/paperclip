import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isIP } from "node:net";
import type { secretService } from "./secrets.js";
import type { SecretProvider } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type Vault = Pick<ReturnType<typeof secretService>, "getByName" | "create">;
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export async function createTailscalePairing(input: {
  vault: Vault; provider: SecretProvider; companyId: string; connectionId: string; deviceId: string;
  address: string; port: number; userId: string;
}) {
  if (!isIP(input.address) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw unprocessable("Choose a valid Tailscale machine and SSH port.");
  const fingerprint = createHash("sha256").update(input.connectionId + ":" + input.deviceId).digest("hex").slice(0, 16);
  const name = `Tailscale SSH ${fingerprint}`;
  let secret = await input.vault.getByName(input.companyId, name);
  if (!secret) {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-ts-pairing-"));
    try {
      const file = join(dir, "key");
      await promisify(execFile)("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "paperclip-tailscale", "-f", file], { timeout: 5000, maxBuffer: 4096 });
      const [privateKey, publicKey] = await Promise.all([readFile(file, "utf8"), readFile(file + ".pub", "utf8")]);
      secret = await input.vault.create(input.companyId, { name, provider: input.provider, value: privateKey,
        providerMetadata: { sshPublicKey: publicKey.trim() } }, { userId: input.userId });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  const publicKey = secret.providerMetadata?.sshPublicKey;
  if (typeof publicKey !== "string" || !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(publicKey)) throw unprocessable("This pairing key is unavailable. Choose a saved SSH key or create a new connection.");
  const host = input.port === 22 ? input.address : `[${input.address}]:${input.port}`;
  const command = [
    "(", "set -eu", "umask 077", "mkdir -p \"$HOME/.ssh\"", "chmod 700 \"$HOME/.ssh\"",
    `if ! grep -Fqx -- ${quote(publicKey)} "$HOME/.ssh/authorized_keys" 2>/dev/null; then`,
    `  printf '%s\\n' ${quote(publicKey)} >> "$HOME/.ssh/authorized_keys"`, "fi",
    "chmod 600 \"$HOME/.ssh/authorized_keys\"",
    "printf '\\nPaperclip username: '; id -un",
    "printf '\\nPaperclip workspace: %s/Paperclip\\n' \"$HOME\"",
    "printf '\\nKnown hosts:\\n'",
    `printf '%s ' ${quote(host)}`, "cat /etc/ssh/ssh_host_ed25519_key.pub", ")",
  ].join("\n");
  return { privateKeySecretId: secret.id, publicKey, command };
}
