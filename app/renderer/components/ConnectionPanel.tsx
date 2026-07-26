import { memo, type ChangeEvent } from "react";

import type { AppState } from "../model/app-state";

export interface SidebarHandlers {
  onHostChange?: (host: string) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onPause?: () => void;
  onBias?: () => void;
  onRecord?: () => void;
  onStop?: () => void;
}

export interface ConnectionPanelProps extends SidebarHandlers {
  state: AppState;
}

const ACTIVE_CONNECTION_STATES = new Set([
  "connecting",
  "streaming",
  "reconnecting",
  "disconnecting",
]);

const ConnectionPanelView = ({
  state,
  onHostChange,
  onConnect,
  onDisconnect,
}: ConnectionPanelProps) => {
  const active = ACTIVE_CONNECTION_STATES.has(state.connection);
  const canConnect =
    state.backend.state === "running" &&
    !active &&
    state.sensorHost.trim().length > 0;
  const canDisconnect =
    state.backend.state === "running" &&
    active &&
    state.connection !== "disconnecting";
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onHostChange?.(event.currentTarget.value);
  };

  return (
    <section className="sidebar-section connection-panel">
      <h2>Sensor connection</h2>
      <div className="connection-controls">
        <label className="sensor-host-field">
          <span className="sr-only">Sensor IP address</span>
          <span className="field-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 5v4M5 19v-4h14v4M5 15V9h14v6M9 19H3v3h6zm12 0h-6v3h6zM15 2H9v3h6z" />
            </svg>
          </span>
          <input
            aria-label="Sensor IP address"
            autoCapitalize="none"
            autoComplete="off"
            data-testid="sensor-host-input"
            disabled={active}
            onChange={handleChange}
            spellCheck={false}
            type="text"
            value={state.sensorHost}
          />
        </label>
        {active ? (
          <button
            className="button button-secondary"
            data-testid="connection-action"
            disabled={!canDisconnect}
            onClick={onDisconnect}
            type="button"
          >
            Disconnect
          </button>
        ) : (
          <button
            className="button button-primary"
            data-testid="connection-action"
            disabled={!canConnect}
            onClick={onConnect}
            type="button"
          >
            Connect
          </button>
        )}
      </div>
    </section>
  );
};

export const ConnectionPanel = memo(
  ConnectionPanelView,
  (previous, next) =>
    previous.state.backend.state === next.state.backend.state &&
    previous.state.connection === next.state.connection &&
    previous.state.sensorHost === next.state.sensorHost &&
    previous.onHostChange === next.onHostChange &&
    previous.onConnect === next.onConnect &&
    previous.onDisconnect === next.onDisconnect,
);
