# Override with --build-arg BASE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim
# if you hit Docker Hub rate limits.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

# ── System tools: poppler (pdfimages/pdftoppm/pdfinfo), ImageMagick (montage),
#    img2pdf, Python for the OpenCV stages ─────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils imagemagick img2pdf \
      python3 python3-pip python3-venv \
      libgl1 libglib2.0-0 \
      curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Debian's ImageMagick policy chokes on 35 MP scan pages — raise the limits.
RUN sed -i \
      -e 's/name="memory" value="[^"]*"/name="memory" value="4GiB"/' \
      -e 's/name="map" value="[^"]*"/name="map" value="8GiB"/' \
      -e 's/name="width" value="[^"]*"/name="width" value="64KP"/' \
      -e 's/name="height" value="[^"]*"/name="height" value="64KP"/' \
      -e 's/name="area" value="[^"]*"/name="area" value="1GP"/' \
      -e 's/name="disk" value="[^"]*"/name="disk" value="8GiB"/' \
      /etc/ImageMagick-6/policy.xml

# ── Python: CPU torch first (so iopaint doesn't pull the CUDA build), then
#    OpenCV + iopaint (LaMa inpainting) ────────────────────────────────────────
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && /opt/venv/bin/pip install --no-cache-dir numpy pillow iopaint
# iopaint depends on full opencv-python (needs libGL); replace it with the
# headless build so exactly one cv2 is installed and imports work everywhere.
RUN /opt/venv/bin/pip uninstall -y opencv-python opencv-python-headless; \
    /opt/venv/bin/pip install --no-cache-dir opencv-python-headless \
 && /opt/venv/bin/python -c "import cv2, torch, PIL; print('cv2', cv2.__version__)"
ENV PATH="/opt/venv/bin:${PATH}"

# ── Pre-bake the LaMa weights so the container runs offline (≈196 MB).
#    iopaint --model-dir=/opt/models resolves to <model-dir>/torch/hub/checkpoints/. ──
RUN mkdir -p /opt/models/torch/hub/checkpoints \
 && curl -fL -o /opt/models/torch/hub/checkpoints/big-lama.pt \
      https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt

# ── App ────────────────────────────────────────────────────────────────────────
# qpdf (used by `pdfcut slice`) is installed here, after the heavy torch/LaMa
# layers, so adding it didn't invalidate their build cache.
RUN apt-get update && apt-get install -y --no-install-recommends qpdf \
    && rm -rf /var/lib/apt/lists/*

# ── Print rendering (`pdfcut render`): WeasyPrint + the TeX Gyre faces ────────
# Termes/Heros/Cursor are metric clones of Times/Helvetica/Courier — the faces
# 1980s German computer books were phototypeset in. Pango/GDK-Pixbuf are
# WeasyPrint's text/image backends; pyphen (a dependency) does the German
# hyphenation.
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-texgyre fontconfig \
      libpango-1.0-0 libpangocairo-1.0-0 libpangoft2-1.0-0 libgdk-pixbuf-2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
 && /opt/venv/bin/pip install --no-cache-dir weasyprint \
 && /opt/venv/bin/weasyprint --version
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY pdfcut.config.json ./

# /data is the mounted project dir (input/, work/, output/, pdfcut.config.json)
# HOME=/tmp: under podman --userns=keep-id the container user is the host uid,
# which has no home dir here — torch/iopaint need a writable cache location.
ENV HOME=/tmp
WORKDIR /data
ENTRYPOINT ["node", "/app/src/cli.js"]
CMD ["--help"]
