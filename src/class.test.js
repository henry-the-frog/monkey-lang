// class.test.js — Tests for class syntax (parsing, compilation, execution)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileWithPrelude } from './prelude.js';
import { VM } from './vm.js';

function run(input) {
  const bc = compileWithPrelude(input);
  const vm = new VM(bc);
  vm.run();
  return vm.lastPoppedStackElem();
}

describe('Class: basic', () => {
  it('creates an instance with properties', () => {
    const r = run(`
      class Point {
        init(self, x, y) {
          set self.x = x;
          set self.y = y;
        }
      }
      let p = Point(3, 4);
      p.x + p.y;
    `);
    assert.strictEqual(r.value, 7);
  });

  it('accesses properties via dot notation', () => {
    const r = run(`
      class Person {
        init(self, name) {
          set self.name = name;
        }
      }
      let p = Person("Alice");
      p.name;
    `);
    assert.strictEqual(r.value, 'Alice');
  });

  it('accesses properties via index notation', () => {
    const r = run(`
      class Person {
        init(self, name) {
          set self.name = name;
        }
      }
      let p = Person("Bob");
      p["name"];
    `);
    assert.strictEqual(r.value, 'Bob');
  });

  it('creates multiple independent instances', () => {
    const r = run(`
      class Counter {
        init(self, n) {
          set self.n = n;
        }
      }
      let a = Counter(10);
      let b = Counter(20);
      a.n + b.n;
    `);
    assert.strictEqual(r.value, 30);
  });
});

describe('Class: methods', () => {
  it('calls method with explicit self', () => {
    const r = run(`
      class Greeter {
        init(self, name) {
          set self.name = name;
        }
        greet(self) {
          "Hello, " + self.name
        }
      }
      let g = Greeter("World");
      greet(g);
    `);
    assert.strictEqual(r.value, 'Hello, World');
  });

  it('calls method with dot notation', () => {
    const r = run(`
      class Greeter {
        init(self, name) {
          set self.name = name;
        }
        greet(self) {
          "Hello, " + self.name
        }
      }
      let g = Greeter("World");
      g.greet();
    `);
    assert.strictEqual(r.value, 'Hello, World');
  });

  it('method with multiple params', () => {
    const r = run(`
      class Math {
        init(self) {}
        add(self, a, b) {
          a + b
        }
      }
      let m = Math();
      m.add(3, 4);
    `);
    assert.strictEqual(r.value, 7);
  });

  it('method accesses instance properties', () => {
    const r = run(`
      class Circle {
        init(self, r) {
          set self.radius = r;
        }
        area(self) {
          3 * self.radius * self.radius
        }
      }
      let c = Circle(5);
      c.area();
    `);
    assert.strictEqual(r.value, 75);
  });

  it('multiple methods on same class', () => {
    const r = run(`
      class Animal {
        init(self, name, sound) {
          set self.name = name;
          set self.sound = sound;
        }
        speak(self) {
          self.name + " says " + self.sound
        }
        name_only(self) {
          self.name
        }
      }
      let a = Animal("Rex", "woof");
      a.speak() + " (" + a.name_only() + ")";
    `);
    assert.strictEqual(r.value, 'Rex says woof (Rex)');
  });
});

describe('Class: property mutation', () => {
  it('set statement mutates property', () => {
    const r = run(`
      class Box {
        init(self, val) {
          set self.value = val;
        }
        set_value(self, v) {
          set self.value = v;
        }
      }
      let b = Box(10);
      set_value(b, 42);
      b.value;
    `);
    assert.strictEqual(r.value, 42);
  });

  it('set with index notation', () => {
    const r = run(`
      let obj = {};
      set obj["x"] = 10;
      set obj["y"] = 20;
      obj["x"] + obj["y"];
    `);
    assert.strictEqual(r.value, 30);
  });

  it('set with dot notation', () => {
    const r = run(`
      let obj = {};
      set obj.x = 10;
      set obj.y = 20;
      obj.x + obj.y;
    `);
    assert.strictEqual(r.value, 30);
  });
});

describe('Class: class without init', () => {
  it('class with only methods returns empty hash', () => {
    const r = run(`
      class Utils {
        double(self, x) {
          x * 2
        }
      }
      let u = Utils();
      u.double(21);
    `);
    assert.strictEqual(r.value, 42);
  });
});

describe('Class: edge cases', () => {
  it('class with no methods', () => {
    const r = run(`
      class Empty {}
      let e = Empty();
      type(e);
    `);
    assert.strictEqual(r.value, 'HASH');
  });

  it('multiple classes in scope', () => {
    const r = run(`
      class Dog {
        init(self, name) { set self.name = name; }
        speak(self) { self.name + " barks" }
      }
      class Cat {
        init(self, name) { set self.name = name; }
        purr(self) { self.name + " purrs" }
      }
      let d = Dog("Rex");
      let c = Cat("Whiskers");
      d.speak() + " and " + c.purr();
    `);
    assert.strictEqual(r.value, 'Rex barks and Whiskers purrs');
  });
});
