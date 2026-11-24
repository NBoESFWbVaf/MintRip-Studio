"""Metadaten-Abgleich über MusicBrainz (DiscID/TOC/Suche), Discogs, CDDB/GnuDB sowie Cover Art Archive & Amazon."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from email.utils import parsedate_to_datetime
import hashlib
import html
import http.client
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Optional

import musicbrainzngs

from .models import (
    COVER_PROVIDER_OPTIONS,
    DEFAULT_COVER_PROVIDERS,
    DEFAULT_MUSICBRAINZ_SERVER_URL,
    AlbumMetadata,
    TrackMetadata,
    normalize_cover_providers,
    normalize_multi_artist,
    normalize_musicbrainz_server_url,
)


from . import __version__ as APP_VERSION

USER_AGENT_APP = "MintRipStudio"
USER_AGENT_VERSION = APP_VERSION
USER_AGENT_CONTACT = "https://github.com/NBoESFWbVaf/mintrip-studio"
USER_AGENT_HEADER = f"{USER_AGENT_APP}/{USER_AGENT_VERSION} ({USER_AGENT_CONTACT})"
GNUDB_ENDPOINTS = (
    "https://gnudb.gnudb.org/~cddb/cddb.cgi",
    "http://gnudb.gnudb.org/~cddb/cddb.cgi",
)
# GnuDB verlangt eine registrierte/anerkannte Client-Kennung im hello-Parameter
GNUDB_HELLO = "anonymous+localhost+abcde+2.9.3"
MB_WS2_BASE = DEFAULT_MUSICBRAINZ_SERVER_URL
DISCOGS_API_BASE = "https://api.discogs.com"
LASTFM_API_BASE = "https://ws.audioscrobbler.com/2.0/"
_DISCOGS_ARTIST_SUFFIX_RE = re.compile(r"\s*\(\d+\)$")
_AMAZON_ASIN_URL_RE = re.compile(r"amazon\.[a-z.]+/(?:[^/]+/)?(?:dp|gp/product)/([A-Z0-9]{10})", re.IGNORECASE)
_SETTINGS_JSON_PATH = Path.home() / ".config" / "mintrip" / "settings.json"
_CACHE_DB_PATH = Path.home() / ".cache" / "mintrip" / "metadata_cache.sqlite"

musicbrainzngs.set_useragent(USER_AGENT_APP, USER_AGENT_VERSION, USER_AGENT_CONTACT)


def _read_settings_json_dict() -> dict:
    if _SETTINGS_JSON_PATH.exists():
        try:
            cfg = json.loads(_SETTINGS_JSON_PATH.read_text(encoding="utf-8"))
            if isinstance(cfg, dict):
                return cfg
        except Exception:
            pass
    return {}


def _get_configured_mb_base_url(explicit_url: str = "") -> str:
    if explicit_url and explicit_url.strip():
        return normalize_musicbrainz_server_url(explicit_url)
    env_url = os.environ.get("MUSICBRAINZ_SERVER_URL", "").strip()
    if env_url:
        return normalize_musicbrainz_server_url(env_url)
    cfg = _read_settings_json_dict()
    if cfg.get("musicbrainz_server_url"):
        return normalize_musicbrainz_server_url(cfg["musicbrainz_server_url"])
    return DEFAULT_MUSICBRAINZ_SERVER_URL


def _get_configured_lastfm_api_key(explicit_key: str = "") -> str:
    if explicit_key and explicit_key.strip():
        return explicit_key.strip()
    env_key = os.environ.get("LASTFM_API_KEY", "").strip()
    if env_key:
        return env_key
    cfg = _read_settings_json_dict()
    return str(cfg.get("lastfm_api_key") or "").strip()


def _get_configured_bool_setting(key: str, default: bool, explicit: Optional[bool] = None) -> bool:
    if explicit is not None:
        return bool(explicit)
    cfg = _read_settings_json_dict()
    if key in cfg:
        return bool(cfg[key])
    return default


# --- Persistenter SQLite-HTTP-Cache für MusicBrainz, Discogs, Last.fm & Wikidata ---
_CACHE_LOCK = threading.Lock()
_CACHE_CONN: Optional[sqlite3.Connection] = None


def _get_cache_conn() -> Optional[sqlite3.Connection]:
    global _CACHE_CONN
    if _CACHE_CONN is not None:
        return _CACHE_CONN
    try:
        _CACHE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(_CACHE_DB_PATH), check_same_thread=False)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS http_cache ("
            "cache_key TEXT PRIMARY KEY, "
            "payload TEXT NOT NULL, "
            "stored_at REAL NOT NULL, "
            "ttl_sec INTEGER NOT NULL)"
        )
        conn.commit()
        _CACHE_CONN = conn
        return _CACHE_CONN
    except Exception:
        return None


def _cache_get_json(cache_key: str) -> Optional[object]:
    with _CACHE_LOCK:
        conn = _get_cache_conn()
        if conn is None:
            return None
        try:
            row = conn.execute(
                "SELECT payload, stored_at, ttl_sec FROM http_cache WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()
            if not row:
                return None
            payload_str, stored_at, ttl_sec = row
            if time.time() - float(stored_at) > int(ttl_sec):
                conn.execute("DELETE FROM http_cache WHERE cache_key = ?", (cache_key,))
                conn.commit()
                return None
            return json.loads(payload_str)
        except Exception:
            return None


def _cache_set_json(cache_key: str, data: object, ttl_sec: int = 86400 * 14) -> None:
    with _CACHE_LOCK:
        conn = _get_cache_conn()
        if conn is None:
            return
        try:
            payload_str = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
            conn.execute(
                "INSERT OR REPLACE INTO http_cache (cache_key, payload, stored_at, ttl_sec) VALUES (?, ?, ?, ?)",
                (cache_key, payload_str, time.time(), int(ttl_sec)),
            )
            conn.commit()
        except Exception:
            pass


def clear_metadata_cache() -> int:
    """Leert den gesamten lokalen Metadaten-Cache (MusicBrainz, Discogs, Last.fm, Wikidata)."""
    with _CACHE_LOCK:
        conn = _get_cache_conn()
        if conn is None:
            return 0
        try:
            cur = conn.execute("SELECT COUNT(*) FROM http_cache")
            count = int(cur.fetchone()[0] or 0)
            conn.execute("DELETE FROM http_cache")
            conn.commit()
            return count
        except Exception:
            return 0


def get_metadata_cache_stats() -> dict:
    """Liefert Anzahl der zwischengespeicherten Einträge & Dateigröße in KB."""
    with _CACHE_LOCK:
        conn = _get_cache_conn()
        count = 0
        if conn is not None:
            try:
                count = int(conn.execute("SELECT COUNT(*) FROM http_cache").fetchone()[0] or 0)
            except Exception:
                count = 0
        size_kb = round(_CACHE_DB_PATH.stat().st_size / 1024.0, 1) if _CACHE_DB_PATH.exists() else 0.0
        return {"entries": count, "size_kb": size_kb}


def _log_step(message: str, on_log: Optional[Callable[[str], None]] = None) -> None:
    """Gibt einen Abfrageschritt mit Zeitstempel auf der Konsole aus und informiert optional die GUI."""
    ts = datetime.now().strftime("%H:%M:%S")
    formatted = f"[{ts}] {message}"
    print(f"[MintRip Abfrage] {formatted}", flush=True)
    if on_log is not None:
        try:
            on_log(formatted)
        except Exception:
            pass


def _get_configured_discogs_token(explicit_token: str = "") -> str:
    """Ermittelt das Discogs-Token aus Parameter, Umgebungsvariable DISCOGS_TOKEN oder settings.json."""
    if explicit_token and explicit_token.strip():
        return explicit_token.strip()
    env_tok = os.environ.get("DISCOGS_TOKEN", "").strip()
    if env_tok:
        return env_tok
    if _SETTINGS_JSON_PATH.exists():
        try:
            cfg = json.loads(_SETTINGS_JSON_PATH.read_text(encoding="utf-8"))
            if isinstance(cfg, dict) and cfg.get("discogs_token"):
                return str(cfg["discogs_token"]).strip()
        except Exception:
            pass
    return ""

_DISC_TITLE_PATTERNS = (
    re.compile(r"\s*[\(\[]\s*(?:disc|cd|disk)\s*(\d{1,2})\s*(?:/|of|von)\s*(\d{1,2})\s*[\)\]]\s*$", re.IGNORECASE),
    re.compile(r"\s*[\(\[]\s*(?:disc|cd|disk)\s*#?\s*(\d{1,2})\s*[\)\]]\s*$", re.IGNORECASE),
    re.compile(r"\s*[,/\-–]\s*(?:disc|cd|disk)\s*#?\s*(\d{1,2})\s*$", re.IGNORECASE),
)


def _as_dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _format_artist_credit(artist_credit: list) -> str:
    raw = "".join(
        (str(chunk.get("name") or _as_dict(chunk.get("artist")).get("name") or ""))
        + str(chunk.get("joinphrase") or "")
        for chunk in (artist_credit or [])
        if isinstance(chunk, dict)
    ).strip()
    return normalize_multi_artist(raw)


def _format_artist_sort_credit(artist_credit: list) -> str:
    raw = "".join(
        (
            str(
                _as_dict(chunk.get("artist")).get("sort-name")
                or chunk.get("name")
                or _as_dict(chunk.get("artist")).get("name")
                or ""
            )
        )
        + str(chunk.get("joinphrase") or "")
        for chunk in (artist_credit or [])
        if isinstance(chunk, dict)
    ).strip()
    return normalize_multi_artist(raw)


def _extract_artist_ids(artist_credit: list) -> str:
    ids: list[str] = []
    for chunk in artist_credit or []:
        if isinstance(chunk, dict):
            aid = _as_dict(chunk.get("artist")).get("id")
            if aid and aid not in ids:
                ids.append(aid)
    return "; ".join(ids)


def _extract_artist_names(artist_credit: list) -> list[str]:
    names: list[str] = []
    for chunk in artist_credit or []:
        if isinstance(chunk, dict):
            name = str(chunk.get("name") or _as_dict(chunk.get("artist")).get("name") or "").strip()
            if name and name not in names:
                names.append(name)
    return names


def _extract_release_countries(rel: dict) -> str:
    codes: list[str] = []
    primary = str(rel.get("country") or "").strip()
    if primary:
        codes.append(primary)
    for ev in rel.get("release-events") or []:
        if not isinstance(ev, dict):
            continue
        area = _as_dict(ev.get("area"))
        for code in area.get("iso-3166-1-codes") or []:
            c = str(code or "").strip()
            if c and c not in codes:
                codes.append(c)
    return "; ".join(codes)


def _collect_artist_role_ids(relations: list[dict], target_roles: tuple[str, ...]) -> list[str]:
    ids: list[str] = []
    for rel_item in relations or []:
        if not isinstance(rel_item, dict):
            continue
        if rel_item.get("target-type") == "artist" and isinstance(rel_item.get("artist"), dict):
            role = str(rel_item.get("type") or "").strip().lower()
            if role in target_roles:
                aid = str(rel_item["artist"].get("id") or "").strip()
                if aid and aid not in ids:
                    ids.append(aid)
    return ids


def _format_genre_token(token: str) -> str:
    cleaned = token.strip()
    if not cleaned:
        return ""
    lower = cleaned.lower()
    special = {
        "r&b": "R&B",
        "edm": "EDM",
        "idm": "IDM",
        "dnb": "Drum & Bass",
        "drum and bass": "Drum & Bass",
        "hip-hop": "Hip-Hop",
        "hip hop": "Hip-Hop",
        "hip hop music": "Hip-Hop",
        "synth-pop": "Synth-Pop",
        "synthpop": "Synth-Pop",
        "lo-fi": "Lo-Fi",
        "krautrock": "Krautrock",
        "electronic music": "Electronic",
        "experimental music": "Experimental",
        "rock music": "Rock",
        "pop music": "Pop",
        "ambient music": "Ambient",
        "jazz music": "Jazz",
        "classical music": "Classical",
        "heavy metal": "Heavy Metal",
        "progressive rock": "Progressive Rock",
        "psychedelic rock": "Psychedelic Rock",
        "dance music": "Dance",
        "folk music": "Folk",
        "soul music": "Soul",
        "country music": "Country",
        "disco music": "Disco",
        "house music": "House",
        "techno music": "Techno",
        "reggae music": "Reggae",
        "blues music": "Blues",
        "funk music": "Funk",
        "popmusik": "Pop",
        "rockmusik": "Rock",
        "elektronische musik": "Electronic",
        "klassische musik": "Classical",
        "filmmusik": "Soundtrack",
        "rhythm and blues": "R&B",
        "elektropop": "Electropop",
        "elektro-pop": "Electropop",
        "electro-pop": "Electropop",
        "electropop": "Electropop",
        "elektro": "Electro",
    }
    if lower in special:
        return special[lower]
    cleaned_no_suffix = re.sub(r"\s+(?:music|musik)$", "", cleaned, flags=re.IGNORECASE).strip()
    if cleaned_no_suffix:
        cleaned = cleaned_no_suffix
        if cleaned.lower() in special:
            return special[cleaned.lower()]
    parts = re.split(r"([\s\-/]+)", cleaned)
    formatted = []
    for part in parts:
        if not part or re.fullmatch(r"[\s\-/]+", part):
            formatted.append(part)
        elif part.isupper() and len(part) <= 4:
            formatted.append(part)
        else:
            formatted.append(part[0].upper() + part[1:].lower())
    return "".join(formatted)


def _canonical_genre_dedupe_key(genre_text: str) -> str:
    """Erzeugt einen normalisierten Vergleichsschlüssel zur zuverlässigen Genre-Deduplizierung."""
    s = unicodedata.normalize("NFKD", str(genre_text or "").strip().lower())
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.replace("&", "and")
    s = re.sub(r"\s+(?:music|musik)$", "", s).strip()
    return re.sub(r"[^a-z0-9]+", "", s)


def format_multi_genre(genres: list[str], max_items: int = 7) -> str:
    """Normalisiert mehrere Genres, entfernt Duplikate zuverlässig und trennt sie mit '; '."""
    seen: set[str] = set()
    result: list[str] = []
    for raw_entry in genres:
        for raw in re.split(r"[;,]+", str(raw_entry or "")):
            raw = raw.strip()
            if not raw:
                continue
            formatted = _format_genre_token(raw)
            if not formatted:
                continue
            key = _canonical_genre_dedupe_key(formatted)
            if not key or key in seen:
                continue
            seen.add(key)
            result.append(formatted)
            if len(result) >= max_items:
                return "; ".join(result)
    return "; ".join(result)


def _parse_cddb_genres(raw_genre: str) -> str:
    if not raw_genre:
        return ""
    tokens = [part.strip() for part in re.split(r"[;,/]+", raw_genre) if part.strip()]
    return format_multi_genre(tokens)


_BROAD_UMBRELLA_GENRES: frozenset[str] = frozenset(
    {
        "rock",
        "pop",
        "electronic",
        "metal",
        "punk",
        "jazz",
        "hip-hop",
        "hip hop",
        "rap",
        "classical",
        "folk",
        "country",
        "soul",
        "r&b",
        "rhythm and blues",
        "blues",
        "world",
        "world music",
        "indie",
        "alternative",
        "dance",
        "soundtrack",
        "stage & screen",
        "funk / soul",
        "folk, world, & country",
        "non-music",
        "latin",
    }
)

_NOISE_TAG_EXACT: frozenset[str] = frozenset(
    {
        "seen live",
        "favorites",
        "favourites",
        "favorite",
        "favourite",
        "my favorites",
        "albums i own",
        "awesome",
        "great",
        "love",
        "loved",
        "best",
        "good",
        "cool",
        "classic",
        "check out",
        "under 2000 listeners",
        "spotify",
        "all",
        "music",
        "songs",
        "tracks",
        "male vocalists",
        "female vocalists",
        "american",
        "british",
        "german",
        "english",
        "french",
        "japanese",
        "swedish",
        "canadian",
        "australian",
        "california",
        "los angeles",
        "new york",
        "london",
        "berlin",
        "usa",
        "uk",
        "deutsch",
        "english lyrics",
        "political",
        "angry",
        "fast",
        "energy",
        "energetic",
        "sad",
        "happy",
        "chill",
        "relax",
        "party",
        "workout",
        "driving",
        "summer",
        "winter",
        "live",
        "cover",
        "remix",
        "single",
        "album",
        "ep",
        "lp",
        "cd",
        "vinyl",
    }
)

_VALID_GENRE_KEYWORDS: tuple[str, ...] = (
    "rock",
    "punk",
    "hardcore",
    "metal",
    "grind",
    "core",
    "thrash",
    "doom",
    "sludge",
    "stoner",
    "djent",
    "grunge",
    "shoegaze",
    "britpop",
    "pop",
    "synth",
    "wave",
    "goth",
    "darkwave",
    "industrial",
    "ebm",
    "electro",
    "techno",
    "house",
    "trance",
    "ambient",
    "drone",
    "idm",
    "downtempo",
    "trip-hop",
    "trip hop",
    "breakbeat",
    "drum and bass",
    "drum & bass",
    "dnb",
    "jungle",
    "dubstep",
    "garage",
    "disco",
    "funk",
    "soul",
    "r&b",
    "rhythm and blues",
    "gospel",
    "blues",
    "jazz",
    "bebop",
    "swing",
    "fusion",
    "bossa",
    "samba",
    "salsa",
    "tango",
    "flamenco",
    "reggae",
    "dub",
    "ska",
    "rocksteady",
    "dancehall",
    "hip-hop",
    "hip hop",
    "rap",
    "trap",
    "boom bap",
    "grime",
    "folk",
    "bluegrass",
    "americana",
    "country",
    "celtic",
    "chanson",
    "schlager",
    "liedermacher",
    "neue deutsche",
    "krautrock",
    "classical",
    "baroque",
    "romantic",
    "opera",
    "symphon",
    "chamber",
    "choral",
    "minimalism",
    "neoclassical",
    "soundtrack",
    "score",
    "musical",
    "emo",
    "screamo",
    "oi!",
    "crust",
    "d-beat",
    "anarcho",
    "skate",
    "melodic",
    "psychobilly",
    "rockabilly",
    "surf",
    "psychedelic",
    "progressive",
    "art rock",
    "kraut",
    "post-",
    "nu ",
    "alt-",
    "alternative",
    "indie",
    "lo-fi",
    "lofi",
    "noise",
    "avant-garde",
    "experimental",
    "spoken word",
    "comedy",
    "a cappella",
    "acoustic",
    "ballad",
    "chillout",
    "lounge",
    "eurodance",
    "italo",
    "hardstyle",
    "gabber",
    "chiptune",
    "vaporwave",
    "afrobeat",
    "k-pop",
    "j-pop",
    "j-rock",
    "city pop",
)


def is_valid_music_genre_tag(raw_tag: str, artist_name: str = "", album_title: str = "") -> bool:
    """Prüft streng, ob ein Community-Tag (Last.fm/MB) ein echtes Musikgenre ist und kein Müll-/Dekaden-/Künstler-Tag."""
    clean = re.sub(r"\s+", " ", str(raw_tag or "").strip())
    if not clean or len(clean) < 2 or len(clean) > 42:
        return False
    low = clean.lower()
    if low in _NOISE_TAG_EXACT:
        return False
    # Reine Jahreszahlen / Dekaden (z. B. "80s", "1982", "90s") ausfiltern
    if re.fullmatch(r"(?:19|20)?\d0s|\d{4}s?|\d+", low):
        return False
    if artist_name and low == artist_name.strip().lower():
        return False
    if album_title and low == album_title.strip().lower():
        return False
    if low in _BROAD_UMBRELLA_GENRES:
        return True
    return any(kw in low for kw in _VALID_GENRE_KEYWORDS)


def filter_subgenres(genres: list[str], prefer_subgenres: Optional[bool] = None, max_items: int = 7) -> list[str]:
    """Bevorzugt spezifische Subgenres (z. B. Hardcore Punk, Skate Punk) und blendet grobe Verallgemeinerungen (Rock, Punk) aus, sobald Subgenres vorhanden sind."""
    pref = _get_configured_bool_setting("prefer_subgenres", True, explicit=prefer_subgenres)
    formatted_str = format_multi_genre(genres, max_items=max(max_items * 2, 16))
    items = [p.strip() for p in formatted_str.split(";") if p.strip()]
    if not items:
        return []
    if not pref:
        return items[:max_items]
    specific = [g for g in items if g.lower() not in _BROAD_UMBRELLA_GENRES]
    broad = [g for g in items if g.lower() in _BROAD_UMBRELLA_GENRES]
    if specific:
        return specific[:max_items]
    return broad[:max_items]


def _extract_recording_genres(rec: dict, prefer_subgenres: Optional[bool] = None) -> str:
    """Extrahiert liedspezifische Genres aus einem MusicBrainz-Recording (genres + kuratierte tags)."""
    rec = _as_dict(rec)
    raw_items: list[dict] = []
    raw_items.extend(rec.get("genres") or [])
    if not raw_items:
        for t in rec.get("tags") or []:
            if isinstance(t, dict) and int(t.get("count") or 0) > 0:
                if is_valid_music_genre_tag(str(t.get("name") or "")):
                    raw_items.append(t)
    sorted_items = sorted(
        [x for x in raw_items if isinstance(x, dict)],
        key=lambda x: int(x.get("count") or 0),
        reverse=True,
    )
    names = [str(item.get("name") or "") for item in sorted_items if item.get("name")]
    if not names:
        return ""
    return "; ".join(filter_subgenres(names, prefer_subgenres=prefer_subgenres, max_items=5))


def _extract_musicbrainz_genres(
    rel: dict,
    extra_recordings: list[dict] | None = None,
    prefer_subgenres: Optional[bool] = None,
) -> str:
    """Liest Genres aus Release, Release-Group & Recordings (mit Tag-Fallback & Subgenre-Priorisierung), getrennt durch '; '."""
    rel = _as_dict(rel)
    rg = _as_dict(rel.get("release-group"))
    raw_items: list[dict] = []
    raw_items.extend(rg.get("genres") or [])
    raw_items.extend(rel.get("genres") or [])
    for rec in extra_recordings or []:
        if isinstance(rec, dict):
            raw_items.extend(rec.get("genres") or [])

    if not raw_items:
        tags = []
        tags.extend(rg.get("tags") or [])
        tags.extend(rel.get("tags") or [])
        for rec in extra_recordings or []:
            if isinstance(rec, dict):
                tags.extend(rec.get("tags") or [])
        raw_items = [
            t
            for t in tags
            if isinstance(t, dict)
            and int(t.get("count") or 0) > 0
            and is_valid_music_genre_tag(str(t.get("name") or ""))
        ]

    valid_items = [x for x in raw_items if isinstance(x, dict)]
    sorted_items = sorted(valid_items, key=lambda x: int(x.get("count") or 0), reverse=True)
    names = [str(item.get("name") or "") for item in sorted_items if item.get("name")]
    return "; ".join(filter_subgenres(names, prefer_subgenres=prefer_subgenres, max_items=7))


_UUID_RE = re.compile(r"^[a-f0-9-]{36}$", re.IGNORECASE)


def fetch_wikidata_genres(
    release_id: str = "",
    release_group_id: str = "",
    artist_id: str = "",
    artist_name: str = "",
    album_title: str = "",
) -> list[str]:
    """Fragt Wikidata (SPARQL via MusicBrainz-IDs oder Titelsuche, mit lokalem Cache) nach weiteren Genres (P136) ab."""
    cache_key = (
        f"wikidata_genres:{release_id.strip()}:{release_group_id.strip()}:"
        f"{artist_id.strip()}:{artist_name.strip().lower()}:{album_title.strip().lower()}"
    )
    cached = _cache_get_json(cache_key)
    if isinstance(cached, list):
        return [str(x) for x in cached if x]

    headers = {
        "User-Agent": f"{USER_AGENT_APP}/{USER_AGENT_VERSION} ({USER_AGENT_CONTACT})",
        "Accept": "application/json",
    }
    unions: list[str] = []
    if release_id and _UUID_RE.match(release_id.strip()):
        unions.append(
            f'{{ BIND(1 AS ?prio) ?item wdt:P5813 "{release_id.strip()}" . ?item wdt:P136 ?genre . }}'
        )
    if release_group_id and _UUID_RE.match(release_group_id.strip()):
        unions.append(
            f'{{ BIND(2 AS ?prio) ?item wdt:P436 "{release_group_id.strip()}" . ?item wdt:P136 ?genre . }}'
        )
    for aid in [part.strip() for part in artist_id.split(";") if part.strip()][:2]:
        if _UUID_RE.match(aid):
            unions.append(
                f'{{ BIND(3 AS ?prio) ?item wdt:P434 "{aid}" . ?item wdt:P136 ?genre . }}'
            )

    genres: list[str] = []
    if unions:
        sparql = (
            "SELECT DISTINCT ?prio ?genreLabel WHERE {\n  "
            + "\n  UNION\n  ".join(unions)
            + '\n  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de". }\n}\n'
            + "ORDER BY ?prio\nLIMIT 20"
        )
        url = "https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(sparql)
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="replace"))
            for row in _as_dict(_as_dict(data).get("results")).get("bindings") or []:
                if not isinstance(row, dict):
                    continue
                val = str(_as_dict(row.get("genreLabel")).get("value") or "").strip()
                if val and not re.fullmatch(r"Q\d+", val):
                    genres.append(val)
        except Exception:
            pass

    # Fallback über Wikidata-Suche nach Album/Künstler, falls noch keine Genres gefunden wurden
    if not genres and (album_title or artist_name):
        search_term = f"{artist_name} {album_title}".strip()
        try:
            search_url = (
                "https://www.wikidata.org/w/api.php?action=wbsearchentities"
                f"&search={urllib.parse.quote(search_term)}&language=en&format=json&limit=3"
            )
            req = urllib.request.Request(search_url, headers=headers)
            with urllib.request.urlopen(req, timeout=6) as resp:
                sdata = json.loads(resp.read().decode("utf-8", errors="replace"))
            qids = [item["id"] for item in (_as_dict(sdata).get("search") or []) if isinstance(item, dict) and item.get("id")]
            if qids:
                qid_values = " ".join(f"wd:{q}" for q in qids[:3] if re.fullmatch(r"Q\d+", q))
                if qid_values:
                    sparql = (
                        f"SELECT DISTINCT ?genreLabel WHERE {{ VALUES ?item {{ {qid_values} }} "
                        "?item wdt:P136 ?genre . "
                        'SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de". } } LIMIT 12'
                    )
                    qurl = "https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(sparql)
                    qreq = urllib.request.Request(qurl, headers=headers)
                    with urllib.request.urlopen(qreq, timeout=6) as qresp:
                        qdata = json.loads(qresp.read().decode("utf-8", errors="replace"))
                    for row in _as_dict(_as_dict(qdata).get("results")).get("bindings") or []:
                        if not isinstance(row, dict):
                            continue
                        val = str(_as_dict(row.get("genreLabel")).get("value") or "").strip()
                        if val and not re.fullmatch(r"Q\d+", val):
                            genres.append(val)
        except Exception:
            pass

    _cache_set_json(cache_key, genres, ttl_sec=86400 * 14)
    return genres


def merge_genre_strings(
    *genre_sources: str | list[str],
    max_items: int = 7,
    prefer_subgenres: Optional[bool] = None,
) -> str:
    """Führt Genres aus MusicBrainz, Discogs, Last.fm, CDDB und Wikidata zusammen (mit Subgenre-Priorisierung)."""
    tokens: list[str] = []
    for src in genre_sources:
        if isinstance(src, str):
            tokens.extend(part.strip() for part in re.split(r"[;,]+", src) if part.strip())
        elif isinstance(src, list):
            tokens.extend(str(part).strip() for part in src if str(part).strip())
    return "; ".join(filter_subgenres(tokens, prefer_subgenres=prefer_subgenres, max_items=max_items))


def _extract_disc_info_from_title(title: str) -> tuple[str, int, int]:
    """Erkennt Multi-CD-Hinweise wie '(Disc 2)' oder '(CD 2/3)' aus Albumnamen."""
    for pattern in _DISC_TITLE_PATTERNS:
        match = pattern.search(title)
        if match:
            disc_num = max(1, int(match.group(1)))
            total_discs = max(disc_num, int(match.group(2))) if match.lastindex and match.lastindex >= 2 else max(2, disc_num)
            clean_title = pattern.sub("", title).strip() or title
            return clean_title, disc_num, total_discs
    return title, 1, 1


def _collect_artist_relations(relations: list[dict]) -> dict[str, list[str]]:
    """Sammelt Künstler-Beziehungen (Komponist, Texter, Produzent, Mixer, etc.) aus MusicBrainz."""
    role_map: dict[str, list[str]] = {}
    for rel_item in relations or []:
        if not isinstance(rel_item, dict):
            continue
        if rel_item.get("target-type") == "artist" and isinstance(rel_item.get("artist"), dict):
            role = str(rel_item.get("type") or "").strip().lower()
            name = str(rel_item["artist"].get("name") or "").strip()
            if role and name:
                attrs = [str(a).strip() for a in (rel_item.get("attributes") or []) if a]
                label = f"{name} ({', '.join(attrs)})" if attrs and role in ("instrument", "vocal", "performer") else name
                bucket = role_map.setdefault(role, [])
                if label not in bucket:
                    bucket.append(label)
    return role_map


_MB_RATE_LOCK = threading.Lock()
_LAST_MB_STARTED_TS = 0.0
_MB_COOLDOWN_UNTIL = 0.0
_MB_MIN_INTERVAL_SEC = 1.18
_MB_CONSECUTIVE_503 = 0
_MB_CIRCUIT_OPEN_UNTIL = 0.0


def _is_official_musicbrainz_host(url_str: str) -> bool:
    try:
        host = (urllib.parse.urlparse(url_str).hostname or "").lower()
        return host == "musicbrainz.org" or host.endswith(".musicbrainz.org")
    except Exception:
        return "musicbrainz.org" in url_str


def is_musicbrainz_circuit_open() -> bool:
    return time.monotonic() < _MB_CIRCUIT_OPEN_UNTIL


def _parse_retry_after_sec(header_val: Optional[str]) -> float:
    if not header_val:
        return 0.0
    txt = str(header_val).strip()
    try:
        secs = float(txt)
        return max(0.0, secs)
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(txt)
        return max(0.0, dt.timestamp() - time.time())
    except Exception:
        return 0.0


def _sleep_cancellable(seconds: float, cancel_event: Optional[threading.Event] = None) -> None:
    if seconds <= 0.0:
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("Abfrage durch Benutzer gestoppt.")
        return
    if cancel_event is not None:
        if cancel_event.wait(timeout=seconds):
            raise InterruptedError("Abfrage durch Benutzer gestoppt.")
    else:
        time.sleep(seconds)


def _urlopen_with_backoff(
    req: urllib.request.Request,
    timeout: int = 12,
    max_retries: int = 2,
    on_log: Optional[Callable[[str], None]] = None,
    label: str = "API",
    cancel_event: Optional[threading.Event] = None,
    wait_on_circuit: bool = False,
) -> bytes:
    """Führt einen HTTP-Request mit Startzeit-Token-Bucket (1.18s), Circuit-Breaker, Retry-After & Backoff aus."""
    global _LAST_MB_STARTED_TS, _MB_COOLDOWN_UNTIL, _MB_MIN_INTERVAL_SEC, _MB_CONSECUTIVE_503, _MB_CIRCUIT_OPEN_UNTIL
    url_str = getattr(req, "full_url", "")
    is_mb = _is_official_musicbrainz_host(url_str)

    if is_mb:
        now_mono = time.monotonic()
        if _MB_CIRCUIT_OPEN_UNTIL > 0.0 and now_mono >= _MB_CIRCUIT_OPEN_UNTIL:
            with _MB_RATE_LOCK:
                if time.monotonic() >= _MB_CIRCUIT_OPEN_UNTIL:
                    _MB_CIRCUIT_OPEN_UNTIL = 0.0
                    _MB_CONSECUTIVE_503 = 0
        elif now_mono < _MB_CIRCUIT_OPEN_UNTIL:
            rem = max(0.5, _MB_CIRCUIT_OPEN_UNTIL - now_mono)
            if wait_on_circuit:
                _log_step(
                    f"[{label}] Rate-Limit-Abkühlpause ({rem:.0f}s) – warte kurz ab und setze danach fort…",
                    on_log,
                )
                _sleep_cancellable(rem + 0.15, cancel_event)
                if cancel_event is not None and cancel_event.is_set():
                    raise InterruptedError("Abfrage durch Benutzer gestoppt.")
                with _MB_RATE_LOCK:
                    if time.monotonic() >= _MB_CIRCUIT_OPEN_UNTIL:
                        _MB_CIRCUIT_OPEN_UNTIL = 0.0
                        _MB_CONSECUTIVE_503 = 0
            else:
                _log_step(
                    f"[{label}] Circuit-Breaker aktiv (noch {rem:.0f}s Abkühlung nach wiederholtem 503) – überspringe MusicBrainz vorübergehend.",
                    on_log,
                )
                raise urllib.error.HTTPError(url_str, 503, "MusicBrainz Circuit-Breaker aktiv", None, None)

    last_exc: Optional[Exception] = None
    for attempt in range(max_retries + 1):
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("Abfrage durch Benutzer gestoppt.")
        try:
            if is_mb:
                # Startzeit-Token-Bucket: Lock nur für Slot-Reservierung halten, nicht während gesamter Netzwerk-Latenz
                with _MB_RATE_LOCK:
                    now = time.monotonic()
                    next_by_interval = (
                        _LAST_MB_STARTED_TS + _MB_MIN_INTERVAL_SEC if _LAST_MB_STARTED_TS > 0.0 else 0.0
                    )
                    target = max(next_by_interval, _MB_COOLDOWN_UNTIL)
                    if target > now:
                        _sleep_cancellable(target - now, cancel_event)
                    if cancel_event is not None and cancel_event.is_set():
                        raise InterruptedError("Abfrage durch Benutzer gestoppt.")
                    _LAST_MB_STARTED_TS = time.monotonic()

                try:
                    with urllib.request.urlopen(req, timeout=timeout) as resp:
                        body = resp.read()
                    with _MB_RATE_LOCK:
                        _MB_CONSECUTIVE_503 = 0
                        _MB_MIN_INTERVAL_SEC = max(1.18, _MB_MIN_INTERVAL_SEC - 0.10)
                    return body
                except urllib.error.HTTPError as http_exc:
                    if http_exc.code in (503, 429):
                        with _MB_RATE_LOCK:
                            _MB_CONSECUTIVE_503 += 1
                            _MB_MIN_INTERVAL_SEC = min(3.2, max(1.6, _MB_MIN_INTERVAL_SEC + 0.45))
                            ra_sec = _parse_retry_after_sec(http_exc.headers.get("Retry-After") if http_exc.headers else None)
                            _MB_COOLDOWN_UNTIL = max(
                                _MB_COOLDOWN_UNTIL,
                                time.monotonic() + max(ra_sec + 0.25, _MB_MIN_INTERVAL_SEC),
                            )
                            if _MB_CONSECUTIVE_503 >= 4:
                                _MB_CIRCUIT_OPEN_UNTIL = time.monotonic() + 10.0
                    raise
            else:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return resp.read()
        except InterruptedError:
            raise
        except urllib.error.HTTPError as http_exc:
            last_exc = http_exc
            if http_exc.code in (503, 429, 502, 504) and attempt < max_retries:
                if is_mb and time.monotonic() < _MB_CIRCUIT_OPEN_UNTIL:
                    if wait_on_circuit:
                        rem = max(0.5, _MB_CIRCUIT_OPEN_UNTIL - time.monotonic())
                        _log_step(
                            f"[{label}] Wiederholtes Rate-Limit (HTTP {http_exc.code}) – warte {rem:.0f}s Abkühlpause und versuche erneut…",
                            on_log,
                        )
                        _sleep_cancellable(rem + 0.15, cancel_event)
                        with _MB_RATE_LOCK:
                            _MB_CIRCUIT_OPEN_UNTIL = 0.0
                            _MB_CONSECUTIVE_503 = 0
                        continue
                    _log_step(
                        f"[{label}] Wiederholtes Rate-Limit (HTTP {http_exc.code}) – aktiviere 10s Circuit-Breaker, weiche auf schnelle Quellen aus.",
                        on_log,
                    )
                    raise
                ra_sec = _parse_retry_after_sec(http_exc.headers.get("Retry-After") if http_exc.headers else None)
                exp_delay = 1.8 * (1.7 ** attempt)
                delay = min(10.0, max(ra_sec + 0.25 if ra_sec > 0 else 0.0, exp_delay))
                if is_mb:
                    with _MB_RATE_LOCK:
                        _MB_COOLDOWN_UNTIL = max(_MB_COOLDOWN_UNTIL, time.monotonic() + delay)
                _log_step(
                    f"[{label}] HTTP {http_exc.code} (Rate-Limit / Server ausgelastet) – Wiederholungsversuch "
                    f"{attempt + 1}/{max_retries} in {delay:.1f}s...",
                    on_log,
                )
                if not is_mb:
                    _sleep_cancellable(delay, cancel_event)
                continue
            raise
        except (
            urllib.error.URLError,
            TimeoutError,
            socket.timeout,
            http.client.HTTPException,
            ConnectionError,
            OSError,
        ) as net_exc:
            last_exc = net_exc
            if attempt < max_retries:
                delay = min(10.0, 1.8 * (1.7 ** attempt))
                if is_mb:
                    with _MB_RATE_LOCK:
                        _MB_COOLDOWN_UNTIL = max(_MB_COOLDOWN_UNTIL, time.monotonic() + delay)
                reason_txt = getattr(net_exc, "reason", None) or str(net_exc) or type(net_exc).__name__
                _log_step(
                    f"[{label}] Zeitüberschreitung / Verbindungsfehler ({reason_txt}) – Wiederholungsversuch "
                    f"{attempt + 1}/{max_retries} in {delay:.1f}s...",
                    on_log,
                )
                if not is_mb:
                    _sleep_cancellable(delay, cancel_event)
                continue
            raise
    if last_exc:
        raise last_exc
    return b""


def _mb_ws2_get_json(
    path: str,
    on_log: Optional[Callable[[str], None]] = None,
    cancel_event: Optional[threading.Event] = None,
    timeout: int = 18,
    max_retries: int = 2,
    use_cache: bool = True,
    ttl_sec: Optional[int] = None,
    mb_server_url: str = "",
    wait_on_circuit: bool = False,
) -> dict:
    base_url = _get_configured_mb_base_url(mb_server_url)
    clean_path = path.lstrip("/")
    url = f"{base_url}/{clean_path}"
    cache_key = f"mb:{url}"

    if use_cache:
        cached = _cache_get_json(cache_key)
        if isinstance(cached, dict):
            return cached

    if ttl_sec is None:
        if clean_path.startswith(("release/?", "recording/?", "release-group/?", "artist/?")):
            ttl_sec = 86400 * 7
        elif clean_path.startswith("discid/"):
            ttl_sec = 86400 * 14
        else:
            ttl_sec = 86400 * 30

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": f"{USER_AGENT_APP}/{USER_AGENT_VERSION} ({USER_AGENT_CONTACT})",
            "Accept": "application/json",
            "Connection": "keep-alive",
        },
    )
    raw = _urlopen_with_backoff(
        req,
        timeout=timeout,
        max_retries=max_retries,
        on_log=on_log,
        label="MusicBrainz",
        cancel_event=cancel_event,
        wait_on_circuit=wait_on_circuit,
    )
    parsed = json.loads(raw.decode("utf-8", errors="replace"))
    if use_cache and isinstance(parsed, dict):
        _cache_set_json(cache_key, parsed, ttl_sec=ttl_sec)
    return parsed


def _preserve_physical_toc(target: AlbumMetadata, physical: AlbumMetadata) -> AlbumMetadata:
    """Übernimmt Sektor-Grenzen, lokale Quelldateien, lokales Ordner-Cover und DiscIDs auf erkannte Metadaten."""
    target.cddb_id = physical.cddb_id or target.cddb_id
    target.musicbrainz_disc_id = physical.musicbrainz_disc_id or target.musicbrainz_disc_id
    target.musicbrainz_toc = physical.musicbrainz_toc or target.musicbrainz_toc
    target.track_offsets = physical.track_offsets or target.track_offsets
    target.leadout_offset = physical.leadout_offset or target.leadout_offset
    if getattr(physical, "total_discs", 1) > getattr(target, "total_discs", 1):
        target.total_discs = physical.total_discs
    if getattr(physical, "available_discs", None) and not getattr(target, "available_discs", None):
        target.available_discs = list(physical.available_discs)

    # Vorhandenes lokales Bild im Verzeichnis (oder eingebettetes Cover) nicht überschreiben!
    if physical.cover_art_bytes and (
        not target.cover_art_bytes
        or physical.cover_art_source.startswith(("Ordner-Bild", "Eingebettetes Cover", "Festplatte", "Scanner"))
    ):
        target.cover_art_bytes = physical.cover_art_bytes
        target.cover_art_mime = physical.cover_art_mime or "image/jpeg"
        target.cover_art_source = physical.cover_art_source

    phys_by_key: dict[tuple[int, int], TrackMetadata] = {}
    for p_trk in physical.tracks:
        p_disc = max(1, getattr(p_trk, "disc_number", 1) or 1)
        phys_by_key.setdefault((p_disc, p_trk.track_number), p_trk)

    phys_discs = {max(1, getattr(t, "disc_number", 1) or 1) for t in physical.tracks}
    target_discs = {max(1, getattr(t, "disc_number", 1) or 1) for t in target.tracks}
    use_key_match = len(phys_discs) > 1 or len(target_discs) > 1
    used_phys_ids: set[int] = set()

    for idx, trk in enumerate(target.tracks):
        t_disc = max(1, getattr(trk, "disc_number", 0) or target.disc_number or 1)
        trk.disc_number = t_disc
        phys_trk: Optional[TrackMetadata] = None
        if use_key_match:
            cand = phys_by_key.get((t_disc, trk.track_number))
            if cand is not None and id(cand) not in used_phys_ids:
                phys_trk = cand
        if phys_trk is None and idx < len(physical.tracks):
            cand = physical.tracks[idx]
            if not use_key_match or id(cand) not in used_phys_ids:
                phys_trk = cand
        if phys_trk is not None:
            used_phys_ids.add(id(phys_trk))
            trk.start_lsn = phys_trk.start_lsn
            trk.end_lsn = phys_trk.end_lsn
            trk.toc_track_number = int(getattr(phys_trk, "toc_track_number", 0) or phys_trk.track_number or 0)
            if phys_trk.source_file:
                trk.source_file = phys_trk.source_file
            if getattr(phys_trk, "audio_health_status", ""):
                trk.audio_health_status = phys_trk.audio_health_status
                trk.audio_health_color = getattr(phys_trk, "audio_health_color", "")
                trk.audio_health_tooltip = getattr(phys_trk, "audio_health_tooltip", "")
            if not trk.duration_seconds:
                trk.duration_seconds = phys_trk.duration_seconds
            if not trk.isrc and phys_trk.isrc:
                trk.isrc = phys_trk.isrc
            if not trk.isrcs and phys_trk.isrcs:
                trk.isrcs = list(phys_trk.isrcs)
            if not getattr(trk, "genre", "") and getattr(phys_trk, "genre", ""):
                trk.genre = phys_trk.genre
            for fallback_attr in (
                "artist_sort",
                "composer",
                "orchestra",
                "conductor",
                "lyricist",
                "writer",
                "producer",
                "work",
                "work_language",
                "disc_subtitle",
                "musicbrainz_recording_id",
                "musicbrainz_track_id",
                "musicbrainz_artist_id",
                "musicbrainz_work_id",
                "musicbrainz_composer_id",
            ):
                if not getattr(trk, fallback_attr, "") and getattr(phys_trk, fallback_attr, ""):
                    setattr(trk, fallback_attr, getattr(phys_trk, fallback_attr))
            # Lokale Datei-Zusatztags (insbesondere ReplayGain, R128, AcoustID, Kommentar, Lyrics, Custom-Tags)
            # beim Online-Abgleich unbedingt erhalten und nicht überschreiben!
            phys_extra = getattr(phys_trk, "extra_tags", None) or {}
            if isinstance(phys_extra, dict) and phys_extra:
                merged_extra: dict[str, list[str]] = {}
                for k_loc, v_loc in phys_extra.items():
                    if isinstance(v_loc, (list, tuple)):
                        vals = [str(x).strip() for x in v_loc if str(x).strip()]
                    elif v_loc is not None and str(v_loc).strip():
                        vals = [str(v_loc).strip()]
                    else:
                        vals = []
                    if vals:
                        merged_extra[str(k_loc)] = vals
                for k_on, v_on in (getattr(trk, "extra_tags", None) or {}).items():
                    if isinstance(v_on, (list, tuple)):
                        vals = [str(x).strip() for x in v_on if str(x).strip()]
                    elif v_on is not None and str(v_on).strip():
                        vals = [str(v_on).strip()]
                    else:
                        vals = []
                    if vals:
                        merged_extra[str(k_on)] = vals
                trk.extra_tags = merged_extra

    phys_album_extra = getattr(physical, "extra_tags", None) or {}
    if isinstance(phys_album_extra, dict) and phys_album_extra:
        merged_alb_extra = dict(target.extra_tags or {})
        for k_loc, v_loc in phys_album_extra.items():
            if k_loc not in merged_alb_extra and v_loc:
                merged_alb_extra[k_loc] = list(v_loc) if isinstance(v_loc, (list, tuple)) else [str(v_loc)]
        target.extra_tags = merged_alb_extra
    return target



def _parse_discogs_code_or_url(raw_value: str) -> Optional[tuple[str, bool]]:
    """Erkennt Discogs-Codes mit oder ohne eckige Klammern (z. B. [r524030], [m63720], r524030, discogs:524030) sowie URLs."""
    raw = str(raw_value or "").strip()
    if not raw:
        return None

    # 1. Discogs URL: https://www.discogs.com/.../release/524030... oder .../master/63720...
    m_url = re.search(
        r"discogs\.com/(?:[^/]+/)?(release|master)/(\d{2,12})(?:-[^/?#]*)?",
        raw,
        re.IGNORECASE,
    )
    if m_url:
        return m_url.group(2), m_url.group(1).lower() == "master"

    # 2. Kopierter Discogs-Code mit eckigen Klammern (z. B. "[r524030]", "[m63720]", "[524030]")
    m_bracket = re.search(r"\[\s*([rm])?\s*(\d{2,12})\s*\]", raw, re.IGNORECASE)
    if m_bracket:
        prefix = (m_bracket.group(1) or "r").lower()
        return m_bracket.group(2), prefix == "m"

    # 3. Direkte Eingabe wie "r524030", "m63720", "discogs:524030", "discogs:r524030", "discogs:[r524030]"
    m_direct = re.match(
        r"^(?:discogs\s*:\s*)?(?:(release|master)\s*[:/]\s*)?\[?\s*([rm])?\s*(\d{2,12})\s*\]?$",
        raw,
        re.IGNORECASE,
    )
    if m_direct:
        has_explicit_prefix = bool(re.match(r"^discogs\s*:", raw, re.IGNORECASE))
        word_prefix = (m_direct.group(1) or "").lower()
        char_prefix = (m_direct.group(2) or "").lower()
        if has_explicit_prefix or word_prefix or char_prefix:
            return m_direct.group(3), (word_prefix == "master" or char_prefix == "m")

    return None


def _resolve_discogs_release_id(
    raw_id_or_code: str,
    discogs_token: str = "",
    on_log: Optional[Callable[[str], None]] = None,
) -> str:
    """Löst einen Discogs-Code (z. B. [r524030], [m63720], r524030, m63720) in eine numerische Release-ID auf."""
    trimmed = str(raw_id_or_code or "").strip()
    if not trimmed:
        return ""
    parsed = _parse_discogs_code_or_url(trimmed)
    if parsed:
        candidate_id, is_master = parsed
    else:
        cleaned = re.sub(r"^discogs\s*:\s*", "", trimmed, flags=re.IGNORECASE)
        is_master = bool(re.match(r"^\[?\s*m\d+", cleaned, re.IGNORECASE))
        candidate_id = re.sub(r"^[\[\srm]+|[\]\s]+$", "", cleaned, flags=re.IGNORECASE)

    if not candidate_id.isdigit():
        return ""

    if is_master:
        try:
            m_data = _discogs_get_json(f"masters/{candidate_id}", discogs_token=discogs_token)
            main_rel = str(m_data.get("main_release") or "").strip()
            if main_rel.isdigit():
                _log_step(
                    f"Discogs: Master-/Releasegroup-ID [m{candidate_id}] auf Haupt-Release [r{main_rel}] aufgelöst.",
                    on_log,
                )
                return main_rel
        except Exception:
            return ""
    return candidate_id


def parse_barcode_or_qr_payload(raw_value: str) -> dict[str, str]:
    """Analysiert einen gescannten Barcode (EAN-13, EAN-8, UPC-A, UPC-E), Discogs-Code ([r524030]) oder QR-Code-Inhalt."""
    raw = str(raw_value or "").strip()
    if not raw:
        return {"kind": "empty", "raw": "", "query": ""}

    # 1. MusicBrainz Release-URL oder UUID
    m_mb = re.search(r"musicbrainz\.org/release/([a-f0-9-]{36})", raw, re.IGNORECASE)
    if m_mb:
        mbid = m_mb.group(1).lower()
        return {"kind": "mbid", "raw": raw, "mbid": mbid, "query": f"reid:{mbid}"}
    if _UUID_RE.match(raw):
        mbid = raw.lower()
        return {"kind": "mbid", "raw": raw, "mbid": mbid, "query": f"reid:{mbid}"}

    # 2. Discogs Release-/Master-Code ([r524030], [m63720], r524030, discogs:524030 oder Discogs-URL)
    dg_parsed = _parse_discogs_code_or_url(raw)
    if dg_parsed:
        dg_num, is_master = dg_parsed
        dg_id = f"m{dg_num}" if is_master else dg_num
        return {"kind": "discogs_id", "raw": raw, "discogs_id": dg_id, "query": f"discogs:{dg_id}"}

    # 3. Amazon-Link oder ASIN
    m_amz = _AMAZON_ASIN_URL_RE.search(raw) or re.match(r"^asin:\s*([A-Z0-9]{10})$", raw, re.IGNORECASE)
    if m_amz:
        asin = m_amz.group(1).upper()
        return {"kind": "asin", "raw": raw, "asin": asin, "query": f"asin:{asin}"}

    # 4. GS1 Digital Link QR-Code (/01/<GTIN>) oder Barcode/EAN/UPC-Ziffernfolge (8-14 Ziffern)
    m_gs1 = re.search(r"/01/(\d{8,14})(?:/|\?|$)", raw)
    m_pref = re.match(
        r"^(?:barcode|ean(?:-?13|-?8)?|upc(?:-?a|-?e)?|gtin)\s*[:=#]?\s*([\d\s-]{8,20})$",
        raw,
        re.IGNORECASE,
    )
    digits = ""
    if m_gs1:
        digits = m_gs1.group(1)
    elif m_pref:
        digits = re.sub(r"[\s-]+", "", m_pref.group(1))
    elif re.fullmatch(r"[\d\s-]{8,18}", raw):
        digits = re.sub(r"[\s-]+", "", raw)

    if re.fullmatch(r"\d{8,14}", digits):
        variants = [digits]
        if len(digits) == 12:
            variants.append("0" + digits)
        elif len(digits) == 13 and digits.startswith("0"):
            variants.append(digits[1:])
        elif len(digits) == 14 and digits.startswith("0"):
            variants.append(digits[1:])
            if digits.startswith("00"):
                variants.append(digits[2:])
        mb_query = " OR ".join(f"barcode:{v}" for v in dict.fromkeys(variants))
        return {
            "kind": "barcode",
            "raw": raw,
            "barcode": digits,
            "variants": ",".join(dict.fromkeys(variants)),
            "query": mb_query,
        }

    return {"kind": "text", "raw": raw, "query": raw}


def search_musicbrainz_releases(
    query: str,
    limit: int = 10,
    on_log: Optional[Callable[[str], None]] = None,
) -> list[dict]:
    """Sucht passende Releases auf MusicBrainz nach Album, Künstler, Barcode/EAN oder Katalognummer (inkl. 503-Backoff)."""
    parsed = parse_barcode_or_qr_payload(query)
    if parsed["kind"] == "discogs_id":
        return []
    effective_query = parsed["query"] if parsed["kind"] in ("barcode", "mbid", "asin") else query

    def _query_ws2(q_str: str) -> list[dict]:
        data = _mb_ws2_get_json(
            f"release/?query={urllib.parse.quote(q_str)}&limit={limit}&fmt=json",
            on_log=on_log,
        )
        return data.get("releases") or data.get("release-list") or []

    rel_list = _query_ws2(effective_query)
    if not rel_list and parsed["kind"] == "barcode" and parsed.get("barcode"):
        rel_list = _query_ws2(parsed["barcode"])

    releases = []
    for rel in rel_list:
        if not isinstance(rel, dict):
            continue
        medium_list = [m for m in (rel.get("media") or rel.get("medium-list") or []) if isinstance(m, dict)]
        medium_count = int(rel.get("medium-count") or len(medium_list) or 1)
        track_count = int(
            rel.get("track-count")
            or rel.get("medium-track-count")
            or sum(int(m.get("track-count") or 0) for m in medium_list)
            or 0
        )
        label_list = [li for li in (rel.get("label-info") or rel.get("label-info-list") or []) if isinstance(li, dict)]
        first_label = next(
            (
                str(_as_dict(li.get("label")).get("name") or "").strip()
                for li in label_list
                if _as_dict(li.get("label")).get("name")
            ),
            "",
        )
        first_catno = next(
            (str(li.get("catalog-number") or "").strip() for li in label_list if li.get("catalog-number")),
            "",
        )
        raw_tags = [
            str(t.get("name") or "").strip()
            for t in (rel.get("tags") or [])
            if isinstance(t, dict) and t.get("name") and is_valid_music_genre_tag(str(t.get("name") or ""))
        ]
        cover_arch = _as_dict(rel.get("cover-art-archive"))
        has_cover = bool(cover_arch.get("front") or cover_arch.get("artwork"))
        releases.append(
            {
                "id": str(rel.get("id") or ""),
                "release_group_id": str(_as_dict(rel.get("release-group")).get("id") or ""),
                "title": str(rel.get("title") or "Unbekannt"),
                "artist": _format_artist_credit(rel.get("artist-credit", [])) or "Unbekannt",
                "date": str(rel.get("date") or ""),
                "country": str(rel.get("country") or ""),
                "barcode": str(rel.get("barcode") or ""),
                "catno": first_catno,
                "track_count": track_count,
                "medium_count": medium_count,
                "media": medium_list,
                "label": first_label,
                "genres": filter_subgenres(raw_tags, max_items=4),
                "has_cover": has_cover,
                "score": int(rel.get("score") or 0),
            }
        )
    return releases



def _select_medium(
    media: list[dict],
    disc_number: Optional[int] = None,
    match_disc_id: str = "",
    match_track_count: int = 0,
) -> dict:
    dict_media = [m for m in (media or []) if isinstance(m, dict)]
    if not dict_media:
        return {}

    if match_disc_id:
        for m in dict_media:
            for disc in m.get("discs") or []:
                if isinstance(disc, dict) and disc.get("id") == match_disc_id:
                    return m

    if disc_number is not None and disc_number >= 1:
        for m in dict_media:
            if int(m.get("position") or 0) == disc_number:
                return m
        if disc_number <= len(dict_media):
            return dict_media[disc_number - 1]

    if match_track_count > 0:
        for m in dict_media:
            count = int(m.get("track-count") or len(m.get("tracks") or []))
            if count == match_track_count:
                return m

    return dict_media[0]


def fetch_musicbrainz_release_details(
    release_id: str,
    disc_number: Optional[int] = None,
    match_disc_id: str = "",
    match_track_count: int = 0,
    enabled_cover_providers: Optional[list[str]] = None,
    on_log: Optional[Callable[[str], None]] = None,
    load_deep_relations: Optional[bool] = None,
) -> AlbumMetadata:
    """Lädt Release-, Track- & Genre-Tags von MusicBrainz (standardmäßig schnell & kompakt; tiefe Relationen optional)."""
    rel_quoted = urllib.parse.quote(release_id)
    want_deep = _get_configured_bool_setting("mb_load_deep_relations", False, explicit=load_deep_relations)
    compact_inc = "artists+recordings+labels+isrcs+release-groups+genres+tags+discids+url-rels"
    deep_inc = f"{compact_inc}+artist-rels+work-rels+recording-level-rels+work-level-rels"

    if want_deep:
        try:
            rel = _mb_ws2_get_json(
                f"release/{rel_quoted}?inc={deep_inc}&fmt=json",
                on_log=on_log,
                timeout=22,
                max_retries=2,
            )
        except Exception as full_exc:
            if isinstance(full_exc, urllib.error.HTTPError) and full_exc.code in (400, 404):
                raise
            _log_step(
                f"[MusicBrainz] Vollabfrage mit Detail-Relationen nicht rechtzeitig abgeschlossen ({full_exc}) "
                "– lade kompakte Release-Metadaten (Fallback)...",
                on_log,
            )
            rel = _mb_ws2_get_json(
                f"release/{rel_quoted}?inc={compact_inc}&fmt=json",
                on_log=on_log,
                timeout=18,
                max_retries=2,
            )
    else:
        rel = _mb_ws2_get_json(
            f"release/{rel_quoted}?inc={compact_inc}&fmt=json",
            on_log=on_log,
            timeout=18,
            max_retries=2,
        )
    _preseed_verify_cache_from_mb_release(rel)
    release_ac = rel.get("artist-credit", [])
    album_artist = _format_artist_credit(release_ac) or "Unbekannter Künstler"
    album_artists_list = _extract_artist_names(release_ac)
    album_artist_sort = _format_artist_sort_credit(release_ac)
    album_artist_id = _extract_artist_ids(release_ac)

    label_list = [li for li in (rel.get("label-info") or []) if isinstance(li, dict)]
    labels = [
        str(_as_dict(li.get("label")).get("name") or "").strip()
        for li in label_list
        if _as_dict(li.get("label")).get("name")
    ]
    catalog_numbers = [
        str(li.get("catalog-number") or "").strip()
        for li in label_list
        if li.get("catalog-number")
    ]

    rg = _as_dict(rel.get("release-group"))
    release_types = []
    if rg.get("primary-type"):
        release_types.append(str(rg["primary-type"]).lower())
    for st in rg.get("secondary-types") or []:
        if st:
            release_types.append(str(st).lower())

    text_rep = _as_dict(rel.get("text-representation"))
    release_date = str(rel.get("date") or "").strip()
    original_date = str(rg.get("first-release-date") or "").strip()

    media = [m for m in (rel.get("media") or []) if isinstance(m, dict)]
    total_discs = max(1, len(media))
    available_discs = [
        {
            "position": int(m.get("position") or idx + 1),
            "title": str(m.get("title") or ""),
            "format": str(m.get("format") or "CD"),
            "track_count": int(m.get("track-count") or len(m.get("tracks") or [])),
        }
        for idx, m in enumerate(media)
    ]

    load_all_discs = disc_number == 0
    selected_medium = _select_medium(
        media,
        disc_number=1 if load_all_discs else disc_number,
        match_disc_id=match_disc_id,
        match_track_count=match_track_count,
    )
    resolved_disc_num = int(selected_medium.get("position") or 1) if selected_medium else 1
    media_to_load = media if (load_all_discs and media) else ([selected_medium] if selected_medium else [])

    # Release-weite Beziehungs-Tags (Picard-konform: Producer, Engineer, Mixer, DJ-Mixer, Arranger, Remixer)
    rel_role_map = _collect_artist_relations(rel.get("relations") or [])
    album_extra_tags: dict[str, list[str]] = {}
    for role_key, tag_name in (
        ("producer", "PRODUCER"),
        ("executive producer", "PRODUCER"),
        ("engineer", "ENGINEER"),
        ("mix", "MIXER"),
        ("dj-mix", "DJMIXER"),
        ("mastering", "ENGINEER"),
        ("arranger", "ARRANGER"),
        ("remixer", "REMIXER"),
    ):
        if rel_role_map.get(role_key):
            for val in rel_role_map[role_key]:
                bucket = album_extra_tags.setdefault(tag_name, [])
                if val not in bucket:
                    bucket.append(val)

    tracks: list[TrackMetadata] = []
    medium_recordings: list[dict] = []
    for med_idx, med_obj in enumerate(media_to_load):
        med_dict = _as_dict(med_obj)
        med_pos = int(med_dict.get("position") or (med_idx + 1 if load_all_discs else resolved_disc_num) or 1)
        med_sub = str(med_dict.get("title") or "").strip()
        for idx, trk in enumerate(med_dict.get("tracks") or []):
            if not isinstance(trk, dict):
                continue
            rec = _as_dict(trk.get("recording"))
            medium_recordings.append(rec)
            length_ms = int(trk.get("length") or rec.get("length") or 0)
            trk_ac = trk.get("artist-credit") or rec.get("artist-credit") or []
            track_artist = _format_artist_credit(trk_ac) or album_artist
            track_artists_list = _extract_artist_names(trk_ac) or list(album_artists_list)
            track_artist_sort = _format_artist_sort_credit(trk_ac) or album_artist_sort
            track_artist_id = _extract_artist_ids(trk_ac) or album_artist_id
            isrc_list = [str(code).strip() for code in (rec.get("isrcs") or []) if code]

            rec_rels = _collect_artist_relations(rec.get("relations") or [])
            composer_ids = _collect_artist_role_ids(rec.get("relations") or [], ("composer",))
            work_rels: dict[str, list[str]] = {}
            work_titles: list[str] = []
            work_ids: list[str] = []
            work_langs: list[str] = []
            for r_item in rec.get("relations") or []:
                if isinstance(r_item, dict) and r_item.get("target-type") == "work" and isinstance(r_item.get("work"), dict):
                    wk = r_item["work"]
                    if wk.get("id") and wk["id"] not in work_ids:
                        work_ids.append(wk["id"])
                    if wk.get("title") and str(wk["title"]).strip() not in work_titles:
                        work_titles.append(str(wk["title"]).strip())
                    for lang in wk.get("languages") or ([wk.get("language")] if wk.get("language") else []):
                        if lang and lang not in work_langs:
                            work_langs.append(lang)
                    for cid in _collect_artist_role_ids(wk.get("relations") or [], ("composer",)):
                        if cid not in composer_ids:
                            composer_ids.append(cid)
                    wk_roles = _collect_artist_relations(wk.get("relations") or [])
                    for k, vals in wk_roles.items():
                        work_rels.setdefault(k, []).extend(v for v in vals if v not in work_rels.get(k, []))

            composers = work_rels.get("composer", []) + rec_rels.get("composer", [])
            lyricists = work_rels.get("lyricist", []) + rec_rels.get("lyricist", [])
            writers = work_rels.get("writer", []) + rec_rels.get("writer", [])
            producers = rec_rels.get("producer", []) or album_extra_tags.get("PRODUCER", [])

            trk_extra_tags: dict[str, list[str]] = {}
            for role_key, tag_name in (
                ("arranger", "ARRANGER"),
                ("engineer", "ENGINEER"),
                ("mix", "MIXER"),
                ("dj-mix", "DJMIXER"),
                ("remixer", "REMIXER"),
                ("performer", "PERFORMER"),
                ("instrument", "PERFORMER"),
                ("vocal", "PERFORMER"),
            ):
                combined = (rec_rels.get(role_key) or []) + (work_rels.get(role_key) or [])
                if combined:
                    bucket = trk_extra_tags.setdefault(tag_name, [])
                    for item in combined:
                        if item not in bucket:
                            bucket.append(item)

            orchestras = (
                rec_rels.get("performing orchestra", [])
                + rec_rels.get("orchestra", [])
                + work_rels.get("orchestra", [])
                + rel_role_map.get("performing orchestra", [])
                + rel_role_map.get("orchestra", [])
                + [
                    p
                    for p in (rec_rels.get("performer", []) + work_rels.get("performer", []))
                    if any(
                        kw in p.lower()
                        for kw in ("orchestra", "orchester", "philharmon", "symphon", "sinfon", "ensemble", "quartet", "kammer")
                    )
                ]
            )
            conductors = (
                rec_rels.get("conductor", [])
                + work_rels.get("conductor", [])
                + (rel_role_map.get("conductor") or [])
            )

            track_genre_str = _extract_recording_genres(rec)
            tracks.append(
                TrackMetadata(
                    track_number=int(trk.get("position") or idx + 1),
                    title=trk.get("title") or rec.get("title") or f"Titel {idx + 1}",
                    artist=track_artist,
                    artists=track_artists_list,
                    artist_sort=track_artist_sort,
                    duration_seconds=round(length_ms / 1000) if length_ms else 0,
                    genre=track_genre_str,
                    isrc="; ".join(dict.fromkeys(isrc_list)),
                    isrcs=list(dict.fromkeys(isrc_list)),
                    composer="; ".join(dict.fromkeys(composers)),
                    orchestra="; ".join(dict.fromkeys(orchestras)),
                    conductor="; ".join(dict.fromkeys(conductors)),
                    lyricist="; ".join(dict.fromkeys(lyricists)),
                    writer="; ".join(dict.fromkeys(writers)),
                    producer="; ".join(dict.fromkeys(producers)),
                    work="; ".join(work_titles),
                    work_language="; ".join(dict.fromkeys(work_langs)),
                    musicbrainz_recording_id=str(rec.get("id") or ""),
                    musicbrainz_track_id=str(trk.get("id") or ""),
                    musicbrainz_artist_id=track_artist_id,
                    musicbrainz_work_id="; ".join(work_ids),
                    musicbrainz_composer_id="; ".join(composer_ids),
                    metadata_source="MusicBrainz",
                    extra_tags=trk_extra_tags,
                    disc_number=med_pos,
                    disc_subtitle=med_sub,
                )
            )

    mb_genres = _extract_musicbrainz_genres(rel, extra_recordings=medium_recordings)
    wikidata_genres = fetch_wikidata_genres(
        release_id=release_id,
        release_group_id=str(rg.get("id") or "").strip(),
        artist_id=album_artist_id,
        artist_name=album_artist,
        album_title=str(rel.get("title") or ""),
    )
    genre_str = merge_genre_strings(mb_genres, wikidata_genres, max_items=7)

    asin_str = str(rel.get("asin") or "").strip()
    if not asin_str:
        for rel_item in rel.get("relations") or []:
            if isinstance(rel_item, dict) and isinstance(rel_item.get("url"), dict):
                res_url = str(rel_item["url"].get("resource") or "")
                m_asin = _AMAZON_ASIN_URL_RE.search(res_url)
                if m_asin:
                    asin_str = m_asin.group(1).upper()
                    break

    album_composers = list(
        dict.fromkeys(
            (rel_role_map.get("composer") or [])
            + [c.strip() for t in tracks for c in (t.composer or "").split(";") if c.strip()]
        )
    )
    album_orchestras = list(
        dict.fromkeys(
            (rel_role_map.get("performing orchestra") or [])
            + (rel_role_map.get("orchestra") or [])
            + [o.strip() for t in tracks for o in (t.orchestra or "").split(";") if o.strip()]
        )
    )
    album_conductors = list(
        dict.fromkeys(
            (rel_role_map.get("conductor") or [])
            + [c.strip() for t in tracks for c in (t.conductor or "").split(";") if c.strip()]
        )
    )

    album = AlbumMetadata(
        title=rel.get("title", "Unbekanntes Album"),
        artist=album_artist,
        album_artist=album_artist,
        album_artists=album_artists_list,
        album_artist_sort=album_artist_sort,
        composer="; ".join(album_composers[:4]),
        orchestra="; ".join(album_orchestras[:3]),
        conductor="; ".join(album_conductors[:3]),
        year=release_date[:4],
        release_date=release_date,
        original_date=original_date,
        genre=genre_str,
        label="; ".join(dict.fromkeys(labels)),
        catalog_number="; ".join(dict.fromkeys(catalog_numbers)),
        barcode=str(rel.get("barcode") or "").strip(),
        asin=asin_str,
        country=_extract_release_countries(rel),
        status=str(rel.get("status") or "").strip().lower(),
        release_type="; ".join(dict.fromkeys(release_types)),
        media_format=str(selected_medium.get("format") or "CD").strip() if selected_medium else "CD",
        disc_subtitle=str(selected_medium.get("title") or "").strip() if selected_medium else "",
        script=str(text_rep.get("script") or "").strip(),
        language=str(text_rep.get("language") or "").strip(),
        disc_number=resolved_disc_num,
        total_discs=total_discs,
        musicbrainz_release_id=release_id,
        musicbrainz_release_group_id=str(rg.get("id") or "").strip(),
        musicbrainz_album_artist_id=album_artist_id,
        metadata_source="MusicBrainz",
        available_discs=available_discs,
        extra_tags=album_extra_tags,
        tracks=tracks,
    )

    active_cov = set(
        normalize_cover_providers(
            DEFAULT_COVER_PROVIDERS if enabled_cover_providers is None else enabled_cover_providers
        )
    )
    if "musicbrainz_caa" in active_cov:
        cover_bytes, cover_mime = download_cover_art(release_id)
        if cover_bytes:
            album.cover_art_bytes = cover_bytes
            album.cover_art_mime = cover_mime
            album.cover_art_source = "Cover Art Archive (MusicBrainz)"
    if not album.cover_art_bytes and "musicbrainz_rg_caa" in active_cov and album.musicbrainz_release_group_id:
        rg_imgs = _download_caa_release_group_images(album.musicbrainz_release_group_id, limit=1)
        if rg_imgs:
            album.cover_art_bytes = rg_imgs[0][0]
            album.cover_art_mime = rg_imgs[0][1]
            album.cover_art_source = "Cover Art Archive (Release-Group)"
    if not album.cover_art_bytes and "amazon" in active_cov and asin_str:
        amz_bytes, amz_mime, _ = download_amazon_cover(asin=asin_str)
        if amz_bytes:
            album.cover_art_bytes = amz_bytes
            album.cover_art_mime = amz_mime
            album.cover_art_source = f"Amazon Cover (ASIN {asin_str})"

    return album


def _score_release_duration_match(
    rel: dict,
    target_durations: list[int],
    target_track_count: int = 0,
) -> float:
    """Bewertet ein MusicBrainz-Release anhand der Übereinstimmung der Track-Längen (Dauer-Vektor-Distanz)."""
    if not isinstance(rel, dict):
        return -1000.0
    media = rel.get("media") or rel.get("medium-list") or []
    eff_count = target_track_count or len(target_durations)
    best_score = -1000.0

    for m in media:
        if not isinstance(m, dict):
            continue
        tracks = m.get("tracks") or m.get("track-list") or []
        m_count = int(m.get("track-count") or len(tracks) or 0)
        if eff_count > 0 and m_count != eff_count:
            score = -50.0 * abs(m_count - eff_count)
            if score > best_score:
                best_score = score
            continue

        score = 100.0
        if target_durations and tracks and len(tracks) == len(target_durations):
            diffs: list[float] = []
            for idx, target_sec in enumerate(target_durations):
                t_obj = tracks[idx]
                if not isinstance(t_obj, dict):
                    continue
                rec = _as_dict(t_obj.get("recording"))
                length_ms = int(t_obj.get("length") or rec.get("length") or 0)
                if length_ms > 0 and target_sec > 0:
                    cand_sec = length_ms / 1000.0
                    diffs.append(abs(cand_sec - float(target_sec)))
            if diffs:
                avg_diff = sum(diffs) / len(diffs)
                max_diff = max(diffs)
                # Sehr hohe Punktzahl, wenn alle Tracks innerhalb von ±3s liegen
                score += max(-60.0, 60.0 - avg_diff * 8.0 - max(0.0, max_diff - 4.0) * 3.0)
        elif eff_count > 0 and m_count == eff_count:
            score += 25.0

        fmt = str(m.get("format") or "").upper()
        if "CD" in fmt:
            score += 5.0

        if score > best_score:
            best_score = score

    return best_score


def lookup_musicbrainz_by_discid(
    disc_id: str,
    toc_string: str = "",
    track_count: int = 0,
    track_durations: Optional[list[int]] = None,
    on_log: Optional[Callable[[str], None]] = None,
) -> Optional[AlbumMetadata]:
    """Erkennt eine Audio-CD oder virtuelle Datei-TOC über exakte DiscID sowie MusicBrainz-Fuzzy-TOC über alle Medienformate."""
    if not disc_id and not toc_string:
        return None

    releases: list[dict] = []
    durations = track_durations or []

    # 1. Versuch: Exakte DiscID + TOC
    if disc_id and disc_id != "-":
        try:
            target = urllib.parse.quote(disc_id)
            query = (
                f"?toc={urllib.parse.quote(toc_string)}&cdstubs=no&fmt=json"
                if toc_string
                else "?fmt=json"
            )
            data = _mb_ws2_get_json(f"discid/{target}{query}", on_log=on_log)
            releases = data.get("releases") or data.get("release-list") or []
        except urllib.error.HTTPError as http_exc:
            if http_exc.code != 404:
                _log_step(f"MusicBrainz DiscID-Hinweis: HTTP {http_exc.code}", on_log)
        except Exception:
            pass

    # 2. Versuch (entscheidend für virtuelle Datei-TOC!): Reine Fuzzy-TOC-Suche über alle Medienformate (/ws/2/discid/-?toc=...)
    if not releases and toc_string:
        for extra_params in ("&media-format=all&cdstubs=no", "&media-format=all"):
            try:
                _log_step(
                    f"[MusicBrainz Fuzzy-TOC] Suche nach Sektor-Offsets ({track_count or '?'} Tracks, alle Medien)...",
                    on_log,
                )
                data = _mb_ws2_get_json(
                    f"discid/-?toc={urllib.parse.quote(toc_string)}{extra_params}&fmt=json",
                    on_log=on_log,
                )
                releases = data.get("releases") or data.get("release-list") or []
                if releases:
                    break
                # Falls ein CD-Stub gefunden wurde, dessen Künstler & Titel (+ exakte Trackanzahl) als Hinweis nutzen
                if isinstance(data.get("cdstub"), dict):
                    stub = data["cdstub"]
                    stub_artist = str(stub.get("artist") or "").strip()
                    stub_title = str(stub.get("title") or "").strip()
                    if stub_artist and stub_title:
                        _log_step(
                            f"[MusicBrainz CD-Stub] TOC-Stub erkannt: {stub_artist} – {stub_title}. Suche zugehöriges Release ({track_count or '?'} Tracks)...",
                            on_log,
                        )
                        stub_q = f'artist:"{stub_artist}" AND release:"{stub_title}"'
                        if track_count > 0:
                            stub_q += f" AND tracks:{track_count}"
                        stub_hits = search_musicbrainz_releases(
                            stub_q,
                            limit=5,
                            on_log=on_log,
                        )
                        if stub_hits:
                            releases = stub_hits
                            break
            except urllib.error.HTTPError as http_exc:
                if http_exc.code != 404:
                    _log_step(f"MusicBrainz Fuzzy-TOC HTTP {http_exc.code}", on_log)
            except Exception:
                pass

    if not releases:
        return None

    # Kandidaten nach Dauer-Vektor-Ähnlichkeit und Trackanzahl sortieren
    scored_releases = sorted(
        releases,
        key=lambda r: _score_release_duration_match(r, durations, track_count),
        reverse=True,
    )

    best_rel = scored_releases[0]
    if track_count > 0 and _score_release_duration_match(best_rel, durations, track_count) < 0:
        _log_step(
            f"[MusicBrainz TOC] Verwerfe Release mit abweichender Trackanzahl (erwartet: {track_count} Tracks).",
            on_log,
        )
        return None

    release_id = best_rel.get("id")
    if not release_id:
        return None

    album = fetch_musicbrainz_release_details(
        release_id,
        match_disc_id=disc_id,
        match_track_count=track_count,
    )
    if track_count > 0 and len(album.tracks) != track_count:
        _log_step(
            f"[MusicBrainz TOC] Verwerfe Release „{album.title}“ ({len(album.tracks)} Tracks statt {track_count} Tracks).",
            on_log,
        )
        return None
    album.metadata_source = "MusicBrainz DiscID/TOC"
    return album



def _gnudb_request(cmd: str) -> list[str]:
    encoded_cmd = urllib.parse.quote_plus(cmd)
    last_error: Optional[Exception] = None
    for endpoint in GNUDB_ENDPOINTS:
        url = f"{endpoint}?cmd={encoded_cmd}&hello={GNUDB_HELLO}&proto=6"
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT_HEADER})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.read().decode("utf-8", errors="replace").splitlines()
        except Exception as exc:
            last_error = exc
    if last_error:
        raise last_error
    return []


def lookup_cddb_metadata(cddb_id: str, track_offsets: list[int], total_seconds: int) -> Optional[AlbumMetadata]:
    """Fragt CDDB/GnuDB-Datenbanken per DiscID + Track-Offsets ab."""
    if not cddb_id or not track_offsets:
        return None

    offsets_str = " ".join(str(o) for o in track_offsets)
    query_cmd = f"cddb query {cddb_id} {len(track_offsets)} {offsets_str} {total_seconds}"
    lines = _gnudb_request(query_cmd)
    if not lines:
        return None

    status_line = lines[0].strip()
    code = status_line[:3]
    category = ""
    matched_id = cddb_id

    if code == "200":
        parts = status_line.split(maxsplit=3)
        if len(parts) >= 3:
            category, matched_id = parts[1], parts[2]
    elif code in ("210", "211") and len(lines) > 1:
        for candidate in lines[1:]:
            if candidate == ".":
                break
            parts = candidate.strip().split(maxsplit=2)
            if len(parts) >= 2:
                category, matched_id = parts[0], parts[1]
                break
    else:
        return None

    if not category:
        return None

    read_lines = _gnudb_request(f"cddb read {category} {matched_id}")
    if not read_lines or not read_lines[0].startswith("210"):
        return None

    fields: dict[str, str] = {}
    cover_url_hint = ""
    for line in read_lines[1:]:
        if line == ".":
            break
        if line.startswith("# Cover:"):
            cover_url_hint = line.partition(":")[2].strip()
            continue
        if line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        fields[k] = fields.get(k, "") + v

    dtitle = fields.get("DTITLE", "Unbekannt / Unbekannt")
    artist, _, album_title = dtitle.partition(" / ")
    artist_clean = normalize_multi_artist(artist.strip()) or "Unbekannter Künstler"
    raw_title_clean = (album_title or dtitle).strip() or "Unbekanntes Album"
    title_clean, disc_num, total_discs = _extract_disc_info_from_title(raw_title_clean)

    raw_genre = fields.get("DGENRE", "").strip()
    genre_clean = _parse_cddb_genres(raw_genre)
    if not genre_clean and category and category.lower() not in ("misc", "data"):
        genre_clean = format_multi_genre([category])

    tracks = []
    for idx in range(len(track_offsets)):
        raw_t = fields.get(f"TTITLE{idx}", f"Titel {idx + 1:02d}").strip()
        # Bei Compilations steht oft "Track-Interpret / Track-Titel" in TTITLE
        if " / " in raw_t and artist_clean.lower() in ("various", "various artists"):
            t_artist, _, t_title = raw_t.partition(" / ")
            tracks.append(
                TrackMetadata(
                    track_number=idx + 1,
                    title=t_title.strip(),
                    artist=normalize_multi_artist(t_artist.strip()),
                    metadata_source="CDDB",
                )
            )
        else:
            tracks.append(
                TrackMetadata(
                    track_number=idx + 1,
                    title=raw_t,
                    artist=artist_clean,
                    metadata_source="CDDB",
                )
            )

    album = AlbumMetadata(
        title=title_clean,
        artist=artist_clean,
        album_artist=artist_clean,
        year=fields.get("DYEAR", "").strip(),
        genre=genre_clean,
        disc_number=disc_num,
        total_discs=total_discs,
        cddb_id=matched_id,
        metadata_source=f"CDDB/GnuDB ({category}/{matched_id})",
        tracks=tracks,
    )

    if "coverartarchive.org/release/" in cover_url_hint:
        mbid = cover_url_hint.split("coverartarchive.org/release/")[-1].split("/")[0]
        if mbid:
            album.musicbrainz_release_id = mbid
            cover_bytes, cover_mime = download_cover_art(mbid)
            if cover_bytes:
                album.cover_art_bytes = cover_bytes
                album.cover_art_mime = cover_mime
                album.cover_art_source = "Cover Art Archive (via GnuDB)"

    return album


def _discogs_clean_name(name: str) -> str:
    return _DISCOGS_ARTIST_SUFFIX_RE.sub("", str(name or "").strip()).strip()


def _discogs_format_artists(artists: list[dict]) -> str:
    parts: list[str] = []
    for idx, art in enumerate(artists or []):
        if not isinstance(art, dict):
            continue
        aname = _discogs_clean_name(art.get("anv") or art.get("name") or "")
        if not aname:
            continue
        join = str(art.get("join") or "").strip()
        if idx > 0 and not parts[-1].endswith((" ", "/", "&", ",", ";")):
            parts.append(" ")
        parts.append(aname)
        if join and idx < len(artists) - 1:
            parts.append(f" {join} " if join not in (",", "/", ";") else f"{join} ")
    return normalize_multi_artist("".join(parts).strip())


def _discogs_parse_duration(raw: str) -> int:
    text = str(raw or "").strip()
    if not text or ":" not in text:
        return 0
    try:
        segs = [int(p) for p in text.split(":")]
        if len(segs) == 2:
            return max(0, segs[0] * 60 + segs[1])
        if len(segs) == 3:
            return max(0, segs[0] * 3600 + segs[1] * 60 + segs[2])
    except ValueError:
        return 0
    return 0


def _discogs_parse_position(pos: str, fallback_idx: int) -> tuple[int, int]:
    clean = str(pos or "").strip()
    multi = re.match(r"^(?:CD|DISC)?\s*(\d{1,2})\s*[-.:]\s*(\d{1,3})$", clean, re.IGNORECASE)
    if multi:
        return max(1, int(multi.group(1))), max(1, int(multi.group(2)))
    digits = re.match(r"^(\d{1,3})$", clean)
    if digits:
        return 1, max(1, int(digits.group(1)))
    return 1, fallback_idx


def _discogs_get_json(
    path: str,
    discogs_token: str = "",
    on_log: Optional[Callable[[str], None]] = None,
    use_cache: bool = True,
) -> dict:
    clean_path = path.lstrip("/")
    url = f"{DISCOGS_API_BASE}/{clean_path}"
    cache_key = f"discogs:{url}"
    if use_cache:
        cached = _cache_get_json(cache_key)
        if isinstance(cached, dict):
            return cached
    headers = {
        "User-Agent": f"{USER_AGENT_APP}/{USER_AGENT_VERSION} +{USER_AGENT_CONTACT}",
        "Accept": "application/json",
    }
    token = _get_configured_discogs_token(discogs_token)
    if token:
        headers["Authorization"] = f"Discogs token={token}"
    req = urllib.request.Request(url, headers=headers)
    raw = _urlopen_with_backoff(req, timeout=16, max_retries=2, on_log=on_log, label="Discogs")
    parsed = json.loads(raw.decode("utf-8", errors="replace"))
    if use_cache and isinstance(parsed, dict):
        ttl = 86400 * 7 if clean_path.startswith("database/search") else 86400 * 30
        _cache_set_json(cache_key, parsed, ttl_sec=ttl)
    return parsed



def download_image_url(url: str, timeout: int = 12) -> tuple[Optional[bytes], str]:
    if not url:
        return None, "image/jpeg"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": f"{USER_AGENT_APP}/{USER_AGENT_VERSION} +{USER_AGENT_CONTACT}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            content_type = resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
            return resp.read(), content_type
    except Exception:
        return None, "image/jpeg"


def matches_source_track_count_rule(
    candidate_track_count: int,
    candidate_medium_count: int,
    source_track_count: int,
) -> bool:
    """Regel für Albenliste: Trackanzahl darf nur >= Quelle sein; > Quelle nur bei Multi-CDs."""
    if source_track_count <= 0:
        return True
    tc = int(candidate_track_count or 0)
    mc = max(1, int(candidate_medium_count or 1))
    if tc <= 0:
        return False
    if tc < source_track_count:
        return False
    if tc == source_track_count:
        return True
    return mc > 1


def _extract_discogs_summary_from_release(rel_data: dict, fallback_id: str = "") -> dict:
    artist_clean = _discogs_format_artists(rel_data.get("artists") or []) or "Unbekannter Künstler"
    title_clean = str(rel_data.get("title") or "Unbekanntes Album")
    labels = [
        _discogs_clean_name(str(li.get("name") or ""))
        for li in (rel_data.get("labels") or [])
        if isinstance(li, dict) and li.get("name")
    ]
    catnos = [
        str(li.get("catno") or "").strip()
        for li in (rel_data.get("labels") or [])
        if isinstance(li, dict) and li.get("catno") and str(li.get("catno")).lower() != "none"
    ]
    barcodes = [
        str(ident.get("value") or "").strip()
        for ident in (rel_data.get("identifiers") or [])
        if isinstance(ident, dict) and str(ident.get("type") or "").lower() == "barcode" and ident.get("value")
    ]
    images = [im for im in (rel_data.get("images") or []) if isinstance(im, dict)]
    cover_url = str(images[0].get("uri") or images[0].get("resource_url") or "") if images else ""
    tracklist = [t for t in (rel_data.get("tracklist") or []) if isinstance(t, dict)]
    track_rows = [t for t in tracklist if t.get("type_", "track") == "track"]
    track_cnt = len(track_rows)

    format_qty_sum = 0
    for fmt in (rel_data.get("formats") or []):
        if isinstance(fmt, dict):
            raw_qty = str(fmt.get("qty") or "1").strip()
            format_qty_sum += int(raw_qty) if raw_qty.isdigit() and int(raw_qty) > 0 else 1

    disc_nums: set[int] = set()
    for t in track_rows:
        pos = str(t.get("position") or "").strip()
        m_pos = re.match(r"^(?:CD|DISC)?\s*(\d{1,2})\s*[-.:]\s*\d+", pos, re.IGNORECASE)
        if m_pos:
            disc_nums.add(int(m_pos.group(1)))

    heading_discs = sum(
        1
        for t in tracklist
        if t.get("type_") == "heading" and re.search(r"\b(?:cd|disc|disk)\s*\d+", str(t.get("title") or ""), re.IGNORECASE)
    )
    medium_cnt = max(1, format_qty_sum, len(disc_nums), heading_discs)

    return {
        "id": str(rel_data.get("id") or fallback_id),
        "source": "discogs",
        "title": title_clean,
        "artist": artist_clean,
        "date": str(rel_data.get("year") or rel_data.get("released") or ""),
        "country": str(rel_data.get("country") or ""),
        "barcode": barcodes[0] if barcodes else "",
        "label": labels[0] if labels else "",
        "catno": catnos[0] if catnos else "",
        "track_count": track_cnt,
        "medium_count": medium_cnt,
        "genres": list(rel_data.get("genres") or []) + list(rel_data.get("styles") or []),
        "cover_url": cover_url,
    }


def search_discogs_releases(
    query: str,
    limit: int = 8,
    discogs_token: str = "",
    on_log: Optional[Callable[[str], None]] = None,
    expected_track_count: int = 0,
) -> list[dict]:
    """Sucht passende CD-Releases auf Discogs (inkl. direkter [r524030] / [m63720] Code-Abfrage ohne Token)."""
    clean = query.strip()
    if not clean:
        return []
    token = _get_configured_discogs_token(discogs_token)
    parsed_code = parse_barcode_or_qr_payload(clean)

    # Direkter Discogs Release- oder Master-Code (z. B. [r524030] oder [m63720])
    if parsed_code["kind"] == "discogs_id" and parsed_code.get("discogs_id"):
        raw_dg_id = parsed_code["discogs_id"]
        _log_step(f"Discogs: Direkter Code „{clean}“ erkannt – rufe Release-Details ab...", on_log)
        resolved_id = _resolve_discogs_release_id(raw_dg_id, discogs_token=token, on_log=on_log)
        if resolved_id:
            rel_data: dict = {}
            try:
                rel_data = _discogs_get_json(f"releases/{resolved_id}", discogs_token=token)
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    alt_master = _resolve_discogs_release_id(f"m{resolved_id}", discogs_token=token, on_log=on_log)
                    if alt_master and alt_master != resolved_id:
                        resolved_id = alt_master
                        rel_data = _discogs_get_json(f"releases/{resolved_id}", discogs_token=token)
            except Exception as exc:
                _log_step(f"Discogs: Fehler beim Abrufen von Release #{resolved_id} ({exc}).", on_log)
            if rel_data and isinstance(rel_data, dict) and rel_data.get("id"):
                return [_extract_discogs_summary_from_release(rel_data, fallback_id=str(resolved_id))]
        return []

    def _enrich_discogs_hits(raw_list: list[dict]) -> list[dict]:
        if expected_track_count <= 0 or not raw_list:
            return raw_list

        def _fetch_one(entry: dict) -> Optional[dict]:
            cid = str(entry.get("id") or "").strip()
            if not cid:
                return None
            try:
                rel_data = _discogs_get_json(f"releases/{cid}", discogs_token=token)
                if isinstance(rel_data, dict) and rel_data.get("id"):
                    return _extract_discogs_summary_from_release(rel_data, fallback_id=cid)
            except Exception:
                return None
            return None

        top_items = raw_list[:6]
        enriched: list[dict] = []
        with ThreadPoolExecutor(max_workers=3) as pool:
            for res_item in pool.map(_fetch_one, top_items):
                if res_item:
                    enriched.append(res_item)
        return enriched

    encoded = urllib.parse.quote(clean)
    try:
        results: list[dict] = []
        if parsed_code["kind"] == "barcode" and parsed_code.get("barcode"):
            bc = parsed_code["barcode"]
            _log_step(
                f"Discogs: Barcode-Anfrage an api.discogs.com/database/search?barcode={bc} "
                f"({'mit Token' if token else 'ohne Token'})",
                on_log,
            )
            for variant in parsed_code.get("variants", bc).split(","):
                v_enc = urllib.parse.quote(variant.strip())
                data = _discogs_get_json(
                    f"database/search?barcode={v_enc}&type=release&per_page={limit}",
                    discogs_token=token,
                )
                results = data.get("results") or []
                if results:
                    break
            if not results:
                data = _discogs_get_json(
                    f"database/search?q={urllib.parse.quote(bc)}&type=release&per_page={limit}",
                    discogs_token=token,
                )
                results = data.get("results") or []
        else:
            _log_step(
                f"Discogs: Anfrage an api.discogs.com/database/search?q={clean} "
                f"({'mit Token' if token else 'ohne Token'})",
                on_log,
            )
            data = _discogs_get_json(
                f"database/search?q={encoded}&type=release&format=CD&per_page={limit}",
                discogs_token=token,
            )
            results = data.get("results") or []
            if not results:
                data = _discogs_get_json(
                    f"database/search?q={encoded}&type=release&per_page={limit}",
                    discogs_token=token,
                )
                results = data.get("results") or []

        parsed: list[dict] = []
        for item in results:
            raw_title = str(item.get("title") or "Unbekannt")
            artist_part, sep, album_part = raw_title.partition(" - ")
            artist_clean = normalize_multi_artist(_discogs_clean_name(artist_part)) if sep else "Unbekannt"
            title_clean = album_part.strip() if sep else raw_title
            labels = [str(l).strip() for l in (item.get("label") or []) if l]
            barcodes = [str(b).strip() for b in (item.get("barcode") or []) if b]
            parsed.append(
                {
                    "id": str(item.get("id") or ""),
                    "source": "discogs",
                    "title": title_clean,
                    "artist": artist_clean,
                    "date": str(item.get("year") or ""),
                    "country": str(item.get("country") or ""),
                    "barcode": barcodes[0] if barcodes else "",
                    "label": labels[0] if labels else "",
                    "catno": str(item.get("catno") or ""),
                    "track_count": 0,
                    "medium_count": 1,
                    "genres": list(item.get("genre") or []) + list(item.get("style") or []),
                    "cover_url": str(item.get("cover_image") or item.get("thumb") or ""),
                }
            )
        _log_step(f"Discogs: {len(parsed)} Treffer über /database/search erhalten.", on_log)
        return _enrich_discogs_hits(parsed)
    except urllib.error.HTTPError as http_exc:
        _log_step(
            f"Discogs: /database/search antwortete mit HTTP {http_exc.code} "
            f"({'Token prüfen' if token else 'Kein Discogs-Token in Einstellungen hinterlegt – nutze URL-Fallback'}).",
            on_log,
        )
    except Exception as exc:
        _log_step(f"Discogs: Suchfehler ({exc}) – prüfe verknüpfte Discogs-IDs.", on_log)

    # Fallback ohne Token: Verknüpfte Discogs-Release-IDs über MusicBrainz url-rels ermitteln
    fallback_items: list[dict] = []
    try:
        mb_list = search_musicbrainz_releases(clean, limit=3)
        for mb_rel in mb_list:
            mbid = mb_rel.get("id")
            if not mbid:
                continue
            rel_data = _mb_ws2_get_json(f"release/{urllib.parse.quote(mbid)}?inc=url-rels&fmt=json")
            for rel_item in rel_data.get("relations") or []:
                res_url = str((rel_item.get("url") or {}).get("resource") or "")
                m_dg = re.search(r"discogs\.com/(?:[^/]+/)?release/(\d+)", res_url, re.IGNORECASE)
                if m_dg:
                    dg_id = m_dg.group(1)
                    _log_step(f"Discogs: Verknüpfte Discogs-Release-ID #{dg_id} gefunden.", on_log)
                    fallback_items.append(
                        {
                            "id": dg_id,
                            "source": "discogs",
                            "title": mb_rel.get("title", "Unbekannt"),
                            "artist": mb_rel.get("artist", "Unbekannt"),
                            "date": mb_rel.get("date", ""),
                            "country": mb_rel.get("country", ""),
                            "barcode": "",
                            "label": mb_rel.get("label", ""),
                            "catno": "",
                            "track_count": 0,
                            "medium_count": 1,
                            "genres": [],
                            "cover_url": "",
                        }
                    )
                    break
            if len(fallback_items) >= 4:
                break
    except Exception:
        pass
    return _enrich_discogs_hits(fallback_items)


def fetch_discogs_release_details(
    discogs_id: int | str,
    disc_number: Optional[int] = None,
    match_track_count: int = 0,
    enabled_cover_providers: Optional[list[str]] = None,
    on_log: Optional[Callable[[str], None]] = None,
) -> AlbumMetadata:
    """Lädt vollständige Album- & Track-Metadaten inklusive Multi-CD, Genres & Cover von Discogs."""
    clean_id = _resolve_discogs_release_id(str(discogs_id)) or str(discogs_id).strip()
    try:
        rel = _discogs_get_json(f"releases/{urllib.parse.quote(str(clean_id))}", on_log=on_log)
    except urllib.error.HTTPError as exc:
        if exc.code == 404 and str(clean_id).isdigit():
            alt_master = _resolve_discogs_release_id(f"m{clean_id}")
            if alt_master and alt_master != clean_id:
                clean_id = alt_master
                rel = _discogs_get_json(f"releases/{urllib.parse.quote(str(clean_id))}", on_log=on_log)
            else:
                raise
        else:
            raise
    discogs_id = clean_id
    album_artist = _discogs_format_artists(rel.get("artists") or []) or "Unbekannter Künstler"
    album_artist_sort = normalize_multi_artist(_discogs_clean_name(rel.get("artists_sort") or ""))

    labels = list(
        dict.fromkeys(
            _discogs_clean_name(li.get("name", ""))
            for li in (rel.get("labels") or [])
            if isinstance(li, dict) and li.get("name")
        )
    )
    catnos = list(
        dict.fromkeys(
            str(li.get("catno") or "").strip()
            for li in (rel.get("labels") or [])
            if isinstance(li, dict) and li.get("catno") and str(li.get("catno")).lower() != "none"
        )
    )
    barcodes = [
        str(ident.get("value") or "").strip()
        for ident in (rel.get("identifiers") or [])
        if isinstance(ident, dict) and str(ident.get("type") or "").lower() == "barcode" and ident.get("value")
    ]

    formats = [f for f in (rel.get("formats") or []) if isinstance(f, dict)]
    media_format = str(formats[0].get("name") or "CD") if formats else "CD"
    format_qty = int(formats[0].get("qty") or 1) if formats and str(formats[0].get("qty") or "1").isdigit() else 1

    album_artists_list = list(
        dict.fromkeys(
            _discogs_clean_name(a.get("anv") or a.get("name") or "")
            for a in (rel.get("artists") or [])
            if isinstance(a, dict) and _discogs_clean_name(a.get("anv") or a.get("name") or "")
        )
    )

    # Trackliste in Discs gruppieren
    discs_tracks: dict[int, list[TrackMetadata]] = {}
    fallback_idx = 0
    for item in rel.get("tracklist") or []:
        if not isinstance(item, dict) or item.get("type_", "track") != "track":
            continue
        fallback_idx += 1
        disc_idx, trk_idx = _discogs_parse_position(item.get("position", ""), fallback_idx)
        trk_artist = _discogs_format_artists(item.get("artists") or []) or album_artist
        trk_artists_list = list(
            dict.fromkeys(
                _discogs_clean_name(a.get("anv") or a.get("name") or "")
                for a in (item.get("artists") or [])
                if isinstance(a, dict) and _discogs_clean_name(a.get("anv") or a.get("name") or "")
            )
        ) or list(album_artists_list)

        composers: list[str] = []
        lyricists: list[str] = []
        producers: list[str] = []
        trk_extra: dict[str, list[str]] = {}
        for ea in item.get("extraartists") or []:
            if not isinstance(ea, dict):
                continue
            role = str(ea.get("role") or "").lower()
            ea_name = _discogs_clean_name(ea.get("anv") or ea.get("name") or "")
            if not ea_name:
                continue
            if "written-by" in role or "composed by" in role or "music by" in role:
                if ea_name not in composers:
                    composers.append(ea_name)
            if "lyrics" in role or "words by" in role:
                if ea_name not in lyricists:
                    lyricists.append(ea_name)
            if "producer" in role or "produced by" in role:
                if ea_name not in producers:
                    producers.append(ea_name)
            if "remix" in role:
                trk_extra.setdefault("REMIXER", [])
                if ea_name not in trk_extra["REMIXER"]:
                    trk_extra["REMIXER"].append(ea_name)
            elif "mix" in role:
                trk_extra.setdefault("MIXER", [])
                if ea_name not in trk_extra["MIXER"]:
                    trk_extra["MIXER"].append(ea_name)
            if "master" in role or "engineer" in role:
                trk_extra.setdefault("ENGINEER", [])
                if ea_name not in trk_extra["ENGINEER"]:
                    trk_extra["ENGINEER"].append(ea_name)

        discs_tracks.setdefault(disc_idx, []).append(
            TrackMetadata(
                track_number=trk_idx,
                title=str(item.get("title") or f"Titel {trk_idx}"),
                artist=trk_artist,
                artists=trk_artists_list,
                duration_seconds=_discogs_parse_duration(item.get("duration", "")),
                composer="; ".join(composers),
                lyricist="; ".join(lyricists),
                producer="; ".join(producers),
                metadata_source="Discogs",
                extra_tags=trk_extra,
                disc_number=disc_idx,
            )
        )

    all_disc_nums = sorted(discs_tracks.keys()) or [1]
    total_discs = max(format_qty, len(all_disc_nums), max(all_disc_nums))
    load_all_discs = disc_number == 0
    chosen_disc = all_disc_nums[0]
    if load_all_discs:
        resolved_tracks = [t for dnum in all_disc_nums for t in discs_tracks.get(dnum, [])]
    else:
        if disc_number and disc_number in discs_tracks:
            chosen_disc = disc_number
        elif match_track_count > 0:
            for dnum in all_disc_nums:
                if len(discs_tracks[dnum]) == match_track_count:
                    chosen_disc = dnum
                    break
        resolved_tracks = discs_tracks.get(chosen_disc, [])

    available_discs = [
        {
            "position": dnum,
            "title": "",
            "format": media_format,
            "track_count": len(discs_tracks[dnum]),
        }
        for dnum in all_disc_nums
    ]

    discogs_genres = list(rel.get("genres") or []) + list(rel.get("styles") or [])
    wd_genres = fetch_wikidata_genres(
        artist_name=album_artist,
        album_title=str(rel.get("title") or ""),
    )
    genre_str = merge_genre_strings(discogs_genres, wd_genres, max_items=7)

    release_date = str(rel.get("released") or rel.get("year") or "").strip()
    year_str = str(rel.get("year") or release_date[:4] or "").strip()

    album = AlbumMetadata(
        title=str(rel.get("title") or "Unbekanntes Album"),
        artist=album_artist,
        album_artist=album_artist,
        album_artists=album_artists_list,
        album_artist_sort=album_artist_sort,
        year=year_str[:4],
        release_date=release_date,
        genre=genre_str,
        label="; ".join(labels),
        catalog_number="; ".join(catnos),
        barcode="; ".join(dict.fromkeys(barcodes)),
        country=str(rel.get("country") or "").strip(),
        status=str(rel.get("status") or "").strip().lower(),
        media_format=media_format,
        disc_number=chosen_disc,
        total_discs=total_discs,
        discogs_release_id=str(discogs_id),
        metadata_source=f"Discogs (#{discogs_id})",
        available_discs=available_discs,
        tracks=resolved_tracks,
    )

    # Cover-Bild von Discogs laden (nur falls Discogs als Cover-Quelle aktiviert ist)
    active_cov = set(
        normalize_cover_providers(
            DEFAULT_COVER_PROVIDERS if enabled_cover_providers is None else enabled_cover_providers
        )
    )
    if "discogs" in active_cov:
        images = rel.get("images") or []
        primary_img = next((img for img in images if isinstance(img, dict) and img.get("type") == "primary"), None)
        chosen_img = primary_img or (images[0] if images and isinstance(images[0], dict) else None)
        if chosen_img:
            img_url = str(chosen_img.get("uri") or chosen_img.get("resource_url") or "")
            cover_bytes, cover_mime = download_image_url(img_url)
            if cover_bytes:
                album.cover_art_bytes = cover_bytes
                album.cover_art_mime = cover_mime
                album.cover_art_source = "Discogs Cover"

    return album


def lookup_discogs_by_album(
    artist: str = "",
    title: str = "",
    match_track_count: int = 0,
    disc_number: Optional[int] = None,
    discogs_token: str = "",
    on_log: Optional[Callable[[str], None]] = None,
) -> Optional[AlbumMetadata]:
    """Sucht auf Discogs anhand Künstler/Album/Trackanzahl und lädt das beste CD-Release."""
    parts = []
    if artist and artist not in ("Unbekannter Künstler",):
        parts.append(artist.strip())
    if title and title not in ("Unbekanntes Album", "Audio-CD (Lokal ausgelesen)"):
        parts.append(title.strip())
    query = " ".join(parts).strip()
    if not query:
        _log_step("Discogs: Übersprungen (kein Künstler/Albumtitel bekannt).", on_log)
        return None

    try:
        candidates = search_discogs_releases(query, limit=5, discogs_token=discogs_token, on_log=on_log)
        for cand in candidates:
            cid = cand.get("id")
            if not cid:
                continue
            _log_step(f"Discogs: Lade Release-Details #{cid} von api.discogs.com/releases/{cid}...", on_log)
            details = fetch_discogs_release_details(
                cid,
                disc_number=disc_number,
                match_track_count=match_track_count,
            )
            if match_track_count <= 0 or len(details.tracks) == match_track_count:
                _log_step(
                    f"Discogs: Treffer bestätigt (#{cid}: {details.artist} – {details.title}, {len(details.tracks)} Tracks).",
                    on_log,
                )
                return details
        if match_track_count <= 0 and candidates and candidates[0].get("id"):
            cid0 = candidates[0]["id"]
            _log_step(f"Discogs: Verwende besten Treffer #{cid0}.", on_log)
            return fetch_discogs_release_details(
                cid0,
                disc_number=disc_number,
                match_track_count=match_track_count,
            )
        _log_step(
            f"Discogs: Kein Release mit exakt {match_track_count} Tracks gefunden.",
            on_log,
        )
    except Exception as exc:
        _log_step(f"Discogs: Abfrage fehlgeschlagen ({exc}).", on_log)
        return None
    return None


def resolve_amazon_asin(
    asin: str = "",
    release_mbid: str = "",
    artist: str = "",
    title: str = "",
    on_log: Optional[Callable[[str], None]] = None,
) -> str:
    """Ermittelt die 10-stellige Amazon-ASIN direkt oder über MusicBrainz-Release/URL-Beziehungen."""
    clean_asin = str(asin or "").strip().upper()
    if re.fullmatch(r"[A-Z0-9]{10}", clean_asin):
        return clean_asin

    candidate_mbids: list[str] = []
    if release_mbid and _UUID_RE.match(release_mbid.strip()):
        candidate_mbids.append(release_mbid.strip())

    if artist or title:
        q_parts = []
        if artist and artist != "Unbekannter Künstler":
            q_parts.append(f'"{artist.strip()}"')
        if title and title not in ("Unbekanntes Album", "Audio-CD (Lokal ausgelesen)"):
            q_parts.append(f'"{title.strip()}"')
        q_str = " ".join(q_parts).strip()
        if q_str:
            try:
                rels = search_musicbrainz_releases(q_str, limit=5)
                for r in rels:
                    rid = str(r.get("id") or "").strip()
                    if rid and rid not in candidate_mbids:
                        candidate_mbids.append(rid)
            except Exception:
                pass

    for mbid in candidate_mbids[:5]:
        try:
            data = _mb_ws2_get_json(f"release/{urllib.parse.quote(mbid)}?inc=url-rels&fmt=json")
            direct = str(data.get("asin") or "").strip().upper()
            if re.fullmatch(r"[A-Z0-9]{10}", direct):
                _log_step(f"Amazon: ASIN {direct} über MusicBrainz-Release {mbid[:8]} ermittelt.", on_log)
                return direct
            for rel_item in data.get("relations") or []:
                if isinstance(rel_item, dict) and isinstance(rel_item.get("url"), dict):
                    res_url = str(rel_item["url"].get("resource") or "")
                    m = _AMAZON_ASIN_URL_RE.search(res_url)
                    if m:
                        found = m.group(1).upper()
                        _log_step(f"Amazon: ASIN {found} aus Amazon-Link ermittelt.", on_log)
                        return found
        except Exception:
            continue

    return ""


def download_amazon_cover(
    asin: str = "",
    artist: str = "",
    title: str = "",
    release_mbid: str = "",
    on_log: Optional[Callable[[str], None]] = None,
) -> tuple[Optional[bytes], str, str]:
    """Lädt das Album-Cover von den Amazon-Bildservern anhand der ASIN (oder Künstler/Album)."""
    resolved_asin = resolve_amazon_asin(
        asin=asin,
        release_mbid=release_mbid,
        artist=artist,
        title=title,
        on_log=on_log,
    )
    if not resolved_asin:
        _log_step("Amazon Cover: Keine passende ASIN für dieses Release gefunden.", on_log)
        return None, "image/jpeg", ""

    urls = (
        f"https://m.media-amazon.com/images/P/{resolved_asin}.01._SCLZZZZZZZ_.jpg",
        f"https://images-na.ssl-images-amazon.com/images/P/{resolved_asin}.01._SCLZZZZZZZ_.jpg",
        f"https://images-eu.ssl-images-amazon.com/images/P/{resolved_asin}.01._SCLZZZZZZZ_.jpg",
        f"https://m.media-amazon.com/images/P/{resolved_asin}.01.LZZZZZZZ.jpg",
    )
    for url in urls:
        _log_step(f"Amazon Cover: Lade Bild für ASIN {resolved_asin}...", on_log)
        data, mime = download_image_url(url)
        # Amazon liefert bei fehlendem Bild ein 1x1-Pixel-GIF (< 1000 Bytes) zurück
        if data and len(data) > 1500:
            _log_step(f"Amazon Cover: Bild erfolgreich geladen ({len(data) // 1024} KB, ASIN {resolved_asin}).", on_log)
            return data, mime or "image/jpeg", resolved_asin

    _log_step(f"Amazon Cover: Kein hochauflösendes Bild unter ASIN {resolved_asin} verfügbar.", on_log)
    return None, "image/jpeg", resolved_asin


def _clean_search_hint(value: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r"\s*[\(\[]\s*(?:cd|disc|disk)\s*\d+[^\)\]]*[\)\]]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*[\(\[]\s*(?:flac|mp3|wav|remaster(?:ed)?|\d{4})\s*[\)\]]", "", text, flags=re.IGNORECASE)
    return text.strip(" -_.")


def lookup_musicbrainz_by_durations_and_hints(
    physical_album: AlbumMetadata,
    on_log: Optional[Callable[[str], None]] = None,
) -> Optional[AlbumMetadata]:
    """Hochpräzise Multi-Signal-Erkennung für virtuelle Datei-TOCs (Tags, Ordnername, Trackanzahl & Spieldauer-Vektor)."""
    track_count = len(physical_album.tracks)
    if track_count == 0:
        return None

    durations = [max(1, int(t.duration_seconds or 0)) for t in physical_album.tracks]

    # Signal A: Bereits bekannte MusicBrainz Release-ID oder Barcode in Datei-Tags / CUE
    if physical_album.musicbrainz_release_id and _UUID_RE.match(physical_album.musicbrainz_release_id.strip()):
        try:
            _log_step(
                f"[1/3 MusicBrainz] Lade Release direkt über Tag-MBID {physical_album.musicbrainz_release_id[:8]}...",
                on_log,
            )
            details = fetch_musicbrainz_release_details(
                physical_album.musicbrainz_release_id.strip(),
                disc_number=physical_album.disc_number if physical_album.disc_number > 1 else None,
                match_track_count=track_count,
            )
            return _preserve_physical_toc(details, physical_album)
        except Exception:
            pass

    if physical_album.barcode:
        bc_hit = lookup_album_by_barcode_or_qr(
            physical_album.barcode,
            current_album=physical_album,
            on_log=on_log,
        )
        if bc_hit:
            return bc_hit

    artist_raw = (physical_album.album_artist or physical_album.artist or "").strip()
    title_raw = (physical_album.title or "").strip()
    artist_hint = (
        _clean_search_hint(artist_raw)
        if artist_raw not in ("", "Unbekannter Künstler")
        else ""
    )
    title_hint = (
        _clean_search_hint(title_raw)
        if title_raw
        not in (
            "",
            "Unbekanntes Album",
            "Audio-CD (Lokal ausgelesen)",
            "Importierte Audiodateien",
            "Importiertes Album",
            "Lokaler Datei-Import (Virtuelle TOC)",
        )
        else ""
    )

    lucene_queries: list[str] = []
    if artist_hint and title_hint:
        lucene_queries.append(f'artist:"{artist_hint}" AND release:"{title_hint}" AND tracks:{track_count}')
    elif title_hint:
        lucene_queries.append(f'release:"{title_hint}" AND tracks:{track_count}')
        lucene_queries.append(f'"{title_hint}" AND tracks:{track_count}')
    elif artist_hint:
        lucene_queries.append(f'artist:"{artist_hint}" AND tracks:{track_count}')

    # Signal B: Track-Titel + exakte Spieldauer-Fenster (nur Releases mit passender Trackanzahl auf dem Medium!)
    named_tracks = [
        t
        for t in physical_album.tracks
        if t.title
        and not re.match(r"^(?:track|titel|audio)\s*\d*$", t.title.strip(), re.IGNORECASE)
    ]
    if named_tracks:
        sample_trks = named_tracks[:3]
        rec_clauses: list[str] = []
        for st in sample_trks:
            clean_t = _clean_search_hint(st.title)
            if clean_t:
                ms = max(1000, st.duration_seconds * 1000)
                rec_clauses.append(f'(recording:"{clean_t}" AND dur:[{max(1000, ms - 4000)} TO {ms + 4000}])')
        if rec_clauses:
            try:
                rec_q = " AND ".join(rec_clauses[:2]) + f" AND tracks:{track_count}"
                _log_step(
                    f"[1/3 MusicBrainz] Prüfe Track-Dauer-Signatur ({len(sample_trks)} Titel + Millisekunden-Fenster, {track_count} Tracks)...",
                    on_log,
                )
                rec_data = _mb_ws2_get_json(
                    f"recording/?query={urllib.parse.quote(rec_q)}&limit=6&fmt=json",
                    on_log=on_log,
                )
                for rec_item in rec_data.get("recordings") or []:
                    for rel_item in rec_item.get("releases") or []:
                        media_list = rel_item.get("media") or []
                        has_matching_medium = any(
                            int(m.get("track-count") or 0) == track_count for m in media_list
                        ) or int(rel_item.get("track-count") or 0) == track_count
                        if not has_matching_medium:
                            continue
                        rid = str(rel_item.get("id") or "").strip()
                        if rid and f"reid:{rid}" not in lucene_queries:
                            lucene_queries.append(f"reid:{rid}")
            except Exception:
                pass

    seen_ids: set[str] = set()
    candidate_ids: list[str] = []

    for lq in lucene_queries[:2]:
        try:
            _log_step(f"[1/3 MusicBrainz] Multi-Signal-Suche: {lq}...", on_log)
            hits = search_musicbrainz_releases(lq, limit=6, on_log=on_log)
            for h in hits:
                h_media = h.get("media") or []
                has_matching_med = any(
                    int(m.get("track-count") or 0) == track_count for m in h_media
                ) or int(h.get("track_count") or 0) == track_count
                if not has_matching_med:
                    continue
                hid = str(h.get("id") or "").strip()
                if hid and hid not in seen_ids:
                    seen_ids.add(hid)
                    candidate_ids.append(hid)
            if len(candidate_ids) >= 3:
                break
        except Exception as exc:
            _log_step(f"[1/3 MusicBrainz] Hinweis bei Suche ({exc}).", on_log)

    best_album: Optional[AlbumMetadata] = None
    best_diff = 999999.0

    for cid in candidate_ids[:3]:
        try:
            details = fetch_musicbrainz_release_details(
                cid,
                disc_number=physical_album.disc_number if physical_album.disc_number > 1 else None,
                match_track_count=track_count,
            )
            if len(details.tracks) == track_count and durations:
                total_diff = sum(
                    abs(int(details.tracks[i].duration_seconds or 0) - durations[i])
                    for i in range(track_count)
                )
                avg_diff = total_diff / max(1, track_count)
                _log_step(
                    f"[1/3 MusicBrainz] Kandidat {details.artist} – {details.title}: "
                    f"{len(details.tracks)}/{track_count} Tracks, Ø Dauer-Abweichung {avg_diff:.1f}s.",
                    on_log,
                )
                if avg_diff < best_diff:
                    best_diff = avg_diff
                    best_album = details
                if avg_diff <= 3.5:
                    break
            else:
                _log_step(
                    f"[1/3 MusicBrainz] Überspringe Release „{details.title}“ ({len(details.tracks)} Tracks statt {track_count} Tracks).",
                    on_log,
                )
        except Exception:
            continue

    if best_album:
        best_album.metadata_source = "MusicBrainz (TOC + Dauer-Vektor)"
        return _preserve_physical_toc(best_album, physical_album)

    return None


def resolve_cd_metadata(
    physical_album: AlbumMetadata,
    on_log: Optional[Callable[[str], None]] = None,
) -> AlbumMetadata:
    """Fragt Metadaten strikt in der Reihenfolge 1. MusicBrainz -> 2. Discogs -> 3. CDDB ab (inkl. Fuzzy-TOC & Dauer-Vektor)."""
    track_count = len(physical_album.tracks)
    track_durations = [max(1, int(t.duration_seconds or 0)) for t in physical_album.tracks]
    _log_step(
        f"Starte Online-Abgleich (Kaskade: 1. MusicBrainz → 2. Discogs → 3. CDDB) für {track_count} Tracks...",
        on_log,
    )

    # 1a. MusicBrainz (Exakte DiscID + Fuzzy-Sektor-TOC über alle Medienformate)
    if physical_album.musicbrainz_disc_id or physical_album.musicbrainz_toc:
        _log_step(
            f"[1/3 MusicBrainz] Prüfe DiscID {physical_album.musicbrainz_disc_id or '-'} & Fuzzy-Sektor-TOC...",
            on_log,
        )
        mb_album = lookup_musicbrainz_by_discid(
            physical_album.musicbrainz_disc_id,
            physical_album.musicbrainz_toc,
            track_count=track_count,
            track_durations=track_durations,
            on_log=on_log,
        )
        if mb_album:
            _log_step(
                f"[1/3 MusicBrainz] Treffer über DiscID/Fuzzy-TOC: {mb_album.artist} – {mb_album.title} (MBID {mb_album.musicbrainz_release_id[:8]}...).",
                on_log,
            )
            return _preserve_physical_toc(mb_album, physical_album)
        _log_step("[1/3 MusicBrainz] Kein direkter Sektor-TOC-Treffer – starte Multi-Signal- & Dauer-Vektor-Abgleich...", on_log)

    # 1b. MusicBrainz Multi-Signal-Abgleich (Tags, CUE, Ordnername, Trackanzahl & Spieldauer-Vektor)
    mb_multi = lookup_musicbrainz_by_durations_and_hints(physical_album, on_log=on_log)
    if mb_multi:
        _log_step(
            f"[1/3 MusicBrainz] Treffer über Multi-Signal/Dauer-Vektor: {mb_multi.artist} – {mb_multi.title}.",
            on_log,
        )
        return mb_multi

    has_hint = (
        physical_album.title
        not in (
            "",
            "Unbekanntes Album",
            "Audio-CD (Lokal ausgelesen)",
            "Importierte Audiodateien",
            "Importiertes Album",
        )
        and physical_album.artist not in ("", "Unbekannter Künstler")
    )
    if has_hint:
        # 2. Discogs (wenn Künstler/Titel aus Tags oder Ordnername bekannt)
        _log_step(
            f"[2/3 Discogs] Starte Discogs-Abfrage für '{physical_album.artist} – {physical_album.title}'...",
            on_log,
        )
        discogs_album = lookup_discogs_by_album(
            artist=physical_album.album_artist or physical_album.artist,
            title=physical_album.title,
            match_track_count=track_count,
            disc_number=physical_album.disc_number if physical_album.disc_number > 1 else None,
            on_log=on_log,
        )
        if discogs_album:
            return _preserve_physical_toc(discogs_album, physical_album)
    else:
        _log_step(
            "[2/3 Discogs] Noch kein Album-/Künstlername bekannt – frage CDDB/GnuDB über Sektor-Offsets ab.",
            on_log,
        )


    # 3. GnuDB / CDDB Fallback (Gesamtlänge in Sekunden ab Frame 0 = leadout_offset // 75)
    if physical_album.cddb_id and physical_album.track_offsets:
        total_secs = max(1, physical_album.leadout_offset // 75)
        _log_step(
            f"[3/3 CDDB/GnuDB] Frage gnudb.org nach DiscID {physical_album.cddb_id} ({track_count} Tracks, {total_secs}s) ab...",
            on_log,
        )
        cddb_album = lookup_cddb_metadata(
            physical_album.cddb_id,
            physical_album.track_offsets,
            total_secs,
        )
        if cddb_album:
            _log_step(
                f"[3/3 CDDB/GnuDB] Treffer: {cddb_album.artist} – {cddb_album.title}.",
                on_log,
            )
            resolved = _preserve_physical_toc(cddb_album, physical_album)
            # Cover + fehlende Genres über MusicBrainz, Discogs & Amazon ergänzen
            if resolved.artist and resolved.title:
                try:
                    matches = search_musicbrainz_releases(f'"{resolved.artist}" "{resolved.title}"', limit=3)
                    for match in matches:
                        if match.get("medium_count", 1) > resolved.total_discs:
                            resolved.total_discs = match["medium_count"]
                        if not resolved.cover_art_bytes:
                            data, mime = download_cover_art(match["id"])
                            if data:
                                resolved.musicbrainz_release_id = resolved.musicbrainz_release_id or match["id"]
                                resolved.cover_art_bytes = data
                                resolved.cover_art_mime = mime
                                resolved.cover_art_source = "Cover Art Archive (MusicBrainz)"
                                break
                except Exception:
                    pass
                if not resolved.cover_art_bytes or not resolved.genre:
                    _log_step("[Discogs-Ergänzung] Suche Cover & Genres auf Discogs...", on_log)
                    dg = lookup_discogs_by_album(
                        artist=resolved.album_artist or resolved.artist,
                        title=resolved.title,
                        match_track_count=track_count,
                        on_log=on_log,
                    )
                    if dg:
                        if dg.genre:
                            resolved.genre = merge_genre_strings(resolved.genre, dg.genre, max_items=7)
                        if not resolved.cover_art_bytes and dg.cover_art_bytes:
                            resolved.cover_art_bytes = dg.cover_art_bytes
                            resolved.cover_art_mime = dg.cover_art_mime
                            resolved.cover_art_source = dg.cover_art_source
                if not resolved.cover_art_bytes:
                    amz_bytes, amz_mime, amz_asin = download_amazon_cover(
                        asin=resolved.asin,
                        artist=resolved.album_artist or resolved.artist,
                        title=resolved.title,
                        release_mbid=resolved.musicbrainz_release_id,
                        on_log=on_log,
                    )
                    if amz_bytes:
                        resolved.asin = resolved.asin or amz_asin
                        resolved.cover_art_bytes = amz_bytes
                        resolved.cover_art_mime = amz_mime
                        resolved.cover_art_source = f"Amazon Cover (ASIN {amz_asin})"
            wd_genres = fetch_wikidata_genres(
                release_id=resolved.musicbrainz_release_id,
                release_group_id=resolved.musicbrainz_release_group_id,
                artist_id=resolved.musicbrainz_album_artist_id,
                artist_name=resolved.album_artist or resolved.artist,
                album_title=resolved.title,
            )
            if wd_genres:
                resolved.genre = merge_genre_strings(resolved.genre, wd_genres, max_items=7)
            return resolved
        _log_step(f"[3/3 CDDB/GnuDB] Kein Eintrag für DiscID {physical_album.cddb_id} gefunden.", on_log)

    return physical_album


def lookup_album_by_barcode_or_qr(
    raw_code: str,
    current_album: Optional[AlbumMetadata] = None,
    discogs_token: str = "",
    on_log: Optional[Callable[[str], None]] = None,
) -> Optional[AlbumMetadata]:
    """Sucht ein Album anhand eines gescannten Barcodes (EAN/UPC) oder QR-Codes (MusicBrainz -> Discogs)."""
    parsed = parse_barcode_or_qr_payload(raw_code)
    if parsed["kind"] == "empty":
        return None

    track_count = len(current_album.tracks) if current_album else 0
    disc_num = current_album.disc_number if (current_album and current_album.disc_number > 1) else None

    _log_step(
        f"[Barcode/QR-Suche] Analysiere Code „{parsed['raw']}“ (Typ: {parsed['kind'].upper()})...",
        on_log,
    )

    # Direkte Discogs-ID aus QR-Code
    if parsed["kind"] == "discogs_id" and parsed.get("discogs_id"):
        dg_id = parsed["discogs_id"]
        _log_step(f"[Barcode/QR → Discogs] Lade Release #{dg_id}...", on_log)
        details = fetch_discogs_release_details(dg_id, disc_number=disc_num, match_track_count=track_count)
        return _preserve_physical_toc(details, current_album) if current_album else details

    # Direkte MusicBrainz-UUID aus QR-Code
    if parsed["kind"] == "mbid" and parsed.get("mbid"):
        mbid = parsed["mbid"]
        _log_step(f"[Barcode/QR → MusicBrainz] Lade Release-UUID {mbid}...", on_log)
        details = fetch_musicbrainz_release_details(mbid, disc_number=disc_num, match_track_count=track_count)
        return _preserve_physical_toc(details, current_album) if current_album else details

    # 1. MusicBrainz Barcode-/QR-Suche
    try:
        _log_step(f"[1/2 MusicBrainz] Suche nach Barcode/Code ({parsed['query']})...", on_log)
        mb_hits = search_musicbrainz_releases(parsed["raw"], limit=3)
        if mb_hits and mb_hits[0].get("id"):
            mb_id = mb_hits[0]["id"]
            details = fetch_musicbrainz_release_details(
                mb_id,
                disc_number=disc_num,
                match_track_count=track_count,
            )
            if parsed.get("barcode") and not details.barcode:
                details.barcode = parsed["barcode"]
            _log_step(
                f"[1/2 MusicBrainz] Treffer über Barcode/QR: {details.artist} – {details.title} (MBID {mb_id[:8]}...).",
                on_log,
            )
            return _preserve_physical_toc(details, current_album) if current_album else details
        _log_step("[1/2 MusicBrainz] Kein Treffer – prüfe Discogs...", on_log)
    except Exception as exc:
        _log_step(f"[1/2 MusicBrainz] Fehler ({exc}) – prüfe Discogs...", on_log)

    # 2. Discogs Barcode-/QR-Suche
    try:
        _log_step(f"[2/2 Discogs] Suche nach Barcode/Code „{parsed['raw']}“...", on_log)
        dg_hits = search_discogs_releases(parsed["raw"], limit=3, discogs_token=discogs_token, on_log=on_log)
        if dg_hits and dg_hits[0].get("id"):
            cid = dg_hits[0]["id"]
            details = fetch_discogs_release_details(cid, disc_number=disc_num, match_track_count=track_count)
            if parsed.get("barcode") and not details.barcode:
                details.barcode = parsed["barcode"]
            _log_step(
                f"[2/2 Discogs] Treffer über Barcode/QR: {details.artist} – {details.title} (Discogs #{cid}).",
                on_log,
            )
            return _preserve_physical_toc(details, current_album) if current_album else details
    except Exception as exc:
        _log_step(f"[2/2 Discogs] Fehler bei Barcode-Abfrage ({exc}).", on_log)

    _log_step(f"[Barcode/QR-Suche] Kein Release für „{parsed['raw']}“ gefunden.", on_log)
    return None


def lookup_album_metadata_ordered(
    current_album: AlbumMetadata,
    on_log: Optional[Callable[[str], None]] = None,
) -> Optional[AlbumMetadata]:
    """Manueller Online-Abgleich in fester Reihenfolge: 1. MusicBrainz, 2. Discogs, 3. CDDB."""
    track_count = len(current_album.tracks)
    artist_term = (current_album.album_artist or current_album.artist or "").strip()
    title_term = (current_album.title or "").strip()
    barcode_term = (current_album.barcode or "").strip()
    is_placeholder = title_term in ("", "Unbekanntes Album", "Audio-CD (Lokal ausgelesen)")

    _log_step("Starte Online-Abfrage (1. MusicBrainz → 2. Discogs → 3. CDDB)...", on_log)

    # Falls ein Barcode / QR-Code im Feld 'barcode' eingetragen wurde, diesen vorrangig prüfen
    if barcode_term:
        bc_hit = lookup_album_by_barcode_or_qr(
            barcode_term,
            current_album=current_album,
            on_log=on_log,
        )
        if bc_hit:
            return bc_hit

    # 1. MusicBrainz
    if current_album.musicbrainz_release_id:
        _log_step(
            f"[1/3 MusicBrainz] Lade Release-ID {current_album.musicbrainz_release_id}...",
            on_log,
        )
        details = fetch_musicbrainz_release_details(
            current_album.musicbrainz_release_id,
            disc_number=current_album.disc_number,
        )
        _log_step(f"[1/3 MusicBrainz] Geladen: {details.artist} – {details.title}.", on_log)
        return _preserve_physical_toc(details, current_album)

    if current_album.musicbrainz_disc_id or current_album.musicbrainz_toc:
        _log_step(
            f"[1/3 MusicBrainz] Prüfe DiscID {current_album.musicbrainz_disc_id or '-'}...",
            on_log,
        )
        mb_disc = lookup_musicbrainz_by_discid(
            current_album.musicbrainz_disc_id,
            current_album.musicbrainz_toc,
            track_count=track_count,
        )
        if mb_disc:
            _log_step(f"[1/3 MusicBrainz] DiscID-Treffer: {mb_disc.artist} – {mb_disc.title}.", on_log)
            return _preserve_physical_toc(mb_disc, current_album)

    if not is_placeholder:
        parts = []
        if artist_term and artist_term != "Unbekannter Künstler":
            parts.append(f'"{artist_term}"')
        if title_term:
            parts.append(f'"{title_term}"')
        query = " ".join(parts).strip()
        if query:
            try:
                _log_step(f"[1/3 MusicBrainz] Suche nach {query}...", on_log)
                releases = search_musicbrainz_releases(query, limit=1)
                if releases and releases[0].get("id"):
                    details = fetch_musicbrainz_release_details(
                        releases[0]["id"],
                        disc_number=current_album.disc_number if current_album.disc_number > 1 else None,
                        match_track_count=track_count,
                    )
                    _log_step(
                        f"[1/3 MusicBrainz] Treffer: {details.artist} – {details.title} (überspringe Discogs/CDDB, da MusicBrainz erfolgreich).",
                        on_log,
                    )
                    return _preserve_physical_toc(details, current_album)
                _log_step("[1/3 MusicBrainz] Keine Treffer – fahre mit Schritt 2 (Discogs) fort.", on_log)
            except Exception as exc:
                _log_step(f"[1/3 MusicBrainz] Fehler ({exc}) – fahre mit Schritt 2 (Discogs) fort.", on_log)

    # 2. Discogs
    if not is_placeholder:
        _log_step(f"[2/3 Discogs] Suche nach '{artist_term} – {title_term}'...", on_log)
        discogs_album = lookup_discogs_by_album(
            artist=artist_term,
            title=title_term,
            match_track_count=track_count,
            disc_number=current_album.disc_number if current_album.disc_number > 1 else None,
            on_log=on_log,
        )
        if discogs_album:
            return _preserve_physical_toc(discogs_album, current_album)

    # 3. CDDB / GnuDB
    if current_album.cddb_id and current_album.track_offsets:
        total_secs = max(1, current_album.leadout_offset // 75)
        _log_step(f"[3/3 CDDB/GnuDB] Prüfe DiscID {current_album.cddb_id}...", on_log)
        cddb_album = lookup_cddb_metadata(
            current_album.cddb_id,
            current_album.track_offsets,
            total_secs,
        )
        if cddb_album:
            _log_step(f"[3/3 CDDB/GnuDB] Treffer: {cddb_album.artist} – {cddb_album.title}.", on_log)
            resolved = _preserve_physical_toc(cddb_album, current_album)
            wd_genres = fetch_wikidata_genres(
                artist_name=resolved.album_artist or resolved.artist,
                album_title=resolved.title,
            )
            if wd_genres:
                resolved.genre = merge_genre_strings(resolved.genre, wd_genres, max_items=7)
            return resolved

    _log_step("Online-Abfrage abgeschlossen: Kein Treffer in MusicBrainz, Discogs oder CDDB.", on_log)
    return None


def download_cover_art(
    release_mbid: str,
    size: int = 500,
    on_log: Optional[Callable[[str], None]] = None,
) -> tuple[Optional[bytes], str]:
    """Lädt das Front-Cover automatisch vom Cover Art Archive herunter."""
    if not release_mbid:
        return None, "image/jpeg"

    _log_step(f"Cover Art Archive: Prüfe Front-Cover für MBID {release_mbid[:8]}...", on_log)
    url = f"https://coverartarchive.org/release/{release_mbid}/front-{size}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": f"{USER_AGENT_APP}/{USER_AGENT_VERSION} ({USER_AGENT_CONTACT})"},
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            content_type = resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
            data = resp.read()
            _log_step(f"Cover Art Archive: Cover geladen ({len(data) // 1024} KB).", on_log)
            return data, content_type
    except urllib.error.HTTPError:
        try:
            fallback_req = urllib.request.Request(
                f"https://coverartarchive.org/release/{release_mbid}/front",
                headers={"User-Agent": USER_AGENT_HEADER},
            )
            with urllib.request.urlopen(fallback_req, timeout=12) as resp:
                content_type = resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
                data = resp.read()
                _log_step(f"Cover Art Archive: Original-Cover geladen ({len(data) // 1024} KB).", on_log)
                return data, content_type
        except Exception:
            _log_step("Cover Art Archive: Kein Cover hinterlegt.", on_log)
            return None, "image/jpeg"
    except Exception as exc:
        _log_step(f"Cover Art Archive: Fehler ({exc}).", on_log)
        return None, "image/jpeg"


def _download_caa_release_group_images(
    rg_id: str,
    limit: int = 2,
) -> list[tuple[bytes, str, str]]:
    """Lädt Front- und weitere priorisierte Cover-Bilder einer MusicBrainz Release-Group."""
    if not rg_id or not _UUID_RE.match(rg_id):
        return []
    out: list[tuple[bytes, str, str]] = []
    try:
        req = urllib.request.Request(
            f"https://coverartarchive.org/release-group/{urllib.parse.quote(rg_id)}",
            headers={
                "User-Agent": f"{USER_AGENT_APP}/{USER_AGENT_VERSION} ({USER_AGENT_CONTACT})",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=7) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace"))
        imgs = payload.get("images") or []
        prioritized = [
            im for im in imgs if im.get("front") is True or "Front" in (im.get("types") or [])
        ] + [
            im for im in imgs if not (im.get("front") is True or "Front" in (im.get("types") or []))
        ]
        for im in prioritized[:limit]:
            thumbs = im.get("thumbnails") or {}
            img_url = str(
                im.get("image") or thumbs.get("1200") or thumbs.get("500") or thumbs.get("large") or ""
            ).strip()
            if not img_url:
                continue
            img_url = re.sub(r"^http://", "https://", img_url, flags=re.I)
            data, mime = download_image_url(img_url, timeout=8)
            if data:
                types_list = im.get("types") or []
                type_label = ", ".join(str(t) for t in types_list) if types_list else "Front"
                out.append((data, mime or "image/jpeg", type_label))
    except Exception:
        pass
    if not out:
        for suffix in ("front-1200", "front-500", "front"):
            data, mime = download_image_url(
                f"https://coverartarchive.org/release-group/{urllib.parse.quote(rg_id)}/{suffix}",
                timeout=7,
            )
            if data:
                out.append((data, mime or "image/jpeg", "Release-Group Front"))
                break
    return out


def search_all_cover_candidates(
    artist: str = "",
    title: str = "",
    release_mbid: str = "",
    release_group_mbid: str = "",
    discogs_id: str = "",
    asin: str = "",
    barcode: str = "",
    discogs_token: str = "",
    on_log: Optional[Callable[[str], None]] = None,
    query: str = "",
    cancel_event: Optional[threading.Event] = None,
    enabled_providers: Optional[list[str]] = None,
) -> list[dict]:
    """
    Fragt alle aktivierten Cover-Provider (MusicBrainz CAA, MusicBrainz Release-Group CAA,
    Deezer, TheAudioDB, Bandcamp, iTunes DE & Multi-Region US/JP, Discogs, Amazon) parallel ab
    und gibt sämtliche eindeutigen Cover-Bilder für die tabellarische Auswahlanzeige zurück.
    """
    active_providers = normalize_cover_providers(
        DEFAULT_COVER_PROVIDERS if enabled_providers is None else enabled_providers
    )
    active_set = set(active_providers)
    provider_label_map = {str(p["id"]): str(p["label"]) for p in COVER_PROVIDER_OPTIONS}

    if not active_set:
        _log_step(
            "[Cover-Suche] Keine Cover-Bilddatenbank in den Einstellungen aktiviert.",
            on_log,
        )
        return []

    raw_query = str(query or "").strip()
    clean_artist = str(artist or "").strip()
    clean_title = str(title or "").strip()
    clean_mbid = str(release_mbid or "").strip()
    clean_rgid = str(release_group_mbid or "").strip()
    raw_discogs = str(discogs_id or "").strip()
    clean_asin = str(asin or "").strip().upper()
    clean_barcode = str(barcode or "").strip()

    if raw_query:
        mb_url_m = re.search(r"musicbrainz\.org/release/([a-f0-9-]{36})", raw_query, flags=re.I)
        mb_rg_m = re.search(r"musicbrainz\.org/release-group/([a-f0-9-]{36})", raw_query, flags=re.I)
        if mb_rg_m:
            clean_rgid = mb_rg_m.group(1).lower()
        elif mb_url_m:
            clean_mbid = mb_url_m.group(1).lower()
        elif _UUID_RE.match(raw_query):
            clean_mbid = raw_query.lower()
        elif (
            re.search(r"\[\s*[rm]?\s*\d{2,12}\s*\]", raw_query, flags=re.I)
            or re.match(r"^(?:discogs\s*:\s*)?(?:(?:release|master)\s*[:/]\s*)?\[?\s*[rm]\s*\d{2,12}\s*\]?$", raw_query, flags=re.I)
            or re.search(r"discogs\.com/(?:[^/]+/)?(?:release|master)/\d{2,12}", raw_query, flags=re.I)
        ):
            raw_discogs = raw_query
        elif re.match(r"^\d{8,14}$", re.sub(r"[\s-]+", "", raw_query)):
            clean_barcode = re.sub(r"[\s-]+", "", raw_query)
        elif re.match(r"^B[0-9A-Z]{9}$", raw_query, flags=re.I):
            clean_asin = raw_query.upper()
        elif not clean_artist and not clean_title:
            dash_m = re.match(r"^(.+?)\s+[-–—]\s+(.+)$", raw_query)
            if dash_m:
                clean_artist = dash_m.group(1).strip()
                clean_title = dash_m.group(2).strip()

    if cancel_event and cancel_event.is_set():
        return []

    clean_discogs = (
        _resolve_discogs_release_id(raw_discogs, discogs_token=discogs_token, on_log=on_log)
        if (raw_discogs and "discogs" in active_set)
        else ""
    )

    if cancel_event and cancel_event.is_set():
        return []

    eff_artist = clean_artist if clean_artist not in ("", "Unbekannter Künstler") else ""
    eff_title = (
        clean_title
        if clean_title not in ("", "Unbekanntes Album", "Audio-CD (Lokal ausgelesen)")
        else ""
    )
    free_text_query = (
        raw_query
        if (raw_query and not clean_mbid and not clean_rgid and not raw_discogs and not clean_barcode and not clean_asin)
        else " ".join(p for p in (eff_artist, eff_title) if p).strip()
    )
    search_term = " ".join(p for p in (eff_artist, eff_title) if p).strip() or free_text_query

    active_names = " · ".join(provider_label_map.get(pid, pid) for pid in active_providers)
    log_target = raw_query or f"{clean_artist or '—'} – {clean_title or '—'}"
    _log_step(
        f"[Cover-Suche] Frage aktivierte Provider parallel ab ({active_names}) für „{log_target}“...",
        on_log,
    )

    candidates: list[dict] = []
    cand_lock = threading.Lock()

    def _add_candidate(
        data: Optional[bytes],
        mime: str,
        provider: str,
        provider_label: str,
        source_label: str,
        cand_title: str,
        cand_artist: str,
        date_str: str = "",
        details: str = "",
        mbid_val: str = "",
        discogs_val: str = "",
        asin_val: str = "",
    ) -> None:
        if not data or len(data) <= 1500:
            return
        digest = hashlib.sha256(data).hexdigest()
        with cand_lock:
            candidates.append(
                {
                    "id": f"{provider}-{len(candidates) + 1}-{digest[:8]}",
                    "provider": provider,
                    "provider_label": provider_label,
                    "source_label": source_label,
                    "title": cand_title or clean_title or "Unbekanntes Album",
                    "artist": cand_artist or clean_artist or "Unbekannter Künstler",
                    "date": date_str,
                    "details": details,
                    "image_bytes": data,
                    "mime": mime or "image/jpeg",
                    "size_bytes": len(data),
                    "mbid": mbid_val,
                    "discogs_id": discogs_val,
                    "asin": asin_val,
                }
            )

    def _cancelled() -> bool:
        return bool(cancel_event and cancel_event.is_set())

    # Gemeinsame MusicBrainz-Release- und Release-Group-IDs (für CAA, Release-Group CAA, TheAudioDB & Amazon)
    mb_candidate_ids: list[str] = []
    mb_rg_ids: list[str] = []
    mb_meta_map: dict[str, dict] = {}
    mb_rg_meta_map: dict[str, dict] = {}

    if clean_mbid and _UUID_RE.match(clean_mbid):
        mb_candidate_ids.append(clean_mbid)
    if clean_rgid and _UUID_RE.match(clean_rgid):
        mb_rg_ids.append(clean_rgid)

    need_mb_lookup = bool(
        active_set.intersection({"musicbrainz_caa", "musicbrainz_rg_caa", "theaudiodb", "amazon"})
    )
    if need_mb_lookup and not _cancelled():
        q_parts: list[str] = []
        if clean_barcode:
            q_parts.append(f"barcode:{clean_barcode}")
        if eff_artist:
            q_parts.append(f'artist:"{eff_artist}"')
        if eff_title:
            q_parts.append(f'release:"{eff_title}"')
        mb_query_str = " AND ".join(q_parts) if q_parts else free_text_query
        if mb_query_str:
            try:
                rels = search_musicbrainz_releases(mb_query_str, limit=5)
                for r in rels:
                    rid = str(r.get("id") or "").strip()
                    if rid and _UUID_RE.match(rid):
                        if rid not in mb_candidate_ids:
                            mb_candidate_ids.append(rid)
                        mb_meta_map[rid] = r
                    rg_val = str(r.get("release_group_id") or r.get("rg_id") or "").strip()
                    if rg_val and _UUID_RE.match(rg_val):
                        if rg_val not in mb_rg_ids:
                            mb_rg_ids.append(rg_val)
                        mb_rg_meta_map.setdefault(rg_val, r)
            except Exception:
                pass

        # Falls Release-Group-CAA oder TheAudioDB aktiv sind und noch keine RG-ID vorliegt: gezielt abfragen
        if (
            active_set.intersection({"musicbrainz_rg_caa", "theaudiodb"})
            and not mb_rg_ids
            and not _cancelled()
        ):
            if clean_mbid and _UUID_RE.match(clean_mbid):
                try:
                    req = urllib.request.Request(
                        f"{MB_WS2_BASE}/release/{urllib.parse.quote(clean_mbid)}?inc=release-groups&fmt=json",
                        headers={
                            "User-Agent": f"{USER_AGENT_APP}/{USER_AGENT_VERSION} ({USER_AGENT_CONTACT})",
                            "Accept": "application/json",
                        },
                    )
                    with urllib.request.urlopen(req, timeout=6) as resp:
                        rdata = json.loads(resp.read().decode("utf-8", errors="replace"))
                    rg_obj = rdata.get("release-group") or {}
                    rg_val = str(rg_obj.get("id") or "").strip()
                    if rg_val and _UUID_RE.match(rg_val):
                        mb_rg_ids.append(rg_val)
                        mb_rg_meta_map[rg_val] = {
                            "title": str(rg_obj.get("title") or rdata.get("title") or clean_title),
                            "artist": clean_artist,
                            "date": str(rg_obj.get("first-release-date") or rdata.get("date") or ""),
                        }
                except Exception:
                    pass
            if not mb_rg_ids and search_term and not _cancelled():
                try:
                    rg_q_parts: list[str] = []
                    if eff_artist:
                        rg_q_parts.append(f'artist:"{eff_artist}"')
                    if eff_title:
                        rg_q_parts.append(f'releasegroup:"{eff_title}"')
                    rg_q = " AND ".join(rg_q_parts) if rg_q_parts else search_term
                    req = urllib.request.Request(
                        f"{MB_WS2_BASE}/release-group/?query={urllib.parse.quote(rg_q)}&limit=4&fmt=json",
                        headers={
                            "User-Agent": f"{USER_AGENT_APP}/{USER_AGENT_VERSION} ({USER_AGENT_CONTACT})",
                            "Accept": "application/json",
                        },
                    )
                    with urllib.request.urlopen(req, timeout=6) as resp:
                        rg_res = json.loads(resp.read().decode("utf-8", errors="replace"))
                    for rg_item in (rg_res.get("release-groups") or [])[:4]:
                        rg_val = str(rg_item.get("id") or "").strip()
                        if rg_val and _UUID_RE.match(rg_val) and rg_val not in mb_rg_ids:
                            mb_rg_ids.append(rg_val)
                            ac_list = rg_item.get("artist-credit") or []
                            rg_art = "".join(
                                f"{ac.get('name') or (ac.get('artist') or {}).get('name') or ''}{ac.get('joinphrase') or ''}"
                                for ac in ac_list
                                if isinstance(ac, dict)
                            ).strip()
                            mb_rg_meta_map[rg_val] = {
                                "title": str(rg_item.get("title") or clean_title),
                                "artist": rg_art or clean_artist,
                                "date": str(rg_item.get("first-release-date") or ""),
                            }
                except Exception:
                    pass

    # --- Provider-Worker-Funktionen ---
    def _run_musicbrainz_caa() -> None:
        for rid in mb_candidate_ids[:5]:
            if _cancelled():
                return
            rmeta = mb_meta_map.get(rid, {})
            c_bytes, c_mime = download_cover_art(rid, size=1200, on_log=on_log)
            if not c_bytes:
                c_bytes, c_mime = download_cover_art(rid, size=500, on_log=on_log)
            if c_bytes:
                det_parts = [
                    rmeta.get("country", ""),
                    rmeta.get("label", ""),
                    f"MBID {rid[:8]}",
                ]
                _add_candidate(
                    c_bytes,
                    c_mime,
                    provider="musicbrainz",
                    provider_label="MusicBrainz CAA",
                    source_label="Cover Art Archive (MusicBrainz)",
                    cand_title=str(rmeta.get("title") or clean_title),
                    cand_artist=str(rmeta.get("artist") or clean_artist),
                    date_str=str(rmeta.get("date") or ""),
                    details=" · ".join(p for p in det_parts if p),
                    mbid_val=rid,
                )

    def _run_musicbrainz_rg_caa() -> None:
        for rgid in mb_rg_ids[:4]:
            if _cancelled():
                return
            rg_meta = mb_rg_meta_map.get(rgid, {})
            rg_images = _download_caa_release_group_images(rgid, limit=2)
            for data, mime, type_lbl in rg_images:
                if _cancelled():
                    return
                det_parts = [type_lbl, f"RG {rgid[:8]}"]
                _add_candidate(
                    data,
                    mime,
                    provider="musicbrainz_rg",
                    provider_label="MusicBrainz Release-Group",
                    source_label="Cover Art Archive (Release-Group)",
                    cand_title=str(rg_meta.get("title") or clean_title),
                    cand_artist=str(rg_meta.get("artist") or clean_artist),
                    date_str=str(rg_meta.get("date") or ""),
                    details=" · ".join(p for p in det_parts if p),
                    mbid_val=clean_mbid,
                )

    def _run_deezer() -> None:
        if not search_term or _cancelled():
            return
        queries_to_try: list[str] = []
        if eff_artist and eff_title:
            queries_to_try.append(f'artist:"{eff_artist}" album:"{eff_title}"')
        if search_term not in queries_to_try:
            queries_to_try.append(search_term)
        items: list[dict] = []
        for q_str in queries_to_try:
            if _cancelled():
                return
            try:
                dz_url = f"https://api.deezer.com/search/album?q={urllib.parse.quote(q_str)}&limit=6"
                req = urllib.request.Request(
                    dz_url,
                    headers={"User-Agent": USER_AGENT_HEADER},
                )
                with urllib.request.urlopen(req, timeout=7) as resp:
                    dz_data = json.loads(resp.read().decode("utf-8", errors="replace"))
                items = dz_data.get("data") or []
                if items:
                    break
            except Exception:
                continue
        for item in items[:5]:
            if _cancelled():
                return
            xl_url = str(item.get("cover_xl") or item.get("cover_big") or "").strip()
            if not xl_url:
                continue
            hi_url = re.sub(r"1000x1000", "1200x1200", xl_url)
            d_bytes, d_mime = download_image_url(hi_url, timeout=7)
            if not d_bytes and hi_url != xl_url:
                d_bytes, d_mime = download_image_url(xl_url, timeout=7)
            if d_bytes:
                dz_artist = str((item.get("artist") or {}).get("name") or clean_artist)
                dz_title = str(item.get("title") or clean_title)
                nb_tracks = item.get("nb_tracks")
                det_parts = [f"{nb_tracks} Tracks" if nb_tracks else "", "Deezer Katalog"]
                _add_candidate(
                    d_bytes,
                    d_mime,
                    provider="deezer",
                    provider_label="Deezer",
                    source_label="Deezer Cover",
                    cand_title=dz_title,
                    cand_artist=dz_artist,
                    date_str="",
                    details=" · ".join(p for p in det_parts if p),
                )

    def _run_theaudiodb() -> None:
        if _cancelled():
            return
        albums_found: list[dict] = []
        seen_tadb_ids: set[str] = set()

        def _fetch_tadb(url: str) -> None:
            try:
                req = urllib.request.Request(
                    url,
                    headers={"User-Agent": USER_AGENT_HEADER},
                )
                with urllib.request.urlopen(req, timeout=7) as resp:
                    payload = json.loads(resp.read().decode("utf-8", errors="replace"))
                for alb in (payload.get("album") or []):
                    if not isinstance(alb, dict):
                        continue
                    aid = str(alb.get("idAlbum") or "")
                    if aid and aid in seen_tadb_ids:
                        continue
                    if aid:
                        seen_tadb_ids.add(aid)
                    albums_found.append(alb)
            except Exception:
                pass

        for rgid in mb_rg_ids[:2]:
            if _cancelled():
                return
            _fetch_tadb(f"https://www.theaudiodb.com/api/v1/json/2/album-mb.php?i={urllib.parse.quote(rgid)}")

        t_artist, t_title = eff_artist, eff_title
        if not t_artist and not t_title and search_term:
            dm = re.match(r"^(.+?)\s+[-–—]\s+(.+)$", search_term)
            if dm:
                t_artist, t_title = dm.group(1).strip(), dm.group(2).strip()
        if t_artist and t_title and not _cancelled():
            _fetch_tadb(
                "https://www.theaudiodb.com/api/v1/json/2/searchalbum.php"
                f"?s={urllib.parse.quote(t_artist)}&a={urllib.parse.quote(t_title)}"
            )
        elif t_artist and not _cancelled():
            _fetch_tadb(
                "https://www.theaudiodb.com/api/v1/json/2/searchalbum.php"
                f"?s={urllib.parse.quote(t_artist)}"
            )

        for alb in albums_found[:4]:
            if _cancelled():
                return
            for key_name, label_suffix in (
                ("strAlbumThumbHQ", "HQ Front"),
                ("strAlbumThumb", "Front"),
            ):
                img_url = str(alb.get(key_name) or "").strip()
                if not img_url:
                    continue
                img_url = re.sub(r"^http://", "https://", img_url, flags=re.I)
                t_bytes, t_mime = download_image_url(img_url, timeout=7)
                if t_bytes:
                    det_parts = [
                        label_suffix,
                        str(alb.get("strGenre") or ""),
                        str(alb.get("strLabel") or ""),
                    ]
                    _add_candidate(
                        t_bytes,
                        t_mime,
                        provider="theaudiodb",
                        provider_label="TheAudioDB",
                        source_label="TheAudioDB Cover",
                        cand_title=str(alb.get("strAlbum") or clean_title),
                        cand_artist=str(alb.get("strArtist") or clean_artist),
                        date_str=str(alb.get("intYearReleased") or ""),
                        details=" · ".join(p for p in det_parts if p),
                    )
                    break

    def _run_bandcamp() -> None:
        if not search_term or _cancelled():
            return
        try:
            bc_url = f"https://bandcamp.com/search?q={urllib.parse.quote(search_term)}&item_type=a"
            req = urllib.request.Request(
                bc_url,
                headers={
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
                    "Accept-Language": "de,en;q=0.9",
                },
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                page_html = resp.read().decode("utf-8", errors="replace")
        except Exception:
            return

        blocks = re.findall(
            r'<li\s+class="searchresult[^"]*"[^>]*>(.*?)</li>',
            page_html,
            flags=re.S | re.I,
        )
        added_bc = 0
        for block in blocks:
            if _cancelled() or added_bc >= 4:
                return
            img_m = re.search(
                r'https?://f4\.bcbits\.com/img/(a\d+)_\d+\.(jpg|jpeg|png)',
                block,
                flags=re.I,
            )
            if not img_m:
                continue
            art_id = img_m.group(1)
            hi_url = f"https://f4.bcbits.com/img/{art_id}_10.jpg"
            title_m = re.search(
                r'<div\s+class="heading"[^>]*>.*?<a[^>]*>(.*?)</a>',
                block,
                flags=re.S | re.I,
            )
            sub_m = re.search(
                r'<div\s+class="subhead"[^>]*>(.*?)</div>',
                block,
                flags=re.S | re.I,
            )
            rel_m = re.search(
                r'<div\s+class="released"[^>]*>(.*?)</div>',
                block,
                flags=re.S | re.I,
            )
            bc_title = html.unescape(re.sub(r"<[^>]+>", "", title_m.group(1))).strip() if title_m else clean_title
            bc_artist_raw = html.unescape(re.sub(r"<[^>]+>", "", sub_m.group(1))).strip() if sub_m else ""
            bc_artist = re.sub(r"^by\s+", "", bc_artist_raw, flags=re.I).strip() or clean_artist
            bc_date = html.unescape(re.sub(r"<[^>]+>", "", rel_m.group(1))).strip() if rel_m else ""
            bc_date = re.sub(r"^released\s+", "", bc_date, flags=re.I).strip()

            b_bytes, b_mime = download_image_url(hi_url, timeout=7)
            if not b_bytes:
                fallback_url = f"https://f4.bcbits.com/img/{art_id}_16.jpg"
                b_bytes, b_mime = download_image_url(fallback_url, timeout=7)
            if b_bytes:
                added_bc += 1
                _add_candidate(
                    b_bytes,
                    b_mime,
                    provider="bandcamp",
                    provider_label="Bandcamp",
                    source_label="Bandcamp Cover",
                    cand_title=bc_title,
                    cand_artist=bc_artist,
                    date_str=bc_date,
                    details="Bandcamp Album-Artwork",
                )

    def _run_itunes() -> None:
        if not search_term or _cancelled():
            return
        regions: list[str] = []
        if "itunes" in active_set:
            regions.append("DE")
        if "itunes_multi_region" in active_set:
            regions.extend(["US", "JP"])
        for country_code in regions:
            if _cancelled():
                return
            try:
                itunes_url = (
                    f"https://itunes.apple.com/search?term={urllib.parse.quote(search_term)}"
                    f"&entity=album&limit=4&country={country_code}"
                )
                req = urllib.request.Request(
                    itunes_url,
                    headers={"User-Agent": USER_AGENT_HEADER},
                )
                with urllib.request.urlopen(req, timeout=7) as resp:
                    idata = json.loads(resp.read().decode("utf-8", errors="replace"))
                for item in (idata.get("results") or [])[:4]:
                    if _cancelled():
                        return
                    art100 = str(item.get("artworkUrl100") or "").strip()
                    if not art100:
                        continue
                    hi_1400 = re.sub(r"100x100bb\.(jpg|jpeg|png)$", r"1400x1400bb.\1", art100, flags=re.I)
                    hi_1000 = re.sub(r"100x100bb\.(jpg|jpeg|png)$", r"1000x1000bb.\1", art100, flags=re.I)
                    i_bytes, i_mime = download_image_url(hi_1400, timeout=7)
                    if not i_bytes:
                        i_bytes, i_mime = download_image_url(hi_1000, timeout=7)
                    if i_bytes:
                        det_parts = [
                            str(item.get("primaryGenreName") or ""),
                            f"Store {country_code}",
                            f"{item.get('trackCount')} Tracks" if item.get("trackCount") else "",
                        ]
                        _add_candidate(
                            i_bytes,
                            i_mime,
                            provider="itunes",
                            provider_label=f"iTunes / Apple ({country_code})",
                            source_label=f"iTunes / Apple Cover ({country_code})",
                            cand_title=str(item.get("collectionName") or clean_title),
                            cand_artist=str(item.get("artistName") or clean_artist),
                            date_str=str(item.get("releaseDate") or "")[:10],
                            details=" · ".join(p for p in det_parts if p),
                        )
            except Exception:
                pass

    def _run_discogs() -> None:
        if _cancelled():
            return
        token = _get_configured_discogs_token(discogs_token)
        if clean_discogs and clean_discogs.isdigit():
            try:
                rel_data = _discogs_get_json(f"releases/{clean_discogs}", discogs_token=token)
                for im in (rel_data.get("images") or [])[:3]:
                    if _cancelled():
                        return
                    img_url = str(im.get("uri") or im.get("resource_url") or "").strip()
                    if not img_url or "spacer.gif" in img_url:
                        continue
                    d_bytes, d_mime = download_image_url(img_url)
                    if d_bytes:
                        _add_candidate(
                            d_bytes,
                            d_mime,
                            provider="discogs",
                            provider_label="Discogs",
                            source_label="Discogs Cover",
                            cand_title=str(rel_data.get("title") or clean_title),
                            cand_artist=clean_artist,
                            date_str=str(rel_data.get("released") or rel_data.get("year") or ""),
                            details=f"Discogs #{clean_discogs}",
                            discogs_val=clean_discogs,
                        )
            except Exception:
                pass

        if (search_term or clean_barcode) and not _cancelled():
            try:
                dg_hits = search_discogs_releases(
                    clean_barcode or search_term,
                    limit=5,
                    discogs_token=token,
                    on_log=on_log,
                )
                for item in dg_hits[:4]:
                    if _cancelled():
                        return
                    raw_id = str(item.get("id") or "").replace("discogs:", "").strip()
                    cover_url = str(item.get("cover_image") or "").strip()
                    if not cover_url and raw_id.isdigit():
                        try:
                            r_json = _discogs_get_json(f"releases/{raw_id}", discogs_token=token)
                            imgs = r_json.get("images") or []
                            if imgs:
                                cover_url = str(imgs[0].get("uri") or imgs[0].get("resource_url") or "")
                        except Exception:
                            pass
                    if cover_url and "spacer.gif" not in cover_url:
                        d_bytes, d_mime = download_image_url(cover_url)
                        if d_bytes:
                            det_parts = [
                                str(item.get("country") or ""),
                                str(item.get("label") or ""),
                                f"#{raw_id}" if raw_id else "",
                            ]
                            _add_candidate(
                                d_bytes,
                                d_mime,
                                provider="discogs",
                                provider_label="Discogs",
                                source_label="Discogs Cover",
                                cand_title=str(item.get("title") or clean_title),
                                cand_artist=str(item.get("artist") or clean_artist),
                                date_str=str(item.get("date") or ""),
                                details=" · ".join(p for p in det_parts if p),
                                discogs_val=raw_id,
                            )
            except Exception:
                pass

    def _run_amazon() -> None:
        if _cancelled():
            return
        amz_bytes, amz_mime, resolved_asin = download_amazon_cover(
            asin=clean_asin,
            artist=clean_artist,
            title=clean_title,
            release_mbid=clean_mbid,
            on_log=on_log,
        )
        if amz_bytes:
            _add_candidate(
                amz_bytes,
                amz_mime,
                provider="amazon",
                provider_label="Amazon",
                source_label=f"Amazon Cover (ASIN {resolved_asin})" if resolved_asin else "Amazon Cover",
                cand_title=clean_title or f"ASIN {resolved_asin}",
                cand_artist=clean_artist or "Amazon Produktbild",
                date_str="",
                details=f"ASIN {resolved_asin}" if resolved_asin else "Amazon",
                asin_val=resolved_asin,
            )

    tasks: list[Callable[[], None]] = []
    if "musicbrainz_caa" in active_set:
        tasks.append(_run_musicbrainz_caa)
    if "musicbrainz_rg_caa" in active_set:
        tasks.append(_run_musicbrainz_rg_caa)
    if "deezer" in active_set:
        tasks.append(_run_deezer)
    if "theaudiodb" in active_set:
        tasks.append(_run_theaudiodb)
    if "bandcamp" in active_set:
        tasks.append(_run_bandcamp)
    if "itunes" in active_set or "itunes_multi_region" in active_set:
        tasks.append(_run_itunes)
    if "discogs" in active_set:
        tasks.append(_run_discogs)
    if "amazon" in active_set:
        tasks.append(_run_amazon)

    if tasks and not _cancelled():
        with ThreadPoolExecutor(max_workers=min(6, len(tasks)), thread_name_prefix="mintrip-cover") as pool:
            futs = [pool.submit(fn) for fn in tasks]
            for f in futs:
                try:
                    f.result()
                except Exception:
                    pass

    _log_step(
        f"[Cover-Suche] Aktivierte Provider abgefragt ({len(active_providers)} Quellen): {len(candidates)} Cover-Treffer gefunden.",
        on_log,
    )
    return candidates


def lookup_cddb_candidates(
    cddb_id: str,
    track_offsets: list[int],
    total_seconds: int,
    on_log: Optional[Callable[[str], None]] = None,
) -> list[dict]:
    """Fragt GnuDB/CDDB per Sektor-TOC ab und gibt ALLE gefundenen Kandidaten (200/210/211) zurück."""
    if not cddb_id or not track_offsets:
        return []

    offsets_str = " ".join(str(o) for o in track_offsets)
    query_cmd = f"cddb query {cddb_id} {len(track_offsets)} {offsets_str} {total_seconds}"
    try:
        lines = _gnudb_request(query_cmd)
    except Exception as exc:
        _log_step(f"[CDDB/GnuDB] Abfragefehler: {exc}", on_log)
        return []

    if not lines:
        return []

    status_line = lines[0].strip()
    code = status_line[:3]
    pairs: list[tuple[str, str]] = []

    if code == "200":
        parts = status_line.split(maxsplit=3)
        if len(parts) >= 3:
            pairs.append((parts[1], parts[2].lower()))
    elif code in ("210", "211") and len(lines) > 1:
        for candidate in lines[1:]:
            if candidate == ".":
                break
            parts = candidate.strip().split(maxsplit=2)
            if len(parts) >= 2:
                pairs.append((parts[0], parts[1].lower()))

    if not pairs:
        return []

    _log_step(f"[CDDB/GnuDB] {len(pairs)} Sektor-TOC-Kandidat(en) gefunden – lese Details...", on_log)
    results: list[dict] = []
    for idx, (category, matched_id) in enumerate(pairs[:6]):
        try:
            read_lines = _gnudb_request(f"cddb read {category} {matched_id}")
            if not read_lines or not read_lines[0].startswith("210"):
                continue

            fields: dict[str, str] = {}
            cover_url_hint = ""
            for line in read_lines[1:]:
                if line == ".":
                    break
                if line.startswith("# Cover:"):
                    cover_url_hint = line.partition(":")[2].strip()
                    continue
                if line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                fields[k] = fields.get(k, "") + v

            dtitle = fields.get("DTITLE", "Unbekannt / Unbekannt")
            artist, _, album_title = dtitle.partition(" / ")
            artist_clean = normalize_multi_artist(artist.strip()) or "Unbekannter Künstler"
            raw_title_clean = (album_title or dtitle).strip() or "Unbekanntes Album"
            title_clean, disc_num, total_discs = _extract_disc_info_from_title(raw_title_clean)

            raw_genre = fields.get("DGENRE", "").strip()
            genre_clean = _parse_cddb_genres(raw_genre)
            if not genre_clean and category and category.lower() not in ("misc", "data"):
                genre_clean = format_multi_genre([category])

            tracks: list[TrackMetadata] = []
            for t_idx in range(len(track_offsets)):
                raw_t = fields.get(f"TTITLE{t_idx}", f"Titel {t_idx + 1:02d}").strip()
                if " / " in raw_t and artist_clean.lower() in ("various", "various artists"):
                    t_artist, _, t_title = raw_t.partition(" / ")
                    tracks.append(
                        TrackMetadata(
                            track_number=t_idx + 1,
                            title=t_title.strip(),
                            artist=normalize_multi_artist(t_artist.strip()),
                            metadata_source="CDDB",
                        )
                    )
                else:
                    tracks.append(
                        TrackMetadata(
                            track_number=t_idx + 1,
                            title=raw_t,
                            artist=artist_clean,
                            metadata_source="CDDB",
                        )
                    )

            year_str = fields.get("DYEAR", "").strip()
            album_obj = AlbumMetadata(
                title=title_clean,
                artist=artist_clean,
                album_artist=artist_clean,
                year=year_str,
                genre=genre_clean,
                disc_number=disc_num,
                total_discs=total_discs,
                cddb_id=matched_id,
                metadata_source=f"CDDB/GnuDB ({category}/{matched_id})",
                tracks=tracks,
            )
            if "coverartarchive.org/release/" in cover_url_hint:
                mbid = cover_url_hint.split("coverartarchive.org/release/")[-1].split("/")[0]
                if mbid:
                    album_obj.musicbrainz_release_id = mbid

            results.append(
                {
                    "id": f"cddb:{category}:{matched_id}",
                    "source": "cddb",
                    "method": "CDDB Sektor-TOC",
                    "title": title_clean,
                    "artist": artist_clean,
                    "date": year_str,
                    "country": "",
                    "label": f"GnuDB ({category})",
                    "catno": matched_id,
                    "barcode": "",
                    "track_count": len(tracks),
                    "medium_count": total_discs,
                    "matched_disc_number": disc_num,
                    "score": max(75, 92 - idx * 3),
                    "cddb_album": album_obj,
                }
            )
        except Exception:
            continue

    return results


def search_all_databases_candidates(
    physical_album: AlbumMetadata,
    query: str = "",
    discogs_token: str = "",
    on_log: Optional[Callable[[str], None]] = None,
) -> list[dict]:
    """
    Fragt ALLE Datenbanken (MusicBrainz, CDDB/GnuDB und Discogs) ohne vorzeitigen Abbruch ab
    und liefert eine zusammengeführte Trefferliste aller Kandidaten zur manuellen Auswahl durch den Benutzer.
    """
    track_count = len(physical_album.tracks)
    track_durations = [max(1, int(t.duration_seconds or 0)) for t in physical_album.tracks]
    disc_id = (physical_album.musicbrainz_disc_id or "").strip()
    toc_string = (physical_album.musicbrainz_toc or "").strip()
    cddb_id = (physical_album.cddb_id or "").strip()
    clean_query = query.strip()

    _log_step(
        f"[Trefferliste] Starte Vollabfrage über alle Datenbanken (MusicBrainz + CDDB/GnuDB + Discogs) "
        f"für {track_count} Tracks (CDDB {cddb_id or '-'} · MB-DiscID {disc_id or '-'})...",
        on_log,
    )

    candidates: list[dict] = []
    seen_keys: set[str] = set()

    def _add_candidate(item: dict) -> None:
        key = f"{item.get('source', 'mb')}:{item.get('id', '')}"
        if not item.get("id") or key in seen_keys:
            return
        seen_keys.add(key)
        # Vollständigkeits-Indikatoren ohne zusätzliche Requests direkt aus Suchdaten ableiten
        badges: list[str] = []
        q_bonus = 0
        c_genres = item.get("genres") or []
        if isinstance(c_genres, list) and c_genres:
            lbl = "Styles" if item.get("source") == "discogs" else "Genres"
            badges.append(f"{lbl} ({len(c_genres)})")
            q_bonus += 18
        if item.get("barcode"):
            badges.append("Barcode")
            q_bonus += 8
        if item.get("label") or item.get("catno"):
            badges.append("Label")
            q_bonus += 6
        if item.get("has_cover"):
            badges.append("Cover")
            q_bonus += 6
        if track_count > 0 and int(item.get("track_count") or 0) == track_count:
            badges.append("Exakte Tracks")
            q_bonus += 12
        item["quality_badges"] = badges
        item["quality_score"] = min(100, int(item.get("score") or 60) + (q_bonus // 3))
        candidates.append(item)

    # 1.0 Fast-Path: Vorhandene MUSICBRAINZ_ALBUMID aus lokalen Dateien direkt in 1 Request (oder 0ms Cache) laden
    existing_mbid = str(getattr(physical_album, "musicbrainz_release_id", "") or "").strip()
    mb_fastpath_hit = False
    if existing_mbid and _UUID_RE.match(existing_mbid) and not clean_query:
        try:
            _log_step(f"[Fast-Path] Nutze gespeicherte MusicBrainz Release-ID {existing_mbid} (1 Request / Cache)...", on_log)
            rel = _mb_ws2_get_json(
                f"release/{urllib.parse.quote(existing_mbid)}?inc=artists+labels+recordings+release-groups+genres+tags&fmt=json",
                on_log=on_log,
                timeout=16,
                max_retries=2,
            )
            if isinstance(rel, dict) and rel.get("id"):
                media_list = [m for m in (rel.get("media") or []) if isinstance(m, dict)]
                matching_med = _as_dict(_select_medium(media_list, match_disc_id=disc_id, match_track_count=track_count))
                total_mb_tracks = sum(int(m.get("track-count") or len(m.get("tracks") or [])) for m in media_list)
                label_list = [li for li in (rel.get("label-info") or []) if isinstance(li, dict)]
                first_label = next(
                    (str(_as_dict(li.get("label")).get("name") or "").strip() for li in label_list if _as_dict(li.get("label")).get("name")),
                    "",
                )
                first_catno = next(
                    (str(li.get("catalog-number") or "").strip() for li in label_list if li.get("catalog-number")),
                    "",
                )
                fp_genres = [
                    g.strip()
                    for g in _extract_musicbrainz_genres(rel).split(";")
                    if g.strip()
                ]
                _add_candidate(
                    {
                        "id": str(rel.get("id")),
                        "source": "musicbrainz",
                        "method": "Gespeicherte MBID (Fast-Path)",
                        "title": str(rel.get("title") or "Unbekanntes Album"),
                        "artist": _format_artist_credit(rel.get("artist-credit", [])) or "Unbekannt",
                        "date": str(rel.get("date") or ""),
                        "country": str(rel.get("country") or ""),
                        "label": first_label,
                        "catno": first_catno,
                        "barcode": str(rel.get("barcode") or ""),
                        "track_count": total_mb_tracks,
                        "medium_count": max(1, len(media_list)),
                        "matched_disc_number": int(matching_med.get("position") or 1) if matching_med else 1,
                        "genres": fp_genres[:4],
                        "has_cover": bool(_as_dict(rel.get("cover-art-archive")).get("front")),
                        "score": 100,
                    }
                )
                mb_fastpath_hit = True
        except Exception as fp_exc:
            _log_step(f"[Fast-Path] Direkter MBID-Abruf nicht erfolgreich ({fp_exc}) – fahre mit regulärer Suche fort.", on_log)

    # 1A. MusicBrainz DiscID & Fuzzy-Sektor-TOC (überspringen wenn Fast-Path bereits getroffen hat)
    if (disc_id or toc_string) and not mb_fastpath_hit:
        raw_toc_rels: list[dict] = []
        if disc_id and disc_id != "-":
            try:
                _log_step(f"[1/3 MusicBrainz] Prüfe DiscID {disc_id} + Sektor-TOC...", on_log)
                q_str = (
                    f"?toc={urllib.parse.quote(toc_string)}&inc=artists+labels+recordings+release-groups&cdstubs=no&fmt=json"
                    if toc_string
                    else "?inc=artists+labels+recordings+release-groups&fmt=json"
                )
                data = _mb_ws2_get_json(f"discid/{urllib.parse.quote(disc_id)}{q_str}", on_log=on_log)
                if isinstance(data, dict):
                    raw_toc_rels.extend(
                        r for r in (data.get("releases") or data.get("release-list") or []) if isinstance(r, dict)
                    )
            except Exception:
                pass

        # Fuzzy-Sektor-TOC nur als Fallback ausführen, falls exakte DiscID noch keinen Treffer lieferte!
        if toc_string and not raw_toc_rels:
            try:
                _log_step(f"[1/3 MusicBrainz] Prüfe Fuzzy-Sektor-TOC ({track_count or '?'} Tracks, alle Medien)...", on_log)
                data = _mb_ws2_get_json(
                    f"discid/-?toc={urllib.parse.quote(toc_string)}&inc=artists+labels+recordings+release-groups&media-format=all&fmt=json",
                    on_log=on_log,
                )
                if isinstance(data, dict):
                    raw_toc_rels.extend(
                        r for r in (data.get("releases") or data.get("release-list") or []) if isinstance(r, dict)
                    )
                    if isinstance(data.get("cdstub"), dict):
                        stub = data["cdstub"]
                        s_art = str(stub.get("artist") or "").strip()
                        s_tit = str(stub.get("title") or "").strip()
                        if s_art and s_tit and not clean_query:
                            clean_query = f"{s_art} {s_tit}".strip()
            except Exception:
                pass

        for idx, rel in enumerate(raw_toc_rels):
            if not isinstance(rel, dict):
                continue
            try:
                rid = str(rel.get("id") or "").strip()
                if not rid:
                    continue
                media_list = [m for m in (rel.get("media") or rel.get("medium-list") or []) if isinstance(m, dict)]
                dur_score = _score_release_duration_match(rel, track_durations, track_count)
                if track_count > 0 and dur_score < 0 and not clean_query:
                    continue
                matching_med = _select_medium(media_list, match_disc_id=disc_id, match_track_count=track_count)
                med_dict = _as_dict(matching_med)
                med_tracks = int(med_dict.get("track-count") or len(med_dict.get("tracks") or []) or track_count or 0)
                total_mb_tracks = (
                    sum(int(m.get("track-count") or len(m.get("tracks") or []) or 0) for m in media_list)
                    or int(rel.get("track-count") or 0)
                    or med_tracks
                )
                label_list = [li for li in (rel.get("label-info") or []) if isinstance(li, dict)]
                first_label = next(
                    (
                        str(_as_dict(li.get("label")).get("name") or "").strip()
                        for li in label_list
                        if _as_dict(li.get("label")).get("name")
                    ),
                    "",
                )
                first_catno = next(
                    (
                        str(li.get("catalog-number") or "").strip()
                        for li in label_list
                        if li.get("catalog-number")
                    ),
                    "",
                )
                _add_candidate(
                    {
                        "id": rid,
                        "source": "musicbrainz",
                        "method": "TOC / DiscID",
                        "title": str(rel.get("title") or "Unbekanntes Album"),
                        "artist": _format_artist_credit(rel.get("artist-credit", [])) or "Unbekannt",
                        "date": str(rel.get("date") or ""),
                        "country": str(rel.get("country") or ""),
                        "label": first_label,
                        "catno": first_catno,
                        "barcode": str(rel.get("barcode") or ""),
                        "track_count": total_mb_tracks,
                        "medium_count": max(1, len(media_list)),
                        "matched_disc_number": int(med_dict.get("position") or 1) if med_dict else 1,
                        "score": max(60, min(100, int(round(dur_score if dur_score > 0 else 95 - idx * 2)))),
                    }
                )
            except Exception as rel_exc:
                _log_step(f"[1/3 MusicBrainz] Überspringe unvollständigen TOC-Treffer ({rel_exc}).", on_log)

    # 2. CDDB / GnuDB Sektor-TOC-Abfrage (liefert alle Treffer + Hinweis für Textsuche, falls noch kein Albumtitel bekannt ist)
    discovered_hint = clean_query
    if not discovered_hint:
        art_raw = (physical_album.album_artist or physical_album.artist or "").strip()
        tit_raw = (physical_album.title or "").strip()
        if (
            tit_raw
            and tit_raw
            not in (
                "Unbekanntes Album",
                "Audio-CD (Lokal ausgelesen)",
                "Importierte Audiodateien",
                "Importiertes Album",
                "Lokaler Datei-Import (Virtuelle TOC)",
            )
        ):
            discovered_hint = (
                f"{art_raw} {tit_raw}".strip()
                if art_raw and art_raw != "Unbekannter Künstler"
                else tit_raw
            )

    if cddb_id and physical_album.track_offsets:
        total_secs = max(1, physical_album.leadout_offset // 75)
        _log_step(
            f"[2/3 CDDB/GnuDB] Frage GnuDB nach DiscID {cddb_id} ({track_count} Tracks, {total_secs}s) ab...",
            on_log,
        )
        cddb_cands = lookup_cddb_candidates(
            cddb_id,
            physical_album.track_offsets,
            total_secs,
            on_log=on_log,
        )
        for cc in cddb_cands:
            _add_candidate(cc)
            if not discovered_hint and cc.get("artist") and cc.get("title"):
                if cc["artist"] != "Unbekannter Künstler" and cc["title"] != "Unbekanntes Album":
                    discovered_hint = f"{cc['artist']} {cc['title']}".strip()
                    _log_step(
                        f"[2/3 CDDB/GnuDB] Nutze erkannten Titel „{discovered_hint}“ zusätzlich für MusicBrainz & Discogs...",
                        on_log,
                    )

    # 1B. MusicBrainz Text- / Barcode- / Multi-Signal-Suche
    parsed_clean_q = parse_barcode_or_qr_payload(clean_query) if clean_query else {"kind": "empty"}
    search_terms: list[tuple[str, str]] = []
    if clean_query and parsed_clean_q.get("kind") != "discogs_id":
        search_terms.append((clean_query, "Suche / Barcode"))
    elif not clean_query and physical_album.barcode:
        search_terms.append((physical_album.barcode.strip(), "Barcode / EAN"))

    if (
        discovered_hint
        and parsed_clean_q.get("kind") != "discogs_id"
        and all(discovered_hint.lower() != q.lower() for q, _ in search_terms)
    ):
        if track_count > 0:
            search_terms.append(
                (f"{discovered_hint} AND (tracks:{track_count} OR tracksmedium:{track_count})", "Multi-Signal + Tracks")
            )
        search_terms.append((discovered_hint, "Album-/Ordner-Suche"))

    # Maximal 2 gezielte MusicBrainz-Suchanfragen mit Early-Exit bei starkem Treffer (spart Rate-Limits!)
    if not mb_fastpath_hit and not is_musicbrainz_circuit_open():
        for q_term, method_lbl in search_terms[:2]:
            try:
                _log_step(f"[1/3 MusicBrainz] Suche Releases für „{q_term}“ ({method_lbl})...", on_log)
                mb_hits = search_musicbrainz_releases(q_term, limit=12, on_log=on_log)
                strong_hit_found = False
                for idx, h in enumerate(mb_hits):
                    if not isinstance(h, dict):
                        continue
                    hid = str(h.get("id") or "").strip()
                    if not hid:
                        continue
                    h_media = [m for m in (h.get("media") or []) if isinstance(m, dict)]
                    matching_med = _as_dict(_select_medium(h_media, match_disc_id=disc_id, match_track_count=track_count))
                    med_tracks = int(
                        matching_med.get("track-count")
                        or h.get("track_count")
                        or 0
                    )
                    total_mb_tracks = (
                        sum(int(m.get("track-count") or 0) for m in h_media)
                        or int(h.get("track_count") or 0)
                        or med_tracks
                    )
                    base_score = int(h.get("score") or max(55, 92 - idx * 3))
                    exact_track_match = track_count > 0 and (med_tracks == track_count or total_mb_tracks == track_count)
                    if exact_track_match:
                        base_score = min(100, base_score + 6)
                    if base_score >= 95 and (exact_track_match or track_count <= 0):
                        strong_hit_found = True
                    _add_candidate(
                        {
                            "id": hid,
                            "source": "musicbrainz",
                            "method": method_lbl,
                            "title": str(h.get("title") or "Unbekannt"),
                            "artist": str(h.get("artist") or "Unbekannt"),
                            "date": str(h.get("date") or ""),
                            "country": str(h.get("country") or ""),
                            "label": str(h.get("label") or ""),
                            "catno": str(h.get("catno") or ""),
                            "barcode": str(h.get("barcode") or ""),
                            "track_count": total_mb_tracks,
                            "medium_count": max(1, int(h.get("medium_count") or len(h_media) or 1)),
                            "matched_disc_number": int(matching_med.get("position") or 1) if matching_med else 1,
                            "genres": h.get("genres") or [],
                            "has_cover": bool(h.get("has_cover")),
                            "score": base_score,
                        }
                    )
                if strong_hit_found:
                    break
            except Exception as exc:
                _log_step(f"[1/3 MusicBrainz] Hinweis bei Release-Suche: {exc}", on_log)
                if is_musicbrainz_circuit_open():
                    break

    # 3. Discogs Suche (über Suchbegriff, Discogs-Code [r524030], Barcode oder über erkannte MusicBrainz/CDDB-Kandidaten)
    discogs_query = clean_query or physical_album.barcode.strip() or discovered_hint
    if not discogs_query and candidates:
        top_c = candidates[0]
        if top_c.get("artist") and top_c.get("title"):
            discogs_query = f"{top_c['artist']} {top_c['title']}".strip()

    if discogs_query:
        try:
            is_direct_discogs = parse_barcode_or_qr_payload(discogs_query).get("kind") == "discogs_id"
            _log_step(f"[3/3 Discogs] Suche Releases für „{discogs_query}“...", on_log)
            dg_hits = search_discogs_releases(
                discogs_query,
                limit=8,
                discogs_token=discogs_token,
                on_log=on_log,
                expected_track_count=track_count,
            )
            for idx, dh in enumerate(dg_hits):
                did = str(dh.get("id") or "").strip()
                if not did:
                    continue
                dg_genres = filter_subgenres(list(dh.get("genres") or []), max_items=4)
                _add_candidate(
                    {
                        "id": did,
                        "source": "discogs",
                        "method": "Discogs Release-Code" if is_direct_discogs else "Discogs-Suche",
                        "title": str(dh.get("title") or "Unbekannt"),
                        "artist": str(dh.get("artist") or "Unbekannt"),
                        "date": str(dh.get("date") or ""),
                        "country": str(dh.get("country") or ""),
                        "label": str(dh.get("label") or ""),
                        "catno": str(dh.get("catno") or ""),
                        "barcode": str(dh.get("barcode") or ""),
                        "track_count": int(dh.get("track_count") or 0),
                        "medium_count": max(1, int(dh.get("medium_count") or 1)),
                        "matched_disc_number": 1,
                        "genres": dg_genres,
                        "has_cover": bool(dh.get("cover_url") or dh.get("thumb")),
                        "score": 100 if is_direct_discogs else max(55, 90 - idx * 4),
                    }
                )
        except Exception as exc:
            _log_step(f"[3/3 Discogs] Hinweis bei Discogs-Suche: {exc}", on_log)

    if track_count > 0:
        before_count = len(candidates)
        candidates = [
            c
            for c in candidates
            if matches_source_track_count_rule(
                int(c.get("track_count") or 0),
                int(c.get("medium_count") or 1),
                track_count,
            )
        ]
        filtered_out = before_count - len(candidates)
        if filtered_out > 0:
            _log_step(
                f"[Trefferfilter] {filtered_out} Album-Kandidat(en) mit unpassender Trackanzahl ausgeblendet "
                f"(nur >= {track_count} Titel; > {track_count} nur bei Multi-CDs).",
                on_log,
            )

    candidates.sort(
        key=lambda c: (int(c.get("quality_score") or c.get("score") or 0), len(c.get("genres") or []), int(c.get("score") or 0)),
        reverse=True,
    )
    _log_step(
        f"[Trefferliste] {len(candidates)} passende Alben in MusicBrainz, CDDB und Discogs gefunden. "
        f"Sortiert nach Trefferqualität & Vollständigkeit (Genres/Styles, Barcode, Label).",
        on_log,
    )
    return candidates


def _norm_track_match_title(title: str) -> str:
    txt = unicodedata.normalize("NFKD", str(title or "").lower())
    txt = "".join(ch for ch in txt if not unicodedata.combining(ch))
    txt = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", txt)
    txt = re.sub(r"[^a-z0-9]+", " ", txt).strip()
    return txt


def _has_specific_genre(genre_str: str) -> bool:
    parts = [p.strip().lower() for p in re.split(r"[;,]+", str(genre_str or "")) if p.strip()]
    return any(p not in _BROAD_UMBRELLA_GENRES for p in parts)


def fetch_lastfm_top_tags(
    artist: str,
    track_title: str = "",
    album_title: str = "",
    api_key: str = "",
) -> list[str]:
    """Fragt Last.fm track.getTopTags / album.getTopTags (gecacht, streng gegen Musikgenre-Whitelist gefiltert) ab."""
    key = _get_configured_lastfm_api_key(api_key)
    clean_artist = str(artist or "").split(";")[0].strip()
    if not key or not clean_artist:
        return []
    method = "track.getTopTags" if track_title.strip() else "album.getTopTags"
    cache_key = f"lastfm:{method}:{clean_artist.lower()}:{track_title.strip().lower()}:{album_title.strip().lower()}"
    cached = _cache_get_json(cache_key)
    if isinstance(cached, list):
        return [str(x) for x in cached if x]

    params = {
        "method": method,
        "artist": clean_artist,
        "api_key": key,
        "autocorrect": "1",
        "format": "json",
    }
    if track_title.strip():
        params["track"] = track_title.strip()
    elif album_title.strip():
        params["album"] = album_title.strip()
    else:
        return []

    url = f"{LASTFM_API_BASE}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": f"{USER_AGENT_APP}/{USER_AGENT_VERSION} ({USER_AGENT_CONTACT})",
            "Accept": "application/json",
        },
    )
    tags: list[str] = []
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
        raw_tags = _as_dict(_as_dict(data).get("toptags")).get("tag") or []
        if isinstance(raw_tags, dict):
            raw_tags = [raw_tags]
        for item in raw_tags:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            count = int(item.get("count") or 0)
            if count < 5 and len(tags) >= 3:
                continue
            if is_valid_music_genre_tag(name, artist_name=clean_artist, album_title=album_title):
                tags.append(name)
    except Exception:
        return []

    filtered = filter_subgenres(tags, max_items=5)
    _cache_set_json(cache_key, filtered, ttl_sec=86400 * 30)
    return filtered


def _fetch_discogs_styles_for_album(
    album: AlbumMetadata,
    discogs_token: str = "",
    on_log: Optional[Callable[[str], None]] = None,
) -> list[str]:
    """Ermittelt präzise Discogs-Styles (Subgenres) über Master/Release-ID oder schnelle Suche (gecacht)."""
    styles: list[str] = []
    did = re.sub(r"^discogs:", "", str(album.discogs_release_id or "").strip(), flags=re.IGNORECASE)
    if did and did.isdigit():
        try:
            rel_data = _discogs_get_json(f"releases/{did}", discogs_token=discogs_token, on_log=on_log)
            styles.extend(str(s) for s in (rel_data.get("styles") or []) if s)
            if not styles:
                styles.extend(str(g) for g in (rel_data.get("genres") or []) if g)
            master_id = rel_data.get("master_id")
            if master_id:
                m_data = _discogs_get_json(f"masters/{master_id}", discogs_token=discogs_token, on_log=on_log)
                styles.extend(str(s) for s in (m_data.get("styles") or []) if s)
                if not styles:
                    styles.extend(str(g) for g in (m_data.get("genres") or []) if g)
        except Exception:
            pass

    if not styles and album.title:
        q = f"{album.album_artist or album.artist} {album.title}".strip()
        try:
            q_params = urllib.parse.urlencode({"q": q, "type": "master", "per_page": "3"})
            s_data = _discogs_get_json(f"database/search?{q_params}", discogs_token=discogs_token, on_log=on_log)
            for res in (s_data.get("results") or [])[:2]:
                if not isinstance(res, dict):
                    continue
                styles.extend(str(s) for s in (res.get("style") or []) if s)
                if not styles:
                    styles.extend(str(g) for g in (res.get("genre") or []) if g)
                if styles:
                    break
        except Exception:
            pass

    return filter_subgenres(styles, max_items=5)


def enrich_album_track_genres(
    album: AlbumMetadata,
    discogs_token: str = "",
    lastfm_api_key: str = "",
    prefer_subgenres: Optional[bool] = None,
    on_log: Optional[Callable[[str], None]] = None,
) -> dict:
    """Reichert fehlende/zu allgemeine Track-Genres blitzschnell aus MusicBrainz Release-Group-Auflagen, Discogs-Styles, Last.fm & Wikidata an."""
    pref = _get_configured_bool_setting("prefer_subgenres", True, explicit=prefer_subgenres)
    updated_tracks = 0
    sources_used: list[str] = []

    def _needs_enrichment(trk: TrackMetadata) -> bool:
        g = str(trk.genre or "").strip()
        if not g:
            return True
        if pref and not _has_specific_genre(g):
            return True
        return False

    missing_tracks = [t for t in album.tracks if _needs_enrichment(t)]
    if not missing_tracks and _has_specific_genre(album.genre):
        return {"updated_tracks": 0, "album_genre": album.genre, "sources": []}

    _log_step(
        f"[Genre-Anreicherung] Prüfe {len(missing_tracks)}/{len(album.tracks)} Titel auf spezifische Subgenres...",
        on_log,
    )

    # 1. Cross-Pressing-Abgleich in derselben MusicBrainz Release-Group (behält die gewählte Pressung 100% bei!)
    rg_id = str(getattr(album, "musicbrainz_release_group_id", "") or "").strip()
    cur_rel_id = str(getattr(album, "musicbrainz_release_id", "") or "").strip()
    if missing_tracks and rg_id and _UUID_RE.match(rg_id) and not is_musicbrainz_circuit_open():
        try:
            rg_data = _mb_ws2_get_json(
                f"release-group/{urllib.parse.quote(rg_id)}?inc=releases+genres+tags&fmt=json",
                on_log=on_log,
                timeout=14,
                max_retries=1,
            )
            rg_genres = _extract_musicbrainz_genres({"release-group": rg_data}, prefer_subgenres=pref)
            if rg_genres:
                album.genre = merge_genre_strings(album.genre, rg_genres, prefer_subgenres=pref, max_items=6)

            sibling_rels = [
                r
                for r in (rg_data.get("releases") or [])
                if isinstance(r, dict) and str(r.get("id") or "") != cur_rel_id
            ]
            # Bevorzuge älteste offizielle Pressungen (oft am besten getaggt)
            sibling_rels.sort(
                key=lambda r: (
                    0 if str(r.get("status") or "").lower() == "official" else 1,
                    str(r.get("date") or "9999"),
                )
            )
            for sib in sibling_rels[:2]:
                sib_id = str(sib.get("id") or "").strip()
                if not sib_id or is_musicbrainz_circuit_open():
                    continue
                sib_full = _mb_ws2_get_json(
                    f"release/{urllib.parse.quote(sib_id)}?inc=recordings+genres+tags&fmt=json",
                    on_log=on_log,
                    timeout=14,
                    max_retries=1,
                )
                title_to_genre: dict[str, str] = {}
                pos_to_genre: dict[int, str] = {}
                for med in sib_full.get("media") or []:
                    if not isinstance(med, dict):
                        continue
                    for idx, trk in enumerate(med.get("tracks") or []):
                        if not isinstance(trk, dict):
                            continue
                        rec = _as_dict(trk.get("recording"))
                        rg_str = _extract_recording_genres(rec, prefer_subgenres=pref)
                        if not rg_str:
                            continue
                        norm_t = _norm_track_match_title(str(trk.get("title") or rec.get("title") or ""))
                        if norm_t and norm_t not in title_to_genre:
                            title_to_genre[norm_t] = rg_str
                        pos = int(trk.get("position") or idx + 1)
                        if pos not in pos_to_genre:
                            pos_to_genre[pos] = rg_str

                if title_to_genre or pos_to_genre:
                    hit_in_sib = 0
                    for trk in album.tracks:
                        if not _needs_enrichment(trk):
                            continue
                        matched_g = title_to_genre.get(_norm_track_match_title(trk.title)) or pos_to_genre.get(trk.track_number, "")
                        if matched_g:
                            trk.genre = merge_genre_strings(trk.genre, matched_g, prefer_subgenres=pref, max_items=5)
                            updated_tracks += 1
                            hit_in_sib += 1
                    if hit_in_sib > 0:
                        sources_used.append("MusicBrainz Release-Group")
                        _log_step(
                            f"[Genre-Anreicherung] {hit_in_sib} Track-Genres aus Referenz-Auflage derselben Release-Group übernommen.",
                            on_log,
                        )
                        break
        except Exception as rg_exc:
            _log_step(f"[Genre-Anreicherung] Release-Group-Abgleich übersprungen ({rg_exc}).", on_log)

    # 2. Last.fm Track-TopTags (parallel & sehr schnell für liedspezifische Subgenres, sofern API-Key gesetzt)
    lfm_key = _get_configured_lastfm_api_key(lastfm_api_key)
    still_missing = [t for t in album.tracks if _needs_enrichment(t)]
    if still_missing and lfm_key:
        _log_step(
            f"[Genre-Anreicherung] Frage Last.fm Track-Subgenres für {len(still_missing)} Titel parallel ab...",
            on_log,
        )
        lfm_hits = 0

        def _fetch_one_lfm(trk: TrackMetadata) -> tuple[TrackMetadata, list[str]]:
            art = trk.artist or album.album_artist or album.artist
            return trk, fetch_lastfm_top_tags(art, track_title=trk.title, album_title=album.title, api_key=lfm_key)

        with ThreadPoolExecutor(max_workers=4) as pool:
            for trk, lfm_tags in pool.map(_fetch_one_lfm, still_missing):
                if lfm_tags:
                    trk.genre = merge_genre_strings(trk.genre, lfm_tags, prefer_subgenres=pref, max_items=5)
                    updated_tracks += 1
                    lfm_hits += 1

        if lfm_hits > 0:
            sources_used.append("Last.fm Track-Tags")
            _log_step(f"[Genre-Anreicherung] Last.fm lieferte präzise Subgenres für {lfm_hits} Titel.", on_log)

        # Album-TopTags als zusätzlicher Subgenre-Pool
        lfm_alb_tags = fetch_lastfm_top_tags(
            album.album_artist or album.artist,
            album_title=album.title,
            api_key=lfm_key,
        )
        if lfm_alb_tags:
            album.genre = merge_genre_strings(album.genre, lfm_alb_tags, prefer_subgenres=pref, max_items=6)

    # 3. Discogs Master/Release Styles (präzise Subgenres statt Verallgemeinerungen)
    still_missing = [t for t in album.tracks if _needs_enrichment(t)]
    if still_missing or not _has_specific_genre(album.genre):
        dg_styles = _fetch_discogs_styles_for_album(album, discogs_token=discogs_token, on_log=on_log)
        if dg_styles:
            album.genre = merge_genre_strings(album.genre, dg_styles, prefer_subgenres=pref, max_items=6)
            sources_used.append("Discogs Styles")
            _log_step(f"[Genre-Anreicherung] Discogs-Styles ergänzt: {'; '.join(dg_styles)}.", on_log)

    # 4. Album-Subgenres sauber auf verbleibende Tracks ohne eigenes Genre vererben + ggf. Album-Genre aus Track-Genres verdichten
    if not _has_specific_genre(album.genre):
        track_pool = [t.genre for t in album.tracks if t.genre]
        if track_pool:
            album.genre = merge_genre_strings(album.genre, *track_pool, prefer_subgenres=pref, max_items=6)

    if album.genre:
        for trk in album.tracks:
            if not str(trk.genre or "").strip() or (pref and not _has_specific_genre(trk.genre) and _has_specific_genre(album.genre)):
                trk.genre = merge_genre_strings(trk.genre, album.genre, prefer_subgenres=pref, max_items=5)
                updated_tracks += 1

    return {
        "updated_tracks": updated_tracks,
        "album_genre": album.genre,
        "sources": sources_used,
    }


def load_selected_candidate_metadata(
    candidate: dict,
    physical_album: Optional[AlbumMetadata] = None,
    on_log: Optional[Callable[[str], None]] = None,
    enabled_cover_providers: Optional[list[str]] = None,
    discogs_token: str = "",
) -> AlbumMetadata:
    """Lädt das vom Benutzer in der Trefferliste ausgewählte Album vollständig in die Arbeitsfläche."""
    active_cov_list = normalize_cover_providers(
        DEFAULT_COVER_PROVIDERS if enabled_cover_providers is None else enabled_cover_providers
    )
    active_cov_set = set(active_cov_list)
    source = str(candidate.get("source") or "musicbrainz").lower()
    cid = str(candidate.get("id") or "").strip()
    disc_num = int(candidate.get("matched_disc_number") or 1)
    track_count = len(physical_album.tracks) if physical_album else 0
    disc_id = physical_album.musicbrainz_disc_id if physical_album else ""
    if physical_album and physical_album.tracks:
        local_discs = {max(1, getattr(t, "disc_number", 1) or 1) for t in physical_album.tracks if t.source_file}
        if len(local_discs) > 1:
            disc_num = 0  # Alle CDs laden, damit Multi-CD-Ordner komplett abgedeckt bleiben

    def _fill_cover_from_enabled_providers(alb: AlbumMetadata) -> AlbumMetadata:
        if alb.cover_art_bytes or not active_cov_list:
            return alb
        try:
            cov_cands = search_all_cover_candidates(
                artist=alb.album_artist or alb.artist,
                title=alb.title,
                release_mbid=alb.musicbrainz_release_id,
                release_group_mbid=getattr(alb, "musicbrainz_release_group_id", ""),
                discogs_id=alb.discogs_release_id,
                asin=alb.asin,
                barcode=alb.barcode,
                discogs_token=discogs_token,
                on_log=on_log,
                enabled_providers=active_cov_list,
            )
            if cov_cands:
                first_cov = cov_cands[0]
                alb.cover_art_bytes = first_cov.get("image_bytes")
                alb.cover_art_mime = str(first_cov.get("mime") or "image/jpeg")
                alb.cover_art_source = str(first_cov.get("source_label") or first_cov.get("provider_label") or "Online-Cover")
        except Exception:
            pass
        return alb

    if source == "discogs":
        clean_id = re.sub(r"^discogs:", "", cid, flags=re.IGNORECASE)
        disc_txt = "alle CDs" if disc_num == 0 else f"CD {disc_num}"
        _log_step(f"[Auswahl → Discogs] Lade vollständiges Release #{clean_id} ({disc_txt})...", on_log)
        details = fetch_discogs_release_details(
            clean_id,
            disc_number=disc_num,
            match_track_count=track_count,
            enabled_cover_providers=active_cov_list,
            on_log=on_log,
        )
        resolved = _preserve_physical_toc(details, physical_album) if physical_album else details
        if _get_configured_bool_setting("auto_enrich_track_genres", True):
            enrich_album_track_genres(resolved, discogs_token=discogs_token, on_log=on_log)
        return _fill_cover_from_enabled_providers(resolved)

    if source == "cddb":
        _log_step(f"[Auswahl → CDDB/GnuDB] Lade CDDB-Eintrag {cid}...", on_log)
        cddb_album: Optional[AlbumMetadata] = candidate.get("cddb_album")
        if cddb_album is None and physical_album and physical_album.cddb_id and physical_album.track_offsets:
            total_secs = max(1, physical_album.leadout_offset // 75)
            cddb_album = lookup_cddb_metadata(
                physical_album.cddb_id,
                physical_album.track_offsets,
                total_secs,
            )
        if cddb_album is None:
            raise RuntimeError(f"CDDB-Eintrag {cid} konnte nicht geladen werden.")

        resolved = _preserve_physical_toc(cddb_album, physical_album) if physical_album else cddb_album
        wd_genres = fetch_wikidata_genres(
            artist_name=resolved.album_artist or resolved.artist,
            album_title=resolved.title,
        )
        if wd_genres:
            resolved.genre = merge_genre_strings(resolved.genre, wd_genres, max_items=7)
        if _get_configured_bool_setting("auto_enrich_track_genres", True):
            enrich_album_track_genres(resolved, discogs_token=discogs_token, on_log=on_log)
        if not resolved.cover_art_bytes and resolved.musicbrainz_release_id and "musicbrainz_caa" in active_cov_set:
            c_bytes, c_mime = download_cover_art(resolved.musicbrainz_release_id, on_log=on_log)
            if c_bytes:
                resolved.cover_art_bytes = c_bytes
                resolved.cover_art_mime = c_mime
                resolved.cover_art_source = "Cover Art Archive (via GnuDB)"
        return _fill_cover_from_enabled_providers(resolved)

    disc_txt = "alle CDs" if disc_num == 0 else f"CD {disc_num}"
    _log_step(f"[Auswahl → MusicBrainz] Lade vollständiges Release {cid} ({disc_txt})...", on_log)
    details = fetch_musicbrainz_release_details(
        cid,
        disc_number=disc_num,
        match_disc_id=disc_id,
        match_track_count=track_count,
        enabled_cover_providers=active_cov_list,
        on_log=on_log,
    )
    resolved = _preserve_physical_toc(details, physical_album) if physical_album else details
    if _get_configured_bool_setting("auto_enrich_track_genres", True):
        enrich_album_track_genres(resolved, discogs_token=discogs_token, on_log=on_log)
    return _fill_cover_from_enabled_providers(resolved)


_PREVIEW_TRACKLIST_CACHE: dict[str, dict] = {}
_PREVIEW_COVER_CACHE: dict[str, Optional[bytes]] = {}


def fetch_preview_cover_thumbnail(cover_url: str, timeout: int = 7) -> Optional[bytes]:
    """Lädt optional ein kompaktes Cover-Vorschaubild (zwischengespeichert) ohne die Metadaten-Vorschau zu blockieren."""
    url = str(cover_url or "").strip()
    if not url:
        return None
    if url in _PREVIEW_COVER_CACHE:
        return _PREVIEW_COVER_CACHE[url]
    img_bytes, _mime = download_image_url(url, timeout=timeout)
    if len(_PREVIEW_COVER_CACHE) >= 100:
        first_key = next(iter(_PREVIEW_COVER_CACHE), None)
        if first_key is not None:
            _PREVIEW_COVER_CACHE.pop(first_key, None)
    _PREVIEW_COVER_CACHE[url] = img_bytes
    return img_bytes


def fetch_candidate_tracklist_preview(
    candidate: dict,
    discogs_token: str = "",
) -> dict:
    """Lädt schnell & zwischengespeichert Album-Details + Trackliste eines Trefferlisten-Albums für linke & rechte Vorschau-Spalte."""
    source = str(candidate.get("source") or "musicbrainz").strip().lower()
    cid = str(candidate.get("id") or "").strip()
    cache_key = f"{source}:{cid}"
    if cache_key in _PREVIEW_TRACKLIST_CACHE:
        return _PREVIEW_TRACKLIST_CACHE[cache_key]

    def _fmt_dur(sec: int) -> str:
        s = max(0, int(sec or 0))
        if s <= 0:
            return "--:--"
        return f"{s // 60:02d}:{s % 60:02d}"

    result: dict = {
        "title": str(candidate.get("title") or ""),
        "artist": str(candidate.get("artist") or ""),
        "album_artist": str(candidate.get("artist") or ""),
        "date": str(candidate.get("date") or ""),
        "original_date": "",
        "country": str(candidate.get("country") or ""),
        "status": "",
        "barcode": str(candidate.get("barcode") or ""),
        "asin": "",
        "label": str(candidate.get("label") or ""),
        "catalog_number": str(candidate.get("catno") or ""),
        "genre": "",
        "release_type": "",
        "media_format": "CD",
        "disambiguation": "",
        "language": "",
        "source_id": cid,
        "cover_url": "",
        "total_discs": 1,
        "tracks": [],
    }

    if source == "cddb":
        cddb_album: Optional[AlbumMetadata] = candidate.get("cddb_album")
        if cddb_album is not None:
            result["title"] = cddb_album.title or result["title"]
            result["artist"] = cddb_album.artist or result["artist"]
            result["album_artist"] = cddb_album.album_artist or result["artist"]
            result["date"] = str(getattr(cddb_album, "year", "") or result["date"])
            result["genre"] = str(getattr(cddb_album, "genre", "") or "")
            result["release_type"] = "CDDB / GnuDB"
            result["media_format"] = "CD"
            result["total_discs"] = max(1, int(getattr(cddb_album, "total_discs", 1) or 1))
            for idx, trk in enumerate(cddb_album.tracks or [], start=1):
                dur_s = int(getattr(trk, "duration_seconds", 0) or 0)
                result["tracks"].append(
                    {
                        "disc_number": max(1, int(getattr(trk, "disc_number", 1) or 1)),
                        "disc_subtitle": str(getattr(trk, "disc_subtitle", "") or ""),
                        "track_number": int(getattr(trk, "track_number", idx) or idx),
                        "title": str(getattr(trk, "title", "") or f"Titel {idx}"),
                        "artist": str(getattr(trk, "artist", "") or result["artist"]),
                        "duration_seconds": dur_s,
                        "duration_formatted": _fmt_dur(dur_s),
                    }
                )
        else:
            raise RuntimeError("Für diesen CDDB-Treffer liegt keine Trackliste vor.")
    elif source == "discogs":
        clean_id = re.sub(r"^discogs:", "", cid, flags=re.IGNORECASE).strip()
        resolved_id = _resolve_discogs_release_id(clean_id) or clean_id
        try:
            rel = _discogs_get_json(
                f"releases/{urllib.parse.quote(str(resolved_id))}",
                discogs_token=discogs_token,
            )
        except urllib.error.HTTPError as exc:
            if exc.code == 404 and str(resolved_id).isdigit():
                alt_master = _resolve_discogs_release_id(f"m{resolved_id}")
                if alt_master and alt_master != resolved_id:
                    resolved_id = alt_master
                    rel = _discogs_get_json(
                        f"releases/{urllib.parse.quote(str(alt_master))}",
                        discogs_token=discogs_token,
                    )
                else:
                    raise
            else:
                raise
        album_artist = _discogs_format_artists(rel.get("artists") or []) or result["artist"] or "Unbekannter Künstler"
        labels = list(
            dict.fromkeys(
                _discogs_clean_name(li.get("name", ""))
                for li in (rel.get("labels") or [])
                if isinstance(li, dict) and li.get("name")
            )
        )
        catnos = list(
            dict.fromkeys(
                str(li.get("catno") or "").strip()
                for li in (rel.get("labels") or [])
                if isinstance(li, dict) and li.get("catno") and str(li.get("catno")).lower() != "none"
            )
        )
        barcodes = [
            str(ident.get("value") or "").strip()
            for ident in (rel.get("identifiers") or [])
            if isinstance(ident, dict) and str(ident.get("type") or "").lower() == "barcode" and ident.get("value")
        ]
        formats = [f for f in (rel.get("formats") or []) if isinstance(f, dict)]
        fmt_parts = []
        for f in formats:
            f_name = str(f.get("name") or "").strip()
            f_qty = int(f.get("qty") or 1) if str(f.get("qty") or "1").isdigit() else 1
            if f_name:
                fmt_parts.append(f"{f_qty} × {f_name}" if f_qty > 1 else f_name)
        dg_genres = [str(g).strip() for g in list(rel.get("genres") or []) + list(rel.get("styles") or []) if str(g).strip()]
        images = [i for i in (rel.get("images") or []) if isinstance(i, dict)]
        primary_img = next((i for i in images if i.get("type") == "primary"), images[0] if images else {})
        cover_url = str(primary_img.get("uri150") or primary_img.get("uri") or rel.get("thumb") or "").strip()

        result["title"] = str(rel.get("title") or result["title"])
        result["artist"] = album_artist
        result["album_artist"] = album_artist
        result["date"] = str(rel.get("released") or rel.get("year") or result["date"])
        result["country"] = str(rel.get("country") or result["country"])
        result["status"] = str(rel.get("status") or "")
        result["barcode"] = barcodes[0] if barcodes else result["barcode"]
        result["label"] = "; ".join(labels) if labels else result["label"]
        result["catalog_number"] = "; ".join(catnos) if catnos else result["catalog_number"]
        result["genre"] = format_multi_genre(dg_genres, max_items=7)
        result["release_type"] = ", ".join(str(d) for d in (formats[0].get("descriptions") or [])[:3]) if formats else ""
        result["media_format"] = " + ".join(fmt_parts) if fmt_parts else "CD"
        result["disambiguation"] = str(rel.get("notes") or "").strip()[:180]
        result["source_id"] = f"[r{resolved_id}]"
        result["cover_url"] = cover_url

        fallback_idx = 0
        disc_nums: set[int] = set()
        for item in rel.get("tracklist") or []:
            if not isinstance(item, dict) or item.get("type_", "track") != "track":
                continue
            fallback_idx += 1
            disc_idx, trk_idx = _discogs_parse_position(item.get("position", ""), fallback_idx)
            disc_nums.add(disc_idx)
            trk_artist = _discogs_format_artists(item.get("artists") or []) or album_artist
            dur_s = _discogs_parse_duration(str(item.get("duration") or ""))
            result["tracks"].append(
                {
                    "disc_number": disc_idx,
                    "disc_subtitle": "",
                    "track_number": trk_idx,
                    "title": str(item.get("title") or f"Titel {trk_idx}"),
                    "artist": trk_artist,
                    "duration_seconds": dur_s,
                    "duration_formatted": _fmt_dur(dur_s),
                }
            )
        result["total_discs"] = max(1, len(disc_nums))
    else:
        rel_quoted = urllib.parse.quote(cid)
        rel = _mb_ws2_get_json(
            f"release/{rel_quoted}?inc=artists+recordings+labels+release-groups+genres+tags&fmt=json",
            timeout=15,
            max_retries=2,
        )
        album_artist = _format_artist_credit(rel.get("artist-credit") or []) or result["artist"] or "Unbekannter Künstler"
        label_list = [li for li in (rel.get("label-info") or []) if isinstance(li, dict)]
        labels = list(
            dict.fromkeys(
                str(_as_dict(li.get("label")).get("name") or "").strip()
                for li in label_list
                if _as_dict(li.get("label")).get("name")
            )
        )
        catnos = list(
            dict.fromkeys(
                str(li.get("catalog-number") or "").strip()
                for li in label_list
                if li.get("catalog-number")
            )
        )
        rg = _as_dict(rel.get("release-group"))
        rel_types = []
        if rg.get("primary-type"):
            rel_types.append(str(rg.get("primary-type")))
        for st in rg.get("secondary-types") or []:
            if st and str(st) not in rel_types:
                rel_types.append(str(st))
        media = [m for m in (rel.get("media") or []) if isinstance(m, dict)]
        fmt_counts: dict[str, int] = {}
        for med in media:
            f_name = str(med.get("format") or "CD").strip()
            fmt_counts[f_name] = fmt_counts.get(f_name, 0) + 1
        media_fmt = " + ".join(
            f"{cnt} × {fname}" if cnt > 1 else fname for fname, cnt in fmt_counts.items()
        )
        text_rep = _as_dict(rel.get("text-representation"))
        lang_parts = " / ".join(
            p for p in (str(text_rep.get("language") or "").strip(), str(text_rep.get("script") or "").strip()) if p
        )
        mb_genres_str = _extract_musicbrainz_genres(rel)

        result["title"] = str(rel.get("title") or result["title"])
        result["artist"] = album_artist
        result["album_artist"] = album_artist
        result["date"] = str(rel.get("date") or result["date"])
        result["original_date"] = str(rg.get("first-release-date") or "")
        result["country"] = str(rel.get("country") or result["country"])
        result["status"] = str(rel.get("status") or "")
        result["barcode"] = str(rel.get("barcode") or result["barcode"])
        result["asin"] = str(rel.get("asin") or "")
        result["label"] = "; ".join(labels) if labels else result["label"]
        result["catalog_number"] = "; ".join(catnos) if catnos else result["catalog_number"]
        result["genre"] = mb_genres_str
        result["release_type"] = ", ".join(rel_types)
        result["media_format"] = media_fmt or "CD"
        result["disambiguation"] = str(rel.get("disambiguation") or "")
        result["language"] = lang_parts
        result["source_id"] = cid
        result["cover_url"] = f"https://coverartarchive.org/release/{rel_quoted}/front-250" if cid else ""
        result["total_discs"] = max(1, len(media))
        for m_idx, med in enumerate(media, start=1):
            disc_num = int(med.get("position") or m_idx)
            disc_sub = str(med.get("title") or "").strip()
            for t_idx, t in enumerate(med.get("tracks") or [], start=1):
                if not isinstance(t, dict):
                    continue
                rec = _as_dict(t.get("recording"))
                len_ms = int(t.get("length") or rec.get("length") or 0)
                dur_s = int(round(len_ms / 1000.0)) if len_ms > 0 else 0
                trk_artist = (
                    _format_artist_credit(t.get("artist-credit") or [])
                    or _format_artist_credit(rec.get("artist-credit") or [])
                    or album_artist
                )
                result["tracks"].append(
                    {
                        "disc_number": disc_num,
                        "disc_subtitle": disc_sub,
                        "track_number": int(t.get("position") or t_idx),
                        "title": str(t.get("title") or rec.get("title") or f"Titel {t_idx}"),
                        "artist": trk_artist,
                        "duration_seconds": dur_s,
                        "duration_formatted": _fmt_dur(dur_s),
                    }
                )

    if len(_PREVIEW_TRACKLIST_CACHE) >= 150:
        first_key = next(iter(_PREVIEW_TRACKLIST_CACHE), None)
        if first_key is not None:
            _PREVIEW_TRACKLIST_CACHE.pop(first_key, None)
    _PREVIEW_TRACKLIST_CACHE[cache_key] = result
    return result


_NON_LATIN_LETTER_RE = re.compile(
    r"[\u0370-\u03FF\u0400-\u052F\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0700-\u074F"
    r"\u0900-\u097F\u0E00-\u0E7F\u10A0-\u10FF\u1100-\u11FF\u3040-\u309F\u30A0-\u30FF"
    r"\u3130-\u318F\u4E00-\u9FFF\uAC00-\uD7AF]"
)

_CYR_GREEK_LATIN_MAP: dict[str, str] = {
    "А": "A", "а": "a", "Б": "B", "б": "b", "В": "V", "в": "v", "Г": "G", "г": "g",
    "Д": "D", "д": "d", "Е": "E", "е": "e", "Ё": "Yo", "ё": "yo", "Ж": "Zh", "ж": "zh",
    "З": "Z", "з": "z", "И": "I", "и": "i", "Й": "Y", "й": "y", "К": "K", "к": "k",
    "Л": "L", "л": "l", "М": "M", "м": "m", "Н": "N", "н": "n", "О": "O", "о": "o",
    "П": "P", "п": "p", "Р": "R", "р": "r", "С": "S", "с": "s", "Т": "T", "т": "t",
    "У": "U", "у": "u", "Ф": "F", "ф": "f", "Х": "Kh", "х": "kh", "Ц": "Ts", "ц": "ts",
    "Ч": "Ch", "ч": "ch", "Ш": "Sh", "ш": "sh", "Щ": "Shch", "щ": "shch", "Ъ": "", "ъ": "",
    "Ы": "Y", "ы": "y", "Ь": "", "ь": "", "Э": "E", "э": "e", "Ю": "Yu", "ю": "yu",
    "Я": "Ya", "я": "ya", "І": "I", "і": "i", "Ї": "Yi", "ї": "yi", "Є": "Ye", "є": "ye",
    "Ґ": "G", "ґ": "g",
    "Α": "A", "α": "a", "Β": "V", "β": "v", "Γ": "G", "γ": "g", "Δ": "D", "δ": "d",
    "Ε": "E", "ε": "e", "Ζ": "Z", "ζ": "z", "Η": "I", "η": "i", "Θ": "Th", "θ": "th",
    "Ι": "I", "ι": "i", "Κ": "K", "κ": "k", "Λ": "L", "λ": "l", "Μ": "M", "μ": "m",
    "Ν": "N", "ν": "n", "Ξ": "X", "ξ": "x", "Ο": "O", "ο": "o", "Π": "P", "π": "p",
    "Ρ": "R", "ρ": "r", "Σ": "S", "σ": "s", "ς": "s", "Τ": "T", "τ": "t", "Υ": "Y", "υ": "y",
    "Φ": "F", "φ": "f", "Χ": "Ch", "χ": "ch", "Ψ": "Ps", "ψ": "ps", "Ω": "O", "ω": "o",
}


def is_latin_artist_name(value: str) -> bool:
    return not bool(_NON_LATIN_LETTER_RE.search(str(value or "")))


def _fold_artist_for_compare(value: str) -> str:
    nfkd = unicodedata.normalize("NFKD", str(value or ""))
    stripped = "".join(ch for ch in nfkd if unicodedata.category(ch) != "Mn")
    cleaned = re.sub(r"[^a-z0-9\u0370-\u03ff\u0400-\u052f\u0590-\u06ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]+", " ", stripped.lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def _artist_levenshtein_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    m, n = len(a), len(b)
    dp = list(range(n + 1))
    for i in range(1, m + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, n + 1):
            temp = dp[j]
            cost = 0 if a[i - 1] == b[j - 1] else 1
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + cost)
            prev = temp
    return max(0.0, 1.0 - dp[n] / max(m, n))


def _uninvert_artist_sort_name(name: str) -> str:
    clean = str(name or "").strip()
    if ", " not in clean:
        return clean
    parts = [p.strip() for p in clean.split(", ") if p.strip()]
    if len(parts) != 2:
        return clean
    if re.search(r"[&/]", clean) or re.search(r"\b(?:and|und|feat|ft|vs)\b", clean, re.IGNORECASE):
        return clean
    return f"{parts[1]} {parts[0]}".strip()


def _escape_mb_lucene(term: str) -> str:
    return re.sub(r'([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)', r"\\\1", term)


def _transliterate_non_latin_artist(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or ""))
    out = "".join(_CYR_GREEK_LATIN_MAP.get(ch, ch) for ch in normalized)
    return re.sub(r"\s+", " ", out).strip()


def _fetch_wikidata_english_artist_label(mb_artist_id: str = "", search_name: str = "") -> str:
    headers = {
        "User-Agent": f"{USER_AGENT_APP}/{USER_AGENT_VERSION} ({USER_AGENT_CONTACT})",
        "Accept": "application/json",
    }
    try:
        if mb_artist_id and _UUID_RE.match(mb_artist_id.strip()):
            sparql = (
                f'SELECT ?label WHERE {{ ?item wdt:P434 "{mb_artist_id.strip()}" ; '
                'rdfs:label ?label . FILTER(LANG(?label) = "en") } LIMIT 1'
            )
            url = "https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(sparql)
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="replace"))
            bindings = _as_dict(_as_dict(data).get("results")).get("bindings") or []
            if bindings and isinstance(bindings[0], dict):
                val = str(_as_dict(bindings[0].get("label")).get("value") or "").strip()
                if val and is_latin_artist_name(val):
                    return val
        if search_name.strip():
            surl = (
                "https://www.wikidata.org/w/api.php?action=wbsearchentities"
                f"&search={urllib.parse.quote(search_name.strip())}&language=en&format=json&limit=3"
            )
            sreq = urllib.request.Request(surl, headers=headers)
            with urllib.request.urlopen(sreq, timeout=5) as sresp:
                sdata = json.loads(sresp.read().decode("utf-8", errors="replace"))
            items = sdata.get("search", [])
            music_item = next(
                (
                    it
                    for it in items
                    if re.search(
                        r"(musician|singer|band|composer|conductor|orchestra|rapper|dj|group|artist|performer|pianist|violinist)",
                        str(it.get("description") or ""),
                        re.IGNORECASE,
                    )
                ),
                items[0] if items else None,
            )
            if music_item:
                lbl = str(music_item.get("label") or "").strip()
                if lbl and is_latin_artist_name(lbl):
                    return lbl
    except Exception:
        pass
    return ""


def _score_mb_artist_candidate(cand: dict, raw_input: str, alt_input: str) -> float:
    fold_a = _fold_artist_for_compare(raw_input)
    fold_b = _fold_artist_for_compare(alt_input)
    forms: list[str] = []
    if cand.get("name"):
        forms.append(str(cand["name"]))
    if cand.get("sort-name"):
        forms.append(str(cand["sort-name"]))
        forms.append(_uninvert_artist_sort_name(str(cand["sort-name"])))
    for al in cand.get("aliases") or []:
        if isinstance(al, dict):
            if al.get("name"):
                forms.append(str(al["name"]))
            if al.get("sort-name"):
                forms.append(_uninvert_artist_sort_name(str(al["sort-name"])))

    best_sim = 0.0
    for f in forms:
        ff = _fold_artist_for_compare(f)
        if not ff:
            continue
        best_sim = max(best_sim, _artist_levenshtein_similarity(fold_a, ff))
        if fold_b and fold_b != fold_a:
            best_sim = max(best_sim, _artist_levenshtein_similarity(fold_b, ff))
    return best_sim


_ARTIST_VERIFY_CACHE_TTL_SEC = 24 * 60 * 60
_ARTIST_VERIFY_CACHE: dict[tuple[str, str], tuple[str, str, float]] = {}


def _get_cached_artist_verify(role: str, key_lower: str) -> Optional[tuple[str, str]]:
    hit = _ARTIST_VERIFY_CACHE.get((role, key_lower))
    if not hit:
        return None
    resolved, source, expires_at = hit
    if expires_at <= time.monotonic():
        _ARTIST_VERIFY_CACHE.pop((role, key_lower), None)
        return None
    return resolved, source


def _set_cached_artist_verify(role: str, key_lower: str, resolved: str, source: str) -> None:
    if len(_ARTIST_VERIFY_CACHE) >= 3000:
        first_key = next(iter(_ARTIST_VERIFY_CACHE), None)
        if first_key is not None:
            _ARTIST_VERIFY_CACHE.pop(first_key, None)
    _ARTIST_VERIFY_CACHE[(role, key_lower)] = (resolved, source, time.monotonic() + _ARTIST_VERIFY_CACHE_TTL_SEC)


def _preseed_verify_cache_from_mb_release(rel: dict) -> None:
    if not isinstance(rel, dict):
        return

    def _seed_credit(ac: list) -> None:
        for chunk in ac or []:
            if isinstance(chunk, dict):
                canonical = str((chunk.get("artist") or {}).get("name") or "").strip()
                if canonical and is_latin_artist_name(canonical):
                    _set_cached_artist_verify("artist", canonical.lower(), canonical, "mb")

    def _seed_relations(rels: list) -> None:
        for item in rels or []:
            if not isinstance(item, dict):
                continue
            canonical = str((item.get("artist") or {}).get("name") or "").strip()
            if not canonical or not is_latin_artist_name(canonical):
                continue
            rtype = str(item.get("type") or "").lower()
            if rtype == "composer":
                _set_cached_artist_verify("composer", canonical.lower(), canonical, "mb")
            elif rtype == "conductor":
                _set_cached_artist_verify("conductor", canonical.lower(), canonical, "mb")
            elif rtype in ("orchestra", "performing orchestra"):
                _set_cached_artist_verify("orchestra", canonical.lower(), canonical, "mb")

    _seed_credit(rel.get("artist-credit") or [])
    _seed_relations(rel.get("relations") or [])
    for med in rel.get("media") or []:
        for trk in (med.get("tracks") or []) if isinstance(med, dict) else []:
            if not isinstance(trk, dict):
                continue
            _seed_credit(trk.get("artist-credit") or [])
            rec = trk.get("recording") or {}
            if isinstance(rec, dict):
                _seed_credit(rec.get("artist-credit") or [])
                _seed_relations(rec.get("relations") or [])
                for r_item in rec.get("relations") or []:
                    if isinstance(r_item, dict) and r_item.get("target-type") == "work" and isinstance(r_item.get("work"), dict):
                        _seed_relations(r_item["work"].get("relations") or [])


def _describe_artist_change_reason(raw_input: str, resolved: str, source: str) -> str:
    if not resolved or resolved == raw_input:
        return ""
    is_input_latin = is_latin_artist_name(raw_input)
    uninverted = _uninvert_artist_sort_name(raw_input)
    has_comma_invert = uninverted != raw_input
    if not is_input_latin:
        if source == "wikidata":
            return "Internationaler Name über Wikidata ergänzt"
        if source == "local":
            return "In lateinische Umschrift internationalisiert"
        return "Nicht-lateinische Schrift internationalisiert"
    if has_comma_invert and resolved.lower() == uninverted.lower():
        return "Namensreihenfolge normalisiert"
    if _fold_artist_for_compare(resolved) == _fold_artist_for_compare(raw_input):
        return "Schreibweise / Diakritika korrigiert"
    return "Rechtschreibung / Internationaler Name über MusicBrainz korrigiert"


def _pick_latin_alias_from_list(raw_aliases: list) -> str:
    aliases = [
        al
        for al in (raw_aliases or [])
        if isinstance(al, dict)
        and not al.get("ended")
        and al.get("name")
        and is_latin_artist_name(str(al["name"]))
    ]
    for pred in (
        lambda a: re.match(r"^en(?:[_-]|$)", str(a.get("locale") or ""), re.IGNORECASE) and bool(a.get("primary")),
        lambda a: re.match(r"^en(?:[_-]|$)", str(a.get("locale") or ""), re.IGNORECASE) and a.get("type") == "Artist name",
        lambda a: re.match(r"^en(?:[_-]|$)", str(a.get("locale") or ""), re.IGNORECASE),
        lambda a: a.get("type") == "Artist name" and bool(a.get("primary")),
        lambda a: a.get("type") == "Artist name",
        lambda _a: True,
    ):
        hit = next((a for a in aliases if pred(a)), None)
        if hit and hit.get("name"):
            return str(hit["name"]).strip()
    return ""


def _pick_international_name_from_mb_artist(
    cand: dict,
    on_log: Optional[Callable[[str], None]] = None,
    skip_extra_mb_fetch: bool = False,
    cancel_event: Optional[threading.Event] = None,
) -> str:
    artist_obj = cand
    aid = str(cand.get("id") or "").strip()
    raw_name = str(cand.get("name") or "").strip()

    if raw_name and is_latin_artist_name(raw_name):
        return raw_name

    from_search_aliases = _pick_latin_alias_from_list(artist_obj.get("aliases") or [])
    if from_search_aliases:
        return from_search_aliases

    # Wikidata ohne MusicBrainz-Rate-Limit zuerst abfragen, bevor ein weiterer MB-Request erfolgt
    wd_label = _fetch_wikidata_english_artist_label(aid, raw_name)
    if wd_label:
        return wd_label

    if (
        not skip_extra_mb_fetch
        and not (cancel_event is not None and cancel_event.is_set())
        and aid
        and _UUID_RE.match(aid)
        and "aliases" not in artist_obj
    ):
        try:
            artist_obj = _mb_ws2_get_json(
                f"artist/{urllib.parse.quote(aid)}?inc=aliases&fmt=json",
                on_log=on_log,
                cancel_event=cancel_event,
            )
            from_detail_aliases = _pick_latin_alias_from_list(artist_obj.get("aliases") or [])
            if from_detail_aliases:
                return from_detail_aliases
        except InterruptedError:
            raise
        except Exception:
            pass

    sort_name = str(artist_obj.get("sort-name") or "").strip()
    if sort_name and is_latin_artist_name(sort_name):
        return _uninvert_artist_sort_name(sort_name)

    return _transliterate_non_latin_artist(raw_name or sort_name)


def _get_role_bonus(cand: dict, role: str) -> float:
    ctype = str(cand.get("type") or "").lower()
    disambig = str(cand.get("disambiguation") or "").lower()
    if role == "orchestra":
        bonus = 0.0
        if ctype == "orchestra":
            bonus += 0.045
        elif ctype in ("group", "choir"):
            bonus += 0.015
        if re.search(
            r"(orchestra|philharmonic|philharmoniker|symphony|sinfonie|ensemble|choir|kammerorchester)",
            disambig,
            re.IGNORECASE,
        ):
            bonus += 0.02
        return bonus
    if role == "composer":
        bonus = 0.02 if ctype == "person" else 0.0
        if re.search(r"(composer|komponist)", disambig, re.IGNORECASE):
            bonus += 0.025
        return bonus
    if role == "conductor":
        bonus = 0.02 if ctype == "person" else 0.0
        if re.search(r"(conductor|dirigent|kapellmeister)", disambig, re.IGNORECASE):
            bonus += 0.025
        return bonus
    return 0.0


def _resolve_single_artist_token_with_status(
    raw_token: str,
    on_log: Optional[Callable[[str], None]] = None,
    role: str = "artist",
    mb_paused_in_batch: bool = False,
    cancel_event: Optional[threading.Event] = None,
) -> tuple[str, str, bool]:
    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError("Abfrage durch Benutzer gestoppt.")
    clean = re.sub(r"\s+", " ", str(raw_token or "")).strip()
    if not clean:
        return clean, "", False
    if re.fullmatch(
        r"(?:unbekannter künstler|unknown artist|unbekannter komponist|unknown composer|unbekanntes orchester|unknown orchestra|unbekannter dirigent|unknown conductor|\?|-)",
        clean,
        re.IGNORECASE,
    ):
        return clean, "", False
    if role == "artist" and re.fullmatch(
        r"(?:verschiedene(?:\s+interpreten)?|v\.?a\.?|various(?:\s+artists)?)", clean, re.IGNORECASE
    ):
        target = "Various Artists"
        return target, ("Internationalisiert auf „Various Artists“" if target != clean else ""), False

    cache_key_lower = clean.lower()
    cached = _get_cached_artist_verify(role, cache_key_lower)
    if cached:
        cached_resolved, cached_source = cached
        return cached_resolved, _describe_artist_change_reason(clean, cached_resolved, cached_source), False

    uninverted = _uninvert_artist_sort_name(clean)
    has_comma_invert = uninverted != clean
    is_input_latin = is_latin_artist_name(clean)
    fold_in = _fold_artist_for_compare(clean)

    # Kombinierte Einzelabfrage (Exakt mit ^6/^5-Boost + Fuzzy-Fallback in EINEM HTTP-Call -> halbiert MB-Requests)
    esc_clean = _escape_mb_lucene(clean)
    exact_clause = (
        f'artist:"{_escape_mb_lucene(uninverted)}"^6 OR artist:"{esc_clean}"^6 OR alias:"{esc_clean}"^5'
        if has_comma_invert
        else f'artist:"{esc_clean}"^6 OR alias:"{esc_clean}"^5'
    )
    words = [w for w in fold_in.split(" ") if len(w) >= 3]
    fuzzy_target = words if words else ([clean] if len(fold_in) >= 3 else [])
    fuzzy_part = ""
    if fuzzy_target:
        fuzzy_clauses = " AND ".join(f"{_escape_mb_lucene(w)}~0.65" for w in fuzzy_target)
        fuzzy_part = f" OR artist:({fuzzy_clauses}) OR alias:({fuzzy_clauses})"
    combined_query = f"({exact_clause}){fuzzy_part}"

    best_cand: Optional[dict] = None
    best_combined = 0.0
    hit_rate_limit = False

    if not mb_paused_in_batch:
        try:
            data = _mb_ws2_get_json(
                f"artist/?query={urllib.parse.quote(combined_query)}&limit=10&fmt=json",
                on_log=on_log,
                cancel_event=cancel_event,
            )
            for cand in data.get("artists") or []:
                mb_score = float(cand.get("score") or 0)
                sim = _score_mb_artist_candidate(cand, clean, uninverted)
                is_short = len(fold_in) <= 3
                acceptable = (
                    (sim >= 0.99 and mb_score >= 80)
                    if is_short
                    else (sim >= 0.96 or (sim >= 0.72 and mb_score >= 60) or sim >= 0.80)
                )
                if not acceptable:
                    continue
                combined = sim * 0.78 + (mb_score / 100.0) * 0.22 + _get_role_bonus(cand, role)
                if combined > best_combined:
                    best_combined = combined
                    best_cand = cand
        except InterruptedError:
            raise
        except urllib.error.HTTPError as http_exc:
            if http_exc.code in (503, 429):
                hit_rate_limit = True
        except Exception:
            pass

    if best_cand:
        intl_name = _pick_international_name_from_mb_artist(
            best_cand,
            on_log=on_log,
            skip_extra_mb_fetch=hit_rate_limit,
            cancel_event=cancel_event,
        )
        if intl_name:
            _set_cached_artist_verify(role, cache_key_lower, intl_name, "mb")
            return intl_name, _describe_artist_change_reason(clean, intl_name, "mb"), False

    if not is_input_latin:
        wd_name = _fetch_wikidata_english_artist_label("", clean)
        if wd_name:
            if not hit_rate_limit and not mb_paused_in_batch:
                _set_cached_artist_verify(role, cache_key_lower, wd_name, "wikidata")
            return wd_name, _describe_artist_change_reason(clean, wd_name, "wikidata"), hit_rate_limit
        translit = _transliterate_non_latin_artist(clean)
        if translit and translit != clean:
            return translit, _describe_artist_change_reason(clean, translit, "local"), hit_rate_limit

    if has_comma_invert and is_latin_artist_name(uninverted):
        return uninverted, "Namensreihenfolge (Vorname Nachname) korrigiert", hit_rate_limit

    if not hit_rate_limit and not mb_paused_in_batch:
        _set_cached_artist_verify(role, cache_key_lower, clean, "mb")
    return clean, "", hit_rate_limit


def resolve_single_artist_international(
    raw_token: str,
    on_log: Optional[Callable[[str], None]] = None,
    role: str = "artist",
) -> tuple[str, str]:
    resolved, reason, _ = _resolve_single_artist_token_with_status(raw_token, on_log=on_log, role=role)
    return resolved, reason


def verify_and_internationalize_artists(
    album: AlbumMetadata,
    on_log: Optional[Callable[[str], None]] = None,
    field: str = "artist",
    cancel_event: Optional[threading.Event] = None,
    only_selected: bool = True,
) -> tuple[list[tuple[str, str, str, str]], int]:
    """Prüft Interpreten, Komponisten, Orchester oder Dirigenten (; getrennt) nur für ausgewählte Titel (und bei Gesamtauswahl für Albumfelder) online."""
    role = field if field in ("artist", "composer", "orchestra", "conductor") else "artist"
    role_meta = {
        "artist": ("[Interpreten-Prüfung]", "Künstler", "Interpretennamen"),
        "composer": ("[Komponist-Prüfung]", "Komponist (Album)", "Komponisten"),
        "orchestra": ("[Orchester-Prüfung]", "Orchester (Album)", "Orchesternamen"),
        "conductor": ("[Dirigent-Prüfung]", "Dirigent (Album)", "Dirigenten"),
    }
    log_tag, album_scope, plural_noun = role_meta[role]

    target_tracks = (
        [t for t in album.tracks if t.selected] if (only_selected and album.tracks) else list(album.tracks)
    )
    if only_selected and album.tracks and not target_tracks:
        _log_step(f"{log_tag} Keine Titel ausgewählt – Prüfung übersprungen.", on_log)
        return [], 0

    verify_album_fields = (not only_selected) or (len(album.tracks) == 0) or (len(target_tracks) == len(album.tracks))

    _log_step(
        f"{log_tag} Starte Online-Verifizierung & Internationalisierung ({plural_noun}, ;-getrennte Mehrfachwerte) über MusicBrainz + Wikidata...",
        on_log,
    )
    token_cache: dict[str, tuple[str, str]] = {}
    changes: list[tuple[str, str, str, str]] = []
    consecutive_mb_rate_limits = 0
    mb_paused_in_batch = False
    was_cancelled = False

    def _resolve_field(raw_val: str) -> tuple[str, list[str]]:
        nonlocal consecutive_mb_rate_limits, mb_paused_in_batch
        norm = normalize_multi_artist(str(raw_val or "").strip())
        if not norm:
            return "", []
        tokens = [t.strip() for t in re.split(r"\s*;\s*", norm) if t.strip()]
        out_tokens: list[str] = []
        reasons: list[str] = []
        for tok in tokens:
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("Abfrage durch Benutzer gestoppt.")
            tok_key = tok.lower()
            if tok_key not in token_cache:
                resolved_tok, _tok_reason, rate_limited = _resolve_single_artist_token_with_status(
                    tok,
                    on_log=on_log,
                    role=role,
                    mb_paused_in_batch=mb_paused_in_batch,
                    cancel_event=cancel_event,
                )
                if rate_limited:
                    consecutive_mb_rate_limits += 1
                    if consecutive_mb_rate_limits >= 2 and not mb_paused_in_batch:
                        mb_paused_in_batch = True
                        _log_step(
                            f"{log_tag} MusicBrainz Rate-Limit aktiv – schalte für restliche Einträge auf Wikidata- & lokale Normalisierung um, um weitere 503-Sperren zu vermeiden.",
                            on_log,
                        )
                else:
                    consecutive_mb_rate_limits = 0
                token_cache[tok_key] = (resolved_tok, "local" if rate_limited else "mb")
            resolved_tok, tok_source = token_cache[tok_key]
            if resolved_tok and not any(x.lower() == resolved_tok.lower() for x in out_tokens):
                out_tokens.append(resolved_tok)
            reason = _describe_artist_change_reason(tok, resolved_tok, tok_source)
            if reason and reason not in reasons:
                reasons.append(reason)
        return "; ".join(out_tokens), reasons

    try:
        if role == "artist":
            if verify_album_fields:
                orig_artist = (album.artist or "").strip()
                new_artist, art_reasons = _resolve_field(orig_artist)
                if new_artist and new_artist != orig_artist:
                    album.artist = new_artist
                    ch = ("Künstler", orig_artist, new_artist, ", ".join(art_reasons) or "Korrigiert")
                    changes.append(ch)
                    _log_step(f"{log_tag} {ch[0]}: „{ch[1]}“ → „{ch[2]}“ ({ch[3]})", on_log)

                orig_album_artist = (album.album_artist or "").strip()
                new_album_artist, aart_reasons = _resolve_field(orig_album_artist)
                if new_album_artist and new_album_artist != orig_album_artist:
                    album.album_artist = new_album_artist
                    ch = ("Album-Interpret", orig_album_artist, new_album_artist, ", ".join(aart_reasons) or "Korrigiert")
                    changes.append(ch)
                    _log_step(f"{log_tag} {ch[0]}: „{ch[1]}“ → „{ch[2]}“ ({ch[3]})", on_log)

            for trk in target_tracks:
                orig_t_art = (trk.artist or "").strip()
                if not orig_t_art:
                    continue
                new_t_art, t_reasons = _resolve_field(orig_t_art)
                if new_t_art and new_t_art != orig_t_art:
                    trk.artist = new_t_art
                    ch = (f"Titel #{trk.track_number:02d}", orig_t_art, new_t_art, ", ".join(t_reasons) or "Korrigiert")
                    changes.append(ch)
                    _log_step(f"{log_tag} {ch[0]}: „{ch[1]}“ → „{ch[2]}“ ({ch[3]})", on_log)
        else:
            if verify_album_fields:
                orig_album_val = str(getattr(album, role, "") or "").strip()
                new_album_val, album_reasons = _resolve_field(orig_album_val)
                if new_album_val and new_album_val != orig_album_val:
                    setattr(album, role, new_album_val)
                    ch = (album_scope, orig_album_val, new_album_val, ", ".join(album_reasons) or "Korrigiert")
                    changes.append(ch)
                    _log_step(f"{log_tag} {ch[0]}: „{ch[1]}“ → „{ch[2]}“ ({ch[3]})", on_log)

            for trk in target_tracks:
                orig_t_val = str(getattr(trk, role, "") or "").strip()
                if not orig_t_val:
                    continue
                new_t_val, t_reasons = _resolve_field(orig_t_val)
                if new_t_val and new_t_val != orig_t_val:
                    setattr(trk, role, new_t_val)
                    ch = (f"Titel #{trk.track_number:02d}", orig_t_val, new_t_val, ", ".join(t_reasons) or "Korrigiert")
                    changes.append(ch)
                    _log_step(f"{log_tag} {ch[0]}: „{ch[1]}“ → „{ch[2]}“ ({ch[3]})", on_log)
    except InterruptedError:
        was_cancelled = True

    if was_cancelled:
        _log_step(
            f"{log_tag} Abfrage durch Benutzer gestoppt (bisher {len(changes)} Änderung(en) übernommen).",
            on_log,
        )
    else:
        _log_step(
            f"{log_tag} Abgeschlossen: {len(changes)} Eintrag/Einträge korrigiert bzw. internationalisiert."
            if changes
            else f"{log_tag} Abgeschlossen: Alle {len(token_cache)} geprüften {plural_noun} sind korrekt und internationalisiert.",
            on_log,
        )
    return changes, len(token_cache)


_GENERIC_TRACK_TITLE_RE = re.compile(
    r"^(?:track|titel|audio|spur|title|song|unknown|unbekannt|audiotrack)\s*\d*$",
    re.IGNORECASE,
)
_GENERIC_ARTIST_NAMES = frozenset(
    {
        "",
        "unbekannter künstler",
        "unbekannter kuenstler",
        "unknown artist",
        "various artists",
        "various",
        "diverse",
        "diverse interpreten",
        "va",
        "v.a.",
    }
)


def _clean_single_track_hint(raw: str) -> str:
    txt = str(raw or "").strip()
    if not txt:
        return ""
    txt = re.sub(
        r"\.(?:flac|mp3|mp2|wav|aiff|aif|aifc|ogg|opus|m4a|dsf|tta|wv)$",
        "",
        txt,
        flags=re.IGNORECASE,
    )
    txt = re.sub(r"^\s*(?:\d{1,2}\s*[-–._]\s*\d{1,3}|\d{1,3})\s*[-–._)]\s*", "", txt)
    txt = txt.replace("_", " ")
    return re.sub(r"\s+", " ", txt).strip()


def _parse_hints_from_filename(file_name: str) -> tuple[str, str]:
    """Extrahiert optional (artist_hint, title_hint) aus einem Dateinamen wie '01 - Artist - Title.flac'."""
    stem = _clean_single_track_hint(file_name)
    if not stem:
        return "", ""
    parts = [p.strip() for p in re.split(r"\s+[-–—]\s+", stem) if p.strip()]
    if len(parts) >= 2:
        return parts[0], " - ".join(parts[1:])
    return "", stem


def _normalize_match_str(text: str) -> str:
    s = unicodedata.normalize("NFKD", str(text or "").lower())
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _extract_genres_from_mb_items(items: list[dict], max_items: int = 5) -> str:
    valid = [x for x in items if isinstance(x, dict) and x.get("name")]
    if not valid:
        return ""
    sorted_items = sorted(valid, key=lambda x: int(x.get("count") or 0), reverse=True)
    names = [str(x.get("name") or "").strip() for x in sorted_items if str(x.get("name") or "").strip()]
    return format_multi_genre(names, max_items=max_items)


def _extract_single_recording_genre(
    rec: dict,
    on_log: Optional[Callable[[str], None]] = None,
    cancel_event: Optional[threading.Event] = None,
) -> str:
    """Liest Genre eines einzelnen MusicBrainz-Recordings (Recording → Release-Groups → Haupt-Interpret)."""
    rec = _as_dict(rec)
    genre = _extract_genres_from_mb_items(list(rec.get("genres") or []))
    if genre:
        return genre

    rec_tags = [t for t in (rec.get("tags") or []) if isinstance(t, dict) and int(t.get("count") or 0) > 0]
    genre = _extract_genres_from_mb_items(rec_tags)
    if genre:
        return genre

    rg_genres: list[dict] = []
    rg_tags: list[dict] = []
    for rel in (rec.get("releases") or [])[:6]:
        if not isinstance(rel, dict):
            continue
        rg = _as_dict(rel.get("release-group"))
        rg_genres.extend(rg.get("genres") or [])
        rg_tags.extend(
            t for t in (rg.get("tags") or []) if isinstance(t, dict) and int(t.get("count") or 0) > 0
        )
    genre = _extract_genres_from_mb_items(rg_genres) or _extract_genres_from_mb_items(rg_tags)
    if genre:
        return genre

    artist_id = ""
    for chunk in rec.get("artist-credit") or []:
        if isinstance(chunk, dict):
            aid = str(_as_dict(chunk.get("artist")).get("id") or "").strip()
            if aid and _UUID_RE.match(aid):
                artist_id = aid
                break

    if artist_id:
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("Abfrage vom Benutzer abgebrochen.")
        try:
            art_data = _mb_ws2_get_json(
                f"artist/{urllib.parse.quote(artist_id)}?inc=genres+tags&fmt=json",
                on_log=on_log,
                cancel_event=cancel_event,
                timeout=16,
                max_retries=2,
                wait_on_circuit=True,
            )
            art_genres = list(art_data.get("genres") or [])
            genre = _extract_genres_from_mb_items(art_genres)
            if genre:
                return genre
            art_tags = [
                t for t in (art_data.get("tags") or []) if isinstance(t, dict) and int(t.get("count") or 0) > 0
            ]
            genre = _extract_genres_from_mb_items(art_tags)
            if genre:
                return genre
        except InterruptedError:
            raise
        except Exception:
            pass

    return ""


def _score_mb_recording_candidate(
    rec: dict,
    target_title: str,
    target_artist: str,
    duration_seconds: int,
) -> float:
    score = float(rec.get("score") or 50)
    cand_title = _normalize_match_str(str(rec.get("title") or ""))
    cand_artist = _normalize_match_str(_format_artist_credit(rec.get("artist-credit") or []))
    norm_title = _normalize_match_str(target_title)
    norm_artist = _normalize_match_str(target_artist)

    if norm_title and cand_title:
        if cand_title == norm_title:
            score += 40.0
        elif norm_title in cand_title or cand_title in norm_title:
            score += 18.0
    if norm_artist and cand_artist:
        if cand_artist == norm_artist:
            score += 35.0
        elif norm_artist in cand_artist or cand_artist in norm_artist:
            score += 16.0

    rec_len_ms = rec.get("length")
    if duration_seconds > 0 and isinstance(rec_len_ms, (int, float)) and rec_len_ms > 0:
        diff_sec = abs((float(rec_len_ms) / 1000.0) - float(duration_seconds))
        if diff_sec <= 2.5:
            score += 28.0
        elif diff_sec <= 6.0:
            score += 14.0
        elif diff_sec <= 15.0:
            score += 4.0
        elif diff_sec >= 45.0:
            score -= 18.0

    if rec.get("genres") or rec.get("tags"):
        score += 4.0
    return score


def analyze_single_track_musicbrainz(
    track: TrackMetadata,
    fallback_artist: str = "",
    on_log: Optional[Callable[[str], None]] = None,
    cancel_event: Optional[threading.Event] = None,
) -> Optional[dict]:
    """Analysiert einen einzelnen Track über MusicBrainz Recording-Suche (ISRC + Titel/Interpret/Dauer).

    Liefert gezielt Interpret, Titel und Genre für diesen Einzeltrack zurück (keine Album-Analyse).
    """
    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError("Abfrage vom Benutzer abgebrochen.")

    trk_label = f"#{track.track_number:02d}"
    raw_title = str(track.title or "").strip()
    raw_artist = str(track.artist or "").strip()
    if raw_artist.lower() in _GENERIC_ARTIST_NAMES:
        raw_artist = ""
    if not raw_artist and fallback_artist and fallback_artist.strip().lower() not in _GENERIC_ARTIST_NAMES:
        raw_artist = fallback_artist.strip()

    fn_artist = ""
    fn_title = ""
    if track.source_file is not None:
        fn_artist, fn_title = _parse_hints_from_filename(track.source_file.name)

    title_hint = raw_title
    if not title_hint or _GENERIC_TRACK_TITLE_RE.match(title_hint):
        title_hint = fn_title or _clean_single_track_hint(raw_title)
    else:
        title_hint = _clean_single_track_hint(title_hint) or raw_title

    artist_hint = raw_artist or fn_artist
    primary_artist_query = artist_hint.split(";")[0].strip() if artist_hint else ""
    isrc = str(track.isrc or "").strip().upper()
    dur_sec = max(0, int(track.duration_seconds or 0))

    best_rec: Optional[dict] = None
    match_method = "MusicBrainz (Einzeltrack)"

    # Stufe 1: Exakter ISRC-Treffer (falls vorhanden)
    isrc_matched = False
    if isrc and re.fullmatch(r"[A-Z]{2}[A-Z0-9]{3}\d{7}", isrc):
        _log_step(
            f"[MusicBrainz Einzeltrack {trk_label}] Prüfe exakten ISRC {isrc}...",
            on_log,
        )
        try:
            isrc_data = _mb_ws2_get_json(
                f"isrc/{urllib.parse.quote(isrc)}?inc=artists+genres+tags+releases+release-groups&fmt=json",
                on_log=on_log,
                cancel_event=cancel_event,
                timeout=18,
                max_retries=2,
                wait_on_circuit=True,
            )
            recs = [r for r in (isrc_data.get("recordings") or []) if isinstance(r, dict)]
            if recs:
                recs.sort(
                    key=lambda r: _score_mb_recording_candidate(r, title_hint, primary_artist_query, dur_sec),
                    reverse=True,
                )
                best_rec = recs[0]
                isrc_matched = True
                match_method = "MusicBrainz (ISRC)"
        except InterruptedError:
            raise
        except urllib.error.HTTPError as http_exc:
            if http_exc.code in (503, 429):
                _log_step(
                    f"[MusicBrainz Einzeltrack {trk_label}] MusicBrainz vorübergehend überlastet (HTTP {http_exc.code}) – überspringe Fallback-Suche für diesen Titel.",
                    on_log,
                )
                return None
            best_rec = None
        except Exception:
            best_rec = None

    # Stufe 2: Recording-Suche nach Titel + Interpret (+ Dauer-Bewertung)
    if best_rec is None:
        if not title_hint:
            _log_step(
                f"[MusicBrainz Einzeltrack {trk_label}] Übersprungen: kein auswertbarer Titel oder Dateiname vorhanden.",
                on_log,
            )
            return None

        esc_title = title_hint.replace('"', "").strip()
        esc_artist = primary_artist_query.replace('"', "").strip()
        queries: list[str] = []
        if esc_artist:
            queries.append(f'recording:"{esc_title}" AND artist:"{esc_artist}"')
            queries.append(f"recording:({esc_title}) AND artist:({esc_artist})")
        else:
            if dur_sec > 10:
                ms = dur_sec * 1000
                queries.append(f'recording:"{esc_title}" AND dur:[{max(1000, ms - 6000)} TO {ms + 6000}]')
            queries.append(f'recording:"{esc_title}"')

        _log_step(
            f"[MusicBrainz Einzeltrack {trk_label}] Suche Recording „{esc_title}“"
            + (f" von „{esc_artist}“" if esc_artist else "")
            + (f" ({dur_sec}s)" if dur_sec > 0 else "")
            + "...",
            on_log,
        )

        candidates: list[dict] = []
        had_service_error = False
        for lucene_q in queries:
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("Abfrage vom Benutzer abgebrochen.")
            try:
                search_data = _mb_ws2_get_json(
                    f"recording/?query={urllib.parse.quote(lucene_q)}&limit=8&fmt=json",
                    on_log=on_log,
                    cancel_event=cancel_event,
                    timeout=18,
                    max_retries=2,
                    wait_on_circuit=True,
                )
                found = [r for r in (search_data.get("recordings") or []) if isinstance(r, dict)]
                if found:
                    candidates = found
                    break
            except InterruptedError:
                raise
            except urllib.error.HTTPError as http_exc:
                had_service_error = True
                _log_step(
                    f"[MusicBrainz Einzeltrack {trk_label}] MusicBrainz-Anfrage fehlgeschlagen (HTTP {http_exc.code}).",
                    on_log,
                )
                if http_exc.code in (503, 429):
                    break
            except Exception as exc:
                had_service_error = True
                _log_step(
                    f"[MusicBrainz Einzeltrack {trk_label}] Such-Anfrage fehlgeschlagen: {exc}",
                    on_log,
                )
                break

        if not candidates:
            if not had_service_error:
                _log_step(
                    f"[MusicBrainz Einzeltrack {trk_label}] Kein passendes Recording bei MusicBrainz gefunden.",
                    on_log,
                )
            return None

        candidates.sort(
            key=lambda r: _score_mb_recording_candidate(r, title_hint, primary_artist_query, dur_sec),
            reverse=True,
        )
        best_rec = candidates[0]

    rec_id = str(best_rec.get("id") or "").strip()
    detail_rec = best_rec

    # Stufe 3: Recording-Details nur nachladen, falls Stufe 1 (ISRC) noch keine Genres/Artists/Releases geliefert hat oder tiefe Relationen aktiv sind
    need_deep_rels = _get_configured_bool_setting("mb_load_deep_relations", False)
    has_isrc_details = isrc_matched and bool(
        best_rec.get("artist-credit")
        and (best_rec.get("genres") or best_rec.get("tags") or best_rec.get("releases"))
    )
    if rec_id and _UUID_RE.match(rec_id) and (not has_isrc_details or need_deep_rels):
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("Abfrage vom Benutzer abgebrochen.")
        try:
            inc_str = (
                "artists+genres+tags+releases+release-groups+work-rels"
                if need_deep_rels
                else "artists+genres+tags+releases+release-groups"
            )
            fetched = _mb_ws2_get_json(
                f"recording/{urllib.parse.quote(rec_id)}?inc={inc_str}&fmt=json",
                on_log=on_log,
                cancel_event=cancel_event,
                timeout=18,
                max_retries=2,
                wait_on_circuit=True,
            )
            if isinstance(fetched, dict) and fetched.get("id"):
                detail_rec = fetched
        except InterruptedError:
            raise
        except Exception:
            pass

    resolved_title = str(detail_rec.get("title") or best_rec.get("title") or "").strip()
    resolved_artist = _format_artist_credit(
        detail_rec.get("artist-credit") or best_rec.get("artist-credit") or []
    )

    # IDs für parallele Wikidata-Track-Genre-Abfrage einsammeln (Recording, Work, Release-Group, Artist)
    work_id = ""
    for rel_item in detail_rec.get("relations") or []:
        if isinstance(rel_item, dict):
            wid = str(_as_dict(rel_item.get("work")).get("id") or "").strip()
            if wid and _UUID_RE.match(wid):
                work_id = wid
                break

    release_group_id = ""
    for rel_obj in (detail_rec.get("releases") or [])[:6]:
        if isinstance(rel_obj, dict):
            rgid = str(_as_dict(rel_obj.get("release-group")).get("id") or "").strip()
            if rgid and _UUID_RE.match(rgid):
                release_group_id = rgid
                break

    artist_ids_list: list[str] = []
    for chunk in (detail_rec.get("artist-credit") or best_rec.get("artist-credit") or []):
        if isinstance(chunk, dict):
            aid = str(_as_dict(chunk.get("artist")).get("id") or "").strip()
            if aid and _UUID_RE.match(aid) and aid not in artist_ids_list:
                artist_ids_list.append(aid)

    # Gleichzeitige (parallele) Genre-Abfrage: MusicBrainz + Wikidata für diesen Einzeltrack
    with ThreadPoolExecutor(max_workers=2) as pool:
        fut_mb_genre = pool.submit(
            _extract_single_recording_genre,
            detail_rec,
            on_log,
            cancel_event,
        )
        fut_wd_genres = pool.submit(
            fetch_wikidata_track_genres,
            rec_id,
            work_id,
            release_group_id,
            "; ".join(artist_ids_list),
            resolved_artist,
            resolved_title,
        )
        mb_genre_str = fut_mb_genre.result()
        try:
            wd_genres_list = fut_wd_genres.result()
        except Exception:
            wd_genres_list = []

    # Wikidata-Genres an MusicBrainz-Genres anhängen und strikt deduplizieren
    resolved_genre = merge_genre_strings(mb_genre_str, wd_genres_list, max_items=10)

    if not resolved_title and not resolved_artist and not resolved_genre:
        return None

    wd_info = f" (+{len(wd_genres_list)} Wikidata-Rohwerte)" if wd_genres_list else ""
    _log_step(
        f"[MusicBrainz Einzeltrack {trk_label}] Treffer: „{resolved_artist or '—'} – {resolved_title or '—'}“"
        + (f" · Genre (MB + Wikidata, dedupliziert{wd_info}): {resolved_genre}" if resolved_genre else " · Genre: —"),
        on_log,
    )
    return {
        "recording_id": rec_id,
        "title": resolved_title,
        "artist": resolved_artist,
        "genre": resolved_genre,
        "mb_genre": mb_genre_str,
        "wikidata_genres": wd_genres_list,
        "method": match_method,
    }


def fetch_wikidata_track_genres(
    recording_id: str = "",
    work_id: str = "",
    release_group_id: str = "",
    artist_id: str = "",
    artist_name: str = "",
    track_title: str = "",
) -> list[str]:
    """Fragt Wikidata-Genres (P136) gezielt für einen Einzeltrack ab (Recording P4404, Work P435, RG P436, Artist P434 + Titelsuche)."""
    headers = {
        "User-Agent": f"{USER_AGENT_APP}/{USER_AGENT_VERSION} ({USER_AGENT_CONTACT})",
        "Accept": "application/json",
    }
    unions: list[str] = []
    if recording_id and _UUID_RE.match(recording_id.strip()):
        unions.append(
            f'{{ BIND(1 AS ?prio) ?item wdt:P4404 "{recording_id.strip()}" . ?item wdt:P136 ?genre . }}'
        )
    if work_id and _UUID_RE.match(work_id.strip()):
        unions.append(
            f'{{ BIND(2 AS ?prio) ?item wdt:P435 "{work_id.strip()}" . ?item wdt:P136 ?genre . }}'
        )
    if release_group_id and _UUID_RE.match(release_group_id.strip()):
        unions.append(
            f'{{ BIND(3 AS ?prio) ?item wdt:P436 "{release_group_id.strip()}" . ?item wdt:P136 ?genre . }}'
        )
    for aid in [part.strip() for part in artist_id.split(";") if part.strip()][:2]:
        if _UUID_RE.match(aid):
            unions.append(
                f'{{ BIND(4 AS ?prio) ?item wdt:P434 "{aid}" . ?item wdt:P136 ?genre . }}'
            )

    genres: list[str] = []
    if unions:
        sparql = (
            "SELECT DISTINCT ?prio ?genreLabel WHERE {\n  "
            + "\n  UNION\n  ".join(unions)
            + '\n  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de". }\n}\n'
            + "ORDER BY ?prio\nLIMIT 20"
        )
        url = "https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(sparql)
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="replace"))
            for row in _as_dict(_as_dict(data).get("results")).get("bindings") or []:
                if not isinstance(row, dict):
                    continue
                val = str(_as_dict(row.get("genreLabel")).get("value") or "").strip()
                if val and not re.fullmatch(r"Q\d+", val):
                    genres.append(val)
        except Exception:
            pass

    # Fallback über Wikidata-Entitätssuche nach Track-Titel + Interpret
    if not genres and (track_title or artist_name):
        primary_artist = artist_name.split(";")[0].strip() if artist_name else ""
        search_terms = [
            f"{track_title} {primary_artist}".strip(),
            primary_artist,
        ]
        for term in search_terms:
            if not term:
                continue
            try:
                search_url = (
                    "https://www.wikidata.org/w/api.php?action=wbsearchentities"
                    f"&search={urllib.parse.quote(term)}&language=en&format=json&limit=3"
                )
                req = urllib.request.Request(search_url, headers=headers)
                with urllib.request.urlopen(req, timeout=6) as resp:
                    sdata = json.loads(resp.read().decode("utf-8", errors="replace"))
                qids = [
                    item["id"]
                    for item in (_as_dict(sdata).get("search") or [])
                    if isinstance(item, dict) and item.get("id") and re.fullmatch(r"Q\d+", str(item["id"]))
                ]
                if not qids:
                    continue
                qid_values = " ".join(f"wd:{q}" for q in qids[:3])
                sparql = (
                    f"SELECT DISTINCT ?genreLabel WHERE {{ VALUES ?item {{ {qid_values} }} "
                    "?item wdt:P136 ?genre . "
                    'SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de". } } LIMIT 12'
                )
                qurl = "https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(sparql)
                qreq = urllib.request.Request(qurl, headers=headers)
                with urllib.request.urlopen(qreq, timeout=6) as qresp:
                    qdata = json.loads(qresp.read().decode("utf-8", errors="replace"))
                for row in _as_dict(_as_dict(qdata).get("results")).get("bindings") or []:
                    if not isinstance(row, dict):
                        continue
                    val = str(_as_dict(row.get("genreLabel")).get("value") or "").strip()
                    if val and not re.fullmatch(r"Q\d+", val):
                        genres.append(val)
                if genres:
                    break
            except Exception:
                pass

    return genres





