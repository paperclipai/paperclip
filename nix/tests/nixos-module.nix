{ pkgs, self }:

let
  paperclip = self.packages.${pkgs.stdenv.hostPlatform.system}.paperclip;
in

pkgs.testers.nixosTest {
  name = "paperclip-nixos-module";

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [ self.nixosModules.paperclip ];

      services.paperclip = {
        enable = true;
        autoStart = false;
        stateDir = "/srv/paperclip";
        host = "0.0.0.0";
        allowedHostnames = [ "127.0.0.1" ];
        auth = {
          enable = true;
          publicBaseUrl = "http://127.0.0.1:3100";
        };
        database.backup.enable = false;
        telemetry.enable = false;
        environmentFiles = [ "/run/paperclip/runtime.env" ];
      };

      # Generate representative secrets only after the VM boots. The values
      # therefore never become Nix expressions or store objects.
      systemd.services.paperclip-runtime-env = {
        description = "Create Paperclip's runtime-only test environment";
        requiredBy = [ "paperclip.service" ];
        before = [ "paperclip.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          install -d -m 0700 /run/paperclip
          umask 0077
          auth_secret="$(${pkgs.openssl}/bin/openssl rand -hex 32)"
          action_secret="$(${pkgs.openssl}/bin/openssl rand -hex 32)"
          printf 'BETTER_AUTH_SECRET=%s\nPAPERCLIP_TOOL_ACTION_SIGNING_SECRET=%s\n' \
            "$auth_secret" "$action_secret" > /run/paperclip/runtime.env
          chown root:paperclip /run/paperclip/runtime.env
          chmod 0600 /run/paperclip/runtime.env
        '';
      };

      # Keep a startup failure observable instead of hiding it behind the
      # production restart policy until the test driver's global timeout.
      systemd.services.paperclip.serviceConfig.Restart = pkgs.lib.mkForce "no";

      environment.systemPackages = [ pkgs.curl ];
    };

  nodes.public = {
    imports = [ self.nixosModules.paperclip ];

    services.paperclip = {
      enable = true;
      autoStart = false;
      host = "0.0.0.0";
      openFirewall = true;
      publicExposure = true;
      auth = {
        enable = true;
        publicBaseUrl = "https://paperclip.example.com";
      };
      database.external.enable = true;
      environmentFiles = [ "/run/paperclip/runtime.env" ];
    };
  };

  testScript = ''
    start_all()
    machine.succeed("test \"$(stat -c %U:%G /srv/paperclip/instances)\" = paperclip:paperclip")
    machine.succeed("test \"$(stat -c %U:%G /srv/paperclip/instances/default)\" = paperclip:paperclip")
    machine.succeed("systemctl start paperclip.service")
    machine.wait_for_unit("paperclip.service")
    machine.wait_until_succeeds(
      "ss -H -ltn 'sport = :3100' | grep -q '0.0.0.0:3100' || systemctl is-failed --quiet paperclip.service",
      timeout=600,
    )
    machine.succeed("systemctl is-active --quiet paperclip.service")
    machine.wait_for_open_port(3100, timeout=30)
    machine.succeed("systemctl show paperclip.service -p Environment --value | grep -q 'HOST=0.0.0.0'")
    machine.succeed("systemctl show paperclip.service -p Environment --value | grep -q 'PORT=3100'")
    machine.succeed("systemctl show paperclip.service -p Environment --value | grep -q 'SERVE_UI=true'")
    machine.succeed(
      "main_pid=$(systemctl show paperclip.service -p MainPID --value); "
      "service_path=$(tr '\\0' '\\n' < /proc/$main_pid/environ | sed -n 's/^PATH=//p'); "
      "printf '%s\\n' \"$service_path\" | grep -Fq '${pkgs.nodejs}/bin'; "
      "PATH=\"$service_path\" ${paperclip}/lib/paperclip/packages/adapters/codex-local/node_modules/.bin/codex-acp --version "
      "| grep -q '^@agentclientprotocol/codex-acp '"
    )

    machine.succeed(
      "curl --fail --silent http://127.0.0.1:3100/api/health | grep -q '\"status\":\"ok\"'"
    )
    machine.succeed("test \"$(stat -c %a /run/paperclip/runtime.env)\" = 600")
    machine.succeed("test \"$(stat -c %U /run/paperclip/runtime.env)\" = root")
    machine.succeed("systemctl cat paperclip.service | grep -q 'EnvironmentFile=/run/paperclip/runtime.env'")
    machine.succeed("grep -q '\"source\":\"nixos-module\"' /etc/paperclip/config.json")
    machine.succeed("! grep -Eq 'BETTER_AUTH_SECRET|PAPERCLIP_TOOL_ACTION_SIGNING_SECRET|DATABASE_URL' /etc/paperclip/config.json")
    public.succeed("grep -q '\"exposure\":\"public\"' /etc/paperclip/config.json")
    public.succeed("grep -q '\"mode\":\"postgres\"' /etc/paperclip/config.json")
  '';
}
