---
title: Vercel Hosting
summary: Deploy Paperclip to Vercel
---

# Vercel Hosting

Paperclip can be deployed to Vercel as a serverless application.

## Prerequisites

1. A [Vercel account](https://vercel.com)
2. A PostgreSQL database (recommended: [Supabase](https://supabase.com), [Neon](https://neon.tech), or [Railway](https://railway.app))
3. A storage solution (optional: S3-compatible storage for file uploads)

## Deployment Steps

### 1. Fork and Clone

Fork the [Paperclip repository](https://github.com/paperclipai/paperclip) to your GitHub account.

### 2. Create Vercel Project

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your forked repository
3. Vercel will auto-detect the Next.js/Node.js configuration

### 3. Configure Environment Variables

Set these environment variables in Vercel:

```bash
# Required
DATABASE_URL=postgres://...    # Your PostgreSQL connection string
BETTER_AUTH_SECRET=...         # Random 32+ char secret
PAPERCLIP_AGENT_JWT_SECRET=... # Random 32+ char secret

# Deployment mode
PAPERCLIP_DEPLOYMENT_MODE=authenticated

# Auth URLs (replace with your Vercel URL)
PAPERCLIP_AUTH_BASE_URL_MODE=explicit
PAPERCLIP_AUTH_PUBLIC_BASE_URL=https://your-app.vercel.app

# Optional: Disable sign-ups for invite-only instances
PAPERCLIP_AUTH_DISABLE_SIGN_UP=true
```

### 4. Database Migrations

Before the first deployment, run migrations against your database:

```bash
# Local terminal with DATABASE_URL set
npx drizzle-kit push
```

### 5. Deploy

Click "Deploy" in Vercel. The first deploy may take a few minutes.

## Post-Deployment

### First User

The first user to sign up will become the admin. To restrict sign-ups:

```bash
PAPERCLIP_AUTH_DISABLE_SIGN_UP=true
```

### Storage

By default, Paperclip uses local disk storage which won't work on Vercel's ephemeral filesystem. Configure S3-compatible storage:

```bash
PAPERCLIP_STORAGE_PROVIDER=s3
PAPERCLIP_STORAGE_S3_BUCKET=your-bucket
PAPERCLIP_STORAGE_S3_REGION=us-east-1
PAPERCLIP_STORAGE_S3_ENDPOINT=https://s3.amazonaws.com
# For cloudflare R2, backblaze, etc:
# PAPERCLIP_STORAGE_S3_ENDPOINT=https://your-endpoint.com
```

### Custom Domain

Add a custom domain in Vercel project settings. Update:

```bash
PAPERCLIP_AUTH_PUBLIC_BASE_URL=https://your-domain.com
```

## Limitations

- **Serverless**: Heartbeat runs execute in serverless functions with time limits
- **No embedded PostgreSQL**: Must use external database (Supabase, Neon, etc.)
- **Ephemeral filesystem**: Must use S3-compatible storage for attachments

## Troubleshooting

### Build Errors

If you see TypeScript errors, ensure all dependencies are installed:

```bash
pnpm install
```

### Database Connection

If database connections fail:

1. Verify `DATABASE_URL` is correct
2. Ensure your database accepts connections from Vercel's IPs
3. For pooled connections (like Supabase), add `?pgbouncer=true` to the URL

### Auth Issues

If login doesn't work:

1. Verify `PAPERCLIP_AUTH_PUBLIC_BASE_URL` matches your actual URL
2. Check `BETTER_AUTH_SECRET` is set
3. Clear browser cookies and try again
