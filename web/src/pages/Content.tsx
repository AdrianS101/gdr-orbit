// Conteúdo e calendário: posts por marca, fluxo de aprovação, agendamento, publicação e prévia por rede.
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, List, CalendarDays, ExternalLink, Download, Copy, Sparkles, Film, Image as ImageIcon, Layers } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useApp, showError, onJob } from '../lib/store.ts';
import { Empty, Field, Modal } from '../components/ui.tsx';
import { fmtDateTime } from '../lib/format.ts';
import { SocialPreview, type PreviewMedia } from './SocialPreview.tsx';
import { NET_ICON, NET_LABEL, type SocialAccount } from './SocialAccounts.tsx';
import { UploadButton } from './Library.tsx';
import { CoverPicker, type Cover } from './CoverPicker.tsx';

interface MediaItem {
  source: 'export' | 'asset';
  id: string;
  kind: 'video' | 'image';
  name: string;
  url: string;
  projectId?: string;
  settings: { width?: number; height?: number };
}
interface Target {
  id: string;
  accountId: string;
  network: keyof typeof NET_LABEL;
  status: string;
  permalink: string | null;
  error: string | null;
  accountName: string;
  username: string | null;
  avatar: string | null;
}
interface Post {
  id: string;
  brandId: string;
  projectId: string | null;
  type: 'video' | 'image' | 'carousel';
  media: { source: 'export' | 'asset'; id: string }[];
  caption: string;
  captions: Record<string, string>;
  status: string;
  scheduledAt: string | null;
  timezone: string;
  cover: Cover;
  targets: Target[];
}

export const POST_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'Rascunho', tone: '' },
  review: { label: 'Em revisão', tone: 'warning' },
  approved: { label: 'Aprovado', tone: 'info' },
  scheduled: { label: 'Agendado', tone: 'accent' },
  publishing: { label: 'Publicando', tone: 'accent' },
  published: { label: 'Publicado', tone: 'success' },
  awaiting_manual: { label: 'Aguardando publicação manual', tone: 'warning' },
  failed: { label: 'Falhou', tone: 'danger' },
};
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function Composer({ brandId, post, onClose, onSaved }: { brandId: string; post: Post | null; onClose: () => void; onSaved: () => void }) {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [type, setType] = useState<Post['type']>(post?.type ?? 'video');
  const [chosen, setChosen] = useState<{ source: 'export' | 'asset'; id: string }[]>(post?.media ?? []);
  const [caption, setCaption] = useState(post?.caption ?? '');
  const [captions, setCaptions] = useState<Record<string, string>>(post?.captions ?? {});
  const [targets, setTargets] = useState<string[]>(post?.targets.map((t) => t.accountId) ?? []);
  const [when, setWhen] = useState(toLocalInput(post?.scheduledAt ?? null));
  const [net, setNet] = useState<string>('instagram');
  const [cur, setCur] = useState<Post | null>(post);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [cover, setCover] = useState<Cover>(post?.cover ?? null);
  const [coverWaiting, setCoverWaiting] = useState<string | null>(null);
  useEffect(() => {
    if (coverWaiting && media.some((m) => m.id === coverWaiting)) {
      setCover({ kind: 'image', assetId: coverWaiting });
      setCoverWaiting(null);
    }
  }, [media, coverWaiting]);
  const brand = useApp((s) => s.brands.find((b) => b.id === brandId));
  const locked = !!cur && !['draft', 'review', 'approved', 'failed'].includes(cur.status);

  // Arquivos anexados aqui: enviados para a Biblioteca da marca e selecionados quando ficam prontos.
  const [waiting, setWaiting] = useState<string[]>([]);
  const loadMedia = () => api.get<MediaItem[]>(`/api/social/media?brandId=${brandId}`).then((list) => {
    setMedia(list);
    setWaiting((w) => {
      const ready = w.filter((id) => list.some((m) => m.id === id));
      if (ready.length) setChosen((c) => (type === 'carousel' ? [...c, ...ready.map((id) => ({ source: 'asset' as const, id }))].slice(0, 10) : [{ source: 'asset' as const, id: ready[ready.length - 1] }]));
      return w.filter((id) => !ready.includes(id));
    });
    return list;
  }, showError);
  useEffect(() => onJob((j) => j.type === 'ingest' && j.status === 'done' && j.brandId === brandId && loadMedia()), [brandId, type]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    loadMedia();
    api.get<SocialAccount[]>(`/api/social/accounts?brandId=${brandId}`).then((a) => {
      setAccounts(a);
      if (!post && a.length) setTargets(a.filter((x) => x.status === 'connected' || x.assisted).map((x) => x.id));
    }, showError);
  }, [brandId, post]);

  // Sugere o texto gerado no projeto do vídeo escolhido.
  const projectId = media.find((m) => chosen.some((c) => c.id === m.id) && m.projectId)?.projectId;
  useEffect(() => {
    if (!projectId) return setSuggestion(null);
    api.get<any[]>(`/api/projects/${projectId}/post-drafts`).then((d) => setSuggestion(d[0]?.content?.variations?.[0]?.fullText ?? null), () => {});
  }, [projectId]);

  const pickable = media.filter((m) => (type === 'video' ? m.kind === 'video' : type === 'image' ? m.kind === 'image' : true));
  const toggle = (m: MediaItem) => {
    const has = chosen.some((c) => c.id === m.id);
    if (type === 'carousel') setChosen(has ? chosen.filter((c) => c.id !== m.id) : [...chosen, { source: m.source, id: m.id }].slice(0, 10));
    else setChosen(has ? [] : [{ source: m.source, id: m.id }]);
  };
  const previewItems: PreviewMedia[] = chosen.map((c) => media.find((m) => m.id === c.id)).filter(Boolean).map((m) => ({ url: m!.url, kind: m!.kind }));
  const warnings: string[] = [];
  for (const c of chosen) {
    const m = media.find((x) => x.id === c.id);
    const w = m?.settings.width;
    const h = m?.settings.height;
    if (w && h && m!.kind === 'image' && (w / h < 0.8 || w / h > 1.91)) warnings.push(`"${m!.name}" está fora da proporção aceita pelo feed do Instagram (de 4:5 a 1,91:1).`);
    if (w && h && type === 'video' && w / h > 1) warnings.push('Vídeo horizontal: no Reels e no TikTok o ideal é 9:16.');
  }
  const selAccounts = accounts.filter((a) => targets.includes(a.id));
  const previewNet = selAccounts.some((a) => a.network === net) ? net : selAccounts[0]?.network ?? net;
  const previewAcc = selAccounts.find((a) => a.network === previewNet);

  const save = async (): Promise<Post | null> => {
    const body = { brandId, type, media: chosen, caption, captions, cover: type === 'video' && !(cover?.kind === 'image' && !cover.assetId) ? cover : null, targets, scheduledAt: when ? new Date(when).toISOString() : null, timezone: TZ };
    try {
      const p = cur ? await api.put<Post>(`/api/posts/${cur.id}`, body) : await api.post<Post>('/api/posts', body);
      setCur(p);
      onSaved();
      return p;
    } catch (e) {
      showError(e);
      return null;
    }
  };
  const act = async (action: string) => {
    const p = locked ? cur : await save();
    if (!p) return;
    try {
      const r = await api.post<Post>(`/api/posts/${p.id}/action`, { action, scheduledAt: when ? new Date(when).toISOString() : undefined });
      setCur(r);
      onSaved();
      useApp.getState().toast({ kind: 'success', title: POST_STATUS[r.status]?.label ?? r.status });
    } catch (e) {
      showError(e);
    }
  };
  useEffect(() => onJob((j) => j.type === 'publish' && cur && (j.status === 'done' || j.status === 'failed') && api.get<Post>(`/api/posts/${cur.id}`).then(setCur, () => {})), [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const st = cur ? POST_STATUS[cur.status] : POST_STATUS.draft;
  return (
    <Modal title={cur ? 'Post' : 'Novo post'} onClose={onClose} wide>
      <div className="composer">
        <div className="col" style={{ gap: 12, minWidth: 0 }}>
          <div className="row">
            <span className={`badge ${st.tone}`}>{st.label}</span>
            {cur?.scheduledAt && <span className="faint small">{fmtDateTime(cur.scheduledAt)} ({TZ})</span>}
          </div>
          <Field label="Tipo">
            <div className="row" style={{ gap: 6 }}>
              {([['video', 'Vídeo / Reels', Film], ['image', 'Imagem', ImageIcon], ['carousel', 'Carrossel', Layers]] as const).map(([k, l, I]) => (
                <button key={k} disabled={locked} className={`btn sm ${type === k ? 'primary' : ''}`} onClick={() => (setType(k), setChosen([]))}>
                  <I size={14} /> {l}
                </button>
              ))}
            </div>
          </Field>
          <Field label={type === 'carousel' ? `Mídias (${chosen.length}/10, na ordem dos cliques)` : 'Mídia'} help="Anexe do computador ou escolha um vídeo exportado de um projeto / arquivo da Biblioteca.">
            {!locked && (
              <div className="row" style={{ marginBottom: 6 }}>
                <UploadButton brandId={brandId} accept={type === 'video' ? 'video/*' : type === 'image' ? 'image/*' : 'image/*,video/*'} label="Anexar do computador" onUploaded={(a) => (setWaiting((w) => [...w, a.id]), loadMedia())} />
                {waiting.length > 0 && <span className="faint small">Preparando {waiting.length} arquivo(s)… ele(s) será(ão) selecionado(s) automaticamente.</span>}
              </div>
            )}
            <div className="media-pick">
              {pickable.map((m) => {
                const i = chosen.findIndex((c) => c.id === m.id);
                return (
                  <button key={m.id} disabled={locked} className={`media-pick-item ${i >= 0 ? 'on' : ''}`} onClick={() => toggle(m)} title={m.name}>
                    {m.kind === 'image' ? <img src={m.url} alt="" /> : <video src={m.url} muted preload="metadata" />}
                    {i >= 0 && <span className="badge accent pick-n">{type === 'carousel' ? i + 1 : '✓'}</span>}
                    <span className="ellipsis small">{m.source === 'export' ? '🎬 ' : ''}{m.name}</span>
                  </button>
                );
              })}
              {!pickable.length && <span className="faint small">Nada disponível. Exporte um vídeo num projeto ou envie imagens na Biblioteca.</span>}
            </div>
          </Field>
          {type === 'video' && (
            <Field label="Capa do Reels">
              <CoverPicker
                brandId={brandId}
                disabled={locked}
                videoUrl={media.find((m) => m.id === chosen[0]?.id)?.url ?? null}
                images={media.filter((m) => m.kind === 'image').map((m) => ({ id: m.id, url: m.url, name: m.name }))}
                value={cover}
                onChange={setCover}
                onUploaded={(id) => (setCoverWaiting(id), loadMedia())}
              />
              {coverWaiting && <span className="faint small">Preparando a imagem de capa…</span>}
            </Field>
          )}
          <Field label="Texto da publicação">
            <textarea className="textarea" rows={6} disabled={locked} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Escreva ou use o texto gerado no projeto" />
            {suggestion && suggestion !== caption && !locked && (
              <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setCaption(suggestion)}>
                <Sparkles size={12} /> Usar o texto gerado no projeto
              </button>
            )}
            <span className="faint small">{caption.length}/2200 caracteres</span>
          </Field>
          <Field label="Adaptar o texto por rede (opcional)">
            {(['instagram', 'facebook', 'tiktok'] as const).filter((n) => selAccounts.some((a) => a.network === n)).map((n) => (
              <details key={n}>
                <summary className="small">{NET_LABEL[n]}{captions[n] ? ' (personalizado)' : ''}</summary>
                <textarea className="textarea" rows={3} disabled={locked} value={captions[n] ?? ''} placeholder="Vazio = usa o texto principal" onChange={(e) => setCaptions({ ...captions, [n]: e.target.value })} />
              </details>
            ))}
          </Field>
          <Field label="Publicar em">
            {!accounts.length && <span className="faint small">Nenhum perfil conectado a esta marca. Conecte em Marcas → Perfis sociais.</span>}
            {accounts.map((a) => {
              const I = NET_ICON[a.network];
              return (
                <label key={a.id} className="row small">
                  <input type="checkbox" disabled={locked || (!a.assisted && a.status !== 'connected')} checked={targets.includes(a.id)} onChange={(e) => setTargets(e.target.checked ? [...targets, a.id] : targets.filter((t) => t !== a.id))} />
                  <I size={14} /> {a.username ? `@${a.username}` : a.name}
                  {a.assisted && <span className="badge warning">assistido</span>}
                  {!a.assisted && a.status !== 'connected' && <span className="badge danger">reconectar</span>}
                </label>
              );
            })}
          </Field>
          <Field label={`Data e horário (${TZ})`}>
            <input className="input" type="datetime-local" disabled={locked && cur?.status !== 'scheduled'} value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          {warnings.map((w, i) => <div key={i} className="alert warning small">{w}</div>)}

          {cur?.targets.some((t) => t.status !== 'pending') && (
            <div className="col" style={{ gap: 6 }}>
              <div className="label">Resultado por perfil</div>
              {cur.targets.map((t) => (
                <TargetRow key={t.id} t={t} post={cur} media={media} onChange={setCur} />
              ))}
            </div>
          )}

          <div className="row wrap" style={{ gap: 6, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
            {!locked && <button className="btn sm" onClick={() => save().then((p) => p && useApp.getState().toast({ kind: 'success', title: 'Rascunho salvo' }))}>Salvar rascunho</button>}
            {(!cur || ['draft', 'failed'].includes(cur.status)) && <button className="btn sm" onClick={() => act('review')}>Enviar para revisão</button>}
            {(!cur || ['draft', 'review'].includes(cur.status)) && <button className="btn sm" onClick={() => act('approve')}>Aprovar</button>}
            {cur && ['approved', 'failed'].includes(cur.status) && <button className="btn primary sm" disabled={!when} onClick={() => act('schedule')}>Agendar</button>}
            {cur && ['approved', 'failed'].includes(cur.status) && <button className="btn sm" onClick={() => confirm('Publicar agora nos perfis selecionados?') && act('publish_now')}>Publicar agora</button>}
            {cur?.status === 'scheduled' && <button className="btn sm" onClick={() => act('unschedule')}>Cancelar agendamento</button>}
            <span className="spacer" />
            {cur && !['publishing', 'published'].includes(cur.status) && (
              <button className="btn ghost danger sm" onClick={() => confirm('Excluir este post?') && api.del(`/api/posts/${cur.id}`).then(() => (onSaved(), onClose()), showError)}>Excluir</button>
            )}
          </div>
        </div>
        <div className="col" style={{ gap: 8, alignItems: 'center' }}>
          <div className="tabs" style={{ marginBottom: 0 }}>
            {(['instagram', 'facebook', 'tiktok'] as const).map((n) => (
              <button key={n} className={previewNet === n ? 'on' : ''} onClick={() => setNet(n)}>{NET_LABEL[n]}</button>
            ))}
          </div>
          <SocialPreview network={previewNet} type={type} items={previewItems} caption={captions[previewNet] || caption} name={previewAcc?.username ?? brand?.name ?? 'perfil'} avatar={previewAcc?.avatar} />
        </div>
      </div>
    </Modal>
  );
}

function TargetRow({ t, post, media, onChange }: { t: Target; post: Post; media: MediaItem[]; onChange: (p: Post) => void }) {
  const [link, setLink] = useState('');
  const I = NET_ICON[t.network];
  const video = media.find((m) => m.id === post.media[0]?.id);
  return (
    <div className="card col" style={{ padding: 8, gap: 6, background: 'var(--surface-2)' }}>
      <div className="row small">
        <I size={14} /> {t.username ? `@${t.username}` : t.accountName}
        <span className={`badge ${t.status === 'published' ? 'success' : t.status === 'failed' ? 'danger' : 'warning'}`}>{t.status === 'published' ? 'Publicado' : t.status === 'failed' ? 'Falhou' : t.status === 'manual' ? 'Publique no app' : 'Pendente'}</span>
        {t.permalink && <a className="btn ghost sm" href={t.permalink} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Abrir</a>}
      </div>
      {t.error && <div className="small" style={{ color: 'var(--danger)' }}>{t.error}</div>}
      {t.status === 'manual' && (
        <div className="col" style={{ gap: 6 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            {video && <a className="btn sm" href={`${video.url}?download=1`}><Download size={12} /> Baixar vídeo</a>}
            <button className="btn sm" onClick={() => navigator.clipboard.writeText(post.captions.tiktok || post.caption)}><Copy size={12} /> Copiar texto</button>
            <a className="btn sm" href="https://www.tiktok.com/upload" target="_blank" rel="noreferrer"><ExternalLink size={12} /> Abrir TikTok</a>
          </div>
          <div className="row">
            <input className="input sm" placeholder="Cole o link do vídeo publicado" value={link} onChange={(e) => setLink(e.target.value)} />
            <button className="btn sm" disabled={!link} onClick={() => api.post<Post>(`/api/posts/${post.id}/targets/${t.id}/manual`, { permalink: link }).then(onChange, showError)}>Confirmar</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ContentPage() {
  const { scope, brands } = useApp();
  const [posts, setPosts] = useState<Post[]>([]);
  const [view, setView] = useState<'month' | 'list'>('month');
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [status, setStatus] = useState('');
  const [network, setNetwork] = useState('');
  const [open, setOpen] = useState<{ post: Post | null; brandId: string; date?: string } | null>(null);
  const brandId = scope !== 'all' ? scope : null;

  const load = () => api.get<Post[]>(`/api/posts${brandId ? `?brandId=${brandId}` : ''}`).then(setPosts, showError);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);
  useEffect(() => onJob((j) => j.type === 'publish' && (j.status === 'done' || j.status === 'failed') && load()), [brandId]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = posts.filter((p) => (!status || p.status === status) && (!network || p.targets.some((t) => t.network === network)));
  const days = useMemo(() => {
    const start = new Date(month);
    start.setDate(1 - ((start.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const byDay = new Map<string, Post[]>();
  for (const p of filtered) if (p.scheduledAt) {
    const k = key(new Date(p.scheduledAt));
    byDay.set(k, [...(byDay.get(k) ?? []), p]);
  }
  const newPost = () => (brandId ? setOpen({ post: null, brandId }) : useApp.getState().toast({ kind: 'info', title: 'Selecione a marca no topo para criar um post.' }));
  const chip = (p: Post) => {
    const st = POST_STATUS[p.status];
    return (
      <button key={p.id} className={`cal-chip ${st.tone}`} onClick={() => setOpen({ post: p, brandId: p.brandId })} title={p.caption}>
        {p.scheduledAt && new Date(p.scheduledAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} {p.targets.map((t) => NET_LABEL[t.network][0]).join('')} · {p.caption.slice(0, 30) || p.type}
      </button>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Conteúdo e calendário</h1>
          <p>Prepare, revise, agende e acompanhe as publicações{brandId ? ` de ${brands.find((b) => b.id === brandId)?.name}` : ' de todas as marcas'}.</p>
        </div>
        <div className="actions">
          <button className={`btn ${view === 'month' ? '' : 'ghost'}`} onClick={() => setView('month')}><CalendarDays size={16} /> Calendário</button>
          <button className={`btn ${view === 'list' ? '' : 'ghost'}`} onClick={() => setView('list')}><List size={16} /> Lista</button>
          <button className="btn primary" onClick={newPost}><Plus size={16} /> Novo post</button>
        </div>
      </div>
      <div className="row wrap" style={{ marginBottom: 14 }}>
        <select className="select sm" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos os status</option>
          {Object.entries(POST_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="select sm" style={{ width: 'auto' }} value={network} onChange={(e) => setNetwork(e.target.value)}>
          <option value="">Todas as redes</option>
          {Object.entries(NET_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="faint small">Fuso: {TZ}. O GDR Digital precisa estar aberto no horário agendado para publicar.</span>
      </div>

      {view === 'month' ? (
        <div className="card" style={{ padding: 12 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="btn ghost sm icon" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
            <b style={{ minWidth: 150, textAlign: 'center' }}>{month.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</b>
            <button className="btn ghost sm icon" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
          </div>
          <div className="cal">
            {['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'].map((d) => <div key={d} className="cal-head">{d}</div>)}
            {days.map((d) => {
              const today = key(d) === key(new Date());
              return (
                <div key={d.toISOString()} className={`cal-day ${d.getMonth() !== month.getMonth() ? 'out' : ''} ${today ? 'today' : ''}`}>
                  <span className="cal-num">{d.getDate()}</span>
                  {(byDay.get(key(d)) ?? []).map(chip)}
                </div>
              );
            })}
          </div>
          {filtered.some((p) => !p.scheduledAt) && (
            <div style={{ marginTop: 12 }}>
              <div className="label" style={{ marginBottom: 6 }}>Sem data</div>
              <div className="row wrap">{filtered.filter((p) => !p.scheduledAt).map(chip)}</div>
            </div>
          )}
        </div>
      ) : !filtered.length ? (
        <Empty icon={<CalendarDays size={36} />} title="Nenhum post" action={<button className="btn primary" onClick={newPost}>Criar post</button>}>Crie um post a partir de um vídeo exportado ou de imagens da biblioteca.</Empty>
      ) : (
        <div className="card list">
          {filtered.map((p) => (
            <button key={p.id} className="list-item" style={{ background: 'none', border: 0, borderBottom: '1px solid var(--border)', textAlign: 'left', cursor: 'pointer' }} onClick={() => setOpen({ post: p, brandId: p.brandId })}>
              <span className={`badge ${POST_STATUS[p.status].tone}`}>{POST_STATUS[p.status].label}</span>
              <span className="small faint" style={{ minWidth: 130 }}>{p.scheduledAt ? fmtDateTime(p.scheduledAt) : 'sem data'}</span>
              <span className="ellipsis" style={{ flex: 1 }}>{p.caption || '(sem texto)'}</span>
              <span className="small faint">{p.targets.map((t) => NET_LABEL[t.network]).join(', ')}</span>
            </button>
          ))}
        </div>
      )}
      {open && <Composer brandId={open.brandId} post={open.post} onClose={() => setOpen(null)} onSaved={load} />}
    </>
  );
}
