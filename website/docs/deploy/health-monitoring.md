---
sidebar_position: 3
---

# Health Check e Monitoramento — Toca da IA

## Endpoint de saúde

A aplicação expõe um endpoint de health check em:

```
GET /health
```

### Resposta de exemplo (saudável)

```json
{
  "status": "ok",
  "version": "1.2.3",
  "deploymentMode": "authenticated",
  "deploymentExposure": "private"
}
```

### Resposta de exemplo (banco inacessível)

```json
{
  "status": "unhealthy",
  "version": "1.2.3",
  "error": "database_unreachable"
}
```

HTTP 200 = ok, HTTP 503 = unhealthy.

## Verificação rápida

```bash
curl -sf http://localhost/health | python3 -m json.tool
```

## Docker health check integrado

O `docker-compose.prod.yml` já configura health check automático no container `app`:

```yaml
healthcheck:
  test: ["CMD-SHELL", "curl -sf http://localhost:3100/health | grep -q '\"status\":\"ok\"'"]
  interval: 10s
  timeout: 5s
  retries: 12
  start_period: 30s
```

Ver status dos containers:
```bash
docker compose -f docker/docker-compose.prod.yml ps
```

## Monitoramento com UptimeRobot (gratuito)

1. Acesse [uptimerobot.com](https://uptimerobot.com) e crie uma conta
2. Adicione novo monitor → tipo **HTTP(S)**
3. URL: `https://sua-url.exemplo.com.br/health`
4. Intervalo: 5 minutos
5. Alerta por e-mail quando cair

## Monitoramento com script de alertas

```bash
#!/usr/bin/env bash
# monitor.sh — alerta por e-mail se app ficar unhealthy
HEALTH_URL="http://localhost/health"
EMAIL="admin@exemplo.com.br"

STATUS=$(curl -sf "$HEALTH_URL" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "unreachable")

if [[ "$STATUS" != "ok" ]]; then
  echo "ALERTA: Toca da IA está $STATUS" | mail -s "[ALERTA] Toca da IA" "$EMAIL"
fi
```

Agendar via cron a cada 5 minutos:
```bash
*/5 * * * * /opt/toca-da-ia/scripts/monitor.sh
```

## Logs

```bash
# Todos os serviços
docker compose -f docker/docker-compose.prod.yml logs -f

# Apenas o app
docker compose -f docker/docker-compose.prod.yml logs -f app

# Nginx access log
docker compose -f docker/docker-compose.prod.yml exec nginx tail -f /var/log/nginx/access.log
```
