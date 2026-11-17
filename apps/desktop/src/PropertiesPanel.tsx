// A note's properties above it, its frontmatter: each key with a type, the
// vault's choice or what its value looks like, and an editor for that
// type. Changes go to the note's document, and from there to its file, in
// the order shown, which dragging a property or its arrow keys change.
import type { JsonValue, PropertyEntry, PropertyType } from "@nether/core";
import { databaseKey } from "@nether/database";
import { documentProperties, setDocumentProperties } from "@nether/editor";
import type { Vault } from "@nether/storage";
import type { LinkGraph } from "@nether/graph";
import {
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type * as Y from "yjs";
import { ContextMenu, type MenuPoint, pointBelow } from "./ContextMenu.tsx";
import { t } from "./messages.ts";
import { PropertyValueOutput } from "./PropertyValueOutput.tsx";
import { type PropertyTypeRegistry, usePropertyTypes } from "./plugins/propertyTypes.ts";
import {
  type PropertyTypes,
  convertValue,
  editableTypes,
  isListType,
  moveProperty,
  newPropertyKey,
  readPropertyTypes,
  type PluginTypeChoice,
  pluginTypeOf,
  typeOf,
} from "./properties.ts";
import { myName, peopleNames, personKeysOf, subscribeMyName } from "./people.ts";

/** What a dragged property carries, so other drags pass the panel by. */
const dragType = "application/x-nether-property";

interface DropAt {
  readonly key: string;
  readonly place: "before" | "after";
}

/** A list item as text: strings as they are, other values as JSON. */
function itemText(item: JsonValue): string {
  return typeof item === "string" ? item : JSON.stringify(item);
}

export function ListEditor(props: {
  readonly label: string;
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
  /** What to offer as a value is typed, as a relation's rows. */
  readonly suggestions?: readonly string[];
  /** How a value shows in its chip, as a link by the note's name. */
  readonly show?: (value: string) => string;
  /** What a typed value is written as, as a row's name becomes a link to it. */
  readonly toValue?: (typed: string) => string;
}) {
  const { label, values, onChange, suggestions, show, toValue } = props;
  const [draft, setDraft] = useState("");
  const list = useId();
  const add = () => {
    const typed = draft.trim();
    const value = typed === "" || toValue === undefined ? typed : toValue(typed);
    if (value !== "" && !values.includes(value)) onChange([...values, value]);
    setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    } else if (event.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };
  return (
    <span className="property-list">
      {values.map((value) => (
        <span key={value} className="property-chip">
          {show === undefined ? value : show(value)}
          <button
            type="button"
            aria-label={t("removeValue", { value: show === undefined ? value : show(value) })}
            onClick={() => {
              onChange(values.filter((item) => item !== value));
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        value={draft}
        list={suggestions === undefined || suggestions.length === 0 ? undefined : list}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={add}
      />
      {suggestions === undefined || suggestions.length === 0 ? null : (
        <datalist id={list}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
    </span>
  );
}

function ValueEditor(props: {
  readonly name: string;
  readonly type: PropertyType;
  readonly value: JsonValue;
  readonly onChange: (value: JsonValue) => void;
  /** The names a person property offers, for one. */
  readonly people?: readonly string[];
}) {
  const { name, type, value, onChange, people } = props;
  const label = t("propertyValue", { name });
  if (isListType(type)) {
    const values = (Array.isArray(value) ? value : value === null ? [] : [value]).map(itemText);
    return (
      <ListEditor
        label={label}
        values={values}
        onChange={onChange}
        {...(people === undefined ? {} : { suggestions: people })}
      />
    );
  }
  if (type === "checkbox") {
    return (
      <input
        type="checkbox"
        aria-label={label}
        checked={value === true}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
    );
  }
  const text = value === null || typeof value === "object" ? "" : String(value);
  const kind =
    type === "number" ? "number" : type === "date" ? "date" : type === "url" ? "url" : "text";
  return (
    <input
      type={kind}
      aria-label={label}
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        if (type === "number") onChange(next === "" ? null : Number(next));
        else if (type === "date") onChange(next === "" ? null : next);
        else onChange(next);
      }}
    />
  );
}

/** A property's name, renamed when the field is left with a name no other property has. */
function KeyField(props: {
  readonly name: string;
  readonly taken: readonly string[];
  readonly autoFocus: boolean;
  readonly onRename: (name: string) => void;
}) {
  const { name, taken, autoFocus, onRename } = props;
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    setDraft(name);
  }, [name]);
  const commit = () => {
    const next = draft.trim();
    if (next === "" || (next !== name && taken.includes(next))) setDraft(name);
    else if (next !== name) onRename(next);
  };
  return (
    <input
      className="property-key"
      aria-label={t("propertyName")}
      value={draft}
      autoFocus={autoFocus}
      spellCheck={false}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

export function PropertiesPanel(props: {
  readonly document: Y.Doc;
  readonly vault: Vault;
  readonly graph: LinkGraph;
  /** The property types plugins add (ADR 0057). */
  readonly propertyTypes: PropertyTypeRegistry;
  /** Told of each edit made here, its properties before and after, as triggers follow them (ADR 0072). */
  readonly onEdit?: (before: readonly PropertyEntry[], after: readonly PropertyEntry[]) => void;
}) {
  const { document, vault, graph, propertyTypes, onEdit } = props;
  const pluginTypes = usePropertyTypes(propertyTypes);
  const [entries, setEntries] = useState<readonly PropertyEntry[]>(() =>
    documentProperties(document),
  );
  const [types, setTypes] = useState<PropertyTypes>({});
  const me = useSyncExternalStore(subscribeMyName, myName);
  const [added, setAdded] = useState<string | undefined>();
  const [dropAt, setDropAt] = useState<DropAt | undefined>();
  // The property the arrow keys just moved, whose handle keeps the focus.
  const [moved, setMoved] = useState<string | undefined>();
  // A handle's menu, which moves its property up or down without a drag, as a finger needs.
  const [handleMenu, setHandleMenu] = useState<
    { readonly key: string; readonly at: MenuPoint } | undefined
  >();
  const [announcement, setAnnouncement] = useState("");
  const section = useRef<HTMLElement>(null);
  const hint = useId();

  useEffect(() => {
    const refresh = () => {
      setEntries(documentProperties(document));
    };
    refresh();
    document.on("update", refresh);
    return () => {
      document.off("update", refresh);
    };
  }, [document]);

  useEffect(() => {
    let current = true;
    void vault.readData("properties").then((data) => {
      if (current) setTypes(readPropertyTypes(data));
    });
    return () => {
      current = false;
    };
  }, [vault]);

  const save = (next: readonly PropertyEntry[]) => {
    const before = documentProperties(document);
    setDocumentProperties(document, next);
    onEdit?.(before, next);
  };
  const keys = entries.map((entry) => entry.key);

  /** Gives a key a type, the app's or a plugin's, carrying its value over to what it stores as. */
  const setType = (key: string, type: PropertyType | PluginTypeChoice) => {
    const next = { ...types, [key]: type };
    setTypes(next);
    void vault.writeData("properties", next);
    const stored = typeof type === "string" ? type : type.stores;
    save(
      entries.map((entry) =>
        entry.key === key ? { key, value: convertValue(entry.value, stored) } : entry,
      ),
    );
  };

  useEffect(() => {
    if (moved === undefined) return;
    const handle = [
      ...(section.current?.querySelectorAll<HTMLElement>(".property-handle") ?? []),
    ].find((element) => element.dataset.key === moved);
    handle?.focus();
    setMoved(undefined);
  }, [moved, entries]);

  // A database's schema shows as the database below the note, and is kept on every save.
  const shown = entries.filter((entry) => entry.key !== databaseKey);

  const move = (key: string, target: string, place: DropAt["place"]) => {
    const next = moveProperty(entries, key, target, place);
    const position = next
      .filter((entry) => entry.key !== databaseKey)
      .findIndex((entry) => entry.key === key);
    save(next);
    setAnnouncement(
      t("propertyMoved", {
        name: key,
        position: String(position + 1),
        count: String(shown.length),
      }),
    );
  };

  const dragOver = (event: DragEvent<HTMLElement>, key: string) => {
    if (!event.dataTransfer.types.includes(dragType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    const place = event.clientY < box.top + box.height / 2 ? "before" : "after";
    if (dropAt?.key !== key || dropAt.place !== place) setDropAt({ key, place });
  };

  const drop = (event: DragEvent<HTMLElement>, target: string) => {
    const key = event.dataTransfer.getData(dragType);
    const place = dropAt?.key === target ? dropAt.place : "before";
    setDropAt(undefined);
    if (key === "") return;
    event.preventDefault();
    if (key !== target) move(key, target, place);
  };

  const add = () => {
    const key = newPropertyKey(keys);
    setAdded(key);
    save([...entries, { key, value: "" }]);
  };

  // The keys of person properties, the vault's and its databases', as a row's
  // are its database's; and the names they offer, worked out only for a note with one.
  const personKeys = useMemo(() => personKeysOf(graph, types), [graph, types]);
  const isPerson = (key: string, value: JsonValue) =>
    personKeys.has(key) || typeOf(key, value, types) === "person";
  const hasPerson = entries.some((entry) => isPerson(entry.key, entry.value));
  const people = useMemo(() => {
    if (!hasPerson) return [];
    const names = peopleNames(graph, types);
    return me === "" || names.some((name) => name.toLowerCase() === me.toLowerCase())
      ? names
      : [me, ...names];
  }, [hasPerson, graph, types, me]);

  return (
    <section
      ref={section}
      className="properties"
      aria-label={t("properties")}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(undefined);
      }}
    >
      {shown.map((entry, index) => {
        const type = typeOf(entry.key, entry.value, types);
        // A plugin's type, shown by its plugin's view when the plugin is here.
        const choice = pluginTypeOf(entry.key, types);
        const processor = choice === undefined ? undefined : propertyTypes.get(choice.type);
        return (
          <div
            key={entry.key}
            className="property"
            role="group"
            aria-label={entry.key}
            data-drop={dropAt?.key === entry.key ? dropAt.place : undefined}
            onDragOver={(event) => {
              dragOver(event, entry.key);
            }}
            onDrop={(event) => {
              drop(event, entry.key);
            }}
          >
            <button
              type="button"
              className="property-handle"
              data-key={entry.key}
              draggable
              aria-label={t("moveProperty", { name: entry.key })}
              aria-describedby={hint}
              aria-haspopup="menu"
              title={t("movePropertyHint")}
              onClick={(event) => {
                setHandleMenu({ key: entry.key, at: pointBelow(event.currentTarget) });
              }}
              onDragStart={(event) => {
                event.dataTransfer.setData(dragType, entry.key);
                event.dataTransfer.effectAllowed = "move";
                const row = event.currentTarget.parentElement;
                if (row !== null) event.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2);
              }}
              onDragEnd={() => {
                setDropAt(undefined);
              }}
              onKeyDown={(event) => {
                const up = event.key === "ArrowUp";
                if (!up && event.key !== "ArrowDown") return;
                event.preventDefault();
                const neighbour = shown[up ? index - 1 : index + 1];
                if (neighbour === undefined) return;
                move(entry.key, neighbour.key, up ? "before" : "after");
                setMoved(entry.key);
              }}
            >
              <span aria-hidden="true">⠿</span>
            </button>
            <KeyField
              name={entry.key}
              taken={keys}
              autoFocus={added === entry.key}
              onRename={(name) => {
                save(
                  entries.map((item) =>
                    item.key === entry.key ? { key: name, value: item.value } : item,
                  ),
                );
              }}
            />
            <select
              className="property-type"
              aria-label={t("propertyType", { name: entry.key })}
              value={choice?.type ?? type}
              onChange={(event) => {
                const chosen = event.target.value;
                if (chosen === choice?.type) return;
                const plugin = pluginTypes.find((each) => each.type === chosen);
                setType(
                  entry.key,
                  plugin === undefined
                    ? (chosen as PropertyType)
                    : { type: plugin.type, stores: plugin.stores },
                );
              }}
            >
              {editableTypes.map((option) => (
                <option key={option} value={option}>
                  {t(`type_${option}`)}
                </option>
              ))}
              {pluginTypes.map((each) => (
                <option key={each.type} value={each.type}>
                  {each.name()}
                </option>
              ))}
              {choice === undefined || processor !== undefined ? null : (
                // A type no plugin here has, named as the vault has it; its value edits as what it stores as.
                <option value={choice.type}>{choice.type}</option>
              )}
            </select>
            {processor === undefined ? (
              <ValueEditor
                name={entry.key}
                type={type}
                value={entry.value}
                {...(isPerson(entry.key, entry.value) ? { people } : {})}
                onChange={(value) => {
                  save(
                    entries.map((item) =>
                      item.key === entry.key ? { key: item.key, value } : item,
                    ),
                  );
                }}
              />
            ) : (
              <PropertyValueOutput
                processor={processor}
                propertyKey={entry.key}
                value={entry.value}
                editable
                onChange={(value) => {
                  save(
                    entries.map((item) =>
                      item.key === entry.key ? { key: item.key, value } : item,
                    ),
                  );
                }}
              />
            )}
            <button
              type="button"
              className="quiet property-remove"
              aria-label={t("removeProperty", { name: entry.key })}
              onClick={() => {
                save(entries.filter((item) => item.key !== entry.key));
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button type="button" className="quiet property-add" onClick={add}>
        {t("addProperty")}
      </button>
      <span id={hint} hidden>
        {t("movePropertyHint")}
      </span>
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {(() => {
        if (handleMenu === undefined) return null;
        const { key } = handleMenu;
        const at = shown.findIndex((entry) => entry.key === key);
        const step = (up: boolean) => () => {
          const neighbour = shown[up ? at - 1 : at + 1];
          if (neighbour === undefined) return;
          move(key, neighbour.key, up ? "before" : "after");
          setMoved(key);
        };
        return (
          <ContextMenu
            label={t("moveProperty", { name: key })}
            at={handleMenu.at}
            entries={[
              { label: t("movePropertyUp", { name: key }), disabled: at <= 0, run: step(true) },
              {
                label: t("movePropertyDown", { name: key }),
                disabled: at < 0 || at >= shown.length - 1,
                run: step(false),
              },
            ]}
            onClose={() => {
              setHandleMenu(undefined);
            }}
          />
        );
      })()}
    </section>
  );
}
