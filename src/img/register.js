import sharp from 'sharp';

// Place a page's content box into the fixed output window: horizontally
// centered, top edge at the window's top margin. Everything outside the
// (padded) content box is left white — this both registers pages to
// identical geometry and erases anything outside the content.
export async function registerToWindow({ src, bbox, window, pad, outPath }) {
  const canvas = sharp({
    create: { width: window.w, height: window.h, channels: 3, background: '#ffffff' }
  });
  if (!bbox) {
    await canvas.grayscale().png().toFile(outPath);
    return;
  }

  const meta = await sharp(src).metadata();
  const crop = {
    left: Math.max(0, bbox.x - pad),
    top: Math.max(0, bbox.y - pad),
    right: Math.min(meta.width, bbox.x + bbox.w + pad),
    bottom: Math.min(meta.height, bbox.y + bbox.h + pad)
  };
  // Destination of the crop's top-left, derived from the registration of the
  // bbox itself (centered horizontally, top at margin).
  let dstX = Math.round((window.w - bbox.w) / 2) - (bbox.x - crop.left);
  let dstY = window.topPx - (bbox.y - crop.top);
  if (dstX < 0) {
    crop.left -= dstX;
    dstX = 0;
  }
  if (dstY < 0) {
    crop.top -= dstY;
    dstY = 0;
  }
  crop.right = Math.min(crop.right, crop.left + (window.w - dstX));
  crop.bottom = Math.min(crop.bottom, crop.top + (window.h - dstY));

  if (crop.right > crop.left && crop.bottom > crop.top) {
    const content = await sharp(src)
      .extract({
        left: crop.left,
        top: crop.top,
        width: crop.right - crop.left,
        height: crop.bottom - crop.top
      })
      .toBuffer();
    await canvas
      .composite([{ input: content, left: dstX, top: dstY }])
      .grayscale()
      .png()
      .toFile(outPath);
  } else {
    await canvas.grayscale().png().toFile(outPath);
  }
}
