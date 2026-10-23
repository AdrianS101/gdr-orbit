import type { Asset, Brand, BrandProfile, ProjectSummary, Timeline } from '../../../shared/types.ts';
import { timelineDuration } from '../../../shared/timeline.ts';
import { db } from '../db.ts';

export const EMPTY_PROFILE: BrandProfile = {
  description: '',
  productsServices: '',
  audience: '',
  positioning: '',
  objectives: '',
  toneOfVoice: '',
  communicationExamples: '',
  wordsToUse: '',
  wordsToAvoid: '',
  colors: [],
  fonts: '',
  visualReferences: '',
  knowledgeBase: '',
  logoAssetId: null,
  captionStyle: null,
};

export function rowToBrand(r: any): Brand {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    profile: { ...EMPTY_PROFILE, ...JSON.parse(r.profile) },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function rowToAsset(r: any): Asset {
  const hasTranscript = db.prepare('SELECT 1 FROM transcripts WHERE asset_id = ?').get(r.id);
  return {
    id: r.id,
    brandId: r.brand_id,
    kind: r.kind,
    name: r.name,
    size: r.size,
    sha256: r.sha256,
    meta: JSON.parse(r.meta),
    status: r.status,
    hasProxy: !!r.proxy,
    hasWaveform: !!r.waveform,
    hasFilmstrip: !!r.filmstrip,
    filmstrip: r.filmstrip ? JSON.parse(r.filmstrip) : null,
    tags: JSON.parse(r.tags),
    source: r.source,
    createdAt: r.created_at,
    transcriptStatus: hasTranscript ? 'ready' : 'none',
    usage: {
      projects: (db.prepare('SELECT COUNT(*) AS n FROM projects WHERE timeline LIKE ?').get(`%"${r.id}"%`) as any).n,
      posts: (db.prepare('SELECT COUNT(*) AS n FROM posts WHERE media LIKE ?').get(`%"${r.id}"%`) as any).n,
    },
  };
}

export function rowToProjectSummary(r: any): ProjectSummary {
  const tl = JSON.parse(r.timeline) as Timeline;
  return {
    id: r.id,
    brandId: r.brand_id,
    name: r.name,
    status: r.status,
    revision: r.revision,
    duration: timelineDuration(tl),
    format: tl.format,
    thumbAssetId: tl.clips[0]?.assetId ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
