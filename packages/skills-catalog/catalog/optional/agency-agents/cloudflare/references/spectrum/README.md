# Cloudflare Spectrum Skill Reference

## Overview

Cloudflare Spectrum provides security and acceleration for ANY TCP or UDP-based application. It's a global Layer 4 (L4) reverse proxy running on Cloudflare's edge nodes that routes MQTT, email, file transfer, version control, games, and more through Cloudflare to mask origins and protect from DDoS attacks.

**When to Use Spectrum**: When your protocol isn't HTTP/HTTPS (use Cloudflare proxy for HTTP). Spectrum handles everything else: SSH, gaming, databases, MQTT, SMTP, RDP, custom protocols.

## Plan Capabilities

| Capability | Pro/Business | Enterprise |
|------------|--------------|------------|
| TCP protocols | Selected ports only | All ports (1-65535) |
| UDP protocols | Selected ports only | All ports (1-65535) |
| Port ranges | ❌ | ✅ |
| Argo Smart Routing | ✅ | ✅ |
| IP Firewall | ✅ | ✅ |
| Load balancer origins | ✅ | ✅ |

## Decision Tree

**What are you trying to do?**

1. **Create/manage Spectrum app**
   - Via Dashboard → See [Cloudflare Dashboard](https://dash.cloudflare.com)
   - Via API → See [api.md](api.md) - REST endpoints
   - Via SDK → See [api.md](api.md) - TypeScript/Python/Go examples
   - Via IaC → See [configuration.md](configuration.md) - Terraform/Pulumi

2. **Protect specific protocol**
   - SSH → See [patterns.md](patterns.md#1-ssh-server-protection)
   - Gaming (Minecraft, etc) → See [patterns.md](patterns.md#2-game-server)
   - MQTT/IoT → See [patterns.md](patterns.md#3-mqtt-broker)
   - SMTP/Email → See [patterns.md](patterns.md#4-smtp-relay)
   - Database → See [patterns.md](patterns.md#5-database-proxy)
   - RDP → See [patterns.md](patterns.md#6-rdp-remote-desktop)

3. **Choose origin type**
   - Direct IP (single server) → See [configuration.md](configuration.md#direct-ip-origin)
   - CNAME (hostname) → See [configuration.md](configuration.md#cname-origin)
   - Load balancer (HA/failover) → See [configuration.md](configuration.md#load-balancer-origin)

## Reading Order

1. Start with [patterns.md](patterns.md) for your specific protocol
2. Then [configuration.md](configuration.md) for your origin type
3. Check [gotchas.md](gotchas.md) before going to production
4. Use [api.md](api.md) for programmatic access

## See Also

- [Cloudflare Docs](https://developers.cloudflare.com/spectrum/)
