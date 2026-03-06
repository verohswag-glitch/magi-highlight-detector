// ============================================================
// detect.js v1.6.1 — 密度閾値 + 1パス統合 + MAX_CROP_HEIGHT安全網
// v1.6.1: Error 20修正（密度閾値で図表疑陽性除去）
//         Error 21修正（1パス統合でY_GAP_THRESHOLD未満gap分割防止）
//         Error 19再発防止（MAX_CROP_HEIGHT超過cropを強制再分割）
// v1.6:   Error 19修正 — 赤縦線で先にROI分割、各カラム独立にY軸処理
// 赤縦線なし → カラム1つ(全幅)として同一パスで処理（v1.2互換）
// ============================================================
const Jimp = require('jimp');

const CONFIG = {
  // --- 黄色マーカー検出（v1.2互換） ---
  YELLOW_RB_DIFF: 40,
  YELLOW_G_MIN: 170,
  YELLOW_R_MIN: 200,
  YELLOW_BRIGHTNESS_MIN: 200,
  DILATE_RADIUS: 2,
  MIN_REGION_HEIGHT: 25,
  Y_GAP_THRESHOLD: 75,

  // --- 黄色密度閾値（v1.6.1新規 — Error 20対策） ---
  YELLOW_DENSITY_MIN: 0.10,

  // --- 最大クロップ高さ（v1.6.1新規 — Error 19再発防止） ---
  MAX_CROP_HEIGHT: 500,

  // --- 赤縦線検出（v1.4新規） ---
  RED_RG_THRESHOLD: 100,
  RED_RB_THRESHOLD: 100,
  RED_R_MIN: 180,
  RED_MIN_ASPECT_RATIO: 3,
  RED_MIN_HEIGHT_PX: 50,
  RED_MIN_HEIGHT_RATIO: 0.10,
  RED_MAX_WIDTH: 30,

  // --- カラム分割マージン（v1.6新規） ---
  COLUMN_SPLIT_MARGIN: 2,

  // --- 最小クロップサイズフィルタ（v1.5継承） ---
  MIN_CROP_WIDTH: 50,
  MIN_CROP_HEIGHT: 30,
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
    // Step 2: 黄色マーカー検出 + 膨張（全画像共通）
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

    const dilated = dilate(yellowMask, width, height, CONFIG.DILATE_RADIUS);

    // ================================================
    // Step 3: カラム定義 → カラム別に独立して領域抽出
    // v1.6核心: 赤縦線ありなら先にROI分割してからY軸処理
    // v1.6.1: 密度閾値 + 1パス統合 + MAX_CROP_HEIGHT安全網
    // ================================================
    const columns = defineColumns(redLines, width);
    const rawCrops = [];

    for (const col of columns) {
      const colWidth = col.xEnd - col.xStart + 1;

      // カラム内のY軸プロジェクション（カラムX範囲のみカウント）
      // v1.6.1: 密度閾値適用 — yellowCount/colWidth < YELLOW_DENSITY_MIN → yProfile=0
      const yProfile = new Uint32Array(height);
      for (let y = 0; y < height; y++) {
        let yellowCount = 0;
        for (let x = col.xStart; x <= col.xEnd; x++) {
          if (dilated[y * width + x]) {
            yellowCount++;
          }
        }
        // v1.6.1: 密度閾値 — 図表罫線等の疑陽性をゼロ化
        if (yellowCount / colWidth >= CONFIG.YELLOW_DENSITY_MIN) {
          yProfile[y] = yellowCount;
        }
        // else: yProfile[y] は初期値0のまま
      }

      // v1.6.1: 1パス統合 — extractRegionsInColumn + splitByYGapInColumn を統合
      // Y_GAP_THRESHOLD未満のgapでは分割しない（Error 21修正）
      const regions = extractAndSplitRegionsInColumn(
        dilated, yProfile, width, height, col.xStart, col.xEnd
      );

      // v1.6.1: MAX_CROP_HEIGHT安全網 — 超過cropを最大gapで強制再分割
      const finalRegions = [];
      for (const region of regions) {
        const regionHeight = region.yEnd - region.yStart + 1;
        if (regionHeight > CONFIG.MAX_CROP_HEIGHT) {
          finalRegions.push(
            ...splitOversizedRegion(
              dilated, width, region, col.xStart, col.xEnd
            )
          );
        } else {
          finalRegions.push(region);
        }
      }

      // カラム内のクロップ生成
      for (const region of finalRegions) {
        const cropBuf = await cropRegionBase64(
          image, region.xMin, region.yStart,
          region.xMax - region.xMin + 1, region.yEnd - region.yStart + 1
        );
        rawCrops.push({
          x: region.xMin,
          y: region.yStart,
          width: region.xMax - region.xMin + 1,
          height: region.yEnd - region.yStart + 1,
          column: col.label,
          base64: cropBuf,
        });
      }
    }

    // ================================================
    // Step 3.5: 最小クロップサイズフィルタ（v1.5継承）
    // ================================================
    const crops = rawCrops.filter(
      (c) => c.width >= CONFIG.MIN_CROP_WIDTH && c.height >= CONFIG.MIN_CROP_HEIGHT
    );

    // ================================================
    // Step 4: レスポンス
    // CD_ExpandCrops が期待するフィールド: base64, index, bbox, area
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
        columnSide: l.xCenter < width * 0.5 ? 'left' : 'right',
      })),
      columns_detected: columns.length,
      columns: columns.map((c) => ({
        label: c.label,
        xStart: c.xStart,
        xEnd: c.xEnd,
      })),
      crops: crops.map((c, i) => ({
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height,
        column: c.column,
        base64: c.base64,
        index: i,
        bbox: { x: c.x, y: c.y, width: c.width, height: c.height },
        area: c.width * c.height,
      })),
      crop_count: crops.length,
      highlight_count: crops.length,
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
// カラム定義: 赤縦線の位置からカラム境界を決定
// 赤縦線なし → カラム1つ（全幅, label='none'）
// 赤縦線1本 → 左右2カラム（label='left'/'right'）
// 赤縦線N本 → N+1カラム（label='col_0'〜'col_N'）
// ============================================================
function defineColumns(redLines, width) {
  if (redLines.length === 0) {
    return [{ xStart: 0, xEnd: width - 1, label: 'none' }];
  }

  const sorted = [...redLines].sort((a, b) => a.xCenter - b.xCenter);
  const margin = CONFIG.COLUMN_SPLIT_MARGIN;
  const columns = [];

  for (let i = 0; i <= sorted.length; i++) {
    const xStart = i === 0
      ? 0
      : Math.min(sorted[i - 1].xMax + 1 + margin, width - 1);
    const xEnd = i === sorted.length
      ? width - 1
      : Math.max(sorted[i].xMin - 1 - margin, 0);

    if (xStart <= xEnd) {
      let label;
      if (sorted.length === 1) {
        label = i === 0 ? 'left' : 'right';
      } else {
        label = 'col_' + i;
      }
      columns.push({ xStart, xEnd, label });
    }
  }

  return columns;
}

// ============================================================
// 赤縦線検出: 赤マスク → BFS 4連結フラッドフィル → フィルタ
// （v1.5から変更なし）
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
// v1.6.1: 1パス統合 — 領域抽出 + Y軸ギャップ分割を統合
// 旧: extractRegionsInColumn → splitByYGapInColumn（2段階）
// 新: 1パスでY_GAP_THRESHOLD以上のgapのみで分割
// これによりError 21（微小gapでの文章途中切れ）を修正
// ============================================================
function extractAndSplitRegionsInColumn(dilated, yProfile, width, height, colXStart, colXEnd) {
  const regions = [];
  let inRegion = false;
  let regionStart = 0;
  let gapStart = -1;

  for (let y = 0; y <= height; y++) {
    const active = y < height && yProfile[y] > 0;

    if (active && !inRegion) {
      // 領域開始
      inRegion = true;
      regionStart = y;
      gapStart = -1;
    } else if (active && inRegion) {
      // 領域継続中 — gapカウントリセット
      if (gapStart >= 0) {
        const gapSize = y - gapStart;
        if (gapSize >= CONFIG.Y_GAP_THRESHOLD) {
          // 閾値以上のgap → ここで分割
          const bounds = computeRegionBoundsInColumn(
            dilated, width, regionStart, gapStart - 1, colXStart, colXEnd
          );
          if (bounds) regions.push(bounds);
          regionStart = y;
        }
        // 閾値未満のgap → 分割しない（Error 21修正の核心）
        gapStart = -1;
      }
    } else if (!active && inRegion) {
      // gap開始（ただしまだ領域終了とは判定しない）
      if (gapStart < 0) {
        gapStart = y;
      }
      // 画像末端チェック
      if (y === height) {
        // 画像の最後まで来た → gap中の領域を確定
        const endY = gapStart > 0 ? gapStart - 1 : y - 1;
        if (endY >= regionStart) {
          const bounds = computeRegionBoundsInColumn(
            dilated, width, regionStart, endY, colXStart, colXEnd
          );
          if (bounds) regions.push(bounds);
        }
        inRegion = false;
      }
    }
  }

  // MIN_REGION_HEIGHTフィルタ
  return regions.filter(
    (r) => (r.yEnd - r.yStart + 1) >= CONFIG.MIN_REGION_HEIGHT
  );
}

// ============================================================
// v1.6.1: MAX_CROP_HEIGHT超過cropを最大gapで強制再分割
// 超過regionを2分割 → 再帰的にさらに超過があれば分割
// 分割点: region内で黄色ピクセルが最も少ない行（最大gap）
// ============================================================
function splitOversizedRegion(dilated, width, region, colXStart, colXEnd) {
  const regionHeight = region.yEnd - region.yStart + 1;
  if (regionHeight <= CONFIG.MAX_CROP_HEIGHT) {
    return [region];
  }

  // 各行の黄色ピクセル数をカウント
  const rowCounts = [];
  for (let y = region.yStart; y <= region.yEnd; y++) {
    let count = 0;
    for (let x = colXStart; x <= colXEnd; x++) {
      if (dilated[y * width + x]) {
        count++;
      }
    }
    rowCounts.push({ y, count });
  }

  // 分割候補: 上下端から最低20%の範囲は避ける（極端な端での分割防止）
  const margin = Math.floor(regionHeight * 0.2);
  const searchStart = region.yStart + margin;
  const searchEnd = region.yEnd - margin;

  if (searchStart >= searchEnd) {
    // マージンを取ると検索範囲がない → 強制的に中央で分割
    const midY = region.yStart + Math.floor(regionHeight / 2);
    return splitAtY(dilated, width, region, midY, colXStart, colXEnd);
  }

  // 検索範囲内で最も黄色ピクセルが少ない行を探す（最大gap = 最適分割点）
  let bestY = -1;
  let bestCount = Infinity;
  for (const rc of rowCounts) {
    if (rc.y >= searchStart && rc.y <= searchEnd && rc.count < bestCount) {
      bestCount = rc.count;
      bestY = rc.y;
    }
  }

  if (bestY < 0) {
    // フォールバック: 中央で分割
    bestY = region.yStart + Math.floor(regionHeight / 2);
  }

  return splitAtY(dilated, width, region, bestY, colXStart, colXEnd);
}

// ============================================================
// 指定Y座標でregionを2分割し、再帰的に超過チェック
// ============================================================
function splitAtY(dilated, width, region, splitY, colXStart, colXEnd) {
  const results = [];

  // 上半分
  if (splitY > region.yStart) {
    const upper = computeRegionBoundsInColumn(
      dilated, width, region.yStart, splitY - 1, colXStart, colXEnd
    );
    if (upper) {
      results.push(
        ...splitOversizedRegion(dilated, width, upper, colXStart, colXEnd)
      );
    }
  }

  // 下半分
  if (splitY <= region.yEnd) {
    const lower = computeRegionBoundsInColumn(
      dilated, width, splitY, region.yEnd, colXStart, colXEnd
    );
    if (lower) {
      results.push(
        ...splitOversizedRegion(dilated, width, lower, colXStart, colXEnd)
      );
    }
  }

  // 分割できなかった場合はそのまま返す
  return results.length > 0 ? results : [region];
}

// ============================================================
// カラム内バウンディングボックス計算
// computeRegionBoundsのカラム制限版（v1.6から変更なし）
// ============================================================
function computeRegionBoundsInColumn(dilated, width, yStart, yEnd, colXStart, colXEnd) {
  let xMin = Infinity, xMax = 0;
  let hasPixels = false;
  for (let y = yStart; y <= yEnd; y++) {
    for (let x = colXStart; x <= colXEnd; x++) {
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

// ============================================================
// Dilate（膨張処理）— 正方形カーネル（v1.5から変更なし）
// ============================================================
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

// ============================================================
// 画像クロップ → base64（v1.5から変更なし）
// ============================================================
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
