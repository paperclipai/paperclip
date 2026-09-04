# docker/certs

Drop a PEM CA bundle here for a self-hosted GitLab instance on a private or
internal CA — this directory is mounted read-only into the server container
at `/certs` (deliberately not under `/paperclip`: the entrypoint recursively
chowns that whole tree before dropping privileges, and that fails outright on
a read-only mount).

This applies to both `docker/docker-compose.yml` and
`docker/docker-compose.quickstart.yml`. For the Podman Quadlet deployment, the
equivalent directory is `~/.config/containers/systemd/paperclip-certs` (see
`doc/DOCKER.md`).

Then point `PAPERCLIP_GITLAB_CA_CERT_PATH` at the in-container path, e.g. for
a file named `lab-ca.pem`:

```
PAPERCLIP_GITLAB_CA_CERT_PATH=/certs/lab-ca.pem
```

Only applies to a host configured in `PAPERCLIP_GITLAB_HOSTS` — never to
gitlab.com itself.

Certificate files placed here are git-ignored (see `.gitignore` in this
directory); only this README is tracked.
