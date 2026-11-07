import { t } from "@/i18n";
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
  if (depth > 50) throw new Error(t("display:config_797001f7db40"));
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(item => assertJson(item, depth + 1)); return; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype", "<<"].includes(key)) {
        throw new Error(t("display:config_64eb6056e342", { value0: key }));
      }
      assertJson(item, depth + 1);
    }
    return;
  }
  throw new Error(t("display:config_37e7bd7b33ff"));
}

export function parseAgentConfigurationYaml(source: string): AgentConfigurationInput {
  if (source.length > 8 * 1024 * 1024 || new TextEncoder().encode(source).byteLength > 8 * 1024 * 1024) throw new Error(t("display:config_b941c0592415"));
  const document = parseDocument(source, { version: "1.2", schema: "core", uniqueKeys: true, stringKeys: true });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) throw new Error(problem.message);
  if (document.directives?.yaml.version !== "1.2") throw new Error(t("display:config_3f71794bd06b"));
  visit(document, (_key, node) => {
    if (isAlias(node)) throw new Error(t("display:config_0a7737f85947"));
    if (node && typeof node === "object" && "anchor" in node && node.anchor) throw new Error(t("display:config_030d0d0108fa"));
    if (node && typeof node === "object" && "tag" in node && node.tag) throw new Error(t("display:config_6df8c278addd"));
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
