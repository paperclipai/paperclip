/** Linux kernel identity read by a trusted launch wrapper before agent code runs. */
export interface RemoteProcessIdentity {
  version: 1;
  pid: number;
  uid: number;
  processGroupId: number;
  bootId: string;
  startTicks: string;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function isRemoteProcessIdentity(value: unknown): value is RemoteProcessIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(",") === "bootId,pid,processGroupId,startTicks,uid,version"
    && row.version === 1
    && Number.isSafeInteger(row.pid) && (row.pid as number) > 1
    && Number.isSafeInteger(row.uid) && (row.uid as number) >= 0
    && Number.isSafeInteger(row.processGroupId) && (row.processGroupId as number) > 1
    && typeof row.bootId === "string" && uuid.test(row.bootId)
    && typeof row.startTicks === "string" && /^[1-9][0-9]{0,19}$/.test(row.startTicks);
}

/**
 * FD 3 belongs only to the provider launch RPC. Emit before exec, then close it
 * so agent output cannot supply or replace this receipt. No sandbox-writable
 * marker is used as its authority. Function positional args preserve the command
 * vector; ${...##*) } handles spaces/parentheses in Linux's comm field.
 */
export const remoteProcessIdentityPrelude = [
  'paperclip_emit_process_identity() {',
  '  IFS= read -r paperclip_boot < /proc/sys/kernel/random/boot_id;',
  '  IFS= read -r paperclip_stat < "/proc/$$/stat";',
  '  paperclip_stat=${paperclip_stat##*) };',
  '  set -- $paperclip_stat;',
  '  paperclip_group=$3; shift 19; paperclip_ticks=$1;',
  '  paperclip_uid=; while read -r paperclip_label paperclip_real paperclip_effective paperclip_saved paperclip_fs; do',
  '    if test "$paperclip_label" = "Uid:"; then',
  '      test "$paperclip_real" = "$paperclip_effective" && test "$paperclip_real" = "$paperclip_saved" && test "$paperclip_real" = "$paperclip_fs";',
  '      paperclip_uid=$paperclip_real; break;',
  '    fi;',
  '  done < "/proc/$$/status"; test -n "$paperclip_uid";',
  '  printf "paperclip-process-v1|%s|%s|%s|%s|%s|%s\\n" "$identity_nonce" "$$" "$paperclip_uid" "$paperclip_group" "$paperclip_boot" "$paperclip_ticks" >&3;',
  '}; paperclip_emit_process_identity; exec 3>&-;',
].join("\n");

/** Parse only the exact pre-exec response for this particular launch attempt. */
export function parseRemoteProcessLaunchReceipt(value: string, nonce: string): RemoteProcessIdentity | null {
  if (value.length > 512 || !uuid.test(nonce)) return null;
  const match = /^paperclip-process-v1\|([^|\n]+)\|([1-9][0-9]*)\|([0-9]+)\|([1-9][0-9]*)\|([^|\n]+)\|([1-9][0-9]*)\n$/.exec(value);
  if (!match || match[1] !== nonce) return null;
  const identity = { version: 1, pid: Number(match[2]), uid: Number(match[3]), processGroupId: Number(match[4]), bootId: match[5], startTicks: match[6] };
  return isRemoteProcessIdentity(identity) ? identity : null;
}
