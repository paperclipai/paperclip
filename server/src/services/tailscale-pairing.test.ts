import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { createTailscalePairing } from "./tailscale-pairing.js";

it("creates a real SSH key in the vault and returns only an id and public pairing command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-pairing-test-"));
  let saved: any;
  let count = 0;
  const vault = {
    getByName: vi.fn(async () => saved ?? null),
    create: vi.fn(async (_company: string, input: any) => { saved = { ...input, id: `fixture-private-key-ref-${++count}` }; return saved; }),
  };
  const input = { vault: vault as any, provider: "local_encrypted" as const, companyId: "fixture-company", connectionId: "fixture-connection", deviceId: "fixture-device", address: "100.64.0.1", port: 2222, userId: "fixture-user" };
  try {
    const result = await createTailscalePairing(input);
    expect(saved.value).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(result.privateKeySecretId).toBe("fixture-private-key-ref-1");
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(result.command).toContain("[100.64.0.1]:2222");
    expect(result.command).toContain('>> "$HOME/.ssh/authorized_keys"');
    const file = join(dir, "key");
    await writeFile(file, saved.value, { mode: 0o600 });
    const publicKey = (await promisify(execFile)("ssh-keygen", ["-y", "-f", file], { timeout: 5000 })).stdout.trim();
    expect(result.publicKey).toBe(publicKey);
    const next = await createTailscalePairing(input);
    expect(next.privateKeySecretId).not.toBe(result.privateKeySecretId);
    expect(next.publicKey).not.toBe(result.publicKey);
    expect(vault.create).toHaveBeenCalledTimes(2);
    expect(vault.getByName).not.toHaveBeenCalled();
    await expect(createTailscalePairing({ ...input, address: "host; command" })).rejects.toThrow("valid Tailscale machine");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("does not install a public key substituted into mutable vault metadata", async () => {
  let memberKey: any;
  const input = { provider: "local_encrypted" as const, companyId: "fixture-company", connectionId: "fixture-connection",
    deviceId: "fixture-device", address: "100.64.0.1", port: 22, userId: "fixture-user" };
  const member = await createTailscalePairing({ ...input, vault: {
    getByName: vi.fn(async () => null),
    create: vi.fn(async (_company: string, secret: any) => { memberKey = secret; return { ...secret, id: "member-owned-key" }; }),
  } as any });
  const substituted = member.publicKey;
  const vault = {
    getByName: vi.fn(async () => ({ ...memberKey, id: "substituted-key", providerMetadata: { sshPublicKey: substituted } })),
    create: vi.fn(async (_company: string, input: any) => ({ ...input, id: "new-pairing-key", providerMetadata: { sshPublicKey: substituted } })),
  };
  const result = await createTailscalePairing({ ...input, vault: vault as any });
  expect(result.privateKeySecretId).toBe("new-pairing-key");
  expect(result.publicKey).not.toBe(substituted);
  expect(result.command).not.toContain(substituted);
  expect(vault.create).toHaveBeenCalledOnce();
  expect(vault.getByName).not.toHaveBeenCalled();
});

it.each(["", "ssh-ed25519 existing-key", "ssh-ed25519 existing-key\n"])("preserves existing authorized_keys and appends a separate key (existing=%j)", async existing => {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-pairing-command-test-"));
  const vault = {
    getByName: vi.fn(async () => null),
    create: vi.fn(async (_company: string, input: any) => ({ ...input, id: "new-pairing-key" })),
  };
  try {
    const result = await createTailscalePairing({ vault: vault as any, provider: "local_encrypted", companyId: "fixture-company", connectionId: "fixture-connection",
      deviceId: "fixture-device", address: "100.64.0.1", port: 22, userId: "fixture-user" });
    const hostKey = join(dir, "host-key.pub");
    await writeFile(hostKey, "ssh-ed25519 fixture-host-key\n");
    await mkdir(join(dir, ".ssh"));
    const authorizedKeys = join(dir, ".ssh", "authorized_keys");
    await writeFile(authorizedKeys, existing);
    const command = result.command.replace("/etc/ssh/ssh_host_ed25519_key.pub", hostKey);
    await promisify(execFile)("/bin/sh", ["-c", command], { env: { ...process.env, HOME: dir }, timeout: 5000 });
    const expected = existing + (existing && !existing.endsWith("\n") ? "\n" : "") + result.publicKey + "\n";
    expect(await readFile(authorizedKeys, "utf8")).toBe(expected);
    await promisify(execFile)("/bin/sh", ["-c", command], { env: { ...process.env, HOME: dir }, timeout: 5000 });
    expect(await readFile(authorizedKeys, "utf8")).toBe(expected);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
