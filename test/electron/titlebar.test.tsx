// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { DEFAULT_MENU_STATE } from "../../app/main/application-menu";
import { TitleBar } from "../../app/renderer/components/TitleBar";

afterEach(cleanup);

const interactiveState = {
  ...DEFAULT_MENU_STATE,
  backendRunning: true,
  connection: "streaming" as const,
  hasSensorHost: true,
};

describe("custom title bar", () => {
  it("renders an inline application menubar on Linux", () => {
    render(
      <TitleBar
        fullScreen={false}
        menuState={interactiveState}
        onMenuCommand={vi.fn()}
        performWindowCommand={vi.fn()}
        platform="linux"
      />,
    );

    expect(screen.getByRole("menubar")).toBeTruthy();
    expect(screen.getByTestId("titlebar-window-controls")).toBeTruthy();
  });

  it("keeps the in-window menu out of the macOS title surface", () => {
    render(
      <TitleBar
        fullScreen={false}
        menuState={interactiveState}
        onMenuCommand={vi.fn()}
        performWindowCommand={vi.fn()}
        platform="darwin"
      />,
    );

    expect(screen.queryByRole("menubar")).toBeNull();
    expect(screen.getByTestId("titlebar-traffic-lights")).toBeTruthy();
  });

  it("switches open top-level menus and exposes current selection state", () => {
    render(
      <TitleBar
        fullScreen={false}
        menuState={{ ...interactiveState, plotMode: "panels" }}
        onMenuCommand={vi.fn()}
        performWindowCommand={vi.fn()}
        platform="linux"
      />,
    );

    fireEvent.click(screen.getByTestId("titlebar-menu-sensor"));
    expect(screen.getByTestId("titlebar-popup-sensor")).toBeTruthy();
    fireEvent.pointerEnter(screen.getByTestId("titlebar-menu-record"));
    expect(screen.queryByTestId("titlebar-popup-sensor")).toBeNull();
    expect(screen.getByTestId("titlebar-popup-record")).toBeTruthy();

    fireEvent.click(screen.getByTestId("titlebar-menu-view"));
    fireEvent.pointerEnter(screen.getByTestId("titlebar-item-plot-layout"));
    expect(
      screen
        .getByTestId("titlebar-item-plot-panels")
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("routes application and privileged commands through separate callbacks", () => {
    const onMenuCommand = vi.fn();
    const performWindowCommand = vi.fn(async () => {});
    render(
      <TitleBar
        fullScreen={false}
        menuState={interactiveState}
        onMenuCommand={onMenuCommand}
        performWindowCommand={performWindowCommand}
        platform="linux"
      />,
    );

    fireEvent.click(screen.getByTestId("titlebar-menu-sensor"));
    fireEvent.click(screen.getByTestId("titlebar-item-connection"));
    fireEvent.click(screen.getByTestId("titlebar-menu-help"));
    fireEvent.click(screen.getByTestId("titlebar-item-documentation"));

    expect(onMenuCommand).toHaveBeenCalledWith({ type: "disconnect" });
    expect(performWindowCommand).toHaveBeenCalledWith({
      type: "open-external",
      target: "documentation",
    });
  });

  it("supports mnemonic opening and Escape dismissal", () => {
    render(
      <TitleBar
        fullScreen={false}
        menuState={interactiveState}
        onMenuCommand={vi.fn()}
        performWindowCommand={vi.fn()}
        platform="linux"
      />,
    );

    fireEvent.keyDown(document, { altKey: true, key: "s" });
    expect(screen.getByTestId("titlebar-popup-sensor")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("titlebar-popup-sensor")).toBeNull();
  });

  it("retains the full-screen accelerator without a native menu", () => {
    const performWindowCommand = vi.fn(async () => {});
    render(
      <TitleBar
        fullScreen={false}
        menuState={interactiveState}
        onMenuCommand={vi.fn()}
        performWindowCommand={performWindowCommand}
        platform="linux"
      />,
    );

    fireEvent.keyDown(document, { key: "F11" });

    expect(performWindowCommand).toHaveBeenCalledWith({
      type: "toggle-full-screen",
    });
  });

  it("renders platform-native accelerator labels", () => {
    render(
      <TitleBar
        fullScreen={false}
        menuState={interactiveState}
        onMenuCommand={vi.fn()}
        performWindowCommand={vi.fn()}
        platform="linux"
      />,
    );

    fireEvent.click(screen.getByTestId("titlebar-menu-sensor"));

    expect(screen.getByText("Ctrl+K")).toBeTruthy();
    expect(screen.queryByText(/CmdOrCtrl/)).toBeNull();
  });

  it("keeps keyboard handling mounted while hiding its full-screen surface", () => {
    render(
      <TitleBar
        fullScreen
        menuState={interactiveState}
        onMenuCommand={vi.fn()}
        performWindowCommand={vi.fn()}
        platform="linux"
      />,
    );

    expect(screen.getByTestId("desktop-titlebar").dataset.fullScreen).toBe(
      "true",
    );
  });

  it("exposes inactive window state without a nonstandard CSS pseudo-class", () => {
    render(
      <TitleBar
        focused={false}
        fullScreen={false}
        menuState={interactiveState}
        onMenuCommand={vi.fn()}
        performWindowCommand={vi.fn()}
        platform="linux"
      />,
    );

    expect(screen.getByTestId("desktop-titlebar").dataset.active).toBe("false");
  });
});
