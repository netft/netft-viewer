import type {
  DesktopMenu,
  DesktopMenuItem,
} from "../../shared/desktop-menu-model";

export interface TitlebarMenuState {
  focusedMenuId?: string;
  openPath: string[];
  activeItemPath: string[];
  mnemonicsVisible: boolean;
}

export type TitlebarMenuEvent =
  | { type: "focus-menubar" }
  | { type: "open-menu"; menuId: string }
  | { type: "move-top-level"; direction: -1 | 1 }
  | { type: "move-item"; direction: -1 | 1 }
  | { type: "focus-item"; path: string[] }
  | { type: "open-submenu" }
  | { type: "close-submenu" }
  | { type: "close-all" }
  | { type: "show-mnemonics"; visible: boolean };

export const INITIAL_TITLEBAR_MENU_STATE: TitlebarMenuState = {
  openPath: [],
  activeItemPath: [],
  mnemonicsVisible: false,
};

const isFocusableItem = (item: DesktopMenuItem): boolean =>
  item.kind === "submenu" ||
  ((item.kind === "command" || item.kind === "window") && item.enabled);

const itemsAtPath = (
  model: readonly DesktopMenu[],
  path: readonly string[],
): readonly DesktopMenuItem[] => {
  if (path.length === 0) {
    return [];
  }
  let items = model.find(({ id }) => id === path[0])?.items ?? [];
  for (const submenuId of path.slice(1)) {
    const submenu = items.find(
      (item) => item.id === submenuId && item.kind === "submenu",
    );
    if (submenu?.kind !== "submenu") {
      return [];
    }
    items = submenu.items;
  }
  return items;
};

const firstFocusableId = (
  model: readonly DesktopMenu[],
  path: readonly string[],
): string | undefined => itemsAtPath(model, path).find(isFocusableItem)?.id;

const openMenu = (
  state: TitlebarMenuState,
  menuId: string,
  model: readonly DesktopMenu[],
): TitlebarMenuState => {
  const openPath = [menuId];
  const firstItemId = firstFocusableId(model, openPath);
  return {
    ...state,
    focusedMenuId: menuId,
    openPath,
    activeItemPath:
      firstItemId === undefined ? [menuId] : [menuId, firstItemId],
  };
};

export const reduceTitlebarMenu = (
  state: TitlebarMenuState,
  event: TitlebarMenuEvent,
  model: readonly DesktopMenu[],
): TitlebarMenuState => {
  switch (event.type) {
    case "focus-menubar":
      return {
        ...state,
        focusedMenuId: model[0]?.id,
      };
    case "show-mnemonics":
      return {
        ...state,
        mnemonicsVisible: event.visible,
      };
    case "close-all":
      return INITIAL_TITLEBAR_MENU_STATE;
    case "open-menu":
      return openMenu(state, event.menuId, model);
    case "move-top-level": {
      if (model.length === 0) {
        return state;
      }
      const currentIndex = Math.max(
        0,
        model.findIndex(({ id }) => id === state.focusedMenuId),
      );
      const nextIndex =
        (currentIndex + event.direction + model.length) % model.length;
      const nextId = model[nextIndex]?.id;
      if (nextId === undefined) {
        return state;
      }
      return state.openPath.length > 0
        ? openMenu(state, nextId, model)
        : { ...state, focusedMenuId: nextId };
    }
    case "move-item": {
      if (state.openPath.length === 0) {
        return state;
      }
      const focusable = itemsAtPath(model, state.openPath).filter(
        isFocusableItem,
      );
      if (focusable.length === 0) {
        return state;
      }
      const currentId = state.activeItemPath.at(-1);
      const currentIndex = Math.max(
        0,
        focusable.findIndex(({ id }) => id === currentId),
      );
      const nextIndex =
        (currentIndex + event.direction + focusable.length) % focusable.length;
      const nextId = focusable[nextIndex]?.id;
      return nextId === undefined
        ? state
        : {
            ...state,
            activeItemPath: [...state.openPath, nextId],
          };
    }
    case "focus-item":
      return {
        ...state,
        activeItemPath: event.path,
      };
    case "open-submenu": {
      const activeId = state.activeItemPath.at(-1);
      const activeItem = itemsAtPath(model, state.openPath).find(
        ({ id }) => id === activeId,
      );
      if (activeItem?.kind !== "submenu") {
        return state;
      }
      const openPath = [...state.openPath, activeItem.id];
      const firstItemId = firstFocusableId(model, openPath);
      return {
        ...state,
        openPath,
        activeItemPath:
          firstItemId === undefined ? openPath : [...openPath, firstItemId],
      };
    }
    case "close-submenu": {
      if (state.openPath.length <= 1) {
        return state;
      }
      const closedSubmenuId = state.openPath.at(-1);
      const openPath = state.openPath.slice(0, -1);
      return {
        ...state,
        openPath,
        activeItemPath:
          closedSubmenuId === undefined
            ? openPath
            : [...openPath, closedSubmenuId],
      };
    }
  }
};
