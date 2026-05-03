#!/usr/bin/env bash
set -euo pipefail

DEPLOY_BASE="$PWD"

usage() {
  cat <<'USAGE'
Usage: ./deploy [profile] [options]

Profiles: local-no-auth | local-auth | private | public

Generates a Paperclip deployment in the current directory.

Options:
  --profile <name>              Same as positional profile
  --dir <path>                  Output directory (default: current directory)
  --port <port>                 Host port (default 3100)
  --bind-host <addr>            127.0.0.1 or 0.0.0.0
  --public-url <url>            Browser URL
  --allowed-hostnames <csv>     Extra hostnames
  --image <image:tag>           Paperclip image
  --admin-email <email>         First admin email
  --admin-name <name>           First admin display name
  --admin-password <pass>       First admin password (random when omitted)
  --no-auto-admin               Generate bootstrap invite only
  --no-start                    Generate files but do not start
  --no-open                     Do not open browser
  --force                       Overwrite existing deployment files in the target directory
  -h, --help                    Show this help
USAGE
}

info() {
  printf '[paperclip] %s\n' "$*"
}

die() {
  printf '[paperclip] Error: %s\n' "$*" >&2
  exit 1
}

random_hex() {
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

prompt_value() {
  local label="$1"
  local default_value="$2"
  local value
  if [ ! -t 0 ]; then
    printf '%s' "$default_value"
    return
  fi
  if [ -n "$default_value" ]; then
    read -r -p "$label [$default_value]: " value </dev/tty
    printf '%s' "${value:-$default_value}"
  else
    read -r -p "$label: " value </dev/tty
    printf '%s' "$value"
  fi
}

choose_profile() {
  if [ ! -t 0 ]; then
    die "profile is required in non-interactive mode"
  fi

  cat >&2 <<'MENU'
Select Paperclip deployment profile:
  1) local-no-auth  - trusted local mode, no sign-in
  2) local-auth     - local authenticated mode with admin account
  3) private        - authenticated, intended for LAN/VPN
  4) public         - authenticated, intended for the internet (behind reverse proxy)
MENU
  local choice
  read -r -p "Profile [2]: " choice </dev/tty
  case "${choice:-2}" in
    1|local-no-auth) printf 'local-no-auth' ;;
    2|local-auth) printf 'local-auth' ;;
    3|private) printf 'private' ;;
    4|public) printf 'public' ;;
    *) die "unknown profile choice: $choice" ;;
  esac
}

choose_bind_host() {
  local profile="$1"
  local default_choice
  case "$profile" in
    local-no-auth|local-auth) default_choice="1" ;;
    *) default_choice="2" ;;
  esac
  if [ ! -t 0 ]; then
    case "$default_choice" in
      1) printf '127.0.0.1' ;;
      *) printf '0.0.0.0' ;;
    esac
    return
  fi
  cat >&2 <<'MENU'
Select host port binding:
  1) 127.0.0.1  - loopback only (behind a reverse proxy, or local-only)
  2) 0.0.0.0    - all interfaces (LAN or internet directly)
MENU
  local choice
  read -r -p "Binding [$default_choice]: " choice </dev/tty
  case "${choice:-$default_choice}" in
    1|127.0.0.1|loopback) printf '127.0.0.1' ;;
    2|0.0.0.0|all) printf '0.0.0.0' ;;
    *) die "unknown binding choice: $choice" ;;
  esac
}

confirm_continue() {
  if [ ! -t 0 ]; then
    return
  fi
  local answer
  read -r -p "$1 [Y/n]: " answer </dev/tty
  case "${answer:-y}" in
    y|Y|yes|YES) return 0 ;;
    *) die "Cancelled" ;;
  esac
}

normalize_profile() {
  case "$1" in
    local-no-auth|no-auth|trusted-local|local_trusted) printf 'local-no-auth' ;;
    local-auth|auth-local|authenticated-local) printf 'local-auth' ;;
    private|private-auth|lan|tailnet) printf 'private' ;;
    public|public-auth) printf 'public' ;;
    *) die "unknown profile: $1" ;;
  esac
}

url_hostname() {
  local raw="$1"
  local without_scheme="${raw#*://}"
  local host_port="${without_scheme%%/*}"
  local host="${host_port%%:*}"
  printf '%s' "$host"
}

merge_csv() {
  local existing="$1"
  local addition="$2"
  if [ -z "$addition" ]; then
    printf '%s' "$existing"
  elif [ -z "$existing" ]; then
    printf '%s' "$addition"
  else
    printf '%s,%s' "$existing" "$addition"
  fi
}

read_env_value() {
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    return 0
  fi
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    die "Docker Compose was not found. Install Docker Desktop or docker compose."
  fi
}

open_url() {
  local url="$1"
  if [ "${NO_OPEN:-0}" = "1" ]; then
    return
  fi
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

PROFILE=""
DEPLOY_DIR=""
HOST_PORT="3100"
BIND_HOST=""
PUBLIC_URL=""
ALLOWED_HOSTNAMES=""
IMAGE="ghcr.io/paperclipai/paperclip:latest"
ADMIN_EMAIL=""
ADMIN_NAME="Paperclip Admin"
ADMIN_PASSWORD=""
AUTO_ADMIN="true"
START_CONTAINERS="true"
NO_OPEN="0"
FORCE="false"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --dir)
      DEPLOY_DIR="${2:-}"
      shift 2
      ;;
    --port)
      HOST_PORT="${2:-}"
      shift 2
      ;;
    --bind-host)
      BIND_HOST="${2:-}"
      shift 2
      ;;
    --public-url)
      PUBLIC_URL="${2:-}"
      shift 2
      ;;
    --allowed-hostnames)
      ALLOWED_HOSTNAMES="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --admin-email)
      ADMIN_EMAIL="${2:-}"
      shift 2
      ;;
    --admin-name)
      ADMIN_NAME="${2:-}"
      shift 2
      ;;
    --admin-password)
      ADMIN_PASSWORD="${2:-}"
      shift 2
      ;;
    --no-auto-admin)
      AUTO_ADMIN="false"
      shift
      ;;
    --no-start)
      START_CONTAINERS="false"
      shift
      ;;
    --no-open)
      NO_OPEN="1"
      shift
      ;;
    --force)
      FORCE="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      die "unknown option: $1"
      ;;
    *)
      if [ -n "$PROFILE" ]; then
        die "unexpected argument: $1"
      fi
      PROFILE="$1"
      shift
      ;;
  esac
done

if [ -z "$PROFILE" ]; then
  PROFILE="$(choose_profile)"
fi
PROFILE="$(normalize_profile "$PROFILE")"

if ! [[ "$HOST_PORT" =~ ^[0-9]+$ ]] || [ "$HOST_PORT" -lt 1 ] || [ "$HOST_PORT" -gt 65535 ]; then
  die "--port must be an integer between 1 and 65535"
fi

case "$PROFILE" in
  local-no-auth)
    DEPLOYMENT_MODE="local_trusted"
    DEPLOYMENT_EXPOSURE="private"
    AUTO_ADMIN="false"
    PUBLIC_URL="${PUBLIC_URL:-http://localhost:$HOST_PORT}"
    ALLOWED_HOSTNAMES="$(merge_csv "$ALLOWED_HOSTNAMES" "localhost,127.0.0.1")"
    ;;
  local-auth)
    DEPLOYMENT_MODE="authenticated"
    DEPLOYMENT_EXPOSURE="private"
    PUBLIC_URL="${PUBLIC_URL:-http://localhost:$HOST_PORT}"
    ALLOWED_HOSTNAMES="$(merge_csv "$ALLOWED_HOSTNAMES" "localhost,127.0.0.1")"
    ;;
  private)
    DEPLOYMENT_MODE="authenticated"
    DEPLOYMENT_EXPOSURE="private"
    PUBLIC_URL="${PUBLIC_URL:-$(prompt_value "Public/browser URL" "http://localhost:$HOST_PORT")}"
    ALLOWED_HOSTNAMES="$(merge_csv "$ALLOWED_HOSTNAMES" "$(url_hostname "$PUBLIC_URL")")"
    ;;
  public)
    DEPLOYMENT_MODE="authenticated"
    DEPLOYMENT_EXPOSURE="public"
    PUBLIC_URL="${PUBLIC_URL:-$(prompt_value "Public URL, for example https://paperclip.example.com" "")}"
    [ -n "$PUBLIC_URL" ] || die "--public-url is required for public profile"
    ALLOWED_HOSTNAMES="$(merge_csv "$ALLOWED_HOSTNAMES" "$(url_hostname "$PUBLIC_URL")")"
    ;;
esac

if [ "$DEPLOYMENT_MODE" = "authenticated" ]; then
  ALLOWED_HOSTNAMES="$(merge_csv "$ALLOWED_HOSTNAMES" "paperclip")"
fi

if [ -z "$BIND_HOST" ]; then
  BIND_HOST="$(choose_bind_host "$PROFILE")"
fi
if [[ ! "$BIND_HOST" =~ ^[0-9.]+$ ]] && [[ ! "$BIND_HOST" =~ ^\[?[0-9a-fA-F:]+\]?$ ]]; then
  die "--bind-host must be an IPv4 or IPv6 address"
fi

if [ "$DEPLOYMENT_MODE" = "authenticated" ]; then
  ADMIN_EMAIL="${ADMIN_EMAIL:-$(prompt_value "Admin email" "admin@paperclip.local")}"
  ADMIN_NAME="${ADMIN_NAME:-Paperclip Admin}"
fi

PAPERCLIP_BIND_MODE="lan"
if [ "$DEPLOYMENT_MODE" = "local_trusted" ]; then
  PAPERCLIP_BIND_MODE="loopback"
fi
PAPERCLIP_PORT="3100"

DEPLOY_ID="$(random_hex 4)"

if [ -z "$DEPLOY_DIR" ]; then
  DEPLOY_DIR="$DEPLOY_BASE"
fi
mkdir -p "$DEPLOY_DIR"
DEPLOY_DIR="$(cd "$DEPLOY_DIR" && pwd)"
if [ "$FORCE" != "true" ]; then
  for existing in docker-compose.yml .env manage.sh; do
    if [ -e "$DEPLOY_DIR/$existing" ]; then
      die "$DEPLOY_DIR/$existing already exists. Use --force to overwrite, or --dir for a different directory."
    fi
  done
fi

if [ -t 0 ]; then
  printf >&2 '\nReview deployment plan:\n'
  printf >&2 '  Profile      : %s\n' "$PROFILE"
  printf >&2 '  Public URL   : %s\n' "$PUBLIC_URL"
  printf >&2 '  Host port    : %s:%s -> container %s\n' "$BIND_HOST" "$HOST_PORT" "$PAPERCLIP_PORT"
  printf >&2 '  Output dir   : %s\n' "$DEPLOY_DIR"
  printf >&2 '  Image        : %s\n' "$IMAGE"
  if [ "$DEPLOYMENT_MODE" = "authenticated" ] && [ "$AUTO_ADMIN" = "true" ]; then
    printf >&2 '  Admin email  : %s\n' "$ADMIN_EMAIL"
  fi
  printf >&2 '\n'
  confirm_continue "Continue?"
fi

if [ -x "$DEPLOY_DIR/manage.sh" ]; then
  info "Tearing down previous deployment at $DEPLOY_DIR"
  (cd "$DEPLOY_DIR" && ./manage.sh reset --yes >/dev/null 2>&1) || true
fi

rm -f "$DEPLOY_DIR/docker-compose.yml" "$DEPLOY_DIR/.env" "$DEPLOY_DIR/manage.sh" "$DEPLOY_DIR/admin-credentials.txt"
rm -rf "$DEPLOY_DIR/scripts"
mkdir -p "$DEPLOY_DIR/scripts"

POSTGRES_PASSWORD="$(random_hex 24)"
BETTER_AUTH_SECRET="$(random_hex 32)"
AGENT_JWT_SECRET="$(random_hex 32)"
if [ "$DEPLOYMENT_MODE" = "authenticated" ]; then
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(random_hex 18)}"
fi
PROJECT_NAME="paperclip-$DEPLOY_ID"

cat > "$DEPLOY_DIR/.env" <<ENV
NODE_ENV=production
HOST=0.0.0.0
PORT=$PAPERCLIP_PORT
PAPERCLIP_HOME=/paperclip
PAPERCLIP_INSTANCE_ID=default
PAPERCLIP_BIND=$PAPERCLIP_BIND_MODE
PAPERCLIP_PUBLIC_URL=$PUBLIC_URL
PAPERCLIP_ALLOWED_HOSTNAMES=$ALLOWED_HOSTNAMES
BETTER_AUTH_TRUSTED_ORIGINS=$PUBLIC_URL
PAPERCLIP_DEPLOYMENT_MODE=$DEPLOYMENT_MODE
PAPERCLIP_DEPLOYMENT_EXPOSURE=$DEPLOYMENT_EXPOSURE
PAPERCLIP_AUTH_DISABLE_SIGN_UP=false
PAPERCLIP_MIGRATION_AUTO_APPLY=true
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
PAPERCLIP_AGENT_JWT_SECRET=$AGENT_JWT_SECRET
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
AUTOMATED_AUTO_ADMIN=$AUTO_ADMIN
AUTOMATED_ADMIN_EMAIL="$ADMIN_EMAIL"
AUTOMATED_ADMIN_PASSWORD="$ADMIN_PASSWORD"
AUTOMATED_ADMIN_NAME="$ADMIN_NAME"
ENV
chmod 600 "$DEPLOY_DIR/.env"

cat > "$DEPLOY_DIR/docker-compose.yml" <<COMPOSE
name: $PROJECT_NAME

services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: paperclip
      POSTGRES_DB: paperclip
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U paperclip -d paperclip"]
      interval: 2s
      timeout: 5s
      retries: 30
    volumes:
      - postgres-data:/var/lib/postgresql/data

  paperclip:
    image: $IMAGE
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "$BIND_HOST:$HOST_PORT:$PAPERCLIP_PORT"
    env_file:
      - .env
    environment:
      DATABASE_URL: postgres://paperclip:\${POSTGRES_PASSWORD}@db:5432/paperclip
    volumes:
      - paperclip-data:/paperclip
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:$PAPERCLIP_PORT/api/health >/dev/null || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s

  bootstrap:
    image: $IMAGE
    profiles: ["bootstrap"]
    depends_on:
      db:
        condition: service_healthy
      paperclip:
        condition: service_healthy
    entrypoint: ["node", "/paperclip-automated/bootstrap-admin.mjs"]
    env_file:
      - .env
    environment:
      DATABASE_URL: postgres://paperclip:\${POSTGRES_PASSWORD}@db:5432/paperclip
    volumes:
      - ./scripts:/paperclip-automated:ro
      - ./:/paperclip-output

volumes:
  postgres-data:
  paperclip-data:
COMPOSE

cat > "$DEPLOY_DIR/scripts/bootstrap-admin.mjs" <<'BOOTSTRAP'
#!/usr/bin/env node
import { spawn } from "node:child_process";
const CLI_ROOT = "/app/cli";
const LOG_PREFIX = "[paperclip]";

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logError(message) {
  console.error(`${LOG_PREFIX} ${message}`);
}

function baseUrl() {
  return (process.env.AUTOMATED_INTERNAL_URL || "http://paperclip:3100").replace(/\/+$/, "");
}

async function waitForPaperclip() {
  const deadline = Date.now() + Number(process.env.AUTOMATED_BOOTSTRAP_WAIT_MS || "180000");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl()}/api/health`, {
        headers: { accept: "application/json" },
      });
      if (res.ok) return;
    } catch {
    }
    await sleep(1000);
  }
  throw new Error("Paperclip did not become healthy before timeout");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAppModuleScript(source) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module"],
      {
        cwd: CLI_ROOT,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `child script exited with code ${code}`));
    });
    child.stdin.end(source);
  });
}

async function ensureBootstrapInvite() {
  const source = String.raw`
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { createDb, instanceUserRoles, invites } from "@paperclipai/db";

const dbUrl = process.env.DATABASE_URL;
const baseUrl = (process.env.AUTOMATED_PUBLIC_URL || process.env.PAPERCLIP_PUBLIC_URL || "http://localhost:3100").replace(/\/+$/, "");
const expiresHoursRaw = Number(process.env.AUTOMATED_BOOTSTRAP_EXPIRES_HOURS || "168");
const expiresHours = Math.max(1, Math.min(24 * 30, Number.isFinite(expiresHoursRaw) ? expiresHoursRaw : 168));
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const db = createDb(dbUrl);

try {
  const adminCount = await db
    .select({ count: count() })
    .from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, "instance_admin"))
    .then((rows) => Number(rows[0]?.count ?? 0));

  if (adminCount > 0) {
    console.log("AUTOMATED_BOOTSTRAP_JSON:" + JSON.stringify({ adminExists: true }));
  } else {
    const now = new Date();
    await db
      .update(invites)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(
        eq(invites.inviteType, "bootstrap_ceo"),
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, now),
      ));

    const token = "pcp_bootstrap_" + randomBytes(24).toString("hex");
    const created = await db
      .insert(invites)
      .values({
        inviteType: "bootstrap_ceo",
        tokenHash: hashToken(token),
        allowedJoinTypes: "human",
        expiresAt: new Date(Date.now() + expiresHours * 60 * 60 * 1000),
        invitedByUserId: "system",
      })
      .returning()
      .then((rows) => rows[0]);

    console.log("AUTOMATED_BOOTSTRAP_JSON:" + JSON.stringify({
      token,
      inviteUrl: baseUrl + "/invite/" + token,
      expiresAt: created.expiresAt.toISOString(),
    }));
  }
} finally {
  const client = db["$" + "client"];
  await client?.end?.({ timeout: 5 }).catch(() => undefined);
}
`;
  const output = await runAppModuleScript(source);
  const marker = output
    .split(/\r?\n/)
    .find((line) => line.startsWith("AUTOMATED_BOOTSTRAP_JSON:"));
  if (!marker) throw new Error("bootstrap script did not return an invite payload");
  const payload = JSON.parse(marker.slice("AUTOMATED_BOOTSTRAP_JSON:".length));
  if (payload.adminExists) {
    log("Admin account already exists");
  } else if (payload.inviteUrl) {
    log(`First-admin invite created: ${payload.inviteUrl}`);
  }
  return payload;
}

function setCookieHeader(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  }
  const raw = headers.get("set-cookie");
  return raw ? raw.split(/,(?=[^;,]+=)/).map((cookie) => cookie.split(";")[0]).join("; ") : "";
}

async function createAdminFromInvite(inviteToken) {
  if (process.env.AUTOMATED_AUTO_ADMIN !== "true") return false;
  if (!inviteToken) return false;
  const email = process.env.AUTOMATED_ADMIN_EMAIL?.trim();
  const password = process.env.AUTOMATED_ADMIN_PASSWORD?.trim();
  const name = process.env.AUTOMATED_ADMIN_NAME?.trim() || "Paperclip Admin";
  if (!email || !password) {
    log("Auto-admin requested but email or password is missing; invite left active");
    return false;
  }

  const base = baseUrl();
  const origin = new URL(process.env.AUTOMATED_PUBLIC_URL || process.env.PAPERCLIP_PUBLIC_URL || base).origin;
  const authHeaders = {
    "content-type": "application/json",
    accept: "application/json",
    origin,
  };
  let signResponse = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name, email, password }),
  });
  let responseText = await signResponse.text();
  let cookie = setCookieHeader(signResponse.headers);

  if (!signResponse.ok && /already|exist/i.test(responseText)) {
    signResponse = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ email, password }),
    });
    responseText = await signResponse.text();
    cookie = setCookieHeader(signResponse.headers);
  }

  if (!signResponse.ok || !cookie) {
    throw new Error(`admin sign-up/sign-in failed (${signResponse.status}): ${responseText}`);
  }

  const acceptResponse = await fetch(`${base}/api/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin,
      cookie,
    },
    body: JSON.stringify({ requestType: "human" }),
  });
  const acceptText = await acceptResponse.text();
  if (!acceptResponse.ok) {
    throw new Error(`admin invite acceptance failed (${acceptResponse.status}): ${acceptText}`);
  }

  log(`Admin account created: ${email}`);
  return true;
}

async function verifyAdminSignIn() {
  if (process.env.AUTOMATED_AUTO_ADMIN !== "true") return false;
  const email = process.env.AUTOMATED_ADMIN_EMAIL?.trim();
  const password = process.env.AUTOMATED_ADMIN_PASSWORD?.trim();
  if (!email || !password) return false;

  const base = baseUrl();
  const origin = new URL(process.env.AUTOMATED_PUBLIC_URL || process.env.PAPERCLIP_PUBLIC_URL || base).origin;
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin,
    },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`admin sign-in verification failed (${res.status}): ${text}`);
  }
  log(`Admin sign-in verified: ${email}`);
  return true;
}

async function writeAdminCredentials() {
  if (process.env.AUTOMATED_AUTO_ADMIN !== "true") return;
  const fs = await import("node:fs/promises");
  const url = (process.env.AUTOMATED_PUBLIC_URL || process.env.PAPERCLIP_PUBLIC_URL || "").trim();
  const email = (process.env.AUTOMATED_ADMIN_EMAIL || "").trim();
  const password = (process.env.AUTOMATED_ADMIN_PASSWORD || "").trim();
  if (!email || !password) return;
  const content = [
    "Paperclip admin account",
    "",
    `URL: ${url}`,
    `Email: ${email}`,
    `Password: ${password}`,
    "",
  ].join("\n");
  const target = "/paperclip-output/admin-credentials.txt";
  await fs.writeFile(target, content, { mode: 0o600 });
  log(`Credentials written to admin-credentials.txt`);
}

async function bootstrap() {
  log("Waiting for Paperclip to become healthy");
  await waitForPaperclip();
  log("Paperclip is healthy");

  const payload = await ensureBootstrapInvite();
  let adminReady = false;
  if (payload?.adminExists) {
    adminReady = await verifyAdminSignIn();
  } else if (payload?.token) {
    try {
      adminReady = await createAdminFromInvite(payload.token);
    } catch (err) {
      logError(`Admin creation failed: ${err?.message || err}`);
      process.exit(1);
    }
  }
  if (adminReady) await writeAdminCredentials();
}

bootstrap().catch((err) => {
  logError(`Bootstrap failed: ${err?.message || err}`);
  process.exit(1);
});
BOOTSTRAP

cat > "$DEPLOY_DIR/manage.sh" <<'MANAGE'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

read_env_value() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    printf 'Docker Compose was not found. Install Docker Desktop or docker compose.\n' >&2
    exit 1
  fi
}

usage() {
  cat <<'USAGE'
Usage: ./manage.sh [command]

Commands:
  start        Start db + paperclip; run bootstrap once if admin not yet provisioned
  stop         Stop containers
  restart      Restart paperclip
  bootstrap    Force-run the first-admin bootstrap
  logs         Follow paperclip logs
  status       Show container status
  credentials  Print admin credentials
  reset        Stop containers and delete data volumes
USAGE
}

log() {
  printf '[paperclip] %s\n' "$*"
}

disable_sign_up_after_admin() {
  [ -f admin-credentials.txt ] || return 0
  grep -q '^PAPERCLIP_AUTH_DISABLE_SIGN_UP=false$' .env || return 0
  local tmp
  tmp="$(mktemp .env.XXXXXX)"
  awk '/^PAPERCLIP_AUTH_DISABLE_SIGN_UP=/ { print "PAPERCLIP_AUTH_DISABLE_SIGN_UP=true"; next } { print }' .env > "$tmp"
  mv "$tmp" .env
  chmod 600 .env
  compose up -d --force-recreate paperclip >/dev/null
  log "Sign-up disabled after admin creation; paperclip recreated"
}

run_bootstrap() {
  local force="${1:-false}"
  local deployment_mode
  deployment_mode="$(read_env_value .env PAPERCLIP_DEPLOYMENT_MODE)"
  if [ "$deployment_mode" != "authenticated" ]; then
    return
  fi
  if [ "$force" != "true" ] && [ -f admin-credentials.txt ]; then
    log "Admin already provisioned; skipping bootstrap (run './manage.sh bootstrap' to re-run)"
    return
  fi
  rm -f admin-credentials.txt
  compose --profile bootstrap run --rm bootstrap
  if [ -f admin-credentials.txt ]; then
    log "Admin credentials saved to $(pwd)/admin-credentials.txt"
    disable_sign_up_after_admin
  fi
}

start_stack() {
  local public_url
  public_url="$(read_env_value .env PAPERCLIP_PUBLIC_URL)"
  compose up -d db paperclip
  run_bootstrap
  log "Paperclip is ready at $public_url"
}

cmd="${1:-start}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$cmd" in
  start|up)
    start_stack
    ;;
  stop|down)
    compose down
    ;;
  restart)
    compose up -d db paperclip
    compose restart paperclip
    run_bootstrap
    ;;
  bootstrap)
    run_bootstrap true
    ;;
  logs)
    compose logs -f "${1:-paperclip}"
    ;;
  status|ps)
    compose ps
    ;;
  credentials)
    if [ -f admin-credentials.txt ]; then
      cat admin-credentials.txt
    else
      printf 'admin-credentials.txt does not exist yet. Run ./manage.sh start first.\n' >&2
      exit 1
    fi
    ;;
  reset)
    if [ "${1:-}" != "--yes" ]; then
      printf 'This deletes the generated Paperclip containers and volumes for this deployment.\n'
      read -r -p 'Continue? [y/N] ' answer
      case "$answer" in
        y|Y|yes|YES) ;;
        *) printf 'Cancelled.\n'; exit 0 ;;
      esac
    fi
    compose down -v
    rm -f admin-credentials.txt
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
MANAGE
chmod +x "$DEPLOY_DIR/manage.sh"

cat > "$DEPLOY_DIR/README.md" <<README
# Paperclip — \`$PROFILE\`

- URL: <$PUBLIC_URL>
- Project: \`$PROJECT_NAME\`

\`\`\`sh
./manage.sh start         # start db + paperclip
./manage.sh credentials   # print admin login
./manage.sh logs          # follow paperclip logs
./manage.sh stop          # stop containers
./manage.sh reset --yes   # remove containers + volumes
\`\`\`

To open a shell inside the running container, connect as the \`node\` user — files under \`/paperclip\` are owned by \`node\`, so running as root will create files the app can't read/write:

\`\`\`sh
docker exec -it -u node \$(docker compose ps -q paperclip) bash
\`\`\`

Provider keys (\`OPENAI_API_KEY\`, \`ANTHROPIC_API_KEY\`, \`GEMINI_API_KEY\`) live in \`.env\`; \`./manage.sh restart\` applies changes.
README

info "Generated deployment at $DEPLOY_DIR"
info "Profile: $PROFILE | URL: $PUBLIC_URL | Bound to ${BIND_HOST}:${HOST_PORT} | Project: $PROJECT_NAME"

if [ "$START_CONTAINERS" = "true" ]; then
  info "Starting containers"
  (cd "$DEPLOY_DIR" && ./manage.sh start)
  open_url "$PUBLIC_URL"
else
  info "Skipping container start (--no-start)"
fi
