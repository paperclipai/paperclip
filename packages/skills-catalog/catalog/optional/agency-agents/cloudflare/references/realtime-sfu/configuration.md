# Configuration & Deployment

## Dashboard Setup

1. Navigate to https://dash.cloudflare.com/?to=/:account/calls
2. Click "Create Application" (or use existing app)
3. Copy `CALLS_APP_ID` from dashboard
4. Generate and copy `CALLS_APP_SECRET` (treat as sensitive credential)
5. Use credentials in Wrangler config or environment variables below

## Dependencies

**Backend (Workers):** Built-in fetch API, no additional packages required

**Client (PartyTracks):**
```bash
npm install partytracks @cloudflare/calls
```

**Client (React + PartyTracks):**
```bash
npm install partytracks @cloudflare/calls observable-hooks
# Observable hooks: useObservableAsValue, useValueAsObservable
```

**Client (Raw API):** Native browser WebRTC API only

## Wrangler Setup

```jsonc
{
  "name": "my-calls-app",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01", // Use current date for new projects
  "vars": {
    "CALLS_APP_ID": "your-app-id",
    "MAX_WEBCAM_BITRATE": "1200000",
    "MAX_WEBCAM_FRAMERATE": "24",
    "MAX_WEBCAM_QUALITY_LEVEL": "1080"
  },
  // Set secret: wrangler secret put CALLS_APP_SECRET
  "durable_objects": {
    "bindings": [
      {
        "name": "ROOM",
        "class_name": "Room"
      }
    ]
  }
}
```

## Deploy

```bash
wrangler login
wrangler secret put CALLS_APP_SECRET
wrangler deploy
```

## Environment Variables

**Required:**
- `CALLS_APP_ID`: From dashboard
- `CALLS_APP_SECRET`: From dashboard (secret)

**Optional:**
- `MAX_WEBCAM_BITRATE` (default: 1200000)
- `MAX_WEBCAM_FRAMERATE` (default: 24)
- `MAX_WEBCAM_QUALITY_LEVEL` (default: 1080)
- `TURN_SERVICE_ID`: TURN service
- `TURN_SERVICE_TOKEN`: TURN auth (secret)

## TURN Configuration

```javascript
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp'
      ],
      username: turnUsername,
      credential: turnCredential
    }
  ],
  bundlePolicy: 'max-bundle', // Recommended: reduces overhead
  iceTransportPolicy: 'all'    // Use 'relay' to force TURN (testing only)
});
```

**Ports:** 3478 (UDP/TCP), 53 (UDP), 80 (TCP), 443 (TLS), 5349 (TLS)

**When to use TURN:** Required for restrictive corporate firewalls/networks that block UDP. ~5-10% of connections fallback to TURN. STUN works for most users.

**ICE candidate filtering:** Cloudflare handles candidate filtering automatically. No need to manually filter candidates.

## Durable Object Boilerplate

Minimal presence system:

```typescript
export class Room {
  private sessions = new Map<string, {userId: string, tracks: string[]}>();

  async fetch(req: Request) {
    const {pathname} = new URL(req.url);
    const body = await req.json();
    
    if (pathname === '/join') {
      this.sessions.set(body.sessionId, {userId: body.userId, tracks: []});
      return Response.json({participants: this.sessions.size});
    }
    
    if (pathname === '/publish') {
      this.sessions.get(body.sessionId)?.tracks.push(...body.tracks);
      // Broadcast to others via WebSocket (not shown)
      return new Response('OK');
    }
    
    return new Response('Not found', {status: 404});
  }
}
```

## Environment Validation

Check credentials before first API call:

```typescript
if (!env.CALLS_APP_ID || !env.CALLS_APP_SECRET) {
  throw new Error('CALLS_APP_ID and CALLS_APP_SECRET required');
}
```
