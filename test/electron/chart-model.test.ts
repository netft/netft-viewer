import { describe, expect, it } from "vitest";

import type { RendererEvent } from "../../app/main/companion-supervisor";
import {
  AXIS_STYLES,
  ChartModel,
  buildCombinedOption,
  buildPanelOption,
  createChartViewState,
  reduceChartViewState,
} from "../../app/renderer/model/chart-model";
import { AXES } from "../../app/renderer/model/app-state";

type PlotBatchEvent = Extract<RendererEvent, { type: "plot_batch" }>;

const batch = (
  points: ReadonlyArray<readonly [hostTimeNs: string, value: number]>,
): PlotBatchEvent => ({
  protocol: { major: 1, minor: 0 },
  type: "plot_batch",
  monotonicNs: points.at(-1)?.[0] ?? "0",
  payload: {
    axes: [
      {
        axis: "Fx",
        points: points.map(([hostTimeNs, value]) => ({ hostTimeNs, value })),
      },
      {
        axis: "Fy",
        points: points.map(([hostTimeNs, value]) => ({
          hostTimeNs,
          value: value + 10,
        })),
      },
      {
        axis: "Fz",
        points: points.map(([hostTimeNs, value]) => ({
          hostTimeNs,
          value: value + 20,
        })),
      },
      {
        axis: "Tx",
        points: points.map(([hostTimeNs, value]) => ({
          hostTimeNs,
          value: value + 30,
        })),
      },
      {
        axis: "Ty",
        points: points.map(([hostTimeNs, value]) => ({
          hostTimeNs,
          value: value + 40,
        })),
      },
      {
        axis: "Tz",
        points: points.map(([hostTimeNs, value]) => ({
          hostTimeNs,
          value: value + 50,
        })),
      },
    ],
  },
});

describe("ChartModel", () => {
  it("subtracts a bigint session origin before converting nanoseconds", () => {
    const model = new ChartModel(10_000);
    model.append(
      batch([
        ["9007199254740993000", 1],
        ["9007199254741993000", 2],
      ]),
    );

    expect(model.series("Fx").map((point) => point.timeMs)).toEqual([0, 1]);
  });

  it("evicts every axis against the newest accepted point", () => {
    const model = new ChartModel(10_000);
    model.append(batch([["1000000000", 1]]));
    model.append(batch([["12000000000", 2]]));

    for (const axis of AXES) {
      expect(model.series(axis).map((point) => point.timeMs)).toEqual([11_000]);
    }
    expect(model.pointCount).toBe(6);
  });

  it("merges out-of-order points chronologically and replaces duplicates", () => {
    const model = new ChartModel(10_000);
    model.append(
      batch([
        ["3000000", 3],
        ["1000000", 1],
        ["2000000", 2],
        ["2000000", 9],
      ]),
    );

    expect(
      model.series("Fx").map(({ hostTimeNs, value }) => [hostTimeNs, value]),
    ).toEqual([
      ["1000000", 1],
      ["2000000", 9],
      ["3000000", 3],
    ]);
  });

  it("discards late points outside the retained window", () => {
    const model = new ChartModel(1_000);
    model.append(batch([["10000000000", 1]]));
    model.append(batch([["12000000000", 2]]));
    model.append(batch([["10500000000", 3]]));

    expect(model.series("Fx").map((point) => point.hostTimeNs)).toEqual([
      "12000000000",
    ]);
  });

  it("resets both retained data and the per-session origin", () => {
    const model = new ChartModel(10_000);
    model.append(batch([["9007199254740993000", 1]]));
    model.reset();
    model.append(batch([["1000", 2]]));

    expect(model.series("Fx")).toEqual([
      { hostTimeNs: "1000", timeMs: 0, value: 2 },
    ]);
    expect(model.pointCount).toBe(6);
  });

  it("applies a shorter active window immediately", () => {
    const model = new ChartModel(10_000);
    model.append(
      batch([
        ["0", 1],
        ["5000000000", 2],
        ["10000000000", 3],
      ]),
    );
    model.setWindowMs(1_000);

    expect(model.series("Fx").map((point) => point.value)).toEqual([3]);
  });
});

describe("chart interaction state", () => {
  it("switches views without mutating the shared chart data", () => {
    const model = new ChartModel(10_000);
    model.append(batch([["0", 1]]));
    const before = model.pointCount;
    const panels = reduceChartViewState(createChartViewState(), {
      type: "mode_changed",
      mode: "panels",
    });

    expect(panels.mode).toBe("panels");
    expect(model.pointCount).toBe(before);
  });

  it("preserves visibility while changing the time window", () => {
    const state = reduceChartViewState(createChartViewState(), {
      type: "axis_visibility_changed",
      axis: "Fy",
      visible: false,
    });
    const resized = reduceChartViewState(state, {
      type: "window_changed",
      seconds: 30,
    });

    expect(resized.visibleAxes).not.toContain("Fy");
    expect(resized.windowSeconds).toBe(30);
  });

  it("uses only the five approved rolling windows", () => {
    const state = reduceChartViewState(createChartViewState(), {
      type: "window_changed",
      seconds: 60,
    });

    expect(state.windowSeconds).toBe(60);
  });
});

describe("ECharts option builders", () => {
  it("keeps a fixed relative time axis while samples move through the window", () => {
    const model = new ChartModel(10_000);
    model.append(
      batch([
        ["1000000000", 1],
        ["2000000000", 2],
      ]),
    );
    const option = buildCombinedOption(model, {
      forceUnit: "N",
      torqueUnit: "N-mm",
      theme: "light",
      view: createChartViewState(),
    });

    expect(option.xAxis.min).toBe(-10_000);
    expect(option.xAxis.max).toBe(0);
    expect(option.series[0]?.data).toEqual([
      [-1_000, 1],
      [0, 2],
    ]);
    expect("dataZoom" in option).toBe(false);
  });

  it("uses RGB by dimension and line style by force or torque", () => {
    expect(AXIS_STYLES.Fx.color).toBe(AXIS_STYLES.Tx.color);
    expect(AXIS_STYLES.Fy.color).toBe(AXIS_STYLES.Ty.color);
    expect(AXIS_STYLES.Fz.color).toBe(AXIS_STYLES.Tz.color);
    expect(
      new Set([
        AXIS_STYLES.Fx.color,
        AXIS_STYLES.Fy.color,
        AXIS_STYLES.Fz.color,
      ]).size,
    ).toBe(3);
    expect(
      [AXIS_STYLES.Fx, AXIS_STYLES.Fy, AXIS_STYLES.Fz].every(
        (style) => style.lineType === "solid",
      ),
    ).toBe(true);
    expect(
      [AXIS_STYLES.Tx, AXIS_STYLES.Ty, AXIS_STYLES.Tz].every(
        (style) => style.lineType === "dashed",
      ),
    ).toBe(true);
  });

  it("aligns force and torque zero ticks in the combined view", () => {
    const model = new ChartModel(10_000);
    model.append(batch([["0", -1]]));
    const option = buildCombinedOption(model, {
      forceUnit: "N",
      torqueUnit: "N-mm",
      theme: "light",
      view: createChartViewState(),
    });

    expect(option.yAxis[0].scale).toBe(false);
    expect(option.yAxis[1].scale).toBe(false);
    expect(option.yAxis[1].alignTicks).toBe(true);
    for (const axis of option.yAxis) {
      expect(axis.min).toBeLessThan(0);
      expect(axis.max).toBeGreaterThan(0);
      expect(Math.abs(axis.min as number)).toBe(axis.max);
    }
  });

  it("reserves fixed-width y-axis labels with stable decimal precision", () => {
    const model = new ChartModel(10_000);
    model.append(batch([["0", 2]]));
    const option = buildCombinedOption(model, {
      forceUnit: "N",
      torqueUnit: "N-mm",
      theme: "light",
      view: createChartViewState(),
    });

    expect(option.yAxis[0].axisLabel.width).toBe(76);
    expect(option.yAxis[1].axisLabel.width).toBe(76);
    expect(option.yAxis[0].axisLabel.align).toBe("right");
    expect(option.yAxis[1].axisLabel.align).toBe("left");
    expect(option.yAxis[0].axisLabel.formatter?.(0.7433496)).toBe("0.743");
    expect(option.yAxis[1].axisLabel.formatter?.(-0.0183792)).toBe("-0.018");
    expect(option.yAxis[0].axisLabel.formatter?.(-0.0001)).toBe("0.000");
  });

  it("maps six combined series to force and torque axes without animation", () => {
    const model = new ChartModel(10_000);
    model.append(batch([["0", 1]]));
    const option = buildCombinedOption(model, {
      forceUnit: "N",
      torqueUnit: "N-mm",
      theme: "light",
      view: createChartViewState(),
    });

    expect(option.series).toHaveLength(6);
    expect(option.series.map((series) => series.yAxisIndex)).toEqual([
      0, 0, 0, 1, 1, 1,
    ]);
    expect(option.series.every((series) => series.animation === false)).toBe(
      true,
    );
    expect(option.series.every((series) => series.progressive === 0)).toBe(
      true,
    );
    expect(
      new Set(option.series.map((series) => series.lineStyle.type)).size,
    ).toBeGreaterThan(1);
    expect(option.yAxis.map((axis) => axis.position)).toEqual([
      "left",
      "right",
    ]);
    expect(option.yAxis[0].name).toContain("N");
    expect(option.yAxis[1].name).toContain("N·mm");
    expect(option.aria.enabled).toBe(true);
    expect(Object.keys(AXIS_STYLES)).toEqual(AXES);
  });

  it("builds a symmetric single-axis panel with a visible empty scale", () => {
    const model = new ChartModel(10_000);
    const option = buildPanelOption(model, "Ty", {
      forceUnit: "N",
      torqueUnit: "N-mm",
      theme: "light",
      view: createChartViewState(),
    });

    expect(option.series).toHaveLength(1);
    expect(option.series[0]?.name).toBe("Ty");
    expect(option.series[0]?.yAxisIndex).toBe(0);
    expect(option.yAxis.scale).toBe(false);
    expect(option.yAxis.min).toBe(-1);
    expect(option.yAxis.max).toBe(1);
    expect(option.yAxis.splitLine.lineStyle.width).toBe(1);
    expect(option.yAxis.position).toBe("left");
    expect(option.animation).toBe(false);
  });
});
