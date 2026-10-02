import { mkdtemp, readFile, rm, stat, writeFile, chmod, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePubsubIdentity, loadPubsubIdentity } from "../services/pubsub-identity.js";
import { signPubsubEnvelope, verifyPubsubEnvelope } from "../services/pubsub-crypto.js";
import { randomUUID } from "node:crypto";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function identityPath() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-pubsub-identity-"));
  directories.push(directory);
  return path.join(directory, "identity.json");
}

describe("PubSub instance signing identity", () => {
  it("concurrent initializers retain one private mode-0600 identity usable after reload", async () => {
    const file = await identityPath();
    const identities = await Promise.all(Array.from({ length: 12 }, () => ensurePubsubIdentity(file)));
    for (const identity of identities) expect(identity).toEqual(identities[0]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const persistedBefore = await readFile(file, "utf8");
    const loaded = await loadPubsubIdentity(file);
    const signed = signPubsubEnvelope({
      version: 1, id: randomUUID(), from_instance: loaded.instanceId, from_company: randomUUID(),
      from_agent: null, from_role: "board", to_instance: randomUUID(), to_company: randomUUID(),
      to_topic: "fleet.chat.restart", payload: { retained: true }, timestamp: new Date().toISOString(), nonce: randomUUID(),
    }, loaded.privateKey);
    const restarted = await ensurePubsubIdentity(file);
    expect(verifyPubsubEnvelope(signed, restarted.publicKey).from_instance).toBe(restarted.instanceId);
    expect(await readFile(file, "utf8")).toBe(persistedBefore);
    const published = JSON.parse(await readFile(file.replace(/\.json$/, "-public.json"), "utf8"));
    expect(published.instanceId).toBe(restarted.instanceId);
    expect(published.publicKey).toBe(restarted.publicKey);
    expect(JSON.stringify(published)).not.toContain("PRIVATE KEY");
  });

  it("never replaces a malformed persisted identity", async () => {
    const file = await identityPath();
    await writeFile(file, "broken-key", { mode: 0o600 });
    await expect(ensurePubsubIdentity(file)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("broken-key");
  });

  it("refuses unsafe key permissions and symlink targets", async () => {
    const file = await identityPath();
    await ensurePubsubIdentity(file);
    await chmod(file, 0o644);
    await expect(ensurePubsubIdentity(file)).rejects.toThrow("0600");
    await chmod(file, 0o600);
    const linked = path.join(path.dirname(file), "linked.json");
    await symlink(file, linked);
    await expect(ensurePubsubIdentity(linked)).rejects.toMatchObject({ code: "ELOOP" });
  });
});
