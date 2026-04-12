# neurOS Electron

Electron-first desktop shell for Paperclip workspaces. This app exists to connect directly to the already working Paperclip web control plane instead of reimplementing the API/runtime bootstrap in Swift.

## Scope

- local desktop wrapper for the Paperclip board web UI
- automatic detection of local servers on:
  - `http://127.0.0.1:3100`
  - `http://localhost:3100`
- workspace switching for dedicated company routes like:
  - `/BC/dashboard`
  - `/GOL/dashboard`
- persisted base URL and preferred workspace prefix
- embedded webview with reload, reconnect, and open-in-browser controls

## Why This App Exists

The previous native macOS implementation kept failing in the connection/bootstrap layer even when the Paperclip server and web UI were already healthy. This Electron build intentionally takes a narrower and more reliable approach:

- it trusts the existing Paperclip web app
- it probes the API directly from Electron
- it does not try to auto-onboard or auto-bootstrap a missing local instance

If the API is not available, the app shows a clear connection state instead of trying to run a non-interactive onboarding flow.

## Local Development

Install dependencies:

```bash
cd apps/neuros-electron
npm install
```

Run the desktop app in development:

```bash
npm run dev
```

Build the renderer and validate TypeScript:

```bash
npm run build
```

Create local macOS artifacts:

```bash
npm run dist
```

## Repository Shortcuts

From the repo root:

```bash
pnpm neuros:electron:install
pnpm neuros:electron:dev
pnpm neuros:electron:build
pnpm neuros:electron:dist
```

## Maintainer

- Instagram: `@monrars`
- Site: `goldneuron.io`
- GitHub: `@monrars1995`

## License

This app is distributed under the MIT license. See [LICENSE](./LICENSE).
