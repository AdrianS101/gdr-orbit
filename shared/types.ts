// Tipos compartilhados entre servidor e interface.
// A timeline é a fonte única da verdade: a prévia e a exportação leem o mesmo objeto.

export type FormatPreset = '9:16' | '16:9' | '1:1' | '4:5' | 'custom';

export interface OutputFormat {
  preset: FormatPreset;
  width: number;
  height: number;
  fps: number;
}

/** Como o vídeo preenche o quadro de saída. */
export type FitMode = 'cover' | 'contain' | 'blur';

/** Trecho na faixa principal de vídeo (faixa magnética: os trechos ficam em sequência, sem buracos). */
export interface VideoClip {
  id: string;
  assetId: string;
  /** Início e fim no arquivo original, em segundos. */
  in: number;
  out: number;
  speed: number;
  /** 0 a 2 (100% = 1). */
  volume: number;
  fit: FitMode;
  /** Ponto de foco do reenquadramento (0..1), usado quando fit = cover/blur. */
  focusX: number;
  focusY: number;
  /** Ajustes de cor (opcional). */
  color?: ColorAdjust;
  /** Zoom animado ao longo do trecho (1 = sem zoom). */
  zoom?: { from: number; to: number };
  /** Transição na entrada deste trecho (entre o trecho anterior e este). */
  transition?: { type: TransitionType; duration: number };
}

export type TransitionType = 'fade' | 'flash' | 'zoom';

export interface ColorAdjust {
  preset: string;
  brightness: number;
  contrast: number;
  saturation: number;
  /** -1 (frio) a 1 (quente). */
  temperature: number;
}

export type TextStyleKind = 'title' | 'lower' | 'cta' | 'caption';
export type TextAnim = 'fade' | 'pop' | 'slide' | 'none';

/** Texto sobreposto (títulos, lower thirds, chamadas) — renderizado pela libass como as legendas. */
export interface TextClip {
  id: string;
  start: number;
  end: number;
  text: string;
  kind: TextStyleKind;
  anim: TextAnim;
  x: number;
  y: number;
  /** % do menor lado do quadro. */
  size: number;
  color: string;
  bg: string;
  font: string;
}

export interface MusicTrack {
  assetId: string;
  /** 0..1 */
  volume: number;
  /** Baixa a música enquanto há fala (com base na transcrição). */
  ducking: boolean;
  duckLevel: number;
  fadeIn: number;
  fadeOut: number;
  /** Início dentro do arquivo de música. */
  offset: number;
}

/** Imagem sobreposta (logo, selo, elemento). Posição normalizada pelo centro. */
export interface OverlayClip {
  id: string;
  assetId: string;
  start: number;
  end: number;
  x: number;
  y: number;
  /** Largura relativa à largura do quadro (0..1). */
  width: number;
  opacity: number;
}

/** Palavra ancorada no tempo do arquivo original — sobrevive a cortes e reordenações. */
export interface CaptionWord {
  text: string;
  s: number;
  e: number;
}

export interface CaptionCue {
  id: string;
  assetId: string;
  words: CaptionWord[];
  /** Índices de palavras após as quais há quebra de linha manual. */
  breaks?: number[];
}

export type CaptionPreset = 'classic' | 'highlight' | 'pop' | 'karaoke' | 'box';

export interface CaptionStyle {
  preset: CaptionPreset;
  font: string;
  /** Tamanho em % do menor lado do quadro. */
  size: number;
  bold: boolean;
  uppercase: boolean;
  textColor: string;
  highlightColor: string;
  outlineColor: string;
  /** Espessura do contorno em % do tamanho da fonte. */
  outline: number;
  shadow: number;
  boxColor: string;
  boxOpacity: number;
  /** Centro vertical do bloco de legenda (0 = topo, 1 = base). */
  posY: number;
  /** Largura máxima de linha em caracteres. */
  maxCharsPerLine: number;
  /** Máximo de palavras por legenda ao gerar. */
  maxWordsPerCue: number;
}

export interface Timeline {
  version: 1;
  format: OutputFormat;
  clips: VideoClip[];
  overlays: OverlayClip[];
  captions: {
    enabled: boolean;
    style: CaptionStyle;
    cues: CaptionCue[];
  };
  audio: {
    normalize: boolean;
  };
  texts?: TextClip[];
  music?: MusicTrack | null;
}

export interface Brand {
  id: string;
  name: string;
  slug: string;
  profile: BrandProfile;
  createdAt: string;
  updatedAt: string;
}

export interface BrandProfile {
  description: string;
  productsServices: string;
  audience: string;
  positioning: string;
  objectives: string;
  toneOfVoice: string;
  communicationExamples: string;
  wordsToUse: string;
  wordsToAvoid: string;
  colors: { name: string; hex: string }[];
  fonts: string;
  visualReferences: string;
  knowledgeBase: string;
  logoAssetId: string | null;
  captionStyle: Partial<CaptionStyle> | null;
}

export type AssetKind = 'video' | 'audio' | 'image' | 'font';

export interface AssetMeta {
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  rotation?: number;
  /** Proporção do pixel (1 = quadrado). width/height já são as dimensões de exibição. */
  sar?: number;
}

export interface Asset {
  id: string;
  brandId: string;
  kind: AssetKind;
  name: string;
  size: number;
  sha256: string;
  meta: AssetMeta;
  status: 'processing' | 'ready' | 'failed';
  hasProxy: boolean;
  hasWaveform: boolean;
  hasFilmstrip: boolean;
  filmstrip?: { interval: number; frames: number; tileW: number; tileH: number; cols: number } | null;
  tags: string[];
  source: string;
  createdAt: string;
  transcriptStatus?: 'none' | 'ready';
  usage?: { projects: number; posts: number };
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';
export type JobType = 'ingest' | 'transcribe' | 'render' | 'publish' | 'drive' | 'metrics';

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  message: string;
  brandId: string | null;
  projectId: string | null;
  assetId: string | null;
  title: string;
  error: string | null;
  result: any;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type ProjectStatus = 'draft' | 'editing' | 'review' | 'approved';

export interface ProjectSummary {
  id: string;
  brandId: string;
  name: string;
  status: ProjectStatus;
  revision: number;
  duration: number;
  format: OutputFormat;
  thumbAssetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project extends ProjectSummary {
  timeline: Timeline;
}
