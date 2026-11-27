import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bindLocalPiProfile, resolveLocalPiConfiguration, verifyLocalPiInstallation } from "./local-pi-installation.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("requires an explicit closure digest and reuses only the selected profile's private auth file", async () => {
  root = await mkdtemp(join(tmpdir(), "paperclip-local-pi-"));
  const assets = join(root, "assets");
  const profile = join(root, "profile");
  const session = join(root, "session");
  const source = join(profile, "auth.json");
  await Promise.all([mkdir(assets), mkdir(profile), mkdir(session)]);
  await writeFile(source, "{}", { mode: 0o600 });
  await writeFile(join(assets, "native-closure.json"), JSON.stringify({ entries: [
    { path: "node/bin/node", sha256: "0".repeat(64), size: 1, executable: true },
  ] }));
  const config = { assets, profile, sha256: "a".repeat(64),
    companyId: "00000000-0000-4000-8000-000000000001", agentId: "00000000-0000-4000-8000-000000000002" };
  const resolve = (value: typeof config) => resolveLocalPiConfiguration(JSON.stringify(value));
  expect(await resolveLocalPiConfiguration(undefined)).toBeUndefined();
  await expect(resolve({ ...config, profile: assets })).rejects.toThrow("Invalid operator configuration");
  await expect(resolve({ ...config, sha256: "../invalid" })).rejects.toThrow("Invalid operator configuration");
  const resolved = (await resolve(config))!;
  expect((await resolve({ ...config, sha256: "b".repeat(64) }))?.identity).not.toBe(resolved.identity);
  await expect(verifyLocalPiInstallation(resolved)).rejects.toThrow("digest mismatch");
  await bindLocalPiProfile(profile, session);
  await bindLocalPiProfile(profile, session);
  expect(await readlink(join(session, "auth.json"))).toBe(source);
  expect((await lstat(source)).isSymbolicLink()).toBe(false);
});
