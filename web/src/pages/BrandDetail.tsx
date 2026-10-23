import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, ImagePlus, Plus, Trash2, AlertCircle } from 'lucide-react';
import { api, media } from '../lib/api.ts';
import { useApp, showError, type BrandWithMissing } from '../lib/store.ts';
import { Field, Modal } from '../components/ui.tsx';
import { UploadButton } from './Library.tsx';
import { SocialAccounts } from './SocialAccounts.tsx';
import type { Asset, BrandProfile } from '../../../shared/types.ts';

type Section = 'essencial' | 'publico' | 'voz' | 'visual' | 'conhecimento' | 'perfis';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'essencial', label: 'Essencial' },
  { id: 'publico', label: 'Público e posicionamento' },
  { id: 'voz', label: 'Tom de voz' },
  { id: 'visual', label: 'Identidade visual' },
  { id: 'conhecimento', label: 'Base de conhecimento' },
  { id: 'perfis', label: 'Perfis sociais' },
];

function Text({ label, help, value, onChange, rows = 3, placeholder }: { label: string; help?: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return (
    <Field label={label} help={help}>
      <textarea className="textarea" rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

export function BrandDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { loadBrands, setScope, scope } = useApp();
  const [brand, setBrand] = useState<BrandWithMissing | null>(null);
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<BrandProfile | null>(null);
  const [section, setSection] = useState<Section>(() => (new URLSearchParams(location.search).has('meta') || new URLSearchParams(location.search).has('metaErro') ? 'perfis' : 'essencial'));
  const [saving, setSaving] = useState(false);
  const [images, setImages] = useState<Asset[]>([]);
  const [pickLogo, setPickLogo] = useState(false);

  const load = () =>
    api.get<BrandWithMissing>(`/api/brands/${id}`).then((b) => {
      setBrand(b);
      setName(b.name);
      setProfile(b.profile);
    }, showError);
  const loadImages = () => api.get<Asset[]>(`/api/assets?brandId=${id}&kind=image`).then(setImages, showError);

  useEffect(() => {
    load();
    loadImages();
    if (id && scope !== id) setScope(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const dirty = useMemo(() => !!brand && !!profile && (name !== brand.name || JSON.stringify(profile) !== JSON.stringify(brand.profile)), [brand, profile, name]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!brand || !profile) return null;
  const set = <K extends keyof BrandProfile>(k: K, v: BrandProfile[K]) => setProfile({ ...profile, [k]: v });

  const save = async () => {
    setSaving(true);
    try {
      const b = await api.put<BrandWithMissing>(`/api/brands/${id}`, { name, profile });
      setBrand(b);
      setProfile(b.profile);
      await loadBrands();
      useApp.getState().toast({ kind: 'success', title: 'Perfil da marca salvo' });
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Excluir a marca "${brand.name}"? Isso só é permitido se ela não tiver projetos.`)) return;
    try {
      await api.del(`/api/brands/${id}`);
      await loadBrands();
      nav('/marcas');
    } catch (e) {
      showError(e);
    }
  };

  return (
    <>
      <div className="page-head">
        <button className="btn ghost sm icon" onClick={() => nav('/marcas')} aria-label="Voltar">
          <ArrowLeft size={16} />
        </button>
        <div style={{ flex: 1, minWidth: 220 }}>
          <input className="input" style={{ fontSize: 20, fontWeight: 700, background: 'transparent', border: '1px solid transparent', padding: '4px 6px' }} value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome da marca" />
        </div>
        <div className="actions">
          <button className="btn ghost danger sm" onClick={remove}>
            <Trash2 size={14} /> Excluir
          </button>
          <button className="btn primary" disabled={!dirty || saving} onClick={save}>
            {dirty ? 'Salvar alterações' : <><Check size={16} /> Salvo</>}
          </button>
        </div>
      </div>

      {brand.missing.length > 0 && (
        <div className="alert warning" style={{ marginBottom: 16 }}>
          <AlertCircle size={18} color="var(--warning)" style={{ flex: 'none' }} />
          <div>
            <div className="title">Campos que precisam ser preenchidos por você</div>
            <div className="muted small">O GDR Digital não inventa informações sobre a marca. Estes campos ficam de fora dos textos da IA até serem preenchidos: {brand.missing.join(', ')}.</div>
          </div>
        </div>
      )}

      <div className="tabs">
        {SECTIONS.map((s) => (
          <button key={s.id} className={section === s.id ? 'on' : ''} onClick={() => setSection(s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="card col" style={{ gap: 16, maxWidth: 860 }}>
        {section === 'essencial' && (
          <>
            <Text label="Descrição" help="O que a marca faz, em 2 ou 3 frases." value={profile.description} onChange={(v) => set('description', v)} />
            <Text label="Produtos e serviços" help="Um por linha. Inclua apenas o que é oferecido de fato." rows={5} value={profile.productsServices} onChange={(v) => set('productsServices', v)} />
            <Text label="Objetivos" help="Ex.: gerar leads para consultoria, fortalecer autoridade no nicho." value={profile.objectives} onChange={(v) => set('objectives', v)} />
          </>
        )}
        {section === 'publico' && (
          <>
            <Text label="Público" help="Quem a marca quer alcançar: perfil, dores, momento de compra." rows={4} value={profile.audience} onChange={(v) => set('audience', v)} />
            <Text label="Posicionamento" help="Como a marca quer ser percebida e o que a diferencia." rows={4} value={profile.positioning} onChange={(v) => set('positioning', v)} />
          </>
        )}
        {section === 'voz' && (
          <>
            <Text label="Tom de voz" help="Ex.: direto, próximo, técnico sem ser frio. Use exemplos." rows={3} value={profile.toneOfVoice} onChange={(v) => set('toneOfVoice', v)} />
            <Text label="Exemplos de comunicação" help="Cole textos aprovados que representam bem a marca." rows={6} value={profile.communicationExamples} onChange={(v) => set('communicationExamples', v)} />
            <div className="grid cols-2">
              <Text label="Expressões a usar" help="Uma por linha." value={profile.wordsToUse} onChange={(v) => set('wordsToUse', v)} />
              <Text label="Expressões a evitar" help="Uma por linha." value={profile.wordsToAvoid} onChange={(v) => set('wordsToAvoid', v)} />
            </div>
          </>
        )}
        {section === 'visual' && (
          <>
            <Field label="Logo" help="Usado nos vídeos e como referência visual. Prefira PNG com fundo transparente.">
              <div className="row" style={{ gap: 12 }}>
                <div className="thumb contain" style={{ width: 96, aspectRatio: '1', background: 'var(--bg)' }}>
                  {profile.logoAssetId ? <img src={media.original(profile.logoAssetId)} alt="Logo" /> : <ImagePlus size={22} />}
                </div>
                <button className="btn sm" onClick={() => setPickLogo(true)}>
                  {profile.logoAssetId ? 'Trocar logo' : 'Escolher logo'}
                </button>
                {profile.logoAssetId && (
                  <button className="btn ghost sm" onClick={() => set('logoAssetId', null)}>
                    Remover
                  </button>
                )}
              </div>
            </Field>
            <Field label="Cores" help="A primeira cor é usada como destaque padrão nas legendas desta marca.">
              <div className="col">
                {profile.colors.map((c, i) => (
                  <div className="row" key={i}>
                    <input type="color" value={c.hex} onChange={(e) => set('colors', profile.colors.map((x, k) => (k === i ? { ...x, hex: e.target.value.toUpperCase() } : x)))} />
                    <input className="input sm mono" style={{ width: 100 }} value={c.hex} onChange={(e) => set('colors', profile.colors.map((x, k) => (k === i ? { ...x, hex: e.target.value } : x)))} />
                    <input className="input sm" style={{ maxWidth: 220 }} placeholder="Nome (ex.: Laranja principal)" value={c.name} onChange={(e) => set('colors', profile.colors.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
                    <button className="btn ghost sm icon" aria-label="Remover cor" onClick={() => set('colors', profile.colors.filter((_, k) => k !== i))}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <div>
                  <button className="btn sm" onClick={() => set('colors', [...profile.colors, { name: '', hex: '#FF7A00' }])}>
                    <Plus size={14} /> Adicionar cor
                  </button>
                </div>
              </div>
            </Field>
            <Text label="Fontes" help="Nomes das fontes da marca. Para usá-las nas legendas, envie os arquivos TTF/OTF na Biblioteca." rows={2} value={profile.fonts} onChange={(v) => set('fonts', v)} />
            <Text label="Referências visuais" help="Links ou descrição do estilo visual desejado." rows={3} value={profile.visualReferences} onChange={(v) => set('visualReferences', v)} />
          </>
        )}
        {section === 'conhecimento' && (
          <Text
            label="Base de conhecimento"
            help="Informações confirmadas que a IA pode usar em textos e, futuramente, no atendimento: perguntas frequentes, diferenciais, políticas. Não inclua preços que mudam com frequência."
            rows={14}
            value={profile.knowledgeBase}
            onChange={(v) => set('knowledgeBase', v)}
          />
        )}
        {section === 'perfis' && <SocialAccounts brandId={brand.id} />}
      </div>

      {pickLogo && (
        <Modal title="Escolher logo" onClose={() => setPickLogo(false)} wide>
          <div className="row">
            <span className="muted small">Imagens desta marca na Biblioteca</span>
            <span className="spacer" />
            <UploadButton brandId={brand.id} accept="image/png,image/jpeg,image/webp" label="Enviar imagem" onUploaded={() => loadImages()} />
          </div>
          {images.length === 0 && <p className="muted">Nenhuma imagem ainda. Envie o arquivo do logo.</p>}
          <div className="grid auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
            {images.map((a) => (
              <button
                key={a.id}
                className="card hover col"
                style={{ padding: 8, gap: 6, borderColor: profile.logoAssetId === a.id ? 'var(--accent)' : undefined }}
                disabled={a.status !== 'ready'}
                onClick={() => {
                  set('logoAssetId', a.id);
                  setPickLogo(false);
                }}
              >
                <div className="thumb contain" style={{ background: 'var(--bg)' }}>
                  <img src={media.original(a.id)} alt="" />
                </div>
                <span className="small ellipsis">{a.name}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
