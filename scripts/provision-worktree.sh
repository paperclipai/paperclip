#!/usr/bin/env bash
set -euo pipefail

base_cwd="${PAPERCLIP_WORKSPACE_BASE_CWD:?PAPERCLIP_WORKSPACE_BASE_CWD is required}"
worktree_cwd="${PAPERCLIP_WORKSPACE_CWD:?PAPERCLIP_WORKSPACE_CWD is required}"
paperclip_home="${PAPERCLIP_HOME:-$HOME/.paperclip}"
paperclip_instance_id="${PAPERCLIP_INSTANCE_ID:-default}"
paperclip_dir="$worktree_cwd/.paperclip"
worktree_config_path="$paperclip_dir/config.json"
worktree_env_path="$paperclip_dir/.env"
worktree_name="${PAPERCLIP_WORKSPACE_BRANCH:-$(basename "$worktree_cwd")}"

if [[ ! -d "$base_cwd" ]]; then
  echo "Base workspace does not exist: $base_cwd" >&2
  exit 1
fi

if [[ ! -d "$worktree_cwd" ]]; then
  echo "Derived worktree does not exist: $worktree_cwd" >&2
  exit 1
fi

source_config_path="${PAPERCLIP_CONFIG:-}"
if [[ -z "$source_config_path" && ( -e "$base_cwd/.paperclip/config.json" || -L "$base_cwd/.paperclip/config.json" ) ]]; then
  source_config_path="$base_cwd/.paperclip/config.json"
fi
if [[ -z "$source_config_path" ]]; then
  source_config_path="$paperclip_home/instances/$paperclip_instance_id/config.json"
fi
source_env_path="$(dirname "$source_config_path")/.env"

mkdir -p "$paperclip_dir"

run_paperclipai_command() {
  local command_args=("$@")
  if command -v pnpm >/dev/null 2>&1 && pnpm paperclipai --help >/dev/null 2>&1; then
    pnpm paperclipai "${command_args[@]}"
    return 0
  fi

  local base_cli_tsx_path="$base_cwd/cli/node_modules/tsx/dist/cli.mjs"
  local base_cli_entry_path="$base_cwd/cli/src/index.ts"
  if command -v node >/dev/null 2>&1 && [[ -f "$base_cli_tsx_path" ]] && [[ -f "$base_cli_entry_path" ]]; then
    node "$base_cli_tsx_path" "$base_cli_entry_path" "${command_args[@]}"
    return 0
  fi

  if command -v paperclipai >/dev/null 2>&1; then
    paperclipai "${command_args[@]}"
    return 0
  fi

  return 1
}

paperclipai_command_available() {
  if command -v pnpm >/dev/null 2>&1 && pnpm paperclipai --help >/dev/null 2>&1; then
    return 0
  fi

  local base_cli_tsx_path="$base_cwd/cli/node_modules/tsx/dist/cli.mjs"
  local base_cli_entry_path="$base_cwd/cli/src/index.ts"
  if command -v node >/dev/null 2>&1 && [[ -f "$base_cli_tsx_path" ]] && [[ -f "$base_cli_entry_path" ]]; then
    return 0
  fi

  if command -v paperclipai >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

run_isolated_worktree_init() {
  run_paperclipai_command \
    worktree \
    init \
    --force \
    --seed-mode \
    minimal \
    --name \
    "$worktree_name" \
    --from-config \
    "$source_config_path"
}

write_fallback_worktree_config() {
  WORKTREE_NAME="$worktree_name" \
  BASE_CWD="$base_cwd" \
  WORKTREE_CWD="$worktree_cwd" \
  PAPERCLIP_DIR="$paperclip_dir" \
  SOURCE_CONFIG_PATH="$source_config_path" \
  SOURCE_ENV_PATH="$source_env_path" \
  PAPERCLIP_WORKTREES_DIR="${PAPERCLIP_WORKTREES_DIR:-}" \
  node <<'EOF'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

function expandHomePrefix(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sanitizeInstanceId(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  const normalized = trimmed
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized || "worktree";
}

function parseEnvFile(contents) {
  const entries = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (!value) {
      entries[key] = "";
      continue;
    }
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      entries[key] = value.slice(1, -1);
      continue;
    }
    entries[key] = value.replace(/\s+#.*$/, "").trim();
  }
  return entries;
}

async function findAvailablePort(preferredPort, reserved = new Set()) {
  const startPort = Number.isFinite(preferredPort) && preferredPort > 0 ? Math.trunc(preferredPort) : 0;
  if (startPort > 0) {
    for (let port = startPort; port < startPort + 100; port += 1) {
      if (reserved.has(port)) continue;
      const available = await new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => {
          server.close(() => resolve(true));
        });
      });
      if (available) return port;
    }
  }

  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function isLoopbackHost(hostname) {
  const value = hostname.trim().toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function rewriteLocalUrlPort(rawUrl, port) {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    if (!isLoopbackHost(parsed.hostname)) return rawUrl;
    parsed.port = String(port);
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function resolveRuntimeLikePath(value, configPath) {
  const expanded = expandHomePrefix(value);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(path.dirname(configPath), expanded);
}

async function main() {
  const worktreeName = process.env.WORKTREE_NAME;
  const paperclipDir = process.env.PAPERCLIP_DIR;
  const sourceConfigPath = process.env.SOURCE_CONFIG_PATH;
  const sourceEnvPath = process.env.SOURCE_ENV_PATH;
  const worktreeHome = path.resolve(expandHomePrefix(nonEmpty(process.env.PAPERCLIP_WORKTREES_DIR) ?? "~/.paperclip-worktrees"));
  const instanceId = sanitizeInstanceId(worktreeName);
  const instanceRoot = path.resolve(worktreeHome, "instances", instanceId);
  const configPath = path.resolve(paperclipDir, "config.json");
  const envPath = path.resolve(paperclipDir, ".env");

  let sourceConfig = null;
  if (sourceConfigPath && fs.existsSync(sourceConfigPath)) {
    sourceConfig = JSON.parse(fs.readFileSync(sourceConfigPath, "utf8"));
  }

  const sourceEnvEntries =
    sourceEnvPath && fs.existsSync(sourceEnvPath)
      ? parseEnvFile(fs.readFileSync(sourceEnvPath, "utf8"))
      : {};

  const preferredServerPort = Number(sourceConfig?.server?.port ?? 3101) + 1;
  const serverPort = await findAvailablePort(preferredServerPort);
  const preferredDbPort = Number(sourceConfig?.database?.embeddedPostgresPort ?? 54329) + 1;
  const databasePort = await findAvailablePort(preferredDbPort, new Set([serverPort]));

  fs.rmSync(configPath, { force: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(instanceRoot, { recursive: true });

  const authPublicBaseUrl = rewriteLocalUrlPort(sourceConfig?.auth?.publicBaseUrl, serverPort);
  const targetConfig = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "configure",
    },
    ...(sourceConfig?.llm ? { llm: sourceConfig.llm } : {}),
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.resolve(instanceRoot, "db"),
      embeddedPostgresPort: databasePort,
      backup: {
        enabled: sourceConfig?.database?.backup?.enabled ?? true,
        intervalMinutes: sourceConfig?.database?.backup?.intervalMinutes ?? 60,
        retentionDays: sourceConfig?.database?.backup?.retentionDays ?? 30,
        dir: path.resolve(instanceRoot, "data", "backups"),
      },
    },
    logging: {
      mode: sourceConfig?.logging?.mode ?? "file",
      logDir: path.resolve(instanceRoot, "logs"),
    },
    server: {
      deploymentMode: sourceConfig?.server?.deploymentMode ?? "local_trusted",
      exposure: sourceConfig?.server?.exposure ?? "private",
      ...(sourceConfig?.server?.bind ? { bind: sourceConfig.server.bind } : {}),
      ...(sourceConfig?.server?.customBindHost ? { customBindHost: sourceConfig.server.customBindHost } : {}),
      host: sourceConfig?.server?.host ?? "127.0.0.1",
      port: serverPort,
      allowedHostnames: sourceConfig?.server?.allowedHostnames ?? [],
      serveUi: sourceConfig?.server?.serveUi ?? true,
    },
    auth: {
      baseUrlMode: sourceConfig?.auth?.baseUrlMode ?? "auto",
      ...(authPublicBaseUrl ? { publicBaseUrl: authPublicBaseUrl } : {}),
      disableSignUp: sourceConfig?.auth?.disableSignUp ?? false,
    },
    storage: {
      provider: sourceConfig?.storage?.provider ?? "local_disk",
      localDisk: {
        baseDir: path.resolve(instanceRoot, "data", "storage"),
      },
      s3: {
        bucket: sourceConfig?.storage?.s3?.bucket ?? "paperclip",
        region: sourceConfig?.storage?.s3?.region ?? "us-east-1",
        endpoint: sourceConfig?.storage?.s3?.endpoint,
        prefix: sourceConfig?.storage?.s3?.prefix ?? "",
        forcePathStyle: sourceConfig?.storage?.s3?.forcePathStyle ?? false,
      },
    },
    secrets: {
      provider: sourceConfig?.secrets?.provider ?? "local_encrypted",
      strictMode: sourceConfig?.secrets?.strictMode ?? false,
      localEncrypted: {
        keyFilePath: path.resolve(instanceRoot, "secrets", "master.key"),
      },
    },
  };

  fs.writeFileSync(configPath, `${JSON.stringify(targetConfig, null, 2)}\n`, { mode: 0o600 });

  const inlineMasterKey = nonEmpty(sourceEnvEntries.PAPERCLIP_SECRETS_MASTER_KEY);
  if (inlineMasterKey) {
    fs.mkdirSync(path.resolve(instanceRoot, "secrets"), { recursive: true });
    fs.writeFileSync(targetConfig.secrets.localEncrypted.keyFilePath, inlineMasterKey, {
      encoding: "utf8",
      mode: 0o600,
    });
  } else {
    const sourceKeyFilePath = nonEmpty(sourceEnvEntries.PAPERCLIP_SECRETS_MASTER_KEY_FILE)
      ? resolveRuntimeLikePath(sourceEnvEntries.PAPERCLIP_SECRETS_MASTER_KEY_FILE, sourceConfigPath)
      : nonEmpty(sourceConfig?.secrets?.localEncrypted?.keyFilePath)
        ? resolveRuntimeLikePath(sourceConfig.secrets.localEncrypted.keyFilePath, sourceConfigPath)
        : null;

    if (sourceKeyFilePath && fs.existsSync(sourceKeyFilePath)) {
      fs.mkdirSync(path.resolve(instanceRoot, "secrets"), { recursive: true });
      fs.copyFileSync(sourceKeyFilePath, targetConfig.secrets.localEncrypted.keyFilePath);
      fs.chmodSync(targetConfig.secrets.localEncrypted.keyFilePath, 0o600);
    }
  }

  const envLines = [
    "PAPERCLIP_HOME=" + JSON.stringify(worktreeHome),
    "PAPERCLIP_INSTANCE_ID=" + JSON.stringify(instanceId),
    "PAPERCLIP_CONFIG=" + JSON.stringify(configPath),
    "PAPERCLIP_CONTEXT=" + JSON.stringify(path.resolve(worktreeHome, "context.json")),
    "PAPERCLIP_IN_WORKTREE=true",
    "PAPERCLIP_WORKTREE_NAME=" + JSON.stringify(worktreeName),
  ];

  const agentJwtSecret = nonEmpty(sourceEnvEntries.PAPERCLIP_AGENT_JWT_SECRET);
  if (agentJwtSecret) {
    envLines.push("PAPERCLIP_AGENT_JWT_SECRET=" + JSON.stringify(agentJwtSecret));
  }

  fs.writeFileSync(envPath, `${envLines.join("\n")}\n`, { mode: 0o600 });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
EOF
}

if paperclipai_command_available; then
  run_isolated_worktree_init
else
  echo "paperclipai CLI not available in this workspace; writing isolated fallback config without DB seeding." >&2
  write_fallback_worktree_config
fi

list_base_node_modules_paths() {
  cd "$base_cwd" &&
    find . \
      -mindepth 1 \
      -maxdepth 4 \
      -type d \
      -name node_modules \
      ! -path './.git/*' \
      ! -path './.paperclip/*' \
      | sed 's#^\./##'
}
if [[ -f "$worktree_cwd/package.json" && -f "$worktree_cwd/pnpm-lock.yaml" ]]; then
  needs_install=0

  while IFS= read -r relative_path; do
    [[ -n "$relative_path" ]] || continue
    target_path="$worktree_cwd/$relative_path"

    if [[ -L "$target_path" || ! -e "$target_path" ]]; then
      needs_install=1
      break
    fi
  done < <(list_base_node_modules_paths)

  if [[ "$needs_install" -eq 1 ]]; then
    backup_suffix=".paperclip-backup-${BASHPID:-$$}"
    moved_symlink_paths=()

    while IFS= read -r relative_path; do
      [[ -n "$relative_path" ]] || continue
      target_path="$worktree_cwd/$relative_path"
      if [[ -L "$target_path" ]]; then
        backup_path="${target_path}${backup_suffix}"
        rm -rf "$backup_path"
        mv "$target_path" "$backup_path"
        moved_symlink_paths+=("$relative_path")
      fi
    done < <(list_base_node_modules_paths)

    restore_moved_symlinks() {
      local relative_path target_path backup_path
      [[ ${#moved_symlink_paths[@]} -gt 0 ]] || return 0
      for relative_path in "${moved_symlink_paths[@]}"; do
        target_path="$worktree_cwd/$relative_path"
        backup_path="${target_path}${backup_suffix}"
        [[ -L "$backup_path" ]] || continue
        rm -rf "$target_path"
        mv "$backup_path" "$target_path"
      done
    }

    cleanup_moved_symlinks() {
      local relative_path target_path backup_path
      [[ ${#moved_symlink_paths[@]} -gt 0 ]] || return 0
      for relative_path in "${moved_symlink_paths[@]}"; do
        target_path="$worktree_cwd/$relative_path"
        backup_path="${target_path}${backup_suffix}"
        [[ -L "$backup_path" ]] && rm "$backup_path"
      done
    }

    run_pnpm_install() {
      local stdout_path stderr_path
      stdout_path="$(mktemp)"
      stderr_path="$(mktemp)"

      if (
        cd "$worktree_cwd"
        pnpm install "$@"
      ) >"$stdout_path" 2>"$stderr_path"; then
        cat "$stdout_path"
        cat "$stderr_path" >&2
        rm -f "$stdout_path" "$stderr_path"
        return 0
      fi

      local exit_code=$?
      cat "$stdout_path"
      cat "$stderr_path" >&2
      if grep -q "ERR_PNPM_OUTDATED_LOCKFILE" "$stdout_path" "$stderr_path"; then
        rm -f "$stdout_path" "$stderr_path"
        return 90
      fi

      rm -f "$stdout_path" "$stderr_path"
      return "$exit_code"
    }

    if run_pnpm_install --frozen-lockfile; then
      :
    else
      install_exit_code=$?
      if [[ "$install_exit_code" -eq 90 ]]; then
        echo "pnpm-lock.yaml is out of date in this execution workspace; retrying install without --frozen-lockfile." >&2
        run_pnpm_install --no-frozen-lockfile || {
          restore_moved_symlinks
          exit 1
        }
      else
        restore_moved_symlinks
        exit "$install_exit_code"
      fi
    fi

    cleanup_moved_symlinks
  fi

  exit 0
fi

while IFS= read -r relative_path; do
  [[ -n "$relative_path" ]] || continue
  source_path="$base_cwd/$relative_path"
  target_path="$worktree_cwd/$relative_path"

  [[ -d "$source_path" ]] || continue
  [[ -e "$target_path" || -L "$target_path" ]] && continue

  mkdir -p "$(dirname "$target_path")"
  ln -s "$source_path" "$target_path"
done < <(
  list_base_node_modules_paths
)
