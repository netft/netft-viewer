import { memo } from "react";

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
  const unit = index < 3 ? state.wrench.forceUnit : state.wrench.torqueUnit;

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

const LiveWrenchTableView = ({ state }: { state: AppState }) => {
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
    previous.state.configuration === next.state.configuration,
);
