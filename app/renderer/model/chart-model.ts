import type { RendererEvent } from "../../main/companion-supervisor";
import { AXES, type Axis, type PlotMode, type Preferences } from "./app-state";
import type { ResolvedViewerTheme } from "./viewer-theme";

type PlotBatchEvent = Extract<RendererEvent, { type: "plot_batch" }>;

export interface ChartPoint {
  hostTimeNs: string;
  timeMs: number;
  value: number;
}

interface StoredChartPoint extends ChartPoint {
  hostTime: bigint;
}

export interface ChartViewState {
  mode: PlotMode;
  windowSeconds: Preferences["timeWindowSeconds"];
  visibleAxes: Axis[];
  followLive: boolean;
  resetRevision: number;
}

export type ChartViewAction =
  | { type: "mode_changed"; mode: PlotMode }
  | {
      type: "window_changed";
      seconds: Preferences["timeWindowSeconds"];
    }
  | {
      type: "axis_visibility_changed";
      axis: Axis;
      visible: boolean;
    }
  | { type: "manual_navigation" }
  | { type: "live_requested" }
  | { type: "view_reset" }
  | {
      type: "preferences_received";
      preferences: Pick<
        Preferences,
        "plotMode" | "timeWindowSeconds" | "visibleAxes"
      >;
    };

export const TIME_WINDOWS_SECONDS = [1, 5, 10, 30, 60] as const;

export interface AxisStyle {
  color: string;
  lineType: "solid" | "dashed" | "dotted";
}

export const AXIS_STYLES: Record<Axis, AxisStyle> = {
  Fx: { color: "#1f63d5", lineType: "solid" },
  Fy: { color: "#16966a", lineType: "dashed" },
  Fz: { color: "#7b4dd8", lineType: "dotted" },
  Tx: { color: "#d67519", lineType: "solid" },
  Ty: { color: "#168c9b", lineType: "dashed" },
  Tz: { color: "#cf3b49", lineType: "dotted" },
};

const orderedVisibleAxes = (axes: readonly Axis[]): Axis[] => {
  const selected = new Set(axes);
  return AXES.filter((axis) => selected.has(axis));
};

export const createChartViewState = (
  preferences?: Pick<
    Preferences,
    "plotMode" | "timeWindowSeconds" | "visibleAxes"
  >,
): ChartViewState => ({
  mode: preferences?.plotMode ?? "combined",
  windowSeconds: preferences?.timeWindowSeconds ?? 10,
  visibleAxes: orderedVisibleAxes(preferences?.visibleAxes ?? AXES),
  followLive: true,
  resetRevision: 0,
});

export const reduceChartViewState = (
  state: ChartViewState,
  action: ChartViewAction,
): ChartViewState => {
  switch (action.type) {
    case "mode_changed":
      return action.mode === state.mode
        ? state
        : { ...state, mode: action.mode };
    case "window_changed":
      return {
        ...state,
        windowSeconds: action.seconds,
        followLive: true,
      };
    case "axis_visibility_changed": {
      const selected = new Set(state.visibleAxes);
      if (action.visible) {
        selected.add(action.axis);
      } else {
        selected.delete(action.axis);
      }
      return { ...state, visibleAxes: orderedVisibleAxes([...selected]) };
    }
    case "manual_navigation":
      return state.followLive ? { ...state, followLive: false } : state;
    case "live_requested":
      return state.followLive ? state : { ...state, followLive: true };
    case "view_reset":
      return { ...state, resetRevision: state.resetRevision + 1 };
    case "preferences_received":
      return {
        ...state,
        mode: action.preferences.plotMode,
        windowSeconds: action.preferences.timeWindowSeconds,
        visibleAxes: orderedVisibleAxes(action.preferences.visibleAxes),
      };
  }
};

const lowerBound = (
  points: readonly StoredChartPoint[],
  timestamp: bigint,
): number => {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle]!.hostTime < timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

export class ChartModel {
  private readonly points = new Map<Axis, StoredChartPoint[]>(
    AXES.map((axis) => [axis, []]),
  );
  private originNs: bigint | undefined;
  private latestNs: bigint | undefined;
  private windowNanoseconds: bigint;

  revision = 0;

  constructor(windowMs: number) {
    this.windowNanoseconds = ChartModel.windowToNanoseconds(windowMs);
  }

  get pointCount(): number {
    let count = 0;
    for (const axis of AXES) {
      count += this.points.get(axis)!.length;
    }
    return count;
  }

  get latestTimeMs(): number | null {
    if (this.originNs === undefined || this.latestNs === undefined) {
      return null;
    }
    return Number(this.latestNs - this.originNs) / 1_000_000;
  }

  append(batch: PlotBatchEvent): boolean {
    let firstTimestamp: bigint | undefined;
    let newestTimestamp = this.latestNs;
    for (const axisBatch of batch.payload.axes) {
      for (const point of axisBatch.points) {
        const timestamp = BigInt(point.hostTimeNs);
        firstTimestamp =
          firstTimestamp === undefined || timestamp < firstTimestamp
            ? timestamp
            : firstTimestamp;
        newestTimestamp =
          newestTimestamp === undefined || timestamp > newestTimestamp
            ? timestamp
            : newestTimestamp;
      }
    }
    if (firstTimestamp === undefined || newestTimestamp === undefined) {
      return false;
    }
    this.originNs ??= firstTimestamp;
    this.latestNs = newestTimestamp;
    const cutoff = newestTimestamp - this.windowNanoseconds;
    let changed = false;

    for (const axisBatch of batch.payload.axes) {
      const series = this.points.get(axisBatch.axis)!;
      for (const point of axisBatch.points) {
        const timestamp = BigInt(point.hostTimeNs);
        if (timestamp < cutoff) {
          continue;
        }
        const index = lowerBound(series, timestamp);
        const stored: StoredChartPoint = {
          hostTimeNs: point.hostTimeNs,
          hostTime: timestamp,
          timeMs: Number(timestamp - this.originNs) / 1_000_000,
          value: point.value,
        };
        if (series[index]?.hostTime === timestamp) {
          if (series[index]!.value !== point.value) {
            series[index] = stored;
            changed = true;
          }
        } else {
          series.splice(index, 0, stored);
          changed = true;
        }
      }
    }
    changed = this.evictBefore(cutoff) || changed;
    if (changed) {
      this.revision += 1;
    }
    return changed;
  }

  series(axis: Axis): readonly ChartPoint[] {
    return this.points
      .get(axis)!
      .map(({ hostTimeNs, timeMs, value }) => ({ hostTimeNs, timeMs, value }));
  }

  setWindowMs(windowMs: number): boolean {
    const nextWindow = ChartModel.windowToNanoseconds(windowMs);
    if (nextWindow === this.windowNanoseconds) {
      return false;
    }
    this.windowNanoseconds = nextWindow;
    const changed =
      this.latestNs === undefined
        ? false
        : this.evictBefore(this.latestNs - this.windowNanoseconds);
    this.revision += 1;
    return changed;
  }

  reset(): boolean {
    if (
      this.originNs === undefined &&
      this.latestNs === undefined &&
      this.pointCount === 0
    ) {
      return false;
    }
    for (const axis of AXES) {
      this.points.get(axis)!.length = 0;
    }
    this.originNs = undefined;
    this.latestNs = undefined;
    this.revision += 1;
    return true;
  }

  private evictBefore(cutoff: bigint): boolean {
    let changed = false;
    for (const axis of AXES) {
      const series = this.points.get(axis)!;
      const firstRetained = lowerBound(series, cutoff);
      if (firstRetained > 0) {
        series.splice(0, firstRetained);
        changed = true;
      }
    }
    return changed;
  }

  private static windowToNanoseconds(windowMs: number): bigint {
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new RangeError("chart window must be a positive integer");
    }
    return BigInt(windowMs) * 1_000_000n;
  }
}

interface ChartOptionTheme {
  background: string;
  ink: string;
  muted: string;
  border: string;
  splitLine: string;
  tooltipBackground: string;
}

const OPTION_THEMES: Record<ResolvedViewerTheme, ChartOptionTheme> = {
  light: {
    background: "#fbfcfe",
    ink: "#13233b",
    muted: "#5e6b7c",
    border: "#aeb9c8",
    splitLine: "#dfe4eb",
    tooltipBackground: "#ffffff",
  },
  dark: {
    background: "#0f141c",
    ink: "#e7edf6",
    muted: "#9dabc0",
    border: "#465368",
    splitLine: "#293443",
    tooltipBackground: "#1c2531",
  },
};

const displayUnit = (unit: string): string =>
  unit === "N-mm" ? "N·mm" : unit === "N-m" ? "N·m" : unit;

const axisUnit = (axis: Axis, forceUnit: string, torqueUnit: string): string =>
  displayUnit(axis.startsWith("F") ? forceUnit : torqueUnit);

export interface ChartSeriesOption {
  name: Axis;
  type: "line";
  yAxisIndex: 0 | 1;
  data: Array<[number, number]>;
  animation: false;
  showSymbol: false;
  progressive: 0;
  progressiveThreshold: 0;
  lineStyle: {
    color: string;
    width: number;
    type: AxisStyle["lineType"];
  };
  itemStyle: { color: string };
  emphasis: { focus: "series" };
  tooltip: { valueFormatter: (value: unknown) => string };
}

export interface ChartAxisOption {
  type: "value";
  name?: string;
  position?: "left" | "right";
  min?: number | null;
  max?: number | null;
  scale?: boolean;
  axisLine: { lineStyle: { color: string } };
  axisLabel: {
    color: string;
    formatter?: (value: number) => string;
  };
  nameTextStyle?: { color: string };
  splitLine: { lineStyle: { color: string; width: number } };
}

export interface CombinedChartOption {
  animation: false;
  backgroundColor: string;
  aria: { enabled: true };
  color: string[];
  grid: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    containLabel: true;
  };
  legend: {
    show: false;
    type: "scroll";
    bottom: number;
    textStyle: { color: string };
    selected: Record<Axis, boolean>;
  };
  tooltip: {
    trigger: "axis";
    axisPointer: { type: "line"; snap: true };
    backgroundColor: string;
    borderColor: string;
    textStyle: { color: string };
  };
  dataZoom: Array<{
    type: "inside";
    xAxisIndex: number | number[];
    filterMode: "none";
    zoomOnMouseWheel: true;
    moveOnMouseMove: true;
  }>;
  xAxis: ChartAxisOption;
  yAxis: [ChartAxisOption, ChartAxisOption];
  series: ChartSeriesOption[];
}

export interface PanelChartOption {
  animation: false;
  backgroundColor: string;
  aria: { enabled: true };
  grid: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    containLabel: true;
  };
  legend: {
    show: false;
    selected: Record<Axis, boolean>;
  };
  tooltip: CombinedChartOption["tooltip"];
  dataZoom: CombinedChartOption["dataZoom"];
  xAxis: ChartAxisOption;
  yAxis: ChartAxisOption;
  series: ChartSeriesOption[];
}

interface BuildOptionContext {
  forceUnit: string;
  torqueUnit: string;
  theme: ResolvedViewerTheme;
  view: ChartViewState;
}

const buildXAxis = (
  model: ChartModel,
  context: BuildOptionContext,
): ChartAxisOption => {
  const colors = OPTION_THEMES[context.theme];
  const latest = model.latestTimeMs;
  const windowMs = context.view.windowSeconds * 1_000;
  return {
    type: "value",
    min:
      context.view.followLive && latest !== null
        ? Math.max(0, latest - windowMs)
        : null,
    max: context.view.followLive ? latest : null,
    axisLine: { lineStyle: { color: colors.border } },
    axisLabel: {
      color: colors.muted,
      formatter: (value) =>
        latest === null ? "0" : ((value - latest) / 1_000).toFixed(1),
    },
    splitLine: { lineStyle: { color: colors.splitLine, width: 1 } },
  };
};

const buildYAxis = (
  name: string,
  theme: ResolvedViewerTheme,
  position: "left" | "right" = "left",
): ChartAxisOption => {
  const colors = OPTION_THEMES[theme];
  return {
    type: "value",
    name,
    position,
    scale: true,
    axisLine: { lineStyle: { color: colors.border } },
    axisLabel: { color: colors.muted },
    nameTextStyle: { color: colors.muted },
    splitLine: { lineStyle: { color: colors.splitLine, width: 1 } },
  };
};

const buildSeries = (
  model: ChartModel,
  axis: Axis,
  context: BuildOptionContext,
): ChartSeriesOption => {
  const style = AXIS_STYLES[axis];
  const unit = axisUnit(axis, context.forceUnit, context.torqueUnit);
  return {
    name: axis,
    type: "line",
    yAxisIndex: axis.startsWith("F") ? 0 : 1,
    data: model.series(axis).map((point) => [point.timeMs, point.value]),
    animation: false,
    showSymbol: false,
    progressive: 0,
    progressiveThreshold: 0,
    lineStyle: {
      color: style.color,
      type: style.lineType,
      width: 1.5,
    },
    itemStyle: { color: style.color },
    emphasis: { focus: "series" },
    tooltip: {
      valueFormatter: (value) =>
        `${typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(value)} ${unit}`,
    },
  };
};

const selectedAxes = (visibleAxes: readonly Axis[]): Record<Axis, boolean> => {
  const visible = new Set(visibleAxes);
  return Object.fromEntries(
    AXES.map((axis) => [axis, visible.has(axis)]),
  ) as Record<Axis, boolean>;
};

const commonTooltip = (
  theme: ResolvedViewerTheme,
): CombinedChartOption["tooltip"] => {
  const colors = OPTION_THEMES[theme];
  return {
    trigger: "axis",
    axisPointer: { type: "line", snap: true },
    backgroundColor: colors.tooltipBackground,
    borderColor: colors.border,
    textStyle: { color: colors.ink },
  };
};

const commonDataZoom = (
  xAxisIndex: number | number[],
): CombinedChartOption["dataZoom"] => [
  {
    type: "inside",
    xAxisIndex,
    filterMode: "none",
    zoomOnMouseWheel: true,
    moveOnMouseMove: true,
  },
];

export const buildCombinedOption = (
  model: ChartModel,
  context: BuildOptionContext,
): CombinedChartOption => {
  const colors = OPTION_THEMES[context.theme];
  return {
    animation: false,
    backgroundColor: colors.background,
    aria: { enabled: true },
    color: AXES.map((axis) => AXIS_STYLES[axis].color),
    grid: {
      left: 16,
      right: 28,
      top: 32,
      bottom: 18,
      containLabel: true,
    },
    legend: {
      show: false,
      type: "scroll",
      bottom: 5,
      textStyle: { color: colors.ink },
      selected: selectedAxes(context.view.visibleAxes),
    },
    tooltip: commonTooltip(context.theme),
    dataZoom: commonDataZoom(0),
    xAxis: buildXAxis(model, context),
    yAxis: [
      buildYAxis(
        `Force (${displayUnit(context.forceUnit)})`,
        context.theme,
        "left",
      ),
      buildYAxis(
        `Torque (${displayUnit(context.torqueUnit)})`,
        context.theme,
        "right",
      ),
    ],
    series: AXES.map((axis) => buildSeries(model, axis, context)),
  };
};

export const buildPanelOption = (
  model: ChartModel,
  axis: Axis,
  context: BuildOptionContext,
): PanelChartOption => {
  const colors = OPTION_THEMES[context.theme];
  return {
    animation: false,
    backgroundColor: colors.background,
    aria: { enabled: true },
    grid: {
      left: 8,
      right: 12,
      top: 28,
      bottom: 10,
      containLabel: true,
    },
    legend: {
      show: false,
      selected: selectedAxes(context.view.visibleAxes),
    },
    tooltip: commonTooltip(context.theme),
    dataZoom: commonDataZoom(0),
    xAxis: buildXAxis(model, context),
    yAxis: buildYAxis(
      `${axis} (${axisUnit(axis, context.forceUnit, context.torqueUnit)})`,
      context.theme,
    ),
    series: [{ ...buildSeries(model, axis, context), yAxisIndex: 0 }],
  };
};
