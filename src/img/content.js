// Content-box detection that ignores scanner residue: dark regions connected
// to the image border (edge bands, smudges, dark scan surroundings) are
// flood-filled away before the bounding box of the remaining ink is computed.

export function analyzeContent(raw, { darkThreshold, minInkPx }) {
  const { data, width, height } = raw;
  const n = width * height;
  const dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) dark[i] = data[i] < darkThreshold ? 1 : 0;

  // Flood-fill border-connected dark pixels (8-connectivity).
  const edge = new Uint8Array(n);
  const stack = [];
  const push = (i) => {
    if (dark[i] && !edge[i]) {
      edge[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    const y = (i / width) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        push(ny * width + nx);
      }
    }
  }

  // Row/column ink counts of non-residue pixels.
  const rowInk = new Uint32Array(height);
  const colInk = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (dark[i] && !edge[i]) {
        rowInk[y]++;
        colInk[x]++;
      }
    }
  }

  const firstAbove = (arr, min) => {
    for (let i = 0; i < arr.length; i++) if (arr[i] >= min) return i;
    return -1;
  };
  const lastAbove = (arr, min) => {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= min) return i;
    return -1;
  };

  const top = firstAbove(rowInk, minInkPx);
  if (top === -1) return { bbox: null };
  const bottom = lastAbove(rowInk, minInkPx);
  const left = firstAbove(colInk, minInkPx);
  const right = lastAbove(colInk, minInkPx);
  return { bbox: { x: left, y: top, w: right - left + 1, h: bottom - top + 1 } };
}
