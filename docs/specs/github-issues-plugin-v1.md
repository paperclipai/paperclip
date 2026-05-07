# PRD — Plugin Nativo GitHub Issues → Paperclip

**Status**: Draft v0.1
**Autor**: Luis (com Claude)
**Data**: 2026-05-07
**Versão alvo**: v1 (MVP)

---

## Problem Statement

A integração atual GitHub→Paperclip (`feat/gh-issues-integration`) usa um agente externo (`gh-analyzer`) com idempotência baseada em **markers persistidos como comentários** na issue do Paperclip. O modelo é frágil: o estado de "já processado" vive **fora do banco do control plane**, recriado a cada delivery, e depende de scans server-side com filtros `q+status` e tolerância a `409`/`403` espalhada. Quando o GitHub redelivera um webhook (retentativa por timeout, retry manual, replay), o sistema **não tem garantia formal** de que a operação não vai duplicar.

**Quem sofre**: equipes que dependem do pipeline GitHub→Paperclip pra triagem automatizada de issues e roteamento de PR/CI. Em escala, redeliveries do GitHub são certeza, não exceção.

**Custo de não resolver**: tasks duplicadas no Paperclip → CEO acordando duas vezes pelo mesmo evento → tokens desperdiçados, agentes em conflito de checkout (409s "verdadeiros" mascarados pelos tolerados), confiança operacional erodida.

## Goals

1. **Idempotência por construção**: dois deliveries do mesmo `X-GitHub-Delivery` produzem **exatamente uma** task no Paperclip — garantido em 3 camadas (plataforma, plugin state, domínio).
2. **Eliminar o agente externo `gh-analyzer`** como peça da integração: lógica passa pra plugin nativo do servidor, sem state fora do DB.
3. **Lifecycle completo coberto**: criar/atualizar/fechar tasks; rotear `workflow_run` e `pull_request.merged` pra wakeups corretos.
4. **Single source of truth**: vínculo issue↔task fica em `externalRef` na própria task Paperclip, não em comentários.
5. **Zero ações destrutivas em rollback**: desligar o plugin não corrompe tasks existentes.

## Non-Goals

1. **Não substituir GlitchTip→GitHub** — esse pipeline existe e fica intocado.
2. **Não migrar tasks legadas** criadas pelo `gh-analyzer` — ficam como estão; novo plugin pega só eventos novos.
3. **Não cobrir GitHub Projects v2 sync bidirecional** nessa v1 — fica pra v2.
4. **Não implementar UI no Paperclip** pra configurar repos — config via plugin manifest + env por enquanto. UI fica pra v2.
5. **Não automatizar merge de PR** — agentes podem decidir mergear via skill, mas o plugin só **acorda** o agente, não executa merge sozinho.

## User Stories

### Operador do board
- Como operador, quero que **uma issue criada no GitHub com label `agent-eligible` apareça automaticamente como task no Paperclip** atribuída ao CEO, pra eu não precisar criar manualmente.
- Como operador, quero que **redelivery do mesmo webhook não crie task duplicada**, pra eu não ter que limpar lixo após cada incidente do GitHub.
- Como operador, quero **ver o link explícito** da task Paperclip pra issue GitHub original (URL em `externalRef.url`), pra triangular contexto.

### CEO agent
- Como CEO, quero **acordar com payload completo do evento GitHub** (`wake_payload` com `action`, `issue`, `comment`, `repo`), pra decidir contexto sem fazer roundtrip à API do GitHub.
- Como CEO, quando uma issue GitHub é editada/comentada, quero **ser acordado uma única vez por delta** com `wake_reason: github_issue_updated`, pra não reprocessar conteúdo idêntico.

### Agente de desenvolvimento
- Como dev agent dono de uma task vinculada a um PR, quando o `workflow_run` daquele PR fica verde, quero **ser acordado com `wake_reason: ci_green`** e o `head_sha`, pra continuar o trabalho (mergear, abrir review, etc.).
- Como dev agent, quando o PR é mergeado, quero que **a task vire `done` automaticamente** sem eu precisar mexer.

### Operador de segurança/confiabilidade
- Como SRE, quero que **falha de assinatura HMAC retorne 401** sem efeito colateral, pra que requests forjados não disparem nada.
- Como SRE, quero **logs estruturados de cada delivery** (`deliveryId`, `event`, `action`, `outcome`), pra auditoria e troubleshooting.

## Requirements

### Must-Have (P0) — sem isso não shippa

**Plugin foundation**
- [P0.1] Plugin TypeScript em `packages/plugins/paperclip-plugin-github-issues/` seguindo SDK `@paperclipai/plugin-sdk`.
- [P0.2] Manifest declarando `capabilities: ["webhooks.receive"]` + endpoint webhook `key: "github"` aceitando eventos `issues`, `issue_comment`, `pull_request`, `workflow_run`.
- [P0.3] Config schema com: `hmacSecret` (secret), `ceoAgentId`, `labelGate` (default `agent-eligible`), `repoToProject` (mapa).

**Idempotência (3 camadas)**
- [P0.4] **Camada plataforma**: aceitar `plugin_webhook_deliveries.deliveryId UNIQUE` do host (já existe).
- [P0.5] **Camada plugin state**: antes de qualquer mutação, `ctx.state.get({ namespace:"github", stateKey:"delivery:" + deliveryId })`. Se existe → no-op + log. Se não → set + prosseguir.
- [P0.6] **Camada domínio**: lookup de task por `externalRef: { source:"github", id: payload.issue.node_id }` antes de qualquer create. Sempre upsert, nunca insert cego.
- **Aceitação**: teste vitest envia o mesmo payload com mesmo `deliveryId` 5x; resultado: 1 task criada, 4 no-ops com log distinto.

**Lifecycle**
- [P0.7] `issues.opened` + label `agent-eligible` + repo mapeado em `repoToProject` → cria task Paperclip com `externalRef`, `assigneeAgentId: ceoAgentId`, descrição = body do GitHub + URL.
- [P0.8] `issues.edited` ou `issue_comment.created`: lookup por `externalRef`, adiciona comment Paperclip com diff/body, `POST /agents/<assignee>/wakeup` com `source: "automation"`, `reason: "github_issue_updated"`, `payload: <delta>`.
- [P0.9] `issues.closed`: lookup → `PATCH /issues/{id}` status `done`.
- [P0.10] `workflow_run.completed` com `conclusion=success`: lookup task pela linkagem PR (via `payload.workflow_run.pull_requests`) → wakeup do `assigneeAgentId` com `wake_reason: ci_green`, `payload: { headSha, runId }`.
- [P0.11] `pull_request.closed` com `merged=true`: lookup task → status `done`.
- [P0.12] Eventos não tratados: drop silencioso com log de debug.

**Segurança**
- [P0.13] Validar `X-Hub-Signature-256` com `hmacSecret`. Falha → return early com log + 401 implícito (não throw que polua delivery store).
- [P0.14] Drop de payload sem label `agent-eligible` (configurável) **antes** de qualquer mutação.
- [P0.15] Drop de eventos de repo não mapeado em `repoToProject`.

**Observabilidade**
- [P0.16] Log estruturado por delivery: `{ deliveryId, event, action, repo, outcome: "created"|"updated"|"closed"|"duplicate"|"filtered"|"error", durationMs }`.

**Testes**
- [P0.17] Vitest cobrindo: HMAC válido/inválido, dispatch por action, idempotência 5x repetidas, label gate, lifecycle completo (opened→edited→closed), workflow_run sem PR linkado.
- [P0.18] Cobertura ≥ 80% nas branches de `dispatch.ts` e `idempotency.ts`.

**Build/deploy**
- [P0.19] Build do plugin produz bundle único registrável via `~/.paperclip/adapter-plugins.json` (ou caminho equivalente do host).
- [P0.20] Plugin documentado em `README.md` com setup e config.

**Decommissioning**
- [P0.21] Plano escrito (não execução) de desligamento do `gh-analyzer` após 30 dias de operação estável do plugin.

### Should-Have (P1) — fast-follow após launch

- [P1.1] **Linker explícito PR↔task** via campo customizado em `externalRef.metadata.prNumber`, populado em `pull_request.opened` (hoje a task é vinculada via lookup heurístico).
- [P1.2] **Coalescing por janela** — múltiplos `workflow_run.completed` no mesmo `headSha` em < 60s consolidam em 1 wakeup (caso CI matrix com vários jobs).
- [P1.3] **Métricas Prometheus** expostas pelo plugin (deliveries por evento, latência, erro rate).
- [P1.4] **Comentário automático na issue GitHub** com link pra task Paperclip ("Tracked in Paperclip: <url>").
- [P1.5] **Rate limit guard** — se >100 deliveries/min do mesmo repo, plugin reporta degraded e ignora silenciosamente.

### Could-Have (P2) — design pra suportar, não construir

- [P2.1] **UI no Paperclip** pra gerenciar `repoToProject` e secrets sem editar config manualmente.
- [P2.2] **Sync bidirecional** GitHub Projects v2 ↔ Paperclip (status, custom fields).
- [P2.3] **Auto-criação de issue Paperclip sem label** se mapeamento `repoToProject` declarar `autoIngest: true`.
- [P2.4] **Webhook rotativo de secret** (rotacionar `hmacSecret` sem perder deliveries em flight).
- [P2.5] **Multi-CEO** — roteamento por repo/label pra agentes diferentes (não só CEO).

### Won't-Have (this time)

- Substituir GlitchTip.
- Migrar tasks criadas pelo `gh-analyzer`.
- Sync de comentários Paperclip → GitHub (só direção GH→PC nessa v1).
- Suporte a GitHub Enterprise Server (SaaS only por enquanto).

## Success Metrics

### Métrica primária
**Zero issues Paperclip duplicadas em 30 dias após `issue.opened`** redelivered pelo GitHub.
- **Como medir**: query SQL diária — `SELECT external_ref->>'id' AS gh_id, COUNT(*) FROM issues WHERE external_ref->>'source'='github' GROUP BY gh_id HAVING COUNT(*) > 1`. Resultado vazio = 100% sucesso.
- **Threshold de sucesso**: 0 duplicatas em 30 dias.
- **Threshold de stretch**: 0 duplicatas em 90 dias.
- **Janela de avaliação**: 30 dias rolling após go-live.

### Leading indicators (rápidos)
- **Taxa de filtragem correta**: % de eventos não-elegíveis (sem label, repo não mapeado) corretamente dropped → meta 100%.
- **Latência de criação**: tempo entre `X-GitHub-Delivery` recebido e task Paperclip criada → mediana < 2s, P95 < 5s.
- **Taxa de erro**: deliveries com `outcome: "error"` / total → < 0.5% após primeiros 3 dias.

### Lagging indicators (lentos)
- **Cobertura de pipeline**: tasks Paperclip vinculadas / issues GitHub `agent-eligible` criadas → 100% em 30d.
- **Token waste eliminado**: comparar tokens consumidos pelo CEO em 30d antes vs 30d depois — meta -20% (eliminação de wakeups duplicados).
- **Confiança operacional**: zero rollbacks/hotfixes do plugin em 60 dias.

## Open Questions

| # | Pergunta | Quem responde | Bloqueia? |
|---|---|---|---|
| OQ1 | Os **3 repos GitHub** específicos pra cadastrar — `org/repo` × 3? | Luis | Sim — webhook config |
| OQ2 | Sintoma de idempotência que motivou a redesign — issue duplicada, wakeup duplicado, ou desconfiança conceitual? | Luis | Não — afina testes |
| OQ3 | `ceoAgentId` — pegar do banco via query read-only ok? | Luis | Sim — config plugin |
| OQ4 | Estratégia de proxy pro container (a/b/c) — afeta Playwright dentro da imagem | Luis | Sim — Dockerfile |
| OQ5 | Plugin worker registration — caminho exato em `~/.paperclip/adapter-plugins.json` no container? | Engineering | Não — descobrir no Dockerfile |
| OQ6 | `workflow_run` sem `pull_requests[]` populado (push em branch sem PR) — drop ou tentar resolver via API GitHub? | Luis | Não — default drop |
| OQ7 | Quando label `agent-eligible` é **removida** depois (action `unlabeled`) — manter task ou cancelar? | Luis | Não — default manter |
| OQ8 | Plano de migração de webhooks GitHub atuais (`paperclip-watcher` → novo) — janela de overlap ou cutover? | Luis | Não — define no rollout |

## Timeline Considerations

### Dependências
- **Dockerfile changes** (Playwright + Graphify) — independente, pode ir em paralelo.
- **Master upstream rebased** — já feito no worktree `relaxed-hypatia-3bab19` (e400315c).
- **Decisão de proxy** (OQ4) — bloqueia rebuild final; não bloqueia desenvolvimento do plugin.

### Phasing sugerido

**Fase 1 — Plugin standalone** (3–5 dias)
- P0.1–P0.6 (foundation + idempotência) com testes
- Smoke test em ambiente isolado, sem GitHub real

**Fase 2 — Lifecycle completo** (2–3 dias)
- P0.7–P0.16 (todos os eventos + observabilidade)
- Testes E2E com payloads gravados de webhooks reais

**Fase 3 — Deploy + um repo piloto** (1 dia)
- Rebuild imagem com Dockerfile atualizado
- Registrar plugin no container
- Configurar webhook em **1 dos 3 repos** (menor blast radius)
- Monitorar 48h

**Fase 4 — Rollout completo** (2–3 dias)
- Adicionar webhook nos outros 2 repos
- Acompanhar métrica primária por 7 dias
- Decisão: prosseguir ou rollback

**Fase 5 — Decommissioning gh-analyzer** (após 30d operação estável)
- Plano escrito (P0.21) → execução em ciclo separado.

### Hard deadlines
- Nenhuma identificada. Spec não tem deadline contratual.

### Sugestão de janela
Começar Fase 1 imediatamente após resposta às OQ1, OQ3, OQ4. Total ~7–12 dias de calendário até rollout completo (Fase 4).
