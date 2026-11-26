void Promise.all([
  import("../../../../packages/plugins/sdk/src/define-plugin.ts"),
  import("../../../../packages/plugins/sdk/src/worker-rpc-host.ts"),
]).then(([{ definePlugin }, { startWorkerRpcHost }]) => {
  startWorkerRpcHost({ plugin: definePlugin({
    async setup(ctx) {
      ctx.jobs.register("hourly", async job => {
        await ctx.state.set({ scopeKind: "instance", stateKey: job.runId }, { runId: job.runId, scheduledAt: job.scheduledAt });
      });
    },
    async onIdleDrain() { return "none"; },
  }) });
});
