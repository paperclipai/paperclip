import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { claimVolumeFreeControllerState, volumeFreeControllerStateOwned } from "./volume-free-controller-state.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function base() {
  const root = await mkdtemp(join(tmpdir(), "volume-free-owner-"));
  roots.push(root);
  return join(root, "durable-sessions");
}

it("claims only an empty state directory and releases the claim outside volume-free mode", async () => {
  const dir = await base();
  expect(await claimVolumeFreeControllerState(true, dir)).toBe("claimed");
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect(JSON.parse(await readFile(join(dir, ".volume-free-owner.json"), "utf8")).schema).toBe("paperclip.volume-free-controller-state.v1");
  await mkdir(join(dir, "a".repeat(64)));
  expect(await claimVolumeFreeControllerState(true, dir)).toBe("owned");
  expect(await claimVolumeFreeControllerState(false, dir)).toBe("released");
  expect(await claimVolumeFreeControllerState(false, dir)).toBe("absent");
  expect(await claimVolumeFreeControllerState(true, dir)).toBe("unclaimed");
  expect(await volumeFreeControllerStateOwned(dir)).toBe(false);
});

it("ignores a marker with the wrong schema", async () => {
  const dir = await base();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".volume-free-owner.json"), JSON.stringify({ schema: "other" }));
  expect(await volumeFreeControllerStateOwned(dir)).toBe(false);
});

it.each(["directory", "fifo"] as const)("never blocks or throws on a %s at the marker path", async kind => {
  const dir = await base();
  await mkdir(dir, { recursive: true });
  const marker = join(dir, ".volume-free-owner.json");
  if (kind === "directory") await mkdir(marker);
  else execFileSync("mkfifo", [marker]);
  expect(await volumeFreeControllerStateOwned(dir)).toBe(false);
  expect(await claimVolumeFreeControllerState(true, dir)).toBe("unclaimed");
  expect(await claimVolumeFreeControllerState(false, dir)).toBe("absent");
  expect((await stat(marker)).isFile()).toBe(false);
});
