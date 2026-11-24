"""EasyTAG-kompatible 'Dateiname zu Tags'-Engine und GTK-3.0-Maskeneditor für Modul 3."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
import re
from typing import Optional

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Pango", "1.0")
from gi.repository import Gtk, Pango

from .icons import make_system_icon
from .models import AlbumMetadata, TrackMetadata, normalize_multi_artist, split_multi_value

AUDIO_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".flac",
        ".mp3",
        ".mp2",
        ".wav",
        ".aiff",
        ".aif",
        ".aifc",
        ".ogg",
        ".opus",
        ".m4a",
        ".dsf",
        ".tta",
        ".wv",
    }
)

EASYTAG_PLACEHOLDERS: list[tuple[str, str, str]] = [
    ("%a", "Interpret", "Titel-Interpret (ARTIST)"),
    ("%b", "Album", "Albumtitel (ALBUM)"),
    ("%c", "Kommentar", "Kommentar-Tag (COMMENT)"),
    ("%d", "CD-Nr.", "CD-Nummer / DiscNumber"),
    ("%g", "Genre", "Musikrichtung (GENRE)"),
    ("%i", "Ignorieren", "Beliebigen Text überspringen"),
    ("%l", "Titel gesamt", "Gesamtanzahl Titel"),
    ("%n", "Titel-Nr.", "Titelnummer (TRACKNUMBER)"),
    ("%o", "Album-Interpret", "Album- / Original-Interpret (ALBUMARTIST)"),
    ("%p", "Komponist", "Komponist (COMPOSER)"),
    ("%t", "Titel", "Liedtitel (TITLE)"),
    ("%y", "Jahr", "Erscheinungsjahr (YEAR / DATE)"),
    ("/", "Ordner-Trenner", "Übergeordnete Verzeichnisnamen einbeziehen"),
]

DEFAULT_FILENAME_MASKS: list[str] = [
    "%n - %t",
    "%n. %t",
    "%n - %a - %t",
    "%a - %t",
    "%d-%n - %t",
    "%a - %b/%n - %t",
    "%a/%b/%n - %t",
    "%a/%y - %b/%n - %t",
    "%a - %y - %b/%n - %t",
    "%b/%n - %a - %t",
    "%n %t",
]

_VALID_TOKEN_CODES: frozenset[str] = frozenset(
    {"a", "b", "c", "d", "g", "i", "l", "n", "o", "p", "t", "y"}
)
_TOKEN_RE = re.compile(r"%([a-zA-Z])")
_CUSTOM_MASKS_PATH = Path.home() / ".config" / "mintrip" / "filename_masks.json"


@dataclass
class FilenameMaskOptions:
    replace_underscores: bool = True
    clean_spaces: bool = True
    only_selected: bool = True
    only_empty_fields: bool = False


@dataclass
class FilenameTagPreviewRow:
    track_index: int
    track: TrackMetadata
    source_display: str
    matched: bool
    extracted: dict[str, str] = field(default_factory=dict)
    reason: str = ""


def load_saved_filename_masks() -> list[str]:
    """Lädt gespeicherte EasyTAG-Masken (Standard + benutzerdefinierte)."""
    custom: list[str] = []
    try:
        if _CUSTOM_MASKS_PATH.exists():
            raw = json.loads(_CUSTOM_MASKS_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                for item in raw:
                    m = str(item or "").strip()
                    if m and m not in custom:
                        custom.append(m)
    except Exception:
        custom = []

    merged: list[str] = []
    for mask in [*custom, *DEFAULT_FILENAME_MASKS]:
        if mask not in merged:
            merged.append(mask)
    return merged


def save_custom_filename_masks(masks: list[str]) -> None:
    """Speichert benutzerdefinierte EasyTAG-Masken dauerhaft."""
    custom_only = [m.strip() for m in masks if m.strip() and m.strip() not in DEFAULT_FILENAME_MASKS]
    try:
        _CUSTOM_MASKS_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CUSTOM_MASKS_PATH.write_text(
            json.dumps(custom_only, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass


def _strip_audio_extension(name: str) -> str:
    p = Path(name)
    if p.suffix.lower() in AUDIO_EXTENSIONS:
        return name[: -len(p.suffix)]
    return name


def _clean_extracted_text(value: str, options: FilenameMaskOptions) -> str:
    text = str(value or "")
    if options.replace_underscores:
        text = text.replace("%20", " ").replace("_", " ")
    if options.clean_spaces:
        text = re.sub(r"\s+", " ", text).strip()
    else:
        text = text.strip()
    return text


def _compile_segment_regex(segment_mask: str, clean_spaces: bool) -> tuple[re.Pattern[str], list[str]]:
    """Kompiliert ein einzelnes Pfadsegment einer EasyTAG-Maske in eine Regex + Code-Liste."""
    tokens: list[tuple[int, int, str]] = []
    for m in _TOKEN_RE.finditer(segment_mask):
        code = m.group(1).lower()
        if code in _VALID_TOKEN_CODES:
            tokens.append((m.start(), m.end(), code))

    parts: list[str] = ["^"]
    group_codes: list[str] = []
    cursor = 0
    total_tokens = len(tokens)

    for idx, (start, end, code) in enumerate(tokens):
        literal = segment_mask[cursor:start]
        if literal:
            esc = re.escape(literal)
            if clean_spaces:
                esc = re.sub(r"(?:\\ )+", r"\\s+", esc)
            parts.append(esc)

        is_last = idx == total_tokens - 1
        has_trailing_literal = end < len(segment_mask)
        if code in ("n", "d", "l"):
            pat = r"(\d+)"
        elif code == "y":
            pat = r"(\d{4}|\d{2})"
        elif is_last and not has_trailing_literal:
            pat = r"(.+)"
        else:
            pat = r"(.+?)"
        parts.append(pat)
        group_codes.append(code)
        cursor = end

    tail = segment_mask[cursor:]
    if tail:
        esc = re.escape(tail)
        if clean_spaces:
            esc = re.sub(r"(?:\\ )+", r"\\s+", esc)
        parts.append(esc)

    parts.append("$")
    return re.compile("".join(parts)), group_codes


def parse_path_with_mask(
    source_path: str,
    mask: str,
    options: Optional[FilenameMaskOptions] = None,
) -> tuple[bool, dict[str, str], str]:
    """Extrahiert EasyTAG-Felder aus einem Dateipfad oder Dateinamen anhand der Maske."""
    opts = options or FilenameMaskOptions()
    clean_mask = str(mask or "").strip().replace("\\", "/")
    if not clean_mask:
        return False, {}, "Leere Maske"

    norm_path = str(source_path or "").strip().replace("\\", "/")
    if not norm_path:
        return False, {}, "Kein Dateiname vorhanden"

    raw_segments = [s for s in norm_path.split("/") if s]
    if not raw_segments:
        return False, {}, "Kein Dateiname vorhanden"

    raw_segments[-1] = _strip_audio_extension(raw_segments[-1])
    mask_segments = [s for s in clean_mask.split("/") if s != ""]
    if not mask_segments:
        return False, {}, "Ungültige Maske"

    if len(raw_segments) < len(mask_segments):
        return (
            False,
            {},
            f"Pfadtiefe zu gering ({len(raw_segments)} Segment(e) für {len(mask_segments)} Masken-Ebenen)",
        )

    target_segments = raw_segments[-len(mask_segments) :]
    extracted: dict[str, str] = {}

    for seg_val, seg_mask in zip(target_segments, mask_segments):
        try:
            rx, codes = _compile_segment_regex(seg_mask, opts.clean_spaces)
        except re.error as exc:
            return False, {}, f"Masken-Fehler: {exc}"

        raw_seg = seg_val.strip()
        m = rx.match(raw_seg)
        if not m and opts.replace_underscores:
            norm_seg = raw_seg.replace("%20", " ").replace("_", " ").strip()
            m = rx.match(norm_seg)
        if not m:
            return False, {}, "Stimmt nicht mit Maske überein"

        for grp_idx, code in enumerate(codes, start=1):
            if code == "i":
                continue
            val = _clean_extracted_text(m.group(grp_idx), opts)
            if val:
                extracted[code] = val

    return True, extracted, "OK"


def build_track_source_string(track: TrackMetadata, fallback_folder: str = "") -> str:
    """Liefert den aussagekräftigsten Dateipfad / Dateinamen eines Tracks für den Masken-Parser."""
    if track.source_file is not None:
        return str(track.source_file)
    base = f"{track.track_number:02d} - {track.title}" if track.title else f"{track.track_number:02d}"
    if fallback_folder:
        return f"{fallback_folder.rstrip('/')}/{base}"
    return base


def preview_filename_mask_on_album(
    album: AlbumMetadata,
    mask: str,
    options: Optional[FilenameMaskOptions] = None,
) -> list[FilenameTagPreviewRow]:
    """Erstellt eine Live-Vorschau der extrahierten Tags für alle (oder ausgewählte) Titel."""
    opts = options or FilenameMaskOptions()
    rows: list[FilenameTagPreviewRow] = []
    mask_depth = str(mask or "").strip().replace("\\", "/").count("/")

    for idx, track in enumerate(album.tracks):
        if opts.only_selected and not track.selected:
            continue
        full_src = build_track_source_string(track)
        norm_parts = [p for p in full_src.replace("\\", "/").split("/") if p]
        if norm_parts:
            display_parts = norm_parts[-(mask_depth + 1) :]
            source_display = "/".join(display_parts)
        else:
            source_display = full_src

        matched, extracted, reason = parse_path_with_mask(full_src, mask, opts)
        rows.append(
            FilenameTagPreviewRow(
                track_index=idx,
                track=track,
                source_display=source_display,
                matched=matched,
                extracted=extracted,
                reason=reason,
            )
        )
    return rows


def apply_filename_mask_to_album(
    album: AlbumMetadata,
    mask: str,
    options: Optional[FilenameMaskOptions] = None,
) -> tuple[int, int, list[str]]:
    """Wendet die extrahierten EasyTAG-Felder auf AlbumMetadata & Tracks an.

    Rückgabe: (anzahl_treffer, anzahl_geprueft, liste_aktualisierter_feldnamen)
    """
    opts = options or FilenameMaskOptions()
    rows = preview_filename_mask_on_album(album, mask, opts)
    matched_count = 0
    touched_fields: set[str] = set()

    album_titles: list[str] = []
    album_artists: list[str] = []
    track_artists: list[str] = []
    years: list[str] = []
    genres: list[str] = []
    comments: list[str] = []
    composers: list[str] = []
    disc_nums: set[int] = set()

    def _can_set(existing: str) -> bool:
        if not opts.only_empty_fields:
            return True
        return not str(existing or "").strip()

    for row in rows:
        if not row.matched or not row.extracted:
            continue
        matched_count += 1
        ext = row.extracted
        tr = row.track

        if "n" in ext and ext["n"].isdigit():
            val_n = max(1, int(ext["n"]))
            if (not opts.only_empty_fields) or tr.track_number <= 0:
                tr.track_number = val_n
                touched_fields.add("Titelnummer")

        if "d" in ext and ext["d"].isdigit():
            val_d = max(1, int(ext["d"]))
            if (not opts.only_empty_fields) or tr.disc_number <= 0:
                tr.disc_number = val_d
                disc_nums.add(val_d)
                touched_fields.add("CD-Nr.")

        if "t" in ext and _can_set(tr.title):
            tr.title = ext["t"]
            touched_fields.add("Titel")

        if "a" in ext and _can_set(tr.artist):
            norm_a = normalize_multi_artist(ext["a"])
            tr.artist = norm_a
            tr.artists = split_multi_value(norm_a)
            track_artists.append(norm_a)
            touched_fields.add("Interpret")

        if "p" in ext and _can_set(tr.composer):
            norm_p = normalize_multi_artist(ext["p"])
            tr.composer = norm_p
            composers.append(norm_p)
            touched_fields.add("Komponist")

        if "b" in ext:
            album_titles.append(ext["b"])
        if "o" in ext:
            album_artists.append(normalize_multi_artist(ext["o"]))
        if "y" in ext:
            years.append(ext["y"])
        if "g" in ext:
            if _can_set(getattr(tr, "genre", "")):
                tr.genre = ext["g"]
                touched_fields.add("Genre")
            genres.append(ext["g"])
        if "c" in ext:
            comments.append(ext["c"])

    if album_titles and _can_set(album.title if album.title != "Unbekanntes Album" else ""):
        album.title = album_titles[0]
        touched_fields.add("Album")

    if album_artists and _can_set(album.album_artist):
        album.album_artist = album_artists[0]
        album.album_artists = split_multi_value(album_artists[0])
        if _can_set(album.artist if album.artist != "Unbekannter Künstler" else ""):
            album.artist = album_artists[0]
        touched_fields.add("Album-Interpret")
    elif track_artists:
        unique_artists = list(dict.fromkeys(track_artists))
        if len(unique_artists) == 1:
            if _can_set(album.artist if album.artist != "Unbekannter Künstler" else ""):
                album.artist = unique_artists[0]
            if _can_set(album.album_artist):
                album.album_artist = unique_artists[0]
                album.album_artists = split_multi_value(unique_artists[0])
        elif len(unique_artists) > 1 and _can_set(album.album_artist):
            album.album_artist = "Various Artists"
            album.album_artists = ["Various Artists"]

    if years and _can_set(album.year):
        album.year = years[0]
        touched_fields.add("Jahr")

    if genres and _can_set(album.genre):
        album.genre = genres[0]
        touched_fields.add("Genre")

    if comments:
        existing_comment = "; ".join(album.extra_tags.get("COMMENT", []))
        if _can_set(existing_comment):
            album.extra_tags["COMMENT"] = [comments[0]]
            touched_fields.add("Kommentar")

    if composers:
        unique_comp = list(dict.fromkeys(composers))
        if len(unique_comp) == 1 and _can_set(album.composer):
            album.composer = unique_comp[0]

    if disc_nums:
        album.total_discs = max(album.total_discs, max(disc_nums))
        album.disc_number = min(disc_nums)

    return matched_count, len(rows), sorted(touched_fields)


class FilenameToTagsDialog(Gtk.Dialog):
    """Modalfenster mit EasyTAG-Maskeneditor und Live-Vorschau für Modul 3."""

    def __init__(self, parent: Gtk.Window, album: AlbumMetadata) -> None:
        super().__init__(
            title="Dateiname zu Tags — Maskeneditor (EasyTAG)",
            transient_for=parent,
            modal=True,
        )
        self.album = album
        self.saved_masks: list[str] = load_saved_filename_masks()
        self.selected_mask: str = self.saved_masks[0] if self.saved_masks else "%n - %t"
        self.options = FilenameMaskOptions()
        self._syncing_combo = False

        self.set_default_size(940, 620)
        self.set_border_width(10)

        self.add_button("Abbrechen", Gtk.ResponseType.CANCEL)
        self.apply_btn = self.add_button("Tags übernehmen", Gtk.ResponseType.OK)
        self.apply_btn.get_style_context().add_class("suggested-action")

        content = self.get_content_area()
        content.set_spacing(10)

        # Kopfbereich
        hdr_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        hdr_box.pack_start(make_system_icon("module_tag", pixel_size=26), False, False, 0)
        hdr_txt = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        title_lbl = Gtk.Label()
        title_lbl.set_markup("<b>Dateiname zu Tags — EasyTAG-Maskeneditor</b>")
        title_lbl.set_xalign(0)
        sub_lbl = Gtk.Label()
        sub_lbl.set_markup(
            "<span size='small'>Extrahiert Metadaten aus Dateinamen und übergeordneten Ordnernamen (mit '/'). Änderungen werden live in der Vorschau angezeigt.</span>"
        )
        sub_lbl.set_xalign(0)
        sub_lbl.set_line_wrap(True)
        sub_lbl.get_style_context().add_class("dim-label")
        hdr_txt.pack_start(title_lbl, False, False, 0)
        hdr_txt.pack_start(sub_lbl, False, False, 0)
        hdr_box.pack_start(hdr_txt, True, True, 0)
        content.pack_start(hdr_box, False, False, 0)

        # Masken-Zeile + Vorlagen-Auswahl
        mask_frame = Gtk.Frame(label="Maske & Vorlagen")
        mask_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        mask_vbox.set_border_width(8)

        preset_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        preset_row.pack_start(Gtk.Label(label="Vorlage:"), False, False, 0)
        self.preset_combo = Gtk.ComboBoxText()
        self._populate_preset_combo(self.selected_mask)
        self.preset_combo.connect("changed", self._on_preset_changed)
        preset_row.pack_start(self.preset_combo, True, True, 0)

        self.save_mask_btn = Gtk.Button(label="Maske speichern")
        self.save_mask_btn.set_tooltip_text("Aktuelle Maske als Vorlage speichern")
        self.save_mask_btn.connect("clicked", self._on_save_mask_clicked)
        preset_row.pack_start(self.save_mask_btn, False, False, 0)

        self.delete_mask_btn = Gtk.Button(label="Vorlage entfernen")
        self.delete_mask_btn.set_tooltip_text("Benutzerdefinierte Vorlage entfernen")
        self.delete_mask_btn.connect("clicked", self._on_delete_mask_clicked)
        preset_row.pack_start(self.delete_mask_btn, False, False, 0)
        mask_vbox.pack_start(preset_row, False, False, 0)

        edit_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        edit_row.pack_start(Gtk.Label(label="Maske:"), False, False, 0)
        self.mask_entry = Gtk.Entry()
        self.mask_entry.set_text(self.selected_mask)
        self.mask_entry.set_placeholder_text("z. B. %a/%y - %b/%n - %t")
        self.mask_entry.connect("changed", lambda _e: self._refresh_preview())
        edit_row.pack_start(self.mask_entry, True, True, 0)

        clear_mask_btn = Gtk.Button(label="Leeren")
        clear_mask_btn.connect("clicked", lambda _b: self.mask_entry.set_text(""))
        edit_row.pack_start(clear_mask_btn, False, False, 0)
        mask_vbox.pack_start(edit_row, False, False, 0)

        # Klickbare EasyTAG-Platzhalter-Legende
        ph_lbl = Gtk.Label()
        ph_lbl.set_markup("<span size='small'><b>Platzhalter einfügen (Klick fügt an Cursor-Position ein):</b></span>")
        ph_lbl.set_xalign(0)
        mask_vbox.pack_start(ph_lbl, False, False, 0)

        ph_flow = Gtk.FlowBox()
        ph_flow.set_selection_mode(Gtk.SelectionMode.NONE)
        ph_flow.set_max_children_per_line(7)
        ph_flow.set_row_spacing(4)
        ph_flow.set_column_spacing(4)
        for code, short_lbl, tip in EASYTAG_PLACEHOLDERS:
            btn = Gtk.Button(label=f"{code}  {short_lbl}")
            btn.set_tooltip_text(f"{code}: {tip}")
            btn.connect("clicked", self._on_insert_placeholder, code)
            ph_flow.add(btn)
        mask_vbox.pack_start(ph_flow, False, False, 0)

        # Optionen-Zeile
        opt_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=14)
        self.chk_underscores = Gtk.CheckButton(label="Unterstriche (_) & %20 durch Leerzeichen ersetzen")
        self.chk_underscores.set_active(True)
        self.chk_underscores.connect("toggled", lambda _c: self._refresh_preview())
        opt_row.pack_start(self.chk_underscores, False, False, 0)

        self.chk_spaces = Gtk.CheckButton(label="Mehrfache Leerzeichen bereinigen")
        self.chk_spaces.set_active(True)
        self.chk_spaces.connect("toggled", lambda _c: self._refresh_preview())
        opt_row.pack_start(self.chk_spaces, False, False, 0)

        self.chk_empty_only = Gtk.CheckButton(label="Nur leere Tag-Felder füllen")
        self.chk_empty_only.set_active(False)
        self.chk_empty_only.connect("toggled", lambda _c: self._refresh_preview())
        opt_row.pack_start(self.chk_empty_only, False, False, 0)

        self.selected_scope_lbl = Gtk.Label()
        self.selected_scope_lbl.set_xalign(1.0)
        self.selected_scope_lbl.get_style_context().add_class("dim-label")
        opt_row.pack_end(self.selected_scope_lbl, False, False, 0)
        mask_vbox.pack_start(opt_row, False, False, 0)

        mask_frame.add(mask_vbox)
        content.pack_start(mask_frame, False, False, 0)

        # Live-Vorschau-Tabelle
        preview_frame = Gtk.Frame(label="Live-Vorschau der extrahierten Tags")
        preview_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        preview_vbox.set_border_width(8)

        self.status_label = Gtk.Label()
        self.status_label.set_xalign(0)
        preview_vbox.pack_start(self.status_label, False, False, 0)

        # Spalten: 0=Status, 1=Quelle, 2=CD, 3=Nr, 4=Titel, 5=Interpret, 6=Album, 7=Jahr, 8=Genre, 9=Weitere
        self.preview_store = Gtk.ListStore(str, str, str, str, str, str, str, str, str, str)
        self.preview_tree = Gtk.TreeView(model=self.preview_store)
        self.preview_tree.set_grid_lines(Gtk.TreeViewGridLines.BOTH)
        cols = [
            ("Status", 72, False),
            ("Dateiname / Pfad", 220, True),
            ("CD", 42, False),
            ("Nr.", 44, False),
            ("Titel", 170, True),
            ("Interpret", 140, True),
            ("Album", 130, True),
            ("Jahr", 54, False),
            ("Genre", 90, False),
            ("Weitere (%o/%p/%c)", 130, True),
        ]
        for col_idx, (col_title, min_w, expand) in enumerate(cols):
            rend = Gtk.CellRendererText()
            rend.set_property("ellipsize", Pango.EllipsizeMode.END)
            col = Gtk.TreeViewColumn(col_title, rend, text=col_idx)
            col.set_resizable(True)
            col.set_min_width(min_w)
            col.set_expand(expand)
            self.preview_tree.append_column(col)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        scroll.set_min_content_height(210)
        scroll.add(self.preview_tree)
        preview_vbox.pack_start(scroll, True, True, 0)

        preview_frame.add(preview_vbox)
        content.pack_start(preview_frame, True, True, 0)

        self.show_all()
        self._refresh_preview()

    def _populate_preset_combo(self, active_mask: str) -> None:
        self._syncing_combo = True
        try:
            self.preset_combo.remove_all()
            for mask in self.saved_masks:
                self.preset_combo.append(mask, mask)
            if active_mask in self.saved_masks:
                self.preset_combo.set_active_id(active_mask)
            elif self.saved_masks:
                self.preset_combo.set_active(0)
        finally:
            self._syncing_combo = False

    def _on_preset_changed(self, combo: Gtk.ComboBoxText) -> None:
        if self._syncing_combo:
            return
        mask_id = combo.get_active_id()
        if mask_id:
            self.mask_entry.set_text(mask_id)
            self._refresh_preview()

    def _on_insert_placeholder(self, _btn: Gtk.Button, token: str) -> None:
        pos = self.mask_entry.get_position()
        cur = self.mask_entry.get_text()
        new_text = cur[:pos] + token + cur[pos:]
        self.mask_entry.set_text(new_text)
        self.mask_entry.set_position(pos + len(token))
        self.mask_entry.grab_focus()

    def _on_save_mask_clicked(self, _btn: Gtk.Button) -> None:
        mask = self.mask_entry.get_text().strip()
        if not mask:
            return
        if mask not in self.saved_masks:
            self.saved_masks.insert(0, mask)
            save_custom_filename_masks(self.saved_masks)
            self._populate_preset_combo(mask)
        self._refresh_preview()

    def _on_delete_mask_clicked(self, _btn: Gtk.Button) -> None:
        mask = self.mask_entry.get_text().strip()
        if mask in self.saved_masks and mask not in DEFAULT_FILENAME_MASKS:
            self.saved_masks.remove(mask)
            save_custom_filename_masks(self.saved_masks)
            next_mask = self.saved_masks[0] if self.saved_masks else "%n - %t"
            self._populate_preset_combo(next_mask)
            self.mask_entry.set_text(next_mask)
        self._refresh_preview()

    def get_current_options(self) -> FilenameMaskOptions:
        return FilenameMaskOptions(
            replace_underscores=self.chk_underscores.get_active(),
            clean_spaces=self.chk_spaces.get_active(),
            only_selected=True,
            only_empty_fields=self.chk_empty_only.get_active(),
        )

    def get_current_mask(self) -> str:
        return self.mask_entry.get_text().strip()

    def _refresh_preview(self) -> None:
        mask = self.get_current_mask()
        opts = self.get_current_options()
        self.selected_mask = mask
        self.options = opts

        can_delete = mask in self.saved_masks and mask not in DEFAULT_FILENAME_MASKS
        self.delete_mask_btn.set_sensitive(can_delete)

        total_tracks = len(self.album.tracks)
        selected_tracks = sum(1 for t in self.album.tracks if t.selected)
        self.selected_scope_lbl.set_markup(
            f"<span size='small'>Gilt nur für ausgewählte Titel (<b>{selected_tracks} / {total_tracks}</b> per Checkbox aktiv)</span>"
        )

        rows = preview_filename_mask_on_album(self.album, mask, opts)
        self.preview_store.clear()

        matched = 0
        for row in rows:
            ext = row.extracted
            if row.matched:
                matched += 1
            extra_parts: list[str] = []
            if "o" in ext:
                extra_parts.append(f"Album-Int.: {ext['o']}")
            if "p" in ext:
                extra_parts.append(f"Komp.: {ext['p']}")
            if "c" in ext:
                extra_parts.append(f"Komm.: {ext['c']}")
            if "l" in ext:
                extra_parts.append(f"Gesamt: {ext['l']}")

            self.preview_store.append(
                [
                    "✓ Treffer" if row.matched else f"✕ {row.reason}",
                    row.source_display,
                    ext.get("d", ""),
                    ext.get("n", ""),
                    ext.get("t", ""),
                    ext.get("a", ""),
                    ext.get("b", ""),
                    ext.get("y", ""),
                    ext.get("g", ""),
                    " · ".join(extra_parts),
                ]
            )

        total = len(rows)
        if total_tracks == 0:
            self.status_label.set_markup(
                "<span size='small'>Keine Titel geladen. Bitte zuerst einen Album-Ordner importieren.</span>"
            )
            self.apply_btn.set_sensitive(False)
        elif total == 0:
            self.status_label.set_markup(
                "<span size='small'>Keine Titel per Checkbox ausgewählt – bitte wählen Sie in der Trackliste mindestens einen Titel aus.</span>"
            )
            self.apply_btn.set_sensitive(False)
        else:
            self.status_label.set_markup(
                f"<span size='small'><b>{matched} von {total}</b> ausgewählten Titel(n) passen zur Maske „{mask or '—'}“.</span>"
            )
            self.apply_btn.set_sensitive(matched > 0)
