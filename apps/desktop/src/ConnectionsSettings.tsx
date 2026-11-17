// The Connections tab of the vault's settings (ADR 0090): the person's
// accounts at other services, which Nether's integrations reach for them,
// kept on this device with their secrets in the system's keychain. Every
// vault on the device shares them; each turns the integrations on for
// itself. A plugin never sees this form, nor a secret. This part adds ICS
// feeds; the other services come with their integrations.
import {
  type AddressProblem,
  type CheckProblem,
  type KeptConnection,
  feedConnection,
  readAddress,
} from "@nether/integrations";
import { type SyntheticEvent, useCallback, useEffect, useId, useState } from "react";
import type { ConnectionsHub } from "./connections.ts";
import { type MessageKey, t } from "./messages.ts";

const addressProblems: Readonly<Record<AddressProblem, MessageKey>> = {
  empty: "connectionAddressEmpty",
  scheme: "connectionAddressScheme",
  host: "connectionAddressHost",
  credentials: "connectionAddressCredentials",
};

/** Why a feed did not check, in the app's words. */
export function checkText(problem: CheckProblem): string {
  switch (problem.problem) {
    case "status":
      return t("connectionCheckStatus", { status: String(problem.status) });
    case "notCalendar":
      return t("connectionCheckNotCalendar");
    case "unreachable":
      return t("connectionCheckUnreachable", { reason: problem.message });
  }
}

interface FeedDraft {
  readonly name: string;
  readonly address: string;
  readonly password: boolean;
  readonly user: string;
  readonly secret: string;
}

const blank: FeedDraft = { name: "", address: "", password: false, user: "", secret: "" };

function FeedForm(props: {
  readonly hub: ConnectionsHub;
  readonly onAdded: (connection: KeptConnection) => void;
  readonly onCancel: () => void;
}) {
  const { hub, onAdded, onCancel } = props;
  const id = useId();
  const field = (name: string) => `${id}-${name}`;
  const [draft, setDraft] = useState<FeedDraft>(blank);
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const change = (next: Partial<FeedDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const read = readAddress(draft.address, hub.http);
    if (read.url === undefined) {
      setError(t(addressProblems[read.problem]));
      return;
    }
    const { connection, secret } = feedConnection({
      id: "",
      name: draft.name,
      url: read.url,
      ...(draft.password ? { user: draft.user, password: draft.secret } : {}),
    });
    setBusy(true);
    setError(undefined);
    setStatus(t("connectionChecking"));
    void (async () => {
      try {
        const problem = await hub.check(connection, secret);
        if (problem !== undefined) {
          setStatus(undefined);
          setError(checkText(problem));
          return;
        }
        const kept = await hub.add(connection, secret);
        setStatus(undefined);
        onAdded(kept);
      } catch (reason) {
        setStatus(undefined);
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <form className="ai-provider-form" onSubmit={submit}>
      <fieldset>
        <legend>{t("connectionAddFeed")}</legend>
        <div className="field">
          <label htmlFor={field("address")}>{t("connectionFeedAddress")}</label>
          <input
            id={field("address")}
            value={draft.address}
            spellCheck={false}
            inputMode="url"
            autoComplete="off"
            aria-describedby={field("address-hint")}
            onChange={(event) => {
              change({ address: event.target.value });
            }}
          />
          <span className="hint" id={field("address-hint")}>
            {t("connectionFeedAddressHint")}
          </span>
        </div>
        <div className="field">
          <label htmlFor={field("name")}>{t("connectionName")}</label>
          <input
            id={field("name")}
            value={draft.name}
            aria-describedby={field("name-hint")}
            onChange={(event) => {
              change({ name: event.target.value });
            }}
          />
          <span className="hint" id={field("name-hint")}>
            {t("connectionNameHint")}
          </span>
        </div>
        <label className="field-check">
          <input
            type="checkbox"
            checked={draft.password}
            onChange={(event) => {
              change({ password: event.target.checked });
            }}
          />
          {t("connectionFeedPassword")}
        </label>
        {draft.password ? (
          <>
            <label className="field">
              {t("connectionUser")}
              <input
                value={draft.user}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  change({ user: event.target.value });
                }}
              />
            </label>
            <label className="field">
              {t("connectionPassword")}
              <input
                type="password"
                value={draft.secret}
                autoComplete="off"
                onChange={(event) => {
                  change({ secret: event.target.value });
                }}
              />
            </label>
          </>
        ) : null}
        {status === undefined ? null : <p role="status">{status}</p>}
        {error === undefined ? null : <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="quiet" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {t("connectionCheckAndAdd")}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function Renaming(props: {
  readonly connection: KeptConnection;
  readonly onSave: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const { connection, onSave, onCancel } = props;
  const [name, setName] = useState(connection.name);
  return (
    <form
      className="connection-rename"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "") onSave(name.trim());
      }}
    >
      <label className="field">
        {t("connectionRenameLabel", { name: connection.name })}
        <input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <div className="ai-provider-actions">
        <button type="button" className="quiet" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="submit" className="primary">
          {t("save")}
        </button>
      </div>
    </form>
  );
}

export function ConnectionsSettings(props: {
  readonly hub: ConnectionsHub;
  /** Whether a plugin asked to add a connection, which opens the form. */
  readonly adding: boolean;
  readonly onClose: () => void;
}) {
  const { hub, onClose } = props;
  const [connections, setConnections] = useState<readonly KeptConnection[] | undefined>();
  const [adding, setAdding] = useState(props.adding);
  const [renaming, setRenaming] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(() => {
    hub.list().then(setConnections, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [hub]);
  useEffect(() => {
    load();
    return hub.subscribe(load);
  }, [hub, load]);

  const act = (work: () => Promise<void>, done: string) => {
    setError(undefined);
    work().then(
      () => {
        setStatus(done);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <div className="settings-form ai-settings">
      <h3>{t("connectionsTab")}</h3>
      <div className="dialog-body">
        <p className="hint">{t("connectionsIntro")}</p>
        <h4>{t("connectionsOnDevice")}</h4>
        {connections === undefined ? null : connections.length === 0 ? (
          <p className="hint">{t("connectionsNone")}</p>
        ) : (
          <ul className="plugin-list ai-providers">
            {connections.map((connection) => {
              const nameId = `connection-name-${connection.id}`;
              return (
                <li key={connection.id}>
                  <div className="ai-provider-head">
                    <strong id={nameId}>{connection.name}</strong>
                  </div>
                  <p className="hint">
                    {t("connectionIcsAt", { host: connection.address })}
                    {connection.account === ""
                      ? null
                      : ` ${t("connectionAs", { account: connection.account })}`}
                  </p>
                  {renaming === connection.id ? (
                    <Renaming
                      connection={connection}
                      onCancel={() => {
                        setRenaming(undefined);
                      }}
                      onSave={(name) => {
                        setRenaming(undefined);
                        act(() => hub.rename(connection, name), t("connectionRenamed", { name }));
                      }}
                    />
                  ) : (
                    <div className="ai-provider-actions">
                      <button
                        type="button"
                        className="quiet"
                        id={`connection-rename-${connection.id}`}
                        aria-labelledby={`connection-rename-${connection.id} ${nameId}`}
                        onClick={() => {
                          setRenaming(connection.id);
                        }}
                      >
                        {t("renameDo")}
                      </button>
                      <button
                        type="button"
                        className="quiet"
                        id={`connection-remove-${connection.id}`}
                        aria-labelledby={`connection-remove-${connection.id} ${nameId}`}
                        onClick={() => {
                          act(
                            () => hub.remove(connection.id),
                            t("connectionRemoved", { name: connection.name }),
                          );
                        }}
                      >
                        {t("connectionRemove")}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {adding ? (
          <FeedForm
            hub={hub}
            onCancel={() => {
              setAdding(false);
            }}
            onAdded={(connection) => {
              setAdding(false);
              setStatus(t("connectionAdded", { name: connection.name }));
            }}
          />
        ) : (
          <div>
            <button
              type="button"
              onClick={() => {
                setStatus(undefined);
                setAdding(true);
              }}
            >
              {t("connectionAddFeed")}
            </button>
          </div>
        )}
        {status === undefined ? null : <p role="status">{status}</p>}
        {error === undefined ? null : <p role="alert">{error}</p>}
      </div>
      <div className="dialog-actions">
        <button type="button" className="quiet" onClick={onClose}>
          {t("close")}
        </button>
      </div>
    </div>
  );
}
