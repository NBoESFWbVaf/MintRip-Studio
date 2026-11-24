import React from 'react';
import {
  Disc3,
  Disc,
  Globe,
  ShoppingBag,
  Music,
  FolderOpen,
  Image as ImageIcon,
  Search,
  RefreshCw,
  Play,
  Pause,
  Square,
  Save,
  Plus,
  Trash2,
  Check,
  AlertTriangle,
  AlertCircle,
  GripVertical,
  ListOrdered,
  Settings,
  ArrowUpFromLine,
  ArrowDownToLine,
  Eraser,
  ScanLine,
  FolderUp,
  QrCode,
  AudioWaveform,
  ArrowRight,
  Music2,
  UserCheck,
  Users,
  Scissors,
  Home,
  ArrowLeft,
  Tags,
  Repeat,
  Wrench,
  Maximize2,
} from 'lucide-react';

function FlatbedScannerIcon({
  className = 'w-4 h-4',
  strokeWidth = 1.75,
  ...rest
}: {
  className?: string;
  strokeWidth?: number;
  [key: string]: unknown;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      {/* Geöffneter Scanner-Deckel schräg nach oben */}
      <path d="M4 12L6.5 4.5H19.5L18 12" />
      {/* Vorlagenglas / Booklet-Auflage */}
      <path d="M6.5 8.5H16.5" strokeOpacity="0.65" />
      {/* Flachbettscanner-Gehäuse unten */}
      <rect x="2.5" y="12" width="19" height="7.5" rx="1.8" />
      {/* Leuchtender Scan-Schlitten & Status-LED */}
      <line x1="6" y1="15.75" x2="14" y2="15.75" />
      <circle cx="18" cy="15.75" r="0.9" fill="currentColor" />
    </svg>
  );
}

export type SystemIconKey =
  | 'optical_drive'
  | 'audio_track'
  | 'music_folder'
  | 'cover_image'
  | 'search_online'
  | 'provider_musicbrainz'
  | 'provider_discogs'
  | 'provider_amazon'
  | 'refresh_disc'
  | 'eject_disc'
  | 'close_tray'
  | 'start_rip'
  | 'pause_batch'
  | 'stop_batch'
  | 'save_export'
  | 'add_files'
  | 'remove_item'
  | 'clear_list'
  | 'settings'
  | 'status_ok'
  | 'status_warn'
  | 'status_error'
  | 'drag_handle'
  | 'batch_queue'
  | 'scanner'
  | 'open_file'
  | 'barcode_qr'
  | 'shazam'
  | 'apply_arrow'
  | 'classical_album'
  | 'verify_artists'
  | 'verify_orchestra'
  | 'split_artists'
  | 'crop_cover'
  | 'scale_cover'
  | 'save_cover'
  | 'media_play'
  | 'media_stop'
  | 'home_start'
  | 'back_arrow'
  | 'module_tag'
  | 'module_convert'
  | 'module_repair'
  | 'module_cut';

export interface SystemIconSpec {
  key: SystemIconKey;
  xdgName: string;
  gtkRole: string;
  themeNote: string;
}

export const SYSTEM_ICON_SPECS: SystemIconSpec[] = [
  {
    key: 'optical_drive',
    xdgName: 'media-optical-symbolic',
    gtkRole: 'Laufwerksauswahl & HeaderBar',
    themeNote: 'Mint-Y / Adwaita Devices',
  },
  {
    key: 'audio_track',
    xdgName: 'audio-x-generic-symbolic',
    gtkRole: 'Trackliste & Audio-Dropzone',
    themeNote: 'Freedesktop MIME Type',
  },
  {
    key: 'music_folder',
    xdgName: 'folder-music-symbolic',
    gtkRole: 'Zielverzeichnis (~/Musik)',
    themeNote: 'XDG User Dirs',
  },
  {
    key: 'cover_image',
    xdgName: 'image-x-generic-symbolic',
    gtkRole: 'Cover-Art-Well & Download',
    themeNote: 'Freedesktop MIME Type',
  },
  {
    key: 'search_online',
    xdgName: 'system-search-symbolic',
    gtkRole: 'MusicBrainz & CDDB Suche / Auto-Cover',
    themeNote: 'Standard Action Icon',
  },
  {
    key: 'provider_musicbrainz',
    xdgName: 'network-workgroup-symbolic',
    gtkRole: 'MusicBrainz (Cover Art Archive) Direkt-Suche',
    themeNote: 'Mint-Y / Adwaita Places & Network',
  },
  {
    key: 'provider_discogs',
    xdgName: 'media-optical-cd-audio-symbolic',
    gtkRole: 'Discogs Cover-Suche',
    themeNote: 'Mint-Y / Adwaita Devices',
  },
  {
    key: 'provider_amazon',
    xdgName: 'applications-internet-symbolic',
    gtkRole: 'Amazon ASIN Cover-Suche',
    themeNote: 'Mint-Y / Adwaita Categories',
  },
  {
    key: 'refresh_disc',
    xdgName: 'view-refresh-symbolic',
    gtkRole: 'CD-TOC mit PyCdio neu einlesen',
    themeNote: 'Standard Action Icon',
  },
  {
    key: 'eject_disc',
    xdgName: 'media-eject-symbolic',
    gtkRole: 'Laufwerk nach Rip auswerfen',
    themeNote: 'Media Playback Controls',
  },
  {
    key: 'close_tray',
    xdgName: 'go-down-symbolic',
    gtkRole: 'CD-Schlitten schließen (einfahren)',
    themeNote: 'Media Playback Controls',
  },
  {
    key: 'start_rip',
    xdgName: 'media-playback-start-symbolic',
    gtkRole: 'Stapelverarbeitung starten',
    themeNote: 'Media Playback Controls',
  },
  {
    key: 'pause_batch',
    xdgName: 'media-playback-pause-symbolic',
    gtkRole: 'Warteschlange pausieren',
    themeNote: 'Media Playback Controls',
  },
  {
    key: 'stop_batch',
    xdgName: 'process-stop-symbolic',
    gtkRole: 'Laufende Aufträge abbrechen',
    themeNote: 'Standard Action Icon',
  },
  {
    key: 'save_export',
    xdgName: 'document-save-symbolic',
    gtkRole: 'FLAC / MP3 / Cuesheet speichern',
    themeNote: 'Standard Action Icon',
  },
  {
    key: 'add_files',
    xdgName: 'list-add-symbolic',
    gtkRole: 'Titel / Dateien hinzufügen',
    themeNote: 'Standard Action Icon',
  },
  {
    key: 'remove_item',
    xdgName: 'edit-delete-symbolic',
    gtkRole: 'Titel oder Auftrag entfernen',
    themeNote: 'Standard Action Icon',
  },
  {
    key: 'clear_list',
    xdgName: 'edit-clear-all-symbolic',
    gtkRole: 'Abgeschlossene Jobs leeren',
    themeNote: 'Standard Action Icon',
  },
  {
    key: 'settings',
    xdgName: 'preferences-system-symbolic',
    gtkRole: 'Encoder- & Paranoia-Optionen',
    themeNote: 'System Categories',
  },
  {
    key: 'status_ok',
    xdgName: 'emblem-ok-symbolic',
    gtkRole: 'Export erfolgreich verifiziert',
    themeNote: 'Standard Emblem',
  },
  {
    key: 'status_warn',
    xdgName: 'dialog-warning-symbolic',
    gtkRole: 'Fehlende Metadaten / Jitter-Hinweis',
    themeNote: 'Standard Status Icon',
  },
  {
    key: 'status_error',
    xdgName: 'dialog-error-symbolic',
    gtkRole: 'Lesefehler oder fehlender Codec',
    themeNote: 'Standard Status Icon',
  },
  {
    key: 'drag_handle',
    xdgName: 'list-drag-handle-symbolic',
    gtkRole: 'Drag-and-Drop Griff für Tracks',
    themeNote: 'GTK4 List Row Affordance',
  },
  {
    key: 'batch_queue',
    xdgName: 'view-list-symbolic',
    gtkRole: 'Stapelverarbeitungs-Ansicht',
    themeNote: 'Standard View Icon',
  },
  {
    key: 'scanner',
    xdgName: 'scanner-symbolic',
    gtkRole: 'CD-Booklet direkt über SANE einscannen',
    themeNote: 'Mint-Y / Adwaita Devices',
  },
  {
    key: 'open_file',
    xdgName: 'document-open-symbolic',
    gtkRole: 'Cover-Bilddatei von Festplatte wählen',
    themeNote: 'Standard Action Icon',
  },
  {
    key: 'barcode_qr',
    xdgName: 'view-barcode-symbolic',
    gtkRole: 'Barcode (EAN/UPC) & QR-Code per Webcam scannen',
    themeNote: 'Mint-Y / Adwaita Action Icon',
  },
  {
    key: 'shazam',
    xdgName: 'audio-input-microphone-symbolic',
    gtkRole: 'Shazam Track-Erkennung (Audio-Fingerprint & Katalog ohne API-Key)',
    themeNote: 'Mint-Y / Adwaita Audio Action Icon',
  },
  {
    key: 'apply_arrow',
    xdgName: 'go-next-symbolic',
    gtkRole: 'Feldwert auf alle Tracks übertragen / Aktion ausführen',
    themeNote: 'Mint-Y / Adwaita Navigation Action Icon',
  },
  {
    key: 'classical_album',
    xdgName: 'applications-multimedia-symbolic',
    gtkRole: 'Klassikalbum-Modus (Komponist, Orchester, Dirigent)',
    themeNote: 'Mint-Y / Adwaita Multimedia Category',
  },
  {
    key: 'verify_artists',
    xdgName: 'avatar-default-symbolic',
    gtkRole: 'Interpreten-, Komponisten- & Dirigentennamen prüfen & internationalisieren',
    themeNote: 'Mint-Y / Adwaita Action / User Icon',
  },
  {
    key: 'verify_orchestra',
    xdgName: 'system-users-symbolic',
    gtkRole: 'Orchesternamen prüfen & internationalisieren',
    themeNote: 'Mint-Y / Adwaita Action / Group Icon',
  },
  {
    key: 'split_artists',
    xdgName: 'edit-cut-symbolic',
    gtkRole: 'Interpretensplitter (verkettete Interpreten & Titel-Features trennen)',
    themeNote: 'Standard Action Icon',
  },
  {
    key: 'crop_cover',
    xdgName: 'edit-cut-symbolic',
    gtkRole: 'Geladenes Cover-Bild im Vollbild-Modal frei oder quadratisch beschneiden',
    themeNote: 'Standard Edit Action Icon (Schere)',
  },
  {
    key: 'scale_cover',
    xdgName: 'zoom-fit-best-symbolic',
    gtkRole: 'Geladenes Cover-Bild im Modal quadratisch oder auf freie Maße skalieren',
    themeNote: 'Standard Scale / Resize Action Icon',
  },
  {
    key: 'save_cover',
    xdgName: 'document-save-symbolic',
    gtkRole: 'Geladenes Cover-Bild manuell als Bilddatei speichern',
    themeNote: 'Standard Save Action Icon (Diskette)',
  },
  {
    key: 'media_play',
    xdgName: 'media-playback-start-symbolic',
    gtkRole: 'Titel in der Spurliste vorhören / abspielen',
    themeNote: 'Media Playback Controls',
  },
  {
    key: 'media_stop',
    xdgName: 'media-playback-stop-symbolic',
    gtkRole: 'Titel-Wiedergabe in der Spurliste stoppen',
    themeNote: 'Media Playback Controls',
  },
  {
    key: 'home_start',
    xdgName: 'go-home-symbolic',
    gtkRole: 'Zurück zur Modul-Startseite wechseln',
    themeNote: 'Standard Navigation Icon',
  },
  {
    key: 'back_arrow',
    xdgName: 'go-previous-symbolic',
    gtkRole: 'Aus einem Modul zurück zur Startseite kehren',
    themeNote: 'Standard Navigation Icon',
  },
  {
    key: 'module_tag',
    xdgName: 'emblem-documents-symbolic',
    gtkRole: 'Modul 3: Album Taggen (MusicBrainz Picard Tags)',
    themeNote: 'Mint-Y / Adwaita Emblem & Metadata',
  },
  {
    key: 'module_convert',
    xdgName: 'media-playlist-repeat-symbolic',
    gtkRole: 'Modul 4: Musik konvertieren',
    themeNote: 'Media Action Icon',
  },
  {
    key: 'module_repair',
    xdgName: 'preferences-other-symbolic',
    gtkRole: 'Modul 5: Musik reparieren',
    themeNote: 'System Tool / Repair Icon',
  },
  {
    key: 'module_cut',
    xdgName: 'edit-cut-symbolic',
    gtkRole: 'Modul 6: Musik Schneiden',
    themeNote: 'Standard Edit Action Icon',
  },
];

const ICON_MAP: Record<SystemIconKey, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  optical_drive: Disc3,
  audio_track: Music,
  music_folder: FolderOpen,
  cover_image: ImageIcon,
  search_online: Search,
  provider_musicbrainz: Globe,
  provider_discogs: Disc,
  provider_amazon: ShoppingBag,
  refresh_disc: RefreshCw,
  eject_disc: ArrowUpFromLine,
  close_tray: ArrowDownToLine,
  start_rip: Play,
  pause_batch: Pause,
  stop_batch: Square,
  save_export: Save,
  add_files: Plus,
  remove_item: Trash2,
  clear_list: Eraser,
  settings: Settings,
  status_ok: Check,
  status_warn: AlertTriangle,
  status_error: AlertCircle,
  drag_handle: GripVertical,
  batch_queue: ListOrdered,
  scanner: FlatbedScannerIcon,
  open_file: FolderUp,
  barcode_qr: QrCode,
  shazam: AudioWaveform,
  apply_arrow: ArrowRight,
  classical_album: Music2,
  verify_artists: UserCheck,
  verify_orchestra: Users,
  split_artists: Scissors,
  crop_cover: Scissors,
  scale_cover: Maximize2,
  save_cover: Save,
  media_play: Play,
  media_stop: Square,
  home_start: Home,
  back_arrow: ArrowLeft,
  module_tag: Tags,
  module_convert: Repeat,
  module_repair: Wrench,
  module_cut: Scissors,
};

export function SystemIcon({
  name,
  className = 'w-4 h-4',
}: {
  name: SystemIconKey;
  className?: string;
}) {
  const IconComponent = ICON_MAP[name];
  const spec = SYSTEM_ICON_SPECS.find((s) => s.key === name);
  return (
    <IconComponent
      className={`${className} shrink-0`}
      strokeWidth={1.75}
      aria-hidden="true"
      data-xdg-icon={spec?.xdgName}
    />
  );
}
