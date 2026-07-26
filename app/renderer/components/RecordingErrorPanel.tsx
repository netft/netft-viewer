import { safeDiagnostic } from "../model/safe-error";
import type { AppState } from "../model/app-state";

export interface RecordingErrorPanelProps {
  state: AppState;
}

export const RecordingErrorPanel = ({ state }: RecordingErrorPanelProps) => {
  if (state.recording.state !== "error") {
    return null;
  }

  const partialPath =
    state.recording.partialPath || state.recoverablePartialPath;

  return (
    <section
      aria-labelledby="recording-error-heading"
      className="recording-error-panel"
      role="alert"
    >
      <div className="recording-error-heading">
        <span aria-hidden="true" className="recording-error-mark">
          !
        </span>
        <h2 id="recording-error-heading">Recording needs attention</h2>
      </div>
      <dl className="recording-error-details">
        <div>
          <dt>Category</dt>
          <dd>Recording pipeline</dd>
        </div>
        <div>
          <dt>Technical detail</dt>
          <dd data-testid="recording-error-detail">
            {safeDiagnostic(state.recording.lastError, "Unavailable")}
          </dd>
        </div>
        <div>
          <dt>Partial recording</dt>
          <dd
            data-state={partialPath.length > 0 ? "available" : "unavailable"}
            data-testid="recording-error-partial"
          >
            <code>{partialPath || "Unavailable"}</code>
          </dd>
        </div>
        <div>
          <dt>Log location</dt>
          <dd data-testid="recording-error-log">
            <code>{state.backend.logPath || "Unavailable"}</code>
          </dd>
        </div>
      </dl>
    </section>
  );
};
