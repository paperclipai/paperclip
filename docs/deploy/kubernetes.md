---
title: Kubernetes (Helm)
summary: Deploy Paperclip on Kubernetes with the in-tree Helm chart
---

Run Paperclip on Kubernetes using the chart under `deploy/helm/paperclip`. The chart provisions a single-replica StatefulSet with embedded Postgres on a PersistentVolume, plus Service, Ingress, PodDisruptionBudget, NetworkPolicy, and a templated Secret.

## Quickstart

The chart defaults to `ghcr.io/paperclipai/paperclip:latest`. Pin to a specific release in production — stable tags (`vYYYY.MMM.P`) and per-commit SHA tags (`sha-<short>`) are both published by upstream CI.

```sh
helm install paperclip deploy/helm/paperclip \
  --namespace paperclip --create-namespace \
  --set image.tag=v2026.416.0 \
  --set persistence.storageClassName=<your-storage-class>
```

Port-forward to open the UI:

```sh
kubectl -n paperclip port-forward svc/paperclip 3100:3100
```

Open [http://127.0.0.1:3100](http://127.0.0.1:3100).

## Persistence

Paperclip keeps all state on disk at `/paperclip`: embedded PostgreSQL, uploaded assets, the local secrets master key, and agent workspaces. The chart mounts a PVC there by default (`persistence.enabled: true`).

- `persistence.size` — sized for live state plus hourly `pg_dump` backups.
- `persistence.storageClassName` — set to your cluster's StorageClass, or leave empty for the cluster default.
- `persistence.accessMode` — `ReadWriteOnce` is correct; the StatefulSet is single-replica by design.

Disabling persistence loses all data on pod restart. Don't.

## Secrets

By default the chart renders a Secret with an auto-generated `agentJwtSecret`. Provide one explicitly to keep the value stable across `helm upgrade`:

```sh
helm install paperclip deploy/helm/paperclip \
  --set secret.agentJwtSecret=$(openssl rand -hex 32)
```

`masterKey` is a base64-encoded seed written to `/paperclip/instances/<instanceId>/secrets/master.key` on first boot. Ignored on subsequent boots once the file exists on the PVC. Leave empty to let Paperclip generate its own.

### Under GitOps

The in-chart Secret is incompatible with any reconciler that re-renders templates (ArgoCD, Flux): `randAlphaNum` is non-deterministic, so each reconcile produces a new value, the app stays `OutOfSync`, and `selfHeal` thrashes pods. Create the Secret out-of-band and point the chart at it:

```sh
kubectl -n paperclip create secret generic paperclip-credentials \
  --from-literal=agentJwtSecret=$(openssl rand -hex 32)

helm install paperclip deploy/helm/paperclip \
  --set secret.existingSecret=paperclip-credentials
```

See [Secrets](secrets) for how Paperclip uses the master key.

## Exposure

The Service is `ClusterIP` by default. Two typical front doors:

- **Ingress** — set `ingress.enabled=true`, configure `ingress.hosts` and `ingress.tls`. Matches `ingress-nginx` out of the box.
- **Cloudflare Tunnel** — leave the Ingress disabled and run `cloudflared` as a separate workload pointing at `http://paperclip.paperclip.svc:3100`.

The bundled `NetworkPolicy` restricts ingress to the `ingress-nginx` and `cloudflare` namespaces. Override `networkPolicy.allowFromNamespaces` for other setups, or set `networkPolicy.enabled=false` to disable.

## Deployment mode

The Helm chart is runtime packaging — it does not choose a deployment mode. Set it via env on first boot:

```yaml
env:
  extra:
    - name: PAPERCLIP_DEPLOYMENT_MODE
      value: authenticated
    - name: PAPERCLIP_BIND
      value: lan
```

See [Deployment Modes](deployment-modes) for the available modes.

## Probes and the hostname allowlist

Probes use `httpGet` to `/healthz` with an explicit `Host: 127.0.0.1:3100` header. Paperclip's private-hostname guard accepts loopback unconditionally; the pod-IP `Host` header kubelet would otherwise send is rejected in `authenticated + private` mode. Leave the header alone unless you know what you are doing.

## Updating

Upstream CI publishes an image for every master push (`sha-<short>`) and every stable tag (`vYYYY.MMM.P`). To upgrade:

```sh
helm upgrade paperclip deploy/helm/paperclip \
  --namespace paperclip \
  --set image.tag=v2026.<new>.0
```

Rolling the StatefulSet stops Paperclip briefly; the new pod reattaches the same PVC and the embedded Postgres comes back up.

## Full values reference

All knobs are documented in [`deploy/helm/paperclip/README.md`](https://github.com/paperclipai/paperclip/blob/master/deploy/helm/paperclip/README.md), generated from `values.yaml` by `helm-docs`.
