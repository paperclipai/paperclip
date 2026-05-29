---
name: docker-compose-prod-grade
description: Write a single-VPS Docker Compose stack that's actually production-ready — healthchecks, named networks, volume strategies, restart policies, log rotation, secrets via env-file (not in compose), and zero-downtime image updates with `pull && up -d --no-deps`. Use when shipping a Hono/Next.js + Postgres + Redis stack to a Hetzner/DO/Linode box.
category: devops
version: 0.1.0
tags: [docker, docker-compose, vps, deploy]
recommended_npm: []
license: MIT
author: claude-code-skills
---

For a side project or early-stage product, one $20 VPS with Docker Compose beats Kubernetes by 100x in operational cost. But "works on my machine" Compose isn't production. Here's what production-grade looks like.

## Compose skeleton

```yaml
# compose.yaml — yes, that's the modern filename
name: myapp

services:
  app:
    image: ghcr.io/owner/app:${APP_TAG:-latest}
    restart: unless-stopped
    env_file: .env.app
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/healthz"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 30s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "5" }
    networks: [internal, edge]

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    env_file: .env.db
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./backups:/backups
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"]
      interval: 5s
      timeout: 3s
      retries: 10
    networks: [internal]

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
    volumes: [redisdata:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
    networks: [internal]

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddydata:/data
      - caddyconfig:/config
    networks: [edge]

volumes:
  pgdata: {}
  redisdata: {}
  caddydata: {}
  caddyconfig: {}

networks:
  internal: {}      # app + db + redis
  edge: {}          # app + caddy (no db exposure)
```

## Caddyfile — automatic HTTPS

```
example.com {
  reverse_proxy app:3000
  encode zstd gzip
}
```

That's it. Caddy gets Let's Encrypt certs, renews them, and serves HTTP/3.

## Secrets — env-files, not inline

```
.env.app
.env.db
```

Both `.gitignore`d. On the VPS: `chmod 600 .env.*` and own them by the deploy user. Compose reads them via `env_file:`.

For real secrets management at this scale, use **age** + a single encrypted `secrets.age` checked into git, decrypted on deploy.

## Zero-downtime image updates

```bash
# On the VPS
docker compose pull app
docker compose up -d --no-deps app
```

`--no-deps` recreates only `app`, not its database. Compose drains old container only after the new one passes its healthcheck. No downtime if you have ≥2 app replicas behind Caddy load-balancing.

For a single replica, ~3 seconds of 503s during swap — acceptable for most apps. For zero, run two app replicas (`deploy.replicas: 2`).

## Backups (cron on the host)

```bash
# /etc/cron.daily/postgres-backup
docker compose -f /opt/myapp/compose.yaml exec -T db pg_dump -U $POSTGRES_USER $POSTGRES_DB | \
  gzip > /opt/myapp/backups/$(date +%F).sql.gz
find /opt/myapp/backups -name "*.sql.gz" -mtime +30 -delete
```

Then push backups off-box (rclone to B2/R2/S3) — local-only backups die with the VPS.

## Anti-patterns

- ❌ `latest` tag on prod images — you can't roll back. Use immutable tags (git SHA).
- ❌ Mounting source code into prod containers — defeats the point of the image.
- ❌ Ports exposed for db/redis to the public internet (`5432:5432` on the host) — bind to 127.0.0.1 or only inside the internal network.
- ❌ No log rotation — `/var/lib/docker` fills up in weeks.
- ❌ No healthcheck — `depends_on` waits for "started", not "ready".
- ❌ Using Compose for cross-host workloads — that's K8s/Nomad territory.
- ❌ Storing secrets in the compose.yaml committed to git.

## Quality gates

- `docker compose ps` shows all services `(healthy)`.
- Disk usage doesn't grow without bound (log rotation + image prune).
- `docker compose pull && docker compose up -d` deploys in < 30s with no DB downtime.
- Backups land off-box and restore-tested monthly.
- HTTPS works without manual cert renewal.
