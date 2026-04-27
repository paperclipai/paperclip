import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { cookbookListSkills, type CookbookSkillSummary } from "./client.js";

const ADAPTER_TYPE = "managed_agents";

function entryFromCookbook(
  summary: CookbookSkillSummary,
  desired: boolean,
): AdapterSkillEntry {
  const scopeLabel =
    summary.scope_type === "global"
      ? "Cookbook (global)"
      : summary.scope_type === "client"
        ? `Cookbook (client${summary.scope_id ? ` ${summary.scope_id}` : ""})`
        : `Cookbook (${summary.scope_type})`;
  return {
    key: summary.name,
    runtimeName: summary.name,
    desired,
    managed: true,
    state: desired ? "configured" : "available",
    origin: "company_managed",
    originLabel: scopeLabel,
    readOnly: false,
    sourcePath: null,
    targetPath: null,
    detail: desired
      ? "Will be fetched from Cookbook MCP and injected into the Managed Agents session prompt on the next run."
      : summary.description || null,
  };
}

async function buildSnapshot(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  const cookbookKey =
    process.env.COOKBOOK_ACCESS_TOKEN ??
    process.env.COOKBOOK_API_KEY ??
    process.env.MEMORY_API_KEY ??
    "";
  const warnings: string[] = [];

  if (!cookbookKey) {
    return {
      adapterType: ADAPTER_TYPE,
      supported: false,
      mode: "unsupported",
      desiredSkills: [],
      entries: [],
      warnings: [
        "COOKBOOK_API_KEY is not set on the Paperclip server — Cookbook skills cannot be listed or materialized.",
      ],
    };
  }

  let summaries: CookbookSkillSummary[] = [];
  try {
    summaries = await cookbookListSkills(cookbookKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Cookbook MCP list_skills failed: ${msg}`);
  }

  const availableEntries = summaries.map((s) => ({ key: s.name, runtimeName: s.name }));
  const desiredSkills = resolvePaperclipDesiredSkillNames(ctx.config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const availableByKey = new Map(summaries.map((s) => [s.name, s]));

  const entries: AdapterSkillEntry[] = summaries.map((summary) =>
    entryFromCookbook(summary, desiredSet.has(summary.name)),
  );

  for (const desired of desiredSkills) {
    if (availableByKey.has(desired)) continue;
    warnings.push(`Desired skill "${desired}" is not available from Cookbook MCP.`);
    entries.push({
      key: desired,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: undefined,
      targetPath: undefined,
      detail: "Paperclip cannot find this skill in Cookbook MCP.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: ADAPTER_TYPE,
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx);
}

export async function syncSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx);
}
