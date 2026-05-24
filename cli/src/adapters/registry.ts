import type { CLIAdapterModule } from "@paperclipai/adapter-utils";
import { processCLIAdapter } from "./process/index.js";
import { httpCLIAdapter } from "./http/index.js";

type CLIAdapterLoader = () => Promise<CLIAdapterModule>;

function createCLIAdapter(
  type: string,
  formatStdoutEvent: CLIAdapterModule["formatStdoutEvent"],
): CLIAdapterModule {
  return { type, formatStdoutEvent };
}

const adapterLoaders = new Map<string, CLIAdapterLoader>([
  [
    "acpx_local",
    async () => {
      const { printAcpxStreamEvent } = await import("@paperclipai/adapter-acpx-local/cli");
      return createCLIAdapter("acpx_local", printAcpxStreamEvent);
    },
  ],
  [
    "claude_local",
    async () => {
      const { printClaudeStreamEvent } = await import("@paperclipai/adapter-claude-local/cli");
      return createCLIAdapter("claude_local", printClaudeStreamEvent);
    },
  ],
  [
    "codex_local",
    async () => {
      const { printCodexStreamEvent } = await import("@paperclipai/adapter-codex-local/cli");
      return createCLIAdapter("codex_local", printCodexStreamEvent);
    },
  ],
  [
    "opencode_local",
    async () => {
      const { printOpenCodeStreamEvent } = await import("@paperclipai/adapter-opencode-local/cli");
      return createCLIAdapter("opencode_local", printOpenCodeStreamEvent);
    },
  ],
  [
    "pi_local",
    async () => {
      const { printPiStreamEvent } = await import("@paperclipai/adapter-pi-local/cli");
      return createCLIAdapter("pi_local", printPiStreamEvent);
    },
  ],
  [
    "cursor",
    async () => {
      const { printCursorStreamEvent } = await import("@paperclipai/adapter-cursor-local/cli");
      return createCLIAdapter("cursor", printCursorStreamEvent);
    },
  ],
  [
    "cursor_cloud",
    async () => {
      const { printCursorCloudEvent } = await import("@paperclipai/adapter-cursor-cloud/cli");
      return createCLIAdapter("cursor_cloud", printCursorCloudEvent);
    },
  ],
  [
    "gemini_local",
    async () => {
      const { printGeminiStreamEvent } = await import("@paperclipai/adapter-gemini-local/cli");
      return createCLIAdapter("gemini_local", printGeminiStreamEvent);
    },
  ],
  [
    "grok_local",
    async () => {
      const { printGrokStreamEvent } = await import("@paperclipai/adapter-grok-local/cli");
      return createCLIAdapter("grok_local", printGrokStreamEvent);
    },
  ],
  [
    "openclaw_gateway",
    async () => {
      const { printOpenClawGatewayStreamEvent } = await import("@paperclipai/adapter-openclaw-gateway/cli");
      return createCLIAdapter("openclaw_gateway", printOpenClawGatewayStreamEvent);
    },
  ],
  ["process", async () => processCLIAdapter],
  ["http", async () => httpCLIAdapter],
]);

const loadedAdapters = new Map<string, CLIAdapterModule>();

export async function getCLIAdapter(type: string): Promise<CLIAdapterModule> {
  const cached = loadedAdapters.get(type);
  if (cached) return cached;
  const loader = adapterLoaders.get(type);
  if (!loader) return processCLIAdapter;
  const adapter = await loader();
  loadedAdapters.set(type, adapter);
  return adapter;
}
