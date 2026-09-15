# Docker sandbox provider

`@paperclipai/plugin-docker` creates one Docker container per Paperclip lease. It never mounts a host repository, home directory, credentials, Docker socket, devices, or host namespaces into a lease.

Leases run as the unprivileged `paperclip` user with all capabilities dropped and `no-new-privileges`. The image includes `sudo` for Noble tool compatibility, but it grants no `NOPASSWD` sudoers rule, so `sudo -n` cannot elevate a workload inside a provider-created lease.

Build the Noble QA image:

```sh
docker build -t paperclip-noble-qa:24.04 -f Dockerfile.noble .
```

Install a reviewed packed artifact:

```sh
paperclipai plugin install --local ./paperclipai-plugin-docker-0.1.0.tgz
paperclipai plugin health paperclip.docker-sandbox-provider
```

Enable an environment with `driver: sandbox`, `provider: docker`, and `image: paperclip-noble-qa:24.04`. The provider publishes only container port 3107, mapped to an allocated `127.0.0.1` port. Roll back by disabling the environment, uninstalling the plugin, and removing only containers with the exact `com.paperclip.managed=true` label.
