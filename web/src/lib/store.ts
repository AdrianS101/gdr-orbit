import { create } from 'zustand';
import type { Brand, Job } from '../../../shared/types.ts';
import { api, ApiError } from './api.ts';

export type BrandWithMissing = Brand & { missing: string[] };

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  title: string;
  hint?: string;
}

interface AppState {
  brands: BrandWithMissing[];
  brandsLoaded: boolean;
  /** 'all' = visão geral da operação; caso contrário, id da marca. */
  scope: string;
  jobs: Record<string, Job>;
  toasts: Toast[];
  loadBrands: () => Promise<void>;
  setScope: (s: string) => void;
  upsertJob: (j: Job) => void;
  removeJob: (id: string) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
}

const SCOPE_KEY = 'orbit.scope';
function readScope() {
  try {
    return localStorage.getItem(SCOPE_KEY) || 'all';
  } catch {
    return 'all';
  }
}

let toastSeq = 1;

export const useApp = create<AppState>((set, get) => ({
  brands: [],
  brandsLoaded: false,
  scope: readScope(),
  jobs: {},
  toasts: [],
  loadBrands: async () => {
    const brands = await api.get<BrandWithMissing[]>('/api/brands');
    const scope = get().scope;
    set({ brands, brandsLoaded: true, scope: scope !== 'all' && !brands.some((b) => b.id === scope) ? 'all' : scope });
  },
  setScope: (scope) => {
    try {
      localStorage.setItem(SCOPE_KEY, scope);
    } catch {
      /* armazenamento indisponível */
    }
    set({ scope });
  },
  upsertJob: (j) => set((s) => ({ jobs: { ...s.jobs, [j.id]: j } })),
  removeJob: (id) =>
    set((s) => {
      const jobs = { ...s.jobs };
      delete jobs[id];
      return { jobs };
    }),
  toast: (t) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 9000 : 4500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Mostra um erro da API de forma amigável. */
export function showError(e: unknown, fallback = 'Algo deu errado.') {
  if ((e as Error)?.name === 'AbortError') return;
  const err = e instanceof ApiError ? e : null;
  useApp.getState().toast({ kind: 'error', title: err?.message ?? (e as Error)?.message ?? fallback, hint: err?.hint });
}

export function currentBrand(): BrandWithMissing | null {
  const { scope, brands } = useApp.getState();
  return brands.find((b) => b.id === scope) ?? null;
}

// Eventos em tempo real da fila de processamento.
let es: EventSource | null = null;
export function connectEvents() {
  if (es) return;
  es = new EventSource('/api/events');
  es.addEventListener('job', (ev) => {
    const j = JSON.parse((ev as MessageEvent).data) as Job;
    useApp.getState().upsertJob(j);
    for (const fn of jobListeners) fn(j);
  });
  es.onerror = () => {
    // o navegador reconecta sozinho; ao voltar, recarregamos os trabalhos ativos
  };
  es.onopen = async () => {
    try {
      const jobs = await api.get<Job[]>('/api/jobs?limit=30');
      for (const j of jobs) useApp.getState().upsertJob(j);
    } catch {
      /* ignora */
    }
  };
}

const jobListeners = new Set<(j: Job) => void>();
export function onJob(fn: (j: Job) => void) {
  jobListeners.add(fn);
  return () => {
    jobListeners.delete(fn);
  };
}
