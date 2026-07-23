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

### 4. Instalar o opencode.json no volume — uma vez só

O paperclip-server (UID 1000) precisa **ler e copiar** o `opencode.json` antes de cada run. Tentar injetar via `configs:` do Docker Compose não funciona — o Docker monta configs como root:root sem leitura pra "other", causando `EACCES copyfile` em `prepareOpenCodeRuntimeConfig()`. A solução é gravar o arquivo direto no volume bind.

**One-liner** (na VPS, baixa do repo direto via curl — sem precisar clonar nada):

```bash
curl -fsSL https://raw.githubusercontent.com/victorbvieira/paperclip/prod/deploy/dockploy/scripts/install-opencode-config.sh | sudo bash
```

O script cria `/opt/paperclip/.config/opencode/opencode.json`, faz chown pra UID 1000 e seta `0644`. Como `/opt/paperclip` está bind-mountado em `/paperclip` no container, o paperclip vê em `/paperclip/.config/opencode/opencode.json` e consegue ler.

Atualizou o `opencode.json` no repo? Rode o one-liner de novo pra propagar.

### 5. Login ChatGPT (assinatura) — uma vez só

Depois que o container subir e a migração rodar:

```bash
# IMPORTANTE: use `-u node` — o container roda o server como UID 1000 (node)
# por causa do `gosu node` do entrypoint. Sem `-u node`, o docker exec entra
# como root (UID 0) e os arquivos criados ficam root:root 0600, que o server
# (UID 1000) NÃO consegue ler depois.
docker exec -u node -it paperclip bash
codex login
# escolha "Sign in with ChatGPT"
# abra a URL impressa NO SEU NAVEGADOR (não no servidor)
# autorize → o codex grava /paperclip/.codex/auth.json
exit
```

O `auth.json` fica persistido em `/opt/paperclip/.codex/auth.json` na VPS. Sobrevive a `docker compose down`, rebuild da imagem e atualizações.

Para revalidar:
```bash
docker exec -u node paperclip codex whoami     # mostra a conta ChatGPT logada
```

> **Se já fez `codex login` sem `-u node`:** os arquivos ficaram root:root e o paperclip não consegue ler. Conserte com:
> ```bash
> docker exec paperclip chown -R node:node /paperclip/.codex /paperclip/.local /paperclip/.config /paperclip/.cache /paperclip/.claude /paperclip/.claude.json
> ```

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

### Codex adapter test falha com "Codex hello probe failed" / "Permission denied (os error 13)"

Causa quase sempre: você rodou `docker exec -it paperclip codex login` **sem `-u node`**, o que criou `/paperclip/.codex/auth.json` como root:root 0600. O server (UID 1000) não consegue ler. Conserte:
```bash
docker exec paperclip chown -R node:node /paperclip/.codex /paperclip/.local /paperclip/.config /paperclip/.cache /paperclip/.claude /paperclip/.claude.json
```

Se persistir após o chown, o erro pode ser **Codex git-repo check**: o probe roda em cwd `/app` que não é um git repo trusted. No adapter config do agente, em "Extra args" cole:
```json
["--skip-git-repo-check"]
```

### OpenCode adapter test falha com "PermissionDenied: FileSystem.readFile (/tmp/paperclip-opencode-config-…)"

Mesma causa: algum arquivo em `/paperclip/.local/share/opencode/` ou `/paperclip/.config/opencode/` ficou root:root depois de comando interativo sem `-u node`. Mesmo fix do chown acima.

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

### `failed to set up container networking: Could not attach to network interna: NotFound`

Causa: o serviço declara `networks: [interna]` com `external: true`, mas não existe nenhuma rede chamada literalmente `interna` no daemon Docker. A rede `interna` é uma rede compartilhada que liga o paperclip ao container Postgres `databases-postgres-cypdtq`, então **ela tem que existir** — não dá pra simplesmente remover a referência.

Diagnóstico na VPS:
```bash
# 1) Liste todas as redes do daemon e procure por "interna"
docker network ls | grep -i interna

# 2) Veja em quais redes o container do Postgres está conectado
docker inspect databases-postgres-cypdtq \
  --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'
```

Resultados possíveis e como agir:

| Saída de (1) | Saída de (2) | Causa | Fix |
|---|---|---|---|
| (vazio) | (sem rede `interna`) | Rede nunca foi criada no daemon | `docker network create interna` na VPS, depois `docker network connect interna databases-postgres-cypdtq`. Re-deploy. |
| `interna` | `interna` aparece | Rede existe e Postgres está nela — outra coisa quebrou (perm? compose v1?) | Conferir versão do compose (`docker compose version` ≥ v2.20) |
| `databases-cypdtq_interna` | `databases-cypdtq_interna` | O Dockploy prefixou a rede com o nome do projeto Postgres | No compose, ajustar: `networks: interna: { external: true, name: databases-cypdtq_interna }` |
| nenhuma `interna` mas tem `dokploy-network` | só `dokploy-network` | Você está usando a rede padrão do Dockploy, não uma custom | Trocar `networks: [interna]` por `networks: [dokploy-network]` em ambos lugares no compose |

Se a saída de (2) tiver alguma rede e a de (1) confirmar o mesmo nome, **edite o `compose.yml` para usar `name:`** apontando pro nome literal. Exemplo:
```yaml
networks:
  interna:
    external: true
    name: databases-cypdtq_interna   # ← nome real no daemon
```
O serviço continua dizendo `networks: [interna]` (alias local do compose), e o `name:` é a tradução para o daemon.

### Warning `The "schema" variable is not set. Defaulting to a blank string.`

Causa: o JSON inline em `configs.content` tem `"$schema": "..."` e o Docker Compose faz interpolação de `$VAR` em qualquer string do YAML, incluindo dentro de `content:`. A fix é escapar como `$$schema` — o compose substitui `$$` por `$` literal antes de gravar o arquivo. Já corrigido no `compose.yml` deste repo.

### Warning `The "BETTER_AUTH_SECRET" variable is not set. Defaulting to a blank string.`

Causa: a env não está definida na aba *Environment* do Dockploy. Gere com `openssl rand -base64 32` e cole lá. O paperclip não sobe sem isso (assinatura de sessão).

---

## Como manter este fork sincronizado com upstream

```bash
git fetch upstream
git merge upstream/prod      # ou rebase, se preferir histórico linear
git push origin prod
```

`deploy/dockploy/` não existe no upstream → não há conflito esperado nessa pasta.
