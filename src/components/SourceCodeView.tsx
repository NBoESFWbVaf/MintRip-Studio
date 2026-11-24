import React, { useState } from 'react';
import { PythonProjectFile } from '../types/mintrip';
import { SystemIcon } from './SystemIcons';

interface SourceCodeViewProps {
  files: PythonProjectFile[];
  isLoading: boolean;
  error: string | null;
}

export function SourceCodeView({ files, isLoading, error }: SourceCodeViewProps) {
  const [selectedPath, setSelectedPath] = useState<string>('mintrip/cd_reader.py');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const activeFile = files.find((f) => f.path === selectedPath) || files[0] || null;

  const handleCopy = async () => {
    if (!activeFile) return;
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopiedPath(activeFile.path);
      setTimeout(() => setCopiedPath(null), 1800);
    } catch {
      // Clipboard API fallback omitted
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
            Python & GTK3 Projekt für Linux Mint
          </h1>
          <p className="text-xs text-[#57606A] dark:text-[#8B949E]">
            Vollständige Implementierung mit PyCdio, GTK 3.0 (klassisches Cinnamon-Layout), cdparanoia, CDDB, MusicBrainz, Cover Art Archive, FLAC/LAME-Export, Drag-and-Drop und Systemthema-Erkennung.
          </p>
        </div>

        <a
          href="/api/python-project/download"
          download="mintrip-linux-mint.zip"
          className="inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-semibold rounded bg-[#5BA632] hover:bg-[#4E922A] text-white transition-colors whitespace-nowrap"
        >
          <SystemIcon name="save_export" className="w-3.5 h-3.5" />
          <span>Komplettes Projekt als ZIP laden</span>
        </a>
      </section>

      {error && (
        <div className="p-4 rounded-lg border border-[#DC2626]/30 bg-[#DC2626]/5 text-xs text-[#DC2626] dark:text-[#F87171]">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[270px_1fr] gap-6 items-start">
        {/* Dateibaum */}
        <aside className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg overflow-hidden">
          <div className="px-3 py-2.5 border-b border-[#E1E4E8] dark:border-[#343A40] text-xs font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
            Projektdateien ({files.length})
          </div>
          {isLoading ? (
            <div className="p-4 text-xs text-[#57606A] dark:text-[#8B949E]">Lade Dateien...</div>
          ) : (
            <div className="divide-y divide-[#E1E4E8] dark:divide-[#343A40]">
              {files.map((file) => {
                const isSelected = activeFile?.path === file.path;
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => setSelectedPath(file.path)}
                    className={`w-full px-2.5 py-1.5 text-left flex items-center justify-between gap-2 text-xs transition-colors ${
                      isSelected
                        ? 'bg-[#5BA632]/10 text-[#2E6B14] dark:text-[#9BE270] font-medium'
                        : 'text-[#1F2328] dark:text-[#EAEEF2] hover:bg-[#F4F5F6] dark:hover:bg-[#2D333B]'
                    }`}
                  >
                    <span className="font-mono truncate">{file.path}</span>
                    <span className="font-mono text-[11px] tabular-nums text-[#57606A] dark:text-[#8B949E] shrink-0">
                      {(file.size / 1024).toFixed(1)} KB
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="p-3 border-t border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 space-y-1.5 text-[11px] text-[#57606A] dark:text-[#8B949E]">
            <div className="font-semibold text-[#1F2328] dark:text-[#EAEEF2]">Installation unter Linux Mint:</div>
            <pre className="font-mono text-[11px] overflow-x-auto leading-relaxed">
{`unzip mintrip-linux-mint.zip
cd mintrip-linux-mint
chmod +x install_mint.sh
./install_mint.sh
~/.local/bin/mintrip`}
            </pre>
          </div>
        </aside>

        {/* Quellcode-Anzeige */}
        <section className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg overflow-hidden min-w-0">
          {activeFile ? (
            <>
              <div className="px-4 py-2.5 border-b border-[#E1E4E8] dark:border-[#343A40] flex items-center justify-between gap-4 bg-[#F8F9FA] dark:bg-[#1C1F23]/60">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs font-medium text-[#1F2328] dark:text-[#EAEEF2] truncate">
                    {activeFile.path}
                  </span>
                  <span className="text-[11px] text-[#57606A] dark:text-[#8B949E] tabular-nums">
                    · {activeFile.content.split('\n').length} Zeilen
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="px-2 py-0.5 text-xs font-medium rounded border border-[#D0D7DE] dark:border-[#444C56] text-[#1F2328] dark:text-[#EAEEF2] hover:bg-white dark:hover:bg-[#2D333B] whitespace-nowrap"
                >
                  {copiedPath === activeFile.path ? 'Kopiert' : 'Code kopieren'}
                </button>
              </div>
              <pre className="p-4 text-xs font-mono leading-relaxed overflow-x-auto max-h-[680px] text-[#1F2328] dark:text-[#EAEEF2] bg-white dark:bg-[#1C1F23]">
                <code>{activeFile.content}</code>
              </pre>
            </>
          ) : (
            <div className="p-8 text-center text-xs text-[#57606A] dark:text-[#8B949E]">
              Keine Datei ausgewählt.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
