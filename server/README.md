# Paperclip Server

A Node.js/Express server for the Paperclip application.

## Quickstart

```bash
npx paperclipai onboard --yes
```

The server starts at `http://localhost:3100`. It runs in your terminal until you stop it (Ctrl+C).

**To start again later:**

```bash
npx paperclipai run
```

## Local Development

If you're contributing to Paperclip itself:

```bash
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm dev
```

> **Requirements:** Node.js 20+, pnpm 9.15+

## Sentry Error Monitoring

This server uses Sentry for error tracking and performance monitoring.

### Setup

1. Create a project at https://sentry.io and copy your DSN.
2. Add `SENTRY_DSN=<your-dsn>` to your `.env` file.
3. Optionally set `NODE_ENV=production` for production environments.

### Verify Integration

With the server running, hit the test endpoint:

    curl http://localhost:3000/api/sentry-test

This throws a deliberate error that Sentry should capture. Check your Sentry dashboard for the event.

### What is Captured

- All unhandled Express errors (via error-handler middleware)
- Unhandled promise rejections
- Uncaught exceptions
- Request traces (100% sample rate in development)
