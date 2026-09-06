function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * OpenCode does not expose Codex app-server collaboration presets itself, but
 * the Paperclip proxy implements planning semantics through its task envelope,
 * read-only permission profile, and Paperclip runtime tools. Advertise that
 * proxy-owned capability so runnerd can negotiate planning mode without
 * pretending OpenCode supplied a native Codex preset.
 */
export function openCodeProxyCollaborationModes(model: string) {
  const resolvedModel = model.trim();
  if (!resolvedModel) {
    throw new Error(
      "OpenCode collaboration modes are unavailable before thread/start resolves a model",
    );
  }
  return {
    data: [
      {
        name: "Plan",
        mode: "plan",
        model: resolvedModel,
        reasoning_effort: null,
      },
    ],
  };
}

export function assertOpenCodeProxyCollaborationMode(params: unknown): void {
  const collaborationMode = record(record(params).collaborationMode);
  if (Object.keys(collaborationMode).length === 0) return;
  if (collaborationMode.mode !== "plan") {
    throw new Error(
      `Unsupported OpenCode proxy collaboration mode ${String(collaborationMode.mode)}`,
    );
  }
}
