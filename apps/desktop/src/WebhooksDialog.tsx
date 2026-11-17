// The webhooks of the workspace the vault syncs with (ADR 0060), for its
// owners and admins: each with its address, what it tells of, whether it
// is on and why it fails; adding one, with the address the server refuses
// said so; editing, turning off and on, a new secret, a test event, its
// recent events, and removing it. A secret shows once, with a button to
// copy it. Others see why they cannot, as the server says.
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { backend } from "./backend.ts";
import { type MessageKey, t } from "./messages.ts";
import { type VaultLink, hostOf } from "./sync.ts";
import { useModal } from "./useModal.ts";
import {
  type Delivery,
  type Webhook,
  type WebhookEvent,
  addWebhook,
  changeWebhook,
  removeWebhook,
  rollWebhookSecret,
  testWebhook,
  webhookDeliveries,
  webhookEvents,
  webhooks,
} from "./webhooks.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const eventNames: Readonly<Record<WebhookEvent, MessageKey>> = {
  "note.created": "webhookEvent_created",
  "note.updated": "webhookEvent_updated",
  "note.deleted": "webhookEvent_deleted",
};

const statusNames: Readonly<Record<Delivery["status"], MessageKey>> = {
  sent: "delivery_sent",
  waiting: "delivery_waiting",
  failed: "delivery_failed",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The kinds of event a webhook tells of, as boxes to tick. */
function EventChoice(props: {
  readonly legend: string;
  readonly chosen: ReadonlySet<WebhookEvent>;
  readonly onChange: (chosen: ReadonlySet<WebhookEvent>) => void;
}) {
  const { legend, chosen, onChange } = props;
  return (
    <fieldset className="webhook-events">
      <legend>{legend}</legend>
      {webhookEvents.map((event) => (
        <label key={event} className="field-check">
          <input
            type="checkbox"
            checked={chosen.has(event)}
            onChange={(change) => {
              const next = new Set(chosen);
              if (change.target.checked) next.add(event);
              else next.delete(event);
              onChange(next);
            }}
          />
          {t(eventNames[event])}
        </label>
      ))}
    </fieldset>
  );
}

/** The events in the order the server lists them. */
function ordered(chosen: ReadonlySet<WebhookEvent>): WebhookEvent[] {
  return webhookEvents.filter((event) => chosen.has(event));
}

function DeliveryLine(props: { readonly delivery: Delivery }) {
  const { delivery } = props;
  const parts: string[] = [t("deliveryTries", { count: delivery.attempts })];
  if (delivery.answer !== null) parts.push(t("deliveryAnswer", { status: delivery.answer }));
  if (delivery.error !== null && delivery.status !== "sent") parts.push(delivery.error);
  if (delivery.nextAt !== null && delivery.status === "waiting") {
    parts.push(t("deliveryNext", { date: when.format(Date.parse(delivery.nextAt)) }));
  }
  return (
    <li>
      <span>
        {t("deliveryLine", {
          type: delivery.type,
          status: t(statusNames[delivery.status]),
          date: when.format(Date.parse(delivery.createdAt)),
        })}
      </span>
      <span className="hint">{parts.join(". ")}</span>
    </li>
  );
}

export function WebhooksDialog(props: { readonly link: VaultLink; readonly onClose: () => void }) {
  const { link, onClose } = props;
  const server = link.server;
  const [list, setList] = useState<readonly Webhook[] | undefined>();
  const [address, setAddress] = useState("");
  const [events, setEvents] = useState<ReadonlySet<WebhookEvent>>(new Set(webhookEvents));
  const [editing, setEditing] = useState<string | undefined>();
  const [editAddress, setEditAddress] = useState("");
  const [editEvents, setEditEvents] = useState<ReadonlySet<WebhookEvent>>(new Set());
  const [shown, setShown] = useState<
    { readonly id: string; readonly deliveries: readonly Delivery[] } | undefined
  >();
  const [secret, setSecret] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const dialog = useRef<HTMLDivElement>(null);
  const secretField = useRef<HTMLInputElement>(null);
  useModal(dialog);

  const session = useCallback(async () => {
    const found = await backend.serverToken(server);
    if (found === undefined) throw new Error(t("syncSignedOut", { server: hostOf(server) }));
    return found;
  }, [server]);

  const load = useCallback(async () => {
    setList(await webhooks(backend.serverFetch, server, await session(), link.workspaceId));
  }, [session, server, link.workspaceId]);

  useEffect(() => {
    load().catch((reason: unknown) => {
      setError(messageOf(reason));
    });
  }, [load]);

  const act = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    work()
      .catch((reason: unknown) => {
        setError(messageOf(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  /** Shows a webhook's recent events, read again. */
  const showDeliveries = async (id: string) => {
    const deliveries = await webhookDeliveries(
      backend.serverFetch,
      server,
      await session(),
      link.workspaceId,
      id,
    );
    setShown({ id, deliveries });
  };

  const item = (hook: Webhook): ReactNode => {
    if (editing === hook.id) {
      return (
        <form
          className="member-invite"
          onSubmit={(event) => {
            event.preventDefault();
            if (editEvents.size === 0) {
              setError(t("webhookNoEvents"));
              return;
            }
            act(async () => {
              const saved = await changeWebhook(
                backend.serverFetch,
                server,
                await session(),
                link.workspaceId,
                hook.id,
                { url: editAddress.trim(), events: ordered(editEvents) },
              );
              setEditing(undefined);
              await load();
              setStatus(t("webhookSaved", { url: saved.url }));
            });
          }}
        >
          <fieldset disabled={busy}>
            <legend>{t("webhookEditOf", { url: hook.url })}</legend>
            <label className="field">
              {t("webhookAddress")}
              <input
                type="url"
                required
                value={editAddress}
                onChange={(event) => {
                  setEditAddress(event.target.value);
                }}
              />
            </label>
            <EventChoice legend={t("webhookTellOf")} chosen={editEvents} onChange={setEditEvents} />
            <span className="field-actions">
              <button type="submit">{t("webhookSave")}</button>
              <button
                type="button"
                className="quiet"
                onClick={() => {
                  setEditing(undefined);
                }}
              >
                {t("cancel")}
              </button>
            </span>
          </fieldset>
        </form>
      );
    }
    const failing =
      hook.failingSince === null
        ? undefined
        : t("webhookFailing", {
            date: when.format(Date.parse(hook.failingSince)),
            error: hook.lastError ?? "",
          });
    const open = shown?.id === hook.id;
    return (
      <>
        <span className="member-name">{hook.url}</span>
        <span className="hint">
          {[
            t(hook.enabled ? "webhookOn" : "webhookOff"),
            ...hook.events.map((e) => t(eventNames[e])),
          ].join(". ")}
        </span>
        {failing === undefined ? null : <span className="hint">{failing}</span>}
        <span className="hint">{t("webhookMadeBy", { name: hook.maker.name })}</span>
        <span className="field-actions">
          <button
            type="button"
            className="quiet"
            disabled={busy}
            aria-label={t("webhookEditOf", { url: hook.url })}
            onClick={() => {
              setEditAddress(hook.url);
              setEditEvents(new Set(hook.events));
              setEditing(hook.id);
            }}
          >
            {t("webhookEdit")}
          </button>
          <button
            type="button"
            className="quiet"
            disabled={busy}
            aria-label={t(hook.enabled ? "webhookTurnOffOf" : "webhookTurnOnOf", { url: hook.url })}
            onClick={() => {
              act(async () => {
                await changeWebhook(
                  backend.serverFetch,
                  server,
                  await session(),
                  link.workspaceId,
                  hook.id,
                  { enabled: !hook.enabled },
                );
                await load();
                setStatus(
                  t(hook.enabled ? "webhookTurnedOff" : "webhookTurnedOn", { url: hook.url }),
                );
              });
            }}
          >
            {t(hook.enabled ? "webhookTurnOff" : "webhookTurnOn")}
          </button>
          <button
            type="button"
            className="quiet"
            disabled={busy}
            aria-label={t("webhookNewSecretOf", { url: hook.url })}
            onClick={() => {
              act(async () => {
                setSecret(
                  await rollWebhookSecret(
                    backend.serverFetch,
                    server,
                    await session(),
                    link.workspaceId,
                    hook.id,
                  ),
                );
                setStatus(t("webhookSecretRolled", { url: hook.url }));
              });
            }}
          >
            {t("webhookNewSecret")}
          </button>
          <button
            type="button"
            className="quiet"
            disabled={busy || !hook.enabled}
            aria-label={t("webhookTestOf", { url: hook.url })}
            onClick={() => {
              act(async () => {
                await testWebhook(
                  backend.serverFetch,
                  server,
                  await session(),
                  link.workspaceId,
                  hook.id,
                );
                setStatus(t("webhookTested", { url: hook.url }));
                if (open) await showDeliveries(hook.id);
              });
            }}
          >
            {t("webhookTest")}
          </button>
          <button
            type="button"
            className="quiet"
            disabled={busy}
            aria-expanded={open}
            aria-label={t(open ? "webhookHideEvents" : "webhookEventsOf", { url: hook.url })}
            onClick={() => {
              if (open) {
                setShown(undefined);
                return;
              }
              act(() => showDeliveries(hook.id));
            }}
          >
            {t("webhookEvents")}
          </button>
          <button
            type="button"
            className="quiet danger"
            disabled={busy}
            aria-label={t("webhookRemoveOf", { url: hook.url })}
            onClick={() => {
              act(async () => {
                await removeWebhook(
                  backend.serverFetch,
                  server,
                  await session(),
                  link.workspaceId,
                  hook.id,
                );
                if (open) setShown(undefined);
                await load();
                setStatus(t("webhookRemoved", { url: hook.url }));
              });
            }}
          >
            {t("webhookRemove")}
          </button>
        </span>
        {!open ? null : shown.deliveries.length === 0 ? (
          <p className="hint">{t("webhookEventsNone")}</p>
        ) : (
          <ul className="webhook-deliveries" aria-label={t("webhookEventsOf", { url: hook.url })}>
            {shown.deliveries.map((delivery) => (
              <DeliveryLine key={delivery.id} delivery={delivery} />
            ))}
          </ul>
        )}
      </>
    );
  };

  return (
    <div
      className="switcher-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="switcher dialog members-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="webhooks-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id="webhooks-title">{t("webhooksOf", { workspace: link.workspaceName })}</h2>
        <p className="hint">{t("webhooksHint")}</p>
        {list === undefined ? null : list.length === 0 ? (
          <p className="hint">{t("webhooksNone")}</p>
        ) : (
          <ul className="member-list webhook-list" aria-label={t("webhooksList")}>
            {list.map((hook) => (
              <li key={hook.id}>{item(hook)}</li>
            ))}
          </ul>
        )}
        {list === undefined ? null : (
          <form
            className="member-invite"
            onSubmit={(event) => {
              event.preventDefault();
              if (events.size === 0) {
                setError(t("webhookNoEvents"));
                return;
              }
              act(async () => {
                const added = await addWebhook(
                  backend.serverFetch,
                  server,
                  await session(),
                  link.workspaceId,
                  address.trim(),
                  ordered(events),
                );
                setSecret(added.secret);
                setAddress("");
                await load();
                setStatus(t("webhookAdded", { url: added.webhook.url }));
              });
            }}
          >
            <fieldset disabled={busy}>
              <legend>{t("webhookAdd")}</legend>
              <label className="field">
                {t("webhookAddress")}
                <input
                  type="url"
                  required
                  placeholder="https://"
                  value={address}
                  aria-describedby="webhook-address-hint"
                  onChange={(event) => {
                    setAddress(event.target.value);
                  }}
                />
                <span id="webhook-address-hint" className="hint">
                  {t("webhookAddressHint")}
                </span>
              </label>
              <EventChoice legend={t("webhookTellOf")} chosen={events} onChange={setEvents} />
              <button type="submit">{t("webhookAddButton")}</button>
            </fieldset>
          </form>
        )}
        {secret === undefined ? null : (
          <div className="field">
            <label htmlFor="webhook-secret">{t("webhookSecret")}</label>
            <span className="field-actions">
              <input
                id="webhook-secret"
                ref={secretField}
                type="text"
                readOnly
                value={secret}
                aria-describedby="webhook-secret-hint"
                onFocus={(event) => {
                  event.target.select();
                }}
              />
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(secret).then(
                    () => {
                      setStatus(t("webhookSecretCopied"));
                    },
                    () => {
                      secretField.current?.focus();
                      setStatus(t("webhookSecretCopyYourself"));
                    },
                  );
                }}
              >
                {t("copy")}
              </button>
            </span>
            <span id="webhook-secret-hint" className="hint">
              {t("webhookSecretHint")}
            </span>
          </div>
        )}
        {status === undefined ? null : <p role="status">{status}</p>}
        {error === undefined ? null : <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="primary" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}
