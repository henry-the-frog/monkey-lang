// ===== Option Type (Rust/Scala-inspired Some/None) =====

export class Some {
  constructor(value) { this.value = value; }
  get isSome() { return true; }
  get isNone() { return false; }
  map(fn) { return some(fn(this.value)); }
  flatMap(fn) { return fn(this.value); }
  filter(pred) { return pred(this.value) ? this : NONE; }
  unwrap() { return this.value; }
  unwrapOr() { return this.value; }
  unwrapOrElse() { return this.value; }
  or() { return this; }
  and(other) { return other; }
  zip(other) { return other.isSome ? some([this.value, other.value]) : NONE; }
  match({ some: s }) { return s(this.value); }
  toString() { return `Some(${this.value})`; }
}

export class None {
  get isSome() { return false; }
  get isNone() { return true; }
  map() { return this; }
  flatMap() { return this; }
  filter() { return this; }
  unwrap() { throw new Error('Unwrap on None'); }
  unwrapOr(def) { return def; }
  unwrapOrElse(fn) { return fn(); }
  or(other) { return other; }
  and() { return this; }
  zip() { return this; }
  match({ none: n }) { return n(); }
  toString() { return 'None'; }
}

const NONE = new None();
export function some(value) { return new Some(value); }
export function none() { return NONE; }
none.isNone = true;
none.isSome = false;
none.unwrap = () => NONE.unwrap();
none.unwrapOr = (v) => v;
none.map = () => NONE;
none.flatMap = () => NONE;
none.filter = () => NONE;
none.match = (m) => NONE.match(m);
none.or = (other) => other;
none.zip = () => NONE;
none.isNone_ = () => true;
none.isSome_ = () => false;
export function fromNullable(value) { return value != null ? some(value) : NONE; }
export const from = fromNullable;
export function tryCatch(fn) {
  try { return some(fn()); } catch { return NONE; }
}
