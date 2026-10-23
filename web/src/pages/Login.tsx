import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { OrbitLogo, Field } from '../components/ui.tsx';

export function Login({ setupDone, onDone }: { setupDone: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<{ msg: string; hint?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!setupDone && password !== confirm) return setError({ msg: 'As senhas não conferem.', hint: 'Digite a mesma senha nos dois campos.' });
    setBusy(true);
    try {
      await api.post(setupDone ? '/api/auth/login' : '/api/auth/setup', { password });
      onDone();
    } catch (err) {
      const a = err as ApiError;
      setError({ msg: a.message, hint: a.hint });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card col" style={{ gap: 16 }} onSubmit={submit}>
        <div className="row" style={{ gap: 12 }}>
          <OrbitLogo size={36} />
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>GDR Orbit</div>
            <div className="muted small">Seu conteúdo, sua operação e seus resultados no mesmo lugar.</div>
          </div>
        </div>
        {!setupDone && (
          <div className="alert info small">
            <div>
              <div className="title">Primeiro acesso</div>
              Crie a senha que protege o GDR Orbit neste computador. Ela é guardada apenas aqui, de forma criptografada.
            </div>
          </div>
        )}
        <Field label={setupDone ? 'Senha' : 'Nova senha (mínimo 8 caracteres)'}>
          <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setupDone ? 'current-password' : 'new-password'} />
        </Field>
        {!setupDone && (
          <Field label="Confirme a senha">
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </Field>
        )}
        {error && (
          <div className="alert danger small">
            <div>
              <div className="title">{error.msg}</div>
              {error.hint}
            </div>
          </div>
        )}
        <button className="btn primary" disabled={busy || !password}>
          {setupDone ? 'Entrar' : 'Criar senha e entrar'}
        </button>
      </form>
    </div>
  );
}
