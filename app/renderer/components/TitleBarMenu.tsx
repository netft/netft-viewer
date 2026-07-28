import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type {
  DesktopMenu,
  DesktopMenuItem,
} from "../../shared/desktop-menu-model";
import type { MenuCommand } from "../../shared/menu-contract";
import type {
  ViewerPlatform,
  WindowCommand,
} from "../../shared/window-command";
import {
  INITIAL_TITLEBAR_MENU_STATE,
  reduceTitlebarMenu,
  type TitlebarMenuEvent,
} from "../model/titlebar-menu-state";
import { MaterialSymbol } from "./MaterialSymbol";

export interface TitleBarMenuProps {
  menus: DesktopMenu[];
  onMenuCommand(command: MenuCommand): void;
  performWindowCommand(command: WindowCommand): Promise<void>;
  platform: ViewerPlatform;
}

const itemAtPath = (
  menus: readonly DesktopMenu[],
  path: readonly string[],
): DesktopMenuItem | undefined => {
  const menu = menus.find(({ id }) => id === path[0]);
  let items = menu?.items;
  let found: DesktopMenuItem | undefined;
  for (const id of path.slice(1)) {
    found = items?.find((item) => item.id === id);
    items = found?.kind === "submenu" ? found.items : undefined;
  }
  return found;
};

const actionableItems = (
  menus: readonly DesktopMenu[],
): Array<Extract<DesktopMenuItem, { kind: "command" | "window" }>> => {
  const result: Array<
    Extract<DesktopMenuItem, { kind: "command" | "window" }>
  > = [];
  const visit = (items: readonly DesktopMenuItem[]): void => {
    for (const item of items) {
      if (item.kind === "submenu") {
        visit(item.items);
      } else if (item.kind === "command" || item.kind === "window") {
        result.push(item);
      }
    }
  };
  for (const menu of menus) {
    visit(menu.items);
  }
  return result;
};

const matchesAccelerator = (
  event: KeyboardEvent,
  accelerator: string,
): boolean => {
  const parts = accelerator.toLowerCase().split("+");
  const key = parts.at(-1);
  const commandOrControl = parts.includes("cmdorctrl");
  return (
    key === event.key.toLowerCase() &&
    (!commandOrControl || event.metaKey || event.ctrlKey) &&
    (parts.includes("shift") ? event.shiftKey : !event.shiftKey) &&
    (parts.includes("alt") ? event.altKey : !event.altKey)
  );
};

const formatAccelerator = (
  accelerator: string,
  platform: ViewerPlatform,
): string =>
  accelerator
    .replace("CmdOrCtrl", platform === "darwin" ? "⌘" : "Ctrl")
    .replaceAll("+", platform === "darwin" ? "" : "+");

const mnemonicLabel = (label: string, mnemonic: string, visible: boolean) => {
  const index = label.toLowerCase().indexOf(mnemonic);
  if (index < 0) {
    return label;
  }
  return (
    <>
      {label.slice(0, index)}
      <span
        className={visible ? "titlebar-mnemonic visible" : "titlebar-mnemonic"}
      >
        {label[index]}
      </span>
      {label.slice(index + 1)}
    </>
  );
};

export const TitleBarMenu = ({
  menus,
  onMenuCommand,
  performWindowCommand,
  platform,
}: TitleBarMenuProps) => {
  const [menuState, setMenuState] = useState(INITIAL_TITLEBAR_MENU_STATE);
  const menuStateRef = useRef(menuState);
  menuStateRef.current = menuState;
  const rootRef = useRef<HTMLDivElement>(null);
  const topLevelRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const actions = useMemo(() => actionableItems(menus), [menus]);
  const dispatch = useCallback(
    (event: TitlebarMenuEvent): void => {
      setMenuState((current) => reduceTitlebarMenu(current, event, menus));
    },
    [menus],
  );
  const closeMenus = useCallback(
    (restoreFocus: boolean): void => {
      dispatch({ type: "close-all" });
      if (restoreFocus) {
        previousFocusRef.current?.focus();
      }
      previousFocusRef.current = null;
    },
    [dispatch],
  );
  const openMenu = useCallback(
    (menuId: string): void => {
      if (menuStateRef.current.openPath.length === 0) {
        previousFocusRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      }
      dispatch({ type: "open-menu", menuId });
    },
    [dispatch],
  );
  const activate = useCallback(
    (item: DesktopMenuItem | undefined): void => {
      if (
        item === undefined ||
        item.kind === "separator" ||
        item.kind === "submenu" ||
        !item.enabled
      ) {
        return;
      }
      if (item.kind === "command") {
        onMenuCommand(item.command);
      } else {
        void performWindowCommand(item.command).catch(() => {});
      }
      closeMenus(false);
    },
    [closeMenus, onMenuCommand, performWindowCommand],
  );

  useEffect(() => {
    if (menuState.focusedMenuId !== undefined) {
      topLevelRefs.current.get(menuState.focusedMenuId)?.focus();
    }
  }, [menuState.focusedMenuId]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      if (
        menuStateRef.current.openPath.length > 0 &&
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        closeMenus(false);
      }
    };
    const handleBlur = (): void => closeMenus(false);
    const handleKeyDown = (event: KeyboardEvent): void => {
      const accelerated = actions.find(
        (item) =>
          item.enabled &&
          item.accelerator !== undefined &&
          matchesAccelerator(event, item.accelerator),
      );
      if (accelerated !== undefined) {
        event.preventDefault();
        activate(accelerated);
        return;
      }

      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.key !== "Alt"
      ) {
        const menu = menus.find(
          ({ mnemonic }) => mnemonic === event.key.toLowerCase(),
        );
        if (menu !== undefined) {
          event.preventDefault();
          dispatch({ type: "show-mnemonics", visible: true });
          openMenu(menu.id);
        }
        return;
      }
      if (event.key === "Alt") {
        event.preventDefault();
        dispatch({ type: "focus-menubar" });
        dispatch({ type: "show-mnemonics", visible: true });
        return;
      }
      if (menuStateRef.current.openPath.length === 0) {
        return;
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          dispatch({ type: "move-item", direction: 1 });
          return;
        case "ArrowUp":
          event.preventDefault();
          dispatch({ type: "move-item", direction: -1 });
          return;
        case "ArrowRight": {
          event.preventDefault();
          const active = itemAtPath(menus, menuStateRef.current.activeItemPath);
          dispatch(
            active?.kind === "submenu"
              ? { type: "open-submenu" }
              : { type: "move-top-level", direction: 1 },
          );
          return;
        }
        case "ArrowLeft":
          event.preventDefault();
          dispatch(
            menuStateRef.current.openPath.length > 1
              ? { type: "close-submenu" }
              : { type: "move-top-level", direction: -1 },
          );
          return;
        case "Enter":
        case " ":
          event.preventDefault();
          activate(itemAtPath(menus, menuStateRef.current.activeItemPath));
          return;
        case "Escape":
          event.preventDefault();
          closeMenus(true);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleBlur);
    };
  }, [actions, activate, closeMenus, dispatch, menus, openMenu]);

  const renderItems = (
    items: readonly DesktopMenuItem[],
    parentPath: readonly string[],
    depth: number,
  ) => (
    <ul
      className={`titlebar-popup${depth > 0 ? " titlebar-submenu" : ""}`}
      data-testid={`titlebar-popup-${parentPath.at(-1)}`}
      role="menu"
    >
      {items.map((item) => {
        if (item.kind === "separator") {
          return (
            <li
              className="titlebar-menu-separator"
              key={item.id}
              role="separator"
            />
          );
        }
        const itemPath = [...parentPath, item.id];
        const active =
          menuState.activeItemPath.at(-1) === item.id &&
          menuState.activeItemPath.length === itemPath.length;
        const nestedOpen =
          item.kind === "submenu" && menuState.openPath[depth + 1] === item.id;
        const role =
          item.kind === "command" && item.selection === "checkbox"
            ? "menuitemcheckbox"
            : item.kind === "command" && item.selection === "radio"
              ? "menuitemradio"
              : "menuitem";
        const enabled =
          item.kind === "submenu" ||
          ((item.kind === "command" || item.kind === "window") && item.enabled);
        return (
          <li className="titlebar-menu-row" key={item.id} role="none">
            <button
              aria-checked={
                item.kind === "command" && item.selection !== undefined
                  ? item.checked
                  : undefined
              }
              aria-expanded={item.kind === "submenu" ? nestedOpen : undefined}
              aria-haspopup={item.kind === "submenu" ? "menu" : undefined}
              className={
                active ? "titlebar-menu-item active" : "titlebar-menu-item"
              }
              data-testid={`titlebar-item-${item.id}`}
              disabled={!enabled}
              onClick={() => {
                if (item.kind === "submenu") {
                  dispatch({ type: "focus-item", path: itemPath });
                  dispatch({ type: "open-submenu" });
                } else {
                  activate(item);
                }
              }}
              onPointerEnter={() => {
                if (!enabled) {
                  return;
                }
                dispatch({ type: "focus-item", path: itemPath });
                if (item.kind === "submenu") {
                  dispatch({ type: "open-submenu" });
                }
              }}
              role={role}
              tabIndex={active ? 0 : -1}
              type="button"
            >
              <span className="titlebar-menu-check">
                {item.kind === "command" &&
                item.selection !== undefined &&
                item.checked ? (
                  <MaterialSymbol name="check" />
                ) : null}
              </span>
              <span className="titlebar-menu-item-label">{item.label}</span>
              {"accelerator" in item && item.accelerator !== undefined ? (
                <span className="titlebar-menu-accelerator">
                  {formatAccelerator(item.accelerator, platform)}
                </span>
              ) : null}
              {item.kind === "submenu" ? (
                <MaterialSymbol
                  className="titlebar-submenu-arrow"
                  name="keyboardArrowRight"
                />
              ) : null}
            </button>
            {item.kind === "submenu" && nestedOpen
              ? renderItems(item.items, itemPath, depth + 1)
              : null}
          </li>
        );
      })}
    </ul>
  );

  const handleTopLevelKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      dispatch({
        type: "move-top-level",
        direction: event.key === "ArrowRight" ? 1 : -1,
      });
    }
  };

  return (
    <div className="titlebar-menubar" ref={rootRef} role="menubar">
      {menus.map((menu, index) => {
        const open = menuState.openPath[0] === menu.id;
        return (
          <div className="titlebar-menu-root" key={menu.id}>
            <button
              aria-expanded={open}
              aria-haspopup="menu"
              className={
                open ? "titlebar-menu-button open" : "titlebar-menu-button"
              }
              data-testid={`titlebar-menu-${menu.id}`}
              onClick={() => {
                if (open) {
                  closeMenus(false);
                } else {
                  openMenu(menu.id);
                }
              }}
              onKeyDown={handleTopLevelKeyDown}
              onPointerEnter={() => {
                if (menuStateRef.current.openPath.length > 0 && !open) {
                  openMenu(menu.id);
                }
              }}
              ref={(element) => {
                if (element === null) {
                  topLevelRefs.current.delete(menu.id);
                } else {
                  topLevelRefs.current.set(menu.id, element);
                }
              }}
              role="menuitem"
              tabIndex={
                menuState.focusedMenuId === menu.id ||
                (menuState.focusedMenuId === undefined && index === 0)
                  ? 0
                  : -1
              }
              type="button"
            >
              {mnemonicLabel(
                menu.label,
                menu.mnemonic,
                menuState.mnemonicsVisible,
              )}
            </button>
            {open ? renderItems(menu.items, [menu.id], 0) : null}
          </div>
        );
      })}
    </div>
  );
};
