# GDR Orbit

> Seu conteúdo, sua operação e seus resultados no mesmo lugar.

Plataforma pessoal da agência **GDR Gestão de Resultados** (Adrian) para edição profissional de vídeo, criação de conteúdo com IA, gestão de redes sociais, atendimento/automações e análise de desempenho — por marca/cliente. Uso inicial: uma pessoa, rodando localmente no Windows.

Idioma de toda a interface, mensagens e documentação voltada ao usuário: **português do Brasil**. Mensagens de erro sempre dizem o problema **e** como resolver (`AppError(status, mensagem, dica)` no servidor; `{error, hint}` na API).

## Regras de produto (não negociáveis)

- Não apresentar processamento simulado como real; dados de demonstração sempre identificados.
- Não mostrar integração como conectada antes de verificar (ex.: IA só aparece "Conectado e testado" após uma chamada real bem-sucedida — `ai.verified`).
- Não mostrar publicação como concluída sem confirmação da rede.
- Não inventar informações de marca: campos vazios ficam de fora da IA e aparecem como "a preencher".
- Prévia e exportação precisam bater (mesma matemática e o mesmo renderizador de legendas).
- Originais nunca são alterados. Dados de cada marca separados (pastas e validação no servidor).
- Chaves nunca no navegador, código ou logs. Sem cobrança/planos nesta fase.
- Áreas futuras aparecem como "planejado para a Etapa N", sem botões falsos.

## Como rodar

Requisitos: Node ≥ 22.13 (usa `node:sqlite` e execução direta de TypeScript), FFmpeg/FFprobe no PATH (build com libass), Windows/macOS/Linux.

```bash
npm install
npm run build        # compila a interface (web/dist)
npm start            # servidor + interface em http://127.0.0.1:4310
```

Desenvolvimento (recarrega sozinho): `npm run dev` → interface em http://localhost:5173 (Vite, com proxy para a API em 4310).

No primeiro acesso a interface pede para criar a senha local (guardada com scrypt em `data/orbit.db`).

Variáveis (opcionais, em `.env` na raiz): `ORBIT_PORT` (4310), `ORBIT_HOST` (127.0.0.1; use 0.0.0.0 para abrir no celular pela rede local — o acesso continua exigindo senha), `ORBIT_DATA_DIR` (data), `ORBIT_MODELS_DIR`, `FFMPEG_PATH`, `FFPROBE_PATH`, `ANTHROPIC_API_KEY`, `CLAUDE_CLI_PATH`.

Testes:
- `npm test` — regras compartilhadas (timeline, legendas, SRT, ASS, grafo do FFmpeg).
- `npm run typecheck`
- Ponta a ponta com arquivos reais, contra um servidor com dados de teste (não toca em `data/`):
  `ORBIT_DATA_DIR=data-test npm start` e, em outro terminal, `npm run test:e2e -- <video> <logo.png>`.
  A senha de teste é gerada e guardada em `data-test/.test-credentials.json`.

### Servidor na nuvem (24h, publica com o PC desligado)
Alvo: Oracle Cloud Always Free (Ubuntu, ARM ou x64). `Dockerfile` (Node 24 + FFmpeg + fontes MS/Liberation/Noto) e `deploy/docker-compose.yml` (app + Caddy com https automático; domínio provisório `<ip-com-tracos>.sslip.io`).
- Publicar/atualizar: `deploy/deploy.sh ubuntu@IP [chave.pem]` (instala Docker e libera 80/443 na 1ª vez).
- Migrar dados do PC: `deploy/migrate-data.sh ubuntu@IP [chave.pem]`.
- `PUBLIC_URL` define os retornos OAuth (Meta/Google) e ativa cookie `secure`. Na nuvem o provedor de IA padrão é o Gemini (Claude Code local não existe lá).

## Arquitetura

```
shared/            Regras puras usadas pela interface E pelo servidor (fonte única da verdade)
  types.ts         Timeline, Marca, Asset, Job…
  timeline.ts      formatos, layout da faixa magnética, dividir/aparar/mover/duplicar, mapeamento de tempo
  captions.ts      legendas ancoradas no tempo do ORIGINAL, quebra de linha, edição, SRT
  ass.ts           gera o arquivo ASS (estilos: highlight, pop, karaoke, classic, box)
server/src/
  index.ts         Fastify: auth, rotas, fila, interface compilada
  db.ts            SQLite (node:sqlite) + migrações em ordem
  jobs/queue.ts    fila persistente (retoma após reinício, checkpoint, cancelamento real, eventos SSE)
  jobs/ingest.ts   ffprobe, proxy 540p (GOP curto), forma de onda, miniaturas, capa
  jobs/transcribe.ts + workers/transcribe-worker.ts   Whisper local (ONNX) com palavras e checkpoint por janela
  jobs/render-graph.ts + render.ts                    timeline → filter_complex do FFmpeg → MP4
  ai/providers.ts  camada de IA (API Anthropic | Claude Code local), verificação real
  ai/copy.ts       texto do post a partir da fala final + perfil da marca
  routes/*         auth, brands, assets, projects (versões, exportação, post), system (fila, fontes, config)
web/src/           React + Vite (SPA)
  editor/          Player (prévia), Timeline, painéis, store (histórico, autosave, rascunho local)
  pages/           Início, Marcas, Biblioteca, Projetos, Configurações, áreas planejadas
data/              (fora do git) orbit.db, secrets.json, storage/brands/<marca>/{originals,derived,exports}, models/
```

### Decisões e justificativas

- **React + Vite em vez de Next.js**: app local de um usuário, sem SEO/SSR; Vite é mais simples e rápido. O servidor é Fastify separado porque precisa de processos longos (FFmpeg, transcrição) e streaming de mídia com Range.
- **`node:sqlite` + TypeScript sem build no servidor**: zero dependências nativas para compilar no Windows; o servidor roda direto com `node server/src/index.ts`.
- **Timeline é JSON versionado** (`version: 1`) salvo no projeto; a prévia e o render leem o mesmo objeto. Faixa principal "magnética" (trechos em sequência) + faixa de elementos (logo/imagens) + faixa de legendas. Etapa 2 amplia para múltiplas faixas livres.
- **Legendas ancoradas no tempo do arquivo original** (`CaptionWord.s/e`): cortar, reordenar, duplicar ou mudar a velocidade não dessincroniza; correções de texto preservam tempos quando o número de palavras é o mesmo.
- **Coerência prévia × exportação**: o mesmo ASS é renderizado pela libass nos dois lados (JASSUB/WASM no navegador, filtro `ass` no FFmpeg) com as mesmas fontes (servidas por `/api/fonts/file` e copiadas para o job). Enquadramento `cover` = `object-fit/object-position` ⇔ `scale…increase,crop=(iw-W)*fx`. Logo: posição/largura normalizadas, mesma conta nos dois lados. Validado comparando quadros no mesmo instante.
- **Vídeos anamórficos** (pixels não quadrados, comum em celular): `probe` calcula dimensões de exibição com o SAR; proxy e render convertem para pixels quadrados antes de reenquadrar. (Bug real encontrado na validação com `IMG_9068.mp4`.)
- **Prévia com proxy 540p e dois `<video>` alternados** (o próximo trecho fica pré-carregado). Volume >100% via Web Audio.
- **Render**: um input do FFmpeg por trecho (`-ss/-t` antes de `-i`), `concat`, overlays com `enable=between`, `ass`, `loudnorm` opcional; saída escrita em pasta temporária e copiada só no fim (sem arquivos parciais). Encoders de hardware só são oferecidos se uma codificação de teste funcionar (`availableEncoders`).
- **Transcrição local** (Whisper `Xenova/whisper-small` q8 via `@huggingface/transformers`): sem custo e sem enviar vídeo para fora. Roda em processo separado; janelas de ~28 s cortadas em silêncios; cada janela é checkpoint (retoma após falha). Filtro de alucinações comuns do Whisper em PT ("legendas pela comunidade Amara.org").
- **IA**: provedores atrás de `generateJson`. `anthropic` usa o SDK oficial, modelo padrão `claude-opus-5-5`, saída estruturada (`output_config.format`) e fallback do servidor em recusas. `claude-cli` usa o Claude Code instalado (login da conta do usuário, `--json-schema`). Chave fica em `data/secrets.json` (nunca volta para a interface).
- **Remotion** avaliado: útil para motion graphics em React na Etapa 2, mas exige Chrome headless e licença para empresas; não resolve timeline/áudio/prévia sozinho. Decisão: FFmpeg como motor de render; motion graphics da Etapa 2 serão gerados como overlays (ASS animado / imagens / possivelmente Remotion só para títulos), mantendo o mesmo princípio de "mesmo renderizador na prévia e no export".

## Paleta inicial (ajustável em Configurações → Identidade visual)

| Token | Cor | Uso |
|---|---|---|
| `--accent` | `#FF7A00` | botões principais, seleção, progresso |
| `--accent-hover` | `#FF8F26` | hover |
| `--on-accent` | `#0B0B0C` | texto sobre laranja (contraste 8,6:1) |
| `--bg` | `#0B0B0C` | fundo |
| `--surface-1/2/3` | `#141416` / `#1C1C1F` / `#26262B` | painéis, campos, destaques |
| `--border` | `#2E2E34` | bordas |
| `--text` / `--text-2` / `--text-3` | `#F4F4F5` / `#A1A1AA` / `#71717A` | textos |
| `--success` `--warning` `--danger` `--info` | `#22C55E` `#F5B301` `#EF4444` `#60A5FA` | estados |

Fonte da interface: Inter (variável, empacotada). Ícones: lucide-react.

## Funcionalidades implementadas (Etapa 1)

- Acesso com senha local, sessão em cookie httpOnly, bloqueio após tentativas erradas.
- Marcas: perfil completo (descrição, produtos/serviços, público, posicionamento, objetivos, tom de voz, exemplos, expressões a usar/evitar, cores, fontes, logo, referências, base de conhecimento), lista do que falta preencher, seletor global de marca / visão geral.
- Biblioteca por marca: envio com progresso (streaming), importação por caminho local, detecção de duplicados (SHA-256), etiquetas e busca, fontes TTF/OTF da marca, preparação em segundo plano.
- Projetos: formatos 9:16, 16:9, 1:1, 4:5 e personalizado; status Rascunho → Em produção → Em revisão → Aprovado.
- Editor: timeline com miniaturas e forma de onda, zoom, dividir (S), aparar pelas bordas, reordenar arrastando, duplicar, excluir, velocidade, volume (0–200%), enquadramento (preencher / inteiro com fundo desfocado / barras), foco do reenquadramento, logo/imagens arrastáveis na prévia com tamanho/opacidade/tempo, guias de área segura das redes, desfazer/refazer (agrupando ajustes contínuos), salvamento automático com controle de conflito, rascunho local para recuperar após queda, versões automáticas (5 min) e nomeadas, backup JSON do projeto.
- Legendas: transcrição local com tempo por palavra, geração automática, 5 estilos (destaque, pop, karaokê, clássica, caixa), cores (inclusive as da marca), fonte, tamanho, posição, contorno, sombra, maiúsculas, caracteres por linha, quebra manual (Enter), correção de texto e de tempo, juntar/excluir, importar/exportar SRT, estilo salvo como padrão da marca.
- Exportação MP4 real (H.264/AAC, faststart) em fila com progresso, cancelamento, nova tentativa e retomada após reinício; resolução, FPS, qualidade, CPU ou Intel QuickSync/NVIDIA (se funcionarem); normalização −14 LUFS; assistir e baixar.
- Texto do post: gerado da fala que ficou no vídeo final + perfil da marca, por rede (Instagram, TikTok, Facebook, LinkedIn, YouTube Shorts), com variações, pontos de atenção e informações faltantes; editável e salvo no projeto.
- Início: falhas, processamentos ativos, revisões pendentes, projetos em andamento, exportações recentes, perfis incompletos; avisos honestos para calendário e métricas (ainda não existem).
- Celular: navegação inferior, modo revisão no editor (assistir, exportar, mudar status).

### Validado com arquivos reais
`IMG_9068.mp4` (4K, 59,94 fps, anamórfico 9:16, 55 s) + `Icone GDR.png`: importação, duplicado detectado, proxy, transcrição (144 palavras PT-BR), cortes, 45 legendas, logo, exportação 1080×1920/30 fps/18,00 s, áudio normalizado (pico −1,5 dB) e comparação quadro a quadro prévia × MP4.

## Etapa 2 (em andamento) — já implementado
- shared/effects.ts: filtros de cor (presets + brilho/contraste/saturação/temperatura; SVG na prévia ⇔ lutrgb+colorchannelmixer no FFmpeg), zoom animado (CSS scale ⇔ zoompan), transições sem sobreposição (escurecer, flash branco, zoom), música com ducking determinístico pelos intervalos de fala, remoção de pausas sem cortar palavras.
- Títulos, lower thirds e chamadas como TextClip no mesmo ASS das legendas (mesmo renderizador nos dois lados).
- shared/edit-actions.ts: catálogo de ações (remove_pauses, cut, keep_only, captions, logo, text, transitions, filter, zoom, dynamic_zoom, speed, music, format). Chat da IA (server/src/ai/edit-chat.ts) só escolhe ações deste catálogo; a interface mostra o plano, aplica cada ação como um passo de desfazer. Ações rápidas usam o mesmo motor sem IA.
- Provedor Gemini (gratuito, chave em Configurações → IA), preferido no modo automático para não gastar tokens do Claude. Validado: render real com zoom/filtro/transições/título/música; ações rápidas na interface. Pendente de validar: chat com Gemini (precisa da chave do usuário).
- Ainda falta da Etapa 2: múltiplas faixas livres, keyframes, sobreposição de vídeos (PiP), redução de ruído, "3 Reels a partir de uma entrevista", referência de ritmo.

## Etapa 3 (em andamento) — redes sociais
- server/src/social/meta.ts: OAuth da Meta (app do próprio usuário, modo desenvolvimento), Páginas + Instagram profissional, publicação real: Reels (upload resumível, sem URL pública), imagem (hospedada como foto não publicada da Página para obter URL), carrossel (2–10), vídeo/foto/multi-foto no Facebook. "Publicado" só com id + permalink da API. Tokens criptografados (AES-GCM, lib/vault.ts).
- server/src/social/routes.ts: contas por marca, posts (vídeo, imagem, carrossel) com texto por rede, fluxo Rascunho → Revisão → Aprovado → Agendado → Publicando → Publicado/Falhou/Aguardando manual; agendador a cada 20 s; se o app estava desligado (>15 min de atraso) não publica sozinho; job de publicação não é retomado após queda (evita duplicidade) e reaproveita o container do Instagram em nova tentativa.
- TikTok: fluxo assistido (baixar vídeo, copiar texto, abrir TikTok, colar link para registrar). Postagem direta exige app aprovado pelo TikTok.
- web/src/pages/Content.tsx (calendário mensal + lista + filtros), SocialPreview.tsx (prévia Instagram feed/Reels, Facebook, TikTok), SocialAccounts.tsx, MetaSettings.tsx.
- Validado: fluxo de status e TikTok assistido via API com dados de teste. App Meta "GDR Orbit" (ID 2375388399959584, modo desenvolvimento) criado e perfis conectados pelo usuário; publicação real ainda não testada.
- Compositor aceita anexar arquivo do computador (vai para a Biblioteca da marca e é selecionado ao ficar pronto) além de vídeos exportados/arquivos da Biblioteca.
- Google Drive (server/src/drive.ts): OAuth somente leitura com cliente Google do usuário, pastas vinculadas por marca, verificação a cada 15 min (conta novos), importação manual ou automática por pasta, dedupe por id do Drive (assets.source_ref) e SHA-256. Nunca publica. Pendente: credenciais Google do usuário.
- Biblioteca mostra uso de cada arquivo (projetos/posts) e botão "Editar" cria projeto a partir do vídeo.

## Etapa 4 (em andamento) — Resultados
- server/src/social/insights.ts + results-routes.ts: totais da conta por período (IG: views, reach, accounts_engaged, interações, curtidas, comentários, compartilhamentos, salvamentos, visitas ao perfil, novos seguidores, cliques no link; FB Página: métricas page_* toleradas individualmente) com comparação ao período anterior; janelas de 30 dias (limite da API, avisado na tela); cache de 1 h; métricas indisponíveis = "—", nunca estimadas.
- Conteúdos (media_items) sincronizados pelo job 'metrics' com métricas por post; ranking ordenável; CSV.
- Tráfego pago: token de usuário Meta (60 dias, criptografado) + ads_read; conta de anúncio escolhida por marca; anúncios do período com investimento/alcance/cliques/CTR/CPC/resultados e vínculo ao post promovido (effective_instagram_media_id / object_story_id) → selo "Impulsionado" no ranking.
- Permissões adicionadas no app Meta: instagram_manage_insights, read_insights, ads_read (caso de uso API de Marketing). Usuário precisa reconectar os perfis para conceder.
- Relatório padrão GDR: espaço reservado, aguardando o modelo do usuário.
- PWA: manifest + service worker mínimo + ícones GDR (instalável no celular).

## Dependências e limitações conhecidas

- **IA para texto do post**: precisa de (a) login no Claude Code deste computador (`claude` no terminal, uma vez) **ou** (b) chave da API Anthropic em Configurações → IA. Sem isso a geração mostra o erro e como resolver. *Validado em 2026-10-22 com o Claude Code logado (opus): texto gerado só com base na fala real, com alertas do que não inventou.*
- **Desempenho**: neste notebook (i5-5200U, 2 núcleos) o render de fonte 4K60 roda ~0,25× o tempo real na CPU; Intel QuickSync ~2× mais rápido. A transcrição "Precisa" leva ~1× a duração do vídeo; a "Rápida" (whisper-base) ~3× mais rápida com mais erros. Primeira transcrição baixa ~250 MB do Hugging Face.
- Prévia depende de navegador com WebAssembly + OffscreenCanvas (Chrome/Edge/Firefox atuais). Se a prévia de legendas falhar, a exportação não é afetada (aviso na tela).
- Fontes de legenda: fontes instaladas no Windows ou enviadas na Biblioteca da marca (TTF/OTF).
- Faixa de vídeo é sequencial (sem sobreposição de vídeos, transições ou faixas de música) — vem na Etapa 2.
- Senha local única; sem multiusuário.

## Próximas etapas e critérios de conclusão

**Etapa 2 — Editor avançado.** Múltiplas faixas livres de vídeo/áudio/texto; keyframes (posição, escala, opacidade, rotação); transições com parâmetros; títulos, lower thirds, contadores e motion graphics como templates editáveis; música com ducking automático sob a voz, fades, redução de ruído; biblioteca de trilhas com origem/licença; edição por linguagem natural (plano de edição proposto pela IA aplicado como itens editáveis e desfazíveis na timeline — ex.: remover pausas via `rippleDelete` com silêncios da transcrição, sem cortar falas no meio).
*Critérios:* exportar um vídeo com ≥3 faixas, 1 transição, 1 título animado, música com ducking; comando "retire as pausas" gera alterações revisáveis e desfazíveis uma a uma; prévia × export conferidos por quadro.

**Etapa 3 — Operação social.** Calendário/lista com filtros e fluxo Rascunho → Em produção → Em revisão → Aprovado → Agendado → Publicado/Falhou; fuso horário; prevenção de duplicidade; Google Drive por marca (importa, detecta novos, não publica sozinho); primeira rede via API oficial (Instagram Graph API — conta profissional, `instagram_content_publish`), com fluxo assistido onde não houver publicação direta.
*Critérios:* publicar um Reels real agendado, status "Publicado" só após confirmação da API com link; falha registrada e reprocessável.

**Etapa 4 — Dados e inteligência.** Coleta de métricas com origem/período/última atualização; importação manual identificada; análise de perfil; pesquisa de tendências com fontes e datas (verificado × observação × hipótese); assistente de dados por conversa; recomendações → pautas/roteiros/projetos.

**Etapa 5 — Atendimento e automações.** Caixa de entrada (onde as APIs permitirem), respostas sugeridas com base de conhecimento, modo manual/automático, pausa por conversa, registro do enviado × sugerido; fluxos comentário→DM com palavra-chave, prévia/teste, histórico e anti-duplicidade, respeitando janelas de 24 h da Meta.
