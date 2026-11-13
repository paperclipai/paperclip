import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { createTailscalePairing } from "./tailscale-pairing.js";

it("creates a real SSH key in the vault and returns only an id and public pairing command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-pairing-test-"));
  let saved: any;
  const vault = {
    getByName: vi.fn(async () => saved ?? null),
    create: vi.fn(async (_company: string, input: any) => { saved = { ...input, id: "fixture-private-key-ref" }; return saved; }),
  };
  const input = { vault: vault as any, provider: "local_encrypted" as const, companyId: "fixture-company", connectionId: "fixture-connection", deviceId: "fixture-device", address: "100.64.0.1", port: 2222, userId: "fixture-user" };
  try {
    const result = await createTailscalePairing(input);
    expect(saved.value).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(result.privateKeySecretId).toBe("fixture-private-key-ref");
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(result.command).toContain("[100.64.0.1]:2222");
    expect(result.command).toContain('>> "$HOME/.ssh/authorized_keys"');
    const file = join(dir, "key");
    await writeFile(file, saved.value, { mode: 0o600 });
    const publicKey = (await promisify(execFile)("ssh-keygen", ["-y", "-f", file], { timeout: 5000 })).stdout.trim();
    expect(result.publicKey).toBe(publicKey);
    expect(await createTailscalePairing(input)).toEqual(result);
    expect(vault.create).toHaveBeenCalledOnce();
    await expect(createTailscalePairing({ ...input, address: "host; command" })).rejects.toThrow("valid Tailscale machine");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
