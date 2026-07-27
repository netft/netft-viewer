import { resolve } from "node:path";

import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

import { removeMacCodeSignatures } from "./tools/lib/mac-signature-sanitizer.mjs";

const e2eBuild = process.env.NETFT_VIEWER_E2E_BUILD === "true";
const forgePlatform =
  process.env.NETFT_VIEWER_FORGE_PLATFORM ?? process.platform;
const forgeArchitecture =
  process.env.NETFT_VIEWER_FORGE_ARCHITECTURE ?? process.arch;
const icon = resolve("packaging/icons/netft-viewer");
const entitlements = resolve("packaging/entitlements.mac.plist");
const legalResources = [
  resolve("LICENSE"),
  resolve("THIRD_PARTY_NOTICES.md"),
  resolve("LICENSES"),
];
const macSigningIdentity = process.env.NETFT_VIEWER_MACOS_SIGN_IDENTITY;
const macSigningEnabled =
  macSigningIdentity !== undefined && macSigningIdentity.length > 0;
const notarizationEnabled = process.env.NETFT_VIEWER_MACOS_NOTARIZE === "true";

const macNotarization = () => {
  if (!notarizationEnabled) {
    return undefined;
  }
  const appleId = process.env.NETFT_VIEWER_APPLE_ID;
  const appleIdPassword = process.env.NETFT_VIEWER_APPLE_ID_PASSWORD;
  const teamId = process.env.NETFT_VIEWER_APPLE_TEAM_ID;
  if (
    !macSigningEnabled ||
    appleId === undefined ||
    appleIdPassword === undefined ||
    teamId === undefined
  ) {
    throw new Error(
      "macOS notarization requires a signing identity and Apple ID credentials",
    );
  }
  return { appleId, appleIdPassword, teamId };
};

const config = {
  ...(e2eBuild ? { outDir: resolve("out/e2e") } : {}),
  packagerConfig: {
    asar: true,
    appBundleId: "org.netft.viewer",
    appCategoryType: "public.app-category.utilities",
    executableName: "netft-viewer",
    icon,
    afterExtract: [
      (
        buildPath: string,
        _electronVersion: string,
        platform: string,
        _architecture: string,
        callback: (error?: Error | null) => void,
      ) => {
        removeMacCodeSignatures(buildPath, platform).then(
          () => callback(),
          (error: unknown) =>
            callback(
              error instanceof Error
                ? error
                : new Error("failed to remove macOS code signatures"),
            ),
        );
      },
    ],
    osxUniversal: {
      mergeASARs: true,
    },
    ...(macSigningEnabled
      ? {
          osxSign: {
            identity: macSigningIdentity,
            hardenedRuntime: true,
            entitlements,
          },
        }
      : {}),
    ...(notarizationEnabled ? { osxNotarize: macNotarization() } : {}),
    ...(e2eBuild
      ? {
          extraResource: ["test/support/fake-companion.mjs", ...legalResources],
        }
      : {
          extraResource: [
            resolve(
              "build",
              "packaging",
              "companion",
              `${forgePlatform}-${forgeArchitecture}`,
              "companion",
            ),
            ...legalResources,
          ],
        }),
  },
  makers: [
    new MakerDeb({
      options: {
        name: "netft-viewer",
        productName: "Net F/T Viewer",
        genericName: "Force and Torque Sensor Viewer",
        description: "Desktop viewer for ATI Net F/T sensors.",
        section: "science",
        priority: "optional",
        maintainer: "Net F/T contributors",
        homepage: "https://github.com/netft/netft-viewer",
        icon: resolve("packaging/icons/netft-viewer.png"),
        categories: ["Science", "Utility"],
      },
    }),
    new MakerSquirrel({
      name: "netft_viewer",
      authors: "Net F/T contributors",
      description: "Desktop viewer for ATI Net F/T sensors.",
      exe: "netft-viewer.exe",
      noMsi: true,
      setupExe: "NetFTViewerSetup.exe",
      setupIcon: resolve("packaging/icons/netft-viewer.ico"),
    }),
    new MakerDMG({
      name: "Net F-T Viewer",
      icon: resolve("packaging/icons/netft-viewer.icns"),
      format: "ULFO",
    }),
    new MakerZIP({}, ["darwin", "win32"]),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "app/main/main.ts",
          config: "vite.main.config.ts",
        },
        {
          entry: "app/preload/index.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: e2eBuild,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: false,
    }),
  ],
};

export default config;
