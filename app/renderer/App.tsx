import { memo, useCallback, useEffect, useReducer } from "react";

import { ConnectionPanel } from "./components/ConnectionPanel";
import { LiveWrenchTable } from "./components/LiveWrenchTable";
import { StatusPanel } from "./components/StatusPanel";
import { appReducer, createInitialAppState } from "./model/app-state";

const PlotWorkspacePlaceholder = memo(() => (
  <section
    aria-label="Plot workspace"
    className="plot-workspace"
    data-testid="plot-workspace"
  />
));

const invoke = (request: Promise<unknown>): void => {
  void request.catch(() => {
    // Structured backend and command failures arrive through renderer events.
  });
};

export const App = () => {
  const [state, dispatch] = useReducer(
    appReducer,
    undefined,
    createInitialAppState,
  );

  useEffect(() => window.netft.subscribe(dispatch), []);

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
    <div className="viewer-shell">
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
      <PlotWorkspacePlaceholder />
    </div>
  );
};
