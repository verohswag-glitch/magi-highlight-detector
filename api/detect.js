const sharp = require('sharp');

module.exports = async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    const buf = Buffer.from(image, 'base64');
    const img = sharp(buf).removeAlpha();
    const { width, height } = await img.metadata();
    const raw = await img.raw().toBuffer();

    // ── CONFIG ──
    const CONFIG = {
      // Yellow marker detection
      YELLOW_RB_DIFF: 40,
      YELLOW_G_MIN: 170,
      YELLOW_R_MIN: 200,
      YELLOW_BRIGHTNESS_MIN: 200,

      // Morphological
      DILATE_RADIUS: 2,
      MIN_REGION_HEIGHT: 25,
      Y_GAP_THRESHOLD: 60,
      YELLOW_DENSITY_MIN: 0.07,
      MAX_CROP_HEIGHT: 500,

      // Red line detection
      RED_RG_THRESHOLD: 100,
      RED_RB_THRESHOLD: 100,
      RED_R_MIN: 180,
      RED_MIN_ASPECT_RATIO: 3,
      RED_MIN_HEIGHT_PX: 50,
      RED_MIN_HEIGHT_RATIO: 0.10,
      RED_MAX_WIDTH: 30,

      // Crop filtering
      COLUMN_SPLIT_MARGIN: 2,
      MIN_CROP_WIDTH: 50,
      MIN_CROP_HEIGHT: 20,

      // v1.7.0: Crop padding (pixels added to each side of the crop bounding box)
      CROP_PADDING_Y: 8,
      CROP_PADDING_X: 0,
    };

    // ── Helper: pixel index ──
    const idx = (x, y) => (y * width + x) * 3;

    // ── Step 1: Yellow mask ──
    const yellowMask = Buffer.alloc(width * height, 0);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y);
        const r = raw[i], g = raw[i + 1], b = raw[i + 2];
        const brightness = (r + g + b) / 3;
        if (
          r - b >= CONFIG.YELLOW_RB_DIFF &&
          g >= CONFIG.YELLOW_G_MIN &&
          r >= CONFIG.YELLOW_R_MIN &&
          brightness >= CONFIG.YELLOW_BRIGHTNESS_MIN
        ) {
          yellowMask[y * width + x] = 1;
        }
      }
    }

    // ── Step 2: Dilate yellow mask ──
    const dilated = Buffer.alloc(width * height, 0);
    const dr = CONFIG.DILATE_RADIUS;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (yellowMask[y * width + x] === 1) {
          for (let dy = -dr; dy <= dr; dy++) {
            for (let dx = -dr; dx <= dr; dx++) {
              const ny = y + dy, nx = x + dx;
              if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                dilated[ny * width + nx] = 1;
              }
            }
          }
        }
      }
    }

    // ── Step 3: Detect red vertical lines (BFS flood fill) ──
    const redMask = Buffer.alloc(width * height, 0);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y);
        const r = raw[i], g = raw[i + 1], b = raw[i + 2];
        if (
          r >= CONFIG.RED_R_MIN &&
          r - g >= CONFIG.RED_RG_THRESHOLD &&
          r - b >= CONFIG.RED_RB_THRESHOLD
        ) {
          redMask[y * width + x] = 1;
        }
      }
    }

    // BFS connected components on redMask
    const visited = Buffer.alloc(width * height, 0);
    const redLines = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (redMask[y * width + x] === 1 && !visited[y * width + x]) {
          // BFS
          const queue = [[x, y]];
          visited[y * width + x] = 1;
          let minX = x, maxX = x, minY = y, maxY = y;
          let count = 0;
          while (queue.length > 0) {
            const [cx, cy] = queue.shift();
            count++;
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;
            const neighbors = [[cx-1,cy],[cx+1,cy],[cx,cy-1],[cx,cy+1]];
            for (const [nx, ny] of neighbors) {
              if (nx >= 0 && nx < width && ny >= 0 && ny < height &&
                  redMask[ny * width + nx] === 1 && !visited[ny * width + nx]) {
                visited[ny * width + nx] = 1;
                queue.push([nx, ny]);
              }
            }
          }
          const compW = maxX - minX + 1;
          const compH = maxY - minY + 1;
          if (
            compH / compW >= CONFIG.RED_MIN_ASPECT_RATIO &&
            compH >= CONFIG.RED_MIN_HEIGHT_PX &&
            compH / height >= CONFIG.RED_MIN_HEIGHT_RATIO &&
            compW <= CONFIG.RED_MAX_WIDTH
          ) {
            redLines.push({ x: Math.round((minX + maxX) / 2), minY, maxY, width: compW, height: compH });
          }
        }
      }
    }

    // ── Step 4: Define columns based on red lines ──
    function defineColumns(redLines, imgWidth, margin) {
      if (redLines.length === 0) {
        return [{ id: 'col_0', xStart: 0, xEnd: imgWidth - 1 }];
      }
      const sorted = [...redLines].sort((a, b) => a.x - b.x);
      const columns = [];
      let prevEnd = 0;
      sorted.forEach((line, i) => {
        const colEnd = line.x - margin;
        if (colEnd > prevEnd) {
          columns.push({ id: `col_${i}`, xStart: prevEnd, xEnd: colEnd });
        }
        prevEnd = line.x + margin + 1;
      });
      if (prevEnd < imgWidth) {
        columns.push({ id: `col_${sorted.length}`, xStart: prevEnd, xEnd: imgWidth - 1 });
      }
      return columns;
    }

    const columns = defineColumns(redLines, width, CONFIG.COLUMN_SPLIT_MARGIN);

    // ── Step 5: Extract and split regions per column (1-pass method) ──
    function extractAndSplitRegionsInColumn(dilated, col, imgWidth, imgHeight, config) {
      const colWidth = col.xEnd - col.xStart + 1;
      // Build Y profile with density filtering
      const yProfile = [];
      for (let y = 0; y < imgHeight; y++) {
        let count = 0;
        for (let x = col.xStart; x <= col.xEnd; x++) {
          if (dilated[y * imgWidth + x] === 1) count++;
        }
        const density = count / colWidth;
        yProfile.push(density >= config.YELLOW_DENSITY_MIN ? count : 0);
      }

      // 1-pass: extract regions, only split at gaps >= Y_GAP_THRESHOLD
      const regions = [];
      let inRegion = false;
      let regionStart = 0;
      let gapStart = 0;

      for (let y = 0; y < imgHeight; y++) {
        if (yProfile[y] > 0) {
          if (!inRegion) {
            // Starting a new region or continuing after a gap
            if (regions.length > 0 && (y - gapStart) < config.Y_GAP_THRESHOLD) {
              // Gap too small — merge with previous region (pop and continue)
              const prev = regions.pop();
              regionStart = prev.yStart;
            } else {
              regionStart = y;
            }
            inRegion = true;
          }
        } else {
          if (inRegion) {
            // Entering a gap
            regions.push({ yStart: regionStart, yEnd: y - 1 });
            gapStart = y;
            inRegion = false;
          }
        }
      }
      if (inRegion) {
        regions.push({ yStart: regionStart, yEnd: imgHeight - 1 });
      }

      // Filter by MIN_REGION_HEIGHT
      const filtered = regions.filter(r => (r.yEnd - r.yStart + 1) >= config.MIN_REGION_HEIGHT);

      // Safety net: split oversized regions at largest gap
      const finalRegions = [];
      for (const region of filtered) {
        splitOversizedRegion(region, yProfile, config, finalRegions);
      }

      return finalRegions;
    }

    function splitOversizedRegion(region, yProfile, config, output) {
      const h = region.yEnd - region.yStart + 1;
      if (h <= config.MAX_CROP_HEIGHT) {
        output.push(region);
        return;
      }
      // Find largest gap within region
      let bestGapStart = -1, bestGapLen = 0;
      let currentGapStart = -1, currentGapLen = 0;
      for (let y = region.yStart; y <= region.yEnd; y++) {
        if (yProfile[y] === 0) {
          if (currentGapStart === -1) currentGapStart = y;
          currentGapLen++;
        } else {
          if (currentGapLen > bestGapLen) {
            bestGapStart = currentGapStart;
            bestGapLen = currentGapLen;
          }
          currentGapStart = -1;
          currentGapLen = 0;
        }
      }
      if (currentGapLen > bestGapLen) {
        bestGapStart = currentGapStart;
        bestGapLen = currentGapLen;
      }

      if (bestGapLen > 0) {
        const splitY = bestGapStart + Math.floor(bestGapLen / 2);
        const upper = { yStart: region.yStart, yEnd: splitY - 1 };
        const lower = { yStart: splitY, yEnd: region.yEnd };
        splitOversizedRegion(upper, yProfile, config, output);
        splitOversizedRegion(lower, yProfile, config, output);
      } else {
        output.push(region);
      }
    }

    // ── Step 6: Compute bounds and build crops ──
    function computeRegionBoundsInColumn(dilated, region, col, imgWidth) {
      let minX = col.xEnd, maxX = col.xStart;
      for (let y = region.yStart; y <= region.yEnd; y++) {
        for (let x = col.xStart; x <= col.xEnd; x++) {
          if (dilated[y * imgWidth + x] === 1) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }
      return { xStart: minX, xEnd: maxX };
    }

    const allCrops = [];
    for (const col of columns) {
      const regions = extractAndSplitRegionsInColumn(dilated, col, width, height, CONFIG);
      for (const region of regions) {
        const bounds = computeRegionBoundsInColumn(dilated, region, col, width);
        const cropW = bounds.xEnd - bounds.xStart + 1;
        const cropH = region.yEnd - region.yStart + 1;
        if (cropW >= CONFIG.MIN_CROP_WIDTH && cropH >= CONFIG.MIN_CROP_HEIGHT) {
          // v1.7.0: Apply padding with boundary clamping
          const padY = CONFIG.CROP_PADDING_Y;
          const padX = CONFIG.CROP_PADDING_X;
          const paddedX = Math.max(0, bounds.xStart - padX);
          const paddedY = Math.max(0, region.yStart - padY);
          const paddedXEnd = Math.min(width - 1, bounds.xEnd + padX);
          const paddedYEnd = Math.min(height - 1, region.yEnd + padY);

          allCrops.push({
            column: col.id,
            x: paddedX,
            y: paddedY,
            w: paddedXEnd - paddedX + 1,
            h: paddedYEnd - paddedY + 1,
            area: (paddedXEnd - paddedX + 1) * (paddedYEnd - paddedY + 1),
          });
        }
      }
    }

    // ── Step 7: Sort crops (left-to-right columns, top-to-bottom within column) ──
    allCrops.sort((a, b) => {
      if (a.column !== b.column) return a.column < b.column ? -1 : 1;
      return a.y - b.y;
    });

    // ── Step 8: Extract crop images ──
    const crops = [];
    for (let i = 0; i < allCrops.length; i++) {
      const c = allCrops[i];
      const cropped = await sharp(buf)
        .extract({ left: c.x, top: c.y, width: c.w, height: c.h })
        .png()
        .toBuffer();
      crops.push({
        index: i,
        base64: cropped.toString('base64'),
        bbox: { x: c.x, y: c.y, w: c.w, h: c.h },
        area: c.area,
      });
    }

    return res.status(200).json({
      highlight_count: crops.length,
      columns_detected: columns.length,
      columns: columns.map(c => ({ id: c.id, xStart: c.xStart, xEnd: c.xEnd })),
      red_lines: redLines.map(l => ({ x: l.x, height: l.height })),
      crop_count: crops.length,
      crops,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
