{ config, lib, pkgs, ... }:

let
  cfg = config.services.paperclip;
  instanceDir = "${cfg.stateDir}/instances/${cfg.instanceId}";

  configJson = pkgs.writeText "paperclip-config.json" (builtins.toJSON (lib.recursiveUpdate {
    "$meta" = {
      version = 1;
      source = "nixos-module";
    };
    server = {
      deploymentMode = if cfg.auth.enable then "authenticated" else "local_trusted";
      exposure = if cfg.publicExposure then "public" else "private";
      host = cfg.host;
      port = cfg.port;
      serveUi = cfg.serveUi;
    };
    database = {
      mode = if cfg.database.external.enable then "postgres" else "embedded-postgres";
      embeddedPostgresDataDir = "${instanceDir}/db";
      backup = {
        enabled = cfg.database.backup.enable;
        intervalMinutes = cfg.database.backup.intervalMinutes;
        retentionDays = cfg.database.backup.retentionDays;
        dir = "${instanceDir}/data/backups";
      };
    } // lib.optionalAttrs cfg.database.external.enable {
      connectionString = cfg.database.external.url;
    };
    storage = {
      provider = if cfg.storage.s3.enable then "s3" else "local_disk";
      localDisk = {
        baseDir = "${instanceDir}/data/storage";
      };
    } // lib.optionalAttrs cfg.storage.s3.enable {
      s3 = {
        inherit (cfg.storage.s3) bucket region prefix forcePathStyle;
      } // lib.optionalAttrs (cfg.storage.s3.endpoint != null) {
        inherit (cfg.storage.s3) endpoint;
      };
    };
    logging = {
      logDir = "${instanceDir}/logs";
    };
    secrets = {
      provider = "local_encrypted";
      localEncrypted = {
        keyFilePath = "${instanceDir}/secrets/master.key";
      };
    };
  } cfg.settings));

in
{
  options.services.paperclip = {
    enable = lib.mkEnableOption "Paperclip AI agent orchestration platform";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.paperclip;
      defaultText = lib.literalExpression "pkgs.paperclip";
      description = "The Paperclip package to use.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3100;
      description = "Port the server listens on.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0";
      description = "Address the server binds to.";
    };

    serveUi = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to serve the bundled web UI.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the server port in the firewall.";
    };

    auth.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Enable authenticated deployment mode.
        When false, uses local_trusted mode (loopback only).
      '';
    };

    publicExposure = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Expose the server publicly.
        When false, the server runs in private mode.
      '';
    };

    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/paperclip";
      description = "Base directory for Paperclip state (database, logs, storage, secrets).";
    };

    instanceId = lib.mkOption {
      type = lib.types.str;
      default = "default";
      description = "Instance identifier. Allows running multiple isolated instances.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "paperclip";
      description = "User account under which Paperclip runs.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "paperclip";
      description = "Group under which Paperclip runs.";
    };

    # Database
    database.external = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Use an external PostgreSQL database instead of the embedded one.
          When enabled, set the connection URL via `database.external.url`
          or pass `DATABASE_URL` through `environmentFiles`.
        '';
      };

      url = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = ''
          PostgreSQL connection string for external mode.
          Prefer using `environmentFiles` for this to avoid storing
          credentials in the Nix store.
        '';
      };
    };

    database.backup = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Enable automated database backups.";
      };

      intervalMinutes = lib.mkOption {
        type = lib.types.ints.between 1 10080;
        default = 60;
        description = "Minutes between automated backups.";
      };

      retentionDays = lib.mkOption {
        type = lib.types.ints.between 1 3650;
        default = 7;
        description = "Days to retain old backups.";
      };
    };

    # Storage
    storage.s3 = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Use S3 for file storage instead of local disk.";
      };

      bucket = lib.mkOption {
        type = lib.types.str;
        default = "paperclip";
        description = "S3 bucket name.";
      };

      region = lib.mkOption {
        type = lib.types.str;
        default = "us-east-1";
        description = "S3 region.";
      };

      endpoint = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Custom S3 endpoint for S3-compatible services (e.g. MinIO).";
      };

      prefix = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Key prefix for all S3 objects.";
      };

      forcePathStyle = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Use path-style S3 URLs instead of virtual-hosted-style.";
      };
    };

    # Escape hatches
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = {};
      description = "Extra environment variables passed to the server.";
    };

    environmentFiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = ''
        Paths to files containing environment variables (systemd EnvironmentFile).
        Use this for secrets like API keys or DATABASE_URL.
      '';
    };

    settings = lib.mkOption {
      type = lib.types.attrs;
      default = {};
      description = ''
        Freeform JSON attributes deep-merged into the generated config.json.
        Use this for options not covered by the typed module options.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.publicExposure || cfg.auth.enable;
        message = "services.paperclip: public exposure requires auth.enable = true.";
      }
      {
        assertion = !(!cfg.auth.enable && cfg.host != "127.0.0.1" && cfg.host != "::1" && cfg.host != "localhost");
        message = "services.paperclip: local_trusted mode (auth.enable = false) requires host to be loopback (127.0.0.1, ::1, or localhost).";
      }
    ];

    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      home = cfg.stateDir;
      description = "Paperclip service user";
    };

    users.groups.${cfg.group} = {};

    systemd.tmpfiles.rules = [
      "d ${instanceDir}/db 0750 ${cfg.user} ${cfg.group} -"
      "d ${instanceDir}/data/storage 0750 ${cfg.user} ${cfg.group} -"
      "d ${instanceDir}/data/backups 0750 ${cfg.user} ${cfg.group} -"
      "d ${instanceDir}/logs 0750 ${cfg.user} ${cfg.group} -"
      "d ${instanceDir}/secrets 0700 ${cfg.user} ${cfg.group} -"
    ];

    environment.etc."paperclip/config.json" = {
      source = configJson;
      mode = "0644";
    };

    systemd.services.paperclip = {
      description = "Paperclip AI agent orchestration platform";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      environment = {
        PAPERCLIP_HOME = cfg.stateDir;
        PAPERCLIP_INSTANCE_ID = cfg.instanceId;
        PAPERCLIP_CONFIG = "/etc/paperclip/config.json";
        PORT = toString cfg.port;
        HOST = cfg.host;
        SERVE_UI = lib.boolToString cfg.serveUi;
        PAPERCLIP_DEPLOYMENT_MODE = if cfg.auth.enable then "authenticated" else "local_trusted";
        PAPERCLIP_DEPLOYMENT_EXPOSURE = if cfg.publicExposure then "public" else "private";
        PAPERCLIP_MIGRATION_AUTO_APPLY = "true";
        PAPERCLIP_MIGRATION_PROMPT = "never";
        NODE_ENV = "production";
      } // cfg.environment;

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        ExecStart = "${cfg.package}/bin/paperclip-server";
        Restart = "on-failure";
        RestartSec = 5;

        WorkingDirectory = cfg.stateDir;
        StateDirectory = lib.removePrefix "/var/lib/" cfg.stateDir;

        EnvironmentFile = cfg.environmentFiles;

        # Hardening
        ProtectHome = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ cfg.stateDir ];
        PrivateTmp = true;
        NoNewPrivileges = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}
