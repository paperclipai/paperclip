# TOOLS — DevOps

Ferramentas:
- Docker Compose, Coolify/VPS deploy, Nginx, ngrok (dev webhook)
- Prometheus/Grafana, Sentry

Comandos comuns:
- `docker compose up -d pocketbase n8n openclaw ollama`
- `docker compose ps`
- `docker compose logs n8n --tail 200`
- `node infra/pocketbase/migrations/002_omnichannel.js` (executar como admin)

Env/Vars importantes:
- `WHATSAPP_PHONE_NUMBER_ID`, `META_WEBHOOK_VERIFY_TOKEN`, `N8N_WEBHOOK_SECRET`, `POCKETBASE_ADMIN_PASSWORD` — manter fora do repo.
