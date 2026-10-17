import { StrictMode, useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";

import {
  CASE_TRANSFORMS,
  PREVIEW_LIMIT,
  planRename,
  type CaseTransform,
  type RenameFailure,
} from "../core/rename";
import {
  assertNever,
  onPluginMessage,
  sendToPlugin,
  type SelectionSummary,
} from "../shared/messages";
import "./styles.css";

const CASE_LABELS: Record<CaseTransform, string> = {
  keep: "Keep as typed",
  upper: "UPPERCASE",
  lower: "lowercase",
  title: "Title Case",
};

const SCOPE_LABELS: Record<SelectionSummary["scope"], string> = {
  layer: "the selected layer",
  children: "the children of the selection",
  mixed: "the selection and its children",
};

type Status =
  | { kind: "idle" }
  | { kind: "renaming" }
  | { kind: "done"; renamed: number; failures: RenameFailure[] }
  | { kind: "error"; message: string };

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function App() {
  const [selection, setSelection] = useState<SelectionSummary | null>(null);
  const [pattern, setPattern] = useState("{name} {n}");
  const [transform, setTransform] = useState<CaseTransform>("keep");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    const unsubscribe = onPluginMessage((message) => {
      switch (message.type) {
        case "selection":
          setSelection(message.selection);
          break;
        case "renamed":
          setStatus({
            kind: "done",
            renamed: message.renamed,
            failures: message.failures,
          });
          break;
        case "error":
          setStatus({ kind: "error", message: message.message });
          break;
        default:
          assertNever(message);
      }
    });

    // O sandbox só responde quando sabe que a UI está escutando.
    sendToPlugin({ type: "ready" });

    return unsubscribe;
  }, []);

  const plan = useMemo(() => {
    if (!selection) {
      return null;
    }

    return planRename({ names: selection.names, pattern, transform });
  }, [selection, pattern, transform]);

  const preview = plan?.ok ? plan.entries.slice(0, PREVIEW_LIMIT) : [];
  const hidden = plan?.ok ? plan.entries.length - preview.length : 0;
  const validationError = plan && !plan.ok ? plan.error : null;

  const targetCount = selection?.targetCount ?? 0;
  const canRename =
    status.kind !== "renaming" && targetCount > 0 && plan !== null && plan.ok;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canRename) {
      return;
    }

    setStatus({ kind: "renaming" });
    sendToPlugin({ type: "rename", pattern, transform });
  };

  return (
    <main className="app">
      <header className="header">
        <h1 className="title">Rename layers</h1>
        <p className="subtitle">
          {selection?.scope === "children"
            ? "Names the children of the selected containers."
            : selection?.scope === "mixed"
              ? "Names the selection and the children of its containers."
              : "Names each selected layer."}
        </p>
      </header>

      <section className="stats" aria-live="polite">
        <div className="stat">
          <span className="stat-value">{selection?.selectedCount ?? "n/d"}</span>
          <span className="stat-label">selected</span>
        </div>
        <div className="stat">
          <span className="stat-value">{selection ? targetCount : "n/d"}</span>
          <span className="stat-label">to rename</span>
        </div>
      </section>

      {selection && selection.scope !== "layer" && (
        <p className="hint">
          Renaming {SCOPE_LABELS[selection.scope]}. Index runs across the batch,
          in selection order.
        </p>
      )}

      <form className="form" onSubmit={handleSubmit}>
        <div className="field">
          <label className="label" htmlFor="pattern">
            Pattern
          </label>
          <input
            id="pattern"
            className="input"
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            placeholder="{name} {n}"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            aria-invalid={validationError !== null}
            aria-describedby="pattern-hint"
          />
          <p className="hint" id="pattern-hint">
            <code>{"{name}"}</code> current name · <code>{"{n}"}</code> 1-based
            index
          </p>
        </div>

        <div className="field">
          <label className="label" htmlFor="case">
            Letter case
          </label>
          <select
            id="case"
            className="select"
            value={transform}
            onChange={(event) =>
              setTransform(event.target.value as CaseTransform)
            }
          >
            {CASE_TRANSFORMS.map((option) => (
              <option key={option} value={option}>
                {CASE_LABELS[option]}
              </option>
            ))}
          </select>
        </div>

        <div className="preview">
          <div className="preview-head">
            <span className="label">Preview</span>
            {plan?.ok && (
              <span className="preview-count">
                {plan.entries.length} layer{plural(plan.entries.length)}
              </span>
            )}
          </div>

          {validationError ? (
            <p className="status status--error" role="alert">
              {validationError}
            </p>
          ) : targetCount === 0 ? (
            <p className="empty">
              Select a layer, or a frame with children, to rename it.
            </p>
          ) : (
            <ol className="preview-list">
              {preview.map((entry, index) => (
                <li className="preview-row" key={`${index}-${entry.name}`}>
                  <span className="preview-from">{entry.original || "Untitled"}</span>
                  <span className="preview-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="preview-to">{entry.name}</span>
                </li>
              ))}
            </ol>
          )}

          {hidden > 0 && <p className="hint">+{hidden} more layer{plural(hidden)}</p>}
        </div>

        {status.kind === "done" && (
          <p className="status status--success" role="status">
            Renamed {status.renamed} layer{plural(status.renamed)}.
            {status.failures.length > 0 &&
              ` ${status.failures.length} failure${plural(status.failures.length)}.`}
          </p>
        )}

        {status.kind === "done" && status.failures.length > 0 && (
          <ul className="failures">
            {status.failures.slice(0, 3).map((failure) => (
              <li key={`${failure.layer}-${failure.reason}`}>
                <strong>{failure.layer}</strong>: {failure.reason}
              </li>
            ))}
          </ul>
        )}

        {status.kind === "error" && (
          <p className="status status--error" role="alert">
            {status.message}
          </p>
        )}

        <div className="actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => sendToPlugin({ type: "cancel" })}
          >
            Close
          </button>
          <button type="submit" className="button button--primary" disabled={!canRename}>
            {status.kind === "renaming" ? "Renaming…" : "Rename"}
          </button>
        </div>
      </form>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element in the plugin UI.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
