{
  description = "Paperclip — AI agent orchestration platform";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    let
      paperclipModule = import ./nix/modules/nixos/paperclip.nix;

      paperclipOverlay = final: _prev: {
        paperclip = self.packages.${final.stdenv.hostPlatform.system}.paperclip;
      };

      nixosModule =
        { lib, pkgs, ... }:
        {
          imports = [ paperclipModule ];

          services.paperclip.package =
            lib.mkDefault
              self.packages.${pkgs.stdenv.hostPlatform.system}.paperclip;
        };
    in
    {
      nixosModules = {
        default = nixosModule;
        paperclip = nixosModule;
      };

      overlays = {
        default = paperclipOverlay;
        paperclip = paperclipOverlay;
      };
    }
    //
      flake-utils.lib.eachSystem
        [
          "x86_64-linux"
          "aarch64-linux"
          "aarch64-darwin"
        ]
        (
          system:
          let
            pkgs = import nixpkgs { inherit system; };
            inherit (pkgs) lib;
            nodejs = pkgs.nodejs;
            pnpm = pkgs.pnpm_10;
            version = (builtins.fromJSON (builtins.readFile ./server/package.json)).version;

            # Keep packaging inputs independent from Nix modules, tests, and
            # documentation. Otherwise editing a VM assertion needlessly
            # rebuilds the entire JavaScript application.
            packageSource = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./.npmrc
                ./LICENSE
                ./README.md
                ./package.json
                ./pnpm-lock.yaml
                ./pnpm-workspace.yaml
                ./tsconfig.base.json
                ./tsconfig.json
                ./cli
                ./packages
                ./patches
                ./scripts
                ./server
                ./skills
                ./skills-releases
                ./ui
              ];
            };

            runtimePath = lib.makeBinPath [
              pkgs.curl
              pkgs.gh
              pkgs.git
              pkgs.jq
              pkgs.openssh
              pkgs.postgresql
              pkgs.ripgrep
              pkgs.wget
            ];

            # pnpm-generated launchers for bundled local adapters execute
            # `node` via PATH rather than using Paperclip's absolute Node path.
            # Add it in the lightweight public wrapper layer so every adapter
            # child inherits Node without rebuilding the large JS runtime.
            adapterRuntimePath = lib.makeBinPath [ nodejs ];

            paperclipUnwrapped = pkgs.stdenv.mkDerivation (finalAttrs: {
              pname = "paperclip";
              inherit version;
              src = packageSource;

              strictDeps = true;

              nativeBuildInputs = [
                nodejs
                pnpm
                pkgs.pnpmConfigHook
                pkgs.makeWrapper
                pkgs.python3
                pkgs.pkg-config
              ];

              buildInputs = [
                pkgs.postgresql
                pkgs.vips
              ];

              # The workspace packages export TypeScript sources during monorepo
              # development. Hoisting keeps those exports and their dependencies
              # resolvable from the installed application tree.
              pnpmInstallFlags = [ "--shamefully-hoist" ];
              pnpmWorkspaces = [
                "paperclipai..."
                "@paperclipai/ui..."
              ];

              # pnpm 10 is the supported, non-vulnerable pnpm in nixpkgs. The
              # repository lockfile is maintained by GitHub Actions with pnpm 9,
              # whose patch hashes use the older short form. Normalize only the
              # sandbox copy until the upstream lockfile moves to pnpm 10.
              prePnpmInstall = ''
                # Large optional agent SDK binaries can otherwise saturate this
                # host's connection and make pnpm discard the entire fixed-output
                # fetch after a transient registry timeout.
                pnpm config set network-concurrency 4
                pnpm config set fetch-retries 5
                pnpm config set fetch-retry-mintimeout 20000
                pnpm config set fetch-retry-maxtimeout 120000
                pnpm config set fetch-timeout 600000

                substituteInPlace pnpm-lock.yaml \
                  --replace-fail x3fethhotv43zektyl5prdwf54 a93c6b5344b036508a5a86ba7e8589b11302119d46bdc51318e297b74fa5666e \
                  --replace-fail 55uhvnotpqyiy37rn3pqpukhei d8b1e087e95f559a6342fc15954f11af22d9dca43a7fcca5762b6459913b5800
              '';

              pnpmDeps = pkgs.fetchPnpmDeps {
                inherit (finalAttrs)
                  pname
                  version
                  src
                  pnpmWorkspaces
                  prePnpmInstall
                  ;
                inherit pnpm;
                fetcherVersion = 4;
                hash = "sha256-xcAji32woqLG93dclH/hDaWyNUeLHWdXfW+AKeIPF7o=";
              };

              buildPhase = ''
                runHook preBuild

                # Keep this aligned with the production Docker build. The CLI is
                # built as well because it is the flake's default executable.
                pnpm --filter @paperclipai/ui build
                pnpm --filter @paperclipai/plugin-sdk build
                # TypeScript's server program exceeds V8's default ~2 GiB heap
                # on memory-constrained Nix builders.
                NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @paperclipai/server build
                pnpm --filter paperclipai build

                test -f server/dist/index.js
                test -f cli/dist/index.js

                runHook postBuild
              '';

              installPhase = ''
                runHook preInstall

                mkdir -p "$out/lib/paperclip"
                cp -R . "$out/lib/paperclip"

                mkdir -p "$out/bin"
                makeWrapper ${nodejs}/bin/node "$out/bin/paperclip" \
                  --add-flags "$out/lib/paperclip/cli/dist/index.js" \
                  --set-default NODE_ENV production \
                  --set-default PAPERCLIP_BUILD_VERSION ${lib.escapeShellArg version} \
                  --prefix PATH : ${lib.escapeShellArg runtimePath}

                # server/dist is JavaScript, but it imports workspace packages
                # whose development manifests intentionally export src/*.ts.
                # Keep the tsx loader until the production build rewrites those
                # workspace exports to dist/*.js.
                makeWrapper ${nodejs}/bin/node "$out/bin/paperclip-server" \
                  --add-flags "--import $out/lib/paperclip/server/node_modules/tsx/dist/loader.mjs" \
                  --add-flags "$out/lib/paperclip/server/dist/index.js" \
                  --set-default NODE_ENV production \
                  --set-default PAPERCLIP_BUILD_VERSION ${lib.escapeShellArg version} \
                  --set-default SERVE_UI true \
                  --set-default HOST 127.0.0.1 \
                  --set-default PORT 3100 \
                  --prefix PATH : ${lib.escapeShellArg runtimePath}

                runHook postInstall
              '';

              meta = {
                description = "Control plane for autonomous AI companies";
                homepage = "https://github.com/paperclipai/paperclip";
                license = lib.licenses.mit;
                mainProgram = "paperclip";
                platforms = lib.platforms.unix;
              };
            });

            # Paperclip prepares soname aliases for its embedded PostgreSQL at
            # runtime. Nix store paths are immutable, so create those aliases
            # in a lightweight post-processing derivation instead of letting
            # the service attempt to mutate its installed package.
            paperclipRuntime =
              pkgs.runCommand "paperclip-${version}"
                {
                  inherit (paperclipUnwrapped) meta;
                  passthru.unwrapped = paperclipUnwrapped;
                  dontFixup = true;
                }
                ''
                  cp -a --reflink=auto ${paperclipUnwrapped} "$out"

                  chmod u+w "$out/bin/paperclip" "$out/bin/paperclip-server"
                  substituteInPlace "$out/bin/paperclip" "$out/bin/paperclip-server" \
                    --replace-fail ${paperclipUnwrapped} "$out"

                  # The upstream embedded PostgreSQL binaries use the generic
                  # FHS loader path (/lib64/ld-linux-x86-64.so.2 on x86_64),
                  # which does not exist on a normal NixOS system. Point every
                  # bundled ELF executable at this platform's store loader;
                  # Paperclip itself supplies the matching native library path
                  # before spawning them.
                  while IFS= read -r -d "" executable; do
                    if ${pkgs.patchelf}/bin/patchelf --print-interpreter "$executable" >/dev/null 2>&1; then
                      chmod u+w "$executable"
                      ${pkgs.patchelf}/bin/patchelf \
                        --set-interpreter ${lib.escapeShellArg pkgs.stdenv.cc.bintools.dynamicLinker} \
                        "$executable"
                    fi
                  done < <(
                    find "$out/lib/paperclip/node_modules/.pnpm" \
                      -path '*/@embedded-postgres/*/native/bin/*' \
                      -type f -print0
                  )

                  while IFS= read -r -d "" library; do
                    libDir="$(dirname "$library")"
                    libraryName="$(basename "$library")"
                    aliasName="$(printf '%s\n' "$libraryName" | sed -E 's/^(lib.+\.so\.[0-9]+)\.[0-9]+(\.[0-9]+)?$/\1/')"
                    if [ "$aliasName" = "$libraryName" ] || [ -e "$libDir/$aliasName" ]; then
                      continue
                    fi

                    chmod u+w "$libDir"
                    ln -s "$libraryName" "$libDir/$aliasName"
                    chmod u-w "$libDir"
                  done < <(
                    find "$out/lib/paperclip/node_modules/.pnpm" \
                      -path '*/@embedded-postgres/*/native/lib/lib*.so.*.*' \
                      -type f -print0
                  )
                '';

            # Keep the large, immutable runtime as its own cached layer. The
            # public package only adds wrappers, including the C++ runtime
            # needed by the bundled initdb/postgres binaries.
            paperclip =
              pkgs.runCommand "paperclip-${version}"
                {
                  inherit (paperclipRuntime) meta;
                  nativeBuildInputs = [ pkgs.makeWrapper ];
                  passthru = {
                    inherit paperclipRuntime paperclipUnwrapped;
                    runtime = paperclipRuntime;
                    unwrapped = paperclipUnwrapped;
                  };
                }
                ''
                  mkdir -p "$out/bin"
                  ln -s ${paperclipRuntime}/lib "$out/lib"
                  makeWrapper \
                    ${paperclipRuntime}/bin/paperclip \
                    "$out/bin/paperclip" \
                    --prefix PATH : ${lib.escapeShellArg adapterRuntimePath}
                  makeWrapper \
                    ${paperclipRuntime}/bin/paperclip-server \
                    "$out/bin/paperclip-server" \
                    --prefix PATH : ${lib.escapeShellArg adapterRuntimePath} \
                    --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]}
                '';
          in
          {
            packages = {
              default = paperclip;
              inherit paperclip;
            };

            apps = {
              default = {
                type = "app";
                program = "${paperclip}/bin/paperclip";
              };
              paperclip-server = {
                type = "app";
                program = "${paperclip}/bin/paperclip-server";
              };
            };

            checks = {
              package = paperclip;
            }
            // lib.optionalAttrs pkgs.stdenv.isLinux {
              nixos-module = import ./nix/tests/nixos-module.nix {
                inherit pkgs self;
              };
            };

            devShells.default = pkgs.mkShell {
              packages = [
                nodejs
                pnpm
                pkgs.curl
                pkgs.gh
                pkgs.git
                pkgs.jq
                pkgs.openssh
                pkgs.pkg-config
                pkgs.playwright-driver.browsers
                pkgs.python3
                pkgs.ripgrep
                pkgs.vips
                pkgs.wget
              ];

              shellHook = ''
                export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
                export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
              '';
            };

            formatter = pkgs.nixfmt;
          }
        );
}
