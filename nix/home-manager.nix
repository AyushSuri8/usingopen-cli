{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.usingopen;
  yaml = pkgs.formats.yaml { };
  configFile = yaml.generate "usingopen-config.yml" cfg.settings;
in
{
  options.programs.usingopen = {
    enable = lib.mkEnableOption "USINGOPEN coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.usingopen.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "USINGOPEN package to install.";
    };

    settings = lib.mkOption {
      type = lib.types.nullOr yaml.type;
      default = null;
      description = ''
        Settings written declaratively to {file}`~/.usingopen/agent/config.yml`.
        On each `home-manager switch` the declared settings are copied into
        place as a writable regular file (not a read-only store symlink), so
        USINGOPEN can acquire its config lock and rewrite the file when persisting
        runtime changes (`/settings`, onboarding). Those runtime changes are
        overwritten by the declared values again on the next
        `home-manager switch`.
      '';
      example = {
        theme.dark = "titanium";
        startup.quiet = true;
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # USINGOPEN rewrites its config at runtime and acquires an advisory lock on it
    # first; on macOS the lock backend creates an flock sidecar next to the
    # target file. A `home.file` store symlink is read-only and lives under
    # /nix/store, so both the lock and the atomic rewrite fail with EACCES and
    # break every launch. Copy a writable regular file instead. The DAG entry
    # is written literally (rather than via `lib.hm.dag.entryAfter`) so the
    # home-manager-free module evaluation in `flake.nix` keeps working.
    home.activation.usingopenConfig = lib.mkIf (cfg.settings != null) {
      before = [ ];
      after = [ "writeBoundary" ];
      data = ''
        run mkdir -p "$HOME/.usingopen/agent"
        run install -m 600 ${configFile} "$HOME/.usingopen/agent/config.yml"
      '';
    };
  };
}
