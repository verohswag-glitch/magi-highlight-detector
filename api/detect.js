import sharp from 'sharp';

const CONFIG = {
  RB_THRESHOLD: 40,
  G_MIN: 150,
  R_MIN: 180,
  MIN_AREA_PX: 500,
  DILATE_KERNEL_W: 3,
  DILATE_KERNEL_H: 3,
  CROP_MARGIN_X: 20,
  CROP_MARGIN_Y: 10,
  Y_GAP_THRESHOLD: 15,
  X_GAP_THRESHOLD: 60,
  MIN_COLUMN_WIDTH_RATIO: 0.15,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const { image_base64 } = req.body;
    if (!image_base64) {
      return res.status(400).json({ error: 'image_base64 is required' });
    }

    const imageBuffer = Buffer.from(image_base64, 'base64');

    const { data, info } = await sharp(imageBuffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;

    // ===== 色検出マスク（v1.1: G, R 条件追加） =====
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const r = data[i * channels];
      const g = data[i * channels + 1];
      const b = data[i * channels + 2];
      mask[i] = (r - b > CONFIG.RB_THRESHOLD && g > CONFIG.G_MIN && r > CONFIG.R_MIN) ? 1 : 0;
    }

    const dilated = dilate(mask, width, height, CONFIG.DILATE_KERNEL_W, CONFIG.DILATE_KERNEL_H);

    // ===== Y軸プロファイル → 行リージョン検出 =====
    const yProfile = new Uint32Array(height);
    for (let y = 0; y < height; y++) {
      let count = 0;
      for (let x = 0; x < width; x++) {
        if (dilated[y * width + x]) count++;
      }
      yProfile[y] = count;
    }

    const yRegions = [];
    let inRegion = false;
    let regionStart = 0;

    for (let y = 0; y < height; y++) {
      if (yProfile[y] > 0) {
        if (!inRegion) {
          inRegion = true;
          regionStart = y;
        }
      } else {
        if (inRegion) {
          let gapEnd = y;
          while (gapEnd < height && gapEnd - y < CONFIG.Y_GAP_THRESHOLD && yProfile[gapEnd] === 0) {
            gapEnd++;
          }
          if (gapEnd < height && yProfile[gapEnd] > 0 && gapEnd - y < CONFIG.Y_GAP_THRESHOLD) {
            continue;
          }
          yRegions.push({ yStart: regionStart, yEnd: y - 1 });
          inRegion = false;
        }
      }
    }
    if (inRegion) {
      yRegions.push({ yStart: regionStart, yEnd: height - 1 });
    }

    // ===== 各Y領域のbbox計算 + X軸分割（v1.1新機能） =====
    const validRegions = [];
    for (const region of yRegions) {
      let xMin = width, xMax = 0;
      let area = 0;

      for (let y = region.yStart; y <= region.yEnd; y++) {
        for (let x = 0; x < width; x++) {
          if (dilated[y * width + x]) {
            if (x < xMin) xMin = x;
            if (x > xMax) xMax = x;
            area++;
          }
        }
      }

      if (area < CONFIG.MIN_AREA_PX) continue;

      // X軸分割チェック: 領域幅が画像幅の60%以上なら分割を試みる
      const regionWidth = xMax - xMin;
      if (regionWidth > width * 0.6) {
        const subRegions = splitByXGap(dilated, width, region.yStart, region.yEnd, xMin, xMax);
        if (subRegions.length > 1) {
          for (const sub of subRegions) {
            if (sub.area >= CONFIG.MIN_AREA_PX) {
              validRegions.push(sub);
            }
          }
          continue;
        }
      }

      validRegions.push({ yStart: region.yStart, yEnd: region.yEnd, xMin, xMax, area });
    }

    if (validRegions.length === 0) {
      return res.status(200).json({
        highlight_count: 0,
        crops: [],
        image_width: width,
        image_height: height,
        message: 'NO_HIGHLIGHTS'
      });
    }

    const crops = [];
    for (let i = 0; i < validRegions.length; i++) {
      const r = validRegions[i];
      const cropX = Math.max(0, r.xMin - CONFIG.CROP_MARGIN_X);
      const cropY = Math.max(0, r.yStart - CONFIG.CROP_MARGIN_Y);
      const cropW = Math.min(width - cropX, (r.xMax - r.xMin) + CONFIG.CROP_MARGIN_X * 2);
      const cropH = Math.min(height - cropY, (r.yEnd - r.yStart) + CONFIG.CROP_MARGIN_Y * 2);

      const croppedBuffer = await sharp(imageBuffer)
        .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
        .png()
        .toBuffer();

      crops.push({
        index: i,
        base64: croppedBuffer.toString('base64'),
        bbox: { x: cropX, y: cropY, w: cropW, h: cropH },
        area: r.area
      });
    }

    return res.status(200).json({
      highlight_count: validRegions.length,
      crops,
      image_width: width,
      image_height: height
    });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ===== X軸ギャップ分割（v1.1新機能） =====
function splitByXGap(dilated, imgWidth, yStart, yEnd, xMin, xMax) {
  // X軸プロファイル: 各X座標のピクセル数
  const xProfile = new Uint32Array(imgWidth);
  for (let x = xMin; x <= xMax; x++) {
    let count = 0;
    for (let y = yStart; y <= yEnd; y++) {
      if (dilated[y * imgWidth + x]) count++;
    }
    xProfile[x] = count;
  }

  // 最大ギャップを探す
  let bestGapStart = -1;
  let bestGapLen = 0;
  let gapStart = -1;

  for (let x = xMin; x <= xMax; x++) {
    if (xProfile[x] === 0) {
      if (gapStart === -1) gapStart = x;
    } else {
      if (gapStart !== -1) {
        const gapLen = x - gapStart;
        if (gapLen > bestGapLen) {
          bestGapLen = gapLen;
          bestGapStart = gapStart;
        }
        gapStart = -1;
      }
    }
  }
  if (gapStart !== -1) {
    const gapLen = (xMax + 1) - gapStart;
    if (gapLen > bestGapLen) {
      bestGapLen = gapLen;
      bestGapStart = gapStart;
    }
  }

  // ギャップが十分大きい場合のみ分割
  if (bestGapLen < CONFIG.X_GAP_THRESHOLD) {
    return []; // 分割しない
  }

  // 左右それぞれの領域を構築
  const leftXMax = bestGapStart - 1;
  const rightXMin = bestGapStart + bestGapLen;

  const minColWidth = imgWidth * CONFIG.MIN_COLUMN_WIDTH_RATIO;
  if (leftXMax - xMin < minColWidth || xMax - rightXMin < minColWidth) {
    return []; // 片方が小さすぎる場合は分割しない
  }

  const regions = [];

  // 左領域
  let leftArea = 0;
  for (let y = yStart; y <= yEnd; y++) {
    for (let x = xMin; x <= leftXMax; x++) {
      if (dilated[y * imgWidth + x]) leftArea++;
    }
  }
  regions.push({ yStart, yEnd, xMin, xMax: leftXMax, area: leftArea });

  // 右領域
  let rightArea = 0;
  for (let y = yStart; y <= yEnd; y++) {
    for (let x = rightXMin; x <= xMax; x++) {
      if (dilated[y * imgWidth + x]) rightArea++;
    }
  }
  regions.push({ yStart, yEnd, xMin: rightXMin, xMax, area: rightArea });

  return regions;
}

function dilate(mask, width, height, kw, kh) {
  const halfW = Math.floor(kw / 2);
  const halfH = Math.floor(kh / 2);
  const result = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let found = false;
      for (let ky = -halfH; ky <= halfH && !found; ky++) {
        for (let kx = -halfW; kx <= halfW && !found; kx++) {
          const ny = y + ky;
          const nx = x + kx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            if (mask[ny * width + nx]) found = true;
          }
        }
      }
      result[y * width + x] = found ? 1 : 0;
    }
  }
  return result;
}
