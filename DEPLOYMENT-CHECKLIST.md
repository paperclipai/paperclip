# Paperclip Deployment Checklist

Use this checklist to ensure your production deployment is properly configured and secure.

## Pre-Deployment

### Infrastructure
- [ ] Server provisioned with minimum 2 vCPU, 4GB RAM, 20GB disk
- [ ] Ubuntu 22.04 LTS (or compatible) installed
- [ ] SSH access configured with key authentication
- [ ] Firewall configured (allow ports: 22, 80, 443)
- [ ] Domain name registered and DNS configured
- [ ] SSL certificate acquired (Let's Encrypt recommended)

### Docker & Dependencies
- [ ] Docker Engine 20.10+ installed
- [ ] Docker Compose 2.0+ installed
- [ ] Git installed
- [ ] openssl installed
- [ ] User added to docker group (no sudo needed for docker commands)

### Git & Code
- [ ] Repository cloned to `/opt/paperclip`
- [ ] `.env.prod.example` reviewed
- [ ] `.env.prod` created with actual secrets
- [ ] All secrets generated with strong random values
- [ ] Repository at current release tag (not on development branch)

## Secrets & Security

### Cryptographic Keys
- [ ] `BETTER_AUTH_SECRET` generated with `openssl rand -base64 32`
- [ ] `DB_PASSWORD` generated with `openssl rand -base64 32`
- [ ] Secrets stored in secure location (password manager, vault)
- [ ] Secrets backed up securely
- [ ] Secrets NOT committed to git

### Configuration
- [ ] `PAPERCLIP_PUBLIC_URL` matches domain name (with https)
- [ ] `DEPLOYMENT_MODE=authenticated`
- [ ] `DEPLOYMENT_EXPOSURE=private`
- [ ] `NODE_ENV=production`
- [ ] All environment variables validated and set

### Access Control
- [ ] SSH public key authentication only (no password auth)
- [ ] Root SSH login disabled
- [ ] Non-root docker user configured
- [ ] File permissions secured (chmod 600 on .env.prod)
- [ ] Database user passwords strong and unique

## Database Setup

### PostgreSQL
- [ ] Database user created with limited privileges
- [ ] Database created
- [ ] Backups directory created (`/opt/paperclip/backups`)
- [ ] Automated backup scheduled (cron job)
- [ ] Database migrations verified to run on startup
- [ ] Test restore procedure documented

### Data Persistence
- [ ] PostgreSQL data volume mounted correctly
- [ ] Application data volume mounted correctly
- [ ] Volumes have sufficient disk space
- [ ] Backup strategy documented and tested

## Docker & Containerization

### Images & Builds
- [ ] All images built successfully
- [ ] Multi-architecture images if needed
- [ ] Image layers optimized
- [ ] Base images from official registries only
- [ ] No secrets in image layers

### Networking
- [ ] Docker network defined (bridge mode)
- [ ] Container communication verified
- [ ] Database only accessible from app container
- [ ] API server not exposed directly (behind Nginx)

### Resource Limits
- [ ] Memory limits set in docker-compose.prod.yml
- [ ] CPU limits set appropriately
- [ ] Health checks configured
- [ ] Restart policies set to `always`
- [ ] Logging driver configured with size limits

## Nginx Configuration

### Reverse Proxy
- [ ] nginx.conf syntax validated (`nginx -t`)
- [ ] Upstream servers configured correctly
- [ ] Proxy headers set (X-Real-IP, X-Forwarded-*)
- [ ] WebSocket support enabled (Upgrade header)
- [ ] Timeout values appropriate

### Security Headers
- [ ] Strict-Transport-Security header set
- [ ] X-Content-Type-Options header set
- [ ] X-Frame-Options header set
- [ ] X-XSS-Protection header set
- [ ] Content-Security-Policy configured (if needed)
- [ ] CORS headers configured (if needed)

### Performance
- [ ] Gzip compression enabled
- [ ] Cache headers set for static assets
- [ ] Rate limiting configured
- [ ] Connection pooling enabled
- [ ] Buffer sizes optimized

### Logging
- [ ] Access logs enabled
- [ ] Error logs enabled
- [ ] Log rotation configured
- [ ] Sensitive data not logged (auth tokens, etc.)

## SSL/TLS Configuration

### Certificates
- [ ] SSL certificate acquired from trusted CA
- [ ] Full chain certificate configured (not just domain)
- [ ] Private key permissions secured (600)
- [ ] Certificate renewal process automated
- [ ] Certificate expiry monitored

### Protocol & Ciphers
- [ ] TLS 1.2+ only (no SSL 3.0, TLS 1.0, 1.1)
- [ ] Strong cipher suites configured
- [ ] Weak ciphers disabled
- [ ] Perfect Forward Secrecy enabled
- [ ] HSTS header configured with appropriate max-age

### HTTP Redirect
- [ ] HTTP to HTTPS redirect configured
- [ ] Permanent redirect (301) used
- [ ] Redirect tested in browser

## Application Deployment

### Startup
- [ ] Services start without errors
- [ ] Health checks passing
- [ ] Database migrations completed successfully
- [ ] No startup timeouts occurring
- [ ] Logs show normal operation

### Functionality
- [ ] UI loads and renders correctly
- [ ] API endpoints responding with correct status codes
- [ ] Authentication working (login/logout)
- [ ] Database operations functional
- [ ] WebSocket connections established (if used)

### Performance
- [ ] Response times acceptable
- [ ] No memory leaks or excessive CPU usage
- [ ] Connections pooled correctly
- [ ] Caching working as expected

## Monitoring & Observability

### Health Checks
- [ ] API health endpoint responding (`/health`)
- [ ] Nginx health endpoint working
- [ ] Database connectivity verified
- [ ] Container health checks passing
- [ ] Manual health verification documented

### Logging
- [ ] Application logs being captured
- [ ] Log rotation configured
- [ ] Logs accessible via `docker-compose logs`
- [ ] Error logs reviewed for issues
- [ ] Structured logging enabled (JSON if possible)

### Metrics & Alerts
- [ ] Disk space monitored
- [ ] Memory usage monitored
- [ ] CPU usage monitored
- [ ] Network traffic monitored
- [ ] Alert thresholds set appropriately
- [ ] Alerting channels configured (email, Slack, etc.)

## Backup & Disaster Recovery

### Backup Strategy
- [ ] Backup script created and tested
- [ ] Backups stored in separate location
- [ ] Backup retention policy defined
- [ ] Automated backup scheduled (cron)
- [ ] Backup success notifications configured

### Restore Procedure
- [ ] Restore process documented
- [ ] Test restore from backup performed
- [ ] Recovery Time Objective (RTO) defined
- [ ] Recovery Point Objective (RPO) defined
- [ ] Backup verification automated

### Data Migration
- [ ] Database export/import tested
- [ ] Volume backup/restore tested
- [ ] Disaster recovery plan documented
- [ ] Team trained on recovery procedures

## Security Hardening

### System Level
- [ ] Fail2ban or similar configured (optional)
- [ ] File integrity monitoring enabled (optional)
- [ ] System logs monitored
- [ ] Security patches applied
- [ ] Unnecessary services disabled

### Application Level
- [ ] Input validation verified
- [ ] OWASP Top 10 vulnerabilities reviewed
- [ ] Rate limiting configured to prevent abuse
- [ ] CORS configured appropriately
- [ ] Security headers in place

### Secrets Management
- [ ] Secrets encrypted at rest
- [ ] Secrets never in logs or error messages
- [ ] Secrets access restricted to authorized personnel
- [ ] Secrets rotation schedule defined
- [ ] Vault or secret management tool considered

## Documentation

### Deployment
- [ ] Deployment procedure documented
- [ ] Architecture diagram created
- [ ] Network diagram created
- [ ] Configuration file locations documented
- [ ] Environment variables documented

### Operations
- [ ] Startup/shutdown procedures documented
- [ ] Common issues and solutions documented
- [ ] Health check procedures documented
- [ ] Escalation procedures documented
- [ ] On-call runbooks prepared

### Disaster Recovery
- [ ] Backup/restore procedures documented
- [ ] RTO and RPO defined
- [ ] Failover procedures documented
- [ ] Contact information documented
- [ ] Regular drills scheduled

## Testing

### Functionality Testing
- [ ] Full user workflow tested
- [ ] All API endpoints tested
- [ ] Database operations tested
- [ ] Authentication flows tested
- [ ] Error conditions tested

### Load Testing
- [ ] Performance under load verified
- [ ] Scalability tested
- [ ] Database handles load
- [ ] Memory usage acceptable
- [ ] CPU usage acceptable

### Failover Testing
- [ ] Container restart tested
- [ ] Database failover tested
- [ ] Service recovery automatic
- [ ] No data loss on restart
- [ ] Backup restore tested

### Security Testing
- [ ] SSL/TLS configuration tested
- [ ] Headers validated with security scanner
- [ ] OWASP Top 10 tested
- [ ] Rate limiting tested
- [ ] Authentication bypass attempts tested

## Post-Deployment

### Validation
- [ ] All checklist items completed
- [ ] Team walkthrough completed
- [ ] Stakeholder approval obtained
- [ ] Known issues documented
- [ ] Monitoring alerts verified

### Transition
- [ ] DNS cutover completed (if migrating)
- [ ] Load balancer updated (if applicable)
- [ ] CDN configured (if applicable)
- [ ] Old infrastructure decommissioned (if migrating)
- [ ] Post-mortem scheduled (if applicable)

### Monitoring
- [ ] All monitoring active
- [ ] All alerts configured
- [ ] On-call team ready
- [ ] First week monitoring schedule confirmed
- [ ] Issue tracking configured

## Sign-Off

- [ ] Deployment Lead Approval: _________________ Date: _______
- [ ] Operations Lead Approval: _________________ Date: _______
- [ ] Security Review Approval: _________________ Date: _______

---

## Notes

Use this space to document any deviations from standard procedure or special configurations:

```
________________________________________________________________________

________________________________________________________________________

________________________________________________________________________

________________________________________________________________________
```
