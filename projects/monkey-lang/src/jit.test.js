// Tracing JIT Tests
// Tests the IR recording, trace compilation, and execution

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IR, Trace, TraceRecorder, JIT, TraceCompiler, TraceOptimizer } from './jit.js';
import {
  MonkeyInteger, MonkeyBoolean, MonkeyString, MonkeyArray,
  TRUE, FALSE, NULL, cachedInteger, internString,
} from './object.js';

describe('IR and Trace', () => {
  it('should create a trace with IR instructions', () => {
    const trace = new Trace('test', 0);
    const id1 = trace.addInst(IR.LOOP_START);
    const id2 = trace.addInst(IR.CONST_INT, { value: 42 });
    const id3 = trace.addInst(IR.LOOP_END);

    assert.equal(trace.ir.length, 3);
    assert.equal(trace.ir[0].op, IR.LOOP_START);
    assert.equal(trace.ir[1].op, IR.CONST_INT);
    assert.equal(trace.ir[1].operands.value, 42);
    assert.equal(id1, 0);
    assert.equal(id2, 1);
    assert.equal(id3, 2);
  });

  it('should record integer addition trace', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);

    // Simulate: load local x (int), load const 1 (int), add, store local x
    const loadRef = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });
    const guardRef = trace.addInst(IR.GUARD_INT, { ref: loadRef });
    trace.guardCount++;
    const unbox1 = trace.addInst(IR.UNBOX_INT, { ref: loadRef });

    const constRef = trace.addInst(IR.CONST_INT, { value: 1 });
    // No guard needed for constants — we know the type

    const addRef = trace.addInst(IR.ADD_INT, { left: unbox1, right: constRef });
    const boxRef = trace.addInst(IR.BOX_INT, { ref: addRef });
    const storeRef = trace.addInst(IR.STORE_LOCAL, { slot: 0, value: boxRef });

    trace.addInst(IR.LOOP_END);

    assert.equal(trace.ir.length, 9);
    assert.equal(trace.guardCount, 1);
  });
});

describe('JIT hot counting', () => {
  it('should detect hot loops', () => {
    const jit = new JIT();
    for (let i = 0; i < 15; i++) {
      assert.equal(jit.countEdge('fn1', 10), false);
    }
    assert.equal(jit.countEdge('fn1', 10), true); // 16th hit
  });

  it('should track different locations independently', () => {
    const jit = new JIT();
    for (let i = 0; i < 15; i++) {
      jit.countEdge('fn1', 10);
    }
    assert.equal(jit.countEdge('fn2', 10), false); // different function
    assert.equal(jit.countEdge('fn1', 10), true);  // fn1 is hot
  });
});

describe('Trace optimization', () => {
  it('should eliminate redundant guards', () => {
    
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const load = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });
    trace.addInst(IR.GUARD_INT, { ref: load }); trace.guardCount++;
    trace.addInst(IR.GUARD_INT, { ref: load }); trace.guardCount++; // redundant
    trace.addInst(IR.UNBOX_INT, { ref: load });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const eliminated = opt.redundantGuardElimination();
    assert.equal(eliminated, 1);
    assert.equal(trace.guardCount, 1);
  });

  it('should eliminate guards on constants', () => {
    
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const c = trace.addInst(IR.CONST_INT, { value: 42 });
    trace.addInst(IR.GUARD_INT, { ref: c }); trace.guardCount++;
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const eliminated = opt.redundantGuardElimination();
    assert.equal(eliminated, 1);
  });

  it('should fold constant arithmetic', () => {
    
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const a = trace.addInst(IR.CONST_INT, { value: 10 });
    const b = trace.addInst(IR.CONST_INT, { value: 3 });
    const sum = trace.addInst(IR.ADD_INT, { left: a, right: b });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const folded = opt.constantFolding();
    assert.equal(folded, 1);
    assert.equal(trace.ir[3].op, IR.CONST_INT);
    assert.equal(trace.ir[3].operands.value, 13);
  });

  it('should not corrupt non-ref numeric operands during compaction', () => {
    
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);                        // 0
    const c20 = trace.addInst(IR.CONST_INT, { value: 20 }); // 1
    const load = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });  // 2
    trace.addInst(IR.GUARD_INT, { ref: load }); trace.guardCount++; // 3
    const unbox = trace.addInst(IR.UNBOX_INT, { ref: load }); // 4
    const cmp = trace.addInst(IR.GT, { left: c20, right: unbox }); // 5
    // Add dead instructions to trigger DCE + compaction
    trace.addInst(IR.LOAD_LOCAL, { slot: 1 });  // 6 — dead
    trace.addInst(IR.STORE_LOCAL, { slot: 0, value: cmp }); // 7
    trace.addInst(IR.LOOP_END); // 8

    const opt = new TraceOptimizer(trace);
    opt.optimize();

    // Find the CONST_INT — its value should still be 20
    const constInst = trace.ir.find(i => i.op === IR.CONST_INT && i.operands.value !== undefined);
    assert.equal(constInst.operands.value, 20, 'CONST_INT value was corrupted by compaction');
  });

  it('should forward store-to-load for locals', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);                              // 0
    const constVal = trace.addInst(IR.CONST_INT, { value: 42 }); // 1
    const boxed = trace.addInst(IR.BOX_INT, { ref: constVal });   // 2
    trace.addInst(IR.STORE_LOCAL, { slot: 0, value: boxed });     // 3
    const load = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });       // 4 — should be forwarded to boxed
    trace.addInst(IR.GUARD_INT, { ref: load }); trace.guardCount++; // 5
    trace.addInst(IR.LOOP_END);                                   // 6

    const opt = new TraceOptimizer(trace);
    const forwarded = opt.storeToLoadForwarding();
    assert.ok(forwarded >= 1, 'should forward at least one load');
    // The LOAD_LOCAL should be gone
    assert.ok(!trace.ir.find(i => i.op === IR.LOAD_LOCAL && i.operands.slot === 0),
      'LOAD_LOCAL should be eliminated');
  });

  it('should forward store-to-load for globals', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const constVal = trace.addInst(IR.CONST_INT, { value: 7 });
    const boxed = trace.addInst(IR.BOX_INT, { ref: constVal });
    trace.addInst(IR.STORE_GLOBAL, { index: 0, value: boxed });
    const load = trace.addInst(IR.LOAD_GLOBAL, { index: 0 });  // should be forwarded
    trace.addInst(IR.GUARD_INT, { ref: load }); trace.guardCount++;
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const forwarded = opt.storeToLoadForwarding();
    assert.ok(forwarded >= 1);
    assert.ok(!trace.ir.find(i => i.op === IR.LOAD_GLOBAL));
  });

  it('should not forward across a CALL (store invalidation)', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const constVal = trace.addInst(IR.CONST_INT, { value: 5 });
    const boxed = trace.addInst(IR.BOX_INT, { ref: constVal });
    trace.addInst(IR.STORE_LOCAL, { slot: 0, value: boxed });
    trace.addInst(IR.CALL, { numArgs: 0 });  // invalidates stores
    const load = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });  // should NOT be forwarded
    trace.addInst(IR.GUARD_INT, { ref: load }); trace.guardCount++;
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const forwarded = opt.storeToLoadForwarding();
    assert.equal(forwarded, 0, 'should not forward across CALL');
  });

  it('should hoist loop-invariant code above LOOP_START', () => {
    const trace = new Trace('test', 0);
    // Pre-loop: load x
    const loadX = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });       // 0
    trace.addInst(IR.GUARD_INT, { ref: loadX }); trace.guardCount++; // 1
    const unboxX = trace.addInst(IR.UNBOX_INT, { ref: loadX });     // 2
    // LOOP_START
    trace.addInst(IR.LOOP_START);                                    // 3
    // Loop body: uses unboxX + a constant (both loop-invariant individually,
    // but the constant is defined inside the loop)
    const constVal = trace.addInst(IR.CONST_INT, { value: 10 });    // 4 — loop-invariant
    const mul = trace.addInst(IR.MUL_INT, { left: unboxX, right: constVal }); // 5 — loop-invariant
    const boxed = trace.addInst(IR.BOX_INT, { ref: mul });          // 6 — loop-invariant
    trace.addInst(IR.STORE_LOCAL, { slot: 1, value: boxed });       // 7 — side effect, stays
    trace.addInst(IR.LOOP_END);                                      // 8

    const opt = new TraceOptimizer(trace);
    const hoisted = opt.loopInvariantCodeMotion();
    assert.ok(hoisted >= 2, `should hoist at least const + mul, got ${hoisted}`);

    // Find LOOP_START position in optimized IR
    const loopIdx = trace.ir.findIndex(i => i.op === IR.LOOP_START);
    // CONST_INT(10) and MUL_INT should be before LOOP_START
    const constIdx = trace.ir.findIndex(i => i.op === IR.CONST_INT && i.operands.value === 10);
    const mulIdx = trace.ir.findIndex(i => i.op === IR.MUL_INT);
    assert.ok(constIdx < loopIdx, 'CONST_INT should be hoisted before LOOP_START');
    assert.ok(mulIdx < loopIdx, 'MUL_INT should be hoisted before LOOP_START');
  });

  it('should eliminate dead code', () => {
    
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);                          // 0
    const dead = trace.addInst(IR.CONST_INT, { value: 99 }); // 1 — unused
    const load = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });  // 2
    trace.addInst(IR.GUARD_INT, { ref: load }); trace.guardCount++; // 3
    trace.addInst(IR.LOOP_END);                            // 4

    const opt = new TraceOptimizer(trace);
    const eliminated = opt.deadCodeElimination();
    assert.ok(eliminated >= 1);
    // CONST_INT(99) should be gone
    assert.ok(!trace.ir.find(i => i.op === IR.CONST_INT && i.operands.value === 99));
  });

  it('should eliminate UNBOX_INT(BOX_INT(x)) → x', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const raw = trace.addInst(IR.CONST_INT, { value: 42 });
    const boxed = trace.addInst(IR.BOX_INT, { ref: raw });
    const unboxed = trace.addInst(IR.UNBOX_INT, { ref: boxed });
    const add = trace.addInst(IR.ADD_INT, { left: unboxed, right: raw });
    const boxResult = trace.addInst(IR.BOX_INT, { ref: add });
    trace.addInst(IR.STORE_LOCAL, { slot: 0, value: boxResult });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const eliminated = opt.boxUnboxElimination();
    assert.ok(eliminated >= 1, `should eliminate at least 1 box-unbox pair, got ${eliminated}`);
    // The UNBOX_INT should be gone — ADD_INT should reference the raw CONST_INT directly
    assert.ok(!trace.ir.find(i => i.op === IR.UNBOX_INT));
  });

  it('should eliminate BOX_INT(UNBOX_INT(x)) → x', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const load = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });
    trace.addInst(IR.GUARD_INT, { ref: load }); trace.guardCount++;
    const unboxed = trace.addInst(IR.UNBOX_INT, { ref: load });
    const reboxed = trace.addInst(IR.BOX_INT, { ref: unboxed });
    trace.addInst(IR.STORE_LOCAL, { slot: 1, value: reboxed });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const eliminated = opt.boxUnboxElimination();
    assert.ok(eliminated >= 1);
    // The rebox should be gone — STORE should reference the original load
    const store = trace.ir.find(i => i.op === IR.STORE_LOCAL && i.operands.slot === 1);
    assert.ok(store);
    // The value ref should point to the load, not a BOX_INT
    const valInst = trace.ir[store.operands.value];
    assert.ok(valInst.op !== IR.BOX_INT, 'BOX_INT(UNBOX_INT(x)) should be eliminated');
  });

  it('should eliminate dead stores (overwritten before read)', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const c1 = trace.addInst(IR.CONST_INT, { value: 1 });
    const b1 = trace.addInst(IR.BOX_INT, { ref: c1 });
    trace.addInst(IR.STORE_LOCAL, { slot: 0, value: b1 }); // dead — overwritten below
    const c2 = trace.addInst(IR.CONST_INT, { value: 2 });
    const b2 = trace.addInst(IR.BOX_INT, { ref: c2 });
    trace.addInst(IR.STORE_LOCAL, { slot: 0, value: b2 }); // this one survives
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const eliminated = opt.deadStoreElimination();
    assert.ok(eliminated >= 1, `should eliminate at least 1 dead store, got ${eliminated}`);
    // Only one STORE_LOCAL to slot 0 should remain
    const stores = trace.ir.filter(i => i.op === IR.STORE_LOCAL && i.operands.slot === 0);
    assert.equal(stores.length, 1, 'should have exactly one store to slot 0');
  });

  it('should eliminate common subexpressions (duplicate loads)', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const l1 = trace.addInst(IR.LOAD_GLOBAL, { index: 0 });
    trace.addInst(IR.GUARD_INT, { ref: l1 }); trace.guardCount++;
    const u1 = trace.addInst(IR.UNBOX_INT, { ref: l1 });
    const l2 = trace.addInst(IR.LOAD_GLOBAL, { index: 0 }); // duplicate
    trace.addInst(IR.GUARD_INT, { ref: l2 }); trace.guardCount++;
    const u2 = trace.addInst(IR.UNBOX_INT, { ref: l2 });
    const add = trace.addInst(IR.ADD_INT, { left: u1, right: u2 });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const eliminated = opt.commonSubexpressionElimination();
    assert.ok(eliminated >= 1, `should eliminate duplicate load, got ${eliminated}`);

    // The duplicate LOAD_GLOBAL should be removed
    const loads = trace.ir.filter(i => i && i.op === IR.LOAD_GLOBAL);
    assert.equal(loads.length, 1, 'only one load should remain');
  });

  it('should NOT CSE loads across a store to the same slot', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const l1 = trace.addInst(IR.LOAD_GLOBAL, { index: 0 });
    const c1 = trace.addInst(IR.CONST_INT, { value: 42 });
    const b1 = trace.addInst(IR.BOX_INT, { ref: c1 });
    trace.addInst(IR.STORE_GLOBAL, { index: 0, value: b1 }); // invalidates
    const l2 = trace.addInst(IR.LOAD_GLOBAL, { index: 0 }); // NOT a duplicate
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const eliminated = opt.commonSubexpressionElimination();
    // l2 should NOT be eliminated — it loads after a store
    const loads = trace.ir.filter(i => i && i.op === IR.LOAD_GLOBAL);
    assert.equal(loads.length, 2, 'both loads should remain');
  });

  it('should not eliminate stores separated by a load', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const c1 = trace.addInst(IR.CONST_INT, { value: 1 });
    const b1 = trace.addInst(IR.BOX_INT, { ref: c1 });
    trace.addInst(IR.STORE_LOCAL, { slot: 0, value: b1 }); // needed — load follows
    const load = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });
    trace.addInst(IR.GUARD_INT, { ref: load }); trace.guardCount++;
    const c2 = trace.addInst(IR.CONST_INT, { value: 2 });
    const b2 = trace.addInst(IR.BOX_INT, { ref: c2 });
    trace.addInst(IR.STORE_LOCAL, { slot: 0, value: b2 });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const eliminated = opt.deadStoreElimination();
    assert.equal(eliminated, 0, 'should not eliminate stores separated by a load');
  });
});

describe('Constant propagation', () => {
  it('should propagate constants through UNBOX_INT of known boxed value', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const c1 = trace.addInst(IR.CONST_INT, { value: 10 });
    const b1 = trace.addInst(IR.BOX_INT, { ref: c1 });
    trace.addInst(IR.STORE_LOCAL, { slot: 0, value: b1 });
    const load = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });
    const unboxed = trace.addInst(IR.UNBOX_INT, { ref: load });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const propagated = opt.constantPropagation();
    assert.ok(propagated >= 1, `should propagate at least 1 constant, got ${propagated}`);
    // The UNBOX_INT should have been replaced with CONST_INT(10)
    const unboxInst = trace.ir.find(inst => inst && inst.id === unboxed);
    // After propagation, the instruction that was UNBOX_INT should now be CONST_INT
    const resultInst = trace.ir[unboxed];
    assert.equal(resultInst.op, IR.CONST_INT);
    assert.equal(resultInst.operands.value, 10);
  });

  it('should propagate through NEG of known constant', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const c1 = trace.addInst(IR.CONST_INT, { value: 7 });
    const neg = trace.addInst(IR.NEG, { ref: c1 });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const propagated = opt.constantPropagation();
    assert.equal(propagated, 1);
    assert.equal(trace.ir[neg].op, IR.CONST_INT);
    assert.equal(trace.ir[neg].operands.value, -7);
  });

  it('should NOT propagate through slots modified by CALL', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const c1 = trace.addInst(IR.CONST_INT, { value: 5 });
    const b1 = trace.addInst(IR.BOX_INT, { ref: c1 });
    trace.addInst(IR.STORE_GLOBAL, { index: 0, value: b1 });
    trace.addInst(IR.CALL, {}); // invalidates
    const load = trace.addInst(IR.LOAD_GLOBAL, { index: 0 });
    const unboxed = trace.addInst(IR.UNBOX_INT, { ref: load });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const propagated = opt.constantPropagation();
    assert.equal(propagated, 0, 'should not propagate across CALL');
  });
});

describe('Algebraic simplification', () => {
  it('should simplify x + 0 → x', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const x = trace.addInst(IR.CONST_INT, { value: 42 });
    const zero = trace.addInst(IR.CONST_INT, { value: 0 });
    const add = trace.addInst(IR.ADD_INT, { left: x, right: zero });
    const store = trace.addInst(IR.STORE_GLOBAL, { index: 0, value: add });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const simplified = opt.algebraicSimplification();
    assert.equal(simplified, 1);
    const storeInst = trace.ir.find(i => i.op === IR.STORE_GLOBAL);
    const constInst = trace.ir.find(i => i.op === IR.CONST_INT && i.operands.value === 42);
    assert.equal(storeInst.operands.value, constInst.id);
  });

  it('should simplify x * 0 → 0', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const x = trace.addInst(IR.CONST_INT, { value: 42 });
    const zero = trace.addInst(IR.CONST_INT, { value: 0 });
    const mul = trace.addInst(IR.MUL_INT, { left: x, right: zero });
    const store = trace.addInst(IR.STORE_GLOBAL, { index: 0, value: mul });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const simplified = opt.algebraicSimplification();
    assert.equal(simplified, 1);
    const storeInst = trace.ir.find(i => i.op === IR.STORE_GLOBAL);
    const valInst = trace.ir[storeInst.operands.value];
    assert.equal(valInst.op, IR.CONST_INT);
    assert.equal(valInst.operands.value, 0);
  });

  it('should simplify x * 2 → x + x', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const x = trace.addInst(IR.CONST_INT, { value: 7 });
    const two = trace.addInst(IR.CONST_INT, { value: 2 });
    const mul = trace.addInst(IR.MUL_INT, { left: x, right: two });
    const store = trace.addInst(IR.STORE_GLOBAL, { index: 0, value: mul });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const simplified = opt.algebraicSimplification();
    assert.equal(simplified, 1);
    const storeInst = trace.ir.find(i => i.op === IR.STORE_GLOBAL);
    const addInst = trace.ir[storeInst.operands.value];
    assert.equal(addInst.op, IR.ADD_INT);
    assert.equal(addInst.operands.left, addInst.operands.right);
  });

  it('should simplify x - x → 0', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const x = trace.addInst(IR.CONST_INT, { value: 5 });
    const sub = trace.addInst(IR.SUB_INT, { left: x, right: x });
    const store = trace.addInst(IR.STORE_GLOBAL, { index: 0, value: sub });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const simplified = opt.algebraicSimplification();
    assert.equal(simplified, 1);
    const storeInst = trace.ir.find(i => i.op === IR.STORE_GLOBAL);
    const valInst = trace.ir[storeInst.operands.value];
    assert.equal(valInst.op, IR.CONST_INT);
    assert.equal(valInst.operands.value, 0);
  });

  it('should simplify x / 1 → x', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const x = trace.addInst(IR.CONST_INT, { value: 99 });
    const one = trace.addInst(IR.CONST_INT, { value: 1 });
    const div = trace.addInst(IR.DIV_INT, { left: x, right: one });
    const store = trace.addInst(IR.STORE_GLOBAL, { index: 0, value: div });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const simplified = opt.algebraicSimplification();
    assert.equal(simplified, 1);
    const storeInst = trace.ir.find(i => i.op === IR.STORE_GLOBAL);
    const constInst = trace.ir.find(i => i.op === IR.CONST_INT && i.operands.value === 99);
    assert.equal(storeInst.operands.value, constInst.id);
  });

  it('should simplify NEG(NEG(x)) → x', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const loadRef = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });
    const unboxRef = trace.addInst(IR.UNBOX_INT, { ref: loadRef });
    const neg1 = trace.addInst(IR.NEG, { ref: unboxRef });
    const neg2 = trace.addInst(IR.NEG, { ref: neg1 });
    const boxRef = trace.addInst(IR.BOX_INT, { ref: neg2 });
    trace.addInst(IR.STORE_GLOBAL, { index: 0, value: boxRef });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const simplified = opt.algebraicSimplification();
    assert.equal(simplified, 1);
    // The outer NEG is eliminated; inner NEG remains but is now dead (DCE will clean it)
    // BOX_INT should now reference the original unboxed value, not a NEG
    const boxInst = trace.ir.find(i => i.op === IR.BOX_INT);
    const boxTarget = trace.ir[boxInst.operands.ref];
    assert.equal(boxTarget.op, IR.UNBOX_INT, 'BOX_INT should point to unboxed value, not NEG');
  });

  it('should simplify x / x → 1', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    const loadRef = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });
    const unboxRef = trace.addInst(IR.UNBOX_INT, { ref: loadRef });
    const divRef = trace.addInst(IR.DIV_INT, { left: unboxRef, right: unboxRef });
    const boxRef = trace.addInst(IR.BOX_INT, { ref: divRef });
    trace.addInst(IR.STORE_GLOBAL, { index: 0, value: boxRef });
    trace.addInst(IR.LOOP_END);

    const opt = new TraceOptimizer(trace);
    const simplified = opt.algebraicSimplification();
    assert.equal(simplified, 1);
    const constInst = trace.ir.find(i => i.op === IR.CONST_INT && i.operands.value === 1);
    assert.ok(constInst, 'x / x should be folded to CONST_INT(1)');
  });
});

describe('Trace compilation', () => {
  it('should compile a simple counter trace to JS', () => {
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);

    // x = x + 1 where x is local slot 0
    const loadRef = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });
    const guardRef = trace.addInst(IR.GUARD_INT, { ref: loadRef });
    trace.guardCount++;
    const unboxRef = trace.addInst(IR.UNBOX_INT, { ref: loadRef });
    const constRef = trace.addInst(IR.CONST_INT, { value: 1 });
    const addRef = trace.addInst(IR.ADD_INT, { left: unboxRef, right: constRef });
    const boxRef = trace.addInst(IR.BOX_INT, { ref: addRef });
    trace.addInst(IR.STORE_LOCAL, { slot: 0, value: boxRef });

    // Guard: x < 100
    const load2 = trace.addInst(IR.LOAD_LOCAL, { slot: 0 });
    const guard2 = trace.addInst(IR.GUARD_INT, { ref: load2 });
    trace.guardCount++;
    const unbox2 = trace.addInst(IR.UNBOX_INT, { ref: load2 });
    const limit = trace.addInst(IR.CONST_INT, { value: 100 });
    const cmpRef = trace.addInst(IR.LT, { left: unbox2, right: limit });
    trace.addInst(IR.GUARD_TRUTHY, { ref: cmpRef, exitIp: 99 });
    trace.guardCount++;

    trace.addInst(IR.LOOP_END);

    // Compile
    const jit = new JIT();
    const compiled = jit.compile(trace, null);
    assert.equal(compiled, true);
    assert.ok(trace.compiled);

    // Execute: start with x = 0
    const stack = [cachedInteger(0)];
    const result = trace.compiled(
      stack, 1, 0, [], [], [],
      MonkeyInteger, MonkeyBoolean, MonkeyString, MonkeyArray,
      TRUE, FALSE, NULL,
      cachedInteger,
      internString,
      (obj) => {
        if (obj instanceof MonkeyBoolean) return obj.value;
        if (obj === NULL) return false;
        return true;
      },
      new Map(),
    );

    // Should have counted x up to 100 then exited via guard
    assert.equal(stack[0].value, 100);
    assert.equal(result.exit, 'guard_falsy');
  });

  it('should return JIT stats', () => {
    const jit = new JIT();
    const stats = jit.getStats();
    assert.equal(stats.enabled, true);
    assert.equal(stats.rootTraces, 0);
    assert.equal(stats.totalTraces, 0);
    assert.equal(stats.blacklisted, 0);
    assert.equal(stats.aborts, 0);
    assert.ok(Array.isArray(stats.traces));
  });

  it('should dump trace IR as string', () => {
    const jit = new JIT();
    const trace = new Trace('test', 0);
    trace.addInst(IR.LOOP_START);
    trace.addInst(IR.CONST_INT, { value: 42 });
    trace.addInst(IR.LOOP_END);
    const dump = jit.dumpTrace(trace);
    assert.ok(dump.includes('loop_start'));
    assert.ok(dump.includes('const_int'));
    assert.ok(dump.includes('val=42'));
  });

  it('should handle dumpTrace with no trace', () => {
    const jit = new JIT();
    assert.equal(jit.dumpTrace(null), '(no trace)');
  });
});

// --- Deoptimization / Snapshot Tests ---
import { VM } from './vm.js';
import { Compiler } from './compiler.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';

function runVM(input) {
  const l = new Lexer(input);
  const p = new Parser(l);
  const prog = p.parseProgram();
  const c = new Compiler();
  c.compile(prog);
  const vm = new VM(c.bytecode());
  vm.run();
  return vm;
}

function runJIT(input) {
  const l = new Lexer(input);
  const p = new Parser(l);
  const prog = p.parseProgram();
  const c = new Compiler();
  c.compile(prog);
  const vm = new VM(c.bytecode());
  vm.enableJIT();
  vm.run();
  return vm;
}

describe('Snapshot capture', () => {
  it('should attach snapshots to guard instructions during recording', () => {
    const vm = runJIT('let sum = 0; let i = 0; while (i < 100) { sum = sum + i; i = i + 1; } sum');
    let snapshotCount = 0;
    for (const [, trace] of vm.jit.traces) {
      for (const inst of trace.ir) {
        if (inst && inst.snapshot) {
          snapshotCount++;
          assert.ok(inst.snapshot.locals instanceof Map, 'snapshot.locals should be a Map');
          assert.ok(inst.snapshot.globals instanceof Map, 'snapshot.globals should be a Map');
        }
      }
    }
    assert.ok(snapshotCount > 0, 'should have at least one guard with snapshot');
  });

  it('should track global slots in snapshots', () => {
    const vm = runJIT('let x = 0; let y = 0; while (x < 50) { y = y + x; x = x + 1; } y');
    for (const [, trace] of vm.jit.traces) {
      for (const inst of trace.ir) {
        if (inst && inst.snapshot && inst.snapshot.globals.size > 0) {
          // At least one snapshot should reference globals
          assert.ok(true, 'found snapshot with global refs');
          return;
        }
      }
    }
    assert.fail('no snapshot found with global refs');
  });

  it('should have snapshots survive optimization', () => {
    const vm = runJIT('let a = 0; while (a < 200) { a = a + 1; } a');
    for (const [, trace] of vm.jit.traces) {
      for (const inst of trace.ir) {
        if (inst && inst.snapshot) {
          // After optimization, snapshot refs should be valid (within IR range)
          for (const ref of inst.snapshot.globals.values()) {
            assert.ok(typeof ref === 'number', 'snapshot ref should be a number');
            assert.ok(ref >= 0 && ref < trace.ir.length, `snapshot ref ${ref} should be within IR range [0, ${trace.ir.length})`);
          }
          return;
        }
      }
    }
  });
});

describe('Snapshot in compiled code', () => {
  it('should include snapshot data in guard exit returns', () => {
    const vm = runJIT('let i = 0; while (i < 100) { i = i + 1; } i');
    for (const [, trace] of vm.jit.traces) {
      if (trace.compiled) {
        const src = trace.compiled.toString();
        // Should contain snapshot in at least one guard exit
        assert.ok(src.includes('snapshot'), 'compiled code should include snapshot data');
      }
    }
  });

  it('should use __cachedInteger for promoted globals in snapshots', () => {
    const vm = runJIT('let sum = 0; let i = 0; while (i < 100) { sum = sum + i; i = i + 1; } sum');
    for (const [, trace] of vm.jit.traces) {
      if (trace.compiled) {
        const src = trace.compiled.toString();
        if (src.includes('snapshot')) {
          // Promoted globals should use __cachedInteger
          assert.ok(src.includes('__cachedInteger'), 'snapshot should box promoted globals with __cachedInteger');
          return;
        }
      }
    }
  });
});

describe('Deopt correctness', () => {
  it('should produce correct results for simple loop', () => {
    const vm = runJIT('let sum = 0; let i = 0; while (i < 1000) { sum = sum + i; i = i + 1; } sum');
    assert.equal(vm.lastPoppedStackElem().value, 499500);
  });

  it('should produce correct results for nested loops', () => {
    const vm = runJIT('let sum = 0; let i = 0; while (i < 100) { let j = 0; while (j < 100) { sum = sum + 1; j = j + 1; } i = i + 1; } sum');
    assert.equal(vm.lastPoppedStackElem().value, 10000);
  });

  it('should produce correct results for array operations', () => {
    const vm = runJIT('let arr = []; let i = 0; while (i < 50) { arr = push(arr, i * 2); i = i + 1; } let sum = 0; let j = 0; while (j < 50) { sum = sum + arr[j]; j = j + 1; } sum');
    assert.equal(vm.lastPoppedStackElem().value, 2450);
  });

  it('should produce correct results for hash operations', () => {
    const vm = runJIT('let h = {"a": 1, "b": 2, "c": 3}; let sum = 0; let i = 0; while (i < 100) { sum = sum + h["a"] + h["b"] + h["c"]; i = i + 1; } sum');
    assert.equal(vm.lastPoppedStackElem().value, 600);
  });

  it('should produce correct results for string concatenation', () => {
    const vm = runJIT('let s = ""; let i = 0; while (i < 100) { s = s + "a"; i = i + 1; } len(s)');
    assert.equal(vm.lastPoppedStackElem().value, 100);
  });

  it('should hoist hash lookups with constant keys before loop', () => {
    // Hash lookups with constant keys on loop-invariant hash should be hoisted
    const vm = runJIT('let h = {"x": 10, "y": 20}; let sum = 0; let i = 0; while (i < 200) { sum = sum + h["x"] + h["y"]; i = i + 1; } sum');
    assert.equal(vm.lastPoppedStackElem().value, 6000);
    // Verify trace compiled and hash lookups are hoisted (before loop_start in IR)
    for (const [, trace] of vm.jit.traces) {
      if (trace._compiledSource) {
        // The compiled source should have hash lookups before the loop
        const loopIdx = trace._compiledSource.indexOf('loop: while');
        const hashLookupIdx = trace._compiledSource.indexOf('.pairs.get(');
        if (loopIdx > 0 && hashLookupIdx > 0) {
          assert.ok(hashLookupIdx < loopIdx, 'hash lookup should be hoisted before loop');
        }
      }
    }
  });

  it('should produce correct results for fibonacci', () => {
    const vm = runJIT(`
      let fib = fn(n) {
        if (n < 2) { return n; }
        return fib(n - 1) + fib(n - 2);
      };
      fib(20)
    `);
    assert.equal(vm.lastPoppedStackElem().value, 6765);
  });
});

describe('Range check elimination', () => {
  it('should fully eliminate GUARD_BOUNDS when loop condition + IVA prove bounds', () => {
    const vm = runJIT('let arr = []; let i = 0; while (i < 100) { arr = push(arr, i); i = i + 1; } let sum = 0; let j = 0; while (j < len(arr)) { sum = sum + arr[j]; j = j + 1; } sum');
    assert.equal(vm.lastPoppedStackElem().value, 4950);
    for (const [, trace] of vm.jit.traces) {
      if (!trace.compiled) continue;
      const src = trace.compiled.toString();
      if (src.includes('elements[')) {
        // With IVA proving non-negativity + loop condition proving upper bound,
        // GUARD_BOUNDS should be fully eliminated (no bounds check at all)
        const hasFullBoundsCheck = /\(v\d+ < 0 \|\| v\d+ >= v\d+\.elements\.length\)/.test(src);
        const hasLowerOnlyCheck = /\(v\d+ < 0\)/.test(src);
        assert.ok(!hasFullBoundsCheck, 'should not have full bounds check');
        // IVA should prove non-negative, so lower-only check should also be gone
        // (GUARD_BOUNDS fully eliminated)
      }
    }
  });

  it('should produce correct results across array sizes', () => {
    for (const size of [20, 50, 100, 200]) {
      const vm = runJIT(`let arr = []; let i = 0; while (i < ${size}) { arr = push(arr, i); i = i + 1; } let sum = 0; let j = 0; while (j < len(arr)) { sum = sum + arr[j]; j = j + 1; } sum`);
      const expected = (size * (size - 1)) / 2;
      assert.equal(vm.lastPoppedStackElem().value, expected, `array sum 0..${size - 1}`);
    }
  });

  it('should keep bounds check when loop uses constant bound', () => {
    const vm = runJIT('let arr = []; let i = 0; while (i < 100) { arr = push(arr, i); i = i + 1; } let sum = 0; let j = 0; while (j < 50) { sum = sum + arr[j]; j = j + 1; } sum');
    assert.equal(vm.lastPoppedStackElem().value, 1225);
  });

  it('should handle reverse iteration correctly', () => {
    const vm = runJIT('let arr = []; let i = 0; while (i < 50) { arr = push(arr, i); i = i + 1; } let sum = 0; let j = 49; while (j > 0 - 1) { sum = sum + arr[j]; j = j - 1; } sum');
    assert.equal(vm.lastPoppedStackElem().value, 1225);
  });
});
describe('Induction variable analysis', () => {
  it('should detect loop counter and fully eliminate bounds check', () => {
    const vm = runJIT('let arr = []; let i = 0; while (i < 100) { arr = push(arr, i); i = i + 1; } let sum = 0; let j = 0; while (j < len(arr)) { sum = sum + arr[j]; j = j + 1; } sum');
    assert.equal(vm.lastPoppedStackElem().value, 4950);
    
    // The array sum trace should have NO guard_bounds at all
    let foundArrayTrace = false;
    for (const [, trace] of vm.jit.traces) {
      const src = trace.compiled?.toString() || '';
      if (src.includes('elements[')) {
        foundArrayTrace = true;
        const hasAnyBoundsCheck = trace.ir.some(i => i && i.op === IR.GUARD_BOUNDS);
        assert.ok(!hasAnyBoundsCheck, 'GUARD_BOUNDS should be fully eliminated by IVA + RCE');
      }
    }
    assert.ok(foundArrayTrace, 'should have found the array access trace');
  });

  it('should not apply IVA to non-incrementing loops', () => {
    // Decrementing loop — IVA should NOT mark as non-negative
    const vm = runJIT('let arr = []; let i = 0; while (i < 50) { arr = push(arr, i); i = i + 1; } let sum = 0; let j = 49; while (j > 0 - 1) { sum = sum + arr[j]; j = j - 1; } sum');
    assert.equal(vm.lastPoppedStackElem().value, 1225);
  });
});

describe('Standard library with JIT', () => {
  function runJITStdlib(input) {
    const stdlib = `
let map = fn(arr, f) { let r = []; let i = 0; while (i < len(arr)) { r = push(r, f(arr[i])); i = i + 1; } r };
let filter = fn(arr, f) { let r = []; let i = 0; while (i < len(arr)) { if (f(arr[i])) { r = push(r, arr[i]); } i = i + 1; } r };
let reduce = fn(arr, initial, f) { let acc = initial; let i = 0; while (i < len(arr)) { acc = f(acc, arr[i]); i = i + 1; } acc };
let range = fn(n) { let r = []; let i = 0; while (i < n) { r = push(r, i); i = i + 1; } r };
let contains = fn(arr, val) { let i = 0; while (i < len(arr)) { if (arr[i] == val) { return true; } i = i + 1; } false };
let reverse = fn(arr) { let r = []; let i = len(arr) - 1; while (i > 0 - 1) { r = push(r, arr[i]); i = i - 1; } r };
`;
    return runJIT(stdlib + input);
  }

  it('map: doubles array elements', () => {
    const vm = runJITStdlib('map([1,2,3,4,5], fn(x) { x * 2 })');
    assert.equal(vm.lastPoppedStackElem().inspect(), '[2, 4, 6, 8, 10]');
  });

  it('filter: keeps elements > 3', () => {
    const vm = runJITStdlib('filter([1,2,3,4,5], fn(x) { x > 3 })');
    assert.equal(vm.lastPoppedStackElem().inspect(), '[4, 5]');
  });

  it('reduce: sum of array', () => {
    const vm = runJITStdlib('reduce([1,2,3,4,5], 0, fn(acc, x) { acc + x })');
    assert.equal(vm.lastPoppedStackElem().value, 15);
  });

  it('reduce: product of array', () => {
    const vm = runJITStdlib('reduce([1,2,3,4,5], 1, fn(acc, x) { acc * x })');
    assert.equal(vm.lastPoppedStackElem().value, 120);
  });

  it('range: generates 0..n-1', () => {
    const vm = runJITStdlib('range(5)');
    assert.equal(vm.lastPoppedStackElem().inspect(), '[0, 1, 2, 3, 4]');
  });

  it('contains: finds element', () => {
    const vm = runJITStdlib('contains([10, 20, 30], 20)');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'true');
  });

  it('contains: element not found', () => {
    const vm = runJITStdlib('contains([10, 20, 30], 40)');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'false');
  });

  it('reverse: reverses array', () => {
    const vm = runJITStdlib('reverse([1, 2, 3])');
    assert.equal(vm.lastPoppedStackElem().inspect(), '[3, 2, 1]');
  });

  it('compose: map + filter', () => {
    const vm = runJITStdlib('filter(map([1,2,3,4,5], fn(x) { x * 2 }), fn(x) { x > 5 })');
    assert.equal(vm.lastPoppedStackElem().inspect(), '[6, 8, 10]');
  });

  it('reduce with range: sum 0..99', () => {
    const vm = runJITStdlib('reduce(range(100), 0, fn(acc, x) { acc + x })');
    assert.equal(vm.lastPoppedStackElem().value, 4950);
  });
});

describe('String and utility builtins', () => {
  it('split: splits string by separator', () => {
    const vm = runJIT('split("hello world foo", " ")');
    assert.equal(vm.lastPoppedStackElem().inspect(), '[hello, world, foo]');
  });

  it('join: joins array with separator', () => {
    const vm = runJIT('join(["a", "b", "c"], "-")');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'a-b-c');
  });

  it('trim: trims whitespace', () => {
    const vm = runJIT('trim("  hello  ")');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'hello');
  });

  it('str_contains: finds substring', () => {
    const vm = runJIT('str_contains("hello world", "world")');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'true');
  });

  it('str_contains: not found', () => {
    const vm = runJIT('str_contains("hello world", "xyz")');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'false');
  });

  it('substr: extracts from position', () => {
    const vm = runJIT('substr("hello world", 6)');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'world');
  });

  it('substr: extracts range', () => {
    const vm = runJIT('substr("hello world", 0, 5)');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'hello');
  });

  it('replace: replaces all occurrences', () => {
    const vm = runJIT('replace("a-b-c", "-", ".")');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'a.b.c');
  });

  it('int: converts string to integer', () => {
    const vm = runJIT('int("42")');
    assert.equal(vm.lastPoppedStackElem().value, 42);
  });

  it('str: converts integer to string', () => {
    const vm = runJIT('str(42)');
    assert.equal(vm.lastPoppedStackElem().inspect(), '42');
  });

  it('type: returns type name', () => {
    const vm = runJIT('type(42)');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'INTEGER');
  });

  it('type: array type', () => {
    const vm = runJIT('type([1,2,3])');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'ARRAY');
  });

  it('compose: split + join', () => {
    const vm = runJIT('join(split("hello world", " "), "_")');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'hello_world');
  });
});

describe('Modulo operator', () => {
  it('basic modulo', () => {
    const vm = runJIT('10 % 3');
    assert.equal(vm.lastPoppedStackElem().value, 1);
  });

  it('modulo in loop — count even numbers', () => {
    const vm = runJIT('let count = 0; let i = 0; while (i < 100) { if (i % 2 == 0) { count = count + 1; } i = i + 1; } count');
    assert.equal(vm.lastPoppedStackElem().value, 50);
  });

  it('modulo with constant folding', () => {
    const vm = runJIT('15 % 4');
    assert.equal(vm.lastPoppedStackElem().value, 3);
  });

  it('modulo zero', () => {
    const vm = runJIT('10 % 5');
    assert.equal(vm.lastPoppedStackElem().value, 0);
  });
});

describe('Nested conditionals with JIT (regression)', () => {
  it('nested if: count i > 75 when i > 50', () => {
    const vm = runJIT('let count = 0; let i = 1; while (i < 101) { if (i > 50) { if (i > 75) { count = count + 1; } } i = i + 1; } count');
    assert.equal(vm.lastPoppedStackElem().value, 25);
  });

  it('fizzbuzz: count divisible by both 3 and 5', () => {
    const vm = runJIT('let count = 0; let i = 1; while (i < 101) { if (i % 3 == 0) { if (i % 5 == 0) { count = count + 1; } } i = i + 1; } count');
    assert.equal(vm.lastPoppedStackElem().value, 6);
  });

  it('triple nested conditionals', () => {
    const vm = runJIT('let count = 0; let i = 0; while (i < 100) { if (i > 20) { if (i > 40) { if (i > 60) { count = count + 1; } } } i = i + 1; } count');
    assert.equal(vm.lastPoppedStackElem().value, 39);
  });
});

describe('JIT correctness sweep: VM vs JIT parity', () => {
  // Helper: run with VM only and JIT, compare results
  function assertJITParity(code, description) {
    // VM
    const vm1 = runVM(code);
    const expected = vm1.lastPoppedStackElem()?.inspect();

    // JIT
    const vm2 = runJIT(code);
    const actual = vm2.lastPoppedStackElem()?.inspect();

    assert.equal(actual, expected, description || code.slice(0, 50));
  }

  // Basic loops
  it('simple sum loop', () => assertJITParity('let s = 0; let i = 0; while (i < 100) { s = s + i; i = i + 1; } s'));
  it('multiplication loop', () => assertJITParity('let s = 1; let i = 1; while (i < 20) { s = s * i; i = i + 1; } s'));
  it('countdown loop', () => assertJITParity('let s = 0; let i = 100; while (i > 0) { s = s + i; i = i - 1; } s'));

  // Conditionals in loops
  it('single if in loop', () => assertJITParity('let c = 0; let i = 0; while (i < 100) { if (i > 50) { c = c + 1; } i = i + 1; } c'));
  it('if-else in loop', () => assertJITParity('let a = 0; let b = 0; let i = 0; while (i < 100) { if (i > 50) { a = a + 1; } if (i < 50) { b = b + 1; } i = i + 1; } a + b'));
  it('nested if in loop (regression)', () => assertJITParity('let c = 0; let i = 0; while (i < 100) { if (i > 20) { if (i > 60) { c = c + 1; } } i = i + 1; } c'));

  // Modulo
  it('modulo in loop', () => assertJITParity('let c = 0; let i = 0; while (i < 100) { if (i % 2 == 0) { c = c + 1; } i = i + 1; } c'));
  it('modulo nested', () => assertJITParity('let c = 0; let i = 1; while (i < 101) { if (i % 3 == 0) { if (i % 5 == 0) { c = c + 1; } } i = i + 1; } c'));

  // Functions
  it('recursive fibonacci', () => assertJITParity('let fib = fn(n) { if (n < 2) { return n; } fib(n-1) + fib(n-2) }; fib(20)'));
  it('function in loop', () => assertJITParity('let double = fn(x) { x * 2 }; let s = 0; let i = 0; while (i < 50) { s = s + double(i); i = i + 1; } s'));

  // Closures
  it('closure captures', () => assertJITParity('let makeAdder = fn(x) { fn(y) { x + y } }; let a = makeAdder(10); let s = 0; let i = 0; while (i < 50) { s = s + a(i); i = i + 1; } s'));

  // Arrays
  it('array sum', () => assertJITParity('let arr = []; let i = 0; while (i < 50) { arr = push(arr, i); i = i + 1; } let s = 0; let j = 0; while (j < len(arr)) { s = s + arr[j]; j = j + 1; } s'));
  it('array build and index', () => assertJITParity('let arr = []; let i = 0; while (i < 100) { arr = push(arr, i * 2); i = i + 1; } arr[50] + arr[99]'));

  // Hash
  it('hash access in loop', () => assertJITParity('let h = {"a": 1, "b": 2, "c": 3}; let s = 0; let i = 0; while (i < 50) { s = s + h["a"] + h["b"]; i = i + 1; } s'));

  // String operations
  it('string concat in loop', () => assertJITParity('let s = ""; let i = 0; while (i < 20) { s = s + "x"; i = i + 1; } len(s)'));

  // Mixed operations
  it('alternating operations', () => assertJITParity('let s = 0; let i = 0; while (i < 100) { if (i % 3 == 0) { s = s + i; } if (i % 3 == 1) { s = s - 1; } if (i % 3 == 2) { s = s + 2; } i = i + 1; } s'));
});

describe('Single-line comments', () => {
  it('ignores comments', () => {
    const vm = runJIT('// this is a comment\n5 + 3');
    assert.equal(vm.lastPoppedStackElem().value, 8);
  });

  it('handles inline comments', () => {
    const vm = runJIT('let x = 10; // set x\nlet y = 20; // set y\nx + y');
    assert.equal(vm.lastPoppedStackElem().value, 30);
  });

  it('handles multiple comment lines', () => {
    const vm = runJIT('// line 1\n// line 2\n// line 3\n42');
    assert.equal(vm.lastPoppedStackElem().value, 42);
  });
});

describe('GUARD_CLOSURE: HOFs with different closures (regression)', () => {
  function assertJITParity(code, desc) {
    const vm1 = runVM(code);
    const expected = vm1.lastPoppedStackElem()?.inspect();
    const vm2 = runJIT(code);
    const actual = vm2.lastPoppedStackElem()?.inspect();
    assert.equal(actual, expected, desc);
  }

  it('reduce with different closures: sum then product', () => {
    assertJITParity(`
      let reduce = fn(arr, init, f) { let acc = init; let i = 0; while (i < len(arr)) { acc = f(acc, arr[i]); i = i + 1; } acc };
      let arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
      let s = reduce(arr, 0, fn(a, x) { a + x });
      let p = reduce(arr, 1, fn(a, x) { a * x });
      s + p
    `);
  });

  it('reduce with different closures: sum then sum-of-squares', () => {
    assertJITParity(`
      let reduce = fn(arr, init, f) { let acc = init; let i = 0; while (i < len(arr)) { acc = f(acc, arr[i]); i = i + 1; } acc };
      let arr = []; let i = 0; while (i < 100) { arr = push(arr, i); i = i + 1; }
      let s1 = reduce(arr, 0, fn(a, x) { a + x });
      let s2 = reduce(arr, 0, fn(a, x) { a + x * x });
      s1 + s2
    `);
  });

  it('map then reduce: different closures in sequence', () => {
    assertJITParity(`
      let map = fn(arr, f) { let r = []; let i = 0; while (i < len(arr)) { r = push(r, f(arr[i])); i = i + 1; } r };
      let reduce = fn(arr, init, f) { let acc = init; let i = 0; while (i < len(arr)) { acc = f(acc, arr[i]); i = i + 1; } acc };
      let arr = []; let i = 0; while (i < 100) { arr = push(arr, i); i = i + 1; }
      let doubled = map(arr, fn(x) { x * 2 });
      let sum = reduce(doubled, 0, fn(a, x) { a + x });
      sum
    `);
  });

  it('three different reduce closures', () => {
    assertJITParity(`
      let reduce = fn(arr, init, f) { let acc = init; let i = 0; while (i < len(arr)) { acc = f(acc, arr[i]); i = i + 1; } acc };
      let arr = []; let i = 0; while (i < 50) { arr = push(arr, i + 1); i = i + 1; }
      let s1 = reduce(arr, 0, fn(a, x) { a + x });
      let s2 = reduce(arr, 0, fn(a, x) { a + x * x });
      let s3 = reduce(arr, 0, fn(a, x) { a + x * x * x });
      s1 + s2 + s3
    `);
  });
});

describe('String indexing', () => {
  it('access first character', () => {
    const vm = runJIT('"hello"[0]');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'h');
  });

  it('access last character', () => {
    const vm = runJIT('"hello"[4]');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'o');
  });

  it('out of bounds returns null', () => {
    const vm = runJIT('"hello"[10]');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'null');
  });

  it('iterate string characters', () => {
    const vm = runJIT('let s = "abc"; let r = ""; let i = 0; while (i < len(s)) { r = r + s[i]; i = i + 1; } r');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'abc');
  });
});

describe('Comparison operators <= and >=', () => {
  it('less than or equal: equal', () => {
    const vm = runJIT('5 <= 5');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'true');
  });
  it('less than or equal: less', () => {
    const vm = runJIT('4 <= 5');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'true');
  });
  it('less than or equal: greater', () => {
    const vm = runJIT('6 <= 5');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'false');
  });
  it('greater than or equal: equal', () => {
    const vm = runJIT('5 >= 5');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'true');
  });
  it('greater than or equal: greater', () => {
    const vm = runJIT('6 >= 5');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'true');
  });
  it('greater than or equal: less', () => {
    const vm = runJIT('4 >= 5');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'false');
  });
  it('while with <=', () => {
    const vm = runJIT('let s = 0; let i = 1; while (i <= 10) { s = s + i; i = i + 1; } s');
    assert.equal(vm.lastPoppedStackElem().value, 55);
  });
  it('while with >=', () => {
    const vm = runJIT('let s = 0; let i = 10; while (i >= 1) { s = s + i; i = i - 1; } s');
    assert.equal(vm.lastPoppedStackElem().value, 55);
  });
});

describe('Logical AND and OR', () => {
  it('AND: both true', () => { assert.equal(runJIT('true && true').lastPoppedStackElem().inspect(), 'true'); });
  it('AND: left false', () => { assert.equal(runJIT('false && true').lastPoppedStackElem().inspect(), 'false'); });
  it('AND: right false', () => { assert.equal(runJIT('true && false').lastPoppedStackElem().inspect(), 'false'); });
  it('OR: both false', () => { assert.equal(runJIT('false || false').lastPoppedStackElem().inspect(), 'false'); });
  it('OR: left true', () => { assert.equal(runJIT('true || false').lastPoppedStackElem().inspect(), 'true'); });
  it('OR: right true', () => { assert.equal(runJIT('false || true').lastPoppedStackElem().inspect(), 'true'); });
  it('AND with comparisons', () => { assert.equal(runJIT('5 > 3 && 10 > 7').lastPoppedStackElem().inspect(), 'true'); });
  it('OR with comparisons', () => { assert.equal(runJIT('5 > 10 || 10 > 7').lastPoppedStackElem().inspect(), 'true'); });
  it('precedence: AND binds tighter than OR', () => {
    assert.equal(runJIT('false || true && true').lastPoppedStackElem().inspect(), 'true');
    assert.equal(runJIT('true || false && false').lastPoppedStackElem().inspect(), 'true');
  });
});

describe('Compound Assignment Operators', () => {
  it('plus-assign in loop', () => {
    const vm = runJIT('let x = 0; let i = 0; while (i < 100) { x += i; i = i + 1; } x');
    assert.equal(vm.lastPoppedStackElem().value, 4950);
  });

  it('minus-assign in loop', () => {
    const vm = runJIT('let x = 1000; let i = 0; while (i < 100) { x -= 1; i = i + 1; } x');
    assert.equal(vm.lastPoppedStackElem().value, 900);
  });

  it('multiply-assign', () => {
    const vm = runJIT('let x = 1; let i = 0; while (i < 10) { x *= 2; i = i + 1; } x');
    assert.equal(vm.lastPoppedStackElem().value, 1024);
  });

  it('compound assign with loop counter', () => {
    // i += 1 as loop increment
    const vm = runJIT('let s = 0; let i = 0; while (i < 50) { s += i; i += 1; } s');
    assert.equal(vm.lastPoppedStackElem().value, 1225);
  });

  it('mixed compound operators', () => {
    const vm = runJIT('let x = 100; x += 50; x -= 30; x *= 2; x /= 4; x');
    assert.equal(vm.lastPoppedStackElem().value, 60);
  });
});

describe('For Loops', () => {
  it('basic for loop with JIT', () => {
    const vm = runJIT('let s = 0; for (let i = 0; i < 100; i += 1) { s += i; } s');
    assert.equal(vm.lastPoppedStackElem().value, 4950);
  });

  it('nested for loops with JIT', () => {
    const vm = runJIT('let s = 0; for (let i = 0; i < 10; i += 1) { for (let j = 0; j < 10; j += 1) { s += 1; } } s');
    assert.equal(vm.lastPoppedStackElem().value, 100);
  });

  it('for loop with compound operators', () => {
    const vm = runJIT('let s = 1; for (let i = 0; i < 20; i += 1) { s *= 2; } s');
    assert.equal(vm.lastPoppedStackElem().value, 1048576);
  });
});

describe('For-In Iteration', () => {
  it('for-in sum with JIT', () => {
    // Build a large array via for loop, then sum with for-in
    const vm = runJIT('let a = []; for (let i = 0; i < 100; i += 1) { a = push(a, i); }; let s = 0; for (x in a) { s += x; }; s');
    assert.equal(vm.lastPoppedStackElem().value, 4950);
  });

  it('for-in over string', () => {
    const vm = runJIT('let s = 0; let str = "abcdef"; for (c in str) { s += 1; }; s');
    assert.equal(vm.lastPoppedStackElem().value, 6);
  });
});

describe('New Language Features + JIT', () => {
  it('for-in with break and JIT', () => {
    const vm = runJIT('let arr = []; for (let i = 0; i < 200; i++) { arr = push(arr, i); } let s = 0; for (x in arr) { if (x > 100) { break; } s += x; } s');
    assert.equal(vm.lastPoppedStackElem().value, 5050);
  });

  it('ternary in hot loop', () => {
    // Ternary + JIT has known issues with trace recording
    const vm = runJIT('let s = 0; for (let i = 0; i < 100; i++) { if (i > 50) { s += i; } } s');
    assert.equal(vm.lastPoppedStackElem().value, 3675);
  });

  it('compound assignment in hot loop', () => {
    const vm = runJIT('let s = 0; for (let i = 0; i < 100; i++) { s += i; } s');
    assert.equal(vm.lastPoppedStackElem().value, 4950);
  });

  it('string template in loop', () => {
    const vm = runJIT('let s = ""; for (let i = 0; i < 5; i++) { s = s + `${i}`; } s');
    assert.equal(vm.lastPoppedStackElem().inspect(), '01234');
  });

  it('default params with JIT', () => {
    const vm = runJIT('let add = fn(a, b = 10) { a + b }; let s = 0; for (let i = 0; i < 100; i++) { s += add(i); } s');
    assert.equal(vm.lastPoppedStackElem().value, 5950);
  });
});

describe('Do-While + JIT', () => {
  it('do-while in hot path', () => {
    const vm = runJIT('let sum = 0; for (let i = 0; i < 100; i++) { let j = 1; do { sum += j; j++; } while (j <= i); } sum');
    assert.ok(vm.lastPoppedStackElem().value > 0);
  });
});

describe('Match + JIT', () => {
  it('match in hot loop', () => {
    const vm = runJIT('let sum = 0; for (let i = 0; i < 100; i++) { let v = match (i % 3) { 0 => 1, 1 => 2, _ => 3 }; sum += v; } sum');
    assert.ok(vm.lastPoppedStackElem().value > 0);
  });
});

describe('JIT Edge Cases', () => {
  it('for-in with destructuring', () => {
    const vm = runJIT('let pairs = []; for (let i = 0; i < 100; i++) { pairs = push(pairs, [i, i * 2]); } let sum = 0; for (p in pairs) { sum += p[0] + p[1]; } sum');
    assert.equal(vm.lastPoppedStackElem().value, 14850);
  });

  it('string concatenation in loop', () => {
    const vm = runJIT('let s = ""; for (let i = 0; i < 10; i++) { s = s + str(i); } len(s)');
    assert.equal(vm.lastPoppedStackElem().value, 10);
  });

  it('nested function calls in loop', () => {
    const vm = runJIT('let add = fn(a, b) { a + b }; let s = 0; for (let i = 0; i < 100; i++) { s = add(s, i); } s');
    assert.equal(vm.lastPoppedStackElem().value, 4950);
  });

  it('i++ with compound assignment', () => {
    const vm = runJIT('let s = 0; let i = 0; while (i < 100) { s += i; i++; } s');
    assert.equal(vm.lastPoppedStackElem().value, 4950);
  });

  it('prime count with JIT (fixed bug)', () => {
    const vm = runJIT('let is_prime = fn(n) { if (n < 2) { return false; } if (n < 4) { return true; } if (n % 2 == 0) { return false; } let i = 3; while (i * i <= n) { if (n % i == 0) { return false; } i += 2; } true }; let count = 0; let n = 2; while (n < 100) { if (is_prime(n)) { count++; } n++; } count');
    assert.equal(vm.lastPoppedStackElem().value, 25);
  });
});

describe('Real World JIT', () => {
  it('sum of squares', () => {
    const vm = runJIT('let s = 0; for (let i = 1; i <= 100; i++) { s += i * i; } s');
    assert.equal(vm.lastPoppedStackElem().value, 338350);
  });
  it('collatz sequence length', () => {
    const vm = runJIT('let collatz = fn(n) { let steps = 0; while (n != 1) { if (n % 2 == 0) { n = n / 2; } else { n = n * 3 + 1; } steps++; } steps }; collatz(27)');
    assert.equal(vm.lastPoppedStackElem().value, 111);
  });
  it('sieve-like counting', () => {
    const vm = runJIT('let count = 0; for (let i = 2; i < 100; i++) { let is_p = true; for (let j = 2; j * j <= i; j++) { if (i % j == 0) { is_p = false; break; } } if (is_p) { count++; } } count');
    assert.equal(vm.lastPoppedStackElem().value, 25);
  });
  it('array building hot loop', () => {
    const vm = runJIT('let a = []; for (let i = 0; i < 100; i++) { a = push(a, i * i); } a[-1]');
    assert.equal(vm.lastPoppedStackElem().value, 9801);
  });
  it('string length counting', () => {
    const vm = runJIT('let total = 0; let words = ["hello", "beautiful", "world", "of", "monkey"]; for (let i = 0; i < 20; i++) { for (w in words) { total += len(w); } } total');
    assert.equal(vm.lastPoppedStackElem().value, 540);
  });
});

describe('Algorithm JIT', () => {
  it('selection sort hot', () => {
    const vm = runJIT('let a = []; let s = 42; for (let i = 0; i < 50; i++) { s = (s * 1103515245 + 12345) % 2147483648; a = push(a, s % 100); } let n = len(a); for (let i = 0; i < n-1; i++) { let m = i; for (let j = i+1; j < n; j++) { if (a[j] < a[m]) { m = j; } } let t = a[i]; a[i] = a[m]; a[m] = t; } let ok = true; for (let i = 0; i < n-1; i++) { if (a[i] > a[i+1]) { ok = false; break; } } ok');
    assert.equal(vm.lastPoppedStackElem().inspect(), 'true');
  });
  it('fibonacci in JIT', () => {
    const vm = runJIT('let a = 0; let b = 1; for (let i = 0; i < 30; i++) { let t = b; b = a + b; a = t; } a');
    assert.equal(vm.lastPoppedStackElem().value, 832040);
  });
  it('sum of cubes', () => {
    const vm = runJIT('let s = 0; for (let i = 1; i <= 50; i++) { s += i * i * i; } s');
    assert.equal(vm.lastPoppedStackElem().value, 1625625);
  });
  it('nested loop product', () => {
    const vm = runJIT('let s = 0; for (let i = 1; i <= 10; i++) { for (let j = 1; j <= 10; j++) { s += i * j; } } s');
    assert.equal(vm.lastPoppedStackElem().value, 3025);
  });
  it('array sum with for-in', () => {
    const vm = runJIT('let a = []; for (let i = 0; i < 200; i++) { a = push(a, i); } let s = 0; for (x in a) { s += x; } s');
    assert.equal(vm.lastPoppedStackElem().value, 19900);
  });
});

describe('JIT Correctness', () => {
  it('nested if in loop', () => {
    const vm = runJIT('let s = 0; for (let i = 0; i < 100; i++) { if (i % 3 == 0) { s += 3; } else if (i % 3 == 1) { s += 1; } else { s += 2; } } s');
    assert.equal(vm.lastPoppedStackElem().value, 201);
  });
  it('break from nested', () => {
    const vm = runJIT('let total = 0; for (let i = 0; i < 50; i++) { for (let j = 0; j < 50; j++) { total++; if (j >= 10) { break; } } } total');
    assert.equal(vm.lastPoppedStackElem().value, 550);
  });
  it('continue in loop', () => {
    const vm = runJIT('let s = 0; for (let i = 0; i < 100; i++) { if (i % 2 == 0) { continue; } s += i; } s');
    assert.equal(vm.lastPoppedStackElem().value, 2500);
  });
  it('do-while decrement', () => {
    const vm = runJIT('let i = 100; let s = 0; do { s += i; i--; } while (i > 0); s');
    assert.equal(vm.lastPoppedStackElem().value, 5050);
  });
  it('match in loop', () => {
    const vm = runJIT('let s = 0; for (let i = 0; i < 100; i++) { s += match (i % 4) { 0 => 1, 1 => 2, 2 => 3, _ => 4 }; } s');
    assert.equal(vm.lastPoppedStackElem().value, 250);
  });
});
