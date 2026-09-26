## Common Use Cases

### 1. SSH Server Protection

**Terraform:**
```hcl
resource "cloudflare_spectrum_application" "ssh" {
  zone_id  = var.zone_id
  protocol = "tcp/22"

  dns {
    type = "CNAME"
    name = "ssh.example.com"
  }

  origin_direct      = ["tcp://10.0.1.5:22"]
  ip_firewall        = true
  argo_smart_routing = true
}
```

**Benefits:** Hide origin IP, DDoS protection, IP firewall, Argo reduces latency

### 2. Game Server

**TypeScript (Minecraft):**
```typescript
const app = await client.spectrum.apps.create({
  zone_id: 'your-zone-id',
  protocol: 'tcp/25565',
  dns: { type: 'CNAME', name: 'mc.example.com' },
  origin_direct: ['tcp://192.168.1.10:25565'],
  proxy_protocol: 'v1',  // Preserves player IPs
  argo_smart_routing: true,
});
```

**Benefits:** DDoS protection, hide origin IP, Proxy Protocol for player IPs/bans, Argo reduces latency

### 3. MQTT Broker

IoT device communication.

**TypeScript:**
```typescript
const mqttApp = await client.spectrum.apps.create({
  zone_id: 'your-zone-id',
  protocol: 'tcp/8883',  // Use 1883 for plain MQTT
  dns: { type: 'CNAME', name: 'mqtt.example.com' },
  origin_direct: ['tcp://mqtt-broker.internal:8883'],
  tls: 'full',  // Use 'off' for plain MQTT
});
```

**Benefits:** DDoS protection, hide broker IP, TLS termination at edge

### 4. SMTP Relay

Email submission (port 587). **WARNING**: See [gotchas.md](gotchas.md#smtp-reverse-dns)

**Terraform:**
```hcl
resource "cloudflare_spectrum_application" "smtp" {
  zone_id  = var.zone_id
  protocol = "tcp/587"

  dns {
    type = "CNAME"
    name = "smtp.example.com"
  }

  origin_direct = ["tcp://mail-server.internal:587"]
  tls           = "full"  # STARTTLS support
}
```

**Limitations:**
- Spectrum IPs lack reverse DNS (PTR records)
- Many mail servers reject without valid rDNS
- Best for internal/trusted relay only

### 5. Database Proxy

MySQL/PostgreSQL. **Use with caution** - security critical.

**PostgreSQL:**
```typescript
const postgresApp = await client.spectrum.apps.create({
  zone_id: 'your-zone-id',
  protocol: 'tcp/5432',
  dns: { type: 'CNAME', name: 'postgres.example.com' },
  origin_dns: { name: 'db-primary.internal.example.com' },
  origin_port: 5432,
  tls: 'strict',      // REQUIRED
  ip_firewall: true,  // REQUIRED
});
```

**MySQL:**
```hcl
resource "cloudflare_spectrum_application" "mysql" {
  zone_id  = var.zone_id
  protocol = "tcp/3306"

  dns {
    type = "CNAME"
    name = "mysql.example.com"
  }

  origin_dns {
    name = "mysql-primary.internal.example.com"
  }

  origin_port = 3306
  tls         = "strict"
  ip_firewall = true
}
```

**Security:**
- ALWAYS use `tls: "strict"`
- ALWAYS use `ip_firewall: true`
- Restrict to known IPs via zone firewall
- Use strong DB authentication
- Consider VPN or Cloudflare Access instead

### 6. RDP (Remote Desktop)

**Requires IP firewall.**

**Terraform:**
```hcl
resource "cloudflare_spectrum_application" "rdp" {
  zone_id  = var.zone_id
  protocol = "tcp/3389"

  dns {
    type = "CNAME"
    name = "rdp.example.com"
  }

  origin_direct = ["tcp://windows-server.internal:3389"]
  tls           = "off"       # RDP has own encryption
  ip_firewall   = true        # REQUIRED
}
```

**Security:** ALWAYS `ip_firewall: true`, whitelist admin IPs, RDP is DDoS/brute-force target

### 7. Multi-Origin Failover

High availability with load balancer.

**Terraform:**
```hcl
resource "cloudflare_load_balancer" "database_lb" {
  zone_id          = var.zone_id
  name             = "db-lb.example.com"
  default_pool_ids = [cloudflare_load_balancer_pool.db_primary.id]
  fallback_pool_id = cloudflare_load_balancer_pool.db_secondary.id
}

resource "cloudflare_load_balancer_pool" "db_primary" {
  name    = "db-primary-pool"
  origins { name = "db-1"; address = "192.0.2.1" }
  monitor = cloudflare_load_balancer_monitor.postgres_monitor.id
}

resource "cloudflare_load_balancer_pool" "db_secondary" {
  name    = "db-secondary-pool"
  origins { name = "db-2"; address = "192.0.2.2" }
  monitor = cloudflare_load_balancer_monitor.postgres_monitor.id
}

resource "cloudflare_load_balancer_monitor" "postgres_monitor" {
  type = "tcp"; port = 5432; interval = 30; timeout = 5
}

resource "cloudflare_spectrum_application" "postgres_ha" {
  zone_id     = var.zone_id
  protocol    = "tcp/5432"
  dns         { type = "CNAME"; name = "postgres.example.com" }
  origin_dns  { name = cloudflare_load_balancer.database_lb.name }
  origin_port = 5432
  tls         = "strict"
  ip_firewall = true
}
```

**Benefits:** Automatic failover, health monitoring, traffic distribution, zero-downtime deployments

## See Also

- [configuration.md](configuration.md) - Origin type setup
- [gotchas.md](gotchas.md) - Protocol limitations
- [api.md](api.md) - SDK reference
