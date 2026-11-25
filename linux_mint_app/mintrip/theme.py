"""Systemthema- & Icon-Thema-Synchronisation für Linux Mint Cinnamon (GTK 3.0)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, Optional

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gio, GLib, Gtk


_SCROLL_FIX_CSS = """
/* Entfernt die gestrichelten GTK3-Undershoot-/Overshoot-Linien beim Scrollen */
scrolledwindow undershoot,
scrolledwindow undershoot.top,
scrolledwindow undershoot.bottom,
scrolledwindow undershoot.left,
scrolledwindow undershoot.right,
scrolledwindow overshoot,
scrolledwindow overshoot.top,
scrolledwindow overshoot.bottom,
scrolledwindow overshoot.left,
scrolledwindow overshoot.right,
undershoot,
undershoot.top,
undershoot.bottom,
undershoot.left,
undershoot.right,
overshoot,
overshoot.top,
overshoot.bottom,
overshoot.left,
overshoot.right {
    background: none;
    background-image: none;
    background-color: transparent;
    border: none;
    box-shadow: none;
}

/* Obere Toolbar bündig ohne linken, oberen und rechten Abstand zum Fensterrand */
toolbar.primary-toolbar,
box.primary-toolbar,
.primary-toolbar {
    background-color: shade(@theme_bg_color, 0.96);
    background-image: none;
    margin-top: 0px;
    margin-left: 0px;
    margin-right: 0px;
    padding-top: 2px;
    padding-bottom: 2px;
    padding-left: 4px;
    padding-right: 4px;
    border-top: none;
    border-left: none;
    border-right: none;
}

/* Kompaktes Quellen-Badge neben dem Track-Titel */
label.source-badge {
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 85%;
    border: 1px solid alpha(currentColor, 0.28);
}

button.shazam-toggle-btn {
    padding: 1px 6px;
    min-height: 20px;
    min-width: 20px;
    border-radius: 4px;
    font-size: 85%;
    font-weight: 600;
    background-image: none;
}

button.shazam-toggle-btn.shazam-active {
    color: #0369a1;
    background-color: alpha(#0284c7, 0.14);
    border: 1px solid alpha(#0284c7, 0.45);
}

button.shazam-toggle-btn.shazam-active:hover {
    background-color: alpha(#0284c7, 0.24);
}

button.shazam-toggle-btn.original-active {
    color: #b45309;
    background-color: alpha(#d97706, 0.14);
    border: 1px solid alpha(#d97706, 0.45);
}

button.shazam-toggle-btn.original-active:hover {
    background-color: alpha(#d97706, 0.24);
}

button.shazam-toggle-btn.mb-active {
    color: #9b2c74;
    background-color: alpha(#ba478f, 0.14);
    border: 1px solid alpha(#ba478f, 0.48);
}

button.shazam-toggle-btn.mb-active:hover {
    background-color: alpha(#ba478f, 0.24);
}

/* Aktive Track-Zeile in der Titelliste (verknüpft mit der rechten 3. Spalte "Track-Felder") */
.track-row-active {
    background-color: alpha(#5ba632, 0.11);
    border-left: 3px solid #5ba632;
    border-radius: 4px;
}

/* Eingeklappte vertikale Leiste der rechten 3. Spalte */
button.track-inspector-rail-btn {
    border: none;
    background-image: none;
    background-color: transparent;
    padding: 8px 4px;
}

button.track-inspector-rail-btn:hover {
    background-color: alpha(#5ba632, 0.10);
}

/* Kompakteres Padding (-2px) für alle Buttons und Eingabefelder */
button,
togglebutton {
    padding: 2px 6px;
    min-height: 22px;
    min-width: 22px;
}

button.flat,
button.image-button {
    padding: 1px 4px;
    min-height: 20px;
    min-width: 20px;
}

entry,
spinbutton,
spinbutton > entry {
    padding: 2px 6px;
    min-height: 22px;
}

combobox > box > button.combo {
    padding: 2px 6px;
    min-height: 22px;
}

/* Exklusiv aufklappbare Display-Boxen in der rechten Spalte */
frame.display-box {
    border-radius: 8px;
}

button.display-summary {
    background-color: shade(@theme_bg_color, 0.96);
    background-image: none;
    color: @theme_fg_color;
    border: none;
    box-shadow: none;
    border-radius: 8px 8px 0px 0px;
    padding: 4px 10px;
    min-height: 24px;
}

button.display-summary:hover {
    background-color: shade(@theme_bg_color, 0.92);
    background-image: none;
}

button.display-summary.closed-box {
    border-radius: 8px;
}

label.display-glyph {
    font-size: 125%;
    font-weight: 400;
}

/* Dezente hellrote Hervorhebung bei mehrdeutiger CD-Auswahl (Multi-CD-Konflikt) */
spinbutton.disc-conflict,
spinbutton.disc-conflict > entry,
spinbutton.disc-conflict entry {
    background-color: alpha(#ef4444, 0.12);
    background-image: none;
    border-color: alpha(#dc2626, 0.45);
    color: @theme_fg_color;
    box-shadow: none;
}

/* Visuelle CD-Überschriften & Abstände in der Trackliste */
row.cd-section-row,
row.cd-section-row:hover,
row.cd-section-row:selected,
.cd-section-row {
    background-color: transparent;
    background-image: none;
    padding: 0px;
    margin: 0px;
}

box.cd-section-header {
    background-color: shade(@theme_bg_color, 0.94);
    border-top: 1px solid alpha(@theme_fg_color, 0.14);
    border-bottom: 1px solid alpha(@theme_fg_color, 0.14);
    padding: 5px 10px;
}

/* Deutlich transparenteres Overlay über dem Coverbild bei laufender Suche / Scan */
box.cover-loading-overlay,
.cover-loading-overlay {
    background-color: rgba(0, 0, 0, 0.25);
    background-image: none;
    color: #ffffff;
    border-radius: 6px;
}

/* Modul 3: Leichtes Drag-&-Drop-Overlay über Alben- und Titelliste */
box.dnd-drop-overlay,
.dnd-drop-overlay {
    background-color: alpha(#5ba632, 0.14);
    background-image: none;
    border: 2px dashed alpha(#5ba632, 0.78);
    border-radius: 6px;
}

box.dnd-drop-overlay-card,
.dnd-drop-overlay-card {
    background-color: alpha(@theme_base_color, 0.92);
    border: 1px solid alpha(#5ba632, 0.45);
    border-radius: 10px;
    padding: 16px 24px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

/* Modul 5: Zeilen- & Auswahl-Styling */
.repair-file-row {
    border-bottom: 1px solid alpha(@theme_fg_color, 0.08);
    padding: 0px;
    margin: 0px;
}

.repair-file-row:hover {
    background-color: alpha(@theme_fg_color, 0.04);
}

.repair-file-row:selected,
.repair-file-row.highlighted {
    background-color: alpha(#5ba632, 0.22);
    color: @theme_fg_color;
}

.repair-spacer-row,
.repair-spacer-row:hover,
.repair-spacer-row:selected {
    background-color: transparent;
    background-image: none;
    border: none;
    box-shadow: none;
    padding: 0px;
    margin: 0px;
}

/* Fortschrittsleiste am unteren Fensterrand für alle Datenbankabfragen */
box.db-query-progress-strip {
    background-color: shade(@theme_bg_color, 0.94);
    border-top: 1px solid alpha(@theme_fg_color, 0.18);
    padding: 5px 12px;
    min-height: 30px;
}

box.db-query-progress-strip.db-progress-active {
    background-color: alpha(#5ba632, 0.08);
    border-top: 1px solid alpha(#5ba632, 0.45);
}

box.db-query-progress-strip.db-progress-done {
    background-color: alpha(#5ba632, 0.14);
    border-top: 1px solid alpha(#5ba632, 0.58);
}

box.db-query-progress-strip.db-progress-cancelled {
    background-color: alpha(#d97706, 0.11);
    border-top: 1px solid alpha(#d97706, 0.48);
}

progressbar.db-query-progress-bar,
progressbar.db-query-progress-bar > trough,
progressbar.db-query-progress-bar trough {
    min-height: 12px;
    border-radius: 6px;
    background-color: alpha(@theme_fg_color, 0.14);
    background-image: none;
    border: 1px solid alpha(@theme_fg_color, 0.14);
    box-shadow: none;
}

progressbar.db-query-progress-bar > trough > progress,
progressbar.db-query-progress-bar progress {
    min-height: 12px;
    border-radius: 5px;
    background-color: #5ba632;
    background-image: none;
    border: none;
    box-shadow: none;
}

box.db-query-progress-strip.db-progress-cancelled progressbar.db-query-progress-bar > trough > progress,
box.db-query-progress-strip.db-progress-cancelled progressbar.db-query-progress-bar progress {
    background-color: #d97706;
}

label.db-progress-status-active {
    font-weight: 600;
}

label.db-progress-status-done {
    color: #3f7e1f;
    font-weight: 700;
}

label.db-progress-status-cancelled {
    color: #b45309;
    font-weight: 700;
}
""".encode("utf-8")

_scroll_css_provider: Optional[Gtk.CssProvider] = None


def apply_gtk3_scroll_undershoot_fix() -> None:
    """Deaktiviert die gestrichelten GTK3-Undershoot-Linien (oben/unten) in allen ScrolledWindows."""
    global _scroll_css_provider
    try:
        screen = Gdk.Screen.get_default()
        if screen is None:
            return
        if _scroll_css_provider is None:
            _scroll_css_provider = Gtk.CssProvider()
            _scroll_css_provider.load_from_data(_SCROLL_FIX_CSS)
        Gtk.StyleContext.add_provider_for_screen(
            screen,
            _scroll_css_provider,
            Gtk.STYLE_PROVIDER_PRIORITY_USER,
        )
    except Exception:
        pass


def _read_cinnamon_or_gnome_string(key: str) -> str:
    """Liest einen String-Schlüssel bevorzugt aus Cinnamon, sonst GNOME GSettings."""
    schema_source = Gio.SettingsSchemaSource.get_default()
    if schema_source:
        for schema_id in ("org.cinnamon.desktop.interface", "org.gnome.desktop.interface"):
            if schema_source.lookup(schema_id, True):
                try:
                    settings = Gio.Settings.new(schema_id)
                    val = settings.get_string(key).strip()
                    if val:
                        return val
                except Exception:
                    pass
    return ""


def _read_gtk3_settings_ini() -> dict[str, str]:
    """Fallback auf ~/.config/gtk-3.0/settings.ini falls GSettings nichts liefert."""
    ini_path = Path.home() / ".config" / "gtk-3.0" / "settings.ini"
    result: dict[str, str] = {}
    if not ini_path.exists():
        return result
    try:
        for line in ini_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith(("#", "[", ";")) or "=" not in line:
                continue
            k, v = line.split("=", 1)
            result[k.strip()] = v.strip()
    except Exception:
        pass
    return result


def detect_system_gtk_theme() -> str:
    """Ermittelt das aktive GTK-Theme unter Linux Mint (z.B. Mint-L-Dark-Aqua)."""
    theme = _read_cinnamon_or_gnome_string("gtk-theme")
    if theme:
        return theme
    ini = _read_gtk3_settings_ini()
    if ini.get("gtk-theme-name"):
        return ini["gtk-theme-name"]
    return os.environ.get("GTK_THEME", "").split(":")[0] or "Mint-Y"


def detect_system_icon_theme() -> str:
    """Ermittelt das aktive System-Icon-Theme unter Linux Mint (z.B. WhiteSur-dark)."""
    icon_theme = _read_cinnamon_or_gnome_string("icon-theme")
    if icon_theme:
        return icon_theme
    ini = _read_gtk3_settings_ini()
    if ini.get("gtk-icon-theme-name"):
        return ini["gtk-icon-theme-name"]
    return "Mint-Y"


def detect_system_font_name() -> str:
    """Ermittelt die Systemschriftart unter Linux Mint."""
    font_name = _read_cinnamon_or_gnome_string("font-name")
    if font_name:
        return font_name
    ini = _read_gtk3_settings_ini()
    return ini.get("gtk-font-name", "")


def detect_system_dark_mode() -> bool:
    """Ermittelt Light/Dark Mode aus Cinnamon-Theme, XDG Portal und GTK_THEME."""
    gtk_theme = detect_system_gtk_theme().lower()
    if "dark" in gtk_theme:
        return True

    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        result = bus.call_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Settings",
            "Read",
            GLib.Variant("(ss)", ("org.freedesktop.appearance", "color-scheme")),
            GLib.VariantType("(v)"),
            Gio.DBusCallFlags.NONE,
            1000,
            None,
        )
        color_scheme = result.get_child_value(0).get_variant().get_variant().get_uint32()
        if color_scheme == 1:
            return True
        if color_scheme == 2:
            return False
    except Exception:
        pass

    if "dark" in os.environ.get("GTK_THEME", "").lower():
        return True

    return False


def _theme_exists(theme_name: str) -> bool:
    for base in (
        Path.home() / ".themes" / theme_name,
        Path.home() / ".local" / "share" / "themes" / theme_name,
        Path("/usr/share/themes") / theme_name,
    ):
        if (base / "gtk-3.0").exists():
            return True
    return False


def _resolve_theme_variant(base_theme: str, want_dark: bool) -> str:
    """Wechselt bei Mint-L/Mint-Y/Mint-X sauber zwischen Hell- und Dunkel-Variante."""
    if not base_theme:
        return "Mint-Y-Dark" if want_dark else "Mint-Y"

    lower = base_theme.lower()
    if want_dark:
        if "dark" in lower:
            return base_theme
        if base_theme.startswith(("Mint-Y-", "Mint-L-", "Mint-X-")):
            parts = base_theme.split("-", 2)
            if len(parts) == 3:
                candidate = f"{parts[0]}-{parts[1]}-Dark-{parts[2]}"
                if _theme_exists(candidate):
                    return candidate
        candidate = f"{base_theme}-Dark"
        if _theme_exists(candidate):
            return candidate
        return base_theme

    # Hell-Variante ermitteln (z.B. "Mint-L-Dark-Aqua" -> "Mint-L-Aqua")
    if "dark" in lower:
        for token in ("-Dark-", "-dark-", "-Dark", "-dark"):
            if token in base_theme:
                candidate = base_theme.replace(token, "-" if token.endswith("-") else "")
                if _theme_exists(candidate):
                    return candidate
    return base_theme


def bootstrap_system_theme_env() -> None:
    """Synchronisiert GTK_THEME vor GTK-Init falls noch nicht gesetzt."""
    os.environ.pop("GTK_THEME", None)


class SystemThemeWatcher:
    """Synchronisiert GTK3-Theme, Icon-Theme, Schriftart & Dark/Light Mode live mit Linux Mint."""

    def __init__(self, on_change: Optional[Callable[[bool], None]] = None) -> None:
        self.mode: str = "system"  # "system" | "light" | "dark"
        self._on_change = on_change
        self._cinnamon_settings: Optional[Gio.Settings] = None
        self._gnome_settings: Optional[Gio.Settings] = None
        self._apply_effective_theme()
        self._subscribe_system_changes()

    def set_mode(self, mode: str) -> None:
        if mode not in ("system", "light", "dark"):
            return
        self.mode = mode
        self._apply_effective_theme()

    def is_dark_active(self) -> bool:
        if self.mode == "dark":
            return True
        if self.mode == "light":
            return False
        return detect_system_dark_mode()

    def _apply_effective_theme(self) -> None:
        prefer_dark = self.is_dark_active()
        system_theme = detect_system_gtk_theme()
        effective_theme = (
            system_theme if self.mode == "system" else _resolve_theme_variant(system_theme, prefer_dark)
        )
        icon_theme = detect_system_icon_theme()
        font_name = detect_system_font_name()

        gtk_settings = Gtk.Settings.get_default()
        if gtk_settings is not None:
            if effective_theme:
                gtk_settings.set_property("gtk-theme-name", effective_theme)
            if icon_theme:
                gtk_settings.set_property("gtk-icon-theme-name", icon_theme)
            if font_name:
                gtk_settings.set_property("gtk-font-name", font_name)
            gtk_settings.set_property("gtk-application-prefer-dark-theme", prefer_dark)

        apply_gtk3_scroll_undershoot_fix()

        if self._on_change:
            self._on_change(prefer_dark)

    def _subscribe_system_changes(self) -> None:
        schema_source = Gio.SettingsSchemaSource.get_default()
        if schema_source and schema_source.lookup("org.cinnamon.desktop.interface", True):
            try:
                self._cinnamon_settings = Gio.Settings.new("org.cinnamon.desktop.interface")
                self._cinnamon_settings.connect("changed::gtk-theme", lambda *_args: self._apply_effective_theme())
                self._cinnamon_settings.connect("changed::icon-theme", lambda *_args: self._apply_effective_theme())
                self._cinnamon_settings.connect("changed::font-name", lambda *_args: self._apply_effective_theme())
            except Exception:
                pass

        if schema_source and schema_source.lookup("org.gnome.desktop.interface", True):
            try:
                self._gnome_settings = Gio.Settings.new("org.gnome.desktop.interface")
                self._gnome_settings.connect("changed::gtk-theme", lambda *_args: self._apply_effective_theme())
                self._gnome_settings.connect("changed::icon-theme", lambda *_args: self._apply_effective_theme())
                self._gnome_settings.connect("changed::color-scheme", lambda *_args: self._apply_effective_theme())
            except Exception:
                pass
