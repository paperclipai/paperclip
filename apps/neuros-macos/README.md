# neurOS macOS

SwiftUI-native macOS foundation for `neurOS`, the Paperclip evolution in this repository.

## Current Scope

- native SwiftUI application shell for macOS
- real connection flow against the Paperclip REST API
- operational sections for:
  - central operacional
  - inbox
  - atividade
  - metas
  - fila e issues
  - agentes
  - aprovações
  - runtime e sinais
  - projetos
  - plugins
  - empresa e equipe
- interactive operational consoles for:
  - approval detail, comments, approve/reject/request-revision/resubmit flows
  - issue detail with dependency context, project/goal linkage, and operational timeline facts
  - agent detail with chain of command, permissions source, heartbeat, and budget visibility
  - plugin health, logs, enable/disable, and upgrade actions
  - project workspace runtime start/stop/restart controls
  - native inbox triage over approvals, issues, and runtime signals
  - activity timeline backed by the Paperclip activity API
  - native goal hierarchy with tree selection, owner/status detail, and linked projects
- persisted server configuration with local/remote/hybrid runtime preference
- native desktop service layer prepared for:
  - notifications
  - menu bar
  - login item
  - local network discovery
  - manual primary-node promotion

## Local Development

```bash
cd apps/neuros-macos
swift build
swift run NeurOSDesktopApp
```

Build a local `.app` bundle from the repo root:

```bash
pnpm neuros:macos:bundle
```

Install the app locally:

```bash
pnpm neuros:macos:install
```

By default the installer targets `/Applications` when writable and falls back to `~/Applications` otherwise.

Configure the backend instance from the native Settings screen. The app normalizes the configured base URL to `/api` automatically.

## Architecture

- `NeurOSAppCore`: domain-facing app state and typed desktop models
- `NeurOSDesktopServices`: native service protocols and bootstrap coordinator
- `NeurOSDesktopFeatures`: SwiftUI surfaces and desktop navigation
- `NeurOSDesktopApp`: app entry point and scenes

## Maintainer

- Instagram: `@monrars`
- Site: `goldneuron.io`
- GitHub: `@monrars1995`

## License

This app foundation is covered by the repository MIT license and includes a local MIT license file in this directory.
