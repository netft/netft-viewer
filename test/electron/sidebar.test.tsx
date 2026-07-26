// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RendererEvent } from "../../app/main/companion-supervisor";
import type { NetftApi } from "../../app/preload";
import { App } from "../../app/renderer/App";
import { ConnectionPanel } from "../../app/renderer/components/ConnectionPanel";
import { LiveWrenchTable } from "../../app/renderer/components/LiveWrenchTable";
import { StatusPanel } from "../../app/renderer/components/StatusPanel";
import {
  createInitialAppState,
  type AppState,
} from "../../app/renderer/model/app-state";

const commandOk = async () => ({ success: true });

const installApi = () => {
  let listener: ((event: RendererEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const api: NetftApi = {
    connect: vi.fn(commandOk),
    disconnect: vi.fn(commandOk),
    setPaused: vi.fn(commandOk),
    requestBias: vi.fn(commandOk),
    startRecording: vi.fn(commandOk),
    stopRecording: vi.fn(commandOk),
    retryBackend: vi.fn(commandOk),
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
    productName: "ATI Net F/T",
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
    expect(screen.getByTestId("configuration-revision").textContent).toContain(
      "3",
    );
  });

  it("exposes the correct controls for a paused recording", () => {
    const state = { ...liveState(), paused: true } satisfies AppState;
    const handlers = {
      onHostChange: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onPause: vi.fn(),
      onBias: vi.fn(),
      onRecord: vi.fn(),
      onStop: vi.fn(),
    };
    render(
      <>
        <ConnectionPanel state={state} {...handlers} />
        <LiveWrenchTable state={state} {...handlers} />
      </>,
    );

    for (const testId of [
      "connection-action",
      "pause-action",
      "bias-action",
      "recording-action",
    ]) {
      expect((screen.getByTestId(testId) as HTMLButtonElement).disabled).toBe(
        false,
      );
    }
    fireEvent.click(screen.getByTestId("recording-action"));
    expect(handlers.onStop).toHaveBeenCalledOnce();
    expect(handlers.onRecord).not.toHaveBeenCalled();
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

  it("subscribes and cleans up safely under StrictMode", () => {
    const { api, unsubscribe } = installApi();
    const view = render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(api.subscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("applies validated stream events to the displayed wrench", () => {
    const { emit } = installApi();
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
    });

    expect(screen.getByTestId("raw-Fx").textContent).toContain("10");
    expect(screen.getByTestId("value-Tz").textContent).toContain("6.000 N·mm");
  });
});
