{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.paperclip;
  instanceDir = "${cfg.stateDir}/instances/${cfg.instanceId}";
  storeDir = builtins.storeDir;

  isAbsolutePath = path: lib.hasPrefix "/" path;
  isStorePath = path: path == storeDir || lib.hasPrefix "${storeDir}/" path;
  isNormalizedAbsolutePath =
    path:
    isAbsolutePath path
    && path != "/"
    && !lib.hasSuffix "/" path
    && !lib.hasInfix "//" path
    && lib.all (segment: segment != "." && segment != "..") (lib.splitString "/" path);
  isMutablePath = path: isNormalizedAbsolutePath path && !isStorePath path;

  configJson = pkgs.writeText "paperclip-config.json" (
    builtins.toJSON {
      "$meta" = {
        version = 1;
        updatedAt = "1970-01-01T00:00:00.000Z";
        source = "nixos-module";
      };
      server = {
        deploymentMode = if cfg.auth.enable then "authenticated" else "local_trusted";
        exposure = if cfg.publicExposure then "public" else "private";
        host = cfg.host;
        port = cfg.port;
        allowedHostnames = cfg.allowedHostnames;
        serveUi = cfg.serveUi;
      };
      auth = {
        baseUrlMode = if cfg.auth.publicBaseUrl == null then "auto" else "explicit";
        disableSignUp = cfg.auth.disableSignUp;
      }
      // lib.optionalAttrs (cfg.auth.publicBaseUrl != null) {
        inherit (cfg.auth) publicBaseUrl;
      };
      database = {
        mode = if cfg.database.external.enable then "postgres" else "embedded-postgres";
        embeddedPostgresDataDir = "${instanceDir}/db";
        embeddedPostgresPort = cfg.database.embeddedPort;
        backup = {
          enabled = cfg.database.backup.enable;
          intervalMinutes = cfg.database.backup.intervalMinutes;
          retentionDays = cfg.database.backup.retentionDays;
          dir = "${instanceDir}/data/backups";
        };
      };
      storage = {
        provider = if cfg.storage.s3.enable then "s3" else "local_disk";
        localDisk.baseDir = "${instanceDir}/data/storage";
        s3 = {
          inherit (cfg.storage.s3)
            bucket
            region
            prefix
            forcePathStyle
            ;
        }
        // lib.optionalAttrs (cfg.storage.s3.endpoint != null) {
          inherit (cfg.storage.s3) endpoint;
        };
      };
      logging = {
        mode = "file";
        logDir = "${instanceDir}/logs";
      };
      secrets = {
        provider = "local_encrypted";
        strictMode = cfg.secrets.strictMode;
        localEncrypted.keyFilePath = "${instanceDir}/secrets/master.key";
      };
      telemetry.enabled = cfg.telemetry.enable;
    }
  );
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

    autoStart = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Start Paperclip automatically during boot.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3100;
      description = "Port on which the server listens.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address to which the server binds.";
    };

    allowedHostnames = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Additional hostnames accepted by Paperclip's host validation.";
    };

    serveUi = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to serve the bundled web UI.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the server port in the NixOS firewall.";
    };

    auth = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Use authenticated deployment mode instead of local_trusted mode.";
      };

      publicBaseUrl = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "https://paperclip.example.com";
        description = "Canonical browser-facing URL used by authenticated deployments.";
      };

      disableSignUp = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Disable new user sign-up after the instance has been claimed.";
      };
    };

    publicExposure = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Declare an authenticated deployment as internet-facing. Enable this
        for public endpoints so Paperclip applies its stricter public exposure
        policy; leave it disabled only for private LAN, VPN, or tailnet access.
        Public exposure requires an external PostgreSQL database.
      '';
    };

    stateDir = lib.mkOption {
      type = lib.types.strMatching "^/[^[:space:]]*$";
      default = "/var/lib/paperclip";
      description = "Base directory for Paperclip database, logs, storage, and runtime secrets.";
    };

    instanceId = lib.mkOption {
      type = lib.types.strMatching "^[A-Za-z0-9][A-Za-z0-9_-]*$";
      default = "default";
      description = "Identifier for this isolated Paperclip instance.";
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

    createUser = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Create the configured service user and group.";
    };

    environmentFiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/run/secrets/paperclip.env" ];
      description = ''
        Runtime-only systemd EnvironmentFile paths. Put DATABASE_URL,
        BETTER_AUTH_SECRET, API keys, and other secret values here. Store paths
        are rejected so secret material cannot be copied into /nix/store.
      '';
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Additional executables made available to Paperclip and its local agents.";
    };

    readWritePaths = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/srv/paperclip-workspaces" ];
      description = "Additional absolute paths that Paperclip and local agents may modify.";
    };

    database = {
      external.enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Use external PostgreSQL. Supply DATABASE_URL, and optionally
          DATABASE_MIGRATION_URL, through environmentFiles.
        '';
      };

      embeddedPort = lib.mkOption {
        type = lib.types.port;
        default = 54329;
        description = "Port used by the embedded PostgreSQL server.";
      };

      backup = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable automatic logical database backups.";
        };

        intervalMinutes = lib.mkOption {
          type = lib.types.ints.between 1 10080;
          default = 60;
          description = "Minutes between automatic database backups.";
        };

        retentionDays = lib.mkOption {
          type = lib.types.ints.between 1 3650;
          default = 7;
          description = "Days for which automatic backups are retained.";
        };
      };
    };

    storage.s3 = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Use S3-compatible object storage instead of local disk.";
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
        description = "Custom endpoint for an S3-compatible service.";
      };

      prefix = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Key prefix for objects stored by Paperclip.";
      };

      forcePathStyle = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Use path-style S3 URLs.";
      };
    };

    secrets.strictMode = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Require Paperclip-managed secret references for sensitive agent environment values.";
    };

    telemetry.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable Paperclip telemetry.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.publicExposure || cfg.auth.enable;
        message = "services.paperclip: publicExposure requires auth.enable = true.";
      }
      {
        assertion = !cfg.publicExposure || cfg.auth.publicBaseUrl != null;
        message = "services.paperclip: publicExposure requires auth.publicBaseUrl.";
      }
      {
        assertion = !cfg.publicExposure || cfg.database.external.enable;
        message = "services.paperclip: publicExposure requires database.external.enable = true and DATABASE_URL.";
      }
      {
        assertion =
          cfg.auth.enable
          || lib.elem (lib.toLower cfg.host) [
            "127.0.0.1"
            "::1"
            "localhost"
          ];
        message = "services.paperclip: local_trusted mode requires a loopback host.";
      }
      {
        assertion = !cfg.auth.enable || cfg.environmentFiles != [ ];
        message = "services.paperclip: authenticated mode requires a runtime environmentFiles entry for BETTER_AUTH_SECRET.";
      }
      {
        assertion = !cfg.database.external.enable || cfg.environmentFiles != [ ];
        message = "services.paperclip: external PostgreSQL requires DATABASE_URL in a runtime environmentFiles entry.";
      }
      {
        assertion = lib.all isNormalizedAbsolutePath cfg.environmentFiles;
        message = "services.paperclip: every environmentFiles entry must be a normalized absolute runtime file path.";
      }
      {
        assertion = lib.all (path: !isStorePath path) cfg.environmentFiles;
        message = "services.paperclip: environmentFiles must not refer to /nix/store; provision secrets at runtime instead.";
      }
      {
        assertion = isMutablePath cfg.stateDir;
        message = "services.paperclip: stateDir must be a normalized mutable path outside /nix/store and must not be /.";
      }
      {
        assertion = lib.all isMutablePath cfg.readWritePaths;
        message = "services.paperclip: every readWritePaths entry must be a normalized mutable path outside /nix/store and must not be /.";
      }
    ];

    users.users = lib.mkIf cfg.createUser {
      ${cfg.user} = {
        isSystemUser = true;
        group = cfg.group;
        home = cfg.stateDir;
        createHome = false;
        description = "Paperclip service user";
      };
    };

    users.groups = lib.mkIf cfg.createUser {
      ${cfg.group} = { };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.stateDir} 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/instances 0750 ${cfg.user} ${cfg.group} -"
      "d ${instanceDir} 0750 ${cfg.user} ${cfg.group} -"
      "d ${instanceDir}/db 0750 ${cfg.user} ${cfg.group} -"
      "d ${instanceDir}/data 0750 ${cfg.user} ${cfg.group} -"
      "d ${instanceDir}/data/storage 0750 ${cfg.user} ${cfg.group} -"
      "d ${instanceDir}/data/backups 0750 ${cfg.user} ${cfg.group} -"
      "d ${instanceDir}/logs 0750 ${cfg.user} ${cfg.group} -"
      "d ${instanceDir}/secrets 0700 ${cfg.user} ${cfg.group} -"
    ];

    environment.etc."paperclip/config.json" = {
      source = configJson;
      mode = "0444";
    };

    systemd.services.paperclip = {
      description = "Paperclip AI agent orchestration platform";
      wantedBy = lib.optionals cfg.autoStart [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      path = cfg.extraPackages;

      environment = {
        # The package wrapper provides safe loopback defaults for direct use,
        # while Paperclip gives environment variables precedence over its JSON
        # config. Export the module options explicitly so non-default bind
        # addresses and ports cannot be shadowed by those wrapper defaults.
        HOST = cfg.host;
        PORT = toString cfg.port;
        SERVE_UI = if cfg.serveUi then "true" else "false";
        PAPERCLIP_HOME = cfg.stateDir;
        PAPERCLIP_INSTANCE_ID = cfg.instanceId;
        PAPERCLIP_CONFIG = "/etc/paperclip/config.json";
        PAPERCLIP_MIGRATION_AUTO_APPLY = "true";
        PAPERCLIP_MIGRATION_PROMPT = "never";
        NODE_ENV = "production";
      };

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        ExecStart = "${cfg.package}/bin/paperclip-server";
        Restart = "on-failure";
        RestartSec = 5;
        UMask = "0077";

        WorkingDirectory = "${cfg.package}/lib/paperclip";
        EnvironmentFile = cfg.environmentFiles;

        ProtectHome = "read-only";
        ProtectSystem = "strict";
        ReadWritePaths = [ cfg.stateDir ] ++ cfg.readWritePaths;
        PrivateTmp = true;
        NoNewPrivileges = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        LockPersonality = true;
        RestrictSUIDSGID = true;
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}
