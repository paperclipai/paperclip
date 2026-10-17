{
  config,
  lib,
  ...
}:
let
  selections = config.services.paperclip.homeManager.deployments;
  selected =
    instance: selection:
    let
      declaration = lib.attrByPath [
        selection.user
        "programs"
        "paperclip"
        "deployments"
        selection.deployment
      ] null config.home-manager.users;
    in
    assert lib.assertMsg (
      declaration != null
    ) "Paperclip ${instance}: selected Home Manager deployment does not exist";
    declaration;
in
{
  # Import alongside the NixOS Home Manager integration and Paperclip service module.
  options.services.paperclip.homeManager.deployments = lib.mkOption {
    default = { };
    description = ''
      Explicit per-instance selection of a trusted person's nonsecret manifest.
      Each controller retains one declaration owner and one reconciler. This
      selection grants neither application membership nor Unix account access.
    '';
    type = lib.types.attrsOf (
      lib.types.submodule {
        options = {
          user = lib.mkOption {
            type = lib.types.str;
            description = "Home Manager user owning the declaration.";
          };
          deployment = lib.mkOption {
            type = lib.types.strMatching "[a-z][a-z0-9_-]{0,62}";
            description = "Key in that user's programs.paperclip.deployments.";
          };
        };
      }
    );
  };

  config = {
    home-manager.sharedModules = [ ../home-manager/paperclip.nix ];
    services.paperclip.instances = lib.mapAttrs (instance: selection: {
      manifest = selected instance selection;
    }) selections;
    assertions = lib.mapAttrsToList (instance: selection: {
      assertion = config.services.paperclip.instances.${instance}.manifest == selected instance selection;
      message = "Paperclip ${instance}: a selected Home Manager manifest must not be extended or overridden by the host";
    }) selections;
  };
}
