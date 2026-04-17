// Range — Python-like range with lazy iteration

export function range(startOrEnd, end, step) {
  let start;
  if (end === undefined) { start = 0; end = startOrEnd; step = 1; }
  else { start = startOrEnd; step = step !== undefined ? step : (start <= end ? 1 : -1); }
  if (step === 0) throw new Error('Step cannot be zero');

  return {
    start, end, step,
    get length() { return Math.max(0, Math.ceil((end - start) / step)); },
    includes(n) { if (step > 0) return n >= start && n < end && (n - start) % step === 0; return n <= start && n > end && (start - n) % (-step) === 0; },
    at(i) { const val = start + i * step; return (step > 0 ? val < end : val > end) ? val : undefined; },
    toArray() { const arr = []; for (const v of this) arr.push(v); return arr; },
    map(fn) { return this.toArray().map(fn); },
    filter(fn) { return this.toArray().filter(fn); },
    reduce(fn, init) { return this.toArray().reduce(fn, init); },
    forEach(fn) { let i = 0; for (const v of this) fn(v, i++); },
    reverse() { return range(start + (this.length - 1) * step, start - step, -step); },
    slice(lo, hi) { const arr = this.toArray(); return arr.slice(lo, hi); },
    *[Symbol.iterator]() {
      if (step > 0) { for (let i = start; i < end; i += step) yield i; }
      else { for (let i = start; i > end; i += step) yield i; }
    },
  };
}
