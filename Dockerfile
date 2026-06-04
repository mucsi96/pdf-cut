# pdf-cut — split & deskew scanned book PDFs
#
# The image bundles the Node CLI together with the proven binary toolchain it
# orchestrates:
#   - poppler-utils  → pdftoppm (PDF → high-res PNG rasterization)
#   - imagemagick    → convert/identify (split, deskew, trim, border)
#   - img2pdf        → lossless PNG → PDF assembly
FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        poppler-utils \
        imagemagick \
        img2pdf \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Allow ImageMagick to read/write the formats we use. The default Debian
# policy is fine for PNG work (we never let IM touch PDFs directly), but make
# the disk/memory limits generous for high-DPI book scans.
ENV MAGICK_DISK_LIMIT=8GiB \
    MAGICK_MEMORY_LIMIT=2GiB \
    MAGICK_MAP_LIMIT=4GiB

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

RUN chmod +x src/cli.js \
    && ln -s /app/src/cli.js /usr/local/bin/pdf-cut

# Users mount the directory containing their PDF here.
WORKDIR /data

ENTRYPOINT ["pdf-cut"]
CMD ["--help"]
