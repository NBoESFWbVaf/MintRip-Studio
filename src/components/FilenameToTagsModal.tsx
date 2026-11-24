import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlbumMetadata } from '../types/mintrip';
import {
  applyFilenameMaskToAlbum,
  DEFAULT_FILENAME_MASK_OPTIONS,
  DEFAULT_FILENAME_MASKS,
  EASYTAG_PLACEHOLDERS,
  FilenameMaskOptions,
  loadSavedFilenameMasks,
  previewFilenameMaskOnAlbum,
  saveCustomFilenameMasks,
} from '../utils/filenameTagParser';
import { SystemIcon } from './SystemIcons';

interface FilenameToTagsModalProps {
  isOpen: boolean;
  album: AlbumMetadata;
  fallbackFolder?: string;
  onClose: () => void;
  onApply: (updatedAlbum: AlbumMetadata, summaryLog: string) => void;
}

export function FilenameToTagsModal({
  isOpen,
  album,
  fallbackFolder = '',
  onClose,
  onApply,
}: FilenameToTagsModalProps) {
  const [savedMasks, setSavedMasks] = useState<string[]>(() => loadSavedFilenameMasks());
  const [mask, setMask] = useState<string>(() => loadSavedFilenameMasks()[0] || '%n - %t');
  const [options, setOptions] = useState<FilenameMaskOptions>(DEFAULT_FILENAME_MASK_OPTIONS);
  const maskInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  const effectiveOptions = useMemo<FilenameMaskOptions>(
    () => ({ ...options, onlySelected: true }),
    [options]
  );

  const selectedTrackCount = useMemo(
    () => album.tracks.filter((t) => t.selected).length,
    [album.tracks]
  );

  const previewRows = useMemo(
    () =>
      isOpen ? previewFilenameMaskOnAlbum(album, mask, effectiveOptions, fallbackFolder) : [],
    [isOpen, album, mask, effectiveOptions, fallbackFolder]
  );

  const matchedCount = useMemo(
    () => previewRows.filter((r) => r.matched).length,
    [previewRows]
  );

  if (!isOpen) return null;

  const trimmedMask = mask.trim();
  const isCustomSavedMask =
    trimmedMask.length > 0 &&
    savedMasks.includes(trimmedMask) &&
    !DEFAULT_FILENAME_MASKS.includes(trimmedMask);

  const handleInsertPlaceholder = (token: string) => {
    const input = maskInputRef.current;
    if (!input) {
      setMask((prev) => prev + token);
      return;
    }
    const start = input.selectionStart ?? mask.length;
    const end = input.selectionEnd ?? mask.length;
    const next = mask.slice(0, start) + token + mask.slice(end);
    setMask(next);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const handleSaveMask = () => {
    if (!trimmedMask || savedMasks.includes(trimmedMask)) return;
    const next = [trimmedMask, ...savedMasks];
    setSavedMasks(next);
    saveCustomFilenameMasks(next);
  };

  const handleDeleteMask = () => {
    if (!isCustomSavedMask) return;
    const next = savedMasks.filter((m) => m !== trimmedMask);
    setSavedMasks(next);
    saveCustomFilenameMasks(next);
    setMask(next[0] || '%n - %t');
  };

  const handleApply = () => {
    const result = applyFilenameMaskToAlbum(album, mask, effectiveOptions, fallbackFolder);
    const fieldsText =
      result.touchedFields.length > 0 ? result.touchedFields.join(', ') : 'keine Änderungen';
    onApply(
      result.updatedAlbum,
      `[Dateiname → Tags] Maske „${trimmedMask}“ auf ${result.matchedCount}/${result.totalChecked} ausgewählte(n) Titel angewendet (Felder: ${fieldsText}).`
    );
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="filename-to-tags-title"
      className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[1px] flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-5xl max-h-[88vh] flex flex-col rounded-lg border border-[#D0D7DE] dark:border-[#343A40] bg-white dark:bg-[#25292E] shadow-2xl overflow-hidden">
        {/* Kopfleiste */}
        <div className="px-4 py-3 border-b border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded border border-[#5BA632]/40 bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] flex items-center justify-center shrink-0">
              <SystemIcon name="module_tag" className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2
                id="filename-to-tags-title"
                className="text-sm font-bold text-[#1F2328] dark:text-[#EAEEF2] truncate"
              >
                Dateiname zu Tags — EasyTAG-Maskeneditor
              </h2>
              <p className="text-[11px] text-[#57606A] dark:text-[#8B949E] truncate">
                Extrahiert Metadaten aus Dateinamen und übergeordneten Ordnernamen (mit „/“) · Live-Vorschau
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] cursor-pointer"
          >
            Schließen
          </button>
        </div>

        {/* Inhalt */}
        <div className="p-4 space-y-3.5 overflow-y-auto flex-1">
          {/* Masken-Editor & Vorlagen */}
          <div className="rounded-md border border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 p-3 space-y-2.5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              <div className="flex items-center gap-2">
                <label
                  htmlFor="easytag-preset-select"
                  className="text-xs font-semibold text-[#57606A] dark:text-[#8B949E] shrink-0 w-16"
                >
                  Vorlage:
                </label>
                <select
                  id="easytag-preset-select"
                  value={savedMasks.includes(trimmedMask) ? trimmedMask : ''}
                  onChange={(e) => {
                    if (e.target.value) setMask(e.target.value);
                  }}
                  className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                >
                  {!savedMasks.includes(trimmedMask) && (
                    <option value="">Benutzerdefinierte Maske…</option>
                  )}
                  {savedMasks.map((preset) => (
                    <option key={preset} value={preset}>
                      {preset}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!trimmedMask || savedMasks.includes(trimmedMask)}
                  onClick={handleSaveMask}
                  title="Aktuelle Maske als Vorlage speichern"
                  className="px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] disabled:opacity-45 whitespace-nowrap cursor-pointer"
                >
                  Speichern
                </button>
                <button
                  type="button"
                  disabled={!isCustomSavedMask}
                  onClick={handleDeleteMask}
                  title="Benutzerdefinierte Vorlage entfernen"
                  className="px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#DC2626] dark:text-[#F87171] hover:border-[#DC2626] disabled:opacity-40 whitespace-nowrap cursor-pointer"
                >
                  Entfernen
                </button>
              </div>

              <div className="flex items-center gap-2">
                <label
                  htmlFor="easytag-mask-input"
                  className="text-xs font-semibold text-[#57606A] dark:text-[#8B949E] shrink-0 w-14"
                >
                  Maske:
                </label>
                <input
                  id="easytag-mask-input"
                  ref={maskInputRef}
                  type="text"
                  value={mask}
                  onChange={(e) => setMask(e.target.value)}
                  placeholder="z. B. %a/%y - %b/%n - %t"
                  className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-mono rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
                />
                <button
                  type="button"
                  onClick={() => {
                    setMask('');
                    maskInputRef.current?.focus();
                  }}
                  className="px-2.5 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#1C1F23] text-[#57606A] dark:text-[#8B949E] hover:text-[#1F2328] dark:hover:text-[#EAEEF2] whitespace-nowrap cursor-pointer"
                >
                  Leeren
                </button>
              </div>
            </div>

            {/* Klickbare EasyTAG-Platzhalter */}
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold text-[#57606A] dark:text-[#8B949E]">
                Platzhalter (Klick fügt an Cursor-Position ein):
              </div>
              <div className="flex flex-wrap gap-1.5">
                {EASYTAG_PLACEHOLDERS.map((ph) => (
                  <button
                    key={ph.code}
                    type="button"
                    title={`${ph.code}: ${ph.description}`}
                    onClick={() => handleInsertPlaceholder(ph.code)}
                    className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:border-[#5BA632] hover:bg-[#5BA632]/10 transition-colors cursor-pointer"
                  >
                    <code className="font-mono font-bold text-[#2E6B14] dark:text-[#9BE270]">
                      {ph.code}
                    </code>
                    <span>{ph.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Scanner-Optionen */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 pt-1 border-t border-[#E1E4E8] dark:border-[#343A40] text-xs text-[#1F2328] dark:text-[#EAEEF2]">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.replaceUnderscores}
                  onChange={(e) =>
                    setOptions((prev) => ({ ...prev, replaceUnderscores: e.target.checked }))
                  }
                  className="accent-[#5BA632]"
                />
                <span>Unterstriche (_) &amp; %20 → Leerzeichen</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.cleanSpaces}
                  onChange={(e) =>
                    setOptions((prev) => ({ ...prev, cleanSpaces: e.target.checked }))
                  }
                  className="accent-[#5BA632]"
                />
                <span>Mehrfache Leerzeichen bereinigen</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.onlyEmptyFields}
                  onChange={(e) =>
                    setOptions((prev) => ({ ...prev, onlyEmptyFields: e.target.checked }))
                  }
                  className="accent-[#5BA632]"
                />
                <span>Nur leere Tag-Felder füllen</span>
              </label>
              <span className="ml-auto text-[11px] font-medium text-[#57606A] dark:text-[#8B949E]">
                Nur per Checkbox ausgewählte Titel ({selectedTrackCount} / {album.tracks.length} aktiv)
              </span>
            </div>
          </div>

          {/* Live-Vorschau */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
                Live-Vorschau der extrahierten Tags (ausgewählte Titel)
              </span>
              <span className="font-mono tabular-nums text-[#57606A] dark:text-[#8B949E]">
                {album.tracks.length === 0
                  ? 'Keine Titel geladen'
                  : previewRows.length === 0
                    ? 'Keine Titel per Checkbox ausgewählt'
                    : `${matchedCount} von ${previewRows.length} ausgewählten Titel(n) passen zur Maske`}
              </span>
            </div>

            <div className="border border-[#E1E4E8] dark:border-[#343A40] rounded-md overflow-auto max-h-[300px]">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-[#F8F9FA] dark:bg-[#1C1F23] border-b border-[#E1E4E8] dark:border-[#343A40] text-[11px] font-semibold uppercase tracking-wide text-[#57606A] dark:text-[#8B949E]">
                  <tr>
                    <th className="py-2 px-2.5 w-24">Status</th>
                    <th className="py-2 px-2.5">Dateiname / Pfad</th>
                    <th className="py-2 px-2 w-12">CD</th>
                    <th className="py-2 px-2 w-12">Nr.</th>
                    <th className="py-2 px-2.5">Titel</th>
                    <th className="py-2 px-2.5">Interpret</th>
                    <th className="py-2 px-2.5">Album</th>
                    <th className="py-2 px-2 w-14">Jahr</th>
                    <th className="py-2 px-2.5">Genre / Weitere</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E1E4E8] dark:divide-[#343A40]">
                  {previewRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={9}
                        className="py-8 px-4 text-center text-xs text-[#57606A] dark:text-[#8B949E]"
                      >
                        {album.tracks.length === 0
                          ? 'Keine Titel vorhanden. Bitte zuerst über „Album-Ordner importieren“ Audiodateien laden.'
                          : 'Keine Titel per Checkbox ausgewählt. Bitte aktivieren Sie zuerst die gewünschten Titel in der Trackliste.'}
                      </td>
                    </tr>
                  ) : (
                    previewRows.map((row) => {
                      const ext = row.extracted;
                      const extras: string[] = [];
                      if (ext.g) extras.push(ext.g);
                      if (ext.o) extras.push(`Album-Int.: ${ext.o}`);
                      if (ext.p) extras.push(`Komp.: ${ext.p}`);
                      if (ext.c) extras.push(`Komm.: ${ext.c}`);
                      if (ext.l) extras.push(`Gesamt: ${ext.l}`);

                      return (
                        <tr
                          key={row.track.id}
                          className="hover:bg-[#F4F5F6]/70 dark:hover:bg-[#1C1F23]/60"
                        >
                          <td className="py-1.5 px-2.5 whitespace-nowrap font-medium">
                            {row.matched ? (
                              <span className="text-[#16A34A] dark:text-[#69B53F]">✓ Treffer</span>
                            ) : (
                              <span
                                className="text-[#DC2626] dark:text-[#F87171]"
                                title={row.reason}
                              >
                                ✕ Kein Treffer
                              </span>
                            )}
                          </td>
                          <td
                            className="py-1.5 px-2.5 font-mono text-[11px] text-[#57606A] dark:text-[#8B949E] max-w-[240px] truncate"
                            title={row.sourceDisplay}
                          >
                            {row.sourceDisplay}
                          </td>
                          <td className="py-1.5 px-2 font-mono tabular-nums text-[#1F2328] dark:text-[#EAEEF2]">
                            {ext.d || '—'}
                          </td>
                          <td className="py-1.5 px-2 font-mono tabular-nums text-[#1F2328] dark:text-[#EAEEF2]">
                            {ext.n || '—'}
                          </td>
                          <td className="py-1.5 px-2.5 font-medium text-[#1F2328] dark:text-[#EAEEF2] max-w-[180px] truncate">
                            {ext.t || '—'}
                          </td>
                          <td className="py-1.5 px-2.5 text-[#1F2328] dark:text-[#EAEEF2] max-w-[150px] truncate">
                            {ext.a || '—'}
                          </td>
                          <td className="py-1.5 px-2.5 text-[#1F2328] dark:text-[#EAEEF2] max-w-[140px] truncate">
                            {ext.b || '—'}
                          </td>
                          <td className="py-1.5 px-2 font-mono tabular-nums text-[#1F2328] dark:text-[#EAEEF2]">
                            {ext.y || '—'}
                          </td>
                          <td className="py-1.5 px-2.5 text-[#57606A] dark:text-[#8B949E] max-w-[160px] truncate">
                            {extras.length > 0 ? extras.join(' · ') : '—'}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Fußleiste */}
        <div className="px-4 py-3 border-t border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23] flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] bg-white dark:bg-[#25292E] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B] cursor-pointer"
          >
            Abbrechen
          </button>
          <button
            type="button"
            disabled={matchedCount === 0}
            onClick={handleApply}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white disabled:opacity-45 transition-colors cursor-pointer"
          >
            <SystemIcon name="module_tag" className="w-3.5 h-3.5 text-white" />
            <span>Tags übernehmen ({matchedCount})</span>
          </button>
        </div>
      </div>
    </div>
  );
}
