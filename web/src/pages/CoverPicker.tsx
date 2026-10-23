// Capa do Reels: um quadro do próprio vídeo ou uma imagem da Biblioteca. Mostra como fica no Reels (9:16) e na grade do perfil (3:4).
import { useEffect, useRef, useState } from 'react';
import { UploadButton } from './Library.tsx';

export type Cover = { kind: 'frame'; t: number } | { kind: 'image'; assetId: string } | null;

export function CoverPicker({ brandId, videoUrl, images, value, onChange, disabled, onUploaded }: { brandId: string; videoUrl: string | null; images: { id: string; url: string; name: string }[]; value: Cover; onChange: (c: Cover) => void; disabled?: boolean; onUploaded: (assetId: string) => void }) {
  const vRef = useRef<HTMLVideoElement>(null);
  const cRef = useRef<HTMLCanvasElement>(null);
  const [dur, setDur] = useState(0);
  const t = value?.kind === 'frame' ? value.t : 0;
  const img = value?.kind === 'image' ? images.find((i) => i.id === value.assetId) : null;

  // Recorte 3:4 central (como a grade do perfil mostra o Reels).
  const drawGrid = (src: CanvasImageSource, w: number, h: number) => {
    const c = cRef.current;
    if (!c || !w || !h) return;
    const ctx = c.getContext('2d')!;
    const target = 3 / 4;
    let sw = w, sh = h;
    if (w / h > target) sw = h * target;
    else sh = w / target;
    ctx.drawImage(src, (w - sw) / 2, (h - sh) / 2, sw, sh, 0, 0, c.width, c.height);
  };
  useEffect(() => {
    const v = vRef.current;
    if (!v || value?.kind !== 'frame') return;
    if (Math.abs(v.currentTime - t) > 0.05) v.currentTime = t;
  }, [t, value?.kind]);
  useEffect(() => {
    if (!img) return;
    const im = new Image();
    im.onload = () => drawGrid(im, im.naturalWidth, im.naturalHeight);
    im.src = img.url;
  }, [img?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!videoUrl) return <span className="faint small">Escolha o vídeo para definir a capa.</span>;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row small" style={{ gap: 12 }}>
        <label className="row"><input type="radio" disabled={disabled} checked={!value} onChange={() => onChange(null)} /> Automática (a rede escolhe)</label>
        <label className="row"><input type="radio" disabled={disabled} checked={value?.kind === 'frame'} onChange={() => onChange({ kind: 'frame', t: 0 })} /> Quadro do vídeo</label>
        <label className="row"><input type="radio" disabled={disabled} checked={value?.kind === 'image'} onChange={() => onChange({ kind: 'image', assetId: images[0]?.id ?? '' })} /> Imagem</label>
      </div>
      {value && (
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <div className="col" style={{ gap: 4, alignItems: 'center' }}>
            {value.kind === 'frame' ? (
              <video ref={vRef} src={videoUrl} muted playsInline preload="auto" onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)} onSeeked={(e) => drawGrid(e.currentTarget, e.currentTarget.videoWidth, e.currentTarget.videoHeight)} style={{ width: 90, aspectRatio: '9/16', objectFit: 'cover', background: '#000', borderRadius: 6 }} />
            ) : (
              <img src={img?.url ?? undefined} alt="" style={{ width: 90, aspectRatio: '9/16', objectFit: 'cover', background: '#000', borderRadius: 6 }} />
            )}
            <span className="faint small">Reels</span>
          </div>
          <div className="col" style={{ gap: 4, alignItems: 'center' }}>
            <canvas ref={cRef} width={90} height={120} style={{ width: 90, height: 120, background: '#000', borderRadius: 6 }} />
            <span className="faint small">Grade do perfil</span>
          </div>
          <div className="col" style={{ gap: 6, flex: 1, minWidth: 0 }}>
            {value.kind === 'frame' ? (
              <>
                <input type="range" disabled={disabled} min={0} max={Math.max(0.1, dur - 0.05)} step={0.05} value={t} onChange={(e) => onChange({ kind: 'frame', t: Number(e.target.value) })} aria-label="Quadro da capa" />
                <span className="faint small">Em {t.toFixed(1).replace('.', ',')} s. No Instagram vai como quadro escolhido; no Facebook, o quadro é enviado como imagem.</span>
              </>
            ) : (
              <>
                <div className="media-pick" style={{ maxHeight: 130 }}>
                  {images.map((i) => (
                    <button key={i.id} disabled={disabled} className={`media-pick-item ${value.assetId === i.id ? 'on' : ''}`} onClick={() => onChange({ kind: 'image', assetId: i.id })} title={i.name}>
                      <img src={i.url} alt="" />
                    </button>
                  ))}
                </div>
                {!disabled && <UploadButton brandId={brandId} primary accept="image/png,image/jpeg,image/webp" label="Enviar capa do computador" onUploaded={(a) => onUploaded(a.id)} />}
                <span className="faint small">Ideal 1080×1920 (9:16). O centro 3:4 aparece na grade do perfil.</span>
              </>
            )}
          </div>
        </div>
      )}
      <span className="faint small">No TikTok a capa é escolhida no próprio app durante a postagem assistida.</span>
    </div>
  );
}
