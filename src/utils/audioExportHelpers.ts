import { AlbumMetadata, DEFAULT_MODULE_OUTPUT_DIRS, ExportSettings, TrackMetadata } from '../types/mintrip';

export function formatIndexNumber(value: number, total = 0): string {
  const safeVal = Math.max(0, Math.round(value));
  const safeTotal = Math.max(0, Math.round(total));
  const width = safeTotal >= 100 || safeVal >= 100 ? 3 : 2;
  return String(safeVal).padStart(width, '0');
}

export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

const MULTI_ARTIST_BRACKET_RE =
  /\s*[(\[]\s*(?:feat(?:uring)?|ft|vs|versus|v\.|pres(?:ents|enting)?|präsentiert|praesentiert)(?:\.\s*|\s+)([^)\]]+?)[)\]]/gi;

const MULTI_ARTIST_JOIN_RE =
  /(?:\s*[,;&]?\s+)(?:(?:feat(?:uring)?|ft|vs|versus|pres(?:ents|enting)?|präsentiert|praesentiert)(?:\.\s*|\s+)|v\.\s*)/gi;

export function splitMultiValue(value?: string | string[] | null): string[] {
  const raw: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const txt = String(entry || '').trim();
      if (!txt) continue;
      if (txt.includes(';')) {
        raw.push(...txt.split(';').map((s) => s.trim()).filter(Boolean));
      } else {
        raw.push(txt);
      }
    }
  } else if (value) {
    const txt = String(value).trim();
    if (txt.includes(';')) {
      raw.push(...txt.split(';').map((s) => s.trim()).filter(Boolean));
    } else if (txt) {
      raw.push(txt);
    }
  }
  const dedup: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!seen.has(item)) {
      seen.add(item);
      dedup.push(item);
    }
  }
  return dedup;
}

export function mergeMultiValues(...sources: Array<string | string[] | undefined | null>): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    for (const item of splitMultiValue(src)) {
      if (!seen.has(item)) {
        seen.add(item);
        merged.push(item);
      }
    }
  }
  return merged;
}

export function normalizeMultiArtist(value: string): string {
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

const PROTECTED_BAND_PATTERNS: RegExp[] = [
  /\bEarth,\s*Wind\s+(?:&|and)\s+Fire\b/gi,
  /\bCrosby,\s*Stills,\s*Nash\s+(?:&|and)\s+Young\b/gi,
  /\bCrosby,\s*Stills\s+(?:&|and)\s+Nash\b/gi,
  /\bCrosby\s+(?:&|and)\s+Nash\b/gi,
  /\bEmerson,\s*Lake\s+(?:&|and)\s+Palmer\b/gi,
  /\bBlood,\s*Sweat\s+(?:&|and)\s+Tears\b/gi,
  /\bPeter,\s*Paul\s+(?:&|and)\s+Mary\b/gi,
  /\bSimon\s+(?:&|and)\s+Garfunkel\b/gi,
  /\b(?:Daryl\s+)?Hall\s+(?:&|and)\s+(?:John\s+)?Oates\b/gi,
  /\bKool\s+(?:&|and)\s+the\s+Gang\b/gi,
  /\bSly\s+(?:&|and)\s+the\s+Family\s+Stone\b/gi,
  /\bTom\s+Petty\s+(?:&|and)\s+the\s+Heartbreakers\b/gi,
  /\bBruce\s+Springsteen\s+(?:&|and)\s+the\s+E\s+Street\s+Band\b/gi,
  /\bBob\s+Marley\s+(?:&|and)\s+the\s+Wailers\b/gi,
  /\bNick\s+Cave\s+(?:&|and)\s+the\s+Bad\s+Seeds\b/gi,
  /\bHuey\s+Lewis\s+(?:&|and)\s+the\s+News\b/gi,
  /\bGladys\s+Knight\s+(?:&|and)\s+the\s+Pips\b/gi,
  /\bMartha\s+(?:&|and)\s+the\s+Vandellas\b/gi,
  /\bSmokey\s+Robinson\s+(?:&|and)\s+the\s+Miracles\b/gi,
  /\bJoan\s+Jett\s+(?:&|and)\s+the\s+Blackhearts\b/gi,
  /\bEcho\s+(?:&|and)\s+the\s+Bunnymen\b/gi,
  /\bSiouxsie\s+(?:&|and)\s+the\s+Banshees\b/gi,
  /\bFlorence\s*(?:\+|&|and)\s*the\s+Machine\b/gi,
  /\bDerek\s+(?:&|and)\s+the\s+Dominos\b/gi,
  /\bThe\s+Mamas\s+(?:&|and)\s+the\s+Papas\b/gi,
  /\bCaptain\s+(?:&|and)\s+Tennille\b/gi,
  /\bSonny\s+(?:&|and)\s+Cher\b/gi,
  /\bIke\s+(?:&|and)\s+Tina\s+Turner\b/gi,
  /\bSam\s+(?:&|and)\s+Dave\b/gi,
  /\bBrooks\s+(?:&|and)\s+Dunn\b/gi,
  /\bTegan\s+(?:&|and)\s+Sara\b/gi,
  /\bAngus\s+(?:&|and)\s+Julia\s+Stone\b/gi,
  /\bMumford\s+(?:&|and)\s+Sons\b/gi,
  /\bOf\s+Mice\s+(?:&|and)\s+Men\b/gi,
  /\bIron\s+(?:&|and)\s+Wine\b/gi,
  /\bBelle\s+(?:&|and)\s+Sebastian\b/gi,
  /\bCoheed\s+(?:&|and)\s+Cambria\b/gi,
  /\bAbove\s+(?:&|and)\s+Beyond\b/gi,
  /\bChase\s+(?:&|and)\s+Status\b/gi,
  /\bHootie\s+(?:&|and)\s+the\s+Blowfish\b/gi,
  /\bEdward\s+Sharpe\s+(?:&|and)\s+the\s+Magnetic\s+Zeros\b/gi,
  /\bNoah\s+(?:&|and)\s+the\s+Whale\b/gi,
  /\bMe\s+First\s+(?:&|and)\s+the\s+Gimme\s+Gimmes\b/gi,
  /\bMike\s*\+\s*the\s+Mechanics\b/gi,
  /\bPrince\s+(?:&|and)\s+the\s+Revolution\b/gi,
  /\bKatrina\s+(?:&|and)\s+the\s+Waves\b/gi,
  /\bDr\.?\s+Hook\s+(?:&|and)\s+the\s+Medicine\s+Show\b/gi,
  /\bTyler,\s*The\s+Creator\b/gi,
  /\bGuns\s+N['’]\s*Roses\b/gi,
  /\bSalt-N-Pepa\b/gi,
  /\bAC\s*\/\s*DC\b/gi,
  /\bK\/DA\b/gi,
];

// Struktureller Schutz nur für echte "&/+ The <Band-Nomen>" Backing-Bands (keine Kollaborationen wie "Timbaland And The Mudd Katz")
const BACKING_BAND_RE =
  /\b([A-ZÄÖÜÀ-Ö][^\s,;()[\]]*(?:\s+[A-ZÄÖÜÀ-Ö][^\s,;()[\]]*){0,1})\s+(?:&|\+)\s+((?:the|die|les|los)\s+(?:[^\s,;()[\]]+\s+){0,2}(?:band|orchestra|orchester|ensemble|choir|chor|singers|collective|crew|allstars|all-stars|playboys|ramblers|drifters|experience|syndicate|shadows|riders|rebels|family|gang|sons|news|waves|machine|mechanics))\b/gi;

const NON_ARTIST_WITH_NOUNS_RE =
  /^(?:lyrics|songtext|bonus(?:\s+track)?|video|booklet|orchestra|orchester|strings|streicher|choir|chor|chorus|band|piano|klavier|guitar|gitarre|drums|schlagzeug|applause|crowd|friends|commentary|kommentar)$/i;

const MIX_EDITION_KEYWORD_RE =
  /\b(?:remix|rmx|mix|megamix|bootleg|rework|mashup|vip\s+(?:mix|edit)|radio\s+edit|club\s+(?:mix|edit)|extended\s+(?:mix|edit|version)|dub\s+(?:mix|edit|version)|acoustic\s+(?:mix|version|edit)|akustik(?:\s+version)?|unplugged|instrumental|karaoke|acapella|a\s*cappella|edit|version|remaster(?:ed)?|reprise|bonus\s+track|deluxe\s+edition|(?:clean|explicit|mono|stereo)\s+(?:mix|edit|version)|live\s+(?:at|in|from|mix|version|recording))\b/i;

const KNOWN_STANDALONE_ARTIST_BOUNDARIES: string[] = [
  'Bubba Sparxxx',
  'Bubba Spaxxx',
  'The Mudd Katz',
  'Justin Timberlake',
  'Timbaland',
  'Jawga Boyz',
  'Missy Elliott',
  'Busta Rhymes',
  'Kendrick Lamar',
  'Calvin Harris',
  'David Guetta',
  'Taylor Swift',
  'Kanye West',
  'Snoop Dogg',
  'Post Malone',
  'Bruno Mars',
  'Ed Sheeran',
  'Katy Perry',
  'Lady Gaga',
  'The Weeknd',
  'Sean Paul',
  'Ricky Martin',
  'Elton John',
  'Peter Alexander',
  'Joseph Strauss',
  'Marshmello',
  'Lil Wayne',
  '50 Cent',
  'Dr. Dre',
  'Pharrell',
  'Ludacris',
  'Skrillex',
  'Shakira',
  'Madonna',
  'Rihanna',
  'Beyoncé',
  'Pitbull',
  'Eminem',
  'Coolio',
  'Xzibit',
  'Tiësto',
  'Avicii',
  'Usher',
  'Ne-Yo',
  'T-Pain',
  'Fergie',
  'Jay-Z',
  'Magoo',
  'Ciara',
  'Nelly',
  'Akon',
  'Dua Lipa',
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SPLITTER_COLLAB_BRACKET_RE =
  /\s*[(\[]\s*(?:feat(?:uring)?|ft|vs|versus|pres(?:ents|enting)?|präsentiert|praesentiert|duet\s+with|duett\s+mit|zusammen\s+mit|with|mit|starring|meets|trifft|intro(?:ducing)?)(?:\.\s*|\s+)([^()[\]]+?)[)\]]/gi;

const SPLITTER_COLLAB_INLINE_RE =
  /(?:\s*[,;&/+]?\s+)(?:feat(?:uring)?|ft|vs|versus|pres(?:ents|enting)?|präsentiert|praesentiert|duet\s+with|duett\s+mit|zusammen\s+mit|with|mit|starring|meets|trifft|accompanied\s+by|intro(?:ducing)?)(?:\.\s*|\s+)|(?:\s+v\.\s+)/gi;

function dedupArtistTokens(tokens: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const clean = raw
      .replace(/^[\s,;:/&+|–—-]+|[\s,;:/&+|–—-]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
}

function splitConcatenatedChunkByBoundaries(
  chunk: string,
  boundaries: string[],
  depth = 0
): string[] {
  const trimmed = chunk.trim();
  if (!trimmed || depth > 5) return trimmed ? [trimmed] : [];
  if (MIX_EDITION_KEYWORD_RE.test(trimmed)) return [trimmed];

  for (const b of boundaries) {
    if (b.length < 4) continue;
    if (trimmed.toLowerCase() === b.toLowerCase()) return [trimmed];
    const pat = new RegExp(
      `^(.*?)(?:^|\\s)(${escapeRegExp(b)})(?:\\s+(.*)|$)`,
      'i'
    );
    const m = pat.exec(trimmed);
    if (!m) continue;
    const before = (m[1] || '').trim();
    const matched = (m[2] || '').trim();
    const after = (m[3] || '').trim();
    if (!before && !after) continue;
    // Niemals vor Band-/Orchester-/Remix-Endungen aufbrechen
    if (
      after &&
      /^(?:remix|rmx|mix|megamix|edit|version|band|orchestra|orchester|ensemble|trio|quartet|choir|chor|feat\.?|ft\.?)\b/i.test(
        after
      )
    ) {
      continue;
    }
    const result: string[] = [];
    if (before) result.push(...splitConcatenatedChunkByBoundaries(before, boundaries, depth + 1));
    result.push(matched);
    if (after) result.push(...splitConcatenatedChunkByBoundaries(after, boundaries, depth + 1));
    return result;
  }
  return [trimmed];
}

export function splitChainedArtists(
  raw: string,
  isClassical = false,
  knownArtists: string[] = []
): string[] {
  let working = String(raw || '').trim();
  if (!working) return [];

  const placeholders = new Map<string, string>();
  let phIdx = 0;
  const stash = (matchText: string): string => {
    const token = `\uE000P${phIdx++}\uE000`;
    placeholders.set(token, matchText.trim());
    return token;
  };

  for (const pat of PROTECTED_BAND_PATTERNS) {
    working = working.replace(pat, (m) => stash(m));
  }
  working = working.replace(BACKING_BAND_RE, (m) => stash(m));

  // Im Klassik-Modus ein einzelnes "Nachname, Vorname" ohne weitere Verkettung schützen
  if (
    isClassical &&
    !/[;&+/×]|\b(?:feat(?:uring)?|ft|vs|versus|and|und|mit|with|duet|duett|pres)\b/i.test(working) &&
    (working.match(/,/g) || []).length === 1 &&
    /^[A-ZÄÖÜÀ-Ö][a-zäöüßà-öø-ÿ'-]+,\s+[A-ZÄÖÜÀ-Ö][^\s,;]+(?:\s+[A-ZÄÖÜÀ-Ö][^\s,;]+){0,2}$/.test(working)
  ) {
    working = stash(working);
  }

  working = working.replace(SPLITTER_COLLAB_BRACKET_RE, '; $1');
  working = working.replace(SPLITTER_COLLAB_INLINE_RE, '; ');

  // Komma-, Semikolon-, &- , +- , /- , Konjunktions- und Kollaborations-Trenner vereinheitlichen
  working = working
    .replace(/\s*;\s*/g, '; ')
    .replace(/\s*,\s*/g, '; ')
    .replace(/\s+&\s+|(?<=[^\W\d_]{2})&(?=[^\W\d_]{2})/g, '; ')
    .replace(/\s+\+\s+/g, '; ')
    .replace(/\s+\/\s+|(?<=[^\W\d_]{3})\/(?=[^\W\d_]{3})/g, '; ')
    .replace(/\s+[×]\s+|\s+x\s+(?=[^\s;]{2,})/g, '; ')
    .replace(/\s+(?:and|und|et|avec|con)\s+/gi, '; ');

  const allBoundaries = Array.from(
    new Set(
      [...knownArtists, ...KNOWN_STANDALONE_ARTIST_BOUNDARIES]
        .map((s) => s.trim())
        .filter((s) => s.length >= 4 && !MIX_EDITION_KEYWORD_RE.test(s))
    )
  ).sort((a, b) => b.length - a.length);

  const rawParts: string[] = [];
  for (const p of working.split(/\s*;\s*/)) {
    let restored = p.trim();
    if (!restored) continue;
    let hadPlaceholder = false;
    for (const [tok, orig] of placeholders.entries()) {
      if (restored.includes(tok)) {
        restored = restored.split(tok).join(orig);
        hadPlaceholder = true;
      }
    }
    if (!restored) continue;
    if (hadPlaceholder) {
      rawParts.push(restored);
    } else {
      rawParts.push(...splitConcatenatedChunkByBoundaries(restored, allBoundaries));
    }
  }

  return dedupArtistTokens(rawParts);
}

export function extractFeaturesFromTitle(
  rawTitle: string,
  isClassical = false,
  knownArtists: string[] = []
): { cleanTitle: string; extractedArtists: string[] } {
  let workingTitle = String(rawTitle || '').trim();
  if (!workingTitle) return { cleanTitle: '', extractedArtists: [] };

  const collectedRawChunks: string[] = [];

  const handleBracketMatch = (
    full: string,
    kw: string,
    inner: string,
    openBr: string,
    closeBr: string
  ): string => {
    const cleanInner = String(inner || '').trim();
    if (!cleanInner) return full;
    if (/^(?:with|mit)$/i.test(kw.trim()) && NON_ARTIST_WITH_NOUNS_RE.test(cleanInner)) {
      return full;
    }
    // Remix / Mix / Version / Edit in Klammern IMMER im Titel erhalten (z. B. "(Timbaland Remix)", "(with Club Mix)")
    if (MIX_EDITION_KEYWORD_RE.test(cleanInner)) {
      if (/^(?:feat(?:uring)?|ft)$/i.test(kw.trim())) {
        const splitFeatAndRemix =
          /^(.+?)\s*[-–—,/]\s*([^()[\]]*\b(?:remix|rmx|mix|megamix|bootleg|rework|mashup|flip|vip|radio|edit|version|remaster(?:ed)?|acoustic|akustik|unplugged|instrumental|karaoke|acapella|a\s*cappella|extended|dub|club|live)\b.*)$/i.exec(
            cleanInner
          );
        if (splitFeatAndRemix) {
          const featPart = splitFeatAndRemix[1].trim();
          const mixPart = splitFeatAndRemix[2].trim();
          if (featPart && !MIX_EDITION_KEYWORD_RE.test(featPart)) {
            collectedRawChunks.push(featPart);
            return ` ${openBr}${mixPart}${closeBr}`;
          }
        }
      }
      return full;
    }
    collectedRawChunks.push(cleanInner);
    return ' ';
  };

  // 1. Geklammerte Feature-Konstrukte wie "(feat. Jawga Boyz & Bubba Sparxxx)" oder "[ft. Artist A, Artist B]"
  const parenRe =
    /\s*\(\s*(feat(?:uring)?|ft|vs|versus|pres(?:ents|enting)?|präsentiert|praesentiert|duet\s+with|duett\s+mit|zusammen\s+mit|with|mit|starring)(?:\.\s*|\s+)([^()]+?)\s*\)/gi;
  workingTitle = workingTitle.replace(parenRe, (full, kw: string, inner: string) =>
    handleBracketMatch(full, kw, inner, '(', ')')
  );

  const bracketRe =
    /\s*\[\s*(feat(?:uring)?|ft|vs|versus|pres(?:ents|enting)?|präsentiert|praesentiert|duet\s+with|duett\s+mit|zusammen\s+mit|with|mit|starring)(?:\.\s*|\s+)([^\[\]]+?)\s*\]/gi;
  workingTitle = workingTitle.replace(bracketRe, (full, kw: string, inner: string) =>
    handleBracketMatch(full, kw, inner, '[', ']')
  );

  // 2. Ungeklammerte Feature-Anhänge wie "Songtitle feat. Artist A & Artist B (Timbaland Remix)" oder "... feat. Artist - Timbaland Remix"
  const unbracketedRe =
    /(?:\s*[-–—,/]?\s+|\s+)(?:feat(?:uring)?|ft|duet\s+with|duett\s+mit|zusammen\s+mit|pres(?:ents|enting)?|präsentiert|praesentiert)(?:\.\s*|\s+)(.+?)(?=\s*[\(\[][^()\]]*\b(?:radio|edit|remix|rmx|mix|megamix|bootleg|rework|mashup|flip|vip|live|version|remaster(?:ed)?|acoustic|akustik|unplugged|instrumental|karaoke|acapella|a\s*cappella|extended|dub|club|deluxe|bonus|mono|stereo|clean|explicit)\b[^()\]]*[\)\]]|\s*[-–—,/]\s*[^-–—,/()[\]]*\b(?:remix|rmx|mix|megamix|bootleg|rework|mashup|flip|vip|edit|version|remaster(?:ed)?|acoustic|akustik|unplugged|instrumental|karaoke|acapella|a\s*cappella|extended|dub|club|live)\b|\s*$)/gi;
  workingTitle = workingTitle.replace(unbracketedRe, (full, inner: string) => {
    const cleanInner = String(inner || '').trim();
    if (!cleanInner) return full;
    // Wenn im unbracketed-Teil selbst "Timbaland Remix" steht, nicht herauslöschen!
    if (MIX_EDITION_KEYWORD_RE.test(cleanInner)) {
      return full;
    }
    collectedRawChunks.push(cleanInner);
    return '';
  });

  const cleanTitle = workingTitle
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–—,/]\s*$/g, '')
    .trim();

  const extractedArtists = dedupArtistTokens(
    collectedRawChunks.flatMap((chunk) => splitChainedArtists(chunk, isClassical, knownArtists))
  );

  return {
    cleanTitle: cleanTitle || rawTitle.trim(),
    extractedArtists,
  };
}

export function splitArtistsAndExtractFromTitle(
  album: AlbumMetadata,
  onlySelected = true
): {
  album: AlbumMetadata;
  changes: Array<{ scope: string; detail: string }>;
} {
  const isClassical = Boolean(album.isClassical);
  const changes: Array<{ scope: string; detail: string }> = [];
  const hasTracks = album.tracks.length > 0;
  const selectedTracks = album.tracks.filter((t) => t.selected);

  if (onlySelected && hasTracks && selectedTracks.length === 0) {
    return { album, changes: [] };
  }

  const targetTracks = onlySelected && hasTracks ? selectedTracks : album.tracks;
  const includeAlbumFields = !onlySelected || !hasTracks || selectedTracks.length === album.tracks.length;

  // Bekannte atomare Künstlernamen aus Album & Tracks für kontextbasierte Erkennung sammeln
  const candidatePool: string[] = [];
  for (const val of [album.artist, album.albumArtist, ...album.tracks.map((t) => t.artist)]) {
    const cleanVal = String(val || '').trim();
    if (!cleanVal) continue;
    for (const part of cleanVal.split(/\s*[;,]\s*/)) {
      const p = part.trim();
      if (p && p.length >= 4 && !/[&+/×]|\b(?:and|und|feat|ft|remix|mix)\b/i.test(p)) {
        candidatePool.push(p);
      }
    }
  }
  const knownArtists = Array.from(new Set(candidatePool));

  const splitJoin = (val: string) =>
    splitChainedArtists(val, isClassical, knownArtists).join('; ');

  const origArtist = (album.artist || '').trim();
  const nextArtist = includeAlbumFields && origArtist ? splitJoin(origArtist) : origArtist;
  if (includeAlbumFields && nextArtist && nextArtist !== origArtist) {
    changes.push({ scope: 'Künstler', detail: `„${origArtist}“ → „${nextArtist}“` });
  }

  const origAlbumArtist = (album.albumArtist || '').trim();
  const nextAlbumArtist =
    includeAlbumFields && origAlbumArtist ? splitJoin(origAlbumArtist) : origAlbumArtist;
  if (includeAlbumFields && nextAlbumArtist && nextAlbumArtist !== origAlbumArtist) {
    changes.push({ scope: 'Album-Interpret', detail: `„${origAlbumArtist}“ → „${nextAlbumArtist}“` });
  }

  let nextComposer = album.composer || '';
  let nextOrchestra = album.orchestra || '';
  let nextConductor = album.conductor || '';
  if (isClassical && includeAlbumFields) {
    if (nextComposer.trim()) {
      const s = splitJoin(nextComposer);
      if (s && s !== nextComposer.trim()) {
        changes.push({ scope: 'Komponist (Album)', detail: `„${nextComposer.trim()}“ → „${s}“` });
        nextComposer = s;
      }
    }
    if (nextOrchestra.trim()) {
      const s = splitJoin(nextOrchestra);
      if (s && s !== nextOrchestra.trim()) {
        changes.push({ scope: 'Orchester (Album)', detail: `„${nextOrchestra.trim()}“ → „${s}“` });
        nextOrchestra = s;
      }
    }
    if (nextConductor.trim()) {
      const s = splitJoin(nextConductor);
      if (s && s !== nextConductor.trim()) {
        changes.push({ scope: 'Dirigent (Album)', detail: `„${nextConductor.trim()}“ → „${s}“` });
        nextConductor = s;
      }
    }
  }

  const targetIds = new Set(targetTracks.map((t) => t.id));
  const nextTracks = album.tracks.map((trk) => {
    if (onlySelected && hasTracks && !targetIds.has(trk.id)) {
      return trk;
    }
    const origTrkTitle = (trk.title || '').trim();
    const origTrkArtist = (trk.artist || '').trim();
    const { cleanTitle, extractedArtists } = extractFeaturesFromTitle(
      origTrkTitle,
      isClassical,
      knownArtists
    );
    const baseArtists = splitChainedArtists(origTrkArtist, isClassical, knownArtists);
    const mergedArtists = dedupArtistTokens([...baseArtists, ...extractedArtists]);
    const finalArtist = mergedArtists.join('; ');
    const finalTitle = cleanTitle || origTrkTitle;

    const trkDetails: string[] = [];
    if (finalTitle !== origTrkTitle) {
      trkDetails.push(`Titel: „${origTrkTitle}“ → „${finalTitle}“`);
    }
    if (finalArtist !== origTrkArtist) {
      trkDetails.push(`Interpret: „${origTrkArtist || '—'}“ → „${finalArtist}“`);
    }
    if (trkDetails.length > 0) {
      changes.push({
        scope: `Titel #${String(trk.trackNumber).padStart(2, '0')}`,
        detail: trkDetails.join(' · '),
      });
    }

    const updatedTrack: TrackMetadata = {
      ...trk,
      title: finalTitle,
      artist: finalArtist || trk.artist,
    };
    if (isClassical) {
      if ((trk.composer || '').trim()) {
        updatedTrack.composer = splitJoin(trk.composer || '') || trk.composer;
      }
      if ((trk.orchestra || '').trim()) {
        updatedTrack.orchestra = splitJoin(trk.orchestra || '') || trk.orchestra;
      }
      if ((trk.conductor || '').trim()) {
        updatedTrack.conductor = splitJoin(trk.conductor || '') || trk.conductor;
      }
    }
    return updatedTrack;
  });

  return {
    album: {
      ...album,
      artist: nextArtist || album.artist,
      albumArtist: nextAlbumArtist || album.albumArtist,
      composer: nextComposer,
      orchestra: nextOrchestra,
      conductor: nextConductor,
      tracks: nextTracks,
    },
    changes,
  };
}

export interface AlbumStorageEstimate {
  totalTracks: number;
  selectedTracks: number;
  totalDurationSeconds: number;
  selectedDurationSeconds: number;
  averageTrackSeconds: number;
  rawPcmBytes: number;
  estimatedOutputBytes: number;
  estimatedBitrateKbps: number;
  compressionRatioPercent: number;
  formatLabel: string;
}

export function estimateAlbumStorage(
  album: AlbumMetadata,
  settings: ExportSettings
): AlbumStorageEstimate {
  const totalTracks = album.tracks.length;
  const selectedList = album.tracks.filter((t) => t.selected);
  const activeList = selectedList.length > 0 ? selectedList : album.tracks;
  const totalDurationSeconds = album.tracks.reduce(
    (sum, t) => sum + Math.max(0, t.durationSeconds || 0),
    0
  );
  const selectedDurationSeconds = selectedList.reduce(
    (sum, t) => sum + Math.max(0, t.durationSeconds || 0),
    0
  );
  const effectiveSeconds = selectedList.length > 0 ? selectedDurationSeconds : totalDurationSeconds;
  const averageTrackSeconds =
    totalTracks > 0 ? Math.round(totalDurationSeconds / totalTracks) : 0;

  // Red Book Audio-CD: 44.100 Hz * 16 Bit * 2 Kanäle = 176.400 Bytes/Sekunde (1411,2 kbps)
  const rawPcmBytes = effectiveSeconds * 176400;

  let bytesPerSecond = 0;
  let formatLabel = '';

  if (settings.exportFormat === 'flac') {
    const level = Math.min(8, Math.max(0, settings.flacCompressionLevel));
    // Typische FLAC-Kompression für CD-Audio liegt zwischen ~66% (Stufe 0) und ~55% (Stufe 8)
    const flacRatio = 0.66 - (level / 8) * 0.11;
    bytesPerSecond = Math.round(176400 * flacRatio);
    formatLabel = `FLAC (Stufe ${level})`;
  } else {
    const kbpsMap: Record<ExportSettings['mp3Quality'], number> = {
      cbr_320: 320,
      cbr_256: 256,
      cbr_192: 192,
      vbr_v0: 245,
      vbr_v2: 190,
    };
    const kbps = kbpsMap[settings.mp3Quality] || 245;
    bytesPerSecond = (kbps * 1000) / 8;
    formatLabel = `MP3 (${settings.mp3Quality.toUpperCase()} · ID3v2.${settings.id3v2Version})`;
  }

  const perTrackTagAndCoverBytes = (settings.embedCoverArt ? 160 * 1024 : 0) + 12 * 1024;
  const folderCoverBytes = settings.saveFolderCover && activeList.length > 0 ? 180 * 1024 : 0;
  const estimatedOutputBytes =
    effectiveSeconds > 0
      ? Math.round(
          effectiveSeconds * bytesPerSecond +
            activeList.length * perTrackTagAndCoverBytes +
            folderCoverBytes
        )
      : 0;

  const estimatedBitrateKbps = Math.round((bytesPerSecond * 8) / 1000);
  const compressionRatioPercent =
    rawPcmBytes > 0 ? Math.round((estimatedOutputBytes / rawPcmBytes) * 100) : 0;

  return {
    totalTracks,
    selectedTracks: selectedList.length,
    totalDurationSeconds,
    selectedDurationSeconds,
    averageTrackSeconds,
    rawPcmBytes,
    estimatedOutputBytes,
    estimatedBitrateKbps,
    compressionRatioPercent,
    formatLabel,
  };
}

export function formatMegabytes(bytes: number): string {
  if (bytes <= 0) return '0,0 MB';
  const mb = bytes / (1024 * 1024);
  return `${mb.toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} MB`;
}

export function formatCoverByteSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb.toLocaleString('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} MB`;
  }
  const kb = bytes / 1024;
  return `${kb.toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} KB`;
}

export interface NormalizedCoverInfo {
  url: string;
  width: number;
  height: number;
  sizeBytes: number;
  format: string;
  originalFormat: string;
  wasConvertedToJpg: boolean;
}

function detectImageFormatFromBytes(bytes: Uint8Array, mimeHint = '', nameHint = ''): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'JPEG';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'PNG';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'WEBP';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'BMP';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'GIF';
  }
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return 'TIFF';
  }
  const m = mimeHint.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'JPEG';
  if (m.includes('png')) return 'PNG';
  if (m.includes('webp')) return 'WEBP';
  if (m.includes('bmp')) return 'BMP';
  if (m.includes('gif')) return 'GIF';
  if (m.includes('tiff') || m.includes('tif')) return 'TIFF';
  if (m.includes('svg')) return 'SVG';

  const ext = nameHint.split('.').pop()?.toLowerCase() || '';
  if (ext === 'jpg' || ext === 'jpeg') return 'JPEG';
  if (ext === 'png') return 'PNG';
  if (ext === 'webp') return 'WEBP';
  if (ext === 'bmp') return 'BMP';
  if (ext === 'gif') return 'GIF';
  if (ext === 'tif' || ext === 'tiff') return 'TIFF';
  return 'JPEG';
}

export async function inspectCoverImage(
  source: Blob | File | string,
  fileNameHint = ''
): Promise<NormalizedCoverInfo> {
  let blob: Blob;
  let nameHint = fileNameHint;
  let previewUrl: string;
  let createdBlobUrl = false;

  if (typeof source === 'string') {
    previewUrl = source;
    const resp = await fetch(source);
    if (!resp.ok) {
      throw new Error(`Cover konnte nicht geladen werden (HTTP ${resp.status})`);
    }
    blob = await resp.blob();
  } else {
    blob = source;
    if (!nameHint && 'name' in source && typeof source.name === 'string') {
      nameHint = source.name;
    }
    previewUrl = URL.createObjectURL(blob);
    createdBlobUrl = true;
  }

  const headBuf = await blob.slice(0, 32).arrayBuffer();
  const detectedFormat = detectImageFormatFromBytes(
    new Uint8Array(headBuf),
    blob.type || '',
    nameHint
  );

  const probeUrl = createdBlobUrl ? previewUrl : URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Bilddatei konnte nicht dekodiert werden.'));
      el.src = probeUrl;
    });

    const width = Math.max(1, img.naturalWidth || img.width || 500);
    const height = Math.max(1, img.naturalHeight || img.height || 500);
    if (!createdBlobUrl) {
      URL.revokeObjectURL(probeUrl);
    }

    return {
      url: previewUrl,
      width,
      height,
      sizeBytes: blob.size,
      format: detectedFormat,
      originalFormat: detectedFormat,
      wasConvertedToJpg: false,
    };
  } catch (err) {
    if (!createdBlobUrl) {
      URL.revokeObjectURL(probeUrl);
    }
    throw err;
  }
}

export async function normalizeCoverToJpeg(
  source: Blob | File | string,
  fileNameHint = ''
): Promise<NormalizedCoverInfo> {
  let blob: Blob;
  let nameHint = fileNameHint;
  if (typeof source === 'string') {
    const resp = await fetch(source);
    if (!resp.ok) {
      throw new Error(`Cover konnte nicht geladen werden (HTTP ${resp.status})`);
    }
    blob = await resp.blob();
  } else {
    blob = source;
    if (!nameHint && 'name' in source && typeof source.name === 'string') {
      nameHint = source.name;
    }
  }

  const headBuf = await blob.slice(0, 32).arrayBuffer();
  const originalFormat = detectImageFormatFromBytes(
    new Uint8Array(headBuf),
    blob.type || '',
    nameHint
  );

  const tempUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Bilddatei konnte nicht dekodiert werden.'));
      el.src = tempUrl;
    });

    const width = Math.max(1, img.naturalWidth || img.width || 500);
    const height = Math.max(1, img.naturalHeight || img.height || 500);

    // Falls das Bild nicht im JPG/JPEG-Format vorliegt, direkt vor dem Einbetten verlustarm (Q92) in JPEG umwandeln
    if (originalFormat !== 'JPEG') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        const jpegBlob = await new Promise<Blob | null>((res) =>
          canvas.toBlob((b) => res(b), 'image/jpeg', 0.92)
        );
        if (jpegBlob) {
          URL.revokeObjectURL(tempUrl);
          const jpgUrl = URL.createObjectURL(jpegBlob);
          return {
            url: jpgUrl,
            width,
            height,
            sizeBytes: jpegBlob.size,
            format: 'JPEG',
            originalFormat,
            wasConvertedToJpg: true,
          };
        }
      }
    }

    return {
      url: typeof source === 'string' ? source : tempUrl,
      width,
      height,
      sizeBytes: blob.size,
      format: 'JPEG',
      originalFormat: 'JPEG',
      wasConvertedToJpg: false,
    };
  } catch (err) {
    URL.revokeObjectURL(tempUrl);
    throw err;
  }
}

export function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return cleaned || 'Unbekannt';
}

export function formatCoverFilename(album: AlbumMetadata, settings: ExportSettings): string {
  const raw = (settings.coverFilename || 'cover').trim() || 'cover';
  const discPad = formatIndexNumber(album.discNumber, album.totalDiscs);
  const totalDiscsPad = formatIndexNumber(album.totalDiscs, album.totalDiscs);
  const primaryLabel = (album.label?.split(';')[0]?.trim() || '') || 'Label';
  const primaryCatno = (album.catalogNumber?.split(';')[0]?.trim() || '') || 'CatNo';
  const yearClean = sanitizeSegment((album.year || album.releaseDate?.slice(0, 4) || '0000').slice(0, 4));

  const artistNorm = normalizeMultiArtist(album.artist);
  const albumArtistNorm = normalizeMultiArtist(album.albumArtist || album.artist);
  const rendered = raw
    .replaceAll('{album}', sanitizeSegment(album.title))
    .replaceAll('{albumtitel}', sanitizeSegment(album.title))
    .replaceAll('{artist}', sanitizeSegment(artistNorm))
    .replaceAll('{interpret}', sanitizeSegment(artistNorm))
    .replaceAll('{album_artist}', sanitizeSegment(albumArtistNorm))
    .replaceAll('{albumartist}', sanitizeSegment(albumArtistNorm))
    .replaceAll('{albuminterpret}', sanitizeSegment(albumArtistNorm))
    .replaceAll('{year}', yearClean)
    .replaceAll('{jahr}', yearClean)
    .replaceAll('{disc}', discPad)
    .replaceAll('{cd}', discPad)
    .replaceAll('{total_discs}', totalDiscsPad)
    .replaceAll('{label}', sanitizeSegment(primaryLabel))
    .replaceAll('{catno}', sanitizeSegment(primaryCatno))
    .replace(/\{[^{}]*\}/g, 'cover');

  if (/\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(rendered)) {
    const idx = rendered.lastIndexOf('.');
    return `${sanitizeSegment(rendered.slice(0, idx))}.jpg`;
  }
  return `${sanitizeSegment(rendered)}.jpg`;
}

export function formatOutputStem(
  album: AlbumMetadata,
  track: TrackMetadata,
  settings: ExportSettings
): string {
  const artist = sanitizeSegment(normalizeMultiArtist(track.artist || album.artist));
  const albumArtist = sanitizeSegment(normalizeMultiArtist(album.albumArtist || album.artist));
  const artistSort = sanitizeSegment(
    normalizeMultiArtist(track.artistSort || album.albumArtistSort || album.albumArtist || album.artist)
  );
  const albumTitle = sanitizeSegment(album.title);
  const year = sanitizeSegment((album.year || album.releaseDate?.slice(0, 4) || '0000').slice(0, 4));
  const origYear = sanitizeSegment(
    (album.originalDate?.slice(0, 4) || year).slice(0, 4) || year
  );
  const releaseDate = sanitizeSegment(album.releaseDate || album.year || '0000');
  const effectiveGenre = (track.genre || '').trim() || album.genre || '';
  const primaryGenre = (effectiveGenre.split(';')[0]?.trim() || '') || 'Audio';
  const genre = sanitizeSegment(primaryGenre);
  const genresAll = sanitizeSegment(effectiveGenre || 'Audio');
  const label = sanitizeSegment((album.label?.split(';')[0]?.trim() || '') || 'Label');
  const catno = sanitizeSegment(
    (album.catalogNumber?.split(';')[0]?.trim() || '') || 'CatNo'
  );
  const barcode = sanitizeSegment(album.barcode || '00000000');
  const country = sanitizeSegment(album.country || 'XX');
  const media = sanitizeSegment(album.mediaFormat || 'CD');
  const effectiveDisc = track.discNumber || album.discNumber || 1;
  const discTracks = album.tracks.filter((t) => (t.discNumber || album.discNumber || 1) === effectiveDisc);
  const trackTotalCount = discTracks.length > 0 ? discTracks.length : album.tracks.length;
  const title = sanitizeSegment(track.title);
  const trackPad = formatIndexNumber(track.trackNumber, trackTotalCount);
  const totalTracksPad = formatIndexNumber(trackTotalCount, trackTotalCount);
  const discPad = formatIndexNumber(effectiveDisc, album.totalDiscs);
  const totalDiscsPad = formatIndexNumber(album.totalDiscs, album.totalDiscs);
  const discSub = sanitizeSegment(track.discSubtitle || album.discSubtitle || `CD ${discPad}`);
  const isrc = sanitizeSegment(track.isrc || 'ISRC');
  const composer = sanitizeSegment(
    (track.composer?.split(';')[0]?.trim() || album.composer?.split(';')[0]?.trim() || '') || artist
  );
  const orchestra = sanitizeSegment(
    (track.orchestra?.split(';')[0]?.trim() || album.orchestra?.split(';')[0]?.trim() || '') || 'Orchester'
  );
  const conductor = sanitizeSegment(
    (track.conductor?.split(';')[0]?.trim() || album.conductor?.split(';')[0]?.trim() || '') || 'Dirigent'
  );
  const fmtUpper = settings.exportFormat.toUpperCase();

  const rel = settings.filenameTemplate
    .replaceAll('{artist}', artist)
    .replaceAll('{interpret}', artist)
    .replaceAll('{artist_sort}', artistSort)
    .replaceAll('{album_artist}', albumArtist)
    .replaceAll('{albumartist}', albumArtist)
    .replaceAll('{albuminterpret}', albumArtist)
    .replaceAll('{album}', albumTitle)
    .replaceAll('{albumtitel}', albumTitle)
    .replaceAll('{year}', year)
    .replaceAll('{jahr}', year)
    .replaceAll('{original_year}', origYear)
    .replaceAll('{orig_year}', origYear)
    .replaceAll('{date}', releaseDate)
    .replaceAll('{datum}', releaseDate)
    .replaceAll('{genre}', genre)
    .replaceAll('{genres}', genresAll)
    .replaceAll('{label}', label)
    .replaceAll('{catno}', catno)
    .replaceAll('{catalog_number}', catno)
    .replaceAll('{katalognummer}', catno)
    .replaceAll('{barcode}', barcode)
    .replaceAll('{ean}', barcode)
    .replaceAll('{country}', country)
    .replaceAll('{land}', country)
    .replaceAll('{media}', media)
    .replaceAll('{medium}', media)
    .replaceAll('{format}', fmtUpper)
    .replaceAll('{isrc}', isrc)
    .replaceAll('{composer}', composer)
    .replaceAll('{komponist}', composer)
    .replaceAll('{orchestra}', orchestra)
    .replaceAll('{orchester}', orchestra)
    .replaceAll('{conductor}', conductor)
    .replaceAll('{dirigent}', conductor)
    .replaceAll('{total_tracks}', totalTracksPad)
    .replaceAll('{tracktotal}', totalTracksPad)
    .replaceAll('{total_discs}', totalDiscsPad)
    .replaceAll('{disctotal}', totalDiscsPad)
    .replaceAll('{disc_subtitle}', discSub)
    .replace(/\{track(?::[^{}]*)?\}/gi, trackPad)
    .replace(/\{nr(?::[^{}]*)?\}/gi, trackPad)
    .replace(/\{disc(?::[^{}]*)?\}/gi, discPad)
    .replace(/\{cd(?::[^{}]*)?\}/gi, discPad)
    .replace(/\{:0[23]d\}/gi, trackPad)
    .replaceAll('{title}', title)
    .replaceAll('{titel}', title)
    .replaceAll('{}', trackPad);

  const rawOutDir = track.sourceFileName
    ? settings.outputDirTag || settings.outputDir || DEFAULT_MODULE_OUTPUT_DIRS.outputDirTag
    : settings.outputDirRip || settings.outputDir || DEFAULT_MODULE_OUTPUT_DIRS.outputDirRip;
  const baseDir = rawOutDir.replace(/\/+$/, '');
  return `${baseDir}/${rel}`;
}

const CANONICAL_ROMAN_RE =
  /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

const UNICODE_ROMAN_MAP: Record<string, string> = {
  '\u2160': 'I',
  '\u2161': 'II',
  '\u2162': 'III',
  '\u2163': 'IV',
  '\u2164': 'V',
  '\u2165': 'VI',
  '\u2166': 'VII',
  '\u2167': 'VIII',
  '\u2168': 'IX',
  '\u2169': 'X',
  '\u216a': 'XI',
  '\u216b': 'XII',
  '\u216c': 'L',
  '\u216d': 'C',
  '\u216e': 'D',
  '\u216f': 'M',
  '\u2170': 'i',
  '\u2171': 'ii',
  '\u2172': 'iii',
  '\u2173': 'iv',
  '\u2174': 'v',
  '\u2175': 'vi',
  '\u2176': 'vii',
  '\u2177': 'viii',
  '\u2178': 'ix',
  '\u2179': 'x',
  '\u217a': 'xi',
  '\u217b': 'xii',
  '\u217c': 'l',
  '\u217d': 'c',
  '\u217e': 'd',
  '\u217f': 'm',
};

const ROMAN_EXPLICIT_PREFIX_RE =
  /(?:^|[\s(\[,;:/–—-])(?:parts?|pts?\.?|teil(?:e|en)?|volumes?|vols?\.?|acts?|akte?|chapters?|kap\.?|kapiteln?|books?|bücher|episodes?|eps?\.?|discs?|disks?|cds?|sides?|seiten?|bände|band|bd\.?|suites?|nos?\.?|nrs?\.?|n°|opp?\.?|opus|sätze|satz|movements?|movs?\.?|phases?|stages?|levels?|rounds?|runden?|tracks?|sections?|sektionen?|tomes?|livres?|partes?|cantos?|scenes?|szenen?|symphon(?:y|ies|ie|ien)|sinfonie(?:n)?|concertos?|konzerte?|sonatas?|sonaten?|preludes?|préludes?|präludien|etudes?|études?|overtures?|ouvertüren?|interludes?|interludien|stücke?|nummern?|versions?|editions?|seasons?|staffeln?|generations?|gen|marks?|mks?\.?|divisions?|cycles?|zyklen?|sagas?|partitas?|toccatas?|fugues?|fugen?|masses?|messen?|requiems?|cantatas?|kantaten?|motets?|motetten?|nocturnes?|waltzes?|walzer|mazurkas?|polonaises?|rhapsod(?:y|ies|ie)|fantas(?:ia|ies|ie)|serenades?|divertiment(?:o|i)|quartets?|quartette?|quintets?|quintette?|trios?|duos?|sextets?|octets?|bagatelles?|impromptus?|intermezzos?|capriccios?|ballades?|scherzos?|rondos?|canons?|kanons?|psalms?|psalmen?|hymns?|hymnen?|sonnets?|sonette?|studies?|studien?|super\s+bowl)\s*$/i;

const ROMAN_X_SAFE_PREFIX_RE =
  /(?:^|[\s(\[,;:/–—-])(?:parts?|pts?\.?|teil(?:e|en)?|volumes?|vols?\.?|acts?|akte?|chapters?|kap\.?|kapiteln?|books?|bücher|episodes?|eps?\.?|discs?|disks?|cds?|sides?|seiten?|bände|band|bd\.?|suites?|nos?\.?|nrs?\.?|n°|opp?\.?|opus|sätze|satz|movements?|movs?\.?|phases?|stages?|levels?|rounds?|runden?|tracks?|sections?|sektionen?|tomes?|livres?|partes?|cantos?|scenes?|szenen?|sinfonie(?:n)?|concertos?|konzerte?|sonatas?|sonaten?|preludes?|préludes?|präludien|etudes?|études?|overtures?|ouvertüren?|interludes?|interludien|stücke?|nummern?|versions?|editions?|seasons?|staffeln?|marks?|mks?\.?|divisions?|cycles?|zyklen?|psalms?|psalmen?|sonnets?|sonette?|super\s+bowl)\s*$/i;

const ENGLISH_AFTER_I_VERBS_RE =
  /^\s+(?:am|was|were|are|be|can|could|will|would|shall|should|may|might|must|do|did|don't|didn't|can't|won't|wouldn't|shouldn't|couldn't|have|had|has|love|loved|hate|hated|know|knew|need|needed|want|wanted|feel|felt|see|saw|hear|heard|think|thought|say|said|tell|told|make|made|get|got|give|gave|take|took|keep|kept|find|found|lose|lost|leave|left|live|lived|die|died|cry|cried|try|tried|fly|flew|run|ran|walk|walked|stand|stood|stay|stayed|wait|waited|wish|wished|hope|hoped|dream|dreamed|remember|remembered|forget|forgot|believe|believed|trust|trusted|miss|missed|like|liked|read|write|wrote|sing|sang|play|played|wear|wore|hold|held|use|used|work|worked|call|called|look|looked|watch|watched|own|owned|went|came|bring|brought|buy|bought|sell|sold|send|sent|choose|chose|break|broke|built|grow|grew|met|put|let|cut|hit|beat|drive|drove|ride|rode|burn|burned|burnt|turn|turned|mean|meant|swear|swore|owe|owed|pay|paid|pick|picked|drop|dropped|pull|pulled|push|pushed|hide|hid|show|showed|ask|asked|answer|answered|follow|followed|lead|led|fight|fought|win|won|pray|prayed|dance|danced|laugh|laughed|smile|smiled|fear|feared|care|cared|ever|always|never|still|just|only|really|also|already|almost|nearly|often|sometimes)\b/i;

const PRE_I_STOPWORDS = new Set([
  'and', 'or', 'nor', 'but', 'yet', 'so', 'for', 'than', 'as', 'like', 'to', 'of',
  'in', 'on', 'at', 'by', 'from', 'with', 'into', 'onto', 'upon', 'about', 'after',
  'before', 'until', 'till', 'since', 'while', 'when', 'where', 'why', 'how', 'who',
  'whom', 'whose', 'what', 'which', 'that', 'if', 'unless', 'though', 'although',
  'because', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does',
  'did', 'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'have', 'has', 'had', 'not', 'no', 'yes', 'oh', 'ah', 'ooh', 'hey', 'yeah', 'yea',
  'well', 'here', 'there', 'now', 'then', 'only', 'even', 'just', 'still', 'also',
  'maybe', 'perhaps', 'all', 'both', 'neither', 'either', 'me', 'you', 'he', 'she',
  'it', 'we', 'they', 'him', 'her', 'us', 'them', 'mr', 'mrs', 'ms', 'dr', 'prof',
  'st', 'dj', 'mc', 'agent', 'vitamin', 'factor', 'team', 'key', 'letter', 'plan',
  'vs', 'v', 'a', 'e', 'o', 'u',
]);

const PRE_V_STOPWORDS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'dj', 'mc', 'agent', 'vitamin', 'factor',
  'team', 'key', 'letter', 'in', 'of', 'and', 'or', 'for', 'to', 'by', 'with', 'from',
  'vs', 'v', 'a', 'e', 'o', 'u',
]);

export function parseCanonicalRomanNumeral(token: string): number | null {
  const upper = String(token || '').trim().toUpperCase();
  if (!upper || !CANONICAL_ROMAN_RE.test(upper)) return null;
  const vals: Record<string, number> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };
  let total = 0;
  for (let i = 0; i < upper.length; i++) {
    const cur = vals[upper[i]] || 0;
    const next = i + 1 < upper.length ? vals[upper[i + 1]] || 0 : 0;
    total += cur < next ? -cur : cur;
  }
  return total >= 1 && total <= 3999 ? total : null;
}

function isSimpleIvxRoman(upper: string): boolean {
  return /^[IVX]+$/.test(upper) && parseCanonicalRomanNumeral(upper) !== null;
}

export function convertRomanNumeralsInTitle(text: string): string {
  const raw = String(text || '');
  if (!raw.trim()) return raw;

  // 1. Eindeutige Unicode-Zeichen für römische Ziffern (Ⅰ..Ⅻ, ⅰ..ⅻ, etc.) direkt umwandeln
  let working = raw.replace(/[\u2160-\u217F]+/g, (seq) => {
    const mapped = Array.from(seq)
      .map((ch) => UNICODE_ROMAN_MAP[ch] || '')
      .join('');
    const val = parseCanonicalRomanNumeral(mapped);
    return val !== null ? String(val) : seq;
  });

  // 2. ASCII-Wörter kontextsensitiv prüfen, damit englisches "I" (Ich), Tonarten ("in D") oder Wörter ("Mix", "CD") geschützt bleiben
  const tokenRe = /[A-Za-z]+/g;
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(working)) !== null) {
    const tok = match[0];
    const start = match.index;
    const end = start + tok.length;

    const prevCh = start > 0 ? working[start - 1] : '';
    const nextCh = end < working.length ? working[end] : '';

    // Nicht innerhalb von Wörtern, Apostrophen (I'm, I've, I'll, I'd), Ziffern oder Unterstrichen umwandeln
    if (/['’\d_]/.test(prevCh) || /['’\d_]/.test(nextCh)) continue;

    // Gemischte Groß-/Kleinschreibung (z. B. "Mix", "Vi", "Di", "Mi", "Liv", "Civ", "Iv") niemals als römische Zahl behandeln
    const isAllUpper = tok === tok.toUpperCase() && tok !== tok.toLowerCase();
    const isAllLower = tok === tok.toLowerCase() && tok !== tok.toUpperCase();
    if (!isAllUpper && !isAllLower) continue;

    const upper = tok.toUpperCase();
    const numericVal = parseCanonicalRomanNumeral(upper);
    if (numericVal === null) continue;

    const leftCtx = working.slice(0, start);
    const rightCtx = working.slice(end);

    // Abkürzungen/Initialen mit Punkten schützen (z. B. I.G.Y., V.I.P., A.I., W. I. Lenin)
    if (nextCh === '.' && (/^\.[A-Za-z]/.test(rightCtx) || /^\.\s*[A-Za-z]\./.test(rightCtx))) {
      continue;
    }
    if (prevCh === '.') continue;
    if (upper.length === 1 && /[A-Za-z]\.\s*$/.test(leftCtx) && /^\s*\./.test(rightCtx)) {
      continue;
    }

    // Schrägstrich-Schutz (z. B. I/O, V/H/S, A/V, AC/DC bleiben erhalten; I/II -> 1/2 wird umgewandelt)
    if (prevCh === '/' || nextCh === '/') {
      const leftNeighbor = prevCh === '/' ? /([A-Za-z]+)\/$/.exec(leftCtx)?.[1] : undefined;
      const rightNeighbor = nextCh === '/' ? /^\/([A-Za-z]+)/.exec(rightCtx)?.[1] : undefined;
      const leftOk = Boolean(leftNeighbor && parseCanonicalRomanNumeral(leftNeighbor) !== null);
      const rightOk = Boolean(rightNeighbor && parseCanonicalRomanNumeral(rightNeighbor) !== null);
      if (!leftOk && !rightOk) continue;
    }

    // Direkt verbundener Bindestrich/Gedankenstrich (z. B. X-Men, X-Ray, V-Sync, I-95, CD-ROM schützen; I–IV oder Part-II umwandeln)
    if (prevCh === '-' || prevCh === '–' || prevCh === '—' || nextCh === '-' || nextCh === '–' || nextCh === '—') {
      const leftNeighbor = /[-–—]$/.test(leftCtx)
        ? /([A-Za-z]+)[-–—]$/.exec(leftCtx)?.[1]
        : undefined;
      const rightNeighbor = /^[-–—]/.test(rightCtx)
        ? /^[-–—]([A-Za-z]+)/.exec(rightCtx)?.[1]
        : undefined;
      const leftRomanOk = Boolean(leftNeighbor && isSimpleIvxRoman(leftNeighbor.toUpperCase()));
      const rightRomanOk = Boolean(rightNeighbor && isSimpleIvxRoman(rightNeighbor.toUpperCase()));
      const leftPrefixOk = Boolean(
        leftNeighbor && ROMAN_EXPLICIT_PREFIX_RE.test(`${leftNeighbor} `)
      );
      if (!leftRomanOk && !rightRomanOk && !leftPrefixOk) continue;
    }

    // Ziffer direkt davor bei Einzelbuchstaben (z. B. "220 V", "12 V", "100 M") schützen
    if (upper.length === 1 && /\d\s*$/.test(leftCtx)) continue;

    // 1. Expliziter Kontext-Präfix ("Part I", "Pt. II", "Vol. IV", "Teil III", "Act I", "No. IX", ...)
    const hasExplicitPrefix =
      upper === 'X'
        ? ROMAN_X_SAFE_PREFIX_RE.test(leftCtx)
        : ROMAN_EXPLICIT_PREFIX_RE.test(leftCtx);

    if (hasExplicitPrefix && upper === 'I') {
      // Schutz gegen englische Sätze wie "The Part I Love" oder "A Book I Read"
      const hasDetBeforePrefix =
        /\b(?:the|a|an|this|that|my|your|his|her|our|their|every|only|one|first|last|best|worst|same|which)\s+[A-Za-zÀ-ÖØ-öø-ÿ]+\.?\s*$/i.test(
          leftCtx
        );
      if (ENGLISH_AFTER_I_VERBS_RE.test(rightCtx) || (hasDetBeforePrefix && /^\s+[A-Za-z]/.test(rightCtx))) {
        continue;
      }
    }

    // 2. Satz-/Tracknummern-Position ("I. Overture", "II. Allegro", "Symphony No. 9: IV. Finale", "I: Dawn")
    const atSegmentStart =
      leftCtx.trim() === '' || /(?:[:/(\[–—]|\s-)\s*$/.test(leftCtx);
    const hasEnumFollow =
      /^\.\s+\S/.test(rightCtx) ||
      /^:\s+\S/.test(rightCtx) ||
      (atSegmentStart && isAllUpper && /^\s+[-–—]\s+\S/.test(rightCtx));
    const isMovementEnumerator =
      atSegmentStart && hasEnumFollow && isSimpleIvxRoman(upper);

    // 3. Alleinstehend in Klammern: "(I)", "(II)", "[IV]", "(ii)"
    const isBracketedStandalone =
      ((/\(\s*$/.test(leftCtx) && /^\s*\)/.test(rightCtx)) ||
        (/\[\s*$/.test(leftCtx) && /^\s*\]/.test(rightCtx))) &&
      isSimpleIvxRoman(upper) &&
      (isAllUpper ? upper !== 'X' : upper.length >= 2);

    // 4. Gepaarte römische Bereiche/Listen ("I & II", "I–V", "IV & V", "IX & X")
    const rightPairToken = /^\s*(?:[-–—/,&]|\band\b|\bund\b)\s*([A-Za-z]+)\b/i.exec(rightCtx)?.[1];
    const leftPairToken = /\b([A-Za-z]+)\s*(?:[-–—/,&]|\band\b|\bund\b)\s*$/i.exec(leftCtx)?.[1];
    const isDirectRangePair =
      isAllUpper &&
      isSimpleIvxRoman(upper) &&
      ((/[-–—/]$/.test(leftCtx) &&
        Boolean(
          leftPairToken &&
            leftPairToken === leftPairToken.toUpperCase() &&
            isSimpleIvxRoman(leftPairToken)
        )) ||
        (/^[-–—/]/.test(rightCtx) &&
          Boolean(
            rightPairToken &&
              rightPairToken === rightPairToken.toUpperCase() &&
              isSimpleIvxRoman(rightPairToken)
          )));
    const isPairedRoman =
      isDirectRangePair ||
      (isAllUpper &&
        isSimpleIvxRoman(upper) &&
        (Boolean(
          rightPairToken &&
            rightPairToken === rightPairToken.toUpperCase() &&
            rightPairToken.length >= 2 &&
            isSimpleIvxRoman(rightPairToken)
        ) ||
          Boolean(
            leftPairToken &&
              leftPairToken === leftPairToken.toUpperCase() &&
              leftPairToken.length >= 2 &&
              isSimpleIvxRoman(leftPairToken)
          )));

    let shouldConvert = false;

    if (hasExplicitPrefix || isMovementEnumerator || isBracketedStandalone || isPairedRoman) {
      shouldConvert = true;
    } else if (isAllUpper) {
      if (upper.length >= 2 && isSimpleIvxRoman(upper)) {
        // z. B. II, III, IV, VI, VII, VIII, IX, XII..XXXIX
        if (
          upper === 'IV' &&
          /^\s+(?:drip|bag|tube|pole|line|therapy|solution)\b/i.test(rightCtx)
        ) {
          shouldConvert = false;
        } else {
          shouldConvert = true;
        }
      } else if (upper.length >= 4 && numericVal >= 40) {
        // Eindeutige mehrstellige Zahlen/Jahreszahlen wie MCMXC, MCMXCIX, MMXX, XLVIII
        shouldConvert = true;
      } else if (upper === 'V') {
        // Alleinstehendes "V" nur am Titelende / vor Klammer oder Trennzeichen nach gültigem Wort (z. B. "Rocky V", "Chronologie V")
        const prevWordMatch = /([A-Za-zÀ-ÖØ-öø-ÿ]{2,})\s+$/.exec(leftCtx);
        const rightEndOrDelim = /^\s*(?:$|[\)\]:–—\-\(\[,!?])/.test(rightCtx);
        if (prevWordMatch && rightEndOrDelim && !PRE_V_STOPWORDS.has(prevWordMatch[1].toLowerCase())) {
          shouldConvert = true;
        }
      } else if (upper === 'I') {
        // Alleinstehendes "I" ohne Präfix nur bei klarem Album-/Folgetitel-Muster (z. B. "Use Your Illusion I", NICHT "You and I", "I Will...", "I, Robot")
        const prevWordMatch = /([A-Za-zÀ-ÖØ-öø-ÿ]{2,})\s+$/.exec(leftCtx);
        const rightEndOrDelim = /^\s*(?:$|[\)\]:–—\-\(\[!?])/.test(rightCtx);
        if (
          leftCtx.trim() !== '' &&
          prevWordMatch &&
          rightEndOrDelim &&
          !PRE_I_STOPWORDS.has(prevWordMatch[1].toLowerCase())
        ) {
          shouldConvert = true;
        }
      }
    }

    if (shouldConvert) {
      replacements.push({ start, end, value: String(numericVal) });
    }
  }

  if (replacements.length === 0) return working;

  let out = '';
  let cursor = 0;
  for (const rep of replacements) {
    out += working.slice(cursor, rep.start) + rep.value;
    cursor = rep.end;
  }
  out += working.slice(cursor);
  return out;
}

export function applyRomanNumeralPreference(
  title: string,
  settings?: Pick<ExportSettings, 'convertRomanNumerals'>
): string {
  const clean = String(title || '');
  if (settings && settings.convertRomanNumerals === false) return clean;
  return convertRomanNumeralsInTitle(clean);
}

export function toGermanTitleCase(text: string): string {
  return text
    .split(/\s+/)
    .map((word) => {
      if (!word) return word;
      const coreMatch = /^([^A-Za-z]*)([A-Za-z]+)([^A-Za-z]*)$/.exec(word);
      if (coreMatch) {
        const [, pre, core, post] = coreMatch;
        if (
          core.length >= 2 &&
          core === core.toUpperCase() &&
          isSimpleIvxRoman(core)
        ) {
          return `${pre}${core}${post}`;
        }
      }
      return word.charAt(0).toLocaleUpperCase('de-DE') + word.slice(1).toLocaleLowerCase('de-DE');
    })
    .join(' ');
}

export interface ExtractedAudioMetadata {
  durationSeconds: number;
  title?: string;
  artist?: string;
  artists?: string[];
  artistSort?: string;
  albumArtist?: string;
  albumArtists?: string[];
  albumArtistSort?: string;
  album?: string;
  composer?: string;
  orchestra?: string;
  conductor?: string;
  lyricist?: string;
  writer?: string;
  producer?: string;
  work?: string;
  trackNumber?: number;
  discNumber?: number;
  discSubtitle?: string;
  year?: string;
  releaseDate?: string;
  originalDate?: string;
  genre?: string;
  isrc?: string;
  isrcs?: string[];
  barcode?: string;
  catalogNumber?: string;
  label?: string;
  asin?: string;
  country?: string;
  status?: string;
  releaseType?: string;
  mediaFormat?: string;
  script?: string;
  language?: string;
  mbReleaseId?: string;
  mbReleaseGroupId?: string;
  mbAlbumArtistId?: string;
  mbDiscId?: string;
  mbRecordingId?: string;
  mbTrackId?: string;
  mbArtistId?: string;
  mbWorkId?: string;
  mbComposerId?: string;
  extraTags?: Record<string, string[]>;
  coverBlobUrl?: string;
}

function readSynchsafeInt(view: DataView, offset: number): number {
  return (
    ((view.getUint8(offset) & 0x7f) << 21) |
    ((view.getUint8(offset + 1) & 0x7f) << 14) |
    ((view.getUint8(offset + 2) & 0x7f) << 7) |
    (view.getUint8(offset + 3) & 0x7f)
  );
}

function removeId3Unsync(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length);
  let j = 0;
  for (let i = 0; i < raw.length; i++) {
    out[j++] = raw[i];
    if (raw[i] === 0xff && i + 1 < raw.length && raw[i + 1] === 0x00) {
      i++;
    }
  }
  return out.subarray(0, j);
}

function decodeUtf16Segment(seg: Uint8Array, defaultLittleEndian: boolean): string {
  if (seg.length === 0) return '';
  let littleEndian = defaultLittleEndian;
  let start = 0;
  if (seg.length >= 2) {
    if (seg[0] === 0xff && seg[1] === 0xfe) {
      littleEndian = true;
      start = 2;
    } else if (seg[0] === 0xfe && seg[1] === 0xff) {
      littleEndian = false;
      start = 2;
    }
  }
  const body = seg.subarray(start);
  const evenLen = body.length - (body.length % 2);
  if (evenLen <= 0) return '';
  try {
    return new TextDecoder(littleEndian ? 'utf-16le' : 'utf-16be')
      .decode(body.subarray(0, evenLen))
      .replace(/^\uFEFF/, '')
      .trim();
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body).replace(/^\uFEFF/, '').trim();
  }
}

function decodeMultiTextFrame(bytes: Uint8Array): string[] {
  if (bytes.length === 0) return [];
  const encoding = bytes[0];
  const payload = bytes.subarray(1);
  if (payload.length === 0) return [];

  if (encoding === 1 || encoding === 2) {
    // 2-Byte-ausgerichtete Null-Terminatoren (\x00\x00) sauber trennen, damit doppelte BOMs in TXXX (Picard ID3v2.3) korrekt dekodiert werden
    const segments: string[] = [];
    let segStart = 0;
    let i = 0;
    while (i + 1 < payload.length) {
      if (payload[i] === 0 && payload[i + 1] === 0) {
        const decoded = decodeUtf16Segment(payload.subarray(segStart, i), encoding === 1);
        segments.push(decoded);
        i += 2;
        segStart = i;
      } else {
        i += 2;
      }
    }
    if (segStart < payload.length) {
      segments.push(decodeUtf16Segment(payload.subarray(segStart), encoding === 1));
    }
    return segments.filter(Boolean);
  }

  let decoded = '';
  try {
    decoded = new TextDecoder(encoding === 0 ? 'iso-8859-1' : 'utf-8').decode(payload);
  } catch {
    decoded = new TextDecoder('utf-8', { fatal: false }).decode(payload);
  }
  return decoded
    .split('\0')
    .map((s) => s.replace(/^\uFEFF/, '').trim())
    .filter(Boolean);
}

function decodeId3TxxxFrame(bytes: Uint8Array): { desc: string; vals: string[] } | null {
  if (bytes.length < 2) return null;
  const encoding = bytes[0];
  const payload = bytes.subarray(1);

  if (encoding === 1 || encoding === 2) {
    let sep = -1;
    for (let i = 0; i + 1 < payload.length; i += 2) {
      if (payload[i] === 0 && payload[i + 1] === 0) {
        sep = i;
        break;
      }
    }
    if (sep < 0) return null;
    const desc = decodeUtf16Segment(payload.subarray(0, sep), encoding === 1);
    const rest = payload.subarray(sep + 2);
    const vals: string[] = [];
    let segStart = 0;
    let i = 0;
    while (i + 1 < rest.length) {
      if (rest[i] === 0 && rest[i + 1] === 0) {
        const s = decodeUtf16Segment(rest.subarray(segStart, i), encoding === 1);
        if (s) vals.push(s);
        i += 2;
        segStart = i;
      } else {
        i += 2;
      }
    }
    if (segStart < rest.length) {
      const s = decodeUtf16Segment(rest.subarray(segStart), encoding === 1);
      if (s) vals.push(s);
    }
    if (!desc || vals.length === 0) return null;
    return { desc, vals };
  }

  let sep = -1;
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] === 0) {
      sep = i;
      break;
    }
  }
  if (sep < 0) return null;
  const dec = new TextDecoder(encoding === 0 ? 'iso-8859-1' : 'utf-8', { fatal: false });
  const desc = dec.decode(payload.subarray(0, sep)).replace(/^\uFEFF/, '').trim();
  const vals = dec
    .decode(payload.subarray(sep + 1))
    .split('\0')
    .map((s) => s.replace(/^\uFEFF/, '').trim())
    .filter(Boolean);
  if (!desc || vals.length === 0) return null;
  return { desc, vals };
}

function decodeTextFrame(bytes: Uint8Array): string {
  return decodeMultiTextFrame(bytes).join('; ');
}

function appendUniqueTag(current: string | undefined, value: string): string {
  return mergeMultiValues(current, value).join('; ');
}

function normalizeExtraTagKey(rawKey: string): string {
  const up = rawKey.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const aliasMap: Record<string, string> = {
    INITIALKEY: 'KEY',
    INITIAL_KEY: 'KEY',
    UNSYNCEDLYRICS: 'LYRICS',
    MUSICBRAINZ_ORIGINAL_ALBUM_ID: 'MUSICBRAINZ_ORIGINALALBUMID',
    MUSICBRAINZ_ORIGINAL_ARTIST_ID: 'MUSICBRAINZ_ORIGINALARTISTID',
  };
  return aliasMap[up] || up;
}

function consumeNamedTagIntoResult(
  result: Partial<ExtractedAudioMetadata>,
  rawKey: string,
  rawVals: string[]
): void {
  const vals = rawVals.map((v) => String(v || '').trim()).filter(Boolean);
  if (!vals.length) return;
  const cleanKey = rawKey.trim();
  if (!cleanKey) return;
  const k = cleanKey.toUpperCase().replace(/[\s-]+/g, '_');
  if (k === 'METADATA_BLOCK_PICTURE' || k === 'COVERART' || k === 'COVERARTMIME' || k === 'APIC' || k === 'COVR') {
    return;
  }

  const joined = vals.join('; ');
  if (k === 'TITLE') result.title = appendUniqueTag(result.title, joined);
  else if (k === 'ARTIST') result.artist = appendUniqueTag(result.artist, joined);
  else if (k === 'ARTISTS') result.artists = mergeMultiValues(result.artists, vals);
  else if (k === 'ARTISTSORT' || k === 'ARTIST_SORT') {
    result.artistSort = appendUniqueTag(result.artistSort, joined);
  } else if (k === 'ALBUMARTIST' || k === 'ALBUM_ARTIST') {
    result.albumArtist = appendUniqueTag(result.albumArtist, joined);
  } else if (k === 'ALBUMARTISTS' || k === 'ALBUM_ARTISTS') {
    result.albumArtists = mergeMultiValues(result.albumArtists, vals);
  } else if (k === 'ALBUMARTISTSORT' || k === 'ALBUM_ARTIST_SORT') {
    result.albumArtistSort = appendUniqueTag(result.albumArtistSort, joined);
  } else if (k === 'ALBUM') {
    result.album = appendUniqueTag(result.album, joined);
  } else if (k === 'TRACKNUMBER' || k === 'TRACK') {
    if (!result.trackNumber) {
      const n = parseInt(vals[0].split('/')[0], 10);
      if (Number.isFinite(n) && n > 0) result.trackNumber = n;
    }
  } else if (k === 'DISCNUMBER' || k === 'DISC') {
    if (!result.discNumber) {
      const n = parseInt(vals[0].split('/')[0], 10);
      if (Number.isFinite(n) && n > 0) result.discNumber = n;
    }
  } else if (k === 'TRACKTOTAL' || k === 'TOTALTRACKS' || k === 'DISCTOTAL' || k === 'TOTALDISCS') {
    // Structural counters handled separately
  } else if (k === 'DISCSUBTITLE' || k === 'DISC_SUBTITLE' || k === 'SETSUBTITLE') {
    result.discSubtitle = appendUniqueTag(result.discSubtitle, joined);
  } else if (k === 'DATE' || k === 'YEAR') {
    if (!result.releaseDate) result.releaseDate = vals[0];
    if (!result.year && vals[0].length >= 4) result.year = vals[0].slice(0, 4);
  } else if (k === 'ORIGINALDATE' || k === 'ORIGINAL_DATE' || k === 'ORIGINALYEAR' || k === 'ORIGINAL_YEAR') {
    if (!result.originalDate) result.originalDate = vals[0];
    if (!result.year && vals[0].length >= 4) result.year = vals[0].slice(0, 4);
  } else if (k === 'GENRE') {
    result.genre = appendUniqueTag(result.genre, joined);
  } else if (k === 'ISRC') {
    result.isrcs = mergeMultiValues(result.isrcs, vals);
    result.isrc = result.isrcs.join('; ');
  } else if (k === 'BARCODE' || k === 'EAN' || k === 'UPC') {
    result.barcode = appendUniqueTag(result.barcode, joined);
  } else if (k === 'CATALOGNUMBER' || k === 'CATALOG' || k === 'CATALOG_NUMBER') {
    result.catalogNumber = appendUniqueTag(result.catalogNumber, joined);
  } else if (k === 'LABEL' || k === 'ORGANIZATION' || k === 'PUBLISHER') {
    result.label = appendUniqueTag(result.label, joined);
  } else if (k === 'ASIN') {
    result.asin = appendUniqueTag(result.asin, joined);
  } else if (k === 'RELEASECOUNTRY' || k === 'MUSICBRAINZ_ALBUM_RELEASE_COUNTRY') {
    result.country = appendUniqueTag(result.country, joined);
  } else if (k === 'RELEASESTATUS' || k === 'MUSICBRAINZ_ALBUM_STATUS') {
    result.status = appendUniqueTag(result.status, joined);
  } else if (k === 'RELEASETYPE' || k === 'MUSICBRAINZ_ALBUM_TYPE') {
    result.releaseType = appendUniqueTag(result.releaseType, joined);
  } else if (k === 'MEDIA') {
    result.mediaFormat = appendUniqueTag(result.mediaFormat, joined);
  } else if (k === 'SCRIPT') {
    result.script = appendUniqueTag(result.script, joined);
  } else if (k === 'LANGUAGE') {
    result.language = appendUniqueTag(result.language, joined);
  } else if (k === 'COMPOSER') {
    result.composer = appendUniqueTag(result.composer, joined);
  } else if (k === 'CONDUCTOR') {
    result.conductor = appendUniqueTag(result.conductor, joined);
  } else if (k === 'LYRICIST') {
    result.lyricist = appendUniqueTag(result.lyricist, joined);
  } else if (k === 'WRITER') {
    result.writer = appendUniqueTag(result.writer, joined);
  } else if (k === 'PRODUCER') {
    result.producer = appendUniqueTag(result.producer, joined);
  } else if (k === 'WORK') {
    result.work = appendUniqueTag(result.work, joined);
  } else if (k === 'PERFORMER') {
    for (const v of vals) {
      const orchMatch = v.match(/^\s*(.+?)\s*\((?:orchestra|performing orchestra|ensemble)\)\s*$/i);
      if (orchMatch && orchMatch[1]) {
        result.orchestra = appendUniqueTag(result.orchestra, orchMatch[1]);
      } else {
        if (!result.extraTags) result.extraTags = {};
        result.extraTags.PERFORMER = mergeMultiValues(result.extraTags.PERFORMER, v);
      }
    }
  } else if (k === 'ORCHESTRA' || k === 'ENSEMBLE') {
    result.orchestra = appendUniqueTag(result.orchestra, joined);
  } else if (
    k === 'MUSICBRAINZ_ALBUMID' ||
    k === 'MUSICBRAINZ_ALBUM_ID' ||
    k === 'MUSICBRAINZ_RELEASEID' ||
    k === 'MUSICBRAINZ_RELEASE_ID'
  ) {
    if (!result.mbReleaseId) result.mbReleaseId = vals[0];
  } else if (k === 'MUSICBRAINZ_RELEASEGROUPID' || k === 'MUSICBRAINZ_RELEASE_GROUP_ID') {
    if (!result.mbReleaseGroupId) result.mbReleaseGroupId = vals[0];
  } else if (k === 'MUSICBRAINZ_ALBUMARTISTID' || k === 'MUSICBRAINZ_ALBUM_ARTIST_ID') {
    result.mbAlbumArtistId = appendUniqueTag(result.mbAlbumArtistId, joined);
  } else if (k === 'MUSICBRAINZ_DISCID' || k === 'MUSICBRAINZ_DISC_ID') {
    if (!result.mbDiscId) result.mbDiscId = vals[0];
  } else if (
    k === 'MUSICBRAINZ_TRACKID' ||
    k === 'MUSICBRAINZ_TRACK_ID' ||
    k === 'MUSICBRAINZ_RECORDINGID' ||
    k === 'MUSICBRAINZ_RECORDING_ID'
  ) {
    if (!result.mbRecordingId) result.mbRecordingId = vals[0];
  } else if (k === 'MUSICBRAINZ_RELEASETRACKID' || k === 'MUSICBRAINZ_RELEASE_TRACK_ID') {
    if (!result.mbTrackId) result.mbTrackId = vals[0];
  } else if (k === 'MUSICBRAINZ_ARTISTID' || k === 'MUSICBRAINZ_ARTIST_ID') {
    result.mbArtistId = appendUniqueTag(result.mbArtistId, joined);
  } else if (k === 'MUSICBRAINZ_WORKID' || k === 'MUSICBRAINZ_WORK_ID') {
    result.mbWorkId = appendUniqueTag(result.mbWorkId, joined);
  } else if (k === 'MUSICBRAINZ_COMPOSERID' || k === 'MUSICBRAINZ_COMPOSER_ID') {
    result.mbComposerId = appendUniqueTag(result.mbComposerId, joined);
  } else {
    const normKey = cleanKey.toUpperCase().startsWith('PERFORMER:')
      ? `PERFORMER:${cleanKey.slice(cleanKey.indexOf(':') + 1).trim()}`
      : normalizeExtraTagKey(cleanKey);
    if (normKey) {
      if (!result.extraTags) result.extraTags = {};
      result.extraTags[normKey] = mergeMultiValues(result.extraTags[normKey], vals);
    }
  }
}

function parseVorbisCommentBlock(
  bytes: Uint8Array,
  view: DataView,
  startOffset: number,
  endOffset: number,
  result: Partial<ExtractedAudioMetadata>
): void {
  let p = startOffset;
  if (p + 4 > endOffset) return;
  const vendorLen = view.getUint32(p, true);
  p += 4 + vendorLen;
  if (p + 4 > endOffset) return;
  const count = view.getUint32(p, true);
  p += 4;
  const dec = new TextDecoder('utf-8', { fatal: false });
  for (let i = 0; i < count && p + 4 <= endOffset; i++) {
    const cLen = view.getUint32(p, true);
    p += 4;
    if (p + cLen > endOffset) break;
    const comment = dec.decode(bytes.subarray(p, p + cLen));
    p += cLen;
    const eq = comment.indexOf('=');
    if (eq > 0) {
      const key = comment.slice(0, eq).trim();
      const val = comment.slice(eq + 1).trim();
      if (key && val) {
        consumeNamedTagIntoResult(result, key, [val]);
      }
    }
  }
}

async function parseBinaryAudioTags(file: File): Promise<Partial<ExtractedAudioMetadata>> {
  const result: Partial<ExtractedAudioMetadata> = {};
  try {
    const headLen = Math.min(file.size, 64 * 1024);
    const headBuf = await file.slice(0, headLen).arrayBuffer();
    const headView = new DataView(headBuf);
    const headBytes = new Uint8Array(headBuf);

    // Optional führender ID3v2-Header-Offset (z. B. FLAC mit vorangestelltem ID3v2)
    let leadingId3End = 0;
    if (
      headBytes.length >= 10 &&
      headBytes[0] === 0x49 &&
      headBytes[1] === 0x44 &&
      headBytes[2] === 0x33
    ) {
      const id3Flags = headBytes[5];
      const hasFooter = (id3Flags & 0x10) !== 0;
      leadingId3End = 10 + readSynchsafeInt(headView, 6) + (hasFooter ? 10 : 0);
    }

    // 1. FLAC ("fLaC") – dynamisch Block für Block direkt aus der Datei lesen (kein 512-KB-Abschnitt bei großen Covern!)
    let flacStart = -1;
    if (
      headBytes.length >= 4 &&
      headBytes[0] === 0x66 &&
      headBytes[1] === 0x4c &&
      headBytes[2] === 0x61 &&
      headBytes[3] === 0x43
    ) {
      flacStart = 0;
    } else if (leadingId3End > 0 && leadingId3End + 4 <= file.size) {
      const probeBuf = await file.slice(leadingId3End, leadingId3End + 4).arrayBuffer();
      const pb = new Uint8Array(probeBuf);
      if (pb[0] === 0x66 && pb[1] === 0x4c && pb[2] === 0x61 && pb[3] === 0x43) {
        flacStart = leadingId3End;
      }
    }

    if (flacStart >= 0) {
      let offset = flacStart + 4;
      let isLast = false;
      let blockGuard = 0;
      while (!isLast && offset + 4 <= file.size && blockGuard < 64) {
        blockGuard++;
        const hdrBuf = await file.slice(offset, offset + 4).arrayBuffer();
        const hv = new DataView(hdrBuf);
        const header = hv.getUint8(0);
        isLast = (header & 0x80) !== 0;
        const blockType = header & 0x7f;
        const blockLen =
          (hv.getUint8(1) << 16) | (hv.getUint8(2) << 8) | hv.getUint8(3);
        offset += 4;
        if (offset + blockLen > file.size) break;

        if (blockType === 0 && blockLen >= 34) {
          const blkBuf = await file.slice(offset, offset + 34).arrayBuffer();
          const bv = new DataView(blkBuf);
          const sr =
            (bv.getUint8(10) << 12) | (bv.getUint8(11) << 4) | (bv.getUint8(12) >> 4);
          const hiSamples = bv.getUint8(13) & 0x0f;
          const loSamples = bv.getUint32(14, false);
          const totalSamples = hiSamples * 4294967296 + loSamples;
          if (sr > 0 && totalSamples > 0) {
            result.durationSeconds = totalSamples / sr;
          }
        } else if (blockType === 4 && blockLen <= 16 * 1024 * 1024) {
          const blkBuf = await file.slice(offset, offset + blockLen).arrayBuffer();
          parseVorbisCommentBlock(
            new Uint8Array(blkBuf),
            new DataView(blkBuf),
            0,
            blockLen,
            result
          );
        } else if (blockType === 6 && !result.coverBlobUrl && blockLen <= 32 * 1024 * 1024) {
          const blkBuf = await file.slice(offset, offset + blockLen).arrayBuffer();
          const bv = new DataView(blkBuf);
          const bb = new Uint8Array(blkBuf);
          let p = 4; // skip picture type
          if (p + 4 <= blockLen) {
            const mimeLen = bv.getUint32(p, false);
            p += 4;
            const mime =
              new TextDecoder('ascii').decode(bb.subarray(p, p + mimeLen)) || 'image/jpeg';
            p += mimeLen;
            if (p + 4 <= blockLen) {
              const descLen = bv.getUint32(p, false);
              p += 4 + descLen + 16; // skip width, height, depth, colors
              if (p + 4 <= blockLen) {
                const dataLen = bv.getUint32(p, false);
                p += 4;
                if (dataLen > 64 && p + dataLen <= blockLen) {
                  const picBytes = bb.slice(p, p + dataLen);
                  result.coverBlobUrl = URL.createObjectURL(new Blob([picBytes], { type: mime }));
                }
              }
            }
          }
        }
        offset += blockLen;
      }
    }

    // 2. OGG Vorbis / Opus ("OggS") – Vorbis Comment / OpusTags aus den ersten Ogg-Pages auslesen
    if (
      headBytes.length >= 28 &&
      headBytes[0] === 0x4f &&
      headBytes[1] === 0x67 &&
      headBytes[2] === 0x67 &&
      headBytes[3] === 0x53
    ) {
      const oggScanLen = Math.min(file.size, 2 * 1024 * 1024);
      const oggBuf = oggScanLen <= headBuf.byteLength ? headBuf : await file.slice(0, oggScanLen).arrayBuffer();
      const oggBytes = new Uint8Array(oggBuf);
      let pos = 0;
      let packetChunks: Uint8Array[] = [];
      let packetsParsed = 0;
      while (pos + 27 <= oggBytes.length && packetsParsed < 3) {
        if (
          oggBytes[pos] !== 0x4f ||
          oggBytes[pos + 1] !== 0x67 ||
          oggBytes[pos + 2] !== 0x67 ||
          oggBytes[pos + 3] !== 0x53
        ) {
          break;
        }
        const segCount = oggBytes[pos + 26];
        if (pos + 27 + segCount > oggBytes.length) break;
        const segTableStart = pos + 27;
        let dataPos = segTableStart + segCount;
        for (let s = 0; s < segCount; s++) {
          const segLen = oggBytes[segTableStart + s];
          if (dataPos + segLen > oggBytes.length) {
            dataPos = oggBytes.length;
            break;
          }
          if (segLen > 0) {
            packetChunks.push(oggBytes.subarray(dataPos, dataPos + segLen));
          }
          dataPos += segLen;
          if (segLen < 255) {
            const totalLen = packetChunks.reduce((acc, c) => acc + c.length, 0);
            const pkt = new Uint8Array(totalLen);
            let w = 0;
            for (const c of packetChunks) {
              pkt.set(c, w);
              w += c.length;
            }
            packetChunks = [];
            packetsParsed++;
            // Vorbis Comment Packet: \x03vorbis
            if (
              pkt.length > 7 &&
              pkt[0] === 0x03 &&
              pkt[1] === 0x76 &&
              pkt[2] === 0x6f &&
              pkt[3] === 0x72 &&
              pkt[4] === 0x62 &&
              pkt[5] === 0x69 &&
              pkt[6] === 0x73
            ) {
              parseVorbisCommentBlock(pkt, new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength), 7, pkt.length, result);
            } else if (
              pkt.length > 8 &&
              pkt[0] === 0x4f &&
              pkt[1] === 0x70 &&
              pkt[2] === 0x75 &&
              pkt[3] === 0x73 &&
              pkt[4] === 0x54 &&
              pkt[5] === 0x61 &&
              pkt[6] === 0x67 &&
              pkt[7] === 0x73
            ) {
              // OpusTags
              parseVorbisCommentBlock(pkt, new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength), 8, pkt.length, result);
            }
          }
        }
        pos = dataPos;
      }
    }

    // 3. MP4 / M4A (ISO BMFF "ftyp") – moov -> udta -> meta -> ilst inkl. ---- (iTunes Freeform: ReplayGain, MusicBrainz, AcoustID)
    if (
      headBytes.length >= 12 &&
      headBytes[4] === 0x66 &&
      headBytes[5] === 0x74 &&
      headBytes[6] === 0x79 &&
      headBytes[7] === 0x70
    ) {
      const readBoxHeader = async (
        off: number,
        limit: number
      ): Promise<{ type: string; headerSize: number; boxEnd: number } | null> => {
        if (off + 8 > limit) return null;
        const b = await file.slice(off, Math.min(limit, off + 16)).arrayBuffer();
        const dv = new DataView(b);
        const u8 = new Uint8Array(b);
        let size = dv.getUint32(0, false);
        const type = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
        let headerSize = 8;
        if (size === 1 && b.byteLength >= 16) {
          size = dv.getUint32(8, false) * 4294967296 + dv.getUint32(12, false);
          headerSize = 16;
        } else if (size === 0) {
          size = limit - off;
        }
        if (size < headerSize) return null;
        return { type, headerSize, boxEnd: Math.min(limit, off + size) };
      };

      const findChildBox = async (
        start: number,
        end: number,
        targetType: string
      ): Promise<{ dataStart: number; boxEnd: number } | null> => {
        let p = start;
        let guard = 0;
        while (p + 8 <= end && guard < 128) {
          guard++;
          const hdr = await readBoxHeader(p, end);
          if (!hdr) break;
          if (hdr.type === targetType) {
            return { dataStart: p + hdr.headerSize, boxEnd: hdr.boxEnd };
          }
          if (hdr.boxEnd <= p) break;
          p = hdr.boxEnd;
        }
        return null;
      };

      const moov = await findChildBox(0, file.size, 'moov');
      if (moov) {
        const udta = await findChildBox(moov.dataStart, moov.boxEnd, 'udta');
        const meta = udta ? await findChildBox(udta.dataStart, udta.boxEnd, 'meta') : null;
        // meta is a FullBox (+4 bytes version/flags)
        const ilst = meta ? await findChildBox(meta.dataStart + 4, meta.boxEnd, 'ilst') : null;
        if (ilst && ilst.boxEnd - ilst.dataStart <= 24 * 1024 * 1024) {
          const ilstBuf = await file.slice(ilst.dataStart, ilst.boxEnd).arrayBuffer();
          const iv = new DataView(ilstBuf);
          const ib = new Uint8Array(ilstBuf);
          const decUtf8 = new TextDecoder('utf-8', { fatal: false });
          const mp4TextMap: Record<string, string> = {
            '\xa9nam': 'TITLE',
            '\xa9ART': 'ARTIST',
            aART: 'ALBUMARTIST',
            '\xa9alb': 'ALBUM',
            '\xa9day': 'DATE',
            '\xa9gen': 'GENRE',
            '\xa9wrt': 'COMPOSER',
            '\xa9cmt': 'COMMENT',
            '\xa9lyr': 'LYRICS',
            '\xa9grp': 'GROUPING',
            '\xa9too': 'ENCODEDBY',
            cprt: 'COPYRIGHT',
            soar: 'ARTISTSORT',
            soaa: 'ALBUMARTISTSORT',
            soal: 'ALBUMSORT',
            sonm: 'TITLESORT',
            soco: 'COMPOSERSORT',
            '\xa9mvn': 'MOVEMENTNAME',
            '\xa9wrk': 'WORK',
          };
          let p = 0;
          while (p + 8 <= ib.length) {
            const atomSize = iv.getUint32(p, false);
            if (atomSize < 8 || p + atomSize > ib.length) break;
            const atomType = String.fromCharCode(ib[p + 4], ib[p + 5], ib[p + 6], ib[p + 7]);
            const atomEnd = p + atomSize;
            let sp = p + 8;
            let freeformName = '';
            const dataPayloads: Array<{ dataType: number; bytes: Uint8Array }> = [];
            while (sp + 8 <= atomEnd) {
              const subSize = iv.getUint32(sp, false);
              if (subSize < 8 || sp + subSize > atomEnd) break;
              const subType = String.fromCharCode(ib[sp + 4], ib[sp + 5], ib[sp + 6], ib[sp + 7]);
              if (subType === 'name' && subSize > 12) {
                freeformName = decUtf8.decode(ib.subarray(sp + 12, sp + subSize)).trim();
              } else if (subType === 'data' && subSize >= 16) {
                const dataType = iv.getUint32(sp + 8, false);
                dataPayloads.push({
                  dataType,
                  bytes: ib.subarray(sp + 16, sp + subSize),
                });
              }
              sp += subSize;
            }
            if (atomType === '----' && freeformName && dataPayloads.length > 0) {
              const vals = dataPayloads
                .map((dp) => decUtf8.decode(dp.bytes).trim())
                .filter(Boolean);
              if (vals.length > 0) {
                consumeNamedTagIntoResult(result, freeformName, vals);
              }
            } else if (atomType === 'trkn' && dataPayloads[0] && dataPayloads[0].bytes.length >= 4) {
              const dv = new DataView(
                dataPayloads[0].bytes.buffer,
                dataPayloads[0].bytes.byteOffset,
                dataPayloads[0].bytes.byteLength
              );
              const n = dv.getUint16(2, false);
              if (n > 0 && !result.trackNumber) result.trackNumber = n;
            } else if (atomType === 'disk' && dataPayloads[0] && dataPayloads[0].bytes.length >= 4) {
              const dv = new DataView(
                dataPayloads[0].bytes.buffer,
                dataPayloads[0].bytes.byteOffset,
                dataPayloads[0].bytes.byteLength
              );
              const n = dv.getUint16(2, false);
              if (n > 0 && !result.discNumber) result.discNumber = n;
            } else if (atomType === 'tmpo' && dataPayloads[0] && dataPayloads[0].bytes.length >= 2) {
              const dv = new DataView(
                dataPayloads[0].bytes.buffer,
                dataPayloads[0].bytes.byteOffset,
                dataPayloads[0].bytes.byteLength
              );
              const bpm = dv.getUint16(0, false);
              if (bpm > 0) consumeNamedTagIntoResult(result, 'BPM', [String(bpm)]);
            } else if (atomType === 'cpil' && dataPayloads[0] && dataPayloads[0].bytes.length >= 1) {
              if (dataPayloads[0].bytes[0] > 0) consumeNamedTagIntoResult(result, 'COMPILATION', ['1']);
            } else if (atomType === 'covr' && !result.coverBlobUrl && dataPayloads[0] && dataPayloads[0].bytes.length > 64) {
              const mime = dataPayloads[0].dataType === 14 ? 'image/png' : 'image/jpeg';
              result.coverBlobUrl = URL.createObjectURL(
                new Blob([dataPayloads[0].bytes.slice()], { type: mime })
              );
            } else if (mp4TextMap[atomType] && dataPayloads.length > 0) {
              const vals = dataPayloads
                .map((dp) => decUtf8.decode(dp.bytes).trim())
                .filter(Boolean);
              if (vals.length > 0) {
                consumeNamedTagIntoResult(result, mp4TextMap[atomType], vals);
              }
            }
            p = atomEnd;
          }
        }
      }
    }

    // 4. ID3v2 ("ID3") – direkt am Dateianfang (MP3/MP2/TTA) oder im RIFF WAVE / AIFF / DSF Container (volle Tag-Größe bis 32 MB!)
    const findId3Buffer = async (): Promise<ArrayBuffer | null> => {
      if (
        headBytes.length >= 10 &&
        headBytes[0] === 0x49 &&
        headBytes[1] === 0x44 &&
        headBytes[2] === 0x33
      ) {
        const tagSize = readSynchsafeInt(headView, 6);
        const totalNeed = Math.min(file.size, Math.min(32 * 1024 * 1024, 10 + tagSize));
        if (totalNeed <= headBuf.byteLength) return headBuf.slice(0, totalNeed);
        return await file.slice(0, totalNeed).arrayBuffer();
      }

      // RIFF WAVE ("RIFF....WAVE") -> suche Chunk "id3 " oder "ID3 "
      if (
        headBytes.length >= 12 &&
        headBytes[0] === 0x52 &&
        headBytes[1] === 0x49 &&
        headBytes[2] === 0x46 &&
        headBytes[3] === 0x46 &&
        headBytes[8] === 0x57 &&
        headBytes[9] === 0x41 &&
        headBytes[10] === 0x56 &&
        headBytes[11] === 0x45
      ) {
        let p = 12;
        while (p + 8 <= file.size) {
          const hdrBuf =
            p + 8 <= headBytes.length
              ? headBuf.slice(p, p + 8)
              : await file.slice(p, p + 8).arrayBuffer();
          const hv = new DataView(hdrBuf);
          const hb = new Uint8Array(hdrBuf);
          const cid = String.fromCharCode(hb[0], hb[1], hb[2], hb[3]);
          const csize = hv.getUint32(4, true);
          p += 8;
          if (cid.toLowerCase() === 'id3 ' && csize >= 10) {
            return await file.slice(p, Math.min(file.size, p + Math.min(csize, 32 * 1024 * 1024))).arrayBuffer();
          }
          const step = csize + (csize % 2);
          if (step <= 0) break;
          p += step;
        }
      }

      // AIFF / AIFC ("FORM....AIFF" / "FORM....AIFC") -> suche Chunk "ID3 "
      if (
        headBytes.length >= 12 &&
        headBytes[0] === 0x46 &&
        headBytes[1] === 0x4f &&
        headBytes[2] === 0x52 &&
        headBytes[3] === 0x4d &&
        headBytes[8] === 0x41 &&
        headBytes[9] === 0x49 &&
        headBytes[10] === 0x46 &&
        (headBytes[11] === 0x46 || headBytes[11] === 0x43)
      ) {
        let p = 12;
        while (p + 8 <= file.size) {
          const hdrBuf =
            p + 8 <= headBytes.length
              ? headBuf.slice(p, p + 8)
              : await file.slice(p, p + 8).arrayBuffer();
          const hv = new DataView(hdrBuf);
          const hb = new Uint8Array(hdrBuf);
          const cid = String.fromCharCode(hb[0], hb[1], hb[2], hb[3]);
          const csize = hv.getUint32(4, false);
          p += 8;
          if (cid.toLowerCase() === 'id3 ' && csize >= 10) {
            return await file.slice(p, Math.min(file.size, p + Math.min(csize, 32 * 1024 * 1024))).arrayBuffer();
          }
          const step = csize + (csize % 2);
          if (step <= 0) break;
          p += step;
        }
      }

      // DSF ("DSD ") -> 64-Bit-Little-Endian Offset zu ID3v2 bei Byte 20
      if (
        headBytes.length >= 28 &&
        headBytes[0] === 0x44 &&
        headBytes[1] === 0x53 &&
        headBytes[2] === 0x44 &&
        headBytes[3] === 0x20
      ) {
        const lo = headView.getUint32(20, true);
        const hi = headView.getUint32(24, true);
        const id3Ptr = hi * 4294967296 + lo;
        if (id3Ptr >= 28 && id3Ptr + 10 <= file.size) {
          const hdr = await file.slice(id3Ptr, id3Ptr + 10).arrayBuffer();
          const hv = new DataView(hdr);
          const tagSize = readSynchsafeInt(hv, 6);
          const totalNeed = Math.min(file.size - id3Ptr, Math.min(32 * 1024 * 1024, 10 + tagSize));
          return await file.slice(id3Ptr, id3Ptr + totalNeed).arrayBuffer();
        }
      }

      return null;
    };

    const id3Buf = await findId3Buffer();
    if (id3Buf) {
      const id3View = new DataView(id3Buf);
      const rawId3Bytes = new Uint8Array(id3Buf);
      if (
        rawId3Bytes.length >= 10 &&
        rawId3Bytes[0] === 0x49 &&
        rawId3Bytes[1] === 0x44 &&
        rawId3Bytes[2] === 0x33
      ) {
        const version = rawId3Bytes[3];
        const headerFlags = rawId3Bytes[5];
        const tagUnsync = (headerFlags & 0x80) !== 0;
        const hasExtHeader = (headerFlags & 0x40) !== 0;
        const tagSize = readSynchsafeInt(id3View, 6);
        const rawBody = rawId3Bytes.subarray(10, Math.min(rawId3Bytes.length, 10 + tagSize));
        // Bei ID3v2.2 / v2.3 gilt Unsynchronisation global für den gesamten Tag-Body
        const bodyBytes = tagUnsync && version < 4 ? removeId3Unsync(rawBody) : rawBody;
        const bodyView = new DataView(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength);

        let pos = 0;
        if (hasExtHeader && pos + 4 <= bodyBytes.length) {
          const extSize =
            version === 4 ? readSynchsafeInt(bodyView, pos) : bodyView.getUint32(pos, false) + 4;
          if (extSize >= 4 && pos + extSize <= bodyBytes.length) {
            pos += extSize;
          }
        }

        const id3SimpleMap: Record<string, string> = {
          TIT2: 'TITLE',
          TT2: 'TITLE',
          TPE1: 'ARTIST',
          TP1: 'ARTIST',
          TPE2: 'ALBUMARTIST',
          TP2: 'ALBUMARTIST',
          TALB: 'ALBUM',
          TAL: 'ALBUM',
          TRCK: 'TRACKNUMBER',
          TRK: 'TRACKNUMBER',
          TPOS: 'DISCNUMBER',
          TPA: 'DISCNUMBER',
          TSST: 'DISCSUBTITLE',
          TDRC: 'DATE',
          TYER: 'DATE',
          TYE: 'DATE',
          TDOR: 'ORIGINALDATE',
          TORY: 'ORIGINALDATE',
          TCON: 'GENRE',
          TCO: 'GENRE',
          TPUB: 'LABEL',
          TPB: 'LABEL',
          TCOM: 'COMPOSER',
          TCM: 'COMPOSER',
          TPE3: 'CONDUCTOR',
          TP3: 'CONDUCTOR',
          TPE4: 'REMIXER',
          TEXT: 'LYRICIST',
          TMED: 'MEDIA',
          TLAN: 'LANGUAGE',
          TSRC: 'ISRC',
          TRC: 'ISRC',
          TSOP: 'ARTISTSORT',
          TSO2: 'ALBUMARTISTSORT',
          TSOA: 'ALBUMSORT',
          TSOT: 'TITLESORT',
          TSOC: 'COMPOSERSORT',
          TIT1: 'GROUPING',
          TIT3: 'SUBTITLE',
          TCOP: 'COPYRIGHT',
          TCMP: 'COMPILATION',
          TBPM: 'BPM',
          TBP: 'BPM',
          TKEY: 'KEY',
          TMOO: 'MOOD',
          TENC: 'ENCODEDBY',
          TSSE: 'ENCODERSETTINGS',
          TOFN: 'ORIGINALFILENAME',
          MVNM: 'MOVEMENTNAME',
          MVIN: 'MOVEMENT',
        };

        const isV22 = version === 2;
        const frameHdrLen = isV22 ? 6 : 10;
        while (pos + frameHdrLen <= bodyBytes.length) {
          if (bodyBytes[pos] === 0) break; // Padding erreicht
          const frameId = isV22
            ? String.fromCharCode(bodyBytes[pos], bodyBytes[pos + 1], bodyBytes[pos + 2])
            : String.fromCharCode(
                bodyBytes[pos],
                bodyBytes[pos + 1],
                bodyBytes[pos + 2],
                bodyBytes[pos + 3]
              );
          if (!(isV22 ? /^[A-Z0-9]{3}$/ : /^[A-Z0-9]{4}$/).test(frameId)) break;

          let frameSize = 0;
          let frameFlags2 = 0;
          if (isV22) {
            frameSize =
              (bodyBytes[pos + 3] << 16) | (bodyBytes[pos + 4] << 8) | bodyBytes[pos + 5];
          } else {
            frameSize =
              version === 4
                ? readSynchsafeInt(bodyView, pos + 4)
                : bodyView.getUint32(pos + 4, false);
            // Toleranter Fallback falls ein ID3v2.4-Writer eine reguläre 32-Bit-Größe statt Synchsafe geschrieben hat
            if (version === 4 && (pos + 10 + frameSize > bodyBytes.length || frameSize <= 0)) {
              const altSize = bodyView.getUint32(pos + 4, false);
              if (altSize > 0 && pos + 10 + altSize <= bodyBytes.length) {
                frameSize = altSize;
              }
            }
            frameFlags2 = bodyBytes[pos + 9];
          }
          pos += frameHdrLen;
          if (frameSize <= 0 || pos + frameSize > bodyBytes.length) break;

          let frameBytes = bodyBytes.subarray(pos, pos + frameSize);
          pos += frameSize;

          if (version === 4) {
            const frameUnsync = tagUnsync || (frameFlags2 & 0x02) !== 0;
            const hasDataLenInd = (frameFlags2 & 0x01) !== 0;
            if (hasDataLenInd && frameBytes.length > 4) {
              frameBytes = frameBytes.subarray(4);
            }
            if (frameUnsync) {
              frameBytes = removeId3Unsync(frameBytes);
            }
          }

          if (id3SimpleMap[frameId]) {
            const vals = decodeMultiTextFrame(frameBytes);
            if (vals.length > 0) {
              consumeNamedTagIntoResult(result, id3SimpleMap[frameId], vals);
            }
          } else if (frameId === 'TMCL' || frameId === 'TIPL' || frameId === 'IPLS') {
            const pairs = decodeMultiTextFrame(frameBytes);
            for (let i = 0; i + 1 < pairs.length; i += 2) {
              const role = pairs[i].trim();
              const roleLow = role.toLowerCase();
              const person = pairs[i + 1].trim();
              if (!person) continue;
              if (roleLow === 'orchestra' || roleLow === 'performing orchestra' || roleLow === 'ensemble') {
                result.orchestra = appendUniqueTag(result.orchestra, person);
              } else if (roleLow === 'producer') {
                result.producer = appendUniqueTag(result.producer, person);
              } else if (roleLow === 'arranger') {
                consumeNamedTagIntoResult(result, 'ARRANGER', [person]);
              } else if (roleLow === 'engineer') {
                consumeNamedTagIntoResult(result, 'ENGINEER', [person]);
              } else if (roleLow === 'mix' || roleLow === 'mixer') {
                consumeNamedTagIntoResult(result, 'MIXER', [person]);
              } else if (roleLow === 'dj-mix' || roleLow === 'djmixer') {
                consumeNamedTagIntoResult(result, 'DJMIXER', [person]);
              } else {
                const roleKey = role && roleLow !== 'performer' ? `PERFORMER:${role}` : 'PERFORMER';
                consumeNamedTagIntoResult(result, roleKey, [person]);
              }
            }
          } else if (frameId === 'TXXX' || frameId === 'TXX') {
            const parsedTxxx = decodeId3TxxxFrame(frameBytes);
            if (parsedTxxx) {
              consumeNamedTagIntoResult(result, parsedTxxx.desc, parsedTxxx.vals);
            }
          } else if (frameId === 'UFID' || frameId === 'UFI') {
            let nul = -1;
            for (let i = 0; i < frameBytes.length; i++) {
              if (frameBytes[i] === 0) {
                nul = i;
                break;
              }
            }
            if (nul > 0 && nul + 1 < frameBytes.length) {
              const owner = new TextDecoder('ascii').decode(frameBytes.subarray(0, nul)).toLowerCase();
              if (owner.includes('musicbrainz.org') && !result.mbRecordingId) {
                const rid = new TextDecoder('ascii').decode(frameBytes.subarray(nul + 1)).trim();
                if (rid) result.mbRecordingId = rid;
              }
            }
          } else if (frameId === 'RVA2') {
            let nul = -1;
            for (let i = 0; i < frameBytes.length; i++) {
              if (frameBytes[i] === 0) {
                nul = i;
                break;
              }
            }
            if (nul >= 0 && nul + 5 <= frameBytes.length) {
              const ident = new TextDecoder('ascii').decode(frameBytes.subarray(0, nul)).trim().toLowerCase();
              const dv = new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);
              const gainRaw = dv.getInt16(nul + 2, false);
              const gainDb = gainRaw / 512.0;
              const peakBits = frameBytes[nul + 4];
              const peakBytes = Math.ceil(peakBits / 8);
              let peakVal = 0;
              if (peakBits > 0 && peakBytes > 0 && nul + 5 + peakBytes <= frameBytes.length) {
                let acc = 0;
                for (let b = 0; b < peakBytes; b++) {
                  acc = acc * 256 + frameBytes[nul + 5 + b];
                }
                const denom = Math.pow(2, Math.max(1, peakBits - 1));
                peakVal = acc / denom;
              }
              const gainStr = `${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(2)} dB`;
              if (ident === 'track' || ident === '') {
                if (!result.extraTags?.REPLAYGAIN_TRACK_GAIN) {
                  consumeNamedTagIntoResult(result, 'REPLAYGAIN_TRACK_GAIN', [gainStr]);
                }
                if (peakVal > 0 && !result.extraTags?.REPLAYGAIN_TRACK_PEAK) {
                  consumeNamedTagIntoResult(result, 'REPLAYGAIN_TRACK_PEAK', [peakVal.toFixed(6)]);
                }
              } else if (ident === 'album') {
                if (!result.extraTags?.REPLAYGAIN_ALBUM_GAIN) {
                  consumeNamedTagIntoResult(result, 'REPLAYGAIN_ALBUM_GAIN', [gainStr]);
                }
                if (peakVal > 0 && !result.extraTags?.REPLAYGAIN_ALBUM_PEAK) {
                  consumeNamedTagIntoResult(result, 'REPLAYGAIN_ALBUM_PEAK', [peakVal.toFixed(6)]);
                }
              }
            }
          } else if (frameId === 'COMM' || frameId === 'USLT') {
            if (frameBytes.length > 4) {
              const enc = frameBytes[0];
              const rest = frameBytes.subarray(4);
              const fakeTxxx = new Uint8Array(1 + rest.length);
              fakeTxxx[0] = enc;
              fakeTxxx.set(rest, 1);
              const parsed = decodeId3TxxxFrame(fakeTxxx);
              const textVals = parsed ? parsed.vals : decodeMultiTextFrame(fakeTxxx);
              if (textVals.length > 0) {
                consumeNamedTagIntoResult(result, frameId === 'COMM' ? 'COMMENT' : 'LYRICS', textVals);
              }
            }
          } else if (frameId === 'WCOP' || frameId === 'WOAR') {
            const urlVal = new TextDecoder('iso-8859-1').decode(frameBytes).replace(/\0+$/, '').trim();
            if (urlVal) {
              consumeNamedTagIntoResult(result, frameId === 'WCOP' ? 'LICENSE' : 'WEBSITE', [urlVal]);
            }
          } else if (frameId === 'APIC' && !result.coverBlobUrl && frameBytes.length > 32) {
            let p = 1; // skip encoding
            let mimeEnd = p;
            while (mimeEnd < frameBytes.length && frameBytes[mimeEnd] !== 0) mimeEnd++;
            const mime =
              new TextDecoder('ascii').decode(frameBytes.subarray(p, mimeEnd)) || 'image/jpeg';
            p = mimeEnd + 2; // skip null + picture type
            if (frameBytes[0] === 1 || frameBytes[0] === 2) {
              while (p + 1 < frameBytes.length && !(frameBytes[p] === 0 && frameBytes[p + 1] === 0)) {
                p += 2;
              }
              p += 2;
            } else {
              while (p < frameBytes.length && frameBytes[p] !== 0) p++;
              p += 1;
            }
            if (p + 64 < frameBytes.length) {
              const picBytes = frameBytes.slice(p);
              result.coverBlobUrl = URL.createObjectURL(new Blob([picBytes], { type: mime }));
            }
          }
        }
      }
    }

    // 5. APEv2-Footer-Tag am Dateiende (z. B. MP3 mit mp3gain / foobar2000 / loudgain, WavPack, APE, MPC)
    if (file.size >= 32) {
      const tailLen = Math.min(file.size, 64 * 1024);
      const tailStart = file.size - tailLen;
      const tailBuf = await file.slice(tailStart, file.size).arrayBuffer();
      const tailBytes = new Uint8Array(tailBuf);
      const tailView = new DataView(tailBuf);

      const checkApeFooterAt = (footerOff: number): boolean => {
        if (footerOff < 0 || footerOff + 32 > tailBytes.length) return false;
        // "APETAGEX"
        if (
          tailBytes[footerOff] !== 0x41 ||
          tailBytes[footerOff + 1] !== 0x50 ||
          tailBytes[footerOff + 2] !== 0x45 ||
          tailBytes[footerOff + 3] !== 0x54 ||
          tailBytes[footerOff + 4] !== 0x41 ||
          tailBytes[footerOff + 5] !== 0x47 ||
          tailBytes[footerOff + 6] !== 0x45 ||
          tailBytes[footerOff + 7] !== 0x58
        ) {
          return false;
        }
        const apeSize = tailView.getUint32(footerOff + 12, true);
        const itemCount = tailView.getUint32(footerOff + 16, true);
        if (apeSize < 32 || itemCount <= 0 || itemCount > 1024) return false;
        const itemsEnd = footerOff;
        const itemsStart = footerOff + 32 - apeSize;
        if (itemsStart < 0 || itemsStart >= itemsEnd) return false;
        const dec = new TextDecoder('utf-8', { fatal: false });
        let p = itemsStart;
        for (let i = 0; i < itemCount && p + 8 <= itemsEnd; i++) {
          const valLen = tailView.getUint32(p, true);
          const itemFlags = tailView.getUint32(p + 4, true);
          p += 8;
          let keyEnd = p;
          while (keyEnd < itemsEnd && tailBytes[keyEnd] !== 0) keyEnd++;
          if (keyEnd >= itemsEnd) break;
          const key = dec.decode(tailBytes.subarray(p, keyEnd)).trim();
          p = keyEnd + 1;
          if (p + valLen > itemsEnd) break;
          const isBinary = ((itemFlags >> 1) & 0x03) === 1;
          if (!isBinary && key && valLen > 0) {
            const vals = dec
              .decode(tailBytes.subarray(p, p + valLen))
              .split('\0')
              .map((s) => s.trim())
              .filter(Boolean);
            if (vals.length > 0) {
              consumeNamedTagIntoResult(result, key, vals);
            }
          }
          p += valLen;
        }
        return true;
      };

      // Direkt am Ende oder vor einem 128-Byte-ID3v1-Tag ("TAG")
      if (!checkApeFooterAt(tailBytes.length - 32)) {
        const id3v1Off = tailBytes.length - 128;
        if (
          id3v1Off >= 32 &&
          tailBytes[id3v1Off] === 0x54 &&
          tailBytes[id3v1Off + 1] === 0x41 &&
          tailBytes[id3v1Off + 2] === 0x47
        ) {
          checkApeFooterAt(id3v1Off - 32);
        }
      }
    }

    // 6. RIFF WAVE ("RIFF....WAVE") exact PCM duration fallback
    if (
      !result.durationSeconds &&
      headBytes.length >= 44 &&
      headBytes[0] === 0x52 &&
      headBytes[1] === 0x49 &&
      headBytes[2] === 0x46 &&
      headBytes[3] === 0x46 &&
      headBytes[8] === 0x57 &&
      headBytes[9] === 0x41 &&
      headBytes[10] === 0x56 &&
      headBytes[11] === 0x45
    ) {
      const byteRate = headView.getUint32(28, true);
      if (byteRate > 0 && file.size > 44) {
        result.durationSeconds = (file.size - 44) / byteRate;
      }
    }
  } catch {
    // Ignore binary tag parse errors
  }
  return result;
}

export function extractAudioFileDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';

    const finish = (seconds: number) => {
      URL.revokeObjectURL(objectUrl);
      resolve(seconds);
    };

    audio.onloadedmetadata = () => {
      const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      finish(dur);
    };
    audio.onerror = () => finish(0);
    audio.src = objectUrl;
  });
}

export async function extractAudioMetadataAndDuration(file: File): Promise<ExtractedAudioMetadata> {
  const tags = await parseBinaryAudioTags(file);
  let duration = tags.durationSeconds && tags.durationSeconds > 0 ? tags.durationSeconds : 0;
  if (!duration) {
    duration = await extractAudioFileDuration(file);
  }
  return {
    ...tags,
    durationSeconds: duration,
  };
}

/**
 * Konvertiert 16-Bit-PCM-Samples (s16le) platzsparend in Base64 für den schnellen Transport ans Backend.
 */
function encodeInt16SamplesToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const parts: string[] = [];
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(''));
}

/**
 * Extrahiert ein 16-kHz-Mono-PCM-Sample (s16le) exakt aus der Mitte des Tracks (bei 50 % der Gesamtdauer)
 * in der gewählten Samplegröße (z. B. 128000 = 8s bis 384000 = 24s).
 * Nur falls die 50%-Mitte nahezu reine Stille enthält, werden ersatzweise benachbarte Mittenfenster (40% / 60%) geprüft.
 */
export async function extractShazamPcmWindowsFromFile(
  file: File,
  sampleCountOrSeconds = 384000
): Promise<string[]> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    return [];
  }
  const audioCtx = new AudioCtx();
  try {
    const arrayBuf = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arrayBuf.slice(0));
    if (!decoded || decoded.duration <= 0.5) {
      return [];
    }

    const targetSampleRate = 16000;
    const requestedSamples =
      sampleCountOrSeconds >= 1000
        ? Math.max(80000, Math.min(384000, Math.round(sampleCountOrSeconds)))
        : Math.max(5, Math.min(24, Math.round(sampleCountOrSeconds))) * targetSampleRate;
    const windowSec = requestedSamples / targetSampleRate;
    const maxStart = Math.max(0, decoded.duration - windowSec);
    // Primär exakt um die 50%-Mitte des Tracks zentrieren (statt ab Trackanfang)
    const midStart =
      decoded.duration <= windowSec
        ? 0
        : Math.max(0, Math.min(maxStart, decoded.duration * 0.5 - windowSec * 0.5));

    const renderWindow = async (startSec: number): Promise<{ base64: string; rms: number }> => {
      const actualSec = Math.max(0.5, Math.min(windowSec, decoded.duration - startSec));
      const targetLength = Math.max(
        1,
        Math.min(requestedSamples, Math.round(actualSec * targetSampleRate))
      );
      const offlineCtx = new OfflineAudioContext(1, targetLength, targetSampleRate);
      const source = offlineCtx.createBufferSource();
      source.buffer = decoded;
      source.connect(offlineCtx.destination);
      source.start(0, startSec, actualSec);

      const rendered = await offlineCtx.startRendering();
      const channelData = rendered.getChannelData(0);
      const sampleLen = Math.min(requestedSamples, channelData.length);
      const pcm16 = new Int16Array(sampleLen);
      let sumSq = 0;
      for (let i = 0; i < sampleLen; i++) {
        const clamped = Math.max(-1, Math.min(1, channelData[i]));
        const val = Math.max(-32768, Math.min(32767, Math.round(clamped * 32767)));
        pcm16[i] = val;
        sumSq += val * val;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, sampleLen));
      return {
        base64: encodeInt16SamplesToBase64(pcm16),
        rms,
      };
    };

    const midWindow = await renderWindow(midStart);
    if (midWindow.rms >= 120 || maxStart <= 1) {
      return [midWindow.base64];
    }

    // Falls exakt bei 50% eine stille Passage liegt, leicht versetzte Mittenpositionen (40% / 60%) prüfen
    const fallbackStarts = [
      Math.max(0, Math.min(maxStart, decoded.duration * 0.4 - windowSec * 0.5)),
      Math.max(0, Math.min(maxStart, decoded.duration * 0.6 - windowSec * 0.5)),
    ].filter((s) => Math.abs(s - midStart) >= 2.0);

    let best = midWindow;
    for (const fbStart of fallbackStarts) {
      const candidate = await renderWindow(fbStart);
      if (candidate.rms > best.rms) {
        best = candidate;
      }
    }
    return [best.base64];
  } catch {
    return [];
  } finally {
    try {
      await audioCtx.close();
    } catch {
      // Ignore close error
    }
  }
}

/**
 * Extrahiert ein einzelnes 16 kHz Mono Signed-16-Bit PCM-Fenster (s16le) aus der Mitte (50%) einer lokalen Audiodatei.
 */
export async function extractShazamPcmSamplesFromFile(
  file: File,
  sampleCountOrSeconds = 384000
): Promise<number[]> {
  const b64List = await extractShazamPcmWindowsFromFile(file, sampleCountOrSeconds);
  if (b64List.length === 0) return [];
  const bin = atob(b64List[0]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  return Array.from(int16);
}

export interface ParsedCueMetadata {
  cddbId?: string;
  mbDiscId?: string;
  artist?: string;
  album?: string;
  year?: string;
  genre?: string;
  barcode?: string;
  trackOffsets: number[];
  tracks: Array<{ trackNumber: number; title?: string; artist?: string; isrc?: string }>;
}

export function parseCueSheetText(cueText: string): ParsedCueMetadata {
  const result: ParsedCueMetadata = {
    trackOffsets: [],
    tracks: [],
  };
  let currentTrack: { trackNumber: number; title?: string; artist?: string; isrc?: string } | null =
    null;

  for (const rawLine of cueText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const remDiscId = line.match(/^REM\s+DISCID\s+"?([A-Fa-f0-9]{8})"?/i);
    if (remDiscId) {
      result.cddbId = remDiscId[1].toLowerCase();
      continue;
    }
    const remMbDiscId = line.match(/^REM\s+MUSICBRAINZ_DISCID\s+"?([A-Za-z0-9._-]+)"?/i);
    if (remMbDiscId) {
      result.mbDiscId = remMbDiscId[1];
      continue;
    }
    const remDate = line.match(/^REM\s+DATE\s+"?(\d{4})"?/i);
    if (remDate) {
      result.year = remDate[1];
      continue;
    }
    const remGenre = line.match(/^REM\s+GENRE\s+"?([^"]+)"?/i);
    if (remGenre) {
      result.genre = remGenre[1].trim();
      continue;
    }
    const catMatch = line.match(/^CATALOG\s+"?(\d{8,14})"?/i);
    if (catMatch) {
      result.barcode = catMatch[1];
      continue;
    }

    const trkMatch = line.match(/^TRACK\s+(\d{1,3})\s+AUDIO/i);
    if (trkMatch) {
      currentTrack = { trackNumber: parseInt(trkMatch[1], 10) };
      result.tracks.push(currentTrack);
      continue;
    }

    const titleMatch = line.match(/^TITLE\s+"?([^"]+)"?$/i);
    if (titleMatch) {
      if (currentTrack === null) {
        result.album = titleMatch[1].trim();
      } else {
        currentTrack.title = titleMatch[1].trim();
      }
      continue;
    }

    const perfMatch = line.match(/^PERFORMER\s+"?([^"]+)"?$/i);
    if (perfMatch) {
      if (currentTrack === null) {
        result.artist = perfMatch[1].trim();
      } else {
        currentTrack.artist = perfMatch[1].trim();
      }
      continue;
    }

    const isrcMatch = line.match(/^ISRC\s+([A-Z0-9]{12})/i);
    if (isrcMatch && currentTrack) {
      currentTrack.isrc = isrcMatch[1].toUpperCase();
      continue;
    }

    const idxMatch = line.match(/^INDEX\s+01\s+(\d{1,3}):(\d{2}):(\d{2})/i);
    if (idxMatch && currentTrack) {
      const mm = parseInt(idxMatch[1], 10);
      const ss = parseInt(idxMatch[2], 10);
      const ff = parseInt(idxMatch[3], 10);
      const frameOffset = (mm * 60 + ss) * 75 + ff + 150;
      result.trackOffsets.push(frameOffset);
    }
  }
  return result;
}

export interface ParsedFolderInfo {
  folderName: string;
  parentFolderName: string;
  artist?: string;
  album?: string;
  year?: string;
  discNumber?: number;
}

export function parseAlbumFolderName(relativePathOrFolder: string): ParsedFolderInfo {
  const parts = relativePathOrFolder
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  // If path includes a file name at the end, drop the last segment
  const dirParts =
    parts.length > 1 && /\.[a-z0-9]{2,5}$/i.test(parts[parts.length - 1])
      ? parts.slice(0, -1)
      : parts;

  let folderName = dirParts[dirParts.length - 1] || '';
  let parentFolderName = dirParts.length >= 2 ? dirParts[dirParts.length - 2] : '';
  let discNumber: number | undefined;

  const cdMatch = folderName.match(/^(?:cd|disc|disk)\s*0*(\d{1,2})(?:\s*[-–:]\s*(.+))?$/i);
  if (cdMatch && parentFolderName) {
    discNumber = parseInt(cdMatch[1], 10);
    folderName = parentFolderName;
    parentFolderName = dirParts.length >= 3 ? dirParts[dirParts.length - 3] : '';
  }

  let cleanFolder = folderName
    .replace(/\s*[\[(](?:flac|mp3|wav|lossless|web|cd\s*\d*|24bit|16bit|320\s*kbps)[\])]/gi, '')
    .trim();

  let year: string | undefined;
  const yearBracket = cleanFolder.match(/[\[(](19\d{2}|20\d{2})[\])]/);
  if (yearBracket) {
    year = yearBracket[1];
    cleanFolder = cleanFolder.replace(yearBracket[0], '').trim();
  } else {
    const leadYear = cleanFolder.match(/^(19\d{2}|20\d{2})\s*[-–_.]\s*(.+)$/);
    if (leadYear) {
      year = leadYear[1];
      cleanFolder = leadYear[2].trim();
    }
  }

  let artist: string | undefined;
  let album: string | undefined;
  const splitParts = cleanFolder.split(/\s+[-–—]\s+/);
  if (splitParts.length >= 2) {
    if (/^(19\d{2}|20\d{2})$/.test(splitParts[0])) {
      year = year || splitParts[0];
      if (splitParts.length >= 3) {
        artist = splitParts[1].trim();
        album = splitParts.slice(2).join(' - ').trim();
      } else {
        album = splitParts[1].trim();
      }
    } else {
      artist = splitParts[0].trim();
      album = splitParts.slice(1).join(' - ').trim();
    }
  } else if (cleanFolder) {
    album = cleanFolder;
    if (
      parentFolderName &&
      !/^(musik|music|alben|albums|downloads|rips|audio|flac|mp3)$/i.test(parentFolderName)
    ) {
      artist = parentFolderName;
    }
  }

  return {
    folderName,
    parentFolderName,
    artist,
    album,
    year,
    discNumber,
  };
}

export function findBestCoverImageFile(files: File[]): File | null {
  const imageFiles = files.filter(
    (f) => /\.(jpe?g|png|webp|bmp|gif)$/i.test(f.name) || f.type.startsWith('image/')
  );
  if (imageFiles.length === 0) return null;

  const preferredStems = [
    'cover',
    'folder',
    'front',
    'album',
    'albumart',
    'albumartsmall',
    'artwork',
    'booklet',
    'scan',
    'disc',
    'cd',
  ];

  const scored = imageFiles.map((file) => {
    const stem = file.name.replace(/\.[^.]+$/, '').toLowerCase().trim();
    let priority = 50;
    for (let idx = 0; idx < preferredStems.length; idx++) {
      const p = preferredStems[idx];
      if (stem === p) {
        priority = idx;
        break;
      }
      if (stem.startsWith(p) || stem.includes(p)) {
        priority = Math.min(priority, idx + 15);
      }
    }
    return { file, priority, size: file.size };
  });

  scored.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.size - a.size;
  });

  return scored[0]?.file || null;
}

export function parseTrackFilename(
  fileName: string,
  fallbackNumber: number
): { trackNumber: number; discNumber?: number; title: string; artist?: string } {
  const stem = fileName.replace(/\.[^.]+$/, '').trim();
  // Format: "CD2 - 01 - Title", "Disc 2 - 01 Title", "2-01 - Artist - Title", "01. Title", or "1_Title"
  const cdPrefixMatch = stem.match(
    /^(?:cd|disc|disk)\s*0*(\d{1,2})\s*[-._\s]+\s*(\d{1,3})\s*[-._)\s]+\s*(.+)$/i
  );
  if (cdPrefixMatch) {
    const discNum = Math.max(1, Number(cdPrefixMatch[1]));
    const trkNum = Math.max(1, Number(cdPrefixMatch[2]));
    const rest = cdPrefixMatch[3].trim();
    const dashParts = rest.split(/\s+[-–]\s+/);
    if (dashParts.length >= 2) {
      return {
        discNumber: discNum,
        trackNumber: trkNum,
        artist: dashParts[0].trim(),
        title: dashParts.slice(1).join(' - ').trim(),
      };
    }
    return {
      discNumber: discNum,
      trackNumber: trkNum,
      title: rest,
    };
  }

  const match = stem.match(/^(?:(\d{1,2})[-.])?(\d{1,3})\s*[-._)\s]+\s*(.+)$/);
  if (match) {
    const discNum = match[1] ? Math.max(1, Number(match[1])) : undefined;
    const trkNum = Number(match[2]);
    const rest = match[3].trim();
    const dashParts = rest.split(/\s+[-–]\s+/);
    if (dashParts.length >= 2) {
      return {
        discNumber: discNum,
        trackNumber: trkNum,
        artist: dashParts[0].trim(),
        title: dashParts.slice(1).join(' - ').trim(),
      };
    }
    return {
      discNumber: discNum,
      trackNumber: trkNum,
      title: rest,
    };
  }
  return {
    trackNumber: fallbackNumber,
    title: stem || `Titel ${fallbackNumber}`,
  };
}

const RED_BOOK_FRAMES_PER_SEC = 75;
const RED_BOOK_PREGAP_FRAMES = 150;

function cddbSumDigits(value: number): number {
  let n = Math.max(0, Math.floor(value));
  let total = 0;
  while (n > 0) {
    total += n % 10;
    n = Math.floor(n / 10);
  }
  return total;
}

export function calculateCddbDiscId(frameOffsets: number[], totalSeconds: number): string {
  if (frameOffsets.length === 0) return '00000000';
  let checksum = 0;
  for (const offset of frameOffsets) {
    checksum += cddbSumDigits(Math.floor(offset / RED_BOOK_FRAMES_PER_SEC));
  }
  const numTracks = frameOffsets.length;
  const discId =
    (((checksum % 0xff) << 24) | ((Math.max(1, totalSeconds) & 0xffff) << 8) | (numTracks & 0xff)) >>>
    0;
  return discId.toString(16).padStart(8, '0').toLowerCase();
}

function sha1AsciiBytes(ascii: string): Uint8Array {
  const msgLen = ascii.length;
  const bitLen = msgLen * 8;
  const totalBytes = (((msgLen + 8) >> 6) + 1) << 6;
  const words = new Uint32Array(totalBytes >> 2);

  for (let i = 0; i < msgLen; i++) {
    words[i >> 2] |= (ascii.charCodeAt(i) & 0xff) << (24 - (i & 3) * 8);
  }
  words[msgLen >> 2] |= 0x80 << (24 - (msgLen & 3) * 8);
  words[words.length - 1] = bitLen >>> 0;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  const rotl = (val: number, shift: number) => ((val << shift) | (val >>> (32 - shift))) >>> 0;

  for (let i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 16; t++) {
      w[t] = words[i + t];
    }
    for (let t = 16; t < 80; t++) {
      w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let t = 0; t < 80; t++) {
      let f = 0;
      let k = 0;
      if (t < 20) {
        f = ((b & c) | (~b & d)) >>> 0;
        k = 0x5a827999;
      } else if (t < 40) {
        f = (b ^ c ^ d) >>> 0;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = ((b & c) | (b & d) | (c & d)) >>> 0;
        k = 0x8f1bbcdc;
      } else {
        f = (b ^ c ^ d) >>> 0;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[t]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const hashes = [h0, h1, h2, h3, h4];
  for (let idx = 0; idx < 5; idx++) {
    const hv = hashes[idx];
    out[idx * 4] = (hv >>> 24) & 0xff;
    out[idx * 4 + 1] = (hv >>> 16) & 0xff;
    out[idx * 4 + 2] = (hv >>> 8) & 0xff;
    out[idx * 4 + 3] = hv & 0xff;
  }
  return out;
}

function base64MusicBrainzEncode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    result += alphabet[(triple >>> 18) & 0x3f];
    result += alphabet[(triple >>> 12) & 0x3f];
    result += i + 1 < bytes.length ? alphabet[(triple >>> 6) & 0x3f] : '-';
    result += i + 2 < bytes.length ? alphabet[triple & 0x3f] : '-';
  }
  return result;
}

export function calculateMusicBrainzDiscId(
  firstTrack: number,
  lastTrack: number,
  leadoutOffset: number,
  frameOffsets: number[]
): string {
  if (frameOffsets.length === 0 || lastTrack < firstTrack) return '';
  let hexPayload =
    firstTrack.toString(16).toUpperCase().padStart(2, '0') +
    lastTrack.toString(16).toUpperCase().padStart(2, '0') +
    Math.max(0, Math.floor(leadoutOffset)).toString(16).toUpperCase().padStart(8, '0');

  for (let i = 0; i < 99; i++) {
    const offset = i < frameOffsets.length ? Math.max(0, Math.floor(frameOffsets[i])) : 0;
    hexPayload += offset.toString(16).toUpperCase().padStart(8, '0');
  }
  const digest = sha1AsciiBytes(hexPayload);
  return base64MusicBrainzEncode(digest);
}

export interface SynthesizedTocResult {
  cddbId: string;
  musicbrainzDiscId: string;
  musicbrainzToc: string;
  trackOffsets: number[];
  leadoutOffset: number;
  totalDiscSeconds: number;
  tracksWithLsn: TrackMetadata[];
}

export function renumberTracksPerDisc(tracks: TrackMetadata[]): TrackMetadata[] {
  const counters = new Map<number, number>();
  return tracks.map((t) => {
    const disc = Math.max(1, t.discNumber || 1);
    const next = (counters.get(disc) || 0) + 1;
    counters.set(disc, next);
    return { ...t, discNumber: disc, trackNumber: next };
  });
}

export function synthesizeTocFromTracks(
  tracks: TrackMetadata[],
  pregapFrames = RED_BOOK_PREGAP_FRAMES
): SynthesizedTocResult {
  if (tracks.length === 0) {
    return {
      cddbId: '00000000',
      musicbrainzDiscId: '',
      musicbrainzToc: '',
      trackOffsets: [],
      leadoutOffset: 0,
      totalDiscSeconds: 0,
      tracksWithLsn: [],
    };
  }

  const distinctDiscs = new Set(tracks.map((t) => Math.max(1, t.discNumber || 1)));
  const isMultiDisc = distinctDiscs.size > 1;
  const trackOffsets: number[] = [];
  const tracksWithLsn: TrackMetadata[] = [];
  let currentLsn = 0;

  for (let i = 0; i < tracks.length; i++) {
    const trk = tracks[i];
    const exactSec =
      typeof trk.exactDurationSeconds === 'number' && trk.exactDurationSeconds > 0
        ? trk.exactDurationSeconds
        : Math.max(1, trk.durationSeconds || 180);
    const sectors = Math.max(
      RED_BOOK_FRAMES_PER_SEC,
      Math.round(exactSec * RED_BOOK_FRAMES_PER_SEC)
    );
    const startLsn = currentLsn;
    const endLsn = currentLsn + sectors - 1;
    const frameOffset = startLsn + pregapFrames;
    trackOffsets.push(frameOffset);
    currentLsn += sectors;

    tracksWithLsn.push({
      ...trk,
      discNumber: Math.max(1, trk.discNumber || 1),
      trackNumber: isMultiDisc ? Math.max(1, trk.trackNumber || i + 1) : trk.trackNumber || i + 1,
      durationSeconds: Math.max(1, Math.round(sectors / RED_BOOK_FRAMES_PER_SEC)),
      exactDurationSeconds: exactSec,
      startLsn,
      endLsn,
    });
  }

  const leadoutOffset = currentLsn + pregapFrames;
  const totalDiscSeconds = Math.max(
    1,
    Math.floor(leadoutOffset / RED_BOOK_FRAMES_PER_SEC) -
      Math.floor(trackOffsets[0] / RED_BOOK_FRAMES_PER_SEC)
  );
  const cddbId = calculateCddbDiscId(trackOffsets, totalDiscSeconds);
  const musicbrainzDiscId = calculateMusicBrainzDiscId(
    1,
    tracks.length,
    leadoutOffset,
    trackOffsets
  );
  const musicbrainzToc = `1 ${tracks.length} ${leadoutOffset} ${trackOffsets.join(' ')}`;

  return {
    cddbId,
    musicbrainzDiscId,
    musicbrainzToc,
    trackOffsets,
    leadoutOffset,
    totalDiscSeconds,
    tracksWithLsn,
  };
}

export function buildCueSheetContent(album: AlbumMetadata): string {
  const albumArtist = normalizeMultiArtist(album.albumArtist || album.artist);
  const discPad = formatIndexNumber(album.discNumber, album.totalDiscs);
  const totalDiscPad = formatIndexNumber(album.totalDiscs, album.totalDiscs);
  const lines: string[] = [
    `REM GENRE "${album.genre || 'Audio'}"`,
    `REM DATE ${album.releaseDate || album.year || '2026'}`,
    `REM DISCNUMBER ${discPad}`,
    `REM TOTALDISCS ${totalDiscPad}`,
    `REM DISCID ${album.cddbId.toUpperCase() || '00000000'}`,
  ];
  if (album.musicbrainzDiscId) {
    lines.push(`REM MUSICBRAINZ_DISCID ${album.musicbrainzDiscId}`);
  }
  lines.push(
    `PERFORMER "${albumArtist}"`,
    `TITLE "${album.title}"`,
    `FILE "${sanitizeSegment(albumArtist)} - ${sanitizeSegment(album.title)}.flac" WAVE`
  );

  let currentFrame = 0;
  for (const track of album.tracks) {
    const startFrame = typeof track.startLsn === 'number' ? track.startLsn : currentFrame;
    const totalSec = Math.floor(startFrame / RED_BOOK_FRAMES_PER_SEC);
    const ff = String(startFrame % RED_BOOK_FRAMES_PER_SEC).padStart(2, '0');
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    const trackPad = formatIndexNumber(track.trackNumber, album.tracks.length);
    const trackArtist = normalizeMultiArtist(track.artist || album.artist);
    lines.push(`  TRACK ${trackPad} AUDIO`);
    lines.push(`    TITLE "${track.title}"`);
    lines.push(`    PERFORMER "${trackArtist}"`);
    if (track.isrc) {
      lines.push(`    ISRC ${track.isrc}`);
    }
    lines.push(`    INDEX 01 ${mm}:${ss}:${ff}`);
    const trackFrames =
      typeof track.startLsn === 'number' && typeof track.endLsn === 'number'
        ? Math.max(RED_BOOK_FRAMES_PER_SEC, track.endLsn - track.startLsn + 1)
        : Math.max(1, track.durationSeconds) * RED_BOOK_FRAMES_PER_SEC;
    currentFrame = startFrame + trackFrames;
  }

  return lines.join('\n') + '\n';
}

export function buildMintRipShellScript(
  album: AlbumMetadata,
  settings: ExportSettings,
  devicePath: string,
  options?: { convertLocalToFlac?: boolean }
): string {
  const convertLocalToFlac = Boolean(options?.convertLocalToFlac);
  const selected = album.tracks.filter((t) => t.selected);
  const totalTracksPad = formatIndexNumber(album.tracks.length, album.tracks.length);
  const discPad = formatIndexNumber(album.discNumber, album.totalDiscs);
  const totalDiscsPad = formatIndexNumber(album.totalDiscs, album.totalDiscs);

  const mp3Flag =
    settings.mp3Quality === 'cbr_320'
      ? '-b 320 -q 0'
      : settings.mp3Quality === 'cbr_256'
        ? '-b 256 -q 0'
        : settings.mp3Quality === 'cbr_192'
          ? '-b 192 -q 2'
          : settings.mp3Quality === 'vbr_v2'
            ? '-V 2 -q 0'
            : '-V 0 -q 0';

  const lines: string[] = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `# Export-Skript erzeugt von MintRip Studio für "${album.albumArtist || album.artist} - ${album.title}"`,
    `DEVICE="${devicePath}"`,
    'TMP_DIR="$(mktemp -d)"',
    'trap "rm -rf $TMP_DIR" EXIT',
    '',
  ];

  const hasCover = Boolean(album.musicbrainzReleaseId || album.coverArtUrl) && selected.length > 0;
  if (hasCover && (settings.saveFolderCover || settings.embedCoverArt)) {
    const firstStem = formatOutputStem(album, selected[0], settings);
    const coverFile = formatCoverFilename(album, settings);
    lines.push('# Cover-Art abrufen und vor dem Einbetten verbindlich in JPEG (.jpg) umwandeln');
    lines.push('RAW_COVER="$TMP_DIR/cover_raw.img"');
    lines.push('COVER_JPG="$TMP_DIR/cover_embed.jpg"');
    if (album.musicbrainzReleaseId) {
      lines.push(
        `curl -fsSL "https://coverartarchive.org/release/${album.musicbrainzReleaseId}/front-500" -o "$RAW_COVER" || true`
      );
    }
    lines.push(
      'if [ -s "$RAW_COVER" ]; then ffmpeg -y -hide_banner -loglevel error -i "$RAW_COVER" -q:v 2 "$COVER_JPG" || cp "$RAW_COVER" "$COVER_JPG"; fi'
    );
    if (settings.saveFolderCover) {
      lines.push(`mkdir -p "$(dirname "${firstStem.replace(/"/g, '\\"')}")"`);
      lines.push(
        `if [ -s "$COVER_JPG" ]; then cp "$COVER_JPG" "$(dirname "${firstStem.replace(/"/g, '\\"')}")/${coverFile}"; fi`
      );
    }
    lines.push('');
  }

  for (const track of selected) {
    const stem = formatOutputStem(album, track, settings);
    const escapedStem = stem.replace(/"/g, '\\"');
    const effDisc = track.discNumber || album.discNumber || 1;
    const discTracks = album.tracks.filter((t) => (t.discNumber || album.discNumber || 1) === effDisc);
    const discTrackCount = discTracks.length > 0 ? discTracks.length : album.tracks.length;
    const trkTotalPad = formatIndexNumber(discTrackCount, discTrackCount);
    const trkDiscPad = formatIndexNumber(effDisc, album.totalDiscs);
    const trackPad = formatIndexNumber(track.trackNumber, discTrackCount);
    const wavPath = `$TMP_DIR/disc_${trkDiscPad}_track_${trackPad}.wav`;

    const isLocalSourceTrack = Boolean(track.sourceFileName);
    const isTagOnlyTrack = isLocalSourceTrack && !convertLocalToFlac;
    const escapedSourceFile = (track.sourceFileName || '').replace(/"/g, '\\"');
    if (isTagOnlyTrack) {
      lines.push(
        `echo "Schreibe Tags in vorhandene Datei (CD ${trkDiscPad} Titel ${trackPad}): ${escapedSourceFile}"`
      );
    } else if (isLocalSourceTrack && convertLocalToFlac) {
      lines.push(
        `echo "Schritt 1/2 – Wandle erst nach WAV um (CD ${trkDiscPad} Titel ${trackPad}): ${escapedSourceFile}"`
      );
      lines.push(`mkdir -p "$(dirname "${escapedStem}")"`);
      lines.push(
        `SRC_SAMPLE_FMT=$(ffprobe -v error -select_streams a:0 -show_entries stream=bits_per_raw_sample,sample_fmt -of default=noprint_wrappers=1:nokey=1 "${escapedSourceFile}" | tr '\\n' ' ')`
      );
      lines.push(
        'PCM_CODEC="pcm_s16le"; case "$SRC_SAMPLE_FMT" in *24*|*32*|*flt*) PCM_CODEC="pcm_s24le" ;; esac'
      );
      lines.push(
        `ffmpeg -y -hide_banner -loglevel error -i "${escapedSourceFile}" -map 0:a:0 -vn -map_metadata -1 -c:a "$PCM_CODEC" "${wavPath}"`
      );
      if (settings.normalizeAlbum) {
        lines.push(
          `SRC_RATE=$(ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of default=noprint_wrappers=1:nokey=1 "${escapedSourceFile}" || echo 44100)`
        );
        lines.push(
          `ffmpeg -y -hide_banner -loglevel error -i "${wavPath}" -af "loudnorm=I=${settings.normalizeTargetLufs.toFixed(1)}:TP=-1.0:LRA=11" -ar "\${SRC_RATE:-44100}" -c:a "$PCM_CODEC" "${wavPath}.norm.wav" && mv "${wavPath}.norm.wav" "${wavPath}"`
        );
      }
      lines.push(
        `echo "Schritt 2/2 – Wandle WAV nach FLAC um (mit Tags & Cover): ${escapedStem}.flac"`
      );
    } else {
      lines.push(`echo "Rippe CD ${trkDiscPad} Titel ${trackPad}: ${track.title.replace(/"/g, '')}"`);
      lines.push(`mkdir -p "$(dirname "${escapedStem}")"`);
      const paranoiaOpt =
        settings.paranoiaMode === 'fast'
          ? '-Z'
          : settings.paranoiaMode === 'disable-skip'
          ? '-Y'
          : '-e';
      lines.push(`cdparanoia -d "$DEVICE" ${paranoiaOpt} ${track.trackNumber} "${wavPath}"`);

      if (settings.normalizeAlbum) {
        lines.push(
          `# EBU-R128 Normalisierung auf ${settings.normalizeTargetLufs.toFixed(1)} LUFS (erfordert ffmpeg)`
        );
        lines.push(
          `ffmpeg -y -hide_banner -loglevel error -i "${wavPath}" -af "loudnorm=I=${settings.normalizeTargetLufs.toFixed(1)}:TP=-1.0:LRA=11" -ar 44100 "${wavPath}.norm.wav" && mv "${wavPath}.norm.wav" "${wavPath}"`
        );
      }
    }

    const trackArtistNorm = normalizeMultiArtist(track.artist || album.artist);
    const albumArtistNorm = normalizeMultiArtist(album.albumArtist || album.artist);
    const trackArtistVals = splitMultiValue(trackArtistNorm);
    const trackArtistsVals = mergeMultiValues(track.artists, trackArtistVals);
    const albumArtistVals = splitMultiValue(albumArtistNorm);
    const albumArtistsVals = mergeMultiValues(album.albumArtists, albumArtistVals);

    const effectiveComposer = splitMultiValue(track.composer || album.composer);
    const effectiveOrchestra = splitMultiValue(track.orchestra || album.orchestra);
    const effectiveConductor = splitMultiValue(track.conductor || album.conductor);
    const lyricistVals = splitMultiValue(track.lyricist || album.lyricist);
    const writerVals = splitMultiValue(track.writer || album.writer);
    const producerVals = splitMultiValue(track.producer || album.producer);
    const arrangerVals = splitMultiValue(track.arranger || album.arranger);
    const engineerVals = splitMultiValue(track.engineer || album.engineer);
    const mixerVals = splitMultiValue(track.mixer || album.mixer);
    const djmixerVals = splitMultiValue(track.djmixer || album.djmixer);
    const remixerVals = splitMultiValue(track.remixer || album.remixer);
    const workVals = splitMultiValue(track.work || album.work);
    const languageVals = mergeMultiValues(album.language, track.workLanguage);
    const discSubVals = splitMultiValue(track.discSubtitle || album.discSubtitle);
    const isrcVals = mergeMultiValues(track.isrcs, track.isrc);
    const albumSortVals = splitMultiValue(album.albumSort);
    const subtitleVals = splitMultiValue(album.subtitle);
    const copyrightVals = splitMultiValue(album.copyright);
    const groupingVals = splitMultiValue(album.grouping);
    const compilationVals = splitMultiValue(album.compilation);
    const moodVals = splitMultiValue(album.mood);
    const commentVals = splitMultiValue(album.comment);

    const performerList: string[] = [];
    const tmclPairs: Array<[string, string]> = [];
    const seenPerf = new Set<string>();
    for (const orch of effectiveOrchestra) {
      const m = orch.match(/^\s*(.+?)\s*\(([^()]+)\)\s*$/);
      const role = m ? m[2].trim() : 'orchestra';
      const name = m ? m[1].trim() : orch.trim();
      if (!name) continue;
      const vorbisVal = `${name} (${role || 'orchestra'})`;
      if (!seenPerf.has(vorbisVal)) {
        seenPerf.add(vorbisVal);
        performerList.push(vorbisVal);
        tmclPairs.push([role || 'orchestra', name]);
      }
    }
    for (const rawPerf of track.performers || []) {
      const m = String(rawPerf || '').match(/^\s*(.+?)\s*\(([^()]+)\)\s*$/);
      const role = m ? m[2].trim() : 'performer';
      const name = m ? m[1].trim() : String(rawPerf || '').trim();
      if (!name) continue;
      const vorbisVal = m ? `${name} (${role})` : name;
      if (!seenPerf.has(vorbisVal)) {
        seenPerf.add(vorbisVal);
        performerList.push(vorbisVal);
        tmclPairs.push([role || 'performer', name]);
      }
    }

    const escShellVal = (val: string) => val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const pushVorbisMulti = (tagsOut: string[], key: string, values: string[]) => {
      for (const v of values) {
        if (v) tagsOut.push(`--tag="${key}=${escShellVal(v)}"`);
      }
    };

    const sourceExtMatch = (track.sourceFileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    const sourceExt = sourceExtMatch ? sourceExtMatch[1] : '';
    const isId3TagOnlyExt = ['mp3', 'mp2', 'wav', 'aiff', 'aif', 'aifc', 'dsf', 'tta'].includes(sourceExt);
    const writeVorbisMode = isTagOnlyTrack
      ? sourceExt === 'flac'
      : isLocalSourceTrack && convertLocalToFlac
        ? true
        : settings.exportFormat === 'flac';

    if (writeVorbisMode) {
      const verifyFlag = settings.flacVerify ? '--verify' : '';
      const rgFlag = settings.flacReplayGain ? '--replay-gain' : '';
      const vorbisTags: string[] = [];
      pushVorbisMulti(vorbisTags, 'TITLE', splitMultiValue(track.title));
      pushVorbisMulti(vorbisTags, 'ARTIST', trackArtistVals);
      pushVorbisMulti(vorbisTags, 'ARTISTS', trackArtistsVals);
      if (track.artistSort) {
        pushVorbisMulti(vorbisTags, 'ARTISTSORT', splitMultiValue(normalizeMultiArtist(track.artistSort)));
      }
      pushVorbisMulti(vorbisTags, 'ALBUMARTIST', albumArtistVals);
      pushVorbisMulti(vorbisTags, 'ALBUMARTISTS', albumArtistsVals);
      if (album.albumArtistSort) {
        pushVorbisMulti(
          vorbisTags,
          'ALBUMARTISTSORT',
          splitMultiValue(normalizeMultiArtist(album.albumArtistSort))
        );
      }
      pushVorbisMulti(vorbisTags, 'ALBUM', splitMultiValue(album.title));
      vorbisTags.push(`--tag="TRACKNUMBER=${trackPad}"`);
      vorbisTags.push(`--tag="TRACKTOTAL=${trkTotalPad}"`);
      vorbisTags.push(`--tag="TOTALTRACKS=${trkTotalPad}"`);
      vorbisTags.push(`--tag="DISCNUMBER=${trkDiscPad}"`);
      vorbisTags.push(`--tag="DISCTOTAL=${totalDiscsPad}"`);
      vorbisTags.push(`--tag="TOTALDISCS=${totalDiscsPad}"`);
      pushVorbisMulti(vorbisTags, 'DISCSUBTITLE', discSubVals);
      pushVorbisMulti(vorbisTags, 'GENRE', splitMultiValue((track.genre || '').trim() || album.genre));
      pushVorbisMulti(vorbisTags, 'DATE', splitMultiValue(album.releaseDate || album.year));
      const origDates = splitMultiValue(album.originalDate);
      pushVorbisMulti(vorbisTags, 'ORIGINALDATE', origDates);
      pushVorbisMulti(
        vorbisTags,
        'ORIGINALYEAR',
        Array.from(new Set(origDates.map((d) => d.slice(0, 4)).filter((y) => y.length === 4)))
      );
      pushVorbisMulti(vorbisTags, 'LABEL', splitMultiValue(album.label));
      pushVorbisMulti(vorbisTags, 'CATALOGNUMBER', splitMultiValue(album.catalogNumber));
      pushVorbisMulti(vorbisTags, 'BARCODE', splitMultiValue(album.barcode));
      pushVorbisMulti(vorbisTags, 'ASIN', splitMultiValue(album.asin));
      pushVorbisMulti(vorbisTags, 'RELEASECOUNTRY', splitMultiValue(album.country));
      pushVorbisMulti(vorbisTags, 'RELEASESTATUS', splitMultiValue(album.status));
      pushVorbisMulti(vorbisTags, 'RELEASETYPE', splitMultiValue(album.releaseType));
      pushVorbisMulti(vorbisTags, 'MEDIA', splitMultiValue(album.mediaFormat));
      pushVorbisMulti(vorbisTags, 'SCRIPT', splitMultiValue(album.script));
      pushVorbisMulti(vorbisTags, 'LANGUAGE', languageVals);
      pushVorbisMulti(vorbisTags, 'ISRC', isrcVals);
      pushVorbisMulti(vorbisTags, 'COMPOSER', effectiveComposer);
      pushVorbisMulti(vorbisTags, 'CONDUCTOR', effectiveConductor);
      pushVorbisMulti(vorbisTags, 'LYRICIST', lyricistVals);
      pushVorbisMulti(vorbisTags, 'WRITER', writerVals);
      pushVorbisMulti(vorbisTags, 'PRODUCER', producerVals);
      pushVorbisMulti(vorbisTags, 'ARRANGER', arrangerVals);
      pushVorbisMulti(vorbisTags, 'ENGINEER', engineerVals);
      pushVorbisMulti(vorbisTags, 'MIXER', mixerVals);
      pushVorbisMulti(vorbisTags, 'DJMIXER', djmixerVals);
      pushVorbisMulti(vorbisTags, 'REMIXER', remixerVals);
      pushVorbisMulti(vorbisTags, 'WORK', workVals);
      pushVorbisMulti(vorbisTags, 'ALBUMSORT', albumSortVals);
      pushVorbisMulti(vorbisTags, 'SUBTITLE', subtitleVals);
      pushVorbisMulti(vorbisTags, 'COPYRIGHT', copyrightVals);
      pushVorbisMulti(vorbisTags, 'GROUPING', groupingVals);
      pushVorbisMulti(vorbisTags, 'COMPILATION', compilationVals);
      pushVorbisMulti(vorbisTags, 'MOOD', moodVals);
      pushVorbisMulti(vorbisTags, 'COMMENT', commentVals);
      pushVorbisMulti(vorbisTags, 'PERFORMER', performerList);
      if (settings.normalizeAlbum && settings.normalizeWriteRefLoudnessTag) {
        vorbisTags.push(
          `--tag="REPLAYGAIN_REFERENCE_LOUDNESS=${settings.normalizeTargetLufs.toFixed(2)} LUFS"`
        );
      }
      pushVorbisMulti(vorbisTags, 'MUSICBRAINZ_ALBUMID', splitMultiValue(album.musicbrainzReleaseId));
      pushVorbisMulti(
        vorbisTags,
        'MUSICBRAINZ_RELEASEGROUPID',
        splitMultiValue(album.musicbrainzReleaseGroupId)
      );
      pushVorbisMulti(
        vorbisTags,
        'MUSICBRAINZ_ALBUMARTISTID',
        splitMultiValue(album.musicbrainzAlbumArtistId)
      );
      pushVorbisMulti(vorbisTags, 'MUSICBRAINZ_DISCID', splitMultiValue(album.musicbrainzDiscId));
      pushVorbisMulti(vorbisTags, 'MUSICBRAINZ_ARTISTID', splitMultiValue(track.musicbrainzArtistId));
      pushVorbisMulti(vorbisTags, 'MUSICBRAINZ_TRACKID', splitMultiValue(track.musicbrainzRecordingId));
      pushVorbisMulti(
        vorbisTags,
        'MUSICBRAINZ_RELEASETRACKID',
        splitMultiValue(track.musicbrainzTrackId)
      );
      pushVorbisMulti(vorbisTags, 'MUSICBRAINZ_WORKID', splitMultiValue(track.musicbrainzWorkId));
      pushVorbisMulti(
        vorbisTags,
        'MUSICBRAINZ_COMPOSERID',
        splitMultiValue(track.musicbrainzComposerId)
      );

      // Vorhandene track.extraTags (z. B. ReplayGain, R128, AcoustID, Custom-Tags) ebenfalls mitsichern
      const writtenVorbisKeys = new Set<string>(
        vorbisTags
          .map((t) => {
            const m = t.match(/^--tag="([^=]+)=/);
            return m ? m[1].toUpperCase() : '';
          })
          .filter(Boolean)
      );
      for (const [exKey, exVals] of Object.entries(track.extraTags || {})) {
        const upKey = exKey.trim().toUpperCase();
        if (!upKey || writtenVorbisKeys.has(upKey) || upKey.startsWith('PERFORMER')) continue;
        const cleanVals = (Array.isArray(exVals) ? exVals : [String(exVals)]).filter(Boolean);
        if (cleanVals.length > 0) {
          pushVorbisMulti(vorbisTags, upKey, cleanVals);
          writtenVorbisKeys.add(upKey);
        }
      }

      if (isTagOnlyTrack) {
        const removeFlags = Array.from(writtenVorbisKeys)
          .map((k) => `--remove-tag="${escShellVal(k)}"`)
          .join(' ');
        lines.push(
          `metaflac ${removeFlags} ${vorbisTags.join(' ')} "${escapedSourceFile}"`.replace(
            /\s+/g,
            ' '
          )
        );
        if (hasCover && settings.embedCoverArt) {
          lines.push(
            `if [ -s "$COVER_JPG" ]; then metaflac --remove --block-type=PICTURE --import-picture-from="$COVER_JPG" "${escapedSourceFile}"; fi`
          );
        }
      } else {
        lines.push(
          `flac -${settings.flacCompressionLevel} ${verifyFlag} ${rgFlag} -f ${vorbisTags.join(' ')} -o "${escapedStem}.flac" "${wavPath}"`.replace(
            /\s+/g,
            ' '
          )
        );
        if (hasCover && settings.embedCoverArt) {
          lines.push(
            `if [ -s "$COVER_JPG" ]; then metaflac --import-picture-from="$COVER_JPG" "${escapedStem}.flac"; fi`
          );
        }
      }
    } else {
      const extraTxxx: Record<string, string[]> = {};
      for (const [exKey, exVals] of Object.entries(track.extraTags || {})) {
        const upKey = exKey.trim().toUpperCase();
        if (!upKey || upKey.startsWith('PERFORMER')) continue;
        const cleanVals = (Array.isArray(exVals) ? exVals : [String(exVals)]).filter(Boolean);
        if (cleanVals.length > 0) {
          extraTxxx[upKey] = cleanVals;
        }
      }

      const id3Payload = {
        v2_version: settings.id3v2Version === 3 ? 3 : 4,
        title: splitMultiValue(track.title),
        artist: trackArtistVals,
        artists: trackArtistsVals,
        artistsort: splitMultiValue(normalizeMultiArtist(track.artistSort || '')),
        albumartist: albumArtistVals,
        albumartists: albumArtistsVals,
        albumartistsort: splitMultiValue(normalizeMultiArtist(album.albumArtistSort || '')),
        album: splitMultiValue(album.title),
        trck: `${trackPad}/${trkTotalPad}`,
        tpos: `${trkDiscPad}/${totalDiscsPad}`,
        discsubtitle: discSubVals,
        date: splitMultiValue(album.releaseDate || album.year),
        originaldate: splitMultiValue(album.originalDate),
        genre: splitMultiValue((track.genre || '').trim() || album.genre),
        label: splitMultiValue(album.label),
        composer: effectiveComposer,
        conductor: effectiveConductor,
        remixer: remixerVals,
        lyricist: lyricistVals,
        media: splitMultiValue(album.mediaFormat),
        language: languageVals,
        isrc: isrcVals,
        albumsort: albumSortVals,
        subtitle: subtitleVals,
        copyright: copyrightVals,
        grouping: groupingVals,
        compilation: compilationVals,
        mood: moodVals,
        comment: commentVals,
        tipl: [
          ...producerVals.map((n) => ['producer', n]),
          ...arrangerVals.map((n) => ['arranger', n]),
          ...engineerVals.map((n) => ['engineer', n]),
          ...mixerVals.map((n) => ['mix', n]),
          ...djmixerVals.map((n) => ['DJ-mix', n]),
        ],
        tmcl: tmclPairs,
        txxx: {
          ...extraTxxx,
          Artists: trackArtistsVals,
          ALBUMARTISTS: albumArtistsVals,
          CATALOGNUMBER: splitMultiValue(album.catalogNumber),
          BARCODE: splitMultiValue(album.barcode),
          ASIN: splitMultiValue(album.asin),
          SCRIPT: splitMultiValue(album.script),
          WORK: workVals,
          Writer: writerVals,
          'MusicBrainz Album Release Country': splitMultiValue(album.country),
          'MusicBrainz Album Status': splitMultiValue(album.status),
          'MusicBrainz Album Type': splitMultiValue(album.releaseType),
          'MusicBrainz Album Id': splitMultiValue(album.musicbrainzReleaseId),
          'MusicBrainz Release Group Id': splitMultiValue(album.musicbrainzReleaseGroupId),
          'MusicBrainz Album Artist Id': splitMultiValue(album.musicbrainzAlbumArtistId),
          'MusicBrainz Disc Id': splitMultiValue(album.musicbrainzDiscId),
          'MusicBrainz Artist Id': splitMultiValue(track.musicbrainzArtistId),
          'MusicBrainz Release Track Id': splitMultiValue(track.musicbrainzTrackId),
          'MusicBrainz Work Id': splitMultiValue(track.musicbrainzWorkId),
          'MusicBrainz Composer Id': splitMultiValue(track.musicbrainzComposerId),
          ...(settings.normalizeAlbum && settings.normalizeWriteRefLoudnessTag
            ? { REPLAYGAIN_REFERENCE_LOUDNESS: [`${settings.normalizeTargetLufs.toFixed(2)} LUFS`] }
            : {}),
        },
        ufid: splitMultiValue(track.musicbrainzRecordingId)[0] || '',
      };

      lines.push(
        `# ID3v2.${settings.id3v2Version} Tagging nicht-destruktiv nach MusicBrainz Picard (bestehende Tags bleiben erhalten)`
      );
      const targetAudioPath = isTagOnlyTrack ? escapedSourceFile : `${escapedStem}.mp3`;
      if (!isTagOnlyTrack) {
        lines.push(`lame --silent ${mp3Flag} "${wavPath}" "${targetAudioPath}"`);
      } else if (!isId3TagOnlyExt) {
        lines.push(
          `echo "Fehler: Format '.${sourceExt}' unterstützt weder FLAC-Vorbis noch ID3v2.3/2.4 – überspringe ${escapedSourceFile}" >&2`
        );
      }
      if (!isTagOnlyTrack || isId3TagOnlyExt) {
        const coverArg = hasCover && settings.embedCoverArt ? ' "$COVER_JPG"' : ' ""';
        lines.push(`python3 - "${targetAudioPath}"${coverArg} <<'__MINTRIP_ID3__'`);
        lines.push(
          `import json, os, sys\nfrom mutagen.id3 import APIC, COMM, ID3, ID3NoHeaderError, TCMP, TCOP, TDRC, TDOR, TEXT, TIPL, TIT1, TIT2, TIT3, TLAN, TMCL, TMED, TMOO, TPE1, TPE2, TPE3, TPE4, TPOS, TPUB, TRCK, TSOA, TSO2, TSOP, TSRC, TSST, TXXX, TCOM, TCON, TALB, UFID\np = json.loads(${JSON.stringify(JSON.stringify(id3Payload))})\ntarget = sys.argv[1]\next = os.path.splitext(target)[1].lower()\ndef fill_id3(tags):\n    for fid, cls, k in (('TIT2',TIT2,'title'),('TPE1',TPE1,'artist'),('TPE2',TPE2,'albumartist'),('TSOP',TSOP,'artistsort'),('TSO2',TSO2,'albumartistsort'),('TSOA',TSOA,'albumsort'),('TALB',TALB,'album'),('TIT3',TIT3,'subtitle'),('TIT1',TIT1,'grouping'),('TCOP',TCOP,'copyright'),('TCMP',TCMP,'compilation'),('TDRC',TDRC,'date'),('TDOR',TDOR,'originaldate'),('TCON',TCON,'genre'),('TPUB',TPUB,'label'),('TCOM',TCOM,'composer'),('TPE3',TPE3,'conductor'),('TPE4',TPE4,'remixer'),('TEXT',TEXT,'lyricist'),('TMED',TMED,'media'),('TLAN',TLAN,'language'),('TSRC',TSRC,'isrc')):\n        if p.get(k):\n            tags.delall(fid)\n            tags.add(cls(encoding=3, text=p[k]))\n    tags.delall('TRCK'); tags.add(TRCK(encoding=3, text=p['trck']))\n    tags.delall('TPOS'); tags.add(TPOS(encoding=3, text=p['tpos']))\n    if p['v2_version'] == 4 and p.get('discsubtitle'): tags.delall('TSST'); tags.add(TSST(encoding=3, text=p['discsubtitle']))\n    if p['v2_version'] == 4 and p.get('mood'): tags.delall('TMOO'); tags.add(TMOO(encoding=3, text=p['mood']))\n    if p.get('comment'): tags.delall('COMM'); tags.add(COMM(encoding=3, lang='eng', desc='', text=p['comment']))\n    if p.get('tipl'): tags.delall('TIPL'); tags.add(TIPL(encoding=3, people=p['tipl']))\n    if p.get('tmcl'): tags.delall('TMCL'); tags.add(TMCL(encoding=3, people=p['tmcl']))\n    for desc, vals in p.get('txxx', {}).items():\n        if vals:\n            dn = desc.strip().lower()\n            for ek in list(tags.keys()):\n                if str(ek).startswith('TXXX:') and str(getattr(tags[ek], 'desc', '')).strip().lower() == dn:\n                    del tags[ek]\n            tags.add(TXXX(encoding=3, desc=desc, text=vals))\n    if p.get('ufid'):\n        for ek in list(tags.keys()):\n            if str(ek).startswith('UFID:http://musicbrainz.org'): del tags[ek]\n        tags.add(UFID(owner='http://musicbrainz.org', data=p['ufid'].encode('ascii')))\n    if len(sys.argv) > 2 and sys.argv[2] and os.path.isfile(sys.argv[2]):\n        with open(sys.argv[2], 'rb') as cf:\n            tags.delall('APIC')\n            tags.add(APIC(encoding=3, mime='image/jpeg', type=3, desc='Front Cover', data=cf.read()))\nif ext in ('.mp3', '.mp2'):\n    try:\n        tags = ID3(target)\n    except ID3NoHeaderError:\n        tags = ID3()\n    fill_id3(tags)\n    if p['v2_version'] == 3:\n        tags.update_to_v23()\n        tags.save(target, v2_version=3, v23_sep=' / ')\n    else:\n        tags.save(target, v2_version=4)\nelse:\n    container = None\n    if ext == '.wav':\n        from mutagen.wave import WAVE as container\n    elif ext in ('.aiff', '.aif', '.aifc'):\n        from mutagen.aiff import AIFF as container\n    elif ext == '.dsf':\n        from mutagen.dsf import DSF as container\n    elif ext == '.tta':\n        from mutagen.trueaudio import TrueAudio as container\n    audio = container(target)\n    if getattr(audio, 'tags', None) is None:\n        audio.add_tags()\n    fill_id3(audio.tags)\n    if p['v2_version'] == 3:\n        audio.tags.update_to_v23()\n        audio.save(v2_version=3, v23_sep=' / ')\n    else:\n        audio.save(v2_version=4)`
        );
        lines.push('__MINTRIP_ID3__');
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function triggerTextDownload(filename: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
