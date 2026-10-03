# Proxmox Deployment

The most reliable Proxmox setup for Paperclip is:

- a standard Ubuntu VM on Proxmox
- Docker Compose inside the VM
- Paperclip persistent data mounted at `/srv/paperclip`

This avoids the extra Docker-in-LXC edge cases while keeping deployment simple.

This repo now includes:

- direct VM bootstrap assets
- cloud-init templates for unattended first boot
- reverse-proxy overlays for Caddy and Nginx
- an LXC-oriented bootstrap path for advanced setups

## Recommended VM Shape

- Ubuntu Server 24.04 LTS
- 4 vCPU
- 8 GB RAM
- 40 GB disk
- bridged network interface
- OpenSSH server enabled
- QEMU guest agent enabled if you use it elsewhere in Proxmox

## Quick Start

From the new VM:

```sh
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
sudo PAPERCLIP_PUBLIC_URL=http://<vm-ip>:3100 ./deploy/proxmox/bootstrap-ubuntu.sh
```

What the bootstrap script does:

- installs Docker Engine and the Compose plugin
- creates `deploy/proxmox/.env`
- creates `/srv/paperclip` with write permissions for the container user
- builds and starts Paperclip with `deploy/proxmox/docker-compose.yml`
- waits for `http://127.0.0.1:<port>/api/health`

After the script finishes, open `PAPERCLIP_PUBLIC_URL` in your browser.

## Cloud-Init VM Provisioning

Templates live in `deploy/proxmox/cloud-init/`.

- `user-data.yaml`
- `meta-data.yaml`

Replace these placeholders in `user-data.yaml` before uploading it to a Proxmox snippet store or attaching it as cloud-init user data:

- `__VM_USERNAME__`
- `__SSH_PUBLIC_KEY__`
- `__PAPERCLIP_REPO__`
- `__PAPERCLIP_GIT_REF__`
- `__PAPERCLIP_PUBLIC_URL__`
- `__PAPERCLIP_PROXY_MODE__`
- `__PAPERCLIP_SERVER_NAME__`
- `__OPENAI_API_KEY__`
- `__ANTHROPIC_API_KEY__`

Typical values:

- repo: `https://github.com/paperclipai/paperclip.git`
- git ref: `master`
- proxy mode: `none`, `caddy`, or `nginx`
- server name: your public DNS name when using HTTPS proxying

When the VM boots, cloud-init will:

- install `git` and `qemu-guest-agent`
- clone the repo into `/opt/paperclip`
- check out the selected git ref
- run `deploy/proxmox/bootstrap-ubuntu.sh`

## Reverse Proxy / HTTPS

The bootstrap script now supports three modes through `PAPERCLIP_PROXY_MODE`:

- `none`: direct HTTP on `PAPERCLIP_PORT`
- `caddy`: automatic HTTPS with Caddy and a public DNS hostname
- `nginx`: HTTPS with Nginx and pre-provisioned certificate files

In proxy mode, `PAPERCLIP_BIND_HOST` automatically defaults to `127.0.0.1` unless you override it.

### Caddy

For automatic HTTPS with Let's Encrypt, point your DNS name at the VM and run:

```sh
sudo \
  PAPERCLIP_PROXY_MODE=caddy \
  PAPERCLIP_SERVER_NAME=paperclip.example.com \
  PAPERCLIP_PUBLIC_URL=https://paperclip.example.com \
  ./deploy/proxmox/bootstrap-ubuntu.sh
```

This uses:

- `deploy/proxmox/docker-compose.caddy.yml`
- `deploy/proxmox/proxy/Caddyfile`

Persistent Caddy state defaults to:

- `/srv/caddy/data`
- `/srv/caddy/config`

### Nginx

For Nginx, put these files on the VM first:

- `${NGINX_CERT_DIR:-/srv/nginx/certs}/fullchain.pem`
- `${NGINX_CERT_DIR:-/srv/nginx/certs}/privkey.pem`

Then run:

```sh
sudo \
  PAPERCLIP_PROXY_MODE=nginx \
  PAPERCLIP_SERVER_NAME=paperclip.example.com \
  PAPERCLIP_PUBLIC_URL=https://paperclip.example.com \
  NGINX_CERT_DIR=/srv/nginx/certs \
  ./deploy/proxmox/bootstrap-ubuntu.sh
```

This uses:

- `deploy/proxmox/docker-compose.nginx.yml`
- `deploy/proxmox/proxy/nginx.conf.template`

## Optional Provider Keys

Paperclip itself can boot without model-provider credentials, but local adapters inside the container need them.

```sh
sudo \
  PAPERCLIP_PUBLIC_URL=http://<vm-ip>:3100 \
  OPENAI_API_KEY=... \
  ANTHROPIC_API_KEY=... \
  ./deploy/proxmox/bootstrap-ubuntu.sh
```

If auth or callbacks must accept extra private names, add them as a comma-separated allowlist:

```sh
sudo \
  PAPERCLIP_PUBLIC_URL=https://paperclip.example.com \
  PAPERCLIP_ALLOWED_HOSTNAMES=paperclip.example.com,paperclip.lan \
  ./deploy/proxmox/bootstrap-ubuntu.sh
```

## Files

- `deploy/proxmox/docker-compose.yml`: Proxmox-oriented Compose file
- `deploy/proxmox/docker-compose.caddy.yml`: Caddy HTTPS overlay
- `deploy/proxmox/docker-compose.nginx.yml`: Nginx HTTPS overlay
- `deploy/proxmox/.env.example`: environment template
- `deploy/proxmox/bootstrap-ubuntu.sh`: Ubuntu/Debian VM bootstrap script
- `deploy/proxmox/bootstrap-lxc.sh`: Proxmox LXC bootstrap entrypoint
- `deploy/proxmox/cloud-init/user-data.yaml`: cloud-init template
- `deploy/proxmox/cloud-init/meta-data.yaml`: cloud-init metadata template
- `deploy/proxmox/lxc/pve-container.conf.example`: LXC config example

## Operations

Check container status:

```sh
docker compose -f deploy/proxmox/docker-compose.yml --env-file deploy/proxmox/.env ps
```

Watch logs:

```sh
docker compose -f deploy/proxmox/docker-compose.yml --env-file deploy/proxmox/.env logs -f
```

Rebuild after updating the repo:

```sh
git pull
sudo ./deploy/proxmox/bootstrap-ubuntu.sh
```

Stop the stack:

```sh
docker compose -f deploy/proxmox/docker-compose.yml --env-file deploy/proxmox/.env down
```

If you use Caddy or Nginx mode, include the extra compose file on operational commands too:

```sh
docker compose \
  -f deploy/proxmox/docker-compose.yml \
  -f deploy/proxmox/docker-compose.caddy.yml \
  --env-file deploy/proxmox/.env ps
```

## Proxmox LXC

LXC is an advanced option. Prefer the VM path unless you specifically want container density.

Recommended Proxmox CT settings:

- Debian 12 or Ubuntu 24.04 template
- privileged container
- `features: nesting=1,keyctl=1`
- 4 vCPU
- 8 GB RAM
- 40 GB disk

An example config is included at `deploy/proxmox/lxc/pve-container.conf.example`.

Inside the container:

```sh
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
sudo PAPERCLIP_PUBLIC_URL=http://<ct-ip>:3100 ./deploy/proxmox/bootstrap-lxc.sh
```

Notes for LXC:

- Docker inside LXC may require host-side allowance beyond `nesting=1,keyctl=1` on some Proxmox setups.
- If Docker storage or iptables setup fails, try the optional AppArmor lines shown in `pve-container.conf.example`.
- Keep persistent storage on a real Proxmox-backed volume, not a tiny rootfs.

## Notes

- Paperclip uses embedded PostgreSQL by default, so a separate database is not required for this VM-based setup.
- Persistent state lives under `/srv/paperclip` unless you override `PAPERCLIP_DATA_DIR`.
- `BETTER_AUTH_SECRET` is generated automatically when missing and then stored in `deploy/proxmox/.env`.
- In `caddy` or `nginx` mode, set `PAPERCLIP_PUBLIC_URL` to the final external HTTPS URL.
