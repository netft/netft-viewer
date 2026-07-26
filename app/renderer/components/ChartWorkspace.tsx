import {
  Component,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { RendererEvent } from "../../main/companion-supervisor";
import type { ResolvedViewerTheme } from "../model/viewer-theme";
import {
  ChartModel,
  buildCombinedOption,
  buildPanelOption,
  createChartViewState,
  reduceChartViewState,
  type ChartViewAction,
} from "../model/chart-model";
import { AXES, type AppState, type Axis } from "../model/app-state";
import { ChartToolbar } from "./ChartToolbar";
import {
  defaultEChartRuntime,
  useEChart,
  type EChartRuntime,
} from "./use-echart";

interface ChartErrorBoundaryProps {
  children: ReactNode;
}

interface ChartErrorBoundaryState {
  failed: boolean;
}

class ChartErrorBoundary extends Component<
  ChartErrorBoundaryProps,
  ChartErrorBoundaryState
> {
  state: ChartErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ChartErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(): void {
    // The chart fallback contains renderer failures without exposing internals.
  }

  render(): ReactNode {
    return this.state.failed ? <ChartFallback /> : this.props.children;
  }
}

const ChartFallback = () => (
  <div
    className="chart-render-fallback"
    data-testid="chart-render-fallback"
    role="status"
  >
    Chart unavailable
  </div>
);

interface ChartSurfaceProps {
  axis?: Axis;
  followLive: boolean;
  group?: string;
  onLegendSelection?: (selection: Partial<Record<Axis, boolean>>) => void;
  onManualNavigation: () => void;
  option: unknown;
  resetRevision: number;
  runtime: EChartRuntime;
}

const ChartSurface = memo(
  ({
    axis,
    followLive,
    group,
    onLegendSelection,
    onManualNavigation,
    option,
    resetRevision,
    runtime,
  }: ChartSurfaceProps) => {
    const { containerRef, failed } = useEChart({
      option,
      group,
      followLive,
      resetRevision,
      runtime,
      onManualNavigation,
      onLegendSelection,
    });
    if (failed) {
      return <ChartFallback />;
    }
    return (
      <div
        aria-label={
          axis === undefined ? "Combined force and torque plot" : `${axis} plot`
        }
        className="chart-surface"
        data-testid={`chart-surface-${axis ?? "combined"}`}
        ref={containerRef}
        role="img"
      />
    );
  },
);

ChartSurface.displayName = "ChartSurface";

export interface ChartWorkspaceProps {
  state: AppState;
  theme: ResolvedViewerTheme;
  runtime?: EChartRuntime;
  registerEventSink?: (sink: (event: RendererEvent) => void) => () => void;
}

interface SessionBoundary {
  backendEpoch: string;
  connectionGeneration: string;
  connection: AppState["connection"];
  paused: boolean;
}

const sameSessionBoundary = (
  left: SessionBoundary,
  right: SessionBoundary,
): boolean =>
  left.backendEpoch === right.backendEpoch &&
  left.connectionGeneration === right.connectionGeneration &&
  left.connection === right.connection &&
  left.paused === right.paused;

export const ChartWorkspace = ({
  state,
  theme,
  runtime = defaultEChartRuntime,
  registerEventSink,
}: ChartWorkspaceProps) => {
  const modelRef = useRef<ChartModel>(
    new ChartModel(state.preferences.timeWindowSeconds * 1_000),
  );
  const [modelRevision, setModelRevision] = useState(modelRef.current.revision);
  const [view, dispatchView] = useReducer(
    reduceChartViewState,
    state.preferences,
    createChartViewState,
  );
  const boundary: SessionBoundary = {
    backendEpoch: state.backend.lastMonotonicNs,
    connectionGeneration: state.connectionGeneration,
    connection: state.connection,
    paused: state.paused,
  };
  const previousBoundaryRef = useRef<SessionBoundary>(boundary);
  const lastAppendedBatchRef = useRef<AppState["plot"]["lastBatch"]>(null);

  const resetModel = useCallback(() => {
    if (modelRef.current.reset()) {
      setModelRevision(modelRef.current.revision);
    }
  }, []);

  const consumeRendererEvent = useCallback(
    (event: RendererEvent): void => {
      const current = previousBoundaryRef.current;
      switch (event.type) {
        case "backend_disconnected":
          previousBoundaryRef.current = {
            backendEpoch: event.monotonicNs,
            connectionGeneration: "0",
            connection: "disconnected",
            paused: false,
          };
          resetModel();
          return;
        case "backend_state":
          previousBoundaryRef.current = {
            backendEpoch: event.monotonicNs,
            connectionGeneration:
              event.payload.state === "running"
                ? current.connectionGeneration
                : "0",
            connection:
              event.payload.state === "running"
                ? current.connection
                : "disconnected",
            paused: event.payload.state === "running" ? current.paused : false,
          };
          resetModel();
          return;
        case "connection_state": {
          const next: SessionBoundary = {
            ...current,
            connectionGeneration: event.payload.generation,
            connection: event.payload.state,
            paused: event.payload.paused,
          };
          previousBoundaryRef.current = next;
          if (
            next.connectionGeneration !== current.connectionGeneration ||
            next.connection !== "streaming" ||
            next.paused
          ) {
            resetModel();
          }
          return;
        }
        case "plot_batch":
          if (current.connection !== "streaming" || current.paused) {
            return;
          }
          lastAppendedBatchRef.current = event;
          if (modelRef.current.append(event)) {
            setModelRevision(modelRef.current.revision);
          }
          return;
        default:
          return;
      }
    },
    [resetModel],
  );

  useEffect(() => {
    if (registerEventSink === undefined) {
      return;
    }
    return registerEventSink(consumeRendererEvent);
  }, [consumeRendererEvent, registerEventSink]);

  useEffect(() => {
    if (modelRef.current.setWindowMs(view.windowSeconds * 1_000)) {
      setModelRevision(modelRef.current.revision);
    }
  }, [view.windowSeconds]);

  useEffect(() => {
    const previous = previousBoundaryRef.current;
    if (sameSessionBoundary(previous, boundary)) {
      return;
    }
    previousBoundaryRef.current = boundary;
    const sessionChanged =
      previous.backendEpoch !== boundary.backendEpoch ||
      previous.connectionGeneration !== boundary.connectionGeneration;
    const measurementUnavailable =
      boundary.connection !== "streaming" || boundary.paused;
    if (sessionChanged || measurementUnavailable) {
      resetModel();
      const batch = state.plot.lastBatch;
      const batchPredatesConnection =
        batch !== null &&
        BigInt(batch.monotonicNs) <= BigInt(state.connectionMonotonicNs);
      lastAppendedBatchRef.current =
        measurementUnavailable || batchPredatesConnection ? batch : null;
    }
  }, [boundary, resetModel, state.connectionMonotonicNs, state.plot.lastBatch]);

  useEffect(() => {
    const batch = state.plot.lastBatch;
    if (
      batch === null ||
      batch === lastAppendedBatchRef.current ||
      state.connection !== "streaming" ||
      state.paused
    ) {
      return;
    }
    lastAppendedBatchRef.current = batch;
    if (modelRef.current.append(batch)) {
      setModelRevision(modelRef.current.revision);
    }
  }, [
    state.connection,
    state.paused,
    state.plot.lastBatch,
    state.plot.lastMonotonicNs,
  ]);

  const dispatch = useCallback((action: ChartViewAction) => {
    dispatchView(action);
  }, []);
  const manualNavigation = useCallback(() => {
    dispatchView({ type: "manual_navigation" });
  }, []);
  const legendSelection = useCallback(
    (selection: Partial<Record<Axis, boolean>>) => {
      for (const axis of AXES) {
        const visible = selection[axis];
        if (visible !== undefined) {
          dispatchView({
            type: "axis_visibility_changed",
            axis,
            visible,
          });
        }
      }
    },
    [],
  );
  const optionContext = useMemo(
    () => ({
      forceUnit: state.configuration.forceUnit,
      torqueUnit: state.configuration.torqueUnit,
      theme,
      view,
    }),
    [
      state.configuration.forceUnit,
      state.configuration.torqueUnit,
      theme,
      view,
    ],
  );
  const combinedOption = useMemo(
    () =>
      view.mode === "combined"
        ? buildCombinedOption(modelRef.current, optionContext)
        : null,
    [modelRevision, optionContext, view.mode],
  );
  const panelOptions = useMemo(
    () =>
      view.mode === "panels"
        ? (Object.fromEntries(
            AXES.map((axis) => [
              axis,
              buildPanelOption(modelRef.current, axis, optionContext),
            ]),
          ) as Record<Axis, ReturnType<typeof buildPanelOption>>)
        : null,
    [modelRevision, optionContext, view.mode],
  );

  return (
    <section
      className="plot-workspace"
      data-follow-live={view.followLive}
      data-point-count={modelRef.current.pointCount}
      data-testid="chart-workspace"
      data-visible-axis-count={view.visibleAxes.length}
    >
      <ChartToolbar dispatch={dispatch} view={view} />
      <ChartErrorBoundary>
        {view.mode === "combined" ? (
          <div className="combined-chart-layout">
            <ChartSurface
              followLive={view.followLive}
              onLegendSelection={legendSelection}
              onManualNavigation={manualNavigation}
              option={combinedOption!}
              resetRevision={view.resetRevision}
              runtime={runtime}
            />
          </div>
        ) : (
          <div className="panel-chart-grid">
            {AXES.map((axis) => (
              <div className="panel-chart-cell" key={axis}>
                <ChartSurface
                  axis={axis}
                  followLive={view.followLive}
                  group="netft-viewer-panels"
                  onManualNavigation={manualNavigation}
                  option={panelOptions![axis]}
                  resetRevision={view.resetRevision}
                  runtime={runtime}
                />
              </div>
            ))}
          </div>
        )}
      </ChartErrorBoundary>
    </section>
  );
};
