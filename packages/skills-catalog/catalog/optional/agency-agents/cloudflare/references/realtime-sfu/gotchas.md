# Gotchas & Troubleshooting

## Common Errors

### "Slow initial connect (~1.8s)"

**Cause:** First STUN delayed during consensus forming (normal behavior)
**Solution:** Subsequent connections are faster. CF detects DTLS ClientHello early to compensate.

### "No media flow"

**Cause:** SDP exchange incomplete, connection not established, tracks not added before offer, browser permissions missing
**Solution:** 
1. Verify SDP exchange complete
2. Check `pc.connectionState === 'connected'`
3. Ensure tracks added before creating offer
4. Confirm browser permissions granted
5. Use `chrome://webrtc-internals` for debugging

### "Track not receiving"

**Cause:** Track not published, track ID not shared, session IDs mismatch, `pc.ontrack` not set, renegotiation needed
**Solution:** 
1. Verify track published successfully
2. Confirm track ID shared between peers
3. Check session IDs match
4. Set `pc.ontrack` handler before answer
5. Trigger renegotiation if needed

### "ICE connection failed"

**Cause:** Network changed, firewall blocked UDP, TURN needed, transient network issue
**Solution:**
```typescript
pc.oniceconnectionstatechange = async () => {
  if (pc.iceConnectionState === 'failed') {
    console.warn('ICE failed, attempting restart');
    await pc.restartIce(); // Triggers new ICE gathering
    
    // Create new offer with ICE restart flag
    const offer = await pc.createOffer({iceRestart: true});
    await pc.setLocalDescription(offer);
    
    // Send to backend → Cloudflare API
    await fetch(`/api/sessions/${sessionId}/renegotiate`, {
      method: 'PUT',
      body: JSON.stringify({sdp: offer.sdp})
    });
  }
};
```

### "Track stuck/frozen"

**Cause:** Sender paused track, network congestion, codec mismatch, mobile browser backgrounded
**Solution:**
1. Check `track.enabled` and `track.readyState === 'live'`
2. Verify sender active: `pc.getSenders().find(s => s.track === track)`
3. Check stats for packet loss/jitter (see patterns.md)
4. On mobile: Re-acquire tracks when app foregrounded
5. Test with different codecs if persistent

### "Network change disconnects call"

**Cause:** Mobile switching WiFi↔cellular, laptop changing networks
**Solution:**
```typescript
// Listen for network changes
if ('connection' in navigator) {
  (navigator as any).connection.addEventListener('change', async () => {
    console.log('Network changed');
    await pc.restartIce(); // Use ICE restart pattern above
  });
}

// Or use PartyTracks (handles automatically)
```

## Retry with Exponential Backoff

```typescript
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status >= 500) throw new Error('Server error');
      return res; // Client error, don't retry
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      const delay = Math.min(1000 * 2 ** i, 10000); // Cap at 10s
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

## Debugging with chrome://webrtc-internals

1. Open `chrome://webrtc-internals` in Chrome/Edge
2. Find your PeerConnection in the list
3. Check **Stats graphs** for packet loss, jitter, bandwidth
4. Check **ICE candidate pairs**: Look for `succeeded` state, relay vs host candidates
5. Check **getStats**: Raw metrics for inbound/outbound RTP
6. Look for errors in **Event log**: `iceConnectionState`, `connectionState` changes
7. Export data with "Download the PeerConnection updates and stats data" button
8. Common issues visible here: ICE failures, high packet loss, bitrate drops

## Limits

| Resource/Limit | Value | Notes |
|----------------|-------|-------|
| Egress (Free) | 1TB/month | Per account |
| Egress (Paid) | $0.05/GB | After free tier |
| Inbound traffic | Free | All plans |
| TURN service | Free | Included with SFU |
| Participants | No hard limit | Client bandwidth/CPU bound (typically 10-50 tracks) |
| Tracks per session | No hard limit | Client resources limited |
| Session duration | No hard limit | Production calls run for hours |
| WebRTC ports | UDP 1024-65535 | Outbound only, required for media |
| API rate limit | 600 req/min | Per app, burst allowed |

## Security Checklist

- ✅ **Never expose** `CALLS_APP_SECRET` to client
- ✅ **Validate user identity** in backend before creating sessions
- ✅ **Implement auth tokens** for session access (JWT in custom header)
- ✅ **Rate limit** session creation endpoints
- ✅ **Expire sessions** server-side after inactivity
- ✅ **Validate track IDs** before subscribing (prevent unauthorized access)
- ✅ **Use HTTPS** for all signaling (API calls)
- ✅ **Enable DTLS-SRTP** (automatic with Cloudflare, encrypts media)
- ⚠️ **Consider E2EE** for sensitive content (implement client-side with Insertable Streams API)
