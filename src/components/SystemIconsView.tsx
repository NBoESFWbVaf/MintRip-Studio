import React, { useState } from 'react';
import { SYSTEM_ICON_SPECS, SystemIcon } from './SystemIcons';

export function SystemIconsView() {
  const [filter, setFilter] = useState('');

  const filtered = SYSTEM_ICON_SPECS.filter(
    (spec) =>
      spec.xdgName.toLowerCase().includes(filter.toLowerCase()) ||
      spec.gtkRole.toLowerCase().includes(filter.toLowerCase()) ||
      spec.key.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold text-[#1F2328] dark:text-[#EAEEF2]">
              Systemicons & Linux Mint Theme-Kompatibilität
            </h1>
            <p className="text-xs text-[#57606A] dark:text-[#8B949E] max-w-2xl">
              Die GTK3-Anwendung verzichtet vollständig auf eigene PNG/SVG-Assets und lädt jedes Symbol über
              <code className="mx-1 px-1.5 py-0.5 rounded bg-[#F4F5F6] dark:bg-[#1C1F23] font-mono">
                Gtk.Image.new_from_icon_name(...)
              </code>
              direkt aus dem aktiven Linux-Mint-Systemtheme (Mint-L, Mint-Y, WhiteSur oder Adwaita) inkl. automatischer Light-/Dark-Anpassung.
            </p>
          </div>

          <div className="relative w-64">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[#656D76]">
              <SystemIcon name="search_online" className="w-3.5 h-3.5" />
            </span>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="XDG-Icon-Namen filtern..."
              className="w-full pl-7 pr-2.5 py-1 text-xs rounded border border-[#D0D7DE] dark:border-[#444C56] bg-[#F8F9FA] dark:bg-[#1C1F23] text-[#1F2328] dark:text-[#EAEEF2] focus:outline-none focus:ring-2 focus:ring-[#5BA632]"
            />
          </div>
        </div>
      </section>

      <section className="bg-white dark:bg-[#25292E] border border-[#E1E4E8] dark:border-[#343A40] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#E1E4E8] dark:border-[#343A40] bg-[#F8F9FA] dark:bg-[#1C1F23]/60 text-[11px] font-semibold text-[#57606A] dark:text-[#8B949E]">
                <th className="py-2.5 pl-4 pr-2 w-16">Vorschau</th>
                <th className="py-2.5 px-2">XDG-Systemicon-Name (-symbolic)</th>
                <th className="py-2.5 px-2">Python-Schlüssel</th>
                <th className="py-2.5 px-2">Verwendung in der GTK3-UI</th>
                <th className="py-2.5 pl-2 pr-4">Freedesktop-Kategorie</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E1E4E8] dark:divide-[#343A40] text-xs">
              {filtered.map((spec) => (
                <tr key={spec.key} className="h-11 hover:bg-[#F8F9FA] dark:hover:bg-[#2D333B]/60">
                  <td className="pl-4 pr-2">
                    <div className="w-8 h-8 rounded border border-[#E1E4E8] dark:border-[#343A40] bg-[#F4F5F6] dark:bg-[#1C1F23] flex items-center justify-center text-[#1F2328] dark:text-[#EAEEF2]">
                      <SystemIcon name={spec.key} className="w-4 h-4" />
                    </div>
                  </td>
                  <td className="px-2 font-mono text-[11px] text-[#5BA632] dark:text-[#69B53F]">
                    {spec.xdgName}
                  </td>
                  <td className="px-2 font-mono text-[11px] text-[#57606A] dark:text-[#8B949E]">
                    {spec.key}
                  </td>
                  <td className="px-2 text-[#1F2328] dark:text-[#EAEEF2]">{spec.gtkRole}</td>
                  <td className="pl-2 pr-4 text-[#57606A] dark:text-[#8B949E]">{spec.themeNote}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
