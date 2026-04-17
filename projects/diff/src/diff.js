// diff.js — Diff algorithms

// ===== Longest Common Subsequence =====
export function lcs(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  
  // Backtrack
  const result = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { result.unshift(a[i - 1]); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return result;
}

// ===== Myers Diff =====
export function myersDiff(a, b) {
  const n = a.length, m = b.length;
  const max = n + m;
  const v = new Array(2 * max + 1).fill(0);
  const trace = [];

  for (let d = 0; d <= max; d++) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max]; // down
      } else {
        x = v[k - 1 + max] + 1; // right
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[k + max] = x;
      if (x >= n && y >= m) {
        return buildEdits(a, b, trace, max);
      }
    }
  }
  return [];
}

function buildEdits(a, b, trace, max) {
  let x = a.length, y = b.length;
  const edits = [];
  
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    
    const prevX = v[prevK + max];
    const prevY = prevX - prevK;
    
    // Diagonal (equal)
    while (x > prevX && y > prevY) {
      x--; y--;
      edits.unshift({ type: 'equal', value: a[x] });
    }
    
    if (d > 0) {
      if (x === prevX) {
        y--;
        edits.unshift({ type: 'insert', value: b[y] });
      } else {
        x--;
        edits.unshift({ type: 'delete', value: a[x] });
      }
    }
  }
  
  return edits;
}

// ===== Simple line diff =====
export function diffLines(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  return myersDiff(oldLines, newLines);
}

// ===== Word diff =====
export function diffWords(oldText, newText) {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);
  return myersDiff(oldWords, newWords);
}

// ===== Unified diff format =====
export function unifiedDiff(oldName, newName, oldText, newText, context = 3) {
  const edits = diffLines(oldText, newText);
  if (edits.every(e => e.type === 'equal')) return '';

  const lines = [`--- ${oldName}`, `+++ ${newName}`];
  
  // Group edits into hunks
  const hunks = [];
  let hunk = null;
  let oldLine = 0, newLine = 0;
  
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const isChange = edit.type !== 'equal';
    
    // Check if near a change (within context)
    let nearChange = isChange;
    if (!nearChange) {
      for (let j = Math.max(0, i - context); j <= Math.min(edits.length - 1, i + context); j++) {
        if (edits[j].type !== 'equal') { nearChange = true; break; }
      }
    }
    
    if (nearChange) {
      if (!hunk) hunk = { oldStart: oldLine + 1, newStart: newLine + 1, oldCount: 0, newCount: 0, lines: [] };
      
      if (edit.type === 'equal') {
        hunk.lines.push(` ${edit.value}`);
        hunk.oldCount++;
        hunk.newCount++;
      } else if (edit.type === 'delete') {
        hunk.lines.push(`-${edit.value}`);
        hunk.oldCount++;
      } else {
        hunk.lines.push(`+${edit.value}`);
        hunk.newCount++;
      }
    } else if (hunk) {
      hunks.push(hunk);
      hunk = null;
    }
    
    if (edit.type === 'equal' || edit.type === 'delete') oldLine++;
    if (edit.type === 'equal' || edit.type === 'insert') newLine++;
  }
  if (hunk) hunks.push(hunk);
  
  for (const h of hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
    lines.push(...h.lines);
  }
  
  return lines.join('\n');
}

// ===== Patch Apply =====
export function applyPatch(text, edits) {
  const result = [];
  for (const edit of edits) {
    if (edit.type === 'equal' || edit.type === 'insert') result.push(edit.value);
  }
  return result;
}

// ===== 3-way merge =====
export function merge3(base, ours, theirs) {
  const baseLines = base.split('\n');
  const oursLines = ours.split('\n');
  const theirsLines = theirs.split('\n');
  
  // Build line-level change maps: which base lines were modified/deleted
  const oursChanges = new Map(); // baseIdx → replacement lines (or null for delete)
  const theirsChanges = new Map();
  
  function buildChangeMap(baseArr, modifiedArr) {
    const changes = new Map();
    const edits = myersDiff(baseArr, modifiedArr);
    let baseIdx = 0;
    let i = 0;
    while (i < edits.length) {
      const e = edits[i];
      if (e.type === 'equal') {
        baseIdx++;
        i++;
      } else if (e.type === 'delete') {
        // Collect inserts that follow
        const replacements = [];
        i++;
        while (i < edits.length && edits[i].type === 'insert') {
          replacements.push(edits[i].value);
          i++;
        }
        changes.set(baseIdx, replacements);
        baseIdx++;
      } else if (e.type === 'insert') {
        // Insert before baseIdx
        const key = `ins_${baseIdx}`;
        const existing = changes.get(key) || [];
        existing.push(e.value);
        changes.set(key, existing);
        i++;
      }
    }
    return changes;
  }
  
  const oMap = buildChangeMap(baseLines, oursLines);
  const tMap = buildChangeMap(baseLines, theirsLines);
  
  const result = [];
  let conflicts = 0;
  
  for (let bi = 0; bi < baseLines.length; bi++) {
    // Check for inserts before this line
    const oInsKey = `ins_${bi}`;
    const tInsKey = `ins_${bi}`;
    if (oMap.has(oInsKey)) result.push(...oMap.get(oInsKey));
    if (tMap.has(tInsKey)) result.push(...tMap.get(tInsKey));
    
    const oChanged = oMap.has(bi);
    const tChanged = tMap.has(bi);
    
    if (!oChanged && !tChanged) {
      result.push(baseLines[bi]);
    } else if (oChanged && !tChanged) {
      result.push(...oMap.get(bi));
    } else if (!oChanged && tChanged) {
      result.push(...tMap.get(bi));
    } else {
      // Both changed same line — conflict
      const oReplace = oMap.get(bi);
      const tReplace = tMap.get(bi);
      if (JSON.stringify(oReplace) === JSON.stringify(tReplace)) {
        result.push(...oReplace); // Same change
      } else {
        result.push('<<<<<<< ours');
        result.push(...oReplace);
        result.push('=======');
        result.push(...tReplace);
        result.push('>>>>>>> theirs');
        conflicts++;
      }
    }
  }
  
  // Trailing inserts
  const oTail = `ins_${baseLines.length}`;
  const tTail = `ins_${baseLines.length}`;
  if (oMap.has(oTail)) result.push(...oMap.get(oTail));
  if (tMap.has(tTail)) result.push(...tMap.get(tTail));
  
  return { result: result.join('\n'), conflicts };
}
