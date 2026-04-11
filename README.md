<p align="center">
  <img src="doc/assets/header.png" alt="Paperclip — runs your business" width="720" />
</p>

<h3 align="center">Paperclip Inc. — Opinionated Fork</h3>

<p align="center">
  This is the <strong>internal fork</strong> maintained by <a href="https://paperclip.inc">Paperclip Inc.</a><br/>
  For the upstream open-source project, visit <a href="https://github.com/paperclipai/paperclip"><strong>paperclipai/paperclip</strong></a>.
</p>

<p align="center">
  <a href="https://github.com/paperclipai/paperclip"><img src="https://img.shields.io/badge/upstream-paperclipai%2Fpaperclip-blue" alt="Upstream" /></a>
  <a href="https://github.com/paperclipai/paperclip/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
</p>

<br/>

## About this repository

This fork powers the managed hosting platform at [paperclip.inc](https://paperclip.inc). It tracks the upstream [paperclipai/paperclip](https://github.com/paperclipai/paperclip) project and layers on opinionated adaptations specific to our infrastructure, workflows, and customer requirements.

Changes made here are **not intended for general use**. If you're looking to self-host or contribute to Paperclip, head to the upstream repository.

<br/>

## Relationship to upstream

| | |
| --- | --- |
| **Upstream** | [github.com/paperclipai/paperclip](https://github.com/paperclipai/paperclip) |
| **This fork** | [github.com/paperclipinc/paperclip](https://github.com/paperclipinc/paperclip) |
| **Sync strategy** | Regularly rebased onto `upstream/main` |
| **Direction of contributions** | Bug fixes and improvements are contributed back upstream via pull requests |

<br/>

## What this fork adds

This repository contains modifications tailored to the Paperclip Inc. managed platform, including but not limited to:

- Infrastructure and deployment configuration for our hosting environment
- Platform-specific integrations and service adapters
- Internal tooling and operational enhancements
- Security hardening for multi-tenant production workloads

<br/>

## Contributing

**Upstream contributions** — If you'd like to contribute to Paperclip itself, please open issues and pull requests against the upstream repository at [paperclipai/paperclip](https://github.com/paperclipai/paperclip).

**Fork-specific changes** — Internal team members should follow the standard branch-and-PR workflow against this repository.

<br/>

## Development

```bash
pnpm install
pnpm dev
```

See [doc/DEVELOPING.md](doc/DEVELOPING.md) for the full development guide.

<br/>

## Roadmap

- ✅ Plugin system (e.g. add a knowledge base, custom tracing, queues, etc)
- ✅ Get OpenClaw / claw-style agent employees
- ✅ companies.sh - import and export entire organizations
- ✅ Easy AGENTS.md configurations
- ✅ Skills Manager
- ✅ Scheduled Routines
- ✅ Better Budgeting
- ✅ Agent Reviews and Approvals
- ⚪ Multiple Human Users
- ⚪ Cloud / Sandbox agents (e.g. Cursor / e2b agents)
- ⚪ Artifacts & Work Products
- ⚪ Memory & Knowledge
- ⚪ Enforced Outcomes
- ⚪ MAXIMIZER MODE
- ⚪ Deep Planning
- ⚪ Work Queues
- ⚪ Self-Organization
- ⚪ Automatic Organizational Learning
- ⚪ CEO Chat
- ⚪ Cloud deployments
- ⚪ Desktop App

<br/>

## Community & Plugins

Find Plugins and more at [awesome-paperclip](https://github.com/gsxdsm/awesome-paperclip)

## Telemetry

Paperclip collects anonymous usage telemetry to help us understand how the product is used and improve it. No personal information, issue content, prompts, file paths, or secrets are ever collected. Private repository references are hashed with a per-install salt before being sent.

Telemetry is **enabled by default** and can be disabled with any of the following:

| Method               | How                                                     |
| -------------------- | ------------------------------------------------------- |
| Environment variable | `PAPERCLIP_TELEMETRY_DISABLED=1`                        |
| Standard convention  | `DO_NOT_TRACK=1`                                        |
| CI environments      | Automatically disabled when `CI=true`                   |
| Config file          | Set `telemetry.enabled: false` in your Paperclip config |

## Contributing

We welcome contributions. See the [contributing guide](CONTRIBUTING.md) for details.

<br/>

## Community

- [Discord](https://discord.gg/m4HZY7xNG3) — Join the community
- [GitHub Issues](https://github.com/paperclipai/paperclip/issues) — bugs and feature requests
- [GitHub Discussions](https://github.com/paperclipai/paperclip/discussions) — ideas and RFC

<br/>

## License

MIT — see [LICENSE](LICENSE). Original work by [Paperclip](https://github.com/paperclipai/paperclip).

<br/>

---

<p align="center">
  <sub><a href="https://paperclip.inc">paperclip.inc</a> · Managed Paperclip hosting</sub>
</p>
