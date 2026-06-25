# Webhook de Review GitHub -> Paperclip

Este fluxo conecta o review de PR no GitHub ao Paperclip para criar ou atualizar tasks de correção.

## Fluxo esperado

1. Um humano pede a implementação ao Hermes Agent.
2. O Hermes Agent analisa o pedido e delega para um ou mais agentes capazes.
3. O(s) agente(s) cria(m) branch, resolve(m) o trabalho e abrem um PR.
4. O Codex no GitHub (`chatgpt-codex-connector[bot]` ou outro bot configurado) revisa o PR e escreve comentários/melhorias.
5. O GitHub dispara um webhook para o Paperclip.
6. O Paperclip normaliza o review, aplica allowlist/assinatura/idempotência e cria ou atualiza a task.
7. O agente responsável recebe a task e corrige o PR na mesma branch.

## Endpoint

- URL local/pública: `POST /api/github/webhook`
- `Content-Type`: `application/json`
- Assinatura: `X-Hub-Signature-256`
- Delivery ID: `X-GitHub-Delivery`

## Eventos aceitos

O endpoint processa apenas estes eventos:

- `pull_request_review`
- `pull_request_review_comment`
- `issue_comment` quando `issue.pull_request` existe

Comentários em issue comum são ignorados.

## Configuração

As variáveis abaixo são lidas do ambiente do Paperclip. Não coloque segredos no código.

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_WEBHOOK_COMPANY_ID`
- `GITHUB_WEBHOOK_PROJECT_ID` opcional
- `GITHUB_WEBHOOK_ALLOWED_REPOS` opcional, lista separada por vírgula ou quebra de linha
- `GITHUB_WEBHOOK_ALLOWED_ORGS` opcional
- `GITHUB_WEBHOOK_ALLOWED_BOT_LOGINS` opcional, padrão: `chatgpt-codex-connector[bot]`
- `GITHUB_WEBHOOK_ALLOW_HUMAN_REVIEWERS` opcional, padrão `false`
- `GITHUB_WEBHOOK_CEO_AGENT_ID` opcional
- `GITHUB_WEBHOOK_DEFAULT_ASSIGNEE_AGENT_ID` opcional
- `GITHUB_WEBHOOK_AGENT_CTO`, `GITHUB_WEBHOOK_AGENT_DEVOPS`, `GITHUB_WEBHOOK_AGENT_QA`, `GITHUB_WEBHOOK_AGENT_UXDESIGNER` opcionais

## Allowlist e segurança

- Se `GITHUB_WEBHOOK_ALLOWED_REPOS` ou `GITHUB_WEBHOOK_ALLOWED_ORGS` estiverem configurados, o webhook só aceita o repositório correspondente.
- A assinatura HMAC SHA-256 é validada quando `GITHUB_WEBHOOK_SECRET` estiver configurado.
- Duplicatas são tratadas por `originKind + originId`, evitando tasks repetidas para o mesmo review/comentário.
- Review/comentário de humano é ignorado por padrão; para aceitar, habilite `GITHUB_WEBHOOK_ALLOW_HUMAN_REVIEWERS=true`.

## Task criada no Paperclip

Para cada review acionável, o Paperclip registra:

- repositório e URL
- PR, branch head/base e SHA
- autor do PR
- autor do review/comentário
- review ID, estado e corpo
- comentário, arquivo e linha quando aplicável
- delivery ID e sender
- critérios de aceite para a correção

Se uma task já existir para o mesmo review/comentário, o Paperclip atualiza a task em vez de criar outra.
