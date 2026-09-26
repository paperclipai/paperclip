# TURN Gotchas & Troubleshooting

Common mistakes, security best practices, and troubleshooting for Cloudflare TURN.

## Quick Reference

| Issue | Solution | Details |
|-------|----------|---------|
| Credentials not working | Check TTL ≤ 48hrs | [See Troubleshooting](#issue-turn-credentials-not-working) |
| Connection drops after ~48hrs | Implement credential refresh | [See Connection Drops](#issue-connection-drops-after-48-hours) |
| Port 53 fails in browser | Filter server-side | [See Port 53](#using-port-53-in-browsers) |
| High packet loss | Check rate limits | [See Rate Limits](#limits-per-turn-allocation) |
| Connection fails after maintenance | Implement ICE restart | [See ICE Restart](#ice-restart-required-scenarios) |

## Critical Constraints

| Constraint | Value | Consequence if Violated |
|------------|-------|-------------------------|
| Max credential TTL | 48 hours (172800s) | API rejects request |
| Credential revocation delay | ~seconds | Billing stops immediately, connection drops shortly |
| IP allowlist update window | 14 days (if IPs change) | Connection fails if IPs change |
| Packet rate | 5-10k pps per allocation | Packet drops |
| Data rate | 50-100 Mbps per allocation | Packet drops |
| Unique IP rate | >5 new IPs/sec | Packet drops |

## Limits Per TURN Allocation

**Per user** (not account-wide):

- **IP addresses**: >5 new unique IPs per second
- **Packet rate**: 5-10k packets per second (inbound/outbound)
- **Data rate**: 50-100 Mbps (inbound/outbound)
- **MTU**: No specific limit
- **Burst rates**: Higher than documented

Exceeding limits results in **packet drops**.

## Common Mistakes

### Setting TTL > 48 hours

```typescript
// ❌ BAD: API will reject
const creds = await generate({ ttl: 604800 });  // 7 days

// ✅ GOOD:
const creds = await generate({ ttl: 86400 });   // 24 hours
```

### Hardcoding IPs without monitoring

```typescript
// ❌ BAD: IPs can change with 14-day notice
const iceServers = [{ urls: 'turn:141.101.90.1:3478' }];

// ✅ GOOD: Use DNS
const iceServers = [{ urls: 'turn:turn.cloudflare.com:3478' }];
```

### Using port 53 in browsers

```typescript
// ❌ BAD: Blocked by Chrome/Firefox
urls: ['turn:turn.cloudflare.com:53']

// ✅ GOOD: Filter port 53
urls: urls.filter(url => !url.includes(':53'))
```

### Not handling credential expiry

```typescript
// ❌ BAD: Credentials expire but call continues → connection drops
const creds = await fetchCreds();
const pc = new RTCPeerConnection({ iceServers: creds });

// ✅ GOOD: Refresh before expiry
setInterval(() => refreshCredentials(pc), 3000000);  // 50 min
```

### Missing ICE restart support

```typescript
// ❌ BAD: No recovery from TURN maintenance
pc.addEventListener('iceconnectionstatechange', () => {
  console.log('State changed:', pc.iceConnectionState);
});

// ✅ GOOD: Implement ICE restart
pc.addEventListener('iceconnectionstatechange', async () => {
  if (pc.iceConnectionState === 'failed') {
    await refreshCredentials(pc);
    pc.restartIce();
  }
});
```

### Exposing TURN key secret client-side

```typescript
// ❌ BAD: Secret exposed to client
const secret = 'your-turn-key-secret';
const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/...`, {
  headers: { 'Authorization': `Bearer ${secret}` }
});

// ✅ GOOD: Generate credentials server-side
const response = await fetch('/api/turn-credentials');
```

## ICE Restart Required Scenarios

These events require ICE restart (see [patterns.md](./patterns.md#ice-restart-pattern)):

1. **TURN server maintenance** (occasional on Cloudflare's network)
2. **Network topology changes** (anycast routing changes)
3. **Credential refresh** during long sessions (>1 hour)
4. **Connection failure** (iceConnectionState === 'failed')

Implement in all production apps:

```typescript
pc.addEventListener('iceconnectionstatechange', async () => {
  if (pc.iceConnectionState === 'failed' || 
      pc.iceConnectionState === 'disconnected') {
    await refreshTURNCredentials(pc);
    pc.restartIce();
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    // Send offer to peer via signaling...
  }
});
```

Reference: [RFC 8445 Section 2.4](https://datatracker.ietf.org/doc/html/rfc8445#section-2.4)

## Security Checklist

- [ ] Credentials generated server-side only (never client-side)
- [ ] TURN_KEY_SECRET in wrangler secrets, not vars
- [ ] TTL ≤ expected session duration (and ≤ 48 hours)
- [ ] Rate limiting on credential generation endpoint
- [ ] Client authentication before issuing credentials
- [ ] Credential revocation API for compromised sessions
- [ ] No hardcoded IPs (or DNS monitoring in place)
- [ ] Port 53 filtered for browser clients

## Troubleshooting

### Issue: TURN credentials not working

**Check:**
- Key ID and secret are correct
- Credentials haven't expired (check TTL)
- TTL doesn't exceed 172800 seconds (48 hours)
- Server can reach rtc.live.cloudflare.com
- Network allows outbound HTTPS

**Solution:**
```typescript
// Validate before using
if (ttl > 172800) {
  throw new Error('TTL cannot exceed 48 hours');
}
```

### Issue: Slow connection establishment

**Solutions:**
- Ensure proper ICE candidate gathering
- Check network latency to Cloudflare edge
- Verify firewall allows WebRTC ports (3478, 5349, 443)
- Consider using TURN over TLS (port 443) for corporate networks

### Issue: High packet loss

**Check:**
- Not exceeding rate limits (5-10k pps)
- Not exceeding bandwidth limits (50-100 Mbps)
- Not connecting to too many unique IPs (>5/sec)
- Client network quality

### Issue: Connection drops after ~48 hours

**Cause**: Credentials expired (48hr max)

**Solution**: 
- Set TTL to expected session duration
- Implement credential refresh with setConfiguration()
- Use ICE restart if connection fails

```typescript
// Refresh credentials before expiry
const refreshInterval = ttl * 1000 - 60000; // 1 min early
setInterval(async () => {
  await refreshTURNCredentials(pc);
}, refreshInterval);
```

### Issue: Port 53 URLs in browser fail silently

**Cause**: Chrome/Firefox block port 53

**Solution**: Filter port 53 URLs server-side:

```typescript
const filtered = urls.filter(url => !url.includes(':53'));
```

### Issue: Hardcoded IPs stop working

**Cause**: Cloudflare changed IP addresses (14-day notice)

**Solution**: 
- Use DNS hostnames (`turn.cloudflare.com`)
- Monitor DNS changes with automated alerts
- Update allowlists within 14 days if using IP allowlisting

## Cost Optimization

1. Use appropriate TTLs (don't over-provision)
2. Implement credential caching
3. Set `iceTransportPolicy: 'all'` to try direct first (use `'relay'` only when necessary)
4. Monitor bandwidth usage
5. Free when used with Cloudflare Calls SFU

## See Also

- [api.md](./api.md) - Credential generation API, revocation
- [configuration.md](./configuration.md) - IP allowlisting, monitoring
- [patterns.md](./patterns.md) - ICE restart, credential refresh patterns
