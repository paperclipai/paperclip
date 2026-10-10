# Personal declarations with Home Manager

The Home Manager module writes nonsecret deployment manifests and configures the
Paperclip CLI. The NixOS bridge selects one personal manifest for each system
controller. The controller runs the native reconciler under its database lease.

This integration requires the native deployment entry point from
[Paperclip #14616](https://github.com/paperclipai/paperclip/pull/14616) and the
`services.paperclip.instances` module from
[nixpkgs #567242](https://github.com/NixOS/nixpkgs/pull/567242). Both contributions
are under review. Select compatible, immutable package and module revisions.
CLI credential-file support comes from
[Paperclip #14466](https://github.com/paperclipai/paperclip/pull/14466), independently
of #14616's native deployment entry point. An enabled CLI with `apiKeyFile`
requires a package attribute set declaring `supportsPaperclipApiKeyFile = true`.
This marker declares #14466's full protected credential-file runtime support:
protected file validation, credential precedence, fail-closed errors, and sanitized
diagnostics. Recognizing `PAPERCLIP_API_KEY_FILE` alone is insufficient. The
module-only source does not add that application behavior.

Packaging owners add the marker only to packages implementing that contract.
Absent, false, or string-valued markers and plain package path strings are rejected
when the CLI is enabled with a credential file. CLI enablement without
`apiKeyFile`, and a disabled CLI with a runtime credential path, do not require
the marker. Actual marked-package runtime proof remains pending.

## Personal configuration

Import `nix/modules/home-manager/paperclip.nix` in your Home Manager modules:

```nix
{
  imports = [ "${paperclipSource}/nix/modules/home-manager/paperclip.nix" ];
  programs.paperclip = {
    enable = true;
    package = pkgs.paperclip; # Must retain supportsPaperclipApiKeyFile = true metadata.
    apiUrl = "https://paperclip.example.org";
    apiKeyFile = "/run/credentials/paperclip-cli/api-key";
    deployments.work = {
      version = 1;
      owner = "personal";
      companies.example.fields = {
        name = "Example company";
        budgetMonthlyCents = 1000;
      };
    };
  };
}
```

The declaration is available at
`$XDG_CONFIG_HOME/paperclip/deployments/work.json`. Manifest output is independent
of CLI enablement. `companyId` can set the CLI's default company after native
startup exports its resource bindings. `apiKeyFile` is a runtime path; its
contents are never read during evaluation or copied to the Nix store.
Keep the package derivation with its capability metadata when passing it to the
module. Converting it to a plain store path loses the marker and is insufficient
for an enabled client with `apiKeyFile`. Provision a protected credential file
at runtime; the CLI validates it before making authenticated requests and refuses
invalid files even when an ambient API key is available.
Company defaults apply to commands that support them, such as `issue list`.
Commands such as `agent list` still require an explicit `--company-id`.

Manifest fields must be nonsecret. Use credential references such as
`agents.hermes.credentials.apiKey = "gateway"`, then provision the matching
credential through the system service. Nix values, generated manifests, and the
store are readable by other local users. The runtime manifest validator remains
the source of truth for resource types, company boundaries, ownership, adoption,
and schedule semantics. Omitted fields and explicit `null` retain their distinct
native meanings.

## System selection

Alongside the NixOS Paperclip and Home Manager modules, import the bridge:

```nix
{
  imports = [ "${paperclipSource}/nix/modules/nixos/home-manager.nix" ];
  services.paperclip.homeManager.deployments.operations = {
    user = "operator";
    deployment = "work";
  };
  services.paperclip.instances.operations = {
    enable = true;
    package = pkgs.paperclip;
    # Configure database, authentication, credentials, and state here.
  };
}
```

The bridge imports the personal module through `home-manager.sharedModules`.
It reads `home-manager.users.operator.programs.paperclip.deployments.work` during
system evaluation. Home Manager activation does not call Paperclip or start a
reconciler. The host selects the evaluated manifest, not a mutable file in the
user's home. Changing the personal manifest takes effect when the selected system
controller is rebuilt and restarted.

The bridge rejects a missing user or manifest. It also rejects extensions and
overrides at `services.paperclip.instances.<name>.manifest`, including `mkForce`.
Declare all resource fields in the selected personal manifest. Normal Nix module
composition of `home-manager.users.<user>.programs.paperclip.deployments.<name>`
is allowed: the bridge selects that final evaluated value, not its author or
module provenance. A controller without a Home Manager selection can use the
normal system `manifest` option directly.

System service identities, filesystem access, worker configuration, credentials,
and database settings belong to NixOS. Paperclip owns application users,
memberships, authorization, budgets, and governance. A Home Manager user name
does not grant application membership. Selection does not enable a controller;
the system must set `services.paperclip.instances.<name>.enable` explicitly.

## Evaluation tests

Use a nixpkgs checkout containing the service module and a Home Manager checkout:

```sh
nix eval --json --impure --expr '
  import ./nix/tests/personal-declarations.nix {
    nixpkgsPath = /absolute/path/to/nixpkgs;
    homeManagerPath = /absolute/path/to/home-manager;
  }
'
```

The expression checks standalone and integrated Home Manager, lossless manifest
forwarding, disabled-controller behavior, runtime credential references, missing
selections, and conflicting system definitions. Synthetic package fixtures check
the enabled credential-file capability matrix (true, false, absent, string-valued,
and plain package path), enabled clients without a credential file, and disabled
clients with a runtime credential path. Rejections are checked through the
activation package's `drvPath`. These fixtures test evaluation only and do not
prove runtime credential-file support. The expression starts no services and
needs no credentials. Runtime reconciliation and package/VM tests remain the
responsibility of the native startup and NixOS service contributions.

## CLI execution test

`nix/tests/personal-cli.nix` builds and runs the actual Home Manager wrapper on
Linux. It uses a loopback fixture API and a disposable runtime key to verify
authentication, API URL and company selection, and refusal of missing or publicly
readable keys even when an ambient API key is present. Both failure cases must
emit a `CLI credential file` diagnostic on stderr without exposing the token or
contacting the API. Use a package with the packaging-owned capability marker and
the required #14466 runtime support; the test does not add that marker.
It checks the company default with `issue list` and authenticated agent listing
with the required explicit company flag.

Build this expression with the same immutable nixpkgs and Home Manager inputs:

```sh
nix build --impure --expr '
  import ./nix/tests/personal-cli.nix {
    nixpkgsPath = /absolute/path/to/nixpkgs;
    homeManagerPath = /absolute/path/to/home-manager;
  }
'
```

To check an already-built compatible package, pass its derivation as
`paperclipPackage`, retaining `supportsPaperclipApiKeyFile = true` metadata. A plain
store path is insufficient. Packaging marker addition remains packaging
owner-controlled; qualification of an actual marked package with this runtime
test remains pending. The test performs no controller reconciliation or worker
dispatch.
