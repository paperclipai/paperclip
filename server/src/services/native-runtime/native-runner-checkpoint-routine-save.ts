import { createLocalEncryptedCipher } from "../../secrets/local-encrypted-provider.js";

type Binding = { companyId: string; issueId: string; runId: string };
export type RoutineCheckpointSaveOwner = Binding & { bootId: string; leaseOwner: string; generation: number; authorityRunId: string };
export type RoutineCheckpointSaveResult = { owned: number; written: number };

export function encryptCheckpointParts(binding: Binding, records: ReadonlyMap<string, string>) {
  if (!records.size) return [];
  const cipher = createLocalEncryptedCipher("write");
  return [...records].map(([part, contents]) => ({
    companyId: binding.companyId, issueId: binding.issueId, runId: binding.runId, part,
    material: cipher.encrypt(JSON.stringify({ companyId: binding.companyId, issueId: binding.issueId, runId: binding.runId, part, contents })),
  }));
}

export const ROUTINE_CHECKPOINT_SAVE_SQL = `
  with locked_owner as (
    select lease_expires_at from native_run_finalizations
    where company_id = $1::uuid and issue_id = $2::uuid and run_id = $3::uuid and controller_boot_id = $4::text
      and controller_generation = $5::integer and lease_owner = $6::text
    for update
  ), owner as (
    select 1 from locked_owner where lease_expires_at > clock_timestamp()
  ), written as (
    insert into "native_runner_checkpoints" (company_id, issue_id, run_id, part, material)
    select $1::uuid, $2::uuid, $7::uuid, part.value ->> 'part', part.value -> 'material'
    from owner cross join jsonb_array_elements($8::jsonb) as part(value)
    on conflict (run_id, part) do update set material = excluded.material, updated_at = now()
    returning 1
  )
  select (select count(*)::int from owner) as owned, (select count(*)::int from written) as written`;

export function routineCheckpointSaveParameters(owner: RoutineCheckpointSaveOwner, changed: ReturnType<typeof encryptCheckpointParts>) {
  return [owner.companyId, owner.issueId, owner.authorityRunId, owner.bootId, String(owner.generation), owner.leaseOwner, owner.runId,
    JSON.stringify(changed.map(part => ({ part: part.part, material: part.material })))];
}

export function isRoutineCheckpointSave(
  checkpoint: { changedRecords: ReadonlyMap<string, string>; reset: boolean; removedRecords: readonly string[]; predecessor: unknown },
  owner: RoutineCheckpointSaveOwner,
): boolean {
  return checkpoint.changedRecords.size > 0 && !checkpoint.reset && checkpoint.removedRecords.length === 0
    && !checkpoint.changedRecords.has("header") && !checkpoint.predecessor && owner.runId === owner.authorityRunId;
}
