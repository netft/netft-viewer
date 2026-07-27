# Contributing

Thank you for helping improve Net F/T Viewer. Bug reports, hardware compatibility reports, documentation corrections, tests, and focused code changes are welcome.

## Before opening an issue

Search existing issues first. Use the bug, feature, or hardware compatibility form and include the operating system, architecture, application version, sensor model, firmware version when known, and concise reproduction steps. Remove private network addresses, logs that identify a private network, and other sensitive information before posting.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md) instead of the public issue tracker.

## Development environment

The reproducible development environment uses [Pixi](https://pixi.sh/) and includes Node.js 24, pnpm 11.17.0, CMake, Ninja, Clang, Python, and the native test tools:

```bash
pixi install
pnpm install --frozen-lockfile
pixi run native-configure
pixi run native-build
pnpm run start
```

You may also provide the exact tools directly. Linux packaging additionally needs `fakeroot`, `dpkg-dev`, and `patchelf`. Windows builds use the Visual Studio C++ toolchain. macOS builds require Xcode command-line tools; signing and notarization are release-maintainer concerns and are not required for local development.

## Tests

Run the checks relevant to your change while developing and the complete local gate before requesting review:

```bash
pixi run format-check
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run test:e2e
pnpm run package
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
