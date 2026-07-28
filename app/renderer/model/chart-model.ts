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
  Fx: { color: "#d63c3c", lineType: "solid" },
  Fy: { color: "#16966a", lineType: "solid" },
  Fz: { color: "#2563d9", lineType: "solid" },
  Tx: { color: "#d63c3c", lineType: "dashed" },
  Ty: { color: "#16966a", lineType: "dashed" },
  Tz: { color: "#2563d9", lineType: "dashed" },
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
    background: "#fcfcfb",
    ink: "#20211f",
    muted: "#70726d",
    border: "#c4c6c0",
    splitLine: "#e6e7e2",
    tooltipBackground: "#ffffff",
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
  nameLocation?: "middle";
  nameGap?: number;
  position?: "left" | "right";
  min?: number | null;
  max?: number | null;
  scale?: boolean;
  alignTicks?: boolean;
  axisLine: { lineStyle: { color: string } };
  axisLabel: {
    color: string;
    width?: number;
    align?: "left" | "right";
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
  const windowMs = context.view.windowSeconds * 1_000;
  return {
    type: "value",
    min: -windowMs,
    max: 0,
    axisLine: { lineStyle: { color: colors.border } },
    axisLabel: {
      color: colors.muted,
      formatter: (value) => (value / 1_000).toFixed(1),
    },
    splitLine: { lineStyle: { color: colors.splitLine, width: 1 } },
  };
};

const buildYAxis = (
  name: string,
  theme: ResolvedViewerTheme,
  position: "left" | "right" = "left",
  scale = true,
  alignTicks = false,
  extent?: readonly [min: number, max: number],
): ChartAxisOption => {
  const colors = OPTION_THEMES[theme];
  const formatLabel = (value: number): string =>
    (Math.abs(value) < 0.0005 ? 0 : value).toFixed(3);
  return {
    type: "value",
    name,
    nameLocation: "middle",
    nameGap: 48,
    position,
    scale,
    alignTicks,
    min: extent?.[0],
    max: extent?.[1],
    axisLine: { lineStyle: { color: colors.border } },
    axisLabel: {
      color: colors.muted,
      width: 76,
      align: position === "left" ? "right" : "left",
      formatter: formatLabel,
    },
    nameTextStyle: { color: colors.muted },
    splitLine: { lineStyle: { color: colors.splitLine, width: 1 } },
  };
};

const symmetricExtent = (
  model: ChartModel,
  axes: readonly Axis[],
): readonly [number, number] => {
  const magnitude = Math.max(
    0,
    ...axes.flatMap((axis) =>
      model.series(axis).map((point) => Math.abs(point.value)),
    ),
  );
  const paddedMagnitude = magnitude === 0 ? 1 : magnitude * 1.05;
  return [-paddedMagnitude, paddedMagnitude];
};

const buildSeries = (
  model: ChartModel,
  axis: Axis,
  context: BuildOptionContext,
): ChartSeriesOption => {
  const style = AXIS_STYLES[axis];
  const unit = axisUnit(axis, context.forceUnit, context.torqueUnit);
  const latest = model.latestTimeMs ?? 0;
  return {
    name: axis,
    type: "line",
    yAxisIndex: axis.startsWith("F") ? 0 : 1,
    data: model
      .series(axis)
      .map((point) => [point.timeMs - latest, point.value]),
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

export const buildCombinedOption = (
  model: ChartModel,
  context: BuildOptionContext,
): CombinedChartOption => {
  const colors = OPTION_THEMES[context.theme];
  const forceExtent = symmetricExtent(model, ["Fx", "Fy", "Fz"]);
  const torqueExtent = symmetricExtent(model, ["Tx", "Ty", "Tz"]);
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
    xAxis: buildXAxis(model, context),
    yAxis: [
      buildYAxis(
        `Force (${displayUnit(context.forceUnit)})`,
        context.theme,
        "left",
        false,
        false,
        forceExtent,
      ),
      buildYAxis(
        `Torque (${displayUnit(context.torqueUnit)})`,
        context.theme,
        "right",
        false,
        true,
        torqueExtent,
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
  const extent = symmetricExtent(model, [axis]);
  return {
    animation: false,
    backgroundColor: colors.background,
    aria: { enabled: true },
    grid: {
      left: 28,
      right: 18,
      top: 28,
      bottom: 10,
      containLabel: true,
    },
    legend: {
      show: false,
      selected: selectedAxes(context.view.visibleAxes),
    },
    tooltip: commonTooltip(context.theme),
    xAxis: buildXAxis(model, context),
    yAxis: buildYAxis(
      `${axis} (${axisUnit(axis, context.forceUnit, context.torqueUnit)})`,
      context.theme,
      "left",
      false,
      false,
      extent,
    ),
    series: [{ ...buildSeries(model, axis, context), yAxisIndex: 0 }],
  };
};
