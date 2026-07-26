import { memo, useRef, useState } from "react";

import type { NetftApi } from "../../preload";
import type { AppState } from "../model/app-state";
import { safeDiagnostic } from "../model/safe-error";

export interface BackendErrorViewProps {
  api: Pick<NetftApi, "retryBackend">;
  state: AppState;
}

const BackendErrorViewComponent = ({ api, state }: BackendErrorViewProps) => {
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [retryError, setRetryError] = useState(false);

  const retry = (): void => {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setRetryError(false);
    void api
      .retryBackend()
      .then((result) => {
        if (!result.success) {
          setRetryError(true);
        }
      })
      .catch(() => {
        setRetryError(true);
      })
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  };

  return (
    <main
      aria-labelledby="backend-error-title"
      className="backend-error-view"
      data-state="failed"
      data-testid="backend-error-view"
    >
      <div className="backend-error-heading">
        <svg aria-hidden="true" viewBox="0 0 48 48">
          <path d="M16 4h16l12 12v16L32 44H16L4 32V16zM17 17l14 14m0-14L17 31" />
        </svg>
        <h2 id="backend-error-title">Backend unavailable</h2>
      </div>
      <dl className="backend-error-details">
        <div>
          <dt>Category</dt>
          <dd>Local companion process</dd>
        </div>
        <div>
          <dt>Technical detail</dt>
          <dd
            data-testid="backend-technical-detail"
            style={{ userSelect: "text" }}
          >
            {safeDiagnostic(state.backend.lastError)}
          </dd>
        </div>
        <div>
          <dt>Log location</dt>
          <dd data-testid="backend-log-path">
            <code>{state.backend.logPath || "Unavailable"}</code>
          </dd>
        </div>
        <div>
          <dt>Partial file</dt>
          <dd data-testid="backend-partial-path">
            <code>{state.recoverablePartialPath || "None"}</code>
          </dd>
        </div>
      </dl>
      <button
        aria-busy={pending}
        className="button button-secondary backend-retry"
        data-action="retry"
        data-testid="retry-backend"
        disabled={pending}
        onClick={retry}
        type="button"
      >
        Retry backend
      </button>
      <p className="backend-retry-note">
        This restarts the local backend only. The sensor remains disconnected
        and recording stays stopped.
      </p>
      {retryError ? (
        <output className="action-error" role="status">
          The backend could not be restarted. Review the log for details.
        </output>
      ) : null}
    </main>
  );
};

export const BackendErrorView = memo(BackendErrorViewComponent);
