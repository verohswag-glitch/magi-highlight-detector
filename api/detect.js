import sharp from 'sharp';

const CONFIG = {
  // ===== v1.2 既存（変更なし） =====
  RB_THRESHOLD: 40,
  G_MIN: 170,
  R_MIN: 200,
  BRIGHTNESS_MIN: 200,
  MIN_AREA_PX: 500,
  DILATE_KERNEL_W: 3,
  DILATE_KERNEL_H: 3,
  CROP_MARGIN_X: 20,
  CROP_MARGIN_Y: 10,
  Y_GAP_THRESHOLD: 15,
  X_GAP_THRESHOLD: 30,
  WIDE_REGION_RATIO: 0.45,
  MIN_COLUMN_WIDTH_RATIO: 0.10,

  // ===== v1.3 D-α段組検出 =====
  COLUMN_GAP_MIN_WIDTH: 20,       // 段間ギャップの最小幅（px）
  COLUMN_SCAN_LEFT: 0.30,         // 段境界を探す範囲の左端（画像幅の30%）
  COLUMN_SCAN_RIGHT: 0.70,        // 段境界を探す範囲の右端（画像幅の70%）
  COLUMN_DENSITY_THRESHOLD: 0.02, // この密度以下の列を「空白」と判定（行数に対する比率）
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

    // ===== 色検出マスク（v1.2: 輝度条件追加） =====
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const r = data[i * channels];
      const g = data[i * channels + 1];
      const b = data[i * channels + 2];
      const brightness = (r + g + b) / 3;
      mask[i] = (
        r - b > CONFIG.RB_THRESHOLD &&
        g > CONFIG.G_MIN &&
        r > CONFIG.R_MIN &&
        brightness > CONFIG.BRIGHTNESS_MIN
      ) ? 1 : 0;
    }

    const dilated = dilate(mask, width, height, CONFIG.DILATE_KERNEL_W, CONFIG.DILATE_KERNEL_H);

    // ===== v1.3: D-α 段組検出（画像全体のテキスト密度プロファイル） =====
    const columnInfo = detectColumns(data, width, height, channels);

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

    // ===== 各Y領域のbbox計算 + X軸分割（v1.2: 条件緩和） =====
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

      // X軸分割チェック: 領域幅が画像幅の45%以上なら分割を試みる
      const regionWidth = xMax - xMin;
      if (regionWidth > width * CONFIG.WIDE_REGION_RATIO) {
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
        column_detected: columnInfo.detected,
        message: 'NO_HIGHLIGHTS'
      });
    }

    // ===== v1.3: 段組検出時はクロップを段内に制約 =====
    const constrainedRegions = columnInfo.detected
      ? validRegions.map(r => constrainToColumn(r, columnInfo, width))
      : validRegions;

    const crops = [];
    for (let i = 0; i < constrainedRegions.length; i++) {
      const r = constrainedRegions[i];
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
      highlight_count: constrainedRegions.length,
      crops,
      image_width: width,
      image_height: height,
      column_detected: columnInfo.detected,
      column_boundary: columnInfo.detected ? columnInfo.boundary : null
    });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ===== v1.3: D-α 段組検出 =====
// 画像全体の「暗いピクセル」（テキスト領域）のX軸密度プロファイルを計算し、
// 画像中央付近（30%-70%）に低密度の縦溝があれば「2段組」と判定する。
function detectColumns(rawData, width, height, channels) {
  const scanLeft = Math.floor(width * CONFIG.COLUMN_SCAN_LEFT);
  const scanRight = Math.floor(width * CONFIG.COLUMN_SCAN_RIGHT);

  // X軸の「テキストらしいピクセル」密度プロファイル
  // テキスト = 暗いピクセル（brightness < 128）
  const xDensity = new Uint32Array(width);
  for (let x = scanLeft; x < scanRight; x++) {
    let count = 0;
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * channels;
      const r = rawData[idx];
      const g = rawData[idx + 1];
      const b = rawData[idx + 2];
      const brightness = (r + g + b) / 3;
      if (brightness < 128) count++;
    }
    xDensity[x] = count;
  }

  // 低密度帯（縦溝）を探す
  const densityThreshold = Math.floor(height * CONFIG.COLUMN_DENSITY_THRESHOLD);

  let bestGapStart = -1;
  let bestGapLen = 0;
  let gapStart = -1;

  for (let x = scanLeft; x < scanRight; x++) {
    if (xDensity[x] <= densityThreshold) {
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
    const gapLen = scanRight - gapStart;
    if (gapLen > bestGapLen) {
      bestGapLen = gapLen;
      bestGapStart = gapStart;
    }
  }

  if (bestGapLen < CONFIG.COLUMN_GAP_MIN_WIDTH) {
    return { detected: false };
  }

  // 段境界 = ギャップの中央
  const boundary = Math.floor(bestGapStart + bestGapLen / 2);

  return {
    detected: true,
    boundary,          // 段境界のX座標
    gapStart: bestGapStart,
    gapEnd: bestGapStart + bestGapLen,
    gapWidth: bestGapLen
  };
}

// ===== v1.3: クロップを段内に制約 =====
// マーカー領域の中心X座標が段境界の左右どちらかで、クロップ範囲を段内に収める
function constrainToColumn(region, columnInfo, imageWidth) {
  const regionCenterX = Math.floor((region.xMin + region.xMax) / 2);
  const boundary = columnInfo.boundary;

  if (regionCenterX < boundary) {
    // 左段: クロップの右端を段境界のギャップ開始位置に制限
    return {
      ...region,
      xMax: Math.min(region.xMax, columnInfo.gapStart - 1)
    };
  } else {
    // 右段: クロップの左端を段境界のギャップ終了位置に制限
    return {
      ...region,
      xMin: Math.max(region.xMin, columnInfo.gapEnd)
    };
  }
}

// ===== X軸ギャップ分割（v1.2から変更なし） =====
function splitByXGap(dilated, imgWidth, yStart, yEnd, xMin, xMax) {
  const xProfile = new Uint32Array(imgWidth);
  for (let x = xMin; x <= xMax; x++) {
    let count = 0;
    for (let y = yStart; y <= yEnd; y++) {
      if (dilated[y * imgWidth + x]) count++;
    }
    xProfile[x] = count;
  }

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

  if (bestGapLen < CONFIG.X_GAP_THRESHOLD) {
    return [];
  }

  const leftXMax = bestGapStart - 1;
  const rightXMin = bestGapStart + bestGapLen;

  const minColWidth = imgWidth * CONFIG.MIN_COLUMN_WIDTH_RATIO;
  if (leftXMax - xMin < minColWidth || xMax - rightXMin < minColWidth) {
    return [];
  }

  const regions = [];

  let leftArea = 0;
  for (let y = yStart; y <= yEnd; y++) {
    for (let x = xMin; x <= leftXMax; x++) {
      if (dilated[y * imgWidth + x]) leftArea++;
    }
  }
  regions.push({ yStart, yEnd, xMin, xMax: leftXMax, area: leftArea });

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
