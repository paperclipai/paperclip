# `@paperclipai/plugin-smolmachines`

Run Paperclip agents in isolated SmolVMs on your own computer or in Smol Cloud. Each lease creates a VM with its own storage. The provider mounts no host directories and passes no host management socket or credentials into the VM. Paperclip's standard workspace sync and HTTP bridge handle host files and API access.

## Install and configure

Build the provider from a Paperclip checkout with the commands under **Local development**, then install it with `paperclipai plugin install --local /path/to/paperclip/packages/plugins/sandbox-providers/smolmachines` while the instance is running. Add a sandbox environment in **Instance Settings → Environments** with the **Smol Machines VM** driver. Select `local` or `cloud`.

- **Local:** Run Paperclip on a Linux host with `/dev/kvm`, an Apple Silicon Mac, or a Windows machine with the Windows Hypervisor Platform. The host needs a working SmolVM installation. A Paperclip Docker deployment needs access to the host hypervisor; ordinary containers cannot run local VMs without it.
- **Cloud:** Paste a Smol Cloud API key into the environment's `apiKey` field. Paperclip stores it as a company secret. `SMOL_CLOUD_TOKEN` or an existing `smol auth login` session can be used instead. Cloud VMs expire after `ttlSeconds` (one hour by default); increase that value when jobs run longer.

If no `image` is set, the provider selects Paperclip's published agent runtime image for the run's adapter (Claude, Codex, Gemini, OpenCode, or Pi). These images currently support linux/amd64 only. On a local Apple Silicon or arm64 Linux host, set `image` to an arm64 OCI image with the agent CLI installed. The default image tag pins a tested published build; set `image` to a newer published tag when needed. For other adapters, provide an OCI image containing `node`, `tar`, `sh`, and the agent CLI on `PATH`. The default probe uses `node:24-alpine` if no image is configured. The workspace lives under the image user's writable home; this keeps it writable for Paperclip's non-root runtime images and persistent across stop and restart.

A lease is deleted when the run ends. Enable `reuseLease` to stop the VM and retain its filesystem for a later run. Stopping it does not preserve running processes or RAM; it boots from the retained filesystem on reconnect. Each VM has outbound network access, so choose an image and credentials you trust with the workload's network authority.

The provider stages command stdin in a random file under the image user's home and removes it after command execution. It does not expose the host filesystem. The generic Paperclip sync path transfers workspace files through sandbox commands.

## Local development

```sh
pnpm install --frozen-lockfile
pnpm -C packages/plugins/sandbox-providers/smolmachines install --ignore-workspace --no-lockfile
pnpm -C packages/plugins/sandbox-providers/smolmachines typecheck
pnpm -C packages/plugins/sandbox-providers/smolmachines test
pnpm -C packages/plugins/sandbox-providers/smolmachines build
pnpm -C packages/plugins/sandbox-providers/smolmachines test:live
# Optional: SMOL_TEST_CLOUD=1 pnpm -C packages/plugins/sandbox-providers/smolmachines test:live
```

The provider lives outside the root pnpm workspace so it can publish as a standalone npm plugin. Its first `@paperclipai/plugin-smolmachines` npm publish needs a Paperclip maintainer; until then, install the local package as above. After that first publish, it can be installed from the Plugin Manager and enrolled in CI releases. For a managed Paperclip Cloud image, include `smolmachines` in the `CLOUD_BUNDLED_PLUGINS` build argument before enabling it in `plugins.autoInstall`; the default Cloud image bundles only Daytona.
