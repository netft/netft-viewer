import { memo, useCallback, useEffect, useRef, useState } from "react";

import type { CommandResult } from "../../main/companion-supervisor";
import type { NetftApi } from "../../preload";
import type { AppState } from "../model/app-state";

type PendingAction = "pause" | "bias" | "record" | "stop";

interface PendingEntry {
  commandComplete: boolean;
  expectedState?:
    | { kind: "paused"; value: boolean }
    | { kind: "recording_active" }
    | { kind: "recording_idle" };
}

export interface ActionsProps {
  api: Pick<
    NetftApi,
    "setPaused" | "requestBias" | "startRecording" | "stopRecording"
  >;
  disabled?: boolean;
  onError?: (errorCode: string) => void;
  state: AppState;
}

const isRecordingActive = (state: AppState): boolean =>
  !["idle", "error"].includes(state.recording.state);

const safeErrorCode = (result: CommandResult): string =>
  result.errorCode?.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, "") ||
  "command_failed";

const expectedStateReached = (
  expected: PendingEntry["expectedState"],
  state: AppState,
): boolean => {
  if (expected === undefined) {
    return true;
  }
  switch (expected.kind) {
    case "paused":
      return state.paused === expected.value;
    case "recording_active":
      return !["idle", "error"].includes(state.recording.state);
    case "recording_idle":
      return ["idle", "error"].includes(state.recording.state);
  }
};

const ActionsView = ({
  api,
  disabled = false,
  onError,
  state,
}: ActionsProps) => {
  const pendingRef = useRef(new Map<PendingAction, PendingEntry>());
  const stateRef = useRef(state);
  stateRef.current = state;
  const [pendingRevision, setPendingRevision] = useState(0);
  const [errorCode, setErrorCode] = useState("");
  const streaming =
    state.backend.state === "running" && state.connection === "streaming";
  const recordingActive = isRecordingActive(state);

  const rerenderPending = useCallback(() => {
    setPendingRevision((revision) => revision + 1);
  }, []);

  const removePending = useCallback(
    (action: PendingAction): void => {
      if (pendingRef.current.delete(action)) {
        rerenderPending();
      }
    },
    [rerenderPending],
  );

  const run = useCallback(
    (
      action: PendingAction,
      command: () => Promise<CommandResult>,
      expectedState?: PendingEntry["expectedState"],
    ): void => {
      if (pendingRef.current.has(action)) {
        return;
      }
      setErrorCode("");
      pendingRef.current.set(action, {
        commandComplete: false,
        expectedState,
      });
      rerenderPending();
      void command()
        .then((result) => {
          const entry = pendingRef.current.get(action);
          if (entry === undefined) {
            return;
          }
          if (!result.success) {
            removePending(action);
            if (result.errorCode !== "cancelled") {
              const code = safeErrorCode(result);
              setErrorCode(code);
              onError?.(code);
            }
            return;
          }
          entry.commandComplete = true;
          if (expectedStateReached(entry.expectedState, stateRef.current)) {
            removePending(action);
          }
        })
        .catch(() => {
          removePending(action);
          setErrorCode("command_unavailable");
          onError?.("command_unavailable");
        });
    },
    [onError, removePending, rerenderPending],
  );

  useEffect(() => {
    for (const [action, entry] of pendingRef.current) {
      if (
        entry.commandComplete &&
        expectedStateReached(entry.expectedState, state)
      ) {
        removePending(action);
      }
    }
  }, [
    removePending,
    state.paused,
    state.recording.state,
    state.connection,
    state.backend.state,
  ]);

  const pending = pendingRef.current;
  const pausePending = pending.has("pause");
  const biasPending = pending.has("bias");
  const recordPending = pending.has("record");
  const stopPending = pending.has("stop");
  const transitionPending =
    pausePending || biasPending || recordPending || stopPending;
  void pendingRevision;

  return (
    <>
      <div className="measurement-actions" aria-label="Sensor actions">
        <button
          aria-busy={pausePending}
          className="button button-secondary"
          data-testid="pause-action"
          disabled={disabled || !streaming || transitionPending}
          onClick={() => {
            const target = !state.paused;
            run("pause", async () => api.setPaused(target), {
              kind: "paused",
              value: target,
            });
          }}
          type="button"
        >
          {state.paused ? "Resume" : "Pause"}
        </button>
        <button
          aria-busy={biasPending}
          className="button button-secondary"
          data-testid="bias-action"
          disabled={disabled || !streaming || state.paused || transitionPending}
          onClick={() => {
            run("bias", api.requestBias);
          }}
          type="button"
        >
          Bias
        </button>
        {recordingActive ? (
          <button
            aria-busy={stopPending}
            className="button button-danger-outline"
            data-testid="recording-action"
            disabled={disabled || stopPending}
            onClick={() => {
              run("stop", api.stopRecording, { kind: "recording_idle" });
            }}
            type="button"
          >
            Stop
          </button>
        ) : (
          <button
            aria-busy={recordPending}
            className="button button-danger"
            data-testid="recording-action"
            disabled={
              disabled ||
              !streaming ||
              state.paused ||
              transitionPending ||
              state.recording.state === "error"
            }
            onClick={() => {
              run("record", api.startRecording, { kind: "recording_active" });
            }}
            type="button"
          >
            Record
          </button>
        )}
      </div>
      {errorCode.length > 0 ? (
        <output
          className="action-error"
          data-error-code={errorCode}
          role="status"
        >
          The action could not be completed. Check the status details.
        </output>
      ) : null}
    </>
  );
};

export const Actions = memo(ActionsView);
