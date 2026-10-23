// Ações de edição usadas por botões, atalhos e painéis. Cada ação gera um passo no histórico.
import { useEditor } from './store.ts';
import { useApp } from '../lib/store.ts';
import { duplicateClip, layoutClips, removeClip, splitAt, uid, timelineDuration } from '../../../shared/timeline.ts';
import { buildCues } from '../../../shared/captions.ts';
import type { Asset, Timeline } from '../../../shared/types.ts';

const st = () => useEditor.getState();

export function splitAtPlayhead() {
  const { timeline, time, commit, select } = st();
  if (!timeline) return;
  const r = splitAt(timeline, time);
  if (!r.rightId) {
    useApp.getState().toast({ kind: 'info', title: 'Não é possível dividir aqui', hint: 'Posicione o cursor dentro de um trecho, a pelo menos 0,1 s das bordas.' });
    return;
  }
  commit(r.timeline, 'Dividir trecho');
  select({ kind: 'clip', id: r.rightId });
}

export function deleteSelection() {
  const { timeline, selection, commit, select } = st();
  if (!timeline || !selection) return;
  if (selection.kind === 'clip') commit(removeClip(timeline, selection.id), 'Excluir trecho');
  else if (selection.kind === 'overlay') commit({ ...timeline, overlays: timeline.overlays.filter((o) => o.id !== selection.id) }, 'Excluir elemento');
  else if (selection.kind === 'layer') commit({ ...timeline, layers: (timeline.layers ?? []).filter((o) => o.id !== selection.id) }, 'Excluir da faixa');
  else if (selection.kind === 'audio') commit({ ...timeline, audioClips: (timeline.audioClips ?? []).filter((o) => o.id !== selection.id) }, 'Excluir áudio');
  else commit({ ...timeline, captions: { ...timeline.captions, cues: timeline.captions.cues.filter((c) => c.id !== selection.id) } }, 'Excluir legenda');
  select(null);
}

export function duplicateSelection() {
  const { timeline, selection, commit, select } = st();
  if (!timeline || !selection) return;
  if (selection.kind === 'clip') {
    const r = duplicateClip(timeline, selection.id);
    if (r.newId) {
      commit(r.timeline, 'Duplicar trecho');
      select({ kind: 'clip', id: r.newId });
    }
  } else if (selection.kind === 'overlay') {
    const o = timeline.overlays.find((x) => x.id === selection.id);
    if (!o) return;
    const copy = { ...o, id: uid('o_'), x: Math.min(0.95, o.x + 0.04), y: Math.min(0.95, o.y + 0.04) };
    commit({ ...timeline, overlays: [...timeline.overlays, copy] }, 'Duplicar elemento');
    select({ kind: 'overlay', id: copy.id });
  } else if (selection.kind === 'layer' || selection.kind === 'audio') {
    const key = selection.kind === 'layer' ? 'layers' : 'audioClips';
    const list = (timeline[key] ?? []) as any[];
    const o = list.find((x) => x.id === selection.id);
    if (!o) return;
    const copy = { ...o, id: uid(selection.kind === 'layer' ? 'l_' : 'a_'), start: o.start + (o.out - o.in) };
    commit({ ...timeline, [key]: [...list, copy] }, 'Duplicar faixa');
    select({ kind: selection.kind, id: copy.id });
  }
}

export function addVideo(a: Asset) {
  const { timeline, commit } = st();
  if (!timeline || !a.meta.duration) return;
  const clip = { id: uid('c_'), assetId: a.id, in: 0, out: a.meta.duration, speed: 1, volume: 1, fit: 'cover' as const, focusX: 0.5, focusY: 0.5 };
  commit({ ...timeline, clips: [...timeline.clips, clip] }, 'Adicionar vídeo');
  st().loadTranscript(a.id);
}

export function addImageOverlay(a: Asset, preset: 'logo' | 'center' = 'logo') {
  const { timeline, commit, select } = st();
  if (!timeline || !a.meta.width) return;
  const total = timelineDuration(timeline) || 5;
  const vertical = timeline.format.height > timeline.format.width;
  const width = preset === 'logo' ? (vertical ? 0.2 : 0.11) : 0.5;
  const aspect = (a.meta.height ?? 1) / (a.meta.width ?? 1);
  const hFrac = (width * timeline.format.width * aspect) / timeline.format.height;
  // logo no canto superior direito, dentro da área segura das redes
  const o = {
    id: uid('o_'),
    assetId: a.id,
    start: 0,
    end: total,
    x: preset === 'logo' ? 1 - width / 2 - (vertical ? 0.06 : 0.03) : 0.5,
    y: preset === 'logo' ? (vertical ? 0.13 : 0.05) + hFrac / 2 : 0.5,
    width,
    opacity: 1,
  };
  commit({ ...timeline, overlays: [...timeline.overlays, o] }, preset === 'logo' ? 'Aplicar logo' : 'Adicionar imagem');
  select({ kind: 'overlay', id: o.id });
}

/** Gera as legendas a partir das transcrições dos vídeos usados na timeline. */
export function generateCaptions(): { created: number; missing: string[] } {
  const { timeline, transcripts, assets, commit } = st();
  if (!timeline) return { created: 0, missing: [] };
  const used = Array.from(new Set(timeline.clips.map((c) => c.assetId)));
  const missing = used.filter((id) => !transcripts[id]).map((id) => assets[id]?.name ?? id);
  const cues = used.flatMap((id) => {
    const words = transcripts[id];
    if (!words) return [];
    const ranges = timeline.clips.filter((c) => c.assetId === id).map((c) => ({ from: c.in, to: c.out }));
    return buildCues(id, words, timeline.captions.style, ranges);
  });
  commit({ ...timeline, captions: { ...timeline.captions, enabled: true, cues } }, 'Gerar legendas');
  return { created: cues.length, missing };
}

export function updateTimeline(fn: (tl: Timeline) => Timeline, label: string) {
  const { timeline, commit } = st();
  if (timeline) commit(fn(timeline), label);
}

export function seekBy(dt: number) {
  const { timeline, time, setTime, setPlaying } = st();
  if (!timeline) return;
  setPlaying(false);
  const total = layoutClips(timeline.clips).reduce((m, p) => Math.max(m, p.end), 0);
  setTime(Math.max(0, Math.min(total, time + dt)));
}
