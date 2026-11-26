"""GTK3-Hauptfenster für MintRip Studio unter Linux Mint (klassisches Cinnamon-Layout & Systemicons)."""

from __future__ import annotations

from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import math
import mimetypes
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Optional
import uuid

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
gi.require_version("Pango", "1.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk, Pango

from .batch_queue import BatchQueueManager
from .cd_reader import (
    CD_PCM_BYTES_PER_SEC,
    BufferedCdPlaybackSession,
    build_album_from_directory,
    build_album_from_local_files,
    detect_optical_drives,
    get_cd_tray_state,
    read_audio_cd_toc,
    set_cd_read_speed,
    synthesize_toc_from_tracks,
    toggle_cd_tray,
)
from .converter import (
    CONVERTER_TARGET_FORMATS,
    ConverterJob,
    ConverterManager,
    ConverterOptions,
)
from .drag_drop import (
    attach_audio_file_drop_target,
    attach_cover_image_drop_target,
    attach_track_reorder_dnd,
)
from .encoder import (
    build_cover_target_path,
    detect_image_format,
    ensure_jpeg_cover,
    inspect_cover_image,
)
from .filename_tagger import FilenameToTagsDialog, apply_filename_mask_to_album
from .icons import make_system_icon, resolve_program_icon_name, resolve_system_icon_name
from .metadata_service import (
    analyze_single_track_musicbrainz,
    download_amazon_cover,
    download_cover_art,
    download_image_url,
    enrich_album_track_genres,
    fetch_candidate_tracklist_preview,
    fetch_musicbrainz_release_details,
    fetch_preview_cover_thumbnail,
    load_selected_candidate_metadata,
    lookup_album_by_barcode_or_qr,
    lookup_album_metadata_ordered,
    lookup_discogs_by_album,
    matches_source_track_count_rule,
    resolve_cd_metadata,
    search_all_cover_candidates,
    search_all_databases_candidates,
    search_musicbrainz_releases,
    verify_and_internationalize_artists,
)
from .models import (
    COVER_PROVIDER_OPTIONS,
    DEFAULT_COVER_MAX_DIMENSION,
    DEFAULT_COVER_PROVIDERS,
    DEFAULT_MAX_THREADS,
    DEFAULT_OUTPUT_DIR_CONVERT,
    DEFAULT_OUTPUT_DIR_COVER,
    DEFAULT_OUTPUT_DIR_CUT,
    DEFAULT_OUTPUT_DIR_REPAIR,
    DEFAULT_OUTPUT_DIR_RIP,
    DEFAULT_OUTPUT_DIR_TAG,
    DEFAULT_SHAZAM_SAMPLE_SIZE,
    DEFAULT_VISIBLE_LEFT_TAG_FIELDS,
    MUSICBRAINZ_LEFT_TAG_FIELDS,
    AlbumMetadata,
    BatchJob,
    BatchStage,
    ExportFormat,
    ExportSettings,
    TrackMetadata,
    convert_roman_numerals_in_title,
    format_index_number,
    normalize_cover_max_dimension,
    normalize_cover_providers,
    normalize_max_threads,
    normalize_multi_artist,
    normalize_shazam_sample_size,
    normalize_visible_left_tag_fields,
    run_artist_splitter_on_album,
)
from .repairer import (
    RepairJob,
    RepairManager,
    RepairOptions,
    analyze_audio_file_for_repair,
)
from .settings_dialog import (
    SettingsPanel,
    SettingsWindow,
    load_saved_settings,
    load_saved_theme_mode,
    save_settings,
)
from .shazam_recognizer import recognize_track_with_shazam
from .theme import SystemThemeWatcher


class MintRipWindow(Gtk.ApplicationWindow):
    """Hauptfenster mit klassischer Titelleiste, Metadaten-Sidebar, Track-Editor & Batch-Queue."""

    def __init__(self, app: Gtk.Application) -> None:
        super().__init__(application=app, title="MintRip Studio — CD-Ripper & Audio-Konverter")
        self.set_default_size(1240, 820)
        self.set_icon_name(resolve_program_icon_name())

        self.theme_watcher = SystemThemeWatcher()
        self.theme_watcher.set_mode(load_saved_theme_mode())

        self.album = AlbumMetadata()
        self.settings = load_saved_settings()
        eff_max_threads = normalize_max_threads(
            getattr(self.settings, "max_threads", DEFAULT_MAX_THREADS)
        )
        self.batch_manager = BatchQueueManager(
            on_job_update=self._on_batch_job_updated,
            max_workers=eff_max_threads,
        )
        self._job_iters: dict[str, Gtk.TreeIter] = {}
        self._job_last_stage: dict[str, str] = {}
        self._track_checkbuttons: list[Gtk.CheckButton] = []
        self._track_num_labels: list[tuple[TrackMetadata, Gtk.Label]] = []
        self._single_disc_buttons: dict[int, Gtk.Button] = {}
        self._updating_single_disc_combo = False
        self._candidate_hits: list[dict] = []
        self._updating_select_all = False
        self._updating_drives = False
        self._updating_log_toggle = False
        self._updating_disc_ui = False
        self._disc_conflict = False
        self._awaiting_album_selection = False
        self._album_loaded_in_tracks = bool(self.album.tracks)
        self._active_display: str | None = "tracks"
        self._batch_running = False
        self._batch_paused = False
        self._verify_cancel_event: threading.Event | None = None
        self._shazam_cancel_event: threading.Event | None = None
        self._mb_tracks_cancel_event: threading.Event | None = None
        self._cover_search_cancel_event: threading.Event | None = None
        self._scanner_cancel_event: threading.Event | None = None
        self._scanner_proc: subprocess.Popen | None = None
        self._spinner_angle: float = 0.0
        self._spinner_timer_id: int | None = None
        self._track_preview_buttons: dict[int, Gtk.Button] = {}
        self._playing_track_idx: int | None = None
        self._preview_procs: list[subprocess.Popen] = []
        self._preview_session: Optional[BufferedCdPlaybackSession] = None
        self._preview_token: int = 0
        self._cd_tray_open: bool = False
        self._tray_poll_timer_id: int = 0
        self._tray_toggle_in_progress: bool = False
        self._hits_search_active: bool = False
        self._batch_group_iters: dict[str, Gtk.TreeIter] = {}
        self._batch_group_jobs: dict[str, list[BatchJob]] = {}
        self._batch_group_was_completed: dict[str, bool] = {}
        self._active_module: str = "home"
        self._detached_log_window: Optional[Gtk.Window] = None
        self.converter_manager = ConverterManager(max_workers=eff_max_threads)
        self.converter_manager.on_job_updated = self._on_conv_job_updated_threadsafe
        self.converter_manager.on_all_finished = self._on_conv_all_finished_threadsafe
        self.converter_manager.on_log = self._append_query_log_threadsafe
        self._conv_iters: dict[str, Gtk.TreeIter] = {}
        self._conv_running = False
        self.repair_manager = RepairManager(max_workers=eff_max_threads)
        self.repair_manager.cover_max_dimension = normalize_cover_max_dimension(
            getattr(self.settings, "cover_max_dimension", DEFAULT_COVER_MAX_DIMENSION)
        )
        self.repair_manager.on_job_updated = self._on_repair_job_updated_threadsafe
        self.repair_manager.on_all_finished = self._on_repair_all_finished_threadsafe
        self.repair_manager.on_log = self._append_query_log_threadsafe
        self._repair_jobs_by_id: dict[str, RepairJob] = {}
        self._repair_folder_job_ids: dict[str, list[str]] = {}
        self._repair_folder_labels: dict[str, str] = {}
        self._rep_vrows: list[dict] = []
        self._rep_vrow_offsets: list[int] = []
        self._rep_total_height: int = 0
        self._rep_visible_job_ids: list[str] = []
        self._rep_visible_pos_by_id: dict[str, int] = {}
        self._rep_vrow_idx_by_job_id: dict[str, int] = {}
        self._rep_all_slots: list[dict] = []
        self._rep_active_slots: dict[int, dict] = {}
        self._rep_free_slots: list[dict] = []
        self._rep_visible_file_slots: dict[str, dict] = {}
        self._rep_visible_folder_slots: dict[str, dict] = {}
        self._rep_highlighted_ids: set[str] = set()
        self._rep_anchor_id: Optional[str] = None
        self._rep_updating_scroll: bool = False
        self._rep_spacer_h: int = 14
        self._rep_folder_h: int = 42
        self._rep_file_h: int = 34
        self._rep_content_w: int = 720
        self._last_rep_alloc_w: int = 0
        self._last_rep_alloc_h: int = 0
        self._rep_row_heights_measured: bool = False
        self._playing_repair_job_id: Optional[str] = None
        self._last_playing_repair_job_id: Optional[str] = None
        self._current_inspected_repair_id: Optional[str] = None
        self._repair_busy = False
        self._repair_loading = False
        self._repair_loading_count = 0
        self._repair_loading_source = ""
        self._repair_load_cancel: Optional[threading.Event] = None
        self._rep_summary_dirty = False
        self._rep_summary_timer_id = 0
        self._rep_pending_lock = threading.Lock()
        self._rep_pending_jobs: dict[str, RepairJob] = {}
        self._rep_flush_timer_id: int = 0
        self._query_log_lock = threading.Lock()
        self._pending_log_lines: list[str] = []
        self._query_log_timer_id: int = 0
        self._repair_filter = "all"
        self._updating_rep_select_all = False
        self._track_health_widgets: dict[str, tuple[Gtk.EventBox, Gtk.DrawingArea, list]] = {}
        self._tag_health_scan_gen: int = 0
        self._preview_left_loading: bool = False
        self._preview_right_loading: bool = False
        self._left_tag_field_rows: dict[str, list[Gtk.Widget]] = {}
        self._classical_field_rows: dict[str, list[Gtk.Widget]] = {}
        self._left_field_transfer_buttons: list[Gtk.Button] = []
        self._dynamic_left_entries: dict[str, Gtk.Entry] = {}
        self._left_panel_collapsed: bool = False
        self._left_panel_width: int = 400
        self._updating_left_paned_pos: bool = False
        self._left_paned_sync_idle_id: int = 0
        self._left_panel_applied_state: Optional[tuple[bool, bool]] = None
        self._track_panel_collapsed: bool = False
        self._track_panel_width: int = 400
        self._right_paned_initialized: bool = False
        self._updating_right_paned_pos: bool = False
        self._right_paned_sync_idle_id: int = 0
        self._track_panel_applied_collapsed: Optional[bool] = None
        self._conv_setup_display_open: bool = False
        self._rep_setup_display_open: bool = False
        self._rep_player_duration_sec: float = 0.0
        self._rep_player_offset_sec: float = 0.0
        self._rep_player_started_monotonic: float = 0.0
        self._rep_player_seeking: bool = False
        self._rep_player_updating_scale: bool = False
        self._rep_player_timer_id: int = 0
        self._rep_player_seek_timer_id: int = 0
        self._active_track_idx: int = 0
        self._syncing_track_inspector: bool = False
        self._track_row_widgets: list[Gtk.Widget] = []
        self._has_populated_track_tags: bool = False
        self._has_track_id_tags: bool = False
        self._has_track_rg_tags: bool = False
        self._track_ids_display_open: bool = False
        self._track_rg_display_open: bool = False
        self._preview_request_gen: int = 0
        self._last_preview_key: str = ""
        self._db_progress_tasks: dict[str, dict] = {}
        self._db_progress_seq: int = 0
        self._db_progress_pulse_id: int = 0
        self._db_progress_hide_id: int = 0
        self._db_progress_notice: Optional[tuple[str, bool]] = None
        self.connect("destroy", self._on_main_window_destroy)

        self._build_layout()
        self._refresh_drives()
        self._update_multi_disc_indicator()
        self._sync_select_all_state()
        self.show_all()
        self._update_classical_visibility()
        self._apply_left_tag_field_visibility()
        self._update_query_log_visibility()
        self._update_workspace_visibility_and_locks()
        self._switch_to_module("home", log=False, reset_cache=False)
        self._append_query_log_ui(
            f"[Start] MintRip Studio bereit (Startseite · 6 Module) · Laufwerk: {self._get_selected_drive()} · "
            f"Format: {self.settings.export_format.value.upper()} · Zielordner: {self.settings.output_dir}"
        )

    def _build_toolbar(self) -> Gtk.Box:
        toolbar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        toolbar.set_border_width(0)
        toolbar.set_margin_top(0)
        toolbar.set_margin_start(0)
        toolbar.set_margin_end(0)
        toolbar.set_margin_bottom(0)
        toolbar.get_style_context().add_class("toolbar")
        toolbar.get_style_context().add_class("primary-toolbar")

        # Ganz links: Button "Startseite" zur Rückkehr aus jedem Modul
        self.home_toolbar_btn = Gtk.Button()
        home_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        home_box.pack_start(make_system_icon("home_start"), False, False, 0)
        home_box.pack_start(Gtk.Label(label="Startseite"), False, False, 0)
        self.home_toolbar_btn.add(home_box)
        self.home_toolbar_btn.set_tooltip_text("Zurück zur Modul-Startseite wechseln")
        self.home_toolbar_btn.connect("clicked", lambda _b: self._switch_to_module("home"))
        toolbar.pack_start(self.home_toolbar_btn, False, False, 0)

        # Rechts neben "Startseite": Dropdown-Menü mit Sprungmarken zu den anderen Modulen + Einstellungen (außer auf Startseite)
        self.module_jump_btn = Gtk.MenuButton()
        jump_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        jump_box.pack_start(
            Gtk.Image.new_from_icon_name("view-grid-symbolic", Gtk.IconSize.BUTTON),
            False,
            False,
            0,
        )
        jump_box.pack_start(Gtk.Label(label="Module"), False, False, 0)
        jump_box.pack_start(Gtk.Label(label="▾"), False, False, 0)
        jump_box.show_all()
        self.module_jump_btn.add(jump_box)
        self.module_jump_btn.set_tooltip_text(
            "Direkt zu einem anderen Modul oder den Einstellungen wechseln"
        )
        self.module_jump_btn.show_all()
        self.module_jump_btn.set_no_show_all(True)
        self.module_jump_btn.set_visible(False)
        toolbar.pack_start(self.module_jump_btn, False, False, 0)

        # Modulspezifische Werkzeuge für Modul 4 direkt neben "Startseite" / Modul-Dropdown
        self.conv_toolbar_sep = Gtk.Separator(orientation=Gtk.Orientation.VERTICAL)
        toolbar.pack_start(self.conv_toolbar_sep, False, False, 2)

        self.conv_import_btn = Gtk.MenuButton()
        self.conv_import_btn.get_style_context().add_class("suggested-action")
        conv_imp_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        conv_imp_box.pack_start(make_system_icon("music_folder"), False, False, 0)
        conv_imp_box.pack_start(Gtk.Label(label="Dateien / Ordner importieren"), False, False, 0)
        conv_imp_box.pack_start(Gtk.Label(label="▾"), False, False, 0)
        conv_imp_box.show_all()
        self.conv_import_btn.add(conv_imp_box)
        self.conv_import_btn.set_tooltip_text(
            "Einzelne Audiodateien oder ganze Ordner rekursiv zur Konvertierung importieren"
        )

        conv_imp_menu = Gtk.Menu()
        mi_conv_files = Gtk.MenuItem(label="Einzelne Dateien auswählen…")
        mi_conv_files.connect("activate", self._on_conv_add_files_clicked)
        conv_imp_menu.append(mi_conv_files)
        mi_conv_folder = Gtk.MenuItem(label="Ordner rekursiv importieren (inkl. Unterordner)…")
        mi_conv_folder.connect("activate", self._on_conv_add_folder_clicked)
        conv_imp_menu.append(mi_conv_folder)
        conv_imp_menu.show_all()
        self.conv_import_btn.set_popup(conv_imp_menu)
        toolbar.pack_start(self.conv_import_btn, False, False, 0)

        self._converter_toolbar_widgets: list[Gtk.Widget] = [
            self.conv_toolbar_sep,
            self.conv_import_btn,
        ]
        for cw in self._converter_toolbar_widgets:
            cw.show_all()
            cw.set_no_show_all(True)
            cw.set_visible(False)

        # Modulspezifische Werkzeuge für Modul 5 direkt neben "Startseite" / Modul-Dropdown
        self.rep_toolbar_sep = Gtk.Separator(orientation=Gtk.Orientation.VERTICAL)
        toolbar.pack_start(self.rep_toolbar_sep, False, False, 2)

        self.rep_import_btn = Gtk.MenuButton()
        self.rep_import_btn.get_style_context().add_class("suggested-action")
        rep_imp_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        rep_imp_box.pack_start(make_system_icon("music_folder"), False, False, 0)
        rep_imp_box.pack_start(Gtk.Label(label="Dateien oder Ordner importieren"), False, False, 0)
        rep_imp_box.pack_start(Gtk.Label(label="▾"), False, False, 0)
        rep_imp_box.show_all()
        self.rep_import_btn.add(rep_imp_box)
        self.rep_import_btn.set_tooltip_text(
            "Einzelne Audiodateien oder ganze Ordner rekursiv zur Diagnose & Reparatur importieren"
        )

        rep_imp_menu = Gtk.Menu()
        mi_rep_files = Gtk.MenuItem(label="Einzelne Dateien auswählen…")
        mi_rep_files.connect("activate", self._on_rep_add_files_clicked)
        rep_imp_menu.append(mi_rep_files)
        mi_rep_folder = Gtk.MenuItem(label="Ordner rekursiv scannen (inkl. Unterordner)…")
        mi_rep_folder.connect("activate", self._on_rep_add_folder_clicked)
        rep_imp_menu.append(mi_rep_folder)
        rep_imp_menu.show_all()
        self.rep_import_btn.set_popup(rep_imp_menu)
        toolbar.pack_start(self.rep_import_btn, False, False, 0)

        self.rep_rescan_btn = Gtk.Button()
        rep_rescan_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        rep_rescan_box.pack_start(make_system_icon("refresh_disc"), False, False, 0)
        rep_rescan_box.pack_start(Gtk.Label(label="Neu analysieren"), False, False, 0)
        rep_rescan_box.show_all()
        self.rep_rescan_btn.add(rep_rescan_box)
        self.rep_rescan_btn.set_tooltip_text("Alle geladenen Audiodateien erneut analysieren")
        self.rep_rescan_btn.connect("clicked", self._on_rep_rescan_clicked)
        toolbar.pack_start(self.rep_rescan_btn, False, False, 0)

        self._repair_toolbar_widgets: list[Gtk.Widget] = [
            self.rep_toolbar_sep,
            self.rep_import_btn,
            self.rep_rescan_btn,
        ]
        for rw in self._repair_toolbar_widgets:
            rw.show_all()
            rw.set_no_show_all(True)
            rw.set_visible(False)

        toolbar_sep = Gtk.Separator(orientation=Gtk.Orientation.VERTICAL)
        toolbar.pack_start(toolbar_sep, False, False, 2)

        # Linke Seite: Laufwerksauswahl & CD-Scan (nur in Modul 2 sichtbar; Modul 3 ohne CD-Laufwerk)
        self.drive_icon = make_system_icon("optical_drive")
        toolbar.pack_start(self.drive_icon, False, False, 0)
        self.drive_combo = Gtk.ComboBoxText()
        self.drive_combo.append_text("/dev/cdrom")
        self.drive_combo.set_active(0)
        self.drive_combo.connect("changed", self._on_drive_combo_changed)
        toolbar.pack_start(self.drive_combo, False, False, 0)

        self.tray_toggle_btn = Gtk.Button()
        self.tray_btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=5)
        self.tray_btn_icon = make_system_icon("eject_disc")
        self.tray_btn_label = Gtk.Label(label="Auswerfen")
        self.tray_btn_box.pack_start(self.tray_btn_icon, False, False, 0)
        self.tray_btn_box.pack_start(self.tray_btn_label, False, False, 0)
        self.tray_toggle_btn.add(self.tray_btn_box)
        self.tray_toggle_btn.set_tooltip_text("CD-Schlitten auswerfen (Eject)")
        self.tray_toggle_btn.connect("clicked", self._on_tray_toggle_clicked)
        toolbar.pack_start(self.tray_toggle_btn, False, False, 0)

        self.scan_cd_btn = Gtk.Button()
        scan_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        scan_box.pack_start(make_system_icon("refresh_disc"), False, False, 0)
        scan_box.pack_start(Gtk.Label(label="CD einlesen und Abfragen"), False, False, 0)
        self.scan_cd_btn.add(scan_box)
        self.scan_cd_btn.set_tooltip_text(
            "Audio-CD einlesen (oder Datei-TOC nutzen) und Metadaten & Cover online abfragen (MusicBrainz → Discogs → CDDB)"
        )
        self.scan_cd_btn.connect("clicked", self._on_read_cd_clicked)
        toolbar.pack_start(self.scan_cd_btn, False, False, 0)

        self.import_folder_btn = Gtk.Button()
        self.import_folder_btn.get_style_context().add_class("suggested-action")
        import_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        import_box.pack_start(make_system_icon("music_folder"), False, False, 0)
        import_box.pack_start(Gtk.Label(label="Album-Ordner importieren"), False, False, 0)
        self.import_folder_btn.add(import_box)
        self.import_folder_btn.set_tooltip_text(
            "Ein Verzeichnis mit einem Album auswählen (inkl. automatischer Cover-Erkennung im Ordner, CUE-Sheet & virtueller CD-TOC)"
        )
        self.import_folder_btn.connect("clicked", self._on_import_folder_clicked)
        toolbar.pack_start(self.import_folder_btn, False, False, 0)

        self.filename_to_tags_btn = Gtk.Button()
        f2t_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        f2t_box.pack_start(make_system_icon("module_tag"), False, False, 0)
        f2t_box.pack_start(Gtk.Label(label="Dateiname zu Tags"), False, False, 0)
        self.filename_to_tags_btn.add(f2t_box)
        self.filename_to_tags_btn.set_tooltip_text(
            "Tags anhand einer EasyTAG-Maske aus Dateinamen & Ordnernamen extrahieren (Maskeneditor öffnen)"
        )
        self.filename_to_tags_btn.connect("clicked", self._on_open_filename_to_tags_clicked)
        toolbar.pack_start(self.filename_to_tags_btn, False, False, 0)

        self.retry_query_btn = Gtk.Button()
        retry_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        retry_box.pack_start(make_system_icon("search_online"), False, False, 0)
        self.retry_query_label = Gtk.Label(label="Erneut versuchen")
        retry_box.pack_start(self.retry_query_label, False, False, 0)
        self.retry_query_btn.add(retry_box)
        self.retry_query_btn.set_tooltip_text(
            "Metadaten-Abfrage für das geladene Album mit exponentiellem Backoff neu initialisieren (z. B. nach HTTP 503 Fehler, ohne das Album neu zu laden)"
        )
        self.retry_query_btn.connect("clicked", self._on_retry_metadata_query_clicked)
        toolbar.pack_start(self.retry_query_btn, False, False, 0)

        self.barcode_toolbar_btn = Gtk.Button()
        barcode_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        barcode_box.pack_start(make_system_icon("barcode_qr"), False, False, 0)
        barcode_box.pack_start(Gtk.Label(label="Barcode / QR scannen"), False, False, 0)
        self.barcode_toolbar_btn.add(barcode_box)
        self.barcode_toolbar_btn.set_tooltip_text(
            "Albuminformationen per Webcam über einen Barcode (EAN/UPC) oder QR-Code einlesen und suchen"
        )
        self.barcode_toolbar_btn.connect("clicked", self._on_scan_barcode_clicked)
        toolbar.pack_start(self.barcode_toolbar_btn, False, False, 0)

        self.classical_toggle_btn = Gtk.ToggleButton()
        classical_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        classical_box.pack_start(make_system_icon("classical_album"), False, False, 0)
        classical_box.pack_start(Gtk.Label(label="Klassikalbum"), False, False, 0)
        self.classical_toggle_btn.add(classical_box)
        self.classical_toggle_btn.set_tooltip_text(
            "Klassikalbum-Modus umschalten: Zeigt Komponist, Orchester und Dirigent in der rechten Track-Spalte sowie links mit Zuordnungs-Pfeilen an"
        )
        self.classical_toggle_btn.connect("toggled", self._on_classical_album_toggled)
        toolbar.pack_start(self.classical_toggle_btn, False, False, 0)

        reset_all_btn = Gtk.Button()
        reset_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        reset_box.pack_start(make_system_icon("clear_list"), False, False, 0)
        reset_box.pack_start(Gtk.Label(label="Felder zurücksetzen"), False, False, 0)
        reset_all_btn.add(reset_box)
        reset_all_btn.set_tooltip_text(
            "Alle Metadaten-Felder, Cover-Vorschau und Trackliste vollständig zurücksetzen"
        )
        reset_all_btn.connect("clicked", self._on_reset_all_fields_clicked)
        toolbar.pack_start(reset_all_btn, False, False, 0)

        self._workbench_toolbar_widgets: list[Gtk.Widget] = [
            toolbar_sep,
            self.drive_icon,
            self.drive_combo,
            self.tray_toggle_btn,
            self.scan_cd_btn,
            self.import_folder_btn,
            self.filename_to_tags_btn,
            self.retry_query_btn,
            self.barcode_toolbar_btn,
            self.classical_toggle_btn,
            reset_all_btn,
        ]

        # Rechte Seite: Protokoll anzeigen (ohne Einstellungen-Button – Zugriff über Kachel auf Startseite)
        self.toggle_log_btn = Gtk.ToggleButton()
        log_btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        log_btn_box.pack_start(make_system_icon("batch_queue"), False, False, 0)
        log_btn_box.pack_start(Gtk.Label(label="Protokoll anzeigen"), False, False, 0)
        self.toggle_log_btn.add(log_btn_box)
        self.toggle_log_btn.set_tooltip_text(
            "Schaltet das Aktions- & Abfrage-Protokoll am unteren Fensterrand ein oder aus"
        )
        self.toggle_log_btn.set_active(self.settings.show_query_log)
        self.toggle_log_btn.connect("toggled", self._on_toggle_log_btn_toggled)
        toolbar.pack_end(self.toggle_log_btn, False, False, 0)

        return toolbar

    def _build_home_launcher_page(self) -> Gtk.Widget:
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_overlay_scrolling(False)

        # Vertikal & horizontal mittig platzierter Container (Kacheln um 30% kleiner)
        center_align_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        center_align_box.set_valign(Gtk.Align.CENTER)
        center_align_box.set_halign(Gtk.Align.CENTER)
        center_align_box.set_hexpand(True)
        center_align_box.set_vexpand(True)

        outer_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        outer_vbox.set_border_width(16)
        outer_vbox.set_halign(Gtk.Align.CENTER)
        outer_vbox.set_hexpand(False)
        outer_vbox.set_size_request(820, -1)

        header_frame = Gtk.Frame()
        header_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        header_box.set_border_width(10)
        header_icon_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        header_icon_box.set_valign(Gtk.Align.CENTER)
        header_icon_box.pack_start(make_system_icon("optical_drive", pixel_size=34), False, False, 0)
        header_box.pack_start(header_icon_box, False, False, 0)

        header_text_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        kicker_lbl = Gtk.Label()
        kicker_lbl.set_markup("<span size='small'>MintRip Studio · Modulare Audio-Arbeitsumgebung</span>")
        kicker_lbl.set_xalign(0)
        kicker_lbl.get_style_context().add_class("dim-label")
        header_text_box.pack_start(kicker_lbl, False, False, 0)

        title_lbl = Gtk.Label()
        title_lbl.set_markup("<span size='large' weight='bold'>Startseite — Modul auswählen</span>")
        title_lbl.set_xalign(0)
        header_text_box.pack_start(title_lbl, False, False, 0)
        header_box.pack_start(header_text_box, True, True, 0)
        header_frame.add(header_box)
        outer_vbox.pack_start(header_frame, False, False, 0)

        grid = Gtk.Grid()
        grid.set_row_spacing(11)
        grid.set_column_spacing(11)
        grid.set_row_homogeneous(True)
        grid.set_column_homogeneous(True)
        grid.set_halign(Gtk.Align.CENTER)
        grid.set_hexpand(False)

        module_defs = [
            (
                "module_cover",
                "01. Modul · Aktiv",
                "Coverbild beziehen",
                "Multi-Provider-Coversuche, SANE-Scanner, Zuschnitt & Speichern",
                "Cover über alle aktivierten Bilddatenbanken (MusicBrainz, Deezer, TheAudioDB, Bandcamp, iTunes, Discogs, Amazon) suchen, beschneiden und speichern.",
                "cover_image",
                True,
            ),
            (
                "module_rip",
                "02. Modul · Aktiv",
                "CD-Rippen",
                "Bitgenaues Audio-CD-Auslesen, Online-Metadaten & FLAC/MP3-Export",
                "Physische Audio-CDs mit cdparanoia auslesen, Metadaten abrufen und nach FLAC/MP3 exportieren.",
                "optical_drive",
                True,
            ),
            (
                "module_tag",
                "03. Modul · Aktiv",
                "Album Taggen",
                "Offizielle MusicBrainz-Picard-Tags & direktes Schreiben in Dateien",
                "Album-Ordner importieren und offizielle Multi-Value-Picard-Tags direkt in die Dateien schreiben.",
                "module_tag",
                True,
            ),
            (
                "module_convert",
                "04. Modul · Aktiv",
                "Musik konvertieren",
                "Einzeldateien & rekursive Ordner in FLAC, MP3, WAV, Opus, Ogg, M4A & AIFF",
                "Einzelne Audiodateien oder ganze Ordner rekursiv importieren und mit Tags umwandeln.",
                "module_convert",
                True,
            ),
            (
                "module_repair",
                "05. Modul · Aktiv",
                "Musik reparieren",
                "MP3-Xing/Frame-Diagnose, ID3-Bereinigung, FLAC-MD5 & Header-Reparatur",
                "Audiodateien auf defekte Frames prüfen, MP3-Xing-Header korrigieren und FLAC-MD5 neu aufbauen.",
                "module_repair",
                True,
            ),
            (
                "module_cut",
                "06. Modul · Spätere Erweiterung",
                "Musik Schneiden",
                "Präziser Audio-Zuschnitt, CUE-Splitter & Stille-Erkennung",
                "Gesamtaufnahmen anhand von CUE-Sheets oder Pausen-Erkennung verlustfrei in Einzeltitel teilen.",
                "module_cut",
                False,
            ),
        ]

        for idx, (mod_id, num_lbl, mod_title, mod_sub, mod_desc, icon_key, is_active) in enumerate(module_defs):
            tile_btn = Gtk.Button()
            tile_btn.set_size_request(260, 144)
            tile_btn.set_hexpand(False)
            tile_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
            tile_vbox.set_border_width(8)

            top_hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            top_hbox.pack_start(make_system_icon(icon_key, pixel_size=32), False, False, 0)
            title_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
            num_widget = Gtk.Label()
            num_widget.set_markup(f"<span size='small'>{GLib.markup_escape_text(num_lbl)}</span>")
            num_widget.set_xalign(0)
            num_widget.set_max_width_chars(24)
            num_widget.set_ellipsize(Pango.EllipsizeMode.END)
            num_widget.get_style_context().add_class("dim-label")
            title_widget = Gtk.Label()
            title_widget.set_markup(
                f"<span size='large' weight='bold'>{GLib.markup_escape_text(mod_title)}</span>"
            )
            title_widget.set_xalign(0)
            title_widget.set_max_width_chars(20)
            title_widget.set_ellipsize(Pango.EllipsizeMode.END)
            title_box.pack_start(num_widget, False, False, 0)
            title_box.pack_start(title_widget, False, False, 0)
            top_hbox.pack_start(title_box, True, True, 0)
            tile_vbox.pack_start(top_hbox, False, False, 0)

            sub_widget = Gtk.Label()
            sub_widget.set_markup(f"<span size='small'><b>{GLib.markup_escape_text(mod_sub)}</b></span>")
            sub_widget.set_xalign(0)
            sub_widget.set_line_wrap(True)
            sub_widget.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
            sub_widget.set_width_chars(24)
            sub_widget.set_max_width_chars(32)
            tile_vbox.pack_start(sub_widget, False, False, 0)

            desc_widget = Gtk.Label()
            desc_widget.set_markup(f"<span size='small'>{GLib.markup_escape_text(mod_desc)}</span>")
            desc_widget.set_xalign(0)
            desc_widget.set_line_wrap(True)
            desc_widget.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
            desc_widget.set_width_chars(24)
            desc_widget.set_max_width_chars(34)
            desc_widget.get_style_context().add_class("dim-label")
            tile_vbox.pack_start(desc_widget, True, True, 0)

            action_lbl = Gtk.Label()
            action_lbl.set_markup(
                f"<span size='small'><b>{GLib.markup_escape_text(mod_title + ' öffnen →' if is_active else 'Modul-Seite öffnen →')}</b></span>"
            )
            action_lbl.set_xalign(0)
            action_lbl.set_max_width_chars(32)
            action_lbl.set_ellipsize(Pango.EllipsizeMode.END)
            tile_vbox.pack_start(action_lbl, False, False, 0)

            tile_btn.add(tile_vbox)
            tile_btn.connect("clicked", lambda _b, m=mod_id: self._switch_to_module(m))
            grid.attach(tile_btn, idx % 3, idx // 3, 1, 1)

        # Eigene Kachel für die Einstellungen auf der Startseite (exakt gleiche Größe wie Modulkacheln)
        settings_tile_btn = Gtk.Button()
        settings_tile_btn.set_size_request(260, 144)
        settings_tile_btn.set_hexpand(False)
        settings_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        settings_vbox.set_border_width(8)

        settings_top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        settings_top.pack_start(make_system_icon("settings", pixel_size=32), False, False, 0)
        settings_title_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
        settings_kicker = Gtk.Label()
        settings_kicker.set_markup("<span size='small'>System · Eigene Seite</span>")
        settings_kicker.set_xalign(0)
        settings_kicker.set_max_width_chars(24)
        settings_kicker.set_ellipsize(Pango.EllipsizeMode.END)
        settings_kicker.get_style_context().add_class("dim-label")
        settings_title_lbl = Gtk.Label()
        settings_title_lbl.set_markup("<span size='large' weight='bold'>Einstellungen</span>")
        settings_title_lbl.set_xalign(0)
        settings_title_lbl.set_max_width_chars(20)
        settings_title_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        settings_title_box.pack_start(settings_kicker, False, False, 0)
        settings_title_box.pack_start(settings_title_lbl, False, False, 0)
        settings_top.pack_start(settings_title_box, True, True, 0)
        settings_vbox.pack_start(settings_top, False, False, 0)

        settings_sub_lbl = Gtk.Label()
        settings_sub_lbl.set_markup(
            "<span size='small'><b>Speicherort, FLAC/MP3, EBU-R128, Scanner &amp; Protokoll</b></span>"
        )
        settings_sub_lbl.set_xalign(0)
        settings_sub_lbl.set_line_wrap(True)
        settings_sub_lbl.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        settings_sub_lbl.set_width_chars(24)
        settings_sub_lbl.set_max_width_chars(32)
        settings_vbox.pack_start(settings_sub_lbl, False, False, 0)

        settings_desc_lbl = Gtk.Label()
        settings_desc_lbl.set_markup(
            "<span size='small'>Ausgabeformat, Pfad-Vorlagen, SANE-Scanner, Discogs-Token &amp; Protokoll konfigurieren.</span>"
        )
        settings_desc_lbl.set_xalign(0)
        settings_desc_lbl.set_line_wrap(True)
        settings_desc_lbl.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        settings_desc_lbl.set_width_chars(24)
        settings_desc_lbl.set_max_width_chars(34)
        settings_desc_lbl.get_style_context().add_class("dim-label")
        settings_vbox.pack_start(settings_desc_lbl, True, True, 0)

        settings_action_lbl = Gtk.Label()
        settings_action_lbl.set_markup("<span size='small'><b>Einstellungen öffnen →</b></span>")
        settings_action_lbl.set_xalign(0)
        settings_action_lbl.set_max_width_chars(32)
        settings_action_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        settings_vbox.pack_start(settings_action_lbl, False, False, 0)

        settings_tile_btn.add(settings_vbox)
        settings_tile_btn.connect("clicked", lambda _b: self._switch_to_module("settings"))
        grid.attach(settings_tile_btn, 0, 2, 1, 1)

        outer_vbox.pack_start(grid, False, False, 0)
        center_align_box.pack_start(outer_vbox, False, False, 0)
        scroll.add(center_align_box)
        return scroll

    def _build_module_header_bar(
        self,
        mod_num: str,
        mod_title: str,
        mod_sub: str,
        icon_key: str,
    ) -> Gtk.Box:
        hdr_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        hdr_bar.set_border_width(8)
        icon_widget = make_system_icon(icon_key, pixel_size=34)
        hdr_bar.pack_start(icon_widget, False, False, 0)

        txt_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        txt_vbox.set_valign(Gtk.Align.CENTER)
        h2_lbl = Gtk.Label()
        head_txt = f"{mod_num} · {mod_title}" if mod_num else mod_title
        h2_lbl.set_markup(
            f"<span size='x-large' weight='bold'>{GLib.markup_escape_text(head_txt)}</span>"
        )
        h2_lbl.set_xalign(0)
        h2_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        txt_vbox.pack_start(h2_lbl, False, False, 0)

        sub_lbl = Gtk.Label()
        sub_lbl.set_markup(f"<span size='small'>{GLib.markup_escape_text(mod_sub)}</span>")
        sub_lbl.set_xalign(0)
        sub_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        sub_lbl.get_style_context().add_class("dim-label")
        txt_vbox.pack_start(sub_lbl, False, False, 0)

        hdr_bar.pack_start(txt_vbox, True, True, 0)
        return hdr_bar

    def _build_reserved_module_page(
        self,
        mod_num: str,
        mod_title: str,
        mod_sub: str,
        mod_desc: str,
        icon_key: str,
        highlights: list[str],
    ) -> Gtk.Widget:
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        vbox.set_border_width(20)

        # Einheitliche Kopfleiste (H2 + Beschreibung darunter + Startseiten-Icongröße 34px)
        hdr_bar = self._build_module_header_bar(mod_num, mod_title, mod_sub, icon_key)
        vbox.pack_start(hdr_bar, False, False, 0)
        vbox.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)

        card_frame = Gtk.Frame()
        card_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        card_vbox.set_border_width(24)

        cut_dir = getattr(self.settings, "output_dir_cut", DEFAULT_OUTPUT_DIR_CUT)
        status_lbl = Gtk.Label()
        status_lbl.set_markup(
            f"<span font_family='monospace'>{GLib.markup_escape_text(mod_num)} · Status: Freigehalten für spätere Erweiterung · Zielordner: {GLib.markup_escape_text(str(cut_dir))}</span>"
        )
        status_lbl.set_xalign(0)
        status_lbl.get_style_context().add_class("dim-label")
        card_vbox.pack_start(status_lbl, False, False, 0)

        title_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        title_row.pack_start(make_system_icon(icon_key, pixel_size=34), False, False, 0)
        main_lbl = Gtk.Label()
        main_lbl.set_markup(f"<span size='x-large' weight='bold'>{GLib.markup_escape_text(mod_title)}</span>")
        main_lbl.set_xalign(0)
        title_row.pack_start(main_lbl, False, False, 0)
        card_vbox.pack_start(title_row, False, False, 0)

        desc_lbl = Gtk.Label(label=mod_desc)
        desc_lbl.set_xalign(0)
        desc_lbl.set_line_wrap(True)
        card_vbox.pack_start(desc_lbl, False, False, 0)

        for idx, h_text in enumerate(highlights, start=1):
            item_lbl = Gtk.Label(label=f"0{idx}. {h_text}")
            item_lbl.set_xalign(0)
            item_lbl.set_line_wrap(True)
            card_vbox.pack_start(item_lbl, False, False, 0)

        card_frame.add(card_vbox)
        vbox.pack_start(card_frame, False, False, 0)
        return vbox

    def _rebuild_module_jump_menu(self, active_module_id: str) -> None:
        """Aktualisiert das Modul-Sprungmenü rechts neben 'Startseite' mit allen anderen Modulen & Einstellungen."""
        if not hasattr(self, "module_jump_btn"):
            return
        if active_module_id == "home":
            self.module_jump_btn.set_no_show_all(True)
            self.module_jump_btn.hide()
            return

        jump_targets = [
            ("module_cover", "01. Coverbild beziehen", "cover_image"),
            ("module_rip", "02. CD-Rippen", "optical_drive"),
            ("module_tag", "03. Album Taggen", "module_tag"),
            ("module_convert", "04. Musik konvertieren", "module_convert"),
            ("module_repair", "05. Musik reparieren", "module_repair"),
            ("module_cut", "06. Musik Schneiden", "module_cut"),
        ]

        menu = Gtk.Menu()
        for target_id, target_label, icon_key in jump_targets:
            if target_id == active_module_id:
                continue
            mi = Gtk.MenuItem()
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            row.pack_start(make_system_icon(icon_key, pixel_size=16), False, False, 0)
            lbl = Gtk.Label(label=target_label)
            lbl.set_xalign(0)
            row.pack_start(lbl, True, True, 0)
            mi.add(row)
            mi.connect("activate", lambda _item, m=target_id: self._switch_to_module(m))
            menu.append(mi)

        if active_module_id != "settings":
            menu.append(Gtk.SeparatorMenuItem())
            mi_settings = Gtk.MenuItem()
            row_s = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            row_s.pack_start(make_system_icon("settings", pixel_size=16), False, False, 0)
            lbl_s = Gtk.Label(label="Einstellungen")
            lbl_s.set_xalign(0)
            row_s.pack_start(lbl_s, True, True, 0)
            mi_settings.add(row_s)
            mi_settings.connect("activate", lambda _item: self._switch_to_module("settings"))
            menu.append(mi_settings)

        menu.show_all()
        self.module_jump_btn.set_popup(menu)
        self.module_jump_btn.set_no_show_all(False)
        self.module_jump_btn.show_all()

    def _switch_to_module(
        self, module_id: str, log: bool = True, reset_cache: bool = True
    ) -> None:
        prev_module = getattr(self, "_active_module", None)
        if reset_cache and prev_module != module_id:
            self._reset_module_cache()
        self._active_module = module_id
        if not hasattr(self, "main_stack"):
            return

        # Dropdown-Sprungmenü rechts neben "Startseite" für alle Module außer der Startseite
        self._rebuild_module_jump_menu(module_id)

        # Obere Toolbar: In Modul 2 & 3 modulspezifische Werkzeuge, in Modul 4 & 5 Import-/Prüfbuttons neben Startseite
        show_full_toolbar = module_id in ("module_rip", "module_tag")
        if hasattr(self, "_workbench_toolbar_widgets"):
            for w in self._workbench_toolbar_widgets:
                w.set_no_show_all(not show_full_toolbar)
                w.set_visible(show_full_toolbar)

        show_converter_toolbar = module_id == "module_convert"
        if hasattr(self, "_converter_toolbar_widgets"):
            for cw in self._converter_toolbar_widgets:
                cw.set_no_show_all(not show_converter_toolbar)
                if show_converter_toolbar:
                    cw.show_all()
                else:
                    cw.hide()

        show_repair_toolbar = module_id == "module_repair"
        if hasattr(self, "_repair_toolbar_widgets"):
            for rw in self._repair_toolbar_widgets:
                rw.set_no_show_all(not show_repair_toolbar)
                if show_repair_toolbar:
                    rw.show_all()
                else:
                    rw.hide()

        # Modulspezifische Ausblendungen in Modul 2 (ohne Ordner-Import) & Modul 3 (ohne CD-Laufwerk / CD-Einlesen / Barcode)
        if module_id == "module_rip":
            for w in (
                getattr(self, "drive_icon", None),
                getattr(self, "drive_combo", None),
                getattr(self, "tray_toggle_btn", None),
                getattr(self, "scan_cd_btn", None),
                getattr(self, "barcode_toolbar_btn", None),
                getattr(self, "bc_scan_inline_btn", None),
            ):
                if w is not None:
                    w.set_no_show_all(False)
                    w.set_visible(True)
            if hasattr(self, "import_folder_btn"):
                self.import_folder_btn.set_no_show_all(True)
                self.import_folder_btn.set_visible(False)
            if hasattr(self, "filename_to_tags_btn"):
                self.filename_to_tags_btn.set_no_show_all(True)
                self.filename_to_tags_btn.set_visible(False)
            if hasattr(self, "hdr_health"):
                self.hdr_health.set_no_show_all(True)
                self.hdr_health.set_visible(False)
            if hasattr(self, "retry_query_label"):
                self.retry_query_label.set_text("Erneut versuchen")
            if hasattr(self, "retry_query_btn"):
                self.retry_query_btn.set_tooltip_text(
                    "Metadaten-Abfrage für das geladene Album mit exponentiellem Backoff neu initialisieren (z. B. nach HTTP 503 Fehler, ohne das Album neu zu laden)"
                )
            self._tag_health_scan_gen += 1
            self._refresh_cd_tray_state_async()
            self._start_tray_polling()
        elif module_id == "module_tag":
            self._stop_tray_polling()
            for w in (
                getattr(self, "drive_icon", None),
                getattr(self, "drive_combo", None),
                getattr(self, "tray_toggle_btn", None),
                getattr(self, "scan_cd_btn", None),
                getattr(self, "barcode_toolbar_btn", None),
                getattr(self, "bc_scan_inline_btn", None),
            ):
                if w is not None:
                    w.set_no_show_all(True)
                    w.set_visible(False)
            if hasattr(self, "import_folder_btn"):
                self.import_folder_btn.set_no_show_all(False)
                self.import_folder_btn.set_visible(True)
            if hasattr(self, "filename_to_tags_btn"):
                self.filename_to_tags_btn.set_no_show_all(False)
                self.filename_to_tags_btn.set_visible(True)
            if hasattr(self, "hdr_health"):
                self.hdr_health.set_no_show_all(False)
                self.hdr_health.set_visible(True)
            if hasattr(self, "retry_query_label"):
                self.retry_query_label.set_text("Onlinedatenbanken abfragen")
            if hasattr(self, "retry_query_btn"):
                self.retry_query_btn.set_tooltip_text(
                    "Onlinedatenbanken (MusicBrainz, Discogs, CDDB/GnuDB) für das geladene Album abfragen"
                )
        else:
            self._tag_health_scan_gen += 1
            self._stop_tray_polling()

        if module_id == "home":
            self.main_stack.set_visible_child_name("home")
            if hasattr(self, "right_box"):
                self.right_box.set_visible(True)
            if log:
                self._append_query_log_ui(
                    "[Navigation] Zurückgekehrt zur Startseite (Modul-Cache zurückgesetzt)."
                )
            return

        if module_id == "settings":
            if hasattr(self, "settings_panel"):
                self.settings_panel.load_from_settings(self.settings, self.theme_watcher.mode)
            self.main_stack.set_visible_child_name("settings")
            if log:
                self._append_query_log_ui(
                    "[Navigation] Einstellungsseite geöffnet (Modul-Cache zurückgesetzt)."
                )
            return

        if module_id in ("module_convert", "module_repair", "module_cut"):
            self.main_stack.set_visible_child_name(module_id)
            if log:
                self._append_query_log_ui(
                    f"[Navigation] Gewechselt zu Modul „{module_id}“ (Modul-Cache zurückgesetzt)."
                )
            return

        # Aktive Arbeitsbereich-Module: module_cover (1), module_rip (2), module_tag (3)
        self.main_stack.set_visible_child_name("workbench")
        is_cover_only = module_id == "module_cover"
        self._update_cover_toolbar_icon_sizes(module_id)
        self._update_rip_or_tag_button_mode()
        if hasattr(self, "outer_paned"):
            self._schedule_outer_paned_sync()
        if hasattr(self, "cover_image"):
            target_dim = 340 if is_cover_only else 240
            self.cover_image.set_size_request(target_dim, target_dim)
        for tb_widget in (
            getattr(self, "online_cover_btn", None),
            getattr(self, "online_cover_sep", None),
            getattr(self, "choose_file_btn", None),
        ):
            if tb_widget is not None:
                tb_widget.set_no_show_all(is_cover_only)
                tb_widget.set_visible(not is_cover_only)
        if hasattr(self, "module_header_bar"):
            self.module_header_bar.set_no_show_all(False)
            self.module_header_bar.set_visible(True)
        if hasattr(self, "module_header_sep"):
            self.module_header_sep.set_no_show_all(False)
            self.module_header_sep.set_visible(True)
        if hasattr(self, "meta_grid"):
            self.meta_grid.set_no_show_all(is_cover_only)
            self.meta_grid.set_visible(not is_cover_only)
        if hasattr(self, "search_all_btn"):
            self.search_all_btn.set_label("Onlinedatenbanken abfragen")
        if hasattr(self, "enrich_genres_btn"):
            self.enrich_genres_btn.set_no_show_all(is_cover_only)
            self.enrich_genres_btn.set_visible(not is_cover_only)
        if hasattr(self, "module_header_title_label"):
            if module_id == "module_cover":
                mod_icon_key = "cover_image"
                mod_head_txt = "01. Modul · Coverbild beziehen"
                mod_sub_txt = "Multi-Provider-Coversuche (9 konfigurierbare Bilddatenbanken), SANE-Scanner, Zuschnitt & Speichern"
            elif module_id == "module_tag":
                mod_icon_key = "module_tag"
                mod_head_txt = "03. Modul · Album Taggen"
                mod_sub_txt = "Album-Ordner importieren, MusicBrainz-Picard-Tags bearbeiten & direkt in Dateien schreiben (FLAC + ID3v2.3/v2.4)"
            else:
                mod_icon_key = "optical_drive"
                mod_head_txt = "02. Modul · CD-Rippen"
                mod_sub_txt = "Audio-CD auslesen (cdparanoia), Online-Metadaten abrufen & FLAC/MP3 exportieren"
            self.module_header_title_label.set_markup(
                f"<span size='x-large' weight='bold'>{GLib.markup_escape_text(mod_head_txt)}</span>"
            )
            if hasattr(self, "module_header_sub_label"):
                self.module_header_sub_label.set_markup(
                    f"<span size='small'>{GLib.markup_escape_text(mod_sub_txt)}</span>"
                )
            if hasattr(self, "module_header_icon_box"):
                for ch in self.module_header_icon_box.get_children():
                    self.module_header_icon_box.remove(ch)
                self.module_header_icon_box.pack_start(
                    make_system_icon(mod_icon_key, pixel_size=34), False, False, 0
                )
                self.module_header_icon_box.show_all()
        self._render_cover_preview()
        self._update_workspace_visibility_and_locks()
        if log:
            self._append_query_log_ui(
                f"[Navigation] Modul geöffnet: „{module_id}“ (Modul-Cache zurückgesetzt)."
            )

    def _build_layout(self) -> None:
        main_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.add(main_vbox)

        self.primary_toolbar = self._build_toolbar()
        main_vbox.pack_start(self.primary_toolbar, False, False, 0)
        main_vbox.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)

        # Vertikales Haupt-Paned: Oben Gtk.Stack (Startseite + 6 Module), unten optionale skalierbare Abfrage-Protokoll-Spalte
        self.window_vpaned = Gtk.Paned(orientation=Gtk.Orientation.VERTICAL)
        self.window_vpaned.set_position(620)
        main_vbox.pack_start(self.window_vpaned, True, True, 0)

        self.main_stack = Gtk.Stack()
        self.main_stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self.main_stack.set_transition_duration(140)
        self.window_vpaned.pack1(self.main_stack, resize=True, shrink=False)

        # Startseite ("home") mit den 6 Modulkacheln
        self.main_stack.add_named(self._build_home_launcher_page(), "home")

        # Modul 4 & 5: Audio-Konverter & Musik reparieren
        self.main_stack.add_named(self._build_converter_module_page(), "module_convert")
        self.main_stack.add_named(self._build_repair_module_page(), "module_repair")
        self.main_stack.add_named(
            self._build_reserved_module_page(
                "06. Modul",
                "Musik Schneiden",
                "Präziser Audio-Zuschnitt, CUE-Splitter & Stille-Erkennung",
                "Schneidet Einzelaufnahmen oder Gesamtdatenströme verlustfrei anhand von CUE-Sheets oder automatischer Pausen-Erkennung in Einzeltitel.",
                "module_cut",
                [
                    "Samplegenaues Aufteilen von Gesamtaufnahmen mittels CUE-Sheet",
                    "Automatische Stille-Erkennung an Trackgrenzen sowie Trimmen von Pausen",
                    "Verlustfreies Ein- und Ausblenden (Fade-In / Fade-Out) bei Live-Mitschnitten",
                ],
            ),
            "module_cut",
        )

        # Eigene Seite für die Einstellungen ("settings")
        settings_page_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        settings_hdr_bar = self._build_module_header_bar(
            "System",
            "Einstellungen",
            "Zielordner je Modul, FLAC/MP3, Normalisierung, Scanner & Protokoll",
            "settings",
        )
        settings_page_vbox.pack_start(settings_hdr_bar, False, False, 0)
        settings_page_vbox.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)

        self.settings_panel = SettingsPanel(
            parent_window=self,
            settings=self.settings,
            theme_mode=self.theme_watcher.mode,
            on_apply=self._on_settings_applied,
            on_back_to_home=None,
        )
        settings_page_vbox.pack_start(self.settings_panel, True, True, 0)
        self.main_stack.add_named(settings_page_vbox, "settings")

        # Arbeitsbereich-Seite ("workbench") für Modul 1, 2 und 3
        workbench_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.module_header_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        self.module_header_bar.set_homogeneous(True)
        self.module_header_bar.set_border_width(8)

        wb_hdr_left_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        self.module_header_icon_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self.module_header_icon_box.pack_start(
            make_system_icon("optical_drive", pixel_size=34), False, False, 0
        )
        wb_hdr_left_box.pack_start(self.module_header_icon_box, False, False, 0)

        wb_hdr_txt_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        wb_hdr_txt_box.set_valign(Gtk.Align.CENTER)
        wb_hdr_txt_box.set_hexpand(True)
        self.module_header_title_label = Gtk.Label()
        self.module_header_title_label.set_markup(
            "<span size='x-large' weight='bold'>02. Modul · CD-Rippen</span>"
        )
        self.module_header_title_label.set_xalign(0)
        self.module_header_title_label.set_ellipsize(Pango.EllipsizeMode.END)
        wb_hdr_txt_box.pack_start(self.module_header_title_label, False, False, 0)

        self.module_header_sub_label = Gtk.Label()
        self.module_header_sub_label.set_markup(
            "<span size='small'>Audio-CD auslesen (cdparanoia), Online-Metadaten abrufen &amp; FLAC/MP3 exportieren</span>"
        )
        self.module_header_sub_label.set_xalign(0)
        self.module_header_sub_label.set_ellipsize(Pango.EllipsizeMode.END)
        self.module_header_sub_label.get_style_context().add_class("dim-label")
        wb_hdr_txt_box.pack_start(self.module_header_sub_label, False, False, 0)

        wb_hdr_left_box.pack_start(wb_hdr_txt_box, True, True, 0)
        self.module_header_bar.pack_start(wb_hdr_left_box, True, True, 0)

        # Globale Suchleiste direkt neben der Fensterüberschrift (max. 50 % der Fensterbreite)
        wb_hdr_right_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self.search_bar_frame = Gtk.Frame()
        self.search_bar_frame.set_shadow_type(Gtk.ShadowType.IN)
        self.search_bar_frame.get_style_context().add_class("display-box")
        self.search_bar_frame.set_valign(Gtk.Align.CENTER)
        self.search_bar_frame.set_hexpand(True)
        self.search_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.search_bar.set_border_width(5)
        self.search_bar.pack_start(make_system_icon("search_online"), False, False, 0)
        self.search_entry = Gtk.Entry()
        self.search_entry.set_hexpand(True)
        self.search_entry.set_width_chars(16)
        self.search_entry.set_placeholder_text(
            "Album, Künstler, Discogs-Code ([r524030]), Barcode (EAN/UPC) oder CDDB-DiscID in allen Datenbanken suchen..."
        )
        self.search_entry.connect("activate", lambda _e: self._on_manual_search_clicked())
        self.search_bar.pack_start(self.search_entry, True, True, 0)

        self.search_all_btn = Gtk.Button(label="Onlinedatenbanken abfragen")
        self.search_all_btn.set_tooltip_text(
            "Fragt MusicBrainz, CDDB/GnuDB und Discogs (bzw. im Modul 1 alle Cover-Provider) ab"
        )
        self.search_all_btn.connect("clicked", lambda _b: self._on_manual_search_clicked())
        self.search_bar.pack_start(self.search_all_btn, False, False, 0)

        self.enrich_genres_btn = Gtk.Button(label="Track-Genres anreichern")
        self.enrich_genres_btn.set_tooltip_text(
            "Reichert fehlende Song-Genres gezielt aus MusicBrainz Release-Group-Pressungen, Discogs Styles & Last.fm an"
        )
        self.enrich_genres_btn.connect("clicked", lambda _b: self._on_enrich_track_genres_clicked())
        self.search_bar.pack_start(self.enrich_genres_btn, False, False, 0)

        self.cancel_cover_search_btn = Gtk.Button(label="Suche abbrechen")
        self.cancel_cover_search_btn.set_tooltip_text("Laufende Online-Cover-Suche sofort abbrechen")
        self.cancel_cover_search_btn.get_style_context().add_class("destructive-action")
        self.cancel_cover_search_btn.set_no_show_all(True)
        self.cancel_cover_search_btn.connect("clicked", lambda _b: self._on_cancel_cover_search_clicked())
        self.search_bar.pack_start(self.cancel_cover_search_btn, False, False, 0)

        self.search_bar_frame.add(self.search_bar)
        wb_hdr_right_box.pack_start(self.search_bar_frame, True, True, 0)
        self.module_header_bar.pack_start(wb_hdr_right_box, True, True, 0)

        workbench_vbox.pack_start(self.module_header_bar, False, False, 0)
        self.module_header_sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        workbench_vbox.pack_start(self.module_header_sep, False, False, 0)

        outer_paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        outer_paned.set_wide_handle(True)
        outer_paned.set_position(400)
        self.outer_paned = outer_paned
        workbench_vbox.pack_start(outer_paned, True, True, 0)
        self.main_stack.add_named(workbench_vbox, "workbench")

        # Linke Sidebar: Cover-Art (Drag & Drop) + Album-Metadaten (in Modul 2 & 3 ein- und ausklappbar wie rechts)
        self.left_sidebar_container = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)

        self.left_sidebar_expanded = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.left_sidebar_expanded.set_hexpand(True)
        # Mindestbreite 400px sicherstellen, damit alle Feldbeschriftungen stets vollständig lesbar bleiben
        self.left_sidebar_expanded.set_size_request(400, -1)

        self.left_sidebar_header_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.left_sidebar_header_box.set_border_width(8)
        self.left_panel_collapse_btn = Gtk.Button()
        self.left_panel_collapse_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.left_panel_collapse_btn.add(
            Gtk.Image.new_from_icon_name("go-previous-symbolic", Gtk.IconSize.BUTTON)
        )
        self.left_panel_collapse_btn.set_tooltip_text("Linke Album-Spalte einklappen")
        self.left_panel_collapse_btn.connect(
            "clicked", lambda _b: self._set_left_panel_collapsed(True)
        )
        self.left_sidebar_header_box.pack_start(self.left_panel_collapse_btn, False, False, 0)

        left_hdr_right_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        left_hdr_right_box.set_halign(Gtk.Align.END)
        self.left_hdr_lbl = Gtk.Label()
        self.left_hdr_lbl.set_markup("<b>Album &amp; Cover</b>")
        self.left_hdr_lbl.set_xalign(1.0)
        self.left_hdr_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        left_hdr_right_box.pack_start(self.left_hdr_lbl, False, False, 0)
        left_hdr_right_box.pack_start(make_system_icon("cover_image"), False, False, 0)
        self.left_sidebar_header_box.pack_end(left_hdr_right_box, True, True, 0)

        self.left_sidebar_expanded.pack_start(self.left_sidebar_header_box, False, False, 0)
        self.left_sidebar_header_sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        self.left_sidebar_expanded.pack_start(self.left_sidebar_header_sep, False, False, 0)

        self.left_panel_stack = Gtk.Stack()
        self.left_panel_stack.set_transition_type(Gtk.StackTransitionType.NONE)
        self.left_panel_stack.set_homogeneous(False)

        sidebar_scroll = Gtk.ScrolledWindow()
        sidebar_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        sidebar_scroll.set_overlay_scrolling(False)
        self.sidebar_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.sidebar_box.set_border_width(14)
        sidebar_scroll.add(self.sidebar_box)
        sidebar_box = self.sidebar_box
        self.left_panel_stack.add_named(sidebar_scroll, "album_editor")

        # Seite 2 der linken Spalte: Album-Vorschau für den aktuell markierten Treffer in Display 1
        self.left_album_preview_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        self.left_album_preview_scroll = Gtk.ScrolledWindow()
        self.left_album_preview_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.left_album_preview_scroll.set_overlay_scrolling(False)
        left_prev_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        left_prev_box.set_border_width(14)

        cover_prev_frame = Gtk.Frame()
        cover_prev_frame.set_halign(Gtk.Align.CENTER)
        self.left_preview_cover_img = Gtk.Image()
        self.left_preview_cover_img.set_size_request(180, 180)
        self.left_preview_cover_img.set_from_icon_name("media-optical", Gtk.IconSize.DIALOG)
        cover_prev_frame.add(self.left_preview_cover_img)
        left_prev_box.pack_start(cover_prev_frame, False, False, 0)

        self.left_preview_title_lbl = Gtk.Label()
        self.left_preview_title_lbl.set_markup("<b>—</b>")
        self.left_preview_title_lbl.set_justify(Gtk.Justification.CENTER)
        self.left_preview_title_lbl.set_line_wrap(True)
        self.left_preview_title_lbl.set_max_width_chars(32)
        left_prev_box.pack_start(self.left_preview_title_lbl, False, False, 0)

        self.left_preview_artist_lbl = Gtk.Label(label="")
        self.left_preview_artist_lbl.set_justify(Gtk.Justification.CENTER)
        self.left_preview_artist_lbl.set_line_wrap(True)
        self.left_preview_artist_lbl.set_max_width_chars(32)
        self.left_preview_artist_lbl.get_style_context().add_class("dim-label")
        left_prev_box.pack_start(self.left_preview_artist_lbl, False, False, 0)

        self.left_preview_badge_lbl = Gtk.Label(label="")
        self.left_preview_badge_lbl.set_justify(Gtk.Justification.CENTER)
        self.left_preview_badge_lbl.set_line_wrap(True)
        self.left_preview_badge_lbl.get_style_context().add_class("dim-label")
        left_prev_box.pack_start(self.left_preview_badge_lbl, False, False, 0)

        self.left_preview_status_lbl = Gtk.Label(label="")
        self.left_preview_status_lbl.set_justify(Gtk.Justification.CENTER)
        self.left_preview_status_lbl.set_line_wrap(True)
        self.left_preview_status_lbl.get_style_context().add_class("dim-label")
        left_prev_box.pack_start(self.left_preview_status_lbl, False, False, 0)

        left_prev_box.pack_start(
            Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 2
        )

        self.left_album_preview_meta_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        left_prev_box.pack_start(self.left_album_preview_meta_box, False, False, 0)

        self.left_album_preview_scroll.add(left_prev_box)
        self.left_album_preview_page.pack_start(self.left_album_preview_scroll, True, True, 0)

        # Hinweis am unteren Rand der linken Album-Vorschau (Übernahme-Button sitzt rechts unten)
        left_prev_footer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        left_prev_footer.set_border_width(10)

        left_prev_hint = Gtk.Label(
            label="Vorschau — bestehende Album- & Ordner-Tags bleiben unverändert, bis das Album rechts unten geladen wird."
        )
        left_prev_hint.set_justify(Gtk.Justification.CENTER)
        left_prev_hint.set_line_wrap(True)
        left_prev_hint.get_style_context().add_class("dim-label")
        left_prev_footer.pack_start(left_prev_hint, False, False, 0)

        self.left_album_preview_page.pack_end(left_prev_footer, False, False, 0)
        self.left_album_preview_page.pack_end(
            Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0
        )

        self.left_preview_overlay = Gtk.Overlay()
        self.left_preview_overlay.add(self.left_album_preview_page)

        self.left_preview_loading_overlay_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.left_preview_loading_overlay_box.get_style_context().add_class("cover-loading-overlay")
        self.left_preview_loading_overlay_box.set_halign(Gtk.Align.FILL)
        self.left_preview_loading_overlay_box.set_valign(Gtk.Align.FILL)
        left_ov_center = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        left_ov_center.set_halign(Gtk.Align.CENTER)
        left_ov_center.set_valign(Gtk.Align.CENTER)

        self.left_preview_spinner_area = Gtk.DrawingArea()
        self.left_preview_spinner_area.set_size_request(48, 48)
        self.left_preview_spinner_area.set_halign(Gtk.Align.CENTER)
        self.left_preview_spinner_area.connect("draw", self._on_draw_slow_spinner)
        left_ov_center.pack_start(self.left_preview_spinner_area, False, False, 0)

        self.left_preview_overlay_title_label = Gtk.Label()
        self.left_preview_overlay_title_label.set_markup("<b>Albumdetails werden abgefragt…</b>")
        self.left_preview_overlay_title_label.set_line_wrap(True)
        self.left_preview_overlay_title_label.set_justify(Gtk.Justification.CENTER)
        left_ov_center.pack_start(self.left_preview_overlay_title_label, False, False, 0)

        self.left_preview_overlay_sub_label = Gtk.Label()
        self.left_preview_overlay_sub_label.set_markup(
            "<span size='small'>Cover &amp; Metadaten werden geladen</span>"
        )
        self.left_preview_overlay_sub_label.set_line_wrap(True)
        self.left_preview_overlay_sub_label.set_justify(Gtk.Justification.CENTER)
        left_ov_center.pack_start(self.left_preview_overlay_sub_label, False, False, 0)

        self.left_preview_loading_overlay_box.pack_start(left_ov_center, True, True, 0)
        self.left_preview_loading_overlay_box.set_no_show_all(True)
        self.left_preview_loading_overlay_box.hide()
        self.left_preview_overlay.add_overlay(self.left_preview_loading_overlay_box)

        self.left_panel_stack.add_named(self.left_preview_overlay, "album_preview")
        self.left_panel_stack.set_visible_child_name("album_editor")

        self.left_sidebar_expanded.pack_start(self.left_panel_stack, True, True, 0)
        self.left_sidebar_container.pack_start(self.left_sidebar_expanded, True, True, 0)

        # Eingeklappte schmale Leiste der linken Spalte (zum Wiederausklappen)
        self.left_sidebar_collapsed = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.left_sidebar_collapsed.set_size_request(36, -1)
        self.left_sidebar_collapsed.set_no_show_all(True)

        self.left_panel_expand_btn = Gtk.Button()
        self.left_panel_expand_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.left_panel_expand_btn.get_style_context().add_class("track-inspector-rail-btn")
        self.left_panel_expand_btn.set_tooltip_text("Linke Album-Spalte ausklappen")
        left_expand_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        left_expand_box.set_valign(Gtk.Align.START)
        left_expand_box.pack_start(
            Gtk.Image.new_from_icon_name("go-next-symbolic", Gtk.IconSize.BUTTON),
            False,
            False,
            0,
        )
        self.left_panel_rail_lbl = Gtk.Label(label="Album & Cover")
        self.left_panel_rail_lbl.set_angle(90)
        self.left_panel_rail_lbl.get_style_context().add_class("dim-label")
        left_expand_box.pack_start(self.left_panel_rail_lbl, False, False, 0)
        self.left_panel_expand_btn.add(left_expand_box)
        self.left_panel_expand_btn.connect(
            "clicked", lambda _b: self._set_left_panel_collapsed(False)
        )
        self.left_sidebar_collapsed.pack_start(self.left_panel_expand_btn, True, True, 0)
        self.left_sidebar_container.pack_start(self.left_sidebar_collapsed, True, True, 0)

        outer_paned.pack1(self.left_sidebar_container, resize=False, shrink=False)
        outer_paned.connect("size-allocate", self._on_outer_paned_size_allocate)
        outer_paned.connect("notify::position", self._on_outer_paned_position_changed)

        # Cover Art Fieldset mit bündiger vertikaler Icon-Toolbar am linken inneren Rand (nicht schwebend)
        cover_event_box = Gtk.EventBox()
        cover_frame = Gtk.Frame(label="Album-Cover")
        cover_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        cover_box.set_margin_top(6)
        cover_box.set_margin_bottom(8)
        cover_box.set_margin_start(0)
        cover_box.set_margin_end(8)

        cover_top_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)

        # Vertikale Icon-Toolbar bündig am linken inneren Rand des Fieldsets (Modul 1 & 2: alte 16px/28px Größe, Modul 3: 26px/38px)
        inner_toolbar = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        inner_toolbar.set_valign(Gtk.Align.START)
        inner_toolbar.set_margin_start(4)
        inner_toolbar.set_margin_end(4)
        inner_toolbar.set_margin_top(2)
        inner_toolbar.set_margin_bottom(2)
        self._cover_toolbar_items: list[tuple[Gtk.Button, str]] = []

        online_cover_btn = Gtk.Button()
        online_cover_btn.set_size_request(28, 28)
        online_cover_btn.set_relief(Gtk.ReliefStyle.NONE)
        online_cover_icon = make_system_icon("search_online", pixel_size=16)
        online_cover_icon.set_has_tooltip(False)
        online_cover_btn.add(online_cover_icon)
        online_cover_btn.set_tooltip_text(
            "Cover online suchen: Fragt alle in den Einstellungen aktivierten Bilddatenbanken parallel ab und öffnet die Treffer-Auswahltabelle"
        )
        online_cover_btn.set_has_tooltip(True)
        online_cover_btn.connect(
            "clicked",
            lambda _b: self._start_online_cover_search(),
        )
        self.online_cover_btn = online_cover_btn
        self._cover_toolbar_items.append((online_cover_btn, "search_online"))
        inner_toolbar.pack_start(online_cover_btn, False, False, 0)

        self.online_cover_sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        inner_toolbar.pack_start(self.online_cover_sep, False, False, 2)

        choose_file_btn = Gtk.Button()
        choose_file_btn.set_size_request(28, 28)
        choose_file_btn.set_relief(Gtk.ReliefStyle.NONE)
        choose_icon = make_system_icon("open_file", pixel_size=16)
        choose_icon.set_has_tooltip(False)
        choose_file_btn.add(choose_icon)
        choose_file_btn.set_tooltip_text(
            "Eigenes Cover-Bild von der Festplatte auswählen (JPG, PNG, WebP, BMP, TIFF)"
        )
        choose_file_btn.set_has_tooltip(True)
        choose_file_btn.connect("clicked", self._on_choose_cover_file_clicked)
        self.choose_file_btn = choose_file_btn
        self._cover_toolbar_items.append((choose_file_btn, "open_file"))
        inner_toolbar.pack_start(choose_file_btn, False, False, 0)

        scan_cover_btn = Gtk.Button()
        scan_cover_btn.set_size_request(28, 28)
        scan_cover_btn.set_relief(Gtk.ReliefStyle.NONE)
        scan_icon = make_system_icon("scanner", pixel_size=16)
        scan_icon.set_has_tooltip(False)
        scan_cover_btn.add(scan_icon)
        scan_cover_btn.set_tooltip_text(
            "Sofort scannen (mit Scanner-Einstellungen aus dem Einstellungsfenster) und anschließend Zuschneidefenster öffnen"
        )
        scan_cover_btn.set_has_tooltip(True)
        scan_cover_btn.connect("clicked", self._on_scan_cover_clicked)
        self.scan_cover_btn = scan_cover_btn
        self._cover_toolbar_items.append((scan_cover_btn, "scanner"))
        inner_toolbar.pack_start(scan_cover_btn, False, False, 0)

        self.cover_tools_sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        inner_toolbar.pack_start(self.cover_tools_sep, False, False, 2)

        self.crop_cover_btn = Gtk.Button()
        self.crop_cover_btn.set_size_request(28, 28)
        self.crop_cover_btn.set_relief(Gtk.ReliefStyle.NONE)
        crop_icon = make_system_icon("crop_cover", pixel_size=16)
        crop_icon.set_has_tooltip(False)
        crop_icon.show()
        self.crop_cover_btn.add(crop_icon)
        self.crop_cover_btn.set_tooltip_text(
            "Geladenes Coverbild in voller Größe beschneiden (Schere)"
        )
        self.crop_cover_btn.set_has_tooltip(True)
        self.crop_cover_btn.set_sensitive(False)
        self.crop_cover_btn.connect("clicked", self._on_crop_cover_clicked)
        self._cover_toolbar_items.append((self.crop_cover_btn, "crop_cover"))
        inner_toolbar.pack_start(self.crop_cover_btn, False, False, 0)

        self.scale_cover_btn = Gtk.Button()
        self.scale_cover_btn.set_size_request(28, 28)
        self.scale_cover_btn.set_relief(Gtk.ReliefStyle.NONE)
        scale_icon = make_system_icon("scale_cover", pixel_size=16)
        scale_icon.set_has_tooltip(False)
        scale_icon.show()
        self.scale_cover_btn.add(scale_icon)
        self.scale_cover_btn.set_tooltip_text(
            "Geladenes Coverbild skalieren (Quadratisch oder mit eigenen Werten)"
        )
        self.scale_cover_btn.set_has_tooltip(True)
        self.scale_cover_btn.set_sensitive(False)
        self.scale_cover_btn.connect("clicked", self._on_scale_cover_clicked)
        self._cover_toolbar_items.append((self.scale_cover_btn, "scale_cover"))
        inner_toolbar.pack_start(self.scale_cover_btn, False, False, 0)

        self.save_cover_btn = Gtk.Button()
        self.save_cover_btn.set_size_request(28, 28)
        self.save_cover_btn.set_relief(Gtk.ReliefStyle.NONE)
        save_icon = make_system_icon("save_cover", pixel_size=16)
        save_icon.set_has_tooltip(False)
        save_icon.show()
        self.save_cover_btn.add(save_icon)
        self.save_cover_btn.set_tooltip_text(
            "Geladenes Coverbild manuell auf Festplatte speichern (Diskette)"
        )
        self.save_cover_btn.set_has_tooltip(True)
        self.save_cover_btn.set_sensitive(False)
        self.save_cover_btn.connect("clicked", self._on_save_cover_clicked)
        self._cover_toolbar_items.append((self.save_cover_btn, "save_cover"))
        inner_toolbar.pack_start(self.save_cover_btn, False, False, 0)

        cover_top_row.pack_start(inner_toolbar, False, False, 0)
        cover_top_row.pack_start(
            Gtk.Separator(orientation=Gtk.Orientation.VERTICAL), False, False, 4
        )

        self.cover_overlay = Gtk.Overlay()
        self.cover_image = Gtk.Image()
        self.cover_image.set_size_request(240, 240)
        self._set_placeholder_cover()
        self.cover_overlay.add(self.cover_image)

        # Deutlich transparenteres Overlay mit langsam rotierendem Kreis (2.4s pro Umdrehung) & Abbrechen-Button während Cover-Suche oder Scanvorgang
        self.cover_search_overlay_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.cover_search_overlay_box.set_valign(Gtk.Align.FILL)
        self.cover_search_overlay_box.set_halign(Gtk.Align.FILL)
        self.cover_search_overlay_box.set_no_show_all(True)
        self.cover_search_overlay_box.get_style_context().add_class("cover-loading-overlay")

        overlay_inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        overlay_inner.set_valign(Gtk.Align.CENTER)
        overlay_inner.set_halign(Gtk.Align.CENTER)
        overlay_inner.set_border_width(12)

        self.cover_search_spinner_area = Gtk.DrawingArea()
        self.cover_search_spinner_area.set_size_request(48, 48)
        self.cover_search_spinner_area.set_halign(Gtk.Align.CENTER)
        self.cover_search_spinner_area.connect("draw", self._on_draw_slow_spinner)
        overlay_inner.pack_start(self.cover_search_spinner_area, False, False, 0)

        self.overlay_title_label = Gtk.Label()
        self.overlay_title_label.set_markup("<b>Cover-Suche läuft…</b>")
        self.overlay_title_label.set_justify(Gtk.Justification.CENTER)
        overlay_inner.pack_start(self.overlay_title_label, False, False, 0)

        self.overlay_sub_label = Gtk.Label()
        self.overlay_sub_label.set_markup("<span size='small'>Aktivierte Bilddatenbanken werden abgefragt…</span>")
        self.overlay_sub_label.set_justify(Gtk.Justification.CENTER)
        overlay_inner.pack_start(self.overlay_sub_label, False, False, 0)

        self.overlay_cancel_btn = Gtk.Button(label="Suche abbrechen")
        self.overlay_cancel_btn.get_style_context().add_class("destructive-action")
        self.overlay_cancel_btn.connect("clicked", lambda _b: self._on_cancel_cover_overlay_clicked())
        overlay_inner.pack_start(self.overlay_cancel_btn, False, False, 4)

        self.cover_search_overlay_box.pack_start(overlay_inner, True, True, 0)
        self.cover_overlay.add_overlay(self.cover_search_overlay_box)

        cover_top_row.pack_start(self.cover_overlay, True, True, 4)

        cover_box.pack_start(cover_top_row, False, False, 0)

        self.cover_meta_label = Gtk.Label()
        self.cover_meta_label.set_markup(
            "<span size='small'>Auflösung: — · Größe: — · Format: —</span>"
        )
        self.cover_meta_label.set_justify(Gtk.Justification.CENTER)
        self.cover_meta_label.set_line_wrap(True)
        self.cover_meta_label.set_margin_start(8)
        cover_box.pack_start(self.cover_meta_label, False, False, 0)

        self.cover_status_label = Gtk.Label(
            label="Kein Cover geladen"
        )
        self.cover_status_label.set_line_wrap(True)
        self.cover_status_label.set_justify(Gtk.Justification.CENTER)
        self.cover_status_label.set_margin_start(8)
        self.cover_status_label.get_style_context().add_class("dim-label")
        cover_box.pack_start(self.cover_status_label, False, False, 0)

        cover_frame.add(cover_box)
        cover_event_box.add(cover_frame)
        attach_cover_image_drop_target(cover_event_box, self._on_cover_dropped)
        sidebar_box.pack_start(cover_event_box, False, False, 0)

        # Album-Metadaten-Formular (konfigurierbare MusicBrainz-Felder aus den Einstellungen)
        meta_grid = Gtk.Grid(column_spacing=8, row_spacing=6)
        self.meta_grid = meta_grid
        album_lbl, self.entry_album = self._add_form_row_widgets(meta_grid, 0, "Album:", self.album.title)
        self.entry_album.connect("focus-out-event", self._on_album_field_focus_out, "Albumtitel")
        self._left_tag_field_rows["title"] = [album_lbl, self.entry_album]

        aa_lbl, self.entry_album_artist = self._add_form_row_widgets(
            meta_grid, 1, "Album-Interpret:", self.album.album_artist or self.album.artist
        )
        self.entry_album_artist.connect("focus-out-event", self._on_artist_entry_focus_out, "Album-Interpret")
        self._left_tag_field_rows["albumArtist"] = [aa_lbl, self.entry_album_artist]

        artist_lbl = Gtk.Label(label="Künstler:")
        artist_lbl.set_xalign(0)
        artist_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.entry_artist = Gtk.Entry()
        self.entry_artist.set_text(self.album.artist)
        self.entry_artist.set_hexpand(True)
        self.entry_artist.connect("focus-out-event", self._on_artist_entry_focus_out, "Künstler")
        artist_row.pack_start(self.entry_artist, True, True, 0)

        self.apply_artist_btn = Gtk.Button()
        self.apply_artist_btn.add(make_system_icon("apply_arrow"))
        self.apply_artist_btn.set_tooltip_text(
            "Künstler auf die aktiv markierten Titel in der Titel- und Metadatenspalte übertragen"
        )
        self.apply_artist_btn.connect("clicked", self._on_apply_artist_to_all_clicked)
        artist_row.pack_start(self.apply_artist_btn, False, False, 0)
        self._left_field_transfer_buttons.append(self.apply_artist_btn)

        meta_grid.attach(artist_lbl, 0, 2, 1, 1)
        meta_grid.attach(artist_row, 1, 2, 1, 1)
        self._left_tag_field_rows["artist"] = [artist_lbl, artist_row]

        # Klassikalbum-Zusatzfelder (Komponist, Orchester, Dirigent + Zuordnungs-Pfeil pro Feld)
        self.classical_frame = Gtk.Frame(label="Klassikalbum-Tags")
        self.classical_frame.set_no_show_all(True)
        classical_grid = Gtk.Grid(column_spacing=8, row_spacing=6)
        classical_grid.set_border_width(8)

        comp_lbl = Gtk.Label(label="Komponist:")
        comp_lbl.set_xalign(0)
        comp_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.entry_composer = Gtk.Entry()
        self.entry_composer.set_hexpand(True)
        self.entry_composer.set_placeholder_text("z. B. Ludwig van Beethoven (; für mehrere)")
        self.entry_composer.set_tooltip_text("Mehrere Komponisten mit '; ' trennen")
        self.entry_composer.connect("focus-out-event", self._on_artist_entry_focus_out, "Komponist")
        comp_row.pack_start(self.entry_composer, True, True, 0)
        self.apply_comp_btn = Gtk.Button()
        self.apply_comp_btn.add(make_system_icon("apply_arrow"))
        self.apply_comp_btn.set_tooltip_text("Komponist den aktiv markierten Titeln in der Titel- und Metadatenspalte zuordnen")
        self.apply_comp_btn.connect("clicked", self._on_apply_composer_to_all_clicked)
        comp_row.pack_start(self.apply_comp_btn, False, False, 0)
        self._left_field_transfer_buttons.append(self.apply_comp_btn)
        classical_grid.attach(comp_lbl, 0, 0, 1, 1)
        classical_grid.attach(comp_row, 1, 0, 1, 1)
        self._classical_field_rows["composer"] = [comp_lbl, comp_row]

        orch_lbl = Gtk.Label(label="Orchester:")
        orch_lbl.set_xalign(0)
        orch_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.entry_orchestra = Gtk.Entry()
        self.entry_orchestra.set_hexpand(True)
        self.entry_orchestra.set_placeholder_text("z. B. Berliner Philharmoniker (; für mehrere)")
        self.entry_orchestra.set_tooltip_text("Mehrere Orchester mit '; ' trennen")
        self.entry_orchestra.connect("focus-out-event", self._on_artist_entry_focus_out, "Orchester")
        orch_row.pack_start(self.entry_orchestra, True, True, 0)
        self.apply_orch_btn = Gtk.Button()
        self.apply_orch_btn.add(make_system_icon("apply_arrow"))
        self.apply_orch_btn.set_tooltip_text("Orchester den aktiv markierten Titeln in der Titel- und Metadatenspalte zuordnen")
        self.apply_orch_btn.connect("clicked", self._on_apply_orchestra_to_all_clicked)
        orch_row.pack_start(self.apply_orch_btn, False, False, 0)
        self._left_field_transfer_buttons.append(self.apply_orch_btn)
        classical_grid.attach(orch_lbl, 0, 1, 1, 1)
        classical_grid.attach(orch_row, 1, 1, 1, 1)
        self._classical_field_rows["orchestra"] = [orch_lbl, orch_row]

        cond_lbl = Gtk.Label(label="Dirigent:")
        cond_lbl.set_xalign(0)
        cond_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.entry_conductor = Gtk.Entry()
        self.entry_conductor.set_hexpand(True)
        self.entry_conductor.set_placeholder_text("z. B. Herbert von Karajan (; für mehrere)")
        self.entry_conductor.set_tooltip_text("Mehrere Dirigenten mit '; ' trennen")
        self.entry_conductor.connect("focus-out-event", self._on_artist_entry_focus_out, "Dirigent")
        cond_row.pack_start(self.entry_conductor, True, True, 0)
        self.apply_cond_btn = Gtk.Button()
        self.apply_cond_btn.add(make_system_icon("apply_arrow"))
        self.apply_cond_btn.set_tooltip_text("Dirigent den aktiv markierten Titeln in der Titel- und Metadatenspalte zuordnen")
        self.apply_cond_btn.connect("clicked", self._on_apply_conductor_to_all_clicked)
        cond_row.pack_start(self.apply_cond_btn, False, False, 0)
        self._left_field_transfer_buttons.append(self.apply_cond_btn)
        classical_grid.attach(cond_lbl, 0, 2, 1, 1)
        classical_grid.attach(cond_row, 1, 2, 1, 1)
        self._classical_field_rows["conductor"] = [cond_lbl, cond_row]

        self.classical_frame.add(classical_grid)
        meta_grid.attach(self.classical_frame, 0, 3, 2, 1)

        # CD-Nummer & Gesamt-CDs (Multi-CD)
        disc_lbl = Gtk.Label(label="CD-Nr. / Gesamt:")
        disc_lbl.set_xalign(0)
        disc_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.spin_disc_number = Gtk.SpinButton.new_with_range(1, 99, 1)
        self.spin_disc_number.set_numeric(False)
        self.spin_disc_number.set_value(self.album.disc_number)
        self.spin_disc_number.connect("output", self._on_disc_spin_output)
        self.spin_disc_number.connect("value-changed", lambda _s: self._on_disc_values_changed())
        disc_row.pack_start(self.spin_disc_number, False, False, 0)

        disc_of_lbl = Gtk.Label(label="von")
        disc_row.pack_start(disc_of_lbl, False, False, 0)

        self.spin_total_discs = Gtk.SpinButton.new_with_range(1, 99, 1)
        self.spin_total_discs.set_value(self.album.total_discs)
        self.spin_total_discs.connect("value-changed", lambda _s: self._on_total_discs_changed())
        disc_row.pack_start(self.spin_total_discs, False, False, 0)

        self.load_disc_btn = Gtk.Button(label="CD laden")
        self.load_disc_btn.set_no_show_all(True)
        self.load_disc_btn.set_tooltip_text("Trackliste der gewählten CD-Nummer von MusicBrainz laden")
        self.load_disc_btn.connect("clicked", self._on_load_selected_disc_clicked)
        disc_row.pack_end(self.load_disc_btn, False, False, 0)

        meta_grid.attach(disc_lbl, 0, 4, 1, 1)
        meta_grid.attach(disc_row, 1, 4, 1, 1)
        self._left_tag_field_rows["discNumber"] = [disc_lbl, disc_row]

        self.multi_disc_label = Gtk.Label()
        self.multi_disc_label.set_xalign(0)
        self.multi_disc_label.set_line_wrap(True)
        self.multi_disc_label.set_no_show_all(True)
        meta_grid.attach(self.multi_disc_label, 0, 5, 2, 1)

        year_lbl, self.entry_year = self._add_form_row_widgets(meta_grid, 6, "Jahr:", "")
        self.entry_year.connect("focus-out-event", self._on_album_field_focus_out, "Jahr")
        self._left_tag_field_rows["year"] = [year_lbl, self.entry_year]

        genre_lbl = Gtk.Label(label="Genre:")
        genre_lbl.set_xalign(0)
        genre_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.entry_genre = Gtk.Entry()
        self.entry_genre.set_hexpand(True)
        self.entry_genre.set_tooltip_text("Mehrere Genres mit '; ' trennen (z. B. Electro; Synth-Pop)")
        self.entry_genre.set_placeholder_text("z. B. Rock; Electronic")
        self.entry_genre.connect("focus-out-event", self._on_album_field_focus_out, "Genre")
        genre_row.pack_start(self.entry_genre, True, True, 0)

        self.apply_genre_btn = Gtk.Button()
        self.apply_genre_btn.add(make_system_icon("apply_arrow"))
        self.apply_genre_btn.set_tooltip_text(
            "Genre auf alle aktiv markierten Einzeltracks übertragen"
        )
        self.apply_genre_btn.connect("clicked", self._on_apply_genre_to_all_clicked)
        genre_row.pack_start(self.apply_genre_btn, False, False, 0)
        self._left_field_transfer_buttons.append(self.apply_genre_btn)

        meta_grid.attach(genre_lbl, 0, 7, 1, 1)
        meta_grid.attach(genre_row, 1, 7, 1, 1)
        self._left_tag_field_rows["genre"] = [genre_lbl, genre_row]

        label_lbl, self.entry_label = self._add_form_row_widgets(meta_grid, 8, "Label:", "")
        self.entry_label.connect("focus-out-event", self._on_album_field_focus_out, "Label")
        self._left_tag_field_rows["label"] = [label_lbl, self.entry_label]

        cddb_lbl, self.entry_cddb_id = self._add_form_row_widgets(meta_grid, 9, "CDDB DiscID:", "")
        self.entry_cddb_id.set_placeholder_text("8-stellige Hex-DiscID")
        self.entry_cddb_id.connect("focus-out-event", self._on_album_field_focus_out, "CDDB-DiscID")
        self._left_tag_field_rows["cddbId"] = [cddb_lbl, self.entry_cddb_id]

        mbid_lbl, self.entry_mbid = self._add_form_row_widgets(meta_grid, 10, "MBID:", "")
        self.entry_mbid.connect("focus-out-event", self._on_album_field_focus_out, "MusicBrainz-ID")
        self._left_tag_field_rows["musicbrainzReleaseId"] = [mbid_lbl, self.entry_mbid]

        discogs_lbl = Gtk.Label(label="Discogs-ID:")
        discogs_lbl.set_xalign(0)
        discogs_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.entry_discogs_id = Gtk.Entry()
        self.entry_discogs_id.set_hexpand(True)
        self.entry_discogs_id.set_placeholder_text("z. B. [r524030] oder 524030")
        self.entry_discogs_id.connect("focus-out-event", self._on_album_field_focus_out, "Discogs Release-ID")
        self.entry_discogs_id.connect("activate", self._on_lookup_discogs_entry_activated)
        discogs_row.pack_start(self.entry_discogs_id, True, True, 0)
        discogs_apply_btn = Gtk.Button()
        discogs_apply_btn.add(make_system_icon("apply_arrow"))
        discogs_apply_btn.set_tooltip_text("Albuminformationen anhand dieser Discogs Release-/Master-ID abrufen")
        discogs_apply_btn.connect("clicked", lambda _b: self._on_lookup_discogs_entry_activated(self.entry_discogs_id))
        discogs_row.pack_start(discogs_apply_btn, False, False, 0)
        meta_grid.attach(discogs_lbl, 0, 11, 1, 1)
        meta_grid.attach(discogs_row, 1, 11, 1, 1)
        self._left_tag_field_rows["discogsId"] = [discogs_lbl, discogs_row]

        asin_lbl, self.entry_asin = self._add_form_row_widgets(meta_grid, 12, "Amazon ASIN:", "")
        self.entry_asin.set_placeholder_text("Optional: 10-stellige ASIN (z. B. B000002U82)")
        self.entry_asin.connect("focus-out-event", self._on_album_field_focus_out, "Amazon ASIN")
        self._left_tag_field_rows["asin"] = [asin_lbl, self.entry_asin]

        bc_lbl = Gtk.Label(label="Barcode / QR:")
        bc_lbl.set_xalign(0)
        bc_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.entry_barcode = Gtk.Entry()
        self.entry_barcode.set_hexpand(True)
        self.entry_barcode.set_placeholder_text("EAN-13 / UPC / QR-Code")
        self.entry_barcode.connect("focus-out-event", self._on_album_field_focus_out, "Barcode / EAN")
        self.entry_barcode.connect("activate", self._on_lookup_barcode_entry_activated)
        bc_row.pack_start(self.entry_barcode, True, True, 0)

        bc_apply_btn = Gtk.Button()
        bc_apply_btn.add(make_system_icon("apply_arrow"))
        bc_apply_btn.set_tooltip_text("Albuminformationen anhand dieses Barcodes / QR-Codes abrufen")
        bc_apply_btn.connect("clicked", lambda _b: self._on_lookup_barcode_entry_activated(self.entry_barcode))
        bc_row.pack_start(bc_apply_btn, False, False, 0)

        self.bc_scan_inline_btn = Gtk.Button()
        self.bc_scan_inline_btn.add(make_system_icon("barcode_qr"))
        self.bc_scan_inline_btn.set_tooltip_text("Barcode oder QR-Code mit der Webcam einlesen")
        self.bc_scan_inline_btn.connect("clicked", self._on_scan_barcode_clicked)
        bc_row.pack_start(self.bc_scan_inline_btn, False, False, 0)

        meta_grid.attach(bc_lbl, 0, 13, 1, 1)
        meta_grid.attach(bc_row, 1, 13, 1, 1)
        self._left_tag_field_rows["barcode"] = [bc_lbl, bc_row]

        # Optionale konfigurierbare MusicBrainz-Tags dynamisch unterhalb anhängen
        dyn_row_idx = 14
        for spec in MUSICBRAINZ_LEFT_TAG_FIELDS:
            fid = str(spec["id"])
            if spec.get("default_visible") or fid in ("composer", "orchestra", "conductor"):
                continue
            f_lbl = Gtk.Label(label=f"{spec['label']}:")
            f_lbl.set_xalign(0)
            f_lbl.set_tooltip_text(f"MusicBrainz-Tag: {spec['mb_tag']}")
            f_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
            f_entry = Gtk.Entry()
            f_entry.set_hexpand(True)
            if spec.get("placeholder"):
                f_entry.set_placeholder_text(str(spec["placeholder"]))
            normalize_people = spec.get("category") == "credits" and fid != "work"
            if normalize_people:
                f_entry.connect("focus-out-event", self._on_artist_entry_focus_out, str(spec["label"]))
            else:
                f_entry.connect("focus-out-event", self._on_album_field_focus_out, str(spec["label"]))
            f_row.pack_start(f_entry, True, True, 0)

            transfer_key = spec.get("track_transfer_key")
            if transfer_key:
                t_btn = Gtk.Button()
                t_btn.add(make_system_icon("apply_arrow"))
                t_btn.set_tooltip_text(
                    f"{spec['label']} auf die aktiv markierten Titel in der Titelliste übertragen"
                )
                t_btn.connect(
                    "clicked",
                    lambda _b, f_id=fid, tk=str(transfer_key), lbl_s=str(spec["label"]), np=normalize_people: self._apply_album_field_to_selected_tracks(
                        f_id, tk, lbl_s, np
                    ),
                )
                f_row.pack_start(t_btn, False, False, 0)
                self._left_field_transfer_buttons.append(t_btn)

            meta_grid.attach(f_lbl, 0, dyn_row_idx, 1, 1)
            meta_grid.attach(f_row, 1, dyn_row_idx, 1, 1)
            self._dynamic_left_entries[fid] = f_entry
            self._left_tag_field_rows[fid] = [f_lbl, f_row]
            dyn_row_idx += 1

        sidebar_box.pack_start(meta_grid, False, False, 0)

        # Mittlerer & Rechter Arbeitsbereich: Gtk.Paned wie bei Spalte 1 (Mitte = 3 Display-Boxen bzw. Cover-Ergebnistabelle, Rechts = frei skalierbare & ein-/ausklappbare 3. Spalte für Track-Felder in Modul 2 & 3)
        self.right_paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self.right_paned.set_wide_handle(True)
        self.right_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        self.right_box.set_border_width(10)
        self.right_paned.pack1(self.right_box, resize=True, shrink=True)
        outer_paned.pack2(self.right_paned, resize=True, shrink=True)

        # --- Inline Cover-Ergebnistabelle für Modul 1 ("Coverbild beziehen") direkt unterhalb der Suchleiste ---
        self.cover_results_frame = Gtk.Frame()
        self.cover_results_frame.set_shadow_type(Gtk.ShadowType.IN)
        self.cover_results_frame.get_style_context().add_class("display-box")
        self.cover_results_frame.set_no_show_all(True)
        cover_res_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        cover_res_vbox.set_border_width(10)

        cover_res_hdr_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        cover_res_hdr_row.pack_start(make_system_icon("cover_image"), False, False, 0)
        cover_res_title_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self.cover_results_title_label = Gtk.Label()
        self.cover_results_title_label.set_xalign(0)
        self.cover_results_title_label.set_markup(
            "<b>Online-Cover-Auswahl — 0 Treffer aus allen Providern</b>"
        )
        self.cover_results_sub_label = Gtk.Label()
        self.cover_results_sub_label.set_xalign(0)
        self.cover_results_sub_label.get_style_context().add_class("dim-label")
        self.cover_results_sub_label.set_markup(
            "<span size='small'>Abgefragte Quellen: Alle in den Einstellungen aktivierten Bilddatenbanken — Klick auf Vorschaubild öffnet Großansicht</span>"
        )
        cover_res_title_box.pack_start(self.cover_results_title_label, False, False, 0)
        cover_res_title_box.pack_start(self.cover_results_sub_label, False, False, 0)
        cover_res_hdr_row.pack_start(cover_res_title_box, True, True, 0)

        self.cover_results_refresh_btn = Gtk.Button(label="Erneut abfragen")
        self.cover_results_refresh_btn.connect(
            "clicked", lambda _b: self._start_online_cover_search()
        )
        cover_res_hdr_row.pack_end(self.cover_results_refresh_btn, False, False, 0)
        cover_res_vbox.pack_start(cover_res_hdr_row, False, False, 0)
        cover_res_vbox.pack_start(
            Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0
        )

        self.cover_results_scroll = Gtk.ScrolledWindow()
        self.cover_results_scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        self.cover_results_scroll.set_vexpand(True)

        self.cover_results_grid = Gtk.Grid()
        self.cover_results_grid.set_column_spacing(12)
        self.cover_results_grid.set_row_spacing(8)
        self.cover_results_grid.set_border_width(6)
        self.cover_results_scroll.add(self.cover_results_grid)
        cover_res_vbox.pack_start(self.cover_results_scroll, True, True, 0)

        self.cover_results_frame.add(cover_res_vbox)
        self.right_box.pack_start(self.cover_results_frame, True, True, 0)
        self._populate_inline_cover_candidates([])

        # --- Display 1: Albenliste ---
        self.hits_frame_box = Gtk.Frame()
        self.hits_frame_box.set_shadow_type(Gtk.ShadowType.IN)
        self.hits_frame_box.get_style_context().add_class("display-box")
        hits_card_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        self.hits_summary_btn = Gtk.Button()
        self.hits_summary_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.hits_summary_btn.get_style_context().add_class("display-summary")
        hits_sum_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        hits_sum_row.pack_start(make_system_icon("search_online"), False, False, 0)
        self.hits_summary_label = Gtk.Label()
        self.hits_summary_label.set_markup("<b>Albenliste</b>")
        self.hits_summary_label.set_xalign(0)
        hits_sum_row.pack_start(self.hits_summary_label, True, True, 0)
        self.hits_toggle_glyph = Gtk.Label(label="+")
        self.hits_toggle_glyph.get_style_context().add_class("display-glyph")
        hits_sum_row.pack_end(self.hits_toggle_glyph, False, False, 0)
        self.hits_summary_btn.add(hits_sum_row)
        self.hits_summary_btn.connect("clicked", lambda _b: self._on_display_header_clicked("hits"))
        hits_card_vbox.pack_start(self.hits_summary_btn, False, False, 0)

        self.hits_header_sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        self.hits_header_sep.set_no_show_all(True)
        hits_card_vbox.pack_start(self.hits_header_sep, False, False, 0)

        self.hits_body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.hits_body.set_border_width(10)
        self.hits_body.set_no_show_all(True)

        # Trefferliste (Gefundene Alben aus MusicBrainz, CDDB & Discogs zur manuellen Auswahl)
        self.hits_frame = Gtk.Frame(
            label="Gefundene Alben — Trefferliste (Bitte das korrekte Album auswählen und laden)"
        )
        hits_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        hits_vbox.set_border_width(8)

        # Spalten: 0=idx(int), 1=Datenbank, 2=Methode, 3=Album & Interpret (Markup), 4=Jahr/Land, 5=Label/Kat.-Nr., 6=Tracks/CDs, 7=Score
        self.hits_store = Gtk.ListStore(int, str, str, str, str, str, str, str)
        self.hits_treeview = Gtk.TreeView(model=self.hits_store)
        self.hits_treeview.set_headers_visible(True)
        self.hits_treeview.set_grid_lines(Gtk.TreeViewGridLines.BOTH)
        self.hits_treeview.get_selection().set_mode(Gtk.SelectionMode.SINGLE)
        self.hits_treeview.get_selection().connect("changed", self._on_hit_selection_changed)
        self.hits_treeview.connect("row-activated", self._on_hit_row_activated)

        for col_idx, col_title, min_w, is_markup, expand, ellipsize in (
            (1, "Datenbank", 80, False, False, False),
            (2, "Methode", 85, False, False, True),
            (3, "Album & Interpret", 140, True, True, True),
            (4, "Jahr / Land", 75, False, False, True),
            (5, "Label / Kat.-Nr.", 95, False, True, True),
            (6, "Umfang", 80, False, False, True),
            (7, "Score", 50, False, False, False),
        ):
            renderer = Gtk.CellRendererText()
            if ellipsize:
                renderer.set_property("ellipsize", Pango.EllipsizeMode.END)
            if is_markup:
                col = Gtk.TreeViewColumn(col_title, renderer, markup=col_idx)
            else:
                col = Gtk.TreeViewColumn(col_title, renderer, text=col_idx)
            col.set_resizable(True)
            col.set_min_width(min_w)
            col.set_expand(expand)
            self.hits_treeview.append_column(col)

        hits_scroll = Gtk.ScrolledWindow()
        hits_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        hits_scroll.set_overlay_scrolling(False)
        hits_scroll.set_shadow_type(Gtk.ShadowType.IN)
        hits_scroll.set_min_content_height(155)
        hits_scroll.add(self.hits_treeview)

        self.hits_overlay = Gtk.Overlay()
        self.hits_overlay.add(hits_scroll)

        self.hits_search_overlay_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        self.hits_search_overlay_box.get_style_context().add_class("cover-loading-overlay")
        self.hits_search_overlay_box.set_halign(Gtk.Align.FILL)
        self.hits_search_overlay_box.set_valign(Gtk.Align.FILL)
        hits_overlay_center = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        hits_overlay_center.set_halign(Gtk.Align.CENTER)
        hits_overlay_center.set_valign(Gtk.Align.CENTER)

        self.hits_search_spinner_area = Gtk.DrawingArea()
        self.hits_search_spinner_area.set_size_request(52, 52)
        self.hits_search_spinner_area.set_halign(Gtk.Align.CENTER)
        self.hits_search_spinner_area.connect("draw", self._on_draw_slow_spinner)
        hits_overlay_center.pack_start(self.hits_search_spinner_area, False, False, 0)

        self.hits_overlay_title_label = Gtk.Label()
        self.hits_overlay_title_label.set_markup("<b>CD wird eingelesen &amp; Alben werden abgefragt…</b>")
        hits_overlay_center.pack_start(self.hits_overlay_title_label, False, False, 0)

        self.hits_overlay_sub_label = Gtk.Label()
        self.hits_overlay_sub_label.set_markup(
            "<span size='small'>MusicBrainz · Discogs · CDDB / GnuDB</span>"
        )
        hits_overlay_center.pack_start(self.hits_overlay_sub_label, False, False, 0)

        self.hits_search_overlay_box.pack_start(hits_overlay_center, True, True, 0)
        self.hits_search_overlay_box.set_no_show_all(True)
        self.hits_search_overlay_box.hide()
        self.hits_overlay.add_overlay(self.hits_search_overlay_box)
        self.hits_dnd_overlay_box = self._build_dnd_overlay_box(
            "Album-Ordner hier ablegen",
            "Aktuelle Liste wird geleert &amp; Online-Abfrage gestartet",
        )
        self.hits_overlay.add_overlay(self.hits_dnd_overlay_box)
        self.hits_overlay.set_overlay_pass_through(self.hits_dnd_overlay_box, True)
        hits_vbox.pack_start(self.hits_overlay, True, True, 0)

        hits_action_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.hits_status_label = Gtk.Label(
            label="Noch keine Trefferliste geladen. Suchbegriff oben eingeben oder CD einlesen."
        )
        self.hits_status_label.set_xalign(0)
        self.hits_status_label.set_ellipsize(Pango.EllipsizeMode.END)
        self.hits_status_label.get_style_context().add_class("dim-label")
        hits_action_row.pack_start(self.hits_status_label, True, True, 0)

        hits_vbox.pack_start(hits_action_row, False, False, 0)
        self.hits_frame.add(hits_vbox)
        self.hits_body.pack_start(self.hits_frame, True, True, 0)

        # Modul 3: Drag & Drop auch in der Albenliste (leichtes Overlay mit Icon -> Liste leeren + automatische Online-Abfrage)
        self._dnd_hide_timers: dict[str, int] = {}
        on_hits_hover = lambda active: self._set_module3_dnd_overlay("hits", active)
        attach_audio_file_drop_target(self.hits_body, self._on_hits_audio_files_dropped, on_drag_hover=on_hits_hover)
        attach_audio_file_drop_target(hits_scroll, self._on_hits_audio_files_dropped, on_drag_hover=on_hits_hover)
        attach_audio_file_drop_target(self.hits_treeview, self._on_hits_audio_files_dropped, on_drag_hover=on_hits_hover)

        hits_card_vbox.pack_start(self.hits_body, True, True, 0)
        self.hits_frame_box.add(hits_card_vbox)
        self.right_box.pack_start(self.hits_frame_box, False, False, 0)

        # --- Display 2: Titel- & Metadaten-Verwaltung ---
        self.track_frame_box = Gtk.Frame()
        self.track_frame_box.set_shadow_type(Gtk.ShadowType.IN)
        self.track_frame_box.get_style_context().add_class("display-box")
        track_card_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        self.track_summary_btn = Gtk.Button()
        self.track_summary_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.track_summary_btn.get_style_context().add_class("display-summary")
        track_sum_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        track_sum_row.pack_start(make_system_icon("audio_track"), False, False, 0)
        self.track_header_label = Gtk.Label()
        self.track_header_label.set_markup("<b>Titel- &amp; Metadaten-Verwaltung (WAV/FLAC hierher ziehen)</b>")
        self.track_header_label.set_xalign(0)
        track_sum_row.pack_start(self.track_header_label, True, True, 0)
        self.track_toggle_glyph = Gtk.Label(label="−")
        self.track_toggle_glyph.get_style_context().add_class("display-glyph")
        track_sum_row.pack_end(self.track_toggle_glyph, False, False, 0)
        self.track_summary_btn.add(track_sum_row)
        self.track_summary_btn.connect("clicked", lambda _b: self._on_display_header_clicked("tracks"))
        track_card_vbox.pack_start(self.track_summary_btn, False, False, 0)

        self.track_header_sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        self.track_header_sep.set_no_show_all(True)
        track_card_vbox.pack_start(self.track_header_sep, False, False, 0)

        # Einklappbarer Inhaltsbereich von Display 2 ("Titel- & Metadaten-Verwaltung")
        self.track_body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.track_body.set_border_width(10)
        self.track_body.set_no_show_all(True)

        # Häkchen zum Auswählen aller Titel linksbündig + Shazam-Batch-Schaltfläche rechts
        select_all_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.select_all_check = Gtk.CheckButton(label="Alle auswählen / abwählen")
        self.select_all_check.set_tooltip_text("Schaltet alle Titel in der Liste gleichzeitig ein oder aus")
        self.select_all_check.connect("toggled", self._on_select_all_toggled)
        select_all_row.pack_start(self.select_all_check, False, False, 0)

        self.single_disc_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.single_disc_box.set_no_show_all(True)
        self.single_disc_box.hide()
        select_all_row.pack_start(self.single_disc_box, False, False, 0)

        self.analyze_tracks_btn = Gtk.MenuButton()
        analyze_tracks_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        analyze_tracks_box.pack_start(make_system_icon("search_online"), False, False, 0)
        self.analyze_tracks_label = Gtk.Label(label="Markierte Tracks analysieren")
        analyze_tracks_box.pack_start(self.analyze_tracks_label, False, False, 0)
        analyze_tracks_box.pack_start(Gtk.Label(label="▾"), False, False, 0)
        analyze_tracks_box.show_all()
        self.analyze_tracks_btn.add(analyze_tracks_box)
        self.analyze_tracks_btn.set_tooltip_text(
            "Per Checkbox ausgewählte Titel einzeln mit MusicBrainz (+ Wikidata-Genre) oder Shazam analysieren"
        )

        analyze_tracks_menu = Gtk.Menu()
        mi_analyze_mb = Gtk.MenuItem(label="Mit Musikbrainz analysieren")
        mi_analyze_mb.connect("activate", self._on_analyze_mb_tracks_clicked)
        analyze_tracks_menu.append(mi_analyze_mb)
        mi_analyze_shazam = Gtk.MenuItem(label="Mit Shazam analysieren")
        mi_analyze_shazam.connect("activate", self._on_shazam_all_tracks_clicked)
        analyze_tracks_menu.append(mi_analyze_shazam)
        analyze_tracks_menu.show_all()
        self.analyze_tracks_btn.set_popup(analyze_tracks_menu)
        select_all_row.pack_end(self.analyze_tracks_btn, False, False, 0)

        self.mb_tracks_stop_btn = Gtk.Button()
        mb_stop_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        mb_stop_box.pack_start(make_system_icon("stop_batch"), False, False, 0)
        mb_stop_box.pack_start(Gtk.Label(label="Musikbrainz stoppen"), False, False, 0)
        self.mb_tracks_stop_btn.add(mb_stop_box)
        self.mb_tracks_stop_btn.get_style_context().add_class("destructive-action")
        self.mb_tracks_stop_btn.set_tooltip_text(
            "Stoppt die laufende MusicBrainz-Einzeltrackanalyse sofort. Bereits erkannte Treffer bleiben erhalten."
        )
        self.mb_tracks_stop_btn.connect("clicked", self._on_stop_mb_tracks_clicked)
        self.mb_tracks_stop_btn.set_no_show_all(True)
        self.mb_tracks_stop_btn.hide()
        select_all_row.pack_end(self.mb_tracks_stop_btn, False, False, 0)

        self.shazam_stop_btn = Gtk.Button()
        shazam_stop_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        shazam_stop_box.pack_start(make_system_icon("stop_batch"), False, False, 0)
        shazam_stop_box.pack_start(Gtk.Label(label="Shazam stoppen"), False, False, 0)
        self.shazam_stop_btn.add(shazam_stop_box)
        self.shazam_stop_btn.get_style_context().add_class("destructive-action")
        self.shazam_stop_btn.set_tooltip_text(
            "Stoppt die laufende Shazam-Abfrage sofort. Bereits gefundene Treffer bleiben erhalten."
        )
        self.shazam_stop_btn.connect("clicked", self._on_stop_shazam_clicked)
        self.shazam_stop_btn.set_no_show_all(True)
        self.shazam_stop_btn.hide()
        select_all_row.pack_end(self.shazam_stop_btn, False, False, 0)

        self.verify_conductor_btn = Gtk.Button()
        verify_cond_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        verify_cond_box.pack_start(make_system_icon("verify_artists"), False, False, 0)
        self.verify_conductor_label = Gtk.Label(label="Dirigent prüfen")
        verify_cond_box.pack_start(self.verify_conductor_label, False, False, 0)
        self.verify_conductor_btn.add(verify_cond_box)
        self.verify_conductor_btn.set_tooltip_text(
            "Prüft Dirigenten der ausgewählten Titel (;-getrennte Mehrfachwerte) online (MusicBrainz & Wikidata), korrigiert Schreibfehler und internationalisiert Namen"
        )
        self.verify_conductor_btn.connect("clicked", self._on_verify_field_clicked, "conductor")
        self.verify_conductor_btn.set_no_show_all(True)
        select_all_row.pack_end(self.verify_conductor_btn, False, False, 0)

        self.verify_orchestra_btn = Gtk.Button()
        verify_orch_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        verify_orch_box.pack_start(make_system_icon("verify_orchestra"), False, False, 0)
        self.verify_orchestra_label = Gtk.Label(label="Orchester prüfen")
        verify_orch_box.pack_start(self.verify_orchestra_label, False, False, 0)
        self.verify_orchestra_btn.add(verify_orch_box)
        self.verify_orchestra_btn.set_tooltip_text(
            "Prüft Orchester der ausgewählten Titel (;-getrennte Mehrfachwerte) online (MusicBrainz & Wikidata), korrigiert Schreibfehler und internationalisiert Namen"
        )
        self.verify_orchestra_btn.connect("clicked", self._on_verify_field_clicked, "orchestra")
        self.verify_orchestra_btn.set_no_show_all(True)
        select_all_row.pack_end(self.verify_orchestra_btn, False, False, 0)

        self.verify_composer_btn = Gtk.Button()
        verify_comp_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        verify_comp_box.pack_start(make_system_icon("verify_artists"), False, False, 0)
        self.verify_composer_label = Gtk.Label(label="Komponist prüfen")
        verify_comp_box.pack_start(self.verify_composer_label, False, False, 0)
        self.verify_composer_btn.add(verify_comp_box)
        self.verify_composer_btn.set_tooltip_text(
            "Prüft Komponisten der ausgewählten Titel (;-getrennte Mehrfachwerte) online (MusicBrainz & Wikidata), korrigiert Schreibfehler und internationalisiert Namen"
        )
        self.verify_composer_btn.connect("clicked", self._on_verify_field_clicked, "composer")
        self.verify_composer_btn.set_no_show_all(True)
        select_all_row.pack_end(self.verify_composer_btn, False, False, 0)

        self.verify_artists_btn = Gtk.Button()
        verify_art_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        verify_art_box.pack_start(make_system_icon("verify_artists"), False, False, 0)
        self.verify_artists_label = Gtk.Label(label="Interpreten prüfen")
        verify_art_box.pack_start(self.verify_artists_label, False, False, 0)
        self.verify_artists_btn.add(verify_art_box)
        self.verify_artists_btn.set_tooltip_text(
            "Prüft Interpretennamen der ausgewählten Titel (;-getrennte Mehrfachwerte) online (MusicBrainz & Wikidata), korrigiert Schreibfehler und erzwingt internationalisierte Künstlernamen"
        )
        self.verify_artists_btn.connect("clicked", self._on_verify_field_clicked, "artist")
        select_all_row.pack_end(self.verify_artists_btn, False, False, 0)

        self.verify_stop_btn = Gtk.Button()
        verify_stop_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        verify_stop_box.pack_start(make_system_icon("stop_batch"), False, False, 0)
        verify_stop_box.pack_start(Gtk.Label(label="Abfrage stoppen"), False, False, 0)
        self.verify_stop_btn.add(verify_stop_box)
        self.verify_stop_btn.get_style_context().add_class("destructive-action")
        self.verify_stop_btn.set_tooltip_text(
            "Stoppt die laufende Online-Prüfung sofort (z. B. bei MusicBrainz Rate-Limit). Bereits geprüfte Ergebnisse bleiben erhalten."
        )
        self.verify_stop_btn.connect("clicked", self._on_stop_verify_clicked)
        self.verify_stop_btn.set_no_show_all(True)
        self.verify_stop_btn.hide()
        select_all_row.pack_end(self.verify_stop_btn, False, False, 0)

        self.split_artists_btn = Gtk.Button()
        split_art_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        split_art_box.pack_start(make_system_icon("split_artists"), False, False, 0)
        split_art_box.pack_start(Gtk.Label(label="Interpretensplitter"), False, False, 0)
        self.split_artists_btn.add(split_art_box)
        self.split_artists_btn.set_tooltip_text(
            "Trennt verkettete Interpreten in den ausgewählten Titeln (z. B. „A, B & C“ → „A; B; C“ unter Schutz echter Bandnamen) und übernimmt Feature-Zusätze wie „(feat. X & Y)“ aus Titeln ins Interpretenfeld"
        )
        self.split_artists_btn.connect("clicked", self._on_split_artists_clicked)
        select_all_row.pack_end(self.split_artists_btn, False, False, 0)

        self.track_body.pack_start(select_all_row, False, False, 0)

        # Spaltenköpfe für die Track-Tabelle (mit SizeGroups für saubere Spaltenausrichtung ohne horizontalen Überlauf)
        self._sg_health = Gtk.SizeGroup(mode=Gtk.SizeGroupMode.HORIZONTAL)
        self._sg_num = Gtk.SizeGroup(mode=Gtk.SizeGroupMode.HORIZONTAL)
        self._sg_title = Gtk.SizeGroup(mode=Gtk.SizeGroupMode.HORIZONTAL)
        self._sg_artist = Gtk.SizeGroup(mode=Gtk.SizeGroupMode.HORIZONTAL)
        self._sg_dur = Gtk.SizeGroup(mode=Gtk.SizeGroupMode.HORIZONTAL)
        self._sg_preview = Gtk.SizeGroup(mode=Gtk.SizeGroupMode.HORIZONTAL)

        col_header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        col_header.set_margin_start(6)
        col_header.set_margin_end(6)

        spacer_lbl = Gtk.Label(label="")
        spacer_lbl.set_width_chars(5)
        col_header.pack_start(spacer_lbl, False, False, 0)

        self.hdr_health = Gtk.Label(label="")
        self.hdr_health.set_xalign(0.5)
        self.hdr_health.set_size_request(18, -1)
        self.hdr_health.set_tooltip_text(
            "Dateizustand (Farbcode wie Modul 5) — erneute Prüfung & Reparatur erfolgt in Modul 5"
        )
        self.hdr_health.set_no_show_all(True)
        self.hdr_health.set_visible(False)
        self._sg_health.add_widget(self.hdr_health)
        col_header.pack_start(self.hdr_health, False, False, 0)

        self.hdr_num = Gtk.Label()
        self.hdr_num.set_markup("<b>#</b>")
        self.hdr_num.set_xalign(0)
        self.hdr_num.set_width_chars(4)
        self._sg_num.add_widget(self.hdr_num)
        col_header.pack_start(self.hdr_num, False, False, 0)

        hdr_title = Gtk.Label()
        hdr_title.set_markup("<b>Titel</b>")
        hdr_title.set_xalign(0)
        self._sg_title.add_widget(hdr_title)
        col_header.pack_start(hdr_title, True, True, 0)

        self.hdr_artist = Gtk.Label()
        self.hdr_artist.set_markup("<b>Interpret (; getrennt)</b>")
        self.hdr_artist.set_xalign(0)
        self.hdr_artist.set_ellipsize(Pango.EllipsizeMode.END)
        self._sg_artist.add_widget(self.hdr_artist)
        col_header.pack_start(self.hdr_artist, True, True, 0)

        hdr_dur = Gtk.Label()
        hdr_dur.set_markup("<b>Länge</b>")
        hdr_dur.set_xalign(1.0)
        hdr_dur.set_width_chars(6)
        self._sg_dur.add_widget(hdr_dur)
        col_header.pack_start(hdr_dur, False, False, 0)

        hdr_preview = Gtk.Label()
        hdr_preview.set_markup("<b>Vorhören</b>")
        hdr_preview.set_xalign(0.5)
        self._sg_preview.add_widget(hdr_preview)
        col_header.pack_start(hdr_preview, False, False, 0)

        self.track_body.pack_start(col_header, False, False, 0)

        track_drop_box = Gtk.EventBox()
        track_scroll = Gtk.ScrolledWindow()
        track_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        track_scroll.set_overlay_scrolling(False)
        self.track_listbox = Gtk.ListBox()
        self.track_listbox.set_selection_mode(Gtk.SelectionMode.NONE)
        track_scroll.add(self.track_listbox)
        self.track_overlay = Gtk.Overlay()
        self.track_overlay.add(track_scroll)
        self.track_dnd_overlay_box = self._build_dnd_overlay_box(
            "Album-Ordner hier ablegen",
            "Aktuelle Liste wird geleert &amp; Titel werden geladen",
        )
        self.track_overlay.add_overlay(self.track_dnd_overlay_box)
        self.track_overlay.set_overlay_pass_through(self.track_dnd_overlay_box, True)
        track_drop_box.add(self.track_overlay)
        on_track_hover = lambda active: self._set_module3_dnd_overlay("tracks", active)
        attach_audio_file_drop_target(track_drop_box, self._on_audio_files_dropped, on_drag_hover=on_track_hover)
        attach_audio_file_drop_target(track_scroll, self._on_audio_files_dropped, on_drag_hover=on_track_hover)
        attach_audio_file_drop_target(self.track_listbox, self._on_audio_files_dropped, on_drag_hover=on_track_hover)
        self.track_body.pack_start(track_drop_box, True, True, 0)

        # Fußzeile von Display 2: Optionaler WAV->FLAC Konvertierungs-Schalter in Modul 3 + Aktion
        self.convert_local_flac_chk = Gtk.CheckButton(
            label="In FLAC umwandeln (2-Schritt: erst nach WAV, danach nach FLAC · Bitraten exakt · Tags & Cover beibehalten)"
        )
        self.convert_local_flac_chk.set_active(False)
        self.convert_local_flac_chk.set_no_show_all(True)
        self.convert_local_flac_chk.set_visible(False)
        self.convert_local_flac_chk.set_tooltip_text(
            "Konvertiert importierte Audiodateien in Modul 3 zuerst sauber in unkomprimiertes WAV und kodiert anschließend nach FLAC, sodass die Bitraten exakt stimmen und alle Tags sowie das Cover erhalten bleiben."
        )
        self.convert_local_flac_chk.connect("toggled", lambda _w: self._update_rip_or_tag_button_mode())
        self.track_body.pack_start(self.convert_local_flac_chk, False, False, 0)

        track_action_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.track_action_hint = Gtk.Label(
            label="Ausgewählte Titel rippen / konvertieren und in die Stapelverarbeitung übergeben (rechts unten)."
        )
        self.track_action_hint.set_xalign(0)
        self.track_action_hint.set_ellipsize(Pango.EllipsizeMode.END)
        self.track_action_hint.get_style_context().add_class("dim-label")
        track_action_row.pack_start(self.track_action_hint, True, True, 0)
        self.track_body.pack_start(track_action_row, False, False, 0)

        track_card_vbox.pack_start(self.track_body, True, True, 0)
        self.track_frame_box.add(track_card_vbox)
        self.right_box.pack_start(self.track_frame_box, True, True, 0)

        # --- Display 3: Stapelverarbeitung (Batch Queue) ---
        self.batch_frame_box = Gtk.Frame()
        self.batch_frame_box.set_shadow_type(Gtk.ShadowType.IN)
        self.batch_frame_box.get_style_context().add_class("display-box")
        batch_card_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        self.batch_summary_btn = Gtk.Button()
        self.batch_summary_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.batch_summary_btn.get_style_context().add_class("display-summary")
        batch_sum_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        batch_sum_row.pack_start(make_system_icon("batch_queue"), False, False, 0)
        self.batch_summary_label = Gtk.Label()
        self.batch_summary_label.set_markup("<b>Stapelverarbeitung</b> (0 Aufträge)")
        self.batch_summary_label.set_xalign(0)
        batch_sum_row.pack_start(self.batch_summary_label, True, True, 0)
        self.batch_toggle_glyph = Gtk.Label(label="+")
        self.batch_toggle_glyph.get_style_context().add_class("display-glyph")
        batch_sum_row.pack_end(self.batch_toggle_glyph, False, False, 0)
        self.batch_summary_btn.add(batch_sum_row)
        self.batch_summary_btn.connect("clicked", lambda _b: self._on_display_header_clicked("batch"))
        batch_card_vbox.pack_start(self.batch_summary_btn, False, False, 0)

        self.batch_header_sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        self.batch_header_sep.set_no_show_all(True)
        batch_card_vbox.pack_start(self.batch_header_sep, False, False, 0)

        # Einklappbarer Inhaltsbereich von Display 3 ("Stapelverarbeitung")
        self.batch_body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.batch_body.set_border_width(10)
        self.batch_body.set_no_show_all(True)

        self.batch_toolbar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.batch_toolbar.set_halign(Gtk.Align.END)

        self.pause_batch_btn = Gtk.Button()
        pause_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        pause_box.pack_start(make_system_icon("pause_batch"), False, False, 0)
        self.pause_batch_label = Gtk.Label(label="Pausieren")
        pause_box.pack_start(self.pause_batch_label, False, False, 0)
        self.pause_batch_btn.add(pause_box)
        self.pause_batch_btn.set_tooltip_text("Stapelverarbeitung pausieren / fortsetzen")
        self.pause_batch_btn.connect("clicked", self._on_pause_batch_clicked)
        self.batch_toolbar.pack_start(self.pause_batch_btn, False, False, 0)

        self.stop_batch_btn = Gtk.Button()
        stop_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        stop_box.pack_start(make_system_icon("stop_batch"), False, False, 0)
        stop_box.pack_start(Gtk.Label(label="Abbrechen"), False, False, 0)
        self.stop_batch_btn.add(stop_box)
        self.stop_batch_btn.set_tooltip_text("Alle laufenden Aufträge abbrechen")
        self.stop_batch_btn.connect("clicked", self._on_cancel_batch_clicked)
        self.batch_toolbar.pack_start(self.stop_batch_btn, False, False, 0)

        self.clear_batch_btn = Gtk.Button()
        self.clear_batch_btn.add(make_system_icon("clear_list"))
        self.clear_batch_btn.set_tooltip_text("Abgeschlossene und abgebrochene Aufträge aus der Tabelle entfernen")
        self.clear_batch_btn.connect("clicked", self._on_clear_finished_batch_clicked)
        self.batch_toolbar.pack_start(self.clear_batch_btn, False, False, 0)

        self.batch_body.pack_start(self.batch_toolbar, False, False, 0)

        # Spalten (hierarchische CD-Gruppierung mit Gtk.TreeStore):
        # 0=id (group_id oder job_id), 1=Nr./CD, 2=Titel+Interpret (Markup), 3=Album/Info, 4=Länge, 5=Status (Markup), 6=progress_int, 7=progress_text, 8=is_group
        self.batch_store = Gtk.TreeStore(str, str, str, str, str, str, int, str, bool)
        self.batch_treeview = Gtk.TreeView(model=self.batch_store)
        self.batch_treeview.set_headers_visible(True)
        self.batch_treeview.set_grid_lines(Gtk.TreeViewGridLines.BOTH)
        self.batch_treeview.set_show_expanders(True)
        self.batch_treeview.set_level_indentation(12)
        self.batch_treeview.get_selection().set_mode(Gtk.SelectionMode.SINGLE)
        self.batch_treeview.connect("row-activated", self._on_batch_row_activated)
        self.batch_treeview.connect("button-press-event", self._on_batch_button_press)

        # Spalte 1: Nr. / Expander für CD-Gruppen
        num_renderer = Gtk.CellRendererText()
        num_renderer.set_property("xalign", 0.5)
        self._batch_col_num = Gtk.TreeViewColumn("Nr.", num_renderer, text=1)
        self._batch_col_num.set_resizable(True)
        self._batch_col_num.set_min_width(88)
        self.batch_treeview.append_column(self._batch_col_num)
        self.batch_treeview.set_expander_column(self._batch_col_num)

        # Spalte 2: Titel & darunter Interpret (bzw. CD-Gruppenkopf)
        title_renderer = Gtk.CellRendererText()
        title_renderer.set_property("ellipsize", Pango.EllipsizeMode.END)
        self._batch_col_title = Gtk.TreeViewColumn("Titel", title_renderer, markup=2)
        self._batch_col_title.set_resizable(True)
        self._batch_col_title.set_expand(True)
        self._batch_col_title.set_min_width(140)
        self.batch_treeview.append_column(self._batch_col_title)

        # Spalte 3: Länge
        dur_renderer = Gtk.CellRendererText()
        dur_renderer.set_property("xalign", 1.0)
        self._batch_col_dur = Gtk.TreeViewColumn("Länge", dur_renderer, text=4)
        self._batch_col_dur.set_resizable(True)
        self._batch_col_dur.set_min_width(56)
        self.batch_treeview.append_column(self._batch_col_dur)

        # Spalte 5: Fortschritt & darunter Status im Interpret-Stil in einer Zelle
        prog_cell_area = Gtk.CellAreaBox()
        prog_cell_area.set_orientation(Gtk.Orientation.VERTICAL)
        prog_cell_area.set_spacing(3)
        self._batch_col_prog_status = Gtk.TreeViewColumn.new_with_area(prog_cell_area)
        self._batch_col_prog_status.set_title("Fortschritt / Status")
        self._batch_col_prog_status.set_resizable(True)
        self._batch_col_prog_status.set_expand(True)
        self._batch_col_prog_status.set_min_width(180)

        prog_renderer = Gtk.CellRendererProgress()
        status_renderer = Gtk.CellRendererText()
        status_renderer.set_property("ellipsize", Pango.EllipsizeMode.END)
        self._batch_col_prog_status.pack_start(prog_renderer, False)
        self._batch_col_prog_status.pack_start(status_renderer, False)
        self._batch_col_prog_status.add_attribute(prog_renderer, "value", 6)
        self._batch_col_prog_status.add_attribute(prog_renderer, "text", 7)
        self._batch_col_prog_status.add_attribute(status_renderer, "markup", 5)
        self.batch_treeview.append_column(self._batch_col_prog_status)

        batch_scroll = Gtk.ScrolledWindow()
        batch_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        batch_scroll.set_overlay_scrolling(False)
        batch_scroll.set_shadow_type(Gtk.ShadowType.IN)
        batch_scroll.set_min_content_height(180)
        batch_scroll.add(self.batch_treeview)
        self.batch_body.pack_start(batch_scroll, True, True, 0)
        batch_card_vbox.pack_start(self.batch_body, True, True, 0)
        self.batch_frame_box.add(batch_card_vbox)

        self.right_box.pack_start(self.batch_frame_box, False, False, 0)

        # --- Rechte 3. Spalte (Modul 2 & 3): Track-spezifische Felder (frei skalierbar über right_paned & ein-/ausklappbar) ---
        self.track_inspector_container = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self.track_inspector_container.set_no_show_all(True)

        # Ausgeklappte Ansicht der 3. Spalte (Mindestbreite 400px, frei skalierbar)
        self.track_inspector_expanded = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.track_inspector_expanded.set_size_request(400, -1)
        self.track_inspector_expanded.set_hexpand(True)
        self.track_inspector_expanded.set_border_width(8)

        insp_hdr = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        insp_hdr.pack_start(make_system_icon("audio_track"), False, False, 0)
        self.insp_title_lbl = Gtk.Label()
        self.insp_title_lbl.set_markup("<b>Track-Felder</b>")
        self.insp_title_lbl.set_xalign(0)
        self.insp_title_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        insp_hdr.pack_start(self.insp_title_lbl, True, True, 0)

        self.track_panel_collapse_btn = Gtk.Button()
        self.track_panel_collapse_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.track_panel_collapse_btn.add(
            Gtk.Image.new_from_icon_name("go-next-symbolic", Gtk.IconSize.BUTTON)
        )
        self.track_panel_collapse_btn.set_tooltip_text("Rechte Spalte einklappen")
        self.track_panel_collapse_btn.connect(
            "clicked", lambda _b: self._set_track_panel_collapsed(True)
        )
        insp_hdr.pack_end(self.track_panel_collapse_btn, False, False, 0)
        self.track_inspector_expanded.pack_start(insp_hdr, False, False, 0)
        self.track_inspector_expanded.pack_start(
            Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0
        )

        # Stack in der rechten Spalte: "track_fields" (Display 2/3) vs. "album_preview" (Display 1 Albenliste)
        self.right_panel_stack = Gtk.Stack()
        self.right_panel_stack.set_transition_type(Gtk.StackTransitionType.NONE)
        self.track_inspector_expanded.pack_start(self.right_panel_stack, True, True, 0)

        self.track_fields_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)

        # Aktiver Track-Auswahlbereich (‹ [Track-Auswahl] ›)
        insp_track_hdr = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        insp_track_lbl = Gtk.Label()
        insp_track_lbl.set_markup("<span size='small' weight='bold'>AUSGEWÄHLTER TRACK</span>")
        insp_track_lbl.set_xalign(0)
        insp_track_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        insp_track_lbl.get_style_context().add_class("dim-label")
        insp_track_hdr.pack_start(insp_track_lbl, True, True, 0)
        self.track_insp_counter_lbl = Gtk.Label(label="")
        self.track_insp_counter_lbl.get_style_context().add_class("dim-label")
        insp_track_hdr.pack_end(self.track_insp_counter_lbl, False, False, 0)
        self.track_fields_page.pack_start(insp_track_hdr, False, False, 0)

        insp_nav_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.track_insp_prev_btn = Gtk.Button(label="‹")
        self.track_insp_prev_btn.set_tooltip_text("Vorheriger Track")
        self.track_insp_prev_btn.connect("clicked", lambda _b: self._step_active_track(-1))
        insp_nav_row.pack_start(self.track_insp_prev_btn, False, False, 0)

        self.track_insp_combo = Gtk.ComboBoxText()
        self.track_insp_combo.set_hexpand(True)
        self.track_insp_combo.set_size_request(120, -1)
        for renderer in self.track_insp_combo.get_cells():
            if hasattr(renderer, "set_property"):
                try:
                    renderer.set_property("ellipsize", Pango.EllipsizeMode.END)
                    renderer.set_property("width-chars", 14)
                    renderer.set_property("max-width-chars", 34)
                except Exception:
                    pass
        self.track_insp_combo.connect("changed", self._on_track_insp_combo_changed)
        insp_nav_row.pack_start(self.track_insp_combo, True, True, 0)

        self.track_insp_next_btn = Gtk.Button(label="›")
        self.track_insp_next_btn.set_tooltip_text("Nächster Track")
        self.track_insp_next_btn.connect("clicked", lambda _b: self._step_active_track(1))
        insp_nav_row.pack_start(self.track_insp_next_btn, False, False, 0)
        self.track_fields_page.pack_start(insp_nav_row, False, False, 0)

        self.track_insp_meta_lbl = Gtk.Label(label="Kein Titel geladen")
        self.track_insp_meta_lbl.set_xalign(0)
        self.track_insp_meta_lbl.set_width_chars(12)
        self.track_insp_meta_lbl.set_max_width_chars(36)
        self.track_insp_meta_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        self.track_insp_meta_lbl.get_style_context().add_class("dim-label")
        self.track_fields_page.pack_start(self.track_insp_meta_lbl, False, False, 0)
        self.track_fields_page.pack_start(
            Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 2
        )

        # Scrollbarer Bereich für Track-spezifische Felder
        insp_scroll = Gtk.ScrolledWindow()
        insp_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        insp_scroll.set_overlay_scrolling(False)
        insp_body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)

        # Titel-spezifisches Genre (aus Titel- & Metadaten-Verwaltung hierher verschoben)
        trk_genre_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        trk_genre_lbl = Gtk.Label(label="Genre (; getrennt · nur dieser Track):")
        trk_genre_lbl.set_xalign(0)
        trk_genre_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        self.track_entry_genre = Gtk.Entry()
        self.track_entry_genre.set_width_chars(12)
        self.track_entry_genre.set_hexpand(True)
        self.track_entry_genre.set_placeholder_text("z. B. Rock; Electronic")
        self.track_entry_genre.set_tooltip_text(
            "Titel-spezifisches Genre (überschreibt beim Schreiben das Album-Genre)"
        )
        self.track_entry_genre.connect("changed", self._on_inspector_track_genre_changed)
        self.track_entry_genre.connect(
            "focus-out-event", self._on_inspector_track_genre_focus_out
        )
        trk_genre_box.pack_start(trk_genre_lbl, False, False, 0)
        trk_genre_box.pack_start(self.track_entry_genre, False, False, 0)
        trk_genre_box.pack_start(
            Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4
        )
        insp_body.pack_start(trk_genre_box, False, False, 0)

        # Klassikalbum-Trackfelder (Komponist, Orchester, Dirigent) – nur sichtbar wenn "Klassikalbum" aktiv
        self.track_insp_classical_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.track_insp_classical_box.set_no_show_all(True)

        cl_trk_hdr = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        cl_trk_hdr.pack_start(make_system_icon("classical_album"), False, False, 0)
        cl_trk_lbl = Gtk.Label()
        cl_trk_lbl.set_markup("<b>Klassikalbum (nur dieser Track)</b>")
        cl_trk_lbl.set_xalign(0)
        cl_trk_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        cl_trk_hdr.pack_start(cl_trk_lbl, True, True, 0)
        self.track_insp_classical_box.pack_start(cl_trk_hdr, False, False, 0)

        trk_comp_lbl = Gtk.Label(label="Komponist (; für mehrere):")
        trk_comp_lbl.set_xalign(0)
        trk_comp_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        self.track_entry_composer = Gtk.Entry()
        self.track_entry_composer.set_width_chars(8)
        self.track_entry_composer.set_hexpand(True)
        self.track_entry_composer.set_placeholder_text("z. B. Ludwig van Beethoven")
        self.track_entry_composer.set_tooltip_text("Komponist ausschließlich für den ausgewählten Track (; für mehrere)")
        self.track_entry_composer.connect(
            "changed", self._on_inspector_track_field_changed, "composer"
        )
        self.track_entry_composer.connect(
            "focus-out-event", self._on_inspector_track_field_focus_out, "composer", "Komponist"
        )
        self.track_insp_classical_box.pack_start(trk_comp_lbl, False, False, 0)
        self.track_insp_classical_box.pack_start(self.track_entry_composer, False, False, 0)

        trk_orch_lbl = Gtk.Label(label="Orchester (; für mehrere):")
        trk_orch_lbl.set_xalign(0)
        trk_orch_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        self.track_entry_orchestra = Gtk.Entry()
        self.track_entry_orchestra.set_width_chars(8)
        self.track_entry_orchestra.set_hexpand(True)
        self.track_entry_orchestra.set_placeholder_text("z. B. Berliner Philharmoniker")
        self.track_entry_orchestra.set_tooltip_text("Orchester ausschließlich für den ausgewählten Track (; für mehrere)")
        self.track_entry_orchestra.connect(
            "changed", self._on_inspector_track_field_changed, "orchestra"
        )
        self.track_entry_orchestra.connect(
            "focus-out-event", self._on_inspector_track_field_focus_out, "orchestra", "Orchester"
        )
        self.track_insp_classical_box.pack_start(trk_orch_lbl, False, False, 0)
        self.track_insp_classical_box.pack_start(self.track_entry_orchestra, False, False, 0)

        trk_cond_lbl = Gtk.Label(label="Dirigent (; für mehrere):")
        trk_cond_lbl.set_xalign(0)
        trk_cond_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        self.track_entry_conductor = Gtk.Entry()
        self.track_entry_conductor.set_width_chars(8)
        self.track_entry_conductor.set_hexpand(True)
        self.track_entry_conductor.set_placeholder_text("z. B. Herbert von Karajan")
        self.track_entry_conductor.set_tooltip_text("Dirigent ausschließlich für den ausgewählten Track (; für mehrere)")
        self.track_entry_conductor.connect(
            "changed", self._on_inspector_track_field_changed, "conductor"
        )
        self.track_entry_conductor.connect(
            "focus-out-event", self._on_inspector_track_field_focus_out, "conductor", "Dirigent"
        )
        self.track_insp_classical_box.pack_start(trk_cond_lbl, False, False, 0)
        self.track_insp_classical_box.pack_start(self.track_entry_conductor, False, False, 0)
        self.track_insp_classical_box.pack_start(
            Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4
        )

        insp_body.pack_start(self.track_insp_classical_box, False, False, 0)

        # Bereich für bereits befüllte Track-Tags des ausgewählten Tracks (direkt editierbar)
        self.track_insp_populated_section = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.track_insp_populated_section.set_no_show_all(True)
        self.track_insp_populated_hdr_lbl = Gtk.Label()
        self.track_insp_populated_hdr_lbl.set_markup("<span size='small' weight='bold'>BEFÜLLTE TRACK-TAGS</span>")
        self.track_insp_populated_hdr_lbl.set_xalign(0)
        self.track_insp_populated_hdr_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        self.track_insp_populated_hdr_lbl.get_style_context().add_class("dim-label")
        self.track_insp_populated_section.pack_start(self.track_insp_populated_hdr_lbl, False, False, 0)
        self.track_insp_populated_list = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.track_insp_populated_section.pack_start(self.track_insp_populated_list, False, False, 0)
        insp_body.pack_start(self.track_insp_populated_section, False, False, 0)

        # Zusammengeklapptes Display: ID's (MusicBrainz-IDs & AcoustID)
        self.track_ids_display_frame = Gtk.Frame()
        self.track_ids_display_frame.set_shadow_type(Gtk.ShadowType.IN)
        self.track_ids_display_frame.get_style_context().add_class("display-box")
        ids_card_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        self.track_ids_summary_btn = Gtk.Button()
        self.track_ids_summary_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.track_ids_summary_btn.get_style_context().add_class("display-summary")
        ids_sum_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.track_ids_summary_label = Gtk.Label()
        self.track_ids_summary_label.set_markup("<b>ID's</b>")
        self.track_ids_summary_label.set_xalign(0)
        self.track_ids_summary_label.set_ellipsize(Pango.EllipsizeMode.END)
        ids_sum_row.pack_start(self.track_ids_summary_label, True, True, 0)
        self.track_ids_toggle_glyph = Gtk.Label(label="+")
        self.track_ids_toggle_glyph.get_style_context().add_class("display-glyph")
        ids_sum_row.pack_end(self.track_ids_toggle_glyph, False, False, 0)
        self.track_ids_summary_btn.add(ids_sum_row)
        self.track_ids_summary_btn.connect(
            "clicked", lambda _b: self._toggle_track_inspector_subdisplay("ids")
        )
        ids_card_vbox.pack_start(self.track_ids_summary_btn, False, False, 0)

        self.track_ids_header_sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        self.track_ids_header_sep.set_no_show_all(True)
        self.track_ids_header_sep.hide()
        ids_card_vbox.pack_start(self.track_ids_header_sep, False, False, 0)

        self.track_ids_body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.track_ids_body.set_border_width(8)
        self.track_ids_body.set_no_show_all(True)
        self.track_ids_body.hide()
        self.track_ids_list = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.track_ids_body.pack_start(self.track_ids_list, False, False, 0)
        ids_card_vbox.pack_start(self.track_ids_body, False, False, 0)

        self.track_ids_display_frame.add(ids_card_vbox)
        insp_body.pack_start(self.track_ids_display_frame, False, False, 0)

        # Zusammengeklapptes Display: Replaygain
        self.track_rg_display_frame = Gtk.Frame()
        self.track_rg_display_frame.set_shadow_type(Gtk.ShadowType.IN)
        self.track_rg_display_frame.get_style_context().add_class("display-box")
        rg_card_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        self.track_rg_summary_btn = Gtk.Button()
        self.track_rg_summary_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.track_rg_summary_btn.get_style_context().add_class("display-summary")
        rg_sum_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.track_rg_summary_label = Gtk.Label()
        self.track_rg_summary_label.set_markup("<b>Replaygain</b>")
        self.track_rg_summary_label.set_xalign(0)
        self.track_rg_summary_label.set_ellipsize(Pango.EllipsizeMode.END)
        rg_sum_row.pack_start(self.track_rg_summary_label, True, True, 0)
        self.track_rg_toggle_glyph = Gtk.Label(label="+")
        self.track_rg_toggle_glyph.get_style_context().add_class("display-glyph")
        rg_sum_row.pack_end(self.track_rg_toggle_glyph, False, False, 0)
        self.track_rg_summary_btn.add(rg_sum_row)
        self.track_rg_summary_btn.connect(
            "clicked", lambda _b: self._toggle_track_inspector_subdisplay("replaygain")
        )
        rg_card_vbox.pack_start(self.track_rg_summary_btn, False, False, 0)

        self.track_rg_header_sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        self.track_rg_header_sep.set_no_show_all(True)
        self.track_rg_header_sep.hide()
        rg_card_vbox.pack_start(self.track_rg_header_sep, False, False, 0)

        self.track_rg_body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.track_rg_body.set_border_width(8)
        self.track_rg_body.set_no_show_all(True)
        self.track_rg_body.hide()
        self.track_rg_list = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.track_rg_body.pack_start(self.track_rg_list, False, False, 0)
        rg_card_vbox.pack_start(self.track_rg_body, False, False, 0)

        self.track_rg_display_frame.add(rg_card_vbox)
        insp_body.pack_start(self.track_rg_display_frame, False, False, 0)

        # Kompakter Hinweis wenn befüllte Track-Tags vorhanden sind, aber Klassikalbum aus ist
        self.track_insp_compact_hint_lbl = Gtk.Label(
            label="„Klassikalbum“ in der Toolbar blendet zusätzlich Komponist, Orchester & Dirigent ein."
        )
        self.track_insp_compact_hint_lbl.set_xalign(0)
        self.track_insp_compact_hint_lbl.set_line_wrap(True)
        self.track_insp_compact_hint_lbl.set_width_chars(10)
        self.track_insp_compact_hint_lbl.set_max_width_chars(22)
        self.track_insp_compact_hint_lbl.get_style_context().add_class("dim-label")
        self.track_insp_compact_hint_lbl.set_no_show_all(True)
        insp_body.pack_start(self.track_insp_compact_hint_lbl, False, False, 0)

        # Hinweis-Box wenn weder Klassikalbum aktiv noch befüllte Track-Tags vorhanden sind
        self.track_insp_hint_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.track_insp_hint_box.set_no_show_all(True)
        hint_frame = Gtk.Frame()
        hint_frame.set_shadow_type(Gtk.ShadowType.ETCHED_IN)
        hint_inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        hint_inner.set_border_width(8)
        hint_title_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        hint_title_row.pack_start(make_system_icon("classical_album"), False, False, 0)
        hint_title = Gtk.Label()
        hint_title.set_markup("<b>Track-spezifische Felder</b>")
        hint_title.set_xalign(0)
        hint_title.set_ellipsize(Pango.EllipsizeMode.END)
        hint_title_row.pack_start(hint_title, True, True, 0)
        hint_inner.pack_start(hint_title_row, False, False, 0)
        hint_text = Gtk.Label(
            label=(
                "Bereits befüllte Track-Tags erscheinen hier automatisch.\n\n"
                "Aktivieren Sie „Klassikalbum“ in der Toolbar für Komponist, Orchester und Dirigent."
            )
        )
        hint_text.set_xalign(0)
        hint_text.set_line_wrap(True)
        hint_text.set_width_chars(10)
        hint_text.set_max_width_chars(22)
        hint_text.get_style_context().add_class("dim-label")
        hint_inner.pack_start(hint_text, False, False, 0)
        hint_frame.add(hint_inner)
        self.track_insp_hint_box.pack_start(hint_frame, False, False, 0)
        insp_body.pack_start(self.track_insp_hint_box, False, False, 0)

        insp_scroll.add(insp_body)
        self.track_fields_page.pack_start(insp_scroll, True, True, 0)

        # Hauptaktions-Button ("Tags in Dateien schreiben" / "In FLAC umwandeln" / "Rippen") am unteren Rand der rechten Spalte
        self.track_fields_page.pack_start(
            Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4
        )
        self.rip_btn = Gtk.Button()
        self.rip_btn.get_style_context().add_class("suggested-action")
        rip_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        rip_box.set_halign(Gtk.Align.CENTER)
        self.rip_btn_icon = make_system_icon("start_rip")
        self.rip_btn_label = Gtk.Label(label="Rippen")
        self.rip_btn_label.set_ellipsize(Pango.EllipsizeMode.END)
        rip_box.pack_start(self.rip_btn_icon, False, False, 0)
        rip_box.pack_start(self.rip_btn_label, False, False, 0)
        self.rip_btn.add(rip_box)
        self.rip_btn.set_tooltip_text(
            "Ausgewählte Titel rippen / konvertieren und in die Stapelverarbeitung starten"
        )
        self.rip_btn.connect("clicked", self._on_enqueue_album_clicked)
        self.track_fields_page.pack_end(self.rip_btn, False, False, 2)

        self.right_panel_stack.add_named(self.track_fields_page, "track_fields")

        # Seite 2 der rechten Spalte: Album-Tracks-Vorschau beim Klick auf ein Album in Display 1 (Albenliste)
        self.album_preview_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)

        self.album_preview_source_lbl = Gtk.Label(label="")
        self.album_preview_source_lbl.set_xalign(0)
        self.album_preview_source_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        self.album_preview_source_lbl.get_style_context().add_class("dim-label")
        self.album_preview_page.pack_start(self.album_preview_source_lbl, False, False, 0)

        self.album_preview_title_lbl = Gtk.Label()
        self.album_preview_title_lbl.set_xalign(0)
        self.album_preview_title_lbl.set_line_wrap(True)
        self.album_preview_title_lbl.set_width_chars(10)
        self.album_preview_title_lbl.set_max_width_chars(24)
        self.album_preview_page.pack_start(self.album_preview_title_lbl, False, False, 0)

        self.album_preview_artist_lbl = Gtk.Label(label="")
        self.album_preview_artist_lbl.set_xalign(0)
        self.album_preview_artist_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        self.album_preview_artist_lbl.get_style_context().add_class("dim-label")
        self.album_preview_page.pack_start(self.album_preview_artist_lbl, False, False, 0)

        self.album_preview_page.pack_start(
            Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 2
        )

        self.album_preview_status_lbl = Gtk.Label(
            label="Album in der Albenliste anklicken, um enthaltene Tracks anzuzeigen."
        )
        self.album_preview_status_lbl.set_xalign(0)
        self.album_preview_status_lbl.set_line_wrap(True)
        self.album_preview_status_lbl.set_width_chars(10)
        self.album_preview_status_lbl.set_max_width_chars(24)
        self.album_preview_status_lbl.get_style_context().add_class("dim-label")
        self.album_preview_page.pack_start(self.album_preview_status_lbl, False, False, 0)

        preview_scroll = Gtk.ScrolledWindow()
        preview_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        preview_scroll.set_overlay_scrolling(False)
        self.album_preview_tracks_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        preview_scroll.add(self.album_preview_tracks_box)
        self.album_preview_page.pack_start(preview_scroll, True, True, 0)

        # Einziger Button "Ausgewähltes Album laden" mit Pfeil-nach-unten-Icon fest am unteren Rand der rechten Spalte
        self.album_preview_page.pack_start(
            Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4
        )
        self.load_hit_btn = Gtk.Button()
        self.load_hit_btn.get_style_context().add_class("suggested-action")
        load_hit_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        load_hit_box.set_halign(Gtk.Align.CENTER)
        load_hit_box.pack_start(
            Gtk.Image.new_from_icon_name("go-down-symbolic", Gtk.IconSize.BUTTON),
            False,
            False,
            0,
        )
        load_hit_box.pack_start(Gtk.Label(label="Ausgewähltes Album laden"), False, False, 0)
        self.load_hit_btn.add(load_hit_box)
        self.load_hit_btn.set_tooltip_text(
            "Lädt die vollständigen Metadaten, Titel und das Cover des markierten Treffers in Display 2 (Titel- & Metadaten-Verwaltung)"
        )
        self.load_hit_btn.set_sensitive(False)
        self.load_hit_btn.connect("clicked", self._on_load_selected_hit_clicked)
        self.album_preview_page.pack_end(self.load_hit_btn, False, False, 2)

        self.right_preview_overlay = Gtk.Overlay()
        self.right_preview_overlay.add(self.album_preview_page)

        self.right_preview_loading_overlay_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.right_preview_loading_overlay_box.get_style_context().add_class("cover-loading-overlay")
        self.right_preview_loading_overlay_box.set_halign(Gtk.Align.FILL)
        self.right_preview_loading_overlay_box.set_valign(Gtk.Align.FILL)
        right_ov_center = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        right_ov_center.set_halign(Gtk.Align.CENTER)
        right_ov_center.set_valign(Gtk.Align.CENTER)

        self.right_preview_spinner_area = Gtk.DrawingArea()
        self.right_preview_spinner_area.set_size_request(48, 48)
        self.right_preview_spinner_area.set_halign(Gtk.Align.CENTER)
        self.right_preview_spinner_area.connect("draw", self._on_draw_slow_spinner)
        right_ov_center.pack_start(self.right_preview_spinner_area, False, False, 0)

        self.right_preview_overlay_title_label = Gtk.Label()
        self.right_preview_overlay_title_label.set_markup("<b>Trackliste wird abgefragt…</b>")
        self.right_preview_overlay_title_label.set_line_wrap(True)
        self.right_preview_overlay_title_label.set_justify(Gtk.Justification.CENTER)
        right_ov_center.pack_start(self.right_preview_overlay_title_label, False, False, 0)

        self.right_preview_overlay_sub_label = Gtk.Label()
        self.right_preview_overlay_sub_label.set_markup(
            "<span size='small'>Enthaltene Titel werden geladen</span>"
        )
        self.right_preview_overlay_sub_label.set_line_wrap(True)
        self.right_preview_overlay_sub_label.set_justify(Gtk.Justification.CENTER)
        right_ov_center.pack_start(self.right_preview_overlay_sub_label, False, False, 0)

        self.right_preview_loading_overlay_box.pack_start(right_ov_center, True, True, 0)
        self.right_preview_loading_overlay_box.set_no_show_all(True)
        self.right_preview_loading_overlay_box.hide()
        self.right_preview_overlay.add_overlay(self.right_preview_loading_overlay_box)

        self.right_panel_stack.add_named(self.right_preview_overlay, "album_preview")
        self.right_panel_stack.set_visible_child_name("track_fields")

        self.track_inspector_container.pack_start(self.track_inspector_expanded, True, True, 0)

        # Eingeklappte schmale Leiste der 3. Spalte (zum Wiederausklappen)
        self.track_inspector_collapsed = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.track_inspector_collapsed.set_size_request(36, -1)
        self.track_inspector_collapsed.set_no_show_all(True)

        self.track_panel_expand_btn = Gtk.Button()
        self.track_panel_expand_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.track_panel_expand_btn.get_style_context().add_class("track-inspector-rail-btn")
        self.track_panel_expand_btn.set_tooltip_text("Rechte Spalte ausklappen")
        expand_btn_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        expand_btn_box.set_valign(Gtk.Align.START)
        expand_btn_box.pack_start(
            Gtk.Image.new_from_icon_name("go-previous-symbolic", Gtk.IconSize.BUTTON),
            False,
            False,
            0,
        )
        self.track_panel_rail_lbl = Gtk.Label(label="Track-Felder")
        self.track_panel_rail_lbl.set_angle(90)
        self.track_panel_rail_lbl.get_style_context().add_class("dim-label")
        expand_btn_box.pack_start(self.track_panel_rail_lbl, False, False, 0)
        self.track_panel_expand_btn.add(expand_btn_box)
        self.track_panel_expand_btn.connect(
            "clicked", lambda _b: self._set_track_panel_collapsed(False)
        )
        self.track_inspector_collapsed.pack_start(self.track_panel_expand_btn, True, True, 0)
        self.track_inspector_container.pack_start(self.track_inspector_collapsed, True, True, 0)

        self.right_paned.pack2(self.track_inspector_container, resize=False, shrink=False)
        self.right_paned.connect("size-allocate", self._on_right_paned_size_allocate)
        self.right_paned.connect("notify::position", self._on_right_paned_position_changed)

        # Optionale eigene Spalte am unteren Rand des gesamten Fensters (Höhe über window_vpaned skalierbar)
        self.query_log_panel = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.query_log_panel.set_border_width(8)
        self.query_log_panel.set_size_request(-1, 120)

        log_header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        log_header.pack_start(make_system_icon("search_online"), False, False, 0)
        log_title = Gtk.Label()
        log_title.set_markup(
            "<b>Aktions- &amp; Abfrage-Protokoll (Alle Aktionen · MusicBrainz → Discogs → CDDB &amp; Cover-Quellen)</b>"
        )
        log_title.set_xalign(0)
        log_header.pack_start(log_title, True, True, 0)

        self.log_clear_btn = Gtk.Button(label="Protokoll leeren")
        self.log_clear_btn.set_tooltip_text("Alle Einträge im Abfrage-Protokoll löschen")
        self.log_clear_btn.connect("clicked", lambda _b: self._clear_query_log())
        log_header.pack_start(self.log_clear_btn, False, False, 0)

        self.log_dock_btn = Gtk.Button(label="Abdocken")
        self.log_dock_btn.set_tooltip_text(
            "Protokoll in ein eigenes Fenster abdocken oder wieder an der alten Stelle andocken"
        )
        self.log_dock_btn.connect("clicked", self._on_toggle_log_dock_clicked)
        log_header.pack_start(self.log_dock_btn, False, False, 0)

        self.log_hide_btn = Gtk.Button(label="Ausblenden")
        self.log_hide_btn.set_tooltip_text("Protokoll-Spalte schließen (wieder aktivierbar in den Einstellungen)")
        self.log_hide_btn.connect("clicked", self._on_hide_query_log_clicked)
        log_header.pack_start(self.log_hide_btn, False, False, 0)

        self.query_log_panel.pack_start(log_header, False, False, 0)

        log_scroll = Gtk.ScrolledWindow()
        log_scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        log_scroll.set_overlay_scrolling(False)
        log_scroll.set_shadow_type(Gtk.ShadowType.IN)
        log_scroll.set_min_content_height(80)
        self.query_log_view = Gtk.TextView()
        self.query_log_view.set_editable(False)
        self.query_log_view.set_cursor_visible(False)
        self.query_log_view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self.query_log_view.set_monospace(True)
        self._init_query_log_tags()
        log_scroll.add(self.query_log_view)
        self.query_log_panel.pack_start(log_scroll, True, True, 0)

        self.window_vpaned.pack2(self.query_log_panel, resize=False, shrink=False)

        # Dauerhafte Fortschrittsleiste am unteren Fensterrand für alle Datenbankabfragen
        # (immer sichtbar am unteren Rand, unabhängig vom Abfrage-Protokoll)
        self.db_query_progress_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        self.db_query_progress_box.set_size_request(-1, 32)
        self.db_query_progress_box.get_style_context().add_class("db-query-progress-strip")

        self.db_progress_spinner = Gtk.Spinner()
        self.db_progress_spinner.set_size_request(16, 16)
        self.db_progress_spinner.set_valign(Gtk.Align.CENTER)
        self.db_progress_spinner.set_no_show_all(True)
        self.db_query_progress_box.pack_start(self.db_progress_spinner, False, False, 0)

        self.db_progress_glyph = Gtk.Label(label="●")
        self.db_progress_glyph.set_valign(Gtk.Align.CENTER)
        self.db_progress_glyph.get_style_context().add_class("dim-label")
        self.db_query_progress_box.pack_start(self.db_progress_glyph, False, False, 0)

        self.db_progress_label = Gtk.Label(label="Bereit — keine aktive Datenbankabfrage")
        self.db_progress_label.set_xalign(0)
        self.db_progress_label.set_ellipsize(Pango.EllipsizeMode.END)
        self.db_progress_label.set_hexpand(True)
        self.db_progress_label.get_style_context().add_class("dim-label")
        self.db_query_progress_box.pack_start(self.db_progress_label, True, True, 0)

        self.db_progress_bar = Gtk.ProgressBar()
        self.db_progress_bar.set_size_request(280, 14)
        self.db_progress_bar.set_valign(Gtk.Align.CENTER)
        self.db_progress_bar.set_pulse_step(0.06)
        self.db_progress_bar.set_fraction(0.0)
        self.db_progress_bar.get_style_context().add_class("db-query-progress-bar")
        self.db_query_progress_box.pack_start(self.db_progress_bar, False, False, 0)

        self.db_progress_pct_label = Gtk.Label(label="Bereit")
        self.db_progress_pct_label.set_xalign(1.0)
        self.db_progress_pct_label.set_width_chars(14)
        self.db_progress_pct_label.get_style_context().add_class("dim-label")
        self.db_query_progress_box.pack_start(self.db_progress_pct_label, False, False, 0)

        self.db_progress_spinner.hide()
        main_vbox.pack_end(self.db_query_progress_box, False, False, 0)

    def _on_main_window_destroy(self, _w: Gtk.Widget) -> None:
        self._stop_tray_polling()
        self._stop_track_preview(log=False)
        self._db_progress_stop_timers()
        with self._rep_pending_lock:
            if self._rep_flush_timer_id:
                GLib.source_remove(self._rep_flush_timer_id)
                self._rep_flush_timer_id = 0
            self._rep_pending_jobs.clear()
        with self._query_log_lock:
            if self._query_log_timer_id:
                GLib.source_remove(self._query_log_timer_id)
                self._query_log_timer_id = 0
            self._pending_log_lines.clear()
        if self._rep_summary_timer_id:
            GLib.source_remove(self._rep_summary_timer_id)
            self._rep_summary_timer_id = 0
        if getattr(self, "_left_paned_sync_idle_id", 0):
            GLib.source_remove(self._left_paned_sync_idle_id)
            self._left_paned_sync_idle_id = 0
        if getattr(self, "_right_paned_sync_idle_id", 0):
            GLib.source_remove(self._right_paned_sync_idle_id)
            self._right_paned_sync_idle_id = 0
        if getattr(self, "_rep_player_timer_id", 0):
            GLib.source_remove(self._rep_player_timer_id)
            self._rep_player_timer_id = 0
        if getattr(self, "_rep_player_seek_timer_id", 0):
            GLib.source_remove(self._rep_player_seek_timer_id)
            self._rep_player_seek_timer_id = 0
        if self._detached_log_window is not None:
            try:
                self._detached_log_window.destroy()
            except Exception:
                pass
            self._detached_log_window = None

    def _dock_query_log_back(self, log: bool = True) -> None:
        if self._detached_log_window is None:
            return
        win = self._detached_log_window
        self._detached_log_window = None
        parent = self.query_log_panel.get_parent()
        if parent is win:
            win.remove(self.query_log_panel)
        try:
            win.destroy()
        except Exception:
            pass
        if self.query_log_panel.get_parent() is None:
            self.window_vpaned.pack2(self.query_log_panel, resize=False, shrink=False)
        self.log_dock_btn.set_label("Abdocken")
        self._update_query_log_visibility()
        if log:
            self._append_query_log_ui("[Ansicht] Protokoll wieder an der alten Stelle angedockt.")

    def _on_detached_log_window_delete(self, _win: Gtk.Window, _event: Gdk.Event) -> bool:
        self._dock_query_log_back(log=True)
        return True

    def _on_toggle_log_dock_clicked(self, _btn: Gtk.Button) -> None:
        if self._detached_log_window is not None:
            self._dock_query_log_back(log=True)
            return
        parent = self.query_log_panel.get_parent()
        if parent is not None:
            parent.remove(self.query_log_panel)
        win = Gtk.Window(title="Aktions- & Abfrage-Protokoll — MintRip Studio")
        win.set_default_size(900, 320)
        win.set_icon_name(resolve_program_icon_name())
        win.connect("delete-event", self._on_detached_log_window_delete)
        self._detached_log_window = win
        self.log_dock_btn.set_label("An alter Stelle andocken")
        win.add(self.query_log_panel)
        self.query_log_panel.set_no_show_all(False)
        win.show_all()
        self._append_query_log_ui("[Ansicht] Protokoll in eigenes Fenster abgedockt.")

    def _on_toggle_log_btn_toggled(self, btn: Gtk.ToggleButton) -> None:
        if self._updating_log_toggle:
            return
        active = btn.get_active()
        self.settings.show_query_log = active
        save_settings(self.settings, theme_mode=self.theme_watcher.mode)
        self._update_query_log_visibility()
        self._append_query_log_ui(
            f"[Ansicht] Protokoll-Spalte am unteren Fensterrand {'eingeblendet' if active else 'ausgeblendet'}."
        )

    def _update_query_log_visibility(self) -> None:
        self._updating_log_toggle = True
        try:
            if hasattr(self, "toggle_log_btn"):
                self.toggle_log_btn.set_active(self.settings.show_query_log)
        finally:
            self._updating_log_toggle = False
        if self.settings.show_query_log:
            self.query_log_panel.set_no_show_all(False)
            if self._detached_log_window is not None:
                self._detached_log_window.show_all()
            else:
                self.query_log_panel.show_all()
        else:
            if self._detached_log_window is not None:
                self._detached_log_window.hide()
            self.query_log_panel.hide()
            self.query_log_panel.set_no_show_all(True)

    def _update_workspace_visibility_and_locks(self) -> None:
        locked = self._batch_running and not self._batch_paused
        effective_display = "batch" if locked else self._active_display

        hits_count = len(self._candidate_hits)
        if hits_count > 0:
            self.hits_summary_label.set_markup(
                f"<b>Albenliste</b> ({hits_count} Treffer)"
            )
        else:
            self.hits_summary_label.set_markup("<b>Albenliste</b>")

        job_count = len(self.batch_manager.jobs)
        if locked:
            self.batch_summary_label.set_markup(
                f"<b>Stapelverarbeitung</b> ({job_count} Aufträge · Läuft)"
            )
        elif self._batch_paused:
            self.batch_summary_label.set_markup(
                f"<b>Stapelverarbeitung</b> ({job_count} Aufträge · Pausiert)"
            )
        else:
            self.batch_summary_label.set_markup(
                f"<b>Stapelverarbeitung</b> ({job_count} Aufträge)"
            )

        # 1. Display 1: Albenliste
        hits_open = effective_display == "hits"
        self.hits_toggle_glyph.set_text("−" if hits_open else "+")
        if hasattr(self, "hits_search_overlay_box"):
            self.hits_search_overlay_box.set_no_show_all(not self._hits_search_active)
        if hits_open:
            self.hits_summary_btn.get_style_context().remove_class("closed-box")
            self.hits_header_sep.set_no_show_all(False)
            self.hits_header_sep.show()
            self.hits_body.set_no_show_all(False)
            self.hits_body.show_all()
            if hasattr(self, "hits_search_overlay_box"):
                if self._hits_search_active:
                    self.hits_search_overlay_box.show_all()
                else:
                    self.hits_search_overlay_box.hide()
            self.load_hit_btn.set_sensitive((not locked) and (not self._hits_search_active) and hits_count > 0)
        else:
            self.hits_summary_btn.get_style_context().add_class("closed-box")
            self.hits_header_sep.hide()
            self.hits_header_sep.set_no_show_all(True)
            self.hits_body.hide()
            self.hits_body.set_no_show_all(True)
        if hasattr(self, "scan_cd_btn"):
            self.scan_cd_btn.set_sensitive((not locked) and (not self._hits_search_active))

        # 2. Display 2: Titel- & Metadaten-Verwaltung
        tracks_open = effective_display == "tracks"
        self.track_toggle_glyph.set_text("−" if tracks_open else "+")
        if tracks_open:
            self.track_summary_btn.get_style_context().remove_class("closed-box")
            self.track_header_sep.set_no_show_all(False)
            self.track_header_sep.show()
            self.track_body.set_no_show_all(False)
            self.track_body.show_all()
            self._update_classical_visibility()
        else:
            self.track_summary_btn.get_style_context().add_class("closed-box")
            self.track_header_sep.hide()
            self.track_header_sep.set_no_show_all(True)
            self.track_body.hide()
            self.track_body.set_no_show_all(True)

        # 3. Display 3: Stapelverarbeitung
        batch_open = effective_display == "batch"
        self.batch_toggle_glyph.set_text("−" if batch_open else "+")
        if batch_open:
            self.batch_summary_btn.get_style_context().remove_class("closed-box")
            self.batch_header_sep.set_no_show_all(False)
            self.batch_header_sep.show()
            self.batch_body.set_no_show_all(False)
            self.batch_body.show_all()
        else:
            self.batch_summary_btn.get_style_context().add_class("closed-box")
            self.batch_header_sep.hide()
            self.batch_header_sep.set_no_show_all(True)
            self.batch_body.hide()
            self.batch_body.set_no_show_all(True)

        is_cover_only = getattr(self, "_active_module", "") == "module_cover"
        for disp_box in (self.hits_frame_box, self.track_frame_box, self.batch_frame_box):
            disp_box.set_no_show_all(is_cover_only)
            disp_box.set_visible(not is_cover_only)
        if hasattr(self, "cover_results_frame"):
            self.cover_results_frame.set_no_show_all(not is_cover_only)
            if is_cover_only:
                self.cover_results_frame.show_all()
            else:
                self.cover_results_frame.hide()

        # Linke Spalte ("Album & Cover" bzw. "Album-Vorschau" bei geöffneter Albenliste): in Modul 2 & 3 ein-/ausklappbar
        show_album_preview = (not is_cover_only) and hits_open and hits_count > 0
        if hasattr(self, "left_sidebar_header_box"):
            self.left_sidebar_header_box.set_no_show_all(is_cover_only)
            self.left_sidebar_header_box.set_visible(not is_cover_only)
            self.left_sidebar_header_sep.set_no_show_all(is_cover_only)
            self.left_sidebar_header_sep.set_visible(not is_cover_only)
            if hasattr(self, "left_panel_stack"):
                self.left_panel_stack.set_visible_child_name(
                    "album_preview" if show_album_preview else "album_editor"
                )
            if hasattr(self, "left_hdr_lbl"):
                self.left_hdr_lbl.set_markup(
                    "<b>Album-Vorschau</b>" if show_album_preview else "<b>Album &amp; Cover</b>"
                )
            if hasattr(self, "left_panel_rail_lbl"):
                self.left_panel_rail_lbl.set_text(
                    "Album-Vorschau" if show_album_preview else "Album & Cover"
                )
            self._apply_left_panel_collapse_state()

        # Rechte 3. Spalte ("Track-Felder" bzw. "Album-Tracks"): sichtbar in Modul 2 & 3, ausgeblendet in Modul 1
        if hasattr(self, "track_inspector_container"):
            show_third_col = not is_cover_only
            self.track_inspector_container.set_no_show_all(not show_third_col)
            self.track_inspector_container.set_visible(show_third_col)
            if show_third_col:
                if hasattr(self, "right_panel_stack"):
                    self.right_panel_stack.set_visible_child_name(
                        "album_preview" if show_album_preview else "track_fields"
                    )
                if hasattr(self, "insp_title_lbl"):
                    self.insp_title_lbl.set_markup(
                        "<b>Album-Tracks</b>" if show_album_preview else "<b>Track-Felder</b>"
                    )
                if hasattr(self, "track_panel_rail_lbl"):
                    self.track_panel_rail_lbl.set_text(
                        "Album-Tracks" if show_album_preview else "Track-Felder"
                    )
                self._apply_track_panel_collapse_state()
                if show_album_preview:
                    self._request_selected_hit_preview()
                else:
                    self._sync_track_inspector_ui()
                self._schedule_right_paned_sync()

        # 4. Exklusive Höhenverteilung in right_box (nur das geöffnete Display dehnt sich aus)
        self.right_box.set_child_packing(
            self.hits_frame_box, (not is_cover_only) and hits_open, (not is_cover_only) and hits_open, 0, Gtk.PackType.START
        )
        self.right_box.set_child_packing(
            self.track_frame_box, (not is_cover_only) and tracks_open, (not is_cover_only) and tracks_open, 0, Gtk.PackType.START
        )
        self.right_box.set_child_packing(
            self.batch_frame_box, (not is_cover_only) and batch_open, (not is_cover_only) and batch_open, 0, Gtk.PackType.START
        )

        # 5. Sperre während laufender Stapelverarbeitung (Pausieren, Abbrechen sowie Protokoll ein-/ausblenden & abdocken bleiben stets bedienbar)
        self.primary_toolbar.set_sensitive(True)
        for tb_child in self.primary_toolbar.get_children():
            if hasattr(self, "toggle_log_btn") and tb_child is self.toggle_log_btn:
                tb_child.set_sensitive(True)
            else:
                tb_child.set_sensitive(not locked)
        self.sidebar_box.set_sensitive(not locked)
        if hasattr(self, "left_panel_stack"):
            self.left_panel_stack.set_sensitive(not locked)
        self.search_bar_frame.set_sensitive(not locked)
        self.hits_summary_btn.set_sensitive(not locked)
        self.hits_body.set_sensitive(not locked)
        self.track_summary_btn.set_sensitive(not locked)
        self.track_body.set_sensitive(not locked)
        if hasattr(self, "track_inspector_expanded"):
            self.track_inspector_expanded.set_sensitive(not locked)
        self.batch_summary_btn.set_sensitive(not locked)
        self.clear_batch_btn.set_sensitive(not locked)
        self.log_clear_btn.set_sensitive(not locked)
        if hasattr(self, "log_dock_btn"):
            self.log_dock_btn.set_sensitive(True)
        self.log_hide_btn.set_sensitive(True)

        selected_count = sum(1 for t in self.album.tracks if t.selected)
        self.rip_btn.set_sensitive((not locked) and selected_count > 0)
        self.pause_batch_btn.set_sensitive(self._batch_running)
        self.stop_batch_btn.set_sensitive(self._batch_running)
        self.pause_batch_label.set_text("Fortsetzen" if self._batch_paused else "Pausieren")

    def _on_display_header_clicked(self, display: str) -> None:
        if self._batch_running and not self._batch_paused:
            return
        self._active_display = None if self._active_display == display else display
        self._update_workspace_visibility_and_locks()

    def _on_hide_query_log_clicked(self, _btn: Gtk.Button) -> None:
        self._append_query_log_ui("[Ansicht] Protokoll-Spalte am unteren Fensterrand ausgeblendet.")
        self.settings.show_query_log = False
        save_settings(self.settings, theme_mode=self.theme_watcher.mode)
        self._update_query_log_visibility()

    def _set_placeholder_cover(self) -> None:
        self.cover_image.set_from_icon_name(
            resolve_system_icon_name("cover_image"),
            Gtk.IconSize.DIALOG,
        )
        self.cover_image.set_pixel_size(72)
        for attr in ("crop_cover_btn", "scale_cover_btn", "save_cover_btn"):
            widget = getattr(self, attr, None)
            if widget is not None:
                widget.set_sensitive(False)

    def _add_form_row_widgets(
        self, grid: Gtk.Grid, row: int, label_text: str, value: str
    ) -> tuple[Gtk.Label, Gtk.Entry]:
        lbl = Gtk.Label(label=label_text)
        lbl.set_xalign(0)
        entry = Gtk.Entry()
        entry.set_text(value)
        entry.set_hexpand(True)
        grid.attach(lbl, 0, row, 1, 1)
        grid.attach(entry, 1, row, 1, 1)
        return lbl, entry

    def _add_form_row(self, grid: Gtk.Grid, row: int, label_text: str, value: str) -> Gtk.Entry:
        _lbl, entry = self._add_form_row_widgets(grid, row, label_text, value)
        return entry

    def _refresh_drives(self) -> None:
        drives = detect_optical_drives()
        if drives:
            self._updating_drives = True
            try:
                self.drive_combo.remove_all()
                for drv in drives:
                    self.drive_combo.append_text(drv)
                self.drive_combo.set_active(0)
            finally:
                self._updating_drives = False

    def _on_drive_combo_changed(self, _combo: Gtk.ComboBoxText) -> None:
        if self._updating_drives:
            return
        drv = self.drive_combo.get_active_text()
        if drv:
            self._append_query_log_ui(f"[Laufwerk] Optisches Laufwerk gewechselt auf {drv}.")
            self._refresh_cd_tray_state_async()

    def _get_selected_drive(self) -> str:
        return self.drive_combo.get_active_text() or "/dev/cdrom"

    def _update_tray_button_ui(self, is_open: bool) -> bool:
        self._cd_tray_open = bool(is_open)
        if not hasattr(self, "tray_toggle_btn"):
            return False
        if hasattr(self, "tray_btn_box") and hasattr(self, "tray_btn_icon"):
            self.tray_btn_box.remove(self.tray_btn_icon)
            self.tray_btn_icon = make_system_icon("close_tray" if is_open else "eject_disc")
            self.tray_btn_icon.show()
            self.tray_btn_box.pack_start(self.tray_btn_icon, False, False, 0)
            self.tray_btn_box.reorder_child(self.tray_btn_icon, 0)
        if hasattr(self, "tray_btn_label"):
            self.tray_btn_label.set_text("Schließen" if is_open else "Auswerfen")
        self.tray_toggle_btn.set_tooltip_text(
            "CD-Schlitten schließen (Einfahren)"
            if is_open
            else "CD-Schlitten auswerfen (Eject)"
        )
        return False

    def _start_tray_polling(self) -> None:
        if self._tray_poll_timer_id:
            return
        self._tray_poll_timer_id = GLib.timeout_add(2000, self._on_tray_poll_tick)

    def _stop_tray_polling(self) -> None:
        if self._tray_poll_timer_id:
            try:
                GLib.source_remove(self._tray_poll_timer_id)
            except Exception:
                pass
            self._tray_poll_timer_id = 0

    def _on_tray_poll_tick(self) -> bool:
        if getattr(self, "_active_module", "") != "module_rip":
            self._tray_poll_timer_id = 0
            return False
        if (
            self._tray_toggle_in_progress
            or self._batch_running
            or self._playing_track_idx is not None
            or self._preview_session is not None
            or self._hits_search_active
        ):
            return True
        self._refresh_cd_tray_state_async()
        return True

    def _refresh_cd_tray_state_async(self) -> None:
        dev = self._get_selected_drive()

        def worker() -> None:
            st = get_cd_tray_state(dev)
            if st.get("exists") and st.get("reliable"):
                new_open = bool(st.get("tray_open"))
                if new_open != self._cd_tray_open:
                    GLib.idle_add(self._update_tray_button_ui, new_open)

        threading.Thread(target=worker, daemon=True).start()

    def _on_tray_toggle_clicked(self, _btn: Gtk.Button) -> None:
        if self._tray_toggle_in_progress:
            return
        dev = self._get_selected_drive()
        current_open = self._cd_tray_open
        if not current_open and self._playing_track_idx is not None:
            self._stop_track_preview(log=False)
        self._tray_toggle_in_progress = True
        self.tray_toggle_btn.set_sensitive(False)

        def worker() -> None:
            try:
                now_open, hw_used, msg = toggle_cd_tray(dev, current_tray_open=current_open)
                GLib.idle_add(self._update_tray_button_ui, now_open)
                suffix = "" if hw_used else " (Simulierter Zustand ohne physisches Laufwerk)"
                self._append_query_log_threadsafe(f"[Laufwerk] {msg}{suffix}")
            except Exception as exc:
                self._append_query_log_threadsafe(f"[Laufwerk] Fehler beim Steuern von {dev}: {exc}")
            finally:
                def _finish_toggle() -> bool:
                    self._tray_toggle_in_progress = False
                    self.tray_toggle_btn.set_sensitive(True)
                    return False

                GLib.idle_add(_finish_toggle)

        threading.Thread(target=worker, daemon=True).start()

    def _on_disc_spin_output(self, spin: Gtk.SpinButton) -> bool:
        if self._disc_conflict:
            if spin.get_text() != "":
                spin.set_text("")
            return True
        return False

    def _refresh_track_num_labels(self) -> None:
        distinct_discs = {
            max(1, int(getattr(t, "disc_number", 1) or 1))
            for t in self.album.tracks
        }
        is_multi_disc = len(distinct_discs) > 1 or self.album.total_discs > 1
        per_disc_totals: dict[int, int] = {}
        for t in self.album.tracks:
            d = max(1, int(getattr(t, "disc_number", 1) or 1))
            per_disc_totals[d] = per_disc_totals.get(d, 0) + 1
        if hasattr(self, "hdr_num"):
            self.hdr_num.set_width_chars(7 if is_multi_disc else 4)
        for track, lbl in self._track_num_labels:
            eff_disc = max(1, int(getattr(track, "disc_number", 1) or 1))
            disc_total = per_disc_totals.get(eff_disc, len(self.album.tracks))
            num_txt = (
                f"CD{eff_disc}·{format_index_number(track.track_number, disc_total)}"
                if is_multi_disc
                else format_index_number(track.track_number, len(self.album.tracks))
            )
            lbl.set_text(num_txt)
            lbl.set_width_chars(7 if is_multi_disc else 4)

    def _sync_disc_number_from_track_selection(self, emit_log: bool = False) -> None:
        selected_tracks = [t for t in self.album.tracks if t.selected]
        distinct_discs = sorted(
            {max(1, int(getattr(t, "disc_number", 1) or 1)) for t in selected_tracks}
        )
        has_conflict = len(distinct_discs) > 1
        prev_conflict = self._disc_conflict
        prev_disc = self.album.disc_number
        self._disc_conflict = has_conflict

        ctx = self.spin_disc_number.get_style_context()
        self._updating_disc_ui = True
        try:
            if has_conflict:
                ctx.add_class("disc-conflict")
                self.spin_disc_number.set_text("")
                self.spin_disc_number.queue_draw()
            else:
                ctx.remove_class("disc-conflict")
                target_disc = (
                    distinct_discs[0]
                    if len(distinct_discs) == 1
                    else max(1, self.album.disc_number)
                )
                self.album.disc_number = target_disc
                if (
                    int(self.spin_disc_number.get_value_as_int()) != target_disc
                    or not self.spin_disc_number.get_text().strip()
                ):
                    self.spin_disc_number.set_value(target_disc)
                    self.spin_disc_number.set_text(str(target_disc))
                self.spin_disc_number.queue_draw()
        finally:
            self._updating_disc_ui = False

        self._update_multi_disc_indicator()
        self._refresh_single_disc_selector_active()
        if emit_log:
            if has_conflict and not prev_conflict:
                cd_list = ", ".join(f"CD {d}" for d in distinct_discs)
                self._append_query_log_ui(
                    f"[Multi-CD] Mehrere CDs gleichzeitig gewählt ({cd_list}) — CD-Nummer geleert."
                )
            elif (
                not has_conflict
                and len(distinct_discs) == 1
                and (prev_conflict or prev_disc != distinct_discs[0])
            ):
                self._append_query_log_ui(
                    f"[Multi-CD] Aktive CD-Nummer anhand Auswahl automatisch auf CD {distinct_discs[0]} gesetzt."
                )

    def _on_disc_values_changed(self) -> None:
        if self._updating_disc_ui:
            return
        disc_num = max(1, self.spin_disc_number.get_value_as_int())
        was_conflict = self._disc_conflict
        self._disc_conflict = False
        self.spin_disc_number.get_style_context().remove_class("disc-conflict")
        total_discs = max(
            disc_num,
            self.album.total_discs,
            self.spin_total_discs.get_value_as_int(),
        )
        changed = (
            was_conflict
            or (disc_num != self.album.disc_number)
            or (total_discs != self.album.total_discs)
        )
        self.album.disc_number = disc_num
        self.album.total_discs = total_discs
        selected_tracks = [t for t in self.album.tracks if t.selected]
        for trk in selected_tracks:
            trk.disc_number = disc_num
        self._updating_disc_ui = True
        try:
            self.spin_disc_number.set_text(str(disc_num))
            if self.spin_total_discs.get_value_as_int() < total_discs:
                self.spin_total_discs.set_value(total_discs)
        finally:
            self._updating_disc_ui = False
        self._refresh_track_num_labels()
        self._rebuild_single_disc_selector()
        self._update_multi_disc_indicator()
        if changed:
            self._append_query_log_ui(
                f"[Multi-CD] CD-Nummer gesetzt auf CD {disc_num} von {total_discs}."
            )

    def _on_total_discs_changed(self) -> None:
        if self._updating_disc_ui:
            return
        min_disc = 1 if self._disc_conflict else max(1, self.album.disc_number)
        total_discs = max(min_disc, self.spin_total_discs.get_value_as_int())
        changed = total_discs != self.album.total_discs
        self.album.total_discs = total_discs
        if self.spin_total_discs.get_value_as_int() != total_discs:
            self._updating_disc_ui = True
            try:
                self.spin_total_discs.set_value(total_discs)
            finally:
                self._updating_disc_ui = False
        self._refresh_track_num_labels()
        self._update_multi_disc_indicator()
        if changed:
            self._append_query_log_ui(
                f"[Multi-CD] Gesamtanzahl der CDs gesetzt auf {total_discs}."
            )

    def _update_multi_disc_indicator(self) -> None:
        track_discs = {
            max(1, int(getattr(t, "disc_number", 1) or 1))
            for t in self.album.tracks
        }
        selected_discs = sorted(
            {
                max(1, int(getattr(t, "disc_number", 1) or 1))
                for t in self.album.tracks
                if t.selected
            }
        )
        total = max(1, self.album.total_discs, max(track_discs) if track_discs else 1)
        disc = max(1, min(total, self.album.disc_number))

        if self._disc_conflict and len(selected_discs) > 1:
            cds_txt = ", ".join(
                f"CD {format_index_number(d, total)}" for d in selected_discs
            )
            self.multi_disc_label.set_markup(
                f"<b>Mehrere CDs ausgewählt ({cds_txt}):</b> Titel aus verschiedenen CDs gewählt"
            )
            self.multi_disc_label.show()
            self.load_disc_btn.hide()
            return

        if total > 1:
            disc_str = format_index_number(disc, total)
            total_str = format_index_number(total, total)
            self.multi_disc_label.set_markup(
                f"<b>Multi-CD-Album erkannt:</b> CD {disc_str} von {total_str}"
            )
            self.multi_disc_label.show()
            if self.album.musicbrainz_release_id and len(track_discs) <= 1:
                self.load_disc_btn.show()
            else:
                self.load_disc_btn.hide()
        else:
            self.multi_disc_label.hide()
            self.load_disc_btn.hide()

    def _rebuild_single_disc_selector(self) -> None:
        if not hasattr(self, "single_disc_box"):
            return
        for child in self.single_disc_box.get_children():
            self.single_disc_box.remove(child)
        self._single_disc_buttons.clear()
        self._single_disc_combo = None

        disc_numbers = sorted(
            {max(1, int(getattr(t, "disc_number", 1) or 1)) for t in self.album.tracks}
        )
        if len(disc_numbers) <= 1:
            self.single_disc_box.hide()
            return

        sep = Gtk.Separator(orientation=Gtk.Orientation.VERTICAL)
        sep.set_margin_start(4)
        sep.set_margin_end(4)
        self.single_disc_box.pack_start(sep, False, False, 0)

        if len(disc_numbers) <= 6:
            for d_num in disc_numbers:
                count = sum(
                    1
                    for t in self.album.tracks
                    if max(1, int(getattr(t, "disc_number", 1) or 1)) == d_num
                )
                btn = Gtk.Button(label=f"CD {d_num}")
                btn.set_tooltip_text(f"Nur Titel von CD {d_num} ({count} Titel) auswählen")
                btn.connect("clicked", lambda _b, dn=d_num: self._select_single_disc(dn))
                self._single_disc_buttons[d_num] = btn
                self.single_disc_box.pack_start(btn, False, False, 0)
        else:
            combo = Gtk.ComboBoxText()
            combo.append("", "CD wählen…")
            for d_num in disc_numbers:
                combo.append(str(d_num), f"Nur CD {d_num}")
            combo.set_active(0)
            combo.connect("changed", self._on_single_disc_combo_changed)
            self._single_disc_combo = combo
            self.single_disc_box.pack_start(combo, False, False, 0)

        self.single_disc_box.set_no_show_all(False)
        self.single_disc_box.show_all()
        self.single_disc_box.set_no_show_all(True)
        self._refresh_single_disc_selector_active()

    def _on_single_disc_combo_changed(self, combo: Gtk.ComboBoxText) -> None:
        if self._updating_single_disc_combo:
            return
        active_id = combo.get_active_id() or ""
        if active_id.isdigit():
            self._select_single_disc(int(active_id))

    def _refresh_single_disc_selector_active(self) -> None:
        selected_tracks = [t for t in self.album.tracks if t.selected]
        sel_discs = {
            max(1, int(getattr(t, "disc_number", 1) or 1)) for t in selected_tracks
        }
        exclusive_disc = None
        if len(sel_discs) == 1 and selected_tracks:
            cand = next(iter(sel_discs))
            disc_count = sum(
                1
                for t in self.album.tracks
                if max(1, int(getattr(t, "disc_number", 1) or 1)) == cand
            )
            if len(selected_tracks) == disc_count:
                exclusive_disc = cand

        for d_num, btn in self._single_disc_buttons.items():
            ctx = btn.get_style_context()
            if exclusive_disc == d_num:
                ctx.add_class("suggested-action")
            else:
                ctx.remove_class("suggested-action")

        combo = getattr(self, "_single_disc_combo", None)
        if combo is not None:
            self._updating_single_disc_combo = True
            try:
                combo.set_active_id(str(exclusive_disc) if exclusive_disc is not None else "")
            finally:
                self._updating_single_disc_combo = False

    def _select_single_disc(self, disc_num: int) -> None:
        self._updating_select_all = True
        count = 0
        try:
            for idx, track in enumerate(self.album.tracks):
                t_disc = max(1, int(getattr(track, "disc_number", 1) or 1))
                is_match = t_disc == disc_num
                track.selected = is_match
                if is_match:
                    count += 1
                if idx < len(self._track_checkbuttons):
                    self._track_checkbuttons[idx].set_active(is_match)
        finally:
            self._updating_select_all = False
        self._sync_select_all_state()
        self._sync_disc_number_from_track_selection(emit_log=False)
        self._append_query_log_ui(
            f"[Auswahl] Nur CD {format_index_number(disc_num, self.album.total_discs)} ({count} Titel) ausgewählt."
        )

    def _on_select_all_toggled(self, btn: Gtk.CheckButton) -> None:
        if self._updating_select_all:
            return
        active = btn.get_active()
        self._updating_select_all = True
        try:
            btn.set_inconsistent(False)
            for idx, track in enumerate(self.album.tracks):
                track.selected = active
                if idx < len(self._track_checkbuttons):
                    self._track_checkbuttons[idx].set_active(active)
        finally:
            self._updating_select_all = False
        self._update_track_header_count()
        self._sync_disc_number_from_track_selection(emit_log=True)
        state_txt = "ausgewählt" if active else "abgewählt"
        self._append_query_log_ui(f"[Auswahl] Alle {len(self.album.tracks)} Titel {state_txt}.")

    def _on_track_check_toggled(self, btn: Gtk.CheckButton, track: TrackMetadata) -> None:
        track.selected = btn.get_active()
        if not self._updating_select_all:
            self._sync_select_all_state()
            self._sync_disc_number_from_track_selection(emit_log=True)
            state_txt = "ausgewählt" if track.selected else "abgewählt"
            disc_prefix = (
                f"CD{max(1, int(getattr(track, 'disc_number', 1) or 1))}·"
                if self.album.total_discs > 1
                else ""
            )
            self._append_query_log_ui(
                f"[Auswahl] Titel {disc_prefix}#{track.track_number:02d} „{track.title}“ {state_txt}."
            )

    def _sync_select_all_state(self) -> None:
        total = len(self.album.tracks)
        selected = sum(1 for t in self.album.tracks if t.selected)
        self._updating_select_all = True
        try:
            if total == 0:
                self.select_all_check.set_sensitive(False)
                self.select_all_check.set_inconsistent(False)
                self.select_all_check.set_active(False)
            elif selected == 0:
                self.select_all_check.set_sensitive(True)
                self.select_all_check.set_inconsistent(False)
                self.select_all_check.set_active(False)
            elif selected == total:
                self.select_all_check.set_sensitive(True)
                self.select_all_check.set_inconsistent(False)
                self.select_all_check.set_active(True)
            else:
                self.select_all_check.set_sensitive(True)
                self.select_all_check.set_inconsistent(True)
        finally:
            self._updating_select_all = False
        self._update_track_header_count()

    def _update_track_header_count(self) -> None:
        total = len(self.album.tracks)
        selected = sum(1 for t in self.album.tracks if t.selected)
        if total > 0:
            self.track_header_label.set_markup(
                f"<b>Titel- &amp; Metadaten-Verwaltung ({selected}/{total} ausgewählt)</b>"
            )
        else:
            self.track_header_label.set_markup(
                "<b>Titel- &amp; Metadaten-Verwaltung (WAV/FLAC hierher ziehen)</b>"
            )
        locked = self._batch_running and not self._batch_paused
        verifying = self._verify_cancel_event is not None
        shazaming = self._shazam_cancel_event is not None
        analyzing_mb = self._mb_tracks_cancel_event is not None
        has_sel_or_album_only = (not locked) and ((total == 0) or (selected > 0))
        if hasattr(self, "rip_btn"):
            self.rip_btn.set_sensitive((not locked) and selected > 0)
        if hasattr(self, "analyze_tracks_btn"):
            self.analyze_tracks_btn.set_sensitive(
                (not locked) and (not shazaming) and (not analyzing_mb) and total > 0 and selected > 0
            )
        if hasattr(self, "split_artists_btn"):
            self.split_artists_btn.set_sensitive((not verifying) and has_sel_or_album_only)
        for btn_attr in (
            "verify_artists_btn",
            "verify_composer_btn",
            "verify_orchestra_btn",
            "verify_conductor_btn",
        ):
            if hasattr(self, btn_attr):
                getattr(self, btn_attr).set_sensitive((not verifying) and has_sel_or_album_only)
        for transfer_btn in getattr(self, "_left_field_transfer_buttons", []):
            transfer_btn.set_sensitive((not locked) and total > 0 and selected > 0)

    def _on_open_settings_clicked(self, _btn: Gtk.Button) -> None:
        self._switch_to_module("settings")

    def _apply_roman_preference_to_album(
        self, album: AlbumMetadata, enabled: Optional[bool] = None
    ) -> int:
        is_enabled = (
            bool(enabled)
            if enabled is not None
            else bool(getattr(self.settings, "convert_roman_numerals", True))
        )
        if not is_enabled:
            return 0
        changed = 0
        if album.title:
            next_album_title = convert_roman_numerals_in_title(album.title)
            if next_album_title != album.title:
                album.title = next_album_title
                changed += 1
        for trk in album.tracks:
            if trk.title:
                next_trk_title = convert_roman_numerals_in_title(trk.title)
                if next_trk_title != trk.title:
                    trk.title = next_trk_title
                    changed += 1
            if trk.original_title:
                trk.original_title = convert_roman_numerals_in_title(trk.original_title)
            if trk.shazam_title:
                trk.shazam_title = convert_roman_numerals_in_title(trk.shazam_title)
        return changed

    def _on_settings_applied(self, new_settings: ExportSettings, new_theme_mode: str) -> None:
        was_roman = bool(getattr(self.settings, "convert_roman_numerals", True))
        self.settings = new_settings
        self.theme_watcher.set_mode(new_theme_mode)
        self._update_query_log_tag_colors()
        self._apply_left_tag_field_visibility()
        self._update_query_log_visibility()
        cov_max_dim = normalize_cover_max_dimension(
            getattr(self.settings, "cover_max_dimension", DEFAULT_COVER_MAX_DIMENSION)
        )
        eff_threads = normalize_max_threads(
            getattr(self.settings, "max_threads", DEFAULT_MAX_THREADS)
        )
        if hasattr(self, "batch_manager"):
            self.batch_manager.set_max_workers(eff_threads)
        if hasattr(self, "converter_manager"):
            self.converter_manager.set_max_workers(eff_threads)
        if hasattr(self, "repair_manager"):
            self.repair_manager.set_max_workers(eff_threads)
            self.repair_manager.cover_max_dimension = cov_max_dim
        if hasattr(self, "rep_optimize_cover_chk"):
            self.rep_optimize_cover_chk.set_label(
                f"Cover-Optimierung (≤ {cov_max_dim}×{cov_max_dim} px / ≤ 1 MB)"
            )
        if hasattr(self, "conv_outdir_chooser"):
            conv_dir = getattr(self.settings, "output_dir_convert", DEFAULT_OUTPUT_DIR_CONVERT)
            if conv_dir.exists():
                self.conv_outdir_chooser.set_filename(str(conv_dir))
            elif conv_dir.parent.exists():
                self.conv_outdir_chooser.set_filename(str(conv_dir.parent))

        norm_state = (
            f"{self.settings.normalize_target_lufs:.1f} LUFS"
            if self.settings.normalize_album
            else "Aus"
        )
        roman_state = "Ein" if self.settings.convert_roman_numerals else "Aus"
        visible_cnt = len(
            normalize_visible_left_tag_fields(
                getattr(self.settings, "visible_left_tag_fields", DEFAULT_VISIBLE_LEFT_TAG_FIELDS)
            )
        )
        cov_prov_cnt = len(
            normalize_cover_providers(
                getattr(self.settings, "cover_providers", DEFAULT_COVER_PROVIDERS)
            )
        )
        if getattr(self.settings, "mb_use_local_mirror", False):
            mb_mode_txt = (
                f"Lokal ({self.settings.mb_local_host}:{self.settings.mb_local_port}, "
                f"Suchindex={'Ein' if getattr(self.settings, 'mb_local_search_index_enabled', False) else 'Aus'}, "
                f"Fallback={'Ein' if getattr(self.settings, 'mb_fallback_to_official', True) else 'Aus'})"
            )
        else:
            mb_mode_txt = "Entfernt (musicbrainz.org)"
        self._append_query_log_ui(
            f"[Einstellungen] Gespeichert: Format={self.settings.export_format.value.upper()}, "
            f"MusicBrainz={mb_mode_txt}, "
            f"Zielordner={self.settings.output_dir}, Import-Ordner={self.settings.last_import_dir}, "
            f"Cover-Max={cov_max_dim} px, Cover-Quellen={cov_prov_cnt}/{len(COVER_PROVIDER_OPTIONS)}, "
            f"Threads={eff_threads}, Normalisierung={norm_state}, "
            f"Römische Ziffern={roman_state}, Tag-Felder={visible_cnt}, Farbschema={new_theme_mode}, "
            f"Protokoll={'Ein' if self.settings.show_query_log else 'Aus'}."
        )
        if not was_roman and self.settings.convert_roman_numerals:
            changed = self._apply_roman_preference_to_album(self.album, enabled=True)
            if changed > 0:
                self._populate_album_ui()
                self._append_query_log_ui(
                    f"[Titel-Normalisierung] Römische Ziffern im geladenen Album in arabische Zahlen umgewandelt ({changed} Anpassung(en))."
                )

    def _on_album_field_focus_out(self, entry: Gtk.Entry, _event: object, field_label: str) -> bool:
        val = entry.get_text().strip()
        self._append_query_log_ui(f"[Metadaten] {field_label} aktualisiert: „{val or '—'}“.")
        return False

    def _on_artist_entry_focus_out(
        self,
        entry: Gtk.Entry,
        _event: object,
        field_label: str = "Interpret",
    ) -> bool:
        raw = entry.get_text().strip()
        if raw:
            normalized = normalize_multi_artist(raw)
            if normalized != raw:
                entry.set_text(normalized)
            self._append_query_log_ui(f"[Metadaten] {field_label} gesetzt: „{normalized}“.")
        return False

    _LEFT_ALBUM_DIRECT_ATTRS: dict[str, str] = {
        "title": "title",
        "albumArtist": "album_artist",
        "artist": "artist",
        "year": "year",
        "genre": "genre",
        "label": "label",
        "cddbId": "cddb_id",
        "musicbrainzReleaseId": "musicbrainz_release_id",
        "discogsId": "discogs_release_id",
        "asin": "asin",
        "barcode": "barcode",
        "albumArtistSort": "album_artist_sort",
        "discSubtitle": "disc_subtitle",
        "releaseDate": "release_date",
        "originalDate": "original_date",
        "catalogNumber": "catalog_number",
        "country": "country",
        "status": "status",
        "releaseType": "release_type",
        "mediaFormat": "media_format",
        "script": "script",
        "language": "language",
        "composer": "composer",
        "orchestra": "orchestra",
        "conductor": "conductor",
        "musicbrainzReleaseGroupId": "musicbrainz_release_group_id",
        "musicbrainzAlbumArtistId": "musicbrainz_album_artist_id",
        "musicbrainzDiscId": "musicbrainz_disc_id",
    }

    _LEFT_ALBUM_EXTRA_TAG_KEYS: dict[str, str] = {
        "albumSort": "ALBUMSORT",
        "subtitle": "SUBTITLE",
        "copyright": "COPYRIGHT",
        "grouping": "GROUPING",
        "compilation": "COMPILATION",
        "mood": "MOOD",
        "comment": "COMMENT",
        "lyricist": "LYRICIST",
        "writer": "WRITER",
        "producer": "PRODUCER",
        "arranger": "ARRANGER",
        "engineer": "ENGINEER",
        "mixer": "MIXER",
        "djmixer": "DJMIXER",
        "remixer": "REMIXER",
        "work": "WORK",
    }

    def _get_album_left_field_value(self, field_id: str) -> str:
        if field_id in self._LEFT_ALBUM_DIRECT_ATTRS:
            return str(getattr(self.album, self._LEFT_ALBUM_DIRECT_ATTRS[field_id], "") or "")
        extra_key = self._LEFT_ALBUM_EXTRA_TAG_KEYS.get(field_id)
        if extra_key:
            vals = self.album.extra_tags.get(extra_key) or []
            return "; ".join(str(v) for v in vals if str(v).strip())
        return ""

    def _set_album_left_field_value(self, field_id: str, value: str) -> None:
        if field_id in self._LEFT_ALBUM_DIRECT_ATTRS:
            setattr(self.album, self._LEFT_ALBUM_DIRECT_ATTRS[field_id], value)
            return
        extra_key = self._LEFT_ALBUM_EXTRA_TAG_KEYS.get(field_id)
        if extra_key:
            parts = [p.strip() for p in str(value or "").split(";") if p.strip()]
            if parts:
                self.album.extra_tags[extra_key] = parts
            else:
                self.album.extra_tags.pop(extra_key, None)

    def _apply_left_tag_field_visibility(self) -> None:
        visible_set = set(
            normalize_visible_left_tag_fields(
                getattr(self.settings, "visible_left_tag_fields", DEFAULT_VISIBLE_LEFT_TAG_FIELDS)
            )
        )
        for fid, widgets in getattr(self, "_left_tag_field_rows", {}).items():
            show_row = fid in visible_set
            for w in widgets:
                w.set_no_show_all(not show_row)
                w.set_visible(show_row)
        self._update_classical_visibility()
        if hasattr(self, "multi_disc_label") and "discNumber" not in visible_set:
            self.multi_disc_label.set_no_show_all(True)
            self.multi_disc_label.hide()

    def _update_classical_visibility(self) -> None:
        visible_set = set(
            normalize_visible_left_tag_fields(
                getattr(self.settings, "visible_left_tag_fields", DEFAULT_VISIBLE_LEFT_TAG_FIELDS)
            )
        )
        show_classical_box = bool(
            self.album.is_classical
            or ("composer" in visible_set)
            or ("orchestra" in visible_set)
            or ("conductor" in visible_set)
        )
        if show_classical_box:
            self.classical_frame.set_no_show_all(False)
            self.classical_frame.show_all()
            for cid, widgets in getattr(self, "_classical_field_rows", {}).items():
                show_c = bool(self.album.is_classical or (cid in visible_set))
                for w in widgets:
                    w.set_no_show_all(not show_c)
                    w.set_visible(show_c)
        else:
            self.classical_frame.hide()
            self.classical_frame.set_no_show_all(True)

        if self.album.is_classical:
            self.verify_artists_btn.hide()
            self.verify_artists_btn.set_no_show_all(True)
            for btn in (
                self.verify_composer_btn,
                self.verify_orchestra_btn,
                self.verify_conductor_btn,
            ):
                btn.set_no_show_all(False)
                btn.show_all()
        else:
            for btn in (
                self.verify_composer_btn,
                self.verify_orchestra_btn,
                self.verify_conductor_btn,
            ):
                btn.hide()
                btn.set_no_show_all(True)
            self.verify_artists_btn.set_no_show_all(False)
            self.verify_artists_btn.show_all()

        # Rechte 3. Spalte ("Track-Felder"): Komponist, Orchester, Dirigent nur bei aktiviertem Klassikalbum einblenden
        self._update_track_inspector_section_visibility()

        if self._verify_cancel_event is not None and not self._verify_cancel_event.is_set():
            self.verify_stop_btn.set_no_show_all(False)
            self.verify_stop_btn.show_all()
        else:
            self.verify_stop_btn.hide()
            self.verify_stop_btn.set_no_show_all(True)

        if self._shazam_cancel_event is not None and not self._shazam_cancel_event.is_set():
            self.shazam_stop_btn.set_no_show_all(False)
            self.shazam_stop_btn.show_all()
        else:
            self.shazam_stop_btn.hide()
            self.shazam_stop_btn.set_no_show_all(True)

    def _update_track_inspector_section_visibility(self) -> None:
        if not hasattr(self, "track_insp_classical_box"):
            return
        if self.album.is_classical:
            self.track_insp_classical_box.set_no_show_all(False)
            self.track_insp_classical_box.show_all()
        else:
            self.track_insp_classical_box.hide()
            self.track_insp_classical_box.set_no_show_all(True)

        has_pop = bool(getattr(self, "_has_populated_track_tags", False))
        has_any_tags = (
            has_pop
            or bool(getattr(self, "_has_track_id_tags", False))
            or bool(getattr(self, "_has_track_rg_tags", False))
        )
        if hasattr(self, "track_insp_populated_section"):
            if has_pop:
                self.track_insp_populated_section.set_no_show_all(False)
                self.track_insp_populated_section.show_all()
            else:
                self.track_insp_populated_section.hide()
                self.track_insp_populated_section.set_no_show_all(True)

        self._sync_track_inspector_subdisplays()

        if hasattr(self, "track_insp_hint_box") and hasattr(self, "track_insp_compact_hint_lbl"):
            if self.album.is_classical:
                self.track_insp_hint_box.hide()
                self.track_insp_hint_box.set_no_show_all(True)
                self.track_insp_compact_hint_lbl.hide()
                self.track_insp_compact_hint_lbl.set_no_show_all(True)
            elif has_any_tags:
                self.track_insp_hint_box.hide()
                self.track_insp_hint_box.set_no_show_all(True)
                self.track_insp_compact_hint_lbl.set_no_show_all(False)
                self.track_insp_compact_hint_lbl.show_all()
            else:
                self.track_insp_compact_hint_lbl.hide()
                self.track_insp_compact_hint_lbl.set_no_show_all(True)
                self.track_insp_hint_box.set_no_show_all(False)
                self.track_insp_hint_box.show_all()

    def _toggle_track_inspector_subdisplay(self, which: str) -> None:
        if which == "ids":
            self._track_ids_display_open = not bool(getattr(self, "_track_ids_display_open", False))
        elif which == "replaygain":
            self._track_rg_display_open = not bool(getattr(self, "_track_rg_display_open", False))
        self._sync_track_inspector_subdisplays()

    def _sync_track_inspector_subdisplays(self) -> None:
        if hasattr(self, "track_ids_body"):
            is_open = bool(getattr(self, "_track_ids_display_open", False))
            self.track_ids_toggle_glyph.set_text("−" if is_open else "+")
            if is_open:
                self.track_ids_header_sep.set_no_show_all(False)
                self.track_ids_header_sep.show()
                self.track_ids_body.set_no_show_all(False)
                self.track_ids_body.show_all()
            else:
                self.track_ids_header_sep.hide()
                self.track_ids_header_sep.set_no_show_all(True)
                self.track_ids_body.hide()
                self.track_ids_body.set_no_show_all(True)

        if hasattr(self, "track_rg_body"):
            is_open = bool(getattr(self, "_track_rg_display_open", False))
            self.track_rg_toggle_glyph.set_text("−" if is_open else "+")
            if is_open:
                self.track_rg_header_sep.set_no_show_all(False)
                self.track_rg_header_sep.show()
                self.track_rg_body.set_no_show_all(False)
                self.track_rg_body.show_all()
            else:
                self.track_rg_header_sep.hide()
                self.track_rg_header_sep.set_no_show_all(True)
                self.track_rg_body.hide()
                self.track_rg_body.set_no_show_all(True)

    @staticmethod
    def _get_collapsed_rail_width(widget: Optional[Gtk.Widget], default_w: int = 38) -> int:
        if widget is None:
            return default_w
        try:
            pref = widget.get_preferred_width()
            if isinstance(pref, (tuple, list)) and len(pref) >= 1:
                min_w = int(pref[0])
                if min_w > 0:
                    return max(36, min(120, min_w))
        except Exception:
            pass
        return default_w

    def _schedule_outer_paned_sync(self) -> None:
        if getattr(self, "_left_paned_sync_idle_id", 0):
            return
        self._left_paned_sync_idle_id = GLib.idle_add(self._sync_outer_paned_position)

    def _sync_outer_paned_position(self) -> bool:
        self._left_paned_sync_idle_id = 0
        if not hasattr(self, "outer_paned"):
            return False
        is_cover_only = getattr(self, "_active_module", "") == "module_cover"
        alloc_w = self.outer_paned.get_allocated_width()
        min_left_w = 400
        collapsed_w = self._get_collapsed_rail_width(
            getattr(self, "left_sidebar_collapsed", None), 38
        )
        if alloc_w < 160:
            win_w = max(1280, self.get_allocated_width())
            target_pos = (
                int(round(win_w * 0.30))
                if is_cover_only
                else (
                    collapsed_w
                    if self._left_panel_collapsed
                    else max(min_left_w, int(self._left_panel_width))
                )
            )
        else:
            if is_cover_only:
                target_pos = max(min_left_w, int(round(alloc_w * 0.30)))
            elif self._left_panel_collapsed:
                target_pos = collapsed_w
            else:
                max_left = max(min_left_w, alloc_w - 320)
                target_pos = max(min_left_w, min(int(self._left_panel_width), max_left))
        cur_pos = self.outer_paned.get_position()
        if abs(cur_pos - target_pos) > 1:
            self._updating_left_paned_pos = True
            try:
                self.outer_paned.set_position(target_pos)
            finally:
                self._updating_left_paned_pos = False
        return False

    def _on_outer_paned_size_allocate(self, paned: Gtk.Paned, alloc: Gdk.Rectangle) -> None:
        is_cover_only = getattr(self, "_active_module", "") == "module_cover"
        if is_cover_only or alloc.width < 160:
            return
        # Niemals set_position() synchron innerhalb von size-allocate aufrufen (verhindert GTK3-Layout-Hänger)
        if self._left_panel_collapsed:
            collapsed_w = self._get_collapsed_rail_width(
                getattr(self, "left_sidebar_collapsed", None), 38
            )
            if paned.get_position() > collapsed_w + 4:
                self._schedule_outer_paned_sync()

    def _on_outer_paned_position_changed(self, paned: Gtk.Paned, _pspec) -> None:
        is_cover_only = getattr(self, "_active_module", "") == "module_cover"
        if self._updating_left_paned_pos or self._left_panel_collapsed or is_cover_only:
            return
        pos = paned.get_position()
        alloc_w = paned.get_allocated_width()
        if alloc_w >= 450 and 400 <= pos <= alloc_w - 220:
            self._left_panel_width = int(pos)

    def _apply_left_panel_collapse_state(self, force: bool = False) -> None:
        if not hasattr(self, "left_sidebar_expanded") or not hasattr(self, "left_sidebar_collapsed"):
            return
        is_cover_only = getattr(self, "_active_module", "") == "module_cover"
        effective_collapsed = (not is_cover_only) and self._left_panel_collapsed
        desired_state = (effective_collapsed, is_cover_only)
        if not force and getattr(self, "_left_panel_applied_state", None) == desired_state:
            return
        self._left_panel_applied_state = desired_state
        if effective_collapsed:
            self.left_sidebar_expanded.set_size_request(-1, -1)
            self.left_sidebar_expanded.set_no_show_all(True)
            self.left_sidebar_expanded.hide()
            self.left_sidebar_collapsed.set_size_request(36, -1)
            self.left_sidebar_collapsed.set_no_show_all(False)
            self.left_sidebar_collapsed.show_all()
            if hasattr(self, "outer_paned"):
                try:
                    self.outer_paned.child_set_property(
                        self.left_sidebar_container, "shrink", True
                    )
                except Exception:
                    pass
        else:
            self.left_sidebar_collapsed.set_no_show_all(True)
            self.left_sidebar_collapsed.hide()
            self.left_sidebar_expanded.set_size_request(400, -1)
            self.left_sidebar_expanded.set_no_show_all(False)
            self.left_sidebar_expanded.show()
            if hasattr(self, "outer_paned"):
                try:
                    self.outer_paned.child_set_property(
                        self.left_sidebar_container, "shrink", False
                    )
                except Exception:
                    pass
            if hasattr(self, "left_sidebar_header_box"):
                self.left_sidebar_header_box.set_visible(not is_cover_only)
                self.left_sidebar_header_sep.set_visible(not is_cover_only)
            if hasattr(self, "meta_grid"):
                self.meta_grid.set_visible(not is_cover_only)
        self.left_sidebar_container.queue_resize()
        self._schedule_outer_paned_sync()

    def _set_left_panel_collapsed(self, collapsed: bool) -> None:
        self._left_panel_collapsed = bool(collapsed)
        self._apply_left_panel_collapse_state(force=True)

    def _schedule_right_paned_sync(self) -> None:
        if getattr(self, "_right_paned_sync_idle_id", 0):
            return
        self._right_paned_sync_idle_id = GLib.idle_add(self._sync_right_paned_position)

    def _sync_right_paned_position(self) -> bool:
        self._right_paned_sync_idle_id = 0
        if not hasattr(self, "right_paned") or not hasattr(self, "track_inspector_container"):
            return False
        if not self.track_inspector_container.get_visible():
            return False
        alloc_w = self.right_paned.get_allocated_width()
        if alloc_w < 120:
            return False
        min_right_w = 400
        if self._track_panel_collapsed:
            target_right_w = self._get_collapsed_rail_width(
                getattr(self, "track_inspector_collapsed", None), 38
            )
        else:
            max_right_w = max(min_right_w, alloc_w - 260)
            target_right_w = max(min_right_w, min(int(self._track_panel_width), max_right_w))
        target_pos = max(120, alloc_w - target_right_w)
        if abs(self.right_paned.get_position() - target_pos) > 1:
            self._updating_right_paned_pos = True
            try:
                self.right_paned.set_position(target_pos)
            finally:
                self._updating_right_paned_pos = False
        return False

    def _on_right_paned_size_allocate(self, paned: Gtk.Paned, alloc: Gdk.Rectangle) -> None:
        if not hasattr(self, "track_inspector_container"):
            return
        if not self.track_inspector_container.get_visible() or alloc.width < 120:
            return
        if self._track_panel_collapsed:
            collapsed_w = self._get_collapsed_rail_width(
                getattr(self, "track_inspector_collapsed", None), 38
            )
            target_pos = max(120, alloc.width - collapsed_w)
            if abs(paned.get_position() - target_pos) > 4:
                self._schedule_right_paned_sync()
        elif not self._right_paned_initialized:
            self._right_paned_initialized = True
            self._schedule_right_paned_sync()

    def _on_right_paned_position_changed(self, paned: Gtk.Paned, _pspec) -> None:
        if (
            self._updating_right_paned_pos
            or self._track_panel_collapsed
            or not self.track_inspector_container.get_visible()
        ):
            return
        alloc_w = paned.get_allocated_width()
        if alloc_w < 450:
            return
        right_w = alloc_w - paned.get_position()
        if 400 <= right_w <= alloc_w - 180:
            self._track_panel_width = int(right_w)

    def _apply_track_panel_collapse_state(self, force: bool = False) -> None:
        if not hasattr(self, "track_inspector_expanded") or not hasattr(self, "track_inspector_collapsed"):
            return
        collapsed = bool(self._track_panel_collapsed)
        if not force and getattr(self, "_track_panel_applied_collapsed", None) == collapsed:
            return
        self._track_panel_applied_collapsed = collapsed
        if collapsed:
            self.track_inspector_expanded.set_size_request(-1, -1)
            self.track_inspector_expanded.set_no_show_all(True)
            self.track_inspector_expanded.hide()
            self.track_inspector_collapsed.set_size_request(36, -1)
            self.track_inspector_collapsed.set_no_show_all(False)
            self.track_inspector_collapsed.show_all()
            if hasattr(self, "right_paned"):
                try:
                    self.right_paned.child_set_property(
                        self.track_inspector_container, "shrink", True
                    )
                except Exception:
                    pass
        else:
            self.track_inspector_collapsed.set_no_show_all(True)
            self.track_inspector_collapsed.hide()
            self.track_inspector_expanded.set_size_request(400, -1)
            self.track_inspector_expanded.set_no_show_all(False)
            self.track_inspector_expanded.show()
            if hasattr(self, "right_paned"):
                try:
                    self.right_paned.child_set_property(
                        self.track_inspector_container, "shrink", False
                    )
                except Exception:
                    pass
            self._update_track_inspector_section_visibility()
        self.track_inspector_container.queue_resize()
        self._schedule_right_paned_sync()

    def _set_track_panel_collapsed(self, collapsed: bool) -> None:
        self._track_panel_collapsed = bool(collapsed)
        self._apply_track_panel_collapse_state(force=True)
        if not collapsed:
            self._sync_track_inspector_ui()

    def _get_active_inspector_track(self) -> Optional[TrackMetadata]:
        if not self.album.tracks:
            self._active_track_idx = 0
            return None
        if self._active_track_idx < 0 or self._active_track_idx >= len(self.album.tracks):
            self._active_track_idx = 0
        return self.album.tracks[self._active_track_idx]

    def _update_active_track_row_highlight(self) -> None:
        for row_idx, w in enumerate(getattr(self, "_track_row_widgets", [])):
            ctx = w.get_style_context()
            if row_idx == self._active_track_idx:
                ctx.add_class("track-row-active")
            else:
                ctx.remove_class("track-row-active")

    def _select_active_track(self, idx: int) -> None:
        if not self.album.tracks:
            return
        clamped = max(0, min(idx, len(self.album.tracks) - 1))
        if clamped != self._active_track_idx:
            self._active_track_idx = clamped
            self._update_active_track_row_highlight()
            self._sync_track_inspector_ui()

    def _step_active_track(self, delta: int) -> None:
        if not self.album.tracks:
            return
        self._select_active_track(self._active_track_idx + delta)

    def _on_track_insp_combo_changed(self, combo: Gtk.ComboBoxText) -> None:
        if self._syncing_track_inspector:
            return
        idx = combo.get_active()
        if idx >= 0:
            self._select_active_track(idx)

    @staticmethod
    def _format_extra_tag_label(raw_key: str) -> str:
        k_up = (raw_key or "").strip().upper()
        known_labels = {
            "ARRANGER": "Arrangeur",
            "ENGINEER": "Toningenieur",
            "MIXER": "Abmischung",
            "DJMIXER": "DJ-Mix",
            "REMIXER": "Remixer",
            "PERFORMER": "Mitwirkende",
            "COMMENT": "Kommentar",
            "DESCRIPTION": "Beschreibung",
            "MOOD": "Stimmung",
            "BPM": "BPM",
            "TBPM": "BPM",
            "INITIALKEY": "Tonart",
            "TKEY": "Tonart",
            "GROUPING": "Gruppierung",
            "COPYRIGHT": "Copyright",
            "LYRICS": "Liedtext",
            "UNSYNCEDLYRICS": "Liedtext",
            "LANGUAGE": "Sprache",
            "SUBTITLE": "Untertitel",
            "MOVEMENT": "Satz",
            "MOVEMENTNAME": "Satzname",
            "WORK": "Werk",
            "ENCODEDBY": "Kodiert von",
            "ENCODER": "Encoder",
            "ACOUSTID_ID": "AcoustID",
            "ACOUSTID_FINGERPRINT": "AcoustID Fingerprint",
            "ACOUSTID_PUID": "AcoustID PUID",
            "REPLAYGAIN_TRACK_GAIN": "Track Gain",
            "REPLAYGAIN_TRACK_PEAK": "Track Peak",
            "REPLAYGAIN_TRACK_RANGE": "Track Range",
            "REPLAYGAIN_ALBUM_GAIN": "Album Gain",
            "REPLAYGAIN_ALBUM_PEAK": "Album Peak",
            "REPLAYGAIN_ALBUM_RANGE": "Album Range",
            "REPLAYGAIN_REFERENCE_LOUDNESS": "Referenzlautheit",
            "REPLAYGAIN_MINMAX": "Track Min/Max",
            "REPLAYGAIN_ALBUM_MINMAX": "Album Min/Max",
            "REPLAYGAIN_UNDO": "ReplayGain Undo",
            "R128_TRACK_GAIN": "R128 Track Gain",
            "R128_ALBUM_GAIN": "R128 Album Gain",
        }
        k_norm = k_up.replace(" ", "_")
        if k_norm in known_labels:
            return known_labels[k_norm]
        if k_norm.startswith("MUSICBRAINZ_"):
            suffix = k_norm[len("MUSICBRAINZ_"):].replace("_", " ").strip().title()
            return f"MB {suffix}" if suffix else "MusicBrainz-ID"
        if k_up.startswith("PERFORMER:"):
            role = raw_key.split(":", 1)[1].strip()
            return f"Mitwirkende ({role})" if role else "Mitwirkende"
        return raw_key.replace("_", " ").strip().title() or raw_key

    def _rebuild_populated_track_tags_ui(self, active_trk: Optional[TrackMetadata]) -> None:
        if not hasattr(self, "track_insp_populated_list"):
            return
        for child in list(self.track_insp_populated_list.get_children()):
            self.track_insp_populated_list.remove(child)
        if hasattr(self, "track_ids_list"):
            for child in list(self.track_ids_list.get_children()):
                self.track_ids_list.remove(child)
        if hasattr(self, "track_rg_list"):
            for child in list(self.track_rg_list.get_children()):
                self.track_rg_list.remove(child)
        self._has_populated_track_tags = False
        self._has_track_id_tags = False
        self._has_track_rg_tags = False

        if active_trk is None:
            if hasattr(self, "track_ids_summary_label"):
                self.track_ids_summary_label.set_markup("<b>ID's</b>")
            if hasattr(self, "track_rg_summary_label"):
                self.track_rg_summary_label.set_markup("<b>Replaygain</b>")
            if hasattr(self, "track_ids_list"):
                empty_ids = Gtk.Label(label="Keine MusicBrainz-IDs oder AcoustID-Werte für diesen Track vorhanden.")
                empty_ids.set_xalign(0)
                empty_ids.set_line_wrap(True)
                empty_ids.set_width_chars(10)
                empty_ids.set_max_width_chars(24)
                empty_ids.get_style_context().add_class("dim-label")
                empty_ids.show()
                self.track_ids_list.pack_start(empty_ids, False, False, 0)
            if hasattr(self, "track_rg_list"):
                empty_rg = Gtk.Label(label="Keine ReplayGain-Werte für diesen Track vorhanden.")
                empty_rg.set_xalign(0)
                empty_rg.set_line_wrap(True)
                empty_rg.set_width_chars(10)
                empty_rg.set_max_width_chars(24)
                empty_rg.get_style_context().add_class("dim-label")
                empty_rg.show()
                self.track_rg_list.pack_start(empty_rg, False, False, 0)
            return

        direct_specs: list[tuple[str, str, bool]] = [
            ("artist_sort", "Interpret-Sortierung", False),
            ("isrc", "ISRC", False),
            ("work", "Werk", False),
            ("work_language", "Werk-Sprache", False),
            ("disc_subtitle", "Disc-Untertitel", False),
        ]
        if not self.album.is_classical:
            direct_specs.extend(
                [
                    ("composer", "Komponist", True),
                    ("orchestra", "Orchester", True),
                    ("conductor", "Dirigent", True),
                ]
            )
        direct_specs.extend(
            [
                ("lyricist", "Texter", True),
                ("writer", "Autor", True),
                ("producer", "Produzent", True),
            ]
        )

        id_direct_specs: list[tuple[str, str]] = [
            ("musicbrainz_recording_id", "MB Recording-ID"),
            ("musicbrainz_track_id", "MB Track-ID"),
            ("musicbrainz_artist_id", "MB Artist-ID"),
            ("musicbrainz_work_id", "MB Werk-ID"),
            ("musicbrainz_composer_id", "MB Komponist-ID"),
        ]

        item_count = 0
        id_count = 0
        rg_count = 0

        for attr_name, field_label, normalize_people in direct_specs:
            raw_val = str(getattr(active_trk, attr_name, "") or "").strip()
            if not raw_val:
                continue
            item_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
            lbl = Gtk.Label(label=f"{field_label}:")
            lbl.set_xalign(0)
            lbl.set_ellipsize(Pango.EllipsizeMode.END)
            lbl.get_style_context().add_class("dim-label")
            ent = Gtk.Entry()
            ent.set_width_chars(8)
            ent.set_hexpand(True)
            ent.set_text(raw_val)
            ent.set_tooltip_text(f"{field_label}: {raw_val}")
            ent.connect("changed", self._on_inspector_track_field_changed, attr_name)
            if normalize_people:
                ent.connect(
                    "focus-out-event",
                    self._on_inspector_track_field_focus_out,
                    attr_name,
                    field_label,
                )
            item_box.pack_start(lbl, False, False, 0)
            item_box.pack_start(ent, False, False, 0)
            self.track_insp_populated_list.pack_start(item_box, False, False, 0)
            item_count += 1

        if hasattr(self, "track_ids_list"):
            for attr_name, field_label in id_direct_specs:
                raw_val = str(getattr(active_trk, attr_name, "") or "").strip()
                if not raw_val:
                    continue
                item_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
                lbl = Gtk.Label(label=f"{field_label}:")
                lbl.set_xalign(0)
                lbl.set_ellipsize(Pango.EllipsizeMode.END)
                lbl.get_style_context().add_class("dim-label")
                ent = Gtk.Entry()
                ent.set_width_chars(8)
                ent.set_hexpand(True)
                ent.set_text(raw_val)
                ent.set_tooltip_text(f"{field_label}: {raw_val}")
                ent.connect("changed", self._on_inspector_track_field_changed, attr_name)
                item_box.pack_start(lbl, False, False, 0)
                item_box.pack_start(ent, False, False, 0)
                item_box.show_all()
                self.track_ids_list.pack_start(item_box, False, False, 0)
                id_count += 1

        skip_extra_keys = {
            "TITLE",
            "ARTIST",
            "ARTISTS",
            "ARTISTSORT",
            "GENRE",
            "TRACKNUMBER",
            "TRACKTOTAL",
            "TOTALTRACKS",
            "DISCNUMBER",
            "DISCTOTAL",
            "TOTALDISCS",
            "DISCSUBTITLE",
            "ALBUM",
            "ALBUMARTIST",
            "ALBUMARTISTSORT",
            "DATE",
            "YEAR",
            "ORIGINALDATE",
            "ORIGINALYEAR",
            "COMPOSER",
            "ORCHESTRA",
            "ENSEMBLE",
            "CONDUCTOR",
            "LYRICIST",
            "WRITER",
            "PRODUCER",
            "ISRC",
            "WORK",
            "MUSICBRAINZ_TRACKID",
            "MUSICBRAINZ_RELEASETRACKID",
            "MUSICBRAINZ_ARTISTID",
            "MUSICBRAINZ_WORKID",
            "MUSICBRAINZ_COMPOSERID",
            "MUSICBRAINZ_ALBUMID",
            "MUSICBRAINZ_ALBUMARTISTID",
            "MUSICBRAINZ_RELEASEGROUPID",
        }
        rg_order = [
            "REPLAYGAIN_TRACK_GAIN",
            "REPLAYGAIN_TRACK_PEAK",
            "REPLAYGAIN_TRACK_RANGE",
            "REPLAYGAIN_ALBUM_GAIN",
            "REPLAYGAIN_ALBUM_PEAK",
            "REPLAYGAIN_ALBUM_RANGE",
            "REPLAYGAIN_REFERENCE_LOUDNESS",
        ]
        extra_tags = getattr(active_trk, "extra_tags", None) or {}
        if isinstance(extra_tags, dict):
            rg_entries: list[tuple[str, str]] = []
            for tag_key in sorted(extra_tags.keys(), key=lambda s: str(s).upper()):
                k_up = str(tag_key).strip().upper().replace(" ", "_")
                if not k_up or k_up in skip_extra_keys:
                    continue
                raw_vals = extra_tags.get(tag_key)
                if isinstance(raw_vals, (list, tuple)):
                    cleaned_vals = [str(v).strip() for v in raw_vals if str(v).strip()]
                elif raw_vals is not None and str(raw_vals).strip():
                    cleaned_vals = [str(raw_vals).strip()]
                else:
                    cleaned_vals = []
                if not cleaned_vals:
                    continue
                joined = "; ".join(cleaned_vals)
                if k_up.startswith("REPLAYGAIN") or k_up.startswith("R128_"):
                    rg_entries.append((str(tag_key), joined))
                    continue

                disp_label = self._format_extra_tag_label(str(tag_key))
                item_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
                lbl = Gtk.Label(label=f"{disp_label}:")
                lbl.set_xalign(0)
                lbl.set_ellipsize(Pango.EllipsizeMode.END)
                lbl.get_style_context().add_class("dim-label")
                ent = Gtk.Entry()
                ent.set_width_chars(8)
                ent.set_hexpand(True)
                ent.set_text(joined)
                ent.set_tooltip_text(f"{disp_label} ({tag_key}): {joined}")
                ent.connect("changed", self._on_inspector_extra_tag_changed, str(tag_key))
                item_box.pack_start(lbl, False, False, 0)
                item_box.pack_start(ent, False, False, 0)
                if (k_up.startswith("ACOUSTID") or k_up.startswith("MUSICBRAINZ")) and hasattr(
                    self, "track_ids_list"
                ):
                    item_box.show_all()
                    self.track_ids_list.pack_start(item_box, False, False, 0)
                    id_count += 1
                else:
                    self.track_insp_populated_list.pack_start(item_box, False, False, 0)
                    item_count += 1

            def _rg_sort_key(pair: tuple[str, str]) -> tuple[int, str]:
                ku = pair[0].strip().upper().replace(" ", "_")
                return (rg_order.index(ku) if ku in rg_order else 999, ku)

            if hasattr(self, "track_rg_list"):
                for tag_key, joined in sorted(rg_entries, key=_rg_sort_key):
                    disp_label = self._format_extra_tag_label(tag_key)
                    item_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
                    lbl = Gtk.Label(label=f"{disp_label}:")
                    lbl.set_xalign(0)
                    lbl.set_ellipsize(Pango.EllipsizeMode.END)
                    lbl.get_style_context().add_class("dim-label")
                    ent = Gtk.Entry()
                    ent.set_width_chars(8)
                    ent.set_hexpand(True)
                    ent.set_text(joined)
                    ent.set_tooltip_text(f"{disp_label} ({tag_key}): {joined}")
                    ent.connect("changed", self._on_inspector_extra_tag_changed, tag_key)
                    item_box.pack_start(lbl, False, False, 0)
                    item_box.pack_start(ent, False, False, 0)
                    item_box.show_all()
                    self.track_rg_list.pack_start(item_box, False, False, 0)
                    rg_count += 1

        if hasattr(self, "track_ids_list") and id_count == 0:
            empty_ids = Gtk.Label(label="Keine MusicBrainz-IDs oder AcoustID-Werte für diesen Track vorhanden.")
            empty_ids.set_xalign(0)
            empty_ids.set_line_wrap(True)
            empty_ids.set_width_chars(10)
            empty_ids.set_max_width_chars(24)
            empty_ids.get_style_context().add_class("dim-label")
            empty_ids.show()
            self.track_ids_list.pack_start(empty_ids, False, False, 0)

        if hasattr(self, "track_rg_list") and rg_count == 0:
            empty_rg = Gtk.Label(label="Keine ReplayGain-Werte für diesen Track vorhanden.")
            empty_rg.set_xalign(0)
            empty_rg.set_line_wrap(True)
            empty_rg.set_width_chars(10)
            empty_rg.set_max_width_chars(24)
            empty_rg.get_style_context().add_class("dim-label")
            empty_rg.show()
            self.track_rg_list.pack_start(empty_rg, False, False, 0)

        # Read-Only Metadaten-Quelle & Quelldatei
        ro_items: list[tuple[str, str]] = []
        meta_src = str(getattr(active_trk, "metadata_source", "") or "").strip()
        if meta_src:
            ro_items.append(("Metadaten-Quelle", meta_src))
        src_file = getattr(active_trk, "source_file", None)
        if src_file is not None:
            src_name = getattr(src_file, "name", "") or str(src_file)
            if src_name:
                ro_items.append(("Quelldatei", src_name))

        for ro_label, ro_val in ro_items:
            ro_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
            lbl = Gtk.Label(label=f"{ro_label}:")
            lbl.set_xalign(0)
            lbl.set_ellipsize(Pango.EllipsizeMode.END)
            lbl.get_style_context().add_class("dim-label")
            val_lbl = Gtk.Label(label=ro_val)
            val_lbl.set_xalign(0)
            val_lbl.set_width_chars(8)
            val_lbl.set_max_width_chars(20)
            val_lbl.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
            val_lbl.set_selectable(True)
            val_lbl.set_tooltip_text(ro_val)
            ro_box.pack_start(lbl, False, False, 0)
            ro_box.pack_start(val_lbl, False, False, 0)
            self.track_insp_populated_list.pack_start(ro_box, False, False, 0)
            item_count += 1

        self._has_populated_track_tags = item_count > 0
        self._has_track_id_tags = id_count > 0
        self._has_track_rg_tags = rg_count > 0
        if hasattr(self, "track_insp_populated_hdr_lbl"):
            self.track_insp_populated_hdr_lbl.set_markup(
                f"<span size='small' weight='bold'>BEFÜLLTE TRACK-TAGS ({item_count})</span>"
            )
        if hasattr(self, "track_ids_summary_label"):
            self.track_ids_summary_label.set_markup(
                f"<b>ID's ({id_count})</b>" if id_count > 0 else "<b>ID's</b>"
            )
        if hasattr(self, "track_rg_summary_label"):
            self.track_rg_summary_label.set_markup(
                f"<b>Replaygain ({rg_count})</b>" if rg_count > 0 else "<b>Replaygain</b>"
            )

    def _on_inspector_extra_tag_changed(self, entry: Gtk.Entry, tag_key: str) -> None:
        if self._syncing_track_inspector:
            return
        trk = self._get_active_inspector_track()
        if trk is None:
            return
        parts = [p.strip() for p in entry.get_text().split(";") if p.strip()]
        if parts:
            trk.extra_tags[tag_key] = parts
        else:
            trk.extra_tags.pop(tag_key, None)

    def _sync_track_inspector_ui(self) -> None:
        if not hasattr(self, "track_insp_combo"):
            return
        self._syncing_track_inspector = True
        try:
            tracks = self.album.tracks
            self.track_insp_combo.remove_all()
            if not tracks:
                self._active_track_idx = 0
                self.track_insp_combo.set_sensitive(False)
                self.track_insp_prev_btn.set_sensitive(False)
                self.track_insp_next_btn.set_sensitive(False)
                self.track_insp_counter_lbl.set_text("")
                self.track_insp_meta_lbl.set_text("Kein Titel geladen")
                for ent in (
                    self.track_entry_genre,
                    self.track_entry_composer,
                    self.track_entry_orchestra,
                    self.track_entry_conductor,
                ):
                    ent.set_text("")
                    ent.set_sensitive(False)
                self._rebuild_populated_track_tags_ui(None)
                return

            if self._active_track_idx < 0 or self._active_track_idx >= len(tracks):
                self._active_track_idx = 0

            distinct_discs = {
                max(1, int(getattr(t, "disc_number", 1) or 1)) for t in tracks
            }
            is_multi_disc = len(distinct_discs) > 1 or self.album.total_discs > 1
            for t in tracks:
                d_num = max(1, int(getattr(t, "disc_number", 1) or 1))
                num_lbl = (
                    f"CD{d_num}·{format_index_number(t.track_number, len(tracks))}"
                    if is_multi_disc
                    else f"#{format_index_number(t.track_number, len(tracks))}"
                )
                self.track_insp_combo.append_text(f"{num_lbl} — {t.title or 'Unbenannter Titel'}")

            self.track_insp_combo.set_sensitive(True)
            self.track_insp_combo.set_active(self._active_track_idx)
            self.track_insp_prev_btn.set_sensitive(self._active_track_idx > 0)
            self.track_insp_next_btn.set_sensitive(self._active_track_idx < len(tracks) - 1)
            self.track_insp_counter_lbl.set_text(f"{self._active_track_idx + 1} / {len(tracks)}")

            active_trk = tracks[self._active_track_idx]
            art_txt = (active_trk.artist or self.album.artist or "Unbekannter Interpret").strip()
            meta_line = f"{art_txt} · {active_trk.duration_formatted}"
            self.track_insp_meta_lbl.set_text(meta_line)
            self.track_insp_meta_lbl.set_tooltip_text(meta_line)

            self.track_entry_genre.set_sensitive(True)
            self.track_entry_genre.set_placeholder_text(self.album.genre or "z. B. Rock; Electronic")
            self.track_entry_genre.set_text(getattr(active_trk, "genre", "") or "")

            self.track_entry_composer.set_sensitive(True)
            self.track_entry_orchestra.set_sensitive(True)
            self.track_entry_conductor.set_sensitive(True)
            self.track_entry_composer.set_text(active_trk.composer or "")
            self.track_entry_orchestra.set_text(active_trk.orchestra or "")
            self.track_entry_conductor.set_text(active_trk.conductor or "")
            self._rebuild_populated_track_tags_ui(active_trk)
        finally:
            self._syncing_track_inspector = False
            self._update_track_inspector_section_visibility()
            self._update_active_track_row_highlight()

    def _on_inspector_track_genre_changed(self, entry: Gtk.Entry) -> None:
        if self._syncing_track_inspector:
            return
        trk = self._get_active_inspector_track()
        if trk is None:
            return
        self._on_track_genre_changed(entry, trk)

    def _on_inspector_track_genre_focus_out(
        self, entry: Gtk.Entry, _event: Gdk.EventFocus
    ) -> bool:
        if self._syncing_track_inspector:
            return False
        trk = self._get_active_inspector_track()
        if trk is None:
            return False
        val = entry.get_text().strip()
        self._append_query_log_ui(
            f"[Track-Felder] Genre für Titel #{trk.track_number:02d} gesetzt auf „{val or '—'}“."
        )
        return False

    def _on_inspector_track_field_changed(self, entry: Gtk.Entry, attr_name: str) -> None:
        if self._syncing_track_inspector:
            return
        trk = self._get_active_inspector_track()
        if trk is None:
            return
        setattr(trk, attr_name, entry.get_text())

    def _on_inspector_track_field_focus_out(
        self, entry: Gtk.Entry, _event: Gdk.EventFocus, attr_name: str, field_label: str
    ) -> bool:
        if self._syncing_track_inspector:
            return False
        trk = self._get_active_inspector_track()
        if trk is None:
            return False
        norm = normalize_multi_artist(entry.get_text())
        if norm != entry.get_text():
            self._syncing_track_inspector = True
            try:
                entry.set_text(norm)
            finally:
                self._syncing_track_inspector = False
        setattr(trk, attr_name, norm)
        self._append_query_log_ui(
            f"[Track-Felder] {field_label} für Titel #{trk.track_number:02d} gesetzt auf „{norm or '—'}“."
        )
        return False

    def _on_classical_album_toggled(self, btn: Gtk.ToggleButton) -> None:
        self.album.is_classical = btn.get_active()
        if self.album.is_classical and self._track_panel_collapsed:
            self._track_panel_collapsed = False
            self._apply_track_panel_collapse_state()
        self._update_classical_visibility()
        self._sync_track_inspector_ui()
        if self.album.is_classical:
            self._append_query_log_ui(
                "[Klassikalbum] Klassikalbum-Modus aktiviert (Zusatzfelder: Komponist, Orchester, Dirigent in der rechten Track-Spalte eingeblendet)."
            )
        else:
            self._append_query_log_ui("[Klassikalbum] Klassikalbum-Modus deaktiviert.")

    def _apply_album_field_to_selected_tracks(
        self,
        field_id: str,
        track_attr: str,
        field_label: str,
        normalize_people: bool = True,
    ) -> None:
        selected_tracks = [t for t in self.album.tracks if t.selected]
        if not selected_tracks:
            self._append_query_log_ui(
                f"[Metadaten] Kein Titel ausgewählt – „{field_label}“ wurde nicht übertragen (mindestens einen Titel anhaken)."
            )
            return

        if field_id == "artist":
            raw_val = self.entry_artist.get_text().strip()
        elif field_id == "genre":
            raw_val = self.entry_genre.get_text().strip()
        elif field_id == "composer":
            raw_val = self.entry_composer.get_text().strip()
        elif field_id == "orchestra":
            raw_val = self.entry_orchestra.get_text().strip()
        elif field_id == "conductor":
            raw_val = self.entry_conductor.get_text().strip()
        elif field_id in self._dynamic_left_entries:
            raw_val = self._dynamic_left_entries[field_id].get_text().strip()
        else:
            raw_val = self._get_album_left_field_value(field_id).strip()

        clean_val = normalize_multi_artist(raw_val) if normalize_people else raw_val
        if field_id == "artist":
            self.entry_artist.set_text(clean_val)
            self.album.artist = clean_val or "Unbekannter Künstler"
        elif field_id == "genre":
            self.entry_genre.set_text(clean_val)
            self.album.genre = clean_val
        elif field_id == "composer":
            self.entry_composer.set_text(clean_val)
            self.album.composer = clean_val
        elif field_id == "orchestra":
            self.entry_orchestra.set_text(clean_val)
            self.album.orchestra = clean_val
        elif field_id == "conductor":
            self.entry_conductor.set_text(clean_val)
            self.album.conductor = clean_val
        elif field_id in self._dynamic_left_entries:
            self._dynamic_left_entries[field_id].set_text(clean_val)
            self._set_album_left_field_value(field_id, clean_val)
        else:
            self._set_album_left_field_value(field_id, clean_val)

        # Ausschließlich aktiv markierte Titel aktualisieren
        extra_key = self._LEFT_ALBUM_EXTRA_TAG_KEYS.get(field_id)
        for trk in selected_tracks:
            if hasattr(trk, track_attr):
                setattr(trk, track_attr, clean_val)
            if track_attr == "genre" and (
                getattr(trk, "has_shazam_alternative", False)
                or getattr(trk, "has_mb_alternative", False)
            ):
                var = getattr(trk, "active_metadata_variant", "")
                if var == "original":
                    trk.original_genre = clean_val
                elif var == "musicbrainz":
                    trk.mb_genre = clean_val
                elif var == "shazam":
                    trk.shazam_genre = clean_val
            if extra_key:
                parts = [p.strip() for p in str(clean_val or "").split(";") if p.strip()]
                if parts:
                    trk.extra_tags[extra_key] = parts
                else:
                    trk.extra_tags.pop(extra_key, None)

        self._render_track_list()
        self._sync_track_inspector_ui()
        scope_prefix = (
            "[Klassikalbum]"
            if field_id in ("composer", "orchestra", "conductor")
            else "[Metadaten]"
        )
        self._append_query_log_ui(
            f"{scope_prefix} {field_label} „{clean_val or '—'}“ auf {len(selected_tracks)} von {len(self.album.tracks)} markierte(n) Titel(n) übertragen."
        )

    def _on_apply_artist_to_all_clicked(self, _btn: Gtk.Button) -> None:
        self._apply_album_field_to_selected_tracks("artist", "artist", "Künstler", True)

    def _on_apply_genre_to_all_clicked(self, _btn: Gtk.Button) -> None:
        self._apply_album_field_to_selected_tracks("genre", "genre", "Genre", False)

    def _on_apply_composer_to_all_clicked(self, _btn: Gtk.Button) -> None:
        self._apply_album_field_to_selected_tracks("composer", "composer", "Komponist", True)

    def _on_apply_orchestra_to_all_clicked(self, _btn: Gtk.Button) -> None:
        self._apply_album_field_to_selected_tracks("orchestra", "orchestra", "Orchester", True)

    def _on_apply_conductor_to_all_clicked(self, _btn: Gtk.Button) -> None:
        self._apply_album_field_to_selected_tracks("conductor", "conductor", "Dirigent", True)

    def _sync_album_from_entries(self) -> None:
        self.album.title = self.entry_album.get_text().strip() or "Unbekanntes Album"
        norm_artist = normalize_multi_artist(self.entry_artist.get_text().strip()) or "Unbekannter Künstler"
        norm_album_artist = normalize_multi_artist(self.entry_album_artist.get_text().strip()) or norm_artist
        self.album.artist = norm_artist
        self.album.album_artist = norm_album_artist
        self.entry_artist.set_text(norm_artist)
        self.entry_album_artist.set_text(norm_album_artist)
        self.album.composer = normalize_multi_artist(self.entry_composer.get_text().strip())
        self.album.orchestra = normalize_multi_artist(self.entry_orchestra.get_text().strip())
        self.album.conductor = normalize_multi_artist(self.entry_conductor.get_text().strip())
        for trk in self.album.tracks:
            if trk.artist:
                trk.artist = normalize_multi_artist(trk.artist)
            if trk.composer:
                trk.composer = normalize_multi_artist(trk.composer)
            if trk.orchestra:
                trk.orchestra = normalize_multi_artist(trk.orchestra)
            if trk.conductor:
                trk.conductor = normalize_multi_artist(trk.conductor)
        if not self._disc_conflict:
            self.album.disc_number = max(1, self.spin_disc_number.get_value_as_int())
        min_disc = 1 if self._disc_conflict else self.album.disc_number
        self.album.total_discs = max(
            min_disc,
            self.album.total_discs,
            self.spin_total_discs.get_value_as_int(),
        )
        self.album.year = self.entry_year.get_text().strip()
        self.album.genre = self.entry_genre.get_text().strip()
        self.album.label = self.entry_label.get_text().strip()
        self.album.cddb_id = self.entry_cddb_id.get_text().strip()
        self.album.musicbrainz_release_id = self.entry_mbid.get_text().strip()
        self.album.discogs_release_id = self.entry_discogs_id.get_text().strip()
        self.album.asin = self.entry_asin.get_text().strip().upper()
        self.album.barcode = self.entry_barcode.get_text().strip()
        for fid, f_entry in self._dynamic_left_entries.items():
            spec = next((s for s in MUSICBRAINZ_LEFT_TAG_FIELDS if s["id"] == fid), None)
            raw_v = f_entry.get_text().strip()
            if spec and spec.get("category") == "credits" and fid != "work":
                raw_v = normalize_multi_artist(raw_v)
                f_entry.set_text(raw_v)
            self._set_album_left_field_value(fid, raw_v)

    def _populate_album_ui(self) -> None:
        self.album.artist = normalize_multi_artist(self.album.artist) or "Unbekannter Künstler"
        self.album.album_artist = normalize_multi_artist(self.album.album_artist or self.album.artist)
        for trk in self.album.tracks:
            trk.artist = normalize_multi_artist(trk.artist or self.album.artist)
        self.entry_album.set_text(self.album.title)
        self.entry_album_artist.set_text(self.album.album_artist or self.album.artist)
        self.entry_artist.set_text(self.album.artist)
        self.entry_composer.set_text(self.album.composer)
        self.entry_orchestra.set_text(self.album.orchestra)
        self.entry_conductor.set_text(self.album.conductor)
        self._updating_disc_ui = True
        try:
            self.spin_disc_number.set_value(max(1, self.album.disc_number))
            self.spin_total_discs.set_value(max(1, self.album.total_discs))
        finally:
            self._updating_disc_ui = False
        self.entry_year.set_text(self.album.year)
        self.entry_genre.set_text(self.album.genre)
        self.entry_label.set_text(self.album.label)
        self.entry_cddb_id.set_text(self.album.cddb_id)
        self.entry_mbid.set_text(self.album.musicbrainz_release_id)
        self.entry_discogs_id.set_text(self.album.discogs_release_id)
        self.entry_asin.set_text(self.album.asin)
        self.entry_barcode.set_text(self.album.barcode)
        for fid, f_entry in self._dynamic_left_entries.items():
            f_entry.set_text(self._get_album_left_field_value(fid))
        self._apply_left_tag_field_visibility()
        self._render_cover_preview()
        self._render_track_list()
        self._sync_disc_number_from_track_selection(emit_log=False)

    def _apply_cover_bytes(
        self, raw_bytes: bytes, raw_mime: str, source_label: str
    ) -> tuple[int, int, str]:
        w, h, orig_fmt = inspect_cover_image(raw_bytes, raw_mime)
        self.album.cover_art_bytes = raw_bytes
        self.album.cover_art_mime = raw_mime or "image/jpeg"
        self.album.cover_art_width = w
        self.album.cover_art_height = h
        self.album.cover_art_original_format = orig_fmt
        self.album.cover_art_source = source_label
        return w, h, orig_fmt

    def _render_cover_preview(self) -> bool:
        if self.album.cover_art_bytes:
            try:
                orig_fmt = detect_image_format(
                    self.album.cover_art_bytes, self.album.cover_art_mime
                )
                self.album.cover_art_original_format = orig_fmt

                loader = GdkPixbuf.PixbufLoader()
                loader.write(self.album.cover_art_bytes)
                loader.close()
                pixbuf = loader.get_pixbuf()
                if pixbuf is not None:
                    w = pixbuf.get_width()
                    h = pixbuf.get_height()
                    self.album.cover_art_width = w
                    self.album.cover_art_height = h
                    box_dim = 340.0 if getattr(self, "_active_module", "") == "module_cover" else 240.0
                    scale = min(box_dim / max(1, w), box_dim / max(1, h))
                    target_w = max(1, int(round(w * scale)))
                    target_h = max(1, int(round(h * scale)))
                    scaled = pixbuf.scale_simple(target_w, target_h, GdkPixbuf.InterpType.BILINEAR)
                    if scaled is not None:
                        self.cover_image.set_from_pixbuf(scaled)
                        size_bytes = len(self.album.cover_art_bytes)
                        if size_bytes >= 1024 * 1024:
                            size_txt = f"{size_bytes / (1024 * 1024):.2f} MB"
                        else:
                            size_txt = f"{max(1.0, size_bytes / 1024.0):.1f} KB"
                        fmt_txt = (
                            f"{orig_fmt} (Export → JPG)"
                            if orig_fmt and orig_fmt != "JPEG"
                            else "JPEG"
                        )
                        self.cover_meta_label.set_markup(
                            f"<span size='small'><b>{w} × {h} px</b> · <b>{size_txt}</b> · <b>{fmt_txt}</b></span>"
                        )
                        self.cover_status_label.set_text(self.album.cover_art_source or "Cover geladen")
                        for attr in ("crop_cover_btn", "scale_cover_btn", "save_cover_btn"):
                            widget = getattr(self, attr, None)
                            if widget is not None:
                                widget.set_sensitive(True)
                                widget.show_all()
                        return False
            except Exception:
                pass
        self._set_placeholder_cover()
        if hasattr(self, "cover_meta_label"):
            self.cover_meta_label.set_markup(
                "<span size='small'>Auflösung: — · Größe: — · Format: —</span>"
            )
        if hasattr(self, "cover_status_label"):
            self.cover_status_label.set_text("Kein Cover geladen")
        return False

    def _render_track_list(self) -> None:
        for child in self.track_listbox.get_children():
            self.track_listbox.remove(child)
        self._track_checkbuttons.clear()
        self._track_preview_buttons.clear()
        self._track_num_labels.clear()
        self._track_row_widgets.clear()
        self._track_health_widgets.clear()
        is_tag_module = getattr(self, "_active_module", "") == "module_tag"
        if hasattr(self, "hdr_health"):
            self.hdr_health.set_no_show_all(not is_tag_module)
            self.hdr_health.set_visible(is_tag_module)

        distinct_discs = {
            max(1, int(getattr(t, "disc_number", 1) or 1))
            for t in self.album.tracks
        }
        is_multi_disc = len(distinct_discs) > 1 or self.album.total_discs > 1
        per_disc_totals: dict[int, int] = {}
        for t in self.album.tracks:
            d = max(1, int(getattr(t, "disc_number", 1) or 1))
            per_disc_totals[d] = per_disc_totals.get(d, 0) + 1
        if hasattr(self, "hdr_num"):
            self.hdr_num.set_width_chars(7 if is_multi_disc else 4)

        prev_disc: int | None = None
        total_discs = max(1, self.album.total_discs, max(distinct_discs) if distinct_discs else 1)

        for idx, track in enumerate(self.album.tracks):
            eff_disc = max(1, int(getattr(track, "disc_number", 1) or 1))
            if is_multi_disc and (prev_disc is None or eff_disc != prev_disc):
                disc_count = per_disc_totals.get(eff_disc, 0)
                disc_sub = (getattr(track, "disc_subtitle", "") or "").strip()
                hdr_row = Gtk.ListBoxRow()
                hdr_row.set_selectable(False)
                hdr_row.set_activatable(False)
                hdr_row.get_style_context().add_class("cd-section-row")
                hdr_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
                hdr_box.get_style_context().add_class("cd-section-header")
                if prev_disc is not None:
                    hdr_box.set_margin_top(24)
                else:
                    hdr_box.set_margin_top(2)
                title_txt = f"<b>CD {format_index_number(eff_disc, total_discs)}</b>"
                if disc_sub:
                    title_txt += f" — {GLib.markup_escape_text(disc_sub)}"
                cd_title_lbl = Gtk.Label()
                cd_title_lbl.set_markup(title_txt)
                cd_title_lbl.set_xalign(0)
                hdr_box.pack_start(cd_title_lbl, True, True, 0)

                cd_count_lbl = Gtk.Label(label=f"{disc_count} Titel")
                cd_count_lbl.get_style_context().add_class("dim-label")
                hdr_box.pack_end(cd_count_lbl, False, False, 0)

                hdr_row.add(hdr_box)
                self.track_listbox.add(hdr_row)
            prev_disc = eff_disc

            row_event_box = Gtk.EventBox()
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            row.set_margin_top(3)
            row.set_margin_bottom(3)
            row.set_margin_start(6)
            row.set_margin_end(6)

            handle_box = Gtk.EventBox()
            handle_box.add(make_system_icon("drag_handle"))
            row.pack_start(handle_box, False, False, 0)

            check = Gtk.CheckButton()
            check.set_active(track.selected)
            check.connect("toggled", self._on_track_check_toggled, track)
            self._track_checkbuttons.append(check)
            row.pack_start(check, False, False, 0)

            if is_tag_module:
                h_ev = Gtk.EventBox()
                h_ev.set_visible_window(False)
                h_ev.set_size_request(18, 22)
                h_area = Gtk.DrawingArea()
                h_area.set_size_request(14, 22)
                h_area.set_valign(Gtk.Align.CENTER)
                h_area.set_halign(Gtk.Align.CENTER)
                h_status = getattr(track, "audio_health_status", "") or ""
                h_color = getattr(track, "audio_health_color", "") or (
                    "#94A3B8" if h_status else ""
                )
                h_tip = getattr(track, "audio_health_tooltip", "") or (
                    "Audiodatei wird im Hintergrund geprüft…"
                    if h_status == "scanning"
                    else "Keine lokale Audiodatei"
                )
                h_state = [h_color]

                def _draw_track_health_bar(widget: Gtk.DrawingArea, cr, st_ref=h_state) -> bool:
                    col_hex = st_ref[0]
                    if not col_hex:
                        return False
                    alloc = widget.get_allocation()
                    r, g, b = self._repair_severity_rgb(col_hex)
                    bar_w = 10.0
                    bar_h = 20.0
                    x = max(0.0, (alloc.width - bar_w) * 0.5)
                    y = max(0.0, (alloc.height - bar_h) * 0.5)
                    rad = 2.5
                    cr.new_sub_path()
                    cr.arc(x + bar_w - rad, y + rad, rad, -1.5707963, 0.0)
                    cr.arc(x + bar_w - rad, y + bar_h - rad, rad, 0.0, 1.5707963)
                    cr.arc(x + rad, y + bar_h - rad, rad, 1.5707963, 3.1415927)
                    cr.arc(x + rad, y + rad, rad, 3.1415927, 4.7123890)
                    cr.close_path()
                    cr.set_source_rgb(r, g, b)
                    cr.fill()
                    return False

                h_area.connect("draw", _draw_track_health_bar)
                h_ev.add(h_area)
                h_ev.set_tooltip_text(h_tip)
                self._sg_health.add_widget(h_ev)
                row.pack_start(h_ev, False, False, 0)
                if track.source_file is not None:
                    self._track_health_widgets[str(track.source_file)] = (h_ev, h_area, h_state)

            disc_total = per_disc_totals.get(eff_disc, len(self.album.tracks))
            num_text = (
                f"CD{eff_disc}·{format_index_number(track.track_number, disc_total)}"
                if is_multi_disc
                else format_index_number(track.track_number, len(self.album.tracks))
            )
            num_lbl = Gtk.Label(label=num_text)
            num_lbl.set_width_chars(7 if is_multi_disc else 4)
            num_lbl.set_xalign(0)
            self._sg_num.add_widget(num_lbl)
            self._track_num_labels.append((track, num_lbl))
            row.pack_start(num_lbl, False, False, 0)

            title_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            title_entry = Gtk.Entry()
            title_entry.set_text(track.title)
            title_entry.set_width_chars(10)
            title_entry.set_hexpand(True)
            title_entry.connect("changed", self._on_track_title_changed, track)
            title_entry.connect(
                "focus-in-event", lambda _w, _e, t_idx=idx: (self._select_active_track(t_idx), False)[1]
            )
            title_entry.connect(
                "focus-out-event",
                self._on_album_field_focus_out,
                f"Titel #{track.track_number:02d}",
            )
            title_box.pack_start(title_entry, True, True, 0)

            has_shazam_alt = bool(getattr(track, "has_shazam_alternative", False))
            has_mb_alt = bool(getattr(track, "has_mb_alternative", False))
            if has_shazam_alt or has_mb_alt:
                active_var = getattr(track, "active_metadata_variant", "") or (
                    "musicbrainz" if has_mb_alt else "shazam"
                )
                is_orig = active_var == "original"
                is_mb = active_var == "musicbrainz"
                if is_orig:
                    btn_lbl = "Original ⇄"
                    css_cls = "original-active"
                elif is_mb:
                    btn_lbl = "MusicBrainz ⇄"
                    css_cls = "mb-active"
                else:
                    shazam_src_raw = (track.shazam_metadata_source or "Shazam").strip()
                    shazam_short = "Shazam" if "shazam" in shazam_src_raw.lower() else shazam_src_raw
                    btn_lbl = f"{shazam_short} ⇄"
                    css_cls = "shazam-active"

                toggle_btn = Gtk.Button(label=btn_lbl)
                ctx = toggle_btn.get_style_context()
                ctx.add_class("shazam-toggle-btn")
                ctx.add_class(css_cls)

                var_lines: list[str] = []
                if is_orig:
                    var_lines.append(
                        f"Aktiv: Original („{track.original_artist or '—'} – {track.original_title or '—'}“ · Genre: {track.original_genre or '—'})"
                    )
                elif is_mb:
                    var_lines.append(
                        f"Aktiv: MusicBrainz („{track.mb_artist or '—'} – {track.mb_title or '—'}“ · Genre: {track.mb_genre or '—'})"
                    )
                else:
                    var_lines.append(
                        f"Aktiv: Shazam („{track.shazam_artist or '—'} – {track.shazam_title or '—'}“ · Genre: {track.shazam_genre or '—'})"
                    )
                if not is_orig:
                    var_lines.append(
                        f"Original: „{track.original_artist or '—'} – {track.original_title or '—'}“ · Genre: {track.original_genre or '—'}"
                    )
                if has_mb_alt and not is_mb:
                    var_lines.append(
                        f"MusicBrainz: „{track.mb_artist or '—'} – {track.mb_title or '—'}“ · Genre: {track.mb_genre or '—'}"
                    )
                if has_shazam_alt and active_var != "shazam":
                    var_lines.append(
                        f"Shazam: „{track.shazam_artist or '—'} – {track.shazam_title or '—'}“ · Genre: {track.shazam_genre or '—'}"
                    )
                var_lines.append("Klick schaltet zwischen den gespeicherten Ergebnissen um.")
                toggle_btn.set_tooltip_text("\n".join(var_lines))
                toggle_btn.connect("clicked", self._on_toggle_shazam_variant_clicked, track)
                title_box.pack_start(toggle_btn, False, False, 0)
            else:
                raw_src = (track.metadata_source or self.album.metadata_source or "").strip()
                if raw_src and not raw_src.lower().startswith("lokal"):
                    short_src = (
                        "Shazam"
                        if "shazam" in raw_src.lower()
                        else "Discogs"
                        if "discogs" in raw_src.lower()
                        else "CDDB"
                        if "cddb" in raw_src.lower() or "gnudb" in raw_src.lower()
                        else "MusicBrainz"
                        if "musicbrainz" in raw_src.lower()
                        else raw_src
                    )
                    src_badge = Gtk.Label(label=short_src)
                    src_badge.get_style_context().add_class("source-badge")
                    src_badge.get_style_context().add_class("dim-label")
                    src_badge.set_tooltip_text(f"Metadaten-Quelle: {raw_src}")
                    title_box.pack_start(src_badge, False, False, 0)

            self._sg_title.add_widget(title_box)
            row.pack_start(title_box, True, True, 0)

            artist_entry = Gtk.Entry()
            artist_entry.set_text(normalize_multi_artist(track.artist or self.album.artist))
            artist_entry.set_width_chars(10)
            artist_entry.set_hexpand(True)
            artist_entry.connect("changed", self._on_track_artist_changed, track)
            artist_entry.connect(
                "focus-in-event", lambda _w, _e, t_idx=idx: (self._select_active_track(t_idx), False)[1]
            )
            artist_entry.connect(
                "focus-out-event",
                self._on_artist_entry_focus_out,
                f"Interpret (Titel #{track.track_number:02d})",
            )
            self._sg_artist.add_widget(artist_entry)
            row.pack_start(artist_entry, True, True, 0)

            dur_lbl = Gtk.Label(label=track.duration_formatted)
            dur_lbl.set_width_chars(6)
            dur_lbl.set_xalign(1.0)
            self._sg_dur.add_widget(dur_lbl)
            row.pack_start(dur_lbl, False, False, 0)

            preview_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
            toggle_btn = Gtk.Button()
            toggle_btn.add(make_system_icon("media_play", pixel_size=14))
            toggle_btn.set_tooltip_text(
                f"Titel #{track.track_number:02d} („{track.title}“) zum Reinhören abspielen"
            )
            toggle_btn.set_has_tooltip(True)
            toggle_btn.connect("clicked", lambda _b, t_idx=idx: self._on_toggle_track_preview_clicked(t_idx))
            preview_box.pack_start(toggle_btn, False, False, 0)

            self._sg_preview.add_widget(preview_box)
            self._track_preview_buttons[idx] = toggle_btn
            row.pack_start(preview_box, False, False, 0)

            row_event_box.add(row)
            row_event_box.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
            row_event_box.connect(
                "button-press-event", lambda _w, _e, t_idx=idx: (self._select_active_track(t_idx), False)[1]
            )
            self._track_row_widgets.append(row_event_box)
            attach_track_reorder_dnd(handle_box, row_event_box, idx, self._on_reorder_track)
            self.track_listbox.add(row_event_box)

        self.track_listbox.show_all()
        self._rebuild_single_disc_selector()
        self._refresh_preview_button_states()
        self._sync_select_all_state()
        self._update_rip_or_tag_button_mode()
        self._sync_track_inspector_ui()

    def _update_cover_toolbar_icon_sizes(self, _module_id: str) -> None:
        btn_size = 28
        icon_size = 16
        for btn, icon_name in getattr(self, "_cover_toolbar_items", []):
            btn.set_size_request(btn_size, btn_size)
            old_child = btn.get_child()
            if old_child is not None:
                btn.remove(old_child)
            new_icon = make_system_icon(icon_name, pixel_size=icon_size)
            new_icon.set_has_tooltip(False)
            new_icon.show()
            btn.add(new_icon)

    def _update_rip_or_tag_button_mode(self) -> None:
        is_imported_only = bool(self.album.tracks) and all(
            t.source_file is not None for t in self.album.tracks
        )
        is_modul3 = getattr(self, "_active_module", "") == "module_tag"
        show_flac_opt = is_modul3 and is_imported_only
        if hasattr(self, "convert_local_flac_chk"):
            self.convert_local_flac_chk.set_no_show_all(not show_flac_opt)
            self.convert_local_flac_chk.set_visible(show_flac_opt)
            if not show_flac_opt and self.convert_local_flac_chk.get_active():
                self.convert_local_flac_chk.set_active(False)

        convert_flac = show_flac_opt and hasattr(self, "convert_local_flac_chk") and self.convert_local_flac_chk.get_active()
        if hasattr(self, "rip_btn_label"):
            if convert_flac:
                self.rip_btn_label.set_text("In FLAC umwandeln")
            elif is_imported_only:
                self.rip_btn_label.set_text("Tags in Dateien schreiben")
            else:
                self.rip_btn_label.set_text("Rippen")
        if hasattr(self, "rip_btn"):
            self.rip_btn.set_tooltip_text(
                "Wandelt importierte Dateien zuerst nach WAV und danach nach FLAC um (exakte Bitraten) unter Beibehaltung aller Tags & des Covers"
                if convert_flac
                else (
                    "Schreibt ausschließlich die Picard-Metadaten-Tags und das Cover direkt in die vorhandenen Audiodateien – ohne erneutes Rippen oder Neukodieren"
                    if is_imported_only
                    else "Ausgewählte Titel rippen / konvertieren und in die Stapelverarbeitung starten"
                )
            )
        if hasattr(self, "track_action_hint"):
            self.track_action_hint.set_text(
                "Importiertes Album: Erst nach WAV und danach nach FLAC umwandeln (Button rechts unten)."
                if convert_flac
                else (
                    "Importiertes Album: Nur Metadaten-Tags & Cover direkt in die vorhandenen Dateien schreiben (Button rechts unten)."
                    if is_imported_only
                    else "Ausgewählte Titel rippen / konvertieren und in die Stapelverarbeitung übergeben (Button rechts unten)."
                )
            )

    def _refresh_preview_button_states(self) -> None:
        for t_idx, toggle_btn in self._track_preview_buttons.items():
            is_playing = self._playing_track_idx == t_idx
            ctx = toggle_btn.get_style_context()
            if is_playing:
                ctx.add_class("suggested-action")
            else:
                ctx.remove_class("suggested-action")
            old_child = toggle_btn.get_child()
            if old_child is not None:
                toggle_btn.remove(old_child)
            icon_widget = make_system_icon("media_stop" if is_playing else "media_play", pixel_size=14)
            icon_widget.set_has_tooltip(False)
            icon_widget.show()
            toggle_btn.add(icon_widget)
            if 0 <= t_idx < len(self.album.tracks):
                trk = self.album.tracks[t_idx]
                toggle_btn.set_tooltip_text(
                    f"Wiedergabe von Titel #{trk.track_number:02d} („{trk.title}“) stoppen"
                    if is_playing
                    else f"Titel #{trk.track_number:02d} („{trk.title}“) zum Reinhören abspielen"
                )

    def _on_toggle_track_preview_clicked(self, track_idx: int) -> None:
        if self._playing_track_idx == track_idx:
            self._stop_track_preview(log=True)
        else:
            self._on_play_track_clicked(track_idx)

    def _refresh_repair_preview_button_states(self) -> None:
        prev_id = getattr(self, "_last_playing_repair_job_id", None)
        cur_id = self._playing_repair_job_id
        for jid in (prev_id, cur_id):
            if not jid:
                continue
            slot = self._rep_visible_file_slots.get(jid)
            if slot is not None:
                job = self._repair_jobs_by_id.get(jid)
                self._sync_repair_slot_play_button(slot, job)
        self._last_playing_repair_job_id = cur_id

    @staticmethod
    def _format_rep_player_time(seconds: float) -> str:
        total = max(0, int(round(seconds)))
        h, rem = divmod(total, 3600)
        m, s = divmod(rem, 60)
        if h > 0:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m:02d}:{s:02d}"

    @staticmethod
    def _probe_audio_duration_seconds(path: Path) -> float:
        ffprobe_bin = shutil.which("ffprobe")
        if not ffprobe_bin:
            return 0.0
        try:
            res = subprocess.run(
                [
                    ffprobe_bin,
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(path),
                ],
                capture_output=True,
                text=True,
                timeout=4,
                check=False,
            )
            val = float((res.stdout or "").strip())
            return val if math.isfinite(val) and val > 0 else 0.0
        except Exception:
            return 0.0

    def _stop_rep_player_timers(self) -> None:
        if getattr(self, "_rep_player_timer_id", 0):
            try:
                GLib.source_remove(self._rep_player_timer_id)
            except Exception:
                pass
            self._rep_player_timer_id = 0
        if getattr(self, "_rep_player_seek_timer_id", 0):
            try:
                GLib.source_remove(self._rep_player_seek_timer_id)
            except Exception:
                pass
            self._rep_player_seek_timer_id = 0

    def _sync_repair_player_bar_ui(self, position_sec: Optional[float] = None) -> None:
        if not hasattr(self, "rep_player_scale"):
            return
        cur_id = getattr(self, "_playing_repair_job_id", None)
        job = None
        if cur_id:
            job = self._repair_jobs_by_id.get(cur_id) or next(
                (j for j in self.repair_manager.jobs if j.job_id == cur_id), None
            )
        dur = max(0.0, float(getattr(self, "_rep_player_duration_sec", 0.0)))
        if position_sec is None:
            if job is not None and self._rep_player_started_monotonic > 0.0:
                pos = self._rep_player_offset_sec + max(
                    0.0, time.monotonic() - self._rep_player_started_monotonic
                )
            else:
                pos = 0.0
        else:
            pos = max(0.0, float(position_sec))
        if dur > 0.0:
            pos = min(dur, pos)

        if hasattr(self, "rep_player_title_lbl"):
            if job is not None:
                variant = (
                    "Repariert"
                    if (job.output_path is not None and job.output_path.exists())
                    else "Original"
                )
                title_txt = f"{job.source_path.name} ({variant})"
                self.rep_player_title_lbl.set_markup(
                    f"<b>{GLib.markup_escape_text(title_txt)}</b>"
                )
                self.rep_player_title_lbl.set_tooltip_text(str(job.relative_path))
            else:
                self.rep_player_title_lbl.set_markup(
                    "<span alpha='70%'>Kein Titel wird abgespielt</span>"
                )
                self.rep_player_title_lbl.set_tooltip_text("Kein Titel wird abgespielt")

        if hasattr(self, "rep_player_time_lbl"):
            self.rep_player_time_lbl.set_text(
                f"{self._format_rep_player_time(pos)} / {self._format_rep_player_time(dur)}"
            )

        if hasattr(self, "rep_player_stop_btn"):
            self.rep_player_stop_btn.set_sensitive(job is not None)

        self._rep_player_updating_scale = True
        try:
            scale_max = dur if dur > 0.0 else 1.0
            self.rep_player_scale.set_range(0.0, scale_max)
            self.rep_player_scale.set_value(pos if job is not None else 0.0)
            self.rep_player_scale.set_sensitive(job is not None and dur > 0.0)
        finally:
            self._rep_player_updating_scale = False

    def _on_rep_player_tick(self) -> bool:
        if not getattr(self, "_playing_repair_job_id", None):
            self._rep_player_timer_id = 0
            return False
        if not self._rep_player_seeking:
            self._sync_repair_player_bar_ui()
        return True

    def _on_rep_player_scale_button_press(self, _widget: Gtk.Widget, _event: Gdk.EventButton) -> bool:
        self._rep_player_seeking = True
        return False

    def _on_rep_player_scale_button_release(self, scale: Gtk.Scale, _event: Gdk.EventButton) -> bool:
        self._rep_player_seeking = False
        target_sec = float(scale.get_value())
        self._commit_repair_player_seek(target_sec)
        return False

    def _on_rep_player_scale_value_changed(self, scale: Gtk.Scale) -> None:
        if self._rep_player_updating_scale:
            return
        val = max(0.0, float(scale.get_value()))
        if hasattr(self, "rep_player_time_lbl"):
            dur = max(0.0, float(getattr(self, "_rep_player_duration_sec", 0.0)))
            self.rep_player_time_lbl.set_text(
                f"{self._format_rep_player_time(val)} / {self._format_rep_player_time(dur)}"
            )
        # Tastatur-/Klick-Seek außerhalb eines gedrückten Drag-Vorgangs entprellt übernehmen
        if not self._rep_player_seeking and getattr(self, "_playing_repair_job_id", None):
            if self._rep_player_seek_timer_id:
                try:
                    GLib.source_remove(self._rep_player_seek_timer_id)
                except Exception:
                    pass
                self._rep_player_seek_timer_id = 0

            def _do_seek() -> bool:
                self._rep_player_seek_timer_id = 0
                self._commit_repair_player_seek(float(scale.get_value()))
                return False

            self._rep_player_seek_timer_id = GLib.timeout_add(140, _do_seek)

    def _commit_repair_player_seek(self, target_sec: float) -> None:
        cur_id = getattr(self, "_playing_repair_job_id", None)
        if not cur_id:
            return
        job = self._repair_jobs_by_id.get(cur_id) or next(
            (j for j in self.repair_manager.jobs if j.job_id == cur_id), None
        )
        if job is None:
            return
        dur = max(0.0, float(getattr(self, "_rep_player_duration_sec", 0.0)))
        clamped = max(0.0, min(dur - 0.5, target_sec)) if dur > 1.0 else max(0.0, target_sec)
        self._start_repair_preview(job, start_sec=clamped, log_start=False)

    def _on_toggle_repair_preview_clicked(self, job: RepairJob) -> None:
        if self._playing_repair_job_id == job.job_id:
            self._stop_track_preview(log=True)
            return
        self._start_repair_preview(job, start_sec=0.0, log_start=True)

    def _start_repair_preview(
        self, job: RepairJob, start_sec: float = 0.0, log_start: bool = True
    ) -> None:
        self._stop_track_preview(log=False)
        play_path = (
            job.output_path
            if (job.output_path is not None and job.output_path.exists())
            else job.source_path
        )
        if not play_path or not play_path.exists():
            self._append_query_log_ui(
                f"[Reparatur · Vorhören] Datei „{job.relative_path}“ nicht gefunden."
            )
            return

        token = self._preview_token
        self._playing_repair_job_id = job.job_id
        known_dur = float(job.structure.duration_seconds) if (job.structure and job.structure.duration_seconds > 0) else 0.0
        self._rep_player_duration_sec = known_dur
        self._rep_player_offset_sec = max(0.0, float(start_sec))
        self._rep_player_started_monotonic = time.monotonic()
        self._rep_player_seeking = False
        self._refresh_repair_preview_button_states()
        self._sync_repair_player_bar_ui(position_sec=self._rep_player_offset_sec)
        self._stop_rep_player_timers()
        self._rep_player_timer_id = GLib.timeout_add(200, self._on_rep_player_tick)

        def _spawn_and_wait() -> None:
            procs_started: list[subprocess.Popen] = []
            try:
                if known_dur <= 0.0:
                    probed_dur = self._probe_audio_duration_seconds(play_path)
                    if probed_dur > 0.0:
                        def _apply_probed_dur() -> bool:
                            if self._preview_token == token:
                                self._rep_player_duration_sec = probed_dur
                                self._sync_repair_player_bar_ui()
                            return False
                        GLib.idle_add(_apply_probed_dur)

                seek_val = max(0.0, float(start_sec))
                cmd: list[str] | None = None
                use_ffmpeg_pipe = False
                if shutil.which("ffplay"):
                    cmd = ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"]
                    if seek_val > 0.05:
                        cmd.extend(["-ss", f"{seek_val:.2f}"])
                    cmd.append(str(play_path))
                elif shutil.which("mpv"):
                    cmd = ["mpv", "--no-video", "--really-quiet"]
                    if seek_val > 0.05:
                        cmd.append(f"--start={seek_val:.2f}")
                    cmd.append(str(play_path))
                elif shutil.which("cvlc"):
                    cmd = ["cvlc", "--play-and-exit", "--intf", "dummy", "--quiet"]
                    if seek_val > 0.05:
                        cmd.append(f"--start-time={seek_val:.2f}")
                    cmd.append(str(play_path))
                elif seek_val > 0.05 and shutil.which("ffmpeg") and shutil.which("paplay"):
                    use_ffmpeg_pipe = True
                elif shutil.which("gst-play-1.0"):
                    cmd = ["gst-play-1.0", "--quiet", str(play_path)]
                elif shutil.which("paplay"):
                    cmd = ["paplay", str(play_path)]
                elif shutil.which("aplay") and play_path.suffix.lower() == ".wav":
                    cmd = ["aplay", "-q", str(play_path)]

                if not cmd and not use_ffmpeg_pipe:
                    self._append_query_log_threadsafe(
                        "[Reparatur · Vorhören] Kein Audio-Player gefunden (erforderlich: ffplay/ffmpeg, mpv, cvlc oder gst-play-1.0)."
                    )
                    return

                if use_ffmpeg_pipe:
                    p_dec = subprocess.Popen(
                        [
                            "ffmpeg",
                            "-v",
                            "error",
                            "-ss",
                            f"{seek_val:.2f}",
                            "-i",
                            str(play_path),
                            "-f",
                            "wav",
                            "-",
                        ],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                    )
                    p_out = subprocess.Popen(
                        ["paplay"],
                        stdin=p_dec.stdout,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    if p_dec.stdout is not None:
                        p_dec.stdout.close()
                    procs_started.extend([p_dec, p_out])
                else:
                    p = subprocess.Popen(
                        cmd,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    procs_started.append(p)

                started_mono = time.monotonic()

                def _register_and_check() -> bool:
                    if self._preview_token != token:
                        for pr in procs_started:
                            try:
                                if pr.poll() is None:
                                    pr.terminate()
                            except Exception:
                                pass
                        return False
                    self._preview_procs = procs_started
                    self._rep_player_started_monotonic = started_mono
                    self._rep_player_offset_sec = seek_val
                    self._sync_repair_player_bar_ui(position_sec=seek_val)
                    return False

                GLib.idle_add(_register_and_check)
                if log_start:
                    variant_lbl = (
                        "Repariert"
                        if (job.output_path is not None and play_path == job.output_path)
                        else "Original"
                    )
                    self._append_query_log_threadsafe(
                        f"[Reparatur · Vorhören] Spiele „{job.relative_path}“ ({variant_lbl}) ab..."
                    )
                for pr in reversed(procs_started):
                    pr.wait()
            except Exception as exc:
                self._append_query_log_threadsafe(
                    f"[Reparatur · Vorhören] Wiedergabefehler: {exc}"
                )
            finally:
                for pr in procs_started:
                    try:
                        if pr.poll() is None:
                            pr.terminate()
                    except Exception:
                        pass

                def _on_finished() -> bool:
                    if self._preview_token == token:
                        self._stop_rep_player_timers()
                        self._playing_repair_job_id = None
                        self._rep_player_duration_sec = 0.0
                        self._rep_player_offset_sec = 0.0
                        self._rep_player_started_monotonic = 0.0
                        self._rep_player_seeking = False
                        self._preview_procs.clear()
                        self._preview_session = None
                        self._refresh_repair_preview_button_states()
                        self._sync_repair_player_bar_ui(position_sec=0.0)
                    return False

                GLib.idle_add(_on_finished)

        threading.Thread(target=_spawn_and_wait, daemon=True).start()

    def _stop_track_preview(self, log: bool = True) -> None:
        self._preview_token += 1
        self._stop_rep_player_timers()
        was_playing_idx = self._playing_track_idx
        was_playing_repair_id = getattr(self, "_playing_repair_job_id", None)
        self._playing_track_idx = None
        self._playing_repair_job_id = None
        self._rep_player_duration_sec = 0.0
        self._rep_player_offset_sec = 0.0
        self._rep_player_started_monotonic = 0.0
        self._rep_player_seeking = False
        session = self._preview_session
        self._preview_session = None
        if session is not None:
            try:
                session.stop()
            except Exception:
                pass
        procs = list(self._preview_procs)
        self._preview_procs.clear()
        for proc in procs:
            try:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=0.5)
                    except Exception:
                        proc.kill()
            except Exception:
                pass
        self._refresh_preview_button_states()
        self._refresh_repair_preview_button_states()
        self._sync_repair_player_bar_ui(position_sec=0.0)
        if log and was_playing_idx is not None and 0 <= was_playing_idx < len(self.album.tracks):
            trk = self.album.tracks[was_playing_idx]
            self._append_query_log_ui(
                f"[Vorhören] Wiedergabe von Titel #{trk.track_number:02d} („{trk.title}“) gestoppt."
            )
        if log and was_playing_repair_id is not None:
            stopped_job = self._repair_jobs_by_id.get(was_playing_repair_id) or next(
                (j for j in self.repair_manager.jobs if j.job_id == was_playing_repair_id), None
            )
            if stopped_job is not None:
                self._append_query_log_ui(
                    f"[Reparatur · Vorhören] Wiedergabe von „{stopped_job.relative_path}“ gestoppt."
                )

    def _on_stop_track_clicked(self) -> None:
        self._stop_track_preview(log=True)

    def _on_play_track_clicked(self, track_idx: int) -> None:
        if track_idx < 0 or track_idx >= len(self.album.tracks):
            return
        self._stop_track_preview(log=False)
        trk = self.album.tracks[track_idx]
        device_path = self._get_selected_drive()
        token = self._preview_token
        self._playing_track_idx = track_idx
        self._refresh_preview_button_states()

        def _spawn_and_wait() -> None:
            procs_started: list[subprocess.Popen] = []
            cd_speed_device: Optional[str] = None
            try:
                src_path = Path(trk.source_file) if trk.source_file else None
                if src_path and src_path.exists():
                    cmd: list[str] | None = None
                    if shutil.which("ffplay"):
                        cmd = ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", str(src_path)]
                    elif shutil.which("mpv"):
                        cmd = ["mpv", "--no-video", "--really-quiet", str(src_path)]
                    elif shutil.which("cvlc"):
                        cmd = ["cvlc", "--play-and-exit", "--intf", "dummy", "--quiet", str(src_path)]
                    elif shutil.which("gst-play-1.0"):
                        cmd = ["gst-play-1.0", "--quiet", str(src_path)]
                    elif shutil.which("paplay"):
                        cmd = ["paplay", str(src_path)]
                    elif shutil.which("aplay") and src_path.suffix.lower() == ".wav":
                        cmd = ["aplay", "-q", str(src_path)]

                    if not cmd:
                        self._append_query_log_threadsafe(
                            "[Vorhören] Kein Audio-Player gefunden (erforderlich: ffplay/ffmpeg, mpv, cvlc oder gst-play-1.0)."
                        )
                        return

                    p = subprocess.Popen(
                        cmd,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    procs_started.append(p)
                else:
                    real_dev = os.path.realpath(device_path) if os.path.exists(device_path) else device_path
                    tray_state = get_cd_tray_state(real_dev)
                    if tray_state.get("tray_open"):
                        GLib.idle_add(self._update_tray_button_ui, True)
                        self._append_query_log_threadsafe(
                            f"[Vorhören] CD-Schlitten ({device_path}) ist geöffnet – bitte Laufwerk zuerst schließen."
                        )
                        return
                    if tray_state.get("exists") and tray_state.get("status_code") == 1:
                        self._append_query_log_threadsafe(
                            f"[Vorhören] Keine Audio-CD im Laufwerk {device_path} eingelegt."
                        )
                        return

                    # 1. Gepufferte & laufwerksgedrosselte CD-Wiedergabe (max. 2x-Speed + 2,0s Pre-Buffer + Ringpuffer)
                    audio_sink_cmds: list[list[str]] = []
                    if shutil.which("pw-play"):
                        audio_sink_cmds.append(["pw-play", "-"])
                    if shutil.which("ffplay"):
                        audio_sink_cmds.append(["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-i", "pipe:0"])
                    if shutil.which("mpv"):
                        audio_sink_cmds.append(
                            ["mpv", "--no-video", "--really-quiet", "--cache=yes", "--audio-buffer=0.4", "-"]
                        )
                    if shutil.which("paplay"):
                        audio_sink_cmds.append(["paplay"])
                    if shutil.which("aplay"):
                        audio_sink_cmds.append(["aplay", "-q", "-B", "250000"])

                    sector_count = (
                        (trk.end_lsn - trk.start_lsn + 1)
                        if (trk.end_lsn >= trk.start_lsn and trk.end_lsn > 0)
                        else 0
                    )
                    expected_pcm_bytes = (
                        sector_count * 2352
                        if sector_count > 0
                        else max(0, int(trk.duration_seconds or 0) * CD_PCM_BYTES_PER_SEC)
                    )

                    phys_trk_num = int(getattr(trk, "toc_track_number", 0) or 0) or int(trk.track_number)
                    if shutil.which("cdparanoia") and audio_sink_cmds:
                        session = BufferedCdPlaybackSession(
                            device_path=real_dev,
                            track_number=phys_trk_num,
                            expected_pcm_bytes=expected_pcm_bytes,
                            read_speed=2,
                        )
                        if self._preview_token != token:
                            return
                        self._preview_session = session
                        self._append_query_log_threadsafe(
                            f"[Vorhören] Puffere CD-Titel #{trk.track_number:02d} („{trk.title}“) mit harter 2x-Drosselung (~2,0s Puffer)..."
                        )
                        played_via_buffer = session.start_and_wait(
                            audio_sink_cmds,
                            cancel_check=lambda: self._preview_token != token,
                            on_playing=lambda: self._append_query_log_threadsafe(
                                f"[Vorhören] Spiele CD-Titel #{trk.track_number:02d} („{trk.title}“) flüssig ab..."
                            ),
                        )
                        self._preview_session = None
                        if played_via_buffer or self._preview_token != token:
                            return

                    # 2. Sekundäre Fallbacks (direkte cdda://-Wiedergabe mit harter 2x-Geschwindigkeit falls cdparanoia nicht verfügbar)
                    cd_speed_device = real_dev
                    set_cd_read_speed(real_dev, 2)
                    direct_cd_cmds: list[list[str]] = []
                    if shutil.which("mpv"):
                        direct_cd_cmds.append(
                            [
                                "mpv",
                                "--no-video",
                                "--really-quiet",
                                "--cdda-speed=2",
                                "--cache=yes",
                                "--audio-buffer=0.5",
                                f"cdda://{phys_trk_num}",
                                f"--cdrom-device={real_dev}",
                            ]
                        )
                    if shutil.which("cvlc"):
                        direct_cd_cmds.append(
                            [
                                "cvlc",
                                "--play-and-exit",
                                "--intf",
                                "dummy",
                                "--quiet",
                                "--cdrom-caching=3000",
                                f"cdda://{real_dev}@{phys_trk_num}",
                            ]
                        )
                    if shutil.which("ffplay"):
                        direct_cd_cmds.append(
                            ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-f", "libcdio", "-i", real_dev]
                        )
                    started_ok = False
                    for d_cmd in direct_cd_cmds:
                        if self._preview_token != token:
                            return
                        p = subprocess.Popen(
                            d_cmd,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                        time.sleep(0.25)
                        if p.poll() is None:
                            procs_started.append(p)
                            started_ok = True
                            break

                    if not started_ok:
                        self._append_query_log_threadsafe(
                            f"[Vorhören] CD-Wiedergabe für Titel #{trk.track_number:02d} auf {device_path} fehlgeschlagen (prüfen Sie CD-Einlage sowie cdparanoia/ffplay/mpv)."
                        )
                        return

                    def _fallback_speed_guard() -> None:
                        # Nach dem Anlaufen (Spin-up) sofort erneut auf 2x sperren und alle 2,5s erneuern
                        time.sleep(0.8)
                        while self._preview_token == token and any(pr.poll() is None for pr in procs_started):
                            set_cd_read_speed(real_dev, 2)
                            for _ in range(25):
                                if self._preview_token != token or not any(pr.poll() is None for pr in procs_started):
                                    return
                                time.sleep(0.1)

                    threading.Thread(target=_fallback_speed_guard, daemon=True).start()

                def _register_and_check() -> bool:
                    if self._preview_token != token:
                        for pr in procs_started:
                            try:
                                if pr.poll() is None:
                                    pr.terminate()
                            except Exception:
                                pass
                        return False
                    self._preview_procs = procs_started
                    return False

                GLib.idle_add(_register_and_check)
                self._append_query_log_threadsafe(
                    f"[Vorhören] Spiele Titel #{trk.track_number:02d} („{trk.title}“) ab..."
                )
                for pr in reversed(procs_started):
                    pr.wait()
            except Exception as exc:
                self._append_query_log_threadsafe(f"[Vorhören] Wiedergabefehler: {exc}")
            finally:
                if cd_speed_device:
                    set_cd_read_speed(cd_speed_device, 0)
                for pr in procs_started:
                    try:
                        if pr.poll() is None:
                            pr.terminate()
                    except Exception:
                        pass

                def _on_finished() -> bool:
                    if self._preview_token == token:
                        self._playing_track_idx = None
                        self._preview_procs.clear()
                        self._preview_session = None
                        self._refresh_preview_button_states()
                    return False

                GLib.idle_add(_on_finished)

        threading.Thread(target=_spawn_and_wait, daemon=True).start()

    def _on_track_title_changed(self, entry: Gtk.Entry, track: TrackMetadata) -> None:
        val = entry.get_text()
        track.title = val
        if getattr(track, "has_shazam_alternative", False) or getattr(track, "has_mb_alternative", False):
            var = getattr(track, "active_metadata_variant", "")
            if var == "original":
                track.original_title = val
            elif var == "musicbrainz":
                track.mb_title = val
            elif var == "shazam":
                track.shazam_title = val

    def _on_track_artist_changed(self, entry: Gtk.Entry, track: TrackMetadata) -> None:
        val = entry.get_text()
        track.artist = val
        if getattr(track, "has_shazam_alternative", False) or getattr(track, "has_mb_alternative", False):
            var = getattr(track, "active_metadata_variant", "")
            if var == "original":
                track.original_artist = val
            elif var == "musicbrainz":
                track.mb_artist = val
            elif var == "shazam":
                track.shazam_artist = val

    def _on_track_genre_changed(self, entry: Gtk.Entry, track: TrackMetadata) -> None:
        val = entry.get_text()
        track.genre = val
        if getattr(track, "has_shazam_alternative", False) or getattr(track, "has_mb_alternative", False):
            var = getattr(track, "active_metadata_variant", "")
            if var == "original":
                track.original_genre = val
            elif var == "musicbrainz":
                track.mb_genre = val
            elif var == "shazam":
                track.shazam_genre = val

    def _on_toggle_shazam_variant_clicked(self, _btn: Gtk.Button, track: TrackMetadata) -> None:
        has_shazam = bool(getattr(track, "has_shazam_alternative", False))
        has_mb = bool(getattr(track, "has_mb_alternative", False))
        if not (has_shazam or has_mb):
            return
        variants: list[str] = ["original"]
        if has_shazam:
            variants.append("shazam")
        if has_mb:
            variants.append("musicbrainz")

        cur = getattr(track, "active_metadata_variant", "")
        if cur in variants:
            next_variant = variants[(variants.index(cur) + 1) % len(variants)]
        else:
            next_variant = "original"

        if next_variant == "original":
            next_title = track.original_title
            next_artist = track.original_artist
            next_genre = getattr(track, "original_genre", "")
            next_source = track.original_metadata_source
            label_name = "Original"
        elif next_variant == "musicbrainz":
            next_title = getattr(track, "mb_title", "") or track.title
            next_artist = getattr(track, "mb_artist", "") or track.artist
            next_genre = getattr(track, "mb_genre", "")
            next_source = getattr(track, "mb_metadata_source", "") or "MusicBrainz (Einzeltrack)"
            label_name = "MusicBrainz"
        else:
            next_title = track.shazam_title
            next_artist = track.shazam_artist
            next_genre = getattr(track, "shazam_genre", "")
            next_source = track.shazam_metadata_source or "Shazam"
            label_name = "Shazam"

        track.title = next_title
        track.artist = next_artist
        track.artists = [p.strip() for p in normalize_multi_artist(next_artist).split(";") if p.strip()]
        track.genre = next_genre
        track.metadata_source = next_source
        track.active_metadata_variant = next_variant
        self._populate_album_ui()
        log_prefix = "MusicBrainz-Vergleich" if (has_mb and not has_shazam) else "Ergebnis-Vergleich" if (has_mb and has_shazam) else "Shazam-Vergleich"
        self._append_query_log_ui(
            f"[{log_prefix} #{track.track_number:02d}] Umgeschaltet auf {label_name}: "
            f"„{next_artist or '—'} – {next_title or '—'}“ · Genre: {next_genre or '—'}."
        )

    def _apply_shazam_result_to_track(self, idx: int, res: dict) -> None:
        if idx < 0 or idx >= len(self.album.tracks):
            return
        trk = self.album.tracks[idx]
        preserve_prior_original = (
            bool(getattr(trk, "has_shazam_alternative", False))
            or bool(getattr(trk, "has_mb_alternative", False))
        ) and getattr(trk, "active_metadata_variant", "") in ("shazam", "musicbrainz")
        orig_title = trk.original_title if preserve_prior_original else trk.title
        orig_artist = (
            trk.original_artist
            if preserve_prior_original
            else normalize_multi_artist(trk.artist or self.album.artist or "")
        )
        orig_genre = getattr(trk, "original_genre", "") if preserve_prior_original else (getattr(trk, "genre", "") or "")
        orig_source = (
            trk.original_metadata_source if preserve_prior_original else trk.metadata_source
        )

        next_title = orig_title
        if res.get("title"):
            raw_trk_title = str(res["title"]).strip()
            next_title = (
                convert_roman_numerals_in_title(raw_trk_title)
                if getattr(self.settings, "convert_roman_numerals", True)
                else raw_trk_title
            )
        next_artist = orig_artist
        if res.get("artist"):
            next_artist = normalize_multi_artist(str(res["artist"]).strip())
        next_genre = str(res["genre"]).strip() if res.get("genre") else orig_genre
        next_source = str(res.get("method") or "Shazam")

        differs_from_original = (
            next_title.strip() != (orig_title or "").strip()
            or normalize_multi_artist(next_artist).strip()
            != normalize_multi_artist(orig_artist).strip()
            or next_genre.strip() != (orig_genre or "").strip()
        )

        trk.title = next_title
        trk.artist = next_artist
        if res.get("genre"):
            trk.genre = next_genre
        if res.get("isrc"):
            isrc_val = str(res["isrc"]).strip()
            trk.isrc = isrc_val
            if isrc_val not in trk.isrcs:
                trk.isrcs.append(isrc_val)
        if res.get("shazam_key"):
            trk.shazam_key = str(res["shazam_key"])
        if res.get("shazam_url"):
            trk.shazam_url = str(res["shazam_url"])
        trk.metadata_source = next_source

        if differs_from_original:
            trk.original_title = orig_title
            trk.original_artist = orig_artist
            trk.original_genre = orig_genre
            trk.original_metadata_source = orig_source
            trk.shazam_title = next_title
            trk.shazam_artist = next_artist
            trk.shazam_genre = next_genre
            trk.shazam_metadata_source = next_source
            trk.active_metadata_variant = "shazam"
            trk.has_shazam_alternative = True
        else:
            trk.shazam_title = ""
            trk.shazam_artist = ""
            trk.shazam_genre = ""
            trk.shazam_metadata_source = ""
            trk.has_shazam_alternative = False
            if not getattr(trk, "has_mb_alternative", False):
                trk.original_title = ""
                trk.original_artist = ""
                trk.original_genre = ""
                trk.original_metadata_source = ""
                trk.active_metadata_variant = ""
            else:
                trk.active_metadata_variant = "original"

        # Falls Album-Metadaten noch leer/generisch sind, ebenfalls ergänzen
        if res.get("album") and self.album.title in (
            "",
            "Unbekanntes Album",
            "Audio-CD (Lokal ausgelesen)",
            "Lokaler Datei-Import (Virtuelle TOC)",
        ):
            raw_alb_title = str(res["album"]).strip()
            self.album.title = (
                convert_roman_numerals_in_title(raw_alb_title)
                if getattr(self.settings, "convert_roman_numerals", True)
                else raw_alb_title
            )
        if res.get("artist") and self.album.artist in ("", "Unbekannter Künstler"):
            norm_a = normalize_multi_artist(str(res["artist"]).strip())
            self.album.artist = norm_a
            self.album.album_artist = self.album.album_artist or norm_a
        if res.get("year") and not self.album.year:
            self.album.year = str(res["year"]).strip()
        if res.get("label") and not self.album.label:
            self.album.label = str(res["label"]).strip()
        if res.get("genre") and not self.album.genre:
            self.album.genre = str(res["genre"]).strip()
        if res.get("cover_url") and not self.album.cover_art_bytes:
            c_bytes, c_mime = download_image_url(str(res["cover_url"]))
            if c_bytes:
                self._apply_cover_bytes(
                    c_bytes,
                    c_mime or "image/jpeg",
                    f"Shazam Cover (#{res.get('shazam_key', '')})",
                )

    def _on_stop_shazam_clicked(self, _btn: Gtk.Button) -> None:
        if self._shazam_cancel_event is not None:
            self._shazam_cancel_event.set()
        self.shazam_stop_btn.set_sensitive(False)
        self._append_query_log_ui(
            "[Shazam] Stopp-Anforderung gesendet – laufende Shazam-Abfrage wird abgebrochen (bisherige Treffer bleiben erhalten)..."
        )

    def _on_shazam_all_tracks_clicked(self, _widget: Gtk.Widget) -> None:
        if self._shazam_cancel_event is not None or self._mb_tracks_cancel_event is not None:
            return
        self._sync_album_from_entries()
        if not self.album.tracks:
            self._append_query_log_ui("[Shazam] Keine Titel in der Liste vorhanden.")
            return

        selected_entries = [
            (idx, trk) for idx, trk in enumerate(self.album.tracks) if trk.selected
        ]
        if not selected_entries:
            self._append_query_log_ui(
                "[Shazam] Keine Titel ausgewählt – Shazam wird nur auf ausgewählte Titel angewendet."
            )
            return

        cancel_evt = threading.Event()
        self._shazam_cancel_event = cancel_evt
        self.analyze_tracks_btn.set_sensitive(False)
        self.analyze_tracks_label.set_text("Shazam läuft...")
        self.shazam_stop_btn.set_no_show_all(False)
        self.shazam_stop_btn.set_sensitive(True)
        self.shazam_stop_btn.show_all()

        total_sel = len(selected_entries)
        shazam_sample_size = normalize_shazam_sample_size(
            getattr(self.settings, "shazam_sample_size", DEFAULT_SHAZAM_SAMPLE_SIZE)
        )
        selected_drive = self._get_selected_drive()
        self._db_progress_start(
            "shazam",
            f"Shazam-Abfrage: 0/{total_sel} Titel…",
            total=total_sel,
            current=0,
        )
        self._append_query_log_ui(
            f"[Shazam] Starte schlüssellose Shazam-Abfrage für {total_sel} ausgewählte Titel (Track-Mitte 50 %, Samplegröße: {shazam_sample_size} Samples / {shazam_sample_size / 16000.0:.1f}s)..."
        )

        def worker() -> None:
            matched_count = 0
            processed_count = 0
            try:
                for idx, trk in selected_entries:
                    if cancel_evt.is_set():
                        break
                    processed_count += 1
                    trk_name = (trk.title or "").strip() or f"Track #{trk.track_number:02d}"
                    GLib.idle_add(
                        self._db_progress_update,
                        "shazam",
                        processed_count - 1,
                        total_sel,
                        f"Shazam-Abfrage ({processed_count}/{total_sel}): „{trk_name}“…",
                    )
                    res = recognize_track_with_shazam(
                        trk,
                        album=self.album,
                        on_log=self._append_query_log_threadsafe,
                        cancel_event=cancel_evt,
                        sample_size=shazam_sample_size,
                        device_path=selected_drive,
                    )
                    if res and not cancel_evt.is_set():
                        matched_count += 1
                        GLib.idle_add(self._apply_shazam_result_to_track, idx, res)
                        GLib.idle_add(self._populate_album_ui)
                    GLib.idle_add(
                        self._db_progress_update,
                        "shazam",
                        processed_count,
                        total_sel,
                        f"Shazam-Abfrage ({processed_count}/{total_sel}): „{trk_name}“",
                    )
                    if cancel_evt.is_set():
                        break
            except Exception as exc:
                self._append_query_log_threadsafe(
                    f"[Shazam] Fehler bei der Shazam-Abfrage: {exc}"
                )

            def finish() -> bool:
                was_cancelled = cancel_evt.is_set()
                if self._shazam_cancel_event is cancel_evt:
                    self._shazam_cancel_event = None
                self.shazam_stop_btn.hide()
                self.shazam_stop_btn.set_no_show_all(True)
                self.analyze_tracks_label.set_text("Markierte Tracks analysieren")
                self._populate_album_ui()
                self._sync_select_all_state()
                if was_cancelled:
                    self._db_progress_finish(
                        "shazam",
                        f"Shazam abgebrochen ({matched_count}/{processed_count} Treffer)",
                        cancelled=True,
                    )
                    self._append_query_log_ui(
                        f"[Shazam] Abfrage vom Benutzer gestoppt ({matched_count} von {processed_count} geprüften / {total_sel} ausgewählten Titeln identifiziert; bisherige Treffer bleiben erhalten)."
                    )
                else:
                    self._db_progress_finish(
                        "shazam",
                        f"Shazam abgeschlossen: {matched_count}/{total_sel} Titel identifiziert",
                    )
                    self._append_query_log_ui(
                        f"[Shazam] Abfrage abgeschlossen: {matched_count} von {total_sel} ausgewählten Titeln erfolgreich über Shazam identifiziert."
                    )
                return False

            GLib.idle_add(finish)

        threading.Thread(target=worker, daemon=True).start()

    def _apply_mb_single_track_result(self, idx: int, res: dict) -> None:
        """Übernimmt Interpret, Titel und Genre einer MusicBrainz-Einzeltrackanalyse inkl. Original-⇄-Umschaltung."""
        if idx < 0 or idx >= len(self.album.tracks):
            return
        trk = self.album.tracks[idx]
        preserve_prior_original = (
            bool(getattr(trk, "has_mb_alternative", False))
            or bool(getattr(trk, "has_shazam_alternative", False))
        ) and getattr(trk, "active_metadata_variant", "") in ("shazam", "musicbrainz")

        orig_title = trk.original_title if preserve_prior_original else trk.title
        orig_artist = (
            trk.original_artist
            if preserve_prior_original
            else normalize_multi_artist(trk.artist or self.album.artist or "")
        )
        orig_genre = getattr(trk, "original_genre", "") if preserve_prior_original else (getattr(trk, "genre", "") or "")
        orig_source = (
            trk.original_metadata_source if preserve_prior_original else trk.metadata_source
        )

        next_title = orig_title
        if res.get("title"):
            raw_title = str(res["title"]).strip()
            next_title = (
                convert_roman_numerals_in_title(raw_title)
                if getattr(self.settings, "convert_roman_numerals", True)
                else raw_title
            )
        next_artist = orig_artist
        if res.get("artist"):
            next_artist = normalize_multi_artist(str(res["artist"]).strip())
        next_genre = str(res["genre"]).strip() if res.get("genre") else orig_genre
        next_source = str(res.get("method") or "MusicBrainz (Einzeltrack)")

        differs_from_original = (
            next_title.strip() != (orig_title or "").strip()
            or normalize_multi_artist(next_artist).strip()
            != normalize_multi_artist(orig_artist).strip()
            or next_genre.strip() != (orig_genre or "").strip()
        )

        trk.title = next_title
        trk.artist = next_artist
        trk.artists = [p.strip() for p in next_artist.split(";") if p.strip()]
        trk.genre = next_genre
        trk.metadata_source = next_source

        if differs_from_original:
            trk.original_title = orig_title
            trk.original_artist = orig_artist
            trk.original_genre = orig_genre
            trk.original_metadata_source = orig_source
            trk.mb_title = next_title
            trk.mb_artist = next_artist
            trk.mb_genre = next_genre
            trk.mb_metadata_source = next_source
            trk.active_metadata_variant = "musicbrainz"
            trk.has_mb_alternative = True
        else:
            trk.mb_title = ""
            trk.mb_artist = ""
            trk.mb_genre = ""
            trk.mb_metadata_source = ""
            trk.has_mb_alternative = False
            if not getattr(trk, "has_shazam_alternative", False):
                trk.original_title = ""
                trk.original_artist = ""
                trk.original_genre = ""
                trk.original_metadata_source = ""
                trk.active_metadata_variant = ""
            else:
                trk.active_metadata_variant = "original"

    def _on_stop_mb_tracks_clicked(self, _btn: Gtk.Button) -> None:
        if self._mb_tracks_cancel_event is not None:
            self._mb_tracks_cancel_event.set()
        self.mb_tracks_stop_btn.set_sensitive(False)
        self._append_query_log_ui(
            "[MusicBrainz Einzeltracks] Stopp-Anforderung gesendet – laufende Einzeltrackanalyse wird abgebrochen (bisherige Treffer bleiben erhalten)..."
        )

    def _on_analyze_mb_tracks_clicked(self, _widget: Gtk.Widget) -> None:
        if self._mb_tracks_cancel_event is not None or self._shazam_cancel_event is not None:
            return
        self._sync_album_from_entries()
        if not self.album.tracks:
            self._append_query_log_ui("[MusicBrainz Einzeltracks] Keine Titel in der Liste vorhanden.")
            return

        selected_entries = [
            (idx, trk) for idx, trk in enumerate(self.album.tracks) if trk.selected
        ]
        if not selected_entries:
            self._append_query_log_ui(
                "[MusicBrainz Einzeltracks] Keine Titel per Checkbox ausgewählt – bitte mindestens einen Titel aktivieren."
            )
            return

        cancel_evt = threading.Event()
        self._mb_tracks_cancel_event = cancel_evt
        self.analyze_tracks_btn.set_sensitive(False)
        self.analyze_tracks_label.set_text("Musikbrainz läuft...")
        self.mb_tracks_stop_btn.set_no_show_all(False)
        self.mb_tracks_stop_btn.set_sensitive(True)
        self.mb_tracks_stop_btn.show_all()

        total_sel = len(selected_entries)
        fallback_artist = (self.album.artist or self.album.album_artist or "").strip()
        self._db_progress_start(
            "mb_tracks",
            f"MusicBrainz Einzelanalyse: 0/{total_sel} Titel…",
            total=total_sel,
            current=0,
        )
        self._append_query_log_ui(
            f"[MusicBrainz Einzeltracks] Starte Einzeltrackanalyse für {total_sel} per Checkbox ausgewählte(n) Titel (befüllt Interpret, Titel & Genre)..."
        )

        def worker() -> None:
            matched_count = 0
            processed_count = 0
            try:
                for _pos, (idx, trk) in enumerate(selected_entries):
                    if cancel_evt.is_set():
                        break
                    processed_count += 1
                    trk_name = (trk.title or "").strip() or f"Track #{trk.track_number:02d}"
                    GLib.idle_add(
                        self._db_progress_update,
                        "mb_tracks",
                        processed_count - 1,
                        total_sel,
                        f"MusicBrainz Einzelanalyse ({processed_count}/{total_sel}): „{trk_name}“…",
                    )
                    res = analyze_single_track_musicbrainz(
                        trk,
                        fallback_artist=fallback_artist,
                        on_log=self._append_query_log_threadsafe,
                        cancel_event=cancel_evt,
                    )
                    if res and not cancel_evt.is_set():
                        matched_count += 1
                        GLib.idle_add(self._apply_mb_single_track_result, idx, res)
                        GLib.idle_add(self._populate_album_ui)
                    GLib.idle_add(
                        self._db_progress_update,
                        "mb_tracks",
                        processed_count,
                        total_sel,
                        f"MusicBrainz Einzelanalyse ({processed_count}/{total_sel}): „{trk_name}“",
                    )
            except InterruptedError:
                pass
            except Exception as exc:
                self._append_query_log_threadsafe(
                    f"[MusicBrainz Einzeltracks] Fehler bei der Einzeltrackanalyse: {exc}"
                )

            def finish() -> bool:
                was_cancelled = cancel_evt.is_set()
                if self._mb_tracks_cancel_event is cancel_evt:
                    self._mb_tracks_cancel_event = None
                self.mb_tracks_stop_btn.hide()
                self.mb_tracks_stop_btn.set_no_show_all(True)
                self.analyze_tracks_label.set_text("Markierte Tracks analysieren")
                self._populate_album_ui()
                self._sync_select_all_state()
                if was_cancelled:
                    self._db_progress_finish(
                        "mb_tracks",
                        f"MusicBrainz Einzelanalyse abgebrochen ({matched_count}/{processed_count} aktualisiert)",
                        cancelled=True,
                    )
                    self._append_query_log_ui(
                        f"[MusicBrainz Einzeltracks] Analyse vom Benutzer gestoppt ({matched_count} von {processed_count} geprüften / {total_sel} ausgewählten Titeln aktualisiert)."
                    )
                else:
                    self._db_progress_finish(
                        "mb_tracks",
                        f"MusicBrainz Einzelanalyse abgeschlossen: {matched_count}/{total_sel} Titel aktualisiert",
                    )
                    self._append_query_log_ui(
                        f"[MusicBrainz Einzeltracks] Abgeschlossen: {matched_count} von {total_sel} ausgewählten Titeln erfolgreich aktualisiert (Interpret, Titel & Genre)."
                    )
                return False

            GLib.idle_add(finish)

        threading.Thread(target=worker, daemon=True).start()

    def _on_stop_verify_clicked(self, _btn: Gtk.Button) -> None:
        if self._verify_cancel_event is not None:
            self._verify_cancel_event.set()
        self.verify_stop_btn.set_sensitive(False)
        self._append_query_log_ui(
            "[Prüfung] Stopp-Anforderung gesendet – laufende Abfrage wird abgebrochen (bisherige Änderungen bleiben erhalten)..."
        )

    def _on_split_artists_clicked(self, _btn: Gtk.Button) -> None:
        self._sync_album_from_entries()
        if self.album.tracks and not any(t.selected for t in self.album.tracks):
            self._append_query_log_ui(
                "[Interpretensplitter] Keine Titel ausgewählt – Interpretensplitter wird nur auf ausgewählte Titel angewendet."
            )
            return
        changes = run_artist_splitter_on_album(self.album, only_selected=True)
        self._populate_album_ui()
        if not changes:
            self._append_query_log_ui(
                "[Interpretensplitter] Keine verketteten Interpreten oder Feature-Zusätze in den ausgewählten Titeln gefunden."
            )
            return
        self._append_query_log_ui(
            f"[Interpretensplitter] {len(changes)} Eintrag/Einträge in ausgewählten Titeln aufgesplittet bzw. aus Titeln ins Interpretenfeld übernommen (; getrennt):"
        )
        for scope, detail in changes:
            self._append_query_log_ui(f"[Interpretensplitter] {scope}: {detail}")

    def _on_verify_field_clicked(self, _btn: Gtk.Button, field: str = "artist") -> None:
        if self._verify_cancel_event is not None:
            return
        self._sync_album_from_entries()

        selected_tracks = [t for t in self.album.tracks if t.selected]
        tag_map = {
            "artist": ("[Interpreten-Prüfung]", "Interpretennamen"),
            "composer": ("[Komponist-Prüfung]", "Komponisten"),
            "orchestra": ("[Orchester-Prüfung]", "Orchesternamen"),
            "conductor": ("[Dirigent-Prüfung]", "Dirigenten"),
        }
        tag, noun = tag_map.get(field, ("[Prüfung]", "Einträge"))

        if self.album.tracks and not selected_tracks:
            self._append_query_log_ui(
                f"{tag} Keine Titel ausgewählt – Prüfung wird nur auf ausgewählte Titel angewendet."
            )
            return

        include_album_fields = (len(self.album.tracks) == 0) or (
            len(selected_tracks) == len(self.album.tracks)
        )

        if field == "artist":
            has_any = (
                include_album_fields
                and (bool(self.album.artist.strip()) or bool((self.album.album_artist or "").strip()))
            ) or any(bool(t.artist.strip()) for t in selected_tracks)
            empty_msg = "[Interpreten-Prüfung] Keine Interpretennamen in den ausgewählten Titeln zum Prüfen vorhanden."
        else:
            has_any = (
                include_album_fields and bool(str(getattr(self.album, field, "") or "").strip())
            ) or any(bool(str(getattr(t, field, "") or "").strip()) for t in selected_tracks)
            empty_msg = f"{tag} Keine {noun} in den ausgewählten Titeln zum Prüfen vorhanden."

        if not has_any:
            self._append_query_log_ui(empty_msg)
            return

        btn_map = {
            "artist": (self.verify_artists_btn, self.verify_artists_label, "Interpreten prüfen", "Prüfe Interpreten..."),
            "composer": (self.verify_composer_btn, self.verify_composer_label, "Komponist prüfen", "Prüfe Komponist..."),
            "orchestra": (self.verify_orchestra_btn, self.verify_orchestra_label, "Orchester prüfen", "Prüfe Orchester..."),
            "conductor": (self.verify_conductor_btn, self.verify_conductor_label, "Dirigent prüfen", "Prüfe Dirigent..."),
        }
        all_verify_btns = [
            self.verify_artists_btn,
            self.verify_composer_btn,
            self.verify_orchestra_btn,
            self.verify_conductor_btn,
            self.split_artists_btn,
        ]
        for b in all_verify_btns:
            b.set_sensitive(False)

        cancel_evt = threading.Event()
        self._verify_cancel_event = cancel_evt
        self.verify_stop_btn.set_no_show_all(False)
        self.verify_stop_btn.set_sensitive(True)
        self.verify_stop_btn.show_all()

        _active_btn, active_lbl, idle_txt, busy_txt = btn_map.get(
            field, btn_map["artist"]
        )
        active_lbl.set_text(busy_txt)
        target_album = self.album
        self._db_progress_start(
            "verify",
            f"{noun}-Prüfung läuft (MusicBrainz & Wikidata)…",
        )

        def worker() -> None:
            try:
                verify_and_internationalize_artists(
                    target_album,
                    on_log=self._append_query_log_threadsafe,
                    field=field,
                    cancel_event=cancel_evt,
                    only_selected=True,
                )
            except Exception as exc:
                self._append_query_log_threadsafe(
                    f"[Prüfung] Fehler bei der Prüfung ({field}): {exc}"
                )

            def finish() -> bool:
                was_cancelled = cancel_evt.is_set()
                self._verify_cancel_event = None
                self.verify_stop_btn.hide()
                self.verify_stop_btn.set_no_show_all(True)
                active_lbl.set_text(idle_txt)
                for b in all_verify_btns:
                    b.set_sensitive(True)
                self._populate_album_ui()
                if was_cancelled:
                    self._db_progress_finish(
                        "verify",
                        f"{noun}-Prüfung abgebrochen",
                        cancelled=True,
                    )
                else:
                    self._db_progress_finish(
                        "verify",
                        f"{noun}-Prüfung abgeschlossen",
                    )
                return False

            GLib.idle_add(finish)

        threading.Thread(target=worker, daemon=True).start()

    def _on_reorder_track(self, from_idx: int, to_idx: int) -> None:
        item = self.album.tracks.pop(from_idx)
        self.album.tracks.insert(to_idx, item)
        per_disc_pos: dict[int, int] = {}
        for trk in self.album.tracks:
            d = max(1, int(getattr(trk, "disc_number", 1) or 1))
            per_disc_pos[d] = per_disc_pos.get(d, 0) + 1
            trk.track_number = per_disc_pos[d]
        synthesize_toc_from_tracks(self.album)
        self._render_track_list()
        self._append_query_log_ui(
            f"[Reihenfolge] Titel „{item.title}“ von Position {from_idx + 1} auf Position {to_idx + 1} verschoben · "
            f"TOC neu berechnet (CDDB-ID {self.album.cddb_id}, MB-DiscID {self.album.musicbrainz_disc_id or '-'})."
        )

    def _update_status_label(self, text: str) -> bool:
        self.cover_status_label.set_text(text)
        return False

    def _clear_query_log(self) -> bool:
        buf = self.query_log_view.get_buffer()
        buf.set_text("")
        return False

    def _append_query_log_ui(self, line: str) -> bool:
        with self._query_log_lock:
            pending = self._pending_log_lines
            self._pending_log_lines = []
            if self._query_log_timer_id:
                try:
                    GLib.source_remove(self._query_log_timer_id)
                except Exception:
                    pass
                self._query_log_timer_id = 0
        if pending:
            self._append_query_log_batch_ui(pending)
        self._append_query_log_batch_ui([line])
        return False

    def _init_query_log_tags(self) -> None:
        if not hasattr(self, "query_log_view"):
            return
        buf = self.query_log_view.get_buffer()
        tag_table = buf.get_tag_table()
        for name, weight in (
            ("log_local", Pango.Weight.SEMIBOLD),
            ("log_remote", Pango.Weight.SEMIBOLD),
            ("log_cache", Pango.Weight.NORMAL),
            ("log_error", Pango.Weight.SEMIBOLD),
            ("log_shazam", Pango.Weight.SEMIBOLD),
            ("log_discogs", Pango.Weight.SEMIBOLD),
            ("log_settings", Pango.Weight.NORMAL),
        ):
            if tag_table.lookup(name) is None:
                buf.create_tag(name, weight=weight)
        self._update_query_log_tag_colors()

    def _update_query_log_tag_colors(self) -> None:
        if not hasattr(self, "query_log_view"):
            return
        dark = bool(hasattr(self, "theme_watcher") and self.theme_watcher.is_dark_active())
        palette = (
            {
                "log_local": "#4ADE80",
                "log_remote": "#60A5FA",
                "log_cache": "#2DD4BF",
                "log_error": "#F87171",
                "log_shazam": "#7DD3FC",
                "log_discogs": "#FCD34D",
                "log_settings": "#58A6FF",
            }
            if dark
            else {
                "log_local": "#047857",
                "log_remote": "#1D4ED8",
                "log_cache": "#0F766E",
                "log_error": "#C62828",
                "log_shazam": "#0369A1",
                "log_discogs": "#B45309",
                "log_settings": "#0969DA",
            }
        )
        tag_table = self.query_log_view.get_buffer().get_tag_table()
        for name, color in palette.items():
            tag = tag_table.lookup(name)
            if tag is not None:
                tag.set_property("foreground", color)

    @staticmethod
    def _classify_query_log_tag(line: str) -> Optional[str]:
        low = line.lower()
        if any(tok in low for tok in ("fehler", "nicht erreichbar", "kein cover", "abgebrochen")):
            return "log_error"
        if "[LOKAL" in line:
            return "log_local"
        if "[ENTFERNT" in line:
            return "log_remote"
        if "[CACHE" in line:
            return "log_cache"
        if "shazam" in low:
            return "log_shazam"
        if "discogs" in low:
            return "log_discogs"
        if "[einstellungen]" in low or "[profil]" in low or "[ansicht]" in low:
            return "log_settings"
        return None

    def _append_query_log_batch_ui(self, lines: list[str]) -> bool:
        if not lines or not hasattr(self, "query_log_view"):
            return False
        ts = datetime.now().strftime("%H:%M:%S")
        formatted_lines = [
            f"[{ts}] {line}" if not line.startswith("[2") and not line.startswith(f"[{ts[:2]}") else line
            for line in lines
        ]
        buf = self.query_log_view.get_buffer()
        tag_table = buf.get_tag_table()
        for fmt_line in formatted_lines:
            end_iter = buf.get_end_iter()
            prefix = "\n" if buf.get_char_count() > 0 else ""
            tag_name = self._classify_query_log_tag(fmt_line)
            tag = tag_table.lookup(tag_name) if tag_name else None
            if tag is not None:
                if prefix:
                    buf.insert(end_iter, prefix)
                    end_iter = buf.get_end_iter()
                buf.insert_with_tags(end_iter, fmt_line, tag)
            else:
                buf.insert(end_iter, f"{prefix}{fmt_line}")
        line_cnt = buf.get_line_count()
        if line_cnt > 2200:
            trim_iter = buf.get_iter_at_line(line_cnt - 1600)
            buf.delete(buf.get_start_iter(), trim_iter)
        mark = buf.create_mark(None, buf.get_end_iter(), False)
        self.query_log_view.scroll_to_mark(mark, 0.0, True, 0.0, 1.0)
        buf.delete_mark(mark)
        return False

    def _flush_pending_query_logs(self) -> bool:
        with self._query_log_lock:
            self._query_log_timer_id = 0
            batch = self._pending_log_lines
            self._pending_log_lines = []
        if batch:
            self._append_query_log_batch_ui(batch)
        return False

    def _append_query_log_threadsafe(self, line: str) -> None:
        with self._query_log_lock:
            self._pending_log_lines.append(line)
            if not self._query_log_timer_id:
                self._query_log_timer_id = GLib.timeout_add(80, self._flush_pending_query_logs)

    def _reset_all_fields_state(self, emit_log: bool = True, log_reason: str = "") -> None:
        """Setzt alle Metadaten-Felder, das Vorschaubild, die Trackliste und die Stapelverarbeitung vollständig zurück."""
        self._stop_track_preview(log=False)
        if self._shazam_cancel_event is not None:
            self._shazam_cancel_event.set()
            self._shazam_cancel_event = None
        if self._mb_tracks_cancel_event is not None:
            self._mb_tracks_cancel_event.set()
            self._mb_tracks_cancel_event = None
        if self._verify_cancel_event is not None:
            self._verify_cancel_event.set()
            self._verify_cancel_event = None
        self._tag_health_scan_gen += 1
        keep_classical = self.album.is_classical
        self.album = AlbumMetadata(title="", artist="", album_artist="", is_classical=keep_classical)
        self.entry_album.set_text("")
        self.entry_album_artist.set_text("")
        self.entry_artist.set_text("")
        self.entry_composer.set_text("")
        self.entry_orchestra.set_text("")
        self.entry_conductor.set_text("")
        self._disc_conflict = False
        self.spin_disc_number.get_style_context().remove_class("disc-conflict")
        self._updating_disc_ui = True
        try:
            self.spin_disc_number.set_value(1)
            self.spin_disc_number.set_text("1")
            self.spin_total_discs.set_value(1)
        finally:
            self._updating_disc_ui = False
        self.entry_year.set_text("")
        self.entry_genre.set_text("")
        self.entry_label.set_text("")
        self.entry_cddb_id.set_text("")
        self.entry_mbid.set_text("")
        self.entry_discogs_id.set_text("")
        self.entry_asin.set_text("")
        self.entry_barcode.set_text("")
        for f_entry in getattr(self, "_dynamic_left_entries", {}).values():
            f_entry.set_text("")
        self._candidate_hits.clear()
        self.hits_store.clear()
        self.hits_frame.set_label(
            "Gefundene Alben — Trefferliste (Bitte das korrekte Album auswählen und laden)"
        )
        self.hits_status_label.set_text(
            "Noch keine Trefferliste geladen. Suchbegriff oben eingeben oder CD einlesen."
        )
        self.search_entry.set_text("")
        self.batch_manager.clear_all()
        self.batch_store.clear()
        self._job_iters.clear()
        self._job_last_stage.clear()
        self._batch_group_iters.clear()
        self._batch_group_jobs.clear()
        self._batch_group_was_completed.clear()
        self._batch_running = False
        self._batch_paused = False
        self._awaiting_album_selection = False
        self._album_loaded_in_tracks = False
        self._active_display = "tracks"
        self._apply_left_tag_field_visibility()
        self._update_multi_disc_indicator()
        self._render_cover_preview()
        self._render_track_list()
        self._sync_disc_number_from_track_selection(emit_log=False)
        self._update_workspace_visibility_and_locks()
        if emit_log:
            self._append_query_log_ui(
                log_reason
                or "[Reset] Alle Metadaten-Felder, Cover-Vorschau, Trefferliste, Trackliste und Stapelverarbeitung zurückgesetzt."
            )

    def _reset_module_cache(self) -> None:
        """Setzt beim Modulwechsel laufende Abfragen, Ergebnisse, Felder, Cover und Stapelverarbeitung vollständig zurück."""
        if self._cover_search_cancel_event is not None:
            self._cover_search_cancel_event.set()
            self._cover_search_cancel_event = None
        if self._scanner_cancel_event is not None:
            self._scanner_cancel_event.set()
            self._scanner_cancel_event = None
        if self._scanner_proc is not None:
            try:
                self._scanner_proc.terminate()
            except Exception:
                pass
            self._scanner_proc = None
        self._set_cover_search_running_ui(False)
        self._set_hits_search_running_ui(False)
        self._set_preview_overlays_ui(left=False, right=False)
        self._db_progress_clear_all()
        self._reset_all_fields_state(emit_log=False)
        if hasattr(self, "convert_local_flac_chk"):
            self.convert_local_flac_chk.set_active(False)
        self._populate_inline_cover_candidates([])
        self._reset_converter_cache()
        self._reset_repair_cache()

    def _on_reset_all_fields_clicked(self, _btn: Gtk.Button) -> None:
        self._reset_all_fields_state(emit_log=True)

    def _resolve_import_start_dir(self) -> Path:
        for cand in (
            getattr(self.settings, "last_import_dir", None),
            getattr(self.settings, "output_dir", None),
            Path.home() / "Musik",
            Path.home(),
        ):
            if cand is not None:
                p = Path(cand).expanduser()
                if p.exists() and p.is_dir():
                    return p
        return Path.home()

    def _remember_import_dir(self, selected_path: Path, is_dir: bool = False) -> Path:
        resolved = selected_path.expanduser()
        target_dir = resolved if (is_dir or resolved.is_dir()) else resolved.parent
        if not target_dir.exists():
            target_dir = self._resolve_import_start_dir()
        self.settings.last_import_dir = target_dir
        save_settings(self.settings, theme_mode=self.theme_watcher.mode)
        return target_dir

    def _on_open_filename_to_tags_clicked(self, _btn: Gtk.Button) -> None:
        if self._batch_running and not self._batch_paused:
            return
        self._append_query_log_ui(
            "[Dateiname → Tags] EasyTAG-Maskeneditor geöffnet."
        )
        dialog = FilenameToTagsDialog(self, self.album)
        response = dialog.run()
        mask = dialog.get_current_mask()
        opts = dialog.get_current_options()
        dialog.destroy()

        if response != Gtk.ResponseType.OK or not mask:
            return

        matched, total_checked, touched_fields = apply_filename_mask_to_album(
            self.album, mask, opts
        )
        self._populate_album_ui()
        self._update_workspace_visibility_and_locks()
        fields_txt = ", ".join(touched_fields) if touched_fields else "keine Änderungen"
        self._append_query_log_ui(
            f"[Dateiname → Tags] Maske „{mask}“ auf {matched}/{total_checked} Titel angewendet (Felder: {fields_txt})."
        )

    def _on_import_folder_clicked(self, _btn: Gtk.Button) -> None:
        if self._batch_running and not self._batch_paused:
            return
        self._reset_all_fields_state(
            emit_log=True,
            log_reason="[Ordner-Import] Alle Felder, Trackliste, Trefferliste und Stapelverarbeitung vor dem Ordner-Import zurückgesetzt.",
        )
        start_dir = self._resolve_import_start_dir()

        self._append_query_log_ui(
            f"[Ordner-Import] Dialog zur Auswahl eines Album-Verzeichnisses geöffnet (Startordner: {start_dir})."
        )
        dialog = Gtk.FileChooserDialog(
            title="Album-Verzeichnis auswählen & CD-TOC generieren — MintRip Studio",
            transient_for=self,
            action=Gtk.FileChooserAction.SELECT_FOLDER,
        )
        dialog.add_buttons(
            "Abbrechen",
            Gtk.ResponseType.CANCEL,
            "Album-Ordner importieren & TOC berechnen",
            Gtk.ResponseType.OK,
        )
        if start_dir.exists():
            dialog.set_current_folder(str(start_dir))

        extra_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        extra_box.set_border_width(8)
        replace_check = Gtk.CheckButton(label="Vorhandene Trackliste durch gewähltes Album-Verzeichnis ersetzen")
        replace_check.set_active(True)
        extra_box.pack_start(replace_check, False, False, 0)

        auto_lookup_check = Gtk.CheckButton(
            label="Nach Ordner-Import direkt Online-Abfrage starten (MusicBrainz → Discogs → CDDB)"
        )
        auto_lookup_check.set_active(True)
        extra_box.pack_start(auto_lookup_check, False, False, 0)
        extra_box.show_all()
        dialog.set_extra_widget(extra_box)

        response = dialog.run()
        chosen_folder = dialog.get_filename() if response == Gtk.ResponseType.OK else None
        replace_existing = replace_check.get_active()
        auto_lookup = auto_lookup_check.get_active()
        dialog.destroy()

        if not chosen_folder:
            self._append_query_log_ui("[Ordner-Import] Verzeichnisauswahl abgebrochen.")
            return

        folder_path = Path(chosen_folder)
        self.settings.last_cover_dir = folder_path if folder_path.exists() else folder_path.parent
        saved_dir = self._remember_import_dir(folder_path, is_dir=True)
        self._append_query_log_ui(
            f"[Ordner-Import] Letztes Import-Verzeichnis gespeichert: {saved_dir}"
        )
        self._import_audio_paths_with_toc(
            [folder_path],
            append=not replace_existing,
            auto_online_lookup=auto_lookup,
        )

    def _populate_candidate_hits_ui(self, candidates: list[dict]) -> bool:
        src_track_count = len(self.album.tracks)
        self._candidate_hits = [
            c
            for c in candidates
            if matches_source_track_count_rule(
                int(c.get("track_count") or 0),
                int(c.get("medium_count") or 1),
                src_track_count,
            )
        ]
        self.hits_store.clear()
        self._last_preview_key = ""
        if not self._candidate_hits:
            self._preview_request_gen += 1
            self._set_preview_overlays_ui(left=False, right=False)
            self._awaiting_album_selection = False
            self._active_display = "hits"
            self.hits_frame.set_label("Gefundene Alben — Trefferliste (0 Treffer)")
            self.hits_status_label.set_text(
                "Keine passenden Alben gefunden. Suchbegriff oben anpassen oder CD einlesen."
            )
            self._update_workspace_visibility_and_locks()
            return False

        for idx, cand in enumerate(self._candidate_hits):
            src_raw = str(cand.get("source") or "musicbrainz").lower()
            src_label = (
                "Discogs"
                if src_raw == "discogs"
                else "CDDB / GnuDB"
                if src_raw == "cddb"
                else "MusicBrainz"
            )
            method_str = str(cand.get("method") or "Suche")
            title_esc = GLib.markup_escape_text(str(cand.get("title") or "Unbekannt"))
            artist_esc = GLib.markup_escape_text(str(cand.get("artist") or "Unbekannt"))
            cand_genres = [str(g).strip() for g in (cand.get("genres") or []) if str(g).strip()]
            cand_badges = [str(b).strip() for b in (cand.get("quality_badges") or []) if str(b).strip()]
            meta_line_parts: list[str] = []
            if cand_genres:
                meta_line_parts.append("Genres: " + ", ".join(cand_genres[:3]))
            if cand_badges:
                meta_line_parts.append(" · ".join(cand_badges[:4]))
            if meta_line_parts:
                meta_esc = GLib.markup_escape_text("  |  ".join(meta_line_parts))
                title_artist_markup = (
                    f"<b>{title_esc}</b>\n"
                    f"<span size='small'>{artist_esc}</span>\n"
                    f"<span size='x-small' alpha='72%'>{meta_esc}</span>"
                )
            else:
                title_artist_markup = f"<b>{title_esc}</b>\n<span size='small'>{artist_esc}</span>"

            date_str = str(cand.get("date") or "").strip()
            country_str = str(cand.get("country") or "").strip()
            year_country = " · ".join(p for p in (date_str, country_str) if p) or "—"

            label_str = str(cand.get("label") or "").strip()
            catno_str = str(cand.get("catno") or cand.get("barcode") or "").strip()
            label_catno = " · ".join(p for p in (label_str, catno_str) if p) or "—"

            med_cnt = int(cand.get("medium_count") or 1)
            disc_no = int(cand.get("matched_disc_number") or 1)
            trk_cnt = int(cand.get("track_count") or 0)
            scope_parts: list[str] = []
            if med_cnt > 1:
                scope_parts.append(f"{med_cnt} CDs (CD {disc_no})")
            if trk_cnt > 0:
                scope_parts.append(f"{trk_cnt} Titel")
            scope_str = " · ".join(scope_parts) or "CD-Release"

            score_val = int(cand.get("score") or 0)
            q_score = int(cand.get("quality_score") or 0)
            if score_val > 0 and q_score > 0:
                score_str = f"{score_val}% · Q{q_score}"
            elif score_val > 0:
                score_str = f"{score_val}%"
            else:
                score_str = "—"

            self.hits_store.append(
                [
                    idx,
                    src_label,
                    method_str,
                    title_artist_markup,
                    year_country,
                    label_catno,
                    scope_str,
                    score_str,
                ]
            )

        self.hits_frame.set_label(
            f"Gefundene Alben — Trefferliste ({len(self._candidate_hits)} Treffer · Bitte korrektes Album auswählen)"
        )
        self.hits_status_label.set_text(
            f"{len(self._candidate_hits)} mögliche Alben gefunden. Markieren Sie das korrekte Album und klicken Sie rechts unten auf „Ausgewähltes Album laden“ (oder Doppelklick):"
        )
        # 2.1: Display 1 (Albenliste) exklusiv geöffnet, Display 2 & Display 3 automatisch geschlossen
        self._awaiting_album_selection = True
        self._active_display = "hits"
        first_iter = self.hits_store.get_iter_first()
        if first_iter is not None:
            self.hits_treeview.get_selection().select_iter(first_iter)
        self._update_workspace_visibility_and_locks()
        return False

    def _on_hit_selection_changed(self, _selection: Gtk.TreeSelection) -> None:
        if getattr(self, "_active_module", "") == "module_cover":
            return
        if self._active_display == "hits" and self._candidate_hits:
            self._request_selected_hit_preview()

    def _render_album_preview_tracks(
        self,
        cand: dict,
        tracks: list[dict],
        total_discs: int,
        album_artist: str,
        status_msg: str = "",
    ) -> None:
        if not hasattr(self, "album_preview_tracks_box"):
            return
        src = str(cand.get("source") or "musicbrainz").lower()
        src_label = "Discogs" if src == "discogs" else ("CDDB" if src == "cddb" else "MusicBrainz")
        date_str = str(cand.get("date") or "").strip()
        meta_top = f"{src_label} · {date_str}" if date_str else src_label
        if tracks:
            meta_top = f"{meta_top} · {len(tracks)} Titel"
        self.album_preview_source_lbl.set_text(meta_top)
        title_str = str(cand.get("title") or "Unbenanntes Album")
        self.album_preview_title_lbl.set_markup(f"<b>{GLib.markup_escape_text(title_str)}</b>")
        self.album_preview_title_lbl.set_tooltip_text(title_str)
        art_str = str(album_artist or cand.get("artist") or "Unbekannter Künstler")
        self.album_preview_artist_lbl.set_text(art_str)
        self.album_preview_artist_lbl.set_tooltip_text(art_str)

        for child in list(self.album_preview_tracks_box.get_children()):
            self.album_preview_tracks_box.remove(child)

        if status_msg:
            self.album_preview_status_lbl.set_text(status_msg)
            self.album_preview_status_lbl.show()
            return

        if not tracks:
            self.album_preview_status_lbl.set_text("Keine Tracks für dieses Album gemeldet.")
            self.album_preview_status_lbl.show()
            return

        self.album_preview_status_lbl.hide()
        prev_disc: Optional[int] = None
        total_count = len(tracks)
        for trk in tracks:
            d_num = max(1, int(trk.get("disc_number") or 1))
            if total_discs > 1 and d_num != prev_disc:
                d_sub = str(trk.get("disc_subtitle") or "").strip()
                d_lbl = Gtk.Label()
                d_txt = f"CD {d_num} — {d_sub}" if d_sub else f"CD {d_num}"
                d_lbl.set_markup(f"<span size='small' weight='bold'>{GLib.markup_escape_text(d_txt)}</span>")
                d_lbl.set_xalign(0)
                d_lbl.set_margin_top(4)
                self.album_preview_tracks_box.pack_start(d_lbl, False, False, 0)
            prev_disc = d_num

            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            t_num = int(trk.get("track_number") or 0)
            num_lbl = Gtk.Label(label=format_index_number(t_num, total_count))
            num_lbl.set_xalign(1.0)
            num_lbl.set_width_chars(3)
            num_lbl.get_style_context().add_class("dim-label")
            row.pack_start(num_lbl, False, False, 0)

            mid_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
            t_title = str(trk.get("title") or f"Titel {t_num}")
            title_lbl = Gtk.Label(label=t_title)
            title_lbl.set_xalign(0)
            title_lbl.set_width_chars(8)
            title_lbl.set_max_width_chars(20)
            title_lbl.set_ellipsize(Pango.EllipsizeMode.END)
            title_lbl.set_tooltip_text(t_title)
            mid_box.pack_start(title_lbl, False, False, 0)

            t_art = str(trk.get("artist") or "").strip()
            if t_art and t_art.lower() != art_str.strip().lower():
                t_art_lbl = Gtk.Label()
                t_art_lbl.set_markup(f"<span size='small'>{GLib.markup_escape_text(t_art)}</span>")
                t_art_lbl.set_xalign(0)
                t_art_lbl.set_width_chars(8)
                t_art_lbl.set_max_width_chars(20)
                t_art_lbl.set_ellipsize(Pango.EllipsizeMode.END)
                t_art_lbl.get_style_context().add_class("dim-label")
                mid_box.pack_start(t_art_lbl, False, False, 0)

            row.pack_start(mid_box, True, True, 0)

            dur_lbl = Gtk.Label(label=str(trk.get("duration_formatted") or "--:--"))
            dur_lbl.get_style_context().add_class("dim-label")
            row.pack_end(dur_lbl, False, False, 0)

            self.album_preview_tracks_box.pack_start(row, False, False, 0)
            self.album_preview_tracks_box.pack_start(
                Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0
            )
        self.album_preview_tracks_box.show_all()

    def _set_left_preview_cover_bytes(self, img_bytes: Optional[bytes]) -> None:
        if not hasattr(self, "left_preview_cover_img"):
            return
        if not img_bytes:
            self.left_preview_cover_img.set_from_icon_name("media-optical", Gtk.IconSize.DIALOG)
            return
        try:
            loader = GdkPixbuf.PixbufLoader()
            loader.write(img_bytes)
            loader.close()
            pb = loader.get_pixbuf()
            if pb is not None:
                scaled = pb.scale_simple(180, 180, GdkPixbuf.InterpType.BILINEAR)
                if scaled is not None:
                    self.left_preview_cover_img.set_from_pixbuf(scaled)
                    return
        except Exception:
            pass
        self.left_preview_cover_img.set_from_icon_name("media-optical", Gtk.IconSize.DIALOG)

    def _render_left_album_preview(
        self,
        cand: dict,
        preview_data: Optional[dict] = None,
        status_msg: str = "",
    ) -> None:
        if not hasattr(self, "left_album_preview_meta_box"):
            return
        data = preview_data or {}
        src_raw = str(cand.get("source") or "musicbrainz").strip().lower()
        src_label = (
            "Discogs"
            if src_raw == "discogs"
            else ("CDDB / GnuDB" if src_raw == "cddb" else "MusicBrainz")
        )
        title_str = str(data.get("title") or cand.get("title") or "Unbekanntes Album")
        artist_str = str(
            data.get("album_artist")
            or data.get("artist")
            or cand.get("artist")
            or "Unbekannter Künstler"
        )
        self.left_preview_title_lbl.set_markup(
            f"<b>{GLib.markup_escape_text(title_str)}</b>"
        )
        self.left_preview_artist_lbl.set_text(artist_str)

        badge_parts = [src_label]
        method = str(cand.get("lookup_method") or "").strip()
        if method:
            badge_parts.append(method)
        score = int(cand.get("score") or 0)
        if score > 0:
            badge_parts.append(f"{score}%")
        self.left_preview_badge_lbl.set_text(" · ".join(badge_parts))

        if status_msg:
            self.left_preview_status_lbl.set_text(status_msg)
            self.left_preview_status_lbl.set_no_show_all(False)
            self.left_preview_status_lbl.show()
        else:
            self.left_preview_status_lbl.set_text("")
            self.left_preview_status_lbl.hide()
            self.left_preview_status_lbl.set_no_show_all(True)

        p_date = str(data.get("date") or cand.get("date") or "").strip()
        p_orig = str(data.get("original_date") or "").strip()
        if p_orig == p_date:
            p_orig = ""
        p_genre = str(data.get("genre") or "").strip()
        p_country = str(data.get("country") or cand.get("country") or "").strip()
        p_label = str(data.get("label") or cand.get("label") or "").strip()
        p_catno = str(data.get("catalog_number") or cand.get("catalog_number") or "").strip()
        p_barcode = str(data.get("barcode") or cand.get("barcode") or "").strip()
        p_format = str(data.get("media_format") or cand.get("format_summary") or "").strip()
        p_discs = max(1, int(data.get("total_discs") or cand.get("medium_count") or 1))
        tracks_list = list(data.get("tracks") or [])
        p_tracks_cnt = len(tracks_list) if tracks_list else int(cand.get("track_count") or 0)
        umfang_str = (
            f"{p_discs} {'CD' if p_discs == 1 else 'CDs'} · {p_tracks_cnt} Titel"
            if p_tracks_cnt > 0
            else (f"{p_discs} CDs" if p_discs > 1 else "")
        )
        id_label = (
            "Discogs-ID"
            if src_raw == "discogs"
            else ("CDDB-ID" if src_raw == "cddb" else "MusicBrainz-ID")
        )
        detail_rows = [
            ("Jahr / Datum", p_date),
            ("Erstveröffentlichung", p_orig),
            ("Genre", p_genre),
            ("Land", p_country),
            ("Label", p_label),
            ("Katalognummer", p_catno),
            ("Barcode / EAN", p_barcode),
            ("Medium / Format", p_format),
            ("Umfang", umfang_str),
            ("Release-Typ", str(data.get("release_type") or "").strip()),
            ("Status", str(data.get("status") or "").strip()),
            ("Sprache / Schrift", str(data.get("language") or "").strip()),
            ("Hinweis", str(data.get("disambiguation") or "").strip()),
            ("Amazon ASIN", str(data.get("asin") or "").strip()),
            (id_label, str(data.get("source_id") or cand.get("id") or "").strip()),
        ]
        detail_rows = [(k, v) for (k, v) in detail_rows if v]

        for child in list(self.left_album_preview_meta_box.get_children()):
            self.left_album_preview_meta_box.remove(child)

        if not detail_rows:
            empty_lbl = Gtk.Label(label="Keine weiteren Details gemeldet.")
            empty_lbl.get_style_context().add_class("dim-label")
            self.left_album_preview_meta_box.pack_start(empty_lbl, False, False, 4)
        else:
            meta_grid = Gtk.Grid(column_spacing=10, row_spacing=5)
            for row_idx, (k_txt, v_txt) in enumerate(detail_rows):
                k_lbl = Gtk.Label(label=f"{k_txt}:")
                k_lbl.set_xalign(0)
                k_lbl.set_yalign(0)
                k_lbl.get_style_context().add_class("dim-label")
                v_lbl = Gtk.Label(label=v_txt)
                v_lbl.set_xalign(1.0)
                v_lbl.set_yalign(0)
                v_lbl.set_hexpand(True)
                v_lbl.set_line_wrap(True)
                v_lbl.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
                v_lbl.set_selectable(True)
                meta_grid.attach(k_lbl, 0, row_idx, 1, 1)
                meta_grid.attach(v_lbl, 1, row_idx, 1, 1)
            self.left_album_preview_meta_box.pack_start(meta_grid, False, False, 0)

        self.left_album_preview_meta_box.show_all()

    def _request_selected_hit_preview(self) -> None:
        if not hasattr(self, "hits_treeview") or not hasattr(self, "album_preview_tracks_box"):
            return
        selection = self.hits_treeview.get_selection()
        model, tree_iter = selection.get_selected()
        if tree_iter is None:
            return
        idx = int(model.get_value(tree_iter, 0))
        if idx < 0 or idx >= len(self._candidate_hits):
            return
        cand = self._candidate_hits[idx]
        preview_key = f"{str(cand.get('source') or 'musicbrainz').lower()}:{str(cand.get('id') or '')}"
        if preview_key == self._last_preview_key and self.album_preview_tracks_box.get_children():
            return
        self._preview_request_gen += 1
        req_gen = self._preview_request_gen
        self._last_preview_key = preview_key

        self._set_left_preview_cover_bytes(None)
        self._render_left_album_preview(
            cand,
            preview_data=None,
            status_msg="",
        )
        self._render_album_preview_tracks(
            cand,
            tracks=[],
            total_discs=1,
            album_artist=str(cand.get("artist") or ""),
            status_msg="",
        )
        self._set_preview_overlays_ui(
            left=True,
            right=True,
            left_title="Albumdetails werden abgefragt…",
            left_sub="Cover & Metadaten werden geladen",
            right_title="Trackliste wird abgefragt…",
            right_sub="Enthaltene Titel werden geladen",
        )
        preview_title_txt = " – ".join(
            p for p in (str(cand.get("artist") or "").strip(), str(cand.get("title") or "").strip()) if p
        )
        self._db_progress_start(
            "preview",
            f"Album-Vorschau wird geladen… ({preview_title_txt})" if preview_title_txt else "Album-Vorschau wird geladen…",
        )
        discogs_tok = self.settings.discogs_token

        def _load_cover_bg(c_url: str) -> None:
            img_data = fetch_preview_cover_thumbnail(c_url) if c_url else None

            def _apply_cover() -> bool:
                if req_gen != self._preview_request_gen:
                    return False
                if img_data:
                    self._set_left_preview_cover_bytes(img_data)
                self._set_preview_overlays_ui(left=False)
                self._db_progress_finish(
                    "preview",
                    f"Album-Vorschau geladen: {preview_title_txt}" if preview_title_txt else "Album-Vorschau geladen",
                )
                return False

            GLib.idle_add(_apply_cover)

        def worker() -> None:
            err_msg = ""
            data: Optional[dict] = None
            try:
                data = fetch_candidate_tracklist_preview(cand, discogs_token=discogs_tok)
            except Exception as exc:
                err_msg = f"Trackliste konnte nicht geladen werden: {exc}"

            def _apply_on_main() -> bool:
                if req_gen != self._preview_request_gen:
                    return False
                if err_msg or data is None:
                    self._set_preview_overlays_ui(left=False, right=False)
                    self._db_progress_finish("preview", "Album-Vorschau nicht verfügbar")
                    self._render_left_album_preview(
                        cand,
                        preview_data=None,
                        status_msg="",
                    )
                    self._render_album_preview_tracks(
                        cand,
                        tracks=[],
                        total_discs=1,
                        album_artist=str(cand.get("artist") or ""),
                        status_msg=err_msg or "Trackliste nicht verfügbar.",
                    )
                else:
                    self._set_preview_overlays_ui(right=False)
                    self._render_left_album_preview(
                        cand,
                        preview_data=data,
                        status_msg="",
                    )
                    self._render_album_preview_tracks(
                        cand,
                        tracks=list(data.get("tracks") or []),
                        total_discs=max(1, int(data.get("total_discs") or 1)),
                        album_artist=str(data.get("artist") or cand.get("artist") or ""),
                        status_msg="",
                    )
                    c_url = str(data.get("cover_url") or "").strip()
                    if c_url:
                        self._set_preview_overlays_ui(
                            left=True,
                            left_title="Cover-Vorschau wird geladen…",
                            left_sub="Bilddaten werden abgerufen",
                        )
                        threading.Thread(target=_load_cover_bg, args=(c_url,), daemon=True).start()
                    else:
                        self._set_preview_overlays_ui(left=False)
                        self._db_progress_finish(
                            "preview",
                            f"Album-Vorschau geladen: {preview_title_txt}" if preview_title_txt else "Album-Vorschau geladen",
                        )
                return False

            GLib.idle_add(_apply_on_main)

        threading.Thread(target=worker, daemon=True).start()

    def _on_hit_row_activated(
        self,
        _treeview: Gtk.TreeView,
        path: Gtk.TreePath,
        _column: Gtk.TreeViewColumn,
    ) -> None:
        tree_iter = self.hits_store.get_iter(path)
        if tree_iter is not None:
            idx = int(self.hits_store.get_value(tree_iter, 0))
            self._load_candidate_by_index(idx)

    def _on_load_selected_hit_clicked(self, _btn: Gtk.Button) -> None:
        selection = self.hits_treeview.get_selection()
        model, tree_iter = selection.get_selected()
        if tree_iter is None:
            self._append_query_log_ui("[Trefferliste] Bitte zuerst ein Album in der Trefferliste markieren.")
            return
        idx = int(model.get_value(tree_iter, 0))
        self._load_candidate_by_index(idx)

    def _load_candidate_by_index(self, idx: int) -> None:
        if self._hits_search_active:
            return
        if idx < 0 or idx >= len(self._candidate_hits):
            return
        cand = self._candidate_hits[idx]
        current_album = self.album
        cand_artist = str(cand.get("artist") or "").strip()
        cand_title = str(cand.get("title") or "").strip()
        src_upper = str(cand.get("source") or "musicbrainz").upper()
        subtitle_parts = [p for p in (cand_artist, cand_title) if p]
        overlay_sub = (
            f"{' – '.join(subtitle_parts)} ({src_upper})"
            if subtitle_parts
            else f"Metadaten, Titelliste & Cover werden abgerufen ({src_upper})"
        )
        self._set_hits_search_running_ui(
            True,
            title="Album & Titelliste werden geladen…",
            subtitle=overlay_sub,
        )
        self._set_preview_overlays_ui(
            left=True,
            right=True,
            left_title="Album wird geladen…",
            left_sub="Metadaten & Cover werden übernommen",
            right_title="Album wird geladen…",
            right_sub="Titelliste wird übernommen",
        )
        self._append_query_log_ui(
            f"[Trefferliste] Lade ausgewähltes Album #{idx + 1}: „{cand.get('artist')} – {cand.get('title')}“ "
            f"({src_upper})..."
        )

        enabled_cov_providers = normalize_cover_providers(
            getattr(self.settings, "cover_providers", DEFAULT_COVER_PROVIDERS)
        )
        discogs_tok = self.settings.discogs_token

        def worker() -> None:
            resolved_album: Optional[AlbumMetadata] = None
            try:
                resolved_album = load_selected_candidate_metadata(
                    cand,
                    physical_album=current_album,
                    on_log=self._append_query_log_threadsafe,
                    enabled_cover_providers=enabled_cov_providers,
                    discogs_token=discogs_tok,
                )
            except Exception as exc:
                self._append_query_log_threadsafe(
                    f"[Fehler] Ausgewähltes Album konnte nicht geladen werden: {exc}"
                )

            def _finish_on_main() -> bool:
                if resolved_album is not None:
                    self._db_progress_finish(
                        "hits",
                        f"Album geladen: {resolved_album.artist} – {resolved_album.title} ({len(resolved_album.tracks)} Titel)",
                    )
                else:
                    self._db_progress_finish("hits", "Album konnte nicht geladen werden")
                self._set_hits_search_running_ui(False)
                self._set_preview_overlays_ui(left=False, right=False)
                if resolved_album is not None:
                    self._apply_resolved_album(resolved_album)
                return False

            GLib.idle_add(_finish_on_main)

        threading.Thread(target=worker, daemon=True).start()

    def _on_manual_search_clicked(self) -> None:
        self._sync_album_from_entries()
        q = self.search_entry.get_text().strip()
        if not q:
            parts = []
            if self.album.artist and self.album.artist != "Unbekannter Künstler":
                parts.append(self.album.artist)
            if self.album.title and not self.album.title.startswith(("Unbekannt", "Audio-CD", "Lokaler Datei-Import")):
                parts.append(self.album.title)
            q = " ".join(parts).strip()
        if getattr(self, "_active_module", "") == "module_cover":
            self._start_online_cover_search(custom_query=q)
            return

        if self.album.tracks:
            synthesize_toc_from_tracks(self.album)
            self._populate_album_ui()

        self._active_display = "hits"
        self._update_workspace_visibility_and_locks()
        self._set_hits_search_running_ui(
            True,
            title="Onlinedatenbanken werden abgefragt…",
            subtitle="MusicBrainz · Discogs · CDDB / GnuDB",
        )

        current_album = self.album
        token = self.settings.discogs_token
        self._append_query_log_ui(
            f"[Datenbank-Suche] Frage MusicBrainz, CDDB/GnuDB und Discogs ab ({q or 'TOC-Abfrage'})..."
        )

        def worker() -> None:
            cands: Optional[list[dict]] = None
            try:
                cands = search_all_databases_candidates(
                    current_album,
                    query=q,
                    discogs_token=token,
                    on_log=self._append_query_log_threadsafe,
                )
            except Exception as exc:
                self._append_query_log_threadsafe(f"[Datenbank-Suche] Fehler: {exc}")

            def _finish_search() -> bool:
                if cands is not None:
                    self._db_progress_finish(
                        "hits",
                        f"Datenbanksuche abgeschlossen: {len(cands)} Album-Treffer gefunden",
                    )
                else:
                    self._db_progress_finish("hits", "Datenbanksuche fehlgeschlagen")
                self._set_hits_search_running_ui(False)
                if cands is not None:
                    self._populate_candidate_hits_ui(cands)
                return False

            GLib.idle_add(_finish_search)

        threading.Thread(target=worker, daemon=True).start()

    def _on_enrich_track_genres_clicked(self) -> None:
        """Reichert fehlende oder zu allgemeine Track-Genres aus Release-Group, Discogs Styles & Last.fm an."""
        self._sync_album_from_entries()
        if not self.album.tracks:
            self._append_query_log_ui(
                "[Track-Genre-Enrichment] Keine Tracks geladen — bitte zuerst ein Album einlesen oder importieren."
            )
            return

        if hasattr(self, "enrich_genres_btn"):
            self.enrich_genres_btn.set_sensitive(False)
            self.enrich_genres_btn.set_label("Genres werden angereichert…")

        current_album = self.album
        discogs_token = self.settings.discogs_token
        lastfm_api_key = str(getattr(self.settings, "lastfm_api_key", "") or "")
        prefer_subgenres = bool(getattr(self.settings, "prefer_subgenres", True))
        self._db_progress_start(
            "enrich",
            f"Track-Genres werden angereichert ({len(current_album.tracks)} Tracks · MusicBrainz · Discogs · Last.fm)…",
        )
        self._append_query_log_ui(
            f"[Track-Genre-Enrichment] Starte Multi-Source-Genre-Abfrage für „{current_album.artist} – {current_album.title}“ ({len(current_album.tracks)} Tracks)..."
        )

        def worker() -> None:
            summary: dict = {}
            try:
                summary = enrich_album_track_genres(
                    current_album,
                    discogs_token=discogs_token,
                    lastfm_api_key=lastfm_api_key,
                    prefer_subgenres=prefer_subgenres,
                    on_log=self._append_query_log_threadsafe,
                )
            except Exception as exc:
                self._append_query_log_threadsafe(f"[Track-Genre-Enrichment] Fehler: {exc}")

            def _finish() -> bool:
                if hasattr(self, "enrich_genres_btn"):
                    self.enrich_genres_btn.set_sensitive(True)
                    self.enrich_genres_btn.set_label("Track-Genres anreichern")
                self._populate_album_ui()
                updated_cnt = int(summary.get("updated_tracks", 0) or 0)
                srcs = ", ".join(summary.get("sources") or []) or "keine neuen Quellen"
                self._db_progress_finish(
                    "enrich",
                    f"Track-Genres abgeschlossen: {updated_cnt} Titel aktualisiert ({srcs})",
                )
                self._append_query_log_ui(
                    f"[Track-Genre-Enrichment] Fertig: {updated_cnt} Track-Genres aktualisiert ({srcs})."
                )
                return False

            GLib.idle_add(_finish)

        threading.Thread(target=worker, daemon=True).start()

    def _on_retry_metadata_query_clicked(self, _btn: Gtk.Button) -> None:
        """Initialisiert die Metadaten-Abfrage über alle Datenbanken mit exponentiellem Backoff neu und zeigt die Trefferliste."""
        self._sync_album_from_entries()
        if self.album.tracks:
            synthesize_toc_from_tracks(self.album)
            self._populate_album_ui()

        self._active_display = "hits"
        self._update_workspace_visibility_and_locks()
        self._set_hits_search_running_ui(
            True,
            title="Onlinedatenbanken werden abgefragt…",
            subtitle="MusicBrainz · Discogs · CDDB / GnuDB",
        )

        current_album = self.album
        q = self.search_entry.get_text().strip()
        token = self.settings.discogs_token
        self._append_query_log_ui(
            f"[Neu-Initialisierung] Wiederhole Datenbank-Abfrage mit exponentiellem Backoff für „{current_album.artist} – {current_album.title}“ "
            f"({len(current_album.tracks)} Tracks · CDDB {current_album.cddb_id or '-'} · MB-DiscID {current_album.musicbrainz_disc_id or '-'})..."
        )

        def worker() -> None:
            max_attempts = 4
            cands: Optional[list[dict]] = None
            for attempt in range(1, max_attempts + 1):
                if attempt > 1:
                    GLib.idle_add(
                        self._set_hits_search_running_ui,
                        True,
                        f"Onlinedatenbanken werden abgefragt (Versuch {attempt}/{max_attempts})…",
                        "MusicBrainz · Discogs · CDDB / GnuDB",
                    )
                try:
                    cands = search_all_databases_candidates(
                        current_album,
                        query=q,
                        discogs_token=token,
                        on_log=self._append_query_log_threadsafe,
                    )
                    break
                except Exception as exc:
                    if attempt < max_attempts:
                        delay = 1.5 * (2 ** (attempt - 1))
                        self._append_query_log_threadsafe(
                            f"[Backoff-Retry {attempt}/{max_attempts}] Fehler ({exc}) – warte {delay:.1f}s vor erneutem Versuch..."
                        )
                        threading.Event().wait(delay)
                    else:
                        self._append_query_log_threadsafe(
                            f"[Fehler] Wiederholungsversuch nach {max_attempts} Anläufen fehlgeschlagen: {exc}"
                        )

            def _finish_retry() -> bool:
                if cands is not None:
                    self._db_progress_finish(
                        "hits",
                        f"Datenbankabfrage abgeschlossen: {len(cands)} Album-Treffer gefunden",
                    )
                else:
                    self._db_progress_finish("hits", "Datenbankabfrage fehlgeschlagen")
                self._set_hits_search_running_ui(False)
                if cands is not None:
                    self._populate_candidate_hits_ui(cands)
                return False

            GLib.idle_add(_finish_retry)

        threading.Thread(target=worker, daemon=True).start()

    def _import_audio_paths_with_toc(
        self,
        paths: list[Path],
        append: bool = False,
        auto_online_lookup: bool = True,
        show_overlay: bool = False,
    ) -> None:
        self._sync_album_from_entries()
        existing = self.album
        token = self.settings.discogs_token
        convert_roman = bool(getattr(self.settings, "convert_roman_numerals", True))

        if auto_online_lookup and show_overlay:
            self._active_display = "hits"
            self.hits_frame.set_label("Gefundene Alben — Suche läuft…")
            self.hits_status_label.set_text(
                "Album-Ordner wird analysiert und Online-Datenbanken werden abgefragt…"
            )
            self._set_hits_search_running_ui(
                True,
                title="Album-Ordner wird analysiert & Alben werden abgefragt…",
                subtitle="MusicBrainz · Discogs · CDDB / GnuDB",
            )
            self._update_workspace_visibility_and_locks()

        def worker() -> None:
            try:
                if len(paths) == 1 and paths[0].is_dir():
                    built = build_album_from_directory(paths[0], existing_album=existing, append=append)
                    folder_label = paths[0].name
                else:
                    built = build_album_from_local_files(paths, existing_album=existing, append=append)
                    folder_label = paths[0].parent.name if paths else "Auswahl"

                if convert_roman:
                    self._apply_roman_preference_to_album(built, enabled=True)

                is_tag_mod = getattr(self, "_active_module", "") == "module_tag"
                if is_tag_mod:
                    for t in built.tracks:
                        if t.source_file is not None and not getattr(t, "audio_health_status", ""):
                            t.audio_health_status = "scanning"
                            t.audio_health_color = "#94A3B8"
                            t.audio_health_tooltip = "Audiodatei wird im Hintergrund geprüft…"

                GLib.idle_add(self._set_album_and_refresh, built)
                if is_tag_mod and built.tracks:
                    GLib.idle_add(self._start_modul3_audio_health_scan, list(built.tracks))
                self._append_query_log_threadsafe(
                    f"[Ordner-Import] Album-Verzeichnis „{folder_label}“ geladen: {len(built.tracks)} Audiodatei(en) erkannt."
                )
                if built.cover_art_bytes and built.cover_art_source:
                    self._append_query_log_threadsafe(
                        f"[Cover-Erkennung] Vorhandenes Bild im Verzeichnis automatisch übernommen: {built.cover_art_source} ({len(built.cover_art_bytes) // 1024} KB)."
                    )
                self._append_query_log_threadsafe(
                    f"[TOC-Generator] Virtuelle CD-TOC berechnet: "
                    f"{len(built.tracks)} Tracks · CDDB-DiscID {built.cddb_id} · "
                    f"MB-DiscID {built.musicbrainz_disc_id} · TOC „{built.musicbrainz_toc}“"
                )
                if auto_online_lookup and built.tracks:
                    def _enter_phase_2_1() -> bool:
                        self._active_display = "hits"
                        if not self._hits_search_active:
                            self._set_hits_search_running_ui(
                                True,
                                title="Album-Ordner wird analysiert & Alben werden abgefragt…",
                                subtitle="MusicBrainz · Discogs · CDDB / GnuDB",
                            )
                        self._update_workspace_visibility_and_locks()
                        return False

                    GLib.idle_add(_enter_phase_2_1)
                    try:
                        cands = search_all_databases_candidates(
                            built,
                            discogs_token=token,
                            on_log=self._append_query_log_threadsafe,
                        )
                        GLib.idle_add(self._populate_candidate_hits_ui, cands)
                        GLib.idle_add(
                            self._db_progress_finish,
                            "hits",
                            f"Datenbankabfrage abgeschlossen: {len(cands)} Album-Treffer gefunden",
                        )
                    except Exception as exc:
                        GLib.idle_add(
                            self._db_progress_finish,
                            "hits",
                            "Datenbankabfrage fehlgeschlagen",
                        )
                        self._append_query_log_threadsafe(
                            f"[TOC-Abfrage] Online-Abfrage fehlgeschlagen ({exc}) – über 'Erneut versuchen' jederzeit wiederholbar."
                        )
            finally:
                if auto_online_lookup:
                    GLib.idle_add(self._set_hits_search_running_ui, False)

        threading.Thread(target=worker, daemon=True).start()

    def _start_modul3_audio_health_scan(self, tracks: list[TrackMetadata]) -> bool:
        """Prüft in Modul 3 importierte Audiodateien im Hintergrund (identischer Farbcode wie Modul 5, rein informativ)."""
        src_paths: list[Path] = []
        seen_paths: set[str] = set()
        for t in tracks:
            if t.source_file is not None and t.source_file.exists():
                sp = str(t.source_file)
                if sp not in seen_paths:
                    seen_paths.add(sp)
                    src_paths.append(t.source_file)
        if not src_paths:
            return False

        self._tag_health_scan_gen += 1
        scan_gen = self._tag_health_scan_gen
        cov_max_dim = normalize_cover_max_dimension(
            getattr(self.settings, "cover_max_dimension", DEFAULT_COVER_MAX_DIMENSION)
        )
        max_w = max(1, min(4, normalize_max_threads(getattr(self.settings, "max_threads", DEFAULT_MAX_THREADS))))

        def _apply_one_result(path_key: str, status: str, color_hex: str, tooltip: str) -> bool:
            if self._tag_health_scan_gen != scan_gen:
                return False
            for t in self.album.tracks:
                if t.source_file is not None and str(t.source_file) == path_key:
                    t.audio_health_status = status
                    t.audio_health_color = color_hex
                    t.audio_health_tooltip = tooltip
            w_tuple = self._track_health_widgets.get(path_key)
            if w_tuple is not None:
                h_ev, h_area, h_state = w_tuple
                h_state[0] = color_hex
                h_ev.set_tooltip_text(tooltip)
                h_area.queue_draw()
            return False

        def _scan_one(p: Path) -> tuple[str, str, str, str, bool]:
            pk = str(p)
            try:
                health, findings, struct = analyze_audio_file_for_repair(
                    p, deep_scan=True, cover_max_dimension=cov_max_dim
                )
                ff = struct.flac_firefox_compatible if struct else None
                has_crit = (
                    health in ("critical", "error")
                    or any(f.severity == "critical" for f in findings)
                    or ff == "incompatible"
                )
                has_warn = (
                    health == "warning"
                    or any(f.severity == "warning" for f in findings)
                    or ff == "warning"
                )
                has_info = any(f.severity == "info" for f in findings)
                top_titles = " · ".join(f.title for f in findings[:3] if f.title)
                if has_crit:
                    tip = (
                        f"Rot: Möglicherweise beschädigt ({len(findings)} Befund(e)"
                        f"{': ' + top_titles if top_titles else ''}) — bitte in Modul 5 prüfen & reparieren."
                    )
                    return (pk, "critical", "#DC2626", tip, True)
                if has_warn:
                    tip = (
                        f"Orange: Warnung ({len(findings)} Befund(e)"
                        f"{': ' + top_titles if top_titles else ''}) — bitte in Modul 5 prüfen & reparieren."
                    )
                    return (pk, "warning", "#F97316", tip, True)
                if has_info:
                    tip = (
                        f"Gelb: Hinweis ({len(findings)} Hinweis(e)"
                        f"{': ' + top_titles if top_titles else ''}) — optional in Modul 5 prüfen."
                    )
                    return (pk, "info", "#EAB308", tip, False)
                return (
                    pk,
                    "ok",
                    "#22C55E",
                    "Grün: OK — Audiodatei unauffällig (keine Struktur- oder Dekodierfehler).",
                    False,
                )
            except Exception:
                return (
                    pk,
                    "warning",
                    "#F97316",
                    "Orange: Prüfung beim Import nicht vollständig möglich — bitte in Modul 5 prüfen.",
                    True,
                )

        def _runner() -> None:
            flagged = 0
            with ThreadPoolExecutor(max_workers=max_w) as pool:
                futures = [pool.submit(_scan_one, p) for p in src_paths]
                for fut in futures:
                    if self._tag_health_scan_gen != scan_gen:
                        return
                    pk, st, col, tip, is_flag = fut.result()
                    if is_flag:
                        flagged += 1
                    GLib.idle_add(_apply_one_result, pk, st, col, tip)
            if self._tag_health_scan_gen == scan_gen:
                if flagged > 0:
                    self._append_query_log_threadsafe(
                        f"[Audio-Prüfung Modul 3] Hinweis: {flagged} von {len(src_paths)} Datei(en) zeigen Auffälligkeiten (Farbcode wie Modul 5) — bitte in Modul 5 prüfen & reparieren."
                    )
                else:
                    self._append_query_log_threadsafe(
                        f"[Audio-Prüfung Modul 3] Alle {len(src_paths)} importierte(n) Audiodatei(en) geprüft (keine kritischen Fehler/Warnungen)."
                    )

        threading.Thread(target=_runner, daemon=True).start()
        return False

    def _on_read_cd_clicked(self, _btn: Gtk.Button) -> None:
        if self._hits_search_active:
            return
        self._sync_album_from_entries()
        device_path = self._get_selected_drive()
        current_album = self.album
        token = self.settings.discogs_token
        convert_roman = bool(getattr(self.settings, "convert_roman_numerals", True))

        # Albenliste sofort leeren und Overlay mit langsam rotierendem Kreis einblenden
        self._candidate_hits.clear()
        self.hits_store.clear()
        self._awaiting_album_selection = False
        self.hits_frame.set_label("Gefundene Alben — Suche läuft…")
        self.hits_status_label.set_text(
            "CD wird eingelesen und Online-Datenbanken werden abgefragt…"
        )
        self.load_hit_btn.set_sensitive(False)
        self._active_display = "hits"
        self._set_hits_search_running_ui(
            True,
            title="CD wird eingelesen & Alben werden abgefragt…",
            subtitle="MusicBrainz · Discogs · CDDB / GnuDB",
        )
        self._update_workspace_visibility_and_locks()
        self._append_query_log_ui(
            f"[CD-Leser] Starte CD-TOC-Auslesung auf {device_path} & Datenbank-Abfrage (Trefferliste geleert)..."
        )

        def worker() -> None:
            try:
                try:
                    album = read_audio_cd_toc(device_path)
                    if convert_roman:
                        self._apply_roman_preference_to_album(album, enabled=True)
                    GLib.idle_add(self._set_album_and_refresh, album)
                    self._append_query_log_threadsafe(
                        f"[CD-Leser] CD-TOC gelesen ({album.metadata_source}): {len(album.tracks)} Audio-Titel, "
                        f"CDDB-ID {album.cddb_id}, MB-DiscID {album.musicbrainz_disc_id or '-'}"
                    )
                    cands = search_all_databases_candidates(
                        album,
                        discogs_token=token,
                        on_log=self._append_query_log_threadsafe,
                    )
                    GLib.idle_add(self._populate_candidate_hits_ui, cands)
                    GLib.idle_add(
                        self._db_progress_finish,
                        "hits",
                        f"CD-Datenbankabfrage abgeschlossen: {len(cands)} Album-Treffer gefunden",
                    )
                except Exception as cd_exc:
                    if current_album.tracks:
                        synthesize_toc_from_tracks(current_album)
                        GLib.idle_add(self._set_album_and_refresh, current_album)
                        self._append_query_log_threadsafe(
                            f"[TOC-Generator] Kein physisches Medium in {device_path} – nutze virtuelle Datei-TOC "
                            f"({len(current_album.tracks)} Tracks, CDDB-ID {current_album.cddb_id}, "
                            f"MB-DiscID {current_album.musicbrainz_disc_id or '-'}) für Datenbank-Trefferliste..."
                        )
                    else:
                        self._append_query_log_threadsafe(
                            f"[CD-Leser] Kein Medium in {device_path} ({cd_exc}) – starte Suche in allen Datenbanken..."
                        )
                    try:
                        cands = search_all_databases_candidates(
                            current_album,
                            query=self.search_entry.get_text().strip(),
                            discogs_token=token,
                            on_log=self._append_query_log_threadsafe,
                        )
                        GLib.idle_add(self._populate_candidate_hits_ui, cands)
                        GLib.idle_add(
                            self._db_progress_finish,
                            "hits",
                            f"Datenbankabfrage abgeschlossen: {len(cands)} Album-Treffer gefunden",
                        )
                    except Exception as exc:
                        GLib.idle_add(
                            self._db_progress_finish,
                            "hits",
                            "Datenbankabfrage fehlgeschlagen",
                        )
                        self._append_query_log_threadsafe(f"[Fehler] Datenbank-Abfrage fehlgeschlagen: {exc}")
            finally:
                GLib.idle_add(self._set_hits_search_running_ui, False)

        threading.Thread(target=worker, daemon=True).start()

    def _apply_resolved_album(self, album: AlbumMetadata) -> bool:
        self._apply_roman_preference_to_album(album)
        self.album = album
        # 2.2: Display 2 (Titel- & Metadaten-Verwaltung) exklusiv öffnen; Display 1 & Display 3 schließen
        self._awaiting_album_selection = False
        self._album_loaded_in_tracks = bool(album.tracks)
        self._active_display = "tracks"
        self._populate_album_ui()
        self._update_workspace_visibility_and_locks()
        disc_info = (
            f" · CD {format_index_number(album.disc_number, album.total_discs)}/{format_index_number(album.total_discs, album.total_discs)}"
            if album.total_discs > 1
            else ""
        )
        if album.cover_art_bytes:
            msg = f"[Metadaten] Übernommen: {album.artist} – {album.title} ({album.metadata_source}{disc_info} · {album.cover_art_source})"
        elif album.metadata_source and not album.metadata_source.startswith("Lokal"):
            msg = f"[Metadaten] Erkannt über {album.metadata_source}{disc_info}: {album.artist} – {album.title} (kein Cover gefunden)"
        else:
            msg = f"[CD-Leser] TOC geladen (CDDB {album.cddb_id}) · Kein Online-Treffer"
        self._append_query_log_ui(msg)
        return False

    def _set_album_and_refresh(self, album: AlbumMetadata) -> bool:
        self.album = album
        self._album_loaded_in_tracks = bool(album.tracks)
        self._populate_album_ui()
        self._update_workspace_visibility_and_locks()
        return False

    def _run_barcode_or_qr_lookup(self, raw_code: str) -> None:
        clean_code = raw_code.strip()
        if not clean_code:
            return
        self._sync_album_from_entries()
        self.entry_barcode.set_text(clean_code)
        self.search_entry.set_text(clean_code)
        self.album.barcode = clean_code
        if getattr(self, "_active_module", "") == "module_cover":
            self._start_online_cover_search(custom_query=clean_code)
            return
        self._active_display = "hits"
        self._update_workspace_visibility_and_locks()
        self._set_hits_search_running_ui(
            True,
            title=f"Barcode/QR-Code wird abgefragt ({clean_code})…",
            subtitle="MusicBrainz · Discogs",
        )
        current_album = self.album
        token = self.settings.discogs_token
        self._append_query_log_ui(
            f"[Barcode/QR] Starte Datenbank-Abfrage für Code „{clean_code}“ (MusicBrainz + Discogs) – zeige Trefferliste..."
        )

        def worker() -> None:
            cands: Optional[list[dict]] = None
            try:
                cands = search_all_databases_candidates(
                    current_album,
                    query=clean_code,
                    discogs_token=token,
                    on_log=self._append_query_log_threadsafe,
                )
            except Exception as exc:
                self._append_query_log_threadsafe(f"[Barcode/QR] Fehler bei der Abfrage: {exc}")

            def _finish_barcode() -> bool:
                if cands is not None:
                    self._db_progress_finish(
                        "hits",
                        f"Barcode/QR-Abfrage abgeschlossen: {len(cands)} Treffer gefunden",
                    )
                else:
                    self._db_progress_finish("hits", "Barcode/QR-Abfrage fehlgeschlagen")
                self._set_hits_search_running_ui(False)
                if cands is not None:
                    self._populate_candidate_hits_ui(cands)
                return False

            GLib.idle_add(_finish_barcode)

        threading.Thread(target=worker, daemon=True).start()

    def _on_lookup_barcode_entry_activated(self, entry: Gtk.Entry) -> None:
        code = entry.get_text().strip()
        if code:
            self._run_barcode_or_qr_lookup(code)

    def _on_lookup_discogs_entry_activated(self, entry: Gtk.Entry) -> None:
        raw_dg = entry.get_text().strip()
        if not raw_dg:
            return
        query = f"discogs:{raw_dg}" if raw_dg.isdigit() else raw_dg
        self.search_entry.set_text(query)
        self._on_manual_search_clicked()

    def _on_scan_barcode_clicked(self, _btn: Gtk.Button) -> None:
        self._append_query_log_ui(
            "[Barcode/QR-Scanner] Dialog zum Einlesen eines Barcodes (EAN/UPC) oder QR-Codes per Webcam geöffnet."
        )
        dialog = Gtk.Dialog(
            title="Barcode / QR-Code mit Webcam einlesen — MintRip Studio",
            transient_for=self,
            flags=Gtk.DialogFlags.MODAL,
        )
        dialog.set_default_size(520, 310)
        dialog.add_buttons(
            "Abbrechen",
            Gtk.ResponseType.CANCEL,
            "Bilddatei dekodieren...",
            Gtk.ResponseType.HELP,
            "Webcam-Scanner starten",
            Gtk.ResponseType.APPLY,
            "Code abfragen",
            Gtk.ResponseType.OK,
        )

        content = dialog.get_content_area()
        content.set_spacing(10)
        content.set_border_width(14)

        intro_lbl = Gtk.Label(
            label=(
                "Halte die Rückseite der CD-Hülle (EAN-13 / UPC-A Barcode) oder einen QR-Code "
                "(MusicBrainz / Discogs / GTIN) vor die Webcam oder gib den Code direkt ein."
            )
        )
        intro_lbl.set_xalign(0)
        intro_lbl.set_line_wrap(True)
        content.pack_start(intro_lbl, False, False, 0)

        cam_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        cam_lbl = Gtk.Label(label="Video-Gerät (V4L2):")
        cam_lbl.set_xalign(0)
        cam_row.pack_start(cam_lbl, False, False, 0)

        cam_combo = Gtk.ComboBoxText()
        video_devs = sorted(str(p) for p in Path("/dev").glob("video*") if p.name[5:].isdigit())
        if not video_devs:
            video_devs = ["/dev/video0"]
        for dev in video_devs:
            cam_combo.append_text(dev)
        cam_combo.set_active(0)
        cam_row.pack_start(cam_combo, True, True, 0)
        content.pack_start(cam_row, False, False, 0)

        code_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        code_lbl = Gtk.Label(label="Barcode / QR-Inhalt:")
        code_lbl.set_xalign(0)
        code_row.pack_start(code_lbl, False, False, 0)

        code_entry = Gtk.Entry()
        code_entry.set_hexpand(True)
        code_entry.set_text(self.entry_barcode.get_text().strip())
        code_entry.set_placeholder_text("z. B. 5099969944926 oder 0724384960629 oder Release-URL")
        code_row.pack_start(code_entry, True, True, 0)
        content.pack_start(code_row, False, False, 0)

        hint_lbl = Gtk.Label()
        hint_lbl.set_markup(
            "<span size='small'>Unterstützt: <b>zbarcam</b> (Live-Webcam-Fenster) · <b>ffmpeg + zbarimg</b> (Einzelbild-Scan) · <b>Bilddatei</b></span>"
        )
        hint_lbl.set_xalign(0)
        hint_lbl.get_style_context().add_class("dim-label")
        content.pack_start(hint_lbl, False, False, 0)

        dialog.show_all()
        response = dialog.run()
        selected_cam = cam_combo.get_active_text() or "/dev/video0"
        typed_code = code_entry.get_text().strip()
        dialog.destroy()

        if response == Gtk.ResponseType.OK:
            if typed_code:
                self._run_barcode_or_qr_lookup(typed_code)
            else:
                self._append_query_log_ui("[Barcode/QR-Scanner] Kein Code eingegeben.")
            return

        if response == Gtk.ResponseType.HELP:
            file_dlg = Gtk.FileChooserDialog(
                title="Foto eines Barcodes oder QR-Codes auswählen",
                transient_for=self,
                action=Gtk.FileChooserAction.OPEN,
            )
            file_dlg.add_buttons(
                "Abbrechen",
                Gtk.ResponseType.CANCEL,
                "Code aus Bild lesen",
                Gtk.ResponseType.OK,
            )
            start_dir = self._resolve_import_start_dir()
            if start_dir.exists():
                file_dlg.set_current_folder(str(start_dir))
            chosen_img = file_dlg.get_filename() if file_dlg.run() == Gtk.ResponseType.OK else None
            file_dlg.destroy()
            if not chosen_img:
                self._append_query_log_ui("[Barcode/QR-Scanner] Bildauswahl abgebrochen.")
                return
            self._remember_import_dir(Path(chosen_img), is_dir=False)
            if not shutil.which("zbarimg"):
                self._append_query_log_ui(
                    "[Barcode/QR-Scanner] Werkzeug 'zbarimg' fehlt (sudo apt install zbar-tools)."
                )
                return
            self._append_query_log_ui(f"[Barcode/QR-Scanner] Analysiere Bilddatei „{Path(chosen_img).name}“...")
            try:
                proc = subprocess.run(
                    ["zbarimg", "--raw", "-q", chosen_img],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=15,
                    text=True,
                )
                lines = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]
                if lines:
                    found_code = lines[0]
                    self._append_query_log_ui(
                        f"[Barcode/QR-Scanner] Code in Bilddatei erkannt: „{found_code}“."
                    )
                    self._run_barcode_or_qr_lookup(found_code)
                else:
                    self._append_query_log_ui(
                        "[Barcode/QR-Scanner] Kein Barcode oder QR-Code in der Bilddatei gefunden."
                    )
            except Exception as exc:
                self._append_query_log_ui(f"[Barcode/QR-Scanner] Fehler beim Bild-Scan: {exc}")
            return

        if response != Gtk.ResponseType.APPLY:
            self._append_query_log_ui("[Barcode/QR-Scanner] Dialog geschlossen.")
            return

        # Live-Webcam-Scan über zbarcam (--raw --oneshot) oder ffmpeg + zbarimg
        self._append_query_log_ui(
            f"[Barcode/QR-Scanner] Starte Webcam-Erfassung auf {selected_cam} (Halte den Barcode/QR-Code vor die Kamera)..."
        )

        def webcam_worker() -> None:
            if shutil.which("zbarcam"):
                try:
                    proc = subprocess.run(
                        ["zbarcam", "--raw", "--oneshot", selected_cam],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=45,
                        text=True,
                    )
                    detected = (proc.stdout or "").strip().splitlines()
                    if detected and detected[0].strip():
                        code_val = detected[0].strip()
                        self._append_query_log_threadsafe(
                            f"[Barcode/QR-Scanner] Webcam hat Code erkannt: „{code_val}“."
                        )
                        GLib.idle_add(self._run_barcode_or_qr_lookup, code_val)
                        return
                except subprocess.TimeoutExpired:
                    self._append_query_log_threadsafe(
                        "[Barcode/QR-Scanner] Zeitüberschreitung beim Webcam-Scan (45s)."
                    )
                    return
                except Exception as exc:
                    self._append_query_log_threadsafe(
                        f"[Barcode/QR-Scanner] zbarcam-Hinweis: {exc} – versuche Einzelbild-Erfassung..."
                    )

            if shutil.which("ffmpeg") and shutil.which("zbarimg"):
                tmp_frame = Path(tempfile.mktemp(suffix=".jpg", prefix="mintrip_webcam_"))
                try:
                    cap = subprocess.run(
                        [
                            "ffmpeg",
                            "-y",
                            "-f",
                            "video4linux2",
                            "-i",
                            selected_cam,
                            "-frames:v",
                            "1",
                            str(tmp_frame),
                        ],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=12,
                    )
                    if cap.returncode == 0 and tmp_frame.exists():
                        dec = subprocess.run(
                            ["zbarimg", "--raw", "-q", str(tmp_frame)],
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            timeout=10,
                            text=True,
                        )
                        lines = [ln.strip() for ln in (dec.stdout or "").splitlines() if ln.strip()]
                        if lines:
                            code_val = lines[0]
                            self._append_query_log_threadsafe(
                                f"[Barcode/QR-Scanner] Code aus Webcam-Einzelbild erkannt: „{code_val}“."
                            )
                            GLib.idle_add(self._run_barcode_or_qr_lookup, code_val)
                            return
                        self._append_query_log_threadsafe(
                            "[Barcode/QR-Scanner] Kein Barcode/QR-Code im Kamerabild erkannt. Bitte näher an die Kamera halten."
                        )
                        return
                except Exception as exc:
                    self._append_query_log_threadsafe(f"[Barcode/QR-Scanner] Kamera-Fehler: {exc}")
                finally:
                    tmp_frame.unlink(missing_ok=True)

            self._append_query_log_threadsafe(
                "[Barcode/QR-Scanner] Für den Webcam-Scan unter Linux Mint bitte 'sudo apt install zbar-tools' installieren."
            )

        threading.Thread(target=webcam_worker, daemon=True).start()

    def _on_load_selected_disc_clicked(self, _btn: Gtk.Button) -> None:
        self._sync_album_from_entries()
        mbid = self.album.musicbrainz_release_id
        disc_num = self.album.disc_number
        if not mbid:
            return
        self._db_progress_start(
            "disc_load",
            f"Multi-CD: Trackliste für CD {disc_num} wird von MusicBrainz geladen…",
        )
        self._append_query_log_ui(f"[Multi-CD] Lade Trackliste für CD {disc_num} von MusicBrainz (MBID {mbid})...")
        current_album = self.album

        def worker() -> None:
            try:
                details = fetch_musicbrainz_release_details(mbid, disc_number=disc_num)
                details.cddb_id = current_album.cddb_id or details.cddb_id
                details.track_offsets = current_album.track_offsets
                details.leadout_offset = current_album.leadout_offset
                if len(details.tracks) == len(current_album.tracks):
                    for idx, trk in enumerate(details.tracks):
                        trk.start_lsn = current_album.tracks[idx].start_lsn
                        trk.end_lsn = current_album.tracks[idx].end_lsn
                GLib.idle_add(self._apply_resolved_album, details)
                GLib.idle_add(
                    self._db_progress_finish,
                    "disc_load",
                    f"CD {disc_num} geladen ({len(details.tracks)} Titel)",
                )
            except Exception as exc:
                GLib.idle_add(
                    self._db_progress_finish,
                    "disc_load",
                    f"CD {disc_num} konnte nicht geladen werden",
                )
                self._append_query_log_threadsafe(f"[Multi-CD] CD-Abruf fehlgeschlagen: {exc}")

        threading.Thread(target=worker, daemon=True).start()

    def _on_draw_slow_spinner(self, widget: Gtk.DrawingArea, cr) -> bool:
        import math

        alloc = widget.get_allocation()
        w = max(1, alloc.width)
        h = max(1, alloc.height)
        cx = w * 0.5
        cy = h * 0.5
        radius = max(8.0, min(w, h) * 0.40)

        cr.set_line_width(4.0)
        # Dezenter Hintergrundring
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.25)
        cr.arc(cx, cy, radius, 0.0, 2.0 * math.pi)
        cr.stroke()

        # Langsam rotierendes Kreissegment (2.4 Sekunden pro Umdrehung)
        cr.set_source_rgba(0.06, 0.72, 0.50, 0.95)
        start_a = self._spinner_angle
        end_a = start_a + math.pi * 0.65
        cr.arc(cx, cy, radius, start_a, end_a)
        cr.stroke()
        return False

    def _tick_slow_spinner(self) -> bool:
        import math

        is_searching = self._cover_search_cancel_event is not None
        is_scanning = self._scanner_cancel_event is not None
        is_hits_searching = bool(getattr(self, "_hits_search_active", False))
        is_prev_left = bool(getattr(self, "_preview_left_loading", False))
        is_prev_right = bool(getattr(self, "_preview_right_loading", False))
        if not is_searching and not is_scanning and not is_hits_searching and not is_prev_left and not is_prev_right:
            self._spinner_timer_id = None
            return False
        # 2.4 Sekunden für eine volle Umdrehung (2*pi rad) bei 40ms Intervall
        self._spinner_angle = (self._spinner_angle + (2.0 * math.pi * 0.04 / 2.4)) % (2.0 * math.pi)
        if hasattr(self, "cover_search_spinner_area") and (is_searching or is_scanning):
            self.cover_search_spinner_area.queue_draw()
        if hasattr(self, "hits_search_spinner_area") and is_hits_searching:
            self.hits_search_spinner_area.queue_draw()
        if hasattr(self, "left_preview_spinner_area") and is_prev_left:
            self.left_preview_spinner_area.queue_draw()
        if hasattr(self, "right_preview_spinner_area") and is_prev_right:
            self.right_preview_spinner_area.queue_draw()
        return True

    def _any_slow_spinner_active(self) -> bool:
        return bool(
            self._cover_search_cancel_event is not None
            or self._scanner_cancel_event is not None
            or getattr(self, "_hits_search_active", False)
            or getattr(self, "_preview_left_loading", False)
            or getattr(self, "_preview_right_loading", False)
        )

    def _ensure_slow_spinner_running(self, active: bool) -> None:
        if active:
            if self._spinner_timer_id is None:
                self._spinner_timer_id = GLib.timeout_add(40, self._tick_slow_spinner)
        else:
            if self._spinner_timer_id is not None:
                GLib.source_remove(self._spinner_timer_id)
                self._spinner_timer_id = None

    def _set_preview_overlays_ui(
        self,
        left: Optional[bool] = None,
        right: Optional[bool] = None,
        left_title: Optional[str] = None,
        left_sub: Optional[str] = None,
        right_title: Optional[str] = None,
        right_sub: Optional[str] = None,
    ) -> bool:
        if left is not None:
            self._preview_left_loading = bool(left)
            if left_title and hasattr(self, "left_preview_overlay_title_label"):
                self.left_preview_overlay_title_label.set_markup(
                    f"<b>{GLib.markup_escape_text(left_title)}</b>"
                )
            if left_sub and hasattr(self, "left_preview_overlay_sub_label"):
                self.left_preview_overlay_sub_label.set_markup(
                    f"<span size='small'>{GLib.markup_escape_text(left_sub)}</span>"
                )
            if hasattr(self, "left_preview_loading_overlay_box"):
                self.left_preview_loading_overlay_box.set_no_show_all(not self._preview_left_loading)
                if self._preview_left_loading:
                    self.left_preview_loading_overlay_box.show_all()
                else:
                    self.left_preview_loading_overlay_box.hide()
        if right is not None:
            self._preview_right_loading = bool(right)
            if right_title and hasattr(self, "right_preview_overlay_title_label"):
                self.right_preview_overlay_title_label.set_markup(
                    f"<b>{GLib.markup_escape_text(right_title)}</b>"
                )
            if right_sub and hasattr(self, "right_preview_overlay_sub_label"):
                self.right_preview_overlay_sub_label.set_markup(
                    f"<span size='small'>{GLib.markup_escape_text(right_sub)}</span>"
                )
            if hasattr(self, "right_preview_loading_overlay_box"):
                self.right_preview_loading_overlay_box.set_no_show_all(not self._preview_right_loading)
                if self._preview_right_loading:
                    self.right_preview_loading_overlay_box.show_all()
                else:
                    self.right_preview_loading_overlay_box.hide()
        self._ensure_slow_spinner_running(self._any_slow_spinner_active())
        return False

    def _db_progress_stop_timers(self, pulse: bool = True, hide: bool = True) -> None:
        if pulse and getattr(self, "_db_progress_pulse_id", 0):
            try:
                GLib.source_remove(self._db_progress_pulse_id)
            except Exception:
                pass
            self._db_progress_pulse_id = 0
        if hide and getattr(self, "_db_progress_hide_id", 0):
            try:
                GLib.source_remove(self._db_progress_hide_id)
            except Exception:
                pass
            self._db_progress_hide_id = 0

    def _on_db_progress_pulse_tick(self) -> bool:
        if not self._db_progress_tasks or not hasattr(self, "db_progress_bar"):
            self._db_progress_pulse_id = 0
            return False
        self.db_progress_bar.pulse()
        self.db_progress_bar.queue_draw()
        return True

    def _on_db_progress_auto_hide(self) -> bool:
        self._db_progress_hide_id = 0
        if self._db_progress_tasks:
            return False
        self._db_progress_notice = None
        self._render_db_progress_bar()
        return False

    def _db_progress_start(
        self,
        key: str,
        label: str,
        total: int = 0,
        current: int = 0,
    ) -> bool:
        self._db_progress_seq += 1
        self._db_progress_notice = None
        self._db_progress_stop_timers(pulse=False, hide=True)
        self._db_progress_tasks[key] = {
            "label": label,
            "current": max(0, int(current)),
            "total": max(0, int(total)),
            "seq": self._db_progress_seq,
        }
        self._render_db_progress_bar()
        return False

    def _db_progress_update(
        self,
        key: str,
        current: int,
        total: int,
        label: Optional[str] = None,
    ) -> bool:
        entry = self._db_progress_tasks.get(key)
        if entry is None:
            return self._db_progress_start(key, label or "Datenbankabfrage läuft…", total=total, current=current)
        entry["current"] = max(0, int(current))
        entry["total"] = max(0, int(total))
        if label is not None:
            entry["label"] = label
        self._render_db_progress_bar()
        return False

    def _db_progress_finish(
        self,
        key: str,
        summary: str = "",
        cancelled: bool = False,
    ) -> bool:
        existed = self._db_progress_tasks.pop(key, None) is not None
        if not existed and not summary:
            return False
        if self._db_progress_tasks:
            self._render_db_progress_bar()
            return False
        if not existed:
            return False
        final_text = summary.strip() or (
            "Datenbankabfrage abgebrochen" if cancelled else "Datenbankabfrage abgeschlossen"
        )
        self._db_progress_notice = (final_text, bool(cancelled))
        self._render_db_progress_bar()
        self._db_progress_stop_timers(pulse=True, hide=True)
        delay_ms = 4000 if cancelled else 6000
        self._db_progress_hide_id = GLib.timeout_add(delay_ms, self._on_db_progress_auto_hide)
        return False

    def _db_progress_clear_all(self) -> bool:
        self._db_progress_tasks.clear()
        self._db_progress_notice = None
        self._db_progress_stop_timers(pulse=True, hide=True)
        self._render_db_progress_bar()
        return False

    def _render_db_progress_bar(self) -> None:
        if not hasattr(self, "db_query_progress_box"):
            return
        strip_ctx = self.db_query_progress_box.get_style_context()
        lbl_ctx = self.db_progress_label.get_style_context()
        glyph_ctx = self.db_progress_glyph.get_style_context()
        for cls in ("db-progress-active", "db-progress-done", "db-progress-cancelled"):
            strip_ctx.remove_class(cls)
        for cls in ("dim-label", "db-progress-status-active", "db-progress-status-done", "db-progress-status-cancelled"):
            lbl_ctx.remove_class(cls)
            glyph_ctx.remove_class(cls)

        self.db_query_progress_box.show()
        self.db_progress_label.show()
        self.db_progress_bar.show()
        self.db_progress_pct_label.show()

        if self._db_progress_tasks:
            tasks = list(self._db_progress_tasks.values())
            det_tasks = [t for t in tasks if t["total"] > 0]
            active = max(det_tasks if det_tasks else tasks, key=lambda t: t["seq"])
            extra_cnt = len(tasks) - 1
            extra_suffix = (
                f" (+{extra_cnt} weitere Abfrage)"
                if extra_cnt == 1
                else (f" (+{extra_cnt} weitere Abfragen)" if extra_cnt > 1 else "")
            )
            strip_ctx.add_class("db-progress-active")
            lbl_ctx.add_class("db-progress-status-active")
            self.db_progress_label.set_text(f"{active['label']}{extra_suffix}")
            self.db_progress_glyph.hide()
            self.db_progress_spinner.show()
            self.db_progress_spinner.start()

            if active["total"] > 0:
                self._db_progress_stop_timers(pulse=True, hide=False)
                raw_frac = max(0.0, min(1.0, active["current"] / float(active["total"])))
                # Auch bei Schritt 0/N einen minimalen grünen Startbalken zeigen
                vis_frac = max(0.05, raw_frac)
                self.db_progress_bar.set_fraction(vis_frac)
                pct = int(round(raw_frac * 100))
                self.db_progress_pct_label.set_text(
                    f"{active['current']}/{active['total']} · {pct} %"
                )
            else:
                self.db_progress_pct_label.set_text("Läuft…")
                if not self._db_progress_pulse_id:
                    self.db_progress_bar.pulse()
                    self._db_progress_pulse_id = GLib.timeout_add(
                        65, self._on_db_progress_pulse_tick
                    )
            self.db_progress_bar.queue_draw()
            return

        if self._db_progress_notice is not None:
            summary_txt, was_cancelled = self._db_progress_notice
            self._db_progress_stop_timers(pulse=True, hide=False)
            self.db_progress_spinner.stop()
            self.db_progress_spinner.hide()
            self.db_progress_glyph.set_text("■" if was_cancelled else "✓")
            self.db_progress_glyph.show()
            self.db_progress_label.set_text(summary_txt)
            if was_cancelled:
                strip_ctx.add_class("db-progress-cancelled")
                lbl_ctx.add_class("db-progress-status-cancelled")
                glyph_ctx.add_class("db-progress-status-cancelled")
                self.db_progress_pct_label.set_text("Abgebrochen")
            else:
                strip_ctx.add_class("db-progress-done")
                lbl_ctx.add_class("db-progress-status-done")
                glyph_ctx.add_class("db-progress-status-done")
                self.db_progress_bar.set_fraction(1.0)
                self.db_progress_pct_label.set_text("100 %")
            self.db_progress_bar.queue_draw()
            return

        # Ruhezustand: Leiste bleibt kompakt am unteren Fensterrand verankert
        self._db_progress_stop_timers(pulse=True, hide=False)
        self.db_progress_spinner.stop()
        self.db_progress_spinner.hide()
        self.db_progress_glyph.set_text("●")
        glyph_ctx.add_class("dim-label")
        lbl_ctx.add_class("dim-label")
        self.db_progress_glyph.show()
        self.db_progress_label.set_text("Bereit — keine aktive Datenbankabfrage")
        self.db_progress_bar.set_fraction(0.0)
        self.db_progress_pct_label.set_text("Bereit")
        self.db_progress_bar.queue_draw()

    def _set_hits_search_running_ui(
        self,
        running: bool,
        title: Optional[str] = None,
        subtitle: Optional[str] = None,
    ) -> bool:
        self._hits_search_active = bool(running)
        if self._hits_search_active:
            title_txt = title or "CD wird eingelesen & Alben werden abgefragt…"
            sub_txt = subtitle or "MusicBrainz · Discogs · CDDB / GnuDB"
            if hasattr(self, "hits_overlay_title_label"):
                self.hits_overlay_title_label.set_markup(f"<b>{GLib.markup_escape_text(title_txt)}</b>")
            if hasattr(self, "hits_overlay_sub_label"):
                self.hits_overlay_sub_label.set_markup(
                    f"<span size='small'>{GLib.markup_escape_text(sub_txt)}</span>"
                )
            self._db_progress_start("hits", f"{title_txt} ({sub_txt})")
        else:
            if "hits" in self._db_progress_tasks:
                self._db_progress_finish("hits", "Datenbankabfrage abgeschlossen")
        if hasattr(self, "hits_search_overlay_box"):
            self.hits_search_overlay_box.set_no_show_all(not self._hits_search_active)
            if self._hits_search_active:
                self.hits_search_overlay_box.show_all()
            else:
                self.hits_search_overlay_box.hide()
        if hasattr(self, "hits_treeview"):
            self.hits_treeview.set_sensitive(not self._hits_search_active)
        self._ensure_slow_spinner_running(self._any_slow_spinner_active())
        if hasattr(self, "scan_cd_btn"):
            locked = self._batch_running and not self._batch_paused
            self.scan_cd_btn.set_sensitive((not locked) and (not self._hits_search_active))
        if hasattr(self, "load_hit_btn"):
            locked = self._batch_running and not self._batch_paused
            self.load_hit_btn.set_sensitive(
                (not locked) and (not self._hits_search_active) and len(self._candidate_hits) > 0
            )
        return False

    def _set_cover_search_running_ui(self, running: bool, mode: str = "search") -> bool:
        is_scanning = self._scanner_cancel_event is not None
        is_any_active = running or (self._cover_search_cancel_event is not None) or is_scanning
        if hasattr(self, "overlay_title_label") and hasattr(self, "overlay_sub_label") and hasattr(self, "overlay_cancel_btn"):
            if mode == "scan" or is_scanning:
                dpi_val = getattr(self.settings, "scanner_dpi", 300)
                mode_val = getattr(self.settings, "scanner_color_mode", "Color")
                area_val = getattr(self.settings, "scanner_scan_area", "cd_booklet")
                area_txt = "125×125 mm Booklet" if area_val == "cd_booklet" else ("150×120 mm Inlay" if area_val == "cd_inlay" else "Vollfläche")
                self.overlay_title_label.set_markup("<b>Scanvorgang läuft…</b>")
                self.overlay_sub_label.set_markup(
                    f"<span size='small'>SANE Flachbettscanner · {dpi_val} DPI · {mode_val} · {area_txt}</span>"
                )
                self.overlay_cancel_btn.set_label("Scan abbrechen")
                self.overlay_cancel_btn.set_no_show_all(False)
            else:
                active_provs = normalize_cover_providers(
                    getattr(self.settings, "cover_providers", DEFAULT_COVER_PROVIDERS)
                )
                self.overlay_title_label.set_markup("<b>Cover-Suche läuft…</b>")
                self.overlay_sub_label.set_markup(
                    f"<span size='small'>{len(active_provs)} aktive Bilddatenbanken</span>"
                )
                self.overlay_cancel_btn.set_no_show_all(True)

        if hasattr(self, "cover_search_overlay_box"):
            self.cover_search_overlay_box.set_no_show_all(not is_any_active)
            if is_any_active:
                self.cover_search_overlay_box.show_all()
                if hasattr(self, "overlay_cancel_btn"):
                    if is_scanning or mode == "scan":
                        self.overlay_cancel_btn.show()
                    else:
                        self.overlay_cancel_btn.hide()
            else:
                self.cover_search_overlay_box.hide()

        self._ensure_slow_spinner_running(is_any_active or self._any_slow_spinner_active())

        search_running = self._cover_search_cancel_event is not None
        if hasattr(self, "cancel_cover_search_btn"):
            self.cancel_cover_search_btn.set_no_show_all(not search_running)
            if search_running:
                self.cancel_cover_search_btn.show_all()
            else:
                self.cancel_cover_search_btn.hide()
        if hasattr(self, "cover_results_refresh_btn"):
            self.cover_results_refresh_btn.set_sensitive(not search_running)
        if hasattr(self, "search_all_btn"):
            self.search_all_btn.set_sensitive(not search_running)
        return False

    def _on_cancel_cover_overlay_clicked(self) -> None:
        if self._scanner_cancel_event is not None:
            self._scanner_cancel_event.set()
            self._scanner_cancel_event = None
            if self._scanner_proc is not None:
                try:
                    self._scanner_proc.terminate()
                except Exception:
                    pass
                self._scanner_proc = None
            self._set_cover_search_running_ui(False)
            self._append_query_log_ui("[Scanner] Scanvorgang vom Benutzer abgebrochen.")
            return
        self._on_cancel_cover_search_clicked()

    def _on_cancel_cover_search_clicked(self) -> None:
        if self._cover_search_cancel_event is not None:
            self._cover_search_cancel_event.set()
            self._cover_search_cancel_event = None
        self._db_progress_finish("cover", "Cover-Suche abgebrochen", cancelled=True)
        self._set_cover_search_running_ui(False)
        self._append_query_log_ui(
            "[Cover-Suche] Online-Cover-Suche vom Benutzer abgebrochen."
        )

    def _start_online_cover_search(
        self, _preferred_source: str = "auto", custom_query: str = ""
    ) -> None:
        if self._cover_search_cancel_event is not None:
            self._cover_search_cancel_event.set()
        cancel_evt = threading.Event()
        self._cover_search_cancel_event = cancel_evt

        is_cover_only = getattr(self, "_active_module", "") == "module_cover"
        if is_cover_only:
            self.album.cover_art_bytes = None
            self.album.cover_art_mime = ""
            self.album.cover_art_source = ""
            self.album.cover_art_width = 0
            self.album.cover_art_height = 0
            self.album.cover_art_original_format = ""
            self._render_cover_preview()
            self._populate_inline_cover_candidates([])

        self._set_cover_search_running_ui(True)

        self._sync_album_from_entries()
        enabled_providers = normalize_cover_providers(
            getattr(self.settings, "cover_providers", DEFAULT_COVER_PROVIDERS)
        )
        if not enabled_providers:
            self._append_query_log_ui(
                "[Cover-Suche] Keine Cover-Bilddatenbank in den Einstellungen aktiviert."
            )
            if self._cover_search_cancel_event is cancel_evt:
                self._cover_search_cancel_event = None
            self._set_cover_search_running_ui(False)
            return

        provider_labels = [
            str(opt["label"])
            for opt in COVER_PROVIDER_OPTIONS
            if str(opt["id"]) in enabled_providers
        ]
        mbid = self.album.musicbrainz_release_id
        rgid = getattr(self.album, "musicbrainz_release_group_id", "")
        discogs_id = self.album.discogs_release_id
        asin = self.album.asin
        barcode = self.album.barcode
        artist = self.album.album_artist or self.album.artist
        title = self.album.title
        q = (custom_query or (self.search_entry.get_text() if is_cover_only else "") or "").strip()
        label_target = q or f"{artist} – {title}"
        self._db_progress_start(
            "cover",
            f"Cover-Suche läuft ({len(enabled_providers)} Bilddatenbanken) für „{label_target}“…",
        )
        self._append_query_log_ui(
            f"[Cover-Suche] Starte Vollabfrage über {len(enabled_providers)} aktivierte Quellen ({' · '.join(provider_labels)}) für „{label_target}“..."
        )

        def worker() -> None:
            found_count = 0
            try:
                candidates = search_all_cover_candidates(
                    artist=artist,
                    title=title,
                    release_mbid=mbid,
                    release_group_mbid=rgid,
                    discogs_id=discogs_id,
                    asin=asin,
                    barcode=barcode,
                    discogs_token=self.settings.discogs_token,
                    on_log=self._append_query_log_threadsafe,
                    query=q,
                    cancel_event=cancel_evt,
                    enabled_providers=enabled_providers,
                )
                if cancel_evt.is_set():
                    return
                found_count = len(candidates or [])
                if not candidates:
                    self._append_query_log_threadsafe(
                        "[Cover-Suche] Kein Cover bei den aktivierten Bilddatenbanken gefunden."
                    )
                    if is_cover_only:
                        GLib.idle_add(self._populate_inline_cover_candidates, [])
                    return
                if is_cover_only:
                    GLib.idle_add(self._populate_inline_cover_candidates, candidates)
                else:
                    GLib.idle_add(self._show_cover_candidates_dialog, candidates)
            finally:
                def _finish() -> bool:
                    if self._cover_search_cancel_event is cancel_evt:
                        self._cover_search_cancel_event = None
                        if cancel_evt.is_set():
                            self._db_progress_finish("cover", "Cover-Suche abgebrochen", cancelled=True)
                        elif found_count > 0:
                            self._db_progress_finish(
                                "cover",
                                f"Cover-Suche abgeschlossen: {found_count} Treffer gefunden",
                            )
                        else:
                            self._db_progress_finish(
                                "cover",
                                "Cover-Suche abgeschlossen: Keine Treffer gefunden",
                            )
                        self._set_cover_search_running_ui(False)
                    return False

                GLib.idle_add(_finish)

        threading.Thread(target=worker, daemon=True).start()

    def _show_large_cover_preview_dialog(
        self,
        parent_dialog: Gtk.Window,
        candidates: list[dict],
        start_index: int,
    ) -> None:
        if not candidates:
            return
        state = {"idx": max(0, min(start_index, len(candidates) - 1))}

        preview_dlg = Gtk.Dialog(
            title="Cover-Großansicht",
            transient_for=parent_dialog,
            flags=Gtk.DialogFlags.MODAL | Gtk.DialogFlags.DESTROY_WITH_PARENT,
        )
        preview_dlg.set_default_size(680, 720)
        preview_dlg.add_button("Zurück zur Übersicht", Gtk.ResponseType.CLOSE)
        apply_btn = preview_dlg.add_button("Dieses Cover übernehmen", Gtk.ResponseType.APPLY)
        apply_btn.get_style_context().add_class("suggested-action")

        content = preview_dlg.get_content_area()
        content.set_spacing(8)
        content.set_border_width(12)

        header_lbl = Gtk.Label()
        header_lbl.set_xalign(0)
        header_lbl.set_line_wrap(True)
        content.pack_start(header_lbl, False, False, 0)

        img_widget = Gtk.Image()
        img_scroll = Gtk.ScrolledWindow()
        img_scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        img_scroll.set_vexpand(True)
        img_scroll.add(img_widget)
        content.pack_start(img_scroll, True, True, 0)

        nav_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        prev_btn = Gtk.Button(label="◀ Vorheriges")
        next_btn = Gtk.Button(label="Nächstes ▶")
        meta_lbl = Gtk.Label()
        meta_lbl.set_hexpand(True)
        nav_box.pack_start(prev_btn, False, False, 0)
        nav_box.pack_start(meta_lbl, True, True, 0)
        nav_box.pack_end(next_btn, False, False, 0)
        content.pack_start(nav_box, False, False, 0)

        def render_current() -> None:
            cand = candidates[state["idx"]]
            raw_bytes = cand.get("image_bytes") or b""
            mime = cand.get("mime") or "image/jpeg"
            w, h, fmt = inspect_cover_image(raw_bytes, mime)
            try:
                loader = GdkPixbuf.PixbufLoader()
                loader.write(raw_bytes)
                loader.close()
                pixbuf = loader.get_pixbuf()
                if pixbuf is not None:
                    pw = pixbuf.get_width()
                    ph = pixbuf.get_height()
                    scale = min(580.0 / max(1, pw), 580.0 / max(1, ph), 1.0)
                    scaled = pixbuf.scale_simple(
                        max(1, int(round(pw * scale))),
                        max(1, int(round(ph * scale))),
                        GdkPixbuf.InterpType.BILINEAR,
                    )
                    if scaled is not None:
                        img_widget.set_from_pixbuf(scaled)
            except Exception:
                pass
            size_kb = max(1.0, len(raw_bytes) / 1024.0)
            header_lbl.set_markup(
                f"<b>{GLib.markup_escape_text(str(cand.get('provider_label') or ''))}</b> — "
                f"{GLib.markup_escape_text(str(cand.get('artist') or ''))} – "
                f"{GLib.markup_escape_text(str(cand.get('title') or ''))}"
            )
            meta_lbl.set_markup(
                f"<span size='small'>{w} × {h} px · {size_kb:.1f} KB · {fmt} · "
                f"Treffer {state['idx'] + 1} / {len(candidates)}</span>"
            )
            prev_btn.set_sensitive(len(candidates) > 1)
            next_btn.set_sensitive(len(candidates) > 1)

        def on_prev(_b: Gtk.Button) -> None:
            state["idx"] = (state["idx"] - 1) % len(candidates)
            render_current()

        def on_next(_b: Gtk.Button) -> None:
            state["idx"] = (state["idx"] + 1) % len(candidates)
            render_current()

        prev_btn.connect("clicked", on_prev)
        next_btn.connect("clicked", on_next)
        render_current()
        preview_dlg.show_all()
        resp = preview_dlg.run()
        chosen_idx = state["idx"]
        preview_dlg.destroy()

        if resp == Gtk.ResponseType.APPLY:
            self._apply_cover_candidate(candidates[chosen_idx])
            if isinstance(parent_dialog, Gtk.Dialog):
                parent_dialog.response(Gtk.ResponseType.OK)

    def _populate_inline_cover_candidates(self, candidates: list[dict]) -> bool:
        if not hasattr(self, "cover_results_grid"):
            return False
        for child in list(self.cover_results_grid.get_children()):
            self.cover_results_grid.remove(child)

        active_provs = normalize_cover_providers(
            getattr(self.settings, "cover_providers", DEFAULT_COVER_PROVIDERS)
        )
        active_names = [
            str(opt["label"])
            for opt in COVER_PROVIDER_OPTIONS
            if str(opt["id"]) in active_provs
        ]
        self.cover_results_title_label.set_markup(
            f"<b>Online-Cover-Auswahl — {len(candidates)} Treffer aus allen aktivierten Quellen</b>"
        )
        if hasattr(self, "cover_results_sub_label"):
            prov_summary = GLib.markup_escape_text(" · ".join(active_names) or "Keine Quelle aktiv")
            self.cover_results_sub_label.set_markup(
                f"<span size='small'>Abgefragte Quellen ({len(active_provs)}): {prov_summary} — Klick auf Vorschaubild öffnet Großansicht</span>"
            )

        headers = ("Vorschau", "Provider", "Album & Release-Details", "Auflösung & Größe", "Format", "Aktion")
        for col, h_text in enumerate(headers):
            h_lbl = Gtk.Label()
            h_lbl.set_xalign(0)
            h_lbl.set_markup(f"<b>{GLib.markup_escape_text(h_text)}</b>")
            self.cover_results_grid.attach(h_lbl, col, 0, 1, 1)

        if not candidates:
            empty_lbl = Gtk.Label(
                label="Noch keine Cover-Treffer geladen. Geben Sie oben in der Suchleiste Album, Künstler, Barcode oder Discogs-Code (z. B. [r524030]) ein oder klicken Sie links in der Cover-Toolbar auf die Lupe."
            )
            empty_lbl.set_xalign(0)
            empty_lbl.set_line_wrap(True)
            empty_lbl.get_style_context().add_class("dim-label")
            self.cover_results_grid.attach(empty_lbl, 0, 1, 6, 1)
            self.cover_results_grid.show_all()
            return False

        for row_idx, cand in enumerate(candidates, start=1):
            raw_bytes = cand.get("image_bytes") or b""
            mime = str(cand.get("mime") or "image/jpeg")
            w, h, fmt = inspect_cover_image(raw_bytes, mime)
            cand["width"] = w
            cand["height"] = h
            cand["format"] = fmt

            thumb_btn = Gtk.Button()
            thumb_btn.set_relief(Gtk.ReliefStyle.NONE)
            thumb_btn.set_tooltip_text("Klicken, um das Vorschaubild in groß anzuzeigen")
            thumb_img = Gtk.Image()
            try:
                loader = GdkPixbuf.PixbufLoader()
                loader.write(raw_bytes)
                loader.close()
                pb = loader.get_pixbuf()
                if pb is not None:
                    scaled = pb.scale_simple(64, 64, GdkPixbuf.InterpType.BILINEAR)
                    if scaled is not None:
                        thumb_img.set_from_pixbuf(scaled)
            except Exception:
                pass
            thumb_btn.add(thumb_img)
            thumb_btn.connect(
                "clicked",
                lambda _b, idx=row_idx - 1: self._show_large_cover_preview_dialog(self, candidates, idx),
            )
            self.cover_results_grid.attach(thumb_btn, 0, row_idx, 1, 1)

            prov_lbl = Gtk.Label()
            prov_lbl.set_xalign(0)
            prov_lbl.set_markup(f"<b>{GLib.markup_escape_text(str(cand.get('provider_label') or ''))}</b>")
            self.cover_results_grid.attach(prov_lbl, 1, row_idx, 1, 1)

            det_lbl = Gtk.Label()
            det_lbl.set_xalign(0)
            det_lbl.set_hexpand(True)
            det_lbl.set_line_wrap(True)
            title_esc = GLib.markup_escape_text(str(cand.get("title") or ""))
            artist_esc = GLib.markup_escape_text(str(cand.get("artist") or ""))
            date_esc = GLib.markup_escape_text(str(cand.get("date") or ""))
            extra_esc = GLib.markup_escape_text(str(cand.get("details") or ""))
            sub_line = f"{artist_esc}{' · ' + date_esc if date_esc else ''}"
            if extra_esc:
                sub_line += f"\n<span size='small'>{extra_esc}</span>"
            det_lbl.set_markup(f"<b>{title_esc}</b>\n{sub_line}")
            self.cover_results_grid.attach(det_lbl, 2, row_idx, 1, 1)

            size_kb = max(1.0, len(raw_bytes) / 1024.0)
            dim_lbl = Gtk.Label(label=f"{w} × {h} px\n{size_kb:.1f} KB")
            dim_lbl.set_xalign(0)
            self.cover_results_grid.attach(dim_lbl, 3, row_idx, 1, 1)

            fmt_lbl = Gtk.Label(label=fmt or "JPEG")
            fmt_lbl.set_xalign(0)
            self.cover_results_grid.attach(fmt_lbl, 4, row_idx, 1, 1)

            act_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            zoom_btn = Gtk.Button(label="Großansicht")
            zoom_btn.connect(
                "clicked",
                lambda _b, idx=row_idx - 1: self._show_large_cover_preview_dialog(self, candidates, idx),
            )
            use_btn = Gtk.Button(label="Übernehmen")
            use_btn.get_style_context().add_class("suggested-action")
            use_btn.connect(
                "clicked",
                lambda _b, chosen=cand: self._apply_cover_candidate(chosen),
            )
            act_box.pack_start(zoom_btn, False, False, 0)
            act_box.pack_start(use_btn, False, False, 0)
            self.cover_results_grid.attach(act_box, 5, row_idx, 1, 1)

        self.cover_results_grid.show_all()
        return False

    def _apply_cover_candidate(self, cand: dict) -> None:
        raw_bytes = cand.get("image_bytes") or b""
        mime = str(cand.get("mime") or "image/jpeg")
        source_label = str(cand.get("source_label") or "Online-Cover")
        if cand.get("mbid") and not self.album.musicbrainz_release_id:
            self.album.musicbrainz_release_id = str(cand["mbid"])
        if cand.get("discogs_id") and not self.album.discogs_release_id:
            self.album.discogs_release_id = str(cand["discogs_id"])
        if cand.get("asin") and not self.album.asin:
            self.album.asin = str(cand["asin"])
        w, h, fmt = self._apply_cover_bytes(raw_bytes, mime, source_label)
        self._append_query_log_ui(
            f"[Cover übernommen] {source_label}: {w}×{h} px · {len(raw_bytes) // 1024} KB · Format: {fmt}."
        )
        self._populate_album_ui()

    def _show_cover_candidates_dialog(self, candidates: list[dict]) -> bool:
        dlg = Gtk.Dialog(
            title=f"Online-Cover-Auswahl — {len(candidates)} Treffer aus allen Providern",
            transient_for=self,
            flags=Gtk.DialogFlags.MODAL | Gtk.DialogFlags.DESTROY_WITH_PARENT,
        )
        dlg.set_default_size(860, 560)
        dlg.add_button("Schließen", Gtk.ResponseType.CANCEL)

        content = dlg.get_content_area()
        content.set_spacing(8)
        content.set_border_width(12)

        active_provs = normalize_cover_providers(
            getattr(self.settings, "cover_providers", DEFAULT_COVER_PROVIDERS)
        )
        active_names = [
            str(opt["label"])
            for opt in COVER_PROVIDER_OPTIONS
            if str(opt["id"]) in active_provs
        ]
        prov_summary = GLib.markup_escape_text(" · ".join(active_names) or "Keine Quelle aktiv")
        info_lbl = Gtk.Label()
        info_lbl.set_xalign(0)
        info_lbl.set_line_wrap(True)
        info_lbl.set_markup(
            f"<b>Abgefragte Quellen ({len(active_provs)}):</b> {prov_summary} — "
            "<i>Klick auf ein Vorschaubild öffnet die Großansicht.</i>"
        )
        content.pack_start(info_lbl, False, False, 0)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        scroll.set_vexpand(True)

        grid = Gtk.Grid()
        grid.set_column_spacing(12)
        grid.set_row_spacing(8)
        grid.set_border_width(6)

        headers = ("Vorschau", "Provider", "Album & Release-Details", "Auflösung & Größe", "Format", "Aktion")
        for col, h_text in enumerate(headers):
            h_lbl = Gtk.Label()
            h_lbl.set_xalign(0)
            h_lbl.set_markup(f"<b>{GLib.markup_escape_text(h_text)}</b>")
            grid.attach(h_lbl, col, 0, 1, 1)

        for row_idx, cand in enumerate(candidates, start=1):
            raw_bytes = cand.get("image_bytes") or b""
            mime = str(cand.get("mime") or "image/jpeg")
            w, h, fmt = inspect_cover_image(raw_bytes, mime)
            cand["width"] = w
            cand["height"] = h
            cand["format"] = fmt

            # 1. Klickbares Vorschaubild (öffnet Großansicht)
            thumb_btn = Gtk.Button()
            thumb_btn.set_relief(Gtk.ReliefStyle.NONE)
            thumb_btn.set_tooltip_text("Klicken, um das Vorschaubild in groß anzuzeigen")
            thumb_img = Gtk.Image()
            try:
                loader = GdkPixbuf.PixbufLoader()
                loader.write(raw_bytes)
                loader.close()
                pb = loader.get_pixbuf()
                if pb is not None:
                    scaled = pb.scale_simple(64, 64, GdkPixbuf.InterpType.BILINEAR)
                    if scaled is not None:
                        thumb_img.set_from_pixbuf(scaled)
            except Exception:
                pass
            thumb_btn.add(thumb_img)
            thumb_btn.connect(
                "clicked",
                lambda _b, idx=row_idx - 1: self._show_large_cover_preview_dialog(dlg, candidates, idx),
            )
            grid.attach(thumb_btn, 0, row_idx, 1, 1)

            # 2. Provider
            prov_lbl = Gtk.Label()
            prov_lbl.set_xalign(0)
            prov_lbl.set_markup(f"<b>{GLib.markup_escape_text(str(cand.get('provider_label') or ''))}</b>")
            grid.attach(prov_lbl, 1, row_idx, 1, 1)

            # 3. Album & Details
            det_lbl = Gtk.Label()
            det_lbl.set_xalign(0)
            det_lbl.set_hexpand(True)
            det_lbl.set_line_wrap(True)
            title_esc = GLib.markup_escape_text(str(cand.get("title") or ""))
            artist_esc = GLib.markup_escape_text(str(cand.get("artist") or ""))
            date_esc = GLib.markup_escape_text(str(cand.get("date") or ""))
            extra_esc = GLib.markup_escape_text(str(cand.get("details") or ""))
            sub_line = f"{artist_esc}{' · ' + date_esc if date_esc else ''}"
            if extra_esc:
                sub_line += f"\n<span size='small'>{extra_esc}</span>"
            det_lbl.set_markup(f"<b>{title_esc}</b>\n{sub_line}")
            grid.attach(det_lbl, 2, row_idx, 1, 1)

            # 4. Auflösung & Dateigröße
            size_kb = max(1.0, len(raw_bytes) / 1024.0)
            dim_lbl = Gtk.Label(label=f"{w} × {h} px\n{size_kb:.1f} KB")
            dim_lbl.set_xalign(0)
            grid.attach(dim_lbl, 3, row_idx, 1, 1)

            # 5. Format
            fmt_lbl = Gtk.Label(label=fmt or "JPEG")
            fmt_lbl.set_xalign(0)
            grid.attach(fmt_lbl, 4, row_idx, 1, 1)

            # 6. Aktionen (Großansicht + Übernehmen)
            act_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            zoom_btn = Gtk.Button(label="Großansicht")
            zoom_btn.connect(
                "clicked",
                lambda _b, idx=row_idx - 1: self._show_large_cover_preview_dialog(dlg, candidates, idx),
            )
            use_btn = Gtk.Button(label="Übernehmen")
            use_btn.get_style_context().add_class("suggested-action")

            def _on_use_clicked(_b: Gtk.Button, chosen: dict = cand) -> None:
                self._apply_cover_candidate(chosen)
                dlg.response(Gtk.ResponseType.OK)

            use_btn.connect("clicked", _on_use_clicked)
            act_box.pack_start(zoom_btn, False, False, 0)
            act_box.pack_start(use_btn, False, False, 0)
            grid.attach(act_box, 5, row_idx, 1, 1)

        scroll.add(grid)
        content.pack_start(scroll, True, True, 0)

        dlg.show_all()
        dlg.run()
        dlg.destroy()
        return False

    def _on_choose_cover_file_clicked(self, _btn: Gtk.Button) -> None:
        start_dir = self.settings.last_cover_dir
        if not start_dir or not start_dir.exists():
            start_dir = self.settings.last_import_dir if self.settings.last_import_dir.exists() else Path.home()

        self._append_query_log_ui(
            f"[Cover] Dateiauswahl für lokales Cover-Bild von Festplatte geöffnet (Startordner: {start_dir})..."
        )
        dialog = Gtk.FileChooserDialog(
            title="Eigenes Cover-Bild von Festplatte auswählen",
            transient_for=self,
            action=Gtk.FileChooserAction.OPEN,
        )
        dialog.add_buttons(
            "Abbrechen",
            Gtk.ResponseType.CANCEL,
            "Bild übernehmen",
            Gtk.ResponseType.OK,
        )
        if start_dir.exists():
            dialog.set_current_folder(str(start_dir))

        img_filter = Gtk.FileFilter()
        img_filter.set_name("Bilddateien (JPG, PNG, WebP, BMP, TIFF)")
        for pat in ("*.jpg", "*.jpeg", "*.png", "*.webp", "*.bmp", "*.tif", "*.tiff"):
            img_filter.add_pattern(pat)
            img_filter.add_pattern(pat.upper())
        dialog.add_filter(img_filter)

        if dialog.run() == Gtk.ResponseType.OK:
            chosen = dialog.get_filename()
            if chosen:
                try:
                    path = Path(chosen)
                    self.settings.last_cover_dir = path.parent
                    save_settings(self.settings, theme_mode=self.theme_watcher.mode)
                    data = path.read_bytes()
                    mime, _ = mimetypes.guess_type(path.name)
                    w, h, orig_fmt = self._apply_cover_bytes(
                        data, mime or "image/jpeg", f"Festplatte ({path.name})"
                    )
                    self._render_cover_preview()
                    self._append_query_log_ui(
                        f"[Cover] Bilddatei geladen: {path.name} ({w}×{h} px · {len(data) // 1024} KB · Format: {orig_fmt})."
                    )
                except Exception as exc:
                    self._append_query_log_ui(f"[Cover] Fehler beim Laden der Bilddatei: {exc}")
        else:
            self._append_query_log_ui("[Cover] Lokale Dateiauswahl abgebrochen.")
        dialog.destroy()

    def _on_save_cover_clicked(self, _btn: Gtk.Button) -> None:
        if not self.album.cover_art_bytes:
            self._append_query_log_ui("[Cover] Kein Coverbild zum Speichern geladen.")
            return
        self._sync_album_from_entries()
        cov_dir = getattr(self.settings, "output_dir_cover", DEFAULT_OUTPUT_DIR_COVER)
        last_dir = getattr(self.settings, "last_cover_dir", None)
        if getattr(self, "_active_module", "") == "module_cover":
            start_dir = cov_dir if Path(cov_dir).exists() else (last_dir if (last_dir and Path(last_dir).exists()) else cov_dir.parent)
        else:
            start_dir = last_dir if (last_dir and Path(last_dir).exists()) else cov_dir
        if not start_dir or not Path(start_dir).exists():
            start_dir = Path.home() / "Musik" if (Path.home() / "Musik").exists() else Path.home()
        suggested_path = build_cover_target_path(Path(start_dir), self.album, self.settings)
        orig_fmt = detect_image_format(
            self.album.cover_art_bytes, self.album.cover_art_mime or "image/jpeg"
        )
        ext_map = {
            "JPEG": ".jpg",
            "PNG": ".png",
            "WEBP": ".webp",
            "BMP": ".bmp",
            "GIF": ".gif",
            "TIFF": ".tiff",
        }
        orig_ext = ext_map.get(orig_fmt, ".jpg")
        stem_name = suggested_path.stem or "cover"
        default_filename = f"{stem_name}{orig_ext}"

        dialog = Gtk.FileChooserDialog(
            title="Speichern unter — Coverbild",
            transient_for=self,
            action=Gtk.FileChooserAction.SAVE,
        )
        dialog.add_buttons(
            "Abbrechen",
            Gtk.ResponseType.CANCEL,
            "Speichern",
            Gtk.ResponseType.OK,
        )
        dialog.set_do_overwrite_confirmation(True)
        if start_dir and Path(start_dir).exists():
            dialog.set_current_folder(str(start_dir))
        dialog.set_current_name(default_filename)

        img_filter = Gtk.FileFilter()
        img_filter.set_name("Bilddateien (JPG, PNG, WebP, BMP)")
        for pat in ("*.jpg", "*.jpeg", "*.png", "*.webp", "*.bmp"):
            img_filter.add_pattern(pat)
            img_filter.add_pattern(pat.upper())
        dialog.add_filter(img_filter)

        if dialog.run() == Gtk.ResponseType.OK:
            chosen = dialog.get_filename()
            if chosen:
                try:
                    target_path = Path(chosen)
                    if not target_path.suffix:
                        target_path = target_path.with_suffix(orig_ext)
                    self.settings.last_cover_dir = target_path.parent
                    save_settings(self.settings, theme_mode=self.theme_watcher.mode)
                    out_bytes = self.album.cover_art_bytes
                    if target_path.suffix.lower() in (".jpg", ".jpeg") and orig_fmt != "JPEG":
                        jpg_bytes, _w, _h, _fmt, _conv = ensure_jpeg_cover(
                            self.album.cover_art_bytes,
                            self.album.cover_art_mime or "image/jpeg",
                        )
                        if jpg_bytes:
                            out_bytes = jpg_bytes
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    target_path.write_bytes(out_bytes)
                    self._append_query_log_ui(
                        f"[Cover] Coverbild manuell gespeichert: {target_path} ({len(out_bytes) // 1024} KB)."
                    )
                except Exception as exc:
                    self._append_query_log_ui(
                        f"[Cover] Fehler beim manuellen Speichern des Coverbilds: {exc}"
                    )
        else:
            self._append_query_log_ui("[Cover] Speichern unter abgebrochen.")
        dialog.destroy()

    def _on_crop_cover_clicked(self, _btn: Gtk.Button) -> None:
        if not self.album.cover_art_bytes:
            self._append_query_log_ui("[Cover] Kein Coverbild zum Beschneiden geladen.")
            return
        try:
            loader = GdkPixbuf.PixbufLoader()
            loader.write(self.album.cover_art_bytes)
            loader.close()
            orig_pixbuf = loader.get_pixbuf()
        except Exception as exc:
            self._append_query_log_ui(f"[Cover] Coverbild konnte nicht zum Beschneiden geöffnet werden: {exc}")
            return

        if orig_pixbuf is None:
            return

        orig_w = max(1, orig_pixbuf.get_width())
        orig_h = max(1, orig_pixbuf.get_height())

        dialog = Gtk.Dialog(
            title=f"Coverbild beschneiden ({orig_w} × {orig_h} px)",
            transient_for=self,
            flags=Gtk.DialogFlags.MODAL,
        )
        dialog.set_default_size(900, 740)
        dialog.add_buttons(
            "Abbrechen",
            Gtk.ResponseType.CANCEL,
            "Zuschnitt übernehmen",
            Gtk.ResponseType.OK,
        )
        ok_btn = dialog.get_widget_for_response(Gtk.ResponseType.OK)
        if ok_btn is not None:
            ok_btn.get_style_context().add_class("suggested-action")

        content = dialog.get_content_area()
        content.set_spacing(8)
        content.set_border_width(12)

        # Toolbar oben im Beschneidungsdialog
        top_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        info_label = Gtk.Label()
        info_label.set_xalign(0)
        top_bar.pack_start(info_label, True, True, 0)

        square_chk = Gtk.CheckButton(label="1:1 Quadratisch fixieren")
        square_chk.set_active(False)
        top_bar.pack_start(square_chk, False, False, 0)

        center_sel_btn = Gtk.Button(label="Auswahl zentrieren")
        center_sel_btn.set_tooltip_text("Eigene Auswahlgröße beibehalten und mittig im Bild zentrieren")
        top_bar.pack_start(center_sel_btn, False, False, 0)

        center_btn = Gtk.Button(label="Mittig 85 %")
        top_bar.pack_start(center_btn, False, False, 0)

        reset_btn = Gtk.Button(label="Vollbild-Auswahl")
        top_bar.pack_start(reset_btn, False, False, 0)

        content.pack_start(top_bar, False, False, 0)

        hint_lbl = Gtk.Label(
            label="Ziehen Sie die Ecken oder Kanten des Beschneidungsrahmens mit der Maus größer oder kleiner, oder verschieben Sie den Rahmen im Bild."
        )
        hint_lbl.set_xalign(0)
        hint_lbl.get_style_context().add_class("dim-label")
        content.pack_start(hint_lbl, False, False, 0)

        state: dict = {
            "x": 0.05,
            "y": 0.05,
            "w": 0.90,
            "h": 0.90,
            "drag_mode": None,
            "start_mx": 0.0,
            "start_my": 0.0,
            "start_rect": (0.05, 0.05, 0.90, 0.90),
            "img_box": (0.0, 0.0, 1.0, 1.0),
        }

        drawing_area = Gtk.DrawingArea()
        drawing_area.set_size_request(680, 560)
        drawing_area.set_hexpand(True)
        drawing_area.set_vexpand(True)
        drawing_area.add_events(
            Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.BUTTON_RELEASE_MASK
            | Gdk.EventMask.POINTER_MOTION_MASK
        )

        def _get_pixel_rect() -> tuple[int, int, int, int]:
            px = max(0, min(orig_w - 1, int(round(state["x"] * orig_w))))
            py = max(0, min(orig_h - 1, int(round(state["y"] * orig_h))))
            pw = max(1, min(orig_w - px, int(round(state["w"] * orig_w))))
            ph = max(1, min(orig_h - py, int(round(state["h"] * orig_h))))
            return px, py, pw, ph

        def _update_info_label() -> None:
            px, py, pw, ph = _get_pixel_rect()
            info_label.set_markup(
                f"<b>Original:</b> {orig_w} × {orig_h} px   ·   "
                f"<b>Zuschnitt:</b> <span foreground='#10b981'><b>{pw} × {ph} px</b></span> "
                f"(Position X={px}, Y={py})"
            )

        def _enforce_square() -> None:
            px_w = state["w"] * orig_w
            px_h = state["h"] * orig_h
            side_px = max(16.0, min(px_w, px_h, float(orig_w), float(orig_h)))
            cx = state["x"] + state["w"] * 0.5
            cy = state["y"] + state["h"] * 0.5
            nw = side_px / orig_w
            nh = side_px / orig_h
            nx = max(0.0, min(1.0 - nw, cx - nw * 0.5))
            ny = max(0.0, min(1.0 - nh, cy - nh * 0.5))
            state["x"], state["y"], state["w"], state["h"] = nx, ny, nw, nh

        def _on_square_toggled(_chk: Gtk.CheckButton) -> None:
            if square_chk.get_active():
                _enforce_square()
                _update_info_label()
                drawing_area.queue_draw()

        def _on_center_selection_clicked(_b: Gtk.Button) -> None:
            w = max(0.01, min(1.0, float(state["w"])))
            h = max(0.01, min(1.0, float(state["h"])))
            state["w"] = w
            state["h"] = h
            state["x"] = max(0.0, min(1.0 - w, (1.0 - w) * 0.5))
            state["y"] = max(0.0, min(1.0 - h, (1.0 - h) * 0.5))
            _update_info_label()
            drawing_area.queue_draw()

        def _on_center_clicked(_b: Gtk.Button) -> None:
            state["x"], state["y"], state["w"], state["h"] = 0.075, 0.075, 0.85, 0.85
            if square_chk.get_active():
                _enforce_square()
            _update_info_label()
            drawing_area.queue_draw()

        def _on_reset_clicked(_b: Gtk.Button) -> None:
            state["x"], state["y"], state["w"], state["h"] = 0.0, 0.0, 1.0, 1.0
            if square_chk.get_active():
                _enforce_square()
            _update_info_label()
            drawing_area.queue_draw()

        square_chk.connect("toggled", _on_square_toggled)
        center_sel_btn.connect("clicked", _on_center_selection_clicked)
        center_btn.connect("clicked", _on_center_clicked)
        reset_btn.connect("clicked", _on_reset_clicked)

        def _on_draw(widget: Gtk.DrawingArea, cr) -> bool:
            alloc = widget.get_allocation()
            area_w = max(1, alloc.width)
            area_h = max(1, alloc.height)

            # Hintergrund dunkelgrau zeichnen
            cr.set_source_rgb(0.11, 0.12, 0.14)
            cr.rectangle(0, 0, area_w, area_h)
            cr.fill()

            pad = 18.0
            avail_w = max(32.0, area_w - 2 * pad)
            avail_h = max(32.0, area_h - 2 * pad)
            scale = min(avail_w / orig_w, avail_h / orig_h)
            disp_w = max(1, int(round(orig_w * scale)))
            disp_h = max(1, int(round(orig_h * scale)))
            disp_x = (area_w - disp_w) * 0.5
            disp_y = (area_h - disp_h) * 0.5
            state["img_box"] = (disp_x, disp_y, float(disp_w), float(disp_h))

            scaled_pb = orig_pixbuf.scale_simple(disp_w, disp_h, GdkPixbuf.InterpType.BILINEAR)
            if scaled_pb is not None:
                Gdk.cairo_set_source_pixbuf(cr, scaled_pb, disp_x, disp_y)
                cr.paint()

            rx = disp_x + state["x"] * disp_w
            ry = disp_y + state["y"] * disp_h
            rw = state["w"] * disp_w
            rh = state["h"] * disp_h

            # Abgedunkelter Außenbereich außerhalb des Beschneidungsrahmens
            cr.set_source_rgba(0.0, 0.0, 0.0, 0.60)
            # Oben
            cr.rectangle(disp_x, disp_y, disp_w, max(0.0, ry - disp_y))
            # Unten
            cr.rectangle(disp_x, ry + rh, disp_w, max(0.0, (disp_y + disp_h) - (ry + rh)))
            # Links
            cr.rectangle(disp_x, ry, max(0.0, rx - disp_x), rh)
            # Rechts
            cr.rectangle(rx + rw, ry, max(0.0, (disp_x + disp_w) - (rx + rw)), rh)
            cr.fill()

            # Drittel-Hilfslinien im Beschneidungsrahmen
            cr.set_source_rgba(1.0, 1.0, 1.0, 0.35)
            cr.set_line_width(1.0)
            for frac in (1.0 / 3.0, 2.0 / 3.0):
                gx = rx + rw * frac
                cr.move_to(gx, ry)
                cr.line_to(gx, ry + rh)
                gy = ry + rh * frac
                cr.move_to(rx, gy)
                cr.line_to(rx + rw, gy)
            cr.stroke()

            # Rahmen um den Zuschnittbereich
            cr.set_source_rgb(0.06, 0.72, 0.50)
            cr.set_line_width(2.2)
            cr.rectangle(rx, ry, rw, rh)
            cr.stroke()

            # 8 Ziehpunkte (Ecken + Kantenmitten)
            handles = [
                (rx, ry),
                (rx + rw * 0.5, ry),
                (rx + rw, ry),
                (rx + rw, ry + rh * 0.5),
                (rx + rw, ry + rh),
                (rx + rw * 0.5, ry + rh),
                (rx, ry + rh),
                (rx, ry + rh * 0.5),
            ]
            hs = 6.0
            for hx, hy in handles:
                cr.set_source_rgb(1.0, 1.0, 1.0)
                cr.rectangle(hx - hs, hy - hs, hs * 2, hs * 2)
                cr.fill()
                cr.set_source_rgb(0.06, 0.72, 0.50)
                cr.set_line_width(1.8)
                cr.rectangle(hx - hs, hy - hs, hs * 2, hs * 2)
                cr.stroke()

            return False

        def _hit_test_mode(mx: float, my: float) -> Optional[str]:
            disp_x, disp_y, disp_w, disp_h = state["img_box"]
            rx = disp_x + state["x"] * disp_w
            ry = disp_y + state["y"] * disp_h
            rw = state["w"] * disp_w
            rh = state["h"] * disp_h
            tol = 12.0
            handle_pts = [
                ("nw", rx, ry),
                ("n", rx + rw * 0.5, ry),
                ("ne", rx + rw, ry),
                ("e", rx + rw, ry + rh * 0.5),
                ("se", rx + rw, ry + rh),
                ("s", rx + rw * 0.5, ry + rh),
                ("sw", rx, ry + rh),
                ("w", rx, ry + rh * 0.5),
            ]
            for name, hx, hy in handle_pts:
                if abs(mx - hx) <= tol and abs(my - hy) <= tol:
                    return name
            if rx <= mx <= rx + rw and ry <= my <= ry + rh:
                return "move"
            return None

        def _on_button_press(_widget: Gtk.DrawingArea, event: Gdk.EventButton) -> bool:
            if event.button != 1:
                return False
            mode = _hit_test_mode(event.x, event.y)
            if mode is not None:
                state["drag_mode"] = mode
                state["start_mx"] = event.x
                state["start_my"] = event.y
                state["start_rect"] = (state["x"], state["y"], state["w"], state["h"])
                return True
            return False

        def _on_button_release(_widget: Gtk.DrawingArea, event: Gdk.EventButton) -> bool:
            if event.button == 1 and state["drag_mode"] is not None:
                state["drag_mode"] = None
                return True
            return False

        def _on_motion_notify(_widget: Gtk.DrawingArea, event: Gdk.EventMotion) -> bool:
            mode = state["drag_mode"]
            if mode is None:
                return False
            _disp_x, _disp_y, disp_w, disp_h = state["img_box"]
            if disp_w <= 1 or disp_h <= 1:
                return False
            dx = (event.x - state["start_mx"]) / disp_w
            dy = (event.y - state["start_my"]) / disp_h
            sx, sy, sw, sh = state["start_rect"]
            min_w = max(0.03, 16.0 / orig_w)
            min_h = max(0.03, 16.0 / orig_h)

            nx, ny, nw, nh = sx, sy, sw, sh
            if mode == "move":
                nx = max(0.0, min(1.0 - sw, sx + dx))
                ny = max(0.0, min(1.0 - sh, sy + dy))
            else:
                if "w" in mode:
                    max_dx = sw - min_w
                    clamped_dx = max(-sx, min(max_dx, dx))
                    nx = sx + clamped_dx
                    nw = sw - clamped_dx
                if "e" in mode:
                    nw = max(min_w, min(1.0 - sx, sw + dx))
                if "n" in mode:
                    max_dy = sh - min_h
                    clamped_dy = max(-sy, min(max_dy, dy))
                    ny = sy + clamped_dy
                    nh = sh - clamped_dy
                if "s" in mode:
                    nh = max(min_h, min(1.0 - sy, sh + dy))

                if square_chk.get_active():
                    side_px = max(16.0, min(nw * orig_w, nh * orig_h, float(orig_w), float(orig_h)))
                    target_w = side_px / orig_w
                    target_h = side_px / orig_h
                    if "w" in mode:
                        nx = (sx + sw) - target_w
                    if "n" in mode:
                        ny = (sy + sh) - target_h
                    nw = target_w
                    nh = target_h
                    if nx < 0.0:
                        nx = 0.0
                    if ny < 0.0:
                        ny = 0.0
                    if nx + nw > 1.0:
                        nw = 1.0 - nx
                    if ny + nh > 1.0:
                        nh = 1.0 - ny

            state["x"], state["y"], state["w"], state["h"] = nx, ny, nw, nh
            _update_info_label()
            drawing_area.queue_draw()
            return True

        drawing_area.connect("draw", _on_draw)
        drawing_area.connect("button-press-event", _on_button_press)
        drawing_area.connect("button-release-event", _on_button_release)
        drawing_area.connect("motion-notify-event", _on_motion_notify)

        content.pack_start(drawing_area, True, True, 0)
        _update_info_label()
        dialog.show_all()

        if dialog.run() == Gtk.ResponseType.OK:
            px, py, pw, ph = _get_pixel_rect()
            try:
                cropped_pb = orig_pixbuf.new_subpixbuf(px, py, pw, ph)
                if cropped_pb is not None:
                    orig_fmt = detect_image_format(
                        self.album.cover_art_bytes,
                        self.album.cover_art_mime or "image/jpeg",
                    )
                    if orig_fmt == "PNG":
                        ok, buf = cropped_pb.save_to_bufferv("png", [], [])
                        new_mime = "image/png"
                    else:
                        if cropped_pb.get_has_alpha():
                            composited = cropped_pb.composite_color_simple(
                                pw,
                                ph,
                                GdkPixbuf.InterpType.BILINEAR,
                                255,
                                16,
                                0xFFFFFF,
                                0xFFFFFF,
                            )
                            if composited is not None:
                                cropped_pb = composited
                        ok, buf = cropped_pb.save_to_bufferv("jpeg", ["quality"], ["95"])
                        new_mime = "image/jpeg"
                    if ok and buf:
                        new_bytes = bytes(buf)
                        prev_src = self.album.cover_art_source or "Cover"
                        w, h, fmt_out = self._apply_cover_bytes(
                            new_bytes,
                            new_mime,
                            f"{prev_src} (Beschnitten {pw}×{ph} px)",
                        )
                        self._render_cover_preview()
                        self._append_query_log_ui(
                            f"[Cover] Coverbild beschnitten: {w}×{h} px ({len(new_bytes) // 1024} KB · Format: {fmt_out})."
                        )
            except Exception as exc:
                self._append_query_log_ui(f"[Cover] Fehler beim Beschneiden des Coverbilds: {exc}")
        dialog.destroy()

    def _on_scale_cover_clicked(self, _btn: Gtk.Button | None) -> None:
        if not self.album.cover_art_bytes:
            self._append_query_log_ui("[Cover] Kein Coverbild zum Skalieren geladen.")
            return
        try:
            loader = GdkPixbuf.PixbufLoader()
            loader.write(self.album.cover_art_bytes)
            loader.close()
            orig_pixbuf = loader.get_pixbuf()
        except Exception as exc:
            self._append_query_log_ui(f"[Cover] Coverbild konnte nicht zum Skalieren geöffnet werden: {exc}")
            return

        if orig_pixbuf is None:
            return

        orig_w = max(1, orig_pixbuf.get_width())
        orig_h = max(1, orig_pixbuf.get_height())
        aspect = orig_w / float(orig_h)

        dialog = Gtk.Dialog(
            title=f"Coverbild skalieren ({orig_w} × {orig_h} px)",
            transient_for=self,
            flags=Gtk.DialogFlags.MODAL,
        )
        dialog.set_default_size(560, 420)
        dialog.add_buttons(
            "Abbrechen",
            Gtk.ResponseType.CANCEL,
            "Skalierung übernehmen",
            Gtk.ResponseType.OK,
        )
        ok_btn = dialog.get_widget_for_response(Gtk.ResponseType.OK)
        if ok_btn is not None:
            ok_btn.get_style_context().add_class("suggested-action")

        content = dialog.get_content_area()
        content.set_spacing(12)
        content.set_border_width(14)

        orig_info = Gtk.Label()
        orig_info.set_xalign(0)
        orig_info.set_markup(
            f"<b>Aktuelle Bildgröße:</b> {orig_w} × {orig_h} px   ·   "
            f"<b>Format:</b> {GLib.markup_escape_text(self.album.cover_art_original_format or 'JPEG')}"
        )
        content.pack_start(orig_info, False, False, 0)

        mode_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=16)
        radio_square = Gtk.RadioButton.new_with_label_from_widget(None, "Quadratisch (1:1)")
        radio_custom = Gtk.RadioButton.new_with_label_from_widget(
            radio_square, "Andere Werte (Breite × Höhe)"
        )
        radio_square.set_active(orig_w == orig_h)
        radio_custom.set_active(orig_w != orig_h)
        mode_row.pack_start(radio_square, False, False, 0)
        mode_row.pack_start(radio_custom, False, False, 0)
        content.pack_start(mode_row, False, False, 0)

        # Box 1: Quadratisch (1:1)
        square_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        sq_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        sq_lbl = Gtk.Label(label="Quadratische Kantenlänge (Breite = Höhe):")
        sq_lbl.set_xalign(0)
        sq_row.pack_start(sq_lbl, False, False, 0)
        spin_square = Gtk.SpinButton.new_with_range(32, 6000, 10)
        spin_square.set_value(max(orig_w, orig_h))
        sq_row.pack_start(spin_square, False, False, 0)
        sq_row.pack_start(Gtk.Label(label="px"), False, False, 0)
        square_box.pack_start(sq_row, False, False, 0)

        sq_preset_lbl = Gtk.Label(label="Schnellauswahl für quadratische Standard-Covergrößen:")
        sq_preset_lbl.set_xalign(0)
        sq_preset_lbl.get_style_context().add_class("dim-label")
        square_box.pack_start(sq_preset_lbl, False, False, 0)

        sq_flow = Gtk.FlowBox()
        sq_flow.set_selection_mode(Gtk.SelectionMode.NONE)
        sq_flow.set_max_children_per_line(7)
        sq_flow.set_column_spacing(6)
        sq_flow.set_row_spacing(6)
        for preset_px in (300, 500, 600, 800, 1000, 1200, 1500):
            pbtn = Gtk.Button(label=f"{preset_px} × {preset_px}")
            pbtn.connect("clicked", lambda _b, val=preset_px: spin_square.set_value(val))
            sq_flow.add(pbtn)
        square_box.pack_start(sq_flow, False, False, 0)
        content.pack_start(square_box, False, False, 0)

        # Box 2: Andere Werte (Breite x Höhe)
        custom_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        dim_grid = Gtk.Grid()
        dim_grid.set_column_spacing(12)
        dim_grid.set_row_spacing(8)

        w_lbl = Gtk.Label(label="Breite (px):")
        w_lbl.set_xalign(0)
        dim_grid.attach(w_lbl, 0, 0, 1, 1)
        spin_w = Gtk.SpinButton.new_with_range(16, 6000, 10)
        spin_w.set_value(orig_w)
        dim_grid.attach(spin_w, 1, 0, 1, 1)

        h_lbl = Gtk.Label(label="Höhe (px):")
        h_lbl.set_xalign(0)
        dim_grid.attach(h_lbl, 2, 0, 1, 1)
        spin_h = Gtk.SpinButton.new_with_range(16, 6000, 10)
        spin_h.set_value(orig_h)
        dim_grid.attach(spin_h, 3, 0, 1, 1)
        custom_box.pack_start(dim_grid, False, False, 0)

        lock_aspect_chk = Gtk.CheckButton(label="Seitenverhältnis beibehalten (Proportional skalieren)")
        lock_aspect_chk.set_active(True)
        custom_box.pack_start(lock_aspect_chk, False, False, 0)

        pct_flow = Gtk.FlowBox()
        pct_flow.set_selection_mode(Gtk.SelectionMode.NONE)
        pct_flow.set_max_children_per_line(5)
        pct_flow.set_column_spacing(6)
        pct_flow.set_row_spacing(6)

        updating_spins = {"busy": False}

        def _set_custom_factor(factor: float) -> None:
            updating_spins["busy"] = True
            try:
                spin_w.set_value(max(16, int(round(orig_w * factor))))
                spin_h.set_value(max(16, int(round(orig_h * factor))))
            finally:
                updating_spins["busy"] = False
            _update_target_summary()

        for factor, label_txt in (
            (0.5, "50 %"),
            (0.75, "75 %"),
            (1.0, "100 % (Original)"),
            (1.5, "150 %"),
            (2.0, "200 %"),
        ):
            fbtn = Gtk.Button(label=label_txt)
            fbtn.connect("clicked", lambda _b, f=factor: _set_custom_factor(f))
            pct_flow.add(fbtn)
        custom_box.pack_start(pct_flow, False, False, 0)
        content.pack_start(custom_box, False, False, 0)

        target_summary = Gtk.Label()
        target_summary.set_xalign(0)
        content.pack_start(target_summary, False, False, 4)

        def _get_target_dims() -> tuple[int, int]:
            if radio_square.get_active():
                side = max(16, min(6000, spin_square.get_value_as_int()))
                return side, side
            return (
                max(16, min(6000, spin_w.get_value_as_int())),
                max(16, min(6000, spin_h.get_value_as_int())),
            )

        def _update_target_summary() -> None:
            tw, th = _get_target_dims()
            target_summary.set_markup(
                f"<b>Neue Ziel-Auflösung:</b> <span foreground='#10b981'><b>{tw} × {th} px</b></span> "
                f"(Original: {orig_w} × {orig_h} px)"
            )

        def _on_w_changed(_s: Gtk.SpinButton) -> None:
            if updating_spins["busy"]:
                return
            if lock_aspect_chk.get_active():
                updating_spins["busy"] = True
                try:
                    new_w = max(16, spin_w.get_value_as_int())
                    spin_h.set_value(max(16, int(round(new_w / max(0.01, aspect)))))
                finally:
                    updating_spins["busy"] = False
            _update_target_summary()

        def _on_h_changed(_s: Gtk.SpinButton) -> None:
            if updating_spins["busy"]:
                return
            if lock_aspect_chk.get_active():
                updating_spins["busy"] = True
                try:
                    new_h = max(16, spin_h.get_value_as_int())
                    spin_w.set_value(max(16, int(round(new_h * aspect))))
                finally:
                    updating_spins["busy"] = False
            _update_target_summary()

        def _update_mode_vis() -> None:
            is_sq = radio_square.get_active()
            square_box.set_visible(is_sq)
            custom_box.set_visible(not is_sq)
            _update_target_summary()

        spin_square.connect("value-changed", lambda _s: _update_target_summary())
        spin_w.connect("value-changed", _on_w_changed)
        spin_h.connect("value-changed", _on_h_changed)
        radio_square.connect("toggled", lambda _b: _update_mode_vis())

        dialog.show_all()
        _update_mode_vis()

        if dialog.run() == Gtk.ResponseType.OK:
            target_w, target_h = _get_target_dims()
            try:
                scaled_pb = orig_pixbuf.scale_simple(
                    target_w, target_h, GdkPixbuf.InterpType.HYPER
                )
                if scaled_pb is not None:
                    orig_fmt = detect_image_format(
                        self.album.cover_art_bytes,
                        self.album.cover_art_mime or "image/jpeg",
                    )
                    if orig_fmt == "PNG":
                        ok, buf = scaled_pb.save_to_bufferv("png", [], [])
                        new_mime = "image/png"
                    else:
                        if scaled_pb.get_has_alpha():
                            composited = scaled_pb.composite_color_simple(
                                target_w,
                                target_h,
                                GdkPixbuf.InterpType.BILINEAR,
                                255,
                                16,
                                0xFFFFFF,
                                0xFFFFFF,
                            )
                            if composited is not None:
                                scaled_pb = composited
                        ok, buf = scaled_pb.save_to_bufferv("jpeg", ["quality"], ["95"])
                        new_mime = "image/jpeg"
                    if ok and buf:
                        new_bytes = bytes(buf)
                        prev_src = self.album.cover_art_source or "Cover"
                        w, h, fmt_out = self._apply_cover_bytes(
                            new_bytes,
                            new_mime,
                            f"{prev_src} (Skaliert {target_w}×{target_h} px)",
                        )
                        self._render_cover_preview()
                        self._append_query_log_ui(
                            f"[Cover] Coverbild skaliert auf {w}×{h} px ({len(new_bytes) // 1024} KB · Format: {fmt_out})."
                        )
            except Exception as exc:
                self._append_query_log_ui(f"[Cover] Fehler beim Skalieren des Coverbilds: {exc}")
        dialog.destroy()

    def _on_scan_cover_clicked(self, _btn: Gtk.Button) -> None:
        if self._scanner_cancel_event is not None:
            return

        chosen_dpi = int(getattr(self.settings, "scanner_dpi", 300) or 300)
        color_mode = str(getattr(self.settings, "scanner_color_mode", "Color") or "Color")
        scan_area = str(getattr(self.settings, "scanner_scan_area", "cd_booklet") or "cd_booklet")
        scanner_dev = str(getattr(self.settings, "scanner_device", "") or "").strip()
        auto_open_crop = bool(getattr(self.settings, "scanner_auto_open_crop", True))

        if not shutil.which("scanimage"):
            self._append_query_log_ui(
                "[Scanner] SANE-Werkzeug 'scanimage' nicht gefunden (sudo apt install sane-utils)."
            )
            return

        cancel_evt = threading.Event()
        self._scanner_cancel_event = cancel_evt
        self._set_cover_search_running_ui(True, mode="scan")

        area_label = (
            "125×125 mm Booklet"
            if scan_area == "cd_booklet"
            else ("150×120 mm Inlay" if scan_area == "cd_inlay" else "Vollfläche")
        )
        self._append_query_log_ui(
            f"[Scanner] Starte sofortigen SANE-Direktscan ({chosen_dpi} DPI · {color_mode} · {area_label})..."
        )

        def scan_worker() -> None:
            tmp_path = Path(tempfile.mktemp(suffix=".png", prefix="mintrip_scan_"))
            try:
                cmd = [
                    "scanimage",
                    "--format=png",
                    "--mode",
                    color_mode,
                    "--resolution",
                    str(chosen_dpi),
                ]
                if scanner_dev:
                    cmd.extend(["-d", scanner_dev])
                if scan_area == "cd_booklet":
                    cmd.extend(["-x", "125", "-y", "125"])
                elif scan_area == "cd_inlay":
                    cmd.extend(["-x", "150", "-y", "120"])

                with tmp_path.open("wb") as out_f:
                    proc = subprocess.Popen(cmd, stdout=out_f, stderr=subprocess.PIPE)
                    self._scanner_proc = proc
                    _, stderr_bytes = proc.communicate(timeout=90)

                if cancel_evt.is_set():
                    return

                if proc.returncode != 0 or not tmp_path.exists() or tmp_path.stat().st_size < 512:
                    err_txt = (stderr_bytes or b"").decode("utf-8", errors="replace").strip() or "Kein SANE-Scanner erkannt"
                    self._append_query_log_threadsafe(f"[Scanner] Scan fehlgeschlagen: {err_txt}")
                    return

                data = tmp_path.read_bytes()
                w, h, orig_fmt = self._apply_cover_bytes(
                    data, "image/png", f"Scanner ({chosen_dpi} DPI)"
                )

                def _on_scan_finished_ui() -> bool:
                    self._render_cover_preview()
                    self._append_query_log_ui(
                        f"[Scanner] CD-Cover eingescannt ({w}×{h} px · {chosen_dpi} DPI · {len(data) // 1024} KB · Format: {orig_fmt})."
                    )
                    if auto_open_crop:
                        self._append_query_log_ui(
                            "[Scanner] Öffne automatisch das Fenster für den Cover-Zuschnitt..."
                        )
                        self._on_crop_cover_clicked(self.crop_cover_btn)
                    return False

                GLib.idle_add(_on_scan_finished_ui)
            except Exception as exc:
                if not cancel_evt.is_set():
                    self._append_query_log_threadsafe(f"[Scanner] Scanner-Fehler: {exc}")
            finally:
                self._scanner_proc = None
                tmp_path.unlink(missing_ok=True)

                def _cleanup_scan_overlay() -> bool:
                    if self._scanner_cancel_event is cancel_evt:
                        self._scanner_cancel_event = None
                        self._set_cover_search_running_ui(False)
                    return False

                GLib.idle_add(_cleanup_scan_overlay)

        threading.Thread(target=scan_worker, daemon=True).start()

    def _on_cover_dropped(self, image_bytes: bytes, mime: str, source_label: str) -> None:
        w, h, orig_fmt = self._apply_cover_bytes(image_bytes, mime, source_label)
        self._render_cover_preview()
        self._append_query_log_ui(
            f"[Cover] Bild per Drag & Drop übernommen: {source_label} ({w}×{h} px · {len(image_bytes) // 1024} KB · Format: {orig_fmt})."
        )

    def _on_draw_dnd_icon(self, area: Gtk.DrawingArea, cr) -> bool:
        """Zeichnet ein klares Drag-&-Drop-Icon (Album-Ordner mit Ablege-Pfeil in Mintgrün)."""
        w = area.get_allocated_width()
        h = area.get_allocated_height()
        s = min(w, h)
        ox = (w - s) / 2.0
        oy = (h - s) / 2.0
        cr.save()
        cr.translate(ox, oy)
        cr.scale(s / 48.0, s / 48.0)

        # Leichter Hintergrund-Kreis
        cr.set_source_rgba(0.357, 0.651, 0.196, 0.14)
        cr.arc(24.0, 24.0, 22.0, 0, 2.0 * math.pi)
        cr.fill()

        # Ablage-Schale / Ordner-Umriss
        cr.set_source_rgba(0.357, 0.651, 0.196, 0.95)
        cr.set_line_width(2.6)
        cr.set_line_cap(1)   # CAIRO_LINE_CAP_ROUND
        cr.set_line_join(1)  # CAIRO_LINE_JOIN_ROUND

        cr.move_to(11.0, 28.0)
        cr.line_to(11.0, 34.0)
        cr.curve_to(11.0, 36.2, 12.8, 38.0, 15.0, 38.0)
        cr.line_to(33.0, 38.0)
        cr.curve_to(35.2, 38.0, 37.0, 36.2, 37.0, 34.0)
        cr.line_to(37.0, 28.0)
        cr.stroke()

        # Nach-unten-Pfeil (Drag & Drop)
        cr.move_to(24.0, 11.0)
        cr.line_to(24.0, 29.0)
        cr.stroke()
        cr.move_to(17.5, 23.0)
        cr.line_to(24.0, 29.5)
        cr.line_to(30.5, 23.0)
        cr.stroke()
        cr.restore()
        return False

    def _build_dnd_overlay_box(self, title_markup: str, subtitle_markup: str) -> Gtk.Box:
        """Erstellt das leichte halbtransparente Drag-&-Drop-Overlay mit Icon über Alben- & Titelliste."""
        overlay_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        overlay_box.get_style_context().add_class("dnd-drop-overlay")
        overlay_box.set_halign(Gtk.Align.FILL)
        overlay_box.set_valign(Gtk.Align.FILL)

        card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        card.get_style_context().add_class("dnd-drop-overlay-card")
        card.set_halign(Gtk.Align.CENTER)
        card.set_valign(Gtk.Align.CENTER)

        icon_area = Gtk.DrawingArea()
        icon_area.set_size_request(52, 52)
        icon_area.set_halign(Gtk.Align.CENTER)
        icon_area.connect("draw", self._on_draw_dnd_icon)
        card.pack_start(icon_area, False, False, 0)

        lbl_title = Gtk.Label()
        lbl_title.set_markup(f"<b>{title_markup}</b>")
        lbl_title.set_halign(Gtk.Align.CENTER)
        card.pack_start(lbl_title, False, False, 0)

        lbl_sub = Gtk.Label()
        lbl_sub.set_markup(f"<span size='small'>{subtitle_markup}</span>")
        lbl_sub.get_style_context().add_class("dim-label")
        lbl_sub.set_halign(Gtk.Align.CENTER)
        card.pack_start(lbl_sub, False, False, 0)

        card.show_all()
        overlay_box.pack_start(card, True, False, 0)
        overlay_box.set_no_show_all(True)
        overlay_box.hide()
        return overlay_box

    def _set_module3_dnd_overlay(self, target: str, active: bool) -> None:
        """Zeigt/versteckt das leichte Drag-&-Drop-Overlay in Modul 3 flimmerfrei über Alben- oder Titelliste."""
        timers = getattr(self, "_dnd_hide_timers", None)
        if timers is None:
            self._dnd_hide_timers = {}
            timers = self._dnd_hide_timers
        existing_tid = timers.pop(target, 0)
        if existing_tid:
            try:
                GLib.source_remove(existing_tid)
            except Exception:
                pass

        overlay_box = self.hits_dnd_overlay_box if target == "hits" else self.track_dnd_overlay_box
        if active:
            if getattr(self, "_active_module", "") != "module_tag":
                overlay_box.hide()
                return
            if self._batch_running and not self._batch_paused:
                overlay_box.hide()
                return
            if target == "hits" and self._hits_search_active:
                overlay_box.hide()
                return
            overlay_box.show()
            return

        def _do_hide() -> bool:
            timers.pop(target, None)
            overlay_box.hide()
            return False

        timers[target] = GLib.timeout_add(65, _do_hide)

    def _hide_all_module3_dnd_overlays(self) -> None:
        timers = getattr(self, "_dnd_hide_timers", {})
        for key in list(timers.keys()):
            tid = timers.pop(key, 0)
            if tid:
                try:
                    GLib.source_remove(tid)
                except Exception:
                    pass
        if hasattr(self, "hits_dnd_overlay_box"):
            self.hits_dnd_overlay_box.hide()
        if hasattr(self, "track_dnd_overlay_box"):
            self.track_dnd_overlay_box.hide()

    def _on_hits_audio_files_dropped(self, paths: list[Path]) -> None:
        self._hide_all_module3_dnd_overlays()
        if getattr(self, "_active_module", "") != "module_tag":
            return
        if self._hits_search_active or (self._batch_running and not self._batch_paused):
            return
        if not paths:
            return
        # Felder & vorherige Ergebnisse zurücksetzen und automatisch Online-Abfrage mit Overlay starten
        self._reset_all_fields_state(
            emit_log=True,
            log_reason="Drag & Drop in Albenliste – Ansicht zurückgesetzt, starte automatische Online-Abfrage.",
        )
        self._import_audio_paths_with_toc(
            paths, append=False, auto_online_lookup=True, show_overlay=True
        )

    def _on_audio_files_dropped(self, paths: list[Path]) -> None:
        self._hide_all_module3_dnd_overlays()
        if self._batch_running and not self._batch_paused:
            return
        if not paths:
            return
        if getattr(self, "_active_module", "") == "module_tag":
            # Modul 3: Aktuell geladene Liste beim Drag & Drop eines Albums immer vollständig leeren
            self._reset_all_fields_state(
                emit_log=True,
                log_reason="Drag & Drop in Titelliste – aktuelle Liste geleert, lade neues Album.",
            )
            self._import_audio_paths_with_toc(
                paths, append=False, auto_online_lookup=False
            )
            return
        # Modul 2: Ordner-Drop ersetzt, Einzeldatei-Drop hängt an
        is_folder_drop = any(p.is_dir() for p in paths)
        self._import_audio_paths_with_toc(
            paths, append=(not is_folder_drop), auto_online_lookup=False
        )

    def _on_enqueue_album_clicked(self, _btn: Gtk.Button) -> None:
        self._sync_album_from_entries()
        device_path = self._get_selected_drive()
        enqueued_count = 0
        selected_tracks = [t for t in self.album.tracks if t.selected]
        is_imported_only = bool(selected_tracks) and all(
            t.source_file is not None for t in selected_tracks
        )
        convert_local_to_flac = (
            getattr(self, "_active_module", "") == "module_tag"
            and is_imported_only
            and hasattr(self, "convert_local_flac_chk")
            and self.convert_local_flac_chk.get_active()
        )
        from dataclasses import replace

        active_mod = getattr(self, "_active_module", "")
        target_out_dir = (
            getattr(self.settings, "output_dir_tag", DEFAULT_OUTPUT_DIR_TAG)
            if active_mod == "module_tag"
            else getattr(self.settings, "output_dir_rip", self.settings.output_dir)
        )
        job_settings = replace(
            self.settings,
            output_dir=target_out_dir,
            export_format=ExportFormat.FLAC if convert_local_to_flac else self.settings.export_format,
        )

        batch_run_id = str(uuid.uuid4())[:6]
        album_hdr = (self.album.title or "Unbekanntes Album").strip()

        new_group_ids: list[str] = []
        for track in selected_tracks:
            is_local = track.source_file is not None
            job_tag_only = is_local and not convert_local_to_flac
            eff_disc = max(1, int(getattr(track, "disc_number", self.album.disc_number) or 1))
            gid = f"{batch_run_id}:disc{eff_disc}"
            if gid not in new_group_ids:
                new_group_ids.append(gid)
            glabel = album_hdr
            job = BatchJob(
                device_path="" if is_local else device_path,
                album=self.album,
                track=track,
                settings=job_settings,
                tag_only=job_tag_only,
                group_id=gid,
                group_label=glabel,
                status_message=f"Wartet: {track.source_file.name} → WAV → FLAC (Tags beibehalten)"
                if convert_local_to_flac and track.source_file
                else (
                    f"Bereit zum Tag-Schreiben ({track.source_file.name})"
                    if is_local and track.source_file
                    else "Bereit"
                ),
            )
            self._append_batch_row(job)
            self.batch_manager.enqueue(job)
            enqueued_count += 1

        if enqueued_count > 0:
            # 2.3: Bei "Rippen", "Tags in Dateien schreiben" bzw. "In FLAC umwandeln" exklusiv Display 3 ("Stapelverarbeitung") öffnen
            self._awaiting_album_selection = False
            self._album_loaded_in_tracks = True
            self._active_display = "batch"
            self._batch_running = True
            self._batch_paused = False
            if convert_local_to_flac:
                self._append_query_log_ui(
                    f"[WAV→FLAC] {enqueued_count} importierte Datei(en) von „{self.album.artist} – {self.album.title}“ "
                    f"zur 2-Schritt-Umwandlung (erst nach WAV, danach nach FLAC · Bitraten exakt · Tags & Cover beibehalten) gestartet."
                )
            elif is_imported_only:
                self._append_query_log_ui(
                    f"[Tag-Writer] {enqueued_count} importierte Datei(en) von „{self.album.artist} – {self.album.title}“ "
                    f"zum direkten Tag-Schreiben (ohne Re-Rip) gestartet."
                )
            else:
                self._append_query_log_ui(
                    f"[Stapelverarbeitung] {enqueued_count} Titel von „{self.album.artist} – {self.album.title}“ "
                    f"als {job_settings.export_format.value.upper()} in Warteschlange eingereiht und gestartet."
                )
            self.batch_manager.start_all()
            self._update_workspace_visibility_and_locks()
            # Nach dem Einblenden von Display 3 neue CD-Gruppen zuverlässig ausklappen und nach oben scrollen
            for gid in new_group_ids:
                g_iter = self._batch_group_iters.get(gid)
                if g_iter is not None and self.batch_store.iter_is_valid(g_iter):
                    g_path = self.batch_store.get_path(g_iter)
                    if g_path is not None:
                        self.batch_treeview.expand_row(g_path, False)
            if len(self.batch_store) > 0:
                self.batch_treeview.scroll_to_cell(Gtk.TreePath.new_first(), None, False, 0.0, 0.0)
        else:
            self._append_query_log_ui(
                "[Stapelverarbeitung] Keine Titel ausgewählt – es wurden keine Aufträge eingereiht."
            )

    def _on_pause_batch_clicked(self, _btn: Gtk.Button) -> None:
        paused = self.batch_manager.toggle_pause()
        self._batch_paused = paused
        if paused:
            self._active_display = "tracks"
            self._append_query_log_ui(
                "[Stapelverarbeitung] Warteschlange pausiert – Bedienelemente entsperrt & Titelverwaltung ausgeklappt."
            )
        else:
            self._active_display = "batch"
            self._append_query_log_ui(
                "[Stapelverarbeitung] Warteschlange fortgesetzt – Stapelverarbeitung exklusiv geöffnet & Bedienelemente gesperrt."
            )
        self._update_workspace_visibility_and_locks()

    def _on_cancel_batch_clicked(self, _btn: Gtk.Button) -> None:
        self.batch_manager.cancel_all()
        self._batch_running = False
        self._batch_paused = False
        self._active_display = "tracks"
        for gid in list(self._batch_group_iters.keys()):
            self._refresh_batch_group_row(gid)
        self._update_workspace_visibility_and_locks()
        self._append_query_log_ui(
            "[Stapelverarbeitung] Alle laufenden und wartenden Aufträge abgebrochen – Bedienelemente wieder aktiv."
        )

    def _on_batch_row_activated(
        self, treeview: Gtk.TreeView, path: Gtk.TreePath, _col: Gtk.TreeViewColumn
    ) -> None:
        if path.get_depth() == 1:
            if treeview.row_expanded(path):
                treeview.collapse_row(path)
            else:
                treeview.expand_row(path, False)

    def _on_batch_button_press(self, treeview: Gtk.TreeView, event: Gdk.EventButton) -> bool:
        if event.type != Gdk.EventType.BUTTON_PRESS or event.button != 1:
            return False
        hit = treeview.get_path_at_pos(int(event.x), int(event.y))
        if not hit:
            return False
        path, col, _cx, _cy = hit
        # Klick auf den CD-Gruppenkopf (außerhalb der Expander-Spalte) klappt die CD-Gruppe direkt auf/zu
        if path.get_depth() == 1 and col is not self._batch_col_num:
            if treeview.row_expanded(path):
                treeview.collapse_row(path)
            else:
                treeview.expand_row(path, False)
            return True
        return False

    def _refresh_batch_group_row(self, group_id: str) -> None:
        group_iter = self._batch_group_iters.get(group_id)
        if group_iter is None or not self.batch_store.iter_is_valid(group_iter):
            return
        group_jobs = self._batch_group_jobs.get(group_id, [])
        if not group_jobs:
            return
        total = len(group_jobs)
        done_cnt = sum(1 for j in group_jobs if j.stage == BatchStage.DONE)
        err_cnt = sum(1 for j in group_jobs if j.stage == BatchStage.ERROR)
        cancel_cnt = sum(1 for j in group_jobs if j.stage == BatchStage.CANCELLED)
        active_cnt = sum(
            1
            for j in group_jobs
            if j.stage
            in (
                BatchStage.RIPPING,
                BatchStage.ENCODING_FLAC,
                BatchStage.ENCODING_MP3,
                BatchStage.TAGGING,
            )
        )
        all_done = bool(group_jobs) and all(j.stage == BatchStage.DONE for j in group_jobs)
        all_stopped = bool(group_jobs) and all(
            j.stage in (BatchStage.DONE, BatchStage.ERROR, BatchStage.CANCELLED)
            for j in group_jobs
        )
        avg_pct = int(
            round(
                (sum(max(0.0, min(1.0, j.progress)) for j in group_jobs) / max(1, total))
                * 100
            )
        )
        total_sec = sum(max(0, int(getattr(j.track, "duration_seconds", 0) or 0)) for j in group_jobs)
        dur_str = f"{total_sec // 60}:{total_sec % 60:02d}"

        sample = group_jobs[0]
        eff_disc = max(1, int(getattr(sample.track, "disc_number", sample.album.disc_number) or 1))
        total_discs = max(1, int(getattr(sample.album, "total_discs", 1) or 1), eff_disc)
        cd_badge = f"CD {eff_disc}/{total_discs}"
        album_artist = normalize_multi_artist(sample.album.album_artist or sample.album.artist or "").strip()
        album_title = (sample.album.title or sample.group_label or "Unbekanntes Album").strip()
        if album_artist:
            glabel = f"{album_artist} - {album_title} ({total} Titel)"
        else:
            glabel = f"{album_title} ({total} Titel)"
        glabel_esc = GLib.markup_escape_text(glabel)
        sub_info = f"{done_cnt}/{total} Titel fertig"
        if err_cnt > 0:
            sub_info += f" · {err_cnt} Fehler"
        if cancel_cnt > 0:
            sub_info += f" · {cancel_cnt} abgebrochen"
        title_markup = f"<b>{glabel_esc}</b>\n<span size='small'>{GLib.markup_escape_text(sub_info)}</span>"

        if all_done:
            status_text = f"Abgeschlossen ({done_cnt}/{total} Titel)"
        elif all_stopped:
            if err_cnt > 0:
                status_text = f"Beendet mit {err_cnt} Fehler(n) ({done_cnt}/{total})"
            elif cancel_cnt == total:
                status_text = f"Abgebrochen ({total} Titel)"
            else:
                status_text = f"Unvollständig ({done_cnt}/{total} fertig)"
        elif active_cnt > 0:
            status_text = f"Rippt / Konvertiert ({done_cnt}/{total} fertig)"
        else:
            status_text = f"Warteschlange ({total} Titel)"

        self.batch_store.set_value(group_iter, 1, cd_badge)
        self.batch_store.set_value(group_iter, 2, title_markup)
        self.batch_store.set_value(group_iter, 3, f"{total} Titel")
        self.batch_store.set_value(group_iter, 4, dur_str)
        self.batch_store.set_value(
            group_iter,
            5,
            f"<span size='small' style='italic'>{GLib.markup_escape_text(status_text)}</span>",
        )
        self.batch_store.set_value(group_iter, 6, avg_pct)
        self.batch_store.set_value(group_iter, 7, f"{avg_pct}%")

        # Nur vollständig fertiggestellte Alben (alle Titel DONE) automatisch einklappen
        was_completed = self._batch_group_was_completed.get(group_id, False)
        group_path = self.batch_store.get_path(group_iter)
        if all_done and not was_completed:
            self._batch_group_was_completed[group_id] = True
            if group_path is not None:
                self.batch_treeview.collapse_row(group_path)
        elif not all_done and was_completed:
            self._batch_group_was_completed[group_id] = False
            if group_path is not None:
                self.batch_treeview.expand_row(group_path, False)

    def _append_batch_row(self, job: BatchJob) -> None:
        eff_disc = max(1, int(getattr(job.track, "disc_number", job.album.disc_number) or 1))
        disc_tracks = [
            t
            for t in job.album.tracks
            if max(1, int(getattr(t, "disc_number", 1) or 1)) == eff_disc
        ]
        disc_total = len(disc_tracks) if disc_tracks else len(job.album.tracks)
        is_multi = (
            max(1, int(getattr(job.album, "total_discs", 1) or 1)) > 1
            or len({max(1, int(getattr(t, "disc_number", 1) or 1)) for t in job.album.tracks}) > 1
        )
        track_num_str = format_index_number(job.track.track_number, disc_total)
        num_str = f"CD{eff_disc}·{track_num_str}" if is_multi else track_num_str
        artist_str = normalize_multi_artist(job.track.artist or job.album.artist)
        title_escaped = GLib.markup_escape_text(job.track.title or "")
        artist_escaped = GLib.markup_escape_text(artist_str or "")
        title_artist_markup = f"{title_escaped}\n<span size='small' style='italic'>{artist_escaped}</span>"
        status_escaped = GLib.markup_escape_text(job.status_message or "")
        status_markup = f"<span size='small' style='italic'>{status_escaped}</span>"
        pct = int(round(max(0.0, min(1.0, job.progress)) * 100))

        gid = job.group_id or f"{job.album.artist}::{job.album.title}::disc{eff_disc}"
        job.group_id = gid
        group_iter = self._batch_group_iters.get(gid)
        created_group = False
        if group_iter is None or not self.batch_store.iter_is_valid(group_iter):
            # Neueste CD-Gruppe immer ganz oben einfügen (umgekehrte Reihenfolge)
            group_iter = self.batch_store.prepend(
                None,
                [gid, "CD", "", "", "0:00", "", 0, "0%", True],
            )
            self._batch_group_iters[gid] = group_iter
            self._batch_group_jobs[gid] = []
            self._batch_group_was_completed[gid] = False
            created_group = True

        self._batch_group_jobs.setdefault(gid, []).append(job)
        tree_iter = self.batch_store.append(
            group_iter,
            [
                job.job_id,
                num_str,
                title_artist_markup,
                job.album.title,
                job.track.duration_formatted,
                status_markup,
                pct,
                f"{pct}%",
                False,
            ],
        )
        self._job_iters[job.job_id] = tree_iter
        self._refresh_batch_group_row(gid)
        if created_group:
            # Default während des Ripps: CD-Gruppe ausgeklappt
            group_path = self.batch_store.get_path(group_iter)
            if group_path is not None:
                self.batch_treeview.expand_row(group_path, False)

    def _on_batch_job_updated(self, job: BatchJob) -> bool:
        tree_iter = self._job_iters.get(job.job_id)
        if tree_iter is not None and self.batch_store.iter_is_valid(tree_iter):
            pct = int(round(max(0.0, min(1.0, job.progress)) * 100))
            status_escaped = GLib.markup_escape_text(f"{job.stage.value}: {job.status_message}")
            self.batch_store.set_value(
                tree_iter, 5, f"<span size='small' style='italic'>{status_escaped}</span>"
            )
            self.batch_store.set_value(tree_iter, 6, pct)
            self.batch_store.set_value(tree_iter, 7, f"{pct}%")
        if job.group_id:
            self._refresh_batch_group_row(job.group_id)
        prev_stage = self._job_last_stage.get(job.job_id)
        if prev_stage != job.stage.value:
            self._job_last_stage[job.job_id] = job.stage.value
            self._append_query_log_ui(
                f"[Stapelverarbeitung] Titel #{job.track.track_number:02d} „{job.track.title}“ → {job.stage.value}: {job.status_message}"
            )
        if self._batch_running and not self.batch_manager.has_active_jobs():
            self._batch_running = False
            self._batch_paused = False
            self._active_display = "tracks"
            self._update_workspace_visibility_and_locks()
            self._append_query_log_ui(
                "[Stapelverarbeitung] Alle Aufträge abgeschlossen – Bedienelemente entsperrt & Titelverwaltung ausgeklappt."
            )
            if self.settings.eject_after_rip:
                phys_job = next(
                    (
                        j
                        for j in self.batch_manager.jobs
                        if j.track.source_file is None and j.stage == BatchStage.DONE
                    ),
                    None,
                )
                if phys_job is not None:
                    self._append_query_log_ui(
                        f"[Laufwerk] Physische Audio-CD ({phys_job.device_path or self._get_selected_drive()}) nach Abschluss automatisch ausgeworfen."
                    )
                    GLib.timeout_add(
                        1200,
                        lambda: (self._refresh_cd_tray_state_async(), False)[1],
                    )
                else:
                    self._append_query_log_ui(
                        "[Laufwerk] Automatischer CD-Auswurf übersprungen (importiertes Album ohne physischen Datenträger)."
                    )
        return False

    def _on_clear_finished_batch_clicked(self, _btn: Gtk.Button) -> None:
        to_remove: list[str] = []
        for job_id, tree_iter in list(self._job_iters.items()):
            if not self.batch_store.iter_is_valid(tree_iter):
                to_remove.append(job_id)
                continue
            status_text = self.batch_store.get_value(tree_iter, 5) or ""
            prog_val = self.batch_store.get_value(tree_iter, 6) or 0
            if (
                prog_val >= 100
                or "Abgebrochen" in status_text
                or "Fertig" in status_text
                or "Erfolgreich" in status_text
            ):
                self.batch_store.remove(tree_iter)
                to_remove.append(job_id)
        removed_set = set(to_remove)
        for jid in to_remove:
            self._job_iters.pop(jid, None)
            self._job_last_stage.pop(jid, None)
        for gid in list(self._batch_group_iters.keys()):
            remaining = [j for j in self._batch_group_jobs.get(gid, []) if j.job_id not in removed_set]
            g_iter = self._batch_group_iters.get(gid)
            if not remaining:
                if g_iter is not None and self.batch_store.iter_is_valid(g_iter):
                    self.batch_store.remove(g_iter)
                self._batch_group_iters.pop(gid, None)
                self._batch_group_jobs.pop(gid, None)
                self._batch_group_was_completed.pop(gid, None)
            else:
                self._batch_group_jobs[gid] = remaining
                self._refresh_batch_group_row(gid)
        self.batch_manager.clear_finished()
        self._update_workspace_visibility_and_locks()
        self._append_query_log_ui(
            f"[Stapelverarbeitung] {len(to_remove)} abgeschlossene/abgebrochene Aufträge aus der Liste entfernt."
        )

    # ------------------------------------------------------------------
    # Modul 4: Musik konvertieren (Einzeldateien & rekursive Ordner)
    # ------------------------------------------------------------------

    def _build_converter_module_page(self) -> Gtk.Widget:
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        vbox.set_border_width(14)

        hdr_box = self._build_module_header_bar(
            "04. Modul",
            "Musik konvertieren",
            "Einzeldateien & ganze Ordner rekursiv importieren und in FLAC, MP3, WAV, Opus, Ogg, M4A oder AIFF umwandeln.",
            "module_convert",
        )
        vbox.pack_start(hdr_box, False, False, 0)
        vbox.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)

        # Zusammenklappbares Display: Quelle importieren & Zielformat (Default: eingeklappt)
        self.conv_setup_display_frame = Gtk.Frame()
        self.conv_setup_display_frame.set_shadow_type(Gtk.ShadowType.IN)
        self.conv_setup_display_frame.get_style_context().add_class("display-box")
        conv_setup_card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        self.conv_setup_summary_btn = Gtk.Button()
        self.conv_setup_summary_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.conv_setup_summary_btn.get_style_context().add_class("display-summary")
        self.conv_setup_summary_btn.get_style_context().add_class("closed-box")
        conv_sum_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        conv_sum_row.pack_start(make_system_icon("module_convert"), False, False, 0)
        conv_sum_title = Gtk.Label()
        conv_sum_title.set_markup("<b>Quelle importieren &amp; Zielformat</b>")
        conv_sum_title.set_xalign(0)
        conv_sum_title.set_ellipsize(Pango.EllipsizeMode.END)
        conv_sum_row.pack_start(conv_sum_title, True, True, 0)
        self.conv_setup_summary_meta_lbl = Gtk.Label(label="")
        self.conv_setup_summary_meta_lbl.get_style_context().add_class("dim-label")
        self.conv_setup_summary_meta_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        conv_sum_row.pack_end(self.conv_setup_summary_meta_lbl, False, False, 4)
        self.conv_setup_toggle_glyph = Gtk.Label(label="+")
        self.conv_setup_toggle_glyph.get_style_context().add_class("display-glyph")
        conv_sum_row.pack_end(self.conv_setup_toggle_glyph, False, False, 0)
        self.conv_setup_summary_btn.add(conv_sum_row)
        self.conv_setup_summary_btn.connect("clicked", lambda _b: self._toggle_converter_setup_display())
        conv_setup_card.pack_start(self.conv_setup_summary_btn, False, False, 0)

        self.conv_setup_header_sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        self.conv_setup_header_sep.set_no_show_all(True)
        self.conv_setup_header_sep.hide()
        conv_setup_card.pack_start(self.conv_setup_header_sep, False, False, 0)

        self.conv_setup_body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.conv_setup_body.set_border_width(10)
        self.conv_setup_body.set_no_show_all(True)
        self.conv_setup_body.hide()

        top_grid = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)

        # Links: Import-Hinweis & Drag & Drop (Import-Button liegt oben in der Toolbar)
        import_frame = Gtk.Frame(label="Quelle importieren (Datei & Ordner rekursiv)")
        import_event = Gtk.EventBox()
        import_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        import_vbox.set_border_width(10)

        import_hint = Gtk.Label(
            label="Import über „Dateien / Ordner importieren“ oben in der Toolbar oder per Drag & Drop in das Fenster bzw. die Dateiliste."
        )
        import_hint.set_line_wrap(True)
        import_hint.set_xalign(0)
        import_hint.get_style_context().add_class("dim-label")
        import_vbox.pack_start(import_hint, False, False, 0)

        drop_hint = Gtk.Label()
        drop_hint.set_markup(
            "<span size='small'>Unterstützt: FLAC · WAV · MP3 · MP2 · AIFF/AIF/AIFC · DSF · TTA · Ogg · Opus · M4A · WV</span>"
        )
        drop_hint.set_line_wrap(True)
        drop_hint.set_xalign(0)
        drop_hint.get_style_context().add_class("dim-label")
        import_vbox.pack_start(drop_hint, False, False, 0)

        import_event.add(import_vbox)
        attach_audio_file_drop_target(import_event, self._on_conv_dropped_paths)
        import_frame.add(import_event)
        top_grid.pack_start(import_frame, True, True, 0)

        # Rechts: Zielformat & Konvertierungsoptionen
        opt_frame = Gtk.Frame(label="Zielformat & Kodierungsoptionen")
        opt_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        opt_vbox.set_border_width(10)

        opt_row1 = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        opt_row1.pack_start(Gtk.Label(label="Zielformat:"), False, False, 0)
        self.conv_format_combo = Gtk.ComboBoxText()
        for fmt_id, fmt_lbl in CONVERTER_TARGET_FORMATS:
            self.conv_format_combo.append(fmt_id, fmt_lbl)
        self.conv_format_combo.set_active_id("flac")
        self.conv_format_combo.connect("changed", lambda _c: self._sync_converter_option_widgets())
        opt_row1.pack_start(self.conv_format_combo, True, True, 0)

        opt_row1.pack_start(Gtk.Label(label="Qualität:"), False, False, 0)
        self.conv_quality_combo = Gtk.ComboBoxText()
        self.conv_quality_combo.connect("changed", lambda _c: self._refresh_converter_setup_summary())
        opt_row1.pack_start(self.conv_quality_combo, True, True, 0)

        opt_row1.pack_start(Gtk.Label(label="ID3v2:"), False, False, 0)
        self.conv_id3_combo = Gtk.ComboBoxText()
        self.conv_id3_combo.append("4", "ID3v2.4")
        self.conv_id3_combo.append("3", "ID3v2.3")
        self.conv_id3_combo.set_active_id(str(self.settings.id3v2_version))
        opt_row1.pack_start(self.conv_id3_combo, False, False, 0)
        opt_vbox.pack_start(opt_row1, False, False, 0)

        opt_row2 = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        self.conv_preserve_structure_chk = Gtk.CheckButton(
            label="Ordnerstruktur rekursiv beibehalten"
        )
        self.conv_preserve_structure_chk.set_active(True)
        opt_row2.pack_start(self.conv_preserve_structure_chk, False, False, 0)

        self.conv_preserve_tags_chk = Gtk.CheckButton(
            label="Metadaten & Coverbild übernehmen"
        )
        self.conv_preserve_tags_chk.set_active(True)
        opt_row2.pack_start(self.conv_preserve_tags_chk, False, False, 0)

        self.conv_normalize_chk = Gtk.CheckButton(
            label=f"EBU-R128 ({self.settings.normalize_target_lufs:.0f} LUFS)"
        )
        self.conv_normalize_chk.set_active(bool(self.settings.normalize_album))
        self.conv_normalize_chk.connect("toggled", lambda _c: self._refresh_converter_setup_summary())
        opt_row2.pack_start(self.conv_normalize_chk, False, False, 0)
        opt_vbox.pack_start(opt_row2, False, False, 0)

        dir_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        dir_row.pack_start(Gtk.Label(label="Zielordner:"), False, False, 0)
        self.conv_outdir_chooser = Gtk.FileChooserButton(
            title="Zielordner für konvertierte Audiodateien wählen",
            action=Gtk.FileChooserAction.SELECT_FOLDER,
        )
        conv_default_out = getattr(
            self.settings, "output_dir_convert", DEFAULT_OUTPUT_DIR_CONVERT
        ).expanduser()
        try:
            conv_default_out.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        if conv_default_out.exists():
            self.conv_outdir_chooser.set_current_folder(str(conv_default_out))
        elif self.settings.output_dir.exists():
            self.conv_outdir_chooser.set_current_folder(str(self.settings.output_dir))
        else:
            self.conv_outdir_chooser.set_current_folder(str(Path.home()))
        dir_row.pack_start(self.conv_outdir_chooser, True, True, 0)
        opt_vbox.pack_start(dir_row, False, False, 0)

        opt_frame.add(opt_vbox)
        top_grid.pack_start(opt_frame, True, True, 0)
        self.conv_setup_body.pack_start(top_grid, False, False, 0)
        conv_setup_card.pack_start(self.conv_setup_body, False, False, 0)
        self.conv_setup_display_frame.add(conv_setup_card)
        vbox.pack_start(self.conv_setup_display_frame, False, False, 0)

        # Aktionsleiste & Fortschritt
        ctrl_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.conv_select_all_chk = Gtk.CheckButton(label="Alle auswählen")
        self.conv_select_all_chk.set_active(True)
        self.conv_select_all_chk.connect("toggled", self._on_conv_select_all_toggled)
        ctrl_row.pack_start(self.conv_select_all_chk, False, False, 0)

        self.conv_summary_label = Gtk.Label(label="0 Dateien geladen")
        self.conv_summary_label.get_style_context().add_class("dim-label")
        ctrl_row.pack_start(self.conv_summary_label, True, True, 0)

        self.conv_start_btn = Gtk.Button()
        self.conv_start_btn.get_style_context().add_class("suggested-action")
        s_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        s_box.pack_start(make_system_icon("start_rip"), False, False, 0)
        s_box.pack_start(Gtk.Label(label="Ausgewählte konvertieren"), False, False, 0)
        self.conv_start_btn.add(s_box)
        self.conv_start_btn.connect("clicked", self._on_conv_start_clicked)
        ctrl_row.pack_end(self.conv_start_btn, False, False, 0)

        self.conv_cancel_btn = Gtk.Button()
        self.conv_cancel_btn.get_style_context().add_class("destructive-action")
        c_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        c_box.pack_start(make_system_icon("stop_batch"), False, False, 0)
        c_box.pack_start(Gtk.Label(label="Abbrechen"), False, False, 0)
        self.conv_cancel_btn.add(c_box)
        self.conv_cancel_btn.set_sensitive(False)
        self.conv_cancel_btn.connect("clicked", self._on_conv_cancel_clicked)
        ctrl_row.pack_end(self.conv_cancel_btn, False, False, 0)

        self.conv_clear_done_btn = Gtk.Button(label="Erledigte entfernen")
        self.conv_clear_done_btn.connect("clicked", self._on_conv_clear_finished_clicked)
        ctrl_row.pack_end(self.conv_clear_done_btn, False, False, 0)

        self.conv_clear_all_btn = Gtk.Button(label="Liste leeren")
        self.conv_clear_all_btn.connect("clicked", self._on_conv_clear_all_clicked)
        ctrl_row.pack_end(self.conv_clear_all_btn, False, False, 0)

        vbox.pack_start(ctrl_row, False, False, 0)

        self.conv_total_progress = Gtk.ProgressBar()
        self.conv_total_progress.set_show_text(True)
        self.conv_total_progress.set_text("0%")
        vbox.pack_start(self.conv_total_progress, False, False, 0)

        # Warteschlangen-Tabelle (Gtk.TreeView)
        # Spalten: 0=job_id, 1=selected(bool), 2=rel_path, 3=tags, 4=format, 5=duration, 6=status, 7=progress(int), 8=pct_text
        self.conv_store = Gtk.ListStore(str, bool, str, str, str, str, str, int, str)
        self.conv_treeview = Gtk.TreeView(model=self.conv_store)
        self.conv_treeview.set_headers_visible(True)
        self.conv_treeview.set_grid_lines(Gtk.TreeViewGridLines.BOTH)

        toggle_rend = Gtk.CellRendererToggle()
        toggle_rend.connect("toggled", self._on_conv_row_toggled)
        col_sel = Gtk.TreeViewColumn("", toggle_rend, active=1)
        col_sel.set_fixed_width(34)
        self.conv_treeview.append_column(col_sel)

        for col_idx, col_title, min_w, expand in (
            (2, "Datei / Rekursiver Pfad", 240, True),
            (3, "Metadaten (Interpret · Titel)", 190, True),
            (4, "Format", 90, False),
            (5, "Dauer", 65, False),
            (6, "Status", 180, True),
        ):
            r = Gtk.CellRendererText()
            r.set_property("ellipsize", Pango.EllipsizeMode.END)
            c = Gtk.TreeViewColumn(col_title, r, text=col_idx)
            c.set_resizable(True)
            c.set_min_width(min_w)
            c.set_expand(expand)
            self.conv_treeview.append_column(c)

        prog_rend = Gtk.CellRendererProgress()
        col_prog = Gtk.TreeViewColumn("Fortschritt", prog_rend, value=7, text=8)
        col_prog.set_min_width(130)
        self.conv_treeview.append_column(col_prog)

        conv_scroll = Gtk.ScrolledWindow()
        conv_scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        conv_scroll.set_shadow_type(Gtk.ShadowType.IN)
        conv_scroll.add(self.conv_treeview)
        attach_audio_file_drop_target(self.conv_treeview, self._on_conv_dropped_paths)
        attach_audio_file_drop_target(conv_scroll, self._on_conv_dropped_paths)
        attach_audio_file_drop_target(vbox, self._on_conv_dropped_paths)
        vbox.pack_start(conv_scroll, True, True, 0)

        self._sync_converter_option_widgets()
        self._refresh_converter_summary()
        return vbox

    def _sync_converter_option_widgets(self) -> None:
        fmt = self.conv_format_combo.get_active_id() or "flac"
        self.conv_quality_combo.remove_all()
        if fmt == "flac":
            for lvl in range(9):
                suffix = " (Schnell)" if lvl == 0 else (" (Standard)" if lvl == 6 else (" (Maximal)" if lvl == 8 else ""))
                self.conv_quality_combo.append(str(lvl), f"Stufe {lvl}{suffix}")
            self.conv_quality_combo.set_active_id(str(self.settings.flac_compression_level))
            self.conv_id3_combo.set_sensitive(False)
        elif fmt == "mp3":
            for qid, qlbl in (
                ("vbr_v0", "VBR V0 (~245 kbps)"),
                ("vbr_v2", "VBR V2 (~190 kbps)"),
                ("cbr_320", "CBR 320 kbps"),
                ("cbr_256", "CBR 256 kbps"),
                ("cbr_192", "CBR 192 kbps"),
            ):
                self.conv_quality_combo.append(qid, qlbl)
            self.conv_quality_combo.set_active_id(self.settings.mp3_quality.value)
            self.conv_id3_combo.set_sensitive(True)
        elif fmt in ("wav", "aiff"):
            self.conv_quality_combo.append("16", "16-Bit PCM (CD)")
            self.conv_quality_combo.append("24", "24-Bit PCM (Studio)")
            self.conv_quality_combo.set_active_id("16")
            self.conv_id3_combo.set_sensitive(True)
        else:
            for kbps in ("320", "256", "192", "160", "128", "96"):
                self.conv_quality_combo.append(kbps, f"{kbps} kbps")
            self.conv_quality_combo.set_active_id("192")
            self.conv_id3_combo.set_sensitive(False)

        for row in self.conv_store:
            jid = row[0]
            job = next((j for j in self.converter_manager.jobs if j.job_id == jid), None)
            if job is not None:
                row[4] = f"{job.source_ext} → {fmt.upper()}"
        self._refresh_converter_setup_summary()

    def _refresh_converter_setup_summary(self) -> None:
        if not hasattr(self, "conv_setup_summary_meta_lbl"):
            return
        fmt = (self.conv_format_combo.get_active_id() or "flac").upper()
        qual_txt = (
            self.conv_quality_combo.get_active_text()
            if hasattr(self, "conv_quality_combo")
            else ""
        ) or ""
        norm_txt = (
            " · EBU-R128"
            if hasattr(self, "conv_normalize_chk") and self.conv_normalize_chk.get_active()
            else ""
        )
        parts = [f"Ziel: {fmt}"]
        if qual_txt:
            parts.append(qual_txt)
        self.conv_setup_summary_meta_lbl.set_text(" · ".join(parts) + norm_txt)

    def _toggle_converter_setup_display(self) -> None:
        self._conv_setup_display_open = not bool(getattr(self, "_conv_setup_display_open", False))
        is_open = self._conv_setup_display_open
        if hasattr(self, "conv_setup_toggle_glyph"):
            self.conv_setup_toggle_glyph.set_text("−" if is_open else "+")
        if hasattr(self, "conv_setup_summary_btn"):
            ctx = self.conv_setup_summary_btn.get_style_context()
            if is_open:
                ctx.remove_class("closed-box")
            else:
                ctx.add_class("closed-box")
        if hasattr(self, "conv_setup_header_sep"):
            self.conv_setup_header_sep.set_no_show_all(not is_open)
            self.conv_setup_header_sep.set_visible(is_open)
        if hasattr(self, "conv_setup_body"):
            if is_open:
                self.conv_setup_body.set_no_show_all(False)
                self.conv_setup_body.show_all()
            else:
                self.conv_setup_body.hide()
                self.conv_setup_body.set_no_show_all(True)

    def _on_conv_add_files_clicked(self, _btn: Gtk.Button) -> None:
        if self._conv_running:
            return
        dialog = Gtk.FileChooserDialog(
            title="Einzelne Audiodateien für Konverter auswählen — MintRip Studio",
            transient_for=self,
            action=Gtk.FileChooserAction.OPEN,
        )
        dialog.set_select_multiple(True)
        dialog.add_buttons(
            "Abbrechen",
            Gtk.ResponseType.CANCEL,
            "Importieren",
            Gtk.ResponseType.OK,
        )
        audio_filter = Gtk.FileFilter()
        audio_filter.set_name("Audiodateien (FLAC, WAV, MP3, AIFF, Opus, Ogg, M4A, DSF, TTA)")
        for pat in (
            "*.flac", "*.wav", "*.mp3", "*.mp2", "*.aiff", "*.aif", "*.aifc",
            "*.dsf", "*.tta", "*.ogg", "*.opus", "*.m4a", "*.wv",
        ):
            audio_filter.add_pattern(pat)
            audio_filter.add_pattern(pat.upper())
        dialog.add_filter(audio_filter)
        start_dir = self._resolve_import_start_dir()
        if start_dir.exists():
            dialog.set_current_folder(str(start_dir))
        resp = dialog.run()
        chosen = [Path(p) for p in dialog.get_filenames()] if resp == Gtk.ResponseType.OK else []
        dialog.destroy()
        if chosen:
            self._remember_import_dir(chosen[0], is_dir=False)
            self._append_converter_paths(chosen, "Einzeldatei-Auswahl")

    def _on_conv_add_folder_clicked(self, _btn: Gtk.Button) -> None:
        if self._conv_running:
            return
        dialog = Gtk.FileChooserDialog(
            title="Ordner rekursiv für Konverter auswählen — MintRip Studio",
            transient_for=self,
            action=Gtk.FileChooserAction.SELECT_FOLDER,
        )
        dialog.add_buttons(
            "Abbrechen",
            Gtk.ResponseType.CANCEL,
            "Ordner rekursiv importieren",
            Gtk.ResponseType.OK,
        )
        start_dir = self._resolve_import_start_dir()
        if start_dir.exists():
            dialog.set_current_folder(str(start_dir))
        resp = dialog.run()
        chosen = dialog.get_filename() if resp == Gtk.ResponseType.OK else None
        dialog.destroy()
        if chosen:
            chosen_dir = Path(chosen)
            self._remember_import_dir(chosen_dir, is_dir=True)
            self._append_converter_paths([chosen_dir], "Rekursiver Ordner-Import")

    def _on_conv_dropped_paths(self, paths: list[Path]) -> None:
        if self._conv_running:
            return
        self._append_converter_paths(paths, "Drag & Drop")

    def _append_converter_paths(self, paths: list[Path], source_label: str) -> None:
        added = self.converter_manager.add_paths(paths)
        target_fmt = (self.conv_format_combo.get_active_id() or "flac").upper()
        for job in added:
            tag_desc = " · ".join(
                p for p in (job.artist or "Unbekannt", job.title, job.album) if p
            )
            dur_str = f"{job.duration_seconds // 60:02d}:{job.duration_seconds % 60:02d}" if job.duration_seconds > 0 else "—"
            tree_iter = self.conv_store.append(
                [
                    job.job_id,
                    job.selected,
                    job.relative_path,
                    tag_desc,
                    f"{job.source_ext} → {target_fmt}",
                    dur_str,
                    job.status_message,
                    0,
                    "0%",
                ]
            )
            self._conv_iters[job.job_id] = tree_iter
        self._refresh_converter_summary()
        self._append_query_log_ui(
            f"[Konverter] {len(added)} Audiodatei(en) über „{source_label}“ importiert."
        )

    def _on_conv_row_toggled(self, _cell: Gtk.CellRendererToggle, path_str: str) -> None:
        if self._conv_running:
            return
        tree_iter = self.conv_store.get_iter_from_string(path_str)
        if tree_iter is None:
            return
        new_val = not bool(self.conv_store.get_value(tree_iter, 1))
        self.conv_store.set_value(tree_iter, 1, new_val)
        jid = self.conv_store.get_value(tree_iter, 0)
        for job in self.converter_manager.jobs:
            if job.job_id == jid:
                job.selected = new_val
                break
        self._refresh_converter_summary()

    def _on_conv_select_all_toggled(self, chk: Gtk.CheckButton) -> None:
        if self._conv_running:
            return
        active = chk.get_active()
        for row in self.conv_store:
            row[1] = active
        for job in self.converter_manager.jobs:
            job.selected = active
        self._refresh_converter_summary()

    def _refresh_converter_summary(self) -> None:
        total = len(self.converter_manager.jobs)
        sel = sum(1 for j in self.converter_manager.jobs if j.selected)
        done = sum(1 for j in self.converter_manager.jobs if j.stage == "done")
        self.conv_summary_label.set_text(
            f"{total} Dateien · {sel} ausgewählt · {done} fertig"
        )
        if total > 0:
            avg_pct = sum(max(0.0, min(1.0, j.progress)) for j in self.converter_manager.jobs) / total
        else:
            avg_pct = 0.0
        self.conv_total_progress.set_fraction(avg_pct)
        self.conv_total_progress.set_text(f"{int(round(avg_pct * 100))}%")

        self.conv_start_btn.set_sensitive((not self._conv_running) and sel > 0)
        self.conv_cancel_btn.set_sensitive(self._conv_running)
        if hasattr(self, "conv_import_btn"):
            self.conv_import_btn.set_sensitive(not self._conv_running)
        self.conv_clear_done_btn.set_sensitive((not self._conv_running) and done > 0)
        self.conv_clear_all_btn.set_sensitive((not self._conv_running) and total > 0)

    def _on_conv_start_clicked(self, _btn: Gtk.Button) -> None:
        if self._conv_running:
            return
        fmt = self.conv_format_combo.get_active_id() or "flac"
        q_val = self.conv_quality_combo.get_active_id() or ""
        out_folder_str = self.conv_outdir_chooser.get_filename() or str(
            getattr(self.settings, "output_dir_convert", DEFAULT_OUTPUT_DIR_CONVERT)
        )
        opts = ConverterOptions(
            output_dir=Path(out_folder_str),
            target_format=fmt,
            flac_level=int(q_val) if (fmt == "flac" and q_val.isdigit()) else self.settings.flac_compression_level,
            mp3_quality=q_val if fmt == "mp3" else self.settings.mp3_quality.value,
            bitrate_kbps=int(q_val) if (fmt in ("opus", "ogg", "m4a") and q_val.isdigit()) else 192,
            pcm_bits=int(q_val) if (fmt in ("wav", "aiff") and q_val.isdigit()) else 16,
            id3v2_version=int(self.conv_id3_combo.get_active_id() or "4"),
            preserve_structure=self.conv_preserve_structure_chk.get_active(),
            preserve_tags=self.conv_preserve_tags_chk.get_active(),
            normalize_audio=self.conv_normalize_chk.get_active(),
            target_lufs=self.settings.normalize_target_lufs,
        )
        try:
            eff_threads = normalize_max_threads(
                getattr(self.settings, "max_threads", DEFAULT_MAX_THREADS)
            )
            count = self.converter_manager.start(opts, max_workers=eff_threads)
        except Exception as exc:
            self._append_query_log_ui(f"[Konverter] Start fehlgeschlagen: {exc}")
            return
        if count > 0:
            self._conv_running = True
            self._refresh_converter_summary()
            self._append_query_log_ui(
                f"[Konverter] Konvertierung von {count} Datei(en) nach {fmt.upper()} gestartet → {opts.output_dir}"
            )

    def _on_conv_cancel_clicked(self, _btn: Gtk.Button) -> None:
        self.converter_manager.cancel_all()
        self._conv_running = False
        self._refresh_converter_summary()
        self._append_query_log_ui("[Konverter] Konvertierung durch Benutzer abgebrochen.")

    def _on_conv_clear_finished_clicked(self, _btn: Gtk.Button) -> None:
        if self._conv_running:
            return
        self.converter_manager.clear_finished()
        keep_ids = {j.job_id for j in self.converter_manager.jobs}
        for jid in list(self._conv_iters.keys()):
            if jid not in keep_ids:
                it = self._conv_iters.pop(jid)
                if self.conv_store.iter_is_valid(it):
                    self.conv_store.remove(it)
        self._refresh_converter_summary()

    def _on_conv_clear_all_clicked(self, _btn: Gtk.Button) -> None:
        if self._conv_running:
            return
        self._reset_converter_cache()
        self._append_query_log_ui("[Konverter] Importliste vollständig geleert.")

    def _reset_converter_cache(self) -> None:
        if hasattr(self, "converter_manager"):
            self.converter_manager.clear_all()
        self._conv_running = False
        if hasattr(self, "conv_store"):
            self.conv_store.clear()
        if hasattr(self, "_conv_iters"):
            self._conv_iters.clear()
        if hasattr(self, "conv_summary_label"):
            self._refresh_converter_summary()

    def _on_conv_job_updated_threadsafe(self, job: ConverterJob) -> None:
        def _apply() -> bool:
            tree_iter = self._conv_iters.get(job.job_id)
            if tree_iter is not None and self.conv_store.iter_is_valid(tree_iter):
                pct = int(round(max(0.0, min(1.0, job.progress)) * 100))
                self.conv_store.set_value(tree_iter, 6, job.status_message)
                self.conv_store.set_value(tree_iter, 7, pct)
                self.conv_store.set_value(tree_iter, 8, f"{pct}%")
            self._refresh_converter_summary()
            return False

        GLib.idle_add(_apply)

    def _on_conv_all_finished_threadsafe(self, was_cancelled: bool) -> None:
        def _done() -> bool:
            self._conv_running = False
            self._refresh_converter_summary()
            self._append_query_log_ui(
                "[Konverter] Stapelkonvertierung abgebrochen."
                if was_cancelled
                else "[Konverter] Stapelkonvertierung vollständig abgeschlossen."
            )
            return False

        GLib.idle_add(_done)

    # ------------------------------------------------------------------
    # Modul 5: Musik reparieren (MP3Diags-orientiert im eigenen MintRip-Design)
    # ------------------------------------------------------------------

    def _build_repair_module_page(self) -> Gtk.Widget:
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        vbox.set_border_width(14)

        hdr_box = self._build_module_header_bar(
            "05. Modul",
            "Musik reparieren",
            "Struktur-, Header- & Firefox-FLAC-Diagnose (MP3 Xing/VBR, Frame-Sync, ID3v2, STREAMINFO/Ogg-FLAC/MD5) & verlustfreie Reparatur.",
            "module_repair",
        )
        vbox.pack_start(hdr_box, False, False, 0)
        vbox.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)

        # Zusammenklappbares Display: Bestand einlesen & Reparatur-Transformationen (Default: eingeklappt)
        self.rep_setup_display_frame = Gtk.Frame()
        self.rep_setup_display_frame.set_shadow_type(Gtk.ShadowType.IN)
        self.rep_setup_display_frame.get_style_context().add_class("display-box")
        rep_setup_card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        self.rep_setup_summary_btn = Gtk.Button()
        self.rep_setup_summary_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.rep_setup_summary_btn.get_style_context().add_class("display-summary")
        self.rep_setup_summary_btn.get_style_context().add_class("closed-box")
        rep_sum_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        rep_sum_row.pack_start(make_system_icon("module_repair"), False, False, 0)
        rep_sum_title = Gtk.Label()
        rep_sum_title.set_markup("<b>Bestand einlesen &amp; Reparatur-Transformationen</b>")
        rep_sum_title.set_xalign(0)
        rep_sum_title.set_ellipsize(Pango.EllipsizeMode.END)
        rep_sum_row.pack_start(rep_sum_title, True, True, 0)
        self.rep_setup_summary_meta_lbl = Gtk.Label(label="")
        self.rep_setup_summary_meta_lbl.get_style_context().add_class("dim-label")
        self.rep_setup_summary_meta_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        rep_sum_row.pack_end(self.rep_setup_summary_meta_lbl, False, False, 4)
        self.rep_setup_toggle_glyph = Gtk.Label(label="+")
        self.rep_setup_toggle_glyph.get_style_context().add_class("display-glyph")
        rep_sum_row.pack_end(self.rep_setup_toggle_glyph, False, False, 0)
        self.rep_setup_summary_btn.add(rep_sum_row)
        self.rep_setup_summary_btn.connect("clicked", lambda _b: self._toggle_repair_setup_display())
        rep_setup_card.pack_start(self.rep_setup_summary_btn, False, False, 0)

        self.rep_setup_header_sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        self.rep_setup_header_sep.set_no_show_all(True)
        self.rep_setup_header_sep.hide()
        rep_setup_card.pack_start(self.rep_setup_header_sep, False, False, 0)

        self.rep_setup_body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.rep_setup_body.set_border_width(10)
        self.rep_setup_body.set_no_show_all(True)
        self.rep_setup_body.hide()

        top_grid = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)

        # Links: Import & Scan-Tiefe
        import_frame = Gtk.Frame(label="Bestand einlesen & analysieren")
        import_event = Gtk.EventBox()
        import_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        import_vbox.set_border_width(10)

        hint_lbl = Gtk.Label(
            label="Prüft MP3-Frames, Xing/VBR-Header, ID3v2-Blöcke sowie Firefox-FLAC-Kompatibilität (≤ 24-Bit/192 kHz, Kanäle, STREAMINFO, Ogg-FLAC, Blockgröße & MD5)."
        )
        hint_lbl.set_line_wrap(True)
        hint_lbl.set_xalign(0)
        hint_lbl.get_style_context().add_class("dim-label")
        import_vbox.pack_start(hint_lbl, False, False, 0)

        dnd_hint = Gtk.Label(
            label="Import über „Dateien oder Ordner importieren“ oben in der Toolbar oder per Drag & Drop in das Fenster bzw. die Dateiliste."
        )
        dnd_hint.set_line_wrap(True)
        dnd_hint.set_xalign(0)
        dnd_hint.get_style_context().add_class("dim-label")
        import_vbox.pack_start(dnd_hint, False, False, 0)

        self.rep_deep_scan_chk = Gtk.CheckButton(
            label="Stufe 2: Deep-Check (Null-Decode für Frame-CRC, Truncation, MD5 & Pegel)"
        )
        self.rep_deep_scan_chk.set_active(True)
        self.rep_deep_scan_chk.connect("toggled", lambda _c: self._refresh_repair_setup_summary())
        import_vbox.pack_start(self.rep_deep_scan_chk, False, False, 0)

        import_event.add(import_vbox)
        attach_audio_file_drop_target(import_event, self._on_rep_dropped_paths)
        import_frame.add(import_event)
        top_grid.pack_start(import_frame, True, True, 0)

        # Rechts: Reparatur-Transformationen
        tr_frame = Gtk.Frame(label="Reparatur-Transformationen (verlustfreier Neuaufbau)")
        tr_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        tr_vbox.set_border_width(10)

        tr_row1 = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=14)
        self.rep_fix_xing_chk = Gtk.CheckButton(label="VBR / Xing / Info-Header neu aufbauen")
        self.rep_fix_xing_chk.set_active(True)
        tr_row1.pack_start(self.rep_fix_xing_chk, False, False, 0)

        self.rep_strip_garbage_chk = Gtk.CheckButton(label="Defekte Sync-Frames & Müll-Bytes entfernen")
        self.rep_strip_garbage_chk.set_active(True)
        tr_row1.pack_start(self.rep_strip_garbage_chk, False, False, 0)
        tr_vbox.pack_start(tr_row1, False, False, 0)

        tr_row2 = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=14)
        self.rep_clean_tags_chk = Gtk.CheckButton(label="Doppelte ID3v2-Header & Tags bereinigen")
        self.rep_clean_tags_chk.set_active(True)
        tr_row2.pack_start(self.rep_clean_tags_chk, False, False, 0)

        self.rep_rebuild_container_chk = Gtk.CheckButton(
            label="FLAC-MD5, Seektable & RIFF/Container korrigieren"
        )
        self.rep_rebuild_container_chk.set_active(True)
        tr_row2.pack_start(self.rep_rebuild_container_chk, False, False, 0)
        tr_vbox.pack_start(tr_row2, False, False, 0)

        tr_row3 = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        cov_max_dim = normalize_cover_max_dimension(
            getattr(self.settings, "cover_max_dimension", DEFAULT_COVER_MAX_DIMENSION)
        )
        self.rep_optimize_cover_chk = Gtk.CheckButton(
            label=f"Cover-Optimierung (≤ {cov_max_dim}×{cov_max_dim} px / ≤ 1 MB)"
        )
        self.rep_optimize_cover_chk.set_active(False)
        self.rep_optimize_cover_chk.connect("toggled", lambda _c: self._refresh_repair_setup_summary())
        tr_row3.pack_start(self.rep_optimize_cover_chk, False, False, 0)

        self.rep_firefox_compat_chk = Gtk.CheckButton(
            label="FLAC-Firefox-Konvertierung (>2ch → Stereo, ≤ 192 kHz/24-Bit)"
        )
        self.rep_firefox_compat_chk.set_active(False)
        self.rep_firefox_compat_chk.connect("toggled", lambda _c: self._refresh_repair_setup_summary())
        tr_row3.pack_start(self.rep_firefox_compat_chk, False, False, 0)
        tr_vbox.pack_start(tr_row3, False, False, 0)

        tr_row4 = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        self.rep_seektable_chk = Gtk.CheckButton(
            label="FLAC-Seektable erzeugen (10s-Sprungmarken)"
        )
        self.rep_seektable_chk.set_active(True)
        self.rep_seektable_chk.set_tooltip_text(
            "Schreibt echte 10-Sekunden-Seekpoints in FLAC-Header für schnelles Spulen (Standard: ein)."
        )
        self.rep_seektable_chk.connect("toggled", lambda _c: self._refresh_repair_setup_summary())
        tr_row4.pack_start(self.rep_seektable_chk, False, False, 0)

        tr_row4.pack_start(Gtk.Label(label="ID3:"), False, False, 0)
        self.rep_id3_combo = Gtk.ComboBoxText()
        self.rep_id3_combo.append("4", "ID3v2.4")
        self.rep_id3_combo.append("3", "ID3v2.3")
        self.rep_id3_combo.set_active_id(str(self.settings.id3v2_version))
        self.rep_id3_combo.connect("changed", lambda _c: self._refresh_repair_setup_summary())
        tr_row4.pack_start(self.rep_id3_combo, False, False, 0)
        tr_vbox.pack_start(tr_row4, False, False, 0)

        out_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        self.rep_backup_chk = Gtk.CheckButton(label="Original mit .bak-Backup direkt ersetzen")
        self.rep_backup_chk.set_active(False)
        self.rep_backup_chk.connect("toggled", lambda _c: self._sync_repair_output_sensitivity())
        out_row.pack_start(self.rep_backup_chk, False, False, 0)
        tr_vbox.pack_start(out_row, False, False, 0)

        tr_frame.add(tr_vbox)
        top_grid.pack_start(tr_frame, True, True, 0)
        self.rep_setup_body.pack_start(top_grid, False, False, 0)
        rep_setup_card.pack_start(self.rep_setup_body, False, False, 0)
        self.rep_setup_display_frame.add(rep_setup_card)
        vbox.pack_start(self.rep_setup_display_frame, False, False, 0)
        self._refresh_repair_setup_summary()

        # Aktions- & Filterleiste (kompaktes Platzmanagement: Alle + Auswahl-Aktionen + Filter + Pipeline-Buttons)
        ctrl_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.rep_select_all_chk = Gtk.CheckButton(label="Alle")
        self.rep_select_all_chk.set_active(False)
        self.rep_select_all_chk.connect("toggled", self._on_rep_select_all_toggled)
        ctrl_row.pack_start(self.rep_select_all_chk, False, False, 0)

        self.rep_activate_selected_btn = Gtk.Button(label="Markierte Dateien aktivieren")
        self.rep_activate_selected_btn.get_style_context().add_class("suggested-action")
        self.rep_activate_selected_btn.set_tooltip_text(
            "Aktiviert die Checkboxen aller per Klick / Strg+Klick / Shift+Klick markierten Dateien"
        )
        self.rep_activate_selected_btn.set_sensitive(False)
        self.rep_activate_selected_btn.connect(
            "clicked", self._on_rep_activate_highlighted_clicked
        )
        ctrl_row.pack_start(self.rep_activate_selected_btn, False, False, 0)

        self.rep_clear_sel_btn = Gtk.Button(label="Markierung aufheben")
        self.rep_clear_sel_btn.set_tooltip_text("Hebt die aktuelle Zeilenmarkierung auf")
        self.rep_clear_sel_btn.set_sensitive(False)
        self.rep_clear_sel_btn.connect("clicked", self._on_rep_clear_highlight_clicked)
        ctrl_row.pack_start(self.rep_clear_sel_btn, False, False, 0)

        self.rep_filter_combo = Gtk.ComboBoxText()
        self.rep_filter_combo.append("all", "Filter: Alle Dateien")
        self.rep_filter_combo.append("issues", "Filter: Mit Problemen")
        self.rep_filter_combo.append(
            "hide_clean_folders", "Filter: Fehlerfreie Ordner ausblenden"
        )
        self.rep_filter_combo.append("critical", "Filter: Nur Kritisch")
        self.rep_filter_combo.append("repaired", "Filter: Repariert")
        self.rep_filter_combo.set_active_id("all")
        self.rep_filter_combo.connect("changed", self._on_rep_filter_changed)
        ctrl_row.pack_start(self.rep_filter_combo, False, False, 0)

        self.rep_summary_label = Gtk.Label(label="0 Dateien geprüft")
        self.rep_summary_label.set_xalign(0)
        self.rep_summary_label.set_ellipsize(Pango.EllipsizeMode.END)
        self.rep_summary_label.get_style_context().add_class("dim-label")
        ctrl_row.pack_start(self.rep_summary_label, True, True, 0)

        self.rep_start_btn = Gtk.Button(label="Manuelle Pipeline")
        self.rep_start_btn.connect("clicked", lambda b: self._on_rep_start_clicked(b, False))
        ctrl_row.pack_end(self.rep_start_btn, False, False, 0)

        self.rep_auto_repair_btn = Gtk.Button()
        self.rep_auto_repair_btn.get_style_context().add_class("suggested-action")
        self.rep_auto_repair_btn.set_tooltip_text(
            "Führt gezielt nur die je Datei erkannten Reparatur-Fixes aus (Header-Strip, Faststart, VBR-Rebuild, Cover, Lossless Re-Encode)"
        )
        ar_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        ar_box.pack_start(make_system_icon("module_repair"), False, False, 0)
        ar_box.pack_start(Gtk.Label(label="Auto-Repair (Fehlerklassen)"), False, False, 0)
        self.rep_auto_repair_btn.add(ar_box)
        self.rep_auto_repair_btn.connect("clicked", lambda b: self._on_rep_start_clicked(b, True))
        ctrl_row.pack_end(self.rep_auto_repair_btn, False, False, 0)

        self.rep_cancel_btn = Gtk.Button(label="Abbrechen")
        self.rep_cancel_btn.get_style_context().add_class("destructive-action")
        self.rep_cancel_btn.set_sensitive(False)
        self.rep_cancel_btn.connect("clicked", self._on_rep_cancel_clicked)
        ctrl_row.pack_end(self.rep_cancel_btn, False, False, 0)

        self.rep_clear_btn = Gtk.Button(label="Liste leeren")
        self.rep_clear_btn.connect("clicked", self._on_rep_clear_clicked)
        ctrl_row.pack_end(self.rep_clear_btn, False, False, 0)
        vbox.pack_start(ctrl_row, False, False, 0)

        self.rep_total_progress = Gtk.ProgressBar()
        self.rep_total_progress.set_show_text(True)
        self.rep_total_progress.set_text("0%")
        vbox.pack_start(self.rep_total_progress, False, False, 0)

        # Master-Detail Paned: Links Diagnose-Tabelle (70%) | Rechts Struktur- & Befund-Inspektor (initial 30%, resizable)
        rep_paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self._rep_paned_init_done = False

        def _on_rep_paned_size_allocate(paned: Gtk.Paned, alloc: Gdk.Rectangle) -> None:
            if not self._rep_paned_init_done and alloc.width > 200:
                self._rep_paned_init_done = True
                paned.set_position(max(300, int(round(alloc.width * 0.70))))

        rep_paned.connect("size-allocate", _on_rep_paned_size_allocate)

        # Links: Dateiliste mit Ordner-Abstand, Strg/Shift-Mehrfachauswahl & Audio-Vorschau
        rep_left_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        # Feste Spaltenköpfe identisch zum ursprünglichen Tabellen-Layout
        rep_col_hdr = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        rep_col_hdr.set_margin_start(8)
        rep_col_hdr.set_margin_end(22)
        rep_col_hdr.set_margin_top(4)
        rep_col_hdr.set_margin_bottom(4)

        chk_spacer = Gtk.Box()
        chk_spacer.set_size_request(28, -1)
        rep_col_hdr.pack_start(chk_spacer, False, False, 0)

        sev_spacer = Gtk.Box()
        sev_spacer.set_size_request(14, -1)
        rep_col_hdr.pack_start(sev_spacer, False, False, 0)

        hdr_rep_file = Gtk.Label()
        hdr_rep_file.set_markup("<b>Datei / Rekursiver Pfad</b>")
        hdr_rep_file.set_xalign(0)
        rep_col_hdr.pack_start(hdr_rep_file, True, True, 0)

        hdr_rep_stream = Gtk.Label()
        hdr_rep_stream.set_markup("<b>Stream &amp; Bitrate</b>")
        hdr_rep_stream.set_xalign(0)
        hdr_rep_stream.set_size_request(185, -1)
        rep_col_hdr.pack_start(hdr_rep_stream, False, False, 0)

        hdr_rep_health = Gtk.Label()
        hdr_rep_health.set_markup("<b>Diagnose</b>")
        hdr_rep_health.set_xalign(0.5)
        hdr_rep_health.set_size_request(90, -1)
        rep_col_hdr.pack_start(hdr_rep_health, False, False, 0)

        hdr_rep_status = Gtk.Label()
        hdr_rep_status.set_markup("<b>Befund / Status</b>")
        hdr_rep_status.set_xalign(0)
        hdr_rep_status.set_size_request(210, -1)
        rep_col_hdr.pack_start(hdr_rep_status, False, False, 0)

        hdr_rep_play = Gtk.Label()
        hdr_rep_play.set_markup("<b>Vorhören</b>")
        hdr_rep_play.set_xalign(0.5)
        hdr_rep_play.set_size_request(52, -1)
        rep_col_hdr.pack_start(hdr_rep_play, False, False, 0)

        rep_left_vbox.pack_start(rep_col_hdr, False, False, 0)

        # Virtualisiertes Gtk.Layout mit vrow_idx-gepoolten Gtk.EventBox-Zeilen (ruckelfrei bei 5.000+ Dateien)
        rep_list_frame = Gtk.Frame()
        rep_list_frame.set_shadow_type(Gtk.ShadowType.IN)
        rep_list_hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)

        self.rep_hscroll = Gtk.ScrolledWindow()
        v_policy_external = getattr(Gtk.PolicyType, "EXTERNAL", Gtk.PolicyType.NEVER)
        self.rep_hscroll.set_policy(Gtk.PolicyType.AUTOMATIC, v_policy_external)
        self.rep_hscroll.set_shadow_type(Gtk.ShadowType.NONE)
        self.rep_hscroll.set_min_content_height(180)
        self.rep_hscroll.set_propagate_natural_height(False)
        self.rep_hscroll.add_events(
            Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.SMOOTH_SCROLL_MASK
        )
        self.rep_hscroll.connect("scroll-event", self._on_rep_viewport_scroll_event)
        self.rep_hscroll.connect("size-allocate", self._on_rep_viewport_size_allocate)

        self.rep_layout = Gtk.Layout()
        self.rep_layout.set_can_focus(True)
        self.rep_layout.add_events(
            Gdk.EventMask.SCROLL_MASK
            | Gdk.EventMask.SMOOTH_SCROLL_MASK
            | Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.KEY_PRESS_MASK
        )
        self.rep_layout.connect("scroll-event", self._on_rep_viewport_scroll_event)
        self.rep_layout.connect("key-press-event", self._on_rep_layout_key_press)

        self._rep_empty_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        empty_lbl = Gtk.Label(
            label="Noch keine Audiodateien geladen. Nutzen Sie oben „Dateien oder Ordner importieren“ oder ziehen Sie Dateien/Ordner hierher."
        )
        empty_lbl.set_margin_top(28)
        empty_lbl.set_margin_bottom(28)
        empty_lbl.set_margin_start(16)
        empty_lbl.set_margin_end(16)
        empty_lbl.set_line_wrap(True)
        empty_lbl.set_justify(Gtk.Justification.CENTER)
        empty_lbl.get_style_context().add_class("dim-label")
        self._rep_empty_box.pack_start(empty_lbl, False, False, 0)
        self._rep_empty_box.show_all()
        self.rep_layout.put(self._rep_empty_box, 0, 12)

        self.rep_hscroll.add(self.rep_layout)

        self.rep_vadj = Gtk.Adjustment(
            value=0.0,
            lower=0.0,
            upper=1.0,
            step_increment=34.0,
            page_increment=240.0,
            page_size=1.0,
        )
        self.rep_vadj.connect("value-changed", self._on_rep_vadj_value_changed)
        self.rep_vscroll = Gtk.Scrollbar(
            orientation=Gtk.Orientation.VERTICAL, adjustment=self.rep_vadj
        )

        rep_list_hbox.pack_start(self.rep_hscroll, True, True, 0)
        rep_list_hbox.pack_start(self.rep_vscroll, False, False, 0)
        rep_list_frame.add(rep_list_hbox)
        rep_left_vbox.pack_start(rep_list_frame, True, True, 0)

        attach_audio_file_drop_target(self.rep_layout, self._on_rep_dropped_paths)
        attach_audio_file_drop_target(self.rep_hscroll, self._on_rep_dropped_paths)
        attach_audio_file_drop_target(vbox, self._on_rep_dropped_paths)
        rep_paned.pack1(rep_left_vbox, resize=True, shrink=False)

        # Rechts: Wiedergabe-Leiste (Slider + Stopp) über dem Struktur- & Befund-Inspektor
        rep_right_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        rep_right_vbox.set_size_request(220, -1)
        rep_right_vbox.set_margin_start(10)
        rep_right_vbox.set_margin_left(10)

        player_frame = Gtk.Frame(label="Wiedergabe")
        player_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        player_vbox.set_border_width(8)

        player_top_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        player_top_row.pack_start(make_system_icon("media_play"), False, False, 0)
        self.rep_player_title_lbl = Gtk.Label()
        self.rep_player_title_lbl.set_markup("<span alpha='70%'>Kein Titel wird abgespielt</span>")
        self.rep_player_title_lbl.set_xalign(0)
        self.rep_player_title_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        player_top_row.pack_start(self.rep_player_title_lbl, True, True, 0)

        self.rep_player_time_lbl = Gtk.Label(label="00:00 / 00:00")
        self.rep_player_time_lbl.get_style_context().add_class("dim-label")
        self.rep_player_time_lbl.get_style_context().add_class("monospace")
        player_top_row.pack_end(self.rep_player_time_lbl, False, False, 0)
        player_vbox.pack_start(player_top_row, False, False, 0)

        player_ctrl_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.rep_player_scale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, 0.0, 1.0, 0.5
        )
        self.rep_player_scale.set_draw_value(False)
        self.rep_player_scale.set_hexpand(True)
        self.rep_player_scale.set_sensitive(False)
        self.rep_player_scale.set_tooltip_text("Wiedergabeposition des aktuellen Titels verschieben")
        self.rep_player_scale.connect("button-press-event", self._on_rep_player_scale_button_press)
        self.rep_player_scale.connect(
            "button-release-event", self._on_rep_player_scale_button_release
        )
        self.rep_player_scale.connect("value-changed", self._on_rep_player_scale_value_changed)
        player_ctrl_row.pack_start(self.rep_player_scale, True, True, 0)

        self.rep_player_stop_btn = Gtk.Button()
        self.rep_player_stop_btn.get_style_context().add_class("destructive-action")
        self.rep_player_stop_btn.set_tooltip_text("Aktuelle Audiowiedergabe stoppen")
        stop_btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=5)
        stop_btn_box.pack_start(make_system_icon("media_stop"), False, False, 0)
        stop_btn_box.pack_start(Gtk.Label(label="Stopp"), False, False, 0)
        self.rep_player_stop_btn.add(stop_btn_box)
        self.rep_player_stop_btn.set_sensitive(False)
        self.rep_player_stop_btn.connect("clicked", lambda _b: self._stop_track_preview(log=True))
        player_ctrl_row.pack_end(self.rep_player_stop_btn, False, False, 0)
        player_vbox.pack_start(player_ctrl_row, False, False, 0)

        player_frame.add(player_vbox)
        rep_right_vbox.pack_start(player_frame, False, False, 0)

        insp_frame = Gtk.Frame(label="Diagnose-Inspektor (Stream, Tags & Befunde)")
        insp_scroll = Gtk.ScrolledWindow()
        insp_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.rep_inspector_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.rep_inspector_box.set_border_width(10)
        insp_scroll.add(self.rep_inspector_box)
        insp_frame.add(insp_scroll)
        rep_right_vbox.pack_start(insp_frame, True, True, 0)

        rep_paned.pack2(rep_right_vbox, resize=True, shrink=False)
        vbox.pack_start(rep_paned, True, True, 0)

        self._render_repair_inspector(None)
        self._refresh_repair_summary()
        return vbox

    def _sync_repair_output_sensitivity(self) -> None:
        pass

    def _on_rep_add_files_clicked(self, _btn: Gtk.Button) -> None:
        if self._repair_busy or self._repair_loading:
            return
        dialog = Gtk.FileChooserDialog(
            title="Audiodateien zur Diagnose auswählen — MintRip Studio",
            transient_for=self,
            action=Gtk.FileChooserAction.OPEN,
        )
        dialog.set_select_multiple(True)
        dialog.add_buttons("Abbrechen", Gtk.ResponseType.CANCEL, "Prüfen", Gtk.ResponseType.OK)
        start_dir = self._resolve_import_start_dir()
        if start_dir.exists():
            dialog.set_current_folder(str(start_dir))
        resp = dialog.run()
        chosen = [Path(p) for p in dialog.get_filenames()] if resp == Gtk.ResponseType.OK else []
        dialog.destroy()
        if chosen:
            self._remember_import_dir(chosen[0], is_dir=False)
            self._append_repair_paths(chosen, "Einzeldatei-Auswahl")

    def _on_rep_add_folder_clicked(self, _btn: Gtk.Button) -> None:
        if self._repair_busy or self._repair_loading:
            return
        dialog = Gtk.FileChooserDialog(
            title="Ordner rekursiv auf Audiofehler scannen — MintRip Studio",
            transient_for=self,
            action=Gtk.FileChooserAction.SELECT_FOLDER,
        )
        dialog.add_buttons(
            "Abbrechen", Gtk.ResponseType.CANCEL, "Rekursiv scannen", Gtk.ResponseType.OK
        )
        start_dir = self._resolve_import_start_dir()
        if start_dir.exists():
            dialog.set_current_folder(str(start_dir))
        resp = dialog.run()
        chosen = dialog.get_filename() if resp == Gtk.ResponseType.OK else None
        dialog.destroy()
        if chosen:
            chosen_dir = Path(chosen)
            self._remember_import_dir(chosen_dir, is_dir=True)
            self._append_repair_paths([chosen_dir], "Rekursiver Ordner-Scan")

    def _on_rep_dropped_paths(self, paths: list[Path]) -> None:
        if self._repair_busy or self._repair_loading:
            self._append_query_log_ui(
                "[Reparatur] Import ignoriert: Ladevorgang oder Diagnose läuft bereits."
            )
            return
        self._append_repair_paths(paths, "Drag & Drop")

    def _append_repair_paths(self, paths: list[Path], source_label: str) -> None:
        if self._repair_busy or self._repair_loading:
            return
        # Vorherige Liste beim Laden über Import-Buttons oder Drag & Drop immer zuerst leeren
        self._reset_repair_cache()
        # Filter beim Importieren von Dateien oder Ordnern automatisch auf Standard ("all") zurücksetzen
        self._repair_filter = "all"
        if hasattr(self, "rep_filter_combo") and self.rep_filter_combo.get_active_id() != "all":
            self.rep_filter_combo.set_active_id("all")
        cancel_ev = threading.Event()
        self._repair_load_cancel = cancel_ev
        self._repair_loading = True
        self._repair_loading_count = 0
        self._repair_loading_source = source_label
        self.repair_manager.set_loading(True)
        self._refresh_repair_summary()
        self._append_query_log_ui(
            f"[Reparatur] Lade Dateien über „{source_label}“... (Analyse startet erst nach vollständigem Laden)"
        )

        last_progress_ts = [0.0]

        def _on_load_progress(cnt: int) -> None:
            now = time.monotonic()
            if now - last_progress_ts[0] < 0.15:
                return
            last_progress_ts[0] = now

            def _ui_prog() -> bool:
                if self._repair_loading:
                    self._repair_loading_count = cnt
                    self._refresh_repair_summary()
                return False

            GLib.idle_add(_ui_prog)

        def _load_worker() -> None:
            prepared: list[RepairJob] = []
            load_err: Optional[Exception] = None
            try:
                prepared = self.repair_manager.build_jobs_for_paths(
                    paths, cancel_event=cancel_ev, on_progress=_on_load_progress
                )
            except Exception as exc:
                load_err = exc

            def _finish_loading_phase() -> bool:
                self._repair_loading = False
                self._repair_load_cancel = None
                self.repair_manager.set_loading(False)

                if cancel_ev.is_set():
                    self._refresh_repair_summary()
                    self._append_query_log_ui(
                        "[Reparatur] Dateiladen durch Benutzer abgebrochen."
                    )
                    return False

                if load_err is not None:
                    self._refresh_repair_summary()
                    self._append_query_log_ui(
                        f"[Reparatur] Fehler beim Laden über „{source_label}“: {load_err}"
                    )
                    return False

                added = self.repair_manager.commit_loaded_jobs(prepared)
                if not added:
                    self._refresh_repair_summary()
                    self._append_query_log_ui(
                        f"[Reparatur] Keine neuen unterstützten Dateien über „{source_label}“ gefunden."
                    )
                    return False

                # Phase 2 erst nach vollständigem Laden, Widget-Aufbau & UI-Redraw starten
                self._repair_busy = True
                self._rebuild_repair_tree_rows()
                self._refresh_repair_summary()
                while Gtk.events_pending():
                    Gtk.main_iteration_do(False)
                self._append_query_log_ui(
                    f"[Reparatur] Alle {len(added)} Datei(en) über „{source_label}“ vollständig geladen · Starte Diagnose..."
                )

                deep_enabled = self.rep_deep_scan_chk.get_active()
                cov_max_dim = normalize_cover_max_dimension(
                    getattr(self.settings, "cover_max_dimension", DEFAULT_COVER_MAX_DIMENSION)
                )

                def _start_analysis_after_commit() -> bool:
                    if self._repair_loading or not self._repair_busy:
                        return False
                    eff_threads = normalize_max_threads(
                        getattr(self.settings, "max_threads", DEFAULT_MAX_THREADS)
                    )
                    started = self.repair_manager.start_scan(
                        added,
                        deep_enabled,
                        cover_max_dimension=cov_max_dim,
                        max_workers=eff_threads,
                    )
                    if started <= 0:
                        self._repair_busy = False
                        self._refresh_repair_summary()
                    return False

                GLib.timeout_add(120, _start_analysis_after_commit)
                return False

            GLib.idle_add(_finish_loading_phase)

        threading.Thread(target=_load_worker, daemon=True).start()

    def _get_repair_severity_indicator(self, job: RepairJob) -> tuple[str, str]:
        if job.health in ("pending", "scanning"):
            return ("#94A3B8", "Wartet / Prüfung läuft")
        ff = job.structure.flac_firefox_compatible if job.structure else None
        has_crit = (
            job.health in ("critical", "error")
            or any(f.severity == "critical" for f in job.findings)
            or ff == "incompatible"
        )
        if has_crit:
            return ("#DC2626", "Defekt / nicht abspielbar")
        has_warn = (
            job.health == "warning"
            or any(f.severity == "warning" for f in job.findings)
            or ff == "warning"
        )
        if has_warn:
            return ("#F97316", "Warnung / eingeschränkt kompatibel")
        has_info = any(f.severity == "info" for f in job.findings)
        if has_info:
            return ("#EAB308", "Hinweis / kleine Abweichung")
        return ("#22C55E", "OK")

    @staticmethod
    def _get_repair_job_rel_dir(job: RepairJob) -> str:
        rel_norm = str(job.relative_path or "").replace("\\", "/").lstrip("/")
        idx = rel_norm.rfind("/")
        return rel_norm[:idx] if idx > 0 else ""

    @staticmethod
    def _is_repair_job_completely_clean(job: RepairJob) -> bool:
        """True nur wenn der Track fertig geprüft und absolut fehlerfrei ist (0 Befunde, kein Hinweis/Warnung/Fehler)."""
        if job.health not in ("ok", "repaired"):
            return False
        if job.findings:
            return False
        ff = job.structure.flac_firefox_compatible if job.structure else None
        if ff in ("incompatible", "warning"):
            return False
        return True

    def _get_visible_repair_jobs(self) -> list[RepairJob]:
        filt = getattr(self, "_repair_filter", "all")
        if filt == "hide_clean_folders":
            by_dir: dict[str, list[RepairJob]] = {}
            for job in self.repair_manager.jobs:
                dkey = self._get_repair_job_rel_dir(job)
                by_dir.setdefault(dkey, []).append(job)
            clean_dirs = {
                dkey
                for dkey, dir_jobs in by_dir.items()
                if dir_jobs and all(self._is_repair_job_completely_clean(j) for j in dir_jobs)
            }
            return [
                job
                for job in self.repair_manager.jobs
                if self._get_repair_job_rel_dir(job) not in clean_dirs
            ]
        visible: list[RepairJob] = []
        for job in self.repair_manager.jobs:
            if filt == "issues" and job.health not in ("warning", "critical", "error"):
                continue
            if filt == "critical" and job.health not in ("critical", "error"):
                continue
            if (
                filt == "repaired"
                and job.health != "repaired"
                and not (job.output_path is not None and job.output_path.exists())
            ):
                continue
            visible.append(job)
        return visible

    @staticmethod
    def _repair_severity_rgb(color_hex: str) -> tuple[float, float, float]:
        palette = {
            "#DC2626": (0.863, 0.149, 0.149),
            "#F97316": (0.976, 0.451, 0.086),
            "#EAB308": (0.918, 0.702, 0.031),
            "#22C55E": (0.133, 0.773, 0.369),
            "#94A3B8": (0.580, 0.639, 0.722),
        }
        return palette.get(color_hex, (0.580, 0.639, 0.722))

    def _create_pooled_repair_slot(self) -> dict:
        row = Gtk.EventBox()
        row.set_visible_window(True)
        row.set_above_child(False)
        row.add_events(
            Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.SCROLL_MASK
            | Gdk.EventMask.SMOOTH_SCROLL_MASK
            | Gdk.EventMask.ENTER_NOTIFY_MASK
            | Gdk.EventMask.LEAVE_NOTIFY_MASK
        )

        container = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        row.add(container)

        # 1) Transparenter Ordner-Abstand
        spacer_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        spacer_box.set_size_request(-1, self._rep_spacer_h)
        spacer_box.set_no_show_all(True)
        container.pack_start(spacer_box, False, False, 0)

        # 2) Ordner-Gruppenkopf (Checkbox + Ordner-Icon + Pfad + Dateizähler)
        folder_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        folder_box.get_style_context().add_class("cd-section-header")
        folder_chk = Gtk.CheckButton()
        folder_icon = make_system_icon("music_folder", pixel_size=14)
        folder_dir_lbl = Gtk.Label()
        folder_dir_lbl.set_xalign(0)
        folder_dir_lbl.set_single_line_mode(True)
        folder_dir_lbl.set_width_chars(18)
        folder_dir_lbl.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        folder_cnt_lbl = Gtk.Label()
        folder_cnt_lbl.set_single_line_mode(True)
        folder_cnt_lbl.get_style_context().add_class("dim-label")

        folder_box.pack_start(folder_chk, False, False, 0)
        folder_box.pack_start(folder_icon, False, False, 0)
        folder_box.pack_start(folder_dir_lbl, True, True, 0)
        folder_box.pack_end(folder_cnt_lbl, False, False, 4)
        folder_box.show_all()
        folder_box.set_no_show_all(True)
        folder_box.hide()
        container.pack_start(folder_box, False, False, 0)

        # 3) Einzeldatei-Zeile (exakte Spalten & echter Play/Stop-Button)
        file_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        file_box.set_margin_top(2)
        file_box.set_margin_bottom(2)
        file_box.set_margin_start(6)
        file_box.set_margin_end(6)

        chk = Gtk.CheckButton()
        chk.set_size_request(28, -1)
        chk.set_valign(Gtk.Align.CENTER)

        sev_area = Gtk.DrawingArea()
        sev_area.set_size_request(14, 22)
        sev_area.set_valign(Gtk.Align.CENTER)

        file_lbl = Gtk.Label()
        file_lbl.set_xalign(0)
        file_lbl.set_single_line_mode(True)
        file_lbl.set_width_chars(22)
        file_lbl.set_ellipsize(Pango.EllipsizeMode.MIDDLE)

        stream_lbl = Gtk.Label()
        stream_lbl.set_xalign(0)
        stream_lbl.set_single_line_mode(True)
        stream_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        stream_lbl.set_size_request(185, -1)

        health_lbl = Gtk.Label()
        health_lbl.set_xalign(0.5)
        health_lbl.set_single_line_mode(True)
        health_lbl.set_size_request(90, -1)

        status_lbl = Gtk.Label()
        status_lbl.set_xalign(0)
        status_lbl.set_single_line_mode(True)
        status_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        status_lbl.set_size_request(210, -1)

        play_wrap = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        play_wrap.set_size_request(52, -1)
        play_btn = Gtk.Button()
        play_btn.get_style_context().add_class("flat")
        play_icon_img = make_system_icon("media_play", pixel_size=14)
        play_btn.add(play_icon_img)
        play_wrap.pack_start(play_btn, True, False, 0)

        file_box.pack_start(chk, False, False, 0)
        file_box.pack_start(sev_area, False, False, 0)
        file_box.pack_start(file_lbl, True, True, 0)
        file_box.pack_start(stream_lbl, False, False, 0)
        file_box.pack_start(health_lbl, False, False, 0)
        file_box.pack_start(status_lbl, False, False, 0)
        file_box.pack_start(play_wrap, False, False, 0)
        file_box.show_all()
        file_box.set_no_show_all(True)
        file_box.hide()
        container.pack_start(file_box, False, False, 0)

        container.show()
        row.set_no_show_all(True)
        row.hide()

        slot = {
            "row": row,
            "vrow_idx": -1,
            "last_w": -1,
            "last_y": -999999,
            "mode": "",
            "dir_key": "",
            "job_id": "",
            "syncing": False,
            "sev_rgb": (0.580, 0.639, 0.722),
            "spacer_box": spacer_box,
            "folder_box": folder_box,
            "folder_chk": folder_chk,
            "folder_dir_lbl": folder_dir_lbl,
            "folder_cnt_lbl": folder_cnt_lbl,
            "file_box": file_box,
            "chk": chk,
            "sev_area": sev_area,
            "file_lbl": file_lbl,
            "stream_lbl": stream_lbl,
            "health_lbl": health_lbl,
            "status_lbl": status_lbl,
            "play_btn": play_btn,
            "play_icon_img": play_icon_img,
        }

        def _on_draw_sev(widget: Gtk.DrawingArea, cr) -> bool:
            r, g, b = slot["sev_rgb"]
            alloc = widget.get_allocation()
            bar_w = 10.0
            bar_h = 20.0
            x = max(0.0, (alloc.width - bar_w) * 0.5)
            y = max(0.0, (alloc.height - bar_h) * 0.5)
            rad = 2.5
            cr.new_sub_path()
            cr.arc(x + bar_w - rad, y + rad, rad, -1.5707963, 0.0)
            cr.arc(x + bar_w - rad, y + bar_h - rad, rad, 0.0, 1.5707963)
            cr.arc(x + rad, y + bar_h - rad, rad, 1.5707963, 3.1415927)
            cr.arc(x + rad, y + rad, rad, 3.1415927, 4.7123890)
            cr.close_path()
            cr.set_source_rgb(r, g, b)
            cr.fill()
            return False

        sev_area.connect("draw", _on_draw_sev)

        def _on_file_chk_toggled(btn: Gtk.CheckButton) -> None:
            if slot["syncing"] or slot["mode"] != "file":
                return
            if self._repair_busy or self._repair_loading:
                job = self._repair_jobs_by_id.get(slot["job_id"])
                slot["syncing"] = True
                try:
                    btn.set_active(bool(job.selected) if job else False)
                finally:
                    slot["syncing"] = False
                return
            job = self._repair_jobs_by_id.get(slot["job_id"])
            if job is None:
                return
            job.selected = btn.get_active()
            self._sync_single_repair_folder_row(self._get_repair_job_rel_dir(job))
            self._refresh_repair_summary(sync_folders=False)

        chk.connect("toggled", _on_file_chk_toggled)

        def _on_folder_toggled(_chk: Gtk.CheckButton) -> None:
            if slot["syncing"] or slot["mode"] != "folder":
                return
            self._toggle_single_repair_folder(slot["dir_key"])

        folder_chk.connect("toggled", _on_folder_toggled)

        def _on_play_clicked(_btn: Gtk.Button) -> None:
            if slot["mode"] != "file":
                return
            job = self._repair_jobs_by_id.get(slot["job_id"])
            if job is not None:
                self._on_toggle_repair_preview_clicked(job)

        play_btn.connect("clicked", _on_play_clicked)
        row.connect("button-press-event", self._on_rep_slot_button_press, slot)
        self.rep_layout.put(row, 0, -500)
        self._rep_all_slots.append(slot)

        if not self._rep_row_heights_measured:
            self._rep_row_heights_measured = True
            folder_dir_lbl.set_markup("<b>Ordner</b>")
            folder_cnt_lbl.set_text("0/0 Dateien")
            file_lbl.set_text("01_track.flac")
            stream_lbl.set_text("FLAC · 44.1 kHz · VBR")
            health_lbl.set_text("OK")
            status_lbl.set_text("Fehlerfrei")

            row.set_size_request(-1, -1)
            rctx = row.get_style_context()
            rctx.add_class("cd-section-row")
            folder_box.show()
            row.show()
            _mfh, nat_fh = row.get_preferred_height()
            folder_box.hide()
            rctx.remove_class("cd-section-row")

            rctx.add_class("repair-file-row")
            file_box.show()
            _mih, nat_ih = row.get_preferred_height()
            file_box.hide()
            rctx.remove_class("repair-file-row")
            row.hide()

            self._rep_folder_h = max(38, int(nat_fh))
            self._rep_file_h = max(32, int(nat_ih))

        folder_box.set_size_request(-1, self._rep_folder_h)
        file_box.set_size_request(-1, max(28, self._rep_file_h - 1))
        return slot

    def _sync_repair_slot_play_button(
        self, slot: dict, job: Optional[RepairJob]
    ) -> None:
        is_play = job is not None and self._playing_repair_job_id == job.job_id
        play_btn = slot["play_btn"]
        pctx = play_btn.get_style_context()
        if is_play:
            pctx.add_class("suggested-action")
        else:
            pctx.remove_class("suggested-action")
        icon_name = resolve_system_icon_name("media_stop" if is_play else "media_play")
        slot["play_icon_img"].set_from_icon_name(icon_name, Gtk.IconSize.MENU)
        if job is not None:
            play_btn.set_tooltip_text(
                f"Wiedergabe von „{job.relative_path}“ stoppen"
                if is_play
                else f"„{job.relative_path}“ zum Reinhören abspielen"
            )

    def _bind_spacer_slot(self, slot: dict) -> None:
        slot["mode"] = "spacer"
        slot["dir_key"] = ""
        slot["job_id"] = ""
        slot["last_w"] = self._rep_content_w
        slot["row"].set_size_request(self._rep_content_w, self._rep_spacer_h)
        rctx = slot["row"].get_style_context()
        rctx.remove_class("cd-section-row")
        rctx.remove_class("repair-file-row")
        rctx.remove_class("highlighted")
        rctx.add_class("repair-spacer-row")
        slot["row"].set_tooltip_text(None)
        slot["folder_box"].hide()
        slot["file_box"].hide()
        slot["spacer_box"].show()
        slot["row"].show()

    def _bind_folder_slot(self, slot: dict, dir_key: str, folder_label: str) -> None:
        slot["mode"] = "folder"
        slot["dir_key"] = dir_key
        slot["job_id"] = ""
        slot["last_w"] = self._rep_content_w
        slot["row"].set_size_request(self._rep_content_w, self._rep_folder_h)
        rctx = slot["row"].get_style_context()
        rctx.remove_class("repair-spacer-row")
        rctx.remove_class("repair-file-row")
        rctx.remove_class("highlighted")
        rctx.add_class("cd-section-row")

        job_ids = self._repair_folder_job_ids.get(dir_key, [])
        total_cnt = len(job_ids)
        sel_cnt = sum(
            1
            for jid in job_ids
            if (j := self._repair_jobs_by_id.get(jid)) is not None and j.selected
        )
        all_sel = total_cnt > 0 and sel_cnt == total_cnt
        some_sel = sel_cnt > 0 and not all_sel

        slot["syncing"] = True
        try:
            slot["folder_chk"].set_inconsistent(some_sel)
            slot["folder_chk"].set_active(all_sel)
        finally:
            slot["syncing"] = False

        slot["folder_dir_lbl"].set_markup(
            f"<b>{GLib.markup_escape_text(folder_label)}</b>"
        )
        slot["folder_cnt_lbl"].set_text(
            f"{sel_cnt}/{total_cnt} {'Datei' if total_cnt == 1 else 'Dateien'}"
        )
        slot["folder_chk"].set_tooltip_text(
            f"Alle Dateien in „{folder_label}“ wieder abwählen"
            if all_sel
            else f"Alle {total_cnt} Dateien in „{folder_label}“ per Checkbox aktivieren"
        )
        slot["row"].set_tooltip_text(
            f"Ordner „{folder_label}“ ({total_cnt} Dateien)"
        )
        slot["spacer_box"].hide()
        slot["file_box"].hide()
        slot["folder_box"].show()
        slot["row"].show()

    def _bind_file_slot(self, slot: dict, job: RepairJob) -> None:
        slot["mode"] = "file"
        slot["dir_key"] = ""
        slot["job_id"] = job.job_id
        slot["last_w"] = self._rep_content_w
        slot["row"].set_size_request(self._rep_content_w, self._rep_file_h)
        rctx = slot["row"].get_style_context()
        rctx.remove_class("repair-spacer-row")
        rctx.remove_class("cd-section-row")
        rctx.add_class("repair-file-row")
        if job.job_id in self._rep_highlighted_ids:
            rctx.add_class("highlighted")
        else:
            rctx.remove_class("highlighted")

        vals = self._format_repair_row_values(job)
        new_rgb = self._repair_severity_rgb(vals[7])
        rgb_changed = new_rgb != slot["sev_rgb"]
        slot["sev_rgb"] = new_rgb
        slot["sev_area"].set_tooltip_text(vals[8])
        if rgb_changed:
            slot["sev_area"].queue_draw()

        slot["syncing"] = True
        try:
            slot["chk"].set_active(bool(job.selected))
        finally:
            slot["syncing"] = False

        slot["file_lbl"].set_text(vals[2])
        slot["stream_lbl"].set_text(vals[3])
        slot["health_lbl"].set_text(vals[4])
        slot["status_lbl"].set_text(vals[5])
        slot["row"].set_tooltip_text(f"{job.relative_path} — {vals[5]}")
        self._sync_repair_slot_play_button(slot, job)

        slot["spacer_box"].hide()
        slot["folder_box"].hide()
        slot["file_box"].show()
        slot["row"].show()

    def _on_rep_viewport_size_allocate(
        self, _widget: Gtk.Widget, alloc: Gdk.Rectangle
    ) -> None:
        w = int(alloc.width)
        h = int(alloc.height)
        if h <= 40 or (
            w == getattr(self, "_last_rep_alloc_w", 0)
            and h == getattr(self, "_last_rep_alloc_h", 0)
        ):
            return
        self._last_rep_alloc_w = w
        self._last_rep_alloc_h = h
        if w > 120:
            self._rep_content_w = max(680, w)
        if getattr(self, "_rep_resize_pending", False):
            return
        self._rep_resize_pending = True

        def _apply_resize() -> bool:
            self._rep_resize_pending = False
            self._sync_rep_scrollbar_and_render(reset_scroll=False)
            return False

        GLib.idle_add(_apply_resize)

    def _on_rep_vadj_value_changed(self, _adj: Gtk.Adjustment) -> None:
        if getattr(self, "_rep_updating_scroll", False):
            return
        self._render_rep_visible_window()

    def _on_rep_viewport_scroll_event(
        self, _widget: Gtk.Widget, event: Gdk.EventScroll
    ) -> bool:
        if not hasattr(self, "rep_vadj") or not self._rep_vrows:
            return False
        step = 34.0 * 3.0
        dy = 0.0
        if event.direction == Gdk.ScrollDirection.UP:
            dy = -step
        elif event.direction == Gdk.ScrollDirection.DOWN:
            dy = step
        elif event.direction == Gdk.ScrollDirection.SMOOTH:
            ok, _dx, sdy = event.get_scroll_deltas()
            if ok and abs(sdy) > 1e-4:
                dy = sdy * step
            else:
                return False
        else:
            return False

        upper = self.rep_vadj.get_upper()
        page = self.rep_vadj.get_page_size()
        max_val = max(0.0, upper - page)
        new_val = max(0.0, min(max_val, self.rep_vadj.get_value() + dy))
        self.rep_vadj.set_value(new_val)
        return True

    def _ensure_rep_job_visible(self, job_id: str) -> None:
        vrow_idx = self._rep_vrow_idx_by_job_id.get(job_id)
        if vrow_idx is None or not hasattr(self, "rep_vadj"):
            return
        row_top = self._rep_vrow_offsets[vrow_idx]
        row_h = self._rep_vrows[vrow_idx]["height"]
        row_bot = row_top + row_h
        scroll_y = int(round(self.rep_vadj.get_value()))
        viewport_h = max(180, int(round(self.rep_vadj.get_page_size())))
        max_val = max(0.0, self.rep_vadj.get_upper() - self.rep_vadj.get_page_size())
        if row_top < scroll_y:
            self.rep_vadj.set_value(max(0.0, min(max_val, float(row_top))))
        elif row_bot > scroll_y + viewport_h:
            self.rep_vadj.set_value(max(0.0, min(max_val, float(row_bot - viewport_h))))

    def _on_rep_layout_key_press(
        self, _widget: Gtk.Widget, event: Gdk.EventKey
    ) -> bool:
        if not self._rep_visible_job_ids:
            return False
        keyval = event.keyval
        is_shift = bool(event.state & Gdk.ModifierType.SHIFT_MASK)
        is_ctrl = bool(event.state & Gdk.ModifierType.CONTROL_MASK)

        if is_ctrl and keyval in (Gdk.KEY_a, Gdk.KEY_A):
            self._rep_highlighted_ids = set(self._rep_visible_job_ids)
            if not self._rep_anchor_id:
                self._rep_anchor_id = self._rep_visible_job_ids[0]
            focus_id = self._current_inspected_repair_id or self._rep_visible_job_ids[-1]
            self._current_inspected_repair_id = focus_id
            self._refresh_visible_highlight_classes()
            self._sync_repair_selection_action_bar()
            self._render_repair_inspector(self._repair_jobs_by_id.get(focus_id))
            return True

        delta = 0
        if keyval == Gdk.KEY_Up:
            delta = -1
        elif keyval == Gdk.KEY_Down:
            delta = 1
        elif keyval == Gdk.KEY_Page_Up:
            delta = -10
        elif keyval == Gdk.KEY_Page_Down:
            delta = 10
        elif keyval == Gdk.KEY_Home:
            delta = -len(self._rep_visible_job_ids)
        elif keyval == Gdk.KEY_End:
            delta = len(self._rep_visible_job_ids)
        else:
            return False

        cur_id = self._current_inspected_repair_id
        cur_pos = self._rep_visible_pos_by_id.get(cur_id, 0) if cur_id else 0
        next_pos = max(0, min(len(self._rep_visible_job_ids) - 1, cur_pos + delta))
        next_id = self._rep_visible_job_ids[next_pos]

        if is_shift and self._rep_anchor_id in self._rep_visible_pos_by_id:
            a_pos = self._rep_visible_pos_by_id[self._rep_anchor_id]
            lo, hi = (a_pos, next_pos) if a_pos <= next_pos else (next_pos, a_pos)
            self._rep_highlighted_ids = set(self._rep_visible_job_ids[lo : hi + 1])
        else:
            self._rep_highlighted_ids = {next_id}
            self._rep_anchor_id = next_id

        self._current_inspected_repair_id = next_id
        self._ensure_rep_job_visible(next_id)
        self._refresh_visible_highlight_classes()
        self._sync_repair_selection_action_bar()
        self._render_repair_inspector(self._repair_jobs_by_id.get(next_id))
        return True

    def _recycle_all_repair_slots(self) -> None:
        self._rep_visible_file_slots.clear()
        self._rep_visible_folder_slots.clear()
        for slot in list(self._rep_active_slots.values()):
            slot["mode"] = ""
            slot["dir_key"] = ""
            slot["job_id"] = ""
            slot["vrow_idx"] = -1
            slot["row"].hide()
            self._rep_free_slots.append(slot)
        self._rep_active_slots.clear()

    def _sync_rep_scrollbar_and_render(
        self, reset_scroll: bool = False, force: bool = False
    ) -> None:
        if not hasattr(self, "rep_vadj") or not hasattr(self, "rep_hscroll"):
            return
        alloc_w = self.rep_hscroll.get_allocated_width()
        alloc_h = self.rep_hscroll.get_allocated_height()
        if alloc_w > 120:
            self._rep_content_w = max(680, alloc_w)
        viewport_h = alloc_h if alloc_h > 40 else 360
        total_h = max(viewport_h, self._rep_total_height)
        max_val = max(0.0, float(self._rep_total_height - viewport_h))
        cur_val = (
            0.0
            if reset_scroll
            else max(0.0, min(max_val, float(self.rep_vadj.get_value())))
        )
        self._rep_updating_scroll = True
        try:
            self.rep_vadj.configure(
                cur_val,
                0.0,
                float(total_h),
                float(self._rep_file_h),
                max(68.0, float(viewport_h) * 0.85),
                float(viewport_h),
            )
        finally:
            self._rep_updating_scroll = False
        self._render_rep_visible_window(force=force)

    def _render_rep_visible_window(self, force: bool = False) -> None:
        if not hasattr(self, "rep_layout"):
            return

        alloc_w = (
            self.rep_hscroll.get_allocated_width()
            if hasattr(self, "rep_hscroll")
            else 0
        )
        alloc_h = (
            self.rep_hscroll.get_allocated_height()
            if hasattr(self, "rep_hscroll")
            else 0
        )
        if alloc_w > 120:
            self._rep_content_w = max(680, alloc_w)
        viewport_h = alloc_h if alloc_h > 40 else 360
        content_w = self._rep_content_w
        self.rep_layout.set_size(content_w, viewport_h)

        if not self._rep_vrows:
            self._recycle_all_repair_slots()
            if hasattr(self, "_rep_empty_box"):
                self._rep_empty_box.set_size_request(content_w, -1)
                self.rep_layout.move(self._rep_empty_box, 0, 12)
                self._rep_empty_box.show()
            return

        if hasattr(self, "_rep_empty_box"):
            self._rep_empty_box.hide()

        if force:
            self._recycle_all_repair_slots()

        scroll_y = int(round(self.rep_vadj.get_value()))
        total_rows = len(self._rep_vrows)

        overscan = 96
        top_bound = max(0, scroll_y - overscan)
        bot_bound = scroll_y + viewport_h + overscan

        render_start = max(0, bisect_right(self._rep_vrow_offsets, top_bound) - 1)
        render_end = render_start
        while render_end < total_rows and self._rep_vrow_offsets[render_end] < bot_bound:
            render_end += 1

        # 1) Nur aus dem Overscan-Bereich herausgerollte Zeilen recyceln
        for idx in list(self._rep_active_slots.keys()):
            if idx < render_start or idx >= render_end:
                slot = self._rep_active_slots.pop(idx)
                old_jid = slot["job_id"]
                old_dk = slot["dir_key"]
                if old_jid and self._rep_visible_file_slots.get(old_jid) is slot:
                    self._rep_visible_file_slots.pop(old_jid, None)
                if old_dk and self._rep_visible_folder_slots.get(old_dk) is slot:
                    self._rep_visible_folder_slots.pop(old_dk, None)
                slot["mode"] = ""
                slot["dir_key"] = ""
                slot["job_id"] = ""
                slot["vrow_idx"] = -1
                slot["last_y"] = -999999
                slot["row"].hide()
                self._rep_free_slots.append(slot)

        # 2) Sichtbare + Overscan-Zeilen positionieren; bereits gebundene Slots NICHT neu befüllen
        for idx in range(render_start, render_end):
            y_pos = self._rep_vrow_offsets[idx] - scroll_y
            vrow = self._rep_vrows[idx]
            slot = self._rep_active_slots.get(idx)
            if slot is not None:
                if slot.get("last_w") != content_w:
                    slot["last_w"] = content_w
                    slot["row"].set_size_request(content_w, vrow["height"])
                if slot.get("last_y") != y_pos:
                    slot["last_y"] = y_pos
                    self.rep_layout.move(slot["row"], 0, y_pos)
                continue

            if self._rep_free_slots:
                slot = self._rep_free_slots.pop()
            else:
                slot = self._create_pooled_repair_slot()

            slot["vrow_idx"] = idx
            slot["last_y"] = y_pos
            self.rep_layout.move(slot["row"], 0, y_pos)

            kind = vrow["kind"]
            if kind == "spacer":
                self._bind_spacer_slot(slot)
            elif kind == "folder":
                dk = vrow["dir_key"]
                self._bind_folder_slot(slot, dk, vrow["label"])
                self._rep_visible_folder_slots[dk] = slot
            else:
                job = vrow["job"]
                self._bind_file_slot(slot, job)
                self._rep_visible_file_slots[job.job_id] = slot
            self._rep_active_slots[idx] = slot

    def _refresh_visible_highlight_classes(self) -> None:
        for jid, slot in self._rep_visible_file_slots.items():
            rctx = slot["row"].get_style_context()
            if jid in self._rep_highlighted_ids:
                rctx.add_class("highlighted")
            else:
                rctx.remove_class("highlighted")

    def _rebuild_repair_tree_rows(self) -> None:
        if not hasattr(self, "rep_layout"):
            return
        if not self._rep_all_slots:
            free_slot = self._create_pooled_repair_slot()
            self._rep_free_slots.append(free_slot)
        self._repair_jobs_by_id = {j.job_id: j for j in self.repair_manager.jobs}
        self._repair_folder_job_ids.clear()
        self._repair_folder_labels.clear()
        self._rep_vrows.clear()
        self._rep_vrow_offsets.clear()
        self._rep_visible_job_ids.clear()
        self._rep_visible_pos_by_id.clear()
        self._rep_vrow_idx_by_job_id.clear()
        self._rep_highlighted_ids.clear()
        self._rep_anchor_id = None
        self._current_inspected_repair_id = None

        visible = self._get_visible_repair_jobs()
        folder_groups: list[tuple[str, list[RepairJob]]] = []
        group_map: dict[str, list[RepairJob]] = {}
        for job in visible:
            dkey = self._get_repair_job_rel_dir(job)
            if dkey not in group_map:
                group_map[dkey] = []
                folder_groups.append((dkey, group_map[dkey]))
            group_map[dkey].append(job)

        y_off = 0
        for grp_idx, (dir_key, grp_jobs) in enumerate(folder_groups):
            if grp_idx > 0:
                self._rep_vrow_offsets.append(y_off)
                self._rep_vrows.append({"kind": "spacer", "height": self._rep_spacer_h})
                y_off += self._rep_spacer_h

            folder_label = dir_key or "Einzeldateien (ohne Ordner)"
            self._repair_folder_job_ids[dir_key] = [j.job_id for j in grp_jobs]
            self._repair_folder_labels[dir_key] = folder_label

            self._rep_vrow_offsets.append(y_off)
            self._rep_vrows.append(
                {
                    "kind": "folder",
                    "dir_key": dir_key,
                    "label": folder_label,
                    "height": self._rep_folder_h,
                }
            )
            y_off += self._rep_folder_h

            for job in grp_jobs:
                pos = len(self._rep_visible_job_ids)
                self._rep_visible_job_ids.append(job.job_id)
                self._rep_visible_pos_by_id[job.job_id] = pos
                self._rep_vrow_idx_by_job_id[job.job_id] = len(self._rep_vrows)
                self._rep_vrow_offsets.append(y_off)
                self._rep_vrows.append({"kind": "file", "job": job, "height": self._rep_file_h})
                y_off += self._rep_file_h

        self._rep_total_height = y_off
        self._last_playing_repair_job_id = self._playing_repair_job_id
        self._sync_rep_scrollbar_and_render(reset_scroll=True, force=True)
        self._sync_repair_selection_action_bar([])

    def _format_repair_row_values(self, job: RepairJob) -> list:
        health_map = {
            "ok": "OK",
            "warning": "Warnung",
            "critical": "Defekt",
            "repaired": "Repariert",
            "scanning": "Prüfe...",
            "error": "Fehler",
        }
        stream_txt = job.source_ext
        if job.structure is not None:
            st = job.structure
            br = "VBR" if st.is_vbr else f"{st.bitrate_kbps or '—'} kbps"
            stream_txt = f"{job.source_ext} · {st.sample_rate/1000:.1f} kHz · {br}"
        sev_color, sev_tip = self._get_repair_severity_indicator(job)
        return [
            job.job_id,
            job.selected,
            job.relative_path,
            stream_txt,
            health_map.get(job.health, "Wartet"),
            job.status_message,
            int(round(max(0.0, min(1.0, job.progress)) * 100)),
            sev_color,
            sev_tip,
        ]

    def _schedule_repair_summary_refresh(self) -> None:
        self._rep_summary_dirty = True
        if self._rep_summary_timer_id:
            return

        def _flush() -> bool:
            self._rep_summary_timer_id = 0
            if self._rep_summary_dirty:
                self._rep_summary_dirty = False
                self._refresh_repair_summary()
            return False

        self._rep_summary_timer_id = GLib.timeout_add(140, _flush)

    def _apply_repair_job_to_store(self, job: RepairJob) -> None:
        slot = self._rep_visible_file_slots.get(job.job_id)
        if slot is not None:
            self._bind_file_slot(slot, job)

    def _flush_pending_repair_ui_updates(self) -> bool:
        with self._rep_pending_lock:
            self._rep_flush_timer_id = 0
            pending = self._rep_pending_jobs
            self._rep_pending_jobs = {}
        if not pending or not hasattr(self, "rep_layout"):
            return False

        touched_dirs: set[str] = set()
        for job in pending.values():
            self._repair_jobs_by_id[job.job_id] = job
            self._apply_repair_job_to_store(job)
            touched_dirs.add(self._get_repair_job_rel_dir(job))

        for dk in touched_dirs:
            self._sync_single_repair_folder_row(dk)

        self._schedule_repair_summary_refresh()
        insp_id = getattr(self, "_current_inspected_repair_id", None)
        if insp_id and insp_id in pending:
            self._render_repair_inspector(pending[insp_id])
        return False

    def _on_repair_job_updated_threadsafe(self, job: RepairJob) -> None:
        with self._rep_pending_lock:
            self._rep_pending_jobs[job.job_id] = job
            if not self._rep_flush_timer_id:
                self._rep_flush_timer_id = GLib.timeout_add(
                    80, self._flush_pending_repair_ui_updates
                )

    def _refresh_repair_setup_summary(self) -> None:
        if not hasattr(self, "rep_setup_summary_meta_lbl"):
            return
        parts = [
            "Deep-Check"
            if (hasattr(self, "rep_deep_scan_chk") and self.rep_deep_scan_chk.get_active())
            else "Fast-Check"
        ]
        id3_id = (
            self.rep_id3_combo.get_active_id() if hasattr(self, "rep_id3_combo") else "4"
        ) or "4"
        parts.append(f"ID3v2.{id3_id}")
        if hasattr(self, "rep_seektable_chk") and self.rep_seektable_chk.get_active():
            parts.append("Seektable")
        if hasattr(self, "rep_optimize_cover_chk") and self.rep_optimize_cover_chk.get_active():
            parts.append("Cover")
        if hasattr(self, "rep_firefox_compat_chk") and self.rep_firefox_compat_chk.get_active():
            parts.append("Firefox-FLAC")
        self.rep_setup_summary_meta_lbl.set_text(" · ".join(parts))

    def _toggle_repair_setup_display(self) -> None:
        self._rep_setup_display_open = not bool(getattr(self, "_rep_setup_display_open", False))
        is_open = self._rep_setup_display_open
        if hasattr(self, "rep_setup_toggle_glyph"):
            self.rep_setup_toggle_glyph.set_text("−" if is_open else "+")
        if hasattr(self, "rep_setup_summary_btn"):
            ctx = self.rep_setup_summary_btn.get_style_context()
            if is_open:
                ctx.remove_class("closed-box")
            else:
                ctx.add_class("closed-box")
        if hasattr(self, "rep_setup_header_sep"):
            self.rep_setup_header_sep.set_no_show_all(not is_open)
            self.rep_setup_header_sep.set_visible(is_open)
        if hasattr(self, "rep_setup_body"):
            if is_open:
                self.rep_setup_body.set_no_show_all(False)
                self.rep_setup_body.show_all()
            else:
                self.rep_setup_body.hide()
                self.rep_setup_body.set_no_show_all(True)

    def _on_repair_all_finished_threadsafe(self, mode: str, was_cancelled: bool) -> None:
        def _done() -> bool:
            with self._rep_pending_lock:
                if self._rep_flush_timer_id:
                    GLib.source_remove(self._rep_flush_timer_id)
                    self._rep_flush_timer_id = 0
            self._flush_pending_repair_ui_updates()
            self._repair_busy = False
            self._rep_summary_dirty = False
            has_defective = False
            if not was_cancelled:
                if mode == "scan":
                    has_defective = any(
                        not self._is_repair_job_completely_clean(j)
                        for j in self.repair_manager.jobs
                    )
                    target_filter = "hide_clean_folders" if has_defective else "all"
                else:
                    target_filter = "all"
                if hasattr(self, "rep_filter_combo") and self.rep_filter_combo.get_active_id() != target_filter:
                    self.rep_filter_combo.set_active_id(target_filter)
                else:
                    self._repair_filter = target_filter
                    self._rebuild_repair_tree_rows()
            elif getattr(self, "_repair_filter", "all") != "all":
                self._rebuild_repair_tree_rows()
            self._refresh_repair_summary()
            if mode == "scan":
                if was_cancelled:
                    msg = "[Reparatur] Diagnose abgebrochen."
                elif has_defective:
                    msg = "[Reparatur] Struktur- & Header-Diagnose abgeschlossen (Filter automatisch auf „Fehlerfreie Ordner ausblenden“ gesetzt)."
                else:
                    msg = "[Reparatur] Struktur- & Header-Diagnose abgeschlossen (alle Dateien fehlerfrei — Filter bleibt auf „Alle Dateien“)."
                self._append_query_log_ui(msg)
            else:
                self._append_query_log_ui(
                    "[Reparatur] Reparaturdurchlauf abgebrochen."
                    if was_cancelled
                    else "[Reparatur] Reparaturdurchlauf abgeschlossen (Filter automatisch auf „Alle Dateien“ gesetzt)."
                )
            return False

        GLib.idle_add(_done)

    def _on_rep_filter_changed(self, combo: Gtk.ComboBoxText) -> None:
        self._repair_filter = combo.get_active_id() or "all"
        # Filterwechsel setzt gesamte Auswahl zurück, damit keine unsichtbaren Dateien gewählt bleiben
        for j in self.repair_manager.jobs:
            j.selected = False
        if hasattr(self, "rep_select_all_chk"):
            self._updating_rep_select_all = True
            try:
                self.rep_select_all_chk.set_active(False)
            finally:
                self._updating_rep_select_all = False
        self._rebuild_repair_tree_rows()
        if (
            self._playing_repair_job_id is not None
            and self._playing_repair_job_id not in self._rep_visible_pos_by_id
        ):
            self._stop_track_preview(log=False)
        self._render_repair_inspector(None)
        self._refresh_repair_summary()

    def _sync_single_repair_folder_row(self, dir_key: str) -> None:
        slot = self._rep_visible_folder_slots.get(dir_key)
        if slot is None:
            return
        folder_label = self._repair_folder_labels.get(
            dir_key, dir_key or "Einzeldateien (ohne Ordner)"
        )
        self._bind_folder_slot(slot, dir_key, folder_label)

    def _sync_repair_folder_controls(self) -> None:
        for dir_key in list(self._rep_visible_folder_slots.keys()):
            self._sync_single_repair_folder_row(dir_key)

    def _set_repair_job_selected_ui(self, job: RepairJob, selected: bool) -> None:
        job.selected = selected
        slot = self._rep_visible_file_slots.get(job.job_id)
        if slot is not None:
            slot["syncing"] = True
            try:
                slot["chk"].set_active(selected)
            finally:
                slot["syncing"] = False

    def _on_rep_slot_button_press(
        self, _row: Gtk.Widget, event: Gdk.EventButton, slot: dict
    ) -> bool:
        if event.button != 1 or slot["mode"] != "file":
            return False
        ev_widget = Gtk.get_event_widget(event)
        if ev_widget is not None and (
            ev_widget is slot["chk"]
            or ev_widget.is_ancestor(slot["chk"])
            or ev_widget is slot["play_btn"]
            or ev_widget.is_ancestor(slot["play_btn"])
        ):
            return False

        jid = slot["job_id"]
        if not jid or jid not in self._rep_visible_pos_by_id:
            return False

        if hasattr(self, "rep_layout"):
            self.rep_layout.grab_focus()

        is_shift = bool(event.state & Gdk.ModifierType.SHIFT_MASK)
        is_ctrl = bool(event.state & Gdk.ModifierType.CONTROL_MASK)

        if (
            is_shift
            and self._rep_anchor_id is not None
            and self._rep_anchor_id in self._rep_visible_pos_by_id
        ):
            a_pos = self._rep_visible_pos_by_id[self._rep_anchor_id]
            b_pos = self._rep_visible_pos_by_id[jid]
            lo, hi = (a_pos, b_pos) if a_pos <= b_pos else (b_pos, a_pos)
            range_ids = self._rep_visible_job_ids[lo : hi + 1]
            if is_ctrl:
                self._rep_highlighted_ids.update(range_ids)
            else:
                self._rep_highlighted_ids = set(range_ids)
        elif is_ctrl:
            if jid in self._rep_highlighted_ids:
                self._rep_highlighted_ids.remove(jid)
            else:
                self._rep_highlighted_ids.add(jid)
            self._rep_anchor_id = jid
        else:
            self._rep_highlighted_ids = {jid}
            self._rep_anchor_id = jid

        self._refresh_visible_highlight_classes()
        highlighted = self._get_highlighted_repair_jobs()
        self._sync_repair_selection_action_bar(highlighted)

        if not highlighted:
            self._current_inspected_repair_id = None
            self._render_repair_inspector(None)
        else:
            focus_id = jid if jid in self._rep_highlighted_ids else highlighted[-1].job_id
            self._current_inspected_repair_id = focus_id
            self._render_repair_inspector(self._repair_jobs_by_id.get(focus_id))
        return True

    def _on_rep_clear_highlight_clicked(self, _btn: Gtk.Button) -> None:
        self._rep_highlighted_ids.clear()
        self._rep_anchor_id = None
        self._current_inspected_repair_id = None
        self._refresh_visible_highlight_classes()
        self._sync_repair_selection_action_bar([])
        self._render_repair_inspector(None)

    def _on_rep_select_all_toggled(self, chk: Gtk.CheckButton) -> None:
        if (
            self._repair_busy
            or self._repair_loading
            or getattr(self, "_updating_rep_select_all", False)
        ):
            return
        active = chk.get_active()
        self._updating_rep_select_all = True
        try:
            for jid in self._rep_visible_job_ids:
                job = self._repair_jobs_by_id.get(jid)
                if job is not None:
                    self._set_repair_job_selected_ui(job, active)
        finally:
            self._updating_rep_select_all = False
        self._sync_repair_folder_controls()
        self._refresh_repair_summary(sync_folders=False)

    def _toggle_single_repair_folder(self, dir_key: str) -> None:
        if self._repair_busy or self._repair_loading:
            return
        target_ids = self._repair_folder_job_ids.get(dir_key, [])
        if not target_ids:
            return
        target_jobs = [
            j for jid in target_ids if (j := self._repair_jobs_by_id.get(jid)) is not None
        ]
        if not target_jobs:
            return
        next_state = not all(j.selected for j in target_jobs)
        for job in target_jobs:
            self._set_repair_job_selected_ui(job, next_state)
        self._sync_single_repair_folder_row(dir_key)
        self._refresh_repair_summary(sync_folders=False)

    def _get_highlighted_repair_jobs(self) -> list[RepairJob]:
        if not self._rep_highlighted_ids:
            return []
        result: list[RepairJob] = []
        for jid in self._rep_visible_job_ids:
            if jid in self._rep_highlighted_ids:
                job = self._repair_jobs_by_id.get(jid)
                if job is not None:
                    result.append(job)
        return result

    def _sync_repair_selection_action_bar(
        self, highlighted: Optional[list[RepairJob]] = None
    ) -> None:
        if not hasattr(self, "rep_activate_selected_btn"):
            return
        if highlighted is None:
            highlighted = self._get_highlighted_repair_jobs()
        if not highlighted:
            self.rep_activate_selected_btn.set_label("Markierte Dateien aktivieren")
            self.rep_activate_selected_btn.set_sensitive(False)
            if hasattr(self, "rep_clear_sel_btn"):
                self.rep_clear_sel_btn.set_sensitive(False)
            return
        self.rep_activate_selected_btn.set_label(
            f"Markierte Dateien aktivieren ({len(highlighted)})"
        )
        active_lock = self._repair_busy or self._repair_loading
        self.rep_activate_selected_btn.set_sensitive(not active_lock)
        if hasattr(self, "rep_clear_sel_btn"):
            self.rep_clear_sel_btn.set_sensitive(True)

    def _on_rep_activate_highlighted_clicked(self, _btn: Gtk.Button) -> None:
        if self._repair_busy or self._repair_loading:
            return
        highlighted = self._get_highlighted_repair_jobs()
        if not highlighted:
            return
        touched_dirs: set[str] = set()
        for job in highlighted:
            self._set_repair_job_selected_ui(job, True)
            touched_dirs.add(self._get_repair_job_rel_dir(job))
        for dk in touched_dirs:
            self._sync_single_repair_folder_row(dk)
        self._refresh_repair_summary(sync_folders=False)

    def _render_repair_inspector(self, job: Optional[RepairJob]) -> None:
        if not hasattr(self, "rep_inspector_box"):
            return
        for child in self.rep_inspector_box.get_children():
            self.rep_inspector_box.remove(child)

        def _make_copyable(widget: Gtk.Label) -> Gtk.Label:
            widget.set_selectable(True)
            widget.set_can_focus(True)
            return widget

        if job is None:
            lbl = _make_copyable(
                Gtk.Label(
                    label="Wähle links eine geprüfte Audiodatei aus, um Header-, Frame-, Tag- und Audio-Befunde anzuzeigen."
                )
            )
            lbl.set_line_wrap(True)
            lbl.set_xalign(0)
            lbl.get_style_context().add_class("dim-label")
            self.rep_inspector_box.pack_start(lbl, False, False, 0)
            self.rep_inspector_box.show_all()
            return

        copy_lines: list[str] = [f"Datei: {job.relative_path}", f"Status: {job.status_message}"]

        hdr_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        title_lbl = _make_copyable(Gtk.Label())
        title_lbl.set_markup(f"<b>{GLib.markup_escape_text(job.source_path.name)}</b>")
        title_lbl.set_xalign(0)
        title_lbl.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        hdr_row.pack_start(title_lbl, True, True, 0)

        copy_btn = Gtk.Button(label="Kopieren")
        copy_btn.set_tooltip_text(
            "Vollständigen Diagnose-Befund in die Zwischenablage kopieren (Einzeltext ebenfalls direkt markierbar & per Strg+C / Rechtsklick kopierbar)"
        )
        hdr_row.pack_end(copy_btn, False, False, 0)
        self.rep_inspector_box.pack_start(hdr_row, False, False, 0)

        if job.before_finding_count is not None and job.health == "repaired":
            cmp_lbl = _make_copyable(Gtk.Label())
            cmp_lbl.set_markup(
                f"<span color='#2E6B14'>Vorher/Nachher: <b>{job.before_finding_count}</b> Befund(e) → <b>{job.after_finding_count or 0}</b> verbleibend</span>"
            )
            cmp_lbl.set_xalign(0)
            cmp_lbl.set_line_wrap(True)
            self.rep_inspector_box.pack_start(cmp_lbl, False, False, 0)

        cov_max_dim = normalize_cover_max_dimension(
            getattr(self.settings, "cover_max_dimension", DEFAULT_COVER_MAX_DIMENSION)
        )
        fix_labels = {
            "header_strip": "Header-Strip (ID3/Müll)",
            "vbr_header_rebuild": "VBR-Header-Rebuild",
            "remux_faststart": "Remuxing / Faststart",
            "cover_optimize": f"Cover-Optimierung (≤{cov_max_dim} px / ≤1 MB)",
            "lossless_reencode": "Verlustfreies Re-Encoding",
        }

        if job.pipeline is not None:
            pip = job.pipeline
            s1_ok = pip.stage1_fast_check.passed
            s1_txt = "OK" if s1_ok else f"{pip.stage1_fast_check.issue_count} Befund(e)"
            s1_col = "#2E6B14" if s1_ok else "#B45309"
            reasons = pip.stage2_deep_check.failure_reasons or []
            if not pip.stage2_deep_check.executed:
                s2_txt = "Deaktiviert"
                s2_col = "#57606A"
            elif pip.stage2_deep_check.passed:
                if reasons:
                    s2_txt = f"OK · Hinweis: {', '.join(reasons)} ({pip.stage2_deep_check.duration_ms} ms)"
                    s2_col = "#B45309"
                else:
                    s2_txt = f"OK ({pip.stage2_deep_check.duration_ms} ms)"
                    s2_col = "#2E6B14"
            else:
                reason_txt = (
                    ", ".join(reasons)
                    if reasons
                    else f"CRC:{pip.stage2_deep_check.crc_error_count} · Trunc:{'Ja' if pip.stage2_deep_check.truncated_detected else 'Nein'}"
                )
                s2_txt = f"{reason_txt} ({pip.stage2_deep_check.duration_ms} ms)"
                s2_col = "#DC2626"

            copy_lines.append(f"Stufe 1 Fast-Check: {s1_txt} ({pip.stage1_fast_check.duration_ms} ms)")
            copy_lines.append(f"Stufe 2 Deep-Check: {s2_txt}")

            pip_lbl = _make_copyable(Gtk.Label())
            pip_markup = (
                f"<span color='{s1_col}'><b>Stufe 1 Fast-Check:</b> {GLib.markup_escape_text(s1_txt)} ({pip.stage1_fast_check.duration_ms} ms)</span>\n"
                f"<span color='{s2_col}'><b>Stufe 2 Deep-Check:</b> {GLib.markup_escape_text(s2_txt)}</span>"
            )
            if pip.recommended_fixes:
                plan_txt = ", ".join(fix_labels.get(a, a) for a in pip.recommended_fixes)
                pip_markup += f"\n<span color='#2E6B14'><b>Auto-Repair-Plan:</b> {GLib.markup_escape_text(plan_txt)}</span>"
                copy_lines.append(f"Auto-Repair-Plan: {plan_txt}")
            pip_lbl.set_markup(pip_markup)
            pip_lbl.set_xalign(0)
            pip_lbl.set_line_wrap(True)
            self.rep_inspector_box.pack_start(pip_lbl, False, False, 0)

        if job.structure is not None:
            st = job.structure
            if st.flac_firefox_compatible:
                ff_color = (
                    "#2E6B14"
                    if st.flac_firefox_compatible == "compatible"
                    else ("#B45309" if st.flac_firefox_compatible == "warning" else "#DC2626")
                )
                ff_text = (
                    "Kompatibel (natives fLaC, ≤ 24-Bit/192 kHz, Mono/Stereo)"
                    if st.flac_firefox_compatible == "compatible"
                    else (
                        "Eingeschränkt (Warnungen bei Blockgröße/MD5/Encoding)"
                        if st.flac_firefox_compatible == "warning"
                        else "Inkompatibel (kritische Abweichung für Firefox)"
                    )
                )
                ff_lbl = _make_copyable(Gtk.Label())
                ff_lbl.set_markup(
                    f"<span color='{ff_color}'><b>Firefox-FLAC-Prüfung:</b> {GLib.markup_escape_text(ff_text)}</span>"
                )
                ff_lbl.set_xalign(0)
                ff_lbl.set_line_wrap(True)
                self.rep_inspector_box.pack_start(ff_lbl, False, False, 0)
                copy_lines.append(f"Firefox-FLAC-Prüfung: {ff_text}")

            lay_str = f" ({st.channel_layout})" if st.channel_layout else ""
            magic_txt = (
                f"{st.detected_magic.upper()} ({'OK' if st.magic_matches_extension else 'FEHLER != Endung!'})"
                if st.detected_magic
                else st.codec.upper()
            )
            lines = [
                f"Format: {st.codec.upper()} ({st.container}) · Magic: {magic_txt} · {st.sample_rate} Hz · {st.bits_per_sample}-Bit · {st.channels}ch{lay_str}",
                f"ID3v2: {st.id3v2_count}× ({', '.join(st.id3v2_versions) if st.id3v2_versions else 'keine'}) · ID3v1: {'Ja' if st.has_id3v1 else 'Nein'}",
                f"Müll-Bytes Vor/Ende: {st.leading_garbage_bytes} B / {st.trailing_garbage_bytes} B · Sync-Lücken: {st.corrupt_sync_gaps}",
            ]
            if st.m4a_moov_position:
                moov_map = {
                    "before_mdat": "vor mdat (Faststart OK)",
                    "after_mdat": "NACH mdat (kein Faststart!)",
                    "missing": "FEHLT!",
                }
                lines.append(f"M4A moov-Atom: {moov_map.get(st.m4a_moov_position, st.m4a_moov_position)}")
            if st.has_cover_art:
                cov_kb = max(1, round(st.cover_art_bytes / 1024)) if st.cover_art_bytes else 0
                dim_s = f" · {st.cover_art_width}×{st.cover_art_height} px" if st.cover_art_width else ""
                lines.append(f"Cover-Art: {st.cover_art_mime or 'unbekannt'} · {cov_kb} KB{dim_s}")
            if st.codec == "mp3":
                lines.append(
                    f"VBR/Xing: {'Ja' if st.has_xing_header else 'Nein'} ({st.xing_frames}/{st.actual_frames} Frames)"
                )
            elif st.codec == "flac" or st.flac_firefox_compatible:
                md5_map = {
                    "valid": "Gültig",
                    "mismatch": "PRÜFFEHLER",
                    "missing": "Leer (0000)",
                    "unverified": "Vorhanden",
                }
                md5_txt = md5_map.get(st.flac_md5_status or "", "Gültig" if st.flac_md5_valid else "—")
                cont_txt = (
                    "Ogg-FLAC (OggS!)"
                    if st.flac_is_ogg
                    else ("Nativ fLaC · STREAMINFO OK" if st.flac_streaminfo_valid else "fLaC · STREAMINFO-Fehler")
                )
                blk_txt = (
                    f"{st.flac_min_block_size or '?'}–{st.flac_max_block_size or '?'} (Var)"
                    if st.flac_variable_block_size
                    else f"{st.flac_min_block_size or '?'} (Fest)"
                )
                seek_s = (
                    "Defekt!"
                    if (st.flac_has_seektable and st.seek_table_valid is False)
                    else ("Ja (OK)" if st.flac_has_seektable else "Nein")
                )
                sub_s = "Nein" if st.flac_subset_valid is False else "OK"
                lines.append(f"Container: {cont_txt} · Blockgröße: {blk_txt} · Subset: {sub_s}")
                lines.append(f"FLAC MD5: {md5_txt} · Seektable: {seek_s}")
            if st.max_volume_db is not None or st.stream_crc_errors > 0 or st.stream_truncated:
                pk = f"{st.max_volume_db:.1f} dB" if st.max_volume_db is not None else "—"
                lines.append(
                    f"Null-Decode: CRC={st.stream_crc_errors} · Trunc={'Ja!' if st.stream_truncated else 'Nein'} · Peak: {pk}"
                )
            copy_lines.extend(lines)
            info_lbl = _make_copyable(Gtk.Label(label="\n".join(lines)))
            info_lbl.set_xalign(0)
            info_lbl.set_line_wrap(True)
            info_lbl.get_style_context().add_class("dim-label")
            self.rep_inspector_box.pack_start(info_lbl, False, False, 0)

        self.rep_inspector_box.pack_start(
            Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 2
        )

        # Visuelle Fehlerposition in der Datei (3 Zonen: Header/Anfang · Audiostrom · Ende/Trailer)
        def _fmt_dur_mmss(sec_val: Optional[int]) -> str:
            if sec_val is None or sec_val < 0:
                return ""
            m_v, s_v = divmod(int(sec_val), 60)
            return f"{m_v:02d}:{s_v:02d}"

        raw_err_positions: list[dict] = list(
            getattr(job.structure, "error_positions", None) or []
        ) if job.structure is not None else []
        if not raw_err_positions and job.findings:
            dur_fb = job.structure.duration_seconds if job.structure else 0
            for f in job.findings:
                if f.code in ("trailing_garbage", "stream_truncated_file", "m4a_moov_after_mdat", "apev2_tag_present"):
                    z_fb, r_fb, t_fb = "end", 1.0, (dur_fb if dur_fb > 0 else None)
                elif f.category in ("header", "tags") or f.code == "leading_garbage":
                    z_fb, r_fb, t_fb = "start", 0.0, 0
                else:
                    z_fb, r_fb, t_fb = "stream", None, None
                raw_err_positions.append(
                    {
                        "zone": z_fb,
                        "ratio": r_fb,
                        "severity": f.severity,
                        "code": f.code,
                        "label": f.title,
                        "time_seconds": t_fb,
                    }
                )

        def _finding_pos_text(finding_obj) -> str:
            matched = [p for p in raw_err_positions if p.get("code") == finding_obj.code]
            if matched:
                z0 = matched[0].get("zone")
                if z0 == "start":
                    return "Dateianfang (Header / Tags)"
                if z0 == "end":
                    return "Dateiende (Trailer)"
                timed = [p for p in matched if isinstance(p.get("ratio"), (int, float))]
                if timed:
                    parts = []
                    for p in timed[:3]:
                        pct = f"{round(float(p['ratio']) * 100)} %"
                        ts = p.get("time_seconds")
                        parts.append(f"~{_fmt_dur_mmss(ts)} ({pct})" if isinstance(ts, (int, float)) else pct)
                    extra = f" (+{len(timed) - 3})" if len(timed) > 3 else ""
                    return f"Audiostrom bei {', '.join(parts)}{extra}"
                return "Gesamter Audiostrom"
            if finding_obj.code in ("trailing_garbage", "stream_truncated_file", "m4a_moov_after_mdat", "apev2_tag_present"):
                return "Dateiende (Trailer)"
            if finding_obj.category in ("header", "tags") or finding_obj.code == "leading_garbage":
                return "Dateianfang (Header / Tags)"
            return "Audiostrom"

        if job.health not in ("pending", "scanning"):
            pos_frame = Gtk.Frame()
            pos_hdr_lbl = _make_copyable(Gtk.Label())
            pos_hdr_suffix = (
                "Keine Fehlerpositionen (sauber)"
                if not raw_err_positions
                else f"{len(raw_err_positions)} Markierung(en)"
            )
            pos_hdr_lbl.set_markup(
                f"<b>Fehlerposition in der Datei</b> · {GLib.markup_escape_text(pos_hdr_suffix)}"
            )
            pos_frame.set_label_widget(pos_hdr_lbl)
            pos_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
            pos_vbox.set_border_width(6)

            dur_total = job.structure.duration_seconds if job.structure else 0
            dur_lbl_txt = _fmt_dur_mmss(dur_total) if dur_total > 0 else "Ende"

            map_area = Gtk.DrawingArea()
            map_area.set_size_request(-1, 56)

            def _sev_hex(sev_s: str) -> str:
                if sev_s == "critical":
                    return "#DC2626"
                if sev_s == "warning":
                    return "#F97316"
                return "#EAB308"

            def _worst_hex(items_list: list[dict]) -> Optional[str]:
                if not items_list:
                    return None
                rank = {"critical": 3, "warning": 2, "info": 1}
                top = max(items_list, key=lambda x: rank.get(str(x.get("severity")), 1))
                return _sev_hex(str(top.get("severity")))

            start_pins = [p for p in raw_err_positions if p.get("zone") == "start"]
            stream_pins = [p for p in raw_err_positions if p.get("zone") == "stream"]
            end_pins = [p for p in raw_err_positions if p.get("zone") == "end"]
            stream_pts = [p for p in stream_pins if isinstance(p.get("ratio"), (int, float))]
            stream_spans = [p for p in stream_pins if not isinstance(p.get("ratio"), (int, float))]

            def _draw_error_pos_map(widget: Gtk.DrawingArea, cr) -> bool:
                alloc = widget.get_allocation()
                w = max(120, alloc.width)
                h = max(44, alloc.height)
                bar_y = 4.0
                bar_h = 32.0
                gap = 4.0
                side_w = max(58.0, min(86.0, w * 0.20))
                mid_x = side_w + gap
                mid_w = max(40.0, w - 2.0 * side_w - 2.0 * gap)
                end_x = mid_x + mid_w + gap

                def _draw_zone(x: float, zw: float, col_hex: Optional[str], title_s: str, pins: list[dict], is_mid: bool = False) -> None:
                    if col_hex:
                        r, g, b = self._repair_severity_rgb(col_hex)
                        fill_a = 0.16 if (not is_mid or stream_spans) else 0.06
                        cr.set_source_rgba(r, g, b, fill_a)
                    else:
                        cr.set_source_rgba(0.133, 0.773, 0.369, 0.10)
                    cr.rectangle(x, bar_y, zw, bar_h)
                    cr.fill()
                    if col_hex:
                        r, g, b = self._repair_severity_rgb(col_hex)
                        cr.set_source_rgba(r, g, b, 0.85)
                    else:
                        cr.set_source_rgba(0.133, 0.773, 0.369, 0.55)
                    cr.set_line_width(1.2)
                    cr.rectangle(x + 0.6, bar_y + 0.6, zw - 1.2, bar_h - 1.2)
                    cr.stroke()

                    if is_mid:
                        # Zeitachse in der Mitte
                        line_y = bar_y + bar_h / 2.0
                        if stream_spans and col_hex:
                            r, g, b = self._repair_severity_rgb(col_hex)
                            cr.set_source_rgba(r, g, b, 0.55)
                        else:
                            cr.set_source_rgba(0.357, 0.651, 0.196, 0.45)
                        cr.set_line_width(3.0)
                        cr.move_to(x + 6.0, line_y)
                        cr.line_to(x + zw - 6.0, line_y)
                        cr.stroke()
                        # Exakte Fehler-Marker auf der Zeitachse
                        for pt in stream_pts:
                            ratio = max(0.03, min(0.97, float(pt["ratio"])))
                            px = x + 6.0 + ratio * max(1.0, zw - 12.0)
                            pr, pg, pb = self._repair_severity_rgb(_sev_hex(str(pt.get("severity"))))
                            cr.set_source_rgb(pr, pg, pb)
                            cr.set_line_width(2.0)
                            cr.move_to(px, bar_y + 2.0)
                            cr.line_to(px, bar_y + bar_h - 2.0)
                            cr.stroke()
                            cr.arc(px, line_y, 4.5, 0.0, 2.0 * math.pi)
                            cr.fill()
                        # Mittentext
                        cr.select_font_face("Sans", 0, 1)
                        cr.set_font_size(10.0)
                        mid_txt = (
                            f"Audiostrom (00:00 – {dur_lbl_txt}) · OK"
                            if not pins
                            else (
                                f"Audiostrom · {len(stream_pts)} Stelle(n)"
                                if stream_pts
                                else f"Audiostrom · {len(stream_spans)} Befund(e)"
                            )
                        )
                        ext = cr.text_extents(mid_txt)
                        tx = x + (zw - ext.width) / 2.0
                        ty = bar_y + bar_h / 2.0 + ext.height / 2.0 - 1.0
                        cr.set_source_rgba(0.5, 0.5, 0.5, 0.12)
                        cr.rectangle(tx - 4.0, bar_y + 7.0, ext.width + 8.0, 18.0)
                        cr.fill()
                        cr.set_source_rgb(0.25, 0.28, 0.31)
                        if self.theme_watcher.is_dark_active():
                            cr.set_source_rgb(0.92, 0.94, 0.95)
                        cr.move_to(tx, ty)
                        cr.show_text(mid_txt)
                    else:
                        cr.select_font_face("Sans", 0, 1)
                        cr.set_font_size(10.0)
                        ext = cr.text_extents(title_s)
                        cr.set_source_rgb(0.20, 0.24, 0.28)
                        if self.theme_watcher.is_dark_active():
                            cr.set_source_rgb(0.92, 0.94, 0.95)
                        cr.move_to(x + (zw - ext.width) / 2.0, bar_y + 13.0)
                        cr.show_text(title_s)
                        if pins:
                            dots = pins[:4]
                            total_dot_w = len(dots) * 10.0 - 2.0
                            dx0 = x + (zw - total_dot_w) / 2.0 + 4.0
                            for idx_d, dp in enumerate(dots):
                                dr, dg, db = self._repair_severity_rgb(_sev_hex(str(dp.get("severity"))))
                                cr.set_source_rgb(dr, dg, db)
                                cr.arc(dx0 + idx_d * 10.0, bar_y + 23.0, 3.8, 0.0, 2.0 * math.pi)
                                cr.fill()
                        else:
                            ok_ext = cr.text_extents("OK")
                            cr.set_source_rgb(0.18, 0.42, 0.08)
                            if self.theme_watcher.is_dark_active():
                                cr.set_source_rgb(0.61, 0.89, 0.44)
                            cr.move_to(x + (zw - ok_ext.width) / 2.0, bar_y + 26.0)
                            cr.show_text("OK")

                _draw_zone(0.0, side_w, _worst_hex(start_pins), "Header", start_pins, is_mid=False)
                _draw_zone(mid_x, mid_w, _worst_hex(stream_pins), "Audiostrom", stream_pins, is_mid=True)
                _draw_zone(end_x, side_w, _worst_hex(end_pins), "Ende", end_pins, is_mid=False)

                # Untere Skalen-Beschriftung
                cr.select_font_face("Monospace", 0, 0)
                cr.set_font_size(9.5)
                cr.set_source_rgba(0.45, 0.49, 0.54, 0.95)
                if self.theme_watcher.is_dark_active():
                    cr.set_source_rgba(0.62, 0.67, 0.72, 0.95)
                foot_y = bar_y + bar_h + 13.0
                cr.move_to(2.0, foot_y)
                cr.show_text("Anfang (00:00)")
                right_txt = f"{dur_lbl_txt} · Trailer"
                r_ext = cr.text_extents(right_txt)
                cr.move_to(max(2.0, w - r_ext.width - 2.0), foot_y)
                cr.show_text(right_txt)
                return False

            map_area.connect("draw", _draw_error_pos_map)
            pos_vbox.pack_start(map_area, False, False, 0)

            if raw_err_positions:
                for ep in raw_err_positions[:6]:
                    z_ep = ep.get("zone")
                    col_ep = _sev_hex(str(ep.get("severity")))
                    if z_ep == "start":
                        z_txt = "Dateianfang (Header)"
                    elif z_ep == "end":
                        z_txt = "Dateiende (Trailer)"
                    elif isinstance(ep.get("ratio"), (int, float)):
                        pct = f"{round(float(ep['ratio']) * 100)} %"
                        ts = ep.get("time_seconds")
                        t_part = f" · ~{_fmt_dur_mmss(ts)}" if isinstance(ts, (int, float)) else ""
                        z_txt = f"Audiostrom ({pct}{t_part})"
                    else:
                        z_txt = "Audiostrom (gesamt)"
                    ep_lbl = _make_copyable(Gtk.Label())
                    ep_lbl.set_markup(
                        f"<span color='{col_ep}'>●</span> <b>{GLib.markup_escape_text(z_txt)}:</b> {GLib.markup_escape_text(str(ep.get('label') or ''))}"
                    )
                    ep_lbl.set_xalign(0)
                    ep_lbl.set_line_wrap(True)
                    pos_vbox.pack_start(ep_lbl, False, False, 0)
                if len(raw_err_positions) > 6:
                    more_lbl = _make_copyable(
                        Gtk.Label(label=f"… und {len(raw_err_positions) - 6} weitere Position(en)")
                    )
                    more_lbl.set_xalign(0)
                    more_lbl.get_style_context().add_class("dim-label")
                    pos_vbox.pack_start(more_lbl, False, False, 0)

            pos_frame.add(pos_vbox)
            self.rep_inspector_box.pack_start(pos_frame, False, False, 0)

        f_hdr = _make_copyable(Gtk.Label())
        f_hdr.set_markup(f"<b>Diagnose-Befunde ({len(job.findings)})</b>")
        f_hdr.set_xalign(0)
        self.rep_inspector_box.pack_start(f_hdr, False, False, 0)

        if not job.findings:
            ok_lbl = _make_copyable(
                Gtk.Label(label="Keine Struktur-, Header- oder Frame-Fehler erkannt.")
            )
            ok_lbl.set_xalign(0)
            ok_lbl.set_line_wrap(True)
            self.rep_inspector_box.pack_start(ok_lbl, False, False, 0)
            copy_lines.append("Befunde: Keine Struktur-, Header- oder Frame-Fehler erkannt.")
        else:
            copy_lines.append(f"Diagnose-Befunde ({len(job.findings)}):")
            for finding in job.findings:
                sev_lbl = (
                    "KRITISCH"
                    if finding.severity == "critical"
                    else ("WARNUNG" if finding.severity == "warning" else "HINWEIS")
                )
                st_lbl = "Deep" if finding.stage == "deep" else "Fast"
                card = Gtk.Frame()
                card_title_lbl = _make_copyable(
                    Gtk.Label(label=f"[{st_lbl} · {sev_lbl}] {finding.title}")
                )
                card_title_lbl.set_xalign(0)
                card_title_lbl.set_line_wrap(True)
                card.set_label_widget(card_title_lbl)
                c_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
                c_vbox.set_border_width(6)
                pos_txt = _finding_pos_text(finding)
                pos_lbl = _make_copyable(Gtk.Label())
                pos_lbl.set_markup(
                    f"<b>Position:</b> {GLib.markup_escape_text(pos_txt)}"
                )
                pos_lbl.set_xalign(0)
                pos_lbl.set_line_wrap(True)
                c_vbox.pack_start(pos_lbl, False, False, 0)
                d_lbl = _make_copyable(Gtk.Label(label=finding.description))
                d_lbl.set_xalign(0)
                d_lbl.set_line_wrap(True)
                c_vbox.pack_start(d_lbl, False, False, 0)
                act_note = (
                    f" [Fix: {fix_labels.get(finding.fix_action, finding.fix_action)}]"
                    if finding.fix_action
                    else ""
                )
                fix_lbl = _make_copyable(Gtk.Label())
                fix_lbl.set_markup(
                    f"<span color='#2E6B14'>Lösung: {GLib.markup_escape_text(finding.recommended_fix + act_note)}</span>"
                )
                fix_lbl.set_xalign(0)
                fix_lbl.set_line_wrap(True)
                c_vbox.pack_start(fix_lbl, False, False, 0)
                card.add(c_vbox)
                self.rep_inspector_box.pack_start(card, False, False, 0)
                copy_lines.append(
                    f"- [{st_lbl} · {sev_lbl} · {pos_txt}] {finding.title}: {finding.description} -> {finding.recommended_fix}{act_note}"
                )

        full_report_text = "\n".join(copy_lines)

        def _on_copy_inspector(btn: Gtk.Button) -> None:
            clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            clipboard.set_text(full_report_text, -1)
            clipboard.store()
            btn.set_label("Kopiert!")
            GLib.timeout_add(1600, lambda: btn.set_label("Kopieren") or False)

        copy_btn.connect("clicked", _on_copy_inspector)
        self.rep_inspector_box.show_all()

    def _refresh_repair_summary(self, sync_folders: bool = True) -> None:
        if not hasattr(self, "rep_summary_label"):
            return
        jobs = self.repair_manager.jobs
        total = len(jobs)
        sel = 0
        ok_cnt = 0
        issue_cnt = 0
        rep_cnt = 0
        prog_sum = 0.0
        for j in jobs:
            if j.selected:
                sel += 1
            if j.health == "ok":
                ok_cnt += 1
            elif j.health in ("warning", "critical", "error"):
                issue_cnt += 1
            if j.health == "repaired" or (j.output_path is not None and j.output_path.exists()):
                rep_cnt += 1
            prog_sum += max(0.0, min(1.0, j.progress))

        if self._repair_loading:
            src_txt = f" ({self._repair_loading_source})" if self._repair_loading_source else ""
            self.rep_summary_label.set_text(
                f"Lade Dateien{src_txt}… {self._repair_loading_count} gefunden · Analyse startet erst nach vollständigem Laden"
            )
        else:
            self.rep_summary_label.set_text(
                f"{total} Dateien · {ok_cnt} OK · {issue_cnt} Probleme · {rep_cnt} repariert · {sel} gewählt"
            )
        if hasattr(self, "rep_select_all_chk"):
            vis_total = len(self._rep_visible_job_ids)
            vis_sel = sum(
                1
                for jid in self._rep_visible_job_ids
                if (jb := self._repair_jobs_by_id.get(jid)) is not None and jb.selected
            )
            all_vis_sel = vis_total > 0 and vis_sel == vis_total
            if self.rep_select_all_chk.get_active() != all_vis_sel:
                self._updating_rep_select_all = True
                try:
                    self.rep_select_all_chk.set_active(all_vis_sel)
                finally:
                    self._updating_rep_select_all = False
        avg_pct = (prog_sum / total) if total > 0 else 0.0
        self.rep_total_progress.set_fraction(avg_pct)
        self.rep_total_progress.set_text(
            "Lade..." if self._repair_loading else f"{int(round(avg_pct * 100))}%"
        )

        active_lock = self._repair_busy or self._repair_loading
        can_rep = (not active_lock) and sel > 0
        self.rep_start_btn.set_sensitive(can_rep)
        if hasattr(self, "rep_auto_repair_btn"):
            self.rep_auto_repair_btn.set_sensitive(can_rep)
        self.rep_rescan_btn.set_sensitive((not active_lock) and total > 0)
        self.rep_cancel_btn.set_sensitive(active_lock)
        self.rep_clear_btn.set_sensitive((not active_lock) and total > 0)
        if hasattr(self, "rep_import_btn"):
            self.rep_import_btn.set_sensitive(not active_lock)
        if hasattr(self, "rep_deep_scan_chk"):
            self.rep_deep_scan_chk.set_sensitive(not active_lock)
        self._sync_repair_selection_action_bar()
        if sync_folders:
            self._sync_repair_folder_controls()

    def _on_rep_rescan_clicked(self, _btn: Gtk.Button) -> None:
        if self._repair_busy or self._repair_loading or not self.repair_manager.jobs:
            return
        for j in self.repair_manager.jobs:
            j.selected = False
            j.health = "pending"
            j.progress = 0.0
            j.status_message = "In Diagnose-Warteschlange..."
        self._rebuild_repair_tree_rows()
        self._repair_busy = True
        self._refresh_repair_summary(sync_folders=False)
        cov_max_dim = normalize_cover_max_dimension(
            getattr(self.settings, "cover_max_dimension", DEFAULT_COVER_MAX_DIMENSION)
        )
        eff_threads = normalize_max_threads(
            getattr(self.settings, "max_threads", DEFAULT_MAX_THREADS)
        )
        self.repair_manager.start_scan(
            self.repair_manager.jobs,
            self.rep_deep_scan_chk.get_active(),
            cover_max_dimension=cov_max_dim,
            max_workers=eff_threads,
        )

    def _on_rep_start_clicked(self, _btn: Gtk.Button, auto_repair: bool = False) -> None:
        if self._repair_busy or self._repair_loading:
            return
        out_str = str(
            getattr(self.settings, "output_dir_repair", DEFAULT_OUTPUT_DIR_REPAIR)
        )
        cov_max_dim = normalize_cover_max_dimension(
            getattr(self.settings, "cover_max_dimension", DEFAULT_COVER_MAX_DIMENSION)
        )
        opts = RepairOptions(
            output_dir=Path(out_str),
            in_place_backup=self.rep_backup_chk.get_active(),
            deep_scan=self.rep_deep_scan_chk.get_active(),
            fix_vbr_xing=self.rep_fix_xing_chk.get_active(),
            strip_garbage_frames=self.rep_strip_garbage_chk.get_active(),
            clean_tags=self.rep_clean_tags_chk.get_active(),
            rebuild_container=self.rep_rebuild_container_chk.get_active(),
            write_flac_seektable=self.rep_seektable_chk.get_active(),
            optimize_cover=self.rep_optimize_cover_chk.get_active(),
            cover_max_dimension=cov_max_dim,
            auto_repair=auto_repair,
            firefox_compat=self.rep_firefox_compat_chk.get_active(),
            id3v2_version=int(self.rep_id3_combo.get_active_id() or "4"),
            cover_filename=str(getattr(self.settings, "cover_filename", "cover") or "cover"),
        )
        try:
            eff_threads = normalize_max_threads(
                getattr(self.settings, "max_threads", DEFAULT_MAX_THREADS)
            )
            cnt = self.repair_manager.start_repair(opts, max_workers=eff_threads)
        except Exception as exc:
            self._append_query_log_ui(f"[Reparatur] Start fehlgeschlagen: {exc}")
            return
        if cnt > 0:
            self._repair_busy = True
            self._refresh_repair_summary()
            mode_txt = (
                f"Auto-Repair (Fehlerklassen · Seektable={'Ja' if opts.write_flac_seektable else 'Nein'})"
                if auto_repair
                else f"Manuelle Pipeline (Xing={'Ja' if opts.fix_vbr_xing else 'Nein'}, Frames={'Ja' if opts.strip_garbage_frames else 'Nein'}, Tags={'Ja' if opts.clean_tags else 'Nein'}, Container={'Ja' if opts.rebuild_container else 'Nein'}, Seektable={'Ja' if opts.write_flac_seektable else 'Nein'}, Cover={'Ja' if opts.optimize_cover else 'Nein'})"
            )
            self._append_query_log_ui(f"[Reparatur] {mode_txt} für {cnt} Datei(en) gestartet...")

    def _on_rep_cancel_clicked(self, _btn: Gtk.Button) -> None:
        if self._repair_load_cancel is not None:
            self._repair_load_cancel.set()
        self.repair_manager.set_loading(False)
        self.repair_manager.cancel_all()
        self._repair_loading = False
        self._repair_busy = False
        self._refresh_repair_summary()
        self._append_query_log_ui("[Reparatur] Vorgang abgebrochen.")

    def _on_rep_clear_clicked(self, _btn: Gtk.Button) -> None:
        if not self._repair_busy and not self._repair_loading:
            self._reset_repair_cache()
            self._append_query_log_ui("[Reparatur] Diagnoseliste geleert.")

    def _reset_repair_cache(self) -> None:
        if getattr(self, "_playing_repair_job_id", None) is not None:
            self._stop_track_preview(log=False)
        if self._repair_load_cancel is not None:
            self._repair_load_cancel.set()
            self._repair_load_cancel = None
        with self._rep_pending_lock:
            if self._rep_flush_timer_id:
                GLib.source_remove(self._rep_flush_timer_id)
                self._rep_flush_timer_id = 0
            self._rep_pending_jobs.clear()
        if hasattr(self, "repair_manager"):
            self.repair_manager.set_loading(False)
            self.repair_manager.clear_all()
        self._repair_loading = False
        self._repair_busy = False
        if hasattr(self, "_repair_jobs_by_id"):
            self._repair_jobs_by_id.clear()
        if hasattr(self, "_repair_folder_job_ids"):
            self._repair_folder_job_ids.clear()
        if hasattr(self, "_repair_folder_labels"):
            self._repair_folder_labels.clear()
        if hasattr(self, "_rep_vrows"):
            self._rep_vrows.clear()
        if hasattr(self, "_rep_vrow_offsets"):
            self._rep_vrow_offsets.clear()
        self._rep_total_height = 0
        if hasattr(self, "_rep_visible_job_ids"):
            self._rep_visible_job_ids.clear()
        if hasattr(self, "_rep_visible_pos_by_id"):
            self._rep_visible_pos_by_id.clear()
        if hasattr(self, "_rep_vrow_idx_by_job_id"):
            self._rep_vrow_idx_by_job_id.clear()
        if hasattr(self, "_rep_highlighted_ids"):
            self._rep_highlighted_ids.clear()
        self._rep_anchor_id = None
        self._last_playing_repair_job_id = None
        self._current_inspected_repair_id = None
        self._sync_rep_scrollbar_and_render(reset_scroll=True, force=True)
        self._sync_repair_selection_action_bar([])
        self._render_repair_inspector(None)
        self._refresh_repair_summary(sync_folders=False)



