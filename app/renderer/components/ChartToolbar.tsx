import { memo, type CSSProperties } from "react";

import {
  AXIS_STYLES,
  TIME_WINDOWS_SECONDS,
  type ChartViewAction,
  type ChartViewState,
} from "../model/chart-model";
import { AXES } from "../model/app-state";

export interface ChartToolbarProps {
  view: ChartViewState;
  dispatch: (action: ChartViewAction) => void;
}

export const ChartToolbar = memo(({ view, dispatch }: ChartToolbarProps) => (
  <div className="chart-toolbar" data-testid="chart-toolbar">
    <div aria-label="Plot view" className="chart-control-group">
      <button
        aria-pressed={view.mode === "combined"}
        className="chart-toolbar-button"
        data-testid="chart-mode-combined"
        onClick={() => {
          dispatch({ type: "mode_changed", mode: "combined" });
        }}
        type="button"
      >
        Combined
      </button>
      <button
        aria-pressed={view.mode === "panels"}
        className="chart-toolbar-button"
        data-testid="chart-mode-panels"
        onClick={() => {
          dispatch({ type: "mode_changed", mode: "panels" });
        }}
        type="button"
      >
        6 panels
      </button>
    </div>

    <div aria-label="Time window" className="chart-control-group">
      {TIME_WINDOWS_SECONDS.map((seconds) => (
        <button
          aria-pressed={view.windowSeconds === seconds}
          className="chart-toolbar-button chart-window-button"
          data-testid={`chart-window-${seconds}`}
          data-window-seconds={seconds}
          key={seconds}
          onClick={() => {
            dispatch({ type: "window_changed", seconds });
          }}
          type="button"
        >
          {seconds}s
        </button>
      ))}
    </div>

    <div aria-label="Series visibility" className="chart-series-controls">
      {AXES.map((axis) => {
        const visible = view.visibleAxes.includes(axis);
        return (
          <button
            aria-pressed={visible}
            className="chart-series-button"
            data-testid={`axis-visibility-${axis}`}
            key={axis}
            onClick={() => {
              dispatch({
                type: "axis_visibility_changed",
                axis,
                visible: !visible,
              });
            }}
            type="button"
          >
            <span
              aria-hidden="true"
              className={`series-swatch series-swatch-${AXIS_STYLES[axis].lineType}`}
              style={
                {
                  "--series-color": AXIS_STYLES[axis].color,
                } as CSSProperties
              }
            />
            {axis}
          </button>
        );
      })}
    </div>

    <div className="chart-control-group chart-view-actions">
      <button
        className="chart-toolbar-button"
        data-testid="chart-reset"
        onClick={() => {
          dispatch({ type: "view_reset" });
        }}
        type="button"
      >
        Reset view
      </button>
      <button
        aria-pressed={view.followLive}
        className="chart-toolbar-button chart-live-button"
        data-testid="chart-live"
        onClick={() => {
          dispatch({ type: "live_requested" });
        }}
        type="button"
      >
        <span aria-hidden="true" className="live-indicator" />
        Live
      </button>
    </div>
  </div>
));

ChartToolbar.displayName = "ChartToolbar";
