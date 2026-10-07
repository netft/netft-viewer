# Contributing

Thank you for helping improve Net F/T Viewer. Bug reports, hardware compatibility reports, documentation corrections, tests, and focused code changes are welcome.

## Before opening an issue

Search existing issues first. Use the bug, feature, or hardware compatibility form and include the operating system, architecture, application version, sensor model, firmware version when known, and concise reproduction steps. Remove private network addresses, logs that identify a private network, and other sensitive information before posting.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md) instead of the public issue tracker.

## Development environment

The reproducible development environment uses [Pixi](https://pixi.sh/) and includes Node.js 24, pnpm 11.17.0, CMake, Ninja, Clang, Python, and the native test tools:

```bash
pixi install
pixi run pnpm install --frozen-lockfile
pixi run native-configure
pixi run native-build
pixi run pnpm run start
```

You may also provide the exact tools directly. Linux packaging additionally needs `fakeroot`, `dpkg-dev`, and `patchelf`. Windows builds use the Visual Studio C++ toolchain. macOS builds require Xcode command-line tools; signing and notarization are release-maintainer concerns and are not required for local development.

## Tests

Run the checks relevant to your change while developing and the complete local gate before requesting review:

```bash
pixi run format-check
pixi run pnpm run lint
pixi run pnpm run typecheck
pixi run pnpm run test
pixi run pnpm run test:e2e
pixi run pnpm run package
```

Native changes should also pass the sanitizer build used in CI. Hardware access is never part of the ordinary test suite. Maintainers run `tools/hardware-test.sh` only with an explicitly provided `NETFT_SENSOR_HOST`; Bias needs a second deliberate opt-in and safety confirmation.

Write tests against numeric behavior, typed states, protocols, file formats, and machine-readable contracts. Do not lock README prose, full interface sentences, or other user-facing wording into tests.

## Code and design

- Keep repository content, code, comments, commit messages, and documentation in English.
- Preserve the sandboxed Electron boundary and the versioned JSON Lines companion protocol.
- Keep sensor callbacks independent from disk and renderer latency.
- Never add a laboratory or private sensor address to code, examples, tests, screenshots, logs, or commits. Public examples use ATI's documented `192.168.1.1` default.
- Do not replace the private core snapshot with a runtime download, submodule, or external package lookup.
- Add dependencies only when their ownership, version, license, packaging effect, and security implications have been reviewed.

## Pull requests

Create a focused branch, use clear commits, and complete the pull request template. Describe the user-visible effect, the tests you ran, platform-specific behavior, and any core snapshot or protocol impact. Keep generated output, local settings, recordings, and development workspaces out of the commit.

Maintainers may ask for changes when a patch broadens platform risk, weakens release or renderer security, couples tests to prose, or cannot be verified without undocumented hardware.

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).

### Current core candidate

The private snapshot uses unpublished upstream commit `91f012c5d6f9b63902765ccbec3437cb286c15e1`; `UPSTREAM` marks it `unreleased`. It is not the published v0.3.3 snapshot. Update from a clean upstream checkout using:

```sh
python tools/sync_core.py sync --source /path/to/netft-cpp --commit 91f012c5d6f9b63902765ccbec3437cb286c15e1
python tools/sync_core.py verify
```

The manifest checks the selected bytes, including provenance. It detects drift and does not authenticate a remote release. Consumer build files remain private; fixes to core source belong upstream.

### Production release acceptance

Action and native dependency references are fixed commits; changes must resolve the official upstream tag and review its diff. curl archives retain their SHA-256 check. Before a public production release, verify the `release` environment protection and tag rules in GitHub, macOS signing identity/notarization with `codesign --verify --deep --strict`, `spctl --assess --type execute`, and `xcrun stapler validate`, and Windows Authenticode identity with `Get-AuthenticodeSignature`. Unsigned artifacts may remain explicit development builds; do not describe them as signed production installers. Repository source cannot prove hosted rules, secret configuration or platform trust acceptance. Existing checksum, SBOM, draft-byte comparison and approved publishing gates remain the release path.

## Restricted-network and offline native builds

The SDK snapshot is vendored. curl, GoogleTest (tests only) and nlohmann/json are separate pinned FetchContent dependencies; a source checkout is not a complete offline build environment. Pixi/pnpm tools and Electron also require their caches or preinstalled environments.

On a connected machine, configure once with the intended build type and testing option to populate `build/native/_deps`, or provide verified source directories through `FETCHCONTENT_SOURCE_DIR_CURL`, `FETCHCONTENT_SOURCE_DIR_GOOGLETEST`, and `FETCHCONTENT_SOURCE_DIR_NLOHMANN_JSON`. Use the exact curl archive SHA and Git commits in `cmake/Dependencies.cmake`; source-directory overrides bypass FetchContent download verification, so verify them before use. A trusted mirror may supply those same bytes.

Reconfigure the populated build with `-DFETCHCONTENT_FULLY_DISCONNECTED=ON` to prohibit dependency download/update. Keep the entire source/build cache at the same location, or use the three source overrides with a fresh build directory. Missing sources fail at configuration with the missing dependency and recovery instruction. Do not treat `FETCHCONTENT_UPDATES_DISCONNECTED=ON` as fully offline: it can still download missing sources. Enabling tests additionally requires the pinned GoogleTest sources. Build with `cmake --build build/native`; for a packaging build apply the same CMake options/source overrides to its configured build directory.
