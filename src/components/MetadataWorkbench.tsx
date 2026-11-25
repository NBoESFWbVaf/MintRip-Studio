import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  ZoomIn,
} from 'lucide-react';
import {
  BarcodeFormat,
  BrowserMultiFormatReader,
  DecodeHintType,
} from '@zxing/library';
import {
  AlbumMetadata,
  BatchJob,
  COVER_PROVIDER_OPTIONS,
  CoverSearchCandidate,
  DEFAULT_MODULE_OUTPUT_DIRS,
  DEFAULT_VISIBLE_LEFT_TAG_FIELDS,
  ExportSettings,
  MUSICBRAINZ_LEFT_TAG_FIELDS,
  MusicBrainzSearchResult,
  normalizeCoverProviders,
  TrackMetadata,
} from '../types/mintrip';
import {
  buildCueSheetContent,
  buildMintRipShellScript,
  convertRomanNumeralsInTitle,
  estimateAlbumStorage,
  formatCoverByteSize,
  formatCoverFilename,
  formatDuration,
  formatIndexNumber,
  formatMegabytes,
  formatOutputStem,
  normalizeMultiArtist,
  renumberTracksPerDisc,
  splitArtistsAndExtractFromTitle,
  SynthesizedTocResult,
  synthesizeTocFromTracks,
  toGermanTitleCase,
  triggerTextDownload,
} from '../utils/audioExportHelpers';
import { pickDirectoryWithPersistence } from '../utils/folderImportHelper';
import { BatchQueueView } from './BatchQueueView';
import { FilenameToTagsModal } from './FilenameToTagsModal';
import { ModulePageHeaderBar } from './ModulePages';
import { SystemIcon } from './SystemIcons';

interface MetadataWorkbenchProps {
  album: AlbumMetadata;
  onAlbumChange: React.Dispatch<React.SetStateAction<AlbumMetadata>>;
  settings: ExportSettings;
  onSettingsChange: React.Dispatch<React.SetStateAction<ExportSettings>>;
  devicePath: string;
  onDevicePathChange: (device: string) => void;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  searchResults: MusicBrainzSearchResult[];
  isSearching: boolean;
  isLoadingRelease: boolean;
  searchError: string | null;
  onSearchMusicBrainz: (query: string, autoSelectFirst?: boolean) => void;
  onSelectRelease: (
    releaseId: string,
    discNumber?: number,
    source?: 'musicbrainz' | 'discogs' | 'cddb'
  ) => void;
  onFetchCoverArt: (customQuery?: string) => void;
  onCancelFetchCoverArt?: () => void;
  isFetchingCover: boolean;
  coverError: string | null;
  coverCandidates: CoverSearchCandidate[];
  isCoverPickerOpen: boolean;
  isApplyingCoverCandidate: boolean;
  onCloseCoverPicker: () => void;
  onSelectCoverCandidate: (candidate: CoverSearchCandidate) => void;
  onCoverFileDrop: (file: File, customSourceLabel?: string) => void;
  onAppendQueryLog: (message: string) => void;
  onAudioFilesDrop: (files: FileList | File[]) => void;
  onImportAudioFiles: (
    files: FileList | File[],
    options?: { replaceExisting?: boolean; autoLookupToc?: boolean; resetBeforeImport?: boolean }
  ) => void;
  onLookupByToc: (customSynthesized?: SynthesizedTocResult) => void;
  onClearSearchResults?: () => void;
  onRetryWithBackoff: () => void;
  onReinitializeQuery: () => void;
  isRetryingBackoff: boolean;
  retryAttempt: number;
  retryMaxAttempts: number;
  onShazamAllTracks: () => void;
  onCancelShazamAll: () => void;
  isShazamingAll: boolean;
  onAnalyzeMbTracks?: () => void;
  onCancelAnalyzeMbTracks?: () => void;
  isAnalyzingMbTracks?: boolean;
  onEnrichTrackGenres?: () => void;
  isEnrichingGenres?: boolean;
  onVerifyField: (field: 'artist' | 'composer' | 'orchestra' | 'conductor') => void;
  onCancelVerifyField: () => void;
  verifyingField: 'artist' | 'composer' | 'orchestra' | 'conductor' | null;
  onEnqueueAlbum: (mode?: 'tag_only' | 'convert_flac') => void;
  onOpenSettings: () => void;
  onResetAllFields: () => void;
  themeMode: 'system' | 'light' | 'dark';
  onThemeModeChange: (mode: 'system' | 'light' | 'dark') => void;
  activeRightDisplay: 'hits' | 'tracks' | 'batch' | null;
  onToggleRightDisplay: (display: 'hits' | 'tracks' | 'batch') => void;
  jobs: BatchJob[];
  isBatchRunning: boolean;
  isBatchPaused: boolean;
  isBatchActivelyRunning: boolean;
  onBatchStartAll: () => void;
  onBatchTogglePause: () => void;
  onBatchCancelAll: () => void;
  onBatchClearFinished: () => void;
  onBatchRetryJob: (jobId: string) => void;
  onBatchRemoveJob: (jobId: string) => void;
  onBatchDropFiles: (files: FileList | File[]) => void;
  moduleMode?: 'cover_only' | 'cd_rip' | 'album_tag';
  onBackToHome?: () => void;
  onOpenCoverPicker?: () => void;
  isFilenameToTagsOpen?: boolean;
  onCloseFilenameToTags?: () => void;
  onDbPreviewProgress?: (state: 'start' | 'done' | 'dismiss', label?: string) => void;
}

const SAMPLE_BARCODE_PRESETS = [
  {
    code: '5099969944926',
    typeLabel: 'EAN-13',
    albumLabel: 'Kraftwerk – Computerwelt',
  },
  {
    code: '0724384960629',
    typeLabel: 'EAN-13',
    albumLabel: 'Daft Punk – Discovery',
  },
  {
    code: '5099902987621',
    typeLabel: 'EAN-13',
    albumLabel: 'Pink Floyd – Wish You Were Here',
  },
  {
    code: 'https://musicbrainz.org/release/75678f27-51e0-4802-a367-e7a1f86fc7d3',
    typeLabel: 'QR-URL',
    albumLabel: 'MusicBrainz Release-QR (Computerwelt)',
  },
] as const;

export function MetadataWorkbench({
  album,
  onAlbumChange,
  settings,
  onSettingsChange,
  devicePath,
  onDevicePathChange,
  searchQuery,
  onSearchQueryChange,
  searchResults,
  isSearching,
  isLoadingRelease,
  searchError,
  onSearchMusicBrainz,
  onSelectRelease,
  onFetchCoverArt,
  onCancelFetchCoverArt,
  isFetchingCover,
  coverError,
  coverCandidates,
  isCoverPickerOpen,
  isApplyingCoverCandidate,
  onCloseCoverPicker,
  onSelectCoverCandidate,
  onCoverFileDrop,
  onAppendQueryLog,
  onAudioFilesDrop,
  onImportAudioFiles,
  onLookupByToc,
  onClearSearchResults,
  onRetryWithBackoff,
  onReinitializeQuery,
  isRetryingBackoff,
  retryAttempt,
  retryMaxAttempts,
  onShazamAllTracks,
  onCancelShazamAll,
  isShazamingAll,
  onAnalyzeMbTracks,
  onCancelAnalyzeMbTracks,
  isAnalyzingMbTracks = false,
  onEnrichTrackGenres,
  isEnrichingGenres = false,
  onVerifyField,
  onCancelVerifyField,
  verifyingField,
  onEnqueueAlbum,
  onOpenSettings,
  onResetAllFields,
  themeMode,
  onThemeModeChange,
  activeRightDisplay,
  onToggleRightDisplay,
  jobs,
  isBatchRunning,
  isBatchPaused,
  isBatchActivelyRunning,
  onBatchStartAll,
  onBatchTogglePause,
  onBatchCancelAll,
  onBatchClearFinished,
  onBatchRetryJob,
  onBatchRemoveJob,
  onBatchDropFiles,
  moduleMode = 'cd_rip',
  onBackToHome,
  onOpenCoverPicker,
  isFilenameToTagsOpen = false,
  onCloseFilenameToTags,
  onDbPreviewProgress,
}: MetadataWorkbenchProps) {
  const [isCoverDragOver, setIsCoverDragOver] = useState(false);
  const [isHitsDropActive, setIsHitsDropActive] = useState(false);
  const [isTrackDropActive, setIsTrackDropActive] = useState(false);
  const [draggedTrackIdx, setDraggedTrackIdx] = useState<number | null>(null);
  const [dragTargetIdx, setDragTargetIdx] = useState<number | null>(null);
  const [coverImgFailed, setCoverImgFailed] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [loadedCoverDims, setLoadedCoverDims] = useState<Record<string, { w: number; h: number }>>({});
  const [importReplaceExisting, setImportReplaceExisting] = useState<boolean>(true);
  const [importAutoLookupToc, setImportAutoLookupToc] = useState<boolean>(true);
  const [hitSourceFilter, setHitSourceFilter] = useState<'all' | 'musicbrainz' | 'discogs' | 'cddb'>('all');
  const [selectedCandidateIdx, setSelectedCandidateIdx] = useState<number>(0);
  const [isLeftColumnCollapsed, setIsLeftColumnCollapsed] = useState<boolean>(false);
  const [isTrackColumnCollapsed, setIsTrackColumnCollapsed] = useState<boolean>(false);
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [leftColWidth, setLeftColWidth] = useState<number>(400);
  const [rightColWidth, setRightColWidth] = useState<number>(400);
  const [activeSplitter, setActiveSplitter] = useState<'left' | 'right' | null>(null);
  const [pinnedTrackTagKeys, setPinnedTrackTagKeys] = useState<string[]>([]);
  const [isTrackIdsOpen, setIsTrackIdsOpen] = useState<boolean>(false);
  const [isTrackReplayGainOpen, setIsTrackReplayGainOpen] = useState<boolean>(false);
  const [isAnalyzeTracksMenuOpen, setIsAnalyzeTracksMenuOpen] = useState<boolean>(false);
  const analyzeTracksMenuRef = useRef<HTMLDivElement | null>(null);
  const [previewCoverFailed, setPreviewCoverFailed] = useState<boolean>(false);
  const [hitTrackPreview, setHitTrackPreview] = useState<{
    key: string;
    loading: boolean;
    error: string | null;
    title: string;
    artist: string;
    albumArtist: string;
    date: string;
    originalDate: string;
    country: string;
    status: string;
    barcode: string;
    asin: string;
    label: string;
    catalogNumber: string;
    genre: string;
    releaseType: string;
    mediaFormat: string;
    disambiguation: string;
    language: string;
    sourceId: string;
    coverUrl: string;
    totalDiscs: number;
    tracks: Array<{
      discNumber: number;
      discSubtitle: string;
      trackNumber: number;
      title: string;
      artist: string;
      durationSeconds: number;
    }>;
  } | null>(null);
  const hitTrackPreviewCacheRef = useRef<
    Map<
      string,
      {
        title: string;
        artist: string;
        albumArtist: string;
        date: string;
        originalDate: string;
        country: string;
        status: string;
        barcode: string;
        asin: string;
        label: string;
        catalogNumber: string;
        genre: string;
        releaseType: string;
        mediaFormat: string;
        disambiguation: string;
        language: string;
        sourceId: string;
        coverUrl: string;
        totalDiscs: number;
        tracks: Array<{
          discNumber: number;
          discSubtitle: string;
          trackNumber: number;
          title: string;
          artist: string;
          durationSeconds: number;
        }>;
      }
    >
  >(new Map());
  const workbenchSplitRef = useRef<HTMLDivElement | null>(null);
  const splitDragRef = useRef<{
    side: 'left' | 'right';
    startX: number;
    startWidth: number;
  } | null>(null);
  const prevIsClassicalRef = useRef<boolean>(Boolean(album.isClassical));

  const isLeftColCollapsedEffective = moduleMode !== 'cover_only' && isLeftColumnCollapsed;

  useEffect(() => {
    const isNowClassical = Boolean(album.isClassical);
    if (isNowClassical && !prevIsClassicalRef.current) {
      setIsTrackColumnCollapsed(false);
    }
    prevIsClassicalRef.current = isNowClassical;
  }, [album.isClassical]);

  useEffect(() => {
    const el = workbenchSplitRef.current;
    if (!el) return;
    el.style.setProperty('--wb-left-w', `${leftColWidth}px`);
    el.style.setProperty('--wb-right-w', `${rightColWidth}px`);
  }, [leftColWidth, rightColWidth, moduleMode]);

  useEffect(() => {
    if (!isAnalyzeTracksMenuOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        analyzeTracksMenuRef.current &&
        !analyzeTracksMenuRef.current.contains(e.target as Node)
      ) {
        setIsAnalyzeTracksMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsAnalyzeTracksMenuOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isAnalyzeTracksMenuOpen]);

  useEffect(() => {
    if (!activeSplitter) return;
    const handlePointerMove = (e: PointerEvent) => {
      const drag = splitDragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const containerW = workbenchSplitRef.current?.clientWidth ?? 1280;
      if (drag.side === 'left') {
        const reservedRight = isTrackColumnCollapsed ? 52 : rightColWidth + 12;
        const maxLeft = Math.min(620, Math.max(400, containerW - reservedRight - 280));
        const nextW = Math.round(Math.max(400, Math.min(maxLeft, drag.startWidth + dx)));
        setLeftColWidth(nextW);
      } else {
        const reservedLeft = isLeftColCollapsedEffective ? 52 : leftColWidth + 12;
        const maxRight = Math.min(620, Math.max(400, containerW - reservedLeft - 280));
        const nextW = Math.round(Math.max(400, Math.min(maxRight, drag.startWidth - dx)));
        setRightColWidth(nextW);
      }
    };
    const handlePointerUp = () => {
      splitDragRef.current = null;
      setActiveSplitter(null);
    };
    document.body.classList.add('select-none', 'cursor-col-resize');
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('blur', handlePointerUp);
    return () => {
      document.body.classList.remove('select-none', 'cursor-col-resize');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('blur', handlePointerUp);
    };
  }, [activeSplitter, isLeftColCollapsedEffective, isTrackColumnCollapsed, leftColWidth, rightColWidth]);

  const handleSetLeftColumnCollapsed = (collapsed: boolean) => {
    splitDragRef.current = null;
    setActiveSplitter(null);
    setIsLeftColumnCollapsed(collapsed);
  };

  const filteredHitResults =
    hitSourceFilter === 'all'
      ? searchResults
      : searchResults.filter((r) => (r.source || 'musicbrainz') === hitSourceFilter);
  const selectedHitCandidate =
    filteredHitResults[selectedCandidateIdx] || filteredHitResults[0] || null;
  const isAlbumPreviewMode =
    moduleMode !== 'cover_only' &&
    activeRightDisplay === 'hits' &&
    searchResults.length > 0;
  const selectedHitPreviewKey = selectedHitCandidate
    ? `${selectedHitCandidate.source || 'musicbrainz'}:${selectedHitCandidate.id}`
    : '';

  useEffect(() => {
    setPreviewCoverFailed(false);
  }, [selectedHitPreviewKey]);

  useEffect(() => {
    if (!isAlbumPreviewMode || !selectedHitCandidate || !selectedHitPreviewKey) {
      return;
    }
    const cached = hitTrackPreviewCacheRef.current.get(selectedHitPreviewKey);
    if (cached) {
      setHitTrackPreview({
        key: selectedHitPreviewKey,
        loading: false,
        error: null,
        ...cached,
      });
      return;
    }

    const controller = new AbortController();
    const baseFields = {
      title: selectedHitCandidate.title || '',
      artist: selectedHitCandidate.artist || '',
      albumArtist: selectedHitCandidate.artist || '',
      date: selectedHitCandidate.date || '',
      originalDate: '',
      country: selectedHitCandidate.country || '',
      status: '',
      barcode: selectedHitCandidate.barcode || '',
      asin: '',
      label: selectedHitCandidate.label || '',
      catalogNumber: selectedHitCandidate.catno || '',
      genre: '',
      releaseType: '',
      mediaFormat: '',
      disambiguation: '',
      language: '',
      sourceId: selectedHitCandidate.id || '',
      coverUrl: '',
      totalDiscs: selectedHitCandidate.mediumCount || 1,
    };
    setHitTrackPreview({
      key: selectedHitPreviewKey,
      loading: true,
      error: null,
      ...baseFields,
      tracks: [],
    });

    const params = new URLSearchParams({
      id: selectedHitCandidate.id,
      source: selectedHitCandidate.source || 'musicbrainz',
    });
    const headers: Record<string, string> = {};
    if (settings.discogsToken?.trim()) {
      headers['x-discogs-token'] = settings.discogsToken.trim();
    }
    const previewLabel = [selectedHitCandidate.artist, selectedHitCandidate.title]
      .filter((s) => Boolean(s && s.trim()))
      .join(' – ');
    onDbPreviewProgress?.(
      'start',
      previewLabel
        ? `Album-Vorschau wird geladen… (${previewLabel})`
        : 'Album-Vorschau wird geladen…'
    );

    fetch(`/api/metadata/preview-tracks?${params.toString()}`, {
      headers,
      signal: controller.signal,
    })
      .then(async (resp) => {
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(data?.error || `HTTP ${resp.status}`);
        }
        const normalized = {
          title: String(data.title || baseFields.title),
          artist: String(data.artist || baseFields.artist),
          albumArtist: String(data.albumArtist || data.artist || baseFields.albumArtist),
          date: String(data.date || baseFields.date),
          originalDate: String(data.originalDate || ''),
          country: String(data.country || baseFields.country),
          status: String(data.status || ''),
          barcode: String(data.barcode || baseFields.barcode),
          asin: String(data.asin || ''),
          label: String(data.label || baseFields.label),
          catalogNumber: String(data.catalogNumber || baseFields.catalogNumber),
          genre: String(data.genre || ''),
          releaseType: String(data.releaseType || ''),
          mediaFormat: String(data.mediaFormat || baseFields.mediaFormat),
          disambiguation: String(data.disambiguation || ''),
          language: String(data.language || ''),
          sourceId: String(data.sourceId || baseFields.sourceId),
          coverUrl: String(data.coverUrl || baseFields.coverUrl),
          totalDiscs: Math.max(1, Number(data.totalDiscs || baseFields.totalDiscs || 1)),
          tracks: Array.isArray(data.tracks) ? data.tracks : [],
        };
        hitTrackPreviewCacheRef.current.set(selectedHitPreviewKey, normalized);
        setHitTrackPreview({
          key: selectedHitPreviewKey,
          loading: false,
          error: null,
          ...normalized,
        });
        onDbPreviewProgress?.(
          'done',
          previewLabel
            ? `Album-Vorschau geladen: ${previewLabel}`
            : 'Album-Vorschau geladen'
        );
      })
      .catch((err: any) => {
        if (controller.signal.aborted) return;
        setHitTrackPreview({
          key: selectedHitPreviewKey,
          loading: false,
          error: err?.message || 'Trackliste konnte nicht geladen werden.',
          ...baseFields,
          tracks: [],
        });
        onDbPreviewProgress?.('done', 'Album-Vorschau nicht verfügbar');
      });

    return () => {
      controller.abort();
      onDbPreviewProgress?.('dismiss');
    };
  }, [isAlbumPreviewMode, selectedHitPreviewKey, settings.discogsToken, onDbPreviewProgress]);

  useEffect(() => {
    setCoverImgFailed(false);
  }, [album.coverArtUrl]);

  useEffect(() => {
    setLightboxIndex(null);
    setLoadedCoverDims({});
  }, [coverCandidates, isCoverPickerOpen]);

  useEffect(() => {
    if (!isCoverPickerOpen && lightboxIndex === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (lightboxIndex !== null) {
          setLightboxIndex(null);
        } else if (isCoverPickerOpen) {
          onCloseCoverPicker();
        }
      } else if (lightboxIndex !== null && coverCandidates.length > 1) {
        if (e.key === 'ArrowLeft') {
          setLightboxIndex((prev) =>
            prev === null ? null : (prev - 1 + coverCandidates.length) % coverCandidates.length
          );
        } else if (e.key === 'ArrowRight') {
          setLightboxIndex((prev) =>
            prev === null ? null : (prev + 1) % coverCandidates.length
          );
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isCoverPickerOpen, lightboxIndex, coverCandidates.length, onCloseCoverPicker]);

  useEffect(() => {
    setHitSourceFilter('all');
    setSelectedCandidateIdx(0);
  }, [searchResults]);

  const [convertImportedToFlac, setConvertImportedToFlac] = useState(false);
  useEffect(() => {
    setConvertImportedToFlac(false);
  }, [moduleMode]);

  // Scanner-Dialog & Direktscan State (Cover-Art)
  const [isScannerModalOpen, setIsScannerModalOpen] = useState(false);
  const [scanDpi, setScanDpi] = useState<150 | 300 | 600>(300);
  const [isScanningHardware, setIsScanningHardware] = useState(false);
  const [scannerStatus, setScannerStatus] = useState<string | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const scanAbortRef = useRef<AbortController | null>(null);

  // Cover-Beschneidungs-Modal State (Schere-Werkzeug)
  const [isCropModalOpen, setIsCropModalOpen] = useState(false);
  const [cropImgNatural, setCropImgNatural] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number }>({
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  });
  const [cropLockSquare, setCropLockSquare] = useState(false);
  const cropImgRef = useRef<HTMLImageElement>(null);

  // Cover-Skalierungs-Modal State (Skalieren-Werkzeug unterhalb der Schere)
  const [isScaleModalOpen, setIsScaleModalOpen] = useState(false);
  const [scaleImgNatural, setScaleImgNatural] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [scaleMode, setScaleMode] = useState<'square' | 'custom'>('square');
  const [scaleWidth, setScaleWidth] = useState<number>(1000);
  const [scaleHeight, setScaleHeight] = useState<number>(1000);
  const [scaleKeepAspect, setScaleKeepAspect] = useState<boolean>(true);
  const scaleImgRef = useRef<HTMLImageElement>(null);

  // "Speichern unter"-Dialog State (Diskette-Werkzeug)
  const [isSaveCoverModalOpen, setIsSaveCoverModalOpen] = useState(false);
  const [saveCoverFilename, setSaveCoverFilename] = useState('cover.jpg');
  const [saveCoverFormat, setSaveCoverFormat] = useState<'jpg' | 'png' | 'webp'>('jpg');
  const [saveCoverQuality, setSaveCoverQuality] = useState<number>(95);
  const [saveCoverFolder, setSaveCoverFolder] = useState<string>('~/Musik');
  const [isSavingCoverFile, setIsSavingCoverFile] = useState(false);
  const cropDragRef = useRef<{
    mode: 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
    startClientX: number;
    startClientY: number;
    startRect: { x: number; y: number; w: number; h: number };
    scaleX: number;
    scaleY: number;
    natW: number;
    natH: number;
    lockSquare: boolean;
  } | null>(null);

  useEffect(() => {
    if (!isCropModalOpen) return;
    const handlePointerMove = (ev: PointerEvent) => {
      const drag = cropDragRef.current;
      if (!drag) return;
      ev.preventDefault();
      const dx = (ev.clientX - drag.startClientX) * drag.scaleX;
      const dy = (ev.clientY - drag.startClientY) * drag.scaleY;
      const { startRect: s, natW, natH, mode, lockSquare } = drag;
      const minSize = Math.min(24, natW, natH);

      if (mode === 'move') {
        const nx = Math.max(0, Math.min(natW - s.w, Math.round(s.x + dx)));
        const ny = Math.max(0, Math.min(natH - s.h, Math.round(s.y + dy)));
        setCropRect({ x: nx, y: ny, w: s.w, h: s.h });
        return;
      }

      let left = s.x;
      let top = s.y;
      let right = s.x + s.w;
      let bottom = s.y + s.h;

      if (mode.includes('w')) {
        left = Math.max(0, Math.min(right - minSize, Math.round(s.x + dx)));
      }
      if (mode.includes('e')) {
        right = Math.min(natW, Math.max(left + minSize, Math.round(s.x + s.w + dx)));
      }
      if (mode.includes('n')) {
        top = Math.max(0, Math.min(bottom - minSize, Math.round(s.y + dy)));
      }
      if (mode.includes('s')) {
        bottom = Math.min(natH, Math.max(top + minSize, Math.round(s.y + s.h + dy)));
      }

      let newW = Math.max(minSize, right - left);
      let newH = Math.max(minSize, bottom - top);

      if (lockSquare) {
        const maxAllowedSide = Math.min(
          mode.includes('w') ? right : natW - left,
          mode.includes('n') ? bottom : natH - top
        );
        const targetSide = Math.max(
          minSize,
          Math.min(maxAllowedSide, mode === 'n' || mode === 's' ? newH : mode === 'e' || mode === 'w' ? newW : Math.round((newW + newH) / 2))
        );
        newW = targetSide;
        newH = targetSide;
        if (mode.includes('w')) left = right - newW;
        if (mode.includes('n')) top = bottom - newH;
      }

      setCropRect({
        x: Math.max(0, Math.min(natW - newW, left)),
        y: Math.max(0, Math.min(natH - newH, top)),
        w: newW,
        h: newH,
      });
    };

    const handlePointerUp = () => {
      cropDragRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isCropModalOpen]);

  // Webcam Barcode / QR-Code Scanner State
  const [isBarcodeModalOpen, setIsBarcodeModalOpen] = useState(false);
  const [isBarcodeCamActive, setIsBarcodeCamActive] = useState(false);
  const [barcodeScannerStatus, setBarcodeScannerStatus] = useState<string | null>(null);
  const [manualBarcodeInput, setManualBarcodeInput] = useState<string>('');
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState<string>('');
  const [lastDetectedFormat, setLastDetectedFormat] = useState<string | null>(null);

  const coverInputRef = useRef<HTMLInputElement>(null);
  const scannerFileInputRef = useRef<HTMLInputElement>(null);
  const barcodeFileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const barcodeVideoRef = useRef<HTMLVideoElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const barcodeStreamRef = useRef<MediaStream | null>(null);
  const zxingReaderRef = useRef<BrowserMultiFormatReader | null>(null);
  const barcodeScanTimerRef = useRef<number | null>(null);
  const barcodeHandledRef = useRef<boolean>(false);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const importTocAudioInputRef = useRef<HTMLInputElement>(null);
  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);
  const cdSynthStopRef = useRef<(() => void) | null>(null);
  const playSessionRef = useRef<number>(0);
  const previewObjectUrlRef = useRef<string | null>(null);
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [isTrayOpen, setIsTrayOpen] = useState<boolean>(false);
  const [isTogglingTray, setIsTogglingTray] = useState<boolean>(false);

  const selectedTracks = album.tracks.filter((t) => t.selected);
  const selectedCount = selectedTracks.length;
  const selectedDiscNumbers = Array.from(
    new Set(selectedTracks.map((t) => Math.max(1, t.discNumber || album.discNumber || 1)))
  ).sort((a, b) => a - b);
  const hasDiscConflict = selectedDiscNumbers.length > 1;
  const trackDistinctDiscs = Array.from(
    new Set(album.tracks.map((t) => Math.max(1, t.discNumber || 1)))
  ).sort((a, b) => a - b);
  const isMultiDiscAlbum = album.totalDiscs > 1 || trackDistinctDiscs.length > 1;
  const allSelected = album.tracks.length > 0 && selectedCount === album.tracks.length;
  const someSelected = selectedCount > 0 && selectedCount < album.tracks.length;
  const totalSeconds = album.tracks.reduce((sum, t) => sum + t.durationSeconds, 0);
  const storageStats = estimateAlbumStorage(album, settings);
  const activeTrackIdx = (() => {
    if (album.tracks.length === 0) return -1;
    if (activeTrackId) {
      const idx = album.tracks.findIndex((t) => t.id === activeTrackId);
      if (idx >= 0) return idx;
    }
    return 0;
  })();
  const activeTrack = activeTrackIdx >= 0 ? album.tracks[activeTrackIdx] : null;
  const activeTrackKey = activeTrack?.id ?? null;

  useEffect(() => {
    setPinnedTrackTagKeys([]);
  }, [activeTrackKey]);

  const pinTrackTagKey = (key: string) => {
    setPinnedTrackTagKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };

  const updateTrackExtraTag = (trackId: string, tagKey: string, rawValue: string) => {
    const parts = rawValue
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    onAlbumChange((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const nextExtra: Record<string, string[]> = { ...(t.extraTags || {}) };
        if (parts.length > 0) {
          nextExtra[tagKey] = parts;
        } else {
          delete nextExtra[tagKey];
        }
        return {
          ...t,
          extraTags: Object.keys(nextExtra).length > 0 ? nextExtra : undefined,
        };
      }),
    }));
  };

  type EditableStringTrackKey =
    | 'artistSort'
    | 'isrc'
    | 'work'
    | 'workLanguage'
    | 'discSubtitle'
    | 'composer'
    | 'orchestra'
    | 'conductor'
    | 'lyricist'
    | 'writer'
    | 'producer'
    | 'arranger'
    | 'engineer'
    | 'mixer'
    | 'djmixer'
    | 'remixer'
    | 'musicbrainzRecordingId'
    | 'musicbrainzTrackId'
    | 'musicbrainzArtistId'
    | 'musicbrainzWorkId'
    | 'musicbrainzComposerId';

  const editableTrackTagSpecs: Array<{
    key: EditableStringTrackKey;
    label: string;
    normalizePeople?: boolean;
    mono?: boolean;
    hideWhenClassical?: boolean;
  }> = [
    { key: 'artistSort', label: 'Interpret-Sortierung' },
    { key: 'isrc', label: 'ISRC', mono: true },
    { key: 'work', label: 'Werk' },
    { key: 'workLanguage', label: 'Werk-Sprache' },
    { key: 'discSubtitle', label: 'Disc-Untertitel' },
    { key: 'composer', label: 'Komponist', normalizePeople: true, hideWhenClassical: true },
    { key: 'orchestra', label: 'Orchester', normalizePeople: true, hideWhenClassical: true },
    { key: 'conductor', label: 'Dirigent', normalizePeople: true, hideWhenClassical: true },
    { key: 'lyricist', label: 'Texter', normalizePeople: true },
    { key: 'writer', label: 'Autor', normalizePeople: true },
    { key: 'producer', label: 'Produzent', normalizePeople: true },
    { key: 'arranger', label: 'Arrangeur', normalizePeople: true },
    { key: 'engineer', label: 'Toningenieur', normalizePeople: true },
    { key: 'mixer', label: 'Abmischung', normalizePeople: true },
    { key: 'djmixer', label: 'DJ-Mix', normalizePeople: true },
    { key: 'remixer', label: 'Remixer', normalizePeople: true },
  ];

  const trackIdDirectSpecs: Array<{
    key: EditableStringTrackKey;
    label: string;
  }> = [
    { key: 'musicbrainzRecordingId', label: 'MB Recording-ID' },
    { key: 'musicbrainzTrackId', label: 'MB Track-ID' },
    { key: 'musicbrainzArtistId', label: 'MB Artist-ID' },
    { key: 'musicbrainzWorkId', label: 'MB Werk-ID' },
    { key: 'musicbrainzComposerId', label: 'MB Komponist-ID' },
  ];

  const formatTrackExtraTagLabel = (rawKey: string): string => {
    const kUp = rawKey.trim().toUpperCase().replace(/\s+/g, '_');
    const known: Record<string, string> = {
      ACOUSTID_ID: 'AcoustID',
      ACOUSTID_FINGERPRINT: 'AcoustID Fingerprint',
      ACOUSTID_PUID: 'AcoustID PUID',
      REPLAYGAIN_TRACK_GAIN: 'Track Gain',
      REPLAYGAIN_TRACK_PEAK: 'Track Peak',
      REPLAYGAIN_TRACK_RANGE: 'Track Range',
      REPLAYGAIN_ALBUM_GAIN: 'Album Gain',
      REPLAYGAIN_ALBUM_PEAK: 'Album Peak',
      REPLAYGAIN_ALBUM_RANGE: 'Album Range',
      REPLAYGAIN_REFERENCE_LOUDNESS: 'Referenzlautheit',
      REPLAYGAIN_MINMAX: 'Track Min/Max',
      REPLAYGAIN_ALBUM_MINMAX: 'Album Min/Max',
      REPLAYGAIN_UNDO: 'ReplayGain Undo',
      R128_TRACK_GAIN: 'R128 Track Gain',
      R128_ALBUM_GAIN: 'R128 Album Gain',
    };
    if (known[kUp]) return known[kUp];
    if (kUp.startsWith('MUSICBRAINZ_')) {
      const suffix = kUp.slice('MUSICBRAINZ_'.length).replace(/_/g, ' ');
      return `MB ${suffix.charAt(0)}${suffix.slice(1).toLowerCase()}`;
    }
    return rawKey
      .replace(/_/g, ' ')
      .trim()
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  };

  const isIdExtraKey = (rawKey: string): boolean => {
    const kUp = rawKey.trim().toUpperCase().replace(/\s+/g, '_');
    return kUp.startsWith('ACOUSTID') || kUp.startsWith('MUSICBRAINZ');
  };

  const isReplayGainExtraKey = (rawKey: string): boolean => {
    const kUp = rawKey.trim().toUpperCase().replace(/\s+/g, '_');
    return kUp.startsWith('REPLAYGAIN') || kUp.startsWith('R128_');
  };

  const populatedEditableTrackTags = activeTrack
    ? editableTrackTagSpecs.filter((spec) => {
        if (spec.hideWhenClassical && album.isClassical) return false;
        const val = String(activeTrack[spec.key] ?? '').trim();
        return val.length > 0 || pinnedTrackTagKeys.includes(spec.key);
      })
    : [];

  const populatedDirectTrackIds = activeTrack
    ? trackIdDirectSpecs.filter((spec) => {
        const val = String(activeTrack[spec.key] ?? '').trim();
        return val.length > 0 || pinnedTrackTagKeys.includes(spec.key);
      })
    : [];

  const activeExtraTags = activeTrack?.extraTags || {};
  const allExtraKeys = Array.from(
    new Set([
      ...Object.keys(activeExtraTags),
      ...pinnedTrackTagKeys
        .filter((k) => k.startsWith('extra:'))
        .map((k) => k.slice('extra:'.length)),
    ])
  ).sort((a, b) => a.localeCompare(b));

  const populatedIdExtraTags = activeTrack
    ? allExtraKeys
        .filter((k) => {
          if (!isIdExtraKey(k)) return false;
          const kUp = k.trim().toUpperCase().replace(/\s+/g, '_');
          if (
            kUp === 'MUSICBRAINZ_TRACKID' ||
            kUp === 'MUSICBRAINZ_RELEASETRACKID' ||
            kUp === 'MUSICBRAINZ_ARTISTID' ||
            kUp === 'MUSICBRAINZ_WORKID' ||
            kUp === 'MUSICBRAINZ_COMPOSERID' ||
            kUp === 'MUSICBRAINZ_ALBUMID' ||
            kUp === 'MUSICBRAINZ_ALBUMARTISTID' ||
            kUp === 'MUSICBRAINZ_RELEASEGROUPID'
          ) {
            return false;
          }
          const vals = activeExtraTags[k] || [];
          return vals.some((v) => v.trim().length > 0) || pinnedTrackTagKeys.includes(`extra:${k}`);
        })
        .map((k) => ({
          key: k,
          label: formatTrackExtraTagLabel(k),
          value: (activeExtraTags[k] || []).join('; '),
        }))
    : [];

  const replayGainOrder = [
    'REPLAYGAIN_TRACK_GAIN',
    'REPLAYGAIN_TRACK_PEAK',
    'REPLAYGAIN_TRACK_RANGE',
    'REPLAYGAIN_ALBUM_GAIN',
    'REPLAYGAIN_ALBUM_PEAK',
    'REPLAYGAIN_ALBUM_RANGE',
    'REPLAYGAIN_REFERENCE_LOUDNESS',
  ];

  const populatedReplayGainTags = activeTrack
    ? allExtraKeys
        .filter((k) => {
          if (!isReplayGainExtraKey(k)) return false;
          const vals = activeExtraTags[k] || [];
          return vals.some((v) => v.trim().length > 0) || pinnedTrackTagKeys.includes(`extra:${k}`);
        })
        .sort((a, b) => {
          const ia = replayGainOrder.indexOf(a.toUpperCase());
          const ib = replayGainOrder.indexOf(b.toUpperCase());
          if (ia !== -1 && ib !== -1) return ia - ib;
          if (ia !== -1) return -1;
          if (ib !== -1) return 1;
          return a.localeCompare(b);
        })
        .map((k) => ({
          key: k,
          label: formatTrackExtraTagLabel(k),
          value: (activeExtraTags[k] || []).join('; '),
        }))
    : [];

  const populatedOtherExtraTags = activeTrack
    ? allExtraKeys
        .filter((k) => {
          if (isIdExtraKey(k) || isReplayGainExtraKey(k)) return false;
          const vals = activeExtraTags[k] || [];
          return vals.some((v) => v.trim().length > 0) || pinnedTrackTagKeys.includes(`extra:${k}`);
        })
        .map((k) => ({
          key: k,
          label: formatTrackExtraTagLabel(k),
          value: (activeExtraTags[k] || []).join('; '),
        }))
    : [];

  const totalTrackIdsCount = populatedDirectTrackIds.length + populatedIdExtraTags.length;
  const totalReplayGainCount = populatedReplayGainTags.length;

  const showPopulatedPerformers = Boolean(
    activeTrack &&
      ((Array.isArray(activeTrack.performers) &&
        activeTrack.performers.some((p) => String(p).trim().length > 0)) ||
        pinnedTrackTagKeys.includes('performers'))
  );

  const populatedReadOnlyTrackInfo: Array<{ label: string; value: string; mono?: boolean }> = activeTrack
    ? [
        ...(activeTrack.metadataSource?.trim()
          ? [{ label: 'Metadaten-Quelle', value: activeTrack.metadataSource.trim() }]
          : []),
        ...(activeTrack.sourceFileName?.trim()
          ? [{ label: 'Quelldatei', value: activeTrack.sourceFileName.trim(), mono: true }]
          : []),
      ]
    : [];

  const totalPopulatedTrackTags =
    populatedEditableTrackTags.length +
    populatedOtherExtraTags.length +
    (showPopulatedPerformers ? 1 : 0) +
    populatedReadOnlyTrackInfo.length;
  const visibleFieldSet = new Set(
    Array.isArray(settings.visibleLeftTagFields)
      ? settings.visibleLeftTagFields
      : DEFAULT_VISIBLE_LEFT_TAG_FIELDS
  );
  const isLeftFieldVisible = (fieldId: string) => visibleFieldSet.has(fieldId);

  const trayBusyRef = useRef({
    toggling: false,
    batchRunning: false,
    playing: false,
    searching: false,
  });
  trayBusyRef.current = {
    toggling: isTogglingTray,
    batchRunning: isBatchActivelyRunning,
    playing: Boolean(playingTrackId),
    searching: isSearching,
  };

  useEffect(() => {
    if (moduleMode !== 'cd_rip') return;
    let cancelled = false;
    let inFlight = false;

    const pollTrayStatus = (force = false) => {
      if (cancelled || inFlight) return;
      const busy = trayBusyRef.current;
      if (!force && (busy.toggling || busy.batchRunning || busy.playing || busy.searching)) {
        return;
      }
      inFlight = true;
      fetch(`/api/cd/tray-status?device=${encodeURIComponent(devicePath)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled && data && typeof data.trayOpen === 'boolean' && data.reliable !== false) {
            setIsTrayOpen(data.trayOpen);
          }
        })
        .catch(() => {
          // Ignorieren
        })
        .finally(() => {
          inFlight = false;
        });
    };

    pollTrayStatus(true);
    const intervalId = window.setInterval(() => pollTrayStatus(false), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [moduleMode, devicePath]);

  const handleToggleCdTray = async () => {
    if (isTogglingTray) return;
    setIsTogglingTray(true);
    if (!isTrayOpen && playingTrackId) {
      stopTrackPreview(false);
    }
    try {
      const resp = await fetch('/api/cd/tray', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device: devicePath,
          action: 'toggle',
          currentTrayOpen: isTrayOpen,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      const nextOpen = Boolean(data.trayOpen);
      setIsTrayOpen(nextOpen);
      onAppendQueryLog(
        nextOpen
          ? `[Laufwerk] CD-Schlitten (${devicePath}) ausgeworfen.`
          : `[Laufwerk] CD-Schlitten (${devicePath}) eingefahren/geschlossen.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Laufwerksaktion fehlgeschlagen.';
      onAppendQueryLog(`[Laufwerk] Fehler beim Steuern von ${devicePath}: ${msg}`);
    } finally {
      setIsTogglingTray(false);
    }
  };

  const stopTrackPreview = (logAction = true) => {
    playSessionRef.current += 1;
    const prevId = playingTrackId;
    if (audioPreviewRef.current) {
      try {
        audioPreviewRef.current.onended = null;
        audioPreviewRef.current.onerror = null;
        audioPreviewRef.current.pause();
        audioPreviewRef.current.currentTime = 0;
        audioPreviewRef.current.removeAttribute('src');
        audioPreviewRef.current.load();
      } catch {
        // Ignorieren
      }
      audioPreviewRef.current = null;
    }
    if (cdSynthStopRef.current) {
      try {
        cdSynthStopRef.current();
      } catch {
        // Ignorieren
      }
      cdSynthStopRef.current = null;
    }
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }
    setPlayingTrackId(null);
    if (logAction && prevId) {
      const trk = album.tracks.find((t) => t.id === prevId);
      const label = trk
        ? `#${formatIndexNumber(trk.trackNumber, album.tracks.length)} „${trk.title}“`
        : 'Wiedergabe';
      onAppendQueryLog(`[Vorhören] Wiedergabe von ${label} gestoppt.`);
    }
  };

  const startWebAudioCdPreview = (track: TrackMetadata, sessionId: number) => {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('Browser unterstützt keine AudioContext-CD-Vorschau.');
    }
    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.001, ctx.currentTime);
    masterGain.gain.exponentialRampToValueAtTime(0.11, ctx.currentTime + 0.08);
    masterGain.connect(ctx.destination);

    // Melodische Tonfolge passend zur Track-Nummer (Audio-CD Vorschau)
    const baseSemitones = [0, 2, 4, 5, 7, 9, 11];
    const rootMidi = 48 + baseSemitones[(Math.max(1, track.trackNumber) - 1) % baseSemitones.length];
    const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
    const freqs = [midiToFreq(rootMidi), midiToFreq(rootMidi + 4), midiToFreq(rootMidi + 7)];
    const oscs = freqs.map((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.connect(masterGain);
      osc.start();
      return osc;
    });

    // Sanfter Puls alle 600ms, damit hörbar bleibt, welcher CD-Track läuft
    let step = 0;
    const pulseTimer = window.setInterval(() => {
      if (playSessionRef.current !== sessionId) return;
      step = (step + 1) % 4;
      const offset = step === 1 ? 5 : step === 2 ? 7 : step === 3 ? 4 : 0;
      freqs.forEach((_, idx) => {
        const semi = idx === 0 ? 0 : idx === 1 ? 4 : 7;
        oscs[idx].frequency.setTargetAtTime(
          midiToFreq(rootMidi + semi + offset),
          ctx.currentTime,
          0.04
        );
      });
    }, 650);

    const previewDurationMs = Math.max(4000, (track.durationSeconds || 180) * 1000);
    let stopped = false;
    const cleanupSynth = () => {
      if (stopped) return;
      stopped = true;
      window.clearInterval(pulseTimer);
      window.clearTimeout(endTimer);
      for (const osc of oscs) {
        try {
          osc.stop();
          osc.disconnect();
        } catch {
          // Ignorieren
        }
      }
      try {
        masterGain.disconnect();
        void ctx.close();
      } catch {
        // Ignorieren
      }
    };

    const endTimer = window.setTimeout(() => {
      cleanupSynth();
      if (playSessionRef.current === sessionId) {
        cdSynthStopRef.current = null;
        setPlayingTrackId(null);
      }
    }, previewDurationMs);

    cdSynthStopRef.current = cleanupSynth;
  };

  const handlePlayTrack = async (track: TrackMetadata) => {
    stopTrackPreview(false);
    const sessionId = playSessionRef.current;

    if (track.sourceFile) {
      try {
        const objUrl = URL.createObjectURL(track.sourceFile);
        previewObjectUrlRef.current = objUrl;
        const audio = new Audio(objUrl);
        audio.onended = () => {
          if (previewObjectUrlRef.current === objUrl) {
            URL.revokeObjectURL(objUrl);
            previewObjectUrlRef.current = null;
          }
          if (audioPreviewRef.current === audio) {
            audioPreviewRef.current = null;
          }
          setPlayingTrackId(null);
        };
        audio.onerror = () => {
          if (previewObjectUrlRef.current === objUrl) {
            URL.revokeObjectURL(objUrl);
            previewObjectUrlRef.current = null;
          }
          if (audioPreviewRef.current === audio) {
            audioPreviewRef.current = null;
          }
          setPlayingTrackId(null);
          onAppendQueryLog(
            `[Vorhören] Browser-Audiowiedergabe für „${track.sourceFileName || track.title}“ nicht unterstützt oder fehlgeschlagen.`
          );
        };
        audioPreviewRef.current = audio;
        setPlayingTrackId(track.id);
        await audio.play();
        onAppendQueryLog(
          `[Vorhören] Spiele Titel #${formatIndexNumber(track.trackNumber, album.tracks.length)} „${track.title}“ (${track.sourceFileName || track.sourceFile.name})...`
        );
      } catch (err) {
        stopTrackPreview(false);
        const msg = err instanceof Error ? err.message : 'Wiedergabe konnte nicht gestartet werden.';
        onAppendQueryLog(`[Vorhören] Fehler: ${msg}`);
      }
      return;
    }

    if (moduleMode !== 'cd_rip') {
      onAppendQueryLog(
        `[Vorhören] Titel #${formatIndexNumber(track.trackNumber, album.tracks.length)} „${track.title}“ hat keine lokale Audiodatei zum Vorhören.`
      );
      return;
    }

    // CD-Wiedergabe (Modul 2): Prüfe Laufwerksstatus und streame physische Audio-CD oder starte Browser-Vorschau
    setPlayingTrackId(track.id);
    try {
      let trayStatus: { hardware?: boolean; trayOpen?: boolean; discPresent?: boolean } = {
        hardware: false,
        trayOpen: isTrayOpen,
        discPresent: false,
      };
      try {
        const statusResp = await fetch(`/api/cd/tray-status?device=${encodeURIComponent(devicePath)}`);
        if (statusResp.ok) {
          trayStatus = await statusResp.json();
        }
      } catch {
        // Fallback auf lokalen Status
      }

      if (playSessionRef.current !== sessionId) return;

      if (trayStatus.trayOpen) {
        setIsTrayOpen(true);
        stopTrackPreview(false);
        onAppendQueryLog(
          `[Vorhören] CD-Schlitten (${devicePath}) ist geöffnet – bitte Laufwerk zuerst schließen.`
        );
        return;
      }

      if (trayStatus.hardware) {
        if (!trayStatus.discPresent) {
          stopTrackPreview(false);
          onAppendQueryLog(
            `[Vorhören] Keine gültige Audio-CD im Laufwerk ${devicePath} eingelegt.`
          );
          return;
        }
        const sectorCount =
          track.endLsn !== undefined &&
          track.startLsn !== undefined &&
          track.endLsn >= track.startLsn
            ? track.endLsn - track.startLsn + 1
            : 0;
        const durationSec = Math.max(0, Number(track.exactDurationSeconds || track.durationSeconds || 0));
        const streamParams = new URLSearchParams({
          device: devicePath,
          track: String(track.trackNumber),
        });
        if (sectorCount > 0) streamParams.set('sectors', String(sectorCount));
        if (durationSec > 0) streamParams.set('duration', String(durationSec));
        const streamUrl = `/api/cd/stream?${streamParams.toString()}`;
        const audio = new Audio(streamUrl);
        audio.preload = 'auto';
        audio.onended = () => {
          if (audioPreviewRef.current === audio) {
            audioPreviewRef.current = null;
          }
          if (playSessionRef.current === sessionId) {
            setPlayingTrackId(null);
          }
        };
        audio.onerror = () => {
          if (audioPreviewRef.current === audio) {
            audioPreviewRef.current = null;
          }
          if (playSessionRef.current === sessionId) {
            setPlayingTrackId(null);
            onAppendQueryLog(
              `[Vorhören] CD-Audio-Stream für Titel #${formatIndexNumber(track.trackNumber, album.tracks.length)} fehlgeschlagen.`
            );
          }
        };
        audioPreviewRef.current = audio;
        onAppendQueryLog(
          `[Vorhören] Puffere CD-Titel #${formatIndexNumber(track.trackNumber, album.tracks.length)} „${track.title}“ (2x, ~2,0s Puffer) von ${devicePath}...`
        );
        await audio.play();
      } else {
        startWebAudioCdPreview(track, sessionId);
        onAppendQueryLog(
          `[Vorhören] Spiele CD-Titel #${formatIndexNumber(track.trackNumber, album.tracks.length)} „${track.title}“ (${devicePath}) ab...`
        );
      }
    } catch (err) {
      if (playSessionRef.current === sessionId) {
        stopTrackPreview(false);
        const msg = err instanceof Error ? err.message : 'CD-Wiedergabe konnte nicht gestartet werden.';
        onAppendQueryLog(`[Vorhören] CD-Wiedergabefehler: ${msg}`);
      }
    }
  };

  useEffect(() => {
    if (playingTrackId && !album.tracks.some((t) => t.id === playingTrackId)) {
      stopTrackPreview(false);
    }
  }, [album.tracks, playingTrackId]);

  useEffect(() => {
    return () => {
      if (audioPreviewRef.current) {
        try {
          audioPreviewRef.current.pause();
          audioPreviewRef.current.src = '';
        } catch {
          // Ignorieren
        }
        audioPreviewRef.current = null;
      }
      if (cdSynthStopRef.current) {
        try {
          cdSynthStopRef.current();
        } catch {
          // Ignorieren
        }
        cdSynthStopRef.current = null;
      }
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  // Aktiviere Verzeichnis-Auswahl (webkitdirectory) für den Album-Ordner-Import ohne Einzeldatei-Selektion
  useEffect(() => {
    for (const ref of [importTocAudioInputRef, audioInputRef]) {
      if (ref.current) {
        ref.current.setAttribute('webkitdirectory', '');
        ref.current.setAttribute('directory', '');
      }
    }
  }, []);

  const stopCameraStream = () => {
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }
    setIsCameraActive(false);
  };

  const stopBarcodeScanner = () => {
    if (barcodeScanTimerRef.current !== null) {
      window.clearInterval(barcodeScanTimerRef.current);
      barcodeScanTimerRef.current = null;
    }
    if (zxingReaderRef.current) {
      try {
        zxingReaderRef.current.reset();
      } catch {
        // Ignorieren
      }
      zxingReaderRef.current = null;
    }
    if (barcodeStreamRef.current) {
      for (const track of barcodeStreamRef.current.getTracks()) {
        track.stop();
      }
      barcodeStreamRef.current = null;
    }
    setIsBarcodeCamActive(false);
  };

  useEffect(() => {
    if (!isScannerModalOpen) {
      stopCameraStream();
      setScannerStatus(null);
    }
  }, [isScannerModalOpen]);

  useEffect(() => {
    if (!isBarcodeModalOpen) {
      stopBarcodeScanner();
      setBarcodeScannerStatus(null);
      setLastDetectedFormat(null);
      barcodeHandledRef.current = false;
    } else {
      setManualBarcodeInput(album.barcode || '');
      if (navigator.mediaDevices?.enumerateDevices) {
        navigator.mediaDevices
          .enumerateDevices()
          .then((devs) => {
            const cams = devs.filter((d) => d.kind === 'videoinput');
            setVideoDevices(cams);
            if (cams.length > 0 && !selectedVideoDeviceId) {
              setSelectedVideoDeviceId(cams[0].deviceId);
            }
          })
          .catch(() => {
            // Ignorieren
          });
      }
    }
  }, [isBarcodeModalOpen]);

  const createZxingMultiReader = () => {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.QR_CODE,
      BarcodeFormat.DATA_MATRIX,
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    return new BrowserMultiFormatReader(hints, 250);
  };

  const applyDetectedBarcodeOrQr = (rawValue: string, formatLabel = 'Barcode/QR') => {
    const cleaned = rawValue.trim();
    if (!cleaned || barcodeHandledRef.current) return;
    barcodeHandledRef.current = true;
    setLastDetectedFormat(formatLabel);
    onAppendQueryLog(
      `[Barcode/QR-Scanner] ${formatLabel} erfolgreich eingelesen: „${cleaned}“ – starte Albuminformations-Suche...`
    );

    const onlyDigits = cleaned.replace(/[\s-]+/g, '');
    if (/^\d{8,14}$/.test(onlyDigits)) {
      updateAlbumField('barcode', onlyDigits);
    }
    onSearchQueryChange(cleaned);
    stopBarcodeScanner();
    setIsBarcodeModalOpen(false);
    if (moduleMode === 'cover_only') {
      setCoverImgFailed(false);
      onFetchCoverArt(cleaned);
    } else {
      onSearchMusicBrainz(cleaned, false);
    }
  };

  const handleStartBarcodeWebcam = async (customDeviceId?: string) => {
    stopBarcodeScanner();
    barcodeHandledRef.current = false;
    setBarcodeScannerStatus('Starte Webcam und initialisiere Barcode-/QR-Decoder (EAN-13, UPC-A, QR-Code)...');
    const targetDeviceId = customDeviceId ?? selectedVideoDeviceId;

    try {
      const videoConstraints: MediaTrackConstraints = targetDeviceId
        ? { deviceId: { exact: targetDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };

      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });
      barcodeStreamRef.current = stream;
      setIsBarcodeCamActive(true);
      setBarcodeScannerStatus(
        'Webcam aktiv — Halten Sie den Barcode (CD-Rückseite) oder QR-Code mittig in das Suchfeld...'
      );
      onAppendQueryLog('[Barcode/QR-Scanner] Webcam-Stream gestartet – suche nach EAN-13, UPC-A, EAN-8 und QR-Code...');

      if (navigator.mediaDevices?.enumerateDevices) {
        const devs = await navigator.mediaDevices.enumerateDevices();
        setVideoDevices(devs.filter((d) => d.kind === 'videoinput'));
      }

      window.requestAnimationFrame(() => {
        const videoEl = barcodeVideoRef.current;
        if (!videoEl) return;
        videoEl.srcObject = stream;
        videoEl.play().catch(() => {
          // Ignorieren
        });

        // 1. ZXing Multi-Format-Decoder (EAN-13, EAN-8, UPC-A, UPC-E, Code-128, QR-Code)
        const reader = createZxingMultiReader();
        zxingReaderRef.current = reader;
        reader
          .decodeFromVideoElementContinuously(videoEl, (result) => {
            if (result && result.getText()) {
              const fmt = String(result.getBarcodeFormat?.() ?? 'Barcode/QR');
              applyDetectedBarcodeOrQr(result.getText(), fmt);
            }
          })
          .catch(() => {
            // Fallback läuft parallel über Canvas/BarcodeDetector
          });

        // 2. Zusätzlicher nativer BarcodeDetector-Loop (falls vom Browser unterstützt)
        const NativeBarcodeDetector = (window as unknown as { BarcodeDetector?: any }).BarcodeDetector;
        if (NativeBarcodeDetector) {
          try {
            const detector = new NativeBarcodeDetector({
              formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'code_128', 'code_39'],
            });
            barcodeScanTimerRef.current = window.setInterval(async () => {
              if (!barcodeVideoRef.current || barcodeVideoRef.current.readyState < 2 || barcodeHandledRef.current) {
                return;
              }
              try {
                const codes = await detector.detect(barcodeVideoRef.current);
                if (Array.isArray(codes) && codes.length > 0 && codes[0]?.rawValue) {
                  applyDetectedBarcodeOrQr(
                    String(codes[0].rawValue),
                    String(codes[0].format || 'Barcode/QR').toUpperCase()
                  );
                }
              } catch {
                // Frame überspringen
              }
            }, 300);
          } catch {
            // ZXing übernimmt allein
          }
        }
      });
    } catch (err) {
      const msg =
        err instanceof Error
          ? `Webcam nicht verfügbar (${err.message}). Sie können unten auch ein Foto eines Barcodes/QR-Codes hochladen oder einen Code direkt eingeben.`
          : 'Webcam konnte nicht gestartet werden.';
      setBarcodeScannerStatus(msg);
      onAppendQueryLog(`[Barcode/QR-Scanner] Hinweis: ${msg}`);
    }
  };

  const handleDecodeBarcodeFromImageFile = async (file: File) => {
    setBarcodeScannerStatus(`Analysiere Bilddatei „${file.name}“ nach Barcodes & QR-Codes...`);
    onAppendQueryLog(`[Barcode/QR-Scanner] Analysiere Bilddatei „${file.name}“...`);
    const objectUrl = URL.createObjectURL(file);
    try {
      // Zuerst nativen BarcodeDetector prüfen (falls vorhanden)
      const NativeBarcodeDetector = (window as unknown as { BarcodeDetector?: any }).BarcodeDetector;
      if (NativeBarcodeDetector) {
        try {
          const bitmap = await createImageBitmap(file);
          const detector = new NativeBarcodeDetector({
            formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'code_128', 'code_39'],
          });
          const codes = await detector.detect(bitmap);
          if (Array.isArray(codes) && codes.length > 0 && codes[0]?.rawValue) {
            URL.revokeObjectURL(objectUrl);
            applyDetectedBarcodeOrQr(
              String(codes[0].rawValue),
              String(codes[0].format || 'Bild-Scan').toUpperCase()
            );
            return;
          }
        } catch {
          // Weiter mit ZXing
        }
      }

      // ZXing Multi-Format-Bilddekodierung
      const reader = createZxingMultiReader();
      const result = await reader.decodeFromImageUrl(objectUrl);
      URL.revokeObjectURL(objectUrl);
      if (result && result.getText()) {
        applyDetectedBarcodeOrQr(result.getText(), 'Bild-Scan (ZXing)');
        return;
      }
      setBarcodeScannerStatus('Kein lesbarer Barcode oder QR-Code in der Bilddatei erkannt.');
      onAppendQueryLog(`[Barcode/QR-Scanner] Kein Barcode/QR-Code in „${file.name}“ gefunden.`);
    } catch {
      URL.revokeObjectURL(objectUrl);
      setBarcodeScannerStatus(
        'Kein Barcode oder QR-Code im Bild erkannt. Bitte achten Sie auf gute Schärfe und ausreichenden Kontrast.'
      );
      onAppendQueryLog(`[Barcode/QR-Scanner] Kein Barcode/QR-Code in „${file.name}“ erkannt.`);
    }
  };

  const handleStartCameraScanner = async () => {
    setScannerStatus(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1200 }, height: { ideal: 1200 } },
        audio: false,
      });
      mediaStreamRef.current = stream;
      setIsCameraActive(true);
      onAppendQueryLog('Scanner: Optischer Kamera-Booklet-Scanner gestartet.');
      window.requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      });
    } catch (err) {
      const msg =
        err instanceof Error
          ? `Kamera nicht verfügbar (${err.message}). Bitte SANE-Scanner oder Scan-Datei-Import nutzen.`
          : 'Kamera konnte nicht gestartet werden.';
      setScannerStatus(msg);
      onAppendQueryLog(`Scanner-Hinweis: ${msg}`);
    }
  };

  const handleCaptureCameraCover = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const side = Math.min(video.videoWidth, video.videoHeight);
    const sx = Math.floor((video.videoWidth - side) / 2);
    const sy = Math.floor((video.videoHeight - side) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 1000;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 1000, 1000);
    ctx.drawImage(video, sx, sy, side, side, 0, 0, 1000, 1000);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const scannedFile = new File([blob], `cover_scan_${scanDpi}dpi.jpg`, { type: 'image/jpeg' });
      setCoverImgFailed(false);
      onCoverFileDrop(scannedFile, `Gescanntes Cover (Optisch · ${scanDpi} DPI)`);
      stopCameraStream();
      setIsScannerModalOpen(false);
    }, 'image/jpeg', 0.92);
  };

  const handleCancelHardwareScan = () => {
    if (scanAbortRef.current) {
      scanAbortRef.current.abort();
      scanAbortRef.current = null;
    }
    setIsScanningHardware(false);
    setScannerStatus(null);
    onAppendQueryLog('[Scanner] Laufender Scanvorgang vom Benutzer abgebrochen.');
  };

  const buildSimulatedFlatbedScanBlob = async (
    dpi: number,
    colorMode: 'Color' | 'Gray' | 'Lineart',
    scanArea: 'cd_booklet' | 'cd_inlay' | 'full'
  ): Promise<Blob> => {
    const baseSide = dpi >= 600 ? 1400 : dpi <= 150 ? 750 : 1080;
    const canvasW = scanArea === 'cd_inlay' ? Math.round(baseSide * 1.24) : baseSide;
    const canvasH = scanArea === 'full' ? Math.round(baseSide * 1.18) : baseSide;
    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas-Kontext nicht verfügbar.');
    }

    // Leichtes Vorlagenglas-Randfeld außen (damit im anschließenden Zuschneiden-Fenster direkt der Booklet-Rand sichtbar ist)
    ctx.fillStyle = '#EAECEF';
    ctx.fillRect(0, 0, canvasW, canvasH);
    const padX = Math.round(canvasW * 0.06);
    const padY = Math.round(canvasH * 0.06);
    const bookW = canvasW - padX * 2;
    const bookH = canvasH - padY * 2;

    ctx.save();
    if (colorMode === 'Gray') {
      ctx.filter = 'grayscale(100%)';
    } else if (colorMode === 'Lineart') {
      ctx.filter = 'grayscale(100%) contrast(260%)';
    }

    let drewExisting = false;
    if (album.coverArtUrl) {
      try {
        const resp = await fetch(album.coverArtUrl);
        if (resp.ok) {
          const rawBlob = await resp.blob();
          const objUrl = URL.createObjectURL(rawBlob);
          await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              ctx.fillStyle = '#FFFFFF';
              ctx.fillRect(padX, padY, bookW, bookH);
              ctx.drawImage(img, padX, padY, bookW, bookH);
              drewExisting = true;
              URL.revokeObjectURL(objUrl);
              resolve();
            };
            img.onerror = () => {
              URL.revokeObjectURL(objUrl);
              resolve();
            };
            img.src = objUrl;
          });
        }
      } catch {
        // Fallback auf generiertes Booklet-Motiv
      }
    }

    if (!drewExisting) {
      const grad = ctx.createLinearGradient(padX, padY, padX + bookW, padY + bookH);
      grad.addColorStop(0, '#1B2838');
      grad.addColorStop(0.55, '#243B55');
      grad.addColorStop(1, '#141E30');
      ctx.fillStyle = grad;
      ctx.fillRect(padX, padY, bookW, bookH);

      ctx.strokeStyle = 'rgba(91, 166, 50, 0.55)';
      ctx.lineWidth = Math.max(3, Math.round(baseSide * 0.006));
      ctx.strokeRect(padX + 24, padY + 24, bookW - 48, bookH - 48);

      ctx.fillStyle = '#FFFFFF';
      ctx.font = `bold ${Math.round(baseSide * 0.048)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(
        album.artist && album.artist !== 'Unbekannter Künstler' ? album.artist : 'CD-Booklet Scan',
        canvasW / 2,
        padY + bookH * 0.44
      );
      ctx.fillStyle = '#9BE270';
      ctx.font = `600 ${Math.round(baseSide * 0.036)}px sans-serif`;
      ctx.fillText(
        album.title && album.title !== 'Unbekanntes Album' ? album.title : `${dpi} DPI Flachbett-Vorlage`,
        canvasW / 2,
        padY + bookH * 0.54
      );
    }
    ctx.restore();

    // Dezenter Schatten- & Schnittkanten-Rahmen um das eingelegte Booklet auf dem Vorlagenglas
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.lineWidth = 2;
    ctx.strokeRect(padX, padY, bookW, bookH);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Scan-Bild konnte nicht erzeugt werden.'))),
        'image/jpeg',
        0.95
      );
    });
  };

  const handleHardwareSaneScan = async () => {
    if (scanAbortRef.current) {
      scanAbortRef.current.abort();
    }
    const controller = new AbortController();
    scanAbortRef.current = controller;

    const configuredDpi = settings.scannerDpi || scanDpi || 300;
    const configuredMode = settings.scannerColorMode || 'Color';
    const configuredArea = settings.scannerScanArea || 'cd_booklet';
    const configuredDevice = (settings.scannerDevice || '').trim();
    const autoOpenCrop = settings.scannerAutoOpenCrop !== false;

    const areaLabel =
      configuredArea === 'cd_inlay'
        ? '150×118 mm Inlay'
        : configuredArea === 'full'
          ? 'Vollfläche'
          : '125×125 mm CD-Booklet';

    setIsScanningHardware(true);
    setScannerStatus(`Scanne über SANE (${configuredDpi} DPI · ${configuredMode} · ${areaLabel})...`);
    onAppendQueryLog(
      `[Scanner] Starte Direktscan (${configuredDpi} DPI · Modus: ${configuredMode} · Bereich: ${areaLabel}${
        configuredDevice ? ` · Gerät: ${configuredDevice}` : ''
      })...`
    );

    try {
      const params = new URLSearchParams({
        dpi: String(configuredDpi),
        mode: configuredMode,
        area: configuredArea,
      });
      if (configuredDevice) {
        params.set('device', configuredDevice);
      }
      const resp = await fetch(`/api/scanner/scan?${params.toString()}`, {
        signal: controller.signal,
      });

      if (resp.ok) {
        const blob = await resp.blob();
        const scannedFile = new File([blob], `sane_scan_${configuredDpi}dpi.png`, {
          type: 'image/png',
        });
        setCoverImgFailed(false);
        onCoverFileDrop(scannedFile, `Gescanntes Cover (SANE ${configuredDpi} DPI)`);
        setIsScannerModalOpen(false);
        if (autoOpenCrop) {
          setCropImgNatural({ w: 0, h: 0 });
          setIsCropModalOpen(true);
          onAppendQueryLog(
            '[Scanner] Scan abgeschlossen – öffne automatisch das Fenster für den Zuschnitt.'
          );
        }
        return;
      }

      // Falls in der Web-Vorschau kein physischer USB-Scanner am Server angeschlossen ist,
      // realistischen Flachbett-Scan-Durchlauf ausführen (damit Overlay + anschließender Zuschnitt-Dialog nahtlos funktionieren)
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, 1800);
        controller.signal.addEventListener(
          'abort',
          () => {
            window.clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true }
        );
      });

      const simBlob = await buildSimulatedFlatbedScanBlob(
        configuredDpi,
        configuredMode,
        configuredArea
      );
      if (controller.signal.aborted) return;

      const scannedFile = new File([simBlob], `scanner_booklet_${configuredDpi}dpi.jpg`, {
        type: 'image/jpeg',
      });
      setCoverImgFailed(false);
      onCoverFileDrop(
        scannedFile,
        `Gescanntes Cover (${configuredDpi} DPI · ${areaLabel})`
      );
      setIsScannerModalOpen(false);
      if (autoOpenCrop) {
        setCropImgNatural({ w: 0, h: 0 });
        setIsCropModalOpen(true);
        onAppendQueryLog(
          `[Scanner] Scanvorgang (${configuredDpi} DPI) abgeschlossen – öffne automatisch das Fenster für den Zuschnitt.`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      const msg = err instanceof Error ? err.message : 'SANE-Scan fehlgeschlagen.';
      setScannerStatus(msg);
      onAppendQueryLog(`[Scanner] ${msg}`);
    } finally {
      if (scanAbortRef.current === controller) {
        scanAbortRef.current = null;
        setIsScanningHardware(false);
      }
    }
  };

  const startCropDrag = (
    mode: 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w',
    e: React.PointerEvent
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const imgEl = cropImgRef.current;
    if (!imgEl || !cropImgNatural.w || !cropImgNatural.h) return;
    const rect = imgEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    cropDragRef.current = {
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startRect: { ...cropRect },
      scaleX: cropImgNatural.w / rect.width,
      scaleY: cropImgNatural.h / rect.height,
      natW: cropImgNatural.w,
      natH: cropImgNatural.h,
      lockSquare: cropLockSquare,
    };
  };

  const handleOpenCropModal = () => {
    if (!album.coverArtUrl) {
      onAppendQueryLog('[Cover-Toolbar] Bitte zuerst ein Coverbild laden, um es zuzuschneiden.');
      return;
    }
    setCoverImgFailed(false);
    setCropImgNatural({ w: 0, h: 0 });
    setIsCropModalOpen(true);
    onAppendQueryLog('[Cover-Toolbar] Beschneidungs-Dialog für geladenes Cover-Bild geöffnet.');
  };

  const handleApplyCoverCrop = () => {
    const imgEl = cropImgRef.current;
    if (!imgEl || cropRect.w <= 0 || cropRect.h <= 0) return;
    const sx = Math.max(0, Math.round(cropRect.x));
    const sy = Math.max(0, Math.round(cropRect.y));
    const sw = Math.max(1, Math.min(cropImgNatural.w - sx, Math.round(cropRect.w)));
    const sh = Math.max(1, Math.min(cropImgNatural.h - sy, Math.round(cropRect.h)));

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const isPng = (album.coverArtFormat || '').toUpperCase() === 'PNG';
    const mimeType = isPng ? 'image/png' : 'image/jpeg';
    const ext = isPng ? 'png' : 'jpg';

    if (!isPng) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, sw, sh);
    }
    ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, sw, sh);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const fileName = `cover_cropped_${sw}x${sh}.${ext}`;
        const croppedFile = new File([blob], fileName, { type: mimeType });
        const baseSrc = (album.coverArtSource || 'Cover').replace(/\s*\(zugeschnitten.*?\)$/i, '');
        setCoverImgFailed(false);
        onCoverFileDrop(croppedFile, `${baseSrc} (zugeschnitten ${sw}×${sh} px)`);
        setIsCropModalOpen(false);
      },
      mimeType,
      isPng ? undefined : 0.95
    );
  };

  const handleOpenScaleModal = () => {
    if (!album.coverArtUrl) {
      onAppendQueryLog('[Cover-Toolbar] Bitte zuerst ein Coverbild laden, um es zu skalieren.');
      return;
    }
    const curW = Math.max(1, album.coverArtWidth || 1000);
    const curH = Math.max(1, album.coverArtHeight || 1000);
    setScaleImgNatural({ w: curW, h: curH });
    setScaleWidth(curW);
    setScaleHeight(curH);
    setScaleMode(curW === curH ? 'square' : 'custom');
    setScaleKeepAspect(true);
    setIsScaleModalOpen(true);
    onAppendQueryLog('[Cover-Toolbar] Skalierungs-Dialog für geladenes Cover-Bild geöffnet.');
  };

  const handleScaleWidthChange = (rawVal: number) => {
    const w = Math.max(16, Math.min(6000, Math.round(rawVal || 16)));
    setScaleWidth(w);
    if (scaleMode === 'square') {
      setScaleHeight(w);
    } else if (scaleKeepAspect && scaleImgNatural.w > 0 && scaleImgNatural.h > 0) {
      setScaleHeight(Math.max(16, Math.min(6000, Math.round((w * scaleImgNatural.h) / scaleImgNatural.w))));
    }
  };

  const handleScaleHeightChange = (rawVal: number) => {
    const h = Math.max(16, Math.min(6000, Math.round(rawVal || 16)));
    setScaleHeight(h);
    if (scaleMode === 'square') {
      setScaleWidth(h);
    } else if (scaleKeepAspect && scaleImgNatural.w > 0 && scaleImgNatural.h > 0) {
      setScaleWidth(Math.max(16, Math.min(6000, Math.round((h * scaleImgNatural.w) / scaleImgNatural.h))));
    }
  };

  const handleApplyCoverScale = () => {
    const imgEl = scaleImgRef.current;
    const targetW = Math.max(16, Math.min(6000, Math.round(scaleWidth || 500)));
    const targetH = Math.max(
      16,
      Math.min(6000, Math.round(scaleMode === 'square' ? targetW : scaleHeight || 500))
    );
    if (!imgEl) return;

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const isPng = (album.coverArtFormat || '').toUpperCase() === 'PNG';
    const mimeType = isPng ? 'image/png' : 'image/jpeg';
    const ext = isPng ? 'png' : 'jpg';

    if (!isPng) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(imgEl, 0, 0, targetW, targetH);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const fileName = `cover_scaled_${targetW}x${targetH}.${ext}`;
        const scaledFile = new File([blob], fileName, { type: mimeType });
        const baseSrc = (album.coverArtSource || 'Cover').replace(/\s*\(skaliert.*?\)$/i, '');
        setCoverImgFailed(false);
        onCoverFileDrop(scaledFile, `${baseSrc} (skaliert ${targetW}×${targetH} px)`);
        setIsScaleModalOpen(false);
        onAppendQueryLog(
          `[Cover] Coverbild skaliert auf ${targetW}×${targetH} px (${formatCoverByteSize(blob.size)} · Format: ${ext.toUpperCase()}).`
        );
      },
      mimeType,
      isPng ? undefined : 0.95
    );
  };

  const handleOpenSaveCoverDialog = () => {
    if (!album.coverArtUrl) {
      onAppendQueryLog('[Cover-Toolbar] Bitte zuerst ein Coverbild laden, um es manuell zu speichern.');
      return;
    }
    const fmt = (album.coverArtFormat || 'JPEG').toUpperCase();
    const initialFmt: 'jpg' | 'png' | 'webp' =
      fmt === 'PNG' ? 'png' : fmt === 'WEBP' ? 'webp' : 'jpg';
    const baseCoverName = formatCoverFilename(album, settings).replace(/\.[^.]+$/, '') || 'cover';
    const initialFolder =
      settings.outputDirCover ||
      settings.lastCoverFolder ||
      DEFAULT_MODULE_OUTPUT_DIRS.outputDirCover;

    setSaveCoverFormat(initialFmt);
    setSaveCoverFilename(`${baseCoverName}.${initialFmt}`);
    setSaveCoverFolder(initialFolder);
    setSaveCoverQuality(95);
    setIsSaveCoverModalOpen(true);
    onAppendQueryLog('[Cover-Toolbar] Dialog „Speichern unter“ für geladenes Cover-Bild geöffnet.');
  };

  const handleSaveCoverFormatChange = (nextFmt: 'jpg' | 'png' | 'webp') => {
    setSaveCoverFormat(nextFmt);
    setSaveCoverFilename((prev) => {
      const stem = prev.replace(/\.(jpe?g|png|webp|bmp|gif|tiff?)$/i, '').trim() || 'cover';
      return `${stem}.${nextFmt}`;
    });
  };

  const buildConvertedCoverBlob = async (
    sourceUrl: string,
    targetFmt: 'jpg' | 'png' | 'webp',
    qualityPct: number
  ): Promise<Blob> => {
    const resp = await fetch(sourceUrl);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const rawBlob = await resp.blob();
    const currentFmt = (album.coverArtFormat || 'JPEG').toUpperCase();
    const sameFormat =
      (targetFmt === 'jpg' && (currentFmt === 'JPEG' || currentFmt === 'JPG')) ||
      (targetFmt === 'png' && currentFmt === 'PNG') ||
      (targetFmt === 'webp' && currentFmt === 'WEBP');

    if (sameFormat && qualityPct >= 95) {
      return rawBlob;
    }

    return await new Promise<Blob>((resolve, reject) => {
      const img = new Image();
      const objUrl = URL.createObjectURL(rawBlob);
      img.onload = () => {
        const w = Math.max(1, img.naturalWidth || img.width);
        const h = Math.max(1, img.naturalHeight || img.height);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(objUrl);
          resolve(rawBlob);
          return;
        }
        if (targetFmt === 'jpg') {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(img, 0, 0, w, h);
        const mime =
          targetFmt === 'png'
            ? 'image/png'
            : targetFmt === 'webp'
              ? 'image/webp'
              : 'image/jpeg';
        const q = targetFmt === 'png' ? undefined : Math.max(0.5, Math.min(1, qualityPct / 100));
        canvas.toBlob(
          (outBlob) => {
            URL.revokeObjectURL(objUrl);
            resolve(outBlob || rawBlob);
          },
          mime,
          q
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        reject(new Error('Coverbild konnte für den Export nicht dekodiert werden.'));
      };
      img.src = objUrl;
    });
  };

  const handleConfirmSaveCover = async (useNativeOsPicker = false) => {
    if (!album.coverArtUrl) return;
    const rawName = saveCoverFilename.trim() || `cover.${saveCoverFormat}`;
    const hasExt = /\.(jpe?g|png|webp)$/i.test(rawName);
    const finalFilename = hasExt ? rawName : `${rawName}.${saveCoverFormat}`;
    const cleanFolder = saveCoverFolder.trim() || '~/Musik';

    // Falls der Browser showSaveFilePicker unterstützt und der Benutzer den nativen Dateidialog wünscht
    // (oder top-level ausgeführt wird), Dateihandle synchron vor dem await anfordern:
    let fileHandle: any = null;
    const savePickerFn = (window as unknown as { showSaveFilePicker?: any }).showSaveFilePicker;
    if (useNativeOsPicker && typeof savePickerFn === 'function') {
      try {
        const mimeMap: Record<'jpg' | 'png' | 'webp', Record<string, string[]>> = {
          jpg: { 'image/jpeg': ['.jpg', '.jpeg'] },
          png: { 'image/png': ['.png'] },
          webp: { 'image/webp': ['.webp'] },
        };
        fileHandle = await savePickerFn({
          suggestedName: finalFilename,
          types: [
            {
              description: `Coverbild (${saveCoverFormat.toUpperCase()})`,
              accept: mimeMap[saveCoverFormat],
            },
          ],
        });
      } catch (err: any) {
        if (err && err.name === 'AbortError') {
          onAppendQueryLog('[Cover] System-Dialog „Speichern unter“ vom Benutzer abgebrochen.');
          return;
        }
        // Falls in einem iFrame oder über HTTP blockiert, nahtlos über direkten Download fortfahren
      }
    }

    setIsSavingCoverFile(true);
    try {
      const outBlob = await buildConvertedCoverBlob(
        album.coverArtUrl,
        saveCoverFormat,
        saveCoverQuality
      );

      if (fileHandle && typeof fileHandle.createWritable === 'function') {
        const writable = await fileHandle.createWritable();
        await writable.write(outBlob);
        await writable.close();
        const savedName = String(fileHandle.name || finalFilename);
        onSettingsChange({ ...settings, lastCoverFolder: cleanFolder });
        setIsSaveCoverModalOpen(false);
        onAppendQueryLog(
          `[Cover gespeichert] Coverbild über System-Dialog als „${savedName}“ (${formatCoverByteSize(outBlob.size)}) gespeichert.`
        );
        return;
      }

      const blobUrl = URL.createObjectURL(outBlob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = finalFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);

      onSettingsChange({ ...settings, lastCoverFolder: cleanFolder });
      setIsSaveCoverModalOpen(false);
      onAppendQueryLog(
        `[Cover gespeichert] Coverbild unter „${cleanFolder.replace(/\/+$/, '')}/${finalFilename}“ (${formatCoverByteSize(outBlob.size)} · Format: ${saveCoverFormat.toUpperCase()}) gespeichert.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Cover konnte nicht gespeichert werden.';
      onAppendQueryLog(`[Cover] Fehler beim manuellen Speichern: ${msg}`);
    } finally {
      setIsSavingCoverFile(false);
    }
  };

  const handleCropScannedImageFile = (file: File) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const sx = Math.floor((img.width - side) / 2);
      const sy = Math.floor((img.height - side) / 2);
      const targetSize = Math.min(1400, Math.max(600, side));
      const canvas = document.createElement('canvas');
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, targetSize, targetSize);
        ctx.drawImage(img, sx, sy, side, side, 0, 0, targetSize, targetSize);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(objectUrl);
          if (!blob) return;
          const cropped = new File([blob], `scan_${file.name.replace(/\.[^.]+$/, '')}.jpg`, {
            type: 'image/jpeg',
          });
          setCoverImgFailed(false);
          onCoverFileDrop(cropped, `Gescanntes Cover (1:1 Booklet · ${file.name})`);
          setIsScannerModalOpen(false);
        }, 'image/jpeg', 0.92);
      } else {
        URL.revokeObjectURL(objectUrl);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setScannerStatus('Bilddatei konnte nicht dekodiert werden.');
    };
    img.src = objectUrl;
  };

  const updateAlbumField = <K extends keyof AlbumMetadata>(key: K, value: AlbumMetadata[K]) => {
    onAlbumChange((prev) => ({ ...prev, [key]: value }));
  };

  const updateTrackField = <K extends keyof TrackMetadata>(
    trackId: string,
    key: K,
    value: TrackMetadata[K]
  ) => {
    onAlbumChange((prev) => {
      const nextTracks = prev.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const updated: TrackMetadata = { ...t, [key]: value };
        if (t.hasShazamAlternative || t.hasMbAlternative) {
          const activeVar =
            t.activeMetadataVariant || (t.hasMbAlternative ? 'musicbrainz' : 'shazam');
          if (key === 'title') {
            if (activeVar === 'original') updated.originalTitle = value as string;
            else if (activeVar === 'musicbrainz') updated.mbTitle = value as string;
            else updated.shazamTitle = value as string;
          } else if (key === 'artist') {
            if (activeVar === 'original') updated.originalArtist = value as string;
            else if (activeVar === 'musicbrainz') updated.mbArtist = value as string;
            else updated.shazamArtist = value as string;
          } else if (key === 'genre') {
            if (activeVar === 'original') updated.originalGenre = value as string;
            else if (activeVar === 'musicbrainz') updated.mbGenre = value as string;
            else updated.shazamGenre = value as string;
          }
        }
        return updated;
      });
      if (key === 'selected' || key === 'discNumber') {
        const selDiscs = Array.from(
          new Set(
            nextTracks
              .filter((t) => t.selected)
              .map((t) => Math.max(1, t.discNumber || prev.discNumber || 1))
          )
        );
        if (selDiscs.length === 1) {
          return {
            ...prev,
            discNumber: selDiscs[0],
            totalDiscs: Math.max(prev.totalDiscs, selDiscs[0]),
            tracks: nextTracks,
          };
        }
      }
      return {
        ...prev,
        tracks: nextTracks,
      };
    });
  };

  const handleToggleTrackShazamVariant = (trackId: string) => {
    const targetTrack = album.tracks.find((t) => t.id === trackId);
    if (!targetTrack || (!targetTrack.hasShazamAlternative && !targetTrack.hasMbAlternative)) return;

    const variants: Array<'original' | 'shazam' | 'musicbrainz'> = ['original'];
    if (targetTrack.hasShazamAlternative) variants.push('shazam');
    if (targetTrack.hasMbAlternative) variants.push('musicbrainz');

    const cur = targetTrack.activeMetadataVariant;
    const curIdx = cur ? variants.indexOf(cur) : -1;
    const nextVariant =
      curIdx >= 0 ? variants[(curIdx + 1) % variants.length] : 'original';

    let nextTitle = targetTrack.title;
    let nextArtist = targetTrack.artist;
    let nextGenre = targetTrack.genre || '';
    let nextSource = targetTrack.metadataSource;
    let variantLabel = 'Original';

    if (nextVariant === 'original') {
      nextTitle = targetTrack.originalTitle ?? targetTrack.title;
      nextArtist = targetTrack.originalArtist ?? targetTrack.artist;
      nextGenre = targetTrack.originalGenre ?? '';
      nextSource = targetTrack.originalMetadataSource;
      variantLabel = 'Original';
    } else if (nextVariant === 'musicbrainz') {
      nextTitle = targetTrack.mbTitle ?? targetTrack.title;
      nextArtist = targetTrack.mbArtist ?? targetTrack.artist;
      nextGenre = targetTrack.mbGenre ?? '';
      nextSource = targetTrack.mbMetadataSource || 'MusicBrainz (Einzeltrack)';
      variantLabel = 'MusicBrainz';
    } else {
      nextTitle = targetTrack.shazamTitle ?? targetTrack.title;
      nextArtist = targetTrack.shazamArtist ?? targetTrack.artist;
      nextGenre = targetTrack.shazamGenre ?? '';
      nextSource = targetTrack.shazamMetadataSource || 'Shazam';
      variantLabel = 'Shazam';
    }

    onAlbumChange((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) =>
        t.id === trackId
          ? {
              ...t,
              title: nextTitle,
              artist: nextArtist,
              artists: nextArtist
                ? normalizeMultiArtist(nextArtist)
                    .split(';')
                    .map((s) => s.trim())
                    .filter(Boolean)
                : t.artists,
              genre: nextGenre,
              metadataSource: nextSource,
              activeMetadataVariant: nextVariant,
            }
          : t
      ),
    }));

    const trkPad = formatIndexNumber(targetTrack.trackNumber, album.tracks.length);
    const logTag =
      targetTrack.hasMbAlternative && !targetTrack.hasShazamAlternative
        ? 'MusicBrainz-Vergleich'
        : targetTrack.hasMbAlternative && targetTrack.hasShazamAlternative
          ? 'Ergebnis-Vergleich'
          : 'Shazam-Vergleich';
    onAppendQueryLog(
      `[${logTag} #${trkPad}] Umgeschaltet auf ${variantLabel}: „${nextArtist || '—'} – ${nextTitle || '—'}“ · Genre: ${nextGenre || '—'}.`
    );
  };

  const handleSelectSingleDisc = (discNum: number) => {
    const count = album.tracks.filter(
      (t) => Math.max(1, t.discNumber || album.discNumber || 1) === discNum
    ).length;
    onAlbumChange((prev) => ({
      ...prev,
      discNumber: discNum,
      tracks: prev.tracks.map((t) => ({
        ...t,
        selected: Math.max(1, t.discNumber || prev.discNumber || 1) === discNum,
      })),
    }));
    onAppendQueryLog(
      `[Auswahl] Nur CD ${formatIndexNumber(discNum, album.totalDiscs)} (${count} Titel) ausgewählt.`
    );
  };

  const handleRemoveTrack = (trackId: string) => {
    if (playingTrackId === trackId) {
      stopTrackPreview(false);
    }
    const removed = album.tracks.find((t) => t.id === trackId);
    const filtered = renumberTracksPerDisc(album.tracks.filter((t) => t.id !== trackId));
    const syn = synthesizeTocFromTracks(filtered);
    onAlbumChange((prev) => {
      const selDiscs = Array.from(
        new Set(syn.tracksWithLsn.filter((t) => t.selected).map((t) => Math.max(1, t.discNumber || 1)))
      );
      return {
        ...prev,
        discNumber: selDiscs.length === 1 ? selDiscs[0] : prev.discNumber,
        cddbId: syn.cddbId,
        musicbrainzDiscId: syn.musicbrainzDiscId,
        musicbrainzToc: syn.musicbrainzToc,
        trackOffsets: syn.trackOffsets,
        leadoutOffset: syn.leadoutOffset,
        tracks: syn.tracksWithLsn,
      };
    });
    if (removed) {
      onAppendQueryLog(
        `[Trackliste] Titel #${formatIndexNumber(removed.trackNumber, album.tracks.length)} „${removed.title}“ entfernt → TOC aktualisiert (CDDB ${syn.cddbId} · MB-DiscID ${syn.musicbrainzDiscId || '—'}).`
      );
    }
  };

  const handleAddManualTrack = () => {
    const targetDisc = hasDiscConflict
      ? Math.max(1, trackDistinctDiscs[trackDistinctDiscs.length - 1] || album.discNumber || 1)
      : Math.max(1, album.discNumber || 1);
    const sameDiscTracks = album.tracks.filter((t) => (t.discNumber || 1) === targetDisc);
    const nextNum = sameDiscTracks.length + 1;
    const newTitle = `Titel ${String(nextNum).padStart(2, '0')}`;
    const updatedTracks: TrackMetadata[] = [
      ...album.tracks,
      {
        id: `trk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        trackNumber: nextNum,
        discNumber: targetDisc,
        title: newTitle,
        artist: album.artist,
        durationSeconds: 215,
        exactDurationSeconds: 215,
        isrc: '',
        composer: album.composer || '',
        orchestra: album.orchestra || '',
        conductor: album.conductor || '',
        selected: true,
      },
    ];
    const syn = synthesizeTocFromTracks(updatedTracks);
    onAlbumChange((prev) => ({
      ...prev,
      cddbId: syn.cddbId,
      musicbrainzDiscId: syn.musicbrainzDiscId,
      musicbrainzToc: syn.musicbrainzToc,
      trackOffsets: syn.trackOffsets,
      leadoutOffset: syn.leadoutOffset,
      tracks: syn.tracksWithLsn,
    }));
    onAppendQueryLog(
      `[Trackliste] Neuer Titel #${String(nextNum).padStart(2, '0')} (CD ${targetDisc}) „${newTitle}“ angelegt → TOC aktualisiert (CDDB ${syn.cddbId} · MB-DiscID ${syn.musicbrainzDiscId}).`
    );
  };

  const extractFilesFromDataTransfer = async (dt: DataTransfer): Promise<File[]> => {
    const items = Array.from(dt.items || []);
    const entries = items
      .map((item) =>
        typeof (item as DataTransferItem & { webkitGetAsEntry?: () => any }).webkitGetAsEntry === 'function'
          ? (item as DataTransferItem & { webkitGetAsEntry: () => any }).webkitGetAsEntry()
          : null
      )
      .filter(Boolean);

    if (entries.length > 0) {
      const collected: File[] = [];
      const readAllDirectoryEntries = (reader: any): Promise<any[]> =>
        new Promise((resolve) => {
          const all: any[] = [];
          const readBatch = () => {
            reader.readEntries(
              (batch: any[]) => {
                if (!batch || batch.length === 0) {
                  resolve(all);
                } else {
                  all.push(...batch);
                  readBatch();
                }
              },
              () => resolve(all)
            );
          };
          readBatch();
        });

      const traverseEntry = async (entry: any, prefix: string): Promise<void> => {
        if (!entry) return;
        if (entry.isFile) {
          await new Promise<void>((resolve) => {
            entry.file(
              (file: File) => {
                const relPath = prefix ? `${prefix}/${file.name}` : file.name;
                if (!(file as File & { webkitRelativePath?: string }).webkitRelativePath) {
                  try {
                    Object.defineProperty(file, 'webkitRelativePath', {
                      value: relPath,
                      configurable: true,
                    });
                  } catch {
                    // ignore non-configurable
                  }
                }
                collected.push(file);
                resolve();
              },
              () => resolve()
            );
          });
        } else if (entry.isDirectory) {
          const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
          const reader = entry.createReader();
          const children = await readAllDirectoryEntries(reader);
          for (const child of children) {
            await traverseEntry(child, nextPrefix);
          }
        }
      };

      for (const entry of entries) {
        await traverseEntry(entry, '');
      }
      if (collected.length > 0) {
        return collected;
      }
    }

    return Array.from(dt.files || []);
  };

  const handleApplyAlbumFieldToSelectedTracks = (
    albumField: keyof AlbumMetadata,
    trackField: keyof TrackMetadata,
    label: string,
    normalizePeople = false
  ) => {
    const raw = String(album[albumField] ?? '');
    const cleanVal = normalizePeople ? normalizeMultiArtist(raw) : raw.trim();
    const targetCount = album.tracks.filter((t) => t.selected).length;
    if (targetCount === 0) {
      onAppendQueryLog(
        `[Metadaten] Keine Titel ausgewählt – bitte mindestens einen Track markieren, auf den „${label}“ übertragen werden soll.`
      );
      return;
    }
    onAlbumChange((prev) => ({
      ...prev,
      [albumField]: cleanVal,
      tracks: prev.tracks.map((t) => {
        if (!t.selected) return t;
        const updated: TrackMetadata = { ...t, [trackField]: cleanVal };
        if (trackField === 'genre' && (t.hasShazamAlternative || t.hasMbAlternative)) {
          const activeVar = t.activeMetadataVariant || (t.hasMbAlternative ? 'musicbrainz' : 'shazam');
          if (activeVar === 'original') updated.originalGenre = cleanVal;
          else if (activeVar === 'musicbrainz') updated.mbGenre = cleanVal;
          else updated.shazamGenre = cleanVal;
        }
        return updated;
      }),
    }));
    onAppendQueryLog(
      `[Metadaten] ${label} „${cleanVal || '—'}“ auf ${targetCount} aktiv markierte Titel in der Titelliste übertragen.`
    );
  };

  const handleApplyArtistToAll = () =>
    handleApplyAlbumFieldToSelectedTracks('artist', 'artist', 'Künstler', true);

  const handleApplyGenreToAll = () =>
    handleApplyAlbumFieldToSelectedTracks('genre', 'genre', 'Genre', false);

  const handleApplyComposerToAll = () =>
    handleApplyAlbumFieldToSelectedTracks('composer', 'composer', 'Komponist', true);

  const handleApplyOrchestraToAll = () =>
    handleApplyAlbumFieldToSelectedTracks('orchestra', 'orchestra', 'Orchester', true);

  const handleApplyConductorToAll = () =>
    handleApplyAlbumFieldToSelectedTracks('conductor', 'conductor', 'Dirigent', true);

  const handleApplyTitleCase = () => {
    if (album.tracks.length > 0 && selectedCount === 0) {
      onAppendQueryLog(
        '[Metadaten] Keine Titel ausgewählt – bitte mindestens einen Titel in der Liste auswählen.'
      );
      return;
    }
    const formatTitle = (val: string) => {
      const tc = toGermanTitleCase(val);
      return settings.convertRomanNumerals !== false ? convertRomanNumeralsInTitle(tc) : tc;
    };
    const applyAlbumTitle = album.tracks.length === 0 || allSelected;
    onAlbumChange((prev) => ({
      ...prev,
      title: applyAlbumTitle ? formatTitle(prev.title) : prev.title,
      tracks: prev.tracks.map((t) =>
        t.selected ? { ...t, title: formatTitle(t.title) } : t
      ),
    }));
    onAppendQueryLog(
      applyAlbumTitle
        ? `[Metadaten] Groß-/Kleinschreibung (Title Case) auf Album „${formatTitle(album.title)}“ und ${selectedCount} ausgewählte(n) Titel angewendet.`
        : `[Metadaten] Groß-/Kleinschreibung (Title Case) auf ${selectedCount} ausgewählte(n) Titel angewendet.`
    );
  };

  const handleSplitArtists = () => {
    if (album.tracks.length > 0 && selectedCount === 0) {
      onAppendQueryLog(
        '[Interpretensplitter] Keine Titel ausgewählt – bitte mindestens einen Titel in der Liste auswählen.'
      );
      return;
    }
    const result = splitArtistsAndExtractFromTitle(album, true);
    onAlbumChange(result.album);
    if (result.changes.length === 0) {
      onAppendQueryLog(
        '[Interpretensplitter] Keine verketteten Interpreten oder Feature-Zusätze in den ausgewählten Titeln gefunden.'
      );
      return;
    }
    onAppendQueryLog(
      `[Interpretensplitter] ${result.changes.length} Eintrag/Einträge aufgesplittet bzw. aus ausgewählten Titeln ins Interpretenfeld übernommen (; getrennt):`
    );
    for (const ch of result.changes) {
      onAppendQueryLog(`[Interpretensplitter] ${ch.scope}: ${ch.detail}`);
    }
  };

  const handleToggleAllTracks = (checked: boolean) => {
    onAlbumChange((prev) => {
      const nextTracks = prev.tracks.map((t) => ({ ...t, selected: checked }));
      const selDiscs = checked
        ? Array.from(new Set(nextTracks.map((t) => Math.max(1, t.discNumber || 1))))
        : [];
      return {
        ...prev,
        discNumber: selDiscs.length === 1 ? selDiscs[0] : prev.discNumber,
        tracks: nextTracks,
      };
    });
    onAppendQueryLog(
      `[Auswahl] Alle ${album.tracks.length} Titel ${checked ? 'ausgewählt' : 'abgewählt'}.`
    );
  };

  const handleTrackReorderDrop = (targetIdx: number) => {
    if (draggedTrackIdx === null || draggedTrackIdx === targetIdx) {
      setDraggedTrackIdx(null);
      setDragTargetIdx(null);
      return;
    }
    const movedTrack = album.tracks[draggedTrackIdx];
    const updated = [...album.tracks];
    const [moved] = updated.splice(draggedTrackIdx, 1);
    updated.splice(targetIdx, 0, moved);
    const syn = synthesizeTocFromTracks(renumberTracksPerDisc(updated));

    onAlbumChange((prev) => ({
      ...prev,
      cddbId: syn.cddbId,
      musicbrainzDiscId: syn.musicbrainzDiscId,
      musicbrainzToc: syn.musicbrainzToc,
      trackOffsets: syn.trackOffsets,
      leadoutOffset: syn.leadoutOffset,
      tracks: syn.tracksWithLsn,
    }));
    if (movedTrack) {
      onAppendQueryLog(
        `[Reihenfolge] Titel „${movedTrack.title}“ von Position ${draggedTrackIdx + 1} auf Position ${targetIdx + 1} verschoben → virtuelle TOC neu berechnet: CDDB-ID=${syn.cddbId}, MB-DiscID=${syn.musicbrainzDiscId}.`
      );
    }
    setDraggedTrackIdx(null);
    setDragTargetIdx(null);
  };

  const handleResetDemoDisc = () => {
    const demoTracksRaw: TrackMetadata[] = [
      { id: 'kw-1', trackNumber: 1, title: 'Computerwelt', artist: 'Kraftwerk', durationSeconds: 305, exactDurationSeconds: 305, isrc: 'DEAE68100101', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
      { id: 'kw-2', trackNumber: 2, title: 'Taschenrechner', artist: 'Kraftwerk', durationSeconds: 304, exactDurationSeconds: 304, isrc: 'DEAE68100102', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
      { id: 'kw-3', trackNumber: 3, title: 'Nummern', artist: 'Kraftwerk', durationSeconds: 199, exactDurationSeconds: 199, isrc: 'DEAE68100103', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
      { id: 'kw-4', trackNumber: 4, title: 'Computerwelt 2', artist: 'Kraftwerk', durationSeconds: 201, exactDurationSeconds: 201, isrc: 'DEAE68100104', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
      { id: 'kw-5', trackNumber: 5, title: 'Computerliebe', artist: 'Kraftwerk', durationSeconds: 435, exactDurationSeconds: 435, isrc: 'DEAE68100105', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
      { id: 'kw-6', trackNumber: 6, title: 'Heimcomputer', artist: 'Kraftwerk', durationSeconds: 377, exactDurationSeconds: 377, isrc: 'DEAE68100106', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
      { id: 'kw-7', trackNumber: 7, title: 'It’s More Fun to Compute', artist: 'Kraftwerk', durationSeconds: 253, exactDurationSeconds: 253, isrc: 'DEAE68100107', composer: 'Hütter / Schneider / Bartos', metadataSource: 'MusicBrainz', selected: true },
    ];
    const syn = synthesizeTocFromTracks(demoTracksRaw);
    onAlbumChange({
      title: 'Computerwelt',
      artist: 'Kraftwerk',
      albumArtist: 'Kraftwerk',
      year: '1981',
      genre: 'Electro; Electronic; Synth-Pop; Avant-Garde',
      label: 'Kling Klang',
      discNumber: 1,
      totalDiscs: 1,
      cddbId: syn.cddbId,
      musicbrainzDiscId: syn.musicbrainzDiscId,
      musicbrainzToc: syn.musicbrainzToc,
      trackOffsets: syn.trackOffsets,
      leadoutOffset: syn.leadoutOffset,
      musicbrainzReleaseId: '75678f27-51e0-4802-a367-e7a1f86fc7d3',
      metadataSource: 'MusicBrainz',
      coverArtUrl: '/api/coverart/75678f27-51e0-4802-a367-e7a1f86fc7d3',
      coverArtSource: 'Cover Art Archive (MusicBrainz)',
      tracks: syn.tracksWithLsn,
    });
    setCoverImgFailed(false);
    onAppendQueryLog(
      `[CD-Leser] Audio-CD TOC aus ${devicePath} eingelesen (CDDB-DiscID ${syn.cddbId} · MB-DiscID ${syn.musicbrainzDiscId} · 7 Titel).`
    );
    return syn;
  };

  const enabledCoverProviderIds = normalizeCoverProviders(settings.coverProviders);
  const activeCoverProviderSummary =
    enabledCoverProviderIds.length === 0
      ? 'Keine Cover-Bilddatenbank aktiviert'
      : COVER_PROVIDER_OPTIONS.filter((o) => enabledCoverProviderIds.includes(o.id))
          .map((o) => o.label)
          .join(' · ');

  const moduleMeta =
    moduleMode === 'cover_only'
      ? {
          numberLabel: '01. Modul',
          title: 'Coverbild beziehen',
          subtitle:
            'Online-Coverbildsuche über alle aktivierten Bilddatenbanken (MusicBrainz, Deezer, TheAudioDB, Bandcamp, iTunes, Discogs, Amazon), SANE-Scanner, Zuschneiden & Speichern',
          icon: 'cover_image' as const,
        }
      : moduleMode === 'album_tag'
      ? {
          numberLabel: '03. Modul',
          title: 'Album Taggen',
          subtitle:
            'Lokale Album-Ordner importieren, über virtuelle TOC & Shazam identifizieren und offizielle MusicBrainz-Picard-Tags direkt in Dateien schreiben',
          icon: 'module_tag' as const,
        }
      : {
          numberLabel: '02. Modul',
          title: 'CD-Rippen',
          subtitle:
            'Optisches Laufwerk mit cdparanoia auslesen, Online-Metadaten & Cover abrufen, EBU-R128 Normalisierung und FLAC/MP3-Export',
          icon: 'optical_drive' as const,
        };

  const renderCoverCandidatesTableSection = (inlineMode: boolean) => (
    <>
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#E1E4E8] dark:border-[#343A40] flex flex-wrap items-center justify-between gap-3 bg-[#F8F9FA] dark:bg-[#1C1F23]/70 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <SystemIcon name="cover_image" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0" />
          <div className="min-w-0">
            <h2
              id={inlineMode ? 'cover-picker-inline-title' : 'cover-picker-modal-title'}
              className="text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate"
            >
              Online-Cover-Auswahl — {coverCandidates.length} Treffer aus allen aktivierten Quellen
            </h2>
            <p
              className="text-[11px] text-[#57606A] dark:text-[#8B949E] truncate"
              title={activeCoverProviderSummary}
            >
              Abgefragte Quellen ({enabledCoverProviderIds.length}): {activeCoverProviderSummary} — Klick auf Vorschaubild öffnet Großansicht
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={isFetchingCover}
            onClick={() => onFetchCoverArt(inlineMode ? searchQuery : undefined)}
            className="px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 cursor-pointer"
          >
            {isFetchingCover ? 'Suche läuft...' : 'Erneut abfragen'}
          </button>
          {!inlineMode && (
            <button
              type="button"
              onClick={onCloseCoverPicker}
              className="px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] cursor-pointer"
            >
              Schließen
            </button>
          )}
        </div>
      </div>

      {/* Tabellarische Trefferliste */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-[#F8F9FA] dark:bg-[#1C1F23] border-b border-[#E1E4E8] dark:border-[#343A40] text-[11px] font-semibold uppercase tracking-wide text-[#57606A] dark:text-[#8B949E]">
            <tr>
              <th className="py-2.5 px-3 w-24">Vorschau</th>
              <th className="py-2.5 px-3 w-36">Provider</th>
              <th className="py-2.5 px-3">Album &amp; Release-Details</th>
              <th className="py-2.5 px-3 w-40">Auflösung &amp; Größe</th>
              <th className="py-2.5 px-3 w-20">Format</th>
              <th className="py-2.5 px-3 w-32 text-right">Aktion</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E1E4E8] dark:divide-[#343A40]">
            {coverCandidates.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-10 px-4 text-center text-xs text-[#57606A] dark:text-[#8B949E]">
                  {isFetchingCover
                    ? `Frage ${enabledCoverProviderIds.length} aktivierte Bilddatenbanken parallel nach Coverbildern ab...`
                    : 'Noch keine Cover-Treffer geladen. Geben Sie oben in der Suchleiste Album, Künstler, Barcode oder Discogs-Code (z. B. [r524030]) ein oder klicken Sie links in der Cover-Toolbar auf die Lupe.'}
                </td>
              </tr>
            ) : (
              coverCandidates.map((cand, idx) => {
                const dim = loadedCoverDims[cand.id];
                const w = cand.width || dim?.w;
                const h = cand.height || dim?.h;
                return (
                  <tr
                    key={cand.id}
                    className="hover:bg-[#F4F5F6]/70 dark:hover:bg-[#1C1F23]/60 transition-colors"
                  >
                    <td className="py-2.5 px-3 align-middle">
                      <button
                        type="button"
                        onClick={() => setLightboxIndex(idx)}
                        title="Klicken für Großansicht"
                        className="group relative w-16 h-16 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#111315]/5 dark:bg-black/30 overflow-hidden flex items-center justify-center cursor-zoom-in focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                      >
                        <img
                          src={cand.thumbnailUrl || cand.imageUrl}
                          alt={`${cand.providerLabel}: ${cand.title}`}
                          loading="lazy"
                          onLoad={(e) => {
                            const nw = e.currentTarget.naturalWidth;
                            const nh = e.currentTarget.naturalHeight;
                            if (nw > 0 && nh > 0 && (!cand.width || !cand.height)) {
                              setLoadedCoverDims((prev) =>
                                prev[cand.id] ? prev : { ...prev, [cand.id]: { w: nw, h: nh } }
                              );
                            }
                          }}
                          className="w-full h-full object-contain"
                        />
                        <span className="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white">
                          <ZoomIn className="w-5 h-5" />
                        </span>
                      </button>
                    </td>
                    <td className="py-2.5 px-3 align-middle">
                      <div className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-[#5BA632]/12 text-[#2E6B14] dark:text-[#9BE270] border border-[#5BA632]/30">
                        {cand.providerLabel}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 align-middle">
                      <div className="font-semibold text-[#1F2328] dark:text-[#EAEEF2] leading-snug">
                        {cand.title || 'Unbekanntes Album'}
                      </div>
                      <div className="text-[#57606A] dark:text-[#8B949E] mt-0.5">
                        {cand.artist || 'Unbekannter Künstler'}
                        {cand.date ? ` · ${cand.date}` : ''}
                      </div>
                      {cand.details && (
                        <div className="text-[11px] text-[#656D76] dark:text-[#7D8590] mt-0.5 font-mono">
                          {cand.details}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 px-3 align-middle font-mono text-[11px] text-[#1F2328] dark:text-[#EAEEF2]">
                      <div>{w && h ? `${w} × ${h} px` : '—'}</div>
                      <div className="text-[#57606A] dark:text-[#8B949E]">
                        {cand.sizeBytes ? formatCoverByteSize(cand.sizeBytes) : '—'}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 align-middle font-mono text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      {cand.format || 'JPEG'}
                    </td>
                    <td className="py-2.5 px-3 align-middle text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setLightboxIndex(idx)}
                          title="Vorschaubild in groß anzeigen"
                          className="p-1.5 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] cursor-pointer"
                        >
                          <ZoomIn className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={isApplyingCoverCandidate}
                          onClick={() => onSelectCoverCandidate(cand)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Übernehmen</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );

  return (
    <div className="space-y-4">
      {onBackToHome && (
        <ModulePageHeaderBar
          moduleNumber={moduleMeta.numberLabel}
          title={moduleMeta.title}
          subtitle={moduleMeta.subtitle}
          icon={moduleMeta.icon}
          onBackToHome={onBackToHome}
          disabled={isBatchActivelyRunning}
          rightSlotClassName="w-full md:w-1/2 md:max-w-[50vw] shrink-0"
          rightSlot={
            <fieldset
              disabled={isBatchActivelyRunning}
              className={`min-w-0 block transition-opacity ${
                isBatchActivelyRunning ? 'opacity-60' : ''
              }`}
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (moduleMode === 'cover_only') {
                    setCoverImgFailed(false);
                    onFetchCoverArt(searchQuery);
                  } else {
                    onSearchMusicBrainz(searchQuery);
                  }
                }}
                className="flex flex-wrap sm:flex-nowrap items-center gap-2"
              >
                <div className="relative flex-1 min-w-[200px]">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#656D76]">
                    <SystemIcon name="search_online" className="w-4 h-4" />
                  </span>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => onSearchQueryChange(e.target.value)}
                    placeholder={
                      moduleMode === 'cover_only'
                        ? 'Coverbild suchen: Album, Künstler, Discogs-Code ([r524030]), Barcode, ASIN oder MBID...'
                        : 'Album, Künstler, Discogs-Code ([r524030]), Barcode (EAN/UPC) oder CDDB-DiscID suchen...'
                    }
                    className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                  />
                </div>
                {moduleMode !== 'album_tag' && (
                  <button
                    type="button"
                    onClick={() => {
                      onAppendQueryLog(
                        '[Barcode/QR-Scanner] Dialog zum Einlesen eines Barcodes (EAN/UPC) oder QR-Codes per Webcam geöffnet.'
                      );
                      setIsBarcodeModalOpen(true);
                    }}
                    title="Barcode (EAN-13, EAN-8, UPC-A) oder QR-Code mit der Webcam einlesen und suchen"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <SystemIcon name="barcode_qr" className="w-3.5 h-3.5 text-[#5BA632] dark:text-[#69B53F]" />
                    <span>Barcode / QR</span>
                  </button>
                )}
                <button
                  type="submit"
                  disabled={
                    moduleMode === 'cover_only'
                      ? isFetchingCover
                      : isSearching || isRetryingBackoff || !searchQuery.trim()
                  }
                  className="px-3 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {moduleMode === 'cover_only'
                    ? isFetchingCover
                      ? 'Suche läuft...'
                      : 'Onlinedatenbanken abfragen'
                    : isSearching
                    ? 'Suche läuft...'
                    : 'Onlinedatenbanken abfragen'}
                </button>
                {moduleMode === 'cover_only' && isFetchingCover && onCancelFetchCoverArt && (
                  <button
                    type="button"
                    onClick={onCancelFetchCoverArt}
                    title="Laufende Coverbild-Suche abbrechen"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded border border-[#DC2626] bg-[#DC2626] hover:bg-[#B91C1C] text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <SystemIcon name="stop_batch" className="w-3.5 h-3.5" />
                    <span>Abbrechen</span>
                  </button>
                )}
                {moduleMode !== 'cover_only' && (
                  <button
                    type="button"
                    onClick={onRetryWithBackoff}
                    disabled={isSearching || isLoadingRelease || isRetryingBackoff}
                    title={
                      moduleMode === 'album_tag'
                        ? 'Onlinedatenbanken (MusicBrainz, Discogs, CDDB/GnuDB) für das geladene Album abfragen'
                        : 'Vorherige Metadaten-Abfrage automatisch mit exponentiellem Backoff wiederholen (z. B. nach HTTP 503 Rate-Limit, ohne das Album neu zu laden)'
                    }
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <SystemIcon name="refresh_disc" className="w-3.5 h-3.5 text-[#5BA632] dark:text-[#69B53F]" />
                    <span>
                      {isRetryingBackoff
                        ? `Backoff (${retryAttempt}/${retryMaxAttempts})...`
                        : moduleMode === 'album_tag'
                        ? 'Onlinedatenbanken abfragen'
                        : 'Erneut versuchen'}
                    </span>
                  </button>
                )}
                {moduleMode !== 'cover_only' && onEnrichTrackGenres && (
                  <button
                    type="button"
                    onClick={onEnrichTrackGenres}
                    disabled={
                      isEnrichingGenres ||
                      isSearching ||
                      isLoadingRelease ||
                      album.tracks.length === 0
                    }
                    title="Reichert fehlende oder zu allgemeine Song-Genres aus MusicBrainz Release-Group-Pressungen, Discogs Styles & Last.fm an"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {isEnrichingGenres ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[#5BA632] dark:text-[#69B53F]" />
                    ) : (
                      <SystemIcon name="module_tag" className="w-3.5 h-3.5 text-[#5BA632] dark:text-[#69B53F]" />
                    )}
                    <span>
                      {isEnrichingGenres ? 'Genres werden angereichert...' : 'Track-Genres anreichern'}
                    </span>
                  </button>
                )}
              </form>
            </fieldset>
          }
        />
      )}

      <div
        ref={workbenchSplitRef}
        className={
          moduleMode === 'cover_only'
            ? 'grid grid-cols-1 lg:grid-cols-[30%_1fr] gap-6 items-start'
            : 'flex flex-col lg:flex-row items-stretch gap-4 lg:gap-0'
        }
      >
      {/* Linke GTK-Sidebar: Cover-Art (Drag & Drop), Album-Metadaten, Export-Profil (in Modul 2 & 3 ein- und ausklappbar) */}
      <aside
        aria-disabled={isBatchActivelyRunning}
        className={`bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg transition-opacity flex flex-col ${
          moduleMode !== 'cover_only'
            ? isLeftColCollapsedEffective
              ? 'w-full lg:w-10 lg:shrink-0 min-w-0'
              : 'w-full lg:w-[var(--wb-left-w,400px)] lg:min-w-[400px] lg:shrink-0 min-w-0'
            : 'p-4'
        } ${isBatchActivelyRunning ? 'opacity-60 pointer-events-none select-none' : ''}`}
      >
        {isLeftColCollapsedEffective ? (
          <button
            type="button"
            onClick={() => handleSetLeftColumnCollapsed(false)}
            title={
              isAlbumPreviewMode
                ? 'Linke Spalte (Album-Vorschau) ausklappen'
                : 'Linke Spalte (Album & Cover) ausklappen'
            }
            aria-label={
              isAlbumPreviewMode
                ? 'Linke Spalte (Album-Vorschau) ausklappen'
                : 'Linke Spalte (Album & Cover) ausklappen'
            }
            className="w-full h-full py-3 px-2 lg:px-0 lg:min-h-[320px] flex lg:flex-col items-center justify-center lg:justify-start gap-2.5 text-[#57606A] dark:text-[#8B949E] hover:text-[#1F2328] dark:hover:text-[#EAEEF2] hover:bg-[#F8F9FA] dark:hover:bg-[#2D333B]/60 rounded-lg transition-colors cursor-pointer"
          >
            <ChevronRight className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0" />
            <span className="text-xs font-semibold tracking-wide lg:[writing-mode:vertical-rl] lg:rotate-180 select-none">
              {isAlbumPreviewMode ? 'Album-Vorschau' : 'Album & Cover'}
            </span>
          </button>
        ) : (
          <>
            {moduleMode !== 'cover_only' && (
              <div className="px-2.5 py-2 border-b border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 flex items-center justify-between gap-2 rounded-t-lg">
                <button
                  type="button"
                  onClick={() => handleSetLeftColumnCollapsed(true)}
                  title={
                    isAlbumPreviewMode
                      ? 'Linke Spalte (Album-Vorschau) einklappen'
                      : 'Linke Spalte (Album & Cover) einklappen'
                  }
                  aria-label={
                    isAlbumPreviewMode
                      ? 'Linke Spalte (Album-Vorschau) einklappen'
                      : 'Linke Spalte (Album & Cover) einklappen'
                  }
                  className="p-1 rounded border border-transparent text-[#57606A] dark:text-[#8B949E] hover:text-[#1F2328] dark:hover:text-[#EAEEF2] hover:border-[#D0D7DE] dark:hover:border-[#444C56] hover:bg-white dark:hover:bg-[#2D333B] transition-colors shrink-0 cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <div className="flex items-center justify-end gap-1.5 min-w-0">
                  <span className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate">
                    {isAlbumPreviewMode ? 'Album-Vorschau' : 'Album & Cover'}
                  </span>
                  <SystemIcon
                    name="cover_image"
                    className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                  />
                </div>
              </div>
            )}
            {isAlbumPreviewMode ? (
              <div className="relative flex flex-col flex-1 min-w-0 text-xs overflow-hidden rounded-b-lg">
                {((hitTrackPreview && hitTrackPreview.key === selectedHitPreviewKey && hitTrackPreview.loading) ||
                  isLoadingRelease) && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[#1C1F23]/70 dark:bg-[#0D1117]/75 backdrop-blur-[1.5px] text-white px-4 text-center"
                  >
                    <svg
                      viewBox="0 0 52 52"
                      className="w-11 h-11 animate-[spin_2.4s_linear_infinite]"
                      aria-hidden="true"
                    >
                      <circle
                        cx="26"
                        cy="26"
                        r="20"
                        fill="none"
                        stroke="rgba(255,255,255,0.24)"
                        strokeWidth="4"
                      />
                      <path
                        d="M 26 6 A 20 20 0 0 1 44.5 18.4"
                        fill="none"
                        stroke="#10B981"
                        strokeWidth="4"
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="space-y-0.5">
                      <p className="text-xs font-semibold text-white">
                        {isLoadingRelease
                          ? 'Album wird geladen…'
                          : 'Albumdetails werden abgefragt…'}
                      </p>
                      <p className="text-[11px] text-white/80">
                        Cover &amp; Metadaten werden geladen
                      </p>
                    </div>
                  </div>
                )}
                {selectedHitCandidate ? (() => {
                  const preview =
                    hitTrackPreview && hitTrackPreview.key === selectedHitPreviewKey
                      ? hitTrackPreview
                      : null;
                  const srcRaw = (selectedHitCandidate.source || 'musicbrainz').toLowerCase();
                  const srcLabel =
                    srcRaw === 'discogs'
                      ? 'Discogs'
                      : srcRaw === 'cddb'
                      ? 'CDDB / GnuDB'
                      : 'MusicBrainz';
                  const pTitle = preview?.title || selectedHitCandidate.title || 'Unbekanntes Album';
                  const pArtist =
                    preview?.albumArtist ||
                    preview?.artist ||
                    selectedHitCandidate.artist ||
                    'Unbekannter Künstler';
                  const pCover = preview?.coverUrl || '';
                  const pDate = preview?.date || selectedHitCandidate.date || '';
                  const pOrigDate =
                    preview?.originalDate && preview.originalDate !== pDate
                      ? preview.originalDate
                      : '';
                  const pGenre = preview?.genre || '';
                  const pCountry = preview?.country || selectedHitCandidate.country || '';
                  const pLabel = preview?.label || selectedHitCandidate.label || '';
                  const pCatNo = preview?.catalogNumber || selectedHitCandidate.catno || '';
                  const pBarcode = preview?.barcode || selectedHitCandidate.barcode || '';
                  const pFormat = preview?.mediaFormat || '';
                  const pDiscs = preview?.totalDiscs || selectedHitCandidate.mediumCount || 1;
                  const pTrackCount =
                    preview && preview.tracks.length > 0
                      ? preview.tracks.length
                      : selectedHitCandidate.trackCount || 0;
                  const pReleaseType = preview?.releaseType || '';
                  const pStatus = preview?.status || '';
                  const pLanguage = preview?.language || '';
                  const pDisambig = preview?.disambiguation || '';
                  const pAsin = preview?.asin || '';
                  const pSourceId = preview?.sourceId || selectedHitCandidate.id || '';

                  const detailRows: Array<{ label: string; value: string; mono?: boolean }> = [
                    { label: 'Jahr / Datum', value: pDate },
                    { label: 'Erstveröffentlichung', value: pOrigDate },
                    { label: 'Genre', value: pGenre },
                    { label: 'Land', value: pCountry },
                    { label: 'Label', value: pLabel },
                    { label: 'Katalognummer', value: pCatNo, mono: true },
                    { label: 'Barcode / EAN', value: pBarcode, mono: true },
                    { label: 'Medium / Format', value: pFormat },
                    {
                      label: 'Umfang',
                      value:
                        pTrackCount > 0
                          ? `${pDiscs} ${pDiscs === 1 ? 'CD' : 'CDs'} · ${pTrackCount} Titel`
                          : pDiscs > 1
                          ? `${pDiscs} CDs`
                          : '',
                    },
                    { label: 'Release-Typ', value: pReleaseType },
                    { label: 'Status', value: pStatus },
                    { label: 'Sprache / Schrift', value: pLanguage },
                    { label: 'Hinweis', value: pDisambig },
                    { label: 'Amazon ASIN', value: pAsin, mono: true },
                    {
                      label:
                        srcRaw === 'discogs'
                          ? 'Discogs-ID'
                          : srcRaw === 'cddb'
                          ? 'CDDB-ID'
                          : 'MusicBrainz-ID',
                      value: pSourceId,
                      mono: true,
                    },
                  ].filter((row) => Boolean(row.value && row.value.trim()));

                  return (
                    <>
                      <div className="p-3.5 space-y-3.5 flex-1">
                      {/* Cover-Vorschau */}
                      <div className="flex flex-col items-center gap-2">
                        <div className="w-44 h-44 rounded-lg border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] overflow-hidden flex items-center justify-center shadow-sm">
                          {pCover && !previewCoverFailed ? (
                            <img
                              src={pCover}
                              alt={`Cover-Vorschau ${pTitle}`}
                              onError={() => setPreviewCoverFailed(true)}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="flex flex-col items-center justify-center gap-1.5 px-3 text-center text-[#57606A] dark:text-[#8B949E]">
                              <SystemIcon name="cover_image" className="w-8 h-8 opacity-45" />
                              <span className="text-[11px]">
                                {preview?.loading ? 'Cover wird geprüft…' : 'Kein Vorschau-Cover'}
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="w-full text-center space-y-0.5">
                          <div className="text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2] leading-snug break-words">
                            {pTitle}
                          </div>
                          <div className="text-xs text-[#57606A] dark:text-[#8B949E] break-words">
                            {pArtist}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-1.5 text-[11px]">
                          <span className="px-2 py-0.5 rounded border border-[#5BA632]/40 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] font-semibold">
                            {srcLabel}
                          </span>
                          {selectedHitCandidate.method && (
                            <span className="px-2 py-0.5 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#57606A] dark:text-[#8B949E]">
                              {selectedHitCandidate.method}
                            </span>
                          )}
                          {typeof selectedHitCandidate.score === 'number' && selectedHitCandidate.score > 0 && (
                            <span className="px-1.5 py-0.5 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] font-mono text-[#1F2328] dark:text-[#EAEEF2]">
                              {selectedHitCandidate.score}%
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Alle übrigen Albuminformationen */}
                      <div className="rounded-md border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 divide-y divide-[#E1E4E8] dark:divide-[#343A40]">
                        {detailRows.length > 0 ? (
                          detailRows.map((row) => (
                            <div
                              key={row.label}
                              className="px-2.5 py-1.5 flex items-start justify-between gap-3"
                            >
                              <span className="text-[11px] font-medium text-[#57606A] dark:text-[#8B949E] shrink-0">
                                {row.label}:
                              </span>
                              <span
                                className={`text-[11px] text-right text-[#1F2328] dark:text-[#EAEEF2] break-all ${
                                  row.mono ? 'font-mono' : ''
                                }`}
                              >
                                {row.value}
                              </span>
                            </div>
                          ))
                        ) : (
                          <div className="px-2.5 py-3 text-center text-[11px] text-[#57606A] dark:text-[#8B949E]">
                            Keine weiteren Details gemeldet.
                          </div>
                        )}
                      </div>
                      </div>

                      <div className="mt-auto px-3 py-2.5 border-t border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 rounded-b-lg">
                        <p className="text-[11px] text-center text-[#57606A] dark:text-[#8B949E] leading-snug">
                          Vorschau — bestehende Album- &amp; Ordner-Tags bleiben unverändert, bis das Album rechts unten geladen wird.
                        </p>
                      </div>
                    </>
                  );
                })() : (
                  <div className="p-3.5 py-8 flex-1 text-center text-xs text-[#57606A] dark:text-[#8B949E]">
                    Album in der Trefferliste anklicken, um weitere Informationen anzuzeigen.
                  </div>
                )}
              </div>
            ) : (
            <fieldset
              disabled={isBatchActivelyRunning}
              className={`space-y-6 min-w-0 block ${moduleMode !== 'cover_only' ? 'p-4' : ''}`}
            >
        {/* Laufwerk, Lokaler Datei-Import & Systemthema (System / Hell / Dunkel) */}
        <div
          className={`space-y-3 pb-4 border-b border-[#E1E4E8] dark:border-[#343A40] ${
            moduleMode === 'cover_only' ? 'hidden' : ''
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
              <SystemIcon
                name={moduleMode === 'album_tag' ? 'music_folder' : 'optical_drive'}
                className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F]"
              />
              <span>
                {moduleMode === 'album_tag' ? 'Album-Ordner & Ansicht' : 'Optisches Laufwerk & Dateien'}
              </span>
            </div>
            <div
              role="group"
              aria-label="Farbschema wählen"
              className="inline-flex items-center p-0.5 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F4F5F6] dark:bg-[#1C1F23]"
            >
              {(
                [
                  { id: 'system', label: 'System' },
                  { id: 'light', label: 'Hell' },
                  { id: 'dark', label: 'Dunkel' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onThemeModeChange(opt.id)}
                  className={`px-1.5 py-0 text-[11px] font-medium rounded transition-colors whitespace-nowrap ${
                    themeMode === opt.id
                      ? 'bg-white dark:bg-[#2D333B] text-[#1F2328] dark:text-[#EAEEF2] shadow-xs'
                      : 'text-[#57606A] dark:text-[#8B949E] hover:text-[#1F2328] dark:hover:text-[#EAEEF2]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            {moduleMode === 'cd_rip' && (
              <div className="flex items-center gap-1.5">
                <select
                  aria-label="Optisches Laufwerk auswählen"
                  value={devicePath}
                  onChange={(e) => {
                    onDevicePathChange(e.target.value);
                    onAppendQueryLog(`[Laufwerk] Optisches Laufwerk gewechselt auf ${e.target.value}.`);
                  }}
                  className="flex-1 min-w-0 px-2 py-1 text-xs font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                >
                  <option value="/dev/cdrom">/dev/cdrom (Standard)</option>
                  <option value="/dev/sr0">/dev/sr0 (SATA BD/DVD)</option>
                  <option value="/dev/sr1">/dev/sr1 (USB-Laufwerk)</option>
                </select>
                <button
                  type="button"
                  disabled={isTogglingTray}
                  onClick={() => void handleToggleCdTray()}
                  aria-label={isTrayOpen ? 'CD-Laufwerk schließen' : 'CD-Laufwerk auswerfen'}
                  title={
                    isTrayOpen
                      ? 'CD-Schlitten schließen (Einfahren)'
                      : 'CD-Schlitten auswerfen (Eject)'
                  }
                  className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border transition-colors shrink-0 cursor-pointer disabled:opacity-50 ${
                    isTrayOpen
                      ? 'border-[#5BA632] bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270] hover:bg-[#5BA632]/25'
                      : 'border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/10'
                  }`}
                >
                  <SystemIcon
                    name={isTrayOpen ? 'close_tray' : 'eject_disc'}
                    className="w-3.5 h-3.5 shrink-0"
                  />
                  <span>{isTrayOpen ? 'Schließen' : 'Auswerfen'}</span>
                </button>
              </div>
            )}

            {/* Modul-spezifische Aktionszeile: Modul 2 = "CD einlesen und Abfragen", Modul 3 = "Album-Ordner importieren" */}
            {moduleMode === 'cd_rip' ? (
              <button
                type="button"
                disabled={isBatchActivelyRunning || isSearching}
                onClick={() => {
                  if (album.tracks.length > 0) {
                    onLookupByToc();
                  } else {
                    const syn = handleResetDemoDisc();
                    onLookupByToc(syn);
                  }
                }}
                title="Audio-CD TOC einlesen und alle Online-Datenbanken abfragen (MusicBrainz + CDDB/GnuDB + Discogs) – zeigt Trefferliste zur Auswahl"
                className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-1 text-[11px] font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <SystemIcon name="refresh_disc" className="w-3.5 h-3.5 text-[#5BA632] dark:text-[#69B53F] shrink-0" />
                <span className="truncate">CD einlesen und Abfragen</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  stopTrackPreview(false);
                  setCoverImgFailed(false);
                  onResetAllFields();
                  onAppendQueryLog(
                    `[Ordner-Import] Alle Felder & Stapelverarbeitung zurückgesetzt · Verzeichnis-Auswahl geöffnet (Letzter Ort: ${
                      settings.lastImportFolder || '~/Musik'
                    }).`
                  );
                  const picked = await pickDirectoryWithPersistence();
                  if (picked.status === 'picked') {
                    onSettingsChange((prev) => ({
                      ...prev,
                      lastImportFolder: picked.folderName,
                    }));
                    onImportAudioFiles(picked.files, {
                      replaceExisting: importReplaceExisting,
                      autoLookupToc: importAutoLookupToc,
                    });
                  } else if (picked.status === 'fallback_input') {
                    importTocAudioInputRef.current?.click();
                  } else {
                    onAppendQueryLog('[Ordner-Import] Verzeichnisauswahl abgebrochen.');
                  }
                }}
                title="Setzt zuvor alle Felder und die Stapelverarbeitung zurück und importiert ein komplettes Album-Verzeichnis (inkl. Audiodateien, Cover & CUE-Sheet)"
                className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white transition-colors whitespace-nowrap cursor-pointer"
              >
                <SystemIcon name="music_folder" className="w-3.5 h-3.5 text-white shrink-0" />
                <span className="truncate">Album-Ordner importieren</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                stopTrackPreview(false);
                setCoverImgFailed(false);
                onResetAllFields();
              }}
              title="Alle Metadaten-Felder, das Vorschaubild und die Titelliste vollständig zurücksetzen"
              className="w-full inline-flex items-center justify-center gap-1.5 px-1.5 py-1 text-[11px] font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#57606A] dark:text-[#8B949E] hover:text-[#DC2626] dark:hover:text-[#F87171] hover:border-[#DC2626]/50 hover:bg-[#DC2626]/5 transition-colors"
            >
              <SystemIcon name="clear_list" className="w-3.5 h-3.5 shrink-0" />
              <span>Alle Felder zurücksetzen</span>
            </button>

            <input
              ref={importTocAudioInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  stopTrackPreview(false);
                  setCoverImgFailed(false);
                  onImportAudioFiles(e.target.files, {
                    replaceExisting: importReplaceExisting,
                    autoLookupToc: importAutoLookupToc,
                  });
                  e.target.value = '';
                }
              }}
            />

            {moduleMode === 'album_tag' && (
              <div className="p-2 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 space-y-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2 pb-1 border-b border-[#E1E4E8] dark:border-[#343A40]">
                  <span className="text-[#57606A] dark:text-[#8B949E] shrink-0">Letzter Ordner:</span>
                  <span
                    className="font-mono text-[#1F2328] dark:text-[#EAEEF2] truncate"
                    title={settings.lastImportFolder || '~/Musik'}
                  >
                    {settings.lastImportFolder || '~/Musik'}
                  </span>
                </div>
                <label className="flex items-center gap-2 text-[#57606A] dark:text-[#8B949E] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={importReplaceExisting}
                    onChange={(e) => setImportReplaceExisting(e.target.checked)}
                    className="accent-[#5BA632] rounded"
                  />
                  <span>Beim Ordner-Import bestehendes Album ersetzen</span>
                </label>
                <label className="flex items-center gap-2 text-[#57606A] dark:text-[#8B949E] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={importAutoLookupToc}
                    onChange={(e) => setImportAutoLookupToc(e.target.checked)}
                    className="accent-[#5BA632] rounded"
                  />
                  <span>TOC + Cover aus Ordner lesen &amp; sofort abfragen</span>
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Album-Cover Fieldset mit nicht-schwebender vertikaler Icon-Toolbar links bündig am inneren Rand */}
        <fieldset className="rounded-md border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] overflow-visible">
          <legend className="ml-2.5 px-1.5 text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
            Album-Cover
          </legend>

          {/* Horizontale Einheit: Links bündige vertikale Icon-Toolbar | Rechts das quadratische Vorschaubild */}
          <div className="flex items-stretch border-t border-b border-[#E1E4E8] dark:border-[#343A40]">
            {/* Nicht-schwebende vertikale Icon-Toolbar direkt am linken inneren Rand des Fieldsets */}
            {(() => {
              const coverTbBtnSize = 'w-7 h-7';
              const coverTbIconSize = 'w-4 h-4';
              return (
            <div
              role="toolbar"
              aria-label="Cover-Provider und Bildwerkzeuge"
              className="flex flex-col items-center justify-start gap-2 p-1.5 bg-[#F8F9FA] dark:bg-[#1C1F23] border-r border-[#D0D7DE] dark:border-[#444C56] shrink-0"
            >
              {moduleMode !== 'cover_only' && (
                <>
                  <div className="relative group">
                    <button
                      type="button"
                      disabled={isFetchingCover}
                      aria-label="Cover online suchen (aktivierte Bilddatenbanken abfragen)"
                      title={`Cover online suchen (${enabledCoverProviderIds.length} aktive Quellen: ${activeCoverProviderSummary})`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCoverImgFailed(false);
                        onAppendQueryLog(
                          `[Cover-Toolbar] Online-Cover-Suche gestartet – frage ${enabledCoverProviderIds.length} aktivierte Quellen ab...`
                        );
                        onFetchCoverArt();
                      }}
                      className={`${coverTbBtnSize} flex items-center justify-center rounded border transition-colors cursor-pointer disabled:opacity-45 ${
                        isFetchingCover
                          ? 'border-[#5BA632] bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270]'
                          : 'border-transparent text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B]'
                      }`}
                    >
                      <SystemIcon
                        name={isFetchingCover ? 'refresh_disc' : 'search_online'}
                        className={`${coverTbIconSize} ${isFetchingCover ? 'animate-spin' : ''}`}
                      />
                    </button>
                    <span
                      role="tooltip"
                      className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 z-30 hidden group-hover:block group-focus-within:block whitespace-nowrap rounded bg-[#1F2328] dark:bg-[#0D1117] px-2 py-1 text-[11px] font-medium text-white shadow-lg border border-[#444C56]"
                    >
                      Cover online suchen (Alle Provider abfragen &amp; Treffer auswählen)
                    </span>
                  </div>

                  <div className="h-px w-full bg-[#D0D7DE] dark:bg-[#444C56] my-0.5" />

                  <div className="relative group">
                    <button
                      type="button"
                      aria-label="Bilddatei von Festplatte laden"
                      title="Bilddatei von Festplatte laden (Originalformat in Vorschau; Konvertierung nach JPG vor dem Einbetten)"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAppendQueryLog('[Cover-Toolbar] Dateiauswahl für lokales Cover-Bild von Festplatte geöffnet.');
                        coverInputRef.current?.click();
                      }}
                      className={`${coverTbBtnSize} flex items-center justify-center rounded border border-transparent text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B] transition-colors cursor-pointer`}
                    >
                      <SystemIcon name="open_file" className={coverTbIconSize} />
                    </button>
                    <span
                      role="tooltip"
                      className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 z-30 hidden group-hover:block group-focus-within:block whitespace-nowrap rounded bg-[#1F2328] dark:bg-[#0D1117] px-2 py-1 text-[11px] font-medium text-white shadow-lg border border-[#444C56]"
                    >
                      Bilddatei von Festplatte laden (Originalformat in Vorschau)
                    </span>
                  </div>
                </>
              )}

              <div className="relative group">
                <button
                  type="button"
                  disabled={isScanningHardware || isFetchingCover}
                  aria-label="CD-Booklet direkt über Scanner einscannen"
                  title={`CD-Booklet sofort mit den Scanner-Einstellungen (${settings.scannerDpi || 300} DPI) einscannen und anschließend zuschneiden`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleHardwareSaneScan();
                  }}
                  className={`${coverTbBtnSize} flex items-center justify-center rounded border transition-colors cursor-pointer disabled:opacity-45 ${
                    isScanningHardware
                      ? 'border-[#5BA632] bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270]'
                      : 'border-transparent text-[#5BA632] dark:text-[#69B53F] hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B]'
                  }`}
                >
                  <SystemIcon name="scanner" className={coverTbIconSize} />
                </button>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 z-30 hidden group-hover:block group-focus-within:block whitespace-nowrap rounded bg-[#1F2328] dark:bg-[#0D1117] px-2 py-1 text-[11px] font-medium text-white shadow-lg border border-[#444C56]"
                >
                  Sofort scannen ({settings.scannerDpi || 300} DPI · Einstellungen im Einstellungsfenster)
                </span>
              </div>

              <div className="h-px w-full bg-[#D0D7DE] dark:bg-[#444C56] my-0.5" />

              <div className="relative group">
                <button
                  type="button"
                  disabled={!album.coverArtUrl}
                  aria-label="Coverbild beschneiden"
                  title={
                    album.coverArtUrl
                      ? 'Coverbild beschneiden (öffnet Vollbild-Modal mit ziehbarem Beschneidungsrahmen)'
                      : 'Coverbild beschneiden (Schere) – bitte zuerst ein Coverbild laden'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenCropModal();
                  }}
                  className={`${coverTbBtnSize} flex items-center justify-center rounded border border-transparent text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  <SystemIcon name="crop_cover" className={coverTbIconSize} />
                </button>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 z-30 hidden group-hover:block group-focus-within:block whitespace-nowrap rounded bg-[#1F2328] dark:bg-[#0D1117] px-2 py-1 text-[11px] font-medium text-white shadow-lg border border-[#444C56]"
                >
                  {album.coverArtUrl
                    ? 'Coverbild beschneiden (Schere)'
                    : 'Coverbild beschneiden (bitte zuerst ein Coverbild laden)'}
                </span>
              </div>

              <div className="relative group">
                <button
                  type="button"
                  disabled={!album.coverArtUrl}
                  aria-label="Coverbild skalieren"
                  title={
                    album.coverArtUrl
                      ? 'Coverbild skalieren (öffnet Modalfenster für quadratische oder freie Skalierung)'
                      : 'Coverbild skalieren – bitte zuerst ein Coverbild laden'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenScaleModal();
                  }}
                  className={`${coverTbBtnSize} flex items-center justify-center rounded border border-transparent text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  <SystemIcon name="scale_cover" className={coverTbIconSize} />
                </button>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 z-30 hidden group-hover:block group-focus-within:block whitespace-nowrap rounded bg-[#1F2328] dark:bg-[#0D1117] px-2 py-1 text-[11px] font-medium text-white shadow-lg border border-[#444C56]"
                >
                  {album.coverArtUrl
                    ? 'Coverbild skalieren (Quadratisch oder freie Maße)'
                    : 'Coverbild skalieren (bitte zuerst ein Coverbild laden)'}
                </span>
              </div>

              <div className="relative group">
                <button
                  type="button"
                  disabled={!album.coverArtUrl}
                  aria-label="Coverbild speichern unter"
                  title={
                    album.coverArtUrl
                      ? 'Coverbild speichern unter... (öffnet den Speichern-unter-Dialog)'
                      : 'Coverbild speichern unter (Diskette) – bitte zuerst ein Coverbild laden'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenSaveCoverDialog();
                  }}
                  className={`${coverTbBtnSize} flex items-center justify-center rounded border border-transparent text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  <SystemIcon name="save_cover" className={coverTbIconSize} />
                </button>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 z-30 hidden group-hover:block group-focus-within:block whitespace-nowrap rounded bg-[#1F2328] dark:bg-[#0D1117] px-2 py-1 text-[11px] font-medium text-white shadow-lg border border-[#444C56]"
                >
                  {album.coverArtUrl
                    ? 'Coverbild speichern unter... (Diskette)'
                    : 'Coverbild speichern unter (bitte zuerst ein Coverbild laden)'}
                </span>
              </div>
            </div>
              );
            })()}

            {/* Vorschaubild rechts neben der bündigen Toolbar */}
            <div
              onDragOver={(e) => {
                if (isBatchActivelyRunning) return;
                e.preventDefault();
                setIsCoverDragOver(true);
              }}
              onDragLeave={() => setIsCoverDragOver(false)}
              onDrop={(e) => {
                if (isBatchActivelyRunning) return;
                e.preventDefault();
                setIsCoverDragOver(false);
                const file = e.dataTransfer.files?.[0];
                if (file && file.type.startsWith('image/')) {
                  setCoverImgFailed(false);
                  onCoverFileDrop(file);
                }
              }}
              onClick={() => {
                if (!isBatchActivelyRunning && !isFetchingCover) coverInputRef.current?.click();
              }}
              role="button"
              tabIndex={isBatchActivelyRunning ? -1 : 0}
              title="Klicken oder Bilddatei per Drag & Drop hierher ziehen, um ein Cover zu laden"
              onKeyDown={(e) => {
                if (isBatchActivelyRunning || isFetchingCover) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  coverInputRef.current?.click();
                }
              }}
              className={`relative aspect-square flex-1 w-full overflow-hidden transition-colors cursor-pointer flex flex-col items-center justify-center text-center ${
                isCoverDragOver
                  ? 'bg-[#5BA632]/15 ring-2 ring-inset ring-[#5BA632]'
                  : 'bg-[#F4F5F6] dark:bg-[#1C1F23] hover:bg-[#EAEEF2]/60 dark:hover:bg-[#22272E]'
              }`}
            >
              {album.coverArtUrl && !coverImgFailed ? (
                <img
                  key={album.coverArtUrl}
                  src={album.coverArtUrl}
                  alt={`Cover für ${album.title || 'Album'}`}
                  referrerPolicy="no-referrer"
                  onLoad={(e) => {
                    const nw = e.currentTarget.naturalWidth;
                    const nh = e.currentTarget.naturalHeight;
                    if (nw > 0 && nh > 0 && (!album.coverArtWidth || !album.coverArtHeight)) {
                      onAlbumChange((prev) => ({
                        ...prev,
                        coverArtWidth: nw,
                        coverArtHeight: nh,
                        coverArtFormat: prev.coverArtFormat || 'JPEG',
                        coverArtOriginalFormat: prev.coverArtOriginalFormat || prev.coverArtFormat || 'JPEG',
                      }));
                    }
                  }}
                  onError={() => setCoverImgFailed(true)}
                  className="w-full h-full object-contain bg-[#111315]/5 dark:bg-black/25"
                />
              ) : (
                <div className="p-6 flex flex-col items-center gap-2.5 text-[#656D76] dark:text-[#8B949E]">
                  <SystemIcon
                    name="cover_image"
                    className={`${moduleMode === 'cover_only' ? 'w-14 h-14' : 'w-8 h-8'} opacity-75`}
                  />
                  <p className="text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                    {album.title || 'Kein Vorschaubild geladen'}
                  </p>
                  <p className="text-[11px] leading-relaxed">
                    Bild per Drag &amp; Drop ablegen oder links ein Werkzeug-Icon wählen
                  </p>
                </div>
              )}

              {/* Noch transparenteres Overlay mit langsamer rotierendem Kreis während laufender Cover-Suche oder laufendem Scanvorgang */}
              {(isFetchingCover || isScanningHardware) && (
                <div
                  role="status"
                  aria-live="polite"
                  onClick={(e) => e.stopPropagation()}
                  className="absolute inset-0 z-20 bg-black/25 dark:bg-black/35 backdrop-blur-[0.5px] flex flex-col items-center justify-center gap-3 p-4 text-white cursor-default"
                >
                  <div
                    aria-label={isScanningHardware ? 'Scanvorgang läuft' : 'Cover-Suche läuft'}
                    className="w-12 h-12 rounded-full border-4 border-white/35 border-t-[#5BA632] animate-[spin_2.4s_linear_infinite] shadow-md"
                  />
                  <div className="space-y-0.5 text-center px-2.5 py-1 rounded bg-black/35">
                    <div className="text-xs font-semibold tracking-wide text-white drop-shadow">
                      {isScanningHardware ? 'Scanvorgang läuft…' : 'Cover-Suche läuft…'}
                    </div>
                    <div className="text-[11px] text-white/90">
                      {isScanningHardware
                        ? `SANE Flachbettscanner (${settings.scannerDpi || 300} DPI)`
                        : `${enabledCoverProviderIds.length} aktive Bilddatenbanken`}
                    </div>
                  </div>
                  {isScanningHardware && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCancelHardwareScan();
                      }}
                      className="mt-1 inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded border border-white/30 bg-[#DC2626] hover:bg-[#B91C1C] text-white shadow transition-colors cursor-pointer"
                    >
                      <SystemIcon name="stop_batch" className="w-3.5 h-3.5" />
                      <span>Scan abbrechen</span>
                    </button>
                  )}
                </div>
              )}

              <input
                ref={coverInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,image/tiff"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setCoverImgFailed(false);
                    onCoverFileDrop(file, `Festplatte (${file.name})`);
                    e.target.value = '';
                  }
                }}
              />
            </div>
          </div>

          {/* Fußbereich im Cover-Fieldset: Quelle + Auflösung, Dateigröße & Format */}
          <div className="p-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-[#57606A] dark:text-[#8B949E] shrink-0">Quelle:</span>
              <span
                className="font-medium text-[#1F2328] dark:text-[#EAEEF2] truncate"
                title={album.coverArtSource || 'Kein Cover geladen'}
              >
                {isFetchingCover ? 'Suche Cover...' : album.coverArtSource || 'Kein Cover geladen'}
              </span>
            </div>

            <div
              aria-label="Vorschaubild-Informationen"
              className="grid grid-cols-3 gap-1.5 px-2.5 py-1.5 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/80 text-[11px]"
            >
              <div className="min-w-0">
                <div className="text-[10px] text-[#57606A] dark:text-[#8B949E]">Auflösung</div>
                <div className="font-mono font-medium text-[#1F2328] dark:text-[#EAEEF2] truncate tabular-nums">
                  {album.coverArtUrl && !coverImgFailed && album.coverArtWidth && album.coverArtHeight
                    ? `${album.coverArtWidth} × ${album.coverArtHeight} px`
                    : '—'}
                </div>
              </div>
              <div className="min-w-0 border-l border-[#E1E4E8] dark:border-[#343A40] pl-2">
                <div className="text-[10px] text-[#57606A] dark:text-[#8B949E]">Dateigröße</div>
                <div className="font-mono font-medium text-[#1F2328] dark:text-[#EAEEF2] truncate tabular-nums">
                  {album.coverArtUrl && !coverImgFailed
                    ? formatCoverByteSize(album.coverArtSizeBytes)
                    : '—'}
                </div>
              </div>
              <div className="min-w-0 border-l border-[#E1E4E8] dark:border-[#343A40] pl-2">
                <div className="text-[10px] text-[#57606A] dark:text-[#8B949E]">Format</div>
                <div
                  className="font-mono font-medium text-[#2E6B14] dark:text-[#9BE270] truncate"
                  title={
                    album.coverArtFormat && album.coverArtFormat !== 'JPEG'
                      ? `Vorschau im Originalformat (${album.coverArtFormat}) – wird erst unmittelbar vor dem Einbetten in die Audiodateien nach JPEG (.jpg) konvertiert`
                      : 'JPEG (.jpg)'
                  }
                >
                  {album.coverArtUrl && !coverImgFailed
                    ? album.coverArtFormat && album.coverArtFormat !== 'JPEG'
                      ? `${album.coverArtFormat} (→ JPG)`
                      : album.coverArtFormat || 'JPEG'
                    : '—'}
                </div>
              </div>
            </div>

            {coverError && (
              <p className="text-xs text-[#DC2626] dark:text-[#F87171] flex items-center gap-1.5">
                <SystemIcon name="status_warn" className="w-3.5 h-3.5 shrink-0" />
                <span>{coverError}</span>
              </p>
            )}
          </div>
        </fieldset>

        {/* Album-Metadaten */}
        <div className={moduleMode === 'cover_only' ? 'hidden' : 'space-y-3'}>
          <h2 className="text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2]">Album-Metadaten</h2>

          <div className="space-y-2.5 text-xs">
            {isLeftFieldVisible('title') && (
              <label className="block space-y-1">
                <span className="text-[#57606A] dark:text-[#8B949E]">Albumtitel</span>
                <input
                  type="text"
                  value={album.title}
                  onChange={(e) => updateAlbumField('title', e.target.value)}
                  onBlur={(e) =>
                    onAppendQueryLog(`[Metadaten] Albumtitel geändert auf „${e.target.value.trim() || '—'}“.`)
                  }
                  className="w-full px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                />
              </label>
            )}

            {isLeftFieldVisible('albumArtist') && (
              <label className="block space-y-1">
                <span className="text-[#57606A] dark:text-[#8B949E]">Album-Interpret (; für mehrere)</span>
                <input
                  type="text"
                  value={album.albumArtist}
                  onChange={(e) => updateAlbumField('albumArtist', e.target.value)}
                  onBlur={(e) => {
                    const norm = normalizeMultiArtist(e.target.value);
                    updateAlbumField('albumArtist', norm);
                    onAppendQueryLog(`[Metadaten] Album-Interpret geändert auf „${norm || '—'}“.`);
                  }}
                  placeholder="z. B. Elton John; George Michael"
                  className="w-full px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                />
              </label>
            )}

            {isLeftFieldVisible('artist') && (
              <div className="space-y-1">
                <span className="block text-[#57606A] dark:text-[#8B949E]">
                  Künstler (Standard für Titel)
                </span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={album.artist}
                    onChange={(e) => updateAlbumField('artist', e.target.value)}
                    onBlur={(e) => {
                      const norm = normalizeMultiArtist(e.target.value);
                      updateAlbumField('artist', norm);
                      onAppendQueryLog(`[Metadaten] Standard-Künstler geändert auf „${norm || '—'}“.`);
                    }}
                    placeholder="feat. / vs. / pres. wird automatisch zu ;"
                    className="min-w-0 flex-1 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                  />
                  <button
                    type="button"
                    disabled={album.tracks.length === 0 || selectedCount === 0}
                    onClick={handleApplyArtistToAll}
                    title="Künstler auf die aktiv markierten Titel in der Titel- und Metadatenspalte übertragen"
                    aria-label="Künstler auf markierte Titel übertragen"
                    className="px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/15 hover:text-[#2E6B14] dark:hover:text-[#9BE270] disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
                  >
                    <SystemIcon name="apply_arrow" className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {(album.isClassical ||
              isLeftFieldVisible('composer') ||
              isLeftFieldVisible('orchestra') ||
              isLeftFieldVisible('conductor')) && (
              <div className="p-2.5 rounded border border-[#5BA632]/40 bg-[#5BA632]/5 dark:bg-[#5BA632]/10 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-[#2E6B14] dark:text-[#9BE270] flex items-center gap-1.5">
                    <SystemIcon name="classical_album" className="w-3.5 h-3.5" />
                    <span>Klassik- &amp; Ensemble-Tags</span>
                  </span>
                  <span className="text-[10px] text-[#57606A] dark:text-[#8B949E]">
                    Pfeil → auf markierte Titel
                  </span>
                </div>

                {(album.isClassical || isLeftFieldVisible('composer')) && (
                  <div className="space-y-1">
                    <span className="block text-[#57606A] dark:text-[#8B949E]">Komponist (; für mehrere)</span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={album.composer || ''}
                        onChange={(e) => updateAlbumField('composer', e.target.value)}
                        onBlur={(e) => {
                          const norm = normalizeMultiArtist(e.target.value);
                          updateAlbumField('composer', norm);
                          onAppendQueryLog(`[Klassikalbum] Komponist geändert auf „${norm || '—'}“.`);
                        }}
                        placeholder="z. B. Ludwig van Beethoven; Mozart (; getrennt)"
                        className="min-w-0 flex-1 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                      />
                      <button
                        type="button"
                        disabled={album.tracks.length === 0 || selectedCount === 0}
                        onClick={handleApplyComposerToAll}
                        title="Komponist den aktiv markierten Titeln in der Titel- und Metadatenspalte zuordnen"
                        aria-label="Komponist markierten Titeln zuordnen"
                        className="px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/15 hover:text-[#2E6B14] dark:hover:text-[#9BE270] disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
                      >
                        <SystemIcon name="apply_arrow" className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {(album.isClassical || isLeftFieldVisible('orchestra')) && (
                  <div className="space-y-1">
                    <span className="block text-[#57606A] dark:text-[#8B949E]">Orchester (; für mehrere)</span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={album.orchestra || ''}
                        onChange={(e) => updateAlbumField('orchestra', e.target.value)}
                        onBlur={(e) => {
                          const norm = normalizeMultiArtist(e.target.value);
                          updateAlbumField('orchestra', norm);
                          onAppendQueryLog(`[Klassikalbum] Orchester geändert auf „${norm || '—'}“.`);
                        }}
                        placeholder="z. B. Berliner Philharmoniker (; getrennt)"
                        className="min-w-0 flex-1 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                      />
                      <button
                        type="button"
                        disabled={album.tracks.length === 0 || selectedCount === 0}
                        onClick={handleApplyOrchestraToAll}
                        title="Orchester den aktiv markierten Titeln in der Titel- und Metadatenspalte zuordnen"
                        aria-label="Orchester markierten Titeln zuordnen"
                        className="px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/15 hover:text-[#2E6B14] dark:hover:text-[#9BE270] disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
                      >
                        <SystemIcon name="apply_arrow" className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {(album.isClassical || isLeftFieldVisible('conductor')) && (
                  <div className="space-y-1">
                    <span className="block text-[#57606A] dark:text-[#8B949E]">Dirigent (; für mehrere)</span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={album.conductor || ''}
                        onChange={(e) => updateAlbumField('conductor', e.target.value)}
                        onBlur={(e) => {
                          const norm = normalizeMultiArtist(e.target.value);
                          updateAlbumField('conductor', norm);
                          onAppendQueryLog(`[Klassikalbum] Dirigent geändert auf „${norm || '—'}“.`);
                        }}
                        placeholder="z. B. Herbert von Karajan (; getrennt)"
                        className="min-w-0 flex-1 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                      />
                      <button
                        type="button"
                        disabled={album.tracks.length === 0 || selectedCount === 0}
                        onClick={handleApplyConductorToAll}
                        title="Dirigent den aktiv markierten Titeln in der Titel- und Metadatenspalte zuordnen"
                        aria-label="Dirigent markierten Titeln zuordnen"
                        className="px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/15 hover:text-[#2E6B14] dark:hover:text-[#9BE270] disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
                      >
                        <SystemIcon name="apply_arrow" className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {isLeftFieldVisible('discNumber') && (
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-[#57606A] dark:text-[#8B949E]">CD-Nr.</span>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={hasDiscConflict ? '' : album.discNumber}
                    placeholder=""
                    title={
                      hasDiscConflict
                        ? `Konflikt: Ausgewählte Titel stammen von mehreren CDs (${selectedDiscNumbers.map((d) => `CD ${d}`).join(', ')})`
                        : 'Laufende CD-Nummer'
                    }
                    onChange={(e) => {
                      const nextDisc = Math.max(1, Number(e.target.value) || 1);
                      const nextTotal = Math.max(album.totalDiscs, nextDisc);
                      onAlbumChange((prev) => ({
                        ...prev,
                        discNumber: nextDisc,
                        totalDiscs: Math.max(prev.totalDiscs, nextDisc),
                        tracks: prev.tracks.some((t) => t.selected)
                          ? prev.tracks.map((t) =>
                              t.selected ? { ...t, discNumber: nextDisc } : t
                            )
                          : prev.tracks,
                      }));
                      onAppendQueryLog(`[Multi-CD] CD-Nummer geändert auf CD ${nextDisc} von ${nextTotal}.`);
                    }}
                    className={`w-full px-2 py-1 font-mono rounded border focus:outline-none focus:ring-2 transition-colors text-[#1F2328] dark:text-[#EAEEF2] ${
                      hasDiscConflict
                        ? 'border-red-300/80 dark:border-red-500/45 bg-red-50/75 dark:bg-red-950/25 focus:ring-red-300'
                        : 'border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] focus:ring-[#5BA632]'
                    }`}
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-[#57606A] dark:text-[#8B949E]">Gesamt-CDs</span>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={album.totalDiscs}
                    onChange={(e) => {
                      const nextTotal = Math.max(1, Number(e.target.value) || 1);
                      const nextDisc = Math.min(album.discNumber, nextTotal);
                      onAlbumChange((prev) => ({
                        ...prev,
                        totalDiscs: nextTotal,
                        discNumber: Math.min(prev.discNumber, nextTotal),
                      }));
                      onAppendQueryLog(`[Multi-CD] Gesamt-CDs geändert auf ${nextTotal} (aktuell CD ${nextDisc}).`);
                    }}
                    className="w-full px-2 py-1 font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                  />
                </label>
              </div>
            )}

            {isMultiDiscAlbum && (
              <div
                className={`p-2.5 rounded border space-y-2 transition-colors ${
                  hasDiscConflict
                    ? 'border-rose-300/50 bg-rose-50/40 dark:border-rose-500/25 dark:bg-rose-950/15'
                    : 'border-[#5BA632]/40 bg-[#5BA632]/10'
                }`}
              >
                <div
                  className={`text-[11px] font-semibold ${
                    hasDiscConflict
                      ? 'text-[#57606A] dark:text-[#9CA3AF]'
                      : 'text-[#2E6B14] dark:text-[#9BE270]'
                  }`}
                >
                  {hasDiscConflict
                    ? `Mehrere CDs ausgewählt (${selectedDiscNumbers.map((d) => `CD ${formatIndexNumber(d, album.totalDiscs)}`).join(' + ')})`
                    : `Multi-CD-Album erkannt (CD ${formatIndexNumber(album.discNumber, album.totalDiscs)} von ${formatIndexNumber(album.totalDiscs, album.totalDiscs)})`}
                </div>
                {((album.discs && album.discs.length > 1) || trackDistinctDiscs.length > 1) && (
                  <div className="flex flex-wrap gap-1.5">
                    {(album.discs && album.discs.length > 1
                      ? album.discs
                      : trackDistinctDiscs.map((pos) => ({
                          position: pos,
                          title: '',
                          format: album.mediaFormat || 'CD',
                          trackCount: album.tracks.filter((t) => (t.discNumber || 1) === pos).length,
                        }))
                    ).map((d) => {
                      const hasLocalTracksForDisc =
                        trackDistinctDiscs.length > 1 && trackDistinctDiscs.includes(d.position);
                      const isActivePill = !hasDiscConflict && album.discNumber === d.position;
                      return (
                        <button
                          key={d.position}
                          type="button"
                          disabled={isLoadingRelease}
                          title={
                            hasLocalTracksForDisc
                              ? `Nur Titel von CD ${d.position} auswählen`
                              : `Trackliste für CD ${d.position} laden`
                          }
                          onClick={() => {
                            if (hasLocalTracksForDisc) {
                              onAlbumChange((prev) => ({
                                ...prev,
                                discNumber: d.position,
                                tracks: prev.tracks.map((t) => ({
                                  ...t,
                                  selected: (t.discNumber || 1) === d.position,
                                })),
                              }));
                              onAppendQueryLog(
                                `[Multi-CD] Auswahl auf CD ${formatIndexNumber(d.position, album.totalDiscs)} (${d.trackCount} Titel) gewechselt.`
                              );
                            } else if (album.musicbrainzReleaseId || album.discogsId) {
                              onSelectRelease(
                                album.musicbrainzReleaseId
                                  ? album.musicbrainzReleaseId
                                  : `discogs:${album.discogsId}`,
                                d.position,
                                album.musicbrainzReleaseId ? 'musicbrainz' : 'discogs'
                              );
                            }
                          }}
                          className={`px-1.5 py-0.5 text-[11px] font-medium rounded border transition-colors ${
                            isActivePill
                              ? 'border-[#5BA632] bg-[#5BA632] text-white'
                              : 'border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]'
                          }`}
                        >
                          CD {formatIndexNumber(d.position, album.totalDiscs)} ({d.trackCount})
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {(isLeftFieldVisible('year') || isLeftFieldVisible('genre')) && (
              <div
                className={
                  isLeftFieldVisible('year') && isLeftFieldVisible('genre')
                    ? 'grid grid-cols-[108px_1fr] gap-2'
                    : 'space-y-2.5'
                }
              >
                {isLeftFieldVisible('year') && (
                  <label className="block space-y-1">
                    <span className="text-[#57606A] dark:text-[#8B949E]">Jahr</span>
                    <input
                      type="text"
                      value={album.year}
                      onChange={(e) => updateAlbumField('year', e.target.value)}
                      onBlur={(e) =>
                        onAppendQueryLog(`[Metadaten] Erscheinungsjahr geändert auf „${e.target.value.trim() || '—'}“.`)
                      }
                      className="w-full px-2 py-1 font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                  </label>
                )}

                {isLeftFieldVisible('genre') && (
                  <div className="space-y-1 min-w-0">
                    <span className="block text-[#57606A] dark:text-[#8B949E]">Genre (; getrennt)</span>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <input
                        type="text"
                        value={album.genre}
                        onChange={(e) => updateAlbumField('genre', e.target.value)}
                        onBlur={(e) =>
                          onAppendQueryLog(`[Metadaten] Genre geändert auf „${e.target.value.trim() || '—'}“.`)
                        }
                        placeholder="Rock; Electronic"
                        className="min-w-0 flex-1 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                      />
                      <button
                        type="button"
                        disabled={album.tracks.length === 0 || selectedCount === 0}
                        onClick={handleApplyGenreToAll}
                        title="Genre auf alle aktiv markierten Einzeltracks übertragen"
                        aria-label="Genre auf markierte Titel übertragen"
                        className="px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/15 hover:text-[#2E6B14] dark:hover:text-[#9BE270] disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
                      >
                        <SystemIcon name="apply_arrow" className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {(isLeftFieldVisible('label') || isLeftFieldVisible('cddbId')) && (
              <div
                className={
                  isLeftFieldVisible('label') && isLeftFieldVisible('cddbId')
                    ? 'grid grid-cols-2 gap-2'
                    : 'space-y-2.5'
                }
              >
                {isLeftFieldVisible('label') && (
                  <label className="block space-y-1">
                    <span className="text-[#57606A] dark:text-[#8B949E]">Label</span>
                    <input
                      type="text"
                      value={album.label}
                      onChange={(e) => updateAlbumField('label', e.target.value)}
                      onBlur={(e) =>
                        onAppendQueryLog(`[Metadaten] Label geändert auf „${e.target.value.trim() || '—'}“.`)
                      }
                      className="w-full px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                  </label>
                )}

                {isLeftFieldVisible('cddbId') && (
                  <label className="block space-y-1">
                    <span className="text-[#57606A] dark:text-[#8B949E]">CDDB DiscID</span>
                    <input
                      type="text"
                      value={album.cddbId}
                      onChange={(e) => updateAlbumField('cddbId', e.target.value)}
                      onBlur={(e) =>
                        onAppendQueryLog(`[Metadaten] CDDB-DiscID geändert auf „${e.target.value.trim() || '—'}“.`)
                      }
                      className="w-full px-2 py-1 font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                  </label>
                )}
              </div>
            )}

            {/* Dynamisch aktivierte zusätzliche MusicBrainz-Tags aus den Einstellungen */}
            {MUSICBRAINZ_LEFT_TAG_FIELDS.filter(
              (spec) =>
                !spec.defaultVisible &&
                spec.id !== 'composer' &&
                spec.id !== 'orchestra' &&
                spec.id !== 'conductor' &&
                spec.id !== 'musicbrainzReleaseGroupId' &&
                spec.id !== 'musicbrainzAlbumArtistId' &&
                spec.id !== 'musicbrainzDiscId' &&
                isLeftFieldVisible(spec.id)
            ).map((spec) => {
              const albumKey = spec.id as keyof AlbumMetadata;
              const val = String(album[albumKey] ?? '');
              const normalizePeople = spec.category === 'credits' && spec.id !== 'work';
              return (
                <div key={spec.id} className="space-y-1">
                  <span className="flex items-center justify-between gap-2 text-[#57606A] dark:text-[#8B949E]">
                    <span>{spec.label}</span>
                    <span className="font-mono text-[10px] opacity-75">{spec.mbTag}</span>
                  </span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={val}
                      onChange={(e) => updateAlbumField(albumKey, e.target.value as never)}
                      onBlur={(e) => {
                        const clean = normalizePeople ? normalizeMultiArtist(e.target.value) : e.target.value.trim();
                        updateAlbumField(albumKey, clean as never);
                        onAppendQueryLog(`[Metadaten] ${spec.label} geändert auf „${clean || '—'}“.`);
                      }}
                      placeholder={spec.placeholder || ''}
                      className="min-w-0 flex-1 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                    {spec.trackTransferKey && (
                      <button
                        type="button"
                        disabled={album.tracks.length === 0 || selectedCount === 0}
                        onClick={() =>
                          handleApplyAlbumFieldToSelectedTracks(
                            albumKey,
                            spec.trackTransferKey!,
                            spec.label,
                            normalizePeople
                          )
                        }
                        title={`${spec.label} auf die aktiv markierten Titel in der Titelliste übertragen`}
                        aria-label={`${spec.label} auf markierte Titel übertragen`}
                        className="px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/15 hover:text-[#2E6B14] dark:hover:text-[#9BE270] disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
                      >
                        <SystemIcon name="apply_arrow" className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Virtuelle Red-Book-TOC (aus CD oder lokalem Album-Ordner ohne physisches Laufwerk) */}
            <div className="p-2.5 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23]/80 space-y-2">
              <div className="flex items-center justify-between gap-1.5">
                <span className="text-[11px] font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate">
                  Virtuelle CD-TOC &amp; Dauer-Signatur
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={album.tracks.length === 0 || isSearching || isRetryingBackoff}
                    onClick={() => onLookupByToc()}
                    title="Sektor-TOC + Dauer-Vektor berechnen und bei MusicBrainz / Discogs / CDDB abfragen"
                    className="inline-flex items-center gap-1 px-1.5 py-0 text-[11px] font-medium rounded border border-[#5BA632]/50 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] hover:bg-[#5BA632]/20 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    <SystemIcon name="search_online" className="w-3 h-3" />
                    <span>TOC abfragen</span>
                  </button>
                  <button
                    type="button"
                    disabled={album.tracks.length === 0 || isSearching || isRetryingBackoff}
                    onClick={onReinitializeQuery}
                    title="Metadaten-Abfrage für dieses Album neu initialisieren (mit exponentiellem Backoff, ohne das Album neu laden zu müssen)"
                    className="inline-flex items-center gap-1 px-1.5 py-0 text-[11px] font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    <SystemIcon name="refresh_disc" className="w-3 h-3 text-[#5BA632] dark:text-[#69B53F]" />
                    <span>Neu initialisieren</span>
                  </button>
                </div>
              </div>
              <div className="space-y-1 text-[11px] font-mono">
                <div className="flex items-center justify-between gap-2 truncate">
                  <span className="text-[#57606A] dark:text-[#8B949E] font-sans">MB-DiscID:</span>
                  <span className="text-[#1F2328] dark:text-[#EAEEF2] truncate" title={album.musicbrainzDiscId || ''}>
                    {album.musicbrainzDiscId || '—'}
                  </span>
                </div>
                <div className="truncate text-[#57606A] dark:text-[#8B949E]" title={album.musicbrainzToc || ''}>
                  <span className="font-sans">TOC: </span>
                  <span className="text-[#1F2328] dark:text-[#EAEEF2]">
                    {album.musicbrainzToc || '—'}
                  </span>
                </div>
              </div>
            </div>

            {isLeftFieldVisible('musicbrainzReleaseId') && (
              <div className="space-y-1">
                <span className="text-[#57606A] dark:text-[#8B949E]">MusicBrainz Release-ID</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={album.musicbrainzReleaseId}
                    onChange={(e) => updateAlbumField('musicbrainzReleaseId', e.target.value)}
                    onBlur={(e) =>
                      onAppendQueryLog(
                        `[Metadaten] MusicBrainz Release-ID geändert auf „${e.target.value.trim() || '—'}“.`
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && album.musicbrainzReleaseId?.trim()) {
                        e.preventDefault();
                        const mbid = album.musicbrainzReleaseId.trim();
                        onSearchQueryChange(mbid);
                        onSearchMusicBrainz(mbid, false);
                      }
                    }}
                    placeholder="UUID (z.B. e54e7c1c-...)"
                    className="min-w-0 flex-1 px-2 py-1 font-mono text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                  />
                  <button
                    type="button"
                    disabled={!album.musicbrainzReleaseId?.trim() || isSearching}
                    onClick={() => {
                      const mbid = album.musicbrainzReleaseId?.trim();
                      if (!mbid) return;
                      onSearchQueryChange(mbid);
                      onSearchMusicBrainz(mbid, false);
                    }}
                    title="Albuminformationen anhand dieser MusicBrainz Release-ID abrufen"
                    aria-label="MusicBrainz Release-ID abfragen"
                    className="px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/15 hover:text-[#2E6B14] dark:hover:text-[#9BE270] disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
                  >
                    <SystemIcon name="apply_arrow" className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {MUSICBRAINZ_LEFT_TAG_FIELDS.filter(
              (spec) =>
                (spec.id === 'musicbrainzReleaseGroupId' ||
                  spec.id === 'musicbrainzAlbumArtistId' ||
                  spec.id === 'musicbrainzDiscId') &&
                isLeftFieldVisible(spec.id)
            ).map((spec) => {
              const albumKey = spec.id as keyof AlbumMetadata;
              const val = String(album[albumKey] ?? '');
              return (
                <label key={spec.id} className="block space-y-1">
                  <span className="flex items-center justify-between gap-2 text-[#57606A] dark:text-[#8B949E]">
                    <span>{spec.label}</span>
                    <span className="font-mono text-[10px] opacity-75">{spec.mbTag}</span>
                  </span>
                  <input
                    type="text"
                    value={val}
                    onChange={(e) => updateAlbumField(albumKey, e.target.value as never)}
                    onBlur={(e) =>
                      onAppendQueryLog(`[Metadaten] ${spec.label} geändert auf „${e.target.value.trim() || '—'}“.`)
                    }
                    placeholder={spec.placeholder || ''}
                    className="w-full px-2 py-1 font-mono text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                  />
                </label>
              );
            })}

            {(isLeftFieldVisible('discogsId') || isLeftFieldVisible('asin')) && (
              <div
                className={
                  isLeftFieldVisible('discogsId') && isLeftFieldVisible('asin')
                    ? 'grid grid-cols-2 gap-2'
                    : 'space-y-2.5'
                }
              >
                {isLeftFieldVisible('discogsId') && (
                  <div className="space-y-1">
                    <span className="text-[#57606A] dark:text-[#8B949E]">Discogs Release-ID</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={album.discogsId || ''}
                        onChange={(e) => updateAlbumField('discogsId', e.target.value)}
                        onBlur={(e) =>
                          onAppendQueryLog(
                            `[Metadaten] Discogs Release-ID geändert auf „${e.target.value.trim() || '—'}“.`
                          )
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && album.discogsId?.trim()) {
                            e.preventDefault();
                            const rawDg = album.discogsId.trim();
                            const q = /^\[?[rm]?\d+\]?$/i.test(rawDg) && !rawDg.startsWith('[') && !/^[rm]/i.test(rawDg)
                              ? `discogs:${rawDg}`
                              : rawDg;
                            onSearchQueryChange(q);
                            onSearchMusicBrainz(q, false);
                          }
                        }}
                        placeholder="z.B. [r524030] oder 524030"
                        className="min-w-0 flex-1 px-2 py-1 font-mono text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                      />
                      <button
                        type="button"
                        disabled={!album.discogsId?.trim() || isSearching}
                        onClick={() => {
                          const rawDg = album.discogsId?.trim();
                          if (!rawDg) return;
                          const q = /^\d+$/.test(rawDg) ? `discogs:${rawDg}` : rawDg;
                          onSearchQueryChange(q);
                          onSearchMusicBrainz(q, false);
                        }}
                        title="Albuminformationen anhand dieser Discogs Release-/Master-ID (z. B. [r524030] oder [m63720]) abrufen"
                        aria-label="Discogs Release-ID abfragen"
                        className="px-1.5 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/15 hover:text-[#2E6B14] dark:hover:text-[#9BE270] disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
                      >
                        <SystemIcon name="apply_arrow" className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {isLeftFieldVisible('asin') && (
                  <label className="block space-y-1">
                    <span className="text-[#57606A] dark:text-[#8B949E]">Amazon ASIN</span>
                    <input
                      type="text"
                      value={album.asin || ''}
                      onChange={(e) => updateAlbumField('asin', e.target.value.toUpperCase())}
                      onBlur={(e) =>
                        onAppendQueryLog(
                          `[Metadaten] Amazon ASIN geändert auf „${e.target.value.trim().toUpperCase() || '—'}“.`
                        )
                      }
                      placeholder="z.B. B000002U82"
                      className="w-full px-2 py-1 font-mono text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                  </label>
                )}
              </div>
            )}

            {isLeftFieldVisible('barcode') && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[#57606A] dark:text-[#8B949E]">Barcode (EAN / UPC) &amp; QR-Code</span>
                  {moduleMode !== 'album_tag' && (
                    <button
                      type="button"
                      onClick={() => {
                        onAppendQueryLog(
                          '[Barcode/QR-Scanner] Dialog zum Einlesen eines Barcodes oder QR-Codes per Webcam geöffnet.'
                        );
                        setIsBarcodeModalOpen(true);
                      }}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-[#5BA632] dark:text-[#69B53F] hover:underline"
                    >
                      <SystemIcon name="barcode_qr" className="w-3 h-3" />
                      <span>Webcam-Scan</span>
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={album.barcode || ''}
                    onChange={(e) => updateAlbumField('barcode', e.target.value)}
                    onBlur={(e) =>
                      onAppendQueryLog(
                        `[Metadaten] Barcode/EAN geändert auf „${e.target.value.trim() || '—'}“.`
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && album.barcode?.trim()) {
                        e.preventDefault();
                        const bc = album.barcode.trim();
                        onSearchQueryChange(bc);
                        onSearchMusicBrainz(bc, false);
                      }
                    }}
                    placeholder="EAN-13 / UPC-A (z.B. 5099969944926)"
                    className="min-w-0 flex-1 px-2 py-1 font-mono text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                  />
                  <button
                    type="button"
                    disabled={!album.barcode?.trim() || isSearching}
                    onClick={() => {
                      if (!album.barcode?.trim()) return;
                      const bc = album.barcode.trim();
                      onSearchQueryChange(bc);
                      onSearchMusicBrainz(bc, false);
                    }}
                    title="Albuminformationen anhand dieses Barcodes / QR-Codes abrufen (zeigt Trefferliste zur Auswahl)"
                    aria-label="Barcode abfragen"
                    className="px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/15 hover:text-[#2E6B14] dark:hover:text-[#9BE270] disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
                  >
                    <SystemIcon name="apply_arrow" className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        </fieldset>
            )}
          </>
        )}
      </aside>

      {/* Ziehbarer Trennbalken zwischen Spalte 1 und Spalte 2 (Modul 2 & 3) */}
      {moduleMode !== 'cover_only' &&
        (isLeftColCollapsedEffective ? (
          <div className="hidden lg:block w-3 shrink-0" aria-hidden="true" />
        ) : (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Breite der linken Spalte anpassen"
            title="Spaltenbreite durch Ziehen anpassen (Doppelklick zum Zurücksetzen)"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              splitDragRef.current = {
                side: 'left',
                startX: e.clientX,
                startWidth: leftColWidth,
              };
              setActiveSplitter('left');
            }}
            onDoubleClick={() => setLeftColWidth(400)}
            className="hidden lg:flex w-3 shrink-0 self-stretch cursor-col-resize items-center justify-center group select-none touch-none"
          >
            <span
              className={`w-[3px] h-16 rounded-full transition-colors ${
                activeSplitter === 'left'
                  ? 'bg-[#5BA632]'
                  : 'bg-[#D0D7DE] dark:bg-[#343A40] group-hover:bg-[#5BA632]'
              }`}
            />
          </div>
        ))}

      {/* Rechter Hauptbereich: im Modul 1 die Cover-Ergebnistabelle, sonst die 3 Displays (Suchleiste liegt neben der Fensterüberschrift) */}
      <div className="flex flex-col gap-3 min-w-0 flex-1">
        {searchError && moduleMode !== 'cover_only' && (
          <div className="p-2.5 rounded-lg border border-[#DC2626]/40 bg-[#DC2626]/5 text-xs text-[#DC2626] dark:text-[#F87171] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <SystemIcon name="status_error" className="w-4 h-4 shrink-0" />
              <span>{searchError}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={isSearching || isLoadingRelease || isRetryingBackoff}
                onClick={onRetryWithBackoff}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <SystemIcon name="refresh_disc" className="w-3.5 h-3.5" />
                <span>
                  {isRetryingBackoff
                    ? `Wiederhole (${retryAttempt}/${retryMaxAttempts})...`
                    : 'Erneut versuchen (Exp. Backoff)'}
                </span>
              </button>
              <button
                type="button"
                disabled={isSearching || isLoadingRelease || isRetryingBackoff}
                onClick={onReinitializeQuery}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded border border-[#DC2626]/40 bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <span>Abfrage neu initialisieren</span>
              </button>
            </div>
          </div>
        )}

        {/* Im Modul 1 ("Coverbild beziehen"): Ergebnisse der Bildersuche direkt unterhalb der Suchleiste */}
        {moduleMode === 'cover_only' ? (
          <section
            aria-labelledby="cover-picker-inline-title"
            className="flex flex-col bg-white dark:bg-[#25292E] border border-[#DCDCE4] dark:border-[#343A40] rounded-lg shadow-[0_2px_4px_rgba(0,0,0,0.05)] overflow-hidden"
          >
            {renderCoverCandidatesTableSection(true)}
          </section>
        ) : (
          <>
        {/* Display 1: Albenliste (in Modul 3 mit Drag & Drop → Felder zurücksetzen + automatische Online-Abfrage mit Overlay) */}
        <details
          open={activeRightDisplay === 'hits'}
          onDragOver={(e) => {
            if (
              moduleMode !== 'album_tag' ||
              isBatchActivelyRunning ||
              isSearching ||
              isLoadingRelease ||
              activeRightDisplay !== 'hits'
            ) {
              return;
            }
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setIsHitsDropActive(true);
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setIsHitsDropActive(false);
            }
          }}
          onDrop={(e) => {
            if (
              moduleMode !== 'album_tag' ||
              isBatchActivelyRunning ||
              isSearching ||
              isLoadingRelease ||
              activeRightDisplay !== 'hits'
            ) {
              return;
            }
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setIsHitsDropActive(false);
              void extractFilesFromDataTransfer(e.dataTransfer).then((droppedFiles) => {
                if (droppedFiles.length > 0) {
                  onImportAudioFiles(droppedFiles, {
                    replaceExisting: true,
                    autoLookupToc: true,
                    resetBeforeImport: true,
                  });
                }
              });
            }
          }}
          className={`bg-white dark:bg-[#25292E] border rounded-lg shadow-[0_2px_4px_rgba(0,0,0,0.05)] overflow-hidden transition-colors ${
            isHitsDropActive
              ? 'border-[#5BA632] ring-2 ring-[#5BA632]/30'
              : 'border-[#DCDCE4] dark:border-[#343A40]'
          } ${isBatchActivelyRunning ? 'opacity-60' : ''}`}
        >
          <summary
            onClick={(e) => {
              e.preventDefault();
              if (!isBatchActivelyRunning) onToggleRightDisplay('hits');
            }}
            aria-disabled={isBatchActivelyRunning}
            className={`list-none [&::-webkit-details-marker]:hidden px-3 py-1.5 flex items-center justify-between gap-3 bg-[#F8F9FA] dark:bg-[#1C1F23]/60 transition-colors select-none ${
              activeRightDisplay === 'hits' ? 'border-b border-[#DCDCE4] dark:border-[#343A40]' : ''
            } ${
              isBatchActivelyRunning
                ? 'cursor-not-allowed'
                : 'cursor-pointer hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B]'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <SystemIcon name="search_online" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0" />
              <span className="font-semibold text-sm text-[#1F2328] dark:text-[#EAEEF2] truncate">
                Albenliste
              </span>
              {searchResults.length > 0 && (
                <span className="px-1.5 py-0 text-[11px] font-mono rounded border border-[#5BA632]/40 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] shrink-0">
                  {searchResults.length} Treffer
                </span>
              )}
              {(isSearching || isLoadingRelease) && (
                <span className="px-1.5 py-0 text-[11px] font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#57606A] dark:text-[#8B949E] shrink-0">
                  {isSearching ? 'Abfrage läuft...' : 'Album wird geladen…'}
                </span>
              )}
            </div>
            <span
              aria-hidden="true"
              className="text-lg font-normal leading-none text-[#555555] dark:text-[#8B949E] shrink-0"
            >
              {activeRightDisplay === 'hits' ? '−' : '+'}
            </span>
          </summary>

          {activeRightDisplay === 'hits' && (
            <div className="relative min-h-[210px] bg-[#FAFAFA] dark:bg-[#1C1F23]/40">
              {(isSearching || isLoadingRelease || isRetryingBackoff) && (
                <div
                  role="status"
                  aria-live="polite"
                  className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[#1C1F23]/70 dark:bg-[#0D1117]/75 backdrop-blur-[1.5px] text-white px-4 text-center"
                >
                  <svg
                    viewBox="0 0 52 52"
                    className="w-12 h-12 animate-[spin_2.4s_linear_infinite]"
                    aria-hidden="true"
                  >
                    <circle
                      cx="26"
                      cy="26"
                      r="20"
                      fill="none"
                      stroke="rgba(255,255,255,0.24)"
                      strokeWidth="4"
                    />
                    <path
                      d="M 26 6 A 20 20 0 0 1 44.5 18.4"
                      fill="none"
                      stroke="#10B981"
                      strokeWidth="4"
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="space-y-0.5">
                    <p className="text-sm font-semibold text-white">
                      {isRetryingBackoff
                        ? `Onlinedatenbanken werden abgefragt (Versuch ${retryAttempt}/${retryMaxAttempts})…`
                        : isSearching
                        ? moduleMode === 'album_tag'
                          ? 'Onlinedatenbanken werden abgefragt…'
                          : 'CD wird eingelesen & Alben werden abgefragt…'
                        : 'Album & Titelliste werden geladen…'}
                    </p>
                    <p className="text-xs text-white/80">
                      {isSearching || isRetryingBackoff
                        ? 'MusicBrainz · Discogs · CDDB / GnuDB'
                        : 'Metadaten, Titelliste & Cover werden abgerufen'}
                    </p>
                  </div>
                </div>
              )}
              {moduleMode === 'album_tag' &&
                isHitsDropActive &&
                !isSearching &&
                !isLoadingRelease &&
                !isRetryingBackoff && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-[#5BA632]/12 dark:bg-[#5BA632]/18 backdrop-blur-[1.5px] border-2 border-dashed border-[#5BA632] rounded-b-lg p-4"
                  >
                    <div className="flex flex-col items-center gap-2 px-6 py-4 rounded-xl bg-white/92 dark:bg-[#1C1F23]/92 border border-[#5BA632]/45 shadow-md text-center">
                      <div className="w-12 h-12 rounded-full bg-[#5BA632]/15 flex items-center justify-center text-[#5BA632] dark:text-[#6BCB57]">
                        <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 4v11" />
                          <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
                          <path d="M4 15v2.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V15" />
                        </svg>
                      </div>
                      <p className="text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                        Album-Ordner hier ablegen
                      </p>
                      <p className="text-xs text-[#57606A] dark:text-[#8B949E]">
                        Aktuelle Liste wird geleert &amp; Online-Abfrage gestartet
                      </p>
                    </div>
                  </div>
                )}
              <fieldset disabled={isBatchActivelyRunning} className="min-w-0 block">
                {searchResults.length === 0 ? (
                  <div className="p-8 min-h-[210px] flex flex-col items-center justify-center text-center space-y-2 bg-white dark:bg-[#25292E]">
                    <p className="text-sm font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                      {isSearching ? '' : 'Noch keine Alben-Trefferliste geladen'}
                    </p>
                    {!isSearching && (
                      <p className="text-xs text-[#57606A] dark:text-[#8B949E]">
                        {moduleMode === 'album_tag'
                          ? 'Ziehe einen Album-Ordner per Drag & Drop hierher (startet automatisch die Online-Abfrage) oder suche oben manuell.'
                          : 'Gib oben einen Suchbegriff ein, lies eine Audio-CD ein oder importiere einen Album-Ordner.'}
                      </p>
                    )}
                  </div>
                ) : (() => {
                  const mbCount = searchResults.filter((r) => (r.source || 'musicbrainz') === 'musicbrainz').length;
                  const cddbCount = searchResults.filter((r) => r.source === 'cddb').length;
                  const discogsCount = searchResults.filter((r) => r.source === 'discogs').length;
                  const filteredResults =
                    hitSourceFilter === 'all'
                      ? searchResults
                      : searchResults.filter((r) => (r.source || 'musicbrainz') === hitSourceFilter);
                  const activeHit = filteredResults[selectedCandidateIdx] || filteredResults[0];

                  return (
                    <div className="bg-white dark:bg-[#25292E]">
                      {/* Kopfzeile der Trefferliste */}
                      <div className="px-3.5 py-2 bg-[#5BA632]/10 dark:bg-[#5BA632]/15 border-b border-[#E1E4E8] dark:border-[#343A40] flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <SystemIcon name="search_online" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0" />
                          <div>
                            <div className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                              Gefundene Alben — Trefferliste ({searchResults.length} Treffer)
                            </div>
                            <div className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                              Album markieren und rechts unten über „Ausgewähltes Album laden“ (oder Doppelklick) übernehmen:
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          {(
                            [
                              { id: 'all', label: `Alle (${searchResults.length})`, count: searchResults.length },
                              { id: 'musicbrainz', label: `MusicBrainz (${mbCount})`, count: mbCount },
                              { id: 'cddb', label: `CDDB (${cddbCount})`, count: cddbCount },
                              { id: 'discogs', label: `Discogs (${discogsCount})`, count: discogsCount },
                            ] as const
                          )
                            .filter((tab) => tab.id === 'all' || tab.count > 0)
                            .map((tab) => (
                              <button
                                key={tab.id}
                                type="button"
                                onClick={() => {
                                  setHitSourceFilter(tab.id);
                                  setSelectedCandidateIdx(0);
                                }}
                                className={`px-1.5 py-0.5 text-[11px] font-medium rounded border transition-colors cursor-pointer ${
                                  hitSourceFilter === tab.id
                                    ? 'border-[#5BA632] bg-[#5BA632] text-white'
                                    : 'border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]'
                                }`}
                              >
                                {tab.label}
                              </button>
                            ))}
                        </div>
                      </div>

                      {/* Scrollbare Liste aller gefundenen Alben (ohne horizontale Scrollbalken) */}
                      <div className="max-h-[calc(100vh-370px)] min-h-[220px] overflow-y-auto overflow-x-hidden divide-y divide-[#E1E4E8] dark:divide-[#343A40] bg-white dark:bg-[#25292E]">
                        {filteredResults.map((rel, idx) => {
                          const srcLabel =
                            rel.source === 'discogs'
                              ? 'Discogs'
                              : rel.source === 'cddb'
                                ? 'CDDB'
                                : 'MusicBrainz';
                          const srcBadgeColors =
                            rel.source === 'discogs'
                              ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300'
                              : rel.source === 'cddb'
                                ? 'border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300'
                                : 'border-[#5BA632]/40 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270]';

                          const isCurrentlyLoaded =
                            (rel.source === 'musicbrainz' && Boolean(album.musicbrainzReleaseId) && album.musicbrainzReleaseId === rel.id) ||
                            (rel.source === 'discogs' && Boolean(album.discogsId) && rel.id === `discogs:${album.discogsId}`) ||
                            (rel.source === 'cddb' && album.metadataSource === 'CDDB' && Boolean(album.cddbId) && rel.id.endsWith(`:${album.cddbId}`) && album.title === rel.title);

                          const isSelectedRow = idx === selectedCandidateIdx;
                          const targetDisc = rel.matchedDiscNumber || 1;

                          return (
                            <div
                              key={`${rel.source || 'mb'}-${rel.id}-${idx}`}
                              onClick={() => {
                                if (!isBatchActivelyRunning) setSelectedCandidateIdx(idx);
                              }}
                              onDoubleClick={() => {
                                if (isBatchActivelyRunning || isLoadingRelease) return;
                                setCoverImgFailed(false);
                                onSelectRelease(rel.id, targetDisc, rel.source);
                              }}
                              className={`px-3.5 py-2 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 transition-colors cursor-pointer ${
                                isSelectedRow
                                  ? 'bg-[#5BA632]/12 dark:bg-[#5BA632]/20'
                                  : isCurrentlyLoaded
                                    ? 'bg-[#5BA632]/5 dark:bg-[#5BA632]/10'
                                    : 'hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]'
                              }`}
                            >
                              <div className="min-w-0 flex-1 space-y-0.5">
                                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                                  <span className="text-[11px] font-mono text-[#57606A] dark:text-[#8B949E] shrink-0">
                                    #{idx + 1}
                                  </span>
                                  <span
                                    className={`px-1.5 py-0 text-[10px] font-mono font-semibold uppercase rounded border shrink-0 ${srcBadgeColors}`}
                                  >
                                    {srcLabel}
                                  </span>
                                  {rel.method && (
                                    <span className="px-1.5 py-0 text-[10px] font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#57606A] dark:text-[#8B949E] shrink-0">
                                      {rel.method}
                                    </span>
                                  )}
                                  <span className="text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate">
                                    {rel.title}
                                  </span>
                                  <span className="text-xs text-[#57606A] dark:text-[#8B949E] truncate">
                                    — {rel.artist}
                                  </span>
                                </div>

                                <div className="text-xs text-[#57606A] dark:text-[#8B949E] flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                  {rel.date && (
                                    <span className="font-mono tabular-nums">Jahr: {rel.date}</span>
                                  )}
                                  {rel.country && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span>Land: {rel.country}</span>
                                    </>
                                  )}
                                  {rel.label && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span>Label: {rel.label}</span>
                                    </>
                                  )}
                                  {rel.catno && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span className="font-mono">Kat.-Nr.: {rel.catno}</span>
                                    </>
                                  )}
                                  {rel.barcode && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span className="font-mono">EAN: {rel.barcode}</span>
                                    </>
                                  )}
                                </div>

                                {((Array.isArray(rel.genres) && rel.genres.length > 0) ||
                                  (Array.isArray(rel.qualityBadges) && rel.qualityBadges.length > 0)) && (
                                  <div className="flex flex-wrap items-center gap-1 pt-0.5">
                                    {Array.isArray(rel.genres) && rel.genres.length > 0 && (
                                      <span className="px-1.5 py-0 text-[10px] rounded border border-[#5BA632]/35 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270]">
                                        {rel.genres.slice(0, 3).join(', ')}
                                      </span>
                                    )}
                                    {(rel.qualityBadges || []).slice(0, 4).map((badge) => (
                                      <span
                                        key={badge}
                                        className="px-1.5 py-0 text-[10px] font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#57606A] dark:text-[#8B949E]"
                                      >
                                        {badge}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>

                              <div className="flex items-center gap-2.5 shrink-0">
                                <div className="text-right">
                                  <div className="text-xs font-mono tabular-nums font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                                    {(rel.mediumCount || 1) > 1
                                      ? `${rel.mediumCount} CDs (CD ${targetDisc}) · `
                                      : ''}
                                    {rel.trackCount > 0 ? `${rel.trackCount} Titel` : 'CD-Release'}
                                  </div>
                                  {typeof rel.score === 'number' && rel.score > 0 && (
                                    <div className="text-[10px] font-mono tabular-nums text-[#57606A] dark:text-[#8B949E]">
                                      Übereinstimmung: {rel.score}%
                                      {typeof rel.qualityScore === 'number' && rel.qualityScore > 0
                                        ? ` · Q${rel.qualityScore}`
                                        : ''}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Fußzeile von Display 1: Auswahl-Info (Übernahme-Button liegt links unten in der Album-Vorschau) */}
                      <div className="px-3.5 py-2.5 border-t border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 flex items-center justify-between gap-4">
                        <div className="min-w-0 flex-1 text-xs text-[#57606A] dark:text-[#8B949E] truncate">
                          {activeHit
                            ? `Ausgewählt: ${activeHit.artist} – ${activeHit.title} (${
                                activeHit.source === 'discogs'
                                  ? 'Discogs'
                                  : activeHit.source === 'cddb'
                                    ? 'CDDB'
                                    : 'MusicBrainz'
                              })`
                            : 'Bitte ein Album aus der Trefferliste auswählen.'}
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </fieldset>
            </div>
          )}
        </details>

        {/* Display 2: Titel- & Metadaten-Verwaltung (Drag & Drop lädt Ordner/Dateien ohne automatische Online-Abfrage) */}
        <details
          open={activeRightDisplay === 'tracks'}
          onDragOver={(e) => {
            if (isBatchActivelyRunning || activeRightDisplay !== 'tracks') return;
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setIsTrackDropActive(true);
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setIsTrackDropActive(false);
            }
          }}
          onDrop={(e) => {
            if (isBatchActivelyRunning || activeRightDisplay !== 'tracks') return;
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setIsTrackDropActive(false);
              void extractFilesFromDataTransfer(e.dataTransfer).then((droppedFiles) => {
                if (droppedFiles.length > 0) {
                  onImportAudioFiles(droppedFiles, {
                    replaceExisting: true,
                    autoLookupToc: false,
                    resetBeforeImport: moduleMode === 'album_tag',
                  });
                }
              });
            }
          }}
          className={`bg-white dark:bg-[#25292E] border rounded-lg shadow-[0_2px_4px_rgba(0,0,0,0.05)] overflow-hidden transition-colors ${
            isTrackDropActive
              ? 'border-[#5BA632] ring-2 ring-[#5BA632]/30'
              : 'border-[#DCDCE4] dark:border-[#343A40]'
          } ${isBatchActivelyRunning ? 'opacity-60' : ''}`}
        >
          <summary
            onClick={(e) => {
              e.preventDefault();
              if (!isBatchActivelyRunning) onToggleRightDisplay('tracks');
            }}
            aria-disabled={isBatchActivelyRunning}
            className={`list-none [&::-webkit-details-marker]:hidden px-3 py-1.5 flex items-center justify-between gap-3 bg-[#F8F9FA] dark:bg-[#1C1F23]/60 transition-colors select-none ${
              activeRightDisplay === 'tracks' ? 'border-b border-[#DCDCE4] dark:border-[#343A40]' : ''
            } ${
              isBatchActivelyRunning
                ? 'cursor-not-allowed'
                : 'cursor-pointer hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B]'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <SystemIcon name="audio_track" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0" />
              <span className="font-semibold text-sm text-[#1F2328] dark:text-[#EAEEF2] truncate">
                Titel- &amp; Metadaten-Verwaltung ({selectedCount}/{album.tracks.length} ausgewählt)
              </span>
              <span className="hidden sm:inline text-xs font-mono tabular-nums text-[#57606A] dark:text-[#8B949E] shrink-0">
                · {formatDuration(totalSeconds)}
              </span>
            </div>
            <span
              aria-hidden="true"
              className="text-lg font-normal leading-none text-[#555555] dark:text-[#8B949E] shrink-0"
            >
              {activeRightDisplay === 'tracks' ? '−' : '+'}
            </span>
          </summary>

          {activeRightDisplay === 'tracks' && (
            <div className="relative bg-[#FAFAFA] dark:bg-[#1C1F23]/40">
              {moduleMode === 'album_tag' && isTrackDropActive && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-[#5BA632]/12 dark:bg-[#5BA632]/18 backdrop-blur-[1.5px] border-2 border-dashed border-[#5BA632] rounded-b-lg p-4"
                >
                  <div className="flex flex-col items-center gap-2 px-6 py-4 rounded-xl bg-white/92 dark:bg-[#1C1F23]/92 border border-[#5BA632]/45 shadow-md text-center">
                    <div className="w-12 h-12 rounded-full bg-[#5BA632]/15 flex items-center justify-center text-[#5BA632] dark:text-[#6BCB57]">
                      <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 4v11" />
                        <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
                        <path d="M4 15v2.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V15" />
                      </svg>
                    </div>
                    <p className="text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                      Album-Ordner hier ablegen
                    </p>
                    <p className="text-xs text-[#57606A] dark:text-[#8B949E]">
                      Aktuelle Liste wird geleert &amp; Titel werden geladen
                    </p>
                  </div>
                </div>
              )}
              <fieldset
                disabled={isBatchActivelyRunning}
                className={`min-w-0 block ${
                  isBatchActivelyRunning ? 'opacity-60 pointer-events-none select-none' : ''
                }`}
              >
                {/* Kompaktes Album-Dashboard */}
                <div className="p-3.5 border-b border-[#E1E4E8] dark:border-[#343A40] bg-white/80 dark:bg-[#25292E]/70">
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-2 mb-2 border-b border-[#E1E4E8] dark:border-[#343A40]">
                    <div className="flex items-center gap-2 text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                      <SystemIcon name="optical_drive" className="w-3.5 h-3.5 text-[#5BA632] dark:text-[#69B53F]" />
                      <span>Album-Dashboard · Aktuelle CD-Übersicht</span>
                    </div>
                    <span className="text-[11px] font-mono text-[#57606A] dark:text-[#8B949E]">
                      Profil: {storageStats.formatLabel} (~{storageStats.estimatedBitrateKbps} kbps)
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div className="px-2.5 py-2 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/70">
                      <div className="text-[11px] font-medium text-[#57606A] dark:text-[#8B949E]">
                        Gesamtspieldauer
                      </div>
                      <div className="mt-0.5 flex items-baseline gap-2">
                        <span className="text-sm font-bold font-mono tabular-nums text-[#1F2328] dark:text-[#EAEEF2]">
                          {formatDuration(storageStats.totalDurationSeconds)}
                        </span>
                        <span className="text-[11px] font-mono tabular-nums text-[#57606A] dark:text-[#8B949E]">
                          Min:Sek
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-[#57606A] dark:text-[#8B949E] tabular-nums">
                        Auswahl: {formatDuration(storageStats.selectedDurationSeconds)} · Ø {formatDuration(storageStats.averageTrackSeconds)} / Track
                      </div>
                    </div>

                    <div className="px-2.5 py-2 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/70">
                      <div className="text-[11px] font-medium text-[#57606A] dark:text-[#8B949E]">
                        Anzahl der Tracks
                      </div>
                      <div className="mt-0.5 flex items-baseline gap-2">
                        <span className="text-sm font-bold font-mono tabular-nums text-[#1F2328] dark:text-[#EAEEF2]">
                          {storageStats.selectedTracks} / {storageStats.totalTracks}
                        </span>
                        <span className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                          ausgewählt
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] tabular-nums text-[#57606A] dark:text-[#8B949E]">
                        {hasDiscConflict
                          ? `Medium: Mehrere CDs (${selectedDiscNumbers.map((d) => `CD ${d}`).join(' + ')}) von ${formatIndexNumber(album.totalDiscs, album.totalDiscs)}`
                          : `Medium: CD ${formatIndexNumber(album.discNumber, album.totalDiscs)} von ${formatIndexNumber(album.totalDiscs, album.totalDiscs)}`}
                      </div>
                    </div>

                    <div className="px-2.5 py-2 rounded border border-[#5BA632]/35 bg-[#5BA632]/5 dark:bg-[#5BA632]/10">
                      <div className="text-[11px] font-medium text-[#2E6B14] dark:text-[#9BE270]">
                        Geschätzter Speicherbedarf
                      </div>
                      <div className="mt-0.5 flex items-baseline gap-2">
                        <span className="text-sm font-bold font-mono tabular-nums text-[#1F2328] dark:text-[#EAEEF2]">
                          ~{formatMegabytes(storageStats.estimatedOutputBytes)}
                        </span>
                        <span className="text-[11px] font-mono text-[#2E6B14] dark:text-[#9BE270]">
                          ({storageStats.compressionRatioPercent}% v. CD)
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-[#57606A] dark:text-[#8B949E] tabular-nums">
                        CD-Rohdaten (PCM): {formatMegabytes(storageStats.rawPcmBytes)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Werkzeughaube mit Aktionen & "Alle auswählen / abwählen" */}
                <div className="px-4 py-2.5 border-b border-[#E1E4E8] dark:border-[#343A40] flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="inline-flex items-center gap-2 text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2] cursor-pointer select-none">
                      <input
                        ref={selectAllCheckboxRef}
                        type="checkbox"
                        disabled={album.tracks.length === 0 || isBatchActivelyRunning}
                        checked={allSelected}
                        onChange={(e) => handleToggleAllTracks(e.target.checked)}
                        className="w-4 h-4 accent-[#5BA632] rounded cursor-pointer disabled:opacity-50"
                      />
                      <span>Alle auswählen / abwählen</span>
                    </label>
                    {trackDistinctDiscs.length > 1 && (
                      <div className="inline-flex items-center gap-1 pl-2 border-l border-[#D0D7DE] dark:border-[#444C56]">
                        {trackDistinctDiscs.length <= 6 ? (
                          trackDistinctDiscs.map((dNum) => {
                            const discTracks = album.tracks.filter(
                              (t) => Math.max(1, t.discNumber || album.discNumber || 1) === dNum
                            );
                            const isOnlyThisDiscSelected =
                              !hasDiscConflict &&
                              selectedCount > 0 &&
                              selectedCount === discTracks.length &&
                              selectedDiscNumbers[0] === dNum;
                            return (
                              <button
                                key={dNum}
                                type="button"
                                disabled={isBatchActivelyRunning}
                                onClick={() => handleSelectSingleDisc(dNum)}
                                title={`Nur Titel von CD ${formatIndexNumber(dNum, album.totalDiscs)} (${discTracks.length} Titel) auswählen`}
                                className={`px-2 py-0.5 text-[11px] font-medium rounded border transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap ${
                                  isOnlyThisDiscSelected
                                    ? 'border-[#5BA632] bg-[#5BA632] text-white'
                                    : 'border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]'
                                }`}
                              >
                                CD {dNum}
                              </button>
                            );
                          })
                        ) : (
                          <select
                            aria-label="Einzelne CD auswählen"
                            disabled={isBatchActivelyRunning}
                            value={
                              !hasDiscConflict &&
                              selectedCount > 0 &&
                              selectedDiscNumbers.length === 1 &&
                              selectedCount ===
                                album.tracks.filter(
                                  (t) =>
                                    Math.max(1, t.discNumber || album.discNumber || 1) ===
                                    selectedDiscNumbers[0]
                                ).length
                                ? String(selectedDiscNumbers[0])
                                : ''
                            }
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              if (val > 0) handleSelectSingleDisc(val);
                            }}
                            className="px-2 py-0.5 text-[11px] font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-1 focus:ring-[#5BA632]"
                          >
                            <option value="">CD wählen…</option>
                            {trackDistinctDiscs.map((dNum) => (
                              <option key={dNum} value={dNum}>
                                Nur CD {dNum}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}
                    <span className="hidden md:inline text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      Ziehen zum Umsortieren oder WAV/FLAC/MP3 hier ablegen
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {!album.isClassical ? (
                      <button
                        type="button"
                        disabled={
                          (album.tracks.length > 0 && selectedCount === 0) ||
                          (album.tracks.length === 0 && !album.artist.trim() && !(album.albumArtist || '').trim()) ||
                          (album.tracks.length > 0 &&
                            !allSelected &&
                            !album.tracks.some((t) => t.selected && Boolean(t.artist.trim()))) ||
                          verifyingField !== null
                        }
                        onClick={() => onVerifyField('artist')}
                        title="Prüft die Interpretennamen der ausgewählten Titel (; getrennte Mehrfachwerte) online über MusicBrainz & Wikidata, korrigiert Schreibfehler und stellt internationalisierte Künstlernamen sicher."
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-semibold rounded border border-[#5BA632]/50 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] hover:bg-[#5BA632]/20 disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <SystemIcon
                          name={verifyingField === 'artist' ? 'refresh_disc' : 'verify_artists'}
                          className={`w-3.5 h-3.5 ${verifyingField === 'artist' ? 'animate-spin' : ''}`}
                        />
                        <span>
                          {verifyingField === 'artist' ? 'Prüfe Interpreten...' : 'Interpreten prüfen'}
                        </span>
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={
                            (album.tracks.length > 0 && selectedCount === 0) ||
                            (!(allSelected || album.tracks.length === 0 ? (album.composer || '').trim() : '') &&
                              !album.tracks.some((t) => t.selected && Boolean((t.composer || '').trim()))) ||
                            verifyingField !== null
                          }
                          onClick={() => onVerifyField('composer')}
                          title="Prüft die Komponisten der ausgewählten Titel (;-getrennte Mehrfachwerte) online über MusicBrainz & Wikidata, korrigiert Schreibfehler und internationalisiert Namen."
                          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-semibold rounded border border-[#5BA632]/50 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] hover:bg-[#5BA632]/20 disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
                        >
                          <SystemIcon
                            name={verifyingField === 'composer' ? 'refresh_disc' : 'verify_artists'}
                            className={`w-3.5 h-3.5 ${verifyingField === 'composer' ? 'animate-spin' : ''}`}
                          />
                          <span>
                            {verifyingField === 'composer' ? 'Prüfe Komponist...' : 'Komponist prüfen'}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={
                            (album.tracks.length > 0 && selectedCount === 0) ||
                            (!(allSelected || album.tracks.length === 0 ? (album.orchestra || '').trim() : '') &&
                              !album.tracks.some((t) => t.selected && Boolean((t.orchestra || '').trim()))) ||
                            verifyingField !== null
                          }
                          onClick={() => onVerifyField('orchestra')}
                          title="Prüft die Orchester der ausgewählten Titel (;-getrennte Mehrfachwerte) online über MusicBrainz & Wikidata, korrigiert Schreibfehler und internationalisiert Namen."
                          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-semibold rounded border border-[#5BA632]/50 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] hover:bg-[#5BA632]/20 disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
                        >
                          <SystemIcon
                            name={verifyingField === 'orchestra' ? 'refresh_disc' : 'verify_orchestra'}
                            className={`w-3.5 h-3.5 ${verifyingField === 'orchestra' ? 'animate-spin' : ''}`}
                          />
                          <span>
                            {verifyingField === 'orchestra' ? 'Prüfe Orchester...' : 'Orchester prüfen'}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={
                            (album.tracks.length > 0 && selectedCount === 0) ||
                            (!(allSelected || album.tracks.length === 0 ? (album.conductor || '').trim() : '') &&
                              !album.tracks.some((t) => t.selected && Boolean((t.conductor || '').trim()))) ||
                            verifyingField !== null
                          }
                          onClick={() => onVerifyField('conductor')}
                          title="Prüft die Dirigenten der ausgewählten Titel (;-getrennte Mehrfachwerte) online über MusicBrainz & Wikidata, korrigiert Schreibfehler und internationalisiert Namen."
                          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-semibold rounded border border-[#5BA632]/50 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] hover:bg-[#5BA632]/20 disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
                        >
                          <SystemIcon
                            name={verifyingField === 'conductor' ? 'refresh_disc' : 'verify_artists'}
                            className={`w-3.5 h-3.5 ${verifyingField === 'conductor' ? 'animate-spin' : ''}`}
                          />
                          <span>
                            {verifyingField === 'conductor' ? 'Prüfe Dirigent...' : 'Dirigent prüfen'}
                          </span>
                        </button>
                      </>
                    )}
                    {verifyingField !== null && (
                      <button
                        type="button"
                        onClick={onCancelVerifyField}
                        title="Laufende Online-Prüfung sofort stoppen (z. B. bei MusicBrainz Rate-Limit). Bereits geprüfte Änderungen bleiben erhalten."
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-semibold rounded border border-[#CF222E]/60 bg-[#CF222E]/10 text-[#CF222E] dark:text-[#FF7B72] hover:bg-[#CF222E]/20 transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <SystemIcon name="stop_batch" className="w-3.5 h-3.5" />
                        <span>Abfrage stoppen</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={
                        (album.tracks.length > 0 && selectedCount === 0) ||
                        (album.tracks.length === 0 &&
                          !album.artist.trim() &&
                          !(album.albumArtist || '').trim()) ||
                        verifyingField !== null ||
                        isBatchActivelyRunning
                      }
                      onClick={handleSplitArtists}
                      title="Trennt verkettete Interpreten in den ausgewählten Titeln (z. B. „A, B & C“ → „A; B; C“ unter Schutz echter Bandnamen) und übernimmt Feature-Zusätze ins Interpretenfeld."
                      className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
                    >
                      <SystemIcon name="split_artists" className="w-3.5 h-3.5" />
                      <span>Interpretensplitter</span>
                    </button>
                    <div ref={analyzeTracksMenuRef} className="relative inline-flex items-center">
                      <button
                        type="button"
                        disabled={selectedCount === 0 || isShazamingAll || isAnalyzingMbTracks}
                        aria-haspopup="menu"
                        aria-expanded={isAnalyzeTracksMenuOpen}
                        onClick={() => setIsAnalyzeTracksMenuOpen((prev) => !prev)}
                        title="Ausgewählte Titel per MusicBrainz (Einzeltrack + Wikidata-Genre) oder Shazam analysieren"
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-semibold rounded border border-[#0284C7]/50 bg-[#0284C7]/10 text-[#0369A1] dark:text-[#38BDF8] hover:bg-[#0284C7]/20 disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <SystemIcon
                          name={
                            isShazamingAll || isAnalyzingMbTracks
                              ? 'refresh_disc'
                              : 'search_online'
                          }
                          className={`w-3.5 h-3.5 ${
                            isShazamingAll || isAnalyzingMbTracks ? 'animate-spin' : ''
                          }`}
                        />
                        <span>
                          {isAnalyzingMbTracks
                            ? 'Musikbrainz läuft...'
                            : isShazamingAll
                              ? 'Shazam läuft...'
                              : 'Markierte Tracks analysieren'}
                        </span>
                        <ChevronDown className="w-3.5 h-3.5 opacity-80 shrink-0" />
                      </button>
                      {isAnalyzeTracksMenuOpen && !isShazamingAll && !isAnalyzingMbTracks && (
                        <div
                          role="menu"
                          className="absolute right-0 top-full mt-1 z-40 min-w-[230px] py-1 rounded-md border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] shadow-lg"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            disabled={!onAnalyzeMbTracks || selectedCount === 0}
                            onClick={() => {
                              setIsAnalyzeTracksMenuOpen(false);
                              onAnalyzeMbTracks?.();
                            }}
                            className="w-full px-3 py-1.5 text-left text-xs font-medium flex items-center gap-2 text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 transition-colors cursor-pointer"
                          >
                            <SystemIcon
                              name="search_online"
                              className="w-3.5 h-3.5 text-[#9B2C74] dark:text-[#E88BC3] shrink-0"
                            />
                            <span>Mit Musikbrainz analysieren</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={selectedCount === 0}
                            onClick={() => {
                              setIsAnalyzeTracksMenuOpen(false);
                              onShazamAllTracks();
                            }}
                            className="w-full px-3 py-1.5 text-left text-xs font-medium flex items-center gap-2 text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 transition-colors cursor-pointer"
                          >
                            <SystemIcon
                              name="shazam"
                              className="w-3.5 h-3.5 text-[#0369A1] dark:text-[#38BDF8] shrink-0"
                            />
                            <span>Mit Shazam analysieren</span>
                          </button>
                        </div>
                      )}
                    </div>
                    {isShazamingAll && (
                      <button
                        type="button"
                        onClick={onCancelShazamAll}
                        title="Laufende Shazam-Abfrage sofort stoppen. Bereits gefundene Treffer bleiben erhalten."
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-semibold rounded border border-[#CF222E]/60 bg-[#CF222E]/10 text-[#CF222E] dark:text-[#FF7B72] hover:bg-[#CF222E]/20 transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <SystemIcon name="stop_batch" className="w-3.5 h-3.5" />
                        <span>Shazam stoppen</span>
                      </button>
                    )}
                    {isAnalyzingMbTracks && onCancelAnalyzeMbTracks && (
                      <button
                        type="button"
                        onClick={onCancelAnalyzeMbTracks}
                        title="Laufende MusicBrainz-Einzeltrackanalyse sofort stoppen. Bereits aktualisierte Titel bleiben erhalten."
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-semibold rounded border border-[#CF222E]/60 bg-[#CF222E]/10 text-[#CF222E] dark:text-[#FF7B72] hover:bg-[#CF222E]/20 transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <SystemIcon name="stop_batch" className="w-3.5 h-3.5" />
                        <span>Musikbrainz stoppen</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={album.tracks.length > 0 && selectedCount === 0}
                      onClick={handleApplyTitleCase}
                      title="Groß-/Kleinschreibung (Title Case) auf die ausgewählten Titel anwenden"
                      className="px-2 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 whitespace-nowrap"
                    >
                      Title Case
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const picked = await pickDirectoryWithPersistence();
                        if (picked.status === 'picked') {
                          stopTrackPreview(false);
                          setCoverImgFailed(false);
                          onSettingsChange((prev) => ({
                            ...prev,
                            lastImportFolder: picked.folderName,
                          }));
                          onAudioFilesDrop(picked.files);
                        } else if (picked.status === 'fallback_input') {
                          audioInputRef.current?.click();
                        }
                      }}
                      title={`Ein komplettes Album-Verzeichnis laden (Letzter Ort: ${
                        settings.lastImportFolder || '~/Musik'
                      })`}
                      className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] whitespace-nowrap"
                    >
                      <SystemIcon name="open_file" className="w-3.5 h-3.5" />
                      <span>Album-Ordner laden</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleAddManualTrack}
                      className="px-2 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] whitespace-nowrap"
                    >
                      + Titel
                    </button>
                    <input
                      ref={audioInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files && e.target.files.length > 0) {
                          stopTrackPreview(false);
                          setCoverImgFailed(false);
                          onAudioFilesDrop(e.target.files);
                          e.target.value = '';
                        }
                      }}
                    />
                  </div>
                </div>

                {/* Datentabelle */}
                {album.tracks.length === 0 ? (
                  <div className="p-10 text-center space-y-3 bg-white dark:bg-[#25292E]">
                    <div className="mx-auto w-10 h-10 rounded-full bg-[#F4F5F6] dark:bg-[#1C1F23] flex items-center justify-center text-[#656D76]">
                      <SystemIcon name="audio_track" className="w-5 h-5" />
                    </div>
                    <p className="text-sm font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                      Keine Titel in der Liste
                    </p>
                    <p className="text-xs text-[#57606A] dark:text-[#8B949E]">
                      Suche oben in Display 1 nach einem Release, lies eine CD ein oder ziehe lokale WAV/FLAC-Dateien hierher.
                    </p>
                    <button
                      type="button"
                      onClick={handleAddManualTrack}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded bg-[#5BA632] text-white hover:bg-[#4E922A]"
                    >
                      <SystemIcon name="add_files" className="w-3.5 h-3.5" />
                      <span>Ersten Titel anlegen</span>
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-hidden bg-white dark:bg-[#25292E]">
                    <table className="w-full table-fixed text-left border-collapse">
                      <thead>
                        <tr className="border-b border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 text-[11px] font-semibold text-[#57606A] dark:text-[#8B949E]">
                          <th className="w-6 py-2 pl-2 pr-0.5"></th>
                          <th className="w-6 py-2 px-1 text-center">✓</th>
                          {moduleMode === 'album_tag' && (
                            <th
                              className="w-6 py-2 px-0.5 text-center"
                              title="Dateizustand (Farbcode wie Modul 5) — erneute Prüfung & Reparatur erfolgt in Modul 5"
                              aria-label="Dateizustand"
                            />
                          )}
                          <th className={isMultiDiscAlbum ? 'w-16 py-2 px-1' : 'w-8 py-2 px-1'}>#</th>
                          <th className="py-2 px-1.5">Titel</th>
                          <th className="py-2 px-1.5">Interpret (; getrennt)</th>
                          <th className="py-2 px-1.5 w-[88px]">ISRC</th>
                          <th className="py-2 px-1.5 w-14 text-right">Länge</th>
                          <th className="py-2 px-1.5 w-[64px] text-center">Vorhören</th>
                          <th className="w-7 py-2 pr-2 pl-0.5"></th>
                        </tr>
                      </thead>
                      <tbody className="text-xs">
                        {album.tracks.map((track, idx) => {
                          const isTrackPlaying = playingTrackId === track.id;
                          const effDisc = Math.max(1, track.discNumber || album.discNumber || 1);
                          const prevDisc =
                            idx > 0
                              ? Math.max(
                                  1,
                                  album.tracks[idx - 1].discNumber || album.discNumber || 1
                                )
                              : effDisc;
                          const showDiscHeader =
                            isMultiDiscAlbum && (idx === 0 || effDisc !== prevDisc);
                          const sameDiscCount = album.tracks.filter(
                            (t) => Math.max(1, t.discNumber || album.discNumber || 1) === effDisc
                          ).length;
                          const colCount = moduleMode === 'album_tag' ? 10 : 9;
                          const isActiveTrackRow = activeTrack?.id === track.id;
                          const discSub =
                            track.discSubtitle ||
                            album.discs?.find((d) => d.position === effDisc)?.title ||
                            '';
                          return (
                            <React.Fragment key={track.id}>
                              {showDiscHeader && idx > 0 && (
                                <tr
                                  aria-hidden="true"
                                  className="bg-transparent pointer-events-none"
                                >
                                  <td colSpan={colCount} className="h-6 p-0 bg-transparent" />
                                </tr>
                              )}
                              {showDiscHeader && (
                                <tr className="bg-[#EFF2F5] dark:bg-[#1C1F23] border-y border-[#D0D7DE] dark:border-[#343A40]">
                                  <td colSpan={colCount} className="px-3 py-1.5">
                                    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                                      <span>
                                        CD {formatIndexNumber(effDisc, album.totalDiscs)}
                                        {discSub ? ` — ${discSub}` : ''}
                                      </span>
                                      <span className="text-[11px] font-normal text-[#57606A] dark:text-[#8B949E] tabular-nums">
                                        {sameDiscCount} Titel
                                      </span>
                                    </div>
                                  </td>
                                </tr>
                              )}
                              <tr
                                draggable={!isBatchActivelyRunning}
                                onClick={() => setActiveTrackId(track.id)}
                                onFocus={() => setActiveTrackId(track.id)}
                                onDragStart={() => {
                                  if (!isBatchActivelyRunning) setDraggedTrackIdx(idx);
                                }}
                                onDragOver={(e) => {
                                  if (!isBatchActivelyRunning && draggedTrackIdx !== null) {
                                    e.preventDefault();
                                    setDragTargetIdx(idx);
                                  }
                                }}
                                onDrop={() => {
                                  if (!isBatchActivelyRunning) handleTrackReorderDrop(idx);
                                }}
                                onDragEnd={() => {
                                  setDraggedTrackIdx(null);
                                  setDragTargetIdx(null);
                                }}
                                className={`h-9 border-b border-[#E1E4E8] dark:border-[#343A40] transition-colors hover:bg-[#F8F9FA] dark:hover:bg-[#2D333B]/60 ${
                                  dragTargetIdx === idx
                                    ? 'bg-[#5BA632]/15'
                                    : isActiveTrackRow
                                      ? 'bg-[#5BA632]/10 dark:bg-[#5BA632]/15 shadow-[inset_3px_0_0_0_#5BA632]'
                                      : ''
                                }`}
                              >
                              <td className="pl-2 pr-0.5 text-[#8C959F] cursor-grab active:cursor-grabbing">
                                <SystemIcon name="drag_handle" className="w-3.5 h-3.5" />
                              </td>
                              <td className="px-1 text-center">
                                <input
                                  type="checkbox"
                                  aria-label={`Titel ${track.trackNumber} auswählen`}
                                  checked={track.selected}
                                  onChange={(e) => {
                                    const nextSelected = e.target.checked;
                                    updateTrackField(track.id, 'selected', nextSelected);
                                    onAppendQueryLog(
                                      `[Auswahl] ${isMultiDiscAlbum ? `CD ${effDisc} · ` : ''}Titel #${formatIndexNumber(track.trackNumber, sameDiscCount || album.tracks.length)} „${track.title}“ ${nextSelected ? 'ausgewählt' : 'abgewählt'}.`
                                    );
                                  }}
                                  className="accent-[#5BA632]"
                                />
                              </td>
                              {moduleMode === 'album_tag' && (
                                <td className="px-0.5 text-center align-middle">
                                  {track.audioHealthStatus ? (
                                    <span
                                      title={
                                        track.audioHealthTooltip ||
                                        (track.audioHealthStatus === 'scanning'
                                          ? 'Audiodatei wird im Hintergrund geprüft…'
                                          : 'Dateizustand (Farbcode wie Modul 5)')
                                      }
                                      aria-label={
                                        track.audioHealthTooltip ||
                                        `Dateizustand: ${track.audioHealthStatus}`
                                      }
                                      className={`inline-block w-2.5 h-5 rounded-sm align-middle ${
                                        track.audioHealthStatus === 'scanning' ? 'animate-pulse' : ''
                                      }`}
                                      style={{
                                        backgroundColor: track.audioHealthColor || '#94A3B8',
                                      }}
                                    />
                                  ) : (
                                    <span className="text-[#8C959F]" title="Keine lokale Audiodatei">
                                      —
                                    </span>
                                  )}
                                </td>
                              )}
                              <td className="px-1 font-mono tabular-nums text-[#57606A] dark:text-[#8B949E] whitespace-nowrap">
                                {isMultiDiscAlbum
                                  ? `CD${effDisc}·${formatIndexNumber(track.trackNumber, sameDiscCount || album.tracks.length)}`
                                  : formatIndexNumber(track.trackNumber, album.tracks.length)}
                              </td>
                              <td className="px-1.5 py-0.5 min-w-0">
                                <div className="flex items-center gap-1 min-w-0">
                                  <input
                                    type="text"
                                    value={track.title}
                                    onChange={(e) => updateTrackField(track.id, 'title', e.target.value)}
                                    onBlur={(e) =>
                                      onAppendQueryLog(
                                        `[Metadaten] Titel #${formatIndexNumber(track.trackNumber, album.tracks.length)} umbenannt in „${e.target.value.trim() || '—'}“.`
                                      )
                                    }
                                    className="flex-1 min-w-0 px-1 py-0 rounded border border-transparent hover:border-[#D0D7DE] dark:hover:border-[#444C56] focus:border-[#5BA632] bg-transparent text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none"
                                  />
                                  {track.hasShazamAlternative || track.hasMbAlternative ? (
                                    (() => {
                                      const activeVar =
                                        track.activeMetadataVariant ||
                                        (track.hasMbAlternative ? 'musicbrainz' : 'shazam');
                                      const isOrig = activeVar === 'original';
                                      const isMb = activeVar === 'musicbrainz';
                                      const tooltipLines: string[] = [];
                                      if (isOrig) {
                                        tooltipLines.push(
                                          `Aktiv: Original („${track.originalArtist || '—'} – ${track.originalTitle || '—'}“ · Genre: ${track.originalGenre || '—'})`
                                        );
                                      } else if (isMb) {
                                        tooltipLines.push(
                                          `Aktiv: MusicBrainz („${track.mbArtist || '—'} – ${track.mbTitle || '—'}“ · Genre: ${track.mbGenre || '—'})`
                                        );
                                      } else {
                                        tooltipLines.push(
                                          `Aktiv: Shazam („${track.shazamArtist || '—'} – ${track.shazamTitle || '—'}“ · Genre: ${track.shazamGenre || '—'})`
                                        );
                                      }
                                      if (!isOrig) {
                                        tooltipLines.push(
                                          `Original: „${track.originalArtist || '—'} – ${track.originalTitle || '—'}“ · Genre: ${track.originalGenre || '—'}`
                                        );
                                      }
                                      if (track.hasMbAlternative && !isMb) {
                                        tooltipLines.push(
                                          `MusicBrainz: „${track.mbArtist || '—'} – ${track.mbTitle || '—'}“ · Genre: ${track.mbGenre || '—'}`
                                        );
                                      }
                                      if (track.hasShazamAlternative && activeVar !== 'shazam') {
                                        tooltipLines.push(
                                          `Shazam: „${track.shazamArtist || '—'} – ${track.shazamTitle || '—'}“ · Genre: ${track.shazamGenre || '—'}`
                                        );
                                      }
                                      tooltipLines.push(
                                        'Klick schaltet zwischen den gespeicherten Ergebnissen um.'
                                      );
                                      return (
                                        <button
                                          type="button"
                                          onClick={() => handleToggleTrackShazamVariant(track.id)}
                                          title={tooltipLines.join('\n')}
                                          className={`shrink-0 max-w-[118px] truncate px-1.5 py-0 text-[10px] font-mono font-semibold rounded border whitespace-nowrap cursor-pointer transition-colors ${
                                            isOrig
                                              ? 'border-[#D97706]/50 bg-[#FEF3C7]/85 text-[#B45309] hover:bg-[#FDE68A]/90 dark:border-[#F59E0B]/50 dark:bg-[#F59E0B]/20 dark:text-[#FCD34D] dark:hover:bg-[#F59E0B]/30'
                                              : isMb
                                                ? 'border-[#BA478F]/55 bg-[#FCE7F3]/85 text-[#9B2C74] hover:bg-[#FBCFE8]/90 dark:border-[#E88BC3]/45 dark:bg-[#BA478F]/25 dark:text-[#F4A7D6] dark:hover:bg-[#BA478F]/35'
                                                : 'border-[#0284C7]/50 bg-[#E0F2FE]/85 text-[#0369A1] hover:bg-[#BAE6FD]/90 dark:border-[#38BDF8]/45 dark:bg-[#0284C7]/25 dark:text-[#7DD3FC] dark:hover:bg-[#0284C7]/35'
                                          }`}
                                        >
                                          {isOrig
                                            ? 'Original ⇄'
                                            : isMb
                                              ? 'MusicBrainz ⇄'
                                              : `${track.shazamMetadataSource || 'Shazam'} ⇄`}
                                        </button>
                                      );
                                    })()
                                  ) : (
                                    (track.metadataSource || album.metadataSource) && (
                                      <span
                                        title={`Metadaten-Quelle aus Online-Abgleich: ${track.metadataSource || album.metadataSource}`}
                                        className={`shrink-0 max-w-[78px] truncate px-1 py-0 text-[10px] font-mono font-medium rounded border whitespace-nowrap ${
                                          (track.metadataSource || album.metadataSource)?.toLowerCase().includes('shazam')
                                            ? 'border-[#0284C7]/45 bg-[#E0F2FE]/80 text-[#0369A1] dark:border-[#38BDF8]/40 dark:bg-[#0284C7]/20 dark:text-[#7DD3FC]'
                                            : (track.metadataSource || album.metadataSource)?.toLowerCase().includes('discogs')
                                              ? 'border-[#D97706]/40 bg-[#FEF3C7]/60 text-[#B45309] dark:border-[#F59E0B]/40 dark:bg-[#F59E0B]/15 dark:text-[#FBBF24]'
                                              : (track.metadataSource || album.metadataSource)?.toLowerCase().includes('cddb')
                                                ? 'border-[#2563EB]/40 bg-[#DBEAFE]/60 text-[#1D4ED8] dark:border-[#60A5FA]/40 dark:bg-[#3B82F6]/15 dark:text-[#93C5FD]'
                                                : 'border-[#5BA632]/40 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270]'
                                        }`}
                                      >
                                        {track.metadataSource || album.metadataSource}
                                      </span>
                                    )
                                  )}
                                </div>
                                {track.sourceFileName && (
                                  <div className="px-1 text-[11px] text-[#57606A] dark:text-[#8B949E] truncate">
                                    Lokale Datei: {track.sourceFileName}
                                  </div>
                                )}
                              </td>
                              <td className="px-1.5 py-0.5 min-w-0">
                                <input
                                  type="text"
                                  value={track.artist}
                                  onChange={(e) => updateTrackField(track.id, 'artist', e.target.value)}
                                  onBlur={(e) => {
                                    const norm = normalizeMultiArtist(e.target.value);
                                    updateTrackField(track.id, 'artist', norm);
                                    onAppendQueryLog(
                                      `[Metadaten] Interpret für Titel #${formatIndexNumber(track.trackNumber, album.tracks.length)} gesetzt auf „${norm || '—'}“.`
                                    );
                                  }}
                                  className="w-full min-w-0 px-1 py-0 rounded border border-transparent hover:border-[#D0D7DE] dark:hover:border-[#444C56] focus:border-[#5BA632] bg-transparent text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none"
                                />
                              </td>
                              <td className="px-2 py-0.5">
                                <input
                                  type="text"
                                  value={track.isrc}
                                  placeholder="—"
                                  onChange={(e) => updateTrackField(track.id, 'isrc', e.target.value)}
                                  onBlur={(e) =>
                                    onAppendQueryLog(
                                      `[Metadaten] ISRC für Titel #${formatIndexNumber(track.trackNumber, album.tracks.length)} gesetzt auf „${e.target.value.trim() || '—'}“.`
                                    )
                                  }
                                  className="w-full px-1.5 py-0 font-mono text-[11px] rounded border border-transparent hover:border-[#D0D7DE] dark:hover:border-[#444C56] focus:border-[#5BA632] bg-transparent text-[#57606A] dark:text-[#8B949E] focus:outline-none"
                                />
                              </td>
                              <td className="px-2 text-right font-mono tabular-nums text-[#57606A] dark:text-[#8B949E]">
                                {formatDuration(track.durationSeconds)}
                              </td>
                              <td className="px-1.5 text-center">
                                {(() => {
                                  const canPlayTrack =
                                    Boolean(track.sourceFile) || moduleMode === 'cd_rip';
                                  return (
                                    <button
                                      type="button"
                                      disabled={!canPlayTrack}
                                      aria-label={
                                        isTrackPlaying
                                          ? `Wiedergabe von ${track.title} stoppen`
                                          : `Titel ${track.title} abspielen`
                                      }
                                      onClick={() => {
                                        if (isTrackPlaying) {
                                          stopTrackPreview(true);
                                        } else {
                                          void handlePlayTrack(track);
                                        }
                                      }}
                                      title={
                                        !canPlayTrack
                                          ? 'Vorhören ist in diesem Modul nur für geladene Audiodateien verfügbar'
                                          : isTrackPlaying
                                            ? 'Wiedergabe stoppen'
                                            : `Titel #${formatIndexNumber(track.trackNumber, album.tracks.length)} „${track.title}“ abspielen`
                                      }
                                      className={`inline-flex items-center justify-center p-1 rounded border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                                        isTrackPlaying
                                          ? 'border-[#5BA632] bg-[#5BA632] text-white hover:border-[#DC2626] hover:bg-[#DC2626]'
                                          : 'border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/15 hover:text-[#2E6B14] dark:hover:text-[#9BE270]'
                                      }`}
                                    >
                                      <SystemIcon
                                        name={isTrackPlaying ? 'media_stop' : 'media_play'}
                                        className="w-3 h-3"
                                      />
                                    </button>
                                  );
                                })()}
                              </td>
                              <td className="pr-3 pl-1 text-right">
                                <button
                                  type="button"
                                  aria-label={`Titel ${track.title} entfernen`}
                                  onClick={() => handleRemoveTrack(track.id)}
                                  className="p-0.5 rounded text-[#656D76] hover:text-[#DC2626] hover:bg-[#DC2626]/10 transition-colors"
                                >
                                  <SystemIcon name="remove_item" className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Export-Aktionsleiste & Pfadvorschau */}
                {(() => {
                  const isImportedFolderOnly =
                    album.tracks.length > 0 && album.tracks.every((t) => Boolean(t.sourceFileName));
                  const convertFlacActive =
                    moduleMode === 'album_tag' && isImportedFolderOnly && convertImportedToFlac;
                  const flacPreviewSettings = convertFlacActive
                    ? { ...settings, exportFormat: 'flac' as const }
                    : settings;
                  return (
                    <div className="p-3.5 border-t border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 flex flex-col gap-3">
                      {moduleMode === 'album_tag' && isImportedFolderOnly && (
                        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#E1E4E8] dark:border-[#343A40]">
                          <label className="inline-flex items-center gap-2 text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2] cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={convertImportedToFlac}
                              onChange={(e) => setConvertImportedToFlac(e.target.checked)}
                              className="accent-[#5BA632] rounded"
                            />
                            <span>
                              In FLAC umwandeln (2-Schritt: erst nach WAV, danach nach FLAC · Bitraten exakt · Tags &amp; Cover beibehalten)
                            </span>
                          </label>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="text-[11px] font-medium text-[#57606A] dark:text-[#8B949E]">
                            {convertFlacActive
                              ? 'Vorschau Zieldatei (Quelle → WAV → FLAC inkl. Tags):'
                              : isImportedFolderOnly
                                ? 'Zieldatei für Tag-Schreibvorgang (Titel 1):'
                                : 'Vorschau Zieldatei (Titel 1):'}
                          </div>
                          <div className="text-xs font-mono truncate text-[#1F2328] dark:text-[#EAEEF2]">
                            {convertFlacActive && album.tracks[0]
                              ? `${formatOutputStem(album, album.tracks[0], flacPreviewSettings)}.flac`
                              : isImportedFolderOnly
                                ? `${album.tracks[0]?.sourceFileName || '—'} (Direktes Tag-Update ohne Re-Rip)`
                                : album.tracks[0]
                                  ? `${formatOutputStem(album, album.tracks[0], settings)}.${
                                      settings.exportFormat === 'mp3' ? 'mp3' : 'flac'
                                    }`
                                  : settings.outputDir}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={album.tracks.length === 0}
                            onClick={() => {
                              const cueName = `${album.artist || 'album'} - ${album.title || 'cd'}.cue`;
                              triggerTextDownload(cueName, buildCueSheetContent(album));
                              onAppendQueryLog(`[Export] CUE-Sheet „${cueName}“ erstellt und heruntergeladen.`);
                            }}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 whitespace-nowrap"
                          >
                            <SystemIcon name="save_export" className="w-3.5 h-3.5" />
                            <span>CUE speichern</span>
                          </button>

                          <button
                            type="button"
                            disabled={selectedCount === 0}
                            onClick={() => {
                              triggerTextDownload(
                                'mintrip_batch.sh',
                                buildMintRipShellScript(album, flacPreviewSettings, devicePath, {
                                  convertLocalToFlac: convertFlacActive,
                                })
                              );
                              onAppendQueryLog(
                                `[Export] Bash-Skript „mintrip_batch.sh“ für ${selectedCount} ausgewählte Titel erstellt und heruntergeladen${
                                  convertFlacActive ? ' (2-Schritt Quelle → WAV → FLAC inkl. Tags)' : ''
                                }.`
                              );
                            }}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 whitespace-nowrap"
                          >
                            <SystemIcon name="save_export" className="w-3.5 h-3.5" />
                            <span>Bash-Skript</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </fieldset>
            </div>
          )}
        </details>

        {/* Display 3: Stapelverarbeitung */}
        <details
          open={activeRightDisplay === 'batch'}
          className="bg-white dark:bg-[#25292E] border border-[#DCDCE4] dark:border-[#343A40] rounded-lg shadow-[0_2px_4px_rgba(0,0,0,0.05)] overflow-hidden"
        >
          <summary
            onClick={(e) => {
              e.preventDefault();
              if (!isBatchActivelyRunning) onToggleRightDisplay('batch');
            }}
            aria-disabled={isBatchActivelyRunning}
            className={`list-none [&::-webkit-details-marker]:hidden px-3 py-1.5 flex items-center justify-between gap-3 bg-[#F8F9FA] dark:bg-[#1C1F23]/60 transition-colors select-none ${
              activeRightDisplay === 'batch' ? 'border-b border-[#DCDCE4] dark:border-[#343A40]' : ''
            } ${
              isBatchActivelyRunning
                ? 'cursor-default'
                : 'cursor-pointer hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B]'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <SystemIcon name="batch_queue" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0" />
              <span className="font-semibold text-sm text-[#1F2328] dark:text-[#EAEEF2] truncate">
                Stapelverarbeitung ({jobs.length} Aufträge)
              </span>
              {isBatchActivelyRunning && (
                <span className="px-1.5 py-0 text-[10px] font-mono font-semibold rounded border border-[#5BA632]/40 bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270] shrink-0">
                  Läuft · Steuerung gesperrt
                </span>
              )}
              {isBatchRunning && isBatchPaused && (
                <span className="px-1.5 py-0 text-[10px] font-mono font-semibold rounded border border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300 shrink-0">
                  Pausiert · Bearbeiten möglich
                </span>
              )}
            </div>
            <span
              aria-hidden="true"
              className="text-lg font-normal leading-none text-[#555555] dark:text-[#8B949E] shrink-0"
            >
              {activeRightDisplay === 'batch' ? '−' : '+'}
            </span>
          </summary>

          {activeRightDisplay === 'batch' && (
            <div className="bg-[#FAFAFA] dark:bg-[#1C1F23]/40 p-4">
              <BatchQueueView
                embedded
                jobs={jobs}
                isRunning={isBatchRunning}
                isPaused={isBatchPaused}
                isLockedDuringRun={isBatchActivelyRunning}
                onStartAll={onBatchStartAll}
                onTogglePause={onBatchTogglePause}
                onCancelAll={onBatchCancelAll}
                onClearFinished={onBatchClearFinished}
                onRetryJob={onBatchRetryJob}
                onRemoveJob={onBatchRemoveJob}
                onDropFilesToBatch={onBatchDropFiles}
              />
            </div>
          )}
        </details>
          </>
        )}
      </div>

      {/* Ziehbarer Trennbalken zwischen Spalte 2 und Spalte 3 (Modul 2 & 3) */}
      {moduleMode !== 'cover_only' &&
        (isTrackColumnCollapsed ? (
          <div className="hidden lg:block w-3 shrink-0" aria-hidden="true" />
        ) : (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Breite der rechten Track-Spalte anpassen"
            title="Breite der Track-Spalte durch Ziehen anpassen (Doppelklick zum Zurücksetzen)"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              splitDragRef.current = {
                side: 'right',
                startX: e.clientX,
                startWidth: rightColWidth,
              };
              setActiveSplitter('right');
            }}
            onDoubleClick={() => setRightColWidth(400)}
            className="hidden lg:flex w-3 shrink-0 self-stretch cursor-col-resize items-center justify-center group select-none touch-none"
          >
            <span
              className={`w-[3px] h-16 rounded-full transition-colors ${
                activeSplitter === 'right'
                  ? 'bg-[#5BA632]'
                  : 'bg-[#D0D7DE] dark:bg-[#343A40] group-hover:bg-[#5BA632]'
              }`}
            />
          </div>
        ))}

      {/* Rechte 3. Spalte (Modul 2 & 3): Felder, die ausschließlich den ausgewählten Track betreffen (skalierbar, ein- und ausklappbar) */}
      {moduleMode !== 'cover_only' && (
        <aside
          aria-label="Track-Felder (rechter Bereich)"
          aria-disabled={isBatchActivelyRunning}
          className={`w-full ${
            isTrackColumnCollapsed ? 'lg:w-10' : 'lg:w-[var(--wb-right-w,400px)] lg:min-w-[400px]'
          } lg:shrink-0 min-w-0 bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg transition-opacity flex flex-col ${
            isBatchActivelyRunning ? 'opacity-60' : ''
          }`}
        >
          {isTrackColumnCollapsed ? (
            <button
              type="button"
              onClick={() => setIsTrackColumnCollapsed(false)}
              title={
                isAlbumPreviewMode
                  ? 'Rechte Spalte (Album-Tracks) ausklappen'
                  : 'Rechte Track-Spalte ausklappen'
              }
              aria-label={
                isAlbumPreviewMode
                  ? 'Rechte Spalte (Album-Tracks) ausklappen'
                  : 'Rechte Track-Spalte ausklappen'
              }
              className="w-full h-full py-3 px-2 lg:px-0 lg:min-h-[320px] flex lg:flex-col items-center justify-center lg:justify-start gap-2.5 text-[#57606A] dark:text-[#8B949E] hover:text-[#1F2328] dark:hover:text-[#EAEEF2] hover:bg-[#F8F9FA] dark:hover:bg-[#2D333B]/60 rounded-lg transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0" />
              <span className="text-xs font-semibold tracking-wide lg:[writing-mode:vertical-rl] lg:rotate-180 select-none">
                {isAlbumPreviewMode ? 'Album-Tracks' : 'Track-Felder'}
              </span>
            </button>
          ) : (
            <div className="flex flex-col flex-1 min-w-0">
              {/* Spaltenkopf mit Einklappen-Schaltfläche */}
              <div className="px-2.5 py-2 border-b border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 flex items-center justify-between gap-2 rounded-t-lg">
                <div className="flex items-center gap-1.5 min-w-0">
                  <SystemIcon
                    name="audio_track"
                    className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                  />
                  <span className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate">
                    {isAlbumPreviewMode ? 'Album-Tracks' : 'Track-Felder'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsTrackColumnCollapsed(true)}
                  title="Rechte Spalte einklappen"
                  aria-label="Rechte Spalte einklappen"
                  className="p-1 rounded border border-transparent text-[#57606A] dark:text-[#8B949E] hover:text-[#1F2328] dark:hover:text-[#EAEEF2] hover:border-[#D0D7DE] dark:hover:border-[#444C56] hover:bg-white dark:hover:bg-[#2D333B] transition-colors shrink-0 cursor-pointer"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>

              {isAlbumPreviewMode ? (
                <div className="relative flex flex-col flex-1 min-w-0 text-xs overflow-hidden rounded-b-lg">
                  {(Boolean(hitTrackPreview?.loading) || isLoadingRelease) && (
                    <div
                      role="status"
                      aria-live="polite"
                      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[#1C1F23]/70 dark:bg-[#0D1117]/75 backdrop-blur-[1.5px] text-white px-4 text-center"
                    >
                      <svg
                        viewBox="0 0 52 52"
                        className="w-11 h-11 animate-[spin_2.4s_linear_infinite]"
                        aria-hidden="true"
                      >
                        <circle
                          cx="26"
                          cy="26"
                          r="20"
                          fill="none"
                          stroke="rgba(255,255,255,0.24)"
                          strokeWidth="4"
                        />
                        <path
                          d="M 26 6 A 20 20 0 0 1 44.5 18.4"
                          fill="none"
                          stroke="#10B981"
                          strokeWidth="4"
                          strokeLinecap="round"
                        />
                      </svg>
                      <div className="space-y-0.5">
                        <p className="text-xs font-semibold text-white">
                          {isLoadingRelease
                            ? 'Album wird geladen…'
                            : 'Trackliste wird abgefragt…'}
                        </p>
                        <p className="text-[11px] text-white/80">
                          Enthaltene Titel werden geladen
                        </p>
                      </div>
                    </div>
                  )}
                  {selectedHitCandidate ? (
                    <>
                      <div className="p-3 space-y-2.5 flex-1 min-w-0">
                      <div className="pb-2 border-b border-[#E1E4E8] dark:border-[#343A40] space-y-1">
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-[#57606A] dark:text-[#8B949E] truncate">
                            {selectedHitCandidate.source === 'discogs'
                              ? 'Discogs'
                              : selectedHitCandidate.source === 'cddb'
                                ? 'CDDB'
                                : 'MusicBrainz'}
                            {selectedHitCandidate.date ? ` · ${selectedHitCandidate.date}` : ''}
                          </span>
                          {hitTrackPreview && !hitTrackPreview.loading && hitTrackPreview.tracks.length > 0 && (
                            <span className="text-[10px] font-mono tabular-nums text-[#57606A] dark:text-[#8B949E] shrink-0">
                              {hitTrackPreview.tracks.length} Titel
                            </span>
                          )}
                        </div>
                        <div
                          className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2] leading-snug break-words"
                          title={selectedHitCandidate.title}
                        >
                          {selectedHitCandidate.title}
                        </div>
                        <div
                          className="text-[11px] text-[#57606A] dark:text-[#8B949E] truncate"
                          title={selectedHitCandidate.artist}
                        >
                          {selectedHitCandidate.artist}
                        </div>
                      </div>

                      {hitTrackPreview?.loading ? (
                        <div className="min-h-[160px]" aria-hidden="true" />
                      ) : hitTrackPreview?.error ? (
                        <div className="p-2.5 rounded border border-[#DC2626]/40 bg-[#DC2626]/5 text-[11px] text-[#DC2626] dark:text-[#F87171]">
                          {hitTrackPreview.error}
                        </div>
                      ) : hitTrackPreview && hitTrackPreview.tracks.length > 0 ? (
                        <div className="max-h-[calc(100vh-370px)] min-h-[160px] overflow-y-auto pr-0.5 divide-y divide-[#E1E4E8]/70 dark:divide-[#343A40]/70">
                          {hitTrackPreview.tracks.map((trk, tIdx) => {
                            const prevDisc = tIdx > 0 ? hitTrackPreview.tracks[tIdx - 1].discNumber : null;
                            const showDiscHdr =
                              hitTrackPreview.totalDiscs > 1 && trk.discNumber !== prevDisc;
                            const showArtist =
                              Boolean(trk.artist?.trim()) &&
                              trk.artist.trim().toLowerCase() !==
                                (hitTrackPreview.artist || selectedHitCandidate.artist || '').trim().toLowerCase();
                            return (
                              <div key={`${trk.discNumber}-${trk.trackNumber}-${tIdx}`}>
                                {showDiscHdr && (
                                  <div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#2E6B14] dark:text-[#9BE270] bg-[#5BA632]/10 rounded-xs my-1">
                                    CD {trk.discNumber}
                                    {trk.discSubtitle ? ` — ${trk.discSubtitle}` : ''}
                                  </div>
                                )}
                                <div className="py-1.5 flex items-start justify-between gap-2">
                                  <div className="flex items-start gap-1.5 min-w-0">
                                    <span className="font-mono text-[10px] tabular-nums text-[#57606A] dark:text-[#8B949E] pt-0.5 shrink-0 w-5 text-right">
                                      {formatIndexNumber(trk.trackNumber, hitTrackPreview.tracks.length)}
                                    </span>
                                    <div className="min-w-0">
                                      <div
                                        className="text-[11px] text-[#1F2328] dark:text-[#EAEEF2] leading-snug break-words"
                                        title={trk.title}
                                      >
                                        {trk.title}
                                      </div>
                                      {showArtist && (
                                        <div
                                          className="text-[10px] text-[#57606A] dark:text-[#8B949E] truncate"
                                          title={trk.artist}
                                        >
                                          {trk.artist}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  <span className="font-mono text-[10px] tabular-nums text-[#57606A] dark:text-[#8B949E] pt-0.5 shrink-0">
                                    {trk.durationSeconds > 0 ? formatDuration(trk.durationSeconds) : '--:--'}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="py-4 text-[11px] text-[#57606A] dark:text-[#8B949E]">
                          Keine Tracks für dieses Album gemeldet.
                        </p>
                      )}
                      </div>

                      <div className="mt-auto p-3 border-t border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 rounded-b-lg">
                        <button
                          type="button"
                          disabled={isLoadingRelease || isBatchActivelyRunning}
                          onClick={() => {
                            if (isLoadingRelease || isBatchActivelyRunning) return;
                            setCoverImgFailed(false);
                            onSelectRelease(
                              selectedHitCandidate.id,
                              selectedHitCandidate.matchedDiscNumber || 1,
                              selectedHitCandidate.source
                            );
                          }}
                          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 transition-colors cursor-pointer"
                        >
                          <ArrowDown className="w-3.5 h-3.5 shrink-0" />
                          <span>
                            {isLoadingRelease ? 'Album wird geladen…' : 'Ausgewähltes Album laden'}
                          </span>
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="p-3 text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      Klicken Sie links in der Albenliste auf ein Album, um die enthaltenen Tracks anzuzeigen.
                    </p>
                  )}
                </div>
              ) : (
              <div className="flex flex-col flex-1 min-w-0">
              <fieldset
                disabled={isBatchActivelyRunning}
                className="p-3 space-y-3.5 text-xs min-w-0 flex-1 block"
              >
                {/* Aktiver Track-Auswahlbereich */}
                <div className="space-y-1.5 pb-2.5 border-b border-[#E1E4E8] dark:border-[#343A40]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[#57606A] dark:text-[#8B949E] truncate">
                      Ausgewählter Track
                    </span>
                    {activeTrack && (
                      <span className="text-[11px] font-mono tabular-nums text-[#57606A] dark:text-[#8B949E] shrink-0">
                        {activeTrackIdx + 1} / {album.tracks.length}
                      </span>
                    )}
                  </div>

                  {activeTrack ? (
                    <>
                      <div className="flex items-center gap-1 min-w-0">
                        <button
                          type="button"
                          disabled={activeTrackIdx <= 0}
                          onClick={() => {
                            if (activeTrackIdx > 0) {
                              setActiveTrackId(album.tracks[activeTrackIdx - 1].id);
                            }
                          }}
                          title="Vorheriger Track"
                          aria-label="Vorheriger Track"
                          className="p-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] disabled:opacity-40 cursor-pointer shrink-0"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>
                        <select
                          aria-label="Aktiven Track für Track-Felder wählen"
                          value={activeTrack.id}
                          onChange={(e) => setActiveTrackId(e.target.value)}
                          className="min-w-0 flex-1 px-1.5 py-1 text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                        >
                          {album.tracks.map((t) => {
                            const dNum = Math.max(1, t.discNumber || album.discNumber || 1);
                            const numLabel = isMultiDiscAlbum
                              ? `CD${dNum}·${formatIndexNumber(t.trackNumber, album.tracks.length)}`
                              : `#${formatIndexNumber(t.trackNumber, album.tracks.length)}`;
                            return (
                              <option key={t.id} value={t.id}>
                                {numLabel} — {t.title || 'Unbenannter Titel'}
                              </option>
                            );
                          })}
                        </select>
                        <button
                          type="button"
                          disabled={activeTrackIdx < 0 || activeTrackIdx >= album.tracks.length - 1}
                          onClick={() => {
                            if (activeTrackIdx >= 0 && activeTrackIdx < album.tracks.length - 1) {
                              setActiveTrackId(album.tracks[activeTrackIdx + 1].id);
                            }
                          }}
                          title="Nächster Track"
                          aria-label="Nächster Track"
                          className="p-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] disabled:opacity-40 cursor-pointer shrink-0"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[11px] text-[#57606A] dark:text-[#8B949E]">
                        <span className="truncate" title={activeTrack.artist || album.artist || '—'}>
                          {activeTrack.artist || album.artist || 'Unbekannter Interpret'}
                        </span>
                        <span className="font-mono tabular-nums shrink-0">
                          {formatDuration(activeTrack.durationSeconds)}
                        </span>
                      </div>
                    </>
                  ) : (
                    <p className="text-[11px] text-[#57606A] dark:text-[#8B949E] leading-relaxed">
                      Kein Titel geladen. Wählen Sie nach dem Einlesen einen Titel in der Titelliste aus.
                    </p>
                  )}
                </div>

                {/* Titel-spezifisches Genre (aus Titel- & Metadaten-Verwaltung hierher verschoben) */}
                <label className="block space-y-1 pb-2.5 border-b border-[#E1E4E8] dark:border-[#343A40]">
                  <span className="block text-[11px] font-medium text-[#57606A] dark:text-[#8B949E]">
                    Genre (; getrennt · nur dieser Track)
                  </span>
                  <input
                    type="text"
                    disabled={!activeTrack}
                    value={activeTrack?.genre || ''}
                    placeholder={album.genre || 'z. B. Rock; Electronic'}
                    onChange={(e) => {
                      if (activeTrack) {
                        updateTrackField(activeTrack.id, 'genre', e.target.value);
                      }
                    }}
                    onBlur={(e) => {
                      if (!activeTrack) return;
                      onAppendQueryLog(
                        `[Track-Felder] Genre für Titel #${formatIndexNumber(activeTrack.trackNumber, album.tracks.length)} gesetzt auf „${e.target.value.trim() || '—'}“.`
                      );
                    }}
                    className="w-full min-w-0 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] placeholder:text-[#8C959F] focus:outline-none focus:ring-2 focus:ring-[#5BA632] disabled:opacity-50"
                  />
                </label>

                {/* Nur-Track-Felder (Klassikalbum: Komponist, Orchester, Dirigent) */}
                {album.isClassical && (
                  <div className="space-y-2.5 pb-2.5 border-b border-[#E1E4E8] dark:border-[#343A40]">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#2E6B14] dark:text-[#9BE270]">
                      <SystemIcon name="classical_album" className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">Klassikalbum (nur dieser Track)</span>
                    </div>

                    <label className="block space-y-1">
                      <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                        Komponist (; für mehrere)
                      </span>
                      <input
                        type="text"
                        disabled={!activeTrack}
                        value={activeTrack?.composer || ''}
                        placeholder="z. B. Ludwig van Beethoven"
                        onChange={(e) => {
                          if (activeTrack) {
                            updateTrackField(activeTrack.id, 'composer', e.target.value);
                          }
                        }}
                        onBlur={(e) => {
                          if (!activeTrack) return;
                          const norm = normalizeMultiArtist(e.target.value);
                          updateTrackField(activeTrack.id, 'composer', norm);
                          onAppendQueryLog(
                            `[Klassikalbum] Komponist für Titel #${formatIndexNumber(activeTrack.trackNumber, album.tracks.length)} gesetzt auf „${norm || '—'}“.`
                          );
                        }}
                        className="w-full min-w-0 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632] disabled:opacity-50"
                      />
                    </label>

                    <label className="block space-y-1">
                      <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                        Orchester (; für mehrere)
                      </span>
                      <input
                        type="text"
                        disabled={!activeTrack}
                        value={activeTrack?.orchestra || ''}
                        placeholder="z. B. Berliner Philharmoniker"
                        onChange={(e) => {
                          if (activeTrack) {
                            updateTrackField(activeTrack.id, 'orchestra', e.target.value);
                          }
                        }}
                        onBlur={(e) => {
                          if (!activeTrack) return;
                          const norm = normalizeMultiArtist(e.target.value);
                          updateTrackField(activeTrack.id, 'orchestra', norm);
                          onAppendQueryLog(
                            `[Klassikalbum] Orchester für Titel #${formatIndexNumber(activeTrack.trackNumber, album.tracks.length)} gesetzt auf „${norm || '—'}“.`
                          );
                        }}
                        className="w-full min-w-0 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632] disabled:opacity-50"
                      />
                    </label>

                    <label className="block space-y-1">
                      <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                        Dirigent (; für mehrere)
                      </span>
                      <input
                        type="text"
                        disabled={!activeTrack}
                        value={activeTrack?.conductor || ''}
                        placeholder="z. B. Herbert von Karajan"
                        onChange={(e) => {
                          if (activeTrack) {
                            updateTrackField(activeTrack.id, 'conductor', e.target.value);
                          }
                        }}
                        onBlur={(e) => {
                          if (!activeTrack) return;
                          const norm = normalizeMultiArtist(e.target.value);
                          updateTrackField(activeTrack.id, 'conductor', norm);
                          onAppendQueryLog(
                            `[Klassikalbum] Dirigent für Titel #${formatIndexNumber(activeTrack.trackNumber, album.tracks.length)} gesetzt auf „${norm || '—'}“.`
                          );
                        }}
                        className="w-full min-w-0 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632] disabled:opacity-50"
                      />
                    </label>
                  </div>
                )}

                {/* Bereits befüllte Track-Tags des ausgewählten Titels */}
                {activeTrack && totalPopulatedTrackTags > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-[#57606A] dark:text-[#8B949E] truncate">
                        Befüllte Track-Tags
                      </span>
                      <span className="text-[11px] font-mono tabular-nums text-[#57606A] dark:text-[#8B949E] shrink-0">
                        {totalPopulatedTrackTags}
                      </span>
                    </div>

                    <div className="space-y-2">
                      {populatedEditableTrackTags.map((spec) => (
                        <label key={spec.key} className="block space-y-0.5">
                          <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E] truncate">
                            {spec.label}
                          </span>
                          <input
                            type="text"
                            value={String(activeTrack[spec.key] ?? '')}
                            onFocus={() => pinTrackTagKey(spec.key)}
                            onChange={(e) => {
                              pinTrackTagKey(spec.key);
                              updateTrackField(activeTrack.id, spec.key, e.target.value);
                            }}
                            onBlur={(e) => {
                              if (spec.normalizePeople) {
                                const norm = normalizeMultiArtist(e.target.value);
                                updateTrackField(activeTrack.id, spec.key, norm);
                              }
                            }}
                            className={`w-full min-w-0 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632] ${
                              spec.mono ? 'font-mono text-[11px]' : ''
                            }`}
                          />
                        </label>
                      ))}

                      {showPopulatedPerformers && (
                        <label className="block space-y-0.5">
                          <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E] truncate">
                            Mitwirkende (; getrennt)
                          </span>
                          <input
                            type="text"
                            value={(activeTrack.performers ?? []).join('; ')}
                            onFocus={() => pinTrackTagKey('performers')}
                            onChange={(e) => {
                              pinTrackTagKey('performers');
                              const parts = e.target.value
                                .split(';')
                                .map((s) => s.trim())
                                .filter(Boolean);
                              updateTrackField(activeTrack.id, 'performers', parts);
                            }}
                            className="w-full min-w-0 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                          />
                        </label>
                      )}

                      {populatedOtherExtraTags.map((extra) => (
                        <label key={extra.key} className="block space-y-0.5">
                          <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E] truncate">
                            {extra.label}
                          </span>
                          <input
                            type="text"
                            value={extra.value}
                            onFocus={() => pinTrackTagKey(`extra:${extra.key}`)}
                            onChange={(e) => {
                              pinTrackTagKey(`extra:${extra.key}`);
                              updateTrackExtraTag(activeTrack.id, extra.key, e.target.value);
                            }}
                            className="w-full min-w-0 px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                          />
                        </label>
                      ))}

                      {populatedReadOnlyTrackInfo.map((info) => (
                        <div
                          key={info.label}
                          className="pt-1 border-t border-[#E1E4E8]/70 dark:border-[#343A40]/70 space-y-0.5"
                        >
                          <span className="block text-[10px] uppercase tracking-wide text-[#57606A] dark:text-[#8B949E]">
                            {info.label}
                          </span>
                          <div
                            title={info.value}
                            className={`text-[11px] text-[#1F2328] dark:text-[#EAEEF2] break-all ${
                              info.mono ? 'font-mono' : ''
                            }`}
                          >
                            {info.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Zusammengeklapptes Display: ID's (MusicBrainz-IDs & AcoustID) */}
                <details
                  open={isTrackIdsOpen}
                  className="bg-white dark:bg-[#25292E] border border-[#DCDCE4] dark:border-[#343A40] rounded-md overflow-hidden"
                >
                  <summary
                    onClick={(e) => {
                      e.preventDefault();
                      setIsTrackIdsOpen((prev) => !prev);
                    }}
                    className={`list-none [&::-webkit-details-marker]:hidden px-2.5 py-1.5 flex items-center justify-between gap-2 bg-[#F8F9FA] dark:bg-[#1C1F23]/60 hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B] transition-colors cursor-pointer select-none ${
                      isTrackIdsOpen ? 'border-b border-[#DCDCE4] dark:border-[#343A40]' : ''
                    }`}
                  >
                    <span className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate">
                      ID&apos;s{totalTrackIdsCount > 0 ? ` (${totalTrackIdsCount})` : ''}
                    </span>
                    <span
                      aria-hidden="true"
                      className="text-base font-normal leading-none text-[#555555] dark:text-[#8B949E] shrink-0"
                    >
                      {isTrackIdsOpen ? '−' : '+'}
                    </span>
                  </summary>
                  {isTrackIdsOpen && (
                    <div className="p-2.5 space-y-2 bg-[#FAFAFA] dark:bg-[#1C1F23]/30">
                      {activeTrack && totalTrackIdsCount > 0 ? (
                        <>
                          {populatedDirectTrackIds.map((spec) => (
                            <label key={spec.key} className="block space-y-0.5">
                              <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E] truncate">
                                {spec.label}
                              </span>
                              <input
                                type="text"
                                value={String(activeTrack[spec.key] ?? '')}
                                onFocus={() => pinTrackTagKey(spec.key)}
                                onChange={(e) => {
                                  pinTrackTagKey(spec.key);
                                  updateTrackField(activeTrack.id, spec.key, e.target.value);
                                }}
                                className="w-full min-w-0 px-2 py-1 font-mono text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                              />
                            </label>
                          ))}
                          {populatedIdExtraTags.map((item) => (
                            <label key={item.key} className="block space-y-0.5">
                              <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E] truncate">
                                {item.label}
                              </span>
                              <input
                                type="text"
                                value={item.value}
                                onFocus={() => pinTrackTagKey(`extra:${item.key}`)}
                                onChange={(e) => {
                                  pinTrackTagKey(`extra:${item.key}`);
                                  updateTrackExtraTag(activeTrack.id, item.key, e.target.value);
                                }}
                                className="w-full min-w-0 px-2 py-1 font-mono text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                              />
                            </label>
                          ))}
                        </>
                      ) : (
                        <p className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                          Keine MusicBrainz-IDs oder AcoustID-Werte für diesen Track vorhanden.
                        </p>
                      )}
                    </div>
                  )}
                </details>

                {/* Zusammengeklapptes Display: Replaygain */}
                <details
                  open={isTrackReplayGainOpen}
                  className="bg-white dark:bg-[#25292E] border border-[#DCDCE4] dark:border-[#343A40] rounded-md overflow-hidden"
                >
                  <summary
                    onClick={(e) => {
                      e.preventDefault();
                      setIsTrackReplayGainOpen((prev) => !prev);
                    }}
                    className={`list-none [&::-webkit-details-marker]:hidden px-2.5 py-1.5 flex items-center justify-between gap-2 bg-[#F8F9FA] dark:bg-[#1C1F23]/60 hover:bg-[#EAEEF2] dark:hover:bg-[#2D333B] transition-colors cursor-pointer select-none ${
                      isTrackReplayGainOpen ? 'border-b border-[#DCDCE4] dark:border-[#343A40]' : ''
                    }`}
                  >
                    <span className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate">
                      Replaygain{totalReplayGainCount > 0 ? ` (${totalReplayGainCount})` : ''}
                    </span>
                    <span
                      aria-hidden="true"
                      className="text-base font-normal leading-none text-[#555555] dark:text-[#8B949E] shrink-0"
                    >
                      {isTrackReplayGainOpen ? '−' : '+'}
                    </span>
                  </summary>
                  {isTrackReplayGainOpen && (
                    <div className="p-2.5 space-y-2 bg-[#FAFAFA] dark:bg-[#1C1F23]/30">
                      {activeTrack && totalReplayGainCount > 0 ? (
                        populatedReplayGainTags.map((item) => (
                          <label key={item.key} className="block space-y-0.5">
                            <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E] truncate">
                              {item.label}
                            </span>
                            <input
                              type="text"
                              value={item.value}
                              onFocus={() => pinTrackTagKey(`extra:${item.key}`)}
                              onChange={(e) => {
                                pinTrackTagKey(`extra:${item.key}`);
                                updateTrackExtraTag(activeTrack.id, item.key, e.target.value);
                              }}
                              className="w-full min-w-0 px-2 py-1 font-mono text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                            />
                          </label>
                        ))
                      ) : (
                        <p className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                          Keine ReplayGain-Werte für diesen Track vorhanden.
                        </p>
                      )}
                    </div>
                  )}
                </details>

                {/* Hinweis wenn Klassikalbum aus ist */}
                {!album.isClassical &&
                  (totalPopulatedTrackTags > 0 || totalTrackIdsCount > 0 || totalReplayGainCount > 0 ? (
                    <p className="pt-2 border-t border-[#E1E4E8] dark:border-[#343A40] text-[11px] text-[#57606A] dark:text-[#8B949E] leading-relaxed">
                      <strong>„Klassikalbum“</strong> in der Toolbar blendet zusätzlich Komponist, Orchester &amp; Dirigent ein.
                    </p>
                  ) : (
                    <div className="p-2.5 rounded-md border border-dashed border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23]/50 space-y-1.5">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                        <SystemIcon
                          name="classical_album"
                          className="w-3.5 h-3.5 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                        />
                        <span>Track-spezifische Felder</span>
                      </div>
                      <p className="text-[11px] text-[#57606A] dark:text-[#8B949E] leading-relaxed">
                        Bereits befüllte Track-Tags erscheinen hier automatisch. Aktivieren Sie <strong>„Klassikalbum“</strong> in der Toolbar für <strong>Komponist</strong>, <strong>Orchester</strong> und <strong>Dirigent</strong>.
                      </p>
                    </div>
                  ))}
              </fieldset>

              {/* Hauptaktions-Button am unteren Rand der rechten Spalte */}
              {(() => {
                const isImportedFolderOnly =
                  album.tracks.length > 0 && album.tracks.every((t) => Boolean(t.sourceFileName));
                const convertFlacActive =
                  moduleMode === 'album_tag' && isImportedFolderOnly && convertImportedToFlac;
                return (
                  <div className="mt-auto p-3 border-t border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 rounded-b-lg">
                    <button
                      type="button"
                      disabled={selectedCount === 0 || isBatchActivelyRunning}
                      onClick={() => onEnqueueAlbum(convertFlacActive ? 'convert_flac' : 'tag_only')}
                      title={
                        convertFlacActive
                          ? 'Wandelt die importierten Audiodateien zuerst in unkomprimiertes WAV und danach in FLAC um (exakte Bitraten) unter Beibehaltung aller Tags & des Covers'
                          : isImportedFolderOnly
                            ? 'Schreibt ausschließlich die Picard-Metadaten-Tags und das Cover direkt in die vorhandenen Audiodateien – ohne erneutes Rippen oder Neukodieren'
                            : 'Ausgewählte Titel rippen / konvertieren und in die Stapelverarbeitung starten'
                      }
                      className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      <SystemIcon
                        name={isImportedFolderOnly && !convertFlacActive ? 'save_export' : 'start_rip'}
                        className="w-3.5 h-3.5 shrink-0"
                      />
                      <span className="truncate">
                        {convertFlacActive
                          ? `In FLAC umwandeln (${selectedCount})`
                          : isImportedFolderOnly
                            ? `Tags in Dateien schreiben (${selectedCount})`
                            : `Rippen (${selectedCount})`}
                      </span>
                    </button>
                  </div>
                );
              })()}
              </div>
              )}
            </div>
          )}
        </aside>
      )}

      {/* Modal: Cover-Bild einscannen (SANE Flachbettscanner / Optischer Kamera-Booklet-Scanner / Scan-Datei 1:1 Zuschnitt) */}
      {isScannerModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="scanner-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsScannerModalOpen(false);
          }}
        >
          <div className="w-full max-w-lg bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg shadow-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#E1E4E8] dark:border-[#343A40] flex items-center justify-between gap-4 bg-[#F8F9FA] dark:bg-[#1C1F23]/60">
              <div className="flex items-center gap-2">
                <SystemIcon name="scanner" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F]" />
                <h2 id="scanner-modal-title" className="text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  Album-Cover einscannen — MintRip Studio
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setIsScannerModalOpen(false)}
                className="px-2.5 py-0.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]"
              >
                Schließen
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <p className="text-[#57606A] dark:text-[#8B949E] leading-relaxed">
                Scannen Sie ein CD-Booklet direkt über die Linux-SANE-Schnittstelle (<span className="font-mono">scanimage</span>, 125×125 mm Quadrat-Ausschnitt), erfassen Sie das Booklet über eine angeschlossene Kamera oder schneiden Sie eine bereits gescannte Vorlage quadratisch (1:1) zu.
              </p>

              {/* 1. SANE-Flachbettscanner */}
              <div className="p-3.5 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                    1. SANE-Flachbettscanner (Linux Mint <span className="font-mono">scanimage</span>)
                  </span>
                  <select
                    aria-label="Scan-Auflösung wählen"
                    value={scanDpi}
                    onChange={(e) => setScanDpi(Number(e.target.value) as 150 | 300 | 600)}
                    className="px-1.5 py-0.5 text-xs font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                  >
                    <option value={150}>150 DPI (Schnell)</option>
                    <option value={300}>300 DPI (Standard)</option>
                    <option value={600}>600 DPI (Archiv)</option>
                  </select>
                </div>
                <button
                  type="button"
                  disabled={isScanningHardware}
                  onClick={() => void handleHardwareSaneScan()}
                  className="w-full inline-flex items-center justify-center gap-2 px-2.5 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 transition-colors"
                >
                  <SystemIcon name="scanner" className="w-3.5 h-3.5" />
                  <span>
                    {isScanningHardware
                      ? `Scanne CD-Booklet (${scanDpi} DPI)...`
                      : `Flachbett-Scan starten (${scanDpi} DPI · 125×125 mm)`}
                  </span>
                </button>
              </div>

              {/* 2. Optischer Kamera-Booklet-Scanner */}
              <div className="p-3.5 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 space-y-2.5">
                <div className="font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  2. Optischer Kamera- / Dokumenten-Scanner (1:1 Quadrat-Zuschnitt)
                </div>
                {!isCameraActive ? (
                  <button
                    type="button"
                    onClick={() => void handleStartCameraScanner()}
                    className="w-full inline-flex items-center justify-center gap-2 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] transition-colors"
                  >
                    <SystemIcon name="scanner" className="w-3.5 h-3.5 text-[#5BA632] dark:text-[#69B53F]" />
                    <span>Kamera-Vorschau für Booklet starten</span>
                  </button>
                ) : (
                  <div className="space-y-2.5">
                    <div className="relative mx-auto w-56 h-56 rounded border-2 border-[#5BA632] overflow-hidden bg-black">
                      <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full object-cover"
                      />
                      <div className="pointer-events-none absolute inset-3 border border-dashed border-white/80 rounded-xs" />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleCaptureCameraCover}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white"
                      >
                        <SystemIcon name="scanner" className="w-3.5 h-3.5" />
                        <span>Booklet-Quadrat aufnehmen</span>
                      </button>
                      <button
                        type="button"
                        onClick={stopCameraStream}
                        className="px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#1F2328] dark:text-[#EAEEF2]"
                      >
                        Stopp
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* 3. Vorhandene Scan-Vorlage 1:1 quadratisch zuschneiden */}
              <div className="p-3.5 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 space-y-2">
                <div className="font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  3. Gescannte Bilddatei importieren &amp; automatisch 1:1 quadratisch zuschneiden
                </div>
                <button
                  type="button"
                  onClick={() => scannerFileInputRef.current?.click()}
                  className="w-full inline-flex items-center justify-center gap-2 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] transition-colors"
                >
                  <SystemIcon name="open_file" className="w-3.5 h-3.5" />
                  <span>Scan-Vorlage auswählen und auf CD-Format (1:1) zuschneiden...</span>
                </button>
                <input
                  ref={scannerFileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/bmp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      handleCropScannedImageFile(file);
                      e.target.value = '';
                    }
                  }}
                />
              </div>

              {scannerStatus && (
                <div className="p-2.5 rounded border border-[#D97706]/40 bg-[#FEF3C7]/40 dark:bg-[#F59E0B]/10 text-[#B45309] dark:text-[#FBBF24] text-xs">
                  {scannerStatus}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal: Barcode (EAN-13 / UPC-A / EAN-8) & QR-Code per Webcam einlesen */}
      {isBarcodeModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="barcode-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsBarcodeModalOpen(false);
          }}
        >
          <div className="w-full max-w-xl bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg shadow-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#E1E4E8] dark:border-[#343A40] flex items-center justify-between gap-4 bg-[#F8F9FA] dark:bg-[#1C1F23]/60">
              <div className="flex items-center gap-2">
                <SystemIcon name="barcode_qr" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F]" />
                <h2 id="barcode-modal-title" className="text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  Barcode &amp; QR-Code mit Webcam einlesen — Albuminformationen suchen
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setIsBarcodeModalOpen(false)}
                className="px-2.5 py-0.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]"
              >
                Schließen
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <p className="text-[#57606A] dark:text-[#8B949E] leading-relaxed">
                Halten Sie den <strong>Barcode auf der CD-Hüllen-Rückseite</strong> (EAN-13, EAN-8, UPC-A, UPC-E, Code-128) oder einen <strong>QR-Code</strong> (MusicBrainz-Release, Discogs-Link, GTIN) vor die Webcam. Sobald ein Code erkannt wird, ruft MintRip Studio automatisch die Albuminformationen und das Cover über <strong>MusicBrainz → Discogs</strong> ab.
              </p>

              {/* 1. Live-Webcam-Scanner */}
              <div className="p-3.5 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                    1. Live-Webcam-Scanner (EAN-13 · UPC-A · EAN-8 · QR-Code)
                  </span>
                  {videoDevices.length > 1 && (
                    <select
                      aria-label="Webcam auswählen"
                      value={selectedVideoDeviceId}
                      onChange={(e) => {
                        const nextId = e.target.value;
                        setSelectedVideoDeviceId(nextId);
                        if (isBarcodeCamActive) {
                          void handleStartBarcodeWebcam(nextId);
                        }
                      }}
                      className="px-1.5 py-0.5 text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                    >
                      {videoDevices.map((cam, idx) => (
                        <option key={cam.deviceId || idx} value={cam.deviceId}>
                          {cam.label || `Kamera ${idx + 1}`}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {!isBarcodeCamActive ? (
                  <button
                    type="button"
                    onClick={() => void handleStartBarcodeWebcam()}
                    className="w-full inline-flex items-center justify-center gap-2 px-2.5 py-2 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white transition-colors"
                  >
                    <SystemIcon name="barcode_qr" className="w-4 h-4" />
                    <span>Webcam starten &amp; Barcode / QR-Code scannen</span>
                  </button>
                ) : (
                  <div className="space-y-2.5">
                    <div className="relative mx-auto w-full max-w-md aspect-video rounded border-2 border-[#5BA632] overflow-hidden bg-black">
                      <video
                        ref={barcodeVideoRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full object-cover"
                      />
                      {/* Zielrahmen für Barcode / QR-Code */}
                      <div className="pointer-events-none absolute inset-6 border-2 border-dashed border-[#5BA632]/90 rounded flex items-center justify-center">
                        <div className="w-full h-0.5 bg-[#5BA632]/80 shadow-[0_0_8px_#5BA632]" />
                      </div>
                      <div className="pointer-events-none absolute bottom-2 left-2 right-2 px-2 py-1 rounded bg-black/70 text-[11px] font-mono text-white text-center">
                        Automatische Erkennung aktiv (EAN-13 · UPC · QR-Code)...
                      </div>
                    </div>
                    <div className="flex items-center justify-end">
                      <button
                        type="button"
                        onClick={stopBarcodeScanner}
                        className="px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-white dark:hover:bg-[#2D333B]"
                      >
                        Webcam beenden
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* 2. Barcode / QR-Code aus Foto-Datei lesen oder manuell eingeben */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="p-3 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 space-y-2">
                  <div className="font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                    2. Aus Foto / Bilddatei lesen
                  </div>
                  <p className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                    Foto einer CD-Rückseite oder eines QR-Codes auswählen und dekodieren:
                  </p>
                  <button
                    type="button"
                    onClick={() => barcodeFileInputRef.current?.click()}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]"
                  >
                    <SystemIcon name="open_file" className="w-3.5 h-3.5" />
                    <span>Bild mit Barcode / QR wählen...</span>
                  </button>
                  <input
                    ref={barcodeFileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/bmp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        void handleDecodeBarcodeFromImageFile(file);
                        e.target.value = '';
                      }
                    }}
                  />
                </div>

                <div className="p-3 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 space-y-2">
                  <div className="font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                    3. Direkte Code-Eingabe
                  </div>
                  <p className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                    EAN-13, UPC-A oder QR-Code-URL direkt abfragen:
                  </p>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={manualBarcodeInput}
                      onChange={(e) => setManualBarcodeInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && manualBarcodeInput.trim()) {
                          e.preventDefault();
                          applyDetectedBarcodeOrQr(manualBarcodeInput, 'Manuelle Eingabe');
                        }
                      }}
                      placeholder="z.B. 5099969944926"
                      className="min-w-0 flex-1 px-1.5 py-1 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                    />
                    <button
                      type="button"
                      disabled={!manualBarcodeInput.trim()}
                      onClick={() => applyDetectedBarcodeOrQr(manualBarcodeInput, 'Manuelle Eingabe')}
                      className="px-2 py-1 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 shrink-0"
                    >
                      Suchen
                    </button>
                  </div>
                </div>
              </div>

              {/* 4. Beispiel-Barcodes & QR-Codes zum direkten Testen */}
              <div className="p-3 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 space-y-2">
                <div className="font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  Beispiel-Barcodes &amp; QR-Codes (1-Klick-Test ohne physische CD-Hülle)
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {SAMPLE_BARCODE_PRESETS.map((sample) => (
                    <button
                      key={sample.code}
                      type="button"
                      onClick={() => applyDetectedBarcodeOrQr(sample.code, sample.typeLabel)}
                      className="px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] text-left flex items-center justify-between gap-2 transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-[#1F2328] dark:text-[#EAEEF2] truncate">
                          {sample.albumLabel}
                        </div>
                        <div className="text-[10px] font-mono text-[#57606A] dark:text-[#8B949E] truncate">
                          {sample.code}
                        </div>
                      </div>
                      <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270] shrink-0">
                        {sample.typeLabel}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {(barcodeScannerStatus || lastDetectedFormat) && (
                <div className="p-2.5 rounded border border-[#5BA632]/40 bg-[#5BA632]/10 text-[#1F2328] dark:text-[#EAEEF2] text-xs flex items-center justify-between gap-2">
                  <span>{barcodeScannerStatus}</span>
                  {lastDetectedFormat && (
                    <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-[#5BA632] text-white shrink-0">
                      {lastDetectedFormat}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal: Online-Cover-Auswahl (für Modul 2 & 3; in Modul 1 wird die identische Tabelle direkt unterhalb der Suchleiste angezeigt) */}
      {isCoverPickerOpen && moduleMode !== 'cover_only' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cover-picker-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget && lightboxIndex === null) {
              onCloseCoverPicker();
            }
          }}
        >
          <div className="w-full max-w-5xl max-h-[88vh] flex flex-col bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg shadow-2xl overflow-hidden">
            {renderCoverCandidatesTableSection(false)}
          </div>
        </div>
      )}

      {/* Großansicht / Lightbox beim Klick auf ein Vorschaubild (funktioniert sowohl in der Inline-Tabelle im Modul 1 als auch im Modal in Modul 2 & 3) */}
      {lightboxIndex !== null && coverCandidates[lightboxIndex] && (() => {
        const activeCand = coverCandidates[lightboxIndex];
        const dim = loadedCoverDims[activeCand.id];
        const lw = activeCand.width || dim?.w;
        const lh = activeCand.height || dim?.h;
        return (
          <div
            className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs"
            role="dialog"
            aria-modal="true"
            aria-label="Cover-Großansicht"
            onClick={(e) => {
              if (e.target === e.currentTarget) setLightboxIndex(null);
            }}
          >
            <div className="w-full max-w-2xl bg-[#1C1F23] border border-[#444C56] rounded-lg shadow-2xl overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-[#343A40] flex items-center justify-between gap-3 bg-[#16191D]">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate">
                    {activeCand.title || 'Cover-Großansicht'}
                  </div>
                  <div className="text-[11px] text-[#9CA3AF] truncate">
                    {activeCand.providerLabel} · {activeCand.artist}
                    {activeCand.date ? ` · ${activeCand.date}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setLightboxIndex(null)}
                  className="px-2.5 py-1 text-xs font-medium rounded border border-[#444C56] text-[#EAEEF2] hover:bg-[#2D333B] shrink-0 cursor-pointer"
                >
                  Zurück zur Übersicht
                </button>
              </div>

              <div className="relative p-5 bg-[#0D1117] flex items-center justify-center min-h-[340px]">
                {coverCandidates.length > 1 && (
                  <button
                    type="button"
                    aria-label="Vorheriges Cover"
                    onClick={() =>
                      setLightboxIndex(
                        (lightboxIndex - 1 + coverCandidates.length) % coverCandidates.length
                      )
                    }
                    className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 hover:bg-black/85 text-white border border-white/15 cursor-pointer"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                )}

                <img
                  key={activeCand.imageUrl}
                  src={activeCand.imageUrl}
                  alt={`${activeCand.providerLabel}: ${activeCand.title}`}
                  onLoad={(e) => {
                    const nw = e.currentTarget.naturalWidth;
                    const nh = e.currentTarget.naturalHeight;
                    if (nw > 0 && nh > 0) {
                      setLoadedCoverDims((prev) => ({
                        ...prev,
                        [activeCand.id]: { w: nw, h: nh },
                      }));
                    }
                  }}
                  className="max-w-full max-h-[58vh] object-contain rounded shadow-lg"
                />

                {coverCandidates.length > 1 && (
                  <button
                    type="button"
                    aria-label="Nächstes Cover"
                    onClick={() => setLightboxIndex((lightboxIndex + 1) % coverCandidates.length)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 hover:bg-black/85 text-white border border-white/15 cursor-pointer"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                )}
              </div>

              <div className="px-4 py-3 border-t border-[#343A40] bg-[#16191D] flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="font-mono text-[#CBD5E1] space-x-3">
                  <span>{lw && lh ? `${lw} × ${lh} px` : 'Auflösung wird geladen...'}</span>
                  <span>·</span>
                  <span>{activeCand.sizeBytes ? formatCoverByteSize(activeCand.sizeBytes) : '—'}</span>
                  <span>·</span>
                  <span>{activeCand.format || 'JPEG'}</span>
                  {coverCandidates.length > 1 && (
                    <>
                      <span>·</span>
                      <span className="text-[#9CA3AF]">
                        Treffer {lightboxIndex + 1} / {coverCandidates.length}
                      </span>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  disabled={isApplyingCoverCandidate}
                  onClick={() => {
                    onSelectCoverCandidate(activeCand);
                    setLightboxIndex(null);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 cursor-pointer"
                >
                  <Check className="w-4 h-4" />
                  <span>Dieses Cover übernehmen</span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal: Coverbild in voller Größe mit interaktivem Beschneidungsrahmen (Schere) */}
      {isCropModalOpen && album.coverArtUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="crop-cover-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget && !cropDragRef.current) {
              setIsCropModalOpen(false);
            }
          }}
        >
          <div className="w-full max-w-4xl max-h-[92vh] flex flex-col bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="px-5 py-3.5 border-b border-[#E1E4E8] dark:border-[#343A40] flex flex-wrap items-center justify-between gap-3 bg-[#F8F9FA] dark:bg-[#1C1F23]/80 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <SystemIcon name="crop_cover" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0" />
                <div className="min-w-0">
                  <h2
                    id="crop-cover-modal-title"
                    className="text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate"
                  >
                    Coverbild beschneiden — Interaktiver Beschneidungsrahmen
                  </h2>
                  <p className="text-[11px] text-[#57606A] dark:text-[#8B949E] truncate">
                    Ziehen Sie die Ecken oder Kanten mit der Maus größer oder kleiner, oder verschieben Sie den Rahmen im Bild.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <label className="inline-flex items-center gap-1.5 text-xs text-[#1F2328] dark:text-[#EAEEF2] cursor-pointer select-none px-2 py-1 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23]">
                  <input
                    type="checkbox"
                    checked={cropLockSquare}
                    onChange={(e) => {
                      const nextLock = e.target.checked;
                      setCropLockSquare(nextLock);
                      if (nextLock && cropImgNatural.w > 0 && cropImgNatural.h > 0) {
                        const side = Math.min(cropRect.w, cropRect.h, cropImgNatural.w, cropImgNatural.h);
                        const nx = Math.max(0, Math.min(cropImgNatural.w - side, Math.round(cropRect.x + (cropRect.w - side) / 2)));
                        const ny = Math.max(0, Math.min(cropImgNatural.h - side, Math.round(cropRect.y + (cropRect.h - side) / 2)));
                        setCropRect({ x: nx, y: ny, w: side, h: side });
                      }
                    }}
                    className="accent-[#5BA632] rounded"
                  />
                  <span>1:1 Quadratisch</span>
                </label>

                <button
                  type="button"
                  onClick={() => {
                    if (!cropImgNatural.w || !cropImgNatural.h) return;
                    const w = Math.max(1, Math.min(cropImgNatural.w, cropRect.w));
                    const h = Math.max(1, Math.min(cropImgNatural.h, cropRect.h));
                    const nx = Math.max(0, Math.min(cropImgNatural.w - w, Math.round((cropImgNatural.w - w) / 2)));
                    const ny = Math.max(0, Math.min(cropImgNatural.h - h, Math.round((cropImgNatural.h - h) / 2)));
                    setCropRect({ x: nx, y: ny, w, h });
                  }}
                  title="Eigene Auswahlgröße beibehalten und mittig im Bild zentrieren"
                  className="px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]"
                >
                  Auswahl zentrieren
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (!cropImgNatural.w || !cropImgNatural.h) return;
                    const side = Math.min(cropImgNatural.w, cropImgNatural.h);
                    const nx = Math.floor((cropImgNatural.w - side) / 2);
                    const ny = Math.floor((cropImgNatural.h - side) / 2);
                    setCropRect({ x: nx, y: ny, w: side, h: side });
                  }}
                  className="px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]"
                >
                  Quadrat zentrieren
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (!cropImgNatural.w || !cropImgNatural.h) return;
                    setCropLockSquare(false);
                    setCropRect({ x: 0, y: 0, w: cropImgNatural.w, h: cropImgNatural.h });
                  }}
                  className="px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]"
                >
                  Vollbild (100%)
                </button>

                <button
                  type="button"
                  onClick={() => setIsCropModalOpen(false)}
                  className="px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]"
                >
                  Abbrechen
                </button>
              </div>
            </div>

            {/* Bildbühne mit Coverbild in voller Größe & Beschneidungsrahmen */}
            <div className="flex-1 overflow-auto p-6 bg-[#0D1117] flex items-center justify-center select-none">
              <div className="relative inline-block leading-none shadow-2xl">
                <img
                  ref={cropImgRef}
                  src={album.coverArtUrl}
                  alt="Cover zum Beschneiden"
                  crossOrigin="anonymous"
                  draggable={false}
                  onLoad={(e) => {
                    const nw = Math.max(1, e.currentTarget.naturalWidth || 500);
                    const nh = Math.max(1, e.currentTarget.naturalHeight || 500);
                    setCropImgNatural({ w: nw, h: nh });
                    const insetX = Math.max(0, Math.round(nw * 0.05));
                    const insetY = Math.max(0, Math.round(nh * 0.05));
                    setCropRect({
                      x: insetX,
                      y: insetY,
                      w: Math.max(1, nw - insetX * 2),
                      h: Math.max(1, nh - insetY * 2),
                    });
                  }}
                  className="block max-w-full max-h-[65vh] w-auto h-auto select-none pointer-events-none"
                />

                {cropImgNatural.w > 0 && cropImgNatural.h > 0 && (() => {
                  const leftPct = (cropRect.x / cropImgNatural.w) * 100;
                  const topPct = (cropRect.y / cropImgNatural.h) * 100;
                  const widthPct = (cropRect.w / cropImgNatural.w) * 100;
                  const heightPct = (cropRect.h / cropImgNatural.h) * 100;

                  return (
                    <>
                      {/* Abgedunkelte Außenbereiche außerhalb des Beschneidungsrahmens */}
                      <div
                        className="absolute left-0 right-0 top-0 bg-black/60 pointer-events-none"
                        style={{ height: `${topPct}%` }}
                      />
                      <div
                        className="absolute left-0 right-0 bottom-0 bg-black/60 pointer-events-none"
                        style={{ height: `${Math.max(0, 100 - topPct - heightPct)}%` }}
                      />
                      <div
                        className="absolute left-0 bg-black/60 pointer-events-none"
                        style={{ top: `${topPct}%`, height: `${heightPct}%`, width: `${leftPct}%` }}
                      />
                      <div
                        className="absolute right-0 bg-black/60 pointer-events-none"
                        style={{
                          top: `${topPct}%`,
                          height: `${heightPct}%`,
                          width: `${Math.max(0, 100 - leftPct - widthPct)}%`,
                        }}
                      />

                      {/* Interaktiver Beschneidungsrahmen */}
                      <div
                        onPointerDown={(e) => startCropDrag('move', e)}
                        style={{
                          left: `${leftPct}%`,
                          top: `${topPct}%`,
                          width: `${widthPct}%`,
                          height: `${heightPct}%`,
                        }}
                        className="absolute border-2 border-[#5BA632] shadow-[0_0_0_1px_rgba(255,255,255,0.65)] cursor-move touch-none"
                      >
                        {/* Drittel-Hilfslinien */}
                        <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none">
                          <div className="border-r border-b border-white/35" />
                          <div className="border-r border-b border-white/35" />
                          <div className="border-b border-white/35" />
                          <div className="border-r border-b border-white/35" />
                          <div className="border-r border-b border-white/35" />
                          <div className="border-b border-white/35" />
                          <div className="border-r border-white/35" />
                          <div className="border-r border-white/35" />
                          <div />
                        </div>

                        {/* Live-Dimensions-Anzeige im Rahmen */}
                        <div className="pointer-events-none absolute left-1.5 top-1.5 px-1.5 py-0.5 rounded bg-black/75 text-[10px] font-mono text-white shadow">
                          {Math.round(cropRect.w)} × {Math.round(cropRect.h)} px
                        </div>

                        {/* 4 Eck-Anfasser zum Größer-/Kleinerziehen */}
                        <div
                          onPointerDown={(e) => startCropDrag('nw', e)}
                          className="absolute -left-2 -top-2 w-4 h-4 rounded-xs bg-[#5BA632] border-2 border-white cursor-nwse-resize shadow"
                        />
                        <div
                          onPointerDown={(e) => startCropDrag('ne', e)}
                          className="absolute -right-2 -top-2 w-4 h-4 rounded-xs bg-[#5BA632] border-2 border-white cursor-nesw-resize shadow"
                        />
                        <div
                          onPointerDown={(e) => startCropDrag('sw', e)}
                          className="absolute -left-2 -bottom-2 w-4 h-4 rounded-xs bg-[#5BA632] border-2 border-white cursor-nesw-resize shadow"
                        />
                        <div
                          onPointerDown={(e) => startCropDrag('se', e)}
                          className="absolute -right-2 -bottom-2 w-4 h-4 rounded-xs bg-[#5BA632] border-2 border-white cursor-nwse-resize shadow"
                        />

                        {/* 4 Kanten-Anfasser zum Größer-/Kleinerziehen */}
                        <div
                          onPointerDown={(e) => startCropDrag('n', e)}
                          className="absolute left-1/2 -translate-x-1/2 -top-1.5 w-6 h-3 rounded-xs bg-[#5BA632] border border-white cursor-ns-resize shadow"
                        />
                        <div
                          onPointerDown={(e) => startCropDrag('s', e)}
                          className="absolute left-1/2 -translate-x-1/2 -bottom-1.5 w-6 h-3 rounded-xs bg-[#5BA632] border border-white cursor-ns-resize shadow"
                        />
                        <div
                          onPointerDown={(e) => startCropDrag('w', e)}
                          className="absolute top-1/2 -translate-y-1/2 -left-1.5 w-3 h-6 rounded-xs bg-[#5BA632] border border-white cursor-ew-resize shadow"
                        />
                        <div
                          onPointerDown={(e) => startCropDrag('e', e)}
                          className="absolute top-1/2 -translate-y-1/2 -right-1.5 w-3 h-6 rounded-xs bg-[#5BA632] border border-white cursor-ew-resize shadow"
                        />
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/80 flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
              <div className="font-mono text-[#57606A] dark:text-[#8B949E] space-x-3">
                <span>
                  Original: <strong className="text-[#1F2328] dark:text-[#EAEEF2]">{cropImgNatural.w} × {cropImgNatural.h} px</strong>
                </span>
                <span>·</span>
                <span>
                  Auswahl:{' '}
                  <strong className="text-[#2E6B14] dark:text-[#9BE270]">
                    {Math.round(cropRect.w)} × {Math.round(cropRect.h)} px
                  </strong>{' '}
                  (X: {Math.round(cropRect.x)}, Y: {Math.round(cropRect.y)})
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsCropModalOpen(false)}
                  className="px-3 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]"
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  onClick={handleApplyCoverCrop}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white cursor-pointer"
                >
                  <Check className="w-4 h-4" />
                  <span>Zuschnitt übernehmen</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Coverbild skalieren (Quadratisch oder mit anderen Werten) */}
      {isScaleModalOpen && album.coverArtUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="scale-cover-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setIsScaleModalOpen(false);
            }
          }}
        >
          <div className="w-full max-w-2xl max-h-[92vh] flex flex-col bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="px-5 py-3.5 border-b border-[#E1E4E8] dark:border-[#343A40] flex items-center justify-between gap-3 bg-[#F8F9FA] dark:bg-[#1C1F23]/80 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <SystemIcon name="scale_cover" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0" />
                <div className="min-w-0">
                  <h2
                    id="scale-cover-modal-title"
                    className="text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate"
                  >
                    Coverbild skalieren — Quadratisch oder benutzerdefinierte Maße
                  </h2>
                  <p className="text-[11px] text-[#57606A] dark:text-[#8B949E] truncate">
                    Skaliert das geladene Coverbild wahlweise quadratisch (1:1) oder auf beliebige Breite- und Höhenwerte.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsScaleModalOpen(false)}
                className="px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]"
              >
                Schließen
              </button>
            </div>

            {/* Body */}
            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-4 items-start">
                {/* Vorschau */}
                <div className="flex flex-col items-center gap-2 p-3 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#0D1117]">
                  <div className="w-36 h-36 flex items-center justify-center overflow-hidden">
                    <img
                      ref={scaleImgRef}
                      src={album.coverArtUrl}
                      alt="Cover zum Skalieren"
                      crossOrigin="anonymous"
                      onLoad={(e) => {
                        const nw = Math.max(1, e.currentTarget.naturalWidth || 1000);
                        const nh = Math.max(1, e.currentTarget.naturalHeight || 1000);
                        setScaleImgNatural({ w: nw, h: nh });
                        setScaleWidth(nw);
                        setScaleHeight(nh);
                      }}
                      className="max-w-full max-h-full object-contain rounded"
                    />
                  </div>
                  <div className="text-[11px] font-mono text-[#CBD5E1] text-center">
                    Original: <strong>{scaleImgNatural.w} × {scaleImgNatural.h} px</strong>
                  </div>
                </div>

                {/* Skalierungs-Optionen */}
                <div className="space-y-4">
                  {/* Modus-Umschalter: Quadratisch (1:1) vs. Andere Werte (Frei / Proportional) */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setScaleMode('square');
                        const side = Math.max(16, Math.round(scaleWidth || scaleImgNatural.w || 1000));
                        setScaleWidth(side);
                        setScaleHeight(side);
                      }}
                      className={`px-3 py-2 text-xs font-medium rounded border text-left transition-colors cursor-pointer ${
                        scaleMode === 'square'
                          ? 'border-[#5BA632] bg-[#5BA632]/10 text-[#1F2328] dark:text-[#EAEEF2]'
                          : 'border-[#D0D7DE] dark:border-[#444C56] text-[#57606A] dark:text-[#8B949E]'
                      }`}
                    >
                      <div className="font-semibold">Quadratisch (1:1)</div>
                      <div className="text-[11px] opacity-80">Gleiche Breite &amp; Höhe (z. B. 1000 × 1000 px)</div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setScaleMode('custom')}
                      className={`px-3 py-2 text-xs font-medium rounded border text-left transition-colors cursor-pointer ${
                        scaleMode === 'custom'
                          ? 'border-[#5BA632] bg-[#5BA632]/10 text-[#1F2328] dark:text-[#EAEEF2]'
                          : 'border-[#D0D7DE] dark:border-[#444C56] text-[#57606A] dark:text-[#8B949E]'
                      }`}
                    >
                      <div className="font-semibold">Andere Werte (Breite × Höhe)</div>
                      <div className="text-[11px] opacity-80">Freie Maße oder proportional skalieren</div>
                    </button>
                  </div>

                  {scaleMode === 'square' ? (
                    <div className="space-y-3 p-3.5 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60">
                      <label className="block space-y-1">
                        <span className="font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                          Quadratische Zielgröße (Breite = Höhe in Pixel):
                        </span>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={16}
                            max={6000}
                            step={10}
                            value={scaleWidth}
                            onChange={(e) => handleScaleWidthChange(Number(e.target.value))}
                            className="w-32 px-2.5 py-1.5 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                          />
                          <span className="font-mono text-[#57606A] dark:text-[#8B949E]">
                            × {scaleWidth} px (1:1 Quadrat)
                          </span>
                        </div>
                      </label>

                      <div className="space-y-1.5">
                        <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                          Standard-Covergrößen (Schnellwahl):
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {[300, 500, 600, 800, 1000, 1200, 1400, 1500].map((presetSide) => (
                            <button
                              key={presetSide}
                              type="button"
                              onClick={() => {
                                setScaleWidth(presetSide);
                                setScaleHeight(presetSide);
                              }}
                              className={`px-2 py-1 text-[11px] font-mono rounded border transition-colors cursor-pointer ${
                                scaleWidth === presetSide && scaleHeight === presetSide
                                  ? 'border-[#5BA632] bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270] font-semibold'
                                  : 'border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632]'
                              }`}
                            >
                              {presetSide} × {presetSide}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3 p-3.5 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60">
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block space-y-1">
                          <span className="font-medium text-[#1F2328] dark:text-[#EAEEF2]">Breite (px):</span>
                          <input
                            type="number"
                            min={16}
                            max={6000}
                            step={1}
                            value={scaleWidth}
                            onChange={(e) => handleScaleWidthChange(Number(e.target.value))}
                            className="w-full px-2.5 py-1.5 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                          />
                        </label>

                        <label className="block space-y-1">
                          <span className="font-medium text-[#1F2328] dark:text-[#EAEEF2]">Höhe (px):</span>
                          <input
                            type="number"
                            min={16}
                            max={6000}
                            step={1}
                            value={scaleHeight}
                            onChange={(e) => handleScaleHeightChange(Number(e.target.value))}
                            className="w-full px-2.5 py-1.5 font-mono text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                          />
                        </label>
                      </div>

                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={scaleKeepAspect}
                          onChange={(e) => {
                            const nextKeep = e.target.checked;
                            setScaleKeepAspect(nextKeep);
                            if (nextKeep && scaleImgNatural.w > 0 && scaleImgNatural.h > 0) {
                              setScaleHeight(
                                Math.max(
                                  16,
                                  Math.min(6000, Math.round((scaleWidth * scaleImgNatural.h) / scaleImgNatural.w))
                                )
                              );
                            }
                          }}
                          className="accent-[#5BA632] rounded"
                        />
                        <span>Seitenverhältnis beibehalten (Proportional zum Originalbild)</span>
                      </label>

                      <div className="space-y-1.5 pt-1">
                        <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                          Prozentuale Skalierung &amp; Format-Schnellwahl:
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {[25, 50, 75, 100, 125, 150, 200].map((pct) => (
                            <button
                              key={pct}
                              type="button"
                              onClick={() => {
                                if (!scaleImgNatural.w || !scaleImgNatural.h) return;
                                setScaleWidth(Math.max(16, Math.round((scaleImgNatural.w * pct) / 100)));
                                setScaleHeight(Math.max(16, Math.round((scaleImgNatural.h * pct) / 100)));
                              }}
                              className="px-2 py-1 text-[11px] font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] cursor-pointer"
                            >
                              {pct} %
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={() => {
                              setScaleKeepAspect(false);
                              setScaleWidth(1200);
                              setScaleHeight(950);
                            }}
                            className="px-2 py-1 text-[11px] font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] cursor-pointer"
                          >
                            1200 × 950 (CD-Backcover)
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/80 flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
              <div className="font-mono text-[#57606A] dark:text-[#8B949E]">
                Neue Auflösung:{' '}
                <strong className="text-[#2E6B14] dark:text-[#9BE270]">
                  {scaleWidth} × {scaleMode === 'square' ? scaleWidth : scaleHeight} px
                </strong>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsScaleModalOpen(false)}
                  className="px-3 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]"
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  onClick={handleApplyCoverScale}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white cursor-pointer"
                >
                  <Check className="w-4 h-4" />
                  <span>Skalierung übernehmen</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: "Speichern unter — Coverbild" (GTK FileChooserDialog-Pendant + nativer Dateidialog) */}
      {isSaveCoverModalOpen && album.coverArtUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-cover-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSavingCoverFile) {
              setIsSaveCoverModalOpen(false);
            }
          }}
        >
          <div className="w-full max-w-xl bg-white dark:bg-[#25292E] border border-[#D0D7DE] dark:border-[#444C56] rounded-lg shadow-2xl overflow-hidden flex flex-col">
            {/* Dialog-Kopfzeile im Linux Mint / GTK FileChooser-Stil */}
            <div className="px-4 py-3 border-b border-[#E1E4E8] dark:border-[#343A40] flex items-center justify-between gap-3 bg-[#F8F9FA] dark:bg-[#1C1F23]">
              <div className="flex items-center gap-2 min-w-0">
                <SystemIcon name="save_cover" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0" />
                <h2
                  id="save-cover-modal-title"
                  className="text-sm font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate"
                >
                  Speichern unter — Coverbild
                </h2>
              </div>
              <button
                type="button"
                disabled={isSavingCoverFile}
                onClick={() => setIsSaveCoverModalOpen(false)}
                className="px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#57606A] dark:text-[#8B949E] hover:text-[#1F2328] dark:hover:text-[#EAEEF2] hover:bg-[#EAEEF2]/60 dark:hover:bg-[#2D333B]"
              >
                Schließen
              </button>
            </div>

            {/* Dialog-Inhalt: Dateiname, Zielordner, Bildformat & Vorschau */}
            <div className="p-4 space-y-4 text-xs">
              {/* Obere Zeile wie im GTK-Speichern-unter-Dialog: Name & Ordner */}
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="save-cover-filename-input"
                    className="block text-[11px] font-semibold text-[#1F2328] dark:text-[#EAEEF2] mb-1"
                  >
                    Name:
                  </label>
                  <input
                    id="save-cover-filename-input"
                    type="text"
                    autoFocus
                    value={saveCoverFilename}
                    onChange={(e) => setSaveCoverFilename(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isSavingCoverFile) {
                        e.preventDefault();
                        void handleConfirmSaveCover(false);
                      }
                    }}
                    placeholder="cover.jpg"
                    className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                  />
                </div>

                <div>
                  <label
                    htmlFor="save-cover-folder-input"
                    className="block text-[11px] font-semibold text-[#1F2328] dark:text-[#EAEEF2] mb-1"
                  >
                    Ordner speichern in:
                  </label>
                  <div className="flex items-center gap-1.5">
                    <div className="relative flex-1">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#57606A] dark:text-[#8B949E]">
                        <SystemIcon name="music_folder" className="w-3.5 h-3.5" />
                      </span>
                      <input
                        id="save-cover-folder-input"
                        type="text"
                        value={saveCoverFolder}
                        onChange={(e) => setSaveCoverFolder(e.target.value)}
                        placeholder="~/Musik"
                        className="w-full pl-8 pr-2.5 py-1.5 text-xs font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                      />
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-[#57606A] dark:text-[#8B949E]">Schnellwahl:</span>
                    {[
                      settings.outputDir || '~/Musik',
                      '~/Musik',
                      '~/Bilder',
                      '~/Downloads',
                      '~/Schreibtisch',
                    ]
                      .filter((v, i, arr) => Boolean(v) && arr.indexOf(v) === i)
                      .map((folderPreset) => (
                        <button
                          key={folderPreset}
                          type="button"
                          onClick={() => setSaveCoverFolder(folderPreset)}
                          className={`px-2 py-0.5 text-[11px] font-mono rounded border transition-colors cursor-pointer ${
                            saveCoverFolder === folderPreset
                              ? 'border-[#5BA632] bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270] font-semibold'
                              : 'border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#57606A] dark:text-[#8B949E] hover:text-[#1F2328] dark:hover:text-[#EAEEF2]'
                          }`}
                        >
                          {folderPreset}
                        </button>
                      ))}
                  </div>
                </div>
              </div>

              {/* Vorschau + Dateiformat-Auswahl */}
              <div className="grid grid-cols-1 sm:grid-cols-[136px_1fr] gap-3 p-3 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60">
                <div className="w-32 h-32 mx-auto sm:mx-0 rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#111315] overflow-hidden flex items-center justify-center shrink-0">
                  <img
                    src={album.coverArtUrl}
                    alt="Cover-Vorschau"
                    className="w-full h-full object-contain"
                  />
                </div>

                <div className="space-y-2.5 flex flex-col justify-between min-w-0">
                  <div className="space-y-1">
                    <div className="font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate">
                      {album.artist ? `${album.artist} – ${album.title || 'Album'}` : album.title || 'Geladenes Cover'}
                    </div>
                    <div className="font-mono text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      Auflösung:{' '}
                      <strong className="text-[#1F2328] dark:text-[#EAEEF2]">
                        {album.coverArtWidth && album.coverArtHeight
                          ? `${album.coverArtWidth} × ${album.coverArtHeight} px`
                          : 'Originalgröße'}
                      </strong>
                      {album.coverArtSizeBytes ? ` · ${formatCoverByteSize(album.coverArtSizeBytes)}` : ''}
                    </div>
                    <div className="text-[11px] text-[#57606A] dark:text-[#8B949E] truncate">
                      Quelle: {album.coverArtSource || 'Cover geladen'}
                    </div>
                  </div>

                  <div className="space-y-2 pt-1 border-t border-[#E1E4E8] dark:border-[#343A40]">
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor="save-cover-format-select"
                        className="text-[11px] font-medium text-[#57606A] dark:text-[#8B949E]"
                      >
                        Dateiformat:
                      </label>
                      <select
                        id="save-cover-format-select"
                        value={saveCoverFormat}
                        onChange={(e) =>
                          handleSaveCoverFormatChange(e.target.value as 'jpg' | 'png' | 'webp')
                        }
                        className="px-2 py-1 text-xs font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                      >
                        <option value="jpg">JPEG-Bild (.jpg)</option>
                        <option value="png">PNG-Bild verlustfrei (.png)</option>
                        <option value="webp">WebP-Bild (.webp)</option>
                      </select>
                    </div>

                    {saveCoverFormat !== 'png' && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                          Qualität ({saveCoverFormat.toUpperCase()}):
                        </span>
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min={70}
                            max={100}
                            step={1}
                            value={saveCoverQuality}
                            onChange={(e) => setSaveCoverQuality(Number(e.target.value))}
                            className="w-28 accent-[#5BA632]"
                          />
                          <span className="font-mono text-[11px] font-semibold text-[#1F2328] dark:text-[#EAEEF2] w-9 text-right">
                            {saveCoverQuality}%
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Dialog-Fußzeile mit Zielpfad, System-Dateidialog und Speichern-Button */}
            <div className="px-4 py-3 border-t border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23] flex flex-wrap items-center justify-between gap-2 text-xs">
              <div
                className="font-mono text-[11px] text-[#57606A] dark:text-[#8B949E] truncate max-w-[240px]"
                title={`${saveCoverFolder.replace(/\/+$/, '')}/${saveCoverFilename}`}
              >
                Ziel: {saveCoverFolder.replace(/\/+$/, '')}/{saveCoverFilename}
              </div>

              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  disabled={isSavingCoverFile}
                  onClick={() => {
                    setIsSaveCoverModalOpen(false);
                    onAppendQueryLog('[Cover] Dialog „Speichern unter“ abgebrochen.');
                  }}
                  className="px-3 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] cursor-pointer"
                >
                  Abbrechen
                </button>

                {typeof (window as unknown as { showSaveFilePicker?: any }).showSaveFilePicker ===
                  'function' && (
                  <button
                    type="button"
                    disabled={isSavingCoverFile}
                    onClick={() => void handleConfirmSaveCover(true)}
                    title="Öffnet zusätzlich den nativen Betriebssystem-Dateidialog"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-[#5BA632] bg-white dark:bg-[#25292E] text-[#2E6B14] dark:text-[#9BE270] hover:bg-[#5BA632]/10 cursor-pointer"
                  >
                    <SystemIcon name="open_file" className="w-3.5 h-3.5" />
                    <span>System-Ordner wählen...</span>
                  </button>
                )}

                <button
                  type="button"
                  disabled={isSavingCoverFile || !saveCoverFilename.trim()}
                  onClick={() => void handleConfirmSaveCover(false)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 cursor-pointer"
                >
                  <SystemIcon name="save_cover" className="w-3.5 h-3.5" />
                  <span>{isSavingCoverFile ? 'Speichere...' : 'Speichern'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <FilenameToTagsModal
        isOpen={moduleMode === 'album_tag' && isFilenameToTagsOpen}
        album={album}
        fallbackFolder={settings.lastImportFolder || ''}
        onClose={() => onCloseFilenameToTags?.()}
        onApply={(updatedAlbum, summaryLog) => {
          onAlbumChange(updatedAlbum);
          onAppendQueryLog(summaryLog);
        }}
      />
      </div>
    </div>
  );
}
