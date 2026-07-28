import { resolve } from "node:path";

import type { BrowserWindowConstructorOptions } from "electron";

export const CUSTOM_TITLE_BAR_HEIGHT = 35;
export const TITLE_BAR_BACKGROUND = "#fcfcfb";
export const TITLE_BAR_FOREGROUND = "#20211f";

export const buildViewerWindowOptions = (
  platform: NodeJS.Platform,
  preloadPath: string,
  iconPath?: string,
): BrowserWindowConstructorOptions => {
  const customChrome: BrowserWindowConstructorOptions =
    platform === "darwin"
      ? {
          titleBarStyle: "hidden",
          titleBarOverlay: true,
        }
      : {
          frame: false,
          titleBarStyle: "hidden",
          titleBarOverlay: {
            color: TITLE_BAR_BACKGROUND,
            symbolColor: TITLE_BAR_FOREGROUND,
            height: CUSTOM_TITLE_BAR_HEIGHT,
          },
        };

  return {
    width: 1_440,
    height: 900,
    minWidth: 1_100,
    minHeight: 640,
    show: false,
    ...(iconPath === undefined ? {} : { icon: iconPath }),
    ...customChrome,
    webPreferences: {
      preload: resolve(preloadPath),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  };
};
