# paperclip

Self-hosted Paperclip AI — company orchestration platform with a single-replica StatefulSet, embedded Postgres, and PVC-backed state.

**Homepage:** <https://github.com/paperclipai/paperclip>

## TL;DR

```bash
helm install paperclip ./deploy/helm/paperclip \
  --namespace paperclip --create-namespace
```

Default install creates a single-replica StatefulSet with a 20Gi `local-path` PVC, a ClusterIP Service on port 3100, and auto-generates the `agentJwtSecret`. No Ingress is created unless you opt in.

## Quickstart

1. **Install the chart** into a dedicated namespace (`paperclip` by convention):
   ```bash
   helm install paperclip ./deploy/helm/paperclip \
     --namespace paperclip --create-namespace
   ```
2. **Wait for the pod to become Ready**:
   ```bash
   kubectl -n paperclip rollout status sts/paperclip --timeout=5m
   ```
3. **Run the first-run bootstrap** — see below.
4. **Expose the UI** via port-forward, Ingress, or cloudflared — see "Exposure".

## Bootstrap auth

Paperclip's auth is always on. After the first pod becomes Ready, create the initial admin (CEO) account by generating a one-time invite URL:

```bash
kubectl -n paperclip exec -it paperclip-0 -- \
  npx paperclipai auth bootstrap-ceo \
    --base-url https://paperclip.example.com
```

The command prints an invite link that embeds a short-lived token. Open it in a browser to complete sign-up and set an admin password. Replace `--base-url` with whatever host users will browse to — the URL printed must be reachable, or the invite link will be unusable.

Extra flags:

- `--force` — re-issue the invite even if an admin already exists (use when the previous invite expired before it was redeemed).
- `--expires-hours N` — override the invite TTL.

To log the CLI in separately (for `paperclipai` admin commands from your workstation):

```bash
paperclipai auth login --api-base https://paperclip.example.com
```

## Exposure

The chart does **not** create an Ingress by default. Pick one:

- **Ingress** (cluster-internal or LAN-only): set `ingress.enabled=true`, `ingress.className=nginx`, and configure `ingress.hosts[]`.
- **Cloudflare Tunnel** (external, via `cloudflared` running in-cluster): leave `ingress.enabled=false` and add a route in your tunnel config pointing at `http://paperclip.paperclip.svc.cluster.local:3100`. Paperclip's built-in auth gates the UI.
- **Port-forward** (ad-hoc):
  ```bash
  kubectl -n paperclip port-forward svc/paperclip 3100:3100
  ```

## Upgrading

The image is pinned via `image.tag` in `values.yaml`. Two common paths:

- **Follow upstream**: every upstream master push and stable tag publishes an image (`sha-<short>` and `vYYYY.MMM.P` respectively). Point `image.tag` at whichever channel you want to track.
- **Manual**:
  ```bash
  helm upgrade paperclip ./deploy/helm/paperclip \
    --namespace paperclip \
    --set image.tag=v2026.XXX.Y
  ```

Roll back by reverting the bump commit, or:

```bash
helm rollback paperclip <REVISION>
```

The PVC is untouched on rollback — data persists across image versions.

## Backup & restore

### Hourly pg_dump (built-in)

Paperclip writes hourly SQL dumps to `/paperclip/instances/<instanceId>/data/backups/` with 30-day retention. No configuration needed.

### On-demand dump

```bash
kubectl -n paperclip exec paperclip-0 -- npx paperclipai db:backup
```

### Full instance tar

```bash
kubectl -n paperclip exec paperclip-0 -- \
  tar czf - --exclude=data/backups -C /paperclip instances/default \
  > paperclip-instance.tgz
```

### Restore onto a fresh PVC

1. Install the chart with an empty PVC.
2. Scale the StatefulSet to 0:
   ```bash
   kubectl -n paperclip scale sts paperclip --replicas=0
   ```
3. Mount the PVC from a debug pod and extract the tar into `/paperclip/`:
   ```bash
   kubectl -n paperclip run seed --rm -i --tty --image=alpine \
     --overrides='{"spec":{"containers":[{"name":"seed","image":"alpine","stdin":true,"tty":true,"volumeMounts":[{"name":"data","mountPath":"/paperclip"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"data-paperclip-0"}}]}}'
   # Inside: apk add --no-cache tar; tar xzf /path/to/paperclip-instance.tgz -C /paperclip
   # Then: chown -R 1000:1000 /paperclip; chmod 0600 /paperclip/instances/default/secrets/master.key
   ```
4. Scale back to 1. Paperclip detects existing data and skips DB init.

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| Nuno Ferro | <mail@nunoferro.com> |  |

## Source Code

* <https://github.com/paperclipai/paperclip>

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| image | object | `{"pullPolicy":"IfNotPresent","repository":"ghcr.io/paperclipai/paperclip","tag":"latest"}` | Container image settings. |
| image.repository | string | `"ghcr.io/paperclipai/paperclip"` | Image repository. Upstream publishes to `ghcr.io/paperclipai/paperclip` on every master push and stable tag. |
| image.tag | string | `"latest"` | Image tag. Override to a specific stable release (e.g. `v2026.416.0`) or pin to a `sha-<commit>` tag. |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| imagePullSecrets | list | `[]` | Image pull secrets. Only needed if the GHCR package is private. Example: `[{name: ghcr-pull}]`. |
| nameOverride | string | `""` | Override the chart name used in resource names. |
| fullnameOverride | string | `""` | Override the full name used as the prefix for every resource. |
| persistence | object | `{"accessMode":"ReadWriteOnce","enabled":true,"mountPath":"/paperclip","size":"20Gi","storageClassName":""}` | Persistent volume settings for `/paperclip`. |
| persistence.enabled | bool | `true` | Whether to create a PVC for `/paperclip`. Required for any real use — disabling loses all state on pod restart. |
| persistence.storageClassName | string | `""` | StorageClass for the PVC. Empty string uses the cluster's default StorageClass; set explicitly (e.g. `local-path` on Talos) to pin one. |
| persistence.accessMode | string | `"ReadWriteOnce"` | Access mode for the PVC. ReadWriteOnce is correct for the single-replica StatefulSet. |
| persistence.size | string | `"20Gi"` | PVC size. Sized for live state + ~30 days of hourly pg_dumps. |
| persistence.mountPath | string | `"/paperclip"` | Mount path inside the container. Paperclip's `PAPERCLIP_HOME` defaults to `/paperclip`; keep these aligned. |
| service | object | `{"port":3100,"type":"ClusterIP"}` | Kubernetes Service exposing the HTTP UI/API. |
| service.type | string | `"ClusterIP"` | Service type. Keep `ClusterIP`; cloudflared or Ingress handle external exposure. |
| service.port | int | `3100` | Service port. Must match `env.port`. |
| ingress | object | `{"annotations":{},"className":"nginx","enabled":false,"hosts":[{"host":"paperclip.example.com","paths":[{"path":"/","pathType":"Prefix"}]}],"tls":[]}` | Optional Ingress. Leave disabled if fronting via cloudflared only. |
| ingress.enabled | bool | `false` | Enable an Ingress resource. |
| ingress.className | string | `"nginx"` | Ingress class name. `nginx` matches the cluster's ingress-nginx install. |
| ingress.annotations | object | `{}` | Annotations on the Ingress (e.g. cert-manager, rate limits). |
| ingress.hosts | list | single host at `paperclip.example.com` serving `/`. | Hosts and paths served by the Ingress. |
| ingress.tls | list | `[]` | TLS configuration. Leave empty to serve HTTP only. Example: `[{hosts: [paperclip.example.com], secretName: paperclip-tls}]`. |
| env | object | `{"extra":[],"extraAllowedHostnames":[],"host":"0.0.0.0","instanceId":"default","port":3100,"serveUi":true}` | Paperclip runtime environment. |
| env.host | string | `"0.0.0.0"` | Bind address. |
| env.port | int | `3100` | HTTP port inside the container (must match `service.port`). |
| env.serveUi | bool | `true` | Serve the bundled web UI alongside the API. |
| env.instanceId | string | `"default"` | Paperclip instance identifier. Directory under `/paperclip/instances/` is named after this. |
| env.extraAllowedHostnames | list | `[]` | Extra hostnames the server accepts on its `Host` header (e.g. public ingress hosts). Rendered as `PAPERCLIP_ALLOWED_HOSTNAMES`, with `127.0.0.1` **always prepended by the chart** so spawned agents get `http://127.0.0.1:{{ env.port }}` as `PAPERCLIP_API_URL` (the server picks `allowedHostnames[0] + env.port` to build that URL). Do not list public hosts here expecting them to be reachable from inside the pod — they're served on `:443`/HTTPS via an ingress, but the URL the server constructs always uses `http://` and `env.port`, so they'd be unreachable as `allowedHostnames[0]`. The leading `127.0.0.1` neutralises that. Example: `["paperclip.example.com"]`. |
| secret | object | `{"agentJwtSecret":"","existingSecret":"","masterKey":""}` | Secret containing `agentJwtSecret` and optional `masterKey` seed. |
| secret.agentJwtSecret | string | `""` | JWT secret for the Paperclip agent. Only used when `existingSecret` is empty — avoid under GitOps (non-deterministic render). |
| secret.masterKey | string | `""` | Base64-encoded master key to seed `/paperclip/instances/<instanceId>/secrets/master.key` on first boot. Ignored if the file already exists on the PVC. Only used when `existingSecret` is empty. Leave empty to let Paperclip generate its own on first run. |
| pod | object | `{"annotations":{},"containerSecurityContext":{"runAsGroup":1000,"runAsNonRoot":true,"runAsUser":1000},"labels":{},"securityContext":{"fsGroup":1000,"fsGroupChangePolicy":"OnRootMismatch"},"shareProcessNamespace":true}` | Pod spec knobs. |
| pod.shareProcessNamespace | bool | `true` | Share the process namespace so tini (pid 1) reaps orphaned child processes spawned by Claude agents. |
| pod.securityContext | object | `{fsGroup: 1000, fsGroupChangePolicy: OnRootMismatch}`. | Pod-level security context. |
| pod.containerSecurityContext | object | `{runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true}`. | Container-level security context. |
| pod.annotations | object | `{}` | Extra annotations on the pod template. |
| pod.labels | object | `{}` | Extra labels on the pod template. |
| resources | object | requests `500m/1Gi`, limits `2/4Gi`. | Container resource requests/limits. |
| probes | object | `{"liveness":{"failureThreshold":3,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"initialDelaySeconds":60,"periodSeconds":30},"readiness":{"failureThreshold":3,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"initialDelaySeconds":15,"periodSeconds":10},"startup":{"failureThreshold":30,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"periodSeconds":10}}` | Health probe configuration. `httpGet` to `/healthz` with an explicit `Host: 127.0.0.1:3100` header — Paperclip's hostname allowlist always accepts loopback (see server/src/middleware/private-hostname-guard.ts), while the pod-IP Host header kubelet would otherwise send is rejected. |
| probes.liveness | object | `{"failureThreshold":3,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"initialDelaySeconds":60,"periodSeconds":30}` | Liveness probe. Paperclip serves HTTP on the configured port once the embedded Postgres is up. |
| probes.readiness | object | `{"failureThreshold":3,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"initialDelaySeconds":15,"periodSeconds":10}` | Readiness probe. Shorter cadence pulls the pod out of rotation quickly on transient failures. |
| probes.startup | object | `{"failureThreshold":30,"httpGet":{"httpHeaders":[{"name":"Host","value":"127.0.0.1:3100"}],"path":"/healthz","port":"http"},"periodSeconds":10}` | Startup probe. Long timeout tolerates first-run DB init + 45 migrations. |
| nodeSelector | object | `{}` | Node selector. |
| tolerations | list | `[]` | Tolerations. |
| affinity | object | `{}` | Affinity rules. |
| priorityClassName | string | `""` | Priority class name. |
| pdb | object | `{"enabled":true,"maxUnavailable":1}` | PodDisruptionBudget. Uses `maxUnavailable` rather than `minAvailable` so node drains and cluster upgrades remain possible on the single-replica StatefulSet (a `minAvailable: 1` budget would block every voluntary eviction). |
| pdb.enabled | bool | `true` | Create a PodDisruptionBudget. |
| pdb.maxUnavailable | int | `1` | Maximum number of pods that may be unavailable during voluntary disruptions. `1` lets a single-replica StatefulSet be drained. |
| networkPolicy | object | `{"allowFromNamespaces":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"ingress-nginx"}}},{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"cloudflare"}}}],"enabled":true}` | Ingress NetworkPolicy restricting which namespaces may reach the pod. |
| networkPolicy.enabled | bool | `true` | Create a NetworkPolicy. Defaults to allowing from `ingress-nginx` and `cloudflare` namespaces only — **same-namespace pods (sidecars, scrapers, `kubectl debug` pods) are also blocked**, so extend `allowFromNamespaces` or disable the policy for any in-cluster tooling that needs to reach the service. |
| networkPolicy.allowFromNamespaces | list | `ingress-nginx` and `cloudflare` namespaces. | Namespaces whose pods may reach the Paperclip service port. Add an entry for the release namespace if you need same-namespace traffic (e.g. Prometheus scrape, debug pods). |
| serviceAccount | object | `{"annotations":{},"create":true,"name":""}` | Dedicated ServiceAccount for the pod. |
| serviceAccount.create | bool | `true` | Create a dedicated ServiceAccount. |
| serviceAccount.name | string | `""` | Name override. Defaults to the full release name when empty. |
| serviceAccount.annotations | object | `{}` | Annotations on the ServiceAccount. |
