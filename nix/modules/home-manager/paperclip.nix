{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.paperclip;
  client = pkgs.runCommand "paperclip-client" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
    mkdir -p "$out/bin"
    makeWrapper ${cfg.package}/bin/paperclip "$out/bin/paperclip" \
      ${
        lib.optionalString (cfg.apiUrl != null) "--set PAPERCLIP_API_URL ${lib.escapeShellArg cfg.apiUrl}"
      } \
      ${
        lib.optionalString (
          cfg.companyId != null
        ) "--set PAPERCLIP_COMPANY_ID ${lib.escapeShellArg cfg.companyId}"
      } \
      ${lib.optionalString (
        cfg.apiKeyFile != null
      ) "--set PAPERCLIP_API_KEY_FILE ${lib.escapeShellArg cfg.apiKeyFile}"}
  '';
in
{
  options.programs.paperclip = {
    enable = lib.mkEnableOption "Paperclip CLI client";
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.paperclip;
      defaultText = lib.literalExpression "pkgs.paperclip";
      description = ''
        Paperclip package providing bin/paperclip. When the client is enabled
        with apiKeyFile, this must be a package attribute set declaring
        supportsPaperclipApiKeyFile = true. The marker declares full protected
        credential-file runtime support from Paperclip #14466, not just support
        for the PAPERCLIP_API_KEY_FILE environment variable.
      '';
    };
    apiUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Default remote API URL for the CLI client.";
    };
    companyId = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Default company ID, for example from a deployment binding.";
    };
    apiKeyFile = lib.mkOption {
      type = lib.types.nullOr (lib.types.strMatching "^/[^[:space:]]+$");
      default = null;
      description = ''
        Runtime CLI credential file outside the Nix store. The client reads the
        file at runtime; Nix does not read or copy its contents. An enabled
        client requires a package declaring supportsPaperclipApiKeyFile = true
        for Paperclip #14466's protected credential-file runtime support.
      '';
    };
    deployments = lib.mkOption {
      type = lib.types.attrsOf (lib.types.attrsOf (pkgs.formats.json { }).type);
      default = { };
      description = ''
        Nonsecret native deployment manifests, keyed by a native resource key.
        Home Manager writes these declarations under XDG configuration. The
        optional NixOS bridge selects one for each system controller. Paperclip
        validates the manifest and applies its own ownership and access rules.
        Credential references name system-provisioned credentials, not values.
      '';
    };
  };

  config = {
    assertions = [
      {
        assertion =
          !cfg.enable
          || cfg.apiKeyFile == null
          || (
            builtins.isAttrs cfg.package
            && (cfg.package.supportsPaperclipApiKeyFile or false) == true
          );
        message = "Paperclip CLI apiKeyFile requires a package attribute set declaring supportsPaperclipApiKeyFile = true for full protected credential-file runtime support from Paperclip #14466.";
      }
      {
        assertion =
          cfg.apiKeyFile == null
          || !(cfg.apiKeyFile == builtins.storeDir || lib.hasPrefix "${builtins.storeDir}/" cfg.apiKeyFile);
        message = "Paperclip CLI credentials must be runtime files outside the Nix store.";
      }
      {
        assertion = lib.all (name: builtins.match "[a-z][a-z0-9_-]{0,62}" name != null) (
          builtins.attrNames cfg.deployments
        );
        message = "Paperclip deployment names must be native resource keys.";
      }
    ];
    home.packages = lib.optional cfg.enable client;
    xdg.configFile = lib.mapAttrs' (
      name: manifest:
      lib.nameValuePair "paperclip/deployments/${name}.json" {
        text = builtins.toJSON manifest;
      }
    ) cfg.deployments;
  };
}
