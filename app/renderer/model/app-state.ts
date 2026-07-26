import type { RendererEvent } from "../../main/companion-supervisor";

export const AXES = ["Fx", "Fy", "Fz", "Tx", "Ty", "Tz"] as const;
export type Axis = (typeof AXES)[number];
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "disconnecting"
  | "error";
export type BackendState =
  "stopped" | "starting" | "running" | "stopping" | "failed";
export type RecordingState =
  | "idle"
  | "starting"
  | "recording"
  | "pausing"
  | "paused"
  | "stopping"
  | "error";
export type PlotMode = "combined" | "panels";
export type ViewerTheme = "light" | "dark" | "system";

type PlotBatchEvent = Extract<RendererEvent, { type: "plot_batch" }>;

export interface Preferences {
  sensorHost: string;
  plotMode: PlotMode;
  timeWindowSeconds: 1 | 5 | 10 | 30 | 60;
  visibleAxes: Axis[];
  theme: ViewerTheme;
}

export interface BackendView {
  state: BackendState;
  restartPending: boolean;
  startAttempts: number;
  lastError: string;
  lastMonotonicNs: string;
}

export interface HealthView {
  state: "stopped" | "connecting" | "streaming" | "backoff" | "faulted";
  faultCode: string;
  sensorHost: string;
  productName: string;
  receiveRateHz: number;
  deliveryRateHz: number;
  packetLossPercent: number;
  deviceStatus: number;
  latestError: string;
  lastMonotonicNs: string;
}

export interface WrenchView {
  rdtSequence: number | null;
  ftSequence: number | null;
  sampleMonotonicNs: string;
  raw: [number, number, number, number, number, number];
  calibrated: [number, number, number, number, number, number];
  forceUnit: string;
  torqueUnit: string;
  configurationRevision: string;
}

export interface RecordingView {
  state: RecordingState;
  partialPath: string;
  lastError: string;
  startedMonotonicNs: string;
  elapsedNs: string;
  bytesWritten: string;
  queueSize: string;
  queueCapacity: string;
  lastMonotonicNs: string;
}

export interface PlotView {
  lastBatch: PlotBatchEvent | null;
  lastMonotonicNs: string;
}

export interface ConfigurationView {
  productName: string;
  forceUnit: string;
  torqueUnit: string;
  revision: string;
  lastMonotonicNs: string;
}

export interface AppState {
  backend: BackendView;
  connection: ConnectionState;
  connectionGeneration: string;
  connectionMonotonicNs: string;
  paused: boolean;
  sensorHost: string;
  health: HealthView;
  wrench: WrenchView;
  recording: RecordingView;
  plot: PlotView;
  configuration: ConfigurationView;
  preferences: Preferences;
  lastErrorSequence: string;
}

export type AppAction =
  | RendererEvent
  | { type: "sensor_host_changed"; sensorHost: string }
  | { type: "preferences_received"; preferences: Preferences };

const DEFAULT_PREFERENCES: Preferences = {
  sensorHost: "192.168.1.1",
  plotMode: "combined",
  timeWindowSeconds: 10,
  visibleAxes: [...AXES],
  theme: "system",
};

const emptyWrench = (): WrenchView => ({
  rdtSequence: null,
  ftSequence: null,
  sampleMonotonicNs: "0",
  raw: [0, 0, 0, 0, 0, 0],
  calibrated: [0, 0, 0, 0, 0, 0],
  forceUnit: "N",
  torqueUnit: "N-mm",
  configurationRevision: "0",
});

const emptyRecording = (): RecordingView => ({
  state: "idle",
  partialPath: "",
  lastError: "",
  startedMonotonicNs: "0",
  elapsedNs: "0",
  bytesWritten: "0",
  queueSize: "0",
  queueCapacity: "65536",
  lastMonotonicNs: "0",
});

const compareDecimal = (left: string, right: string): number => {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
};

const isNewer = (candidate: string, current: string): boolean =>
  compareDecimal(candidate, current) > 0;

const clearLiveSession = (state: AppState): AppState => ({
  ...state,
  paused: false,
  health: {
    ...state.health,
    state: "stopped",
    receiveRateHz: 0,
    deliveryRateHz: 0,
    packetLossPercent: 0,
    deviceStatus: 0,
  },
  wrench: emptyWrench(),
  plot: {
    lastBatch: null,
    lastMonotonicNs: "0",
  },
  recording: emptyRecording(),
});

const clearBackendSession = (state: AppState): AppState => ({
  ...clearLiveSession(state),
  connection: "disconnected",
  connectionGeneration: "0",
  connectionMonotonicNs: "0",
  recording: emptyRecording(),
});

export const createInitialAppState = (
  preferences: Preferences = DEFAULT_PREFERENCES,
): AppState => ({
  backend: {
    state: "starting",
    restartPending: true,
    startAttempts: 0,
    lastError: "",
    lastMonotonicNs: "0",
  },
  connection: "disconnected",
  connectionGeneration: "0",
  connectionMonotonicNs: "0",
  paused: false,
  sensorHost: preferences.sensorHost,
  health: {
    state: "stopped",
    faultCode: "none",
    sensorHost: "",
    productName: "",
    receiveRateHz: 0,
    deliveryRateHz: 0,
    packetLossPercent: 0,
    deviceStatus: 0,
    latestError: "",
    lastMonotonicNs: "0",
  },
  wrench: emptyWrench(),
  recording: emptyRecording(),
  plot: {
    lastBatch: null,
    lastMonotonicNs: "0",
  },
  configuration: {
    productName: "",
    forceUnit: "N",
    torqueUnit: "N-mm",
    revision: "0",
    lastMonotonicNs: "0",
  },
  preferences: {
    ...preferences,
    visibleAxes: [...preferences.visibleAxes],
  },
  lastErrorSequence: "0",
});

const reduceConnection = (
  state: AppState,
  event: Extract<RendererEvent, { type: "connection_state" }>,
): AppState => {
  const generationOrder = compareDecimal(
    event.payload.generation,
    state.connectionGeneration,
  );
  if (
    generationOrder < 0 ||
    (generationOrder === 0 &&
      !isNewer(event.monotonicNs, state.connectionMonotonicNs))
  ) {
    return state;
  }
  const next: AppState = {
    ...state,
    connection: event.payload.state,
    connectionGeneration: event.payload.generation,
    connectionMonotonicNs: event.monotonicNs,
    paused: event.payload.paused,
    health: {
      ...state.health,
      latestError: event.payload.lastError,
    },
  };
  return event.payload.state === "disconnected" ? clearLiveSession(next) : next;
};

const reduceHealth = (
  state: AppState,
  event: Extract<RendererEvent, { type: "health" }>,
): AppState => {
  if (!isNewer(event.monotonicNs, state.health.lastMonotonicNs)) {
    return state;
  }
  const received = BigInt(event.payload.receivedCount);
  const lost = BigInt(event.payload.lostCount);
  const attempted = received + lost;
  const packetLossPercent =
    attempted === 0n ? 0 : Number((lost * 1_000_000n) / attempted) / 10_000;
  let configuration = state.configuration;
  const sensorConfiguration = event.payload.sensorConfiguration;
  if (
    sensorConfiguration !== undefined &&
    compareDecimal(sensorConfiguration.revision, configuration.revision) >= 0
  ) {
    configuration = {
      productName: sensorConfiguration.productName,
      forceUnit: sensorConfiguration.forceUnit,
      torqueUnit: sensorConfiguration.torqueUnit,
      revision: sensorConfiguration.revision,
      lastMonotonicNs: event.monotonicNs,
    };
  }
  const connectedHost =
    state.connection === "streaming" && event.payload.sensorHost.length > 0
      ? event.payload.sensorHost
      : state.preferences.sensorHost;
  return {
    ...state,
    health: {
      state: event.payload.state,
      faultCode: event.payload.faultCode,
      sensorHost: event.payload.sensorHost,
      productName: sensorConfiguration?.productName ?? state.health.productName,
      receiveRateHz: event.payload.receiveRateHz,
      deliveryRateHz: event.payload.deliveryRateHz,
      packetLossPercent,
      deviceStatus: event.payload.lastStatus,
      latestError: event.payload.lastError,
      lastMonotonicNs: event.monotonicNs,
    },
    configuration,
    preferences: {
      ...state.preferences,
      sensorHost: connectedHost,
    },
  };
};

const reduceRecordingState = (
  state: AppState,
  event: Extract<RendererEvent, { type: "recording_state" }>,
): AppState => {
  if (
    state.connection !== "streaming" &&
    event.payload.state !== "idle" &&
    event.payload.state !== "error"
  ) {
    return state;
  }
  if (!isNewer(event.monotonicNs, state.recording.lastMonotonicNs)) {
    return state;
  }
  if (event.payload.state === "idle") {
    return {
      ...state,
      recording: {
        ...emptyRecording(),
        lastMonotonicNs: event.monotonicNs,
      },
    };
  }
  const begins =
    state.recording.state === "idle" || state.recording.state === "error";
  return {
    ...state,
    recording: {
      ...state.recording,
      state: event.payload.state,
      partialPath: event.payload.partialPath,
      lastError: event.payload.lastError,
      startedMonotonicNs: begins
        ? event.monotonicNs
        : state.recording.startedMonotonicNs,
      lastMonotonicNs: event.monotonicNs,
    },
  };
};

const reduceRecordingProgress = (
  state: AppState,
  event: Extract<RendererEvent, { type: "recording_progress" }>,
): AppState => {
  if (
    state.recording.state === "idle" ||
    state.recording.state === "error" ||
    !isNewer(event.monotonicNs, state.recording.lastMonotonicNs)
  ) {
    return state;
  }
  const start = BigInt(state.recording.startedMonotonicNs);
  const now = BigInt(event.monotonicNs);
  return {
    ...state,
    recording: {
      ...state.recording,
      elapsedNs: start > 0n && now >= start ? (now - start).toString() : "0",
      bytesWritten: event.payload.bytesWritten,
      queueSize: event.payload.queueSize,
      queueCapacity: event.payload.queueCapacity,
      lastMonotonicNs: event.monotonicNs,
    },
  };
};

export const appReducer = (state: AppState, action: AppAction): AppState => {
  switch (action.type) {
    case "sensor_host_changed":
      return { ...state, sensorHost: action.sensorHost };
    case "preferences_received":
      return createInitialAppState(action.preferences);
    case "backend_disconnected": {
      if (!isNewer(action.monotonicNs, state.backend.lastMonotonicNs)) {
        return state;
      }
      const cleared = clearBackendSession(state);
      return {
        ...cleared,
        backend: {
          ...state.backend,
          state: action.payload.restartPending ? "starting" : "stopped",
          restartPending: action.payload.restartPending,
          lastMonotonicNs: action.monotonicNs,
        },
      };
    }
    case "backend_state": {
      if (!isNewer(action.monotonicNs, state.backend.lastMonotonicNs)) {
        return state;
      }
      const backend = {
        state: action.payload.state,
        restartPending: action.payload.state === "starting",
        startAttempts: action.payload.startAttempts,
        lastError: action.payload.lastError ?? "",
        lastMonotonicNs: action.monotonicNs,
      };
      return action.payload.state === "running"
        ? { ...state, backend }
        : { ...clearBackendSession(state), backend };
    }
    case "connection_state":
      return reduceConnection(state, action);
    case "health":
      return reduceHealth(state, action);
    case "live_wrench":
      if (
        state.paused ||
        state.connection !== "streaming" ||
        !isNewer(
          action.payload.sampleMonotonicNs,
          state.wrench.sampleMonotonicNs,
        )
      ) {
        return state;
      }
      return {
        ...state,
        wrench: {
          rdtSequence: action.payload.rdtSequence,
          ftSequence: action.payload.ftSequence,
          sampleMonotonicNs: action.payload.sampleMonotonicNs,
          raw: action.payload.raw,
          calibrated: [...action.payload.force, ...action.payload.torque],
          forceUnit: action.payload.forceUnit,
          torqueUnit: action.payload.torqueUnit,
          configurationRevision: action.payload.configurationRevision,
        },
      };
    case "plot_batch":
      if (
        state.paused ||
        state.connection !== "streaming" ||
        !isNewer(action.monotonicNs, state.plot.lastMonotonicNs)
      ) {
        return state;
      }
      return {
        ...state,
        plot: {
          lastBatch: action,
          lastMonotonicNs: action.monotonicNs,
        },
      };
    case "recording_state":
      return reduceRecordingState(state, action);
    case "recording_progress":
      return reduceRecordingProgress(state, action);
    case "configuration_changed":
      if (
        compareDecimal(action.payload.revision, state.configuration.revision) <=
        0
      ) {
        return state;
      }
      return {
        ...state,
        configuration: {
          productName: action.payload.productName,
          forceUnit: action.payload.forceUnit,
          torqueUnit: action.payload.torqueUnit,
          revision: action.payload.revision,
          lastMonotonicNs: action.monotonicNs,
        },
      };
    case "error":
      if (
        compareDecimal(action.payload.sequence, state.lastErrorSequence) <= 0
      ) {
        return state;
      }
      return {
        ...state,
        health: {
          ...state.health,
          latestError: action.payload.message,
        },
        recording:
          action.payload.operation === "recording"
            ? { ...state.recording, lastError: action.payload.message }
            : state.recording,
        lastErrorSequence: action.payload.sequence,
      };
    case "hello":
    case "command_result":
      return state;
  }
};
