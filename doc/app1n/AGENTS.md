# app1n Org Chart — AGENTS.md

Canonical document for the app1n autonomous company running on Paperclip (cockpit fork).

## Roles

| Role | Agent | Adapter | Budget | Heartbeat |
|------|-------|---------|--------|-----------|
| Orquestrador | `41e643e3` | `claude_local` (Opus) | R$ 50/mês | enabled |
| Worker | `d3254111` | `claude_local` (Sonnet) | R$ 80/mês | enabled |
| Validador Pro | `9c7f2a1d` | `gemini_local` (Gemini 2.5 Pro) | R$ 30/mês | on-demand |
| Validador Cheap | `0205321a` | `gemini_local` (Flash) | R$ 10/mês | on-demand |

## Chain of Command

```
Board (Igor)
  └── Orquestrador (CEO)
        ├── Worker (IC — código, PR, commits)
        └── Validador Pro (QA adversarial + visual validation)
              └── Validador Cheap (triage rápido, smoke tests)
```

## Responsibilities

### Orquestrador
- Recebe features do backlog (`~/state/features.json`).
- Decompõe em milestones, cria issues no Paperclip.
- Delega implementação para o Worker e validação para o Validador.
- Não implementa diretamente — exceção: desbloqueio emergencial quando Worker está parado.
- Registra handoffs em `~/state/handoffs.jsonl` (§6 schema).
- Marca features como `done` após validação aprovada.
- Budget: nunca iniciar trabalho novo acima de 80% do limite.

### Worker
- Executa 1 feature por vez (serial — sem paralelismo).
- Fluxo: checkout → branch `auto/<feature-id>` → implementa → testes locais → PR via `gh pr create`.
- Comita com `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.
- Não mexe em `-prod` Cloud Run sem PR aprovado.
- Registra §6 handoff ao concluir cada milestone.
- Passa para `in_review` quando PR está aberto aguardando validação.

### Validador Pro
- Revisão adversarial de código (segurança, contrato, breaking changes).
- Validação visual: Playwright screenshot → Gemini multimodal → aprova/rejeita.
- Resultado: aprova PR ou devolve para Worker com lista de fixes obrigatórios.
- Nunca aprova sem screenshot quando há mudança visual.

### Validador Cheap
- Smoke test rápido pós-deploy.
- Triage de issues menores sem necessidade de revisão profunda.
- Custo-alvo: < R$ 0,10 por run.

## State Files

| Arquivo | Schema | Acesso |
|---------|--------|--------|
| `~/state/features.json` | v2: `{versao, missao{}, features[*]{milestones[]}}` | read-only para Workers |
| `~/state/handoffs.jsonl` | §6: `{papel, inicio, fim, tokens, concluido, pendente}` | append-only |
| `~/state/validation-contract.md` | regras do que conta como pronto | read-only |
| `~/state/cockpit-mapping.json` | mapa feature/milestone → issue ID Paperclip | managed pelo Orquestrador |

## Claude Loop Flow

1. Orquestrador lê `features.json` → seleciona feature de maior prioridade.
2. Cria branch `auto/<feature-id>` em `~/repos/<projeto>/`.
3. Cria subtasks no Paperclip (milestones) → atribui ao Worker.
4. Worker executa milestone a milestone; PR aberto ao final de cada um.
5. Validador Pro valida PR (código + visual se aplicável).
6. Se aprovado: merge, §6 handoff registrado, milestone `done`.
7. Após todos os milestones: feature marcada `done` em `features.json`.

## Constraints

- **NÃO** mexer em serviços Cloud Run `-prod` sem PR aprovado e review humano.
- Mudanças visuais **exigem** Playwright print → Gemini OK antes do PR.
- Sem edits in-place em paths root-owned (`/opt/`, `/var/www/`, `/etc/`).
- Mission Control (`mission.app1n.com.br`) permanece atrás de IAP por default.
- `gh auth login` deve estar configurado na VM antes do primeiro PR.
