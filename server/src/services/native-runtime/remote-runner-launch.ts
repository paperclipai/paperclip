import { remoteProcessIdentityPrelude } from "@paperclipai/adapter-utils/remote-process-identity";

/** Fixed wrappers; all caller data travels in separately quoted positional args. */
export function remoteRunnerLaunchScripts(kernelReceipt: boolean) {
  const receiptFd = kernelReceipt ? "3>&1 " : "";
  const detach = `if command -v setsid >/dev/null 2>&1; then nohup setsid sh -c "$child_script" paperclip-runner-child "$identity_path" "$identity_nonce" "$runner_instance_id" "$@" ${receiptFd}</dev/null >/dev/null 2>&1 & else nohup sh -c "$child_script" paperclip-runner-child "$identity_path" "$identity_nonce" "$runner_instance_id" "$@" ${receiptFd}</dev/null >/dev/null 2>&1 & fi`;
  return {
    // On the receipt path, the foreground reader keeps this RPC open only until
    // the child emits and closes FD 3, before exec. Runnerd never inherits it.
    launch: 'set -eu; identity_path=$1; identity_nonce=$2; runner_instance_id=$3; child_script=$4; shift 4; umask 077; identity_dir=$(dirname -- "$identity_path"); mkdir -p -- "$identity_dir"; '
      + (kernelReceipt ? `command -v setsid >/dev/null 2>&1; { ${detach}; } | cat` : detach),
    child: 'set -eu; identity_path=$1; identity_nonce=$2; runner_instance_id=$3; diagnostics_directory=$4; shift 4; umask 077; test ! -L "$diagnostics_directory"; if test -e "$diagnostics_directory"; then test -d "$diagnostics_directory"; else mkdir -p -- "$diagnostics_directory"; fi; chmod 0700 "$diagnostics_directory"; started_at=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"); identity_tmp="${identity_path}.tmp.$$"; printf "%s\\n%s\\n%s\\n%s\\n" "$identity_nonce" "$$" "$started_at" "$runner_instance_id" > "$identity_tmp"; chmod 0600 "$identity_tmp"; mv -f -- "$identity_tmp" "$identity_path"; '
      + (kernelReceipt ? remoteProcessIdentityPrelude : "") + 'exec "$@"',
  };
}
