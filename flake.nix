{
  description = "scheduling-kit dev shell and lightweight docs/release checks";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
    in
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        docsPython = pkgs.python313.withPackages (ps: [
          ps.mkdocs
          ps.mkdocs-material
          ps.pymdown-extensions
        ]);

        bazelWrapper = pkgs.writeShellApplication {
          name = "bazel";
          runtimeInputs = [
            pkgs.bazelisk
            pkgs.jdk21_headless
          ];
          text = ''
            exec bazelisk "$@"
          '';
        };

        docsSite = pkgs.stdenvNoCC.mkDerivation {
          pname = "scheduling-kit-docs";
          version = packageJson.version;
          src = ./.;
          nativeBuildInputs = [
            pkgs.nodejs_22
            docsPython
          ];
          dontConfigure = true;
          buildPhase = ''
            runHook preBuild
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"
            cp -r "$src" source
            chmod -R u+w source
            cd source
            node scripts/generate-doc-artifacts.mjs
            mkdocs build --strict
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp -r site/* "$out"/
            runHook postInstall
          '';
        };

        releaseMetadataCheck = pkgs.runCommand "scheduling-kit-release-metadata-${packageJson.version}" {
          nativeBuildInputs = [ pkgs.nodejs_22 ];
          src = ./.;
        } ''
          cp -r "$src" source
          chmod -R u+w source
          cd source
          node scripts/check-release-metadata.mjs
          touch "$out"
        '';
      in
      {
        packages.docs = docsSite;

        checks.docs = docsSite;
        checks.release-metadata = releaseMetadataCheck;

        # Remote-only database proof used by the GF integration lane. Keeping
        # PostgreSQL in the locked flake avoids a hosted service-container path.
        # util-linux supplies setpriv: GF runner pods run jobs as root, and
        # initdb/postgres refuse to start as root, so CI drops to an
        # unprivileged uid for the database processes.
        devShells.ci-postgres = pkgs.mkShellNoCC {
          packages = [ pkgs.postgresql_16 ]
            ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.util-linux ];
        };

        devShells.default = pkgs.mkShellNoCC {
          packages = with pkgs; [
            actionlint
            bazelWrapper
            docsPython
            jdk21_headless
            just
            nodejs_22
            pnpm
            typescript
            typescript-language-server
          ];

          shellHook = ''
            echo "scheduling-kit dev shell"
            echo "Node: $(node --version)"
            echo "pnpm: $(pnpm --version)"
            echo "bazel: nixpkgs bazelisk wrapper using .bazelversion $(cat .bazelversion)"
            echo "mkdocs: $(mkdocs --version | cut -d',' -f1)"
          '';
        };
      }
    );
}
