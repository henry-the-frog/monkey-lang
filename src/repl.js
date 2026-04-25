#!/usr/bin/env node
// repl.js — Monkey Language REPL
// Usage: node src/repl.js [--engine=vm|interpreter]

import { createInterface } from 'readline';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { monkeyEval } from './evaluator.js';
import { Environment, MonkeyError } from './object.js';
import { Compiler } from './compiler.js';
import { VM } from './vm.js';

// Import prelude for VM mode
let PRELUDE_SOURCE = '';
try {
  const mod = await import('./prelude.js');
  PRELUDE_SOURCE = mod.PRELUDE_FUNCTIONS ? '' : ''; // Just need the module loaded
  // Get the actual source by reading it from the file
} catch (e) {}

const args = process.argv.slice(2);
const engineArg = args.find(a => a.startsWith('--engine='));
const engine = engineArg ? engineArg.split('=')[1] : 'vm';

if (!['vm', 'interpreter', 'both'].includes(engine)) {
  console.error(`Unknown engine: ${engine}. Use --engine=vm|interpreter|both`);
  process.exit(1);
}

console.log(`🐵 Monkey Language REPL (engine: ${engine})`);
console.log('Type "exit" or Ctrl+D to quit.\n');

const env = new Environment(); // Persistent env for interpreter mode
let vmGlobals = null; // Shared globals array for VM
let vmSymbolTable = null; // Shared symbol table for VM
let vmConstants = []; // Accumulated constants

// Initialize prelude for VM mode
if (engine === 'vm' || engine === 'both') {
  const preludeSource = `
let map = fn(arr, f) { let i = fn(a, acc) { if (len(a) == 0) { acc; } else { i(rest(a), push(acc, f(first(a)))); }; }; i(arr, []); };
let filter = fn(arr, f) { let i = fn(a, acc) { if (len(a) == 0) { acc; } else { let x = first(a); if (f(x)) { i(rest(a), push(acc, x)); } else { i(rest(a), acc); }; }; }; i(arr, []); };
let reduce = fn(arr, init, f) { let i = fn(a, acc) { if (len(a) == 0) { acc; } else { i(rest(a), f(acc, first(a))); }; }; i(arr, init); };
let any = fn(arr, f) { let i = fn(a) { if (len(a) == 0) { false; } else { if (f(first(a))) { true; } else { i(rest(a)); }; }; }; i(arr); };
let all = fn(arr, f) { let i = fn(a) { if (len(a) == 0) { true; } else { if (f(first(a))) { i(rest(a)); } else { false; }; }; }; i(arr); };
let find = fn(arr, f) { let i = fn(a) { if (len(a) == 0) { null; } else { let x = first(a); if (f(x)) { x; } else { i(rest(a)); }; }; }; i(arr); };
let take = fn(arr, n) { let i = fn(a, n, acc) { if (n == 0) { acc; } else { if (len(a) == 0) { acc; } else { i(rest(a), n - 1, push(acc, first(a))); }; }; }; i(arr, n, []); };
let drop = fn(arr, n) { if (n <= 0) { arr; } else { if (len(arr) == 0) { []; } else { drop(rest(arr), n - 1); }; }; };
0;
`;
  try {
    const compiler = new Compiler();
    const l = new Lexer(preludeSource);
    const p = new Parser(l);
    const prog = p.parseProgram();
    compiler.compile(prog);
    const bc = compiler.bytecode();
    const vm = new VM(bc);
    vm.run();
    vmGlobals = vm.globals;
    vmSymbolTable = compiler.symbolTable;
    vmConstants = [...compiler.constants];
    console.log('  (prelude loaded: map, filter, reduce, any, all, find, take, drop)');
  } catch (e) {
    console.log('  (prelude load failed:', e.message, ')');
  }
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '>> ',
});

rl.prompt();

rl.on('line', (line) => {
  const input = line.trim();
  if (input === 'exit' || input === 'quit') {
    console.log('Bye! 🐵');
    process.exit(0);
  }

  if (!input) {
    rl.prompt();
    return;
  }

  try {
    const l = new Lexer(input);
    const p = new Parser(l);
    const program = p.parseProgram();

    if (p.errors && p.errors.length > 0) {
      console.error('Parser errors:');
      for (const err of p.errors) console.error(`  ${err}`);
      rl.prompt();
      return;
    }

    if (engine === 'interpreter' || engine === 'both') {
      const start = performance.now();
      const result = monkeyEval(program, env);
      const elapsed = performance.now() - start;
      if (result instanceof MonkeyError) {
        console.error(`ERROR: ${result.message}`);
      } else if (result !== null && result !== undefined) {
        if (engine === 'both') {
          console.log(`[interp ${elapsed.toFixed(1)}ms] ${result.inspect()}`);
        } else {
          console.log(result.inspect());
        }
      }
    }

    if (engine === 'vm' || engine === 'both') {
      const start = performance.now();
      const compiler = new Compiler();
      // Restore symbol table state from previous lines
      if (vmSymbolTable) {
        compiler.symbolTable = vmSymbolTable;
      }
      // Restore constants
      compiler.constants = [...vmConstants];
      compiler.compile(program);
      const bc = compiler.bytecode();
      const vm = new VM(bc);
      if (vmGlobals) {
        for (let i = 0; i < vmGlobals.length; i++) {
          if (vmGlobals[i] !== undefined) vm.globals[i] = vmGlobals[i];
        }
      }
      vm.run();
      const elapsed = performance.now() - start;
      const result = vm.lastPoppedStackElem();
      vmGlobals = vm.globals;
      vmSymbolTable = compiler.symbolTable;
      vmConstants = compiler.constants;

      if (result !== null && result !== undefined) {
        if (engine === 'both') {
          console.log(`[vm     ${elapsed.toFixed(1)}ms] ${result.inspect()}`);
        } else {
          console.log(result.inspect());
        }
      }
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
  }

  rl.prompt();
});

rl.on('close', () => {
  console.log('\nBye! 🐵');
  process.exit(0);
});
