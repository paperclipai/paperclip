import { isAlias, parseDocument, stringify, visit } from "yaml";
import {
  agentConfigurationInputSchema,
  agentConfigurationSpec,
  canonicalAgentConfiguration,
  type AgentConfigurationDocument,
  type AgentConfigurationInput,
  type AgentConfigurationSource,
} from "@paperclipai/shared";

export function serializeAgentConfiguration(agent: AgentConfigurationSource): string {
  return serializeAgentConfigurationDocument({ apiVersion: "paperclip/v1", kind: "Agent", spec: agentConfigurationSpec(agent) } as AgentConfigurationDocument);
}

export function serializeAgentConfigurationDocument(document: AgentConfigurationDocument | AgentConfigurationInput): string {
  return stringify(document, {
    lineWidth: 0, aliasDuplicateObjects: false,
  });
}

function assertJson(value: unknown, depth = 0): void {
  if (depth > 50) throw new Error("Configuration nesting must not exceed 50 levels.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(item => assertJson(item, depth + 1)); return; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype", "<<"].includes(key)) {
        throw new Error(`Unsupported configuration key: ${key}`);
      }
      assertJson(item, depth + 1);
    }
    return;
  }
  throw new Error("Configuration must contain only JSON-compatible values (no NaN or infinity).");
}

export function parseAgentConfigurationYaml(source: string): AgentConfigurationInput {
  if (source.length > 8 * 1024 * 1024 || new TextEncoder().encode(source).byteLength > 8 * 1024 * 1024) throw new Error("Configuration must be smaller than 8 MiB.");
  const document = parseDocument(source, { version: "1.2", schema: "core", uniqueKeys: true, stringKeys: true });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) throw new Error(problem.message);
  if (document.directives?.yaml.version !== "1.2") throw new Error("Use YAML 1.2.");
  visit(document, (_key, node) => {
    if (isAlias(node)) throw new Error("YAML aliases are not supported. Write each value explicitly.");
    if (node && typeof node === "object" && "anchor" in node && node.anchor) throw new Error("YAML anchors are not supported.");
    if (node && typeof node === "object" && "tag" in node && node.tag) throw new Error("YAML tags are not supported.");
  });
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  assertJson(value);
  const parsed = agentConfigurationInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(issue => `${issue.path.join(".") || "document"}: ${issue.message}`).join("\n"));
  }
  return parsed.data;
}

export function agentConfigurationPatch(document: AgentConfigurationInput, saved: AgentConfigurationSource) {
  const before = agentConfigurationSpec(saved);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(before) as Array<keyof typeof before>) {
    if (!Object.hasOwn(document.spec, key)) continue;
    const value = document.spec[key];
    if (canonicalAgentConfiguration(value) !== canonicalAgentConfiguration(before[key as keyof typeof before])) {
      patch[key] = value;
    }
  }
  if (Object.hasOwn(patch, "adapterConfig")) patch.replaceAdapterConfig = true;
  return patch;
}
