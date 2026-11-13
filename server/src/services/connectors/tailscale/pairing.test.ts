import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { createTailscalePairing } from "./pairing.js";

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
    const hostKey = join(dir, "ssh_host_ed25519_key.pub");
    await writeFile(hostKey, "ssh-ed25519 fixture-host-key\n");
    await mkdir(join(dir, ".ssh"));
    const authorizedKeys = join(dir, ".ssh", "authorized_keys");
    await writeFile(authorizedKeys, existing);
    const command = result.command.replaceAll("/etc/ssh/", `${dir}/`);
    await promisify(execFile)("/bin/sh", ["-c", command], { env: { ...process.env, HOME: dir }, timeout: 5000 });
    const expected = existing + (existing && !existing.endsWith("\n") ? "\n" : "") + result.publicKey + "\n";
    expect(await readFile(authorizedKeys, "utf8")).toBe(expected);
    await promisify(execFile)("/bin/sh", ["-c", command], { env: { ...process.env, HOME: dir }, timeout: 5000 });
    expect(await readFile(authorizedKeys, "utf8")).toBe(expected);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each(["ecdsa", "rsa", "all"] as const)("prints trusted known-hosts entries for available %s host keys", async kind => {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-pairing-host-keys-"));
  const vault = { create: vi.fn(async (_company: string, input: any) => ({ ...input, id: "new-pairing-key" })) };
  const algorithms = { ed25519: "ssh-ed25519", ecdsa: "ecdsa-sha2-nistp256", rsa: "ssh-rsa" };
  const keys: (keyof typeof algorithms)[] = kind === "all" ? ["ed25519", "ecdsa", "rsa"] : [kind];
  try {
    const result = await createTailscalePairing({ vault: vault as any, provider: "local_encrypted", companyId: "fixture-company", connectionId: "fixture-connection",
      deviceId: "fixture-device", address: "100.64.0.1", port: 2222, userId: "fixture-user" });
    const publicKeys = keys.map(key => `${algorithms[key]} fixture-${key}-host-key`);
    for (let index = 0; index < keys.length; index++) {
      await writeFile(join(dir, `ssh_host_${keys[index]}_key.pub`), publicKeys[index]! + "\n");
    }
    const { stdout } = await promisify(execFile)("/bin/sh", ["-c", result.command.replaceAll("/etc/ssh/", `${dir}/`)], { env: { ...process.env, HOME: dir }, timeout: 5000 });
    expect(stdout.split("Known hosts:\n")[1]).toBe(publicKeys.map(key => `[100.64.0.1]:2222 ${key}\n`).join(""));
    expect(await readFile(join(dir, ".ssh", "authorized_keys"), "utf8")).toBe(result.publicKey + "\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("fails before editing authorized_keys when no supported SSH host public key exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-pairing-no-host-key-"));
  const vault = { create: vi.fn(async (_company: string, input: any) => ({ ...input, id: "new-pairing-key" })) };
  try {
    const result = await createTailscalePairing({ vault: vault as any, provider: "local_encrypted", companyId: "fixture-company", connectionId: "fixture-connection",
      deviceId: "fixture-device", address: "100.64.0.1", port: 22, userId: "fixture-user" });
    await mkdir(join(dir, ".ssh"));
    const authorizedKeys = join(dir, ".ssh", "authorized_keys");
    const existing = "ssh-ed25519 fixture-existing-key";
    await writeFile(authorizedKeys, existing);
    const outcome = await promisify(execFile)("/bin/sh", ["-c", result.command.replaceAll("/etc/ssh/", `${dir}/`)], { env: { ...process.env, HOME: dir }, timeout: 5000 })
      .then(() => null, error => error);
    expect(await readFile(authorizedKeys, "utf8")).toBe(existing);
    expect(outcome).toMatchObject({ code: 1, stderr: expect.stringContaining("SSH host public key") });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
