import { describe, expect, it, vi } from "vitest";

import type { RendererEvent } from "../../app/main/companion-supervisor";
import { createRendererEventScheduler } from "../../app/renderer/model/event-scheduler";

const wrenchEvent = (sequence: number): RendererEvent => ({
  protocol: { major: 1, minor: 0 },
  type: "live_wrench",
  monotonicNs: sequence.toString(),
  payload: {
    hostTimeNs: sequence.toString(),
    sampleMonotonicNs: sequence.toString(),
    rdtSequence: sequence,
    ftSequence: sequence,
    status: 0,
    raw: [sequence, 0, 0, 0, 0, 0],
    force: [sequence, 0, 0],
    torque: [0, 0, 0],
    forceUnit: "N",
    torqueUnit: "N-mm",
    configurationRevision: "1",
  },
});

describe("renderer event scheduler", () => {
  it("coalesces hundreds of wrench events to the latest event per frame", () => {
    const dispatch = vi.fn();
    let frame: FrameRequestCallback | undefined;
    const scheduleFrame = vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 7;
    });
    const scheduler = createRendererEventScheduler({
      dispatch,
      scheduleFrame,
      cancelFrame: vi.fn(),
    });

    for (let sequence = 1; sequence <= 500; sequence += 1) {
      scheduler.push(wrenchEvent(sequence));
    }

    expect(scheduleFrame).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    frame?.(16);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "live_wrench",
      payload: { rdtSequence: 500 },
    });
  });

  it("dispatches control and plot events immediately in arrival order", () => {
    const dispatch = vi.fn();
    const scheduler = createRendererEventScheduler({
      dispatch,
      scheduleFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
    });
    const backend: RendererEvent = {
      type: "backend_state",
      monotonicNs: "1",
      payload: { state: "running", startAttempts: 1 },
    };
    const plot: RendererEvent = {
      protocol: { major: 1, minor: 0 },
      type: "plot_batch",
      monotonicNs: "2",
      payload: {
        axes: [
          { axis: "Fx", points: [] },
          { axis: "Fy", points: [] },
          { axis: "Fz", points: [] },
          { axis: "Tx", points: [] },
          { axis: "Ty", points: [] },
          { axis: "Tz", points: [] },
        ],
      },
    };

    scheduler.push(backend);
    scheduler.push(plot);

    expect(dispatch.mock.calls.map(([event]) => event.type)).toEqual([
      "backend_state",
      "plot_batch",
    ]);
  });

  it("cancels and revokes a pending frame during subscription cleanup", () => {
    const dispatch = vi.fn();
    const cancelFrame = vi.fn();
    let frame: FrameRequestCallback | undefined;
    const scheduler = createRendererEventScheduler({
      dispatch,
      scheduleFrame: (callback) => {
        frame = callback;
        return 9;
      },
      cancelFrame,
    });
    scheduler.push(wrenchEvent(1));

    scheduler.dispose();
    frame?.(16);

    expect(cancelFrame).toHaveBeenCalledWith(9);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("revokes an old sample at a configuration boundary without stealing the next frame", () => {
    const dispatch = vi.fn();
    const frames: FrameRequestCallback[] = [];
    const cancelFrame = vi.fn();
    let handle = 0;
    const scheduler = createRendererEventScheduler({
      dispatch,
      scheduleFrame: (callback) => {
        frames.push(callback);
        handle += 1;
        return handle;
      },
      cancelFrame,
    });
    const configuration: RendererEvent = {
      protocol: { major: 1, minor: 0 },
      type: "configuration_changed",
      monotonicNs: "2",
      payload: {
        productName: "Updated",
        countsPerForceUnit: 10,
        countsPerTorqueUnit: 20,
        forceUnit: "lbf",
        torqueUnit: "lbf-in",
        source: "sensor",
        revision: "2",
      },
    };

    scheduler.push(wrenchEvent(1));
    scheduler.push(configuration);
    scheduler.push(wrenchEvent(2));
    frames[0]?.(16);
    frames[1]?.(32);

    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(dispatch.mock.calls.map(([event]) => event.type)).toEqual([
      "configuration_changed",
      "live_wrench",
    ]);
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
      payload: { rdtSequence: 2 },
    });
  });
});
