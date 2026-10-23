// Edição por conversa. A IA devolve um plano de ações; você revisa e aplica.
// Cada ação vira um passo separado no histórico (Ctrl+Z desfaz uma por vez).
// As ações rápidas usam o mesmo motor, sem IA e sem custo.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Send, Sparkles, Check, Wand2 } from 'lucide-react';
import { useEditor } from './store.ts';
import { api } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { Spinner } from '../components/ui.tsx';
import { applyAction, describeAction, orderPlan, type ActionContext, type EditAction } from '../../../shared/edit-actions.ts';

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  question?: string;
  actions?: EditAction[];
  selected?: boolean[];
  applied?: string[];
  errors?: string[];
  model?: string;
}

function ctx(): ActionContext {
  const st = useEditor.getState();
  const brand = useApp.getState().brands.find((b) => b.id === st.project!.brandId);
  return {
    transcripts: st.transcripts,
    assets: st.assets,
    brand: { colors: brand?.profile.colors.map((c) => c.hex) ?? [], logoAssetId: brand?.profile.logoAssetId ?? null },
  };
}

/** Aplica ações (na ordem segura), cada uma como um passo de desfazer. */
export function runActions(actions: EditAction[]): { applied: string[]; errors: string[] } {
  const applied: string[] = [];
  const errors: string[] = [];
  for (const a of orderPlan(actions)) {
    const st = useEditor.getState();
    try {
      const r = applyAction(st.timeline!, a, ctx());
      st.commit(r.timeline, r.label);
      applied.push(r.label);
    } catch (e) {
      errors.push(`${describeAction(a, ctx())}: ${(e as Error).message}`);
    }
  }
  return { applied, errors };
}

const QUICK: { label: string; action: EditAction }[] = [
  { label: 'Remover pausas', action: { type: 'remove_pauses' } },
  { label: 'Legendas animadas', action: { type: 'captions', preset: 'highlight' } },
  { label: 'Aplicar logo', action: { type: 'logo' } },
  { label: 'Zoom dinâmico', action: { type: 'dynamic_zoom' } },
  { label: 'Transições nos cortes', action: { type: 'transitions', transition: 'fade', duration: 0.4 } },
  { label: 'Filtro cinema', action: { type: 'filter', preset: 'cinema' } },
  { label: 'Reduzir ruído', action: { type: 'denoise', level: 'light' } },
];

const EXAMPLES = ['Retire as pausas e deixe o vídeo mais dinâmico', 'Coloque legendas animadas nas cores da marca e o logo no canto', 'Crie um título de abertura e termine com uma chamada para seguir o perfil'];

export function ChatPanel() {
  const project = useEditor((s) => s.project)!;
  const key = `orbit.chat.${project.id}`;
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '[]');
    } catch {
      return [];
    }
  });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get('/api/settings/ai').then((s) => setAiReady(!!s.active), () => setAiReady(false));
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(msgs.slice(-40)));
    } catch {
      /* sem armazenamento */
    }
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs, key]);

  const quick = (a: EditAction) => {
    const r = runActions([a]);
    if (r.errors.length) useApp.getState().toast({ kind: 'error', title: r.errors[0] });
    else useApp.getState().toast({ kind: 'success', title: r.applied[0], hint: 'Ctrl+Z desfaz.' });
  };

  const send = async (message = text) => {
    if (!message.trim() || busy) return;
    setText('');
    const history = msgs.map((m) => ({ role: m.role, text: m.text }));
    setMsgs((m) => [...m, { role: 'user', text: message }]);
    setBusy(true);
    try {
      await useEditor.getState().save();
      const r = await api.post(`/api/projects/${project.id}/edit-chat`, { message, history });
      setMsgs((m) => [...m, { role: 'assistant', text: r.reply, question: r.question || undefined, actions: r.actions, selected: r.actions.map(() => true), model: r.model }]);
    } catch (e) {
      showError(e);
      setMsgs((m) => [...m, { role: 'assistant', text: `Não consegui planejar: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const apply = (i: number) => {
    const m = msgs[i];
    const chosen = (m.actions ?? []).filter((_, k) => m.selected?.[k]);
    const r = runActions(chosen);
    setMsgs((all) => all.map((x, k) => (k === i ? { ...x, applied: r.applied, errors: r.errors } : x)));
  };

  return (
    <div className="col" style={{ gap: 12, height: '100%' }}>
      <div>
        <div className="label" style={{ marginBottom: 6 }}>Ações rápidas (sem IA, sem custo)</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {QUICK.map((q) => (
            <button key={q.label} className="btn sm" onClick={() => quick(q.action)}>
              <Wand2 size={12} /> {q.label}
            </button>
          ))}
        </div>
      </div>

      <div className="label">Peça para a IA editar</div>
      {aiReady === false && (
        <div className="alert warning small">
          <div>
            Conecte uma IA para editar por comando. <Link to="/configuracoes" style={{ color: 'var(--accent)', fontWeight: 600 }}>Configurar (Gemini é grátis)</Link>
          </div>
        </div>
      )}
      <div className="chat-list">
        {!msgs.length && (
          <div className="col" style={{ gap: 6 }}>
            <span className="faint small">Exemplos:</span>
            {EXAMPLES.map((e) => (
              <button key={e} className="btn ghost sm" style={{ justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left', height: 'auto', padding: 8 }} onClick={() => send(e)} disabled={busy || aiReady === false}>
                “{e}”
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div>{m.text}</div>
            {m.question && <div className="small" style={{ color: 'var(--warning)', marginTop: 6 }}>{m.question}</div>}
            {m.actions && m.actions.length > 0 && (
              <div className="col" style={{ gap: 4, marginTop: 8 }}>
                {m.actions.map((a, k) => (
                  <label key={k} className="row small" style={{ alignItems: 'flex-start' }}>
                    <input type="checkbox" disabled={!!m.applied} checked={!!m.selected?.[k]} onChange={(e) => setMsgs((all) => all.map((x, j) => (j === i ? { ...x, selected: x.selected!.map((s, q) => (q === k ? e.target.checked : s)) } : x)))} />
                    <span>{describeAction(a, ctx())}</span>
                  </label>
                ))}
                {!m.applied ? (
                  <button className="btn primary sm" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => apply(i)} disabled={!m.selected?.some(Boolean)}>
                    <Check size={14} /> Aplicar {m.selected?.filter(Boolean).length} alteração(ões)
                  </button>
                ) : (
                  <div className="small" style={{ color: 'var(--success)' }}>
                    {m.applied.length} aplicada(s). Ctrl+Z desfaz uma por vez.
                  </div>
                )}
                {m.errors?.map((e, k) => (
                  <div key={k} className="small" style={{ color: 'var(--danger)' }}>{e}</div>
                ))}
              </div>
            )}
            {m.model && <div className="faint" style={{ fontSize: 10, marginTop: 6 }}>{m.model}</div>}
          </div>
        ))}
        {busy && (
          <div className="chat-msg assistant row">
            <Spinner size={14} /> Analisando o vídeo e planejando…
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <textarea
          className="textarea"
          rows={2}
          style={{ minHeight: 44 }}
          placeholder="Ex.: tire as pausas, legenda laranja e zoom nas falas fortes"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn primary icon" onClick={() => send()} disabled={busy || !text.trim() || aiReady === false} title="Enviar">
          {busy ? <Spinner size={14} /> : <Send size={16} />}
        </button>
      </div>
      <div className="faint" style={{ fontSize: 11 }}>
        <Sparkles size={11} /> Revise o plano antes de aplicar. Nada é alterado sem o seu clique.
      </div>
    </div>
  );
}
