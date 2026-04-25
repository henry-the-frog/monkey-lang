// opt-fuzz.test.js — Optimizer fuzzer as a test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { Compiler } from './compiler.js';
import { VM } from './vm.js';

function runWithOptimize(input, optimize) {
  const p = new Parser(new Lexer(input)).parseProgram();
  if (p.errors?.length > 0) return { error: true };
  const c = new Compiler({ optimize });
  c.compile(p);
  const bc = c.bytecode();
  const vm = new VM(bc);
  vm.run();
  return { value: vm.lastPoppedStackElem()?.inspect?.() ?? 'null' };
}

describe('Optimizer Fuzzer (100 random programs)', () => {
  let seed = 42;
  function rand() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }
  function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
  function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }

  function genProgram() {
    const stmts = [];
    const vars = [];
    const n = randInt(1, 4);
    for (let i = 0; i < n; i++) {
      const name = String.fromCharCode(97 + vars.length);
      if (vars.length >= 5) continue;
      if (rand() < 0.3 && vars.length > 0) {
        stmts.push(`set ${pick(vars)} = ${randInt(0, 100)}`);
      } else {
        stmts.push(`let ${name} = ${randInt(0, 100)}`);
        vars.push(name);
      }
    }
    if (vars.length > 0) stmts.push(pick(vars));
    else stmts.push(String(randInt(1, 100)));
    return stmts.join('; ');
  }

  for (let i = 0; i < 100; i++) {
    const program = genProgram();
    it(`program ${i}: ${program.substring(0, 40)}`, () => {
      const r1 = runWithOptimize(program, false);
      const r2 = runWithOptimize(program, true);
      if (r1.error && r2.error) return;
      assert.strictEqual(r2.value, r1.value, `Divergence on: ${program}`);
    });
  }
});
