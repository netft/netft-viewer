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
  let disposed = false;

  const flush = (): void => {
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

  return {
    push: (event) => {
      if (disposed) {
        return;
      }
      if (event.type !== "live_wrench") {
        options.dispatch(event);
        return;
      }
      latestWrench = event;
      frameHandle ??= options.scheduleFrame(flush);
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      latestWrench = undefined;
      if (frameHandle !== undefined) {
        options.cancelFrame(frameHandle);
        frameHandle = undefined;
      }
    },
  };
};
