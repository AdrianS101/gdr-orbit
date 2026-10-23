// Prévia de como o post aparece em cada rede (aproximação visual do app, antes de publicar).
import { useState } from 'react';
import { Heart, MessageCircle, Send, Bookmark, ChevronLeft, ChevronRight, ThumbsUp, Share2, Music2 } from 'lucide-react';

export interface PreviewMedia {
  url: string;
  kind: 'video' | 'image';
}

function Media({ items, aspect, idx, setIdx }: { items: PreviewMedia[]; aspect: string; idx: number; setIdx: (n: number) => void }) {
  const m = items[idx];
  return (
    <div style={{ position: 'relative', aspectRatio: aspect, background: '#000', overflow: 'hidden' }}>
      {m ? m.kind === 'video' ? <video src={m.url} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <img src={m.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ color: '#888', display: 'grid', placeItems: 'center', height: '100%', fontSize: 12 }}>Escolha a mídia</div>}
      {items.length > 1 && (
        <>
          {idx > 0 && <button className="pv-arrow" style={{ left: 6 }} onClick={() => setIdx(idx - 1)}><ChevronLeft size={14} /></button>}
          {idx < items.length - 1 && <button className="pv-arrow" style={{ right: 6 }} onClick={() => setIdx(idx + 1)}><ChevronRight size={14} /></button>}
          <span className="pv-count">{idx + 1}/{items.length}</span>
        </>
      )}
    </div>
  );
}

function Caption({ text, limit = 125 }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  const short = text.length > limit && !open;
  return (
    <span style={{ whiteSpace: 'pre-wrap' }}>
      {short ? text.slice(0, limit).trimEnd() + '… ' : text}
      {short && <button className="pv-more" onClick={() => setOpen(true)}>mais</button>}
    </span>
  );
}

export function SocialPreview({ network, type, items, caption, name, avatar }: { network: string; type: string; items: PreviewMedia[]; caption: string; name: string; avatar?: string | null }) {
  const [idx, setIdx] = useState(0);
  const Av = () => (avatar ? <img src={avatar} alt="" className="pv-av" /> : <span className="pv-av" style={{ background: 'var(--accent)' }} />);
  const vertical = type === 'video';

  if (network === 'tiktok' || (network === 'instagram' && vertical)) {
    return (
      <div className="pv-phone">
        <div style={{ position: 'relative', aspectRatio: '9/16', background: '#000' }}>
          <Media items={items} aspect="9/16" idx={idx} setIdx={setIdx} />
          <div className="pv-reel-ui">
            <div className="pv-reel-side">
              <Heart size={20} />
              <MessageCircle size={20} />
              {network === 'tiktok' ? <Bookmark size={20} /> : <Send size={20} />}
              <Share2 size={20} />
            </div>
            <div className="pv-reel-bottom">
              <div className="row" style={{ gap: 6, fontWeight: 700 }}>
                <Av /> {name}
              </div>
              <div style={{ marginTop: 6 }}>
                <Caption text={caption} limit={network === 'tiktok' ? 80 : 60} />
              </div>
              {network === 'tiktok' && <div className="row" style={{ gap: 4, marginTop: 4 }}><Music2 size={11} /> som original</div>}
            </div>
          </div>
        </div>
        <div className="pv-note">{network === 'tiktok' ? 'TikTok' : 'Instagram Reels'} — os botões da rede cobrem as bordas direita e inferior.</div>
      </div>
    );
  }
  if (network === 'facebook') {
    return (
      <div className="pv-phone pv-light">
        <div className="row" style={{ gap: 8, padding: 10 }}>
          <Av />
          <div>
            <b>{name}</b>
            <div style={{ fontSize: 11, color: '#65676b' }}>Agora · 🌎</div>
          </div>
        </div>
        <div style={{ padding: '0 10px 8px' }}>
          <Caption text={caption} limit={180} />
        </div>
        <Media items={items} aspect={vertical ? '9/16' : '1/1'} idx={idx} setIdx={setIdx} />
        <div className="row" style={{ justifyContent: 'space-around', padding: 8, color: '#65676b', fontSize: 12 }}>
          <span><ThumbsUp size={14} /> Curtir</span>
          <span><MessageCircle size={14} /> Comentar</span>
          <span><Share2 size={14} /> Compartilhar</span>
        </div>
      </div>
    );
  }
  return (
    <div className="pv-phone pv-light">
      <div className="row" style={{ gap: 8, padding: 10 }}>
        <Av />
        <b>{name}</b>
      </div>
      <Media items={items} aspect="4/5" idx={idx} setIdx={setIdx} />
      {items.length > 1 && (
        <div className="row" style={{ justifyContent: 'center', gap: 3, paddingTop: 6 }}>
          {items.map((_, i) => <span key={i} style={{ width: 6, height: 6, borderRadius: 9, background: i === idx ? '#0095f6' : '#c7c7c7' }} />)}
        </div>
      )}
      <div className="row" style={{ gap: 12, padding: '8px 10px' }}>
        <Heart size={20} />
        <MessageCircle size={20} />
        <Send size={20} />
        <span className="spacer" />
        <Bookmark size={20} />
      </div>
      <div style={{ padding: '0 10px 12px', fontSize: 13 }}>
        <b>{name}</b> <Caption text={caption} />
      </div>
    </div>
  );
}
