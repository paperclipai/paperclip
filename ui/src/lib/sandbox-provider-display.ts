import { t } from "@/i18n";

const messages: Readonly<Record<string, string>> = {
  "boxd Sandbox Provider": "nov02Provider.boxdPlugin",
  "Sandbox provider plugin that runs Paperclip environments on boxd microVMs, with suspend and resume for reused leases.": "nov02Provider.boxdDescription",
  "boxd Machine": "nov02Provider.boxdMachine",
  "Creates an isolated boxd machine for each run. With reuse on, the machine is suspended after a run and resumed with its disk, memory and processes for the next run.": "nov02Provider.boxdMachineDescription",
  "Paste a boxd API key (`bxd_...`) or pick a saved Paperclip secret. Create one with `boxd auth keys create paperclip --org <org>`. The key decides which org the machines belong to.": "nov02Provider.boxdApiKey",
  "Suspend the machine after a run and resume it for the next run on the same issue, instead of deleting it. Disk, memory and running processes are kept.": "nov02Provider.boxdReuse",
  "Optional snapshot name or ID to restore for each run, for example a machine with your tools preinstalled. Leave blank to start from the default boxd image (Ubuntu 24.04 with Node 24, git, Docker, Claude Code, Codex and OpenCode).": "nov02Provider.boxdSnapshot",
  "Machine size for fresh machines: 1 vCPU/4 GB, 2/8 GB, 4/16 GB or 8/32 GB. Leave blank for the org default. A snapshot keeps its own size.": "nov02Provider.boxdVcpu",
  "Optional org name or ID. Leave blank to use the API key's org.": "nov02Provider.boxdOrg",
  "Prefix for machine names. Machines are reachable at https://<name>.boxd.sh.": "nov02Provider.boxdPrefix",
  "Default command timeout in milliseconds. Paperclip also uses it as the default run timeout for this environment.": "nov02Provider.boxdTimeout",
  "Machine": "nov02Provider.machineGroup",
  "Runtime": "nov02Provider.runtimeGroup",
  "Optional wall-clock lifetime in minutes from creation. Daytona destroys the sandbox and its files at expiry in any state, even while active. Omit to leave the lifetime unchanged.": "nov02Provider.daytonaTtl"
};

const knownPlugins = new Set(["paperclip.boxd-sandbox-provider", "paperclip.daytona-sandbox-provider"]);

/** Exact shipped metadata only. Edited and third-party text remains verbatim. */
export function sandboxProviderTextDisplay(pluginKey: string | undefined, value: string): string {
  if (!pluginKey || !knownPlugins.has(pluginKey)) return value;
  const key = Object.hasOwn(messages, value) ? messages[value] : undefined;
  return key ? t(key) : value;
}

type DisplaySchema = Record<string, unknown> & { properties?: Record<string, DisplaySchema> };

/** Return a display-only copy; callers keep the original schema for defaults and validation. */
export function sandboxProviderSchemaDisplay<T>(pluginKey: string | undefined, schema: T): T {
  if (!pluginKey || !knownPlugins.has(pluginKey) || !schema || typeof schema !== "object") return schema;
  const source = schema as DisplaySchema;
  const properties = source.properties;
  if (!properties) return schema;
  const output: Record<string, DisplaySchema> = {};
  const boxdFields = new Set(["apiKey", "reuseLease", "snapshot", "vcpu", "org", "namePrefix", "timeoutMs"]);
  for (const [field, value] of Object.entries(properties)) {
    const description = typeof value.description === "string" ? value.description : undefined;
    const knownDescription = description !== undefined && Object.hasOwn(messages, description);
    const ownedField = pluginKey === "paperclip.boxd-sandbox-provider" ? boxdFields.has(field) : field === "ttlMinutes";
    if (!knownDescription || !ownedField) { output[field] = value; continue; }
    output[field] = {
      ...value,
      description: sandboxProviderTextDisplay(pluginKey, description!),
      ...(value.title === undefined ? { title: t(`nov02Provider.field.${field}`) } : {}),
      ...(typeof value["x-paperclip-group"] === "string" ? {
        "x-paperclip-group": sandboxProviderTextDisplay(pluginKey, value["x-paperclip-group"]),
      } : {}),
    };
  }
  return { ...source, properties: output } as T;
}
