## REST API Endpoints

```
GET    /zones/{zone_id}/spectrum/apps                    # List apps
POST   /zones/{zone_id}/spectrum/apps                    # Create app
GET    /zones/{zone_id}/spectrum/apps/{app_id}           # Get app
PUT    /zones/{zone_id}/spectrum/apps/{app_id}           # Update app
DELETE /zones/{zone_id}/spectrum/apps/{app_id}           # Delete app

GET    /zones/{zone_id}/spectrum/analytics/aggregate/current
GET    /zones/{zone_id}/spectrum/analytics/events/bytime
GET    /zones/{zone_id}/spectrum/analytics/events/summary
```

## Request/Response Schemas

### CreateSpectrumAppRequest

```typescript
interface CreateSpectrumAppRequest {
  protocol: string;                    // "tcp/22", "udp/53"
  dns: {
    type: "CNAME" | "ADDRESS";
    name: string;                      // "ssh.example.com"
  };
  origin_direct?: string[];            // ["tcp://192.0.2.1:22"]
  origin_dns?: { name: string };       // {"name": "origin.example.com"}
  origin_port?: number | { start: number; end: number };
  proxy_protocol?: "off" | "v1" | "v2" | "simple";
  ip_firewall?: boolean;
  tls?: "off" | "flexible" | "full" | "strict";
  edge_ips?: {
    type: "dynamic" | "static";
    connectivity: "all" | "ipv4" | "ipv6";
  };
  traffic_type?: "direct" | "http" | "https";
  argo_smart_routing?: boolean;
}
```

### SpectrumApp Response

```typescript
interface SpectrumApp {
  id: string;
  protocol: string;
  dns: { type: string; name: string };
  origin_direct?: string[];
  origin_dns?: { name: string };
  origin_port?: number | { start: number; end: number };
  proxy_protocol: string;
  ip_firewall: boolean;
  tls: string;
  edge_ips: { type: string; connectivity: string; ips?: string[] };
  argo_smart_routing: boolean;
  created_on: string;
  modified_on: string;
}
```

## TypeScript SDK

```typescript
import Cloudflare from 'cloudflare';

const client = new Cloudflare({ apiToken: process.env.CLOUDFLARE_API_TOKEN });

// Create
const app = await client.spectrum.apps.create({
  zone_id: 'your-zone-id',
  protocol: 'tcp/22',
  dns: { type: 'CNAME', name: 'ssh.example.com' },
  origin_direct: ['tcp://192.0.2.1:22'],
  ip_firewall: true,
  tls: 'off',
});

// List
const apps = await client.spectrum.apps.list({ zone_id: 'your-zone-id' });

// Get
const appDetails = await client.spectrum.apps.get({ zone_id: 'your-zone-id', app_id: app.id });

// Update
await client.spectrum.apps.update({ zone_id: 'your-zone-id', app_id: app.id, tls: 'full' });

// Delete
await client.spectrum.apps.delete({ zone_id: 'your-zone-id', app_id: app.id });

// Analytics
const analytics = await client.spectrum.analytics.aggregate({
  zone_id: 'your-zone-id',
  metrics: ['bytesIngress', 'bytesEgress'],
  since: new Date(Date.now() - 3600000).toISOString(),
});
```

## Python SDK

```python
from cloudflare import Cloudflare

client = Cloudflare(api_token="your-api-token")

# Create
app = client.spectrum.apps.create(
    zone_id="your-zone-id",
    protocol="tcp/22",
    dns={"type": "CNAME", "name": "ssh.example.com"},
    origin_direct=["tcp://192.0.2.1:22"],
    ip_firewall=True,
    tls="off",
)

# List
apps = client.spectrum.apps.list(zone_id="your-zone-id")

# Get
app_details = client.spectrum.apps.get(zone_id="your-zone-id", app_id=app.id)

# Update
client.spectrum.apps.update(zone_id="your-zone-id", app_id=app.id, tls="full")

# Delete
client.spectrum.apps.delete(zone_id="your-zone-id", app_id=app.id)

# Analytics
analytics = client.spectrum.analytics.aggregate(
    zone_id="your-zone-id",
    metrics=["bytesIngress", "bytesEgress"],
    since=datetime.now() - timedelta(hours=1),
)
```

## Go SDK

```go
import "github.com/cloudflare/cloudflare-go"

api, _ := cloudflare.NewWithAPIToken("your-api-token")

// Create
app, _ := api.CreateSpectrumApplication(ctx, "zone-id", cloudflare.SpectrumApplication{
    Protocol:         "tcp/22",
    DNS:              cloudflare.SpectrumApplicationDNS{Type: "CNAME", Name: "ssh.example.com"},
    OriginDirect:     []string{"tcp://192.0.2.1:22"},
    IPFirewall:       true,
    ArgoSmartRouting: true,
})

// List
apps, _ := api.SpectrumApplications(ctx, "zone-id")

// Delete
_ = api.DeleteSpectrumApplication(ctx, "zone-id", app.ID)
```

## Analytics API

**Metrics:**
- `bytesIngress` - Bytes received from clients
- `bytesEgress` - Bytes sent to clients
- `count` - Number of connections
- `duration` - Connection duration (seconds)

**Dimensions:**
- `event` - Connection event type
- `appID` - Spectrum application ID
- `coloName` - Datacenter name
- `ipVersion` - IPv4 or IPv6

**Example:**
```bash
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/spectrum/analytics/aggregate/current?metrics=bytesIngress,bytesEgress,count&dimensions=appID" \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

## See Also

- [configuration.md](configuration.md) - Terraform/Pulumi
- [patterns.md](patterns.md) - Protocol examples
