import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

it("starts one provider after delayed bootstrap admission and retains it for a second turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-delayed-welcome-"));
  const calls = join(root, "provider-calls.log");
  let admissionDelayed = false;
  let admissionTimer: ReturnType<typeof setTimeout> | undefined;
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "provider.json"), "--call-log", calls, "--record-process-start", "--durable-turn-ids"],
    stateDirectory: join(root, "state"),
    controlPlaneRegistration: async authority => {
      const attach = authority.attachWireConnection.bind(authority);
      vi.spyOn(authority, "attachWireConnection").mockImplementation(wire => attach({
        sendJson: value => wire.sendJson(value),
        close: code => wire.close(code),
        onClose: listener => wire.onClose(listener),
        onJson: listener => wire.onJson(value => {
          if (!admissionDelayed && (value as { kind?: string }).kind === "auth_response") {
            admissionDelayed = true;
            admissionTimer = setTimeout(() => listener(value), 3_000);
          } else listener(value);
        }),
      }));
      await authority.start();
      return { connectUrl: authority.connectUrl, release: () => authority.stop() };
    },
  });
  const terminalTurns: unknown[] = [];
  try {
    const opened = await bundle.transport.request("thread/start", { cwd: root, dynamicTools: [] });
    expect(admissionDelayed).toBe(true);
    for (const text of ["Complete the first turn.", "Continue the same session."]) {
      await bundle.transport.request("turn/start", { input: [{ type: "text", text }] });
      for await (const event of bundle.transport.notifications()) {
        if (event.method === "turn/completed") {
          expect(event.params).toMatchObject({ threadId: opened.thread.id });
          terminalTurns.push(event.params);
          break;
        }
      }
    }
    await bundle.transport.close();
    const methods = (await readFile(calls, "utf8")).trim().split("\n");
    expect(methods.filter(method => method === "process-start")).toHaveLength(1);
    expect(methods.filter(method => method === "thread/start")).toHaveLength(1);
    expect(methods.filter(method => method === "turn/start")).toHaveLength(2);
    expect(terminalTurns).toHaveLength(2);
    const runner = JSON.parse(await readFile(join(root, "state/runner/runner-state.json"), "utf8"));
    expect(runner.lifecycle).toBe("suspended");
    expect(runner.outbox).toEqual([]);
  } finally {
    if (admissionTimer) clearTimeout(admissionTimer);
    await bundle.transport.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
