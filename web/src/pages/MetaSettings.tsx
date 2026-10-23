// Configuração do app da Meta (necessário para conectar Instagram e Facebook pela API oficial).
import { useEffect, useState } from 'react';
import { Share2, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { Field } from '../components/ui.tsx';

export function MetaSettings() {
  const [cfg, setCfg] = useState<{ configured: boolean; appId: string; redirectUri: string } | null>(null);
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const load = () => api.get('/api/settings/meta').then((c) => (setCfg(c), setAppId(c.appId)), () => {});
  useEffect(() => {
    load();
  }, []);
  const save = () =>
    api.put('/api/settings/meta', { appId, appSecret: secret || undefined }).then(() => {
      setSecret('');
      load();
      useApp.getState().toast({ kind: 'success', title: 'App da Meta salvo', hint: 'Agora conecte os perfis em Marcas → Perfis sociais.' });
    }, showError);
  const redirect = cfg?.redirectUri.replace('127.0.0.1', 'localhost');
  return (
    <section className="card col" style={{ gap: 12 }}>
      <h2 className="row"><Share2 size={16} /> Redes sociais — app da Meta {cfg?.configured && <span className="badge success"><CheckCircle2 size={11} /> configurado</span>}</h2>
      <ol className="muted small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
        <li>Acesse <b>developers.facebook.com</b> → Meus apps → Criar app → tipo <b>Empresa</b>.</li>
        <li>Adicione os produtos <b>Login do Facebook para Empresas</b> e <b>API do Instagram (com login do Facebook)</b>.</li>
        <li>Em Login do Facebook → Configurações, cadastre o URI de redirecionamento: <code className="mono">{redirect}</code></li>
        <li>Em Configurações → Básico, copie o <b>ID do app</b> e a <b>Chave secreta</b> e cole abaixo.</li>
        <li>Em modo desenvolvimento, funciona para os perfis em que você é administrador — não precisa de aprovação da Meta para uso próprio.</li>
        <li>Abra o GDR Orbit por <b>http://localhost:4310</b> ao conectar (a Meta só aceita esse endereço local).</li>
      </ol>
      <div className="grid cols-2">
        <Field label="ID do app"><input className="input mono" value={appId} onChange={(e) => setAppId(e.target.value)} /></Field>
        <Field label="Chave secreta do app" help="Guardada só neste computador."><input className="input mono" type="password" autoComplete="off" placeholder={cfg?.configured ? 'Manter a atual' : ''} value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
      </div>
      <div><button className="btn sm" disabled={!appId || (!cfg?.configured && !secret)} onClick={save}>Salvar</button></div>
    </section>
  );
}
