import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

// A Core-dialed route (provider ingress) treats every socket drop it did not
// cause as a transport loss: it redials, and the endpoint answers 404 once the
// Runner process is gone. This route keeps that shape, so a drop it was not
// told to expect shows up as a redial into a 404.
function coreDialedRoute() {
  const events: string[] = [];
  let authority: DurablePrpControlPlane | null = null;
  let quiesced = false;
  let released = false;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  void failure.catch(() => undefined);
  const server = createServer();
  server.on("upgrade", (request, socket: Socket, head) => {
    if (!authority) { socket.destroy(); return; }
    events.push("connected");
    socket.once("close", () => {
      if (quiesced || released) return;
      events.push("redial: 404");
      rejectFailure(new Error("runner_ingress_unavailable: Runner ingress connection failed."));
    });
    authority.handleUpgrade(request, socket, "/runner", head);
  });
  return {
    events,
    async listen() {
      await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing route listener");
      return address.port;
    },
    registration(port: number) {
      return async (next: DurablePrpControlPlane) => {
        authority = next;
        return {
          connectUrl: `ws://127.0.0.1:${port}/runner`,
          failure,
          quiesce: () => {
            const suspend = next.store.state.commands.findLast(command => command.type === "runner.suspend");
            events.push(`quiesce after runner.suspend ${suspend?.status ?? "missing"}`);
            quiesced = true;
          },
          release: () => {
            events.push("release");
            released = true;
            if (authority === next) authority = null;
          },
        };
      };
    },
    async close() {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    },
  };
}

it.each([
  { title: "", stateReadDelayMs: 0 },
  // A remote durable-state read can outlast the Runner: it exits as soon as
  // Core acknowledges its suspend result, while the barrier is still reading.
  { title: " while the barrier is still reading its durable state", stateReadDelayMs: 1_500 },
])("quiesces a Core-dialed route once the Runner commits its suspend$title, so its exit is not a transport loss", async ({ stateReadDelayMs }) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-suspend-route-"));
  const route = coreDialedRoute();
  const port = await route.listen();
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    controlPlaneRegistration: route.registration(port),
    ...(stateReadDelayMs > 0 ? {
      readRunnerState: async () => {
        await new Promise(resolveRead => setTimeout(resolveRead, stateReadDelayMs));
        return JSON.parse(await readFile(join(stateDirectory, "runner", "runner-state.json"), "utf8")) as Record<string, unknown>;
      },
    } : {}),
  });
  bundle.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", { cwd: stateDirectory, dynamicTools: [] });
    // Before the suspend is committed, a drop is still an ordinary loss.
    expect(route.events).toEqual(["connected"]);

    await expect(bundle.transport.close("native session execution complete")).resolves.toBeUndefined();

    expect(route.events).toEqual(["connected", "quiesce after runner.suspend completed", "release"]);
    const runnerState = JSON.parse(await readFile(join(stateDirectory, "runner", "runner-state.json"), "utf8")) as Record<string, unknown>;
    expect(runnerState.lifecycle).toBe("suspended");
    expect(bundle.evidence().runnerExited).toBe(true);
  } finally {
    await bundle.transport.close().catch(() => undefined);
    await route.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);
