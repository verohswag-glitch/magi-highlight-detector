// ============================================================
// detect.js v1.4 — 赤縦線ベース2段組制御 + 黄色マーカー検出
// Round 9 確定仕様（Claude + Gemini統合設計 + 秘書くん修正提案）
// ============================================================
const Jimp = require('jimp');

const CONFIG = {
  // --- 黄色マーカー検出（v1.2互換） ---
  YELLOW_RB_DIFF: 40,
  YELLOW_G_MIN: 170,
  YELLOW_R_MIN: 200,
  YELLOW_BRIGHTNESS_MIN: 200,
  DILATE_RADIUS: 2,
  MIN_REGION_HEIGHT: 10,
  Y_GAP_THRESHOLD: 30,

  // --- 赤縦線検出（v1.4新規） ---
  RED_RG_THRESHOLD: 100,
  RED_RB_THRESHOLD: 100,
  RED_R_MIN: 180,
  RED_MIN_ASPECT_RATIO: 3,
  RED_MIN_HEIGHT_PX: 50,
  RED_MIN_HEIGHT_RATIO: 0.10,
  RED_MAX_WIDTH: 30,

  // --- 紐付け（E-L近接性検証, Gemini提案） ---
  ASSOCIATION_X_MARGIN: 50,

  // --- 50%境界方式（Claude推奨） ---
  COLUMN_BOUNDARY: 0.50,
  COLUMN_LEFT_CROP_LIMIT: 0.55,
  COLUMN_RIGHT_CROP_LIMIT: 0.45,
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { image_base64 } = req.body;
    if (!image_base64) {
      return res.status(400).json({ error: 'image_base64 is required' });
    }

    const buffer = Buffer.from(image_base64, 'base64');
    const image = await Jimp.read(buffer);
    const width = image.bitmap.width;
    const height = image.bitmap.height;

    // ================================================
    // Step 1: 赤縦線検出（黄色検出より先に実行）
    // ================================================
    const redLines = detectRedLines(image, width, height);

    // ================================================
    // Step 2: 黄色マーカー検出（v1.2互換ロジック）
    // ================================================
    const yellowMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const r = image.bitmap.data[idx];
        const g = image.bitmap.data[idx + 1];
        const b = image.bitmap.data[idx + 2];
        const brightness = (r + g + b) / 3;
        if (
          (r - b) > CONFIG.YELLOW_RB_DIFF &&
          g > CONFIG.YELLOW_G_MIN &&
          r > CONFIG.YELLOW_R_MIN &&
          brightness > CONFIG.YELLOW_BRIGHTNESS_MIN
        ) {
          yellowMask[y * width + x] = 1;
        }
      }
    }

    // Dilate（膨張処理）
    const dilated = dilate(yellowMask, width, height, CONFIG.DILATE_RADIUS);

    // Y軸プロジェクション
    const yProfile = new Uint32Array(height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (dilated[y * width + x]) {
          yProfile[y]++;
        }
      }
    }

    // Y軸分割 → 領域抽出
    const rawRegions = extractRegions(dilated, yProfile, width, height);

    // Y軸ギャップによるサブ分割
    const regions = [];
    for (const region of rawRegions) {
      regions.push(...splitByYGap(dilated, width, region, CONFIG.Y_GAP_THRESHOLD));
    }

    // ================================================
    // Step 3: 赤縦線紐付け + クロップ生成
    // ================================================
    const crops = [];

    for (const region of regions) {
      // Y範囲が重なる赤縦線を取得（E-Lはまだ未検証）
      const yOverlappingLines = redLines.filter(
        (l) => l.yMin <= region.yEnd && l.yMax >= region.yStart
      );

      if (yOverlappingLines.length > 0) {
        // 赤縦線あり → 50%境界で左右分割し、E-L近接性をグループ別に検証
        const columnCrops = await splitByRedLines(
          dilated, image, width, height, region, yOverlappingLines
        );
        crops.push(...columnCrops);
      } else {
        // 赤縦線なし → v1.2互換（制限なしクロップ）
        const cropBuf = await cropRegionBase64(
          image, region.xMin, region.yStart,
          region.xMax - region.xMin + 1, region.yEnd - region.yStart + 1
        );
        crops.push({
          x: region.xMin,
          y: region.yStart,
          width: region.xMax - region.xMin + 1,
          height: region.yEnd - region.yStart + 1,
          column: 'none',
          image_base64: cropBuf,
        });
      }
    }

    // ================================================
    // Step 4: レスポンス
    // ================================================
    return res.status(200).json({
      image_width: width,
      image_height: height,
      red_lines_detected: redLines.length > 0,
      red_lines: redLines.map((l) => ({
        xMin: l.xMin,
        xMax: l.xMax,
        yMin: l.yMin,
        yMax: l.yMax,
        width: l.xMax - l.xMin + 1,
        height: l.yMax - l.yMin + 1,
        columnSide:
          l.xCenter < width * CONFIG.COLUMN_BOUNDARY ? 'left' : 'right',
      })),
      crops: crops.map((c) => ({
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height,
        column: c.column,
        image_base64: c.image_base64,
      })),
      crop_count: crops.length,
    });
  } catch (error) {
    console.error('Detection error:', error);
    return res.status(500).json({
      error: 'Detection failed',
      message: error.message,
    });
  }
};

// ============================================================
// 赤縦線検出: 赤マスク → BFS 4連結フラッドフィル → フィルタ
// ============================================================
function detectRedLines(image, width, height) {
  const redMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = image.bitmap.data[idx];
      const g = image.bitmap.data[idx + 1];
      const b = image.bitmap.data[idx + 2];
      if (
        (r - g) > CONFIG.RED_RG_THRESHOLD &&
        (r - b) > CONFIG.RED_RB_THRESHOLD &&
        r > CONFIG.RED_R_MIN
      ) {
        redMask[y * width + x] = 1;
      }
    }
  }

  // BFS 4連結フラッドフィル → 連結成分ラベリング
  const visited = new Uint8Array(width * height);
  const components = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (redMask[y * width + x] && !visited[y * width + x]) {
        const queue = [];
        let head = 0;
        queue.push(y * width + x);
        visited[y * width + x] = 1;

        let cxMin = x, cxMax = x, cyMin = y, cyMax = y;
        let pixelCount = 0;

        while (head < queue.length) {
          const pos = queue[head++];
          const cy = Math.floor(pos / width);
          const cx = pos % width;
          pixelCount++;

          if (cx < cxMin) cxMin = cx;
          if (cx > cxMax) cxMax = cx;
          if (cy < cyMin) cyMin = cy;
          if (cy > cyMax) cyMax = cy;

          // 4連結: 上下左右
          if (cy > 0 && redMask[(cy - 1) * width + cx] && !visited[(cy - 1) * width + cx]) {
            visited[(cy - 1) * width + cx] = 1;
            queue.push((cy - 1) * width + cx);
          }
          if (cy < height - 1 && redMask[(cy + 1) * width + cx] && !visited[(cy + 1) * width + cx]) {
            visited[(cy + 1) * width + cx] = 1;
            queue.push((cy + 1) * width + cx);
          }
          if (cx > 0 && redMask[cy * width + (cx - 1)] && !visited[cy * width + (cx - 1)]) {
            visited[cy * width + (cx - 1)] = 1;
            queue.push(cy * width + (cx - 1));
          }
          if (cx < width - 1 && redMask[cy * width + (cx + 1)] && !visited[cy * width + (cx + 1)]) {
            visited[cy * width + (cx + 1)] = 1;
            queue.push(cy * width + (cx + 1));
          }
        }

        components.push({ xMin: cxMin, xMax: cxMax, yMin: cyMin, yMax: cyMax, pixelCount });
      }
    }
  }

  // 縦線フィルタ
  const minHeight = Math.max(CONFIG.RED_MIN_HEIGHT_PX, height * CONFIG.RED_MIN_HEIGHT_RATIO);
  const lines = [];

  for (const comp of components) {
    const compW = comp.xMax - comp.xMin + 1;
    const compH = comp.yMax - comp.yMin + 1;
    const aspectRatio = compH / Math.max(compW, 1);

    if (
      aspectRatio >= CONFIG.RED_MIN_ASPECT_RATIO &&
      compH >= minHeight &&
      compW <= CONFIG.RED_MAX_WIDTH
    ) {
      lines.push({
        xMin: comp.xMin,
        xMax: comp.xMax,
        yMin: comp.yMin,
        yMax: comp.yMax,
        xCenter: (comp.xMin + comp.xMax) / 2,
        pixelCount: comp.pixelCount,
      });
    }
  }

  return lines;
}

// ============================================================
// 赤縦線ベースのクロップ分割（50%境界方式 + E-L近接性グループ別検証）
// 修正提案#1反映: 片側のみ赤縦線ケースを正しく処理
// ============================================================
async function splitByRedLines(dilated, image, width, height, region, yOverlappingLines) {
  const boundaryX = Math.floor(width * CONFIG.COLUMN_BOUNDARY);

  // (1) マーカーピクセルを50%境界で左右に分割
  let leftXMin = width, leftXMax = 0, leftYMin = height, leftYMax = 0;
  let rightXMin = width, rightXMax = 0, rightYMin = height, rightYMax = 0;
  let hasLeftPixels = false, hasRightPixels = false;

  for (let y = region.yStart; y <= region.yEnd; y++) {
    for (let x = region.xMin; x <= region.xMax; x++) {
      if (dilated[y * width + x]) {
        if (x < boundaryX) {
          hasLeftPixels = true;
          if (x < leftXMin) leftXMin = x;
          if (x > leftXMax) leftXMax = x;
          if (y < leftYMin) leftYMin = y;
          if (y > leftYMax) leftYMax = y;
        } else {
          hasRightPixels = true;
          if (x < rightXMin) rightXMin = x;
          if (x > rightXMax) rightXMax = x;
          if (y < rightYMin) rightYMin = y;
          if (y > rightYMax) rightYMax = y;
        }
      }
    }
  }

  // (2) E-L近接性検証をグループ別に実行
  const hasLeftLine = hasLeftPixels && yOverlappingLines.some(
    (l) => l.xMax <= leftXMin + CONFIG.ASSOCIATION_X_MARGIN
  );
  const hasRightLine = hasRightPixels && yOverlappingLines.some(
    (l) => l.xMax <= rightXMin + CONFIG.ASSOCIATION_X_MARGIN
  );

  // (3) どちらにもE-L紐付け不成立 → v1.2互換にフォールバック
  if (!hasLeftLine && !hasRightLine) {
    const cropBuf = await cropRegionBase64(
      image, region.xMin, region.yStart,
      region.xMax - region.xMin + 1, region.yEnd - region.yStart + 1
    );
    return [{
      x: region.xMin,
      y: region.yStart,
      width: region.xMax - region.xMin + 1,
      height: region.yEnd - region.yStart + 1,
      column: 'none',
      image_base64: cropBuf,
    }];
  }

  // (4) 左右それぞれのクロップ生成
  const crops = [];
  const cropLeftLimit = Math.floor(width * CONFIG.COLUMN_RIGHT_CROP_LIMIT);
  const cropRightLimit = Math.floor(width * CONFIG.COLUMN_LEFT_CROP_LIMIT);

  // 左段クロップ
  if (hasLeftPixels) {
    if (hasLeftLine) {
      const clippedXMax = Math.min(leftXMax, cropRightLimit);
      const cropBuf = await cropRegionBase64(
        image, leftXMin, leftYMin,
        clippedXMax - leftXMin + 1, leftYMax - leftYMin + 1
      );
      crops.push({
        x: leftXMin, y: leftYMin,
        width: clippedXMax - leftXMin + 1,
        height: leftYMax - leftYMin + 1,
        column: 'left',
        image_base64: cropBuf,
      });
    } else {
      const cropBuf = await cropRegionBase64(
        image, leftXMin, leftYMin,
        leftXMax - leftXMin + 1, leftYMax - leftYMin + 1
      );
      crops.push({
        x: leftXMin, y: leftYMin,
        width: leftXMax - leftXMin + 1,
        height: leftYMax - leftYMin + 1,
        column: 'none',
        image_base64: cropBuf,
      });
    }
  }

  // 右段クロップ
  if (hasRightPixels) {
    if (hasRightLine) {
      const clippedXMin = Math.max(rightXMin, cropLeftLimit);
      const cropBuf = await cropRegionBase64(
        image, clippedXMin, rightYMin,
        rightXMax - clippedXMin + 1, rightYMax - rightYMin + 1
      );
      crops.push({
        x: clippedXMin, y: rightYMin,
        width: rightXMax - clippedXMin + 1,
        height: rightYMax - rightYMin + 1,
        column: 'right',
        image_base64: cropBuf,
      });
    } else {
      const cropBuf = await cropRegionBase64(
        image, rightXMin, rightYMin,
        rightXMax - rightXMin + 1, rightYMax - rightYMin + 1
      );
      crops.push({
        x: rightXMin, y: rightYMin,
        width: rightXMax - rightXMin + 1,
        height: rightYMax - rightYMin + 1,
        column: 'none',
        image_base64: cropBuf,
      });
    }
  }

  return crops;
}

// ============================================================
// ヘルパー関数群
// ============================================================

// Y軸プロジェクションから領域を抽出
function extractRegions(dilated, yProfile, width, height) {
  const regions = [];
  let inRegion = false;
  let regionStart = 0;

  for (let y = 0; y <= height; y++) {
    const active = y < height && yProfile[y] > 0;
    if (active && !inRegion) {
      inRegion = true;
      regionStart = y;
    } else if (!active && inRegion) {
      inRegion = false;
      const regionHeight = y - regionStart;
      if (regionHeight >= CONFIG.MIN_REGION_HEIGHT) {
        let xMin = width, xMax = 0;
        for (let ry = regionStart; ry < y; ry++) {
          for (let rx = 0; rx < width; rx++) {
            if (dilated[ry * width + rx]) {
              if (rx < xMin) xMin = rx;
              if (rx > xMax) xMax = rx;
            }
          }
        }
        regions.push({ yStart: regionStart, yEnd: y - 1, xMin, xMax });
      }
    }
  }
  return regions;
}

// Dilate（膨張処理）— 正方形カーネル
function dilate(mask, width, height, radius) {
  const result = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const ny = y + dy;
            const nx = x + dx;
            if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
              result[ny * width + nx] = 1;
            }
          }
        }
      }
    }
  }
  return result;
}

// Y軸ギャップによるサブ分割
function splitByYGap(dilated, width, region, gapThreshold) {
  const subRegions = [];
  let currentStart = region.yStart;

  for (let y = region.yStart; y <= region.yEnd; y++) {
    let hasPixel = false;
    for (let x = 0; x < width; x++) {
      if (dilated[y * width + x]) {
        hasPixel = true;
        break;
      }
    }

    if (!hasPixel) {
      let gapEnd = y;
      while (gapEnd <= region.yEnd) {
        let nextHasPixel = false;
        for (let x = 0; x < width; x++) {
          if (dilated[gapEnd * width + x]) {
            nextHasPixel = true;
            break;
          }
        }
        if (nextHasPixel) break;
        gapEnd++;
      }

      const gapSize = gapEnd - y;
      if (gapSize >= gapThreshold && y > currentStart) {
        const sub = computeRegionBounds(dilated, width, currentStart, y - 1);
        if (sub) subRegions.push(sub);
        currentStart = gapEnd;
      }
      y = gapEnd - 1;
    }
  }

  if (currentStart <= region.yEnd) {
    const sub = computeRegionBounds(dilated, width, currentStart, region.yEnd);
    if (sub) subRegions.push(sub);
  }

  return subRegions.length > 0 ? subRegions : [region];
}

// 領域のバウンディングボックスを計算
function computeRegionBounds(dilated, width, yStart, yEnd) {
  let xMin = Infinity, xMax = 0;
  let hasPixels = false;
  for (let y = yStart; y <= yEnd; y++) {
    for (let x = 0; x < width; x++) {
      if (dilated[y * width + x]) {
        hasPixels = true;
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
    }
  }
  if (!hasPixels) return null;
  return { yStart, yEnd, xMin, xMax };
}

// 画像クロップ → base64
async function cropRegionBase64(image, x, y, w, h) {
  const safeX = Math.max(0, x);
  const safeY = Math.max(0, y);
  const safeW = Math.min(w, image.bitmap.width - safeX);
  const safeH = Math.min(h, image.bitmap.height - safeY);

  if (safeW <= 0 || safeH <= 0) return '';

  const cropped = image.clone().crop(safeX, safeY, safeW, safeH);
  const buf = await cropped.getBufferAsync(Jimp.MIME_PNG);
  return buf.toString('base64');
}
