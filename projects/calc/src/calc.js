// Arithmetic expression evaluator — recursive descent

export function evaluate(expr, vars = {}) {
  let pos = 0;
  const result = parseExpr();
  if (pos < expr.length) throw new Error(`Unexpected: ${expr[pos]}`);
  return result;

  function parseExpr() { return parseAdd(); }

  function parseAdd() {
    let left = parseMul();
    skipWS();
    while (pos < expr.length && (expr[pos] === '+' || expr[pos] === '-')) {
      const op = expr[pos++];
      const right = parseMul();
      left = op === '+' ? left + right : left - right;
      skipWS();
    }
    return left;
  }

  function parseMul() {
    let left = parsePow();
    skipWS();
    while (pos < expr.length && (expr[pos] === '*' || expr[pos] === '/' || expr[pos] === '%')) {
      const op = expr[pos++];
      const right = parsePow();
      if (op === '*') left *= right;
      else if (op === '/') { if (right === 0) throw new Error('Division by zero'); left /= right; }
      else left %= right;
      skipWS();
    }
    return left;
  }

  function parsePow() {
    const base = parseUnary();
    if (pos < expr.length && expr[pos] === '^') { pos++; return Math.pow(base, parsePow()); }
    return base;
  }

  function parseUnary() {
    skipWS();
    if (expr[pos] === '-') { pos++; return -parseUnary(); }
    if (expr[pos] === '+') { pos++; return parseUnary(); }
    return parseAtom();
  }

  function parseAtom() {
    skipWS();
    if (expr[pos] === '(') { pos++; const v = parseExpr(); expect(')'); return v; }

    // Function call
    const fnMatch = expr.slice(pos).match(/^([a-z]+)\s*\(/);
    if (fnMatch) {
      const name = fnMatch[1];
      pos += fnMatch[0].length;
      const args = [parseExpr()];
      while (expr[pos] === ',') { pos++; args.push(parseExpr()); }
      expect(')');
      const fns = { sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round, log: Math.log, log10: Math.log10, min: Math.min, max: Math.max, pow: Math.pow };
      if (!fns[name]) throw new Error(`Unknown function: ${name}`);
      return fns[name](...args);
    }

    // Variable
    const varMatch = expr.slice(pos).match(/^[a-zA-Z_]\w*/);
    if (varMatch) {
      pos += varMatch[0].length;
      const name = varMatch[0];
      if (name === 'pi' || name === 'PI') return Math.PI;
      if (name === 'e' || name === 'E') return Math.E;
      if (vars[name] !== undefined) return vars[name];
      throw new Error(`Unknown variable: ${name}`);
    }

    // Number
    const numMatch = expr.slice(pos).match(/^\d+\.?\d*/);
    if (numMatch) { pos += numMatch[0].length; skipWS(); return parseFloat(numMatch[0]); }

    throw new Error(`Unexpected: ${expr[pos]}`);
  }

  function skipWS() { while (pos < expr.length && expr[pos] === ' ') pos++; }
  function expect(ch) { skipWS(); if (expr[pos] !== ch) throw new Error(`Expected ${ch}`); pos++; }
}
