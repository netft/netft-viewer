import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildViewerWindowOptions,
  CUSTOM_TITLE_BAR_HEIGHT,
} from "../../app/main/window-options";

const preloadPath = resolve("app/preload/index.ts");
const iconPath = resolve("packaging/icons/netft-viewer.png");

describe("viewer window options", () => {
  it.each(["linux", "win32"] as const)(
    "uses a hidden title bar with native overlay controls on %s",
    (platform) => {
      const options = buildViewerWindowOptions(platform, preloadPath, iconPath);

      expect(options).toMatchObject({
        frame: false,
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#fcfcfb",
          symbolColor: "#20211f",
          height: CUSTOM_TITLE_BAR_HEIGHT,
        },
      });
    },
  );

  it("keeps the native macOS frame and traffic-light controls", () => {
    const options = buildViewerWindowOptions("darwin", preloadPath, iconPath);

    expect(options).toMatchObject({
      titleBarStyle: "hidden",
      titleBarOverlay: true,
    });
    expect(options.frame).toBeUndefined();
  });

  it("preserves dimensions, identity, and renderer hardening", () => {
    const options = buildViewerWindowOptions("linux", preloadPath, iconPath);

    expect(options).toMatchObject({
      width: 1_440,
      height: 900,
      minWidth: 1_100,
      minHeight: 640,
      show: false,
      icon: iconPath,
      webPreferences: {
        preload: preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      },
    });
  });
});
