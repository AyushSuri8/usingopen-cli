{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.usingopen;
in
{
  options.programs.usingopen = {
    enable = lib.mkEnableOption "USINGOPEN coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.usingopen.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "USINGOPEN package to install system-wide.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
