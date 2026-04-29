// Monkey Language Tree-Walking Evaluator

import {
  MonkeyInteger, MonkeyFloat, MonkeyString, MonkeyBoolean, MonkeyReturnValue, MonkeyError,
  MonkeyFunction, MonkeyArray, MonkeyHash, MonkeyBuiltin, MonkeyThrown,
  MonkeyBreak, MonkeyContinue, MonkeyResult, MonkeyEnum,
  MonkeyGeneratorDef, MonkeyGenerator, MonkeyYield,
  MonkeyClass, MonkeyInstance,
  Environment, TRUE, FALSE, NULL, OBJ, internString,
} from './object.js';

import * as AST from './ast.js';
import { getModule } from './modules.js';
import { ModuleLoader, getModuleLoader } from './module-loader.js';

// --- Builtins ---

const builtins = new Map([
  ['len', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    const arg = args[0];
    if (arg instanceof MonkeyString) return new MonkeyInteger(arg.value.length);
    if (arg instanceof MonkeyArray) return new MonkeyInteger(arg.elements.length);
    if (arg instanceof MonkeyHash) return new MonkeyInteger(arg.pairs.size);
    // __len__ protocol for instances
    if (arg.get && typeof arg.get === 'function') {
      const lenFn = arg.get('__len__');
      if (lenFn && lenFn instanceof MonkeyFunction) {
        return callMethod(arg, lenFn, []);
      }
    }
    return newError(`argument to \`len\` not supported, got ${arg.type()}`);
  })],
  ['first', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    if (args[0].type() !== OBJ.ARRAY) return newError(`argument to \`first\` must be ARRAY, got ${args[0].type()}`);
    return args[0].elements.length > 0 ? args[0].elements[0] : NULL;
  })],
  ['last', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    if (args[0].type() !== OBJ.ARRAY) return newError(`argument to \`last\` must be ARRAY, got ${args[0].type()}`);
    const els = args[0].elements;
    return els.length > 0 ? els[els.length - 1] : NULL;
  })],
  ['rest', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    if (args[0].type() !== OBJ.ARRAY) return newError(`argument to \`rest\` must be ARRAY, got ${args[0].type()}`);
    const els = args[0].elements;
    return els.length > 0 ? new MonkeyArray(els.slice(1)) : NULL;
  })],
  ['push', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    if (args[0].type() !== OBJ.ARRAY) return newError(`argument to \`push\` must be ARRAY, got ${args[0].type()}`);
    return new MonkeyArray([...args[0].elements, args[1]]);
  })],
  ['puts', new MonkeyBuiltin((...args) => {
    for (const arg of args) {
      if (arg instanceof MonkeyInstance) {
        const toStringFn = arg.get('toString');
        if (toStringFn && toStringFn instanceof MonkeyFunction) {
          const result = callMethod(arg, toStringFn, []);
          console.log(result instanceof MonkeyString ? result.value : result.inspect());
          continue;
        }
      }
      console.log(arg.inspect());
    }
    return NULL;
  })],
  ['split', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    if (!(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyString))
      return newError(`arguments to \`split\` must be STRING`);
    return new MonkeyArray(args[0].value.split(args[1].value).map(s => new MonkeyString(s)));
  })],
  ['join', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    if (!(args[0] instanceof MonkeyArray) || !(args[1] instanceof MonkeyString))
      return newError(`arguments to \`join\` must be (ARRAY, STRING)`);
    return new MonkeyString(args[0].elements.map(e => e instanceof MonkeyString ? e.value : e.inspect()).join(args[1].value));
  })],
  ['trim', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyString)) return newError(`argument to \`trim\` must be STRING`);
    return new MonkeyString(args[0].value.trim());
  })],
  ['str_contains', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    if (!(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyString))
      return newError(`arguments to \`str_contains\` must be STRING`);
    return args[0].value.includes(args[1].value) ? TRUE : FALSE;
  })],
  ['substr', new MonkeyBuiltin((...args) => {
    if (args.length < 2 || args.length > 3) return newError(`wrong number of arguments. got=${args.length}, want=2 or 3`);
    if (!(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyInteger))
      return newError(`arguments to \`substr\` must be (STRING, INT[, INT])`);
    const str = args[0].value;
    const start = args[1].value;
    const end = args.length === 3 && args[2] instanceof MonkeyInteger ? args[2].value : str.length;
    return new MonkeyString(str.slice(start, end));
  })],
  ['replace', new MonkeyBuiltin((...args) => {
    if (args.length !== 3) return newError(`wrong number of arguments. got=${args.length}, want=3`);
    if (!(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyString) || !(args[2] instanceof MonkeyString))
      return newError(`arguments to \`replace\` must be STRING`);
    return new MonkeyString(args[0].value.split(args[1].value).join(args[2].value));
  })],
  ['int', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    if (args[0] instanceof MonkeyInteger) return args[0];
    if (args[0] instanceof MonkeyString) {
      const n = parseInt(args[0].value);
      if (isNaN(n)) return NULL;
      return new MonkeyInteger(n);
    }
    return newError(`cannot convert ${args[0].type()} to INT`);
  })],
  ['str', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    if (args[0] instanceof MonkeyString) return args[0];
    // Check for toString method on instances
    if (args[0] instanceof MonkeyInstance) {
      const toStringFn = args[0].get('toString');
      if (toStringFn && toStringFn instanceof MonkeyFunction) {
        const result = callMethod(args[0], toStringFn, []);
        if (result instanceof MonkeyString) return result;
        return new MonkeyString(result.inspect());
      }
    }
    return new MonkeyString(args[0].inspect());
  })],
  ['type', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    return new MonkeyString(args[0].type());
  })],
  ['isinstance', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    const instance = args[0];
    const klass = args[1];
    if (!(instance instanceof MonkeyInstance) || !(klass instanceof MonkeyClass)) return FALSE;
    let cls = instance.klass;
    while (cls) {
      if (cls === klass) return TRUE;
      cls = cls.superClass;
    }
    return FALSE;
  })],
  ['hasattr', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    if (!(args[0] instanceof MonkeyInstance)) return FALSE;
    if (!(args[1] instanceof MonkeyString)) return newError('second argument must be STRING');
    return args[0].get(args[1].value) !== null ? TRUE : FALSE;
  })],
  ['getattr', new MonkeyBuiltin((...args) => {
    if (args.length < 2 || args.length > 3) return newError(`wrong number of arguments. got=${args.length}, want=2 or 3`);
    if (!(args[0] instanceof MonkeyInstance)) return args.length === 3 ? args[2] : NULL;
    if (!(args[1] instanceof MonkeyString)) return newError('second argument must be STRING');
    const val = args[0].get(args[1].value);
    if (val === null) return args.length === 3 ? args[2] : NULL;
    if (val instanceof MonkeyFunction) {
      const instance = args[0];
      const method = val;
      return new MonkeyBuiltin((...callArgs) => callMethod(instance, method, callArgs));
    }
    return val;
  })],
  ['setattr', new MonkeyBuiltin((...args) => {
    if (args.length !== 3) return newError(`wrong number of arguments. got=${args.length}, want=3`);
    if (!(args[0] instanceof MonkeyInstance)) return newError('first argument must be INSTANCE');
    if (!(args[1] instanceof MonkeyString)) return newError('second argument must be STRING');
    args[0].set(args[1].value, args[2]);
    return NULL;
  })],
  ['classname', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    if (args[0] instanceof MonkeyInstance) return new MonkeyString(args[0].klass.name);
    if (args[0] instanceof MonkeyClass) return new MonkeyString(args[0].name);
    return new MonkeyString(args[0].type());
  })],
  ['ord', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || args[0].type() !== OBJ.STRING) return newError('ord requires one string argument');
    return new MonkeyInteger(args[0].value.charCodeAt(0));
  })],
  ['char', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || args[0].type() !== OBJ.INTEGER) return newError('char requires one integer argument');
    return new MonkeyString(String.fromCharCode(args[0].value));
  })],
  ['abs', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || args[0].type() !== OBJ.INTEGER) return newError('abs requires one integer argument');
    return new MonkeyInteger(Math.abs(args[0].value));
  })],
  ['upper', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || args[0].type() !== OBJ.STRING) return newError('upper requires one string argument');
    return new MonkeyString(args[0].value.toUpperCase());
  })],
  ['lower', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || args[0].type() !== OBJ.STRING) return newError('lower requires one string argument');
    return new MonkeyString(args[0].value.toLowerCase());
  })],
  ['indexOf', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    if (args[0].type() === OBJ.STRING && args[1].type() === OBJ.STRING) {
      return new MonkeyInteger(args[0].value.indexOf(args[1].value));
    }
    return newError('indexOf requires two string arguments');
  })],
  ['startsWith', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    return nativeBoolToBooleanObject(args[0].value.startsWith(args[1].value));
  })],
  ['endsWith', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    return nativeBoolToBooleanObject(args[0].value.endsWith(args[1].value));
  })],
  ['keys', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || args[0].type() !== OBJ.HASH) return newError('keys requires one hash argument');
    const arr = [];
    for (const [, {key}] of args[0].pairs) arr.push(key);
    return new MonkeyArray(arr);
  })],
  ['values', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || args[0].type() !== OBJ.HASH) return newError('values requires one hash argument');
    const arr = [];
    for (const [, {value}] of args[0].pairs) arr.push(value);
    return new MonkeyArray(arr);
  })],
  ['entries', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || args[0].type() !== OBJ.HASH) return newError('entries requires one hash argument');
    const arr = [];
    for (const [, {key, value}] of args[0].pairs) arr.push(new MonkeyArray([key, value]));
    return new MonkeyArray(arr);
  })],
  ['fromEntries', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return newError('fromEntries requires one array argument');
    const pairs = new Map();
    for (const entry of args[0].elements) {
      if (!(entry instanceof MonkeyArray) || entry.elements.length < 2) continue;
      const key = entry.elements[0];
      const value = entry.elements[1];
      const hashKey = key.fastHashKey ? key.fastHashKey() : (key.hashKey ? key.hashKey() : null);
      if (hashKey) pairs.set(hashKey, { key, value });
    }
    return new MonkeyHash(pairs);
  })],
  ['groupBy', new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || !(args[0] instanceof MonkeyArray)) return newError('groupBy requires an array and a function');
    const arr = args[0];
    const fn = args[1];
    const groups = new Map();
    for (const elem of arr.elements) {
      const key = applyFunction(fn, [elem]);
      if (isError(key)) return key;
      const hashKey = key.fastHashKey ? key.fastHashKey() : (key.hashKey ? key.hashKey() : null);
      if (!hashKey) return newError('groupBy key function must return a hashable value');
      if (groups.has(hashKey)) {
        groups.get(hashKey).value.elements.push(elem);
      } else {
        groups.set(hashKey, { key, value: new MonkeyArray([elem]) });
      }
    }
    return new MonkeyHash(groups);
  })],
  ['zip', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError('zip requires two array arguments');
    const keys = args[0];
    const values = args[1];
    if (!(keys instanceof MonkeyArray) || !(values instanceof MonkeyArray)) {
      return newError('zip requires two array arguments');
    }
    const pairs = new Map();
    const len = Math.min(keys.elements.length, values.elements.length);
    for (let i = 0; i < len; i++) {
      const key = keys.elements[i];
      const value = values.elements[i];
      const hashKey = key.fastHashKey ? key.fastHashKey() : (key.hashKey ? key.hashKey() : null);
      if (hashKey) pairs.set(hashKey, { key, value });
    }
    return new MonkeyHash(pairs);
  })],
  ['delete', new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || args[0].type() !== OBJ.HASH) return newError('delete requires a hash and a key');
    const hash = args[0];
    const key = args[1];
    const hashKey = key.fastHashKey ? key.fastHashKey() : (key.hashKey ? key.hashKey() : null);
    if (hashKey === null) return newError('unusable as hash key: ' + key.type());
    const newPairs = new Map(hash.pairs);
    newPairs.delete(hashKey);
    return new MonkeyHash(newPairs);
  })],
  ['has', new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || args[0].type() !== OBJ.HASH) return newError('has requires a hash and a key');
    const hash = args[0];
    const key = args[1];
    const hashKey = key.fastHashKey ? key.fastHashKey() : (key.hashKey ? key.hashKey() : null);
    if (hashKey === null) return newError('unusable as hash key: ' + key.type());
    return hash.pairs.has(hashKey) ? TRUE : FALSE;
  })],
  ['merge', new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || args[0].type() !== OBJ.HASH || args[1].type() !== OBJ.HASH) {
      return newError('merge requires two hash arguments');
    }
    const merged = new Map(args[0].pairs);
    for (const [k, v] of args[1].pairs) {
      merged.set(k, v);
    }
    return new MonkeyHash(merged);
  })],
  ['sort', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return newError('sort requires one array argument');
    const sorted = [...args[0].elements].sort((a, b) => {
      if (a instanceof MonkeyInteger && b instanceof MonkeyInteger) return a.value - b.value;
      return a.inspect().localeCompare(b.inspect());
    });
    return new MonkeyArray(sorted);
  })],
  ['reverse', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return newError('reverse requires one array argument');
    return new MonkeyArray([...args[0].elements].reverse());
  })],
  ['flat', new MonkeyBuiltin((...args) => {
    if (args.length < 1 || args.length > 2) return newError('flat requires 1-2 arguments');
    if (!(args[0] instanceof MonkeyArray)) return newError(`argument to flat must be ARRAY`);
    const depth = args.length === 2 && args[1] instanceof MonkeyInteger ? args[1].value : 1;
    const flatten = (arr, d) => {
      const result = [];
      for (const elem of arr.elements) {
        if (d > 0 && elem instanceof MonkeyArray) {
          result.push(...flatten(elem, d - 1));
        } else {
          result.push(elem);
        }
      }
      return result;
    };
    return new MonkeyArray(flatten(args[0], depth));
  })],
  ['flatMap', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError('flatMap requires 2 arguments');
    if (!(args[0] instanceof MonkeyArray)) return newError(`first argument to flatMap must be ARRAY`);
    const fn = args[1];
    const result = [];
    for (const elem of args[0].elements) {
      const mapped = applyFunction(fn, [elem]);
      if (isError(mapped)) return mapped;
      if (mapped instanceof MonkeyArray) {
        result.push(...mapped.elements);
      } else {
        result.push(mapped);
      }
    }
    return new MonkeyArray(result);
  })],
  ['range', new MonkeyBuiltin((...args) => {
    if (args.length < 1 || args.length > 3) return newError('range requires 1-3 arguments');
    let start = 0, end, step = 1;
    if (args.length === 1) {
      end = args[0] instanceof MonkeyInteger ? args[0].value : 0;
    } else if (args.length === 2) {
      start = args[0] instanceof MonkeyInteger ? args[0].value : 0;
      end = args[1] instanceof MonkeyInteger ? args[1].value : 0;
    } else {
      start = args[0] instanceof MonkeyInteger ? args[0].value : 0;
      end = args[1] instanceof MonkeyInteger ? args[1].value : 0;
      step = args[2] instanceof MonkeyInteger ? args[2].value : 1;
    }
    if (step === 0) return newError('range step cannot be 0');
    const result = [];
    if (step > 0) {
      for (let i = start; i < end; i += step) result.push(new MonkeyInteger(i));
    } else {
      for (let i = start; i > end; i += step) result.push(new MonkeyInteger(i));
    }
    return new MonkeyArray(result);
  })],
  ['type', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError('type requires 1 argument');
    const val = args[0];
    if (val === NULL) return new MonkeyString('null');
    if (val instanceof MonkeyInteger) return new MonkeyString('integer');
    if (val instanceof MonkeyString) return new MonkeyString('string');
    if (val instanceof MonkeyBoolean) return new MonkeyString('boolean');
    if (val instanceof MonkeyArray) return new MonkeyString('array');
    if (val instanceof MonkeyHash) return new MonkeyString('hash');
    if (val instanceof MonkeyFunction || val instanceof MonkeyBuiltin) return new MonkeyString('function');
    return new MonkeyString(val.type ? val.type().toLowerCase() : 'unknown');
  })],
  ['partition', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError('partition requires 2 arguments');
    const fn = args[1];
    if (args[0] instanceof MonkeyArray) {
      const yes = [], no = [];
      for (const elem of args[0].elements) {
        const result = applyFunction(fn, [elem]);
        if (isError(result)) return result;
        (isTruthy(result) ? yes : no).push(elem);
      }
      return new MonkeyArray([new MonkeyArray(yes), new MonkeyArray(no)]);
    }
    if (args[0] instanceof MonkeyHash) {
      const yes = new Map(), no = new Map();
      for (const [hashKey, { key, value }] of args[0].pairs) {
        const result = applyFunction(fn, [key, value]);
        if (isError(result)) return result;
        (isTruthy(result) ? yes : no).set(hashKey, { key, value });
      }
      return new MonkeyArray([new MonkeyHash(yes), new MonkeyHash(no)]);
    }
    return newError('partition requires array or hash');
  })],
  ['contains', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError('contains requires two arguments');
    if (args[0] instanceof MonkeyArray) {
      return nativeBoolToBooleanObject(args[0].elements.some(el => el.inspect() === args[1].inspect()));
    }
    if (args[0] instanceof MonkeyString && args[1] instanceof MonkeyString) {
      return nativeBoolToBooleanObject(args[0].value.includes(args[1].value));
    }
    return newError('contains not supported for ' + args[0].type());
  })],
  ['sum', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return newError('sum requires one array argument');
    let total = 0;
    for (const el of args[0].elements) { if (el instanceof MonkeyInteger) total += el.value; }
    return new MonkeyInteger(total);
  })],
  ['max', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return newError('max requires one array argument');
    let m = -Infinity;
    for (const el of args[0].elements) { if (el instanceof MonkeyInteger && el.value > m) m = el.value; }
    return m === -Infinity ? NULL : new MonkeyInteger(m);
  })],
  ['min', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return newError('min requires one array argument');
    let m = Infinity;
    for (const el of args[0].elements) { if (el instanceof MonkeyInteger && el.value < m) m = el.value; }
    return m === Infinity ? NULL : new MonkeyInteger(m);
  })],
  ['range', new MonkeyBuiltin((...args) => {
    let start = 0, end, step = 1;
    if (args.length === 1) { end = args[0].value; }
    else if (args.length === 2) { start = args[0].value; end = args[1].value; }
    else if (args.length === 3) { start = args[0].value; end = args[1].value; step = args[2].value; }
    else return newError('range requires 1-3 arguments');
    const result = [];
    if (step > 0) for (let i = start; i < end; i += step) result.push(new MonkeyInteger(i));
    else if (step < 0) for (let i = start; i > end; i += step) result.push(new MonkeyInteger(i));
    return new MonkeyArray(result);
  })],
  ['flat', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return newError('flat requires one array argument');
    const result = [];
    for (const el of args[0].elements) {
      if (el instanceof MonkeyArray) result.push(...el.elements);
      else result.push(el);
    }
    return new MonkeyArray(result);
  })],
  ['zip', new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || !(args[0] instanceof MonkeyArray) || !(args[1] instanceof MonkeyArray))
      return newError('zip requires two array arguments');
    const len = Math.min(args[0].elements.length, args[1].elements.length);
    const result = [];
    for (let i = 0; i < len; i++) result.push(new MonkeyArray([args[0].elements[i], args[1].elements[i]]));
    return new MonkeyArray(result);
  })],
  ['enumerate', new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray)) return newError('enumerate requires one array argument');
    const result = [];
    for (let i = 0; i < args[0].elements.length; i++) result.push(new MonkeyArray([new MonkeyInteger(i), args[0].elements[i]]));
    return new MonkeyArray(result);
  })],
  ['Ok', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    return new MonkeyResult(true, args[0]);
  })],
  ['Err', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    return new MonkeyResult(false, args[0]);
  })],
  ['is_ok', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyResult)) return FALSE;
    return args[0].isOk ? TRUE : FALSE;
  })],
  ['is_err', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyResult)) return FALSE;
    return args[0].isOk ? FALSE : TRUE;
  })],
  ['unwrap', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyResult)) return newError('unwrap requires a Result');
    if (!args[0].isOk) return newError('unwrap called on Err: ' + args[0].value.inspect());
    return args[0].value;
  })],
  ['unwrap_or', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    if (!(args[0] instanceof MonkeyResult)) return args[0];
    return args[0].isOk ? args[0].value : args[1];
  })],
  ['map', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    const collection = args[0];
    const fn = args[1];
    if (collection instanceof MonkeyArray) {
      const result = new Array(collection.elements.length);
      for (let i = 0; i < collection.elements.length; i++) {
        result[i] = applyFunction(fn, [collection.elements[i]]);
        if (isError(result[i])) return result[i];
      }
      return new MonkeyArray(result);
    }
    if (collection instanceof MonkeyHash) {
      const newPairs = new Map();
      for (const [hashKey, { key, value }] of collection.pairs) {
        const newVal = applyFunction(fn, [key, value]);
        if (isError(newVal)) return newVal;
        newPairs.set(hashKey, { key, value: newVal });
      }
      return new MonkeyHash(newPairs);
    }
    return newError(`first argument to map must be ARRAY or HASH, got ${collection.type()}`);
  })],
  ['filter', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    const collection = args[0];
    const fn = args[1];
    if (collection instanceof MonkeyArray) {
      const result = [];
      for (const el of collection.elements) {
        const val = applyFunction(fn, [el]);
        if (isError(val)) return val;
        if (isTruthy(val)) result.push(el);
      }
      return new MonkeyArray(result);
    }
    if (collection instanceof MonkeyHash) {
      const newPairs = new Map();
      for (const [hashKey, { key, value }] of collection.pairs) {
        const keep = applyFunction(fn, [key, value]);
        if (isError(keep)) return keep;
        if (isTruthy(keep)) newPairs.set(hashKey, { key, value });
      }
      return new MonkeyHash(newPairs);
    }
    return newError(`first argument to filter must be ARRAY or HASH, got ${collection.type()}`);
  })],
  ['reduce', new MonkeyBuiltin((...args) => {
    if (args.length < 2 || args.length > 3) return newError(`wrong number of arguments. got=${args.length}, want=2 or 3`);
    const collection = args[0];
    const fn = args[1];
    if (collection instanceof MonkeyArray) {
      let acc = args.length === 3 ? args[2] : (collection.elements.length > 0 ? collection.elements[0] : NULL);
      const startIdx = args.length === 3 ? 0 : 1;
      for (let i = startIdx; i < collection.elements.length; i++) {
        acc = applyFunction(fn, [acc, collection.elements[i]]);
        if (isError(acc)) return acc;
      }
      return acc;
    }
    if (collection instanceof MonkeyHash) {
      if (args.length < 3) return newError('reduce on hash requires an initial value (3 arguments)');
      let acc = args[2];
      for (const [, { key, value }] of collection.pairs) {
        acc = applyFunction(fn, [acc, key, value]);
        if (isError(acc)) return acc;
      }
      return acc;
    }
    return newError(`first argument to reduce must be ARRAY or HASH, got ${collection.type()}`);
  })],
  ['find', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    const collection = args[0];
    const fn = args[1];
    if (collection instanceof MonkeyArray) {
      for (const el of collection.elements) {
        const val = applyFunction(fn, [el]);
        if (isError(val)) return val;
        if (isTruthy(val)) return el;
      }
      return NULL;
    }
    if (collection instanceof MonkeyHash) {
      for (const [, { key, value }] of collection.pairs) {
        const val = applyFunction(fn, [key, value]);
        if (isError(val)) return val;
        if (isTruthy(val)) return key;
      }
      return NULL;
    }
    return newError(`first argument to find must be ARRAY or HASH, got ${collection.type()}`);
  })],
  ['any', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    const collection = args[0];
    const fn = args[1];
    if (collection instanceof MonkeyArray) {
      for (const el of collection.elements) {
        const val = applyFunction(fn, [el]);
        if (isError(val)) return val;
        if (isTruthy(val)) return TRUE;
      }
      return FALSE;
    }
    if (collection instanceof MonkeyHash) {
      for (const [, { key, value }] of collection.pairs) {
        const val = applyFunction(fn, [key, value]);
        if (isError(val)) return val;
        if (isTruthy(val)) return TRUE;
      }
      return FALSE;
    }
    return newError(`first argument to any must be ARRAY or HASH, got ${collection.type()}`);
  })],
  ['all', new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return newError(`wrong number of arguments. got=${args.length}, want=2`);
    const collection = args[0];
    const fn = args[1];
    if (collection instanceof MonkeyArray) {
      for (const el of collection.elements) {
        const val = applyFunction(fn, [el]);
        if (isError(val)) return val;
        if (!isTruthy(val)) return FALSE;
      }
      return TRUE;
    }
    if (collection instanceof MonkeyHash) {
      for (const [, { key, value }] of collection.pairs) {
        const val = applyFunction(fn, [key, value]);
        if (isError(val)) return val;
        if (!isTruthy(val)) return FALSE;
      }
      return TRUE;
    }
    return newError(`first argument to all must be ARRAY or HASH, got ${collection.type()}`);
  })],
  ['sort', new MonkeyBuiltin((...args) => {
    if (args.length < 1 || args.length > 2) return newError(`wrong number of arguments. got=${args.length}, want=1 or 2`);
    const arr = args[0];
    if (!(arr instanceof MonkeyArray)) return newError(`first argument to sort must be ARRAY, got ${arr.type()}`);
    const sorted = [...arr.elements];
    if (args.length === 2) {
      // Custom comparator
      const fn = args[1];
      sorted.sort((a, b) => {
        const result = applyFunction(fn, [a, b]);
        return result.value || 0;
      });
    } else {
      // Default: numeric/string comparison
      sorted.sort((a, b) => {
        if (a.value < b.value) return -1;
        if (a.value > b.value) return 1;
        return 0;
      });
    }
    return new MonkeyArray(sorted);
  })],
  ['reverse', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    const arr = args[0];
    if (arr instanceof MonkeyArray) return new MonkeyArray([...arr.elements].reverse());
    if (arr instanceof MonkeyString) return new MonkeyString(arr.value.split('').reverse().join(''));
    return newError(`argument to reverse not supported, got ${arr.type()}`);
  })],
  ['range', new MonkeyBuiltin((...args) => {
    if (args.length < 1 || args.length > 3) return newError(`wrong number of arguments. got=${args.length}, want=1-3`);
    let start = 0, stop, step = 1;
    if (args.length === 1) {
      stop = args[0].value;
    } else if (args.length === 2) {
      start = args[0].value;
      stop = args[1].value;
    } else {
      start = args[0].value;
      stop = args[1].value;
      step = args[2].value;
    }
    const result = [];
    if (step > 0) {
      for (let i = start; i < stop; i += step) result.push(new MonkeyInteger(i));
    } else if (step < 0) {
      for (let i = start; i > stop; i += step) result.push(new MonkeyInteger(i));
    }
    return new MonkeyArray(result);
  })],
  ['zip', new MonkeyBuiltin((...args) => {
    if (args.length < 2) return newError('zip requires at least 2 arguments');
    for (const arg of args) {
      if (!(arg instanceof MonkeyArray)) return newError('all arguments to zip must be arrays');
    }
    const minLen = Math.min(...args.map(a => a.elements.length));
    const result = [];
    for (let i = 0; i < minLen; i++) {
      result.push(new MonkeyArray(args.map(a => a.elements[i])));
    }
    return new MonkeyArray(result);
  })],
  ['enumerate', new MonkeyBuiltin((...args) => {
    if (args.length < 1 || args.length > 2) return newError(`wrong number of arguments. got=${args.length}, want=1 or 2`);
    if (!(args[0] instanceof MonkeyArray)) return newError('first argument must be ARRAY');
    const startIdx = args.length === 2 ? args[1].value : 0;
    const result = [];
    for (let i = 0; i < args[0].elements.length; i++) {
      result.push(new MonkeyArray([new MonkeyInteger(i + startIdx), args[0].elements[i]]));
    }
    return new MonkeyArray(result);
  })],
  ['flatten', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyArray)) return newError('argument must be ARRAY');
    const result = [];
    for (const el of args[0].elements) {
      if (el instanceof MonkeyArray) {
        result.push(...el.elements);
      } else {
        result.push(el);
      }
    }
    return new MonkeyArray(result);
  })],
  ['sum', new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return newError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyArray)) return newError('argument must be ARRAY');
    let total = 0;
    for (const el of args[0].elements) {
      if (el instanceof MonkeyInteger || el instanceof MonkeyFloat) total += el.value;
    }
    return Number.isInteger(total) ? new MonkeyInteger(total) : new MonkeyFloat(total);
  })],
  ['min', new MonkeyBuiltin((...args) => {
    if (args.length === 1 && args[0] instanceof MonkeyArray) {
      let minVal = Infinity;
      for (const el of args[0].elements) {
        if (el.value < minVal) minVal = el.value;
      }
      return Number.isInteger(minVal) ? new MonkeyInteger(minVal) : new MonkeyFloat(minVal);
    }
    if (args.length === 2) {
      return args[0].value <= args[1].value ? args[0] : args[1];
    }
    return newError('min expects 1 array or 2 values');
  })],
  ['max', new MonkeyBuiltin((...args) => {
    if (args.length === 1 && args[0] instanceof MonkeyArray) {
      let maxVal = -Infinity;
      for (const el of args[0].elements) {
        if (el.value > maxVal) maxVal = el.value;
      }
      return Number.isInteger(maxVal) ? new MonkeyInteger(maxVal) : new MonkeyFloat(maxVal);
    }
    if (args.length === 2) {
      return args[0].value >= args[1].value ? args[0] : args[1];
    }
    return newError('max expects 1 array or 2 values');
  })],
]);

// --- Helpers ---

function newError(msg) { return new MonkeyError(msg); }
function isError(obj) { return obj && (obj.type() === OBJ.ERROR || obj instanceof MonkeyThrown); }
function nativeBoolToBooleanObject(val) { return val ? TRUE : FALSE; }
function isTruthy(obj) {
  if (obj === NULL || obj === FALSE) return false;
  if (obj === TRUE) return true;
  return true;
}

// --- Eval ---

export function monkeyEval(node, env) {
  // Program
  if (node instanceof AST.Program) return evalProgram(node.statements, env);

  // Statements
  if (node instanceof AST.ExpressionStatement) return monkeyEval(node.expression, env);
  if (node instanceof AST.BlockStatement) return evalBlockStatement(node.statements, env);
  if (node instanceof AST.LetStatement) {
    const val = monkeyEval(node.value, env);
    if (isError(val)) return val;
    env.set(node.name.value, val, node.isConst);
    return undefined;
  }
  if (node instanceof AST.DestructuringLet) {
    const val = monkeyEval(node.value, env);
    if (isError(val)) return val;
    if (val instanceof MonkeyArray) {
      for (let i = 0; i < node.names.length; i++) {
        if (node.names[i]) {
          env.set(node.names[i].value, i < val.elements.length ? val.elements[i] : NULL);
        }
      }
    }
    return undefined;
  }
  if (node instanceof AST.HashDestructuringLet) {
    const val = monkeyEval(node.value, env);
    if (isError(val)) return val;
    if (val instanceof MonkeyHash) {
      for (const name of node.names) {
        const key = internString(name.value);
        const hashKey = key.fastHashKey();
        const pair = val.pairs.get(hashKey);
        env.set(name.value, pair ? pair.value : NULL);
      }
    }
    return undefined;
  }
  if (node instanceof AST.ReturnStatement) {
    const val = monkeyEval(node.returnValue, env);
    if (isError(val)) return val;
    return new MonkeyReturnValue(val);
  }

  if (node instanceof AST.ImportStatement) {
    let mod;
    
    if (ModuleLoader.isFilePath(node.moduleName)) {
      // File-based import — resolve relative to current file
      const loader = getModuleLoader();
      const fileObj = env.get('__file__');
      const fromFile = fileObj ? fileObj.value : null;
      const result = loader.load(node.moduleName, fromFile, (prog, modEnv) => {
        return monkeyEval(prog, modEnv);
      });
      if (result && result.error) return newError(result.error);
      mod = result;
    } else {
      // Built-in module
      mod = getModule(node.moduleName);
      if (!mod) return newError(`unknown module: ${node.moduleName}`);
    }
    
    if (node.bindings) {
      // Selective import: bind specific names
      for (const name of node.bindings) {
        const key = new MonkeyString(name);
        const hk = key.fastHashKey ? key.fastHashKey() : key.hashKey();
        const pair = mod.pairs.get(hk);
        if (pair) {
          env.set(name, pair.value);
        } else {
          env.set(name, NULL);
        }
      }
      return mod;
    }
    env.set(node.alias || node.moduleName, mod);
    return mod;
  }

  if (node instanceof AST.EnumStatement) {
    // Define enum as hash of MonkeyEnum values
    const pairs = new Map();
    for (let i = 0; i < node.variants.length; i++) {
      const key = new MonkeyString(node.variants[i]);
      const value = new MonkeyEnum(node.name, node.variants[i], i);
      pairs.set(key.fastHashKey ? key.fastHashKey() : key.hashKey(), { key, value });
    }
    const enumHash = new MonkeyHash(pairs);
    env.set(node.name, enumHash);
    return enumHash;
  }

  // Expressions
  if (node instanceof AST.IntegerLiteral) return new MonkeyInteger(node.value);
  if (node instanceof AST.FloatLiteral) return new MonkeyFloat(node.value);
  if (node instanceof AST.StringLiteral) return internString(node.value);
  if (node instanceof AST.BooleanLiteral) return nativeBoolToBooleanObject(node.value);

  if (node instanceof AST.PrefixExpression) {
    const right = monkeyEval(node.right, env);
    if (isError(right)) return right;
    return evalPrefixExpression(node.operator, right);
  }

  if (node instanceof AST.RangeExpression) {
    const start = monkeyEval(node.start, env);
    if (isError(start)) return start;
    const end = monkeyEval(node.end, env);
    if (isError(end)) return end;
    if (!(start instanceof MonkeyInteger) || !(end instanceof MonkeyInteger)) {
      return new MonkeyError('range requires integer bounds');
    }
    const elements = [];
    for (let i = start.value; i < end.value; i++) {
      elements.push(new MonkeyInteger(i));
    }
    return new MonkeyArray(elements);
  }
  if (node instanceof AST.InfixExpression) {
    // Short-circuit evaluation for && and ||
    if (node.operator === '&&') {
      const left = monkeyEval(node.left, env);
      if (isError(left)) return left;
      if (!isTruthy(left)) return left;
      return monkeyEval(node.right, env);
    }
    if (node.operator === '||') {
      const left = monkeyEval(node.left, env);
      if (isError(left)) return left;
      if (isTruthy(left)) return left;
      return monkeyEval(node.right, env);
    }
    if (node.operator === '??') {
      const left = monkeyEval(node.left, env);
      if (isError(left)) return left;
      if (left !== NULL && left !== undefined) return left;
      return monkeyEval(node.right, env);
    }
    const left = monkeyEval(node.left, env);
    if (isError(left)) return left;
    const right = monkeyEval(node.right, env);
    if (isError(right)) return right;
    return evalInfixExpression(node.operator, left, right);
  }

  if (node instanceof AST.IfExpression) return evalIfExpression(node, env);

  if (node instanceof AST.WhileExpression) return evalWhileExpression(node, env);
  if (node instanceof AST.DoWhileExpression) {
    do {
      const result = monkeyEval(node.body, env);
      if (isError(result)) return result;
      if (result instanceof MonkeyReturnValue) return result;
      if (result instanceof MonkeyBreak) break;
      if (result instanceof MonkeyContinue) continue;
      const cond = monkeyEval(node.condition, env);
      if (isError(cond)) return cond;
      if (!isTruthy(cond)) break;
    } while (true);
    return NULL;
  }
  if (node instanceof AST.ForExpression) return evalForExpression(node, env);
  if (node instanceof AST.ForInExpression) return evalForInExpression(node, env);
  if (node instanceof AST.BreakStatement) return new MonkeyBreak();
  if (node instanceof AST.ContinueStatement) return new MonkeyContinue();
  if (node instanceof AST.NullLiteral) return NULL;
  if (node instanceof AST.ThrowExpression) {
    const val = monkeyEval(node.value, env);
    if (isError(val)) return val;
    return new MonkeyThrown(val);
  }
  if (node instanceof AST.TryExpression) {
    return evalTryExpression(node, env);
  }
  if (node instanceof AST.TernaryExpression) {
    const condition = monkeyEval(node.condition, env);
    if (isError(condition)) return condition;
    return isTruthy(condition) ? monkeyEval(node.consequence, env) : monkeyEval(node.alternative, env);
  }
  if (node instanceof AST.MatchExpression) {
    const subject = monkeyEval(node.subject, env);
    if (isError(subject)) return subject;
    for (const arm of node.arms) {
      if (arm.pattern === null) {
        // Wildcard — check guard if present
        if (arm.guard) {
          const guardVal = monkeyEval(arm.guard, env);
          if (!isTruthy(guardVal)) continue;
        }
        return monkeyEval(arm.value, env);
      }
      if (arm.pattern instanceof AST.TypePattern) {
        const typeName = arm.pattern.typeName;
        let matches = false;
        switch (typeName) {
          case 'int': matches = subject instanceof MonkeyInteger; break;
          case 'string': matches = subject instanceof MonkeyString; break;
          case 'bool': matches = subject instanceof MonkeyBoolean; break;
          case 'array': matches = subject instanceof MonkeyArray; break;
          case 'hash': matches = subject instanceof MonkeyHash; break;
          case 'fn': matches = subject instanceof MonkeyFunction; break;
          case 'null': matches = subject === NULL; break;
          case 'Ok': matches = subject instanceof MonkeyResult && subject.isOk; break;
          case 'Err': matches = subject instanceof MonkeyResult && !subject.isOk; break;
        }
        if (matches) {
          const innerEnv = new Environment(env);
          const bindValue = (typeName === 'Ok' || typeName === 'Err') ? subject.value : subject;
          innerEnv.set(arm.pattern.binding.value, bindValue);
          if (arm.guard) {
            const guardVal = monkeyEval(arm.guard, innerEnv);
            if (!isTruthy(guardVal)) continue;
          }
          return monkeyEval(arm.value, innerEnv);
        }
        continue;
      }
      // Or-pattern: pattern1 | pattern2 | ...
      if (arm.pattern instanceof AST.OrPattern) {
        let matched = false;
        for (const p of arm.pattern.patterns) {
          const pVal = monkeyEval(p, env);
          if (isError(pVal)) return pVal;
          if (subject.inspect() === pVal.inspect()) { matched = true; break; }
        }
        if (matched) {
          if (arm.guard) {
            const guardVal = monkeyEval(arm.guard, env);
            if (!isTruthy(guardVal)) continue;
          }
          return monkeyEval(arm.value, env);
        }
        continue;
      }
      // Binding pattern: identifier with guard → bind subject to name
      if (arm.guard && arm.pattern instanceof AST.Identifier) {
        const innerEnv = new Environment(env);
        innerEnv.set(arm.pattern.value, subject);
        const guardVal = monkeyEval(arm.guard, innerEnv);
        if (isTruthy(guardVal)) {
          return monkeyEval(arm.value, innerEnv);
        }
        continue;
      }
      // Value pattern: compare
      const pattern = monkeyEval(arm.pattern, env);
      if (isError(pattern)) return pattern;
      if (subject.inspect() === pattern.inspect()) {
        if (arm.guard) {
          const guardVal = monkeyEval(arm.guard, env);
          if (!isTruthy(guardVal)) continue;
        }
        return monkeyEval(arm.value, env);
      }
    }
    return NULL;
  }
  if (node instanceof AST.TemplateLiteral) return evalTemplateLiteral(node, env);

  if (node instanceof AST.AssignExpression) {
    if (env.isConst(node.name.value)) return new MonkeyError(`cannot assign to const variable: ${node.name.value}`);
    const val = monkeyEval(node.value, env);
    if (isError(val)) return val;
    env.set(node.name.value, val);
    return val;
  }

  if (node instanceof AST.Identifier) return evalIdentifier(node, env);

  if (node instanceof AST.FunctionLiteral) {
    const fn = new MonkeyFunction(node.parameters, node.body, env);
    fn.defaults = node.defaults || [];
    return fn;
  }

  if (node instanceof AST.GeneratorLiteral) {
    return new MonkeyGeneratorDef(node.parameters, node.body, env);
  }

  if (node instanceof AST.ClassStatement) {
    const methods = new Map();
    const staticMethods = new Map();
    for (const m of node.methods) {
      const fn = new MonkeyFunction(m.params, m.body, env);
      if (m.isStatic) {
        staticMethods.set(m.name, fn);
      } else {
        methods.set(m.name, fn);
      }
    }
    const superClass = node.superClass ? env.get(node.superClass) : null;
    const klass = new MonkeyClass(node.name, methods, node.fields, superClass, env);
    klass.staticMethods = staticMethods;
    return klass;
  }

  if (node instanceof AST.SelfExpression) {
    const self = env.get('self');
    if (!self) return newError('self outside of method');
    return self;
  }

  if (node instanceof AST.SuperExpression) {
    // Return a proxy that resolves method lookups from the parent class
    const self = env.get('self');
    if (!self) return newError('super outside of method');
    const klass = self.klass;
    if (!klass.superClass) return newError(`class ${klass.name} has no superclass`);
    // Create a proxy MonkeyInstance that looks up methods from the parent
    const superProxy = {
      type: () => 'SUPER_PROXY',
      inspect: () => '<super>',
      _resolvedClass: null,
      get: function(name) {
        const currentClass = env.get('__currentClass__') || klass;
        let cls = currentClass.superClass;
        while (cls) {
          if (cls.methods.has(name)) {
            this._resolvedClass = cls;
            return cls.methods.get(name);
          }
          cls = cls.superClass;
        }
        return null;
      }
    };
    superProxy._actualInstance = self; // for bound method calls
    return superProxy;
  }

  if (node instanceof AST.YieldExpression) {
    const val = monkeyEval(node.value, env);
    if (isError(val)) return val;
    // Find the yield collector in the environment chain
    let e = env;
    while (e) {
      if (e._yieldCollector) {
        e._yieldCollector.push(val);
        return NULL; // yield doesn't interrupt execution in eager mode
      }
      e = e.outer;
    }
    return newError('yield outside of generator');
  }

  if (node instanceof AST.CallExpression) {
    const fn = monkeyEval(node.function, env);
    if (isError(fn)) return fn;
    const args = evalExpressions(node.arguments, env);
    if (args.length === 1 && isError(args[0])) return args[0];
    return applyFunction(fn, args);
  }

  if (node instanceof AST.ArrayLiteral) {
    const result = [];
    for (const el of node.elements) {
      if (el instanceof AST.SpreadElement) {
        const arr = monkeyEval(el.expression, env);
        if (isError(arr)) return arr;
        if (arr instanceof MonkeyArray) {
          result.push(...arr.elements);
        } else {
          return newError(`spread requires array, got ${arr.type()}`);
        }
      } else {
        const val = monkeyEval(el, env);
        if (isError(val)) return val;
        result.push(val);
      }
    }
    return new MonkeyArray(result);
  }

  if (node instanceof AST.ArrayComprehension) {
    const iterable = monkeyEval(node.iterable, env);
    if (isError(iterable)) return iterable;
    if (!(iterable instanceof MonkeyArray)) {
      return newError(`comprehension requires array, got ${iterable.type()}`);
    }
    const result = [];
    for (const elem of iterable.elements) {
      const innerEnv = new Environment(env);
      innerEnv.set(node.variable, elem);
      if (node.condition) {
        const cond = monkeyEval(node.condition, innerEnv);
        if (isError(cond)) return cond;
        if (!isTruthy(cond)) continue;
      }
      const val = monkeyEval(node.body, innerEnv);
      if (isError(val)) return val;
      result.push(val);
    }
    return new MonkeyArray(result);
  }

  if (node instanceof AST.IndexAssignExpression) {
    const obj = monkeyEval(node.left, env);
    if (isError(obj)) return obj;
    const index = monkeyEval(node.index, env);
    if (isError(index)) return index;
    const val = monkeyEval(node.value, env);
    if (isError(val)) return val;
    if (obj instanceof MonkeyArray && index instanceof MonkeyInteger) {
      let i = index.value;
      if (i < 0) i += obj.elements.length;
      if (i >= 0 && i < obj.elements.length) {
        obj.elements[i] = val;
      }
    } else if (obj instanceof MonkeyHash) {
      if (index.fastHashKey) {
        obj.pairs.set(index.fastHashKey(), { key: index, value: val });
      }
    } else if (obj instanceof MonkeyInstance && index instanceof MonkeyString) {
      // Check for __setitem__ protocol first for non-field keys
      if (!obj.fields.has(index.value)) {
        const setitem = obj.get('__setitem__');
        if (setitem && setitem instanceof MonkeyFunction) {
          callMethod(obj, setitem, [index, val]);
          return val;
        }
      }
      obj.set(index.value, val);
    } else if (obj instanceof MonkeyInstance) {
      // Non-string index — use __setitem__ protocol
      const setitem = obj.get('__setitem__');
      if (setitem && setitem instanceof MonkeyFunction) {
        callMethod(obj, setitem, [index, val]);
        return val;
      }
    }
    return val;
  }
  if (node instanceof AST.SliceExpression) {
    const obj = monkeyEval(node.left, env);
    if (isError(obj)) return obj;
    const start = node.start ? monkeyEval(node.start, env) : null;
    if (start && isError(start)) return start;
    const end = node.end ? monkeyEval(node.end, env) : null;
    if (end && isError(end)) return end;
    if (obj instanceof MonkeyArray) {
      const len = obj.elements.length;
      let s = start ? start.value : 0;
      let e = end ? end.value : len;
      if (s < 0) s += len;
      if (e < 0) e += len;
      return new MonkeyArray(obj.elements.slice(s, e));
    }
    if (obj instanceof MonkeyString) {
      const len = obj.value.length;
      let s = start ? start.value : 0;
      let e = end ? end.value : len;
      if (s < 0) s += len;
      if (e < 0) e += len;
      return new MonkeyString(obj.value.slice(s, e));
    }
    return NULL;
  }
  if (node instanceof AST.IndexExpression) {
    const left = monkeyEval(node.left, env);
    if (isError(left)) return left;
    const index = monkeyEval(node.index, env);
    if (isError(index)) return index;
    return evalIndexExpression(left, index);
  }

  if (node instanceof AST.OptionalChainExpression) {
    const left = monkeyEval(node.left, env);
    if (isError(left)) return left;
    if (left === NULL || left === undefined) return NULL;
    const index = monkeyEval(node.index, env);
    if (isError(index)) return index;
    return evalIndexExpression(left, index);
  }

  if (node instanceof AST.HashLiteral) {
    return evalHashLiteral(node, env);
  }

  return NULL;
}

function evalProgram(stmts, env) {
  let result;
  for (const stmt of stmts) {
    result = monkeyEval(stmt, env);
    if (result instanceof MonkeyReturnValue) return result.value;
    if (result instanceof MonkeyError) return result;
  }
  return result;
}

function evalBlockStatement(stmts, env) {
  let result;
  for (const stmt of stmts) {
    result = monkeyEval(stmt, env);
    if (result) {
      const rt = result.type();
      if (rt === OBJ.RETURN || rt === OBJ.ERROR) return result;
      if (result instanceof MonkeyThrown) return result;
      if (result instanceof MonkeyBreak || result instanceof MonkeyContinue) return result;
    }
  }
  return result;
}

function evalTryExpression(node, env) {
  const tryResult = monkeyEval(node.tryBlock, env);
  let result = tryResult;

  // Check if an exception was thrown (MonkeyThrown) or error occurred (MonkeyError)
  const isThrown = tryResult instanceof MonkeyThrown;
  const isTryError = tryResult instanceof MonkeyError;

  if ((isThrown || isTryError) && node.catchBlock) {
    // Bind the error value to the catch parameter in the current env
    if (node.catchParam) {
      const errorVal = isThrown ? tryResult.value : new MonkeyString(tryResult.message);
      env.set(node.catchParam.value, errorVal);
    }
    result = monkeyEval(node.catchBlock, env);
  }

  // Execute finally block if present (always runs)
  if (node.finallyBlock) {
    const finallyResult = monkeyEval(node.finallyBlock, env);
    // Finally doesn't override the result unless it throws/returns
    if (finallyResult instanceof MonkeyThrown || finallyResult instanceof MonkeyError || finallyResult instanceof MonkeyReturnValue) {
      return finallyResult;
    }
  }

  // If error wasn't caught, propagate it
  if ((isThrown || isTryError) && !node.catchBlock) {
    return tryResult;
  }

  return result !== undefined ? result : NULL;
}

function evalPrefixExpression(op, right) {
  switch (op) {
    case '!': return evalBangOperator(right);
    case '-': return evalMinusPrefix(right);
    default: return newError(`unknown operator: ${op}${right.type()}`);
  }
}

function evalBangOperator(right) {
  if (right === TRUE) return FALSE;
  if (right === FALSE) return TRUE;
  if (right === NULL) return TRUE;
  return FALSE;
}

function evalMinusPrefix(right) {
  if (right.type() === OBJ.FLOAT) return new MonkeyFloat(-right.value);
  if (right.type() !== OBJ.INTEGER) return newError(`unknown operator: -${right.type()}`);
  return new MonkeyInteger(-right.value);
}

function evalInfixExpression(op, left, right) {
  // Operator overloading for class instances
  if (left instanceof MonkeyInstance) {
    const opMap = {
      '+': '__add__', '-': '__sub__', '*': '__mul__', '/': '__div__',
      '%': '__mod__', '==': '__eq__', '!=': '__ne__',
      '<': '__lt__', '>': '__gt__', '<=': '__le__', '>=': '__ge__',
    };
    const methodName = opMap[op];
    if (methodName) {
      const method = left.get(methodName);
      if (method && method instanceof MonkeyFunction) {
        return callMethod(left, method, [right]);
      }
    }
  }
  
  if ((left.type() === OBJ.INTEGER || left.type() === OBJ.FLOAT) && 
      (right.type() === OBJ.INTEGER || right.type() === OBJ.FLOAT)) {
    return evalNumericInfix(op, left, right);
  }
  // String * Integer or Integer * String
  if (op === '*') {
    if (left.type() === OBJ.STRING && right.type() === OBJ.INTEGER) {
      const n = right.value;
      return new MonkeyString(n > 0 ? left.value.repeat(n) : '');
    }
    if (left.type() === OBJ.INTEGER && right.type() === OBJ.STRING) {
      const n = left.value;
      return new MonkeyString(n > 0 ? right.value.repeat(n) : '');
    }
  }
  if (left.type() === OBJ.STRING && right.type() === OBJ.STRING) {
    if (op === '+') return new MonkeyString(left.value + right.value);
    if (op === '==') return nativeBoolToBooleanObject(left.value === right.value);
    if (op === '!=') return nativeBoolToBooleanObject(left.value !== right.value);
    if (op === '<') return nativeBoolToBooleanObject(left.value < right.value);
    if (op === '>') return nativeBoolToBooleanObject(left.value > right.value);
    if (op === '<=') return nativeBoolToBooleanObject(left.value <= right.value);
    if (op === '>=') return nativeBoolToBooleanObject(left.value >= right.value);
    return newError(`unknown operator: ${left.type()} ${op} ${right.type()}`);
  }
  // Array concatenation
  if (left.type() === OBJ.ARRAY && right.type() === OBJ.ARRAY && op === '+') {
    return new MonkeyArray([...left.elements, ...right.elements]);
  }
  if (left.type() === 'ENUM' && right.type() === 'ENUM') {
    const eq = left.enumName === right.enumName && left.variant === right.variant;
    if (op === '==') return nativeBoolToBooleanObject(eq);
    if (op === '!=') return nativeBoolToBooleanObject(!eq);
  }
  if (op === '==') return nativeBoolToBooleanObject(left === right);
  if (op === '!=') return nativeBoolToBooleanObject(left !== right);
  if (left.type() !== right.type()) {
    return newError(`type mismatch: ${left.type()} ${op} ${right.type()}`);
  }
  return newError(`unknown operator: ${left.type()} ${op} ${right.type()}`);
}

function evalNumericInfix(op, left, right) {
  const l = left.value, r = right.value;
  const isFloat = left.type() === OBJ.FLOAT || right.type() === OBJ.FLOAT;
  const mkNum = (v) => isFloat ? new MonkeyFloat(v) : new MonkeyInteger(v);
  switch (op) {
    case '+': return mkNum(l + r);
    case '-': return mkNum(l - r);
    case '*': return mkNum(l * r);
    case '/': return isFloat ? new MonkeyFloat(l / r) : new MonkeyInteger(Math.trunc(l / r));
    case '%': return mkNum(l % r);
    case '<': return nativeBoolToBooleanObject(l < r);
    case '>': return nativeBoolToBooleanObject(l > r);
    case '<=': return nativeBoolToBooleanObject(l <= r);
    case '>=': return nativeBoolToBooleanObject(l >= r);
    case '==': return nativeBoolToBooleanObject(l === r);
    case '!=': return nativeBoolToBooleanObject(l !== r);
    default: return newError(`unknown operator: ${left.type()} ${op} ${right.type()}`);
  }
}

// Keep old name for backward compat in case anything references it
const evalIntegerInfix = evalNumericInfix;

function evalIfExpression(node, env) {
  const condition = monkeyEval(node.condition, env);
  if (isError(condition)) return condition;
  if (isTruthy(condition)) return monkeyEval(node.consequence, env);
  if (node.alternative) return monkeyEval(node.alternative, env);
  return NULL;
}

function evalWhileExpression(node, env) {
  while (true) {
    const condition = monkeyEval(node.condition, env);
    if (isError(condition)) return condition;
    if (!isTruthy(condition)) break;
    const result = monkeyEval(node.body, env);
    if (isError(result)) return result;
    if (result instanceof MonkeyReturnValue) return result;
    if (result instanceof MonkeyBreak) break;
    if (result instanceof MonkeyContinue) continue;
  }
  return NULL;
}

function evalForExpression(node, env) {
  const initResult = monkeyEval(node.init, env);
  if (isError(initResult)) return initResult;

  while (true) {
    const condition = monkeyEval(node.condition, env);
    if (isError(condition)) return condition;
    if (!isTruthy(condition)) break;
    const bodyResult = monkeyEval(node.body, env);
    if (isError(bodyResult)) return bodyResult;
    if (bodyResult instanceof MonkeyReturnValue) return bodyResult;
    if (bodyResult instanceof MonkeyBreak) break;
    if (bodyResult instanceof MonkeyContinue) { /* fall through to update */ }
    const updateResult = monkeyEval(node.update, env);
    if (isError(updateResult)) return updateResult;
  }
  return NULL;
}

function evalForInExpression(node, env) {
  const iterable = monkeyEval(node.iterable, env);
  if (isError(iterable)) return iterable;

  let elements;
  if (iterable instanceof MonkeyArray) {
    elements = iterable.elements;
  } else if (iterable instanceof MonkeyString) {
    elements = iterable.value.split('').map(c => new MonkeyString(c));
  } else if (iterable instanceof MonkeyGenerator) {
    elements = iterable.values;
  } else if (iterable instanceof MonkeyHash) {
    // Iterate over hash keys
    elements = [];
    for (const [, { key }] of iterable.pairs) {
      elements.push(key);
    }
  } else if (iterable instanceof MonkeyInstance) {
    // Check for __iter__ protocol
    const iterFn = iterable.get('__iter__');
    if (iterFn && iterFn instanceof MonkeyFunction) {
      const result = callMethod(iterable, iterFn, []);
      if (result instanceof MonkeyArray) {
        elements = result.elements;
      } else if (result instanceof MonkeyGenerator) {
        elements = result.values;
      } else {
        return new MonkeyError(`__iter__ must return ARRAY or GENERATOR, got ${result.type()}`);
      }
    } else {
      return new MonkeyError(`for-in: INSTANCE does not implement __iter__`);
    }
  } else {
    return new MonkeyError(`for-in: expected ARRAY, STRING, GENERATOR, or iterable INSTANCE, got ${iterable.type()}`);
  }

  for (const elem of elements) {
    env.set(node.variable, elem);
    const bodyResult = monkeyEval(node.body, env);
    if (isError(bodyResult)) return bodyResult;
    if (bodyResult instanceof MonkeyReturnValue) return bodyResult;
    if (bodyResult instanceof MonkeyBreak) break;
    if (bodyResult instanceof MonkeyContinue) continue;
  }
  return NULL;
}

function evalTemplateLiteral(node, env) {
  let result = '';
  for (const part of node.parts) {
    const val = monkeyEval(part, env);
    if (isError(val)) return val;
    result += val.inspect();
  }
  return new MonkeyString(result);
}

function evalIdentifier(node, env) {
  const val = env.get(node.value);
  if (val !== undefined) return val;
  const builtin = builtins.get(node.value);
  if (builtin) return builtin;
  return newError(`identifier not found: ${node.value}`);
}

function evalExpressions(exps, env) {
  const result = [];
  for (const exp of exps) {
    const val = monkeyEval(exp, env);
    if (isError(val)) return [val];
    result.push(val);
  }
  return result;
}

function applyFunction(fn, args) {
  if (fn instanceof MonkeyFunction) {
    const extendedEnv = new Environment(fn.env);
    for (let i = 0; i < fn.parameters.length; i++) {
      if (i < args.length) {
        extendedEnv.set(fn.parameters[i].value, args[i]);
      } else if (fn.defaults && fn.defaults[i]) {
        // Evaluate default in the function's environment
        const defaultVal = monkeyEval(fn.defaults[i], extendedEnv);
        extendedEnv.set(fn.parameters[i].value, defaultVal);
      } else {
        extendedEnv.set(fn.parameters[i].value, NULL);
      }
    }
    const result = monkeyEval(fn.body, extendedEnv);
    if (result instanceof MonkeyReturnValue) return result.value;
    return result;
  }
  if (fn instanceof MonkeyBuiltin) return fn.fn(...args);
  if (fn instanceof MonkeyGeneratorDef) {
    return callGenerator(fn, args);
  }
  if (fn instanceof MonkeyClass) {
    return constructInstance(fn, args);
  }
  return newError(`not a function: ${fn.type()}`);
}

function evalIndexExpression(left, index) {
  if (left.type() === OBJ.ARRAY && index.type() === OBJ.INTEGER) {
    let idx = index.value;
    if (idx < 0) idx += left.elements.length; // negative indexing
    const max = left.elements.length - 1;
    if (idx < 0 || idx > max) return NULL;
    return left.elements[idx];
  }
  if (left.type() === OBJ.HASH) {
    if (typeof index.fastHashKey !== 'function') {
      return newError(`unusable as hash key: ${index.type()}`);
    }
    const pair = left.pairs.get(index.fastHashKey());
    if (!pair) return NULL;
    return pair.value;
  }
  if (left.type() === OBJ.STRING && index instanceof MonkeyInteger) {
    let idx = index.value;
    if (idx < 0) idx += left.value.length; // negative indexing
    if (idx < 0 || idx >= left.value.length) return NULL;
    return new MonkeyString(left.value[idx]);
  }
  if (left.type() === OBJ.STRING && index instanceof MonkeyString) {
    // String dot access
    switch (index.value) {
      case 'length': return new MonkeyInteger(left.value.length);
      default: return NULL;
    }
  }
  if (left.type() === OBJ.ARRAY && index instanceof MonkeyString) {
    switch (index.value) {
      case 'length': return new MonkeyInteger(left.elements.length);
      default: return NULL;
    }
  }
  // Super proxy method access
  if (left && left.type && left.type() === 'SUPER_PROXY' && index instanceof MonkeyString) {
    const method = left.get(index.value);
    if (method && method instanceof MonkeyFunction) {
      const instance = left._actualInstance;
      const resolvedFromClass = left._resolvedClass;
      return new MonkeyBuiltin((...args) => callMethod(instance, method, args, resolvedFromClass));
    }
    return NULL;
  }
  // Instance field/method access
  if (left instanceof MonkeyInstance && index instanceof MonkeyString) {
    const value = left.get(index.value);
    if (value instanceof MonkeyFunction) {
      const methodInfo = left.getMethodWithClass(index.value);
      const methodClass = methodInfo ? methodInfo.klass : null;
      const boundMethod = new MonkeyBuiltin((...args) => {
        return callMethod(left, value, args, methodClass);
      });
      return boundMethod;
    }
    if (value !== null) return value;
    // __getitem__ fallback
    const getitem = left.get('__getitem__');
    if (getitem && getitem instanceof MonkeyFunction) {
      return callMethod(left, getitem, [index]);
    }
    return NULL;
  }
  // Also handle non-string index on instances via __getitem__
  if (left instanceof MonkeyInstance) {
    const getitem = left.get('__getitem__');
    if (getitem && getitem instanceof MonkeyFunction) {
      return callMethod(left, getitem, [index]);
    }
    return NULL;
  }
  // Class static method access
  if (left instanceof MonkeyClass && index instanceof MonkeyString) {
    const staticMethod = left.staticMethods.get(index.value);
    if (staticMethod) return staticMethod;
    return NULL;
  }
  return newError(`index operator not supported: ${left.type()}`);
}

function evalHashLiteral(node, env) {
  const pairs = new Map();
  for (const [keyNode, valueNode] of node.pairs) {
    const key = monkeyEval(keyNode, env);
    if (isError(key)) return key;
    if (typeof key.fastHashKey !== 'function') {
      return newError(`unusable as hash key: ${key.type()}`);
    }
    const value = monkeyEval(valueNode, env);
    if (isError(value)) return value;
    pairs.set(key.fastHashKey(), { key, value });
  }
  return new MonkeyHash(pairs);
}

// Execute a generator, eagerly collecting all yielded values
function callGenerator(genDef, args) {
  const extendedEnv = new Environment(genDef.env);
  for (let i = 0; i < genDef.parameters.length; i++) {
    if (i < args.length) {
      extendedEnv.set(genDef.parameters[i].value, args[i]);
    } else {
      extendedEnv.set(genDef.parameters[i].value, NULL);
    }
  }
  
  // Install a yield collector in the environment
  const values = [];
  extendedEnv._yieldCollector = values;
  
  monkeyEval(genDef.body, extendedEnv);
  return new MonkeyGenerator(values);
}

// Construct a class instance: create MonkeyInstance, call init if present
function constructInstance(klass, args) {
  const instance = new MonkeyInstance(klass);
  
  // Also initialize parent fields
  let parent = klass.superClass;
  while (parent) {
    for (const f of parent.fields) {
      if (!instance.fields.has(f)) {
        instance.fields.set(f, NULL);
      }
    }
    parent = parent.superClass;
  }
  
  // Find init method (may be inherited)
  let initFn = null;
  let cls = klass;
  while (cls) {
    if (cls.methods.has('init')) {
      initFn = cls.methods.get('init');
      break;
    }
    cls = cls.superClass;
  }
  
  if (initFn) {
    callMethod(instance, initFn, args);
  }
  
  return instance;
}

// Call a method on an instance with self binding
function callMethod(instance, fn, args, methodClass) {
  const extendedEnv = new Environment(fn.env);
  extendedEnv.set('self', instance);
  if (methodClass) extendedEnv.set('__currentClass__', methodClass);
  for (let i = 0; i < fn.parameters.length; i++) {
    if (i < args.length) {
      extendedEnv.set(fn.parameters[i].value, args[i]);
    } else {
      extendedEnv.set(fn.parameters[i].value, NULL);
    }
  }
  const result = monkeyEval(fn.body, extendedEnv);
  if (result instanceof MonkeyReturnValue) return result.value;
  return result;
}
