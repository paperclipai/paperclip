{
  nixpkgsPath,
  homeManagerPath,
  system ? builtins.currentSystem,
}:
let
  pkgs = import nixpkgsPath { inherit system; };
  inherit (pkgs) lib;
  hm = import (homeManagerPath + "/lib") { inherit lib; };
  manifest = {
    version = 1;
    owner = "personal";
    companies.example.fields = {
      name = "Example company";
      description = null;
      budgetMonthlyCents = 1000;
    };
    agents.hermes = {
      company = "example";
      fields = {
        name = "Hermes";
        adapterType = "hermes_gateway";
      };
      credentials.apiKey = "gateway";
    };
  };
  home =
    extra:
    hm.homeManagerConfiguration {
      inherit pkgs;
      modules = [
        ../modules/home-manager/paperclip.nix
        {
          home.username = "operator";
          home.homeDirectory = "/home/operator";
          home.stateVersion = "26.05";
          programs.paperclip.deployments.work = manifest;
        }
        extra
      ];
    };
  machine =
    extra:
    import (nixpkgsPath + "/nixos/lib/eval-config.nix") {
      inherit system;
      modules = [
        (homeManagerPath + "/nixos")
        ../modules/nixos/home-manager.nix
        {
          system.stateVersion = "26.05";
          boot.isContainer = true;
          users.users.operator.isNormalUser = true;
          home-manager.users.operator = {
            home.stateVersion = "26.05";
            programs.paperclip.deployments.work = manifest;
          };
          services.paperclip.homeManager.deployments.work = {
            user = "operator";
            deployment = "work";
          };
        }
        extra
      ];
    };
  assertionsPass = c: lib.all (a: a.assertion) c.assertions;
  evaluates = value: (builtins.tryEval (builtins.deepSeq value true)).success;
  # Synthetic packages exercise metadata only; none proves CLI runtime support.
  clientPackage = pkgs.runCommand "paperclip-client-evaluation-fixture" { } ''
    mkdir -p "$out"
  '';
  clientPackages = {
    supported = clientPackage // { supportsPaperclipApiKeyFile = true; };
    unsupported = clientPackage // { supportsPaperclipApiKeyFile = false; };
    absent = clientPackage;
    stringMarker = clientPackage // { supportsPaperclipApiKeyFile = "true"; };
    pathString = builtins.toString clientPackage;
  };
  credentialClient =
    package:
    home {
      programs.paperclip = {
        enable = true;
        inherit package;
        apiUrl = "https://paperclip.example.org";
        companyId = "example-company";
        apiKeyFile = "/run/credentials/paperclip/api-key";
      };
    };
  personal = (home { }).config;
  integrated = (machine { }).config;
  extended =
    (machine {
      services.paperclip.instances.work.manifest.companies.extra.fields.name = "Other";
    }).config;
  overridden =
    (machine {
      services.paperclip.instances.work.manifest = lib.mkForce (manifest // { owner = "other"; });
    }).config;
  missing =
    (machine {
      services.paperclip.homeManager.deployments.work.deployment = lib.mkForce "missing";
    }).config;
  missingUser =
    (machine {
      services.paperclip.homeManager.deployments.work.user = lib.mkForce "missing";
    }).config;
  independent =
    (machine {
      services.paperclip.homeManager.deployments = lib.mkForce { };
      services.paperclip.instances.system.manifest = manifest;
    }).config;
  results = {
    standaloneHome = assertionsPass personal;
    standaloneActivation = evaluates (home { }).activationPackage.drvPath;
    enabledClient =
      evaluates (credentialClient clientPackages.supported).activationPackage.drvPath;
    unsupportedClientRejected =
      !(evaluates (credentialClient clientPackages.unsupported).activationPackage.drvPath);
    absentCapabilityRejected =
      !(evaluates (credentialClient clientPackages.absent).activationPackage.drvPath);
    stringCapabilityRejected =
      !(evaluates (credentialClient clientPackages.stringMarker).activationPackage.drvPath);
    pathStringClientRejected =
      !(evaluates (credentialClient clientPackages.pathString).activationPackage.drvPath);
    enabledWithoutCredentialAccepted =
      evaluates
        (home {
          programs.paperclip = {
            enable = true;
            package = clientPackages.absent;
          };
        }).activationPackage.drvPath;
    disabledWithCredentialAccepted =
      evaluates
        (home {
          programs.paperclip = {
            enable = false;
            package = clientPackages.absent;
            apiKeyFile = "/run/credentials/paperclip/api-key";
          };
        }).activationPackage.drvPath;
    manifestRoundTrip =
      builtins.fromJSON personal.xdg.configFile."paperclip/deployments/work.json".text == manifest;
    noPersonalService = !(personal.systemd.user.services ? paperclip-work);
    invalidKeyRejected =
      !(evaluates
        (home {
          programs.paperclip.deployments."../escape" = manifest;
        }).activationPackage.drvPath
      );
    storeCredentialRejected =
      !(evaluates
        (home {
          programs.paperclip.apiKeyFile = "${builtins.storeDir}/not-a-runtime-key";
        }).activationPackage.drvPath
      );
    runtimeCredentialAccepted =
      assertionsPass
        (home {
          programs.paperclip.apiKeyFile = "/run/credentials/paperclip/api-key";
        }).config;
    integratedHome = assertionsPass integrated;
    exactSelection = integrated.services.paperclip.instances.work.manifest == manifest;
    controllerRemainsDisabled = !integrated.services.paperclip.instances.work.enable;
    extensionRejected = !(assertionsPass extended);
    overrideRejected = !(assertionsPass overridden);
    missingDeclarationRejected = !(evaluates missing.services.paperclip.instances.work.manifest);
    missingUserRejected = !(evaluates missingUser.services.paperclip.instances.work.manifest);
    directSystemDeclaration =
      assertionsPass independent && independent.services.paperclip.instances.system.manifest == manifest;
  };
in
assert lib.assertMsg (lib.all (v: v) (builtins.attrValues results)) (builtins.toJSON results);
results
