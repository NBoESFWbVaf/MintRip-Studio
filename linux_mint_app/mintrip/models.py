"""Datenmodelle für MintRip Studio (Linux Mint CD-Ripper & Batch-Konverter)."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
import re
from typing import Optional
import uuid

_MULTI_ARTIST_BRACKET_RE = re.compile(
    r"\s*[\(\[]\s*(?:feat(?:uring)?|ft|vs|versus|v\.|pres(?:ents|enting)?|präsentiert|praesentiert)(?:\.\s*|\s+)([^\)\]]+?)[\)\]]",
    re.IGNORECASE,
)
_MULTI_ARTIST_JOIN_RE = re.compile(
    r"(?:\s*[,;&]?\s+)(?:(?:feat(?:uring)?|ft|vs|versus|pres(?:ents|enting)?|präsentiert|praesentiert)(?:\.\s*|\s+)|v\.\s*)",
    re.IGNORECASE,
)


def split_multi_value(value: object) -> list[str]:
    """Teilt mehrwertige Feldinhalte ('; '-getrennt oder Sequenz) dedupliziert in eine geordnete Liste auf."""
    raw_items: list[str] = []
    if isinstance(value, (list, tuple, set)):
        for entry in value:
            if entry is None:
                continue
            text = str(entry).strip()
            if not text:
                continue
            if ";" in text:
                raw_items.extend(part.strip() for part in text.split(";") if part.strip())
            else:
                raw_items.append(text)
    elif value is not None:
        text = str(value).strip()
        if text:
            if ";" in text:
                raw_items.extend(part.strip() for part in text.split(";") if part.strip())
            else:
                raw_items.append(text)

    dedup: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        if item not in seen:
            seen.add(item)
            dedup.append(item)
    return dedup


# Offiziell von MusicBrainz Picard (https://picard-docs.musicbrainz.org/en/latest/appendices/tag_mapping.html)
# unterstützte Zusatz-Tags (Großbuchstaben Vorbis- / interne Namen). Nicht gelistete Keys (z. B. SHAZAM_*,
# DISCOGS_RELEASE_ID, ORGANIZATION, WORKLANGUAGE, ORCHESTRA, ENSEMBLE, ISWC) werden beim Schreiben verworfen.
PICARD_EXTRA_TAG_WHITELIST: frozenset[str] = frozenset(
    {
        "ACOUSTID_ID",
        "ACOUSTID_FINGERPRINT",
        "ACOUSTID_PUID",
        "ALBUMSORT",
        "ARRANGER",
        "ARTISTS",
        "ALBUMARTISTS",
        "BPM",
        "COMMENT",
        "COMPILATION",
        "COMPOSERSORT",
        "COPYRIGHT",
        "DESCRIPTION",
        "DIRECTOR",
        "DISCSUBTITLE",
        "DJMIXER",
        "ENCODEDBY",
        "ENCODER",
        "ENCODERSETTINGS",
        "ENGINEER",
        "GROUPING",
        "INITIALKEY",
        "KEY",
        "LICENSE",
        "LYRICS",
        "MIXER",
        "MOOD",
        "MOVEMENT",
        "MOVEMENTNAME",
        "MOVEMENTTOTAL",
        "MUSICBRAINZ_COMPOSERID",
        "MUSICBRAINZ_ORIGINALALBUMID",
        "MUSICBRAINZ_ORIGINALARTISTID",
        "ORIGINALFILENAME",
        "PERFORMER",
        "PRODUCER",
        "R128_ALBUM_GAIN",
        "R128_TRACK_GAIN",
        "REMIXER",
        "REPLAYGAIN_ALBUM_GAIN",
        "REPLAYGAIN_ALBUM_MINMAX",
        "REPLAYGAIN_ALBUM_PEAK",
        "REPLAYGAIN_ALBUM_RANGE",
        "REPLAYGAIN_MINMAX",
        "REPLAYGAIN_REFERENCE_LOUDNESS",
        "REPLAYGAIN_TRACK_GAIN",
        "REPLAYGAIN_TRACK_PEAK",
        "REPLAYGAIN_TRACK_RANGE",
        "REPLAYGAIN_UNDO",
        "SHOWMOVEMENT",
        "SUBTITLE",
        "TITLESORT",
        "WEBSITE",
        "WORK",
        "WRITER",
    }
)


def is_picard_supported_extra_tag(key: str) -> bool:
    """Prüft, ob ein Extra-Tag-Schlüssel offiziell von MusicBrainz Picard unterstützt wird."""
    upper = str(key or "").strip().upper()
    if not upper:
        return False
    if upper in PICARD_EXTRA_TAG_WHITELIST:
        return True
    if upper.startswith("PERFORMER:"):
        return bool(upper.split(":", 1)[1].strip())
    return False


def filter_picard_extra_tags(extra_tags: dict[str, list[str]] | None) -> dict[str, list[str]]:
    """Filtert extra_tags strikt auf offiziell von Picard unterstützte Multi-Value-Tags."""
    cleaned: dict[str, list[str]] = {}
    for raw_key, raw_vals in (extra_tags or {}).items():
        key = str(raw_key or "").strip()
        if not is_picard_supported_extra_tag(key):
            continue
        vals = split_multi_value(raw_vals)
        if not vals:
            continue
        norm_key = (
            f"PERFORMER:{key.split(':', 1)[1].strip()}"
            if key.upper().startswith("PERFORMER:")
            else key.upper()
        )
        bucket = cleaned.setdefault(norm_key, [])
        for v in vals:
            if v not in bucket:
                bucket.append(v)
    return cleaned


def normalize_multi_artist(value: str) -> str:
    """Ersetzt Verbindungsbegriffe wie 'feat.', 'featuring', 'vs.', 'versus', 'pres.', 'presents' durch '; '."""
    if not value:
        return ""
    text = _MULTI_ARTIST_BRACKET_RE.sub(r"; \1", str(value).strip())
    text = _MULTI_ARTIST_JOIN_RE.sub("; ", text)
    parts = [p.strip() for p in re.split(r"\s*;\s*", text) if p.strip()]
    dedup: list[str] = []
    for part in parts:
        if part not in dedup:
            dedup.append(part)
    return "; ".join(dedup)


_PROTECTED_BAND_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bEarth,\s*Wind\s+(?:&|and)\s+Fire\b",
        r"\bCrosby,\s*Stills,\s*Nash\s+(?:&|and)\s+Young\b",
        r"\bCrosby,\s*Stills\s+(?:&|and)\s+Nash\b",
        r"\bCrosby\s+(?:&|and)\s+Nash\b",
        r"\bEmerson,\s*Lake\s+(?:&|and)\s+Palmer\b",
        r"\bBlood,\s*Sweat\s+(?:&|and)\s+Tears\b",
        r"\bPeter,\s*Paul\s+(?:&|and)\s+Mary\b",
        r"\bSimon\s+(?:&|and)\s+Garfunkel\b",
        r"\b(?:Daryl\s+)?Hall\s+(?:&|and)\s+(?:John\s+)?Oates\b",
        r"\bKool\s+(?:&|and)\s+the\s+Gang\b",
        r"\bSly\s+(?:&|and)\s+the\s+Family\s+Stone\b",
        r"\bTom\s+Petty\s+(?:&|and)\s+the\s+Heartbreakers\b",
        r"\bBruce\s+Springsteen\s+(?:&|and)\s+the\s+E\s+Street\s+Band\b",
        r"\bBob\s+Marley\s+(?:&|and)\s+the\s+Wailers\b",
        r"\bNick\s+Cave\s+(?:&|and)\s+the\s+Bad\s+Seeds\b",
        r"\bHuey\s+Lewis\s+(?:&|and)\s+the\s+News\b",
        r"\bGladys\s+Knight\s+(?:&|and)\s+the\s+Pips\b",
        r"\bMartha\s+(?:&|and)\s+the\s+Vandellas\b",
        r"\bSmokey\s+Robinson\s+(?:&|and)\s+the\s+Miracles\b",
        r"\bJoan\s+Jett\s+(?:&|and)\s+the\s+Blackhearts\b",
        r"\bEcho\s+(?:&|and)\s+the\s+Bunnymen\b",
        r"\bSiouxsie\s+(?:&|and)\s+the\s+Banshees\b",
        r"\bFlorence\s*(?:\+|&|and)\s*the\s+Machine\b",
        r"\bDerek\s+(?:&|and)\s+the\s+Dominos\b",
        r"\bThe\s+Mamas\s+(?:&|and)\s+the\s+Papas\b",
        r"\bCaptain\s+(?:&|and)\s+Tennille\b",
        r"\bSonny\s+(?:&|and)\s+Cher\b",
        r"\bIke\s+(?:&|and)\s+Tina\s+Turner\b",
        r"\bSam\s+(?:&|and)\s+Dave\b",
        r"\bBrooks\s+(?:&|and)\s+Dunn\b",
        r"\bTegan\s+(?:&|and)\s+Sara\b",
        r"\bAngus\s+(?:&|and)\s+Julia\s+Stone\b",
        r"\bMumford\s+(?:&|and)\s+Sons\b",
        r"\bOf\s+Mice\s+(?:&|and)\s+Men\b",
        r"\bIron\s+(?:&|and)\s+Wine\b",
        r"\bBelle\s+(?:&|and)\s+Sebastian\b",
        r"\bCoheed\s+(?:&|and)\s+Cambria\b",
        r"\bAbove\s+(?:&|and)\s+Beyond\b",
        r"\bChase\s+(?:&|and)\s+Status\b",
        r"\bHootie\s+(?:&|and)\s+the\s+Blowfish\b",
        r"\bEdward\s+Sharpe\s+(?:&|and)\s+the\s+Magnetic\s+Zeros\b",
        r"\bNoah\s+(?:&|and)\s+the\s+Whale\b",
        r"\bMe\s+First\s+(?:&|and)\s+the\s+Gimme\s+Gimmes\b",
        r"\bMike\s*\+\s*the\s+Mechanics\b",
        r"\bPrince\s+(?:&|and)\s+the\s+Revolution\b",
        r"\bKatrina\s+(?:&|and)\s+the\s+Waves\b",
        r"\bDr\.?\s+Hook\s+(?:&|and)\s+the\s+Medicine\s+Show\b",
        r"\bTyler,\s*The\s+Creator\b",
        r"\bGuns\s+N['’]\s*Roses\b",
        r"\bSalt-N-Pepa\b",
        r"\bAC\s*/\s*DC\b",
        r"\bK/DA\b",
    )
)

# Struktureller Schutz nur für echte "&/+ The <Band-Nomen>" Backing-Bands (keine Kollaborationen wie "Timbaland And The Mudd Katz")
_BACKING_BAND_RE = re.compile(
    r"\b([A-ZÄÖÜÀ-Ö][^\s,;()\[\]]*(?:\s+[A-ZÄÖÜÀ-Ö][^\s,;()\[\]]*){0,1})\s+"
    r"(?:&|\+)\s+((?:the|die|les|los)\s+(?:[^\s,;()\[\]]+\s+){0,2}"
    r"(?:band|orchestra|orchester|ensemble|choir|chor|singers|collective|crew|"
    r"allstars|all-stars|playboys|ramblers|drifters|experience|syndicate|"
    r"shadows|riders|rebels|family|gang|sons|news|waves|machine|mechanics))\b",
    re.IGNORECASE,
)

_NON_ARTIST_WITH_NOUNS_RE = re.compile(
    r"^(?:lyrics|songtext|bonus(?:\s+track)?|video|booklet|orchestra|orchester|strings|"
    r"streicher|choir|chor|chorus|band|piano|klavier|guitar|gitarre|drums|schlagzeug|"
    r"applause|crowd|friends|commentary|kommentar)$",
    re.IGNORECASE,
)

_MIX_EDITION_KEYWORD_RE = re.compile(
    r"\b(?:remix|rmx|mix|megamix|bootleg|rework|mashup|vip\s+(?:mix|edit)|radio\s+edit|"
    r"club\s+(?:mix|edit)|extended\s+(?:mix|edit|version)|dub\s+(?:mix|edit|version)|"
    r"acoustic\s+(?:mix|version|edit)|akustik(?:\s+version)?|unplugged|instrumental|karaoke|"
    r"acapella|a\s*cappella|edit|version|remaster(?:ed)?|reprise|bonus\s+track|deluxe\s+edition|"
    r"(?:clean|explicit|mono|stereo)\s+(?:mix|edit|version)|live\s+(?:at|in|from|mix|version|recording))\b",
    re.IGNORECASE,
)

_KNOWN_STANDALONE_ARTIST_BOUNDARIES: tuple[str, ...] = (
    "Bubba Sparxxx",
    "Bubba Spaxxx",
    "The Mudd Katz",
    "Justin Timberlake",
    "Timbaland",
    "Jawga Boyz",
    "Missy Elliott",
    "Busta Rhymes",
    "Kendrick Lamar",
    "Calvin Harris",
    "David Guetta",
    "Taylor Swift",
    "Kanye West",
    "Snoop Dogg",
    "Post Malone",
    "Bruno Mars",
    "Ed Sheeran",
    "Katy Perry",
    "Lady Gaga",
    "The Weeknd",
    "Sean Paul",
    "Ricky Martin",
    "Elton John",
    "Peter Alexander",
    "Joseph Strauss",
    "Marshmello",
    "Lil Wayne",
    "50 Cent",
    "Dr. Dre",
    "Pharrell",
    "Ludacris",
    "Skrillex",
    "Shakira",
    "Madonna",
    "Rihanna",
    "Beyoncé",
    "Pitbull",
    "Eminem",
    "Coolio",
    "Xzibit",
    "Ne-Yo",
    "T-Pain",
    "Fergie",
    "Jay-Z",
    "Magoo",
    "Ciara",
    "Nelly",
    "Akon",
    "Dua Lipa",
)

_SPLITTER_COLLAB_BRACKET_RE = re.compile(
    r"\s*[\(\[]\s*(?:feat(?:uring)?|ft|vs|versus|pres(?:ents|enting)?|präsentiert|praesentiert|"
    r"duet\s+with|duett\s+mit|zusammen\s+mit|with|mit|starring|meets|trifft|intro(?:ducing)?)"
    r"(?:\.\s*|\s+)([^\)\]]+?)[\)\]]",
    re.IGNORECASE,
)

_SPLITTER_COLLAB_INLINE_RE = re.compile(
    r"(?:\s*[,;&/+]?\s+)(?:feat(?:uring)?|ft|vs|versus|pres(?:ents|enting)?|präsentiert|praesentiert|"
    r"duet\s+with|duett\s+mit|zusammen\s+mit|with|mit|starring|meets|trifft|accompanied\s+by|"
    r"intro(?:ducing)?)(?:\.\s*|\s+)|(?:\s+v\.\s+)",
    re.IGNORECASE,
)


def _dedup_artist_tokens(tokens: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in tokens:
        clean = re.sub(r"^[\s,;:/&+|–—-]+|[\s,;:/&+|–—-]+$", "", str(raw or ""))
        clean = re.sub(r"\s+", " ", clean).strip()
        if not clean:
            continue
        key = clean.lower()
        if key not in seen:
            seen.add(key)
            out.append(clean)
    return out


def _split_concatenated_chunk_by_boundaries(
    chunk: str,
    boundaries: list[str],
    depth: int = 0,
) -> list[str]:
    trimmed = chunk.strip()
    if not trimmed or depth > 5:
        return [trimmed] if trimmed else []
    if _MIX_EDITION_KEYWORD_RE.search(trimmed):
        return [trimmed]

    for b in boundaries:
        if len(b) < 4:
            continue
        if trimmed.lower() == b.lower():
            return [trimmed]
        pat = re.compile(
            rf"^(.*?)(?:^|\s)({re.escape(b)})(?:\s+(.*)|$)",
            re.IGNORECASE,
        )
        m = pat.match(trimmed)
        if not m:
            continue
        before = (m.group(1) or "").strip()
        matched = (m.group(2) or "").strip()
        after = (m.group(3) or "").strip()
        if not before and not after:
            continue
        if after and re.match(
            r"^(?:remix|rmx|mix|megamix|edit|version|band|orchestra|orchester|ensemble|trio|quartet|choir|chor|feat\.?|ft\.?)\b",
            after,
            re.IGNORECASE,
        ):
            continue
        result: list[str] = []
        if before:
            result.extend(_split_concatenated_chunk_by_boundaries(before, boundaries, depth + 1))
        result.append(matched)
        if after:
            result.extend(_split_concatenated_chunk_by_boundaries(after, boundaries, depth + 1))
        return result
    return [trimmed]


def split_chained_artists(
    raw: str,
    is_classical: bool = False,
    known_artists: Optional[list[str]] = None,
) -> list[str]:
    """Zerlegt verkettete Interpreten (z. B. 'A, B, C & D', feat., vs., +, /, x) unter Schutz echter Bandnamen."""
    working = str(raw or "").strip()
    if not working:
        return []

    placeholders: dict[str, str] = {}
    ph_idx = 0

    def _stash(match_text: str) -> str:
        nonlocal ph_idx
        tok = f"\uE000P{ph_idx}\uE000"
        ph_idx += 1
        placeholders[tok] = match_text.strip()
        return tok

    for pat in _PROTECTED_BAND_PATTERNS:
        working = pat.sub(lambda m: _stash(m.group(0)), working)
    working = _BACKING_BAND_RE.sub(lambda m: _stash(m.group(0)), working)

    if (
        is_classical
        and not re.search(
            r"[;&+/×]|\b(?:feat(?:uring)?|ft|vs|versus|and|und|mit|with|duet|duett|pres)\b",
            working,
            re.IGNORECASE,
        )
        and working.count(",") == 1
        and re.match(
            r"^[A-ZÄÖÜÀ-Ö][a-zäöüßà-öø-ÿ'-]+,\s+[A-ZÄÖÜÀ-Ö][^\s,;]+(?:\s+[A-ZÄÖÜÀ-Ö][^\s,;]+){0,2}$",
            working,
        )
    ):
        working = _stash(working)

    working = _SPLITTER_COLLAB_BRACKET_RE.sub(r"; \1", working)
    working = _SPLITTER_COLLAB_INLINE_RE.sub("; ", working)

    working = re.sub(r"\s*;\s*", "; ", working)
    working = re.sub(r"\s*,\s*", "; ", working)
    working = re.sub(r"\s+&\s+|(?<=[^\W\d_]{2})&(?=[^\W\d_]{2})", "; ", working)
    working = re.sub(r"\s+\+\s+", "; ", working)
    working = re.sub(r"\s+/\s+|(?<=[^\W\d_]{3})/(?=[^\W\d_]{3})", "; ", working)
    working = re.sub(r"\s+[×]\s+|\s+x\s+(?=[^\s;]{2,})", "; ", working)
    working = re.sub(r"\s+(?:and|und|et|avec|con)\s+", "; ", working, flags=re.IGNORECASE)

    merged_boundaries = sorted(
        {
            s.strip()
            for s in (*(known_artists or []), *_KNOWN_STANDALONE_ARTIST_BOUNDARIES)
            if s and len(s.strip()) >= 4 and not _MIX_EDITION_KEYWORD_RE.search(s)
        },
        key=len,
        reverse=True,
    )

    raw_parts: list[str] = []
    for part in re.split(r"\s*;\s*", working):
        restored = part.strip()
        if not restored:
            continue
        had_placeholder = False
        for tok, orig in placeholders.items():
            if tok in restored:
                restored = restored.replace(tok, orig)
                had_placeholder = True
        if had_placeholder:
            raw_parts.append(restored)
        else:
            raw_parts.extend(_split_concatenated_chunk_by_boundaries(restored, merged_boundaries))

    return _dedup_artist_tokens(raw_parts)


def extract_features_from_title(
    raw_title: str,
    is_classical: bool = False,
    known_artists: Optional[list[str]] = None,
) -> tuple[str, list[str]]:
    """Schneidet Feature-Konstrukte wie '(feat. X & Y)' aus dem Titel (Remix/Mix bleiben erhalten) und gibt die getrennten Interpreten zurück."""
    working_title = str(raw_title or "").strip()
    if not working_title:
        return "", []

    collected_chunks: list[str] = []

    def _replace_bracket(match: re.Match[str], open_br: str, close_br: str) -> str:
        kw = str(match.group(1) or "").strip()
        inner = str(match.group(2) or "").strip()
        if not inner:
            return match.group(0)
        if re.fullmatch(r"with|mit", kw, re.IGNORECASE) and _NON_ARTIST_WITH_NOUNS_RE.match(inner):
            return match.group(0)
        if _MIX_EDITION_KEYWORD_RE.search(inner):
            if re.fullmatch(r"feat(?:uring)?|ft", kw, re.IGNORECASE):
                m_split = re.match(
                    r"^(.+?)\s*[-–—,/]\s*([^\(\)\[\]]*\b(?:remix|rmx|mix|megamix|bootleg|rework|mashup|"
                    r"flip|vip|radio|edit|version|remaster(?:ed)?|acoustic|akustik|unplugged|"
                    r"instrumental|karaoke|acapella|a\s*cappella|extended|dub|club|live)\b.*)$",
                    inner,
                    re.IGNORECASE,
                )
                if m_split:
                    feat_part = m_split.group(1).strip()
                    mix_part = m_split.group(2).strip()
                    if feat_part and not _MIX_EDITION_KEYWORD_RE.search(feat_part):
                        collected_chunks.append(feat_part)
                        return f" {open_br}{mix_part}{close_br}"
            return match.group(0)
        collected_chunks.append(inner)
        return " "

    paren_re = re.compile(
        r"\s*\(\s*(feat(?:uring)?|ft|vs|versus|pres(?:ents|enting)?|präsentiert|praesentiert|"
        r"duet\s+with|duett\s+mit|zusammen\s+mit|with|mit|starring)(?:\.\s*|\s+)([^()]+?)\s*\)",
        re.IGNORECASE,
    )
    working_title = paren_re.sub(lambda m: _replace_bracket(m, "(", ")"), working_title)

    bracket_re = re.compile(
        r"\s*\[\s*(feat(?:uring)?|ft|vs|versus|pres(?:ents|enting)?|präsentiert|praesentiert|"
        r"duet\s+with|duett\s+mit|zusammen\s+mit|with|mit|starring)(?:\.\s*|\s+)([^\[\]]+?)\s*\]",
        re.IGNORECASE,
    )
    working_title = bracket_re.sub(lambda m: _replace_bracket(m, "[", "]"), working_title)

    unbracketed_re = re.compile(
        r"(?:\s*[-–—,/]?\s+|\s+)(?:feat(?:uring)?|ft|duet\s+with|duett\s+mit|zusammen\s+mit|"
        r"pres(?:ents|enting)?|präsentiert|praesentiert)(?:\.\s*|\s+)(.+?)"
        r"(?=\s*[\(\[][^()\]]*\b(?:radio|edit|remix|rmx|mix|megamix|bootleg|rework|mashup|flip|vip|"
        r"live|version|remaster(?:ed)?|acoustic|akustik|unplugged|instrumental|karaoke|acapella|"
        r"a\s*cappella|extended|dub|club|deluxe|bonus|mono|stereo|clean|explicit)\b[^()\]]*[\)\]]"
        r"|\s*[-–—,/]\s*[^-–—,/()\[\]]*\b(?:remix|rmx|mix|megamix|bootleg|rework|mashup|flip|vip|"
        r"edit|version|remaster(?:ed)?|acoustic|akustik|unplugged|instrumental|karaoke|acapella|"
        r"a\s*cappella|extended|dub|club|live)\b|\s*$)",
        re.IGNORECASE,
    )

    def _replace_unbracketed(match: re.Match[str]) -> str:
        inner = str(match.group(1) or "").strip()
        if not inner or _MIX_EDITION_KEYWORD_RE.search(inner):
            return match.group(0)
        collected_chunks.append(inner)
        return ""

    working_title = unbracketed_re.sub(_replace_unbracketed, working_title)

    clean_title = re.sub(r"\s{2,}", " ", working_title)
    clean_title = re.sub(r"\s*[-–—,/]\s*$", "", clean_title).strip()

    extracted: list[str] = []
    for chunk in collected_chunks:
        extracted.extend(
            split_chained_artists(chunk, is_classical=is_classical, known_artists=known_artists)
        )
    return (clean_title or raw_title.strip()), _dedup_artist_tokens(extracted)


def run_artist_splitter_on_album(
    album: "AlbumMetadata",
    only_selected: bool = True,
) -> list[tuple[str, str]]:
    """Wendet den Interpretensplitter auf ausgewählte Titel (und bei Gesamtauswahl auf Album-Felder) an."""
    is_classical = bool(album.is_classical)
    changes: list[tuple[str, str]] = []

    target_tracks = (
        [t for t in album.tracks if t.selected] if (only_selected and album.tracks) else list(album.tracks)
    )
    if only_selected and album.tracks and not target_tracks:
        return changes

    apply_album_fields = (not only_selected) or (len(album.tracks) == 0) or (len(target_tracks) == len(album.tracks))

    pool: list[str] = []
    for val in [album.artist, album.album_artist, *(t.artist for t in album.tracks)]:
        clean_v = str(val or "").strip()
        if not clean_v:
            continue
        for part in re.split(r"\s*[;,]\s*", clean_v):
            p = part.strip()
            if (
                p
                and len(p) >= 4
                and not re.search(r"[&+/×]|\b(?:and|und|feat|ft|remix|mix)\b", p, re.IGNORECASE)
            ):
                pool.append(p)
    known_artists = list(dict.fromkeys(pool))

    def _split_join(val: str) -> str:
        return "; ".join(
            split_chained_artists(val, is_classical=is_classical, known_artists=known_artists)
        )

    if apply_album_fields:
        orig_artist = (album.artist or "").strip()
        if orig_artist:
            next_artist = _split_join(orig_artist)
            if next_artist and next_artist != orig_artist:
                album.artist = next_artist
                changes.append(("Künstler", f"„{orig_artist}“ → „{next_artist}“"))

        orig_aartist = (album.album_artist or "").strip()
        if orig_aartist:
            next_aartist = _split_join(orig_aartist)
            if next_aartist and next_aartist != orig_aartist:
                album.album_artist = next_aartist
                changes.append(("Album-Interpret", f"„{orig_aartist}“ → „{next_aartist}“"))

        if is_classical:
            for attr, scope_lbl in (
                ("composer", "Komponist (Album)"),
                ("orchestra", "Orchester (Album)"),
                ("conductor", "Dirigent (Album)"),
            ):
                orig_v = str(getattr(album, attr, "") or "").strip()
                if orig_v:
                    next_v = _split_join(orig_v)
                    if next_v and next_v != orig_v:
                        setattr(album, attr, next_v)
                        changes.append((scope_lbl, f"„{orig_v}“ → „{next_v}“"))

    for trk in target_tracks:
        orig_t = (trk.title or "").strip()
        orig_a = (trk.artist or "").strip()
        clean_title, extracted = extract_features_from_title(
            orig_t, is_classical=is_classical, known_artists=known_artists
        )
        base_artists = split_chained_artists(
            orig_a, is_classical=is_classical, known_artists=known_artists
        )
        merged = _dedup_artist_tokens(base_artists + extracted)
        final_artist = "; ".join(merged)
        final_title = clean_title or orig_t

        details: list[str] = []
        if final_title != orig_t:
            trk.title = final_title
            details.append(f"Titel: „{orig_t}“ → „{final_title}“")
        if final_artist and final_artist != orig_a:
            trk.artist = final_artist
            details.append(f"Interpret: „{orig_a or '—'}“ → „{final_artist}“")
        if is_classical:
            for attr in ("composer", "orchestra", "conductor"):
                ov = str(getattr(trk, attr, "") or "").strip()
                if ov:
                    nv = _split_join(ov)
                    if nv and nv != ov:
                        setattr(trk, attr, nv)
        if details:
            changes.append((f"Titel #{trk.track_number:02d}", " · ".join(details)))

    return changes


def format_index_number(number: int, total: int = 0) -> str:
    """Formatiert Titel- und CD-Nummern zweistellig, ab >100 (bzw. >=100) dreistellig."""
    safe_num = max(0, int(number))
    safe_total = max(0, int(total))
    width = 3 if (safe_total >= 100 or safe_num >= 100) else 2
    return f"{safe_num:0{width}d}"


_CANONICAL_ROMAN_RE = re.compile(
    r"^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$"
)

_UNICODE_ROMAN_MAP: dict[str, str] = {
    "\u2160": "I",
    "\u2161": "II",
    "\u2162": "III",
    "\u2163": "IV",
    "\u2164": "V",
    "\u2165": "VI",
    "\u2166": "VII",
    "\u2167": "VIII",
    "\u2168": "IX",
    "\u2169": "X",
    "\u216a": "XI",
    "\u216b": "XII",
    "\u216c": "L",
    "\u216d": "C",
    "\u216e": "D",
    "\u216f": "M",
    "\u2170": "i",
    "\u2171": "ii",
    "\u2172": "iii",
    "\u2173": "iv",
    "\u2174": "v",
    "\u2175": "vi",
    "\u2176": "vii",
    "\u2177": "viii",
    "\u2178": "ix",
    "\u2179": "x",
    "\u217a": "xi",
    "\u217b": "xii",
    "\u217c": "l",
    "\u217d": "c",
    "\u217e": "d",
    "\u217f": "m",
}

_ROMAN_EXPLICIT_PREFIX_RE = re.compile(
    r"(?:^|[\s(\[,;:/–—-])(?:parts?|pts?\.?|teil(?:e|en)?|volumes?|vols?\.?|acts?|akte?|"
    r"chapters?|kap\.?|kapiteln?|books?|bücher|episodes?|eps?\.?|discs?|disks?|cds?|"
    r"sides?|seiten?|bände|band|bd\.?|suites?|nos?\.?|nrs?\.?|n°|opp?\.?|opus|"
    r"sätze|satz|movements?|movs?\.?|phases?|stages?|levels?|rounds?|runden?|tracks?|"
    r"sections?|sektionen?|tomes?|livres?|partes?|cantos?|scenes?|szenen?|"
    r"symphon(?:y|ies|ie|ien)|sinfonie(?:n)?|concertos?|konzerte?|sonatas?|sonaten?|"
    r"preludes?|préludes?|präludien|etudes?|études?|overtures?|ouvertüren?|"
    r"interludes?|interludien|stücke?|nummern?|versions?|editions?|seasons?|staffeln?|"
    r"generations?|gen|marks?|mks?\.?|divisions?|cycles?|zyklen?|sagas?|partitas?|"
    r"toccatas?|fugues?|fugen?|masses?|messen?|requiems?|cantatas?|kantaten?|motets?|"
    r"motetten?|nocturnes?|waltzes?|walzer|mazurkas?|polonaises?|rhapsod(?:y|ies|ie)|"
    r"fantas(?:ia|ies|ie)|serenades?|divertiment(?:o|i)|quartets?|quartette?|"
    r"quintets?|quintette?|trios?|duos?|sextets?|octets?|bagatelles?|impromptus?|"
    r"intermezzos?|capriccios?|ballades?|scherzos?|rondos?|canons?|kanons?|psalms?|"
    r"psalmen?|hymns?|hymnen?|sonnets?|sonette?|studies?|studien?|super\s+bowl)\s*$",
    re.IGNORECASE,
)

_ROMAN_X_SAFE_PREFIX_RE = re.compile(
    r"(?:^|[\s(\[,;:/–—-])(?:parts?|pts?\.?|teil(?:e|en)?|volumes?|vols?\.?|acts?|akte?|"
    r"chapters?|kap\.?|kapiteln?|books?|bücher|episodes?|eps?\.?|discs?|disks?|cds?|"
    r"sides?|seiten?|bände|band|bd\.?|suites?|nos?\.?|nrs?\.?|n°|opp?\.?|opus|"
    r"sätze|satz|movements?|movs?\.?|phases?|stages?|levels?|rounds?|runden?|tracks?|"
    r"sections?|sektionen?|tomes?|livres?|partes?|cantos?|scenes?|szenen?|"
    r"sinfonie(?:n)?|concertos?|konzerte?|sonatas?|sonaten?|preludes?|préludes?|präludien|"
    r"etudes?|études?|overtures?|ouvertüren?|interludes?|interludien|stücke?|nummern?|"
    r"versions?|editions?|seasons?|staffeln?|marks?|mks?\.?|divisions?|cycles?|zyklen?|"
    r"psalms?|psalmen?|sonnets?|sonette?|super\s+bowl)\s*$",
    re.IGNORECASE,
)

_ENGLISH_AFTER_I_VERBS_RE = re.compile(
    r"^\s+(?:am|was|were|are|be|can|could|will|would|shall|should|may|might|must|do|did|"
    r"don't|didn't|can't|won't|wouldn't|shouldn't|couldn't|have|had|has|love|loved|"
    r"hate|hated|know|knew|need|needed|want|wanted|feel|felt|see|saw|hear|heard|"
    r"think|thought|say|said|tell|told|make|made|get|got|give|gave|take|took|keep|kept|"
    r"find|found|lose|lost|leave|left|live|lived|die|died|cry|cried|try|tried|fly|flew|"
    r"run|ran|walk|walked|stand|stood|stay|stayed|wait|waited|wish|wished|hope|hoped|"
    r"dream|dreamed|remember|remembered|forget|forgot|believe|believed|trust|trusted|"
    r"miss|missed|like|liked|read|write|wrote|sing|sang|play|played|wear|wore|hold|held|"
    r"use|used|work|worked|call|called|look|looked|watch|watched|own|owned|went|came|"
    r"bring|brought|buy|bought|sell|sold|send|sent|choose|chose|break|broke|built|"
    r"grow|grew|met|put|let|cut|hit|beat|drive|drove|ride|rode|burn|burned|burnt|"
    r"turn|turned|mean|meant|swear|swore|owe|owed|pay|paid|pick|picked|drop|dropped|"
    r"pull|pulled|push|pushed|hide|hid|show|showed|ask|asked|answer|answered|follow|"
    r"followed|lead|led|fight|fought|win|won|pray|prayed|dance|danced|laugh|laughed|"
    r"smile|smiled|fear|feared|care|cared|ever|always|never|still|just|only|really|"
    r"also|already|almost|nearly|often|sometimes)\b",
    re.IGNORECASE,
)

_PRE_I_STOPWORDS: frozenset[str] = frozenset({
    "and", "or", "nor", "but", "yet", "so", "for", "than", "as", "like", "to", "of",
    "in", "on", "at", "by", "from", "with", "into", "onto", "upon", "about", "after",
    "before", "until", "till", "since", "while", "when", "where", "why", "how", "who",
    "whom", "whose", "what", "which", "that", "if", "unless", "though", "although",
    "because", "am", "is", "are", "was", "were", "be", "been", "being", "do", "does",
    "did", "can", "could", "will", "would", "shall", "should", "may", "might", "must",
    "have", "has", "had", "not", "no", "yes", "oh", "ah", "ooh", "hey", "yeah", "yea",
    "well", "here", "there", "now", "then", "only", "even", "just", "still", "also",
    "maybe", "perhaps", "all", "both", "neither", "either", "me", "you", "he", "she",
    "it", "we", "they", "him", "her", "us", "them", "mr", "mrs", "ms", "dr", "prof",
    "st", "dj", "mc", "agent", "vitamin", "factor", "team", "key", "letter", "plan",
    "vs", "v", "a", "e", "o", "u",
})

_PRE_V_STOPWORDS: frozenset[str] = frozenset({
    "mr", "mrs", "ms", "dr", "prof", "st", "dj", "mc", "agent", "vitamin", "factor",
    "team", "key", "letter", "in", "of", "and", "or", "for", "to", "by", "with", "from",
    "vs", "v", "a", "e", "o", "u",
})


def parse_canonical_roman_numeral(token: str) -> Optional[int]:
    """Parst kanonische römische Zahlen (I..MMMCMXCIX = 1..3999) und liefert None bei ungültiger Syntax."""
    upper = str(token or "").strip().upper()
    if not upper or not _CANONICAL_ROMAN_RE.match(upper):
        return None
    vals = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
    total = 0
    for idx, ch in enumerate(upper):
        cur = vals.get(ch, 0)
        nxt = vals.get(upper[idx + 1], 0) if idx + 1 < len(upper) else 0
        total += -cur if cur < nxt else cur
    return total if 1 <= total <= 3999 else None


def _is_simple_ivx_roman(upper: str) -> bool:
    return bool(re.fullmatch(r"[IVX]+", upper)) and parse_canonical_roman_numeral(upper) is not None


def convert_roman_numerals_in_title(text: str) -> str:
    """Wandelt römische Ziffern kontextsensitiv in arabische Zahlen um (schützt englisches 'I', Tonarten, 'Mix', 'CD' etc.)."""
    raw = str(text or "")
    if not raw.strip():
        return raw

    def _replace_unicode_seq(m: re.Match[str]) -> str:
        seq = m.group(0)
        mapped = "".join(_UNICODE_ROMAN_MAP.get(ch, "") for ch in seq)
        val = parse_canonical_roman_numeral(mapped)
        return str(val) if val is not None else seq

    working = re.sub(r"[\u2160-\u217F]+", _replace_unicode_seq, raw)

    replacements: list[tuple[int, int, str]] = []
    for match in re.finditer(r"[A-Za-z]+", working):
        tok = match.group(0)
        start, end = match.span()
        prev_ch = working[start - 1] if start > 0 else ""
        next_ch = working[end] if end < len(working) else ""

        if (prev_ch and prev_ch in "'’0123456789_") or (next_ch and next_ch in "'’0123456789_"):
            continue

        is_all_upper = tok == tok.upper() and tok != tok.lower()
        is_all_lower = tok == tok.lower() and tok != tok.upper()
        if not is_all_upper and not is_all_lower:
            continue

        upper = tok.upper()
        numeric_val = parse_canonical_roman_numeral(upper)
        if numeric_val is None:
            continue

        left_ctx = working[:start]
        right_ctx = working[end:]

        if next_ch == "." and (
            re.match(r"^\.[A-Za-z]", right_ctx)
            or re.match(r"^\.\s*[A-Za-z]\.", right_ctx)
        ):
            continue
        if prev_ch == ".":
            continue
        if (
            len(upper) == 1
            and re.search(r"[A-Za-z]\.\s*$", left_ctx)
            and re.match(r"^\s*\.", right_ctx)
        ):
            continue

        if prev_ch == "/" or next_ch == "/":
            lm = re.search(r"([A-Za-z]+)/$", left_ctx) if prev_ch == "/" else None
            rm = re.match(r"^/([A-Za-z]+)", right_ctx) if next_ch == "/" else None
            left_ok = bool(lm and parse_canonical_roman_numeral(lm.group(1)) is not None)
            right_ok = bool(rm and parse_canonical_roman_numeral(rm.group(1)) is not None)
            if not left_ok and not right_ok:
                continue

        if (prev_ch and prev_ch in ("-", "–", "—")) or (next_ch and next_ch in ("-", "–", "—")):
            lm = re.search(r"([A-Za-z]+)[-–—]$", left_ctx) if prev_ch in "-–—" else None
            rm = re.match(r"^[-–—]([A-Za-z]+)", right_ctx) if next_ch in "-–—" else None
            left_roman_ok = bool(lm and _is_simple_ivx_roman(lm.group(1).upper()))
            right_roman_ok = bool(rm and _is_simple_ivx_roman(rm.group(1).upper()))
            left_prefix_ok = bool(lm and _ROMAN_EXPLICIT_PREFIX_RE.search(f"{lm.group(1)} "))
            if not left_roman_ok and not right_roman_ok and not left_prefix_ok:
                continue

        if len(upper) == 1 and re.search(r"\d\s*$", left_ctx):
            continue

        has_explicit_prefix = bool(
            _ROMAN_X_SAFE_PREFIX_RE.search(left_ctx)
            if upper == "X"
            else _ROMAN_EXPLICIT_PREFIX_RE.search(left_ctx)
        )

        if has_explicit_prefix and upper == "I":
            has_det_before_prefix = bool(
                re.search(
                    r"\b(?:the|a|an|this|that|my|your|his|her|our|their|every|only|one|first|last|best|worst|same|which)\s+[A-Za-zÀ-ÖØ-öø-ÿ]+\.?\s*$",
                    left_ctx,
                    re.IGNORECASE,
                )
            )
            if _ENGLISH_AFTER_I_VERBS_RE.match(right_ctx) or (
                has_det_before_prefix and re.match(r"^\s+[A-Za-z]", right_ctx)
            ):
                continue

        at_segment_start = left_ctx.strip() == "" or bool(
            re.search(r"(?:[:/(\[–—]|\s-)\s*$", left_ctx)
        )
        has_enum_follow = bool(
            re.match(r"^\.\s+\S", right_ctx)
            or re.match(r"^:\s+\S", right_ctx)
            or (at_segment_start and is_all_upper and re.match(r"^\s+[-–—]\s+\S", right_ctx))
        )
        is_movement_enum = at_segment_start and has_enum_follow and _is_simple_ivx_roman(upper)

        is_bracketed_standalone = (
            bool(
                (re.search(r"\(\s*$", left_ctx) and re.match(r"^\s*\)", right_ctx))
                or (re.search(r"\[\s*$", left_ctx) and re.match(r"^\s*\]", right_ctx))
            )
            and _is_simple_ivx_roman(upper)
            and ((upper != "X") if is_all_upper else len(upper) >= 2)
        )

        rm_pair = re.match(r"^\s*(?:[-–—/,&]|\band\b|\bund\b)\s*([A-Za-z]+)\b", right_ctx, re.IGNORECASE)
        lm_pair = re.search(r"\b([A-Za-z]+)\s*(?:[-–—/,&]|\band\b|\bund\b)\s*$", left_ctx, re.IGNORECASE)
        right_pair = rm_pair.group(1) if rm_pair else ""
        left_pair = lm_pair.group(1) if lm_pair else ""
        is_direct_range_pair = (
            is_all_upper
            and _is_simple_ivx_roman(upper)
            and (
                (
                    bool(re.search(r"[-–—/]$", left_ctx))
                    and bool(left_pair)
                    and left_pair == left_pair.upper()
                    and _is_simple_ivx_roman(left_pair)
                )
                or (
                    bool(re.match(r"^[-–—/]", right_ctx))
                    and bool(right_pair)
                    and right_pair == right_pair.upper()
                    and _is_simple_ivx_roman(right_pair)
                )
            )
        )
        is_paired_roman = is_direct_range_pair or (
            is_all_upper
            and _is_simple_ivx_roman(upper)
            and (
                (
                    bool(right_pair)
                    and right_pair == right_pair.upper()
                    and len(right_pair) >= 2
                    and _is_simple_ivx_roman(right_pair)
                )
                or (
                    bool(left_pair)
                    and left_pair == left_pair.upper()
                    and len(left_pair) >= 2
                    and _is_simple_ivx_roman(left_pair)
                )
            )
        )

        should_convert = False
        if has_explicit_prefix or is_movement_enum or is_bracketed_standalone or is_paired_roman:
            should_convert = True
        elif is_all_upper:
            if len(upper) >= 2 and _is_simple_ivx_roman(upper):
                if upper == "IV" and re.match(
                    r"^\s+(?:drip|bag|tube|pole|line|therapy|solution)\b",
                    right_ctx,
                    re.IGNORECASE,
                ):
                    should_convert = False
                else:
                    should_convert = True
            elif len(upper) >= 4 and numeric_val >= 40:
                should_convert = True
            elif upper == "V":
                prev_word = re.search(r"([A-Za-zÀ-ÖØ-öø-ÿ]{2,})\s+$", left_ctx)
                right_delim = re.match(r"^\s*(?:$|[\)\]:–—\-\(\[,!?])", right_ctx)
                if prev_word and right_delim and prev_word.group(1).lower() not in _PRE_V_STOPWORDS:
                    should_convert = True
            elif upper == "I":
                prev_word = re.search(r"([A-Za-zÀ-ÖØ-öø-ÿ]{2,})\s+$", left_ctx)
                right_delim = re.match(r"^\s*(?:$|[\)\]:–—\-\(\[!?])", right_ctx)
                if (
                    left_ctx.strip() != ""
                    and prev_word
                    and right_delim
                    and prev_word.group(1).lower() not in _PRE_I_STOPWORDS
                ):
                    should_convert = True

        if should_convert:
            replacements.append((start, end, str(numeric_val)))

    if not replacements:
        return working

    parts: list[str] = []
    cursor = 0
    for start, end, val in replacements:
        parts.append(working[cursor:start])
        parts.append(val)
        cursor = end
    parts.append(working[cursor:])
    return "".join(parts)


class ExportFormat(str, Enum):
    FLAC = "flac"
    MP3 = "mp3"


class Mp3QualityMode(str, Enum):
    CBR_320 = "cbr_320"
    CBR_256 = "cbr_256"
    CBR_192 = "cbr_192"
    VBR_V0 = "vbr_v0"
    VBR_V2 = "vbr_v2"


class BatchStage(str, Enum):
    QUEUED = "Warteschlange"
    RIPPING = "Rippen (cdparanoia)"
    ENCODING_FLAC = "FLAC-Export"
    ENCODING_MP3 = "MP3-Export"
    TAGGING = "Metadaten & Cover"
    DONE = "Abgeschlossen"
    ERROR = "Fehler"
    CANCELLED = "Abgebrochen"


@dataclass
class TrackMetadata:
    track_number: int
    title: str
    artist: str = ""
    artists: list[str] = field(default_factory=list)
    artist_sort: str = ""
    duration_seconds: int = 0
    genre: str = ""
    isrc: str = ""
    isrcs: list[str] = field(default_factory=list)
    composer: str = ""
    orchestra: str = ""
    conductor: str = ""
    lyricist: str = ""
    writer: str = ""
    producer: str = ""
    work: str = ""
    work_language: str = ""
    musicbrainz_recording_id: str = ""
    musicbrainz_track_id: str = ""
    musicbrainz_artist_id: str = ""
    musicbrainz_work_id: str = ""
    musicbrainz_composer_id: str = ""
    shazam_key: str = ""
    shazam_url: str = ""
    metadata_source: str = ""
    original_title: str = ""
    original_artist: str = ""
    original_genre: str = ""
    original_metadata_source: str = ""
    shazam_title: str = ""
    shazam_artist: str = ""
    shazam_genre: str = ""
    shazam_metadata_source: str = ""
    mb_title: str = ""
    mb_artist: str = ""
    mb_genre: str = ""
    mb_metadata_source: str = ""
    active_metadata_variant: str = ""
    has_shazam_alternative: bool = False
    has_mb_alternative: bool = False
    extra_tags: dict[str, list[str]] = field(default_factory=dict)
    start_lsn: int = 0
    end_lsn: int = 0
    toc_track_number: int = 0
    selected: bool = True
    source_file: Optional[Path] = None  # Gesetzt bei Drag-and-Drop lokaler Audiodateien
    disc_number: int = 1
    disc_subtitle: str = ""
    audio_health_status: str = ""  # "", "scanning", "ok", "info", "warning", "critical"
    audio_health_color: str = ""   # Farbcode identisch zu Modul 5 (#94A3B8/#22C55E/#EAB308/#F97316/#DC2626)
    audio_health_tooltip: str = ""

    @property
    def duration_formatted(self) -> str:
        minutes, seconds = divmod(max(0, self.duration_seconds), 60)
        return f"{minutes:02d}:{seconds:02d}"


@dataclass
class AlbumMetadata:
    title: str = "Unbekanntes Album"
    artist: str = "Unbekannter Künstler"
    album_artist: str = ""
    album_artists: list[str] = field(default_factory=list)
    album_artist_sort: str = ""
    is_classical: bool = False
    composer: str = ""
    orchestra: str = ""
    conductor: str = ""
    year: str = ""
    release_date: str = ""
    original_date: str = ""
    genre: str = ""
    label: str = ""
    catalog_number: str = ""
    barcode: str = ""
    asin: str = ""
    country: str = ""
    status: str = ""
    release_type: str = ""
    media_format: str = ""
    disc_subtitle: str = ""
    script: str = ""
    language: str = ""
    disc_number: int = 1
    total_discs: int = 1
    cddb_id: str = ""
    musicbrainz_disc_id: str = ""
    musicbrainz_release_id: str = ""
    musicbrainz_release_group_id: str = ""
    musicbrainz_album_artist_id: str = ""
    discogs_release_id: str = ""
    musicbrainz_toc: str = ""
    track_offsets: list[int] = field(default_factory=list)
    leadout_offset: int = 0
    metadata_source: str = ""
    cover_art_bytes: Optional[bytes] = None
    cover_art_mime: str = "image/jpeg"
    cover_art_source: str = ""
    cover_art_width: int = 0
    cover_art_height: int = 0
    cover_art_original_format: str = ""
    available_discs: list[dict] = field(default_factory=list)
    extra_tags: dict[str, list[str]] = field(default_factory=dict)
    tracks: list[TrackMetadata] = field(default_factory=list)


MUSICBRAINZ_LEFT_TAG_FIELDS: list[dict] = [
    # Bisherige Standardfelder (standardmäßig aktiviert)
    {"id": "title", "label": "Albumtitel", "mb_tag": "ALBUM", "category": "basis", "default_visible": True, "track_transfer_key": None, "placeholder": ""},
    {"id": "albumArtist", "label": "Album-Interpret", "mb_tag": "ALBUMARTIST", "category": "basis", "default_visible": True, "track_transfer_key": None, "placeholder": ""},
    {"id": "artist", "label": "Künstler (Standard für Titel)", "mb_tag": "ARTIST", "category": "basis", "default_visible": True, "track_transfer_key": "artist", "placeholder": ""},
    {"id": "discNumber", "label": "CD-Nr. / Gesamt-CDs", "mb_tag": "DISCNUMBER / TOTALDISCS", "category": "basis", "default_visible": True, "track_transfer_key": None, "placeholder": ""},
    {"id": "year", "label": "Jahr", "mb_tag": "DATE (YEAR)", "category": "basis", "default_visible": True, "track_transfer_key": None, "placeholder": ""},
    {"id": "genre", "label": "Genre", "mb_tag": "GENRE", "category": "basis", "default_visible": True, "track_transfer_key": "genre", "placeholder": "z. B. Rock; Electronic"},
    {"id": "label", "label": "Label", "mb_tag": "LABEL", "category": "basis", "default_visible": True, "track_transfer_key": None, "placeholder": ""},
    {"id": "cddbId", "label": "CDDB DiscID", "mb_tag": "CDDB DISCID", "category": "identifiers", "default_visible": True, "track_transfer_key": None, "placeholder": ""},
    {"id": "musicbrainzReleaseId", "label": "MusicBrainz Release-ID", "mb_tag": "MUSICBRAINZ_ALBUMID", "category": "identifiers", "default_visible": True, "track_transfer_key": None, "placeholder": "UUID (z. B. e54e7c1c-...)"},
    {"id": "discogsId", "label": "Discogs Release-ID", "mb_tag": "DISCOGS_RELEASE_ID", "category": "identifiers", "default_visible": True, "track_transfer_key": None, "placeholder": "z. B. [r524030] oder 524030"},
    {"id": "asin", "label": "Amazon ASIN", "mb_tag": "ASIN", "category": "identifiers", "default_visible": True, "track_transfer_key": None, "placeholder": "z. B. B000002U82"},
    {"id": "barcode", "label": "Barcode (EAN / UPC) & QR-Code", "mb_tag": "BARCODE", "category": "identifiers", "default_visible": True, "track_transfer_key": None, "placeholder": "EAN-13 / UPC / QR-Code"},

    # Weitere gängige MusicBrainz-Tags (optional zuschaltbar)
    {"id": "albumArtistSort", "label": "Album-Interpret (Sortiername)", "mb_tag": "ALBUMARTISTSORT", "category": "basis", "default_visible": False, "track_transfer_key": None, "placeholder": "z. B. Beatles, The"},
    {"id": "albumSort", "label": "Albumtitel (Sortiername)", "mb_tag": "ALBUMSORT", "category": "basis", "default_visible": False, "track_transfer_key": None, "placeholder": "Sortiertitel des Albums"},
    {"id": "subtitle", "label": "Album-Untertitel / Edition", "mb_tag": "SUBTITLE", "category": "release", "default_visible": False, "track_transfer_key": None, "placeholder": "z. B. Deluxe Edition"},
    {"id": "discSubtitle", "label": "CD-Untertitel", "mb_tag": "DISCSUBTITLE", "category": "release", "default_visible": False, "track_transfer_key": "disc_subtitle", "placeholder": "z. B. Live in Berlin"},
    {"id": "releaseDate", "label": "Veröffentlichungsdatum", "mb_tag": "DATE", "category": "release", "default_visible": False, "track_transfer_key": None, "placeholder": "JJJJ-MM-TT"},
    {"id": "originalDate", "label": "Erstveröffentlichung", "mb_tag": "ORIGINALDATE", "category": "release", "default_visible": False, "track_transfer_key": None, "placeholder": "JJJJ-MM-TT"},
    {"id": "catalogNumber", "label": "Katalognummer", "mb_tag": "CATALOGNUMBER", "category": "release", "default_visible": False, "track_transfer_key": None, "placeholder": "z. B. 1C 064-46 311"},
    {"id": "country", "label": "Erscheinungsland", "mb_tag": "RELEASECOUNTRY", "category": "release", "default_visible": False, "track_transfer_key": None, "placeholder": "z. B. DE, US, GB"},
    {"id": "status", "label": "Release-Status", "mb_tag": "RELEASESTATUS", "category": "release", "default_visible": False, "track_transfer_key": None, "placeholder": "z. B. official, promotion"},
    {"id": "releaseType", "label": "Release-Typ", "mb_tag": "RELEASETYPE", "category": "release", "default_visible": False, "track_transfer_key": None, "placeholder": "z. B. album, compilation, live"},
    {"id": "mediaFormat", "label": "Medienformat", "mb_tag": "MEDIA", "category": "release", "default_visible": False, "track_transfer_key": None, "placeholder": "z. B. CD, Vinyl, Digital Media"},
    {"id": "script", "label": "Schriftsystem", "mb_tag": "SCRIPT", "category": "release", "default_visible": False, "track_transfer_key": None, "placeholder": "z. B. Latn, Cyrl, Jpan"},
    {"id": "language", "label": "Sprache", "mb_tag": "LANGUAGE", "category": "release", "default_visible": False, "track_transfer_key": None, "placeholder": "z. B. deu, eng"},
    {"id": "compilation", "label": "Compilation-Flag (0/1)", "mb_tag": "COMPILATION", "category": "release", "default_visible": False, "track_transfer_key": None, "placeholder": "1 für Sampler / VA"},

    {"id": "composer", "label": "Komponist", "mb_tag": "COMPOSER", "category": "credits", "default_visible": False, "track_transfer_key": "composer", "placeholder": "Mehrere mit ; trennen"},
    {"id": "orchestra", "label": "Orchester / Ensemble", "mb_tag": "PERFORMER:orchestra", "category": "credits", "default_visible": False, "track_transfer_key": "orchestra", "placeholder": "Mehrere mit ; trennen"},
    {"id": "conductor", "label": "Dirigent", "mb_tag": "CONDUCTOR", "category": "credits", "default_visible": False, "track_transfer_key": "conductor", "placeholder": "Mehrere mit ; trennen"},
    {"id": "lyricist", "label": "Texter / Liedtexter", "mb_tag": "LYRICIST", "category": "credits", "default_visible": False, "track_transfer_key": "lyricist", "placeholder": "Mehrere mit ; trennen"},
    {"id": "writer", "label": "Autor / Songwriter", "mb_tag": "WRITER", "category": "credits", "default_visible": False, "track_transfer_key": "writer", "placeholder": "Mehrere mit ; trennen"},
    {"id": "producer", "label": "Produzent", "mb_tag": "PRODUCER", "category": "credits", "default_visible": False, "track_transfer_key": "producer", "placeholder": "Mehrere mit ; trennen"},
    {"id": "arranger", "label": "Arrangeur", "mb_tag": "ARRANGER", "category": "credits", "default_visible": False, "track_transfer_key": "arranger", "placeholder": "Mehrere mit ; trennen"},
    {"id": "engineer", "label": "Toningenieur", "mb_tag": "ENGINEER", "category": "credits", "default_visible": False, "track_transfer_key": "engineer", "placeholder": "Mehrere mit ; trennen"},
    {"id": "mixer", "label": "Mix-Ingenieur", "mb_tag": "MIXER", "category": "credits", "default_visible": False, "track_transfer_key": "mixer", "placeholder": "Mehrere mit ; trennen"},
    {"id": "djmixer", "label": "DJ-Mixer", "mb_tag": "DJMIXER", "category": "credits", "default_visible": False, "track_transfer_key": "djmixer", "placeholder": "Mehrere mit ; trennen"},
    {"id": "remixer", "label": "Remixer", "mb_tag": "REMIXER", "category": "credits", "default_visible": False, "track_transfer_key": "remixer", "placeholder": "Mehrere mit ; trennen"},
    {"id": "work", "label": "Werk (Work)", "mb_tag": "WORK", "category": "credits", "default_visible": False, "track_transfer_key": "work", "placeholder": "Werkname"},
    {"id": "copyright", "label": "Copyright / Urheberrecht", "mb_tag": "COPYRIGHT", "category": "basis", "default_visible": False, "track_transfer_key": None, "placeholder": "z. B. ℗ 1981 Kling Klang"},
    {"id": "grouping", "label": "Gruppierung / Zyklus", "mb_tag": "GROUPING", "category": "basis", "default_visible": False, "track_transfer_key": None, "placeholder": "Übergeordnete Werkgruppe"},
    {"id": "mood", "label": "Stimmung (Mood)", "mb_tag": "MOOD", "category": "basis", "default_visible": False, "track_transfer_key": None, "placeholder": "z. B. Energetic, Melancholic"},
    {"id": "comment", "label": "Kommentar", "mb_tag": "COMMENT", "category": "basis", "default_visible": False, "track_transfer_key": None, "placeholder": "Freier Kommentar-Tag"},

    {"id": "musicbrainzReleaseGroupId", "label": "MusicBrainz Release-Group-ID", "mb_tag": "MUSICBRAINZ_RELEASEGROUPID", "category": "identifiers", "default_visible": False, "track_transfer_key": None, "placeholder": "UUID"},
    {"id": "musicbrainzAlbumArtistId", "label": "MusicBrainz Album-Artist-ID", "mb_tag": "MUSICBRAINZ_ALBUMARTISTID", "category": "identifiers", "default_visible": False, "track_transfer_key": None, "placeholder": "UUID"},
    {"id": "musicbrainzDiscId", "label": "MusicBrainz DiscID", "mb_tag": "MUSICBRAINZ_DISCID", "category": "identifiers", "default_visible": False, "track_transfer_key": None, "placeholder": "28-stellige DiscID"},
]

DEFAULT_VISIBLE_LEFT_TAG_FIELDS: list[str] = [
    str(f["id"]) for f in MUSICBRAINZ_LEFT_TAG_FIELDS if f.get("default_visible")
]
_VALID_LEFT_TAG_FIELD_IDS: set[str] = {str(f["id"]) for f in MUSICBRAINZ_LEFT_TAG_FIELDS}


def normalize_visible_left_tag_fields(raw_ids: object) -> list[str]:
    """Bereinigt eine Liste sichtbarer Feld-IDs anhand des definierten MusicBrainz-Katalogs."""
    if not isinstance(raw_ids, (list, tuple, set)):
        return list(DEFAULT_VISIBLE_LEFT_TAG_FIELDS)
    wanted = {str(x) for x in raw_ids if str(x) in _VALID_LEFT_TAG_FIELD_IDS}
    return [str(f["id"]) for f in MUSICBRAINZ_LEFT_TAG_FIELDS if str(f["id"]) in wanted]


DEFAULT_SHAZAM_SAMPLE_SIZE: int = 384000

SHAZAM_SAMPLE_SIZE_OPTIONS: list[dict] = [
    {"value": 128000, "label": "128000 – schnell, aber ungenauer (8 Sek.)", "seconds": 8},
    {"value": 192000, "label": "192000 – zügig, solide Erkennung (12 Sek.)", "seconds": 12},
    {"value": 256000, "label": "256000 – ausgewogen (16 Sek.)", "seconds": 16},
    {"value": 320000, "label": "320000 – präzise, längeres Sample (20 Sek.)", "seconds": 20},
    {"value": 384000, "label": "384000 – langsam, aber präziser (24 Sek.)", "seconds": 24},
]
_VALID_SHAZAM_SAMPLE_SIZES: set[int] = {int(opt["value"]) for opt in SHAZAM_SAMPLE_SIZE_OPTIONS}


def normalize_shazam_sample_size(raw_value: object) -> int:
    """Validiert die konfigurierte Shazam-Samplegröße gegen die festen Stufen (Standard: 384000)."""
    try:
        val = int(raw_value)  # type: ignore[arg-type]
    except Exception:
        return DEFAULT_SHAZAM_SAMPLE_SIZE
    return val if val in _VALID_SHAZAM_SAMPLE_SIZES else DEFAULT_SHAZAM_SAMPLE_SIZE


DEFAULT_COVER_MAX_DIMENSION: int = 2048


def normalize_cover_max_dimension(raw_value: object) -> int:
    """Validiert die konfigurierte maximale Cover-Pixeldimension für Modul 5 (Standard: 2048, Bereich: 256..8192)."""
    try:
        val = int(round(float(raw_value)))  # type: ignore[arg-type]
    except Exception:
        return DEFAULT_COVER_MAX_DIMENSION
    return max(256, min(8192, val))


DEFAULT_MAX_THREADS: int = 4


def normalize_max_threads(raw_value: object) -> int:
    """Validiert die maximale Thread-Anzahl für parallele Verarbeitung & FFmpeg (Standard: 4, Bereich: 1..16)."""
    try:
        val = int(round(float(raw_value)))  # type: ignore[arg-type]
    except Exception:
        return DEFAULT_MAX_THREADS
    return max(1, min(16, val))


COVER_PROVIDER_OPTIONS: list[dict] = [
    {
        "id": "musicbrainz_caa",
        "label": "MusicBrainz Cover Art Archive (Release)",
        "hint": "Original-Scans konkreter Pressungen · ohne API-Key",
    },
    {
        "id": "musicbrainz_rg_caa",
        "label": "MusicBrainz Release-Group CAA",
        "hint": "Übergeordnete Album-Cover als Ergänzung/Fallback · ohne API-Key",
    },
    {
        "id": "deezer",
        "label": "Deezer",
        "hint": "Große internationale Datenbank (1000×1000+ px) · ohne API-Key",
    },
    {
        "id": "theaudiodb",
        "label": "TheAudioDB",
        "hint": "Community-Cover per Künstler/Album & MB-ID · ohne API-Key",
    },
    {
        "id": "bandcamp",
        "label": "Bandcamp",
        "hint": "Indie, Metal, Electronic & Nischen-Labels (bis 1200 px) · ohne API-Key",
    },
    {
        "id": "itunes",
        "label": "iTunes / Apple Music (DE)",
        "hint": "Deutscher Store (bis 1400–3000 px) · ohne API-Key",
    },
    {
        "id": "itunes_multi_region",
        "label": "iTunes / Apple Music (Multi-Region: US & JP)",
        "hint": "US- & Japan-Store für internationale Pressungen · ohne API-Key",
    },
    {
        "id": "discogs",
        "label": "Discogs",
        "hint": "CD-, Vinyl- & Sammler-Editionen (Token optional)",
    },
    {
        "id": "amazon",
        "label": "Amazon (ASIN)",
        "hint": "Produktbilder über Amazon-ASIN · ohne API-Key",
    },
]

DEFAULT_COVER_PROVIDERS: list[str] = [str(p["id"]) for p in COVER_PROVIDER_OPTIONS]
_VALID_COVER_PROVIDER_IDS: set[str] = set(DEFAULT_COVER_PROVIDERS)


def normalize_cover_providers(raw_ids: object) -> list[str]:
    """Validiert die aktivierten Cover-Bilddatenbanken (Standard: alle aktiviert)."""
    if raw_ids is None or not isinstance(raw_ids, (list, tuple, set)):
        return list(DEFAULT_COVER_PROVIDERS)
    wanted = {str(x).strip() for x in raw_ids if str(x).strip() in _VALID_COVER_PROVIDER_IDS}
    return [str(p["id"]) for p in COVER_PROVIDER_OPTIONS if str(p["id"]) in wanted]


DEFAULT_OUTPUT_DIR_COVER: Path = Path.home() / "Musik" / "01_Coverbilder"
DEFAULT_OUTPUT_DIR_RIP: Path = Path.home() / "Musik" / "02_CD-Rips"
DEFAULT_OUTPUT_DIR_TAG: Path = Path.home() / "Musik" / "03_Album_getaggt"
DEFAULT_OUTPUT_DIR_CONVERT: Path = Path.home() / "Musik" / "04_konvertiert"
DEFAULT_OUTPUT_DIR_REPAIR: Path = Path.home() / "Musik" / "05_repariert"
DEFAULT_OUTPUT_DIR_CUT: Path = Path.home() / "Musik" / "06_geschnitten"


DEFAULT_MUSICBRAINZ_SERVER_URL: str = "https://musicbrainz.org/ws/2"


def normalize_musicbrainz_server_url(raw_value: object) -> str:
    """Validiert die MusicBrainz-WS2-Basis-URL (Standard: https://musicbrainz.org/ws/2, optional lokaler Mirror)."""
    val = str(raw_value or "").strip().rstrip("/")
    if not val:
        return DEFAULT_MUSICBRAINZ_SERVER_URL
    if not (val.startswith("https://") or val.startswith("http://")):
        return DEFAULT_MUSICBRAINZ_SERVER_URL
    if not val.endswith("/ws/2"):
        val = f"{val}/ws/2"
    return val


@dataclass
class ExportSettings:
    output_dir: Path = field(default_factory=lambda: DEFAULT_OUTPUT_DIR_RIP)
    output_dir_cover: Path = field(default_factory=lambda: DEFAULT_OUTPUT_DIR_COVER)
    output_dir_rip: Path = field(default_factory=lambda: DEFAULT_OUTPUT_DIR_RIP)
    output_dir_tag: Path = field(default_factory=lambda: DEFAULT_OUTPUT_DIR_TAG)
    output_dir_convert: Path = field(default_factory=lambda: DEFAULT_OUTPUT_DIR_CONVERT)
    output_dir_repair: Path = field(default_factory=lambda: DEFAULT_OUTPUT_DIR_REPAIR)
    output_dir_cut: Path = field(default_factory=lambda: DEFAULT_OUTPUT_DIR_CUT)
    filename_template: str = "{album_artist}/{year} - {album}/{track} - {title}"
    export_format: ExportFormat = ExportFormat.FLAC
    flac_compression_level: int = 8  # 0..8
    flac_verify: bool = True
    flac_replay_gain: bool = True
    mp3_quality: Mp3QualityMode = Mp3QualityMode.VBR_V0
    id3v2_version: int = 4  # 4 = ID3v2.4 (Standard), 3 = ID3v2.3 (Kompatibilität)
    normalize_album: bool = False
    normalize_target_lufs: float = -17.0
    normalize_compute_album_gain: bool = True
    normalize_use_loudest_track: bool = True
    normalize_true_peak: bool = True
    normalize_write_ref_loudness_tag: bool = True
    embed_cover_art: bool = True
    save_folder_cover: bool = True
    cover_filename: str = "cover"
    cover_max_dimension: int = DEFAULT_COVER_MAX_DIMENSION
    cover_providers: list[str] = field(default_factory=lambda: list(DEFAULT_COVER_PROVIDERS))
    max_threads: int = DEFAULT_MAX_THREADS
    discogs_token: str = ""
    lastfm_api_key: str = ""
    musicbrainz_server_url: str = DEFAULT_MUSICBRAINZ_SERVER_URL
    mb_load_deep_relations: bool = False
    prefer_subgenres: bool = True
    auto_enrich_track_genres: bool = True
    show_query_log: bool = False
    convert_roman_numerals: bool = True
    eject_after_rip: bool = False
    paranoia_mode: str = "full"  # full | disable-skip | fast
    scanner_device: str = ""
    scanner_dpi: int = 300  # 150 | 300 | 600 | 1200
    scanner_color_mode: str = "Color"  # Color | Gray | Lineart
    scanner_scan_area: str = "cd_booklet"  # cd_booklet | cd_inlay | full
    scanner_auto_open_crop: bool = True
    visible_left_tag_fields: list[str] = field(default_factory=lambda: list(DEFAULT_VISIBLE_LEFT_TAG_FIELDS))
    shazam_sample_size: int = DEFAULT_SHAZAM_SAMPLE_SIZE
    last_import_dir: Path = field(default_factory=lambda: Path.home() / "Musik")
    last_cover_dir: Path = field(default_factory=lambda: DEFAULT_OUTPUT_DIR_COVER)


@dataclass
class BatchJob:
    job_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    device_path: str = "/dev/cdrom"
    album: AlbumMetadata = field(default_factory=AlbumMetadata)
    track: TrackMetadata = field(default_factory=lambda: TrackMetadata(1, "Titel 1"))
    settings: ExportSettings = field(default_factory=ExportSettings)
    tag_only: bool = False
    group_id: str = ""
    group_label: str = ""
    stage: BatchStage = BatchStage.QUEUED
    progress: float = 0.0  # 0.0 .. 1.0
    status_message: str = "Bereit"
    output_files: list[Path] = field(default_factory=list)
    error_message: str = ""
