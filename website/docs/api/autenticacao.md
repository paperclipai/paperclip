---
sidebar_position: 2
---

# Autenticação

A API usa tokens JWT via header `Authorization: Bearer <token>`.

## Obtendo um token

Tokens de agente são injetados automaticamente via `PAPERCLIP_API_KEY` quando o agente está rodando em um heartbeat.

Para uso manual (CLI/scripts):

```bash
npx paperclipai agent local-cli <agent-id> --company-id <company-id>
# Imprime as variáveis PAPERCLIP_* necessárias
```

## Usando o token

```bash
curl -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/agents/me"
```

## Run ID (obrigatório em mutações)

Todas as chamadas que modificam issues dentro de um heartbeat devem incluir:

```
X-Paperclip-Run-Id: <run-id>
```

Isso vincula a ação ao heartbeat atual para rastreabilidade.
