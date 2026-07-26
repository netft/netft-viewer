import { memo, type ReactNode } from "react";

import type { AppState } from "../model/app-state";

interface StatusRowProps {
  label: string;
  testId?: string;
  tone?: "success" | "warning" | "danger";
  value: ReactNode;
}

const StatusRow = ({ label, testId, tone, value }: StatusRowProps) => (
  <div className="status-row">
    <dt>{label}</dt>
    <dd className={tone === undefined ? undefined : `tone-${tone}`}>
      <span data-testid={testId}>{value}</span>
    </dd>
  </div>
);

const formatConnection = (state: AppState): string => {
  if (state.connection === "streaming" && state.paused) {
    return "Paused";
  }
  return state.connection.charAt(0).toUpperCase() + state.connection.slice(1);
};

const connectionTone = (
  state: AppState,
): StatusRowProps["tone"] | undefined => {
  if (state.connection === "streaming") {
    return state.paused ? "warning" : "success";
  }
  return state.connection === "error" ? "danger" : undefined;
};

const recordingLabel = (state: AppState): string =>
  state.recording.state.charAt(0).toUpperCase() +
  state.recording.state.slice(1);

const recordingTone = (state: AppState): StatusRowProps["tone"] | undefined =>
  state.recording.state === "error"
    ? "danger"
    : state.recording.state === "recording"
      ? "danger"
      : state.recording.state === "paused"
        ? "warning"
        : undefined;

const formatDuration = (nanoseconds: string): string => {
  const totalSeconds = Number(BigInt(nanoseconds) / 1_000_000_000n);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
};

const formatBytes = (bytes: string): string => {
  const value = Number(BigInt(bytes));
  if (value < 1_000) {
    return `${value} B`;
  }
  if (value < 1_000_000) {
    return `${(value / 1_000).toFixed(1)} kB`;
  }
  if (value < 1_000_000_000) {
    return `${(value / 1_000_000).toFixed(1)} MB`;
  }
  return `${(value / 1_000_000_000).toFixed(1)} GB`;
};

const queuePercent = (state: AppState): number => {
  const size = Number(BigInt(state.recording.queueSize));
  const capacity = Number(BigInt(state.recording.queueCapacity));
  return capacity === 0 ? 0 : Math.min(100, (size / capacity) * 100);
};

const StatusPanelView = ({ state }: { state: AppState }) => {
  const bufferPercent = queuePercent(state);
  const deviceStatus = state.health.deviceStatus;
  const deviceOkay = state.connection === "streaming" && deviceStatus === 0;
  const latestError =
    state.recording.lastError || state.health.latestError || "—";

  return (
    <section className="sidebar-section status-panel">
      <h2>Status</h2>
      <dl className="status-list">
        <StatusRow
          label="Connection"
          tone={connectionTone(state)}
          value={
            <output aria-live="polite" data-testid="connection-state">
              {formatConnection(state)}
            </output>
          }
        />
        <StatusRow
          label="Product"
          testId="product-name"
          value={state.health.productName || "—"}
        />
        <StatusRow
          label="Receive rate"
          testId="receive-rate"
          value={`${state.health.receiveRateHz.toLocaleString("en-US", {
            maximumFractionDigits: 1,
          })} Hz`}
        />
        <StatusRow
          label="Delivery rate"
          testId="delivery-rate"
          value={`${state.health.deliveryRateHz.toLocaleString("en-US", {
            maximumFractionDigits: 1,
          })} Hz`}
        />
        <StatusRow
          label="Packet loss"
          testId="packet-loss"
          tone={state.health.packetLossPercent > 0 ? "warning" : undefined}
          value={`${state.health.packetLossPercent.toFixed(2)}%`}
        />
        <StatusRow
          label="Device status"
          testId="device-status"
          tone={
            state.connection === "streaming"
              ? deviceOkay
                ? "success"
                : "danger"
              : undefined
          }
          value={deviceOkay ? "OK" : `0x${deviceStatus.toString(16)}`}
        />
        <StatusRow
          label="Latest error"
          testId="latest-error"
          tone={latestError === "—" ? undefined : "danger"}
          value={latestError}
        />
        <div className="status-divider" aria-hidden="true" />
        <StatusRow
          label="Recording"
          testId="recording-state"
          tone={recordingTone(state)}
          value={recordingLabel(state)}
        />
        <StatusRow
          label="Duration"
          testId="recording-duration"
          value={formatDuration(state.recording.elapsedNs)}
        />
        <StatusRow
          label="File size"
          testId="recording-bytes"
          value={formatBytes(state.recording.bytesWritten)}
        />
        <div className="status-row status-buffer-row">
          <dt>Buffer</dt>
          <dd>
            <span data-testid="recording-buffer">
              {bufferPercent.toFixed(1)}%
            </span>
            <progress
              aria-label="Recording buffer utilization"
              max={100}
              value={bufferPercent}
            />
          </dd>
        </div>
      </dl>
    </section>
  );
};

export const StatusPanel = memo(
  StatusPanelView,
  (previous, next) =>
    previous.state.connection === next.state.connection &&
    previous.state.paused === next.state.paused &&
    previous.state.health === next.state.health &&
    previous.state.recording === next.state.recording,
);
