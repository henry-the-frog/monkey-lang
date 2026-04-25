#!/usr/bin/env node
/**
 * Monkey-lang Optimizer Fuzzer
 * 
 * Generates random Monkey programs and compares execution results
 * with optimization enabled vs disabled. Any divergence is a bug.
 * 
 * Usage: node src/opt-fuzz.js [--iterations N] [--seed S] [--verbose]
 */

import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { Compiler } from './compiler.js';
import { VM } from './vm.js';

const ITERATIONS = parseInt(process.argv.find(a => a.startsWith('--iterations='))?.split('=')[1] || '200');
const VERBOSE = process.argv.includes('--verbose');
let seed = parseInt(process.argv.find(a => a.startsWith('--seed='))?.split('=')[1] || String(Date.now()));

function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }

// Generate random Monkey programs
function genProgram() {
  const stmts = [];
  const vars = [];
  const n = randInt(1, 6);
  
  for (let i = 0; i < n; i++) {
    const type = rand();
    if (type < 0.3) {
      // Let with arithmetic
      const name = String.fromCharCode(97 + vars.length);
      if (vars.length >= 10) continue;
      const value = genExpr(vars, 0);
      stmts.push(`let ${name} = ${value}`);
      vars.push(name);
    } else if (type < 0.5 && vars.length > 0) {
      // Set statement
      const v = pick(vars);
      stmts.push(`set ${v} = ${genExpr(vars, 0)}`);
    } else if (type < 0.65) {
      // If expression
      const cond = genCondition(vars);
      const then = genExpr(vars, 0);
      const els = genExpr(vars, 0);
      stmts.push(`if (${cond}) { ${then} } else { ${els} }`);
    } else if (type < 0.75 && vars.length > 0) {
      // While loop (bounded)
      const v = pick(vars);
      stmts.push(`let _i = 0; while (_i < 5) { set _i = _i + 1 }`);
    } else if (type < 0.85) {
      // Function definition
      const name = 'f' + vars.length;
      if (vars.length >= 10) continue;
      stmts.push(`let ${name} = fn(x) { x ${pick(['+', '-', '*'])} ${randInt(1, 10)} }`);
      vars.push(name);
    } else {
      // Array operation
      stmts.push(`[${randInt(1,10)}, ${randInt(1,10)}, ${randInt(1,10)}]`);
    }
  }
  
  // Final expression to return a value
  if (vars.length > 0) {
    stmts.push(pick(vars));
  } else {
    stmts.push(String(randInt(1, 100)));
  }
  
  return stmts.join('; ');
}

function genExpr(vars, depth) {
  if (depth > 2) return String(randInt(0, 100));
  const type = rand();
  if (type < 0.3) return String(randInt(-100, 100));
  if (type < 0.4 && vars.length > 0) return pick(vars);
  if (type < 0.5) return `"${pick(['hello', 'world', 'foo', 'bar'])}"`;
  if (type < 0.7) {
    const op = pick(['+', '-', '*']);
    return `(${genExpr(vars, depth + 1)} ${op} ${genExpr(vars, depth + 1)})`;
  }
  if (type < 0.8) return `if (${genCondition(vars)}) { ${genExpr(vars, depth + 1)} } else { ${genExpr(vars, depth + 1)} }`;
  return String(randInt(0, 50));
}

function genCondition(vars) {
  if (rand() < 0.3 && vars.length > 0) {
    return `${pick(vars)} ${pick(['>', '<', '==', '!='])} ${randInt(-50, 50)}`;
  }
  return `${randInt(0, 100)} ${pick(['>', '<', '==', '!='])} ${randInt(0, 100)}`;
}

function runProgram(input, optimize) {
  const parser = new Parser(new Lexer(input));
  const program = parser.parseProgram();
  if (parser.errors.length > 0) return { error: parser.errors.join(', ') };
  
  const compiler = new Compiler({ optimize });
  compiler.compile(program);
  const bc = compiler.bytecode();
  const vm = new VM(bc);
  vm.run();
  const result = vm.lastPoppedStackElem();
  return { value: result?.inspect?.() ?? String(result), bytes: bc.instructions.length };
}

// Main
let pass = 0, fail = 0, errors = 0;
const divergences = [];

for (let i = 0; i < ITERATIONS; i++) {
  const program = genProgram();
  
  let r1, r2;
  try {
    r1 = runProgram(program, false);
    r2 = runProgram(program, true);
  } catch (e) {
    errors++;
    continue;
  }
  
  if (r1.error || r2.error) {
    // Both error or different errors
    if (r1.error && r2.error) { pass++; continue; }
    if (r1.error && !r2.error) { fail++; divergences.push({ program, issue: 'unopt errors, opt ok' }); continue; }
    if (!r1.error && r2.error) { fail++; divergences.push({ program, issue: 'opt errors, unopt ok' }); continue; }
  }
  
  if (r1.value === r2.value) {
    pass++;
  } else {
    fail++;
    divergences.push({ program: program.substring(0, 100), unopt: r1.value, opt: r2.value });
    if (VERBOSE) {
      console.log(`DIVERGENCE #${fail}:`);
      console.log(`  Program: ${program.substring(0, 100)}`);
      console.log(`  Unopt: ${r1.value} (${r1.bytes} bytes)`);
      console.log(`  Opt:   ${r2.value} (${r2.bytes} bytes)`);
    }
  }
}

console.log(`\nOptimizer Fuzzer Results (seed=${process.argv.find(a => a.startsWith('--seed='))?.split('=')[1] || 'random'}):`);
console.log(`Total: ${ITERATIONS}, Pass: ${pass}, Fail: ${fail}, Errors: ${errors}`);
console.log(`Pass rate: ${(pass * 100 / (pass + fail)).toFixed(1)}%`);

if (divergences.length > 0) {
  console.log(`\nDivergences (${divergences.length}):`);
  for (const d of divergences.slice(0, 5)) {
    console.log(`  ${d.program?.substring(0, 80)}`);
    console.log(`    unopt=${d.unopt}, opt=${d.opt}`);
  }
}
