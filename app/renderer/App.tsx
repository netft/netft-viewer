import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import type { RendererEvent } from "../main/companion-supervisor";
import type { PreferencesPatch } from "../main/settings-store";
import type { MenuCommand, MenuState } from "../shared/menu-contract";
import { Actions } from "./components/Actions";
import { BackendErrorView } from "./components/BackendErrorView";
import { ChartWorkspace } from "./components/ChartWorkspace";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { LiveWrenchTable } from "./components/LiveWrenchTable";
import { StatusPanel } from "./components/StatusPanel";
import { TitleBar } from "./components/TitleBar";
import {
  AXES,
  appReducer,
  createInitialAppState,
  type Preferences,
} from "./model/app-state";
import { createRendererEventScheduler } from "./model/event-scheduler";

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

interface ConnectionScope {
  backendEpoch: string;
  connectionGeneration: string;
}

interface PendingConnection {
  commandComplete: boolean;
  kind: "connect" | "disconnect";
  scope: ConnectionScope;
  token: number;
}

const connectionScope = (state: ReturnType<typeof createInitialAppState>) => ({
  backendEpoch: state.backend.lastMonotonicNs,
  connectionGeneration: state.connectionGeneration,
});

const sameConnectionScope = (
  left: ConnectionScope,
  right: ConnectionScope,
): boolean =>
  left.backendEpoch === right.backendEpoch &&
  left.connectionGeneration === right.connectionGeneration;

const mergePreferences = (
  preferences: Preferences,
  patch: PreferencesPatch,
): Preferences => ({
  ...preferences,
  ...patch,
  visibleAxes:
    patch.visibleAxes === undefined
      ? [...preferences.visibleAxes]
      : [...patch.visibleAxes],
});

export const App = ({ initialPreferences }: AppProps) => {
  const [state, dispatch] = useReducer(
    appReducer,
    initialPreferences,
    createInitialAppState,
  );
  const theme = "light" as const;
  const stateRef = useRef(state);
  stateRef.current = state;
  const [connectionPending, setConnectionPending] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [windowFocused, setWindowFocused] = useState(true);
  const menuActionHandlerRef = useRef<
    ((command: MenuCommand) => void) | undefined
  >(undefined);
  const connectionPendingRef = useRef<PendingConnection | undefined>(undefined);
  const connectionTokenRef = useRef(0);
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

  const schedulePreferenceFlush = useCallback((): void => {
    if (preferenceTimerRef.current !== undefined) {
      window.clearTimeout(preferenceTimerRef.current);
    }
    preferenceTimerRef.current = window.setTimeout(flushPreferences, 250);
  }, [flushPreferences]);

  useEffect(() => {
    if (initialPreferences !== undefined) {
      return;
    }
    let active = true;
    void window.netft
      .getPreferences()
      .then((preferences) => {
        if (!active) {
          return;
        }
        const queuedPatch = pendingPreferencesRef.current;
        const hasQueuedPatch = Object.keys(queuedPatch).length > 0;
        const merged = mergePreferences(preferences, queuedPatch);
        dispatch({ type: "preferences_received", preferences: merged });
        hydratedPreferencesRef.current = true;
        if (hasQueuedPatch) {
          pendingPreferencesRef.current = merged;
          schedulePreferenceFlush();
        }
      })
      .catch(() => {
        if (!active) {
          return;
        }
        const queuedPatch = pendingPreferencesRef.current;
        const hasQueuedPatch = Object.keys(queuedPatch).length > 0;
        const merged = mergePreferences(
          stateRef.current.preferences,
          queuedPatch,
        );
        dispatch({
          type: "settings_error",
          monotonicNs: "1",
          payload: {
            operation: "read",
            errorCode: "settings_unavailable",
          },
        });
        hydratedPreferencesRef.current = true;
        if (hasQueuedPatch) {
          pendingPreferencesRef.current = merged;
          schedulePreferenceFlush();
        }
      });
    return () => {
      active = false;
    };
  }, [initialPreferences, schedulePreferenceFlush]);

  useEffect(
    () => () => {
      if (preferenceTimerRef.current !== undefined) {
        window.clearTimeout(preferenceTimerRef.current);
      }
      flushPreferences();
    },
    [flushPreferences],
  );

  const changePreferences = useCallback(
    (patch: PreferencesPatch): void => {
      dispatch({ type: "preferences_patched", patch });
      pendingPreferencesRef.current = {
        ...pendingPreferencesRef.current,
        ...patch,
      };
      if (!hydratedPreferencesRef.current) {
        return;
      }
      schedulePreferenceFlush();
    },
    [schedulePreferenceFlush],
  );

  const changeHost = useCallback((sensorHost: string) => {
    dispatch({ type: "sensor_host_changed", sensorHost });
  }, []);
  const clearConnectionPending = useCallback((token?: number): void => {
    const pending = connectionPendingRef.current;
    if (
      pending !== undefined &&
      (token === undefined || pending.token === token)
    ) {
      connectionPendingRef.current = undefined;
      setConnectionPending(false);
    }
  }, []);
  const completeConnectionIfAuthoritative = useCallback((): void => {
    const pending = connectionPendingRef.current;
    if (pending === undefined || !pending.commandComplete) {
      return;
    }
    if (
      stateRef.current.backend.state !== "running" ||
      !sameConnectionScope(pending.scope, connectionScope(stateRef.current))
    ) {
      clearConnectionPending(pending.token);
      return;
    }
    const reached =
      pending.kind === "connect"
        ? !["disconnected", "error"].includes(stateRef.current.connection)
        : stateRef.current.connection === "disconnected";
    if (reached) {
      clearConnectionPending(pending.token);
    }
  }, [clearConnectionPending]);

  useEffect(() => {
    const pending = connectionPendingRef.current;
    if (
      pending !== undefined &&
      (state.backend.state !== "running" ||
        !sameConnectionScope(pending.scope, connectionScope(state)))
    ) {
      clearConnectionPending(pending.token);
      return;
    }
    completeConnectionIfAuthoritative();
  }, [
    clearConnectionPending,
    completeConnectionIfAuthoritative,
    state.backend.lastMonotonicNs,
    state.backend.state,
    state.connection,
    state.connectionGeneration,
  ]);

  const runConnection = useCallback(
    (kind: "connect" | "disconnect"): void => {
      if (connectionPendingRef.current !== undefined) {
        return;
      }
      const token = ++connectionTokenRef.current;
      const scope = connectionScope(stateRef.current);
      connectionPendingRef.current = {
        kind,
        commandComplete: false,
        scope,
        token,
      };
      setConnectionPending(true);
      const request =
        kind === "connect"
          ? window.netft.connect(stateRef.current.sensorHost)
          : window.netft.disconnect();
      void request
        .then((result) => {
          const pending = connectionPendingRef.current;
          if (
            pending?.kind !== kind ||
            pending.token !== token ||
            !sameConnectionScope(scope, connectionScope(stateRef.current)) ||
            stateRef.current.backend.state !== "running"
          ) {
            clearConnectionPending(token);
            return;
          }
          if (!result.success) {
            clearConnectionPending(token);
            return;
          }
          pending.commandComplete = true;
          completeConnectionIfAuthoritative();
        })
        .catch(() => {
          clearConnectionPending(token);
        });
    },
    [clearConnectionPending, completeConnectionIfAuthoritative],
  );
  const connect = useCallback(() => {
    runConnection("connect");
  }, [runConnection]);
  const disconnect = useCallback(() => {
    runConnection("disconnect");
  }, [runConnection]);
  const registerMenuActionHandler = useCallback(
    (handler: (command: MenuCommand) => void) => {
      menuActionHandlerRef.current = handler;
      return () => {
        if (menuActionHandlerRef.current === handler) {
          menuActionHandlerRef.current = undefined;
        }
      };
    },
    [],
  );

  const dispatchMenuCommand = useCallback(
    (command: MenuCommand): void => {
      switch (command.type) {
        case "connect":
          runConnection("connect");
          return;
        case "disconnect":
          runConnection("disconnect");
          return;
        case "set-plot-mode":
          changePreferences({ plotMode: command.mode });
          return;
        case "set-time-window":
          changePreferences({ timeWindowSeconds: command.seconds });
          return;
        case "toggle-axis": {
          const selected = new Set(stateRef.current.preferences.visibleAxes);
          if (selected.has(command.axis)) {
            selected.delete(command.axis);
          } else {
            selected.add(command.axis);
          }
          changePreferences({
            visibleAxes: AXES.filter((axis) => selected.has(axis)),
          });
          return;
        }
        case "toggle-pause":
        case "bias":
        case "toggle-recording":
          menuActionHandlerRef.current?.(command);
          return;
      }
    },
    [changePreferences, runConnection],
  );

  useEffect(
    () => window.netft.subscribeMenuCommands(dispatchMenuCommand),
    [dispatchMenuCommand],
  );
  useEffect(
    () =>
      window.netft.subscribeWindowState(
        ({ focused, fullScreen: nextFullScreen }) => {
          setWindowFocused(focused);
          setFullScreen(nextFullScreen);
        },
      ),
    [],
  );

  const menuState = useMemo<MenuState>(
    () => ({
      backendRunning: state.backend.state === "running",
      connection: state.connection,
      connectionPending,
      actionPending,
      paused: state.paused,
      recordingActive: !["idle", "error"].includes(state.recording.state),
      hasSensorHost: state.sensorHost.trim().length > 0,
      plotMode: state.preferences.plotMode,
      timeWindowSeconds: state.preferences.timeWindowSeconds,
      visibleAxes: state.preferences.visibleAxes,
    }),
    [
      actionPending,
      connectionPending,
      state.backend.state,
      state.connection,
      state.paused,
      state.preferences.plotMode,
      state.preferences.timeWindowSeconds,
      state.preferences.visibleAxes,
      state.recording.state,
      state.sensorHost,
    ],
  );

  useEffect(() => {
    window.netft.publishMenuState(menuState);
  }, [menuState]);

  return (
    <div
      className={`desktop-window theme-${theme}`}
      data-full-screen={fullScreen}
      data-testid="desktop-window"
      data-theme={theme}
    >
      <TitleBar
        focused={windowFocused}
        fullScreen={fullScreen}
        menuState={menuState}
        onMenuCommand={dispatchMenuCommand}
        performWindowCommand={window.netft.performWindowCommand}
        platform={window.netft.platform}
      />
      <div
        className="viewer-shell"
        data-testid="viewer-shell"
        data-theme={theme}
      >
        <aside className="sensor-sidebar">
          <ConnectionPanel
            onConnect={connect}
            onDisconnect={disconnect}
            onHostChange={changeHost}
            actionPending={connectionPending}
            state={state}
          />
          <div
            className="sidebar-scroll-region"
            data-testid="sidebar-scroll-region"
          >
            <StatusPanel state={state} />
            <LiveWrenchTable state={state} />
            {state.settingsErrorCode.length > 0 ? (
              <output
                className="settings-warning"
                data-error-code={state.settingsErrorCode}
                role="status"
              >
                Preferences could not be saved. Current controls remain active.
              </output>
            ) : null}
          </div>
          <footer
            className="sidebar-action-dock"
            data-testid="sidebar-action-dock"
          >
            <Actions
              api={window.netft}
              disabled={connectionPending}
              onPendingChange={setActionPending}
              registerMenuHandler={registerMenuActionHandler}
              state={state}
            />
          </footer>
        </aside>
        {state.backend.state === "failed" ? (
          <BackendErrorView api={window.netft} state={state} />
        ) : (
          <ChartWorkspace
            onPreferencesChange={changePreferences}
            registerEventSink={registerChartEventSink}
            state={state}
            theme={theme}
          />
        )}
      </div>
    </div>
  );
};
