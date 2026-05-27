# Relay SSL Multicert Guard

This guard enforces the corrected invariant from [PCL-525](/BLO/issues/PCL-525#document-plan) and the staging image-side safety net shipped in [PCL-492](/BLO/issues/PCL-492): each relay pod's on-disk `/opt/trafficserver/etc/trafficserver/ssl_multicert.config` must contain only the gateway certificate line.

It intentionally does not inspect Traffic Ops profile assignments. [PCL-525](/BLO/issues/PCL-525#document-plan) found production relay `38456` can legitimately have SSL Delivery Services with active keys, so Traffic Ops assignment presence is not the invariant.

## Automation

- Workflow: `.github/workflows/relay-ssl-multicert-guard.yml`
- Script: `scripts/check-relay-ssl-multicert.mjs`
- Default cadence: hourly GitHub Actions schedule plus manual `workflow_dispatch`
- Default namespaces: `staging-traffic-control,production-traffic-control`
- Default pod selector: `app=relay-ats`

The workflow requires the repository secret `BLOCKCAST_KUBE_CONFIG_B64`, containing a base64-encoded kubeconfig with read/list pod permissions and pod exec permissions for the selected relay namespaces.

## Configuration

Use repository variables to match the live onprem-k8s labels and exact gateway template:

- `RELAY_SSL_MULTICERT_NAMESPACES`: comma-separated namespace list
- `RELAY_SSL_MULTICERT_SELECTOR`: Kubernetes label selector for relay pods
- `RELAY_SSL_MULTICERT_CONTAINER`: optional container name for multi-container pods
- `RELAY_SSL_MULTICERT_EXPECTED_LINE`: optional exact gateway-only line to require

If `RELAY_SSL_MULTICERT_EXPECTED_LINE` is unset, the script still fails on missing content or extra non-comment lines and requires the single line to look like the gateway certificate line.

## Paging Ownership

The hourly workflow is owned by the Alert Rules + Dispatcher lane. A failed scheduled run should page the Platform/SRE owner for relay operations because it means a live relay pod's actual ATS file shape drifted, not merely that Traffic Ops assigned an SSL Delivery Service.

## Manual Dry Run

```sh
RELAY_SSL_MULTICERT_NAMESPACES=staging-traffic-control,production-traffic-control \
RELAY_SSL_MULTICERT_SELECTOR='app=relay-ats' \
node scripts/check-relay-ssl-multicert.mjs
```

Expected success output includes one `PASS <namespace>/<pod>` line per relay pod and a final count. Any extra non-gateway line, missing gateway line, or pod-selection miss exits non-zero.
