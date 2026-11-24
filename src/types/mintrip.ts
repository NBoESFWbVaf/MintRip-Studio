export type ExportFormat = 'flac' | 'mp3';

export type Mp3QualityMode = 'vbr_v0' | 'cbr_320' | 'cbr_256' | 'cbr_192' | 'vbr_v2';

export type ParanoiaMode = 'full' | 'disable-skip' | 'fast';

export type CoverSourceOption =
  | 'auto'
  | 'musicbrainz'
  | 'musicbrainz_rg'
  | 'deezer'
  | 'theaudiodb'
  | 'bandcamp'
  | 'discogs'
  | 'amazon'
  | 'itunes';
export type CoverProviderId =
  | 'musicbrainz'
  | 'musicbrainz_rg'
  | 'deezer'
  | 'theaudiodb'
  | 'bandcamp'
  | 'discogs'
  | 'amazon'
  | 'itunes';

export type CoverProviderSettingId =
  | 'musicbrainz_caa'
  | 'musicbrainz_rg_caa'
  | 'deezer'
  | 'theaudiodb'
  | 'bandcamp'
  | 'itunes'
  | 'itunes_multi_region'
  | 'discogs'
  | 'amazon';

export interface CoverProviderSpec {
  id: CoverProviderSettingId;
  label: string;
  hint: string;
}

export const COVER_PROVIDER_OPTIONS: CoverProviderSpec[] = [
  {
    id: 'musicbrainz_caa',
    label: 'MusicBrainz Cover Art Archive (Release)',
    hint: 'Original-Scans konkreter Pressungen · ohne API-Key',
  },
  {
    id: 'musicbrainz_rg_caa',
    label: 'MusicBrainz Release-Group CAA',
    hint: 'Übergeordnete Album-Cover als Ergänzung/Fallback · ohne API-Key',
  },
  {
    id: 'deezer',
    label: 'Deezer',
    hint: 'Große internationale Datenbank (1000×1000+ px) · ohne API-Key',
  },
  {
    id: 'theaudiodb',
    label: 'TheAudioDB',
    hint: 'Community-Cover per Künstler/Album & MB-ID · ohne API-Key',
  },
  {
    id: 'bandcamp',
    label: 'Bandcamp',
    hint: 'Indie, Metal, Electronic & Nischen-Labels (bis 1200 px) · ohne API-Key',
  },
  {
    id: 'itunes',
    label: 'iTunes / Apple Music (DE)',
    hint: 'Deutscher Store (bis 1400–3000 px) · ohne API-Key',
  },
  {
    id: 'itunes_multi_region',
    label: 'iTunes / Apple Music (Multi-Region: US & JP)',
    hint: 'US- & Japan-Store für internationale Pressungen · ohne API-Key',
  },
  {
    id: 'discogs',
    label: 'Discogs',
    hint: 'CD-, Vinyl- & Sammler-Editionen (Token optional)',
  },
  {
    id: 'amazon',
    label: 'Amazon (ASIN)',
    hint: 'Produktbilder über Amazon-ASIN · ohne API-Key',
  },
];

export const DEFAULT_COVER_PROVIDERS: CoverProviderSettingId[] = COVER_PROVIDER_OPTIONS.map(
  (p) => p.id
);

const VALID_COVER_PROVIDER_SET = new Set<string>(DEFAULT_COVER_PROVIDERS);

export function normalizeCoverProviders(raw: unknown): CoverProviderSettingId[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_COVER_PROVIDERS];
  }
  const wanted = new Set(
    raw.map((x) => String(x || '').trim()).filter((x) => VALID_COVER_PROVIDER_SET.has(x))
  );
  return COVER_PROVIDER_OPTIONS.map((p) => p.id).filter((id) => wanted.has(id));
}

export interface CoverSearchCandidate {
  id: string;
  provider: CoverProviderId;
  providerLabel: string;
  sourceLabel: string;
  title: string;
  artist: string;
  date?: string;
  details?: string;
  imageUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  format?: string;
  mbid?: string;
  discogsId?: string;
  asin?: string;
}

export type BatchStage =
  | 'queued'
  | 'ripping'
  | 'encoding_flac'
  | 'encoding_mp3'
  | 'tagging'
  | 'done'
  | 'error'
  | 'cancelled';

export interface TrackMetadata {
  id: string;
  trackNumber: number;
  discNumber?: number;
  discSubtitle?: string;
  title: string;
  artist: string;
  artists?: string[];
  artistSort?: string;
  durationSeconds: number;
  exactDurationSeconds?: number;
  startLsn?: number;
  endLsn?: number;
  genre?: string;
  isrc: string;
  isrcs?: string[];
  composer: string;
  orchestra?: string;
  conductor?: string;
  lyricist?: string;
  writer?: string;
  producer?: string;
  arranger?: string;
  engineer?: string;
  mixer?: string;
  djmixer?: string;
  remixer?: string;
  performers?: string[];
  work?: string;
  workLanguage?: string;
  musicbrainzRecordingId?: string;
  musicbrainzTrackId?: string;
  musicbrainzArtistId?: string;
  musicbrainzWorkId?: string;
  musicbrainzComposerId?: string;
  shazamKey?: string;
  shazamUrl?: string;
  metadataSource?: string;
  originalTitle?: string;
  originalArtist?: string;
  originalGenre?: string;
  originalMetadataSource?: string;
  shazamTitle?: string;
  shazamArtist?: string;
  shazamGenre?: string;
  shazamMetadataSource?: string;
  mbTitle?: string;
  mbArtist?: string;
  mbGenre?: string;
  mbMetadataSource?: string;
  activeMetadataVariant?: 'original' | 'shazam' | 'musicbrainz';
  hasShazamAlternative?: boolean;
  hasMbAlternative?: boolean;
  selected: boolean;
  sourceFileName?: string;
  sourceFileSize?: number;
  sourceFile?: File;
  extraTags?: Record<string, string[]>;
  audioHealthStatus?: 'scanning' | 'ok' | 'info' | 'warning' | 'critical';
  audioHealthColor?: string;
  audioHealthTooltip?: string;
}

export interface AlbumMetadata {
  title: string;
  artist: string;
  albumArtist: string;
  albumArtists?: string[];
  albumArtistSort?: string;
  isClassical?: boolean;
  composer?: string;
  orchestra?: string;
  conductor?: string;
  year: string;
  releaseDate?: string;
  originalDate?: string;
  genre: string;
  label: string;
  catalogNumber?: string;
  barcode?: string;
  asin?: string;
  country?: string;
  status?: string;
  releaseType?: string;
  mediaFormat?: string;
  discSubtitle?: string;
  script?: string;
  language?: string;
  discNumber: number;
  totalDiscs: number;
  cddbId: string;
  musicbrainzDiscId?: string;
  musicbrainzToc?: string;
  trackOffsets?: number[];
  leadoutOffset?: number;
  musicbrainzReleaseId: string;
  musicbrainzReleaseGroupId?: string;
  musicbrainzAlbumArtistId?: string;
  discogsId?: string;
  metadataSource?: string;
  coverArtUrl: string | null;
  coverArtSource: string;
  coverArtWidth?: number;
  coverArtHeight?: number;
  coverArtSizeBytes?: number;
  coverArtFormat?: string;
  coverArtOriginalFormat?: string;
  discs?: Array<{
    position: number;
    title: string;
    format: string;
    trackCount: number;
  }>;
  albumSort?: string;
  subtitle?: string;
  copyright?: string;
  grouping?: string;
  compilation?: string;
  mood?: string;
  comment?: string;
  lyricist?: string;
  writer?: string;
  producer?: string;
  arranger?: string;
  engineer?: string;
  mixer?: string;
  djmixer?: string;
  remixer?: string;
  work?: string;
  workLanguage?: string;
  extraTags?: Record<string, string[]>;
  tracks: TrackMetadata[];
}

export type LeftTagFieldCategory = 'basis' | 'release' | 'credits' | 'identifiers';

export interface MusicBrainzLeftTagFieldSpec {
  id: string;
  label: string;
  mbTag: string;
  category: LeftTagFieldCategory;
  defaultVisible: boolean;
  trackTransferKey?: keyof TrackMetadata;
  placeholder?: string;
}

export const MUSICBRAINZ_LEFT_TAG_FIELDS: MusicBrainzLeftTagFieldSpec[] = [
  // Bisherige Standardfelder (standardmäßig aktiviert)
  { id: 'title', label: 'Albumtitel', mbTag: 'ALBUM', category: 'basis', defaultVisible: true },
  { id: 'albumArtist', label: 'Album-Interpret', mbTag: 'ALBUMARTIST', category: 'basis', defaultVisible: true },
  {
    id: 'artist',
    label: 'Künstler (Standard für Titel)',
    mbTag: 'ARTIST',
    category: 'basis',
    defaultVisible: true,
    trackTransferKey: 'artist',
  },
  { id: 'discNumber', label: 'CD-Nr. / Gesamt-CDs', mbTag: 'DISCNUMBER / TOTALDISCS', category: 'basis', defaultVisible: true },
  { id: 'year', label: 'Jahr', mbTag: 'DATE (YEAR)', category: 'basis', defaultVisible: true },
  { id: 'genre', label: 'Genre', mbTag: 'GENRE', category: 'basis', defaultVisible: true, trackTransferKey: 'genre' },
  { id: 'label', label: 'Label', mbTag: 'LABEL', category: 'basis', defaultVisible: true },
  { id: 'cddbId', label: 'CDDB DiscID', mbTag: 'CDDB DISCID', category: 'identifiers', defaultVisible: true },
  {
    id: 'musicbrainzReleaseId',
    label: 'MusicBrainz Release-ID',
    mbTag: 'MUSICBRAINZ_ALBUMID',
    category: 'identifiers',
    defaultVisible: true,
  },
  { id: 'discogsId', label: 'Discogs Release-ID', mbTag: 'DISCOGS_RELEASE_ID', category: 'identifiers', defaultVisible: true },
  { id: 'asin', label: 'Amazon ASIN', mbTag: 'ASIN', category: 'identifiers', defaultVisible: true },
  { id: 'barcode', label: 'Barcode (EAN / UPC) & QR-Code', mbTag: 'BARCODE', category: 'identifiers', defaultVisible: true },

  // Weitere gängige MusicBrainz-Tags (optional zuschaltbar)
  { id: 'albumArtistSort', label: 'Album-Interpret (Sortiername)', mbTag: 'ALBUMARTISTSORT', category: 'basis', defaultVisible: false, placeholder: 'z. B. Beatles, The' },
  { id: 'albumSort', label: 'Albumtitel (Sortiername)', mbTag: 'ALBUMSORT', category: 'basis', defaultVisible: false, placeholder: 'Sortiertitel des Albums' },
  { id: 'subtitle', label: 'Album-Untertitel / Edition', mbTag: 'SUBTITLE', category: 'release', defaultVisible: false, placeholder: 'z. B. Deluxe Edition' },
  { id: 'discSubtitle', label: 'CD-Untertitel', mbTag: 'DISCSUBTITLE', category: 'release', defaultVisible: false, trackTransferKey: 'discSubtitle', placeholder: 'z. B. Live in Berlin' },
  { id: 'releaseDate', label: 'Veröffentlichungsdatum', mbTag: 'DATE', category: 'release', defaultVisible: false, placeholder: 'JJJJ-MM-TT' },
  { id: 'originalDate', label: 'Erstveröffentlichung', mbTag: 'ORIGINALDATE', category: 'release', defaultVisible: false, placeholder: 'JJJJ-MM-TT' },
  { id: 'catalogNumber', label: 'Katalognummer', mbTag: 'CATALOGNUMBER', category: 'release', defaultVisible: false, placeholder: 'z. B. 1C 064-46 311' },
  { id: 'country', label: 'Erscheinungsland', mbTag: 'RELEASECOUNTRY', category: 'release', defaultVisible: false, placeholder: 'z. B. DE, US, GB' },
  { id: 'status', label: 'Release-Status', mbTag: 'RELEASESTATUS', category: 'release', defaultVisible: false, placeholder: 'z. B. official, promotion' },
  { id: 'releaseType', label: 'Release-Typ', mbTag: 'RELEASETYPE', category: 'release', defaultVisible: false, placeholder: 'z. B. album, compilation, live' },
  { id: 'mediaFormat', label: 'Medienformat', mbTag: 'MEDIA', category: 'release', defaultVisible: false, placeholder: 'z. B. CD, Vinyl, Digital Media' },
  { id: 'script', label: 'Schriftsystem', mbTag: 'SCRIPT', category: 'release', defaultVisible: false, placeholder: 'z. B. Latn, Cyrl, Jpan' },
  { id: 'language', label: 'Sprache', mbTag: 'LANGUAGE', category: 'release', defaultVisible: false, placeholder: 'z. B. deu, eng' },
  { id: 'compilation', label: 'Compilation-Flag (0/1)', mbTag: 'COMPILATION', category: 'release', defaultVisible: false, placeholder: '1 für Sampler / VA' },

  { id: 'composer', label: 'Komponist', mbTag: 'COMPOSER', category: 'credits', defaultVisible: false, trackTransferKey: 'composer', placeholder: 'Mehrere mit ; trennen' },
  { id: 'orchestra', label: 'Orchester / Ensemble', mbTag: 'PERFORMER:orchestra', category: 'credits', defaultVisible: false, trackTransferKey: 'orchestra', placeholder: 'Mehrere mit ; trennen' },
  { id: 'conductor', label: 'Dirigent', mbTag: 'CONDUCTOR', category: 'credits', defaultVisible: false, trackTransferKey: 'conductor', placeholder: 'Mehrere mit ; trennen' },
  { id: 'lyricist', label: 'Texter / Liedtexter', mbTag: 'LYRICIST', category: 'credits', defaultVisible: false, trackTransferKey: 'lyricist', placeholder: 'Mehrere mit ; trennen' },
  { id: 'writer', label: 'Autor / Songwriter', mbTag: 'WRITER', category: 'credits', defaultVisible: false, trackTransferKey: 'writer', placeholder: 'Mehrere mit ; trennen' },
  { id: 'producer', label: 'Produzent', mbTag: 'PRODUCER', category: 'credits', defaultVisible: false, trackTransferKey: 'producer', placeholder: 'Mehrere mit ; trennen' },
  { id: 'arranger', label: 'Arrangeur', mbTag: 'ARRANGER', category: 'credits', defaultVisible: false, trackTransferKey: 'arranger', placeholder: 'Mehrere mit ; trennen' },
  { id: 'engineer', label: 'Toningenieur', mbTag: 'ENGINEER', category: 'credits', defaultVisible: false, trackTransferKey: 'engineer', placeholder: 'Mehrere mit ; trennen' },
  { id: 'mixer', label: 'Mix-Ingenieur', mbTag: 'MIXER', category: 'credits', defaultVisible: false, trackTransferKey: 'mixer', placeholder: 'Mehrere mit ; trennen' },
  { id: 'djmixer', label: 'DJ-Mixer', mbTag: 'DJMIXER', category: 'credits', defaultVisible: false, trackTransferKey: 'djmixer', placeholder: 'Mehrere mit ; trennen' },
  { id: 'remixer', label: 'Remixer', mbTag: 'REMIXER', category: 'credits', defaultVisible: false, trackTransferKey: 'remixer', placeholder: 'Mehrere mit ; trennen' },
  { id: 'work', label: 'Werk (Work)', mbTag: 'WORK', category: 'credits', defaultVisible: false, trackTransferKey: 'work', placeholder: 'Werkname' },
  { id: 'copyright', label: 'Copyright / Urheberrecht', mbTag: 'COPYRIGHT', category: 'basis', defaultVisible: false, placeholder: 'z. B. ℗ 1981 Kling Klang' },
  { id: 'grouping', label: 'Gruppierung / Zyklus', mbTag: 'GROUPING', category: 'basis', defaultVisible: false, placeholder: 'Übergeordnete Werkgruppe' },
  { id: 'mood', label: 'Stimmung (Mood)', mbTag: 'MOOD', category: 'basis', defaultVisible: false, placeholder: 'z. B. Energetic, Melancholic' },
  { id: 'comment', label: 'Kommentar', mbTag: 'COMMENT', category: 'basis', defaultVisible: false, placeholder: 'Freier Kommentar-Tag' },

  { id: 'musicbrainzReleaseGroupId', label: 'MusicBrainz Release-Group-ID', mbTag: 'MUSICBRAINZ_RELEASEGROUPID', category: 'identifiers', defaultVisible: false, placeholder: 'UUID' },
  { id: 'musicbrainzAlbumArtistId', label: 'MusicBrainz Album-Artist-ID', mbTag: 'MUSICBRAINZ_ALBUMARTISTID', category: 'identifiers', defaultVisible: false, placeholder: 'UUID' },
  { id: 'musicbrainzDiscId', label: 'MusicBrainz DiscID', mbTag: 'MUSICBRAINZ_DISCID', category: 'identifiers', defaultVisible: false, placeholder: '28-stellige DiscID' },
];

export const DEFAULT_VISIBLE_LEFT_TAG_FIELDS: string[] = MUSICBRAINZ_LEFT_TAG_FIELDS
  .filter((f) => f.defaultVisible)
  .map((f) => f.id);

export type ShazamSampleSize = 128000 | 192000 | 256000 | 320000 | 384000;

export const DEFAULT_SHAZAM_SAMPLE_SIZE: ShazamSampleSize = 384000;

export const SHAZAM_SAMPLE_SIZE_OPTIONS: Array<{
  value: ShazamSampleSize;
  label: string;
  seconds: number;
}> = [
  { value: 128000, label: '128000 – schnell, aber ungenauer (8 Sek.)', seconds: 8 },
  { value: 192000, label: '192000 – zügig, solide Erkennung (12 Sek.)', seconds: 12 },
  { value: 256000, label: '256000 – ausgewogen (16 Sek.)', seconds: 16 },
  { value: 320000, label: '320000 – präzise, längeres Sample (20 Sek.)', seconds: 20 },
  { value: 384000, label: '384000 – langsam, aber präziser (24 Sek.)', seconds: 24 },
];

export function normalizeShazamSampleSize(raw: unknown): ShazamSampleSize {
  const num = Number(raw);
  const match = SHAZAM_SAMPLE_SIZE_OPTIONS.find((opt) => opt.value === num);
  return match ? match.value : DEFAULT_SHAZAM_SAMPLE_SIZE;
}

export const DEFAULT_COVER_MAX_DIMENSION = 2048;

export function normalizeCoverMaxDimension(raw: unknown): number {
  const num = Math.round(Number(raw));
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_COVER_MAX_DIMENSION;
  return Math.max(256, Math.min(8192, num));
}

export const DEFAULT_MAX_THREADS = 4;

export function normalizeMaxThreads(raw: unknown): number {
  const num = Math.round(Number(raw));
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_MAX_THREADS;
  return Math.max(1, Math.min(16, num));
}

export const DEFAULT_MODULE_OUTPUT_DIRS = {
  outputDirCover: '~/Musik/01_Coverbilder',
  outputDirRip: '~/Musik/02_CD-Rips',
  outputDirTag: '~/Musik/03_Album_getaggt',
  outputDirConvert: '~/Musik/04_konvertiert',
  outputDirRepair: '~/Musik/05_repariert',
  outputDirCut: '~/Musik/06_geschnitten',
} as const;

export const DEFAULT_MUSICBRAINZ_SERVER_URL = 'https://musicbrainz.org/ws/2';

export function normalizeMusicBrainzServerUrl(raw: unknown): string {
  const val = String(raw || '').trim().replace(/\/+$/, '');
  if (!val) return DEFAULT_MUSICBRAINZ_SERVER_URL;
  if (!val.startsWith('https://') && !val.startsWith('http://')) {
    return DEFAULT_MUSICBRAINZ_SERVER_URL;
  }
  return val.endsWith('/ws/2') ? val : `${val}/ws/2`;
}

export interface ExportSettings {
  outputDir: string;
  outputDirCover?: string;
  outputDirRip?: string;
  outputDirTag?: string;
  outputDirConvert?: string;
  outputDirRepair?: string;
  outputDirCut?: string;
  filenameTemplate: string;
  exportFormat: ExportFormat;
  flacCompressionLevel: number;
  flacVerify: boolean;
  flacReplayGain: boolean;
  mp3Quality: Mp3QualityMode;
  id3v2Version: 3 | 4;
  normalizeAlbum: boolean;
  normalizeTargetLufs: number;
  normalizeComputeAlbumGain: boolean;
  normalizeUseLoudestTrack: boolean;
  normalizeTruePeak: boolean;
  normalizeWriteRefLoudnessTag: boolean;
  embedCoverArt: boolean;
  saveFolderCover: boolean;
  coverFilename: string;
  coverMaxDimension?: number;
  coverProviders?: CoverProviderSettingId[];
  maxThreads?: number;
  ejectAfterRip: boolean;
  paranoiaMode: ParanoiaMode;
  discogsToken?: string;
  lastfmApiKey?: string;
  musicbrainzServerUrl?: string;
  mbLoadDeepRelations?: boolean;
  preferSubgenres?: boolean;
  autoEnrichTrackGenres?: boolean;
  showQueryLog?: boolean;
  convertRomanNumerals: boolean;
  lastImportFolder?: string;
  lastCoverFolder?: string;
  scannerDevice?: string;
  scannerDpi?: 150 | 300 | 600 | 1200;
  scannerColorMode?: 'Color' | 'Gray' | 'Lineart';
  scannerScanArea?: 'cd_booklet' | 'cd_inlay' | 'full';
  scannerAutoOpenCrop?: boolean;
  visibleLeftTagFields?: string[];
  shazamSampleSize?: ShazamSampleSize;
}

export interface BatchJob {
  jobId: string;
  batchGroupId?: string;
  batchGroupLabel?: string;
  discNumber?: number;
  totalDiscs?: number;
  devicePath: string;
  albumTitle: string;
  albumArtist: string;
  trackArtist?: string;
  trackNumber: number;
  trackTitle: string;
  durationSeconds: number;
  exportFormat: ExportFormat;
  mp3Quality: Mp3QualityMode;
  id3v2Version?: 3 | 4;
  normalizeAlbum?: boolean;
  normalizeTargetLufs?: number;
  flacCompressionLevel: number;
  outputStem: string;
  sourceKind: 'cdparanoia' | 'local_file';
  tagOnly?: boolean;
  sourceFileName?: string;
  sourceFile?: File;
  tagOverrides?: Record<string, string>;
  convertedUrl?: string;
  convertedFileName?: string;
  stage: BatchStage;
  progress: number;
  statusMessage: string;
  outputFiles: string[];
}

export interface MusicBrainzSearchResult {
  id: string;
  source?: 'musicbrainz' | 'discogs' | 'cddb';
  title: string;
  artist: string;
  date: string;
  country: string;
  barcode: string;
  catno?: string;
  trackCount: number;
  mediumCount?: number;
  matchedDiscNumber?: number;
  method?: string;
  label: string;
  score: number;
  genres?: string[];
  hasCover?: boolean;
  qualityScore?: number;
  qualityBadges?: string[];
}

export interface PythonProjectFile {
  path: string;
  name: string;
  language: string;
  content: string;
  size: number;
}

export type ActiveWorkspaceTab =
  | 'home'
  | 'module_cover'
  | 'module_rip'
  | 'module_tag'
  | 'module_convert'
  | 'module_repair'
  | 'module_cut'
  | 'settings'
  | 'batch'
  | 'icons'
  | 'source';
