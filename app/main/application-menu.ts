import type { MenuItemConstructorOptions } from "electron";

import {
  buildDesktopMenuModel,
  type DesktopMenuItem,
} from "../shared/desktop-menu-model";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import {
  MenuStateSchema,
  type MenuCommand,
  type MenuState,
} from "../shared/menu-contract";
import type { WindowCommand } from "../shared/window-command";

export type { MenuCommand, MenuState } from "../shared/menu-contract";

export const DEFAULT_MENU_STATE: MenuState = {
  backendRunning: false,
  connection: "disconnected",
  connectionPending: false,
  actionPending: false,
  paused: false,
  recordingActive: false,
  hasSensorHost: false,
  plotMode: "combined",
  timeWindowSeconds: 10,
  visibleAxes: ["Fx", "Fy", "Fz", "Tx", "Ty", "Tz"],
};

export interface ApplicationMenuTemplateOptions {
  performWindowCommand: (command: WindowCommand) => unknown;
  platform: NodeJS.Platform;
  sendCommand: (command: MenuCommand) => void;
  state: MenuState;
}

interface MenuFrame {
  readonly url: string;
}

interface MenuWebContents {
  readonly mainFrame: MenuFrame;
  isDestroyed?(): boolean;
  send(channel: string, command: MenuCommand): void;
}

interface MenuIpcEvent {
  readonly sender: MenuWebContents;
  readonly senderFrame: MenuFrame | null;
}

type MenuStateListener = (event: MenuIpcEvent, value: unknown) => void;

export interface ApplicationMenuIpcMain {
  on(channel: string, listener: MenuStateListener): void;
  removeListener(channel: string, listener: MenuStateListener): void;
}

export interface ApplicationMenuRuntime<MenuType> {
  buildFromTemplate(template: MenuItemConstructorOptions[]): MenuType;
  setApplicationMenu(menu: MenuType | null): void;
}

export interface InstallApplicationMenuOptions<MenuType> {
  ipcMain: ApplicationMenuIpcMain;
  menu: ApplicationMenuRuntime<MenuType>;
  performWindowCommand: (command: WindowCommand) => unknown;
  platform: NodeJS.Platform;
  trustedWebContents: MenuWebContents;
}

const nativeItem = (
  item: DesktopMenuItem,
  sendCommand: (command: MenuCommand) => void,
  performWindowCommand: (command: WindowCommand) => unknown,
): MenuItemConstructorOptions => {
  switch (item.kind) {
    case "separator":
      return { id: item.id, type: "separator" };
    case "submenu":
      return {
        id: item.id,
        label: item.label,
        submenu: item.items.map((child) =>
          nativeItem(child, sendCommand, performWindowCommand),
        ),
      };
    case "command":
      return {
        accelerator: item.accelerator,
        checked: item.checked,
        click: () => sendCommand(item.command),
        enabled: item.enabled,
        id: item.id,
        label: item.label,
        type: item.selection,
      };
    case "window":
      return {
        accelerator: item.accelerator,
        click: () => void performWindowCommand(item.command),
        enabled: item.enabled,
        id: item.id,
        label: item.label,
      };
  }
};

export const buildApplicationMenuTemplate = ({
  performWindowCommand,
  platform,
  sendCommand,
  state,
}: ApplicationMenuTemplateOptions): MenuItemConstructorOptions[] => {
  const menus = buildDesktopMenuModel(state, platform).map((menu) => {
    let submenu = menu.items.map((item) =>
      nativeItem(item, sendCommand, performWindowCommand),
    );
    if (platform === "darwin" && menu.id === "file") {
      submenu = [{ role: "close" }];
    }
    if (platform === "darwin" && menu.id === "view") {
      submenu = [
        ...submenu,
        { type: "separator" },
        { role: "togglefullscreen" },
      ];
    }
    return {
      label: platform === "darwin" ? menu.label : `&${menu.label}`,
      submenu,
    } satisfies MenuItemConstructorOptions;
  });

  if (platform !== "darwin") {
    return menus;
  }

  return [
    {
      label: "Net F/T Viewer",
      submenu: [
        {
          click: () =>
            void performWindowCommand({
              type: "open-external",
              target: "organization",
            }),
          id: "about-netft",
          label: "About Net F/T",
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    ...menus,
    { role: "windowMenu" },
  ];
};

export const installApplicationMenu = <MenuType>({
  ipcMain,
  menu,
  performWindowCommand,
  platform,
  trustedWebContents,
}: InstallApplicationMenuOptions<MenuType>): (() => void) => {
  if (platform !== "darwin") {
    menu.setApplicationMenu(null);
    return () => {};
  }

  let state = DEFAULT_MENU_STATE;
  let serializedState = JSON.stringify(state);

  const sendCommand = (command: MenuCommand): void => {
    if (trustedWebContents.isDestroyed?.() === true) {
      return;
    }
    trustedWebContents.send(IPC_CHANNELS.menuCommand, command);
  };
  const rebuild = (): void => {
    menu.setApplicationMenu(
      menu.buildFromTemplate(
        buildApplicationMenuTemplate({
          performWindowCommand,
          platform,
          sendCommand,
          state,
        }),
      ),
    );
  };
  const receiveState: MenuStateListener = (event, value) => {
    if (
      event.sender !== trustedWebContents ||
      event.senderFrame === null ||
      event.senderFrame !== trustedWebContents.mainFrame ||
      trustedWebContents.isDestroyed?.() === true
    ) {
      return;
    }
    const parsed = MenuStateSchema.safeParse(value);
    if (!parsed.success) {
      return;
    }
    const nextSerializedState = JSON.stringify(parsed.data);
    if (nextSerializedState === serializedState) {
      return;
    }
    state = parsed.data;
    serializedState = nextSerializedState;
    rebuild();
  };

  rebuild();
  ipcMain.on(IPC_CHANNELS.menuState, receiveState);
  let cleaned = false;
  return () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    ipcMain.removeListener(IPC_CHANNELS.menuState, receiveState);
  };
};
