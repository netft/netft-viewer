import { useCallback, useEffect, useReducer, useRef } from "react";

import type { RendererEvent } from "../main/companion-supervisor";
import { ChartWorkspace } from "./components/ChartWorkspace";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { LiveWrenchTable } from "./components/LiveWrenchTable";
import { StatusPanel } from "./components/StatusPanel";
import {
  appReducer,
  createInitialAppState,
  type Preferences,
} from "./model/app-state";
import { createRendererEventScheduler } from "./model/event-scheduler";
import { useViewerTheme } from "./model/viewer-theme";

const invoke = (request: Promise<unknown>): void => {
  void request.catch(() => {
    // Structured backend and command failures arrive through renderer events.
  });
};

const scheduleDisplayFrame = (callback: FrameRequestCallback): number =>
  typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame(callback)
    : window.setTimeout(() => callback(performance.now()), 16);

const cancelDisplayFrame = (handle: number): void => {
  if (typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(handle);
  } else {
    window.clearTimeout(handle);
  }
};

export interface AppProps {
  initialPreferences?: Preferences;
}

export const App = ({ initialPreferences }: AppProps) => {
  const [state, dispatch] = useReducer(
    appReducer,
    initialPreferences,
    createInitialAppState,
  );
  const theme = useViewerTheme(state.preferences.theme);
  const chartEventSinkRef = useRef<
    ((event: RendererEvent) => void) | undefined
  >(undefined);
  const registerChartEventSink = useCallback(
    (sink: (event: RendererEvent) => void) => {
      chartEventSinkRef.current = sink;
      return () => {
        if (chartEventSinkRef.current === sink) {
          chartEventSinkRef.current = undefined;
        }
      };
    },
    [],
  );

  useEffect(() => {
    const scheduler = createRendererEventScheduler({
      dispatch: (event) => {
        chartEventSinkRef.current?.(event);
        dispatch(event);
      },
      scheduleFrame: scheduleDisplayFrame,
      cancelFrame: cancelDisplayFrame,
    });
    const unsubscribe = window.netft.subscribe(scheduler.push);
    return () => {
      unsubscribe();
      scheduler.dispose();
    };
  }, []);

  const changeHost = useCallback((sensorHost: string) => {
    dispatch({ type: "sensor_host_changed", sensorHost });
  }, []);
  const connect = useCallback(() => {
    invoke(window.netft.connect(state.sensorHost));
  }, [state.sensorHost]);
  const disconnect = useCallback(() => {
    invoke(window.netft.disconnect());
  }, []);
  const togglePause = useCallback(() => {
    invoke(window.netft.setPaused(!state.paused));
  }, [state.paused]);
  const bias = useCallback(() => {
    invoke(window.netft.requestBias());
  }, []);
  const record = useCallback(() => {
    invoke(window.netft.startRecording());
  }, []);
  const stop = useCallback(() => {
    invoke(window.netft.stopRecording());
  }, []);

  return (
    <div
      className={`viewer-shell theme-${theme}`}
      data-testid="viewer-shell"
      data-theme={theme}
      data-theme-preference={state.preferences.theme}
    >
      <aside className="sensor-sidebar">
        <header className="product-heading">
          <svg aria-hidden="true" className="product-mark" viewBox="0 0 32 32">
            <circle cx="9" cy="23" r="2" />
            <path d="M9 23V8m0 15h15M9 23 22 10M9 8l-2 3m2-3 2 3m13 12-3-2m3 2-3 2m1-15h-4m4 0v4" />
          </svg>
          <h1>Net F/T Viewer</h1>
        </header>
        <ConnectionPanel
          onConnect={connect}
          onDisconnect={disconnect}
          onHostChange={changeHost}
          state={state}
        />
        <StatusPanel state={state} />
        <LiveWrenchTable
          onBias={bias}
          onPause={togglePause}
          onRecord={record}
          onStop={stop}
          state={state}
        />
      </aside>
      <ChartWorkspace
        registerEventSink={registerChartEventSink}
        state={state}
        theme={theme}
      />
    </div>
  );
};
