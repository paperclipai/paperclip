# Cursor Cloud — gambiarras aceitas

| Problema | Workaround no fork | Substituto futuro |
|----------|-------------------|-------------------|
| Wake payload >4096 B | Contexto no **prompt**; `PAPERCLIP_WAKE_PAYLOAD_JSON` omitido em cloud env | Permanente |
| Webhooks v1 inexistentes | Poll SSE + Run Observer + `POST /api/internal/cursor/webhook` v0 HMAC | Webhooks v1 Cursor |
| Sem CRUD Automations | Config manual dashboard + webhook Paperclip | API Cursor |
| Custo USD ausente na API Cursor | Tokens × `pricing-fallback.ts` (`costEstimated: true`) | Admin API reconcile read-only |
| MCP não persiste no resume | Re-pass `mcpServers` em todo `send()` | SDK persistência |
| `409 agent_busy` | Defer heartbeat 30s ×3 (`cursor_agent_busy_retry`) | Serialização nativa |
| Phantom success em chat | Skip git check quando `paperclipChatWake` | — |

Ver também: `packages/adapters/cursor-cloud/README.md`.
