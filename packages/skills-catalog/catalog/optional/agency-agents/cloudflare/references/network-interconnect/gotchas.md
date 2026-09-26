# CNI Gotchas & Troubleshooting

## Common Errors

### "Status: Pending"

**Cause:** Cross-connect not installed, RX/TX fibers reversed, wrong fiber type, or low light levels
**Solution:**
1. Verify cross-connect installed
2. Check fiber at patch panel
3. Swap RX/TX fibers
4. Check light with optical power meter (target > -20 dBm)
5. Contact account team

### "Status: Unhealthy"

**Cause:** Physical issue, low light (<-20 dBm), optic mismatch, or dirty connectors
**Solution:**
1. Check physical connections
2. Clean fiber connectors
3. Verify optic types (10GBASE-LR/100GBASE-LR4)
4. Test with known-good optics
5. Check patch panel
6. Contact account team

### "BGP Session Down"

**Cause:** Wrong IP addressing, wrong ASN, password mismatch, or firewall blocking TCP/179
**Solution:**
1. Verify IPs match CNI object
2. Confirm ASN correct
3. Check BGP password
4. Verify no firewall on TCP/179
5. Check BGP logs
6. Review BGP timers

### "Low Throughput"

**Cause:** MTU mismatch, fragmentation, single GRE tunnel (v1), or routing inefficiency
**Solution:**
1. Check MTU (1500↓/1476↑ for v1, 1500 both for v2)
2. Test various packet sizes
3. Add more GRE tunnels (v1)
4. Consider upgrading to v2
5. Review routing tables
6. Use LACP for bundling (v1)

## API Errors

### 400 Bad Request: "slot_id already occupied"

**Cause:** Another interconnect already uses this slot  
**Solution:** Use `occupied=false` filter when listing slots:
```typescript
await client.networkInterconnects.slots.list({
  account_id: id,
  occupied: false,
  facility: 'EWR1',
});
```

### 400 Bad Request: "invalid facility code"

**Cause:** Typo or unsupported facility  
**Solution:** Check [locations PDF](https://developers.cloudflare.com/network-interconnect/static/cni-locations-05-may-2026.pdf) for valid codes

### 403 Forbidden: "Enterprise plan required"

**Cause:** Account not enterprise-level  
**Solution:** Contact account team to upgrade

### 422 Unprocessable: "validate_only request failed"

**Cause:** Dry-run validation found issues (wrong slot, invalid config)  
**Solution:** Review error message details, fix config before real creation

### Rate Limiting

**Limit:** 1200 requests/5min per token  
**Solution:** Implement exponential backoff, cache slot listings

## Cloud-Specific Issues

### AWS Direct Connect: "VLAN not matching"

**Cause:** VLAN ID from AWS LOA doesn't match CNI config  
**Solution:**
1. Get VLAN from AWS Console after ordering
2. Send exact VLAN to CF account team
3. Verify match in CNI object config

### AWS: "Connection stuck in Pending"

**Cause:** LOA not provided to CF or AWS connection not accepted  
**Solution:**
1. Verify AWS connection status is "Available"
2. Confirm LOA sent to CF account team
3. Wait for CF team acceptance (can take days)

### GCP: "BGP routes not propagating"

**Cause:** BGP routes from GCP Cloud Router **ignored by design**  
**Solution:** Use [static routes](https://developers.cloudflare.com/magic-wan/configuration/manually/how-to/configure-routes/#configure-static-routes) in Magic WAN instead

### GCP: "Cannot query VLAN attachment status via API"

**Cause:** GCP Cloud Interconnect Dashboard-only (no API yet)  
**Solution:** Check status in CF Dashboard or GCP Console

## Partner Interconnect Issues

### Equinix: "Virtual circuit not appearing"

**Cause:** CF hasn't accepted Equinix connection request  
**Solution:**
1. Verify VC created in Equinix Fabric Portal
2. Contact CF account team to accept
3. Allow 2-3 business days

### Console Connect/Megaport: "API creation fails"

**Cause:** Partner interconnects require partner portal + CF approval  
**Solution:** Cannot fully automate. Order in partner portal, notify CF account team.

## Anti-Patterns

| Anti-Pattern | Why Bad | Solution |
|--------------|---------|----------|
| Single interconnect for production | No SLA, single point of failure | Use ≥2 with device diversity |
| No backup Internet | CNI fails = total outage | Always maintain alternate path |
| Polling status every second | Rate limits, wastes API calls | Poll every 30-60s max |
| Using v1 for Magic WAN v2 workloads | GRE overhead, complexity | Use v2 for simplified routing |
| Assuming BGP session = traffic flowing | BGP up ≠ routes installed | Verify routing tables + test traffic |
| Not enabling maintenance alerts | Surprise downtime during maintenance | Enable notifications immediately |
| Hardcoding VLAN in automation | VLAN assigned by CF (v1) | Get VLAN from CNI object response |
| Using Direct without colocation | Can't access cross-connect | Use Partner or Cloud interconnect |

## What's Not Queryable via API

**Cannot retrieve:**
- BGP session state (use Dashboard or BGP logs)
- Light levels (contact account team)
- Historical metrics (uptime, traffic)
- Bandwidth utilization per interconnect
- Maintenance window schedules (notifications only)
- Fiber path details
- Cross-connect installation status

**Workarounds:**
- External monitoring for BGP state
- Log aggregation for historical data
- Notifications for maintenance windows

## Limits

| Resource/Limit | Value | Notes |
|----------------|-------|-------|
| Max optical distance | 10km | Physical limit |
| MTU (v1) | 1500↓ / 1476↑ | Asymmetric |
| MTU (v2) | 1500 both | Symmetric |
| GRE tunnel throughput | 1 Gbps | Per tunnel (v1) |
| Recovery time | Days | No formal SLA |
| Light level minimum | -20 dBm | Target threshold |
| API rate limit | 1200 req/5min | Per token |
| Health check delay | 6 hours | New maintenance alert subscriptions |
