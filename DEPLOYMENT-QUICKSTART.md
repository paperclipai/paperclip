# Paperclip Quick Deployment Guide

**Fast track to production in 5 steps.**

## 1️⃣ Prerequisites

```bash
# Ensure you have:
docker --version        # Docker 20.10+
docker-compose --version # Docker Compose 2.0+
openssl version        # For generating secrets
git --version          # For cloning/updates
```

## 2️⃣ Clone & Setup

```bash
# Clone repository
git clone https://github.com/paperclipai/paperclip.git /opt/paperclip
cd /opt/paperclip

# Generate secure secrets
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
DB_PASSWORD=$(openssl rand -base64 32)

echo "BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET"
echo "DB_PASSWORD=$DB_PASSWORD"
# Save these!
```

## 3️⃣ Configure Environment

```bash
# Copy and edit the production config
cp .env.prod.example .env.prod
nano .env.prod  # Or use your editor

# Must set these:
# BETTER_AUTH_SECRET=<your-generated-secret>
# DB_PASSWORD=<your-generated-password>
# PUBLIC_URL=https://your-domain.com
# DEPLOYMENT_MODE=authenticated
```

## 4️⃣ Deploy with Script (Recommended)

```bash
# Make deploy script executable
chmod +x scripts/deploy.sh

# Run deployment (interactive)
./scripts/deploy.sh

# Script will:
# - Check requirements
# - Generate secrets
# - Build Docker images
# - Start services
# - Verify deployment
# - Setup systemd (optional)
```

## 5️⃣ Or Manual Deployment

```bash
# Build images
docker-compose -f docker-compose.prod.yml build

# Start services
docker-compose -f docker-compose.prod.yml --env-file .env.prod up -d

# Verify
docker-compose -f docker-compose.prod.yml ps

# Check health
curl http://localhost:3100/health
curl http://localhost/health
```

---

## 🚀 You're Live!

Access Paperclip at the PUBLIC_URL you configured.

---

## 📋 Essential Commands

```bash
# View logs
docker-compose -f docker-compose.prod.yml logs -f

# Restart services
docker-compose -f docker-compose.prod.yml restart

# Stop services
docker-compose -f docker-compose.prod.yml down

# Health check (continuous)
chmod +x scripts/health-check.sh
./scripts/health-check.sh -c

# Backup database
chmod +x scripts/backup.sh
./scripts/backup.sh

# Database shell
docker-compose -f docker-compose.prod.yml exec db psql -U paperclip_prod paperclip_prod

# Stop & remove volumes
docker-compose -f docker-compose.prod.yml down -v
```

---

## 🔒 SSL/TLS Setup (Recommended)

```bash
# Get certificate from Let's Encrypt
sudo certbot certonly --standalone -d your-domain.com

# Update nginx.conf (uncomment HTTPS block):
# - Set server_name to your domain
# - Point ssl_certificate to /etc/letsencrypt/live/your-domain.com/fullchain.pem
# - Point ssl_certificate_key to /etc/letsencrypt/live/your-domain.com/privkey.pem

# Reload nginx
docker-compose -f docker-compose.prod.yml exec nginx nginx -s reload

# Auto-renew (add to crontab)
0 3 * * * certbot renew --quiet && docker-compose -f /opt/paperclip/docker-compose.prod.yml exec nginx nginx -s reload
```

---

## 🆘 Troubleshooting

### Services not starting?
```bash
docker-compose -f docker-compose.prod.yml logs
docker-compose -f docker-compose.prod.yml up  # Run in foreground to see errors
```

### Database connection failed?
```bash
# Check DATABASE_URL in .env.prod
docker-compose -f docker-compose.prod.yml exec db psql -U paperclip_prod -d paperclip_prod -c "SELECT 1"
```

### Nginx not routing?
```bash
docker-compose -f docker-compose.prod.yml exec nginx nginx -t
docker-compose -f docker-compose.prod.yml exec nginx curl http://server:3100/health
```

### Out of disk space?
```bash
docker system prune -a --volumes  # ⚠️ WARNING: removes unused images/volumes
docker system df                  # Check usage
```

---

## 📚 Full Documentation

- [DEPLOYMENT.md](./DEPLOYMENT.md) - Complete deployment guide
- [DEPLOYMENT-CHECKLIST.md](./DEPLOYMENT-CHECKLIST.md) - Pre-deployment checklist
- [CLAUDE.md](./CLAUDE.md) - Development & architecture

---

## 🔑 Critical Files

```
.env.prod                  # Configuration (DO NOT COMMIT)
docker-compose.prod.yml    # Production services
nginx.conf                 # Reverse proxy config
scripts/deploy.sh          # Deployment automation
scripts/backup.sh          # Database backups
scripts/health-check.sh    # Health monitoring
```

---

## ✅ Deployment Checklist

- [ ] Secrets generated and saved securely
- [ ] `.env.prod` configured with real values
- [ ] Domain and DNS configured
- [ ] Firewall allows ports 22, 80, 443
- [ ] Docker and Docker Compose installed
- [ ] Repository cloned to `/opt/paperclip`
- [ ] Services started and healthy
- [ ] UI accessible at PUBLIC_URL
- [ ] SSL/TLS certificate installed
- [ ] Backups configured
- [ ] Monitoring configured
- [ ] Team trained on operations

---

## 🆘 Support

- **Issues**: https://github.com/paperclipai/paperclip/issues
- **Docs**: https://docs.paperclip.ai
- **Discord**: https://discord.gg/paperclip

---

## 🎯 Next Steps

1. Configure SSL/TLS
2. Setup automated backups
3. Configure monitoring & alerts
4. Train team on operations
5. Document runbooks
6. Perform failover test
