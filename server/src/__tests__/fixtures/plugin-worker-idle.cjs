// Use the real SDK so host tests cross a process and the NDJSON boundary.
void Promise.all([
  import("../../../../packages/plugins/sdk/src/define-plugin.ts"),
  import("../../../../packages/plugins/sdk/src/worker-rpc-host.ts"),
]).then(([{ definePlugin }, { startWorkerRpcHost }]) => {
  let context;
  startWorkerRpcHost({ plugin: definePlugin({
    async setup(ctx) { context = ctx; },
    async onIdleDrain() { return "none"; },
    async onHealth() {
      if (process.env.IDLE_TEST_WRITE === "1") {
        await context.state.set({ scopeKind: "instance", stateKey: "fixture" }, { value: 1 });
      }
      return { status: "ok" };
    },
    async onEnvironmentProbe(params) {
      if (params.config.crash) process.exit(1);
      await new Promise((resolve) => setTimeout(resolve, params.config.delayMs));
      return { ok: true, summary: "fixture complete" };
    },
  }) });
});
