import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Sparkles, Palette, Server, KeyRound, RotateCcw } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { Field, Spinner } from '../components/ui.tsx';
import { MetaSettings } from './MetaSettings.tsx';
import { DriveSettings } from './DriveSettings.tsx';

// Tokens de identidade ajustáveis (os valores padrão estão em styles/tokens.css).
export const THEME_TOKENS: { key: string; label: string; def: string }[] = [
  { key: '--accent', label: 'Laranja principal (botões, seleção, progresso)', def: '#FF7A00' },
  { key: '--accent-hover', label: 'Laranja ao passar o mouse', def: '#FF8F26' },
  { key: '--bg', label: 'Fundo', def: '#0B0B0C' },
  { key: '--surface-1', label: 'Superfície 1 (painéis)', def: '#141416' },
  { key: '--surface-2', label: 'Superfície 2 (campos, cartões)', def: '#1C1C1F' },
  { key: '--surface-3', label: 'Superfície 3 (destaques)', def: '#26262B' },
  { key: '--border', label: 'Bordas', def: '#2E2E34' },
  { key: '--text', label: 'Texto principal', def: '#F4F4F5' },
  { key: '--text-2', label: 'Texto secundário', def: '#A1A1AA' },
];

export function applyTheme(t: Record<string, string>) {
  const root = document.documentElement;
  for (const { key } of THEME_TOKENS) {
    if (t[key]) root.style.setProperty(key, t[key]);
    else root.style.removeProperty(key);
  }
  if (t['--accent']) {
    const h = t['--accent'].replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.14)`);
  }
}

interface AiSettings {
  providers: { id: string; name: string; configured: boolean; verifiedAt: string | null; detail: string; costNote: string }[];
  preference: string;
  active: string | null;
  model: string;
  cliModel: string;
}

export function SettingsPage() {
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [key, setKey] = useState('');
  const [gkey, setGkey] = useState('');
  const saveGemini = async (value: string | null) => {
    try {
      await api.put('/api/settings/ai/gemini-key', { key: value });
      setGkey('');
      loadAi();
      useApp.getState().toast({ kind: 'success', title: value ? 'Chave do Gemini salva. Clique em Testar.' : 'Chave removida' });
    } catch (e) {
      showError(e);
    }
  };
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string; hint?: string }>>({});
  const [theme, setTheme] = useState<Record<string, string>>({});
  const [system, setSystem] = useState<any>(null);
  const [pw, setPw] = useState({ current: '', next: '' });

  const loadAi = () => api.get<AiSettings>('/api/settings/ai').then(setAi, showError);
  useEffect(() => {
    loadAi();
    api.get('/api/settings/theme').then((t) => setTheme(t ?? {}), () => {});
    api.get('/api/system').then(setSystem, () => {});
  }, []);

  const saveAi = async (patch: Partial<{ preference: string; model: string; cliModel: string }>) => {
    try {
      await api.put('/api/settings/ai', patch);
      loadAi();
    } catch (e) {
      showError(e);
    }
  };

  const saveKey = async (value: string | null) => {
    try {
      await api.put('/api/settings/ai/key', { key: value });
      setKey('');
      loadAi();
      useApp.getState().toast({ kind: 'success', title: value ? 'Chave salva no servidor' : 'Chave removida' });
    } catch (e) {
      showError(e);
    }
  };

  const test = async (provider: string) => {
    setTesting(provider);
    try {
      const r = await api.post('/api/settings/ai/test', { provider });
      setTestResult((t) => ({ ...t, [provider]: r.ok ? { ok: true, text: `Funcionando (${r.model}).` } : { ok: false, text: r.error, hint: r.hint } }));
      loadAi();
    } catch (e) {
      showError(e);
    } finally {
      setTesting(null);
    }
  };

  const saveTheme = async (t: Record<string, string>) => {
    try {
      await api.put('/api/settings/theme', Object.keys(t).length ? t : null);
      applyTheme(t);
      setTheme(t);
    } catch (e) {
      showError(e);
    }
  };

  const changePw = async () => {
    try {
      await api.post('/api/auth/password', pw);
      setPw({ current: '', next: '' });
      useApp.getState().toast({ kind: 'success', title: 'Senha alterada' });
    } catch (e) {
      showError(e);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Configurações</h1>
          <p>Provedores de IA, identidade visual, acesso e informações do sistema.</p>
        </div>
      </div>
      <div className="col" style={{ gap: 16, maxWidth: 860 }}>
        <section className="card col" style={{ gap: 14 }}>
          <h2 className="row">
            <Sparkles size={16} /> Inteligência artificial
          </h2>
          <p className="muted small" style={{ margin: 0 }}>
            Usada para gerar o texto das publicações (e, nas próximas etapas, edição por comandos, análises e atendimento). A transcrição de áudio roda localmente neste computador, sem custo e sem enviar o vídeo para fora.
          </p>
          {ai?.providers.map((p) => (
            <div key={p.id} className="card col" style={{ background: 'var(--surface-2)', gap: 8 }}>
              <div className="row">
                {p.verifiedAt ? <CheckCircle2 size={16} color="var(--success)" /> : <XCircle size={16} color="var(--text-3)" />}
                <b>{p.name}</b>
                {p.verifiedAt ? <span className="badge success">Conectado e testado</span> : p.configured ? <span className="badge warning">Não verificado — clique em Testar</span> : <span className="badge">Não configurado</span>}
                {ai.active === p.id && <span className="badge accent">Selecionado</span>}
                <span className="spacer" />
                {p.configured && (
                  <button className="btn sm" disabled={testing === p.id} onClick={() => test(p.id)}>
                    {testing === p.id ? <Spinner size={14} /> : null} Testar
                  </button>
                )}
              </div>
              <div className="muted small">{p.detail}</div>
              <div className="faint small">{p.costNote}</div>
              {testResult[p.id] && (
                <div className={`alert small ${testResult[p.id].ok ? 'info' : 'danger'}`}>
                  <div>
                    <div className="title">{testResult[p.id].text}</div>
                    {testResult[p.id].hint}
                  </div>
                </div>
              )}
              {p.id === 'claude-cli' && p.configured && (
                <Field label="Modelo no Claude Code" help='"opus" usa o Opus mais recente disponível no seu plano.'>
                  <select className="select sm" style={{ maxWidth: 220 }} value={ai.cliModel} onChange={(e) => saveAi({ cliModel: e.target.value })}>
                    <option value="opus">opus</option>
                    <option value="sonnet">sonnet</option>
                  </select>
                </Field>
              )}
              {p.id === 'gemini' && (
                <Field label="Chave do Gemini" help={<>Grátis: entre em <b>aistudio.google.com</b> com sua conta Google, clique em "Get API key" → "Create API key" e cole aqui. Fica guardada só neste computador.</>}>
                  <div className="row">
                    <input className="input mono" type="password" autoComplete="off" placeholder={p.configured ? 'Substituir chave atual' : 'AIza…'} value={gkey} onChange={(e) => setGkey(e.target.value)} />
                    <button className="btn sm" disabled={!gkey} onClick={() => saveGemini(gkey)}><KeyRound size={14} /> Salvar</button>
                    {p.configured && <button className="btn ghost sm" onClick={() => saveGemini(null)}>Remover</button>}
                  </div>
                </Field>
              )}
              {p.id === 'anthropic' && (
                <div className="col">
                  <Field label="Chave da API" help="A chave fica guardada apenas no servidor local (pasta data). Ela nunca é enviada de volta para o navegador.">
                    <div className="row">
                      <input className="input mono" type="password" autoComplete="off" placeholder={p.configured ? 'Substituir chave atual' : 'sk-ant-…'} value={key} onChange={(e) => setKey(e.target.value)} />
                      <button className="btn sm" disabled={!key} onClick={() => saveKey(key)}>
                        <KeyRound size={14} /> Salvar
                      </button>
                      {p.configured && (
                        <button className="btn ghost sm" onClick={() => saveKey(null)}>
                          Remover
                        </button>
                      )}
                    </div>
                  </Field>
                  <Field label="Modelo">
                    <select className="select sm" style={{ maxWidth: 260 }} value={ai.model} onChange={(e) => saveAi({ model: e.target.value })}>
                      <option value="claude-opus-5-5">Claude Opus 5.5 (recomendado)</option>
                      <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (mais econômico)</option>
                    </select>
                  </Field>
                </div>
              )}
            </div>
          ))}
          {ai && (
            <Field label="Qual provedor usar">
              <select className="select" style={{ maxWidth: 360 }} value={ai.preference} onChange={(e) => saveAi({ preference: e.target.value })}>
                <option value="auto">Automático (Gemini → API Anthropic → Claude Code)</option>
                <option value="gemini">Sempre Gemini (gratuito)</option>
                <option value="claude-cli">Sempre Claude Code</option>
                <option value="anthropic">Sempre API da Anthropic</option>
              </select>
            </Field>
          )}
        </section>

        <MetaSettings />
        <DriveSettings />

        <section className="card col" style={{ gap: 12 }}>
          <h2 className="row">
            <Palette size={16} /> Identidade visual do GDR Orbit
          </h2>
          <p className="muted small" style={{ margin: 0 }}>Paleta inicial: preto/grafite com laranja GDR. Ajuste e veja na hora.</p>
          <div className="grid cols-2">
            {THEME_TOKENS.map((t) => {
              const v = theme[t.key] ?? t.def;
              return (
                <div className="row" key={t.key}>
                  <input type="color" value={v} onChange={(e) => saveTheme({ ...theme, [t.key]: e.target.value.toUpperCase() })} aria-label={t.label} />
                  <div style={{ minWidth: 0 }}>
                    <div className="small">{t.label}</div>
                    <div className="mono faint">{v}</div>
                  </div>
                </div>
              );
            })}
          </div>
          <div>
            <button className="btn sm" onClick={() => saveTheme({})}>
              <RotateCcw size={14} /> Restaurar paleta padrão
            </button>
          </div>
        </section>

        <section className="card col" style={{ gap: 12 }}>
          <h2 className="row">
            <KeyRound size={16} /> Senha de acesso
          </h2>
          <div className="grid cols-2">
            <Field label="Senha atual">
              <input className="input" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            </Field>
            <Field label="Nova senha (mín. 8)">
              <input className="input" type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </Field>
          </div>
          <div>
            <button className="btn sm" disabled={!pw.current || pw.next.length < 8} onClick={changePw}>
              Alterar senha
            </button>
          </div>
        </section>

        {system && (
          <section className="card col" style={{ gap: 8 }}>
            <h2 className="row">
              <Server size={16} /> Sistema
            </h2>
            <div className="small muted">FFmpeg: <span className="mono">{system.ffmpeg}</span></div>
            <div className="small muted">Codificadores de vídeo que funcionam aqui: <span className="mono">{system.encoders.join(', ')}</span></div>
            <div className="small muted">Pasta de dados (projetos, originais, exportações): <span className="mono">{system.dataDir}</span></div>
            <div className="small muted">Node: <span className="mono">{system.node}</span></div>
          </section>
        )}
      </div>
    </>
  );
}
