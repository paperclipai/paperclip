# pii-proxy Public Release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den intern entwickelten DPO-Gate (paperclip-dpo + paperclip-dpo-service) als eigenständiges Open-Source-Projekt `pii-proxy` unter `whitestag-ai/pii-proxy` auf GitHub releasen — TypeScript-Library + HTTP-Server, Docker-Image, Python-Client, CI/CD, volle Doku, plus separates Paperclip-Plugin-Repo.

**Architecture:** Neuer Monorepo `whitestag-ai/pii-proxy` mit pnpm-Workspaces. Zwei TS-Packages (`@whitestag-ai/pii-proxy-core` Library, `@whitestag-ai/pii-proxy-server` Fastify-Service) und ein Python-Package `pii_proxy`. Docker-Image auf `ghcr.io/whitestag-ai/pii-proxy`. Plus ein zweiter kleiner Repo `whitestag-ai/paperclip-plugin-pii-proxy` mit dem Paperclip-Adapter. Fresh-Git-Start (kein Historie-Übertrag aus dem Paperclip-Monorepo), Apache-2.0-Lizenz.

**Tech Stack:** TypeScript, pnpm, Fastify 4, Zod, better-sqlite3, keytar, Python 3.11+ + httpx, Docker, GitHub Actions, changesets, pytest, vitest, Apache-2.0.

**Reference:** Das Release baut auf dem DPO-Gate-Wiring auf, der im Paperclip-Repo unter `docs/superpowers/specs/2026-04-21-dpo-gate-wiring-design.md` und `docs/superpowers/plans/2026-04-21-dpo-gate-wiring.md` dokumentiert ist.

---

## Entscheidungen (aus Brainstorming)

| Frage | Antwort |
|---|---|
| Release-Form | Standalone-Repo + separates Paperclip-Plugin |
| Maintainer | `whitestag-ai` GitHub-Org (existiert) |
| WHITESTAG-Sichtbarkeit | b2 — zurückhaltend (nur `LICENSE`-Copyright + `package.json author`, kein dominantes Branding) |
| Projekt-Name | `pii-proxy` |
| Scope | d3 — voll (TS-Library + Server + Docker + CI + Python-Client + Paperclip-Plugin + Blog-Ankündigung) |
| Lizenz | Apache-2.0 |
| Git-Historie | Fresh `git init` mit einem „initial release"-Commit |

## Arbeitsverzeichnisse

Neuer Arbeitsordner (außerhalb des Paperclip-Repos, um Verwechslung auszuschließen):

```
~/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/
├── pii-proxy/                         ← Haupt-Repo (whitestag-ai/pii-proxy)
└── paperclip-plugin-pii-proxy/        ← Plugin-Repo (whitestag-ai/paperclip-plugin-pii-proxy)
```

Quelle für Code-Migration: aktueller Paperclip-Worktree unter `~/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip/paperclip-dpo/` und `.../paperclip-dpo-service/`.

---

## Naming-Map (Rename-Tabelle)

Referenz für alle Code-Migrationen:

| Alt (paperclip-dpo) | Neu (pii-proxy) |
|---|---|
| Package `paperclip-dpo` | `@whitestag-ai/pii-proxy-core` |
| Package `paperclip-dpo-service` | `@whitestag-ai/pii-proxy-server` |
| Interface `Dpo` | `PiiProxy` |
| `createDpo(...)` | `createPiiProxy(...)` |
| `DpoOptions` | `PiiProxyOptions` |
| `createDpoClient(...)` | `createPiiProxyClient(...)` |
| `DpoClient` | `PiiProxyClient` |
| `DpoClientOptions` | `PiiProxyClientOptions` |
| `DpoUnavailableError` | `ClassifierUnavailableError` |
| `safeExternalLlm` | `safeExternalCall` |
| Env: `DPO_SHARED_KEY` | `PII_PROXY_SHARED_KEY` |
| Env: `DPO_PORT` | `PII_PROXY_PORT` |
| Env: `DPO_BIND` | `PII_PROXY_BIND` |
| Env: `DPO_MAPPING_DB` | `PII_PROXY_MAPPING_DB` |
| Env: `DPO_AUDIT_DIR` | `PII_PROXY_AUDIT_DIR` |
| Env: `DPO_CLASSIFIER_URL` | `PII_PROXY_CLASSIFIER_URL` |
| Env: `DPO_CLASSIFIER_MODEL` | `PII_PROXY_CLASSIFIER_MODEL` |
| Env: `DPO_CLASSIFIER_TIMEOUT_MS` | `PII_PROXY_CLASSIFIER_TIMEOUT_MS` |
| Env: `DPO_TELEGRAM_BOT_TOKEN` | `PII_PROXY_TELEGRAM_BOT_TOKEN` |
| Env: `DPO_TELEGRAM_CHAT_ID` | `PII_PROXY_TELEGRAM_CHAT_ID` |
| HTTP-Header `X-DPO-Key` | `X-PII-Proxy-Key` |
| Keychain-Service `paperclip-dpo` | `io.piiproxy` |
| Keychain-Account `mapping-store-key` | `mapping-store-key` (bleibt) |
| Plist-Label `ai.whitestag.paperclip-dpo` | `io.piiproxy.server` |
| Default-Datenpfad | `~/.pii-proxy/` (cross-platform, macOS+Linux) |

`MappingNotFoundError`, Block-Reasons (`art_9_data_detected`, `dpo_unavailable` → umbenannt in `classifier_unavailable`), Regex-Detektoren, Rules-YAML bleiben inhaltlich gleich.

---

## File-Structure — pii-proxy Repo

```
pii-proxy/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                    # build + test auf push/pr
│   │   ├── release.yml               # npm publish + docker build auf tag
│   │   └── docker.yml                # docker image nightly
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── CODEOWNERS
├── .changeset/
│   └── config.json
├── packages/
│   ├── core/                         # ex paperclip-dpo
│   │   ├── src/
│   │   ├── tests/
│   │   ├── package.json              # name: @whitestag-ai/pii-proxy-core
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── README.md
│   └── server/                       # ex paperclip-dpo-service
│       ├── src/
│       ├── tests/
│       ├── scripts/
│       ├── deploy/
│       │   ├── launchd/io.piiproxy.server.plist
│       │   ├── systemd/pii-proxy.service
│       │   └── docker-compose.yml
│       ├── Dockerfile
│       ├── package.json              # name: @whitestag-ai/pii-proxy-server
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       └── README.md
├── python/
│   ├── src/pii_proxy/
│   │   ├── __init__.py
│   │   └── client.py
│   ├── tests/
│   ├── pyproject.toml
│   └── README.md
├── docs/
│   ├── CONFIG.md                     # Env-Var-Referenz
│   ├── MODELS.md                     # Getestete Classifier-Modelle
│   ├── INTEGRATIONS.md               # n8n, LangChain, generic HTTP
│   └── ARCHITECTURE.md
├── examples/
│   ├── n8n-dpo-proxy-workflow.json   # Beispiel-Sub-Workflow
│   ├── docker-compose.yml
│   ├── langchain-example.py
│   └── curl-quickstart.sh
├── tsconfig.base.json
├── pnpm-workspace.yaml
├── package.json                      # root, private
├── .gitignore
├── .dockerignore
├── .nvmrc
├── LICENSE                           # Apache-2.0
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
└── CHANGELOG.md                      # generated by changesets
```

## File-Structure — paperclip-plugin-pii-proxy Repo

```
paperclip-plugin-pii-proxy/
├── .github/workflows/ci.yml
├── src/
│   ├── manifest.ts                   # Paperclip-Plugin-Manifest
│   ├── worker.ts                     # Plugin-Lifecycle
│   └── ui/index.tsx                  # Status-Panel im Paperclip-Dashboard
├── tests/
├── package.json                      # @whitestag-ai/paperclip-plugin-pii-proxy
├── tsconfig.json
├── LICENSE
├── README.md
└── .gitignore
```

---

## Phase 1 — Repo-Scaffold

### Task 1: Arbeitsverzeichnisse erstellen, pii-proxy Repo initialisieren

**Files:**
- Create: `~/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/pii-proxy/`

- [ ] **Step 1: Dirs anlegen**

```bash
BASE="$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource"
mkdir -p "$BASE/pii-proxy" "$BASE/paperclip-plugin-pii-proxy"
cd "$BASE/pii-proxy"
```

- [ ] **Step 2: Git init + erste Meta-Dateien**

```bash
git init
git branch -m main
```

- [ ] **Step 3: `.gitignore` erstellen**

```
node_modules/
dist/
*.log
.DS_Store
.env
.env.local
coverage/
*.tsbuildinfo
__pycache__/
.pytest_cache/
.venv/
venv/
*.egg-info/
build/
.changeset/*.md
!.changeset/config.json
!.changeset/README.md
```

- [ ] **Step 4: `.nvmrc`**

```
v22.22.0
```

- [ ] **Step 5: `LICENSE` (Apache-2.0)**

Hole die vollständige Apache-2.0-Lizenz:

```bash
curl -s https://www.apache.org/licenses/LICENSE-2.0.txt > LICENSE
```

Prüfe: `wc -l LICENSE` muss >200 Zeilen sein. Copyright-Zeile anschließend anhängen:

```
Copyright 2026 WHITESTAG.AI (Walter Schönenbröcher)
```

Die Apache-Lizenz hat einen APPENDIX-Block mit `Copyright [yyyy] [name of copyright owner]` — den durch das obige ersetzen. Achtung: die Apache-Lizenz-Textdatei ist der reine Lizenztext ohne dieses Feld. Stattdessen fügen wir am Ende einen Abschnitt hinzu:

```bash
cat >> LICENSE <<'EOF'

APPENDIX: Copyright notice
Copyright 2026 WHITESTAG.AI (Walter Schönenbröcher)
EOF
```

- [ ] **Step 6: `pnpm-workspace.yaml`**

```yaml
packages:
  - packages/*
```

- [ ] **Step 7: Root `package.json`**

```json
{
  "name": "pii-proxy-monorepo",
  "version": "0.0.0",
  "private": true,
  "description": "DSGVO-compliant anonymisation gate for LLM calls",
  "repository": {
    "type": "git",
    "url": "https://github.com/whitestag-ai/pii-proxy.git"
  },
  "homepage": "https://github.com/whitestag-ai/pii-proxy",
  "license": "Apache-2.0",
  "author": "WHITESTAG.AI <whitestagvr@gmail.com>",
  "type": "module",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "pnpm -r build && changeset publish"
  },
  "devDependencies": {
    "@changesets/cli": "^2.27.0",
    "typescript": "^5.7.0"
  },
  "packageManager": "pnpm@9.0.0"
}
```

- [ ] **Step 8: `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

- [ ] **Step 9: Init commit**

```bash
git add .
git commit -m "chore: repo scaffold with Apache-2.0 license and pnpm workspaces"
```

---

### Task 2: changesets initialisieren

**Files:**
- Create: `.changeset/config.json`
- Create: `.changeset/README.md`

- [ ] **Step 1: `changesets` installieren**

```bash
pnpm install
pnpm add -Dw @changesets/cli
pnpm changeset init
```

Dies erzeugt `.changeset/config.json` und `.changeset/README.md`.

- [ ] **Step 2: `config.json` konfigurieren**

Ersetze den Inhalt von `.changeset/config.json`:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [["@whitestag-ai/pii-proxy-core", "@whitestag-ai/pii-proxy-server"]],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

`linked` stellt sicher, dass Core und Server immer synchrone Versions-Bumps erhalten.

- [ ] **Step 3: Commit**

```bash
git add .changeset/ package.json pnpm-lock.yaml
git commit -m "chore: changesets configured, core+server linked"
```

---

## Phase 2 — Core-Package (Library)

Die Library (ex `paperclip-dpo`) wird nach `packages/core/` migriert und umbenannt. Alle Rename-Operationen entsprechen der Naming-Map oben.

### Task 3: Core-Package scaffold

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/README.md` (Stub)

- [ ] **Step 1: `packages/core/package.json`**

```json
{
  "name": "@whitestag-ai/pii-proxy-core",
  "version": "0.1.0",
  "description": "PII detection, pseudonymisation, and mapping-store library for LLM privacy gating",
  "keywords": ["gdpr", "dsgvo", "pii", "anonymisation", "pseudonymisation", "llm", "privacy"],
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./keychain": {
      "import": "./dist/keychain.js",
      "types": "./dist/keychain.d.ts"
    }
  },
  "files": ["dist", "pii-proxy-rules.default.yaml"],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "keytar": "^7.9.0",
    "yaml": "^2.6.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^25.6.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/whitestag-ai/pii-proxy.git",
    "directory": "packages/core"
  },
  "license": "Apache-2.0",
  "author": "WHITESTAG.AI <whitestagvr@gmail.com>"
}
```

- [ ] **Step 2: `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: `packages/core/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 4: `packages/core/README.md` (Stub)**

```markdown
# @whitestag-ai/pii-proxy-core

PII detection and pseudonymisation library. Used by `@whitestag-ai/pii-proxy-server` or directly from TypeScript/JavaScript code.

See the [monorepo README](../../README.md) for full documentation.
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "chore(core): scaffold @whitestag-ai/pii-proxy-core package"
```

---

### Task 4: Core src-Dateien migrieren (initial bulk-copy + rename)

**Files:**
- Copy from `paperclip-dpo/src/*` to `packages/core/src/*`
- Copy from `paperclip-dpo/tests/*` to `packages/core/tests/*`
- Copy from `paperclip-dpo/dpo-rules.default.yaml` to `packages/core/pii-proxy-rules.default.yaml`

- [ ] **Step 1: Quellcode kopieren**

```bash
SRC="$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip/paperclip-dpo"
cp -r "$SRC/src" packages/core/src
cp -r "$SRC/tests" packages/core/tests
cp "$SRC/dpo-rules.default.yaml" packages/core/pii-proxy-rules.default.yaml
```

- [ ] **Step 2: `safe-external-llm.ts` → `safe-external-call.ts`**

```bash
mv packages/core/src/safe-external-llm.ts packages/core/src/safe-external-call.ts
mv packages/core/tests/safe-external-llm.test.ts packages/core/tests/safe-external-call.test.ts
```

- [ ] **Step 3: Bulk-Rename in src und tests**

Führe diese sed-Operationen aus (macOS-kompatibel via `find` + `sed -i ''`):

```bash
cd packages/core

# Interface- und Funktionsnamen
find src tests -type f \( -name "*.ts" -o -name "*.yaml" \) -exec sed -i '' \
  -e 's/\bDpoUnavailableError\b/ClassifierUnavailableError/g' \
  -e 's/\bcreateDpo\b/createPiiProxy/g' \
  -e 's/\bDpoOptions\b/PiiProxyOptions/g' \
  -e 's/\binterface Dpo\b/interface PiiProxy/g' \
  -e 's/\btype Dpo\b/type PiiProxy/g' \
  -e 's/: Dpo\b/: PiiProxy/g' \
  -e 's/\bDpo;/PiiProxy;/g' \
  -e 's/<Dpo>/<PiiProxy>/g' \
  -e 's/\bsafeExternalLlm\b/safeExternalCall/g' \
  -e 's/\bSafeExternalLlmOptions\b/SafeExternalCallOptions/g' \
  -e 's/\bSafeExternalLlmResult\b/SafeExternalCallResult/g' \
  {} \;

# Block-Reason rename
find src tests -type f \( -name "*.ts" -o -name "*.yaml" \) -exec sed -i '' \
  -e 's/"dpo_unavailable"/"classifier_unavailable"/g' \
  -e 's/dpo_unavailable/classifier_unavailable/g' \
  {} \;

# Import-Pfade
find src tests -type f -name "*.ts" -exec sed -i '' \
  -e 's|"./safe-external-llm.js"|"./safe-external-call.js"|g' \
  -e 's|"../src/safe-external-llm.js"|"../src/safe-external-call.js"|g' \
  {} \;
```

- [ ] **Step 4: keychain.ts anpassen**

Ersetze `packages/core/src/keychain.ts` komplett durch:

```ts
import keytar from "keytar";
import { randomBytes } from "node:crypto";

const SERVICE = "io.piiproxy";
const ACCOUNT = "mapping-store-key";

export async function getOrCreateMappingKey(): Promise<Buffer> {
  const existing = await keytar.getPassword(SERVICE, ACCOUNT);
  if (existing) {
    return Buffer.from(existing, "base64");
  }
  const key = randomBytes(32);
  await keytar.setPassword(SERVICE, ACCOUNT, key.toString("base64"));
  return key;
}

export async function deleteMappingKey(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT);
}
```

- [ ] **Step 5: Rules-YAML umbenennen und Label-Hinweis**

Die Datei heißt jetzt `packages/core/pii-proxy-rules.default.yaml`. Öffne sie und suche nach einem `tenant:`-Feld — falls dort ein WHITESTAG-spezifischer Default steht (z.B. `tenant: whitestag-internal`), ersetze durch:

```yaml
tenant: default
```

- [ ] **Step 6: rules.ts an den neuen Default-YAML-Pfad anpassen**

Öffne `packages/core/src/rules.ts` — falls dort ein Dateiname `dpo-rules.default.yaml` erwähnt wird, ersetze durch `pii-proxy-rules.default.yaml`:

```bash
sed -i '' 's/dpo-rules\.default\.yaml/pii-proxy-rules.default.yaml/g' packages/core/src/rules.ts
```

- [ ] **Step 7: README in Library updaten**

Ersetze `packages/core/src`-README-Referenzen (falls vorhanden) — Library hat keine eigene README außer dem Stub aus Task 3. Skip.

- [ ] **Step 8: Client-Datei entfernen** (wir migrieren `client.ts` aus paperclip-dpo — aber dieser wird in Task 7 umbenannt)

Noch kein Delete — Client bleibt bestehen, wird in Task 7 gerenamed.

- [ ] **Step 9: Install + Build**

```bash
pnpm install
pnpm -F @whitestag-ai/pii-proxy-core build
```

Erwartung: sauberer Build.

- [ ] **Step 10: Tests laufen**

```bash
pnpm -F @whitestag-ai/pii-proxy-core test
```

Erwartung: alle Tests grün (die ca. 73 aus dem Paperclip-Setup).

- [ ] **Step 11: Commit**

```bash
git add packages/core/
git commit -m "feat(core): migrate library from paperclip-dpo with namespace rename"
```

---

### Task 5: Client-Rename in Core

**Files:**
- Modify: `packages/core/src/client.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/tests/client.test.ts`

- [ ] **Step 1: Client-src renamen**

```bash
cd packages/core
sed -i '' \
  -e 's/\bcreateDpoClient\b/createPiiProxyClient/g' \
  -e 's/\bDpoClient\b/PiiProxyClient/g' \
  -e 's/\bDpoClientOptions\b/PiiProxyClientOptions/g' \
  -e 's/x-dpo-key/x-pii-proxy-key/g' \
  -e 's/X-DPO-Key/X-PII-Proxy-Key/g' \
  src/client.ts tests/client.test.ts src/index.ts
```

- [ ] **Step 2: Build + Tests**

```bash
cd ../..
pnpm -F @whitestag-ai/pii-proxy-core build
pnpm -F @whitestag-ai/pii-proxy-core test
```

Erwartung: Build sauber, Client-Tests grün.

- [ ] **Step 3: Commit**

```bash
git add packages/core/
git commit -m "feat(core): rename createDpoClient → createPiiProxyClient, X-PII-Proxy-Key header"
```

---

## Phase 3 — Server-Package

### Task 6: Server-Package scaffold + Code-Migration

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/vitest.config.ts`
- Copy: `paperclip-dpo-service/src/*` → `packages/server/src/*`
- Copy: `paperclip-dpo-service/tests/*` → `packages/server/tests/*`
- Copy: `paperclip-dpo-service/scripts/*` → `packages/server/scripts/*`

- [ ] **Step 1: `packages/server/package.json`**

```json
{
  "name": "@whitestag-ai/pii-proxy-server",
  "version": "0.1.0",
  "description": "HTTP server exposing pii-proxy-core endpoints over the network with shared-secret auth",
  "keywords": ["gdpr", "dsgvo", "pii", "pseudonymisation", "llm", "privacy", "fastify"],
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "pii-proxy-server": "./dist/index.js"
  },
  "files": ["dist", "deploy", "scripts"],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@whitestag-ai/pii-proxy-core": "workspace:*",
    "fastify": "^4.28.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/whitestag-ai/pii-proxy.git",
    "directory": "packages/server"
  },
  "license": "Apache-2.0",
  "author": "WHITESTAG.AI <whitestagvr@gmail.com>"
}
```

- [ ] **Step 2: `packages/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: `packages/server/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 4: Quelldateien kopieren**

```bash
SRC="$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip/paperclip-dpo-service"
cp -r "$SRC/src" packages/server/src
cp -r "$SRC/tests" packages/server/tests
cp -r "$SRC/scripts" packages/server/scripts
chmod +x packages/server/scripts/*.sh
```

- [ ] **Step 5: Bulk-Rename in server**

```bash
cd packages/server

# Package-Import
find src tests -type f -name "*.ts" -exec sed -i '' \
  -e 's|"paperclip-dpo"|"@whitestag-ai/pii-proxy-core"|g' \
  -e 's|"paperclip-dpo/keychain"|"@whitestag-ai/pii-proxy-core/keychain"|g' \
  {} \;

# Type-Namen (Consumer-Seite)
find src tests -type f -name "*.ts" -exec sed -i '' \
  -e 's/\bDpoUnavailableError\b/ClassifierUnavailableError/g' \
  -e 's/\bcreateDpo\b/createPiiProxy/g' \
  -e 's/\binterface Dpo\b/interface PiiProxy/g' \
  -e 's/: Dpo\b/: PiiProxy/g' \
  -e 's/<Dpo>/<PiiProxy>/g' \
  -e 's/\bDpo,/PiiProxy,/g' \
  -e 's/\bDpo }/PiiProxy }/g' \
  {} \;

# Env-Vars
find src tests -type f -name "*.ts" -exec sed -i '' \
  -e 's/\bDPO_PORT\b/PII_PROXY_PORT/g' \
  -e 's/\bDPO_BIND\b/PII_PROXY_BIND/g' \
  -e 's/\bDPO_SHARED_KEY\b/PII_PROXY_SHARED_KEY/g' \
  -e 's/\bDPO_MAPPING_DB\b/PII_PROXY_MAPPING_DB/g' \
  -e 's/\bDPO_AUDIT_DIR\b/PII_PROXY_AUDIT_DIR/g' \
  -e 's/\bDPO_CLASSIFIER_URL\b/PII_PROXY_CLASSIFIER_URL/g' \
  -e 's/\bDPO_CLASSIFIER_MODEL\b/PII_PROXY_CLASSIFIER_MODEL/g' \
  -e 's/\bDPO_CLASSIFIER_TIMEOUT_MS\b/PII_PROXY_CLASSIFIER_TIMEOUT_MS/g' \
  -e 's/\bDPO_TELEGRAM_BOT_TOKEN\b/PII_PROXY_TELEGRAM_BOT_TOKEN/g' \
  -e 's/\bDPO_TELEGRAM_CHAT_ID\b/PII_PROXY_TELEGRAM_CHAT_ID/g' \
  {} \;

# Header-Name
find src tests -type f -name "*.ts" -exec sed -i '' \
  -e 's/"x-dpo-key"/"x-pii-proxy-key"/g' \
  -e 's/X-DPO-Key/X-PII-Proxy-Key/g' \
  -e 's/\bX-DPO-Key\b/X-PII-Proxy-Key/g' \
  {} \;

# Block-Reason
find src tests -type f -name "*.ts" -exec sed -i '' \
  -e 's/"dpo_unavailable"/"classifier_unavailable"/g' \
  {} \;

cd ../..
```

- [ ] **Step 6: Default-Pfade in `config.ts` auf user-level umstellen**

Öffne `packages/server/src/config.ts`. Ersetze die Pflicht-Einträge `PII_PROXY_MAPPING_DB` und `PII_PROXY_AUDIT_DIR` durch optionale mit Defaults:

Finde im Schema (nach Rename):

```ts
  PII_PROXY_MAPPING_DB: z.string(),
  PII_PROXY_AUDIT_DIR: z.string(),
```

Ersetze durch:

```ts
  PII_PROXY_MAPPING_DB: z.string().default(join(homedir(), ".pii-proxy", "mappings.db")),
  PII_PROXY_AUDIT_DIR: z.string().default(join(homedir(), ".pii-proxy", "audit")),
```

Am Anfang von `config.ts` ergänzen:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 7: Alte Tests mit fehlenden Pflicht-Env-Vars anpassen**

Öffne `packages/server/tests/config.test.ts` — der Test „rejects missing shared key" sollte weiterhin funktionieren. Der Test „reads env vars with defaults" muss die Defaults auf `~/.pii-proxy/...` erwarten, nicht mehr `/tmp/...`. Passe die Assertions an:

Ersetze im Test:

```ts
    const cfg = loadConfig({
      PII_PROXY_SHARED_KEY: "secret-key-32-bytes-min-length-padding-more",
      PII_PROXY_MAPPING_DB: "/tmp/m.db",
      PII_PROXY_AUDIT_DIR: "/tmp/audit",
    });
```

durch:

```ts
    const cfg = loadConfig({
      PII_PROXY_SHARED_KEY: "secret-key-32-bytes-min-length-padding-more",
    });
    expect(cfg.mappingDbPath).toMatch(/\.pii-proxy\/mappings\.db$/);
    expect(cfg.auditDir).toMatch(/\.pii-proxy\/audit$/);
```

Wiederhole für die anderen Test-Fälle (rejects short shared key, rejects missing shared key, telegram-Test): entferne dort die `PII_PROXY_MAPPING_DB` + `PII_PROXY_AUDIT_DIR`-Felder, da sie jetzt optional sind.

- [ ] **Step 8: Plist-Template migrieren**

Alte Datei: `paperclip-dpo-service/ai.whitestag.paperclip-dpo.plist` liegt unter `packages/server/ai.whitestag.paperclip-dpo.plist` nach Copy. Migriere:

```bash
mkdir -p packages/server/deploy/launchd packages/server/deploy/systemd packages/server/deploy/docker
# Delete old location if exists
rm -f packages/server/ai.whitestag.paperclip-dpo.plist
# (The plist content is rewritten below in Step 9; no raw move needed.)
```

- [ ] **Step 9: Neue launchd-Plist schreiben**

Erstelle `packages/server/deploy/launchd/io.piiproxy.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.piiproxy.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE_BIN__</string>
    <string>__INSTALL_DIR__/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>__INSTALL_DIR__</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PII_PROXY_SHARED_KEY</key><string>__SHARED_KEY__</string>
    <key>PII_PROXY_MAPPING_DB</key><string>__DATA_DIR__/mappings.db</string>
    <key>PII_PROXY_AUDIT_DIR</key><string>__DATA_DIR__/audit</string>
    <key>PII_PROXY_CLASSIFIER_URL</key><string>http://localhost:1234</string>
    <key>PII_PROXY_CLASSIFIER_MODEL</key><string>google/gemma-4-26b-a4b</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>__LOG_DIR__/out.log</string>
  <key>StandardErrorPath</key><string>__LOG_DIR__/err.log</string>
</dict>
</plist>
```

- [ ] **Step 10: install-launchd.sh auf neue Pfade anpassen**

Ersetze den kompletten Inhalt von `packages/server/scripts/install-launchd.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SOURCE="$SERVICE_DIR/deploy/launchd/io.piiproxy.server.plist"
TARGET="$HOME/Library/LaunchAgents/io.piiproxy.server.plist"
DATA_DIR="$HOME/.pii-proxy"
LOG_DIR="$HOME/.pii-proxy/logs"
NODE_BIN="$(command -v node)"

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi

mkdir -p "$DATA_DIR/audit" "$LOG_DIR"

if [[ -z "${PII_PROXY_SHARED_KEY:-}" ]]; then
  echo "Set PII_PROXY_SHARED_KEY before running (generate via ./scripts/generate-shared-key.sh)" >&2
  exit 1
fi

sed \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__INSTALL_DIR__|$SERVICE_DIR|g" \
  -e "s|__SHARED_KEY__|$PII_PROXY_SHARED_KEY|g" \
  -e "s|__DATA_DIR__|$DATA_DIR|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$PLIST_SOURCE" > "$TARGET"

launchctl unload "$TARGET" 2>/dev/null || true
launchctl load -w "$TARGET"
echo "Installed at $TARGET. Check: curl http://localhost:4711/health"
```

- [ ] **Step 11: Smoke-Script + Key-Generator anpassen**

```bash
sed -i '' \
  -e 's/x-dpo-key/x-pii-proxy-key/g' \
  -e 's/DPO_SHARED_KEY/PII_PROXY_SHARED_KEY/g' \
  packages/server/scripts/smoke.sh
```

Der `generate-shared-key.sh` braucht keine Anpassung (erzeugt nur den Key).

- [ ] **Step 12: Install + Build + Tests**

```bash
pnpm install
pnpm -F @whitestag-ai/pii-proxy-server build
pnpm -F @whitestag-ai/pii-proxy-server test
```

Erwartung: Build sauber, alle 49+2 Tests grün (die 50 aus dem Original minus eventuelle config-Test-Anpassungen).

- [ ] **Step 13: Commit**

```bash
git add packages/server/
git commit -m "feat(server): migrate service from paperclip-dpo-service with env + naming rename"
```

---

### Task 7: systemd-Unit-Template erstellen

**Files:**
- Create: `packages/server/deploy/systemd/pii-proxy.service`
- Create: `packages/server/deploy/systemd/install-systemd.sh`

- [ ] **Step 1: systemd-Unit**

`packages/server/deploy/systemd/pii-proxy.service`:

```ini
[Unit]
Description=pii-proxy — DSGVO-compliant LLM anonymisation gate
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pii-proxy
Group=pii-proxy
WorkingDirectory=/opt/pii-proxy/server
ExecStart=/usr/bin/node /opt/pii-proxy/server/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/pii-proxy/out.log
StandardError=append:/var/log/pii-proxy/err.log
Environment=PII_PROXY_PORT=4711
Environment=PII_PROXY_BIND=0.0.0.0
Environment=PII_PROXY_CLASSIFIER_URL=http://localhost:11434
Environment=PII_PROXY_CLASSIFIER_MODEL=gemma2:27b
Environment=PII_PROXY_MAPPING_DB=/var/lib/pii-proxy/mappings.db
Environment=PII_PROXY_AUDIT_DIR=/var/lib/pii-proxy/audit
EnvironmentFile=-/etc/pii-proxy/secret.env
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/pii-proxy /var/log/pii-proxy

[Install]
WantedBy=multi-user.target
```

Die `secret.env` wird erwartet zu enthalten: `PII_PROXY_SHARED_KEY=<key>`. Default Classifier ist Ollama Gemma2 (cross-platform üblicher als LM Studio).

- [ ] **Step 2: install-Script (Linux)**

`packages/server/deploy/systemd/install-systemd.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (use sudo)." >&2
  exit 1
fi

SERVICE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# 1. System user
if ! id pii-proxy &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin pii-proxy
fi

# 2. Dirs
install -d -o pii-proxy -g pii-proxy -m 0750 /var/lib/pii-proxy /var/log/pii-proxy
install -d -o root -g pii-proxy -m 0750 /etc/pii-proxy

# 3. Install code
mkdir -p /opt/pii-proxy/server
cp -r "$SERVICE_DIR/dist" "$SERVICE_DIR/node_modules" /opt/pii-proxy/server/
chown -R root:root /opt/pii-proxy

# 4. Secret env
if [[ -z "${PII_PROXY_SHARED_KEY:-}" ]]; then
  echo "Set PII_PROXY_SHARED_KEY before running." >&2
  exit 1
fi
umask 077
echo "PII_PROXY_SHARED_KEY=$PII_PROXY_SHARED_KEY" > /etc/pii-proxy/secret.env
chown root:pii-proxy /etc/pii-proxy/secret.env
chmod 0640 /etc/pii-proxy/secret.env

# 5. Install unit
cp "$SERVICE_DIR/deploy/systemd/pii-proxy.service" /etc/systemd/system/pii-proxy.service
systemctl daemon-reload
systemctl enable pii-proxy.service
systemctl restart pii-proxy.service
echo "Installed. Check: systemctl status pii-proxy && curl http://localhost:4711/health"
```

- [ ] **Step 3: chmod + Commit**

```bash
chmod +x packages/server/deploy/systemd/install-systemd.sh
git add packages/server/deploy/systemd/
git commit -m "chore(server): systemd unit + install script for Linux deployment"
```

---

### Task 8: Dockerfile + docker-compose

**Files:**
- Create: `packages/server/Dockerfile`
- Create: `packages/server/.dockerignore`
- Create: `packages/server/deploy/docker/docker-compose.yml`

- [ ] **Step 1: `packages/server/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

# ---- Builder ----
FROM node:22-bookworm-slim AS builder
WORKDIR /workspace

# Enable pnpm via corepack
RUN corepack enable

# Copy monorepo root metadata for workspace resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/

# Install all workspace deps
RUN pnpm install --frozen-lockfile

# Copy sources
COPY packages/core ./packages/core
COPY packages/server ./packages/server

# Build
RUN pnpm -r build

# ---- Runtime ----
FROM node:22-bookworm-slim AS runtime

# keytar has native deps; we avoid keytar in Docker by setting a mapping key directly
# via env var instead. See docs/CONFIG.md.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libsecret-1-0 \
      && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and node_modules from builder
COPY --from=builder /workspace/packages/core/dist ./node_modules/@whitestag-ai/pii-proxy-core/dist
COPY --from=builder /workspace/packages/core/package.json ./node_modules/@whitestag-ai/pii-proxy-core/
COPY --from=builder /workspace/packages/core/pii-proxy-rules.default.yaml ./node_modules/@whitestag-ai/pii-proxy-core/
COPY --from=builder /workspace/packages/server/dist ./dist
COPY --from=builder /workspace/packages/server/package.json ./
COPY --from=builder /workspace/packages/server/node_modules ./node_modules

# Non-root user
RUN useradd --system --uid 1001 pii-proxy \
    && mkdir -p /var/lib/pii-proxy/audit \
    && chown -R pii-proxy:pii-proxy /var/lib/pii-proxy

USER pii-proxy
ENV NODE_ENV=production
ENV PII_PROXY_BIND=0.0.0.0
ENV PII_PROXY_PORT=4711
ENV PII_PROXY_MAPPING_DB=/var/lib/pii-proxy/mappings.db
ENV PII_PROXY_AUDIT_DIR=/var/lib/pii-proxy/audit

EXPOSE 4711
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4711/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Dockerfile erfordert Keychain-optional — Library anpassen**

Der Docker-Container hat keine Keychain. Wir brauchen einen Fallback, wenn `keytar` nicht verfügbar ist oder `PII_PROXY_MAPPING_KEY` direkt per Env gesetzt wird.

Öffne `packages/server/src/index.ts`. Ersetze den `getOrCreateMappingKey()`-Call durch diese Fallback-Logik:

```ts
import { randomBytes } from "node:crypto";

async function resolveMappingKey(): Promise<Buffer> {
  const fromEnv = process.env.PII_PROXY_MAPPING_KEY_BASE64;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, "base64");
    if (buf.length !== 32) {
      throw new Error("PII_PROXY_MAPPING_KEY_BASE64 must decode to exactly 32 bytes");
    }
    return buf;
  }
  // Fall back to Keychain (macOS). On Linux without libsecret this will throw.
  const { getOrCreateMappingKey } = await import("@whitestag-ai/pii-proxy-core/keychain");
  return getOrCreateMappingKey();
}
```

Und ersetze `await getOrCreateMappingKey()` durch `await resolveMappingKey()`.

- [ ] **Step 3: `packages/server/.dockerignore`**

```
node_modules
dist
coverage
*.log
tests
.env
.env.local
```

- [ ] **Step 4: `packages/server/deploy/docker/docker-compose.yml`**

```yaml
services:
  pii-proxy:
    image: ghcr.io/whitestag-ai/pii-proxy:latest
    container_name: pii-proxy
    restart: unless-stopped
    ports:
      - "127.0.0.1:4711:4711"
    environment:
      PII_PROXY_SHARED_KEY: ${PII_PROXY_SHARED_KEY}
      PII_PROXY_MAPPING_KEY_BASE64: ${PII_PROXY_MAPPING_KEY_BASE64}
      PII_PROXY_CLASSIFIER_URL: http://host.docker.internal:11434
      PII_PROXY_CLASSIFIER_MODEL: gemma2:27b
    volumes:
      - pii-proxy-data:/var/lib/pii-proxy
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  pii-proxy-data:
```

- [ ] **Step 5: Build-Test (docker)**

```bash
cd packages/server
docker build -t pii-proxy:test -f Dockerfile ../..
```

Erwartung: Image baut ohne Fehler. Teste nicht den Run — dafür bräuchte es einen Classifier auf dem Host.

- [ ] **Step 6: Commit**

```bash
cd ../..
git add packages/server/Dockerfile packages/server/.dockerignore packages/server/deploy/docker/ packages/server/src/index.ts
git commit -m "feat(server): Dockerfile + docker-compose + PII_PROXY_MAPPING_KEY_BASE64 fallback"
```

---

## Phase 4 — Python-Client

### Task 9: Python-Package scaffold

**Files:**
- Create: `python/pyproject.toml`
- Create: `python/README.md`
- Create: `python/src/pii_proxy/__init__.py`
- Create: `python/.gitignore`

- [ ] **Step 1: `python/pyproject.toml`**

```toml
[build-system]
requires = ["hatchling>=1.25"]
build-backend = "hatchling.build"

[project]
name = "pii-proxy"
version = "0.1.0"
description = "Python client for pii-proxy — GDPR-compliant LLM anonymisation gate"
readme = "README.md"
license = "Apache-2.0"
authors = [
    { name = "WHITESTAG.AI", email = "whitestagvr@gmail.com" }
]
keywords = ["gdpr", "dsgvo", "pii", "anonymisation", "llm", "privacy"]
requires-python = ">=3.11"
classifiers = [
    "Development Status :: 4 - Beta",
    "Intended Audience :: Developers",
    "License :: OSI Approved :: Apache Software License",
    "Programming Language :: Python :: 3.11",
    "Programming Language :: Python :: 3.12",
    "Programming Language :: Python :: 3.13",
    "Topic :: Security",
]
dependencies = [
    "httpx>=0.27,<1.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.24",
    "pytest-httpx>=0.32",
    "ruff>=0.6",
]

[project.urls]
Homepage = "https://github.com/whitestag-ai/pii-proxy"
Repository = "https://github.com/whitestag-ai/pii-proxy"
Issues = "https://github.com/whitestag-ai/pii-proxy/issues"

[tool.hatch.build.targets.wheel]
packages = ["src/pii_proxy"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.ruff]
line-length = 100
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "W", "I", "N", "UP"]
```

- [ ] **Step 2: `python/.gitignore`**

```
__pycache__/
*.py[cod]
*$py.class
.pytest_cache/
.ruff_cache/
.venv/
venv/
*.egg-info/
dist/
build/
```

- [ ] **Step 3: `python/src/pii_proxy/__init__.py`**

```python
"""Python client for pii-proxy HTTP server."""
from pii_proxy.client import (
    PiiProxyClient,
    AnonymizeResult,
    AnonymizeBlocked,
    SafeCallResult,
    SafeCallBlocked,
    PiiProxyError,
)

__version__ = "0.1.0"
__all__ = [
    "PiiProxyClient",
    "AnonymizeResult",
    "AnonymizeBlocked",
    "SafeCallResult",
    "SafeCallBlocked",
    "PiiProxyError",
]
```

- [ ] **Step 4: `python/README.md` (Stub)**

```markdown
# pii-proxy (Python)

Python client for [pii-proxy](https://github.com/whitestag-ai/pii-proxy) — a GDPR-compliant anonymisation gate for LLM calls.

```bash
pip install pii-proxy
```

See the [monorepo README](../README.md) for full documentation.
```

- [ ] **Step 5: Commit**

```bash
git add python/pyproject.toml python/README.md python/src/pii_proxy/__init__.py python/.gitignore
git commit -m "chore(python): scaffold pii_proxy Python package"
```

---

### Task 10: Python-Client — TDD

**Files:**
- Create: `python/src/pii_proxy/client.py`
- Create: `python/tests/test_client.py`
- Create: `python/tests/__init__.py`

- [ ] **Step 1: Failing Test**

`python/tests/__init__.py` — leer anlegen:

```bash
touch python/tests/__init__.py
```

`python/tests/test_client.py`:

```python
import pytest
import httpx
from pytest_httpx import HTTPXMock
from pii_proxy import PiiProxyClient, PiiProxyError

KEY = "client-test-key-32-bytes-xxxxxxxxx"
BASE = "http://localhost:4711"


def make_client() -> PiiProxyClient:
    return PiiProxyClient(base_url=BASE, shared_key=KEY, timeout=5.0)


def test_anonymize_returns_mapping_and_text(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url=f"{BASE}/anonymize",
        json={"blocked": False, "anonymizedText": "hi [PERSON_A]", "mappingId": "m-1"},
    )
    client = make_client()
    res = client.anonymize(text="hi Max", target_llm="gpt-4o", agent="test")
    assert res.blocked is False
    assert res.anonymized_text == "hi [PERSON_A]"
    assert res.mapping_id == "m-1"

    req = httpx_mock.get_requests()[0]
    assert req.headers["x-pii-proxy-key"] == KEY


def test_anonymize_returns_blocked(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url=f"{BASE}/anonymize",
        json={"blocked": True, "reason": "art_9_data_detected"},
    )
    client = make_client()
    res = client.anonymize(text="x", target_llm="gpt-4o", agent="test")
    assert res.blocked is True
    assert res.reason == "art_9_data_detected"


def test_deanonymize_returns_text(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url=f"{BASE}/deanonymize", json={"text": "hi Max"}
    )
    client = make_client()
    out = client.deanonymize(mapping_id="m-1", text="hi [PERSON_A]")
    assert out == "hi Max"


def test_safe_call_roundtrip(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url=f"{BASE}/safe-call",
        json={"blocked": False, "text": "done"},
    )
    client = make_client()
    res = client.safe_call(
        prompt="hi Max",
        target_llm="gpt-4o",
        agent="test",
        external={
            "url": "https://api.openai.com/v1/chat/completions",
            "headers": {"Authorization": "Bearer t"},
            "bodyTemplate": {"content": "{{prompt}}"},
            "responsePath": "content",
        },
    )
    assert res.blocked is False
    assert res.text == "done"


def test_non_2xx_raises(httpx_mock: HTTPXMock):
    httpx_mock.add_response(url=f"{BASE}/anonymize", status_code=401, text="nope")
    client = make_client()
    with pytest.raises(PiiProxyError, match="401"):
        client.anonymize(text="x", target_llm="y", agent="z")


def test_health_no_auth_required(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url=f"{BASE}/health", json={"status": "ok", "classifier": "reachable"}
    )
    client = make_client()
    health = client.health()
    assert health["classifier"] == "reachable"
    req = httpx_mock.get_requests()[0]
    # health is unauthenticated; the client should not send the key
    assert "x-pii-proxy-key" not in {k.lower() for k in req.headers.keys()}
```

- [ ] **Step 2: Test ausführen — FAIL**

```bash
cd python
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/test_client.py -v
```

Erwartung: ImportError — `client.py` existiert nicht.

- [ ] **Step 3: Implementierung**

`python/src/pii_proxy/client.py`:

```python
"""HTTP client for pii-proxy server."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, TypedDict

import httpx


class ExternalCall(TypedDict, total=False):
    url: str
    method: Literal["POST", "PUT"]
    headers: dict[str, str]
    bodyTemplate: dict[str, Any]
    responsePath: str


@dataclass
class AnonymizeResult:
    blocked: Literal[False] = False
    anonymized_text: str = ""
    mapping_id: str = ""


@dataclass
class AnonymizeBlocked:
    blocked: Literal[True] = True
    reason: str = ""


@dataclass
class SafeCallResult:
    blocked: Literal[False] = False
    text: str = ""


@dataclass
class SafeCallBlocked:
    blocked: Literal[True] = True
    reason: str = ""


class PiiProxyError(RuntimeError):
    """Raised when the pii-proxy server returns a non-2xx response."""


class PiiProxyClient:
    """Synchronous HTTP client for the pii-proxy server."""

    def __init__(
        self,
        base_url: str,
        shared_key: str,
        timeout: float = 60.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._key = shared_key
        self._timeout = timeout
        self._client = httpx.Client(timeout=timeout, transport=transport)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "PiiProxyClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def health(self) -> dict[str, str]:
        r = self._client.get(f"{self._base}/health")
        self._raise_for_status(r, "/health")
        return r.json()

    def anonymize(
        self,
        text: str,
        target_llm: str,
        agent: str,
        tenant_id: str | None = None,
    ) -> AnonymizeResult | AnonymizeBlocked:
        body: dict[str, Any] = {"text": text, "targetLlm": target_llm, "agent": agent}
        if tenant_id:
            body["tenantId"] = tenant_id
        data = self._post("/anonymize", body)
        if data.get("blocked"):
            return AnonymizeBlocked(blocked=True, reason=data["reason"])
        return AnonymizeResult(
            blocked=False,
            anonymized_text=data["anonymizedText"],
            mapping_id=data["mappingId"],
        )

    def deanonymize(self, mapping_id: str, text: str) -> str:
        data = self._post("/deanonymize", {"mappingId": mapping_id, "text": text})
        return data["text"]

    def safe_call(
        self,
        prompt: str,
        target_llm: str,
        agent: str,
        external: ExternalCall,
        tenant_id: str | None = None,
    ) -> SafeCallResult | SafeCallBlocked:
        body: dict[str, Any] = {
            "prompt": prompt,
            "targetLlm": target_llm,
            "agent": agent,
            "external": external,
        }
        if tenant_id:
            body["tenantId"] = tenant_id
        data = self._post("/safe-call", body)
        if data.get("blocked"):
            return SafeCallBlocked(blocked=True, reason=data["reason"])
        return SafeCallResult(blocked=False, text=data["text"])

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        r = self._client.post(
            f"{self._base}{path}",
            json=body,
            headers={"x-pii-proxy-key": self._key},
        )
        self._raise_for_status(r, path)
        return r.json()

    def _raise_for_status(self, r: httpx.Response, path: str) -> None:
        if r.is_success:
            return
        raise PiiProxyError(f"pii-proxy {path} {r.status_code}: {r.text}")
```

- [ ] **Step 4: Test grün**

```bash
pytest tests/test_client.py -v
```

Erwartung: 6 Tests grün.

- [ ] **Step 5: Commit**

```bash
cd ..
git add python/
git commit -m "feat(python): PiiProxyClient with sync httpx, dataclass result types"
```

---

## Phase 5 — Dokumentation

### Task 11: Root-README schreiben

**Files:**
- Create: `README.md`

- [ ] **Step 1: Root `README.md`**

```markdown
# pii-proxy

A GDPR-compliant anonymisation gate for LLM calls.

Detect and pseudonymise personal data (emails, phone numbers, names, company names, bank details, trade secrets) before sending prompts to Claude, OpenAI, Gemini, or any other cloud LLM. De-anonymise responses transparently. Block Art. 9 special-category data entirely. Log everything for GDPR Art. 30 processing records.

**Why:** If you're an EU company using cloud LLMs, your customer data shouldn't leave the continent in plaintext. `pii-proxy` is a drop-in HTTP gate that pseudonymises before egress and restores on return — without the LLM ever seeing real PII.

## Quick start

### Docker

```bash
curl -L -o docker-compose.yml \
  https://raw.githubusercontent.com/whitestag-ai/pii-proxy/main/packages/server/deploy/docker/docker-compose.yml

export PII_PROXY_SHARED_KEY=$(openssl rand -base64 32 | tr -d '=/+' | cut -c1-43)
export PII_PROXY_MAPPING_KEY_BASE64=$(openssl rand -base64 32)

docker compose up -d
curl http://localhost:4711/health
```

### macOS (launchd)

```bash
git clone https://github.com/whitestag-ai/pii-proxy.git
cd pii-proxy
pnpm install && pnpm build

export PII_PROXY_SHARED_KEY=$(./packages/server/scripts/generate-shared-key.sh)
security add-generic-password -s io.piiproxy.shared-key -a default -w "$PII_PROXY_SHARED_KEY"
./packages/server/scripts/install-launchd.sh

curl http://localhost:4711/health
```

### Linux (systemd)

```bash
git clone https://github.com/whitestag-ai/pii-proxy.git
cd pii-proxy
pnpm install && pnpm build

export PII_PROXY_SHARED_KEY=$(./packages/server/scripts/generate-shared-key.sh)
sudo -E ./packages/server/deploy/systemd/install-systemd.sh

systemctl status pii-proxy
```

## Usage

### TypeScript

```ts
import { createPiiProxyClient } from "@whitestag-ai/pii-proxy-core";

const client = createPiiProxyClient({
  baseUrl: "http://localhost:4711",
  sharedKey: process.env.PII_PROXY_SHARED_KEY!,
});

const result = await client.safeCall({
  prompt: "Hi, can you write a birthday email to Max Mustermann (max@example.com)?",
  targetLlm: "gpt-4o-mini",
  agent: "my-app",
  external: {
    url: "https://api.openai.com/v1/chat/completions",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    bodyTemplate: {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "{{prompt}}" }],
    },
    responsePath: "choices.0.message.content",
  },
});

if (!result.blocked) console.log(result.text);
```

### Python

```python
from pii_proxy import PiiProxyClient

client = PiiProxyClient(base_url="http://localhost:4711", shared_key=...)
result = client.safe_call(
    prompt="Hi, can you write ...",
    target_llm="gpt-4o-mini",
    agent="my-app",
    external={
        "url": "https://api.openai.com/v1/chat/completions",
        "headers": {"Authorization": f"Bearer {OPENAI_API_KEY}"},
        "bodyTemplate": {"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "{{prompt}}"}]},
        "responsePath": "choices.0.message.content",
    },
)
```

### curl

```bash
curl -X POST http://localhost:4711/anonymize \
  -H "x-pii-proxy-key: $PII_PROXY_SHARED_KEY" \
  -H "content-type: application/json" \
  -d '{"text":"Max Mustermann (max@example.com)","targetLlm":"gpt-4o","agent":"curl"}'
```

## How it works

Two-stage pipeline:

1. **Regex detectors** — deterministic, zero-latency: emails, phone numbers (DE), IBAN, BIC, VAT-ID, tax numbers, postcodes, URLs.
2. **LLM classifier** (local, via LM Studio or Ollama) — detects: person names, company names, places, trade secrets (revenues, margins, prices, salaries, customer relationships), Art. 9 data (health, religion, biometrics, …).

Pseudonyms are consistent within a session (same name → same `[PERSON_A]`). The mapping table is AES-256-GCM encrypted on disk, keyed from the OS keychain or an env var. A JSONL audit log records what was sent to which LLM, when, and by which agent — the source data for GDPR Art. 30 records of processing.

On Art. 9 detection or classifier outage, requests are **blocked** (fail-closed). Never falls through silently.

## Components

| Package | What | Install |
|---|---|---|
| [`@whitestag-ai/pii-proxy-core`](packages/core/) | TS library: detectors, classifier, mapping store | `pnpm add @whitestag-ai/pii-proxy-core` |
| [`@whitestag-ai/pii-proxy-server`](packages/server/) | Fastify HTTP gate | `docker pull ghcr.io/whitestag-ai/pii-proxy` |
| [`pii-proxy`](python/) (PyPI) | Python HTTP client | `pip install pii-proxy` |
| [`paperclip-plugin-pii-proxy`](https://github.com/whitestag-ai/paperclip-plugin-pii-proxy) | Paperclip integration | separate repo |

## Documentation

- [Configuration reference](docs/CONFIG.md) — all env vars
- [Tested classifier models](docs/MODELS.md) — Ollama, LM Studio, etc.
- [Integrations](docs/INTEGRATIONS.md) — n8n, LangChain, raw HTTP
- [Architecture](docs/ARCHITECTURE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## GDPR reference

| Article | Implementation |
|---|---|
| Art. 25 (Privacy by design) | pii-proxy itself is the technical measure |
| Art. 28 (Processor oversight) | Audit log documents every egress |
| Art. 30 (Records of processing) | Audit log is the data source |
| Art. 32 (Pseudonymisation) | AES-256-GCM mapping store |
| Art. 9 (Special categories) | Fail-closed veto mode |

## License

Apache-2.0 © WHITESTAG.AI
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: root README with quick start, usage, architecture"
```

---

### Task 12: docs/CONFIG.md

**Files:**
- Create: `docs/CONFIG.md`

- [ ] **Step 1: Write**

`docs/CONFIG.md`:

```markdown
# Configuration Reference

All configuration is via environment variables.

## Required

| Var | Description |
|---|---|
| `PII_PROXY_SHARED_KEY` | Shared secret for the `X-PII-Proxy-Key` header on protected endpoints. Must be at least 32 characters. Generate with `./packages/server/scripts/generate-shared-key.sh` |

## Classifier

| Var | Default | Description |
|---|---|---|
| `PII_PROXY_CLASSIFIER_URL` | `http://localhost:1234` | LM Studio or Ollama endpoint. For Ollama use `http://localhost:11434`. |
| `PII_PROXY_CLASSIFIER_MODEL` | `google/gemma-4-26b-a4b` | Model ID as listed by the provider's `/v1/models`. For Ollama: `gemma2:27b`, `llama3.1:70b`, etc. |
| `PII_PROXY_CLASSIFIER_TIMEOUT_MS` | `30000` | Per-classification timeout |

See [MODELS.md](MODELS.md) for tested combinations.

## Storage

| Var | Default | Description |
|---|---|---|
| `PII_PROXY_MAPPING_DB` | `~/.pii-proxy/mappings.db` | SQLite path for the pseudonym mapping table |
| `PII_PROXY_AUDIT_DIR` | `~/.pii-proxy/audit` | Directory for daily JSONL audit logs (file `pii-proxy-YYYY-MM-DD.jsonl`) |
| `PII_PROXY_MAPPING_KEY_BASE64` | — | 32-byte AES key, base64-encoded. If set, overrides the OS keychain lookup. **Required in Docker** (no keychain). Generate: `openssl rand -base64 32` |

In containers without a keychain (Docker, most Linux CI), set `PII_PROXY_MAPPING_KEY_BASE64` explicitly and persist it across restarts — otherwise existing mappings cannot be decrypted after restart.

## Network

| Var | Default | Description |
|---|---|---|
| `PII_PROXY_PORT` | `4711` | HTTP listen port |
| `PII_PROXY_BIND` | `0.0.0.0` | Listen interface. Use `127.0.0.1` for loopback-only |

## Alerts (optional)

| Var | Description |
|---|---|
| `PII_PROXY_TELEGRAM_BOT_TOKEN` | Bot token for Art. 9 / classifier-down alerts. Leave unset to log to stderr instead. |
| `PII_PROXY_TELEGRAM_CHAT_ID` | Destination chat ID |

Both must be set to activate Telegram alerts. Triggers: Art. 9 block (immediate), classifier unreachable 3× consecutive, >10 blocks/h.

## Example `.env`

```
PII_PROXY_SHARED_KEY=generated-43-char-base64url-string
PII_PROXY_MAPPING_KEY_BASE64=generated-32-byte-base64
PII_PROXY_CLASSIFIER_URL=http://localhost:11434
PII_PROXY_CLASSIFIER_MODEL=gemma2:27b
PII_PROXY_BIND=127.0.0.1
```
```

- [ ] **Step 2: Commit**

```bash
git add docs/CONFIG.md
git commit -m "docs: configuration reference"
```

---

### Task 13: docs/MODELS.md

**Files:**
- Create: `docs/MODELS.md`

- [ ] **Step 1: Write**

`docs/MODELS.md`:

```markdown
# Tested Classifier Models

The classifier is an LLM that identifies person names, company names, trade secrets, and Art. 9 data. Regex detectors (emails, IBAN, phone, etc.) run independently and are provider-agnostic.

## Requirements

- Serves OpenAI-compatible `/v1/chat/completions` (Ollama, LM Studio, vLLM, Tabby, LocalAI all work)
- Instruction-tuned model with reliable JSON output
- German + English understanding
- ≥ 20B parameters recommended for acceptable precision

## Tested

| Model | Provider | URL | Notes |
|---|---|---|---|
| `google/gemma-4-26b-a4b` | LM Studio | `http://localhost:1234` | Default. Good precision, fast on Apple Silicon |
| `gemma2:27b` | Ollama | `http://localhost:11434` | Linux/server default. Close to Gemma 4, slightly lower precision |
| `qwen2.5:32b` | Ollama / LM Studio | — | Stronger German than Gemma 2 |
| `mistral-small:24b` | Ollama | — | Fastest with decent quality |

## Not recommended

- `llama3.1:8b` and smaller — too many false negatives on company names
- English-only fine-tunes — miss German legal/commercial terms
- `gpt-oss` / `deepseek-r1` reasoning models — too slow, unpredictable JSON output

## Switching provider

LM Studio is the macOS default because Apple Silicon acceleration works out of the box. For server deployments, Ollama is more scriptable.

Switch by setting env vars:

```
# Ollama
PII_PROXY_CLASSIFIER_URL=http://localhost:11434
PII_PROXY_CLASSIFIER_MODEL=gemma2:27b

# vLLM
PII_PROXY_CLASSIFIER_URL=http://vllm-host:8000
PII_PROXY_CLASSIFIER_MODEL=Qwen/Qwen2.5-32B-Instruct
```

## Reporting a model

If you test a new model and want it listed here, please open a PR with benchmark results: precision and recall for German + English names, companies, and Art. 9 data. Include the exact LM Studio / Ollama version and quantisation.
```

- [ ] **Step 2: Commit**

```bash
git add docs/MODELS.md
git commit -m "docs: tested classifier models reference"
```

---

### Task 14: docs/INTEGRATIONS.md

**Files:**
- Create: `docs/INTEGRATIONS.md`

- [ ] **Step 1: Write**

`docs/INTEGRATIONS.md`:

```markdown
# Integrations

## n8n

Import the example workflow at `examples/n8n-dpo-proxy-workflow.json` as a sub-workflow. It takes `{ prompt, targetLlm, model, agent }` and returns `{ blocked, text }`.

**Parent workflow change:** replace your direct OpenAI HTTP node with an "Execute Workflow" node pointing to the imported sub-workflow.

**Credentials:**

1. Create HTTP Header Auth credential: header `X-PII-Proxy-Key`, value = your `PII_PROXY_SHARED_KEY`
2. Assign to the two `anonymize` / `deanonymize` HTTP nodes in the sub-workflow

## LangChain (Python)

```python
from langchain_openai import ChatOpenAI
from pii_proxy import PiiProxyClient

proxy = PiiProxyClient(base_url="http://localhost:4711", shared_key=KEY)

def anonymised_chat(prompt: str) -> str:
    anon = proxy.anonymize(text=prompt, target_llm="gpt-4o", agent="langchain")
    if anon.blocked:
        raise RuntimeError(f"pii-proxy blocked: {anon.reason}")
    reply = ChatOpenAI(model="gpt-4o").invoke(anon.anonymized_text)
    return proxy.deanonymize(mapping_id=anon.mapping_id, text=reply.content)
```

## Raw HTTP from any language

`/safe-call` is the one-shot endpoint — anonymise, call external, deanonymise, all in the server. Client only needs to POST JSON and read JSON.

```bash
curl -X POST http://localhost:4711/safe-call \
  -H "x-pii-proxy-key: $PII_PROXY_SHARED_KEY" \
  -H "content-type: application/json" \
  -d '{
    "prompt": "Write to Max Mustermann (max@example.com)",
    "targetLlm": "gpt-4o",
    "agent": "my-bash-script",
    "external": {
      "url": "https://api.openai.com/v1/chat/completions",
      "headers": {"Authorization": "Bearer sk-..."},
      "bodyTemplate": {"model":"gpt-4o","messages":[{"role":"user","content":"{{prompt}}"}]},
      "responsePath": "choices.0.message.content"
    }
  }'
```

## Paperclip

Use the separate [`paperclip-plugin-pii-proxy`](https://github.com/whitestag-ai/paperclip-plugin-pii-proxy) repo.
```

- [ ] **Step 2: Commit**

```bash
git add docs/INTEGRATIONS.md
git commit -m "docs: integration examples for n8n, LangChain, curl, Paperclip"
```

---

### Task 15: SECURITY.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md

**Files:**
- Create: `SECURITY.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `CONTRIBUTING.md`

- [ ] **Step 1: `SECURITY.md`**

```markdown
# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Instead:

- Email `security@whitestag.ai`
- PGP: (key fingerprint will be added after repo setup)

We'll acknowledge within 72 hours and aim to ship a fix within 14 days for critical issues.

## Scope

In scope:
- Pseudonymisation bypass (PII leaking through the gate)
- Mapping store key extraction
- Shared-key timing or brute-force weaknesses
- Audit-log tampering or injection
- Any CVSS ≥ 4.0 vulnerability in the HTTP server or TS/Python clients

Out of scope:
- Denial of service via classifier exhaustion (the classifier is an external dependency by design)
- Supply-chain attacks on unpinned dependencies of your own deployment
- LLM prompt injection that tricks a cloud LLM after the gate (pii-proxy does not claim to mitigate prompt injection)

## Supported versions

Only the latest minor release receives security updates during the 0.x series.

## Security assumptions

- The host running pii-proxy is trusted.
- The shared key is treated as a cryptographic secret (32+ chars, rotated on suspicion).
- The classifier model produces outputs aligned with the prompts it's given. Model jailbreaks in the classifier *could* let PII through — report such cases.
```

- [ ] **Step 2: `CODE_OF_CONDUCT.md`**

```markdown
# Contributor Covenant Code of Conduct

This project follows the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

Report incidents to `conduct@whitestag.ai`.
```

- [ ] **Step 3: `CONTRIBUTING.md`**

```markdown
# Contributing to pii-proxy

Thanks for considering a contribution.

## Development setup

```bash
git clone https://github.com/whitestag-ai/pii-proxy.git
cd pii-proxy
pnpm install
pnpm test    # TS packages
cd python && pip install -e ".[dev]" && pytest
```

## Pull requests

1. Open an issue first for anything larger than a typo fix
2. Branch from `main`
3. Write tests (TDD — test first)
4. Run `pnpm build && pnpm test` and (if touching Python) `pytest`
5. Add a changeset: `pnpm changeset`
6. Open PR

## Commit style

- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`)
- Include the package scope: `fix(server): …`

## Classifier models

If you're adding or testing a new classifier model, include benchmark notes in `docs/MODELS.md`.

## Security-sensitive changes

PRs that touch the mapping store, shared-key handling, or the classifier pipeline must include:

1. A description of the threat model change
2. Tests for the new behaviour
3. A mention in `SECURITY.md` if it changes assumptions
```

- [ ] **Step 4: Commit**

```bash
git add SECURITY.md CODE_OF_CONDUCT.md CONTRIBUTING.md
git commit -m "docs: security policy, code of conduct, contributing guide"
```

---

### Task 16: docs/ARCHITECTURE.md + examples/

**Files:**
- Create: `docs/ARCHITECTURE.md`
- Create: `examples/curl-quickstart.sh`
- Create: `examples/langchain-example.py`
- Create: `examples/docker-compose.yml` (symlink to packages/server/deploy/docker/)
- Create: `examples/n8n-dpo-proxy-workflow.json` (copy from Paperclip repo, sanitise)

- [ ] **Step 1: `docs/ARCHITECTURE.md`**

```markdown
# Architecture

```
                  ┌──────────────┐
 client app ─────▶│  pii-proxy   │────▶  external LLM (OpenAI, Anthropic, …)
                  │   server     │
                  │   :4711      │
                  └───────┬──────┘
                          │
                  ┌───────┴──────┐
                  │              │
           ┌──────▼───┐   ┌──────▼──────┐
           │ regex    │   │ classifier  │
           │ detectors│   │ LLM (local) │
           └──────────┘   └─────────────┘
                  │
          ┌───────┴──────┐
          │ AES-256-GCM  │
          │ mapping store│
          └──────────────┘
                  │
          ┌───────┴──────┐
          │ JSONL audit  │
          └──────────────┘
```

## Data flow

1. Client POSTs a prompt to `/anonymize` (or `/safe-call`)
2. Server runs regex detectors for deterministic PII (emails, IBAN, phone, VAT-ID, BIC, tax IDs, postcodes, URLs)
3. Server calls the local classifier LLM to detect named entities and trade secrets
4. If Art. 9 data is detected → block, return `{ blocked: true, reason: "art_9_data_detected" }`
5. Otherwise, each detection is replaced with a consistent pseudonym (`[PERSON_A]`, `[FIRMA_1]`, `[EMAIL_A]`)
6. Pseudonym→plaintext mappings are AES-256-GCM encrypted and persisted to SQLite with the supplied `mappingId` and per-tenant TTL
7. Audit log writes one line of metadata (timestamp, agent, target LLM, detection counts, prompt hash) — never the plaintext itself
8. Server returns `{ anonymizedText, mappingId }` to the client (or forwards to the external LLM in `/safe-call`)
9. Client calls `/deanonymize` with the `mappingId` and the LLM response, receives plaintext back

## Fail-closed semantics

- Classifier unreachable → `{ blocked: true, reason: "classifier_unavailable" }`
- Art. 9 detected with confidence above threshold → immediate block + optional Telegram alert
- Unknown `mappingId` on `/deanonymize` → 404 (prevents silent leakage of untranslated pseudonyms)

## What pii-proxy does not do

- Prompt injection defence (the external LLM can still be manipulated post-gate)
- On-device LLM inference for the user prompts — only the classifier runs locally
- Audit log rotation / retention policy — configure externally (logrotate, cron job)
- Key rotation — manual (new `PII_PROXY_SHARED_KEY`, then restart)

## Threat model

Trusted:
- The host running pii-proxy
- The classifier LLM (but see [MODELS.md](MODELS.md) on jailbreak risks)
- The OS keychain / `PII_PROXY_MAPPING_KEY_BASE64`

Untrusted:
- The external LLM (that's the whole point)
- Network between client and pii-proxy (mitigation: bind to `127.0.0.1` or put behind mTLS proxy if LAN-exposed)
- Other processes on the host (mitigation: file permissions on mapping DB and audit log)
```

- [ ] **Step 2: `examples/curl-quickstart.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

URL="${1:-http://localhost:4711}"
KEY="${PII_PROXY_SHARED_KEY:?set PII_PROXY_SHARED_KEY}"

echo "→ health"
curl -s "$URL/health" | tee /dev/stderr; echo

echo "→ anonymize"
RESP=$(curl -s -f \
  -H "x-pii-proxy-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"text":"Max Mustermann (max@whitestag.de)","targetLlm":"gpt-4o","agent":"demo"}' \
  "$URL/anonymize")
echo "$RESP"

MID=$(echo "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("mappingId",""))')
[[ -z "$MID" ]] && { echo "blocked"; exit 1; }

echo "→ deanonymize"
curl -s -f \
  -H "x-pii-proxy-key: $KEY" \
  -H "content-type: application/json" \
  -d "{\"mappingId\":\"$MID\",\"text\":\"hello $(echo $RESP | python3 -c 'import json,sys;print(json.load(sys.stdin)[\"anonymizedText\"])')!\"}" \
  "$URL/deanonymize"
echo

echo "OK"
```

- [ ] **Step 3: `examples/langchain-example.py`**

```python
"""Minimal LangChain wrapper using pii-proxy."""
import os
from langchain_openai import ChatOpenAI
from pii_proxy import PiiProxyClient

proxy = PiiProxyClient(
    base_url=os.environ.get("PII_PROXY_URL", "http://localhost:4711"),
    shared_key=os.environ["PII_PROXY_SHARED_KEY"],
)


def privacy_safe_chat(prompt: str, model: str = "gpt-4o-mini") -> str:
    """Anonymise a prompt, send to OpenAI, deanonymise the response."""
    anon = proxy.anonymize(text=prompt, target_llm=model, agent="langchain-demo")
    if anon.blocked:
        raise RuntimeError(f"pii-proxy blocked: {anon.reason}")

    chat = ChatOpenAI(model=model, temperature=0.2)
    reply = chat.invoke(anon.anonymized_text)
    return proxy.deanonymize(mapping_id=anon.mapping_id, text=reply.content)


if __name__ == "__main__":
    out = privacy_safe_chat("Write a short greeting to Max Mustermann (max@whitestag.de).")
    print(out)
```

- [ ] **Step 4: n8n-Beispielworkflow kopieren**

```bash
cp "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip/projekte/n8n-workflows/DPO-Proxy V1.json" \
  examples/n8n-pii-proxy-workflow.json
```

Öffne die Datei und ersetze:
- `"name": "DPO-Proxy V1"` → `"name": "PII-Proxy Sub-Workflow"`
- `http://192.168.2.10:4711` → `http://pii-proxy:4711` (Docker-Service-Name, dokumentiert in INTEGRATIONS.md)
- `x-dpo-key` → `x-pii-proxy-key` (falls noch drin)

```bash
sed -i '' \
  -e 's/DPO-Proxy V1/PII-Proxy Sub-Workflow/g' \
  -e 's|192.168.2.10:4711|pii-proxy:4711|g' \
  -e 's/x-dpo-key/x-pii-proxy-key/g' \
  -e 's/X-DPO-Key/X-PII-Proxy-Key/g' \
  examples/n8n-pii-proxy-workflow.json
```

- [ ] **Step 5: `examples/docker-compose.yml` symlinken**

```bash
ln -sf ../packages/server/deploy/docker/docker-compose.yml examples/docker-compose.yml
```

- [ ] **Step 6: chmod + Commit**

```bash
chmod +x examples/curl-quickstart.sh
git add docs/ARCHITECTURE.md examples/
git commit -m "docs: architecture guide and curl/langchain/n8n examples"
```

---

## Phase 6 — CI/CD

### Task 17: GitHub Actions — CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write CI**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ts:
    name: TypeScript
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      - run: pnpm -r test
      - run: pnpm -r lint

  python:
    name: Python
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ["3.11", "3.12", "3.13"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
      - name: Install
        working-directory: python
        run: |
          pip install -e ".[dev]"
      - name: Test
        working-directory: python
        run: pytest -v
      - name: Lint
        working-directory: python
        run: ruff check .

  docker:
    name: Docker build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Build (no push)
        uses: docker/build-push-action@v6
        with:
          context: .
          file: packages/server/Dockerfile
          push: false
          tags: pii-proxy:ci
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: GitHub Actions workflow for TS, Python, Docker build"
```

---

### Task 18: GitHub Actions — Release

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write Release Workflow**

`.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency: ${{ github.workflow }}-${{ github.ref }}

jobs:
  release:
    name: Release via changesets
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      id-token: write
      packages: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          registry-url: "https://registry.npmjs.org"

      - run: pnpm install --frozen-lockfile

      - name: Create release PR or publish
        id: changesets
        uses: changesets/action@v1
        with:
          publish: pnpm release
          title: "chore: release"
          commit: "chore: release packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Log in to GHCR
        if: steps.changesets.outputs.published == 'true'
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push Docker image
        if: steps.changesets.outputs.published == 'true'
        uses: docker/build-push-action@v6
        with:
          context: .
          file: packages/server/Dockerfile
          push: true
          tags: |
            ghcr.io/whitestag-ai/pii-proxy:latest
            ghcr.io/whitestag-ai/pii-proxy:${{ fromJson(steps.changesets.outputs.publishedPackages)[0].version }}

      - name: Publish Python package
        if: steps.changesets.outputs.published == 'true'
        working-directory: python
        run: |
          pip install build twine
          python -m build
          twine upload dist/* -u __token__ -p ${{ secrets.PYPI_TOKEN }}
```

**Note:** This workflow assumes the Python package version is bumped manually to match the TS packages. For strict parity, add a Python-version-sync step later.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: release workflow publishing to npm, GHCR, PyPI"
```

---

### Task 19: GitHub ISSUE_TEMPLATE, PULL_REQUEST_TEMPLATE, CODEOWNERS

**Files:**
- Create: `.github/ISSUE_TEMPLATE/bug_report.md`
- Create: `.github/ISSUE_TEMPLATE/feature_request.md`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `.github/CODEOWNERS`

- [ ] **Step 1: `.github/ISSUE_TEMPLATE/bug_report.md`**

```markdown
---
name: Bug report
about: Something isn't working
title: "[bug] "
labels: bug
---

## Reproduction

```bash
# commands you ran
```

## Expected

## Actual

## Environment

- pii-proxy version:
- Deployment: docker / launchd / systemd / npx / other
- Classifier: (Ollama model / LM Studio model / …)
- OS:

## Audit log snippet (redacted)

Please include a few lines from `pii-proxy-YYYY-MM-DD.jsonl` if relevant. Redact anything sensitive.
```

- [ ] **Step 2: `.github/ISSUE_TEMPLATE/feature_request.md`**

```markdown
---
name: Feature request
about: Suggest an improvement
title: "[feat] "
labels: enhancement
---

## Problem

What are you trying to do that's currently awkward?

## Proposed solution

## Alternatives considered

## GDPR relevance

Does this touch the anonymisation contract, audit log, or mapping store? If yes, explain.
```

- [ ] **Step 3: `.github/PULL_REQUEST_TEMPLATE.md`**

```markdown
## Summary

## Changeset

Have you run `pnpm changeset`? (required for anything affecting published packages)

- [ ] Yes
- [ ] N/A (docs-only / CI-only)

## Tests

- [ ] Added / updated tests
- [ ] All tests pass locally (`pnpm test` and `pytest` if touching Python)

## Security

- [ ] This PR does not change the anonymisation or audit contract
- [ ] OR: the contract change is documented in SECURITY.md / ARCHITECTURE.md
```

- [ ] **Step 4: `.github/CODEOWNERS`**

```
# Global owner
*       @walterschoenenbroecher

# Security-critical paths require review
/packages/core/src/mapping-store.ts    @walterschoenenbroecher
/packages/core/src/entity-classifier.ts @walterschoenenbroecher
/packages/server/src/auth.ts            @walterschoenenbroecher
/SECURITY.md                            @walterschoenenbroecher
```

- [ ] **Step 5: Commit**

```bash
git add .github/ISSUE_TEMPLATE/ .github/PULL_REQUEST_TEMPLATE.md .github/CODEOWNERS
git commit -m "chore: issue templates, PR template, codeowners"
```

---

## Phase 7 — Paperclip-Plugin

### Task 20: paperclip-plugin-pii-proxy Repo scaffold

**Files:**
- Create: `~/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/paperclip-plugin-pii-proxy/`

- [ ] **Step 1: Scaffold**

```bash
cd "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/paperclip-plugin-pii-proxy"
git init
git branch -m main
```

- [ ] **Step 2: `.gitignore`, `LICENSE`**

```bash
cat > .gitignore <<'EOF'
node_modules/
dist/
*.log
.DS_Store
.env
EOF

curl -s https://www.apache.org/licenses/LICENSE-2.0.txt > LICENSE
cat >> LICENSE <<'EOF'

APPENDIX: Copyright notice
Copyright 2026 WHITESTAG.AI (Walter Schönenbröcher)
EOF
```

- [ ] **Step 3: `package.json`**

```json
{
  "name": "@whitestag-ai/paperclip-plugin-pii-proxy",
  "version": "0.1.0",
  "description": "Paperclip plugin exposing pii-proxy as a gate for external LLM calls",
  "keywords": ["paperclip", "plugin", "pii-proxy", "gdpr"],
  "type": "module",
  "main": "./dist/worker.js",
  "files": ["dist", "manifest.json"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@whitestag-ai/pii-proxy-core": "^0.1.0"
  },
  "devDependencies": {
    "@paperclipai/plugin-sdk": "^1.0.0",
    "@types/node": "^25.6.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/whitestag-ai/paperclip-plugin-pii-proxy.git"
  },
  "license": "Apache-2.0",
  "author": "WHITESTAG.AI <whitestagvr@gmail.com>"
}
```

- [ ] **Step 4: `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 5: Plugin-Manifest + Worker + Stub**

`src/manifest.ts`:

```ts
import { definePlugin } from "@paperclipai/plugin-sdk";

export default definePlugin({
  id: "pii-proxy",
  name: "pii-proxy",
  version: "0.1.0",
  description: "GDPR-compliant anonymisation gate for LLM calls via pii-proxy server",
  settings: {
    baseUrl: {
      type: "string",
      default: "http://localhost:4711",
      description: "pii-proxy server URL",
    },
    sharedKey: {
      type: "secret",
      description: "Shared secret for X-PII-Proxy-Key header",
    },
  },
});
```

`src/worker.ts`:

```ts
import { createPiiProxyClient } from "@whitestag-ai/pii-proxy-core";

export async function initialize(settings: { baseUrl: string; sharedKey: string }) {
  const client = createPiiProxyClient(settings);
  const health = await client.health();
  if (health.classifier !== "reachable") {
    throw new Error("pii-proxy classifier is not reachable");
  }
  return client;
}
```

- [ ] **Step 6: README + commit**

`README.md`:

```markdown
# @whitestag-ai/paperclip-plugin-pii-proxy

Paperclip plugin that routes outgoing LLM calls through a [pii-proxy](https://github.com/whitestag-ai/pii-proxy) server for GDPR-compliant anonymisation.

Requires a running pii-proxy server — see the [main project](https://github.com/whitestag-ai/pii-proxy) for install instructions.

## Install

In your Paperclip instance:

```bash
paperclip plugin install @whitestag-ai/paperclip-plugin-pii-proxy
```

Configure `baseUrl` (e.g. `http://host.docker.internal:4711`) and `sharedKey` via the plugin settings UI.

## License

Apache-2.0 © WHITESTAG.AI
```

```bash
git add .
git commit -m "chore: initial scaffold for Paperclip plugin"
```

---

## Phase 8 — Release v0.1.0

### Task 21: Initial Changeset + Version-Bump im pii-proxy-Repo

- [ ] **Step 1: Ins pii-proxy-Verzeichnis wechseln**

```bash
cd "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/pii-proxy"
```

- [ ] **Step 2: Initial-Changeset**

```bash
pnpm changeset
```

Interaktiv auswählen:
- Packages: `@whitestag-ai/pii-proxy-core`, `@whitestag-ai/pii-proxy-server`
- Bump: `minor` (0.0.0 → 0.1.0)
- Summary:
  ```
  Initial public release.

  - @whitestag-ai/pii-proxy-core: Library for PII detection, pseudonymisation, and mapping-store management
  - @whitestag-ai/pii-proxy-server: Fastify HTTP server exposing anonymize/deanonymize/safe-call endpoints with X-PII-Proxy-Key auth

  See README for quick start and architecture overview.
  ```

- [ ] **Step 3: Commit**

```bash
git add .changeset/*.md
git commit -m "chore: initial v0.1.0 changeset"
```

- [ ] **Step 4: Version-Bump (lokal, ohne Publish)**

```bash
pnpm changeset version
```

Dies erzeugt `CHANGELOG.md`, bumpt die `package.json`-Versions, und löscht den `.changeset/*.md`-Eintrag.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: release v0.1.0"
```

---

### Task 22: GitHub-Remote anlegen, push

- [ ] **Step 1: Remote hinzufügen**

```bash
cd "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/pii-proxy"
git remote add origin git@github.com:whitestag-ai/pii-proxy.git
```

(SSH setzt einen konfigurierten SSH-Key gegen GitHub voraus. Falls nicht, HTTPS mit PAT nutzen.)

- [ ] **Step 2: Initial push**

```bash
git push -u origin main
```

Erwartung: Walter hat den leeren Repo `whitestag-ai/pii-proxy` vorab in der GitHub-Org angelegt. Falls nicht: über `gh` erstellen:

```bash
gh repo create whitestag-ai/pii-proxy --public --source=. --remote=origin --push
```

- [ ] **Step 3: Secrets setzen**

```bash
gh secret set NPM_TOKEN --repo whitestag-ai/pii-proxy
# value: npm automation token aus https://www.npmjs.com/settings/<user>/tokens

gh secret set PYPI_TOKEN --repo whitestag-ai/pii-proxy
# value: pypi token aus https://pypi.org/manage/account/token/
```

- [ ] **Step 4: Tag für ersten Release**

```bash
git tag v0.1.0
git push origin v0.1.0
```

- [ ] **Step 5: Plugin-Repo analog**

```bash
cd "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/paperclip-plugin-pii-proxy"
git add .
git commit -m "chore: v0.1.0 scaffold"
gh repo create whitestag-ai/paperclip-plugin-pii-proxy --public --source=. --remote=origin --push
```

---

## Phase 9 — Ankündigung

### Task 23: Blog-Post-Draft

**Files:**
- Create: `BLOG_POST.md` (im pii-proxy Repo unter `docs/` oder separat)

- [ ] **Step 1: Draft schreiben**

`docs/announcements/2026-04-22-release.md`:

```markdown
# Introducing pii-proxy: a GDPR-compliant anonymisation gate for your LLM calls

*Published 2026-04-22 by WHITESTAG.AI*

## The problem

If you're an EU company running customer-facing features on top of Claude, GPT, or Gemini, you've probably had this conversation:

- Legal: "Does this send PII to US servers?"
- Eng: "Well, technically yes, but it's in the prompt, not in structured data."
- Legal: "Still PII. Still Art. 6, Art. 9, Art. 32. Fix it."

The usual fixes are some mix of: regex-masking, an NER model you half-wire up, a custom middleware that drifts out of sync with your actual API calls. We've been there. Every time, the gate gets bypassed by some new workflow nobody told you about.

## What pii-proxy is

A small HTTP server you run yourself, that sits between your app and the external LLM. Every call goes through one of three endpoints:

- `POST /anonymize` — pseudonymises a prompt, returns pseudonymised text + a mapping ID
- `POST /deanonymize` — restores pseudonyms from a response
- `POST /safe-call` — one-shot: anonymise, call external LLM, deanonymise

Detection is two-stage: deterministic regexes for emails, IBAN, phone, VAT-ID, tax IDs, BIC, postcodes, URLs; plus a local instruction-tuned LLM (Gemma, Qwen, Mistral) that catches named entities and trade secrets. Art. 9 detections → blocked, period. Classifier offline → blocked, period. No silent leakage.

## Why we built it

We were gluing Claude and OpenAI into an internal workflow tool and kept running into the same audit conversation. Regex isn't enough (misses names, companies, contextual PII). Cloud-hosted "PII redaction" services send your data to… yet another cloud. The OSS landscape is fragmented: Presidio is solid for NER but doesn't speak "I'll hold the mapping and restore it for you". LangChain's privacy guards are opinionated toys. So we built the missing piece.

## What's in the box

- **`@whitestag-ai/pii-proxy-core`** — TS library: detectors, classifier wrapper, AES-256-GCM mapping store, JSONL audit log
- **`@whitestag-ai/pii-proxy-server`** — Fastify HTTP gate with shared-secret auth, Telegram alerting, monitor loop
- **`pii-proxy`** (PyPI) — Python client with a pythonic API
- **Deployment**: Docker image (`ghcr.io/whitestag-ai/pii-proxy`), systemd unit, macOS launchd plist
- **Integrations**: n8n sub-workflow, LangChain snippet, raw curl recipes, Paperclip plugin (separate repo)

## Quick start

```bash
docker compose up -d  # (see README for the one-liner)
curl -X POST localhost:4711/anonymize \
  -H "x-pii-proxy-key: $KEY" \
  -d '{"text":"Max Mustermann (max@example.com)","targetLlm":"gpt-4o","agent":"demo"}'
```

Full quick-start, including macOS and Linux deployments, is in the [README](https://github.com/whitestag-ai/pii-proxy).

## License

Apache-2.0. We want this to be used.

## Contributions welcome

Especially: testing new classifier models (see `docs/MODELS.md`), Python async client, additional integrations (Make, Zapier, custom SDKs).

— Walter @ WHITESTAG.AI
```

- [ ] **Step 2: Commit + push**

```bash
cd "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/pii-proxy"
mkdir -p docs/announcements
# (write the file above)
git add docs/announcements/
git commit -m "docs: v0.1.0 announcement post"
git push
```

- [ ] **Step 3: Post-Distribution (manuell)**

Wo Walter den Post teilen kann:
- LinkedIn-Post (Link + 150-Wort-Teaser)
- Hacker News „Show HN: pii-proxy" (Titel: „Show HN: pii-proxy — a GDPR-compliant anonymisation gate for LLM calls")
- r/LocalLLaMA (fits perfectly — DSGVO + Local-Classifier-Thematik)
- DSGVO-Mastodon (DSB-Community)
- LangChain Discord + Ollama Discord (spez. #showcase-Kanäle)

Nicht im Scope dieses Plans — Task steht nur dokumentierend hier.

---

## Done Criteria

- [ ] Repo `whitestag-ai/pii-proxy` ist public, `v0.1.0` ist getaggt
- [ ] CI grün auf main (TS, Python 3.11+3.12+3.13, Docker build)
- [ ] Release-Workflow konfiguriert mit `NPM_TOKEN` + `PYPI_TOKEN` + `GHCR`
- [ ] `@whitestag-ai/pii-proxy-core@0.1.0` auf npm
- [ ] `@whitestag-ai/pii-proxy-server@0.1.0` auf npm
- [ ] `pii-proxy@0.1.0` auf PyPI
- [ ] `ghcr.io/whitestag-ai/pii-proxy:0.1.0` + `:latest` verfügbar
- [ ] Repo `whitestag-ai/paperclip-plugin-pii-proxy` ist public, scaffold committed
- [ ] README, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, docs/ (CONFIG, MODELS, INTEGRATIONS, ARCHITECTURE) vorhanden
- [ ] Ankündigungs-Post als Draft bereit

## Was dieser Plan explizit NICHT umfasst

- Kein Python-Async-Client (`AsyncPiiProxyClient`) — Follow-up
- Keine Audit-Log-Rotation (verlassen sich auf externe Tools wie logrotate)
- Keine automatische Python-Version-Sync-Logik im Release-Workflow — manuell gleichziehen
- Keine Paperclip-Plugin-Integration-Tests — Scaffold-Only, echter Plugin-Flow erfordert laufende Paperclip-Instance
- Kein Security-Audit durch Dritte — empfohlen vor größerem Kundenwerbepush
- Kein Marketing-Push auf Social — Post liegt als Draft im Repo
