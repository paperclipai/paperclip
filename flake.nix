{
  description = "Paperclip — AI agent orchestration platform";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      # Non-per-system outputs
      nonSystemOutputs = {
        nixosModules.paperclip = import ./nix/modules/nixos/paperclip.nix;

        overlays.default = final: prev: {
          paperclip = self.packages.${final.system}.default;
        };
      };

      # Per-system outputs (packages, devShells)
      perSystemOutputs = flake-utils.lib.eachDefaultSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          nodejs = pkgs.nodejs_22;
          pnpm = pkgs.pnpm_9;
        in
        {
          packages.default = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "paperclip";
            version = "0.3.1";
            src = ./.;

            nativeBuildInputs = [
              nodejs
              pnpm
              pkgs.pnpmConfigHook
              pkgs.makeWrapper
              pkgs.python3 # node-gyp
              pkgs.pkg-config
            ];

            buildInputs = [
              pkgs.vips # sharp
              pkgs.postgresql # embedded-postgres runtime
            ];

            # Hoist all deps to root node_modules so Node ESM resolution works
            # from any package in the monorepo.
            prePnpmInstall = ''
              echo "shamefully-hoist=true" >> .npmrc
            '';

            # First build: run `nix build`, Nix will error with the correct hash.
            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src prePnpmInstall;
              inherit pnpm;
              fetcherVersion = 3;
              hash = "sha256-5SgY5W5xrY2p8DN9fZ38SNhR+BIXm7hOXILpfyQcRsQ=";
            };

            buildPhase = ''
              runHook preBuild
              pnpm --filter @paperclipai/shared build
              pnpm --filter @paperclipai/db build
              pnpm --filter @paperclipai/adapter-utils build
              pnpm --filter @paperclipai/plugin-sdk build
              pnpm --filter @paperclipai/ui build
              pnpm --filter @paperclipai/server build
              pnpm --filter paperclipai build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              # Copy the full built tree
              mkdir -p $out/lib/paperclip
              cp -r node_modules package.json pnpm-workspace.yaml $out/lib/paperclip/
              for dir in cli server ui packages; do
                cp -r $dir $out/lib/paperclip/
              done

              # CLI entrypoint
              mkdir -p $out/bin
              makeWrapper ${nodejs}/bin/node $out/bin/paperclip \
                --add-flags "$out/lib/paperclip/cli/dist/index.js" \
                --set NODE_ENV production

              # Server entrypoint (for running as a service)
              # PORT, HOST, and SERVE_UI can be overridden at runtime via env vars,
              # e.g.: PORT=8080 HOST=127.0.0.1 paperclip-server
              makeWrapper ${nodejs}/bin/node $out/bin/paperclip-server \
                --add-flags "--import $out/lib/paperclip/server/node_modules/tsx/dist/loader.mjs" \
                --add-flags "$out/lib/paperclip/server/dist/index.js" \
                --set-default NODE_ENV production \
                --set-default SERVE_UI true \
                --set-default HOST 0.0.0.0 \
                --set-default PORT 3100 \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git pkgs.gh pkgs.ripgrep ]}

              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Orchestrate AI agent teams";
              homepage = "https://github.com/paperclipai/paperclip";
              license = licenses.mit;
              mainProgram = "paperclip";
            };
          });

          devShells.default = pkgs.mkShell {
            buildInputs = [
              nodejs
              pkgs.corepack_22
              pkgs.git
              pkgs.gh
              pkgs.ripgrep
              pkgs.python3
              pkgs.jq
              pkgs.openssh
              pkgs.curl
              pkgs.wget
              pkgs.vips
              pkgs.pkg-config
              pkgs.playwright-driver.browsers
            ];

            shellHook = ''
              export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
              export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
              corepack enable
            '';
          };
        });
    in
    perSystemOutputs // nonSystemOutputs;
}
