// prelude.js — Standard library functions compiled as monkey-lang bytecode
// These are HOFs that the VM can't implement as simple builtins (need callback mechanism)
// Instead, they're written in monkey-lang, compiled at startup, and injected into the VM's global scope

import { Compiler, CompiledFunction, Closure } from './compiler.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { VM } from './vm.js';

const PRELUDE_SOURCE = `
let map = fn(arr, f) {
  let iter = fn(arr, acc) {
    if (len(arr) == 0) { acc; }
    else { iter(rest(arr), push(acc, f(first(arr)))); };
  };
  iter(arr, []);
};

let filter = fn(arr, f) {
  let iter = fn(arr, acc) {
    if (len(arr) == 0) { acc; }
    else {
      let item = first(arr);
      if (f(item)) {
        iter(rest(arr), push(acc, item));
      } else {
        iter(rest(arr), acc);
      };
    };
  };
  iter(arr, []);
};

let reduce = fn(arr, init, f) {
  let iter = fn(arr, acc) {
    if (len(arr) == 0) { acc; }
    else { iter(rest(arr), f(acc, first(arr))); };
  };
  iter(arr, init);
};

let any = fn(arr, f) {
  let iter = fn(arr) {
    if (len(arr) == 0) { false; }
    else {
      if (f(first(arr))) { true; }
      else { iter(rest(arr)); };
    };
  };
  iter(arr);
};

let all = fn(arr, f) {
  let iter = fn(arr) {
    if (len(arr) == 0) { true; }
    else {
      if (f(first(arr))) { iter(rest(arr)); }
      else { false; };
    };
  };
  iter(arr);
};

let find = fn(arr, f) {
  let iter = fn(arr) {
    if (len(arr) == 0) { null; }
    else {
      let item = first(arr);
      if (f(item)) { item; }
      else { iter(rest(arr)); };
    };
  };
  iter(arr);
};

let flat_map = fn(arr, f) {
  reduce(arr, [], fn(acc, x) {
    let result = f(x);
    if (type(result) == "ARRAY") {
      reduce(result, acc, fn(a, item) { push(a, item); });
    } else {
      push(acc, result);
    };
  });
};

let take = fn(arr, n) {
  let iter = fn(arr, n, acc) {
    if (n == 0) { acc; }
    else {
      if (len(arr) == 0) { acc; }
      else { iter(rest(arr), n - 1, push(acc, first(arr))); };
    };
  };
  iter(arr, n, []);
};

let drop = fn(arr, n) {
  if (n <= 0) { arr; }
  else {
    if (len(arr) == 0) { []; }
    else { drop(rest(arr), n - 1); };
  };
};
`;

let _compiledPrelude = null;

/**
 * Compile the prelude and return the bytecode.
 * Cached after first compilation.
 */
export function getPrelude() {
  if (_compiledPrelude) return _compiledPrelude;
  
  const lexer = new Lexer(PRELUDE_SOURCE);
  const parser = new Parser(lexer);
  const program = parser.parseProgram();
  const compiler = new Compiler();
  compiler.compile(program);
  _compiledPrelude = compiler.bytecode();
  return _compiledPrelude;
}

/**
 * Execute the prelude in a VM and return the global bindings.
 * These can be injected into other VMs.
 */
export function executePrelude() {
  const bc = getPrelude();
  const vm = new VM(bc);
  vm.run();
  return vm;
}

/**
 * Get the prelude function names.
 */
export const PRELUDE_FUNCTIONS = [
  'map', 'filter', 'reduce', 'any', 'all', 'find', 'flat_map', 'take', 'drop'
];

/**
 * Compile source code with the prelude prepended.
 * Returns bytecode ready for VM execution.
 */
export function compileWithPrelude(source) {
  const combined = PRELUDE_SOURCE + '\n' + source;
  const lexer = new Lexer(combined);
  const parser = new Parser(lexer);
  const program = parser.parseProgram();
  const compiler = new Compiler();
  compiler.compile(program);
  return compiler.bytecode();
}
