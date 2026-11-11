import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
const input = JSON.parse(process.argv[2]);
const { createRunnerdCodexTransport } = await import(
  input.sdk + "/live/runnerd-codex-transport.js"
);
const seen = [];
const model = createServer(async (req, res) => {
  const parts = [];
  for await (const p of req) parts.push(p);
  if (req.url != "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
  const context = JSON.stringify(body.messages);
  seen.push(context);
  const content =
    input.phase === "resume"
      ? context.includes("retained-context-token")
        ? "cold-resume-useful-result"
        : "MISSING_RETAINED_CONTEXT"
      : "retained-context-token";
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [
    [{ role: "assistant", content }, null],
    [{}, "stop"],
  ])
    res.write(
      "data: " +
        JSON.stringify({
          id: "local-native-cold",
          object: "chat.completion.chunk",
          created: 1,
          model: "qualification",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n",
    );
  res.end("data: [DONE]\n\n");
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const root = input.artifactRoot,
  a = input.manifest.payload.artifacts;
await mkdir(input.workspace, { recursive: true });
const { transport } = createRunnerdCodexTransport({
  provider: "opencode",
  runnerBinary: "/qualified-runnerd",
  stateDirectory: input.state,
  sourceCodexHome: "",
  providerNodeCommand: root + "/" + a.nodeCommand.path,
  providerNodeCommandSha256: a.nodeCommand.sha256,
  opencodeCommand: root + "/" + a.opencodeExecutable.path,
  opencodeCommandSha256: a.opencodeExecutable.sha256,
  opencodeProxyPath: root + "/" + a.opencodeProxy.path,
  opencodeProxySha256: a.opencodeProxy.sha256,
  opencodeRuntimeDirectory: input.runtime,
  prpIdentity: input.identity,
  lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60000 },
  ...(input.thread
    ? {
        resumeProviderSession: {
          driverSessionId: input.thread.id,
          providerSessionId: input.thread.sessionId,
        },
      }
    : {}),
  environment: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: input.home ?? "/root",
    PAPERCLIP_AI_PROVIDER_URL:
      "http://127.0.0.1:" + model.address().port + "/v1",
    PAPERCLIP_AI_PROVIDER_KEY: "local-fixture-only",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  },
});
const text = [];
let timer;
try {
  const opened = await transport.request(
    input.thread ? "thread/read" : "thread/start",
    input.thread
      ? {}
      : {
          cwd: input.workspace,
          model: "paperclip/qualification",
          dynamicTools: [],
          completionContract: {
            revision: "cold-closure-v1",
            criterionIds: ["useful-output"],
          },
        },
  );
  if (input.thread && opened.thread.sessionId !== input.thread.sessionId)
    throw Error("provider session changed");
  if (input.phase !== "init") {
    const completed = (async () => {
      for await (const n of transport.notifications()) {
        if (n.method === "item/agentMessage/delta")
          text.push(n.params.delta ?? "");
        if (n.method === "turn/completed") return;
        if (n.method === "turn/failed") throw Error("provider turn failed");
      }
      throw Error("notifications ended");
    })();
    await transport.request("turn/start", {
      input: [
        {
          type: "text",
          text:
            input.phase === "resume"
              ? "Return the earlier retained token as a useful cold-resume result."
              : "Remember retained-context-token for the next turn.",
        },
      ],
    });
    await Promise.race([
      completed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("native cold qualification deadline")),
          45000,
        );
      }),
    ]);
    if (seen.length !== 1)
      throw Error("expected exactly one synthetic model request");
    if (
      input.phase === "resume" &&
      !text.join("").includes("cold-resume-useful-result")
    )
      throw Error("retained context not delivered");
  }
  await transport.close();
  console.log(
    JSON.stringify({
      phase: input.phase,
      status: "passed",
      thread: opened.thread,
      text: text.join(""),
      modelRequests: seen.length,
      lifecycle: JSON.parse(
        await readFile(input.state + "/runner/runner-state.json", "utf8"),
      ).lifecycle,
    }),
  );
} finally {
  if (timer) clearTimeout(timer);
  await transport.close().catch(() => {});
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
}
