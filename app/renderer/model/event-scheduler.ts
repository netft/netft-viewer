import type { RendererEvent } from "../../main/companion-supervisor";

export interface RendererEventSchedulerOptions {
  dispatch: (event: RendererEvent) => void;
  scheduleFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
}

export interface RendererEventScheduler {
  push(event: RendererEvent): void;
  dispose(): void;
}

export const createRendererEventScheduler = (
  options: RendererEventSchedulerOptions,
): RendererEventScheduler => {
  let latestWrench: Extract<RendererEvent, { type: "live_wrench" }> | undefined;
  let frameHandle: number | undefined;
  let frameGeneration = 0;
  let disposed = false;

  const flush = (generation: number): void => {
    if (generation !== frameGeneration) {
      return;
    }
    frameHandle = undefined;
    if (disposed) {
      latestWrench = undefined;
      return;
    }
    const event = latestWrench;
    latestWrench = undefined;
    if (event !== undefined) {
      options.dispatch(event);
    }
  };

  const revokePendingWrench = (): void => {
    frameGeneration += 1;
    latestWrench = undefined;
    if (frameHandle !== undefined) {
      options.cancelFrame(frameHandle);
      frameHandle = undefined;
    }
  };

  const isScopeBoundary = (event: RendererEvent): boolean =>
    event.type === "configuration_changed" ||
    event.type === "connection_state" ||
    event.type === "backend_disconnected" ||
    event.type === "backend_state";

  return {
    push: (event) => {
      if (disposed) {
        return;
      }
      if (event.type !== "live_wrench") {
        if (isScopeBoundary(event)) {
          revokePendingWrench();
        }
        options.dispatch(event);
        return;
      }
      latestWrench = event;
      if (frameHandle === undefined) {
        const generation = ++frameGeneration;
        frameHandle = options.scheduleFrame(() => flush(generation));
      }
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      revokePendingWrench();
    },
  };
};
