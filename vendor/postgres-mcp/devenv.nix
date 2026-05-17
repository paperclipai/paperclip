{ pkgs, lib, config, inputs, ... }:
let
  pkgs-unstable = import inputs.nixpkgs-unstable { system = pkgs.stdenv.system; };
in
{
  # https://devenv.sh/basics/
  env.GREET = "devenv";

  # https://devenv.sh/packages/
  packages = with pkgs; [
    git
    postgresql_16
    pkgs-unstable.libgcc
  ];

  # env = {
  #   LD_LIBRARY_PATH = "${pkgs-unstable.icu}/lib:${pkgs-unstable.gcc.cc.lib}/lib64:${pkgs-unstable.gcc.cc.lib}/lib";
  #   NIX_GLIBC_PATH = "${pkgs-unstable.gcc.cc.lib}/lib64:${pkgs-unstable.gcc.cc.lib}/lib";
  # };

  # https://devenv.sh/languages/
  languages.javascript = {
    enable = true;
    package = pkgs-unstable.nodejs;
    corepack.enable = true;
  };

  languages.python = {
    enable = true;
    # version = "3.12";
    uv = {
      enable = true;
      sync = {
        enable = true;
        allExtras = true;
      };
    };
  };

  dotenv.enable = true;

  # https://devenv.sh/processes/
  # processes.cargo-watch.exec = "cargo-watch";

  # https://devenv.sh/services/
  #   services.postgres = {
  #     enable = true; # to delete: set to false, then rm .devenv/state/postgres
  #     port = 5444;
  #     listen_addresses = "127.0.0.1";
  #     initialScript = "
  # CREATE USER postgres SUPERUSER;
  # ALTER USER postgres WITH PASSWORD 'mysecretpassword';
  # CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
  #     "; # SELECT * FROM pg_stat_statements LIMIT 1;
  #     settings.shared_preload_libraries = "pg_stat_statements";
  #   };

  # https://devenv.sh/scripts/   
  scripts.hello.exec = ''
    echo hello from $GREET
  '';

  enterShell = ''
    hello
    echo "Crystal DBA Agent Development Environment"
  '';

  # https://devenv.sh/tasks/
  # tasks = {
  #   "myproj:setup".exec = "mytool build";
  #   "devenv:enterShell".after = [ "myproj:setup" ];
  # };

  # https://devenv.sh/tests/
  enterTest = ''
    echo "Running tests"
    git --version | grep --color=auto "${pkgs.git.version}"
  '';

  # https://devenv.sh/git-hooks/
  # git-hooks.hooks.shellcheck.enable = true;

  # See full reference at https://devenv.sh/reference/options/
}
