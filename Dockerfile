FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      img2pdf \
      imagemagick \
      fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/

ENTRYPOINT ["node", "/app/src/index.js"]
