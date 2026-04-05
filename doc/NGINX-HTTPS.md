# HTTPS with nginx (reverse proxy)

Paperclip listens on HTTP (for example `127.0.0.1:3100`). For a public domain, terminate **TLS in nginx** and proxy to that upstream. Use **Let’s Encrypt** (via Certbot) for certificates — you do not need to generate keys manually for a normal setup.

## Prerequisites

- DNS **A** (or **AAAA**) record for your hostname pointing to the server’s public IP.
- Firewall allows **80** (ACME HTTP-01) and **443** (HTTPS). Certbot can use other challenges; HTTP-01 is the simplest with nginx on the same host.
- Paperclip bound only on loopback so it is not reachable directly from the internet:
  ```env
  HOST=127.0.0.1
  PAPERCLIP_PORT=3100
  ```

## Environment variables (Paperclip)

Set the URL users open in the browser (HTTPS, no port if you use 443):

```env
PAPERCLIP_PUBLIC_URL=https://your-domain.example
```

If nginx is the only hop in front of Node, enable Express **trust proxy** so `X-Forwarded-`* is honored (see `PAPERCLIP_TRUST_PROXY` in `server/src/app.ts`):

```env
PAPERCLIP_TRUST_PROXY=1
```

Keep `PAPERCLIP_DEPLOYMENT_MODE`, `BETTER_AUTH_SECRET`, database settings, etc. as you already use. See [DOCKER.md](./DOCKER.md) for how `PAPERCLIP_PUBLIC_URL` drives auth defaults.

## nginx site

1. Copy the example and adjust `server_name` and upstream port:
  - Example file: `[examples/nginx-paperclip.conf](./examples/nginx-paperclip.conf)`
2. Enable the site (Debian/Ubuntu-style paths):
  ```sh
   sudo ln -sf /etc/nginx/sites-available/paperclip /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
  ```
3. Obtain certificates (nginx plugin adjusts the server block):
  ```sh
   sudo certbot --nginx -d your-domain.example
  ```
   Renewals are usually installed as a **cron**/**systemd** timer by the package.

## WebSockets

The UI uses WebSockets under paths like `/api/companies/*/events/ws`. The example config sets `Upgrade` / `Connection` headers so live events work through nginx.

## After switching to HTTPS

- Open `https://your-domain.example` (not `http://IP:3100`).
- If sessions misbehave, confirm `PAPERCLIP_PUBLIC_URL` matches the browser origin and `PAPERCLIP_TRUST_PROXY=1` is set.

## Related

- [DEPLOYMENT-MODES.md](./DEPLOYMENT-MODES.md) — authenticated vs local modes.

