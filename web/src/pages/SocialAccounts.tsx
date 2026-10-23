// Perfis sociais de uma marca: conexão oficial com a Meta e TikTok em modo assistido.
import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, RefreshCw, Trash2, Camera as Instagram, Users as Facebook, Music2 } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { Modal } from '../components/ui.tsx';
import { fmtRelative } from '../lib/format.ts';

export interface SocialAccount {
  id: string;
  network: 'instagram' | 'facebook' | 'tiktok';
  name: string;
  username: string | null;
  avatar: string | null;
  status: string;
  verifiedAt: string | null;
  error: string | null;
  assisted: boolean;
}

export const NET_ICON = { instagram: Instagram, facebook: Facebook, tiktok: Music2 };
export const NET_LABEL = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok' };

export function SocialAccounts({ brandId }: { brandId: string }) {
  const [list, setList] = useState<SocialAccount[]>([]);
  const [meta, setMeta] = useState<{ configured: boolean } | null>(null);
  const [params, setParams] = useSearchParams();
  const [pick, setPick] = useState<{ state: string; items: any[] } | null>(null);
  const [sel, setSel] = useState<Record<string, { facebook: boolean; instagram: boolean }>>({});
  const [tiktok, setTiktok] = useState('');

  const load = () => api.get<SocialAccount[]>(`/api/social/accounts?brandId=${brandId}`).then(setList, showError);
  useEffect(() => {
    load();
    api.get('/api/settings/meta').then(setMeta, () => {});
    const state = params.get('meta');
    const err = params.get('metaErro');
    if (err) useApp.getState().toast({ kind: 'error', title: 'Não foi possível conectar à Meta', hint: err });
    if (state)
      api.get(`/api/social/meta/pending/${state}`).then(
        (items) => {
          setPick({ state, items });
          setSel(Object.fromEntries(items.map((i: any) => [i.pageId, { facebook: true, instagram: !!i.ig }])));
        },
        showError,
      );
    if (state || err) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  const link = async () => {
    try {
      const r = await api.post('/api/social/meta/link', { state: pick!.state, selections: Object.entries(sel).map(([pageId, v]) => ({ pageId, ...v })) });
      useApp.getState().toast({ kind: 'success', title: `${r.linked} perfil(is) conectado(s) e verificado(s)` });
      setPick(null);
      load();
    } catch (e) {
      showError(e);
    }
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      {list.map((a) => {
        const Icon = NET_ICON[a.network];
        return (
          <div key={a.id} className="row" style={{ gap: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 10 }}>
            {a.avatar ? <img src={a.avatar} alt="" style={{ width: 36, height: 36, borderRadius: 99 }} /> : <Icon size={28} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{a.username ? `@${a.username}` : a.name} <span className="faint small">· {NET_LABEL[a.network]}</span></div>
              <div className="small">
                {a.assisted ? (
                  <span className="badge warning">Publicação assistida (sem API)</span>
                ) : a.status === 'connected' ? (
                  <span style={{ color: 'var(--success)' }}><CheckCircle2 size={12} /> Conectado e verificado {fmtRelative(a.verifiedAt)}</span>
                ) : (
                  <span style={{ color: 'var(--danger)' }}><AlertTriangle size={12} /> {a.error}</span>
                )}
              </div>
            </div>
            {!a.assisted && (
              <button className="btn ghost sm" title="Verificar conexão" onClick={() => api.post(`/api/social/accounts/${a.id}/verify`).then(load, showError)}>
                <RefreshCw size={14} />
              </button>
            )}
            <button className="btn ghost sm" title="Desconectar" onClick={() => confirm('Desconectar este perfil desta marca?') && api.del(`/api/social/accounts/${a.id}`).then(load, showError)}>
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
      {!list.length && <p className="muted small">Nenhum perfil conectado a esta marca.</p>}

      <div className="card col" style={{ gap: 8, background: 'var(--surface-2)' }}>
        <b>Instagram e Facebook (API oficial da Meta)</b>
        <span className="muted small">Exige conta profissional do Instagram ligada a uma Página do Facebook. Você entra com sua conta Meta e escolhe quais perfis ligar a esta marca.</span>
        {meta && !meta.configured ? (
          <div className="alert warning small">
            Primeiro configure o app da Meta em <Link to="/configuracoes" style={{ color: 'var(--accent)', fontWeight: 600 }}>Configurações → Redes sociais</Link>.
          </div>
        ) : (
          <a className="btn primary sm" style={{ alignSelf: 'flex-start' }} href={`/api/social/meta/connect?brandId=${brandId}`}>
            <Instagram size={14} /> Conectar Instagram / Facebook
          </a>
        )}
      </div>

      <div className="card col" style={{ gap: 8, background: 'var(--surface-2)' }}>
        <b>TikTok (publicação assistida)</b>
        <span className="muted small">A postagem direta pela API do TikTok exige aprovação do app pelo TikTok. Até lá, o GDR Digital prepara o vídeo e o texto, você publica no app e cola o link para registrar.</span>
        <div className="row">
          <input className="input sm" placeholder="@perfil" value={tiktok} onChange={(e) => setTiktok(e.target.value)} style={{ maxWidth: 220 }} />
          <button className="btn sm" disabled={!tiktok.trim()} onClick={() => api.post('/api/social/tiktok/assisted', { brandId, username: tiktok }).then(() => (setTiktok(''), load()), showError)}>
            Adicionar TikTok
          </button>
        </div>
      </div>

      {pick && (
        <Modal title="Escolha os perfis desta marca" onClose={() => setPick(null)} footer={<><button className="btn ghost" onClick={() => setPick(null)}>Cancelar</button><button className="btn primary" onClick={link}>Conectar selecionados</button></>}>
          {!pick.items.length && <p className="muted">Nenhuma Página encontrada nessa conta. Verifique se você é administrador da Página e se aceitou todas as permissões.</p>}
          {pick.items.map((i) => (
            <div key={i.pageId} className="card col" style={{ padding: 10, gap: 6 }}>
              <label className="row small">
                <input type="checkbox" checked={sel[i.pageId]?.facebook} onChange={(e) => setSel({ ...sel, [i.pageId]: { ...sel[i.pageId], facebook: e.target.checked } })} />
                <Facebook size={14} /> Página: {i.pageName}
              </label>
              {i.ig ? (
                <label className="row small">
                  <input type="checkbox" checked={sel[i.pageId]?.instagram} onChange={(e) => setSel({ ...sel, [i.pageId]: { ...sel[i.pageId], instagram: e.target.checked } })} />
                  <Instagram size={14} /> Instagram: @{i.ig.username}
                </label>
              ) : (
                <span className="faint small">Sem conta profissional do Instagram ligada a esta Página.</span>
              )}
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}
