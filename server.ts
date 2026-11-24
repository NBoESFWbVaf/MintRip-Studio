import express from 'express';
import { AsyncLocalStorage } from 'async_hooks';
import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

const PORT = 3000;
const APP_VERSION = '1.2.0';
const APP_CONTACT_URL = 'https://github.com/NBoESFWbVaf/mintrip-studio';
const MB_USER_AGENT = `MintRipStudio/${APP_VERSION} (${APP_CONTACT_URL})`;
const DISCOGS_USER_AGENT = `MintRipStudio/${APP_VERSION} +${APP_CONTACT_URL}`;
const PYTHON_PROJECT_DIR = path.resolve(process.cwd(), 'linux_mint_app');
const DEFAULT_MUSICBRAINZ_SERVER_URL = 'https://musicbrainz.org/ws/2';
const METADATA_CACHE_FILE = path.resolve(process.cwd(), '.cache', 'metadata_cache.json');
const METADATA_CACHE_MAX_ENTRIES = 2500;

interface RequestMetaContext {
  mbBaseUrl: string;
  preferSubgenres: boolean;
}

const requestMetaContext = new AsyncLocalStorage<RequestMetaContext>();

function normalizeMusicBrainzServerUrl(raw: unknown): string {
  const txt = String(raw || '').trim().replace(/\/+$/, '');
  if (!txt) return DEFAULT_MUSICBRAINZ_SERVER_URL;
  try {
    const parsed = new URL(txt);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return DEFAULT_MUSICBRAINZ_SERVER_URL;
    }
    const clean = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
    return clean.endsWith('/ws/2') ? clean : `${clean}/ws/2`;
  } catch {
    return DEFAULT_MUSICBRAINZ_SERVER_URL;
  }
}

function isOfficialMusicBrainzUrl(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return host === 'musicbrainz.org' || host.endsWith('.musicbrainz.org');
  } catch {
    return true;
  }
}

function rewriteMusicBrainzUrl(urlStr: string): string {
  const ctx = requestMetaContext.getStore();
  const baseUrl = ctx?.mbBaseUrl || DEFAULT_MUSICBRAINZ_SERVER_URL;
  if (baseUrl !== DEFAULT_MUSICBRAINZ_SERVER_URL && urlStr.startsWith(DEFAULT_MUSICBRAINZ_SERVER_URL)) {
    return `${baseUrl}${urlStr.slice(DEFAULT_MUSICBRAINZ_SERVER_URL.length)}`;
  }
  return urlStr;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const metadataCacheMap = new Map<string, CacheEntry>();
let metadataCacheLoaded = false;
let metadataCacheFlushTimer: NodeJS.Timeout | null = null;

function ensureMetadataCacheLoaded(): void {
  if (metadataCacheLoaded) return;
  metadataCacheLoaded = true;
  try {
    if (!fs.existsSync(METADATA_CACHE_FILE)) return;
    const raw = fs.readFileSync(METADATA_CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
    const now = Date.now();
    for (const [k, entry] of Object.entries(parsed || {})) {
      if (entry && typeof entry.value === 'string' && Number(entry.expiresAt) > now) {
        metadataCacheMap.set(k, { value: entry.value, expiresAt: Number(entry.expiresAt) });
      }
    }
  } catch {
    // Cache bei beschädigter Datei frisch starten
  }
}

function scheduleMetadataCacheFlush(): void {
  if (metadataCacheFlushTimer) return;
  metadataCacheFlushTimer = setTimeout(() => {
    metadataCacheFlushTimer = null;
    try {
      fs.mkdirSync(path.dirname(METADATA_CACHE_FILE), { recursive: true });
      const now = Date.now();
      const obj: Record<string, CacheEntry> = {};
      for (const [k, entry] of metadataCacheMap.entries()) {
        if (entry.expiresAt > now) {
          obj[k] = entry;
        } else {
          metadataCacheMap.delete(k);
        }
      }
      fs.writeFileSync(METADATA_CACHE_FILE, JSON.stringify(obj), 'utf-8');
    } catch {
      // Cache-Schreibfehler niemals fatal
    }
  }, 600);
}

function getCacheTtlMsForUrl(urlStr: string): number {
  const lower = urlStr.toLowerCase();
  if (
    lower.includes('/ws/2/release/?') ||
    lower.includes('/ws/2/recording/?') ||
    lower.includes('/ws/2/artist/?') ||
    lower.includes('api.discogs.com/database/search')
  ) {
    return 7 * 24 * 60 * 60 * 1000;
  }
  if (lower.includes('/ws/2/discid/') || lower.includes('wikidata.org')) {
    return 14 * 24 * 60 * 60 * 1000;
  }
  if (
    lower.includes('/ws/2/release/') ||
    lower.includes('/ws/2/release-group/') ||
    lower.includes('/ws/2/isrc/') ||
    lower.includes('/ws/2/recording/') ||
    lower.includes('/ws/2/artist/') ||
    lower.includes('api.discogs.com/releases/') ||
    lower.includes('api.discogs.com/masters/') ||
    lower.includes('ws.audioscrobbler.com/')
  ) {
    return 30 * 24 * 60 * 60 * 1000;
  }
  return 0;
}

function makeCacheKey(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    // API-Keys aus Cache-Key entfernen, damit identische Abfragen auch ohne Key-Duplikat treffen
    if (parsed.searchParams.has('api_key')) {
      parsed.searchParams.delete('api_key');
    }
    return parsed.toString();
  } catch {
    return urlStr;
  }
}

function readMetadataCache(urlStr: string): string | null {
  ensureMetadataCacheLoaded();
  const key = makeCacheKey(urlStr);
  const hit = metadataCacheMap.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    metadataCacheMap.delete(key);
    return null;
  }
  return hit.value;
}

function writeMetadataCache(urlStr: string, bodyText: string, ttlMs: number): void {
  if (ttlMs <= 0 || !bodyText) return;
  ensureMetadataCacheLoaded();
  const key = makeCacheKey(urlStr);
  if (metadataCacheMap.size >= METADATA_CACHE_MAX_ENTRIES && !metadataCacheMap.has(key)) {
    const oldestKey = metadataCacheMap.keys().next().value;
    if (oldestKey) metadataCacheMap.delete(oldestKey);
  }
  metadataCacheMap.set(key, { value: bodyText, expiresAt: Date.now() + ttlMs });
  scheduleMetadataCacheFlush();
}

function clearMetadataCache(): { cleared: number } {
  ensureMetadataCacheLoaded();
  const cleared = metadataCacheMap.size;
  metadataCacheMap.clear();
  try {
    if (fs.existsSync(METADATA_CACHE_FILE)) {
      fs.unlinkSync(METADATA_CACHE_FILE);
    }
  } catch {
    // Ignorieren
  }
  return { cleared };
}

function getMetadataCacheStats(): { entries: number; sizeBytes: number } {
  ensureMetadataCacheLoaded();
  const now = Date.now();
  let entries = 0;
  let sizeBytes = 0;
  for (const [k, entry] of metadataCacheMap.entries()) {
    if (entry.expiresAt > now) {
      entries++;
      sizeBytes += Buffer.byteLength(k, 'utf-8') + Buffer.byteLength(entry.value, 'utf-8');
    } else {
      metadataCacheMap.delete(k);
    }
  }
  return { entries, sizeBytes };
}

interface ProjectFileEntry {
  path: string;
  name: string;
  language: string;
  content: string;
  size: number;
}

function detectLanguage(filePath: string): string {
  if (filePath.endsWith('.py')) return 'python';
  if (filePath.endsWith('.sh')) return 'bash';
  if (filePath.endsWith('.desktop')) return 'ini';
  if (filePath.endsWith('.md')) return 'markdown';
  return 'text';
}

function collectProjectFiles(dir: string, baseDir: string): ProjectFileEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: ProjectFileEntry[] = [];

  for (const entry of entries) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectProjectFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      const content = fs.readFileSync(fullPath, 'utf-8');
      results.push({
        path: relPath,
        name: entry.name,
        language: detectLanguage(relPath),
        content,
        size: Buffer.byteLength(content, 'utf-8'),
      });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

const MULTI_ARTIST_BRACKET_RE =
  /\s*[(\[]\s*(?:feat(?:uring)?|ft|vs|versus|v\.|pres(?:ents|enting)?|präsentiert|praesentiert)(?:\.\s*|\s+)([^)\]]+?)[)\]]/gi;

const MULTI_ARTIST_JOIN_RE =
  /(?:\s*[,;&]?\s+)(?:(?:feat(?:uring)?|ft|vs|versus|pres(?:ents|enting)?|präsentiert|praesentiert)(?:\.\s*|\s+)|v\.\s*)/gi;

function normalizeMultiArtist(value: string): string {
  const text = String(value || '').trim();
  if (!text) return '';
  const unbracketed = text.replace(MULTI_ARTIST_BRACKET_RE, '; $1');
  const joined = unbracketed.replace(MULTI_ARTIST_JOIN_RE, '; ');
  const parts = joined
    .split(/\s*;\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : text;
}

function formatArtistCredit(credits?: Array<{ name?: string; artist?: { name?: string }; joinphrase?: string }>): string {
  if (!Array.isArray(credits) || credits.length === 0) return 'Unbekannter Künstler';
  const raw = credits
    .map((c) => `${c.name || c.artist?.name || ''}${c.joinphrase || ''}`)
    .join('')
    .trim();
  return normalizeMultiArtist(raw) || 'Unbekannter Künstler';
}

function formatGenreToken(token: string): string {
  const cleaned = token.trim();
  if (!cleaned) return '';
  const lower = cleaned.toLowerCase();
  const special: Record<string, string> = {
    'r&b': 'R&B',
    edm: 'EDM',
    idm: 'IDM',
    dnb: 'Drum & Bass',
    'drum and bass': 'Drum & Bass',
    'hip-hop': 'Hip-Hop',
    'hip hop': 'Hip-Hop',
    'hip hop music': 'Hip-Hop',
    'synth-pop': 'Synth-Pop',
    synthpop: 'Synth-Pop',
    'lo-fi': 'Lo-Fi',
    krautrock: 'Krautrock',
    'electronic music': 'Electronic',
    'experimental music': 'Experimental',
    'rock music': 'Rock',
    'pop music': 'Pop',
    'ambient music': 'Ambient',
    'jazz music': 'Jazz',
    'classical music': 'Classical',
    'heavy metal': 'Heavy Metal',
    'progressive rock': 'Progressive Rock',
    'psychedelic rock': 'Psychedelic Rock',
    'dance music': 'Dance',
    'folk music': 'Folk',
    'soul music': 'Soul',
    'country music': 'Country',
    'disco music': 'Disco',
    'house music': 'House',
    'techno music': 'Techno',
    'reggae music': 'Reggae',
    'blues music': 'Blues',
    'funk music': 'Funk',
    popmusik: 'Pop',
    rockmusik: 'Rock',
    'elektronische musik': 'Electronic',
    'klassische musik': 'Classical',
    filmmusik: 'Soundtrack',
    'rhythm and blues': 'R&B',
    elektropop: 'Electropop',
    'elektro-pop': 'Electropop',
    'electro-pop': 'Electropop',
    electropop: 'Electropop',
    elektro: 'Electro',
  };
  if (special[lower]) return special[lower];
  const withoutSuffix = cleaned.replace(/\s+(?:music|musik)$/i, '').trim();
  const base = withoutSuffix || cleaned;
  if (special[base.toLowerCase()]) return special[base.toLowerCase()];
  return base
    .split(/([\s\-/]+)/)
    .map((part) => {
      if (!part || /^[\s\-/]+$/.test(part)) return part;
      if (part === part.toUpperCase() && part.length <= 4) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join('');
}

function canonicalGenreDedupeKey(genreText: string): string {
  return String(genreText || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\s+(?:music|musik)$/i, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

const BROAD_UMBRELLA_GENRES = new Set([
  'rock',
  'pop',
  'punk',
  'metal',
  'electronic',
  'jazz',
  'folk',
  'hiphop',
  'hip-hop',
  'rap',
  'classical',
  'soul',
  'blues',
  'country',
  'reggae',
  'dance',
  'indie',
  'alternative',
  'rnb',
  'randb',
  'funk',
  'world',
  'latin',
  'soundtrack',
  'stageandscreen',
  'nonmusic',
]);

const NOISE_TAG_DENYLIST = new Set([
  'seen live',
  'seenlive',
  'favorites',
  'favourites',
  'favorite',
  'favourite',
  'my favorites',
  'awesome',
  'love',
  'beautiful',
  'amazing',
  'great',
  'best',
  'good',
  'classic',
  'masterpiece',
  'american',
  'british',
  'german',
  'english',
  'french',
  'swedish',
  'canadian',
  'japanese',
  'australian',
  'male vocalists',
  'female vocalists',
  'california',
  'los angeles',
  'new york',
  'london',
  'berlin',
  'spotify',
  'cd',
  'vinyl',
  'album',
  'albums i own',
  'under 2000 listeners',
]);

const CURATED_GENRE_TOKENS = new Set([
  'rock', 'punk', 'punk rock', 'hardcore', 'hardcore punk', 'skate punk', 'melodic hardcore',
  'pop punk', 'post-punk', 'post punk', 'anarcho-punk', 'street punk', 'crust punk', 'emo',
  'screamo', 'grunge', 'alternative rock', 'indie rock', 'garage rock', 'psychedelic rock',
  'progressive rock', 'art rock', 'krautrock', 'post-rock', 'math rock', 'noise rock',
  'shoegaze', 'britpop', 'stoner rock', 'surf rock', 'glam rock', 'folk rock', 'blues rock',
  'southern rock', 'hard rock', 'classic rock', 'arena rock', 'soft rock', 'heartland rock',
  'roots rock', 'gothic rock', 'industrial rock', 'space rock', 'new wave', 'no wave', 'coldwave',
  'darkwave', 'synthpop', 'synth-pop', 'electropop', 'dream pop', 'indie pop', 'chamber pop',
  'baroque pop', 'power pop', 'jangle pop', 'twee pop', 'art pop', 'hyperpop', 'city pop',
  'eurodance', 'europop', 'italo-disco', 'disco', 'nu-disco', 'dance-pop', 'pop', 'schlager',
  'neue deutsche welle', 'chanson', 'metal', 'heavy metal', 'thrash metal', 'death metal',
  'melodic death metal', 'technical death metal', 'black metal', 'doom metal', 'sludge metal',
  'stoner metal', 'power metal', 'progressive metal', 'symphonic metal', 'gothic metal',
  'folk metal', 'viking metal', 'nu metal', 'alternative metal', 'industrial metal', 'groove metal',
  'speed metal', 'metalcore', 'deathcore', 'grindcore', 'crossover thrash', 'djent', 'electronic',
  'electro', 'techno', 'minimal techno', 'detroit techno', 'acid techno', 'house', 'deep house',
  'tech house', 'progressive house', 'acid house', 'electro house', 'french house', 'trance',
  'psytrance', 'goa trance', 'ambient', 'dark ambient', 'drone', 'idm', 'drum and bass',
  'drum & bass', 'jungle', 'breakbeat', 'big beat', 'dubstep', 'uk garage', 'trip-hop', 'trip hop',
  'downtempo', 'chillout', 'lo-fi', 'vaporwave', 'synthwave', 'retrowave', 'ebm', 'industrial',
  'aggrotech', 'glitch', 'chiptune', 'electronica', 'leftfield', 'gabber', 'hardstyle', 'edm',
  'hip-hop', 'hip hop', 'rap', 'boom bap', 'gangsta rap', 'east coast hip hop', 'west coast hip hop',
  'conscious hip hop', 'trap', 'drill', 'grime', 'old school hip hop', 'jazz rap', 'cloud rap',
  'instrumental hip hop', 'turntablism', 'jazz', 'bebop', 'hard bop', 'cool jazz', 'modal jazz',
  'free jazz', 'avant-garde jazz', 'jazz fusion', 'fusion', 'smooth jazz', 'acid jazz', 'nu jazz',
  'swing', 'big band', 'bossa nova', 'latin jazz', 'gypsy jazz', 'soul', 'neo-soul', 'funk',
  'p-funk', 'r&b', 'contemporary r&b', 'motown', 'gospel', 'blues', 'delta blues', 'chicago blues',
  'electric blues', 'acoustic blues', 'country', 'alt-country', 'americana', 'bluegrass',
  'outlaw country', 'honky tonk', 'folk', 'indie folk', 'contemporary folk', 'neofolk',
  'freak folk', 'celtic', 'singer-songwriter', 'reggae', 'roots reggae', 'dub', 'ska', 'ska punk',
  'two-tone', 'rocksteady', 'dancehall', 'ragga', 'classical', 'baroque', 'romantic', 'modern classical',
  'contemporary classical', 'minimalism', 'opera', 'chamber music', 'choral', 'orchestral',
  'soundtrack', 'film score', 'video game music', 'musical', 'experimental', 'avant-garde',
  'noise', 'musique concrete', 'spoken word', 'comedy', 'world', 'afrobeat', 'flamenco', 'tango',
  'salsa', 'cumbia', 'samba', 'mpb', 'reggaeton', 'k-pop', 'j-pop', 'j-rock',
]);

function isValidMusicGenreTag(tag: string): boolean {
  const cleaned = String(tag || '').trim().toLowerCase();
  if (!cleaned || cleaned.length < 2 || cleaned.length > 42) return false;
  if (/^\d{2,4}s?$/.test(cleaned)) return false;
  if (NOISE_TAG_DENYLIST.has(cleaned)) return false;
  if (CURATED_GENRE_TOKENS.has(cleaned)) return true;
  const dedup = canonicalGenreDedupeKey(cleaned);
  if (NOISE_TAG_DENYLIST.has(dedup)) return false;
  for (const kw of [
    'rock', 'punk', 'metal', 'pop', 'jazz', 'blues', 'soul', 'funk', 'folk',
    'house', 'techno', 'trance', 'ambient', 'electro', 'hip hop', 'hip-hop', 'rap',
    'reggae', 'ska', 'dub', 'disco', 'wave', 'core', 'grunge', 'indie', 'goth',
    'industrial', 'classical', 'baroque', 'opera', 'country', 'bluegrass', 'swing',
    'bossa', 'salsa', 'afrobeat', 'synth', 'drone', 'shoegaze', 'emo', 'grime', 'trap',
  ]) {
    if (cleaned.includes(kw)) return true;
  }
  return false;
}

function filterSubgenres(genres: string[], preferSubgenres = true): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of genres) {
    const formatted = formatGenreToken(raw);
    if (!formatted) continue;
    const key = canonicalGenreDedupeKey(formatted);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(formatted);
  }
  if (!preferSubgenres || cleaned.length <= 1) {
    return cleaned;
  }
  const specific = cleaned.filter((g) => !BROAD_UMBRELLA_GENRES.has(canonicalGenreDedupeKey(g)));
  return specific.length > 0 ? specific : cleaned;
}

function mergeFormattedGenres(items: string[], maxItems = 7, preferSubgenres?: boolean): string {
  const effectivePrefer =
    preferSubgenres ?? (requestMetaContext.getStore()?.preferSubgenres ?? true);
  const expanded: string[] = [];
  for (const rawEntry of items) {
    const subParts = String(rawEntry || '')
      .split(/[;,]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    expanded.push(...subParts);
  }
  return filterSubgenres(expanded, effectivePrefer).slice(0, maxItems).join('; ');
}

function extractRecordingGenres(rec: any, preferSubgenres?: boolean): string[] {
  if (!rec || typeof rec !== 'object') return [];
  const rawItems: Array<{ name?: string; count?: number }> = [...(rec.genres || [])];
  if (rawItems.length === 0) {
    const tags: Array<{ name?: string; count?: number }> = [...(rec.tags || [])];
    rawItems.push(
      ...tags.filter((t) => Number(t.count || 0) > 0 && isValidMusicGenreTag(String(t.name || '')))
    );
  }
  rawItems.sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
  const names = rawItems.map((i) => String(i.name || '').trim()).filter(Boolean);
  const effectivePrefer =
    preferSubgenres ?? (requestMetaContext.getStore()?.preferSubgenres ?? true);
  return filterSubgenres(names, effectivePrefer).slice(0, 5);
}

function extractMusicBrainzGenres(rel: any, preferSubgenres?: boolean): string[] {
  const rawItems: Array<{ name?: string; count?: number }> = [
    ...(rel['release-group']?.genres || []),
    ...(rel.genres || []),
  ];
  if (rawItems.length === 0) {
    const tags: Array<{ name?: string; count?: number }> = [
      ...(rel['release-group']?.tags || []),
      ...(rel.tags || []),
    ];
    rawItems.push(
      ...tags.filter((t) => Number(t.count || 0) > 0 && isValidMusicGenreTag(String(t.name || '')))
    );
  }

  rawItems.sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
  const names = rawItems.map((item) => String(item.name || '').trim()).filter(Boolean);
  const effectivePrefer =
    preferSubgenres ?? (requestMetaContext.getStore()?.preferSubgenres ?? true);
  return filterSubgenres(names, effectivePrefer);
}

function computeCandidateQuality(
  cand: any,
  expectedTrackCount = 0
): { qualityScore: number; qualityBadges: string[] } {
  const badges: string[] = [];
  let q = Math.min(50, Math.round(Number(cand?.score || 0) * 0.5));
  const genres: string[] = Array.isArray(cand?.genres) ? cand.genres.filter(Boolean) : [];
  if (genres.length > 0) {
    const hasSpecific = genres.some((g) => !BROAD_UMBRELLA_GENRES.has(canonicalGenreDedupeKey(g)));
    q += hasSpecific ? 22 : 12;
    badges.push(cand?.source === 'discogs' ? 'Styles' : hasSpecific ? 'Subgenres' : 'Genres');
  }
  if (String(cand?.barcode || '').trim()) {
    q += 8;
    badges.push('Barcode');
  }
  if (String(cand?.label || '').trim() || String(cand?.catno || '').trim()) {
    q += 7;
    badges.push('Label');
  }
  if (cand?.hasCover) {
    q += 6;
    badges.push('Cover');
  }
  if (expectedTrackCount > 0 && Number(cand?.trackCount || 0) === expectedTrackCount) {
    q += 12;
    badges.push('Exakte Tracks');
  }
  if (String(cand?.method || '').includes('Fast-Path')) {
    q += 15;
    badges.unshift('Fast-Path');
  }
  return { qualityScore: Math.min(100, q), qualityBadges: badges };
}

const UUID_REGEX = /^[a-f0-9-]{36}$/i;

async function fetchWikidataGenres(
  releaseId: string,
  releaseGroupId: string,
  artistId: string
): Promise<string[]> {
  const unions: string[] = [];
  if (releaseId && UUID_REGEX.test(releaseId.trim())) {
    unions.push(`{ BIND(1 AS ?prio) ?item wdt:P5813 "${releaseId.trim()}" . ?item wdt:P136 ?genre . }`);
  }
  if (releaseGroupId && UUID_REGEX.test(releaseGroupId.trim())) {
    unions.push(`{ BIND(2 AS ?prio) ?item wdt:P436 "${releaseGroupId.trim()}" . ?item wdt:P136 ?genre . }`);
  }
  for (const aid of artistId.split(';').map((s) => s.trim()).filter(Boolean).slice(0, 2)) {
    if (UUID_REGEX.test(aid)) {
      unions.push(`{ BIND(3 AS ?prio) ?item wdt:P434 "${aid}" . ?item wdt:P136 ?genre . }`);
    }
  }
  if (unions.length === 0) return [];

  const sparql = `SELECT DISTINCT ?prio ?genreLabel WHERE {\n  ${unions.join('\n  UNION\n  ')}\n  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de". }\n}\nORDER BY ?prio\nLIMIT 20`;
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(5500),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { results?: { bindings?: Array<{ genreLabel?: { value?: string } }> } };
    return (data.results?.bindings || [])
      .map((b) => String(b.genreLabel?.value || '').trim())
      .filter((v) => v.length > 0 && !/^Q\d+$/.test(v));
  } catch {
    return [];
  }
}

async function fetchWikidataGenresByName(artistName: string, albumTitle: string): Promise<string[]> {
  const searchTerm = `${artistName} ${albumTitle}`.trim();
  if (!searchTerm) return [];
  try {
    const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(searchTerm)}&language=en&format=json&limit=3`;
    const searchResp = await fetch(searchUrl, {
      headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(5500),
    });
    if (!searchResp.ok) return [];
    const sdata = (await searchResp.json()) as { search?: Array<{ id?: string }> };
    const qids = (sdata.search || [])
      .map((item) => String(item.id || ''))
      .filter((id) => /^Q\d+$/.test(id))
      .slice(0, 3);
    if (qids.length === 0) return [];

    const qidValues = qids.map((q) => `wd:${q}`).join(' ');
    const sparql = `SELECT DISTINCT ?genreLabel WHERE { VALUES ?item { ${qidValues} } ?item wdt:P136 ?genre . SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de". } } LIMIT 12`;
    const qUrl = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
    const qResp = await fetch(qUrl, {
      headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(5500),
    });
    if (!qResp.ok) return [];
    const qData = (await qResp.json()) as { results?: { bindings?: Array<{ genreLabel?: { value?: string } }> } };
    return (qData.results?.bindings || [])
      .map((b) => String(b.genreLabel?.value || '').trim())
      .filter((v) => v.length > 0 && !/^Q\d+$/.test(v));
  } catch {
    return [];
  }
}

async function fetchWikidataTrackGenres(
  recordingId: string,
  workId: string,
  releaseGroupId: string,
  artistIds: string[],
  artistName: string,
  trackTitle: string
): Promise<string[]> {
  const unions: string[] = [];
  if (recordingId && UUID_REGEX.test(recordingId.trim())) {
    unions.push(`{ BIND(1 AS ?prio) ?item wdt:P4404 "${recordingId.trim()}" . ?item wdt:P136 ?genre . }`);
  }
  if (workId && UUID_REGEX.test(workId.trim())) {
    unions.push(`{ BIND(2 AS ?prio) ?item wdt:P435 "${workId.trim()}" . ?item wdt:P136 ?genre . }`);
  }
  if (releaseGroupId && UUID_REGEX.test(releaseGroupId.trim())) {
    unions.push(`{ BIND(3 AS ?prio) ?item wdt:P436 "${releaseGroupId.trim()}" . ?item wdt:P136 ?genre . }`);
  }
  for (const aid of artistIds.filter((x) => UUID_REGEX.test(x)).slice(0, 2)) {
    unions.push(`{ BIND(4 AS ?prio) ?item wdt:P434 "${aid}" . ?item wdt:P136 ?genre . }`);
  }

  const genres: string[] = [];
  if (unions.length > 0) {
    const sparql = `SELECT DISTINCT ?prio ?genreLabel WHERE {\n  ${unions.join('\n  UNION\n  ')}\n  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de". }\n}\nORDER BY ?prio\nLIMIT 20`;
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(5500),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          results?: { bindings?: Array<{ genreLabel?: { value?: string } }> };
        };
        for (const b of data.results?.bindings || []) {
          const val = String(b.genreLabel?.value || '').trim();
          if (val && !/^Q\d+$/.test(val)) genres.push(val);
        }
      }
    } catch {
      // Fallback unten
    }
  }

  if (genres.length === 0 && (trackTitle || artistName)) {
    const primaryArtist = artistName ? artistName.split(';')[0].trim() : '';
    const terms = [`${trackTitle} ${primaryArtist}`.trim(), primaryArtist].filter(Boolean);
    for (const term of terms) {
      try {
        const sUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(term)}&language=en&format=json&limit=3`;
        const sResp = await fetch(sUrl, {
          headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(5500),
        });
        if (!sResp.ok) continue;
        const sData = (await sResp.json()) as { search?: Array<{ id?: string }> };
        const qids = (sData.search || [])
          .map((item) => String(item.id || ''))
          .filter((id) => /^Q\d+$/.test(id))
          .slice(0, 3);
        if (qids.length === 0) continue;

        const qidValues = qids.map((q) => `wd:${q}`).join(' ');
        const sparql = `SELECT DISTINCT ?genreLabel WHERE { VALUES ?item { ${qidValues} } ?item wdt:P136 ?genre . SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de". } } LIMIT 12`;
        const qResp = await fetch(
          `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
          {
            headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(5500),
          }
        );
        if (qResp.ok) {
          const qData = (await qResp.json()) as {
            results?: { bindings?: Array<{ genreLabel?: { value?: string } }> };
          };
          for (const b of qData.results?.bindings || []) {
            const val = String(b.genreLabel?.value || '').trim();
            if (val && !/^Q\d+$/.test(val)) genres.push(val);
          }
        }
        if (genres.length > 0) break;
      } catch {
        // Ignorieren
      }
    }
  }

  return genres;
}

function formatArtistSortCredit(
  credits?: Array<{ name?: string; artist?: { name?: string; 'sort-name'?: string }; joinphrase?: string }>
): string {
  if (!Array.isArray(credits) || credits.length === 0) return '';
  const raw = credits
    .map((c) => `${c.artist?.['sort-name'] || c.name || c.artist?.name || ''}${c.joinphrase || ''}`)
    .join('')
    .trim();
  return normalizeMultiArtist(raw);
}

function extractArtistIds(credits?: Array<{ artist?: { id?: string } }>): string {
  if (!Array.isArray(credits)) return '';
  const ids: string[] = [];
  for (const c of credits) {
    if (c.artist?.id && !ids.includes(c.artist.id)) {
      ids.push(c.artist.id);
    }
  }
  return ids.join('; ');
}

function extractArtistNames(
  credits?: Array<{ name?: string; artist?: { name?: string } }>
): string[] {
  if (!Array.isArray(credits)) return [];
  const names: string[] = [];
  for (const c of credits) {
    const n = String(c?.name || c?.artist?.name || '').trim();
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

function extractReleaseCountries(rel: any): string {
  const codes: string[] = [];
  const primary = String(rel?.country || '').trim();
  if (primary) codes.push(primary);
  for (const ev of rel?.['release-events'] || []) {
    const areaCodes = ev?.area?.['iso-3166-1-codes'];
    if (Array.isArray(areaCodes)) {
      for (const code of areaCodes) {
        const c = String(code || '').trim();
        if (c && !codes.includes(c)) codes.push(c);
      }
    }
  }
  return codes.join('; ');
}

function collectArtistRoleIds(relations: any[] | undefined, targetRoles: string[]): string[] {
  const ids: string[] = [];
  for (const rel of relations || []) {
    if (rel?.['target-type'] === 'artist' && rel?.artist?.id) {
      const role = String(rel.type || '').trim().toLowerCase();
      if (targetRoles.includes(role)) {
        const id = String(rel.artist.id).trim();
        if (id && !ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
}

function collectArtistRelations(relations?: any[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const rel of relations || []) {
    if (rel?.['target-type'] === 'artist' && rel?.artist?.name) {
      const role = String(rel.type || '').trim().toLowerCase();
      const name = String(rel.artist.name || '').trim();
      if (!role || !name) continue;
      const attrs = Array.isArray(rel.attributes)
        ? rel.attributes.map((a: any) => String(a || '').trim()).filter(Boolean)
        : [];
      const formatted =
        attrs.length > 0 && (role === 'instrument' || role === 'vocal' || role === 'performer')
          ? `${name} (${attrs.join(', ')})`
          : name;
      const list = (map[role] = map[role] || []);
      if (!list.includes(formatted)) {
        list.push(formatted);
      }
    }
  }
  return map;
}

function cleanDiscogsName(name: string): string {
  return String(name || '').trim().replace(/\s*\(\d+\)$/, '').trim();
}

function formatDiscogsArtists(artists?: any[]): string {
  if (!Array.isArray(artists) || artists.length === 0) return 'Unbekannter Künstler';
  const parts: string[] = [];
  for (let i = 0; i < artists.length; i++) {
    const art = artists[i];
    if (!art || typeof art !== 'object') continue;
    const name = cleanDiscogsName(art.anv || art.name || '');
    if (!name) continue;
    const join = String(art.join || '').trim();
    if (parts.length > 0 && !/[ /&,-]$/.test(parts[parts.length - 1])) {
      parts.push(' ');
    }
    parts.push(name);
    if (join && i < artists.length - 1) {
      parts.push(join === ',' || join === '/' ? `${join} ` : ` ${join} `);
    }
  }
  const combined = normalizeMultiArtist(parts.join('').trim());
  return combined || 'Unbekannter Künstler';
}

function parseDiscogsDuration(raw: string): number {
  const text = String(raw || '').trim();
  if (!text || !text.includes(':')) return 0;
  const segs = text.split(':').map((s) => Number(s));
  if (segs.some((n) => !Number.isFinite(n))) return 0;
  if (segs.length === 2) return Math.max(0, segs[0] * 60 + segs[1]);
  if (segs.length === 3) return Math.max(0, segs[0] * 3600 + segs[1] * 60 + segs[2]);
  return 0;
}

function parseDiscogsPosition(pos: string, fallbackIdx: number): { disc: number; track: number } {
  const clean = String(pos || '').trim();
  const multi = clean.match(/^(?:CD|DISC)?\s*(\d{1,2})\s*[-.:]\s*(\d{1,3})$/i);
  if (multi) {
    return { disc: Math.max(1, Number(multi[1])), track: Math.max(1, Number(multi[2])) };
  }
  const single = clean.match(/^(\d{1,3})$/);
  if (single) {
    return { disc: 1, track: Math.max(1, Number(single[1])) };
  }
  return { disc: 1, track: fallbackIdx };
}

function formatLogLine(msg: string): string {
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8);
  const line = `[${ts}] ${msg}`;
  console.log(`[MintRip Abfrage] ${line}`);
  return line;
}

let mbQueueTail: Promise<void> = Promise.resolve();
let lastMbStartedAt = 0;
let mbCooldownUntil = 0;
let mbMinIntervalMs = 1180;
let mbConsecutive503 = 0;
let mbCircuitOpenUntil = 0;

function isMusicBrainzCircuitOpen(): boolean {
  return Date.now() < mbCircuitOpenUntil;
}

async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterMs(headerVal: string | null): number {
  if (!headerVal) return 0;
  const trimmed = headerVal.trim();
  const secs = Number(trimmed);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.round(secs * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return 0;
}

async function runSerializedMbRequest(fn: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
  const prev = mbQueueTail;
  let release!: () => void;
  mbQueueTail = new Promise<void>((res) => {
    release = res;
  });
  try {
    await prev;
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const now = Date.now();
    const nextIntervalAt = lastMbStartedAt > 0 ? lastMbStartedAt + mbMinIntervalMs : 0;
    const targetAt = Math.max(nextIntervalAt, mbCooldownUntil);
    if (targetAt > now) {
      await sleepMs(targetAt - now, signal);
    }
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Startzeit-Token-Bucket: Intervall läuft bereits während der HTTP-Antwortzeit!
    lastMbStartedAt = Date.now();
    const resp = await fn();

    if (resp.status === 503 || resp.status === 429) {
      mbConsecutive503 += 1;
      mbMinIntervalMs = Math.min(3200, Math.max(1600, mbMinIntervalMs + 450));
      const retryAfterMs = parseRetryAfterMs(resp.headers.get('retry-after'));
      const cooldownSpan = Math.max(retryAfterMs + 250, mbMinIntervalMs);
      mbCooldownUntil = Math.max(mbCooldownUntil, Date.now() + cooldownSpan);
      if (mbConsecutive503 >= 4) {
        mbCircuitOpenUntil = Math.max(mbCircuitOpenUntil, Date.now() + 10000);
      }
    } else {
      mbConsecutive503 = 0;
      mbMinIntervalMs = Math.max(1180, mbMinIntervalMs - 100);
    }
    return resp;
  } finally {
    release();
  }
}

async function fetchWithExponentialBackoff(
  url: string,
  options: RequestInit = {},
  maxRetries = 2,
  logs?: string[],
  label = 'API',
  onLogLine?: (line: string) => void,
  waitOnCircuit = false
): Promise<Response> {
  const effectiveUrl = rewriteMusicBrainzUrl(url);
  const method = String(options.method || 'GET').toUpperCase();
  const ttlMs = method === 'GET' ? getCacheTtlMsForUrl(effectiveUrl) : 0;

  if (ttlMs > 0) {
    const cachedBody = readMetadataCache(effectiveUrl);
    if (cachedBody !== null) {
      return new Response(cachedBody, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-mintrip-cache': 'HIT' },
      });
    }
  }

  const isOfficialMb = isOfficialMusicBrainzUrl(effectiveUrl);
  const effectiveMaxRetries = isOfficialMb ? Math.min(2, maxRetries) : Math.min(3, maxRetries);
  const signal = options.signal as AbortSignal | undefined;
  let lastError: Error | null = null;

  const pushMsg = (msg: string) => {
    const formatted = formatLogLine(msg);
    logs?.push(formatted);
    onLogLine?.(formatted);
  };

  if (isOfficialMb) {
    const nowMs = Date.now();
    if (mbCircuitOpenUntil > 0 && nowMs >= mbCircuitOpenUntil) {
      mbCircuitOpenUntil = 0;
      mbConsecutive503 = 0;
    } else if (nowMs < mbCircuitOpenUntil) {
      const remMs = Math.max(500, mbCircuitOpenUntil - nowMs);
      const waitSec = Math.max(1, Math.ceil(remMs / 1000));
      if (waitOnCircuit) {
        pushMsg(
          `${label}: Rate-Limit-Abkühlpause (${waitSec}s) – warte kurz ab und setze danach fort…`
        );
        await sleepMs(remMs + 150, signal);
        mbCircuitOpenUntil = 0;
        mbConsecutive503 = 0;
      } else {
        pushMsg(
          `${label}: MusicBrainz-Circuit-Breaker aktiv (${waitSec}s Schutzpause nach mehrfachem HTTP 503/429) – überspringe Anfrage.`
        );
        return new Response(JSON.stringify({ error: 'MusicBrainz Circuit-Breaker aktiv' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
  }

  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      const timeoutSignal = AbortSignal.timeout(12000);
      const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const doFetch = () =>
        fetch(effectiveUrl, {
          ...options,
          signal: effectiveSignal,
        });

      const resp = isOfficialMb ? await runSerializedMbRequest(doFetch, signal) : await doFetch();

      if ([503, 429, 502, 504].includes(resp.status)) {
        if (isOfficialMb && isMusicBrainzCircuitOpen()) {
          if (waitOnCircuit && attempt < effectiveMaxRetries) {
            const remMs = Math.max(500, mbCircuitOpenUntil - Date.now());
            pushMsg(
              `${label}: Wiederholtes Rate-Limit (HTTP ${resp.status}) – warte ${Math.ceil(remMs / 1000)}s Abkühlpause und versuche erneut…`
            );
            await sleepMs(remMs + 150, signal);
            mbCircuitOpenUntil = 0;
            mbConsecutive503 = 0;
            continue;
          }
          pushMsg(
            `${label}: MusicBrainz-Circuit-Breaker ausgelöst (4× HTTP ${resp.status}) – weiche auf andere Quellen aus.`
          );
          return resp;
        }
        if (attempt < effectiveMaxRetries) {
          const retryAfterMs = parseRetryAfterMs(resp.headers.get('retry-after'));
          const expWaitMs = Math.round(1800 * Math.pow(1.7, attempt));
          const waitMs = Math.min(12000, Math.max(retryAfterMs > 0 ? retryAfterMs + 250 : 0, expWaitMs));
          if (isOfficialMb) {
            mbCooldownUntil = Math.max(mbCooldownUntil, Date.now() + waitMs);
          }
          pushMsg(
            `${label}: HTTP ${resp.status} (Rate-Limit / Server ausgelastet) – Wiederholungsversuch ${
              attempt + 1
            }/${effectiveMaxRetries} in ${(waitMs / 1000).toFixed(1)}s...`
          );
          if (!isOfficialMb) {
            await sleepMs(waitMs, signal);
          }
          continue;
        }
      }

      if (resp.ok && ttlMs > 0) {
        const bodyText = await resp.text();
        if (bodyText.trim().startsWith('{') || bodyText.trim().startsWith('[')) {
          writeMetadataCache(effectiveUrl, bodyText, ttlMs);
        }
        return new Response(bodyText, {
          status: resp.status,
          statusText: resp.statusText,
          headers: resp.headers,
        });
      }

      return resp;
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < effectiveMaxRetries) {
        const waitMs = Math.min(10000, Math.round(1600 * Math.pow(1.7, attempt)));
        if (isOfficialMb) {
          mbCooldownUntil = Math.max(mbCooldownUntil, Date.now() + waitMs);
        }
        pushMsg(
          `${label}: Netzwerkfehler (${lastError.message}) – Wiederholungsversuch ${
            attempt + 1
          }/${effectiveMaxRetries} in ${(waitMs / 1000).toFixed(1)}s...`
        );
        if (!isOfficialMb) {
          await sleepMs(waitMs, signal);
        }
        continue;
      }
    }
  }

  throw lastError || new Error(`${label}: Verbindung nach ${effectiveMaxRetries} Wiederholungsversuchen fehlgeschlagen.`);
}

async function fetchLastfmTopTags(
  method: 'track.getTopTags' | 'album.getTopTags' | 'artist.getTopTags',
  params: Record<string, string>,
  apiKey: string,
  preferSubgenres = true
): Promise<string[]> {
  const key = String(apiKey || '').trim();
  if (!key) return [];
  const qs = new URLSearchParams({
    method,
    ...params,
    autocorrect: '1',
    format: 'json',
    api_key: key,
  });
  const url = `https://ws.audioscrobbler.com/2.0/?${qs.toString()}`;
  try {
    const resp = await fetchWithExponentialBackoff(
      url,
      { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
      1,
      undefined,
      'Last.fm Tags'
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      toptags?: { tag?: Array<{ name?: string; count?: number | string }> };
    };
    const rawTags = Array.isArray(data?.toptags?.tag) ? data.toptags!.tag! : [];
    const valid = rawTags
      .filter((t) => Number(t.count ?? 100) >= 15 && isValidMusicGenreTag(String(t.name || '')))
      .map((t) => String(t.name || '').trim());
    return filterSubgenres(valid, preferSubgenres).slice(0, 4);
  } catch {
    return [];
  }
}

async function fetchDiscogsStylesForAlbum(
  artist: string,
  albumTitle: string,
  discogsReleaseId: string,
  customToken?: string,
  logs?: string[]
): Promise<{ styles: string[]; genres: string[] }> {
  const effectiveToken = String(customToken || process.env.DISCOGS_TOKEN || '').trim();
  const styles: string[] = [];
  const genres: string[] = [];
  const collectFromRel = (rel: any) => {
    for (const s of rel?.styles || []) {
      const val = String(s || '').trim();
      if (val && !styles.includes(val)) styles.push(val);
    }
    for (const g of rel?.genres || []) {
      const val = String(g || '').trim();
      if (val && !genres.includes(val)) genres.push(val);
    }
  };

  try {
    let cleanRelId = String(discogsReleaseId || '').replace(/^discogs:/i, '').trim();
    if (/^\d+$/.test(cleanRelId)) {
      const rResp = await fetchWithExponentialBackoff(
        `https://api.discogs.com/releases/${cleanRelId}`,
        { headers: discogsHeaders(effectiveToken) },
        1,
        logs,
        'Discogs Styles'
      );
      if (rResp.ok) {
        const rel = (await rResp.json()) as any;
        collectFromRel(rel);
        if (rel?.master_id && styles.length < 3) {
          const mResp = await fetchWithExponentialBackoff(
            `https://api.discogs.com/masters/${rel.master_id}`,
            { headers: discogsHeaders(effectiveToken) },
            1,
            logs,
            'Discogs Master Styles'
          );
          if (mResp.ok) {
            collectFromRel(await mResp.json());
          }
        }
      }
    } else if (artist && albumTitle) {
      const q = `${artist} ${albumTitle}`.trim();
      const sResp = await fetchWithExponentialBackoff(
        `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=master&per_page=3`,
        { headers: discogsHeaders(effectiveToken) },
        1,
        logs,
        'Discogs Master-Suche'
      );
      if (sResp.ok) {
        const data = (await sResp.json()) as { results?: any[] };
        for (const item of (data.results || []).slice(0, 2)) {
          collectFromRel({ styles: item?.style, genres: item?.genre });
        }
      }
    }
  } catch {
    // Optionaler Schritt
  }
  return { styles, genres };
}

async function enrichAlbumTrackGenres(opts: {
  artist: string;
  albumTitle: string;
  albumGenre: string;
  musicbrainzReleaseId?: string;
  musicbrainzReleaseGroupId?: string;
  discogsReleaseId?: string;
  tracks: Array<{
    id?: string;
    trackNumber?: number;
    title: string;
    artist?: string;
    genre?: string;
    musicbrainzRecordingId?: string;
  }>;
  discogsToken?: string;
  lastfmApiKey?: string;
  preferSubgenres?: boolean;
  logs?: string[];
}): Promise<{
  albumGenre: string;
  trackGenres: Record<string, string>;
  updatedTracks: number;
  sources: string[];
}> {
  const preferSubgenres = opts.preferSubgenres ?? true;
  const logs = opts.logs;
  const sources: string[] = [];
  const albumPool: string[] = opts.albumGenre ? [opts.albumGenre] : [];
  const perTrackMap = new Map<string, string[]>();

  const normTitleKey = (t: string) =>
    String(t || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .trim();

  const addTrackGenres = (key: string, items: string[]) => {
    if (!key || items.length === 0) return;
    const arr = perTrackMap.get(key) || [];
    arr.push(...items);
    perTrackMap.set(key, arr);
  };

  // 1. MusicBrainz Release-Group-Geschwisterpressungen (sammelt fehlende Recording- & RG-Subgenres)
  let rgId = String(opts.musicbrainzReleaseGroupId || '').trim();
  const relId = String(opts.musicbrainzReleaseId || '').trim();
  if (!rgId && UUID_REGEX.test(relId) && !isMusicBrainzCircuitOpen()) {
    try {
      const rResp = await fetchWithExponentialBackoff(
        `https://musicbrainz.org/ws/2/release/${relId}?inc=release-groups+genres+tags&fmt=json`,
        { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
        1,
        logs,
        'MusicBrainz Release-Group'
      );
      if (rResp.ok) {
        const rData = (await rResp.json()) as any;
        rgId = String(rData?.['release-group']?.id || '').trim();
        const g = extractMusicBrainzGenres(rData, preferSubgenres);
        if (g.length > 0) albumPool.push(...g);
      }
    } catch {
      // Weiter mit anderen Quellen
    }
  }

  if (UUID_REGEX.test(rgId) && !isMusicBrainzCircuitOpen()) {
    try {
      const rgResp = await fetchWithExponentialBackoff(
        `https://musicbrainz.org/ws/2/release-group/${rgId}?inc=releases+genres+tags&fmt=json`,
        { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
        1,
        logs,
        'MusicBrainz Release-Group-Merge'
      );
      if (rgResp.ok) {
        const rgData = (await rgResp.json()) as any;
        const rgGenres = extractMusicBrainzGenres({ 'release-group': rgData }, preferSubgenres);
        if (rgGenres.length > 0) {
          albumPool.push(...rgGenres);
          sources.push('MusicBrainz Release-Group');
        }
        const siblingReleases: any[] = Array.isArray(rgData?.releases) ? rgData.releases : [];
        const otherSiblings = siblingReleases
          .filter((r) => r?.id && String(r.id) !== relId)
          .slice(0, 2);
        let siblingTrackHits = 0;
        for (const sib of otherSiblings) {
          if (isMusicBrainzCircuitOpen()) break;
          const sibResp = await fetchWithExponentialBackoff(
            `https://musicbrainz.org/ws/2/release/${sib.id}?inc=recordings+genres+tags&fmt=json`,
            { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
            1,
            logs,
            'MusicBrainz Geschwister-Pressung'
          );
          if (!sibResp.ok) continue;
          const sibData = (await sibResp.json()) as any;
          const sibAlbGenres = extractMusicBrainzGenres(sibData, preferSubgenres);
          if (sibAlbGenres.length > 0) albumPool.push(...sibAlbGenres);
          for (const m of sibData?.media || []) {
            for (const t of m?.tracks || []) {
              const rec = t?.recording || {};
              const recGenres = extractRecordingGenres(rec, preferSubgenres);
              if (recGenres.length > 0) {
                siblingTrackHits++;
                if (rec.id) addTrackGenres(`rec:${rec.id}`, recGenres);
                const tk = normTitleKey(t.title || rec.title || '');
                if (tk) addTrackGenres(`title:${tk}`, recGenres);
              }
            }
          }
          if (siblingTrackHits >= Math.max(1, Math.floor(opts.tracks.length * 0.5))) {
            break;
          }
        }
        if (siblingTrackHits > 0) {
          sources.push(`MB Geschwister-Pressungen (${siblingTrackHits} Tracks)`);
          logs?.push(
            formatLogLine(
              `Track-Genre-Enrichment: ${siblingTrackHits} Track-Genres aus MusicBrainz Release-Group-Pressungen übernommen.`
            )
          );
        }
      }
    } catch {
      // Weiter mit Discogs & Last.fm
    }
  }

  // 2. Discogs Master/Release Styles (liefert präzise Subgenres wie "Hardcore", "Skate", "Punk")
  const dgData = await fetchDiscogsStylesForAlbum(
    opts.artist,
    opts.albumTitle,
    opts.discogsReleaseId || '',
    opts.discogsToken,
    logs
  );
  if (dgData.styles.length > 0 || dgData.genres.length > 0) {
    albumPool.push(...dgData.styles, ...dgData.genres);
    sources.push(dgData.styles.length > 0 ? 'Discogs Styles' : 'Discogs Genres');
    logs?.push(
      formatLogLine(
        `Track-Genre-Enrichment: Discogs lieferte ${(dgData.styles.length > 0 ? dgData.styles : dgData.genres).join(', ')}.`
      )
    );
  }

  // 3. Optional: Last.fm parallele Track-Tag-Abfrage (kein 1-Req/s-Limit, extrem schnell!)
  const lfmKey = String(opts.lastfmApiKey || '').trim();
  if (lfmKey && opts.artist && opts.tracks.length > 0) {
    const primaryAlbumArtist = opts.artist.split(';')[0].trim();
    const albumLfmTags = await fetchLastfmTopTags(
      'album.getTopTags',
      { artist: primaryAlbumArtist, album: opts.albumTitle },
      lfmKey,
      preferSubgenres
    );
    if (albumLfmTags.length > 0) {
      albumPool.push(...albumLfmTags);
      sources.push('Last.fm Album-Tags');
    }

    const targets = opts.tracks.slice(0, 20);
    let lfmTrackHits = 0;
    const batchSize = 6;
    for (let i = 0; i < targets.length; i += batchSize) {
      const batch = targets.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (trk) => {
          const trkArtist = (trk.artist || primaryAlbumArtist).split(';')[0].trim();
          const tags = await fetchLastfmTopTags(
            'track.getTopTags',
            { artist: trkArtist, track: trk.title },
            lfmKey,
            preferSubgenres
          );
          return { trk, tags };
        })
      );
      for (const { trk, tags } of results) {
        if (tags.length > 0) {
          lfmTrackHits++;
          if (trk.id) addTrackGenres(`id:${trk.id}`, tags);
          const tk = normTitleKey(trk.title);
          if (tk) addTrackGenres(`title:${tk}`, tags);
        }
      }
    }
    if (lfmTrackHits > 0) {
      sources.push(`Last.fm Track-Tags (${lfmTrackHits} Tracks)`);
      logs?.push(
        formatLogLine(`Track-Genre-Enrichment: Last.fm lieferte Subgenres für ${lfmTrackHits} Titel.`)
      );
    }
  }

  const finalAlbumGenre = mergeFormattedGenres(albumPool, 5, preferSubgenres);
  const trackGenres: Record<string, string> = {};
  let updatedTracks = 0;

  for (let i = 0; i < opts.tracks.length; i++) {
    const trk = opts.tracks[i];
    const keyOut = trk.id || String(trk.trackNumber || i + 1);
    const existingRaw = String(trk.genre || '').trim();
    const collected: string[] = [];
    if (existingRaw) collected.push(existingRaw);
    if (trk.id && perTrackMap.has(`id:${trk.id}`)) {
      collected.push(...(perTrackMap.get(`id:${trk.id}`) || []));
    }
    if (trk.musicbrainzRecordingId && perTrackMap.has(`rec:${trk.musicbrainzRecordingId}`)) {
      collected.push(...(perTrackMap.get(`rec:${trk.musicbrainzRecordingId}`) || []));
    }
    const tk = normTitleKey(trk.title);
    if (tk && perTrackMap.has(`title:${tk}`)) {
      collected.push(...(perTrackMap.get(`title:${tk}`) || []));
    }
    // Wenn Track noch kein spezifisches Subgenre hat, erbe das spezifische Album-Subgenre
    const currentMerged = mergeFormattedGenres(collected, 4, preferSubgenres);
    const currentTokens = currentMerged.split(/\s*;\s*/).filter(Boolean);
    const hasSpecificTrackGenre = currentTokens.some(
      (g) => !BROAD_UMBRELLA_GENRES.has(canonicalGenreDedupeKey(g))
    );
    const finalTrackGenre = hasSpecificTrackGenre
      ? currentMerged
      : mergeFormattedGenres([...collected, finalAlbumGenre], 4, preferSubgenres);

    if (finalTrackGenre) {
      trackGenres[keyOut] = finalTrackGenre;
      if (finalTrackGenre !== existingRaw) {
        updatedTracks++;
      }
    }
  }

  return {
    albumGenre: finalAlbumGenre || opts.albumGenre,
    trackGenres,
    updatedTracks,
    sources: Array.from(new Set(sources)),
  };
}

function scoreReleaseDurationMatch(rel: any, targetDurations: number[]): number {
  if (!Array.isArray(targetDurations) || targetDurations.length === 0) {
    return Number(rel?.score || 85);
  }
  const n = targetDurations.length;
  const mediaList: any[] = Array.isArray(rel?.media) ? rel.media : [];
  let bestScore = 0;

  for (const med of mediaList) {
    const tracks: any[] = Array.isArray(med?.tracks) ? med.tracks : [];
    const trackCount = Number(med?.['track-count'] || tracks.length || 0);
    if (trackCount !== n) continue;

    if (tracks.length === n) {
      let diffs = 0;
      let valid = 0;
      for (let i = 0; i < n; i++) {
        const lenMs = Number(tracks[i]?.length || tracks[i]?.recording?.length || 0);
        if (lenMs > 0 && targetDurations[i] > 0) {
          diffs += Math.abs(lenMs / 1000 - targetDurations[i]);
          valid++;
        }
      }
      if (valid > 0) {
        const avgDiff = diffs / valid;
        if (avgDiff <= 1.5) bestScore = Math.max(bestScore, 100);
        else if (avgDiff <= 3.5) bestScore = Math.max(bestScore, 96);
        else if (avgDiff <= 7.0) bestScore = Math.max(bestScore, 90);
        else if (avgDiff <= 15.0) bestScore = Math.max(bestScore, 80);
        else bestScore = Math.max(bestScore, Math.max(45, Math.round(75 - avgDiff)));
      } else {
        bestScore = Math.max(bestScore, 78);
      }
    } else {
      bestScore = Math.max(bestScore, 76);
    }
  }

  return bestScore;
}

function discogsHeaders(customToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': DISCOGS_USER_AGENT,
    Accept: 'application/json',
  };
  const token = String(customToken || process.env.DISCOGS_TOKEN || '').trim();
  if (token) {
    headers.Authorization = `Discogs token=${token}`;
  }
  return headers;
}

function extractAmazonAsinFromRelations(rel: any): string {
  const direct = String(rel?.asin || '').trim().toUpperCase();
  if (/^[A-Z0-9]{10}$/.test(direct)) return direct;
  for (const r of rel?.relations || []) {
    const resUrl = String(r?.url?.resource || '');
    const m = resUrl.match(/amazon\.[a-z.]+\/(?:[^/]+\/)?(?:dp|gp\/product|exec\/obidos\/ASIN)\/([A-Z0-9]{10})/i);
    if (m) return m[1].toUpperCase();
  }
  return '';
}

async function resolveAmazonAsinHelper(params: {
  asin?: string;
  mbid?: string;
  artist?: string;
  title?: string;
  barcode?: string;
}): Promise<string> {
  const rawAsin = String(params.asin || '').trim();
  if (rawAsin) {
    const urlMatch = rawAsin.match(/(?:dp|gp\/product|ASIN)\/([A-Z0-9]{10})/i);
    if (urlMatch) return urlMatch[1].toUpperCase();
    const cleaned = rawAsin.toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(cleaned)) return cleaned;
  }

  const mbid = String(params.mbid || '').trim();
  if (UUID_REGEX.test(mbid)) {
    try {
      const resp = await fetchWithExponentialBackoff(
        `https://musicbrainz.org/ws/2/release/${encodeURIComponent(mbid)}?inc=url-rels&fmt=json`,
        {
          headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
        },
        2,
        undefined,
        'MusicBrainz ASIN'
      );
      if (resp.ok) {
        const rel = await resp.json();
        const found = extractAmazonAsinFromRelations(rel);
        if (found) return found;
      }
    } catch {
      // Weiter zur Suche
    }
  }

  const qParts: string[] = [];
  if (params.barcode?.trim()) qParts.push(`barcode:${params.barcode.trim()}`);
  if (params.artist?.trim()) qParts.push(`artist:"${params.artist.trim()}"`);
  if (params.title?.trim()) qParts.push(`release:"${params.title.trim()}"`);
  if (qParts.length > 0) {
    try {
      const q = qParts.join(' AND ');
      const sResp = await fetchWithExponentialBackoff(
        `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(q)}&limit=5&fmt=json`,
        {
          headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
        },
        2,
        undefined,
        'MusicBrainz ASIN-Suche'
      );
      if (sResp.ok) {
        const sData = (await sResp.json()) as { releases?: any[] };
        const releases = sData.releases || [];
        for (const rel of releases) {
          const a = String(rel?.asin || '').trim().toUpperCase();
          if (/^[A-Z0-9]{10}$/.test(a)) return a;
        }
        for (const rel of releases.slice(0, 2)) {
          const rid = String(rel?.id || '').trim();
          if (!UUID_REGEX.test(rid)) continue;
          try {
            const rResp = await fetchWithExponentialBackoff(
              `https://musicbrainz.org/ws/2/release/${encodeURIComponent(rid)}?inc=url-rels&fmt=json`,
              {
                headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
              },
              2,
              undefined,
              'MusicBrainz ASIN-URL'
            );
            if (rResp.ok) {
              const rData = await rResp.json();
              const found = extractAmazonAsinFromRelations(rData);
              if (found) return found;
            }
          } catch {
            // Weiter
          }
        }
      }
    } catch {
      // Ignorieren
    }
  }
  return '';
}

function inspectImageBufferDimensions(
  buf: Buffer,
  mimeHint = ''
): { width?: number; height?: number; format: string } {
  if (!buf || buf.length < 12) {
    return { format: 'JPEG' };
  }
  // PNG
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      format: 'PNG',
    };
  }
  // GIF
  if (buf.length >= 10 && buf.subarray(0, 4).toString('ascii') === 'GIF8') {
    return {
      width: buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
      format: 'GIF',
    };
  }
  // BMP
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return {
      width: Math.abs(buf.readInt32LE(18)),
      height: Math.abs(buf.readInt32LE(22)),
      format: 'BMP',
    };
  }
  // WebP
  if (
    buf.length >= 30 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const chunkType = buf.subarray(12, 16).toString('ascii');
    if (chunkType === 'VP8 ' && buf.length >= 30) {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
        format: 'WEBP',
      };
    }
    if (chunkType === 'VP8L' && buf.length >= 25) {
      const b0 = buf[21];
      const b1 = buf[22];
      const b2 = buf[23];
      const b3 = buf[24];
      const w = 1 + (((b1 & 0x3f) << 8) | b0);
      const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width: w, height: h, format: 'WEBP' };
    }
    if (chunkType === 'VP8X' && buf.length >= 30) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h, format: 'WEBP' };
    }
    return { format: 'WEBP' };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let pos = 2;
    while (pos + 4 <= buf.length) {
      if (buf[pos] !== 0xff) {
        pos += 1;
        continue;
      }
      while (pos < buf.length && buf[pos] === 0xff) pos += 1;
      if (pos >= buf.length) break;
      const marker = buf[pos];
      pos += 1;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (pos + 2 > buf.length) break;
      const segLen = buf.readUInt16BE(pos);
      if (segLen < 2 || pos + segLen > buf.length) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (pos + 7 <= buf.length) {
          return {
            height: buf.readUInt16BE(pos + 3),
            width: buf.readUInt16BE(pos + 5),
            format: 'JPEG',
          };
        }
      }
      pos += segLen;
    }
    return { format: 'JPEG' };
  }

  const lower = (mimeHint || '').toLowerCase();
  if (lower.includes('png')) return { format: 'PNG' };
  if (lower.includes('webp')) return { format: 'WEBP' };
  if (lower.includes('gif')) return { format: 'GIF' };
  return { format: 'JPEG' };
}

interface ParsedBarcodeOrQr {
  kind: 'barcode' | 'mbid' | 'discogs_id' | 'asin' | 'text';
  raw: string;
  barcode?: string;
  barcodeVariants?: string[];
  mbid?: string;
  discogsId?: string;
  asin?: string;
  cleanQuery: string;
}

function parseDiscogsCodeOrUrl(rawInput: string): { id: string; isMaster: boolean } | null {
  const raw = String(rawInput || '').trim();
  if (!raw) return null;

  // 1. Discogs URL: https://www.discogs.com/.../release/524030... oder .../master/63720...
  const urlMatch = raw.match(
    /discogs\.com\/(?:[^/]+\/)?(release|master)\/(\d{2,12})(?:-[^/?#]*)?/i
  );
  if (urlMatch) {
    return {
      id: urlMatch[2],
      isMaster: urlMatch[1].toLowerCase() === 'master',
    };
  }

  // 2. Kopierter Discogs-Code mit eckigen Klammern (z. B. "[r524030]", "[m63720]", "[524030]")
  //    auch wenn der Code innerhalb eines Suchstrings steht
  const bracketMatch = raw.match(/\[\s*([rm])?\s*(\d{2,12})\s*\]/i);
  if (bracketMatch) {
    const prefix = (bracketMatch[1] || 'r').toLowerCase();
    return {
      id: bracketMatch[2],
      isMaster: prefix === 'm',
    };
  }

  // 3. Direkte Eingabe wie "r524030", "m63720", "discogs:524030", "discogs:r524030", "discogs:m63720", "discogs:[r524030]"
  const directMatch = raw.match(
    /^(?:discogs\s*:\s*)?(?:(release|master)\s*[:/]\s*)?\[?\s*([rm])?\s*(\d{2,12})\s*\]?$/i
  );
  if (directMatch) {
    const hasExplicitDiscogsPrefix = /^discogs\s*:/i.test(raw);
    const wordPrefix = (directMatch[1] || '').toLowerCase();
    const charPrefix = (directMatch[2] || '').toLowerCase();
    if (hasExplicitDiscogsPrefix || wordPrefix || charPrefix) {
      return {
        id: directMatch[3],
        isMaster: wordPrefix === 'master' || charPrefix === 'm',
      };
    }
  }

  return null;
}

async function resolveDiscogsReleaseId(
  rawIdOrCode: string,
  customToken?: string,
  logs?: string[]
): Promise<string | null> {
  const trimmed = String(rawIdOrCode || '').trim();
  if (!trimmed) return null;

  const parsed = parseDiscogsCodeOrUrl(trimmed);
  const candidateId = parsed ? parsed.id : trimmed.replace(/^discogs:/i, '').replace(/^[[\srm]+|[\]\s]+$/gi, '');
  const isMaster = parsed ? parsed.isMaster : /^\[?\s*m\d+/i.test(trimmed);

  if (!/^\d+$/.test(candidateId)) return null;

  const fetchMasterMainRelease = async (masterId: string): Promise<string | null> => {
    const mResp = await fetchWithExponentialBackoff(
      `https://api.discogs.com/masters/${masterId}`,
      { headers: discogsHeaders(customToken) },
      3,
      logs,
      'Discogs Master-Release'
    );
    if (!mResp.ok) return null;
    const mData = (await mResp.json()) as { main_release?: number | string };
    const mainRel = String(mData?.main_release || '').trim();
    if (/^\d+$/.test(mainRel)) {
      logs?.push(
        formatLogLine(
          `Discogs: Master-/Releasegroup-ID [m${masterId}] auf Haupt-Release [r${mainRel}] aufgelöst.`
        )
      );
      return mainRel;
    }
    return null;
  };

  if (isMaster) {
    return await fetchMasterMainRelease(candidateId);
  }

  return candidateId;
}

function parseBarcodeOrQrQuery(rawInput: string): ParsedBarcodeOrQr {
  const raw = String(rawInput || '').trim();
  if (!raw) {
    return { kind: 'text', raw: '', cleanQuery: '' };
  }

  // 1. MusicBrainz Release-URL oder direkte UUID
  const mbUrlMatch = raw.match(/musicbrainz\.org\/release\/([a-f0-9-]{36})/i);
  if (mbUrlMatch) {
    return {
      kind: 'mbid',
      raw,
      mbid: mbUrlMatch[1].toLowerCase(),
      cleanQuery: `reid:${mbUrlMatch[1].toLowerCase()}`,
    };
  }
  if (UUID_REGEX.test(raw)) {
    return {
      kind: 'mbid',
      raw,
      mbid: raw.toLowerCase(),
      cleanQuery: `reid:${raw.toLowerCase()}`,
    };
  }

  // 2. Discogs Release-/Master-Code ([r524030], [m63720], r524030, discogs:524030 oder Discogs-URL)
  const dgParsed = parseDiscogsCodeOrUrl(raw);
  if (dgParsed) {
    const prefixedId = dgParsed.isMaster ? `m${dgParsed.id}` : dgParsed.id;
    return {
      kind: 'discogs_id',
      raw,
      discogsId: prefixedId,
      cleanQuery: `discogs:${prefixedId}`,
    };
  }

  // 3. Amazon URL oder ASIN-Präfix
  const amzUrlMatch = raw.match(
    /(?:amazon\.[a-z.]+\/(?:[^/]+\/)?(?:dp|gp\/product|ASIN)\/|^asin:\s*)([A-Z0-9]{10})\b/i
  );
  if (amzUrlMatch) {
    const asin = amzUrlMatch[1].toUpperCase();
    return {
      kind: 'asin',
      raw,
      asin,
      cleanQuery: `asin:${asin}`,
    };
  }

  // 4. GS1 Digital Link QR-Code (z. B. https://.../01/04006751564224) oder Barcode-Präfix (barcode:, EAN:, UPC:, GTIN:)
  const gs1Match = raw.match(/\/01\/(\d{8,14})(?:\/|\?|$)/);
  const prefixMatch = raw.match(/^(?:barcode|ean(?:-?13|-?8)?|upc(?:-?a|-?e)?|gtin)\s*[:=#]?\s*([\d\s-]{8,20})$/i);
  const candidateDigits = gs1Match
    ? gs1Match[1]
    : prefixMatch
      ? prefixMatch[1].replace(/[\s-]+/g, '')
      : /^[\d\s-]{8,18}$/.test(raw)
        ? raw.replace(/[\s-]+/g, '')
        : '';

  if (/^\d{8,14}$/.test(candidateDigits)) {
    const variants = new Set<string>([candidateDigits]);
    if (candidateDigits.length === 12) {
      variants.add(`0${candidateDigits}`);
    } else if (candidateDigits.length === 13 && candidateDigits.startsWith('0')) {
      variants.add(candidateDigits.slice(1));
    } else if (candidateDigits.length === 14 && candidateDigits.startsWith('0')) {
      variants.add(candidateDigits.slice(1));
      if (candidateDigits.startsWith('00')) {
        variants.add(candidateDigits.slice(2));
      }
    }
    const variantList = Array.from(variants);
    const mbBarcodeQuery = variantList.map((v) => `barcode:${v}`).join(' OR ');
    return {
      kind: 'barcode',
      raw,
      barcode: candidateDigits,
      barcodeVariants: variantList,
      cleanQuery: mbBarcodeQuery,
    };
  }

  return { kind: 'text', raw, cleanQuery: raw };
}

function matchesSourceTrackCountRule(
  candidate: { trackCount?: number; mediumCount?: number },
  sourceTrackCount: number
): boolean {
  if (sourceTrackCount <= 0) return true;
  const tc = Number(candidate?.trackCount || 0);
  const mc = Math.max(1, Number(candidate?.mediumCount || 1));
  if (tc <= 0) return false;
  if (tc < sourceTrackCount) return false;
  if (tc === sourceTrackCount) return true;
  return mc > 1;
}

function getMusicBrainzAlbumTrackCount(rel: any, fallback = 0): { totalTracks: number; mediumCount: number } {
  const mediaList: any[] = Array.isArray(rel?.media) ? rel.media : [];
  const totalFromMedia = mediaList.reduce(
    (sum, m) => sum + Number(m?.['track-count'] || (Array.isArray(m?.tracks) ? m.tracks.length : 0) || 0),
    0
  );
  const totalTracks = totalFromMedia || Number(rel?.['track-count'] || fallback || 0);
  const mediumCount = Math.max(1, Number(rel?.['medium-count'] || mediaList.length || 1));
  return { totalTracks, mediumCount };
}

async function searchMusicBrainzRaw(
  query: string,
  limit = 8,
  logs?: string[],
  expectedTrackCount = 0
) {
  const parsed = parseBarcodeOrQrQuery(query);
  if (parsed.kind === 'discogs_id') {
    return [];
  }

  const runMbQuery = async (luceneQuery: string) => {
    const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(luceneQuery)}&limit=${limit}&fmt=json`;
    const response = await fetchWithExponentialBackoff(
      url,
      {
        headers: {
          'User-Agent': MB_USER_AGENT,
          Accept: 'application/json',
        },
      },
      4,
      logs,
      'MusicBrainz Suche'
    );
    if (!response.ok) {
      throw new Error(`MusicBrainz HTTP ${response.status}`);
    }
    const data = (await response.json()) as { releases?: any[] };
    return data.releases || [];
  };

  let rawReleases: any[] = [];
  if (parsed.kind === 'barcode' && parsed.barcode) {
    logs?.push(
      formatLogLine(
        `MusicBrainz: Barcode/EAN „${parsed.barcode}“ erkannt – suche nach exaktem Release (${parsed.cleanQuery})...`
      )
    );
    rawReleases = await runMbQuery(parsed.cleanQuery);
    if (rawReleases.length === 0) {
      logs?.push(
        formatLogLine(
          `MusicBrainz: Kein direkter Barcode-Index-Treffer – prüfe Volltext/Katalognummer für „${parsed.barcode}“...`
        )
      );
      rawReleases = await runMbQuery(parsed.barcode);
    }
  } else if (parsed.kind === 'mbid' && parsed.mbid) {
    logs?.push(formatLogLine(`MusicBrainz: Release-UUID „${parsed.mbid}“ aus Code erkannt...`));
    rawReleases = await runMbQuery(parsed.cleanQuery);
  } else if (parsed.kind === 'asin' && parsed.asin) {
    logs?.push(formatLogLine(`MusicBrainz: Amazon-ASIN „${parsed.asin}“ aus Code erkannt...`));
    rawReleases = await runMbQuery(parsed.cleanQuery);
  } else {
    rawReleases = await runMbQuery(query);
  }

  const methodLabel =
    parsed.kind === 'barcode'
      ? 'Barcode / EAN'
      : parsed.kind === 'mbid'
        ? 'Release-UUID'
        : parsed.kind === 'asin'
          ? 'Amazon-ASIN'
          : 'MusicBrainz-Suche';

  return rawReleases.map((rel) => {
    const mediaList: any[] = Array.isArray(rel.media) ? rel.media : [];
    const { totalTracks, mediumCount } = getMusicBrainzAlbumTrackCount(rel);
    const matchingMed =
      expectedTrackCount > 0
        ? mediaList.find(
            (m) => Number(m?.['track-count'] || m?.tracks?.length || 0) === expectedTrackCount
          )
        : mediaList[0];
    const catno = rel['label-info']?.[0]?.['catalog-number'] || '';
    const genres = extractMusicBrainzGenres(rel);
    const hasCover = Boolean(rel['cover-art-archive']?.front || rel['cover-art-archive']?.artwork);
    return {
      id: String(rel.id || ''),
      source: 'musicbrainz' as const,
      title: String(rel.title || 'Unbekanntes Album'),
      artist: formatArtistCredit(rel['artist-credit']),
      date: String(rel.date || ''),
      country: String(rel.country || ''),
      barcode: String(rel.barcode || ''),
      catno: String(catno || ''),
      trackCount: totalTracks,
      mediumCount,
      matchedDiscNumber: Number(matchingMed?.position || 1),
      method: methodLabel,
      label: rel['label-info']?.[0]?.label?.name || '',
      score: Number(rel.score || 0),
      genres,
      hasCover,
    };
  });
}

async function fetchDiscogsReleaseSummary(releaseId: string, score = 88, customToken?: string, logs?: string[]) {
  let cleanId = await resolveDiscogsReleaseId(releaseId, customToken, logs);
  if (!cleanId || !/^\d+$/.test(cleanId)) return null;
  let resp = await fetchWithExponentialBackoff(
    `https://api.discogs.com/releases/${cleanId}`,
    {
      headers: discogsHeaders(customToken),
    },
    3,
    logs,
    'Discogs Release'
  );
  // Falls eine Master-ID ohne 'm'-Präfix übergeben wurde und /releases/{id} 404 liefert, /masters/{id} prüfen
  if (resp.status === 404) {
    const fallbackMaster = await resolveDiscogsReleaseId(`m${cleanId}`, customToken, logs);
    if (fallbackMaster && fallbackMaster !== cleanId) {
      cleanId = fallbackMaster;
      resp = await fetchWithExponentialBackoff(
        `https://api.discogs.com/releases/${cleanId}`,
        {
          headers: discogsHeaders(customToken),
        },
        3,
        logs,
        'Discogs Release (via Master)'
      );
    }
  }
  if (!resp.ok) return null;
  const rel = (await resp.json()) as any;
  const artist = formatDiscogsArtists(rel.artists);
  const labels = Array.isArray(rel.labels) ? rel.labels : [];
  const identifiers = Array.isArray(rel.identifiers) ? rel.identifiers : [];
  const barcodeObj = identifiers.find(
    (id: any) => String(id?.type || '').toLowerCase() === 'barcode' && id?.value
  );
  const tracklist: any[] = Array.isArray(rel.tracklist) ? rel.tracklist : [];
  const trackRows = tracklist.filter((t: any) => !t?.type_ || t.type_ === 'track');
  const trackCount = trackRows.length;
  const formats: any[] = Array.isArray(rel.formats) ? rel.formats : [];
  const formatQtySum = formats.reduce((sum, fmt) => {
    const q = Number(fmt?.qty || 0);
    return sum + (Number.isFinite(q) && q > 0 ? q : 1);
  }, 0);
  const discNums = new Set<number>();
  for (const t of trackRows) {
    const pos = String(t?.position || '').trim();
    const m = pos.match(/^(?:CD|DISC)?\s*(\d{1,2})\s*[-.:]\s*\d+/i);
    if (m) discNums.add(Number(m[1]));
  }
  const headingDiscs = tracklist.filter(
    (t: any) => t?.type_ === 'heading' && /\b(?:cd|disc|disk)\s*\d+/i.test(String(t?.title || ''))
  ).length;
  const mediumCount = Math.max(1, formatQtySum, discNums.size, headingDiscs);
  const dgGenres = filterSubgenres(
    [...(rel.styles || []), ...(rel.genres || [])].map(String),
    requestMetaContext.getStore()?.preferSubgenres ?? true
  );
  const hasCover = Boolean(rel.thumb || (Array.isArray(rel.images) && rel.images.length > 0));
  return {
    id: `discogs:${cleanId}`,
    source: 'discogs' as const,
    title: String(rel.title || 'Unbekanntes Album'),
    artist,
    date: String(rel.year || rel.released || ''),
    country: String(rel.country || ''),
    barcode: String(barcodeObj?.value || ''),
    catno: String(labels[0]?.catno || ''),
    trackCount,
    mediumCount,
    matchedDiscNumber: 1,
    method: 'Discogs Release',
    label: cleanDiscogsName(String(labels[0]?.name || '')),
    score,
    genres: dgGenres,
    hasCover,
  };
}

async function searchDiscogsRaw(
  query: string,
  limit = 8,
  mbCandidates: Array<{ id: string }> = [],
  customToken?: string,
  logs?: string[],
  expectedTrackCount = 0
) {
  const effectiveToken = String(customToken || process.env.DISCOGS_TOKEN || '').trim();
  const parsed = parseBarcodeOrQrQuery(query);
  if (parsed.kind === 'discogs_id' && parsed.discogsId) {
    logs?.push(formatLogLine(`Discogs: Direkte Release-ID ${parsed.discogsId} erkannt – rufe Details ab...`));
    const single = await fetchDiscogsReleaseSummary(parsed.discogsId, 98, effectiveToken, logs);
    return single ? [single] : [];
  }

  const fetchDiscogs = async (searchParam: string, extraFormat: string) => {
    const url = `https://api.discogs.com/database/search?${searchParam}&type=release${extraFormat}&per_page=${limit}`;
    const response = await fetchWithExponentialBackoff(
      url,
      {
        headers: discogsHeaders(effectiveToken),
      },
      3,
      logs,
      'Discogs Suche'
    );
    if (!response.ok) {
      throw new Error(`Discogs HTTP ${response.status}`);
    }
    const data = (await response.json()) as { results?: any[] };
    return data.results || [];
  };

  try {
    let results: any[] = [];
    if (parsed.kind === 'barcode' && parsed.barcode) {
      logs?.push(
        formatLogLine(
          `Discogs: Suche nach Barcode/EAN „${parsed.barcode}“ (${effectiveToken ? 'Token aktiv' : 'ohne Token'})...`
        )
      );
      for (const variant of parsed.barcodeVariants || [parsed.barcode]) {
        results = await fetchDiscogs(`barcode=${encodeURIComponent(variant)}`, '');
        if (results.length > 0) break;
      }
      if (results.length === 0) {
        results = await fetchDiscogs(`q=${encodeURIComponent(parsed.barcode)}`, '');
      }
    } else {
      if (effectiveToken) {
        logs?.push(formatLogLine(`Discogs: Token aktiv – frage api.discogs.com/database/search nach "${query}" ab...`));
      } else {
        logs?.push(formatLogLine(`Discogs: Kein Token gesetzt – prüfe api.discogs.com/database/search...`));
      }
      results = await fetchDiscogs(`q=${encodeURIComponent(query)}`, '&format=CD');
      if (results.length === 0) {
        results = await fetchDiscogs(`q=${encodeURIComponent(query)}`, '');
      }
    }
    logs?.push(formatLogLine(`Discogs: ${results.length} direkte Treffer über Datenbanksuche erhalten.`));

    const rawMapped = results.map((item, idx) => {
      const rawTitle = String(item?.title || 'Unbekannt');
      const sepIdx = rawTitle.indexOf(' - ');
      const artist =
        sepIdx > 0 ? normalizeMultiArtist(cleanDiscogsName(rawTitle.slice(0, sepIdx))) : 'Unbekannter Künstler';
      const title = sepIdx > 0 ? rawTitle.slice(sepIdx + 3).trim() : rawTitle;
      const labels: string[] = Array.isArray(item?.label) ? item.label : [];
      const barcodes: string[] = Array.isArray(item?.barcode) ? item.barcode : [];
      const dgGenres = filterSubgenres(
        [...(Array.isArray(item?.style) ? item.style : []), ...(Array.isArray(item?.genre) ? item.genre : [])].map(
          String
        ),
        requestMetaContext.getStore()?.preferSubgenres ?? true
      );
      return {
        rawId: String(item?.id || ''),
        id: `discogs:${String(item?.id || '')}`,
        source: 'discogs' as const,
        title,
        artist,
        date: String(item?.year || ''),
        country: String(item?.country || ''),
        barcode: String(barcodes[0] || ''),
        catno: String(item?.catno || ''),
        trackCount: 0,
        mediumCount: 1,
        matchedDiscNumber: 1,
        method: parsed.kind === 'barcode' ? 'Discogs Barcode' : 'Discogs-Suche',
        label: cleanDiscogsName(String(labels[0] || '')),
        score: Math.max(50, 95 - idx * 4),
        genres: dgGenres,
        hasCover: Boolean(item?.cover_image || item?.thumb),
      };
    });

    if (expectedTrackCount > 0 && rawMapped.length > 0) {
      const topSlice = rawMapped.slice(0, 6);
      const enriched: any[] = [];
      for (let i = 0; i < topSlice.length; i += 3) {
        const batch = await Promise.all(
          topSlice.slice(i, i + 3).map(async (entry) => {
            if (!entry.rawId) return null;
            const detail = await fetchDiscogsReleaseSummary(entry.rawId, entry.score, effectiveToken, logs);
            if (!detail) return null;
            return { ...detail, method: entry.method };
          })
        );
        for (const item of batch) {
          if (item) enriched.push(item);
        }
      }
      return enriched;
    }

    return rawMapped.map(({ rawId: _rawId, ...rest }) => rest);
  } catch (err) {
    logs?.push(
      formatLogLine(
        `Discogs: Direktsuche erfordert Token (${err instanceof Error ? err.message : '401'}) – löse Discogs-Links über MusicBrainz url-rels auf...`
      )
    );
    const discogsIds: string[] = [];
    for (const mb of mbCandidates.slice(0, 4)) {
      if (!mb.id) continue;
      try {
        const relResp = await fetchWithExponentialBackoff(
          `https://musicbrainz.org/ws/2/release/${encodeURIComponent(mb.id)}?inc=url-rels&fmt=json`,
          {
            headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
          },
          2,
          logs,
          'MusicBrainz url-rels'
        );
        if (!relResp.ok) continue;
        const relData = (await relResp.json()) as { relations?: any[] };
        for (const r of relData.relations || []) {
          const resUrl = String(r?.url?.resource || '');
          const m = resUrl.match(/discogs\.com\/(?:[^/]+\/)?release\/(\d+)/i);
          if (m && !discogsIds.includes(m[1])) {
            discogsIds.push(m[1]);
          }
        }
      } catch {
        // Ignorieren
      }
      if (discogsIds.length >= 4) break;
    }

    const summaries = await Promise.all(
      discogsIds.slice(0, 4).map((id, idx) => fetchDiscogsReleaseSummary(id, 90 - idx * 3, effectiveToken, logs))
    );
    const valid = summaries.filter((s): s is NonNullable<typeof s> => s !== null);
    logs?.push(
      formatLogLine(`Discogs: ${valid.length} verknüpfte Discogs-Releases über MusicBrainz url-rels geladen.`)
    );
    return valid;
  }
}

async function lookupMusicBrainzByToc(
  mbDiscId: string,
  tocString: string,
  targetDurations: number[] = [],
  logs?: string[]
) {
  const cleanDiscId = String(mbDiscId || '').trim() || '-';
  const cleanToc = String(tocString || '').trim();
  if (!cleanToc && cleanDiscId === '-') return [];

  const candidateUrls: Array<{ url: string; desc: string }> = [];
  if (cleanDiscId !== '-') {
    const p1 = new URLSearchParams({
      inc: 'artists+labels+recordings+release-groups',
      fmt: 'json',
      cdstubs: 'no',
    });
    if (cleanToc) p1.set('toc', cleanToc);
    candidateUrls.push({
      url: `https://musicbrainz.org/ws/2/discid/${encodeURIComponent(cleanDiscId)}?${p1.toString()}`,
      desc: `DiscID "${cleanDiscId}" + Sektor-TOC`,
    });
  }
  if (cleanToc) {
    const p2 = new URLSearchParams({
      toc: cleanToc,
      inc: 'artists+labels+recordings+release-groups',
      'media-format': 'all',
      fmt: 'json',
    });
    candidateUrls.push({
      url: `https://musicbrainz.org/ws/2/discid/-?${p2.toString()}`,
      desc: `Fuzzy-Sektor-TOC über alle Medienformate`,
    });
  }

  const expectedTracks = targetDurations.length;
  const collectedMap = new Map<string, any>();

  for (const item of candidateUrls) {
    logs?.push(formatLogLine(`MusicBrainz TOC-Abfrage: Prüfe ${item.desc}...`));
    try {
      const resp = await fetchWithExponentialBackoff(
        item.url,
        {
          headers: {
            'User-Agent': MB_USER_AGENT,
            Accept: 'application/json',
          },
        },
        4,
        logs,
        'MusicBrainz TOC'
      );
      if (!resp.ok) {
        if (resp.status === 404) continue;
        throw new Error(`MusicBrainz TOC HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as { releases?: any[]; title?: string; artist?: string };
      if (Array.isArray(data.releases) && data.releases.length > 0) {
        for (let idx = 0; idx < data.releases.length; idx++) {
          const rel = data.releases[idx];
          const relId = String(rel?.id || '');
          if (!relId || collectedMap.has(relId)) continue;
          const mediaList: any[] = Array.isArray(rel.media) ? rel.media : [];
          const matchingMed =
            expectedTracks > 0
              ? mediaList.find(
                  (m) => Number(m?.['track-count'] || m?.tracks?.length || 0) === expectedTracks
                )
              : mediaList[0];
          const mediumTracks = matchingMed
            ? Number(matchingMed?.['track-count'] || matchingMed?.tracks?.length || 0)
            : mediaList.reduce(
                (sum, m) => sum + Number(m?.['track-count'] || m?.tracks?.length || 0),
                0
              );
          const durScore =
            expectedTracks > 0
              ? scoreReleaseDurationMatch(rel, targetDurations)
              : Math.max(85, 100 - idx * 2);
          if (expectedTracks > 0 && (durScore <= 0 || mediumTracks !== expectedTracks)) {
            continue;
          }
          const { totalTracks, mediumCount } = getMusicBrainzAlbumTrackCount(rel, mediumTracks);
          collectedMap.set(relId, {
            id: relId,
            source: 'musicbrainz' as const,
            title: String(rel.title || 'Unbekanntes Album'),
            artist: formatArtistCredit(rel['artist-credit']),
            date: String(rel.date || ''),
            country: String(rel.country || ''),
            barcode: String(rel.barcode || ''),
            catno: String(rel['label-info']?.[0]?.['catalog-number'] || ''),
            trackCount: totalTracks || mediumTracks,
            mediumCount,
            matchedDiscNumber: Number(matchingMed?.position || 1),
            method: 'TOC / DiscID',
            label: rel['label-info']?.[0]?.label?.name || '',
            score: durScore,
          });
        }
        if (collectedMap.size > 0) {
          break;
        }
      }
      // Falls ein CD-Stub zurückgegeben wurde, über Künstler + Titel (+ exakte Trackanzahl) nach Release suchen
      if (data.title && data.artist) {
        logs?.push(
          formatLogLine(`MusicBrainz CD-Stub gefunden: "${data.artist} – ${data.title}" – löse Release auf...`)
        );
        const stubQ =
          targetDurations.length > 0
            ? `artist:"${data.artist}" AND release:"${data.title}" AND (tracks:${targetDurations.length} OR tracksmedium:${targetDurations.length})`
            : `artist:"${data.artist}" AND release:"${data.title}"`;
        const stubHits = await searchMusicBrainzRaw(stubQ, 8, logs, targetDurations.length);
        for (const sh of stubHits) {
          if (sh.id && !collectedMap.has(sh.id)) {
            collectedMap.set(sh.id, { ...sh, method: 'TOC CD-Stub' });
          }
        }
      }
    } catch (err) {
      logs?.push(
        formatLogLine(
          `MusicBrainz TOC-Hinweis: ${err instanceof Error ? err.message : 'Verbindungsfehler'}`
        )
      );
    }
  }

  if (collectedMap.size === 0) {
    logs?.push(formatLogLine(`MusicBrainz TOC: Kein direkter Sektor-TOC-Treffer.`));
    return [];
  }

  const scored = Array.from(collectedMap.values());
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 12);
}

async function lookupMusicBrainzByDurationSignature(
  targetDurations: number[],
  folderHint: string,
  trackTitles: string[],
  logs?: string[]
) {
  const numTracks = targetDurations.length;
  if (numTracks === 0) return [];

  const candidateReleaseMap = new Map<string, { rel: any; bonus: number }>();

  // Strategie A: Ordner-/Tag-Hinweis + exakte Trackanzahl (tracks:<N>)
  const cleanHint = String(folderHint || '').trim();
  if (cleanHint) {
    const dashParts = cleanHint.split(/\s+[-–—]\s+/);
    let q = `tracks:${numTracks} AND (${cleanHint})`;
    if (dashParts.length >= 2) {
      q = `artist:"${dashParts[0].trim()}" AND release:"${dashParts.slice(1).join(' ').trim()}" AND tracks:${numTracks}`;
    }
    logs?.push(
      formatLogLine(
        `MusicBrainz Multi-Signal-Erkennung: Suche über Ordner-/Tag-Hinweis + Trackanzahl (${numTracks} Titel)...`
      )
    );
    try {
      const resp = await fetchWithExponentialBackoff(
        `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(q)}&limit=10&fmt=json`,
        { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
        3,
        logs,
        'MusicBrainz Hinweis+Tracks'
      );
      if (resp.ok) {
        const data = (await resp.json()) as { releases?: any[] };
        for (const r of data.releases || []) {
          if (r?.id) candidateReleaseMap.set(String(r.id), { rel: r, bonus: 15 });
        }
      }
    } catch {
      // Weiter mit Strategie B
    }
  }

  // Strategie B: Spezifische Track-Titel + exakte Millisekunden-Längenfenster (dur:[ms-4000 TO ms+4000])
  const genericTitleRe = /^(?:track|titel|audio|spur|title|song|unknown|unbekannt)\s*\d*$/i;
  const usableTracks: Array<{ idx: number; title: string; durSec: number }> = [];
  for (let i = 0; i < Math.min(trackTitles.length, targetDurations.length); i++) {
    const t = String(trackTitles[i] || '').trim();
    const d = targetDurations[i];
    if (t.length >= 3 && !genericTitleRe.test(t) && d > 15) {
      usableTracks.push({ idx: i, title: t, durSec: d });
    }
  }

  if (usableTracks.length > 0 && candidateReleaseMap.size < 6) {
    // Wähle die 2 längsten/markantesten Tracks für die Recording-Dauer-Suche
    const chosen = [...usableTracks].sort((a, b) => b.durSec - a.durSec).slice(0, 2);
    for (const item of chosen) {
      const ms = Math.round(item.durSec * 1000);
      const minMs = Math.max(1000, ms - 4500);
      const maxMs = ms + 4500;
      const recQuery = `recording:"${item.title.replace(/"/g, '')}" AND dur:[${minMs} TO ${maxMs}] AND tracks:${numTracks}`;
      logs?.push(
        formatLogLine(
          `MusicBrainz Dauer-Signatur: Prüfe Track #${item.idx + 1} „${item.title}“ (${item.durSec}s ±4,5s, ${numTracks} Titel)...`
        )
      );
      try {
        const resp = await fetchWithExponentialBackoff(
          `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(recQuery)}&limit=8&fmt=json`,
          { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
          3,
          logs,
          'MusicBrainz Recording-Dauer'
        );
        if (resp.ok) {
          const data = (await resp.json()) as { recordings?: any[] };
          for (const rec of data.recordings || []) {
            for (const rel of rec?.releases || []) {
              if (!rel?.id) continue;
              const relMedia: any[] = Array.isArray(rel.media) ? rel.media : [];
              const hasMatchingMed =
                relMedia.some((m) => Number(m?.['track-count'] || 0) === numTracks) ||
                Number(rel?.['track-count'] || 0) === numTracks;
              if (!hasMatchingMed) continue;
              const existing = candidateReleaseMap.get(String(rel.id));
              if (existing) {
                existing.bonus += 12;
              } else {
                candidateReleaseMap.set(String(rel.id), { rel, bonus: 10 });
              }
            }
          }
        }
      } catch {
        // Ignorieren
      }
    }
  }

  // Strategie C: Reine Längen-Signatur-Suche über die 2 längsten Tracks (falls Dateien "Track 01.flac" heißen)
  if (candidateReleaseMap.size === 0 && numTracks >= 3) {
    const indexedDurs = targetDurations
      .map((d, idx) => ({ idx: idx + 1, durSec: d }))
      .filter((x) => x.durSec >= 35)
      .sort((a, b) => b.durSec - a.durSec)
      .slice(0, 2);

    for (const item of indexedDurs) {
      const ms = Math.round(item.durSec * 1000);
      const recQuery = `dur:[${ms - 2500} TO ${ms + 2500}] AND tnum:${item.idx} AND tracks:${numTracks}`;
      logs?.push(
        formatLogLine(
          `MusicBrainz Längen-Vektor: Suche Track #${item.idx} (${item.durSec}s ±2,5s) auf Medium mit ${numTracks} Titeln...`
        )
      );
      try {
        const resp = await fetchWithExponentialBackoff(
          `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(recQuery)}&limit=8&fmt=json`,
          { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
          3,
          logs,
          'MusicBrainz Längen-Vektor'
        );
        if (resp.ok) {
          const data = (await resp.json()) as { recordings?: any[] };
          for (const rec of data.recordings || []) {
            for (const rel of rec?.releases || []) {
              if (!rel?.id) continue;
              const relMedia: any[] = Array.isArray(rel.media) ? rel.media : [];
              const hasMatchingMed =
                relMedia.some((m) => Number(m?.['track-count'] || 0) === numTracks) ||
                Number(rel?.['track-count'] || 0) === numTracks;
              if (!hasMatchingMed) continue;
              const existing = candidateReleaseMap.get(String(rel.id));
              if (existing) {
                existing.bonus += 15;
              } else {
                candidateReleaseMap.set(String(rel.id), { rel, bonus: 8 });
              }
            }
          }
        }
      } catch {
        // Ignorieren
      }
    }
  }

  if (candidateReleaseMap.size === 0) return [];

  // Bewerte die besten Kandidaten (max. 3 statt 10, um Rate-Limits & Wartezeiten drastisch zu senken)
  const candidates = Array.from(candidateReleaseMap.values())
    .sort((a, b) => b.bonus - a.bonus)
    .slice(0, 3);

  const verifiedResults: any[] = [];
  for (const cand of candidates) {
    const relId = String(cand.rel.id || '');
    let fullRel = cand.rel;
    // Falls keine Track-Längen im Such-Snippet enthalten sind, kurz Release-Recordings nachladen
    const hasTrackLengths =
      Array.isArray(fullRel.media) &&
      fullRel.media.some((m: any) => Array.isArray(m?.tracks) && m.tracks.length > 0);
    if (!hasTrackLengths && UUID_REGEX.test(relId)) {
      try {
        const rResp = await fetchWithExponentialBackoff(
          `https://musicbrainz.org/ws/2/release/${encodeURIComponent(relId)}?inc=artists+recordings+labels&fmt=json`,
          { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
          2,
          logs,
          'MusicBrainz Dauer-Abgleich'
        );
        if (rResp.ok) {
          fullRel = await rResp.json();
        }
      } catch {
        // Nutze Snippet
      }
    }

    const durScore = scoreReleaseDurationMatch(fullRel, targetDurations);
    if (durScore <= 0) {
      logs?.push(
        formatLogLine(
          `MusicBrainz Dauer-Abgleich: Überspringe Release "${fullRel.title || relId}" (kein Medium mit exakt ${numTracks} Tracks).`
        )
      );
      continue;
    }
    const totalScore = Math.min(100, Math.round(durScore + cand.bonus * 0.4));
    const mediaList: any[] = Array.isArray(fullRel.media) ? fullRel.media : [];
    const matchingMed = mediaList.find(
      (m) => Number(m?.['track-count'] || m?.tracks?.length || 0) === numTracks
    );
    const { totalTracks, mediumCount } = getMusicBrainzAlbumTrackCount(fullRel, numTracks);

    verifiedResults.push({
      id: relId,
      source: 'musicbrainz' as const,
      title: String(fullRel.title || 'Unbekanntes Album'),
      artist: formatArtistCredit(fullRel['artist-credit']),
      date: String(fullRel.date || ''),
      country: String(fullRel.country || ''),
      barcode: String(fullRel.barcode || ''),
      catno: String(fullRel['label-info']?.[0]?.['catalog-number'] || ''),
      trackCount: totalTracks || numTracks,
      mediumCount,
      matchedDiscNumber: Number(matchingMed?.position || 1),
      method: 'Dauer-Signatur',
      label: fullRel['label-info']?.[0]?.label?.name || '',
      score: totalScore,
    });
  }

  verifiedResults.sort((a, b) => b.score - a.score);
  if (verifiedResults.length > 0) {
    logs?.push(
      formatLogLine(
        `MusicBrainz Multi-Signal-Erkennung: ${verifiedResults.length} passende Releases (${numTracks} Tracks) über Dauer-Vektor verifiziert (Top: ${verifiedResults[0].artist} – ${verifiedResults[0].title}, Score ${verifiedResults[0].score}%).`
      )
    );
  }
  return verifiedResults;
}

async function lookupCddbCandidatesByDiscId(
  discid: string,
  tocString?: string,
  expectedTracks = 0,
  logs?: string[],
  preferredCategory?: string
) {
  const cleanId = String(discid || '').trim().toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(cleanId)) return [];

  const categories = ['rock', 'misc', 'jazz', 'soundtrack', 'newage', 'classical', 'folk', 'blues', 'country', 'reggae'];
  const hello = encodeURIComponent(`mintrip github.com MintRipStudio ${APP_VERSION}`);

  const tryRead = async (category: string, targetId = cleanId) => {
    const cmd = encodeURIComponent(`cddb read ${category} ${targetId}`).replace(/%20/g, '+');
    const url = `https://gnudb.gnudb.org/~cddb/cddb.cgi?cmd=${cmd}&hello=${hello}&proto=6`;
    try {
      const resp = await fetchWithExponentialBackoff(
        url,
        {
          headers: { 'User-Agent': MB_USER_AGENT },
          signal: AbortSignal.timeout(5500),
        },
        2,
        logs,
        'GnuDB Read'
      );
      if (!resp.ok) return null;
      const text = await resp.text();
      const lines = text.split(/\r?\n/);
      if (!lines[0]?.startsWith('210')) return null;

      const fields: Record<string, string> = {};
      const offsets: number[] = [];
      let discLengthSec = 0;
      let inOffsets = false;

      for (const line of lines.slice(1)) {
        if (line === '.') break;
        if (line.startsWith('# Track frame offsets:')) {
          inOffsets = true;
          continue;
        }
        if (inOffsets && line.startsWith('#')) {
          const m = line.match(/^#\s*(\d+)\s*$/);
          if (m) {
            offsets.push(Number(m[1]));
            continue;
          }
          inOffsets = false;
        }
        const lenMatch = line.match(/^#\s*Disc length:\s*(\d+)\s*seconds/i);
        if (lenMatch) {
          discLengthSec = Number(lenMatch[1]);
          continue;
        }
        if (line.startsWith('#') || !line.includes('=')) continue;
        const eqIdx = line.indexOf('=');
        const k = line.slice(0, eqIdx);
        const v = line.slice(eqIdx + 1);
        fields[k] = (fields[k] || '') + v;
      }

      const dtitle = fields.DTITLE || 'Unbekannter Künstler / Unbekanntes Album';
      const slashIdx = dtitle.indexOf(' / ');
      const artist = normalizeMultiArtist((slashIdx >= 0 ? dtitle.slice(0, slashIdx) : 'Unbekannter Künstler').trim()) || 'Unbekannter Künstler';
      const title = (slashIdx >= 0 ? dtitle.slice(slashIdx + 3) : dtitle).trim();

      const trackNums = Object.keys(fields)
        .map((k) => k.match(/^TTITLE(\d+)$/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b);

      const tracks = trackNums.map((idx) => {
        const rawT = (fields[`TTITLE${idx}`] || `Titel ${idx + 1}`).trim();
        let trkTitle = rawT;
        let trkArtist = artist;
        if (rawT.includes(' / ') && /^various/i.test(artist)) {
          const p = rawT.indexOf(' / ');
          trkArtist = normalizeMultiArtist(rawT.slice(0, p).trim()) || artist;
          trkTitle = rawT.slice(p + 3).trim();
        }
        let durationSeconds = 210;
        if (offsets.length > idx) {
          const nextFrame = idx + 1 < offsets.length ? offsets[idx + 1] : discLengthSec * 75;
          if (nextFrame > offsets[idx]) {
            durationSeconds = Math.max(1, Math.round((nextFrame - offsets[idx]) / 75));
          }
        }
        return {
          trackNumber: idx + 1,
          title: trkTitle,
          artist: trkArtist,
          durationSeconds,
          isrc: '',
          composer: '',
        };
      });

      return {
        category,
        cddbId: targetId,
        title,
        artist,
        albumArtist: artist,
        year: (fields.DYEAR || '').trim(),
        genre: (fields.DGENRE || category).trim(),
        tracks,
      };
    } catch {
      return null;
    }
  };

  if (preferredCategory) {
    const direct = await tryRead(preferredCategory, cleanId);
    if (direct) return [direct];
  }

  const foundCandidates: Array<{
    category: string;
    cddbId: string;
    title: string;
    artist: string;
    albumArtist: string;
    year: string;
    genre: string;
    tracks: any[];
  }> = [];
  const seenKeys = new Set<string>();
  const addCand = (c: any) => {
    if (!c) return;
    const k = `${c.category}:${c.cddbId}`;
    if (seenKeys.has(k)) return;
    if (expectedTracks > 0 && c.tracks.length > 0 && c.tracks.length !== expectedTracks) {
      return;
    }
    seenKeys.add(k);
    foundCandidates.push(c);
  };

  // Wenn ein vollständiger TOC-String ("1 <numTracks> <leadout> <offset1> ...") vorliegt, zuerst Fuzzy-Query auf GnuDB ausführen
  const cleanToc = String(tocString || '').trim();
  if (cleanToc) {
    const parts = cleanToc.split(/\s+/).map((n) => Number(n));
    if (parts.length >= 4 && parts[0] === 1 && parts[1] === parts.length - 3) {
      const numTracks = parts[1];
      const leadout = parts[2];
      const offsets = parts.slice(3);
      const totalSeconds = Math.max(1, Math.floor(leadout / 75));
      const queryCmd = encodeURIComponent(
        `cddb query ${cleanId} ${numTracks} ${offsets.join(' ')} ${totalSeconds}`
      ).replace(/%20/g, '+');
      const queryUrl = `https://gnudb.gnudb.org/~cddb/cddb.cgi?cmd=${queryCmd}&hello=${hello}&proto=6`;
      try {
        const qResp = await fetchWithExponentialBackoff(
          queryUrl,
          {
            headers: { 'User-Agent': MB_USER_AGENT },
            signal: AbortSignal.timeout(5500),
          },
          2,
          logs,
          'GnuDB Query'
        );
        if (qResp.ok) {
          const qText = await qResp.text();
          const qLines = qText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          const head = qLines[0] || '';
          if (head.startsWith('200 ')) {
            const m = head.match(/^200\s+(\S+)\s+([a-f0-9]{8})\s+/i);
            if (m) {
              logs?.push(formatLogLine(`CDDB Query: Exakter Sektor-TOC-Treffer (${m[1]}/${m[2]}).`));
              const hit = await tryRead(m[1], m[2].toLowerCase());
              addCand(hit);
            }
          } else if (head.startsWith('210 ') || head.startsWith('211 ')) {
            const pairs: Array<{ cat: string; id: string }> = [];
            for (const candLine of qLines.slice(1)) {
              if (candLine === '.') break;
              const m = candLine.match(/^(\S+)\s+([a-f0-9]{8})\s+/i);
              if (m) {
                pairs.push({ cat: m[1], id: m[2].toLowerCase() });
              }
            }
            if (pairs.length > 0) {
              logs?.push(formatLogLine(`CDDB Query: ${pairs.length} Sektor-TOC-Kandidat(en) in GnuDB gefunden – lade Einträge...`));
              const readAll = await Promise.all(pairs.slice(0, 6).map((p) => tryRead(p.cat, p.id)));
              for (const r of readAll) {
                addCand(r);
              }
            }
          }
        }
      } catch {
        // Fallback auf Kategorie-Read
      }
    }
  }

  if (foundCandidates.length === 0) {
    const results = await Promise.all(categories.map((cat) => tryRead(cat)));
    for (const r of results) {
      addCand(r);
    }
  }

  return foundCandidates;
}

async function lookupCddbByDiscId(
  discid: string,
  tocString?: string,
  logs?: string[],
  preferredCategory?: string
) {
  const list = await lookupCddbCandidatesByDiscId(discid, tocString, 0, logs, preferredCategory);
  return list[0] || null;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Per-Request-Kontext für konfigurierbare MusicBrainz-Server-URL & Subgenre-Präferenz
  app.use('/api', (req, _res, next) => {
    const mbBaseUrl = normalizeMusicBrainzServerUrl(
      req.headers['x-mb-server-url'] || req.query.mbServerUrl
    );
    const rawPrefer = String(req.headers['x-prefer-subgenres'] ?? req.query.preferSubgenres ?? 'true')
      .trim()
      .toLowerCase();
    const preferSubgenres = rawPrefer !== 'false' && rawPrefer !== '0';
    requestMetaContext.run({ mbBaseUrl, preferSubgenres }, next);
  });

  // Metadaten-Cache-Verwaltung & Multi-Source Track-Genre-Enrichment
  app.get('/api/metadata/cache/stats', (_req, res) => {
    res.json(getMetadataCacheStats());
  });

  app.post('/api/metadata/cache/clear', (_req, res) => {
    const result = clearMetadataCache();
    res.json({ ok: true, ...result, ...getMetadataCacheStats() });
  });

  app.post('/api/metadata/enrich-genres', async (req, res) => {
    const body = (req.body || {}) as any;
    const album = body.album || {};
    const tracks = Array.isArray(body.tracks) ? body.tracks : [];
    const discogsToken = String(req.headers['x-discogs-token'] || body.discogsToken || '').trim();
    const lastfmApiKey = String(req.headers['x-lastfm-api-key'] || body.lastfmApiKey || '').trim();
    const preferSubgenres = requestMetaContext.getStore()?.preferSubgenres ?? true;
    const logs: string[] = [];

    try {
      const result = await enrichAlbumTrackGenres({
        artist: String(album.albumArtist || album.artist || '').trim(),
        albumTitle: String(album.title || '').trim(),
        albumGenre: String(album.genre || '').trim(),
        musicbrainzReleaseId: String(album.musicbrainzReleaseId || '').trim(),
        musicbrainzReleaseGroupId: String(album.musicbrainzReleaseGroupId || '').trim(),
        discogsReleaseId: String(album.discogsReleaseId || '').trim(),
        tracks,
        discogsToken,
        lastfmApiKey,
        preferSubgenres,
        logs,
      });
      res.json({ ...result, logs });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Track-Genre-Anreicherung fehlgeschlagen.',
        logs,
      });
    }
  });

  // 1a. Alle Datenbanken abfragen (MusicBrainz + CDDB/GnuDB + Discogs) und vollständige Trefferliste zurückgeben
  app.get('/api/metadata/search', async (req, res) => {
    const query = String(req.query.q || '').trim();
    const cddbId = String(req.query.cddbId || '').trim();
    const toc = String(req.query.toc || '').trim();
    const mbDiscId = String(req.query.mbDiscId || '').trim();
    const existingMbid = String(req.query.existingMbid || '').trim();
    const folderHint = String(req.query.folderHint || '').trim();
    const durationsRaw = String(req.query.durations || '').trim();
    const trackTitlesRaw = String(req.query.trackTitles || '').trim();
    const customToken = String(req.query.discogsToken || req.headers['x-discogs-token'] || '').trim();
    const requestedSourceTrackCount = Math.max(0, Math.floor(Number(req.query.sourceTrackCount || 0) || 0));

    const targetDurations = durationsRaw
      ? durationsRaw
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
      : [];
    const effectiveSourceTrackCount = Math.max(requestedSourceTrackCount, targetDurations.length);
    const trackTitles = trackTitlesRaw
      ? trackTitlesRaw
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    if (!query && !cddbId && !toc && !mbDiscId && targetDurations.length === 0) {
      res.status(400).json({ error: 'Suchbegriff, TOC oder CDDB-ID fehlt.' });
      return;
    }

    const logs: string[] = [];
    logs.push(
      formatLogLine(
        `Starte Multi-Datenbank-Abfrage (MusicBrainz + CDDB/GnuDB + Discogs – sammle alle Treffer zur Auswahl) für "${
          toc ? `TOC (${mbDiscId || cddbId || 'Sektor-Offsets'})` : query || folderHint || cddbId
        }"...`
      )
    );

    const orderedResults: any[] = [];
    const seenIds = new Set<string>();
    const pushUnique = (items: any[]) => {
      for (const item of items) {
        if (!item?.id || seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        orderedResults.push(item);
      }
    };

    const mbHits: any[] = [];
    let fastPathHit = false;

    // Fast-Path 0: Bereits vorhandene MusicBrainz-Release-UUID direkt in 1 gecachten Request prüfen
    if (existingMbid && UUID_REGEX.test(existingMbid) && !query) {
      try {
        const fpResp = await fetchWithExponentialBackoff(
          `https://musicbrainz.org/ws/2/release/${existingMbid}?inc=artists+labels+release-groups+genres+tags+media&fmt=json`,
          { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
          1,
          logs,
          'MusicBrainz Fast-Path'
        );
        if (fpResp.ok) {
          const rel = (await fpResp.json()) as any;
          const { totalTracks, mediumCount } = getMusicBrainzAlbumTrackCount(rel);
          const fpCand = {
            id: String(rel.id || existingMbid),
            source: 'musicbrainz' as const,
            title: String(rel.title || 'Unbekanntes Album'),
            artist: formatArtistCredit(rel['artist-credit']),
            date: String(rel.date || ''),
            country: String(rel.country || ''),
            barcode: String(rel.barcode || ''),
            catno: String(rel['label-info']?.[0]?.['catalog-number'] || ''),
            trackCount: totalTracks,
            mediumCount,
            matchedDiscNumber: 1,
            method: 'Gespeicherte MBID (Fast-Path)',
            label: rel['label-info']?.[0]?.label?.name || '',
            score: 100,
            genres: extractMusicBrainzGenres(rel),
            hasCover: Boolean(rel['cover-art-archive']?.front || rel['cover-art-archive']?.artwork),
          };
          mbHits.push(fpCand);
          pushUnique([fpCand]);
          fastPathHit = true;
          logs.push(
            formatLogLine(
              `MusicBrainz Fast-Path: Vorhandene Release-UUID ${existingMbid} direkt geladen („${fpCand.artist} – ${fpCand.title}“).`
            )
          );
        }
      } catch {
        // Fallback auf normale Suche
      }
    }

    // Datenbank 1a: MusicBrainz Sektor-TOC / DiscID
    let exactTocMatched = false;
    if ((toc || mbDiscId) && !fastPathHit) {
      const tocHits = await lookupMusicBrainzByToc(mbDiscId, toc, targetDurations, logs);
      if (tocHits.length > 0) {
        mbHits.push(...tocHits);
        pushUnique(tocHits);
        exactTocMatched = tocHits.some((h) => Number(h.score || 0) >= 95);
        logs.push(
          formatLogLine(
            `MusicBrainz TOC: ${tocHits.length} Release-Kandidat(en) über Sektor-TOC gefunden.`
          )
        );
      }
    }

    // Datenbank 1b: MusicBrainz Multi-Signal-Erkennung (nur wenn kein exakter TOC-/Fast-Path-Treffer vorliegt!)
    if (targetDurations.length > 0 && !exactTocMatched && !fastPathHit) {
      const sigHits = await lookupMusicBrainzByDurationSignature(
        targetDurations,
        folderHint || query,
        trackTitles,
        logs
      );
      if (sigHits.length > 0) {
        mbHits.push(...sigHits);
        pushUnique(sigHits);
      }
    }

    // Datenbank 2: CDDB / GnuDB über Sektor-Offsets / DiscID abfragen (liefert auch Künstler/Album-Hinweise für reine TOC-Abfragen!)
    let cddbHits: any[] = [];
    if (cddbId && /^[a-f0-9]{8}$/i.test(cddbId)) {
      logs.push(
        formatLogLine(
          `Datenbank CDDB/GnuDB: Frage gnudb.org für Disc-ID ${cddbId}${toc ? ' (inkl. Sektor-Offsets)' : ''} ab...`
        )
      );
      cddbHits = await lookupCddbCandidatesByDiscId(
        cddbId,
        toc,
        targetDurations.length,
        logs
      );
      if (cddbHits.length > 0) {
        const mappedCddb = cddbHits.map((c, idx) => ({
          id: `cddb:${c.category}:${c.cddbId}`,
          source: 'cddb' as const,
          title: c.title,
          artist: c.artist,
          date: c.year,
          country: '',
          barcode: '',
          catno: '',
          trackCount: c.tracks.length,
          mediumCount: 1,
          matchedDiscNumber: 1,
          method: `CDDB (${c.category})`,
          label: `CDDB / GnuDB (${c.category})`,
          score: Math.max(75, 92 - idx * 3),
        }));
        pushUnique(mappedCddb);
        logs.push(
          formatLogLine(
            `CDDB/GnuDB: ${mappedCddb.length} Treffer zur Auswahl hinzugefügt (z. B. ${cddbHits[0].artist} – ${cddbHits[0].title}).`
          )
        );
      } else {
        logs.push(formatLogLine(`CDDB/GnuDB: Kein Eintrag für Disc-ID ${cddbId} gefunden.`));
      }
    }

    // Datenbank 1c: Reguläre MusicBrainz-Suche (mit Suchbegriff, Ordnerhinweis oder dem über CDDB ermittelten Album/Künstler)
    const cddbHint =
      cddbHits[0] && cddbHits[0].artist !== 'Unbekannter Künstler'
        ? `${cddbHits[0].artist} ${cddbHits[0].title}`.trim()
        : '';
    const effectiveMbTextQuery = query || folderHint || (mbHits.length === 0 ? cddbHint : '');
    const parsedMbQuery = parseBarcodeOrQrQuery(effectiveMbTextQuery);
    if (effectiveMbTextQuery && parsedMbQuery.kind !== 'discogs_id') {
      try {
        const searchQ =
          parsedMbQuery.kind === 'text' &&
          effectiveSourceTrackCount > 0 &&
          !/tracks(?:medium)?:\d+/i.test(effectiveMbTextQuery)
            ? `${effectiveMbTextQuery} AND (tracks:${effectiveSourceTrackCount} OR tracksmedium:${effectiveSourceTrackCount})`
            : effectiveMbTextQuery;
        logs.push(
          formatLogLine(
            `Datenbank MusicBrainz: Frage Release-Suche für "${searchQ}" ab...`
          )
        );
        let textHits = await searchMusicBrainzRaw(searchQ, 12, logs, effectiveSourceTrackCount);
        if (textHits.length === 0 && searchQ !== effectiveMbTextQuery) {
          textHits = await searchMusicBrainzRaw(effectiveMbTextQuery, 12, logs, effectiveSourceTrackCount);
        }
        if (effectiveSourceTrackCount > 0) {
          textHits = textHits.filter((h) =>
            matchesSourceTrackCountRule(h, effectiveSourceTrackCount)
          );
        }
        mbHits.push(...textHits);
        pushUnique(textHits);
        logs.push(
          formatLogLine(
            `MusicBrainz-Suche: ${textHits.length} Release-Kandidat(en) zur Trefferliste hinzugefügt.`
          )
        );
      } catch (err) {
        logs.push(
          formatLogLine(
            `MusicBrainz-Hinweis: ${err instanceof Error ? err.message : 'Verbindungsfehler'} – fahre mit Discogs fort.`
          )
        );
      }
    }

    // Datenbank 3: Discogs abfragen (mit query, folderHint oder dem aus MusicBrainz / CDDB ermittelten Album/Künstler)
    const effectiveDiscogsQuery =
      query ||
      folderHint ||
      (mbHits[0] ? `${mbHits[0].artist} ${mbHits[0].title}`.trim() : '') ||
      cddbHint;
    if (effectiveDiscogsQuery) {
      try {
        logs.push(
          formatLogLine(
            `Datenbank Discogs: Frage api.discogs.com für "${effectiveDiscogsQuery}" ab...`
          )
        );
        const dg = await searchDiscogsRaw(
          effectiveDiscogsQuery,
          8,
          mbHits,
          customToken,
          logs,
          effectiveSourceTrackCount
        );
        if (parsedMbQuery.kind === 'discogs_id' && dg.length > 0) {
          // Explizite Discogs-Code-Suche (z. B. [r524030]) immer an Position 1 setzen
          for (const item of [...dg].reverse()) {
            if (!item?.id || seenIds.has(item.id)) continue;
            seenIds.add(item.id);
            orderedResults.unshift(item);
          }
        } else {
          pushUnique(dg);
        }
      } catch (err) {
        logs.push(
          formatLogLine(
            `Discogs-Hinweis: ${err instanceof Error ? err.message : 'Verbindungsfehler'}.`
          )
        );
      }
    }

    let finalResults = orderedResults;
    if (effectiveSourceTrackCount > 0) {
      const beforeCount = orderedResults.length;
      finalResults = orderedResults.filter((item) =>
        matchesSourceTrackCountRule(item, effectiveSourceTrackCount)
      );
      const filteredOut = beforeCount - finalResults.length;
      if (filteredOut > 0) {
        logs.push(
          formatLogLine(
            `Trefferfilter: ${filteredOut} Album-Kandidat(en) mit unpassender Trackanzahl ausgeblendet (nur >= ${effectiveSourceTrackCount} Titel; > ${effectiveSourceTrackCount} nur bei Multi-CDs).`
          )
        );
      }
    }

    // Vollständigkeits-/Qualitäts-Badges & Smart-Sortierung (ohne zusätzliche HTTP-Requests)
    finalResults = finalResults.map((item) => {
      const { qualityScore, qualityBadges } = computeCandidateQuality(item, effectiveSourceTrackCount);
      return { ...item, qualityScore, qualityBadges };
    });
    if (parsedMbQuery.kind !== 'discogs_id') {
      finalResults.sort((a, b) => {
        const aFp = String(a.method || '').includes('Fast-Path') ? 1 : 0;
        const bFp = String(b.method || '').includes('Fast-Path') ? 1 : 0;
        if (bFp !== aFp) return bFp - aFp;
        const qDiff = Number(b.qualityScore || 0) - Number(a.qualityScore || 0);
        if (qDiff !== 0) return qDiff;
        const gDiff = (Array.isArray(b.genres) ? b.genres.length : 0) - (Array.isArray(a.genres) ? a.genres.length : 0);
        if (gDiff !== 0) return gDiff;
        return Number(b.score || 0) - Number(a.score || 0);
      });
    }

    logs.push(
      formatLogLine(
        `Alle Datenbanken abgefragt: Insgesamt ${finalResults.length} Treffer in der Auswahlliste bereitgestellt. Bitte gewünschtes Album auswählen.`
      )
    );
    res.json({ releases: finalResults, logs });
  });

  // 1b. MusicBrainz Release Search Proxy (inkl. Discogs-Fallback bei 0 Treffern)
  app.get('/api/musicbrainz/search', async (req, res) => {
    const query = String(req.query.q || '').trim();
    const customToken = String(req.query.discogsToken || req.headers['x-discogs-token'] || '').trim();
    const sourceTrackCount = Math.max(0, Math.floor(Number(req.query.sourceTrackCount || 0) || 0));
    if (!query) {
      res.status(400).json({ error: 'Suchbegriff fehlt.' });
      return;
    }

    try {
      const mbReleases = await searchMusicBrainzRaw(query, 8, undefined, sourceTrackCount);
      const dgReleases = await searchDiscogsRaw(query, 5, mbReleases, customToken, undefined, sourceTrackCount);
      const combined = [...mbReleases, ...dgReleases].filter((r) =>
        matchesSourceTrackCountRule(r, sourceTrackCount)
      );
      res.json({ releases: combined });
    } catch (err) {
      try {
        const dgFallback = (await searchDiscogsRaw(query, 6, [], customToken, undefined, sourceTrackCount)).filter((r) =>
          matchesSourceTrackCountRule(r, sourceTrackCount)
        );
        res.json({ releases: dgFallback });
      } catch {
        res.status(502).json({
          error: err instanceof Error ? err.message : 'Verbindung zu MusicBrainz/Discogs fehlgeschlagen.',
        });
      }
    }
  });

  // 1c. MusicBrainz Einzeltrack-Analyse (ISRC + Recording-Suche + Genres/Tags – nur Interpret, Titel, Genre)
  app.post('/api/musicbrainz/analyze-track', async (req, res) => {
    const body = (req.body || {}) as {
      trackNumber?: number;
      title?: string;
      artist?: string;
      fallbackArtist?: string;
      isrc?: string;
      durationSeconds?: number;
      fileName?: string;
    };

    const logs: string[] = [];
    const trkPad = String(Math.max(1, Number(body.trackNumber || 1))).padStart(2, '0');
    const genericTitleRe = /^(?:track|titel|audio|spur|title|song|unknown|unbekannt|audiotrack)\s*\d*$/i;
    const genericArtists = new Set([
      '',
      'unbekannter künstler',
      'unbekannter kuenstler',
      'unknown artist',
      'various artists',
      'various',
      'diverse',
      'diverse interpreten',
      'va',
      'v.a.',
    ]);

    const cleanHint = (raw: string): string =>
      String(raw || '')
        .trim()
        .replace(/\.(?:flac|mp3|mp2|wav|aiff|aif|aifc|ogg|opus|m4a|dsf|tta|wv)$/i, '')
        .replace(/^\s*(?:\d{1,2}\s*[-–._]\s*\d{1,3}|\d{1,3})\s*[-–._)]\s*/, '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const parseFileNameHints = (fn: string): { artist: string; title: string } => {
      const stem = cleanHint(fn);
      if (!stem) return { artist: '', title: '' };
      const parts = stem
        .split(/\s+[-–—]\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length >= 2) {
        return { artist: parts[0], title: parts.slice(1).join(' - ') };
      }
      return { artist: '', title: stem };
    };

    const normMatch = (val: string): string =>
      String(val || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

    const extractGenresFromItems = (items: any[], maxItems = 5): string => {
      const valid = (Array.isArray(items) ? items : []).filter(
        (x) => x && typeof x === 'object' && typeof x.name === 'string' && x.name.trim()
      );
      if (valid.length === 0) return '';
      valid.sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
      return mergeFormattedGenres(
        valid.map((x) => String(x.name || '').trim()),
        maxItems
      );
    };

    const fnHints = parseFileNameHints(String(body.fileName || ''));
    const rawTitle = String(body.title || '').trim();
    let rawArtist = String(body.artist || '').trim();
    if (genericArtists.has(rawArtist.toLowerCase())) rawArtist = '';
    const fbArtist = String(body.fallbackArtist || '').trim();
    if (!rawArtist && fbArtist && !genericArtists.has(fbArtist.toLowerCase())) {
      rawArtist = fbArtist;
    }

    const titleHint =
      !rawTitle || genericTitleRe.test(rawTitle)
        ? fnHints.title || cleanHint(rawTitle)
        : cleanHint(rawTitle) || rawTitle;
    const artistHint = rawArtist || fnHints.artist;
    const primaryArtistQuery = artistHint ? artistHint.split(';')[0].trim() : '';
    const isrc = String(body.isrc || '').trim().toUpperCase();
    const durSec = Math.max(0, Math.round(Number(body.durationSeconds || 0)));

    const scoreCandidate = (rec: any): number => {
      let score = Number(rec?.score ?? 50);
      const candTitle = normMatch(String(rec?.title || ''));
      const candArtist = normMatch(formatArtistCredit(rec?.['artist-credit']));
      const tNorm = normMatch(titleHint);
      const aNorm = normMatch(primaryArtistQuery);

      if (tNorm && candTitle) {
        if (candTitle === tNorm) score += 40;
        else if (candTitle.includes(tNorm) || tNorm.includes(candTitle)) score += 18;
      }
      if (aNorm && candArtist) {
        if (candArtist === aNorm) score += 35;
        else if (candArtist.includes(aNorm) || aNorm.includes(candArtist)) score += 16;
      }
      const recLenMs = Number(rec?.length || 0);
      if (durSec > 0 && recLenMs > 0) {
        const diffSec = Math.abs(recLenMs / 1000 - durSec);
        if (diffSec <= 2.5) score += 28;
        else if (diffSec <= 6.0) score += 14;
        else if (diffSec <= 15.0) score += 4;
        else if (diffSec >= 45.0) score -= 18;
      }
      if ((Array.isArray(rec?.genres) && rec.genres.length > 0) || (Array.isArray(rec?.tags) && rec.tags.length > 0)) {
        score += 4;
      }
      return score;
    };

    try {
      let bestRec: any = null;
      let isrcMatched = false;
      let matchMethod = 'MusicBrainz (Einzeltrack)';

      // Stufe 1: Exakter ISRC-Lookup
      if (isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc)) {
        logs.push(formatLogLine(`[MusicBrainz Einzeltrack #${trkPad}] Prüfe exakten ISRC ${isrc}...`));
        try {
          const isrcResp = await fetchWithExponentialBackoff(
            `https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(isrc)}?inc=artists+genres+tags+releases+release-groups&fmt=json`,
            { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
            2,
            logs,
            'MusicBrainz ISRC',
            undefined,
            true
          );
          if (isrcResp.status === 503 || isrcResp.status === 429) {
            res.json({
              match: null,
              logs: [
                ...logs,
                formatLogLine(
                  `[MusicBrainz Einzeltrack #${trkPad}] MusicBrainz vorübergehend überlastet (HTTP ${isrcResp.status}) – überspringe Fallback-Suche für diesen Titel.`
                ),
              ],
            });
            return;
          }
          if (isrcResp.ok) {
            const isrcData = (await isrcResp.json()) as { recordings?: any[] };
            const recs = Array.isArray(isrcData.recordings) ? isrcData.recordings : [];
            if (recs.length > 0) {
              recs.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
              bestRec = recs[0];
              isrcMatched = true;
              matchMethod = 'MusicBrainz (ISRC)';
            }
          }
        } catch {
          bestRec = null;
        }
      }

      // Stufe 2: Recording-Suche nach Titel + Interpret (+ Dauer-Bewertung)
      if (!bestRec) {
        if (!titleHint) {
          res.json({
            match: null,
            logs: [
              ...logs,
              formatLogLine(
                `[MusicBrainz Einzeltrack #${trkPad}] Übersprungen: kein auswertbarer Titel oder Dateiname vorhanden.`
              ),
            ],
          });
          return;
        }

        const escTitle = titleHint.replace(/"/g, '').trim();
        const escArtist = primaryArtistQuery.replace(/"/g, '').trim();
        const queries: string[] = [];
        if (escArtist) {
          queries.push(`recording:"${escTitle}" AND artist:"${escArtist}"`);
          queries.push(`recording:(${escTitle}) AND artist:(${escArtist})`);
        } else {
          if (durSec > 10) {
            const ms = durSec * 1000;
            queries.push(`recording:"${escTitle}" AND dur:[${Math.max(1000, ms - 6000)} TO ${ms + 6000}]`);
          }
          queries.push(`recording:"${escTitle}"`);
        }

        logs.push(
          formatLogLine(
            `[MusicBrainz Einzeltrack #${trkPad}] Suche Recording „${escTitle}“${escArtist ? ` von „${escArtist}“` : ''}${durSec > 0 ? ` (${durSec}s)` : ''}...`
          )
        );

        let candidates: any[] = [];
        let hadServiceError = false;
        for (let qIdx = 0; qIdx < queries.length; qIdx++) {
          const searchResp = await fetchWithExponentialBackoff(
            `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(queries[qIdx])}&limit=8&fmt=json`,
            { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
            2,
            logs,
            'MusicBrainz Einzeltrack',
            undefined,
            true
          );
          if (searchResp.status === 503 || searchResp.status === 429) {
            hadServiceError = true;
            logs.push(
              formatLogLine(
                `[MusicBrainz Einzeltrack #${trkPad}] MusicBrainz-Anfrage fehlgeschlagen (HTTP ${searchResp.status}).`
              )
            );
            break;
          }
          if (searchResp.ok) {
            const sData = (await searchResp.json()) as { recordings?: any[] };
            if (Array.isArray(sData.recordings) && sData.recordings.length > 0) {
              candidates = sData.recordings;
              break;
            }
          }
        }

        if (candidates.length === 0) {
          res.json({
            match: null,
            logs: hadServiceError
              ? logs
              : [
                  ...logs,
                  formatLogLine(`[MusicBrainz Einzeltrack #${trkPad}] Kein passendes Recording bei MusicBrainz gefunden.`),
                ],
          });
          return;
        }

        candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
        bestRec = candidates[0];
      }

      const recId = String(bestRec?.id || '').trim();
      let detailRec = bestRec;

      // Stufe 3: Recording-Details nur nachladen, falls Stufe 1 (ISRC) noch keine Genres/Artists/Releases geliefert hat oder tiefe Relationen aktiv sind
      const needDeepRels =
        String(req.headers['x-mb-deep-relations'] ?? 'false').trim().toLowerCase() === 'true';
      const hasIsrcDetails =
        isrcMatched &&
        Array.isArray(bestRec?.['artist-credit']) &&
        bestRec['artist-credit'].length > 0 &&
        ((Array.isArray(bestRec?.genres) && bestRec.genres.length > 0) ||
          (Array.isArray(bestRec?.tags) && bestRec.tags.length > 0) ||
          (Array.isArray(bestRec?.releases) && bestRec.releases.length > 0));
      if (recId && UUID_REGEX.test(recId) && (!hasIsrcDetails || needDeepRels)) {
        try {
          const incStr = needDeepRels
            ? 'artists+genres+tags+releases+release-groups+work-rels'
            : 'artists+genres+tags+releases+release-groups';
          const detResp = await fetchWithExponentialBackoff(
            `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(recId)}?inc=${incStr}&fmt=json`,
            { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
            2,
            logs,
            'MusicBrainz Recording-Details',
            undefined,
            true
          );
          if (detResp.ok) {
            const detData = await detResp.json();
            if (detData && detData.id) detailRec = detData;
          }
        } catch {
          // Nutze Such-Snippet
        }
      }

      const resolvedTitle = String(detailRec?.title || bestRec?.title || '').trim();
      const resolvedArtist = formatArtistCredit(detailRec?.['artist-credit'] || bestRec?.['artist-credit']);

      // IDs für parallele Wikidata-Genre-Abfrage einsammeln
      const workId = (Array.isArray(detailRec?.relations) ? detailRec.relations : [])
        .map((rel: any) => String(rel?.work?.id || '').trim())
        .find((id: string) => UUID_REGEX.test(id)) || '';
      const releaseGroupId = (Array.isArray(detailRec?.releases) ? detailRec.releases : [])
        .slice(0, 6)
        .map((rel: any) => String(rel?.['release-group']?.id || '').trim())
        .find((id: string) => UUID_REGEX.test(id)) || '';
      const artistIds = Array.from(
        new Set(
          (Array.isArray(detailRec?.['artist-credit']) ? detailRec['artist-credit'] : Array.isArray(bestRec?.['artist-credit']) ? bestRec['artist-credit'] : [])
            .map((c: any) => String(c?.artist?.id || '').trim())
            .filter((id: string) => UUID_REGEX.test(id))
        )
      ) as string[];

      const resolveMbGenre = async (): Promise<string> => {
        let mbGenre = extractGenresFromItems(detailRec?.genres);
        if (!mbGenre) {
          const recTags = (Array.isArray(detailRec?.tags) ? detailRec.tags : []).filter(
            (t: any) => Number(t?.count || 0) > 0
          );
          mbGenre = extractGenresFromItems(recTags);
        }
        if (!mbGenre && Array.isArray(detailRec?.releases)) {
          const rgGenres: any[] = [];
          const rgTags: any[] = [];
          for (const rel of detailRec.releases.slice(0, 6)) {
            const rg = rel?.['release-group'];
            if (!rg) continue;
            if (Array.isArray(rg.genres)) rgGenres.push(...rg.genres);
            if (Array.isArray(rg.tags)) {
              rgTags.push(...rg.tags.filter((t: any) => Number(t?.count || 0) > 0));
            }
          }
          mbGenre = extractGenresFromItems(rgGenres) || extractGenresFromItems(rgTags);
        }
        if (!mbGenre && artistIds.length > 0) {
          try {
            const artResp = await fetchWithExponentialBackoff(
              `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(artistIds[0])}?inc=genres+tags&fmt=json`,
              { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
              2,
              logs,
              'MusicBrainz Artist-Genre',
              undefined,
              true
            );
            if (artResp.ok) {
              const artData = await artResp.json();
              mbGenre = extractGenresFromItems(artData?.genres);
              if (!mbGenre) {
                const aTags = (Array.isArray(artData?.tags) ? artData.tags : []).filter(
                  (t: any) => Number(t?.count || 0) > 0
                );
                mbGenre = extractGenresFromItems(aTags);
              }
            }
          } catch {
            // Ignorieren
          }
        }
        return mbGenre;
      };

      // Gleichzeitige Genre-Abfrage: MusicBrainz + Wikidata für diesen Track
      const [mbGenreStr, wdGenres] = await Promise.all([
        resolveMbGenre(),
        fetchWikidataTrackGenres(
          recId,
          workId,
          releaseGroupId,
          artistIds,
          resolvedArtist,
          resolvedTitle
        ),
      ]);

      // Wikidata-Genres an MusicBrainz-Genres anhängen und strikt deduplizieren
      const resolvedGenre = mergeFormattedGenres([mbGenreStr, ...wdGenres], 10);

      const wdInfo = wdGenres.length > 0 ? ` (+${wdGenres.length} Wikidata-Rohwerte)` : '';
      logs.push(
        formatLogLine(
          `[MusicBrainz Einzeltrack #${trkPad}] Treffer: „${resolvedArtist || '—'} – ${resolvedTitle || '—'}“ · Genre (MB + Wikidata, dedupliziert${wdInfo}): ${resolvedGenre || '—'}`
        )
      );

      res.json({
        match: {
          recordingId: recId,
          title: resolvedTitle,
          artist: resolvedArtist,
          genre: resolvedGenre,
          mbGenre: mbGenreStr,
          wikidataGenres: wdGenres,
          method: matchMethod,
        },
        logs,
      });
    } catch (err) {
      res.status(502).json({
        error:
          err instanceof Error
            ? err.message
            : 'MusicBrainz Einzeltrack-Abfrage fehlgeschlagen.',
        logs,
      });
    }
  });

  // 2. MusicBrainz Release Details (inkl. aller MusicBrainz-Tags, Multi-CD, Multi-Genre, Tracks & ISRCs + Auto-Backoff bei 503)
  app.get('/api/musicbrainz/release/:mbid', async (req, res) => {
    const { mbid } = req.params;
    const requestedDisc = Number(req.query.disc || 1);
    if (!/^[a-f0-9-]{36}$/i.test(mbid)) {
      res.status(400).json({ error: 'Ungültige MusicBrainz Release-ID.' });
      return;
    }

    const loadDeepRelations =
      String(req.headers['x-mb-deep-relations'] ?? req.query.deepRelations ?? 'false')
        .trim()
        .toLowerCase() === 'true';
    const autoEnrichGenres =
      String(req.headers['x-auto-enrich-genres'] ?? req.query.autoEnrichGenres ?? 'true')
        .trim()
        .toLowerCase() !== 'false';
    const discogsToken = String(req.headers['x-discogs-token'] || req.query.discogsToken || '').trim();
    const lastfmApiKey = String(req.headers['x-lastfm-api-key'] || req.query.lastfmApiKey || '').trim();
    const preferSubgenres = requestMetaContext.getStore()?.preferSubgenres ?? true;

    try {
      const fullUrl = `https://musicbrainz.org/ws/2/release/${mbid}?inc=artists+recordings+labels+isrcs+release-groups+genres+tags+artist-rels+work-rels+url-rels+recording-level-rels+work-level-rels&fmt=json`;
      const compactUrl = `https://musicbrainz.org/ws/2/release/${mbid}?inc=artists+recordings+labels+isrcs+release-groups+genres+tags+discids+url-rels&fmt=json`;
      const primaryUrl = loadDeepRelations ? fullUrl : compactUrl;
      let response: Response | null = null;
      try {
        response = await fetchWithExponentialBackoff(
          primaryUrl,
          {
            headers: {
              'User-Agent': MB_USER_AGENT,
              Accept: 'application/json',
            },
          },
          2,
          undefined,
          loadDeepRelations ? 'MusicBrainz Release-Details (Tief)' : 'MusicBrainz Release-Details (Kompakt)'
        );
      } catch {
        response = null;
      }

      if (loadDeepRelations && (!response || (!response.ok && response.status !== 400 && response.status !== 404))) {
        response = await fetchWithExponentialBackoff(
          compactUrl,
          {
            headers: {
              'User-Agent': MB_USER_AGENT,
              Accept: 'application/json',
            },
          },
          2,
          undefined,
          'MusicBrainz Release-Details (Kompakt-Fallback)'
        );
      }

      if (!response || !response.ok) {
        res.status(response?.status || 502).json({
          error: `Release konnte nicht geladen werden (HTTP ${response?.status || 502}).`,
        });
        return;
      }

      const rel = (await response.json()) as any;
      preseedVerifyCacheFromMbRelease(rel);
      const artist = formatArtistCredit(rel['artist-credit']);
      const albumArtists = extractArtistNames(rel['artist-credit']);
      const albumArtistSort = formatArtistSortCredit(rel['artist-credit']);
      const musicbrainzAlbumArtistId = extractArtistIds(rel['artist-credit']);

      const labelList: any[] = Array.isArray(rel['label-info']) ? rel['label-info'] : [];
      const labels = Array.from(
        new Set(labelList.map((li) => li?.label?.name?.trim()).filter(Boolean))
      );
      const catalogNumbers = Array.from(
        new Set(labelList.map((li) => li?.['catalog-number']?.trim()).filter(Boolean))
      );

      const rg = rel['release-group'] || {};
      const releaseTypes: string[] = [];
      if (rg['primary-type']) releaseTypes.push(String(rg['primary-type']).toLowerCase());
      for (const st of rg['secondary-types'] || []) {
        if (st && !releaseTypes.includes(String(st).toLowerCase())) {
          releaseTypes.push(String(st).toLowerCase());
        }
      }

      const mediaList: any[] = Array.isArray(rel.media) ? rel.media : [];
      const totalDiscs = Math.max(1, mediaList.length);
      const discs = mediaList.map((m: any, idx: number) => ({
        position: Number(m?.position || idx + 1),
        title: String(m?.title || ''),
        format: String(m?.format || 'CD'),
        trackCount: Number(m?.['track-count'] || m?.tracks?.length || 0),
      }));

      const rawDiscParam = String(req.query.disc || '1').trim().toLowerCase();
      const loadAllDiscs = rawDiscParam === 'all' || rawDiscParam === '0';
      const medium =
        mediaList.find((m: any) => Number(m?.position || 0) === requestedDisc) ||
        mediaList[Math.max(0, Math.min(mediaList.length - 1, requestedDisc - 1))] ||
        mediaList[0];
      const mediaToLoad = loadAllDiscs && mediaList.length > 0 ? mediaList : medium ? [medium] : [];

      const relRelations = collectArtistRelations(rel.relations);
      const albumComposers = new Set<string>(relRelations.composer || []);
      const albumOrchestras = new Set<string>([
        ...(relRelations['performing orchestra'] || []),
        ...(relRelations.orchestra || []),
      ]);
      const albumConductors = new Set<string>(relRelations.conductor || []);

      const tracks = mediaToLoad.flatMap((mItem: any, mIdx: number) => {
        const medDiscNum = Number(mItem?.position || (loadAllDiscs ? mIdx + 1 : requestedDisc) || 1);
        const medSubtitle = String(mItem?.title || '').trim();
        return (mItem?.tracks || []).map((t: any, idx: number) => {
          const rec = t.recording || {};
          const lengthMs = Number(t.length || rec.length || 0);
          const ac = t['artist-credit'] || rec['artist-credit'];
          const trackArtist = formatArtistCredit(ac);
          const extractedArtists = extractArtistNames(ac);
          const trackArtists = extractedArtists.length > 0 ? extractedArtists : albumArtists;
          const trackArtistSort = formatArtistSortCredit(ac);
          const trackArtistId = extractArtistIds(ac) || musicbrainzAlbumArtistId;
          const isrcs: string[] = Array.from(
            new Set((rec.isrcs || []).map((c: any) => String(c || '').trim()).filter(Boolean))
          );

          const recRels = collectArtistRelations(rec.relations);
          const composerIds = collectArtistRoleIds(rec.relations, ['composer']);
          const composers: string[] = [...(recRels.composer || [])];
          const orchestras: string[] = [
            ...(recRels['performing orchestra'] || []),
            ...(recRels.orchestra || []),
            ...(relRelations['performing orchestra'] || []),
            ...(relRelations.orchestra || []),
          ];
          const conductors: string[] = [
            ...(recRels.conductor || []),
            ...(relRelations.conductor || []),
          ];
          const lyricists: string[] = [...(recRels.lyricist || [])];
          const writers: string[] = [...(recRels.writer || [])];
          const producers: string[] = [
            ...(recRels.producer || []),
            ...(relRelations.producer || []),
            ...(relRelations['executive producer'] || []),
          ];
          const arrangers: string[] = [...(recRels.arranger || []), ...(relRelations.arranger || [])];
          const engineers: string[] = [
            ...(recRels.engineer || []),
            ...(relRelations.engineer || []),
            ...(relRelations.mastering || []),
          ];
          const mixers: string[] = [...(recRels.mix || []), ...(relRelations.mix || [])];
          const djmixers: string[] = [...(recRels['dj-mix'] || []), ...(relRelations['dj-mix'] || [])];
          const remixers: string[] = [...(recRels.remixer || []), ...(relRelations.remixer || [])];
          const performers: string[] = [
            ...(recRels.performer || []),
            ...(recRels.instrument || []),
            ...(recRels.vocal || []),
          ];
          const workTitles: string[] = [];
          const workLangs: string[] = [];
          const workIds: string[] = [];

          for (const rItem of rec.relations || []) {
            if (rItem?.['target-type'] === 'work' && rItem.work) {
              if (rItem.work.id && !workIds.includes(rItem.work.id)) workIds.push(rItem.work.id);
              if (rItem.work.title) {
                const wt = String(rItem.work.title).trim();
                if (wt && !workTitles.includes(wt)) workTitles.push(wt);
              }
              const wkLangCandidates = Array.isArray(rItem.work.languages)
                ? rItem.work.languages
                : rItem.work.language
                  ? [rItem.work.language]
                  : [];
              for (const wl of wkLangCandidates) {
                const lStr = String(wl || '').trim();
                if (lStr && !workLangs.includes(lStr)) workLangs.push(lStr);
              }
              for (const cid of collectArtistRoleIds(rItem.work.relations, ['composer'])) {
                if (!composerIds.includes(cid)) composerIds.push(cid);
              }
              const wkRels = collectArtistRelations(rItem.work.relations);
              for (const c of wkRels.composer || []) {
                if (!composers.includes(c)) composers.push(c);
              }
              for (const l of wkRels.lyricist || []) {
                if (!lyricists.includes(l)) lyricists.push(l);
              }
              for (const w of wkRels.writer || []) {
                if (!writers.includes(w)) writers.push(w);
              }
              for (const a of wkRels.arranger || []) {
                if (!arrangers.includes(a)) arrangers.push(a);
              }
            }
          }

          for (const c of composers) albumComposers.add(c);
          for (const o of orchestras) albumOrchestras.add(o);
          for (const cond of conductors) albumConductors.add(cond);

          const recGenres = extractRecordingGenres(rec, preferSubgenres);

          return {
            trackNumber: Number(t.position || idx + 1),
            discNumber: medDiscNum,
            discSubtitle: medSubtitle,
            title: t.title || rec.title || `Titel ${idx + 1}`,
            artist: trackArtist !== 'Unbekannter Künstler' ? trackArtist : artist,
            artists: trackArtists,
            artistSort: trackArtistSort || albumArtistSort,
            durationSeconds: lengthMs > 0 ? Math.round(lengthMs / 1000) : 210,
            genre: recGenres.join('; '),
            isrc: isrcs.join('; '),
            isrcs,
            composer: Array.from(new Set(composers)).join('; '),
            orchestra: Array.from(new Set(orchestras)).join('; '),
            conductor: Array.from(new Set(conductors)).join('; '),
            lyricist: Array.from(new Set(lyricists)).join('; '),
            writer: Array.from(new Set(writers)).join('; '),
            producer: Array.from(new Set(producers)).join('; '),
            arranger: Array.from(new Set(arrangers)).join('; '),
            engineer: Array.from(new Set(engineers)).join('; '),
            mixer: Array.from(new Set(mixers)).join('; '),
            djmixer: Array.from(new Set(djmixers)).join('; '),
            remixer: Array.from(new Set(remixers)).join('; '),
            performers: Array.from(new Set(performers)),
            work: workTitles.join('; '),
            workLanguage: workLangs.join('; '),
            musicbrainzRecordingId: rec.id || '',
            musicbrainzTrackId: t.id || '',
            musicbrainzArtistId: trackArtistId,
            musicbrainzWorkId: workIds.join('; '),
            musicbrainzComposerId: composerIds.join('; '),
            metadataSource: 'MusicBrainz',
          };
        });
      });

      const mbGenres = extractMusicBrainzGenres(rel, preferSubgenres);
      const wikidataGenres = await fetchWikidataGenres(
        rel.id || mbid,
        rg.id || '',
        musicbrainzAlbumArtistId
      );
      let genreString = mergeFormattedGenres([...mbGenres, ...wikidataGenres], 7, preferSubgenres);

      // Automatisches Multi-Source Track-Genre-Enrichment, falls Tracks noch keine spezifischen Subgenres haben
      const tracksMissingSpecific = tracks.some((trk: any) => {
        const toks = String(trk.genre || '')
          .split(/\s*;\s*/)
          .filter(Boolean);
        return !toks.some((g) => !BROAD_UMBRELLA_GENRES.has(canonicalGenreDedupeKey(g)));
      });
      if (autoEnrichGenres && tracksMissingSpecific) {
        try {
          const enriched = await enrichAlbumTrackGenres({
            artist,
            albumTitle: rel.title || '',
            albumGenre: genreString,
            musicbrainzReleaseId: rel.id || mbid,
            musicbrainzReleaseGroupId: rg.id || '',
            tracks,
            discogsToken,
            lastfmApiKey,
            preferSubgenres,
          });
          if (enriched.albumGenre) {
            genreString = enriched.albumGenre;
          }
          for (let i = 0; i < tracks.length; i++) {
            const k = String(tracks[i].trackNumber || i + 1);
            if (enriched.trackGenres[k]) {
              tracks[i].genre = enriched.trackGenres[k];
            }
          }
        } catch {
          // Optionales Enrichment darf Release-Laden nicht blockieren
        }
      }

      const extractedAsin = extractAmazonAsinFromRelations(rel);

      // Deterministische 8-stellige CDDB-ID aus Release-Metadaten berechnen, falls lokal kein Laufwerk
      const totalSec = tracks.reduce((sum: number, t: { durationSeconds: number }) => sum + t.durationSeconds, 0);
      const pseudoChecksum = tracks.reduce((acc: number, t: { trackNumber: number; durationSeconds: number }) => acc + t.trackNumber * 7 + t.durationSeconds, 0);
      const cddbId = (((pseudoChecksum % 0xff) << 24) | ((Math.max(1, totalSec) & 0xffff) << 8) | (tracks.length & 0xff)) >>> 0;

      const releaseDate = String(rel.date || '').trim();
      res.json({
        release: {
          metadataSource: 'MusicBrainz',
          musicbrainzReleaseId: rel.id,
          musicbrainzReleaseGroupId: rg.id || '',
          musicbrainzAlbumArtistId,
          cddbId: cddbId.toString(16).padStart(8, '0'),
          title: rel.title || 'Unbekanntes Album',
          artist,
          albumArtist: artist,
          albumArtists,
          albumArtistSort,
          composer: Array.from(albumComposers).join('; '),
          orchestra: Array.from(albumOrchestras).join('; '),
          conductor: Array.from(albumConductors).join('; '),
          year: releaseDate.slice(0, 4),
          releaseDate,
          originalDate: rg['first-release-date'] || '',
          genre: genreString,
          label: labels.join('; '),
          catalogNumber: catalogNumbers.join('; '),
          barcode: rel.barcode || '',
          asin: extractedAsin,
          country: extractReleaseCountries(rel),
          status: String(rel.status || '').toLowerCase(),
          releaseType: releaseTypes.join('; '),
          mediaFormat: String(medium?.format || 'CD'),
          discSubtitle: String(medium?.title || ''),
          script: rel['text-representation']?.script || '',
          language: rel['text-representation']?.language || '',
          discNumber: Number(medium?.position || 1),
          totalDiscs,
          discs,
          tracks,
        },
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Fehler beim Abrufen der Release-Details.',
      });
    }
  });

  // 3a. Cover Art Archive Einzelbild-Proxy (für Multi-Treffer-Übersicht)
  app.get('/api/coverart/file', async (req, res) => {
    const targetUrl = String(req.query.url || '').trim().replace(/^http:\/\//i, 'https://');
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      res.status(400).json({ error: 'Ungültige Cover-URL.' });
      return;
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== 'coverartarchive.org' && !host.endsWith('.archive.org') && host !== 'archive.org') {
      res.status(403).json({ error: 'Nicht erlaubte Cover-Art-Archive-Domain.' });
      return;
    }
    try {
      const resp = await fetch(parsed.toString(), {
        headers: { 'User-Agent': MB_USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(9000),
      });
      if (!resp.ok) {
        res.status(resp.status).json({ error: 'Cover-Art-Archive-Bild nicht abrufbar.' });
        return;
      }
      const contentType = resp.headers.get('content-type') || 'image/jpeg';
      const buffer = Buffer.from(await resp.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buffer);
    } catch {
      res.status(502).json({ error: 'Cover-Art-Archive-Download fehlgeschlagen.' });
    }
  });

  // 3. Cover Art Archive Proxy (lädt automatisch Front-Cover von coverartarchive.org inkl. Release-Group-Fallback)
  app.get('/api/coverart/:mbid', async (req, res) => {
    const { mbid } = req.params;
    const rgParam = String(req.query.rg || '').trim();
    if (!/^[a-f0-9-]{36}$/i.test(mbid)) {
      res.status(400).json({ error: 'Ungültige MBID.' });
      return;
    }

    const candidates = [
      `https://coverartarchive.org/release/${mbid}/front-500`,
      `https://coverartarchive.org/release/${mbid}/front`,
    ];
    if (/^[a-f0-9-]{36}$/i.test(rgParam)) {
      candidates.push(
        `https://coverartarchive.org/release-group/${rgParam}/front-500`,
        `https://coverartarchive.org/release-group/${rgParam}/front`
      );
    }

    for (const url of candidates) {
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': MB_USER_AGENT },
          redirect: 'follow',
        });
        if (resp.ok) {
          const contentType = resp.headers.get('content-type') || 'image/jpeg';
          const buffer = Buffer.from(await resp.arrayBuffer());
          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.send(buffer);
          return;
        }
      } catch {
        // Nächsten Kandidaten testen
      }
    }

    // Falls noch keine Release-Group-ID übergeben wurde, Release-Group bei MusicBrainz nachschlagen
    if (!rgParam) {
      try {
        const mbResp = await fetchWithExponentialBackoff(
          `https://musicbrainz.org/ws/2/release/${mbid}?inc=release-groups&fmt=json`,
          { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
          2,
          undefined,
          'MusicBrainz Cover-Fallback'
        );
        if (mbResp.ok) {
          const mbData = (await mbResp.json()) as any;
          const rgId = mbData?.['release-group']?.id;
          if (rgId && /^[a-f0-9-]{36}$/i.test(rgId)) {
            for (const rgUrl of [
              `https://coverartarchive.org/release-group/${rgId}/front-500`,
              `https://coverartarchive.org/release-group/${rgId}/front`,
            ]) {
              const rgResp = await fetch(rgUrl, {
                headers: { 'User-Agent': MB_USER_AGENT },
                redirect: 'follow',
              });
              if (rgResp.ok) {
                const contentType = rgResp.headers.get('content-type') || 'image/jpeg';
                const buffer = Buffer.from(await rgResp.arrayBuffer());
                res.setHeader('Content-Type', contentType);
                res.setHeader('Cache-Control', 'public, max-age=86400');
                res.send(buffer);
                return;
              }
            }
          }
        }
      } catch {
        // Ignorieren
      }
    }

    res.status(404).json({ error: 'Kein Cover im Cover Art Archive gefunden.' });
  });

  // 3b. Discogs Release Details (inkl. Multi-CD, Genres + Wikidata, Cover, sowie [r524030] / [m63720] Code-Auflösung)
  app.get('/api/discogs/release/:id', async (req, res) => {
    const rawParam = String(req.params.id || '').trim();
    const requestedDisc = Number(req.query.disc || 1);
    const customToken = String(req.query.discogsToken || req.headers['x-discogs-token'] || '').trim();

    let rawId = await resolveDiscogsReleaseId(rawParam, customToken);
    if (!rawId || !/^\d+$/.test(rawId)) {
      res.status(400).json({ error: 'Ungültige Discogs Release-ID.' });
      return;
    }

    try {
      let response = await fetch(`https://api.discogs.com/releases/${rawId}`, {
        headers: discogsHeaders(customToken),
        signal: AbortSignal.timeout(9000),
      });
      if (response.status === 404) {
        const masterResolved = await resolveDiscogsReleaseId(`m${rawId}`, customToken);
        if (masterResolved && masterResolved !== rawId) {
          rawId = masterResolved;
          response = await fetch(`https://api.discogs.com/releases/${rawId}`, {
            headers: discogsHeaders(customToken),
            signal: AbortSignal.timeout(9000),
          });
        }
      }
      if (!response.ok) {
        res.status(response.status).json({ error: `Discogs Fehler (${response.status})` });
        return;
      }
      const rel = (await response.json()) as any;
      const artist = formatDiscogsArtists(rel.artists);
      const albumArtists = Array.from(
        new Set(
          (rel.artists || [])
            .map((a: any) => cleanDiscogsName(a?.anv || a?.name || ''))
            .filter(Boolean)
        )
      ) as string[];
      const albumArtistSort = normalizeMultiArtist(cleanDiscogsName(rel.artists_sort || ''));
      const labels = Array.from(
        new Set((rel.labels || []).map((l: any) => cleanDiscogsName(l?.name || '')).filter(Boolean))
      );
      const catnos = Array.from(
        new Set(
          (rel.labels || [])
            .map((l: any) => String(l?.catno || '').trim())
            .filter((c: string) => Boolean(c) && c.toLowerCase() !== 'none')
        )
      );
      const barcodes = Array.from(
        new Set(
          (rel.identifiers || [])
            .filter((id: any) => String(id?.type || '').toLowerCase() === 'barcode' && id?.value)
            .map((id: any) => String(id.value).trim())
            .filter(Boolean)
        )
      );
      const formats = Array.isArray(rel.formats) ? rel.formats : [];
      const mediaFormat = String(formats[0]?.name || 'CD');
      const formatQty = Math.max(1, Number(formats[0]?.qty || 1) || 1);

      const rawDiscParam = String(req.query.disc || '1').trim().toLowerCase();
      const loadAllDiscs = rawDiscParam === 'all' || rawDiscParam === '0';

      const discBuckets = new Map<number, any[]>();
      let fallbackIdx = 0;
      for (const item of rel.tracklist || []) {
        if (item?.type_ && item.type_ !== 'track') continue;
        fallbackIdx += 1;
        const { disc, track } = parseDiscogsPosition(item?.position || '', fallbackIdx);
        const trkArtist = Array.isArray(item?.artists) && item.artists.length > 0
          ? formatDiscogsArtists(item.artists)
          : artist;
        const trkArtists =
          Array.isArray(item?.artists) && item.artists.length > 0
            ? Array.from(
                new Set(
                  item.artists
                    .map((a: any) => cleanDiscogsName(a?.anv || a?.name || ''))
                    .filter(Boolean)
                )
              )
            : albumArtists;

        const composers: string[] = [];
        const lyricists: string[] = [];
        const producers: string[] = [];
        const mixers: string[] = [];
        const engineers: string[] = [];
        const remixers: string[] = [];
        for (const ea of item?.extraartists || []) {
          const role = String(ea?.role || '').toLowerCase();
          const eaName = cleanDiscogsName(ea?.anv || ea?.name || '');
          if (!eaName) continue;
          if ((role.includes('written-by') || role.includes('composed') || role.includes('music by')) && !composers.includes(eaName)) {
            composers.push(eaName);
          }
          if ((role.includes('lyrics') || role.includes('words by')) && !lyricists.includes(eaName)) {
            lyricists.push(eaName);
          }
          if (role.includes('producer') && !producers.includes(eaName)) {
            producers.push(eaName);
          }
          if (role.includes('remix') && !remixers.includes(eaName)) {
            remixers.push(eaName);
          } else if (role.includes('mix') && !mixers.includes(eaName)) {
            mixers.push(eaName);
          }
          if ((role.includes('master') || role.includes('engineer')) && !engineers.includes(eaName)) {
            engineers.push(eaName);
          }
        }

        const arr = discBuckets.get(disc) || [];
        arr.push({
          trackNumber: track,
          discNumber: disc,
          title: item?.title || `Titel ${track}`,
          artist: trkArtist,
          artists: trkArtists,
          artistSort: '',
          durationSeconds: parseDiscogsDuration(item?.duration || '') || 210,
          isrc: '',
          composer: composers.join('; '),
          lyricist: lyricists.join('; '),
          producer: producers.join('; '),
          mixer: mixers.join('; '),
          engineer: engineers.join('; '),
          remixer: remixers.join('; '),
          metadataSource: 'Discogs',
        });
        discBuckets.set(disc, arr);
      }

      const discNumbers = Array.from(discBuckets.keys()).sort((a, b) => a - b);
      if (discNumbers.length === 0) discNumbers.push(1);
      const totalDiscs = Math.max(formatQty, discNumbers.length, discNumbers[discNumbers.length - 1]);
      const chosenDisc = discBuckets.has(requestedDisc) ? requestedDisc : discNumbers[0];
      const tracks = loadAllDiscs
        ? discNumbers.flatMap((pos) => discBuckets.get(pos) || [])
        : discBuckets.get(chosenDisc) || [];
      const discs = discNumbers.map((pos) => ({
        position: pos,
        title: '',
        format: mediaFormat,
        trackCount: (discBuckets.get(pos) || []).length,
      }));

      const discogsGenres = [...(rel.genres || []), ...(rel.styles || [])].map(String);
      const wdGenres = await fetchWikidataGenresByName(artist, String(rel.title || ''));
      const genreString = mergeFormattedGenres([...discogsGenres, ...wdGenres], 7);

      const images = Array.isArray(rel.images) ? rel.images : [];
      const primaryImg = images.find((img: any) => img?.type === 'primary') || images[0];
      const coverRawUrl = String(primaryImg?.uri || primaryImg?.resource_url || '');
      const coverArtUrl = coverRawUrl ? `/api/discogs/cover?url=${encodeURIComponent(coverRawUrl)}` : null;

      const releaseDate = String(rel.released || rel.year || '').trim();
      const totalSec = tracks.reduce((sum: number, t: { durationSeconds: number }) => sum + t.durationSeconds, 0);
      const pseudoChecksum = tracks.reduce((acc: number, t: { trackNumber: number; durationSeconds: number }) => acc + t.trackNumber * 7 + t.durationSeconds, 0);
      const cddbId = (((pseudoChecksum % 0xff) << 24) | ((Math.max(1, totalSec) & 0xffff) << 8) | (tracks.length & 0xff)) >>> 0;

      res.json({
        release: {
          source: 'discogs',
          metadataSource: 'Discogs',
          discogsId: rawId,
          musicbrainzReleaseId: '',
          cddbId: cddbId.toString(16).padStart(8, '0'),
          title: rel.title || 'Unbekanntes Album',
          artist,
          albumArtist: artist,
          albumArtists,
          albumArtistSort,
          year: String(rel.year || releaseDate.slice(0, 4) || ''),
          releaseDate,
          genre: genreString,
          label: labels.join('; '),
          catalogNumber: catnos.join('; '),
          barcode: barcodes.join('; '),
          country: String(rel.country || ''),
          status: String(rel.status || '').toLowerCase(),
          mediaFormat,
          discNumber: chosenDisc,
          totalDiscs,
          discs,
          coverArtUrl,
          coverArtSource: coverArtUrl ? 'Discogs Cover' : 'Kein Cover',
          tracks,
        },
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Discogs-Abruf fehlgeschlagen.',
      });
    }
  });

  // 3c. Discogs Cover Image Proxy
  app.get('/api/discogs/cover', async (req, res) => {
    const targetUrl = String(req.query.url || '').trim();
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      res.status(400).json({ error: 'Ungültige Cover-URL.' });
      return;
    }
    if (!['i.discogs.com', 'img.discogs.com', 'api-img.discogs.com'].includes(parsed.hostname)) {
      res.status(403).json({ error: 'Nicht erlaubte Cover-Domain.' });
      return;
    }
    try {
      const resp = await fetch(parsed.toString(), {
        headers: { 'User-Agent': DISCOGS_USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        res.status(resp.status).json({ error: 'Discogs-Cover nicht abrufbar.' });
        return;
      }
      const contentType = resp.headers.get('content-type') || 'image/jpeg';
      const buffer = Buffer.from(await resp.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buffer);
    } catch {
      res.status(502).json({ error: 'Discogs-Cover-Download fehlgeschlagen.' });
    }
  });

  // 3d. CDDB/GnuDB Read Proxy (Stufe 3 Fallback nach MusicBrainz & Discogs)
  app.get('/api/cddb/release/:category/:discid', async (req, res) => {
    const cat = String(req.params.category || '').trim();
    const discid = String(req.params.discid || '').trim().toLowerCase();
    const hit = await lookupCddbByDiscId(discid, undefined, undefined, cat);
    if (!hit) {
      res.status(404).json({ error: `CDDB-Eintrag ${cat}/${discid} nicht gefunden.` });
      return;
    }
    const wdGenres = await fetchWikidataGenresByName(hit.artist, hit.title);
    res.json({
      release: {
        source: 'cddb',
        metadataSource: 'CDDB',
        musicbrainzReleaseId: '',
        cddbId: hit.cddbId,
        title: hit.title,
        artist: hit.artist,
        albumArtist: hit.albumArtist,
        year: hit.year,
        genre: mergeFormattedGenres([hit.genre, ...wdGenres], 7),
        label: '',
        discNumber: 1,
        totalDiscs: 1,
        coverArtUrl: null,
        coverArtSource: 'CDDB (ohne Cover)',
        tracks: hit.tracks.map((t: any) => ({ ...t, metadataSource: 'CDDB' })),
      },
    });
  });

  // 3d. Schnelle Album- & Tracklisten-Vorschau für Klick auf ein Album in der Trefferliste (leichtgewichtig & zwischengespeichert)
  interface PreviewAlbumPayload {
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

  const previewTracksCache = new Map<string, PreviewAlbumPayload>();

  app.get('/api/metadata/preview-tracks', async (req, res) => {
    const rawId = String(req.query.id || '').trim();
    const rawSource = String(req.query.source || '').trim().toLowerCase();
    const effectiveSource: 'musicbrainz' | 'discogs' | 'cddb' =
      rawSource === 'discogs' || rawId.toLowerCase().startsWith('discogs:')
        ? 'discogs'
        : rawSource === 'cddb' || rawId.toLowerCase().startsWith('cddb:')
          ? 'cddb'
          : 'musicbrainz';
    if (!rawId) {
      res.status(400).json({ error: 'Keine Release-ID angegeben.' });
      return;
    }

    const cacheKey = `${effectiveSource}:${rawId}`;
    const cached = previewTracksCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const customToken = String(req.query.discogsToken || req.headers['x-discogs-token'] || '').trim();

    try {
      let payload: PreviewAlbumPayload;

      if (effectiveSource === 'discogs') {
        const stripped = rawId.replace(/^discogs:/i, '').trim();
        let resolvedId = await resolveDiscogsReleaseId(stripped, customToken);
        if (!resolvedId || !/^\d+$/.test(resolvedId)) {
          res.status(400).json({ error: 'Ungültige Discogs Release-ID.' });
          return;
        }
        let resp = await fetch(`https://api.discogs.com/releases/${resolvedId}`, {
          headers: discogsHeaders(customToken),
          signal: AbortSignal.timeout(9000),
        });
        if (resp.status === 404) {
          const masterResolved = await resolveDiscogsReleaseId(`m${resolvedId}`, customToken);
          if (masterResolved && masterResolved !== resolvedId) {
            resolvedId = masterResolved;
            resp = await fetch(`https://api.discogs.com/releases/${resolvedId}`, {
              headers: discogsHeaders(customToken),
              signal: AbortSignal.timeout(9000),
            });
          }
        }
        if (!resp.ok) {
          res.status(resp.status).json({ error: `Discogs-Vorschau fehlgeschlagen (HTTP ${resp.status}).` });
          return;
        }
        const rel = (await resp.json()) as any;
        const albumArtist = formatDiscogsArtists(rel.artists) || 'Unbekannter Künstler';
        const labels = Array.from(
          new Set((rel.labels || []).map((l: any) => cleanDiscogsName(l?.name || '')).filter(Boolean))
        ) as string[];
        const catnos = Array.from(
          new Set(
            (rel.labels || [])
              .map((l: any) => String(l?.catno || '').trim())
              .filter((c: string) => Boolean(c) && c.toLowerCase() !== 'none')
          )
        ) as string[];
        const barcodes = Array.from(
          new Set(
            (rel.identifiers || [])
              .filter((id: any) => String(id?.type || '').toLowerCase() === 'barcode' && id?.value)
              .map((id: any) => String(id.value).trim())
              .filter(Boolean)
          )
        ) as string[];
        const formats = Array.isArray(rel.formats) ? rel.formats : [];
        const fmtParts = formats
          .map((f: any) => {
            const qty = Number(f?.qty || 1);
            const name = String(f?.name || '').trim();
            if (!name) return '';
            return qty > 1 ? `${qty} × ${name}` : name;
          })
          .filter(Boolean);
        const discogsGenres = [...(rel.genres || []), ...(rel.styles || [])]
          .map((g: any) => String(g || '').trim())
          .filter(Boolean);
        const primaryImg =
          (Array.isArray(rel.images) && (rel.images.find((i: any) => i?.type === 'primary') || rel.images[0])) ||
          null;
        const rawCover = String(primaryImg?.uri150 || primaryImg?.uri || rel.thumb || '').trim();
        const coverUrl = rawCover ? `/api/discogs/cover?url=${encodeURIComponent(rawCover)}` : '';

        let fallbackIdx = 0;
        const discSet = new Set<number>();
        const tracks: PreviewAlbumPayload['tracks'] = [];
        for (const item of rel.tracklist || []) {
          if (item?.type_ && item.type_ !== 'track') continue;
          fallbackIdx += 1;
          const { disc, track } = parseDiscogsPosition(item?.position || '', fallbackIdx);
          discSet.add(disc);
          const trkArtist =
            Array.isArray(item?.artists) && item.artists.length > 0
              ? formatDiscogsArtists(item.artists)
              : albumArtist;
          tracks.push({
            discNumber: disc,
            discSubtitle: '',
            trackNumber: track,
            title: String(item?.title || `Titel ${track}`),
            artist: trkArtist,
            durationSeconds: parseDiscogsDuration(item?.duration || '') || 0,
          });
        }
        payload = {
          title: String(rel.title || ''),
          artist: albumArtist,
          albumArtist,
          date: String(rel.released || rel.year || ''),
          originalDate: '',
          country: String(rel.country || ''),
          status: String(rel.status || ''),
          barcode: barcodes[0] || '',
          asin: '',
          label: labels.join('; '),
          catalogNumber: catnos.join('; '),
          genre: mergeFormattedGenres(discogsGenres, 7),
          releaseType: Array.isArray(formats[0]?.descriptions)
            ? formats[0].descriptions.slice(0, 3).join(', ')
            : '',
          mediaFormat: fmtParts.join(' + ') || 'CD',
          disambiguation: String(rel.notes || '').trim().slice(0, 180),
          language: '',
          sourceId: `[r${resolvedId}]`,
          coverUrl,
          totalDiscs: Math.max(1, discSet.size),
          tracks,
        };
      } else if (effectiveSource === 'cddb') {
        const parts = rawId.split(':');
        const category = parts.length >= 3 ? parts[1] : 'misc';
        const discid = (parts.length >= 3 ? parts[2] : parts[1] || rawId).trim().toLowerCase();
        const hit = await lookupCddbByDiscId(discid, undefined, undefined, category);
        if (!hit) {
          res.status(404).json({ error: `CDDB-Eintrag ${category}/${discid} nicht gefunden.` });
          return;
        }
        payload = {
          title: String(hit.title || ''),
          artist: String(hit.artist || ''),
          albumArtist: String(hit.albumArtist || hit.artist || ''),
          date: String(hit.year || ''),
          originalDate: '',
          country: '',
          status: '',
          barcode: '',
          asin: '',
          label: '',
          catalogNumber: '',
          genre: mergeFormattedGenres([String(hit.genre || '')], 7),
          releaseType: category ? `CDDB (${category})` : 'CDDB',
          mediaFormat: 'CD',
          disambiguation: '',
          language: '',
          sourceId: `${category}/${discid}`,
          coverUrl: '',
          totalDiscs: 1,
          tracks: (hit.tracks || []).map((t: any, idx: number) => ({
            discNumber: 1,
            discSubtitle: '',
            trackNumber: Number(t.trackNumber || idx + 1),
            title: String(t.title || `Titel ${idx + 1}`),
            artist: String(t.artist || hit.artist || ''),
            durationSeconds: Number(t.durationSeconds || 0),
          })),
        };
      } else {
        if (!/^[a-f0-9-]{36}$/i.test(rawId)) {
          res.status(400).json({ error: 'Ungültige MusicBrainz Release-ID.' });
          return;
        }
        const resp = await fetchWithExponentialBackoff(
          `https://musicbrainz.org/ws/2/release/${rawId}?inc=artists+recordings+labels+release-groups+genres+tags&fmt=json`,
          {
            headers: {
              'User-Agent': MB_USER_AGENT,
              Accept: 'application/json',
            },
          },
          2,
          undefined,
          'MusicBrainz Album- & Tracklisten-Vorschau'
        );
        if (!resp.ok) {
          res.status(resp.status).json({ error: `Trackliste konnte nicht geladen werden (HTTP ${resp.status}).` });
          return;
        }
        const rel = (await resp.json()) as any;
        const albumArtist = formatArtistCredit(rel['artist-credit']) || 'Unbekannter Künstler';
        const labelList: any[] = Array.isArray(rel['label-info']) ? rel['label-info'] : [];
        const labels = Array.from(
          new Set(labelList.map((li) => li?.label?.name?.trim()).filter(Boolean))
        ) as string[];
        const catnos = Array.from(
          new Set(labelList.map((li) => li?.['catalog-number']?.trim()).filter(Boolean))
        ) as string[];
        const rg = rel['release-group'] || {};
        const relTypes: string[] = [];
        if (rg['primary-type']) relTypes.push(String(rg['primary-type']));
        for (const st of rg['secondary-types'] || []) {
          if (st && !relTypes.includes(String(st))) relTypes.push(String(st));
        }
        const mediaList: any[] = Array.isArray(rel.media) ? rel.media : [];
        const formatCounts = new Map<string, number>();
        for (const m of mediaList) {
          const f = String(m?.format || 'CD').trim();
          formatCounts.set(f, (formatCounts.get(f) || 0) + 1);
        }
        const mediaFormat = Array.from(formatCounts.entries())
          .map(([f, cnt]) => (cnt > 1 ? `${cnt} × ${f}` : f))
          .join(' + ');
        const mbGenres = extractMusicBrainzGenres(rel);
        const textRep = rel['text-representation'] || {};
        const langParts = [textRep.language, textRep.script].filter(Boolean).join(' / ');
        const rgId = String(rg.id || '').trim();
        const coverUrl = rgId
          ? `/api/coverart/${encodeURIComponent(rawId)}?rg=${encodeURIComponent(rgId)}`
          : `/api/coverart/${encodeURIComponent(rawId)}`;

        const tracks = mediaList.flatMap((mItem: any, mIdx: number) => {
          const discNum = Number(mItem?.position || mIdx + 1);
          const discSub = String(mItem?.title || '').trim();
          return (mItem?.tracks || []).map((t: any, idx: number) => {
            const rec = t.recording || {};
            const lenMs = Number(t.length || rec.length || 0);
            const trkArtist =
              formatArtistCredit(t['artist-credit']) ||
              formatArtistCredit(rec['artist-credit']) ||
              albumArtist;
            return {
              discNumber: discNum,
              discSubtitle: discSub,
              trackNumber: Number(t.position || idx + 1),
              title: String(t.title || rec.title || `Titel ${idx + 1}`),
              artist: trkArtist,
              durationSeconds: lenMs > 0 ? Math.round(lenMs / 1000) : 0,
            };
          });
        });
        payload = {
          title: String(rel.title || ''),
          artist: albumArtist,
          albumArtist,
          date: String(rel.date || ''),
          originalDate: String(rg['first-release-date'] || ''),
          country: String(rel.country || ''),
          status: String(rel.status || ''),
          barcode: String(rel.barcode || ''),
          asin: String(rel.asin || ''),
          label: labels.join('; '),
          catalogNumber: catnos.join('; '),
          genre: mergeFormattedGenres(mbGenres, 7),
          releaseType: relTypes.join(', '),
          mediaFormat: mediaFormat || 'CD',
          disambiguation: String(rel.disambiguation || ''),
          language: langParts,
          sourceId: rawId,
          coverUrl,
          totalDiscs: Math.max(1, mediaList.length),
          tracks,
        };
      }

      if (previewTracksCache.size >= 150) {
        const firstKey = previewTracksCache.keys().next().value;
        if (firstKey) previewTracksCache.delete(firstKey);
      }
      previewTracksCache.set(cacheKey, payload);
      res.json(payload);
    } catch (err: any) {
      res.status(502).json({
        error: err?.message || 'Tracklisten-Vorschau konnte nicht geladen werden.',
      });
    }
  });

  // 3e. Amazon Cover Image Proxy (löst ASIN direkt oder via MusicBrainz auf und lädt Produktbild)
  app.get('/api/amazon/cover', async (req, res) => {
    const asin = await resolveAmazonAsinHelper({
      asin: String(req.query.asin || ''),
      mbid: String(req.query.mbid || ''),
      artist: String(req.query.artist || ''),
      title: String(req.query.title || ''),
      barcode: String(req.query.barcode || ''),
    });

    if (!asin) {
      res.status(404).json({
        error: 'Keine Amazon-ASIN für dieses Release gefunden. Bitte ASIN im Feld "Amazon ASIN" eintragen.',
      });
      return;
    }

    const candidates = [
      `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg`,
      `https://images-na.ssl-images-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg`,
      `https://m.media-amazon.com/images/P/${asin}.01.LZZZZZZZ.jpg`,
    ];

    for (const url of candidates) {
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': MB_USER_AGENT },
          redirect: 'follow',
          signal: AbortSignal.timeout(7500),
        });
        if (resp.ok) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          // Amazon liefert ein 43-Byte 1x1 GIF, wenn kein Produktbild existiert
          if (buffer.length > 1500) {
            const contentType = resp.headers.get('content-type') || 'image/jpeg';
            res.setHeader('Content-Type', contentType);
            res.setHeader('X-Amazon-Asin', asin);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.send(buffer);
            return;
          }
        }
      } catch {
        // Nächsten Server testen
      }
    }

    res.status(404).json({
      error: `Kein gültiges Cover-Bild auf den Amazon-Bildservern für ASIN ${asin} verfügbar.`,
    });
  });

  // 3e-2. iTunes / Apple Music Cover Image Proxy
  app.get('/api/itunes/cover', async (req, res) => {
    const targetUrl = String(req.query.url || '').trim().replace(/^http:\/\//i, 'https://');
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      res.status(400).json({ error: 'Ungültige iTunes-Cover-URL.' });
      return;
    }
    if (!parsed.hostname.toLowerCase().endsWith('.mzstatic.com')) {
      res.status(403).json({ error: 'Nicht erlaubte iTunes-Cover-Domain.' });
      return;
    }
    try {
      const resp = await fetch(parsed.toString(), {
        headers: { 'User-Agent': MB_USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        res.status(resp.status).json({ error: 'iTunes-Cover nicht abrufbar.' });
        return;
      }
      const contentType = resp.headers.get('content-type') || 'image/jpeg';
      const buffer = Buffer.from(await resp.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buffer);
    } catch {
      res.status(502).json({ error: 'iTunes-Cover-Download fehlgeschlagen.' });
    }
  });

  // 3e-2b. Universeller Cover-Bild-Proxy mit strenger Domain-Allowlist (Deezer, TheAudioDB, Bandcamp, iTunes, CAA)
  app.get('/api/cover/proxy', async (req, res) => {
    const targetUrl = String(req.query.url || '').trim().replace(/^http:\/\//i, 'https://');
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      res.status(400).json({ error: 'Ungültige Cover-URL.' });
      return;
    }
    const host = parsed.hostname.toLowerCase();
    const isAllowed =
      host === 'coverartarchive.org' ||
      host === 'archive.org' ||
      host.endsWith('.archive.org') ||
      host.endsWith('.dzcdn.net') ||
      host === 'api.deezer.com' ||
      host === 'theaudiodb.com' ||
      host.endsWith('.theaudiodb.com') ||
      host.endsWith('.bcbits.com') ||
      host.endsWith('.mzstatic.com') ||
      host.endsWith('.discogs.com') ||
      host === 'm.media-amazon.com' ||
      host.endsWith('.ssl-images-amazon.com');
    if (!isAllowed) {
      res.status(403).json({ error: 'Nicht erlaubte Cover-Domain.' });
      return;
    }
    try {
      const resp = await fetch(parsed.toString(), {
        headers: { 'User-Agent': MB_USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(9000),
      });
      if (!resp.ok) {
        res.status(resp.status).json({ error: 'Cover-Bild nicht abrufbar.' });
        return;
      }
      const contentType = resp.headers.get('content-type') || 'image/jpeg';
      const buffer = Buffer.from(await resp.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buffer);
    } catch {
      res.status(502).json({ error: 'Cover-Download fehlgeschlagen.' });
    }
  });

  // 3e-3. Kombinierte Cover-Bildsuche über alle aktivierten Provider
  // (MusicBrainz CAA, MusicBrainz Release-Group CAA, Deezer, TheAudioDB, Bandcamp, iTunes DE & Multi-Region US/JP, Discogs, Amazon)
  app.get('/api/cover/search', async (req, res) => {
    const ALL_PROVIDER_IDS = [
      'musicbrainz_caa',
      'musicbrainz_rg_caa',
      'deezer',
      'theaudiodb',
      'bandcamp',
      'itunes',
      'itunes_multi_region',
      'discogs',
      'amazon',
    ] as const;
    const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
      musicbrainz_caa: 'MusicBrainz CAA',
      musicbrainz_rg_caa: 'MusicBrainz Release-Group',
      deezer: 'Deezer',
      theaudiodb: 'TheAudioDB',
      bandcamp: 'Bandcamp',
      itunes: 'iTunes / Apple (DE)',
      itunes_multi_region: 'iTunes Multi-Region (US & JP)',
      discogs: 'Discogs',
      amazon: 'Amazon',
    };

    const rawProvidersParam = req.query.providers;
    let enabledProviderIds: string[];
    if (typeof rawProvidersParam === 'string') {
      const requested = rawProvidersParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const validSet = new Set<string>(ALL_PROVIDER_IDS);
      enabledProviderIds = ALL_PROVIDER_IDS.filter((id) => requested.includes(id) && validSet.has(id));
    } else {
      enabledProviderIds = [...ALL_PROVIDER_IDS];
    }
    const activeSet = new Set<string>(enabledProviderIds);

    if (activeSet.size === 0) {
      res.json({
        candidates: [],
        logs: [formatLogLine('[Cover-Suche] Keine Cover-Bilddatenbank in den Einstellungen aktiviert.')],
        providersQueried: [],
      });
      return;
    }

    const rawQuery = String(req.query.q || '').trim();
    let artist = String(req.query.artist || '').trim();
    let title = String(req.query.title || '').trim();
    let mbid = String(req.query.mbid || '').trim();
    let rgid = String(req.query.rgid || '').trim();
    let rawDiscogsParam = String(req.query.discogsId || '').trim();
    let asin = String(req.query.asin || '').trim().toUpperCase();
    let barcode = String(req.query.barcode || '').trim();
    const customToken = String(req.query.discogsToken || req.headers['x-discogs-token'] || '').trim();
    const effectiveToken = customToken || String(process.env.DISCOGS_TOKEN || '').trim();

    if (rawQuery) {
      const mbRgMatch = rawQuery.match(/musicbrainz\.org\/release-group\/([a-f0-9-]{36})/i);
      const mbUrlMatch = rawQuery.match(/musicbrainz\.org\/release\/([a-f0-9-]{36})/i);
      if (mbRgMatch) {
        rgid = mbRgMatch[1].toLowerCase();
      } else if (mbUrlMatch) {
        mbid = mbUrlMatch[1].toLowerCase();
      } else if (UUID_REGEX.test(rawQuery)) {
        mbid = rawQuery.toLowerCase();
      } else if (
        /\[\s*[rm]?\s*\d{2,12}\s*\]/i.test(rawQuery) ||
        /^(?:discogs\s*:\s*)?(?:(?:release|master)\s*[:/]\s*)?\[?\s*[rm]\s*\d{2,12}\s*\]?$/i.test(rawQuery) ||
        /discogs\.com\/(?:[^/]+\/)?(?:release|master)\/\d{2,12}/i.test(rawQuery)
      ) {
        rawDiscogsParam = rawQuery;
      } else if (/^\d{8,14}$/.test(rawQuery.replace(/[\s-]+/g, ''))) {
        barcode = rawQuery.replace(/[\s-]+/g, '');
      } else if (/^B[0-9A-Z]{9}$/i.test(rawQuery)) {
        asin = rawQuery.toUpperCase();
      } else if (!artist && !title) {
        const dashMatch = rawQuery.match(/^(.+?)\s+[-–—]\s+(.+)$/);
        if (dashMatch) {
          artist = dashMatch[1].trim();
          title = dashMatch[2].trim();
        }
      }
    }

    const discogsId =
      (rawDiscogsParam && activeSet.has('discogs')
        ? await resolveDiscogsReleaseId(rawDiscogsParam, effectiveToken)
        : null) || '';

    if (!rawQuery && !artist && !title && !mbid && !rgid && !discogsId && !asin && !barcode) {
      res.status(400).json({ error: 'Mindestens Suchbegriff, Künstler/Album, MBID, Discogs-ID, ASIN oder Barcode erforderlich.' });
      return;
    }

    const effArtist = artist && artist !== 'Unbekannter Künstler' ? artist : '';
    const effTitle =
      title && title !== 'Unbekanntes Album' && title !== 'Audio-CD (Lokal ausgelesen)' ? title : '';
    const freeTextQuery =
      rawQuery && !mbid && !rgid && !rawDiscogsParam && !barcode && !asin
        ? rawQuery
        : [effArtist, effTitle].filter(Boolean).join(' ').trim();
    const searchTerm = [effArtist, effTitle].filter(Boolean).join(' ').trim() || freeTextQuery;

    const queriedLabels = enabledProviderIds.map((id) => PROVIDER_DISPLAY_NAMES[id] || id);
    const logs: string[] = [];
    logs.push(
      formatLogLine(
        `[Cover-Suche] Frage aktivierte Provider parallel ab (${queriedLabels.join(' · ')}) für „${
          rawQuery || `${artist || '—'} – ${title || '—'}`
        }“...`
      )
    );

    type RawCoverProvider =
      | 'musicbrainz'
      | 'musicbrainz_rg'
      | 'deezer'
      | 'theaudiodb'
      | 'bandcamp'
      | 'discogs'
      | 'amazon'
      | 'itunes';

    interface RawCoverEntry {
      provider: RawCoverProvider;
      providerLabel: string;
      sourceLabel: string;
      title: string;
      artist: string;
      date?: string;
      details?: string;
      directFetchUrl: string;
      imageUrl: string;
      thumbnailUrl: string;
      fetchHeaders?: Record<string, string>;
      mbid?: string;
      discogsId?: string;
      asin?: string;
    }

    const rawEntries: RawCoverEntry[] = [];
    const addRawEntry = (entry: RawCoverEntry) => {
      const key = entry.directFetchUrl.replace(/^http:\/\//i, 'https://');
      if (!key) return;
      rawEntries.push({ ...entry, directFetchUrl: key });
    };

    const mbSearchHits: Array<{
      id: string;
      title: string;
      artist: string;
      date: string;
      country: string;
      label: string;
      rgId?: string;
      asin?: string;
    }> = [];
    const rgMetaMap = new Map<string, { title: string; artist: string; date: string; country?: string; label?: string }>();
    if (UUID_REGEX.test(rgid)) {
      rgMetaMap.set(rgid, { title: effTitle || 'Album', artist: effArtist || 'Unbekannt', date: '' });
    }

    // 1. MusicBrainz Release & Release-Group Metadaten + CAA (Release & Release-Group)
    const mbPromise = (async () => {
      const needMbLookup =
        activeSet.has('musicbrainz_caa') ||
        activeSet.has('musicbrainz_rg_caa') ||
        activeSet.has('theaudiodb') ||
        activeSet.has('amazon');
      if (!needMbLookup) return;

      const candidateIds: string[] = [];
      if (UUID_REGEX.test(mbid)) {
        candidateIds.push(mbid);
      }

      const mbTerms: string[] = [];
      if (barcode) mbTerms.push(`barcode:${barcode}`);
      if (effArtist) mbTerms.push(`artist:"${effArtist}"`);
      if (effTitle) mbTerms.push(`release:"${effTitle}"`);
      const mbQueryStr = mbTerms.length > 0 ? mbTerms.join(' AND ') : freeTextQuery;

      if (mbQueryStr) {
        try {
          const sResp = await fetchWithExponentialBackoff(
            `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(mbQueryStr)}&limit=6&fmt=json`,
            { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } },
            2,
            logs,
            'MusicBrainz Cover-Suche'
          );
          if (sResp.ok) {
            const sData = (await sResp.json()) as { releases?: any[] };
            for (const rel of sData.releases || []) {
              const rid = String(rel?.id || '').trim();
              if (!UUID_REGEX.test(rid)) continue;
              if (!candidateIds.includes(rid)) candidateIds.push(rid);
              const artistCredits = Array.isArray(rel?.['artist-credit']) ? rel['artist-credit'] : [];
              const relArtist =
                artistCredits.map((ac: any) => `${ac?.name || ac?.artist?.name || ''}${ac?.joinphrase || ''}`).join('').trim() ||
                artist;
              const hitRgId = String(rel?.['release-group']?.id || '').trim();
              const hitObj = {
                id: rid,
                title: String(rel?.title || title || 'Album'),
                artist: relArtist,
                date: String(rel?.date || ''),
                country: String(rel?.country || ''),
                label: String(rel?.['label-info']?.[0]?.label?.name || ''),
                rgId: hitRgId,
                asin: String(rel?.asin || '').trim().toUpperCase(),
              };
              mbSearchHits.push(hitObj);
              if (UUID_REGEX.test(hitRgId) && !rgMetaMap.has(hitRgId)) {
                rgMetaMap.set(hitRgId, {
                  title: hitObj.title,
                  artist: hitObj.artist,
                  date: hitObj.date,
                  country: hitObj.country,
                  label: hitObj.label,
                });
              }
            }
          }
        } catch {
          // Weiter
        }
      }

      // Falls Release-Group-CAA / TheAudioDB aktiv und noch keine RG-ID vorhanden: direkt nach Release-Group suchen
      if ((activeSet.has('musicbrainz_rg_caa') || activeSet.has('theaudiodb')) && rgMetaMap.size === 0) {
        if (UUID_REGEX.test(mbid)) {
          try {
            const rResp = await fetch(
              `https://musicbrainz.org/ws/2/release/${encodeURIComponent(mbid)}?inc=release-groups&fmt=json`,
              { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(5500) }
            );
            if (rResp.ok) {
              const rJson = (await rResp.json()) as any;
              const rRg = String(rJson?.['release-group']?.id || '').trim();
              if (UUID_REGEX.test(rRg)) {
                rgMetaMap.set(rRg, {
                  title: String(rJson?.['release-group']?.title || rJson?.title || title || 'Album'),
                  artist: artist || 'Unbekannt',
                  date: String(rJson?.['release-group']?.['first-release-date'] || rJson?.date || ''),
                });
              }
            }
          } catch {
            // Weiter
          }
        }
        if (rgMetaMap.size === 0 && searchTerm) {
          try {
            const rgTerms: string[] = [];
            if (effArtist) rgTerms.push(`artist:"${effArtist}"`);
            if (effTitle) rgTerms.push(`releasegroup:"${effTitle}"`);
            const rgQuery = rgTerms.length > 0 ? rgTerms.join(' AND ') : searchTerm;
            const rgResp = await fetch(
              `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(rgQuery)}&limit=4&fmt=json`,
              { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(5500) }
            );
            if (rgResp.ok) {
              const rgJson = (await rgResp.json()) as { 'release-groups'?: any[] };
              for (const item of (rgJson['release-groups'] || []).slice(0, 4)) {
                const idVal = String(item?.id || '').trim();
                if (!UUID_REGEX.test(idVal) || rgMetaMap.has(idVal)) continue;
                const acs = Array.isArray(item?.['artist-credit']) ? item['artist-credit'] : [];
                const rgArt = acs.map((ac: any) => `${ac?.name || ac?.artist?.name || ''}${ac?.joinphrase || ''}`).join('').trim();
                rgMetaMap.set(idVal, {
                  title: String(item?.title || title || 'Album'),
                  artist: rgArt || artist || 'Unbekannt',
                  date: String(item?.['first-release-date'] || ''),
                });
              }
            }
          } catch {
            // Weiter
          }
        }
      }

      // 1a. MusicBrainz Release CAA
      if (activeSet.has('musicbrainz_caa')) {
        const uniqueIds = candidateIds.slice(0, 5);
        await Promise.allSettled(
          uniqueIds.map(async (rid) => {
            const hitMeta = mbSearchHits.find((h) => h.id === rid);
            try {
              const caaResp = await fetch(`https://coverartarchive.org/release/${encodeURIComponent(rid)}`, {
                headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
                redirect: 'follow',
                signal: AbortSignal.timeout(6500),
              });
              if (caaResp.ok) {
                const caaJson = (await caaResp.json()) as { images?: any[] };
                const imgs = Array.isArray(caaJson?.images) ? caaJson.images : [];
                const prioritized = [
                  ...imgs.filter((im) => im?.front === true || (Array.isArray(im?.types) && im.types.includes('Front'))),
                  ...imgs.filter((im) => !im?.front && !(Array.isArray(im?.types) && im.types.includes('Front'))),
                ].slice(0, 2);
                for (const im of prioritized) {
                  const fullImg = String(im?.image || '').replace(/^http:\/\//i, 'https://');
                  if (!fullImg) continue;
                  const thumbImg = String(
                    im?.thumbnails?.['500'] || im?.thumbnails?.large || im?.thumbnails?.['250'] || fullImg
                  ).replace(/^http:\/\//i, 'https://');
                  const typeText = Array.isArray(im?.types) && im.types.length > 0 ? im.types.join(', ') : 'Front';
                  const detailParts = [
                    typeText,
                    hitMeta?.country,
                    hitMeta?.label,
                    `MBID ${rid.slice(0, 8)}`,
                  ].filter(Boolean);
                  addRawEntry({
                    provider: 'musicbrainz',
                    providerLabel: 'MusicBrainz CAA',
                    sourceLabel: 'Cover Art Archive (MusicBrainz)',
                    title: hitMeta?.title || title || 'MusicBrainz Release',
                    artist: hitMeta?.artist || artist || 'Unbekannt',
                    date: hitMeta?.date || '',
                    details: detailParts.join(' · '),
                    directFetchUrl: fullImg,
                    imageUrl: `/api/coverart/file?url=${encodeURIComponent(fullImg)}`,
                    thumbnailUrl: `/api/coverart/file?url=${encodeURIComponent(thumbImg)}`,
                    fetchHeaders: { 'User-Agent': MB_USER_AGENT },
                    mbid: rid,
                  });
                }
              }
            } catch {
              // Ignorieren
            }
          })
        );
      }

      // 1b. MusicBrainz Release-Group CAA (eigenständige Quelle)
      if (activeSet.has('musicbrainz_rg_caa') && rgMetaMap.size > 0) {
        const rgEntries = Array.from(rgMetaMap.entries()).slice(0, 4);
        await Promise.allSettled(
          rgEntries.map(async ([targetRgId, meta]) => {
            try {
              const caaResp = await fetch(
                `https://coverartarchive.org/release-group/${encodeURIComponent(targetRgId)}`,
                {
                  headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
                  redirect: 'follow',
                  signal: AbortSignal.timeout(6500),
                }
              );
              if (caaResp.ok) {
                const caaJson = (await caaResp.json()) as { images?: any[] };
                const imgs = Array.isArray(caaJson?.images) ? caaJson.images : [];
                const prioritized = [
                  ...imgs.filter((im) => im?.front === true || (Array.isArray(im?.types) && im.types.includes('Front'))),
                  ...imgs.filter((im) => !im?.front && !(Array.isArray(im?.types) && im.types.includes('Front'))),
                ].slice(0, 2);
                for (const im of prioritized) {
                  const fullImg = String(im?.image || '').replace(/^http:\/\//i, 'https://');
                  if (!fullImg) continue;
                  const thumbImg = String(
                    im?.thumbnails?.['500'] || im?.thumbnails?.large || im?.thumbnails?.['250'] || fullImg
                  ).replace(/^http:\/\//i, 'https://');
                  const typeText = Array.isArray(im?.types) && im.types.length > 0 ? im.types.join(', ') : 'Front';
                  addRawEntry({
                    provider: 'musicbrainz_rg',
                    providerLabel: 'MusicBrainz Release-Group',
                    sourceLabel: 'Cover Art Archive (Release-Group)',
                    title: meta.title || title || 'MusicBrainz Release-Group',
                    artist: meta.artist || artist || 'Unbekannt',
                    date: meta.date || '',
                    details: [typeText, `RG ${targetRgId.slice(0, 8)}`].filter(Boolean).join(' · '),
                    directFetchUrl: fullImg,
                    imageUrl: `/api/coverart/file?url=${encodeURIComponent(fullImg)}`,
                    thumbnailUrl: `/api/coverart/file?url=${encodeURIComponent(thumbImg)}`,
                    fetchHeaders: { 'User-Agent': MB_USER_AGENT },
                    mbid: mbid || undefined,
                  });
                }
                return;
              }
            } catch {
              // Fallback auf /front
            }
            const rgImg = `https://coverartarchive.org/release-group/${targetRgId}/front`;
            const rgThumb = `https://coverartarchive.org/release-group/${targetRgId}/front-500`;
            addRawEntry({
              provider: 'musicbrainz_rg',
              providerLabel: 'MusicBrainz Release-Group',
              sourceLabel: 'Cover Art Archive (Release-Group)',
              title: meta.title || title || 'MusicBrainz Release-Group',
              artist: meta.artist || artist || 'Unbekannt',
              date: meta.date || '',
              details: ['Release-Group Front', `RG ${targetRgId.slice(0, 8)}`].join(' · '),
              directFetchUrl: rgImg,
              imageUrl: `/api/coverart/file?url=${encodeURIComponent(rgImg)}`,
              thumbnailUrl: `/api/coverart/file?url=${encodeURIComponent(rgThumb)}`,
              fetchHeaders: { 'User-Agent': MB_USER_AGENT },
              mbid: mbid || undefined,
            });
          })
        );
      }
    })();

    // 2. Deezer Public API (ohne API-Key, bis 1200×1200 px)
    const deezerPromise = (async () => {
      if (!activeSet.has('deezer') || !searchTerm) return;
      const queriesToTry: string[] = [];
      if (effArtist && effTitle) {
        queriesToTry.push(`artist:"${effArtist}" album:"${effTitle}"`);
      }
      if (!queriesToTry.includes(searchTerm)) {
        queriesToTry.push(searchTerm);
      }
      let items: any[] = [];
      for (const qStr of queriesToTry) {
        try {
          const dzResp = await fetch(
            `https://api.deezer.com/search/album?q=${encodeURIComponent(qStr)}&limit=6`,
            { headers: { 'User-Agent': MB_USER_AGENT }, signal: AbortSignal.timeout(6500) }
          );
          if (!dzResp.ok) continue;
          const dzData = (await dzResp.json()) as { data?: any[] };
          if (Array.isArray(dzData?.data) && dzData.data.length > 0) {
            items = dzData.data;
            break;
          }
        } catch {
          // Weiter
        }
      }
      for (const item of items.slice(0, 5)) {
        const xlUrl = String(item?.cover_xl || item?.cover_big || '').replace(/^http:\/\//i, 'https://').trim();
        if (!xlUrl) continue;
        const hiUrl = xlUrl.replace('1000x1000', '1200x1200');
        const thumbUrl = String(item?.cover_medium || item?.cover_big || xlUrl).replace(/^http:\/\//i, 'https://');
        addRawEntry({
          provider: 'deezer',
          providerLabel: 'Deezer',
          sourceLabel: 'Deezer Cover',
          title: String(item?.title || title || 'Album'),
          artist: String(item?.artist?.name || artist || 'Unbekannt'),
          date: '',
          details: [item?.nb_tracks ? `${item.nb_tracks} Tracks` : '', 'Deezer Katalog'].filter(Boolean).join(' · '),
          directFetchUrl: hiUrl,
          imageUrl: `/api/cover/proxy?url=${encodeURIComponent(hiUrl)}`,
          thumbnailUrl: `/api/cover/proxy?url=${encodeURIComponent(thumbUrl)}`,
          fetchHeaders: { 'User-Agent': MB_USER_AGENT },
        });
      }
    })();

    // 3. Bandcamp Public Search (ohne API-Key, bis 1200 px)
    const bandcampPromise = (async () => {
      if (!activeSet.has('bandcamp') || !searchTerm) return;
      try {
        const bcResp = await fetch(
          `https://bandcamp.com/search?q=${encodeURIComponent(searchTerm)}&item_type=a`,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
              'Accept-Language': 'de,en;q=0.9',
            },
            signal: AbortSignal.timeout(7000),
          }
        );
        if (!bcResp.ok) return;
        const pageHtml = await bcResp.text();
        const blockRegex = /<li\s+class="searchresult[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
        const decodeEntities = (s: string) =>
          s
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;|&apos;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim();
        let match: RegExpExecArray | null;
        let count = 0;
        while ((match = blockRegex.exec(pageHtml)) !== null && count < 4) {
          const block = match[1];
          const imgMatch = block.match(/https?:\/\/f4\.bcbits\.com\/img\/(a\d+)_\d+\.(?:jpg|jpeg|png)/i);
          if (!imgMatch) continue;
          const artId = imgMatch[1];
          const hiUrl = `https://f4.bcbits.com/img/${artId}_10.jpg`;
          const thumbUrl = `https://f4.bcbits.com/img/${artId}_16.jpg`;
          const titleM = block.match(/<div\s+class="heading"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
          const subM = block.match(/<div\s+class="subhead"[^>]*>([\s\S]*?)<\/div>/i);
          const relM = block.match(/<div\s+class="released"[^>]*>([\s\S]*?)<\/div>/i);
          const bcTitle = titleM ? decodeEntities(titleM[1]) : title || 'Album';
          const bcArtist = subM ? decodeEntities(subM[1]).replace(/^by\s+/i, '').trim() : artist || 'Unbekannt';
          const bcDate = relM ? decodeEntities(relM[1]).replace(/^released\s+/i, '').trim() : '';
          count++;
          addRawEntry({
            provider: 'bandcamp',
            providerLabel: 'Bandcamp',
            sourceLabel: 'Bandcamp Cover',
            title: bcTitle || title || 'Album',
            artist: bcArtist || artist || 'Unbekannt',
            date: bcDate,
            details: 'Bandcamp Album-Artwork',
            directFetchUrl: hiUrl,
            imageUrl: `/api/cover/proxy?url=${encodeURIComponent(hiUrl)}`,
            thumbnailUrl: `/api/cover/proxy?url=${encodeURIComponent(thumbUrl)}`,
            fetchHeaders: { 'User-Agent': MB_USER_AGENT },
          });
        }
      } catch {
        // Ignorieren
      }
    })();

    // 4. Discogs Release + Suche abfragen
    const discogsPromise = (async () => {
      if (!activeSet.has('discogs')) return;
      if (discogsId && /^\d+$/.test(discogsId)) {
        try {
          const dResp = await fetch(`https://api.discogs.com/releases/${discogsId}`, {
            headers: discogsHeaders(effectiveToken),
            signal: AbortSignal.timeout(7000),
          });
          if (dResp.ok) {
            const rel = (await dResp.json()) as any;
            const imgs = Array.isArray(rel?.images) ? rel.images : [];
            const sortedImgs = [
              ...imgs.filter((im: any) => im?.type === 'primary'),
              ...imgs.filter((im: any) => im?.type !== 'primary'),
            ].slice(0, 4);
            const relArtist = Array.isArray(rel?.artists)
              ? rel.artists.map((a: any) => cleanDiscogsName(String(a?.name || ''))).filter(Boolean).join('; ')
              : artist;
            for (const im of sortedImgs) {
              const uri = String(im?.uri || im?.resource_url || '').replace(/^http:\/\//i, 'https://');
              if (!uri || uri.includes('spacer.gif')) continue;
              const thumb = String(im?.uri150 || uri).replace(/^http:\/\//i, 'https://');
              addRawEntry({
                provider: 'discogs',
                providerLabel: 'Discogs',
                sourceLabel: 'Discogs Cover',
                title: String(rel?.title || title || 'Discogs Release'),
                artist: relArtist || artist || 'Unbekannt',
                date: String(rel?.released || rel?.year || ''),
                details: [
                  im?.type === 'primary' ? 'Primary' : 'Secondary',
                  rel?.country,
                  `Discogs #${discogsId}`,
                ]
                  .filter(Boolean)
                  .join(' · '),
                directFetchUrl: uri,
                imageUrl: `/api/discogs/cover?url=${encodeURIComponent(uri)}`,
                thumbnailUrl: `/api/discogs/cover?url=${encodeURIComponent(thumb)}`,
                fetchHeaders: { 'User-Agent': DISCOGS_USER_AGENT },
                discogsId,
              });
            }
          }
        } catch {
          // Weiter zur Suche
        }
      }

      const searchUrl = barcode
        ? `https://api.discogs.com/database/search?barcode=${encodeURIComponent(barcode)}&type=release&per_page=8`
        : searchTerm
          ? `https://api.discogs.com/database/search?q=${encodeURIComponent(searchTerm)}&type=release&per_page=8`
          : '';
      if (searchUrl) {
        try {
          const sResp = await fetch(searchUrl, {
            headers: discogsHeaders(effectiveToken),
            signal: AbortSignal.timeout(7000),
          });
          if (sResp.ok) {
            const sData = (await sResp.json()) as { results?: any[] };
            for (const item of (sData.results || []).slice(0, 5)) {
              const coverImg = String(item?.cover_image || '').replace(/^http:\/\//i, 'https://');
              if (!coverImg || coverImg.includes('spacer.gif')) continue;
              const thumbImg = String(item?.thumb || coverImg).replace(/^http:\/\//i, 'https://');
              const rawTitle = String(item?.title || title || 'Discogs Release');
              const sep = rawTitle.indexOf(' - ');
              const dgArtist = sep > 0 ? cleanDiscogsName(rawTitle.slice(0, sep)) : artist || 'Unbekannt';
              const dgTitle = sep > 0 ? rawTitle.slice(sep + 3).trim() : rawTitle;
              const dgId = String(item?.id || '');
              const lbl = Array.isArray(item?.label) && item.label[0] ? String(item.label[0]) : '';
              const fmt = Array.isArray(item?.format) ? item.format.slice(0, 2).join('/') : '';
              addRawEntry({
                provider: 'discogs',
                providerLabel: 'Discogs',
                sourceLabel: 'Discogs Cover',
                title: dgTitle,
                artist: dgArtist,
                date: String(item?.year || ''),
                details: [item?.country, fmt, lbl, dgId ? `#${dgId}` : ''].filter(Boolean).join(' · '),
                directFetchUrl: coverImg,
                imageUrl: `/api/discogs/cover?url=${encodeURIComponent(coverImg)}`,
                thumbnailUrl: `/api/discogs/cover?url=${encodeURIComponent(thumbImg)}`,
                fetchHeaders: { 'User-Agent': DISCOGS_USER_AGENT },
                discogsId: dgId || undefined,
              });
            }
          }
        } catch {
          // Ignorieren
        }
      }
    })();

    // 5. iTunes / Apple Music (DE + Multi-Region US & JP)
    const itunesPromise = (async () => {
      const regions: string[] = [];
      if (activeSet.has('itunes')) regions.push('DE');
      if (activeSet.has('itunes_multi_region')) regions.push('US', 'JP');
      if (regions.length === 0 || !searchTerm) return;

      await Promise.allSettled(
        regions.map(async (countryCode) => {
          try {
            const iResp = await fetch(
              `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=4&country=${countryCode}`,
              { headers: { 'User-Agent': MB_USER_AGENT }, signal: AbortSignal.timeout(6000) }
            );
            if (!iResp.ok) return;
            const iData = (await iResp.json()) as { results?: any[] };
            for (const item of (iData.results || []).slice(0, 4)) {
              const art100 = String(item?.artworkUrl100 || '').trim();
              if (!art100) continue;
              const highRes = art100.replace(/100x100bb\.(jpg|jpeg|png)$/i, '1400x1400bb.$1');
              const thumbRes = art100.replace(/100x100bb\.(jpg|jpeg|png)$/i, '250x250bb.$1');
              const relDate = String(item?.releaseDate || '').slice(0, 10);
              addRawEntry({
                provider: 'itunes',
                providerLabel: `iTunes / Apple (${countryCode})`,
                sourceLabel: `iTunes / Apple Cover (${countryCode})`,
                title: String(item?.collectionName || title || 'Album'),
                artist: String(item?.artistName || artist || 'Unbekannt'),
                date: relDate,
                details: [
                  item?.primaryGenreName,
                  `Store ${countryCode}`,
                  item?.trackCount ? `${item.trackCount} Tracks` : '',
                ]
                  .filter(Boolean)
                  .join(' · '),
                directFetchUrl: highRes,
                imageUrl: `/api/itunes/cover?url=${encodeURIComponent(highRes)}`,
                thumbnailUrl: `/api/itunes/cover?url=${encodeURIComponent(thumbRes)}`,
                fetchHeaders: { 'User-Agent': MB_USER_AGENT },
              });
            }
          } catch {
            // Weiter
          }
        })
      );
    })();

    // Auf MB, Deezer, Bandcamp, Discogs & iTunes warten, danach TheAudioDB (inkl. MB-RG-IDs) & Amazon ASINs auflösen
    await Promise.allSettled([mbPromise, deezerPromise, bandcampPromise, discogsPromise, itunesPromise]);

    // 6. TheAudioDB (Public Keyless Endpoint api/v1/json/2/)
    const theAudioDbPromise = (async () => {
      if (!activeSet.has('theaudiodb')) return;
      const tadbAlbums: any[] = [];
      const seenTadb = new Set<string>();
      const fetchTadb = async (url: string) => {
        try {
          const resp = await fetch(url, {
            headers: { 'User-Agent': MB_USER_AGENT },
            signal: AbortSignal.timeout(6500),
          });
          if (!resp.ok) return;
          const payload = (await resp.json()) as { album?: any[] };
          for (const alb of payload?.album || []) {
            if (!alb || typeof alb !== 'object') continue;
            const id = String(alb.idAlbum || '');
            if (id && seenTadb.has(id)) continue;
            if (id) seenTadb.add(id);
            tadbAlbums.push(alb);
          }
        } catch {
          // Weiter
        }
      };

      const tadbCalls: Promise<void>[] = [];
      for (const targetRgId of Array.from(rgMetaMap.keys()).slice(0, 2)) {
        tadbCalls.push(
          fetchTadb(`https://www.theaudiodb.com/api/v1/json/2/album-mb.php?i=${encodeURIComponent(targetRgId)}`)
        );
      }
      let tArt = effArtist;
      let tTit = effTitle;
      if (!tArt && !tTit && searchTerm) {
        const dm = searchTerm.match(/^(.+?)\s+[-–—]\s+(.+)$/);
        if (dm) {
          tArt = dm[1].trim();
          tTit = dm[2].trim();
        }
      }
      if (tArt && tTit) {
        tadbCalls.push(
          fetchTadb(
            `https://www.theaudiodb.com/api/v1/json/2/searchalbum.php?s=${encodeURIComponent(tArt)}&a=${encodeURIComponent(tTit)}`
          )
        );
      } else if (tArt) {
        tadbCalls.push(
          fetchTadb(`https://www.theaudiodb.com/api/v1/json/2/searchalbum.php?s=${encodeURIComponent(tArt)}`)
        );
      }
      await Promise.allSettled(tadbCalls);

      for (const alb of tadbAlbums.slice(0, 4)) {
        const imgUrl = String(alb?.strAlbumThumbHQ || alb?.strAlbumThumb || '')
          .replace(/^http:\/\//i, 'https://')
          .trim();
        if (!imgUrl) continue;
        const isHq = Boolean(alb?.strAlbumThumbHQ);
        addRawEntry({
          provider: 'theaudiodb',
          providerLabel: 'TheAudioDB',
          sourceLabel: 'TheAudioDB Cover',
          title: String(alb?.strAlbum || title || 'Album'),
          artist: String(alb?.strArtist || artist || 'Unbekannt'),
          date: String(alb?.intYearReleased || ''),
          details: [isHq ? 'HQ Front' : 'Front', alb?.strGenre, alb?.strLabel].filter(Boolean).join(' · '),
          directFetchUrl: imgUrl,
          imageUrl: `/api/cover/proxy?url=${encodeURIComponent(imgUrl)}`,
          thumbnailUrl: `/api/cover/proxy?url=${encodeURIComponent(imgUrl)}`,
          fetchHeaders: { 'User-Agent': MB_USER_AGENT },
        });
      }
    })();

    // 7. Amazon Produktbilder über ASIN(s) einsammeln
    const amazonPromise = (async () => {
      if (!activeSet.has('amazon')) return;
      const candidateAsins: string[] = [];
      if (/^[A-Z0-9]{10}$/.test(asin)) candidateAsins.push(asin);
      for (const h of mbSearchHits) {
        if (h.asin && /^[A-Z0-9]{10}$/.test(h.asin) && !candidateAsins.includes(h.asin)) {
          candidateAsins.push(h.asin);
        }
      }
      if (candidateAsins.length === 0) {
        const resolvedAsin = await resolveAmazonAsinHelper({ asin, mbid, artist, title, barcode });
        if (resolvedAsin) candidateAsins.push(resolvedAsin);
      }

      for (const targetAsin of candidateAsins.slice(0, 4)) {
        const amzUrl = `https://m.media-amazon.com/images/P/${targetAsin}.01._SCLZZZZZZZ_.jpg`;
        addRawEntry({
          provider: 'amazon',
          providerLabel: 'Amazon',
          sourceLabel: `Amazon Cover (ASIN ${targetAsin})`,
          title: title || `ASIN ${targetAsin}`,
          artist: artist || 'Amazon Produktbild',
          date: '',
          details: `ASIN ${targetAsin}`,
          directFetchUrl: amzUrl,
          imageUrl: `/api/amazon/cover?asin=${encodeURIComponent(targetAsin)}`,
          thumbnailUrl: `/api/amazon/cover?asin=${encodeURIComponent(targetAsin)}`,
          fetchHeaders: { 'User-Agent': MB_USER_AGENT },
          asin: targetAsin,
        });
      }
    })();

    await Promise.allSettled([theAudioDbPromise, amazonPromise]);

    // Alle gefundenen Kandidaten parallel prüfen (echtes Bild > 1500 Bytes & Dimensionen, ohne Deduplizierung)
    const verifiedResults: Array<{
      id: string;
      provider: RawCoverProvider;
      providerLabel: string;
      sourceLabel: string;
      title: string;
      artist: string;
      date: string;
      details: string;
      imageUrl: string;
      thumbnailUrl: string;
      width?: number;
      height?: number;
      sizeBytes: number;
      format: string;
      mbid?: string;
      discogsId?: string;
      asin?: string;
    }> = [];

    const checkResults = await Promise.allSettled(
      rawEntries.slice(0, 80).map(async (entry, idx) => {
        const resp = await fetch(entry.directFetchUrl, {
          headers: entry.fetchHeaders || { 'User-Agent': MB_USER_AGENT },
          redirect: 'follow',
          signal: AbortSignal.timeout(5500),
        });
        if (!resp.ok) return null;
        const ctype = (resp.headers.get('content-type') || '').toLowerCase();
        if (ctype && !ctype.startsWith('image/') && !ctype.includes('octet-stream')) {
          return null;
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length <= 1500) return null;
        const dim = inspectImageBufferDimensions(buf, ctype);
        if (dim.width && dim.height && (dim.width < 32 || dim.height < 32)) return null;
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        return {
          id: `${entry.provider}-${idx}-${sha256.slice(0, 8)}`,
          provider: entry.provider,
          providerLabel: entry.providerLabel,
          sourceLabel: entry.sourceLabel,
          title: entry.title,
          artist: entry.artist,
          date: entry.date || '',
          details: entry.details || '',
          imageUrl: entry.imageUrl,
          thumbnailUrl: entry.thumbnailUrl,
          width: dim.width,
          height: dim.height,
          sizeBytes: buf.length,
          format: dim.format,
          mbid: entry.mbid,
          discogsId: entry.discogsId,
          asin: entry.asin,
        };
      })
    );

    for (const r of checkResults) {
      if (r.status === 'fulfilled' && r.value) {
        verifiedResults.push(r.value);
      }
    }

    const candidates = verifiedResults;
    const countsByProvider: Record<string, number> = {};
    for (const c of candidates) {
      countsByProvider[c.providerLabel] = (countsByProvider[c.providerLabel] || 0) + 1;
    }
    const summaryText =
      Object.entries(countsByProvider)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ') || 'Keine Treffer';

    logs.push(
      formatLogLine(
        `[Cover-Suche] Abfrage abgeschlossen (${enabledProviderIds.length} Quellen): ${candidates.length} Cover-Treffer (${summaryText}).`
      )
    );

    res.json({
      candidates,
      logs,
      providersQueried: queriedLabels,
    });
  });

  // 3f. SANE Hardware-Scanner Endpoint (scanimage) für Linux-Systeme
  app.get('/api/scanner/scan', (req, res) => {
    const dpiNum = Number(req.query.dpi || 300);
    const dpi = [150, 300, 600, 1200].includes(dpiNum) ? String(dpiNum) : '300';
    const rawMode = String(req.query.mode || 'Color');
    const mode = ['Color', 'Gray', 'Lineart'].includes(rawMode) ? rawMode : 'Color';
    const area = String(req.query.area || 'cd_booklet');
    const device = String(req.query.device || '').trim();

    const args: string[] = ['--format=png', '--mode', mode, '--resolution', dpi];
    if (device) {
      args.unshift('-d', device);
    }
    if (area === 'cd_booklet') {
      args.push('-x', '125', '-y', '125');
    } else if (area === 'cd_inlay') {
      args.push('-x', '150', '-y', '118');
    }

    execFile(
      'scanimage',
      args,
      { encoding: 'buffer', maxBuffer: 40 * 1024 * 1024, timeout: 60000 },
      (err, stdout, stderr) => {
        if (err || !stdout || stdout.length < 100) {
          const detail = stderr ? stderr.toString('utf-8').trim() : err?.message || 'Kein SANE-Scanner erkannt.';
          res.status(503).json({
            error: `Kein lokaler SANE-Scanner erreichbar (${detail}).`,
          });
          return;
        }
        res.setHeader('Content-Type', 'image/png');
        res.send(stdout);
      }
    );
  });

  // 3g. Schlüssellose Shazam-Track-Erkennung (1. Akustischer Audio-Fingerabdruck -> 2. Shazam a2st/Katalog-Brücke)
  app.post('/api/shazam/track', async (req, res) => {
    const {
      trackNumber = 1,
      title = '',
      artist = '',
      albumArtist = '',
      albumTitle = '',
      durationSeconds = 0,
      sampleSize = 384000,
      devicePath = '',
      pcmSamples,
      pcmBase64,
      pcmWindowsBase64,
    } = req.body || {};

    const rawSampleSize = Number(sampleSize);
    const targetSampleCount = Number.isFinite(rawSampleSize)
      ? Math.max(80000, Math.min(384000, Math.round(rawSampleSize)))
      : 384000;

    const logs: string[] = [];
    const tNumStr = String(trackNumber).padStart(2, '0');
    logs.push(
      formatLogLine(
        `[Shazam] Starte schlüssellose Shazam-Abfrage für Track #${tNumStr} („${title || 'Unbekannt'}“, Samplegröße: ${targetSampleCount} Samples)...`
      )
    );

    const shazamHeaders = {
      'X-Shazam-Platform': 'IPHONE',
      'X-Shazam-AppVersion': '14.1.0',
      Accept: '*/*',
      'Content-Type': 'application/json',
      'Accept-Language': 'de-DE',
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    };

    const parseShazamTrackObject = (trackObj: any, methodKind: 'acoustic_fingerprint' | 'catalog_bridge') => {
      const shazamKey = String(trackObj?.key || '').trim();
      const foundTitle = String(trackObj?.title || '').trim();
      const foundArtist = normalizeMultiArtist(String(trackObj?.subtitle || '').trim());
      const isrc = String(trackObj?.isrc || '').trim();
      const genre = String(trackObj?.genres?.primary || '').trim();
      const coverUrl = String(
        trackObj?.images?.coverarthq ||
          trackObj?.images?.coverart ||
          trackObj?.share?.image ||
          ''
      ).trim();
      const shazamUrl = String(trackObj?.url || trackObj?.share?.href || '').trim();

      let album = '';
      let label = '';
      let year = '';
      for (const sec of trackObj?.sections || []) {
        if (sec?.type === 'SONG' && Array.isArray(sec.metadata)) {
          for (const meta of sec.metadata) {
            const mTitle = String(meta?.title || '')
              .trim()
              .toLowerCase()
              .replace(/:$/, '');
            const mText = String(meta?.text || '').trim();
            if (!mText) continue;
            if (mTitle === 'album') album = mText;
            else if (mTitle === 'label') label = mText;
            else if (mTitle === 'released' || mTitle === 'veröffentlicht') {
              const ym = mText.match(/\b(19\d{2}|20\d{2})\b/);
              year = ym ? ym[1] : mText.slice(0, 4);
            }
          }
        }
      }

      return {
        shazamKey,
        title: foundTitle,
        artist: foundArtist,
        album,
        label,
        year,
        genre,
        isrc,
        coverUrl,
        coverArtUrl: coverUrl,
        shazamUrl,
        method: methodKind,
      };
    };

    const decodeBase64Pcm16 = (b64: string): number[] => {
      try {
        const buf = Buffer.from(b64, 'base64');
        const count = Math.floor(buf.length / 2);
        const samples: number[] = new Array(count);
        for (let i = 0; i < count; i++) {
          samples[i] = buf.readInt16LE(i * 2);
        }
        return samples;
      } catch {
        return [];
      }
    };

    const normalizePcm16Samples = (rawSamples: number[]): number[] => {
      if (!rawSamples.length) return rawSamples;
      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < rawSamples.length; i++) {
        const s = rawSamples[i];
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
        sumSq += s * s;
      }
      if (peak < 64) return rawSamples;
      const rms = Math.sqrt(sumSq / rawSamples.length);
      let gain = 1.0;
      if (rms > 0 && rms < 4800) {
        gain = Math.min(8.0, 4800 / rms);
      } else if (peak < 24000) {
        gain = Math.min(4.0, 24000 / peak);
      }
      const maxGain = 28000 / peak;
      gain = Math.min(gain, maxGain);
      if (gain <= 1.08) return rawSamples;
      const out = new Array<number>(rawSamples.length);
      for (let i = 0; i < rawSamples.length; i++) {
        const v = Math.round(rawSamples[i] * gain);
        out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
      return out;
    };

    const buildShazamSignatureFromPcm = (
      SigGen: any,
      rawSamples: number[],
      maxSamples = targetSampleCount
    ) => {
      const clampedMax = Math.max(80000, Math.min(384000, Math.round(maxSamples)));
      let working = rawSamples;
      if (working.length > clampedMax) {
        const mid = Math.floor(working.length / 2);
        const half = Math.floor(clampedMax / 2);
        working = working.slice(mid - half, mid + half);
      }
      const usableLen = working.length - (working.length % 128);
      if (usableLen < 16000) return null;
      const gen = new SigGen();
      gen.initFields();
      for (let i = 0; i + 128 <= usableLen; i += 128) {
        gen.doFFT(working.slice(i, i + 128));
        gen.doPeakSpreading();
        gen.num_spread_ffts_done++;
        if (gen.num_spread_ffts_done >= 46) {
          gen.doPeakRecognition();
        }
      }
      gen.nextSignature.numberSamples += usableLen;
      return gen.nextSignature;
    };

    const queryShazamTagOnce = async (samples: number[], maxSamples: number): Promise<any | null> => {
      const algMod = (await import('shazam-api/dist/algorithm.js')) as any;
      const SigGen = algMod.SignatureGenerator || algMod.default?.SignatureGenerator;
      if (!SigGen) return null;
      const sig = buildShazamSignatureFromPcm(SigGen, samples, maxSamples);
      if (!sig) return null;

      const uuid1 = crypto.randomUUID().toUpperCase();
      const uuid2 = crypto.randomUUID().toUpperCase();
      const tagUrl = `https://amp.shazam.com/discovery/v5/de-DE/DE/iphone/-/tag/${uuid1}/${uuid2}?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3`;
      const bodyPayload = {
        timezone: 'Europe/Berlin',
        signature: {
          uri: sig.encodeToUri(),
          samplems: Math.round((sig.numberSamples / sig.sampleRateHz) * 1000),
        },
        timestamp: Date.now(),
        context: {},
        geolocation: {},
      };

      const resp = await fetchWithExponentialBackoff(
        tagUrl,
        {
          method: 'POST',
          headers: shazamHeaders,
          body: JSON.stringify(bodyPayload),
        },
        3,
        logs,
        'Shazam Audio-Tag'
      );
      if (!resp.ok) return null;
      const data = (await resp.json()) as any;
      if (Array.isArray(data?.matches) && data.matches.length > 0 && data?.track?.title) {
        const parsed = parseShazamTrackObject(data.track, 'acoustic_fingerprint');
        return {
          ...parsed,
          matchStrength: data.matches.length,
        };
      }
      return null;
    };

    const recognizePcmSamplesViaShazam = async (rawSamples: number[]): Promise<any | null> => {
      if (!Array.isArray(rawSamples) || rawSamples.length < 16000) return null;
      const samples = normalizePcm16Samples(rawSamples);
      const primary = await queryShazamTagOnce(samples, targetSampleCount);
      if (primary) return primary;
      // Falls langes Sample (>14s) keinen Treffer liefert, kompaktes 12s-Zentrum prüfen
      if (samples.length > 14 * 16000 && targetSampleCount > 14 * 16000) {
        return await queryShazamTagOnce(samples, 12 * 16000);
      }
      return null;
    };

    const extractMidpointPcmFromCdTrack = async (
      devRaw: string,
      trkNum: number,
      durSec: number,
      desiredSamples: number
    ): Promise<number[]> => {
      const cleanDev = sanitizeCdDevicePath(devRaw);
      if (!cleanDev || !fs.existsSync(cleanDev) || trkNum < 1 || durSec <= 1) {
        return [];
      }
      let realDev = cleanDev;
      try {
        realDev = fs.realpathSync(cleanDev);
      } catch {
        realDev = cleanDev;
      }
      const sampleSec = Math.max(5, Math.min(24, desiredSamples / 16000));
      const startSec =
        durSec <= sampleSec
          ? 0
          : Math.max(0, Math.min(Math.max(0, durSec - sampleSec - 0.1), durSec * 0.5 - sampleSec * 0.5));
      const endSec = Math.min(Math.max(startSec + 1, durSec - 0.05), startSec + sampleSec);

      const fmtSpanTime = (secVal: number) => {
        const totalFrames = Math.max(0, Math.round(secVal * 75));
        const ff = totalFrames % 75;
        const whole = Math.floor(totalFrames / 75);
        const ss = whole % 60;
        const mmTotal = Math.floor(whole / 60);
        const hh = Math.floor(mmTotal / 60);
        const mm = mmTotal % 60;
        const base = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ff).padStart(2, '0')}`;
        return hh > 0 ? `${hh}:${base}` : base;
      };
      const spanArg = `${trkNum}[${fmtSpanTime(startSec)}]-${trkNum}[${fmtSpanTime(endSec)}]`;

      await setCdDriveSpeed(realDev, 2);
      try {
        const wavBuf = await new Promise<Buffer | null>((resolve) => {
          const args = ['-d', realDev, '-S', '2', '-Z', '-q', spanArg, '-'];
          execFile(
            'cdparanoia',
            args,
            { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 25000 },
            (err, stdout) => {
              if (!err && stdout && stdout.length > 44) {
                resolve(stdout);
                return;
              }
              execFile(
                'cdparanoia',
                ['-d', realDev, '-Z', '-q', spanArg, '-'],
                { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 25000 },
                (fbErr, fbOut) => {
                  resolve(!fbErr && fbOut && fbOut.length > 44 ? fbOut : null);
                }
              );
            }
          );
        });
        if (!wavBuf || wavBuf.toString('ascii', 0, 4) !== 'RIFF') return [];

        // Suche 'data'-Chunk im WAV-Container (44.1 kHz Stereo s16le -> 16 kHz Mono s16le)
        let dataOffset = 44;
        let dataLen = wavBuf.length - 44;
        let pos = 12;
        while (pos + 8 <= wavBuf.length) {
          const chunkId = wavBuf.toString('ascii', pos, pos + 4);
          const chunkSize = wavBuf.readUInt32LE(pos + 4);
          if (chunkId === 'data') {
            dataOffset = pos + 8;
            dataLen = Math.min(chunkSize, wavBuf.length - dataOffset);
            break;
          }
          pos += 8 + chunkSize + (chunkSize % 2);
        }
        const frameCount = Math.floor(dataLen / 4);
        if (frameCount < 44100) return [];

        const mono44k = new Float32Array(frameCount);
        for (let i = 0; i < frameCount; i++) {
          const byteOff = dataOffset + i * 4;
          const l = wavBuf.readInt16LE(byteOff);
          const r = wavBuf.readInt16LE(byteOff + 2);
          mono44k[i] = (l + r) * 0.5;
        }
        const step = 44100 / 16000;
        const outCount = Math.min(desiredSamples, Math.floor((frameCount - 1) / step));
        if (outCount < 16000) return [];
        const resampled = new Array<number>(outCount);
        for (let k = 0; k < outCount; k++) {
          const srcPos = k * step;
          const idx = Math.floor(srcPos);
          const frac = srcPos - idx;
          const val = mono44k[idx] * (1 - frac) + mono44k[idx + 1] * frac;
          resampled[k] = Math.max(-32768, Math.min(32767, Math.round(val)));
        }
        return resampled;
      } finally {
        void setCdDriveSpeed(realDev, 0);
      }
    };

    const consensusIdentityKey = (hit: any): string => {
      if (hit?.shazamKey) return `key:${String(hit.shazamKey).trim()}`;
      const norm = (s: string) =>
        String(s || '')
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/\s*\([^)]*\)/g, '')
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .trim();
      return `txt:${norm(hit?.artist || '')}|${norm(hit?.title || '')}`;
    };

    try {
      // Übergebene PCM-Samples aus Track-Mitte (50 %) einsammeln
      const pcmWindowList: number[][] = [];
      if (Array.isArray(pcmWindowsBase64)) {
        for (const b64 of pcmWindowsBase64.slice(0, 4)) {
          if (typeof b64 === 'string' && b64.length > 0) {
            const decoded = decodeBase64Pcm16(b64);
            if (decoded.length >= 16000) pcmWindowList.push(decoded);
          }
        }
      }
      if (pcmWindowList.length === 0 && typeof pcmBase64 === 'string' && pcmBase64.length > 0) {
        const decoded = decodeBase64Pcm16(pcmBase64);
        if (decoded.length >= 16000) pcmWindowList.push(decoded);
      }
      if (pcmWindowList.length === 0 && Array.isArray(pcmSamples) && pcmSamples.length >= 16000) {
        pcmWindowList.push(pcmSamples);
      }

      // Falls keine Client-PCM-Daten vorliegen (z. B. physische Audio-CD), 50%-Mitten-Sample direkt vom CD-Track lesen
      if (
        pcmWindowList.length === 0 &&
        typeof devicePath === 'string' &&
        devicePath.trim() &&
        Number(durationSeconds) > 1
      ) {
        const cdPcm = await extractMidpointPcmFromCdTrack(
          devicePath,
          Math.max(1, Math.floor(Number(trackNumber) || 1)),
          Number(durationSeconds),
          targetSampleCount
        );
        if (cdPcm.length >= 16000) {
          pcmWindowList.push(cdPcm);
        }
      }

      // Stufe 1: Akustischer Shazam-Fingerabdruck (Sample aus Track-Mitte bei 50%)
      if (pcmWindowList.length > 0) {
        const candidatesByKey = new Map<
          string,
          { hit: any; votes: number; strengthSum: number; bestWindowIdx: number }
        >();
        let confirmedHit: any | null = null;

        for (let wIdx = 0; wIdx < pcmWindowList.length; wIdx++) {
          const samples = pcmWindowList[wIdx];
          const effSamples = Math.min(samples.length, targetSampleCount);
          const secDur = (effSamples / 16000).toFixed(1);
          logs.push(
            formatLogLine(
              `[Shazam] Prüfe akustischen Fingerabdruck aus Track-Mitte (50 %, Fenster ${wIdx + 1}/${pcmWindowList.length}: ${effSamples} Samples / ${secDur}s @ 16 kHz)...`
            )
          );
          const fpHit = await recognizePcmSamplesViaShazam(samples);
          if (!fpHit) continue;

          const cKey = consensusIdentityKey(fpHit);
          const existing = candidatesByKey.get(cKey);
          if (existing) {
            existing.votes += 1;
            existing.strengthSum += Number(fpHit.matchStrength || 1);
            logs.push(
              formatLogLine(
                `[Shazam] Bestätigter Audio-Konsens (${existing.votes} Fenster) für Track #${tNumStr}: ${fpHit.artist} – ${fpHit.title} (Key #${fpHit.shazamKey}, ISRC: ${fpHit.isrc || '—'}).`
              )
            );
            confirmedHit = existing.hit;
            break;
          } else {
            candidatesByKey.set(cKey, {
              hit: fpHit,
              votes: 1,
              strengthSum: Number(fpHit.matchStrength || 1),
              bestWindowIdx: wIdx,
            });
            logs.push(
              formatLogLine(
                `[Shazam] Treffer: ${fpHit.artist} – ${fpHit.title} (Key #${fpHit.shazamKey}, ISRC: ${fpHit.isrc || '—'}).`
              )
            );
          }
        }

        if (!confirmedHit && candidatesByKey.size > 0) {
          const ranked = Array.from(candidatesByKey.values()).sort((a, b) => {
            if (b.votes !== a.votes) return b.votes - a.votes;
            if (b.strengthSum !== a.strengthSum) return b.strengthSum - a.strengthSum;
            return a.bestWindowIdx - b.bestWindowIdx;
          });
          confirmedHit = ranked[0].hit;
        }

        if (confirmedHit) {
          const { matchStrength: _ms, ...cleanHit } = confirmedHit;
          res.json({ matched: true, match: cleanHit, track: cleanHit, logs });
          return;
        }
        logs.push(
          formatLogLine(
            `[Shazam] Kein direkter Audio-Fingerprint-Treffer nach ${pcmWindowList.length} Fenster(n) für Track #${tNumStr} – prüfe schlüssellose Shazam-Katalog-Brücke...`
          )
        );
      }

      // Stufe 2: Schlüssellose Shazam-Katalog-Brücke (iTunes-Index -> Shazam a2st Bridge -> amp.shazam.com/discovery/v5/track/<Key>)
      const genericTitleRe = /^(?:track|titel|audio|spur|song|unbekannt)\s*\d*$/i;
      const cleanTitle = genericTitleRe.test(String(title).trim()) ? '' : String(title).trim();
      const rawBestArtist =
        !artist || artist.trim() === 'Unbekannter Künstler' ? String(albumArtist || '').trim() : String(artist).trim();
      const cleanArtist =
        !rawBestArtist || rawBestArtist === 'Unbekannter Künstler' ? '' : rawBestArtist.split(/\s*;\s*/)[0].trim();
      const cleanAlbum =
        !albumTitle ||
        [
          'Unbekanntes Album',
          'Audio-CD (Lokal ausgelesen)',
          'Lokaler Datei-Import (Virtuelle TOC)',
          'Importiertes Album',
        ].includes(albumTitle.trim())
          ? ''
          : String(albumTitle).trim();

      const searchTerms: string[] = [];
      if (cleanArtist && cleanTitle) searchTerms.push(`${cleanArtist} ${cleanTitle}`);
      if (cleanArtist && cleanAlbum) searchTerms.push(`${cleanArtist} ${cleanAlbum}`);
      else if (cleanTitle) searchTerms.push(cleanTitle);
      else if (cleanAlbum) searchTerms.push(cleanAlbum);

      let candidates: any[] = [];
      for (const term of searchTerms.slice(0, 2)) {
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=25&country=DE`;
        const iResp = await fetchWithExponentialBackoff(
          itunesUrl,
          { headers: { 'User-Agent': shazamHeaders['User-Agent'], Accept: 'application/json' } },
          2,
          logs,
          'Shazam Katalog-Index'
        );
        if (iResp.ok) {
          const iData = (await iResp.json()) as { results?: any[] };
          if (Array.isArray(iData.results) && iData.results.length > 0) {
            candidates = iData.results;
            break;
          }
        }
      }

      if (candidates.length > 0) {
        const fold = (s: string) =>
          s
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s*\((?:feat|ft|featuring)\b[^)]*\)/gi, '')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const qTitleFold = fold(cleanTitle);
        const qArtistFold = fold(cleanArtist);
        const qAlbumFold = fold(cleanAlbum);
        const junkRe = /\b(?:karaoke|tribute|ringtone|lullaby|8-bit|made famous by|originally performed)\b/i;

        const scoreCandidate = (item: any) => {
          let s = 0;
          const rawItemTitle = String(item.trackName || '');
          const iTitle = fold(rawItemTitle);
          const iArtist = fold(String(item.artistName || ''));
          const iAlbum = fold(String(item.collectionName || ''));
          const iTnum = Number(item.trackNumber || 0);
          const iDurSec = Math.round(Number(item.trackTimeMillis || 0) / 1000);

          if (qTitleFold) {
            if (iTitle === qTitleFold) s += 55;
            else if (iTitle.includes(qTitleFold) || qTitleFold.includes(iTitle)) s += 38;
          }
          if (qArtistFold) {
            if (iArtist === qArtistFold) s += 40;
            else if (iArtist.includes(qArtistFold) || qArtistFold.includes(iArtist)) s += 26;
          }
          if (qAlbumFold && (iAlbum.includes(qAlbumFold) || qAlbumFold.includes(iAlbum))) s += 25;
          if (Number(trackNumber) > 0 && iTnum === Number(trackNumber)) s += 20;
          if (Number(durationSeconds) > 0 && iDurSec > 0) {
            const diff = Math.abs(iDurSec - Number(durationSeconds));
            if (diff <= 2) s += 40;
            else if (diff <= 5) s += 24;
            else if (diff <= 10) s += 8;
            else s -= diff * 2;
          }
          if (junkRe.test(rawItemTitle) && !junkRe.test(cleanTitle)) s -= 80;
          return s;
        };

        const ranked = candidates
          .map((item) => ({ item, score: scoreCandidate(item) }))
          .sort((a, b) => b.score - a.score);

        const minCatalogScore = pcmWindowList.length > 0 ? 45 : 22;
        for (const { item: cand, score } of ranked.slice(0, 5)) {
          if (pcmWindowList.length > 0 && !cleanTitle && !cleanAlbum) continue;
          if ((qTitleFold || qArtistFold) && score < minCatalogScore) continue;
          const appleId = cand.trackId;
          if (!appleId) continue;

          // 2a. Übersetze Apple-Track-ID über Shazams a2st-Brücke in den offiziellen Shazam-Track-Key
          const a2stResp = await fetch(
            `https://www.shazam.com/services/sd/s/a2st/US/en-US/${encodeURIComponent(String(appleId))}`,
            {
              headers: {
                'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13; Pixel 7 Build/TQ3A.230805.001)',
                Accept: '*/*',
              },
              signal: AbortSignal.timeout(7000),
            }
          ).catch(() => null);

          let shazamKey = '';
          if (a2stResp && a2stResp.ok) {
            try {
              const mapJson = (await a2stResp.json()) as Record<string, string>;
              if (mapJson && !('error' in mapJson)) {
                shazamKey = String(mapJson[String(appleId)] || Object.values(mapJson)[0] || '').trim();
              }
            } catch {
              // Ignorieren
            }
          }

          if (shazamKey) {
            const trackUrl = `https://amp.shazam.com/discovery/v5/de-DE/DE/iphone/-/track/${encodeURIComponent(
              shazamKey
            )}?shazamapiversion=v3&video=v3`;
            const tResp = await fetchWithExponentialBackoff(
              trackUrl,
              { headers: shazamHeaders },
              3,
              logs,
              'Shazam Track-Details'
            );
            if (tResp.ok) {
              const tData = await tResp.json();
              if (tData?.title) {
                const parsedTrack = parseShazamTrackObject(tData, 'catalog_bridge');
                logs.push(
                  formatLogLine(
                    `[Shazam] Katalog-Treffer für Track #${tNumStr}: ${parsedTrack.artist} – ${parsedTrack.title} (Shazam-Key #${shazamKey}, ISRC: ${
                      parsedTrack.isrc || '—'
                    }).`
                  )
                );
                res.json({ matched: true, match: parsedTrack, track: parsedTrack, logs });
                return;
              }
            }
          }
        }
      }

      logs.push(
        formatLogLine(`[Shazam] Kein Shazam-Treffer für Track #${tNumStr} („${title || 'Unbekannt'}“) gefunden.`)
      );
      res.status(404).json({
        matched: false,
        error: `Kein Shazam-Treffer für Track #${tNumStr} gefunden.`,
        logs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Verbindungsfehler zu Shazam';
      logs.push(formatLogLine(`[Shazam] Fehler bei Track #${tNumStr}: ${msg}`));
      res.status(502).json({ matched: false, error: msg, logs });
    }
  });

  // 3h. Interpretennamen online prüfen, Schreibfehler korrigieren & strikt internationalisieren (MusicBrainz + Wikidata)
  const NON_LATIN_LETTER_RE =
    /[\u0370-\u03FF\u0400-\u052F\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0900-\u097F\u0E00-\u0E7F\u10A0-\u10FF\u1100-\u11FF\u3040-\u309F\u30A0-\u30FF\u3130-\u318F\u4E00-\u9FFF\uAC00-\uD7AF]/;

  function isLatinArtistName(value: string): boolean {
    return !NON_LATIN_LETTER_RE.test(String(value || ''));
  }

  function foldArtistForCompare(value: string): string {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\u0370-\u03ff\u0400-\u052f\u0590-\u06ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function artistLevenshteinSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const m = a.length;
    const n = b.length;
    const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const temp = dp[j];
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
        prev = temp;
      }
    }
    return Math.max(0, 1 - dp[n] / Math.max(m, n));
  }

  function uninvertArtistSortName(name: string): string {
    const clean = String(name || '').trim();
    if (!clean.includes(', ')) return clean;
    const parts = clean.split(', ').map((p) => p.trim()).filter(Boolean);
    if (parts.length !== 2) return clean;
    if (/[&/]/.test(clean) || /\b(?:and|und|feat|ft|vs)\b/i.test(clean)) return clean;
    return `${parts[1]} ${parts[0]}`.trim();
  }

  function escapeMbLucene(term: string): string {
    return term.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');
  }

  function transliterateNonLatinArtist(value: string): string {
    const cyrMap: Record<string, string> = {
      А: 'A', а: 'a', Б: 'B', б: 'b', В: 'V', в: 'v', Г: 'G', г: 'g',
      Д: 'D', д: 'd', Е: 'E', е: 'e', Ё: 'Yo', ё: 'yo', Ж: 'Zh', ж: 'zh',
      З: 'Z', з: 'z', И: 'I', и: 'i', Й: 'Y', й: 'y', К: 'K', к: 'k',
      Л: 'L', л: 'l', М: 'M', м: 'm', Н: 'N', н: 'n', О: 'O', о: 'o',
      П: 'P', п: 'p', Р: 'R', р: 'r', С: 'S', с: 's', Т: 'T', т: 't',
      У: 'U', у: 'u', Ф: 'F', ф: 'f', Х: 'Kh', х: 'kh', Ц: 'Ts', ц: 'ts',
      Ч: 'Ch', ч: 'ch', Ш: 'Sh', ш: 'sh', Щ: 'Shch', щ: 'shch', Ъ: '', ъ: '',
      Ы: 'Y', ы: 'y', Ь: '', ь: '', Э: 'E', э: 'e', Ю: 'Yu', ю: 'yu',
      Я: 'Ya', я: 'ya', І: 'I', і: 'i', Ї: 'Yi', ї: 'yi', Є: 'Ye', є: 'ye',
      Ґ: 'G', ґ: 'g',
      Α: 'A', α: 'a', Β: 'V', β: 'v', Γ: 'G', γ: 'g', Δ: 'D', δ: 'd',
      Ε: 'E', ε: 'e', Ζ: 'Z', ζ: 'z', Η: 'I', η: 'i', Θ: 'Th', θ: 'th',
      Ι: 'I', ι: 'i', Κ: 'K', κ: 'k', Λ: 'L', λ: 'l', Μ: 'M', μ: 'm',
      Ν: 'N', ν: 'n', Ξ: 'X', ξ: 'x', Ο: 'O', ο: 'o', Π: 'P', π: 'p',
      Ρ: 'R', ρ: 'r', Σ: 'S', σ: 's', ς: 's', Τ: 'T', τ: 't', Υ: 'Y', υ: 'y',
      Φ: 'F', φ: 'f', Χ: 'Ch', χ: 'ch', Ψ: 'Ps', ψ: 'ps', Ω: 'O', ω: 'o',
    };
    const normalized = String(value || '').normalize('NFKC');
    let out = '';
    for (const ch of normalized) {
      if (ch in cyrMap) {
        out += cyrMap[ch];
      } else {
        out += ch;
      }
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  async function fetchWikidataEnglishArtistLabel(mbArtistId?: string, searchName?: string): Promise<string> {
    try {
      if (mbArtistId && UUID_REGEX.test(mbArtistId.trim())) {
        const sparql = `SELECT ?label WHERE { ?item wdt:P434 "${mbArtistId.trim()}" ; rdfs:label ?label . FILTER(LANG(?label) = "en") } LIMIT 1`;
        const resp = await fetch(
          `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
          {
            headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(5000),
          }
        );
        if (resp.ok) {
          const data = (await resp.json()) as { results?: { bindings?: Array<{ label?: { value?: string } }> } };
          const val = String(data.results?.bindings?.[0]?.label?.value || '').trim();
          if (val && isLatinArtistName(val)) return val;
        }
      }
      if (searchName?.trim()) {
        const sUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
          searchName.trim()
        )}&language=en&format=json&limit=3`;
        const sResp = await fetch(sUrl, {
          headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (sResp.ok) {
          const sData = (await sResp.json()) as { search?: Array<{ label?: string; description?: string }> };
          const musicItem = (sData.search || []).find((item) =>
            /(musician|singer|band|composer|conductor|orchestra|rapper|dj|group|artist|performer|pianist|violinist)/i.test(
              String(item.description || '')
            )
          );
          const lbl = String((musicItem || sData.search?.[0])?.label || '').trim();
          if (lbl && isLatinArtistName(lbl)) return lbl;
        }
      }
    } catch {
      // Wikidata fallback optional
    }
    return '';
  }

  function scoreMbArtistCandidate(cand: any, rawInput: string, altInput: string): number {
    const foldA = foldArtistForCompare(rawInput);
    const foldB = foldArtistForCompare(altInput);
    const forms: string[] = [];
    if (cand?.name) forms.push(String(cand.name));
    if (cand?.['sort-name']) {
      forms.push(String(cand['sort-name']));
      forms.push(uninvertArtistSortName(String(cand['sort-name'])));
    }
    for (const al of cand?.aliases || []) {
      if (al?.name) forms.push(String(al.name));
      if (al?.['sort-name']) forms.push(uninvertArtistSortName(String(al['sort-name'])));
    }

    let bestSim = 0;
    for (const f of forms) {
      const ff = foldArtistForCompare(f);
      if (!ff) continue;
      bestSim = Math.max(bestSim, artistLevenshteinSimilarity(foldA, ff));
      if (foldB && foldB !== foldA) {
        bestSim = Math.max(bestSim, artistLevenshteinSimilarity(foldB, ff));
      }
    }
    return bestSim;
  }

  type VerifyEntityRole = 'artist' | 'composer' | 'orchestra' | 'conductor';
  const ARTIST_VERIFY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const artistVerifyCache = new Map<string, { resolved: string; source: 'mb' | 'wikidata' | 'local'; expiresAt: number }>();

  function getCachedArtistVerify(role: VerifyEntityRole, keyLower: string): { resolved: string; source: 'mb' | 'wikidata' | 'local' } | null {
    const key = `${role}::${keyLower}`;
    const hit = artistVerifyCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      artistVerifyCache.delete(key);
      return null;
    }
    return { resolved: hit.resolved, source: hit.source };
  }

  function setCachedArtistVerify(role: VerifyEntityRole, keyLower: string, resolved: string, source: 'mb' | 'wikidata' | 'local'): void {
    if (artistVerifyCache.size >= 3000) {
      const firstKey = artistVerifyCache.keys().next().value;
      if (firstKey !== undefined) artistVerifyCache.delete(firstKey);
    }
    artistVerifyCache.set(`${role}::${keyLower}`, {
      resolved,
      source,
      expiresAt: Date.now() + ARTIST_VERIFY_CACHE_TTL_MS,
    });
  }

  function preseedVerifyCacheFromMbRelease(rel: any): void {
    if (!rel || typeof rel !== 'object') return;
    const seedCredit = (ac: any) => {
      for (const chunk of Array.isArray(ac) ? ac : []) {
        const canonical = String(chunk?.artist?.name || '').trim();
        if (canonical && isLatinArtistName(canonical)) {
          setCachedArtistVerify('artist', canonical.toLowerCase(), canonical, 'mb');
        }
      }
    };
    const seedRelations = (rels: any) => {
      for (const item of Array.isArray(rels) ? rels : []) {
        const canonical = String(item?.artist?.name || '').trim();
        if (!canonical || !isLatinArtistName(canonical)) continue;
        const rType = String(item?.type || '').toLowerCase();
        if (rType === 'composer') {
          setCachedArtistVerify('composer', canonical.toLowerCase(), canonical, 'mb');
        } else if (rType === 'conductor') {
          setCachedArtistVerify('conductor', canonical.toLowerCase(), canonical, 'mb');
        } else if (rType === 'orchestra' || rType === 'performing orchestra') {
          setCachedArtistVerify('orchestra', canonical.toLowerCase(), canonical, 'mb');
        }
      }
    };
    seedCredit(rel['artist-credit']);
    seedRelations(rel.relations);
    for (const med of Array.isArray(rel.media) ? rel.media : []) {
      for (const trk of Array.isArray(med?.tracks) ? med.tracks : []) {
        seedCredit(trk?.['artist-credit']);
        const rec = trk?.recording;
        if (rec) {
          seedCredit(rec['artist-credit']);
          seedRelations(rec.relations);
          for (const rItem of Array.isArray(rec.relations) ? rec.relations : []) {
            if (rItem?.['target-type'] === 'work' && rItem.work?.relations) {
              seedRelations(rItem.work.relations);
            }
          }
        }
      }
    }
  }

  function describeArtistChangeReason(
    rawInput: string,
    resolved: string,
    source: 'mb' | 'wikidata' | 'local'
  ): string {
    if (!resolved || resolved === rawInput) return '';
    const isInputLatin = isLatinArtistName(rawInput);
    const uninverted = uninvertArtistSortName(rawInput);
    const hasCommaInvert = uninverted !== rawInput;
    if (!isInputLatin) {
      if (source === 'wikidata') return 'Internationaler Name über Wikidata ergänzt';
      if (source === 'local') return 'In lateinische Umschrift internationalisiert';
      return 'Nicht-lateinische Schrift internationalisiert';
    }
    if (hasCommaInvert && resolved.toLowerCase() === uninverted.toLowerCase()) {
      return 'Namensreihenfolge normalisiert';
    }
    if (foldArtistForCompare(resolved) === foldArtistForCompare(rawInput)) {
      return 'Schreibweise / Diakritika korrigiert';
    }
    return 'Rechtschreibung / Internationaler Name über MusicBrainz korrigiert';
  }

  function pickLatinAliasFromList(rawAliases: any[]): string {
    const aliases: any[] = (Array.isArray(rawAliases) ? rawAliases : []).filter(
      (a: any) => a && !a.ended && a.name && isLatinArtistName(String(a.name))
    );
    const enPrimary = aliases.find(
      (a) => /^en(?:[_-]|$)/i.test(String(a.locale || '')) && Boolean(a.primary)
    );
    if (enPrimary?.name) return String(enPrimary.name).trim();
    const enArtistName = aliases.find(
      (a) => /^en(?:[_-]|$)/i.test(String(a.locale || '')) && a.type === 'Artist name'
    );
    if (enArtistName?.name) return String(enArtistName.name).trim();
    const enAny = aliases.find((a) => /^en(?:[_-]|$)/i.test(String(a.locale || '')));
    if (enAny?.name) return String(enAny.name).trim();
    const latinArtistPrimary = aliases.find((a) => a.type === 'Artist name' && Boolean(a.primary));
    if (latinArtistPrimary?.name) return String(latinArtistPrimary.name).trim();
    const latinArtistAny = aliases.find((a) => a.type === 'Artist name');
    if (latinArtistAny?.name) return String(latinArtistAny.name).trim();
    if (aliases[0]?.name) return String(aliases[0].name).trim();
    return '';
  }

  async function pickInternationalNameFromMbArtist(
    cand: any,
    logs?: string[],
    skipExtraMbFetch = false,
    signal?: AbortSignal,
    onLogLine?: (line: string) => void
  ): Promise<string> {
    let artistObj = cand;
    const aid = String(cand?.id || '').trim();
    const rawName = String(cand?.name || '').trim();

    if (rawName && isLatinArtistName(rawName)) {
      return rawName;
    }

    const fromSearchAliases = pickLatinAliasFromList(artistObj?.aliases);
    if (fromSearchAliases) return fromSearchAliases;

    // Wikidata ohne MusicBrainz-Rate-Limit zuerst abfragen, bevor ein weiterer MB-Request erfolgt
    const wdLabel = await fetchWikidataEnglishArtistLabel(aid, rawName);
    if (wdLabel) return wdLabel;

    if (!skipExtraMbFetch && !signal?.aborted && aid && UUID_REGEX.test(aid) && !Array.isArray(artistObj?.aliases)) {
      try {
        const dResp = await fetchWithExponentialBackoff(
          `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(aid)}?inc=aliases&fmt=json`,
          { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' }, signal },
          2,
          logs,
          'MusicBrainz Artist-Aliase',
          onLogLine
        );
        if (dResp.ok) {
          artistObj = await dResp.json();
          const fromDetailAliases = pickLatinAliasFromList(artistObj?.aliases);
          if (fromDetailAliases) return fromDetailAliases;
        }
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
        // Fallback auf vorhandene Felder
      }
    }

    const sortName = String(artistObj?.['sort-name'] || '').trim();
    if (sortName && isLatinArtistName(sortName)) {
      return uninvertArtistSortName(sortName);
    }

    return transliterateNonLatinArtist(rawName || sortName);
  }

  function getRoleBonus(cand: any, role: VerifyEntityRole): number {
    const type = String(cand?.type || '').toLowerCase();
    const disambig = String(cand?.disambiguation || '').toLowerCase();
    if (role === 'orchestra') {
      let bonus = 0;
      if (type === 'orchestra') bonus += 0.045;
      else if (type === 'group' || type === 'choir') bonus += 0.015;
      if (/(orchestra|philharmonic|philharmoniker|symphony|sinfonie|ensemble|choir|kammerorchester)/i.test(disambig)) {
        bonus += 0.02;
      }
      return bonus;
    }
    if (role === 'composer') {
      let bonus = 0;
      if (type === 'person') bonus += 0.02;
      if (/(composer|komponist)/i.test(disambig)) bonus += 0.025;
      return bonus;
    }
    if (role === 'conductor') {
      let bonus = 0;
      if (type === 'person') bonus += 0.02;
      if (/(conductor|dirigent|kapellmeister)/i.test(disambig)) bonus += 0.025;
      return bonus;
    }
    return 0;
  }

  async function resolveSingleArtistToken(
    rawToken: string,
    logs: string[],
    role: VerifyEntityRole = 'artist',
    mbPausedInBatch = false,
    signal?: AbortSignal,
    onLogLine?: (line: string) => void
  ): Promise<{ resolved: string; reason: string; rateLimited: boolean }> {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const clean = String(rawToken || '').replace(/\s+/g, ' ').trim();
    if (!clean) return { resolved: clean, reason: '', rateLimited: false };
    if (
      /^(?:unbekannter künstler|unknown artist|unbekannter komponist|unknown composer|unbekanntes orchester|unknown orchestra|unbekannter dirigent|unknown conductor|\?|-)$/i.test(
        clean
      )
    ) {
      return { resolved: clean, reason: '', rateLimited: false };
    }
    if (role === 'artist' && /^(?:verschiedene(?:\s+interpreten)?|v\.?a\.?|various(?:\s+artists)?)$/i.test(clean)) {
      const target = 'Various Artists';
      return {
        resolved: target,
        reason: target !== clean ? 'Internationalisiert auf „Various Artists“' : '',
        rateLimited: false,
      };
    }

    const cacheKeyLower = clean.toLowerCase();
    const cached = getCachedArtistVerify(role, cacheKeyLower);
    if (cached) {
      return {
        resolved: cached.resolved,
        reason: describeArtistChangeReason(clean, cached.resolved, cached.source),
        rateLimited: false,
      };
    }

    const uninverted = uninvertArtistSortName(clean);
    const hasCommaInvert = uninverted !== clean;
    const isInputLatin = isLatinArtistName(clean);
    const foldIn = foldArtistForCompare(clean);

    // Kombinierte Einzelabfrage (Exakt mit ^6/^5-Boost + Fuzzy-Fallback in EINEM HTTP-Call -> halbiert MB-Requests!)
    const escClean = escapeMbLucene(clean);
    const exactClause = hasCommaInvert
      ? `artist:"${escapeMbLucene(uninverted)}"^6 OR artist:"${escClean}"^6 OR alias:"${escClean}"^5`
      : `artist:"${escClean}"^6 OR alias:"${escClean}"^5`;
    const words = foldIn.split(' ').filter((w) => w.length >= 3);
    const fuzzyTarget = words.length > 0 ? words : foldIn.length >= 3 ? [clean] : [];
    const fuzzyPart =
      fuzzyTarget.length > 0
        ? ` OR artist:(${fuzzyTarget.map((w) => `${escapeMbLucene(w)}~0.65`).join(' AND ')}) OR alias:(${fuzzyTarget
            .map((w) => `${escapeMbLucene(w)}~0.65`)
            .join(' AND ')})`
        : '';
    const combinedQuery = `(${exactClause})${fuzzyPart}`;

    let bestCand: any = null;
    let bestCombined = 0;
    let hitRateLimit = false;

    if (!mbPausedInBatch) {
      try {
        const resp = await fetchWithExponentialBackoff(
          `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(combinedQuery)}&limit=10&fmt=json`,
          { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' }, signal },
          3,
          logs,
          'MusicBrainz Artist-Prüfung',
          onLogLine
        );
        if (resp.status === 503 || resp.status === 429) {
          hitRateLimit = true;
        } else if (resp.ok) {
          const data = (await resp.json()) as { artists?: any[] };
          for (const cand of data.artists || []) {
            const mbScore = Number(cand?.score || 0);
            const sim = scoreMbArtistCandidate(cand, clean, uninverted);
            const isShort = foldIn.length <= 3;
            const acceptable = isShort
              ? sim >= 0.99 && mbScore >= 80
              : sim >= 0.96 || (sim >= 0.72 && mbScore >= 60) || sim >= 0.80;
            if (!acceptable) continue;

            const combined = sim * 0.78 + (mbScore / 100) * 0.22 + getRoleBonus(cand, role);
            if (combined > bestCombined) {
              bestCombined = combined;
              bestCand = cand;
            }
          }
        }
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          throw err;
        }
        // Weiter zu Wikidata / lokalem Fallback
      }
    }

    if (bestCand) {
      const intlName = await pickInternationalNameFromMbArtist(bestCand, logs, hitRateLimit, signal, onLogLine);
      if (intlName) {
        setCachedArtistVerify(role, cacheKeyLower, intlName, 'mb');
        return {
          resolved: intlName,
          reason: describeArtistChangeReason(clean, intlName, 'mb'),
          rateLimited: false,
        };
      }
    }

    if (!isInputLatin) {
      const wdName = await fetchWikidataEnglishArtistLabel(undefined, clean);
      if (wdName) {
        if (!hitRateLimit && !mbPausedInBatch) {
          setCachedArtistVerify(role, cacheKeyLower, wdName, 'wikidata');
        }
        return {
          resolved: wdName,
          reason: describeArtistChangeReason(clean, wdName, 'wikidata'),
          rateLimited: hitRateLimit,
        };
      }
      const translit = transliterateNonLatinArtist(clean);
      if (translit && translit !== clean) {
        return {
          resolved: translit,
          reason: describeArtistChangeReason(clean, translit, 'local'),
          rateLimited: hitRateLimit,
        };
      }
    }

    if (hasCommaInvert && isLatinArtistName(uninverted)) {
      return {
        resolved: uninverted,
        reason: 'Namensreihenfolge (Vorname Nachname) korrigiert',
        rateLimited: hitRateLimit,
      };
    }

    if (!hitRateLimit && !mbPausedInBatch) {
      setCachedArtistVerify(role, cacheKeyLower, clean, 'mb');
    }
    return { resolved: clean, reason: '', rateLimited: hitRateLimit };
  }

  app.post('/api/artists/verify-international', async (req, res) => {
    const {
      field = 'artist',
      artist = '',
      albumArtist = '',
      composer = '',
      orchestra = '',
      conductor = '',
      tracks = [],
      includeAlbumFields = true,
    } = req.body || {};

    const wantsStream = req.headers['x-verify-stream'] === 'ndjson';
    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    if (wantsStream) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders?.();
    }

    const sendEvent = (obj: Record<string, any>) => {
      if (wantsStream && !abortController.signal.aborted && !res.writableEnded) {
        res.write(JSON.stringify(obj) + '\n');
      }
    };

    const role: VerifyEntityRole =
      field === 'composer' || field === 'orchestra' || field === 'conductor' ? field : 'artist';

    const roleLabels: Record<
      VerifyEntityRole,
      { logTag: string; albumScope: string; pluralNoun: string }
    > = {
      artist: {
        logTag: '[Interpreten-Prüfung]',
        albumScope: 'Künstler',
        pluralNoun: 'Interpretennamen',
      },
      composer: {
        logTag: '[Komponist-Prüfung]',
        albumScope: 'Komponist (Album)',
        pluralNoun: 'Komponisten',
      },
      orchestra: {
        logTag: '[Orchester-Prüfung]',
        albumScope: 'Orchester (Album)',
        pluralNoun: 'Orchesternamen',
      },
      conductor: {
        logTag: '[Dirigent-Prüfung]',
        albumScope: 'Dirigent (Album)',
        pluralNoun: 'Dirigenten',
      },
    };
    const meta = roleLabels[role];

    const logs: string[] = [];
    const tokenCache = new Map<string, { resolved: string; source: 'mb' | 'wikidata' | 'local' }>();
    let consecutiveMbRateLimits = 0;
    let mbPausedInBatch = false;

    const emitLogLine = (line: string) => {
      sendEvent({ type: 'log', line });
    };
    const appendAndEmit = (msg: string) => {
      const line = formatLogLine(msg);
      logs.push(line);
      emitLogLine(line);
    };

    appendAndEmit(
      `${meta.logTag} Starte Online-Verifizierung & Internationalisierung (${meta.pluralNoun}, ;-getrennte Mehrfachwerte) über MusicBrainz + Wikidata...`
    );

    const resolveFieldString = async (rawValue: string): Promise<{ value: string; reasons: string[] }> => {
      const normalized = normalizeMultiArtist(String(rawValue || '').trim());
      if (!normalized) return { value: '', reasons: [] };

      const tokens = normalized.split(/\s*;\s*/).map((t) => t.trim()).filter(Boolean);
      const outTokens: string[] = [];
      const reasons: string[] = [];

      for (const tok of tokens) {
        if (abortController.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const tokKey = tok.toLowerCase();
        let entry = tokenCache.get(tokKey);
        if (!entry) {
          const resTok = await resolveSingleArtistToken(
            tok,
            logs,
            role,
            mbPausedInBatch,
            abortController.signal,
            emitLogLine
          );
          if (resTok.rateLimited) {
            consecutiveMbRateLimits += 1;
            if (consecutiveMbRateLimits >= 2 && !mbPausedInBatch) {
              mbPausedInBatch = true;
              appendAndEmit(
                `${meta.logTag} MusicBrainz Rate-Limit aktiv – schalte für restliche Einträge auf Wikidata- & lokale Normalisierung um, um weitere 503-Sperren zu vermeiden.`
              );
            }
          } else {
            consecutiveMbRateLimits = 0;
          }
          entry = {
            resolved: resTok.resolved,
            source: resTok.rateLimited ? 'local' : 'mb',
          };
          tokenCache.set(tokKey, entry);
        }
        if (entry.resolved && !outTokens.some((existing) => existing.toLowerCase() === entry!.resolved.toLowerCase())) {
          outTokens.push(entry.resolved);
        }
        const tokReason = describeArtistChangeReason(tok, entry.resolved, entry.source);
        if (tokReason && !reasons.includes(tokReason)) {
          reasons.push(tokReason);
        }
      }

      const finalStr = outTokens.join('; ');
      return { value: finalStr, reasons };
    };

    try {
      const changes: Array<{ scope: string; before: string; after: string; reason: string }> = [];
      const trackList = Array.isArray(tracks) ? tracks : [];

      if (role === 'artist') {
        const verifyAlbumFields = includeAlbumFields !== false;
        const albumArtistRes = verifyAlbumFields
          ? await resolveFieldString(String(artist || ''))
          : { value: '', reasons: [] };
        if (verifyAlbumFields && albumArtistRes.value && albumArtistRes.value !== String(artist || '').trim()) {
          const ch = {
            scope: 'Künstler',
            before: String(artist || '').trim(),
            after: albumArtistRes.value,
            reason: albumArtistRes.reasons.join(', ') || 'Korrigiert',
          };
          changes.push(ch);
          sendEvent({ type: 'update', scope: 'album', field: 'artist', value: ch.after });
          appendAndEmit(`${meta.logTag} ${ch.scope}: „${ch.before}“ → „${ch.after}“ (${ch.reason})`);
        }

        const albumAlbumArtistRes = verifyAlbumFields
          ? await resolveFieldString(String(albumArtist || ''))
          : { value: '', reasons: [] };
        if (
          verifyAlbumFields &&
          albumAlbumArtistRes.value &&
          albumAlbumArtistRes.value !== String(albumArtist || '').trim()
        ) {
          const ch = {
            scope: 'Album-Interpret',
            before: String(albumArtist || '').trim(),
            after: albumAlbumArtistRes.value,
            reason: albumAlbumArtistRes.reasons.join(', ') || 'Korrigiert',
          };
          changes.push(ch);
          sendEvent({ type: 'update', scope: 'album', field: 'albumArtist', value: ch.after });
          appendAndEmit(`${meta.logTag} ${ch.scope}: „${ch.before}“ → „${ch.after}“ (${ch.reason})`);
        }

        const updatedTracks: Array<{ id: string; trackNumber: number; artist: string }> = [];
        for (const trk of trackList) {
          if (abortController.signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          const rawTrkArtist = String(trk?.artist || '').trim();
          const trkRes = rawTrkArtist ? await resolveFieldString(rawTrkArtist) : { value: '', reasons: [] };
          const finalTrkArtist = trkRes.value || rawTrkArtist;
          updatedTracks.push({
            id: String(trk?.id || ''),
            trackNumber: Number(trk?.trackNumber || 0),
            artist: finalTrkArtist,
          });
          if (finalTrkArtist && finalTrkArtist !== rawTrkArtist) {
            const tPad = String(Number(trk?.trackNumber || 0)).padStart(2, '0');
            const ch = {
              scope: `Titel #${tPad}`,
              before: rawTrkArtist,
              after: finalTrkArtist,
              reason: trkRes.reasons.join(', ') || 'Korrigiert',
            };
            changes.push(ch);
            sendEvent({
              type: 'update',
              scope: 'track',
              id: String(trk?.id || ''),
              field: 'artist',
              value: finalTrkArtist,
            });
            appendAndEmit(`${meta.logTag} ${ch.scope}: „${ch.before}“ → „${ch.after}“ (${ch.reason})`);
          }
        }

        appendAndEmit(
          changes.length > 0
            ? `${meta.logTag} Abgeschlossen: ${changes.length} Eintrag/Einträge korrigiert bzw. internationalisiert.`
            : `${meta.logTag} Abgeschlossen: Alle ${tokenCache.size} geprüften ${meta.pluralNoun} sind korrekt und internationalisiert.`
        );

        const payload = {
          field: role,
          artist: albumArtistRes.value || String(artist || '').trim(),
          albumArtist: albumAlbumArtistRes.value || String(albumArtist || '').trim(),
          tracks: updatedTracks,
          changes,
          checkedCount: tokenCache.size,
          logs,
        };
        if (wantsStream) {
          sendEvent({ type: 'done', ...payload });
          res.end();
        } else {
          res.json(payload);
        }
        return;
      }

      // Klassik-Felder: 'composer' | 'orchestra' | 'conductor'
      const verifyAlbumFields = includeAlbumFields !== false;
      const rawAlbumVal =
        role === 'composer' ? String(composer || '') : role === 'orchestra' ? String(orchestra || '') : String(conductor || '');
      const albumValRes = verifyAlbumFields
        ? await resolveFieldString(rawAlbumVal)
        : { value: '', reasons: [] };
      if (verifyAlbumFields && albumValRes.value && albumValRes.value !== rawAlbumVal.trim()) {
        const ch = {
          scope: meta.albumScope,
          before: rawAlbumVal.trim(),
          after: albumValRes.value,
          reason: albumValRes.reasons.join(', ') || 'Korrigiert',
        };
        changes.push(ch);
        sendEvent({ type: 'update', scope: 'album', field: role, value: ch.after });
        appendAndEmit(`${meta.logTag} ${ch.scope}: „${ch.before}“ → „${ch.after}“ (${ch.reason})`);
      }

      const updatedTracks: Array<Record<string, any>> = [];
      for (const trk of trackList) {
        if (abortController.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const rawTrkVal = String(trk?.[role] || '').trim();
        const trkRes = rawTrkVal ? await resolveFieldString(rawTrkVal) : { value: '', reasons: [] };
        const finalTrkVal = trkRes.value || rawTrkVal;
        updatedTracks.push({
          id: String(trk?.id || ''),
          trackNumber: Number(trk?.trackNumber || 0),
          [role]: finalTrkVal,
        });
        if (finalTrkVal && finalTrkVal !== rawTrkVal) {
          const tPad = String(Number(trk?.trackNumber || 0)).padStart(2, '0');
          const ch = {
            scope: `Titel #${tPad}`,
            before: rawTrkVal,
            after: finalTrkVal,
            reason: trkRes.reasons.join(', ') || 'Korrigiert',
          };
          changes.push(ch);
          sendEvent({
            type: 'update',
            scope: 'track',
            id: String(trk?.id || ''),
            field: role,
            value: finalTrkVal,
          });
          appendAndEmit(`${meta.logTag} ${ch.scope}: „${ch.before}“ → „${ch.after}“ (${ch.reason})`);
        }
      }

      appendAndEmit(
        changes.length > 0
          ? `${meta.logTag} Abgeschlossen: ${changes.length} Eintrag/Einträge korrigiert bzw. internationalisiert.`
          : `${meta.logTag} Abgeschlossen: Alle ${tokenCache.size} geprüften ${meta.pluralNoun} sind korrekt und internationalisiert.`
      );

      const payload = {
        field: role,
        [role]: albumValRes.value || rawAlbumVal.trim(),
        tracks: updatedTracks,
        changes,
        checkedCount: tokenCache.size,
        logs,
      };
      if (wantsStream) {
        sendEvent({ type: 'done', ...payload });
        res.end();
      } else {
        res.json(payload);
      }
    } catch (err) {
      if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        if (!res.writableEnded) res.end();
        return;
      }
      const msg = err instanceof Error ? err.message : `${meta.pluralNoun}-Prüfung fehlgeschlagen.`;
      appendAndEmit(`${meta.logTag} Fehler: ${msg}`);
      if (wantsStream) {
        sendEvent({ type: 'error', error: msg });
        if (!res.writableEnded) res.end();
      } else {
        res.status(502).json({ error: msg, logs });
      }
    }
  });

  // 3b. Modul 4 Audio-Konverter (/api/convert) über ffmpeg
  app.post(
    '/api/convert',
    express.raw({ type: 'application/octet-stream', limit: '250mb' }),
    async (req, res) => {
      const osMod = await import('os');
      const tmpDir = fs.mkdtempSync(path.join(osMod.tmpdir(), 'mintrip-convert-'));
      try {
        const rawBody = req.body as Buffer;
        if (!rawBody || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
          res.status(400).json({ error: 'Keine Audiodaten empfangen.' });
          return;
        }

        const sourceName = String(req.query.sourceName || req.headers['x-source-name'] || 'input.wav');
        const targetFormat = String(req.query.targetFormat || 'flac').toLowerCase();
        const quality = String(req.query.quality || '');
        const id3v2Version = String(req.query.id3v2Version || '4') === '3' ? '3' : '4';
        const preserveTags = String(req.query.preserveTags || 'true') !== 'false';
        const normalize = String(req.query.normalize || 'false') === 'true';
        const targetLufsNum = Number(req.query.targetLufs ?? -18);
        const targetLufs = Number.isFinite(targetLufsNum)
          ? Math.max(-30, Math.min(-5, targetLufsNum))
          : -18;
        const ffmpegThreadsRaw = Number(req.query.ffmpegThreads ?? 1);
        const ffmpegThreads = Number.isFinite(ffmpegThreadsRaw)
          ? Math.max(1, Math.min(16, Math.round(ffmpegThreadsRaw)))
          : 1;

        const allowedTargets = new Set(['flac', 'mp3', 'wav', 'opus', 'ogg', 'm4a', 'aiff']);
        if (!allowedTargets.has(targetFormat)) {
          res.status(400).json({ error: `Nicht unterstütztes Zielformat: ${targetFormat}` });
          return;
        }

        const srcExtMatch = path.basename(sourceName).match(/\.([a-zA-Z0-9]+)$/);
        const srcExt = srcExtMatch ? `.${srcExtMatch[1].toLowerCase()}` : '.audio';
        const inPath = path.join(tmpDir, `input${srcExt}`);
        const outPath = path.join(tmpDir, `output.${targetFormat}`);
        fs.writeFileSync(inPath, rawBody);

        const customTagsHeader = req.headers['x-mintrip-tags'];
        let customTags: Record<string, string> | null = null;
        if (typeof customTagsHeader === 'string' && customTagsHeader.trim()) {
          try {
            const decoded = Buffer.from(customTagsHeader.trim(), 'base64').toString('utf8');
            const parsed = JSON.parse(decoded);
            if (parsed && typeof parsed === 'object') {
              customTags = parsed as Record<string, string>;
            }
          } catch {
            customTags = null;
          }
        }

        const execFfmpeg = (ffmpegArgs: string[], failLabel: string) =>
          new Promise<void>((resolve, reject) => {
            execFile('/usr/bin/ffmpeg', ffmpegArgs, { timeout: 180_000 }, (err, _stdout, stderr) => {
              if (err) {
                reject(new Error(stderr?.trim() || err.message || failLabel));
                return;
              }
              resolve();
            });
          });

        const probeSourceAudioParams = async (
          filePath: string
        ): Promise<{ pcmCodec: 'pcm_s16le' | 'pcm_s24le'; sampleRate: number }> => {
          return new Promise((resolve) => {
            execFile(
              '/usr/bin/ffprobe',
              [
                '-v',
                'error',
                '-select_streams',
                'a:0',
                '-show_entries',
                'stream=codec_name,sample_fmt,bits_per_raw_sample,bits_per_sample,sample_rate',
                '-of',
                'json',
                filePath,
              ],
              { timeout: 10_000 },
              (err, stdout) => {
                if (err || !stdout) {
                  resolve({ pcmCodec: 'pcm_s16le', sampleRate: 44100 });
                  return;
                }
                try {
                  const data = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>> };
                  const st = data.streams?.[0] || {};
                  const codec = String(st.codec_name || '').toLowerCase();
                  const sampleFmt = String(st.sample_fmt || '').toLowerCase();
                  const bitsRaw = Number(st.bits_per_raw_sample || 0) || Number(st.bits_per_sample || 0);
                  const sr = Number(st.sample_rate || 44100) || 44100;
                  const losslessCodecs = new Set([
                    'flac',
                    'alac',
                    'tta',
                    'wavpack',
                    'mlp',
                    'truehd',
                  ]);
                  const isHiResPcm =
                    codec.startsWith('pcm_s24') ||
                    codec.startsWith('pcm_s32') ||
                    codec.startsWith('pcm_f32') ||
                    codec.startsWith('pcm_f64') ||
                    codec.startsWith('dsd_') ||
                    (losslessCodecs.has(codec) &&
                      (bitsRaw > 16 || sampleFmt.startsWith('s32') || sampleFmt.startsWith('flt')));
                  resolve({
                    pcmCodec: isHiResPcm ? 'pcm_s24le' : 'pcm_s16le',
                    sampleRate: sr > 0 ? sr : 44100,
                  });
                } catch {
                  resolve({ pcmCodec: 'pcm_s16le', sampleRate: 44100 });
                }
              }
            );
          });
        };

        if (targetFormat === 'flac') {
          const lvl = /^[0-8]$/.test(quality) ? quality : '6';
          const { pcmCodec, sampleRate } = await probeSourceAudioParams(inPath);
          const midWavPath = path.join(tmpDir, 'intermediate.wav');

          // Schritt 1: Quelle sauber in unkomprimierte PCM-WAV-Datei umwandeln (ohne Video-/Container-Ballast)
          const step1Args: string[] = [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-threads',
            String(ffmpegThreads),
            '-filter_threads',
            String(ffmpegThreads),
            '-i',
            inPath,
            '-map',
            '0:a:0',
            '-vn',
            '-map_metadata',
            '-1',
          ];
          if (normalize) {
            step1Args.push(
              '-af',
              `loudnorm=I=${targetLufs.toFixed(1)}:TP=-1.0:LRA=11`,
              '-ar',
              String(sampleRate)
            );
          }
          step1Args.push('-c:a', pcmCodec, '-threads', String(ffmpegThreads), midWavPath);
          await execFfmpeg(step1Args, 'WAV-Zwischenkonvertierung fehlgeschlagen');

          // Schritt 2: WAV nach FLAC kodieren – unter Erhalt von Tags, Stream-Tags & Cover-Art für exakte Bitraten
          const step2Args: string[] = [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-threads',
            String(ffmpegThreads),
            '-filter_threads',
            String(ffmpegThreads),
            '-i',
            midWavPath,
          ];
          if (preserveTags) {
            step2Args.push(
              '-i',
              inPath,
              '-map',
              '0:a:0',
              '-map',
              '1:v?',
              '-c:v',
              'copy',
              '-map_metadata',
              '1',
              '-map_metadata',
              '1:s:a:0'
            );
          } else {
            step2Args.push('-map', '0:a:0', '-vn', '-map_metadata', '-1');
          }
          if (customTags) {
            for (const [k, v] of Object.entries(customTags)) {
              if (k && typeof v === 'string' && v.trim()) {
                step2Args.push('-metadata', `${k}=${v}`);
              }
            }
          }
          step2Args.push('-c:a', 'flac', '-compression_level', lvl, '-threads', String(ffmpegThreads), outPath);
          await execFfmpeg(step2Args, 'FLAC-Kodierung aus WAV fehlgeschlagen');
        } else {
          const args: string[] = [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-threads',
            String(ffmpegThreads),
            '-filter_threads',
            String(ffmpegThreads),
            '-i',
            inPath,
          ];

          if (normalize) {
            args.push('-af', `loudnorm=I=${targetLufs.toFixed(1)}:TP=-1.0:LRA=11`);
          }

          if (preserveTags) {
            args.push('-map_metadata', '0');
          } else {
            args.push('-map_metadata', '-1');
          }

          if (targetFormat === 'mp3') {
            args.push('-map', '0:a:0');
            if (preserveTags) {
              args.push('-map', '0:v?', '-c:v', 'copy');
            } else {
              args.push('-vn');
            }
            args.push('-c:a', 'libmp3lame');
            if (quality === 'cbr_320') args.push('-b:a', '320k');
            else if (quality === 'cbr_256') args.push('-b:a', '256k');
            else if (quality === 'cbr_192') args.push('-b:a', '192k');
            else if (quality === 'vbr_v2') args.push('-q:a', '2');
            else args.push('-q:a', '0');
            args.push('-id3v2_version', id3v2Version);
          } else if (targetFormat === 'wav') {
            args.push('-map', '0:a:0', '-vn');
            args.push('-c:a', quality === '24' ? 'pcm_s24le' : 'pcm_s16le');
            if (preserveTags) {
              args.push('-write_id3v2', '1', '-id3v2_version', id3v2Version);
            }
          } else if (targetFormat === 'aiff') {
            args.push('-map', '0:a:0', '-vn');
            args.push('-c:a', quality === '24' ? 'pcm_s24be' : 'pcm_s16be');
            if (preserveTags) {
              args.push('-write_id3v2', '1', '-id3v2_version', id3v2Version);
            }
          } else if (targetFormat === 'opus') {
            const kbps = /^\d{2,3}$/.test(quality) ? quality : '192';
            args.push('-map', '0:a:0', '-vn', '-c:a', 'libopus', '-b:a', `${kbps}k`);
          } else if (targetFormat === 'ogg') {
            const kbps = /^\d{2,3}$/.test(quality) ? quality : '256';
            args.push('-map', '0:a:0', '-vn', '-c:a', 'libvorbis', '-b:a', `${kbps}k`);
          } else if (targetFormat === 'm4a') {
            const kbps = /^\d{2,3}$/.test(quality) ? quality : '256';
            args.push('-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', `${kbps}k`, '-movflags', '+faststart');
          }

          args.push('-threads', String(ffmpegThreads), outPath);
          await execFfmpeg(args, 'ffmpeg-Konvertierung fehlgeschlagen');
        }

        if (!fs.existsSync(outPath)) {
          res.status(500).json({ error: 'Ausgabedatei wurde nicht erzeugt.' });
          return;
        }

        const outBuffer = fs.readFileSync(outPath);
        const mimeMap: Record<string, string> = {
          flac: 'audio/flac',
          mp3: 'audio/mpeg',
          wav: 'audio/wav',
          opus: 'audio/ogg',
          ogg: 'audio/ogg',
          m4a: 'audio/mp4',
          aiff: 'audio/aiff',
        };
        const outStem = path.basename(sourceName).replace(/\.[^.]+$/, '') || 'converted';
        const outName = `${outStem}.${targetFormat}`;
        res.setHeader('Content-Type', mimeMap[targetFormat] || 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(outName)}`
        );
        res.send(outBuffer);
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Audio-Konvertierung fehlgeschlagen.',
        });
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // Temporäres Verzeichnis-Cleanup ignorieren
        }
      }
    }
  );

  // 3c. Modul 5 Audio-Diagnose & Reparatur (orientiert an MP3Diags + Multi-Format-Integrität)
  interface RepairFindingItem {
    id: string;
    code: string;
    severity: 'critical' | 'warning' | 'info';
    category: 'header' | 'frames' | 'tags' | 'stream' | 'audio';
    stage: 'fast' | 'deep';
    fixAction?: 'header_strip' | 'remux_faststart' | 'vbr_header_rebuild' | 'cover_optimize' | 'lossless_reencode';
    title: string;
    description: string;
    recommendedFix: string;
    autoFixable: boolean;
  }

  type RepairFixAction =
    | 'header_strip'
    | 'remux_faststart'
    | 'vbr_header_rebuild'
    | 'cover_optimize'
    | 'lossless_reencode';

  interface RepairStructureSummary {
    codec: string;
    container: string;
    detectedMagic: string;
    magicMatchesExtension: boolean;
    m4aMoovPosition: 'before_mdat' | 'after_mdat' | 'missing' | null;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    sampleFmt: string;
    channelLayout: string;
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
    flacMd5Status: 'valid' | 'missing' | 'mismatch' | 'unverified' | null;
    flacHasSeektable: boolean | null;
    seekTableValid: boolean | null;
    flacIsOgg: boolean | null;
    flacStreaminfoValid: boolean | null;
    flacSubsetValid: boolean | null;
    flacMinBlockSize: number | null;
    flacMaxBlockSize: number | null;
    flacVariableBlockSize: boolean | null;
    flacFirefoxCompatible: 'compatible' | 'warning' | 'incompatible' | null;
    maxVolumeDb: number | null;
    meanVolumeDb: number | null;
    decodeErrorCount: number;
    streamCrcErrors: number;
    streamTruncated: boolean;
    hasCoverArt: boolean;
    coverArtMime: string;
    coverArtBytes: number;
    coverArtWidth: number;
    coverArtHeight: number;
    missingCoreTags: string[];
    errorPositions?: Array<{
      zone: 'start' | 'stream' | 'end';
      ratio: number | null;
      severity: 'critical' | 'warning' | 'info';
      code: string;
      label: string;
      timeSeconds: number | null;
    }>;
  }

  interface RepairPipelineReport {
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

  const parseMpegFrameHeaderAt = (
    buf: Buffer,
    offset: number
  ): {
    frameLen: number;
    bitrateKbps: number;
    sampleRate: number;
    channels: number;
    versionId: number;
    layerId: number;
    channelMode: number;
    samplesPerFrame: number;
    hasCrc: boolean;
  } | null => {
    if (offset + 4 > buf.length) return null;
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const b2 = buf[offset + 2];
    const b3 = buf[offset + 3];
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
    const versionBits = (b1 >> 3) & 0x03; // 0=2.5, 1=res, 2=2, 3=1
    const layerBits = (b1 >> 1) & 0x03; // 1=III, 2=II, 3=I
    if (versionBits === 1 || layerBits === 0) return null;
    const bitrateIdx = (b2 >> 4) & 0x0f;
    const srIdx = (b2 >> 2) & 0x03;
    if (bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;
    const padding = (b2 >> 1) & 0x01;
    const channelMode = (b3 >> 6) & 0x03;
    const channels = channelMode === 3 ? 1 : 2;
    const hasCrc = (b1 & 0x01) === 0;

    const srTable: Record<number, number[]> = {
      3: [44100, 48000, 32000], // MPEG1
      2: [22050, 24000, 16000], // MPEG2
      0: [11025, 12000, 8000], // MPEG2.5
    };
    const sampleRate = srTable[versionBits]?.[srIdx];
    if (!sampleRate) return null;

    let bitrateKbps = 0;
    if (versionBits === 3) {
      if (layerBits === 3) {
        bitrateKbps = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448][bitrateIdx];
      } else if (layerBits === 2) {
        bitrateKbps = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384][bitrateIdx];
      } else {
        bitrateKbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][bitrateIdx];
      }
    } else {
      if (layerBits === 3) {
        bitrateKbps = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256][bitrateIdx];
      } else {
        bitrateKbps = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][bitrateIdx];
      }
    }
    if (!bitrateKbps) return null;

    let frameLen = 0;
    let samplesPerFrame = 1152;
    if (layerBits === 3) {
      samplesPerFrame = 384;
      frameLen = Math.floor((12 * bitrateKbps * 1000) / sampleRate + padding) * 4;
    } else if (layerBits === 2) {
      samplesPerFrame = 1152;
      frameLen = Math.floor((144 * bitrateKbps * 1000) / sampleRate + padding);
    } else {
      samplesPerFrame = versionBits === 3 ? 1152 : 576;
      const coeff = versionBits === 3 ? 144 : 72;
      frameLen = Math.floor((coeff * bitrateKbps * 1000) / sampleRate + padding);
    }
    if (frameLen < 16 || frameLen > 8192) return null;
    return {
      frameLen,
      bitrateKbps,
      sampleRate,
      channels,
      versionId: versionBits,
      layerId: layerBits,
      channelMode,
      samplesPerFrame,
      hasCrc,
    };
  };

  const stripMpegTrailingTags = (
    buf: Buffer,
    id3Offset: number
  ): { audioEnd: number; hasId3v1: boolean; hasApev2: boolean; hasExtraTrailer: boolean } => {
    let audioEnd = buf.length;
    let hasId3v1 = false;
    let hasApev2 = false;
    let hasExtraTrailer = false;
    for (let iter = 0; iter < 5; iter++) {
      let changed = false;
      // 1. ID3v1 (128 Bytes, beginnt mit 'TAG', aber nicht 'TAG+')
      if (
        audioEnd >= id3Offset + 128 &&
        buf.toString('ascii', audioEnd - 128, audioEnd - 125) === 'TAG' &&
        buf.toString('ascii', audioEnd - 128, audioEnd - 124) !== 'TAG+'
      ) {
        hasId3v1 = true;
        audioEnd -= 128;
        changed = true;
        if (
          audioEnd >= id3Offset + 227 &&
          buf.toString('ascii', audioEnd - 227, audioEnd - 223) === 'TAG+'
        ) {
          audioEnd -= 227;
          hasExtraTrailer = true;
        }
        continue;
      }

      // 2. Lyrics3v2 ('LYRICS200' + 6-stellige ASCII-Länge + 'LYRICSBEGIN')
      if (
        audioEnd >= id3Offset + 15 &&
        buf.toString('ascii', audioEnd - 9, audioEnd) === 'LYRICS200'
      ) {
        const lenStr = buf.toString('ascii', audioEnd - 15, audioEnd - 9);
        if (/^\d{6}$/.test(lenStr)) {
          const lyrSz = Number.parseInt(lenStr, 10);
          const lyrStart = audioEnd - 15 - lyrSz;
          if (
            lyrStart >= id3Offset &&
            buf.toString('ascii', lyrStart, lyrStart + 11) === 'LYRICSBEGIN'
          ) {
            audioEnd = lyrStart;
            hasExtraTrailer = true;
            changed = true;
            continue;
          }
        }
      }

      // 3. Lyrics3v1 ('LYRICSEND', max. 5120 Bytes bis 'LYRICSBEGIN')
      if (
        audioEnd >= id3Offset + 20 &&
        buf.toString('ascii', audioEnd - 9, audioEnd) === 'LYRICSEND'
      ) {
        const searchStart = Math.max(id3Offset, audioEnd - 5120);
        const slice = buf.subarray(searchStart, audioEnd - 9);
        const relIdx = slice.lastIndexOf('LYRICSBEGIN');
        if (relIdx >= 0) {
          audioEnd = searchStart + relIdx;
          hasExtraTrailer = true;
          changed = true;
          continue;
        }
      }

      // 4. APEv2 / APEv1 Footer ('APETAGEX', 32 Bytes)
      // Spezifikation: apeSize beinhaltet den 32-Byte-Footer, aber NICHT den optionalen 32-Byte-Header.
      // Der Header ist NUR vorhanden, wenn Version >= 2000 UND Bit 31 (0x80000000) in flags gesetzt ist!
      if (
        audioEnd >= id3Offset + 32 &&
        buf.toString('ascii', audioEnd - 32, audioEnd - 24) === 'APETAGEX'
      ) {
        const apeVer = buf.readUInt32LE(audioEnd - 24);
        const apeSize = buf.readUInt32LE(audioEnd - 20);
        const apeFlags = buf.readUInt32LE(audioEnd - 12);
        const hasHeaderFlag = apeVer >= 2000 && (apeFlags & 0x80000000) !== 0;
        if (apeSize >= 32 && audioEnd - apeSize >= id3Offset) {
          let totalApe = apeSize;
          if (
            hasHeaderFlag &&
            audioEnd - apeSize - 32 >= id3Offset &&
            buf.toString('ascii', audioEnd - apeSize - 32, audioEnd - apeSize - 24) === 'APETAGEX'
          ) {
            totalApe = apeSize + 32;
          }
          hasApev2 = true;
          hasExtraTrailer = true;
          audioEnd -= totalApe;
          changed = true;
          continue;
        }
      }

      if (!changed) break;
    }
    return { audioEnd, hasId3v1, hasApev2, hasExtraTrailer };
  };

  const extractCleanMpegStream = (
    buf: Buffer,
    id3Offset: number,
    audioEnd: number
  ): { cleanFrames: Buffer; framesKept: number; bytesSkipped: number } => {
    const startBound = Math.max(0, id3Offset);
    const endBound = Math.min(buf.length, Math.max(startBound, audioEnd));
    let firstOff = -1;
    let streamVer = -1;
    let streamLayer = -1;
    let pos = startBound;
    while (pos + 4 < endBound) {
      const hdr = parseMpegFrameHeaderAt(buf, pos);
      if (hdr && pos + hdr.frameLen + 4 <= endBound) {
        const nh = parseMpegFrameHeaderAt(buf, pos + hdr.frameLen);
        if (
          nh &&
          nh.versionId === hdr.versionId &&
          nh.layerId === hdr.layerId &&
          nh.sampleRate === hdr.sampleRate
        ) {
          firstOff = pos;
          streamVer = hdr.versionId;
          streamLayer = hdr.layerId;
          break;
        }
      }
      pos++;
    }
    if (firstOff < 0) {
      return {
        cleanFrames: Buffer.alloc(0),
        framesKept: 0,
        bytesSkipped: Math.max(0, endBound - startBound),
      };
    }

    const parts: Buffer[] = [];
    let framesKept = 0;
    let bytesSkipped = Math.max(0, firstOff - startBound);
    let scanPos = firstOff;
    let lastEnd = firstOff;

    while (scanPos + 4 <= endBound) {
      const hdr = parseMpegFrameHeaderAt(buf, scanPos);
      if (
        hdr &&
        hdr.versionId === streamVer &&
        hdr.layerId === streamLayer &&
        scanPos + hdr.frameLen <= endBound
      ) {
        const frameEnd = scanPos + hdr.frameLen;
        parts.push(buf.subarray(scanPos, frameEnd));
        framesKept++;
        lastEnd = frameEnd;
        scanPos = frameEnd;
      } else {
        let resync = scanPos + 1;
        let found = false;
        while (resync + 4 < endBound) {
          const nh = parseMpegFrameHeaderAt(buf, resync);
          if (
            nh &&
            nh.versionId === streamVer &&
            nh.layerId === streamLayer &&
            resync + nh.frameLen + 4 <= endBound
          ) {
            const nh2 = parseMpegFrameHeaderAt(buf, resync + nh.frameLen);
            if (
              nh2 &&
              nh2.versionId === streamVer &&
              nh2.layerId === streamLayer &&
              nh2.sampleRate === nh.sampleRate
            ) {
              found = true;
              break;
            }
          }
          resync++;
        }
        if (found) {
          bytesSkipped += resync - scanPos;
          scanPos = resync;
        } else {
          bytesSkipped += Math.max(0, endBound - lastEnd);
          break;
        }
      }
    }

    return { cleanFrames: Buffer.concat(parts), framesKept, bytesSkipped };
  };

  const validateRepairedAudioOutput = (
    candidateBuf: Buffer,
    preFindings: RepairFindingItem[],
    preStruct: RepairStructureSummary,
    afterFindings: RepairFindingItem[],
    afterStruct: RepairStructureSummary
  ): string | null => {
    if (candidateBuf.length <= 128) {
      return `Reparierte Datei ist ungültig klein (${candidateBuf.length} Bytes) — Sicherheitsabbruch.`;
    }
    if (preStruct.durationSeconds >= 2 && afterStruct.durationSeconds <= 0) {
      return 'Reparierte Datei meldet keine gültige Spielzeit — Sicherheitsabbruch.';
    }
    const preDurReliable = !(preStruct.isVbr && !preStruct.hasXingHeader);
    if (
      preDurReliable &&
      preStruct.durationSeconds >= 10 &&
      afterStruct.durationSeconds > 0 &&
      afterStruct.durationSeconds < preStruct.durationSeconds * 0.5
    ) {
      return `Reparierte Datei wäre stark verkürzt (${afterStruct.durationSeconds}s statt ${preStruct.durationSeconds}s) — Sicherheitsabbruch.`;
    }
    const preCodes = new Set(preFindings.map((f) => f.code));
    const fatalCodes = new Set([
      'no_mpeg_sync',
      'flac_missing_marker',
      'flac_invalid_streaminfo',
      'flac_invalid_md5',
      'm4a_missing_moov',
      'wav_invalid_header',
      'aiff_invalid_header',
    ]);
    const newFatal = afterFindings.find((f) => fatalCodes.has(f.code) && !preCodes.has(f.code));
    if (newFatal) {
      return `Sicherheitsprüfung fehlgeschlagen (neuer Strukturfehler: ${newFatal.title}) — Original bleibt geschützt.`;
    }
    const preCrit = preFindings.filter((f) => f.severity === 'critical').length;
    const afterCrit = afterFindings.filter((f) => f.severity === 'critical').length;
    if (afterCrit > preCrit) {
      return `Reparatur würde mehr kritische Befunde erzeugen (${afterCrit} statt ${preCrit}) — Sicherheitsabbruch.`;
    }
    return null;
  };

  const detectMagicSignature = (buf: Buffer, id3Offset: number): string => {
    const payload = buf.subarray(Math.max(0, id3Offset));
    if (buf.length >= 12) {
      if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') {
        return 'wav';
      }
      if (buf.subarray(0, 4).toString('ascii') === 'FORM' && ['AIFF', 'AIFC'].includes(buf.subarray(8, 12).toString('ascii'))) {
        return 'aiff';
      }
      if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
        return 'm4a';
      }
    }
    if (payload.length >= 4) {
      const m4 = payload.subarray(0, 4).toString('ascii');
      if (m4 === 'fLaC') return 'flac';
      if (m4 === 'OggS') return 'ogg';
      if (m4 === 'RIFF' && payload.length >= 12 && payload.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
      if (m4 === 'FORM' && payload.length >= 12 && ['AIFF', 'AIFC'].includes(payload.subarray(8, 12).toString('ascii'))) return 'aiff';
      if (payload.length >= 8 && payload.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';
    }
    // Check MPEG Audio sync within first 8 KB after ID3
    const limit = Math.min(buf.length - 4, Math.max(0, id3Offset) + 8192);
    for (let p = Math.max(0, id3Offset); p < limit; p++) {
      const hdr = parseMpegFrameHeaderAt(buf, p);
      if (hdr && p + hdr.frameLen + 4 <= buf.length) {
        const nextHdr = parseMpegFrameHeaderAt(buf, p + hdr.frameLen);
        if (
          nextHdr &&
          nextHdr.versionId === hdr.versionId &&
          nextHdr.layerId === hdr.layerId &&
          nextHdr.sampleRate === hdr.sampleRate
        ) {
          return hdr.layerId === 2 ? 'mp2' : 'mp3';
        }
      }
    }
    return 'unknown';
  };

  const inspectM4aMoovAtoms = (buf: Buffer): 'before_mdat' | 'after_mdat' | 'missing' => {
    let pos = 0;
    let moovOff = -1;
    let mdatOff = -1;
    while (pos + 8 <= buf.length) {
      let atomSize = buf.readUInt32BE(pos);
      const atomType = buf.subarray(pos + 4, pos + 8).toString('latin1');
      if (atomSize === 1 && pos + 16 <= buf.length) {
        atomSize = Number(buf.readBigUInt64BE(pos + 8));
      } else if (atomSize === 0) {
        atomSize = buf.length - pos;
      }
      if (!Number.isFinite(atomSize) || atomSize < 8) break;
      if (atomType === 'moov' && moovOff < 0) moovOff = pos;
      if (atomType === 'mdat' && mdatOff < 0) mdatOff = pos;
      pos += atomSize;
    }
    if (moovOff < 0) return 'missing';
    if (mdatOff >= 0 && moovOff > mdatOff) return 'after_mdat';
    return 'before_mdat';
  };

  const detectImageMimeFromMagic = (imgBuf: Buffer): string => {
    if (imgBuf.length >= 3 && imgBuf[0] === 0xff && imgBuf[1] === 0xd8 && imgBuf[2] === 0xff) return 'image/jpeg';
    if (imgBuf.length >= 8 && imgBuf[0] === 0x89 && imgBuf.subarray(1, 4).toString('ascii') === 'PNG') return 'image/png';
    if (imgBuf.length >= 12 && imgBuf.subarray(0, 4).toString('ascii') === 'RIFF' && imgBuf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (imgBuf.length >= 4 && imgBuf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
    if (imgBuf.length >= 2 && imgBuf.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
    if (imgBuf.length >= 4 && (imgBuf.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || imgBuf.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) return 'image/tiff';
    return '';
  };

  const analyzeAudioFileForRepair = async (
    filePath: string,
    buf: Buffer,
    fileExt: string,
    deepScan: boolean,
    coverMaxDimension = 2048,
    ffmpegThreads = 1
  ): Promise<{
    healthStatus: 'ok' | 'warning' | 'critical';
    findings: RepairFindingItem[];
    structure: RepairStructureSummary;
    pipeline: RepairPipelineReport;
  }> => {
    const maxCoverDim = Math.max(256, Math.min(8192, Math.round(Number(coverMaxDimension) || 2048)));
    const effThreads = Math.max(1, Math.min(16, Math.round(Number(ffmpegThreads) || 1)));
    const fastStartMs = Date.now();
    const findings: RepairFindingItem[] = [];
    const addFinding = (
      item: Omit<RepairFindingItem, 'id' | 'stage'> & { stage?: 'fast' | 'deep' }
    ) => {
      findings.push({
        id: `f-${findings.length + 1}-${item.code}`,
        stage: item.stage || 'fast',
        ...item,
      });
    };

    // STUFE 1: FAST-CHECK (Header, Magic-Bytes, Container & Tags)
    // 1. ID3v2 / ID3v1 / APEv2 Tag-Kettenprüfung (auch gestapelte ID3v2 wie in MP3Diags)
    let id3Offset = 0;
    let id3v2Count = 0;
    const id3v2Versions: string[] = [];
    while (
      id3Offset + 10 <= buf.length &&
      buf[id3Offset] === 0x49 &&
      buf[id3Offset + 1] === 0x44 &&
      buf[id3Offset + 2] === 0x33
    ) {
      const majVer = buf[id3Offset + 3];
      const revVer = buf[id3Offset + 4];
      const flags = buf[id3Offset + 5];
      const r0 = buf[id3Offset + 6];
      const r1 = buf[id3Offset + 7];
      const r2 = buf[id3Offset + 8];
      const r3 = buf[id3Offset + 9];
      if (![2, 3, 4].includes(majVer) || revVer === 0xff || ((r0 | r1 | r2 | r3) & 0x80) !== 0) {
        break;
      }
      const tagSize = (r0 << 21) | (r1 << 14) | (r2 << 7) | r3;
      const footerLen = (flags & 0x10) !== 0 ? 10 : 0;
      const nextOff = id3Offset + 10 + tagSize + footerLen;
      id3v2Count++;
      id3v2Versions.push(`2.${majVer}.${revVer}`);
      if (nextOff > buf.length) {
        addFinding({
          code: 'id3v2_truncated',
          severity: 'critical',
          category: 'tags',
          stage: 'fast',
          fixAction: 'header_strip',
          title: 'Beschädigter / abgeschnittener ID3v2-Header',
          description: `Der ID3v2.${majVer}-Tag meldet ${tagSize} Bytes, überschreitet jedoch das Dateiende.`,
          recommendedFix: 'Tags bereinigen und ID3v2-Header sauber neu schreiben.',
          autoFixable: true,
        });
        break;
      }
      id3Offset = nextOff;
      if (id3v2Count > 6) break;
    }

    if (id3v2Count > 1) {
      addFinding({
        code: 'duplicate_id3v2',
        severity: 'warning',
        category: 'tags',
        stage: 'fast',
        fixAction: 'header_strip',
        title: `Mehrfache ID3v2-Header gestapelt (${id3v2Count}× erkannt)`,
        description: `Es liegen ${id3v2Count} aufeinanderfolgende ID3v2-Blöcke (${id3v2Versions.join(', ')}) vor. Viele Player lesen nur den ersten Tag oder zeigen Inkonsistenzen.`,
        recommendedFix: 'Doppelte ID3v2-Blöcke per Header-Strip zu einem einzigen sauberen ID3v2-Tag zusammenführen.',
        autoFixable: true,
      });
    }

    // ID3v1, Enhanced TAG+, Lyrics3 & APEv2 Footer nur für MPEG-Dateien prüfen
    let audioEndOffset = buf.length;
    let hasId3v1 = false;
    let hasApev2 = false;
    let hasExtraTrailer = false;
    if (fileExt === '.mp3' || fileExt === '.mp2') {
      const stripped = stripMpegTrailingTags(buf, id3Offset);
      audioEndOffset = stripped.audioEnd;
      hasId3v1 = stripped.hasId3v1;
      hasApev2 = stripped.hasApev2;
      hasExtraTrailer = stripped.hasExtraTrailer;
    }

    // 2. ffprobe Metadaten & Stream-Parameter auslesen
    const probeJson = await new Promise<Record<string, unknown>>((resolve) => {
      execFile(
        '/usr/bin/ffprobe',
        [
          '-v',
          'quiet',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          filePath,
        ],
        { timeout: 15_000 },
        (_err, stdout) => {
          try {
            resolve(stdout ? (JSON.parse(stdout) as Record<string, unknown>) : {});
          } catch {
            resolve({});
          }
        }
      );
    });

    const probeStreams = Array.isArray(probeJson.streams)
      ? (probeJson.streams as Array<Record<string, unknown>>)
      : [];
    const probeFormat =
      probeJson.format && typeof probeJson.format === 'object'
        ? (probeJson.format as Record<string, unknown>)
        : {};
    const audioStream = probeStreams.find((s) => s.codec_type === 'audio') || {};
    const videoCoverStream = probeStreams.find(
      (s) =>
        s.codec_type === 'video' ||
        (s.disposition &&
          typeof s.disposition === 'object' &&
          Number((s.disposition as Record<string, unknown>).attached_pic || 0) === 1)
    );

    const codec = String(audioStream.codec_name || fileExt.replace(/^\./, '') || 'audio').toLowerCase();
    const container = String(probeFormat.format_name || fileExt.replace(/^\./, '')).toLowerCase();
    const sampleRate = Number(audioStream.sample_rate || 44100) || 44100;
    const channels = Number(audioStream.channels || 2) || 2;
    const sampleFmt = String(audioStream.sample_fmt || '').toLowerCase();
    const channelLayout = String(audioStream.channel_layout || '').toLowerCase();
    const bitsPerSample =
      Number(audioStream.bits_per_raw_sample || 0) ||
      Number(audioStream.bits_per_sample || 0) ||
      (sampleFmt.includes('32') || sampleFmt.includes('flt')
        ? 32
        : sampleFmt.includes('24')
        ? 24
        : sampleFmt.includes('u8') || sampleFmt === 's8'
        ? 8
        : 16);
    const bitrateKbps = Math.round(
      (Number(audioStream.bit_rate || probeFormat.bit_rate || 0) || 0) / 1000
    );
    const durationSeconds = Math.round(Number(probeFormat.duration || audioStream.duration || 0) || 0);

    // Tags einsammeln (Format + Stream)
    const rawTags: Record<string, string> = {};
    for (const tagBag of [probeFormat.tags, audioStream.tags]) {
      if (tagBag && typeof tagBag === 'object') {
        for (const [k, v] of Object.entries(tagBag as Record<string, unknown>)) {
          if (typeof v === 'string' && v.trim()) {
            rawTags[k.toLowerCase()] = v.trim();
          }
        }
      }
    }
    const missingCoreTags: string[] = [];
    if (!rawTags.title) missingCoreTags.push('Titel');
    if (!rawTags.artist) missingCoreTags.push('Interpret');
    if (!rawTags.album) missingCoreTags.push('Album');
    if (missingCoreTags.length > 0 && fileExt !== '.wav') {
      addFinding({
        code: 'incomplete_tags',
        severity: 'info',
        category: 'tags',
        title: `Fehlende Basis-Tags (${missingCoreTags.join(', ')})`,
        description: `In den Datei-Metadaten fehlen: ${missingCoreTags.join(', ')}. Dies kann in Modul 3 ergänzt werden.`,
        recommendedFix: 'Basis-Tags in „Modul 3 · Album Taggen“ vervollständigen.',
        autoFixable: false,
      });
    }

    const expectedGroup =
      fileExt === '.aif' || fileExt === '.aifc'
        ? 'aiff'
        : fileExt === '.opus'
        ? 'ogg'
        : fileExt.replace(/^\./, '');
    const detectedMagic = detectMagicSignature(buf, id3Offset);
    const magicMatchesExtension =
      detectedMagic === 'unknown'
        ? true
        : expectedGroup === detectedMagic ||
          (expectedGroup === 'mp3' && detectedMagic === 'mp2') ||
          (expectedGroup === 'mp2' && detectedMagic === 'mp3');

    if (!magicMatchesExtension && !(fileExt === '.flac' && detectedMagic === 'ogg')) {
      addFinding({
        code: 'extension_magic_mismatch',
        severity: 'critical',
        category: 'header',
        stage: 'fast',
        fixAction: 'remux_faststart',
        title: `Dateiendung (${fileExt}) widerspricht Magic-Bytes (${detectedMagic.toUpperCase()})`,
        description: `Die Datei trägt die Endung „${fileExt}“, die binäre Header-Signatur gehört jedoch zum Containerformat „${detectedMagic.toUpperCase()}“.`,
        recommendedFix: `Container per Remuxing/Re-Encoding sauber in echtes ${expectedGroup.toUpperCase()} überführen.`,
        autoFixable: true,
      });
    }

    // Cover-Art Inspektion (Größe, Pixel-Dimensionen & tatsächlicher MIME-Type)
    const hasCoverArt = Boolean(videoCoverStream);
    let coverArtMime = '';
    let coverArtBytes = 0;
    let coverArtWidth = Number(videoCoverStream?.width || 0) || 0;
    let coverArtHeight = Number(videoCoverStream?.height || 0) || 0;

    if (hasCoverArt) {
      const declaredCoverCodec = String(videoCoverStream?.codec_name || '').toLowerCase();
      const extractedCover = await new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        const child = spawn(
          '/usr/bin/ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-threads',
            String(effThreads),
            '-filter_threads',
            String(effThreads),
            '-i',
            filePath,
            '-map',
            '0:v:0',
            '-c:v',
            'copy',
            '-f',
            'image2pipe',
            '-',
          ],
          { stdio: ['ignore', 'pipe', 'ignore'] }
        );
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve(Buffer.alloc(0));
        }, 10_000);
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.on('error', () => {
          clearTimeout(timer);
          resolve(Buffer.alloc(0));
        });
        child.on('close', () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks));
        });
      });

      coverArtBytes = extractedCover.length;
      if (coverArtBytes > 0 && (coverArtWidth === 0 || coverArtHeight === 0)) {
        const probedDims = await new Promise<{ w: number; h: number }>((resolve) => {
          const child = spawn(
            '/usr/bin/ffprobe',
            ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-'],
            { stdio: ['pipe', 'pipe', 'ignore'] }
          );
          const chunks: Buffer[] = [];
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
            resolve({ w: 0, h: 0 });
          }, 5000);
          child.stdout.on('data', (c: Buffer) => chunks.push(c));
          child.on('error', () => {
            clearTimeout(timer);
            resolve({ w: 0, h: 0 });
          });
          child.on('close', () => {
            clearTimeout(timer);
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                streams?: Array<{ width?: number; height?: number }>;
              };
              const st = parsed.streams?.[0];
              resolve({ w: Number(st?.width || 0) || 0, h: Number(st?.height || 0) || 0 });
            } catch {
              resolve({ w: 0, h: 0 });
            }
          });
          child.stdin.end(extractedCover);
        });
        if (probedDims.w > 0 && probedDims.h > 0) {
          coverArtWidth = probedDims.w;
          coverArtHeight = probedDims.h;
        }
      }

      coverArtMime =
        detectImageMimeFromMagic(extractedCover) ||
        (declaredCoverCodec === 'mjpeg'
          ? 'image/jpeg'
          : declaredCoverCodec
          ? `image/${declaredCoverCodec}`
          : '');

      const exceedsDimensions = coverArtWidth > maxCoverDim || coverArtHeight > maxCoverDim;
      const exceedsFileSize = coverArtBytes > 1024 * 1024;

      if (coverArtMime && !['image/jpeg', 'image/png'].includes(coverArtMime)) {
        addFinding({
          code: 'cover_art_unsupported_mime',
          severity: 'warning',
          category: 'tags',
          stage: 'fast',
          fixAction: 'cover_optimize',
          title: `Unübliches Cover-Art-Format (${coverArtMime})`,
          description: `Eingebettetes Cover liegt als „${coverArtMime}“ vor. Autoradios, ältere Hardwareplayer und Browser erwarten meist JPEG oder PNG.`,
          recommendedFix: exceedsDimensions
            ? `Cover-Optimierung konvertiert nach JPEG und skaliert auf max. ${maxCoverDim}×${maxCoverDim} px.`
            : coverArtWidth > 0 && coverArtHeight > 0
            ? `Cover-Optimierung konvertiert nach JPEG unter Erhalt der Pixel-Dimensionen (${coverArtWidth}×${coverArtHeight} px).`
            : `Cover-Optimierung konvertiert nach JPEG (max. ${maxCoverDim}×${maxCoverDim} px).`,
          autoFixable: true,
        });
      }
      if (exceedsDimensions) {
        const kb = Math.round(coverArtBytes / 1024);
        addFinding({
          code: 'cover_art_oversized',
          severity: 'warning',
          category: 'tags',
          stage: 'fast',
          fixAction: 'cover_optimize',
          title: `Cover-Auflösung überschreitet Limit (${coverArtWidth}×${coverArtHeight} px > ${maxCoverDim}×${maxCoverDim} px)`,
          description: `Eingebettetes Cover (${coverArtWidth}×${coverArtHeight} px · ${kb} KB) überschreitet das konfigurierte Maximum von ${maxCoverDim}×${maxCoverDim} px.`,
          recommendedFix: `Cover-Optimierung skaliert proportional auf max. ${maxCoverDim}×${maxCoverDim} px${exceedsFileSize ? ' und komprimiert auf ≤ 1 MB' : ''}.`,
          autoFixable: true,
        });
      } else if (exceedsFileSize) {
        const kb = Math.round(coverArtBytes / 1024);
        const mb = (coverArtBytes / (1024 * 1024)).toFixed(2);
        const dimNote = coverArtWidth > 0 && coverArtHeight > 0 ? ` · ${coverArtWidth}×${coverArtHeight} px` : '';
        addFinding({
          code: 'cover_art_oversized',
          severity: 'warning',
          category: 'tags',
          stage: 'fast',
          fixAction: 'cover_optimize',
          title: `Cover-Dateigröße > 1 MB (${mb} MB${dimNote})`,
          description: `Eingebettetes Cover (${kb} KB) ist größer als 1 MB.${coverArtWidth > 0 ? ` Die Pixel-Dimensionen (${coverArtWidth}×${coverArtHeight} px) liegen innerhalb des Limits von ${maxCoverDim}×${maxCoverDim} px.` : ''}`,
          recommendedFix:
            coverArtWidth > 0 && coverArtHeight > 0
              ? `Cover-Optimierung komprimiert auf ≤ 1 MB — aktuelle Pixel-Dimensionen (${coverArtWidth}×${coverArtHeight} px) bleiben zwingend erhalten.`
              : 'Cover-Optimierung komprimiert auf ≤ 1 MB unter Erhalt der Pixel-Dimensionen.',
          autoFixable: true,
        });
      }
    }

    // 3. Formatspezifische Binäranalyse
    let isVbr = false;
    let hasXingHeader = false;
    let xingFrames = 0;
    let actualFrames = 0;
    let xingAudioBytes = 0;
    let actualAudioBytes = 0;
    let leadingGarbageBytes = 0;
    let trailingGarbageBytes = 0;
    let corruptSyncGaps = 0;
    const syncGapRatios: number[] = [];
    const mixedSrRatios: number[] = [];
    let flacMd5Valid: boolean | null = null;
    let flacMd5Status: 'valid' | 'missing' | 'mismatch' | 'unverified' | null = null;
    let flacHasSeektable: boolean | null = null;
    let seekTableValid: boolean | null = null;
    let flacIsOgg: boolean | null = null;
    let flacStreaminfoValid: boolean | null = null;
    let flacSubsetValid: boolean | null = null;
    let flacMinBlockSize: number | null = null;
    let flacMaxBlockSize: number | null = null;
    let flacVariableBlockSize: boolean | null = null;
    let flacFirefoxCompatible: 'compatible' | 'warning' | 'incompatible' | null = null;
    let m4aMoovPosition: 'before_mdat' | 'after_mdat' | 'missing' | null = null;
    let flacStreaminfoMd5Hex: string | null = null;
    let flacTotalSamplesHeader = 0n;
    let flacEffectiveBps = bitsPerSample;
    let flacEffectiveSr = sampleRate;
    let flacEffectiveChannels = channels;

    if (codec === 'mp3' || codec === 'mp2' || fileExt === '.mp3' || fileExt === '.mp2') {
      if (fileExt !== '.mp3' && fileExt !== '.mp2' && !hasId3v1 && !hasApev2) {
        const stripped = stripMpegTrailingTags(buf, id3Offset);
        audioEndOffset = stripped.audioEnd;
        hasId3v1 = stripped.hasId3v1;
        hasApev2 = stripped.hasApev2;
        hasExtraTrailer = stripped.hasExtraTrailer;
      }
      const bitratesSeen = new Set<number>();
      const sampleRatesSeen = new Set<number>();
      let firstFrameOffset = -1;
      let streamVer = -1;
      let streamLayer = -1;
      let streamSr = 0;

      // Ersten gültigen MPEG-Frame (mit Bestätigung des Folge-Frames gleicher Version/Layer/Abtastrate) finden
      let pos = id3Offset;
      while (pos + 4 < audioEndOffset) {
        const hdr = parseMpegFrameHeaderAt(buf, pos);
        if (hdr && pos + hdr.frameLen + 4 <= audioEndOffset) {
          const nextHdr = parseMpegFrameHeaderAt(buf, pos + hdr.frameLen);
          if (
            nextHdr &&
            nextHdr.versionId === hdr.versionId &&
            nextHdr.layerId === hdr.layerId &&
            nextHdr.sampleRate === hdr.sampleRate
          ) {
            firstFrameOffset = pos;
            streamVer = hdr.versionId;
            streamLayer = hdr.layerId;
            streamSr = hdr.sampleRate;
            break;
          }
        }
        pos++;
      }

      if (firstFrameOffset < 0) {
        addFinding({
          code: 'no_mpeg_sync',
          severity: 'critical',
          category: 'frames',
          title: 'Keine gültige MPEG-Audio-Synchronisation gefunden',
          description: 'Die Datei enthält keinen gültigen MP3/MPEG-Frame-Strom.',
          recommendedFix: 'Stream neu aufbauen oder Datei aus Originalquelle wiederherstellen.',
          autoFixable: false,
        });
      } else {
        leadingGarbageBytes = Math.max(0, firstFrameOffset - id3Offset);
        if (leadingGarbageBytes > 4) {
          addFinding({
            code: 'leading_garbage',
            severity: 'warning',
            category: 'frames',
            stage: 'fast',
            fixAction: 'header_strip',
            title: `Fremddaten vor erstem MPEG-Frame (${leadingGarbageBytes} Bytes)`,
            description: `Zwischen Tag-Bereich und erstem Audio-Frame befinden sich ${leadingGarbageBytes} ungültige Füll-/Müll-Bytes.`,
            recommendedFix: 'Header-Strip: Defekte Sync-Frames & Müll-Bytes vor dem Audio-Stream entfernen.',
            autoFixable: true,
          });
        }

        // Xing / Info / LAME / VBRI im ersten Frame prüfen (inkl. 2-Byte-CRC-Offset bei aktivem CRC-Bit!)
        const firstHdr = parseMpegFrameHeaderAt(buf, firstFrameOffset);
        if (firstHdr) {
          const crcLen = firstHdr.hasCrc ? 2 : 0;
          const sideInfoLen =
            firstHdr.versionId === 3
              ? firstHdr.channelMode === 3
                ? 17
                : 32
              : firstHdr.channelMode === 3
              ? 9
              : 17;
          const xingOff = firstFrameOffset + 4 + crcLen + sideInfoLen;
          if (xingOff + 16 <= buf.length) {
            const marker = buf.toString('ascii', xingOff, xingOff + 4);
            if (marker === 'Xing' || marker === 'Info') {
              hasXingHeader = true;
              const xFlags = buf.readUInt32BE(xingOff + 4);
              let cursor = xingOff + 8;
              if ((xFlags & 0x01) !== 0 && cursor + 4 <= buf.length) {
                xingFrames = buf.readUInt32BE(cursor);
                cursor += 4;
              }
              if ((xFlags & 0x02) !== 0 && cursor + 4 <= buf.length) {
                xingAudioBytes = buf.readUInt32BE(cursor);
              }
            }
          }
          for (const vbriOff of [firstFrameOffset + 4 + crcLen + 32, firstFrameOffset + 36]) {
            if (!hasXingHeader && vbriOff + 18 <= buf.length && buf.toString('ascii', vbriOff, vbriOff + 4) === 'VBRI') {
              hasXingHeader = true;
              xingAudioBytes = buf.readUInt32BE(vbriOff + 10);
              xingFrames = buf.readUInt32BE(vbriOff + 14);
              break;
            }
          }
        }

        // Alle MPEG-Frames durchlaufen
        let scanPos = firstFrameOffset;
        let lastFrameEnd = firstFrameOffset;
        while (scanPos + 4 <= audioEndOffset) {
          const hdr = parseMpegFrameHeaderAt(buf, scanPos);
          if (
            hdr &&
            hdr.versionId === streamVer &&
            hdr.layerId === streamLayer &&
            scanPos + hdr.frameLen <= audioEndOffset
          ) {
            const isXingMetaFrame = scanPos === firstFrameOffset && hasXingHeader;
            actualFrames++;
            if (!isXingMetaFrame) {
              bitratesSeen.add(hdr.bitrateKbps);
            }
            if (hdr.sampleRate !== streamSr && mixedSrRatios.length < 8) {
              const span = Math.max(1, audioEndOffset - firstFrameOffset);
              mixedSrRatios.push(Math.max(0, Math.min(1, (scanPos - firstFrameOffset) / span)));
            }
            sampleRatesSeen.add(hdr.sampleRate);
            lastFrameEnd = scanPos + hdr.frameLen;
            scanPos = lastFrameEnd;
          } else {
            // Ungültige Bytes innerhalb des Streams -> nächsten gültigen Sync gleicher Version/Layer suchen
            let resync = scanPos + 1;
            let found = false;
            while (resync + 4 < audioEndOffset) {
              const nh = parseMpegFrameHeaderAt(buf, resync);
              if (
                nh &&
                nh.versionId === streamVer &&
                nh.layerId === streamLayer &&
                resync + nh.frameLen + 4 <= audioEndOffset
              ) {
                const nh2 = parseMpegFrameHeaderAt(buf, resync + nh.frameLen);
                if (
                  nh2 &&
                  nh2.versionId === streamVer &&
                  nh2.layerId === streamLayer &&
                  nh2.sampleRate === nh.sampleRate
                ) {
                  if (nh.sampleRate === streamSr) {
                    found = true;
                    break;
                  }
                  const thirdOff = resync + nh.frameLen + nh2.frameLen;
                  if (thirdOff + 4 <= audioEndOffset) {
                    const nh3 = parseMpegFrameHeaderAt(buf, thirdOff);
                    if (
                      nh3 &&
                      nh3.versionId === streamVer &&
                      nh3.layerId === streamLayer &&
                      nh3.sampleRate === nh.sampleRate
                    ) {
                      found = true;
                      break;
                    }
                  }
                }
              }
              resync++;
            }
            if (found) {
              corruptSyncGaps++;
              if (syncGapRatios.length < 16) {
                const span = Math.max(1, audioEndOffset - firstFrameOffset);
                syncGapRatios.push(Math.max(0, Math.min(1, (scanPos - firstFrameOffset) / span)));
              }
              scanPos = resync;
            } else {
              break;
            }
          }
        }

        actualAudioBytes = Math.max(0, lastFrameEnd - firstFrameOffset);
        trailingGarbageBytes = Math.max(0, audioEndOffset - lastFrameEnd);
        isVbr = bitratesSeen.size > 1;
        seekTableValid = isVbr ? hasXingHeader : true;

        if (corruptSyncGaps > 0) {
          addFinding({
            code: 'corrupt_sync_gaps',
            severity: 'critical',
            category: 'frames',
            stage: 'fast',
            fixAction: 'remux_faststart',
            title: `${corruptSyncGaps} Synchronisationslücke(n) im MPEG-Stream`,
            description: `Im Audiostrom wurden ${corruptSyncGaps} Stellen mit defekten Sync-Bytes gefunden (oft Ursache für Knackser oder Player-Abbrüche).`,
            recommendedFix: 'Stream neu muxen und defekte Frame-Lücken bereinigen.',
            autoFixable: true,
          });
        }
        if (trailingGarbageBytes > 16) {
          addFinding({
            code: 'trailing_garbage',
            severity: 'warning',
            category: 'frames',
            stage: 'fast',
            fixAction: 'header_strip',
            title: `Überhängende Bytes am Dateiende (${trailingGarbageBytes} Bytes)`,
            description: `Nach dem letzten gültigen Audio-Frame folgen ${trailingGarbageBytes} Bytes nicht zuordenbare Daten.`,
            recommendedFix: 'Header-Strip: Abgeschnittene Restframes und Dateiende-Ballast verlustfrei entfernen.',
            autoFixable: true,
          });
        }
        if (sampleRatesSeen.size > 1) {
          addFinding({
            code: 'mixed_samplerate_frames',
            severity: 'critical',
            category: 'frames',
            stage: 'fast',
            fixAction: 'vbr_header_rebuild',
            title: 'Wechselnde Abtastraten innerhalb der MP3-Datei',
            description: `Es wurden MPEG-Frames mit unterschiedlichen Sample-Raten erkannt (${Array.from(sampleRatesSeen).join(' / ')} Hz).`,
            recommendedFix: 'Datei sauber neu aufbauen (VBR/Stream-Header erneuern).',
            autoFixable: true,
          });
        }
        if (isVbr && !hasXingHeader) {
          seekTableValid = false;
          addFinding({
            code: 'missing_xing_header',
            severity: 'critical',
            category: 'header',
            stage: 'fast',
            fixAction: 'vbr_header_rebuild',
            title: 'Fehlender VBR/Xing-Header (falsche Spielzeit-Anzeige)',
            description: `VBR-MP3 mit ${actualFrames} Frames besitzt keinen Xing-/LAME-Header. Player zeigen oft stark falsche Dauern und springen beim Spulen.`,
            recommendedFix: 'VBR-Header-Rebuild: Xing / Info-Header verlustfrei neu aufbauen.',
            autoFixable: true,
          });
        } else if (
          hasXingHeader &&
          ((xingFrames > 0 &&
            actualFrames > 10 &&
            Math.min(
              Math.abs(xingFrames - actualFrames),
              Math.abs(xingFrames - Math.max(0, actualFrames - 1))
            ) > Math.max(4, Math.round(actualFrames * 0.02))) ||
            (xingAudioBytes > 0 &&
              actualAudioBytes > 4096 &&
              Math.abs(xingAudioBytes - actualAudioBytes) > Math.max(4096, Math.round(actualAudioBytes * 0.05))))
        ) {
          seekTableValid = false;
          addFinding({
            code: 'xing_frame_mismatch',
            severity: 'warning',
            category: 'header',
            stage: 'fast',
            fixAction: 'vbr_header_rebuild',
            title: 'Xing/Info-Header widerspricht realer Stream-Größe',
            description: `Header meldet ${xingFrames} Frames (${xingAudioBytes} B), real existieren ${actualFrames} gültige Frames (${actualAudioBytes} B).`,
            recommendedFix: 'VBR-Header-Rebuild: Xing / Info-Header & Seek-TOC korrigieren.',
            autoFixable: true,
          });
        }
        if (id3v2Count === 0 && hasId3v1) {
          addFinding({
            code: 'id3v1_only',
            severity: 'info',
            category: 'tags',
            stage: 'fast',
            fixAction: 'header_strip',
            title: 'Nur veralteter ID3v1-Tag vorhanden (kein ID3v2)',
            description: 'ID3v1 unterstützt max. 30 Zeichen und kein UTF-8 oder Coverbild.',
            recommendedFix: 'Sauberen ID3v2.3/ID3v2.4-Header ergänzen.',
            autoFixable: true,
          });
        }
      }
    } else if (codec === 'flac' || fileExt === '.flac' || container.includes('flac')) {
      const STANDARD_FLAC_SAMPLE_RATES = new Set([
        8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000,
      ]);
      const payloadAfterId3 = buf.subarray(Math.max(0, id3Offset));
      const startsWithOgg =
        (payloadAfterId3.length >= 4 && payloadAfterId3.toString('ascii', 0, 4) === 'OggS') ||
        container.split(',').includes('ogg');
      flacIsOgg = startsWithOgg;
      flacStreaminfoValid = false;
      flacSubsetValid = true;

      if (id3v2Count > 0) {
        addFinding({
          code: 'flac_has_id3v2_prefix',
          severity: 'critical',
          category: 'header',
          stage: 'fast',
          fixAction: 'header_strip',
          title: 'Vorangestellter ID3v2-Header vor fLaC (Firefox-inkompatibel)',
          description: `FLAC verwendet Vorbis Comments statt ID3v2 (${id3v2Count}× ID3v2 vor Streamstart). Strenge Parser wie der Firefox FlacDemuxer lehnen vorangestellte ID3-Header ab.`,
          recommendedFix: 'Header-Strip / Remuxing: ID3v2-Präfix entfernen und Metadaten sauber als Vorbis Comments in nativen FLAC-Container schreiben.',
          autoFixable: true,
        });
      }

      if (startsWithOgg) {
        flacSubsetValid = false;
        addFinding({
          code: 'flac_ogg_container',
          severity: 'critical',
          category: 'header',
          stage: 'fast',
          fixAction: 'lossless_reencode',
          title: 'Ogg-FLAC-Container statt nativem FLAC (Firefox-inkompatibel)',
          description: 'Die Datei verwendet einen Ogg-Container (OggS) statt des nativen fLaC-Formats. Firefox unterstützt bei .flac-Dateien nur natives fLaC zuverlässig.',
          recommendedFix: 'Verlustfreies Re-Encoding / Remuxing in einen nativen fLaC-Container.',
          autoFixable: true,
        });
      } else {
        const directFlacMagic = payloadAfterId3.length >= 4 && payloadAfterId3.toString('ascii', 0, 4) === 'fLaC';
        const searchLimit = Math.min(buf.length, Math.max(0, id3Offset) + 16384);
        const flacStart = directFlacMagic
          ? Math.max(0, id3Offset)
          : buf.subarray(0, searchLimit).indexOf('fLaC', Math.max(0, id3Offset));

        if (flacStart >= 0 && flacStart + 4 <= buf.length) {
          if (flacStart > id3Offset) {
            leadingGarbageBytes = flacStart - id3Offset;
            addFinding({
              code: 'flac_leading_garbage',
              severity: 'critical',
              category: 'header',
              stage: 'fast',
              fixAction: 'header_strip',
              title: `Fremdbytes vor fLaC-Signatur (${leadingGarbageBytes} Bytes)`,
              description: 'Die fLaC-Signatur beginnt nicht am Stream-Anfang. Firefox erfordert „fLaC“ exakt an Byte 0.',
              recommendedFix: 'Header-Strip: Fremdbytes vor fLaC entfernen und Container sauber neu aufbauen.',
              autoFixable: true,
            });
          }

          let blockOff = flacStart + 4;
          let blockIndex = 0;
          let streaminfoCount = 0;
          let hasSeektable = false;
          let seekTableInvalidReason = '';
          let isLast = false;
          let firstBlockIsStreaminfo = false;
          let siSampleRate = 0;
          let siChannels = 0;
          let siBps = 0;
          let siTotalSamples = 0n;
          const seektableBlocks: Array<{ dataOff: number; blockLen: number }> = [];

          while (!isLast && blockOff + 4 <= buf.length) {
            const hdrByte = buf[blockOff];
            isLast = (hdrByte & 0x80) !== 0;
            const blockType = hdrByte & 0x7f;
            const blockLen =
              (buf[blockOff + 1] << 16) | (buf[blockOff + 2] << 8) | buf[blockOff + 3];
            const dataOff = blockOff + 4;
            if (dataOff + blockLen > buf.length) {
              addFinding({
                code: 'flac_corrupt_metadata_block',
                severity: 'critical',
                category: 'header',
                stage: 'fast',
                fixAction: 'lossless_reencode',
                title: 'Defekter FLAC-Metadatenblock',
                description: 'Die Längenangabe eines FLAC-Metadatenblocks überschreitet das Dateiende.',
                recommendedFix: 'Verlustfreies Re-Encoding über 2-Schritt-WAV.',
                autoFixable: true,
              });
              break;
            }

            if (blockType === 0) {
              streaminfoCount++;
              if (blockIndex === 0) firstBlockIsStreaminfo = true;
              if (blockLen !== 34) {
                addFinding({
                  code: 'flac_invalid_streaminfo',
                  severity: 'critical',
                  category: 'header',
                  stage: 'fast',
                  fixAction: 'lossless_reencode',
                  title: `Fehlerhafte STREAMINFO-Blockgröße (${blockLen} statt 34 Bytes)`,
                  description: 'Der FLAC-STREAMINFO-Block muss exakt 34 Bytes umfassen, damit Firefox ihn einlesen kann.',
                  recommendedFix: 'Verlustfreies Re-Encoding / STREAMINFO-Neuaufbau.',
                  autoFixable: true,
                });
              } else {
                const minBS = buf.readUInt16BE(dataOff);
                const maxBS = buf.readUInt16BE(dataOff + 2);
                const packed = buf.readBigUInt64BE(dataOff + 10);
                siSampleRate = Number((packed >> 44n) & 0xfffffn);
                siChannels = Number((packed >> 41n) & 0x7n) + 1;
                siBps = Number((packed >> 36n) & 0x1fn) + 1;
                siTotalSamples = packed & 0xfffffffffn;
                flacTotalSamplesHeader = siTotalSamples;
                flacMinBlockSize = minBS;
                flacMaxBlockSize = maxBS;

                if (siSampleRate > 0) flacEffectiveSr = siSampleRate;
                if (siChannels > 0) flacEffectiveChannels = siChannels;
                if (siBps > 0) flacEffectiveBps = siBps;

                const validDims =
                  minBS >= 16 &&
                  maxBS >= minBS &&
                  siSampleRate > 0 &&
                  siChannels >= 1 &&
                  siChannels <= 8 &&
                  siBps >= 4;
                if (blockIndex === 0 && streaminfoCount === 1 && validDims) {
                  flacStreaminfoValid = true;
                } else if (!validDims) {
                  addFinding({
                    code: 'flac_invalid_streaminfo',
                    severity: 'critical',
                    category: 'header',
                    stage: 'fast',
                    fixAction: 'lossless_reencode',
                    title: 'Ungültige Parameter im FLAC-STREAMINFO-Block',
                    description: `STREAMINFO enthält ungültige Basiswerte (Blockgröße: ${minBS}–${maxBS}, Abtastrate: ${siSampleRate} Hz, Bittiefe: ${siBps}-Bit).`,
                    recommendedFix: 'FLAC-Header & STREAMINFO verlustfrei neu aufbauen.',
                    autoFixable: true,
                  });
                }

                if (siTotalSamples === 0n) {
                  addFinding({
                    code: 'flac_unknown_total_samples',
                    severity: 'warning',
                    category: 'header',
                    stage: 'fast',
                    fixAction: 'lossless_reencode',
                    title: 'STREAMINFO ohne Gesamtlänge (Total Samples = 0)',
                    description: 'Ohne Sample-Anzahl im STREAMINFO zeigt Firefox ggf. keine Spieldauer an und Spulen funktioniert nicht zuverlässig.',
                    recommendedFix: 'STREAMINFO mit exakter Sample-Anzahl neu erzeugen.',
                    autoFixable: true,
                  });
                }

                if (
                  audioStream.codec_type === 'audio' &&
                  ((siSampleRate > 0 && Math.abs(siSampleRate - sampleRate) > 1) ||
                    (siChannels > 0 && siChannels !== channels))
                ) {
                  addFinding({
                    code: 'flac_streaminfo_mismatch',
                    severity: 'warning',
                    category: 'header',
                    stage: 'fast',
                    fixAction: 'lossless_reencode',
                    title: 'STREAMINFO weicht von Audio-Frames ab',
                    description: `STREAMINFO meldet ${siSampleRate} Hz / ${siChannels}ch, die Frames enthalten ${sampleRate} Hz / ${channels}ch.`,
                    recommendedFix: 'FLAC-Container über 2-Schritt-WAV neu aufbauen.',
                    autoFixable: true,
                  });
                }

                const md5Slice = buf.subarray(dataOff + 18, dataOff + 34);
                const allZero = md5Slice.every((b) => b === 0);
                if (allZero) {
                  flacMd5Valid = false;
                  flacMd5Status = 'missing';
                  addFinding({
                    code: 'flac_zero_md5',
                    severity: 'warning',
                    category: 'header',
                    stage: 'fast',
                    fixAction: 'lossless_reencode',
                    title: 'FLAC-STREAMINFO enthält keine MD5-Prüfsumme (0000...)',
                    description: 'Die interne Audio-MD5-Signatur im STREAMINFO-Block ist leer, wodurch Integritätsprüfungen scheitern.',
                    recommendedFix: 'FLAC-Header & MD5 verlustfrei neu schreiben.',
                    autoFixable: true,
                  });
                } else {
                  flacMd5Valid = true;
                  flacMd5Status = 'unverified';
                  flacStreaminfoMd5Hex = md5Slice.toString('hex');
                }
              }
            } else if (blockType === 3) {
              hasSeektable = true;
              seektableBlocks.push({ dataOff, blockLen });
            }
            blockIndex++;
            blockOff = dataOff + blockLen;
          }

          if (streaminfoCount === 0 || !firstBlockIsStreaminfo) {
            flacStreaminfoValid = false;
            flacSubsetValid = false;
            addFinding({
              code: 'flac_missing_streaminfo',
              severity: 'critical',
              category: 'header',
              stage: 'fast',
              fixAction: 'lossless_reencode',
              title: streaminfoCount === 0
                ? 'Fehlender FLAC-STREAMINFO-Metadatenblock'
                : 'STREAMINFO steht nicht als erster Metadatenblock',
              description: 'Gemäß FLAC-Spezifikation (und Firefox FlacDemuxer) muss STREAMINFO zwingend direkt nach fLaC als erster Block folgen.',
              recommendedFix: 'FLAC-Container über 2-Schritt-WAV neu aufbauen.',
              autoFixable: true,
            });
          } else if (streaminfoCount > 1) {
            flacStreaminfoValid = false;
            flacSubsetValid = false;
            addFinding({
              code: 'flac_duplicate_streaminfo',
              severity: 'critical',
              category: 'header',
              stage: 'fast',
              fixAction: 'lossless_reencode',
              title: `Mehrfache STREAMINFO-Blöcke erkannt (${streaminfoCount}×)`,
              description: 'Eine gültige FLAC-Datei darf nur genau einen STREAMINFO-Block enthalten.',
              recommendedFix: 'FLAC-Header sauber neu schreiben.',
              autoFixable: true,
            });
          }

          // SEEKTABLE-Einträge strukturell prüfen (18 Bytes pro Punkt, sortiert & innerhalb Stream-Ende)
          const firstAudioOff = blockOff;
          if (seektableBlocks.length > 0) {
            seekTableValid = true;
            const maxStreamRelOffset = Math.max(0, buf.length - firstAudioOff);
            for (const stb of seektableBlocks) {
              if (stb.blockLen % 18 !== 0) {
                seekTableValid = false;
                seekTableInvalidReason = `Blockgröße (${stb.blockLen} B) ist kein Vielfaches von 18 Bytes`;
                break;
              }
              let prevSample = -1n;
              let prevOff = -1n;
              for (let p = 0; p < stb.blockLen; p += 18) {
                const sampleNr = buf.readBigUInt64BE(stb.dataOff + p);
                if (sampleNr === 0xffffffffffffffffn) continue;
                const streamRelOff = buf.readBigUInt64BE(stb.dataOff + p + 8);
                if (sampleNr <= prevSample || streamRelOff < prevOff) {
                  seekTableValid = false;
                  seekTableInvalidReason = 'Seekpoints sind nicht monoton steigend sortiert';
                  break;
                }
                if (streamRelOff >= BigInt(maxStreamRelOffset + 1)) {
                  seekTableValid = false;
                  seekTableInvalidReason = 'Seekpoint verweist hinter das Dateiende';
                  break;
                }
                if (flacTotalSamplesHeader > 0n && sampleNr >= flacTotalSamplesHeader) {
                  seekTableValid = false;
                  seekTableInvalidReason = 'Seekpoint-Sample liegt außerhalb der Gesamtdauer';
                  break;
                }
                prevSample = sampleNr;
                prevOff = streamRelOff;
              }
              if (!seekTableValid) break;
            }
            if (!seekTableValid) {
              addFinding({
                code: 'flac_invalid_seektable',
                severity: 'warning',
                category: 'header',
                stage: 'fast',
                fixAction: 'lossless_reencode',
                title: 'Ungültige FLAC-SEEKTABLE erkannt',
                description: `Die Seek-Tabelle ist beschädigt (${seekTableInvalidReason}). Spulen im Player oder Browser kann fehlschlagen.`,
                recommendedFix: 'FLAC-Container mit gültiger SEEKTABLE verlustfrei neu aufbauen.',
                autoFixable: true,
              });
            }
          }

          // Ersten FLAC-Audioframe nach dem letzten Metadatenblock auf Blockgrößen-Strategie & Kanalzuordnung prüfen
          let frameVariableStrategy = false;
          let frameChannelAssignment = -1;
          if (isLast && blockOff + 4 <= buf.length) {
            const b0 = buf[blockOff];
            const b1 = buf[blockOff + 1];
            if (b0 === 0xff && (b1 & 0xfe) === 0xf8) {
              frameVariableStrategy = (b1 & 0x01) === 1;
              frameChannelAssignment = (buf[blockOff + 3] >> 4) & 0x0f;
            }
          }

          const hasVarBlockSize =
            (flacMinBlockSize !== null &&
              flacMaxBlockSize !== null &&
              flacMinBlockSize > 0 &&
              flacMinBlockSize !== flacMaxBlockSize) ||
            frameVariableStrategy;
          flacVariableBlockSize = hasVarBlockSize;

          const subsetBlockLimit = flacEffectiveSr <= 48000 ? 4608 : 16384;
          if (hasVarBlockSize) {
            flacSubsetValid = false;
            addFinding({
              code: 'flac_variable_blocksize',
              severity: 'warning',
              category: 'stream',
              stage: 'fast',
              fixAction: 'lossless_reencode',
              title: `Variable FLAC-Blockgrößen (${flacMinBlockSize ?? '?'}–${flacMaxBlockSize ?? '?'} Samples)`,
              description: 'Variable Blockgrößen liegen außerhalb des FLAC-Subsets und verursachen in Firefox häufig Such-/Seeking-Probleme oder Dekodierabbrüche.',
              recommendedFix: 'Verlustfreies Re-Encoding mit konstanter Standard-Blockgröße.',
              autoFixable: true,
            });
          } else if (flacMaxBlockSize !== null && flacMaxBlockSize > subsetBlockLimit) {
            flacSubsetValid = false;
            addFinding({
              code: 'flac_oversized_blocksize',
              severity: 'warning',
              category: 'stream',
              stage: 'fast',
              fixAction: 'lossless_reencode',
              title: `FLAC-Blockgröße außerhalb Subset-Limit (${flacMaxBlockSize} > ${subsetBlockLimit} Samples)`,
              description: `Bei ${(flacEffectiveSr / 1000).toFixed(1)} kHz erlaubt das FLAC-Subset max. ${subsetBlockLimit} Samples pro Block; größere Blöcke erschweren Streaming/Buffering in Firefox.`,
              recommendedFix: 'FLAC mit Standard-Blockgröße (4096/4608 Samples) verlustfrei neu kodieren.',
              autoFixable: true,
            });
          }

          if (frameChannelAssignment >= 11) {
            flacSubsetValid = false;
            addFinding({
              code: 'flac_firefox_unusual_channels',
              severity: 'warning',
              category: 'stream',
              stage: 'fast',
              fixAction: 'lossless_reencode',
              title: `Ungültige/reservierte FLAC-Kanalzuordnung (Code ${frameChannelAssignment})`,
              description: 'Der erste Audio-Frame verwendet einen reservierten Kanalzuordnungs-Code (11–15).',
              recommendedFix: 'FLAC-Stream über WAV sauber neu aufbauen.',
              autoFixable: true,
            });
          }

          flacHasSeektable = hasSeektable;
          if (!hasSeektable) {
            addFinding({
              code: 'flac_no_seektable',
              severity: 'info',
              category: 'header',
              stage: 'fast',
              fixAction: 'remux_faststart',
              title: 'Keine FLAC-SEEKTABLE vorhanden',
              description: 'Ohne Seektable kann schnelles Spulen in langen Tracks verzögert sein.',
              recommendedFix: 'Container mit SEEKTABLE neu aufbauen.',
              autoFixable: true,
            });
          }
        } else {
          flacSubsetValid = false;
          addFinding({
            code: 'flac_missing_marker',
            severity: 'critical',
            category: 'header',
            stage: 'fast',
            fixAction: 'lossless_reencode',
            title: 'Fehlender fLaC-Container-Header',
            description: 'Die Datei beginnt nicht mit der gültigen fLaC-Signatur.',
            recommendedFix: 'FLAC-Container verlustfrei reparieren.',
            autoFixable: true,
          });
        }
      }

      // Firefox- & FLAC-Subset-Kriterien: Abtastrate & Bittiefe
      if (flacEffectiveSr <= 0) {
        flacSubsetValid = false;
        addFinding({
          code: 'flac_firefox_samplerate_too_high',
          severity: 'critical',
          category: 'stream',
          stage: 'fast',
          fixAction: 'lossless_reencode',
          title: 'Ungültige FLAC-Abtastrate (0 Hz)',
          description: 'Im STREAMINFO-Header ist keine gültige Abtastrate hinterlegt.',
          recommendedFix: 'Verlustfreies Re-Encoding der FLAC-Datei durchführen.',
          autoFixable: true,
        });
      } else if (flacEffectiveSr > 192000) {
        flacSubsetValid = false;
        addFinding({
          code: 'flac_firefox_samplerate_too_high',
          severity: 'warning',
          category: 'stream',
          stage: 'fast',
          fixAction: 'lossless_reencode',
          title: `Hi-Res-Abtastrate ${(flacEffectiveSr / 1000).toFixed(1)} kHz (> 192 kHz — Firefox-inkompatibel)`,
          description: 'Die FLAC-Datei ist technisch gültig, aber Firefox unterstützt natives FLAC nur bis maximal 192 kHz Abtastrate.',
          recommendedFix: 'Nur bei Bedarf für Firefox-Wiedergabe „FLAC-Firefox-Konvertierung“ aktivieren (Resampling auf ≤ 192 kHz).',
          autoFixable: false,
        });
      } else if (!STANDARD_FLAC_SAMPLE_RATES.has(flacEffectiveSr)) {
        flacSubsetValid = false;
        addFinding({
          code: 'flac_firefox_nonstandard_samplerate',
          severity: 'warning',
          category: 'stream',
          stage: 'fast',
          fixAction: 'lossless_reencode',
          title: `Nicht standardmäßige FLAC-Abtastrate (${flacEffectiveSr} Hz)`,
          description: 'Abweichende Abtastraten außerhalb der gängigen Audio-Standards (44,1/48/96/192 kHz) können in Firefox zu Wiedergabe- oder Resampling-Fehlern führen.',
          recommendedFix: 'Mit „Firefox-Kompatibilitätskonvertierung“ auf eine Standard-Abtastrate umrechnen.',
          autoFixable: true,
        });
      }

      const isFloatSampleFmt = ['flt', 'fltp', 'dbl', 'dblp'].includes(sampleFmt);
      if (flacEffectiveBps > 24 || isFloatSampleFmt) {
        flacSubsetValid = false;
        addFinding({
          code: 'flac_firefox_bitdepth_too_high',
          severity: isFloatSampleFmt ? 'critical' : 'warning',
          category: 'stream',
          stage: 'fast',
          fixAction: 'lossless_reencode',
          title: `Bittiefe > 24-Bit (${flacEffectiveBps}-Bit${sampleFmt ? ` · ${sampleFmt}` : ''} — Firefox-inkompatibel)`,
          description: 'Firefox unterstützt im nativen FLAC-Dekoder maximal 24-Bit-Integer-PCM. 32-Bit-Integer-FLAC ist zwar nach FLAC 1.4 gültig, wird aber von Firefox abgelehnt.',
          recommendedFix: 'Nur bei Bedarf für Firefox-Wiedergabe „FLAC-Firefox-Konvertierung“ aktivieren (24-Bit/16-Bit Integer).',
          autoFixable: isFloatSampleFmt,
        });
      } else if (flacEffectiveBps > 0 && flacEffectiveBps !== 16 && flacEffectiveBps !== 24) {
        addFinding({
          code: 'flac_firefox_nonstandard_bitdepth',
          severity: 'warning',
          category: 'stream',
          stage: 'fast',
          fixAction: 'lossless_reencode',
          title: `Nicht standardmäßige FLAC-Bittiefe (${flacEffectiveBps}-Bit)`,
          description: `Firefox erwartet üblicherweise 16-Bit oder 24-Bit; ${flacEffectiveBps}-Bit kann je nach Audio-Backend Probleme verursachen.`,
          recommendedFix: 'Über 2-Schritt-WAV auf 16-Bit oder 24-Bit normieren.',
          autoFixable: true,
        });
      }

      // Firefox-Kriterien: Kanäle (> 2 / Surround oder unübliche Kanalzuordnung)
      if (flacEffectiveChannels > 2) {
        flacSubsetValid = false;
        addFinding({
          code: 'flac_firefox_multichannel',
          severity: 'warning',
          category: 'stream',
          stage: 'fast',
          fixAction: 'lossless_reencode',
          title: `Mehrkanal-Audio (${flacEffectiveChannels} Kanäle${channelLayout ? ` · ${channelLayout}` : ''} — Firefox-inkompatibel)`,
          description: 'Die Mehrkanal-FLAC-Datei ist technisch gültig, aber Firefox gibt natives FLAC zuverlässig nur als Mono (1ch) oder Stereo (2ch) wieder.',
          recommendedFix: 'Nur bei Bedarf für Firefox-Wiedergabe „FLAC-Firefox-Konvertierung“ aktivieren (Downmix auf Stereo).',
          autoFixable: false,
        });
      } else {
        const chMaskRaw = rawTags['waveformatextensible_channel_mask'];
        const chMaskVal = chMaskRaw ? Number.parseInt(chMaskRaw, 16) : NaN;
        const unusualMask =
          Boolean(chMaskRaw) &&
          Number.isFinite(chMaskVal) &&
          ((flacEffectiveChannels === 1 && chMaskVal !== 0x4) ||
            (flacEffectiveChannels === 2 && chMaskVal !== 0x3));
        const unusualLayout =
          Boolean(channelLayout) &&
          ((flacEffectiveChannels === 1 && channelLayout !== 'mono' && channelLayout !== 'fc') ||
            (flacEffectiveChannels === 2 && channelLayout !== 'stereo'));
        if (unusualLayout || unusualMask) {
          addFinding({
            code: 'flac_firefox_unusual_channels',
            severity: 'warning',
            category: 'stream',
            stage: 'fast',
            fixAction: 'lossless_reencode',
            title: `Unübliche Kanalzuordnung (${channelLayout || chMaskRaw})`,
            description: 'Abweichende Kanalmasken oder unübliche Kanalzuordnungen können im Firefox-FLAC-Demuxer Störungen auslösen.',
            recommendedFix: 'Kanalzuordnung auf Standard Mono/Stereo bereinigen.',
            autoFixable: true,
          });
        }
      }
    } else if (fileExt === '.m4a' || detectedMagic === 'm4a') {
      m4aMoovPosition = inspectM4aMoovAtoms(buf);
      if (m4aMoovPosition === 'missing') {
        seekTableValid = false;
        addFinding({
          code: 'm4a_missing_moov',
          severity: 'critical',
          category: 'header',
          stage: 'fast',
          fixAction: 'remux_faststart',
          title: 'Fehlendes M4A-moov-Atom (Index fehlt)',
          description: 'Im MP4/M4A-Container fehlt das zentrale moov-Metadaten- & Index-Atom.',
          recommendedFix: 'Remuxing / Faststart durchführen oder Originaldatei prüfen.',
          autoFixable: true,
        });
      } else if (m4aMoovPosition === 'after_mdat') {
        seekTableValid = false;
        addFinding({
          code: 'm4a_moov_after_mdat',
          severity: 'warning',
          category: 'header',
          stage: 'fast',
          fixAction: 'remux_faststart',
          title: 'M4A-moov-Atom steht nach mdat (kein Faststart)',
          description: 'Der Container-Index (moov) befindet sich am Dateiende nach den Audiodaten (mdat). Browser müssen zum Abspielen/Spulen erst die gesamte Datei laden.',
          recommendedFix: 'Remuxing mit Faststart (-movflags +faststart) schiebt das moov-Atom an den Anfang.',
          autoFixable: true,
        });
      } else {
        seekTableValid = true;
      }
    } else if (fileExt === '.wav' || fileExt === '.aiff' || fileExt === '.aif' || fileExt === '.aifc') {
      if (buf.length >= 12) {
        const magic = buf.toString('ascii', 0, 4);
        if (magic === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
          const declaredSize = buf.readUInt32LE(4) + 8;
          if (Math.abs(declaredSize - buf.length) > 16) {
            addFinding({
              code: 'riff_size_mismatch',
              severity: 'warning',
              category: 'header',
              stage: 'fast',
              fixAction: 'remux_faststart',
              title: 'WAV RIFF-Größenheader weicht von Dateigröße ab',
              description: `Der RIFF-Header meldet ${declaredSize} Bytes, die Datei ist jedoch ${buf.length} Bytes groß.`,
              recommendedFix: 'Container / Chunk-Größen per Remuxing verlustfrei neu schreiben.',
              autoFixable: true,
            });
          }
        } else if (magic === 'FORM' && (buf.toString('ascii', 8, 12) === 'AIFF' || buf.toString('ascii', 8, 12) === 'AIFC')) {
          const declaredSize = buf.readUInt32BE(4) + 8;
          if (Math.abs(declaredSize - buf.length) > 16) {
            addFinding({
              code: 'aiff_size_mismatch',
              severity: 'warning',
              category: 'header',
              stage: 'fast',
              fixAction: 'remux_faststart',
              title: 'AIFF FORM-Größenheader weicht von Dateigröße ab',
              description: `Der FORM-Header meldet ${declaredSize} Bytes, die Datei ist jedoch ${buf.length} Bytes groß.`,
              recommendedFix: 'Container / Chunk-Größen per Remuxing verlustfrei neu schreiben.',
              autoFixable: true,
            });
          }
        }
      }
    }

    const fastDurationMs = Math.max(1, Date.now() - fastStartMs);

    // STUFE 2: DEEP-CHECK (Null-Decode auf Frame-CRC-Fehler, abgeschnittene Dateien, Seek-Integrität & MD5)
    let decodeErrorCount = 0;
    let streamCrcErrors = 0;
    let streamTruncated = false;
    let maxVolumeDb: number | null = null;
    let meanVolumeDb: number | null = null;
    let deepDurationMs = 0;

    if (deepScan) {
      const deepStartMs = Date.now();
      const useStrippedMp3Pipe =
        (codec === 'mp3' || codec === 'mp2' || fileExt === '.mp3' || fileExt === '.mp2') &&
        hasExtraTrailer &&
        audioEndOffset > 0 &&
        audioEndOffset < buf.length;
      const decodeStderr = useStrippedMp3Pipe
        ? await new Promise<string>((resolve) => {
            const chunks: Buffer[] = [];
            const child = spawn(
              '/usr/bin/ffmpeg',
              [
                '-hide_banner',
                '-v',
                'error',
                '-threads',
                String(effThreads),
                '-filter_threads',
                String(effThreads),
                '-err_detect',
                '+crccheck+bitstream',
                '-i',
                'pipe:0',
                '-map',
                '0:a:0',
                '-vn',
                '-f',
                'null',
                '-',
              ],
              { stdio: ['pipe', 'ignore', 'pipe'] }
            );
            const timer = setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch {
                // ignore
              }
              resolve(Buffer.concat(chunks).toString('utf8'));
            }, 60_000);
            child.stderr.on('data', (c: Buffer) => chunks.push(c));
            child.stdin.on('error', () => {
              // ignore EPIPE
            });
            child.on('error', () => {
              clearTimeout(timer);
              resolve(Buffer.concat(chunks).toString('utf8'));
            });
            child.on('close', () => {
              clearTimeout(timer);
              resolve(Buffer.concat(chunks).toString('utf8'));
            });
            child.stdin.end(buf.subarray(0, audioEndOffset));
          })
        : await new Promise<string>((resolve) => {
            execFile(
              '/usr/bin/ffmpeg',
              [
                '-hide_banner',
                '-v',
                'error',
                '-threads',
                String(effThreads),
                '-filter_threads',
                String(effThreads),
                '-err_detect',
                '+crccheck+bitstream',
                '-i',
                filePath,
                '-map',
                '0:a:0',
                '-vn',
                '-f',
                'null',
                '-',
              ],
              { timeout: 60_000 },
              (_err, _stdout, stderr) => resolve(stderr || '')
            );
          });
      const errLines = decodeStderr
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('Last message repeated'));
      decodeErrorCount = errLines.length;

      const crcLines = errLines.filter((l) => /\b(?:crc|checksum)\b|crc\s+mismatch/i.test(l));
      const truncLines = errLines.filter((l) =>
        /truncat|end of file|premature|unexpected eof|overread|incomplete|partial/i.test(l)
      );
      streamCrcErrors = crcLines.length;
      if (truncLines.length > 0) {
        streamTruncated = true;
      }

      if (streamCrcErrors > 0) {
        addFinding({
          code: 'stream_crc_errors',
          severity: 'critical',
          category: 'stream',
          stage: 'deep',
          fixAction: codec === 'flac' ? 'lossless_reencode' : 'remux_faststart',
          title: `${streamCrcErrors} Frame-CRC-Fehler beim Null-Decode erkannt`,
          description: `Decoder meldet Prüfsummenfehler in Audio-Frames: ${crcLines.slice(0, 2).join(' · ').slice(0, 160)}`,
          recommendedFix: codec === 'flac'
            ? 'Verlustfreies Re-Encoding über WAV (defekte Frames isolieren).'
            : 'Stream neu muxen und beschädigte Frames überspringen.',
          autoFixable: true,
        });
      }

      if (streamTruncated) {
        addFinding({
          code: 'stream_truncated_file',
          severity: 'critical',
          category: 'stream',
          stage: 'deep',
          fixAction: codec === 'flac' ? 'lossless_reencode' : 'remux_faststart',
          title: 'Abgeschnittener Audiostream / vorzeitiges Dateiende (EOF)',
          description: `Der Null-Decode endete vorzeitig: ${truncLines.slice(0, 2).join(' · ').slice(0, 160)}`,
          recommendedFix: 'Header-Längenangaben & Container durch Remuxing/Re-Encoding an reale Stream-Länge anpassen.',
          autoFixable: true,
        });
      }

      const otherErrCount = errLines.length - streamCrcErrors - truncLines.length;
      if (otherErrCount > 0 || (decodeErrorCount > 0 && streamCrcErrors === 0 && !streamTruncated)) {
        addFinding({
          code: 'ffmpeg_decode_errors',
          severity: 'critical',
          category: 'stream',
          stage: 'deep',
          fixAction: codec === 'flac' ? 'lossless_reencode' : 'remux_faststart',
          title: `${decodeErrorCount} Dekodierfehler im Audiostrom erkannt`,
          description: `Decoder-Meldung: ${errLines.slice(0, 2).join(' · ').slice(0, 180)}`,
          recommendedFix: 'Defekte Frames entfernen und Stream/Container sauber neu aufbauen.',
          autoFixable: true,
        });
      }

      // Header-Dauer vs. real dekodierte Sample-Länge + MD5-Prüfung (nur für natives FLAC erforderlich)
      const bytesPerSampleFrame = Math.max(
        1,
        (flacEffectiveBps <= 8 ? 1 : flacEffectiveBps <= 16 ? 2 : flacEffectiveBps <= 24 ? 3 : 4) *
          Math.max(1, flacEffectiveChannels)
      );
      let pcmAudit: { md5Hex: string | null; totalPcmBytes: number } = {
        md5Hex: null,
        totalPcmBytes: 0,
      };
      if ((flacStreaminfoMd5Hex || flacTotalSamplesHeader > 0n) && !flacIsOgg) {
        const pcmProbeFmt =
          flacEffectiveBps <= 8
            ? 's8'
            : flacEffectiveBps <= 16
            ? 's16le'
            : flacEffectiveBps <= 24
            ? 's24le'
            : 's32le';
        pcmAudit = await new Promise<{ md5Hex: string | null; totalPcmBytes: number }>((resolve) => {
          const hash = crypto.createHash('md5');
          let totalPcmBytes = 0;
          const child = spawn(
            '/usr/bin/ffmpeg',
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-threads',
              String(effThreads),
              '-filter_threads',
              String(effThreads),
              '-i',
              filePath,
              '-map',
              '0:a:0',
              '-vn',
              '-f',
              pcmProbeFmt,
              '-',
            ],
            { stdio: ['ignore', 'pipe', 'ignore'] }
          );
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
            resolve({ md5Hex: null, totalPcmBytes });
          }, 45_000);
          child.stdout.on('data', (chunk: Buffer) => {
            totalPcmBytes += chunk.length;
            hash.update(chunk);
          });
          child.on('error', () => {
            clearTimeout(timer);
            resolve({ md5Hex: null, totalPcmBytes });
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolve({
              md5Hex: code === 0 && totalPcmBytes > 0 ? hash.digest('hex') : null,
              totalPcmBytes,
            });
          });
        });
      }

      const actualDecodedSamples = Math.floor(pcmAudit.totalPcmBytes / bytesPerSampleFrame);
      if (
        !streamTruncated &&
        flacTotalSamplesHeader > 0n &&
        actualDecodedSamples > 0 &&
        Number(flacTotalSamplesHeader) - actualDecodedSamples > Math.max(flacEffectiveSr, Math.round(Number(flacTotalSamplesHeader) * 0.03))
      ) {
        streamTruncated = true;
        addFinding({
          code: 'stream_truncated_file',
          severity: 'critical',
          category: 'stream',
          stage: 'deep',
          fixAction: 'lossless_reencode',
          title: 'Abgeschnittene FLAC-Datei (real weniger Samples als in STREAMINFO)',
          description: `STREAMINFO erwartet ${flacTotalSamplesHeader.toString()} Samples, der Null-Decode lieferte nur ${actualDecodedSamples} Samples.`,
          recommendedFix: 'Verlustfreies Re-Encoding schreibt STREAMINFO & SEEKTABLE passend zur realen Stream-Länge.',
          autoFixable: true,
        });
      } else if (
        !streamTruncated &&
        hasXingHeader &&
        xingFrames > 20 &&
        actualFrames > 0 &&
        xingFrames - actualFrames > Math.max(10, Math.round(xingFrames * 0.05))
      ) {
        streamTruncated = true;
        addFinding({
          code: 'stream_truncated_file',
          severity: 'critical',
          category: 'stream',
          stage: 'deep',
          fixAction: 'vbr_header_rebuild',
          title: 'Abgeschnittene MP3-Datei (fehlen Frames gegenüber Xing-Header)',
          description: `Xing-Header deklariert ${xingFrames} Frames, im Stream sind jedoch nur ${actualFrames} Frames vorhanden.`,
          recommendedFix: 'VBR-Header-Rebuild korrigiert den Xing-Header auf die vorhandene Frame-Anzahl.',
          autoFixable: true,
        });
      }

      // Echte PCM-MD5-Verifikation gegen STREAMINFO bei nativem FLAC
      if (flacStreaminfoMd5Hex && !flacIsOgg && pcmAudit.md5Hex) {
        if (pcmAudit.md5Hex.toLowerCase() === flacStreaminfoMd5Hex.toLowerCase()) {
          flacMd5Valid = true;
          flacMd5Status = 'valid';
        } else {
          flacMd5Valid = false;
          flacMd5Status = 'mismatch';
          addFinding({
            code: 'flac_invalid_md5',
            severity: 'critical',
            category: 'header',
            stage: 'deep',
            fixAction: 'lossless_reencode',
            title: 'Ungültige FLAC-MD5-Signatur (Prüfsummen-Fehler)',
            description: `Die im STREAMINFO-Block gespeicherte MD5 (${flacStreaminfoMd5Hex.slice(0, 12)}…) stimmt nicht mit dem dekodierten Audio-PCM (${pcmAudit.md5Hex.slice(0, 12)}…) überein.`,
            recommendedFix: 'Verlustfreies Re-Encoding über 2-Schritt-WAV berechnet eine gültige MD5-Signatur.',
            autoFixable: true,
          });
        }
      }

      const volStderr = await new Promise<string>((resolve) => {
        execFile(
          '/usr/bin/ffmpeg',
          [
            '-hide_banner',
            '-threads',
            String(effThreads),
            '-filter_threads',
            String(effThreads),
            '-i',
            filePath,
            '-af',
            'volumedetect',
            '-f',
            'null',
            '-',
          ],
          { timeout: 60_000 },
          (_err, _stdout, stderr) => resolve(stderr || '')
        );
      });
      const maxMatch = volStderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
      const meanMatch = volStderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
      if (maxMatch) maxVolumeDb = Number(maxMatch[1]);
      if (meanMatch) meanVolumeDb = Number(meanMatch[1]);

      if (meanVolumeDb !== null && meanVolumeDb <= -70) {
        addFinding({
          code: 'audio_silence',
          severity: 'warning',
          category: 'audio',
          stage: 'deep',
          title: `Extrem niedriger Pegel / Stille (Ø ${meanVolumeDb.toFixed(1)} dB)`,
          description: 'Die Spur enthält fast ausschließlich digitale Stille oder einen abgebrochenen Audioinhalt.',
          recommendedFix: 'Titel manuell prüfen — Datei könnte leer sein.',
          autoFixable: false,
        });
      }
      deepDurationMs = Math.max(1, Date.now() - deepStartMs);
    }

    if (codec === 'flac' || fileExt === '.flac' || container.includes('flac')) {
      const hasFirefoxCrit = findings.some(
        (f) =>
          (f.severity === 'critical' &&
            (f.code.startsWith('flac_') ||
              f.code === 'ffmpeg_decode_errors' ||
              f.code === 'stream_crc_errors' ||
              f.code === 'stream_truncated_file')) ||
          f.code === 'flac_firefox_samplerate_too_high' ||
          f.code === 'flac_firefox_bitdepth_too_high' ||
          f.code === 'flac_firefox_multichannel'
      );
      const hasFirefoxWarn = findings.some(
        (f) => f.severity === 'warning' && f.code.startsWith('flac_')
      );
      flacFirefoxCompatible = hasFirefoxCrit
        ? 'incompatible'
        : hasFirefoxWarn
        ? 'warning'
        : 'compatible';
    }

    const fixActionOrder: RepairFixAction[] = [
      'header_strip',
      'vbr_header_rebuild',
      'remux_faststart',
      'cover_optimize',
      'lossless_reencode',
    ];
    const recommendedFixesSet = new Set<RepairFixAction>();
    for (const f of findings) {
      if (f.autoFixable && f.fixAction) {
        recommendedFixesSet.add(f.fixAction);
      }
    }
    const recommendedFixes = fixActionOrder.filter((act) => recommendedFixesSet.has(act));

    const fastFindings = findings.filter((f) => f.stage === 'fast' && f.severity !== 'info');
    const deepIntegrityFindings = findings.filter(
      (f) =>
        f.stage === 'deep' &&
        f.severity !== 'info' &&
        f.code !== 'audio_silence'
    );
    const stage2FailureReasons: string[] = [];
    if (streamCrcErrors > 0) stage2FailureReasons.push(`CRC:${streamCrcErrors}`);
    if (streamTruncated) stage2FailureReasons.push('Trunc:Ja');
    if (findings.some((f) => f.code === 'flac_invalid_md5')) {
      stage2FailureReasons.push('MD5-Fehler');
    }
    if (findings.some((f) => f.code === 'ffmpeg_decode_errors')) {
      stage2FailureReasons.push(`Decode-Fehler:${decodeErrorCount}`);
    }
    if (findings.some((f) => f.code === 'audio_silence')) {
      stage2FailureReasons.push('Stille');
    }

    const hasCritical = findings.some((f) => f.severity === 'critical');
    const hasWarning = findings.some((f) => f.severity === 'warning');
    const healthStatus: 'ok' | 'warning' | 'critical' = hasCritical
      ? 'critical'
      : hasWarning
      ? 'warning'
      : 'ok';

    return {
      healthStatus,
      findings,
      structure: {
        codec,
        container,
        detectedMagic,
        magicMatchesExtension,
        m4aMoovPosition,
        sampleRate: flacEffectiveSr,
        channels: flacEffectiveChannels,
        bitsPerSample: flacEffectiveBps,
        sampleFmt,
        channelLayout,
        bitrateKbps,
        durationSeconds,
        isVbr,
        hasXingHeader,
        xingFrames,
        actualFrames,
        id3v2Count,
        id3v2Versions,
        hasId3v1,
        hasApev2,
        leadingGarbageBytes,
        trailingGarbageBytes,
        corruptSyncGaps,
        flacMd5Valid,
        flacMd5Status,
        flacHasSeektable,
        seekTableValid,
        flacIsOgg,
        flacStreaminfoValid,
        flacSubsetValid,
        flacMinBlockSize,
        flacMaxBlockSize,
        flacVariableBlockSize,
        flacFirefoxCompatible,
        maxVolumeDb,
        meanVolumeDb,
        decodeErrorCount,
        streamCrcErrors,
        streamTruncated,
        hasCoverArt,
        coverArtMime,
        coverArtBytes,
        coverArtWidth,
        coverArtHeight,
        missingCoreTags,
        errorPositions: (() => {
          const fmtPosTime = (sec: number | null): string => {
            if (sec === null || sec < 0) return '';
            const m = Math.floor(sec / 60);
            const s = Math.floor(sec % 60);
            return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
          };
          const startCodes = new Set([
            'leading_garbage',
            'duplicate_id3v2',
            'id3v2_invalid_size',
            'flac_has_id3v2_prefix',
            'flac_missing_marker',
            'flac_invalid_streaminfo',
            'flac_ogg_container',
            'wrong_file_extension',
            'missing_xing_header',
            'xing_frame_mismatch',
            'xing_bytes_mismatch',
            'm4a_missing_moov',
            'wav_invalid_header',
            'aiff_invalid_header',
            'cover_art_oversized',
            'cover_art_resolution_exceeded',
            'cover_art_corrupt',
            'incomplete_tags',
            'flac_no_seektable',
            'flac_invalid_seektable',
            'flac_missing_md5',
            'no_mpeg_sync',
          ]);
          const endCodes = new Set([
            'trailing_garbage',
            'stream_truncated_file',
            'm4a_moov_after_mdat',
            'apev2_tag_present',
          ]);
          const out: Array<{
            zone: 'start' | 'stream' | 'end';
            ratio: number | null;
            severity: 'critical' | 'warning' | 'info';
            code: string;
            label: string;
            timeSeconds: number | null;
          }> = [];
          for (const f of findings) {
            if (f.code === 'corrupt_sync_gaps' && syncGapRatios.length > 0) {
              syncGapRatios.slice(0, 12).forEach((r, idxR) => {
                const clamped = Math.max(0.01, Math.min(0.99, r));
                const tSec = durationSeconds > 0 ? Math.round(clamped * durationSeconds) : null;
                const tTxt = tSec !== null ? ` ~${fmtPosTime(tSec)}` : '';
                out.push({
                  zone: 'stream',
                  ratio: Number(clamped.toFixed(4)),
                  severity: f.severity,
                  code: f.code,
                  label: `Sync-Lücke #${idxR + 1}${tTxt} (${Math.round(clamped * 100)} %)`,
                  timeSeconds: tSec,
                });
              });
              continue;
            }
            if (f.code === 'mixed_samplerate_frames' && mixedSrRatios.length > 0) {
              mixedSrRatios.slice(0, 4).forEach((r) => {
                const clamped = Math.max(0.01, Math.min(0.99, r));
                const tSec = durationSeconds > 0 ? Math.round(clamped * durationSeconds) : null;
                const tTxt = tSec !== null ? ` ~${fmtPosTime(tSec)}` : '';
                out.push({
                  zone: 'stream',
                  ratio: Number(clamped.toFixed(4)),
                  severity: f.severity,
                  code: f.code,
                  label: `Abtastraten-Wechsel${tTxt} (${Math.round(clamped * 100)} %)`,
                  timeSeconds: tSec,
                });
              });
              continue;
            }
            if (f.code === 'ffmpeg_decode_errors' || f.code === 'stream_crc_errors') {
              if (
                (trailingGarbageBytes > 16 || streamTruncated) &&
                syncGapRatios.length === 0 &&
                leadingGarbageBytes <= 4
              ) {
                out.push({
                  zone: 'end',
                  ratio: 1.0,
                  severity: f.severity,
                  code: f.code,
                  label: `${f.title} (Dateiende)`,
                  timeSeconds: durationSeconds > 0 ? durationSeconds : null,
                });
              } else if (
                leadingGarbageBytes > 4 &&
                syncGapRatios.length === 0 &&
                trailingGarbageBytes <= 16
              ) {
                out.push({
                  zone: 'start',
                  ratio: 0.0,
                  severity: f.severity,
                  code: f.code,
                  label: `${f.title} (Dateianfang)`,
                  timeSeconds: 0,
                });
              } else if (syncGapRatios.length > 0) {
                syncGapRatios.slice(0, 6).forEach((r) => {
                  const clamped = Math.max(0.01, Math.min(0.99, r));
                  const tSec = durationSeconds > 0 ? Math.round(clamped * durationSeconds) : null;
                  const tTxt = tSec !== null ? ` ~${fmtPosTime(tSec)}` : '';
                  out.push({
                    zone: 'stream',
                    ratio: Number(clamped.toFixed(4)),
                    severity: f.severity,
                    code: f.code,
                    label: `Dekodierfehler${tTxt} (${Math.round(clamped * 100)} %)`,
                    timeSeconds: tSec,
                  });
                });
              } else {
                out.push({
                  zone: 'stream',
                  ratio: null,
                  severity: f.severity,
                  code: f.code,
                  label: f.title,
                  timeSeconds: null,
                });
              }
              continue;
            }
            if (startCodes.has(f.code) || f.category === 'header' || f.category === 'tags') {
              out.push({
                zone: 'start',
                ratio: 0.0,
                severity: f.severity,
                code: f.code,
                label: f.title,
                timeSeconds: 0,
              });
            } else if (endCodes.has(f.code)) {
              out.push({
                zone: 'end',
                ratio: 1.0,
                severity: f.severity,
                code: f.code,
                label: f.title,
                timeSeconds: durationSeconds > 0 ? durationSeconds : null,
              });
            } else {
              out.push({
                zone: 'stream',
                ratio: null,
                severity: f.severity,
                code: f.code,
                label: f.title,
                timeSeconds: null,
              });
            }
          }
          return out;
        })(),
      },
      pipeline: {
        stage1FastCheck: {
          passed: fastFindings.length === 0,
          durationMs: fastDurationMs,
          issueCount: fastFindings.length,
          checksPerformed: [
            'Magic-Bytes vs. Dateiendung',
            'ID3v2/ID3v1/APEv2-Kette',
            'M4A moov-Position',
            'MP3 Xing/VBR-Header',
            'FLAC STREAMINFO & Subset-Regeln',
            'Cover-Art MIME & Größe',
          ],
        },
        stage2DeepCheck: {
          executed: deepScan,
          passed: deepScan ? deepIntegrityFindings.length === 0 : null,
          durationMs: deepDurationMs,
          crcErrorCount: streamCrcErrors,
          truncatedDetected: streamTruncated,
          seekTableValid,
          failureReasons: stage2FailureReasons,
        },
        recommendedFixes,
      },
    };
  };

  app.post(
    '/api/repair/analyze',
    express.raw({ type: 'application/octet-stream', limit: '250mb' }),
    async (req, res) => {
      const osMod = await import('os');
      const tmpDir = fs.mkdtempSync(path.join(osMod.tmpdir(), 'mintrip-analyze-'));
      try {
        const rawBody = req.body as Buffer;
        if (!rawBody || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
          res.status(400).json({ error: 'Keine Audiodatei zur Diagnose empfangen.' });
          return;
        }
        const sourceName = String(req.query.sourceName || req.headers['x-source-name'] || 'track.mp3');
        const deepScan = String(req.query.deepScan || 'true') !== 'false';
        const coverMaxDimension = Math.max(
          256,
          Math.min(8192, Math.round(Number(req.query.coverMaxDimension ?? 2048) || 2048))
        );
        const ffmpegThreadsRaw = Number(req.query.ffmpegThreads ?? 1);
        const ffmpegThreads = Number.isFinite(ffmpegThreadsRaw)
          ? Math.max(1, Math.min(16, Math.round(ffmpegThreadsRaw)))
          : 1;
        const extMatch = path.basename(sourceName).match(/\.([a-zA-Z0-9]+)$/);
        const fileExt = extMatch ? `.${extMatch[1].toLowerCase()}` : '.mp3';
        const inPath = path.join(tmpDir, `inspect${fileExt}`);
        fs.writeFileSync(inPath, rawBody);
        (req as { body?: unknown }).body = undefined;

        const result = await analyzeAudioFileForRepair(
          inPath,
          rawBody,
          fileExt,
          deepScan,
          coverMaxDimension,
          ffmpegThreads
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Diagnose fehlgeschlagen.',
        });
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  );

  const repairExtractedCoverCache = new Map<
    string,
    { buf: Buffer; mimeType: string; ext: string; createdAt: number }
  >();

  const pruneRepairCoverCache = () => {
    const now = Date.now();
    for (const [k, entry] of repairExtractedCoverCache.entries()) {
      if (now - entry.createdAt > 20 * 60 * 1000) {
        repairExtractedCoverCache.delete(k);
      }
    }
    while (repairExtractedCoverCache.size > 100) {
      const oldestKey = repairExtractedCoverCache.keys().next().value;
      if (!oldestKey) break;
      repairExtractedCoverCache.delete(oldestKey);
    }
  };

  app.get('/api/repair/cover/:token', (req, res) => {
    pruneRepairCoverCache();
    const token = String(req.params.token || '');
    const entry = repairExtractedCoverCache.get(token);
    if (!entry) {
      res.status(404).json({ error: 'Extrahiertes Coverbild nicht mehr im Zwischenspeicher.' });
      return;
    }
    res.setHeader('Content-Type', entry.mimeType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(entry.buf);
  });

  app.post(
    '/api/repair/fix',
    express.raw({ type: 'application/octet-stream', limit: '250mb' }),
    async (req, res) => {
      const osMod = await import('os');
      const tmpDir = fs.mkdtempSync(path.join(osMod.tmpdir(), 'mintrip-repair-'));
      try {
        const rawBody = req.body as Buffer;
        if (!rawBody || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
          res.status(400).json({ error: 'Keine Audiodatei zur Reparatur empfangen.' });
          return;
        }
        const sourceName = String(req.query.sourceName || req.headers['x-source-name'] || 'track.mp3');
        const extMatch = path.basename(sourceName).match(/\.([a-zA-Z0-9]+)$/);
        const fileExt = extMatch ? `.${extMatch[1].toLowerCase()}` : '.mp3';
        const inPath = path.join(tmpDir, `input${fileExt}`);
        const outPath = path.join(tmpDir, `repaired${fileExt}`);
        fs.writeFileSync(inPath, rawBody);

        const deepScan = String(req.query.deepScan || 'true') !== 'false';
        const fixVbrXing = String(req.query.fixVbrXing || 'true') !== 'false';
        const stripGarbageFrames = String(req.query.stripGarbageFrames || 'true') !== 'false';
        const cleanTags = String(req.query.cleanTags || 'true') !== 'false';
        const rebuildContainer = String(req.query.rebuildContainer || 'true') !== 'false';
        const writeFlacSeektable = String(req.query.writeFlacSeektable || 'true') !== 'false';
        const optimizeCover = String(req.query.optimizeCover || 'false') === 'true';
        const autoRepair = String(req.query.autoRepair || 'false') === 'true';
        const firefoxCompat = String(req.query.firefoxCompat || 'false') === 'true';
        const id3v2Version = String(req.query.id3v2Version || '4') === '3' ? '3' : '4';
        const coverMaxDimension = Math.max(
          256,
          Math.min(8192, Math.round(Number(req.query.coverMaxDimension ?? 2048) || 2048))
        );
        const ffmpegThreadsRaw = Number(req.query.ffmpegThreads ?? 1);
        const ffmpegThreads = Number.isFinite(ffmpegThreadsRaw)
          ? Math.max(1, Math.min(16, Math.round(ffmpegThreadsRaw)))
          : 1;

        const execFfmpeg = (ffmpegArgs: string[], failLabel: string) =>
          new Promise<void>((resolve, reject) => {
            execFile('/usr/bin/ffmpeg', ffmpegArgs, { timeout: 180_000 }, (err, _stdout, stderr) => {
              if (err) {
                reject(new Error(stderr?.trim() || err.message || failLabel));
                return;
              }
              resolve();
            });
          });

        const repairSteps: Array<{ step: string; status: 'ok' | 'skipped' | 'warning'; detail: string }> = [];

        const insertFlacSeektable = async (flacPath: string, fallbackSr: number): Promise<number> => {
          if (!fs.existsSync(flacPath)) return 0;
          const origBuf = fs.readFileSync(flacPath);
          if (origBuf.length < 42 || origBuf.toString('ascii', 0, 4) !== 'fLaC') {
            return 0;
          }
          let off = 4;
          let streaminfoPayload: Buffer | null = null;
          const otherBlocks: Array<{ blockType: number; payload: Buffer }> = [];
          while (off + 4 <= origBuf.length) {
            const hdr0 = origBuf[off];
            const isLast = (hdr0 & 0x80) !== 0;
            const bType = hdr0 & 0x7f;
            const bLen = (origBuf[off + 1] << 16) | (origBuf[off + 2] << 8) | origBuf[off + 3];
            const dataStart = off + 4;
            const dataEnd = dataStart + bLen;
            if (dataEnd > origBuf.length) return 0;
            const payload = origBuf.subarray(dataStart, dataEnd);
            if (bType === 0 && !streaminfoPayload && payload.length === 34) {
              streaminfoPayload = payload;
            } else if (bType !== 3) {
              otherBlocks.push({ blockType: bType, payload });
            }
            off = dataEnd;
            if (isLast) break;
          }
          if (!streaminfoPayload || off >= origBuf.length) return 0;
          const oldFirstAudioOff = off;
          const streamBytes = origBuf.length - oldFirstAudioOff;
          if (streamBytes <= 0) return 0;

          const siSampleRate =
            (streaminfoPayload[10] << 12) |
            (streaminfoPayload[11] << 4) |
            ((streaminfoPayload[12] >> 4) & 0x0f);
          const effSr = siSampleRate > 0 ? siSampleRate : Math.max(8000, fallbackSr || 44100);
          const totalSamplesHigh = BigInt(streaminfoPayload[13] & 0x0f);
          const totalSamplesLow = BigInt(streaminfoPayload.readUInt32BE(14));
          const totalSamplesHdr = (totalSamplesHigh << 32n) | totalSamplesLow;

          const probeJson = await new Promise<string>((resolve) => {
            execFile(
              '/usr/bin/ffprobe',
              [
                '-v', 'error',
                '-select_streams', 'a:0',
                '-show_entries', 'packet=pos,pts,duration',
                '-of', 'json',
                flacPath,
              ],
              { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
              (err, stdout) => {
                resolve(err ? '{}' : String(stdout || '{}'));
              }
            );
          });
          let packets: Array<{ pos?: string | number; pts?: number; duration?: number }> = [];
          try {
            const parsed = JSON.parse(probeJson) as { packets?: typeof packets };
            if (Array.isArray(parsed.packets)) packets = parsed.packets;
          } catch {
            packets = [];
          }
          if (packets.length === 0) return 0;

          const stepSamples = BigInt(Math.max(1, effSr * 10));
          let nextTarget = 0n;
          let prevSample = -1n;
          let prevRelOff = -1n;
          const points: Array<{ sample: bigint; relOff: bigint; frameSamples: number }> = [];

          for (const pkt of packets) {
            if (pkt.pos === undefined || pkt.pts === undefined) continue;
            const absPos = Number(pkt.pos);
            if (!Number.isFinite(absPos) || absPos < oldFirstAudioOff || absPos + 2 > origBuf.length) continue;
            // Echten FLAC-Frame-Sync-Code (0xFFF8 / 0xFFF9) verifizieren
            if (origBuf[Math.trunc(absPos)] !== 0xff || (origBuf[Math.trunc(absPos) + 1] & 0xfe) !== 0xf8) continue;
            const frameSamples = Math.max(0, Math.min(0xffff, Math.trunc(Number(pkt.duration || 0))));
            if (frameSamples <= 0) continue;
            const relOff = BigInt(Math.trunc(absPos) - oldFirstAudioOff);
            if (relOff >= BigInt(streamBytes)) continue;
            const sample = BigInt(Math.max(0, Math.trunc(Number(pkt.pts))));
            if (totalSamplesHdr > 0n && sample >= totalSamplesHdr) continue;
            if (sample < nextTarget && points.length > 0) continue;
            if (sample <= prevSample || relOff < prevRelOff) continue;
            points.push({ sample, relOff, frameSamples });
            prevSample = sample;
            prevRelOff = relOff;
            nextTarget = sample + stepSamples;
            if (points.length * 18 >= 15_000_000) break;
          }
          if (points.length === 0) return 0;

          const seekPayload = Buffer.alloc(points.length * 18);
          for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const base = i * 18;
            seekPayload.writeBigUInt64BE(p.sample, base);
            seekPayload.writeBigUInt64BE(p.relOff, base + 8);
            seekPayload.writeUInt16BE(p.frameSamples, base + 16);
          }

          const allBlocks: Array<{ blockType: number; payload: Buffer }> = [
            { blockType: 0, payload: streaminfoPayload },
            { blockType: 3, payload: seekPayload },
            ...otherBlocks,
          ];
          const chunks: Buffer[] = [Buffer.from('fLaC', 'ascii')];
          for (let i = 0; i < allBlocks.length; i++) {
            const blk = allBlocks[i];
            const isLastBlk = i === allBlocks.length - 1;
            const hdr = Buffer.alloc(4);
            hdr[0] = (isLastBlk ? 0x80 : 0x00) | (blk.blockType & 0x7f);
            hdr[1] = (blk.payload.length >> 16) & 0xff;
            hdr[2] = (blk.payload.length >> 8) & 0xff;
            hdr[3] = blk.payload.length & 0xff;
            chunks.push(hdr, blk.payload);
          }
          chunks.push(origBuf.subarray(oldFirstAudioOff));
          fs.writeFileSync(flacPath, Buffer.concat(chunks));
          return points.length;
        };

        const stripFlacSeektable = (flacPath: string): void => {
          if (!fs.existsSync(flacPath)) return;
          const origBuf = fs.readFileSync(flacPath);
          if (origBuf.length < 42 || origBuf.toString('ascii', 0, 4) !== 'fLaC') return;
          let off = 4;
          let streaminfoPayload: Buffer | null = null;
          let hadSeektable = false;
          const otherBlocks: Array<{ blockType: number; payload: Buffer }> = [];
          while (off + 4 <= origBuf.length) {
            const hdr0 = origBuf[off];
            const isLast = (hdr0 & 0x80) !== 0;
            const bType = hdr0 & 0x7f;
            const bLen = (origBuf[off + 1] << 16) | (origBuf[off + 2] << 8) | origBuf[off + 3];
            const dataStart = off + 4;
            const dataEnd = dataStart + bLen;
            if (dataEnd > origBuf.length) return;
            const payload = origBuf.subarray(dataStart, dataEnd);
            if (bType === 0 && !streaminfoPayload && payload.length === 34) {
              streaminfoPayload = payload;
            } else if (bType === 3) {
              hadSeektable = true;
            } else {
              otherBlocks.push({ blockType: bType, payload });
            }
            off = dataEnd;
            if (isLast) break;
          }
          if (!streaminfoPayload || !hadSeektable || off >= origBuf.length) return;
          const allBlocks: Array<{ blockType: number; payload: Buffer }> = [
            { blockType: 0, payload: streaminfoPayload },
            ...otherBlocks,
          ];
          const chunks: Buffer[] = [Buffer.from('fLaC', 'ascii')];
          for (let i = 0; i < allBlocks.length; i++) {
            const blk = allBlocks[i];
            const isLastBlk = i === allBlocks.length - 1;
            const hdr = Buffer.alloc(4);
            hdr[0] = (isLastBlk ? 0x80 : 0x00) | (blk.blockType & 0x7f);
            hdr[1] = (blk.payload.length >> 16) & 0xff;
            hdr[2] = (blk.payload.length >> 8) & 0xff;
            hdr[3] = blk.payload.length & 0xff;
            chunks.push(hdr, blk.payload);
          }
          chunks.push(origBuf.subarray(off));
          fs.writeFileSync(flacPath, Buffer.concat(chunks));
        };

        const preCheck = await analyzeAudioFileForRepair(
          inPath,
          rawBody,
          fileExt,
          deepScan,
          coverMaxDimension,
          ffmpegThreads
        );
        const modeLabel = autoRepair ? 'Auto-Repair' : 'Manuelle Pipeline';
        repairSteps.push({
          step: 'Vorab-Analyse',
          status: preCheck.healthStatus === 'ok' && preCheck.findings.length === 0 ? 'ok' : 'warning',
          detail: `${modeLabel} · Befunde: ${preCheck.findings.length} · Basis-Status: ${preCheck.healthStatus}`,
        });
        const recSet = new Set<RepairFixAction>(preCheck.pipeline.recommendedFixes);

        const doHeaderStrip = autoRepair ? recSet.has('header_strip') : (cleanTags || stripGarbageFrames);
        const doVbrRebuild = autoRepair ? recSet.has('vbr_header_rebuild') : fixVbrXing;
        const doRemuxFaststart = autoRepair ? recSet.has('remux_faststart') : rebuildContainer;
        const doCoverOptimize = (autoRepair ? recSet.has('cover_optimize') : optimizeCover) && preCheck.structure.hasCoverArt;
        const doLosslessReencode = autoRepair ? recSet.has('lossless_reencode') : (rebuildContainer || firefoxCompat);
        const hasStreamFrameErrors =
          (preCheck.structure.decodeErrorCount || 0) > 0 ||
          (preCheck.structure.streamCrcErrors || 0) > 0 ||
          Boolean(preCheck.structure.streamTruncated);
        const otherFlacRemuxReasons =
          preCheck.findings.some((f) => f.fixAction === 'remux_faststart' && f.code !== 'flac_no_seektable') ||
          !autoRepair;

        // Optional Cover-Art vorab optimieren:
        // - Wenn Breite/Höhe > coverMaxDimension: proportional auf coverMaxDimension × coverMaxDimension px skalieren
        // - Wenn Größe > 1 MB bei Maßen <= coverMaxDimension: Pixel-Dimensionen zwingend unverändert lassen und ≤ 1 MB komprimieren
        let optimizedCoverPath: string | null = null;
        if (doCoverOptimize) {
          const candidateCover = path.join(tmpDir, 'cover_opt.jpg');
          const covW = preCheck.structure.coverArtWidth || 0;
          const covH = preCheck.structure.coverArtHeight || 0;
          const needsScaleDown = covW > coverMaxDimension || covH > coverMaxDimension;
          const qualityLadder = [3, 5, 7, 9, 12, 16, 22, 28];
          let optSizeKb = 0;
          try {
            for (const qVal of qualityLadder) {
              const covArgs = [
                '-y', '-hide_banner', '-loglevel', 'error',
                '-threads', String(ffmpegThreads),
                '-filter_threads', String(ffmpegThreads),
                '-i', inPath,
                '-map', '0:v:0',
                ...(needsScaleDown
                  ? [
                      '-vf',
                      `scale='min(${coverMaxDimension},iw)':'min(${coverMaxDimension},ih)':force_original_aspect_ratio=decrease`,
                    ]
                  : []),
                '-vframes', '1',
                '-pix_fmt', 'yuvj420p',
                '-q:v', String(qVal),
                '-threads', String(ffmpegThreads),
                candidateCover,
              ];
              await execFfmpeg(covArgs, 'Cover-Optimierung fehlgeschlagen');
              if (fs.existsSync(candidateCover)) {
                const sz = fs.statSync(candidateCover).size;
                if (sz > 64) {
                  optimizedCoverPath = candidateCover;
                  optSizeKb = Math.round(sz / 1024);
                  if (sz <= 1024 * 1024) break;
                }
              }
            }
          } catch {
            optimizedCoverPath =
              fs.existsSync(candidateCover) && fs.statSync(candidateCover).size > 64
                ? candidateCover
                : null;
          }
          if (optimizedCoverPath) {
            const origKb = Math.round((preCheck.structure.coverArtBytes || 0) / 1024);
            repairSteps.push({
              step: 'Cover-Optimierung',
              status: 'ok',
              detail: needsScaleDown
                ? `${covW}×${covH} px (${origKb} KB) → max. ${coverMaxDimension}×${coverMaxDimension} px (${optSizeKb} KB)`
                : `Pixelmaße ${covW}×${covH} px erhalten · ${origKb} KB → ${optSizeKb} KB`,
            });
          } else {
            repairSteps.push({
              step: 'Cover-Optimierung',
              status: 'warning',
              detail: 'Kein optimiertes Cover erzeugt — Original-Cover beibehalten',
            });
          }
        }

        const effectiveInputFormatMismatch = !preCheck.structure.magicMatchesExtension;

        if (fileExt === '.flac') {
          if (effectiveInputFormatMismatch || doLosslessReencode || firefoxCompat || doCoverOptimize) {
            // Sauberer 2-Schritt-Neuaufbau (Quelle -> PCM WAV -> natives fLaC mit fester Blockgröße, STREAMINFO, MD5, SEEKTABLE & Vorbis-Tags)
            const midWav = path.join(tmpDir, 'repair_mid.wav');
            const origSr = preCheck.structure.sampleRate || 44100;
            let targetSr = origSr;
            const STANDARD_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000];
            // Surround-Downmix oder Sample-Rate-Reduktion NUR bei explizit aktivierter Firefox-Kompatibilität
            const needsFirefoxParams = firefoxCompat;
            if (needsFirefoxParams) {
              while (targetSr > 192000) {
                targetSr = Math.round(targetSr / 2);
              }
              if (!STANDARD_RATES.includes(targetSr)) {
                const candidatePool = [44100, 48000, 88200, 96000, 176400, 192000];
                targetSr = candidatePool.reduce((best, cand) =>
                  Math.abs(cand - targetSr) < Math.abs(best - targetSr) ? cand : best
                , 48000);
              }
            }
            const pcmCodec = preCheck.structure.bitsPerSample > 16 ? 'pcm_s24le' : 'pcm_s16le';
            const step1Args = [
              '-y', '-hide_banner', '-loglevel', 'error',
              '-threads', String(ffmpegThreads),
              '-filter_threads', String(ffmpegThreads),
              '-err_detect', 'ignore_err',
              '-i', inPath, '-map', '0:a:0', '-vn', '-map_metadata', '-1',
            ];
            if (needsFirefoxParams && (preCheck.structure.channels > 2 || (preCheck.structure.channelLayout && !['mono', 'stereo'].includes(preCheck.structure.channelLayout)))) {
              step1Args.push('-ac', preCheck.structure.channels === 1 ? '1' : '2');
            }
            if (needsFirefoxParams && targetSr !== origSr) {
              step1Args.push('-ar', String(targetSr));
            }
            step1Args.push('-c:a', pcmCodec, '-rf64', 'auto', '-threads', String(ffmpegThreads), midWav);
            await execFfmpeg(step1Args, 'FLAC-WAV-Reparatur fehlgeschlagen');

            const step2Args = optimizedCoverPath
              ? [
                  '-y', '-hide_banner', '-loglevel', 'error',
                  '-threads', String(ffmpegThreads),
                  '-filter_threads', String(ffmpegThreads),
                  '-i', midWav, '-i', inPath, '-i', optimizedCoverPath,
                  '-map', '0:a:0', '-map', '2:v:0', '-c:v', 'copy',
                  '-disposition:v:0', 'attached_pic',
                  '-map_metadata', '1', '-map_metadata', '1:s:a:0',
                  '-c:a', 'flac', '-compression_level', '6',
                  '-threads', String(ffmpegThreads),
                  outPath,
                ]
              : [
                  '-y', '-hide_banner', '-loglevel', 'error',
                  '-threads', String(ffmpegThreads),
                  '-filter_threads', String(ffmpegThreads),
                  '-i', midWav, '-i', inPath,
                  '-map', '0:a:0', '-map', '1:v?', '-c:v', 'copy',
                  '-map_metadata', '1', '-map_metadata', '1:s:a:0',
                  '-c:a', 'flac', '-compression_level', '6',
                  '-threads', String(ffmpegThreads),
                  outPath,
                ];
            await execFfmpeg(step2Args, 'FLAC-Header-Neuaufbau fehlgeschlagen');
            repairSteps.push({
              step: 'FLAC 2-Schritt-Neuaufbau',
              status: 'ok',
              detail: `PCM WAV → natives fLaC (${targetSr} Hz, ${preCheck.structure.bitsPerSample}-Bit, MD5 & STREAMINFO erneuert)`,
            });
            if (needsFirefoxParams) {
              repairSteps.push({
                step: 'Firefox-FLAC-Anpassung',
                status: 'ok',
                detail: `${origSr} Hz / ${preCheck.structure.channels}ch → ${targetSr} Hz / ${preCheck.structure.channels === 1 ? 1 : 2}ch`,
              });
            }
            if (writeFlacSeektable) {
              const spCount = await insertFlacSeektable(outPath, targetSr);
              repairSteps.push({
                step: 'FLAC-Seektable',
                status: spCount > 0 ? 'ok' : 'warning',
                detail: spCount > 0 ? `${spCount} Seekpoint(s) (10s) geschrieben` : 'Seektable konnte nicht ergänzt werden',
              });
            } else {
              stripFlacSeektable(outPath);
              repairSteps.push({
                step: 'FLAC-Seektable',
                status: 'skipped',
                detail: 'Durch Benutzeroption deaktiviert',
              });
            }
          } else if (
            doHeaderStrip ||
            (doRemuxFaststart && (otherFlacRemuxReasons || writeFlacSeektable)) ||
            (!autoRepair && writeFlacSeektable)
          ) {
            // Verlustfreier FLAC-Remux über FFmpeg bei ID3v2-Präfix oder Remux-Grund:
            // Entfernt illegale ID3v2-Präfixe sicher und migriert enthaltene Tags als Vorbis-Kommentare
            if (preCheck.structure.id3v2Count > 0 || (otherFlacRemuxReasons && (doHeaderStrip || doRemuxFaststart))) {
              await execFfmpeg(
                [
                  '-y', '-hide_banner', '-loglevel', 'error',
                  '-threads', String(ffmpegThreads),
                  '-filter_threads', String(ffmpegThreads),
                  '-i', inPath, '-map', '0:a:0', '-map', '0:v?', '-c:v', 'copy',
                  '-map_metadata', '0', '-c:a', 'flac', '-compression_level', '6',
                  '-threads', String(ffmpegThreads),
                  outPath,
                ],
                'FLAC-Remux fehlgeschlagen'
              );
              repairSteps.push({
                step: preCheck.structure.id3v2Count > 0 ? 'ID3-Header-Strip & FLAC-Remux' : 'FLAC-Remux',
                status: 'ok',
                detail:
                  preCheck.structure.id3v2Count > 0
                    ? 'ID3v2-Präfix entfernt, Tags als Vorbis-Kommentare & fLaC-Container sauber neu geschrieben'
                    : 'Container & Metadatenblöcke sauber neu geschrieben',
              });
            } else {
              fs.copyFileSync(inPath, outPath);
              repairSteps.push({
                step: 'FLAC-Stream-Erhalt',
                status: 'ok',
                detail: 'Audio-Frames & MD5 bit-identisch übernommen',
              });
            }
            if (writeFlacSeektable) {
              const spCount = await insertFlacSeektable(outPath, preCheck.structure.sampleRate || 44100);
              repairSteps.push({
                step: 'FLAC-Seektable',
                status: spCount > 0 ? 'ok' : 'warning',
                detail: spCount > 0 ? `${spCount} Seekpoint(s) (10s) in Header eingefügt` : 'Seektable konnte nicht ergänzt werden',
              });
            } else if (!otherFlacRemuxReasons && preCheck.structure.id3v2Count === 0) {
              stripFlacSeektable(outPath);
              repairSteps.push({
                step: 'FLAC-Seektable',
                status: 'skipped',
                detail: 'Durch Benutzeroption deaktiviert',
              });
            }
          } else {
            fs.copyFileSync(inPath, outPath);
            repairSteps.push({
              step: 'FLAC-Prüfung',
              status: 'skipped',
              detail: writeFlacSeektable ? 'Keine strukturelle Änderung erforderlich' : 'Seektable-Erzeugung durch Benutzer deaktiviert',
            });
          }
        } else if (fileExt === '.mp3' || fileExt === '.mp2') {
          let id3OffRep = 0;
          let id3CntRep = 0;
          while (
            id3OffRep + 10 <= rawBody.length &&
            rawBody[id3OffRep] === 0x49 &&
            rawBody[id3OffRep + 1] === 0x44 &&
            rawBody[id3OffRep + 2] === 0x33
          ) {
            const mv = rawBody[id3OffRep + 3];
            const rv = rawBody[id3OffRep + 4];
            const flB = rawBody[id3OffRep + 5];
            const b6 = rawBody[id3OffRep + 6];
            const b7 = rawBody[id3OffRep + 7];
            const b8 = rawBody[id3OffRep + 8];
            const b9 = rawBody[id3OffRep + 9];
            if (![2, 3, 4].includes(mv) || rv === 0xff || ((b6 | b7 | b8 | b9) & 0x80) !== 0) break;
            const tsz = (b6 << 21) | (b7 << 14) | (b8 << 7) | b9;
            const nextO = id3OffRep + 10 + tsz + ((flB & 0x10) !== 0 ? 10 : 0);
            if (nextO > rawBody.length) break;
            id3OffRep = nextO;
            id3CntRep++;
            if (id3CntRep > 6) break;
          }
          const { audioEnd: audioEndRep } = stripMpegTrailingTags(rawBody, id3OffRep);

          const needsFrameSlice =
            !effectiveInputFormatMismatch &&
            (preCheck.structure.leadingGarbageBytes > 4 ||
              preCheck.structure.trailingGarbageBytes > 0 ||
              preCheck.structure.corruptSyncGaps > 0 ||
              preCheck.structure.id3v2Count > 1 ||
              hasStreamFrameErrors ||
              doHeaderStrip);

          let slicedMpegPath: string | null = null;
          let slicedSkippedBytes = 0;
          if (needsFrameSlice) {
            const { cleanFrames, framesKept, bytesSkipped } = extractCleanMpegStream(
              rawBody,
              id3OffRep,
              audioEndRep
            );
            if (framesKept > 0 && cleanFrames.length > 128) {
              const candSlice = path.join(tmpDir, `clean_frames${fileExt}`);
              fs.writeFileSync(candSlice, cleanFrames);
              slicedMpegPath = candSlice;
              slicedSkippedBytes = bytesSkipped;
              if (bytesSkipped > 0 || preCheck.structure.id3v2Count > 1) {
                repairSteps.push({
                  step: 'Verlustfreier MPEG-Frame-Schnitt',
                  status: 'ok',
                  detail: `${framesKept} gültige Frames isoliert · ${bytesSkipped} Rest-/Müll-Bytes verlustfrei entfernt`,
                });
              }
            }
          }

          const runMp3Ffmpeg = async (reencode: boolean): Promise<void> => {
            const mp3Args: string[] = [
              '-y', '-hide_banner', '-loglevel', 'error',
              '-threads', String(ffmpegThreads),
              '-filter_threads', String(ffmpegThreads),
              '-err_detect', 'ignore_err',
            ];
            if (!reencode && slicedMpegPath) {
              mp3Args.push('-i', slicedMpegPath, '-i', inPath);
              if (optimizedCoverPath) {
                mp3Args.push(
                  '-i', optimizedCoverPath,
                  '-map', '0:a:0', '-map', '2:v:0', '-c:v', 'copy',
                  '-disposition:v:0', 'attached_pic',
                  '-map_metadata', '1'
                );
              } else {
                mp3Args.push('-map', '0:a:0', '-map', '1:v?', '-c:v', 'copy', '-map_metadata', '1');
              }
            } else {
              mp3Args.push('-i', inPath);
              if (optimizedCoverPath) {
                mp3Args.push(
                  '-i', optimizedCoverPath,
                  '-map', '0:a:0', '-map', '1:v:0', '-c:v', 'copy',
                  '-disposition:v:0', 'attached_pic',
                  '-map_metadata', '0'
                );
              } else {
                // Cover-Art immer erhalten (nie still mit -vn löschen!)
                mp3Args.push('-map', '0:a:0', '-map', '0:v?', '-c:v', 'copy', '-map_metadata', '0');
              }
            }

            if (reencode) {
              mp3Args.push('-c:a', fileExt === '.mp2' ? 'mp2' : 'libmp3lame', '-q:a', '0');
            } else {
              mp3Args.push('-c:a', 'copy');
            }
            if (fileExt === '.mp3' && (doVbrRebuild || doRemuxFaststart || Boolean(slicedMpegPath))) {
              mp3Args.push('-write_xing', '1');
            }
            if (doHeaderStrip || cleanTags || Boolean(slicedMpegPath)) {
              mp3Args.push('-id3v2_version', id3v2Version, '-write_id3v1', '1');
            }
            mp3Args.push('-threads', String(ffmpegThreads), outPath);
            await execFfmpeg(mp3Args, 'MP3-Reparatur fehlgeschlagen');
          };

          const countAudioDecodeErrors = async (testPath: string): Promise<number> => {
            const stderrTxt = await new Promise<string>((resolve) => {
              execFile(
                '/usr/bin/ffmpeg',
                [
                  '-hide_banner', '-v', 'error',
                  '-threads', String(ffmpegThreads),
                  '-filter_threads', String(ffmpegThreads),
                  '-err_detect', '+crccheck+bitstream',
                  '-i', testPath, '-map', '0:a:0', '-vn', '-f', 'null', '-',
                ],
                { timeout: 60_000 },
                (_err, _stdout, stderr) => resolve(stderr || '')
              );
            });
            return stderrTxt
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.length > 0 && !l.startsWith('Last message repeated')).length;
          };

          let willReencodeMp3 = false;
          if (effectiveInputFormatMismatch) {
            willReencodeMp3 = true;
            await runMp3Ffmpeg(true);
          } else {
            // Immer zuerst 100 % verlustfreien Stream-Remux versuchen (verhindert unnötigen Qualitätsverlust!)
            let losslessOk = true;
            try {
              await runMp3Ffmpeg(false);
            } catch {
              losslessOk = false;
            }
            const needsFallbackReencode =
              !losslessOk || (hasStreamFrameErrors && (await countAudioDecodeErrors(outPath)) > 0);
            if (
              needsFallbackReencode &&
              (doRemuxFaststart || doLosslessReencode || autoRepair || !losslessOk)
            ) {
              willReencodeMp3 = true;
              await runMp3Ffmpeg(true);
            }
          }

          repairSteps.push({
            step: willReencodeMp3 ? 'MP3 Stream-Neuaufbau' : 'MP3 Verlustfreier Header-/Container-Remux',
            status: 'ok',
            detail: [
              willReencodeMp3
                ? 'Frames fehlertolerant neu aufgebaut (-q:a 0)'
                : 'Audiostream 100 % verlustfrei kopiert (-c:a copy)',
              fileExt === '.mp3' && (doVbrRebuild || doRemuxFaststart || Boolean(slicedMpegPath))
                ? 'Xing/VBR-Header neu geschrieben'
                : '',
              doHeaderStrip || cleanTags || Boolean(slicedMpegPath)
                ? `ID3v2.${id3v2Version} + ID3v1`
                : '',
              !willReencodeMp3 && slicedSkippedBytes > 0 ? `${slicedSkippedBytes} Restbytes entfernt` : '',
            ].filter(Boolean).join(' · '),
          });
        } else {
          // WAV, AIFF, M4A, OGG, OPUS: Container/Faststart-Remux + Cover-Optimierung
          const supportsAttachedPic = fileExt === '.m4a';

          const runOtherFfmpeg = async (reencode: boolean): Promise<void> => {
            const remuxArgs: string[] = [
              '-y', '-hide_banner', '-loglevel', 'error',
              '-threads', String(ffmpegThreads),
              '-filter_threads', String(ffmpegThreads),
              '-err_detect', 'ignore_err',
              '-i', inPath,
            ];
            if (optimizedCoverPath && supportsAttachedPic) {
              remuxArgs.push(
                '-i', optimizedCoverPath,
                '-map', '0:a:0', '-map', '1:v:0', '-c:v', 'copy',
                '-disposition:v:0', 'attached_pic',
                '-map_metadata', '0'
              );
            } else if (supportsAttachedPic) {
              remuxArgs.push('-map', '0:a:0', '-map', '0:v?', '-c:v', 'copy', '-map_metadata', '0');
            } else {
              // WAV, AIFF, OGG, OPUS unterstützen keinen Video-/Cover-Stream im FFmpeg-Muxer
              remuxArgs.push('-map', '0:a:0', '-vn', '-map_metadata', '0');
            }

            if (reencode) {
              if (fileExt === '.wav') {
                const wavCodec =
                  preCheck.structure.bitsPerSample > 24
                    ? 'pcm_s32le'
                    : preCheck.structure.bitsPerSample > 16
                    ? 'pcm_s24le'
                    : 'pcm_s16le';
                remuxArgs.push('-c:a', wavCodec);
              } else if (fileExt === '.aiff' || fileExt === '.aif' || fileExt === '.aifc') {
                const aiffCodec =
                  preCheck.structure.bitsPerSample > 24
                    ? 'pcm_s32be'
                    : preCheck.structure.bitsPerSample > 16
                    ? 'pcm_s24be'
                    : 'pcm_s16be';
                remuxArgs.push('-c:a', aiffCodec);
              } else if (fileExt === '.m4a') {
                if (preCheck.structure.codec === 'alac') {
                  remuxArgs.push('-c:a', 'alac');
                } else {
                  remuxArgs.push('-c:a', 'aac', '-b:a', '256k');
                }
              } else if (fileExt === '.opus') {
                remuxArgs.push('-c:a', 'libopus', '-b:a', '192k');
              } else {
                remuxArgs.push('-c:a', 'libvorbis', '-b:a', '256k');
              }
            } else {
              remuxArgs.push('-c:a', 'copy');
            }

            if (fileExt === '.wav') {
              // FFmpeg WAV-Muxer unterstützt kein -write_id3v2, aber -rf64 auto für >4GB-Schutz
              remuxArgs.push('-rf64', 'auto');
            } else if (fileExt === '.aiff' || fileExt === '.aif' || fileExt === '.aifc') {
              remuxArgs.push('-write_id3v2', '1', '-id3v2_version', id3v2Version);
            } else if (fileExt === '.m4a' && (doRemuxFaststart || doCoverOptimize)) {
              remuxArgs.push('-movflags', '+faststart');
            }
            remuxArgs.push('-threads', String(ffmpegThreads), outPath);
            await execFfmpeg(remuxArgs, 'Container-Reparatur fehlgeschlagen');
          };

          let willReencodeOther = false;
          if (effectiveInputFormatMismatch) {
            willReencodeOther = true;
            await runOtherFfmpeg(true);
          } else {
            let losslessOk = true;
            try {
              await runOtherFfmpeg(false);
            } catch {
              losslessOk = false;
            }
            let needFb = !losslessOk;
            if (
              !needFb &&
              hasStreamFrameErrors &&
              (doRemuxFaststart || doLosslessReencode || autoRepair)
            ) {
              const stderrTxt = await new Promise<string>((resolve) => {
                execFile(
                  '/usr/bin/ffmpeg',
                  [
                    '-hide_banner', '-v', 'error',
                    '-threads', String(ffmpegThreads),
                    '-filter_threads', String(ffmpegThreads),
                    '-err_detect', '+crccheck+bitstream',
                    '-i', outPath, '-map', '0:a:0', '-vn', '-f', 'null', '-',
                  ],
                  { timeout: 60_000 },
                  (_err, _stdout, stderr) => resolve(stderr || '')
                );
              });
              needFb = stderrTxt
                .split('\n')
                .map((l) => l.trim())
                .some((l) => l.length > 0 && !l.startsWith('Last message repeated'));
            }
            if (needFb && (doRemuxFaststart || doLosslessReencode || autoRepair || !losslessOk)) {
              willReencodeOther = true;
              await runOtherFfmpeg(true);
            }
          }

          repairSteps.push({
            step: willReencodeOther ? 'Stream-Neuaufbau' : 'Container-/Header-Remux',
            status: 'ok',
            detail: [
              willReencodeOther ? 'Audiostrom neu kodiert' : 'Audiostrom verlustfrei kopiert',
              fileExt === '.m4a' && (doRemuxFaststart || doCoverOptimize) ? 'moov +faststart vor mdat' : '',
            ].filter(Boolean).join(' · '),
          });
        }

        if (!fs.existsSync(outPath)) {
          res.status(500).json({ error: 'Reparierte Datei konnte nicht erzeugt werden.' });
          return;
        }
        const repairedBuf = fs.readFileSync(outPath);
        const postCheck = await analyzeAudioFileForRepair(
          outPath,
          repairedBuf,
          fileExt,
          deepScan,
          coverMaxDimension,
          ffmpegThreads
        );
        const safetyErr = validateRepairedAudioOutput(
          repairedBuf,
          preCheck.findings,
          preCheck.structure,
          postCheck.findings,
          postCheck.structure
        );
        if (safetyErr) {
          res.status(422).json({ error: safetyErr });
          return;
        }
        const afterIssueCnt = postCheck.findings.filter((f) => f.severity !== 'info').length;
        repairSteps.push({
          step: `Nachprüfung (${deepScan ? 'Stufe 1+2' : 'Stufe 1'})`,
          status: afterIssueCnt === 0 ? 'ok' : 'warning',
          detail: `Status: ${postCheck.healthStatus} · Befunde: ${preCheck.findings.length} → ${postCheck.findings.length}${
            fileExt === '.flac' ? ` · Seektable: ${postCheck.structure.flacHasSeektable ? 'Ja' : 'Nein'}` : ''
          }`,
        });

        let coverArtDownload:
          | { token: string; ext: string; mimeType: string; sizeBytes: number }
          | undefined;
        if (postCheck.structure.hasCoverArt || (optimizedCoverPath && fs.existsSync(optimizedCoverPath))) {
          try {
            let covBuf: Buffer | null = null;
            let covExt = '.jpg';
            let covMime = 'image/jpeg';
            if (optimizedCoverPath && fs.existsSync(optimizedCoverPath)) {
              const cand = fs.readFileSync(optimizedCoverPath);
              if (cand.length > 64) {
                covBuf = cand;
              }
            }
            if (!covBuf) {
              const rawCovPath = path.join(tmpDir, 'extracted_cover.bin');
              await execFfmpeg(
                [
                  '-y', '-hide_banner', '-loglevel', 'error',
                  '-threads', String(ffmpegThreads),
                  '-filter_threads', String(ffmpegThreads),
                  '-i', outPath, '-map', '0:v:0', '-frames:v', '1',
                  '-c:v', 'copy', '-f', 'data', rawCovPath,
                ],
                'Cover-Extraktion fehlgeschlagen'
              );
              if (fs.existsSync(rawCovPath)) {
                const rawCov = fs.readFileSync(rawCovPath);
                if (rawCov.length > 64) {
                  if (
                    rawCov.length >= 8 &&
                    rawCov[0] === 0x89 &&
                    rawCov[1] === 0x50 &&
                    rawCov[2] === 0x4e &&
                    rawCov[3] === 0x47
                  ) {
                    covBuf = rawCov;
                    covExt = '.png';
                    covMime = 'image/png';
                  } else if (
                    rawCov.length >= 12 &&
                    rawCov.toString('ascii', 0, 4) === 'RIFF' &&
                    rawCov.toString('ascii', 8, 12) === 'WEBP'
                  ) {
                    covBuf = rawCov;
                    covExt = '.webp';
                    covMime = 'image/webp';
                  } else if (
                    rawCov.length >= 3 &&
                    rawCov[0] === 0xff &&
                    rawCov[1] === 0xd8 &&
                    rawCov[2] === 0xff
                  ) {
                    covBuf = rawCov;
                    covExt = '.jpg';
                    covMime = 'image/jpeg';
                  } else {
                    const fallbackJpg = path.join(tmpDir, 'extracted_cover.jpg');
                    await execFfmpeg(
                      [
                        '-y', '-hide_banner', '-loglevel', 'error',
                        '-threads', String(ffmpegThreads),
                        '-filter_threads', String(ffmpegThreads),
                        '-i', outPath, '-map', '0:v:0', '-frames:v', '1',
                        '-pix_fmt', 'yuvj420p', '-q:v', '3', '-threads', String(ffmpegThreads), fallbackJpg,
                      ],
                      'Cover-JPEG-Konvertierung fehlgeschlagen'
                    );
                    if (fs.existsSync(fallbackJpg)) {
                      const jpgBuf = fs.readFileSync(fallbackJpg);
                      if (jpgBuf.length > 64) {
                        covBuf = jpgBuf;
                        covExt = '.jpg';
                        covMime = 'image/jpeg';
                      }
                    }
                  }
                }
              }
            }
            if (covBuf && covBuf.length > 64) {
              pruneRepairCoverCache();
              const covToken = crypto.randomUUID();
              repairExtractedCoverCache.set(covToken, {
                buf: covBuf,
                mimeType: covMime,
                ext: covExt,
                createdAt: Date.now(),
              });
              coverArtDownload = {
                token: covToken,
                ext: covExt,
                mimeType: covMime,
                sizeBytes: covBuf.length,
              };
              repairSteps.push({
                step: 'Cover-Datei im Zielordner',
                status: 'ok',
                detail: `Eingebettetes Cover (${covExt.toUpperCase().slice(1)}, ${Math.max(1, Math.round(covBuf.length / 1024))} KB) für Export bereitgestellt`,
              });
            }
          } catch {
            // Optionales Cover nicht abbrechen lassen
          }
        }

        const repairedSummary = Buffer.from(
          JSON.stringify({
            beforeHealth: preCheck.healthStatus,
            beforeFindingCount: preCheck.findings.length,
            afterAnalysis: postCheck,
            repairSteps,
            coverArtDownload,
          }),
          'utf8'
        ).toString('base64');

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-MintRip-Repair-Summary', repairedSummary);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(sourceName))}`
        );
        res.send(repairedBuf);
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Audio-Reparatur fehlgeschlagen.',
        });
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  );

  // 3b. Optisches CD-Laufwerk: Schlitten-Status, Auswerfen/Schließen & Audio-CD-Streaming
  const simulatedTrayStateMap = new Map<string, boolean>();

  const sanitizeCdDevicePath = (raw: unknown): string => {
    const cleaned = String(raw || '').trim() || '/dev/cdrom';
    if (/^\/dev\/(?:cdrom\d*|sr\d+|dvd\d*)$/.test(cleaned)) {
      return cleaned;
    }
    return '/dev/cdrom';
  };

  const probeCdTrayStatus = async (
    devicePath: string
  ): Promise<{
    deviceExists: boolean;
    trayOpen: boolean;
    discPresent: boolean;
    reliable: boolean;
    status: 'open' | 'disc_ok' | 'no_disc' | 'not_ready' | 'closed' | 'unavailable';
  }> => {
    if (!fs.existsSync(devicePath)) {
      return {
        deviceExists: false,
        trayOpen: false,
        discPresent: false,
        reliable: false,
        status: 'unavailable',
      };
    }
    const probeScript = [
      'import ctypes, fcntl, json, os, sys',
      'dev = os.path.realpath(sys.argv[1])',
      'class SgIoHdr(ctypes.Structure):',
      '    _fields_ = [("interface_id", ctypes.c_int), ("dxfer_direction", ctypes.c_int), ("cmd_len", ctypes.c_ubyte), ("mx_sb_len", ctypes.c_ubyte), ("iovec_count", ctypes.c_ushort), ("dxfer_len", ctypes.c_uint), ("dxferp", ctypes.c_void_p), ("cmdp", ctypes.c_void_p), ("sbp", ctypes.c_void_p), ("timeout", ctypes.c_uint), ("flags", ctypes.c_uint), ("pack_id", ctypes.c_int), ("usr_ptr", ctypes.c_void_p), ("status", ctypes.c_ubyte), ("masked_status", ctypes.c_ubyte), ("msg_status", ctypes.c_ubyte), ("sb_len_wr", ctypes.c_ubyte), ("host_status", ctypes.c_ushort), ("driver_status", ctypes.c_ushort), ("resid", ctypes.c_int), ("duration", ctypes.c_uint), ("info", ctypes.c_uint)]',
      'def sg_cmd(fd, cdb_b, dlen=0):',
      '    try:',
      '        cdb = (ctypes.c_ubyte * len(cdb_b))(*cdb_b)',
      '        sb = (ctypes.c_ubyte * 32)()',
      '        buf = (ctypes.c_ubyte * dlen)() if dlen > 0 else None',
      '        hdr = SgIoHdr(ord("S"), -3 if dlen > 0 else -1, len(cdb_b), 32, 0, dlen, ctypes.addressof(buf) if buf is not None else 0, ctypes.addressof(cdb), ctypes.addressof(sb), 2500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)',
      '        fcntl.ioctl(fd, 0x2285, hdr)',
      '        alen = max(0, dlen - max(0, int(hdr.resid))) if dlen > 0 else 0',
      '        return True, int(hdr.status), int(hdr.host_status), int(hdr.driver_status), bytes(buf[:alen]) if buf is not None else b"", bytes(sb[:max(0, min(32, int(hdr.sb_len_wr)))])',
      '    except Exception:',
      '        return False, -1, -1, -1, b"", b""',
      'fd = os.open(dev, os.O_RDONLY | os.O_NONBLOCK)',
      'try:',
      '    code = 0',
      '    try:',
      '        code = int(fcntl.ioctl(fd, 0x5326, 0x7FFFFFFF))',
      '    except Exception:',
      '        try:',
      '            code = int(fcntl.ioctl(fd, 0x5326, 0))',
      '        except Exception:',
      '            code = 0',
      '    res = None',
      '    ok, st, hs, ds, data, _ = sg_cmd(fd, bytes([0x4A, 0x01, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x08, 0x00]), 8)',
      '    if ok and st == 0 and hs == 0 and ds == 0 and len(data) >= 6:',
      '        elen = (data[0] << 8) | data[1]',
      '        if (data[2] & 0x80) == 0 and (data[2] & 0x07) == 4 and elen >= 4:',
      '            door_open = bool(data[5] & 0x01)',
      '            disc = bool(data[5] & 0x02) and (not door_open)',
      '            res = {"trayOpen": door_open, "discPresent": disc, "reliable": True, "status": "open" if door_open else ("disc_ok" if disc else "no_disc")}',
      '    if res is None:',
      '        ok, st, hs, ds, data, _ = sg_cmd(fd, bytes([0xBD, 0, 0, 0, 0, 0, 0, 0, 0, 0x08, 0, 0]), 8)',
      '        if ok and st == 0 and hs == 0 and ds == 0 and len(data) >= 2:',
      '            door_open = bool(data[1] & 0x10)',
      '            disc = (not door_open) and (code == 4)',
      '            res = {"trayOpen": door_open, "discPresent": disc, "reliable": True, "status": "open" if door_open else ("disc_ok" if disc else "no_disc")}',
      '    if res is None:',
      '        ok, st, hs, ds, _, sb = sg_cmd(fd, bytes([0x00, 0, 0, 0, 0, 0]), 0)',
      '        if ok and hs == 0:',
      '            if st == 0 and ds == 0:',
      '                res = {"trayOpen": False, "discPresent": True, "reliable": True, "status": "disc_ok"}',
      '            elif len(sb) >= 4:',
      '                rc = sb[0] & 0x7F',
      '                sk, asc, ascq = (-1, -1, -1)',
      '                if rc in (0x70, 0x71) and len(sb) >= 14:',
      '                    sk, asc, ascq = sb[2] & 0x0F, sb[12], sb[13]',
      '                elif rc in (0x72, 0x73):',
      '                    sk, asc, ascq = sb[1] & 0x0F, sb[2], sb[3]',
      '                if sk == 0x02 and asc == 0x3A and ascq == 0x02:',
      '                    res = {"trayOpen": True, "discPresent": False, "reliable": True, "status": "open"}',
      '                elif sk == 0x02 and asc == 0x3A and ascq == 0x01:',
      '                    res = {"trayOpen": False, "discPresent": False, "reliable": True, "status": "no_disc"}',
      '    if res is None:',
      '        if code == 2:',
      '            res = {"trayOpen": True, "discPresent": False, "reliable": True, "status": "open"}',
      '        elif code == 4:',
      '            res = {"trayOpen": False, "discPresent": True, "reliable": True, "status": "disc_ok"}',
      '        elif code == 1:',
      '            res = {"trayOpen": False, "discPresent": False, "reliable": True, "status": "no_disc"}',
      '        elif code == 3:',
      '            res = {"trayOpen": False, "discPresent": False, "reliable": False, "status": "not_ready"}',
      '        else:',
      '            res = {"trayOpen": False, "discPresent": False, "reliable": False, "status": "closed"}',
      '    print(json.dumps(res))',
      'finally:',
      '    os.close(fd)',
    ].join('\n');

    try {
      const parsed = await new Promise<{
        trayOpen: boolean;
        discPresent: boolean;
        reliable: boolean;
        status: 'open' | 'disc_ok' | 'no_disc' | 'not_ready' | 'closed';
      }>((resolve, reject) => {
        execFile('python3', ['-B', '-c', probeScript, devicePath], { timeout: 3500 }, (err, stdout) => {
          if (err) return reject(err);
          try {
            const obj = JSON.parse(String(stdout || '').trim());
            resolve({
              trayOpen: Boolean(obj.trayOpen),
              discPresent: Boolean(obj.discPresent),
              reliable: Boolean(obj.reliable),
              status: obj.status || 'closed',
            });
          } catch (parseErr) {
            reject(parseErr);
          }
        });
      });
      return {
        deviceExists: true,
        trayOpen: parsed.trayOpen,
        discPresent: parsed.discPresent,
        reliable: parsed.reliable,
        status: parsed.status,
      };
    } catch {
      return {
        deviceExists: true,
        trayOpen: false,
        discPresent: false,
        reliable: false,
        status: 'closed',
      };
    }
  };

  app.get('/api/cd/tray-status', async (req, res) => {
    const device = sanitizeCdDevicePath(req.query.device);
    const probe = await probeCdTrayStatus(device);
    const trayOpen = probe.deviceExists
      ? probe.trayOpen
      : Boolean(simulatedTrayStateMap.get(device) || false);
    res.json({
      ok: true,
      device,
      hardware: probe.deviceExists,
      trayOpen,
      discPresent: probe.discPresent,
      reliable: probe.deviceExists ? probe.reliable : true,
      status: probe.status,
    });
  });

  app.post('/api/cd/tray', async (req, res) => {
    const device = sanitizeCdDevicePath(req.body?.device);
    const reqAction = String(req.body?.action || 'toggle').trim().toLowerCase();
    const clientTrayOpen = Boolean(req.body?.currentTrayOpen);
    const probe = await probeCdTrayStatus(device);

    if (!probe.deviceExists) {
      const prevOpen = simulatedTrayStateMap.has(device)
        ? Boolean(simulatedTrayStateMap.get(device))
        : clientTrayOpen;
      const nextOpen =
        reqAction === 'eject' ? true : reqAction === 'close' ? false : !prevOpen;
      simulatedTrayStateMap.set(device, nextOpen);
      res.json({
        ok: true,
        device,
        hardware: false,
        simulated: true,
        action: nextOpen ? 'eject' : 'close',
        trayOpen: nextOpen,
      });
      return;
    }

    const currentlyOpen = probe.reliable ? probe.trayOpen : clientTrayOpen;
    const targetAction: 'eject' | 'close' =
      reqAction === 'eject' ? 'eject' : reqAction === 'close' ? 'close' : currentlyOpen ? 'close' : 'eject';

    try {
      await new Promise<void>((resolve, reject) => {
        const args = targetAction === 'close' ? ['-t', device] : [device];
        execFile('eject', args, { timeout: 10000 }, (err) => {
          if (!err) return resolve();
          const ioctlCode = targetAction === 'close' ? '0x5319' : '0x5309';
          const unlockLine = targetAction === 'close' ? '' : ' try:\n  fcntl.ioctl(fd, 0x5329, 0)\n except Exception:\n  pass\n';
          execFile(
            'python3',
            [
              '-B',
              '-c',
              `import fcntl, os, sys; fd=os.open(os.path.realpath(sys.argv[1]), os.O_RDONLY|os.O_NONBLOCK)\ntry:\n${unlockLine} fcntl.ioctl(fd, ${ioctlCode}, 0)\nfinally:\n os.close(fd)`,
              device,
            ],
            { timeout: 10000 },
            (pyErr) => {
              if (pyErr) return reject(err);
              resolve();
            }
          );
        });
      });

      const expectedOpen = targetAction === 'eject';
      let probeAfter = await probeCdTrayStatus(device);
      for (let attempt = 0; attempt < 6; attempt++) {
        if (probeAfter.reliable && probeAfter.trayOpen === expectedOpen) {
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
        probeAfter = await probeCdTrayStatus(device);
      }
      const nextOpen = probeAfter.reliable ? probeAfter.trayOpen : expectedOpen;
      res.json({
        ok: true,
        device,
        hardware: true,
        simulated: false,
        action: targetAction,
        trayOpen: nextOpen,
        discPresent: probeAfter.discPresent,
        reliable: probeAfter.reliable,
        status: probeAfter.status,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'CD-Laufwerk konnte nicht gesteuert werden.',
      });
    }
  });

  const setCdDriveSpeed = async (devicePath: string, speed: number): Promise<void> => {
    if (!fs.existsSync(devicePath)) return;
    // Im Wiedergabemodus hart auf maximal 2x drosseln (0 = Auto/Max beim Zurücksetzen)
    const clampedSpeed = speed <= 0 ? 0 : Math.max(1, Math.min(2, Math.floor(speed)));
    const pyScript = [
      'import ctypes, fcntl, os, sys',
      'dev, spd = sys.argv[1], int(sys.argv[2])',
      'class SgIoHdr(ctypes.Structure):',
      '    _fields_ = [("interface_id", ctypes.c_int), ("dxfer_direction", ctypes.c_int), ("cmd_len", ctypes.c_ubyte), ("mx_sb_len", ctypes.c_ubyte), ("iovec_count", ctypes.c_ushort), ("dxfer_len", ctypes.c_uint), ("dxferp", ctypes.c_void_p), ("cmdp", ctypes.c_void_p), ("sbp", ctypes.c_void_p), ("timeout", ctypes.c_uint), ("flags", ctypes.c_uint), ("pack_id", ctypes.c_int), ("usr_ptr", ctypes.c_void_p), ("status", ctypes.c_ubyte), ("masked_status", ctypes.c_ubyte), ("msg_status", ctypes.c_ubyte), ("sb_len_wr", ctypes.c_ubyte), ("host_status", ctypes.c_ushort), ("driver_status", ctypes.c_ushort), ("resid", ctypes.c_int), ("duration", ctypes.c_uint), ("info", ctypes.c_uint)]',
      'fd = os.open(dev, os.O_RDONLY | os.O_NONBLOCK)',
      'try:',
      '    try: fcntl.ioctl(fd, 0x5322, spd)',
      '    except Exception: pass',
      '    kbps = 0xFFFF if spd <= 0 else spd * 176',
      '    cdb = (ctypes.c_ubyte * 12)(0xBB, 0, (kbps >> 8) & 0xFF, kbps & 0xFF, 0xFF, 0xFF, 0, 0, 0, 0, 0, 0)',
      '    sb = (ctypes.c_ubyte * 32)()',
      '    hdr = SgIoHdr(interface_id=ord("S"), dxfer_direction=-1, cmd_len=12, mx_sb_len=32, cmdp=ctypes.addressof(cdb), sbp=ctypes.addressof(sb), timeout=3000)',
      '    try: fcntl.ioctl(fd, 0x2285, hdr)',
      '    except Exception: pass',
      'finally:',
      '    os.close(fd)',
    ].join('\n');
    await new Promise<void>((resolve) => {
      execFile('python3', ['-B', '-c', pyScript, devicePath, String(clampedSpeed)], { timeout: 2500 }, (ioctlErr) => {
        if (!ioctlErr) {
          resolve();
          return;
        }
        execFile('eject', ['-x', String(clampedSpeed), devicePath], { timeout: 2000 }, () => {
          resolve();
        });
      });
    });
  };

  const patchCdWavHeader = (buf: Buffer, expectedPcmBytes: number): Buffer => {
    if (expectedPcmBytes <= 0 || buf.length < 44) return buf;
    if (
      buf.toString('ascii', 0, 4) !== 'RIFF' ||
      buf.toString('ascii', 8, 12) !== 'WAVE' ||
      buf.toString('ascii', 36, 40) !== 'data'
    ) {
      return buf;
    }
    const maxData = 0x7fffffd0;
    const safeDataSize = Math.min(maxData, Math.max(0, Math.floor(expectedPcmBytes) & ~3));
    const safeRiffSize = safeDataSize + 36;
    const patched = Buffer.from(buf);
    patched.writeUInt32LE(safeRiffSize >>> 0, 4);
    patched.writeUInt32LE(safeDataSize >>> 0, 40);
    return patched;
  };

  app.get('/api/cd/stream', async (req, res) => {
    const device = sanitizeCdDevicePath(req.query.device);
    const trackNum = Math.floor(Number(req.query.track || 0));
    const reqSectors = Math.max(0, Math.floor(Number(req.query.sectors || 0)));
    const reqDuration = Math.max(0, Number(req.query.duration || 0));
    if (!Number.isFinite(trackNum) || trackNum < 1 || trackNum > 99) {
      res.status(400).json({ error: 'Ungültige Track-Nummer.' });
      return;
    }
    if (!fs.existsSync(device)) {
      res.status(404).json({ error: `Kein physisches CD-Laufwerk unter ${device} gefunden.` });
      return;
    }

    let realDev = device;
    try {
      realDev = fs.realpathSync(device);
    } catch {
      realDev = device;
    }

    // 44.1 kHz Stereo 16-Bit = 176.400 Bytes/Sekunde (1 CD-Sektor = 2.352 Bytes)
    const PCM_BYTES_PER_SEC = 176400;
    const PREBUFFER_BYTES = PCM_BYTES_PER_SEC * 2; // ~2.0s Anlauf-Puffer (~1s Füllzeit bei 2x)
    const HIGH_WATER_BYTES = Math.round(PCM_BYTES_PER_SEC * 4.5); // ~4.5s Max-Lookahead
    const LOW_WATER_BYTES = Math.round(PCM_BYTES_PER_SEC * 2.5); // ~2.5s Nachlade-Schwelle
    const WRITE_SLICE_BYTES = 16384;
    // Sanfte Leserate nach Pre-Buffer (~1.20x..1.85x), verhindert Bursts & Spin-Up auf Max-Speed
    const REFILL_PACE_LOW_BYTES_PER_SEC = Math.round(PCM_BYTES_PER_SEC * 1.2);
    const REFILL_PACE_CATCHUP_BYTES_PER_SEC = Math.round(PCM_BYTES_PER_SEC * 1.85);
    const SPEED_GUARD_INTERVAL_MS = 2500;

    const expectedPcmBytes =
      reqSectors > 0 ? reqSectors * 2352 : reqDuration > 0 ? Math.round(reqDuration * PCM_BYTES_PER_SEC) : 0;

    // CD-Laufwerk im Play-Modus hart auf maximal 2x-Geschwindigkeit begrenzen (~352 KiB/s)
    const PLAYBACK_SPEED = 2;
    await setCdDriveSpeed(realDev, PLAYBACK_SPEED);

    let closedByClient = false;
    let activeChild: ReturnType<typeof spawn> | null = null;
    let headersSent = false;
    let speedRestored = false;
    let postSpinupRelocked = false;
    let speedApplyInFlight = false;
    let pendingChunks: Buffer[] = [];
    let queuedBytes = 0;
    let prebuffering = true;
    let headerPatched = false;
    let headerCollect = Buffer.alloc(0);
    let drainScheduled = false;
    let flushing = false;
    let childEnded = false;
    let pacePaused = false;
    let paceTimer: ReturnType<typeof setTimeout> | null = null;
    let speedGuardTimer: ReturnType<typeof setInterval> | null = null;
    let paceWindowStartedAt = 0;
    let paceWindowBytes = 0;

    const enforceSpeedCapAsync = () => {
      if (closedByClient || speedRestored || childEnded || speedApplyInFlight) return;
      speedApplyInFlight = true;
      void setCdDriveSpeed(realDev, PLAYBACK_SPEED).finally(() => {
        speedApplyInFlight = false;
      });
    };

    speedGuardTimer = setInterval(() => {
      enforceSpeedCapAsync();
    }, SPEED_GUARD_INTERVAL_MS);

    const stopTimers = () => {
      if (speedGuardTimer) {
        clearInterval(speedGuardTimer);
        speedGuardTimer = null;
      }
      if (paceTimer) {
        clearTimeout(paceTimer);
        paceTimer = null;
      }
    };

    const restoreSpeedOnce = () => {
      stopTimers();
      if (speedRestored) return;
      speedRestored = true;
      void setCdDriveSpeed(realDev, 0);
    };

    const cleanup = () => {
      closedByClient = true;
      stopTimers();
      pendingChunks = [];
      queuedBytes = 0;
      if (activeChild && !activeChild.killed) {
        try {
          activeChild.kill('SIGTERM');
        } catch {
          // Ignorieren
        }
      }
      restoreSpeedOnce();
    };
    req.on('close', cleanup);

    const ensureHeaders = () => {
      if (headersSent || closedByClient || res.headersSent) return;
      headersSent = true;
      res.status(200);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    };

    const maybeResumeUpstream = () => {
      if (closedByClient || childEnded || !activeChild?.stdout) return;
      if (!drainScheduled && !pacePaused && queuedBytes < HIGH_WATER_BYTES) {
        try {
          activeChild.stdout.resume();
        } catch {
          // Ignorieren
        }
      }
    };

    const flushQueue = () => {
      if (flushing || closedByClient || prebuffering) return;
      flushing = true;
      try {
        ensureHeaders();
        while (pendingChunks.length > 0 && !closedByClient && !res.writableEnded) {
          const head = pendingChunks[0];
          const slice =
            head.length > WRITE_SLICE_BYTES ? head.subarray(0, WRITE_SLICE_BYTES) : head;
          if (head.length > WRITE_SLICE_BYTES) {
            pendingChunks[0] = head.subarray(WRITE_SLICE_BYTES);
          } else {
            pendingChunks.shift();
          }
          queuedBytes = Math.max(0, queuedBytes - slice.length);
          const ok = res.write(slice);
          if (!ok) {
            drainScheduled = true;
            try {
              activeChild?.stdout?.pause();
            } catch {
              // Ignorieren
            }
            res.once('drain', () => {
              drainScheduled = false;
              maybeResumeUpstream();
              flushQueue();
            });
            return;
          }
        }
        maybeResumeUpstream();
        if (childEnded && pendingChunks.length === 0 && !res.writableEnded) {
          restoreSpeedOnce();
          res.end();
        }
      } finally {
        flushing = false;
      }
    };

    const applyRefillPacing = (chunkLen: number) => {
      if (closedByClient || childEnded || prebuffering || !activeChild?.stdout) return;
      if (queuedBytes >= HIGH_WATER_BYTES) {
        try {
          activeChild.stdout.pause();
        } catch {
          // Ignorieren
        }
        return;
      }

      const now = Date.now();
      if (paceWindowStartedAt === 0 || now - paceWindowStartedAt > 1200) {
        paceWindowStartedAt = now;
        paceWindowBytes = 0;
      }
      paceWindowBytes += chunkLen;

      const targetRate =
        queuedBytes <= LOW_WATER_BYTES
          ? REFILL_PACE_CATCHUP_BYTES_PER_SEC
          : REFILL_PACE_LOW_BYTES_PER_SEC;
      const expectedElapsedMs = (paceWindowBytes / targetRate) * 1000;
      const actualElapsedMs = now - paceWindowStartedAt;
      const delayMs = Math.round(expectedElapsedMs - actualElapsedMs);

      if (delayMs >= 18 && !pacePaused) {
        pacePaused = true;
        try {
          activeChild.stdout.pause();
        } catch {
          // Ignorieren
        }
        paceTimer = setTimeout(() => {
          paceTimer = null;
          pacePaused = false;
          maybeResumeUpstream();
        }, Math.min(220, delayMs));
      }
    };

    const enqueueChunk = (rawChunk: Buffer) => {
      if (closedByClient || rawChunk.length === 0) return;
      // Sobald die ersten Audio-Daten eintreffen (Spin-Up abgeschlossen), 2x-Limit sofort erneut sperren
      if (!postSpinupRelocked) {
        postSpinupRelocked = true;
        enforceSpeedCapAsync();
      }

      let chunk = rawChunk;
      if (!headerPatched) {
        headerCollect = Buffer.concat([headerCollect, chunk]);
        if (headerCollect.length < 44) {
          return;
        }
        headerPatched = true;
        chunk = patchCdWavHeader(headerCollect, expectedPcmBytes);
        headerCollect = Buffer.alloc(0);
      }

      pendingChunks.push(chunk);
      queuedBytes += chunk.length;

      if (prebuffering && queuedBytes >= PREBUFFER_BYTES) {
        prebuffering = false;
        paceWindowStartedAt = Date.now();
        paceWindowBytes = 0;
        flushQueue();
      } else if (!prebuffering && !drainScheduled) {
        flushQueue();
      }

      if (queuedBytes >= HIGH_WATER_BYTES && activeChild?.stdout) {
        try {
          activeChild.stdout.pause();
        } catch {
          // Ignorieren
        }
      } else if (!prebuffering) {
        applyRefillPacing(chunk.length);
      }
    };

    const startCdparanoia = (args: string[], allowFallbackArgs: string[] | null) => {
      if (closedByClient) {
        restoreSpeedOnce();
        return;
      }
      let errText = '';
      let producedAudio = false;
      const child = spawn('cdparanoia', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      activeChild = child;

      child.stderr?.on('data', (chunk) => {
        if (errText.length < 512) {
          errText += chunk.toString('utf8');
        }
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        if (closedByClient) return;
        producedAudio = true;
        enqueueChunk(chunk);
      });

      child.on('error', (err) => {
        restoreSpeedOnce();
        if (!headersSent && !res.headersSent && !closedByClient) {
          res.status(404).json({ error: `cdparanoia nicht verfügbar (${err.message}).` });
        } else if (!res.writableEnded) {
          res.end();
        }
      });

      child.on('close', (code) => {
        if (closedByClient) {
          restoreSpeedOnce();
          return;
        }
        // Falls Laufwerk `-S 2` ablehnt, bevor PCM ausgegeben wurde -> Fallback ohne `-S` (mit aktivem IOCTL-Speed-Guard)
        if (!producedAudio && allowFallbackArgs && (code ?? 0) !== 0) {
          headerCollect = Buffer.alloc(0);
          headerPatched = false;
          postSpinupRelocked = false;
          startCdparanoia(allowFallbackArgs, null);
          return;
        }

        childEnded = true;
        if (headerCollect.length > 0) {
          pendingChunks.push(headerCollect);
          queuedBytes += headerCollect.length;
          headerCollect = Buffer.alloc(0);
          headerPatched = true;
        }

        if (producedAudio || queuedBytes > 0) {
          prebuffering = false;
          flushQueue();
          stopTimers();
          return;
        }

        restoreSpeedOnce();
        if (!headersSent && !res.headersSent) {
          res.status(404).json({
            error: errText.trim() || `CD-Track ${trackNum} konnte nicht gelesen werden (Exit ${code ?? -1}).`,
          });
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    };

    // `-Z` deaktiviert rückwärts springende Paranoia-Überlappungsprüfungen beim Echtzeit-Vorhören;
    // `-S 2` drosselt das optische Laufwerk hart auf maximal 2x-Lesegeschwindigkeit (~352 KiB/s).
    startCdparanoia(
      ['-d', realDev, '-S', String(PLAYBACK_SPEED), '-Z', '-q', String(trackNum), '-'],
      ['-d', realDev, '-Z', '-q', String(trackNum), '-']
    );
  });

  // 4. Live-Quellcode der Linux Mint Python/GTK4 Anwendung ausliefern
  app.get('/api/python-project/files', (_req, res) => {
    const files = collectProjectFiles(PYTHON_PROJECT_DIR, PYTHON_PROJECT_DIR);
    res.json({ files });
  });

  // 5. Komplettes Linux Mint Python-Projekt als ZIP-Archiv herunterladen
  app.get('/api/python-project/download', async (_req, res) => {
    try {
      const files = collectProjectFiles(PYTHON_PROJECT_DIR, PYTHON_PROJECT_DIR);
      const zip = new JSZip();
      const rootFolder = zip.folder('mintrip-linux-mint');
      for (const file of files) {
        rootFolder?.file(file.path, file.content);
      }
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="mintrip-linux-mint.zip"');
      res.send(zipBuffer);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'ZIP-Erstellung fehlgeschlagen.',
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa',
    });
    app.get('/@vite/client', async (_req, res, next) => {
      try {
        const result = await vite.transformRequest('/@vite/client');
        if (!result?.code) return next();
        const patched = result.code.replace(
          /transport\.connect\(createHMRHandler\([^)]*\)\);/g,
          '/* HMR WebSocket disabled in middlewareMode */'
        );
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.send(patched);
      } catch (err) {
        next(err);
      }
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MintRip Studio server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
