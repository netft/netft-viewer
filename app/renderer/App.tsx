import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { RendererEvent } from "../main/companion-supervisor";
import type { PreferencesPatch } from "../main/settings-store";
import { Actions } from "./components/Actions";
import { BackendErrorView } from "./components/BackendErrorView";
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
  const stateRef = useRef(state);
  stateRef.current = state;
  const [connectionPending, setConnectionPending] = useState(false);
  const connectionPendingRef = useRef<
    { kind: "connect" | "disconnect"; commandComplete: boolean } | undefined
  >(undefined);
  const hydratedPreferencesRef = useRef(initialPreferences !== undefined);
  const pendingPreferencesRef = useRef<PreferencesPatch>({});
  const preferenceTimerRef = useRef<number | undefined>(undefined);
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

  useEffect(() => {
    if (initialPreferences !== undefined) {
      return;
    }
    let active = true;
    void window.netft
      .getPreferences()
      .then((preferences) => {
        if (active) {
          dispatch({ type: "preferences_received", preferences });
        }
      })
      .catch(() => {
        if (active) {
          dispatch({
            type: "settings_error",
            monotonicNs: "1",
            payload: {
              operation: "read",
              errorCode: "settings_unavailable",
            },
          });
        }
      })
      .finally(() => {
        if (active) {
          hydratedPreferencesRef.current = true;
        }
      });
    return () => {
      active = false;
    };
  }, [initialPreferences]);

  const flushPreferences = useCallback((): void => {
    preferenceTimerRef.current = undefined;
    const patch = pendingPreferencesRef.current;
    pendingPreferencesRef.current = {};
    if (Object.keys(patch).length === 0) {
      return;
    }
    void window.netft.updatePreferences(patch).catch(() => {
      dispatch({
        type: "settings_error",
        monotonicNs: "1",
        payload: {
          operation: "write",
          errorCode: "settings_unavailable",
        },
      });
    });
  }, []);

  useEffect(
    () => () => {
      if (preferenceTimerRef.current !== undefined) {
        window.clearTimeout(preferenceTimerRef.current);
        flushPreferences();
      }
    },
    [flushPreferences],
  );

  const changePreferences = useCallback(
    (patch: PreferencesPatch): void => {
      dispatch({ type: "preferences_patched", patch });
      if (!hydratedPreferencesRef.current) {
        return;
      }
      pendingPreferencesRef.current = {
        ...pendingPreferencesRef.current,
        ...patch,
      };
      if (preferenceTimerRef.current !== undefined) {
        window.clearTimeout(preferenceTimerRef.current);
      }
      preferenceTimerRef.current = window.setTimeout(flushPreferences, 250);
    },
    [flushPreferences],
  );

  const changeHost = useCallback((sensorHost: string) => {
    dispatch({ type: "sensor_host_changed", sensorHost });
  }, []);
  const completeConnectionIfAuthoritative = useCallback((): void => {
    const pending = connectionPendingRef.current;
    if (pending === undefined || !pending.commandComplete) {
      return;
    }
    const reached =
      pending.kind === "connect"
        ? !["disconnected", "error"].includes(stateRef.current.connection)
        : stateRef.current.connection === "disconnected";
    if (reached) {
      connectionPendingRef.current = undefined;
      setConnectionPending(false);
    }
  }, []);

  useEffect(() => {
    completeConnectionIfAuthoritative();
  }, [completeConnectionIfAuthoritative, state.connection]);

  const runConnection = useCallback(
    (kind: "connect" | "disconnect"): void => {
      if (connectionPendingRef.current !== undefined) {
        return;
      }
      connectionPendingRef.current = { kind, commandComplete: false };
      setConnectionPending(true);
      const request =
        kind === "connect"
          ? window.netft.connect(stateRef.current.sensorHost)
          : window.netft.disconnect();
      void request
        .then((result) => {
          const pending = connectionPendingRef.current;
          if (pending?.kind !== kind) {
            return;
          }
          if (!result.success) {
            connectionPendingRef.current = undefined;
            setConnectionPending(false);
            return;
          }
          pending.commandComplete = true;
          completeConnectionIfAuthoritative();
        })
        .catch(() => {
          connectionPendingRef.current = undefined;
          setConnectionPending(false);
        });
    },
    [completeConnectionIfAuthoritative],
  );
  const connect = useCallback(() => {
    runConnection("connect");
  }, [runConnection]);
  const disconnect = useCallback(() => {
    runConnection("disconnect");
  }, [runConnection]);

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
          actionPending={connectionPending}
          state={state}
        />
        <StatusPanel state={state} />
        <LiveWrenchTable state={state} />
        <Actions
          api={window.netft}
          disabled={connectionPending}
          state={state}
        />
        {state.settingsErrorCode.length > 0 ? (
          <output
            className="settings-warning"
            data-error-code={state.settingsErrorCode}
            role="status"
          >
            Preferences could not be saved. Current controls remain active.
          </output>
        ) : null}
      </aside>
      {state.backend.state === "failed" ? (
        <BackendErrorView api={window.netft} state={state} />
      ) : (
        <ChartWorkspace
          onPreferencesChange={changePreferences}
          registerEventSink={registerChartEventSink}
          state={state}
          theme={theme}
          themePreference={state.preferences.theme}
        />
      )}
    </div>
  );
};
