# Run Paperclip with systemd

Paperclip can run under `systemd` on Linux.

The simplest production-ish setup is:

- install the `paperclipai` CLI
- create a dedicated `paperclip` user
- store Paperclip data in a persistent directory
- run `paperclipai run` from a `systemd` unit
- put a reverse proxy (Caddy/Nginx/Tailscale Funnel/etc.) in front if you want external access

## Requirements

- Linux with `systemd`
- Node.js 20+
- npm

## 1. Install the CLI

```sh
sudo npm install -g paperclipai
which paperclipai
```

Confirm the binary path before writing the service file. In many setups it will be `/usr/local/bin/paperclipai`.

## 2. Create a dedicated runtime user

```sh
sudo useradd --system --create-home --home-dir /var/lib/paperclip --shell /usr/sbin/nologin paperclip
```

Paperclip will store its default embedded PostgreSQL data, config, backups, secrets key, and local storage under `PAPERCLIP_HOME`.

If you point `PAPERCLIP_HOME` somewhere else, make sure that directory exists and is writable by the `paperclip` user.

## 3. Onboard once as the Paperclip user

Run onboarding once before enabling the service:

```sh
sudo -u paperclip -H env PAPERCLIP_HOME=/var/lib/paperclip paperclipai onboard --yes
```

If you want to review or change config afterwards:

```sh
sudo -u paperclip -H env PAPERCLIP_HOME=/var/lib/paperclip paperclipai configure
sudo -u paperclip -H env PAPERCLIP_HOME=/var/lib/paperclip paperclipai doctor
```

## 4. Create the service unit

Create `/etc/systemd/system/paperclip.service`:

```ini
[Unit]
Description=Paperclip server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=paperclip
Group=paperclip
WorkingDirectory=/var/lib/paperclip
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=PAPERCLIP_HOME=/var/lib/paperclip
Environment=PAPERCLIP_INSTANCE_ID=default
Environment=HOST=127.0.0.1
Environment=PORT=3100
ExecStart=/usr/bin/env paperclipai run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Notes

- `HOST=127.0.0.1` is the safest default when a reverse proxy sits in front.
- If you want Paperclip to listen on all interfaces directly, set `HOST=0.0.0.0`.
- `paperclipai run` handles startup checks and starts the server when configuration is valid.

## 5. Start and enable the service

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip
sudo systemctl status paperclip
```

View logs:

```sh
sudo journalctl -u paperclip -f
```

## 6. Optional environment overrides

If you prefer not to edit the unit for every setting, create an environment file.

Create the directory and env file first:

```sh
sudo install -d -m 0750 /etc/paperclip
sudo editor /etc/paperclip/paperclip.env
sudo chmod 0640 /etc/paperclip/paperclip.env
```

Example: `/etc/paperclip/paperclip.env`

```sh
PAPERCLIP_HOME=/var/lib/paperclip
PAPERCLIP_INSTANCE_ID=default
HOST=127.0.0.1
PORT=3100
# DATABASE_URL=postgres://paperclip:secret@127.0.0.1:5432/paperclip
# PAPERCLIP_PUBLIC_URL=https://paperclip.example.com
# PAPERCLIP_DEPLOYMENT_MODE=authenticated
# PAPERCLIP_DEPLOYMENT_EXPOSURE=private
```

Then update the unit by replacing the inline `Environment=` settings with `EnvironmentFile=`:

```ini
[Service]
Type=simple
User=paperclip
Group=paperclip
WorkingDirectory=/var/lib/paperclip
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/etc/paperclip/paperclip.env
ExecStart=/usr/bin/env paperclipai run
Restart=on-failure
RestartSec=5
```

After editing the unit, reload and restart the service:

```sh
sudo systemctl daemon-reload
sudo systemctl restart paperclip
```

## Embedded PostgreSQL vs external PostgreSQL

By default, `paperclipai run` uses embedded PostgreSQL when `DATABASE_URL` is not set.

That works fine for a single Linux host managed by `systemd`.

If you want a more traditional setup, point Paperclip at your own PostgreSQL instance:

```sh
DATABASE_URL=postgres://paperclip:secret@127.0.0.1:5432/paperclip
```

## Reverse proxy example

If you expose Paperclip beyond localhost, put it behind a reverse proxy and set a canonical public URL in authenticated deployments:

```sh
PAPERCLIP_PUBLIC_URL=https://paperclip.example.com
```

See also:

- `doc/DEVELOPING.md`
- `doc/DOCKER.md`
- `doc/DEPLOYMENT-MODES.md`
