import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";

export const type = "fork_plugin_demo_a";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    async execute(_ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "fork_plugin_demo_a: stub adapter (install via Board / adapter-plugins.json file:).",
      };
    },
    async testEnvironment(_ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
      return {
        adapterType: type,
        status: "pass",
        checks: [
          {
            code: "fork_plugin_demo_a_stub",
            level: "info",
            message: "Demo adapter — always reports pass; no external CLI.",
          },
        ],
        testedAt: new Date().toISOString(),
      };
    },
    models: [],
    agentConfigurationDoc: `# ${type}

Stub adapter for validating the **external plugin** load path only.
`,
  };
}
