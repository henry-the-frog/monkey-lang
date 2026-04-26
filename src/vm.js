// vm.js — Monkey Stack Virtual Machine
// Executes bytecode produced by the compiler.

import { Opcodes, lookup, readOperands } from './code.js';
import { CompiledFunction, Compiler, Closure, Cell } from './compiler.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { STDLIB } from './stdlib.js';
import {
    MonkeyInteger, MonkeyFloat, MonkeyString, MonkeyBoolean, MonkeyArray, MonkeyHash,
  MonkeyNull, MonkeyError, MonkeyBuiltin, ShapedHash, objectKeyString, internString,
  TRUE, FALSE, NULL, OBJ,
} from './object.js';
import { getShape, getIC, createICTable } from './shape.js';

function isHash(obj) { return obj instanceof MonkeyHash || obj instanceof ShapedHash; }

const STACK_SIZE = 8192;
const GLOBALS_SIZE = 65536;
const MAX_FRAMES = 1024;

// Integer cache for common values (-1 to 256)
const INT_CACHE_MIN = -1;
const INT_CACHE_MAX = 256;
const intCache = new Array(INT_CACHE_MAX - INT_CACHE_MIN + 1);
for (let i = INT_CACHE_MIN; i <= INT_CACHE_MAX; i++) {
  intCache[i - INT_CACHE_MIN] = new MonkeyInteger(i);
}

function cachedInteger(value) {
  if (value >= INT_CACHE_MIN && value <= INT_CACHE_MAX && Number.isInteger(value)) {
    return intCache[value - INT_CACHE_MIN];
  }
  return new MonkeyInteger(value);
}

/**
 * Frame: a call frame tracking instruction pointer and base pointer.
 */
class Frame {
  constructor(closure, basePointer) {
    this.closure = closure; // Closure wrapping CompiledFunction
    this.ip = -1;          // instruction pointer (into closure.fn.instructions)
    this.basePointer = basePointer; // stack index where locals start
  }

  instructions() {
    return this.closure.fn.instructions;
  }
}

// Builtins (must match compiler order)
export const builtins = [
  // len
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    const arg = args[0];
    if (arg instanceof MonkeyString) return cachedInteger(arg.value.length);
    if (arg instanceof MonkeyArray) return cachedInteger(arg.elements.length);
    return new MonkeyError(`argument to \`len\` not supported, got ${arg.type()}`);
  }),
  // first
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    if (args[0].type() !== OBJ.ARRAY) return new MonkeyError(`argument to \`first\` must be ARRAY, got ${args[0].type()}`);
    return args[0].elements.length > 0 ? args[0].elements[0] : NULL;
  }),
  // last
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    if (args[0].type() !== OBJ.ARRAY) return new MonkeyError(`argument to \`last\` must be ARRAY, got ${args[0].type()}`);
    const els = args[0].elements;
    return els.length > 0 ? els[els.length - 1] : NULL;
  }),
  // rest
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    if (args[0].type() !== OBJ.ARRAY) return new MonkeyError(`argument to \`rest\` must be ARRAY, got ${args[0].type()}`);
    const els = args[0].elements;
    return els.length > 0 ? new MonkeyArray(els.slice(1)) : NULL;
  }),
  // push
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=2`);
    if (args[0].type() !== OBJ.ARRAY) return new MonkeyError(`argument to \`push\` must be ARRAY, got ${args[0].type()}`);
    return new MonkeyArray([...args[0].elements, args[1]]);
  }),
  // puts
  new MonkeyBuiltin((...args) => {
    for (const arg of args) console.log(arg.inspect());
    return NULL;
  }),
  // print (no newline)
  new MonkeyBuiltin((...args) => {
    process.stdout.write(args.map(a => a.inspect()).join(''));
    return NULL;
  }),
  // type
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    return internString(args[0].type());
  }),
  // str (convert to string)
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    return internString(args[0].inspect());
  }),
  // int (convert to integer)
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    const arg = args[0];
    if (arg instanceof MonkeyInteger) return arg;
    if (arg instanceof MonkeyString) {
      const n = parseInt(arg.value, 10);
      return isNaN(n) ? NULL : cachedInteger(n);
    }
    return NULL;
  }),
  // bool
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError('bool: expected 1 argument');
    const a = args[0];
    if (a === NULL || a === FALSE) return FALSE;
    if (a === TRUE) return TRUE;
    if (a instanceof MonkeyInteger) return a.value !== 0 ? TRUE : FALSE;
    if (a instanceof MonkeyString) return a.value.length > 0 ? TRUE : FALSE;
    if (a instanceof MonkeyArray) return a.elements.length > 0 ? TRUE : FALSE;
    return TRUE;
  }),
  // format (string formatting)
  new MonkeyBuiltin((...args) => {
    if (args.length < 1) return new MonkeyError(`format requires at least 1 argument`);
    if (!(args[0] instanceof MonkeyString)) return new MonkeyError(`first argument to format must be a string`);
    let template = args[0].value;
    let argIdx = 1;
    let result = '';
    for (let i = 0; i < template.length; i++) {
      if (template[i] === '%' && i + 1 < template.length) {
        const spec = template[i + 1];
        if (spec === '%') { result += '%'; i++; continue; }
        if (argIdx >= args.length) { result += '%' + spec; i++; continue; }
        const arg = args[argIdx++];
        switch (spec) {
          case 's': result += arg.inspect(); break;
          case 'd': result += arg instanceof MonkeyInteger ? String(arg.value) : arg.inspect(); break;
          default: result += '%' + spec;
        }
        i++;
      } else {
        result += template[i];
      }
    }
    return internString(result);
  }),
  // range
  new MonkeyBuiltin((...args) => {
    if (args.length < 1 || args.length > 3) return new MonkeyError(`wrong number of arguments to range. got=${args.length}`);
    let start, end, step;
    if (args.length === 1) {
      start = 0; end = args[0].value; step = 1;
    } else if (args.length === 2) {
      start = args[0].value; end = args[1].value; step = 1;
    } else {
      start = args[0].value; end = args[1].value; step = args[2].value;
    }
    if (step === 0) return new MonkeyError('range step cannot be zero');
    const elements = [];
    if (step > 0) {
      for (let i = start; i < end; i += step) elements.push(cachedInteger(i));
    } else {
      for (let i = start; i > end; i += step) elements.push(cachedInteger(i));
    }
    return new MonkeyArray(elements);
  }),
  // split
  new MonkeyBuiltin((...args) => {
    if (args.length < 1 || args.length > 2) return new MonkeyError(`wrong number of arguments to split. got=${args.length}`);
    if (!(args[0] instanceof MonkeyString)) return new MonkeyError(`argument to split must be STRING, got ${args[0].type()}`);
    const sep = args.length === 2 && args[1] instanceof MonkeyString ? args[1].value : '';
    const parts = sep === '' ? [...args[0].value] : args[0].value.split(sep);
    return new MonkeyArray(parts.map(s => internString(s)));
  }),
  // join
  new MonkeyBuiltin((...args) => {
    if (args.length < 1 || args.length > 2) return new MonkeyError(`wrong number of arguments to join. got=${args.length}`);
    if (!(args[0] instanceof MonkeyArray)) return new MonkeyError(`first argument to join must be ARRAY, got ${args[0].type()}`);
    const sep = args.length === 2 && args[1] instanceof MonkeyString ? args[1].value : '';
    const strs = args[0].elements.map(e => e.inspect ? e.inspect() : String(e));
    return internString(strs.join(sep));
  }),
  // trim
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments to trim. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyString)) return new MonkeyError(`argument to trim must be STRING, got ${args[0].type()}`);
    return internString(args[0].value.trim());
  }),
  // upper
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments to upper. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyString)) return new MonkeyError(`argument to upper must be STRING, got ${args[0].type()}`);
    return internString(args[0].value.toUpperCase());
  }),
  // lower
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments to lower. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyString)) return new MonkeyError(`argument to lower must be STRING, got ${args[0].type()}`);
    return internString(args[0].value.toLowerCase());
  }),
  // contains
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return new MonkeyError(`wrong number of arguments to contains`);
    if (args[0] instanceof MonkeyString && args[1] instanceof MonkeyString) {
      return args[0].value.includes(args[1].value) ? TRUE : FALSE;
    }
    if (args[0] instanceof MonkeyArray) {
      for (const el of args[0].elements) {
        if (el.value !== undefined && args[1].value !== undefined && el.value === args[1].value) return TRUE;
      }
      return FALSE;
    }
    return new MonkeyError(`contains: unsupported types`);
  }),
  // indexOf
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return new MonkeyError(`wrong number of arguments to indexOf`);
    if (args[0] instanceof MonkeyString && args[1] instanceof MonkeyString) {
      return new MonkeyInteger(args[0].value.indexOf(args[1].value));
    }
    if (args[0] instanceof MonkeyArray) {
      for (let i = 0; i < args[0].elements.length; i++) {
        if (args[0].elements[i].value !== undefined && args[1].value !== undefined && args[0].elements[i].value === args[1].value) return new MonkeyInteger(i);
      }
      return new MonkeyInteger(-1);
    }
    return new MonkeyError(`indexOf: unsupported types`);
  }),
  // replace
  new MonkeyBuiltin((...args) => {
    if (args.length !== 3) return new MonkeyError('wrong number of arguments to replace');
    if (!(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyString) || !(args[2] instanceof MonkeyString))
      return new MonkeyError('replace: all arguments must be STRING');
    return internString(args[0].value.split(args[1].value).join(args[2].value));
  }),
  // reverse
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError('wrong number of arguments to reverse');
    if (args[0] instanceof MonkeyArray) return new MonkeyArray([...args[0].elements].reverse());
    if (args[0] instanceof MonkeyString) return internString([...args[0].value].reverse().join(''));
    return new MonkeyError(`reverse: unsupported type ${args[0].type()}`);
  }),
  // abs
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyInteger)) return new MonkeyError('abs: expected 1 integer');
    return new MonkeyInteger(Math.abs(args[0].value));
  }),
  // min
  new MonkeyBuiltin((...args) => {
    if (args.length < 2) return new MonkeyError('min: expected at least 2 arguments');
    let result = args[0].value;
    for (let i = 1; i < args.length; i++) result = Math.min(result, args[i].value);
    return new MonkeyInteger(result);
  }),
  // max
  new MonkeyBuiltin((...args) => {
    if (args.length < 2) return new MonkeyError('max: expected at least 2 arguments');
    let result = args[0].value;
    for (let i = 1; i < args.length; i++) result = Math.max(result, args[i].value);
    return new MonkeyInteger(result);
  }),
  // startsWith
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || !(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyString))
      return new MonkeyError('startsWith: expected 2 string arguments');
    return args[0].value.startsWith(args[1].value) ? TRUE : FALSE;
  }),
  // endsWith
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || !(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyString))
      return new MonkeyError('endsWith: expected 2 string arguments');
    return args[0].value.endsWith(args[1].value) ? TRUE : FALSE;
  }),
  // char
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyInteger)) return new MonkeyError('char: expected 1 integer');
    return internString(String.fromCharCode(args[0].value));
  }),
  // ord
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyString)) return new MonkeyError('ord: expected 1 string');
    return new MonkeyInteger(args[0].value.charCodeAt(0));
  }),
  // repeat
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || !(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyInteger))
      return new MonkeyError('repeat: expected (string, int)');
    return internString(args[0].value.repeat(args[1].value));
  }),
  // enumerate
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return new MonkeyError('enumerate: expected 1 array');
    return new MonkeyArray(args[0].elements.map((el, i) => new MonkeyArray([new MonkeyInteger(i), el])));
  }),
  // zip
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || !(args[0] instanceof MonkeyArray) || !(args[1] instanceof MonkeyArray))
      return new MonkeyError('zip: expected 2 arrays');
    const len = Math.min(args[0].elements.length, args[1].elements.length);
    const result = [];
    for (let i = 0; i < len; i++) result.push(new MonkeyArray([args[0].elements[i], args[1].elements[i]]));
    return new MonkeyArray(result);
  }),
  // slice
  new MonkeyBuiltin((...args) => {
    if (args.length < 2 || args.length > 3) return new MonkeyError('slice: expected 2-3 arguments');
    const start = args[1] instanceof MonkeyInteger ? args[1].value : 0;
    const end = args.length > 2 && args[2] instanceof MonkeyInteger ? args[2].value : undefined;
    if (args[0] instanceof MonkeyString) return internString(args[0].value.slice(start, end));
    if (args[0] instanceof MonkeyArray) return new MonkeyArray(args[0].elements.slice(start, end));
    return new MonkeyError('slice: first argument must be string or array');
  }),
  // sum
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return new MonkeyError('sum: expected 1 array');
    let total = 0;
    for (const el of args[0].elements) {
      if (el instanceof MonkeyInteger) total += el.value;
      else return new MonkeyError('sum: all elements must be integers');
    }
    return new MonkeyInteger(total);
  }),
  // count (string occurrences)
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || !(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyString))
      return new MonkeyError('count: expected (string, substring)');
    const str = args[0].value, sub = args[1].value;
    if (!sub) return new MonkeyInteger(0);
    let count = 0, pos = 0;
    while ((pos = str.indexOf(sub, pos)) !== -1) { count++; pos += sub.length; }
    return new MonkeyInteger(count);
  }),
  // compact (remove nulls)
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return new MonkeyError('compact: expected 1 array');
    return new MonkeyArray(args[0].elements.filter(el => el !== NULL));
  }),
  // unique (deduplicate)
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return new MonkeyError('unique: expected 1 array');
    const seen = new Set();
    const result = [];
    for (const el of args[0].elements) {
      const key = el.inspect();
      if (!seen.has(key)) { seen.add(key); result.push(el); }
    }
    return new MonkeyArray(result);
  }),
  // isEmpty
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError('isEmpty: expected 1 argument');
    if (args[0] instanceof MonkeyString) return args[0].value.length === 0 ? TRUE : FALSE;
    if (args[0] instanceof MonkeyArray) return args[0].elements.length === 0 ? TRUE : FALSE;
    if (args[0] === NULL) return TRUE;
    return FALSE;
  }),
  // flatten (deep recursive)
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return new MonkeyError('flatten: expected 1 array');
    function flatDeep(arr) {
      const result = [];
      for (const el of arr.elements) {
        if (el instanceof MonkeyArray) result.push(...flatDeep(el));
        else result.push(el);
      }
      return result;
    }
    return new MonkeyArray(flatDeep(args[0]));
  }),
  // keys (VM hash format: Map<key, value>)
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments to keys. got=${args.length}, want=1`);
    if (!isHash(args[0])) return new MonkeyError(`argument to keys must be HASH, got ${args[0].type()}`);
    const ks = [];
    for (const [k] of args[0].pairs) ks.push(k);
    return new MonkeyArray(ks);
  }),
  // values (VM hash format: Map<key, value>)
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments to values. got=${args.length}, want=1`);
    if (!isHash(args[0])) return new MonkeyError(`argument to values must be HASH, got ${args[0].type()}`);
    const vs = [];
    for (const [, v] of args[0].pairs) vs.push(v);
    return new MonkeyArray(vs);
  }),
  // sort (default, no comparator in VM)
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments to sort. got=${args.length} (VM sort only supports default sort)`);
    if (!(args[0] instanceof MonkeyArray)) return new MonkeyError(`argument to sort must be ARRAY, got ${args[0].type()}`);
    const sorted = [...args[0].elements];
    sorted.sort((a, b) => {
      if (a.value < b.value) return -1;
      if (a.value > b.value) return 1;
      return 0;
    });
    return new MonkeyArray(sorted);
  }),
  // padStart
  new MonkeyBuiltin((...args) => {
    if (args.length < 2 || args.length > 3) return new MonkeyError(`padStart: expected 2-3 arguments, got ${args.length}`);
    if (!(args[0] instanceof MonkeyString)) return new MonkeyError(`padStart: first arg must be STRING`);
    if (!(args[1] instanceof MonkeyInteger)) return new MonkeyError(`padStart: second arg must be INTEGER`);
    const pad = args.length === 3 && args[2] instanceof MonkeyString ? args[2].value : ' ';
    return internString(args[0].value.padStart(args[1].value, pad));
  }),
  // padEnd
  new MonkeyBuiltin((...args) => {
    if (args.length < 2 || args.length > 3) return new MonkeyError(`padEnd: expected 2-3 arguments, got ${args.length}`);
    if (!(args[0] instanceof MonkeyString)) return new MonkeyError(`padEnd: first arg must be STRING`);
    if (!(args[1] instanceof MonkeyInteger)) return new MonkeyError(`padEnd: second arg must be INTEGER`);
    const pad = args.length === 3 && args[2] instanceof MonkeyString ? args[2].value : ' ';
    return internString(args[0].value.padEnd(args[1].value, pad));
  }),
  // float
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError('float: expected 1 argument');
    const a = args[0];
    if (a instanceof MonkeyFloat) return a;
    if (a instanceof MonkeyInteger) return new MonkeyFloat(a.value);
    if (a instanceof MonkeyString) {
      const n = parseFloat(a.value);
      return isNaN(n) ? NULL : new MonkeyFloat(n);
    }
    return NULL;
  }),
  // floor
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError('floor: expected 1 argument');
    return cachedInteger(Math.floor(args[0].value));
  }),
  // ceil
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError('ceil: expected 1 argument');
    return cachedInteger(Math.ceil(args[0].value));
  }),
  // sqrt
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError('sqrt: expected 1 argument');
    const v = Math.sqrt(args[0].value);
    return Number.isInteger(v) ? cachedInteger(v) : new MonkeyFloat(v);
  }),
  // pow
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return new MonkeyError('pow: expected 2 arguments');
    const v = Math.pow(args[0].value, args[1].value);
    return Number.isInteger(v) ? cachedInteger(v) : new MonkeyFloat(v);
  }),
  // chars: split string into array of characters
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError('chars: expected 1 argument');
    const s = args[0] instanceof MonkeyString ? args[0].value : String(args[0].value ?? '');
    return new MonkeyArray(s.split('').map(c => internString(c)));
  }),
  // sin
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError('sin: expected 1 argument');
    return new MonkeyFloat(Math.sin(args[0].value));
  }),
  // cos
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError('cos: expected 1 argument');
    return new MonkeyFloat(Math.cos(args[0].value));
  }),
  // merge: merge two hashes
  new MonkeyBuiltin((...args) => {
    if (args.length < 2) return new MonkeyError('merge: expected at least 2 arguments');
    const result = new Map();
    for (const arg of args) {
      if (arg.pairs) {
        for (const [k, v] of arg.pairs) result.set(k, v);
      }
    }
    return new MonkeyHash(result);
  }),
  // product: multiply all numbers in array
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return new MonkeyError('product: expected 1 array argument');
    let p = 1;
    for (const el of args[0].elements) p *= el.value;
    return Number.isInteger(p) ? cachedInteger(p) : new MonkeyFloat(p);
  }),
  // import: load a module by name from STDLIB
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyString)) {
      return new MonkeyError('import: expected 1 string argument (module name)');
    }
    const name = args[0].value;
    const source = STDLIB[name];
    if (!source) return new MonkeyError(`import: module "${name}" not found`);
    try {
      const lexer = new Lexer(source);
      const parser = new Parser(lexer);
      const program = parser.parseProgram();
      const compiler = new Compiler();
      compiler.compile(program);
      const vm = new VM(compiler.bytecode());
      vm.run();
      return vm.lastPoppedStackElem();
    } catch (e) {
      return new MonkeyError(`import: error loading "${name}": ${e.message}`);
    }
  }),
  // __range_inclusive: a..b → [a, a+1, ..., b] or [a, a-1, ..., b]
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return new MonkeyError(`wrong number of arguments to __range_inclusive. got=${args.length}`);
    const start = args[0].value, end = args[1].value;
    const elements = [];
    if (start <= end) {
      for (let i = start; i <= end; i++) elements.push(cachedInteger(i));
    } else {
      for (let i = start; i >= end; i--) elements.push(cachedInteger(i));
    }
    return new MonkeyArray(elements);
  }),
  // __nativeMap: native map with VM callback (array, fn) → array
  Object.assign(new MonkeyBuiltin((vm, arr, fn) => {
    if (!(arr instanceof MonkeyArray)) return new MonkeyError('first argument to __nativeMap must be ARRAY');
    if (!(fn instanceof Closure)) return new MonkeyError('second argument to __nativeMap must be FUNCTION');
    const results = [];
    for (let i = 0; i < arr.elements.length; i++) {
      results.push(vm.callClosureSync(fn, [arr.elements[i]]));
    }
    return new MonkeyArray(results);
  }), { needsVM: true }),
  // __nativeFilter: native filter with VM callback (array, fn) → array
  Object.assign(new MonkeyBuiltin((vm, arr, fn) => {
    if (!(arr instanceof MonkeyArray)) return new MonkeyError('first argument to __nativeFilter must be ARRAY');
    if (!(fn instanceof Closure)) return new MonkeyError('second argument to __nativeFilter must be FUNCTION');
    const results = [];
    for (let i = 0; i < arr.elements.length; i++) {
      const result = vm.callClosureSync(fn, [arr.elements[i]]);
      if (vm.isTruthy(result)) {
        results.push(arr.elements[i]);
      }
    }
    return new MonkeyArray(results);
  }), { needsVM: true }),
  // __nativeReduce: native reduce with VM callback (array, init, fn) → value
  Object.assign(new MonkeyBuiltin((vm, arr, init, fn) => {
    if (!(arr instanceof MonkeyArray)) return new MonkeyError('first argument to __nativeReduce must be ARRAY');
    if (!(fn instanceof Closure)) return new MonkeyError('third argument to __nativeReduce must be FUNCTION');
    let acc = init;
    for (let i = 0; i < arr.elements.length; i++) {
      acc = vm.callClosureSync(fn, [acc, arr.elements[i]]);
    }
    return acc;
  }), { needsVM: true }),
  // __nativeForEach: native forEach with VM callback (array, fn) → null
  Object.assign(new MonkeyBuiltin((vm, arr, fn) => {
    if (!(arr instanceof MonkeyArray)) return new MonkeyError('first argument to __nativeForEach must be ARRAY');
    if (!(fn instanceof Closure)) return new MonkeyError('second argument to __nativeForEach must be FUNCTION');
    for (let i = 0; i < arr.elements.length; i++) {
      vm.callClosureSync(fn, [arr.elements[i]]);
    }
    return NULL;
  }), { needsVM: true }),
];

/**
 * VM: the Monkey stack virtual machine.
 */
export class VM {
  constructor(bytecode, gc = null) {
    this.constants = bytecode.constants;

    // Main program is wrapped in a closure/frame
    const mainFn = new CompiledFunction(bytecode.instructions);
    const mainClosure = new Closure(mainFn);
    const mainFrame = new Frame(mainClosure, 0);

    this.frames = new Array(MAX_FRAMES);
    this.frames[0] = mainFrame;
    this.framesIndex = 1;

    this.stack = new Array(STACK_SIZE);
    this.sp = 0; // stack pointer (points to next free slot)

    this.globals = new Array(GLOBALS_SIZE);

    // Inline cache table for hash property access
    this.icTable = createICTable();

    // Garbage collector (optional)
    this.gc = gc;
    if (gc) {
      gc.attach(this);
      // Track constants
      for (const c of this.constants) {
        gc.track(c);
      }
    }
  }

  /**
   * Track an object with the GC (if enabled).
   */
  _track(obj) {
    if (this.gc) this.gc.track(obj);
    return obj;
  }

  /**
   * Get the last popped element from the stack.
   */
  lastPoppedStackElem() {
    return this.stack[this.sp];
  }

  /**
   * Run the VM until completion.
   */
  run() {
    while (this.currentFrame().ip < this.currentFrame().instructions().length - 1) {
      this.currentFrame().ip++;
      const ip = this.currentFrame().ip;
      const instructions = this.currentFrame().instructions();
      const op = instructions[ip];

      switch (op) {
        case Opcodes.OpConstant: {
          const constIndex = (instructions[ip + 1] << 8) | instructions[ip + 2];
          this.currentFrame().ip += 2;
          this.push(this.constants[constIndex]);
          break;
        }

        case Opcodes.OpAdd:
        case Opcodes.OpSub:
        case Opcodes.OpMul:
        case Opcodes.OpDiv:
        case Opcodes.OpMod:
        case Opcodes.OpPower: {
          this.executeBinaryOperation(op);
          break;
        }

        case Opcodes.OpPop:
          this.pop();
          break;

        case Opcodes.OpTrue:
          this.push(TRUE);
          break;

        case Opcodes.OpFalse:
          this.push(FALSE);
          break;

        case Opcodes.OpNull:
          this.push(NULL);
          break;

        case Opcodes.OpEqual:
        case Opcodes.OpNotEqual:
        case Opcodes.OpGreaterThan: {
          this.executeComparison(op);
          break;
        }

        case Opcodes.OpMinus: {
          const operand = this.pop();
          if (operand instanceof MonkeyInteger) {
            this.push(cachedInteger(-operand.value));
          } else if (operand instanceof MonkeyFloat) {
            this.push(this._track(new MonkeyFloat(-operand.value)));
          } else {
            throw new Error(`unsupported type for negation: ${operand.type()}`);
          }
          break;
        }

        case Opcodes.OpBang: {
          const operand = this.pop();
          if (operand === TRUE) this.push(FALSE);
          else if (operand === FALSE) this.push(TRUE);
          else if (operand === NULL) this.push(TRUE);
          else this.push(FALSE);
          break;
        }

        case Opcodes.OpJump: {
          const pos = (instructions[ip + 1] << 8) | instructions[ip + 2];
          this.currentFrame().ip = pos - 1; // -1 because loop will increment
          break;
        }

        case Opcodes.OpJumpNotTruthy: {
          const pos = (instructions[ip + 1] << 8) | instructions[ip + 2];
          this.currentFrame().ip += 2;
          const condition = this.pop();
          if (!this.isTruthy(condition)) {
            this.currentFrame().ip = pos - 1;
          }
          break;
        }

        case Opcodes.OpSetGlobal: {
          const globalIndex = (instructions[ip + 1] << 8) | instructions[ip + 2];
          this.currentFrame().ip += 2;
          this.globals[globalIndex] = this.pop();
          break;
        }

        case Opcodes.OpGetGlobal: {
          const globalIndex = (instructions[ip + 1] << 8) | instructions[ip + 2];
          this.currentFrame().ip += 2;
          this.push(this.globals[globalIndex]);
          break;
        }

        case Opcodes.OpArray: {
          const numElements = (instructions[ip + 1] << 8) | instructions[ip + 2];
          this.currentFrame().ip += 2;
          const elements = [];
          for (let i = this.sp - numElements; i < this.sp; i++) {
            elements.push(this.stack[i]);
          }
          this.sp -= numElements;
          this.push(this._track(new MonkeyArray(elements)));
          break;
        }

        case Opcodes.OpHash: {
          const numElements = (instructions[ip + 1] << 8) | instructions[ip + 2];
          this.currentFrame().ip += 2;
          const keyStrs = [];
          const keys = [];
          const values = [];
          for (let i = this.sp - numElements; i < this.sp; i += 2) {
            const key = this.stack[i];
            const value = this.stack[i + 1];
            keyStrs.push(objectKeyString(key));
            keys.push(key);
            values.push(value);
          }
          this.sp -= numElements;
          const shape = getShape(keyStrs);
          this.push(this._track(new ShapedHash(shape, values, keys)));
          break;
        }

        case Opcodes.OpIndex: {
          const indexIp = this.currentFrame().ip; // IP for IC keying
          const index = this.pop();
          const left = this.pop();
          this.executeIndexExpression(left, index, indexIp);
          break;
        }

        case Opcodes.OpCall: {
          const numArgs = instructions[ip + 1];
          this.currentFrame().ip += 1;
          this.executeCall(numArgs);
          break;
        }

        case Opcodes.OpReturnValue: {
          const returnValue = this.pop();
          const floor = this._frameFloor || 1;
          if (this.framesIndex <= floor) {
            // Floor return — halt this run() invocation
            // Place value where caller can find it
            this.stack[this.sp] = returnValue;
            return;
          }
          const frame = this.popFrame();
          this.sp = frame.basePointer - 1; // -1 to also pop the function
          this.push(returnValue);
          break;
        }

        case Opcodes.OpReturn: {
          const floor = this._frameFloor || 1;
          if (this.framesIndex <= floor) {
            this.stack[this.sp] = NULL;
            return;
          }
          const frame = this.popFrame();
          this.sp = frame.basePointer - 1;
          this.push(NULL);
          break;
        }

        case Opcodes.OpSetLocal: {
          const localIndex = instructions[ip + 1];
          this.currentFrame().ip += 1;
          const val = this.pop();
          const slot = this.stack[this.currentFrame().basePointer + localIndex];
          if (slot instanceof Cell) {
            slot.value = val;
          } else {
            this.stack[this.currentFrame().basePointer + localIndex] = val;
          }
          break;
        }

        case Opcodes.OpGetLocal: {
          const localIndex = instructions[ip + 1];
          this.currentFrame().ip += 1;
          const slot = this.stack[this.currentFrame().basePointer + localIndex];
          this.push(slot instanceof Cell ? slot.value : slot);
          break;
        }

        case Opcodes.OpGetBuiltin: {
          const builtinIndex = instructions[ip + 1];
          this.currentFrame().ip += 1;
          this.push(builtins[builtinIndex]);
          break;
        }

        case Opcodes.OpClosure: {
          const constIndex = (instructions[ip + 1] << 8) | instructions[ip + 2];
          const numFree = instructions[ip + 3];
          this.currentFrame().ip += 3;
          const fn = this.constants[constIndex];
          const free = [];
          for (let i = this.sp - numFree; i < this.sp; i++) {
            free.push(this.stack[i]);
          }
          this.sp -= numFree;
          const closure = new Closure(fn, free);
          // Skip GC tracking for non-escaping closures (escape analysis optimization)
          this.push(fn.escapes !== false ? this._track(closure) : closure);
          break;
        }

        case Opcodes.OpGetFree: {
          const freeIndex = instructions[ip + 1];
          this.currentFrame().ip += 1;
          const freeVal = this.currentFrame().closure.free[freeIndex];
          this.push(freeVal instanceof Cell ? freeVal.value : freeVal);
          break;
        }

        case Opcodes.OpSetFree: {
          const freeIndex = instructions[ip + 1];
          this.currentFrame().ip += 1;
          const val = this.pop();
          const freeSlot = this.currentFrame().closure.free[freeIndex];
          if (freeSlot instanceof Cell) {
            freeSlot.value = val;
          } else {
            this.currentFrame().closure.free[freeIndex] = val;
          }
          break;
        }

        case Opcodes.OpMakeCell: {
          // Wrap TOS value in a Cell
          const val = this.pop();
          this.push(this._track(new Cell(val)));
          break;
        }

        case Opcodes.OpGetLocalRaw: {
          // Get local without Cell deref (for closure capture)
          const localIndex = instructions[ip + 1];
          this.currentFrame().ip += 1;
          this.push(this.stack[this.currentFrame().basePointer + localIndex]);
          break;
        }

        case Opcodes.OpGetFreeRaw: {
          // Get free without Cell deref (for re-capture in nested closures)
          const freeIndex = instructions[ip + 1];
          this.currentFrame().ip += 1;
          this.push(this.currentFrame().closure.free[freeIndex]);
          break;
        }

        case Opcodes.OpTailCall: {
          const numArgs = instructions[ip + 1];
          this.currentFrame().ip += 1;
          const callee = this.stack[this.sp - 1 - numArgs];

          if (callee instanceof Closure) {
            if (numArgs !== callee.fn.numParameters) {
              throw new Error(`wrong number of arguments: want=${callee.fn.numParameters}, got=${numArgs}`);
            }
            // Tail call optimization: reuse current frame
            const frame = this.currentFrame();
            // Move arguments to current frame's base position
            const argStart = this.sp - numArgs;
            for (let i = 0; i < numArgs; i++) {
              this.stack[frame.basePointer + i] = this.stack[argStart + i];
            }
            // Clear non-argument locals to prevent stale Cell contamination
            for (let i = numArgs; i < callee.fn.numLocals; i++) {
              this.stack[frame.basePointer + i] = null;
            }
            // Reset stack pointer to base + numLocals
            this.sp = frame.basePointer + callee.fn.numLocals;
            // Update frame to point to new closure
            frame.closure = callee;
            frame.ip = -1; // Will be incremented to 0 by main loop
          } else if (callee instanceof MonkeyBuiltin) {
            // Builtins can't be tail-call optimized, fall through to normal call
            this.callBuiltin(callee, numArgs);
          } else {
            throw new Error(`calling non-function: ${callee?.type?.() || typeof callee}`);
          }
          break;
        }

        case Opcodes.OpCurrentClosure: {
          this.push(this.currentFrame().closure);
          break;
        }

        case Opcodes.OpDeepEqual: {
          const right = this.pop();
          const left = this.pop();
          this.push(this._deepEqual(left, right) ? TRUE : FALSE);
          break;
        }

        default:
          throw new Error(`unknown opcode: ${op}`);
      }
    }
  }

  // --- Internal helpers ---

  push(obj) {
    if (this.sp >= STACK_SIZE) throw new Error('stack overflow');
    this.stack[this.sp] = obj;
    this.sp++;
  }

  pop() {
    const obj = this.stack[this.sp - 1];
    this.sp--;
    return obj;
  }

  currentFrame() {
    return this.frames[this.framesIndex - 1];
  }

  pushFrame(frame) {
    this.frames[this.framesIndex] = frame;
    this.framesIndex++;
  }

  popFrame() {
    this.framesIndex--;
    return this.frames[this.framesIndex];
  }

  executeBinaryOperation(op) {
    const right = this.pop();
    const left = this.pop();

    if (left instanceof MonkeyInteger && right instanceof MonkeyInteger) {
      this.executeBinaryIntegerOperation(op, left, right);
    } else if ((left instanceof MonkeyFloat || left instanceof MonkeyInteger) &&
               (right instanceof MonkeyFloat || right instanceof MonkeyInteger)) {
      this.executeBinaryFloatOperation(op, left, right);
    } else if (left instanceof MonkeyString && right instanceof MonkeyString) {
      if (op === Opcodes.OpAdd) {
        this.push(this._track(internString(left.value + right.value)));
      } else {
        throw new Error(`unknown string operator: ${op}`);
      }
    } else if (left instanceof MonkeyString && right instanceof MonkeyInteger && op === Opcodes.OpMul) {
      this.push(this._track(internString(left.value.repeat(Math.max(0, right.value)))));
    } else if (left instanceof MonkeyInteger && right instanceof MonkeyString && op === Opcodes.OpMul) {
      this.push(this._track(internString(right.value.repeat(Math.max(0, left.value)))));
    } else if (left instanceof MonkeyArray && right instanceof MonkeyArray && op === Opcodes.OpAdd) {
      this.push(this._track(new MonkeyArray([...left.elements, ...right.elements])));
    } else {
      throw new Error(`unsupported types for binary operation: ${left.type()} ${right.type()}`);
    }
  }

  executeBinaryIntegerOperation(op, left, right) {
    let result;
    switch (op) {
      case Opcodes.OpAdd: result = left.value + right.value; break;
      case Opcodes.OpSub: result = left.value - right.value; break;
      case Opcodes.OpMul: result = left.value * right.value; break;
      case Opcodes.OpDiv: result = Math.trunc(left.value / right.value); break;
      case Opcodes.OpMod: result = left.value % right.value; break;
      case Opcodes.OpPower: result = left.value ** right.value; break;
      default: throw new Error(`unknown integer operator: ${op}`);
    }
    this.push(cachedInteger(result));
  }

  executeBinaryFloatOperation(op, left, right) {
    let result;
    switch (op) {
      case Opcodes.OpAdd: result = left.value + right.value; break;
      case Opcodes.OpSub: result = left.value - right.value; break;
      case Opcodes.OpMul: result = left.value * right.value; break;
      case Opcodes.OpDiv: result = left.value / right.value; break;
      case Opcodes.OpMod: result = left.value % right.value; break;
      case Opcodes.OpPower: result = left.value ** right.value; break;
      default: throw new Error(`unknown float operator: ${op}`);
    }
    this.push(this._track(new MonkeyFloat(result)));
  }

  executeComparison(op) {
    const right = this.pop();
    const left = this.pop();

    if (left instanceof MonkeyInteger && right instanceof MonkeyInteger) {
      switch (op) {
        case Opcodes.OpEqual: this.push(left.value === right.value ? TRUE : FALSE); break;
        case Opcodes.OpNotEqual: this.push(left.value !== right.value ? TRUE : FALSE); break;
        case Opcodes.OpGreaterThan: this.push(left.value > right.value ? TRUE : FALSE); break;
      }
    } else if ((left instanceof MonkeyFloat || left instanceof MonkeyInteger) &&
               (right instanceof MonkeyFloat || right instanceof MonkeyInteger)) {
      switch (op) {
        case Opcodes.OpEqual: this.push(left.value === right.value ? TRUE : FALSE); break;
        case Opcodes.OpNotEqual: this.push(left.value !== right.value ? TRUE : FALSE); break;
        case Opcodes.OpGreaterThan: this.push(left.value > right.value ? TRUE : FALSE); break;
      }
    } else if (left instanceof MonkeyString && right instanceof MonkeyString) {
      switch (op) {
        case Opcodes.OpEqual: this.push(left.value === right.value ? TRUE : FALSE); break;
        case Opcodes.OpNotEqual: this.push(left.value !== right.value ? TRUE : FALSE); break;
        case Opcodes.OpGreaterThan: this.push(left.value > right.value ? TRUE : FALSE); break;
      }
    } else {
      switch (op) {
        case Opcodes.OpEqual: this.push(this._deepEqual(left, right) ? TRUE : FALSE); break;
        case Opcodes.OpNotEqual: this.push(!this._deepEqual(left, right) ? TRUE : FALSE); break;
        default: throw new Error(`unknown operator: ${op} (${left.type()} ${right.type()})`);
      }
    }
  }

  executeIndexExpression(left, index, icIp = -1) {
    if (left instanceof MonkeyArray && index instanceof MonkeyInteger) {
      let idx = index.value;
      if (idx < 0) idx = left.elements.length + idx; // negative indexing
      if (idx < 0 || idx >= left.elements.length) {
        this.push(NULL);
      } else {
        this.push(left.elements[idx]);
      }
    } else if (left instanceof MonkeyArray && index instanceof MonkeyArray) {
      // Range/array slice: arr[start..end] → arr[start], arr[start+1], ..., arr[end]
      const indices = index.elements;
      if (indices.length >= 2) {
        const start = Math.max(0, indices[0].value);
        const end = Math.min(left.elements.length, indices[indices.length - 1].value + 1);
        this.push(this._track(new MonkeyArray(left.elements.slice(start, end))));
      } else {
        this.push(NULL);
      }
    } else if (left instanceof MonkeyString && index instanceof MonkeyInteger) {
      let idx = index.value;
      if (idx < 0) idx = left.value.length + idx; // negative indexing
      if (idx < 0 || idx >= left.value.length) {
        this.push(NULL);
      } else {
        this.push(this._track(internString(left.value[idx])));
      }
    } else if (left instanceof MonkeyString && index instanceof MonkeyArray) {
      // Range/array slice for strings: "hello"[1..3] → "el"
      const indices = index.elements;
      if (indices.length >= 2) {
        const start = Math.max(0, indices[0].value);
        const end = Math.min(left.value.length, indices[indices.length - 1].value + 1);
        this.push(this._track(internString(left.value.slice(start, end))));
      } else {
        this.push(NULL);
      }
    } else if (left instanceof ShapedHash) {
      // Fast path: shaped hash with inline cache
      const keyStr = objectKeyString(index);
      const ic = getIC(this.icTable, icIp);
      
      // IC fast path
      if (ic.shapeId === left.shape.id && ic.keyStr === keyStr) {
        ic.hits++;
        const val = ic.slotIndex >= 0 ? left.slots[ic.slotIndex] : undefined;
        this.push(val !== undefined ? val : NULL);
      } else {
        // IC miss — do full lookup
        const slot = left.shape.getSlot(keyStr);
        const val = slot >= 0 ? left.slots[slot] : undefined;
        ic.update(left.shape, keyStr, slot);
        this.push(val !== undefined ? val : NULL);
      }
    } else if (isHash(left)) {
      const key = left.pairs.get(index) || 
                  // MonkeyHash uses reference keys — need value-based lookup
                  this.hashLookup(left, index);
      this.push(key || NULL);
    } else {
      throw new Error(`index operator not supported: ${left.type()}`);
    }
  }

  hashLookup(hash, key) {
    for (const [k, v] of hash.pairs) {
      if (k instanceof MonkeyInteger && key instanceof MonkeyInteger && k.value === key.value) return v;
      if (k instanceof MonkeyString && key instanceof MonkeyString && k.value === key.value) return v;
      if (k instanceof MonkeyBoolean && key instanceof MonkeyBoolean && k.value === key.value) return v;
      if (k === key) return v;
    }
    return null;
  }

  executeCall(numArgs) {
    const callee = this.stack[this.sp - 1 - numArgs];

    if (callee instanceof Closure) {
      this.callClosure(callee, numArgs);
    } else if (callee instanceof MonkeyBuiltin) {
      this.callBuiltin(callee, numArgs);
    } else {
      throw new Error(`calling non-function: ${callee?.type?.() || typeof callee}`);
    }
  }

  callClosure(closure, numArgs) {
    const numParams = closure.fn.numParameters;
    const hasRest = closure.fn.hasRestParam;
    const minParams = closure.fn.minParams !== undefined ? closure.fn.minParams : numParams;
    
    if (hasRest) {
      // Rest param: need at least minParams regular args
      if (numArgs < minParams) {
        throw new Error(`wrong number of arguments: want>=${minParams}, got=${numArgs}`);
      }
      
      // Fill in defaults for missing regular params
      if (numArgs < numParams) {
        const defaults = closure.fn.defaults || [];
        for (let i = numArgs; i < numParams; i++) {
          this.stack[this.sp] = defaults[i] || NULL;
          this.sp++;
        }
        numArgs = numParams;
      }
      
      // Pack extra args into an array for the rest param
      const restStart = this.sp - numArgs + numParams;
      const restEnd = this.sp;
      const restElements = [];
      for (let i = restStart; i < restEnd; i++) {
        restElements.push(this.stack[i]);
      }
      const restArray = this._track(new MonkeyArray(restElements));
      
      // Rewrite stack: regular params + rest array
      this.sp = this.sp - numArgs + numParams;
      this.stack[this.sp] = restArray;
      this.sp++;
      
      const frame = new Frame(closure, this.sp - numParams - 1);
      this.pushFrame(frame);
      const base = frame.basePointer;
      for (let i = numParams + 1; i < closure.fn.numLocals; i++) {
        this.stack[base + i] = null;
      }
      this.sp = frame.basePointer + closure.fn.numLocals;
    } else {
      // No rest param
      if (numArgs < minParams) {
        throw new Error(`wrong number of arguments: want=${numParams}, got=${numArgs}`);
      }
      
      // Fill in defaults for missing params
      if (numArgs < numParams) {
        const defaults = closure.fn.defaults || [];
        for (let i = numArgs; i < numParams; i++) {
          this.stack[this.sp] = defaults[i] || NULL;
          this.sp++;
        }
        numArgs = numParams;
      } else if (numArgs > numParams) {
        throw new Error(`wrong number of arguments: want=${numParams}, got=${numArgs}`);
      }

      const frame = new Frame(closure, this.sp - numArgs);
      this.pushFrame(frame);
      const base = frame.basePointer;
      for (let i = numArgs; i < closure.fn.numLocals; i++) {
        this.stack[base + i] = null;
      }
      this.sp = frame.basePointer + closure.fn.numLocals;
    }
  }

  callBuiltin(builtin, numArgs) {
    const args = [];
    for (let i = this.sp - numArgs; i < this.sp; i++) {
      args.push(this.stack[i]);
    }
    this.sp -= numArgs + 1; // pop args + function

    // VM-aware builtins receive the VM as first arg (for callClosureSync)
    const result = builtin.needsVM ? builtin.fn(this, ...args) : builtin.fn(...args);
    this.push(result != null ? result : NULL);
  }

  /**
   * Synchronously call a compiled closure from native code and return the result.
   * This enables native builtins to invoke monkey-lang callbacks (e.g., map/filter/reduce).
   * Works by pushing a closure frame, running the VM loop until that frame returns,
   * then returning the result value.
   */
  /**
   * Synchronously call a compiled closure from native code and return the result.
   * This enables native builtins to invoke monkey-lang callbacks (e.g., map/filter/reduce).
   * Pushes a closure frame and re-enters run() with a frame floor so it returns
   * when the closure completes.
   */
  callClosureSync(closure, args) {
    // Push the closure and args onto the stack (mimicking a call expression)
    this.push(closure);
    for (const arg of args) {
      this.push(arg);
    }
    // Set up the closure frame (reuses existing callClosure with all param handling)
    this.callClosure(closure, args.length);
    
    // Remember the frame we pushed so we can detect its return
    const callFrameIndex = this.framesIndex;
    const callBasePointer = this.currentFrame().basePointer;
    
    // Save and set the frame floor — run() will stop when a return reaches this level
    const savedFloor = this._frameFloor || 1;
    this._frameFloor = callFrameIndex;
    
    try {
      this.run();
    } finally {
      this._frameFloor = savedFloor;
    }
    
    // After run() returns at the floor:
    // - OpReturnValue placed the value at stack[sp] without popping the frame
    // - We need to: read the value, pop the frame, restore sp
    const returnValue = this.stack[this.sp] || NULL;
    this.framesIndex = callFrameIndex - 1;
    this.sp = callBasePointer - 1; // -1 to also pop the closure reference
    return returnValue;
  }

  isTruthy(obj) {
    if (obj instanceof MonkeyBoolean) return obj.value;
    if (obj === NULL) return false;
    return true; // integers are truthy
  }

  /**
   * Deep structural equality comparison.
   * Compares arrays/hashes by value, not reference.
   */
  _deepEqual(a, b) {
    if (a === b) return true; // same reference (includes TRUE/FALSE/NULL singletons)
    if (a === null || b === null || a === undefined || b === undefined) return false;
    
    // Integer/Float comparison
    if ((a instanceof MonkeyInteger || a instanceof MonkeyFloat) &&
        (b instanceof MonkeyInteger || b instanceof MonkeyFloat)) {
      return a.value === b.value;
    }
    
    // String comparison
    if (a instanceof MonkeyString && b instanceof MonkeyString) {
      return a.value === b.value;
    }
    
    // Boolean comparison
    if (a instanceof MonkeyBoolean && b instanceof MonkeyBoolean) {
      return a.value === b.value;
    }
    
    // Array comparison (recursive)
    if (a instanceof MonkeyArray && b instanceof MonkeyArray) {
      if (a.elements.length !== b.elements.length) return false;
      for (let i = 0; i < a.elements.length; i++) {
        if (!this._deepEqual(a.elements[i], b.elements[i])) return false;
      }
      return true;
    }
    
    // Hash comparison (recursive)
    if (isHash(a) && isHash(b)) {
      if (a.pairs.size !== b.pairs.size) return false;
      for (const [ak, av] of a.pairs) {
        // Find matching key in b
        let found = false;
        for (const [bk, bv] of b.pairs) {
          if (this._deepEqual(ak, bk)) {
            if (!this._deepEqual(av, bv)) return false;
            found = true;
            break;
          }
        }
        if (!found) return false;
      }
      return true;
    }
    
    // Null comparison
    if (a === NULL && b === NULL) return true;
    
    return false;
  }
}
