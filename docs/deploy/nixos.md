---
title: NixOS
summary: Native package and systemd service deployment
---

Paperclip provides a flake package, development shell, overlay, and NixOS
module. Docker is not required.

## Run or build the package

From a Paperclip checkout:

```sh
nix build
nix run -- --help
nix develop
```

The package builds the same UI and server entrypoints as the production Docker
image. It also installs the `paperclip` CLI and `paperclip-server` executable.

## Add the NixOS module

Add Paperclip as an updateable flake input and import its module:

```nix
{
  inputs.paperclip.url = "github:paperclipai/paperclip";

  outputs = { nixpkgs, paperclip, ... }: {
    nixosConfigurations.example = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        paperclip.nixosModules.paperclip
        {
          services.paperclip = {
            enable = true;
            host = "127.0.0.1";
          };
        }
      ];
    };
  };
}
```

This default uses `local_trusted` mode on loopback and embedded PostgreSQL. It
stores mutable data under `/var/lib/paperclip`.

The package already provides Node.js to its bundled local adapters. Use
`services.paperclip.extraPackages` for additional adapter CLIs or other runtime
tools.

## Authenticated deployments and secrets

Authenticated mode requires `BETTER_AUTH_SECRET`. External PostgreSQL requires
`DATABASE_URL`. Supply these and all other credentials through a runtime-only
systemd environment file:

```nix
services.paperclip = {
  enable = true;
  host = "0.0.0.0";
  openFirewall = true;
  publicExposure = true;

  auth = {
    enable = true;
    publicBaseUrl = "https://paperclip.example.com";
  };

  database.external.enable = true;
  environmentFiles = [ "/run/secrets/paperclip.env" ];
};
```

`publicExposure = true` is required for an internet-facing endpoint. It makes
Paperclip apply its stricter public exposure policy. Keep it `false` only when
the authenticated service is reachable exclusively over a private LAN, VPN,
or tailnet. Public exposure also requires external PostgreSQL, so `DATABASE_URL`
must be present in the runtime environment file.

Provision that file at runtime with a secret manager such as sops-nix or
agenix. Its format is:

```sh
BETTER_AUTH_SECRET=...
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=...
DATABASE_URL=postgresql://...
```

Never use `pkgs.writeText`, inline Nix strings, or another store-backed value
for this file. The module rejects environment file paths under `/nix/store`.
The generated Paperclip JSON configuration contains only non-secret settings.

## External PostgreSQL and S3

Enable external PostgreSQL after adding `DATABASE_URL` to the runtime
environment file:

```nix
services.paperclip.database.external.enable = true;
```

S3 access keys also belong in the environment file. Bucket and endpoint
metadata are non-secret Nix options:

```nix
services.paperclip.storage.s3 = {
  enable = true;
  bucket = "paperclip";
  region = "us-east-1";
};
```

## Additional writable workspaces

The service can write its state directory by default. Explicitly allow any
host workspaces used by local agents:

```nix
services.paperclip.readWritePaths = [ "/srv/paperclip-workspaces" ];
```

The module supports state directories outside `/var/lib`; systemd-tmpfiles
creates the selected path with service-user ownership.

## Verify the flake

Run all flake checks, the package build, or the NixOS VM test directly:

```sh
nix flake check
nix build .#paperclip
nix build .#checks.x86_64-linux.nixos-module
```

The VM test boots NixOS, creates representative secrets after boot, starts
Paperclip with embedded PostgreSQL, and verifies the health endpoint.
