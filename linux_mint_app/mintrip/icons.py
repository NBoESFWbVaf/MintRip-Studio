"""Zentrale Systemicon-Registry für Linux Mint (GTK 3.0 / WhiteSur / Mint-Y / Adwaita).

Es werden ausschließlich standardisierte System-Icon-Namen verwendet. Für jedes
Symbol existiert eine Fallback-Kette, die gegen das aktive Gtk.IconTheme
geprüft wird, sodass Symbole in jedem Linux-Icon-Theme sauber geladen werden.
"""

from __future__ import annotations

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk


SYSTEM_ICON_CANDIDATES: dict[str, tuple[str, ...]] = {
    "optical_drive": ("media-optical-symbolic", "media-optical", "drive-optical-symbolic", "drive-optical"),
    "audio_track": ("audio-x-generic-symbolic", "audio-x-generic", "folder-music-symbolic"),
    "music_folder": ("folder-music-symbolic", "folder-music", "folder-symbolic", "folder"),
    "cover_image": ("image-x-generic-symbolic", "image-x-generic", "applications-graphics-symbolic"),
    "search_online": ("system-search-symbolic", "edit-find-symbolic", "system-search", "edit-find"),
    "provider_musicbrainz": (
        "network-workgroup-symbolic",
        "network-server-symbolic",
        "applications-internet-symbolic",
        "network-workgroup",
    ),
    "provider_discogs": (
        "media-optical-cd-audio-symbolic",
        "media-optical-symbolic",
        "audio-x-generic-symbolic",
        "media-optical",
    ),
    "provider_amazon": (
        "applications-internet-symbolic",
        "folder-Download-symbolic",
        "emblem-downloads-symbolic",
        "applications-internet",
    ),
    "refresh_disc": ("view-refresh-symbolic", "view-refresh"),
    "eject_disc": ("media-eject-symbolic", "media-eject"),
    "close_tray": ("go-down-symbolic", "media-eject-symbolic", "go-down", "media-eject"),
    "start_rip": ("media-playback-start-symbolic", "media-playback-start"),
    "pause_batch": ("media-playback-pause-symbolic", "media-playback-pause"),
    "stop_batch": ("process-stop-symbolic", "media-playback-stop-symbolic", "process-stop"),
    "media_play": ("media-playback-start-symbolic", "media-playback-start"),
    "media_stop": ("media-playback-stop-symbolic", "process-stop-symbolic", "media-playback-stop"),
    "save_export": ("document-save-symbolic", "document-save"),
    "add_files": ("list-add-symbolic", "list-add"),
    "remove_item": ("edit-delete-symbolic", "user-trash-symbolic", "edit-delete"),
    "clear_list": ("edit-clear-all-symbolic", "edit-clear-symbolic", "edit-clear"),
    "settings": ("preferences-system-symbolic", "emblem-system-symbolic", "preferences-system"),
    "status_ok": ("emblem-ok-symbolic", "object-select-symbolic", "emblem-default"),
    "status_warn": ("dialog-warning-symbolic", "dialog-warning"),
    "status_error": ("dialog-error-symbolic", "dialog-error"),
    "drag_handle": ("list-drag-handle-symbolic", "open-menu-symbolic", "view-more-symbolic", "pan-down-symbolic"),
    "batch_queue": ("view-list-symbolic", "view-list-details-symbolic", "format-justify-fill-symbolic", "view-list"),
    "scanner": ("document-scanner-symbolic", "document-scanner", "scanner-symbolic", "scanner", "printer-symbolic"),
    "open_file": ("document-open-symbolic", "folder-pictures-symbolic", "document-open", "folder-pictures"),
    "barcode_qr": ("view-barcode-symbolic", "camera-web-symbolic", "camera-photo-symbolic", "system-search-symbolic"),
    "shazam": ("audio-input-microphone-symbolic", "media-eq-symbolic", "audio-x-generic-symbolic", "system-search-symbolic"),
    "apply_arrow": ("go-next-symbolic", "pan-end-symbolic", "go-jump-symbolic", "go-next"),
    "classical_album": ("applications-multimedia-symbolic", "audio-x-generic-symbolic", "folder-music-symbolic"),
    "verify_artists": ("avatar-default-symbolic", "emblem-ok-symbolic", "system-users-symbolic", "avatar-default"),
    "verify_orchestra": ("system-users-symbolic", "avatar-default-symbolic", "emblem-ok-symbolic", "system-users"),
    "split_artists": ("edit-cut-symbolic", "edit-cut", "format-justify-left-symbolic", "view-list-symbolic"),
    "crop_cover": ("edit-cut-symbolic", "edit-cut", "transform-crop-and-resize", "applications-graphics-symbolic"),
    "scale_cover": ("zoom-fit-best-symbolic", "view-fullscreen-symbolic", "transform-scale", "zoom-in-symbolic"),
    "save_cover": ("document-save-symbolic", "document-save", "media-floppy-symbolic", "document-save-as-symbolic"),
    "home_start": ("go-home-symbolic", "go-home", "user-home-symbolic", "view-grid-symbolic"),
    "back_arrow": ("go-previous-symbolic", "go-previous", "go-first-symbolic"),
    "module_tag": ("emblem-documents-symbolic", "document-properties-symbolic", "folder-music-symbolic"),
    "module_convert": ("media-playlist-repeat-symbolic", "view-refresh-symbolic", "audio-x-generic-symbolic"),
    "module_repair": ("preferences-other-symbolic", "applications-utilities-symbolic", "preferences-system-symbolic"),
    "module_cut": ("edit-cut-symbolic", "edit-cut", "applications-multimedia-symbolic"),
}


PROGRAM_ICON_CANDIDATES: tuple[str, ...] = (
    "drive-optical",
    "media-optical",
    "drive-optical-symbolic",
    "media-optical-symbolic",
)


def resolve_system_icon_name(key: str) -> str:
    """Sucht den ersten im aktiven GTK3-Icon-Theme vorhandenen Systemicon-Namen."""
    candidates = SYSTEM_ICON_CANDIDATES.get(key, ("image-missing-symbolic", "image-missing"))
    icon_theme = Gtk.IconTheme.get_default()
    if icon_theme is not None:
        for name in candidates:
            if icon_theme.has_icon(name):
                return name
    return candidates[0]


def resolve_program_icon_name() -> str:
    """Liefert das CD-/Laufwerk-Programmicon (drive-optical / media-optical) im aktiven Icon-Theme."""
    icon_theme = Gtk.IconTheme.get_default()
    if icon_theme is not None:
        for name in PROGRAM_ICON_CANDIDATES:
            if icon_theme.has_icon(name):
                return name
    return PROGRAM_ICON_CANDIDATES[0]


SYSTEM_ICONS: dict[str, str] = {k: v[0] for k, v in SYSTEM_ICON_CANDIDATES.items()}


def _make_flatbed_scanner_image(pixel_size: int = 16) -> Gtk.Image | None:
    """Zeichnet ein dediziertes Flachbettscanner-Symbol (Gehäuse, geöffnetes Deckelglas, Scan-Schlitten)."""
    try:
        import cairo
        from gi.repository import Gdk

        sz = max(16, int(pixel_size))
        surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, sz, sz)
        cr = cairo.Context(surface)
        scale = sz / 24.0
        cr.scale(scale, scale)

        settings = Gtk.Settings.get_default()
        is_dark = bool(settings and settings.get_property("gtk-application-prefer-dark-theme"))
        fg = (0.90, 0.92, 0.95) if is_dark else (0.18, 0.22, 0.28)

        cr.set_source_rgba(fg[0], fg[1], fg[2], 0.95)
        cr.set_line_width(1.85)
        cr.set_line_cap(cairo.LINE_CAP_ROUND)
        cr.set_line_join(cairo.LINE_JOIN_ROUND)

        # Geöffneter Scanner-Deckel (schräg nach oben)
        cr.move_to(4.0, 12.0)
        cr.line_to(6.2, 4.2)
        cr.line_to(19.5, 2.5)
        cr.line_to(20.0, 12.0)
        cr.stroke()

        # Flachbettscanner-Unterteil (Gehäuse)
        cr.rectangle(2.2, 12.0, 19.6, 8.2)
        cr.stroke()

        # Scan-Lichtbalken auf dem Vorlagenglas
        cr.set_source_rgba(0.06, 0.72, 0.50, 0.95)
        cr.move_to(5.5, 14.5)
        cr.line_to(18.5, 14.5)
        cr.stroke()

        # Status-LED & Bedienfeld
        cr.arc(6.0, 17.5, 1.0, 0, 6.28318)
        cr.fill()
        cr.set_source_rgba(fg[0], fg[1], fg[2], 0.85)
        cr.move_to(9.5, 17.5)
        cr.line_to(13.5, 17.5)
        cr.stroke()

        pixbuf = Gdk.pixbuf_get_from_surface(surface, 0, 0, sz, sz)
        if pixbuf is not None:
            return Gtk.Image.new_from_pixbuf(pixbuf)
    except Exception:
        pass
    return None


def make_system_icon(key: str, pixel_size: int = 16) -> Gtk.Image:
    """Erstellt ein Gtk.Image über das aktive Linux-Systemtheme bzw. das dedizierte Flachbettscanner-Symbol."""
    if key == "scanner":
        custom_scanner = _make_flatbed_scanner_image(pixel_size=pixel_size)
        if custom_scanner is not None:
            return custom_scanner
    icon_name = resolve_system_icon_name(key)
    image = Gtk.Image.new_from_icon_name(icon_name, Gtk.IconSize.BUTTON)
    image.set_pixel_size(pixel_size)
    return image

