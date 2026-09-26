# CNI Configuration

See [README.md](README.md) for overview.

## Workflow (2-4 weeks)

1. **Submit request** (Week 1): Contact account team, provide type/location/use case
2. **Review config** (Week 1-2, v1 only): Approve IP/VLAN/spec doc
3. **Order connection** (Week 2-3):
   - **Direct**: Get LOA, order cross-connect from facility
   - **Partner**: Order virtual circuit in partner portal
   - **Cloud**: Order Direct Connect/Cloud Interconnect, send LOA+VLAN to CF
4. **Configure** (Week 3): Both sides configure per doc
5. **Test** (Week 3-4): Ping, verify BGP, check routes
6. **Health checks** (Week 4): Configure [Magic Transit](https://developers.cloudflare.com/magic-transit/how-to/configure-tunnel-endpoints/#add-tunnels) or [Magic WAN](https://developers.cloudflare.com/magic-wan/configuration/manually/how-to/configure-tunnel-endpoints/#add-tunnels) health checks
7. **Activate** (Week 4): Route traffic, verify flow
8. **Monitor**: Enable [maintenance notifications](https://developers.cloudflare.com/network-interconnect/monitoring-and-alerts/#enable-cloudflare-status-maintenance-notification)

## BGP Configuration

**v1 Requirements:**
- BGP ASN (provide during setup)
- /31 subnet for peering
- Optional: BGP password

**v2:** Simplified, less BGP config needed.

**BGP over CNI (Dec 2024):** Magic WAN/Transit can now peer BGP directly over CNI v2 (no GRE tunnel required).

**Example v1 BGP:**
```
Router ID: 192.0.2.1
Peer IP: 192.0.2.0
Remote ASN: 13335
Local ASN: 65000
Password: [optional]
VLAN: 100
```

## Cloud Interconnect Setup

### AWS Direct Connect (Beta)

**Requirements:** Magic WAN, AWS Dedicated Direct Connect 1/10 Gbps.

**Process:**
1. Contact CF account team
2. Choose location
3. Order in AWS portal
4. AWS provides LOA + VLAN ID
5. Send to CF account team
6. Wait ~4 weeks

**Post-setup:** Add [static routes](https://developers.cloudflare.com/magic-wan/configuration/manually/how-to/configure-routes/#configure-static-routes) to Magic WAN. Enable [bidirectional health checks](https://developers.cloudflare.com/magic-wan/configuration/manually/how-to/configure-tunnel-endpoints/#legacy-bidirectional-health-checks).

### GCP Cloud Interconnect (Beta)

**Setup via Dashboard:**
1. Interconnects → Create → Cloud Interconnect → Google
2. Provide name, MTU (match GCP VLAN attachment), speed (50M-50G granular options available for partner interconnects)
3. Enter VLAN attachment pairing key
4. Confirm order

**Routing to GCP:** Add [static routes](https://developers.cloudflare.com/magic-wan/configuration/manually/how-to/configure-routes/#configure-static-routes). BGP routes from GCP Cloud Router **ignored**.

**Routing to CF:** Configure [custom learned routes](https://cloud.google.com/network-connectivity/docs/router/how-to/configure-custom-learned-routes) in Cloud Router. Request prefixes from CF account team.

## Monitoring

**Dashboard Status:**

| Status | Meaning |
|--------|---------|
| **Healthy** | Link operational, traffic flowing, health checks passing |
| **Active** | Link up, sufficient light, Ethernet negotiated |
| **Unhealthy** | Link down, no/low light (<-20 dBm), can't negotiate |
| **Pending** | Cross-connect incomplete, device unresponsive, RX/TX swapped |
| **Down** | Physical link down, no connectivity |

**Alerts:**

**CNI Connection Maintenance** (Magic Networking only):
```
Dashboard → Notifications → Add
Product: Cloudflare Network Interconnect
Type: Connection Maintenance Alert
```
Warnings up to 2 weeks advance. 6hr delay for new additions.

**Cloudflare Status Maintenance** (entire PoP):
```
Dashboard → Notifications → Add
Product: Cloudflare Status
Filter PoPs: gru,fra,lhr
```

**Find PoP code:**
```
Dashboard → Magic Transit/WAN → Configuration → Interconnects
Select CNI → Note Data Center (e.g., "gru-b")
Use first 3 letters: "gru"
```

## Best Practices

**Critical config-specific practices:**
- /31 subnets required for BGP
- BGP passwords recommended
- BFD for fast failover (v1 only)
- Test ping connectivity before BGP
- Enable maintenance notifications immediately after activation
- Monitor status programmatically via API

For design patterns, HA architecture, and security best practices, see [patterns.md](./patterns.md).
