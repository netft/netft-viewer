import { describe, expect, it } from "vitest";

import type { RendererEvent } from "../../app/main/companion-supervisor";
import {
  appReducer,
  createInitialAppState,
  type AppState,
} from "../../app/renderer/model/app-state";

const protocol = { major: 1 as const, minor: 0 };

const streamingState = (): AppState => ({
  ...createInitialAppState(),
  backend: {
    state: "running",
    restartPending: false,
    startAttempts: 1,
    lastError: "",
    lastMonotonicNs: "0",
  },
  connection: "streaming",
  connectionGeneration: "1",
  paused: false,
  wrench: {
    ...createInitialAppState().wrench,
    rdtSequence: 1,
    sampleMonotonicNs: "100",
    raw: [1, 2, 3, 4, 5, 6],
    calibrated: [1, 2, 3, 4, 5, 6],
  },
});

const connectionEvent = (
  state: "disconnected" | "streaming" | "reconnecting",
  generation: string,
  paused = false,
  monotonicNs = "100",
): RendererEvent => ({
  protocol,
  type: "connection_state",
  monotonicNs,
  payload: {
    state,
    paused,
    generation,
    lastError: "",
  },
});

const wrenchEvent = (
  sequence: number,
  sampleMonotonicNs: string,
): RendererEvent => ({
  protocol,
  type: "live_wrench",
  monotonicNs: sampleMonotonicNs,
  payload: {
    hostTimeNs: sampleMonotonicNs,
    sampleMonotonicNs,
    rdtSequence: sequence,
    ftSequence: sequence,
    status: 0,
    raw: [12, -23, 34, -45, 56, -67],
    force: [1.2, -2.3, 3.4],
    torque: [-4.5, 5.6, -6.7],
    forceUnit: "N",
    torqueUnit: "N-mm",
    configurationRevision: "3",
  },
});

const healthEvent = (
  receiveRateHz: number,
  monotonicNs: string,
): RendererEvent => ({
  protocol,
  type: "health",
  monotonicNs,
  payload: {
    state: "streaming",
    faultCode: "none",
    sensorHost: "192.168.1.1",
    rdtPort: 49_152,
    sensorConfiguration: {
      productName: "ATI Net F/T",
      countsPerForceUnit: 1_000_000,
      countsPerTorqueUnit: 1_000_000,
      forceUnit: "N",
      torqueUnit: "N-mm",
      source: "sensor",
      revision: "3",
    },
    lastRdtSequence: 4,
    lastFtSequence: 4,
    lastStatus: 0,
    receiveRateHz,
    deliveryRateHz: receiveRateHz - 1,
    receivedCount: "100",
    deliveredCount: "99",
    rateLimitedCount: "0",
    deviceErrorCount: "0",
    warningCount: "0",
    lostCount: "1",
    duplicateCount: "0",
    outOfOrderCount: "0",
    malformedCount: "0",
    reconnectCount: "0",
    timeoutCount: "0",
    callbackErrorCount: "0",
    ftStallCount: "0",
    ftBackwardCount: "0",
    ftRestartCount: "0",
    calibrationChangeCount: "0",
    lastRecordAgeNs: "1000",
    lastError: "",
    lastFtProgress: "advancing",
  },
});

describe("renderer state", () => {
  it("freezes measurements while paused but continues health updates", () => {
    const paused = appReducer(
      streamingState(),
      connectionEvent("streaming", "1", true, "101"),
    );
    const afterWrench = appReducer(paused, wrenchEvent(2, "200"));
    const afterHealth = appReducer(afterWrench, healthEvent(1_000, "201"));

    expect(afterWrench.wrench.rdtSequence).toBe(1);
    expect(afterHealth.health.receiveRateHz).toBe(1_000);
  });

  it("rejects stale per-stream timestamps without blocking newer streams", () => {
    const withWrench = appReducer(streamingState(), wrenchEvent(8, "400"));
    const withHealth = appReducer(withWrench, healthEvent(900, "500"));
    const staleWrench = appReducer(withHealth, wrenchEvent(7, "399"));
    const staleHealth = appReducer(staleWrench, healthEvent(100, "499"));

    expect(staleHealth.wrench.rdtSequence).toBe(8);
    expect(staleHealth.health.receiveRateHz).toBe(900);
  });

  it("ignores connection events from an older generation", () => {
    const current = appReducer(
      streamingState(),
      connectionEvent("streaming", "12", false, "800"),
    );
    const stale = appReducer(
      current,
      connectionEvent("disconnected", "11", false, "900"),
    );

    expect(stale.connection).toBe("streaming");
    expect(stale.connectionGeneration).toBe("12");
  });

  it("clears live session data when the sensor disconnects", () => {
    const populated = appReducer(
      {
        ...streamingState(),
        recording: {
          ...createInitialAppState().recording,
          state: "recording",
          bytesWritten: "4096",
        },
      },
      wrenchEvent(9, "900"),
    );
    const disconnected = appReducer(
      populated,
      connectionEvent("disconnected", "2", true, "901"),
    );

    expect(disconnected.paused).toBe(false);
    expect(disconnected.wrench.rdtSequence).toBeNull();
    expect(disconnected.plot.lastBatch).toBeNull();
    expect(disconnected.recording.state).toBe("idle");
    expect(disconnected.recording.bytesWritten).toBe("0");
  });

  it("does not repopulate measurements after disconnect", () => {
    const disconnected = appReducer(
      streamingState(),
      connectionEvent("disconnected", "2", false, "901"),
    );
    const delayed = appReducer(disconnected, wrenchEvent(10, "902"));

    expect(delayed.wrench.rdtSequence).toBeNull();
  });

  it("does not apply recording progress after the recording becomes idle", () => {
    const recording = appReducer(streamingState(), {
      protocol,
      type: "recording_state",
      monotonicNs: "1000",
      payload: {
        state: "recording",
        partialPath: "/recording.csv.partial",
        lastError: "",
      },
    });
    const idle = appReducer(recording, {
      protocol,
      type: "recording_state",
      monotonicNs: "1100",
      payload: {
        state: "idle",
        partialPath: "",
        lastError: "",
      },
    });
    const delayedProgress = appReducer(idle, {
      protocol,
      type: "recording_progress",
      monotonicNs: "1200",
      payload: {
        acceptedSamples: "10",
        writtenSamples: "10",
        bytesWritten: "4096",
        queueSize: "0",
        queueCapacity: "65536",
      },
    });

    expect(delayedProgress.recording.bytesWritten).toBe("0");
    expect(delayedProgress.recording.state).toBe("idle");
  });

  it("revokes sensor and recording state when the backend exits", () => {
    const active: AppState = {
      ...streamingState(),
      paused: true,
      recording: {
        ...createInitialAppState().recording,
        state: "paused",
        bytesWritten: "4096",
      },
    };
    const disconnected = appReducer(active, {
      type: "backend_disconnected",
      monotonicNs: "1000",
      payload: { restartPending: true },
    });

    expect(disconnected.backend.state).toBe("starting");
    expect(disconnected.connection).toBe("disconnected");
    expect(disconnected.recording.state).toBe("idle");
    expect(disconnected.recording.bytesWritten).toBe("0");
  });

  it("accepts only increasing configuration revisions", () => {
    const configured = appReducer(streamingState(), {
      protocol,
      type: "configuration_changed",
      monotonicNs: "1000",
      payload: {
        productName: "New calibration",
        countsPerForceUnit: 10,
        countsPerTorqueUnit: 20,
        forceUnit: "N",
        torqueUnit: "N-mm",
        source: "sensor",
        revision: "7",
      },
    });
    const stale = appReducer(configured, {
      protocol,
      type: "configuration_changed",
      monotonicNs: "1001",
      payload: {
        productName: "Old calibration",
        countsPerForceUnit: 1,
        countsPerTorqueUnit: 1,
        forceUnit: "lbf",
        torqueUnit: "lbf-in",
        source: "override",
        revision: "6",
      },
    });

    expect(stale.configuration.productName).toBe("New calibration");
    expect(stale.configuration.revision).toBe("7");
  });

  it("accepts a lower configuration revision after connection generation changes", () => {
    const sensorA = appReducer(streamingState(), {
      protocol,
      type: "configuration_changed",
      monotonicNs: "1000",
      payload: {
        productName: "Sensor A",
        countsPerForceUnit: 10,
        countsPerTorqueUnit: 20,
        forceUnit: "lbf",
        torqueUnit: "lbf-in",
        source: "sensor",
        revision: "10",
      },
    });
    const sensorBSession = appReducer(
      sensorA,
      connectionEvent("streaming", "2", false, "1100"),
    );
    const sensorB = appReducer(sensorBSession, {
      protocol,
      type: "configuration_changed",
      monotonicNs: "1200",
      payload: {
        productName: "Sensor B",
        countsPerForceUnit: 30,
        countsPerTorqueUnit: 40,
        forceUnit: "N",
        torqueUnit: "N-mm",
        source: "sensor",
        revision: "1",
      },
    });

    expect(sensorB.configuration.productName).toBe("Sensor B");
    expect(sensorB.configuration.revision).toBe("1");
    expect(sensorB.health.productName).toBe("Sensor B");
  });

  it("preserves sensor identity across a same-generation reconnect", () => {
    const configured = appReducer(streamingState(), {
      protocol,
      type: "configuration_changed",
      monotonicNs: "1000",
      payload: {
        productName: "Stable identity",
        countsPerForceUnit: 10,
        countsPerTorqueUnit: 20,
        forceUnit: "N",
        torqueUnit: "N-mm",
        source: "sensor",
        revision: "10",
      },
    });
    const withSequence = appReducer(configured, {
      protocol,
      type: "error",
      monotonicNs: "1001",
      payload: {
        operation: "sensor",
        message: "transient",
        sequence: "8",
        droppedBefore: "0",
      },
    });
    const reconnecting = appReducer(
      withSequence,
      connectionEvent("reconnecting", "1", false, "1002"),
    );
    const recovered = appReducer(
      reconnecting,
      connectionEvent("streaming", "1", false, "1003"),
    );

    expect(recovered.configuration.productName).toBe("Stable identity");
    expect(recovered.configuration.revision).toBe("10");
    expect(recovered.configuration.forceUnit).toBe("N");
    expect(recovered.health.productName).toBe("Stable identity");
    expect(recovered.lastErrorSequence).toBe("8");
  });

  it("accepts a lower error sequence after a backend restart", () => {
    const faulted = appReducer(streamingState(), {
      protocol,
      type: "error",
      monotonicNs: "1000",
      payload: {
        operation: "sensor",
        message: "old",
        sequence: "10",
        droppedBefore: "0",
      },
    });
    const disconnected = appReducer(faulted, {
      type: "backend_disconnected",
      monotonicNs: "1100",
      payload: { restartPending: true },
    });
    const restarted = appReducer(disconnected, {
      type: "backend_state",
      monotonicNs: "1200",
      payload: { state: "running", startAttempts: 1 },
    });
    const current = appReducer(restarted, {
      protocol,
      type: "error",
      monotonicNs: "1300",
      payload: {
        operation: "sensor",
        message: "current",
        sequence: "1",
        droppedBefore: "0",
      },
    });

    expect(current.lastErrorSequence).toBe("1");
    expect(current.health.latestError).toBe("current");
  });

  it("keeps configuration events authoritative over health and wrench metadata", () => {
    const configured = appReducer(streamingState(), {
      protocol,
      type: "configuration_changed",
      monotonicNs: "1000",
      payload: {
        productName: "Authoritative",
        countsPerForceUnit: 10,
        countsPerTorqueUnit: 20,
        forceUnit: "N",
        torqueUnit: "N-mm",
        source: "sensor",
        revision: "2",
      },
    });
    const health = appReducer(configured, healthEvent(1_000, "1100"));
    const wrench = appReducer(health, wrenchEvent(20, "1200"));

    expect(wrench.configuration.productName).toBe("Authoritative");
    expect(wrench.configuration.revision).toBe("2");
    expect(wrench.configuration.forceUnit).toBe("N");
    expect(wrench.configuration.torqueUnit).toBe("N-mm");
  });

  it("keeps a paused sample in its native units across configuration changes", () => {
    const sampled = appReducer(streamingState(), wrenchEvent(20, "1000"));
    const paused = appReducer(
      sampled,
      connectionEvent("streaming", "1", true, "1001"),
    );
    const reconfigured = appReducer(paused, {
      protocol,
      type: "configuration_changed",
      monotonicNs: "1002",
      payload: {
        productName: "Updated",
        countsPerForceUnit: 100,
        countsPerTorqueUnit: 200,
        forceUnit: "lbf",
        torqueUnit: "lbf-in",
        source: "sensor",
        revision: "4",
      },
    });

    expect(reconfigured.wrench.forceUnit).toBe("N");
    expect(reconfigured.wrench.torqueUnit).toBe("N-mm");
    expect(reconfigured.wrench.configurationRevision).toBe("3");
    expect(reconfigured.configuration.forceUnit).toBe("lbf");
    expect(reconfigured.configuration.revision).toBe("4");
  });

  it("accepts validated preferences injected by the main-process boundary", () => {
    const initial = createInitialAppState({
      sensorHost: "sensor.example",
      plotMode: "panels",
      timeWindowSeconds: 30,
      visibleAxes: ["Fx", "Tz"],
      theme: "dark",
    });

    expect(initial.sensorHost).toBe("sensor.example");
    expect(initial.preferences.visibleAxes).toEqual(["Fx", "Tz"]);
    expect(initial.preferences.timeWindowSeconds).toBe(30);
  });
});
