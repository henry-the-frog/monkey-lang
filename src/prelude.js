// prelude.js — Standard library functions compiled as monkey-lang bytecode
// These are HOFs that the VM can't implement as simple builtins (need callback mechanism)
// Instead, they're written in monkey-lang, compiled at startup, and injected into the VM's global scope

import { Compiler, CompiledFunction, Closure } from './compiler.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { VM } from './vm.js';

const PRELUDE_SOURCE = `
let map = fn(arr, f) { __nativeMap(arr, f); };

let filter = fn(arr, f) { __nativeFilter(arr, f); };

let reduce = fn(arr, init, f) { __nativeReduce(arr, init, f); };

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

let take_while = fn(arr, f) {
  let iter = fn(arr, acc) {
    if (len(arr) == 0) { acc; }
    else {
      let item = first(arr);
      if (f(item)) { iter(rest(arr), push(acc, item)); }
      else { acc; };
    };
  };
  iter(arr, []);
};

let scan = fn(arr, init, f) {
  let iter = fn(arr, acc, results) {
    if (len(arr) == 0) { results; }
    else {
      let newAcc = f(acc, first(arr));
      iter(rest(arr), newAcc, push(results, newAcc));
    };
  };
  iter(arr, init, []);
};

let chunk = fn(arr, size) {
  let iter = fn(arr, acc) {
    if (len(arr) == 0) { acc; }
    else {
      let piece = take(arr, size);
      iter(drop(arr, size), push(acc, piece));
    };
  };
  iter(arr, []);
};

let zip_with = fn(a, b, f) {
  let iter = fn(a, b, acc) {
    if (len(a) == 0) { acc; }
    else {
      if (len(b) == 0) { acc; }
      else { iter(rest(a), rest(b), push(acc, f(first(a), first(b)))); };
    };
  };
  iter(a, b, []);
};

let tap = fn(arr, f) {
  let iter = fn(arr, acc) {
    if (len(arr) == 0) { acc; }
    else {
      let item = first(arr);
      f(item);
      iter(rest(arr), push(acc, item));
    };
  };
  iter(arr, []);
};

let partition = fn(arr, f) {
  let iter = fn(arr, yes, no) {
    if (len(arr) == 0) { [yes, no]; }
    else {
      let item = first(arr);
      if (f(item)) { iter(rest(arr), push(yes, item), no); }
      else { iter(rest(arr), yes, push(no, item)); };
    };
  };
  iter(arr, [], []);
};

let group_by = fn(arr, f) {
  reduce(arr, {}, fn(groups, item) {
    let key = str(f(item));
    let existing = groups[key];
    if (type(existing) == "ARRAY") {
      merge(groups, {key: push(existing, item)});
    } else {
      merge(groups, {key: [item]});
    };
  });
};

let each = fn(arr, f) { __nativeForEach(arr, f); };
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
  'map', 'filter', 'reduce', 'any', 'all', 'find', 'flat_map', 'take', 'drop',
  'take_while', 'scan', 'chunk', 'zip_with', 'tap', 'partition', 'group_by', 'each'
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
