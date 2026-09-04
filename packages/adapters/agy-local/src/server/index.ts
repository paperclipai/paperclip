import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listAgySkills as listSkills, syncAgySkills as syncSkills } from "./skills.js";
export { listAgyModels } from "./models.js";
export { listAgyAgents as listAgents, listAgyAgents, parseAgyAgentsOutput } from "./agents.js";
export { parseAgyJsonl, isAgyUnknownSessionError } from "./parse.js";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    const obj = parseObject(raw);
    const sessionId =
      asString(obj.sessionId, "") ||
      asString(obj.conversationId, "") ||
      asString(obj.session_id, "") ||
      asString(obj.conversation_id, "");
    if (!sessionId) return null;
    const cwd = asString(obj.cwd, "");
    const workspaceId = asString(obj.workspaceId, "") || asString(obj.workspace_id, "");
    const repoUrl = asString(obj.repoUrl, "") || asString(obj.repo_url, "");
    const repoRef = asString(obj.repoRef, "") || asString(obj.repo_ref, "");
    const remoteExecution =
      typeof obj.remoteExecution === "object" && obj.remoteExecution !== null && !Array.isArray(obj.remoteExecution)
        ? { ...(obj.remoteExecution as Record<string, unknown>) }
        : null;
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(remoteExecution ? { remoteExecution } : {}),
    };
  },
  serialize(params) {
    if (!params) return null;
    const sessionId =
      asString(params.sessionId, "") ||
      asString(params.conversationId, "") ||
      asString(params.session_id, "") ||
      asString(params.conversation_id, "");
    if (!sessionId) return null;
    const cwd = asString(params.cwd, "");
    const workspaceId = asString(params.workspaceId, "") || asString(params.workspace_id, "");
    const repoUrl = asString(params.repoUrl, "") || asString(params.repo_url, "");
    const repoRef = asString(params.repoRef, "") || asString(params.repo_ref, "");
    const remoteExecution =
      typeof params.remoteExecution === "object" &&
      params.remoteExecution !== null &&
      !Array.isArray(params.remoteExecution)
        ? { ...(params.remoteExecution as Record<string, unknown>) }
        : null;
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(remoteExecution ? { remoteExecution } : {}),
    };
  },
  getDisplayId(params) {
    if (!params) return null;
    return (
      asString(params.sessionId, "") ||
      asString(params.conversationId, "") ||
      asString(params.session_id, "") ||
      asString(params.conversation_id, "") ||
      null
    );
  },
};
