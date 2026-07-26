// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RendererEvent } from "../../app/main/companion-supervisor";
import { ChartWorkspace } from "../../app/renderer/components/ChartWorkspace";
import type {
  EChartInstance,
  EChartRuntime,
} from "../../app/renderer/components/use-echart";
import {
  AXES,
  createInitialAppState,
  type AppState,
} from "../../app/renderer/model/app-state";

type PlotBatchEvent = Extract<RendererEvent, { type: "plot_batch" }>;

const plotBatch = (hostTimeNs: string): PlotBatchEvent => ({
  protocol: { major: 1, minor: 0 },
  type: "plot_batch",
  monotonicNs: hostTimeNs,
  payload: {
    axes: [
      { axis: "Fx", points: [{ hostTimeNs, value: 1 }] },
      { axis: "Fy", points: [{ hostTimeNs, value: 2 }] },
      { axis: "Fz", points: [{ hostTimeNs, value: 3 }] },
      { axis: "Tx", points: [{ hostTimeNs, value: 4 }] },
      { axis: "Ty", points: [{ hostTimeNs, value: 5 }] },
      { axis: "Tz", points: [{ hostTimeNs, value: 6 }] },
    ],
  },
});

const stateWithPlot = (
  hostTimeNs = "1000000000",
  generation = "1",
): AppState => ({
  ...createInitialAppState(),
  backend: {
    state: "running",
    restartPending: false,
    startAttempts: 1,
    lastError: "",
    lastMonotonicNs: "10",
  },
  connection: "streaming",
  connectionGeneration: generation,
  connectionMonotonicNs: "20",
  configuration: {
    available: true,
    productName: "ATI",
    forceUnit: "N",
    torqueUnit: "N-mm",
    revision: "1",
    lastMonotonicNs: "30",
  },
  plot: {
    lastBatch: plotBatch(hostTimeNs),
    lastMonotonicNs: hostTimeNs,
  },
});

class TestResizeObserver implements ResizeObserver {
  readonly observe = vi.fn((target: Element) => {
    this.callback(
      [
        {
          target,
          contentRect: {
            width: 800,
            height: 600,
          },
        } as ResizeObserverEntry,
      ],
      this,
    );
  });
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {}
}

class TestInstance implements EChartInstance {
  readonly handlers = new Map<string, (event: unknown) => void>();
  readonly setOption = vi.fn();
  readonly resize = vi.fn();
  readonly dispatchAction = vi.fn();
  readonly dispose = vi.fn(() => {
    this.runtime.instances.delete(this);
  });
  group?: string;

  constructor(private readonly runtime: TestRuntime) {}

  on(event: string, handler: (event: unknown) => void): void {
    this.handlers.set(event, handler);
  }

  off(event: string, handler: (event: unknown) => void): void {
    if (this.handlers.get(event) === handler) {
      this.handlers.delete(event);
    }
  }

  emit(event: string, payload: unknown): void {
    this.handlers.get(event)?.(payload);
  }
}

class TestRuntime implements EChartRuntime {
  readonly instances = new Set<TestInstance>();
  failInitialization = false;

  init(): EChartInstance {
    if (this.failInitialization) {
      throw new Error("canvas unavailable");
    }
    const instance = new TestInstance(this);
    this.instances.add(instance);
    return instance;
  }

  connect(): void {}
}

beforeEach(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ChartWorkspace", () => {
  it("keeps one shared sample set while switching between one and six canvases", () => {
    const runtime = new TestRuntime();
    const view = render(
      <StrictMode>
        <ChartWorkspace
          runtime={runtime}
          state={stateWithPlot()}
          theme="light"
        />
      </StrictMode>,
    );

    expect(screen.getByTestId("chart-workspace").dataset.pointCount).toBe("6");
    expect(runtime.instances.size).toBe(1);

    fireEvent.click(screen.getByTestId("chart-mode-panels"));
    expect(screen.getByTestId("chart-workspace").dataset.pointCount).toBe("6");
    expect(runtime.instances.size).toBe(6);

    fireEvent.click(screen.getByTestId("chart-mode-combined"));
    expect(screen.getByTestId("chart-workspace").dataset.pointCount).toBe("6");
    expect(runtime.instances.size).toBe(1);

    view.unmount();
    expect(runtime.instances.size).toBe(0);
  });

  it("accepts every plot batch in a renderer event burst before React renders", () => {
    const runtime = new TestRuntime();
    let sink: ((event: RendererEvent) => void) | undefined;
    const state = {
      ...stateWithPlot(),
      plot: { lastBatch: null, lastMonotonicNs: "0" },
    } satisfies AppState;
    render(
      <ChartWorkspace
        registerEventSink={(nextSink) => {
          sink = nextSink;
          return () => {
            sink = undefined;
          };
        }}
        runtime={runtime}
        state={state}
        theme="light"
      />,
    );

    act(() => {
      sink?.(plotBatch("1000000000"));
      sink?.(plotBatch("1100000000"));
    });

    expect(screen.getByTestId("chart-workspace").dataset.pointCount).toBe("12");
  });

  it("clears stale data at pause and connection-generation boundaries", () => {
    const runtime = new TestRuntime();
    const view = render(
      <ChartWorkspace
        runtime={runtime}
        state={stateWithPlot()}
        theme="light"
      />,
    );
    expect(screen.getByTestId("chart-workspace").dataset.pointCount).toBe("6");

    view.rerender(
      <ChartWorkspace
        runtime={runtime}
        state={{ ...stateWithPlot(), paused: true }}
        theme="light"
      />,
    );
    expect(screen.getByTestId("chart-workspace").dataset.pointCount).toBe("0");

    view.rerender(
      <ChartWorkspace
        runtime={runtime}
        state={stateWithPlot("2000000000", "2")}
        theme="light"
      />,
    );
    expect(screen.getByTestId("chart-workspace").dataset.pointCount).toBe("6");

    view.rerender(
      <ChartWorkspace
        runtime={runtime}
        state={{
          ...stateWithPlot("2000000000", "3"),
          plot: { lastBatch: null, lastMonotonicNs: "0" },
        }}
        theme="light"
      />,
    );
    expect(screen.getByTestId("chart-workspace").dataset.pointCount).toBe("0");
  });

  it("exposes exact windows and keyboard-native axis visibility controls", () => {
    const runtime = new TestRuntime();
    render(
      <ChartWorkspace
        runtime={runtime}
        state={stateWithPlot()}
        theme="light"
      />,
    );

    expect(
      screen
        .getAllByTestId(/^chart-window-/)
        .map((element) => element.dataset.windowSeconds),
    ).toEqual(["1", "5", "10", "30", "60"]);
    expect(screen.getAllByTestId(/^axis-visibility-/)).toHaveLength(
      AXES.length,
    );

    fireEvent.click(screen.getByTestId("axis-visibility-Fy"));
    expect(screen.getByTestId("axis-visibility-Fy").ariaPressed).toBe("false");
    expect(screen.getByTestId("chart-workspace").dataset.visibleAxisCount).toBe(
      "5",
    );

    fireEvent.click(screen.getByTestId("chart-reset"));
    expect(screen.getByTestId("axis-visibility-Fy").ariaPressed).toBe("false");
  });

  it("persists one coherent visible-axis snapshot for a multi-axis legend event", () => {
    const runtime = new TestRuntime();
    const onPreferencesChange = vi.fn();
    render(
      <ChartWorkspace
        onPreferencesChange={onPreferencesChange}
        runtime={runtime}
        state={stateWithPlot()}
        theme="light"
      />,
    );
    const instance = [...runtime.instances][0];

    act(() => {
      instance?.emit("legendselectchanged", {
        selected: {
          Fx: true,
          Fy: false,
          Fz: false,
          Tx: true,
          Ty: true,
          Tz: true,
        },
      });
    });

    expect(onPreferencesChange).toHaveBeenLastCalledWith({
      visibleAxes: ["Fx", "Tx", "Ty", "Tz"],
    });
  });

  it("leaves live following on manual navigation and ignores programmatic zoom", () => {
    const runtime = new TestRuntime();
    render(
      <ChartWorkspace
        runtime={runtime}
        state={stateWithPlot()}
        theme="light"
      />,
    );
    const instance = [...runtime.instances][0];
    expect(instance).toBeDefined();

    act(() => {
      instance?.emit("datazoom", { from: "user" });
    });
    expect(screen.getByTestId("chart-workspace").dataset.followLive).toBe(
      "false",
    );

    fireEvent.click(screen.getByTestId("chart-live"));
    expect(screen.getByTestId("chart-workspace").dataset.followLive).toBe(
      "true",
    );

    act(() => {
      instance?.emit("datazoom", { from: "netft-viewer-programmatic" });
    });
    expect(screen.getByTestId("chart-workspace").dataset.followLive).toBe(
      "true",
    );
  });

  it("updates theme options without recreating the chart instance", () => {
    const runtime = new TestRuntime();
    const view = render(
      <ChartWorkspace
        runtime={runtime}
        state={stateWithPlot()}
        theme="light"
      />,
    );
    const first = [...runtime.instances][0];

    view.rerender(
      <ChartWorkspace runtime={runtime} state={stateWithPlot()} theme="dark" />,
    );

    expect(runtime.instances.size).toBe(1);
    expect([...runtime.instances][0]).toBe(first);
  });

  it("contains renderer initialization failure inside the chart workspace", () => {
    const runtime = new TestRuntime();
    runtime.failInitialization = true;
    render(
      <ChartWorkspace
        runtime={runtime}
        state={stateWithPlot()}
        theme="light"
      />,
    );

    expect(screen.getByTestId("chart-render-fallback")).toBeDefined();
    expect(screen.getByTestId("chart-toolbar")).toBeDefined();
  });

  it("keeps live charts visible beside structured recording recovery data", () => {
    const runtime = new TestRuntime();
    const state = stateWithPlot();
    render(
      <ChartWorkspace
        runtime={runtime}
        state={{
          ...state,
          backend: {
            ...state.backend,
            logPath: "/var/log/netft-viewer/companion.log",
          },
          recording: {
            ...state.recording,
            state: "error",
            lastError: "write /private/capture failed for 10.0.0.3",
            partialPath: "/data/capture.csv.partial",
          },
          recoverablePartialPath: "/data/capture.csv.partial",
        }}
        theme="light"
      />,
    );

    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByTestId("chart-workspace")).toBeDefined();
    expect(screen.getByTestId("chart-surface-combined")).toBeDefined();
    expect(
      screen.getByTestId("recording-error-detail").textContent,
    ).not.toContain("/private/capture");
    expect(screen.getByTestId("recording-error-partial").textContent).toContain(
      ".partial",
    );
    expect(screen.getByTestId("recording-error-log").textContent).toContain(
      "companion.log",
    );
  });
});
