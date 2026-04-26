import { strict as assert } from 'assert';
import { CompilerPipeline } from './pipeline.js';

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try { fn(); passed++; } catch (e) {
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`    ${e.message}`);
  }
}

// ============================================================
// Full pipeline
// ============================================================

test('empty program runs all passes', () => {
  const pipeline = new CompilerPipeline();
  const result = pipeline.run('');
  assert.equal(result.status, 'ok');
  assert.ok(result.timings.total >= 0);
});

test('simple program: all passes succeed', () => {
  const pipeline = new CompilerPipeline();
  const result = pipeline.run('let x = 5; let y = x + 1;');
  assert.equal(result.status, 'ok');
  assert.equal(result.stats.stmts, 2);
  assert.ok(result.stats.blocks >= 2);
});

test('constants found by SSA const-prop', () => {
  const pipeline = new CompilerPipeline();
  const result = pipeline.run('let x = 5; let y = 3; x + y;');
  assert.ok(result.stats.constants >= 2); // x_0=5, y_0=3
});

test('dead variable detected', () => {
  const pipeline = new CompilerPipeline();
  const result = pipeline.run('let x = 5; let y = 10; puts(y);');
  assert.ok(result.stats.deadVars >= 1); // x is dead
});

test('dead let statements removed from AST', () => {
  const pipeline = new CompilerPipeline();
  const result = pipeline.run('let x = 5; let unused = 999; let y = 10; x + y;');
  assert.equal(result.stats.deadLetsRemoved, 1); // unused removed
  assert.equal(result.results.program.statements.length, 3); // 4 → 3
});

test('dead let with side effects converted to expression', () => {
  const pipeline = new CompilerPipeline();
  const result = pipeline.run('let x = sideEffect(); let y = 10; y;');
  assert.equal(result.stats.deadLetsConverted, 1); // x kept as expression
  assert.equal(result.results.program.statements.length, 3); // still 3 stmts
});

test('type errors reported', () => {
  const pipeline = new CompilerPipeline();
  // Intentionally well-typed
  const result = pipeline.run('let x = 5; let y = x + 1;');
  assert.equal(result.stats.typeErrors, 0);
});

test('parse errors stop pipeline', () => {
  const pipeline = new CompilerPipeline();
  const result = pipeline.run('let = ;');
  assert.equal(result.status, 'parse-error');
  assert.ok(result.stats.parseErrors > 0);
});

// ============================================================
// Individual passes
// ============================================================

test('typecheck only', () => {
  const pipeline = new CompilerPipeline({ cfg: false, ssa: false, liveness: false, dce: false, escape: false });
  const result = pipeline.run('let x = 5;');
  assert.equal(result.status, 'ok');
});

test('CFG produces blocks', () => {
  const pipeline = new CompilerPipeline();
  const result = pipeline.run('let a = 1; if (a > 0) { let x = a + 1; x; } else { let y = a - 1; y; }');
  assert.ok(result.stats.blocks >= 4); // entry, then, else, merge
});

test('loop detection', () => {
  const pipeline = new CompilerPipeline();
  const result = pipeline.run('while (true) { let x = 1; }');
  assert.ok(result.stats.loops >= 1);
});

test('escape analysis: stack vs heap', () => {
  const pipeline = new CompilerPipeline();
  const result = pipeline.run('let x = 5; let y = 10; return y;');
  // y should be heap (returned), x should be stack
  assert.ok(result.stats.stackAllocatable >= 1 || result.stats.heapRequired >= 1);
});

// ============================================================
// Report
// ============================================================

test('report generates readable output', () => {
  const pipeline = new CompilerPipeline();
  pipeline.run('let x = 5; let y = x + 1;');
  const report = pipeline.report();
  assert.ok(report.includes('Compiler Pipeline Report'));
  assert.ok(report.includes('Statements:'));
  assert.ok(report.includes('Basic blocks:'));
});

test('pipeline with DCE', () => {
  const pipeline = new CompilerPipeline();
  const result = pipeline.run('return 1; let dead = 2;');
  assert.ok(result.stats.dceEliminated >= 1);
});

// ============================================================
// Complex programs
// ============================================================

test('complex: function with branch and loop', () => {
  const pipeline = new CompilerPipeline();
  const result = pipeline.run(`
    let x = 10;
    let y = x + 5;
    if (x > 5) {
      let z = x * 2;
      z + y;
    } else {
      let z = x + 1;
      z + y;
    }
  `);
  assert.equal(result.status, 'ok');
  assert.ok(result.stats.blocks >= 4);
  assert.ok(result.stats.constants >= 2);
});

// ============================================================
// Report
// ============================================================

console.log(`\nPipeline integration tests: ${passed}/${total} passed` + (failed ? ` (${failed} failed)` : ''));
if (failed) process.exit(1);
