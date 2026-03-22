# Paperclip Deployment Guide

This guide explains how to deploy Paperclip in a production environment using Docker, Docker Compose, and Nginx.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Production Deployment](#production-deployment)
4. [Environment Configuration](#environment-configuration)
5. [Database Setup](#database-setup)
6. [Nginx Configuration](#nginx-configuration)
7. [SSL/HTTPS Setup](#ssltls-setup)
8. [Monitoring & Logs](#monitoring--logs)
9. [Backup & Restore](#backup--restore)
10. [Troubleshooting](#troubleshooting)

## Prerequisites

- Docker Engine 20.10+
- Docker Compose 2.0+
- Git
- A domain name (for production)
- SSL certificate (for HTTPS, recommended)

## Quick Start

### Local Development with Docker

```bash
# Copy environment variables
cp .env.example .env

# Generate a secure BETTER_AUTH_SECRET
openssl rand -base64 32

# Update .env with the generated secret
# BETTER_AUTH_SECRET=<your-generated-secret>

# Start services
docker-compose up -d

# View logs
docker-compose logs -f server

# Server will be available at http://localhost:3100
```

### Stop Services

```bash
docker-compose down

# Remove volumes (careful - deletes data)
docker-compose down -v
```

## Production Deployment

### 1. Server Setup

Choose a VPS or cloud provider:
- AWS EC2
- DigitalOcean
- Linode
- Vultr
- Self-hosted

**Minimum requirements:**
- 2 vCPU
- 4 GB RAM
- 20 GB disk space
- Ubuntu 22.04 LTS or similar

**Install Docker & Docker Compose:**

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/download/v2.20.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Add user to docker group
sudo usermod -aG docker $USER
newgrp docker

# Verify installation
docker --version
docker-compose --version
```

### 2. Clone Repository

```bash
git clone https://github.com/paperclipai/paperclip.git /opt/paperclip
cd /opt/paperclip
```

### 3. Environment Configuration

```bash
# Copy environment template
cp .env.example .env

# Edit with your values
nano .env
```

**Critical variables to set:**

```env
# Generate secure secret: openssl rand -base64 32
BETTER_AUTH_SECRET=your-generated-secret-here

# Your domain
PUBLIC_URL=https://paperclip.yourdomain.com

# Database
DB_USER=paperclip_prod
DB_PASSWORD=your-strong-password-here
DB_NAME=paperclip_prod

# Deployment mode
DEPLOYMENT_MODE=authenticated
DEPLOYMENT_EXPOSURE=private
LOG_LEVEL=info
```

### 4. Production Compose File

Use the production Docker Compose configuration:

```bash
# Create .env file for compose
cat > .env.compose << EOF
DB_USER=paperclip_prod
DB_PASSWORD=$(openssl rand -base64 32)
DB_NAME=paperclip_prod
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
DEPLOYMENT_MODE=authenticated
DEPLOYMENT_EXPOSURE=private
PUBLIC_URL=https://your-domain.com
LOG_LEVEL=info
EOF
```

### 5. Start Services

```bash
# Build and start all services
docker-compose -f docker-compose.prod.yml --env-file .env.compose up -d

# Verify services are running
docker-compose -f docker-compose.prod.yml ps

# Check logs
docker-compose -f docker-compose.prod.yml logs -f
```

## Environment Configuration

### Key Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BETTER_AUTH_SECRET` | ✅ | Auth encryption key (generate: `openssl rand -base64 32`) |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `PAPERCLIP_PUBLIC_URL` | ✅ | Public URL for auth redirects |
| `PAPERCLIP_DEPLOYMENT_MODE` | ✅ | `authenticated` or `guest` |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | ✅ | `private` or `public` |
| `NODE_ENV` | ✅ | Set to `production` |
| `LOG_LEVEL` | ❌ | `debug`, `info`, `warn`, `error` (default: `info`) |

### Optional AWS S3 Storage

```env
AWS_ACCESS_KEY_ID=your-key-id
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1
AWS_S3_BUCKET=your-bucket-name
```

### Optional Agent Adapters

```env
# Claude local adapter
CLAUDE_API_KEY=sk-ant-...

# OpenAI / Codex
OPENAI_API_KEY=sk-...
CODEX_BASE_URL=http://codex:8000

# Gemini
GEMINI_API_KEY=...

# Ollama
OLLAMA_BASE_URL=http://ollama:11434
```

## Database Setup

### Using External PostgreSQL

Instead of the bundled PostgreSQL container, connect to an external database:

```bash
# Update docker-compose.prod.yml and comment out the 'db' service
# Set DATABASE_URL to your external database:

DATABASE_URL=postgres://user:password@your-db-host:5432/paperclip_prod
```

### Database Migrations

Migrations run automatically on server startup. To manually run:

```bash
docker-compose -f docker-compose.prod.yml exec server pnpm db:migrate
```

### Backup Database

```bash
# Full backup
docker-compose -f docker-compose.prod.yml exec db pg_dump \
  -U paperclip_prod paperclip_prod > backup.sql

# Backup with compression
docker-compose -f docker-compose.prod.yml exec db pg_dump \
  -U paperclip_prod -Fc paperclip_prod > backup.dump
```

### Restore Database

```bash
# From SQL file
docker-compose -f docker-compose.prod.yml exec -T db \
  psql -U paperclip_prod paperclip_prod < backup.sql

# From compressed dump
docker-compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U paperclip_prod -d paperclip_prod backup.dump
```

## Nginx Configuration

### Default Configuration

The included `nginx.conf` provides:
- Reverse proxy to the API
- Security headers
- Rate limiting
- Gzip compression
- WebSocket support
- Static asset caching

### Customization

Edit `nginx.conf` to modify:
- Rate limits
- Cache headers
- Proxy timeouts
- CORS settings

### Test Nginx Config

```bash
docker-compose -f docker-compose.prod.yml exec nginx nginx -t
```

### Reload Configuration

```bash
docker-compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

## SSL/TLS Setup

### Using Let's Encrypt with Certbot

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx -y

# Get certificate (replace with your domain)
sudo certbot certonly --standalone -d paperclip.yourdomain.com

# Certificates are at: /etc/letsencrypt/live/paperclip.yourdomain.com/
```

### Update nginx.conf for HTTPS

In `nginx.conf`, uncomment the HTTPS server block and update:
- Domain name
- Certificate paths

```nginx
server {
    listen 443 ssl http2;
    server_name paperclip.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/paperclip.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/paperclip.yourdomain.com/privkey.pem;
    ...
}
```

### Mount Certificates in Docker

Update `docker-compose.prod.yml`:

```yaml
nginx:
  volumes:
    - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    - /etc/letsencrypt:/etc/letsencrypt:ro
```

### Auto-renew Certificates

```bash
# Create renewal script
cat > /opt/paperclip/renew-certs.sh << 'EOF'
#!/bin/bash
certbot renew --quiet
docker-compose -f /opt/paperclip/docker-compose.prod.yml exec nginx nginx -s reload
EOF

chmod +x /opt/paperclip/renew-certs.sh

# Add to crontab
sudo crontab -e
# Add line: 0 3 * * * /opt/paperclip/renew-certs.sh
```

## Monitoring & Logs

### View Logs

```bash
# All services
docker-compose -f docker-compose.prod.yml logs -f

# Specific service
docker-compose -f docker-compose.prod.yml logs -f server
docker-compose -f docker-compose.prod.yml logs -f nginx
docker-compose -f docker-compose.prod.yml logs -f db
```

### Health Checks

Health checks are configured in `docker-compose.prod.yml`:

```bash
# Check service health
docker-compose -f docker-compose.prod.yml ps

# Manual health check
curl http://localhost:3100/health
```

### Monitor Resource Usage

```bash
# Watch container stats
docker stats

# Specific container
docker stats paperclip-server
```

### Persistent Logs

Docker is configured with JSON file logging (10MB per file, max 3 files):

```bash
# View log file location
docker inspect paperclip-server | grep LogPath

# Rotate logs manually
docker exec paperclip-server kill -SIGUSR1 1
```

## Backup & Restore

### Automated Backups

Create a backup script:

```bash
cat > /opt/paperclip/backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/opt/paperclip/backups"
mkdir -p $BACKUP_DIR

# Backup database
docker-compose -f /opt/paperclip/docker-compose.prod.yml exec -T db \
  pg_dump -U paperclip_prod -Fc paperclip_prod > \
  "$BACKUP_DIR/paperclip-$(date +%Y%m%d-%H%M%S).dump"

# Keep only last 30 days
find $BACKUP_DIR -name "*.dump" -mtime +30 -delete
EOF

chmod +x /opt/paperclip/backup.sh

# Run daily at 2 AM
(crontab -l 2>/dev/null; echo "0 2 * * * /opt/paperclip/backup.sh") | crontab -
```

### Backup Volumes

```bash
# Backup paperclip-data volume
docker run --rm \
  -v paperclip_paperclip-data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/paperclip-data.tar.gz -C /data .

# Backup database volume
docker run --rm \
  -v paperclip_pgdata:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/pgdata.tar.gz -C /data .
```

### Restore from Backup

```bash
# Restore database from dump
docker-compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U paperclip_prod -d paperclip_prod < backup.dump

# Restore volume data
docker run --rm \
  -v paperclip_paperclip-data:/data \
  -v $(pwd):/backup \
  alpine sh -c "cd /data && tar xzf /backup/paperclip-data.tar.gz"
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker-compose -f docker-compose.prod.yml logs server

# Inspect container
docker inspect paperclip-server

# Try rebuilding
docker-compose -f docker-compose.prod.yml build --no-cache
```

### Database Connection Issues

```bash
# Test database connection
docker-compose -f docker-compose.prod.yml exec db \
  psql -U paperclip_prod -d paperclip_prod -c "SELECT 1"

# Check environment variables
docker-compose -f docker-compose.prod.yml exec server env | grep DATABASE_URL
```

### Nginx Not Routing Traffic

```bash
# Test nginx config
docker-compose -f docker-compose.prod.yml exec nginx nginx -t

# Check server connectivity
docker-compose -f docker-compose.prod.yml exec nginx \
  wget -O - http://server:3100/health

# Check logs
docker-compose -f docker-compose.prod.yml logs nginx
```

### Out of Disk Space

```bash
# Check docker disk usage
docker system df

# Clean up unused images/containers
docker system prune -a --volumes

# Clean up logs
docker exec $(docker ps -q) sh -c 'echo "" > /var/log/access.log'
```

### Memory Issues

Increase Docker limits in `docker-compose.prod.yml`:

```yaml
server:
  deploy:
    resources:
      limits:
        cpus: '2'
        memory: 4G
      reservations:
        cpus: '1'
        memory: 2G
```

### High CPU Usage

- Check what processes are running: `docker top paperclip-server`
- Review application logs for errors
- Consider increasing resource limits
- Scale to multiple instances (requires load balancer configuration)

## Security Checklist

- [ ] Generate new `BETTER_AUTH_SECRET`
- [ ] Use strong database password
- [ ] Enable HTTPS with valid SSL certificate
- [ ] Configure firewall to allow only ports 80, 443, and SSH
- [ ] Disable SSH password authentication (use keys only)
- [ ] Keep Docker and system packages updated
- [ ] Regular backups stored offsite
- [ ] Enable audit logging
- [ ] Use environment variables for secrets (not in git)
- [ ] Restrict API rate limits appropriately
- [ ] Monitor logs for suspicious activity

## Scaling

For high-traffic deployments:

1. **Database**: Use managed PostgreSQL (AWS RDS, DigitalOcean)
2. **Caching**: Add Redis for session/cache layer
3. **Load Balancing**: Use Nginx upstream servers for multiple API instances
4. **CDN**: Cache static assets with Cloudflare or similar
5. **Monitoring**: Integrate with Prometheus + Grafana

## Getting Help

- GitHub Issues: https://github.com/paperclipai/paperclip/issues
- Documentation: https://docs.paperclip.ai
- Discord: https://discord.gg/paperclip
