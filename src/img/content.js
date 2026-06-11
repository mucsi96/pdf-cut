// Content-box detection that ignores scanner residue: dark regions connected
// to the image border (edge bands, smudges, dark scan surroundings) are
// flood-filled away before the bounding box of the remaining ink is computed.

export function analyzeContent(
  raw,
  {
    darkThreshold,
    minInkPx,
    removeEdgeConnected = true,
    borderBandXPx = 1,
    borderBandYPx = 1,
    // Detached vertical residue bars (binding shadows, neighbor-page
    // slivers): thinner than barMaxWPx, taller than barMinHPx and centered
    // in the outer barOuterFrac of the page width. 0 disables.
    barMaxWPx = 0,
    barMinHPx = 0,
    barOuterFrac = 0.2
  }
) {
  const { data, width, height } = raw;
  const n = width * height;
  const dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) dark[i] = data[i] < darkThreshold ? 1 : 0;

  // Flood-fill dark regions seeded from a band along the page edges
  // (8-connectivity). The band catches residue separated from the border by
  // a white gap (binding shadows, neighbor-page slivers). Disabled for
  // full-bleed pages (covers) where the content itself touches the border.
  const edge = new Uint8Array(n);
  if (removeEdgeConnected) {
    const bandX = Math.max(1, Math.round(borderBandXPx));
    const bandY = Math.max(1, Math.round(borderBandYPx));
    const stack = [];
    const push = (i) => {
      if (dark[i] && !edge[i]) {
        edge[i] = 1;
        stack.push(i);
      }
    };
    for (let y = 0; y < height; y++) {
      const inYBand = y < bandY || y >= height - bandY;
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (inYBand || x < bandX || x >= width - bandX) push(row + x);
      }
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
  }

  // Classify detached vertical bars as residue via connected components.
  const residueBoxes = [];
  if (removeEdgeConnected && barMaxWPx > 0 && barMinHPx > 0) {
    const visited = new Uint8Array(n);
    for (let start = 0; start < n; start++) {
      if (!dark[start] || edge[start] || visited[start]) continue;
      const component = [start];
      visited[start] = 1;
      let minX = start % width;
      let maxX = minX;
      let minY = (start / width) | 0;
      let maxY = minY;
      for (let head = 0; head < component.length; head++) {
        const i = component[head];
        const x = i % width;
        const y = (i / width) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (const m of [
          x > 0 ? i - 1 : -1,
          x < width - 1 ? i + 1 : -1,
          y > 0 ? i - width : -1,
          y < height - 1 ? i + width : -1
        ]) {
          if (m >= 0 && dark[m] && !edge[m] && !visited[m]) {
            visited[m] = 1;
            component.push(m);
          }
        }
      }
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const cx = (minX + maxX) / 2;
      const outer = cx < barOuterFrac * width || cx > (1 - barOuterFrac) * width;
      // Stroke width = mass / height: tilt-invariant, so skewed bars whose
      // bounding box is smeared horizontally still classify as thin.
      const strokeW = component.length / h;
      if (strokeW <= barMaxWPx && h >= barMinHPx && outer) {
        for (const i of component) edge[i] = 1;
        residueBoxes.push({ x: minX, y: minY, w, h });
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
  if (top === -1) return { bbox: null, residueBoxes };
  const bottom = lastAbove(rowInk, minInkPx);
  const left = firstAbove(colInk, minInkPx);
  const right = lastAbove(colInk, minInkPx);
  return { bbox: { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }, residueBoxes };
}
