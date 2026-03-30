import type { CreateConfigValues } from "../../components/AgentConfigForm";

export function buildHttpConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  ac.method = "POST";
  ac.timeoutMs = 15000;
  const runtimeProfile = v.httpRuntimeProfile ?? "custom-http";
  ac.runtimeProfile = runtimeProfile;

  const headers: Record<string, string> = {};
  if (runtimeProfile === "http+crewai") {
    headers["x-agent-runtime"] = v.httpRuntimeHeader?.trim() || "CrewAI";
  } else if (runtimeProfile === "http+langgraph") {
    headers["x-agent-runtime"] = v.httpRuntimeHeader?.trim() || "LangGraph";
  } else if (v.httpRuntimeHeader?.trim()) {
    headers["x-agent-runtime"] = v.httpRuntimeHeader.trim();
  }

  if (Object.keys(headers).length > 0) {
    ac.headers = headers;
  }
  return ac;
}
