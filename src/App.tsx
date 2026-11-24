import React, { useEffect, useRef, useState } from 'react';
import { BatchQueueView } from './components/BatchQueueView';
import {
  ConverterToolbarState,
  ConverterWorkbench,
  ConverterWorkbenchHandle,
} from './components/ConverterWorkbench';
import { MetadataWorkbench } from './components/MetadataWorkbench';
import {
  MODULE_SPECS,
  ModulePageHeaderBar,
  ReservedModulePage,
  StartPageLauncher,
} from './components/ModulePages';
import {
  RepairToolbarState,
  RepairWorkbench,
  RepairWorkbenchHandle,
} from './components/RepairWorkbench';
import { SettingsPage } from './components/SettingsModal';
import { SourceCodeView } from './components/SourceCodeView';
import { SystemIconsView } from './components/SystemIconsView';
import {
  ActiveWorkspaceTab,
  AlbumMetadata,
  BatchJob,
  COVER_PROVIDER_OPTIONS,
  CoverSearchCandidate,
  DEFAULT_COVER_MAX_DIMENSION,
  DEFAULT_COVER_PROVIDERS,
  DEFAULT_MAX_THREADS,
  DEFAULT_MODULE_OUTPUT_DIRS,
  DEFAULT_MUSICBRAINZ_SERVER_URL,
  DEFAULT_SHAZAM_SAMPLE_SIZE,
  DEFAULT_VISIBLE_LEFT_TAG_FIELDS,
  ExportSettings,
  MusicBrainzSearchResult,
  normalizeCoverMaxDimension,
  normalizeCoverProviders,
  normalizeMaxThreads,
  normalizeMusicBrainzServerUrl,
  normalizeShazamSampleSize,
  PythonProjectFile,
  TrackMetadata,
} from './types/mintrip';
import {
  applyRomanNumeralPreference,
  calculateCddbDiscId,
  calculateMusicBrainzDiscId,
  convertRomanNumeralsInTitle,
  extractAudioMetadataAndDuration,
  extractShazamPcmWindowsFromFile,
  findBestCoverImageFile,
  formatCoverByteSize,
  formatOutputStem,
  inspectCoverImage,
  normalizeCoverToJpeg,
  normalizeMultiArtist,
  parseAlbumFolderName,
  parseCueSheetText,
  parseTrackFilename,
  SynthesizedTocResult,
  synthesizeTocFromTracks,
} from './utils/audioExportHelpers';
import { SystemIcon } from './components/SystemIcons';

type ThemeMode = 'system' | 'light' | 'dark';

const SETTINGS_STORAGE_KEY = 'mintrip_studio_settings_v1';

const INITIAL_TRACKS_RAW: TrackMetadata[] = [
  { id: 'kw-1', trackNumber: 1, title: 'Computerwelt', artist: 'Kraftwerk', durationSeconds: 305, exactDurationSeconds: 305, isrc: 'DEAE68100101', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
  { id: 'kw-2', trackNumber: 2, title: 'Taschenrechner', artist: 'Kraftwerk', durationSeconds: 304, exactDurationSeconds: 304, isrc: 'DEAE68100102', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
  { id: 'kw-3', trackNumber: 3, title: 'Nummern', artist: 'Kraftwerk', durationSeconds: 199, exactDurationSeconds: 199, isrc: 'DEAE68100103', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
  { id: 'kw-4', trackNumber: 4, title: 'Computerwelt 2', artist: 'Kraftwerk', durationSeconds: 201, exactDurationSeconds: 201, isrc: 'DEAE68100104', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
  { id: 'kw-5', trackNumber: 5, title: 'Computerliebe', artist: 'Kraftwerk', durationSeconds: 435, exactDurationSeconds: 435, isrc: 'DEAE68100105', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
  { id: 'kw-6', trackNumber: 6, title: 'Heimcomputer', artist: 'Kraftwerk', durationSeconds: 377, exactDurationSeconds: 377, isrc: 'DEAE68100106', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
  { id: 'kw-7', trackNumber: 7, title: 'It’s More Fun to Compute', artist: 'Kraftwerk', durationSeconds: 253, exactDurationSeconds: 253, isrc: 'DEAE68100107', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
];

const INITIAL_TOC = synthesizeTocFromTracks(INITIAL_TRACKS_RAW);

const INITIAL_ALBUM: AlbumMetadata = {
  title: 'Computerwelt',
  artist: 'Kraftwerk',
  albumArtist: 'Kraftwerk',
  year: '1981',
  genre: 'Electro; Electronic; Synth-Pop; Avant-Garde',
  label: 'Kling Klang',
  discNumber: 1,
  totalDiscs: 1,
  cddbId: INITIAL_TOC.cddbId,
  musicbrainzDiscId: INITIAL_TOC.musicbrainzDiscId,
  musicbrainzToc: INITIAL_TOC.musicbrainzToc,
  trackOffsets: INITIAL_TOC.trackOffsets,
  leadoutOffset: INITIAL_TOC.leadoutOffset,
  musicbrainzReleaseId: '75678f27-51e0-4802-a367-e7a1f86fc7d3',
  metadataSource: 'MusicBrainz',
  coverArtUrl: '/api/coverart/75678f27-51e0-4802-a367-e7a1f86fc7d3',
  coverArtSource: 'Cover Art Archive (MusicBrainz)',
  tracks: INITIAL_TOC.tracksWithLsn,
};

const INITIAL_SETTINGS: ExportSettings = {
  outputDir: DEFAULT_MODULE_OUTPUT_DIRS.outputDirRip,
  outputDirCover: DEFAULT_MODULE_OUTPUT_DIRS.outputDirCover,
  outputDirRip: DEFAULT_MODULE_OUTPUT_DIRS.outputDirRip,
  outputDirTag: DEFAULT_MODULE_OUTPUT_DIRS.outputDirTag,
  outputDirConvert: DEFAULT_MODULE_OUTPUT_DIRS.outputDirConvert,
  outputDirRepair: DEFAULT_MODULE_OUTPUT_DIRS.outputDirRepair,
  outputDirCut: DEFAULT_MODULE_OUTPUT_DIRS.outputDirCut,
  filenameTemplate: '{album_artist}/{year} - {album}/{track} - {title}',
  exportFormat: 'flac',
  flacCompressionLevel: 8,
  flacVerify: true,
  flacReplayGain: true,
  mp3Quality: 'vbr_v0',
  id3v2Version: 4,
  normalizeAlbum: false,
  normalizeTargetLufs: -17,
  normalizeComputeAlbumGain: true,
  normalizeUseLoudestTrack: true,
  normalizeTruePeak: true,
  normalizeWriteRefLoudnessTag: true,
  embedCoverArt: true,
  saveFolderCover: true,
  coverFilename: 'cover',
  coverMaxDimension: DEFAULT_COVER_MAX_DIMENSION,
  coverProviders: [...DEFAULT_COVER_PROVIDERS],
  maxThreads: DEFAULT_MAX_THREADS,
  ejectAfterRip: false,
  paranoiaMode: 'full',
  discogsToken: '',
  lastfmApiKey: '',
  musicbrainzServerUrl: DEFAULT_MUSICBRAINZ_SERVER_URL,
  mbLoadDeepRelations: false,
  preferSubgenres: true,
  autoEnrichTrackGenres: true,
  showQueryLog: false,
  convertRomanNumerals: true,
  lastImportFolder: '~/Musik',
  lastCoverFolder: DEFAULT_MODULE_OUTPUT_DIRS.outputDirCover,
  scannerDevice: '',
  scannerDpi: 300,
  scannerColorMode: 'Color',
  scannerScanArea: 'cd_booklet',
  scannerAutoOpenCrop: true,
  visibleLeftTagFields: DEFAULT_VISIBLE_LEFT_TAG_FIELDS,
  shazamSampleSize: DEFAULT_SHAZAM_SAMPLE_SIZE,
};

const QUERY_LOG_HEIGHT_CLASSES = [
  'h-[96px]',
  'h-[120px]',
  'h-[144px]',
  'h-[168px]',
  'h-[196px]',
  'h-[228px]',
  'h-[264px]',
  'h-[304px]',
  'h-[352px]',
  'h-[408px]',
] as const;

const QUERY_LOG_HEIGHT_PX = [96, 120, 144, 168, 196, 228, 264, 304, 352, 408] as const;

type LastMetadataQueryAction =
  | {
      kind: 'toc';
      syn?: SynthesizedTocResult;
      autoSelectFirst: boolean;
      folderHint?: string;
      durations?: number[];
      trackTitles?: string[];
    }
  | {
      kind: 'search';
      query: string;
      autoSelectFirst: boolean;
    }
  | {
      kind: 'release';
      idOrPrefixed: string;
      discNumber: number;
      source?: 'musicbrainz' | 'discogs' | 'cddb';
      preserveToc?: SynthesizedTocResult;
    };

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveWorkspaceTab>('home');
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  );

  const [devicePath, setDevicePath] = useState<string>('/dev/cdrom');
  const [album, setAlbum] = useState<AlbumMetadata>(INITIAL_ALBUM);
  const [settings, setSettings] = useState<ExportSettings>(() => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ExportSettings>;
        const legacyGeneric = !parsed.outputDir || parsed.outputDir.trim() === '~/Musik';
        const resolvedRip =
          parsed.outputDirRip?.trim() ||
          (!legacyGeneric && parsed.outputDir?.trim()) ||
          DEFAULT_MODULE_OUTPUT_DIRS.outputDirRip;
        return {
          ...INITIAL_SETTINGS,
          ...parsed,
          outputDir: resolvedRip,
          outputDirCover:
            parsed.outputDirCover?.trim() || DEFAULT_MODULE_OUTPUT_DIRS.outputDirCover,
          outputDirRip: resolvedRip,
          outputDirTag:
            parsed.outputDirTag?.trim() || DEFAULT_MODULE_OUTPUT_DIRS.outputDirTag,
          outputDirConvert:
            parsed.outputDirConvert?.trim() || DEFAULT_MODULE_OUTPUT_DIRS.outputDirConvert,
          outputDirRepair:
            parsed.outputDirRepair?.trim() || DEFAULT_MODULE_OUTPUT_DIRS.outputDirRepair,
          outputDirCut:
            parsed.outputDirCut?.trim() || DEFAULT_MODULE_OUTPUT_DIRS.outputDirCut,
          coverMaxDimension: normalizeCoverMaxDimension(parsed.coverMaxDimension),
          coverProviders: normalizeCoverProviders(parsed.coverProviders),
          maxThreads: normalizeMaxThreads(parsed.maxThreads),
          shazamSampleSize: normalizeShazamSampleSize(parsed.shazamSampleSize),
        };
      }
    } catch {
      // Fallback to INITIAL_SETTINGS
    }
    return INITIAL_SETTINGS;
  });
  const [isQueryLogDetached, setIsQueryLogDetached] = useState(false);
  const [detachedLogBounds, setDetachedLogBounds] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>(() => {
    const winW = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const winH = typeof window !== 'undefined' ? window.innerHeight : 820;
    const width = Math.min(940, Math.max(460, winW - 80));
    const height = 320;
    const x = Math.max(24, Math.round((winW - width) / 2));
    const y = Math.max(68, winH - height - 40);
    return { x, y, width, height };
  });

  // MusicBrainz, Discogs, Amazon & Cover Art State
  const [searchQuery, setSearchQuery] = useState<string>('Kraftwerk Computerwelt');
  const [searchResults, setSearchResults] = useState<MusicBrainzSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingRelease, setIsLoadingRelease] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isFetchingCover, setIsFetchingCover] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [coverCandidates, setCoverCandidates] = useState<CoverSearchCandidate[]>([]);
  const [isCoverPickerOpen, setIsCoverPickerOpen] = useState(false);
  const [isApplyingCoverCandidate, setIsApplyingCoverCandidate] = useState(false);

  // Exponential Backoff Retry State (für 503-Fehler & Neu-Initialisierung)
  const [isRetryingBackoff, setIsRetryingBackoff] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [retryMaxAttempts] = useState(4);
  const lastQueryActionRef = useRef<LastMetadataQueryAction>({
    kind: 'toc',
    autoSelectFirst: false,
  });

  // Shazam Track-Erkennung State (ohne API-Schlüssel)
  const [shazamingTrackIds, setShazamingTrackIds] = useState<string[]>([]);
  const [isShazamingAll, setIsShazamingAll] = useState(false);
  const [isAnalyzingMbTracks, setIsAnalyzingMbTracks] = useState(false);
  const [isEnrichingGenres, setIsEnrichingGenres] = useState(false);

  const buildMetadataHeaders = (extra?: Record<string, string>): Record<string, string> => {
    const h: Record<string, string> = { ...(extra || {}) };
    if (settings.discogsToken?.trim()) {
      h['x-discogs-token'] = settings.discogsToken.trim();
    }
    if (settings.lastfmApiKey?.trim()) {
      h['x-lastfm-api-key'] = settings.lastfmApiKey.trim();
    }
    const mbUrl = normalizeMusicBrainzServerUrl(settings.musicbrainzServerUrl);
    if (mbUrl && mbUrl !== DEFAULT_MUSICBRAINZ_SERVER_URL) {
      h['x-mb-server-url'] = mbUrl;
    }
    h['x-mb-deep-relations'] = settings.mbLoadDeepRelations ? 'true' : 'false';
    h['x-prefer-subgenres'] = settings.preferSubgenres !== false ? 'true' : 'false';
    h['x-auto-enrich-genres'] = settings.autoEnrichTrackGenres !== false ? 'true' : 'false';
    return h;
  };

  // Online-Prüfung & Internationalisierung State (Interpreten / Komponist / Orchester / Dirigent)
  const [verifyingField, setVerifyingField] = useState<
    'artist' | 'composer' | 'orchestra' | 'conductor' | null
  >(null);
  const verifyAbortRef = useRef<AbortController | null>(null);
  const shazamAbortRef = useRef<AbortController | null>(null);
  const mbTracksAbortRef = useRef<AbortController | null>(null);

  const [queryLogHeightIdx, setQueryLogHeightIdx] = useState<number>(3);
  const [queryLogs, setQueryLogs] = useState<string[]>(() => {
    const ts = new Date().toTimeString().slice(0, 8);
    return [
      `[${ts}] [Start] Aktions- & Abfrage-Protokoll bereit (Alle Datenbanken: MusicBrainz + CDDB/GnuDB + Discogs · Trefferliste mit manueller Album-Auswahl · Auto-Backoff bei HTTP 503).`,
    ];
  });
  const logScrollRef = useRef<HTMLDivElement>(null);
  const pendingLogsRef = useRef<string[]>([]);
  const logFlushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (logFlushTimerRef.current !== null) {
        window.clearTimeout(logFlushTimerRef.current);
        logFlushTimerRef.current = null;
      }
    };
  }, []);

  const appendQueryLog = (message: string) => {
    const ts = new Date().toTimeString().slice(0, 8);
    const hasTimePrefix = /^\[\d{2}:\d{2}:\d{2}\]/.test(message);
    const formatted = hasTimePrefix ? message : `[${ts}] ${message}`;
    console.info(`[MintRip Protokoll] ${formatted}`);
    pendingLogsRef.current.push(formatted);
    if (logFlushTimerRef.current === null) {
      logFlushTimerRef.current = window.setTimeout(() => {
        logFlushTimerRef.current = null;
        const batch = pendingLogsRef.current;
        if (batch.length === 0) return;
        pendingLogsRef.current = [];
        setQueryLogs((prev) => {
          const combined = prev.concat(batch);
          return combined.length > 800 ? combined.slice(combined.length - 800) : combined;
        });
      }, 60);
    }
  };

  const prevConvertRomanRef = useRef<boolean>(settings.convertRomanNumerals !== false);
  const tagHealthScanGenRef = useRef<number>(0);

  const runModul3AudioHealthCheck = (tracksToCheck: TrackMetadata[]) => {
    const candidates = tracksToCheck.filter((t) => Boolean(t.sourceFile));
    if (candidates.length === 0) return;
    const scanGen = ++tagHealthScanGenRef.current;
    const maxCoverDim = normalizeCoverMaxDimension(settings.coverMaxDimension);
    let cursor = 0;
    let warnOrCritCount = 0;
    let doneCount = 0;

    const patchTrackHealth = (
      trackId: string,
      fileName: string | undefined,
      status: 'ok' | 'info' | 'warning' | 'critical',
      color: string,
      tooltip: string
    ) => {
      if (tagHealthScanGenRef.current !== scanGen) return;
      setAlbum((prev) => ({
        ...prev,
        tracks: prev.tracks.map((t) => {
          const matches =
            t.id === trackId ||
            (Boolean(fileName) && Boolean(t.sourceFileName) && t.sourceFileName === fileName);
          if (!matches) return t;
          return {
            ...t,
            audioHealthStatus: status,
            audioHealthColor: color,
            audioHealthTooltip: tooltip,
          };
        }),
      }));
    };

    const worker = async () => {
      while (cursor < candidates.length && tagHealthScanGenRef.current === scanGen) {
        const idx = cursor++;
        const trk = candidates[idx];
        const file = trk.sourceFile;
        if (!file) continue;
        try {
          const fd = new FormData();
          fd.append('file', file, file.name);
          fd.append('deepScan', 'true');
          fd.append('coverMaxDimension', String(maxCoverDim));
          const res = await fetch('/api/repair/analyze', { method: 'POST', body: fd });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const health: string = data?.health || 'ok';
          const findings: Array<{ severity?: string; title?: string }> = Array.isArray(data?.findings)
            ? data.findings
            : [];
          const ff: string | null = data?.structure?.flacFirefoxCompatible ?? null;
          const hasCrit =
            health === 'critical' ||
            health === 'error' ||
            findings.some((f) => f.severity === 'critical') ||
            ff === 'incompatible';
          const hasWarn =
            health === 'warning' ||
            findings.some((f) => f.severity === 'warning') ||
            ff === 'warning';
          const hasInfo = findings.some((f) => f.severity === 'info');

          const topTitles = findings
            .slice(0, 3)
            .map((f) => f.title)
            .filter(Boolean)
            .join(' · ');

          if (hasCrit) {
            warnOrCritCount++;
            patchTrackHealth(
              trk.id,
              trk.sourceFileName,
              'critical',
              '#DC2626',
              `Rot: Möglicherweise beschädigt (${findings.length} Befund(e)${topTitles ? `: ${topTitles}` : ''}) — bitte in Modul 5 prüfen & reparieren.`
            );
          } else if (hasWarn) {
            warnOrCritCount++;
            patchTrackHealth(
              trk.id,
              trk.sourceFileName,
              'warning',
              '#F97316',
              `Orange: Warnung (${findings.length} Befund(e)${topTitles ? `: ${topTitles}` : ''}) — bitte in Modul 5 prüfen & reparieren.`
            );
          } else if (hasInfo) {
            patchTrackHealth(
              trk.id,
              trk.sourceFileName,
              'info',
              '#EAB308',
              `Gelb: Hinweis (${findings.length} Hinweis(e)${topTitles ? `: ${topTitles}` : ''}) — optional in Modul 5 prüfen.`
            );
          } else {
            patchTrackHealth(
              trk.id,
              trk.sourceFileName,
              'ok',
              '#22C55E',
              'Grün: OK — Audiodatei unauffällig (keine Struktur- oder Dekodierfehler).'
            );
          }
        } catch {
          patchTrackHealth(
            trk.id,
            trk.sourceFileName,
            'warning',
            '#F97316',
            'Orange: Prüfung beim Import nicht vollständig möglich — bitte in Modul 5 prüfen.'
          );
        } finally {
          doneCount++;
          if (doneCount === candidates.length && tagHealthScanGenRef.current === scanGen) {
            if (warnOrCritCount > 0) {
              appendQueryLog(
                `[Audio-Prüfung Modul 3] Hinweis: ${warnOrCritCount} von ${candidates.length} Datei(en) zeigen Auffälligkeiten (Farbcode wie Modul 5) — bitte in Modul 5 prüfen & reparieren.`
              );
            } else {
              appendQueryLog(
                `[Audio-Prüfung Modul 3] Alle ${candidates.length} importierte(n) Audiodatei(en) geprüft (keine kritischen Fehler/Warnungen).`
              );
            }
          }
        }
      }
    };

    const concurrency = Math.min(3, candidates.length);
    for (let w = 0; w < concurrency; w++) {
      void worker();
    }
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage quota errors
    }
  }, [settings]);

  useEffect(() => {
    const isEnabled = settings.convertRomanNumerals !== false;
    const wasEnabled = prevConvertRomanRef.current;
    prevConvertRomanRef.current = isEnabled;
    if (!wasEnabled && isEnabled) {
      let changedCount = 0;
      setAlbum((prev) => {
        const nextAlbumTitle = convertRomanNumeralsInTitle(prev.title);
        if (nextAlbumTitle !== prev.title) changedCount++;
        const nextTracks = prev.tracks.map((t) => {
          const nextTitle = convertRomanNumeralsInTitle(t.title);
          if (nextTitle !== t.title) changedCount++;
          const nextOrigTitle =
            typeof t.originalTitle === 'string'
              ? convertRomanNumeralsInTitle(t.originalTitle)
              : t.originalTitle;
          const nextShazamTitle =
            typeof t.shazamTitle === 'string'
              ? convertRomanNumeralsInTitle(t.shazamTitle)
              : t.shazamTitle;
          if (
            nextTitle !== t.title ||
            nextOrigTitle !== t.originalTitle ||
            nextShazamTitle !== t.shazamTitle
          ) {
            return {
              ...t,
              title: nextTitle,
              originalTitle: nextOrigTitle,
              shazamTitle: nextShazamTitle,
            };
          }
          return t;
        });
        return {
          ...prev,
          title: nextAlbumTitle,
          tracks: nextTracks,
        };
      });
      if (changedCount > 0) {
        appendQueryLog(
          `[Titel-Normalisierung] Römische Ziffern im geladenen Album in arabische Zahlen umgewandelt (${changedCount} Anpassung(en)).`
        );
      }
    }
  }, [settings.convertRomanNumerals]);

  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [queryLogs, settings.showQueryLog, isQueryLogDetached]);

  const handleToggleQueryLogDetached = (detach: boolean) => {
    if (detach) {
      const winW = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const winH = typeof window !== 'undefined' ? window.innerHeight : 820;
      const width = Math.min(940, Math.max(460, winW - 80));
      const height = 320;
      setDetachedLogBounds((prev) => ({
        width: Math.min(winW - 32, Math.max(420, prev.width || width)),
        height: Math.min(winH - 90, Math.max(180, prev.height || height)),
        x: Math.min(Math.max(16, prev.x), Math.max(16, winW - 440)),
        y: Math.min(Math.max(64, prev.y), Math.max(64, winH - 220)),
      }));
      setIsQueryLogDetached(true);
      appendQueryLog('[Ansicht] Protokoll in eigenes Fenster abgedockt.');
    } else {
      setIsQueryLogDetached(false);
      appendQueryLog('[Ansicht] Protokoll wieder an der alten Stelle angedockt.');
    }
  };

  const handleStartDetachedLogDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = detachedLogBounds.x;
    const origY = detachedLogBounds.y;
    const width = detachedLogBounds.width;
    const height = detachedLogBounds.height;

    const onMove = (moveEvt: MouseEvent) => {
      const maxX = Math.max(12, window.innerWidth - Math.min(width, 220));
      const maxY = Math.max(12, window.innerHeight - 64);
      const nextX = Math.min(maxX, Math.max(12, origX + (moveEvt.clientX - startX)));
      const nextY = Math.min(maxY, Math.max(12, origY + (moveEvt.clientY - startY)));
      setDetachedLogBounds((prev) => ({ ...prev, x: nextX, y: nextY }));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleStartDetachedLogResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origW = detachedLogBounds.width;
    const origH = detachedLogBounds.height;

    const onMove = (moveEvt: MouseEvent) => {
      const maxW = Math.max(420, window.innerWidth - detachedLogBounds.x - 16);
      const maxH = Math.max(200, window.innerHeight - detachedLogBounds.y - 16);
      const nextW = Math.min(maxW, Math.max(420, origW + (moveEvt.clientX - startX)));
      const nextH = Math.min(maxH, Math.max(180, origH + (moveEvt.clientY - startY)));
      setDetachedLogBounds((prev) => ({ ...prev, width: nextW, height: nextH }));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleThemeModeChangeWithLog = (nextMode: ThemeMode) => {
    setThemeMode(nextMode);
    const modeLabel =
      nextMode === 'dark' ? 'Dunkel' : nextMode === 'light' ? 'Hell' : 'Systemstandard';
    appendQueryLog(`[Ansicht] Farbschema geändert auf „${modeLabel}“.`);
  };

  const handleSettingsChangeWithLog: React.Dispatch<React.SetStateAction<ExportSettings>> = (
    updater
  ) => {
    setSettings((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      const changes: string[] = [];
      if (next.outputDirCover !== prev.outputDirCover)
        changes.push(`Zielordner Modul 1 (Coverbilder): „${next.outputDirCover}“`);
      if (next.outputDirRip !== prev.outputDirRip || next.outputDir !== prev.outputDir)
        changes.push(`Zielordner Modul 2 (CD-Rips): „${next.outputDirRip || next.outputDir}“`);
      if (next.outputDirTag !== prev.outputDirTag)
        changes.push(`Zielordner Modul 3 (Album Taggen): „${next.outputDirTag}“`);
      if (next.outputDirConvert !== prev.outputDirConvert)
        changes.push(`Zielordner Modul 4 (Konvertiert): „${next.outputDirConvert}“`);
      if (next.outputDirRepair !== prev.outputDirRepair)
        changes.push(`Zielordner Modul 5 (Repariert): „${next.outputDirRepair}“`);
      if (next.outputDirCut !== prev.outputDirCut)
        changes.push(`Zielordner Modul 6 (Geschnitten): „${next.outputDirCut}“`);
      if (next.filenameTemplate !== prev.filenameTemplate)
        changes.push(`Dateinamensmuster: „${next.filenameTemplate}“`);
      if (next.exportFormat !== prev.exportFormat)
        changes.push(`Ausgabeformat: ${next.exportFormat.toUpperCase()}`);
      if (next.flacCompressionLevel !== prev.flacCompressionLevel)
        changes.push(`FLAC-Kompressionsstufe: ${next.flacCompressionLevel}`);
      if (next.flacVerify !== prev.flacVerify)
        changes.push(`FLAC-Verify: ${next.flacVerify ? 'Ein' : 'Aus'}`);
      if (next.flacReplayGain !== prev.flacReplayGain)
        changes.push(`FLAC-ReplayGain: ${next.flacReplayGain ? 'Ein' : 'Aus'}`);
      if (next.mp3Quality !== prev.mp3Quality)
        changes.push(`MP3-Qualität: ${next.mp3Quality.toUpperCase()}`);
      if (next.id3v2Version !== prev.id3v2Version)
        changes.push(`ID3v2-Version: ID3v2.${next.id3v2Version}`);
      if (next.normalizeAlbum !== prev.normalizeAlbum)
        changes.push(`Album-Normalisierung: ${next.normalizeAlbum ? 'Aktiviert' : 'Deaktiviert'}`);
      if (next.normalizeTargetLufs !== prev.normalizeTargetLufs)
        changes.push(`Ziel-Lautheit: ${next.normalizeTargetLufs.toFixed(1)} LUFS`);
      if (next.normalizeComputeAlbumGain !== prev.normalizeComputeAlbumGain)
        changes.push(`ReplayGain-Tags berechnen: ${next.normalizeComputeAlbumGain ? 'Ein' : 'Aus'}`);
      if (next.normalizeUseLoudestTrack !== prev.normalizeUseLoudestTrack)
        changes.push(
          `Referenz-Modus: ${next.normalizeUseLoudestTrack ? 'Lautester Titel' : 'Gesamtes Album'}`
        );
      if (next.normalizeTruePeak !== prev.normalizeTruePeak)
        changes.push(`Spitzenpegel: ${next.normalizeTruePeak ? 'True Peak (dBTP)' : 'Sample Peak'}`);
      if (next.normalizeWriteRefLoudnessTag !== prev.normalizeWriteRefLoudnessTag)
        changes.push(
          `REPLAYGAIN_REFERENCE_LOUDNESS: ${next.normalizeWriteRefLoudnessTag ? 'Ein' : 'Aus'}`
        );
      if (next.embedCoverArt !== prev.embedCoverArt)
        changes.push(`Cover einbetten: ${next.embedCoverArt ? 'Ein' : 'Aus'}`);
      if (next.saveFolderCover !== prev.saveFolderCover)
        changes.push(`Ordner-Cover speichern: ${next.saveFolderCover ? 'Ein' : 'Aus'}`);
      if (next.coverFilename !== prev.coverFilename)
        changes.push(`Cover-Dateiname: „${next.coverFilename}“`);
      if (
        normalizeCoverMaxDimension(next.coverMaxDimension) !==
        normalizeCoverMaxDimension(prev.coverMaxDimension)
      )
        changes.push(
          `Max. Cover-Dimensionen (Modul 5): ${normalizeCoverMaxDimension(next.coverMaxDimension)}×${normalizeCoverMaxDimension(next.coverMaxDimension)} px`
        );
      if (
        normalizeCoverProviders(next.coverProviders).join(',') !==
        normalizeCoverProviders(prev.coverProviders).join(',')
      ) {
        const nextProvs = normalizeCoverProviders(next.coverProviders);
        changes.push(
          `Cover-Bilddatenbanken: ${nextProvs.length}/${COVER_PROVIDER_OPTIONS.length} aktiviert`
        );
      }
      if (normalizeMaxThreads(next.maxThreads) !== normalizeMaxThreads(prev.maxThreads))
        changes.push(`Maximale Threads: ${normalizeMaxThreads(next.maxThreads)}`);
      if (next.ejectAfterRip !== prev.ejectAfterRip)
        changes.push(`CD nach Rip auswerfen: ${next.ejectAfterRip ? 'Ein' : 'Aus'}`);
      if (next.paranoiaMode !== prev.paranoiaMode)
        changes.push(`cdparanoia-Modus: ${next.paranoiaMode}`);
      if (next.discogsToken !== prev.discogsToken)
        changes.push(
          `Discogs-Token: ${next.discogsToken?.trim() ? 'Persönliches Token hinterlegt' : 'Standard'}`
        );
      if (next.showQueryLog !== prev.showQueryLog)
        changes.push(
          `Protokoll-Spalte am unteren Fensterrand: ${next.showQueryLog ? 'Eingeblendet' : 'Ausgeblendet'}`
        );
      if (next.convertRomanNumerals !== prev.convertRomanNumerals)
        changes.push(
          `Römische Ziffern → Arabische Zahlen: ${next.convertRomanNumerals ? 'Eingeschaltet' : 'Ausgeschaltet'}`
        );
      if (next.lastImportFolder !== prev.lastImportFolder && next.lastImportFolder)
        changes.push(`Letztes Import-Verzeichnis gespeichert: „${next.lastImportFolder}“`);

      if (changes.length > 0) {
        const ts = new Date().toTimeString().slice(0, 8);
        const msg = `[${ts}] [Einstellungen] ${changes.join(' · ')}`;
        console.info(`[MintRip Protokoll] ${msg}`);
        setQueryLogs((logs) => [...logs, msg]);
      }
      return next;
    });
  };

  const handleStartQueryLogResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startPx = QUERY_LOG_HEIGHT_PX[queryLogHeightIdx] ?? 168;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY;
      const targetPx = Math.max(96, Math.min(408, startPx + deltaY));
      let closestIdx = 0;
      let minDiff = Infinity;
      for (let i = 0; i < QUERY_LOG_HEIGHT_PX.length; i++) {
        const diff = Math.abs(QUERY_LOG_HEIGHT_PX[i] - targetPx);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      }
      setQueryLogHeightIdx(closestIdx);
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // Stapelverarbeitung (Batch Queue) State & Exklusive Display-Steuerung (Albenliste | Titel & Metadaten | Stapelverarbeitung)
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [isBatchPaused, setIsBatchPaused] = useState(false);
  const [awaitingAlbumSelection, setAwaitingAlbumSelection] = useState(false);
  const [activeRightDisplay, setActiveRightDisplay] = useState<'hits' | 'tracks' | 'batch' | null>('tracks');
  const activeRealConvertIdsRef = useRef<Set<string>>(new Set());
  const repairActionsRef = useRef<RepairWorkbenchHandle | null>(null);
  const repairImportMenuRef = useRef<HTMLDivElement | null>(null);
  const [isRepairImportMenuOpen, setIsRepairImportMenuOpen] = useState(false);
  const [repairToolbarState, setRepairToolbarState] = useState<RepairToolbarState>({
    isBusy: false,
    itemCount: 0,
  });
  const converterActionsRef = useRef<ConverterWorkbenchHandle | null>(null);
  const converterImportMenuRef = useRef<HTMLDivElement | null>(null);
  const [isConverterImportMenuOpen, setIsConverterImportMenuOpen] = useState(false);
  const [converterToolbarState, setConverterToolbarState] = useState<ConverterToolbarState>({
    isConverting: false,
  });
  const moduleJumpMenuRef = useRef<HTMLDivElement | null>(null);
  const [isModuleJumpMenuOpen, setIsModuleJumpMenuOpen] = useState(false);
  const [isFilenameToTagsOpen, setIsFilenameToTagsOpen] = useState(false);

  useEffect(() => {
    if (activeTab !== 'module_repair' && isRepairImportMenuOpen) {
      setIsRepairImportMenuOpen(false);
    }
    if (activeTab !== 'module_convert' && isConverterImportMenuOpen) {
      setIsConverterImportMenuOpen(false);
    }
    if (activeTab !== 'module_tag' && isFilenameToTagsOpen) {
      setIsFilenameToTagsOpen(false);
    }
    if (isModuleJumpMenuOpen) {
      setIsModuleJumpMenuOpen(false);
    }
  }, [activeTab]);

  useEffect(() => {
    if (!isRepairImportMenuOpen && !isConverterImportMenuOpen && !isModuleJumpMenuOpen) return;
    const handleOutside = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (isRepairImportMenuOpen && repairImportMenuRef.current && !repairImportMenuRef.current.contains(target)) {
        setIsRepairImportMenuOpen(false);
      }
      if (
        isConverterImportMenuOpen &&
        converterImportMenuRef.current &&
        !converterImportMenuRef.current.contains(target)
      ) {
        setIsConverterImportMenuOpen(false);
      }
      if (isModuleJumpMenuOpen && moduleJumpMenuRef.current && !moduleJumpMenuRef.current.contains(target)) {
        setIsModuleJumpMenuOpen(false);
      }
    };
    const handleEsc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setIsRepairImportMenuOpen(false);
        setIsConverterImportMenuOpen(false);
        setIsModuleJumpMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [isRepairImportMenuOpen, isConverterImportMenuOpen, isModuleJumpMenuOpen]);

  const isBatchActivelyRunning = isBatchRunning && !isBatchPaused;
  const isBatchAvailable =
    album.tracks.length > 0 ||
    jobs.length > 0 ||
    searchResults.length > 0 ||
    awaitingAlbumSelection;

  // 2.3: Bei aktiver Stapelverarbeitung exklusiv Display 3 ("Stapelverarbeitung") öffnen & restliche Steuerung sperren;
  // bei Pause, Abbruch oder Abschluss automatisch wieder Display 2 ("Titel- & Metadaten-Verwaltung") öffnen
  useEffect(() => {
    if (isBatchActivelyRunning) {
      setActiveRightDisplay('batch');
    } else {
      setActiveRightDisplay((prev) => (prev === 'batch' ? 'tracks' : prev));
    }
  }, [isBatchActivelyRunning]);

  // Python Source Explorer State
  const [pythonFiles, setPythonFiles] = useState<PythonProjectFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  // Systemthema-Überwachung (Light/Dark Mode gemäß Betriebssystem)
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };
    setSystemPrefersDark(media.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const effectiveDark =
      themeMode === 'dark' ? true : themeMode === 'light' ? false : systemPrefersDark;
    document.documentElement.classList.toggle('dark', effectiveDark);
  }, [themeMode, systemPrefersDark]);

  // Python-Projektdateien beim Start vom Express-Server laden
  useEffect(() => {
    let active = true;
    setIsLoadingFiles(true);
    fetch('/api/python-project/files')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { files: PythonProjectFile[] }) => {
        if (active) setPythonFiles(data.files || []);
      })
      .catch((err) => {
        if (active) {
          setFilesError(err instanceof Error ? err.message : 'Projektdateien konnten nicht geladen werden.');
        }
      })
      .finally(() => {
        if (active) setIsLoadingFiles(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Stapelverarbeitung-Worker-Loop (simuliert serielles Rippen & paralleles Encoding im Browser)
  useEffect(() => {
    if (!isBatchRunning || isBatchPaused) return;

    const timer = window.setInterval(() => {
      const stageLogs: string[] = [];

      setJobs((prevJobs) => {
        let changed = false;
        let hasActiveOrQueued = false;
        let rippingActive = prevJobs.some(
          (other) => other.stage === 'ripping' && other.sourceKind === 'cdparanoia'
        );

        const nextJobs = prevJobs.map((job) => {
          if (job.stage === 'done' || job.stage === 'error' || job.stage === 'cancelled') {
            return job;
          }
          hasActiveOrQueued = true;

          if (job.stage === 'queued') {
            if (job.tagOnly) {
              changed = true;
              const targetFile = job.sourceFileName || job.outputStem;
              const statusMsg = `Picard-Tags & Cover werden direkt in „${targetFile}“ geschrieben...`;
              stageLogs.push(
                `[Tag-Writer] Titel #${String(job.trackNumber).padStart(2, '0')} „${job.trackTitle}“ → ${statusMsg}`
              );
              return {
                ...job,
                stage: 'tagging' as const,
                progress: 0.65,
                statusMessage: statusMsg,
              };
            }
            if (job.sourceKind === 'local_file') {
              const maxEncodeWorkers = normalizeMaxThreads(settings.maxThreads);
              if (job.sourceFile && job.exportFormat === 'flac' && !activeRealConvertIdsRef.current.has(job.jobId)) {
                if (activeRealConvertIdsRef.current.size >= maxEncodeWorkers) {
                  return job;
                }
                changed = true;
                activeRealConvertIdsRef.current.add(job.jobId);
                const localQueueCount = prevJobs.filter(
                  (j) =>
                    j.sourceKind === 'local_file' &&
                    (j.stage === 'queued' || j.stage === 'ripping' || j.stage === 'encoding_flac')
                ).length;
                const workerBudget = Math.max(1, Math.min(maxEncodeWorkers, localQueueCount));
                const ffmpegThreads = Math.max(1, Math.floor(maxEncodeWorkers / workerBudget));
                const srcFile = job.sourceFile;
                const flacLvl = job.flacCompressionLevel ?? 6;
                const doNorm = Boolean(job.normalizeAlbum);
                const normLufs = job.normalizeTargetLufs ?? -18;
                const tagOverrides = job.tagOverrides || {};
                const stemName = (job.outputStem.split('/').pop() || job.trackTitle || 'track').replace(/\.[^.]+$/, '');
                const outFileName = `${stemName}.flac`;

                (async () => {
                  try {
                    const buf = await srcFile.arrayBuffer();
                    const headers: Record<string, string> = {
                      'Content-Type': 'application/octet-stream',
                    };
                    if (Object.keys(tagOverrides).length > 0) {
                      const jsonStr = JSON.stringify(tagOverrides);
                      const bytes = new TextEncoder().encode(jsonStr);
                      let bin = '';
                      bytes.forEach((b) => {
                        bin += String.fromCharCode(b);
                      });
                      headers['x-mintrip-tags'] = btoa(bin);
                    }
                    setJobs((cur) =>
                      cur.map((j) =>
                        j.jobId === job.jobId && j.stage !== 'cancelled'
                          ? {
                              ...j,
                              stage: 'encoding_flac' as const,
                              progress: 0.62,
                              statusMessage: `Schritt 2/2: WAV → FLAC -${flacLvl} (Bitraten exakt · Tags beibehalten)...`,
                            }
                          : j
                      )
                    );
                    const qs = new URLSearchParams({
                      sourceName: srcFile.name,
                      targetFormat: 'flac',
                      quality: String(flacLvl),
                      preserveTags: 'true',
                      normalize: String(doNorm),
                      targetLufs: String(normLufs),
                      ffmpegThreads: String(ffmpegThreads),
                    });
                    const resp = await fetch(`/api/convert?${qs.toString()}`, {
                      method: 'POST',
                      headers,
                      body: buf,
                    });
                    if (!resp.ok) {
                      const errData = await resp.json().catch(() => ({}));
                      throw new Error(errData.error || `HTTP ${resp.status}`);
                    }
                    const outBlob = await resp.blob();
                    const outUrl = URL.createObjectURL(outBlob);
                    const finalOut = `${job.outputStem}.flac`;
                    appendQueryLog(
                      `[WAV→FLAC] Titel #${String(job.trackNumber).padStart(2, '0')} „${job.trackTitle}“ → über WAV nach FLAC konvertiert (${outFileName}, ${(outBlob.size / (1024 * 1024)).toFixed(1)} MB · Tags erhalten).`
                    );
                    setJobs((cur) =>
                      cur.map((j) =>
                        j.jobId === job.jobId && j.stage !== 'cancelled'
                          ? {
                              ...j,
                              stage: 'done' as const,
                              progress: 1,
                              statusMessage: `Exportiert über WAV (FLAC · Tags erhalten)`,
                              outputFiles: [finalOut],
                              convertedUrl: outUrl,
                              convertedFileName: outFileName,
                            }
                          : j
                      )
                    );
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : 'WAV→FLAC Konvertierung fehlgeschlagen';
                    appendQueryLog(`[WAV→FLAC] Fehler bei „${job.trackTitle}“: ${msg}`);
                    setJobs((cur) =>
                      cur.map((j) =>
                        j.jobId === job.jobId && j.stage !== 'cancelled'
                          ? {
                              ...j,
                              stage: 'error' as const,
                              progress: 0,
                              statusMessage: `Fehler: ${msg}`,
                            }
                          : j
                      )
                    );
                  } finally {
                    activeRealConvertIdsRef.current.delete(job.jobId);
                  }
                })();
                const statusMsg = `Schritt 1/2: „${job.sourceFileName || job.trackTitle}“ wird erst nach WAV konvertiert...`;
                stageLogs.push(
                  `[WAV→FLAC] Titel #${String(job.trackNumber).padStart(2, '0')} „${job.trackTitle}“ → ${statusMsg}`
                );
                return {
                  ...job,
                  stage: 'ripping' as const,
                  progress: 0.25,
                  statusMessage: statusMsg,
                };
              }
              changed = true;
              const statusMsg = `Schritt 1/2: „${job.sourceFileName || job.trackTitle}“ wird erst nach WAV konvertiert...`;
              stageLogs.push(
                `[WAV→FLAC] Titel #${String(job.trackNumber).padStart(2, '0')} „${job.trackTitle}“ → ${statusMsg}`
              );
              return {
                ...job,
                stage: 'ripping' as const,
                progress: 0.25,
                statusMessage: statusMsg,
              };
            }
            if (job.sourceKind === 'cdparanoia' && rippingActive) {
              return job;
            }
            if (job.sourceKind === 'cdparanoia') {
              rippingActive = true;
            }
            changed = true;
            const statusMsg = 'cdparanoia liest Audio-Sektoren...';
            stageLogs.push(
              `[Stapelverarbeitung] Titel #${String(job.trackNumber).padStart(2, '0')} „${job.trackTitle}“ → Rippen gestartet (${statusMsg})`
            );
            return {
              ...job,
              stage: 'ripping' as const,
              progress: 0.08,
              statusMessage: statusMsg,
            };
          }

          if (job.stage === 'ripping') {
            if (job.sourceKind === 'local_file' && activeRealConvertIdsRef.current.has(job.jobId)) {
              return job;
            }
            changed = true;
            const nextProg = Math.min(0.55, job.progress + 0.14);
            if (nextProg >= 0.55) {
              const normNote = job.normalizeAlbum
                ? ` · Normalisiere ${(job.normalizeTargetLufs ?? -17).toFixed(1)} LUFS`
                : '';
              if (job.exportFormat === 'mp3') {
                const msg = `LAME MP3-Kodierung${normNote}...`;
                stageLogs.push(
                  `[Stapelverarbeitung] Titel #${String(job.trackNumber).padStart(2, '0')} „${job.trackTitle}“ → ${msg}`
                );
                return {
                  ...job,
                  stage: 'encoding_mp3' as const,
                  progress: 0.62,
                  statusMessage: msg,
                };
              }
              const msg =
                job.sourceKind === 'local_file'
                  ? `Schritt 2/2: WAV → FLAC -${job.flacCompressionLevel}${normNote} (Tags beibehalten)...`
                  : `FLAC -${job.flacCompressionLevel} Kodierung${normNote}...`;
              stageLogs.push(
                `[Stapelverarbeitung] Titel #${String(job.trackNumber).padStart(2, '0')} „${job.trackTitle}“ → ${msg}`
              );
              return {
                ...job,
                stage: 'encoding_flac' as const,
                progress: 0.62,
                statusMessage: msg,
              };
            }
            return {
              ...job,
              progress: nextProg,
              statusMessage:
                job.sourceKind === 'local_file'
                  ? `Schritt 1/2: Dekodiere Quelle → WAV (${Math.round((nextProg / 0.55) * 100)}%)`
                  : `Sektor-Prüfung (${Math.round((nextProg / 0.55) * 100)}%)`,
            };
          }

          if (job.stage === 'encoding_flac') {
            if (job.sourceKind === 'local_file' && activeRealConvertIdsRef.current.has(job.jobId)) {
              return job;
            }
            changed = true;
            const nextProg = Math.min(0.88, job.progress + 0.14);
            if (nextProg >= 0.88) {
              const msg = 'Vorbis-Tags & Cover werden eingebettet...';
              stageLogs.push(
                `[Stapelverarbeitung] Titel #${String(job.trackNumber).padStart(2, '0')} „${job.trackTitle}“ → ${msg}`
              );
              return {
                ...job,
                stage: 'tagging' as const,
                progress: 0.94,
                statusMessage: msg,
              };
            }
            return { ...job, progress: nextProg };
          }

          if (job.stage === 'encoding_mp3') {
            changed = true;
            const nextProg = Math.min(0.88, job.progress + 0.14);
            if (nextProg >= 0.88) {
              const msg = `ID3v2.${job.id3v2Version || 4} & Front-Cover einbetten...`;
              stageLogs.push(
                `[Stapelverarbeitung] Titel #${String(job.trackNumber).padStart(2, '0')} „${job.trackTitle}“ → ${msg}`
              );
              return {
                ...job,
                stage: 'tagging' as const,
                progress: 0.94,
                statusMessage: msg,
              };
            }
            return { ...job, progress: nextProg };
          }

          if (job.stage === 'tagging') {
            changed = true;
            if (job.tagOnly) {
              const outFile = job.sourceFileName || job.outputStem;
              stageLogs.push(
                `[Tag-Writer] Titel #${String(job.trackNumber).padStart(2, '0')} „${job.trackTitle}“ → Tags in Datei geschrieben (${outFile})`
              );
              return {
                ...job,
                stage: 'done' as const,
                progress: 1,
                statusMessage: `Tags geschrieben (${outFile})`,
                outputFiles: [outFile],
              };
            }
            const ext = job.exportFormat === 'flac' ? 'flac' : 'mp3';
            const outputs = [`${job.outputStem}.${ext}`];
            stageLogs.push(
              `[Stapelverarbeitung] Titel #${String(job.trackNumber).padStart(2, '0')} „${job.trackTitle}“ fertig exportiert → ${outputs[0]}`
            );
            return {
              ...job,
              stage: 'done' as const,
              progress: 1,
              statusMessage: `Exportiert (${ext.toUpperCase()})`,
              outputFiles: outputs,
            };
          }

          return job;
        });

        if (!hasActiveOrQueued) {
          setIsBatchRunning(false);
          setIsBatchPaused(false);
          stageLogs.push(
            '[Stapelverarbeitung] Alle Aufträge in der Warteschlange wurden abgeschlossen.'
          );
          if (settings.ejectAfterRip) {
            const physicalCdJob = nextJobs.find(
              (j) => j.sourceKind === 'cdparanoia' && j.stage === 'done'
            );
            if (physicalCdJob) {
              const targetDev = physicalCdJob.devicePath || devicePath;
              stageLogs.push(
                `[Laufwerk] Physische Audio-CD (${targetDev}) nach Abschluss des Rip-Vorgangs automatisch ausgeworfen.`
              );
              void fetch('/api/cd/tray', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device: targetDev, action: 'eject' }),
              }).catch(() => {
                // Ignorieren
              });
            } else {
              stageLogs.push(
                '[Laufwerk] Automatischer CD-Auswurf übersprungen (importiertes Album ohne physischen Datenträger).'
              );
            }
          }
        }

        if (stageLogs.length > 0) {
          const ts = new Date().toTimeString().slice(0, 8);
          setQueryLogs((prevLogs) => [
            ...prevLogs,
            ...stageLogs.map((l) => `[${ts}] ${l}`),
          ]);
        }

        return changed ? nextJobs : prevJobs;
      });
    }, 320);

    return () => window.clearInterval(timer);
  }, [isBatchRunning, isBatchPaused, settings.ejectAfterRip, devicePath]);

  const handleLookupByToc = async (
    customSynthesized?: SynthesizedTocResult,
    autoSelectFirst = false,
    extraHints?: {
      folderHint?: string;
      durations?: number[];
      trackTitles?: string[];
      throwOnError?: boolean;
    }
  ): Promise<boolean> => {
    const syn = customSynthesized || synthesizeTocFromTracks(album.tracks);
    if (syn.tracksWithLsn.length === 0) {
      setSearchError('Keine Titel vorhanden, aus denen eine TOC berechnet werden kann.');
      return false;
    }

    const durations =
      extraHints?.durations ||
      syn.tracksWithLsn.map((t) => Math.max(1, Math.round(t.exactDurationSeconds || t.durationSeconds || 180)));
    const trackTitles =
      extraHints?.trackTitles || syn.tracksWithLsn.map((t) => t.title || '');
    const defaultFolderHint =
      album.artist &&
      album.title &&
      album.artist !== 'Unbekannter Künstler' &&
      !album.title.startsWith('Lokaler Datei-Import')
        ? `${album.artist} - ${album.title}`.trim()
        : album.title && !album.title.startsWith('Lokaler Datei-Import')
          ? album.title.trim()
          : '';
    const folderHint = extraHints?.folderHint ?? defaultFolderHint;

    lastQueryActionRef.current = {
      kind: 'toc',
      syn,
      autoSelectFirst,
      folderHint,
      durations,
      trackTitles,
    };

    setAlbum((prev) => ({
      ...prev,
      cddbId: syn.cddbId,
      musicbrainzDiscId: syn.musicbrainzDiscId,
      musicbrainzToc: syn.musicbrainzToc,
      trackOffsets: syn.trackOffsets,
      leadoutOffset: syn.leadoutOffset,
      tracks: syn.tracksWithLsn,
    }));

    appendQueryLog(
      `[TOC-Generator] Virtuelle Red-Book-TOC berechnet (${syn.tracksWithLsn.length} Titel · 75 Frames/Sek · Pregap 150): CDDB-DiscID=${syn.cddbId} · MB-DiscID=${syn.musicbrainzDiscId} · TOC="${syn.musicbrainzToc}"`
    );

    // Albenliste sofort leeren, bevor die neue CD-/TOC-Abfrage startet
    setSearchResults([]);
    setAwaitingAlbumSelection(false);
    setSearchError(null);
    setIsSearching(true);
    if (!autoSelectFirst) {
      setActiveRightDisplay('hits');
    }
    try {
      const sourceTrackCount = syn.tracksWithLsn.length;
      const params = new URLSearchParams({
        toc: syn.musicbrainzToc,
        mbDiscId: syn.musicbrainzDiscId,
        cddbId: syn.cddbId,
        durations: durations.join(','),
        trackTitles: trackTitles.join('|'),
        sourceTrackCount: String(sourceTrackCount),
      });
      if (folderHint) {
        params.set('folderHint', folderHint);
        params.set('q', folderHint.replace(/\s+-\s+/g, ' '));
      } else if (album.musicbrainzReleaseId?.trim()) {
        params.set('existingMbid', album.musicbrainzReleaseId.trim());
      }

      const headers = buildMetadataHeaders();
      const resp = await fetch(`/api/metadata/search?${params.toString()}`, { headers });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status} (Server vorübergehend überlastet)`);
      }
      if (Array.isArray(data.logs)) {
        for (const line of data.logs) {
          appendQueryLog(line);
        }
      }
      const rawReleases: MusicBrainzSearchResult[] = data.releases || [];
      const releases = rawReleases.filter((r) => {
        if (sourceTrackCount <= 0) return true;
        const tc = Number(r.trackCount || 0);
        const mc = Math.max(1, Number(r.mediumCount || 1));
        return tc > 0 && (tc === sourceTrackCount || (tc > sourceTrackCount && mc > 1));
      });
      setSearchResults(releases);
      if (releases.length === 0) {
        setAwaitingAlbumSelection(false);
        setActiveRightDisplay('hits');
        setSearchError(
          `Kein Release-Treffer für die virtuelle TOC (CDDB ${syn.cddbId} / MB-DiscID ${syn.musicbrainzDiscId}) gefunden.`
        );
        return false;
      } else if (autoSelectFirst && releases[0]) {
        const top = releases[0];
        appendQueryLog(
          `[TOC-Abfrage] Bester Treffer (${top.score}% Übereinstimmung): „${top.artist} – ${top.title}“ (${(top.source || 'musicbrainz').toUpperCase()}) wird geladen...`
        );
        await handleSelectRelease(top.id, top.matchedDiscNumber || 1, top.source, syn, extraHints?.throwOnError);
      } else {
        setAwaitingAlbumSelection(true);
        setActiveRightDisplay('hits');
        appendQueryLog(
          `[Trefferliste] ${releases.length} mögliche Alben in MusicBrainz, CDDB und Discogs gefunden – bitte das korrekte Album aus der Trefferliste auswählen.`
        );
      }
      return true;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Online-Abfrage über virtuelle Datei-TOC fehlgeschlagen.';
      appendQueryLog(`Fehler bei TOC-Abfrage: ${msg}`);
      setSearchError(msg);
      if (extraHints?.throwOnError) throw err;
      return false;
    } finally {
      setIsSearching(false);
    }
  };

  const handleSearchMusicBrainz = async (
    query: string,
    autoSelectFirst = false,
    throwOnError = false
  ): Promise<boolean> => {
    const clean = query.trim();
    if (!clean) return false;
    lastQueryActionRef.current = {
      kind: 'search',
      query: clean,
      autoSelectFirst,
    };

    setIsSearching(true);
    setSearchError(null);
    if (!autoSelectFirst) {
      setActiveRightDisplay('hits');
    }

    // Prüfen, ob ein QR-Code direkt eine MusicBrainz-Release-URL oder Discogs-Release-URL enthält
    const mbUrlMatch = clean.match(/musicbrainz\.org\/release\/([a-f0-9-]{36})/i);
    if (mbUrlMatch) {
      const mbid = mbUrlMatch[1].toLowerCase();
      appendQueryLog(`[Barcode/QR] MusicBrainz-Release-Link erkannt (MBID ${mbid}) – lade Album direkt...`);
      setIsSearching(false);
      await handleSelectRelease(mbid, 1, 'musicbrainz', undefined, throwOnError);
      return true;
    }
    const dgUrlMatch = clean.match(/discogs\.com\/(?:[^/]+\/)?(release|master)\/(\d{2,12})/i);
    if (dgUrlMatch) {
      const isMaster = dgUrlMatch[1].toLowerCase() === 'master';
      const dgId = isMaster ? `m${dgUrlMatch[2]}` : dgUrlMatch[2];
      appendQueryLog(`[Barcode/QR] Discogs-${isMaster ? 'Master-' : 'Release-'}Link erkannt (Discogs #${dgId}) – lade Album direkt...`);
      setIsSearching(false);
      await handleSelectRelease(`discogs:${dgId}`, 1, 'discogs', undefined, throwOnError);
      return true;
    }

    const isDiscogsCode =
      /\[\s*[rm]?\s*\d{2,12}\s*\]/i.test(clean) ||
      /^(?:discogs\s*:\s*)?(?:(?:release|master)\s*[:/]\s*)?\[?\s*[rm]\s*\d{2,12}\s*\]?$/i.test(clean);
    const isBarcode = !isDiscogsCode && /^\d{8,14}$/.test(clean.replace(/[\s-]+/g, ''));
    appendQueryLog(
      isDiscogsCode
        ? `[Discogs-Code] Starte direkte Discogs-Abfrage für „${clean}“...`
        : isBarcode
          ? `[Barcode/QR] Starte Online-Abfrage für Barcode/EAN „${clean}“ über alle Datenbanken (MusicBrainz + Discogs)...`
          : `[Suche] Starte Online-Abfrage für „${clean}“ über alle Datenbanken (MusicBrainz + CDDB/GnuDB + Discogs)...`
    );
    try {
      const isHexCddb = /^[a-f0-9]{8}$/i.test(clean);
      const sourceTrackCount = album.tracks.length;
      const params = new URLSearchParams();
      if (isHexCddb) {
        params.set('cddbId', clean);
        if (album.musicbrainzToc) {
          params.set('toc', album.musicbrainzToc);
        }
      } else {
        params.set('q', clean);
      }
      if (sourceTrackCount > 0) {
        params.set('sourceTrackCount', String(sourceTrackCount));
        const durs = album.tracks.map((t) =>
          Math.max(0, Math.round(t.exactDurationSeconds || t.durationSeconds || 0))
        );
        if (durs.every((d) => d > 0)) {
          params.set('durations', durs.join(','));
        }
      }
      const url = `/api/metadata/search?${params.toString()}`;
      const headers = buildMetadataHeaders();
      const resp = await fetch(url, { headers });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      if (Array.isArray(data.logs)) {
        for (const line of data.logs) {
          appendQueryLog(line);
        }
      }
      const rawReleases: MusicBrainzSearchResult[] = data.releases || [];
      const releases = rawReleases.filter((r) => {
        if (sourceTrackCount <= 0) return true;
        const tc = Number(r.trackCount || 0);
        const mc = Math.max(1, Number(r.mediumCount || 1));
        return tc > 0 && (tc === sourceTrackCount || (tc > sourceTrackCount && mc > 1));
      });
      setSearchResults(releases);
      if (releases.length === 0) {
        setAwaitingAlbumSelection(false);
        setActiveRightDisplay('hits');
        setSearchError('Keine passenden Releases auf MusicBrainz, CDDB oder Discogs gefunden.');
        return false;
      } else if (autoSelectFirst && releases[0]) {
        const top = releases[0];
        appendQueryLog(
          `[Auswahl] Treffer „${top.artist} – ${top.title}“ (${(top.source || 'musicbrainz').toUpperCase()}) wird geladen...`
        );
        await handleSelectRelease(top.id, top.matchedDiscNumber || 1, top.source, undefined, throwOnError);
      } else {
        setAwaitingAlbumSelection(true);
        setActiveRightDisplay('hits');
        appendQueryLog(
          `[Trefferliste] ${releases.length} Treffer gefunden – bitte das korrekte Album aus der Trefferliste auswählen.`
        );
      }
      return true;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Online-Suche (MusicBrainz + CDDB + Discogs) fehlgeschlagen.';
      appendQueryLog(`Fehler: ${msg}`);
      setSearchError(msg);
      if (throwOnError) throw err;
      return false;
    } finally {
      setIsSearching(false);
    }
  };

  const handleEnrichTrackGenres = async () => {
    if (album.tracks.length === 0 || isEnrichingGenres) return;
    setIsEnrichingGenres(true);
    appendQueryLog(
      `[Track-Genre-Enrichment] Starte Multi-Source-Genre-Abfrage (Release-Group, Discogs Styles${
        settings.lastfmApiKey?.trim() ? ', Last.fm' : ''
      }) für „${album.artist} – ${album.title}“ (${album.tracks.length} Tracks)...`
    );
    try {
      const resp = await fetch('/api/metadata/enrich-genres', {
        method: 'POST',
        headers: buildMetadataHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          album: {
            artist: album.artist,
            albumArtist: album.albumArtist,
            title: album.title,
            genre: album.genre,
            musicbrainzReleaseId: album.musicbrainzReleaseId,
            musicbrainzReleaseGroupId: album.musicbrainzReleaseGroupId,
            discogsReleaseId: album.discogsId,
          },
          tracks: album.tracks.map((t) => ({
            id: t.id,
            trackNumber: t.trackNumber,
            title: t.title,
            artist: t.artist,
            genre: t.genre,
            musicbrainzRecordingId: t.musicbrainzRecordingId,
          })),
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (Array.isArray(data.logs)) {
        for (const line of data.logs) appendQueryLog(line);
      }
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      const trackGenres: Record<string, string> = data.trackGenres || {};
      const nextAlbumGenre = String(data.albumGenre || '').trim();
      setAlbum((prev) => ({
        ...prev,
        genre: nextAlbumGenre || prev.genre,
        tracks: prev.tracks.map((trk, idx) => {
          const enrichedGenre = trackGenres[trk.id] || trackGenres[String(trk.trackNumber || idx + 1)];
          return enrichedGenre ? { ...trk, genre: enrichedGenre } : trk;
        }),
      }));
      const sourcesLabel = Array.isArray(data.sources) && data.sources.length > 0
        ? data.sources.join(', ')
        : 'keine neuen Quellen';
      appendQueryLog(
        `[Track-Genre-Enrichment] Fertig: ${Number(data.updatedTracks || 0)} Track-Genres aktualisiert (${sourcesLabel}).`
      );
    } catch (err) {
      appendQueryLog(
        `[Track-Genre-Enrichment] Fehler: ${err instanceof Error ? err.message : 'Unbekannter Fehler'}`
      );
    } finally {
      setIsEnrichingGenres(false);
    }
  };

  const handleSelectRelease = async (
    idOrPrefixed: string,
    discNumber = 1,
    source?: 'musicbrainz' | 'discogs' | 'cddb',
    preserveToc?: SynthesizedTocResult,
    throwOnError = false
  ) => {
    lastQueryActionRef.current = {
      kind: 'release',
      idOrPrefixed,
      discNumber,
      source,
      preserveToc,
    };

    setIsLoadingRelease(true);
    setSearchError(null);
    setCoverError(null);
    try {
      const effectiveSource: 'musicbrainz' | 'discogs' | 'cddb' =
        source ||
        (idOrPrefixed.startsWith('discogs:')
          ? 'discogs'
          : idOrPrefixed.startsWith('cddb:')
            ? 'cddb'
            : 'musicbrainz');

      const sourceLabel =
        effectiveSource === 'discogs'
          ? 'Discogs'
          : effectiveSource === 'cddb'
            ? 'CDDB'
            : 'MusicBrainz';

      const existingLocalTracks = preserveToc?.tracksWithLsn || album.tracks;
      const localTracksWithFiles = existingLocalTracks.filter((t) => Boolean(t.sourceFileName));
      const localDiscSet = new Set(localTracksWithFiles.map((t) => Math.max(1, t.discNumber || 1)));
      const loadAllDiscs = discNumber === 0 || (localDiscSet.size > 1 && effectiveSource !== 'cddb');
      const reqDiscParam = loadAllDiscs ? 'all' : String(discNumber);

      appendQueryLog(
        `Lade vollständige Release-Metadaten von ${sourceLabel} (ID: ${idOrPrefixed}, ${loadAllDiscs ? 'alle CDs' : `CD ${discNumber}`})...`
      );

      let endpoint = `/api/musicbrainz/release/${encodeURIComponent(idOrPrefixed)}?disc=${reqDiscParam}`;
      if (effectiveSource === 'discogs') {
        const cleanId = idOrPrefixed.replace(/^discogs:/i, '');
        endpoint = `/api/discogs/release/${encodeURIComponent(cleanId)}?disc=${reqDiscParam}`;
      } else if (effectiveSource === 'cddb') {
        const parts = idOrPrefixed.split(':');
        const category = parts[1] || 'misc';
        const discid = parts[2] || parts[1] || idOrPrefixed;
        endpoint = `/api/cddb/release/${encodeURIComponent(category)}/${encodeURIComponent(discid)}`;
      }

      const headers = buildMetadataHeaders();

      const resp = await fetch(endpoint, { headers });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(
          data.error || `HTTP ${resp.status} (${sourceLabel} vorübergehend nicht erreichbar)`
        );
      }
      const rel = data.release;

      const hasLocalFiles = localTracksWithFiles.length > 0;
      const localByKey = new Map<string, TrackMetadata>();
      for (const lt of existingLocalTracks) {
        const key = `${Math.max(1, lt.discNumber || 1)}:${lt.trackNumber}`;
        if (!localByKey.has(key)) localByKey.set(key, lt);
      }
      const usedLocalIds = new Set<string>();

      const rawMappedTracks: TrackMetadata[] = (rel.tracks || []).map((t: any, idx: number) => {
        const tDisc = Math.max(1, Number(t.discNumber || rel.discNumber || (discNumber > 0 ? discNumber : 1)));
        const tNum = Number(t.trackNumber || idx + 1);
        let localMatch: TrackMetadata | undefined;
        if (hasLocalFiles) {
          if (localDiscSet.size > 1) {
            const keyCand = localByKey.get(`${tDisc}:${tNum}`);
            if (keyCand && !usedLocalIds.has(keyCand.id)) {
              localMatch = keyCand;
            }
          }
          if (!localMatch && idx < existingLocalTracks.length && !usedLocalIds.has(existingLocalTracks[idx].id)) {
            localMatch = existingLocalTracks[idx];
          }
          if (localMatch) usedLocalIds.add(localMatch.id);
        }
        const mergedTrackExtraTags: Record<string, string[]> = {
          ...(localMatch?.extraTags || {}),
          ...(t.extraTags && typeof t.extraTags === 'object' ? t.extraTags : {}),
        };
        return {
          id: `${effectiveSource}-${idOrPrefixed}-d${tDisc}-${tNum}-${idx + 1}`,
          trackNumber: tNum,
          discNumber: tDisc,
          discSubtitle: String(t.discSubtitle || rel.discSubtitle || localMatch?.discSubtitle || ''),
          title: applyRomanNumeralPreference(t.title, settings),
          artist: t.artist || rel.artist,
          artists: Array.isArray(t.artists) && t.artists.length > 0 ? t.artists : localMatch?.artists,
          artistSort: t.artistSort || rel.albumArtistSort || localMatch?.artistSort || '',
          durationSeconds: localMatch?.durationSeconds || t.durationSeconds || 210,
          exactDurationSeconds:
            localMatch?.exactDurationSeconds || t.durationSeconds || 210,
          genre: t.genre || localMatch?.genre || '',
          isrc: t.isrc || localMatch?.isrc || '',
          isrcs: Array.isArray(t.isrcs) && t.isrcs.length > 0 ? t.isrcs : localMatch?.isrcs,
          composer: t.composer || localMatch?.composer || '',
          orchestra: t.orchestra || localMatch?.orchestra || '',
          conductor: t.conductor || localMatch?.conductor || '',
          lyricist: t.lyricist || localMatch?.lyricist || '',
          writer: t.writer || localMatch?.writer || '',
          producer: t.producer || localMatch?.producer || '',
          arranger: t.arranger || localMatch?.arranger || '',
          engineer: t.engineer || localMatch?.engineer || '',
          mixer: t.mixer || localMatch?.mixer || '',
          djmixer: t.djmixer || localMatch?.djmixer || '',
          remixer: t.remixer || localMatch?.remixer || '',
          performers: Array.isArray(t.performers) ? t.performers : localMatch?.performers,
          work: t.work || localMatch?.work || '',
          workLanguage: t.workLanguage || localMatch?.workLanguage || '',
          musicbrainzRecordingId: t.musicbrainzRecordingId || localMatch?.musicbrainzRecordingId || '',
          musicbrainzTrackId: t.musicbrainzTrackId || localMatch?.musicbrainzTrackId || '',
          musicbrainzArtistId: t.musicbrainzArtistId || localMatch?.musicbrainzArtistId || '',
          musicbrainzWorkId: t.musicbrainzWorkId || localMatch?.musicbrainzWorkId || '',
          musicbrainzComposerId: t.musicbrainzComposerId || localMatch?.musicbrainzComposerId || '',
          extraTags: Object.keys(mergedTrackExtraTags).length > 0 ? mergedTrackExtraTags : undefined,
          shazamKey: localMatch?.shazamKey,
          shazamUrl: localMatch?.shazamUrl,
          metadataSource: t.metadataSource || sourceLabel,
          selected: localMatch ? localMatch.selected : true,
          sourceFileName: localMatch?.sourceFileName,
          sourceFileSize: localMatch?.sourceFileSize,
          sourceFile: localMatch?.sourceFile,
          audioHealthStatus: localMatch?.audioHealthStatus,
          audioHealthColor: localMatch?.audioHealthColor,
          audioHealthTooltip: localMatch?.audioHealthTooltip,
        };
      });

      const tocResult =
        preserveToc && preserveToc.tracksWithLsn.length === rawMappedTracks.length
          ? {
              ...preserveToc,
              tracksWithLsn: rawMappedTracks.map((trk, idx) => ({
                ...trk,
                startLsn: preserveToc.tracksWithLsn[idx]?.startLsn,
                endLsn: preserveToc.tracksWithLsn[idx]?.endLsn,
              })),
            }
          : synthesizeTocFromTracks(rawMappedTracks);

      // Lokales Cover-Bild aus dem Album-Verzeichnis / den Tags erhalten, damit es beim Online-Abgleich nicht verloren geht
      const hasLocalFolderOrEmbeddedCover =
        Boolean(album.coverArtUrl) &&
        /^(Ordner-Bild|Eingebettetes Cover|Festplatte|Gescanntes Cover|Lokale Datei)/i.test(
          album.coverArtSource || ''
        );

      const enabledCoverProvs = normalizeCoverProviders(settings.coverProviders);
      const coverProvSet = new Set(enabledCoverProvs);

      let nextCoverArtUrl: string | null = hasLocalFolderOrEmbeddedCover
        ? album.coverArtUrl
        : effectiveSource === 'musicbrainz' &&
            rel.musicbrainzReleaseId &&
            coverProvSet.has('musicbrainz_caa')
          ? `/api/coverart/${rel.musicbrainzReleaseId}`
          : effectiveSource === 'discogs' && rel.coverArtUrl && coverProvSet.has('discogs')
            ? rel.coverArtUrl
            : null;

      let nextCoverArtSource = hasLocalFolderOrEmbeddedCover
        ? album.coverArtSource
        : nextCoverArtUrl
          ? effectiveSource === 'musicbrainz'
            ? 'Cover Art Archive (MusicBrainz)'
            : rel.coverArtSource || 'Discogs Cover'
          : enabledCoverProvs.length === 0
            ? 'Keine Cover-Quelle aktiviert'
            : 'Kein Cover';

      let coverWidth = hasLocalFolderOrEmbeddedCover ? album.coverArtWidth : undefined;
      let coverHeight = hasLocalFolderOrEmbeddedCover ? album.coverArtHeight : undefined;
      let coverSizeBytes = hasLocalFolderOrEmbeddedCover ? album.coverArtSizeBytes : undefined;
      let coverFormat = hasLocalFolderOrEmbeddedCover ? album.coverArtFormat : undefined;
      let coverOrigFormat = hasLocalFolderOrEmbeddedCover ? album.coverArtOriginalFormat : undefined;

      if (!hasLocalFolderOrEmbeddedCover && nextCoverArtUrl) {
        try {
          const info = await inspectCoverImage(nextCoverArtUrl);
          coverWidth = info.width;
          coverHeight = info.height;
          coverSizeBytes = info.sizeBytes;
          coverFormat = info.format;
          coverOrigFormat = info.originalFormat;
        } catch {
          nextCoverArtUrl = null;
          nextCoverArtSource = 'Kein Cover';
        }
      }

      if (!hasLocalFolderOrEmbeddedCover && !nextCoverArtUrl && enabledCoverProvs.length > 0) {
        try {
          const covParams = new URLSearchParams();
          covParams.set('providers', enabledCoverProvs.join(','));
          if (rel.albumArtist || rel.artist) covParams.set('artist', rel.albumArtist || rel.artist);
          if (rel.title) covParams.set('title', rel.title);
          if (rel.musicbrainzReleaseId) covParams.set('mbid', rel.musicbrainzReleaseId);
          if (rel.musicbrainzReleaseGroupId) covParams.set('rgid', rel.musicbrainzReleaseGroupId);
          if (rel.discogsId) covParams.set('discogsId', rel.discogsId);
          if (rel.asin) covParams.set('asin', rel.asin);
          if (rel.barcode) covParams.set('barcode', rel.barcode);
          const covHeaders: Record<string, string> = {};
          if (settings.discogsToken?.trim()) {
            covHeaders['x-discogs-token'] = settings.discogsToken.trim();
          }
          const covResp = await fetch(`/api/cover/search?${covParams.toString()}`, {
            headers: covHeaders,
          });
          if (covResp.ok) {
            const covData = await covResp.json().catch(() => ({}));
            const firstCand = Array.isArray(covData.candidates) ? covData.candidates[0] : null;
            if (firstCand?.imageUrl) {
              const info = await inspectCoverImage(firstCand.imageUrl);
              nextCoverArtUrl = firstCand.imageUrl;
              nextCoverArtSource = firstCand.sourceLabel || firstCand.providerLabel || 'Online-Cover';
              coverWidth = info.width;
              coverHeight = info.height;
              coverSizeBytes = info.sizeBytes;
              coverFormat = info.format;
              coverOrigFormat = info.originalFormat;
            }
          }
        } catch {
          // Falls kein Fallback-Cover geladen werden konnte, Platzhalter belassen
        }
      }

      const normalizedRelTitle = applyRomanNumeralPreference(rel.title, settings);

      appendQueryLog(
        `${sourceLabel}: "${rel.artist} – ${normalizedRelTitle}" (${tocResult.tracksWithLsn.length} Titel${
          rel.asin ? `, Amazon ASIN: ${rel.asin}` : ''
        }${hasLocalFolderOrEmbeddedCover ? `, lokales Cover beibehalten: ${album.coverArtSource}` : ''}) erfolgreich übernommen.`
      );

      setAlbum((prev) => ({
        title: normalizedRelTitle,
        artist: rel.artist,
        albumArtist: rel.albumArtist || rel.artist,
        albumArtists: Array.isArray(rel.albumArtists) ? rel.albumArtists : prev.albumArtists,
        albumArtistSort: rel.albumArtistSort || '',
        isClassical: prev.isClassical,
        composer: rel.composer || prev.composer || '',
        orchestra: rel.orchestra || prev.orchestra || '',
        conductor: rel.conductor || prev.conductor || '',
        year: rel.year || '',
        releaseDate: rel.releaseDate || rel.year || '',
        originalDate: rel.originalDate || '',
        genre: rel.genre || '',
        label: rel.label || '',
        catalogNumber: rel.catalogNumber || '',
        barcode: rel.barcode || '',
        asin: rel.asin || '',
        country: rel.country || '',
        status: rel.status || '',
        releaseType: rel.releaseType || '',
        mediaFormat: rel.mediaFormat || 'CD',
        discSubtitle: rel.discSubtitle || '',
        script: rel.script || '',
        language: rel.language || '',
        discNumber: rel.discNumber || 1,
        totalDiscs: rel.totalDiscs || 1,
        discs: rel.discs || undefined,
        cddbId: preserveToc?.cddbId || tocResult.cddbId || rel.cddbId || '',
        musicbrainzDiscId: tocResult.musicbrainzDiscId,
        musicbrainzToc: tocResult.musicbrainzToc,
        trackOffsets: tocResult.trackOffsets,
        leadoutOffset: tocResult.leadoutOffset,
        musicbrainzReleaseId: rel.musicbrainzReleaseId || '',
        musicbrainzReleaseGroupId: rel.musicbrainzReleaseGroupId || '',
        musicbrainzAlbumArtistId: rel.musicbrainzAlbumArtistId || '',
        discogsId: rel.discogsId || '',
        metadataSource: rel.metadataSource || sourceLabel,
        coverArtUrl: nextCoverArtUrl,
        coverArtSource: nextCoverArtSource,
        coverArtWidth: coverWidth,
        coverArtHeight: coverHeight,
        coverArtSizeBytes: coverSizeBytes,
        coverArtFormat: coverFormat,
        coverArtOriginalFormat: coverOrigFormat,
        tracks: tocResult.tracksWithLsn,
      }));
      // 2.2: Exklusiv Display 2 ("Titel- & Metadaten-Verwaltung") öffnen; Display 1 & Display 3 automatisch schließen
      setAwaitingAlbumSelection(false);
      setActiveRightDisplay('tracks');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Release konnte nicht geladen werden.';
      appendQueryLog(`Fehler beim Release-Abruf: ${msg}`);
      setSearchError(msg);
      if (throwOnError) throw err;
    } finally {
      setIsLoadingRelease(false);
    }
  };

  // Automatische Wiederholung der vorherigen Metadaten-Abfrage mit exponentiellem Backoff (bei 503-Fehlern)
  const handleRetryWithBackoff = async () => {
    if (isRetryingBackoff) return;
    setIsRetryingBackoff(true);
    setSearchError(null);

    const action = lastQueryActionRef.current;
    const delaysMs = [0, 1000, 2000, 4000, 8000];

    try {
      for (let attempt = 1; attempt <= retryMaxAttempts; attempt++) {
        setRetryAttempt(attempt);
        const waitMs = delaysMs[attempt - 1] || 0;
        if (waitMs > 0) {
          appendQueryLog(
            `[Backoff-Retry] Warte ${(waitMs / 1000).toFixed(1)}s vor Wiederholungsversuch ${attempt}/${retryMaxAttempts} (Exponentieller Backoff)...`
          );
          await new Promise((r) => window.setTimeout(r, waitMs));
        } else {
          appendQueryLog(
            `[Backoff-Retry] Starte Metadaten-Abfrage neu (Versuch ${attempt}/${retryMaxAttempts})...`
          );
        }

        try {
          if (action.kind === 'release') {
            await handleSelectRelease(
              action.idOrPrefixed,
              action.discNumber,
              action.source,
              action.preserveToc,
              true
            );
          } else if (action.kind === 'search') {
            await handleSearchMusicBrainz(action.query, action.autoSelectFirst, true);
          } else {
            await handleLookupByToc(action.syn, action.autoSelectFirst, {
              folderHint: action.folderHint,
              durations: action.durations,
              trackTitles: action.trackTitles,
              throwOnError: true,
            });
          }
          appendQueryLog(
            `[Backoff-Retry] Metadaten-Abfrage im Versuch ${attempt}/${retryMaxAttempts} erfolgreich abgeschlossen.`
          );
          setSearchError(null);
          return;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          appendQueryLog(
            `[Backoff-Retry] Versuch ${attempt}/${retryMaxAttempts} fehlgeschlagen (${errMsg}).`
          );
          if (attempt === retryMaxAttempts) {
            setSearchError(
              `Metadaten-Abfrage nach ${retryMaxAttempts} exponentiellen Backoff-Versuchen fehlgeschlagen: ${errMsg}`
            );
          }
        }
      }
    } finally {
      setIsRetryingBackoff(false);
      setRetryAttempt(0);
    }
  };

  // Komplettes Neu-Initialisieren der TOC- und Metadaten-Abfrage für das geladene Album (ohne Album neu laden zu müssen)
  const handleReinitializeQuery = async () => {
    setSearchError(null);
    setCoverError(null);
    const syn = synthesizeTocFromTracks(album.tracks);
    const folderHint =
      album.artist &&
      album.title &&
      album.artist !== 'Unbekannter Künstler' &&
      !album.title.startsWith('Lokaler Datei-Import')
        ? `${album.artist} - ${album.title}`
        : searchQuery.trim();
    appendQueryLog(
      `[Neu-Initialisierung] Initialisiere virtuelle TOC (CDDB ${syn.cddbId} · MB-DiscID ${syn.musicbrainzDiscId}) und starte Online-Abfrage mit Auto-Backoff neu...`
    );
    lastQueryActionRef.current = {
      kind: 'toc',
      syn,
      autoSelectFirst: false,
      folderHint,
      durations: syn.tracksWithLsn.map((t) =>
        Math.max(1, Math.round(t.exactDurationSeconds || t.durationSeconds || 180))
      ),
      trackTitles: syn.tracksWithLsn.map((t) => t.title || ''),
    };
    await handleRetryWithBackoff();
  };

  // Schlüssellose Shazam-Abfrage für einen einzelnen Track (Audio-Fingerprint + Shazam-Katalog-Bridge)
  const handleShazamTrack = async (
    trackId: string,
    signal?: AbortSignal
  ): Promise<boolean> => {
    if (signal?.aborted) return false;
    const targetTrack = album.tracks.find((t) => t.id === trackId);
    if (!targetTrack) return false;
    if (shazamingTrackIds.includes(trackId)) return false;

    const trkPad = String(targetTrack.trackNumber).padStart(2, '0');
    setShazamingTrackIds((prev) => [...prev, trackId]);

    try {
      const sampleSize = normalizeShazamSampleSize(settings.shazamSampleSize);
      const sampleSeconds = Math.round((sampleSize / 16000) * 10) / 10;
      let pcmWindowsBase64: string[] = [];
      if (targetTrack.sourceFile) {
        appendQueryLog(
          `[Shazam #${trkPad}] Extrahiere Audio-Sample aus Track-Mitte (50 %, ${sampleSize} Samples / ${sampleSeconds}s @ 16 kHz Mono PCM) aus „${targetTrack.sourceFile.name}“...`
        );
        pcmWindowsBase64 = await extractShazamPcmWindowsFromFile(targetTrack.sourceFile, sampleSize);
      } else {
        appendQueryLog(
          `[Shazam #${trkPad}] Starte schlüssellose Shazam-Abfrage (Samplegröße ${sampleSize} / ${sampleSeconds}s ab Track-Mitte 50 %) für Titel #${trkPad} „${targetTrack.title}“...`
        );
      }

      if (signal?.aborted) return false;

      const resp = await fetch('/api/shazam/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          pcmWindowsBase64,
          sampleSize,
          devicePath,
          title: targetTrack.title,
          artist: targetTrack.artist,
          albumArtist: album.albumArtist || album.artist,
          albumTitle: album.title,
          trackNumber: targetTrack.trackNumber,
          durationSeconds: targetTrack.exactDurationSeconds || targetTrack.durationSeconds,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (Array.isArray(data.logs)) {
        for (const line of data.logs) {
          appendQueryLog(line);
        }
      }

      const rawMatch = data.match || data.track;
      if (!resp.ok || !rawMatch) {
        appendQueryLog(
          `[Shazam #${trkPad}] Kein eindeutiger Shazam-Treffer für „${targetTrack.title}“ gefunden.`
        );
        return false;
      }

      const match = {
        ...rawMatch,
        coverArtUrl: rawMatch.coverArtUrl || rawMatch.coverUrl || undefined,
      } as {
        shazamKey?: string;
        title?: string;
        artist?: string;
        album?: string;
        label?: string;
        year?: string;
        genre?: string;
        isrc?: string;
        coverArtUrl?: string;
        shazamUrl?: string;
        method?: string;
      };

      const sourceBadge =
        match.method === 'acoustic_fingerprint' || String(match.method || '').includes('Fingerprint')
          ? 'Shazam Audio-FP'
          : match.shazamKey
            ? `Shazam (#${match.shazamKey})`
            : 'Shazam';

      setAlbum((prev) => {
        const nextTracks = prev.tracks.map((t) => {
          if (t.id !== trackId) return t;
          const preservePriorOriginal =
            (Boolean(t.hasShazamAlternative) || Boolean(t.hasMbAlternative)) &&
            (t.activeMetadataVariant === 'shazam' || t.activeMetadataVariant === 'musicbrainz');
          const origTitle = preservePriorOriginal ? (t.originalTitle ?? '') : t.title;
          const origArtist = preservePriorOriginal ? (t.originalArtist ?? '') : t.artist;
          const origGenre = preservePriorOriginal ? (t.originalGenre ?? '') : (t.genre ?? '');
          const origSource = preservePriorOriginal
            ? t.originalMetadataSource
            : t.metadataSource;

          const nextTitle = match.title
            ? applyRomanNumeralPreference(match.title, settings)
            : origTitle;
          const nextArtist = match.artist
            ? normalizeMultiArtist(match.artist)
            : origArtist;
          const nextGenre = match.genre ? match.genre.trim() : origGenre;

          const origArtistComparable = normalizeMultiArtist(
            origArtist || (prev.artist && prev.artist !== 'Unbekannter Künstler' ? prev.artist : '')
          ).trim();
          const nextArtistComparable = normalizeMultiArtist(nextArtist).trim();
          const differsFromOriginal =
            nextTitle.trim() !== origTitle.trim() ||
            nextArtistComparable !== origArtistComparable ||
            nextGenre.trim() !== origGenre.trim();

          return {
            ...t,
            title: nextTitle,
            artist: nextArtist,
            genre: match.genre ? nextGenre : t.genre,
            isrc: match.isrc || t.isrc,
            shazamKey: match.shazamKey || t.shazamKey,
            shazamUrl: match.shazamUrl || t.shazamUrl,
            metadataSource: sourceBadge,
            ...(differsFromOriginal
              ? {
                  originalTitle: origTitle,
                  originalArtist: origArtist,
                  originalGenre: origGenre,
                  originalMetadataSource: origSource,
                  shazamTitle: nextTitle,
                  shazamArtist: nextArtist,
                  shazamGenre: nextGenre,
                  shazamMetadataSource: sourceBadge,
                  activeMetadataVariant: 'shazam' as const,
                  hasShazamAlternative: true,
                }
              : {
                  shazamTitle: undefined,
                  shazamArtist: undefined,
                  shazamGenre: undefined,
                  shazamMetadataSource: undefined,
                  hasShazamAlternative: false,
                  ...(t.hasMbAlternative
                    ? { activeMetadataVariant: 'original' as const }
                    : {
                        originalTitle: undefined,
                        originalArtist: undefined,
                        originalGenre: undefined,
                        originalMetadataSource: undefined,
                        activeMetadataVariant: undefined,
                      }),
                }),
          };
        });

        const nextArtist =
          !prev.artist || prev.artist === 'Unbekannter Künstler'
            ? match.artist || prev.artist
            : prev.artist;
        const nextAlbumArtist =
          !prev.albumArtist || prev.albumArtist === 'Unbekannter Künstler'
            ? match.artist || prev.albumArtist
            : prev.albumArtist;
        const nextTitle =
          !prev.title || prev.title.startsWith('Lokaler Album-Ordner')
            ? match.album
              ? applyRomanNumeralPreference(match.album, settings)
              : prev.title
            : prev.title;

        return {
          ...prev,
          title: nextTitle,
          artist: nextArtist,
          albumArtist: nextAlbumArtist,
          year: prev.year || match.year || '',
          label: prev.label || match.label || '',
          genre: prev.genre || match.genre || '',
          coverArtUrl: prev.coverArtUrl || match.coverArtUrl || null,
          coverArtSource:
            !prev.coverArtUrl && match.coverArtUrl ? 'Shazam High-Res Cover' : prev.coverArtSource,
          tracks: nextTracks,
        };
      });

      return true;
    } catch (err) {
      if (
        signal?.aborted ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        return false;
      }
      const msg = err instanceof Error ? err.message : 'Shazam-Abfrage fehlgeschlagen.';
      appendQueryLog(`[Shazam #${trkPad}] Fehler: ${msg}`);
      return false;
    } finally {
      setShazamingTrackIds((prev) => prev.filter((id) => id !== trackId));
    }
  };

  const handleCancelShazamAll = () => {
    if (shazamAbortRef.current) {
      shazamAbortRef.current.abort();
      shazamAbortRef.current = null;
    }
    setIsShazamingAll(false);
    appendQueryLog(
      '[Shazam befragen] Stopp-Anforderung gesendet – laufende Shazam-Abfrage wird abgebrochen (bisherige Treffer bleiben erhalten)...'
    );
  };

  // Ausgewählte Tracks nacheinander per Shazam abfragen (ohne API-Schlüssel)
  const handleShazamAllTracks = async () => {
    if (isShazamingAll || album.tracks.length === 0) return;
    const selectedTracks = album.tracks.filter((t) => t.selected);
    if (selectedTracks.length === 0) {
      appendQueryLog(
        '[Shazam befragen] Keine Titel ausgewählt – bitte mindestens einen Titel in der Liste auswählen.'
      );
      return;
    }
    if (shazamAbortRef.current) {
      shazamAbortRef.current.abort();
    }
    const controller = new AbortController();
    shazamAbortRef.current = controller;
    setIsShazamingAll(true);
    const trackSnapshot = [...selectedTracks];
    appendQueryLog(
      `[Shazam befragen] Starte schlüssellose Shazam-Abfrage für ${trackSnapshot.length} ausgewählte(n) Titel...`
    );

    let hits = 0;
    let processed = 0;
    try {
      for (let i = 0; i < trackSnapshot.length; i++) {
        if (controller.signal.aborted) break;
        processed++;
        const trk = trackSnapshot[i];
        const ok = await handleShazamTrack(trk.id, controller.signal);
        if (ok) hits++;
        if (controller.signal.aborted) break;
        if (i + 1 < trackSnapshot.length) {
          await new Promise<void>((resolve) => {
            if (controller.signal.aborted) {
              resolve();
              return;
            }
            const timer = window.setTimeout(() => {
              controller.signal.removeEventListener('abort', onAbort);
              resolve();
            }, 280);
            const onAbort = () => {
              window.clearTimeout(timer);
              resolve();
            };
            controller.signal.addEventListener('abort', onAbort, { once: true });
          });
        }
      }
      if (controller.signal.aborted) {
        appendQueryLog(
          `[Shazam befragen] Abfrage vom Benutzer gestoppt (${hits} von ${processed} geprüften / ${trackSnapshot.length} ausgewählten Titeln identifiziert; bisherige Treffer bleiben erhalten).`
        );
      } else {
        appendQueryLog(
          `[Shazam befragen] Abgeschlossen: ${hits} von ${trackSnapshot.length} ausgewählten Titeln erfolgreich über Shazam identifiziert.`
        );
      }
    } finally {
      if (shazamAbortRef.current === controller) {
        shazamAbortRef.current = null;
        setIsShazamingAll(false);
      }
    }
  };

  const handleCancelAnalyzeMbTracks = () => {
    if (mbTracksAbortRef.current) {
      mbTracksAbortRef.current.abort();
      mbTracksAbortRef.current = null;
    }
    setIsAnalyzingMbTracks(false);
    appendQueryLog(
      '[MusicBrainz Einzeltracks] Stopp-Anforderung gesendet – laufende Einzeltrackanalyse wird abgebrochen (bisherige Treffer bleiben erhalten)...'
    );
  };

  // Einzeltrackanalyse bei MusicBrainz: ausschließlich per Checkbox ausgewählte Tracks -> befüllt Interpret, Titel & Genre
  const handleAnalyzeMbTracks = async () => {
    if (isAnalyzingMbTracks || isShazamingAll || album.tracks.length === 0) return;
    const selectedTracks = album.tracks.filter((t) => t.selected);
    if (selectedTracks.length === 0) {
      appendQueryLog(
        '[MusicBrainz Einzeltracks] Keine Titel per Checkbox ausgewählt – bitte mindestens einen Titel aktivieren.'
      );
      return;
    }
    if (mbTracksAbortRef.current) {
      mbTracksAbortRef.current.abort();
    }
    const controller = new AbortController();
    mbTracksAbortRef.current = controller;
    setIsAnalyzingMbTracks(true);

    const trackSnapshot = [...selectedTracks];
    const fallbackArtist = (album.artist || album.albumArtist || '').trim();
    appendQueryLog(
      `[MusicBrainz Einzeltracks] Starte Einzeltrackanalyse für ${trackSnapshot.length} per Checkbox ausgewählte(n) Titel (befüllt Interpret, Titel & Genre)...`
    );

    let hits = 0;
    let processed = 0;
    try {
      for (let i = 0; i < trackSnapshot.length; i++) {
        if (controller.signal.aborted) break;
        processed++;
        const trk = trackSnapshot[i];
        const trkPad = String(trk.trackNumber).padStart(2, '0');
        try {
          const resp = await fetch('/api/musicbrainz/analyze-track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              trackNumber: trk.trackNumber,
              title: trk.title,
              artist: trk.artist,
              fallbackArtist,
              isrc: trk.isrc,
              durationSeconds: trk.durationSeconds,
              fileName: trk.sourceFileName || '',
            }),
          });
          const data = (await resp.json()) as {
            match?: {
              recordingId?: string;
              title?: string;
              artist?: string;
              genre?: string;
              method?: string;
            } | null;
            logs?: string[];
            error?: string;
          };
          if (Array.isArray(data.logs)) {
            for (const line of data.logs) appendQueryLog(line);
          }
          if (resp.ok && data.match && !controller.signal.aborted) {
            const m = data.match;
            if (m.title || m.artist || m.genre) {
              hits++;
              setAlbum((prev) => ({
                ...prev,
                tracks: prev.tracks.map((item) => {
                  if (item.id !== trk.id) return item;
                  const preservePriorOriginal =
                    (Boolean(item.hasMbAlternative) || Boolean(item.hasShazamAlternative)) &&
                    (item.activeMetadataVariant === 'musicbrainz' ||
                      item.activeMetadataVariant === 'shazam');
                  const origTitle = preservePriorOriginal ? (item.originalTitle ?? '') : item.title;
                  const origArtist = preservePriorOriginal
                    ? (item.originalArtist ?? '')
                    : item.artist;
                  const origGenre = preservePriorOriginal
                    ? (item.originalGenre ?? '')
                    : (item.genre ?? '');
                  const origSource = preservePriorOriginal
                    ? item.originalMetadataSource
                    : item.metadataSource;

                  const nextTitle = m.title
                    ? applyRomanNumeralPreference(m.title, settings)
                    : origTitle;
                  const nextArtist = m.artist ? normalizeMultiArtist(m.artist) : origArtist;
                  const nextGenre = m.genre ? m.genre.trim() : origGenre;
                  const nextSource = m.method || 'MusicBrainz (Einzeltrack)';

                  const origArtistComp = normalizeMultiArtist(
                    origArtist ||
                      (prev.artist && prev.artist !== 'Unbekannter Künstler' ? prev.artist : '')
                  ).trim();
                  const differsFromOriginal =
                    nextTitle.trim() !== origTitle.trim() ||
                    normalizeMultiArtist(nextArtist).trim() !== origArtistComp ||
                    nextGenre.trim() !== origGenre.trim();

                  return {
                    ...item,
                    title: nextTitle,
                    artist: nextArtist,
                    artists: nextArtist
                      ? nextArtist
                          .split(';')
                          .map((s) => s.trim())
                          .filter(Boolean)
                      : item.artists,
                    genre: nextGenre,
                    metadataSource: nextSource,
                    ...(differsFromOriginal
                      ? {
                          originalTitle: origTitle,
                          originalArtist: origArtist,
                          originalGenre: origGenre,
                          originalMetadataSource: origSource,
                          mbTitle: nextTitle,
                          mbArtist: nextArtist,
                          mbGenre: nextGenre,
                          mbMetadataSource: nextSource,
                          activeMetadataVariant: 'musicbrainz' as const,
                          hasMbAlternative: true,
                        }
                      : {
                          mbTitle: undefined,
                          mbArtist: undefined,
                          mbGenre: undefined,
                          mbMetadataSource: undefined,
                          hasMbAlternative: false,
                          ...(item.hasShazamAlternative
                            ? { activeMetadataVariant: 'original' as const }
                            : {
                                originalTitle: undefined,
                                originalArtist: undefined,
                                originalGenre: undefined,
                                originalMetadataSource: undefined,
                                activeMetadataVariant: undefined,
                              }),
                        }),
                  };
                }),
              }));
            }
          } else if (data.error) {
            appendQueryLog(`[MusicBrainz Einzeltrack #${trkPad}] Fehler: ${data.error}`);
          }
        } catch (err) {
          if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
            break;
          }
          const msg = err instanceof Error ? err.message : 'Einzeltrackanalyse fehlgeschlagen.';
          appendQueryLog(`[MusicBrainz Einzeltrack #${trkPad}] Fehler: ${msg}`);
        }

        if (controller.signal.aborted) break;
        if (i + 1 < trackSnapshot.length) {
          await new Promise<void>((resolve) => {
            if (controller.signal.aborted) {
              resolve();
              return;
            }
            const timer = window.setTimeout(() => {
              controller.signal.removeEventListener('abort', onAbort);
              resolve();
            }, 420);
            const onAbort = () => {
              window.clearTimeout(timer);
              resolve();
            };
            controller.signal.addEventListener('abort', onAbort, { once: true });
          });
        }
      }

      if (controller.signal.aborted) {
        appendQueryLog(
          `[MusicBrainz Einzeltracks] Analyse vom Benutzer gestoppt (${hits} von ${processed} geprüften / ${trackSnapshot.length} ausgewählten Titeln aktualisiert).`
        );
      } else {
        appendQueryLog(
          `[MusicBrainz Einzeltracks] Abgeschlossen: ${hits} von ${trackSnapshot.length} ausgewählten Titeln erfolgreich aktualisiert (Interpret, Titel & Genre).`
        );
      }
    } finally {
      if (mbTracksAbortRef.current === controller) {
        mbTracksAbortRef.current = null;
        setIsAnalyzingMbTracks(false);
      }
    }
  };

  const handleCancelVerifyField = () => {
    if (verifyAbortRef.current) {
      verifyAbortRef.current.abort();
      verifyAbortRef.current = null;
    }
    setVerifyingField(null);
  };

  // Online-Prüfung, Rechtschreibkorrektur & Internationalisierung (mehrere Werte mit ; getrennt)
  const handleVerifyField = async (
    field: 'artist' | 'composer' | 'orchestra' | 'conductor'
  ) => {
    if (verifyingField !== null || isBatchActivelyRunning) return;

    const tagMap = {
      artist: '[Interpreten-Prüfung]',
      composer: '[Komponist-Prüfung]',
      orchestra: '[Orchester-Prüfung]',
      conductor: '[Dirigent-Prüfung]',
    } as const;
    const nounMap = {
      artist: 'Interpretennamen',
      composer: 'Komponisten',
      orchestra: 'Orchesternamen',
      conductor: 'Dirigenten',
    } as const;

    const selectedTracks = album.tracks.filter((t) => t.selected);
    if (album.tracks.length > 0 && selectedTracks.length === 0) {
      appendQueryLog(
        `${tagMap[field]} Keine Titel ausgewählt – bitte mindestens einen Titel in der Liste auswählen.`
      );
      return;
    }

    const includeAlbumFields =
      album.tracks.length === 0 || selectedTracks.length === album.tracks.length;

    const hasAnyValue =
      field === 'artist'
        ? (includeAlbumFields &&
            (Boolean(album.artist.trim()) || Boolean((album.albumArtist || '').trim()))) ||
          selectedTracks.some((t) => Boolean(t.artist.trim()))
        : (includeAlbumFields && Boolean((album[field] || '').trim())) ||
          selectedTracks.some((t) => Boolean((t[field] || '').trim()));

    if (!hasAnyValue) {
      appendQueryLog(
        `${tagMap[field]} Keine ${nounMap[field]} in den ausgewählten Titeln zum Prüfen vorhanden.`
      );
      return;
    }

    const controller = new AbortController();
    verifyAbortRef.current = controller;
    setVerifyingField(field);
    appendQueryLog(
      includeAlbumFields
        ? `${tagMap[field]} Starte Prüfung & Internationalisierung (${nounMap[field]}, ;-getrennte Mehrfachwerte) für Album & ${selectedTracks.length} ausgewählte Titel...`
        : `${tagMap[field]} Starte Prüfung & Internationalisierung (${nounMap[field]}, ;-getrennte Mehrfachwerte) für ${selectedTracks.length} ausgewählte(n) Titel...`
    );

    const applyDonePayload = (data: Record<string, any>) => {
      const trackValMap = new Map<string, string>();
      for (const item of Array.isArray(data.tracks) ? data.tracks : []) {
        if (item?.id && typeof item[field] === 'string') {
          trackValMap.set(String(item.id), item[field]);
        }
      }

      setAlbum((prev) => {
        if (field === 'artist') {
          return {
            ...prev,
            artist:
              includeAlbumFields && typeof data.artist === 'string' && data.artist
                ? data.artist
                : prev.artist,
            albumArtist:
              includeAlbumFields && typeof data.albumArtist === 'string' && data.albumArtist
                ? data.albumArtist
                : prev.albumArtist,
            tracks: prev.tracks.map((trk) => ({
              ...trk,
              artist: trackValMap.get(trk.id) || trk.artist,
            })),
          };
        }
        const nextAlbumVal =
          includeAlbumFields && typeof data[field] === 'string' && data[field]
            ? data[field]
            : prev[field];
        return {
          ...prev,
          [field]: nextAlbumVal,
          tracks: prev.tracks.map((trk) => ({
            ...trk,
            [field]: trackValMap.get(trk.id) || trk[field],
          })),
        };
      });
    };

    try {
      const resp = await fetch('/api/artists/verify-international', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-verify-stream': 'ndjson',
        },
        signal: controller.signal,
        body: JSON.stringify({
          field,
          includeAlbumFields,
          artist: album.artist,
          albumArtist: album.albumArtist || album.artist,
          composer: album.composer || '',
          orchestra: album.orchestra || '',
          conductor: album.conductor || '',
          tracks: selectedTracks.map((t) => ({
            id: t.id,
            trackNumber: t.trackNumber,
            artist: t.artist,
            composer: t.composer || '',
            orchestra: t.orchestra || '',
            conductor: t.conductor || '',
          })),
        }),
      });

      const contentType = resp.headers.get('content-type') || '';
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        if (Array.isArray(errData.logs)) {
          for (const line of errData.logs) appendQueryLog(line);
        }
        throw new Error(errData.error || `HTTP ${resp.status}`);
      }

      if (resp.body && contentType.includes('ndjson')) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const handleEvent = (ev: Record<string, any>) => {
          if (!ev || typeof ev !== 'object') return;
          if (ev.type === 'log' && typeof ev.line === 'string') {
            appendQueryLog(ev.line);
          } else if (ev.type === 'update' && typeof ev.field === 'string' && typeof ev.value === 'string') {
            if (ev.scope === 'album') {
              const targetField = ev.field as 'artist' | 'albumArtist' | 'composer' | 'orchestra' | 'conductor';
              setAlbum((prev) => ({
                ...prev,
                [targetField]: ev.value,
              }));
            } else if (ev.scope === 'track' && ev.id) {
              const targetField = ev.field as 'artist' | 'composer' | 'orchestra' | 'conductor';
              setAlbum((prev) => ({
                ...prev,
                tracks: prev.tracks.map((trk) =>
                  trk.id === ev.id ? { ...trk, [targetField]: ev.value } : trk
                ),
              }));
            }
          } else if (ev.type === 'done') {
            applyDonePayload(ev);
          } else if (ev.type === 'error') {
            throw new Error(ev.error || `${nounMap[field]}-Prüfung fehlgeschlagen.`);
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              handleEvent(JSON.parse(trimmed));
            } catch (parseErr) {
              if (parseErr instanceof Error && !/JSON/i.test(parseErr.message)) {
                throw parseErr;
              }
            }
          }
        }
        if (buffer.trim()) {
          try {
            handleEvent(JSON.parse(buffer.trim()));
          } catch (parseErr) {
            if (parseErr instanceof Error && !/JSON/i.test(parseErr.message)) {
              throw parseErr;
            }
          }
        }
      } else {
        const data = await resp.json().catch(() => ({}));
        if (Array.isArray(data.logs)) {
          for (const line of data.logs) {
            appendQueryLog(line);
          }
        }
        applyDonePayload(data);
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        appendQueryLog(
          `${tagMap[field]} Abfrage vom Benutzer gestoppt (bereits geprüfte Ergebnisse bleiben erhalten).`
        );
      } else {
        const msg =
          err instanceof Error ? err.message : `${nounMap[field]}-Prüfung fehlgeschlagen.`;
        appendQueryLog(`${tagMap[field]} Fehler: ${msg}`);
      }
    } finally {
      if (verifyAbortRef.current === controller) {
        verifyAbortRef.current = null;
        setVerifyingField(null);
      }
    }
  };

  const coverSearchAbortRef = useRef<AbortController | null>(null);

  const handleCancelFetchCoverArt = () => {
    if (coverSearchAbortRef.current) {
      coverSearchAbortRef.current.abort();
      coverSearchAbortRef.current = null;
    }
    setIsFetchingCover(false);
    appendQueryLog('[Cover-Suche] Online-Cover-Suche vom Benutzer abgebrochen.');
  };

  const handleFetchCoverArt = async (customQuery?: string) => {
    if (coverSearchAbortRef.current) {
      coverSearchAbortRef.current.abort();
      coverSearchAbortRef.current = null;
    }
    const controller = new AbortController();
    coverSearchAbortRef.current = controller;

    setIsFetchingCover(true);
    setCoverError(null);
    if (activeTab === 'module_cover') {
      setCoverCandidates([]);
      setIsCoverPickerOpen(false);
      setAlbum((prev) => ({
        ...prev,
        coverArtUrl: null,
        coverArtSource: '',
        coverArtWidth: undefined,
        coverArtHeight: undefined,
        coverArtSizeBytes: undefined,
        coverArtFormat: undefined,
        coverArtOriginalFormat: undefined,
      }));
    }
    const queryFromBar = (
      typeof customQuery === 'string'
        ? customQuery
        : activeTab === 'module_cover'
          ? searchQuery
          : ''
    ).trim();
    const enabledProviders = normalizeCoverProviders(settings.coverProviders);
    if (enabledProviders.length === 0) {
      const msg = 'Keine Cover-Bilddatenbank in den Einstellungen aktiviert.';
      appendQueryLog(`[Cover-Suche] ${msg}`);
      setCoverError(msg);
      if (coverSearchAbortRef.current === controller) {
        coverSearchAbortRef.current = null;
        setIsFetchingCover(false);
      }
      return;
    }

    const providerLabels = COVER_PROVIDER_OPTIONS.filter((opt) =>
      enabledProviders.includes(opt.id)
    ).map((opt) => opt.label);

    const artistVal = (album.albumArtist || album.artist || '').trim();
    const titleVal = (album.title || '').trim();
    const defaultLabel = `${artistVal || '—'} – ${titleVal || '—'}`;
    appendQueryLog(
      `[Cover-Suche] Starte Vollabfrage über ${enabledProviders.length} aktivierte Quellen (${providerLabels.join(' · ')}) für „${
        queryFromBar || defaultLabel
      }“...`
    );
    try {
      const headers: Record<string, string> = {};
      if (settings.discogsToken?.trim()) {
        headers['x-discogs-token'] = settings.discogsToken.trim();
      }

      const params = new URLSearchParams();
      params.set('providers', enabledProviders.join(','));
      const normalizedAlbumQuery = `${artistVal} ${titleVal}`.trim().toLowerCase();
      const useAlbumFields =
        !queryFromBar ||
        queryFromBar.toLowerCase() === normalizedAlbumQuery ||
        queryFromBar.toLowerCase() === titleVal.toLowerCase();

      if (queryFromBar) {
        params.set('q', queryFromBar);
      }
      if (useAlbumFields) {
        if (artistVal && artistVal !== 'Unbekannter Künstler') params.set('artist', artistVal);
        if (titleVal && titleVal !== 'Unbekanntes Album' && titleVal !== 'Audio-CD (Lokal ausgelesen)') {
          params.set('title', titleVal);
        }
        if (album.musicbrainzReleaseId?.trim()) params.set('mbid', album.musicbrainzReleaseId.trim());
        if (album.musicbrainzReleaseGroupId?.trim()) {
          params.set('rgid', album.musicbrainzReleaseGroupId.trim());
        }
        if (album.discogsId?.trim()) params.set('discogsId', album.discogsId.trim());
        if (album.asin?.trim()) params.set('asin', album.asin.trim());
        if (album.barcode?.trim()) params.set('barcode', album.barcode.trim());
      }

      const resp = await fetch(`/api/cover/search?${params.toString()}`, {
        headers,
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (controller.signal.aborted) return;
      if (Array.isArray(data.logs)) {
        for (const line of data.logs) appendQueryLog(String(line));
      }
      if (!resp.ok) {
        throw new Error(data.error || 'Cover-Suche fehlgeschlagen.');
      }

      const candidates: CoverSearchCandidate[] = Array.isArray(data.candidates) ? data.candidates : [];
      if (candidates.length === 0) {
        setCoverCandidates([]);
        throw new Error('Kein Cover bei den aktivierten Bilddatenbanken gefunden.');
      }

      setCoverCandidates(candidates);
      if (activeTab === 'module_cover') {
        setIsCoverPickerOpen(false);
        appendQueryLog(
          `[Cover-Suche] ${candidates.length} Cover-Treffer unterhalb der Suchleiste geladen – bitte gewünschtes Bild auswählen.`
        );
      } else {
        setIsCoverPickerOpen(true);
        appendQueryLog(
          `[Cover-Suche] ${candidates.length} Cover-Treffer in der Auswahltabelle geöffnet – bitte gewünschtes Bild auswählen.`
        );
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        return;
      }
      const msg = err instanceof Error ? err.message : 'Cover-Download fehlgeschlagen.';
      appendQueryLog(`Cover-Fehler: ${msg}`);
      setCoverError(msg);
    } finally {
      if (coverSearchAbortRef.current === controller) {
        coverSearchAbortRef.current = null;
        setIsFetchingCover(false);
      }
    }
  };

  const handleSelectCoverCandidate = async (candidate: CoverSearchCandidate) => {
    setIsApplyingCoverCandidate(true);
    setCoverError(null);
    try {
      const resp = await fetch(candidate.imageUrl);
      if (!resp.ok) {
        throw new Error(`Ausgewähltes Cover konnte nicht geladen werden (HTTP ${resp.status}).`);
      }
      const blob = await resp.blob();
      const info = await inspectCoverImage(blob, `${candidate.provider}_cover`);
      appendQueryLog(
        `[Cover übernommen] ${candidate.sourceLabel}: ${info.width}×${info.height} px · ${formatCoverByteSize(info.sizeBytes)} · Format: ${info.format}.`
      );
      setAlbum((prev) => ({
        ...prev,
        musicbrainzReleaseId: prev.musicbrainzReleaseId || candidate.mbid || '',
        discogsId: prev.discogsId || candidate.discogsId || '',
        asin: prev.asin || candidate.asin || '',
        coverArtUrl: info.url,
        coverArtSource: candidate.sourceLabel,
        coverArtWidth: info.width,
        coverArtHeight: info.height,
        coverArtSizeBytes: info.sizeBytes,
        coverArtFormat: info.format,
        coverArtOriginalFormat: info.originalFormat,
      }));
      setIsCoverPickerOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Cover konnte nicht übernommen werden.';
      appendQueryLog(`Cover-Fehler: ${msg}`);
      setCoverError(msg);
    } finally {
      setIsApplyingCoverCandidate(false);
    }
  };

  const handleCoverFileDrop = (file: File, customSourceLabel?: string) => {
    const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    if (relPath.includes('/')) {
      const folderPart = relPath.split('/').slice(0, -1).join('/');
      handleSettingsChangeWithLog((prev) => ({ ...prev, lastCoverFolder: folderPart }));
    }
    const sourceLabel = customSourceLabel || `Ordner-Bild (${file.name})`;
    void inspectCoverImage(file, file.name)
      .then((info) => {
        setCoverError(null);
        appendQueryLog(
          `Cover in Vorschau geladen: ${sourceLabel} (${info.width}×${info.height} px · ${formatCoverByteSize(info.sizeBytes)} · Format: ${info.format}${
            info.format !== 'JPEG' ? ' – wird beim Einbetten nach JPG konvertiert' : ''
          }).`
        );
        setAlbum((prev) => ({
          ...prev,
          coverArtUrl: info.url,
          coverArtSource: sourceLabel,
          coverArtWidth: info.width,
          coverArtHeight: info.height,
          coverArtSizeBytes: info.sizeBytes,
          coverArtFormat: info.format,
          coverArtOriginalFormat: info.originalFormat,
        }));
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : 'Bild konnte nicht geladen werden.';
        setCoverError(msg);
        appendQueryLog(`[Cover] Fehler: ${msg}`);
      });
  };

  const ingestAudioFiles = async (
    fileList: FileList | File[],
    alsoEnqueueBatch: boolean,
    options?: { replaceExisting?: boolean; autoLookupToc?: boolean; resetBeforeImport?: boolean }
  ) => {
    const allFiles = Array.from(fileList);
    if (allFiles.length === 0) return;

    const resetBeforeImport = Boolean(options?.resetBeforeImport);
    let overlayActivatedEarly = false;
    if (resetBeforeImport) {
      handleResetAllFields();
      setActiveRightDisplay('hits');
      setIsSearching(true);
      overlayActivatedEarly = true;
    }

    try {

    // 1. Prüfe auf vorhandene Cover-Bilder direkt im ausgewählten Album-Verzeichnis (Originalformat in der Vorschau beibehalten)
    const folderCoverFile = findBestCoverImageFile(allFiles);
    let detectedCoverUrl: string | null = null;
    let detectedCoverSource = '';
    let detectedCoverWidth: number | undefined;
    let detectedCoverHeight: number | undefined;
    let detectedCoverSizeBytes: number | undefined;
    let detectedCoverFormat: string | undefined;
    let detectedCoverOriginalFormat: string | undefined;

    if (folderCoverFile) {
      try {
        const info = await inspectCoverImage(folderCoverFile, folderCoverFile.name);
        detectedCoverUrl = info.url;
        detectedCoverSource = `Ordner-Bild (${folderCoverFile.name})`;
        detectedCoverWidth = info.width;
        detectedCoverHeight = info.height;
        detectedCoverSizeBytes = info.sizeBytes;
        detectedCoverFormat = info.format;
        detectedCoverOriginalFormat = info.originalFormat;
        appendQueryLog(
          `[Ordner-Cover] Vorhandenes Cover-Bild im Album-Verzeichnis erkannt und in Vorschau geladen: „${folderCoverFile.name}“ (${info.width}×${info.height} px · ${formatCoverByteSize(
            info.sizeBytes
          )} · Format: ${info.format}).`
        );
      } catch {
        detectedCoverUrl = URL.createObjectURL(folderCoverFile);
        detectedCoverSource = `Ordner-Bild (${folderCoverFile.name})`;
        detectedCoverSizeBytes = folderCoverFile.size;
      }
    }

    // 2. Prüfe auf ein vorhandenes .cue-Sheet im Album-Verzeichnis (exakte Sektor-TOC / REM DISCID / PERFORMER / TITLE)
    const cueFile = allFiles.find((f) => /\.cue$/i.test(f.name));
    let cueMeta = cueFile ? parseCueSheetText(await cueFile.text().catch(() => '')) : null;
    if (cueMeta && cueFile) {
      appendQueryLog(
        `[CUE-Parser] CUE-Sheet „${cueFile.name}“ im Verzeichnis erkannt (${cueMeta.trackOffsets.length} Sektor-Offsets${
          cueMeta.cddbId ? ` · DISCID ${cueMeta.cddbId}` : ''
        }).`
      );
    }

    // 3. Audiodateien im ausgewählten Verzeichnis filtern
    const audioFiles = allFiles.filter(
      (f) =>
        /\.(wav|flac|mp3|mp2|ogg|aiff|aif|aifc|dsf|tta|m4a|opus|wv)$/i.test(f.name) ||
        f.type.startsWith('audio/')
    );

    // Wenn nur ein Bild im Ordner oder Drag&Drop war, Cover direkt setzen
    if (audioFiles.length === 0) {
      if (folderCoverFile) {
        handleCoverFileDrop(folderCoverFile, `Ordner-Bild (${folderCoverFile.name})`);
      }
      if (overlayActivatedEarly) {
        setIsSearching(false);
        overlayActivatedEarly = false;
      }
      return;
    }

    // 4. Ordnername & letzten Speicherort aus webkitRelativePath ermitteln und speichern
    const sampleRelPath =
      (audioFiles[0] as File & { webkitRelativePath?: string }).webkitRelativePath ||
      (allFiles[0] as File & { webkitRelativePath?: string }).webkitRelativePath ||
      '';
    const folderInfo = sampleRelPath ? parseAlbumFolderName(sampleRelPath) : null;
    if (folderInfo?.folderName) {
      const savedPath = folderInfo.parentFolderName
        ? `${folderInfo.parentFolderName}/${folderInfo.folderName}`
        : folderInfo.folderName;
      handleSettingsChangeWithLog((prev) => ({
        ...prev,
        lastImportFolder: savedPath,
      }));
    }

    const replaceExisting = options?.replaceExisting ?? true;
    const autoLookupToc = options?.autoLookupToc ?? true;

    const detectDiscFromRelPath = (relPath: string): number | undefined => {
      if (!relPath) return undefined;
      const segs = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
      const dirSegs = segs.length > 1 ? segs.slice(0, -1) : [];
      for (let idx = dirSegs.length - 1; idx >= 0; idx--) {
        const m = dirSegs[idx].trim().match(/^(?:cd|disc|disk)\s*0*(\d{1,2})(?:\b|[-_.\s]*(.*))?$/i);
        if (m) return Math.max(1, parseInt(m[1], 10));
      }
      return undefined;
    };

    const scannedItems = await Promise.all(
      audioFiles.map(async (file, rawIdx) => {
        const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
        const extracted = await extractAudioMetadataAndDuration(file);
        const parsedName = parseTrackFilename(file.name, rawIdx + 1);
        const folderDisc = detectDiscFromRelPath(relPath);
        const resolvedDisc = Math.max(
          1,
          folderDisc || extracted.discNumber || parsedName.discNumber || 1
        );
        const relDir = relPath.includes('/')
          ? relPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
          : '';
        const explicitTrackNum =
          extracted.trackNumber ||
          (/^(?:(?:cd|disc|disk)\s*0*\d{1,2}\s*[-._\s]+)?(?:\d{1,2}[-.])?\d{1,3}\s*[-._)\s]+/i.test(
            file.name.replace(/\.[^.]+$/, '').trim()
          )
            ? parsedName.trackNumber
            : undefined);
        return {
          file,
          relDir,
          extracted,
          parsedName,
          resolvedDisc,
          explicitTrackNum,
        };
      })
    );

    scannedItems.sort((a, b) => {
      if (a.resolvedDisc !== b.resolvedDisc) return a.resolvedDisc - b.resolvedDisc;
      const dirCmp = a.relDir.localeCompare(b.relDir, undefined, { numeric: true, sensitivity: 'base' });
      if (dirCmp !== 0) return dirCmp;
      const trkA = a.explicitTrackNum ?? 999999;
      const trkB = b.explicitTrackNum ?? 999999;
      if (trkA !== trkB) return trkA - trkB;
      return a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    const sortedFiles = scannedItems.map((item) => item.file);
    const parsedTracks: TrackMetadata[] = [];
    const perDiscFallbackCounters = new Map<number, number>();
    if (!replaceExisting) {
      for (const existingTrk of album.tracks) {
        const d = Math.max(1, existingTrk.discNumber || 1);
        perDiscFallbackCounters.set(d, Math.max(perDiscFallbackCounters.get(d) || 0, existingTrk.trackNumber));
      }
    }

    let tagAlbumTitle = '';
    let tagAlbumArtist = '';
    let tagAlbumArtists: string[] = [];
    let tagAlbumArtistSort = '';
    let tagComposer = '';
    let tagOrchestra = '';
    let tagConductor = '';
    let tagYear = '';
    let tagReleaseDate = '';
    let tagOriginalDate = '';
    let tagGenre = '';
    let tagBarcode = '';
    let tagCatalogNumber = '';
    let tagLabel = '';
    let tagAsin = '';
    let tagCountry = '';
    let tagStatus = '';
    let tagReleaseType = '';
    let tagMediaFormat = '';
    let tagScript = '';
    let tagLanguage = '';
    let tagDiscSubtitle = '';
    let tagMbReleaseId = '';
    let tagMbReleaseGroupId = '';
    let tagMbAlbumArtistId = '';

    for (let i = 0; i < scannedItems.length; i++) {
      const { file, extracted, parsedName, resolvedDisc, explicitTrackNum } = scannedItems[i];
      const effectiveExact = extracted.durationSeconds > 0 ? extracted.durationSeconds : 180;
      const roundedDuration = Math.max(1, Math.round(effectiveExact));
      const nextFallback = (perDiscFallbackCounters.get(resolvedDisc) || 0) + 1;
      const trackNum = explicitTrackNum || nextFallback;
      perDiscFallbackCounters.set(resolvedDisc, Math.max(nextFallback, trackNum));

      const cueTrack = cueMeta?.tracks[i];

      if (extracted.album && !tagAlbumTitle) tagAlbumTitle = extracted.album;
      if ((extracted.albumArtist || extracted.artist) && !tagAlbumArtist) {
        tagAlbumArtist = extracted.albumArtist || extracted.artist || '';
      }
      if (extracted.albumArtists && extracted.albumArtists.length > 0 && tagAlbumArtists.length === 0) {
        tagAlbumArtists = extracted.albumArtists;
      }
      if (extracted.albumArtistSort && !tagAlbumArtistSort) tagAlbumArtistSort = extracted.albumArtistSort;
      if (extracted.composer && !tagComposer) tagComposer = extracted.composer;
      if (extracted.orchestra && !tagOrchestra) tagOrchestra = extracted.orchestra;
      if (extracted.conductor && !tagConductor) tagConductor = extracted.conductor;
      if (extracted.year && !tagYear) tagYear = extracted.year;
      if (extracted.releaseDate && !tagReleaseDate) tagReleaseDate = extracted.releaseDate;
      if (extracted.originalDate && !tagOriginalDate) tagOriginalDate = extracted.originalDate;
      if (extracted.genre && !tagGenre) tagGenre = extracted.genre;
      if (extracted.barcode && !tagBarcode) tagBarcode = extracted.barcode;
      if (extracted.catalogNumber && !tagCatalogNumber) tagCatalogNumber = extracted.catalogNumber;
      if (extracted.label && !tagLabel) tagLabel = extracted.label;
      if (extracted.asin && !tagAsin) tagAsin = extracted.asin;
      if (extracted.country && !tagCountry) tagCountry = extracted.country;
      if (extracted.status && !tagStatus) tagStatus = extracted.status;
      if (extracted.releaseType && !tagReleaseType) tagReleaseType = extracted.releaseType;
      if (extracted.mediaFormat && !tagMediaFormat) tagMediaFormat = extracted.mediaFormat;
      if (extracted.script && !tagScript) tagScript = extracted.script;
      if (extracted.language && !tagLanguage) tagLanguage = extracted.language;
      if (extracted.discSubtitle && !tagDiscSubtitle) tagDiscSubtitle = extracted.discSubtitle;
      if (extracted.mbReleaseId && !tagMbReleaseId) tagMbReleaseId = extracted.mbReleaseId;
      if (extracted.mbReleaseGroupId && !tagMbReleaseGroupId) {
        tagMbReleaseGroupId = extracted.mbReleaseGroupId;
      }
      if (extracted.mbAlbumArtistId && !tagMbAlbumArtistId) {
        tagMbAlbumArtistId = extracted.mbAlbumArtistId;
      }
      if (!detectedCoverUrl && extracted.coverBlobUrl) {
        try {
          const info = await inspectCoverImage(extracted.coverBlobUrl, file.name);
          detectedCoverUrl = info.url;
          detectedCoverSource = `Eingebettetes Cover (${file.name})`;
          detectedCoverWidth = info.width;
          detectedCoverHeight = info.height;
          detectedCoverSizeBytes = info.sizeBytes;
          detectedCoverFormat = info.format;
          detectedCoverOriginalFormat = info.originalFormat;
        } catch {
          detectedCoverUrl = extracted.coverBlobUrl;
          detectedCoverSource = `Eingebettetes Cover (${file.name})`;
        }
      }

      const effectiveTrackArtist =
        extracted.artist ||
        cueTrack?.artist ||
        parsedName.artist ||
        cueMeta?.artist ||
        folderInfo?.artist ||
        (replaceExisting ? 'Unbekannter Künstler' : album.artist);

      parsedTracks.push({
        id: `drop-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        trackNumber: trackNum,
        discNumber: resolvedDisc,
        discSubtitle: extracted.discSubtitle || '',
        title: applyRomanNumeralPreference(
          extracted.title || cueTrack?.title || parsedName.title,
          settings
        ),
        artist: effectiveTrackArtist,
        artists: extracted.artists,
        artistSort: extracted.artistSort || '',
        durationSeconds: roundedDuration,
        exactDurationSeconds: effectiveExact,
        genre: extracted.genre || '',
        isrc: extracted.isrc || cueTrack?.isrc || '',
        isrcs: extracted.isrcs,
        composer: extracted.composer || '',
        orchestra: extracted.orchestra || '',
        conductor: extracted.conductor || '',
        lyricist: extracted.lyricist || '',
        writer: extracted.writer || '',
        producer: extracted.producer || '',
        work: extracted.work || '',
        workLanguage: extracted.language || '',
        musicbrainzRecordingId: extracted.mbRecordingId || '',
        musicbrainzTrackId: extracted.mbTrackId || '',
        musicbrainzArtistId: extracted.mbArtistId || '',
        musicbrainzWorkId: extracted.mbWorkId || '',
        musicbrainzComposerId: extracted.mbComposerId || '',
        extraTags: extracted.extraTags,
        metadataSource: extracted.title ? 'Datei-Tag' : cueTrack?.title ? 'CUE-Sheet' : 'Lokale Datei',
        selected: true,
        sourceFileName: file.name,
        sourceFileSize: file.size,
        sourceFile: file,
        ...(activeTab === 'module_tag'
          ? {
              audioHealthStatus: 'scanning' as const,
              audioHealthColor: '#94A3B8',
              audioHealthTooltip: 'Audiodatei wird im Hintergrund geprüft…',
            }
          : {}),
      });
    }

    const combinedTracks = replaceExisting ? parsedTracks : [...album.tracks, ...parsedTracks];
    let syn = synthesizeTocFromTracks(combinedTracks);

    // Falls ein .cue-Sheet mit exakten Sektor-Offsets für alle Tracks vorliegt, nutze die Original-Sektor-TOC
    if (
      replaceExisting &&
      cueMeta &&
      cueMeta.trackOffsets.length === combinedTracks.length &&
      syn.leadoutOffset > cueMeta.trackOffsets[cueMeta.trackOffsets.length - 1]
    ) {
      const cueOffsets = cueMeta.trackOffsets;
      const totalSec = Math.max(
        1,
        Math.floor(syn.leadoutOffset / 75) - Math.floor(cueOffsets[0] / 75)
      );
      const cddbId = cueMeta.cddbId || calculateCddbDiscId(cueOffsets, totalSec);
      const mbDiscId =
        cueMeta.mbDiscId ||
        calculateMusicBrainzDiscId(1, combinedTracks.length, syn.leadoutOffset, cueOffsets);
      const mbToc = `1 ${combinedTracks.length} ${syn.leadoutOffset} ${cueOffsets.join(' ')}`;
      syn = {
        ...syn,
        cddbId,
        musicbrainzDiscId: mbDiscId,
        musicbrainzToc: mbToc,
        trackOffsets: cueOffsets,
      };
    }

    if (replaceExisting && !alsoEnqueueBatch) {
      setJobs([]);
      setIsBatchRunning(false);
      setIsBatchPaused(false);
      setSearchResults([]);
      setAwaitingAlbumSelection(false);
      setSearchError(null);
      setCoverError(null);
    }

    const discCounts = new Map<number, number>();
    for (const trk of syn.tracksWithLsn) {
      const d = Math.max(1, trk.discNumber || 1);
      discCounts.set(d, (discCounts.get(d) || 0) + 1);
    }
    const distinctDiscs = Array.from(discCounts.keys()).sort((a, b) => a - b);
    const computedTotalDiscs = Math.max(
      1,
      distinctDiscs.length,
      distinctDiscs[distinctDiscs.length - 1] || 1
    );
    const computedDiscNumber =
      distinctDiscs[0] || folderInfo?.discNumber || (replaceExisting ? 1 : album.discNumber || 1);
    const computedDiscs =
      computedTotalDiscs > 1
        ? distinctDiscs.map((pos) => ({
            position: pos,
            title: '',
            format: 'CD',
            trackCount: discCounts.get(pos) || 0,
          }))
        : undefined;

    const resolvedArtist =
      tagAlbumArtist ||
      cueMeta?.artist ||
      folderInfo?.artist ||
      (replaceExisting ? 'Unbekannter Künstler' : album.artist);
    const rawResolvedTitle =
      tagAlbumTitle ||
      cueMeta?.album ||
      folderInfo?.album ||
      (replaceExisting
        ? folderInfo?.folderName || 'Lokaler Album-Ordner (Virtuelle TOC)'
        : album.title);
    const resolvedTitle = applyRomanNumeralPreference(rawResolvedTitle, settings);
    const resolvedYear = tagYear || cueMeta?.year || folderInfo?.year || (replaceExisting ? '' : album.year);
    const resolvedGenre = tagGenre || cueMeta?.genre || (replaceExisting ? '' : album.genre);
    const resolvedBarcode = tagBarcode || cueMeta?.barcode || (replaceExisting ? '' : album.barcode);

    setAlbum((prev) => ({
      ...(replaceExisting
        ? {
            isClassical: prev.isClassical,
            albumArtistSort: tagAlbumArtistSort || '',
            releaseDate: tagReleaseDate || '',
            originalDate: tagOriginalDate || '',
            asin: tagAsin || '',
            country: tagCountry || '',
            status: tagStatus || '',
            releaseType: tagReleaseType || '',
            mediaFormat: tagMediaFormat || 'CD',
            discSubtitle: tagDiscSubtitle || '',
            script: tagScript || '',
            language: tagLanguage || '',
            musicbrainzReleaseGroupId: tagMbReleaseGroupId || '',
            musicbrainzAlbumArtistId: tagMbAlbumArtistId || '',
            discogsId: '',
          }
        : {
            ...prev,
            albumArtistSort: prev.albumArtistSort || tagAlbumArtistSort || '',
            releaseDate: prev.releaseDate || tagReleaseDate || '',
            originalDate: prev.originalDate || tagOriginalDate || '',
            asin: prev.asin || tagAsin || '',
            country: prev.country || tagCountry || '',
            status: prev.status || tagStatus || '',
            releaseType: prev.releaseType || tagReleaseType || '',
            mediaFormat: prev.mediaFormat || tagMediaFormat || 'CD',
            discSubtitle: prev.discSubtitle || tagDiscSubtitle || '',
            script: prev.script || tagScript || '',
            language: prev.language || tagLanguage || '',
            musicbrainzReleaseGroupId: prev.musicbrainzReleaseGroupId || tagMbReleaseGroupId || '',
            musicbrainzAlbumArtistId: prev.musicbrainzAlbumArtistId || tagMbAlbumArtistId || '',
          }),
      title: resolvedTitle,
      artist: resolvedArtist,
      albumArtist: resolvedArtist,
      albumArtists:
        tagAlbumArtists.length > 0
          ? tagAlbumArtists
          : replaceExisting
            ? undefined
            : prev.albumArtists,
      composer: tagComposer || (replaceExisting ? '' : prev.composer),
      orchestra: tagOrchestra || (replaceExisting ? '' : prev.orchestra),
      conductor: tagConductor || (replaceExisting ? '' : prev.conductor),
      year: resolvedYear,
      genre: resolvedGenre,
      label: tagLabel || (replaceExisting ? '' : prev.label),
      catalogNumber: tagCatalogNumber || (replaceExisting ? '' : prev.catalogNumber),
      barcode: resolvedBarcode,
      discNumber: computedDiscNumber,
      totalDiscs: Math.max(replaceExisting ? 1 : prev.totalDiscs || 1, computedTotalDiscs),
      discs: computedDiscs || (replaceExisting ? undefined : prev.discs),
      cddbId: syn.cddbId,
      musicbrainzDiscId: syn.musicbrainzDiscId,
      musicbrainzToc: syn.musicbrainzToc,
      trackOffsets: syn.trackOffsets,
      leadoutOffset: syn.leadoutOffset,
      musicbrainzReleaseId: tagMbReleaseId || (replaceExisting ? '' : prev.musicbrainzReleaseId),
      metadataSource: replaceExisting ? 'Album-Ordner (TOC)' : prev.metadataSource,
      coverArtUrl: detectedCoverUrl || (replaceExisting ? null : prev.coverArtUrl),
      coverArtSource: detectedCoverUrl
        ? detectedCoverSource
        : replaceExisting
          ? 'Kein Cover'
          : prev.coverArtSource,
      coverArtWidth: detectedCoverUrl ? detectedCoverWidth : replaceExisting ? undefined : prev.coverArtWidth,
      coverArtHeight: detectedCoverUrl ? detectedCoverHeight : replaceExisting ? undefined : prev.coverArtHeight,
      coverArtSizeBytes: detectedCoverUrl
        ? detectedCoverSizeBytes
        : replaceExisting
          ? undefined
          : prev.coverArtSizeBytes,
      coverArtFormat: detectedCoverUrl ? detectedCoverFormat : replaceExisting ? undefined : prev.coverArtFormat,
      coverArtOriginalFormat: detectedCoverUrl
        ? detectedCoverOriginalFormat
        : replaceExisting
          ? undefined
          : prev.coverArtOriginalFormat,
      tracks: syn.tracksWithLsn,
    }));

    if (activeTab === 'module_tag' && parsedTracks.length > 0) {
      runModul3AudioHealthCheck(parsedTracks);
    }

    const folderHint =
      resolvedArtist && resolvedArtist !== 'Unbekannter Künstler' && resolvedTitle
        ? `${resolvedArtist} - ${resolvedTitle}`
        : folderInfo?.folderName || resolvedTitle;
    if (folderHint) {
      setSearchQuery(folderHint.replace(/\s+-\s+/g, ' '));
    }

    const fileNames = sortedFiles
      .slice(0, 4)
      .map((f) => f.name)
      .join(', ');
    const moreSuffix = sortedFiles.length > 4 ? ` (+${sortedFiles.length - 4} weitere)` : '';
    appendQueryLog(
      `[Ordner-Import] ${sortedFiles.length} Audiodatei(en) aus ${
        folderInfo?.folderName ? `Verzeichnis „${folderInfo.folderName}“` : 'Verzeichnis'
      } geladen: ${fileNames}${moreSuffix}${
        detectedCoverSource ? ` · Cover: ${detectedCoverSource}` : ''
      }.`
    );

    if (alsoEnqueueBatch) {
      const dropBatchRunId = `drop-${Date.now().toString(36)}`;
      const dropTracks = syn.tracksWithLsn.slice(replaceExisting ? 0 : album.tracks.length);
      const dropTotalDiscs = Math.max(1, computedTotalDiscs);
      const newJobs: BatchJob[] = dropTracks.map((trk) => {
        const effDisc = Math.max(1, trk.discNumber || computedDiscNumber || 1);
        const grpLabel =
          dropTotalDiscs > 1
            ? `CD ${effDisc}/${dropTotalDiscs} · ${resolvedArtist} – ${resolvedTitle}`
            : `Album · ${resolvedArtist} – ${resolvedTitle}`;
        return {
          jobId: `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          batchGroupId: `${dropBatchRunId}:disc${effDisc}`,
          batchGroupLabel: grpLabel,
          discNumber: effDisc,
          totalDiscs: dropTotalDiscs,
          devicePath,
          albumTitle: resolvedTitle,
          albumArtist: resolvedArtist,
          trackArtist: trk.artist || resolvedArtist,
          trackNumber: trk.trackNumber,
          trackTitle: trk.title,
          durationSeconds: trk.durationSeconds,
          exportFormat: settings.exportFormat,
          mp3Quality: settings.mp3Quality,
          id3v2Version: settings.id3v2Version,
          normalizeAlbum: settings.normalizeAlbum,
          normalizeTargetLufs: settings.normalizeTargetLufs,
          flacCompressionLevel: settings.flacCompressionLevel,
          outputStem: trk.sourceFileName || formatOutputStem(album, trk, settings),
          sourceKind: 'local_file',
          tagOnly: true,
          sourceFileName: trk.sourceFileName,
          stage: 'queued',
          progress: 0,
          statusMessage: `Bereit zum Tag-Schreiben (${trk.sourceFileName})`,
          outputFiles: [],
        };
      });
      setJobs((prev) => [...prev, ...newJobs]);
      appendQueryLog(
        `[Tag-Writer] ${newJobs.length} lokale Audiodatei(en) zum direkten Tag-Schreiben in die Warteschlange eingereiht.`
      );
    }

    if (autoLookupToc) {
      if (tagMbReleaseId && /^[a-f0-9-]{36}$/i.test(tagMbReleaseId)) {
        appendQueryLog(
          `[Tag-Erkennung] Eingebettete MusicBrainz Release-ID (${tagMbReleaseId}) erkannt – suche zusätzlich Kandidaten über alle Datenbanken für die Trefferliste...`
        );
      }
      overlayActivatedEarly = false;
      await handleLookupByToc(syn, false, {
        folderHint,
        durations: syn.tracksWithLsn.map((t) =>
          Math.max(1, Math.round(t.exactDurationSeconds || t.durationSeconds || 180))
        ),
        trackTitles: syn.tracksWithLsn.map((t) => t.title || ''),
      });
    } else {
      setAwaitingAlbumSelection(false);
      setSearchResults([]);
      if (!alsoEnqueueBatch && !isBatchRunning) {
        setActiveRightDisplay('tracks');
      }
    }
    } finally {
      if (overlayActivatedEarly) {
        setIsSearching(false);
      }
    }
  };

  // Automatische Cover-Inspektion (Auflösung, Dateigröße & Format) ohne vorzeitige Konvertierung
  useEffect(() => {
    if (!album.coverArtUrl || (album.coverArtWidth && album.coverArtSizeBytes && album.coverArtFormat)) {
      return;
    }
    let cancelled = false;
    inspectCoverImage(album.coverArtUrl)
      .then((info) => {
        if (cancelled) return;
        setAlbum((prev) => ({
          ...prev,
          coverArtWidth: info.width,
          coverArtHeight: info.height,
          coverArtSizeBytes: info.sizeBytes,
          coverArtFormat: info.format,
          coverArtOriginalFormat: info.originalFormat,
        }));
      })
      .catch(() => {
        // Ignorieren falls Cover nicht erreichbar
      });
    return () => {
      cancelled = true;
    };
  }, [album.coverArtUrl]);

  const handleToggleClassicalAlbum = () => {
    setAlbum((prev) => {
      const nextClassical = !prev.isClassical;
      appendQueryLog(
        nextClassical
          ? '[Klassikalbum] Klassikalbum-Modus aktiviert (Zusatzfelder: Komponist, Orchester, Dirigent eingeblendet).'
          : '[Klassikalbum] Klassikalbum-Modus deaktiviert.'
      );
      return {
        ...prev,
        isClassical: nextClassical,
      };
    });
  };

  const handleResetAllFields = () => {
    if (shazamAbortRef.current) {
      shazamAbortRef.current.abort();
      shazamAbortRef.current = null;
    }
    if (mbTracksAbortRef.current) {
      mbTracksAbortRef.current.abort();
      mbTracksAbortRef.current = null;
    }
    setIsAnalyzingMbTracks(false);
    setIsShazamingAll(false);
    if (verifyAbortRef.current) {
      verifyAbortRef.current.abort();
      verifyAbortRef.current = null;
    }
    setVerifyingField(null);
    setAlbum((prev) => ({
      title: '',
      artist: '',
      albumArtist: '',
      albumArtistSort: '',
      isClassical: prev.isClassical,
      composer: '',
      orchestra: '',
      conductor: '',
      year: '',
      releaseDate: '',
      originalDate: '',
      genre: '',
      label: '',
      catalogNumber: '',
      barcode: '',
      asin: '',
      country: '',
      status: '',
      releaseType: '',
      mediaFormat: 'CD',
      discSubtitle: '',
      script: '',
      language: '',
      discNumber: 1,
      totalDiscs: 1,
      discs: undefined,
      cddbId: '',
      musicbrainzDiscId: '',
      musicbrainzToc: '',
      trackOffsets: [],
      leadoutOffset: 150,
      musicbrainzReleaseId: '',
      musicbrainzReleaseGroupId: '',
      musicbrainzAlbumArtistId: '',
      discogsId: '',
      metadataSource: '',
      coverArtUrl: null,
      coverArtSource: 'Kein Cover',
      coverArtWidth: undefined,
      coverArtHeight: undefined,
      coverArtSizeBytes: undefined,
      coverArtFormat: undefined,
      coverArtOriginalFormat: undefined,
      tracks: [],
    }));
    setSearchQuery('');
    setSearchResults([]);
    setAwaitingAlbumSelection(false);
    setJobs([]);
    setIsBatchRunning(false);
    setIsBatchPaused(false);
    setActiveRightDisplay('tracks');
    setSearchError(null);
    setCoverError(null);
    appendQueryLog(
      '[Reset] Alle Metadaten-Felder, Cover-Vorschau, Trackliste und Stapelverarbeitung wurden vollständig zurückgesetzt.'
    );
  };

  const resetModuleCache = () => {
    if (coverSearchAbortRef.current) {
      coverSearchAbortRef.current.abort();
      coverSearchAbortRef.current = null;
    }
    if (shazamAbortRef.current) {
      shazamAbortRef.current.abort();
      shazamAbortRef.current = null;
    }
    if (mbTracksAbortRef.current) {
      mbTracksAbortRef.current.abort();
      mbTracksAbortRef.current = null;
    }
    setIsAnalyzingMbTracks(false);
    if (verifyAbortRef.current) {
      verifyAbortRef.current.abort();
      verifyAbortRef.current = null;
    }
    setIsFetchingCover(false);
    setIsSearching(false);
    setIsLoadingRelease(false);
    setIsRetryingBackoff(false);
    setRetryAttempt(0);
    setIsShazamingAll(false);
    setShazamingTrackIds([]);
    setVerifyingField(null);
    setCoverCandidates([]);
    setIsCoverPickerOpen(false);
    setIsApplyingCoverCandidate(false);
    setSearchQuery('');
    setSearchResults([]);
    setAwaitingAlbumSelection(false);
    setJobs([]);
    setIsBatchRunning(false);
    setIsBatchPaused(false);
    setActiveRightDisplay('tracks');
    setSearchError(null);
    setCoverError(null);
    setAlbum((prev) => ({
      title: '',
      artist: '',
      albumArtist: '',
      albumArtistSort: '',
      isClassical: prev.isClassical,
      composer: '',
      orchestra: '',
      conductor: '',
      year: '',
      releaseDate: '',
      originalDate: '',
      genre: '',
      label: '',
      catalogNumber: '',
      barcode: '',
      asin: '',
      country: '',
      status: '',
      releaseType: '',
      mediaFormat: 'CD',
      discSubtitle: '',
      script: '',
      language: '',
      discNumber: 1,
      totalDiscs: 1,
      discs: undefined,
      cddbId: '',
      musicbrainzDiscId: '',
      musicbrainzToc: '',
      trackOffsets: [],
      leadoutOffset: 150,
      musicbrainzReleaseId: '',
      musicbrainzReleaseGroupId: '',
      musicbrainzAlbumArtistId: '',
      discogsId: '',
      metadataSource: '',
      coverArtUrl: null,
      coverArtSource: 'Kein Cover',
      coverArtWidth: undefined,
      coverArtHeight: undefined,
      coverArtSizeBytes: undefined,
      coverArtFormat: undefined,
      coverArtOriginalFormat: undefined,
      tracks: [],
    }));
  };

  const navigateToModule = (nextTab: ActiveWorkspaceTab, customLog?: string) => {
    if (nextTab === activeTab) return;
    resetModuleCache();
    setActiveTab(nextTab);
    if (customLog) {
      appendQueryLog(`${customLog} (Modul-Cache zurückgesetzt.)`);
    } else {
      appendQueryLog(`[Navigation] Gewechselt zu „${nextTab}“ (Modul-Cache zurückgesetzt).`);
    }
  };

  const handleBatchStartAll = () => {
    setIsBatchPaused(false);
    setIsBatchRunning(true);
    setActiveRightDisplay('batch');
    appendQueryLog('[Stapelverarbeitung] Warteschlange gestartet.');
  };

  const handleBatchTogglePause = () => {
    setIsBatchPaused((p) => {
      const next = !p;
      setActiveRightDisplay(next ? 'tracks' : 'batch');
      appendQueryLog(`[Stapelverarbeitung] Warteschlange ${next ? 'pausiert' : 'fortgesetzt'}.`);
      return next;
    });
  };

  const handleBatchCancelAll = () => {
    setIsBatchRunning(false);
    setIsBatchPaused(false);
    setActiveRightDisplay('tracks');
    setJobs((prev) =>
      prev.map((j) =>
        j.stage === 'done'
          ? j
          : { ...j, stage: 'cancelled', statusMessage: 'Durch Benutzer abgebrochen' }
      )
    );
    appendQueryLog('[Stapelverarbeitung] Alle laufenden und wartenden Aufträge abgebrochen.');
  };

  const handleBatchClearFinished = () => {
    setJobs((prev) => prev.filter((j) => j.stage !== 'done' && j.stage !== 'cancelled'));
    appendQueryLog(
      '[Stapelverarbeitung] Abgeschlossene und abgebrochene Aufträge aus der Liste entfernt.'
    );
  };

  const handleBatchRetryJob = (jobId: string) => {
    const target = jobs.find((j) => j.jobId === jobId);
    setJobs((prev) =>
      prev.map((j) =>
        j.jobId === jobId
          ? { ...j, stage: 'queued', progress: 0, statusMessage: 'Erneut eingereiht' }
          : j
      )
    );
    setIsBatchPaused(false);
    setIsBatchRunning(true);
    if (target) {
      appendQueryLog(
        `[Stapelverarbeitung] Auftrag für Titel #${String(target.trackNumber).padStart(2, '0')} „${target.trackTitle}“ erneut gestartet.`
      );
    }
  };

  const handleBatchRemoveJob = (jobId: string) => {
    const target = jobs.find((j) => j.jobId === jobId);
    setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
    if (target) {
      appendQueryLog(
        `[Stapelverarbeitung] Auftrag für Titel #${String(target.trackNumber).padStart(2, '0')} „${target.trackTitle}“ aus der Warteschlange entfernt.`
      );
    }
  };

  const handleEnqueueAlbum = async (mode: 'tag_only' | 'convert_flac' = 'tag_only') => {
    const selectedTracks = album.tracks.filter((t) => t.selected);
    if (selectedTracks.length === 0) return;

    // Vor dem Einbetten in die Audiodateien: Nicht-JPG-Bilder automatisch in JPEG (.jpg) umwandeln
    if (
      settings.embedCoverArt &&
      album.coverArtUrl &&
      album.coverArtFormat &&
      album.coverArtFormat !== 'JPEG'
    ) {
      try {
        const norm = await normalizeCoverToJpeg(album.coverArtUrl);
        if (norm.wasConvertedToJpg) {
          appendQueryLog(
            `[Cover-Konverter] Vor dem Einbetten in die Audiodateien: Cover-Bild von ${norm.originalFormat} nach JPEG (.jpg) konvertiert (${norm.width}×${norm.height} px · ${formatCoverByteSize(norm.sizeBytes)}).`
          );
          setAlbum((prev) => ({
            ...prev,
            coverArtUrl: norm.url,
            coverArtSizeBytes: norm.sizeBytes,
            coverArtFormat: 'JPEG',
            coverArtOriginalFormat: norm.originalFormat,
          }));
        }
      } catch {
        // Fahre mit vorhandenem Cover fort
      }
    }

    const isImportedFolderOnly = selectedTracks.every((t) => Boolean(t.sourceFileName));
    const convertToFlac = isImportedFolderOnly && mode === 'convert_flac';
    const effSettings = convertToFlac ? { ...settings, exportFormat: 'flac' as const } : settings;

    const batchRunId = `cd-${Date.now().toString(36)}`;
    const distinctSelectedDiscs = new Set(
      selectedTracks.map((t) => Math.max(1, t.discNumber || album.discNumber || 1))
    );
    const totalDiscsCount = Math.max(1, album.totalDiscs || 1, distinctSelectedDiscs.size);
    const groupTitle = (album.title || 'Unbekanntes Album').trim();

    const newJobs: BatchJob[] = selectedTracks.map((trk) => {
      const isLocalFile = Boolean(trk.sourceFileName);
      const isTagOnly = isLocalFile && !convertToFlac;
      const effDisc = Math.max(1, trk.discNumber || album.discNumber || 1);
      const batchGroupId = `${batchRunId}:disc${effDisc}`;
      const batchGroupLabel = groupTitle;
      const tagOverrides: Record<string, string> | undefined = convertToFlac
        ? {
            TITLE: trk.title || '',
            ARTIST: trk.artist || album.artist || '',
            ALBUMARTIST: album.albumArtist || album.artist || '',
            ALBUM: album.title || '',
            TRACKNUMBER: String(trk.trackNumber),
            DISCNUMBER: String(effDisc),
            DATE: album.releaseDate || album.year || '',
            GENRE: album.genre || '',
            LABEL: album.label || '',
            CATALOGNUMBER: album.catalogNumber || '',
            BARCODE: album.barcode || '',
            ISRC: trk.isrc || '',
            COMPOSER: trk.composer || album.composer || '',
            CONDUCTOR: trk.conductor || album.conductor || '',
            MUSICBRAINZ_ALBUMID: album.musicbrainzReleaseId || '',
            MUSICBRAINZ_TRACKID: trk.musicbrainzRecordingId || '',
          }
        : undefined;

      return {
        jobId: `job-${Date.now()}-${trk.trackNumber}-${Math.random().toString(36).slice(2, 6)}`,
        batchGroupId,
        batchGroupLabel,
        discNumber: effDisc,
        totalDiscs: totalDiscsCount,
        devicePath: isLocalFile ? '' : devicePath,
        albumTitle: album.title,
        albumArtist: album.albumArtist || album.artist,
        trackArtist: trk.artist || album.artist,
        trackNumber: trk.trackNumber,
        trackTitle: trk.title,
        durationSeconds: trk.durationSeconds,
        exportFormat: effSettings.exportFormat,
        mp3Quality: effSettings.mp3Quality,
        id3v2Version: effSettings.id3v2Version,
        normalizeAlbum: effSettings.normalizeAlbum,
        normalizeTargetLufs: effSettings.normalizeTargetLufs,
        flacCompressionLevel: effSettings.flacCompressionLevel,
        outputStem: isTagOnly
          ? trk.sourceFileName || formatOutputStem(album, trk, effSettings)
          : formatOutputStem(album, trk, effSettings),
        sourceKind: isLocalFile ? 'local_file' : 'cdparanoia',
        tagOnly: isTagOnly,
        sourceFileName: trk.sourceFileName,
        sourceFile: convertToFlac ? trk.sourceFile : undefined,
        tagOverrides,
        stage: 'queued',
        progress: 0,
        statusMessage: convertToFlac
          ? `Wartet: ${trk.sourceFileName} → WAV → FLAC (Tags beibehalten)`
          : isLocalFile
            ? `Bereit zum Tag-Schreiben (${trk.sourceFileName})`
            : 'Wartet auf cdparanoia',
        outputFiles: [],
      };
    });

    setJobs((prev) => [...prev, ...newJobs]);
    setAwaitingAlbumSelection(false);
    setActiveRightDisplay('batch');
    setIsBatchPaused(false);
    setIsBatchRunning(true);
    if (convertToFlac) {
      appendQueryLog(
        `[WAV→FLAC] ${newJobs.length} importierte Datei(en) von „${album.artist} – ${album.title}“ zur 2-Schritt-Umwandlung (erst WAV, dann FLAC · Tags & Cover beibehalten) gestartet.`
      );
    } else if (isImportedFolderOnly) {
      appendQueryLog(
        `[Tag-Writer] ${newJobs.length} importierte Datei(en) von „${album.artist} – ${album.title}“ zum direkten Tag-Schreiben (ohne Re-Rip) gestartet.`
      );
    } else {
      appendQueryLog(
        `[Stapelverarbeitung] ${newJobs.length} ausgewählte Titel von „${album.artist} – ${album.title}“ als ${effSettings.exportFormat.toUpperCase()} in Warteschlange eingereiht und gestartet.`
      );
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F5F6] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] transition-colors">
      {/* Obere Toolbar: ohne "Einstellungen"-Button (Aufruf über die Kachel auf der Startseite) */}
      {(() => {
        const isMinimalToolbarView =
          activeTab === 'home' ||
          activeTab === 'module_cover' ||
          activeTab === 'module_convert' ||
          activeTab === 'module_repair' ||
          activeTab === 'module_cut' ||
          activeTab === 'settings';

        return (
          <header className="sticky top-0 z-30 bg-white/95 dark:bg-[#25292E]/95 backdrop-blur-xs border-b border-[#E1E4E8] dark:border-[#343A40]">
            <div className="max-w-[1440px] mx-auto px-6 h-14 flex items-center justify-between gap-6">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={isBatchActivelyRunning}
                  onClick={() =>
                    navigateToModule('home', '[Navigation] Zurückgekehrt zur Startseite (Modulauswahl).')
                  }
                  className="inline-flex items-center gap-2 text-base font-bold tracking-tight text-[#1F2328] dark:text-[#EAEEF2] whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <SystemIcon
                    name="optical_drive"
                    className="w-5 h-5 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                  />
                  <span>MintRip Studio</span>
                </button>

                <button
                  type="button"
                  disabled={isBatchActivelyRunning}
                  onClick={() =>
                    navigateToModule('home', '[Navigation] Zurückgekehrt zur Startseite.')
                  }
                  title="Zurück zur Modul-Startseite"
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded border transition-colors whitespace-nowrap cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                    activeTab === 'home'
                      ? 'border-[#5BA632] bg-[#5BA632] text-white shadow-xs'
                      : 'border-[#5BA632] bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] hover:bg-[#5BA632]/20'
                  }`}
                >
                  <SystemIcon name="home_start" className="w-3.5 h-3.5" />
                  <span>Startseite</span>
                </button>

                {activeTab !== 'home' && (
                  <div ref={moduleJumpMenuRef} className="relative shrink-0">
                    <button
                      type="button"
                      disabled={isBatchActivelyRunning}
                      aria-haspopup="menu"
                      aria-expanded={isModuleJumpMenuOpen}
                      onClick={() => setIsModuleJumpMenuOpen((prev) => !prev)}
                      title="Direkt zu einem anderen Modul oder den Einstellungen wechseln"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] disabled:opacity-45 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
                    >
                      <span>Module</span>
                      <span aria-hidden="true" className="text-[11px] opacity-80 shrink-0">
                        ▾
                      </span>
                    </button>

                    {isModuleJumpMenuOpen && !isBatchActivelyRunning && (
                      <div
                        role="menu"
                        aria-label="Direkt zu anderem Modul wechseln"
                        className="absolute left-0 mt-1 w-64 z-40 rounded-md border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] shadow-lg py-1"
                      >
                        {MODULE_SPECS.filter((m) => m.id !== activeTab).map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setIsModuleJumpMenuOpen(false);
                              navigateToModule(
                                m.id,
                                `[Navigation] Modul geöffnet: „${m.numberLabel} · ${m.title}“.`
                              );
                            }}
                            className="w-full px-3 py-1.5 text-left text-xs text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#5BA632]/10 flex items-center gap-2 cursor-pointer"
                          >
                            <SystemIcon
                              name={m.icon}
                              className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                            />
                            <span className="truncate font-medium">
                              {m.numberLabel.replace(' Modul', '')} {m.title}
                            </span>
                          </button>
                        ))}
                        {activeTab !== 'settings' && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setIsModuleJumpMenuOpen(false);
                              navigateToModule('settings', '[Navigation] Einstellungsseite geöffnet.');
                            }}
                            className="w-full px-3 py-1.5 text-left text-xs text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#5BA632]/10 flex items-center gap-2 cursor-pointer border-t border-[#E1E4E8] dark:border-[#343A40] mt-1 pt-2"
                          >
                            <SystemIcon
                              name="settings"
                              className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                            />
                            <span className="truncate font-medium">Einstellungen</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'module_tag' && (
                  <>
                    <div className="h-5 w-px bg-[#D0D7DE] dark:bg-[#444C56] shrink-0" />
                    <button
                      type="button"
                      disabled={isBatchActivelyRunning}
                      onClick={() => {
                        appendQueryLog('[Dateiname → Tags] EasyTAG-Maskeneditor geöffnet.');
                        setIsFilenameToTagsOpen(true);
                      }}
                      title="Tags anhand einer EasyTAG-Maske aus Dateinamen & Ordnernamen extrahieren (Maskeneditor öffnen)"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] disabled:opacity-45 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
                    >
                      <SystemIcon
                        name="module_tag"
                        className="w-3.5 h-3.5 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                      />
                      <span>Dateiname zu Tags</span>
                    </button>
                  </>
                )}

                {activeTab === 'module_convert' && (
                  <>
                    <div className="h-5 w-px bg-[#D0D7DE] dark:bg-[#444C56] shrink-0" />
                    <div ref={converterImportMenuRef} className="relative shrink-0">
                      <button
                        type="button"
                        disabled={converterToolbarState.isConverting}
                        aria-haspopup="menu"
                        aria-expanded={isConverterImportMenuOpen}
                        onClick={() => setIsConverterImportMenuOpen((prev) => !prev)}
                        title={`Einzeldateien oder Verzeichnisbaum wählen (Letzter Ort: ${
                          settings.lastImportFolder || '~/Musik'
                        })`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <SystemIcon name="music_folder" className="w-3.5 h-3.5 shrink-0" />
                        <span>Dateien / Ordner importieren</span>
                        <span aria-hidden="true" className="text-[11px] opacity-90 shrink-0">
                          ▾
                        </span>
                      </button>

                      {isConverterImportMenuOpen && !converterToolbarState.isConverting && (
                        <div
                          role="menu"
                          aria-label="Importquelle für Konverter"
                          className="absolute left-0 mt-1 w-72 z-40 rounded-md border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] shadow-lg py-1"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setIsConverterImportMenuOpen(false);
                              converterActionsRef.current?.openSingleFilePicker();
                            }}
                            className="w-full px-3 py-2 text-left text-xs text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#5BA632]/10 flex items-center gap-2 cursor-pointer"
                          >
                            <SystemIcon
                              name="add_files"
                              className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                            />
                            <span>
                              <strong className="block font-semibold">
                                Einzelne Dateien auswählen…
                              </strong>
                              <span className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                                Eine oder mehrere Audiodateien direkt laden
                              </span>
                            </span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setIsConverterImportMenuOpen(false);
                              converterActionsRef.current?.openRecursiveFolderPicker();
                            }}
                            className="w-full px-3 py-2 text-left text-xs text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#5BA632]/10 flex items-center gap-2 cursor-pointer border-t border-[#E1E4E8] dark:border-[#343A40]"
                          >
                            <SystemIcon
                              name="music_folder"
                              className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                            />
                            <span>
                              <strong className="block font-semibold">
                                Ordner rekursiv importieren…
                              </strong>
                              <span className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                                Verzeichnisbaum inkl. Unterordner durchsuchen
                              </span>
                            </span>
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {activeTab === 'module_repair' && (
                  <>
                    <div className="h-5 w-px bg-[#D0D7DE] dark:bg-[#444C56] shrink-0" />
                    <div ref={repairImportMenuRef} className="relative shrink-0">
                      <button
                        type="button"
                        disabled={repairToolbarState.isBusy}
                        aria-haspopup="menu"
                        aria-expanded={isRepairImportMenuOpen}
                        onClick={() => setIsRepairImportMenuOpen((prev) => !prev)}
                        title={`Einzelne Dateien oder Ordner rekursiv laden (Letzter Ort: ${
                          settings.lastImportFolder || '~/Musik'
                        })`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <SystemIcon name="music_folder" className="w-3.5 h-3.5 shrink-0" />
                        <span>Dateien oder Ordner importieren</span>
                        <span aria-hidden="true" className="text-[11px] opacity-90 shrink-0">
                          ▾
                        </span>
                      </button>

                      {isRepairImportMenuOpen && !repairToolbarState.isBusy && (
                        <div
                          role="menu"
                          aria-label="Auswahlquelle für Audio-Diagnose"
                          className="absolute left-0 mt-1 w-72 z-40 rounded-md border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] shadow-lg py-1"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setIsRepairImportMenuOpen(false);
                              repairActionsRef.current?.openSingleFilePicker();
                            }}
                            className="w-full px-3 py-2 text-left text-xs text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#5BA632]/10 flex items-center gap-2 cursor-pointer"
                          >
                            <SystemIcon
                              name="add_files"
                              className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                            />
                            <span>
                              <strong className="block font-semibold">
                                Einzelne Dateien auswählen…
                              </strong>
                              <span className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                                Eine oder mehrere Audiodateien direkt laden
                              </span>
                            </span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setIsRepairImportMenuOpen(false);
                              repairActionsRef.current?.openRecursiveFolderPicker();
                            }}
                            className="w-full px-3 py-2 text-left text-xs text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#5BA632]/10 flex items-center gap-2 cursor-pointer border-t border-[#E1E4E8] dark:border-[#343A40]"
                          >
                            <SystemIcon
                              name="music_folder"
                              className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                            />
                            <span>
                              <strong className="block font-semibold">
                                Ordner rekursiv scannen…
                              </strong>
                              <span className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                                Verzeichnisbaum inkl. Unterordner durchsuchen
                              </span>
                            </span>
                          </button>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      disabled={repairToolbarState.isBusy || repairToolbarState.itemCount === 0}
                      onClick={() => repairActionsRef.current?.rescanAll()}
                      title="Alle geladenen Audiodateien erneut analysieren"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] disabled:opacity-45 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <SystemIcon
                        name="refresh_disc"
                        className="w-3.5 h-3.5 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                      />
                      <span>Neu analysieren</span>
                    </button>
                  </>
                )}
              </div>

              {!isMinimalToolbarView ? (
                <nav className="flex items-center gap-6 overflow-x-auto" aria-label="Arbeitsbereiche">
                  {(
                    [
                      { id: 'module_cover', label: 'Coverbild beziehen' },
                      { id: 'module_rip', label: 'CD-Rippen' },
                      { id: 'module_tag', label: 'Album Taggen' },
                      { id: 'source', label: 'Python-Quellcode' },
                    ] as const
                  ).map((item) => {
                    const isActive = activeTab === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={isBatchActivelyRunning}
                        onClick={() =>
                          navigateToModule(item.id, `[Navigation] Gewechselt zu „${item.label}“.`)
                        }
                        className={`py-3.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                          isActive
                            ? 'border-[#5BA632] dark:border-[#69B53F] text-[#1F2328] dark:text-[#EAEEF2]'
                            : 'border-transparent text-[#57606A] dark:text-[#8B949E] hover:text-[#1F2328] dark:hover:text-[#EAEEF2]'
                        }`}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </nav>
              ) : (
                <div />
              )}

              <div className="flex items-center gap-2 shrink-0">
                {!isMinimalToolbarView && (
                  <>
                    <button
                      type="button"
                      disabled={isBatchActivelyRunning}
                      aria-pressed={Boolean(album.isClassical)}
                      onClick={handleToggleClassicalAlbum}
                      title="Klassikalbum-Modus umschalten: Zeigt Komponist, Orchester und Dirigent in der rechten Track-Spalte sowie links mit Zuordnungs-Pfeilen an"
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                        album.isClassical
                          ? 'border-[#5BA632] bg-[#5BA632] text-white shadow-xs'
                          : 'border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B]'
                      }`}
                    >
                      <SystemIcon
                        name="classical_album"
                        className={`w-3.5 h-3.5 ${
                          album.isClassical ? 'text-white' : 'text-[#5BA632] dark:text-[#69B53F]'
                        }`}
                      />
                      <span>Klassikalbum</span>
                    </button>
                    <button
                      type="button"
                      disabled={isBatchActivelyRunning}
                      onClick={handleResetAllFields}
                      title="Alle Metadaten-Felder, Cover-Vorschau und Trackliste vollständig zurücksetzen"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B] transition-colors whitespace-nowrap cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                    >
                      <SystemIcon name="clear_list" className="w-3.5 h-3.5 text-[#DC2626] dark:text-[#F87171]" />
                      <span>Felder zurücksetzen</span>
                    </button>
                  </>
                )}
                <button
                  type="button"
                  aria-pressed={settings.showQueryLog}
                  onClick={() => {
                    handleSettingsChangeWithLog((prev) => ({
                      ...prev,
                      showQueryLog: !prev.showQueryLog,
                    }));
                  }}
                  title="Aktions- & Abfrage-Protokoll am unteren Fensterrand ein- oder ausblenden"
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                    settings.showQueryLog
                      ? 'border-[#5BA632] bg-[#5BA632] text-white shadow-xs'
                      : 'border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B]'
                  }`}
                >
                  <SystemIcon
                    name="batch_queue"
                    className={`w-3.5 h-3.5 ${
                      settings.showQueryLog ? 'text-white' : 'text-[#57606A] dark:text-[#8B949E]'
                    }`}
                  />
                  <span>Protokoll anzeigen</span>
                </button>
                {!isMinimalToolbarView && (
                  <a
                    href="/api/python-project/download"
                    download="mintrip-linux-mint.zip"
                    tabIndex={isBatchActivelyRunning ? -1 : undefined}
                    aria-disabled={isBatchActivelyRunning}
                    onClick={(e) => {
                      if (isBatchActivelyRunning) {
                        e.preventDefault();
                        return;
                      }
                      appendQueryLog('[Export] Linux-Mint-Projektarchiv (mintrip-linux-mint.zip) heruntergeladen.');
                    }}
                    className={`inline-flex items-center px-3.5 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white transition-colors whitespace-nowrap shrink-0 ${
                      isBatchActivelyRunning ? 'opacity-45 pointer-events-none cursor-not-allowed' : ''
                    }`}
                  >
                    Projekt-ZIP laden
                  </a>
                )}
              </div>
            </div>
          </header>
        );
      })()}

      {/* Haupt-Arbeitsbereich */}
      <main
        className={`flex-1 w-full max-w-[1440px] mx-auto px-6 py-5 ${
          activeTab === 'home' ? 'flex flex-col items-center justify-center' : ''
        }`}
      >
        {activeTab === 'home' && (
          <StartPageLauncher
            onSelectModule={(modId) => {
              const spec = MODULE_SPECS.find((m) => m.id === modId);
              const label =
                modId === 'settings'
                  ? '[Navigation] Einstellungsseite geöffnet.'
                  : `[Navigation] Modul geöffnet: „${spec ? `${spec.numberLabel} · ${spec.title}` : modId}“.`;
              navigateToModule(modId, label);
            }}
            activeAlbumTitle={album.title}
            activeAlbumArtist={album.albumArtist || album.artist}
            trackCount={album.tracks.length}
            hasCover={Boolean(album.coverArtUrl)}
            batchCount={jobs.length}
          />
        )}

        {(activeTab === 'module_cover' ||
          activeTab === 'module_rip' ||
          activeTab === 'module_tag') && (
          <MetadataWorkbench
            key={activeTab}
            moduleMode={
              activeTab === 'module_cover'
                ? 'cover_only'
                : activeTab === 'module_tag'
                ? 'album_tag'
                : 'cd_rip'
            }
            onBackToHome={() =>
              navigateToModule('home', '[Navigation] Zurückgekehrt zur Startseite (Modulauswahl).')
            }
            onOpenCoverPicker={() => setIsCoverPickerOpen(true)}
            isFilenameToTagsOpen={isFilenameToTagsOpen}
            onCloseFilenameToTags={() => setIsFilenameToTagsOpen(false)}
            album={album}
            onAlbumChange={setAlbum}
            settings={settings}
            onSettingsChange={handleSettingsChangeWithLog}
            devicePath={devicePath}
            onDevicePathChange={setDevicePath}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            searchResults={searchResults}
            isSearching={isSearching}
            isLoadingRelease={isLoadingRelease}
            searchError={searchError}
            onSearchMusicBrainz={handleSearchMusicBrainz}
            onSelectRelease={handleSelectRelease}
            onFetchCoverArt={(q) => void handleFetchCoverArt(q)}
            onCancelFetchCoverArt={handleCancelFetchCoverArt}
            isFetchingCover={isFetchingCover}
            coverError={coverError}
            coverCandidates={coverCandidates}
            isCoverPickerOpen={isCoverPickerOpen}
            isApplyingCoverCandidate={isApplyingCoverCandidate}
            onCloseCoverPicker={() => setIsCoverPickerOpen(false)}
            onSelectCoverCandidate={(cand) => void handleSelectCoverCandidate(cand)}
            onCoverFileDrop={handleCoverFileDrop}
            onAppendQueryLog={appendQueryLog}
            onAudioFilesDrop={(files) => void ingestAudioFiles(files, false)}
            onImportAudioFiles={(files, opts) => void ingestAudioFiles(files, false, opts)}
            onLookupByToc={(customSyn) => void handleLookupByToc(customSyn, false)}
            onClearSearchResults={() => {
              setAwaitingAlbumSelection(false);
              setActiveRightDisplay('tracks');
            }}
            onRetryWithBackoff={() => void handleRetryWithBackoff()}
            onReinitializeQuery={() => void handleReinitializeQuery()}
            isRetryingBackoff={isRetryingBackoff}
            retryAttempt={retryAttempt}
            retryMaxAttempts={retryMaxAttempts}
            onShazamAllTracks={() => void handleShazamAllTracks()}
            onCancelShazamAll={handleCancelShazamAll}
            isShazamingAll={isShazamingAll}
            onAnalyzeMbTracks={() => void handleAnalyzeMbTracks()}
            onCancelAnalyzeMbTracks={handleCancelAnalyzeMbTracks}
            isAnalyzingMbTracks={isAnalyzingMbTracks}
            onEnrichTrackGenres={() => void handleEnrichTrackGenres()}
            isEnrichingGenres={isEnrichingGenres}
            onVerifyField={(field) => void handleVerifyField(field)}
            onCancelVerifyField={handleCancelVerifyField}
            verifyingField={verifyingField}
            onEnqueueAlbum={(mode) => void handleEnqueueAlbum(mode)}
            onResetAllFields={handleResetAllFields}
            onOpenSettings={() =>
              navigateToModule('settings', '[Navigation] Einstellungsseite geöffnet.')
            }
            themeMode={themeMode}
            onThemeModeChange={handleThemeModeChangeWithLog}
            activeRightDisplay={activeRightDisplay}
            onToggleRightDisplay={(display) => {
              if (isBatchActivelyRunning) return;
              setActiveRightDisplay((prev) => (prev === display ? null : display));
            }}
            jobs={jobs}
            isBatchRunning={isBatchRunning}
            isBatchPaused={isBatchPaused}
            isBatchActivelyRunning={isBatchActivelyRunning}
            onBatchStartAll={handleBatchStartAll}
            onBatchTogglePause={handleBatchTogglePause}
            onBatchCancelAll={handleBatchCancelAll}
            onBatchClearFinished={handleBatchClearFinished}
            onBatchRetryJob={handleBatchRetryJob}
            onBatchRemoveJob={handleBatchRemoveJob}
            onBatchDropFiles={(files) => void ingestAudioFiles(files, true)}
          />
        )}

        {activeTab === 'module_convert' && (
          <ConverterWorkbench
            key={activeTab}
            settings={settings}
            onSettingsChange={handleSettingsChangeWithLog}
            onAppendQueryLog={appendQueryLog}
            actionRef={converterActionsRef}
            onToolbarStateChange={setConverterToolbarState}
          />
        )}

        {activeTab === 'module_repair' && (
          <RepairWorkbench
            key={activeTab}
            settings={settings}
            onSettingsChange={handleSettingsChangeWithLog}
            onAppendQueryLog={appendQueryLog}
            actionRef={repairActionsRef}
            onToolbarStateChange={setRepairToolbarState}
          />
        )}

        {activeTab === 'module_cut' &&
          (() => {
            const spec = MODULE_SPECS.find((m) => m.id === activeTab);
            if (!spec) return null;
            return (
              <ReservedModulePage
                spec={spec}
                targetFolder={settings.outputDirCut || DEFAULT_MODULE_OUTPUT_DIRS.outputDirCut}
                onBackToHome={() =>
                  navigateToModule('home', '[Navigation] Zurückgekehrt zur Startseite (Modulauswahl).')
                }
                onSelectModule={(modId) => {
                  const target = MODULE_SPECS.find((m) => m.id === modId);
                  navigateToModule(
                    modId,
                    `[Navigation] Modul geöffnet: „${target ? `${target.numberLabel} · ${target.title}` : modId}“.`
                  );
                }}
              />
            );
          })()}

        {activeTab === 'batch' && isBatchAvailable && (
          <div className="space-y-4">
            <ModulePageHeaderBar
              moduleNumber="Warteschlange"
              title="Stapelverarbeitung"
              subtitle="Serielles Auslesen & parallele Kodierung bzw. direktes Tag-Schreiben"
              icon="batch_queue"
              onBackToHome={() =>
                navigateToModule('home', '[Navigation] Zurückgekehrt zur Startseite (Modulauswahl).')
              }
              disabled={isBatchActivelyRunning}
            />
            <BatchQueueView
              jobs={jobs}
              isRunning={isBatchRunning}
              isPaused={isBatchPaused}
              isLockedDuringRun={isBatchActivelyRunning}
              onStartAll={handleBatchStartAll}
              onTogglePause={handleBatchTogglePause}
              onCancelAll={handleBatchCancelAll}
              onClearFinished={handleBatchClearFinished}
              onRetryJob={handleBatchRetryJob}
              onRemoveJob={handleBatchRemoveJob}
              onDropFilesToBatch={(files) => void ingestAudioFiles(files, true)}
            />
          </div>
        )}

        {activeTab === 'icons' && (
          <div className="space-y-4">
            <ModulePageHeaderBar
              moduleNumber="System"
              title="Systemicons (GTK3 / XDG)"
              subtitle="Übersicht der verwendeten Freedesktop- und Linux-Mint-Systemsymbole"
              icon="settings"
              onBackToHome={() =>
                navigateToModule('home', '[Navigation] Zurückgekehrt zur Startseite (Modulauswahl).')
              }
            />
            <SystemIconsView />
          </div>
        )}

        {activeTab === 'source' && (
          <div className="space-y-4">
            <ModulePageHeaderBar
              moduleNumber="Linux Mint App"
              title="Python-Quellcode (GTK 3.0)"
              subtitle="Vollständiger Quellcode des nativen Linux-Mint-Pakets inkl. Debian-13-Installationsanleitung"
              icon="save_export"
              onBackToHome={() =>
                navigateToModule('home', '[Navigation] Zurückgekehrt zur Startseite (Modulauswahl).')
              }
            />
            <SourceCodeView
              files={pythonFiles}
              isLoading={isLoadingFiles}
              error={filesError}
            />
          </div>
        )}
        {activeTab === 'settings' && (
          <SettingsPage
            settings={settings}
            onSettingsChange={handleSettingsChangeWithLog}
            themeMode={themeMode}
            onThemeModeChange={handleThemeModeChangeWithLog}
            onBackToHome={() =>
              navigateToModule('home', '[Navigation] Zurückgekehrt zur Startseite (Modulauswahl).')
            }
          />
        )}
      </main>

      {/* Unterer Fensterrand: angedocktes Aktions-Protokoll */}
      <div className="sticky bottom-0 z-30 w-full flex flex-col">
      {settings.showQueryLog && !isQueryLogDetached && (
        <section
          aria-label="Aktions- und Abfrage-Protokoll"
          className="w-full bg-white dark:bg-[#22262B] border-t-2 border-[#D0D7DE] dark:border-[#343A40] shadow-[0_-4px_16px_rgba(0,0,0,0.08)] flex flex-col select-none"
        >
          {/* Skalierbarer Griff (Splitter) am oberen Rand der Protokoll-Spalte */}
          <div
            onMouseDown={(e) => {
              handleStartQueryLogResize(e);
            }}
            title="Ziehen, um die Höhe des Protokolls zu skalieren"
            className="h-2 w-full bg-[#EAEEF2] dark:bg-[#2D3239] flex items-center justify-center transition-colors cursor-ns-resize hover:bg-[#5BA632]/40 dark:hover:bg-[#69B53F]/40"
          >
            <div className="w-12 h-0.5 rounded-full bg-[#8C959F] dark:bg-[#6E7681]" />
          </div>

          <div className="max-w-[1440px] w-full mx-auto px-6 py-1.5 flex items-center justify-between gap-4 border-b border-[#E1E4E8] dark:border-[#343A40] bg-[#F6F8FA] dark:bg-[#1C1F23]">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xs font-bold text-[#1F2328] dark:text-[#EAEEF2] truncate">
                Aktions- &amp; Abfrage-Protokoll (Alle Aktionen · MusicBrainz → Discogs → CDDB &amp; Cover-Quellen)
              </span>
              <span className="text-[11px] font-mono text-[#57606A] dark:text-[#8B949E] shrink-0">
                ({queryLogs.length} Einträge · Höhe {QUERY_LOG_HEIGHT_PX[queryLogHeightIdx]}px)
              </span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span
                className={`text-[10px] font-mono px-1.5 py-0 rounded border ${
                  settings.discogsToken?.trim()
                    ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/30'
                    : 'bg-[#EAEEF2] dark:bg-[#25292E] text-[#57606A] dark:text-[#8B949E] border-[#D0D7DE] dark:border-[#3D444D]'
                }`}
              >
                {settings.discogsToken?.trim() ? 'Discogs-Token: aktiv' : 'Discogs-Token: Standard'}
              </span>

              <div className="flex items-center rounded border border-[#D0D7DE] dark:border-[#3D444D] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setQueryLogHeightIdx((idx) => Math.max(0, idx - 1))}
                  disabled={queryLogHeightIdx === 0}
                  title="Protokoll-Spalte flacher machen"
                  className="px-1.5 py-0 text-[11px] font-mono bg-white dark:bg-[#25292E] hover:bg-[#EAEEF2] dark:hover:bg-[#30363D] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setQueryLogHeightIdx((idx) => Math.min(QUERY_LOG_HEIGHT_CLASSES.length - 1, idx + 1))
                  }
                  disabled={queryLogHeightIdx === QUERY_LOG_HEIGHT_CLASSES.length - 1}
                  title="Protokoll-Spalte höher machen"
                  className="px-1.5 py-0 text-[11px] font-mono bg-white dark:bg-[#25292E] hover:bg-[#EAEEF2] dark:hover:bg-[#30363D] border-l border-[#D0D7DE] dark:border-[#3D444D] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  +
                </button>
              </div>

              {queryLogs.length > 0 && (
                <button
                  type="button"
                  disabled={isBatchActivelyRunning}
                  onClick={() => setQueryLogs([])}
                  className="px-2 py-0 text-[11px] font-medium rounded border border-[#D0D7DE] dark:border-[#3D444D] bg-white dark:bg-[#25292E] hover:bg-[#EAEEF2] dark:hover:bg-[#30363D] text-[#57606A] dark:text-[#8B949E] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Protokoll leeren
                </button>
              )}

              <button
                type="button"
                onClick={() => handleToggleQueryLogDetached(true)}
                className="px-2 py-0 text-[11px] font-semibold rounded border border-[#5BA632]/50 bg-[#5BA632]/10 hover:bg-[#5BA632]/20 text-[#2E6B14] dark:text-[#9BE270] cursor-pointer"
                title="Protokoll in ein eigenes bewegliches Fenster abdocken"
              >
                Abdocken
              </button>

              <button
                type="button"
                onClick={() => handleSettingsChangeWithLog((prev) => ({ ...prev, showQueryLog: false }))}
                className="px-2 py-0 text-[11px] font-medium rounded border border-[#D0D7DE] dark:border-[#3D444D] bg-white dark:bg-[#25292E] hover:bg-[#EAEEF2] dark:hover:bg-[#30363D] text-[#1F2328] dark:text-[#EAEEF2] cursor-pointer"
                title="Protokoll-Spalte ausblenden (kann in den Einstellungen jederzeit wieder aktiviert werden)"
              >
                Ausblenden
              </button>
            </div>
          </div>

          <div
            ref={logScrollRef}
            className={`max-w-[1440px] w-full mx-auto px-6 py-2 overflow-y-auto font-mono text-[11px] leading-relaxed space-y-1 select-text ${QUERY_LOG_HEIGHT_CLASSES[queryLogHeightIdx]}`}
          >
            {queryLogs.length === 0 ? (
              <div className="text-[#57606A] dark:text-[#8B949E] italic">
                Protokoll ist leer. Jede Aktion in der Anwendung wird hier fortlaufend protokolliert.
              </div>
            ) : (
              queryLogs.map((line, i) => {
                const isShazam = /shazam/i.test(line);
                const isDiscogs = /discogs/i.test(line);
                const isAmazon = /amazon|asin/i.test(line);
                const isBatch = /\[stapelverarbeitung\]/i.test(line);
                const isSettings = /\[einstellungen\]|\[profil\]|\[ansicht\]/i.test(line);
                const isErr = /fehler|nicht erreichbar|kein cover|abgebrochen/i.test(line);
                return (
                  <div
                    key={i}
                    className={
                      isErr
                        ? 'text-red-600 dark:text-red-400'
                        : isShazam
                          ? 'text-sky-700 dark:text-sky-300 font-semibold'
                          : isDiscogs
                            ? 'text-amber-700 dark:text-amber-300 font-semibold'
                            : isAmazon
                              ? 'text-orange-700 dark:text-orange-300 font-semibold'
                              : isBatch
                                ? 'text-[#2E6B14] dark:text-[#9BE270]'
                                : isSettings
                                  ? 'text-[#0969DA] dark:text-[#58A6FF]'
                                  : 'text-[#24292F] dark:text-[#C9D1D9]'
                    }
                  >
                    {line}
                  </div>
                );
              })
            )}
          </div>
        </section>
      )}
      </div>

      {/* Abgedocktes eigenes Protokoll-Fenster (beweglich, skalierbar, mit Andock-Button für alte Stelle) */}
      {settings.showQueryLog && isQueryLogDetached && (
        <div
          role="dialog"
          aria-label="Aktions- und Abfrage-Protokoll (Eigenes Fenster)"
          style={{
            left: `${detachedLogBounds.x}px`,
            top: `${detachedLogBounds.y}px`,
            width: `${detachedLogBounds.width}px`,
            height: `${detachedLogBounds.height}px`,
          }}
          className="fixed z-40 rounded-lg border-2 border-[#5BA632]/70 dark:border-[#69B53F]/70 bg-white dark:bg-[#22262B] shadow-2xl flex flex-col overflow-hidden"
        >
          <div
            onMouseDown={handleStartDetachedLogDrag}
            title="Fenster verschieben"
            className="px-3.5 py-2 border-b border-[#E1E4E8] dark:border-[#343A40] bg-[#F6F8FA] dark:bg-[#1C1F23] flex items-center justify-between gap-3 cursor-move select-none shrink-0"
          >
            <div className="flex items-center gap-2 min-w-0">
              <SystemIcon name="batch_queue" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0" />
              <span className="text-xs font-bold text-[#1F2328] dark:text-[#EAEEF2] truncate">
                Aktions- &amp; Abfrage-Protokoll (Eigenes Fenster)
              </span>
              <span className="text-[11px] font-mono text-[#57606A] dark:text-[#8B949E] shrink-0">
                ({queryLogs.length})
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {queryLogs.length > 0 && (
                <button
                  type="button"
                  disabled={isBatchActivelyRunning}
                  onClick={() => setQueryLogs([])}
                  className="px-2 py-0.5 text-[11px] font-medium rounded border border-[#D0D7DE] dark:border-[#3D444D] bg-white dark:bg-[#25292E] hover:bg-[#EAEEF2] dark:hover:bg-[#30363D] text-[#57606A] dark:text-[#8B949E] cursor-pointer disabled:opacity-40"
                >
                  Protokoll leeren
                </button>
              )}

              <button
                type="button"
                onClick={() => handleToggleQueryLogDetached(false)}
                title="Protokollfenster wieder an der alten Stelle am unteren Fensterrand andocken"
                className="inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white cursor-pointer"
              >
                <span>An alter Stelle andocken</span>
              </button>

              <button
                type="button"
                onClick={() => handleSettingsChangeWithLog((prev) => ({ ...prev, showQueryLog: false }))}
                title="Protokoll ausblenden"
                className="px-2 py-0.5 text-[11px] font-medium rounded border border-[#D0D7DE] dark:border-[#3D444D] bg-white dark:bg-[#25292E] hover:bg-[#EAEEF2] dark:hover:bg-[#30363D] text-[#1F2328] dark:text-[#EAEEF2] cursor-pointer"
              >
                Ausblenden
              </button>
            </div>
          </div>

          <div
            ref={logScrollRef}
            className="flex-1 px-4 py-2.5 overflow-y-auto font-mono text-[11px] leading-relaxed space-y-1 select-text"
          >
            {queryLogs.length === 0 ? (
              <div className="text-[#57606A] dark:text-[#8B949E] italic">
                Protokoll ist leer. Jede Aktion in der Anwendung wird hier fortlaufend protokolliert.
              </div>
            ) : (
              queryLogs.map((line, i) => {
                const isShazam = /shazam/i.test(line);
                const isDiscogs = /discogs/i.test(line);
                const isAmazon = /amazon|asin/i.test(line);
                const isBatch = /\[stapelverarbeitung\]/i.test(line);
                const isSettings = /\[einstellungen\]|\[profil\]|\[ansicht\]/i.test(line);
                const isErr = /fehler|nicht erreichbar|kein cover|abgebrochen/i.test(line);
                return (
                  <div
                    key={i}
                    className={
                      isErr
                        ? 'text-red-600 dark:text-red-400'
                        : isShazam
                          ? 'text-sky-700 dark:text-sky-300 font-semibold'
                          : isDiscogs
                            ? 'text-amber-700 dark:text-amber-300 font-semibold'
                            : isAmazon
                              ? 'text-orange-700 dark:text-orange-300 font-semibold'
                              : isBatch
                                ? 'text-[#2E6B14] dark:text-[#9BE270]'
                                : isSettings
                                  ? 'text-[#0969DA] dark:text-[#58A6FF]'
                                  : 'text-[#24292F] dark:text-[#C9D1D9]'
                    }
                  >
                    {line}
                  </div>
                );
              })
            )}
          </div>

          <div
            onMouseDown={handleStartDetachedLogResize}
            title="Größe des Protokollfensters anpassen"
            className="h-3.5 px-3 border-t border-[#E1E4E8] dark:border-[#343A40] bg-[#F6F8FA] dark:bg-[#1C1F23] flex items-center justify-between text-[10px] text-[#57606A] dark:text-[#8B949E] select-none shrink-0"
          >
            <span>Titelleiste ziehen zum Verschieben</span>
            <span className="cursor-nwse-resize font-mono px-1 hover:text-[#1F2328] dark:hover:text-[#EAEEF2]">
              ◢ Größe ändern
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
