// Conexão com o Google Drive (somente leitura) e pastas vinculadas por marca.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { HardDrive, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { Field } from '../components/ui.tsx';

export function DriveSettings() {
  const [cfg, setCfg] = useState<{ configured: boolean; connected: boolean; email: string | null; redirectUri: string } | null>(null);
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [params, setParams] = useSearchParams();
  const load = () => api.get('/api/settings/drive').then(setCfg, () => {});
  useEffect(() => {
    load();
    if (params.get('drive')) useApp.getState().toast({ kind: 'success', title: 'Google Drive conectado' });
    if (params.get('driveErro')) useApp.getState().toast({ kind: 'error', title: 'Não foi possível conectar o Drive', hint: params.get('driveErro')! });
    if (params.get('drive') || params.get('driveErro')) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const save = () => api.put('/api/settings/drive', { clientId: id, clientSecret: secret || undefined }).then(() => (setSecret(''), load()), showError);
  return (
    <section className="card col" style={{ gap: 12 }}>
      <h2 className="row">
        <HardDrive size={16} /> Google Drive {cfg?.connected && <span className="badge success"><CheckCircle2 size={11} /> conectado {cfg.email ? `(${cfg.email})` : ''}</span>}
      </h2>
      {!cfg?.configured && (
        <ol className="muted small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          <li>Acesse <b>console.cloud.google.com</b>, crie um projeto (ex.: GDR Orbit) e ative a <b>Google Drive API</b>.</li>
          <li>Em <b>Tela de consentimento OAuth</b>: tipo Externo, nome GDR Orbit, e adicione o seu e-mail em <b>Usuários de teste</b>.</li>
          <li>Em <b>Credenciais → Criar credenciais → ID do cliente OAuth</b>, tipo <b>Aplicativo da Web</b>, com o URI de redirecionamento: <code className="mono">{cfg?.redirectUri}</code></li>
          <li>Copie o ID e a chave secreta do cliente e cole abaixo.</li>
        </ol>
      )}
      <div className="grid cols-2">
        <Field label="ID do cliente">
          <input className="input mono" value={id} placeholder={cfg?.configured ? 'Configurado — preencha só para trocar' : '…apps.googleusercontent.com'} onChange={(e) => setId(e.target.value)} />
        </Field>
        <Field label="Chave secreta do cliente">
          <input className="input mono" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
      </div>
      <div className="row">
        <button className="btn sm" disabled={!id} onClick={save}>Salvar</button>
        {cfg?.configured && !cfg.connected && <a className="btn primary sm" href="/api/drive/connect">Conectar conta Google</a>}
        {cfg?.connected && <button className="btn ghost sm" onClick={() => api.post('/api/drive/disconnect').then(load, showError)}>Desconectar</button>}
      </div>
      <span className="faint small">Acesso somente leitura. Arquivos importados nunca são publicados automaticamente. Abra o GDR Orbit por http://localhost:4310 ao conectar.</span>
    </section>
  );
}

interface Folder {
  id: string;
  name: string;
  autoImport: boolean;
  newCount: number;
  error: string | null;
}

export function DriveFolders({ brandId, onImported }: { brandId: string; onImported: () => void }) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [link, setLink] = useState('');
  const [connected, setConnected] = useState<boolean | null>(null);
  const load = () => api.get<Folder[]>(`/api/drive/folders?brandId=${brandId}`).then(setFolders, showError);
  useEffect(() => {
    api.get('/api/settings/drive').then((c) => setConnected(c.connected), () => setConnected(false));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);
  if (!connected) return null;
  const importNow = (f: Folder) =>
    api.post(`/api/drive/folders/${f.id}/import`).then(() => {
      useApp.getState().toast({ kind: 'info', title: 'Importação do Drive iniciada', hint: 'Acompanhe em Processamentos.' });
      setTimeout(() => (onImported(), load()), 4000);
    }, showError);
  return (
    <div className="card col" style={{ gap: 8, marginBottom: 16 }}>
      <b className="row"><HardDrive size={14} /> Pastas do Google Drive desta marca</b>
      {folders.map((f) => (
        <div key={f.id} className="row wrap small" style={{ gap: 8 }}>
          <span style={{ fontWeight: 600 }}>{f.name}</span>
          {f.error ? <span style={{ color: 'var(--danger)' }}>{f.error}</span> : <span className={`badge ${f.newCount ? 'accent' : ''}`}>{f.newCount} novo(s)</span>}
          <label className="row">
            <input type="checkbox" checked={f.autoImport} onChange={(e) => api.patch(`/api/drive/folders/${f.id}`, { autoImport: e.target.checked }).then(load)} /> importar sozinho
          </label>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => api.post(`/api/drive/folders/${f.id}/check`).then(load, showError)}>Verificar</button>
          <button className="btn sm" disabled={!f.newCount} onClick={() => importNow(f)}>Importar novos</button>
          <button className="btn ghost sm" onClick={() => api.del(`/api/drive/folders/${f.id}`).then(load, showError)}>Desvincular</button>
        </div>
      ))}
      <div className="row">
        <input className="input sm" placeholder="Cole o link da pasta do Drive" value={link} onChange={(e) => setLink(e.target.value)} />
        <button className="btn sm" disabled={!link} onClick={() => api.post('/api/drive/folders', { brandId, link }).then(() => (setLink(''), load()), showError)}>
          Vincular pasta
        </button>
      </div>
    </div>
  );
}
