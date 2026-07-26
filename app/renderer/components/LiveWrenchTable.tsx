import { memo } from "react";

import type { SidebarHandlers } from "./ConnectionPanel";
import { AXES, type AppState, type Axis } from "../model/app-state";

interface AxisRowProps {
  axis: Axis;
  index: number;
  state: AppState;
}

const displayUnit = (unit: string): string =>
  unit === "unknown" ? "" : unit.replace("-", "·");

const AxisRow = ({ axis, index, state }: AxisRowProps) => {
  const raw = state.wrench.raw[index] ?? 0;
  const value = state.wrench.calibrated[index] ?? 0;
  const unit =
    index < 3 ? state.configuration.forceUnit : state.configuration.torqueUnit;

  return (
    <tr>
      <th scope="row">{axis}</th>
      <td data-testid={`raw-${axis}`}>{raw.toLocaleString("en-US")}</td>
      <td data-testid={`value-${axis}`}>
        {value.toFixed(3)} {displayUnit(unit)}
      </td>
    </tr>
  );
};

const isRecordingActive = (state: AppState): boolean =>
  !["idle", "error"].includes(state.recording.state);

const LiveWrenchTableView = ({
  state,
  onPause,
  onBias,
  onRecord,
  onStop,
}: { state: AppState } & SidebarHandlers) => {
  const streaming =
    state.backend.state === "running" && state.connection === "streaming";
  const recordingActive = isRecordingActive(state);
  const stopPending = state.recording.state === "stopping";

  return (
    <section className="sidebar-section wrench-panel">
      <h2>Live wrench</h2>
      <div className="wrench-table-frame">
        <table aria-label="Live wrench" data-testid="wrench-table">
          <caption className="sr-only">
            Raw and calibrated force and torque axes
          </caption>
          <thead>
            <tr>
              <th scope="col">Axis</th>
              <th scope="col">Raw</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {AXES.map((axis, index) => (
              <AxisRow axis={axis} index={index} key={axis} state={state} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="configuration-revision">
        Configuration revision{" "}
        <span data-testid="configuration-revision">
          {state.configuration.available ? state.configuration.revision : "—"}
        </span>
      </p>
      <div className="measurement-actions" aria-label="Sensor actions">
        <button
          className="button button-secondary"
          data-testid="pause-action"
          disabled={!streaming}
          onClick={onPause}
          type="button"
        >
          {state.paused ? "Resume" : "Pause"}
        </button>
        <button
          className="button button-secondary"
          data-testid="bias-action"
          disabled={!streaming || state.paused}
          onClick={onBias}
          type="button"
        >
          Bias
        </button>
        {recordingActive ? (
          <button
            className="button button-danger-outline"
            data-testid="recording-action"
            disabled={stopPending}
            onClick={onStop}
            type="button"
          >
            Stop
          </button>
        ) : (
          <button
            className="button button-danger"
            data-testid="recording-action"
            disabled={!streaming || state.paused}
            onClick={onRecord}
            type="button"
          >
            Record
          </button>
        )}
      </div>
    </section>
  );
};

export const LiveWrenchTable = memo(
  LiveWrenchTableView,
  (previous, next) =>
    previous.state.backend.state === next.state.backend.state &&
    previous.state.connection === next.state.connection &&
    previous.state.paused === next.state.paused &&
    previous.state.wrench === next.state.wrench &&
    previous.state.configuration === next.state.configuration &&
    previous.state.recording.state === next.state.recording.state &&
    previous.onPause === next.onPause &&
    previous.onBias === next.onBias &&
    previous.onRecord === next.onRecord &&
    previous.onStop === next.onStop,
);
