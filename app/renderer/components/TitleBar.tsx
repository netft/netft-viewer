import { buildDesktopMenuModel } from "../../shared/desktop-menu-model";
import type { MenuCommand, MenuState } from "../../shared/menu-contract";
import type {
  ViewerPlatform,
  WindowCommand,
} from "../../shared/window-command";
import { TitleBarMenu } from "./TitleBarMenu";

const productIconUrl = new URL(
  "../../../packaging/icons/netft-viewer-128.png",
  import.meta.url,
).href;

export interface TitleBarProps {
  focused?: boolean;
  fullScreen: boolean;
  menuState: MenuState;
  onMenuCommand(command: MenuCommand): void;
  performWindowCommand(command: WindowCommand): Promise<void>;
  platform: ViewerPlatform;
}

export const TitleBar = ({
  focused = true,
  fullScreen,
  menuState,
  onMenuCommand,
  performWindowCommand,
  platform,
}: TitleBarProps) => {
  const macOS = platform === "darwin";
  const menus = macOS ? [] : buildDesktopMenuModel(menuState, platform);

  return (
    <header
      className="desktop-titlebar"
      data-active={focused}
      data-full-screen={fullScreen}
      data-platform={platform}
      data-testid="desktop-titlebar"
    >
      <div aria-hidden="true" className="titlebar-drag-region" />
      <div className="titlebar-left">
        {macOS ? (
          <div
            aria-hidden="true"
            className="titlebar-traffic-light-reservation"
            data-testid="titlebar-traffic-lights"
          />
        ) : (
          <>
            <img
              alt=""
              aria-hidden="true"
              className="titlebar-app-icon"
              draggable={false}
              src={productIconUrl}
            />
            <TitleBarMenu
              menus={menus}
              onMenuCommand={onMenuCommand}
              performWindowCommand={performWindowCommand}
              platform={platform}
            />
          </>
        )}
      </div>
      <div className="titlebar-center">
        <span className="titlebar-window-title">Net F/T Viewer</span>
      </div>
      <div className="titlebar-right">
        <div
          aria-hidden="true"
          className={
            macOS
              ? "titlebar-macos-balance"
              : "titlebar-window-controls-reservation"
          }
          data-testid={macOS ? undefined : "titlebar-window-controls"}
        />
      </div>
    </header>
  );
};
