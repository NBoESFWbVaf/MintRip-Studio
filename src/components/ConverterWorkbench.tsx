import React, { useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import { DEFAULT_MODULE_OUTPUT_DIRS, ExportSettings, normalizeMaxThreads } from '../types/mintrip';
import {
  extractAudioMetadataAndDuration,
  formatDuration,
  triggerTextDownload,
} from '../utils/audioExportHelpers';
import {
  extractTopFolderNameFromEntries,
  pickDirectoryWithPersistence,
} from '../utils/folderImportHelper';
import { ModulePageHeaderBar } from './ModulePages';
import { SystemIcon } from './SystemIcons';

export type ConverterTargetFormat = 'flac' | 'mp3' | 'wav' | 'opus' | 'ogg' | 'm4a' | 'aiff';

type ConverterItemStage = 'ready' | 'converting' | 'done' | 'error' | 'cancelled';

interface ConverterItem {
  id: string;
  file: File;
  relativePath: string;
  relDir: string;
  sourceExt: string;
  sizeBytes: number;
  durationSeconds: number;
  artist: string;
  title: string;
  album: string;
  selected: boolean;
  stage: ConverterItemStage;
  progress: number;
  statusMessage: string;
  convertedBlob?: Blob;
  convertedUrl?: string;
  convertedFileName?: string;
  convertedRelativePath?: string;
}

export interface ConverterWorkbenchHandle {
  openSingleFilePicker: () => void;
  openRecursiveFolderPicker: () => void;
}

export interface ConverterToolbarState {
  isConverting: boolean;
}

interface ConverterWorkbenchProps {
  settings: ExportSettings;
  onSettingsChange?: React.Dispatch<React.SetStateAction<ExportSettings>>;
  onAppendQueryLog: (line: string) => void;
  actionRef?: React.MutableRefObject<ConverterWorkbenchHandle | null>;
  onToolbarStateChange?: (state: ConverterToolbarState) => void;
}

const AUDIO_FILE_RE = /\.(wav|flac|mp3|mp2|ogg|aiff|aif|aifc|dsf|tta|opus|wv|m4a)$/i;

const TARGET_FORMAT_OPTIONS: Array<{
  id: ConverterTargetFormat;
  label: string;
  shortDesc: string;
}> = [
  { id: 'flac', label: 'FLAC', shortDesc: 'Verlustfrei · Vorbis Tags' },
  { id: 'mp3', label: 'MP3', shortDesc: 'LAME · ID3v2.3/v2.4' },
  { id: 'wav', label: 'WAV', shortDesc: 'PCM unkomprimiert · ID3v2' },
  { id: 'opus', label: 'Opus', shortDesc: 'Ogg Opus · Effizient' },
  { id: 'ogg', label: 'Ogg Vorbis', shortDesc: 'Vorbis · Frei' },
  { id: 'm4a', label: 'M4A (AAC)', shortDesc: 'MP4 Audio · Mobil' },
  { id: 'aiff', label: 'AIFF', shortDesc: 'PCM Apple/Studio · ID3v2' },
];

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

function computeTargetRelativePath(
  item: ConverterItem,
  targetFormat: ConverterTargetFormat,
  preserveStructure: boolean
): string {
  const stem = item.file.name.replace(/\.[^.]+$/, '') || 'converted';
  const outName = `${stem}.${targetFormat}`;
  if (preserveStructure && item.relDir) {
    return `${item.relDir}/${outName}`;
  }
  return outName;
}

interface DropEntryFileResult {
  file: File;
  relativePath: string;
}

async function collectFilesFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<DropEntryFileResult[]> {
  const results: DropEntryFileResult[] = [];
  const items = Array.from(dataTransfer.items || []);

  const readAllEntries = async (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> => {
    const all: FileSystemEntry[] = [];
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) => {
        reader.readEntries(
          (entries) => resolve(entries || []),
          () => resolve([])
        );
      });
      if (!batch.length) break;
      all.push(...batch);
    }
    return all;
  };

  const traverseEntry = async (entry: FileSystemEntry, parentPath: string): Promise<void> => {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const f = await new Promise<File | null>((resolve) => {
        fileEntry.file(
          (loaded) => resolve(loaded),
          () => resolve(null)
        );
      });
      if (f) {
        const relPath = parentPath ? `${parentPath}/${f.name}` : f.name;
        results.push({ file: f, relativePath: relPath });
      }
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const nextParent = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const children = await readAllEntries(dirEntry.createReader());
      for (const child of children) {
        await traverseEntry(child, nextParent);
      }
    }
  };

  const entries = items
    .map((it) =>
      typeof (it as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null })
        .webkitGetAsEntry === 'function'
        ? (it as DataTransferItem & { webkitGetAsEntry: () => FileSystemEntry | null }).webkitGetAsEntry()
        : null
    )
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length > 0) {
    for (const entry of entries) {
      await traverseEntry(entry, '');
    }
    return results;
  }

  for (const file of Array.from(dataTransfer.files || [])) {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    results.push({ file, relativePath: rel });
  }
  return results;
}

export function ConverterWorkbench({
  settings,
  onSettingsChange,
  onAppendQueryLog,
  actionRef,
  onToolbarStateChange,
}: ConverterWorkbenchProps) {
  const [items, setItems] = useState<ConverterItem[]>([]);
  const [targetFormat, setTargetFormat] = useState<ConverterTargetFormat>('flac');
  const [flacLevel, setFlacLevel] = useState<number>(settings.flacCompressionLevel ?? 6);
  const [mp3Quality, setMp3Quality] = useState<string>(settings.mp3Quality ?? 'vbr_v0');
  const [bitrateKbps, setBitrateKbps] = useState<string>('192');
  const [pcmBits, setPcmBits] = useState<'16' | '24'>('16');
  const [id3Version, setId3Version] = useState<3 | 4>(settings.id3v2Version ?? 4);
  const [preserveStructure, setPreserveStructure] = useState<boolean>(true);
  const [preserveTags, setPreserveTags] = useState<boolean>(true);
  const [normalizeAudio, setNormalizeAudio] = useState<boolean>(settings.normalizeAlbum ?? false);

  const [isConverting, setIsConverting] = useState<boolean>(false);
  const [isDragActive, setIsDragActive] = useState<boolean>(false);
  const [isTableDragActive, setIsTableDragActive] = useState<boolean>(false);
  const [isBuildingZip, setIsBuildingZip] = useState<boolean>(false);
  const [isConverterSetupOpen, setIsConverterSetupOpen] = useState<boolean>(false);

  const singleFileInputRef = useRef<HTMLInputElement>(null);
  const recursiveFolderInputRef = useRef<HTMLInputElement>(null);
  const rootDragDepthRef = useRef<number>(0);
  const tableDragDepthRef = useRef<number>(0);
  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const itemsRef = useRef<ConverterItem[]>([]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    onToolbarStateChange?.({ isConverting });
  }, [isConverting, onToolbarStateChange]);

  useEffect(() => {
    if (recursiveFolderInputRef.current) {
      recursiveFolderInputRef.current.setAttribute('webkitdirectory', '');
      recursiveFolderInputRef.current.setAttribute('directory', '');
    }
  }, []);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      for (const it of itemsRef.current) {
        if (it.convertedUrl) {
          URL.revokeObjectURL(it.convertedUrl);
        }
      }
    };
  }, []);

  const selectedCount = items.filter((it) => it.selected).length;
  const allSelected = items.length > 0 && selectedCount === items.length;
  const someSelected = selectedCount > 0 && selectedCount < items.length;
  const doneItems = items.filter((it) => it.stage === 'done' && it.convertedBlob);

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  const activeQualityParam = (): string => {
    if (targetFormat === 'flac') return String(flacLevel);
    if (targetFormat === 'mp3') return mp3Quality;
    if (targetFormat === 'wav' || targetFormat === 'aiff') return pcmBits;
    return bitrateKbps;
  };

  const ingestEntries = async (
    rawEntries: Array<{ file: File; relativePath: string }>,
    sourceKindLabel: string
  ) => {
    const audioEntries = rawEntries.filter(
      (entry) => AUDIO_FILE_RE.test(entry.file.name) || entry.file.type.startsWith('audio/')
    );
    if (audioEntries.length === 0) {
      onAppendQueryLog(`[Konverter] Keine unterstützten Audiodateien beim ${sourceKindLabel} gefunden.`);
      return;
    }

    audioEntries.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: 'base' })
    );

    const existingKeys = new Set(
      itemsRef.current.map((it) => `${it.relativePath}::${it.sizeBytes}`)
    );

    const parsedNew: ConverterItem[] = [];
    for (const entry of audioEntries) {
      const relPath = (entry.relativePath || entry.file.name).replace(/\\/g, '/').replace(/^\/+/, '');
      const key = `${relPath}::${entry.file.size}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);

      const extMatch = entry.file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
      const sourceExt = extMatch ? extMatch[1].toUpperCase() : 'AUDIO';
      const meta = await extractAudioMetadataAndDuration(entry.file);

      parsedNew.push({
        id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file: entry.file,
        relativePath: relPath,
        relDir: getRelDirFromRelativePath(relPath),
        sourceExt,
        sizeBytes: entry.file.size,
        durationSeconds: Math.max(0, Math.round(meta.durationSeconds || 0)),
        artist: meta.artist || '',
        title: meta.title || entry.file.name.replace(/\.[^.]+$/, ''),
        album: meta.album || '',
        selected: true,
        stage: 'ready',
        progress: 0,
        statusMessage: 'Bereit zur Konvertierung',
      });
    }

    if (parsedNew.length === 0) {
      onAppendQueryLog(`[Konverter] Alle gewählten Dateien befinden sich bereits in der Liste.`);
      return;
    }

    setItems((prev) => [...prev, ...parsedNew]);
    onAppendQueryLog(
      `[Konverter] ${parsedNew.length} Audiodatei(en) über „${sourceKindLabel}“ hinzugefügt.`
    );
  };

  const handleToggleSelectAll = () => {
    const next = !allSelected;
    setItems((prev) => prev.map((it) => ({ ...it, selected: next })));
  };

  const handleRemoveItem = (id: string) => {
    setItems((prev) => {
      const target = prev.find((it) => it.id === id);
      if (target?.convertedUrl) {
        URL.revokeObjectURL(target.convertedUrl);
      }
      return prev.filter((it) => it.id !== id);
    });
  };

  const handleClearFinished = () => {
    setItems((prev) => {
      for (const it of prev) {
        if ((it.stage === 'done' || it.stage === 'cancelled') && it.convertedUrl) {
          URL.revokeObjectURL(it.convertedUrl);
        }
      }
      return prev.filter((it) => it.stage !== 'done' && it.stage !== 'cancelled');
    });
    onAppendQueryLog('[Konverter] Abgeschlossene und abgebrochene Einträge aus der Liste entfernt.');
  };

  const handleClearAll = () => {
    for (const it of items) {
      if (it.convertedUrl) {
        URL.revokeObjectURL(it.convertedUrl);
      }
    }
    setItems([]);
    onAppendQueryLog('[Konverter] Importliste vollständig geleert.');
  };

  const handleCancelConversion = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsConverting(false);
    setItems((prev) =>
      prev.map((it) =>
        it.stage === 'converting'
          ? { ...it, stage: 'cancelled', progress: 0, statusMessage: 'Durch Benutzer abgebrochen' }
          : it
      )
    );
    onAppendQueryLog('[Konverter] Laufende Konvertierung abgebrochen.');
  };

  const handleStartConversion = async () => {
    const targets = items.filter((it) => it.selected);
    if (targets.length === 0 || isConverting) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsConverting(true);

    const qualityVal = activeQualityParam();
    const targetFmt = targetFormat;
    const keepDir = preserveStructure;
    const keepTags = preserveTags;
    const doNorm = normalizeAudio;
    const targetLufs = settings.normalizeTargetLufs ?? -18;
    const id3Ver = id3Version;

    onAppendQueryLog(
      `[Konverter] Starte Konvertierung von ${targets.length} Datei(en) nach ${targetFmt.toUpperCase()} (${
        keepDir ? 'Ordnerstruktur beibehalten' : 'flacher Zielordner'
      }${keepTags ? ' · Metadaten übernehmen' : ''}${
        doNorm ? ` · EBU R128 (${targetLufs} LUFS)` : ''
      })...`
    );

    setItems((prev) =>
      prev.map((it) => {
        if (!it.selected) return it;
        if (it.convertedUrl) URL.revokeObjectURL(it.convertedUrl);
        return {
          ...it,
          stage: 'ready',
          progress: 0,
          statusMessage: 'In Warteschlange...',
          convertedBlob: undefined,
          convertedUrl: undefined,
          convertedFileName: undefined,
          convertedRelativePath: undefined,
        };
      })
    );

    const targetIds = targets.map((t) => t.id);
    let cursor = 0;
    const maxThreads = normalizeMaxThreads(settings.maxThreads);
    const concurrency = Math.max(1, Math.min(maxThreads, targetIds.length));
    const ffmpegThreads = Math.max(1, Math.floor(maxThreads / concurrency));

    const runWorker = async () => {
      while (!controller.signal.aborted) {
        const idx = cursor++;
        if (idx >= targetIds.length) return;
        const jobId = targetIds[idx];
        const currentItem = itemsRef.current.find((x) => x.id === jobId);
        if (!currentItem) continue;

        setItems((prev) =>
          prev.map((it) =>
            it.id === jobId
              ? {
                  ...it,
                  stage: 'converting',
                  progress: 0.25,
                  statusMessage: `Kodierung nach ${targetFmt.toUpperCase()}...`,
                }
              : it
          )
        );

        try {
          const buf = await currentItem.file.arrayBuffer();
          if (controller.signal.aborted) return;

          setItems((prev) =>
            prev.map((it) =>
              it.id === jobId ? { ...it, progress: 0.55, statusMessage: 'ffmpeg arbeitet...' } : it
            )
          );

          const qs = new URLSearchParams({
            sourceName: currentItem.file.name,
            targetFormat: targetFmt,
            quality: qualityVal,
            id3v2Version: String(id3Ver),
            preserveTags: String(keepTags),
            normalize: String(doNorm),
            targetLufs: String(targetLufs),
            ffmpegThreads: String(ffmpegThreads),
          });

          const resp = await fetch(`/api/convert?${qs.toString()}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
            },
            body: buf,
            signal: controller.signal,
          });

          if (!resp.ok) {
            const errJson = await resp.json().catch(() => ({}));
            throw new Error(errJson.error || `HTTP ${resp.status}`);
          }

          const outBlob = await resp.blob();
          const outUrl = URL.createObjectURL(outBlob);
          const outRelPath = computeTargetRelativePath(currentItem, targetFmt, keepDir);
          const outFileName = outRelPath.split('/').pop() || outRelPath;

          setItems((prev) =>
            prev.map((it) =>
              it.id === jobId
                ? {
                    ...it,
                    stage: 'done',
                    progress: 1,
                    statusMessage: `Fertig → ${outRelPath} (${formatBytesReadable(outBlob.size)})`,
                    convertedBlob: outBlob,
                    convertedUrl: outUrl,
                    convertedFileName: outFileName,
                    convertedRelativePath: outRelPath,
                  }
                : it
            )
          );
          onAppendQueryLog(`[Konverter] Abgeschlossen: ${currentItem.relativePath} → ${outRelPath}`);
        } catch (err) {
          if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
            return;
          }
          const msg = err instanceof Error ? err.message : 'Konvertierungsfehler';
          setItems((prev) =>
            prev.map((it) =>
              it.id === jobId
                ? { ...it, stage: 'error', progress: 0, statusMessage: `Fehler: ${msg}` }
                : it
            )
          );
          onAppendQueryLog(`[Konverter] Fehler bei „${currentItem.relativePath}“: ${msg}`);
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setIsConverting(false);
        if (!controller.signal.aborted) {
          onAppendQueryLog('[Konverter] Stapelkonvertierung abgeschlossen.');
        }
      }
    }
  };

  const handleDownloadAllZip = async () => {
    if (doneItems.length === 0 || isBuildingZip) return;
    setIsBuildingZip(true);
    try {
      const zip = new JSZip();
      for (const item of doneItems) {
        if (!item.convertedBlob) continue;
        const zipEntryPath =
          item.convertedRelativePath ||
          computeTargetRelativePath(item, targetFormat, preserveStructure);
        zip.file(zipEntryPath, item.convertedBlob);
      }
      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mintrip-konvertiert-${targetFormat}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onAppendQueryLog(
        `[Konverter] ZIP-Archiv mit ${doneItems.length} konvertierter Datei(en) heruntergeladen.`
      );
    } finally {
      setIsBuildingZip(false);
    }
  };

  const handleDownloadConverterScript = () => {
    const selected = items.filter((it) => it.selected);
    const sourceList = selected.length > 0 ? selected : items;
    const q = activeQualityParam();
    const outBase = (
      settings.outputDirConvert || DEFAULT_MODULE_OUTPUT_DIRS.outputDirConvert
    ).replace(/\/+$/, '');

    const codecArgs = (() => {
      if (targetFormat === 'flac') return `-c:a flac -compression_level ${q}`;
      if (targetFormat === 'mp3') {
        const qa =
          q === 'cbr_320'
            ? '-b:a 320k'
            : q === 'cbr_256'
              ? '-b:a 256k'
              : q === 'cbr_192'
                ? '-b:a 192k'
                : q === 'vbr_v2'
                  ? '-q:a 2'
                  : '-q:a 0';
        return `-c:a libmp3lame ${qa} -id3v2_version ${id3Version}`;
      }
      if (targetFormat === 'wav') {
        return `-c:a ${q === '24' ? 'pcm_s24le' : 'pcm_s16le'}${
          preserveTags ? ` -write_id3v2 1 -id3v2_version ${id3Version}` : ''
        }`;
      }
      if (targetFormat === 'aiff') {
        return `-c:a ${q === '24' ? 'pcm_s24be' : 'pcm_s16be'}${
          preserveTags ? ` -write_id3v2 1 -id3v2_version ${id3Version}` : ''
        }`;
      }
      if (targetFormat === 'opus') return `-c:a libopus -b:a ${q}k`;
      if (targetFormat === 'ogg') return `-c:a libvorbis -b:a ${q}k`;
      return `-c:a aac -b:a ${q}k -movflags +faststart`;
    })();

    const afArg = normalizeAudio
      ? `-af "loudnorm=I=${(settings.normalizeTargetLufs ?? -18).toFixed(1)}:TP=-1.0:LRA=11"`
      : '';
    const mapArgs =
      preserveTags && (targetFormat === 'flac' || targetFormat === 'mp3')
        ? '-map 0:a:0 -map 0:v? -c:v copy -map_metadata 0'
        : preserveTags
          ? '-map 0:a:0 -vn -map_metadata 0'
          : '-map 0:a:0 -vn -map_metadata -1';

    const lines = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '# Konvertierungsskript erzeugt von MintRip Studio (Modul 4: Musik konvertieren)',
      `OUT_ROOT="${outBase}"`,
      'TMP_DIR="$(mktemp -d)"',
      'trap "rm -rf $TMP_DIR" EXIT',
      '',
    ];

    for (const item of sourceList) {
      const dstRel = computeTargetRelativePath(item, targetFormat, preserveStructure);
      const srcEsc = item.relativePath.replace(/"/g, '\\"');
      const dstEsc = dstRel.replace(/"/g, '\\"');
      lines.push(`mkdir -p "$(dirname "$OUT_ROOT/${dstEsc}")"`);
      if (targetFormat === 'flac') {
        lines.push(
          `SRC_INFO=$(ffprobe -v error -select_streams a:0 -show_entries stream=bits_per_raw_sample,sample_fmt,sample_rate -of default=noprint_wrappers=1:nokey=1 "${srcEsc}" | tr '\\n' ' ')`
        );
        lines.push(
          'PCM_CODEC="pcm_s16le"; case "$SRC_INFO" in *24*|*32*|*flt*) PCM_CODEC="pcm_s24le" ;; esac'
        );
        lines.push('TMP_WAV="$TMP_DIR/conv_stage.wav"');
        lines.push(
          `ffmpeg -y -hide_banner -loglevel error -i "${srcEsc}" -map 0:a:0 -vn -map_metadata -1 ${afArg} -c:a "$PCM_CODEC" "$TMP_WAV"`.replace(
            /\s+/g,
            ' '
          )
        );
        const step2Map = preserveTags
          ? '-i "$TMP_WAV" -i "' + srcEsc + '" -map 0:a:0 -map 1:v? -c:v copy -map_metadata 1 -map_metadata 1:s:a:0'
          : '-i "$TMP_WAV" -map 0:a:0 -vn -map_metadata -1';
        lines.push(
          `ffmpeg -y -hide_banner -loglevel error ${step2Map} -c:a flac -compression_level ${q} "$OUT_ROOT/${dstEsc}"`.replace(
            /\s+/g,
            ' '
          )
        );
      } else {
        lines.push(
          `ffmpeg -y -hide_banner -loglevel error -i "${srcEsc}" ${afArg} ${mapArgs} ${codecArgs} "$OUT_ROOT/${dstEsc}"`.replace(
            /\s+/g,
            ' '
          )
        );
      }
    }
    triggerTextDownload('mintrip_convert.sh', lines.join('\n') + '\n', 'text/x-shellscript;charset=utf-8');
    onAppendQueryLog(
      `[Konverter] Konvertierungs-Skript (mintrip_convert.sh) für ${sourceList.length} Datei(en) exportiert.`
    );
  };

  const handleOpenSingleFilePicker = () => {
    singleFileInputRef.current?.click();
  };

  const handleOpenRecursiveFolderPicker = async () => {
    const picked = await pickDirectoryWithPersistence();
    if (picked.status === 'picked') {
      onSettingsChange?.((prev) => ({
        ...prev,
        lastImportFolder: picked.folderName,
      }));
      await ingestEntries(picked.entries, 'Rekursiver Ordner-Import');
    } else if (picked.status === 'fallback_input') {
      recursiveFolderInputRef.current?.click();
    }
  };

  useEffect(() => {
    if (!actionRef) return;
    actionRef.current = {
      openSingleFilePicker: handleOpenSingleFilePicker,
      openRecursiveFolderPicker: () => {
        void handleOpenRecursiveFolderPicker();
      },
    };
    return () => {
      actionRef.current = null;
    };
  });

  const totalProgress =
    items.length === 0
      ? 0
      : Math.round((items.reduce((sum, it) => sum + it.progress, 0) / items.length) * 100);

  return (
    <div
      className="space-y-4"
      onDragEnter={(e) => {
        if (isConverting) return;
        e.preventDefault();
        rootDragDepthRef.current += 1;
        setIsDragActive(true);
      }}
      onDragOver={(e) => {
        if (isConverting) return;
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
        if (isConverting) return;
        e.preventDefault();
        rootDragDepthRef.current = 0;
        tableDragDepthRef.current = 0;
        setIsDragActive(false);
        setIsTableDragActive(false);
        const dropped = await collectFilesFromDataTransfer(e.dataTransfer);
        if (dropped.length > 0) {
          await ingestEntries(dropped, 'Drag & Drop');
        }
      }}
    >
      <ModulePageHeaderBar
        moduleNumber="04. Modul"
        title="Musik konvertieren"
        subtitle="Einzeldateien oder ganze Verzeichnisbäume rekursiv importieren & umwandeln (Entwurf)"
        icon="module_convert"
      />

      {/* Versteckte Datei- & Ordner-Inputs bleiben unabhängig vom Klappzustand gemountet */}
      <input
        ref={singleFileInputRef}
        type="file"
        multiple
        accept=".wav,.flac,.mp3,.mp2,.ogg,.aiff,.aif,.aifc,.dsf,.tta,.opus,.wv,.m4a,audio/*"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            const picked = Array.from(e.target.files).map((file) => ({
              file,
              relativePath: file.name,
            }));
            void ingestEntries(picked, 'Einzeldatei-Auswahl');
            e.target.value = '';
          }
        }}
      />

      <input
        ref={recursiveFolderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            const picked = Array.from(e.target.files).map((file) => ({
              file,
              relativePath:
                (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
            }));
            const topFolder = extractTopFolderNameFromEntries(picked);
            if (topFolder) {
              onSettingsChange?.((prev) => ({
                ...prev,
                lastImportFolder: topFolder,
              }));
            }
            void ingestEntries(picked, 'Rekursiver Ordner-Import');
            e.target.value = '';
          }
        }}
      />

      {/* Zusammenklappbares Display: Quelle importieren & Zielformat (Default: eingeklappt) */}
      <section
        aria-label="Quelle importieren und Zielformat"
        className={`bg-white dark:bg-[#25292E] border rounded-lg overflow-hidden transition-colors ${
          isDragActive
            ? 'border-[#5BA632] bg-[#5BA632]/5'
            : 'border-[#E1E4E8] dark:border-[#343A40]'
        }`}
      >
        <button
          type="button"
          onClick={() => setIsConverterSetupOpen((prev) => !prev)}
          aria-expanded={isConverterSetupOpen}
          className="w-full px-4 py-2.5 flex items-center justify-between gap-3 text-left bg-[#F8F9FA] dark:bg-[#1C1F23]/60 hover:bg-[#F1F3F5] dark:hover:bg-[#2D333B]/70 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2 min-w-0">
            <SystemIcon
              name="module_convert"
              className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F] shrink-0"
            />
            <span className="text-xs font-bold uppercase tracking-wide text-[#1F2328] dark:text-[#EAEEF2] truncate">
              Quelle importieren &amp; Zielformat
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden sm:inline text-[11px] text-[#57606A] dark:text-[#8B949E]">
              Ziel: {targetFormat.toUpperCase()} ·{' '}
              {targetFormat === 'flac'
                ? `Stufe ${flacLevel}`
                : targetFormat === 'mp3'
                ? mp3Quality.replace('_', ' ').toUpperCase()
                : targetFormat === 'wav' || targetFormat === 'aiff'
                ? `${pcmBits}-Bit PCM`
                : `${bitrateKbps} kbps`}
              {normalizeAudio ? ' · EBU-R128' : ''}
            </span>
            <span
              aria-hidden="true"
              className="text-sm font-bold leading-none text-[#57606A] dark:text-[#8B949E] w-4 text-center"
            >
              {isConverterSetupOpen ? '−' : '+'}
            </span>
          </div>
        </button>

        {isConverterSetupOpen && (
          <div className="p-4 border-t border-[#E1E4E8] dark:border-[#343A40] grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
            {/* Linke Spalte: Import-Hinweis, Pfade & Drag-and-Drop */}
            <section
              aria-label="Dateien und Ordner importieren"
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
                    Quelle importieren (Datei &amp; Ordner rekursiv)
                  </h2>
                </div>
                <p className="text-xs text-[#57606A] dark:text-[#8B949E]">
                  Import über „Dateien / Ordner importieren“ oben in der Toolbar oder direkt per Drag &amp;
                  Drop von Einzeldateien und ganzen Ordnern in das Fenster bzw. die Tabelle.
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
                <div className="flex items-center justify-between gap-2 px-2 py-1 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-white dark:bg-[#1C1F23]/60">
                  <span className="text-[#57606A] dark:text-[#8B949E] shrink-0">Zielordner (Modul 4):</span>
                  <span
                    className="font-mono text-[#1F2328] dark:text-[#EAEEF2] truncate"
                    title={settings.outputDirConvert || DEFAULT_MODULE_OUTPUT_DIRS.outputDirConvert}
                  >
                    {settings.outputDirConvert || DEFAULT_MODULE_OUTPUT_DIRS.outputDirConvert}
                  </span>
                </div>
              </div>

              <div className="border border-dashed border-[#D0D7DE] dark:border-[#444C56] rounded px-3 py-2 text-center text-[11px] text-[#57606A] dark:text-[#8B949E]">
                Drag &amp; Drop: FLAC · WAV · MP3 · MP2 · AIFF/AIF/AIFC · DSF · TTA · Ogg · Opus · M4A · WV
              </div>
            </section>

            {/* Rechte Spalte: Zielformat, Qualität & Konvertierungs-Optionen */}
            <section
              aria-label="Konvertierungs-Einstellungen"
              className="lg:col-span-7 bg-[#FAFBFD] dark:bg-[#1F2328] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg p-4 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <SystemIcon
                    name="module_convert"
                    className="w-4 h-4 text-[#5BA632] dark:text-[#69B53F]"
                  />
                  <h2 className="text-xs font-bold uppercase tracking-wide text-[#57606A] dark:text-[#8B949E]">
                    Zielformat &amp; Kodierungsparameter
                  </h2>
                </div>
                <span className="text-[11px] font-mono text-[#57606A] dark:text-[#8B949E]">
                  Zielpfad (Skript): {settings.outputDir || '~/Musik'}/Konvertiert
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                    Zielformat
                  </span>
                  <select
                    value={targetFormat}
                    disabled={isConverting}
                    onChange={(e) => setTargetFormat(e.target.value as ConverterTargetFormat)}
                    className="w-full px-2.5 py-1.5 text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                  >
                    {TARGET_FORMAT_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label} — {opt.shortDesc}
                      </option>
                    ))}
                  </select>
                </label>

                {targetFormat === 'flac' && (
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                      FLAC-Kompressionsstufe
                    </span>
                    <select
                      value={flacLevel}
                      disabled={isConverting}
                      onChange={(e) => setFlacLevel(Number(e.target.value))}
                      className="w-full px-2.5 py-1.5 text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                    >
                      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((lvl) => (
                        <option key={lvl} value={lvl}>
                          Stufe {lvl} {lvl === 0 ? '(Schnell)' : lvl === 8 ? '(Maximal)' : lvl === 6 ? '(Standard)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {targetFormat === 'mp3' && (
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                      LAME MP3-Qualität
                    </span>
                    <select
                      value={mp3Quality}
                      disabled={isConverting}
                      onChange={(e) => setMp3Quality(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                    >
                      <option value="vbr_v0">VBR V0 (~245 kbps · Archiv)</option>
                      <option value="vbr_v2">VBR V2 (~190 kbps · Mobil)</option>
                      <option value="cbr_320">CBR 320 kbps</option>
                      <option value="cbr_256">CBR 256 kbps</option>
                      <option value="cbr_192">CBR 192 kbps</option>
                    </select>
                  </label>
                )}

                {(targetFormat === 'wav' || targetFormat === 'aiff') && (
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                      PCM-Bittiefe
                    </span>
                    <select
                      value={pcmBits}
                      disabled={isConverting}
                      onChange={(e) => setPcmBits(e.target.value as '16' | '24')}
                      className="w-full px-2.5 py-1.5 text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                    >
                      <option value="16">16-Bit PCM (CD-Qualität)</option>
                      <option value="24">24-Bit PCM (Studio)</option>
                    </select>
                  </label>
                )}

                {(targetFormat === 'opus' || targetFormat === 'ogg' || targetFormat === 'm4a') && (
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                      Ziel-Bitrate
                    </span>
                    <select
                      value={bitrateKbps}
                      disabled={isConverting}
                      onChange={(e) => setBitrateKbps(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2]"
                    >
                      <option value="320">320 kbps</option>
                      <option value="256">256 kbps</option>
                      <option value="192">192 kbps (Empfohlen)</option>
                      <option value="160">160 kbps</option>
                      <option value="128">128 kbps</option>
                      <option value="96">96 kbps</option>
                    </select>
                  </label>
                )}

                {(targetFormat === 'mp3' || targetFormat === 'wav' || targetFormat === 'aiff') && (
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2]">
                      ID3v2-Version
                    </span>
                    <select
                      value={id3Version}
                      disabled={isConverting || !preserveTags}
                      onChange={(e) => setId3Version(Number(e.target.value) as 3 | 4)}
                      className="w-full px-2.5 py-1.5 text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] disabled:opacity-50"
                    >
                      <option value={4}>ID3v2.4 (UTF-8 Standard)</option>
                      <option value={3}>ID3v2.3 (Maximale Kompatibilität)</option>
                    </select>
                  </label>
                )}
              </div>

              <div className="pt-1 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[#1F2328] dark:text-[#EAEEF2]">
                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={preserveStructure}
                    disabled={isConverting}
                    onChange={(e) => setPreserveStructure(e.target.checked)}
                    className="accent-[#5BA632] rounded"
                  />
                  <span>Ordnerstruktur rekursiv beibehalten</span>
                </label>

                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={preserveTags}
                    disabled={isConverting}
                    onChange={(e) => setPreserveTags(e.target.checked)}
                    className="accent-[#5BA632] rounded"
                  />
                  <span>Metadaten &amp; Coverbild übernehmen</span>
                </label>

                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={normalizeAudio}
                    disabled={isConverting}
                    onChange={(e) => setNormalizeAudio(e.target.checked)}
                    className="accent-[#5BA632] rounded"
                  />
                  <span>
                    EBU-R128-Normalisierung ({(settings.normalizeTargetLufs ?? -18).toFixed(0)} LUFS)
                  </span>
                </label>
              </div>
            </section>
          </div>
        )}
      </section>

      {/* Aktionsleiste & Fortschritt */}
      <section className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-[#57606A] dark:text-[#8B949E] tabular-nums">
            <strong className="text-[#1F2328] dark:text-[#EAEEF2]">{items.length}</strong> Dateien
            geladen · <strong className="text-[#1F2328] dark:text-[#EAEEF2]">{selectedCount}</strong>{' '}
            ausgewählt ·{' '}
            <strong className="text-[#2E6B14] dark:text-[#9BE270]">{doneItems.length}</strong> fertig
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isConverting || selectedCount === 0}
              onClick={() => void handleStartConversion()}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
            >
              <SystemIcon name="start_rip" className="w-3.5 h-3.5" />
              <span>Ausgewählte konvertieren ({selectedCount})</span>
            </button>

            <button
              type="button"
              disabled={!isConverting}
              onClick={handleCancelConversion}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#DC2626] hover:bg-[#DC2626]/10 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
            >
              <SystemIcon name="stop_batch" className="w-3.5 h-3.5" />
              <span>Abbrechen</span>
            </button>

            <button
              type="button"
              disabled={doneItems.length === 0 || isBuildingZip}
              onClick={() => void handleDownloadAllZip()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-[#5BA632]/50 bg-[#5BA632]/10 hover:bg-[#5BA632]/20 text-[#2E6B14] dark:text-[#9BE270] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
            >
              <SystemIcon name="save_export" className="w-3.5 h-3.5" />
              <span>Alle als ZIP laden ({doneItems.length})</span>
            </button>

            <button
              type="button"
              disabled={items.length === 0}
              onClick={handleDownloadConverterScript}
              title="Bash-Skript für die lokale Konvertierung mit ffmpeg unter Linux Mint erzeugen"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
            >
              <SystemIcon name="save_cover" className="w-3.5 h-3.5" />
              <span>Skript (.sh)</span>
            </button>

            <button
              type="button"
              disabled={isConverting || doneItems.length === 0}
              onClick={handleClearFinished}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#57606A] dark:text-[#8B949E] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <SystemIcon name="clear_list" className="w-3.5 h-3.5" />
              <span>Erledigte entfernen</span>
            </button>

            <button
              type="button"
              disabled={isConverting || items.length === 0}
              onClick={handleClearAll}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#57606A] dark:text-[#8B949E] hover:text-[#DC2626] hover:border-[#DC2626]/50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <SystemIcon name="remove_item" className="w-3.5 h-3.5" />
              <span>Liste leeren</span>
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-[#57606A] dark:text-[#8B949E]">
            <span>
              Gesamtfortschritt · Zielformat: {targetFormat.toUpperCase()}
            </span>
            <span className="font-mono font-semibold tabular-nums text-[#1F2328] dark:text-[#EAEEF2]">
              {totalProgress}%
            </span>
          </div>
          <div className="h-2 w-full rounded bg-[#EAECEF] dark:bg-[#1C1F23] overflow-hidden">
            <div
              className="h-full bg-[#5BA632] dark:bg-[#69B53F] transition-[width] duration-150"
              style={{ width: `${totalProgress}%` }}
            />
          </div>
        </div>
      </section>

      {/* Dateiliste / Warteschlange */}
      <section
        aria-label="Importierte Audiodateien für die Konvertierung"
        onDragEnter={(e) => {
          if (isConverting) return;
          e.preventDefault();
          tableDragDepthRef.current += 1;
          setIsTableDragActive(true);
        }}
        onDragOver={(e) => {
          if (isConverting) return;
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
          if (isConverting) return;
          e.preventDefault();
          e.stopPropagation();
          rootDragDepthRef.current = 0;
          tableDragDepthRef.current = 0;
          setIsDragActive(false);
          setIsTableDragActive(false);
          const dropped = await collectFilesFromDataTransfer(e.dataTransfer);
          if (dropped.length > 0) {
            await ingestEntries(dropped, 'Drag & Drop (Tabelle)');
          }
        }}
        className={`bg-white dark:bg-[#25292E] border rounded-lg overflow-hidden transition-colors ${
          isTableDragActive || isDragActive
            ? 'border-[#5BA632] ring-2 ring-[#5BA632]/30 bg-[#5BA632]/5'
            : 'border-[#E1E4E8] dark:border-[#343A40]'
        }`}
      >
        {items.length === 0 ? (
          <div className="p-10 text-center space-y-2 text-xs text-[#57606A] dark:text-[#8B949E]">
            <div className="mx-auto w-10 h-10 rounded-full bg-[#F4F5F6] dark:bg-[#1C1F23] flex items-center justify-center text-[#5BA632] dark:text-[#69B53F]">
              <SystemIcon name="module_convert" className="w-5 h-5" />
            </div>
            <p className="text-sm font-medium text-[#1F2328] dark:text-[#EAEEF2]">
              Noch keine Audiodateien für die Konvertierung geladen
            </p>
            <p>
              Nutze oben „Dateien / Ordner importieren“ für Einzeldateien oder ganze Ordner bzw.
              ziehe Dateien und Unterordner direkt hier in die Tabelle.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 text-[11px] font-semibold text-[#57606A] dark:text-[#8B949E] divide-x divide-[#E1E4E8] dark:divide-[#343A40]">
                  <th className="py-2 px-2.5 w-9 text-center">
                    <input
                      ref={selectAllCheckboxRef}
                      type="checkbox"
                      checked={allSelected}
                      disabled={isConverting}
                      onChange={handleToggleSelectAll}
                      aria-label="Alle auswählen oder abwählen"
                      className="accent-[#5BA632] rounded cursor-pointer"
                    />
                  </th>
                  <th className="py-2 px-2.5">Datei / Rekursiver Pfad</th>
                  <th className="py-2 px-2.5">Metadaten (Interpret · Titel)</th>
                  <th className="py-2 px-2.5 w-28 text-center">Format</th>
                  <th className="py-2 px-2.5 w-24 text-right">Dauer / Größe</th>
                  <th className="py-2 px-2.5 w-64">Status &amp; Ausgabe</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E1E4E8] dark:divide-[#343A40] text-xs">
                {items.map((item) => {
                  const pct = Math.round(item.progress * 100);
                  const expectedOut = computeTargetRelativePath(
                    item,
                    targetFormat,
                    preserveStructure
                  );
                  return (
                    <tr
                      key={item.id}
                      className="hover:bg-[#F8F9FA] dark:hover:bg-[#2D333B]/60 divide-x divide-[#E1E4E8] dark:divide-[#343A40]"
                    >
                      <td className="px-2.5 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={item.selected}
                          disabled={isConverting}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setItems((prev) =>
                              prev.map((x) => (x.id === item.id ? { ...x, selected: checked } : x))
                            );
                          }}
                          className="accent-[#5BA632] rounded cursor-pointer"
                        />
                      </td>

                      <td className="px-2.5 py-2 max-w-[280px]">
                        <div
                          className="font-medium text-[#1F2328] dark:text-[#EAEEF2] truncate"
                          title={item.relativePath}
                        >
                          {item.file.name}
                        </div>
                        <div
                          className="text-[11px] font-mono text-[#57606A] dark:text-[#8B949E] truncate"
                          title={expectedOut}
                        >
                          {item.relDir ? `${item.relDir}/` : 'Einzeldatei'} → {expectedOut}
                        </div>
                      </td>

                      <td className="px-2.5 py-2 max-w-[220px]">
                        <div
                          className="text-[#1F2328] dark:text-[#EAEEF2] truncate"
                          title={item.title}
                        >
                          {item.title}
                        </div>
                        <div
                          className="text-[11px] italic text-[#57606A] dark:text-[#8B949E] truncate"
                          title={[item.artist, item.album].filter(Boolean).join(' — ')}
                        >
                          {[item.artist || 'Unbekannter Künstler', item.album]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </td>

                      <td className="px-2.5 py-2 text-center font-mono text-[11px] whitespace-nowrap">
                        <span className="text-[#57606A] dark:text-[#8B949E]">{item.sourceExt}</span>
                        <span className="mx-1 text-[#8C959F]">→</span>
                        <span className="font-semibold text-[#2E6B14] dark:text-[#9BE270]">
                          {targetFormat.toUpperCase()}
                        </span>
                      </td>

                      <td className="px-2.5 py-2 text-right font-mono tabular-nums text-[11px] text-[#57606A] dark:text-[#8B949E] whitespace-nowrap">
                        <div>{item.durationSeconds > 0 ? formatDuration(item.durationSeconds) : '—'}</div>
                        <div>{formatBytesReadable(item.sizeBytes)}</div>
                      </td>

                      <td className="px-2.5 py-2 min-w-[220px]">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 rounded bg-[#EAECEF] dark:bg-[#1C1F23] overflow-hidden">
                            <div
                              className={`h-full transition-[width] duration-150 ${
                                item.stage === 'error'
                                  ? 'bg-[#DC2626]'
                                  : 'bg-[#5BA632] dark:bg-[#69B53F]'
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="w-8 text-right font-mono tabular-nums text-[11px] text-[#1F2328] dark:text-[#EAEEF2] shrink-0">
                            {pct}%
                          </span>
                        </div>

                        <div className="mt-1 flex items-center justify-between gap-2">
                          <span
                            className={`text-[11px] truncate ${
                              item.stage === 'error'
                                ? 'text-[#DC2626] dark:text-[#F87171]'
                                : item.stage === 'done'
                                  ? 'text-[#2E6B14] dark:text-[#9BE270]'
                                  : 'text-[#57606A] dark:text-[#8B949E]'
                            }`}
                            title={item.statusMessage}
                          >
                            {item.statusMessage}
                          </span>

                          <div className="inline-flex items-center gap-1 shrink-0">
                            {item.stage === 'done' && item.convertedUrl && item.convertedFileName && (
                              <a
                                href={item.convertedUrl}
                                download={item.convertedFileName}
                                title={`${item.convertedFileName} herunterladen`}
                                className="p-0.5 rounded text-[#2E6B14] dark:text-[#9BE270] hover:bg-[#5BA632]/15"
                              >
                                <SystemIcon name="save_export" className="w-3.5 h-3.5" />
                              </a>
                            )}
                            {!isConverting && (
                              <button
                                type="button"
                                onClick={() => handleRemoveItem(item.id)}
                                title="Eintrag entfernen"
                                className="p-0.5 rounded text-[#656D76] hover:text-[#DC2626] hover:bg-[#DC2626]/10 cursor-pointer"
                              >
                                <SystemIcon name="remove_item" className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
