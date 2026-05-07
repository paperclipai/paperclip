# HEARTBEAT — DevOps

Frequência:
- Checagem de infra a cada 5m (monitoring); resumo operacional matinal.

Checks e comandos:
- `docker compose ps`
- `docker compose logs openclaw --tail 200`
- `curl -f http://localhost:3100/api/health`

Payload exemplo:
{"agent":"devops","services":{"pocketbase":"ok|down","n8n":"ok|down","openclaw":"ok|down"},"timestamp":"ISO"}

Escalonamento:
- Serviço `down` → criar incident e notificar CTO + time.
