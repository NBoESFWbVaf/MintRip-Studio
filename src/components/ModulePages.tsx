import React from 'react';
import { SystemIcon, SystemIconKey } from './SystemIcons';

export type AppModuleId =
  | 'home'
  | 'module_cover'
  | 'module_rip'
  | 'module_tag'
  | 'module_convert'
  | 'module_repair'
  | 'module_cut'
  | 'settings'
  | 'batch'
  | 'icons'
  | 'source';

export interface ModuleCardSpec {
  id: 'module_cover' | 'module_rip' | 'module_tag' | 'module_convert' | 'module_repair' | 'module_cut';
  numberLabel: string;
  title: string;
  subtitle: string;
  description: string;
  icon: SystemIconKey;
  available: boolean;
  statusText: string;
  highlights: string[];
}

export const MODULE_SPECS: ModuleCardSpec[] = [
  {
    id: 'module_cover',
    numberLabel: '01. Modul',
    title: 'Coverbild beziehen',
    subtitle: 'Multi-Provider-Coversuche, SANE-Scanner, Zuschnitt & Speichern',
    description:
      'Sucht Coverbilder parallel über MusicBrainz CAA (Release & Release-Group), Deezer, TheAudioDB, Bandcamp, iTunes (DE & Multi-Region), Discogs und Amazon (in den Einstellungen einzeln auswählbar) mit tabellarischer Vorschau und Großansicht. Unterstützt lokales Laden, Booklet-Scan, freien oder quadratischen Zuschnitt (Schere) und manuelles Speichern (Diskette).',
    icon: 'cover_image',
    available: true,
    statusText: 'Aktiv · Bereit',
    highlights: [
      'Alle Provider gleichzeitig abfragen (Tabellarische Trefferliste & Vollbild-Zoom)',
      'Interaktiver Beschneidungsrahmen (Schere) & Speichern-unter-Dialog (Diskette)',
      'SANE-Flachbettscanner & Drag-and-Drop Bildimport',
    ],
  },
  {
    id: 'module_rip',
    numberLabel: '02. Modul',
    title: 'CD-Rippen',
    subtitle: 'Bitgenaues Audio-CD-Auslesen, Online-Metadaten & FLAC/MP3-Export',
    description:
      'Liest physische Audio-CDs über cdparanoia aus, ermittelt Metadaten über MusicBrainz, Discogs und CDDB/GnuDB, normalisiert auf Wunsch nach EBU R128 und kodiert verlustfrei nach FLAC oder LAME MP3.',
    icon: 'optical_drive',
    available: true,
    statusText: 'Aktiv · Komplett-Arbeitsbereich',
    highlights: [
      'Physisches CD-Laufwerk mit TOC-Erkennung & automatischem Auswurf nach Rip',
      'MusicBrainz, Discogs (inkl. [r...]-Codes) & CDDB Abfrage mit Trefferauswahl',
      'Mehrspur-Stapelverarbeitung, EBU-R128-Normalisierung & CUE/Bash-Export',
    ],
  },
  {
    id: 'module_tag',
    numberLabel: '03. Modul',
    title: 'Album Taggen',
    subtitle: 'Offizielle MusicBrainz-Picard-Tags & direktes Schreiben in Dateien',
    description:
      'Importiert bestehende Album-Ordner, identifiziert Alben per virtueller TOC oder Shazam-Audio-Fingerprinting und schreibt offizielle MusicBrainz-Picard-Tags sowie Coverbilder direkt in FLAC- sowie alle ID3v2.3/v2.4-Formate (MP3, MP2, WAV, AIFF/AIF/AIFC, DSF, TTA).',
    icon: 'module_tag',
    available: true,
    statusText: 'Aktiv · Direkt-Tagger & Ausbau',
    highlights: [
      'Direkter Schreibvorgang („Tags in Dateien schreiben“) ohne Re-Rip oder Neukodierung',
      'Strikte MusicBrainz-Picard-Tag-Konformität (FLAC Vorbis Comments sowie ID3v2.3/v2.4 für MP3, WAV, AIFF, DSF, TTA, MP2)',
      'Klassikalbum-Modus, Interpretensplitter & Shazam-Titelerkennung',
    ],
  },
  {
    id: 'module_convert',
    numberLabel: '04. Modul',
    title: 'Musik konvertieren',
    subtitle: 'Einzeldateien & rekursive Ordner zwischen FLAC, MP3, WAV, Opus, Ogg, M4A & AIFF wandeln',
    description:
      'Importiert sowohl einzelne Audiodateien als auch ganze Verzeichnisbäume rekursiv, behält auf Wunsch Ordnerstruktur, Metadaten sowie Coverbilder bei und konvertiert über ffmpeg in alle gängigen Formate.',
    icon: 'module_convert',
    available: true,
    statusText: 'Aktiv · Konverter (Entwurf)',
    highlights: [
      'Einzeldatei-Auswahl, rekursiver Ordner-Import und rekursives Drag & Drop',
      'Konvertierung nach FLAC, MP3 (ID3v2.3/v2.4), WAV, Ogg Opus, Ogg Vorbis, M4A (AAC) und AIFF',
      'Optionale Übernahme von Ordnerstruktur, Tags/Coverbild und EBU-R128-Normalisierung',
    ],
  },
  {
    id: 'module_repair',
    numberLabel: '05. Modul',
    title: 'Musik reparieren',
    subtitle: 'MP3-Xing/Frame-Diagnose, ID3-Bereinigung, FLAC-MD5 & Header-Reparatur',
    description:
      'Prüft Einzeldateien oder ganze Ordner rekursiv auf fehlende VBR/Xing-Header, gestapelte ID3v2-Blöcke, defekte MPEG-Sync-Frames, FLAC-MD5-Prüfsummen sowie digitales Clipping und repariert Container und Header verlustfrei.',
    icon: 'module_repair',
    available: true,
    statusText: 'Aktiv · Diagnose & Reparatur (Entwurf)',
    highlights: [
      'Binäre Diagnose: MP3 VBR/Xing-Header, Frame-Sync-Lücken, Müll-Bytes & doppelte ID3v2-Tags',
      'FLAC-MD5/Seektable-Neuaufbau (2-Schritt über WAV) & WAV/AIFF-Chunkgrößen-Korrektur',
      'Optionale Tiefenprüfung (Bitstream-Dekodiertest & Clipping-Analyse) mit Vorher/Nachher-Ansicht',
    ],
  },
  {
    id: 'module_cut',
    numberLabel: '06. Modul',
    title: 'Musik Schneiden',
    subtitle: 'Präziser Audio-Zuschnitt, CUE-Splitter & Stille-Erkennung',
    description:
      'Schneidet Einzelaufnahmen oder Gesamtdatenströme verlustfrei anhand von CUE-Sheets oder automatischer Pausen-Erkennung in Einzeltitel, entfernt Vor-/Nachlaufstille und trennt Hidden Tracks.',
    icon: 'module_cut',
    available: false,
    statusText: 'Freigehalten für spätere Erweiterung',
    highlights: [
      'Samplegenaues Aufteilen von Gesamtaufnahmen mittels CUE-Sheet',
      'Automatische Stille-Erkennung an Trackgrenzen sowie Trimmen von Pausen',
      'Verlustfreies Ein- und Ausblenden (Fade-In / Fade-Out) bei Live-Mitschnitten',
    ],
  },
];

interface StartPageLauncherProps {
  onSelectModule: (moduleId: AppModuleId) => void;
  activeAlbumTitle?: string;
  activeAlbumArtist?: string;
  trackCount: number;
  hasCover: boolean;
  batchCount: number;
}

export function StartPageLauncher({
  onSelectModule,
  activeAlbumTitle,
  activeAlbumArtist,
  trackCount,
  hasCover,
  batchCount,
}: StartPageLauncherProps) {
  return (
    <div className="w-full max-w-[820px] mx-auto my-auto space-y-3.5">
      {/* Kompakter Kopfbereich der Startseite */}
      <div className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md border border-[#5BA632]/40 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] flex items-center justify-center shrink-0">
            <SystemIcon name="optical_drive" className="w-6 h-6" />
          </div>
          <div className="space-y-0.5">
            <div className="text-[11px] font-medium text-[#57606A] dark:text-[#8B949E]">
              MintRip Studio · Modulare Audio-Arbeitsumgebung
            </div>
            <h1 className="text-base font-bold tracking-tight text-[#1F2328] dark:text-[#EAEEF2]">
              Startseite — Modul auswählen
            </h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-[11px] text-[#57606A] dark:text-[#8B949E] font-mono tabular-nums">
          <div>
            <span>Album: </span>
            <strong className="text-[#1F2328] dark:text-[#EAEEF2]">
              {activeAlbumTitle
                ? `${activeAlbumArtist ? `${activeAlbumArtist} – ` : ''}${activeAlbumTitle}`
                : 'Kein Album'}
            </strong>
          </div>
          <span aria-hidden="true">·</span>
          <div>
            <span>Titel: </span>
            <strong className="text-[#1F2328] dark:text-[#EAEEF2]">{trackCount}</strong>
          </div>
          <span aria-hidden="true">·</span>
          <div>
            <span>Cover: </span>
            <strong className="text-[#1F2328] dark:text-[#EAEEF2]">{hasCover ? 'Vorhanden' : '—'}</strong>
          </div>
          {batchCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <div>
                <span>Warteschlange: </span>
                <strong className="text-[#2E6B14] dark:text-[#9BE270]">{batchCount}</strong>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 6 Modulkacheln im 3x2 Raster + eigene Kachel für Einstellungen */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-stretch">
        {MODULE_SPECS.map((mod) => (
          <button
            key={mod.id}
            type="button"
            onClick={() => onSelectModule(mod.id)}
            className={`group text-left rounded-lg border p-3 flex flex-col justify-between gap-2.5 transition-colors cursor-pointer ${
              mod.available
                ? 'bg-white dark:bg-[#25292E] border-[#D0D7DE] dark:border-[#343A40] hover:border-[#5BA632] dark:hover:border-[#69B53F]'
                : 'bg-white/85 dark:bg-[#25292E]/80 border-[#E1E4E8] dark:border-[#343A40] hover:border-[#8C959F] dark:hover:border-[#57606A]'
            }`}
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <div
                  className={`w-10 h-10 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
                    mod.available
                      ? 'border-[#5BA632]/40 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] group-hover:bg-[#5BA632] group-hover:text-white'
                      : 'border-[#D0D7DE] dark:border-[#444C56] bg-[#F4F5F6] dark:bg-[#1C1F23] text-[#57606A] dark:text-[#8B949E]'
                  }`}
                >
                  <SystemIcon name={mod.icon} className="w-6 h-6" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] font-mono text-[#57606A] dark:text-[#8B949E] truncate">
                    {mod.numberLabel} · {mod.statusText}
                  </div>
                  <h2 className="text-base font-bold leading-snug text-[#1F2328] dark:text-[#EAEEF2] group-hover:text-[#2E6B14] dark:group-hover:text-[#9BE270] transition-colors truncate">
                    {mod.title}
                  </h2>
                </div>
              </div>

              <div className="text-[11px] font-semibold text-[#1F2328] dark:text-[#EAEEF2] line-clamp-1">
                {mod.subtitle}
              </div>

              <p className="text-[11px] text-[#57606A] dark:text-[#8B949E] leading-snug line-clamp-3">
                {mod.description}
              </p>
            </div>

            <div className="pt-2 border-t border-[#E1E4E8] dark:border-[#343A40] flex items-center justify-between gap-2">
              <span
                className={`text-[11px] font-semibold ${
                  mod.available
                    ? 'text-[#2E6B14] dark:text-[#9BE270]'
                    : 'text-[#57606A] dark:text-[#8B949E]'
                }`}
              >
                {mod.available ? `${mod.title} öffnen` : 'Modul-Vorschau öffnen'}
              </span>
              <SystemIcon
                name="apply_arrow"
                className={`w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5 ${
                  mod.available
                    ? 'text-[#2E6B14] dark:text-[#9BE270]'
                    : 'text-[#57606A] dark:text-[#8B949E]'
                }`}
              />
            </div>
          </button>
        ))}

        {/* Eigene Kachel für die Einstellungen auf der Startseite (gleiche Größe wie alle anderen Kacheln) */}
        <button
          type="button"
          onClick={() => onSelectModule('settings')}
          className="group text-left rounded-lg border p-3 flex flex-col justify-between gap-2.5 transition-colors cursor-pointer bg-white dark:bg-[#25292E] border-[#D0D7DE] dark:border-[#343A40] hover:border-[#5BA632] dark:hover:border-[#69B53F]"
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-md border border-[#5BA632]/40 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] group-hover:bg-[#5BA632] group-hover:text-white flex items-center justify-center shrink-0 transition-colors">
                <SystemIcon name="settings" className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-mono text-[#57606A] dark:text-[#8B949E] truncate">
                  System · Eigene Seite
                </div>
                <h2 className="text-base font-bold leading-snug text-[#1F2328] dark:text-[#EAEEF2] group-hover:text-[#2E6B14] dark:group-hover:text-[#9BE270] transition-colors truncate">
                  Einstellungen
                </h2>
              </div>
            </div>

            <div className="text-[11px] font-semibold text-[#1F2328] dark:text-[#EAEEF2] line-clamp-1">
              Speicherort, Formate, Normalisierung &amp; Scanner
            </div>

            <p className="text-[11px] text-[#57606A] dark:text-[#8B949E] leading-snug line-clamp-3">
              Speicherort, Pfad-Vorlagen, FLAC/MP3-Qualität, EBU-R128-Normalisierung, SANE-Scanner, Discogs-Token &amp; Protokoll konfigurieren.
            </p>
          </div>

          <div className="pt-2 border-t border-[#E1E4E8] dark:border-[#343A40] flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-[#2E6B14] dark:text-[#9BE270]">
              Einstellungen öffnen
            </span>
            <SystemIcon
              name="apply_arrow"
              className="w-3.5 h-3.5 text-[#2E6B14] dark:text-[#9BE270] transition-transform group-hover:translate-x-0.5"
            />
          </div>
        </button>
      </div>
    </div>
  );
}

interface ModulePageHeaderBarProps {
  moduleNumber: string;
  title: string;
  subtitle: string;
  icon: SystemIconKey;
  onBackToHome?: () => void;
  disabled?: boolean;
  rightSlot?: React.ReactNode;
  rightSlotClassName?: string;
}

export function ModulePageHeaderBar({
  moduleNumber,
  title,
  subtitle,
  icon,
  rightSlot,
  rightSlotClassName,
}: ModulePageHeaderBarProps) {
  return (
    <div className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg px-4 py-3 flex flex-wrap md:flex-nowrap items-center justify-between gap-4">
      <div className="flex items-center gap-3.5 min-w-0 flex-1">
        <div className="w-12 h-12 rounded-md border border-[#5BA632]/40 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] flex items-center justify-center shrink-0">
          <SystemIcon name={icon} className="w-8 h-8" />
        </div>
        <div className="min-w-0 flex flex-col justify-center">
          <h2 className="text-lg font-bold leading-snug text-[#1F2328] dark:text-[#EAEEF2] truncate">
            {moduleNumber ? `${moduleNumber} · ${title}` : title}
          </h2>
          <p className="text-xs text-[#57606A] dark:text-[#8B949E] mt-0.5 leading-snug truncate">
            {subtitle}
          </p>
        </div>
      </div>

      {rightSlot && (
        <div
          className={
            rightSlotClassName || 'flex flex-wrap items-center gap-2 shrink-0'
          }
        >
          {rightSlot}
        </div>
      )}
    </div>
  );
}

interface ReservedModulePageProps {
  spec: ModuleCardSpec;
  targetFolder?: string;
  onBackToHome?: () => void;
  onSelectModule: (moduleId: AppModuleId) => void;
}

export function ReservedModulePage({
  spec,
  targetFolder,
  onSelectModule,
}: ReservedModulePageProps) {
  return (
    <div className="space-y-6">
      <ModulePageHeaderBar
        moduleNumber={spec.numberLabel}
        title={spec.title}
        subtitle={spec.subtitle}
        icon={spec.icon}
      />

      <div className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg p-8 space-y-6">
        <div className="max-w-3xl space-y-3">
          <div className="text-xs font-mono text-[#57606A] dark:text-[#8B949E]">
            {spec.numberLabel} · Status: {spec.statusText}
            {targetFolder ? ` · Zielordner: ${targetFolder}` : ''}
          </div>
          <h2 className="text-2xl font-bold text-[#1F2328] dark:text-[#EAEEF2]">
            {spec.title}
          </h2>
          <p className="text-sm text-[#57606A] dark:text-[#8B949E] leading-relaxed">
            {spec.description}
          </p>
        </div>

        <div className="p-5 rounded-lg border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23] space-y-3">
          <h3 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
            Vorgesehene Funktionsbausteine in diesem Modul:
          </h3>
          <ul className="space-y-2 text-xs text-[#57606A] dark:text-[#8B949E]">
            {spec.highlights.map((item, idx) => (
              <li key={idx} className="flex items-start gap-2.5">
                <span className="font-mono text-[#2E6B14] dark:text-[#9BE270] shrink-0">
                  0{idx + 1}.
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="pt-4 border-t border-[#E1E4E8] dark:border-[#343A40] flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-[#57606A] dark:text-[#8B949E]">
            Aktive Module direkt öffnen:
          </span>
          <button
            type="button"
            onClick={() => onSelectModule('module_cover')}
            className="px-3 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] transition-colors cursor-pointer whitespace-nowrap"
          >
            Modul 1: Coverbild beziehen
          </button>
          <button
            type="button"
            onClick={() => onSelectModule('module_rip')}
            className="px-3 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] transition-colors cursor-pointer whitespace-nowrap"
          >
            Modul 2: CD-Rippen
          </button>
          <button
            type="button"
            onClick={() => onSelectModule('module_tag')}
            className="px-3 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] transition-colors cursor-pointer whitespace-nowrap"
          >
            Modul 3: Album Taggen
          </button>
        </div>
      </div>
    </div>
  );
}
