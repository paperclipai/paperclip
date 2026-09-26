# CNI API Reference

See [README.md](README.md) for overview.

## Base

```
https://api.cloudflare.com/client/v4
Auth: Authorization: Bearer <token>
```

## SDK Namespaces

**Primary (recommended):**
```typescript
client.networkInterconnects.interconnects.*
client.networkInterconnects.cnis.*
client.networkInterconnects.slots.*
```

**Alternate (deprecated):**
```typescript
client.magicTransit.cfInterconnects.*
```

Use `networkInterconnects` namespace for all new code.

## Interconnects

```http
GET    /accounts/{account_id}/cni/interconnects              # Query: page, per_page
POST   /accounts/{account_id}/cni/interconnects              # Query: validate_only=true (optional)
GET    /accounts/{account_id}/cni/interconnects/{icon}
GET    /accounts/{account_id}/cni/interconnects/{icon}/status
GET    /accounts/{account_id}/cni/interconnects/{icon}/loa   # Returns PDF
DELETE /accounts/{account_id}/cni/interconnects/{icon}
```

**Create Body:** `account`, `slot_id`, `type`, `facility`, `speed`, `name`, `description`  
**Status Values:** `active` | `healthy` | `unhealthy` | `pending` | `down`

**Response Example:**
```json
{"result": [{"id": "icon_abc", "name": "prod", "type": "direct", "facility": "EWR1", "speed": "10G", "status": "active"}]}
```

## CNI Objects (BGP config)

```http
GET    /accounts/{account_id}/cni/cnis
POST   /accounts/{account_id}/cni/cnis
GET    /accounts/{account_id}/cni/cnis/{cni}
PUT    /accounts/{account_id}/cni/cnis/{cni}
DELETE /accounts/{account_id}/cni/cnis/{cni}
```

Body: `account`, `cust_ip`, `cf_ip`, `bgp_asn`, `bgp_password`, `vlan`

## Slots

```http
GET /accounts/{account_id}/cni/slots
GET /accounts/{account_id}/cni/slots/{slot}
```

Query: `facility`, `occupied`, `speed`

## Health Checks

Configure via Magic Transit/WAN tunnel endpoints (CNI v2).

```typescript
await client.magicTransit.tunnels.update(accountId, tunnelId, {
  health_check: { enabled: true, target: '192.0.2.1', rate: 'high', type: 'request' },
});
```

Rates: `high` | `medium` | `low`. Types: `request` | `reply`. See [Magic Transit docs](https://developers.cloudflare.com/magic-transit/how-to/configure-tunnel-endpoints/#add-tunnels).

## Settings

```http
GET /accounts/{account_id}/cni/settings
PUT /accounts/{account_id}/cni/settings
```

Body: `default_asn`

## TypeScript SDK

```typescript
import Cloudflare from 'cloudflare';

const client = new Cloudflare({ apiToken: process.env.CF_TOKEN });

// List
await client.networkInterconnects.interconnects.list({ account_id: id });

// Create with validation
await client.networkInterconnects.interconnects.create({
  account_id: id,
  account: id,
  slot_id: 'slot_abc',
  type: 'direct',
  facility: 'EWR1',
  speed: '10G',
  name: 'prod-interconnect',
}, {
  query: { validate_only: true }, // Dry-run validation
});

// Create without validation
await client.networkInterconnects.interconnects.create({
  account_id: id,
  account: id,
  slot_id: 'slot_abc',
  type: 'direct',
  facility: 'EWR1',
  speed: '10G',
  name: 'prod-interconnect',
});

// Status
await client.networkInterconnects.interconnects.get(accountId, iconId);

// LOA (use fetch)
const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${id}/cni/interconnects/${iconId}/loa`, {
  headers: { Authorization: `Bearer ${token}` },
});
await fs.writeFile('loa.pdf', Buffer.from(await res.arrayBuffer()));

// CNI object
await client.networkInterconnects.cnis.create({
  account_id: id,
  account: id,
  cust_ip: '192.0.2.1/31',
  cf_ip: '192.0.2.0/31',
  bgp_asn: 65000,
  vlan: 100,
});

// Slots (filter by facility and speed)
await client.networkInterconnects.slots.list({
  account_id: id,
  occupied: false,
  facility: 'EWR1',
  speed: '10G',
});
```

## Python SDK

```python
from cloudflare import Cloudflare

client = Cloudflare(api_token=os.environ["CF_TOKEN"])

# List, create, status (same pattern as TypeScript)
client.network_interconnects.interconnects.list(account_id=id)
client.network_interconnects.interconnects.create(account_id=id, account=id, slot_id="slot_abc", type="direct", facility="EWR1", speed="10G")
client.network_interconnects.interconnects.get(account_id=id, icon=icon_id)

# CNI objects and slots
client.network_interconnects.cnis.create(account_id=id, cust_ip="192.0.2.1/31", cf_ip="192.0.2.0/31", bgp_asn=65000)
client.network_interconnects.slots.list(account_id=id, occupied=False)
```

## cURL

```bash
# List interconnects
curl "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cni/interconnects" \
  -H "Authorization: Bearer ${CF_TOKEN}"

# Create interconnect
curl -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cni/interconnects?validate_only=true" \
  -H "Authorization: Bearer ${CF_TOKEN}" -H "Content-Type: application/json" \
  -d '{"account": "id", "slot_id": "slot_abc", "type": "direct", "facility": "EWR1", "speed": "10G"}'

# LOA PDF
curl "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cni/interconnects/${ICON_ID}/loa" \
  -H "Authorization: Bearer ${CF_TOKEN}" --output loa.pdf
```

## Not Available via API

**Missing Capabilities:**
- BGP session state query (use Dashboard or BGP logs)
- Bandwidth utilization metrics (use external monitoring)
- Traffic statistics per interconnect
- Historical uptime/downtime data
- Light level readings (contact account team)
- Maintenance window scheduling (notifications only)

## Resources

- [API Docs](https://developers.cloudflare.com/api/resources/network_interconnects/)
- [TypeScript SDK](https://github.com/cloudflare/cloudflare-typescript)
- [Python SDK](https://github.com/cloudflare/cloudflare-python)
