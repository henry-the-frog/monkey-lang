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
  hashKey() { return `int:${this.value}`; }
}

export class MonkeyFloat {
  constructor(value) { this.value = value; }
  type() { return OBJ.FLOAT; }
  inspect() { return String(this.value); }
  hashKey() { return `float:${this.value}`; }
}

export class MonkeyBoolean {
  constructor(value) { this.value = value; }
  type() { return OBJ.BOOLEAN; }
  inspect() { return String(this.value); }
  hashKey() { return `bool:${this.value}`; }
}

export class MonkeyNull {
  type() { return OBJ.NULL; }
  inspect() { return 'null'; }
}

export class MonkeyString {
  constructor(value) { this.value = value; }
  type() { return OBJ.STRING; }
  inspect() { return this.value; }
  hashKey() { return `str:${this.value}`; }
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
  constructor(pairs) { this.pairs = pairs; } // Map<hashKey, {key, value}> OR Map<key, value>
  type() { return OBJ.HASH; }
  inspect() {
    const entries = [];
    for (const [k, v] of this.pairs) {
      // Handle both formats: {key, value} objects or direct key→value
      if (v && typeof v === 'object' && 'key' in v && 'value' in v) {
        entries.push(`${v.key.inspect()}: ${v.value.inspect()}`);
      } else {
        entries.push(`${k?.inspect?.() ?? String(k)}: ${v?.inspect?.() ?? String(v)}`);
      }
    }
    return `{${entries.join(', ')}}`;
  }
}

/**
 * ShapedHash — VM-optimized hash using hidden classes.
 * 
 * Instead of a Map, stores values in a flat array indexed by shape slots.
 * Property access: shape.getSlot(key) → slots[slot] instead of Map.get(key).
 * 
 * Falls back to MonkeyHash interface via .pairs getter for compatibility.
 */
export class ShapedHash {
  /**
   * @param {import('./shape.js').Shape} shape - The hidden class
   * @param {any[]} slots - Values indexed by shape slot positions
   * @param {any[]} keys - Original MonkeyObject keys in slot order
   */
  constructor(shape, slots, keys) {
    this.shape = shape;
    this.slots = slots;
    this.keys = keys;    // MonkeyObject keys in slot order (for iteration)
  }

  type() { return OBJ.HASH; }

  /** Get value by string key (fast path) */
  getByString(keyStr) {
    const slot = this.shape.getSlot(keyStr);
    return slot >= 0 ? this.slots[slot] : undefined;
  }

  /** Get value by MonkeyObject key */
  getByKey(keyObj) {
    const keyStr = objectKeyString(keyObj);
    return this.getByString(keyStr);
  }

  /** Set value by string key — mutates in place if key exists, otherwise transitions shape */
  setByString(keyStr, value, keyObj) {
    const slot = this.shape.getSlot(keyStr);
    if (slot >= 0) {
      this.slots[slot] = value;
    } else {
      // New key — transition to a new shape
      const newShape = this.shape.transition(keyStr);
      this.slots.push(value);
      this.keys.push(keyObj);
      this.shape = newShape;
    }
  }

  /** Compatibility: .pairs getter returns a Map view for iteration */
  get pairs() {
    const map = new Map();
    const shapeKeys = this.shape.keys();
    for (let i = 0; i < this.slots.length; i++) {
      map.set(this.keys[i], this.slots[i]);
    }
    return map;
  }

  inspect() {
    const entries = [];
    for (let i = 0; i < this.slots.length; i++) {
      const k = this.keys[i];
      const v = this.slots[i];
      entries.push(`${k?.inspect?.() ?? String(k)}: ${v?.inspect?.() ?? String(v)}`);
    }
    return `{${entries.join(', ')}}`;
  }
}

/** Convert a MonkeyObject key to its string form for shape lookup */
export function objectKeyString(obj) {
  if (obj instanceof MonkeyString) return `str:${obj.value}`;
  if (obj instanceof MonkeyInteger) return `int:${obj.value}`;
  if (obj instanceof MonkeyBoolean) return `bool:${obj.value}`;
  if (obj && typeof obj.inspect === 'function') return obj.inspect();
  return String(obj);
}

// --- String Interning ---

/** Global string intern table */
const stringInternTable = new Map();

/**
 * Get or create an interned MonkeyString.
 * Identical string values share the same object instance.
 * This enables O(1) string equality via reference comparison.
 * 
 * @param {string} value - The string value
 * @returns {MonkeyString} The interned string object
 */
export function internString(value) {
  let existing = stringInternTable.get(value);
  if (existing) return existing;
  const str = new MonkeyString(value);
  stringInternTable.set(value, str);
  return str;
}

/** Get string intern table stats */
export function getInternStats() {
  return { size: stringInternTable.size };
}

/** Reset string intern table (for testing) */
export function resetInternTable() {
  stringInternTable.clear();
}

export class MonkeyEnum {
  constructor(enumName, variant, ordinal) {
    this.enumName = enumName;
    this.variant = variant;
    this.ordinal = ordinal;
  }
  type() { return 'ENUM'; }
  inspect() { return `${this.enumName}.${this.variant}`; }
  hashKey() { return `enum:${this.enumName}:${this.variant}`; }
  fastHashKey() { return `enum:${this.enumName}:${this.variant}`; }
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
    this.constBindings = new Set();
    this.outer = outer;
  }
  get(name) {
    const val = this.store.get(name);
    if (val !== undefined) return val;
    if (this.outer) return this.outer.get(name);
    return undefined;
  }
  set(name, val) {
    this.store.set(name, val);
    return val;
  }
  setConst(name, val) {
    this.store.set(name, val);
    this.constBindings.add(name);
    return val;
  }
  isConst(name) {
    if (this.constBindings.has(name)) return true;
    if (this.outer) return this.outer.isConst(name);
    return false;
  }
  update(name, val) {
    // Update existing binding in the nearest scope that has it
    if (this.store.has(name)) {
      if (this.constBindings.has(name)) {
        return null; // Signal const violation
      }
      this.store.set(name, val);
      return val;
    }
    if (this.outer) return this.outer.update(name, val);
    // If not found, create in current scope (fallback)
    this.store.set(name, val);
    return val;
  }
}

// Singletons
export const TRUE = new MonkeyBoolean(true);
export const FALSE = new MonkeyBoolean(false);
export const NULL = new MonkeyNull();
export const BREAK_SIGNAL = { type: 'BREAK_SIGNAL' };
export const CONTINUE_SIGNAL = { type: 'CONTINUE_SIGNAL' };
