import { LineChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, useState, type RefObject } from "react";

import type { Axis } from "../model/app-state";

echarts.use([
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  LineChart,
  TooltipComponent,
  CanvasRenderer,
]);

export const PROGRAMMATIC_ZOOM_SOURCE = "netft-viewer-programmatic";

export interface EChartInstance {
  group?: string;
  setOption(option: unknown, options?: unknown): void;
  resize(options?: { width?: number; height?: number }): void;
  dispatchAction(action: Record<string, unknown>): void;
  on(event: string, handler: (event: unknown) => void): void;
  off(event: string, handler: (event: unknown) => void): void;
  dispose(): void;
}

export interface EChartRuntime {
  init(
    container: HTMLElement,
    theme?: string | null,
    options?: {
      renderer: "canvas";
      devicePixelRatio: number;
    },
  ): EChartInstance;
  connect(group: string): void;
}

export const defaultEChartRuntime: EChartRuntime = {
  init: (container, theme, options) =>
    echarts.init(container, theme, options) as EChartInstance,
  connect: (group) => {
    echarts.connect(group);
  },
};

interface DataZoomEvent {
  from?: string;
}

interface LegendSelectionEvent {
  selected?: Partial<Record<Axis, boolean>>;
}

export interface UseEChartOptions {
  option: unknown;
  group?: string;
  followLive: boolean;
  resetRevision: number;
  runtime?: EChartRuntime;
  onManualNavigation: () => void;
  onLegendSelection?: (selection: Partial<Record<Axis, boolean>>) => void;
}

export interface UseEChartResult {
  containerRef: RefObject<HTMLDivElement | null>;
  failed: boolean;
}

const positiveSize = (element: HTMLElement): boolean =>
  element.clientWidth > 0 && element.clientHeight > 0;

export const useEChart = ({
  option,
  group,
  followLive,
  resetRevision,
  runtime = defaultEChartRuntime,
  onManualNavigation,
  onLegendSelection,
}: UseEChartOptions): UseEChartResult => {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<EChartInstance | undefined>(undefined);
  const appliedOptionRef = useRef<unknown>(undefined);
  const optionRef = useRef(option);
  const manualNavigationRef = useRef(onManualNavigation);
  const legendSelectionRef = useRef(onLegendSelection);
  const previousFollowLiveRef = useRef(followLive);
  const previousResetRevisionRef = useRef(resetRevision);
  const [failed, setFailed] = useState(false);

  optionRef.current = option;
  manualNavigationRef.current = onManualNavigation;
  legendSelectionRef.current = onLegendSelection;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    let observer: ResizeObserver | undefined;
    let disposed = false;

    const fail = (instance?: EChartInstance): void => {
      instance?.dispose();
      instanceRef.current = undefined;
      appliedOptionRef.current = undefined;
      if (!disposed) {
        setFailed(true);
      }
    };

    const handleDataZoom = (event: unknown): void => {
      if ((event as DataZoomEvent).from !== PROGRAMMATIC_ZOOM_SOURCE) {
        manualNavigationRef.current();
      }
    };
    const handleLegendSelection = (event: unknown): void => {
      const selection = (event as LegendSelectionEvent).selected;
      if (selection !== undefined) {
        legendSelectionRef.current?.(selection);
      }
    };

    const initialize = (): EChartInstance | undefined => {
      if (
        disposed ||
        instanceRef.current !== undefined ||
        !positiveSize(container)
      ) {
        return instanceRef.current;
      }
      try {
        const instance = runtime.init(container, null, {
          renderer: "canvas",
          devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        });
        instanceRef.current = instance;
        if (group !== undefined) {
          instance.group = group;
          runtime.connect(group);
        }
        instance.on("datazoom", handleDataZoom);
        instance.on("legendselectchanged", handleLegendSelection);
        instance.setOption(optionRef.current, {
          lazyUpdate: true,
          notMerge: false,
        });
        appliedOptionRef.current = optionRef.current;
        setFailed(false);
        return instance;
      } catch {
        fail(instanceRef.current);
        return undefined;
      }
    };

    const resize = (width?: number, height?: number): void => {
      if (
        (width !== undefined && width <= 0) ||
        (height !== undefined && height <= 0)
      ) {
        return;
      }
      const instance = initialize();
      if (instance === undefined) {
        return;
      }
      try {
        instance.resize({ width, height });
      } catch {
        fail(instance);
      }
    };

    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver((entries) => {
        const entry = entries.at(-1);
        resize(entry?.contentRect.width, entry?.contentRect.height);
      });
      observer.observe(container);
    } else {
      const handleWindowResize = () => {
        resize();
      };
      window.addEventListener("resize", handleWindowResize);
      observer = {
        disconnect: () => {
          window.removeEventListener("resize", handleWindowResize);
        },
        observe: () => undefined,
        unobserve: () => undefined,
      } as ResizeObserver;
    }
    initialize();

    return () => {
      disposed = true;
      observer?.disconnect();
      const instance = instanceRef.current;
      if (instance !== undefined) {
        instance.off("datazoom", handleDataZoom);
        instance.off("legendselectchanged", handleLegendSelection);
        instance.dispose();
        instanceRef.current = undefined;
        appliedOptionRef.current = undefined;
      }
    };
  }, [group, runtime]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (instance === undefined || appliedOptionRef.current === option) {
      return;
    }
    try {
      instance.setOption(option, { lazyUpdate: true, notMerge: false });
      appliedOptionRef.current = option;
    } catch {
      instance.dispose();
      instanceRef.current = undefined;
      appliedOptionRef.current = undefined;
      setFailed(true);
    }
  }, [option]);

  useEffect(() => {
    const instance = instanceRef.current;
    const resetChanged = previousResetRevisionRef.current !== resetRevision;
    const returnedToLive = !previousFollowLiveRef.current && followLive;
    previousResetRevisionRef.current = resetRevision;
    previousFollowLiveRef.current = followLive;
    if (instance === undefined || (!resetChanged && !returnedToLive)) {
      return;
    }
    instance.dispatchAction({
      type: "dataZoom",
      start: 0,
      end: 100,
      from: PROGRAMMATIC_ZOOM_SOURCE,
    });
  }, [followLive, resetRevision]);

  return { containerRef, failed };
};
