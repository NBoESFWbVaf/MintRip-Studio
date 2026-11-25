"""Eigenes Einstellungsfenster (GTK 3.0) mit Reitern (Gtk.Notebook) inkl. XDG-Konfigurationsspeicherung (~/.config/mintrip)."""

from __future__ import annotations

import json
from pathlib import Path
import threading
from typing import Callable

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk

from .icons import make_system_icon, resolve_program_icon_name
from .metadata_service import (
    clear_metadata_cache,
    get_metadata_cache_stats,
    reset_musicbrainz_mirror_cooldown,
    test_musicbrainz_connection,
)
from .models import (
    COVER_PROVIDER_OPTIONS,
    DEFAULT_COVER_MAX_DIMENSION,
    DEFAULT_COVER_PROVIDERS,
    DEFAULT_MAX_THREADS,
    DEFAULT_MB_LOCAL_HOST,
    DEFAULT_MB_LOCAL_PORT,
    DEFAULT_MUSICBRAINZ_SERVER_URL,
    DEFAULT_OUTPUT_DIR_CONVERT,
    DEFAULT_OUTPUT_DIR_COVER,
    DEFAULT_OUTPUT_DIR_CUT,
    DEFAULT_OUTPUT_DIR_REPAIR,
    DEFAULT_OUTPUT_DIR_RIP,
    DEFAULT_OUTPUT_DIR_TAG,
    DEFAULT_SHAZAM_SAMPLE_SIZE,
    DEFAULT_VISIBLE_LEFT_TAG_FIELDS,
    MUSICBRAINZ_LEFT_TAG_FIELDS,
    SHAZAM_SAMPLE_SIZE_OPTIONS,
    ExportFormat,
    ExportSettings,
    Mp3QualityMode,
    build_musicbrainz_server_url,
    normalize_cover_max_dimension,
    normalize_cover_providers,
    normalize_max_threads,
    normalize_mb_local_host,
    normalize_mb_local_port,
    normalize_musicbrainz_server_url,
    normalize_shazam_sample_size,
    normalize_visible_left_tag_fields,
    parse_musicbrainz_local_host_port,
)

CONFIG_PATH = Path.home() / ".config" / "mintrip" / "settings.json"


def _read_raw_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def load_saved_settings() -> ExportSettings:
    """Lädt gespeicherte Benutzereinstellungen aus ~/.config/mintrip/settings.json."""
    settings = ExportSettings()
    data = _read_raw_config()
    if not data:
        return settings
    try:
        legacy_musik = Path.home() / "Musik"
        if "output_dir_cover" in data and str(data["output_dir_cover"]).strip():
            settings.output_dir_cover = Path(str(data["output_dir_cover"])).expanduser()
        if "output_dir_rip" in data and str(data["output_dir_rip"]).strip():
            settings.output_dir_rip = Path(str(data["output_dir_rip"])).expanduser()
        elif "output_dir" in data and str(data["output_dir"]).strip():
            cand = Path(str(data["output_dir"])).expanduser()
            settings.output_dir_rip = cand if cand != legacy_musik else DEFAULT_OUTPUT_DIR_RIP
        settings.output_dir = settings.output_dir_rip
        if "output_dir_tag" in data and str(data["output_dir_tag"]).strip():
            settings.output_dir_tag = Path(str(data["output_dir_tag"])).expanduser()
        if "output_dir_convert" in data and str(data["output_dir_convert"]).strip():
            settings.output_dir_convert = Path(str(data["output_dir_convert"])).expanduser()
        if "output_dir_repair" in data and str(data["output_dir_repair"]).strip():
            settings.output_dir_repair = Path(str(data["output_dir_repair"])).expanduser()
        if "output_dir_cut" in data and str(data["output_dir_cut"]).strip():
            settings.output_dir_cut = Path(str(data["output_dir_cut"])).expanduser()
        if "filename_template" in data and data["filename_template"]:
            settings.filename_template = str(data["filename_template"])
        if data.get("export_format") in ("flac", "mp3"):
            settings.export_format = ExportFormat(data["export_format"])
        if "flac_compression_level" in data:
            settings.flac_compression_level = max(0, min(8, int(data["flac_compression_level"])))
        if "flac_verify" in data:
            settings.flac_verify = bool(data["flac_verify"])
        if "flac_replay_gain" in data:
            settings.flac_replay_gain = bool(data["flac_replay_gain"])
        if data.get("mp3_quality") in [m.value for m in Mp3QualityMode]:
            settings.mp3_quality = Mp3QualityMode(data["mp3_quality"])
        if data.get("id3v2_version") in (3, 4):
            settings.id3v2_version = int(data["id3v2_version"])
        elif "use_id3v2_3" in data:
            settings.id3v2_version = 3 if bool(data["use_id3v2_3"]) else 4
        if "normalize_album" in data:
            settings.normalize_album = bool(data["normalize_album"])
        if "normalize_target_lufs" in data:
            lufs_val = float(data["normalize_target_lufs"])
            settings.normalize_target_lufs = max(-30.0, min(-5.0, lufs_val))
        if "normalize_compute_album_gain" in data:
            settings.normalize_compute_album_gain = bool(data["normalize_compute_album_gain"])
        if "normalize_use_loudest_track" in data:
            settings.normalize_use_loudest_track = bool(data["normalize_use_loudest_track"])
        if "normalize_true_peak" in data:
            settings.normalize_true_peak = bool(data["normalize_true_peak"])
        if "normalize_write_ref_loudness_tag" in data:
            settings.normalize_write_ref_loudness_tag = bool(data["normalize_write_ref_loudness_tag"])
        if data.get("paranoia_mode") in ("full", "disable-skip", "fast"):
            settings.paranoia_mode = str(data["paranoia_mode"])
        if "embed_cover_art" in data:
            settings.embed_cover_art = bool(data["embed_cover_art"])
        if "save_folder_cover" in data:
            settings.save_folder_cover = bool(data["save_folder_cover"])
        if "cover_filename" in data and str(data["cover_filename"]).strip():
            settings.cover_filename = str(data["cover_filename"]).strip()
        if "cover_max_dimension" in data:
            settings.cover_max_dimension = normalize_cover_max_dimension(data["cover_max_dimension"])
        if "cover_providers" in data and isinstance(data["cover_providers"], list):
            settings.cover_providers = normalize_cover_providers(data["cover_providers"])
        if "max_threads" in data:
            settings.max_threads = normalize_max_threads(data["max_threads"])
        if "discogs_token" in data:
            settings.discogs_token = str(data["discogs_token"] or "").strip()
        if "lastfm_api_key" in data:
            settings.lastfm_api_key = str(data["lastfm_api_key"] or "").strip()
        if "mb_use_local_mirror" in data:
            settings.mb_use_local_mirror = bool(data["mb_use_local_mirror"])
            settings.mb_local_host = normalize_mb_local_host(data.get("mb_local_host", DEFAULT_MB_LOCAL_HOST))
            settings.mb_local_port = normalize_mb_local_port(data.get("mb_local_port", DEFAULT_MB_LOCAL_PORT))
            settings.musicbrainz_server_url = build_musicbrainz_server_url(
                settings.mb_use_local_mirror, settings.mb_local_host, settings.mb_local_port
            )
        elif "musicbrainz_server_url" in data:
            parsed_local, parsed_host, parsed_port = parse_musicbrainz_local_host_port(
                data["musicbrainz_server_url"]
            )
            settings.mb_use_local_mirror = parsed_local
            settings.mb_local_host = parsed_host
            settings.mb_local_port = parsed_port
            settings.musicbrainz_server_url = build_musicbrainz_server_url(
                parsed_local, parsed_host, parsed_port
            )
        if "mb_fallback_to_official" in data:
            settings.mb_fallback_to_official = bool(data["mb_fallback_to_official"])
        if "mb_load_deep_relations" in data:
            settings.mb_load_deep_relations = bool(data["mb_load_deep_relations"])
        if "prefer_subgenres" in data:
            settings.prefer_subgenres = bool(data["prefer_subgenres"])
        if "auto_enrich_track_genres" in data:
            settings.auto_enrich_track_genres = bool(data["auto_enrich_track_genres"])
        if "show_query_log" in data:
            settings.show_query_log = bool(data["show_query_log"])
        if "convert_roman_numerals" in data:
            settings.convert_roman_numerals = bool(data["convert_roman_numerals"])
        if "eject_after_rip" in data:
            settings.eject_after_rip = bool(data["eject_after_rip"])
        if "scanner_device" in data:
            settings.scanner_device = str(data.get("scanner_device") or "").strip()
        if data.get("scanner_dpi") in (150, 300, 600, 1200):
            settings.scanner_dpi = int(data["scanner_dpi"])
        if data.get("scanner_color_mode") in ("Color", "Gray", "Lineart"):
            settings.scanner_color_mode = str(data["scanner_color_mode"])
        if data.get("scanner_scan_area") in ("cd_booklet", "cd_inlay", "full"):
            settings.scanner_scan_area = str(data["scanner_scan_area"])
        if "scanner_auto_open_crop" in data:
            settings.scanner_auto_open_crop = bool(data["scanner_auto_open_crop"])
        if "visible_left_tag_fields" in data and isinstance(data["visible_left_tag_fields"], list):
            settings.visible_left_tag_fields = normalize_visible_left_tag_fields(
                data["visible_left_tag_fields"]
            )
        if "shazam_sample_size" in data:
            settings.shazam_sample_size = normalize_shazam_sample_size(data["shazam_sample_size"])
        if "last_import_dir" in data and data["last_import_dir"]:
            settings.last_import_dir = Path(str(data["last_import_dir"])).expanduser()
        if "last_cover_dir" in data and data["last_cover_dir"]:
            settings.last_cover_dir = Path(str(data["last_cover_dir"])).expanduser()
    except Exception:
        pass
    return settings


def load_saved_theme_mode() -> str:
    """Lädt das gespeicherte Farbschema ('system' | 'light' | 'dark')."""
    mode = _read_raw_config().get("theme_mode", "system")
    return mode if mode in ("system", "light", "dark") else "system"


def save_settings(settings: ExportSettings, theme_mode: str | None = None) -> None:
    """Speichert Benutzereinstellungen dauerhaft in ~/.config/mintrip/settings.json."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    effective_theme_mode = theme_mode if theme_mode in ("system", "light", "dark") else load_saved_theme_mode()
    payload = {
        "output_dir": str(settings.output_dir_rip or settings.output_dir),
        "output_dir_cover": str(getattr(settings, "output_dir_cover", DEFAULT_OUTPUT_DIR_COVER)),
        "output_dir_rip": str(getattr(settings, "output_dir_rip", DEFAULT_OUTPUT_DIR_RIP)),
        "output_dir_tag": str(getattr(settings, "output_dir_tag", DEFAULT_OUTPUT_DIR_TAG)),
        "output_dir_convert": str(getattr(settings, "output_dir_convert", DEFAULT_OUTPUT_DIR_CONVERT)),
        "output_dir_repair": str(getattr(settings, "output_dir_repair", DEFAULT_OUTPUT_DIR_REPAIR)),
        "output_dir_cut": str(getattr(settings, "output_dir_cut", DEFAULT_OUTPUT_DIR_CUT)),
        "filename_template": settings.filename_template,
        "export_format": settings.export_format.value,
        "flac_compression_level": settings.flac_compression_level,
        "flac_verify": settings.flac_verify,
        "flac_replay_gain": settings.flac_replay_gain,
        "mp3_quality": settings.mp3_quality.value,
        "id3v2_version": settings.id3v2_version,
        "use_id3v2_3": settings.id3v2_version == 3,
        "normalize_album": settings.normalize_album,
        "normalize_target_lufs": round(settings.normalize_target_lufs, 1),
        "normalize_compute_album_gain": settings.normalize_compute_album_gain,
        "normalize_use_loudest_track": settings.normalize_use_loudest_track,
        "normalize_true_peak": settings.normalize_true_peak,
        "normalize_write_ref_loudness_tag": settings.normalize_write_ref_loudness_tag,
        "paranoia_mode": settings.paranoia_mode,
        "embed_cover_art": settings.embed_cover_art,
        "save_folder_cover": settings.save_folder_cover,
        "cover_filename": settings.cover_filename,
        "cover_max_dimension": normalize_cover_max_dimension(
            getattr(settings, "cover_max_dimension", DEFAULT_COVER_MAX_DIMENSION)
        ),
        "cover_providers": normalize_cover_providers(
            getattr(settings, "cover_providers", DEFAULT_COVER_PROVIDERS)
        ),
        "max_threads": normalize_max_threads(
            getattr(settings, "max_threads", DEFAULT_MAX_THREADS)
        ),
        "discogs_token": settings.discogs_token.strip(),
        "lastfm_api_key": str(getattr(settings, "lastfm_api_key", "") or "").strip(),
        "mb_use_local_mirror": bool(getattr(settings, "mb_use_local_mirror", False)),
        "mb_local_host": normalize_mb_local_host(getattr(settings, "mb_local_host", DEFAULT_MB_LOCAL_HOST)),
        "mb_local_port": normalize_mb_local_port(getattr(settings, "mb_local_port", DEFAULT_MB_LOCAL_PORT)),
        "mb_fallback_to_official": bool(getattr(settings, "mb_fallback_to_official", True)),
        "musicbrainz_server_url": build_musicbrainz_server_url(
            bool(getattr(settings, "mb_use_local_mirror", False)),
            getattr(settings, "mb_local_host", DEFAULT_MB_LOCAL_HOST),
            getattr(settings, "mb_local_port", DEFAULT_MB_LOCAL_PORT),
        ),
        "mb_load_deep_relations": bool(getattr(settings, "mb_load_deep_relations", False)),
        "prefer_subgenres": bool(getattr(settings, "prefer_subgenres", True)),
        "auto_enrich_track_genres": bool(getattr(settings, "auto_enrich_track_genres", True)),
        "show_query_log": settings.show_query_log,
        "convert_roman_numerals": settings.convert_roman_numerals,
        "eject_after_rip": settings.eject_after_rip,
        "scanner_device": settings.scanner_device.strip(),
        "scanner_dpi": settings.scanner_dpi,
        "scanner_color_mode": settings.scanner_color_mode,
        "scanner_scan_area": settings.scanner_scan_area,
        "scanner_auto_open_crop": settings.scanner_auto_open_crop,
        "visible_left_tag_fields": normalize_visible_left_tag_fields(
            getattr(settings, "visible_left_tag_fields", DEFAULT_VISIBLE_LEFT_TAG_FIELDS)
        ),
        "shazam_sample_size": normalize_shazam_sample_size(
            getattr(settings, "shazam_sample_size", DEFAULT_SHAZAM_SAMPLE_SIZE)
        ),
        "last_import_dir": str(settings.last_import_dir),
        "last_cover_dir": str(settings.last_cover_dir),
        "theme_mode": effective_theme_mode,
    }
    CONFIG_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


class SettingsPanel(Gtk.Box):
    """Wiederverwendbares Einstellungs-Panel mit Reitern (Gtk.Notebook) für die eigene Seite & das Dialogfenster."""

    def __init__(
        self,
        parent_window: Gtk.Window,
        settings: ExportSettings,
        theme_mode: str,
        on_apply: Callable[[ExportSettings, str], None],
        on_back_to_home: Callable[[], None] | None = None,
        on_cancel: Callable[[], None] | None = None,
    ) -> None:
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self._parent_window = parent_window
        self.settings = settings
        self.theme_mode = theme_mode
        self._on_apply = on_apply
        self._on_back_to_home = on_back_to_home
        self._on_cancel = on_cancel

        self._build_ui()
        self._update_format_visibility()

    def _make_tab_header(self, icon_key: str, text: str) -> Gtk.Box:
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.set_halign(Gtk.Align.START)
        box.set_hexpand(True)
        box.set_margin_top(4)
        box.set_margin_bottom(4)
        box.set_margin_start(4)
        box.set_margin_end(6)
        box.pack_start(make_system_icon(icon_key), False, False, 0)
        lbl = Gtk.Label(label=text)
        lbl.set_xalign(0)
        box.pack_start(lbl, True, True, 0)
        box.show_all()
        return box

    def _make_scrolled_tab_page(self) -> tuple[Gtk.ScrolledWindow, Gtk.Box]:
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_overlay_scrolling(False)
        page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        page.set_border_width(18)
        scroll.add(page)
        return scroll, page

    def _build_ui(self) -> None:
        self.notebook = Gtk.Notebook()
        self.notebook.set_tab_pos(Gtk.PositionType.LEFT)
        self.notebook.set_scrollable(True)
        self.pack_start(self.notebook, True, True, 0)

        # =====================================================================
        # Reiter 1: Speicherort & Benennung
        # =====================================================================
        tab1_scroll, tab1 = self._make_scrolled_tab_page()
        hdr_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        hdr_row.pack_start(
            self._section_title("Zielordner je Modul & Dateibenennung"), True, True, 0
        )
        reset_dirs_btn = Gtk.Button(label="Standardpfade wiederherstellen")
        reset_dirs_btn.set_tooltip_text(
            "Setzt die Zielordner aller 6 Module auf die empfohlenen Standardpfade zurück"
        )
        reset_dirs_btn.connect("clicked", self._on_reset_module_dirs_clicked)
        hdr_row.pack_end(reset_dirs_btn, False, False, 0)
        tab1.pack_start(hdr_row, False, False, 0)

        dirs_frame = Gtk.Frame(label="Ausgabe-/Zielordner für jedes Modul separat konfigurieren")
        dirs_grid = Gtk.Grid()
        dirs_grid.set_border_width(10)
        dirs_grid.set_column_spacing(8)
        dirs_grid.set_row_spacing(6)

        self.entry_output_dir_cover = Gtk.Entry()
        self.entry_output_dir_cover.set_hexpand(True)
        self.entry_output_dir_cover.set_text(
            str(getattr(self.settings, "output_dir_cover", DEFAULT_OUTPUT_DIR_COVER))
        )

        self.entry_output_dir_rip = Gtk.Entry()
        self.entry_output_dir_rip.set_hexpand(True)
        self.entry_output_dir_rip.set_text(
            str(getattr(self.settings, "output_dir_rip", self.settings.output_dir))
        )
        self.entry_output_dir_rip.connect("changed", lambda _e: self._update_template_preview())
        # Alias für bestehende Methoden (Vorschau etc.)
        self.entry_output_dir = self.entry_output_dir_rip

        self.entry_output_dir_tag = Gtk.Entry()
        self.entry_output_dir_tag.set_hexpand(True)
        self.entry_output_dir_tag.set_text(
            str(getattr(self.settings, "output_dir_tag", DEFAULT_OUTPUT_DIR_TAG))
        )

        self.entry_output_dir_convert = Gtk.Entry()
        self.entry_output_dir_convert.set_hexpand(True)
        self.entry_output_dir_convert.set_text(
            str(getattr(self.settings, "output_dir_convert", DEFAULT_OUTPUT_DIR_CONVERT))
        )

        self.entry_output_dir_repair = Gtk.Entry()
        self.entry_output_dir_repair.set_hexpand(True)
        self.entry_output_dir_repair.set_text(
            str(getattr(self.settings, "output_dir_repair", DEFAULT_OUTPUT_DIR_REPAIR))
        )

        self.entry_output_dir_cut = Gtk.Entry()
        self.entry_output_dir_cut.set_hexpand(True)
        self.entry_output_dir_cut.set_text(
            str(getattr(self.settings, "output_dir_cut", DEFAULT_OUTPUT_DIR_CUT))
        )

        module_dir_rows: list[tuple[str, str, Gtk.Entry]] = [
            ("module_cover", "Modul 1 · Coverbild beziehen:", self.entry_output_dir_cover),
            ("module_rip", "Modul 2 · CD-Rippen:", self.entry_output_dir_rip),
            ("module_tag", "Modul 3 · Album Taggen:", self.entry_output_dir_tag),
            ("module_convert", "Modul 4 · Musik konvertieren:", self.entry_output_dir_convert),
            ("module_repair", "Modul 5 · Musik reparieren:", self.entry_output_dir_repair),
            ("module_cut", "Modul 6 · Musik Schneiden:", self.entry_output_dir_cut),
        ]
        for row_idx, (icon_key, lbl_text, entry_widget) in enumerate(module_dir_rows):
            lbl_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            lbl_box.pack_start(make_system_icon(icon_key, pixel_size=16), False, False, 0)
            row_lbl = Gtk.Label(label=lbl_text)
            row_lbl.set_xalign(0)
            lbl_box.pack_start(row_lbl, True, True, 0)
            dirs_grid.attach(lbl_box, 0, row_idx, 1, 1)
            dirs_grid.attach(entry_widget, 1, row_idx, 1, 1)

            choose_btn = Gtk.Button()
            choose_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
            choose_box.pack_start(make_system_icon("music_folder", pixel_size=16), False, False, 0)
            choose_box.pack_start(Gtk.Label(label="Ordner wählen..."), False, False, 0)
            choose_btn.add(choose_box)
            choose_btn.connect(
                "clicked", self._on_choose_module_dir_clicked, entry_widget, lbl_text.rstrip(":")
            )
            dirs_grid.attach(choose_btn, 2, row_idx, 1, 1)

        dirs_frame.add(dirs_grid)
        tab1.pack_start(dirs_frame, False, False, 0)

        imp_lbl = Gtk.Label(label="Zuletzt gewähltes Import-Verzeichnis (Modul 2–5):")
        imp_lbl.set_xalign(0)
        tab1.pack_start(imp_lbl, False, False, 0)

        imp_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.entry_last_import_dir = Gtk.Entry()
        self.entry_last_import_dir.set_text(str(self.settings.last_import_dir))
        self.entry_last_import_dir.set_tooltip_text(
            "Wird beim Ordner- oder Datei-Import automatisch aktualisiert; Dialoge starten beim nächsten Mal wieder genau an diesem Pfad."
        )
        imp_row.pack_start(self.entry_last_import_dir, True, True, 0)

        imp_browse_btn = Gtk.Button()
        imp_browse_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        imp_browse_box.pack_start(make_system_icon("music_folder"), False, False, 0)
        imp_browse_box.pack_start(Gtk.Label(label="Import-Ordner wählen..."), False, False, 0)
        imp_browse_btn.add(imp_browse_box)
        imp_browse_btn.connect("clicked", self._on_choose_import_dir_clicked)
        imp_row.pack_start(imp_browse_btn, False, False, 0)
        tab1.pack_start(imp_row, False, False, 0)

        tpl_hdr = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        tpl_lbl = Gtk.Label(label="Pfad- & Dateinamensvorlage:")
        tpl_lbl.set_xalign(0)
        tpl_hdr.pack_start(tpl_lbl, True, True, 0)

        self._template_presets: list[tuple[str, str]] = [
            ("Schnellvorlage wählen...", ""),
            ("Standard: Interpret / Jahr - Album / Nr - Titel", "{album_artist}/{year} - {album}/{track} - {title}"),
            ("Multi-CD: Interpret / Jahr - Album / CD Nr / Nr - Titel", "{album_artist}/{year} - {album}/CD {disc}/{track} - {title}"),
            ("Kompakt (CD-Track): Interpret / Album / CD-Nr - Titel", "{album_artist}/{album}/{disc}-{track} - {title}"),
            ("Nach Genre: Genre / Interpret / Jahr - Album / Nr - Titel", "{genre}/{album_artist}/{year} - {album}/{track} - {title}"),
            ("Archiv (Label & Kat.-Nr.): Interpret / Jahr - Album [Label Kat.-Nr.] / Nr - Titel", "{album_artist}/{year} - {album} [{label} {catno}]/{track} - {title}"),
            ("Compilation / Sampler: Album (Jahr) / CD-Nr - Künstler - Titel", "{album} ({year})/{disc}-{track} - {artist} - {title}"),
        ]
        self.preset_combo = Gtk.ComboBoxText()
        for label_text, _val in self._template_presets:
            self.preset_combo.append_text(label_text)
        self.preset_combo.set_active(0)
        self.preset_combo.connect("changed", self._on_preset_selected)
        tpl_hdr.pack_end(self.preset_combo, False, False, 0)
        tab1.pack_start(tpl_hdr, False, False, 0)

        self.entry_template = Gtk.Entry()
        self.entry_template.set_text(self.settings.filename_template)
        self.entry_template.set_tooltip_text(
            "Klicke unten auf eine Variable, um sie an der aktuellen Cursor-Position einzufügen."
        )
        self.entry_template.connect("changed", lambda _e: self._update_template_preview())
        tab1.pack_start(self.entry_template, False, False, 0)

        vars_hint = Gtk.Label(label="Variablen & Trennzeichen per Klick an Cursor-Position einfügen:")
        vars_hint.set_xalign(0)
        vars_hint.get_style_context().add_class("dim-label")
        tab1.pack_start(vars_hint, False, False, 0)

        vars_flow = Gtk.FlowBox()
        vars_flow.set_selection_mode(Gtk.SelectionMode.NONE)
        vars_flow.set_max_children_per_line(5)
        vars_flow.set_row_spacing(4)
        vars_flow.set_column_spacing(4)

        variable_items: list[tuple[str, str, str]] = [
            ("{album_artist}", "Album-Interpret", "Name des Album-Interpreten (z. B. Kraftwerk)"),
            ("{artist}", "Künstler", "Interpret des einzelnen Titels"),
            ("{artist_sort}", "Sortiername", "Sortiername des Interpreten (z. B. Beatles, The)"),
            ("{album}", "Album", "Albumtitel (z. B. Computerwelt)"),
            ("{track}", "Track-Nr.", "Titelnummer (automatisch 2- oder 3-stellig, z. B. 01)"),
            ("{total_tracks}", "Gesamt-Tracks", "Gesamtanzahl der Titel auf der CD (z. B. 07)"),
            ("{title}", "Titel", "Name des Musikstücks"),
            ("{disc}", "CD-Nr.", "CD-Nummer (automatisch 2- oder 3-stellig, z. B. 01)"),
            ("{total_discs}", "Gesamt-CDs", "Gesamtanzahl der CDs des Releases"),
            ("{disc_subtitle}", "CD-Untertitel", "Untertitel der jeweiligen CD"),
            ("{year}", "Jahr", "Erscheinungsjahr (4-stellig, z. B. 1981)"),
            ("{original_year}", "Erst-Jahr", "Jahr der Erstveröffentlichung"),
            ("{date}", "Datum", "Vollständiges Veröffentlichungsdatum (z. B. 1981-05-10)"),
            ("{genre}", "Hauptgenre", "Erstes Genre des Albums (z. B. Electro)"),
            ("{label}", "Label", "Plattenlabel (z. B. Kling Klang)"),
            ("{catno}", "Katalog-Nr.", "Katalognummer des Releases"),
            ("{barcode}", "Barcode", "EAN/UPC-Barcode"),
            ("{country}", "Land", "Erscheinungsland (z. B. DE)"),
            ("{media}", "Medium", "Medienformat (z. B. CD)"),
            ("{isrc}", "ISRC", "ISRC-Code des Titels"),
            ("{composer}", "Komponist", "Komponist des Titels"),
            ("{format}", "Format", "Ausgabeformat (FLAC oder MP3)"),
            ("/", "/ Ordner", "Neuer Unterordner (Pfadtrenner)"),
            (" - ", " - ", "Bindestrich mit Leerzeichen"),
            ("_", "_", "Unterstrich"),
        ]
        for token, short_lbl, tip in variable_items:
            btn = Gtk.Button(label=f"{short_lbl} {token}" if token.startswith("{") else short_lbl)
            btn.set_tooltip_text(f"{tip} — fügt '{token}' ein")
            btn.connect("clicked", self._on_insert_template_token, token)
            vars_flow.add(btn)
        tab1.pack_start(vars_flow, False, False, 0)

        self.template_preview_lbl = Gtk.Label()
        self.template_preview_lbl.set_xalign(0)
        self.template_preview_lbl.set_line_wrap(True)
        self.template_preview_lbl.get_style_context().add_class("dim-label")
        tab1.pack_start(self.template_preview_lbl, False, False, 0)

        self.notebook.append_page(
            tab1_scroll,
            self._make_tab_header("music_folder", "Speicherort & Benennung"),
        )

        # =====================================================================
        # Reiter 2: Format & Tagging
        # =====================================================================
        tab2_scroll, tab2 = self._make_scrolled_tab_page()
        tab2.pack_start(self._section_title("Ausgabeformat (FLAC oder MP3)"), False, False, 0)

        fmt_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=16)
        self.radio_flac = Gtk.RadioButton.new_with_label_from_widget(None, "FLAC (Verlustfrei)")
        self.radio_mp3 = Gtk.RadioButton.new_with_label_from_widget(self.radio_flac, "MP3 (LAME)")
        if self.settings.export_format == ExportFormat.MP3:
            self.radio_mp3.set_active(True)
        else:
            self.radio_flac.set_active(True)
        self.radio_flac.connect("toggled", lambda _b: self._update_format_visibility())
        fmt_row.pack_start(self.radio_flac, False, False, 0)
        fmt_row.pack_start(self.radio_mp3, False, False, 0)
        tab2.pack_start(fmt_row, False, False, 0)

        # FLAC-Optionen
        self.flac_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.flac_box.set_no_show_all(True)

        flac_hdr = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        flac_lbl = Gtk.Label(label="FLAC-Kompressionsstufe (0 = schnell, 8 = kleinste Datei):")
        flac_lbl.set_xalign(0)
        flac_hdr.pack_start(flac_lbl, True, True, 0)
        self.flac_val_lbl = Gtk.Label(label=f"Stufe {self.settings.flac_compression_level}")
        flac_hdr.pack_start(self.flac_val_lbl, False, False, 0)
        self.flac_box.pack_start(flac_hdr, False, False, 0)

        self.flac_scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 8, 1)
        self.flac_scale.set_value(self.settings.flac_compression_level)
        self.flac_scale.set_digits(0)
        self.flac_scale.set_draw_value(False)
        self.flac_scale.connect(
            "value-changed",
            lambda sc: self.flac_val_lbl.set_text(f"Stufe {int(round(sc.get_value()))}"),
        )
        self.flac_box.pack_start(self.flac_scale, False, False, 0)

        self.check_flac_verify = Gtk.CheckButton(label="FLAC-Prüfsummen verifizieren (--verify)")
        self.check_flac_verify.set_active(self.settings.flac_verify)
        self.flac_box.pack_start(self.check_flac_verify, False, False, 0)

        self.check_flac_replaygain = Gtk.CheckButton(label="ReplayGain-Werte berechnen (--replay-gain)")
        self.check_flac_replaygain.set_active(self.settings.flac_replay_gain)
        self.flac_box.pack_start(self.check_flac_replaygain, False, False, 0)
        tab2.pack_start(self.flac_box, False, False, 0)

        # MP3-Optionen
        self.mp3_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.mp3_box.set_no_show_all(True)

        mp3_lbl = Gtk.Label(label="LAME MP3-Qualitätsstufe:")
        mp3_lbl.set_xalign(0)
        self.mp3_box.pack_start(mp3_lbl, False, False, 0)

        self._mp3_modes = [
            Mp3QualityMode.VBR_V0,
            Mp3QualityMode.CBR_320,
            Mp3QualityMode.CBR_256,
            Mp3QualityMode.VBR_V2,
            Mp3QualityMode.CBR_192,
        ]
        self.mp3_combo = Gtk.ComboBoxText()
        for label in (
            "MP3 VBR V0 (~245 kbps Transparenz)",
            "MP3 CBR 320 kbps (Maximum)",
            "MP3 CBR 256 kbps",
            "MP3 VBR V2 (~190 kbps Mobil)",
            "MP3 CBR 192 kbps",
        ):
            self.mp3_combo.append_text(label)
        if self.settings.mp3_quality in self._mp3_modes:
            self.mp3_combo.set_active(self._mp3_modes.index(self.settings.mp3_quality))
        else:
            self.mp3_combo.set_active(0)
        self.mp3_box.pack_start(self.mp3_combo, False, False, 0)
        tab2.pack_start(self.mp3_box, False, False, 0)

        tab2.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4)
        tab2.pack_start(self._section_title("ID3-Tag-Standard (MP3)"), False, False, 0)

        self.check_id3v2_3 = Gtk.CheckButton(
            label="ID3v2.3-Format für MP3-Tags nutzen (statt Standard ID3v2.4)"
        )
        self.check_id3v2_3.set_active(self.settings.id3v2_version == 3)
        self.check_id3v2_3.set_tooltip_text(
            "Standard ist ID3v2.4 (UTF-8). Aktivieren für maximale Kompatibilität mit älteren Autoradios und Hardware-Playern (ID3v2.3)."
        )
        tab2.pack_start(self.check_id3v2_3, False, False, 0)

        tab2.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4)
        tab2.pack_start(self._section_title("Titel-Normalisierung (Römische Ziffern)"), False, False, 0)

        self.check_convert_roman = Gtk.CheckButton(
            label="Römische Ziffern in Albentiteln und Tracknamen in arabische Zahlen umwandeln"
        )
        self.check_convert_roman.set_active(self.settings.convert_roman_numerals)
        self.check_convert_roman.set_tooltip_text(
            "Wandelt z. B. „Led Zeppelin IV“ oder „Part II“ automatisch in „Led Zeppelin 4“ bzw. „Part 2“ um. "
            "Wörter und Pronomen wie englisches „I“ (Ich), „Club Mix“, „CD“ oder Tonarten („in D“) bleiben geschützt."
        )
        tab2.pack_start(self.check_convert_roman, False, False, 0)

        roman_hint = Gtk.Label(
            label="Beispiel: „Led Zeppelin IV“ → „Led Zeppelin 4“, „Part II“ → „Part 2“. Englisches „I“ (Ich), „You and I“, „Club Mix“ und Tonarten („in D“) bleiben erhalten."
        )
        roman_hint.set_xalign(0)
        roman_hint.set_line_wrap(True)
        roman_hint.set_margin_start(22)
        roman_hint.get_style_context().add_class("dim-label")
        tab2.pack_start(roman_hint, False, False, 0)

        self.notebook.append_page(
            tab2_scroll,
            self._make_tab_header("audio_track", "Format & Tagging"),
        )

        # =====================================================================
        # Reiter 3: Normalisierung
        # =====================================================================
        tab3_scroll, tab3 = self._make_scrolled_tab_page()
        tab3.pack_start(
            self._section_title("EBU-R128 Album-Normalisierung & ReplayGain"),
            False,
            False,
            0,
        )

        self.check_normalize_album = Gtk.CheckButton(
            label="Alben normalisieren (einheitliche EBU-R128 Album-Lautstärke)"
        )
        self.check_normalize_album.set_active(self.settings.normalize_album)
        self.check_normalize_album.set_tooltip_text(
            "Misst die Album-Lautstärke und passt alle Titel mit demselben Gain-Wert auf das LUFS-Ziel an (erfordert ffmpeg)."
        )
        self.check_normalize_album.connect("toggled", self._on_normalize_album_toggled)
        tab3.pack_start(self.check_normalize_album, False, False, 0)

        self.norm_options_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.norm_options_box.set_margin_start(22)
        self.norm_options_box.set_sensitive(self.settings.normalize_album)

        lufs_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        lufs_lbl = Gtk.Label(label="Ziel-Lautstärke (LUFS, Standard -17):")
        lufs_lbl.set_xalign(0)
        lufs_row.pack_start(lufs_lbl, False, False, 0)
        self.spin_target_lufs = Gtk.SpinButton.new_with_range(-30.0, -5.0, 0.5)
        self.spin_target_lufs.set_digits(1)
        self.spin_target_lufs.set_value(self.settings.normalize_target_lufs)
        lufs_row.pack_start(self.spin_target_lufs, False, False, 0)
        lufs_unit = Gtk.Label(label="LUFS")
        lufs_row.pack_start(lufs_unit, False, False, 0)
        self.norm_options_box.pack_start(lufs_row, False, False, 0)

        self.check_norm_album_gain = Gtk.CheckButton(label="Album-Gain/-Peak berechnen")
        self.check_norm_album_gain.set_active(self.settings.normalize_compute_album_gain)
        self.check_norm_album_gain.set_tooltip_text(
            "Berechnet Album- & Titel-ReplayGain sowie Peak-Werte und schreibt die ReplayGain-Tags in FLAC/MP3."
        )
        self.norm_options_box.pack_start(self.check_norm_album_gain, False, False, 0)

        self.check_norm_loudest_track = Gtk.CheckButton(
            label="Lautesten Titel für Album-Loudness verwenden"
        )
        self.check_norm_loudest_track.set_active(self.settings.normalize_use_loudest_track)
        self.check_norm_loudest_track.set_tooltip_text(
            "Orientiert die Album-Lautstärke am lautesten Track des Albums statt am Gesamtdurchschnitt."
        )
        self.norm_options_box.pack_start(self.check_norm_loudest_track, False, False, 0)

        self.check_norm_true_peak = Gtk.CheckButton(label="True Peak verwenden")
        self.check_norm_true_peak.set_active(self.settings.normalize_true_peak)
        self.check_norm_true_peak.set_tooltip_text(
            "Nutzt Oversampled True-Peak (dBTP) statt Sample-Peak für Pegelmessung und Clipping-Schutz."
        )
        self.norm_options_box.pack_start(self.check_norm_true_peak, False, False, 0)

        self.check_norm_ref_tag = Gtk.CheckButton(
            label="Referenz-Loudness-Tag ebenfalls reinschreiben"
        )
        self.check_norm_ref_tag.set_active(self.settings.normalize_write_ref_loudness_tag)
        self.check_norm_ref_tag.set_tooltip_text(
            "Schreibt zusätzlich den Tag REPLAYGAIN_REFERENCE_LOUDNESS (z. B. -17.00 LUFS) in die Metadaten."
        )
        self.norm_options_box.pack_start(self.check_norm_ref_tag, False, False, 0)

        tab3.pack_start(self.norm_options_box, False, False, 0)

        self.notebook.append_page(
            tab3_scroll,
            self._make_tab_header("settings", "Normalisierung"),
        )

        # =====================================================================
        # Reiter 4: Cover, Laufwerk & Ansicht
        # =====================================================================
        tab4_scroll, tab4 = self._make_scrolled_tab_page()
        tab4.pack_start(self._section_title("Cover-Art & Bilddatei"), False, False, 0)

        self.check_embed_cover = Gtk.CheckButton(label="Cover-Art direkt in FLAC/ID3-Tags einbetten")
        self.check_embed_cover.set_active(self.settings.embed_cover_art)
        tab4.pack_start(self.check_embed_cover, False, False, 0)

        self.check_save_folder_cover = Gtk.CheckButton(label="Cover-Bild zusätzlich im Album-Ordner speichern")
        self.check_save_folder_cover.set_active(self.settings.save_folder_cover)
        self.check_save_folder_cover.connect(
            "toggled",
            self._on_save_folder_cover_toggled,
        )
        tab4.pack_start(self.check_save_folder_cover, False, False, 0)

        cover_name_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        cover_name_lbl = Gtk.Label(label="Dateiname des Coverbildes:")
        cover_name_lbl.set_xalign(0)
        cover_name_row.pack_start(cover_name_lbl, False, False, 0)
        self.entry_cover_filename = Gtk.Entry()
        self.entry_cover_filename.set_text(self.settings.cover_filename)
        self.entry_cover_filename.set_placeholder_text("z. B. cover, folder, front oder {album}")
        self.entry_cover_filename.set_tooltip_text(
            "Frei wählbarer Name (ohne Endung wird .jpg/.png automatisch ergänzt). Platzhalter: {album}, {artist}, {album_artist}, {year}, {disc}, {label}, {catno}"
        )
        self.entry_cover_filename.set_sensitive(self.settings.save_folder_cover)
        cover_name_row.pack_start(self.entry_cover_filename, True, True, 0)
        tab4.pack_start(cover_name_row, False, False, 0)

        self.cover_vars_flow = Gtk.FlowBox()
        self.cover_vars_flow.set_selection_mode(Gtk.SelectionMode.NONE)
        self.cover_vars_flow.set_max_children_per_line(6)
        self.cover_vars_flow.set_row_spacing(4)
        self.cover_vars_flow.set_column_spacing(4)
        self.cover_vars_flow.set_sensitive(self.settings.save_folder_cover)
        for cov_token, cov_label, mode in (
            ("cover", "cover", "replace"),
            ("folder", "folder", "replace"),
            ("front", "front", "replace"),
            ("{album}", "{album}", "insert"),
            ("{album_artist}", "{album_artist}", "insert"),
            ("{year}", "{year}", "insert"),
            ("{disc}", "{disc}", "insert"),
            ("{label}", "{label}", "insert"),
        ):
            cbtn = Gtk.Button(label=cov_label)
            cbtn.set_tooltip_text(
                f"Setzt Dateinamen auf '{cov_token}'" if mode == "replace" else f"Fügt '{cov_token}' in den Cover-Namen ein"
            )
            cbtn.connect("clicked", self._on_cover_token_clicked, cov_token, mode)
            self.cover_vars_flow.add(cbtn)
        tab4.pack_start(self.cover_vars_flow, False, False, 0)

        cov_opt_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        cov_opt_lbl = Gtk.Label(label="Max. Cover-Abmessung (Modul 5 Reparatur, px):")
        cov_opt_lbl.set_xalign(0)
        cov_opt_row.pack_start(cov_opt_lbl, False, False, 0)

        self.spin_cover_max_dim = Gtk.SpinButton.new_with_range(256, 8192, 64)
        self.spin_cover_max_dim.set_digits(0)
        self.spin_cover_max_dim.set_value(
            normalize_cover_max_dimension(
                getattr(self.settings, "cover_max_dimension", DEFAULT_COVER_MAX_DIMENSION)
            )
        )
        self.spin_cover_max_dim.set_tooltip_text(
            "Größere Cover werden bei der Reparatur proportional auf dieses Maß herunterskaliert (Standard: 2048 px)."
        )
        cov_opt_row.pack_start(self.spin_cover_max_dim, False, False, 0)

        for preset_px in (1000, 1500, 2048, 3000):
            pbtn = Gtk.Button(label=f"{preset_px} px")
            pbtn.connect("clicked", lambda _b, px=preset_px: self.spin_cover_max_dim.set_value(px))
            cov_opt_row.pack_start(pbtn, False, False, 0)
        tab4.pack_start(cov_opt_row, False, False, 0)

        cov_opt_hint = Gtk.Label(
            label="Standard: 2048 × 2048 px. Ist ein Cover innerhalb des Limits jedoch größer als 1 MB, komprimiert Modul 5 unter zwingendem Erhalt der aktuellen Pixel-Dimensionen."
        )
        cov_opt_hint.set_xalign(0)
        cov_opt_hint.set_line_wrap(True)
        cov_opt_hint.get_style_context().add_class("dim-label")
        tab4.pack_start(cov_opt_hint, False, False, 0)

        tab4.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4)
        tab4.pack_start(
            self._section_title("Cover-Bilddatenbanken (Abfragequellen)"),
            False,
            False,
            0,
        )

        cov_prov_hdr = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.cover_providers_count_label = Gtk.Label()
        self.cover_providers_count_label.set_xalign(0)
        self.cover_providers_count_label.set_line_wrap(True)
        self.cover_providers_count_label.get_style_context().add_class("dim-label")
        cov_prov_hdr.pack_start(self.cover_providers_count_label, True, True, 0)

        btn_cov_all = Gtk.Button(label="Alle aktivieren")
        btn_cov_all.connect(
            "clicked",
            lambda _b: self._set_cover_providers_selection(list(DEFAULT_COVER_PROVIDERS)),
        )
        cov_prov_hdr.pack_start(btn_cov_all, False, False, 0)

        btn_cov_none = Gtk.Button(label="Alle abwählen")
        btn_cov_none.connect(
            "clicked",
            lambda _b: self._set_cover_providers_selection([]),
        )
        cov_prov_hdr.pack_start(btn_cov_none, False, False, 0)
        tab4.pack_start(cov_prov_hdr, False, False, 0)

        self._cover_provider_checks: dict[str, Gtk.CheckButton] = {}
        self._updating_cover_provider_checks = False
        active_cov_providers = set(
            normalize_cover_providers(
                getattr(self.settings, "cover_providers", DEFAULT_COVER_PROVIDERS)
            )
        )
        cov_prov_grid = Gtk.Grid()
        cov_prov_grid.set_row_spacing(6)
        cov_prov_grid.set_column_spacing(18)
        cov_prov_grid.set_column_homogeneous(True)
        for idx, opt in enumerate(COVER_PROVIDER_OPTIONS):
            pid = str(opt["id"])
            label_txt = str(opt["label"])
            hint_txt = str(opt.get("hint", ""))
            chk = Gtk.CheckButton(label=label_txt)
            chk.set_active(pid in active_cov_providers)
            if hint_txt:
                chk.set_tooltip_text(hint_txt)
            chk.connect("toggled", self._on_cover_provider_toggled)
            self._cover_provider_checks[pid] = chk
            cov_prov_grid.attach(chk, idx % 2, idx // 2, 1, 1)
        tab4.pack_start(cov_prov_grid, False, False, 0)
        self._update_cover_providers_counter()

        tab4.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4)
        tab4.pack_start(
            self._section_title("Online-Datenbanken, Discogs & Shazam-Erkennung"),
            False,
            False,
            0,
        )

        shazam_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        shazam_lbl = Gtk.Label(label="Shazam-Samplegröße (Track-Mitte 50 %):")
        shazam_lbl.set_xalign(0)
        shazam_row.pack_start(shazam_lbl, False, False, 0)

        self._shazam_sample_values = [int(opt["value"]) for opt in SHAZAM_SAMPLE_SIZE_OPTIONS]
        self.shazam_sample_combo = Gtk.ComboBoxText()
        self.shazam_sample_combo.set_hexpand(True)
        for opt in SHAZAM_SAMPLE_SIZE_OPTIONS:
            self.shazam_sample_combo.append_text(str(opt["label"]))
        cur_shazam_sz = normalize_shazam_sample_size(
            getattr(self.settings, "shazam_sample_size", DEFAULT_SHAZAM_SAMPLE_SIZE)
        )
        if cur_shazam_sz in self._shazam_sample_values:
            self.shazam_sample_combo.set_active(self._shazam_sample_values.index(cur_shazam_sz))
        else:
            self.shazam_sample_combo.set_active(len(self._shazam_sample_values) - 1)
        self.shazam_sample_combo.set_tooltip_text(
            "Bestimmt die Länge des 16-kHz-Mono-Samples aus der Track-Mitte (16.000 Samples = 1 Sekunde). Kleinere Werte sind schneller, größere erhöhen die Treffersicherheit."
        )
        shazam_row.pack_start(self.shazam_sample_combo, True, True, 0)
        tab4.pack_start(shazam_row, False, False, 0)

        shazam_hint = Gtk.Label(
            label="Extrahiert das Shazam-Sample zentriert bei 50 % der Gesamtdauer (16.000 Samples = 1 Sekunde)."
        )
        shazam_hint.set_xalign(0)
        shazam_hint.set_line_wrap(True)
        shazam_hint.get_style_context().add_class("dim-label")
        tab4.pack_start(shazam_hint, False, False, 0)

        token_lbl = Gtk.Label(
            label="Discogs Personal Access Token (für die Discogs-Such-API /database/search):"
        )
        token_lbl.set_xalign(0)
        tab4.pack_start(token_lbl, False, False, 0)

        token_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.entry_discogs_token = Gtk.Entry()
        self.entry_discogs_token.set_text(self.settings.discogs_token)
        self.entry_discogs_token.set_visibility(False)
        self.entry_discogs_token.set_placeholder_text(
            "Optional: Kostenloses Token unter discogs.com → Settings → Developers"
        )
        self.entry_discogs_token.set_tooltip_text(
            "Wird für authentifizierte Suchanfragen an api.discogs.com/database/search verwendet."
        )
        token_row.pack_start(self.entry_discogs_token, True, True, 0)

        self.check_show_token = Gtk.CheckButton(label="Anzeigen")
        self.check_show_token.connect(
            "toggled",
            lambda btn: self.entry_discogs_token.set_visibility(btn.get_active()),
        )
        token_row.pack_start(self.check_show_token, False, False, 0)
        tab4.pack_start(token_row, False, False, 0)

        token_hint = Gtk.Label(
            label="Reihenfolge der Metadaten-Abfrage: 1. MusicBrainz → 2. Discogs → 3. CDDB/GnuDB. Cover-Abfragen nutzen alle oben aktivierten Bilddatenbanken parallel."
        )
        token_hint.set_xalign(0)
        token_hint.set_line_wrap(True)
        token_hint.get_style_context().add_class("dim-label")
        tab4.pack_start(token_hint, False, False, 0)

        lastfm_lbl = Gtk.Label(
            label="Last.fm API-Key (optional, für schnelle parallele Track-Subgenre-Tags ohne 1-Req/s-Limit):"
        )
        lastfm_lbl.set_xalign(0)
        tab4.pack_start(lastfm_lbl, False, False, 0)

        lastfm_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.entry_lastfm_api_key = Gtk.Entry()
        self.entry_lastfm_api_key.set_text(str(getattr(self.settings, "lastfm_api_key", "") or ""))
        self.entry_lastfm_api_key.set_visibility(False)
        self.entry_lastfm_api_key.set_placeholder_text(
            "Optional: Kostenloser API-Key unter last.fm/api/account/create"
        )
        self.entry_lastfm_api_key.set_tooltip_text(
            "Ermöglicht parallele Track-Tag-Abfragen (track.getTopTags) zur schnellen Anreicherung spezifischer Subgenres pro Song."
        )
        lastfm_row.pack_start(self.entry_lastfm_api_key, True, True, 0)

        self.check_show_lastfm_key = Gtk.CheckButton(label="Anzeigen")
        self.check_show_lastfm_key.connect(
            "toggled",
            lambda btn: self.entry_lastfm_api_key.set_visibility(btn.get_active()),
        )
        lastfm_row.pack_start(self.check_show_lastfm_key, False, False, 0)
        tab4.pack_start(lastfm_row, False, False, 0)

        self.check_mb_use_local_mirror = Gtk.CheckButton(
            label="Lokalen MusicBrainz-Docker-Container verwenden (ohne 1-Anfrage/Sekunde-Limit)"
        )
        self.check_mb_use_local_mirror.set_active(bool(getattr(self.settings, "mb_use_local_mirror", False)))
        self.check_mb_use_local_mirror.set_tooltip_text(
            "Leitet alle MusicBrainz-Abfragen an deinen lokalen Docker-Mirror weiter (ohne Rate-Limit). Deaktiviert = direkt offizielle Server (musicbrainz.org)."
        )
        self.check_mb_use_local_mirror.connect("toggled", self._on_mb_mirror_settings_changed)
        tab4.pack_start(self.check_mb_use_local_mirror, False, False, 0)

        self.mb_local_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.mb_local_row.set_margin_start(22)

        mb_host_lbl = Gtk.Label(label="Host / IP:")
        self.mb_local_row.pack_start(mb_host_lbl, False, False, 0)

        self.entry_mb_local_host = Gtk.Entry()
        self.entry_mb_local_host.set_text(
            normalize_mb_local_host(getattr(self.settings, "mb_local_host", DEFAULT_MB_LOCAL_HOST))
        )
        self.entry_mb_local_host.set_placeholder_text("localhost oder 192.168.178.10")
        self.entry_mb_local_host.set_tooltip_text(
            "Hostname oder IP-Adresse deines MusicBrainz-Docker-Containers (z. B. localhost, 127.0.0.1 oder LAN-IP; optional mit https://)."
        )
        self.entry_mb_local_host.connect("changed", self._on_mb_mirror_settings_changed)
        self.mb_local_row.pack_start(self.entry_mb_local_host, True, True, 0)

        mb_port_lbl = Gtk.Label(label="Port:")
        self.mb_local_row.pack_start(mb_port_lbl, False, False, 0)

        self.spin_mb_local_port = Gtk.SpinButton.new_with_range(1, 65535, 1)
        self.spin_mb_local_port.set_numeric(True)
        self.spin_mb_local_port.set_value(
            normalize_mb_local_port(getattr(self.settings, "mb_local_port", DEFAULT_MB_LOCAL_PORT))
        )
        self.spin_mb_local_port.set_tooltip_text(
            "TCP-Port des MusicBrainz-Docker-Containers (Standard bei musicbrainz-docker: 5000)."
        )
        self.spin_mb_local_port.connect("value-changed", self._on_mb_mirror_settings_changed)
        self.mb_local_row.pack_start(self.spin_mb_local_port, False, False, 0)

        self.btn_test_mb_connection = Gtk.Button(label="Verbindung testen")
        self.btn_test_mb_connection.set_tooltip_text(
            "Prüft sofort die Erreichbarkeit und Antwortzeit des eingestellten MusicBrainz-Servers."
        )
        self.btn_test_mb_connection.connect("clicked", self._on_test_mb_connection_clicked)
        self.mb_local_row.pack_start(self.btn_test_mb_connection, False, False, 0)
        tab4.pack_start(self.mb_local_row, False, False, 0)

        self.check_mb_fallback_official = Gtk.CheckButton(
            label="Bei Nichterreichbarkeit automatisch auf offizielle MusicBrainz-Server (musicbrainz.org) ausweichen"
        )
        self.check_mb_fallback_official.set_margin_start(22)
        self.check_mb_fallback_official.set_active(
            bool(getattr(self.settings, "mb_fallback_to_official", True))
        )
        self.check_mb_fallback_official.set_tooltip_text(
            "Wenn der lokale Docker-Container gestoppt oder nicht erreichbar ist, wechselt MintRip Studio automatisch ohne Wartezeit auf https://musicbrainz.org/ws/2."
        )
        self.check_mb_fallback_official.connect("toggled", self._on_mb_mirror_settings_changed)
        tab4.pack_start(self.check_mb_fallback_official, False, False, 0)

        self.mb_server_status_label = Gtk.Label()
        self.mb_server_status_label.set_xalign(0)
        self.mb_server_status_label.set_line_wrap(True)
        self.mb_server_status_label.set_margin_start(22)
        self.mb_server_status_label.get_style_context().add_class("dim-label")
        tab4.pack_start(self.mb_server_status_label, False, False, 0)
        self._update_mb_mirror_ui_state()

        self.check_prefer_subgenres = Gtk.CheckButton(
            label="Spezifische Subgenres bevorzugen (Verallgemeinerungen wie „Rock“/„Punk“ ausblenden, sobald Subgenres vorliegen)"
        )
        self.check_prefer_subgenres.set_active(bool(getattr(self.settings, "prefer_subgenres", True)))
        tab4.pack_start(self.check_prefer_subgenres, False, False, 0)

        self.check_auto_enrich_genres = Gtk.CheckButton(
            label="Fehlende Track-Genres automatisch anreichern (Release-Group-Pressungen, Discogs Styles, Last.fm)"
        )
        self.check_auto_enrich_genres.set_active(
            bool(getattr(self.settings, "auto_enrich_track_genres", True))
        )
        tab4.pack_start(self.check_auto_enrich_genres, False, False, 0)

        self.check_mb_deep_relations = Gtk.CheckButton(
            label="Tiefe MusicBrainz-Credits & Klassik-Relationen laden (Dirigent, Orchester, Work-Rels — etwas langsamer)"
        )
        self.check_mb_deep_relations.set_active(
            bool(getattr(self.settings, "mb_load_deep_relations", False))
        )
        tab4.pack_start(self.check_mb_deep_relations, False, False, 0)

        cache_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.cache_stats_label = Gtk.Label()
        self.cache_stats_label.set_xalign(0)
        self.cache_stats_label.get_style_context().add_class("dim-label")
        self._refresh_cache_stats_label()
        cache_row.pack_start(self.cache_stats_label, True, True, 0)

        self.btn_clear_metadata_cache = Gtk.Button(label="Metadaten-Cache leeren")
        self.btn_clear_metadata_cache.set_tooltip_text(
            "Löscht alle lokal zwischengespeicherten MusicBrainz-, Discogs-, Last.fm- und Wikidata-Antworten"
        )
        self.btn_clear_metadata_cache.connect("clicked", self._on_clear_metadata_cache_clicked)
        cache_row.pack_start(self.btn_clear_metadata_cache, False, False, 0)
        tab4.pack_start(cache_row, False, False, 0)

        self.check_show_query_log = Gtk.CheckButton(
            label="Abfrage-Protokoll als skalierbare Spalte am unteren Fensterrand einblenden"
        )
        self.check_show_query_log.set_active(self.settings.show_query_log)
        self.check_show_query_log.set_tooltip_text(
            "Blendet am unteren Rand des Hauptfensters eine höhenverstellbare Protokoll-Spalte für alle Online-Abfragen ein. Wenn deaktiviert, wird die Spalte vollständig ausgeblendet."
        )
        tab4.pack_start(self.check_show_query_log, False, False, 0)

        tab4.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4)
        tab4.pack_start(
            self._section_title("Scanner-Einstellungen (Direktscan per SANE / Flachbettscanner)"),
            False,
            False,
            0,
        )

        scan_hint = Gtk.Label(
            label="Beim Klick auf das Scanner-Symbol in der Cover-Toolbar wird sofort mit diesen Einstellungen gescannt und anschließend das Zuschneidefenster geöffnet."
        )
        scan_hint.set_xalign(0)
        scan_hint.set_line_wrap(True)
        scan_hint.get_style_context().add_class("dim-label")
        tab4.pack_start(scan_hint, False, False, 0)

        scan_grid = Gtk.Grid()
        scan_grid.set_column_spacing(12)
        scan_grid.set_row_spacing(8)

        dpi_lbl = Gtk.Label(label="Scan-Auflösung (DPI):")
        dpi_lbl.set_xalign(0)
        scan_grid.attach(dpi_lbl, 0, 0, 1, 1)
        self._scanner_dpi_values = [150, 300, 600, 1200]
        self.scanner_dpi_combo = Gtk.ComboBoxText()
        self.scanner_dpi_combo.set_hexpand(True)
        for text in (
            "150 DPI (Schnellvorschau)",
            "300 DPI (Standard für CD-Booklets)",
            "600 DPI (Hohe Detailtreue / Archiv)",
            "1200 DPI (Maximale Auflösung)",
        ):
            self.scanner_dpi_combo.append_text(text)
        if self.settings.scanner_dpi in self._scanner_dpi_values:
            self.scanner_dpi_combo.set_active(self._scanner_dpi_values.index(self.settings.scanner_dpi))
        else:
            self.scanner_dpi_combo.set_active(1)
        scan_grid.attach(self.scanner_dpi_combo, 1, 0, 1, 1)

        mode_lbl = Gtk.Label(label="Farbmodus:")
        mode_lbl.set_xalign(0)
        scan_grid.attach(mode_lbl, 0, 1, 1, 1)
        self._scanner_color_modes = ["Color", "Gray", "Lineart"]
        self.scanner_mode_combo = Gtk.ComboBoxText()
        self.scanner_mode_combo.set_hexpand(True)
        for text in (
            "Farbe (24-Bit RGB · Color)",
            "Graustufen (8-Bit · Gray)",
            "Strichzeichnung / S/W (Lineart)",
        ):
            self.scanner_mode_combo.append_text(text)
        if self.settings.scanner_color_mode in self._scanner_color_modes:
            self.scanner_mode_combo.set_active(
                self._scanner_color_modes.index(self.settings.scanner_color_mode)
            )
        else:
            self.scanner_mode_combo.set_active(0)
        scan_grid.attach(self.scanner_mode_combo, 1, 1, 1, 1)

        area_lbl = Gtk.Label(label="Scan-Bereich (Vorlagenglas):")
        area_lbl.set_xalign(0)
        scan_grid.attach(area_lbl, 0, 2, 1, 1)
        self._scanner_areas = ["cd_booklet", "cd_inlay", "full"]
        self.scanner_area_combo = Gtk.ComboBoxText()
        self.scanner_area_combo.set_hexpand(True)
        for text in (
            "CD-Booklet (125 × 125 mm Quadrat)",
            "CD-Inlay / Rückseite (150 × 120 mm)",
            "Volles Vorlagenglas (DIN A4)",
        ):
            self.scanner_area_combo.append_text(text)
        if self.settings.scanner_scan_area in self._scanner_areas:
            self.scanner_area_combo.set_active(self._scanner_areas.index(self.settings.scanner_scan_area))
        else:
            self.scanner_area_combo.set_active(0)
        scan_grid.attach(self.scanner_area_combo, 1, 2, 1, 1)

        dev_lbl = Gtk.Label(label="SANE-Scannergerät:")
        dev_lbl.set_xalign(0)
        scan_grid.attach(dev_lbl, 0, 3, 1, 1)
        self.entry_scanner_device = Gtk.Entry()
        self.entry_scanner_device.set_hexpand(True)
        self.entry_scanner_device.set_text(self.settings.scanner_device)
        self.entry_scanner_device.set_placeholder_text("Automatisch erkennen (Standard-SANE-Scanner)")
        scan_grid.attach(self.entry_scanner_device, 1, 3, 1, 1)

        tab4.pack_start(scan_grid, False, False, 0)

        self.check_scanner_auto_crop = Gtk.CheckButton(
            label="Nach dem Scanvorgang sofort das Fenster für den Zuschnitt öffnen"
        )
        self.check_scanner_auto_crop.set_active(self.settings.scanner_auto_open_crop)
        tab4.pack_start(self.check_scanner_auto_crop, False, False, 0)

        tab4.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4)
        tab4.pack_start(self._section_title("Optisches Laufwerk & Auslesen"), False, False, 0)

        paranoia_lbl = Gtk.Label(label="cdparanoia Fehlerkorrektur:")
        paranoia_lbl.set_xalign(0)
        tab4.pack_start(paranoia_lbl, False, False, 0)

        self._paranoia_modes = ["full", "disable-skip", "fast"]
        self.paranoia_combo = Gtk.ComboBoxText()
        for label in (
            "Vollständig (-e Fehlerkorrektur)",
            "Kein Überspringen (-Y)",
            "Schnell (-Z ohne Paranoia)",
        ):
            self.paranoia_combo.append_text(label)
        if self.settings.paranoia_mode in self._paranoia_modes:
            self.paranoia_combo.set_active(self._paranoia_modes.index(self.settings.paranoia_mode))
        else:
            self.paranoia_combo.set_active(0)
        tab4.pack_start(self.paranoia_combo, False, False, 0)

        self.check_eject_after_rip = Gtk.CheckButton(
            label="CD nach Abschluss automatisch auswerfen (nur physische CDs)"
        )
        self.check_eject_after_rip.set_tooltip_text(
            "Wirft das optische Laufwerk nur beim Rippen physischer Audio-CDs aus. Bei importierten Alben erfolgt kein Auswurf."
        )
        self.check_eject_after_rip.set_active(self.settings.eject_after_rip)
        tab4.pack_start(self.check_eject_after_rip, False, False, 0)

        tab4.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4)
        tab4.pack_start(self._section_title("Leistung & Parallelität"), False, False, 0)

        threads_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        threads_lbl = Gtk.Label(label="Maximale Threads (Analyse, Reparatur & Konvertierung):")
        threads_lbl.set_xalign(0)
        threads_row.pack_start(threads_lbl, False, False, 0)

        self.spin_max_threads = Gtk.SpinButton.new_with_range(1, 16, 1)
        self.spin_max_threads.set_digits(0)
        self.spin_max_threads.set_value(
            normalize_max_threads(getattr(self.settings, "max_threads", DEFAULT_MAX_THREADS))
        )
        self.spin_max_threads.set_tooltip_text(
            "Begrenzt sowohl gleichzeitig bearbeitete Dateien als auch FFmpeg-Threads pro Prozess (Standard: 4, Bereich: 1–16)."
        )
        threads_row.pack_start(self.spin_max_threads, False, False, 0)

        for preset_thr in (1, 2, DEFAULT_MAX_THREADS, 8):
            tbtn = Gtk.Button(label=f"{preset_thr} {'Thread' if preset_thr == 1 else 'Threads'}")
            tbtn.connect("clicked", lambda _b, thr=preset_thr: self.spin_max_threads.set_value(thr))
            threads_row.pack_start(tbtn, False, False, 0)
        tab4.pack_start(threads_row, False, False, 0)

        threads_hint = Gtk.Label(
            label="Begrenzt gleichzeitig laufende Dateien sowie FFmpeg-Threads pro Prozess auf insgesamt maximal diesen Wert (Standard: 4), damit der Computer nicht überlastet wird."
        )
        threads_hint.set_xalign(0)
        threads_hint.set_line_wrap(True)
        threads_hint.get_style_context().add_class("dim-label")
        tab4.pack_start(threads_hint, False, False, 0)

        tab4.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4)
        tab4.pack_start(self._section_title("Darstellung & Systemthema"), False, False, 0)

        theme_lbl = Gtk.Label(label="Farbschema (Light / Dark Mode):")
        theme_lbl.set_xalign(0)
        tab4.pack_start(theme_lbl, False, False, 0)

        self._theme_modes = ["system", "light", "dark"]
        self.theme_combo = Gtk.ComboBoxText()
        for label in (
            "Systemthema automatisch übernehmen",
            "Immer Hell (Light-Variante)",
            "Immer Dunkel (Dark-Variante)",
        ):
            self.theme_combo.append_text(label)
        if self.theme_mode in self._theme_modes:
            self.theme_combo.set_active(self._theme_modes.index(self.theme_mode))
        else:
            self.theme_combo.set_active(0)
        tab4.pack_start(self.theme_combo, False, False, 0)

        self.notebook.append_page(
            tab4_scroll,
            self._make_tab_header("scanner", "Cover, Scanner & Laufwerk"),
        )

        # =====================================================================
        # Reiter 5: Tag-Felder (MusicBrainz) für linke Spalte in Modul 2 & 3
        # =====================================================================
        tab5_scroll, tab5 = self._make_scrolled_tab_page()
        tab5.pack_start(
            self._section_title("Eingabefelder in der linken Spalte (MusicBrainz-Tags)"),
            False,
            False,
            0,
        )

        tag_fields_intro_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.tag_fields_count_label = Gtk.Label()
        self.tag_fields_count_label.set_xalign(0)
        self.tag_fields_count_label.set_line_wrap(True)
        self.tag_fields_count_label.get_style_context().add_class("dim-label")
        tag_fields_intro_row.pack_start(self.tag_fields_count_label, True, True, 0)

        tag_fields_btns = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        btn_defaults = Gtk.Button(label="Standard wiederherstellen")
        btn_defaults.connect("clicked", lambda _b: self._set_left_tag_fields_selection(DEFAULT_VISIBLE_LEFT_TAG_FIELDS))
        tag_fields_btns.pack_start(btn_defaults, False, False, 0)

        btn_all = Gtk.Button(label="Alle aktivieren")
        btn_all.connect(
            "clicked",
            lambda _b: self._set_left_tag_fields_selection([str(f["id"]) for f in MUSICBRAINZ_LEFT_TAG_FIELDS]),
        )
        tag_fields_btns.pack_start(btn_all, False, False, 0)
        tag_fields_intro_row.pack_end(tag_fields_btns, False, False, 0)
        tab5.pack_start(tag_fields_intro_row, False, False, 0)

        self._left_tag_field_checks: dict[str, Gtk.CheckButton] = {}
        self._updating_left_tag_checks = False
        active_field_set = set(
            normalize_visible_left_tag_fields(
                getattr(self.settings, "visible_left_tag_fields", DEFAULT_VISIBLE_LEFT_TAG_FIELDS)
            )
        )

        cat_defs = (
            ("basis", "Basis-Tags & Albumdaten"),
            ("release", "Release-, Datums- & Sprach-Tags"),
            ("credits", "Mitwirkende, Credits & Klassik"),
            ("identifiers", "Identifikationsnummern & Barcodes"),
        )
        for cat_key, cat_title in cat_defs:
            cat_frame = Gtk.Frame(label=cat_title)
            cat_grid = Gtk.Grid(column_spacing=12, row_spacing=4)
            cat_grid.set_border_width(8)
            cat_grid.set_column_homogeneous(True)
            cat_fields = [f for f in MUSICBRAINZ_LEFT_TAG_FIELDS if f["category"] == cat_key]
            for idx, field_spec in enumerate(cat_fields):
                fid = str(field_spec["id"])
                chk = Gtk.CheckButton()
                chk_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
                lbl = Gtk.Label(label=str(field_spec["label"]))
                lbl.set_xalign(0)
                chk_box.pack_start(lbl, True, True, 0)
                tag_lbl = Gtk.Label()
                tag_lbl.set_markup(
                    f"<span font_family='monospace' size='small'>{GLib.markup_escape_text(str(field_spec['mb_tag']))}</span>"
                )
                tag_lbl.get_style_context().add_class("dim-label")
                chk_box.pack_end(tag_lbl, False, False, 0)
                chk.add(chk_box)
                chk.set_active(fid in active_field_set)
                chk.connect("toggled", self._on_left_tag_field_toggled)
                self._left_tag_field_checks[fid] = chk
                cat_grid.attach(chk, idx % 2, idx // 2, 1, 1)
            cat_frame.add(cat_grid)
            tab5.pack_start(cat_frame, False, False, 0)

        self._update_left_tag_fields_counter()
        self.notebook.append_page(
            tab5_scroll,
            self._make_tab_header("module_tag", "Tag-Felder (MusicBrainz)"),
        )

        # Untere Aktionsleiste
        self.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)
        action_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        action_bar.set_border_width(12)

        save_btn = Gtk.Button()
        save_btn.get_style_context().add_class("suggested-action")
        save_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        save_box.pack_start(make_system_icon("save_export"), False, False, 0)
        save_box.pack_start(Gtk.Label(label="Übernehmen & Speichern"), False, False, 0)
        save_btn.add(save_box)
        save_btn.connect("clicked", self._on_save_clicked)
        action_bar.pack_end(save_btn, False, False, 0)

        if self._on_cancel is not None:
            cancel_btn = Gtk.Button(label="Abbrechen")
            cancel_btn.connect("clicked", lambda _b: self._on_cancel())
            action_bar.pack_end(cancel_btn, False, False, 0)

        self.pack_start(action_bar, False, False, 0)
        self._update_template_preview()

    def load_from_settings(self, settings: ExportSettings, theme_mode: str) -> None:
        """Synchronisiert alle Eingabefelder mit den aktuellen Einstellungen."""
        self.settings = settings
        self.theme_mode = theme_mode
        self.entry_output_dir.set_text(str(settings.output_dir))
        if hasattr(self, "entry_last_import_dir"):
            self.entry_last_import_dir.set_text(str(settings.last_import_dir))
        self.entry_template.set_text(settings.filename_template)
        if settings.export_format == ExportFormat.MP3:
            self.radio_mp3.set_active(True)
        else:
            self.radio_flac.set_active(True)
        self.flac_scale.set_value(settings.flac_compression_level)
        self.check_flac_verify.set_active(settings.flac_verify)
        self.check_flac_replaygain.set_active(settings.flac_replay_gain)
        if settings.mp3_quality in self._mp3_modes:
            self.mp3_combo.set_active(self._mp3_modes.index(settings.mp3_quality))
        self.check_id3v2_3.set_active(settings.id3v2_version == 3)
        self.check_convert_roman.set_active(settings.convert_roman_numerals)
        self.check_normalize_album.set_active(settings.normalize_album)
        self.norm_options_box.set_sensitive(settings.normalize_album)
        self.spin_target_lufs.set_value(settings.normalize_target_lufs)
        self.check_norm_album_gain.set_active(settings.normalize_compute_album_gain)
        self.check_norm_loudest_track.set_active(settings.normalize_use_loudest_track)
        self.check_norm_true_peak.set_active(settings.normalize_true_peak)
        self.check_norm_ref_tag.set_active(settings.normalize_write_ref_loudness_tag)
        self.check_embed_cover.set_active(settings.embed_cover_art)
        self.check_save_folder_cover.set_active(settings.save_folder_cover)
        self.entry_cover_filename.set_text(settings.cover_filename)
        self.entry_cover_filename.set_sensitive(settings.save_folder_cover)
        self.cover_vars_flow.set_sensitive(settings.save_folder_cover)
        if hasattr(self, "spin_cover_max_dim"):
            self.spin_cover_max_dim.set_value(
                normalize_cover_max_dimension(
                    getattr(settings, "cover_max_dimension", DEFAULT_COVER_MAX_DIMENSION)
                )
            )
        if hasattr(self, "_cover_provider_checks"):
            self._set_cover_providers_selection(
                normalize_cover_providers(
                    getattr(settings, "cover_providers", DEFAULT_COVER_PROVIDERS)
                )
            )
        if hasattr(self, "spin_max_threads"):
            self.spin_max_threads.set_value(
                normalize_max_threads(
                    getattr(settings, "max_threads", DEFAULT_MAX_THREADS)
                )
            )
        self.entry_discogs_token.set_text(settings.discogs_token)
        if hasattr(self, "entry_lastfm_api_key"):
            self.entry_lastfm_api_key.set_text(str(getattr(settings, "lastfm_api_key", "") or ""))
        if hasattr(self, "check_mb_use_local_mirror"):
            self.check_mb_use_local_mirror.set_active(
                bool(getattr(settings, "mb_use_local_mirror", False))
            )
        if hasattr(self, "entry_mb_local_host"):
            self.entry_mb_local_host.set_text(
                normalize_mb_local_host(getattr(settings, "mb_local_host", DEFAULT_MB_LOCAL_HOST))
            )
        if hasattr(self, "spin_mb_local_port"):
            self.spin_mb_local_port.set_value(
                normalize_mb_local_port(getattr(settings, "mb_local_port", DEFAULT_MB_LOCAL_PORT))
            )
        if hasattr(self, "check_mb_fallback_official"):
            self.check_mb_fallback_official.set_active(
                bool(getattr(settings, "mb_fallback_to_official", True))
            )
        self._update_mb_mirror_ui_state()
        if hasattr(self, "check_mb_deep_relations"):
            self.check_mb_deep_relations.set_active(
                bool(getattr(settings, "mb_load_deep_relations", False))
            )
        if hasattr(self, "check_prefer_subgenres"):
            self.check_prefer_subgenres.set_active(
                bool(getattr(settings, "prefer_subgenres", True))
            )
        if hasattr(self, "check_auto_enrich_genres"):
            self.check_auto_enrich_genres.set_active(
                bool(getattr(settings, "auto_enrich_track_genres", True))
            )
        self._refresh_cache_stats_label()
        self.check_show_query_log.set_active(settings.show_query_log)
        if settings.scanner_dpi in self._scanner_dpi_values:
            self.scanner_dpi_combo.set_active(self._scanner_dpi_values.index(settings.scanner_dpi))
        if settings.scanner_color_mode in self._scanner_color_modes:
            self.scanner_mode_combo.set_active(self._scanner_color_modes.index(settings.scanner_color_mode))
        if settings.scanner_scan_area in self._scanner_areas:
            self.scanner_area_combo.set_active(self._scanner_areas.index(settings.scanner_scan_area))
        self.entry_scanner_device.set_text(settings.scanner_device)
        self.check_scanner_auto_crop.set_active(settings.scanner_auto_open_crop)
        if settings.paranoia_mode in self._paranoia_modes:
            self.paranoia_combo.set_active(self._paranoia_modes.index(settings.paranoia_mode))
        self.check_eject_after_rip.set_active(settings.eject_after_rip)
        if theme_mode in self._theme_modes:
            self.theme_combo.set_active(self._theme_modes.index(theme_mode))
        cur_shazam_sz = normalize_shazam_sample_size(
            getattr(settings, "shazam_sample_size", DEFAULT_SHAZAM_SAMPLE_SIZE)
        )
        if cur_shazam_sz in self._shazam_sample_values:
            self.shazam_sample_combo.set_active(self._shazam_sample_values.index(cur_shazam_sz))
        self._set_left_tag_fields_selection(
            normalize_visible_left_tag_fields(
                getattr(settings, "visible_left_tag_fields", DEFAULT_VISIBLE_LEFT_TAG_FIELDS)
            )
        )
        self._update_format_visibility()

    def _on_left_tag_field_toggled(self, _btn: Gtk.CheckButton) -> None:
        if self._updating_left_tag_checks:
            return
        self._update_left_tag_fields_counter()

    def _set_left_tag_fields_selection(self, field_ids: list[str]) -> None:
        wanted = set(normalize_visible_left_tag_fields(field_ids))
        self._updating_left_tag_checks = True
        try:
            for fid, chk in self._left_tag_field_checks.items():
                chk.set_active(fid in wanted)
        finally:
            self._updating_left_tag_checks = False
        self._update_left_tag_fields_counter()

    def _get_selected_left_tag_fields(self) -> list[str]:
        return [
            str(f["id"])
            for f in MUSICBRAINZ_LEFT_TAG_FIELDS
            if str(f["id"]) in self._left_tag_field_checks
            and self._left_tag_field_checks[str(f["id"])].get_active()
        ]

    def _update_left_tag_fields_counter(self) -> None:
        if not hasattr(self, "tag_fields_count_label"):
            return
        active_cnt = sum(1 for chk in self._left_tag_field_checks.values() if chk.get_active())
        self.tag_fields_count_label.set_text(
            f"Wähle per Checkbox aus allen gängigen MusicBrainz-Tags, welche Eingabefelder in der linken Spalte von Modul 2 & 3 angezeigt werden. ({active_cnt} von {len(MUSICBRAINZ_LEFT_TAG_FIELDS)} aktiv)"
        )

    def _on_cover_provider_toggled(self, _btn: Gtk.CheckButton) -> None:
        if getattr(self, "_updating_cover_provider_checks", False):
            return
        self._update_cover_providers_counter()

    def _set_cover_providers_selection(self, provider_ids: list[str]) -> None:
        wanted = set(normalize_cover_providers(provider_ids))
        self._updating_cover_provider_checks = True
        try:
            for pid, chk in self._cover_provider_checks.items():
                chk.set_active(pid in wanted)
        finally:
            self._updating_cover_provider_checks = False
        self._update_cover_providers_counter()

    def _get_selected_cover_providers(self) -> list[str]:
        return [
            str(opt["id"])
            for opt in COVER_PROVIDER_OPTIONS
            if str(opt["id"]) in self._cover_provider_checks
            and self._cover_provider_checks[str(opt["id"])].get_active()
        ]

    def _update_cover_providers_counter(self) -> None:
        if not hasattr(self, "cover_providers_count_label"):
            return
        active_cnt = sum(1 for chk in self._cover_provider_checks.values() if chk.get_active())
        total_cnt = len(COVER_PROVIDER_OPTIONS)
        if active_cnt == 0:
            self.cover_providers_count_label.set_text(
                f"0 von {total_cnt} Bilddatenbanken aktiviert – bitte mindestens eine Quelle für die Online-Cover-Suche aktivieren."
            )
        else:
            self.cover_providers_count_label.set_text(
                f"{active_cnt} von {total_cnt} Bilddatenbanken aktiviert (alle aktivierten Quellen werden parallel ohne API-Schlüssel abgefragt)."
            )

    def _refresh_cache_stats_label(self) -> None:
        if not hasattr(self, "cache_stats_label"):
            return
        stats = get_metadata_cache_stats()
        entries = int(stats.get("entries", 0) or 0)
        size_kb = float(stats.get("size_bytes", 0) or 0) / 1024.0
        self.cache_stats_label.set_text(
            f"Lokaler Metadaten-Cache: {entries} Einträge ({size_kb:.1f} KB · sofortige Treffer ohne Rate-Limit)"
        )

    def _on_clear_metadata_cache_clicked(self, _btn: Gtk.Button) -> None:
        clear_metadata_cache()
        self._refresh_cache_stats_label()

    def _get_effective_mb_url_from_widgets(self) -> str:
        use_local = bool(getattr(self, "check_mb_use_local_mirror", None) and self.check_mb_use_local_mirror.get_active())
        host = self.entry_mb_local_host.get_text() if hasattr(self, "entry_mb_local_host") else DEFAULT_MB_LOCAL_HOST
        port = self.spin_mb_local_port.get_value_as_int() if hasattr(self, "spin_mb_local_port") else DEFAULT_MB_LOCAL_PORT
        return build_musicbrainz_server_url(use_local, host, port)

    def _update_mb_mirror_ui_state(self, status_override: str | None = None) -> None:
        if not hasattr(self, "check_mb_use_local_mirror"):
            return
        use_local = self.check_mb_use_local_mirror.get_active()
        if hasattr(self, "entry_mb_local_host"):
            self.entry_mb_local_host.set_sensitive(use_local)
        if hasattr(self, "spin_mb_local_port"):
            self.spin_mb_local_port.set_sensitive(use_local)
        if hasattr(self, "check_mb_fallback_official"):
            self.check_mb_fallback_official.set_sensitive(use_local)
        if hasattr(self, "mb_server_status_label"):
            if status_override is not None:
                self.mb_server_status_label.set_markup(status_override)
            else:
                eff_url = self._get_effective_mb_url_from_widgets()
                if use_local:
                    fb_txt = (
                        " · automatischer Fallback auf musicbrainz.org aktiv"
                        if self.check_mb_fallback_official.get_active()
                        else " · Fallback deaktiviert"
                    )
                    self.mb_server_status_label.set_markup(
                        f"Aktiver Endpunkt: <tt>{GLib.markup_escape_text(eff_url)}</tt>{GLib.markup_escape_text(fb_txt)}"
                    )
                else:
                    self.mb_server_status_label.set_markup(
                        f"Aktiver Endpunkt: <tt>{GLib.markup_escape_text(DEFAULT_MUSICBRAINZ_SERVER_URL)}</tt> (offizielle MusicBrainz-Server)"
                    )

    def _on_mb_mirror_settings_changed(self, *_args) -> None:
        self._update_mb_mirror_ui_state()

    def _on_test_mb_connection_clicked(self, _btn: Gtk.Button) -> None:
        target_url = self._get_effective_mb_url_from_widgets()
        self.btn_test_mb_connection.set_sensitive(False)
        self._update_mb_mirror_ui_state(
            f"Prüfe Verbindung zu <tt>{GLib.markup_escape_text(target_url)}</tt>…"
        )

        def _worker() -> None:
            ok, _ms, msg = test_musicbrainz_connection(target_url, timeout=4.0)
            use_local = self.check_mb_use_local_mirror.get_active()
            fb_active = self.check_mb_fallback_official.get_active()
            if ok:
                markup = f"<span foreground='#2e7d32'><b>✓ {GLib.markup_escape_text(msg)}</b></span> (<tt>{GLib.markup_escape_text(target_url)}</tt>)"
            else:
                fb_hint = (
                    " – Ausweichen auf musicbrainz.org ist aktiv."
                    if use_local and fb_active
                    else ""
                )
                markup = f"<span foreground='#c62828'><b>✗ {GLib.markup_escape_text(msg)}</b></span>{GLib.markup_escape_text(fb_hint)}"

            def _apply_result() -> bool:
                if hasattr(self, "btn_test_mb_connection"):
                    self.btn_test_mb_connection.set_sensitive(True)
                self._update_mb_mirror_ui_state(markup)
                return False

            GLib.idle_add(_apply_result)

        threading.Thread(target=_worker, daemon=True).start()

    def _section_title(self, text: str) -> Gtk.Label:
        lbl = Gtk.Label()
        lbl.set_markup(f"<b>{GLib.markup_escape_text(text)}</b>")
        lbl.set_xalign(0)
        return lbl

    def _on_preset_selected(self, combo: Gtk.ComboBoxText) -> None:
        idx = combo.get_active()
        if idx is not None and 0 < idx < len(self._template_presets):
            preset_tpl = self._template_presets[idx][1]
            if preset_tpl:
                self.entry_template.set_text(preset_tpl)
                self.entry_template.set_position(-1)

    def _on_insert_template_token(self, _btn: Gtk.Button, token: str) -> None:
        pos = self.entry_template.get_position()
        current = self.entry_template.get_text()
        if pos < 0 or pos > len(current):
            pos = len(current)
        updated = current[:pos] + token + current[pos:]
        self.entry_template.set_text(updated)
        self.entry_template.grab_focus()
        self.entry_template.set_position(pos + len(token))

    def _on_save_folder_cover_toggled(self, btn: Gtk.CheckButton) -> None:
        active = btn.get_active()
        self.entry_cover_filename.set_sensitive(active)
        self.cover_vars_flow.set_sensitive(active)

    def _on_cover_token_clicked(self, _btn: Gtk.Button, token: str, mode: str) -> None:
        if mode == "replace":
            self.entry_cover_filename.set_text(token)
            self.entry_cover_filename.grab_focus()
            self.entry_cover_filename.set_position(-1)
            return
        pos = self.entry_cover_filename.get_position()
        current = self.entry_cover_filename.get_text()
        if pos < 0 or pos > len(current):
            pos = len(current)
        updated = current[:pos] + token + current[pos:]
        self.entry_cover_filename.set_text(updated)
        self.entry_cover_filename.grab_focus()
        self.entry_cover_filename.set_position(pos + len(token))

    def _update_template_preview(self) -> None:
        if not hasattr(self, "template_preview_lbl"):
            return
        tpl = self.entry_template.get_text().strip() or "{album_artist}/{year} - {album}/{track} - {title}"
        ext = "flac" if (not hasattr(self, "radio_flac") or self.radio_flac.get_active()) else "mp3"
        fmt_upper = ext.upper()
        sample_map = {
            "{album_artist}": "Kraftwerk",
            "{artist}": "Kraftwerk",
            "{artist_sort}": "Kraftwerk",
            "{album}": "Computerwelt",
            "{track}": "01",
            "{track:02d}": "01",
            "{track:03d}": "001",
            "{total_tracks}": "07",
            "{title}": "Computerwelt",
            "{disc}": "01",
            "{disc:02d}": "01",
            "{total_discs}": "01",
            "{disc_subtitle}": "CD 01",
            "{year}": "1981",
            "{original_year}": "1981",
            "{date}": "1981-05-10",
            "{genre}": "Electro",
            "{genres}": "Electro; Synth-Pop",
            "{label}": "Kling Klang",
            "{catno}": "1C 064-46 311",
            "{barcode}": "5099996602229",
            "{country}": "DE",
            "{media}": "CD",
            "{isrc}": "DEAE68100101",
            "{composer}": "Hütter",
            "{format}": fmt_upper,
        }
        rendered = tpl
        for k, v in sample_map.items():
            rendered = rendered.replace(k, v)
        base_dir = (self.entry_output_dir.get_text().strip() or str(self.settings.output_dir)).rstrip("/")
        self.template_preview_lbl.set_markup(
            f"<b>Beispiel-Pfad:</b> <tt>{GLib.markup_escape_text(f'{base_dir}/{rendered}.{ext}')}</tt>"
        )

    def _on_normalize_album_toggled(self, btn: Gtk.CheckButton) -> None:
        active = btn.get_active()
        self.norm_options_box.set_sensitive(active)

    def _update_format_visibility(self) -> None:
        is_flac = self.radio_flac.get_active()
        if is_flac:
            self.flac_box.show_all()
            self.mp3_box.hide()
        else:
            self.flac_box.hide()
            self.mp3_box.show_all()
        self._update_template_preview()

    def _on_reset_module_dirs_clicked(self, _btn: Gtk.Button) -> None:
        self.entry_output_dir_cover.set_text(str(DEFAULT_OUTPUT_DIR_COVER))
        self.entry_output_dir_rip.set_text(str(DEFAULT_OUTPUT_DIR_RIP))
        self.entry_output_dir_tag.set_text(str(DEFAULT_OUTPUT_DIR_TAG))
        self.entry_output_dir_convert.set_text(str(DEFAULT_OUTPUT_DIR_CONVERT))
        self.entry_output_dir_repair.set_text(str(DEFAULT_OUTPUT_DIR_REPAIR))
        self.entry_output_dir_cut.set_text(str(DEFAULT_OUTPUT_DIR_CUT))
        self._update_template_preview()

    def _on_choose_module_dir_clicked(
        self, _btn: Gtk.Button, target_entry: Gtk.Entry, module_label: str
    ) -> None:
        dialog = Gtk.FileChooserDialog(
            title=f"Zielordner für {module_label} wählen",
            transient_for=self._parent_window,
            action=Gtk.FileChooserAction.SELECT_FOLDER,
        )
        dialog.add_buttons(
            "Abbrechen",
            Gtk.ResponseType.CANCEL,
            "Ordner wählen",
            Gtk.ResponseType.OK,
        )
        current = Path(target_entry.get_text().strip() or str(self.settings.output_dir)).expanduser()
        if current.exists():
            dialog.set_current_folder(str(current))
        elif current.parent.exists():
            dialog.set_current_folder(str(current.parent))
        response = dialog.run()
        if response == Gtk.ResponseType.OK:
            chosen = dialog.get_filename()
            if chosen:
                target_entry.set_text(chosen)
        dialog.destroy()

    def _on_choose_dir_clicked(self, _btn: Gtk.Button) -> None:
        self._on_choose_module_dir_clicked(_btn, self.entry_output_dir_rip, "Modul 2 · CD-Rippen")

    def _on_choose_import_dir_clicked(self, _btn: Gtk.Button) -> None:
        dialog = Gtk.FileChooserDialog(
            title="Standard-Import-Verzeichnis wählen",
            transient_for=self._parent_window,
            action=Gtk.FileChooserAction.SELECT_FOLDER,
        )
        dialog.add_buttons(
            "Abbrechen",
            Gtk.ResponseType.CANCEL,
            "Ordner wählen",
            Gtk.ResponseType.OK,
        )
        current = Path(self.entry_last_import_dir.get_text().strip() or str(self.settings.last_import_dir)).expanduser()
        if current.exists():
            dialog.set_current_folder(str(current))
        response = dialog.run()
        if response == Gtk.ResponseType.OK:
            chosen = dialog.get_filename()
            if chosen:
                self.entry_last_import_dir.set_text(chosen)
        dialog.destroy()

    def _on_save_clicked(self, _btn: Gtk.Button) -> None:
        raw_cover = self.entry_output_dir_cover.get_text().strip()
        if raw_cover:
            self.settings.output_dir_cover = Path(raw_cover).expanduser()
            self.settings.last_cover_dir = self.settings.output_dir_cover
        raw_rip = self.entry_output_dir_rip.get_text().strip()
        if raw_rip:
            self.settings.output_dir_rip = Path(raw_rip).expanduser()
            self.settings.output_dir = self.settings.output_dir_rip
        raw_tag = self.entry_output_dir_tag.get_text().strip()
        if raw_tag:
            self.settings.output_dir_tag = Path(raw_tag).expanduser()
        raw_convert = self.entry_output_dir_convert.get_text().strip()
        if raw_convert:
            self.settings.output_dir_convert = Path(raw_convert).expanduser()
        raw_repair = self.entry_output_dir_repair.get_text().strip()
        if raw_repair:
            self.settings.output_dir_repair = Path(raw_repair).expanduser()
        raw_cut = self.entry_output_dir_cut.get_text().strip()
        if raw_cut:
            self.settings.output_dir_cut = Path(raw_cut).expanduser()
        if hasattr(self, "entry_last_import_dir"):
            raw_imp_dir = self.entry_last_import_dir.get_text().strip()
            if raw_imp_dir:
                self.settings.last_import_dir = Path(raw_imp_dir).expanduser()
        self.settings.filename_template = self.entry_template.get_text().strip() or self.settings.filename_template
        self.settings.export_format = ExportFormat.FLAC if self.radio_flac.get_active() else ExportFormat.MP3
        self.settings.flac_compression_level = int(round(self.flac_scale.get_value()))
        self.settings.flac_verify = self.check_flac_verify.get_active()
        self.settings.flac_replay_gain = self.check_flac_replaygain.get_active()

        mp3_idx = max(0, self.mp3_combo.get_active())
        self.settings.mp3_quality = self._mp3_modes[mp3_idx]

        self.settings.id3v2_version = 3 if self.check_id3v2_3.get_active() else 4
        self.settings.normalize_album = self.check_normalize_album.get_active()
        self.settings.normalize_target_lufs = round(float(self.spin_target_lufs.get_value()), 1)
        self.settings.normalize_compute_album_gain = self.check_norm_album_gain.get_active()
        self.settings.normalize_use_loudest_track = self.check_norm_loudest_track.get_active()
        self.settings.normalize_true_peak = self.check_norm_true_peak.get_active()
        self.settings.normalize_write_ref_loudness_tag = self.check_norm_ref_tag.get_active()

        paranoia_idx = max(0, self.paranoia_combo.get_active())
        self.settings.paranoia_mode = self._paranoia_modes[paranoia_idx]

        self.settings.embed_cover_art = self.check_embed_cover.get_active()
        self.settings.save_folder_cover = self.check_save_folder_cover.get_active()
        self.settings.cover_filename = self.entry_cover_filename.get_text().strip() or "cover"
        if hasattr(self, "spin_cover_max_dim"):
            self.settings.cover_max_dimension = normalize_cover_max_dimension(
                self.spin_cover_max_dim.get_value()
            )
        if hasattr(self, "_cover_provider_checks"):
            self.settings.cover_providers = self._get_selected_cover_providers()
        if hasattr(self, "spin_max_threads"):
            self.settings.max_threads = normalize_max_threads(
                self.spin_max_threads.get_value()
            )
        self.settings.discogs_token = self.entry_discogs_token.get_text().strip()
        if hasattr(self, "entry_lastfm_api_key"):
            self.settings.lastfm_api_key = self.entry_lastfm_api_key.get_text().strip()
        if hasattr(self, "check_mb_use_local_mirror"):
            self.settings.mb_use_local_mirror = self.check_mb_use_local_mirror.get_active()
        if hasattr(self, "entry_mb_local_host"):
            self.settings.mb_local_host = normalize_mb_local_host(self.entry_mb_local_host.get_text())
        if hasattr(self, "spin_mb_local_port"):
            self.settings.mb_local_port = normalize_mb_local_port(self.spin_mb_local_port.get_value_as_int())
        if hasattr(self, "check_mb_fallback_official"):
            self.settings.mb_fallback_to_official = self.check_mb_fallback_official.get_active()
        self.settings.musicbrainz_server_url = build_musicbrainz_server_url(
            self.settings.mb_use_local_mirror,
            self.settings.mb_local_host,
            self.settings.mb_local_port,
        )
        reset_musicbrainz_mirror_cooldown()
        if hasattr(self, "check_mb_deep_relations"):
            self.settings.mb_load_deep_relations = self.check_mb_deep_relations.get_active()
        if hasattr(self, "check_prefer_subgenres"):
            self.settings.prefer_subgenres = self.check_prefer_subgenres.get_active()
        if hasattr(self, "check_auto_enrich_genres"):
            self.settings.auto_enrich_track_genres = self.check_auto_enrich_genres.get_active()
        self.settings.show_query_log = self.check_show_query_log.get_active()
        self.settings.convert_roman_numerals = self.check_convert_roman.get_active()
        self.settings.eject_after_rip = self.check_eject_after_rip.get_active()

        dpi_idx = max(0, self.scanner_dpi_combo.get_active())
        self.settings.scanner_dpi = self._scanner_dpi_values[dpi_idx]
        mode_idx = max(0, self.scanner_mode_combo.get_active())
        self.settings.scanner_color_mode = self._scanner_color_modes[mode_idx]
        area_idx = max(0, self.scanner_area_combo.get_active())
        self.settings.scanner_scan_area = self._scanner_areas[area_idx]
        self.settings.scanner_device = self.entry_scanner_device.get_text().strip()
        self.settings.scanner_auto_open_crop = self.check_scanner_auto_crop.get_active()

        theme_idx = max(0, self.theme_combo.get_active())
        selected_theme = self._theme_modes[theme_idx]

        shazam_idx = max(0, self.shazam_sample_combo.get_active())
        if shazam_idx < len(self._shazam_sample_values):
            self.settings.shazam_sample_size = self._shazam_sample_values[shazam_idx]
        else:
            self.settings.shazam_sample_size = DEFAULT_SHAZAM_SAMPLE_SIZE
        self.settings.visible_left_tag_fields = self._get_selected_left_tag_fields()

        save_settings(self.settings, theme_mode=selected_theme)
        self._on_apply(self.settings, selected_theme)
        if self._on_cancel is not None:
            self._on_cancel()


class SettingsWindow(Gtk.Window):
    """Eigenes GTK3-Fenster (klassische Titelleiste) als Wrapper um SettingsPanel."""

    def __init__(
        self,
        parent: Gtk.Window,
        settings: ExportSettings,
        theme_mode: str,
        on_apply: Callable[[ExportSettings, str], None],
    ) -> None:
        super().__init__(
            title="Einstellungen — MintRip Studio",
            transient_for=parent,
            modal=True,
        )
        self.set_default_size(820, 580)
        self.set_position(Gtk.WindowPosition.CENTER_ON_PARENT)
        self.set_icon_name(resolve_program_icon_name())
        panel = SettingsPanel(
            parent_window=self,
            settings=settings,
            theme_mode=theme_mode,
            on_apply=on_apply,
            on_cancel=self.destroy,
        )
        self.add(panel)
        self.show_all()
        panel._update_format_visibility()
