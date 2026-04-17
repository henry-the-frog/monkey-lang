// Monkey Language Object System

export const OBJ = {
  INTEGER: 'INTEGER',
  FLOAT: 'FLOAT',
  BOOLEAN: 'BOOLEAN',
  NULL: 'NULL',
  STRING: 'STRING',
  RETURN: 'RETURN',
  ERROR: 'ERROR',
  FUNCTION: 'FUNCTION',
  ARRAY: 'ARRAY',
  HASH: 'HASH',
  BUILTIN: 'BUILTIN',
};

export class MonkeyInteger {
  constructor(value) { this.value = value; }
  type() { return OBJ.INTEGER; }
  inspect() { return String(this.value); }
  hashKey() { if (this._hk === undefined) this._hk = `int:${this.value}`; return this._hk; }
  // Fast hash key: use raw value with type tag for Map identity
  // Integers: use number directly (no collision with strings since Map uses SameValueZero)
  fastHashKey() { return this.value; }
}

export class MonkeyFloat {
  constructor(value) { this.value = value; }
  type() { return OBJ.FLOAT; }
  inspect() { return String(this.value); }
  hashKey() { if (this._hk === undefined) this._hk = `float:${this.value}`; return this._hk; }
  fastHashKey() { return this.value + 0.1; } // offset to avoid collision with integers
}

export class MonkeyBoolean {
  constructor(value) { this.value = value; }
  type() { return OBJ.BOOLEAN; }
  inspect() { return String(this.value); }
  hashKey() { if (this._hk === undefined) this._hk = `bool:${this.value}`; return this._hk; }
  fastHashKey() { return this; } // singleton identity
}

export class MonkeyNull {
  type() { return OBJ.NULL; }
  inspect() { return 'null'; }
}

export class MonkeyString {
  constructor(value) { this.value = value; }
  type() { return OBJ.STRING; }
  inspect() { return this.value; }
  hashKey() { if (this._hk === undefined) this._hk = `str:${this.value}`; return this._hk; }
  fastHashKey() { return `s:${this.value}`; } // value-based for correct hash lookup
}

// String intern table: guarantees same-value strings share same object
const STRING_INTERN = new Map();
const STRING_INTERN_MAX = 4096; // prevent unbounded growth

/**
 * Get or create an interned MonkeyString. Same value → same object.
 * This enables identity-based hash lookups (Map key = object ref).
 */
export function internString(value) {
  let s = STRING_INTERN.get(value);
  if (s !== undefined) return s;
  s = new MonkeyString(value);
  if (STRING_INTERN.size < STRING_INTERN_MAX) {
    STRING_INTERN.set(value, s);
  }
  return s;
}

export class MonkeyReturnValue {
  constructor(value) { this.value = value; }
  type() { return OBJ.RETURN; }
  inspect() { return this.value.inspect(); }
}

export class MonkeyError {
  constructor(message) { this.message = message; }
  type() { return OBJ.ERROR; }
  inspect() { return `ERROR: ${this.message}`; }
}

// Represents a value thrown by the `throw` keyword — propagates up until caught by try/catch
export class MonkeyThrown {
  constructor(value) { this.value = value; }
  type() { return 'THROWN'; }
  inspect() { return `THROWN: ${this.value?.inspect ? this.value.inspect() : String(this.value)}`; }
}

export class MonkeyFunction {
  constructor(parameters, body, env) {
    this.parameters = parameters;
    this.body = body;
    this.env = env;
  }
  type() { return OBJ.FUNCTION; }
  inspect() { return `fn(${this.parameters.join(', ')}) {\n${this.body}\n}`; }
}

export class MonkeyArray {
  constructor(elements) { this.elements = elements; }
  type() { return OBJ.ARRAY; }
  inspect() { return `[${this.elements.map(e => e.inspect()).join(', ')}]`; }
}

export class MonkeyHash {
  constructor(pairs) { 
    this.pairs = pairs; // Map<fastHashKey, {key, value}>
    this._shapeId = null; // Lazy-computed shape identifier
  }
  type() { return OBJ.HASH; }
  inspect() {
    const entries = [];
    for (const [, { key, value }] of this.pairs) {
      entries.push(`${key.inspect()}: ${value.inspect()}`);
    }
    return `{${entries.join(', ')}}`;
  }
  // Shape ID: identifies the set of keys in this hash.
  // Two hashes with the same keys (same shape) get the same shapeId.
  // Invalidated on key addition/removal.
  get shapeId() {
    if (this._shapeId === null) {
      // Sort keys for deterministic shape identification
      const keys = [];
      for (const k of this.pairs.keys()) {
        keys.push(k);
      }
      keys.sort();
      this._shapeId = keys.join('\0');
    }
    return this._shapeId;
  }
  // Call when keys change (set/delete) to invalidate cached shape
  invalidateShape() {
    this._shapeId = null;
  }
}

export class MonkeyBuiltin {
  constructor(fn) { this.fn = fn; }
  type() { return OBJ.BUILTIN; }
  inspect() { return 'builtin function'; }
}

// Environment (scope chain)
export class Environment {
  constructor(outer = null) {
    this.store = new Map();
    this.consts = new Set();
    this.outer = outer;
  }
  get(name) {
    const val = this.store.get(name);
    if (val !== undefined) return val;
    if (this.outer) return this.outer.get(name);
    return undefined;
  }
  isConst(name) {
    if (this.consts.has(name)) return true;
    if (this.store.has(name)) return false;
    if (this.outer) return this.outer.isConst(name);
    return false;
  }
  set(name, val, isConst = false) {
    if (this.isConst(name)) return new MonkeyError(`cannot assign to const variable: ${name}`);
    this.store.set(name, val);
    if (isConst) this.consts.add(name);
    return val;
  }
}

// Singletons
export const TRUE = new MonkeyBoolean(true);
export const FALSE = new MonkeyBoolean(false);
export const NULL = new MonkeyNull();

// Integer cache: pre-allocate MonkeyInteger objects for common values
// Avoids allocation in hot loops (like CPython's small int cache)
const INT_CACHE_MIN = -1;
const INT_CACHE_MAX = 256;
const INT_CACHE = new Array(INT_CACHE_MAX - INT_CACHE_MIN + 1);
for (let i = INT_CACHE_MIN; i <= INT_CACHE_MAX; i++) {
  INT_CACHE[i - INT_CACHE_MIN] = new MonkeyInteger(i);
}

/**
 * Get or create a MonkeyInteger. Uses cache for common values.
 */
export function cachedInteger(value) {
  if (value >= INT_CACHE_MIN && value <= INT_CACHE_MAX && (value | 0) === value) {
    return INT_CACHE[value - INT_CACHE_MIN];
  }
  return new MonkeyInteger(value);
}

export class MonkeyBreak {
  constructor() {}
  type() { return 'BREAK'; }
  inspect() { return 'break'; }
}

export class MonkeyContinue {
  constructor() {}
  type() { return 'CONTINUE'; }
  inspect() { return 'continue'; }
}

export class MonkeyResult {
  constructor(isOk, value) {
    this.isOk = isOk;      // boolean
    this.value = value;     // MonkeyObject
  }
  type() { return 'RESULT'; }
  inspect() { return this.isOk ? `Ok(${this.value.inspect()})` : `Err(${this.value.inspect()})`; }
  fastHashKey() { return `result:${this.isOk}:${this.value.inspect()}`; }
}

export class MonkeyEnum {
  constructor(enumName, variant, ordinal) {
    this.enumName = enumName;   // "Color"
    this.variant = variant;     // "Red"
    this.ordinal = ordinal;     // 0
  }
  type() { return 'ENUM'; }
  inspect() { return `${this.enumName}.${this.variant}`; }
  hashKey() { return `enum:${this.enumName}:${this.variant}`; }
  fastHashKey() { return `enum:${this.enumName}:${this.variant}`; }
}

export class MonkeyGeneratorDef {
  constructor(parameters, body, env) {
    this.parameters = parameters; // [Identifier]
    this.body = body;             // BlockStatement
    this.env = env;               // Environment (closure)
  }
  type() { return 'GENERATOR_DEF'; }
  inspect() { return `gen(${this.parameters.map(p => p.value || p).join(', ')}) { ... }`; }
}

// A "live" generator instance — holds yielded values for iteration
export class MonkeyGenerator {
  constructor(values) {
    this.values = values;     // Array of MonkeyObject values (eagerly collected)
    this._index = 0;
  }
  type() { return 'GENERATOR'; }
  inspect() { return `<generator [${this.values.length} values]>`; }
  
  // Iterator interface
  next() {
    if (this._index < this.values.length) {
      return { value: this.values[this._index++], done: false };
    }
    return { value: null, done: true };
  }
  
  reset() { this._index = 0; }
}

export class MonkeyYield {
  constructor(value) { this.value = value; }
  type() { return 'YIELD_VALUE'; }
  inspect() { return `yield(${this.value.inspect()})`; }
}

export class MonkeyClass {
  constructor(name, methods, fields, superClass, env) {
    this.name = name;             // string
    this.methods = methods;       // Map<string, {params, body, env}>
    this.fields = fields;         // [string]
    this.superClass = superClass; // MonkeyClass or null
    this.env = env;               // closure environment
  }
  type() { return 'CLASS'; }
  inspect() { return `<class ${this.name}>`; }
}

export class MonkeyInstance {
  constructor(klass) {
    this.klass = klass;           // MonkeyClass
    this.fields = new Map();       // Map<string, MonkeyObject>
    // Initialize all declared fields to null
    for (const f of klass.fields) {
      this.fields.set(f, NULL);
    }
  }
  type() { return 'INSTANCE'; }
  inspect() {
    // If the class has a toString method, use it
    const toStr = this.get('toString');
    if (toStr && typeof toStr.body !== 'undefined') {
      // Can't call the method here (no evaluator access), fall through to default
    }
    const entries = [];
    for (const [k, v] of this.fields) {
      entries.push(`${k}: ${v.inspect()}`);
    }
    return `<${this.klass.name} {${entries.join(', ')}}>`;
  }
  
  // Get a field or method
  get(name) {
    if (this.fields.has(name)) return this.fields.get(name);
    // Look up method in class chain
    let klass = this.klass;
    while (klass) {
      if (klass.methods.has(name)) return klass.methods.get(name);
      klass = klass.superClass;
    }
    return null;
  }

  // Get method with the class it belongs to (for super resolution)
  getMethodWithClass(name) {
    let klass = this.klass;
    while (klass) {
      if (klass.methods.has(name)) return { method: klass.methods.get(name), klass };
      klass = klass.superClass;
    }
    return null;
  }
  
  set(name, value) {
    this.fields.set(name, value);
  }
}

export class MonkeyBoundMethod {
  constructor(instance, closure) {
    this.instance = instance;     // MonkeyInstance
    this.closure = closure;       // Closure
  }
  type() { return 'BOUND_METHOD'; }
  inspect() { return `<bound method>`; }
}
