# OddsJam Sandbox OMP Roadmap

## Completed

- [x] OMP 18 runtime/type/UI import port.
- [x] Hidden legacy runtime import removed.
- [x] Public no-token install: `omp plugin install github:luluthehungrycat/omp-pi-sandbox-oddsjam#v0.1.1`.
- [x] GitHub Packages publication: `@luluthehungrycat/omp-pi-sandbox-oddsjam@0.1.1`.
- [x] 157/157 unit tests and Bun typecheck.
- [x] Bun CI, public Git smoke CI, and release verification.
- [x] Podman containment gate.

## Next

- [ ] Run the shared OMP/Bun compatibility matrix on every supported release.
- [ ] Add package-loaded sandbox tool-call runtime coverage to the shared release gate.
- [ ] Keep the upstream `@anthropic-ai/sandbox-runtime` dependency and trusted-install policy under review.

## Release gate

No release is complete unless public Git install, package install, `omp plugin doctor`, and the containment probe pass.
