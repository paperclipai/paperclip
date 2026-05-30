/**
 * @paperclipai/adapter-shared — shared building blocks for Paperclip
 * adapter packages (claude_local, gemini_local, codex_local,
 * opencode_local). Currently focuses on the plugin-tools MCP bridge.
 *
 * @see KSI-664 — design decision B.1.a
 */

export {
  buildPluginToolsMcpServer,
  materializeClaudeMcpConfigFile,
  mergeGeminiSettingsMcpServer,
  mergeCodexConfigMcpServers,
  mergeOpencodeConfigMcpServers,
  resolveBridgeScriptPath,
  type BuildPluginToolsMcpServerInput,
  type PluginToolsMcpRunContext,
  type PluginToolsMcpServerSpec,
} from "./plugin-tools-mcp.js";
