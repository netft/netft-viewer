# Third-Party Notices

Net F/T Viewer is licensed under Apache-2.0. Its distributed application includes or links the following third-party components. Versions are the versions pinned by the `0.1.0` source and lockfiles.

| Component | Version | License | Use |
| --- | --- | --- | --- |
| netft-cpp core snapshot | commit `e424c401587052f03de9b94f76f1e86b78902105` | Apache-2.0 | Native sensor discovery and streaming |
| curl | 8.21.0 | curl license | Statically linked HTTP client |
| nlohmann/json | 3.12.0 | MIT | Native companion protocol |
| Electron | 43.2.0 | MIT | Desktop runtime |
| React and React DOM | 19.2.8 | MIT | Renderer |
| Scheduler | 0.27.0 | MIT | React runtime dependency |
| Apache ECharts | 6.1.0 | Apache-2.0 | Charts |
| zrender | 6.1.0 | BSD-3-Clause | ECharts rendering |
| Zod | 4.4.3 | MIT | Runtime protocol validation |
| tslib | 2.3.0 | 0BSD | TypeScript runtime helpers |

The netft-cpp snapshot provenance and local overlay are documented in [CORE_SNAPSHOT.md](CORE_SNAPSHOT.md). Its Apache-2.0 terms are the repository [LICENSE](LICENSE).

The following exact license and notice texts are stored in `LICENSES/` and copied into every installed application's resources:

- [curl](LICENSES/curl.txt)
- [nlohmann/json](LICENSES/nlohmann-json.txt)
- [Electron](LICENSES/electron.txt)
- [React and React DOM](LICENSES/react.txt)
- [Scheduler](LICENSES/scheduler.txt)
- [Apache ECharts](LICENSES/echarts.txt) and its [NOTICE](LICENSES/echarts-notice.txt)
- [zrender](LICENSES/zrender.txt)
- [Zod](LICENSES/zod.txt)
- [tslib](LICENSES/tslib.txt)

Electron also ships its upstream `LICENSE` and `LICENSES.chromium.html` beside the application resources for Chromium and its bundled components.

GoogleTest 1.17.0 is used only to build native tests and is not included in release artifacts. Playwright, Vitest, TypeScript, Vite, Electron Forge, and the remaining development packages are build and test tools rather than distributed application dependencies; their licenses remain recorded in `pnpm-lock.yaml` and their upstream packages.
