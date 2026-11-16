// The vault's settings, in one dialog (ADR 0055): a tab for each part,
// down its start side, the app's own first, then Plugins, then a tab for
// each plugin that has settings. Each tab's form keeps what it changes, as
// its own dialog did. Up and Down, Home and End move between the tabs.
import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { t } from "./messages.ts";
import { useModal } from "./useModal.ts";

export interface SettingsTab {
  readonly id: string;
  readonly name: string;
  /** The tab's form, drawn while it is chosen. */
  readonly render: () => ReactNode;
}

const tabId = (id: string) => `settings-tab-${id.replace(/[^a-zA-Z0-9-]/g, "-")}`;
const panelId = (id: string) => `settings-panel-${id.replace(/[^a-zA-Z0-9-]/g, "-")}`;

export function SettingsDialog(props: {
  readonly tabs: readonly SettingsTab[];
  /** The tab chosen; the first when it is not one of `tabs`. */
  readonly tab: string;
  readonly onTab: (id: string) => void;
  readonly onClose: () => void;
}) {
  const { tabs, onTab, onClose } = props;
  const dialog = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useModal(dialog);
  const chosen = tabs.find((tab) => tab.id === props.tab) ?? tabs[0];

  const move = (event: KeyboardEvent) => {
    const at = tabs.findIndex((tab) => tab.id === chosen?.id);
    const to =
      event.key === "ArrowDown"
        ? (at + 1) % tabs.length
        : event.key === "ArrowUp"
          ? (at - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : undefined;
    const next = to === undefined ? undefined : tabs[to];
    if (next === undefined) return;
    event.preventDefault();
    onTab(next.id);
    list.current?.querySelector<HTMLElement>(`#${tabId(next.id)}`)?.focus();
  };

  return (
    <div
      className="switcher-backdrop"
      onMouseDown={(event) => {
        // A click outside the dialog closes it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="switcher dialog settings-dialog settings-window"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(event) => {
          // A tab's form handles Escape first, as Shortcuts does while it listens for keys.
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id="settings-title">{t("settings")}</h2>
        <div className="settings-layout">
          <div
            className="settings-tabs"
            role="tablist"
            aria-orientation="vertical"
            aria-labelledby="settings-title"
            ref={list}
            onKeyDown={move}
          >
            {tabs.map((tab) => {
              const selected = tab.id === chosen?.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={tabId(tab.id)}
                  aria-selected={selected}
                  aria-controls={panelId(tab.id)}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    onTab(tab.id);
                  }}
                >
                  {tab.name}
                </button>
              );
            })}
          </div>
          {chosen === undefined ? null : (
            <div
              className="settings-panel"
              role="tabpanel"
              id={panelId(chosen.id)}
              aria-labelledby={tabId(chosen.id)}
              // Each tab's form starts afresh.
              key={chosen.id}
            >
              {chosen.render()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
