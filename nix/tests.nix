# The test suites against the packaged dependencies: `nix flake check`.
{
  stdenvNoCC,
  bun,
  python3,
  wapscii,
}:

stdenvNoCC.mkDerivation {
  pname = "wapscii-tests";
  inherit (wapscii) version src;
  nativeBuildInputs = [
    bun
    python3
  ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    ln -s ${wapscii.node_modules}/node_modules node_modules
    bun test
    python3 tools/test_maps_search_index.py
    runHook postBuild
  '';
  installPhase = "touch $out";
}
