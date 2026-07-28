// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NetftApi } from "../../app/preload";
import { App } from "../../app/renderer/App";
import { Actions } from "../../app/renderer/components/Actions";
import { BackendErrorView } from "../../app/renderer/components/BackendErrorView";
import {
  AXES,
  createInitialAppState,
  type AppState,
} from "../../app/renderer/model/app-state";

const deferred = <T,>() => {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

const commands = (): NetftApi => ({
  connect: vi.fn(async () => ({ success: true })),
  disconnect: vi.fn(async () => ({ success: true })),
  setPaused: vi.fn(async () => ({ success: true })),
  requestBias: vi.fn(async () => ({ success: true })),
  startRecording: vi.fn(async () => ({ success: true })),
  stopRecording: vi.fn(async () => ({ success: true })),
  retryBackend: vi.fn(async () => ({ success: true })),
  getPreferences: vi.fn(async () => createInitialAppState().preferences),
  updatePreferences: vi.fn(async () => createInitialAppState().preferences),
  publishMenuState: vi.fn(),
  subscribeMenuCommands: vi.fn(() => () => {}),
  subscribeWindowState: vi.fn(() => () => {}),
  subscribe: vi.fn(() => () => {}),
});

const liveState = (): AppState => ({
  ...createInitialAppState(),
  backend: {
    ...createInitialAppState().backend,
    state: "running",
    restartPending: false,
  },
  connection: "streaming",
  connectionGeneration: "1",
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("Actions", () => {
  it("waits for correlated Pause completion without optimistic state", async () => {
    const pending = deferred<{ success: boolean }>();
    const api = commands();
    vi.mocked(api.setPaused).mockReturnValue(pending.promise);
    const state = liveState();
    const view = render(<Actions api={api} state={state} />);

    fireEvent.click(screen.getByTestId("pause-action"));
    fireEvent.click(screen.getByTestId("pause-action"));

    expect(api.setPaused).toHaveBeenCalledOnce();
    expect(screen.getByTestId("pause-action").dataset.action).toBe("pause");
    expect(
      (screen.getByTestId("pause-action") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("bias-action") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("recording-action") as HTMLButtonElement).disabled,
    ).toBe(true);
    pending.resolve({ success: true });
    await Promise.resolve();
    expect(
      (screen.getByTestId("pause-action") as HTMLButtonElement).disabled,
    ).toBe(true);
    view.rerender(<Actions api={api} state={{ ...state, paused: true }} />);
    await vi.waitFor(() =>
      expect(
        (screen.getByTestId("pause-action") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("disables Record while paused but leaves Stop available", () => {
    const api = commands();
    const paused = { ...liveState(), paused: true };
    const idle = {
      ...paused,
      recording: { ...paused.recording, state: "idle" as const },
    };
    const view = render(<Actions api={api} state={idle} />);

    expect(
      (screen.getByTestId("recording-action") as HTMLButtonElement).disabled,
    ).toBe(true);

    view.rerender(
      <Actions
        api={api}
        state={{
          ...paused,
          recording: { ...paused.recording, state: "paused" },
        }}
      />,
    );
    expect(
      (screen.getByTestId("recording-action") as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByTestId("recording-action"));
    expect(api.stopRecording).toHaveBeenCalledOnce();
    expect(api.startRecording).not.toHaveBeenCalled();
  });

  it("deduplicates Bias while native confirmation and command are pending", async () => {
    const pending = deferred<{ success: boolean }>();
    const api = commands();
    vi.mocked(api.requestBias).mockReturnValue(pending.promise);
    render(<Actions api={api} state={liveState()} />);

    fireEvent.click(screen.getByTestId("bias-action"));
    fireEvent.click(screen.getByTestId("bias-action"));

    expect(api.requestBias).toHaveBeenCalledOnce();
    pending.resolve({ success: true });
    await vi.waitFor(() =>
      expect(
        (screen.getByTestId("bias-action") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("publishes bounded accessible Bias success feedback", async () => {
    const api = commands();
    render(<Actions api={api} state={liveState()} />);

    fireEvent.click(screen.getByTestId("bias-action"));

    await vi.waitFor(() => {
      const feedback = screen.getByRole("status");
      expect(feedback.dataset.action).toBe("bias");
      expect(feedback.dataset.result).toBe("success");
    });
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("surfaces command failure without changing authoritative state", async () => {
    const api = commands();
    vi.mocked(api.setPaused).mockResolvedValue({
      success: false,
      errorCode: "pause_failed",
      errorMessage: "private raw backend message",
    });
    render(<Actions api={api} state={liveState()} />);

    fireEvent.click(screen.getByTestId("pause-action"));

    await vi.waitFor(() =>
      expect(screen.getByRole("status").dataset.errorCode).toBe("pause_failed"),
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      "private raw backend message",
    );
    expect(screen.getByTestId("pause-action").dataset.action).toBe("pause");
  });

  it("clears stale pending state at a connection-generation boundary", async () => {
    const first = deferred<{ success: boolean }>();
    const second = deferred<{ success: boolean }>();
    const api = commands();
    vi.mocked(api.requestBias)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const state = liveState();
    const view = render(<Actions api={api} state={state} />);

    fireEvent.click(screen.getByTestId("bias-action"));
    view.rerender(
      <Actions
        api={api}
        state={{
          ...state,
          connectionGeneration: "2",
        }}
      />,
    );
    expect(screen.getByTestId("bias-action").getAttribute("aria-busy")).toBe(
      "false",
    );

    fireEvent.click(screen.getByTestId("bias-action"));
    expect(api.requestBias).toHaveBeenCalledTimes(2);
    first.resolve({ success: true });
    await Promise.resolve();
    expect(screen.getByTestId("bias-action").getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(screen.queryByRole("status")).toBeNull();

    second.resolve({ success: true });
    await vi.waitFor(() =>
      expect(screen.getByRole("status").dataset.result).toBe("success"),
    );
  });

  it("releases a successful command waiting for an event when the session ends", async () => {
    const pending = deferred<{ success: boolean }>();
    const api = commands();
    vi.mocked(api.setPaused).mockReturnValue(pending.promise);
    const state = liveState();
    const view = render(<Actions api={api} state={state} />);

    fireEvent.click(screen.getByTestId("pause-action"));
    pending.resolve({ success: true });
    await Promise.resolve();
    view.rerender(
      <Actions
        api={api}
        state={{
          ...state,
          connection: "disconnected",
        }}
      />,
    );
    view.rerender(
      <Actions
        api={api}
        state={{
          ...state,
          connectionGeneration: "2",
        }}
      />,
    );

    expect(screen.getByTestId("pause-action").getAttribute("aria-busy")).toBe(
      "false",
    );
    expect(
      (screen.getByTestId("pause-action") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("BackendErrorView", () => {
  it("retries only the backend and exposes selectable structured diagnostics", async () => {
    const api = commands();
    const state = {
      ...liveState(),
      backend: {
        state: "failed" as const,
        restartPending: false,
        startAttempts: 3,
        lastError: "spawn failed",
        lastMonotonicNs: "9",
        logPath: "/var/log/netft-viewer/companion.log",
      },
      recoverablePartialPath: "/data/capture.csv.partial",
      connection: "disconnected" as const,
    };
    render(<BackendErrorView api={api} state={state} />);

    fireEvent.click(screen.getByTestId("retry-backend"));
    fireEvent.click(screen.getByTestId("retry-backend"));

    expect(api.retryBackend).toHaveBeenCalledOnce();
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.startRecording).not.toHaveBeenCalled();
    expect(api.requestBias).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("backend-technical-detail").style.userSelect,
    ).toBe("text");
    expect(screen.getByTestId("backend-log-path").textContent).toContain(
      "companion.log",
    );
    expect(screen.getByTestId("backend-partial-path").textContent).toContain(
      ".partial",
    );
  });
});

describe("preference hydration", () => {
  it("applies native menu view commands through the same preference state", async () => {
    let menuListener:
      | ((command: {
          type: "set-plot-mode";
          mode: "combined" | "panels";
        }) => void)
      | undefined;
    const api = commands();
    vi.mocked(api.subscribeMenuCommands).mockImplementation((listener) => {
      menuListener = listener as typeof menuListener;
      return () => {};
    });
    Object.defineProperty(window, "netft", {
      configurable: true,
      value: api,
    });

    render(<App initialPreferences={createInitialAppState().preferences} />);
    act(() => {
      menuListener?.({ type: "set-plot-mode", mode: "panels" });
    });

    expect(screen.getByTestId("chart-mode-panels").ariaPressed).toBe("true");
    await vi.waitFor(() =>
      expect(api.publishMenuState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          plotMode: "panels",
        }),
      ),
    );
    await vi.waitFor(
      () =>
        expect(api.updatePreferences).toHaveBeenCalledWith({
          plotMode: "panels",
        }),
      { timeout: 1_000 },
    );
  });

  it("hydrates before applying and coalesces chart updates", async () => {
    const api = commands();
    const hydrated = {
      sensorHost: "sensor.example",
      plotMode: "panels" as const,
      timeWindowSeconds: 30 as const,
      visibleAxes: AXES.filter((axis) => axis !== "Tz"),
      theme: "dark" as const,
    };
    vi.mocked(api.getPreferences).mockResolvedValue(hydrated);
    vi.mocked(api.updatePreferences).mockImplementation(async (patch) => ({
      ...hydrated,
      ...patch,
    }));
    Object.defineProperty(window, "netft", {
      configurable: true,
      value: api,
    });

    render(<App />);

    await vi.waitFor(() =>
      expect(screen.getByTestId("chart-mode-panels").ariaPressed).toBe("true"),
    );
    expect(screen.getByTestId("chart-window-30").ariaPressed).toBe("true");
    expect(screen.getByTestId("axis-visibility-Tz").ariaPressed).toBe("false");

    fireEvent.click(screen.getByTestId("chart-mode-combined"));
    fireEvent.click(screen.getByTestId("chart-window-60"));
    await vi.waitFor(
      () => expect(api.updatePreferences).toHaveBeenCalledOnce(),
      { timeout: 1_000 },
    );
    expect(api.updatePreferences).toHaveBeenCalledWith({
      plotMode: "combined",
      timeWindowSeconds: 60,
    });

    fireEvent.change(screen.getByTestId("sensor-host-input"), {
      target: { value: "typed.example" },
    });
    await new Promise((resolvePromise) => {
      window.setTimeout(resolvePromise, 300);
    });
    expect(api.updatePreferences).toHaveBeenCalledOnce();
  });

  it("keeps a live chart preference while surfacing a persistence failure", async () => {
    const api = commands();
    vi.mocked(api.getPreferences).mockResolvedValue({
      ...createInitialAppState().preferences,
      theme: "light",
    });
    vi.mocked(api.updatePreferences).mockRejectedValue(
      new Error("settings unavailable"),
    );
    Object.defineProperty(window, "netft", {
      configurable: true,
      value: api,
    });
    render(<App />);
    await vi.waitFor(() =>
      expect(screen.getByTestId("chart-window-10").ariaPressed).toBe("true"),
    );

    fireEvent.click(screen.getByTestId("chart-window-30"));

    await vi.waitFor(
      () =>
        expect(
          document.querySelector<HTMLOutputElement>(".settings-warning")
            ?.dataset.errorCode,
        ).toBe("settings_unavailable"),
      { timeout: 1_000 },
    );
    expect(screen.getByTestId("chart-window-30").ariaPressed).toBe("true");
  });

  it("merges delayed hydration under multiple user edits and persists once", async () => {
    const pending =
      deferred<ReturnType<typeof createInitialAppState>["preferences"]>();
    const api = commands();
    vi.mocked(api.getPreferences).mockReturnValue(pending.promise);
    vi.mocked(api.updatePreferences).mockImplementation(async (patch) => ({
      ...createInitialAppState().preferences,
      ...patch,
    }));
    Object.defineProperty(window, "netft", {
      configurable: true,
      value: api,
    });
    render(<App />);

    fireEvent.click(screen.getByTestId("axis-visibility-Fy"));
    fireEvent.click(screen.getByTestId("axis-visibility-Fz"));
    fireEvent.click(screen.getByTestId("chart-mode-panels"));
    expect(api.updatePreferences).not.toHaveBeenCalled();

    pending.resolve({
      sensorHost: "sensor.loaded.example",
      plotMode: "combined",
      timeWindowSeconds: 30,
      visibleAxes: ["Fx", "Fy", "Fz"],
      theme: "light",
    });

    await vi.waitFor(
      () => expect(api.updatePreferences).toHaveBeenCalledOnce(),
      { timeout: 1_000 },
    );
    expect(api.updatePreferences).toHaveBeenCalledWith({
      sensorHost: "sensor.loaded.example",
      plotMode: "panels",
      timeWindowSeconds: 30,
      visibleAxes: ["Fx", "Tx", "Ty", "Tz"],
      theme: "light",
    });
    expect(
      (screen.getByTestId("sensor-host-input") as HTMLInputElement).value,
    ).toBe("sensor.loaded.example");
  });

  it("flushes pre-hydration edits on unmount without a late overwrite", async () => {
    const pending =
      deferred<ReturnType<typeof createInitialAppState>["preferences"]>();
    const api = commands();
    vi.mocked(api.getPreferences).mockReturnValue(pending.promise);
    Object.defineProperty(window, "netft", {
      configurable: true,
      value: api,
    });
    const view = render(<App />);

    fireEvent.click(screen.getByTestId("chart-mode-panels"));
    expect(api.updatePreferences).not.toHaveBeenCalled();

    view.unmount();

    expect(api.updatePreferences).toHaveBeenCalledOnce();
    expect(api.updatePreferences).toHaveBeenCalledWith({
      plotMode: "panels",
    });

    pending.resolve({
      sensorHost: "sensor.loaded.example",
      plotMode: "combined",
      timeWindowSeconds: 30,
      visibleAxes: ["Fx", "Fy", "Fz"],
      theme: "light",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(api.updatePreferences).toHaveBeenCalledOnce();
  });
});
