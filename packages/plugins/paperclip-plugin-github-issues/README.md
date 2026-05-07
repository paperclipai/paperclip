# paperclip-plugin-github-issues

Plugin Paperclip que recebe webhooks do GitHub e abre/atualiza tarefas no plano de controle.
Substitui o `gh-analyzer` legado com rastreabilidade ponta-a-ponta e três camadas de idempotência.

---

## Fluxo de arquitetura

```
GitHub
  │
  │  POST /api/plugins/paperclip-plugin-github-issues/webhooks/github
  │  Headers: X-Hub-Signature-256, X-GitHub-Event, X-GitHub-Delivery
  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Plugin Worker (worker.ts)                                          │
│                                                                     │
│  1. verifySignature()   ← camada 1: HMAC-SHA256                     │
│  2. acquireDelivery()   ← camada 2: estado de plugin (deliveryId)   │
│  3. dispatch()          ← roteia event × action                     │
│  4. handler (issues/pr/workflow_run/comment)                        │
│     └── ctx.issues.list()  ← camada 3: originId já existe?         │
│         └── ctx.issues.create() / createComment() / requestWakeup() │
└─────────────────────────────────────────────────────────────────────┘
  │
  ▼
Plano de controle Paperclip
  (tarefas criadas, agente CEO ativado)
```

---

## Setup local

```bash
pnpm install
pnpm build   # gera dist/manifest.js e dist/worker.js
pnpm test    # 54 testes
```

---

## Schema de configuração

| Campo | Tipo | Descrição |
|---|---|---|
| `hmacSecret` | `string` | Segredo compartilhado com o webhook do GitHub (HMAC-SHA256) |
| `ceoAgentId` | `string` | ID do agente que receberá as tarefas abertas |
| `labelGate` | `string` | Label que precisa estar na issue para criar tarefa (ex: `agent-eligible`) |
| `repoToProject` | `Record<string,string>` | Mapeamento `"owner/repo"` → `"project-id"` |
| `companyId` | `string` | ID da empresa no Paperclip |

Exemplo:

```json
{
  "hmacSecret": "seu-segredo-aqui",
  "ceoAgentId": "agent-abc123",
  "labelGate": "agent-eligible",
  "repoToProject": {
    "acme/backend": "proj-1",
    "acme/frontend": "proj-2"
  },
  "companyId": "company-xyz"
}
```

---

## Gerar o hmacSecret

```bash
openssl rand -hex 32
```

---

## Configurar webhook no GitHub

1. No repositório → **Settings → Webhooks → Add webhook**
2. **Payload URL**: `${PAPERCLIP_PUBLIC_URL}/api/plugins/paperclip-plugin-github-issues/webhooks/github`
3. **Content type**: `application/json`
4. **Secret**: valor de `hmacSecret`
5. **Which events?** — selecionar individualmente:
   - Issues
   - Issue comments
   - Pull requests
   - Workflow runs
6. Salvar. O GitHub enviará um ping; verifique nos logs do plugin.

---

## Idempotência — 3 camadas

| Camada | Onde | Mecanismo |
|---|---|---|
| 1 | `verifySignature()` | Rejeita requisições com HMAC inválido antes de qualquer processamento |
| 2 | `acquireDelivery()` | Armazena o `X-GitHub-Delivery` no estado de plugin; redeliveries retornam `duplicate` imediatamente |
| 3 | Handler (`issues.list`) | Antes de criar tarefa, consulta por `originId`; aborta se já existe |

Graças às três camadas, redeliveries e retentativas do GitHub são seguras e não geram duplicatas.

---

## Logs

Cada requisição gera uma linha JSON no stdout:

```json
{
  "deliveryId": "abc-123",
  "event": "issues",
  "action": "opened",
  "repo": "acme/backend",
  "outcome": "created",
  "durationMs": 42,
  "ts": "2026-05-07T12:00:00.000Z",
  "plugin": "paperclip-plugin-github-issues"
}
```

Campos relevantes: `outcome` (`created` | `duplicate` | `filtered` | `noop`), `error` (presente em falhas).

---

## Troubleshooting

**401 — assinatura inválida**
- Confira se o `hmacSecret` na config do plugin é idêntico ao "Secret" cadastrado no GitHub.
- O GitHub assina o body cru; proxies que modificam o body quebram a assinatura.

**Repositório ignorado silenciosamente**
- O campo `repoToProject` não contém o `full_name` do repositório (`owner/repo`).
- Verifique o log: `outcome: "filtered"`.

**Issue aberta mas tarefa não criada**
- A issue não tem a label definida em `labelGate`.
- Verifique o log: `outcome: "filtered"`.

**Tarefa duplicada**
- Improvável com as 3 camadas, mas se ocorrer cheque se `companyId` mudou entre deploys (invalida a camada 3).

---

## Descomissionamento do gh-analyzer

Este plugin substitui o `gh-analyzer`. Ver:
- Spec: [`../../../docs/specs/github-issues-plugin-v1.md`](../../../docs/specs/github-issues-plugin-v1.md)
- Issue de rastreamento: _(abrir issue no repositório interno após deploy em produção)_

Passos sugeridos:
1. Validar o plugin em produção por um ciclo de sprint.
2. Confirmar que nenhuma issue está sendo perdida comparando volumes.
3. Desabilitar o webhook do `gh-analyzer`.
4. Arquivar o serviço.
