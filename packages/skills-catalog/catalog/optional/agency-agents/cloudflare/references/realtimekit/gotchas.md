# RealtimeKit Gotchas & Troubleshooting

## Common Errors

### "Cannot connect to meeting"

**Cause:** Auth token invalid/expired, API credentials lack permissions, or network blocks WebRTC
**Solution:**
Verify token validity, check API token has **Realtime / Realtime Admin** permissions, enable TURN service for restrictive networks

### "No video/audio tracks"

**Cause:** Browser permissions not granted, video/audio not enabled, device in use, or device unavailable
**Solution:**
Request browser permissions explicitly, verify initialization config, use `meeting.self.getAllDevices()` to debug, close other apps using device

### "Participant count mismatched"

**Cause:** `meeting.participants` doesn't include `meeting.self`
**Solution:** Total count = `meeting.participants.joined.size() + 1`

### "Events not firing"

**Cause:** Listeners registered after actions, incorrect event name, or wrong namespace
**Solution:**
Register listeners before calling `meeting.join()`, check event names against docs, verify correct namespace

### "CORS errors in API calls"

**Cause:** Making REST API calls from client-side
**Solution:** All REST API calls **must** be server-side (Workers, backend). Never expose API tokens to clients.

### "Preset not applying"

**Cause:** Preset doesn't exist, name mismatch (case-sensitive), or participant created before preset
**Solution:**
Verify preset exists via Dashboard or API, check exact spelling and case, create preset before adding participants

### "Token reuse error"

**Cause:** Reusing participant tokens across sessions
**Solution:** Generate fresh token per session. Use refresh endpoint if token expires during session.

### "Video quality poor"

**Cause:** Insufficient bandwidth, resolution/bitrate too high, or CPU overload
**Solution:**
Lower `mediaConfiguration.video` resolution/frameRate, monitor network conditions, reduce participant count or grid size

### "Echo or audio feedback"

**Cause:** Multiple devices picking up same audio source
**Solution:**
- Lower `mediaConfiguration.video` resolution/frameRate
- Monitor network conditions
- Reduce participant count or grid size

### Issue: Echo or audio feedback
**Cause**: Multiple devices picking up same audio source

**Solutions**:
Enable `echoCancellation: true` in `mediaConfiguration.audio`, use headphones, mute when not speaking

### "Screen share not working"

**Cause:** Browser doesn't support screen sharing API, permission denied, or wrong `displaySurface` config
**Solution:**
Use Chrome/Edge/Firefox (Safari limited support), check browser permissions, try different `displaySurface` values ('window', 'monitor', 'browser')

### "How do I schedule meetings?"

**Cause:** RealtimeKit has no built-in scheduling system
**Solution:**
Store meeting IDs in your database with timestamps. Generate participant tokens only when user should join. Example:
```typescript
// Store in DB
{ meetingId: 'abc123', scheduledFor: '2026-02-15T10:00:00Z', userId: 'user456' }

// Generate token when user clicks "Join" near scheduled time
const response = await fetch('/api/join-meeting', {
  method: 'POST',
  body: JSON.stringify({ meetingId: 'abc123' })
});
const { authToken } = await response.json();
```

### "Recording not starting"

**Cause:** Preset lacks recording permissions, no active session, or API call from client
**Solution:**
Verify preset has `canRecord: true` and `canStartStopRecording: true`, ensure session is active (at least one participant), make recording API calls server-side only

## Limits

| Resource | Limit |
|----------|-------|
| Max participants per session | 100 |
| Max concurrent sessions per App | 1000 |
| Max recording duration | 6 hours |
| Max meeting duration | 24 hours |
| Max chat message length | 4000 characters |
| Max preset name length | 64 characters |
| Max meeting title length | 256 characters |
| Max participant name length | 256 characters |
| Token expiration | 24 hours (default) |
| WebRTC ports required | UDP 1024-65535 |

## Network Requirements

### Firewall Rules
Allow outbound UDP/TCP to:
- `*.cloudflare.com` ports 443, 80
- UDP ports 1024-65535 (WebRTC media)

### TURN Service
Enable for users behind restrictive firewalls/proxies:
```jsonc
// wrangler.jsonc
{
  "vars": {
    "TURN_SERVICE_ID": "your_turn_service_id"
  }
  // Set secret: wrangler secret put TURN_SERVICE_TOKEN
}
```

TURN automatically configured in SDK when enabled in account.

## Debugging Tips

```typescript
// Check devices
const devices = await meeting.self.getAllDevices();
meeting.self.on('deviceListUpdate', ({ added, removed, devices }) => console.log('Devices:', { added, removed, devices }));

// Monitor participants
meeting.participants.joined.on('participantJoined', (p) => console.log(`${p.name} joined:`, { id: p.id, userId: p.userId, audioEnabled: p.audioEnabled, videoEnabled: p.videoEnabled }));

// Check room state
meeting.self.on('roomJoined', () => console.log('Room:', { meetingId: meeting.meta.meetingId, meetingTitle: meeting.meta.meetingTitle, participantCount: meeting.participants.joined.size() + 1, audioEnabled: meeting.self.audioEnabled, videoEnabled: meeting.self.videoEnabled }));

// Log all events
['roomJoined', 'audioUpdate', 'videoUpdate', 'screenShareUpdate', 'deviceUpdate', 'deviceListUpdate'].forEach(event => meeting.self.on(event, (data) => console.log(`[self] ${event}:`, data)));
['participantJoined', 'participantLeft'].forEach(event => meeting.participants.joined.on(event, (data) => console.log(`[participants] ${event}:`, data)));
meeting.chat.on('chatUpdate', (data) => console.log('[chat] chatUpdate:', data));
```

## Security & Performance

### Security: Do NOT
- Expose `CLOUDFLARE_API_TOKEN` in client code, hardcode credentials in frontend
- Reuse participant tokens, store tokens in localStorage without encryption
- Allow client-side meeting creation

### Security: DO
- Generate tokens server-side only, use HTTPS, implement rate limiting
- Validate user auth before generating tokens, use `custom_participant_id` to map to your user system
- Set appropriate preset permissions per user role, rotate API tokens regularly

### Performance
- **CPU**: Lower video resolution/frameRate, disable video for audio-only, use `meeting.participants.active` for large meetings, implement virtual scrolling
- **Bandwidth**: Set max resolution in `mediaConfiguration`, disable screenshare audio if unneeded, use audio-only mode, implement adaptive bitrate
- **Memory**: Clean up event listeners on unmount, call `meeting.leave()` when done, don't store large participant arrays

## In This Reference
- [README.md](README.md) - Overview, core concepts, quick start
- [configuration.md](configuration.md) - SDK config, presets, wrangler setup
- [api.md](api.md) - Client SDK APIs, REST endpoints
- [patterns.md](patterns.md) - Common patterns, React hooks, backend integration
