// Estado do editor: timeline, histórico (desfazer/refazer), seleção, reprodução e salvamento automático.
import { create } from 'zustand';
import { api, ApiError } from '../lib/api.ts';
import { showError } from '../lib/store.ts';
import type { Asset, CaptionWord, Project, Timeline } from '../../../shared/types.ts';

export type Selection = { kind: 'clip' | 'overlay' | 'cue' | 'layer' | 'audio'; id: string } | null;
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
export type PanelTab = 'chat' | 'media' | 'captions' | 'effects' | 'text' | 'music' | 'elements' | 'post' | 'format';

const HISTORY_LIMIT = 200;
const draftKey = (id: string) => `orbit.draft.${id}`;

interface EditorState {
  project: Project | null;
  timeline: Timeline | null;
  revision: number;
  assets: Record<string, Asset>;
  transcripts: Record<string, CaptionWord[]>;
  past: { tl: Timeline; label: string }[];
  future: { tl: Timeline; label: string }[];
  selection: Selection;
  time: number;
  playing: boolean;
  zoom: number;
  saveState: SaveState;
  saveError: string;
  tab: PanelTab;
  /** Rascunho local mais novo que o salvo no servidor (queda de energia, aba fechada…). */
  recoverable: Timeline | null;

  load: (id: string) => Promise<void>;
  reset: () => void;
  commit: (tl: Timeline, label: string) => void;
  /** Atualização temporária durante arrastos (não entra no histórico). */
  preview: (tl: Timeline) => void;
  /** Fecha um gesto iniciado com preview, registrando o estado anterior no histórico. */
  endGesture: (before: Timeline, label: string) => void;
  undo: () => void;
  redo: () => void;
  select: (s: Selection) => void;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setZoom: (z: number) => void;
  setTab: (t: PanelTab) => void;
  save: () => Promise<void>;
  refreshAssets: () => Promise<void>;
  loadTranscript: (assetId: string) => Promise<CaptionWord[] | null>;
  setProjectMeta: (patch: { name?: string; status?: string }) => Promise<void>;
  applyRecovery: (accept: boolean) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastCommit = { label: '', at: 0 };
const CONTINUOUS = new Set(['Cor', 'Transformar', 'Volume da faixa', 'Volume', 'Foco', 'Tamanho do elemento', 'Opacidade', 'Estilo da legenda', 'Tempo do elemento', 'Ajustar tempo da legenda']);

function storeDraft(projectId: string, tl: Timeline, baseRevision: number) {
  try {
    localStorage.setItem(draftKey(projectId), JSON.stringify({ tl, baseRevision, at: Date.now() }));
  } catch {
    /* sem armazenamento local */
  }
}

function clearDraft(projectId: string) {
  try {
    localStorage.removeItem(draftKey(projectId));
  } catch {
    /* sem armazenamento local */
  }
}

export const useEditor = create<EditorState>((set, get) => {
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => get().save(), 1200);
  };

  return {
    project: null,
    timeline: null,
    revision: 0,
    assets: {},
    transcripts: {},
    past: [],
    future: [],
    selection: null,
    time: 0,
    playing: false,
    zoom: 60,
    saveState: 'saved',
    saveError: '',
    tab: 'media',
    recoverable: null,

    load: async (id) => {
      const project = await api.get<Project>(`/api/projects/${id}`);
      const assetList = await api.get<Asset[]>(`/api/assets?brandId=${project.brandId}`);
      const assets = Object.fromEntries(assetList.map((a) => [a.id, a]));
      let recoverable: Timeline | null = null;
      try {
        const raw = localStorage.getItem(draftKey(id));
        if (raw) {
          const d = JSON.parse(raw);
          if (d.baseRevision === project.revision && JSON.stringify(d.tl) !== JSON.stringify(project.timeline)) recoverable = d.tl;
          else localStorage.removeItem(draftKey(id));
        }
      } catch {
        /* rascunho ilegível */
      }
      set({
        project,
        timeline: project.timeline,
        revision: project.revision,
        assets,
        past: [],
        future: [],
        selection: null,
        time: 0,
        playing: false,
        saveState: 'saved',
        recoverable,
        tab: project.timeline.clips.length ? 'chat' : 'media',
      });
      const ids = new Set(project.timeline.clips.map((c) => c.assetId));
      for (const a of ids) get().loadTranscript(a);
    },

    reset: () => set({ project: null, timeline: null, past: [], future: [], selection: null, playing: false, time: 0 }),

    commit: (tl, label) => {
      const cur = get().timeline;
      if (!cur || cur === tl) return;
      // Ajustes contínuos (sliders) com o mesmo rótulo viram um único passo de desfazer.
      const now = Date.now();
      const coalesce = CONTINUOUS.has(label) && lastCommit.label === label && now - lastCommit.at < 900 && get().past.length > 0;
      lastCommit = { label, at: now };
      if (coalesce) set({ timeline: tl, future: [], saveState: 'dirty' });
      else set((s) => ({ timeline: tl, past: [...s.past, { tl: cur, label }].slice(-HISTORY_LIMIT), future: [], saveState: 'dirty' }));
      storeDraft(get().project!.id, tl, get().revision);
      scheduleSave();
    },

    preview: (tl) => set({ timeline: tl }),

    endGesture: (before, label) => {
      const cur = get().timeline;
      if (!cur || JSON.stringify(cur) === JSON.stringify(before)) return;
      set((s) => ({ past: [...s.past, { tl: before, label }].slice(-HISTORY_LIMIT), future: [], saveState: 'dirty' }));
      storeDraft(get().project!.id, cur, get().revision);
      scheduleSave();
    },

    undo: () => {
      const { past, timeline } = get();
      if (!past.length || !timeline) return;
      const prev = past[past.length - 1];
      set((s) => ({ timeline: prev.tl, past: s.past.slice(0, -1), future: [{ tl: timeline, label: prev.label }, ...s.future], saveState: 'dirty' }));
      scheduleSave();
    },

    redo: () => {
      const { future, timeline } = get();
      if (!future.length || !timeline) return;
      const next = future[0];
      set((s) => ({ timeline: next.tl, future: s.future.slice(1), past: [...s.past, { tl: timeline, label: next.label }], saveState: 'dirty' }));
      scheduleSave();
    },

    select: (selection) => set({ selection }),
    setTime: (time) => set({ time }),
    setPlaying: (playing) => set({ playing }),
    setZoom: (zoom) => set({ zoom: Math.min(400, Math.max(4, zoom)) }),
    setTab: (tab) => set({ tab }),

    save: async () => {
      const { project, timeline, revision, saveState } = get();
      if (!project || !timeline || saveState === 'saving' || saveState === 'conflict') return;
      set({ saveState: 'saving' });
      const sent = timeline;
      try {
        const r = await api.put(`/api/projects/${project.id}`, { timeline: sent, baseRevision: revision });
        const changedMeanwhile = get().timeline !== sent;
        set({ revision: r.revision, saveState: changedMeanwhile ? 'dirty' : 'saved', saveError: '', project: { ...project, status: r.status } });
        if (changedMeanwhile) scheduleSave();
        else clearDraft(project.id);
      } catch (e) {
        const err = e as ApiError;
        if (err.status === 409) set({ saveState: 'conflict', saveError: err.message + ' ' + err.hint });
        else {
          set({ saveState: 'error', saveError: err.message });
          // tenta novamente em alguns segundos; o rascunho local protege o trabalho
          setTimeout(() => get().saveState === 'error' && (set({ saveState: 'dirty' }), get().save()), 5000);
        }
      }
    },

    refreshAssets: async () => {
      const p = get().project;
      if (!p) return;
      const list = await api.get<Asset[]>(`/api/assets?brandId=${p.brandId}`);
      set({ assets: Object.fromEntries(list.map((a) => [a.id, a])) });
    },

    loadTranscript: async (assetId) => {
      try {
        const t = await api.get<{ words: CaptionWord[] } | null>(`/api/assets/${assetId}/transcript`);
        if (t) set((s) => ({ transcripts: { ...s.transcripts, [assetId]: t.words } }));
        return t?.words ?? null;
      } catch (e) {
        showError(e);
        return null;
      }
    },

    setProjectMeta: async (patch) => {
      const p = get().project;
      if (!p) return;
      await get().save();
      try {
        const r = await api.put(`/api/projects/${p.id}`, { ...patch, baseRevision: get().revision });
        set({ revision: r.revision, project: { ...p, name: r.name, status: r.status } });
      } catch (e) {
        showError(e);
      }
    },

    applyRecovery: (accept) => {
      const { recoverable } = get();
      if (accept && recoverable) get().commit(recoverable, 'Recuperar alterações não salvas');
      else if (get().project) clearDraft(get().project!.id);
      set({ recoverable: null });
    },
  };
});
