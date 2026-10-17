# wapscii for Nix: `nix build`, `nix run`, or the flake's package/overlay.
#
# The npm packages come from bun.lock, installed by bun in a fixed-output
# derivation: the one step allowed to download, checked against
# `nodeModulesHash`. When bun.lock changes (or nixpkgs' bun does), that
# hash changes: `nix build` stops with "hash mismatch ... got: sha256-...";
# put the "got" one here. CI (the nix job) does that check on every push.
{
  lib,
  stdenvNoCC,
  bun,
  nodejs,
  python3,
  makeWrapper,
  nodeModulesHash ? "sha256-AdUpKkvWjX2Q2uocC4GD7lEO9fqMdv1VcTp0c0Tv2Hc=",
}:

let
  packageJson = lib.importJSON ../package.json;
  inherit (packageJson) version;

  # Only what the build needs, so that editing docs doesn't rebuild it
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../bun.lock
      ../tsconfig.json
      ../main.ts
      ../index.ts
      ../src
      ../styles
      ../bin
      ../tools
      ../LICENSE
    ];
  };

  # Runtime dependencies only (no TypeScript, ESLint...), without their
  # install scripts.
  node_modules = stdenvNoCC.mkDerivation {
    pname = "wapscii-node-modules";
    inherit version;
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [ ../package.json ../bun.lock ];
    };
    nativeBuildInputs = [ bun ];
    # for networks that need a proxy
    impureEnvVars = lib.fetchers.proxyImpureEnvVars;
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      bun install --frozen-lockfile --production --ignore-scripts --no-progress --backend=copyfile
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R node_modules $out/
      runHook postInstall
    '';
    # nothing may change what bun wrote: the hash is of exactly that
    dontFixup = true;
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = nodeModulesHash;
  };
in
stdenvNoCC.mkDerivation {
  pname = "wapscii";
  inherit version src;

  nativeBuildInputs = [
    bun
    makeWrapper
  ];

  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    ln -s ${node_modules}/node_modules node_modules
    bun build main.ts index.ts --outdir dist --target node --packages external
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    dest=$out/lib/wapscii
    mkdir -p $dest $out/bin
    cp -R dist styles tools bin package.json LICENSE $dest/
    ln -s ${node_modules}/node_modules $dest/node_modules

    # the map; Python (with SQLite's FTS5) reads the offline search index
    makeWrapper ${lib.getExe nodejs} $out/bin/mapscii \
      --add-flags $dest/bin/mapscii.js \
      --set-default MAPSCII_PYTHON ${lib.getExe python3}
    ln -s mapscii $out/bin/wapscii
    # builds that index (docs/search.md)
    makeWrapper ${lib.getExe python3} $out/bin/wapscii-search-index \
      --add-flags $dest/tools/maps-search-index
    runHook postInstall
  '';

  passthru = {
    inherit node_modules;
  };

  meta = {
    description = "The whole world in your console: a Braille and ASCII map of OpenStreetMap vector tiles (MapSCII, maintained)";
    homepage = "https://github.com/wapscii/wapscii";
    license = lib.licenses.mit;
    mainProgram = "mapscii";
    platforms = lib.platforms.unix;
  };
}
