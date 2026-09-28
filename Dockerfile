FROM node:22-bookworm-slim

# Chromium + the shared libs Puppeteer needs. Installed via the puppeteer
# bundled browser, so `CHROME_PATH` below points at it (the app's default
# CHROME_PATH is a Windows path).
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer

# unzip/xz-utils are NOT optional: @puppeteer/browsers extracts the Chrome
# download with whichever archiver it finds and errors out with
# "no zip archiver is available" when none is present.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl dumb-init unzip xz-utils \
      fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
      libcups2 libdbus-1-3 libgbm1 libgtk-3-0 libnspr4 libnss3 \
      libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 \
      libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# deps first so layer caching survives source edits
COPY package.json package-lock.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev \
    && npx --yes puppeteer browsers install chrome

COPY . .

# Writable state dirs (artifacts + conversation store)
RUN mkdir -p /app/generated /app/data \
    && chmod +x /app/docker-entrypoint.sh \
    && chown -R node:node /app

ENV PORT=8787 \
    QWEN_HOST=0.0.0.0 \
    QWEN_WORKERS=2 \
    QWEN_ARTIFACT_DIR=/app/generated \
    MEMORY_FILE=/app/data/memory.json

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

ENTRYPOINT ["dumb-init", "--", "/app/docker-entrypoint.sh"]
