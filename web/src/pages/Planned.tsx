import { CalendarDays, Inbox, Workflow, BarChart3, Compass } from 'lucide-react';
import { Link } from 'react-router-dom';

// Áreas planejadas para as próximas etapas. Mostram com clareza o que virá,
// sem botões falsos nem dados inventados.
const AREAS = {
  conteudo: {
    icon: CalendarDays,
    title: 'Conteúdo e calendário',
    stage: 'Etapa 3 — Operação social',
    items: [
      'Calendário e lista de publicações com filtros por marca, perfil, formato e status',
      'Fluxo: Rascunho → Em produção → Em revisão → Aprovado → Agendado → Publicado ou Falhou',
      'Preparar vídeo, capa, texto, data e horário, com controle de fuso horário',
      'Integração oficial com a primeira rede (Instagram via API da Meta), verificada antes de aparecer como conectada',
      'Pastas do Google Drive por marca, sem publicar nada automaticamente',
    ],
    now: 'Hoje: os vídeos exportados e os textos de post ficam guardados dentro de cada projeto.',
  },
  inbox: {
    icon: Inbox,
    title: 'Caixa de entrada',
    stage: 'Etapa 5 — Atendimento e automações',
    items: ['Mensagens e comentários das redes onde as integrações oficiais permitirem', 'Histórico por contato, etiquetas e filtros', 'Respostas sugeridas pela IA com base na base de conhecimento da marca', 'Modo manual e automático, pausa por conversa e registro do que foi enviado'],
    now: 'Você já pode preencher a Base de conhecimento de cada marca — ela será usada aqui.',
  },
  automacoes: {
    icon: Workflow,
    title: 'Automações',
    stage: 'Etapa 5 — Atendimento e automações',
    items: ['Comentário com palavra-chave → DM com material (ex.: "GUIA")', 'Editor visual simples de fluxo, prévia e teste', 'Histórico de execução e prevenção de respostas duplicadas', 'Respeito às permissões e janelas oficiais de cada rede'],
    now: 'Depende da conexão com as redes (Etapa 3).',
  },
  resultados: {
    icon: BarChart3,
    title: 'Resultados',
    stage: 'Etapa 4 — Dados e inteligência',
    items: ['Alcance, engajamento, compartilhamentos, salvamentos e seguidores, com origem e data de atualização', 'Comparação entre conteúdos e períodos equivalentes', 'Análise de perfil e recomendações com evidência, mudança sugerida e métrica a acompanhar', 'Assistente para perguntas sobre os dados e importação manual identificada'],
    now: 'Nenhuma métrica é exibida até haver uma fonte real conectada ou importada.',
  },
  '404': { icon: Compass, title: 'Página não encontrada', stage: '', items: [], now: '' },
} as const;

export function PlannedPage({ area }: { area: keyof typeof AREAS }) {
  const a = AREAS[area];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{a.title}</h1>
          {a.stage && <p>Planejado para a {a.stage}.</p>}
        </div>
      </div>
      {area === '404' ? (
        <p className="muted">
          Esse endereço não existe. <Link to="/" style={{ color: 'var(--accent)' }}>Voltar ao início</Link>
        </p>
      ) : (
        <div className="card col" style={{ maxWidth: 720, gap: 14 }}>
          <div className="row" style={{ gap: 12 }}>
            <a.icon size={28} color="var(--accent)" />
            <span className="badge">Ainda não disponível</span>
          </div>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>O que esta área vai fazer</div>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-2)', lineHeight: 1.8 }}>
              {a.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
          <div className="alert info small">{a.now}</div>
        </div>
      )}
    </>
  );
}
