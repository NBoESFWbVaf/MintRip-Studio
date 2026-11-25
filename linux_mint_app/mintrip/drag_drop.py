"""Native GTK3 Drag-and-Drop-Schnittstelle für Audiodateien, Cover-Bilder & Track-Sortierung."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gio, Gtk

SUPPORTED_AUDIO_EXTENSIONS = {
    ".wav",
    ".flac",
    ".aiff",
    ".aif",
    ".aifc",
    ".mp3",
    ".mp2",
    ".dsf",
    ".tta",
    ".ogg",
    ".m4a",
    ".opus",
    ".wv",
}
SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def _paths_from_uris(uris: list[str]) -> list[Path]:
    paths: list[Path] = []
    for uri in uris:
        gfile = Gio.File.new_for_uri(uri.strip())
        local_path = gfile.get_path()
        if local_path:
            paths.append(Path(local_path))
    return paths


def _is_external_uri_drag(drag_context: Gdk.DragContext) -> bool:
    """Prüft, ob ein laufender Drag-Vorgang externe Dateien/Ordner (text/uri-list) und keine interne Track-Sortierung enthält."""
    try:
        targets = drag_context.list_targets() or []
        names = [t.name() for t in targets if hasattr(t, "name")]
        if "mintrip-track-index" in names and "text/uri-list" not in names:
            return False
        if names:
            return "text/uri-list" in names
    except Exception:
        pass
    return True


def attach_audio_file_drop_target(
    widget: Gtk.Widget,
    on_files_dropped: Callable[[list[Path]], None],
    on_drag_hover: Callable[[bool], None] | None = None,
) -> None:
    """Ermöglicht das Ablegen von Audiodateien oder Ordnern (inkl. Unterordnern) per Drag-and-Drop."""
    if isinstance(widget, Gtk.TreeView):
        uri_target = Gtk.TargetEntry.new("text/uri-list", 0, 0)
        widget.enable_model_drag_dest([uri_target], Gdk.DragAction.COPY)
    else:
        widget.drag_dest_set(Gtk.DestDefaults.ALL, [], Gdk.DragAction.COPY)
        widget.drag_dest_add_uri_targets()

    if on_drag_hover is not None:
        def _on_drag_motion(
            _w: Gtk.Widget,
            drag_context: Gdk.DragContext,
            _x: int,
            _y: int,
            _time_val: int,
        ) -> bool:
            if _is_external_uri_drag(drag_context):
                on_drag_hover(True)
            return False

        def _on_drag_leave(
            _w: Gtk.Widget,
            _drag_context: Gdk.DragContext,
            _time_val: int,
        ) -> None:
            on_drag_hover(False)

        widget.connect("drag-motion", _on_drag_motion)
        widget.connect("drag-leave", _on_drag_leave)

    def _on_data_received(
        _widget: Gtk.Widget,
        drag_context: Gdk.DragContext,
        _x: int,
        _y: int,
        selection_data: Gtk.SelectionData,
        _info: int,
        time_val: int,
    ) -> None:
        if on_drag_hover is not None:
            on_drag_hover(False)
        uris = selection_data.get_uris() or []
        collected: list[Path] = []
        for path in _paths_from_uris(uris):
            if path.is_dir():
                collected.append(path)
            elif path.is_file() and path.suffix.lower() in SUPPORTED_AUDIO_EXTENSIONS:
                collected.append(path)

        success = bool(collected)
        if isinstance(widget, Gtk.TreeView):
            Gtk.drag_finish(drag_context, success, False, time_val)

        if collected:
            on_files_dropped(collected)

    widget.connect("drag-data-received", _on_data_received)


def attach_cover_image_drop_target(
    widget: Gtk.Widget,
    on_cover_dropped: Callable[[bytes, str, str], None],
) -> None:
    """Ermöglicht Drag-and-Drop lokaler Cover-Bilder (PNG/JPG/WebP) auf das Cover-Feld."""
    widget.drag_dest_set(Gtk.DestDefaults.ALL, [], Gdk.DragAction.COPY)
    widget.drag_dest_add_uri_targets()

    def _on_data_received(
        _widget: Gtk.Widget,
        _drag_context: Gdk.DragContext,
        _x: int,
        _y: int,
        selection_data: Gtk.SelectionData,
        _info: int,
        _time: int,
    ) -> None:
        for path in _paths_from_uris(selection_data.get_uris()):
            ext = path.suffix.lower()
            if ext in SUPPORTED_IMAGE_EXTENSIONS and path.is_file():
                mime = "image/png" if ext == ".png" else ("image/webp" if ext == ".webp" else "image/jpeg")
                on_cover_dropped(path.read_bytes(), mime, f"Drag & Drop ({path.name})")
                return

    widget.connect("drag-data-received", _on_data_received)


def attach_track_reorder_dnd(
    handle_widget: Gtk.Widget,
    row_widget: Gtk.Widget,
    track_index: int,
    on_reorder: Callable[[int, int], None],
) -> None:
    """Erlaubt das Umsortieren einzelner Tracks in der Liste per Drag-and-Drop."""
    target_entry = Gtk.TargetEntry.new("mintrip-track-index", Gtk.TargetFlags.SAME_APP, 0)

    handle_widget.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, [target_entry], Gdk.DragAction.MOVE)
    handle_widget.connect(
        "drag-data-get",
        lambda _w, _ctx, sel, _info, _t: sel.set_text(str(track_index), -1),
    )

    row_widget.drag_dest_set(Gtk.DestDefaults.ALL, [target_entry], Gdk.DragAction.MOVE)

    def _on_drop(
        _w: Gtk.Widget,
        _ctx: Gdk.DragContext,
        _x: int,
        _y: int,
        selection_data: Gtk.SelectionData,
        _info: int,
        _time: int,
    ) -> None:
        raw = selection_data.get_text()
        if raw is None:
            return
        try:
            source_idx = int(raw.strip())
        except ValueError:
            return
        if source_idx != track_index:
            on_reorder(source_idx, track_index)

    row_widget.connect("drag-data-received", _on_drop)
