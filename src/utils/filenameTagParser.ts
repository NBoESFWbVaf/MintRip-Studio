import { AlbumMetadata, TrackMetadata } from '../types/mintrip';
import { normalizeMultiArtist } from './audioExportHelpers';

export interface EasyTagPlaceholderSpec {
  code: string;
  label: string;
  description: string;
}

export const EASYTAG_PLACEHOLDERS: EasyTagPlaceholderSpec[] = [
  { code: '%a', label: 'Interpret', description: 'Titel-Interpret (ARTIST)' },
  { code: '%b', label: 'Album', description: 'Albumtitel (ALBUM)' },
  { code: '%c', label: 'Kommentar', description: 'Kommentar-Tag (COMMENT)' },
  { code: '%d', label: 'CD-Nr.', description: 'CD-Nummer (DISCNUMBER)' },
  { code: '%g', label: 'Genre', description: 'Musikrichtung (GENRE)' },
  { code: '%i', label: 'Ignorieren', description: 'Beliebigen Text überspringen' },
  { code: '%l', label: 'Titel gesamt', description: 'Gesamtanzahl Titel' },
  { code: '%n', label: 'Titel-Nr.', description: 'Titelnummer (TRACKNUMBER)' },
  { code: '%o', label: 'Album-Interpret', description: 'Album- / Original-Interpret (ALBUMARTIST)' },
  { code: '%p', label: 'Komponist', description: 'Komponist (COMPOSER)' },
  { code: '%t', label: 'Titel', description: 'Liedtitel (TITLE)' },
  { code: '%y', label: 'Jahr', description: 'Erscheinungsjahr (YEAR / DATE)' },
  { code: '/', label: 'Ordner-Trenner', description: 'Übergeordnete Verzeichnisnamen einbeziehen' },
];

export const DEFAULT_FILENAME_MASKS: string[] = [
  '%n - %t',
  '%n. %t',
  '%n - %a - %t',
  '%a - %t',
  '%d-%n - %t',
  '%a - %b/%n - %t',
  '%a/%b/%n - %t',
  '%a/%y - %b/%n - %t',
  '%a - %y - %b/%n - %t',
  '%b/%n - %a - %t',
  '%n %t',
];

const CUSTOM_MASKS_STORAGE_KEY = 'mintrip_easytag_custom_masks_v1';
const AUDIO_EXT_RE = /\.(flac|mp3|mp2|wav|aiff|aif|aifc|ogg|opus|m4a|dsf|tta|wv)$/i;
const VALID_CODES = new Set(['a', 'b', 'c', 'd', 'g', 'i', 'l', 'n', 'o', 'p', 't', 'y']);

export interface FilenameMaskOptions {
  replaceUnderscores: boolean;
  cleanSpaces: boolean;
  onlySelected: boolean;
  onlyEmptyFields: boolean;
}

export const DEFAULT_FILENAME_MASK_OPTIONS: FilenameMaskOptions = {
  replaceUnderscores: true,
  cleanSpaces: true,
  onlySelected: true,
  onlyEmptyFields: false,
};

export interface FilenameTagPreviewRow {
  trackIndex: number;
  track: TrackMetadata;
  sourceDisplay: string;
  matched: boolean;
  extracted: Record<string, string>;
  reason: string;
}

export function loadSavedFilenameMasks(): string[] {
  let custom: string[] = [];
  try {
    const raw = localStorage.getItem(CUSTOM_MASKS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        custom = parsed.map((x) => String(x || '').trim()).filter(Boolean);
      }
    }
  } catch {
    custom = [];
  }
  const merged: string[] = [];
  for (const m of [...custom, ...DEFAULT_FILENAME_MASKS]) {
    if (!merged.includes(m)) merged.push(m);
  }
  return merged;
}

export function saveCustomFilenameMasks(masks: string[]): void {
  const customOnly = masks
    .map((m) => m.trim())
    .filter((m) => m && !DEFAULT_FILENAME_MASKS.includes(m));
  try {
    localStorage.setItem(CUSTOM_MASKS_STORAGE_KEY, JSON.stringify(customOnly));
  } catch {
    // ignore storage quota errors
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanExtractedText(value: string, options: FilenameMaskOptions): string {
  let text = String(value || '');
  if (options.replaceUnderscores) {
    text = text.replace(/%20/g, ' ').replace(/_/g, ' ');
  }
  if (options.cleanSpaces) {
    text = text.replace(/\s+/g, ' ').trim();
  } else {
    text = text.trim();
  }
  return text;
}

function compileSegmentRegex(
  segmentMask: string,
  cleanSpaces: boolean
): { regex: RegExp; codes: string[] } {
  const tokens: Array<{ start: number; end: number; code: string }> = [];
  const tokenRe = /%([a-zA-Z])/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(segmentMask)) !== null) {
    const code = match[1].toLowerCase();
    if (VALID_CODES.has(code)) {
      tokens.push({ start: match.index, end: match.index + match[0].length, code });
    }
  }

  const parts: string[] = ['^'];
  const codes: string[] = [];
  let cursor = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const { start, end, code } = tokens[i];
    const literal = segmentMask.slice(cursor, start);
    if (literal) {
      let esc = escapeRegExp(literal);
      if (cleanSpaces) {
        esc = esc.replace(/ +/g, '\\s+');
      }
      parts.push(esc);
    }

    const isLast = i === tokens.length - 1;
    const hasTrailing = end < segmentMask.length;
    if (code === 'n' || code === 'd' || code === 'l') {
      parts.push('(\\d+)');
    } else if (code === 'y') {
      parts.push('(\\d{4}|\\d{2})');
    } else if (isLast && !hasTrailing) {
      parts.push('(.+)');
    } else {
      parts.push('(.+?)');
    }
    codes.push(code);
    cursor = end;
  }

  const tail = segmentMask.slice(cursor);
  if (tail) {
    let esc = escapeRegExp(tail);
    if (cleanSpaces) {
      esc = esc.replace(/ +/g, '\\s+');
    }
    parts.push(esc);
  }

  parts.push('$');
  return { regex: new RegExp(parts.join('')), codes };
}

export function parsePathWithMask(
  sourcePath: string,
  mask: string,
  options: FilenameMaskOptions = DEFAULT_FILENAME_MASK_OPTIONS
): { matched: boolean; extracted: Record<string, string>; reason: string } {
  const cleanMask = String(mask || '').trim().replace(/\\/g, '/');
  if (!cleanMask) {
    return { matched: false, extracted: {}, reason: 'Leere Maske' };
  }

  const normPath = String(sourcePath || '').trim().replace(/\\/g, '/');
  const rawSegments = normPath.split('/').filter(Boolean);
  if (rawSegments.length === 0) {
    return { matched: false, extracted: {}, reason: 'Kein Dateiname vorhanden' };
  }

  rawSegments[rawSegments.length - 1] = rawSegments[rawSegments.length - 1].replace(AUDIO_EXT_RE, '');
  const maskSegments = cleanMask.split('/').filter((s) => s !== '');
  if (maskSegments.length === 0) {
    return { matched: false, extracted: {}, reason: 'Ungültige Maske' };
  }

  if (rawSegments.length < maskSegments.length) {
    return {
      matched: false,
      extracted: {},
      reason: `Pfadtiefe zu gering (${rawSegments.length} Segment(e) für ${maskSegments.length} Ebenen)`,
    };
  }

  const targetSegments = rawSegments.slice(-maskSegments.length);
  const extracted: Record<string, string> = {};

  for (let i = 0; i < maskSegments.length; i += 1) {
    let compiled: { regex: RegExp; codes: string[] };
    try {
      compiled = compileSegmentRegex(maskSegments[i], options.cleanSpaces);
    } catch {
      return { matched: false, extracted: {}, reason: 'Ungültige Masken-Syntax' };
    }

    const rawSeg = targetSegments[i].trim();
    let m = compiled.regex.exec(rawSeg);
    if (!m && options.replaceUnderscores) {
      const normSeg = rawSeg.replace(/%20/g, ' ').replace(/_/g, ' ').trim();
      m = compiled.regex.exec(normSeg);
    }
    if (!m) {
      return { matched: false, extracted: {}, reason: 'Stimmt nicht mit Maske überein' };
    }

    for (let g = 0; g < compiled.codes.length; g += 1) {
      const code = compiled.codes[g];
      if (code === 'i') continue;
      const val = cleanExtractedText(m[g + 1] || '', options);
      if (val) {
        extracted[code] = val;
      }
    }
  }

  return { matched: true, extracted, reason: 'OK' };
}

export function getTrackSourcePath(track: TrackMetadata, fallbackFolder = ''): string {
  const fileWithRel = track.sourceFile as (File & { webkitRelativePath?: string }) | undefined;
  const relPath = fileWithRel?.webkitRelativePath?.trim();
  if (relPath) return relPath;
  const fileName = track.sourceFileName?.trim() || track.sourceFile?.name?.trim();
  if (fileName) {
    if (fileName.includes('/') || !fallbackFolder) return fileName;
    return `${fallbackFolder.replace(/\/+$/, '')}/${fileName}`;
  }
  const synthetic = `${String(track.trackNumber).padStart(2, '0')} - ${track.title || 'Unbekannt'}`;
  return fallbackFolder ? `${fallbackFolder.replace(/\/+$/, '')}/${synthetic}` : synthetic;
}

export function previewFilenameMaskOnAlbum(
  album: AlbumMetadata,
  mask: string,
  options: FilenameMaskOptions = DEFAULT_FILENAME_MASK_OPTIONS,
  fallbackFolder = ''
): FilenameTagPreviewRow[] {
  const maskDepth = (String(mask || '').trim().replace(/\\/g, '/').match(/\//g) || []).length;
  const rows: FilenameTagPreviewRow[] = [];

  album.tracks.forEach((track, trackIndex) => {
    if (options.onlySelected && !track.selected) return;
    const fullSrc = getTrackSourcePath(track, fallbackFolder);
    const parts = fullSrc.replace(/\\/g, '/').split('/').filter(Boolean);
    const sourceDisplay = parts.length > 0 ? parts.slice(-(maskDepth + 1)).join('/') : fullSrc;
    const { matched, extracted, reason } = parsePathWithMask(fullSrc, mask, options);
    rows.push({
      trackIndex,
      track,
      sourceDisplay,
      matched,
      extracted,
      reason,
    });
  });

  return rows;
}

export function applyFilenameMaskToAlbum(
  album: AlbumMetadata,
  mask: string,
  options: FilenameMaskOptions = DEFAULT_FILENAME_MASK_OPTIONS,
  fallbackFolder = ''
): {
  updatedAlbum: AlbumMetadata;
  matchedCount: number;
  totalChecked: number;
  touchedFields: string[];
} {
  const rows = previewFilenameMaskOnAlbum(album, mask, options, fallbackFolder);
  const rowByIdx = new Map<number, FilenameTagPreviewRow>();
  for (const r of rows) rowByIdx.set(r.trackIndex, r);

  const canSet = (existing?: string) => !options.onlyEmptyFields || !String(existing || '').trim();

  let matchedCount = 0;
  const touched = new Set<string>();
  const albumTitles: string[] = [];
  const albumArtists: string[] = [];
  const trackArtists: string[] = [];
  const years: string[] = [];
  const genres: string[] = [];
  const comments: string[] = [];
  const composers: string[] = [];
  const discNums = new Set<number>();

  const nextTracks = album.tracks.map((tr, idx) => {
    const row = rowByIdx.get(idx);
    if (!row || !row.matched || Object.keys(row.extracted).length === 0) {
      return tr;
    }
    matchedCount += 1;
    const ext = row.extracted;
    const next: TrackMetadata = { ...tr };

    if (ext.n && /^\d+$/.test(ext.n)) {
      const valN = Math.max(1, parseInt(ext.n, 10));
      if (!options.onlyEmptyFields || next.trackNumber <= 0) {
        next.trackNumber = valN;
        touched.add('Titelnummer');
      }
    }

    if (ext.d && /^\d+$/.test(ext.d)) {
      const valD = Math.max(1, parseInt(ext.d, 10));
      if (!options.onlyEmptyFields || !next.discNumber || next.discNumber <= 0) {
        next.discNumber = valD;
        discNums.add(valD);
        touched.add('CD-Nr.');
      }
    }

    if (ext.t && canSet(next.title)) {
      next.title = ext.t;
      touched.add('Titel');
    }

    if (ext.a && canSet(next.artist)) {
      const normA = normalizeMultiArtist(ext.a);
      next.artist = normA;
      next.artists = normA
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      trackArtists.push(normA);
      touched.add('Interpret');
    }

    if (ext.p && canSet(next.composer)) {
      const normP = normalizeMultiArtist(ext.p);
      next.composer = normP;
      composers.push(normP);
      touched.add('Komponist');
    }

    if (ext.b) albumTitles.push(ext.b);
    if (ext.o) albumArtists.push(normalizeMultiArtist(ext.o));
    if (ext.y) years.push(ext.y);
    if (ext.g) {
      if (canSet(next.genre)) {
        next.genre = ext.g;
        touched.add('Genre');
      }
      genres.push(ext.g);
    }
    if (ext.c) comments.push(ext.c);

    return next;
  });

  const nextAlbum: AlbumMetadata = {
    ...album,
    tracks: nextTracks,
  };

  if (albumTitles.length > 0 && canSet(nextAlbum.title === 'Unbekanntes Album' ? '' : nextAlbum.title)) {
    nextAlbum.title = albumTitles[0];
    touched.add('Album');
  }

  if (albumArtists.length > 0 && canSet(nextAlbum.albumArtist)) {
    nextAlbum.albumArtist = albumArtists[0];
    nextAlbum.albumArtists = albumArtists[0]
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    if (canSet(nextAlbum.artist === 'Unbekannter Künstler' ? '' : nextAlbum.artist)) {
      nextAlbum.artist = albumArtists[0];
    }
    touched.add('Album-Interpret');
  } else if (trackArtists.length > 0) {
    const uniq = Array.from(new Set(trackArtists));
    if (uniq.length === 1) {
      if (canSet(nextAlbum.artist === 'Unbekannter Künstler' ? '' : nextAlbum.artist)) {
        nextAlbum.artist = uniq[0];
      }
      if (canSet(nextAlbum.albumArtist)) {
        nextAlbum.albumArtist = uniq[0];
        nextAlbum.albumArtists = uniq[0]
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } else if (uniq.length > 1 && canSet(nextAlbum.albumArtist)) {
      nextAlbum.albumArtist = 'Various Artists';
      nextAlbum.albumArtists = ['Various Artists'];
    }
  }

  if (years.length > 0 && canSet(nextAlbum.year)) {
    nextAlbum.year = years[0];
    touched.add('Jahr');
  }

  if (genres.length > 0 && canSet(nextAlbum.genre)) {
    nextAlbum.genre = genres[0];
    touched.add('Genre');
  }

  if (comments.length > 0 && canSet(nextAlbum.comment)) {
    nextAlbum.comment = comments[0];
    touched.add('Kommentar');
  }

  if (composers.length > 0) {
    const uniqComp = Array.from(new Set(composers));
    if (uniqComp.length === 1 && canSet(nextAlbum.composer)) {
      nextAlbum.composer = uniqComp[0];
    }
  }

  if (discNums.size > 0) {
    const nums = Array.from(discNums);
    nextAlbum.totalDiscs = Math.max(nextAlbum.totalDiscs || 1, ...nums);
    nextAlbum.discNumber = Math.min(...nums);
  }

  return {
    updatedAlbum: nextAlbum,
    matchedCount,
    totalChecked: rows.length,
    touchedFields: Array.from(touched).sort(),
  };
}
