import { describe, expect, it } from "vitest";

import {
  buildDesktopMenuModel,
  type DesktopMenu,
  type DesktopMenuItem,
} from "../../app/shared/desktop-menu-model";
import { DEFAULT_MENU_STATE } from "../../app/main/application-menu";

const findItem = (
  menus: readonly DesktopMenu[],
  id: string,
): DesktopMenuItem | undefined => {
  const visit = (
    items: readonly DesktopMenuItem[],
  ): DesktopMenuItem | undefined => {
    for (const item of items) {
      if (item.id === id) {
        return item;
      }
      if (item.kind === "submenu") {
        const nested = visit(item.items);
        if (nested !== undefined) {
          return nested;
        }
      }
    }
    return undefined;
  };

  for (const menu of menus) {
    const item = visit(menu.items);
    if (item !== undefined) {
      return item;
    }
  }
  return undefined;
};

describe("desktop menu model", () => {
  it("keeps one stable top-level order", () => {
    const model = buildDesktopMenuModel(DEFAULT_MENU_STATE, "linux");

    expect(model.map(({ id }) => id)).toEqual([
      "file",
      "sensor",
      "record",
      "view",
      "help",
    ]);
    expect(new Set(model.map(({ mnemonic }) => mnemonic)).size).toBe(
      model.length,
    );
  });

  it("maps live viewer state into commands, availability, and selections", () => {
    const model = buildDesktopMenuModel(
      {
        ...DEFAULT_MENU_STATE,
        backendRunning: true,
        connection: "streaming",
        paused: true,
        recordingActive: true,
        plotMode: "panels",
        timeWindowSeconds: 30,
        visibleAxes: ["Fx", "Fz", "Ty"],
      },
      "linux",
    );

    expect(findItem(model, "connection")).toMatchObject({
      kind: "command",
      enabled: true,
      command: { type: "disconnect" },
    });
    expect(findItem(model, "bias")).toMatchObject({
      kind: "command",
      enabled: false,
    });
    expect(findItem(model, "start-recording")).toMatchObject({
      enabled: false,
    });
    expect(findItem(model, "stop-recording")).toMatchObject({
      enabled: true,
    });
    expect(findItem(model, "plot-panels")).toMatchObject({
      checked: true,
      selection: "radio",
    });
    expect(findItem(model, "time-window-30")).toMatchObject({
      checked: true,
      selection: "radio",
    });
    expect(findItem(model, "axis-Fx")).toMatchObject({
      checked: true,
      selection: "checkbox",
    });
    expect(findItem(model, "axis-Fy")).toMatchObject({
      checked: false,
      selection: "checkbox",
    });
  });

  it("represents privileged operations as bounded window commands", () => {
    const model = buildDesktopMenuModel(DEFAULT_MENU_STATE, "win32");

    expect(findItem(model, "exit")).toMatchObject({
      kind: "window",
      command: { type: "quit" },
    });
    expect(findItem(model, "toggle-full-screen")).toMatchObject({
      kind: "window",
      command: { type: "toggle-full-screen" },
    });
    expect(findItem(model, "documentation")).toMatchObject({
      kind: "window",
      command: { type: "open-external", target: "documentation" },
    });
  });

  it("leaves macOS close and quit placement to the native adapter", () => {
    const model = buildDesktopMenuModel(DEFAULT_MENU_STATE, "darwin");

    expect(findItem(model, "exit")).toBeUndefined();
    expect(findItem(model, "toggle-full-screen")).toBeUndefined();
  });
});
