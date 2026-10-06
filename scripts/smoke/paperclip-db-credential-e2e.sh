#!/bin/sh
set -eu
repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
docker build -q -f "$repo_root/ops/paperclip-db-credential/Dockerfile.e2e" \
  -t paperclip-db-credential-e2e:local "$repo_root/ops/paperclip-db-credential" >/dev/null
docker run --rm --network none --entrypoint bash \
  --mount "type=bind,src=$repo_root/ops/paperclip-db-credential,dst=/work,readonly" \
  paperclip-db-credential-e2e:local /work/container-e2e.sh
scratch_parent=${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}
scratch=$(mktemp -d "$scratch_parent/paperclip-copy-scan.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/worktree/.paperclip" "$scratch/worktree/nested"
printf '%s\n' 'postgres://old_agent:synthetic@127.0.0.1/synthetic' > "$scratch/old-url"
printf '%s\n' '{"database":{"mode":"postgres"}}' > "$scratch/worktree/.paperclip/config.json"
printf '%s\n' 'PAPERCLIP_INSTANCE_ID=synthetic' > "$scratch/worktree/.paperclip/.env"
printf '%s\n' 'no credential here' > "$scratch/worktree/nested/notes.txt"
scan="$repo_root/ops/paperclip-db-credential/verify-copies.py"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree"
printf '%s\n' 'postgres://new_agent:different_synthetic@127.0.0.1/synthetic' \
  > "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a new worktree credential' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
grep -Eq 'Copy scan: checked=[0-9]+ failures=[1-9][0-9]*' "$scratch/scan-result"
printf '%s\n' 'postgres://new_agent:synthetic_postgres://suffix@127.0.0.1/synthetic' \
  > "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a credential containing a URL prefix' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
printf '%s\n' 'postgres://a@127.0.0.1/db?application_name=ok;postgres://b@127.0.0.1/db?password=different_synthetic' \
  > "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a password in an adjacent URL' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
printf '%s\n' 'postgres://a@127.0.0.1/db?application_name=postgres://b&password=different_synthetic' \
  > "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a password after a nested URL prefix' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
printf '%s\n' 'postgres://a@127.0.0.1/db?application_name=ok;postgres://b@127.0.0.1/db?application_name=ok' \
  > "$scratch/worktree/nested/notes.txt"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
printf '%s\n' 'postgres://a@127.0.0.1/db?application_name=run?password=disabled' \
  > "$scratch/worktree/nested/notes.txt"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
printf '%s\n' 'no credential here' > "$scratch/worktree/nested/notes.txt"
printf '%s\n' 'DATABASE_URL=postgresql://new_agent:different_synthetic@127.0.0.1/synthetic' \
  > "$scratch/worktree/.env.local"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a new .env.local credential' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
grep -Eq 'Copy scan: checked=[0-9]+ failures=[1-9][0-9]*' "$scratch/scan-result"
rm "$scratch/worktree/.env.local"
printf '%s\n' 'postgresql://new_agent@127.0.0.1/synthetic?application_name=copy_scan' \
  > "$scratch/worktree/nested/notes.txt"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
printf '%s\n' 'DATABASE_URL=postgresql://new_agent@127.0.0.1/synthetic?application_name=copy_scan&password=different_synthetic' \
  > "$scratch/worktree/.env.local"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a query-parameter password in .env.local' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
grep -Eq 'Copy scan: checked=[0-9]+ failures=[1-9][0-9]*' "$scratch/scan-result"
rm "$scratch/worktree/.env.local"
printf '%s\n' 'DATABASE_URL=postgresql://new_agent@127.0.0.1/synthetic' \
  'PGPASSWORD=different_synthetic' \
  > "$scratch/worktree/.env.local"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject PGPASSWORD in .env.local' >&2
  exit 1
fi
grep -q 'env-libpq-password' "$scratch/scan-result"
if grep -q 'different_synthetic' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
rm "$scratch/worktree/.env.local"
printf '%s\n' 'PGPASSFILE=/synthetic/private/passfile' \
  > "$scratch/worktree/.env.local"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a libpq passfile reference in .env.local' >&2
  exit 1
fi
grep -q 'reasons=env-libpq-credential-reference' "$scratch/scan-result"
rm "$scratch/worktree/.env.local"
for fixture in conninfo conninfo_multiline conninfo_password_only \
  conninfo_psql_d conninfo_psql_d_prefixed conninfo_psql_d_password_only \
  conninfo_psql_d_shell conninfo_psql_d_timeout conninfo_psql_d_timeout_options \
  conninfo_psql_d_timeout_long_option conninfo_psql_d_sudo \
  conninfo_psql_d_sudo_options conninfo_psql_d_sudo_long_option \
  conninfo_psql_d_nohup conninfo_psql_d_wrappers \
  conninfo_psql_d_quoted_wrappers conninfo_psql_d_env_split \
  conninfo_psql_d_env_split_long conninfo_psql_d_env_split_attached \
  conninfo_psql_d_env_split_quoted_option conninfo_psql_d_env_split_verbose \
  conninfo_psql_d_env_split_verbose_attached conninfo_psql_d_env_split_ignore \
  conninfo_psql_d_env_split_unsupported \
  conninfo_psql_d_env_split_shebang \
  conninfo_client_encoding conninfo_client_encoding_multiline shell shell_ansi_c \
  shell_env shell_env_split_password shell_leading_assignment \
  shell_quoted_assignment shell_env_unset \
  shell_command_env shell_command_p_env shell_exec_env shell_exec_env_unset \
  shell_exec_dashdash_env shell_exec_c_env shell_exec_a_env \
  shell_builtin_exec_env shell_command_exec_env shell_prefix_exec_env \
  shell_prefix_command_env shell_default shell_exec_default \
  shell_if shell_if_prefixed shell_elif shell_while shell_until \
  shell_then shell_do shell_not shell_time shell_command_substitution shell_multiple \
  shell_env_multiple shell_group shell_local_source shell_quoted_command; do
  case "$fixture" in
    conninfo)
      name=conninfo.txt
      content='host=127.0.0.1 dbname=synthetic user=new_agent password=different_synthetic'
      reason=libpq-conninfo-password
      ;;
    conninfo_multiline)
      name=multiline-conninfo.txt
      content='host=127.0.0.1 dbname=synthetic user=new_agent
password=different_synthetic'
      reason=libpq-conninfo-password
      ;;
    conninfo_password_only)
      name=password-only-conninfo.txt
      content='password=different_synthetic'
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d)
      name=psql-conninfo.sh
      content='psql -d "host=127.0.0.1 dbname=synthetic user=new_agent password=different_synthetic"'
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_prefixed)
      name=psql-prefixed-conninfo.sh
      content='PGAPPNAME=probe psql --dbname="host=127.0.0.1 dbname=synthetic user=new_agent password=different_synthetic"'
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_password_only)
      name=psql-password-only-conninfo.sh
      content="psql -d 'password=different_synthetic'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_shell)
      name=psql-shell-conninfo.sh
      content='sh -c '\''psql -d "host=127.0.0.1 dbname=synthetic user=new_agent password=different_synthetic"'\'''
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_timeout)
      name=psql-timeout-conninfo.sh
      content="timeout 10 psql -d 'host=127.0.0.1 password=different_synthetic'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_timeout_options)
      name=psql-timeout-options-conninfo.sh
      content="timeout -s TERM -k 2 -- 10 psql --dbname='host=127.0.0.1 password=different_synthetic'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_timeout_long_option)
      name=psql-timeout-long-option-conninfo.sh
      content="timeout --signal TERM 10 psql -d 'host=127.0.0.1 password=different_synthetic'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_sudo)
      name=psql-sudo-conninfo.sh
      content="sudo psql -d 'host=127.0.0.1 password=different_synthetic'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_sudo_options)
      name=psql-sudo-options-conninfo.sh
      content="sudo -u postgres -- psql --dbname='host=127.0.0.1 password=different_synthetic'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_sudo_long_option)
      name=psql-sudo-long-option-conninfo.sh
      content="sudo --user postgres psql -d 'host=127.0.0.1 password=different_synthetic'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_nohup)
      name=psql-nohup-conninfo.sh
      content="nohup -- psql -d 'host=127.0.0.1 password=different_synthetic'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_wrappers)
      name=psql-nested-wrappers-conninfo.sh
      content="timeout 10 sudo -n nohup psql -d 'host=127.0.0.1 password=different_synthetic'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_quoted_wrappers)
      name=psql-quoted-wrappers-conninfo.sh
      content="'timeout' 10 \"sudo\" 'nohup' \"psql\" -d 'host=127.0.0.1 password=different_synthetic'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_env_split)
      name=psql-env-split-conninfo.sh
      content="env -S 'psql -d \"host=127.0.0.1 password=different_synthetic\"'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_env_split_long)
      name=psql-env-split-long-conninfo.sh
      content="env --split-string='psql -d \"host=127.0.0.1 password=different_synthetic\"'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_env_split_attached)
      name=psql-env-split-attached-conninfo.sh
      content="env -S'psql -d \"host=127.0.0.1 password=different_synthetic\"'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_env_split_quoted_option)
      name=psql-env-split-quoted-option-conninfo.sh
      content="env '-S' 'psql -d \"host=127.0.0.1 password=different_synthetic\"'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_env_split_verbose)
      name=psql-env-split-verbose-conninfo.sh
      content="env -vS 'psql -d \"host=127.0.0.1 password=different_synthetic\"'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_env_split_verbose_attached)
      name=psql-env-split-verbose-attached-conninfo.sh
      content="env -vS'psql -d \"host=127.0.0.1 password=different_synthetic\"'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_env_split_ignore)
      name=psql-env-split-ignore-conninfo.sh
      content="env -iS 'psql -d \"host=127.0.0.1 password=different_synthetic\"'"
      reason=libpq-conninfo-password
      ;;
    conninfo_psql_d_env_split_unsupported)
      name=psql-env-split-unsupported-conninfo.sh
      content="env --block-signal=PIPE -S 'psql -d \"host=127.0.0.1 password=different_synthetic\"'"
      reason=unparsed-env-split-string
      ;;
    conninfo_psql_d_env_split_shebang)
      name=psql-env-split-shebang-conninfo.sh
      content='#!/usr/bin/env -S psql -d "host=127.0.0.1 password=different_synthetic"'
      reason=libpq-conninfo-password
      ;;
    conninfo_client_encoding)
      name=client-encoding-conninfo.txt
      content='client_encoding=UTF8 host=127.0.0.1 password=different_synthetic'
      reason=libpq-conninfo-password
      ;;
    conninfo_client_encoding_multiline)
      name=client-encoding-multiline-conninfo.txt
      content='client_encoding=UTF8
password=different_synthetic'
      reason=libpq-conninfo-password
      ;;
    shell)
      name=run.sh
      content='export PGPASSWORD=different_synthetic'
      reason=env-libpq-password
      ;;
    shell_ansi_c)
      name=run-ansi-c.sh
      content="export PGPASSWORD=\$'different_synthetic'"
      reason=env-libpq-password
      ;;
    shell_env)
      name=run-env.sh
      content='env PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_env_split_password)
      name=run-env-split-password.sh
      content="env --split-string='PGPASSWORD=different_synthetic psql'"
      reason=env-libpq-password
      ;;
    shell_leading_assignment)
      name=run-leading-assignment.sh
      content='PGAPPNAME=probe PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_quoted_assignment)
      name=run-quoted-assignment.sh
      content="PGAPPNAME='probe name' PGPASSWORD=different_synthetic psql"
      reason=env-libpq-password
      ;;
    shell_env_unset)
      name=run-env-unset.sh
      content='env -u PGAPPNAME PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_command_env)
      name=run-command-env.sh
      content='command env PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_command_p_env)
      name=run-command-p-env.sh
      content='command -p env PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_exec_env)
      name=run-exec-env.sh
      content='exec env PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_exec_env_unset)
      name=run-exec-env-unset.sh
      content='exec env -u PGAPPNAME PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_exec_dashdash_env)
      name=run-exec-dashdash-env.sh
      content='exec -- env PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_exec_c_env)
      name=run-exec-c-env.sh
      content='exec -c env PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_exec_a_env)
      name=run-exec-a-env.sh
      content='exec -a psql env PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_builtin_exec_env)
      name=run-builtin-exec-env.sh
      content='builtin exec env PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_command_exec_env)
      name=run-command-exec-env.sh
      content='command exec env PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_prefix_exec_env)
      name=run-prefix-exec-env.sh
      content='PGAPPNAME=probe exec env PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_prefix_command_env)
      name=run-prefix-command-env.sh
      content='PGAPPNAME=probe command env PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_default)
      name=run-default.sh
      content='export PGPASSWORD=${DB_PASS:-different_synthetic}'
      reason=env-libpq-password
      ;;
    shell_if)
      name=run-if.sh
      content="if PGPASSWORD=different_synthetic sh -c 'test \"\$PGPASSWORD\" = different_synthetic'; then :; else exit 1; fi"
      reason=env-libpq-password
      ;;
    shell_if_prefixed)
      name=run-if-prefixed.sh
      content='if PGAPPNAME=probe command env PGPASSWORD=different_synthetic psql; then :; fi'
      reason=env-libpq-password
      ;;
    shell_elif)
      name=run-elif.sh
      content='if false; then :; elif PGPASSWORD=different_synthetic psql; then :; fi'
      reason=env-libpq-password
      ;;
    shell_while)
      name=run-while.sh
      content='while PGPASSWORD=different_synthetic psql; do :; done'
      reason=env-libpq-password
      ;;
    shell_until)
      name=run-until.sh
      content='until PGPASSWORD=different_synthetic psql; do :; done'
      reason=env-libpq-password
      ;;
    shell_then)
      name=run-then.sh
      content='if true; then PGPASSWORD=different_synthetic psql; fi'
      reason=env-libpq-password
      ;;
    shell_do)
      name=run-do.sh
      content='while true; do PGPASSWORD=different_synthetic psql; done'
      reason=env-libpq-password
      ;;
    shell_not)
      name=run-not.sh
      content='if ! PGPASSWORD=different_synthetic psql; then :; fi'
      reason=env-libpq-password
      ;;
    shell_time)
      name=run-time.sh
      content='time -p PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_exec_default)
      name=run-exec-default.sh
      content='exec env PGPASSWORD=${DB_PASS:-different_synthetic} psql'
      reason=env-libpq-password
      ;;
    shell_command_substitution)
      name=run-substitution.sh
      content="export PGPASSWORD=\$(printf '%s' different_synthetic)"
      reason=env-libpq-password
      ;;
    shell_multiple)
      name=run-multiple.sh
      content='export PGPASSWORD=$FROM_PRIVATE_SOURCE; '"PGPASSWORD=different_synthetic"
      reason=env-libpq-password
      ;;
    shell_env_multiple)
      name=run-env-multiple.sh
      content='env PGPASSWORD=$FROM_PRIVATE_SOURCE PGPASSWORD=different_synthetic psql'
      reason=env-libpq-password
      ;;
    shell_group)
      name=run-group.sh
      content="{ PGPASSWORD=different_synthetic sh -c 'test \"\$PGPASSWORD\" = different_synthetic'; }"
      reason=env-libpq-password
      ;;
    shell_local_source)
      name=run-local-source.sh
      content="DB_PASS=different_synthetic
PGPASSWORD=\$DB_PASS sh -c 'test \"\$PGPASSWORD\" = different_synthetic'"
      reason=env-libpq-password
      ;;
    shell_quoted_command)
      name=run-quoted-command.sh
      content="sh -c 'if PGPASSWORD=different_synthetic sh -c \"test \\\$PGPASSWORD = different_synthetic\"; then :; else exit 1; fi'"
      reason=env-libpq-password
      ;;
  esac
  case "$fixture" in
    conninfo_psql_d_env_split*|shell_env_split_password) sh -n -c "$content" ;;
  esac
  if [ "$fixture" = shell_if ] || [ "$fixture" = shell_group ] || \
      [ "$fixture" = shell_local_source ] || [ "$fixture" = shell_quoted_command ]; then
    sh -c "$content" # The synthetic assignment really reaches the child process.
  fi
  printf '%s\n' "$content" > "$scratch/worktree/nested/$name"
  chmod 0600 "$scratch/worktree/nested/$name"
  if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
    > "$scratch/scan-result" 2>&1; then
    echo "Copy scan did not reject worktree $fixture credential" >&2
    exit 1
  fi
  grep -Fxq "FAIL $scratch/worktree/nested/$name reasons=$reason" "$scratch/scan-result"
  grep -Eq '^Copy scan: checked=[0-9]+ failures=1$' "$scratch/scan-result"
  test "$(wc -l < "$scratch/scan-result")" -eq 2
  if grep -q 'different_synthetic' "$scratch/scan-result"; then
    echo 'Copy scan printed synthetic credential material' >&2
    exit 1
  fi
  mv "$scratch/worktree/nested/$name" "$scratch/$name"
  if python3 "$scan" --old-url-file "$scratch/old-url" --carrier "$scratch/$name" \
    > "$scratch/scan-result" 2>&1; then
    echo "Copy scan did not reject explicit $fixture carrier" >&2
    exit 1
  fi
  grep -Fxq "FAIL $scratch/$name reasons=$reason" "$scratch/scan-result"
  grep -Fxq 'Copy scan: checked=1 failures=1' "$scratch/scan-result"
  test "$(wc -l < "$scratch/scan-result")" -eq 2
  if grep -q 'different_synthetic' "$scratch/scan-result"; then
    echo 'Copy scan printed synthetic credential material' >&2
    exit 1
  fi
  rm "$scratch/$name"
done
printf '%s\n' 'psql -d "host=127.0.0.1 dbname=synthetic user=new_agent"' \
  > "$scratch/worktree/nested/psql-passwordless.sh"
printf '%s\n' "env -S 'printf %s env-split-ok'" \
  "env -vS 'printf %s env-split-ok'" \
  "env -vS'printf %s env-split-ok'" \
  "env -iS 'printf %s env-split-ok'" \
  "env --split-string='printf %s env-split-ok'" \
  > "$scratch/worktree/nested/clean-env-split.sh"
test "$(env -S 'printf %s env-split-ok')" = env-split-ok
test "$(env -vS 'printf %s env-split-ok' 2>/dev/null)" = env-split-ok
test "$(env -vS'printf %s env-split-ok' 2>/dev/null)" = env-split-ok
test "$(env -iS 'printf %s env-split-ok')" = env-split-ok
test "$(env --split-string='printf %s env-split-ok')" = env-split-ok
printf '%s\n' "curl -d 'password=different_synthetic' https://example.invalid/" \
  "timeout 10 curl -d 'password=different_synthetic' https://example.invalid/" \
  "sudo -u psql curl -d 'password=different_synthetic' https://example.invalid/" \
  "nohup curl -d 'password=different_synthetic' https://example.invalid/" \
  "echo psql -d 'password=different_synthetic'" \
  "sh -c 'curl -d \"password=different_synthetic\" https://example.invalid/'" \
  > "$scratch/worktree/nested/non-psql-data.sh"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
grep -Eq '^Copy scan: checked=[0-9]+ failures=0$' "$scratch/scan-result"
for name in psql-passwordless.sh clean-env-split.sh non-psql-data.sh; do
  python3 "$scan" --old-url-file "$scratch/old-url" \
    --carrier "$scratch/worktree/nested/$name" > "$scratch/scan-result"
  grep -Fxq 'Copy scan: checked=1 failures=0' "$scratch/scan-result"
done
rm "$scratch/worktree/nested/psql-passwordless.sh" \
  "$scratch/worktree/nested/clean-env-split.sh" \
  "$scratch/worktree/nested/non-psql-data.sh"
echo 'psql -d and env -S/-vS/-iS conninfo rejection; clean env, curl and passwordless controls passed in both modes'
printf '%s\n' 'DB_PASS=different_synthetic' > "$scratch/worktree/nested/source.env"
printf '%s\n' 'PGPASSWORD=$DB_PASS sh -c '\''test "$PGPASSWORD" = different_synthetic'\''' \
  > "$scratch/worktree/nested/run-from-source.sh"
chmod 0600 "$scratch/worktree/nested/source.env" "$scratch/worktree/nested/run-from-source.sh"
sh -c '. "$1"; . "$2"' sh "$scratch/worktree/nested/source.env" \
  "$scratch/worktree/nested/run-from-source.sh"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result" 2>&1; then
  echo 'Copy scan did not reject a worktree variable defined in another file' >&2
  exit 1
fi
grep -Fxq "FAIL $scratch/worktree/nested/run-from-source.sh reasons=env-libpq-password" \
  "$scratch/scan-result"
grep -Eq '^Copy scan: checked=[0-9]+ failures=1$' "$scratch/scan-result"
test "$(wc -l < "$scratch/scan-result")" -eq 2
if grep -q 'different_synthetic' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
if python3 "$scan" --old-url-file "$scratch/old-url" \
  --carrier "$scratch/worktree/nested/source.env" \
  --carrier "$scratch/worktree/nested/run-from-source.sh" \
  > "$scratch/scan-result" 2>&1; then
  echo 'Copy scan did not reject an explicit carrier variable defined in another file' >&2
  exit 1
fi
grep -Fxq "FAIL $scratch/worktree/nested/run-from-source.sh reasons=env-libpq-password" \
  "$scratch/scan-result"
grep -Fxq 'Copy scan: checked=2 failures=1' "$scratch/scan-result"
test "$(wc -l < "$scratch/scan-result")" -eq 2
if grep -q 'different_synthetic' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
rm "$scratch/worktree/nested/source.env" "$scratch/worktree/nested/run-from-source.sh"
echo 'Shell group and local/cross-file password reference rejection passed in worktree and explicit carriers'
cat > "$scratch/worktree/nested/run-continued.sh" <<'SH'
#!/bin/sh
PGPASS\
WORD=different_synthetic sh -c 'test "$PGPASSWORD" = different_synthetic'
SH
chmod 0600 "$scratch/worktree/nested/run-continued.sh"
sh "$scratch/worktree/nested/run-continued.sh"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result" 2>&1; then
  echo 'Copy scan did not reject a continued worktree password assignment' >&2
  exit 1
fi
grep -Fxq "FAIL $scratch/worktree/nested/run-continued.sh reasons=env-libpq-password" \
  "$scratch/scan-result"
grep -Eq '^Copy scan: checked=[0-9]+ failures=1$' "$scratch/scan-result"
test "$(wc -l < "$scratch/scan-result")" -eq 2
if grep -q 'different_synthetic' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
if python3 "$scan" --old-url-file "$scratch/old-url" \
  --carrier "$scratch/worktree/nested/run-continued.sh" \
  > "$scratch/scan-result" 2>&1; then
  echo 'Copy scan did not reject a continued explicit carrier password assignment' >&2
  exit 1
fi
grep -Fxq "FAIL $scratch/worktree/nested/run-continued.sh reasons=env-libpq-password" \
  "$scratch/scan-result"
grep -Fxq 'Copy scan: checked=1 failures=1' "$scratch/scan-result"
test "$(wc -l < "$scratch/scan-result")" -eq 2
if grep -q 'different_synthetic' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
rm "$scratch/worktree/nested/run-continued.sh"
cat > "$scratch/worktree/nested/clean-continued.sh" <<'SH'
#!/bin/sh
PGPASS\
WORD=$FROM_PRIVATE_SOURCE sh -c 'test "$PGPASSWORD" = different_synthetic'
SH
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
python3 "$scan" --old-url-file "$scratch/old-url" \
  --carrier "$scratch/worktree/nested/clean-continued.sh" > "$scratch/scan-result"
rm "$scratch/worktree/nested/clean-continued.sh"
python3 - "$scratch/worktree/nested/oversized-continued.sh" <<'PY'
from pathlib import Path
import sys

Path(sys.argv[1]).write_bytes(b"PGPASS\\\nWORD=" + b"x" * (64 * 1024))
PY
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result" 2>&1; then
  echo 'Copy scan did not reject an oversized continued worktree line' >&2
  exit 1
fi
grep -Fxq "FAIL $scratch/worktree/nested/oversized-continued.sh reasons=oversized-db-carrier-line" \
  "$scratch/scan-result"
rm "$scratch/worktree/nested/oversized-continued.sh"
python3 - "$scratch/worktree/nested/oversized-physical.sh" <<'PY'
from pathlib import Path
import sys

Path(sys.argv[1]).write_bytes(
    b"#!/bin/sh\n"
    + b"env " + b" " * (64 * 1024) + b"PGPASS\\\n"
    + b"WORD=different_synthetic sh -c 'test \"$PGPASSWORD\" = different_synthetic'\n"
)
PY
sh "$scratch/worktree/nested/oversized-physical.sh"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result" 2>&1; then
  echo 'Copy scan did not reject an oversized physical line with a continued password assignment' >&2
  exit 1
fi
grep -Fxq "FAIL $scratch/worktree/nested/oversized-physical.sh reasons=oversized-db-carrier-line" \
  "$scratch/scan-result"
if grep -q 'different_synthetic' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
rm "$scratch/worktree/nested/oversized-physical.sh"
# The .txt variant has no shell filename or shebang, so it exercises the
# bounded scan of the tail rather than the conservative shell-file rule.
for name in oversized-psql.sh oversized-psql.txt; do
  fixture="$scratch/worktree/nested/$name"
  for filler in 70000 65529; do
    python3 - "$fixture" "$filler" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
path.write_bytes(
    (b"#!/bin/sh\n" if path.suffix == ".sh" else b"")
    + b"echo " + b"x" * int(sys.argv[2])
    + b"; psql -d 'host=127.0.0.1 dbname=synthetic password=different_synthetic'\n"
)
PY
    sh -n "$fixture"
    for source in worktree carrier; do
      if [ "$source" = worktree ]; then
        set -- --worktree-root "$scratch/worktree"
      else
        set -- --carrier "$fixture"
      fi
      if python3 "$scan" --old-url-file "$scratch/old-url" "$@" \
        > "$scratch/scan-result" 2>&1; then
        echo "Copy scan did not reject oversized psql in $source" >&2
        exit 1
      fi
      grep -Fxq "FAIL $fixture reasons=oversized-db-carrier-line" \
        "$scratch/scan-result"
      grep -Eq '^Copy scan: checked=[0-9]+ failures=1$' "$scratch/scan-result"
      if grep -q 'different_synthetic' "$scratch/scan-result"; then
        echo 'Copy scan printed synthetic credential material' >&2
        exit 1
      fi
    done
  done
  rm "$fixture"
done
python3 - "$scratch/worktree/nested/oversized-shell.sh" <<'PY'
from pathlib import Path
import sys

Path(sys.argv[1]).write_bytes(b"#!/bin/sh\n: " + b"x" * 70000 + b"\n")
PY
sh -n "$scratch/worktree/nested/oversized-shell.sh"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result" 2>&1; then
  echo 'Copy scan did not fail closed on an oversized shell command' >&2
  exit 1
fi
grep -Fxq "FAIL $scratch/worktree/nested/oversized-shell.sh reasons=oversized-db-carrier-line" \
  "$scratch/scan-result"
rm "$scratch/worktree/nested/oversized-shell.sh"
python3 - "$scratch/worktree/nested/ordinary-long.txt" <<'PY'
from pathlib import Path
import sys

Path(sys.argv[1]).write_bytes(b"x" * 70000 + b"\nordinary text\n")
PY
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
python3 "$scan" --old-url-file "$scratch/old-url" \
  --carrier "$scratch/worktree/nested/ordinary-long.txt" > "$scratch/scan-result"
grep -Fxq 'Copy scan: checked=1 failures=0' "$scratch/scan-result"
rm "$scratch/worktree/nested/ordinary-long.txt"
echo 'Shell line continuation rejection and private reference control passed'
printf '%s\n' 'client_encoding=UTF8 host=127.0.0.1 dbname=synthetic user=new_agent' \
  > "$scratch/worktree/nested/clean-conninfo.txt"
printf '%s\n' '#!/bin/sh' 'export PGAPPNAME=synthetic' 'export PGPASSWORD=$FROM_PRIVATE_SOURCE' \
  > "$scratch/worktree/nested/clean-run.sh"
printf '%s\n' '#!/bin/sh' 'env PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  > "$scratch/worktree/nested/clean-env-run.sh"
printf '%s\n' '#!/bin/sh' 'PGAPPNAME=probe PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'env -u PGAPPNAME PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'command env PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'command -p env PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'exec env PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'exec env -u PGAPPNAME PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'exec -- env PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'exec -c env PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'exec -a psql env PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'builtin exec env PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'command exec env PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'PGAPPNAME=probe exec env PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'PGAPPNAME=probe command env PGPASSWORD=$FROM_PRIVATE_SOURCE psql' \
  'if PGPASSWORD=$FROM_PRIVATE_SOURCE psql; then :; fi' \
  'if PGAPPNAME=probe command env PGPASSWORD=$FROM_PRIVATE_SOURCE psql; then :; fi' \
  'if ! PGPASSWORD=$FROM_PRIVATE_SOURCE psql; then :; fi' \
  'while PGPASSWORD=$FROM_PRIVATE_SOURCE psql; do :; done' \
  > "$scratch/worktree/nested/clean-prefixed-run.sh"
printf '%s\n' '#!/bin/sh' 'export PGPASSWORD="${FROM_PRIVATE_SOURCE}"' \
  'export PGPASSWORD=${FROM_PRIVATE_SOURCE}' \
  > "$scratch/worktree/nested/clean-braced-run.sh"
printf '%s\n' "content='PGAPPNAME=probe PGPASSWORD=different_synthetic psql'" \
  "content='if PGPASSWORD=different_synthetic psql; then :; fi'" \
  > "$scratch/worktree/nested/quoted-fixture.sh"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
for name in clean-conninfo.txt clean-run.sh clean-env-run.sh clean-prefixed-run.sh \
  clean-braced-run.sh quoted-fixture.sh; do
  python3 "$scan" --old-url-file "$scratch/old-url" \
    --carrier "$scratch/worktree/nested/$name" > "$scratch/scan-result"
done
rm "$scratch/worktree/nested/clean-conninfo.txt" "$scratch/worktree/nested/clean-run.sh" \
  "$scratch/worktree/nested/clean-env-run.sh" \
  "$scratch/worktree/nested/clean-prefixed-run.sh" \
  "$scratch/worktree/nested/clean-braced-run.sh" \
  "$scratch/worktree/nested/quoted-fixture.sh"
printf '%s\n' 'region:2024:metric:dimension:value' > "$scratch/worktree/nested/metrics.txt"
chmod 0644 "$scratch/worktree/nested/metrics.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not fail closed on an ambiguous five-field record' >&2
  exit 1
fi
grep -q 'reasons=libpq-passfile-entry' "$scratch/scan-result"
rm "$scratch/worktree/nested/metrics.txt"
for service_file in pg_service.conf .pg_service.conf; do
  printf '[synthetic]\nhost=127.0.0.1\npassword=different_synthetic\n' \
    > "$scratch/worktree/$service_file"
  if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
    > "$scratch/scan-result"; then
    echo "Copy scan did not reject $service_file password" >&2
    exit 1
  fi
  grep -q 'reasons=libpq-service-credential' "$scratch/scan-result"
  rm "$scratch/worktree/$service_file"
done
printf '[synthetic]\nhost=127.0.0.1\npassword=different_synthetic\n' \
  > "$scratch/worktree/custom-service.ini"
chmod 0600 "$scratch/worktree/custom-service.ini"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result" 2>&1; then
  echo 'Copy scan did not reject a custom-named worktree service file' >&2
  exit 1
fi
grep -q 'reasons=libpq-service-credential' "$scratch/scan-result"
if grep -q 'different_synthetic' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
mv "$scratch/worktree/custom-service.ini" "$scratch/custom-service.ini"
printf '[synthetic]\npassfile=/synthetic/private/passfile\n' \
  > "$scratch/custom-service.ini"
if python3 "$scan" --old-url-file "$scratch/old-url" --carrier "$scratch/custom-service.ini" \
  > "$scratch/scan-result" 2>&1; then
  echo 'Copy scan did not reject an explicit custom-named service file' >&2
  exit 1
fi
grep -q 'reasons=libpq-service-credential' "$scratch/scan-result"
if grep -q '/synthetic/private/passfile' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
printf '[synthetic]\nhost=127.0.0.1\nuser=new_agent\n' \
  > "$scratch/custom-service.ini"
python3 "$scan" --old-url-file "$scratch/old-url" --carrier "$scratch/custom-service.ini" \
  > "$scratch/scan-result"
rm "$scratch/custom-service.ini"
printf '%s\n' '127.0.0.1:5432:synthetic:new_agent:different_synthetic' \
  > "$scratch/worktree/credentials"
chmod 0600 "$scratch/worktree/credentials"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a custom-named worktree passfile' >&2
  exit 1
fi
grep -q 'reasons=libpq-passfile-entry' "$scratch/scan-result"
if grep -q 'different_synthetic' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
mv "$scratch/worktree/credentials" "$scratch/custom-passfile"
printf '%s\n' '*:*:*:new_agent:different\:synthetic' > "$scratch/custom-passfile"
if python3 "$scan" --old-url-file "$scratch/old-url" --carrier "$scratch/custom-passfile" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject an explicit custom-named passfile' >&2
  exit 1
fi
grep -q 'reasons=libpq-passfile-entry' "$scratch/scan-result"
if grep -q 'different' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
rm "$scratch/custom-passfile"
printf '%s\n' 'host:notaport:db:user:harmless' > "$scratch/custom-carrier"
python3 "$scan" --old-url-file "$scratch/old-url" --carrier "$scratch/custom-carrier" \
  > "$scratch/scan-result"
rm "$scratch/custom-carrier"
printf '[synthetic]\npassfile=/synthetic/private/passfile\n' \
  > "$scratch/worktree/pg_service.conf"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a libpq passfile reference in a service file' >&2
  exit 1
fi
grep -q 'reasons=libpq-service-credential' "$scratch/scan-result"
rm "$scratch/worktree/pg_service.conf"
for passfile in .pgpass pgpass.conf; do
  printf '%s\n' '127.0.0.1:5432:synthetic:new_agent:different_synthetic' \
    > "$scratch/worktree/$passfile"
  chmod 0600 "$scratch/worktree/$passfile"
  if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
    > "$scratch/scan-result"; then
    echo "Copy scan did not reject $passfile credential" >&2
    exit 1
  fi
  grep -q 'reasons=libpq-passfile-entry' "$scratch/scan-result"
  if grep -q 'different_synthetic' "$scratch/scan-result"; then
    echo 'Copy scan printed synthetic credential material' >&2
    exit 1
  fi
  rm "$scratch/worktree/$passfile"
done
printf '%s\n' 'PGAPPNAME=synthetic' > "$scratch/worktree/.env.local"
printf '[synthetic]\nhost=127.0.0.1\nuser=new_agent\n' \
  > "$scratch/worktree/pg_service.conf"
printf '%s\n' '# no credential entry' > "$scratch/worktree/.pgpass"
chmod 0600 "$scratch/worktree/.pgpass"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
rm "$scratch/worktree/.env.local" "$scratch/worktree/pg_service.conf" "$scratch/worktree/.pgpass"
printf '%s\n' 'postgres://new_agent@127.0.0.1/synthetic?pass%77ord=different_synthetic' \
  > "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a percent-encoded query-parameter password' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
printf '%s\n' 'no credential here' > "$scratch/worktree/nested/notes.txt"
# Place the URL prefix across the 1 MiB read boundary and the @ after a
# password longer than one chunk; neither split may bypass the scanner.
head -c 1048570 /dev/zero > "$scratch/worktree/nested/large.bin"
printf 'postgres://new_agent:' >> "$scratch/worktree/nested/large.bin"
head -c 1048580 /dev/zero | tr '\000' 'x' >> "$scratch/worktree/nested/large.bin"
printf '@127.0.0.1/synthetic\n' >> "$scratch/worktree/nested/large.bin"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a chunk-spanning worktree credential' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
rm "$scratch/worktree/nested/large.bin"
cp "$scratch/old-url" "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a worktree credential copy' >&2
  exit 1
fi
grep -q 'reasons=old-url-copy' "$scratch/scan-result"
mv "$scratch/worktree/nested/notes.txt" "$scratch/outside-secret"
ln -s "$scratch/outside-secret" "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject an agent-readable symlink to an external credential copy' >&2
  exit 1
fi
grep -q '^SYMLINK ' "$scratch/scan-result"
rm "$scratch/worktree/nested/notes.txt"
ln -s "$scratch" "$scratch/worktree/nested/external-directory"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a symlinked directory outside the worktree' >&2
  exit 1
fi
grep -q '^SYMLINK ' "$scratch/scan-result"
echo 'Worktree copy scan assertions passed: clean tree, new DSN, nested-prefix password, .env.local, libpq env/service/passfile, conninfo (including client_encoding) and shell (including control words, leading assignments, env options, command/exec env, defaults and command substitution) password in worktree and explicit carrier, custom service and passfile in worktree and explicit carrier, ambiguous five-field record fail closed, safe libpq carriers, query password, encoded query key, adjacent URL, nested query URL, clean adjacent URLs, literal query ?, chunk-spanning DSN, old copy, external file symlink, external directory symlink'
