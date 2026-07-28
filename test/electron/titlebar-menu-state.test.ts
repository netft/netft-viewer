import { describe, expect, it } from "vitest";

import { DEFAULT_MENU_STATE } from "../../app/main/application-menu";
import { buildDesktopMenuModel } from "../../app/shared/desktop-menu-model";
import {
  INITIAL_TITLEBAR_MENU_STATE,
  reduceTitlebarMenu,
} from "../../app/renderer/model/titlebar-menu-state";

const interactiveModel = buildDesktopMenuModel(
  {
    ...DEFAULT_MENU_STATE,
    backendRunning: true,
    connection: "streaming",
    hasSensorHost: true,
  },
  "linux",
);

describe("title-bar menu state", () => {
  it("opens a menu on its first enabled item and skips unavailable entries", () => {
    const opened = reduceTitlebarMenu(
      INITIAL_TITLEBAR_MENU_STATE,
      { type: "open-menu", menuId: "record" },
      interactiveModel,
    );
    const moved = reduceTitlebarMenu(
      opened,
      { type: "move-item", direction: 1 },
      interactiveModel,
    );

    expect(opened.openPath).toEqual(["record"]);
    expect(opened.activeItemPath).toEqual(["record", "start-recording"]);
    expect(moved.activeItemPath).toEqual(["record", "pause"]);
  });

  it("wraps across top-level menus while a popup is open", () => {
    const opened = reduceTitlebarMenu(
      INITIAL_TITLEBAR_MENU_STATE,
      { type: "open-menu", menuId: "help" },
      interactiveModel,
    );
    const moved = reduceTitlebarMenu(
      opened,
      { type: "move-top-level", direction: 1 },
      interactiveModel,
    );

    expect(moved.focusedMenuId).toBe("file");
    expect(moved.openPath).toEqual(["file"]);
  });

  it("opens and closes nested submenus by stable item id", () => {
    let state = reduceTitlebarMenu(
      INITIAL_TITLEBAR_MENU_STATE,
      { type: "open-menu", menuId: "view" },
      interactiveModel,
    );
    state = reduceTitlebarMenu(
      state,
      { type: "open-submenu" },
      interactiveModel,
    );

    expect(state.openPath).toEqual(["view", "plot-layout"]);
    expect(state.activeItemPath).toEqual([
      "view",
      "plot-layout",
      "plot-combined",
    ]);

    state = reduceTitlebarMenu(
      state,
      { type: "close-submenu" },
      interactiveModel,
    );
    expect(state.openPath).toEqual(["view"]);
    expect(state.activeItemPath).toEqual(["view", "plot-layout"]);
  });

  it("tracks mnemonic focus and clears popup state", () => {
    let state = reduceTitlebarMenu(
      INITIAL_TITLEBAR_MENU_STATE,
      { type: "focus-menubar" },
      interactiveModel,
    );
    state = reduceTitlebarMenu(
      state,
      { type: "show-mnemonics", visible: true },
      interactiveModel,
    );
    state = reduceTitlebarMenu(state, { type: "close-all" }, interactiveModel);

    expect(state).toMatchObject({
      openPath: [],
      activeItemPath: [],
      mnemonicsVisible: false,
    });
    expect(state.focusedMenuId).toBeUndefined();
  });
});
