import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFile, stat } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { openSsh } from "./transport.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); mocks.spawn.mockReset(); });
it("keeps sensitive commands in a private file, escapes percent expansion, and removes it", async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  mocks.spawn.mockReturnValue(child);
  const command = "new --registry-auth='test:tok%en'";
  const opened = await openSsh({ sshPrivateKey: "test-key", strictHostKeyChecking: "accept-new", timeoutMs: 1000 }, "exe.dev", command, true);
  cleanups.push(opened.cleanup);
  const args = mocks.spawn.mock.calls[0][1] as string[];
  expect(args.join(" ")).not.toContain("tok%en");
  const file = args[args.indexOf("-F") + 1];
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readFile(file, "utf8")).toBe("RemoteCommand new --registry-auth='test:tok%%en'\n");
  await opened.cleanup();
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects newline injection into a sensitive SSH config before spawning", async () => {
  await expect(openSsh({ strictHostKeyChecking: "accept-new", timeoutMs: 1000 }, "exe.dev", "new\nLocalCommand unsafe", true)).rejects.toThrow("single-line");
  expect(mocks.spawn).not.toHaveBeenCalled();
});
