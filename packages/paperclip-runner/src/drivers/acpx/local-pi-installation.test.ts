import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveLocalPiConfiguration } from "./local-pi-installation.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("resolves a host PATH installation and normal profile without requiring credentials", async () => {
  root = await mkdtemp(join(tmpdir(), "paperclip-local-pi-"));
  const home = join(root, "home");
  const profile = join(home, ".pi", "agent");
  const bin = join(home, "bin");
  const fallback = join(root, "fallback");
  await Promise.all([mkdir(profile, { recursive: true }), mkdir(bin, { recursive: true }), mkdir(fallback)]);
  const executable = join(fallback, "pi-real");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
  await symlink(executable, join(bin, "pi"));
  const path = [".", "", bin, fallback].join(delimiter);
  const config = { home, path,
    companyId: "00000000-0000-4000-8000-000000000001", agentId: "00000000-0000-4000-8000-000000000002" };
  expect(await resolveLocalPiConfiguration(undefined)).toBeUndefined();
  const selected = await resolveLocalPiConfiguration(JSON.stringify(config));
  expect(selected).toMatchObject({
    executable,
    environment: { HOME: home, PATH: [bin, fallback].join(delimiter), PI_CODING_AGENT_DIR: profile },
  });
  expect((await resolveLocalPiConfiguration(JSON.stringify({ ...config, profile: home })))?.identity).not.toBe(selected?.identity);
  await expect(resolveLocalPiConfiguration(JSON.stringify({ ...config, path: "." }))).rejects.toThrow("not found");
});
