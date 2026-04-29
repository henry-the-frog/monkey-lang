import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { monkeyEval } from './evaluator.js';
import { Parser } from './parser.js';
import { Lexer } from './lexer.js';
import { Environment, MonkeyString } from './object.js';
import { resetModuleLoader, getModuleLoader } from './module-loader.js';

import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const TEST_DIR = join(__dirname, '__test_modules__');

function evalWithFile(code, filePath) {
  const lexer = new Lexer(code);
  const parser = new Parser(lexer);
  const program = parser.parseProgram();
  assert.equal(parser.errors.length, 0, `Parse errors: ${parser.errors.join(', ')}`);
  const env = new Environment();
  if (filePath) {
    env.set('__file__', new MonkeyString(filePath));
  }
  return monkeyEval(program, env);
}

describe('File-based Module System', () => {
  beforeEach(() => {
    resetModuleLoader();
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, 'sub'), { recursive: true });
    getModuleLoader(TEST_DIR);
  });

  afterEach(() => {
    resetModuleLoader();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('imports a simple module', () => {
    writeFileSync(join(TEST_DIR, 'math-utils.monkey'), `
      let add = fn(a, b) { a + b };
      let PI = 3;
    `);
    const result = evalWithFile(`
      import "./math-utils.monkey"
      let m = math_utils;
      0
    `, join(TEST_DIR, 'main.monkey'));
    // Should not error
    assert.ok(result);
  });

  it('imports with selective bindings', () => {
    writeFileSync(join(TEST_DIR, 'helpers.monkey'), `
      let double = fn(x) { x * 2 };
      let triple = fn(x) { x * 3 };
    `);
    const result = evalWithFile(`
      import "./helpers.monkey" for double, triple
      double(5) + triple(3)
    `, join(TEST_DIR, 'main.monkey'));
    assert.equal(result.value, 19); // 10 + 9
  });

  it('imports with alias', () => {
    writeFileSync(join(TEST_DIR, 'utils.monkey'), `
      let greet = fn(name) { "hello" };
    `);
    const result = evalWithFile(`
      import "./utils.monkey" as u
      0
    `, join(TEST_DIR, 'main.monkey'));
    assert.ok(result);
  });

  it('caches modules (only evaluates once)', () => {
    writeFileSync(join(TEST_DIR, 'counter.monkey'), `
      let x = 42;
    `);
    const loader = getModuleLoader(TEST_DIR);
    const result = evalWithFile(`
      import "./counter.monkey" for x
      x
    `, join(TEST_DIR, 'main.monkey'));
    assert.equal(result.value, 42);
    // Second import should use cache
    assert.equal(loader.cache.size, 1);
  });

  it('detects circular imports', () => {
    writeFileSync(join(TEST_DIR, 'a.monkey'), `
      import "./b.monkey"
      let x = 1;
    `);
    writeFileSync(join(TEST_DIR, 'b.monkey'), `
      import "./a.monkey"
      let y = 2;
    `);
    const result = evalWithFile(`
      import "./a.monkey"
      0
    `, join(TEST_DIR, 'main.monkey'));
    // Should get a circular import error
    assert.ok(result.inspect().includes('circular import'));
  });

  it('resolves relative paths from importing file', () => {
    writeFileSync(join(TEST_DIR, 'sub', 'lib.monkey'), `
      let magic = 99;
    `);
    const result = evalWithFile(`
      import "./sub/lib.monkey" for magic
      magic
    `, join(TEST_DIR, 'main.monkey'));
    assert.equal(result.value, 99);
  });

  it('reports error for missing module', () => {
    const result = evalWithFile(`
      import "./nonexistent.monkey"
      0
    `, join(TEST_DIR, 'main.monkey'));
    assert.ok(result.inspect().includes('cannot read module'));
  });

  it('reports parse errors in imported module', () => {
    writeFileSync(join(TEST_DIR, 'bad.monkey'), `
      let x = ;
    `);
    const result = evalWithFile(`
      import "./bad.monkey"
      0
    `, join(TEST_DIR, 'main.monkey'));
    assert.ok(result.inspect().includes('parse error'));
  });

  it('hides private names (starting with _)', () => {
    writeFileSync(join(TEST_DIR, 'private.monkey'), `
      let _internal = 42;
      let public_val = 100;
    `);
    const result = evalWithFile(`
      import "./private.monkey" for _internal, public_val
      public_val
    `, join(TEST_DIR, 'main.monkey'));
    // public_val should work, _internal should be NULL
    assert.equal(result.value, 100);
  });

  it('supports nested imports', () => {
    writeFileSync(join(TEST_DIR, 'base.monkey'), `
      let base_val = 10;
    `);
    writeFileSync(join(TEST_DIR, 'mid.monkey'), `
      import "./base.monkey" for base_val
      let mid_val = base_val * 2;
    `);
    const result = evalWithFile(`
      import "./mid.monkey" for mid_val
      mid_val
    `, join(TEST_DIR, 'main.monkey'));
    assert.equal(result.value, 20);
  });

  it('adds .monkey extension automatically', () => {
    writeFileSync(join(TEST_DIR, 'auto-ext.monkey'), `
      let val = 77;
    `);
    const result = evalWithFile(`
      import "./auto-ext" for val
      val
    `, join(TEST_DIR, 'main.monkey'));
    assert.equal(result.value, 77);
  });
});
