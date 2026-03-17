export { execute, setSandboxProviderFactoryForTests } from "./execute.js";
export { testEnvironment } from "./test.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const parsed = parseObject(raw);
    const sandboxId = asString(parsed.sandboxId, "").trim();
    if (!sandboxId) return null;
    const cliSession = parseObject(parsed.cliSession);
    return {
      sandboxId,
      ...(Object.keys(cliSession).length > 0 ? { cliSession } : {}),
      ...(asString(parsed.agentType, "").trim() ? { agentType: asString(parsed.agentType, "").trim() } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sandboxId = asString(params.sandboxId, "").trim();
    if (!sandboxId) return null;
    const cliSession = parseObject(params.cliSession);
    return {
      sandboxId,
      ...(Object.keys(cliSession).length > 0 ? { cliSession } : {}),
      ...(asString(params.agentType, "").trim() ? { agentType: asString(params.agentType, "").trim() } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    const cliSession = parseObject(params.cliSession);
    return (
      asString(cliSession.sessionId, "").trim() ||
      asString(params.sandboxId, "").trim() ||
      null
    );
  },
};
