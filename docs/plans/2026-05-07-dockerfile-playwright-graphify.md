# Dockerfile: Playwright + Graphify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development ou superpowers:executing-plans. Steps usam `- [ ]` para tracking.

**Goal:** Adicionar Playwright (com Chromium + system deps) e Graphify (knowledge graph CLI) à imagem Docker do Paperclip, com Playwright usando SOCKS5 proxy via host (`PLAYWRIGHT_PROXY_SERVER`), preservando o volume `/paperclip` em rebuild.

**Architecture:** Modificar `Dockerfile` no monorepo Paperclip (raiz do worktree) adicionando duas camadas no estágio `production`: (1) `npx playwright install --with-deps chromium` movido pra `/opt/playwright` (env já setada); (2) `pipx install graphifyy && graphify install` instalando o CLI globalmente. Compose já tem `PLAYWRIGHT_PROXY_SERVER`, só ajustar valor pra `socks5://host.docker.internal:18081` (porta dedicada que **o usuário sobe externamente** via `ssh -fN -D 0.0.0.0:18081 ...`). Rebuild com `docker compose build server` preserva volumes nomeados.

**Tech Stack:** Docker (Dockerfile multi-stage), Playwright (npm package + system browsers), Graphify (Python via pipx), SOCKS5 proxy via SSH dynamic forward.

**Spec:** Vide pedido do usuário em conversa — instalar Playwright com proxy + Graphify, persistir após restart, sem afetar plugin Plan A.

**Premissas:**
- Worktree atual `relaxed-hypatia-3bab19` é onde dev acontece. Rebuild da imagem real depende de merge pro master e build de `/home/luis/projetos/paperclip/` (que é o `build.context` do compose).
- Proxy SSH SOCKS5 dedicado escutando em `0.0.0.0:18081` é responsabilidade do usuário (comando: `ssh -fN -D 0.0.0.0:18081 <gateway>`). Plano assume disponível antes do smoke test.
- Container atual: `docker-paperclip-1` rodando há 28h. Rebuild = breve downtime (~3-5min).
- Volume `paperclip-data:/paperclip` mantém estado (DB embedded, configs, skills).

---

## File Structure

```
/home/luis/projetos/paperclip/                       # main repo (build context do compose)
├── Dockerfile                                       # T2, T3 — adicionar 2 layers no stage production
└── docker/
    ├── docker-compose.yml                           # T4 — ajustar PLAYWRIGHT_PROXY_SERVER se necessário
    └── docker-compose.quickstart.yml                # T4 — idem (var default)

(no worktree relaxed-hypatia-3bab19, mesmas paths via .git compartilhado;
 mudanças commitadas aqui devem ser merged pro master antes do rebuild)
```

---

## Task 1: Pré-requisitos (read-only)

**Files:** nenhum. Validações.

- [ ] **Step 1: Confirmar que o usuário subiu o SSH SOCKS5 dedicado em 0.0.0.0:18081**

Run no host:
```bash
ss -tlnp 2>/dev/null | grep ':18081'
```

Esperado: linha com `LISTEN 0.0.0.0:18081` e processo `ssh`. Se não estiver, **PARAR** e pedir pro usuário rodar:
```bash
ssh -fN -D 0.0.0.0:18081 <usuario>@<gateway-proxy>
```

- [ ] **Step 2: Confirmar conectividade do container para 18081**

Run:
```bash
docker exec docker-paperclip-1 sh -c \
  'curl -sS --socks5 host.docker.internal:18081 -o /dev/null \
   -w "%{http_code} via %{remote_ip}\n" --max-time 5 https://api.ipify.org'
```

Esperado: `200 via <IP-do-gateway-proxy>`. Se timeout, voltar ao Step 1 (proxy não está acessível).

- [ ] **Step 3: Confirmar Plan A foi mergeado para master (opcional — só pra rebuild combinado)**

Run:
```bash
cd /home/luis/projetos/paperclip
git log --oneline master ^origin/master | grep "plugin-github-issues" | wc -l
```

Esperado: ≥1. Se 0, plugin ainda está só no worktree branch — Plan B pode prosseguir independentemente, mas o rebuild final fará mais sentido depois do merge.

---

## Task 2: Adicionar Playwright ao Dockerfile (TDD)

**Files:**
- Modify: `/home/luis/projetos/paperclip/Dockerfile` (worktree path: `/home/luis/projetos/paperclip/.claude/worktrees/relaxed-hypatia-3bab19/Dockerfile`)
- Test: smoke test pós-build (Step 5)

> **TDD pragmático aqui**: o "test" é o smoke test pós-build. Não escrevemos teste em código — em vez disso, definimos critério de aceitação que o build PRECISA satisfazer.

- [ ] **Step 1: Critério de aceitação (escrito antes do build)**

Após build + restart, esses comandos rodam dentro do container e devem ter sucesso:

```bash
# 1. Chromium binário existe em /opt/playwright
docker exec docker-paperclip-1 sh -c 'ls /opt/playwright/chromium-*/chrome-linux/headless_shell 2>&1 | head -1'
# Esperado: caminho válido

# 2. Playwright Node API consegue lançar Chromium via proxy
docker exec docker-paperclip-1 sh -c 'cd /tmp && node -e "
import(\"playwright\").then(async ({ chromium }) => {
  const b = await chromium.launch({ proxy: { server: process.env.PLAYWRIGHT_PROXY_SERVER } });
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  await page.goto(\"https://api.ipify.org\", { timeout: 10000 });
  console.log(await page.textContent(\"body\"));
  await b.close();
})"' 2>&1 | tail -5
# Esperado: IP do gateway proxy (NÃO o IP direto de saída do host)
```

- [ ] **Step 2: Editar Dockerfile — adicionar layer Playwright no stage production**

Localizar no `Dockerfile` o bloco do stage `production` (linha ~50-56), entre `RUN npm install --global ... opencode-ai \` e `COPY scripts/docker-entrypoint.sh`.

Modificar de:

```dockerfile
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip
```

Para:

```dockerfile
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai playwright \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq \
  && PLAYWRIGHT_BROWSERS_PATH=/opt/playwright npx --yes playwright install --with-deps chromium \
  && chmod -R a+rX /opt/playwright \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip
```

> Notas: `playwright` é instalado globalmente como dependência Node (necessário pro `npx playwright install`). `--with-deps` instala libs de sistema do Chromium (libnss, libxkb, etc.). `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright` força os browsers pra esse path estável (env var já está setada no Dockerfile via `ENV`). `chmod a+rX` garante que `node` user (não-root) consegue executar.

- [ ] **Step 3: Confirmar que `ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright` está no bloco ENV (já está em produção atual)**

Verificar bloco `ENV` no Dockerfile (linhas ~60-72). Já tem? OK, sem mudança. Se faltar, adicionar.

- [ ] **Step 4: Commit — apenas a mudança do Dockerfile**

```bash
cd /home/luis/projetos/paperclip/.claude/worktrees/relaxed-hypatia-3bab19
git add Dockerfile
git commit -m "feat(docker): install Playwright + Chromium with SOCKS5 proxy support"
```

- [ ] **Step 5: Build local + smoke (rodar APÓS Task 4 também)**

Não rodar build aqui ainda — rebuild faz parte de Task 5 que combina com Graphify. Step 1 (critério) será exercitado em Task 6.

---

## Task 3: Adicionar Graphify ao Dockerfile

**Files:**
- Modify: `/home/luis/projetos/paperclip/Dockerfile` (mesmo arquivo da Task 2)

- [ ] **Step 1: Critério de aceitação**

Após build + restart:

```bash
docker exec docker-paperclip-1 graphify --version 2>&1 | head -1
# Esperado: versão do graphify (algo como "graphifyy 0.x.y")

docker exec docker-paperclip-1 sh -c 'graphify install --check 2>&1 || graphify install 2>&1' | head -5
# Esperado: instalação ok ou já instalado em runtime targets (Claude Code, Codex, etc.)
```

- [ ] **Step 2: Editar Dockerfile — adicionar layer Graphify**

Após o bloco que adiciona Playwright (Task 2 Step 2), adicionar nova `RUN` step:

```dockerfile
# Graphify — knowledge graph CLI (Karpathy LLM Wiki pattern)
RUN apt-get update \
  && apt-get install -y --no-install-recommends pipx python3-venv \
  && pipx install graphifyy \
  && /root/.local/bin/graphify install --skill-only 2>/dev/null || /root/.local/bin/graphify install \
  && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:${PATH}"
```

> Notas:
> - `pipx` instala `graphifyy` (note dois `y`) em ambiente isolado em `/root/.local/`.
> - O `graphify install` registra a skill em todos os agent runtimes detectados na imagem (Claude Code + Codex já estão).
> - `--skill-only` evita tentativas de modificar `~/.claude.json` global em build (que podem falhar). Fallback chama install padrão.
> - Adicionar `/root/.local/bin` ao PATH garante que `graphify` é invocável tanto pelo user `root` quanto via env exportado pra subprocessos.
> - Para o user `node` (UID 1000), o binário ainda é acessível via path absoluto `/root/.local/bin/graphify` (chmod default da pipx é 755). Se necessário, criar symlink em `/usr/local/bin`.

- [ ] **Step 3: Symlink em /usr/local/bin (acesso pelo user node)**

Adicionar no mesmo `RUN` ou logo após:

```dockerfile
RUN ln -s /root/.local/bin/graphify /usr/local/bin/graphify
```

Garante que `node` user (que é o user padrão do entrypoint do Paperclip) chama `graphify` direto.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "feat(docker): install Graphify (Karpathy LLM Wiki) skill globally"
```

---

## Task 4: Compose — apontar Playwright proxy pra 18081

**Files:**
- Modify: `/home/luis/projetos/paperclip/docker/docker-compose.yml`
- Modify: `/home/luis/projetos/paperclip/docker/docker-compose.quickstart.yml` (default)

- [ ] **Step 1: Editar `docker-compose.yml`**

Localizar linha ~34:
```yaml
PLAYWRIGHT_PROXY_SERVER: "socks5://host.docker.internal:18080"
```

Trocar pra:
```yaml
PLAYWRIGHT_PROXY_SERVER: "socks5://host.docker.internal:18081"
```

- [ ] **Step 2: Editar `docker-compose.quickstart.yml`**

Localizar linha ~13 (default da var):
```yaml
PLAYWRIGHT_PROXY_SERVER: "${PLAYWRIGHT_PROXY_SERVER:-socks5://host.docker.internal:18080}"
```

Trocar default pra:
```yaml
PLAYWRIGHT_PROXY_SERVER: "${PLAYWRIGHT_PROXY_SERVER:-socks5://host.docker.internal:18081}"
```

- [ ] **Step 3: Commit**

```bash
git add docker/docker-compose.yml docker/docker-compose.quickstart.yml
git commit -m "chore(docker): point Playwright proxy to dedicated SOCKS5 :18081"
```

---

## Task 5: Rebuild da imagem + restart preservando volume

**Files:** nenhum. Operação Docker.

> **Pré-requisito**: pra rebuild ter efeito real, mudanças do Dockerfile precisam estar em `/home/luis/projetos/paperclip/Dockerfile` (path do compose `build.context`). Se você está no worktree `relaxed-hypatia-3bab19`, **merge pro master primeiro**:

- [ ] **Step 1: Merge worktree → master (se ainda não)**

```bash
cd /home/luis/projetos/paperclip
git status     # confirmar working tree clean
git checkout master
git merge --ff-only claude/relaxed-hypatia-3bab19 2>&1 | tail
```

Esperado: fast-forward bem-sucedido. Se conflito, resolver manualmente (não esperado já que worktree foi rebased).

- [ ] **Step 2: Backup do volume (segurança)**

```bash
docker run --rm -v paperclip-data:/data:ro -v /tmp:/backup alpine \
  tar czf /backup/paperclip-data-$(date +%Y%m%d-%H%M).tar.gz -C /data .
```

Esperado: arquivo `/tmp/paperclip-data-*.tar.gz` criado. Validar tamanho > 100MB (DB embedded ocupa espaço).

- [ ] **Step 3: Rebuild da imagem**

```bash
cd /home/luis/projetos/paperclip/docker
docker compose build server 2>&1 | tail -30
```

Esperado: build completo sem erro. Tempo estimado: 5-10min (download de Chromium + Graphify pesa). Se `npx playwright install` falhar por rede, repetir.

- [ ] **Step 4: Restart preservando volumes**

```bash
docker compose up -d server
docker ps --filter name=docker-paperclip-1 --format '{{.Status}}'
```

Esperado: `Up X seconds (healthy)` em ~30s. Se unhealthy, `docker compose logs server | tail -50` pra investigar.

- [ ] **Step 5: Sanity check do container**

```bash
docker exec docker-paperclip-1 sh -c 'ls /paperclip/instances/default/' | head -10
```

Esperado: `companies/`, `config.json`, `db/`, `data/`, `logs/`, `.env` — todos presentes (volume preservado).

---

## Task 6: Smoke test Playwright via proxy

**Files:** nenhum. Validação operacional do critério de Task 2 Step 1.

- [ ] **Step 1: Verificar binário Chromium existe**

```bash
docker exec docker-paperclip-1 sh -c 'ls /opt/playwright/chromium-*/chrome-linux/ 2>&1 | head -5'
```

Esperado: arquivo `headless_shell` (ou `chrome`) presente.

- [ ] **Step 2: Lançar Chromium via Playwright API com proxy**

```bash
docker exec docker-paperclip-1 sh -c 'mkdir -p /tmp/pw-smoke && cd /tmp/pw-smoke && \
  npm init -y >/dev/null 2>&1 && \
  npm install --no-save playwright >/dev/null 2>&1 && \
  node -e "
const { chromium } = require(\"playwright\");
(async () => {
  const b = await chromium.launch({
    proxy: { server: process.env.PLAYWRIGHT_PROXY_SERVER },
  });
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  const resp = await page.goto(\"https://api.ipify.org\", { timeout: 15000 });
  console.log(\"status:\", resp.status());
  console.log(\"body:\", await page.textContent(\"body\"));
  await b.close();
})().catch(e => { console.error(\"ERR:\", e.message); process.exit(1); });
"'
```

Esperado:
- `status: 200`
- `body: <IP-do-gateway-proxy>` — **deve ser diferente** do IP que o container saía sem proxy (104.26.12.205 no diagnóstico inicial). Se for igual, proxy não está sendo usado.

- [ ] **Step 3: Comparar com saída sem proxy (controle)**

```bash
docker exec docker-paperclip-1 curl -s https://api.ipify.org
# saída direta do container (sem proxy)

docker exec docker-paperclip-1 curl -s --socks5 host.docker.internal:18081 https://api.ipify.org
# saída via proxy SOCKS5
```

Esperado: dois IPs **diferentes**. O segundo é o IP do gateway proxy.

---

## Task 7: Smoke test Graphify

**Files:** nenhum. Validação operacional.

- [ ] **Step 1: Versão**

```bash
docker exec docker-paperclip-1 graphify --version 2>&1 | head -1
```

Esperado: linha com versão (ex: `graphifyy 0.5.0`).

- [ ] **Step 2: Help / install status**

```bash
docker exec docker-paperclip-1 graphify --help 2>&1 | head -20
docker exec -u node docker-paperclip-1 graphify install --check 2>&1 | head -10
```

Esperado: help printado, install reporta runtimes detectados (Claude Code, Codex, etc.).

- [ ] **Step 3: Smoke run em diretório /tmp**

```bash
docker exec docker-paperclip-1 sh -c 'mkdir -p /tmp/gf-smoke && \
  echo "# Test\nThis is a sample." > /tmp/gf-smoke/README.md && \
  cd /tmp/gf-smoke && graphify --no-llm 2>&1 | tail -10'
```

Esperado: produz `graph.json`/`graph.html`/`GRAPH_REPORT.md` (mesmo que vazio com 1 arquivo). `--no-llm` evita chamadas LLM no smoke; remova pra teste real.

---

## Task 8: Persistência verificada

**Files:** nenhum.

- [ ] **Step 1: Restart do container**

```bash
docker compose -f /home/luis/projetos/paperclip/docker/docker-compose.yml restart server
sleep 10
```

- [ ] **Step 2: Re-rodar smoke tests**

Repetir Task 6 Step 2 e Task 7 Step 1. Esperado: ambos continuam funcionando — Playwright e Graphify estão na imagem (não no volume), persistem.

- [ ] **Step 3: Restart do host inteiro (opcional, se possível)**

Se possível, reiniciar a máquina e ver que `docker compose up -d` traz tudo de volta funcionando. Se não puder testar, documentar como pendente.

---

## Self-Review

**Spec coverage:**
- Playwright instalado com Chromium + system deps → Task 2 ✓
- Playwright usa proxy SOCKS5 :18081 → Task 4 + Task 6 ✓
- Graphify instalado e disponível pro user `node` → Task 3 + symlink ✓
- Persiste após restart (está na imagem, não em volume mutável) → Task 8 ✓
- Volume `/paperclip` preservado → Task 5 backup + Step 5 sanity ✓
- Não afeta Plan A (plugin) → Dockerfile changes são só no stage production, sem mexer em build do server ✓

**Placeholder scan:** Sem TBDs. Todos comandos exatos.

**Dependências externas:**
- Usuário precisa ter SSH SOCKS5 dedicado em `0.0.0.0:18081` antes de Task 6 (Task 1 valida).
- Plan A pode ou não estar mergeado — Plan B independe disso pra desenvolvimento, mas rebuild final faz sentido depois do merge pra trazer ambos juntos.

---

## Plan Status

**Saved to:** `docs/plans/2026-05-07-dockerfile-playwright-graphify.md`

**Total tasks:** 8
**Estimated time:** 1-2h (build da imagem domina; ~10min de download Chromium + 2-3min Graphify).
**Critical path:** Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8.

**Riscos:**
- Network durante `npx playwright install --with-deps chromium` pode falhar se proxy do build host não cooperar. Workaround: rodar build em janela de rede livre, ou usar `playwright install --no-shell` se não precisar do shell (não é o caso aqui).
- Imagem cresce significativamente (~500MB-1GB) por conta do Chromium + libs de sistema. Aceitável.
- Pipx pode falhar se Python 3 não estiver disponível — Dockerfile já tem `python3` instalado em base (linha 7), confirmado.
