# Docker sandbox provider

`@paperclipai/plugin-docker` creates one Docker container per Paperclip lease. It never mounts a host repository, home directory, credentials, Docker socket, devices, or host namespaces into a lease. Containers run as the non-root `paperclip` uid/gid `1000`, drop all Linux capabilities, use `no-new-privileges`, and publish only container port 3107 to loopback.

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

## Trust boundary and provisioning

The image is immutable at runtime. Noble, Chromium, and their OS dependencies are installed during `docker build`; a running lease does not install packages and has no supported `sudo` or root path. Dependency probes therefore verify the already-provisioned image as the `paperclip` user.

Configured runtime-service commands execute only inside their owning lease through a fixed shell wrapper with one positional script argument. The host never interprets that script. Provider services receive only explicitly configured, non-secret service environment values and generated runtime values; Paperclip server and adapter environments are not inherited.

Every realize, execute, service start, service stop, and health operation re-inspects the canonical Docker container and requires the exact Paperclip company, environment, config, workspace, run, and lease labels before invoking Docker. To roll back safely, target only containers whose complete Paperclip label set matches the lease being removed.
