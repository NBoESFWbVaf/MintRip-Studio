import React, { useEffect, useRef, useState } from 'react';
import {
  COVER_PROVIDER_OPTIONS,
  CoverProviderSettingId,
  DEFAULT_COVER_MAX_DIMENSION,
  DEFAULT_COVER_PROVIDERS,
  DEFAULT_MAX_THREADS,
  DEFAULT_MODULE_OUTPUT_DIRS,
  DEFAULT_MUSICBRAINZ_SERVER_URL,
  DEFAULT_VISIBLE_LEFT_TAG_FIELDS,
  ExportSettings,
  LeftTagFieldCategory,
  Mp3QualityMode,
  MUSICBRAINZ_LEFT_TAG_FIELDS,
  normalizeCoverMaxDimension,
  normalizeCoverProviders,
  normalizeMaxThreads,
  normalizeMusicBrainzServerUrl,
  normalizeShazamSampleSize,
  ParanoiaMode,
  SHAZAM_SAMPLE_SIZE_OPTIONS,
} from '../types/mintrip';
import { pickDirectoryWithPersistence, saveLastImportDirHandle } from '../utils/folderImportHelper';
import { SystemIcon, SystemIconKey } from './SystemIcons';
import { ModulePageHeaderBar } from './ModulePages';

interface SettingsSharedProps {
  settings: ExportSettings;
  onSettingsChange: React.Dispatch<React.SetStateAction<ExportSettings>>;
  themeMode: 'system' | 'light' | 'dark';
  onThemeModeChange: (mode: 'system' | 'light' | 'dark') => void;
}

interface SettingsModalProps extends SettingsSharedProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SettingsPageProps extends SettingsSharedProps {
  onBackToHome: () => void;
}

type SettingsTabId = 'storage' | 'format' | 'tag_fields' | 'normalization' | 'drive_cover';

const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string; icon: SystemIconKey }> = [
  { id: 'storage', label: 'Speicherort & Benennung', icon: 'music_folder' },
  { id: 'format', label: 'Format & Tagging', icon: 'audio_track' },
  { id: 'tag_fields', label: 'Tag-Felder (MusicBrainz)', icon: 'module_tag' },
  { id: 'normalization', label: 'Normalisierung', icon: 'settings' },
  { id: 'drive_cover', label: 'Cover, Scanner & Laufwerk', icon: 'scanner' },
];

const TAG_CATEGORY_LABELS: Record<LeftTagFieldCategory, string> = {
  basis: 'Basis-Tags & Sortierung',
  release: 'Veröffentlichung & Medium',
  credits: 'Beteiligte, Klassik & Werk (mit Pfeil auf markierte Tracks)',
  identifiers: 'Identifikatoren & Katalog-IDs',
};

const TEMPLATE_PRESETS: Array<{ label: string; value: string }> = [
  {
    label: 'Standard (Interpret / Jahr - Album / Nr - Titel)',
    value: '{album_artist}/{year} - {album}/{track} - {title}',
  },
  {
    label: 'Multi-CD (Interpret / Jahr - Album / CD Nr / Nr - Titel)',
    value: '{album_artist}/{year} - {album}/CD {disc}/{track} - {title}',
  },
  {
    label: 'Kompakt (Interpret / Album / CD-Track - Titel)',
    value: '{album_artist}/{album}/{disc}-{track} - {title}',
  },
  {
    label: 'Nach Genre (Genre / Interpret / Jahr - Album / Nr - Titel)',
    value: '{genre}/{album_artist}/{year} - {album}/{track} - {title}',
  },
  {
    label: 'Archiv (Interpret / Jahr - Album [Label Kat.-Nr.] / Nr - Titel)',
    value: '{album_artist}/{year} - {album} [{label} {catno}]/{track} - {title}',
  },
  {
    label: 'Compilation / Sampler (Album (Jahr) / CD-Track - Künstler - Titel)',
    value: '{album} ({year})/{disc}-{track} - {artist} - {title}',
  },
];

const TEMPLATE_VARIABLES: Array<{ token: string; label: string; hint: string }> = [
  { token: '{album_artist}', label: 'Album-Interpret', hint: 'Name des Album-Interpreten (z. B. Kraftwerk)' },
  { token: '{artist}', label: 'Künstler', hint: 'Interpret des einzelnen Titels' },
  { token: '{artist_sort}', label: 'Sortiername', hint: 'Sortiername des Interpreten' },
  { token: '{album}', label: 'Album', hint: 'Albumtitel (z. B. Computerwelt)' },
  { token: '{track}', label: 'Track-Nr.', hint: 'Titelnummer (automatisch 2- oder 3-stellig, z. B. 01)' },
  { token: '{total_tracks}', label: 'Gesamt-Tracks', hint: 'Gesamtanzahl der Titel (z. B. 07)' },
  { token: '{title}', label: 'Titel', hint: 'Name des Musikstücks' },
  { token: '{disc}', label: 'CD-Nr.', hint: 'CD-Nummer (automatisch 2- oder 3-stellig, z. B. 01)' },
  { token: '{total_discs}', label: 'Gesamt-CDs', hint: 'Gesamtanzahl der CDs des Releases' },
  { token: '{disc_subtitle}', label: 'CD-Untertitel', hint: 'Untertitel der jeweiligen CD' },
  { token: '{year}', label: 'Jahr', hint: 'Erscheinungsjahr (4-stellig, z. B. 1981)' },
  { token: '{original_year}', label: 'Erst-Jahr', hint: 'Jahr der Erstveröffentlichung' },
  { token: '{date}', label: 'Datum', hint: 'Vollständiges Veröffentlichungsdatum (z. B. 1981-05-10)' },
  { token: '{genre}', label: 'Hauptgenre', hint: 'Erstes Genre des Albums (z. B. Electro)' },
  { token: '{label}', label: 'Label', hint: 'Plattenlabel (z. B. Kling Klang)' },
  { token: '{catno}', label: 'Katalog-Nr.', hint: 'Katalognummer des Releases' },
  { token: '{barcode}', label: 'Barcode', hint: 'EAN/UPC-Barcode' },
  { token: '{country}', label: 'Land', hint: 'Erscheinungsland (z. B. DE)' },
  { token: '{media}', label: 'Medium', hint: 'Medienformat (z. B. CD)' },
  { token: '{isrc}', label: 'ISRC', hint: 'ISRC-Code des Titels' },
  { token: '{composer}', label: 'Komponist', hint: 'Komponist des Titels' },
  { token: '{format}', label: 'Format', hint: 'Ausgabeformat (FLAC oder MP3)' },
  { token: '/', label: '/ Ordner', hint: 'Neuer Unterordner (Pfadtrenner)' },
  { token: ' - ', label: ' - ', hint: 'Bindestrich mit Leerzeichen' },
  { token: '_', label: '_', hint: 'Unterstrich' },
];

const COVER_VARIABLES: Array<{ token: string; label: string; mode: 'replace' | 'insert' }> = [
  { token: 'cover', label: 'cover', mode: 'replace' },
  { token: 'folder', label: 'folder', mode: 'replace' },
  { token: 'front', label: 'front', mode: 'replace' },
  { token: '{album}', label: '{album}', mode: 'insert' },
  { token: '{album_artist}', label: '{album_artist}', mode: 'insert' },
  { token: '{year}', label: '{year}', mode: 'insert' },
  { token: '{disc}', label: '{disc}', mode: 'insert' },
  { token: '{label}', label: '{label}', mode: 'insert' },
];

function SettingsNotebookContent({
  settings,
  onSettingsChange,
  themeMode,
  onThemeModeChange,
  isPageMode = false,
}: SettingsSharedProps & { isPageMode?: boolean }) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>('storage');
  const [showDiscogsToken, setShowDiscogsToken] = useState(false);
  const [showLastfmKey, setShowLastfmKey] = useState(false);
  const [cacheStats, setCacheStats] = useState<{ entries: number; sizeBytes: number } | null>(null);
  const [isClearingCache, setIsClearingCache] = useState(false);
  const templateInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeTab !== 'drive_cover') return;
    let cancelled = false;
    fetch('/api/metadata/cache/stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.entries === 'number') {
          setCacheStats({ entries: data.entries, sizeBytes: Number(data.sizeBytes || 0) });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  const handleClearMetadataCache = async () => {
    setIsClearingCache(true);
    try {
      const resp = await fetch('/api/metadata/cache/clear', { method: 'POST' });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        setCacheStats({ entries: Number(data.entries || 0), sizeBytes: Number(data.sizeBytes || 0) });
      }
    } finally {
      setIsClearingCache(false);
    }
  };

  const insertIntoTemplate = (token: string) => {
    const input = templateInputRef.current;
    const current = settings.filenameTemplate || '';
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? current.length;
    const updated = current.slice(0, start) + token + current.slice(end);
    onSettingsChange((s) => ({ ...s, filenameTemplate: updated }));
    window.requestAnimationFrame(() => {
      if (input) {
        input.focus();
        const nextCursor = start + token.length;
        input.setSelectionRange(nextCursor, nextCursor);
      }
    });
  };

  const handleCoverTokenClick = (token: string, mode: 'replace' | 'insert') => {
    const input = coverInputRef.current;
    if (mode === 'replace') {
      onSettingsChange((s) => ({ ...s, coverFilename: token }));
      window.requestAnimationFrame(() => {
        if (input) {
          input.focus();
          input.setSelectionRange(token.length, token.length);
        }
      });
      return;
    }
    const current = settings.coverFilename || '';
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? current.length;
    const updated = current.slice(0, start) + token + current.slice(end);
    onSettingsChange((s) => ({ ...s, coverFilename: updated }));
    window.requestAnimationFrame(() => {
      if (input) {
        input.focus();
        const nextCursor = start + token.length;
        input.setSelectionRange(nextCursor, nextCursor);
      }
    });
  };

  const renderSamplePreview = () => {
    const ext = settings.exportFormat === 'mp3' ? 'mp3' : 'flac';
    const fmtUpper = ext.toUpperCase();
    const raw = (settings.filenameTemplate || '').trim() || '{album_artist}/{year} - {album}/{track} - {title}';
    const rendered = raw
      .replaceAll('{album_artist}', 'Kraftwerk')
      .replaceAll('{artist}', 'Kraftwerk')
      .replaceAll('{artist_sort}', 'Kraftwerk')
      .replaceAll('{album}', 'Computerwelt')
      .replaceAll('{track}', '01')
      .replaceAll('{total_tracks}', '07')
      .replaceAll('{title}', 'Computerwelt')
      .replaceAll('{disc}', '01')
      .replaceAll('{total_discs}', '01')
      .replaceAll('{disc_subtitle}', 'CD 01')
      .replaceAll('{year}', '1981')
      .replaceAll('{original_year}', '1981')
      .replaceAll('{date}', '1981-05-10')
      .replaceAll('{genre}', 'Electro')
      .replaceAll('{genres}', 'Electro; Synth-Pop')
      .replaceAll('{label}', 'Kling Klang')
      .replaceAll('{catno}', '1C 064-46 311')
      .replaceAll('{barcode}', '5099996602229')
      .replaceAll('{country}', 'DE')
      .replaceAll('{media}', 'CD')
      .replaceAll('{isrc}', 'DEAE68100101')
      .replaceAll('{composer}', 'Hütter')
      .replaceAll('{format}', fmtUpper);
    const baseDir = (
      settings.outputDirRip ||
      settings.outputDir ||
      DEFAULT_MODULE_OUTPUT_DIRS.outputDirRip
    ).replace(/\/+$/, '');
    return `${baseDir}/${rendered}.${ext}`;
  };

  const visibleFieldSet = new Set(
    Array.isArray(settings.visibleLeftTagFields)
      ? settings.visibleLeftTagFields
      : DEFAULT_VISIBLE_LEFT_TAG_FIELDS
  );

  const toggleLeftTagField = (fieldId: string, checked: boolean) => {
    onSettingsChange((s) => {
      const current = new Set(
        Array.isArray(s.visibleLeftTagFields)
          ? s.visibleLeftTagFields
          : DEFAULT_VISIBLE_LEFT_TAG_FIELDS
      );
      if (checked) {
        current.add(fieldId);
      } else {
        current.delete(fieldId);
      }
      const ordered = MUSICBRAINZ_LEFT_TAG_FIELDS.map((f) => f.id).filter((id) => current.has(id));
      return { ...s, visibleLeftTagFields: ordered };
    });
  };

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0">
      {/* Vertikale Reiter-Navigation */}
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label="Einstellungs-Rubriken"
        className="w-full md:w-56 shrink-0 p-2.5 border-b md:border-b-0 md:border-r border-[#E1E4E8] dark:border-[#343A40] bg-[#F4F5F6] dark:bg-[#1C1F23] flex flex-col gap-1"
      >
        {SETTINGS_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                isActive
                  ? 'bg-white dark:bg-[#25292E] border-[#E1E4E8] dark:border-[#343A40] border-l-2 border-l-[#5BA632] dark:border-l-[#69B53F] text-[#1F2328] dark:text-[#EAEEF2] shadow-xs'
                  : 'border-transparent text-[#57606A] dark:text-[#8B949E] hover:text-[#1F2328] dark:hover:text-[#EAEEF2] hover:bg-white/60 dark:hover:bg-[#25292E]/60'
              }`}
            >
              <SystemIcon
                name={tab.icon}
                className={`w-4 h-4 shrink-0 ${isActive ? 'text-[#5BA632] dark:text-[#69B53F]' : ''}`}
              />
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Reiter-Inhalt */}
      <div className={`p-5 text-xs flex-1 min-w-0 min-h-[380px] ${isPageMode ? '' : 'overflow-y-auto'}`}>
          {/* Reiter 1: Speicherort & Dateibenennung */}
          {activeTab === 'storage' && (
            <section role="tabpanel" className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                    Zielordner je Modul &amp; Dateibenennung
                  </h3>
                  <p className="text-[11px] text-[#57606A] dark:text-[#8B949E] mt-0.5">
                    Konfiguriere die Ausgabe-/Zielordner für jedes Modul separat sowie das Benennungsschema für Unterordner und Audiodateien.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onSettingsChange((s) => ({
                      ...s,
                      outputDir: DEFAULT_MODULE_OUTPUT_DIRS.outputDirRip,
                      outputDirCover: DEFAULT_MODULE_OUTPUT_DIRS.outputDirCover,
                      outputDirRip: DEFAULT_MODULE_OUTPUT_DIRS.outputDirRip,
                      outputDirTag: DEFAULT_MODULE_OUTPUT_DIRS.outputDirTag,
                      outputDirConvert: DEFAULT_MODULE_OUTPUT_DIRS.outputDirConvert,
                      outputDirRepair: DEFAULT_MODULE_OUTPUT_DIRS.outputDirRepair,
                      outputDirCut: DEFAULT_MODULE_OUTPUT_DIRS.outputDirCut,
                    }))
                  }
                  className="px-2.5 py-1 text-[11px] font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] hover:border-[#5BA632] text-[#1F2328] dark:text-[#EAEEF2] cursor-pointer"
                >
                  Standardpfade wiederherstellen
                </button>
              </div>

              <div className="p-3 rounded-md border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA]/70 dark:bg-[#1C1F23]/60 space-y-2.5">
                <div className="text-[11px] font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  Ausgabe-/Zielordner für jedes Modul separat festlegen:
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="block space-y-1">
                    <span className="flex items-center gap-1.5 text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      <SystemIcon name="cover_image" className="w-3.5 h-3.5 text-[#5BA632]" />
                      <span>Modul 1 · Coverbild beziehen</span>
                    </span>
                    <input
                      type="text"
                      value={settings.outputDirCover ?? DEFAULT_MODULE_OUTPUT_DIRS.outputDirCover}
                      onChange={(e) =>
                        onSettingsChange((s) => ({
                          ...s,
                          outputDirCover: e.target.value,
                          lastCoverFolder: e.target.value,
                        }))
                      }
                      placeholder={DEFAULT_MODULE_OUTPUT_DIRS.outputDirCover}
                      className="w-full px-2.5 py-1.5 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="flex items-center gap-1.5 text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      <SystemIcon name="optical_drive" className="w-3.5 h-3.5 text-[#5BA632]" />
                      <span>Modul 2 · CD-Rippen</span>
                    </span>
                    <input
                      type="text"
                      value={
                        settings.outputDirRip ??
                        settings.outputDir ??
                        DEFAULT_MODULE_OUTPUT_DIRS.outputDirRip
                      }
                      onChange={(e) =>
                        onSettingsChange((s) => ({
                          ...s,
                          outputDirRip: e.target.value,
                          outputDir: e.target.value,
                        }))
                      }
                      placeholder={DEFAULT_MODULE_OUTPUT_DIRS.outputDirRip}
                      className="w-full px-2.5 py-1.5 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="flex items-center gap-1.5 text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      <SystemIcon name="module_tag" className="w-3.5 h-3.5 text-[#5BA632]" />
                      <span>Modul 3 · Album Taggen</span>
                    </span>
                    <input
                      type="text"
                      value={settings.outputDirTag ?? DEFAULT_MODULE_OUTPUT_DIRS.outputDirTag}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, outputDirTag: e.target.value }))
                      }
                      placeholder={DEFAULT_MODULE_OUTPUT_DIRS.outputDirTag}
                      className="w-full px-2.5 py-1.5 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="flex items-center gap-1.5 text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      <SystemIcon name="module_convert" className="w-3.5 h-3.5 text-[#5BA632]" />
                      <span>Modul 4 · Musik konvertieren</span>
                    </span>
                    <input
                      type="text"
                      value={settings.outputDirConvert ?? DEFAULT_MODULE_OUTPUT_DIRS.outputDirConvert}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, outputDirConvert: e.target.value }))
                      }
                      placeholder={DEFAULT_MODULE_OUTPUT_DIRS.outputDirConvert}
                      className="w-full px-2.5 py-1.5 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="flex items-center gap-1.5 text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      <SystemIcon name="module_repair" className="w-3.5 h-3.5 text-[#5BA632]" />
                      <span>Modul 5 · Musik reparieren</span>
                    </span>
                    <input
                      type="text"
                      value={settings.outputDirRepair ?? DEFAULT_MODULE_OUTPUT_DIRS.outputDirRepair}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, outputDirRepair: e.target.value }))
                      }
                      placeholder={DEFAULT_MODULE_OUTPUT_DIRS.outputDirRepair}
                      className="w-full px-2.5 py-1.5 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="flex items-center gap-1.5 text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      <SystemIcon name="module_cut" className="w-3.5 h-3.5 text-[#5BA632]" />
                      <span>Modul 6 · Musik Schneiden</span>
                    </span>
                    <input
                      type="text"
                      value={settings.outputDirCut ?? DEFAULT_MODULE_OUTPUT_DIRS.outputDirCut}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, outputDirCut: e.target.value }))
                      }
                      placeholder={DEFAULT_MODULE_OUTPUT_DIRS.outputDirCut}
                      className="w-full px-2.5 py-1.5 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                  </label>
                </div>
              </div>

              <div className="space-y-1">
                <span className="text-[#57606A] dark:text-[#8B949E]">
                  Zuletzt gewähltes Import-Verzeichnis (dauerhaft für alle Module gespeichert)
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[200px]">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[#656D76]">
                      <SystemIcon name="open_file" className="w-3.5 h-3.5" />
                    </span>
                    <input
                      type="text"
                      value={settings.lastImportFolder || '~/Musik'}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, lastImportFolder: e.target.value }))
                      }
                      placeholder="~/Musik"
                      className="w-full pl-7 pr-2 py-1.5 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      const picked = await pickDirectoryWithPersistence({ readFiles: false });
                      if (picked.status === 'picked') {
                        onSettingsChange((s) => ({ ...s, lastImportFolder: picked.folderName }));
                      }
                    }}
                    className="px-2.5 py-1.5 text-[11px] font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] hover:border-[#5BA632] text-[#1F2328] dark:text-[#EAEEF2] cursor-pointer"
                  >
                    Import-Ordner wählen...
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void saveLastImportDirHandle(null);
                      onSettingsChange((s) => ({ ...s, lastImportFolder: '~/Musik' }));
                    }}
                    className="px-2 py-1.5 text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#57606A] dark:text-[#8B949E] hover:text-[#1F2328] dark:hover:text-[#EAEEF2] cursor-pointer"
                  >
                    Zurücksetzen
                  </button>
                </div>
                <p className="text-[10px] text-[#57606A] dark:text-[#8B949E]">
                  Wird bei jedem Ordner-Import automatisch aktualisiert; der Browser-Ordnerdialog startet (über IndexedDB-DirectoryHandle) wieder direkt an diesem Verzeichnis.
                </p>
              </div>

              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[#57606A] dark:text-[#8B949E]">Pfad- &amp; Dateinamensvorlage</span>
                  <select
                    aria-label="Namensvorlage auswählen"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) {
                        onSettingsChange((s) => ({ ...s, filenameTemplate: e.target.value }));
                      }
                    }}
                    className="px-1.5 py-0.5 text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                  >
                    <option value="">Schnellvorlage wählen...</option>
                    {TEMPLATE_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>

                <input
                  ref={templateInputRef}
                  type="text"
                  value={settings.filenameTemplate}
                  onChange={(e) => onSettingsChange((s) => ({ ...s, filenameTemplate: e.target.value }))}
                  className="w-full px-2 py-1.5 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                />

                <div className="space-y-1.5 pt-0.5">
                  <div className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                    Variablen &amp; Trennzeichen per Klick an Cursor-Position einfügen:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {TEMPLATE_VARIABLES.map((v) => (
                      <button
                        key={v.token}
                        type="button"
                        title={`${v.hint} — fügt ${v.token} ein`}
                        onClick={() => insertIntoTemplate(v.token)}
                        className="px-1.5 py-0.5 text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] hover:border-[#5BA632] hover:bg-[#5BA632]/10 text-[#1F2328] dark:text-[#EAEEF2] transition-colors cursor-pointer"
                      >
                        <span className="font-medium">{v.label}</span>
                        {v.token.startsWith('{') && (
                          <span className="ml-1 font-mono text-[10px] text-[#57606A] dark:text-[#8B949E]">
                            {v.token}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-2.5 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/70 text-[11px]">
                  <span className="text-[#57606A] dark:text-[#8B949E]">Beispiel-Pfad: </span>
                  <span className="font-mono text-[#1F2328] dark:text-[#EAEEF2] break-all">
                    {renderSamplePreview()}
                  </span>
                </div>
              </div>
            </section>
          )}

          {/* Reiter 2: Format & Tagging */}
          {activeTab === 'format' && (
            <section role="tabpanel" className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  Ausgabeformat, Kompression &amp; Tagging
                </h3>
                <p className="text-[11px] text-[#57606A] dark:text-[#8B949E] mt-0.5">
                  Wähle zwischen verlustfreiem FLAC und LAME-MP3 sowie der gewünschten ID3-Tag-Version.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => onSettingsChange((s) => ({ ...s, exportFormat: 'flac' }))}
                  className={`px-3 py-2 text-xs font-medium rounded border text-left transition-colors ${
                    settings.exportFormat === 'flac'
                      ? 'border-[#5BA632] bg-[#5BA632]/10 text-[#1F2328] dark:text-[#EAEEF2]'
                      : 'border-[#D0D7DE] dark:border-[#444C56] text-[#57606A] dark:text-[#8B949E]'
                  }`}
                >
                  <div className="font-semibold">FLAC (Verlustfrei)</div>
                  <div className="text-[11px] opacity-80 mt-0.5">Archivqualität · Vorbis Comments</div>
                </button>
                <button
                  type="button"
                  onClick={() => onSettingsChange((s) => ({ ...s, exportFormat: 'mp3' }))}
                  className={`px-3 py-2 text-xs font-medium rounded border text-left transition-colors ${
                    settings.exportFormat === 'mp3'
                      ? 'border-[#5BA632] bg-[#5BA632]/10 text-[#1F2328] dark:text-[#EAEEF2]'
                      : 'border-[#D0D7DE] dark:border-[#444C56] text-[#57606A] dark:text-[#8B949E]'
                  }`}
                >
                  <div className="font-semibold">MP3 (LAME)</div>
                  <div className="text-[11px] opacity-80 mt-0.5">Kompatibel · ID3v2.4 / ID3v2.3</div>
                </button>
              </div>

              {settings.exportFormat === 'flac' ? (
                <div className="p-3.5 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/50 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[#57606A] dark:text-[#8B949E]">
                      FLAC-Kompressionsstufe (0 = schnell, 8 = kleinste Datei)
                    </span>
                    <span className="font-mono font-semibold tabular-nums text-[#1F2328] dark:text-[#EAEEF2]">
                      Stufe {settings.flacCompressionLevel}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={8}
                    value={settings.flacCompressionLevel}
                    onChange={(e) =>
                      onSettingsChange((s) => ({ ...s, flacCompressionLevel: Number(e.target.value) }))
                    }
                    className="w-full accent-[#5BA632]"
                  />
                  <div className="flex flex-wrap items-center gap-5 pt-1">
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={settings.flacVerify}
                        onChange={(e) => onSettingsChange((s) => ({ ...s, flacVerify: e.target.checked }))}
                        className="accent-[#5BA632]"
                      />
                      <span>FLAC-Prüfsumme verifizieren (--verify)</span>
                    </label>
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={settings.flacReplayGain}
                        onChange={(e) => onSettingsChange((s) => ({ ...s, flacReplayGain: e.target.checked }))}
                        className="accent-[#5BA632]"
                      />
                      <span>ReplayGain berechnen</span>
                    </label>
                  </div>
                </div>
              ) : (
                <div className="p-3.5 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/50 space-y-2">
                  <label className="block space-y-1">
                    <span className="text-[#57606A] dark:text-[#8B949E]">LAME MP3-Qualitätsstufe</span>
                    <select
                      value={settings.mp3Quality}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, mp3Quality: e.target.value as Mp3QualityMode }))
                      }
                      className="w-full px-2 py-1.5 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                    >
                      <option value="vbr_v0">VBR V0 (~245 kbps Transparenz)</option>
                      <option value="cbr_320">CBR 320 kbps (Maximum)</option>
                      <option value="cbr_256">CBR 256 kbps</option>
                      <option value="vbr_v2">VBR V2 (~190 kbps Mobil)</option>
                      <option value="cbr_192">CBR 192 kbps</option>
                    </select>
                  </label>
                </div>
              )}

              <div className="pt-2 border-t border-[#E1E4E8] dark:border-[#343A40] space-y-2">
                <h4 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  ID3-Tag-Standard (für MP3-Export)
                </h4>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.id3v2Version === 3}
                    onChange={(e) =>
                      onSettingsChange((s) => ({
                        ...s,
                        id3v2Version: e.target.checked ? 3 : 4,
                      }))
                    }
                    className="accent-[#5BA632] mt-0.5"
                  />
                  <span>
                    <span className="block font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                      ID3v2.3-Format für MP3-Tags nutzen (statt Standard ID3v2.4)
                    </span>
                    <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      Standard ist ID3v2.4 (UTF-8). Aktivieren für ältere Autoradios oder Hardware-Player.
                    </span>
                  </span>
                </label>
              </div>

              <div className="pt-2 border-t border-[#E1E4E8] dark:border-[#343A40] space-y-2">
                <h4 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  Titel-Normalisierung (Römische Ziffern)
                </h4>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.convertRomanNumerals !== false}
                    onChange={(e) =>
                      onSettingsChange((s) => ({
                        ...s,
                        convertRomanNumerals: e.target.checked,
                      }))
                    }
                    className="accent-[#5BA632] mt-0.5"
                  />
                  <span>
                    <span className="block font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                      Römische Ziffern in Albentiteln und Tracknamen in arabische Zahlen umwandeln
                    </span>
                    <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      Wandelt z. B. „Led Zeppelin IV“ oder „Part II“ automatisch in „Led Zeppelin 4“ bzw. „Part 2“ um. Wörter und Pronomen wie englisches „I“ (Ich), „Club Mix“, „CD“ oder Tonarten („in D“) bleiben geschützt.
                    </span>
                  </span>
                </label>
              </div>
            </section>
          )}

          {/* Reiter 3: Tag-Felder für die linke Spalte (MusicBrainz) */}
          {activeTab === 'tag_fields' && (
            <section role="tabpanel" className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                    Sichtbare MusicBrainz-Tag-Felder (Linke Spalte)
                  </h3>
                  <p className="text-[11px] text-[#57606A] dark:text-[#8B949E] mt-0.5">
                    Wähle per Checkbox aus allen gängigen MusicBrainz-Tags, welche Eingabefelder in der linken Spalte von Modul 2 &amp; Modul 3 angezeigt werden. ({visibleFieldSet.size} von {MUSICBRAINZ_LEFT_TAG_FIELDS.length} aktiv)
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      onSettingsChange((s) => ({
                        ...s,
                        visibleLeftTagFields: [...DEFAULT_VISIBLE_LEFT_TAG_FIELDS],
                      }))
                    }
                    className="px-2 py-1 text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] hover:border-[#5BA632] text-[#1F2328] dark:text-[#EAEEF2] transition-colors cursor-pointer"
                  >
                    Standard wiederherstellen
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onSettingsChange((s) => ({
                        ...s,
                        visibleLeftTagFields: MUSICBRAINZ_LEFT_TAG_FIELDS.map((f) => f.id),
                      }))
                    }
                    className="px-2 py-1 text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] hover:border-[#5BA632] text-[#1F2328] dark:text-[#EAEEF2] transition-colors cursor-pointer"
                  >
                    Alle aktivieren
                  </button>
                </div>
              </div>

              {(['basis', 'release', 'credits', 'identifiers'] as LeftTagFieldCategory[]).map((cat) => {
                const fields = MUSICBRAINZ_LEFT_TAG_FIELDS.filter((f) => f.category === cat);
                return (
                  <div
                    key={cat}
                    className="p-3 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/50 space-y-2.5"
                  >
                    <h4 className="text-[11px] font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                      {TAG_CATEGORY_LABELS[cat]}
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {fields.map((field) => {
                        const checked = visibleFieldSet.has(field.id);
                        return (
                          <label
                            key={field.id}
                            className="flex items-start gap-2 p-1.5 rounded border border-transparent hover:border-[#D0D7DE] dark:hover:border-[#444C56] hover:bg-white/70 dark:hover:bg-[#25292E]/70 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => toggleLeftTagField(field.id, e.target.checked)}
                              className="accent-[#5BA632] mt-0.5 shrink-0"
                            />
                            <span className="min-w-0 leading-tight">
                              <span className="block text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                                {field.label}
                              </span>
                              <span className="block text-[10px] font-mono text-[#57606A] dark:text-[#8B949E]">
                                {field.mbTag}
                                {field.defaultVisible ? ' · Standard' : ''}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {/* Reiter 4: Normalisierung */}
          {activeTab === 'normalization' && (
            <section role="tabpanel" className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  EBU-R128 Album-Normalisierung &amp; ReplayGain
                </h3>
                <p className="text-[11px] text-[#57606A] dark:text-[#8B949E] mt-0.5">
                  Passt die Lautstärke eines gesamten Albums auf einen einheitlichen LUFS-Referenzpegel an.
                </p>
              </div>

              <label className="flex items-start gap-2.5 p-3 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.normalizeAlbum}
                  onChange={(e) =>
                    onSettingsChange((s) => ({ ...s, normalizeAlbum: e.target.checked }))
                  }
                  className="accent-[#5BA632] mt-0.5"
                />
                <span>
                  <span className="block font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                    Alben normalisieren (einheitliche EBU-R128 Album-Lautstärke)
                  </span>
                  <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                    Misst das gesamte Album und passt alle Titel mit identischem Gain-Offset auf den LUFS-Zielwert an.
                  </span>
                </span>
              </label>

              <div className="p-3.5 rounded border border-[#E1E4E8] dark:border-[#343A40] space-y-3">
                <label className="flex items-center gap-3">
                  <span className="text-[#57606A] dark:text-[#8B949E]">Ziel-Lautstärke:</span>
                  <input
                    type="number"
                    step={0.5}
                    min={-30}
                    max={-5}
                    disabled={!settings.normalizeAlbum}
                    value={settings.normalizeTargetLufs}
                    onChange={(e) => {
                      const parsed = Number(e.target.value);
                      if (Number.isFinite(parsed)) {
                        onSettingsChange((s) => ({
                          ...s,
                          normalizeTargetLufs: Math.max(-30, Math.min(-5, parsed)),
                        }));
                      }
                    }}
                    className="w-24 px-2 py-1 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                  />
                  <span className="font-mono text-[#57606A] dark:text-[#8B949E]">LUFS (Standard -17)</span>
                </label>

                <div className="space-y-2.5 pt-1">
                  <label className={`flex items-center gap-2 ${settings.normalizeAlbum ? 'cursor-pointer' : 'opacity-50'}`}>
                    <input
                      type="checkbox"
                      disabled={!settings.normalizeAlbum}
                      checked={settings.normalizeComputeAlbumGain}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, normalizeComputeAlbumGain: e.target.checked }))
                      }
                      className="accent-[#5BA632]"
                    />
                    <span>Album-Gain/-Peak berechnen</span>
                  </label>

                  <label className={`flex items-center gap-2 ${settings.normalizeAlbum ? 'cursor-pointer' : 'opacity-50'}`}>
                    <input
                      type="checkbox"
                      disabled={!settings.normalizeAlbum}
                      checked={settings.normalizeUseLoudestTrack}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, normalizeUseLoudestTrack: e.target.checked }))
                      }
                      className="accent-[#5BA632]"
                    />
                    <span>Lautesten Titel für Album-Loudness verwenden</span>
                  </label>

                  <label className={`flex items-center gap-2 ${settings.normalizeAlbum ? 'cursor-pointer' : 'opacity-50'}`}>
                    <input
                      type="checkbox"
                      disabled={!settings.normalizeAlbum}
                      checked={settings.normalizeTruePeak}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, normalizeTruePeak: e.target.checked }))
                      }
                      className="accent-[#5BA632]"
                    />
                    <span>True Peak verwenden</span>
                  </label>

                  <label className={`flex items-center gap-2 ${settings.normalizeAlbum ? 'cursor-pointer' : 'opacity-50'}`}>
                    <input
                      type="checkbox"
                      disabled={!settings.normalizeAlbum}
                      checked={settings.normalizeWriteRefLoudnessTag}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, normalizeWriteRefLoudnessTag: e.target.checked }))
                      }
                      className="accent-[#5BA632]"
                    />
                    <span>Referenz-Loudness-Tag ebenfalls reinschreiben</span>
                  </label>
                </div>
              </div>
            </section>
          )}

          {/* Reiter 4: Cover, Laufwerk & Ansicht */}
          {activeTab === 'drive_cover' && (
            <section role="tabpanel" className="space-y-5">
              {/* Cover-Art */}
              <div className="space-y-3 pb-4 border-b border-[#E1E4E8] dark:border-[#343A40]">
                <h3 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  Cover-Art &amp; Bilddatei
                </h3>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.embedCoverArt}
                    onChange={(e) => onSettingsChange((s) => ({ ...s, embedCoverArt: e.target.checked }))}
                    className="accent-[#5BA632]"
                  />
                  <span>Cover-Art direkt in FLAC / ID3-Tags einbetten</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.saveFolderCover}
                    onChange={(e) => onSettingsChange((s) => ({ ...s, saveFolderCover: e.target.checked }))}
                    className="accent-[#5BA632]"
                  />
                  <span>Cover-Bild zusätzlich im Album-Ordner speichern</span>
                </label>

                <div className="space-y-1.5 pl-6">
                  <label className="block space-y-1">
                    <span className="text-[#57606A] dark:text-[#8B949E]">
                      Dateiname des Coverbildes (ohne Endung wird .jpg/.png ergänzt)
                    </span>
                    <input
                      ref={coverInputRef}
                      type="text"
                      disabled={!settings.saveFolderCover}
                      value={settings.coverFilename}
                      onChange={(e) => onSettingsChange((s) => ({ ...s, coverFilename: e.target.value }))}
                      placeholder="z. B. cover, folder, front oder {album}"
                      className="w-full px-2 py-1 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {COVER_VARIABLES.map((cv) => (
                      <button
                        key={cv.token}
                        type="button"
                        disabled={!settings.saveFolderCover}
                        onClick={() => handleCoverTokenClick(cv.token, cv.mode)}
                        className="px-1.5 py-0 text-[11px] font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] hover:border-[#5BA632] hover:bg-[#5BA632]/10 text-[#1F2328] dark:text-[#EAEEF2] disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        {cv.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-2 border-t border-[#E1E4E8] dark:border-[#343A40]/70 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                      Cover-Optimierung in Modul 5 (Maximale Dimensionen)
                    </span>
                    <div className="flex items-center gap-1.5">
                      {[1000, 1500, DEFAULT_COVER_MAX_DIMENSION, 3000].map((px) => {
                        const cur = normalizeCoverMaxDimension(settings.coverMaxDimension);
                        return (
                          <button
                            key={px}
                            type="button"
                            onClick={() =>
                              onSettingsChange((s) => ({ ...s, coverMaxDimension: px }))
                            }
                            className={`px-1.5 py-0.5 text-[10px] font-mono rounded border cursor-pointer ${
                              cur === px
                                ? 'border-[#5BA632] bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270] font-semibold'
                                : 'border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#57606A] dark:text-[#8B949E]'
                            }`}
                          >
                            {px} px
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <label className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[#57606A] dark:text-[#8B949E]">
                      Max. Breite / Höhe:
                    </span>
                    <input
                      type="number"
                      min={256}
                      max={8192}
                      step={64}
                      value={normalizeCoverMaxDimension(settings.coverMaxDimension)}
                      onChange={(e) => {
                        const parsed = Number(e.target.value);
                        if (Number.isFinite(parsed)) {
                          onSettingsChange((s) => ({
                            ...s,
                            coverMaxDimension: normalizeCoverMaxDimension(parsed),
                          }));
                        }
                      }}
                      className="w-24 px-2 py-1 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                    <span className="font-mono text-[#57606A] dark:text-[#8B949E]">
                      × {normalizeCoverMaxDimension(settings.coverMaxDimension)} px (Standard 2048 px)
                    </span>
                  </label>
                  <p className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                    Größere Cover werden bei der Reparatur proportional auf dieses Maß herunterskaliert. Cover &gt; 1 MB innerhalb dieses Limits werden auf ≤ 1 MB komprimiert, wobei die aktuellen Pixel-Dimensionen zwingend erhalten bleiben.
                  </p>
                </div>
              </div>

              {/* Cover-Bilddatenbanken (Abfragequellen) */}
              {(() => {
                const activeCoverProviders = normalizeCoverProviders(settings.coverProviders);
                const activeSet = new Set<CoverProviderSettingId>(activeCoverProviders);
                const toggleProvider = (pid: CoverProviderSettingId, checked: boolean) => {
                  onSettingsChange((s) => {
                    const current = new Set<CoverProviderSettingId>(
                      normalizeCoverProviders(s.coverProviders)
                    );
                    if (checked) current.add(pid);
                    else current.delete(pid);
                    const ordered = COVER_PROVIDER_OPTIONS.map((o) => o.id).filter((id) =>
                      current.has(id)
                    );
                    return { ...s, coverProviders: ordered };
                  });
                };

                return (
                  <div className="space-y-3 pb-4 border-b border-[#E1E4E8] dark:border-[#343A40]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                          Cover-Bilddatenbanken (Abfragequellen)
                        </h3>
                        <p className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                          {activeCoverProviders.length} von {COVER_PROVIDER_OPTIONS.length} Quellen aktiviert · Alle aktivierten Datenbanken werden parallel ohne API-Schlüssel abgefragt.
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            onSettingsChange((s) => ({
                              ...s,
                              coverProviders: [...DEFAULT_COVER_PROVIDERS],
                            }))
                          }
                          className="px-2 py-1 text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] hover:bg-[#ECEFF3] dark:hover:bg-[#2A2F36] text-[#1F2328] dark:text-[#EAEEF2]"
                        >
                          Alle aktivieren
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onSettingsChange((s) => ({
                              ...s,
                              coverProviders: [],
                            }))
                          }
                          className="px-2 py-1 text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] hover:bg-[#ECEFF3] dark:hover:bg-[#2A2F36] text-[#1F2328] dark:text-[#EAEEF2]"
                        >
                          Alle abwählen
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {COVER_PROVIDER_OPTIONS.map((opt) => {
                        const checked = activeSet.has(opt.id);
                        return (
                          <label
                            key={opt.id}
                            className="flex items-start gap-2 p-2 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23] hover:border-[#5BA632]/70 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => toggleProvider(opt.id, e.target.checked)}
                              className="accent-[#5BA632] mt-0.5 shrink-0"
                            />
                            <span className="min-w-0">
                              <span className="block text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2] leading-tight">
                                {opt.label}
                              </span>
                              <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E] leading-snug mt-0.5">
                                {opt.hint}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>

                    {activeCoverProviders.length === 0 && (
                      <p className="text-[11px] text-[#B45309] dark:text-[#FBBF24]">
                        Hinweis: Es ist derzeit keine Cover-Bilddatenbank aktiviert. Bitte mindestens eine Quelle auswählen, um Cover online zu suchen.
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Scanner-Einstellungen (Direktscan beim Klick auf das Scanner-Symbol) */}
              <div className="space-y-3 pb-4 border-b border-[#E1E4E8] dark:border-[#343A40]">
                <div className="flex items-center gap-2">
                  <SystemIcon name="scanner" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F]" />
                  <h3 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                    Scanner-Einstellungen (Direktscan per SANE / Flachbettscanner)
                  </h3>
                </div>
                <p className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                  Beim Klick auf das Scanner-Symbol in der Cover-Toolbar wird sofort mit diesen Einstellungen gescannt und anschließend das Zuschneiden-Fenster geöffnet.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <label className="block space-y-1">
                    <span className="text-[#57606A] dark:text-[#8B949E]">Scan-Auflösung (DPI)</span>
                    <select
                      value={settings.scannerDpi || 300}
                      onChange={(e) =>
                        onSettingsChange((s) => ({
                          ...s,
                          scannerDpi: Number(e.target.value) as 150 | 300 | 600 | 1200,
                        }))
                      }
                      className="w-full px-2 py-1.5 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                    >
                      <option value={150}>150 DPI (Schnell)</option>
                      <option value={300}>300 DPI (Standard Booklet)</option>
                      <option value={600}>600 DPI (Hochauflösend)</option>
                      <option value={1200}>1200 DPI (Archivqualität)</option>
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="text-[#57606A] dark:text-[#8B949E]">Farbmodus</span>
                    <select
                      value={settings.scannerColorMode || 'Color'}
                      onChange={(e) =>
                        onSettingsChange((s) => ({
                          ...s,
                          scannerColorMode: e.target.value as 'Color' | 'Gray' | 'Lineart',
                        }))
                      }
                      className="w-full px-2 py-1.5 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                    >
                      <option value="Color">Farbe (24-Bit RGB)</option>
                      <option value="Gray">Graustufen (8-Bit)</option>
                      <option value="Lineart">Schwarz/Weiß (Lineart)</option>
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="text-[#57606A] dark:text-[#8B949E]">Scan-Bereich</span>
                    <select
                      value={settings.scannerScanArea || 'cd_booklet'}
                      onChange={(e) =>
                        onSettingsChange((s) => ({
                          ...s,
                          scannerScanArea: e.target.value as 'cd_booklet' | 'cd_inlay' | 'full',
                        }))
                      }
                      className="w-full px-2 py-1.5 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                    >
                      <option value="cd_booklet">CD-Booklet (125 × 125 mm)</option>
                      <option value="cd_inlay">CD-Inlay / Back (150 × 118 mm)</option>
                      <option value="full">Vollfläche (A4 / Maximal)</option>
                    </select>
                  </label>
                </div>

                <label className="block space-y-1">
                  <span className="text-[#57606A] dark:text-[#8B949E]">
                    SANE-Scannergerät (leer lassen für automatischen Standard-Scanner)
                  </span>
                  <input
                    type="text"
                    value={settings.scannerDevice || ''}
                    onChange={(e) =>
                      onSettingsChange((s) => ({ ...s, scannerDevice: e.target.value }))
                    }
                    placeholder="Automatisch (z. B. airscan:e0:... oder pixma:04A9...)"
                    className="w-full px-2 py-1 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                  />
                </label>

                <label className="flex items-center gap-2 cursor-pointer pt-0.5">
                  <input
                    type="checkbox"
                    checked={settings.scannerAutoOpenCrop !== false}
                    onChange={(e) =>
                      onSettingsChange((s) => ({ ...s, scannerAutoOpenCrop: e.target.checked }))
                    }
                    className="accent-[#5BA632]"
                  />
                  <span>Nach dem Scanvorgang sofort das Fenster für den Zuschnitt öffnen</span>
                </label>
              </div>

              {/* Online-Datenbanken, Discogs API-Token & Shazam-Erkennung */}
              <div className="space-y-2.5 pb-4 border-b border-[#E1E4E8] dark:border-[#343A40]">
                <h3 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  Online-Datenbanken, Discogs &amp; Shazam-Erkennung
                </h3>
                <label className="block space-y-1">
                  <span className="text-[#57606A] dark:text-[#8B949E]">
                    Shazam-Samplegröße (Audio-Fingerprint aus Track-Mitte bei 50 %)
                  </span>
                  <select
                    value={normalizeShazamSampleSize(settings.shazamSampleSize)}
                    onChange={(e) =>
                      onSettingsChange((s) => ({
                        ...s,
                        shazamSampleSize: normalizeShazamSampleSize(Number(e.target.value)),
                      }))
                    }
                    className="w-full px-2 py-1.5 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                  >
                    {SHAZAM_SAMPLE_SIZE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                    Bestimmt die Länge des 16-kHz-Mono-Samples aus der Track-Mitte (16.000 Samples = 1 Sekunde). Kleinere Werte sind schneller, größere erhöhen die Treffersicherheit.
                  </span>
                </label>

                <label className="block space-y-1 pt-1">
                  <span className="text-[#57606A] dark:text-[#8B949E]">
                    Discogs Personal Access Token (optional, für direkte Volltext-/Barcode-Suche)
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type={showDiscogsToken ? 'text' : 'password'}
                      value={settings.discogsToken || ''}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, discogsToken: e.target.value }))
                      }
                      placeholder="Discogs Personal Access Token (optional)"
                      className="flex-1 px-2 py-1 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                    <label className="inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showDiscogsToken}
                        onChange={(e) => setShowDiscogsToken(e.target.checked)}
                        className="accent-[#5BA632]"
                      />
                      <span>Anzeigen</span>
                    </label>
                  </div>
                </label>
                <p className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                  Erhöht das API-Limit und schaltet die direkte Discogs-Datenbanksuche frei (erstellbar unter{' '}
                  <span className="font-mono">discogs.com/settings/developers</span>). Ohne Token nutzt MintRip automatisch die MusicBrainz-Discogs-Verknüpfung.
                </p>

                <label className="block space-y-1 pt-2">
                  <span className="text-[#57606A] dark:text-[#8B949E]">
                    Last.fm API-Key (optional, für schnelle parallele Track-Subgenre-Tags ohne 1-Req/s-Limit)
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type={showLastfmKey ? 'text' : 'password'}
                      value={settings.lastfmApiKey || ''}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, lastfmApiKey: e.target.value }))
                      }
                      placeholder="Optional: Kostenloser API-Key unter last.fm/api/account/create"
                      className="flex-1 px-2 py-1 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                    <label className="inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showLastfmKey}
                        onChange={(e) => setShowLastfmKey(e.target.checked)}
                        className="accent-[#5BA632]"
                      />
                      <span>Anzeigen</span>
                    </label>
                  </div>
                </label>

                <label className="block space-y-1 pt-1">
                  <span className="text-[#57606A] dark:text-[#8B949E]">
                    MusicBrainz-Server-URL (Standard oder eigener lokaler Docker-Mirror ohne Rate-Limit)
                  </span>
                  <input
                    type="text"
                    value={settings.musicbrainzServerUrl ?? DEFAULT_MUSICBRAINZ_SERVER_URL}
                    onChange={(e) =>
                      onSettingsChange((s) => ({ ...s, musicbrainzServerUrl: e.target.value }))
                    }
                    onBlur={(e) =>
                      onSettingsChange((s) => ({
                        ...s,
                        musicbrainzServerUrl: normalizeMusicBrainzServerUrl(e.target.value),
                      }))
                    }
                    placeholder="https://musicbrainz.org/ws/2 oder http://localhost:5000/ws/2"
                    className="w-full px-2 py-1 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                  />
                  <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                    Bei einem lokalen Mirror (z. B. <span className="font-mono">http://localhost:5000/ws/2</span>) wird die 1-Anfrage/Sekunde-Drosselung automatisch abgeschaltet.
                  </span>
                </label>

                <div className="space-y-1.5 pt-1">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.preferSubgenres !== false}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, preferSubgenres: e.target.checked }))
                      }
                      className="accent-[#5BA632] mt-0.5"
                    />
                    <span>
                      <span className="block font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                        Spezifische Subgenres bevorzugen
                      </span>
                      <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                        Blendet Verallgemeinerungen wie „Rock“ oder „Punk“ aus, sobald spezifischere Subgenres (z. B. „Hardcore Punk“, „Skate Punk“) vorliegen.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.autoEnrichTrackGenres !== false}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, autoEnrichTrackGenres: e.target.checked }))
                      }
                      className="accent-[#5BA632] mt-0.5"
                    />
                    <span>
                      <span className="block font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                        Fehlende Track-Genres automatisch anreichern
                      </span>
                      <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                        Kombiniert MusicBrainz Release-Group-Pressungen, Discogs Styles und optional Last.fm, falls der gewählte Treffer noch keine spezifischen Song-Genres enthält.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(settings.mbLoadDeepRelations)}
                      onChange={(e) =>
                        onSettingsChange((s) => ({ ...s, mbLoadDeepRelations: e.target.checked }))
                      }
                      className="accent-[#5BA632] mt-0.5"
                    />
                    <span>
                      <span className="block font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                        Tiefe MusicBrainz-Credits &amp; Klassik-Relationen laden (langsamer)
                      </span>
                      <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                        Lädt zusätzlich Work-, Dirigenten-, Orchester- und Instrumenten-Relationen pro Track. Standardmäßig deaktiviert für spürbar schnellere MusicBrainz-Antworten.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#E1E4E8]/70 dark:border-[#343A40]/70">
                  <span className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                    Lokaler Metadaten-Cache:{' '}
                    <span className="font-mono font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                      {cacheStats
                        ? `${cacheStats.entries} Einträge (${(cacheStats.sizeBytes / 1024).toFixed(1)} KB)`
                        : 'wird geladen...'}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleClearMetadataCache()}
                    disabled={isClearingCache}
                    className="px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    {isClearingCache ? 'Wird geleert...' : 'Metadaten-Cache leeren'}
                  </button>
                </div>

                <label className="flex items-start gap-2.5 pt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(settings.showQueryLog)}
                    onChange={(e) =>
                      onSettingsChange((s) => ({ ...s, showQueryLog: e.target.checked }))
                    }
                    className="accent-[#5BA632] mt-0.5"
                  />
                  <span>
                    <span className="block font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                      Abfrage-Protokoll am unteren Fensterrand anzeigen (skalierbare Spalte)
                    </span>
                    <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      Blendet am unteren Rand des gesamten Fensters eine höhenverstellbare Protokoll-Spalte für alle Online-Abfrageschritte ein. Wenn deaktiviert, verschwindet die Spalte vollständig.
                    </span>
                  </span>
                </label>
              </div>

              {/* Optisches Laufwerk */}
              <div className="space-y-3 pb-4 border-b border-[#E1E4E8] dark:border-[#343A40]">
                <h3 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  Optisches Laufwerk &amp; Auslesen
                </h3>
                <label className="block space-y-1">
                  <span className="text-[#57606A] dark:text-[#8B949E]">cdparanoia-Modus</span>
                  <select
                    value={settings.paranoiaMode}
                    onChange={(e) =>
                      onSettingsChange((s) => ({ ...s, paranoiaMode: e.target.value as ParanoiaMode }))
                    }
                    className="w-full px-2 py-1.5 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                  >
                    <option value="full">Vollständig (-e Fehlerkorrektur)</option>
                    <option value="disable-skip">Kein Überspringen (-Y)</option>
                    <option value="fast">Schnell (-Z ohne Paranoia)</option>
                  </select>
                </label>

                <label
                  className="flex items-center gap-2 cursor-pointer pt-1"
                  title="Wirft das optische Laufwerk nur beim Rippen physischer Audio-CDs aus. Bei importierten lokalen Alben erfolgt kein Auswurf."
                >
                  <input
                    type="checkbox"
                    checked={settings.ejectAfterRip}
                    onChange={(e) => onSettingsChange((s) => ({ ...s, ejectAfterRip: e.target.checked }))}
                    className="accent-[#5BA632]"
                  />
                  <span>CD nach Abschluss automatisch auswerfen (nur physische CDs)</span>
                </label>
              </div>

              {/* Leistung & Parallelität */}
              <div className="space-y-2.5 pb-4 border-b border-[#E1E4E8] dark:border-[#343A40]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                    Leistung &amp; Parallelität
                  </h3>
                  <div className="flex items-center gap-1.5">
                    {[1, 2, DEFAULT_MAX_THREADS, 8].map((thr) => {
                      const cur = normalizeMaxThreads(settings.maxThreads);
                      return (
                        <button
                          key={thr}
                          type="button"
                          onClick={() =>
                            onSettingsChange((s) => ({ ...s, maxThreads: thr }))
                          }
                          className={`px-1.5 py-0.5 text-[10px] font-mono rounded border cursor-pointer ${
                            cur === thr
                              ? 'border-[#5BA632] bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270] font-semibold'
                              : 'border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#57606A] dark:text-[#8B949E]'
                          }`}
                        >
                          {thr} {thr === 1 ? 'Thread' : 'Threads'}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <label className="flex flex-wrap items-center gap-2.5">
                  <span className="text-[#57606A] dark:text-[#8B949E]">
                    Maximale Threads (Analyse, Reparatur, Konvertierung &amp; Encoding):
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    step={1}
                    value={normalizeMaxThreads(settings.maxThreads)}
                    onChange={(e) => {
                      const parsed = Number(e.target.value);
                      if (Number.isFinite(parsed)) {
                        onSettingsChange((s) => ({
                          ...s,
                          maxThreads: normalizeMaxThreads(parsed),
                        }));
                      }
                    }}
                    className="w-20 px-2 py-1 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                  />
                  <span className="font-mono text-[#57606A] dark:text-[#8B949E]">
                    (Standard {DEFAULT_MAX_THREADS} · Bereich 1–16)
                  </span>
                </label>
                <p className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                  Begrenzt sowohl parallel verarbeitete Dateien als auch die FFmpeg-Threads pro Prozess auf insgesamt maximal diesen Wert, damit der Computer bei großen Ordnern nicht überlastet wird.
                </p>
              </div>

              {/* Darstellung */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  Darstellung &amp; Systemthema
                </h3>
                <label className="block space-y-1">
                  <span className="text-[#57606A] dark:text-[#8B949E]">Farbschema</span>
                  <select
                    value={themeMode}
                    onChange={(e) => onThemeModeChange(e.target.value as 'system' | 'light' | 'dark')}
                    className="w-full px-2 py-1.5 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                  >
                    <option value="system">Systemthema automatisch übernehmen</option>
                    <option value="light">Hell (Mint-Y Light)</option>
                    <option value="dark">Dunkel (Mint-Y Dark)</option>
                  </select>
                </label>
              </div>
            </section>
          )}
      </div>
    </div>
  );
}

export function SettingsPage({
  settings,
  onSettingsChange,
  themeMode,
  onThemeModeChange,
}: Omit<SettingsPageProps, 'onBackToHome'> & { onBackToHome?: () => void }) {
  return (
    <div className="space-y-4">
      <ModulePageHeaderBar
        moduleNumber="System"
        title="Einstellungen"
        subtitle="Speicherort, Pfad-Vorlagen, FLAC/MP3, EBU-R128-Normalisierung, Scanner, Discogs-Token & Darstellung"
        icon="settings"
      />

      <div className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg overflow-hidden flex flex-col">
        <SettingsNotebookContent
          settings={settings}
          onSettingsChange={onSettingsChange}
          themeMode={themeMode}
          onThemeModeChange={onThemeModeChange}
          isPageMode
        />

        <div className="px-5 py-3 border-t border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 flex items-center justify-between gap-4">
          <span className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
            Alle Änderungen werden automatisch im Browserprofil gespeichert.
          </span>
        </div>
      </div>
    </div>
  );
}

export function SettingsModal({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  themeMode,
  onThemeModeChange,
}: SettingsModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
        {/* Dialog-Kopfzeile */}
        <div className="px-5 py-3.5 border-b border-[#E1E4E8] dark:border-[#343A40] flex items-center justify-between gap-4 bg-[#F8F9FA] dark:bg-[#1C1F23]/60">
          <div className="flex items-center gap-2">
            <SystemIcon name="settings" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F]" />
            <h2 id="settings-modal-title" className="text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
              Einstellungen — MintRip Studio
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white transition-colors"
          >
            Fertig
          </button>
        </div>

        <SettingsNotebookContent
          settings={settings}
          onSettingsChange={onSettingsChange}
          themeMode={themeMode}
          onThemeModeChange={onThemeModeChange}
        />
      </div>
    </div>
  );
}
