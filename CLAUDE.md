# GDR Digital

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
- Chat de edição decidido: a IA interpreta pedidos livres/vagos ("mais dinâmico", "cara de cinema", "tá com chiado") em combinações de ações e o editor APLICA NA HORA (cada ação um passo de desfazer; botão "Desfazer" reverte o pedido inteiro). Só pergunta quando é impossível decidir. O histórico enviado inclui o que foi aplicado/desfeito para pedidos como "mais forte" ou "tira isso".
- Referência de recursos: docs/capcut-catalogo-referencia.txt (texto extraído do "Mapa da interface do CapCut Web": painéis e catálogo de nomes — 2.091 efeitos, 790 transições, 626 filtros, 2.329 animações). Uso: inspiração para versões próprias; não copiar assets nem código do CapCut.
- Provedor Gemini (gratuito, chave em Configurações → IA), preferido no modo automático para não gastar tokens do Claude. Validado: render real com zoom/filtro/transições/título/música; ações rápidas na interface. Pendente de validar: chat com Gemini (precisa da chave do usuário).
- Faixas livres e quadros-chave (shared/keyframes.ts):
  - `layers` (vídeo/imagem em faixas acima da principal): modo PiP (largura relativa) ou B-roll (cobre o quadro); posição, escala, rotação e opacidade fixas ou por quadros-chave (linear/suave). Logo/imagens (`overlays`) também aceitam rotação e quadros-chave.
  - Mesma matemática nos dois lados: `transformAt` (prévia, CSS `translate(-50%,-50%) rotate()` + largura × escala) ⇔ `kfExpr` (expressões if/lt/clip no `overlay` x/y, `rotate` e `scale eval=frame`); opacidade animada via `sendcmd` no `colorchannelmixer`. Teste compara a expressão do FFmpeg com a prévia em vários instantes.
  - `audioClips` (faixas de áudio: narração, efeitos) com volume e fades lineares (afade ⇔ `audioClipGain`), mixados com `adelay` + `amix`.
  - Cortes (`rippleDelete`) deslocam o início das faixas livres.
- Redução de ruído por trecho/faixa (`denoise: light|strong` → highpass + afftdn). A prévia comum toca o original; o painel oferece "Ouvir amostra tratada" (15 s gerados no servidor com a mesma cadeia da exportação).
- IA: ações `denoise`, `pip` (com entrada animada por quadros-chave) e `broll` no catálogo do chat.
- Validado: render sintético com PiP animado + B-roll + logo girado + faixa de áudio + redução de ruído; editor no navegador (servidor de teste): PiP, quadros-chave, amostra tratada, exportação.
- Reels a partir de uma entrevista (Biblioteca → botão "Reels"; shared/studio.ts + server/src/routes/studio.ts): transcrição → frases (`splitSentences`) → IA escolhe trechos por índice de frase (corte sempre em fim de frase, sem sobreposição, duração validada em `sanitizePicks`) → revisão (prévia, nome, título) → cria 1 projeto por corte com remover pausas, legendas, logo e título de abertura. Validado: sugestões reais com Gemini num vídeo de 113 s; projetos criados e exportados.
- Cortes virais com 1 clique (Biblioteca → Reels → "Gerar cortes virais"): IA em modo viral (gancho nos 3 primeiros segundos, estrutura início/meio/fim obrigatória, nota de retenção 0-100, frase-teaser dentro do trecho) → cada corte abre com a frase mais forte (≤7 s, `hookRange`) e corta com flash para o trecho completo; estilo: legenda grande 3 palavras com destaque (`VIRAL_CAPTION`), filtro cinema, ritmo 2,6 s com punch-in, redução de ruído leve, logo, título; exportação automática (QSV/NVENC se disponível). Dois estilos: "Impacto" (legenda grande colorida, cortes rápidos 2,6 s) e "Podcast cinematográfico" (padrão; estudado do corte do JotaJota Podcast enviado como referência: legenda branca minúscula 3 palavras com a palavra falada crescendo, Segoe UI Black sem contorno, sombra suave, baixa no quadro; @ do perfil acima; filtro `podcast` dessaturado e quente; push-ins lentos a cada ~6 s em vez de cortes secos). Validado na base de teste: seleção, montagem e exportação dos dois estilos.
- Tela "Cortes com IA" estilo Vizard (/cortes/:assetId; Biblioteca → "Cortes com IA"; web/src/pages/Clips.tsx + server/src/routes/clips.ts): preferências (duração preferida auto/<30/30-60/60-90/90-180 s, quantidade AUTOMÁTICA — a IA lê a transcrição inteira e devolve todos os trechos bons até 15 — ou fixa, formato 9:16/1:1/16:9, estilo Animada/Podcast/Impacto, destacar palavras-chave, luz automática, remover pausas, logo, exportar já, assuntos e "momentos exatos": intervalos mm:ss–mm:ss viram cortes garantidos ajustados a frases inteiras); lista com nota /10, título, trecho com tempos, vídeo exportado ou prévia, Publicar (rascunho no calendário), Baixar, Editar, Reexportar, Excluir; seleção em massa e barra lateral (formato, remover silêncio, legenda, filtro, zoom dinâmico, limpar áudio) que aplica nos selecionados e reexporta. Metadados em projects.clip_meta. Conversas longas são lidas INTEIRAS em janelas de ~40 mil caracteres com 12 frases de sobreposição; os melhores trechos de todas as janelas são unidos, sem sobreposição, e ranqueados (validado: vídeo real de 64 min lido em 2 partes, cortes de 10:45 a 56:50). Até 20 cortes.
- Enquadramento automático (server/src/lib/reframe.ts + workers/detect-worker.ts): detector local YOLOS-tiny (transformers.js/ONNX, ~26 MB baixado do Hugging Face no 1º uso, sem custo e sem enviar vídeo) acha a pessoa principal (maior área × confiança) no meio de cada trecho do corte e converte em focusX/focusY do recorte cover (o mesmo foco que prévia e exportação usam); trecho sem pessoa herda o vizinho. Só roda quando o formato do vídeo difere do formato do corte (ex.: podcast 16:9 → Reels 9:16). Validado: sujeito na borda direita — corte no centro perdia a pessoa, automático enquadra (foco 0,845). Quem focar (preferências e barra lateral "Quem focar"): pessoa principal, esquerda, direita, centro ou "Escolher na imagem" (GET /api/assets/:id/people mostra um quadro com as pessoas; o clique vira {mode:"pick",x} e cada trecho segue a pessoa mais próxima dessa posição). Dois quadros por trecho (1/3 e 2/3), limiar 0,45, pessoas minúsculas ignoradas; trecho sem pessoa herda o vizinho mais próximo. Validado com vídeo de duas pessoas: esquerda/direita/clique enquadram a pessoa certa.
- Zoom dinâmico refeito: ponto do zoom próprio (VideoClip.zoomX/zoomY, padrão 0,5/0,42; o enquadramento automático põe no rosto) em vez do foco do recorte (que fazia o zoom fugir da pessoa); movimento suave (smoothstep) e, na exportação, scale por quadro + crop no lugar do zoompan (que arredondava pixels e tremia). Prévia = transform-origin no mesmo ponto.
- Cortes com IA rodam como job "clips" (POST /api/assets/:id/clips/generate → suggestCuts + createCuts em server/src/routes/studio.ts), com progresso em Processamentos: antes era uma requisição só, que passava do limite de 5 min do Node em vídeos longos e não criava nada. Transcrição lida em partes de ~22 mil caracteres, até 6 em paralelo; tempo-limite do Gemini proporcional ao texto. Detector: entrada do modelo em 320 px (0,5 s/quadro neste notebook, era ~1,7 s) e quadros a cada 3 s do vídeo compartilhados entre trechos (remover pausas gera dezenas de trechos por corte); "pessoa principal" mantém quem já estava em foco quando há duas pessoas de tamanho parecido. Validado no podcast real de 64 min: 2 cortes / 46 trechos enquadrados em ~70 s (antes > 10 min).
- Cortes personalizáveis: legendas, abertura com a frase mais forte, palavras-chave, remover pausas, luz, limpar áudio, logo, filtro (do estilo/nenhum/qualquer preset) e movimento (zoom/troca de plano ou câmera parada) ligáveis um a um; barra lateral tem "Sem legenda".
- Legenda "Animada" (preset bounce, estudada do vídeo FOI NA PORTARIA…): maiúsculas Arial Black, palavra falada cresce ~130% alternando verde #2EE66B / amarelo #FFD400; palavras-chave do corte (CaptionWord.k) ficam sempre na cor de destaque.
- Luz automática (server/src/lib/exposure.ts): signalstats do trecho → brilho guiado pelas altas luzes (alvo 195/255 no 90º percentil, ±20%, fundo escuro de estúdio não é corrigido) + contraste se a imagem estiver lavada; entra no ColorAdjust (prévia = exportação).
- Efeitos próprios (inspirados em docs/capcut-catalogo-referencia.txt, sem copiar assets): transições cruzadas extras via xfade com prévia equivalente (cortina →/↑/↓, deslizar →/↑/↓, círculo, mergulho), 13 filtros de cor novos e efeitos de vídeo por trecho (barras de cinema = drawbox ⇔ divs; vinheta = vignette ⇔ gradiente radial; tremor = crop animado ⇔ translate com a mesma fórmula shakeAt). Disponíveis na aba Efeitos e no chat da IA (ação effect). Transição "Glitch digital" (vídeo de referência): rgbashift + noise só na janela da transição; na prévia o deslocamento de cor é desenhado com sombras vermelha/ciano e o ruído não aparece (única diferença conhecida prévia × export).
- Processamentos: painel maior; clicar no item abre o projeto, os cortes (transcrição) ou a Biblioteca.
- Ritmo de referência (aba Efeitos): mede cortes do vídeo de referência com a detecção de cena do FFmpeg (limiar 0,3; cortes só de zoom não contam), compara com o projeto (`projectRhythm`) e aplica `rhythm` (divide nas pausas entre palavras e alterna enquadramento normal/punch-in 1,12×). Também disponível no chat da IA.
- Transições cruzadas (dissolver, cortina, deslizar): o trecho seguinte começa antes (`overlapOf`, até metade de cada trecho) e o vídeo encurta. Exportação: `xfade` (fade/wipeleft/slideleft) + `acrossfade` linear, encadeados um trecho por vez; prévia: os dois `<video>` tocam juntos com `crossAt` (opacidade / clip-path inset / translateX) e ganhos (1-u)/u. Na sobreposição a legenda troca de um trecho para o outro no meio. Validado: prévia (tempos dos dois vídeos e cortina 25%) × exportação no mesmo instante.
- Etapa 2 concluída no escopo planejado.

## Etapa 3 (em andamento) — redes sociais
- server/src/social/meta.ts: OAuth da Meta (app do próprio usuário, modo desenvolvimento), Páginas + Instagram profissional, publicação real: Reels (upload resumível, sem URL pública), imagem (hospedada como foto não publicada da Página para obter URL), carrossel (2–10), vídeo/foto/multi-foto no Facebook. "Publicado" só com id + permalink da API. Tokens criptografados (AES-GCM, lib/vault.ts).
- server/src/social/routes.ts: contas por marca, posts (vídeo, imagem, carrossel) com texto por rede, fluxo Rascunho → Revisão → Aprovado → Agendado → Publicando → Publicado/Falhou/Aguardando manual; agendador a cada 20 s; se o app estava desligado (>15 min de atraso) não publica sozinho; job de publicação não é retomado após queda (evita duplicidade) e reaproveita o container do Instagram em nova tentativa.
- TikTok: fluxo assistido (baixar vídeo, copiar texto, abrir TikTok, colar link para registrar). Postagem direta exige app aprovado pelo TikTok.
- web/src/pages/Content.tsx (calendário mensal + lista + filtros), SocialPreview.tsx (prévia Instagram feed/Reels, Facebook, TikTok), SocialAccounts.tsx, MetaSettings.tsx.
- Validado: fluxo de status e TikTok assistido via API com dados de teste. App Meta "GDR Digital" (ID 2375388399959584, modo desenvolvimento) criado e perfis conectados pelo usuário; publicação real ainda não testada.
- Capa do Reels (posts.cover): automática, quadro do vídeo (Instagram `thumb_offset`; Facebook recebe o quadro extraído pelo FFmpeg como `thumb`) ou imagem da Biblioteca (Instagram `cover_url` hospedada como foto não publicada; Facebook `thumb`). Prévia 9:16 e recorte 3:4 da grade. Prévia do post com botão de som (antes o vídeo ficava sempre mudo).
- Instagram recusa o upload resumível (400 ProcessingFailedError) de vídeos longos deste app: testado em 2026-10-29 com o mesmo arquivo cortado — 30 s e 45 s passam sempre, 60/75/89/91 s falham sempre (54 s oscila); não é tamanho (22 MB de 92 s falha) nem formato (regravado falha), e video_url hospedado no Facebook dá erro 2207076. Após 4 recusas o destino Instagram vira "Publique no app" (baixar original + copiar texto + colar o link), o post fica "Aguardando publicação manual", e o compositor avisa antes quando o vídeo passa de 55 s. Calendário mostra todos os posts do dia (antes só 3; o 4º ficava escondido).
- Compositor aceita anexar arquivo do computador (vai para a Biblioteca da marca e é selecionado ao ficar pronto) além de vídeos exportados/arquivos da Biblioteca.
- Google Drive (server/src/drive.ts): OAuth somente leitura com cliente Google do usuário, pastas vinculadas por marca, verificação a cada 15 min (conta novos), importação manual ou automática por pasta, dedupe por id do Drive (assets.source_ref) e SHA-256. Nunca publica. Pendente: credenciais Google do usuário.
- Biblioteca mostra uso de cada arquivo (projetos/posts) e botão "Editar" cria projeto a partir do vídeo.

## Etapa 4 (em andamento) — Resultados
- server/src/social/insights.ts + results-routes.ts: totais da conta por período (IG: views, reach, accounts_engaged, interações, curtidas, comentários, compartilhamentos, salvamentos, visitas ao perfil, novos seguidores, cliques no link; FB Página: métricas page_* toleradas individualmente) com comparação ao período anterior; janelas de 30 dias (limite da API, avisado na tela); cache de 1 h; métricas indisponíveis = "—", nunca estimadas.
- Conteúdos (media_items) sincronizados pelo job 'metrics' com métricas por post; ranking ordenável; CSV.
- Tráfego pago: token de usuário Meta (60 dias, criptografado) + ads_read; conta de anúncio escolhida por marca; anúncios do período com investimento/alcance/cliques/CTR/CPC/resultados e vínculo ao post promovido (effective_instagram_media_id / object_story_id) → selo "Impulsionado" no ranking.
- Permissões adicionadas no app Meta: instagram_manage_insights, read_insights, ads_read (caso de uso API de Marketing). Usuário precisa reconectar os perfis para conceder.
- Relatório padrão GDR: espaço reservado, aguardando o modelo do usuário.
- Importação manual (Resultados → "Importar planilha", shared/metrics-import.ts): CSV com cabeçalho em PT (data obrigatória; números "12,5 mil"/"3,4K"; vazio = "—"), por rede/perfil; cria conta "manual" (oculta da publicação) e grava `media_items.source = 'manual'` com lote (`metric_imports`: arquivo, linhas, data). Ranking mostra selo "Importado manualmente"; lote pode ser removido.
- PWA: manifest + service worker mínimo + ícones GDR (instalável no celular).
- Inteligência (server/src/social/intelligence.ts, abas em Resultados — web/src/pages/Intelligence.tsx):
  - Análise do perfil: estatísticas calculadas (medianas por formato/dia/horário, frequência, aviso com < 10 posts) + IA com evidência/mudança/resultado a testar/métrica, cada ponto classificado verificado/observação/hipótese.
  - Pergunte aos dados: responde só com os posts e totais do período, cita os posts usados e declara limitações (ex.: Meta não dá seguidores por post).
  - Concorrentes e referências: IG business_discovery (perfis profissionais públicos, últimos 25 posts; engajamento = (curtidas+comentários)/seguidores; views de terceiros não existem na API).
  - Tendências na web: Gemini com Busca do Google (`geminiResearch`) — no plano gratuito retorna 429; a tela diz isso e não mostra nada sem fonte.
  - Pautas (tabela `ideas`): de recomendações/perguntas ou manuais → roteiro com IA (editável) → projeto de edição 9:16.
  - Validado com dados reais (rodrigo.napoleao 19 posts / 90 dias; benchmark gdr.resultados × sebrae).

## Proteção de uso da Meta (server/src/social/meta-guard.ts)
- Toda chamada à Graph API passa por `metaFetch`: lê `x-app-usage`/`x-business-use-case-usage` (≥75% pausa 10 min, ≥90% pausa 30 min), códigos de limite (4/17/32/613/800xx) pausam, e "API access blocked"/"Cannot call API for app" = bloqueio do app pela Meta (conta de desenvolvedor precisa de "Confirmar conta" em developers.facebook.com) — nunca marca perfis para reconectar; testa de novo a cada 15 min; aviso no topo da interface.
- Ocorrido em 2026-10-23: Meta pediu confirmação da conta de desenvolvedor por "atividade incomum". Volume reduzido: caixa de entrada a cada 3 min (era 1), comentários só dos posts cujo total mudou, 3 perfis enriquecidos por rodada.

## Estabilidade
- Enquanto o servidor roda no Windows, ele impede a suspensão do PC (server/src/lib/keepawake.ts, SetThreadExecutionState; não altera configurações; desligar com ORBIT_ALLOW_SLEEP=1). Porta ocupada encerra o processo para o inicializador tentar de novo.
- Link público para apresentar: `Apresentar - link publico.cmd` sobe o servidor (se preciso) e um Cloudflare Quick Tunnel (tools/cloudflared.exe, fora do Git) → https://…trycloudflare.com, salvo em data/logs/link-publico.txt e copiado. O endereço muda a cada abertura; login continua exigindo a senha. PC precisa estar ligado.
- `Iniciar GDR Digital.cmd` reinicia o servidor sozinho se ele parar (registro em data/logs/reinicios.log). Erros soltos não derrubam mais o processo: vão para data/logs/erros.log (server/src/lib/crashlog.ts).
- Automações: perfis com automação ativa (ou caixa no modo automático) são verificados a cada 20 s (60 s se o uso da Meta passar de 40%); os demais a cada 3 min. Resposta instantânea de verdade só com webhook (servidor na nuvem).

## Etapa 5 (em andamento) — Caixa de entrada e automações
- server/src/social/inbox.ts: coleta por polling a cada 60 s (sem webhook, pois roda local): conversas (IG/Messenger via /{page}/conversations) e comentários das últimas 15 publicações; contatos e mensagens com anti-duplicidade pelo id externo; registra recebido, sugerido (IA), enviado e falha.
- Regras da Meta aplicadas no envio: DM só até 24 h após a última mensagem da pessoa; resposta privada a comentário só até 7 dias (shared/automation.ts, com testes).
- Automações comentário→DM (shared/automation.ts + inbox-routes.ts): palavras-chave (ignora acento/maiúscula/emoji), publicações escolhidas ou todas, resposta pública alternada, DM com {nome} e link, pergunta de continuidade com respostas por palavra; uma DM por pessoa por automação; histórico (automation_runs) e teste simulado que não envia nada.
- IA nas respostas: só usa perfil e base de conhecimento da marca; needsHuman manda a conversa para "Precisa de você". Modo por perfil: manual (só sugere) ou automático (envia o que souber). Pausa de automação por contato.
- Permissões adicionadas no app Meta: instagram_manage_messages, instagram_manage_comments, pages_read_user_content, pages_manage_engagement e pages_messaging (caso de uso Messenger). Usuário precisa reconectar e ativar "Permitir acesso a mensagens" no Instagram.
- Fluxo com botão (estilo ManyChat): 1ª mensagem (resposta privada) com botão postback ("Quero o link") → clique → [opcional: só para quem segue, via `is_user_follow_business` da API de perfil do Instagram; se não segue, manda "tem que estar seguindo" com botão "Estou seguindo" e verifica de novo, até 5 vezes; sem confirmação nunca entrega] → entrega com o link como botão web_url. Estado em `automation_flows`, ligado pelo `recipient_id` que a Meta devolve na resposta privada. Sem webhook (roda local), o clique é reconhecido pela mensagem com o título do botão que aparece na conversa. Se a Meta recusar botão na resposta privada, envia em texto pedindo para responder com o título (mesmo fluxo). Prévia "como no Direct" no editor.
- Pendente: validação com contas reais após reconexão (inclusive se o toque no botão aparece na API de conversas sem webhook); webhooks quando estiver na nuvem.

## Dependências e limitações conhecidas

- **IA para texto do post**: precisa de (a) login no Claude Code deste computador (`claude` no terminal, uma vez) **ou** (b) chave da API Anthropic em Configurações → IA. Sem isso a geração mostra o erro e como resolver. *Validado em 2026-10-22 com o Claude Code logado (opus): texto gerado só com base na fala real, com alertas do que não inventou.*
- **Desempenho**: neste notebook (i5-5200U, 2 núcleos) o render de fonte 4K60 roda ~0,25× o tempo real na CPU; Intel QuickSync ~2× mais rápido. A transcrição "Precisa" leva ~1× a duração do vídeo; a "Rápida" (whisper-base) ~3× mais rápida com mais erros. Primeira transcrição baixa ~250 MB do Hugging Face.
- Prévia depende de navegador com WebAssembly + OffscreenCanvas (Chrome/Edge/Firefox atuais). Se a prévia de legendas falhar, a exportação não é afetada (aviso na tela).
- Fontes de legenda: fontes instaladas no Windows ou enviadas na Biblioteca da marca (TTF/OTF).
- Faixa principal é sequencial (transições sem sobreposição entre trechos); vídeos sobrepostos ficam nas faixas livres. A timeline termina com a faixa principal (faixas livres além disso são cortadas).
- Senha local única; sem multiusuário.

## Próximas etapas e critérios de conclusão

**Etapa 2 — Editor avançado.** Múltiplas faixas livres de vídeo/áudio/texto; keyframes (posição, escala, opacidade, rotação); transições com parâmetros; títulos, lower thirds, contadores e motion graphics como templates editáveis; música com ducking automático sob a voz, fades, redução de ruído; biblioteca de trilhas com origem/licença; edição por linguagem natural (plano de edição proposto pela IA aplicado como itens editáveis e desfazíveis na timeline — ex.: remover pausas via `rippleDelete` com silêncios da transcrição, sem cortar falas no meio).
*Critérios:* exportar um vídeo com ≥3 faixas, 1 transição, 1 título animado, música com ducking; comando "retire as pausas" gera alterações revisáveis e desfazíveis uma a uma; prévia × export conferidos por quadro.

**Etapa 3 — Operação social.** Calendário/lista com filtros e fluxo Rascunho → Em produção → Em revisão → Aprovado → Agendado → Publicado/Falhou; fuso horário; prevenção de duplicidade; Google Drive por marca (importa, detecta novos, não publica sozinho); primeira rede via API oficial (Instagram Graph API — conta profissional, `instagram_content_publish`), com fluxo assistido onde não houver publicação direta.
*Critérios:* publicar um Reels real agendado, status "Publicado" só após confirmação da API com link; falha registrada e reprocessável.

**Etapa 4 — Dados e inteligência.** Coleta de métricas com origem/período/última atualização; importação manual identificada; análise de perfil; pesquisa de tendências com fontes e datas (verificado × observação × hipótese); assistente de dados por conversa; recomendações → pautas/roteiros/projetos.

**Etapa 5 — Atendimento e automações.** Caixa de entrada (onde as APIs permitirem), respostas sugeridas com base de conhecimento, modo manual/automático, pausa por conversa, registro do enviado × sugerido; fluxos comentário→DM com palavra-chave, prévia/teste, histórico e anti-duplicidade, respeitando janelas de 24 h da Meta.
