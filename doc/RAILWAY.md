# Railway Deployment

Deploy Paperclip to Railway as a single Docker service with a persistent volume mounted at `/paperclip`.

This matches Paperclip's production assumptions:

- long-running Node.js server
- embedded PostgreSQL stored on disk
- local encrypted secrets key
- uploaded assets and workspace state on disk

## 1. Why Railway

Paperclip is not a good fit for stateless serverless platforms. Railway can run the existing Docker image, keep a writable persistent volume, and expose one public HTTPS URL for auth flows.

## 2. Recommended service shape

- one Railway project
- one app service built from this repo's `Dockerfile`
- one Railway volume attached to `/paperclip`
- one public Railway domain
- `authenticated/public` deployment mode

Do not scale this service above one replica when using embedded PostgreSQL and a single shared volume.

## 3. Required environment variables

Set these on the Railway service before the first production deploy:

```env
HOST=0.0.0.0
PAPERCLIP_HOME=/paperclip
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=public
PAPERCLIP_PUBLIC_URL=https://<your-service>.up.railway.app
BETTER_AUTH_SECRET=<long-random-secret>
```

Notes:

- `PAPERCLIP_PUBLIC_URL` must match the final external HTTPS URL.
- `BETTER_AUTH_SECRET` should be a long random secret.
- `PAPERCLIP_ALLOWED_HOSTNAMES` is optional because the public URL hostname is auto-derived.
- `DATABASE_URL` is optional when you want to keep using embedded PostgreSQL on the attached volume.

## 4. Deploy with Railway CLI

Login:

```sh
npx @railway/cli login
```

Create a project:

```sh
npx @railway/cli init --name paperclip
```

Upload the service from this repository:

```sh
npx @railway/cli up --ci
```

Attach a persistent volume to `/paperclip`:

```sh
npx @railway/cli volume add
npx @railway/cli volume attach
```

Generate a Railway domain:

```sh
npx @railway/cli domain
```

After the domain is created, set `PAPERCLIP_PUBLIC_URL` to that exact HTTPS URL and redeploy:

```sh
npx @railway/cli variable set PAPERCLIP_PUBLIC_URL=https://<your-service>.up.railway.app
npx @railway/cli up --ci
```

## 5. Health check

The repository includes `railway.toml` with:

- Railway-specific Dockerfile builds enabled
- single replica
- required mount path `/paperclip`
- health check path `/api/health`

Paperclip is healthy when:

```sh
curl https://<your-service>.up.railway.app/api/health
```

Expected response shape:

```json
{
  "status": "ok"
}
```

In authenticated mode the payload also includes deployment metadata and bootstrap status.

## 6. Operational notes

- WebSocket support is handled by the long-running app server, not a separate function runtime.
- Keep the attached volume; removing it will also remove embedded PostgreSQL data, secrets, assets, and local workspaces.
- If you later want managed Postgres instead of embedded Postgres, set `DATABASE_URL` and migrate before switching production traffic.
