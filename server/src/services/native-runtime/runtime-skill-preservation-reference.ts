import { sql } from "drizzle-orm";
import { heartbeatRuns, companySkillRepositorySnapshots } from "@paperclipai/db";
import { nativeSha256 } from "./canonical.js";
import { parseNativeExecutionInput, type NativeRuntimeContextSnapshot } from "../../vendor/paperclip-runner/index.js";

export const RUNTIME_SKILL_PRESERVATION_KEY = "nativeRuntimeSkillPreservation";
export const RUNTIME_SKILL_PRESERVATION_SCHEMA = "paperclip.runtime-skill-preservation.v1";
export type PreservedRuntimeSkill = {
  key: string; runtimeName: string; bundle: NativeRuntimeContextSnapshot["skills"][number]["bundle"];
  manifestText: string; packageSnapshotId: string; packageContentHash: string;
};
export type RuntimeSkillPreservation = {
  schema: typeof RUNTIME_SKILL_PRESERVATION_SCHEMA; inputDigest: string; bindingDigest: string; assets: PreservedRuntimeSkill[];
};
export function admittedRuntimeSkills(row: { id: string; companyId: string; agentId: string; nativeIssueId: string | null;
  runnerProfileJson: Record<string, unknown> | null }) {
  const input = parseNativeExecutionInput(row.runnerProfileJson?.nativeExecutionInput);
  if (input.binding.companyId !== row.companyId || input.binding.runId !== row.id
    || input.binding.agentId !== row.agentId || input.binding.issueId !== row.nativeIssueId || !("runtimeContext" in input)) {
    throw new Error("runtime_skill_preservation_binding_changed");
  }
  return { input, skills: input.runtimeContext.skills.filter(skill => skill.versionId === null),
    inputDigest: nativeSha256(row.runnerProfileJson?.nativeExecutionInput), bindingDigest: nativeSha256(input.binding) };
}
export function sameRuntimeSkill(a: Pick<PreservedRuntimeSkill, "key" | "runtimeName" | "bundle">,
  b: Pick<PreservedRuntimeSkill, "key" | "runtimeName" | "bundle">) {
  return a.key === b.key && a.runtimeName === b.runtimeName && a.bundle.digest === b.bundle.digest
    && a.bundle.manifestDigest === b.bundle.manifestDigest && a.bundle.fileCount === b.bundle.fileCount
    && a.bundle.totalBytes === b.bundle.totalBytes;
}
export function readRuntimeSkillPreservation(row: Parameters<typeof admittedRuntimeSkills>[0]): RuntimeSkillPreservation | null {
  const admitted = admittedRuntimeSkills(row);
  const receipt = row.runnerProfileJson?.[RUNTIME_SKILL_PRESERVATION_KEY] as RuntimeSkillPreservation | undefined;
  // Explicit continuation may revise a completion contract while preserving the
  // exact admitted asset set. Retain the original capture digest as provenance;
  // bind readers to the current run scope and unchanged immutable selection.
  if (receipt?.schema !== RUNTIME_SKILL_PRESERVATION_SCHEMA || !/^[a-f0-9]{64}$/.test(receipt.inputDigest)
    || receipt.bindingDigest !== admitted.bindingDigest
    || !Array.isArray(receipt.assets) || receipt.assets.length !== admitted.skills.length) return null;
  const ids = new Set<string>();
  for (let i = 0; i < admitted.skills.length; i++) {
    const asset = receipt.assets[i];
    if (!asset || !sameRuntimeSkill(asset, admitted.skills[i]!) || typeof asset.manifestText !== "string"
      || !/^[a-f0-9-]{36}$/i.test(asset.packageSnapshotId) || !/^[a-f0-9]{64}$/.test(asset.packageContentHash)
      || ids.has(asset.key)) return null;
    ids.add(asset.key);
  }
  return receipt;
}

/** Ordinary admission has no input yet. Only a concrete admitted local asset is
 * a durability obligation; missing transient version pins alone are not one. */
export function hasUnversionedRuntimeSkillInputSql() {
  const skills = sql`${heartbeatRuns.runnerProfileJson} #> '{nativeExecutionInput,runtimeContext,skills}'`;
  return sql`${heartbeatRuns.runtimeMode} = 'native'
    and ${heartbeatRuns.runnerProfileJson} #> '{nativeExecutionInput,runtimeContext}' is not null
    and (jsonb_typeof(${skills}) is distinct from 'array' or exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(${skills}) = 'array' then ${skills} else '[]'::jsonb end) s
      where s->>'versionId' is null or s->>'versionId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'))`;
}

/** JSON receipts are references just like version FKs. Unknown receipt shapes
 * retain the company's packages rather than allowing destructive inference. */
export function runtimeSkillPackageUnreferencedSql() {
  return sql`not exists (select 1 from ${heartbeatRuns} r where r.company_id = ${companySkillRepositorySnapshots.companyId}
    and r.runner_profile_json ? 'nativeRuntimeSkillPreservation'
    and (r.runner_profile_json->'nativeRuntimeSkillPreservation'->>'schema' is distinct from ${RUNTIME_SKILL_PRESERVATION_SCHEMA}
      or coalesce(r.runner_profile_json->'nativeRuntimeSkillPreservation'->>'inputDigest', '') !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(r.runner_profile_json->'nativeRuntimeSkillPreservation'->'assets') is distinct from 'array'
      or exists (select 1 from jsonb_array_elements(case
        when jsonb_typeof(r.runner_profile_json->'nativeRuntimeSkillPreservation'->'assets') = 'array'
        then r.runner_profile_json->'nativeRuntimeSkillPreservation'->'assets' else '[]'::jsonb end) a
        where coalesce(a->>'packageSnapshotId', '') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
          or a->>'packageSnapshotId' = ${companySkillRepositorySnapshots.id}::text)))`;
}
