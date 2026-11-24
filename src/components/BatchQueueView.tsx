import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BatchJob, BatchStage } from '../types/mintrip';
import { formatDuration, formatIndexNumber } from '../utils/audioExportHelpers';
import { SystemIcon, SystemIconKey } from './SystemIcons';

interface BatchQueueViewProps {
  jobs: BatchJob[];
  isRunning: boolean;
  isPaused: boolean;
  embedded?: boolean;
  isLockedDuringRun?: boolean;
  onStartAll: () => void;
  onTogglePause: () => void;
  onCancelAll: () => void;
  onClearFinished: () => void;
  onRetryJob: (jobId: string) => void;
  onRemoveJob: (jobId: string) => void;
  onDropFilesToBatch: (files: FileList | File[]) => void;
}

interface CdBatchGroup {
  groupId: string;
  label: string;
  cdBadge: string;
  allJobs: BatchJob[];
  visibleJobs: BatchJob[];
  doneCount: number;
  errorCount: number;
  cancelledCount: number;
  activeCount: number;
  isCompleted: boolean;
  avgProgressPct: number;
  totalDurationSeconds: number;
  statusText: string;
}

const STAGE_LABEL: Record<BatchStage, { text: string; icon: SystemIconKey; colorClass: string }> = {
  queued: {
    text: 'Warteschlange',
    icon: 'batch_queue',
    colorClass: 'text-[#57606A] dark:text-[#8B949E]',
  },
  ripping: {
    text: 'cdparanoia Rip',
    icon: 'optical_drive',
    colorClass: 'text-[#D97706] dark:text-[#FBBF24]',
  },
  encoding_flac: {
    text: 'FLAC-Export',
    icon: 'audio_track',
    colorClass: 'text-[#D97706] dark:text-[#FBBF24]',
  },
  encoding_mp3: {
    text: 'LAME MP3-Export',
    icon: 'audio_track',
    colorClass: 'text-[#D97706] dark:text-[#FBBF24]',
  },
  tagging: {
    text: 'Tags & Cover',
    icon: 'cover_image',
    colorClass: 'text-[#5BA632] dark:text-[#69B53F]',
  },
  done: {
    text: 'Abgeschlossen',
    icon: 'status_ok',
    colorClass: 'text-[#16A34A] dark:text-[#4ADE80]',
  },
  error: {
    text: 'Fehler',
    icon: 'status_error',
    colorClass: 'text-[#DC2626] dark:text-[#F87171]',
  },
  cancelled: {
    text: 'Abgebrochen',
    icon: 'status_warn',
    colorClass: 'text-[#57606A] dark:text-[#8B949E]',
  },
};

function resolveJobGroupKey(job: BatchJob): string {
  if (job.batchGroupId) return job.batchGroupId;
  const disc = Math.max(1, job.discNumber || 1);
  return `${job.albumArtist || 'Unbekannt'}::${job.albumTitle || 'Album'}::disc${disc}`;
}

export function BatchQueueView({
  jobs,
  isRunning,
  isPaused,
  embedded = false,
  isLockedDuringRun,
  onStartAll,
  onTogglePause,
  onCancelAll,
  onClearFinished,
  onRetryJob,
  onRemoveJob,
  onDropFilesToBatch,
}: BatchQueueViewProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [stageFilter, setStageFilter] = useState<'all' | 'active' | 'done'>('all');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const prevCompletedRef = useRef<Record<string, boolean>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeLock = isLockedDuringRun ?? (isRunning && !isPaused);

  const doneCount = jobs.filter((j) => j.stage === 'done').length;
  const activeCount = jobs.filter((j) =>
    ['ripping', 'encoding_flac', 'encoding_mp3', 'tagging'].includes(j.stage)
  ).length;
  const queuedCount = jobs.filter((j) => j.stage === 'queued').length;

  const totalProgress =
    jobs.length === 0
      ? 0
      : Math.round((jobs.reduce((sum, j) => sum + j.progress, 0) / jobs.length) * 100);

  const cdGroups = useMemo<CdBatchGroup[]>(() => {
    const order: string[] = [];
    const byKey = new Map<string, BatchJob[]>();
    for (const job of jobs) {
      const key = resolveJobGroupKey(job);
      if (!byKey.has(key)) {
        byKey.set(key, []);
        order.push(key);
      }
      byKey.get(key)!.push(job);
    }

    const result: CdBatchGroup[] = [];
    // Umgekehrte Reihenfolge: zuletzt eingereihte / gerippte CD immer ganz oben anzeigen
    for (const key of [...order].reverse()) {
      const allGroupJobs = byKey.get(key) || [];
      const visibleGroupJobs = allGroupJobs.filter((j) => {
        if (stageFilter === 'done') return j.stage === 'done';
        if (stageFilter === 'active') return j.stage !== 'done' && j.stage !== 'cancelled';
        return true;
      });
      if (visibleGroupJobs.length === 0) continue;

      const sample = allGroupJobs[0];
      const total = allGroupJobs.length;
      const gDone = allGroupJobs.filter((j) => j.stage === 'done').length;
      const gErr = allGroupJobs.filter((j) => j.stage === 'error').length;
      const gCancel = allGroupJobs.filter((j) => j.stage === 'cancelled').length;
      const gActive = allGroupJobs.filter((j) =>
        ['ripping', 'encoding_flac', 'encoding_mp3', 'tagging'].includes(j.stage)
      ).length;
      // Nur vollständig fertiggestellte Alben (alle Titel 'done') gelten als abgeschlossen zum Einklappen
      const isCompleted = allGroupJobs.length > 0 && allGroupJobs.every((j) => j.stage === 'done');
      const allStopped =
        allGroupJobs.length > 0 &&
        allGroupJobs.every((j) => j.stage === 'done' || j.stage === 'error' || j.stage === 'cancelled');
      const avgProgressPct = Math.round(
        (allGroupJobs.reduce((sum, j) => sum + Math.max(0, Math.min(1, j.progress)), 0) /
          Math.max(1, total)) *
          100
      );
      const totalDurationSeconds = allGroupJobs.reduce(
        (sum, j) => sum + Math.max(0, j.durationSeconds || 0),
        0
      );
      const discNum = Math.max(1, sample.discNumber || 1);
      const totalDiscs = Math.max(1, sample.totalDiscs || 1, discNum);
      const cdBadge = `CD ${discNum}/${totalDiscs}`;
      const albumArtist = (sample.albumArtist || '').trim();
      const albumName = (sample.albumTitle || sample.batchGroupLabel || 'Unbekanntes Album').trim();
      const label = albumArtist
        ? `${albumArtist} - ${albumName} (${total} Titel)`
        : `${albumName} (${total} Titel)`;

      let statusText: string;
      if (isCompleted) {
        statusText = `Abgeschlossen (${gDone}/${total} Titel)`;
      } else if (allStopped) {
        if (gErr > 0) statusText = `Beendet mit ${gErr} Fehler(n) (${gDone}/${total})`;
        else if (gCancel === total) statusText = `Abgebrochen (${total} Titel)`;
        else statusText = `Unvollständig (${gDone}/${total} fertig)`;
      } else if (gActive > 0) {
        statusText = `Rippt / Konvertiert (${gDone}/${total} fertig)`;
      } else {
        statusText = `Warteschlange (${total} Titel)`;
      }

      result.push({
        groupId: key,
        label,
        cdBadge,
        allJobs: allGroupJobs,
        visibleJobs: visibleGroupJobs,
        doneCount: gDone,
        errorCount: gErr,
        cancelledCount: gCancel,
        activeCount: gActive,
        isCompleted,
        avgProgressPct,
        totalDurationSeconds,
        statusText,
      });
    }
    return result;
  }, [jobs, stageFilter]);

  // Default während des Ripps: ausgeklappt. Nur vollständig fertiggestellte Alben (alle Titel 'done') werden automatisch eingeklappt.
  // Manuelles Auf-/Zuklappen bleibt jederzeit möglich.
  useEffect(() => {
    const allGroupsMap = new Map<string, boolean>();
    for (const job of jobs) {
      const key = resolveJobGroupKey(job);
      const jobDone = job.stage === 'done';
      if (!allGroupsMap.has(key)) {
        allGroupsMap.set(key, jobDone);
      } else if (!jobDone) {
        allGroupsMap.set(key, false);
      }
    }

    const prevMap = prevCompletedRef.current;
    const nextPrevMap: Record<string, boolean> = {};
    const updates: Record<string, boolean> = {};
    let hasUpdates = false;

    for (const [gid, isComp] of allGroupsMap.entries()) {
      nextPrevMap[gid] = isComp;
      const hadPrev = Object.prototype.hasOwnProperty.call(prevMap, gid);
      const wasComp = Boolean(prevMap[gid]);
      if (!hadPrev) {
        // Neue CD-Gruppe: ausgeklappt wenn laufend/wartend, eingeklappt wenn bereits fertig
        updates[gid] = !isComp;
        hasUpdates = true;
      } else if (!wasComp && isComp) {
        // Rip abgeschlossen -> automatisch einklappen
        updates[gid] = false;
        hasUpdates = true;
      } else if (wasComp && !isComp) {
        // Auftrag erneut gestartet -> wieder ausklappen
        updates[gid] = true;
        hasUpdates = true;
      }
    }

    prevCompletedRef.current = nextPrevMap;
    if (hasUpdates) {
      setExpandedGroups((prev) => ({ ...prev, ...updates }));
    }
  }, [jobs]);

  const toggleGroupExpanded = (groupId: string, defaultExpanded: boolean) => {
    setExpandedGroups((prev) => {
      const current = prev[groupId] ?? defaultExpanded;
      return { ...prev, [groupId]: !current };
    });
  };

  return (
    <div className={embedded ? 'space-y-4' : 'space-y-6'}>
      {/* Zusammenfassung & Steuerung */}
      <section
        className={
          embedded
            ? 'space-y-3'
            : 'bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg p-5 space-y-4'
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          {!embedded ? (
            <div className="space-y-1">
              <h1 className="text-lg font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                Stapelverarbeitung & Parallele Konvertierung
              </h1>
              <p className="text-xs text-[#57606A] dark:text-[#8B949E] tabular-nums">
                {jobs.length} Aufträge gesamt · {activeCount} aktiv · {queuedCount} wartend · {doneCount} fertig
              </p>
            </div>
          ) : (
            <p className="text-xs text-[#57606A] dark:text-[#8B949E] tabular-nums">
              {jobs.length} Aufträge gesamt · {activeCount} aktiv · {queuedCount} wartend · {doneCount} fertig
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onStartAll}
              disabled={activeLock || jobs.length === 0 || (isRunning && !isPaused)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              <SystemIcon name="start_rip" className="w-3.5 h-3.5" />
              <span>Warteschlange starten</span>
            </button>

            <button
              type="button"
              onClick={onTogglePause}
              disabled={!isRunning}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap cursor-pointer"
            >
              <SystemIcon name="pause_batch" className="w-3.5 h-3.5" />
              <span>{isPaused ? 'Stapelverarbeitung fortsetzen' : 'Stapelverarbeitung pausieren'}</span>
            </button>

            <button
              type="button"
              onClick={onCancelAll}
              disabled={!isRunning}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#DC2626] hover:bg-[#DC2626]/10 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap cursor-pointer"
            >
              <SystemIcon name="stop_batch" className="w-3.5 h-3.5" />
              <span>Abbrechen</span>
            </button>

            <button
              type="button"
              onClick={onClearFinished}
              disabled={activeLock || doneCount === 0}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#57606A] dark:text-[#8B949E] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              <SystemIcon name="clear_list" className="w-3.5 h-3.5" />
              <span>Erledigte leeren</span>
            </button>
          </div>
        </div>

        {/* Gesamt-Fortschritt */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-[#57606A] dark:text-[#8B949E]">
            <span>
              Pipeline: Serielles Laufwerks-Lock (cdparanoia) + FLAC- oder MP3-Konvertierung
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

      {/* Drag-and-Drop-Dropzone für Batch-Konvertierung */}
      <section
        onDragOver={(e) => {
          if (activeLock) return;
          e.preventDefault();
          setIsDragActive(true);
        }}
        onDragLeave={() => setIsDragActive(false)}
        onDrop={(e) => {
          if (activeLock) return;
          e.preventDefault();
          setIsDragActive(false);
          if (e.dataTransfer.files?.length) {
            onDropFilesToBatch(e.dataTransfer.files);
          }
        }}
        onClick={() => {
          if (!activeLock) fileInputRef.current?.click();
        }}
        role="button"
        aria-disabled={activeLock}
        tabIndex={activeLock ? -1 : 0}
        onKeyDown={(e) => {
          if (activeLock) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`border border-dashed rounded-lg ${embedded ? 'p-4' : 'p-6'} text-center transition-colors ${
          activeLock
            ? 'opacity-50 pointer-events-none border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23]/60'
            : isDragActive
              ? 'border-[#5BA632] bg-[#5BA632]/10 cursor-pointer'
              : 'border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] hover:border-[#5BA632] cursor-pointer'
        }`}
      >
        <div className="flex flex-col items-center gap-2">
          <SystemIcon name="add_files" className="w-6 h-6 text-[#5BA632] dark:text-[#69B53F]" />
          <p className="text-sm font-medium text-[#1F2328] dark:text-[#EAEEF2]">
            WAV-, FLAC- oder AIFF-Dateien für die Stapelkonvertierung hierher ziehen
          </p>
          <p className="text-xs text-[#57606A] dark:text-[#8B949E]">
            Unterstützt Mehrfachauswahl · Automatische Dauer- und Dateinamen-Erkennung · Direktes Tagging mit Album-Cover
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          disabled={activeLock}
          accept=".wav,.flac,.mp3,.mp2,.ogg,.aiff,.aif,.aifc,.dsf,.tta,.opus,.wv,.m4a,audio/*"
          className="hidden"
          onChange={(e) => {
            if (!activeLock && e.target.files?.length) {
              onDropFilesToBatch(e.target.files);
              e.target.value = '';
            }
          }}
        />
      </section>

      {/* Filter & gruppierte CD-Warteschlangen-Tabelle */}
      <section className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#E1E4E8] dark:border-[#343A40] flex items-center justify-between gap-4">
          <div className="flex items-center gap-1 p-0.5 rounded bg-[#F4F5F6] dark:bg-[#1C1F23]">
            {[
              { id: 'all', label: `Alle (${jobs.length})` },
              { id: 'active', label: `Ausstehend / Aktiv (${jobs.length - doneCount})` },
              { id: 'done', label: `Fertig (${doneCount})` },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                disabled={activeLock}
                onClick={() => setStageFilter(tab.id as 'all' | 'active' | 'done')}
                className={`px-2.5 py-0.5 text-xs font-medium rounded transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${
                  stageFilter === tab.id
                    ? 'bg-white dark:bg-[#2D333B] text-[#1F2328] dark:text-[#EAEEF2] shadow-xs'
                    : 'text-[#57606A] dark:text-[#8B949E] hover:text-[#1F2328] dark:hover:text-[#EAEEF2]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {cdGroups.length > 0 && (
            <span className="text-[11px] text-[#57606A] dark:text-[#8B949E] tabular-nums">
              {cdGroups.length} {cdGroups.length === 1 ? 'CD-Gruppe' : 'CD-Gruppen'}
            </span>
          )}
        </div>

        {cdGroups.length === 0 ? (
          <div className="p-10 text-center space-y-2 text-xs text-[#57606A] dark:text-[#8B949E]">
            <p className="text-sm font-medium text-[#1F2328] dark:text-[#EAEEF2]">
              Keine Aufträge in dieser Ansicht
            </p>
            <p>
              Wähle im Tab „Metadaten & CD“ Titel aus und klicke auf „Rippen“ oder ziehe Audiodateien in die Dropzone oben.
            </p>
          </div>
        ) : (
          <div className="overflow-x-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 text-[11px] font-semibold text-[#57606A] dark:text-[#8B949E] divide-x divide-[#E1E4E8] dark:divide-[#343A40]">
                  <th className="py-2 px-2.5 w-24 text-center">Nr.</th>
                  <th className="py-2 px-2.5">Titel</th>
                  <th className="py-2 px-2.5 w-16 text-right">Länge</th>
                  <th className="py-2 px-2.5 w-60">Fortschritt / Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E1E4E8] dark:divide-[#343A40] text-xs">
                {cdGroups.map((group) => {
                  const isExpanded = expandedGroups[group.groupId] ?? !group.isCompleted;
                  return (
                    <React.Fragment key={group.groupId}>
                      {/* Auf-/Zuklappbarer CD-Gruppenkopf */}
                      <tr
                        onClick={() => toggleGroupExpanded(group.groupId, !group.isCompleted)}
                        role="button"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleGroupExpanded(group.groupId, !group.isCompleted);
                          }
                        }}
                        title={
                          isExpanded
                            ? 'CD-Gruppe einklappen'
                            : 'CD-Gruppe ausklappen, um alle Titel anzuzeigen'
                        }
                        className="bg-[#F4F6F8] dark:bg-[#1E2328] hover:bg-[#EAEFF3] dark:hover:bg-[#272D34] cursor-pointer select-none divide-x divide-[#E1E4E8] dark:divide-[#343A40] transition-colors"
                      >
                        <td className="px-2 py-2 text-center font-mono text-[11px] font-semibold text-[#1F2328] dark:text-[#EAEEF2] whitespace-nowrap">
                          <span
                            aria-hidden="true"
                            className="inline-block w-3.5 text-left text-[#57606A] dark:text-[#8B949E]"
                          >
                            {isExpanded ? '▾' : '▸'}
                          </span>
                          <span>{group.cdBadge}</span>
                        </td>
                        <td className="px-2.5 py-2 max-w-[420px]">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <SystemIcon
                              name="optical_drive"
                              className="w-3.5 h-3.5 text-[#5BA632] dark:text-[#69B53F] shrink-0"
                            />
                            <span
                              className="font-semibold text-[#1F2328] dark:text-[#EAEEF2] truncate"
                              title={group.label}
                            >
                              {group.label}
                            </span>
                          </div>
                          <div className="text-[11px] text-[#57606A] dark:text-[#8B949E] tabular-nums">
                            {group.doneCount}/{group.allJobs.length} Titel fertig
                            {group.errorCount > 0 ? ` · ${group.errorCount} Fehler` : ''}
                            {group.cancelledCount > 0 ? ` · ${group.cancelledCount} abgebrochen` : ''}
                          </div>
                        </td>
                        <td className="px-2.5 py-2 text-right font-mono tabular-nums text-[11px] font-medium text-[#57606A] dark:text-[#8B949E]">
                          {formatDuration(group.totalDurationSeconds)}
                        </td>
                        <td className="px-2.5 py-2 min-w-[200px]">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 rounded bg-[#DDE2E7] dark:bg-[#14171A] overflow-hidden">
                              <div
                                className="h-full bg-[#5BA632] dark:bg-[#69B53F] transition-[width] duration-150"
                                style={{ width: `${group.avgProgressPct}%` }}
                              />
                            </div>
                            <span className="w-8 text-right font-mono tabular-nums text-[11px] font-semibold text-[#1F2328] dark:text-[#EAEEF2] shrink-0">
                              {group.avgProgressPct}%
                            </span>
                          </div>
                          <div
                            className="mt-0.5 text-[11px] italic text-[#57606A] dark:text-[#8B949E] truncate"
                            title={group.statusText}
                          >
                            {group.statusText}
                          </div>
                        </td>
                      </tr>

                      {/* Titelzeilen der CD-Gruppe (wenn ausgeklappt) */}
                      {isExpanded &&
                        group.visibleJobs.map((job) => {
                          const stageMeta = STAGE_LABEL[job.stage];
                          const pct = Math.round(job.progress * 100);
                          return (
                            <tr
                              key={job.jobId}
                              className="h-12 hover:bg-[#F8F9FA] dark:hover:bg-[#2D333B]/60 divide-x divide-[#E1E4E8] dark:divide-[#343A40]"
                            >
                              <td className="pl-5 pr-2 text-center font-mono tabular-nums text-[#57606A] dark:text-[#8B949E]">
                                {formatIndexNumber(job.trackNumber, group.allJobs.length)}
                              </td>
                              <td className="px-2.5 py-1.5 max-w-[420px]">
                                <div
                                  className="font-medium text-[#1F2328] dark:text-[#EAEEF2] truncate"
                                  title={job.trackTitle}
                                >
                                  {job.trackTitle}
                                </div>
                                <div
                                  className="text-[11px] italic text-[#57606A] dark:text-[#8B949E] truncate"
                                  title={job.trackArtist || job.albumArtist}
                                >
                                  {job.trackArtist || job.albumArtist}
                                </div>
                              </td>
                              <td className="px-2.5 text-right font-mono tabular-nums text-[#57606A] dark:text-[#8B949E]">
                                {formatDuration(job.durationSeconds)}
                              </td>
                              <td className="px-2.5 py-1.5 min-w-[200px]">
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 h-2 rounded bg-[#EAECEF] dark:bg-[#1C1F23] overflow-hidden">
                                    <div
                                      className="h-full bg-[#5BA632] dark:bg-[#69B53F] transition-[width] duration-150"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </div>
                                  <span className="w-8 text-right font-mono tabular-nums text-[11px] text-[#1F2328] dark:text-[#EAEEF2] shrink-0">
                                    {pct}%
                                  </span>
                                </div>
                                <div className="mt-0.5 flex items-center justify-between gap-1.5 min-w-0">
                                  <div
                                    className="text-[11px] italic text-[#57606A] dark:text-[#8B949E] truncate min-w-0"
                                    title={`${stageMeta.text}: ${job.statusMessage}`}
                                  >
                                    {stageMeta.text} · {job.statusMessage}
                                  </div>
                                  {!activeLock && (
                                    <div className="inline-flex items-center gap-0.5 shrink-0">
                                      {job.stage === 'done' && job.convertedUrl && (
                                        <a
                                          href={job.convertedUrl}
                                          download={job.convertedFileName || `${job.trackTitle || 'track'}.flac`}
                                          title={`Fertige FLAC-Datei herunterladen (${job.convertedFileName || 'track.flac'})`}
                                          className="p-0.5 rounded text-[#5BA632] hover:bg-[#5BA632]/15"
                                        >
                                          <SystemIcon name="save_cover" className="w-3 h-3" />
                                        </a>
                                      )}
                                      {(job.stage === 'cancelled' || job.stage === 'error') && (
                                        <button
                                          type="button"
                                          onClick={() => onRetryJob(job.jobId)}
                                          title="Erneut einreihen"
                                          className="p-0.5 rounded text-[#5BA632] hover:bg-[#5BA632]/10"
                                        >
                                          <SystemIcon name="refresh_disc" className="w-3 h-3" />
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => onRemoveJob(job.jobId)}
                                        title="Auftrag entfernen"
                                        className="p-0.5 rounded text-[#656D76] hover:text-[#DC2626] hover:bg-[#DC2626]/10"
                                      >
                                        <SystemIcon name="remove_item" className="w-3 h-3" />
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                    </React.Fragment>
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
