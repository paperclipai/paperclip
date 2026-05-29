# Paperclip Docker Release: v2026.403.1-stable

**Image:** `ghcr.io/starlein/paperclip:v2026.403.1-stable`

This README was created from the current working branch state for the Docker patch stream that includes the **companies startup template / starter-template** work.

## Release base and build metadata

- Branch: `docs/v2026.403.1-stable-docker-readme`
- Built-on commit: `fc629891` (`docs: add docker v2026.403.1-stable release notes`)
- OCI tag label used in build:
  - `org.opencontainers.image.description=v2026.403.1-stable - including companies-create-plugin - stable version`

## Included patches / release ingredients

From recent commits on this branch:

- `fc629891` — docs: add docker v2026.403.1-stable release notes
- `2a97d155` — Docker helpers
- `9f3ac37b` — paperclip-startup-template
- `d9fb1fe7` — docker-compose
- `b7aa3fb5` — docker-compose
- `b4acba70` — paperclip-startup-template
- `6da27f81` — dockerfile & `gpt 5.5 update to codex`

### What that means for v2026.403.1-stable

- Runtime image has Docker helper tooling and shell helpers wired for container workflows.
- Template/workspace bootstrap assets for a company starter kit are included.
- `paperclip-startup-template` is present and intended for import into a new instance.
- Compose and startup defaults were refined in the patch window leading to this release.

## Commands used (from shell history check)

The latest `history | grep paperclip`/`~/.bash_history` sweep includes these important commands:

```bash
cp _PATCH-feat-PAP-31-paperclip-startup-template.diff ..
patch -p0 < ../_PATCH-feat-PAP-31-paperclip-startup-template.diff

git add _PATCH-feat-PAP-31-paperclip-startup-template.diff docker-compose.yml
git commit -m "paperclip-startup-template"

docker exec -u node -it paperclip /bin/bash

docker build -t paperclip:v2026.403.1-stable \
  --label "org.opencontainers.image.description=v2026.403.1-stable - including companies-create-plugin - stable version"

docker push ghcr.io/starlein/paperclip:v2026.403.1-stable
```

## Build and publish

```bash
# Build

docker build -t paperclip:v2026.403.1-stable \
  --label "org.opencontainers.image.description=v2026.403.1-stable - including companies-create-plugin - stable version" .

# Publish

docker push ghcr.io/starlein/paperclip:v2026.403.1-stable
```

## Quick run (single container)

```bash
mkdir -p ./data/docker-paperclip

docker run -d --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  -e PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  -e PAPERCLIP_INSTANCE_ID=default \
  -e PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  ghcr.io/starlein/paperclip:v2026.403.1-stable
```

Open: `http://localhost:3100`

## Compose example

```yaml
services:
  paperclip:
    image: ghcr.io/starlein/paperclip:v2026.403.1-stable
    environment:
      HOST: 0.0.0.0
      PORT: 3100
      NODE_ENV: production
      HOME: /paperclip
      PAPERCLIP_HOME: /paperclip
      PAPERCLIP_INSTANCE_ID: default
      PAPERCLIP_CONFIG: /paperclip/instances/default/config.json
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: private
      PAPERCLIP_AUTH_DISABLE_SIGN_UP: "true"
      PAPERCLIP_TELEMETRY_DISABLED: "true"
      PATH: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/bin
    ports:
      - "127.0.0.1:3100:3100"
    volumes:
      - ${PAPERCLIP_DATA_DIR:-./data/docker-paperclip}:/paperclip
```

## Companies starter template (included)

Import example:

```bash
paperclipai company import companies/paperclip-startup-template \
  --target new \
  --new-company-name "MyCompany" \
  --agents all \
  --yes
```

Dry-run first:

```bash
paperclipai company import companies/paperclip-startup-template --dry-run
```

Notes:

- Keep `PAPERCLIP_AUTH_SECRET` stable for persistent authenticated sessions.
- Persist data via the mounted `/paperclip` volume.
- For full changelog across app code, see `doc/*` and release notes in the repo.
