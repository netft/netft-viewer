// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RendererEvent } from "../../app/main/companion-supervisor";
import type { NetftApi } from "../../app/preload";
import { App } from "../../app/renderer/App";
import { LiveWrenchTable } from "../../app/renderer/components/LiveWrenchTable";
import { StatusPanel } from "../../app/renderer/components/StatusPanel";
import {
  AXES,
  createInitialAppState,
  type AppState,
  type Preferences,
} from "../../app/renderer/model/app-state";

const commandOk = async () => ({ success: true });
const deferredCommand = () => {
  let resolve!: (value: { success: boolean }) => void;
  const promise = new Promise<{ success: boolean }>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};
const DEFAULT_PREFERENCES: Preferences = {
  sensorHost: "192.168.1.1",
  plotMode: "combined",
  timeWindowSeconds: 10,
  visibleAxes: [...AXES],
  theme: "system",
};

const installApi = () => {
  let listener: ((event: RendererEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const api: NetftApi = {
    platform: "linux",
    connect: vi.fn(commandOk),
    disconnect: vi.fn(commandOk),
    setPaused: vi.fn(commandOk),
    requestBias: vi.fn(commandOk),
    startRecording: vi.fn(commandOk),
    stopRecording: vi.fn(commandOk),
    retryBackend: vi.fn(commandOk),
    getPreferences: vi.fn(async () => DEFAULT_PREFERENCES),
    updatePreferences: vi.fn(async () => DEFAULT_PREFERENCES),
    publishMenuState: vi.fn(),
    performWindowCommand: vi.fn(async () => {}),
    subscribeMenuCommands: vi.fn(() => () => {}),
    subscribeWindowState: vi.fn(() => () => {}),
    subscribe: vi.fn((nextListener) => {
      listener = nextListener;
      return unsubscribe;
    }),
  };
  Object.defineProperty(window, "netft", {
    configurable: true,
    value: api,
  });
  return {
    api,
    emit: (event: RendererEvent) => listener?.(event),
    unsubscribe,
  };
};

const liveState = (): AppState => ({
  ...createInitialAppState(),
  backend: {
    state: "running",
    restartPending: false,
    startAttempts: 1,
    lastError: "",
    lastMonotonicNs: "0",
  },
  connection: "streaming",
  connectionGeneration: "1",
  health: {
    ...createInitialAppState().health,
    productName: "ATI Net F/T",
    receiveRateHz: 1_000,
    deliveryRateHz: 997,
    packetLossPercent: 0.3,
    deviceStatus: 0,
  },
  wrench: {
    rdtSequence: 7,
    ftSequence: 8,
    sampleMonotonicNs: "100",
    raw: [-12_345, 6_789, 3_456, -2_345, 1_234, -5_678],
    calibrated: [-12.345, 6.789, 3.456, -2.345, 1.234, -5.678],
    forceUnit: "N",
    torqueUnit: "N-mm",
    configurationRevision: "3",
  },
  configuration: {
    ...createInitialAppState().configuration,
    available: true,
    productName: "ATI Net F/T",
    forceUnit: "N",
    torqueUnit: "N-mm",
    revision: "3",
  },
  recording: {
    ...createInitialAppState().recording,
    state: "recording",
    elapsedNs: "84000000000",
    bytesWritten: "13002342",
    queueSize: "31457",
    queueCapacity: "65536",
  },
});

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(window, "requestAnimationFrame");
  Reflect.deleteProperty(window, "cancelAnimationFrame");
});

describe("fixed sensor sidebar", () => {
  it("shows the default host and connection action without auto-connecting", () => {
    const { api, emit } = installApi();
    render(<App />);

    expect(
      (screen.getByTestId("sensor-host-input") as HTMLInputElement).value,
    ).toBe("192.168.1.1");
    expect(
      (screen.getByTestId("connection-action") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(api.connect).not.toHaveBeenCalled();

    act(() => {
      emit({
        type: "backend_state",
        monotonicNs: "1",
        payload: {
          state: "running",
          startAttempts: 1,
        },
      });
    });
    expect(
      (screen.getByTestId("connection-action") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("renders technical health, recording, raw, and calibrated values", () => {
    const state = liveState();
    render(
      <aside>
        <StatusPanel state={state} />
        <LiveWrenchTable state={state} />
      </aside>,
    );

    expect(screen.getByTestId("receive-rate").textContent).toContain("1,000");
    expect(screen.getByTestId("delivery-rate").textContent).toContain("997");
    expect(screen.getByTestId("packet-loss").textContent).toContain("0.30");
    expect(screen.getByTestId("recording-duration").textContent).toContain(
      "00:01:24",
    );
    expect(screen.getByTestId("recording-bytes").textContent).toContain(
      "13.0 MB",
    );
    expect(screen.getByTestId("recording-buffer").textContent).toContain(
      "48.0",
    );
    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByTestId("raw-Fx").textContent).toContain("-12,345");
    expect(screen.getByTestId("value-Fx").textContent).toContain("-12.345 N");
    expect(screen.getByTestId("value-Tz").textContent).toContain("-5.678 N·mm");
  });

  it("collapses status and wrench details independently", () => {
    const state = liveState();
    render(
      <aside>
        <StatusPanel state={state} />
        <LiveWrenchTable state={state} />
      </aside>,
    );

    expect(screen.getByTestId("status-toggle").ariaExpanded).toBe("true");
    expect(screen.getByTestId("wrench-toggle").ariaExpanded).toBe("true");
    expect(screen.getByTestId("receive-rate")).toBeDefined();
    expect(screen.getByTestId("wrench-table")).toBeDefined();

    fireEvent.click(screen.getByTestId("status-toggle"));
    expect(screen.getByTestId("status-toggle").ariaExpanded).toBe("false");
    expect(screen.queryByTestId("receive-rate")).toBeNull();
    expect(screen.getByTestId("wrench-table")).toBeDefined();

    fireEvent.click(screen.getByTestId("wrench-toggle"));
    expect(screen.getByTestId("wrench-toggle").ariaExpanded).toBe("false");
    expect(screen.queryByTestId("wrench-table")).toBeNull();
  });

  it("keeps sensor actions outside the scrolling detail region", () => {
    installApi();
    render(<App initialPreferences={DEFAULT_PREFERENCES} />);

    const scrollRegion = screen.getByTestId("sidebar-scroll-region");
    const actionDock = screen.getByTestId("sidebar-action-dock");

    expect(scrollRegion.contains(screen.getByTestId("status-toggle"))).toBe(
      true,
    );
    expect(scrollRegion.contains(screen.getByTestId("wrench-toggle"))).toBe(
      true,
    );
    expect(actionDock.contains(screen.getByTestId("pause-action"))).toBe(true);
    expect(scrollRegion.contains(actionDock)).toBe(false);
  });

  it("redacts unsafe host and path values from the visible error summary", () => {
    const state = {
      ...liveState(),
      health: {
        ...liveState().health,
        latestError: "connect /private/location failed for 10.0.0.3",
      },
    };

    render(<StatusPanel state={state} />);

    expect(screen.getByTestId("latest-error").textContent).not.toContain(
      "/private/location",
    );
    expect(screen.getByTestId("latest-error").textContent).not.toContain(
      "10.0.0.3",
    );
  });

  it("labels a frozen sample with sample-native units after reconfiguration", () => {
    const state: AppState = {
      ...liveState(),
      paused: true,
      configuration: {
        ...liveState().configuration,
        forceUnit: "lbf",
        torqueUnit: "lbf-in",
        revision: "4",
      },
    };
    render(<LiveWrenchTable state={state} />);

    expect(screen.getByTestId("value-Fx").textContent).toContain("-12.345 N");
    expect(screen.getByTestId("value-Tz").textContent).toContain("-5.678 N·mm");
  });

  it("routes connection input and actions through the narrow API", async () => {
    const { api, emit } = installApi();
    render(<App />);

    act(() => {
      emit({
        type: "backend_state",
        monotonicNs: "1",
        payload: {
          state: "running",
          startAttempts: 1,
        },
      });
    });
    fireEvent.change(screen.getByTestId("sensor-host-input"), {
      target: { value: "sensor.example" },
    });
    fireEvent.click(screen.getByTestId("connection-action"));

    expect(api.connect).toHaveBeenCalledWith("sensor.example");
  });

  it("cancels a pending connection command when the backend epoch changes", async () => {
    const pending = deferredCommand();
    const { api, emit } = installApi();
    vi.mocked(api.connect).mockReturnValue(pending.promise);
    render(<App initialPreferences={DEFAULT_PREFERENCES} />);

    act(() => {
      emit({
        type: "backend_state",
        monotonicNs: "1",
        payload: { state: "running", startAttempts: 1 },
      });
    });
    fireEvent.click(screen.getByTestId("connection-action"));
    expect(
      (screen.getByTestId("connection-action") as HTMLButtonElement).disabled,
    ).toBe(true);

    act(() => {
      emit({
        type: "backend_disconnected",
        monotonicNs: "2",
        payload: { restartPending: true },
      });
      emit({
        type: "backend_state",
        monotonicNs: "3",
        payload: { state: "running", startAttempts: 2 },
      });
    });

    expect(
      (screen.getByTestId("connection-action") as HTMLButtonElement).disabled,
    ).toBe(false);
    await act(async () => {
      pending.resolve({ success: true });
      await pending.promise;
    });
    expect(
      (screen.getByTestId("connection-action") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("cancels a pending connection command at a connection generation boundary", () => {
    const pending = deferredCommand();
    const { api, emit } = installApi();
    vi.mocked(api.connect).mockReturnValue(pending.promise);
    render(<App initialPreferences={DEFAULT_PREFERENCES} />);

    act(() => {
      emit({
        type: "backend_state",
        monotonicNs: "1",
        payload: { state: "running", startAttempts: 1 },
      });
    });
    fireEvent.click(screen.getByTestId("connection-action"));
    act(() => {
      emit({
        protocol: { major: 1, minor: 0 },
        type: "connection_state",
        monotonicNs: "2",
        payload: {
          state: "disconnected",
          paused: false,
          generation: "2",
          lastError: "",
        },
      });
    });

    expect(
      (screen.getByTestId("connection-action") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("cleans up its event subscription on unmount", () => {
    const { unsubscribe } = installApi();
    const view = render(<App />);

    expect(unsubscribe).not.toHaveBeenCalled();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("always renders the light theme without consulting the system theme", () => {
    installApi();
    const matchMedia = vi.fn();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMedia,
    });

    render(
      <App initialPreferences={{ ...DEFAULT_PREFERENCES, theme: "dark" }} />,
    );

    expect(screen.getByTestId("viewer-shell").dataset.theme).toBe("light");
    expect(screen.queryByTestId("theme-preference")).toBeNull();
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it("applies validated stream events to the displayed wrench", () => {
    const { emit } = installApi();
    let frame: FrameRequestCallback | undefined;
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      },
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: vi.fn(),
    });
    render(<App />);

    act(() => {
      emit({
        protocol: { major: 1, minor: 0 },
        type: "connection_state",
        monotonicNs: "100",
        payload: {
          state: "streaming",
          paused: false,
          generation: "1",
          lastError: "",
        },
      });
      emit({
        protocol: { major: 1, minor: 0 },
        type: "configuration_changed",
        monotonicNs: "150",
        payload: {
          productName: "ATI Net F/T",
          countsPerForceUnit: 1_000_000,
          countsPerTorqueUnit: 1_000_000,
          forceUnit: "N",
          torqueUnit: "N-mm",
          source: "sensor",
          revision: "4",
        },
      });
      emit({
        protocol: { major: 1, minor: 0 },
        type: "live_wrench",
        monotonicNs: "200",
        payload: {
          hostTimeNs: "200",
          sampleMonotonicNs: "200",
          rdtSequence: 2,
          ftSequence: 3,
          status: 0,
          raw: [10, 20, 30, 40, 50, 60],
          force: [1, 2, 3],
          torque: [4, 5, 6],
          forceUnit: "N",
          torqueUnit: "N-mm",
          configurationRevision: "4",
        },
      });
      frame?.(16);
    });

    expect(screen.getByTestId("raw-Fx").textContent).toContain("10");
    expect(screen.getByTestId("value-Tz").textContent).toContain("6.000 N·mm");
  });
});
