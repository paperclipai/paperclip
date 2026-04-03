#!/usr/bin/env bash
set -euo pipefail

to_shell_path() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    printf '%s\n' ""
    return 0
  fi

  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$raw"
    return 0
  fi

  if [[ "$raw" =~ ^([A-Za-z]):[\\/](.*)$ ]]; then
    local drive
    local rest
    drive="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
    rest="${BASH_REMATCH[2]}"
    rest="${rest//\\//}"
    printf '/mnt/%s/%s\n' "$drive" "$rest"
    return 0
  fi

  printf '%s\n' "$raw"
}

base_cwd_raw="${PAPERCLIP_WORKSPACE_BASE_CWD:?PAPERCLIP_WORKSPACE_BASE_CWD is required}"
worktree_cwd_raw="${PAPERCLIP_WORKSPACE_CWD:?PAPERCLIP_WORKSPACE_CWD is required}"
base_cwd="$(to_shell_path "$base_cwd_raw")"
worktree_cwd="$(to_shell_path "$worktree_cwd_raw")"
paperclip_home_raw="${PAPERCLIP_HOME:-$HOME/.paperclip}"
paperclip_instance_id="${PAPERCLIP_INSTANCE_ID:-default}"
paperclip_dir="$worktree_cwd/.paperclip"
paperclip_dir_raw="$worktree_cwd_raw/.paperclip"
worktree_config_path_raw="$paperclip_dir_raw/config.json"
worktree_env_path_raw="$paperclip_dir_raw/.env"
worktree_name="${PAPERCLIP_WORKSPACE_BRANCH:-$(basename "$worktree_cwd_raw")}"

if [[ ! -d "$base_cwd" ]]; then
  echo "Base workspace does not exist: $base_cwd_raw" >&2
  exit 1
fi

if [[ ! -d "$worktree_cwd" ]]; then
  echo "Derived worktree does not exist: $worktree_cwd_raw" >&2
  exit 1
fi

source_config_path_raw="${PAPERCLIP_CONFIG:-}"
source_config_path_shell="$(to_shell_path "$source_config_path_raw")"
if [[ -z "$source_config_path_raw" && ( -e "$base_cwd/.paperclip/config.json" || -L "$base_cwd/.paperclip/config.json" ) ]]; then
  source_config_path_raw="$base_cwd_raw/.paperclip/config.json"
  source_config_path_shell="$base_cwd/.paperclip/config.json"
fi
if [[ -z "$source_config_path_raw" ]]; then
  source_config_path_raw="$paperclip_home_raw/instances/$paperclip_instance_id/config.json"
  source_config_path_shell="$(to_shell_path "$source_config_path_raw")"
fi
source_env_path_raw="$(dirname "$source_config_path_raw")/.env"
source_env_path_shell="$(dirname "$source_config_path_shell")/.env"

mkdir -p "$paperclip_dir"

resolve_node_command() {
  if [[ "$base_cwd_raw" =~ ^[A-Za-z]:[\\/] || "$worktree_cwd_raw" =~ ^[A-Za-z]:[\\/] ]]; then
    if command -v node.exe >/dev/null 2>&1; then
      printf '%s\n' "node.exe"
      return 0
    fi
  fi

  printf '%s\n' "node"
}

run_penclip_command() {
  local command_args=("$@")
  if command -v pnpm >/dev/null 2>&1 && pnpm penclip --help >/dev/null 2>&1; then
    pnpm penclip "${command_args[@]}"
    return 0
  fi

  local base_cli_tsx_path="$base_cwd/cli/node_modules/tsx/dist/cli.mjs"
  local base_cli_entry_path="$base_cwd/cli/src/index.ts"
  local node_command
  node_command="$(resolve_node_command)"
  if command -v "$node_command" >/dev/null 2>&1 && [[ -f "$base_cli_tsx_path" ]] && [[ -f "$base_cli_entry_path" ]]; then
    "$node_command" "$base_cli_tsx_path" "$base_cli_entry_path" "${command_args[@]}"
    return 0
  fi

  if command -v penclip >/dev/null 2>&1; then
    penclip "${command_args[@]}"
    return 0
  fi

  return 1
}

run_isolated_worktree_init() {
  run_penclip_command \
    worktree \
    init \
    --force \
    --seed-mode \
    minimal \
    --name \
    "$worktree_name" \
    --from-config \
    "$source_config_path_raw"
}

write_fallback_worktree_config() {
  local node_command
  node_command="$(resolve_node_command)"
  "$node_command" \
    - \
    "$worktree_name" \
    "$paperclip_dir_raw" \
    "$source_config_path_raw" \
    "$source_env_path_raw" \
    "${PAPERCLIP_WORKTREES_DIR:-}" <<'EOF'
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
  const [, , rawWorktreeName, rawPaperclipDir, rawSourceConfigPath, rawSourceEnvPath, rawWorktreeHome] = process.argv;
  const worktreeName = nonEmpty(rawWorktreeName) ?? "worktree";
  const paperclipDir = nonEmpty(rawPaperclipDir);
  const sourceConfigPath = nonEmpty(rawSourceConfigPath);
  const sourceEnvPath = nonEmpty(rawSourceEnvPath);
  const worktreeHome = path.resolve(expandHomePrefix(nonEmpty(rawWorktreeHome) ?? "~/.paperclip-worktrees"));
  if (!paperclipDir) {
    throw new TypeError("paperclipDir is required");
  }
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

if ! run_isolated_worktree_init; then
  echo "penclip CLI not available in this workspace; writing isolated fallback config without DB seeding." >&2
  write_fallback_worktree_config
elif [[ ! -e "$(to_shell_path "$worktree_config_path_raw")" || ! -e "$(to_shell_path "$worktree_env_path_raw")" ]]; then
  echo "penclip worktree init did not materialize repo-local config; writing isolated fallback config." >&2
  write_fallback_worktree_config
fi

disable_seeded_routines() {
  local company_id="${PAPERCLIP_COMPANY_ID:-}"
  if [[ -z "$company_id" ]]; then
    echo "PAPERCLIP_COMPANY_ID not set; skipping routine disable post-step." >&2
    return 0
  fi

  if ! run_penclip_command routines disable-all --config "$worktree_config_path_raw" --company-id "$company_id"; then
    echo "penclip CLI not available in this workspace; skipping routine disable post-step." >&2
  fi
}

disable_seeded_routines

while IFS= read -r relative_path; do
  [[ -n "$relative_path" ]] || continue
  source_path="$base_cwd/$relative_path"
  target_path="$worktree_cwd/$relative_path"

  [[ -d "$source_path" ]] || continue
  [[ -e "$target_path" || -L "$target_path" ]] && continue

  mkdir -p "$(dirname "$target_path")"
  ln -s "$source_path" "$target_path"
  done < <(
  cd "$base_cwd" &&
    find . \
      -mindepth 1 \
      -maxdepth 3 \
      -type d \
      -name node_modules \
      ! -path './.git/*' \
      ! -path './.paperclip/*' \
      | sed 's#^\./##'
)
