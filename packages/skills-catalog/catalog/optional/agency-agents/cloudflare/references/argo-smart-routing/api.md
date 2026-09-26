## API Reference

**Note on Smart Shield:** Argo Smart Routing is being integrated into Cloudflare's Smart Shield product. API endpoints remain stable; existing integrations continue to work without changes.

### Base Endpoint
```
https://api.cloudflare.com/client/v4
```

### Authentication
Use API tokens with Zone:Argo Smart Routing:Edit permissions:

```bash
# Headers required
X-Auth-Email: user@example.com
Authorization: Bearer YOUR_API_TOKEN
```

### Get Argo Smart Routing Status

**Endpoint:** `GET /zones/{zone_id}/argo/smart_routing`

**Description:** Retrieves current Argo Smart Routing enablement status.

**cURL Example:**
```bash
curl -X GET "https://api.cloudflare.com/client/v4/zones/{zone_id}/argo/smart_routing" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "result": {
    "id": "smart_routing",
    "value": "on",
    "editable": true,
    "modified_on": "2024-01-11T12:00:00Z"
  },
  "success": true,
  "errors": [],
  "messages": []
}
```

**TypeScript SDK Example:**
```typescript
import Cloudflare from 'cloudflare';

const client = new Cloudflare({
  apiToken: process.env.CLOUDFLARE_API_TOKEN
});

const status = await client.argo.smartRouting.get({ zone_id: 'your-zone-id' });
console.log(`Argo status: ${status.value}, editable: ${status.editable}`);
```

**Python SDK Example:**
```python
from cloudflare import Cloudflare

client = Cloudflare(api_token=os.environ.get('CLOUDFLARE_API_TOKEN'))

status = client.argo.smart_routing.get(zone_id='your-zone-id')
print(f"Argo status: {status.value}, editable: {status.editable}")
```

### Update Argo Smart Routing Status

**Endpoint:** `PATCH /zones/{zone_id}/argo/smart_routing`

**Description:** Enable or disable Argo Smart Routing for a zone.

**Request Body:**
```json
{
  "value": "on"  // or "off"
}
```

**cURL Example:**
```bash
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/{zone_id}/argo/smart_routing" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "on"}'
```

**TypeScript SDK Example:**
```typescript
const result = await client.argo.smartRouting.edit({
  zone_id: 'your-zone-id',
  value: 'on',
});
console.log(`Updated: ${result.value} at ${result.modified_on}`);
```

**Python SDK Example:**
```python
result = client.argo.smart_routing.edit(
    zone_id='your-zone-id',
    value='on'
)
print(f"Updated: {result.value} at {result.modified_on}")
```

## Checking Editability Before Updates

**Critical:** Always check the `editable` field before attempting to enable/disable Argo. When `editable: false`, the zone has restrictions (billing not configured, insufficient permissions, or plan limitations).

**Pattern:**
```typescript
async function safelyEnableArgo(client: Cloudflare, zoneId: string): Promise<boolean> {
  const status = await client.argo.smartRouting.get({ zone_id: zoneId });
  
  if (!status.editable) {
    console.error('Cannot modify Argo: editable=false (check billing/permissions)');
    return false;
  }
  
  if (status.value === 'on') {
    console.log('Argo already enabled');
    return true;
  }
  
  await client.argo.smartRouting.edit({ zone_id: zoneId, value: 'on' });
  console.log('Argo enabled successfully');
  return true;
}
```

**Python Pattern:**
```python
def safely_enable_argo(client: Cloudflare, zone_id: str) -> bool:
    status = client.argo.smart_routing.get(zone_id=zone_id)
    
    if not status.editable:
        print('Cannot modify Argo: editable=false (check billing/permissions)')
        return False
    
    if status.value == 'on':
        print('Argo already enabled')
        return True
    
    client.argo.smart_routing.edit(zone_id=zone_id, value='on')
    print('Argo enabled successfully')
    return True
```

## Error Handling

The TypeScript SDK provides typed error classes for robust error handling:

```typescript
import Cloudflare from 'cloudflare';
import { APIError, APIConnectionError, RateLimitError } from 'cloudflare';

async function enableArgoWithErrorHandling(client: Cloudflare, zoneId: string) {
  try {
    const result = await client.argo.smartRouting.edit({
      zone_id: zoneId,
      value: 'on',
    });
    return result;
  } catch (error) {
    if (error instanceof RateLimitError) {
      console.error('Rate limited. Retry after:', error.response?.headers.get('retry-after'));
      // Implement exponential backoff
    } else if (error instanceof APIError) {
      console.error('API error:', error.status, error.message);
      if (error.status === 403) {
        console.error('Permission denied - check API token scopes');
      } else if (error.status === 400) {
        console.error('Bad request - verify zone_id and payload');
      }
    } else if (error instanceof APIConnectionError) {
      console.error('Connection failed:', error.message);
      // Retry with exponential backoff
    } else {
      console.error('Unexpected error:', error);
    }
    throw error;
  }
}
```

**Python Error Handling:**
```python
from cloudflare import Cloudflare, APIError, RateLimitError

def enable_argo_with_error_handling(client: Cloudflare, zone_id: str):
    try:
        result = client.argo.smart_routing.edit(zone_id=zone_id, value='on')
        return result
    except RateLimitError as e:
        print(f"Rate limited. Retry after: {e.response.headers.get('retry-after')}")
        raise
    except APIError as e:
        print(f"API error: {e.status} - {e.message}")
        if e.status == 403:
            print('Permission denied - check API token scopes')
        elif e.status == 400:
            print('Bad request - verify zone_id and payload')
        raise
    except Exception as e:
        print(f"Unexpected error: {e}")
        raise
```

## Response Schema

All Argo Smart Routing API responses follow this structure:

```typescript
interface ArgoSmartRoutingResponse {
  result: {
    id: 'smart_routing';
    value: 'on' | 'off';
    editable: boolean;
    modified_on: string; // ISO 8601 timestamp
  };
  success: boolean;
  errors: Array<{
    code: number;
    message: string;
  }>;
  messages: Array<string>;
}
```

## Key Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `value` | `"on" \| "off"` | Current enablement status |
| `editable` | `boolean` | Whether changes are allowed (check before PATCH) |
| `modified_on` | `string` | ISO timestamp of last modification |
| `success` | `boolean` | Whether request succeeded |
| `errors` | `Array` | Error details if `success: false`