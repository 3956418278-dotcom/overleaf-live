import { posix } from 'node:path';
import { gunzipSync } from 'node:zlib';

const recordKinds = new WeakMap();

export function normalizeSynctexPath(rawPath) {
  const slashed = String(rawPath ?? '').trim().replace(/\\/g, '/');
  if (!slashed) return '';

  const isSandboxAbs = /^\/(?:compile|app)(?:\/|$)/.test(slashed);
  const isSystemAbs = slashed.startsWith('/') && !isSandboxAbs;

  let p = slashed
    .replace(/^\/compile\/(?:\.\/)?/, '')
    .replace(/^\/app\/(?:\.\/)?/, '')
    .replace(/^(?:\.\/)+/, '');

  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }

  return (isSystemAbs ? '/' : '') + parts.join('/');
}

function decodeSynctexBuffer(buffer) {
  if (buffer == null) return null;

  if (typeof buffer === 'string') {
    return buffer.length > 0 ? buffer : null;
  }

  let bytes;
  if (Buffer.isBuffer(buffer)) {
    bytes = buffer;
  } else if (buffer instanceof Uint8Array) {
    bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } else {
    return null;
  }

  if (bytes.length === 0) return null;

  // Check gzip magic header 0x1f 0x8b
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes);
    } catch {
      return null;
    }
  }

  if (bytes.length === 0) return null;
  return bytes.toString('utf8');
}

function getKindRank(rec) {
  const kind = recordKinds.get(rec);
  if (kind === '(' || kind === 'h') return 0;
  if (kind === 'x' || kind === 'k' || kind === 'g' || kind === '$') return 1;
  return 2; // '[' or 'v' outer vbox
}

export function parseSynctexGz(buffer) {
  const text = decodeSynctexBuffer(buffer);
  if (!text) return null;

  const lines = text.split(/\r\n?|\n/);

  let version = 1;
  let hasHeader = false;
  let mag = 1000;
  let unit = 1;
  let xOffset = 0;
  let yOffset = 0;

  const inputs = new Map();
  const records = [];
  const byFile = new Map();
  const byBasename = new Map();
  const byPage = new Map();

  let currentPage = 0;
  let inPostamble = false;

  const computeScales = () => {
    const ptScale = (unit * (mag / 1000)) * 72 / (65536 * 72.27);
    return {
      ptScale,
      xOffsetPt: xOffset * ptScale,
      yOffsetPt: yOffset * ptScale,
    };
  };

  let scales = computeScales();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (line.startsWith('SyncTeX Version:')) {
      const v = Number(line.slice('SyncTeX Version:'.length).trim());
      if (Number.isFinite(v)) version = v;
      hasHeader = true;
      continue;
    }

    if (line === 'Postamble:') {
      inPostamble = true;
      currentPage = 0;
      continue;
    }

    if (line === 'Content:' || line === 'Post scriptum:') {
      scales = computeScales();
      continue;
    }

    if (line.startsWith('Magnification:')) {
      const val = Number(line.slice('Magnification:'.length).trim());
      if (Number.isFinite(val) && val > 0) {
        mag = val;
        scales = computeScales();
      }
      continue;
    }

    if (line.startsWith('Unit:')) {
      const val = Number(line.slice('Unit:'.length).trim());
      if (Number.isFinite(val) && val > 0) {
        unit = val;
        scales = computeScales();
      }
      continue;
    }

    if (line.startsWith('X Offset:')) {
      const val = Number(line.slice('X Offset:'.length).trim());
      if (Number.isFinite(val)) {
        xOffset = val;
        scales = computeScales();
      }
      continue;
    }

    if (line.startsWith('Y Offset:')) {
      const val = Number(line.slice('Y Offset:'.length).trim());
      if (Number.isFinite(val)) {
        yOffset = val;
        scales = computeScales();
      }
      continue;
    }

    if (line.startsWith('Input:')) {
      const rest = line.slice('Input:'.length);
      const sep = rest.indexOf(':');
      if (sep > 0) {
        const tag = Number(rest.slice(0, sep));
        const rawFile = rest.slice(sep + 1);
        if (Number.isInteger(tag) && rawFile) {
          inputs.set(tag, normalizeSynctexPath(rawFile));
        }
      }
      continue;
    }

    if (inPostamble) continue;

    const ch = line[0];
    if (ch === '{') {
      const p = Number(line.slice(1));
      if (Number.isInteger(p) && p > 0) {
        currentPage = p;
        scales = computeScales();
      }
      continue;
    }

    if (ch === '}') {
      currentPage = 0;
      continue;
    }

    if (currentPage <= 0) continue;

    if (
      ch !== '[' &&
      ch !== '(' &&
      ch !== 'h' &&
      ch !== 'v' &&
      ch !== 'x' &&
      ch !== 'k' &&
      ch !== 'g' &&
      ch !== '$'
    ) {
      continue;
    }

    // Format: <kind><tag>,<line>[,<col>]:<x>,<y>[:<w>[,<h>,<d>]]
    const colon1 = line.indexOf(':', 1);
    if (colon1 === -1) continue;

    const head = line.slice(1, colon1);
    const headParts = head.split(',');
    if (headParts.length < 2) continue;

    const inputTag = Number(headParts[0]);
    const lineNum = Number(headParts[1]);
    if (
      !Number.isInteger(inputTag) ||
      !Number.isInteger(lineNum) ||
      lineNum <= 0
    ) {
      continue;
    }

    const file = inputs.get(inputTag);
    if (!file) continue;

    const colon2 = line.indexOf(':', colon1 + 1);
    const coordStr =
      colon2 === -1 ? line.slice(colon1 + 1) : line.slice(colon1 + 1, colon2);
    const coordParts = coordStr.split(',');
    if (coordParts.length < 2) continue;

    const rawX = Number(coordParts[0]);
    const rawY = Number(coordParts[1]);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) continue;

    let rawW = 0;
    let rawH = 0;
    let rawD = 0;
    if (colon2 !== -1) {
      const dimParts = line.slice(colon2 + 1).split(',');
      if (dimParts.length >= 1) {
        const w = Number(dimParts[0]);
        if (Number.isFinite(w)) rawW = w;
      }
      if (dimParts.length >= 2) {
        const h = Number(dimParts[1]);
        if (Number.isFinite(h)) rawH = h;
      }
      if (dimParts.length >= 3) {
        const d = Number(dimParts[2]);
        if (Number.isFinite(d)) rawD = d;
      }
    }

    const { ptScale, xOffsetPt, yOffsetPt } = scales;
    const xPt = rawX * ptScale + xOffsetPt;
    const isBox = ch === '[' || ch === '(' || ch === 'h' || ch === 'v';
    const yTopPt = isBox
      ? (rawY - rawH) * ptScale + yOffsetPt
      : rawY * ptScale + yOffsetPt;
    const wPt = Math.max(0, rawW * ptScale);
    const hPt = isBox ? Math.max(0, (rawH + rawD) * ptScale) : 0;

    const rec = {
      page: currentPage,
      inputTag,
      file,
      line: lineNum,
      xPt,
      yTopPt,
      wPt,
      hPt,
    };
    recordKinds.set(rec, ch);
    records.push(rec);

    let fileList = byFile.get(file);
    if (!fileList) {
      fileList = [];
      byFile.set(file, fileList);
    }
    fileList.push(rec);

    const base = posix.basename(file);
    let baseList = byBasename.get(base);
    if (!baseList) {
      baseList = [];
      byBasename.set(base, baseList);
    }
    baseList.push(rec);

    let pageList = byPage.get(currentPage);
    if (!pageList) {
      pageList = [];
      byPage.set(currentPage, pageList);
    }
    pageList.push(rec);
  }

  if (!hasHeader && inputs.size === 0 && records.length === 0) {
    return null;
  }

  return {
    version,
    mag,
    unit,
    xOffset,
    yOffset,
    ptScale: scales.ptScale,
    inputs,
    records,
    byFile,
    byBasename,
    byPage,
  };
}

export function forwardSync(index, relPath, line) {
  if (!index || !relPath || !Number.isFinite(line)) return null;
  const targetLine = Math.round(line);

  let norm = normalizeSynctexPath(relPath);
  if (norm.startsWith('/')) {
    norm = norm.slice(1);
  }
  if (!norm) return null;

  let candidates = index.byFile?.get(norm);
  if (!candidates || candidates.length === 0) {
    // Also try with leading slash in case it was stored as an absolute path
    candidates = index.byFile?.get('/' + norm);
  }
  if (!candidates || candidates.length === 0) {
    const base = posix.basename(norm);
    candidates = index.byBasename?.get(base);
  }
  if (!candidates || candidates.length === 0) return null;

  let best = null;
  let bestDist = Infinity;
  let bestRank = Infinity;
  let bestArea = Infinity;

  const considerCandidate = (rec, dist, preferAtOrAfter) => {
    const rank = getKindRank(rec);
    const area = rec.wPt * rec.hPt;
    if (!best) {
      best = rec;
      bestDist = dist;
      bestRank = rank;
      bestArea = area;
      return;
    }
    if (dist < bestDist) {
      best = rec;
      bestDist = dist;
      bestRank = rank;
      bestArea = area;
      return;
    }
    if (dist === bestDist) {
      const recAfter = rec.line >= targetLine;
      const bestAfter = best.line >= targetLine;
      if (preferAtOrAfter && recAfter !== bestAfter) {
        if (recAfter) {
          best = rec;
          bestDist = dist;
          bestRank = rank;
          bestArea = area;
        }
        return;
      }
      if (
        rank < bestRank ||
        (rank === bestRank &&
          ((best.wPt === 0 && rec.wPt > 0) ||
            (rec.wPt > 0 && best.wPt > 0 && area < bestArea)))
      ) {
        best = rec;
        bestDist = dist;
        bestRank = rank;
        bestArea = area;
      }
    }
  };

  for (let i = 0; i < candidates.length; i++) {
    const rec = candidates[i];
    const dist = Math.abs(rec.line - targetLine);
    if (dist > 5) continue;
    considerCandidate(rec, dist, false);
  }

  // Fallback for preamble lines, multi-line display blocks, comments, or floats (>5 lines away)
  if (!best) {
    let minLine = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].line < minLine) minLine = candidates[i].line;
    }
    const inPreamble = targetLine < minLine;

    for (let i = 0; i < candidates.length; i++) {
      const rec = candidates[i];
      if (inPreamble && rec.line < targetLine) continue;
      const dist = Math.abs(rec.line - targetLine);
      considerCandidate(rec, dist, true);
    }
  }

  if (!best) return null;

  return {
    page: best.page,
    xPt: best.xPt,
    yTopPt: best.yTopPt,
    wPt: Math.max(best.wPt, 36),
    hPt: Math.max(best.hPt, 12),
    matchedLine: best.line,
    file: best.file,
  };
}

export function inverseSync(index, page, xPt, yTopPt, { fileFilter = null } = {}) {
  if (!index || !Number.isFinite(page)) return null;
  const recs = index.byPage?.get(page);
  if (!recs || recs.length === 0) return null;

  const px = Number(xPt) || 0;
  const py = Number(yTopPt) || 0;

  let bestBox = null;
  let bestArea = Infinity;
  let bestBoxRank = Infinity;

  let bestNearest = null;
  let bestScore = Infinity;
  let bestNearestRank = Infinity;

  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec.file || rec.file.startsWith('/') || rec.file.includes('texlive')) {
      continue;
    }
    if (typeof fileFilter === 'function' && !fileFilter(rec.file)) {
      continue;
    }

    const rank = getKindRank(rec);

    // Restrict box containment to line/leaf nodes (rank < 2) with ±2pt vertical tolerance
    // so full-page vbox wrappers (`[`/`v`, rank === 2) never capture inter-line clicks.
    if (
      rank < 2 &&
      rec.wPt > 0 &&
      rec.hPt > 0 &&
      px >= rec.xPt &&
      px <= rec.xPt + rec.wPt &&
      py >= rec.yTopPt - 2 &&
      py <= rec.yTopPt + rec.hPt + 2
    ) {
      const area = rec.wPt * rec.hPt;
      if (
        area < bestArea ||
        (area === bestArea && rank < bestBoxRank)
      ) {
        bestBox = rec;
        bestArea = area;
        bestBoxRank = rank;
      }
    }

    const score =
      Math.abs(rec.yTopPt - py) * 4 +
      Math.abs(rec.xPt - px) +
      (rank >= 2 ? 200 : 0);
    if (
      score < bestScore ||
      (score === bestScore && rank < bestNearestRank)
    ) {
      bestNearest = rec;
      bestScore = score;
      bestNearestRank = rank;
    }
  }

  const chosen = bestBox || bestNearest;
  if (!chosen) return null;

  return {
    file: chosen.file,
    line: chosen.line,
  };
}
