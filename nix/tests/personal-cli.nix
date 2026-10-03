{
  nixpkgsPath,
  homeManagerPath,
  system ? builtins.currentSystem,
  paperclipPackage ? null,
}:
let
  pkgs = import nixpkgsPath { inherit system; };
  inherit (pkgs) lib;
  hm = import (homeManagerPath + "/lib") { inherit lib; };
  apiUrl = "http://127.0.0.1:31987";
  companyId = "personal-cli-fixture";
  # The Linux Nix sandbox provides /build as its writable runtime root.
  apiKeyFile = "/build/paperclip-cli-api-key";
  home = hm.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      ../modules/home-manager/paperclip.nix
      {
        home.username = "operator";
        home.homeDirectory = "/home/operator";
        home.stateVersion = "26.05";
        programs.paperclip = {
          enable = true;
          package = if paperclipPackage == null then pkgs.paperclip else paperclipPackage;
          inherit apiUrl companyId apiKeyFile;
        };
      }
    ];
  };
  client = lib.findFirst (p: p.name == "paperclip-client") null home.config.home.packages;
in
assert lib.assertMsg (client != null) "Paperclip CLI wrapper is missing";
pkgs.runCommand "paperclip-personal-cli-test"
  {
    nativeBuildInputs = [ pkgs.python3 ];
    meta.platforms = lib.platforms.linux;
  }
  ''
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    python3 ${./personal-cli.py} ${client}/bin/paperclip ${lib.escapeShellArg apiUrl} \
      ${lib.escapeShellArg companyId} ${lib.escapeShellArg apiKeyFile}
    touch "$out"
  ''
