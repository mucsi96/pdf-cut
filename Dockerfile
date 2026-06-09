# pdf-cut — split, deskew & repair scanned book PDFs
#
# The image bundles the Node CLI together with the binary/ML toolchain it
# orchestrates:
#   - poppler-utils  → pdftoppm (PDF → high-res PNG rasterization)
#   - imagemagick    → convert (split, edge-clean, trim, border)
#   - img2pdf        → lossless PNG → PDF assembly
#   - python + OpenCV→ robust text-based deskew + punch-hole detection
#   - torch + LaMa   → AI inpainting that fills the detected punch holes
FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        poppler-utils \
        imagemagick \
        img2pdf \
        python3 \
        python3-venv \
        libgl1 \
        libglib2.0-0 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Generous ImageMagick limits for high-DPI book scans (we never let IM touch
# PDFs directly, so the default Debian policy is fine for our PNG work).
ENV MAGICK_DISK_LIMIT=8GiB \
    MAGICK_MEMORY_LIMIT=2GiB \
    MAGICK_MAP_LIMIT=4GiB

# Python AI stage in an isolated venv (prepended to PATH so `python3` resolves
# here). CPU-only torch keeps the image as small as this stack allows.
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

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY python ./python

RUN chmod +x src/cli.js \
    && ln -s /app/src/cli.js /usr/local/bin/pdf-cut

# Users mount the directory containing their PDF here.
WORKDIR /data

ENTRYPOINT ["pdf-cut"]
CMD ["--help"]
