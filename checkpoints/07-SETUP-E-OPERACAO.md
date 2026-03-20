# 07 — Setup e Operação

## Pré-requisitos

- **Node.js** 20+
- **pnpm** 9+

## Quick Start (Dev Local)

```sh
# Instalar dependências
pnpm install

# Iniciar (API + UI em http://localhost:3100)
pnpm dev
```

O banco de dados **não precisa de configuração manual** — PGlite embedded é usado automaticamente quando `DATABASE_URL` não está definido.

## Verificação Rápida

```sh
curl http://localhost:3100/api/health    # → {"status":"ok"}
curl http://localhost:3100/api/companies  # → []
```

## Variantes de Dev

| Comando | Descrição |
|---|---|
| `pnpm dev` | Modo watch (reinicia ao mudar código) |
| `pnpm dev:once` | Sem file watching |
| `pnpm dev --tailscale-auth` | Modo autenticado para rede privada |
| `pnpm paperclipai run` | Bootstrap completo one-command |

## Banco de Dados

### Modos

| `DATABASE_URL` | Modo |
|---|---|
| Não definido | Embedded PostgreSQL (`~/.paperclip/instances/default/db/`) |
| `postgres://...localhost...` | Docker PostgreSQL local |
| `postgres://...supabase.com...` | Hosted Supabase |

### Comandos DB

```sh
# Gerar migration
pnpm db:generate

# Aplicar migration
pnpm db:migrate

# Reset completo dev
rm -rf ~/.paperclip/instances/default/db
pnpm dev

# Backup manual
pnpm db:backup
```

### Backups Automáticos

- **Default**: habilitado, a cada 60 minutos, retenção de 30 dias
- **Dir**: `~/.paperclip/instances/default/data/backups`
- **Config**: `pnpm paperclipai configure --section database`

## Docker

```sh
# Build e run
docker build -t paperclip-local .
docker run -p 3100:3100 -e HOST=0.0.0.0 paperclip-local

# Compose
docker compose -f docker-compose.quickstart.yml up --build
```

## CLI (`paperclipai`)

```sh
# Saúde do sistema
pnpm paperclipai doctor

# Configuração interativa
pnpm paperclipai configure --section database
pnpm paperclipai configure --section secrets
pnpm paperclipai configure --section storage

# Gerenciamento de issues via CLI
pnpm paperclipai issue list --company-id <id>
pnpm paperclipai issue create --company-id <id> --title "Minha task"
pnpm paperclipai issue update <issue-id> --status in_progress

# Definir contexto padrão
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <id>

# Worktrees isoladas
pnpm paperclipai worktree init
pnpm paperclipai worktree:make minha-feature
```

## Testes

```sh
# Testes unitários
pnpm test:run

# Typecheck
pnpm -r typecheck

# Build completo
pnpm build

# Testes E2E
pnpm test:e2e

# Smoke tests
pnpm smoke:openclaw-join
```

## Verificação Antes de Hand-off

```sh
pnpm -r typecheck   # Verificar tipos
pnpm test:run        # Rodar testes
pnpm build           # Build de produção
```

## Secrets

```sh
# Migrar secrets inline para encrypted
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # aplicar

# Modo strict (bloqueia inline secrets)
PAPERCLIP_SECRETS_STRICT_MODE=true
```

**Key file padrão**: `~/.paperclip/instances/default/secrets/master.key`

## Scripts Importantes

| Script | Propósito |
|---|---|
| `scripts/dev-runner.mjs` | Dev mode runner |
| `scripts/build-npm.sh` | Build para npm |
| `scripts/release.sh` | Pipeline de release |
| `scripts/backup-db.sh` | Backup do banco |
| `scripts/smoke/` | Smoke tests variados |

## Variáveis de Ambiente Chave

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Conexão PostgreSQL (omitir para embedded) |
| `PAPERCLIP_HOME` | Dir raiz do Paperclip |
| `PAPERCLIP_INSTANCE_ID` | ID da instância |
| `PAPERCLIP_ENABLE_COMPANY_DELETION` | Habilitar deleção de companies |
| `PAPERCLIP_SECRETS_MASTER_KEY` | Master key para encryption |
| `PAPERCLIP_SECRETS_STRICT_MODE` | Bloquear inline secrets |
| `PAPERCLIP_DB_BACKUP_ENABLED` | Toggle backup automático |
| `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES` | Intervalo de backup |
| `HOST` | Bind address (default: 127.0.0.1) |
