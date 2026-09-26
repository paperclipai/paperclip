## Common Issues

### Connection Timeouts

**Problem:** Connections fail or timeout  
**Cause:** Origin firewall blocking Cloudflare IPs, origin service not running, incorrect DNS  
**Solution:**
1. Verify origin firewall allows Cloudflare IP ranges
2. Check origin service running on correct port
3. Ensure DNS record is CNAME (not A/AAAA)
4. Verify origin IP/hostname is correct

```bash
# Test connectivity
nc -zv app.example.com 22
dig app.example.com
```

### Client IP Showing Cloudflare IP

**Problem:** Origin logs show Cloudflare IPs not real client IPs  
**Cause:** Proxy Protocol not enabled or origin not configured  
**Solution:**
```typescript
// Enable in Spectrum app
const app = await client.spectrum.apps.create({
  // ...
  proxy_protocol: 'v1',  // TCP: v1/v2; UDP: simple
});
```

**Origin config:**
- **nginx**: `listen 22 proxy_protocol;`
- **HAProxy**: `bind :22 accept-proxy`

### TLS Errors

**Problem:** TLS handshake failures, 525 errors  
**Cause:** TLS mode mismatch

| Error | TLS Mode | Problem | Solution |
|-------|----------|---------|----------|
| Connection refused | `full`/`strict` | Origin not TLS | Use `tls: "off"` or enable TLS |
| 525 cert invalid | `strict` | Self-signed cert | Use `tls: "full"` or valid cert |
| Handshake timeout | `flexible` | Origin expects TLS | Use `tls: "full"` |

**Debug:**
```bash
openssl s_client -connect app.example.com:443 -showcerts
```

### SMTP Reverse DNS

**Problem:** Email servers reject SMTP via Spectrum  
**Cause:** Spectrum IPs lack PTR (reverse DNS) records  
**Impact:** Many mail servers require valid rDNS for anti-spam

**Solution:**
- Outbound SMTP: NOT recommended through Spectrum
- Inbound SMTP: Use Cloudflare Email Routing
- Internal relay: Whitelist Spectrum IPs on destination

### Proxy Protocol Compatibility

**Problem:** Connection works but app behaves incorrectly  
**Cause:** Origin doesn't support Proxy Protocol

**Solution:**
1. Verify origin supports version (v1: widely supported, v2: HAProxy 1.5+/nginx 1.11+)
2. Test with `proxy_protocol: 'off'` first
3. Configure origin to parse headers

**nginx TCP:**
```nginx
stream {
    server {
        listen 22 proxy_protocol;
        proxy_pass backend:22;
    }
}
```

**HAProxy:**
```
frontend ft_ssh
    bind :22 accept-proxy
```

### Analytics Data Retention

**Problem:** Historical data not available  
**Cause:** Retention varies by plan

| Plan | Real-time | Historical |
|------|-----------|------------|
| Pro | Last hour | ❌ |
| Business | Last hour | Limited |
| Enterprise | Last hour | 90+ days |

**Solution:** Query within retention window or export to external system

### Enterprise-Only Features

**Problem:** Feature unavailable/errors  
**Cause:** Requires Enterprise plan

**Enterprise-only:**
- Port ranges (`tcp/25565-25575`)
- All TCP/UDP ports (Pro/Business: selected only)
- Extended analytics retention
- Advanced load balancing

### IPv6 Considerations

**Problem:** IPv6 clients can't connect or origin doesn't support IPv6  
**Solution:** Configure `edge_ips.connectivity`

```typescript
const app = await client.spectrum.apps.create({
  // ...
  edge_ips: {
    type: 'dynamic',
    connectivity: 'ipv4',  // Options: 'all', 'ipv4', 'ipv6'
  },
});
```

**Options:**
- `all`: Dual-stack (default, requires origin support both)
- `ipv4`: IPv4 only (use if origin lacks IPv6)
- `ipv6`: IPv6 only (rare)

## Limits

| Resource | Pro/Business | Enterprise |
|----------|--------------|------------|
| Max apps | ~10-15 | 100+ |
| Protocols | Selected | All TCP/UDP |
| Port ranges | ❌ | ✅ |
| Analytics | ~1 hour | 90+ days |

## See Also

- [patterns.md](patterns.md) - Protocol examples
- [configuration.md](configuration.md) - TLS/Proxy setup
