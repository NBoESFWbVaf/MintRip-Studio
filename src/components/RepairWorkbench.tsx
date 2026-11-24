import React, { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  DEFAULT_MODULE_OUTPUT_DIRS,
  ExportSettings,
  normalizeCoverMaxDimension,
  normalizeMaxThreads,
} from '../types/mintrip';
import { formatDuration, triggerTextDownload } from '../utils/audioExportHelpers';
import {
  extractTopFolderNameFromEntries,
  pickDirectoryWithPersistence,
} from '../utils/folderImportHelper';
import { ModulePageHeaderBar } from './ModulePages';
import { SystemIcon } from './SystemIcons';

export type RepairSeverity = 'critical' | 'warning' | 'info';
export type RepairItemHealth = 'pending' | 'scanning' | 'ok' | 'warning' | 'critical' | 'repaired' | 'error';
export type RepairFilterKind =
  | 'all'
  | 'issues'
  | 'hide_clean_folders'
  | 'critical'
  | 'repaired';
export type RepairFixAction =
  | 'header_strip'
  | 'remux_faststart'
  | 'vbr_header_rebuild'
  | 'cover_optimize'
  | 'lossless_reencode';

export interface RepairFindingItem {
  id: string;
  code: string;
  severity: RepairSeverity;
  category: 'header' | 'frames' | 'tags' | 'stream' | 'audio';
  stage?: 'fast' | 'deep';
  fixAction?: RepairFixAction;
  title: string;
  description: string;
  recommendedFix: string;
  autoFixable: boolean;
}

export interface RepairStructureSummary {
  codec: string;
  container: string;
  detectedMagic?: string;
  magicMatchesExtension?: boolean;
  m4aMoovPosition?: 'before_mdat' | 'after_mdat' | 'missing' | null;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  sampleFmt?: string;
  channelLayout?: string;
  bitrateKbps: number;
  durationSeconds: number;
  isVbr: boolean;
  hasXingHeader: boolean;
  xingFrames: number;
  actualFrames: number;
  id3v2Count: number;
  id3v2Versions: string[];
  hasId3v1: boolean;
  hasApev2: boolean;
  leadingGarbageBytes: number;
  trailingGarbageBytes: number;
  corruptSyncGaps: number;
  flacMd5Valid: boolean | null;
  flacMd5Status?: 'valid' | 'missing' | 'mismatch' | 'unverified' | null;
  flacHasSeektable: boolean | null;
  seekTableValid?: boolean | null;
  flacIsOgg?: boolean | null;
  flacStreaminfoValid?: boolean | null;
  flacSubsetValid?: boolean | null;
  flacMinBlockSize?: number | null;
  flacMaxBlockSize?: number | null;
  flacVariableBlockSize?: boolean | null;
  flacFirefoxCompatible?: 'compatible' | 'warning' | 'incompatible' | null;
  maxVolumeDb: number | null;
  meanVolumeDb: number | null;
  decodeErrorCount: number;
  streamCrcErrors?: number;
  streamTruncated?: boolean;
  hasCoverArt: boolean;
  coverArtMime?: string;
  coverArtBytes?: number;
  coverArtWidth?: number;
  coverArtHeight?: number;
  missingCoreTags: string[];
  errorPositions?: RepairErrorPosition[];
}

export interface RepairErrorPosition {
  zone: 'start' | 'stream' | 'end';
  ratio: number | null;
  severity: RepairSeverity;
  code: string;
  label: string;
  timeSeconds?: number | null;
}

export interface RepairPipelineReport {
  stage1FastCheck: {
    passed: boolean;
    durationMs: number;
    issueCount: number;
    checksPerformed: string[];
  };
  stage2DeepCheck: {
    executed: boolean;
    passed: boolean | null;
    durationMs: number;
    crcErrorCount: number;
    truncatedDetected: boolean;
    seekTableValid: boolean | null;
    failureReasons?: string[];
  };
  recommendedFixes: RepairFixAction[];
}

export interface RepairStepLogEntry {
  step: string;
  status: 'ok' | 'skipped' | 'warning';
  detail: string;
}

const FIX_ACTION_LABELS: Record<RepairFixAction, string> = {
  header_strip: 'Header-Strip (ID3/Müll)',
  vbr_header_rebuild: 'VBR-Header-Rebuild',
  remux_faststart: 'Remuxing / Faststart',
  cover_optimize: 'Cover-Optimierung (Maße / ≤ 1 MB)',
  lossless_reencode: 'Verlustfreies Re-Encoding',
};

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function sanitizeRepairCoverStem(raw?: string): string {
  const noTokens = String(raw || 'cover').replace(/\{[^}]*\}/g, '');
  const noExt = noTokens.replace(/\.(jpe?g|png|webp)$/i, '');
  const cleaned = noExt
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[._-]+|[._-]+$/g, '');
  return cleaned || 'cover';
}

interface RepairItem {
  id: string;
  file: File;
  relativePath: string;
  relDir: string;
  sourceExt: string;
  sizeBytes: number;
  selected: boolean;
  health: RepairItemHealth;
  findings: RepairFindingItem[];
  structure?: RepairStructureSummary;
  pipeline?: RepairPipelineReport;
  statusMessage: string;
  progress: number;
  repairedBlob?: Blob;
  repairedUrl?: string;
  repairedFileName?: string;
  repairedCoverBlob?: Blob;
  repairedCoverUrl?: string;
  repairedCoverFileName?: string;
  beforeFindingCount?: number;
  afterFindingCount?: number;
}

export interface RepairWorkbenchHandle {
  openSingleFilePicker: () => void;
  openRecursiveFolderPicker: () => void;
  rescanAll: () => void;
}

export interface RepairToolbarState {
  isBusy: boolean;
  itemCount: number;
}

interface RepairWorkbenchProps {
  settings: ExportSettings;
  onSettingsChange?: React.Dispatch<React.SetStateAction<ExportSettings>>;
  onAppendQueryLog: (line: string) => void;
  actionRef?: React.MutableRefObject<RepairWorkbenchHandle | null>;
  onToolbarStateChange?: (state: RepairToolbarState) => void;
}

const AUDIO_REPAIR_RE = /\.(mp3|mp2|flac|wav|aiff|aif|aifc|ogg|opus|m4a)$/i;
const SPACER_ROW_HEIGHT = 14;
const FOLDER_ROW_HEIGHT = 36;
const FILE_ROW_HEIGHT = 50;

type VirtualRepairRow =
  | { kind: 'spacer'; key: string; height: number }
  | {
      kind: 'folder';
      key: string;
      dir: string;
      label: string;
      totalCount: number;
      selectedCount: number;
      allSelected: boolean;
      someSelected: boolean;
      height: number;
    }
  | { kind: 'file'; key: string; item: RepairItem; height: number };

function formatBytesReadable(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getRelDirFromRelativePath(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const idx = norm.lastIndexOf('/');
  return idx > 0 ? norm.slice(0, idx) : '';
}

function getRepairSeverityIndicator(item: RepairItem): {
  color: string;
  label: string;
} {
  if (item.health === 'pending' || item.health === 'scanning') {
    return { color: '#94A3B8', label: 'Wartet auf Diagnose / Prüfung läuft' };
  }
  const hasCritical =
    item.health === 'critical' ||
    item.health === 'error' ||
    item.findings.some((f) => f.severity === 'critical') ||
    item.structure?.flacFirefoxCompatible === 'incompatible';
  if (hasCritical) {
    return { color: '#DC2626', label: 'Rot: Defekt / nicht abspielbar' };
  }
  const hasWarning =
    item.health === 'warning' ||
    item.findings.some((f) => f.severity === 'warning') ||
    item.structure?.flacFirefoxCompatible === 'warning';
  if (hasWarning) {
    return { color: '#F97316', label: 'Orange: Warnung / eingeschränkt kompatibel' };
  }
  const hasInfo = item.findings.some((f) => f.severity === 'info');
  if (hasInfo) {
    return { color: '#EAB308', label: 'Gelb: Hinweis / kleine Abweichung' };
  }
  return { color: '#22C55E', label: 'Grün: OK' };
}

function resolveFindingPositionSummary(
  finding: RepairFindingItem,
  structure?: RepairStructureSummary | null
): { zone: 'start' | 'stream' | 'end'; text: string } {
  const fromList = (structure?.errorPositions || []).filter((p) => p.code === finding.code);
  if (fromList.length > 0) {
    const first = fromList[0];
    if (first.zone === 'start') {
      return { zone: 'start', text: 'Dateianfang (Header / Tags)' };
    }
    if (first.zone === 'end') {
      return { zone: 'end', text: 'Dateiende (Trailer)' };
    }
    const timed = fromList.filter((p) => typeof p.ratio === 'number');
    if (timed.length > 0) {
      const spots = timed
        .slice(0, 3)
        .map((p) => {
          const pct = `${Math.round((p.ratio || 0) * 100)} %`;
          return typeof p.timeSeconds === 'number' && p.timeSeconds >= 0
            ? `~${formatDuration(p.timeSeconds)} (${pct})`
            : pct;
        })
        .join(', ');
      return {
        zone: 'stream',
        text: `Audiostrom bei ${spots}${timed.length > 3 ? ` (+${timed.length - 3})` : ''}`,
      };
    }
    return { zone: 'stream', text: 'Gesamter Audiostrom' };
  }
  if (
    finding.code === 'trailing_garbage' ||
    finding.code === 'stream_truncated_file' ||
    finding.code === 'm4a_moov_after_mdat' ||
    finding.code === 'apev2_tag_present'
  ) {
    return { zone: 'end', text: 'Dateiende (Trailer)' };
  }
  if (finding.category === 'header' || finding.category === 'tags' || finding.code === 'leading_garbage') {
    return { zone: 'start', text: 'Dateianfang (Header / Tags)' };
  }
  return { zone: 'stream', text: 'Audiostrom' };
}

function getEffectiveErrorPositions(item: RepairItem): RepairErrorPosition[] {
  if (item.structure?.errorPositions && item.structure.errorPositions.length > 0) {
    return item.structure.errorPositions;
  }
  return item.findings.map((f) => {
    const meta = resolveFindingPositionSummary(f, item.structure);
    return {
      zone: meta.zone,
      ratio: meta.zone === 'start' ? 0 : meta.zone === 'end' ? 1 : null,
      severity: f.severity,
      code: f.code,
      label: f.title,
      timeSeconds: meta.zone === 'start' ? 0 : meta.zone === 'end' ? item.structure?.durationSeconds ?? null : null,
    };
  });
}

interface DropEntryFileResult {
  file: File;
  relativePath: string;
}

interface CollectTransferOptions {
  signal?: AbortSignal;
  onProgress?: (loadedCount: number) => void;
}

const NON_AUDIO_SKIP_RE =
  /\.(jpe?g|png|webp|gif|bmp|tiff?|svg|ico|txt|nfo|cue|log|m3u8?|pls|sfv|md5|sha256|pdf|docx?|xlsx?|xml|json|ini|cfg|conf|db|url|html?|css|js|py|sh)$/i;

function isPotentialRepairAudioFileName(fileName: string): boolean {
  if (AUDIO_REPAIR_RE.test(fileName)) return true;
  if (NON_AUDIO_SKIP_RE.test(fileName)) return false;
  return !fileName.includes('.');
}

async function waitForFullListPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fallbackTimer = window.setTimeout(finish, 240);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          window.clearTimeout(fallbackTimer);
          finish();
        }, 60);
      });
    });
  });
}

async function collectFilesFromDataTransfer(
  dataTransfer: DataTransfer,
  options?: CollectTransferOptions
): Promise<DropEntryFileResult[]> {
  const results: DropEntryFileResult[] = [];
  const items = Array.from(dataTransfer.items || []);

  // Einträge & Fallback-Dateien synchron vor dem ersten await sichern, da DataTransfer danach geleert wird
  const entries = items
    .map((it) =>
      typeof (it as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null })
        .webkitGetAsEntry === 'function'
        ? (it as DataTransferItem & { webkitGetAsEntry: () => FileSystemEntry | null }).webkitGetAsEntry()
        : null
    )
    .filter((entry): entry is FileSystemEntry => entry !== null);
  const fallbackFiles = entries.length === 0 ? Array.from(dataTransfer.files || []) : [];

  const readAllEntries = async (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> => {
    const all: FileSystemEntry[] = [];
    while (true) {
      if (options?.signal?.aborted) break;
      const batch = await new Promise<FileSystemEntry[]>((resolve) => {
        reader.readEntries(
          (read) => resolve(read || []),
          () => resolve([])
        );
      });
      if (!batch.length) break;
      all.push(...batch);
    }
    return all;
  };

  let visitedEntries = 0;
  const traverseEntry = async (entry: FileSystemEntry, parentPath: string): Promise<void> => {
    if (options?.signal?.aborted) return;
    if (entry.isFile) {
      if (!isPotentialRepairAudioFileName(entry.name)) {
        visitedEntries += 1;
        if (visitedEntries % 100 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        return;
      }
      const fileEntry = entry as FileSystemFileEntry;
      const f = await new Promise<File | null>((resolve) => {
        fileEntry.file(
          (loaded) => resolve(loaded),
          () => resolve(null)
        );
      });
      if (options?.signal?.aborted) return;
      if (f) {
        const relPath = parentPath ? `${parentPath}/${f.name}` : f.name;
        results.push({ file: f, relativePath: relPath });
        if (results.length === 1 || results.length % 10 === 0) {
          options?.onProgress?.(results.length);
        }
        if (results.length % 40 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const nextParent = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const children = await readAllEntries(dirEntry.createReader());
      for (const child of children) {
        if (options?.signal?.aborted) return;
        await traverseEntry(child, nextParent);
      }
    }
  };

  if (entries.length > 0) {
    for (const entry of entries) {
      if (options?.signal?.aborted) break;
      await traverseEntry(entry, '');
    }
    options?.onProgress?.(results.length);
    return results;
  }

  for (const file of fallbackFiles) {
    if (options?.signal?.aborted) break;
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    results.push({ file, relativePath: rel });
  }
  options?.onProgress?.(results.length);
  return results;
}

export function RepairWorkbench({
  settings,
  onSettingsChange,
  onAppendQueryLog,
  actionRef,
  onToolbarStateChange,
}: RepairWorkbenchProps) {
  const coverMaxDimension = normalizeCoverMaxDimension(settings.coverMaxDimension);
  const [items, setItems] = useState<RepairItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [highlightedIds, setHighlightedIds] = useState<string[]>([]);
  const [anchorHighlightId, setAnchorHighlightId] = useState<string | null>(null);
  const [playingItemId, setPlayingItemId] = useState<string | null>(null);
  const [playbackCurrentTime, setPlaybackCurrentTime] = useState<number>(0);
  const [playbackDuration, setPlaybackDuration] = useState<number>(0);
  const [activeFilter, setActiveFilter] = useState<RepairFilterKind>('all');

  // Scan- und Reparatur-Transformationen (inspiriert von MP3Diags + Multi-Format-Ansatz)
  const [deepScan, setDeepScan] = useState<boolean>(true);
  const [fixVbrXing, setFixVbrXing] = useState<boolean>(true);
  const [stripGarbageFrames, setStripGarbageFrames] = useState<boolean>(true);
  const [cleanTags, setCleanTags] = useState<boolean>(true);
  const [rebuildContainer, setRebuildContainer] = useState<boolean>(true);
  const [writeFlacSeektable, setWriteFlacSeektable] = useState<boolean>(true);
  const [optimizeCover, setOptimizeCover] = useState<boolean>(false);
  const [firefoxCompat, setFirefoxCompat] = useState<boolean>(false);
  const [id3v2Version, setId3v2Version] = useState<3 | 4>(settings.id3v2Version ?? 4);

  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState<boolean>(false);
  const [loadingFileCount, setLoadingFileCount] = useState<number>(0);
  const [loadingSourceLabel, setLoadingSourceLabel] = useState<string>('');
  const [isDragActive, setIsDragActive] = useState<boolean>(false);
  const [isTableDragActive, setIsTableDragActive] = useState<boolean>(false);
  const [inspectorWidthPct, setInspectorWidthPct] = useState<number>(30);
  const [isResizingInspector, setIsResizingInspector] = useState<boolean>(false);
  const [isBuildingZip, setIsBuildingZip] = useState<boolean>(false);
  const [copiedInspector, setCopiedInspector] = useState<boolean>(false);
  const [isRepairSetupOpen, setIsRepairSetupOpen] = useState<boolean>(false);

  const singleFileInputRef = useRef<HTMLInputElement>(null);
  const recursiveFolderInputRef = useRef<HTMLInputElement>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const rootDragDepthRef = useRef<number>(0);
  const tableDragDepthRef = useRef<number>(0);
  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const operationLockRef = useRef<boolean>(false);
  const itemsRef = useRef<RepairItem[]>([]);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);
  const playSessionRef = useRef<number>(0);
  const isSeekingPlaybackRef = useRef<boolean>(false);
  const pendingPatchesRef = useRef<Map<string, Partial<RepairItem>>>(new Map());
  const patchFlushTimerRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const [tableScrollTop, setTableScrollTop] = useState<number>(0);
  const [tableViewportHeight, setTableViewportHeight] = useState<number>(520);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const flushPendingPatches = (): RepairItem[] => {
    if (patchFlushTimerRef.current !== null) {
      window.clearTimeout(patchFlushTimerRef.current);
      patchFlushTimerRef.current = null;
    }
    const pending = pendingPatchesRef.current;
    if (pending.size === 0) return itemsRef.current;
    pendingPatchesRef.current = new Map();
    const applyPatches = (
      list: RepairItem[],
      revokeReplacedUrls: boolean
    ): { next: RepairItem[]; changed: boolean } => {
      let changed = false;
      const next = list.map((it) => {
        const patch = pending.get(it.id);
        if (!patch) return it;
        changed = true;
        if (revokeReplacedUrls) {
          if (patch.repairedUrl && it.repairedUrl && it.repairedUrl !== patch.repairedUrl) {
            URL.revokeObjectURL(it.repairedUrl);
          }
          if (
            patch.repairedCoverUrl &&
            it.repairedCoverUrl &&
            it.repairedCoverUrl !== patch.repairedCoverUrl
          ) {
            URL.revokeObjectURL(it.repairedCoverUrl);
          }
        }
        return { ...it, ...patch };
      });
      return { next, changed };
    };
    const syncApplied = applyPatches(itemsRef.current, false);
    if (syncApplied.changed) {
      itemsRef.current = syncApplied.next;
    }
    setItems((prev) => {
      const res = applyPatches(prev, true);
      if (res.changed) {
        itemsRef.current = res.next;
        return res.next;
      }
      return prev;
    });
    return itemsRef.current;
  };

  const queueItemPatch = (id: string, patch: Partial<RepairItem>, immediate = false) => {
    const existing = pendingPatchesRef.current.get(id);
    pendingPatchesRef.current.set(id, existing ? { ...existing, ...patch } : patch);
    if (immediate) {
      flushPendingPatches();
      return;
    }
    if (patchFlushTimerRef.current === null) {
      patchFlushTimerRef.current = window.setTimeout(() => {
        flushPendingPatches();
      }, 80);
    }
  };

  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const updateH = () => {
      if (el.clientHeight > 0) {
        setTableViewportHeight(el.clientHeight);
      }
    };
    updateH();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(updateH);
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, [items.length === 0]);

  useEffect(() => {
    onToolbarStateChange?.({
      isBusy: isBusy || isLoadingFiles,
      itemCount: items.length,
    });
  }, [isBusy, isLoadingFiles, items.length, onToolbarStateChange]);

  useEffect(() => {
    if (recursiveFolderInputRef.current) {
      recursiveFolderInputRef.current.setAttribute('webkitdirectory', '');
      recursiveFolderInputRef.current.setAttribute('directory', '');
    }
  }, []);

  useEffect(() => {
    if (!isResizingInspector) return;
    const handleMove = (ev: MouseEvent) => {
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const rawPct = ((rect.right - ev.clientX) / rect.width) * 100;
      const clamped = Math.max(20, Math.min(65, Math.round(rawPct * 10) / 10));
      setInspectorWidthPct(clamped);
    };
    const handleUp = () => {
      setIsResizingInspector(false);
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizingInspector]);

  const stopAudioPreview = (logStop = false) => {
    playSessionRef.current += 1;
    isSeekingPlaybackRef.current = false;
    const prevId = playingItemId;
    if (audioPreviewRef.current) {
      try {
        audioPreviewRef.current.pause();
        audioPreviewRef.current.src = '';
      } catch {
        // Ignorieren
      }
      audioPreviewRef.current = null;
    }
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }
    setPlayingItemId(null);
    setPlaybackCurrentTime(0);
    setPlaybackDuration(0);
    if (logStop && prevId) {
      const stoppedItem = itemsRef.current.find((it) => it.id === prevId);
      if (stoppedItem) {
        onAppendQueryLog(`[Reparatur · Vorhören] Wiedergabe von „${stoppedItem.relativePath}“ gestoppt.`);
      }
    }
  };

  const handleSeekAudioPreview = (targetSeconds: number) => {
    const audio = audioPreviewRef.current;
    const maxDur =
      audio && Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : playbackDuration;
    const clamped = Math.max(0, Math.min(maxDur > 0 ? maxDur : targetSeconds, targetSeconds));
    setPlaybackCurrentTime(clamped);
    if (audio && Number.isFinite(clamped)) {
      try {
        audio.currentTime = clamped;
      } catch {
        // Ignorieren, falls Browser noch nicht seekbar ist
      }
    }
  };

  const handleToggleAudioPreview = async (item: RepairItem) => {
    if (playingItemId === item.id) {
      stopAudioPreview(true);
      return;
    }
    stopAudioPreview(false);
    const sessionId = playSessionRef.current;
    const sourceBlob = item.repairedBlob ?? item.file;
    const fallbackDuration =
      item.structure?.durationSeconds && item.structure.durationSeconds > 0
        ? item.structure.durationSeconds
        : 0;
    try {
      const objUrl = URL.createObjectURL(sourceBlob);
      previewObjectUrlRef.current = objUrl;
      const audio = new Audio(objUrl);
      const syncAudioDuration = () => {
        if (playSessionRef.current !== sessionId) return;
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          setPlaybackDuration(audio.duration);
        }
      };
      audio.onloadedmetadata = syncAudioDuration;
      audio.ondurationchange = syncAudioDuration;
      audio.ontimeupdate = () => {
        if (playSessionRef.current !== sessionId || isSeekingPlaybackRef.current) return;
        setPlaybackCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          setPlaybackDuration(audio.duration);
        }
      };
      audio.onended = () => {
        if (previewObjectUrlRef.current === objUrl) {
          URL.revokeObjectURL(objUrl);
          previewObjectUrlRef.current = null;
        }
        if (audioPreviewRef.current === audio) {
          audioPreviewRef.current = null;
        }
        if (playSessionRef.current === sessionId) {
          isSeekingPlaybackRef.current = false;
          setPlayingItemId(null);
          setPlaybackCurrentTime(0);
          setPlaybackDuration(0);
        }
      };
      audio.onerror = () => {
        if (previewObjectUrlRef.current === objUrl) {
          URL.revokeObjectURL(objUrl);
          previewObjectUrlRef.current = null;
        }
        if (audioPreviewRef.current === audio) {
          audioPreviewRef.current = null;
        }
        if (playSessionRef.current === sessionId) {
          isSeekingPlaybackRef.current = false;
          setPlayingItemId(null);
          setPlaybackCurrentTime(0);
          setPlaybackDuration(0);
          onAppendQueryLog(
            `[Reparatur · Vorhören] Browser-Audiowiedergabe für „${item.relativePath}“ nicht unterstützt oder fehlgeschlagen.`
          );
        }
      };
      audioPreviewRef.current = audio;
      setPlayingItemId(item.id);
      setPlaybackCurrentTime(0);
      setPlaybackDuration(fallbackDuration);
      await audio.play();
      const variantLabel = item.repairedBlob ? 'Repariert' : 'Original';
      onAppendQueryLog(
        `[Reparatur · Vorhören] Spiele „${item.relativePath}“ (${variantLabel}) ab...`
      );
    } catch (err) {
      stopAudioPreview(false);
      const msg = err instanceof Error ? err.message : 'Wiedergabe konnte nicht gestartet werden.';
      onAppendQueryLog(`[Reparatur · Vorhören] Fehler: ${msg}`);
    }
  };

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (audioPreviewRef.current) {
        try {
          audioPreviewRef.current.pause();
          audioPreviewRef.current.src = '';
        } catch {
          // Ignorieren
        }
        audioPreviewRef.current = null;
      }
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = null;
      }
      if (patchFlushTimerRef.current !== null) {
        window.clearTimeout(patchFlushTimerRef.current);
        patchFlushTimerRef.current = null;
      }
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      pendingPatchesRef.current.clear();
      for (const it of itemsRef.current) {
        if (it.repairedUrl) {
          URL.revokeObjectURL(it.repairedUrl);
        }
        if (it.repairedCoverUrl) {
          URL.revokeObjectURL(it.repairedCoverUrl);
        }
      }
    };
  }, []);

  const isTrackCompletelyClean = (it: RepairItem): boolean => {
    if (it.health !== 'ok' && it.health !== 'repaired') return false;
    if (it.findings.length > 0) return false;
    const ff = it.structure?.flacFirefoxCompatible;
    if (ff === 'incompatible' || ff === 'warning') return false;
    return true;
  };

  const { cleanFolderSet, totalFolderCount, nonCleanFolderCount } = useMemo(() => {
    const byDir = new Map<string, RepairItem[]>();
    for (const it of items) {
      const dirKey = it.relDir || '';
      let list = byDir.get(dirKey);
      if (!list) {
        list = [];
        byDir.set(dirKey, list);
      }
      list.push(it);
    }
    const cleanSet = new Set<string>();
    for (const [dirKey, list] of byDir.entries()) {
      if (list.length > 0 && list.every(isTrackCompletelyClean)) {
        cleanSet.add(dirKey);
      }
    }
    return {
      cleanFolderSet: cleanSet,
      totalFolderCount: byDir.size,
      nonCleanFolderCount: byDir.size - cleanSet.size,
    };
  }, [items]);

  const visibleItems = useMemo(() => {
    if (activeFilter === 'all') return items;
    if (activeFilter === 'issues') {
      return items.filter(
        (it) => it.health === 'warning' || it.health === 'critical' || it.health === 'error'
      );
    }
    if (activeFilter === 'hide_clean_folders') {
      return items.filter((it) => !cleanFolderSet.has(it.relDir || ''));
    }
    if (activeFilter === 'critical') {
      return items.filter((it) => it.health === 'critical' || it.health === 'error');
    }
    return items.filter((it) => it.health === 'repaired' || Boolean(it.repairedBlob));
  }, [items, activeFilter, cleanFolderSet]);

  // Ordner-Gruppierung für visuellen Abstand zwischen einzelnen Ordnern
  const folderGroups = useMemo(() => {
    const groups: Array<{ dir: string; items: RepairItem[] }> = [];
    const groupMap = new Map<string, { dir: string; items: RepairItem[] }>();
    for (const it of visibleItems) {
      const dirKey = it.relDir || '';
      let grp = groupMap.get(dirKey);
      if (!grp) {
        grp = { dir: dirKey, items: [] };
        groupMap.set(dirKey, grp);
        groups.push(grp);
      }
      grp.items.push(it);
    }
    return groups;
  }, [visibleItems]);

  const flatVisibleItems = useMemo(() => {
    const flat: RepairItem[] = [];
    for (const g of folderGroups) {
      for (const it of g.items) {
        flat.push(it);
      }
    }
    return flat;
  }, [folderGroups]);

  const visibleIdSet = useMemo(() => new Set(flatVisibleItems.map((it) => it.id)), [flatVisibleItems]);
  const highlightedIdSet = useMemo(
    () => new Set(highlightedIds.filter((id) => visibleIdSet.has(id))),
    [highlightedIds, visibleIdSet]
  );
  const highlightedVisibleItems = useMemo(
    () => flatVisibleItems.filter((it) => highlightedIdSet.has(it.id)),
    [flatVisibleItems, highlightedIdSet]
  );

  const { virtualRows, rowOffsets, totalVirtualHeight } = useMemo(() => {
    const rows: VirtualRepairRow[] = [];
    const offsets: number[] = [];
    let y = 0;
    for (let groupIdx = 0; groupIdx < folderGroups.length; groupIdx++) {
      const group = folderGroups[groupIdx];
      if (groupIdx > 0) {
        rows.push({
          kind: 'spacer',
          key: `spacer-${group.dir || '__root__'}-${groupIdx}`,
          height: SPACER_ROW_HEIGHT,
        });
        offsets.push(y);
        y += SPACER_ROW_HEIGHT;
      }
      let folderSelCnt = 0;
      for (const x of group.items) {
        if (x.selected) folderSelCnt += 1;
      }
      const folderAllSel = group.items.length > 0 && folderSelCnt === group.items.length;
      const folderSomeSel = folderSelCnt > 0 && !folderAllSel;
      const folderLabel = group.dir || 'Einzeldateien (ohne Ordner)';
      rows.push({
        kind: 'folder',
        key: `folder-${group.dir || '__root__'}-${groupIdx}`,
        dir: group.dir,
        label: folderLabel,
        totalCount: group.items.length,
        selectedCount: folderSelCnt,
        allSelected: folderAllSel,
        someSelected: folderSomeSel,
        height: FOLDER_ROW_HEIGHT,
      });
      offsets.push(y);
      y += FOLDER_ROW_HEIGHT;

      for (const item of group.items) {
        rows.push({
          kind: 'file',
          key: item.id,
          item,
          height: FILE_ROW_HEIGHT,
        });
        offsets.push(y);
        y += FILE_ROW_HEIGHT;
      }
    }
    return { virtualRows: rows, rowOffsets: offsets, totalVirtualHeight: y };
  }, [folderGroups]);

  const { visibleVirtualRows, topSpacerHeight, bottomSpacerHeight } = useMemo(() => {
    const count = virtualRows.length;
    if (count === 0) {
      return {
        visibleVirtualRows: [] as VirtualRepairRow[],
        topSpacerHeight: 0,
        bottomSpacerHeight: 0,
      };
    }
    const viewTop = Math.max(0, tableScrollTop);
    const viewBottom = viewTop + Math.max(320, tableViewportHeight);

    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowOffsets[mid] + virtualRows[mid].height <= viewTop) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const bucketStart = Math.floor(lo / 8) * 8;
    const startIdx = Math.max(0, bucketStart - 12);

    let lo2 = lo;
    let hi2 = count - 1;
    while (lo2 < hi2) {
      const mid = (lo2 + hi2 + 1) >> 1;
      if (rowOffsets[mid] < viewBottom) {
        lo2 = mid;
      } else {
        hi2 = mid - 1;
      }
    }
    const bucketEnd = Math.ceil((lo2 + 1) / 8) * 8 - 1;
    const endIdx = Math.min(count - 1, bucketEnd + 12);

    const topH = rowOffsets[startIdx] ?? 0;
    const lastEnd = (rowOffsets[endIdx] ?? 0) + (virtualRows[endIdx]?.height ?? 0);
    const bottomH = Math.max(0, totalVirtualHeight - lastEnd);
    return {
      visibleVirtualRows: virtualRows.slice(startIdx, endIdx + 1),
      topSpacerHeight: topH,
      bottomSpacerHeight: bottomH,
    };
  }, [virtualRows, rowOffsets, totalVirtualHeight, tableScrollTop, tableViewportHeight]);

  useEffect(() => {
    if (playingItemId && !visibleIdSet.has(playingItemId)) {
      stopAudioPreview(false);
    }
  }, [playingItemId, visibleIdSet]);

  const {
    selectedCount,
    okCount,
    warningCount,
    criticalCount,
    repairedCount,
    totalProgress,
  } = useMemo(() => {
    let sel = 0;
    let ok = 0;
    let warn = 0;
    let crit = 0;
    let rep = 0;
    let progSum = 0;
    for (const it of items) {
      if (it.selected) sel += 1;
      if (it.health === 'ok') ok += 1;
      else if (it.health === 'warning') warn += 1;
      else if (it.health === 'critical' || it.health === 'error') crit += 1;
      if (it.repairedBlob || it.health === 'repaired') rep += 1;
      progSum += Math.max(0, Math.min(1, it.progress));
    }
    return {
      selectedCount: sel,
      okCount: ok,
      warningCount: warn,
      criticalCount: crit,
      repairedCount: rep,
      totalProgress: items.length > 0 ? Math.round((progSum / items.length) * 100) : 0,
    };
  }, [items]);

  const { allSelected, someSelected } = useMemo(() => {
    if (flatVisibleItems.length === 0) {
      return { allSelected: false, someSelected: false };
    }
    let visSel = 0;
    for (const it of flatVisibleItems) {
      if (it.selected) visSel += 1;
    }
    const all = visSel === flatVisibleItems.length;
    return { allSelected: all, someSelected: visSel > 0 && !all };
  }, [flatVisibleItems]);

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  const activeItem = useMemo(
    () =>
      (selectedItemId ? items.find((it) => it.id === selectedItemId) : undefined) ||
      flatVisibleItems[0] ||
      items[0] ||
      null,
    [items, selectedItemId, flatVisibleItems]
  );

  const runBoundedRepairPool = async <T,>(
    queue: T[],
    workerCount: number,
    workerFn: (item: T) => Promise<void>,
    signal?: AbortSignal
  ): Promise<void> => {
    if (queue.length === 0) return;
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(workerCount, queue.length)) }, async () => {
      while (!signal?.aborted) {
        const idx = cursor++;
        if (idx >= queue.length) return;
        await workerFn(queue[idx]);
      }
    });
    await Promise.all(workers);
  };

  const analyzeSingleItem = async (
    targetItem: RepairItem,
    useDeep: boolean,
    signal?: AbortSignal,
    ffmpegThreads = 1
  ) => {
    queueItemPatch(targetItem.id, {
      health: 'scanning',
      progress: 0.25,
      statusMessage: useDeep ? 'Tiefendiagnose läuft...' : 'Header-Prüfung läuft...',
    });

    try {
      const scanSourceBlob: Blob = targetItem.repairedBlob ?? targetItem.file;
      const scanFileName = targetItem.repairedFileName || targetItem.file.name;
      const qs = new URLSearchParams({
        sourceName: scanFileName,
        deepScan: String(useDeep),
        coverMaxDimension: String(coverMaxDimension),
        ffmpegThreads: String(Math.max(1, Math.min(16, Math.round(ffmpegThreads)))),
      });
      const res = await fetch(`/api/repair/analyze?${qs.toString()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Source-Name': encodeURIComponent(scanFileName),
        },
        body: scanSourceBlob,
        signal,
      });

      if (!res.ok) {
        const errPayload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errPayload.error || `HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        healthStatus: 'ok' | 'warning' | 'critical';
        findings: RepairFindingItem[];
        structure: RepairStructureSummary;
        pipeline?: RepairPipelineReport;
      };

      const issueCount = data.findings.filter((f) => f.severity !== 'info').length;
      const infoCount = data.findings.filter((f) => f.severity === 'info').length;
      const summaryMsg =
        data.healthStatus === 'ok'
          ? infoCount > 0
            ? `Technisch OK (${infoCount} Hinweis)`
            : 'Fehlerfrei · Beide Stufen OK'
          : data.healthStatus === 'warning'
          ? `${issueCount} Warnung(en) erkannt`
          : `${issueCount} Problem(e) · Auto-Repair verfügbar`;

      queueItemPatch(targetItem.id, {
        selected: false,
        health: data.healthStatus,
        findings: data.findings,
        structure: data.structure,
        pipeline: data.pipeline,
        progress: 1,
        statusMessage: summaryMsg,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw err;
      }
      const msg = err instanceof Error ? err.message : 'Analyse fehlgeschlagen';
      queueItemPatch(targetItem.id, {
        selected: false,
        health: 'error',
        progress: 0,
        statusMessage: `Analysefehler: ${msg}`,
      });
    }
  };

  const runImportAndAnalyze = async (
    sourceKindLabel: string,
    collectEntries: (ctx: {
      signal: AbortSignal;
      onProgress: (loadedCount: number) => void;
    }) => Promise<Array<{ file: File; relativePath: string }> | null>
  ) => {
    if (operationLockRef.current) {
      onAppendQueryLog(
        '[Reparatur] Import ignoriert: Aktueller Ladevorgang oder laufende Diagnose ist noch nicht abgeschlossen.'
      );
      return;
    }

    const ctrl = new AbortController();
    operationLockRef.current = true;
    abortControllerRef.current = ctrl;
    setActiveFilter('all');
    setIsBusy(true);
    setIsLoadingFiles(true);
    setLoadingFileCount(0);
    setLoadingSourceLabel(sourceKindLabel);

    try {
      onAppendQueryLog(
        `[Reparatur] Lade Dateien über „${sourceKindLabel}“... (Analyse startet erst nach vollständigem Laden)`
      );

      // PHASE 1: Alle Dateien vollständig einsammeln, bevor irgendeine Analyse startet
      let lastProgTs = 0;
      const reportLoadProgress = (count: number, force = false) => {
        const now = performance.now();
        if (!force && now - lastProgTs < 100) return;
        lastProgTs = now;
        setLoadingFileCount(count);
      };

      const rawEntries = await collectEntries({
        signal: ctrl.signal,
        onProgress: (count) => reportLoadProgress(count),
      });

      if (ctrl.signal.aborted || rawEntries === null) {
        if (ctrl.signal.aborted) {
          onAppendQueryLog('[Reparatur] Dateiladen durch Benutzer abgebrochen.');
        }
        return;
      }

      const audioEntries = rawEntries.filter(
        (entry) => AUDIO_REPAIR_RE.test(entry.file.name) || entry.file.type.startsWith('audio/')
      );
      if (audioEntries.length === 0) {
        onAppendQueryLog(
          `[Reparatur] Keine unterstützten Audiodateien beim ${sourceKindLabel} gefunden.`
        );
        return;
      }

      audioEntries.sort((a, b) =>
        a.relativePath.localeCompare(b.relativePath, undefined, {
          numeric: true,
          sensitivity: 'base',
        })
      );

      // Vorherige Liste leeren, sobald neue Audiodateien per Import oder Drag & Drop vorliegen
      stopAudioPreview(false);
      if (patchFlushTimerRef.current !== null) {
        window.clearTimeout(patchFlushTimerRef.current);
        patchFlushTimerRef.current = null;
      }
      pendingPatchesRef.current.clear();
      for (const oldItem of itemsRef.current) {
        if (oldItem.repairedUrl) URL.revokeObjectURL(oldItem.repairedUrl);
        if (oldItem.repairedCoverUrl) URL.revokeObjectURL(oldItem.repairedCoverUrl);
      }

      const seenKeys = new Set<string>();

      const newItems: RepairItem[] = [];
      for (let idx = 0; idx < audioEntries.length; idx++) {
        if (ctrl.signal.aborted) {
          onAppendQueryLog('[Reparatur] Dateiladen durch Benutzer abgebrochen.');
          return;
        }
        const entry = audioEntries[idx];
        const relPath = (entry.relativePath || entry.file.name)
          .replace(/\\/g, '/')
          .replace(/^\/+/, '');
        const key = `${relPath}::${entry.file.size}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        const extMatch = entry.file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
        newItems.push({
          id: `rep-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`,
          file: entry.file,
          relativePath: relPath,
          relDir: getRelDirFromRelativePath(relPath),
          sourceExt: extMatch ? extMatch[1].toUpperCase() : 'AUDIO',
          sizeBytes: entry.file.size,
          selected: false,
          health: 'pending',
          findings: [],
          statusMessage: 'Geladen · Wartet auf Diagnose...',
          progress: 0,
        });
        if (newItems.length > 0 && newItems.length % 250 === 0) {
          reportLoadProgress(newItems.length);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }

      if (newItems.length === 0) {
        onAppendQueryLog('[Reparatur] Keine unterstützten Audiodateien gefunden.');
        return;
      }

      reportLoadProgress(newItems.length, true);
      setActiveFilter('all');
      setHighlightedIds([]);
      setAnchorHighlightId(null);
      if (tableScrollRef.current) {
        tableScrollRef.current.scrollTop = 0;
      }
      setTableScrollTop(0);
      itemsRef.current = newItems;
      setItems(newItems);
      setSelectedItemId(newItems[0].id);

      // Ladevorgang vollständig abschließen & vollständigen Browser-Paint der gesamten Datei-/Ordnerliste abwarten
      setIsLoadingFiles(false);
      await waitForFullListPaint();
      if (ctrl.signal.aborted) {
        onAppendQueryLog('[Reparatur] Vorgang durch Benutzer abgebrochen.');
        return;
      }

      // PHASE 2: Analyse strikt erst nach vollständigem Laden & Rendern starten (mit Max-Threads-Limit)
      const maxThreads = normalizeMaxThreads(settings.maxThreads);
      const workerCount = Math.max(1, Math.min(maxThreads, newItems.length));
      const ffThreads = Math.max(1, Math.floor(maxThreads / workerCount));
      onAppendQueryLog(
        `[Reparatur] Alle ${newItems.length} Audiodatei(en) über „${sourceKindLabel}“ vollständig geladen · Starte Diagnose (${workerCount} Worker · max. ${maxThreads} Threads)...`
      );
      await runBoundedRepairPool(
        newItems,
        workerCount,
        (item) => analyzeSingleItem(item, deepScan, ctrl.signal, ffThreads),
        ctrl.signal
      );
      const latestItems = flushPendingPatches();
      if (ctrl.signal.aborted) {
        onAppendQueryLog('[Reparatur] Diagnose durch Benutzer abgebrochen.');
      } else {
        const hasDefectiveFiles = latestItems.some((it) => !isTrackCompletelyClean(it));
        const nextFilter: RepairFilterKind = hasDefectiveFiles ? 'hide_clean_folders' : 'all';
        setActiveFilter(nextFilter);
        setHighlightedIds([]);
        setAnchorHighlightId(null);
        setSelectedItemId(null);
        if (tableScrollRef.current) {
          tableScrollRef.current.scrollTop = 0;
        }
        setTableScrollTop(0);
        onAppendQueryLog(
          hasDefectiveFiles
            ? `[Reparatur] Diagnose von ${newItems.length} Datei(en) abgeschlossen (Filter automatisch auf „Fehlerfreie Ordner ausblenden“ gesetzt).`
            : `[Reparatur] Diagnose von ${newItems.length} Datei(en) abgeschlossen (alle Dateien fehlerfrei — Filter bleibt auf „Alle Dateien“).`
        );
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        onAppendQueryLog('[Reparatur] Vorgang durch Benutzer abgebrochen.');
      } else {
        const msg = err instanceof Error ? err.message : 'Laden/Analyse fehlgeschlagen';
        onAppendQueryLog(`[Reparatur] Fehler: ${msg}`);
      }
    } finally {
      flushPendingPatches();
      abortControllerRef.current = null;
      operationLockRef.current = false;
      setIsLoadingFiles(false);
      setLoadingFileCount(0);
      setLoadingSourceLabel('');
      setIsBusy(false);
    }
  };

  const ingestEntries = async (
    rawEntries: Array<{ file: File; relativePath: string }>,
    sourceKindLabel: string
  ) => {
    await runImportAndAnalyze(sourceKindLabel, async () => rawEntries);
  };

  const handleFilterChange = (nextFilter: RepairFilterKind) => {
    setActiveFilter(nextFilter);
    setHighlightedIds([]);
    setAnchorHighlightId(null);
    if (tableScrollRef.current) {
      tableScrollRef.current.scrollTop = 0;
    }
    setTableScrollTop(0);
    setItems((prev) => prev.map((it) => (it.selected ? { ...it, selected: false } : it)));
  };

  const handleRowMouseClick = (e: React.MouseEvent<HTMLTableRowElement>, it: RepairItem) => {
    const flatIds = flatVisibleItems.map((x) => x.id);
    const clickedIdx = flatIds.indexOf(it.id);
    if (e.shiftKey) {
      const baseAnchor =
        anchorHighlightId && flatIds.includes(anchorHighlightId)
          ? anchorHighlightId
          : selectedItemId && flatIds.includes(selectedItemId)
          ? selectedItemId
          : it.id;
      const anchorIdx = flatIds.indexOf(baseAnchor);
      if (anchorIdx >= 0 && clickedIdx >= 0) {
        const start = Math.min(anchorIdx, clickedIdx);
        const end = Math.max(anchorIdx, clickedIdx);
        const rangeIds = flatIds.slice(start, end + 1);
        if (e.ctrlKey || e.metaKey) {
          setHighlightedIds((prev) => Array.from(new Set([...prev, ...rangeIds])));
        } else {
          setHighlightedIds(rangeIds);
        }
      } else {
        setHighlightedIds([it.id]);
        setAnchorHighlightId(it.id);
      }
      setSelectedItemId(it.id);
    } else if (e.ctrlKey || e.metaKey) {
      setHighlightedIds((prev) =>
        prev.includes(it.id) ? prev.filter((id) => id !== it.id) : [...prev, it.id]
      );
      setAnchorHighlightId(it.id);
      setSelectedItemId(it.id);
    } else {
      setHighlightedIds([it.id]);
      setAnchorHighlightId(it.id);
      setSelectedItemId(it.id);
    }
  };

  const handleActivateHighlightedCheckboxes = () => {
    if (isBusy || highlightedVisibleItems.length === 0) return;
    const targetSet = new Set(highlightedVisibleItems.map((it) => it.id));
    setItems((prev) => prev.map((it) => (targetSet.has(it.id) ? { ...it, selected: true } : it)));
  };

  const handleToggleSingleFolderCheckboxes = (dirKey: string, nextSelected: boolean) => {
    if (isBusy || isLoadingFiles) return;
    const targetSet = new Set(
      flatVisibleItems.filter((it) => (it.relDir || '') === dirKey).map((it) => it.id)
    );
    if (targetSet.size === 0) return;
    setItems((prev) =>
      prev.map((it) => (targetSet.has(it.id) ? { ...it, selected: nextSelected } : it))
    );
  };

  const handleOpenSingleFilePicker = () => {
    if (operationLockRef.current || isBusy || isLoadingFiles) return;
    singleFileInputRef.current?.click();
  };

  const handleOpenRecursiveFolderPicker = async () => {
    if (operationLockRef.current || isBusy || isLoadingFiles) return;
    let usedFallback = false;
    await runImportAndAnalyze('Rekursiver Ordner-Scan', async ({ signal, onProgress }) => {
      const picked = await pickDirectoryWithPersistence({
        signal,
        onProgress,
        acceptFileName: isPotentialRepairAudioFileName,
      });
      if (picked.status === 'picked') {
        onSettingsChange?.((prev) => ({
          ...prev,
          lastImportFolder: picked.folderName,
        }));
        return picked.entries;
      }
      if (picked.status === 'fallback_input') {
        usedFallback = true;
      }
      return null;
    });
    if (usedFallback) {
      recursiveFolderInputRef.current?.click();
    }
  };

  const handleRescanAll = async () => {
    if (operationLockRef.current || isBusy || isLoadingFiles || items.length === 0) return;
    const ctrl = new AbortController();
    operationLockRef.current = true;
    abortControllerRef.current = ctrl;
    setIsBusy(true);
    setItems((prev) => {
      const next = prev.map((it) => ({
        ...it,
        selected: false,
        health: 'pending' as RepairItemHealth,
        progress: 0,
        statusMessage: 'In Diagnose-Warteschlange...',
      }));
      itemsRef.current = next;
      return next;
    });
    try {
      await waitForFullListPaint();
      if (ctrl.signal.aborted) {
        onAppendQueryLog('[Reparatur] Neudiagnose abgebrochen.');
        return;
      }
      const maxThreads = normalizeMaxThreads(settings.maxThreads);
      const workerCount = Math.max(1, Math.min(maxThreads, itemsRef.current.length));
      const ffThreads = Math.max(1, Math.floor(maxThreads / workerCount));
      onAppendQueryLog(
        `[Reparatur] Vollständige Neudiagnose (${deepScan ? 'Tiefenprüfung' : 'Schnellprüfung'}) für ${itemsRef.current.length} Datei(en) gestartet (${workerCount} Worker · max. ${maxThreads} Threads)...`
      );
      await runBoundedRepairPool(
        itemsRef.current,
        workerCount,
        (item) => analyzeSingleItem(item, deepScan, ctrl.signal, ffThreads),
        ctrl.signal
      );
      const latestItems = flushPendingPatches();
      if (ctrl.signal.aborted) {
        onAppendQueryLog('[Reparatur] Neudiagnose abgebrochen.');
      } else {
        const hasDefectiveFiles = latestItems.some((it) => !isTrackCompletelyClean(it));
        const nextFilter: RepairFilterKind = hasDefectiveFiles ? 'hide_clean_folders' : 'all';
        setActiveFilter(nextFilter);
        setHighlightedIds([]);
        setAnchorHighlightId(null);
        setSelectedItemId(null);
        if (tableScrollRef.current) {
          tableScrollRef.current.scrollTop = 0;
        }
        setTableScrollTop(0);
        onAppendQueryLog(
          hasDefectiveFiles
            ? '[Reparatur] Neudiagnose abgeschlossen (Filter automatisch auf „Fehlerfreie Ordner ausblenden“ gesetzt).'
            : '[Reparatur] Neudiagnose abgeschlossen (alle Dateien fehlerfrei — Filter bleibt auf „Alle Dateien“).'
        );
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        onAppendQueryLog('[Reparatur] Neudiagnose abgebrochen.');
      }
    } finally {
      flushPendingPatches();
      abortControllerRef.current = null;
      operationLockRef.current = false;
      setIsBusy(false);
    }
  };

  useEffect(() => {
    if (!actionRef) return;
    actionRef.current = {
      openSingleFilePicker: handleOpenSingleFilePicker,
      openRecursiveFolderPicker: () => {
        void handleOpenRecursiveFolderPicker();
      },
      rescanAll: () => {
        void handleRescanAll();
      },
    };
    return () => {
      actionRef.current = null;
    };
  });

  const repairSingleItem = async (
    item: RepairItem,
    useAutoRepair: boolean,
    signal?: AbortSignal,
    ffmpegThreads = 1
  ): Promise<RepairStepLogEntry[]> => {
    queueItemPatch(item.id, {
      progress: 0.45,
      statusMessage: useAutoRepair
        ? 'Auto-Repair nach Fehlerklassen läuft...'
        : 'Repariere Header, Frames & Container...',
    });

    const qs = new URLSearchParams({
      sourceName: item.file.name,
      deepScan: String(deepScan),
      fixVbrXing: String(fixVbrXing),
      stripGarbageFrames: String(stripGarbageFrames),
      cleanTags: String(cleanTags),
      rebuildContainer: String(rebuildContainer),
      writeFlacSeektable: String(writeFlacSeektable),
      optimizeCover: String(optimizeCover),
      autoRepair: String(useAutoRepair),
      firefoxCompat: String(firefoxCompat),
      id3v2Version: String(id3v2Version),
      coverMaxDimension: String(coverMaxDimension),
      ffmpegThreads: String(Math.max(1, Math.min(16, Math.round(ffmpegThreads)))),
    });

    const res = await fetch(`/api/repair/fix?${qs.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Source-Name': encodeURIComponent(item.file.name),
      },
      body: item.file,
      signal,
    });

    if (!res.ok) {
      const errPayload = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(errPayload.error || `HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    let afterFindings = item.findings;
    let afterStructure = item.structure;
    let afterPipeline = item.pipeline;
    let beforeCount = item.findings.length;
    let afterCount = 0;
    let repairSteps: RepairStepLogEntry[] = [];
    let coverArtDownload:
      | { token: string; ext: string; mimeType: string; sizeBytes: number }
      | undefined;

    const summaryHdr = res.headers.get('X-MintRip-Repair-Summary');
    if (summaryHdr) {
      try {
        const decoded = JSON.parse(decodeBase64Utf8(summaryHdr)) as {
          beforeFindingCount?: number;
          repairSteps?: RepairStepLogEntry[];
          coverArtDownload?: {
            token: string;
            ext: string;
            mimeType: string;
            sizeBytes: number;
          };
          afterAnalysis?: {
            findings: RepairFindingItem[];
            structure: RepairStructureSummary;
            pipeline?: RepairPipelineReport;
          };
        };
        if (typeof decoded.beforeFindingCount === 'number') {
          beforeCount = decoded.beforeFindingCount;
        }
        if (Array.isArray(decoded.repairSteps)) {
          repairSteps = decoded.repairSteps;
        }
        if (decoded.coverArtDownload?.token) {
          coverArtDownload = decoded.coverArtDownload;
        }
        if (decoded.afterAnalysis) {
          afterFindings = decoded.afterAnalysis.findings || [];
          afterStructure = decoded.afterAnalysis.structure;
          afterPipeline = decoded.afterAnalysis.pipeline;
          afterCount = afterFindings.filter((f) => f.severity !== 'info').length;
        }
      } catch {
        // Header parse ignore
      }
    }

    let repairedCoverBlob: Blob | undefined;
    let repairedCoverUrl: string | undefined;
    let repairedCoverFileName: string | undefined;
    if (coverArtDownload?.token) {
      try {
        const covRes = await fetch(
          `/api/repair/cover/${encodeURIComponent(coverArtDownload.token)}`,
          { signal }
        );
        if (covRes.ok) {
          const covBlob = await covRes.blob();
          if (covBlob.size > 64) {
            repairedCoverBlob = covBlob;
            repairedCoverUrl = URL.createObjectURL(covBlob);
            const covExt =
              coverArtDownload.ext && coverArtDownload.ext.startsWith('.')
                ? coverArtDownload.ext
                : '.jpg';
            repairedCoverFileName = `${sanitizeRepairCoverStem(settings.coverFilename)}${covExt}`;
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
      }
    }

    queueItemPatch(item.id, {
      health: 'repaired',
      findings: afterFindings,
      structure: afterStructure,
      pipeline: afterPipeline,
      progress: 1,
      statusMessage:
        afterCount === 0
          ? `Repariert · Strukturell sauber (${formatBytesReadable(blob.size)})`
          : `Repariert (${afterCount} Rest-Hinweis)`,
      repairedBlob: blob,
      repairedUrl: url,
      repairedFileName: item.file.name,
      repairedCoverBlob,
      repairedCoverUrl,
      repairedCoverFileName,
      beforeFindingCount: beforeCount,
      afterFindingCount: afterCount,
    });

    return repairSteps;
  };

  const handleRepairTargets = async (targets: RepairItem[], useAutoRepair = false) => {
    if (operationLockRef.current || isBusy || isLoadingFiles || targets.length === 0) return;
    const ctrl = new AbortController();
    operationLockRef.current = true;
    abortControllerRef.current = ctrl;
    setIsBusy(true);
    onAppendQueryLog(
      useAutoRepair
        ? `[Auto-Repair] Starte fehlerklassenspezifische Reparatur für ${targets.length} Datei(en) (Seektable=${
            writeFlacSeektable ? 'Ja' : 'Nein'
          })...`
        : `[Reparatur] Starte manuelle Pipeline für ${targets.length} Datei(en) (Xing=${
            fixVbrXing ? 'Ja' : 'Nein'
          }, Frames=${stripGarbageFrames ? 'Ja' : 'Nein'}, Tags=${
            cleanTags ? 'Ja' : 'Nein'
          }, Container=${rebuildContainer ? 'Ja' : 'Nein'}, Seektable=${
            writeFlacSeektable ? 'Ja' : 'Nein'
          }, CoverOpt=${optimizeCover ? 'Ja' : 'Nein'})...`
    );

    let okFixed = 0;
    const maxThreads = normalizeMaxThreads(settings.maxThreads);
    const workerCount = Math.max(1, Math.min(maxThreads, targets.length));
    const ffThreads = Math.max(1, Math.floor(maxThreads / workerCount));
    try {
      await runBoundedRepairPool(
        targets,
        workerCount,
        async (item) => {
          if (ctrl.signal.aborted) return;
          try {
            const steps = await repairSingleItem(item, useAutoRepair, ctrl.signal, ffThreads);
            okFixed++;
            for (const st of steps) {
              const statusTag =
                st.status === 'ok'
                  ? 'OK'
                  : st.status === 'skipped'
                  ? 'ÜBERSPRUNGEN'
                  : 'HINWEIS';
              onAppendQueryLog(
                `[Reparatur · ${item.relativePath}] [${statusTag}] ${st.step}: ${st.detail}`
              );
            }
            onAppendQueryLog(`[Reparatur] „${item.relativePath}“ erfolgreich repariert.`);
          } catch (err) {
            if ((err as Error).name === 'AbortError') throw err;
            const msg = err instanceof Error ? err.message : 'Reparatur fehlgeschlagen';
            queueItemPatch(item.id, {
              health: 'error',
              progress: 0,
              statusMessage: `Fehler: ${msg}`,
            });
            onAppendQueryLog(`[Reparatur] Fehler bei „${item.relativePath}“: ${msg}`);
          }
        },
        ctrl.signal
      );
      flushPendingPatches();
      if (!ctrl.signal.aborted) {
        setActiveFilter('all');
        setHighlightedIds([]);
        setAnchorHighlightId(null);
        if (tableScrollRef.current) {
          tableScrollRef.current.scrollTop = 0;
        }
        setTableScrollTop(0);
        setItems((prev) => prev.map((it) => (it.selected ? { ...it, selected: false } : it)));
        onAppendQueryLog(
          `[Reparatur] Reparaturdurchlauf abgeschlossen (${okFixed}/${targets.length} repariert · Filter automatisch auf „Alle Dateien“ gesetzt).`
        );
      } else {
        onAppendQueryLog(
          `[Reparatur] Reparaturdurchlauf abgebrochen (${okFixed}/${targets.length} repariert).`
        );
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        onAppendQueryLog('[Reparatur] Vorgang durch Benutzer abgebrochen.');
      }
    } finally {
      flushPendingPatches();
      abortControllerRef.current = null;
      operationLockRef.current = false;
      setIsBusy(false);
    }
  };

  const handleCancelBusy = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    flushPendingPatches();
    operationLockRef.current = false;
    setIsLoadingFiles(false);
    setLoadingFileCount(0);
    setLoadingSourceLabel('');
    setIsBusy(false);
  };

  const handleDownloadAllZip = async () => {
    const done = items.filter((it) => it.repairedBlob);
    if (done.length === 0 || isBuildingZip) return;
    setIsBuildingZip(true);
    try {
      const zip = new JSZip();
      const writtenCoverPaths = new Set<string>();
      for (const it of done) {
        if (it.repairedBlob) {
          const audioRelPath = it.relativePath || it.file.name;
          zip.file(audioRelPath, it.repairedBlob);
          if (it.repairedCoverBlob && it.repairedCoverFileName) {
            const slashIdx = audioRelPath.lastIndexOf('/');
            const dirPrefix = slashIdx >= 0 ? audioRelPath.slice(0, slashIdx + 1) : '';
            const coverRelPath = `${dirPrefix}${it.repairedCoverFileName}`;
            if (!writtenCoverPaths.has(coverRelPath)) {
              writtenCoverPaths.add(coverRelPath);
              zip.file(coverRelPath, it.repairedCoverBlob);
            }
          }
        }
      }
      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mintrip-repariert-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      onAppendQueryLog(
        `[Reparatur] ZIP-Archiv mit ${done.length} reparierten Audiodateien${
          writtenCoverPaths.size > 0 ? ` und ${writtenCoverPaths.size} Cover-Bilddatei(en)` : ''
        } heruntergeladen.`
      );
    } finally {
      setIsBuildingZip(false);
    }
  };

  const handleDownloadRepairScript = () => {
    const outDir = (
      settings.outputDirRepair || DEFAULT_MODULE_OUTPUT_DIRS.outputDirRepair
    ).replace(/\/+$/, '');
    const coverStem = sanitizeRepairCoverStem(settings.coverFilename);
    const lines: string[] = [
      '#!/usr/bin/env bash',
      '# MintRip Studio — Modul 5: Audio-Diagnose & Reparatur (Linux Mint)',
      'set -euo pipefail',
      '',
      `OUT_DIR="${outDir.replace(/^~/, '${HOME}')}"`,
      'mkdir -p "$OUT_DIR"',
      '',
      'repair_file() {',
      '  local src="$1"',
      '  local rel="$2"',
      '  local dst="$OUT_DIR/$rel"',
      '  mkdir -p "$(dirname "$dst")"',
      '  local ext="${src##*.}"',
      '  ext="${ext,,}"',
      '  local sr',
      '  sr=$(ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of csv=p=0 "$src" | head -n1)',
      '  sr="${sr:-44100}"',
      '  if [ "$ext" = "flac" ]; then',
      '    local tmp_wav; tmp_wav=$(mktemp --suffix=.wav)',
      '    local bps; bps=$(ffprobe -v error -select_streams a:0 -show_entries stream=bits_per_raw_sample -of csv=p=0 "$src" | head -n1)',
      '    bps="${bps:-16}"',
      '    local pcm_fmt="pcm_s16le"; if [ "$bps" -gt 16 ] 2>/dev/null; then pcm_fmt="pcm_s24le"; fi',
      ...(firefoxCompat
        ? [
            '    local ch; ch=$(ffprobe -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$src" | head -n1)',
            '    ch="${ch:-2}"',
            '    local ff_args=()',
            '    if [ "$ch" -gt 2 ] 2>/dev/null; then ff_args+=(-ac 2); fi',
            '    if [ "$sr" -gt 192000 ] 2>/dev/null; then ff_args+=(-ar 192000); fi',
            '    ffmpeg -y -hide_banner -loglevel error -err_detect ignore_err -i "$src" -map 0:a:0 -vn -map_metadata -1 "${ff_args[@]}" -c:a "$pcm_fmt" "$tmp_wav"',
          ]
        : [
            '    ffmpeg -y -hide_banner -loglevel error -err_detect ignore_err -i "$src" -map 0:a:0 -vn -map_metadata -1 -c:a "$pcm_fmt" "$tmp_wav"',
          ]),
      '    ffmpeg -y -hide_banner -loglevel error -i "$tmp_wav" -i "$src" -map 0:a:0 -map 1:v? -c:v copy -map_metadata 1 -map_metadata 1:s:a:0 -c:a flac -compression_level 6 "$dst"',
      '    rm -f "$tmp_wav"',
      '  elif [ "$ext" = "mp3" ]; then',
      `    ffmpeg -y -hide_banner -loglevel error -err_detect ignore_err -i "$src" -map 0:a:0 -map 0:v? -c:v copy -c:a copy -write_xing ${fixVbrXing ? '1' : '0'} -id3v2_version ${id3v2Version} -write_id3v1 1 "$dst"`,
      '  elif [ "$ext" = "m4a" ]; then',
      '    ffmpeg -y -hide_banner -loglevel error -err_detect ignore_err -i "$src" -map 0:a:0 -map 0:v? -c:v copy -c:a copy -map_metadata 0 -movflags +faststart "$dst"',
      '  elif [ "$ext" = "wav" ]; then',
      '    ffmpeg -y -hide_banner -loglevel error -err_detect ignore_err -i "$src" -map 0:a:0 -vn -c:a copy -map_metadata 0 -rf64 auto "$dst"',
      '  else',
      '    ffmpeg -y -hide_banner -loglevel error -err_detect ignore_err -i "$src" -map 0:a:0 -vn -c:a copy -map_metadata 0 "$dst"',
      '  fi',
      `  if ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$dst" | grep -q .; then`,
      `    ffmpeg -y -hide_banner -loglevel error -i "$dst" -map 0:v:0 -frames:v 1 -q:v 2 "$(dirname "$dst")/${coverStem}.jpg" 2>/dev/null || true`,
      '  fi',
      '}',
      '',
      ...items.map((it) => `repair_file ${JSON.stringify(it.relativePath)} ${JSON.stringify(it.relativePath)}`),
      'echo "Fertig: Reparierte Dateien in $OUT_DIR"',
    ];
    triggerTextDownload('mintrip_repair.sh', lines.join('\n'), 'text/x-shellscript');
    onAppendQueryLog('[Reparatur] Reparatur-Bash-Skript (mintrip_repair.sh) exportiert.');
  };

  const handleClearAll = () => {
    if (operationLockRef.current || isBusy || isLoadingFiles) return;
    stopAudioPreview(false);
    if (patchFlushTimerRef.current !== null) {
      window.clearTimeout(patchFlushTimerRef.current);
      patchFlushTimerRef.current = null;
    }
    pendingPatchesRef.current.clear();
    for (const it of items) {
      if (it.repairedUrl) URL.revokeObjectURL(it.repairedUrl);
      if (it.repairedCoverUrl) URL.revokeObjectURL(it.repairedCoverUrl);
    }
    setItems([]);
    itemsRef.current = [];
    setSelectedItemId(null);
    setHighlightedIds([]);
    setAnchorHighlightId(null);
    setTableScrollTop(0);
    onAppendQueryLog('[Reparatur] Diagnoseliste vollständig geleert.');
  };

  const healthBadge = (health: RepairItemHealth) => {
    switch (health) {
      case 'ok':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270] border border-[#5BA632]/30">
            <SystemIcon name="status_ok" className="w-3 h-3" />
            OK
          </span>
        );
      case 'repaired':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-[#5BA632] text-white">
            <SystemIcon name="status_ok" className="w-3 h-3" />
            Repariert
          </span>
        );
      case 'warning':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/35">
            <SystemIcon name="status_warn" className="w-3 h-3" />
            Warnung
          </span>
        );
      case 'critical':
      case 'error':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/35">
            <SystemIcon name="status_error" className="w-3 h-3" />
            Defekt
          </span>
        );
      case 'scanning':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270]">
            <SystemIcon name="refresh_disc" className="w-3 h-3 animate-spin" />
            Prüfe...
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-[#F4F5F6] dark:bg-[#1C1F23] text-[#57606A] dark:text-[#8B949E]">
            Wartet
          </span>
        );
    }
  };

  return (
    <div
      className="space-y-4"
      onDragEnter={(e) => {
        if (operationLockRef.current || isBusy || isLoadingFiles) return;
        e.preventDefault();
        rootDragDepthRef.current += 1;
        setIsDragActive(true);
      }}
      onDragOver={(e) => {
        if (operationLockRef.current || isBusy || isLoadingFiles) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setIsDragActive(true);
      }}
      onDragLeave={() => {
        rootDragDepthRef.current = Math.max(0, rootDragDepthRef.current - 1);
        if (rootDragDepthRef.current === 0) {
          setIsDragActive(false);
        }
      }}
      onDrop={async (e) => {
        e.preventDefault();
        rootDragDepthRef.current = 0;
        tableDragDepthRef.current = 0;
        setIsDragActive(false);
        setIsTableDragActive(false);
        if (operationLockRef.current || isBusy || isLoadingFiles) {
          onAppendQueryLog(
            '[Reparatur] Drag & Drop ignoriert: Ladevorgang oder Diagnose läuft bereits.'
          );
          return;
        }
        const dt = e.dataTransfer;
        await runImportAndAnalyze('Drag & Drop', async ({ signal, onProgress }) => {
          const dropped = await collectFilesFromDataTransfer(dt, { signal, onProgress });
          return dropped.length > 0 ? dropped : [];
        });
      }}
    >
      <ModulePageHeaderBar
        moduleNumber="05. Modul"
        title="Musik reparieren"
        subtitle="Struktur-, Header- & Firefox-FLAC-Diagnose (MP3 Xing/VBR, Frame-Sync, ID3v2, STREAMINFO/Ogg-FLAC/MD5) & verlustfreie Reparatur"
        icon="module_repair"
      />

      {/* Versteckte Datei- & Ordner-Inputs bleiben unabhängig vom Klappzustand gemountet */}
      <input
        ref={singleFileInputRef}
        type="file"
        multiple
        accept=".mp3,.mp2,.flac,.wav,.aiff,.aif,.aifc,.ogg,.opus,.m4a,audio/*"
        className="hidden"
        onChange={(e) => {
          if (operationLockRef.current || isBusy || isLoadingFiles) {
            e.target.value = '';
            return;
          }
          if (e.target.files?.length) {
            const picked = Array.from(e.target.files).map((file) => ({
              file,
              relativePath: file.name,
            }));
            e.target.value = '';
            void ingestEntries(picked, 'Einzeldatei-Auswahl');
          }
        }}
      />

      <input
        ref={recursiveFolderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (operationLockRef.current || isBusy || isLoadingFiles) {
            e.target.value = '';
            return;
          }
          if (e.target.files?.length) {
            const picked = Array.from(e.target.files).map((file) => ({
              file,
              relativePath:
                (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
            }));
            e.target.value = '';
            const topFolder = extractTopFolderNameFromEntries(picked);
            if (topFolder) {
              onSettingsChange?.((prev) => ({
                ...prev,
                lastImportFolder: topFolder,
              }));
            }
            void ingestEntries(picked, 'Rekursiver Ordner-Scan');
          }
        }}
      />

      {isLoadingFiles && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-[#5BA632]/40 bg-[#5BA632]/10 text-xs text-[#2E6B14] dark:text-[#9BE270]">
          <span className="inline-flex items-center gap-2 font-medium">
            <SystemIcon name="refresh_disc" className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span>
              Lade Dateien{loadingSourceLabel ? ` (${loadingSourceLabel})` : ''}…{' '}
              <strong>{loadingFileCount}</strong> gefunden · Analyse startet erst nach vollständigem Laden
            </span>
          </span>
        </div>
      )}

      {/* Zusammenklappbares Display: Bestand einlesen & Reparatur-Transformationen (Default: eingeklappt) */}
      <section
        aria-label="Bestand einlesen und Reparatur-Transformationen"
        className={`bg-white dark:bg-[#25292E] border rounded-lg overflow-hidden transition-colors ${
          isDragActive
            ? 'border-[#5BA632] bg-[#5BA632]/5'
            : 'border-[#E1E4E8] dark:border-[#343A40]'
        }`}
      >
        <button
          type="button"
          onClick={() => setIsRepairSetupOpen((prev) => !prev)}
          aria-expanded={isRepairSetupOpen}
          className="w-full px-4 py-2.5 flex items-center justify-between gap-3 text-left bg-[#F8F9FA] dark:bg-[#1C1F23]/60 hover:bg-[#F1F3F5] dark:hover:bg-[#2D333B]/70 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2 min-w-0">
            <SystemIcon
              name="module_repair"
              className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0"
            />
            <span className="text-xs font-bold uppercase tracking-wide text-[#1F2328] dark:text-[#EAEEF2] truncate">
              Bestand einlesen &amp; Reparatur-Transformationen
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden sm:inline text-[11px] text-[#57606A] dark:text-[#8B949E]">
              {deepScan ? 'Deep-Check' : 'Fast-Check'} · ID3v2.{id3v2Version}
              {writeFlacSeektable ? ' · Seektable' : ''}
              {optimizeCover ? ' · Cover' : ''}
              {firefoxCompat ? ' · Firefox-FLAC' : ''}
            </span>
            <span
              aria-hidden="true"
              className="text-sm font-bold leading-none text-[#57606A] dark:text-[#8B949E] w-4 text-center"
            >
              {isRepairSetupOpen ? '−' : '+'}
            </span>
          </div>
        </button>

        {isRepairSetupOpen && (
          <div className="p-4 border-t border-[#E1E4E8] dark:border-[#343A40] grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
            <section
              aria-label="Dateien und Ordner für Diagnose laden"
              className={`lg:col-span-5 bg-[#FAFBFD] dark:bg-[#1F2328] border rounded-lg p-4 flex flex-col justify-between gap-3 transition-colors ${
                isDragActive
                  ? 'border-[#5BA632] bg-[#5BA632]/5'
                  : 'border-[#E1E4E8] dark:border-[#343A40]'
              }`}
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <SystemIcon name="open_file" className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F]" />
                  <h2 className="text-xs font-bold uppercase tracking-wide text-[#57606A] dark:text-[#8B949E]">
                    Bestand einlesen &amp; analysieren
                  </h2>
                </div>
                <p className="text-xs text-[#57606A] dark:text-[#8B949E]">
                  <strong>Stufe 1 (Fast-Check):</strong> Magic-Bytes vs. Endung, ID3-Präfix vor FLAC, M4A-moov, MP3-Xing,
                  FLAC-Subset &amp; Cover. <strong>Stufe 2 (Deep-Check):</strong> Null-Decode für Frame-CRC, Truncation &amp; Seek-Tables.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2 px-2 py-1 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-white dark:bg-[#1C1F23]/60">
                  <span className="text-[#57606A] dark:text-[#8B949E] shrink-0">Letzter Import-Ordner:</span>
                  <span
                    className="font-mono text-[#1F2328] dark:text-[#EAEEF2] truncate"
                    title={settings.lastImportFolder || '~/Musik'}
                  >
                    {settings.lastImportFolder || '~/Musik'}
                  </span>
                </div>
              </div>

              <div className="text-[11px] text-center text-[#57606A] dark:text-[#8B949E] border border-dashed border-[#D0D7DE] dark:border-[#444C56] rounded px-2.5 py-2">
                Import über „Dateien oder Ordner importieren“ oben in der Toolbar oder per Drag &amp; Drop direkt in das Fenster
              </div>

              <label className="inline-flex items-center gap-2 text-xs text-[#1F2328] dark:text-[#EAEEF2] cursor-pointer select-none pt-1 border-t border-[#E1E4E8] dark:border-[#343A40]">
                <input
                  type="checkbox"
                  checked={deepScan}
                  disabled={isBusy}
                  onChange={(e) => setDeepScan(e.target.checked)}
                  className="accent-[#5BA632] rounded"
                />
                <span>Stufe 2: Deep-Check (Null-Decode für Frame-CRC, abgeschnittene Streams, MD5 &amp; Pegel)</span>
              </label>
            </section>

            {/* Rechte Karte: Reparatur-Transformations-Pipeline */}
            <section
              aria-label="Reparatur-Transformationen"
              className="lg:col-span-7 bg-[#FAFBFD] dark:bg-[#1F2328] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg p-4 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <SystemIcon
                    name="module_repair"
                    className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F]"
                  />
                  <h2 className="text-xs font-bold uppercase tracking-wide text-[#57606A] dark:text-[#8B949E]">
                    Reparatur-Transformationen (verlustfreier Container- &amp; Header-Neuaufbau)
                  </h2>
                </div>
                <label className="inline-flex items-center gap-1.5 text-[11px] text-[#57606A] dark:text-[#8B949E]">
                  <span>ID3-Standard:</span>
                  <select
                    value={id3v2Version}
                    disabled={isBusy || !cleanTags}
                    onChange={(e) => setId3v2Version(Number(e.target.value) as 3 | 4)}
                    className="px-2 py-0.5 text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                  >
                    <option value={4}>ID3v2.4 (UTF-8)</option>
                    <option value={3}>ID3v2.3</option>
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs text-[#1F2328] dark:text-[#EAEEF2]">
                <label className="inline-flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={fixVbrXing}
                    disabled={isBusy}
                    onChange={(e) => setFixVbrXing(e.target.checked)}
                    className="accent-[#5BA632] rounded mt-0.5"
                  />
                  <span>
                    <strong className="font-semibold">VBR / Xing / Info-Header neu aufbauen</strong>
                    <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      Korrigiert falsche MP3-Laufzeiten &amp; Suchtabellen ohne Re-Encoding
                    </span>
                  </span>
                </label>

                <label className="inline-flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={stripGarbageFrames}
                    disabled={isBusy}
                    onChange={(e) => setStripGarbageFrames(e.target.checked)}
                    className="accent-[#5BA632] rounded mt-0.5"
                  />
                  <span>
                    <strong className="font-semibold">Defekte Sync-Frames &amp; Müll-Bytes entfernen</strong>
                    <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      Bereinigt fehlerhaftes Padding vor/nach dem Audiostrom &amp; Sync-Lücken
                    </span>
                  </span>
                </label>

                <label className="inline-flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={cleanTags}
                    disabled={isBusy}
                    onChange={(e) => setCleanTags(e.target.checked)}
                    className="accent-[#5BA632] rounded mt-0.5"
                  />
                  <span>
                    <strong className="font-semibold">Doppelte ID3v2-Header &amp; Tags bereinigen</strong>
                    <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      Entfernt gestapelte ID3v2-Blöcke und erhält Cover &amp; Metadaten sauber
                    </span>
                  </span>
                </label>

                <label className="inline-flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rebuildContainer}
                    disabled={isBusy}
                    onChange={(e) => setRebuildContainer(e.target.checked)}
                    className="accent-[#5BA632] rounded mt-0.5"
                  />
                  <span>
                    <strong className="font-semibold">FLAC-MD5, Seektable &amp; RIFF/Container reparieren</strong>
                    <span className="block text-[11px] text-[#57606A] dark:text-[#8B949E]">
                      Erneuert FLAC über 2-Schritt-WAV und korrigiert WAV/AIFF/M4A-Größenheader
                    </span>
                  </span>
                </label>
              </div>

              <div className="pt-2 border-t border-[#E1E4E8] dark:border-[#343A40] flex flex-col gap-1.5 text-xs">
                <label className="inline-flex items-center gap-2 cursor-pointer select-none text-[#1F2328] dark:text-[#EAEEF2]">
                  <input
                    type="checkbox"
                    checked={writeFlacSeektable}
                    disabled={isBusy}
                    onChange={(e) => setWriteFlacSeektable(e.target.checked)}
                    className="accent-[#5BA632] rounded"
                  />
                  <span>
                    <strong className="font-semibold">FLAC-Seektable erzeugen (10s-Sprungmarken)</strong>
                    <span className="text-[#57606A] dark:text-[#8B949E]">
                      {' '}
                      — Schreibt echte Seekpoints in den FLAC-Header für schnelles Spulen (Standard: ein)
                    </span>
                  </span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer select-none text-[#1F2328] dark:text-[#EAEEF2]">
                  <input
                    type="checkbox"
                    checked={optimizeCover}
                    disabled={isBusy}
                    onChange={(e) => setOptimizeCover(e.target.checked)}
                    className="accent-[#5BA632] rounded"
                  />
                  <span>
                    Cover-Optimierung (&gt; {coverMaxDimension}×{coverMaxDimension} px skalieren · &gt; 1 MB mit identischen Pixel-Dimensionen auf ≤ 1 MB komprimieren)
                  </span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer select-none text-[#1F2328] dark:text-[#EAEEF2]">
                  <input
                    type="checkbox"
                    checked={firefoxCompat}
                    disabled={isBusy}
                    onChange={(e) => setFirefoxCompat(e.target.checked)}
                    className="accent-[#5BA632] rounded"
                  />
                  <span>
                    FLAC-Firefox-Konvertierung aktivieren (wandelt &gt; 2 Kanäle → Stereo &amp; &gt; 192 kHz / exotische Raten auf Firefox-Standard)
                  </span>
                </label>
              </div>
            </section>
          </div>
        )}
      </section>

      {/* Filter- & Aktionsleiste */}
      <section className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2] cursor-pointer select-none pr-1">
              <input
                ref={selectAllCheckboxRef}
                type="checkbox"
                checked={allSelected}
                disabled={isBusy}
                onChange={() => {
                  const next = !allSelected;
                  setItems((prev) =>
                    prev.map((it) => (visibleIdSet.has(it.id) ? { ...it, selected: next } : it))
                  );
                }}
                aria-label="Alle sichtbaren Dateien auswählen"
                className="accent-[#5BA632] rounded cursor-pointer"
              />
              <span>Alle</span>
            </label>

            <button
              type="button"
              disabled={isBusy || highlightedVisibleItems.length === 0}
              onClick={handleActivateHighlightedCheckboxes}
              title="Aktiviert die Checkboxen aller per Klick / Strg+Klick / Shift+Klick markierten Dateien für die Weiterverarbeitung"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
            >
              <SystemIcon name="status_ok" className="w-3 h-3" />
              <span>
                {highlightedVisibleItems.length > 0
                  ? `Markierte Dateien aktivieren (${highlightedVisibleItems.length})`
                  : 'Markierte Dateien aktivieren'}
              </span>
            </button>

            <button
              type="button"
              disabled={highlightedVisibleItems.length === 0}
              onClick={() => {
                setHighlightedIds([]);
                setAnchorHighlightId(null);
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
            >
              <span>Markierung aufheben</span>
            </button>

            <div className="flex items-center gap-1.5 pl-2 border-l border-[#E1E4E8] dark:border-[#343A40]">
              <select
                aria-label="Filter"
                value={activeFilter}
                onChange={(e) => handleFilterChange(e.target.value as RepairFilterKind)}
                title="Ansicht nach Prüfstatus oder fehlerfreien Ordnern filtern"
                className="px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] focus:outline-none focus:border-[#5BA632] cursor-pointer"
              >
                <option value="all">{`Filter: Alle Dateien (${items.length})`}</option>
                <option value="issues">{`Filter: Mit Problemen (${warningCount + criticalCount})`}</option>
                <option value="hide_clean_folders">
                  {totalFolderCount > 0
                    ? `Filter: Fehlerfreie Ordner ausblenden (${nonCleanFolderCount}/${totalFolderCount} Ordner)`
                    : 'Filter: Fehlerfreie Ordner ausblenden'}
                </option>
                <option value="critical">{`Filter: Nur Kritisch (${criticalCount})`}</option>
                <option value="repaired">{`Filter: Repariert (${repairedCount})`}</option>
              </select>
            </div>
            <span className="ml-1 text-xs text-[#57606A] dark:text-[#8B949E] tabular-nums">
              OK: <strong className="text-[#2E6B14] dark:text-[#9BE270]">{okCount}</strong> · Ausgewählt:{' '}
              <strong className="text-[#1F2328] dark:text-[#EAEEF2]">{selectedCount}</strong>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isBusy || selectedCount === 0}
              onClick={() => void handleRepairTargets(items.filter((it) => it.selected), true)}
              title="Wendet exakt die pro Datei erkannten Reparaturklassen an (Header-Strip, Faststart-Remux, VBR-Rebuild, Cover-Optimierung, Lossless Re-Encode)"
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
            >
              <SystemIcon name="module_repair" className="w-3.5 h-3.5" />
              <span>Auto-Repair (Fehlerklassen · {selectedCount})</span>
            </button>

            <button
              type="button"
              disabled={isBusy || selectedCount === 0}
              onClick={() => void handleRepairTargets(items.filter((it) => it.selected), false)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-[#5BA632]/50 bg-[#5BA632]/10 hover:bg-[#5BA632]/20 text-[#2E6B14] dark:text-[#9BE270] disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
            >
              <span>Manuelle Pipeline ({selectedCount})</span>
            </button>

            <button
              type="button"
              disabled={!isBusy}
              onClick={handleCancelBusy}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#DC2626] hover:bg-[#DC2626]/10 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <SystemIcon name="stop_batch" className="w-3.5 h-3.5" />
              <span>Abbrechen</span>
            </button>

            <button
              type="button"
              disabled={repairedCount === 0 || isBuildingZip}
              onClick={() => void handleDownloadAllZip()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-[#5BA632]/50 bg-[#5BA632]/10 hover:bg-[#5BA632]/20 text-[#2E6B14] dark:text-[#9BE270] disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <SystemIcon name="save_export" className="w-3.5 h-3.5" />
              <span>Reparierte als ZIP ({repairedCount})</span>
            </button>

            <button
              type="button"
              disabled={items.length === 0}
              onClick={handleDownloadRepairScript}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <SystemIcon name="save_cover" className="w-3.5 h-3.5" />
              <span>Skript (.sh)</span>
            </button>

            <button
              type="button"
              disabled={isBusy || items.length === 0}
              onClick={handleClearAll}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#57606A] dark:text-[#8B949E] hover:text-[#DC2626] hover:border-[#DC2626]/50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <SystemIcon name="remove_item" className="w-3.5 h-3.5" />
              <span>Liste leeren</span>
            </button>
          </div>
        </div>

        <div className="h-2 w-full rounded bg-[#EAECEF] dark:bg-[#1C1F23] overflow-hidden">
          <div
            className="h-full bg-[#5BA632] dark:bg-[#69B53F] transition-[width] duration-150"
            style={{ width: `${totalProgress}%` }}
          />
        </div>
      </section>

      {/* Master-Detail-Arbeitsbereich: Links Dateiliste | Splitter | Rechts Struktur- & Befund-Inspektor (initial 30%) */}
      <div
        ref={splitContainerRef}
        className="flex flex-col lg:flex-row items-stretch gap-3 lg:gap-0"
      >
        <section
          aria-label="Geprüfte Audiodateien"
          onDragEnter={(e) => {
            if (isBusy) return;
            e.preventDefault();
            tableDragDepthRef.current += 1;
            setIsTableDragActive(true);
          }}
          onDragOver={(e) => {
            if (isBusy) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setIsTableDragActive(true);
          }}
          onDragLeave={() => {
            tableDragDepthRef.current = Math.max(0, tableDragDepthRef.current - 1);
            if (tableDragDepthRef.current === 0) {
              setIsTableDragActive(false);
            }
          }}
          onDrop={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            rootDragDepthRef.current = 0;
            tableDragDepthRef.current = 0;
            setIsDragActive(false);
            setIsTableDragActive(false);
            if (operationLockRef.current || isBusy || isLoadingFiles) {
              onAppendQueryLog(
                '[Reparatur] Drag & Drop ignoriert: Ladevorgang oder Diagnose läuft bereits.'
              );
              return;
            }
            const dt = e.dataTransfer;
            await runImportAndAnalyze('Drag & Drop (Tabelle)', async ({ signal, onProgress }) => {
              const dropped = await collectFilesFromDataTransfer(dt, { signal, onProgress });
              return dropped.length > 0 ? dropped : [];
            });
          }}
          className={`w-full lg:min-w-0 lg:flex-1 bg-white dark:bg-[#25292E] border rounded-lg overflow-hidden transition-colors relative ${
            isTableDragActive || isDragActive
              ? 'border-[#5BA632] ring-2 ring-[#5BA632]/30 bg-[#5BA632]/5'
              : 'border-[#E1E4E8] dark:border-[#343A40]'
          }`}
        >
          <div className="flex flex-col">

            {items.length === 0 ? (
              <div className="p-10 text-center space-y-2 text-xs text-[#57606A] dark:text-[#8B949E]">
                <div className="mx-auto w-10 h-10 rounded-full bg-[#F4F5F6] dark:bg-[#1C1F23] flex items-center justify-center text-[#5BA632] dark:text-[#69B53F]">
                  <SystemIcon name="module_repair" className="w-5 h-5" />
                </div>
                <p className="text-sm font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                  Noch keine Audiodateien für die Diagnose geladen
                </p>
                <p>
                  Nutze oben „Dateien oder Ordner importieren“ für Einzeldateien oder ganze Ordner bzw. ziehe
                  Dateien und Ordner per Drag &amp; Drop direkt in diese Tabelle.
                </p>
              </div>
            ) : (
              <div
                ref={tableScrollRef}
                onScroll={(e) => {
                  const st = e.currentTarget.scrollTop;
                  if (scrollRafRef.current === null) {
                    scrollRafRef.current = window.requestAnimationFrame(() => {
                      scrollRafRef.current = null;
                      setTableScrollTop(st);
                    });
                  }
                }}
                style={{ overflowAnchor: 'none' }}
                className="overflow-x-auto max-h-[520px] overflow-y-auto"
              >
                <table className="w-full table-fixed text-left border-collapse select-none">
                  <thead className="sticky top-0 z-10">
                    <tr className="border-b border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[11px] font-semibold text-[#57606A] dark:text-[#8B949E] divide-x divide-[#E1E4E8] dark:divide-[#343A40]">
                      <th className="py-2 px-2.5 w-9 text-center">
                        <input
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected;
                          }}
                          type="checkbox"
                          checked={allSelected}
                          disabled={isBusy}
                          onChange={() => {
                            const next = !allSelected;
                            setItems((prev) =>
                              prev.map((it) =>
                                visibleIdSet.has(it.id) ? { ...it, selected: next } : it
                              )
                            );
                          }}
                          aria-label="Sichtbare Dateien auswählen"
                          className="accent-[#5BA632] rounded cursor-pointer"
                        />
                      </th>
                      <th
                        className="py-2 px-0.5 w-5 text-center"
                        title="Schweregrad (Grün: OK · Gelb: Hinweis · Orange: Warnung · Rot: Defekt)"
                        aria-label="Schweregrad"
                      />
                      <th className="py-2 px-2.5">Datei &amp; technischer Stream</th>
                      <th className="py-2 px-2.5 w-28 text-center">Diagnose</th>
                      <th className="py-2 px-2.5 w-56">Status &amp; Download</th>
                      <th className="py-2 px-2 w-14 text-center">Vorhören</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs">
                    {topSpacerHeight > 0 && (
                      <tr aria-hidden="true" style={{ height: `${topSpacerHeight}px` }}>
                        <td colSpan={6} className="p-0 border-0 leading-none">
                          <div style={{ height: `${topSpacerHeight}px` }} />
                        </td>
                      </tr>
                    )}
                    {visibleVirtualRows.map((vRow) => {
                      if (vRow.kind === 'spacer') {
                        return (
                          <tr
                            key={vRow.key}
                            aria-hidden="true"
                            style={{ height: `${SPACER_ROW_HEIGHT}px` }}
                            className="bg-[#F4F6F8] dark:bg-[#2B3036]/40"
                          >
                            <td
                              colSpan={6}
                              className="p-0 leading-none border-y border-[#E1E4E8] dark:border-[#343A40]"
                            >
                              <div style={{ height: `${SPACER_ROW_HEIGHT - 2}px` }} />
                            </td>
                          </tr>
                        );
                      }
                      if (vRow.kind === 'folder') {
                        return (
                          <tr
                            key={vRow.key}
                            style={{ height: `${FOLDER_ROW_HEIGHT}px` }}
                            className="bg-[#F8F9FA] dark:bg-[#1C1F23]/80 border-b border-[#E1E4E8] dark:border-[#343A40]"
                          >
                            <td className="py-1 px-2.5 text-center">
                              <input
                                type="checkbox"
                                checked={vRow.allSelected}
                                disabled={isBusy}
                                ref={(el) => {
                                  if (el) el.indeterminate = vRow.someSelected;
                                }}
                                onChange={() =>
                                  handleToggleSingleFolderCheckboxes(vRow.dir, !vRow.allSelected)
                                }
                                title={
                                  vRow.allSelected
                                    ? `Alle Dateien in „${vRow.label}“ abwählen`
                                    : `Alle ${vRow.totalCount} Dateien in „${vRow.label}“ per Checkbox aktivieren`
                                }
                                aria-label={`Alle Dateien in ${vRow.label} auswählen`}
                                className="accent-[#5BA632] rounded cursor-pointer"
                              />
                            </td>
                            <td
                              colSpan={5}
                              className="py-1 px-2.5 text-[11px] font-semibold text-[#57606A] dark:text-[#8B949E]"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="inline-flex items-center gap-1.5 min-w-0">
                                  <SystemIcon
                                    name="music_folder"
                                    className="w-3.5 h-3.5 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                                  />
                                  <span className="font-mono text-[#1F2328] dark:text-[#EAEEF2] truncate">
                                    {vRow.label}
                                  </span>
                                </span>
                                <span className="text-[10px] font-normal tabular-nums shrink-0">
                                  {vRow.selectedCount}/{vRow.totalCount}{' '}
                                  {vRow.totalCount === 1 ? 'Datei' : 'Dateien'}
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      }

                      const it = vRow.item;
                      const isActive = activeItem?.id === it.id;
                      const isHighlighted = highlightedIdSet.has(it.id);
                      const isItemPlaying = playingItemId === it.id;
                      const sev = getRepairSeverityIndicator(it);
                      return (
                        <tr
                          key={it.id}
                          style={{ height: `${FILE_ROW_HEIGHT}px` }}
                          onMouseDown={(e) => {
                            if (e.shiftKey || e.ctrlKey || e.metaKey) {
                              e.preventDefault();
                            }
                          }}
                          onClick={(e) => handleRowMouseClick(e, it)}
                          className={`cursor-pointer transition-colors border-b border-[#E1E4E8] dark:border-[#343A40] ${
                            isHighlighted
                              ? 'bg-[#5BA632]/15 dark:bg-[#5BA632]/20'
                              : isActive
                              ? 'bg-[#5BA632]/10 dark:bg-[#5BA632]/15'
                              : 'hover:bg-[#F8F9FA] dark:hover:bg-[#1C1F23]/50'
                          }`}
                        >
                          <td
                            className="py-1 px-2.5 text-center"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              checked={it.selected}
                              disabled={isBusy}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setItems((prev) =>
                                  prev.map((row) =>
                                    row.id === it.id ? { ...row, selected: checked } : row
                                  )
                                );
                              }}
                              className="accent-[#5BA632] rounded cursor-pointer"
                            />
                          </td>
                          <td
                            className="py-1 px-0.5 text-center align-middle"
                            style={{ width: '20px', maxWidth: '20px', minWidth: '16px' }}
                            title={sev.label}
                            aria-label={sev.label}
                          >
                            <span
                              className="inline-block w-2.5 h-5 rounded-sm align-middle"
                              style={{ backgroundColor: sev.color }}
                            />
                          </td>
                          <td className="py-1 px-2.5 overflow-hidden">
                            <div className="font-medium text-[#1F2328] dark:text-[#EAEEF2] truncate">
                              {it.relativePath}
                            </div>
                            <div className="text-[11px] font-mono text-[#57606A] dark:text-[#8B949E] truncate">
                              {it.sourceExt} · {formatBytesReadable(it.sizeBytes)}
                              {it.structure
                                ? ` · ${(it.structure.sampleRate / 1000).toFixed(1)} kHz · ${
                                    it.structure.isVbr
                                      ? 'VBR'
                                      : `${it.structure.bitrateKbps || '—'} kbps`
                                  } · ${formatDuration(it.structure.durationSeconds)}`
                                : ''}
                            </div>
                          </td>
                          <td className="py-1 px-2.5 text-center">{healthBadge(it.health)}</td>
                          <td className="py-1 px-2.5 overflow-hidden" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-between gap-1.5">
                              <span className="text-[11px] text-[#57606A] dark:text-[#8B949E] truncate min-w-0">
                                {it.statusMessage}
                              </span>
                              <div className="flex items-center gap-1 shrink-0">
                                {it.repairedUrl && (
                                  <a
                                    href={it.repairedUrl}
                                    download={it.repairedFileName || it.file.name}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#5BA632] hover:bg-[#4E922A] text-white text-[11px] font-semibold shrink-0"
                                  >
                                    <SystemIcon name="save_export" className="w-3 h-3" />
                                    <span>Laden</span>
                                  </a>
                                )}
                                {it.repairedCoverUrl && (
                                  <a
                                    href={it.repairedCoverUrl}
                                    download={it.repairedCoverFileName || 'cover.jpg'}
                                    title={`Eingebettetes Cover als „${it.repairedCoverFileName || 'cover.jpg'}“ im Zielordner speichern`}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#5BA632]/60 bg-white dark:bg-[#1C1F23] hover:bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270] text-[11px] font-semibold shrink-0"
                                  >
                                    <SystemIcon name="cover_image" className="w-3 h-3" />
                                    <span>Cover</span>
                                  </a>
                                )}
                              </div>
                            </div>
                          </td>
                          <td
                            className="py-1 px-2 text-center"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              aria-label={
                                isItemPlaying
                                  ? `Wiedergabe von ${it.file.name} stoppen`
                                  : `Datei ${it.file.name} abspielen`
                              }
                              onClick={() => void handleToggleAudioPreview(it)}
                              title={
                                isItemPlaying
                                  ? `Wiedergabe von „${it.relativePath}“ stoppen`
                                  : `„${it.relativePath}“ zum Reinhören abspielen`
                              }
                              className={`inline-flex items-center justify-center p-1 rounded border transition-colors cursor-pointer ${
                                isItemPlaying
                                  ? 'border-[#5BA632] bg-[#5BA632] text-white hover:border-[#DC2626] hover:bg-[#DC2626]'
                                  : 'border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/15 hover:text-[#2E6B14] dark:hover:text-[#9BE270]'
                              }`}
                            >
                              <SystemIcon
                                name={isItemPlaying ? 'media_stop' : 'media_play'}
                                className="w-3 h-3"
                              />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {bottomSpacerHeight > 0 && (
                      <tr aria-hidden="true" style={{ height: `${bottomSpacerHeight}px` }}>
                        <td colSpan={6} className="p-0 border-0 leading-none">
                          <div style={{ height: `${bottomSpacerHeight}px` }} />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* Vertikaler Splitter zum Vergrößern/Verkleinern des Diagnose-Inspektors */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Breite des Diagnose-Inspektors anpassen (Doppelklick: 30 %)"
          title="Ziehen zum Vergrößern/Verkleinern · Doppelklick setzt auf 30 % zurück"
          onMouseDown={(e) => {
            e.preventDefault();
            setIsResizingInspector(true);
          }}
          onDoubleClick={() => setInspectorWidthPct(30)}
          className="hidden lg:flex w-3 shrink-0 cursor-col-resize items-center justify-center group select-none"
        >
          <span
            className={`w-1 h-16 rounded-full transition-colors ${
              isResizingInspector
                ? 'bg-[#5BA632]'
                : 'bg-[#D0D7DE] dark:bg-[#444C56] group-hover:bg-[#5BA632]'
            }`}
          />
        </div>

        {/* Rechts: Wiedergabe-Leiste (Slider + Stopp) über dem Struktur- & Befund-Inspektor */}
        <div
          style={
            {
              ['--insp-width' as string]: `${inspectorWidthPct}%`,
              marginLeft: '10px',
            } as React.CSSProperties
          }
          className="w-full lg:w-[var(--insp-width)] ml-[10px] shrink-0 flex flex-col gap-2.5"
        >
          {(() => {
            const playingItem = playingItemId
              ? items.find((it) => it.id === playingItemId) || null
              : null;
            const effectiveDuration =
              playbackDuration > 0
                ? playbackDuration
                : playingItem?.structure?.durationSeconds || 0;
            const sliderMax = effectiveDuration > 0 ? effectiveDuration : 1;
            const sliderVal = playingItem
              ? Math.max(0, Math.min(sliderMax, playbackCurrentTime))
              : 0;
            return (
              <section
                aria-label="Audio-Wiedergabe"
                className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg px-3.5 py-2.5 space-y-2"
              >
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <SystemIcon
                      name="media_play"
                      className={`w-3.5 h-3.5 shrink-0 ${
                        playingItem
                          ? 'text-[#5BA632] dark:text-[#69B53F]'
                          : 'text-[#57606A] dark:text-[#8B949E]'
                      }`}
                    />
                    <span
                      className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate"
                      title={playingItem ? playingItem.relativePath : 'Kein Titel wird abgespielt'}
                    >
                      {playingItem ? playingItem.file.name : 'Kein Titel wird abgespielt'}
                    </span>
                    {playingItem && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270] shrink-0">
                        {playingItem.repairedBlob ? 'Repariert' : 'Original'}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-[#57606A] dark:text-[#8B949E] shrink-0">
                    {formatDuration(Math.floor(sliderVal))} /{' '}
                    {effectiveDuration > 0 ? formatDuration(Math.floor(effectiveDuration)) : '00:00'}
                  </span>
                </div>

                <div className="flex items-center gap-2.5">
                  <input
                    type="range"
                    min={0}
                    max={sliderMax}
                    step={0.1}
                    value={sliderVal}
                    disabled={!playingItem || effectiveDuration <= 0}
                    aria-label="Wiedergabeposition des aktuellen Titels"
                    onPointerDown={() => {
                      isSeekingPlaybackRef.current = true;
                    }}
                    onPointerUp={(e) => {
                      const nextSec = Number((e.target as HTMLInputElement).value);
                      isSeekingPlaybackRef.current = false;
                      handleSeekAudioPreview(nextSec);
                    }}
                    onChange={(e) => {
                      const nextSec = Number(e.target.value);
                      if (isSeekingPlaybackRef.current) {
                        setPlaybackCurrentTime(nextSec);
                      } else {
                        handleSeekAudioPreview(nextSec);
                      }
                    }}
                    className="flex-1 h-1.5 accent-[#5BA632] cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                  />
                  <button
                    type="button"
                    disabled={!playingItem}
                    onClick={() => stopAudioPreview(true)}
                    title="Aktuelle Audiowiedergabe stoppen"
                    aria-label="Wiedergabe stoppen"
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded border border-red-500/40 bg-red-600/10 hover:bg-red-600 hover:text-white text-red-700 dark:text-red-300 dark:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0"
                  >
                    <SystemIcon name="media_stop" className="w-3.5 h-3.5" />
                    <span>Stopp</span>
                  </button>
                </div>
              </section>
            );
          })()}

          <fieldset
            aria-label="Diagnose-Inspektor"
            className="w-full flex-1 bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg p-4 space-y-4 select-text"
          >
            <legend className="sr-only">Diagnose-Inspektor</legend>
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-[#E1E4E8] dark:border-[#343A40]">
            <div className="min-w-0">
              <div className="text-[11px] font-mono text-[#57606A] dark:text-[#8B949E]">
                Diagnose-Inspektor · Stream &amp; Container
              </div>
              <h3 className="text-sm font-bold text-[#1F2328] dark:text-[#EAEEF2] truncate">
                {activeItem ? activeItem.file.name : 'Keine Datei ausgewählt'}
              </h3>
            </div>
            {activeItem && (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    const lines: string[] = [
                      `Datei: ${activeItem.relativePath}`,
                      `Status: ${activeItem.statusMessage}`,
                    ];
                    if (activeItem.structure) {
                      const s = activeItem.structure;
                      lines.push(
                        `Stream: ${s.codec.toUpperCase()} · ${s.sampleRate} Hz · ${s.bitsPerSample}-Bit · ${s.channels}ch · Peak: ${s.maxVolumeDb !== null ? `${s.maxVolumeDb.toFixed(1)} dB` : '—'} · CRC: ${s.streamCrcErrors ?? 0} · Trunc: ${s.streamTruncated ? 'Ja' : 'Nein'}`
                      );
                    }
                    if (activeItem.findings.length === 0) {
                      lines.push('Befunde: Keine Fehler erkannt.');
                    } else {
                      lines.push(`Befunde (${activeItem.findings.length}):`);
                      for (const f of activeItem.findings) {
                        lines.push(`- [${f.stage === 'deep' ? 'Deep' : 'Fast'} · ${f.severity.toUpperCase()}] ${f.title}: ${f.description} -> ${f.recommendedFix}`);
                      }
                    }
                    void navigator.clipboard?.writeText(lines.join('\n')).then(() => {
                      setCopiedInspector(true);
                      setTimeout(() => setCopiedInspector(false), 1800);
                    });
                  }}
                  title="Vollständigen Diagnose-Befund in die Zwischenablage kopieren (Einzeltext ebenfalls direkt markierbar & per Strg+C / Rechtsklick kopierbar)"
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] cursor-pointer"
                >
                  <span>{copiedInspector ? 'Kopiert!' : 'Kopieren'}</span>
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleRepairTargets([activeItem], true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-45 cursor-pointer"
                >
                  <SystemIcon name="module_repair" className="w-3.5 h-3.5" />
                  <span>Auto-Repair</span>
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleRepairTargets([activeItem], false)}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] disabled:opacity-45 cursor-pointer"
                >
                  <span>Manuell</span>
                </button>
              </div>
            )}
          </div>

          {!activeItem ? (
            <p className="text-xs text-[#57606A] dark:text-[#8B949E]">
              Wähle links eine geprüfte Audiodatei aus, um den detaillierten Frame-, Header- und
              Metadaten-Befund anzuzeigen.
            </p>
          ) : (
            <>
              {/* Vorher/Nachher Hinweis nach Reparatur */}
              {typeof activeItem.beforeFindingCount === 'number' &&
                activeItem.health === 'repaired' && (
                  <div className="p-2.5 rounded border border-[#5BA632]/40 bg-[#5BA632]/10 text-xs text-[#2E6B14] dark:text-[#9BE270]">
                    Vorher/Nachher: <strong>{activeItem.beforeFindingCount}</strong> Befund(e) vor
                    Reparatur → <strong>{activeItem.afterFindingCount ?? 0}</strong> verbleibende
                    Warnung(en)/Fehler.
                  </div>
                )}

              {/* 2-Stufen Analyse-Pipeline (Fast-Check & Deep-Check) + Empfohlene Auto-Repair-Fixes */}
              {activeItem.pipeline && (
                <div className="p-2.5 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 space-y-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold ${
                        activeItem.pipeline.stage1FastCheck.passed
                          ? 'bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270]'
                          : 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
                      }`}
                    >
                      Stufe 1 Fast-Check:{' '}
                      {activeItem.pipeline.stage1FastCheck.passed
                        ? 'OK'
                        : `${activeItem.pipeline.stage1FastCheck.issueCount} Befund(e)`}{' '}
                      ({activeItem.pipeline.stage1FastCheck.durationMs} ms)
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold ${
                        !activeItem.pipeline.stage2DeepCheck.executed
                          ? 'bg-black/5 dark:bg-white/10 text-[#57606A] dark:text-[#8B949E]'
                          : !activeItem.pipeline.stage2DeepCheck.passed
                          ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                          : (activeItem.pipeline.stage2DeepCheck.failureReasons?.length || 0) > 0
                          ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
                          : 'bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270]'
                      }`}
                    >
                      Stufe 2 Deep-Check:{' '}
                      {!activeItem.pipeline.stage2DeepCheck.executed
                        ? 'Deaktiviert'
                        : activeItem.pipeline.stage2DeepCheck.passed
                        ? activeItem.pipeline.stage2DeepCheck.failureReasons?.length
                          ? `OK · Hinweis: ${activeItem.pipeline.stage2DeepCheck.failureReasons.join(', ')} (${activeItem.pipeline.stage2DeepCheck.durationMs} ms)`
                          : `OK (${activeItem.pipeline.stage2DeepCheck.durationMs} ms)`
                        : `${
                            activeItem.pipeline.stage2DeepCheck.failureReasons?.length
                              ? activeItem.pipeline.stage2DeepCheck.failureReasons.join(' · ')
                              : `CRC:${activeItem.pipeline.stage2DeepCheck.crcErrorCount} · Trunc:${
                                  activeItem.pipeline.stage2DeepCheck.truncatedDetected ? 'Ja' : 'Nein'
                                }`
                          } (${activeItem.pipeline.stage2DeepCheck.durationMs} ms)`}
                    </span>
                  </div>
                  {activeItem.pipeline.recommendedFixes.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-[#E1E4E8] dark:border-[#343A40]">
                      <span className="text-[11px] font-semibold text-[#57606A] dark:text-[#8B949E]">
                        Auto-Repair-Plan:
                      </span>
                      {activeItem.pipeline.recommendedFixes.map((act) => (
                        <span
                          key={act}
                          className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270] border border-[#5BA632]/30"
                        >
                          {FIX_ACTION_LABELS[act] || act}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Kompakte Struktur-Kennzahlen */}
              {activeItem.structure && (
                <div className="space-y-2">
                  {activeItem.structure.flacFirefoxCompatible && (
                    <div
                      className={`px-2.5 py-2 rounded border text-xs flex items-center justify-between gap-2 ${
                        activeItem.structure.flacFirefoxCompatible === 'compatible'
                          ? 'border-[#5BA632]/40 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270]'
                          : activeItem.structure.flacFirefoxCompatible === 'warning'
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300'
                          : 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
                      }`}
                    >
                      <span className="font-semibold">
                        Firefox-FLAC-Prüfung:{' '}
                        {activeItem.structure.flacFirefoxCompatible === 'compatible'
                          ? 'Kompatibel (natives fLaC, ≤ 24-Bit/192 kHz, Mono/Stereo)'
                          : activeItem.structure.flacFirefoxCompatible === 'warning'
                          ? 'Eingeschränkt (Warnungen bei Encoding/Blockgröße/MD5)'
                          : 'Inkompatibel (kritische Abweichung für Firefox)'}
                      </span>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                    <div className="p-2 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60">
                      <div className="text-[#57606A] dark:text-[#8B949E]">Audio &amp; Magic-Bytes</div>
                      <div className="text-[#1F2328] dark:text-[#EAEEF2] font-semibold truncate">
                        {(activeItem.structure.sampleRate / 1000).toFixed(1)} kHz ·{' '}
                        {activeItem.structure.bitsPerSample}-Bit ·{' '}
                        {activeItem.structure.channels}ch ·{' '}
                        {activeItem.structure.detectedMagic
                          ? activeItem.structure.magicMatchesExtension === false
                            ? `Magic:${activeItem.structure.detectedMagic.toUpperCase()}!`
                            : `Magic:${activeItem.structure.detectedMagic.toUpperCase()}`
                          : activeItem.structure.codec.toUpperCase()}
                      </div>
                    </div>

                    <div className="p-2 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60">
                      <div className="text-[#57606A] dark:text-[#8B949E]">Container, Tags &amp; Cover</div>
                      <div className="text-[#1F2328] dark:text-[#EAEEF2] font-semibold truncate">
                        {activeItem.structure.m4aMoovPosition
                          ? activeItem.structure.m4aMoovPosition === 'before_mdat'
                            ? 'M4A moov OK (Faststart)'
                            : activeItem.structure.m4aMoovPosition === 'after_mdat'
                            ? 'M4A moov NACH mdat!'
                            : 'M4A moov FEHLT!'
                          : activeItem.structure.codec === 'flac' || activeItem.structure.flacFirefoxCompatible
                          ? activeItem.structure.flacIsOgg
                            ? 'Ogg-FLAC (OggS!)'
                            : `${
                                activeItem.structure.flacStreaminfoValid
                                  ? 'Nativ fLaC · STREAMINFO'
                                  : 'fLaC · STREAMINFO-Fehler'
                              }${activeItem.structure.id3v2Count > 0 ? ' · ID3v2!' : ''}`
                          : activeItem.structure.id3v2Count > 0
                          ? `${activeItem.structure.id3v2Count}× ID3 (${activeItem.structure.id3v2Versions.join(', ')})`
                          : 'Keine ID3v2'}
                        {activeItem.structure.hasCoverArt
                          ? ` · Cover ${formatBytesReadable(activeItem.structure.coverArtBytes || 0)}`
                          : ''}
                      </div>
                    </div>

                    <div className="p-2 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60">
                      <div className="text-[#57606A] dark:text-[#8B949E]">
                        {activeItem.structure.codec === 'flac' || activeItem.structure.flacFirefoxCompatible
                          ? 'MD5 / Subset / Seektable'
                          : 'Seek / Xing / Cover-Maße'}
                      </div>
                      <div className="text-[#1F2328] dark:text-[#EAEEF2] font-semibold truncate">
                        {activeItem.structure.codec === 'flac' || activeItem.structure.flacFirefoxCompatible
                          ? `MD5:${
                              activeItem.structure.flacMd5Status === 'valid'
                                ? 'OK'
                                : activeItem.structure.flacMd5Status === 'mismatch'
                                ? 'ERR'
                                : activeItem.structure.flacMd5Status === 'missing'
                                ? 'Leer'
                                : 'Vorh.'
                            } · Sub:${activeItem.structure.flacSubsetValid === false ? 'Nein' : 'OK'} · Seek:${
                              activeItem.structure.flacHasSeektable
                                ? activeItem.structure.seekTableValid === false
                                  ? 'Defekt'
                                  : 'OK'
                                : 'Nein'
                            }`
                          : activeItem.structure.codec === 'mp3'
                          ? activeItem.structure.hasXingHeader
                            ? `Xing (${activeItem.structure.xingFrames}/${activeItem.structure.actualFrames} Fr)`
                            : activeItem.structure.isVbr
                            ? 'VBR ohne Xing!'
                            : `CBR (${activeItem.structure.actualFrames} Fr)`
                          : activeItem.structure.coverArtWidth
                          ? `Cover ${activeItem.structure.coverArtWidth}×${activeItem.structure.coverArtHeight}px`
                          : activeItem.structure.container.toUpperCase()}
                      </div>
                    </div>

                    <div className="p-2 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60">
                      <div className="text-[#57606A] dark:text-[#8B949E]">Null-Decode &amp; Pegel</div>
                      <div className="text-[#1F2328] dark:text-[#EAEEF2] font-semibold truncate">
                        Peak:{' '}
                        {activeItem.structure.maxVolumeDb !== null
                          ? `${activeItem.structure.maxVolumeDb.toFixed(1)} dB`
                          : '—'}{' '}
                        · CRC:{activeItem.structure.streamCrcErrors ?? 0} · Trunc:
                        {activeItem.structure.streamTruncated ? 'Ja!' : 'Nein'}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Visuelle Fehlerposition in der Datei */}
              {activeItem.health !== 'pending' && activeItem.health !== 'scanning' && (() => {
                const posList = getEffectiveErrorPositions(activeItem);
                const startPins = posList.filter((p) => p.zone === 'start');
                const streamPins = posList.filter((p) => p.zone === 'stream');
                const endPins = posList.filter((p) => p.zone === 'end');
                const streamPointPins = streamPins.filter((p) => typeof p.ratio === 'number');
                const streamSpanPins = streamPins.filter((p) => typeof p.ratio !== 'number');
                const sevRank = (s: RepairSeverity) => (s === 'critical' ? 3 : s === 'warning' ? 2 : 1);
                const worstColor = (pins: RepairErrorPosition[]) => {
                  if (pins.length === 0) return null;
                  const top = pins.reduce((a, b) => (sevRank(b.severity) > sevRank(a.severity) ? b : a));
                  return top.severity === 'critical'
                    ? '#DC2626'
                    : top.severity === 'warning'
                    ? '#F97316'
                    : '#EAB308';
                };
                const startCol = worstColor(startPins);
                const streamCol = worstColor(streamPins);
                const endCol = worstColor(endPins);
                const durSec = activeItem.structure?.durationSeconds || 0;
                const durLabel = durSec > 0 ? formatDuration(durSec) : 'Ende';
                return (
                  <div className="p-2.5 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 space-y-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                        Fehlerposition in der Datei
                      </span>
                      <span className="text-[11px] text-[#57606A] dark:text-[#8B949E]">
                        {posList.length === 0
                          ? 'Keine Fehlerpositionen (sauber)'
                          : `${posList.length} Markierung(en)`}
                      </span>
                    </div>

                    {/* 3-Zonen-Dateikarte: Header/Anfang | Audiostrom | Ende/Trailer */}
                    <div className="grid grid-cols-[minmax(68px,18%)_1fr_minmax(68px,18%)] gap-1 items-stretch">
                      {/* Zone 1: Header / Dateianfang */}
                      <div
                        title={
                          startPins.length > 0
                            ? `Dateianfang / Header:\n${startPins.map((p) => `• ${p.label}`).join('\n')}`
                            : 'Dateianfang / Header: OK'
                        }
                        className="relative h-9 rounded-l border flex flex-col items-center justify-center px-1 select-none"
                        style={{
                          borderColor: startCol || 'rgba(34,197,94,0.45)',
                          backgroundColor: startCol ? `${startCol}1F` : 'rgba(34,197,94,0.08)',
                        }}
                      >
                        <span className="text-[10px] font-semibold text-[#1F2328] dark:text-[#EAEEF2] leading-none">
                          Header
                        </span>
                        {startPins.length > 0 ? (
                          <span className="mt-1 inline-flex items-center gap-0.5">
                            {startPins.slice(0, 4).map((p, i) => (
                              <span
                                key={`st-${i}`}
                                className="w-2 h-2 rounded-full ring-1 ring-white/80 dark:ring-black/50"
                                style={{
                                  backgroundColor:
                                    p.severity === 'critical'
                                      ? '#DC2626'
                                      : p.severity === 'warning'
                                      ? '#F97316'
                                      : '#EAB308',
                                }}
                              />
                            ))}
                          </span>
                        ) : (
                          <span className="mt-0.5 text-[10px] font-semibold text-[#2E6B14] dark:text-[#9BE270]">
                            OK
                          </span>
                        )}
                      </div>

                      {/* Zone 2: Audiostrom (Zeitachse 0:00 -> Spielzeit) */}
                      <div
                        title={
                          streamPins.length > 0
                            ? `Audiostrom:\n${streamPins.map((p) => `• ${p.label}`).join('\n')}`
                            : 'Audiostrom: OK'
                        }
                        className="relative h-9 border overflow-hidden flex items-center justify-center px-2 select-none"
                        style={{
                          borderColor: streamCol || 'rgba(34,197,94,0.45)',
                          backgroundColor:
                            streamSpanPins.length > 0 && streamCol
                              ? `${streamCol}1A`
                              : 'rgba(34,197,94,0.06)',
                        }}
                      >
                        {/* Mittellinie / Zeitachse */}
                        <div
                          className="absolute left-1.5 right-1.5 top-1/2 -translate-y-1/2 h-[3px] rounded-full"
                          style={{
                            backgroundColor:
                              streamSpanPins.length > 0 && streamCol
                                ? `${streamCol}66`
                                : 'rgba(91,166,50,0.35)',
                          }}
                        />
                        {/* Exakte Positions-Marker (Sync-Lücken / Abtastratenwechsel / Dekodierfehler) */}
                        {streamPointPins.map((p, i) => {
                          const leftPct = Math.max(3, Math.min(97, Math.round((p.ratio || 0.5) * 100)));
                          const pinCol =
                            p.severity === 'critical'
                              ? '#DC2626'
                              : p.severity === 'warning'
                              ? '#F97316'
                              : '#EAB308';
                          return (
                            <div
                              key={`sp-${i}`}
                              title={p.label}
                              className="absolute top-0.5 bottom-0.5 flex flex-col items-center justify-center -translate-x-1/2"
                              style={{ left: `${leftPct}%` }}
                            >
                              <div className="w-[2px] h-full" style={{ backgroundColor: pinCol }} />
                              <span
                                className="absolute w-2.5 h-2.5 rounded-full ring-2 ring-white dark:ring-[#1C1F23]"
                                style={{ backgroundColor: pinCol }}
                              />
                            </div>
                          );
                        })}
                        <span className="relative z-10 text-[10px] font-medium px-1.5 py-0.5 rounded bg-white/80 dark:bg-[#1C1F23]/80 text-[#1F2328] dark:text-[#EAEEF2]">
                          {streamPins.length === 0
                            ? `Audiostrom (00:00 – ${durLabel}) · OK`
                            : streamPointPins.length > 0
                            ? `Audiostrom · ${streamPointPins.length} Fehlerstelle(n)`
                            : `Audiostrom · ${streamSpanPins.length} Befund(e)`}
                        </span>
                      </div>

                      {/* Zone 3: Ende / Trailer */}
                      <div
                        title={
                          endPins.length > 0
                            ? `Dateiende / Trailer:\n${endPins.map((p) => `• ${p.label}`).join('\n')}`
                            : 'Dateiende / Trailer: OK'
                        }
                        className="relative h-9 rounded-r border flex flex-col items-center justify-center px-1 select-none"
                        style={{
                          borderColor: endCol || 'rgba(34,197,94,0.45)',
                          backgroundColor: endCol ? `${endCol}1F` : 'rgba(34,197,94,0.08)',
                        }}
                      >
                        <span className="text-[10px] font-semibold text-[#1F2328] dark:text-[#EAEEF2] leading-none">
                          Ende
                        </span>
                        {endPins.length > 0 ? (
                          <span className="mt-1 inline-flex items-center gap-0.5">
                            {endPins.slice(0, 4).map((p, i) => (
                              <span
                                key={`en-${i}`}
                                className="w-2 h-2 rounded-full ring-1 ring-white/80 dark:ring-black/50"
                                style={{
                                  backgroundColor:
                                    p.severity === 'critical'
                                      ? '#DC2626'
                                      : p.severity === 'warning'
                                      ? '#F97316'
                                      : '#EAB308',
                                }}
                              />
                            ))}
                          </span>
                        ) : (
                          <span className="mt-0.5 text-[10px] font-semibold text-[#2E6B14] dark:text-[#9BE270]">
                            OK
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[10px] font-mono text-[#57606A] dark:text-[#8B949E]">
                      <span>Anfang (00:00)</span>
                      <span>Audiostrom</span>
                      <span>{durLabel} · Trailer</span>
                    </div>

                    {posList.length > 0 && (
                      <div className="space-y-1 pt-1 border-t border-[#E1E4E8] dark:border-[#343A40]">
                        {posList.slice(0, 6).map((p, idxP) => {
                          const dotCol =
                            p.severity === 'critical'
                              ? '#DC2626'
                              : p.severity === 'warning'
                              ? '#F97316'
                              : '#EAB308';
                          const zoneTxt =
                            p.zone === 'start'
                              ? 'Dateianfang (Header)'
                              : p.zone === 'end'
                              ? 'Dateiende (Trailer)'
                              : typeof p.ratio === 'number'
                              ? `Audiostrom (${Math.round(p.ratio * 100)} %${
                                  typeof p.timeSeconds === 'number'
                                    ? ` · ~${formatDuration(p.timeSeconds)}`
                                    : ''
                                })`
                              : 'Audiostrom (gesamt)';
                          return (
                            <div
                              key={`leg-${idxP}`}
                              className="flex items-start gap-1.5 text-xs text-[#1F2328] dark:text-[#EAEEF2]"
                            >
                              <span
                                className="w-2 h-2 rounded-full mt-1 shrink-0"
                                style={{ backgroundColor: dotCol }}
                              />
                              <span className="min-w-0 break-words">
                                <strong>{zoneTxt}:</strong> {p.label}
                              </span>
                            </div>
                          );
                        })}
                        {posList.length > 6 && (
                          <div className="text-xs text-[#57606A] dark:text-[#8B949E]">
                            … und {posList.length - 6} weitere Position(en)
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Diagnose-Befunde */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                  Diagnose-Befunde ({activeItem.findings.length})
                </div>
                {activeItem.findings.length === 0 ? (
                  <div className="p-3 rounded border border-[#5BA632]/30 bg-[#5BA632]/5 text-xs text-[#2E6B14] dark:text-[#9BE270] flex items-center gap-2">
                    <SystemIcon name="status_ok" className="w-4 h-4 shrink-0" />
                    <span>
                      Keine Struktur-, Header- oder Frame-Fehler erkannt. Die Datei ist sauber.
                    </span>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                    {activeItem.findings.map((finding) => {
                      const posMeta = resolveFindingPositionSummary(finding, activeItem.structure);
                      return (
                        <div
                          key={finding.id}
                          className={`p-2.5 rounded border text-xs space-y-1.5 ${
                            finding.severity === 'critical'
                              ? 'border-red-500/40 bg-red-500/5'
                              : finding.severity === 'warning'
                              ? 'border-amber-500/40 bg-amber-500/5'
                              : 'border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/50'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                              {finding.title}
                            </span>
                            <div className="flex items-center gap-1 shrink-0">
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 text-[#57606A] dark:text-[#8B949E]">
                                {finding.stage === 'deep' ? 'Deep' : 'Fast'}
                              </span>
                              <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 text-[#57606A] dark:text-[#8B949E]">
                                {finding.severity === 'critical'
                                  ? 'Kritisch'
                                  : finding.severity === 'warning'
                                  ? 'Warnung'
                                  : 'Hinweis'}
                              </span>
                            </div>
                          </div>
                          <div className="text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                            Position: <span className="text-[#57606A] dark:text-[#8B949E]">{posMeta.text}</span>
                          </div>
                          <p className="text-xs text-[#57606A] dark:text-[#8B949E]">
                            {finding.description}
                          </p>
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#2E6B14] dark:text-[#9BE270]">
                            <span>Lösung: {finding.recommendedFix}</span>
                            {finding.fixAction && (
                              <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[#5BA632]/15 text-[#2E6B14] dark:text-[#9BE270]">
                                Fix: {FIX_ACTION_LABELS[finding.fixAction]}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
          </fieldset>
        </div>
      </div>
    </div>
  );
}
