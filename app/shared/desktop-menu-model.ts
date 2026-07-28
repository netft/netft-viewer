import {
  MENU_AXES,
  MENU_TIME_WINDOWS,
  type MenuCommand,
  type MenuState,
} from "./menu-contract";
import type { WindowCommand } from "./window-command";

interface DesktopMenuItemBase {
  id: string;
}

export interface DesktopCommandMenuItem extends DesktopMenuItemBase {
  kind: "command";
  label: string;
  command: MenuCommand;
  accelerator?: string;
  enabled: boolean;
  checked?: boolean;
  selection?: "checkbox" | "radio";
}

export interface DesktopWindowMenuItem extends DesktopMenuItemBase {
  kind: "window";
  label: string;
  command: WindowCommand;
  accelerator?: string;
  enabled: boolean;
}

export interface DesktopSeparatorMenuItem extends DesktopMenuItemBase {
  kind: "separator";
}

export interface DesktopSubmenuItem extends DesktopMenuItemBase {
  kind: "submenu";
  label: string;
  items: DesktopMenuItem[];
}

export type DesktopMenuItem =
  | DesktopCommandMenuItem
  | DesktopWindowMenuItem
  | DesktopSeparatorMenuItem
  | DesktopSubmenuItem;

export interface DesktopMenu {
  id: "file" | "sensor" | "record" | "view" | "help";
  label: string;
  mnemonic: string;
  items: DesktopMenuItem[];
}

const separator = (id: string): DesktopSeparatorMenuItem => ({
  kind: "separator",
  id,
});

export const buildDesktopMenuModel = (
  state: MenuState,
  platform: NodeJS.Platform,
): DesktopMenu[] => {
  const connectionActive = [
    "connecting",
    "streaming",
    "reconnecting",
    "disconnecting",
  ].includes(state.connection);
  const streaming = state.backendRunning && state.connection === "streaming";
  const actionAvailable =
    streaming && !state.connectionPending && !state.actionPending;

  const fileItems: DesktopMenuItem[] =
    platform === "darwin"
      ? []
      : [
          {
            kind: "window",
            id: "exit",
            label: "Exit",
            command: { type: "quit" },
            enabled: true,
          },
        ];
  const viewItems: DesktopMenuItem[] = [
    {
      kind: "submenu",
      id: "plot-layout",
      label: "Plot Layout",
      items: [
        {
          kind: "command",
          id: "plot-combined",
          label: "Combined",
          command: { type: "set-plot-mode", mode: "combined" },
          enabled: true,
          checked: state.plotMode === "combined",
          selection: "radio",
        },
        {
          kind: "command",
          id: "plot-panels",
          label: "6 Panels",
          command: { type: "set-plot-mode", mode: "panels" },
          enabled: true,
          checked: state.plotMode === "panels",
          selection: "radio",
        },
      ],
    },
    {
      kind: "submenu",
      id: "time-window",
      label: "Time Window",
      items: MENU_TIME_WINDOWS.map((seconds) => ({
        kind: "command" as const,
        id: `time-window-${seconds}`,
        label: `${seconds} s`,
        command: { type: "set-time-window" as const, seconds },
        enabled: true,
        checked: state.timeWindowSeconds === seconds,
        selection: "radio" as const,
      })),
    },
    {
      kind: "submenu",
      id: "visible-axes",
      label: "Visible Axes",
      items: MENU_AXES.map((axis) => ({
        kind: "command" as const,
        id: `axis-${axis}`,
        label: axis,
        command: { type: "toggle-axis" as const, axis },
        enabled: true,
        checked: state.visibleAxes.includes(axis),
        selection: "checkbox" as const,
      })),
    },
  ];
  if (platform !== "darwin") {
    viewItems.push(separator("view-full-screen-separator"), {
      kind: "window",
      id: "toggle-full-screen",
      label: "Toggle Full Screen",
      command: { type: "toggle-full-screen" },
      accelerator: "F11",
      enabled: true,
    });
  }

  const helpItems: DesktopMenuItem[] = [
    {
      kind: "window",
      id: "documentation",
      label: "Documentation",
      command: { type: "open-external", target: "documentation" },
      enabled: true,
    },
    {
      kind: "window",
      id: "report-issue",
      label: "Report an Issue…",
      command: { type: "open-external", target: "issues" },
      enabled: true,
    },
  ];
  if (platform !== "darwin") {
    helpItems.push(separator("help-about-separator"), {
      kind: "window",
      id: "about-netft",
      label: "About Net F/T",
      command: { type: "open-external", target: "organization" },
      enabled: true,
    });
  }

  return [
    {
      id: "file",
      label: "File",
      mnemonic: "f",
      items: fileItems,
    },
    {
      id: "sensor",
      label: "Sensor",
      mnemonic: "s",
      items: [
        {
          kind: "command",
          id: "connection",
          label: connectionActive ? "Disconnect" : "Connect",
          accelerator: "CmdOrCtrl+K",
          command: { type: connectionActive ? "disconnect" : "connect" },
          enabled:
            state.backendRunning &&
            !state.connectionPending &&
            (connectionActive || state.hasSensorHost),
        },
        separator("sensor-bias-separator"),
        {
          kind: "command",
          id: "bias",
          label: "Bias…",
          accelerator: "CmdOrCtrl+Shift+B",
          command: { type: "bias" },
          enabled: actionAvailable && !state.paused,
        },
      ],
    },
    {
      id: "record",
      label: "Record",
      mnemonic: "r",
      items: [
        {
          kind: "command",
          id: "start-recording",
          label: "Start Recording…",
          accelerator: "CmdOrCtrl+Shift+R",
          command: { type: "toggle-recording" },
          enabled: !state.recordingActive && actionAvailable && !state.paused,
        },
        {
          kind: "command",
          id: "stop-recording",
          label: "Stop Recording",
          accelerator: "CmdOrCtrl+Shift+S",
          command: { type: "toggle-recording" },
          enabled:
            state.recordingActive &&
            !state.connectionPending &&
            !state.actionPending,
        },
        separator("record-pause-separator"),
        {
          kind: "command",
          id: "pause",
          label: state.paused ? "Resume" : "Pause",
          accelerator: "CmdOrCtrl+Shift+P",
          command: { type: "toggle-pause" },
          enabled: actionAvailable,
        },
      ],
    },
    {
      id: "view",
      label: "View",
      mnemonic: "v",
      items: viewItems,
    },
    {
      id: "help",
      label: "Help",
      mnemonic: "h",
      items: helpItems,
    },
  ];
};
