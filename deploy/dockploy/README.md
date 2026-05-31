# Deploy Paperclip — Dockploy (fork victorbvieira)

Documentação **deste fork**, isolada da `docs/` oficial do paperclip. Mexer aqui não conflita com `git pull upstream prod`.

Arquivos:

| Arquivo | Para que serve |
|---|---|
| `compose.yml` | docker-compose que o Dockploy executa |
| `opencode.json` | Config OpenCode para usar Z.AI como provider (fonte de verdade, espelho do `configs:` inline no compose) |
| `.env.example` | Variáveis que o Dockploy precisa ter na seção *Environment* |

---

## Arquitetura do deploy

```
┌─────────────────────────────────────────────────────────────┐
│  Dockploy                                                    │
│  ├─ build: github.com/victorbvieira/paperclip#prod          │
│  ├─ injeta env vars (.env / Environment tab)                │
│  └─ injeta /paperclip/.config/opencode/opencode.json        │
│     via Compose `configs:` (inline)                          │
└─────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│  Container paperclip                                         │
│  HOME=/paperclip  PAPERCLIP_HOME=/paperclip                  │
│                                                              │
│  Volume bind: /opt/paperclip ↔ /paperclip                    │
│   ├─ .codex/auth.json     ← gerado por `codex login`        │
│   ├─ .config/opencode/    ← injetado pelo compose           │
│   └─ instances/default/   ← dados do paperclip              │
│                                                              │
│  CLIs instalados na imagem:                                  │
│   ├─ codex                  → adapter codex_local           │
│   ├─ claude                 → adapter claude_local          │
│   └─ opencode               → adapter opencode_local        │
└─────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│  Postgres (rede `interna` do Dockploy)                       │
│  host: databases-postgres-cypdtq                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Setup inicial (passo a passo)

### 1. No Dockploy

Na aba **Environment** do serviço paperclip, definir as variáveis em `.env.example`. A senha do Postgres é o usuário/senha que o serviço Postgres do Dockploy já tem — não é nova.

### 2. Apontar o Compose para `deploy/dockploy/compose.yml`

Em vez de colar o YAML, configure o Dockploy para usar **Compose Path** = `deploy/dockploy/compose.yml` no repo `https://github.com/victorbvieira/paperclip` branch `prod`. Assim qualquer mudança que você commitar aqui é refletida no próximo deploy.

> Se o Dockploy não suportar Compose Path remoto, mantenha um espelho do conteúdo de `compose.yml` colado direto na UI. Cuidado para reespelhar quando atualizar.

### 3. Primeiro deploy

```
Dockploy → Deploy
```

Logs esperados (sucesso):

```
[paperclip] running migrations...
[paperclip] server listening on 0.0.0.0:3100
```

### 4. Login ChatGPT (assinatura) — uma vez só

Depois que o container subir e a migração rodar:

```bash
docker exec -it paperclip bash
codex login
# escolha "Sign in with ChatGPT"
# abra a URL impressa NO SEU NAVEGADOR (não no servidor)
# autorize → o codex grava /paperclip/.codex/auth.json
exit
```

O `auth.json` fica persistido em `/opt/paperclip/.codex/auth.json` na VPS. Sobrevive a `docker compose down`, rebuild da imagem e atualizações.

Para revalidar:
```bash
docker exec paperclip codex whoami     # mostra a conta ChatGPT logada
```

### 5. Criar agentes no Paperclip UI

| Quero usar | Adapter no Paperclip UI | Configuração |
|---|---|---|
| **ChatGPT (assinatura)** | `Codex (local)` | model = `gpt-5.3-codex` (ou outro listado). **Deixar `apiKey` vazio** no adapter config. |
| **Z.AI Coding Plan** | `OpenCode (local)` | model = `zai/glm-4.6`. A env `ZAI_API_KEY` no compose já alimenta o provider via `opencode.json` injetado. |
| **Claude Code** | `Claude (local)` | `claude login` análogo ao codex login, se quiser usar assinatura. |

---

## Por que não usar o adapter `zai` nativo

Existiu nesse fork uma versão de um adapter Paperclip nativo para Z.AI (commits `00b22033` em diante na branch `prod` antiga). Foram descartados em 2026-05-30 ao alinhar `prod` local com `origin/prod` (que estava sincronizado com upstream e não tinha o adapter).

Decisão atual: usar **OpenCode como proxy para Z.AI**. Trade-offs:
- ✅ Zero código custom, sobrevive a `git pull upstream`
- ✅ OpenCode CLI já vem instalado na imagem
- ✅ Multi-provider — pode acrescentar Anthropic/OpenAI/etc no mesmo `opencode.json`
- ⚠️ A UI do Paperclip mostra o agente como `OpenCode (local)`, não como "Z.AI"; o modelo no dropdown é `zai/glm-4.6`
- ⚠️ Cota e métricas de billing aparecem agregadas pelo provider OpenCode, não específicas do Z.AI Coding Plan

Se um dia o upstream lançar um adapter `zai` nativo, basta trocar o agente para esse adapter — não precisa mexer no compose.

---

## Solução de problemas conhecidos

### `password authentication failed for user "paperclip"` (`28P01`)

Causa típica: `DATABASE_URL` no Dockploy contém o placeholder `***` em vez da senha real. Editar a env e re-deploy.

Confirmar a senha que o Postgres espera:
```bash
docker exec -it databases-postgres-cypdtq psql -U postgres -c "\du paperclip"
# se a senha for desconhecida, resetar:
docker exec -it databases-postgres-cypdtq psql -U postgres \
  -c "ALTER USER paperclip WITH PASSWORD 'NOVA_SENHA_AQUI';"
```

### `codex login` falha com "permission denied" em `/paperclip/.codex/`

Causa: o container está rodando como `user: "0:0"` (root) e gravou arquivos, depois um deploy mudou para uid 1000. Corrija:
```bash
docker exec paperclip chown -R 1000:1000 /paperclip/.codex
```

### `OpenCode (local)` não encontra o provider `zai`

Verificar dentro do container:
```bash
docker exec paperclip cat /paperclip/.config/opencode/opencode.json
docker exec paperclip env | grep ZAI_API_KEY
docker exec paperclip opencode models   # deve listar zai/glm-4.6
```

Se o arquivo estiver vazio, o `configs:` do compose não foi aplicado — checar versão do docker compose (precisa ≥ v2.4).

### Quero atualizar a versão do paperclip

`Dockploy → Rebuild`. O build é a partir de `#prod` no repo, então `git push origin prod` antes do rebuild.

---

## Como manter este fork sincronizado com upstream

```bash
git fetch upstream
git merge upstream/prod      # ou rebase, se preferir histórico linear
git push origin prod
```

`deploy/dockploy/` não existe no upstream → não há conflito esperado nessa pasta.
