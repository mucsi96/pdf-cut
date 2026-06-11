FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      img2pdf \
      imagemagick \
      fonts-dejavu-core \
      python3 \
      python3-venv \
      libgl1 \
      libglib2.0-0 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Generous ImageMagick limits for high-DPI book scans.
ENV MAGICK_DISK_LIMIT=8GiB \
    MAGICK_MEMORY_LIMIT=2GiB \
    MAGICK_MAP_LIMIT=4GiB

# Python toolchain for residue detection and LaMa punch-hole inpainting, in an
# isolated venv (prepended to PATH so python3 resolves here). CPU-only torch
# keeps the image as small as this stack allows.
ENV PATH="/opt/venv/bin:$PATH"
RUN python3 -m venv /opt/venv \
    && pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir numpy opencv-python-headless pillow \
    && pip install --no-cache-dir --no-deps simple-lama-inpainting

# Bake the LaMa weights into the image so runs need no network. simple-lama
# loads from $LAMA_MODEL when set, skipping the download entirely.
ENV LAMA_MODEL=/opt/lama/big-lama.pt
RUN mkdir -p /opt/lama \
    && python3 -c "import urllib.request; urllib.request.urlretrieve('https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt', '/opt/lama/big-lama.pt')"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY python/ ./python/

ENTRYPOINT ["node", "/app/src/index.js"]
