import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, Plus } from 'lucide-react';
import { api, media } from '../lib/api.ts';
import { useApp, showError } from '../lib/store.ts';
import { Empty, Field, Modal } from '../components/ui.tsx';

export function NewBrandModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const { loadBrands, setScope } = useApp();
  const nav = useNavigate();
  const create = async () => {
    setBusy(true);
    try {
      const b = await api.post('/api/brands', { name });
      await loadBrands();
      setScope(b.id);
      onClose();
      nav(`/marcas/${b.id}`);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Nova marca ou cliente"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={!name.trim() || busy} onClick={create}>Criar marca</button>
        </>
      }
    >
      <Field label="Nome" help="Você completa o perfil (público, tom de voz, cores, logo) na próxima tela.">
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()} placeholder="Ex.: GDR Gestão de Resultados" />
      </Field>
    </Modal>
  );
}

export function BrandsPage() {
  const { brands, brandsLoaded, loadBrands } = useApp();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('nova') === '1');
  useEffect(() => {
    loadBrands().catch(showError);
  }, [loadBrands]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Marcas e clientes</h1>
          <p>Cada marca tem seu próprio espaço: perfil, arquivos, projetos e conhecimento ficam separados.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Nova marca
          </button>
        </div>
      </div>
      {brandsLoaded && !brands.length && (
        <Empty icon={<Building2 size={36} />} title="Nenhuma marca ainda" action={<button className="btn primary" onClick={() => setCreating(true)}>Cadastrar primeira marca</button>}>
          Cadastre a GDR e os clientes com quem você trabalha.
        </Empty>
      )}
      <div className="grid auto">
        {brands.map((b) => {
          const total = 10;
          const done = total - b.missing.length;
          return (
            <Link key={b.id} to={`/marcas/${b.id}`} className="card hover col" style={{ gap: 12 }}>
              <div className="row" style={{ gap: 12 }}>
                <div className="thumb contain" style={{ width: 48, aspectRatio: '1', flex: 'none', background: 'var(--bg)' }}>
                  {b.profile.logoAssetId ? <img src={media.original(b.profile.logoAssetId)} alt="" /> : <Building2 size={20} />}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 700 }}>{b.name}</div>
                  <div className="row" style={{ gap: 4, marginTop: 4 }}>
                    {b.profile.colors.slice(0, 5).map((c) => (
                      <span key={c.hex} className="swatch" style={{ background: c.hex, width: 14, height: 14 }} />
                    ))}
                  </div>
                </div>
              </div>
              <div className="faint small" style={{ minHeight: 34 }}>{b.profile.description || 'Descrição ainda não preenchida.'}</div>
              <div className="row">
                <div className="progress" style={{ flex: 1 }}>
                  <div style={{ width: `${(done / total) * 100}%` }} />
                </div>
                <span className="small muted">Perfil {done}/{total}</span>
              </div>
            </Link>
          );
        })}
      </div>
      {creating && (
        <NewBrandModal
          onClose={() => {
            setCreating(false);
            if (params.get('nova')) setParams({});
          }}
        />
      )}
    </>
  );
}
