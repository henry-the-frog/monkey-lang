import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { monkeyEval } from './evaluator.js';
import { Environment } from './object.js';

function evaluate(code) {
  const l = new Lexer(code);
  const p = new Parser(l);
  const program = p.parseProgram();
  if (p.errors.length > 0) throw new Error('Parse: ' + p.errors.join(', '));
  return monkeyEval(program, new Environment());
}

describe('All Dunder Protocols', () => {
  it('__getitem__ + __setitem__ + __len__ + __iter__ + toString', () => {
    const r = evaluate(`
      class SmartArray {
        let data;
        fn init() { self.data = []; }
        fn __getitem__(idx) { self.data[idx]; }
        fn __setitem__(idx, val) { self.data[idx] = val; }
        fn __len__() { len(self.data); }
        fn __iter__() { self.data; }
        fn append(val) { self.data = push(self.data, val); self; }
        fn toString() {
          let items = [];
          for (x in self) { items = push(items, str(x)); };
          "SmartArray(" + reduce(items, fn(a, b) { a + ", " + b }) + ")";
        }
      }
      let sa = SmartArray().append(10).append(20).append(30);
      sa[1] = 99;
      [sa[0], sa[1], sa[2], len(sa), str(sa)];
    `);
    assert.equal(r.elements[0].value, 10);
    assert.equal(r.elements[1].value, 99);
    assert.equal(r.elements[2].value, 30);
    assert.equal(r.elements[3].value, 3);
    assert.equal(r.elements[4].value, 'SmartArray(10, 99, 30)');
  });

  it('operator overloading chain: Complex numbers', () => {
    const r = evaluate(`
      class Complex {
        let re; let im;
        fn init(re, im) { self.re = re; self.im = im; }
        fn __add__(o) { Complex(self.re + o.re, self.im + o.im); }
        fn __sub__(o) { Complex(self.re - o.re, self.im - o.im); }
        fn __mul__(o) {
          Complex(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re);
        }
        fn __eq__(o) { self.re == o.re && self.im == o.im; }
        fn mag_sq() { self.re * self.re + self.im * self.im; }
        fn toString() { str(self.re) + "+" + str(self.im) + "i"; }
      }
      let a = Complex(3, 4);
      let b = Complex(1, 2);
      let c = a + b;
      let d = a * b;
      [str(c), str(d), a.mag_sq(), (a + a) == Complex(6, 8)];
    `);
    assert.equal(r.elements[0].value, '4+6i');
    assert.equal(r.elements[1].value, '-5+10i');
    assert.equal(r.elements[2].value, 25);
    assert.equal(r.elements[3].inspect(), 'true');
  });

  it('full stdlib pipeline with classes', () => {
    const r = evaluate(`
      class Student {
        let name; let grade;
        fn init(n, g) { self.name = n; self.grade = g; }
        fn toString() { self.name + ":" + str(self.grade); }
      }
      let students = [
        Student("Alice", 95),
        Student("Bob", 82),
        Student("Carol", 91),
        Student("Dave", 78),
        Student("Eve", 88)
      ];
      let honors = filter(students, fn(s) { s.grade >= 90 });
      let names = map(honors, fn(s) { s.name });
      let avg = reduce(map(students, fn(s) { s.grade }), fn(a, b) { a + b }, 0.0) / len(students);
      [names, avg];
    `);
    assert.deepEqual(r.elements[0].elements.map(e => e.value), ['Alice', 'Carol']);
    // (95+82+91+78+88)/5 = 434/5 = 86.8
    assert.ok(Math.abs(r.elements[1].value - 86.8) < 0.01);
  });

  it('generator + class + field access', () => {
    const r = evaluate(`
      class Pair {
        let first; let second;
        fn init(a, b) { self.first = a; self.second = b; }
      }
      
      let pair_gen = gen(n) {
        let i = 0;
        while (i < n) {
          yield Pair(i, i * i);
          i = i + 1;
        };
      };
      
      let sum_sq = 0;
      for (p in pair_gen(5)) {
        sum_sq = sum_sq + p.second;
      };
      sum_sq;
    `);
    // 0 + 1 + 4 + 9 + 16 = 30
    assert.equal(r.value, 30);
  });
});
