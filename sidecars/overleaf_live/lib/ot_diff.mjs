export function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

export class OtMismatchError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'OtMismatchError';
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function splitsSurrogate(str, idx) {
  return (
    idx > 0 &&
    idx < str.length &&
    isHighSurrogate(str.charCodeAt(idx - 1)) &&
    isLowSurrogate(str.charCodeAt(idx))
  );
}

function commonPrefixSuffixSafe(a, b) {
  const minLen = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < minLen && a.charCodeAt(prefix) === b.charCodeAt(prefix)) {
    prefix++;
  }
  while (
    prefix > 0 &&
    (splitsSurrogate(a, prefix) || splitsSurrogate(b, prefix))
  ) {
    prefix--;
  }

  const maxSuffix = minLen - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    a.charCodeAt(a.length - 1 - suffix) ===
      b.charCodeAt(b.length - 1 - suffix)
  ) {
    suffix++;
  }
  while (
    suffix > 0 &&
    (splitsSurrogate(a, a.length - suffix) ||
      splitsSurrogate(b, b.length - suffix))
  ) {
    suffix--;
  }

  return { prefix, suffix };
}

export function applyOp(text, op) {
  if (typeof text !== 'string') {
    throw new OtMismatchError('Document text must be a string');
  }
  if (!Array.isArray(op)) {
    throw new OtMismatchError('Operation must be an array');
  }

  let doc = text;
  for (let idx = 0; idx < op.length; idx++) {
    const comp = op[idx];
    if (!comp || typeof comp !== 'object') {
      throw new OtMismatchError(`Invalid component at index ${idx}`);
    }
    const { p } = comp;
    if (!Number.isInteger(p) || p < 0) {
      throw new OtMismatchError(`Invalid component position ${p} at index ${idx}`);
    }

    const hasDel = typeof comp.d === 'string';
    const hasIns = typeof comp.i === 'string';
    if (!hasDel && !hasIns) {
      throw new OtMismatchError(
        `Component at index ${idx} must have string 'i' or 'd'`
      );
    }

    if (hasDel) {
      const d = comp.d;
      if (p + d.length > doc.length) {
        throw new OtMismatchError(
          `Delete out of bounds at index ${idx}: p=${p}, len=${d.length}, docLen=${doc.length}`
        );
      }
      const actual = doc.slice(p, p + d.length);
      if (actual !== d) {
        throw new OtMismatchError(
          `Delete mismatch at index ${idx}: expected ${JSON.stringify(d)}, got ${JSON.stringify(actual)}`
        );
      }
      doc = doc.slice(0, p) + doc.slice(p + d.length);
    }

    if (hasIns) {
      if (p > doc.length) {
        throw new OtMismatchError(
          `Insert out of bounds at index ${idx}: p=${p}, docLen=${doc.length}`
        );
      }
      doc = doc.slice(0, p) + comp.i + doc.slice(p);
    }
  }

  return doc;
}

function splitLinesKeepEol(str) {
  if (str.length === 0) return [];
  const lines = [];
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) {
      lines.push(str.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < str.length) {
    lines.push(str.slice(start));
  }
  return lines;
}

function splitLinesTrimTrailingEol(str) {
  const normalized = normalizeNewlines(str);
  if (normalized.length === 0) return [];
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

const MAX_LCS_CELLS = 1_000_000;

function findUniqueLineAnchors(a, a0, a1, b, b0, b1) {
  const countA = new Map();
  const idxA = new Map();
  for (let i = a0; i < a1; i++) {
    const line = a[i];
    const c = (countA.get(line) || 0) + 1;
    countA.set(line, c);
    if (c === 1) {
      idxA.set(line, i);
    } else {
      idxA.delete(line);
    }
  }

  const countB = new Map();
  const idxB = new Map();
  for (let j = b0; j < b1; j++) {
    const line = b[j];
    if (!idxA.has(line)) continue;
    const c = (countB.get(line) || 0) + 1;
    countB.set(line, c);
    if (c === 1) {
      idxB.set(line, j);
    } else {
      idxB.delete(line);
    }
  }

  if (idxB.size === 0) return [];

  const pairs = [];
  for (let i = a0; i < a1; i++) {
    const j = idxB.get(a[i]);
    if (j !== undefined) {
      pairs.push({ aIdx: i, bIdx: j });
    }
  }

  if (pairs.length === 0) return [];

  // Patience LIS on bIdx
  const tails = [];
  const tailPairIdx = [];
  const prevPairIdx = new Int32Array(pairs.length).fill(-1);

  for (let k = 0; k < pairs.length; k++) {
    const bVal = pairs[k].bIdx;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tails[mid] < bVal) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = bVal;
    tailPairIdx[lo] = k;
    if (lo > 0) {
      prevPairIdx[k] = tailPairIdx[lo - 1];
    }
  }

  const anchors = [];
  let cur = tailPairIdx[tails.length - 1];
  while (cur !== -1) {
    anchors.push(pairs[cur]);
    cur = prevPairIdx[cur];
  }
  anchors.reverse();
  return anchors;
}

function diffLineRange(a, a0, a1, b, b0, b1, out) {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
    out.push({ kind: 'eq', aIdx: a0, bIdx: b0 });
    a0++;
    b0++;
  }

  let suf = 0;
  while (
    a1 - suf > a0 &&
    b1 - suf > b0 &&
    a[a1 - 1 - suf] === b[b1 - 1 - suf]
  ) {
    suf++;
  }
  a1 -= suf;
  b1 -= suf;

  const m = a1 - a0;
  const n = b1 - b0;

  if (m === 0 && n === 0) {
    // Only suffix
  } else if (m === 0) {
    for (let j = b0; j < b1; j++) {
      out.push({ kind: 'add', bIdx: j });
    }
  } else if (n === 0) {
    for (let i = a0; i < a1; i++) {
      out.push({ kind: 'del', aIdx: i });
    }
  } else if (m * n <= MAX_LCS_CELLS) {
    const w = n + 1;
    const dp = new Int32Array((m + 1) * w);
    for (let i = m - 1; i >= 0; i--) {
      const lineA = a[a0 + i];
      const rowOffset = i * w;
      const nextRowOffset = (i + 1) * w;
      for (let j = n - 1; j >= 0; j--) {
        if (lineA === b[b0 + j]) {
          dp[rowOffset + j] = 1 + dp[nextRowOffset + j + 1];
        } else {
          const down = dp[nextRowOffset + j];
          const right = dp[rowOffset + j + 1];
          dp[rowOffset + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[a0 + i] === b[b0 + j]) {
        out.push({ kind: 'eq', aIdx: a0 + i, bIdx: b0 + j });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        out.push({ kind: 'del', aIdx: a0 + i });
        i++;
      } else {
        out.push({ kind: 'add', bIdx: b0 + j });
        j++;
      }
    }
    while (i < m) {
      out.push({ kind: 'del', aIdx: a0 + i });
      i++;
    }
    while (j < n) {
      out.push({ kind: 'add', bIdx: b0 + j });
      j++;
    }
  } else {
    const anchors = findUniqueLineAnchors(a, a0, a1, b, b0, b1);
    if (anchors.length > 0) {
      let curA = a0;
      let curB = b0;
      for (const anchor of anchors) {
        diffLineRange(a, curA, anchor.aIdx, b, curB, anchor.bIdx, out);
        out.push({ kind: 'eq', aIdx: anchor.aIdx, bIdx: anchor.bIdx });
        curA = anchor.aIdx + 1;
        curB = anchor.bIdx + 1;
      }
      diffLineRange(a, curA, a1, b, curB, b1, out);
    } else {
      for (let i = a0; i < a1; i++) {
        out.push({ kind: 'del', aIdx: i });
      }
      for (let j = b0; j < b1; j++) {
        out.push({ kind: 'add', bIdx: j });
      }
    }
  }

  for (let s = 0; s < suf; s++) {
    out.push({ kind: 'eq', aIdx: a1 + s, bIdx: b1 + s });
  }
}

export function diffToOp(oldText, newText) {
  const a = String(oldText ?? '');
  const b = String(newText ?? '');
  if (a === b) return [];

  const { prefix, suffix } = commonPrefixSuffixSafe(a, b);
  const oldMid = a.slice(prefix, a.length - suffix);
  const newMid = b.slice(prefix, b.length - suffix);

  if (oldMid.length === 0 && newMid.length === 0) return [];

  if (oldMid.indexOf('\n') === -1 || newMid.indexOf('\n') === -1) {
    const op = [];
    if (oldMid.length > 0) op.push({ p: prefix, d: oldMid });
    if (newMid.length > 0) op.push({ p: prefix, i: newMid });
    return op;
  }

  const oldLines = splitLinesKeepEol(oldMid);
  const newLines = splitLinesKeepEol(newMid);
  const steps = [];
  diffLineRange(oldLines, 0, oldLines.length, newLines, 0, newLines.length, steps);

  const op = [];
  let cursor = prefix;
  let idx = 0;

  while (idx < steps.length) {
    if (steps[idx].kind === 'eq') {
      cursor += oldLines[steps[idx].aIdx].length;
      idx++;
      continue;
    }

    let delChunk = '';
    let insChunk = '';
    while (idx < steps.length && steps[idx].kind !== 'eq') {
      if (steps[idx].kind === 'del') {
        delChunk += oldLines[steps[idx].aIdx];
      } else {
        insChunk += newLines[steps[idx].bIdx];
      }
      idx++;
    }

    const { prefix: hp, suffix: hs } = commonPrefixSuffixSafe(
      delChunk,
      insChunk
    );
    const dSub = delChunk.slice(hp, delChunk.length - hs);
    const iSub = insChunk.slice(hp, insChunk.length - hs);
    const editPos = cursor + hp;

    if (dSub.length > 0) {
      op.push({ p: editPos, d: dSub });
    }
    if (iSub.length > 0) {
      op.push({ p: editPos, i: iSub });
    }
    cursor += insChunk.length;
  }

  return op;
}

export function computeLineDiff(oldText, newText) {
  const oldLines = splitLinesTrimTrailingEol(oldText);
  const newLines = splitLinesTrimTrailingEol(newText);

  const steps = [];
  diffLineRange(oldLines, 0, oldLines.length, newLines, 0, newLines.length, steps);

  return steps.map((step) => {
    if (step.kind === 'eq') {
      return {
        type: 'equal',
        oldLine: step.aIdx + 1,
        newLine: step.bIdx + 1,
        text: oldLines[step.aIdx],
      };
    }
    if (step.kind === 'del') {
      return {
        type: 'del',
        oldLine: step.aIdx + 1,
        newLine: null,
        text: oldLines[step.aIdx],
      };
    }
    return {
      type: 'add',
      oldLine: null,
      newLine: step.bIdx + 1,
      text: newLines[step.bIdx],
    };
  });
}

function cloneComp(c) {
  return typeof c.i === 'string' ? { p: c.p, i: c.i } : { p: c.p, d: c.d };
}

function appendComp(dest, c) {
  if (!c) return;
  if (typeof c.i === 'string' && c.i.length === 0) return;
  if (typeof c.d === 'string' && c.d.length === 0) return;

  if (dest.length === 0) {
    dest.push(cloneComp(c));
    return;
  }

  const last = dest[dest.length - 1];
  if (typeof last.i === 'string' && typeof c.i === 'string') {
    if (last.p <= c.p && c.p <= last.p + last.i.length) {
      const offset = c.p - last.p;
      dest[dest.length - 1] = {
        p: last.p,
        i: last.i.slice(0, offset) + c.i + last.i.slice(offset),
      };
      return;
    }
  } else if (typeof last.d === 'string' && typeof c.d === 'string') {
    if (c.p <= last.p && last.p <= c.p + c.d.length) {
      const offset = last.p - c.p;
      dest[dest.length - 1] = {
        p: c.p,
        d: c.d.slice(0, offset) + last.d + c.d.slice(offset),
      };
      return;
    }
  }

  dest.push(cloneComp(c));
}

function normalizeOpToSingleComponents(op) {
  const out = [];
  for (const c of op) {
    if (!c || typeof c !== 'object') {
      throw new OtMismatchError('Invalid OT component');
    }
    if (typeof c.d === 'string' && c.d.length > 0) {
      out.push({ p: c.p, d: c.d });
    }
    if (typeof c.i === 'string' && c.i.length > 0) {
      out.push({ p: c.p, i: c.i });
    }
  }
  return out;
}

export function transformComponent(dest, c, otherC, side = 'left') {
  if (side !== 'left' && side !== 'right') {
    throw new RangeError("side must be 'left' or 'right'");
  }

  if (typeof c.i === 'string') {
    if (typeof otherC.i === 'string') {
      // i vs i
      if (c.p < otherC.p || (c.p === otherC.p && side === 'left')) {
        appendComp(dest, { p: c.p, i: c.i });
      } else {
        appendComp(dest, { p: c.p + otherC.i.length, i: c.i });
      }
    } else {
      // i vs d
      const otherEnd = otherC.p + otherC.d.length;
      if (c.p <= otherC.p) {
        appendComp(dest, { p: c.p, i: c.i });
      } else if (c.p <= otherEnd) {
        appendComp(dest, { p: otherC.p, i: c.i });
      } else {
        appendComp(dest, { p: c.p - otherC.d.length, i: c.i });
      }
    }
    return;
  }

  // c is delete
  const cLen = c.d.length;
  const cEnd = c.p + cLen;

  if (typeof otherC.i === 'string') {
    // d vs i
    if (otherC.p <= c.p) {
      appendComp(dest, { p: c.p + otherC.i.length, d: c.d });
    } else if (otherC.p >= cEnd) {
      appendComp(dest, { p: c.p, d: c.d });
    } else {
      const splitOffset = otherC.p - c.p;
      appendComp(dest, { p: c.p, d: c.d.slice(0, splitOffset) });
      appendComp(dest, {
        p: c.p + otherC.i.length,
        d: c.d.slice(splitOffset),
      });
    }
    return;
  }

  // d vs d
  const oEnd = otherC.p + otherC.d.length;
  if (cEnd <= otherC.p) {
    appendComp(dest, { p: c.p, d: c.d });
  } else if (c.p >= oEnd) {
    appendComp(dest, { p: c.p - otherC.d.length, d: c.d });
  } else {
    let newD = '';
    if (c.p < otherC.p) {
      newD += c.d.slice(0, otherC.p - c.p);
    }
    if (cEnd > oEnd) {
      newD += c.d.slice(oEnd - c.p);
    }
    if (newD.length > 0) {
      appendComp(dest, { p: Math.min(c.p, otherC.p), d: newD });
    }
  }
}

function transformSingleAgainstOp(c, rightOp, leftSide) {
  const rightSide = leftSide === 'left' ? 'right' : 'left';
  let leftQueue = [c];
  const outRight = [];

  for (let j = 0; j < rightOp.length; j++) {
    let rightQueue = [rightOp[j]];
    const nextLeft = [];

    for (let i = 0; i < leftQueue.length; i++) {
      const l = leftQueue[i];
      const nextRight = [];
      let curLParts = [l];

      for (let k = 0; k < rightQueue.length; k++) {
        const r = rightQueue[k];
        if (curLParts.length === 0) {
          nextRight.push(r);
          continue;
        }
        if (curLParts.length === 1) {
          const dl = [];
          const dr = [];
          transformComponent(dl, curLParts[0], r, leftSide);
          transformComponent(dr, r, curLParts[0], rightSide);
          curLParts = dl;
          for (const rc of dr) nextRight.push(rc);
        } else {
          // curLParts only exceeds 1 when l was split into multiple deletes,
          // and delete components never split r.
          let curR = [r];
          const updatedL = [];
          for (const lp of curLParts) {
            if (curR.length === 0) {
              updatedL.push(lp);
            } else {
              const dl = [];
              const dr = [];
              transformComponent(dl, lp, curR[0], leftSide);
              transformComponent(dr, curR[0], lp, rightSide);
              for (const lc of dl) updatedL.push(lc);
              curR = dr;
            }
          }
          curLParts = updatedL;
          for (const rc of curR) nextRight.push(rc);
        }
      }

      for (const lc of curLParts) nextLeft.push(lc);
      rightQueue = nextRight;
    }

    for (const rc of rightQueue) appendComp(outRight, rc);
    leftQueue = nextLeft;
  }

  return [leftQueue, outRight];
}

export function transformX(leftOp, rightOp, leftSide = 'left') {
  if (leftSide !== 'left' && leftSide !== 'right') {
    throw new RangeError("side must be 'left' or 'right'");
  }
  const left = normalizeOpToSingleComponents(leftOp);
  const right = normalizeOpToSingleComponents(rightOp);

  if (left.length === 0) {
    const outR = [];
    for (const r of right) appendComp(outR, r);
    return [[], outR];
  }
  if (right.length === 0) {
    const outL = [];
    for (const l of left) appendComp(outL, l);
    return [outL, []];
  }

  let currRight = right;
  const outLeft = [];
  for (let i = 0; i < left.length; i++) {
    const [dl, nextRight] = transformSingleAgainstOp(
      left[i],
      currRight,
      leftSide
    );
    for (const lc of dl) appendComp(outLeft, lc);
    currRight = nextRight;
  }

  return [outLeft, currRight];
}

export function transformOp(clientOp, serverOp, side = 'left') {
  if (side !== 'left' && side !== 'right') {
    throw new RangeError("side must be 'left' or 'right'");
  }
  const [clientPrime] = transformX(clientOp, serverOp, side);
  return clientPrime;
}
