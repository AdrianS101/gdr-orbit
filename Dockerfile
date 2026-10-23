# GDR Orbit — imagem para servidor (Linux x64 ou ARM).
FROM node:24-bookworm-slim
# FFmpeg (render, proxy, áudio) + fontes das legendas. As fontes da Microsoft (Arial Black, Impact…)
# mantêm as legendas iguais às feitas no Windows; Liberation/DejaVu/Noto cobrem o restante.
RUN sed -i 's/Components: main/Components: main contrib/' /etc/apt/sources.list.d/debian.sources \
 && echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ttf-mscorefonts-installer fonts-liberation fonts-dejavu fonts-noto-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build
ENV ORBIT_HOST=0.0.0.0 ORBIT_PORT=4310 ORBIT_DATA_DIR=/data ORBIT_MODELS_DIR=/data/models NODE_ENV=production
VOLUME ["/data"]
EXPOSE 4310
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.ts"]
