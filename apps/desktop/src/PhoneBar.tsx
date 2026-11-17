// The bar above the note on a phone (ADR 0087): the button that opens the
// sidebar as a drawer, the title of what shows, and buttons for the quick
// switcher and the command palette. It loads only at a phone's width.
//
// While it shows, it keeps `--keyboard-inset` on the page at the height the
// on-screen keyboard covers at the bottom of the window, which the sheets
// and the editor's bar stay above. Browsers that shrink the page for the
// keyboard leave it at 0.
import { Command, Menu, Search } from "lucide-react";
import { useEffect } from "react";
import { t } from "./messages.ts";

/** The height the on-screen keyboard covers, from the visual viewport's place in the window. */
function followKeyboard(): () => void {
  const view = window.visualViewport;
  if (view === null) return () => undefined;
  const root = document.documentElement;
  const update = () => {
    const covered = Math.max(0, innerHeight - view.height - view.offsetTop);
    root.style.setProperty("--keyboard-inset", `${String(Math.round(covered))}px`);
  };
  update();
  view.addEventListener("resize", update);
  view.addEventListener("scroll", update);
  return () => {
    view.removeEventListener("resize", update);
    view.removeEventListener("scroll", update);
    root.style.removeProperty("--keyboard-inset");
  };
}

export default function PhoneBar(props: {
  /** What the pane shows: the note's title, or the vault's name. */
  readonly title: string;
  readonly drawerOpen: boolean;
  /** While the drawer is open, the bar is out of reach behind it, as the note is. */
  readonly inert: boolean;
  readonly onDrawer: () => void;
  readonly onSwitcher: () => void;
  readonly onPalette: () => void;
}) {
  const { title, drawerOpen, inert, onDrawer, onSwitcher, onPalette } = props;

  useEffect(followKeyboard, []);

  return (
    <header className="phone-bar" inert={inert}>
      <button
        type="button"
        id="phone-menu"
        className="icon-button"
        aria-label={t("phoneSidebar")}
        aria-controls="sidebar"
        aria-expanded={drawerOpen}
        onClick={onDrawer}
      >
        <Menu className="icon" size={20} aria-hidden="true" />
      </button>
      <p className="phone-title">{title}</p>
      <button
        type="button"
        className="icon-button"
        aria-label={t("switcher")}
        aria-haspopup="dialog"
        onClick={onSwitcher}
      >
        <Search className="icon" size={20} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={t("palette")}
        aria-haspopup="dialog"
        onClick={onPalette}
      >
        <Command className="icon" size={20} aria-hidden="true" />
      </button>
    </header>
  );
}
