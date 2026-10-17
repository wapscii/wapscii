{
  description = "wapscii: the whole world in your console (MapSCII, maintained)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        wapscii = pkgs.callPackage ./nix/package.nix { };
        default = wapscii;
      });

      # pkgs.wapscii, built with this flake's nixpkgs: its npm packages are
      # checked against a hash that depends on the bun that installs them
      overlays.default = final: prev: {
        wapscii = self.packages.${final.stdenv.hostPlatform.system}.default;
      };

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
      });

      checks = forAllSystems (pkgs: {
        build = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        tests = pkgs.callPackage ./nix/tests.nix {
          wapscii = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs
            python3
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
