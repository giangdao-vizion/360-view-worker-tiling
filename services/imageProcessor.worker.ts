
/* 
  Web Worker for Equirectangular to Cubemap Conversion
  Handles multi-level tiling:
  Level 1: 512px faces (1x1)
  Level 2: 1024px faces (2x2 tiles of 512px)
  Level 3: 2048px faces (4x4 tiles of 512px)
*/

const FACES: Record<string, { x: [number, number, number], y: [number, number, number] }> = {
  px: { x: [0, 0, -1], y: [0, -1, 0] }, // Right
  nx: { x: [0, 0, 1], y: [0, -1, 0] },  // Left
  py: { x: [1, 0, 0], y: [0, 0, 1] },   // Top
  ny: { x: [1, 0, 0], y: [0, 0, -1] },  // Bottom
  pz: { x: [1, 0, 0], y: [0, -1, 0] },  // Front
  nz: { x: [-1, 0, 0], y: [0, -1, 0] }, // Back
};

const FACE_ORIGINS: Record<string, [number, number, number]> = {
  px: [1, 1, 1],
  nx: [-1, 1, -1],
  py: [-1, 1, -1],
  ny: [-1, -1, 1],
  pz: [-1, 1, 1],
  nz: [1, 1, -1],
};

self.onmessage = async (e: MessageEvent) => {
  const { imageBitmap, tileRes = 512 } = e.data;
  
  const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(imageBitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const { width, height } = imageData;

  const levels = [
    { id: 1, faceRes: 512, tilesPerSide: 1 },
    { id: 2, faceRes: 1024, tilesPerSide: 2 },
    { id: 3, faceRes: 2048, tilesPerSide: 4 },
  ];

  const results: Record<string, any[]> = { level1: [], level2: [], level3: [] };
  const totalTiles = 6 * (1*1 + 2*2 + 4*4); // 6 + 24 + 96 = 126
  let completedTiles = 0;

  const getPixel = (u: number, v: number) => {
    const x = Math.floor(u * width);
    const y = Math.floor(v * height);
    const idx = (y * width + x) * 4;
    return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
  };

  const processLevel = async (level: typeof levels[0]) => {
    const key = `level${level.id}`;
    const faceRes = level.faceRes;
    const tilesPerSide = level.tilesPerSide;

    for (const faceName of Object.keys(FACES)) {
      const origin = FACE_ORIGINS[faceName];
      const ux = FACES[faceName].x;
      const uy = FACES[faceName].y;

      for (let row = 0; row < tilesPerSide; row++) {
        for (let col = 0; col < tilesPerSide; col++) {
          const tileCanvas = new OffscreenCanvas(tileRes, tileRes);
          const tCtx = tileCanvas.getContext('2d');
          if (!tCtx) continue;
          const tData = tCtx.createImageData(tileRes, tileRes);
          const tPixels = tData.data;

          // Process each pixel in the tile
          for (let ty = 0; ty < tileRes; ty++) {
            for (let tx = 0; tx < tileRes; tx++) {
              // Map tile coordinates (tx, ty) to face coordinates (fx, fy)
              const fx = (col * tileRes + tx) / faceRes;
              const fy = (row * tileRes + ty) / faceRes;

              // Map face coordinates to 3D cube coordinates (px, py, pz)
              const p = [
                origin[0] + fx * ux[0] * 2 + fy * uy[0] * 2,
                origin[1] + fx * ux[1] * 2 + fy * uy[1] * 2,
                origin[2] + fx * ux[2] * 2 + fy * uy[2] * 2,
              ];

              // Project 3D to sphere (longitude, latitude)
              const r = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
              const lon = Math.atan2(p[2], p[0]);
              const lat = Math.acos(p[1] / r);

              // Map sphere to equirectangular UV
              const u = (lon + Math.PI) / (2 * Math.PI);
              const v = lat / Math.PI;

              const pix = getPixel(u, v);
              const tIdx = (ty * tileRes + tx) * 4;
              tPixels[tIdx] = pix[0];
              tPixels[tIdx + 1] = pix[1];
              tPixels[tIdx + 2] = pix[2];
              tPixels[tIdx + 3] = pix[3];
            }
          }

          tCtx.putImageData(tData, 0, 0);
          const blob = await tileCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
          const reader = new FileReader();
          const dataUrl = await new Promise<string>((res) => {
            reader.onloadend = () => res(reader.result as string);
            reader.readAsDataURL(blob);
          });

          results[key].push({
            level: level.id,
            face: faceName,
            row,
            col,
            dataUrl
          });

          completedTiles++;
          self.postMessage({
            type: 'PROGRESS',
            progress: {
              status: 'PROCESSING',
              percentage: Math.round((completedTiles / totalTiles) * 100),
              currentStep: `Generating Level ${level.id}: Face ${faceName} [${row},${col}]`,
              totalTiles,
              completedTiles
            }
          });
        }
      }
    }
  };

  for (const level of levels) {
    await processLevel(level);
  }

  self.postMessage({ type: 'COMPLETE', data: results });
};
