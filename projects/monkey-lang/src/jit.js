// Monkey Language Tracing JIT Compiler
// Records hot loop traces in the VM, compiles to JavaScript functions
//
// Architecture:
//   1. Profile: count loop back-edge executions
//   2. Record: when hot, record a linear trace of operations
//   3. Optimize: constant fold, dead guard elimination on the linear IR
//   4. Compile: emit a JavaScript function via new Function()
//   5. Execute: replace interpreter loop with compiled trace
//
// Key insight: since we're in JS, we can't emit machine code.
// But we CAN generate optimized JS that V8/SpiderMonkey will JIT-compile.
// This eliminates: dispatch overhead, stack push/pop, object wrapping.
// The generated JS operates on raw values where possible.
//
// --- JIT event instrumentation ---
// When JIT_EVENTS=full is set in the environment, the JIT emits one JSON
// line per event to stderr (versioned schema, "v":1). When unset or set
// to anything other than "full", emission is disabled and the cost is a
// single branch check at each emit site. See JIT_EVENTS_SCHEMA.md for
// the event vocabulary.

import { Opcodes, lookup } from './code.js';
import {
  MonkeyInteger, MonkeyBoolean, MonkeyString, MonkeyNull,
  MonkeyArray, MonkeyHash, MonkeyBuiltin, MonkeyError,
  TRUE, FALSE, NULL, cachedInteger,
} from './object.js';
import { CompiledFunction } from './compiler.js';

// --- JIT event instrumentation ---
const JIT_EVENTS_MODE = (typeof process !== 'undefined' && process.env && process.env.JIT_EVENTS) || 'off';
export const JIT_EVENTS_FULL = JIT_EVENTS_MODE === 'full';
export const JIT_EVENTS_SUMMARY = JIT_EVENTS_MODE === 'summary' || JIT_EVENTS_FULL;
export const JIT_EVENTS_SCHEMA_VERSION = 1;

// Emit a single event as a JSON line on stderr.
// Caller MUST gate on JIT_EVENTS_FULL before calling — this function
// assumes emission is desired and skips the early-out check so the
// hot-path uop emitter doesn't pay for two checks.
function emitEvent(event) {
  event.v = JIT_EVENTS_SCHEMA_VERSION;
  process.stderr.write(JSON.stringify(event) + '\n');
}

// --- Configuration ---
const HOT_LOOP_THRESHOLD = 16;   // iterations before tracing starts
const MAX_TRACE_LENGTH = 200;    // max IR instructions per trace
const MAX_TRACES = 64;           // max compiled traces
const HOT_EXIT_THRESHOLD = 8;    // guard exit count before side trace
const MAX_SIDE_TRACES = 4;       // max side traces per root trace
const MAX_INLINE_DEPTH = 3;      // max function inlining depth during tracing
const HOT_FUNC_THRESHOLD = 16;   // calls before function trace recording

// --- IR Opcodes ---
// Linear SSA-style IR. Each instruction produces a value (referenced by index).
// Guards cause trace exits on failure.
export const IR = {
  // Constants & loads
  CONST_INT:    'const_int',     // value: number
  CONST_BOOL:   'const_bool',    // value: boolean
  CONST_NULL:   'const_null',
  CONST_OBJ:    'const_obj',     // value: MonkeyObject ref
  LOAD_LOCAL:   'load_local',    // slot: number
  LOAD_STACK:   'load_stack',    // stackOffset: number, value: any — operand stack value from parent trace
  LOAD_GLOBAL:  'load_global',   // index: number
  LOAD_FREE:    'load_free',     // index: number
  LOAD_CONST:   'load_const',    // index: number (from constant pool)

  // Stores
  STORE_LOCAL:  'store_local',   // slot: number, value: ref
  STORE_GLOBAL: 'store_global',  // index: number, value: ref

  // Arithmetic (operate on raw JS numbers)
  ADD_INT:      'add_int',       // left: ref, right: ref
  SUB_INT:      'sub_int',
  MUL_INT:      'mul_int',
  DIV_INT:      'div_int',
  MOD_INT:      'mod_int',

  // String
  CONCAT:       'concat',        // left: ref, right: ref

  // Comparison (produce raw JS booleans)
  EQ:           'eq',
  NEQ:          'neq',
  GT:           'gt',
  LT:           'lt',

  // Unary
  NEG:          'neg',           // operand: ref
  NOT:          'not',           // operand: ref

  // Guards (exit trace on failure)
  GUARD_INT:    'guard_int',     // ref: check this value is MonkeyInteger
  GUARD_BOOL:   'guard_bool',
  GUARD_STRING: 'guard_string',
  GUARD_TRUTHY: 'guard_truthy',  // ref: check truthy, exit if not
  GUARD_FALSY:  'guard_falsy',   // ref: check falsy, exit if not

  // Control
  PHI:          'phi',           // loop header: merge initial and back-edge values
  LOOP_START:   'loop_start',
  LOOP_END:     'loop_end',      // back-edge: jump to loop start

  // Function traces (recursive call support)
  SELF_CALL:    'self_call',     // args: ref[] — recursive call to the traced function
  FUNC_RETURN:  'func_return',   // ref: return value from function trace

  // Function calls (bail out to interpreter for now)
  CALL:         'call',          // closure: ref, args: ref[], numArgs: number

  // Array operations
  INDEX_ARRAY:  'index_array',   // array: ref, index: ref → element (MonkeyObject)
  GUARD_ARRAY:  'guard_array',   // ref: check this value is MonkeyArray
  GUARD_BOUNDS: 'guard_bounds',  // array: ref, index: ref → check 0 <= index < length
  GUARD_CLOSURE: 'guard_closure', // ref: closureRef, fnId: expected → check closure.fn.id matches

  // Hash operations
  GUARD_HASH:   'guard_hash',    // ref: check this value is MonkeyHash
  INDEX_HASH:   'index_hash',    // hash: ref, key: ref → value (MonkeyObject), uses hashKey()

  // Builtin operations (inlined builtins — avoid aborting trace)
  BUILTIN_LEN:  'builtin_len',   // ref: array or string → raw int (length)
  BUILTIN_PUSH: 'builtin_push',  // array: ref, value: ref → new MonkeyArray

  // Trace stitching (nested loops)
  EXEC_TRACE:   'exec_trace',    // Execute an inner compiled trace; constIdx: index of compiled fn in consts

  // Boxing/unboxing
  UNBOX_INT:    'unbox_int',     // ref → raw number
  BOX_INT:      'box_int',       // raw number → MonkeyInteger
  UNBOX_STRING: 'unbox_string',  // ref → raw JS string
  BOX_STRING:   'box_string',    // raw JS string → MonkeyString
};

// --- IR Instruction ---
class IRInst {
  constructor(op, operands = {}) {
    this.op = op;
    this.operands = operands;  // { left, right, value, slot, ref, etc. }
    this.type = null;          // 'int' | 'bool' | 'string' | 'object' | null
    this.id = -1;              // set during recording
  }
}

// --- Trace ---
// A recorded linear trace through a hot loop
export class Trace {
  constructor(frameId, startIp) {
    this.frameId = frameId;       // which frame (closure identity)
    this.startIp = startIp;       // bytecode IP where trace starts (loop header)
    this.ir = [];                 // IRInst[]
    this.guardCount = 0;
    this.compiled = null;         // compiled JS function
    this.executionCount = 0;
    this.sideExits = new Map();   // guard index → exit count
    this.sideTraces = Object.create(null); // guard index → compiled side Trace (plain object for fast lookup)
    this._sideTraceCount = 0;
    this.isSideTrace = false;
    this.parentTrace = null;
    this.parentGuardIdx = -1;
    // Function trace support
    this.isFuncTrace = false;     // true if this traces a function entry (not a loop)
    this.numArgs = 0;             // number of args for function traces
    this.tracedFn = null;         // the CompiledFunction being traced
  }

  addInst(op, operands = {}) {
    const inst = new IRInst(op, operands);
    inst.id = this.ir.length;
    this.ir.push(inst);
    if (JIT_EVENTS_FULL) {
      // Minimal payload: opcode + the most useful operand identifiers,
      // skipping bulky values. This is the highest-volume event type.
      const ev = { t: 'uop', key: `${this.frameId}:${this.startIp}`, op };
      if (operands.slot !== undefined) ev.slot = operands.slot;
      if (operands.index !== undefined) ev.index = operands.index;
      if (operands.constIdx !== undefined) ev.const_idx = operands.constIdx;
      if (operands.ref !== undefined) ev.ref = operands.ref;
      emitEvent(ev);
    }
    return inst.id;
  }
}

// --- Trace Recorder ---
// Hooks into VM execution to record traces
export class TraceRecorder {
  constructor(vm) {
    this.vm = vm;
    this.trace = null;
    this.recording = false;
    this.startIp = -1;
    this.startFrame = -1;
    this.irStack = [];         // maps VM stack positions to IR refs
    this.loopHeaderSeen = false;
    this.instrCount = 0;

    // Track types seen during recording for guards
    this.typeMap = new Map();  // IR ref → observed type

    // Snapshot support: track current slot→IR ref mapping
    this.localSlotRefs = new Map();   // local slot → most recent IR ref
    this.globalSlotRefs = new Map();  // global index → most recent IR ref

    // Side trace support
    this.isSideTrace = false;
    this.parentTrace = null;
    this.parentGuardIdx = -1;

    // Function inlining support
    // Stack of inline frames: each entry is { baseOffset, numLocals, returnIrStack }
    // baseOffset = offset from trace's __bp to this inlined frame's base pointer
    this.inlineFrames = [];    // stack of { baseOffset, numLocals, irStackDepth, callSiteIp }
    this.inlineDepth = 0;
    // Maps absolute stack slot → IR ref for inlined function arguments
    // When a callee does LOAD_LOCAL, we check this map first
    this.inlineSlotRefs = new Map();

    // Trusted types from type annotations (OpTypeCheck)
    // Maps absolute stack slot → type name (e.g., 'int', 'string')
    // Guards are skipped for slots with trusted types
    this.trustedTypes = new Map();
  }

  start(frameId, ip) {
    this.trace = new Trace(frameId, ip);
    this.recording = true;
    this.startIp = ip;
    this.startFrame = this.vm.framesIndex;
    this.irStack = [];
    this.loopHeaderSeen = false;
    this.instrCount = 0;
    this.typeMap.clear();
    this.localSlotRefs.clear();
    this.globalSlotRefs.clear();
    this.trustedTypes.clear();
    this.isSideTrace = false;
    this.parentTrace = null;
    this.parentGuardIdx = -1;

    if (JIT_EVENTS_FULL) {
      emitEvent({ t: 'trace_start', key: `${frameId}:${ip}`, kind: 'loop' });
    }

    // Record loop start marker
    this.trace.addInst(IR.LOOP_START);
  }

  // Start recording a side trace from a guard exit
  startSideTrace(parentTrace, guardIdx, exitIp, frameId) {
    this.trace = new Trace(frameId, exitIp);
    this.trace.isSideTrace = true;
    this.trace.parentTrace = parentTrace;
    this.trace.parentGuardIdx = guardIdx;
    this.recording = true;
    this.startIp = exitIp;
    this.startFrame = this.vm.framesIndex;
    this.irStack = [];
    this.loopHeaderSeen = false;
    this.instrCount = 0;
    this.typeMap.clear();
    this.localSlotRefs.clear();
    this.globalSlotRefs.clear();
    this.isSideTrace = true;
    this.trustedTypes.clear();
    this.parentTrace = parentTrace;
    this.parentGuardIdx = guardIdx;

    // Initialize irStack from VM stack state at the guard exit point.
    // The parent trace may have had values on the operand stack when the guard
    // fired. These values were restored to the VM stack by _executeTrace.
    // Emit LOAD_STACK instructions so the side trace can reference them.
    const frame = this.vm.currentFrame();
    const numLocals = frame.closure.fn.numLocals;
    this.trace.numLocals = numLocals;
    const stackBase = frame.basePointer + numLocals;
    const stackDepth = this.vm.sp - stackBase;
    for (let i = 0; i < stackDepth; i++) {
      const val = this.vm.stack[stackBase + i];
      // Emit a CONST or LOAD instruction for each stack value
      const ref = this.trace.addInst(IR.LOAD_STACK, { stackOffset: i, value: val });
      this.irStack.push(ref);
      // Track the type
      if (val && val.constructor && val.constructor.name === 'MonkeyInteger') {
        this.typeMap.set(ref, 'int');
      } else if (val && val.constructor && val.constructor.name === 'MonkeyString') {
        this.typeMap.set(ref, 'string');
      } else if (val && val.constructor && val.constructor.name === 'MonkeyBoolean') {
        this.typeMap.set(ref, 'bool');
      }
    }

    if (JIT_EVENTS_FULL) {
      emitEvent({
        t: 'trace_start',
        key: `${frameId}:${exitIp}`,
        kind: 'side',
        parent: `${parentTrace.frameId}:${parentTrace.startIp}`,
        guard_idx: guardIdx,
      });
    }

    // No LOOP_START for side traces — they're linear paths
    // that end at the parent's loop header
    this.trace.addInst(IR.LOOP_START);
  }

  // Start recording a function trace (triggered by hot function entry)
  startFuncTrace(frameId, fn, numArgs) {
    this.trace = new Trace(frameId, 0); // startIp=0 (function entry)
    this.trace.isFuncTrace = true;
    this.trace.numArgs = numArgs;
    this.trace.tracedFn = fn;
    this.recording = true;
    this.startIp = 0;
    this.startFrame = this.vm.framesIndex;
    this.irStack = [];
    this.loopHeaderSeen = false;
    this.instrCount = 0;
    this.typeMap.clear();
    this.localSlotRefs.clear();
    this.globalSlotRefs.clear();
    this.isSideTrace = false;
    this.trustedTypes.clear();
    this.isFuncTrace = true;
    this.tracedFn = fn;

    if (JIT_EVENTS_FULL) {
      emitEvent({ t: 'trace_start', key: `${frameId}:0`, kind: 'func', num_args: numArgs });
    }

    // Load args as LOAD_LOCAL with guard
    for (let i = 0; i < numArgs; i++) {
      const ref = this.trace.addInst(IR.LOAD_LOCAL, { slot: i });
      this.pushRef(ref);
      // We'll pop these immediately — they're in the right slots
    }
    // Clear the stack — args will be accessed via LOAD_LOCAL as the function executes
    this.irStack = [];
  }

  stop() {
    if (!this.recording) return null;
    this.recording = false;
    // For side traces ending at parent loop header, emit LOOP_END so the
    // compiled function returns { exit: "loop_back" }
    // For function traces, we don't emit LOOP_END — FUNC_RETURN is emitted during recording
    if (!this.trace.isFuncTrace) {
      this.trace.addInst(IR.LOOP_END);
    }
    const trace = this.trace;
    this.trace = null;
    if (JIT_EVENTS_FULL) {
      emitEvent({
        t: 'trace_complete',
        key: `${trace.frameId}:${trace.startIp}`,
        ir: trace.ir.length,
        guards: trace.guardCount,
      });
    }
    return trace;
  }

  // Check if the current IP is the parent trace's loop header (side trace stop condition)
  shouldStopSideTrace(ip, frameIndex) {
    if (!this.isSideTrace || !this.parentTrace) return false;
    return ip === this.parentTrace.startIp && frameIndex === this.startFrame;
  }

  abort(reason = 'unknown') {
    if (JIT_EVENTS_FULL && this.trace) {
      emitEvent({
        t: 'trace_abort',
        key: `${this.trace.frameId}:${this.trace.startIp}`,
        reason,
        ir: this.trace.ir.length,
      });
    }
    this.recording = false;
    this.trace = null;
    this.irStack = [];
    this.inlineFrames = [];
    this.inlineDepth = 0;
  }

  // Enter an inlined function call during recording
  // baseOffset: the callee's basePointer relative to the trace's root basePointer
  // numLocals: callee's numLocals (to know the stack layout)
  // callSiteIp: the IP in the caller frame right after the OpCall (for guard exit fallback)
  enterInlineFrame(baseOffset, numLocals, callSiteIp) {
    if (this.inlineDepth >= MAX_INLINE_DEPTH) {
      if (JIT_EVENTS_FULL && this.trace) {
        emitEvent({
          t: 'inline_max_depth',
          key: `${this.trace.frameId}:${this.trace.startIp}`,
          depth: this.inlineDepth,
        });
      }
      return false;
    }
    this.inlineFrames.push({
      baseOffset,
      numLocals,
      irStackDepth: this.irStack.length,
      callSiteIp,  // used for guard exits inside the inlined function
    });
    this.inlineDepth++;
    if (JIT_EVENTS_FULL && this.trace) {
      emitEvent({
        t: 'inline_enter',
        key: `${this.trace.frameId}:${this.trace.startIp}`,
        depth: this.inlineDepth,
        call_site_ip: callSiteIp,
      });
    }
    return true;
  }

  // Leave an inlined function call, returning the return value IR ref
  leaveInlineFrame() {
    if (this.inlineDepth === 0) return;
    const frame = this.inlineFrames.pop();
    // Clean up slot refs for this inlined frame
    for (let i = 0; i < frame.numLocals; i++) {
      this.inlineSlotRefs.delete(frame.baseOffset + i);
    }
    this.inlineDepth--;
    if (JIT_EVENTS_FULL && this.trace) {
      emitEvent({
        t: 'inline_leave',
        key: `${this.trace.frameId}:${this.trace.startIp}`,
        depth: this.inlineDepth,
      });
    }
  }

  // Get the current base offset for local variable addressing
  // Returns 0 for root frame, or the inlined frame's baseOffset
  currentBaseOffset() {
    if (this.inlineFrames.length === 0) return 0;
    return this.inlineFrames[this.inlineFrames.length - 1].baseOffset;
  }

  // Get the appropriate exit IP for guard failures.
  // Inside inlined functions, guards should exit to the outermost callSiteIp
  // (the call instruction in the root frame) so the interpreter resumes at the
  // call site and side traces can record the correct alternate path.
  // Callee IPs are meaningless in the caller's frame.
  getGuardExitIp() {
    if (this.inlineDepth > 0) {
      // Return the outermost (bottom) inlined frame's callSiteIp
      // This is the IP in the root frame where the call chain started
      return this.inlineFrames[0].callSiteIp;
    }
    return null; // use the normal exit IP
  }

  // Capture a snapshot of the current interpreter state for deoptimization.
  // Returns a map of local slots and global indices to their current IR refs.
  // This enables the VM to restore state at the exact bytecode position when
  // a guard fails, rather than restarting from the trace entry.
  captureSnapshot() {
    return {
      locals: new Map(this.localSlotRefs),
      globals: new Map(this.globalSlotRefs),
      irStack: [...this.irStack], // copy of current virtual stack refs
    };
  }

  // Update slot tracking when a local is stored
  trackLocalStore(slot, irRef) {
    this.localSlotRefs.set(slot, irRef);
  }

  // Update slot tracking when a local is loaded
  trackLocalLoad(slot, irRef) {
    if (!this.localSlotRefs.has(slot)) {
      this.localSlotRefs.set(slot, irRef);
    }
  }

  // Update slot tracking when a global is stored
  trackGlobalStore(index, irRef) {
    this.globalSlotRefs.set(index, irRef);
  }

  // Update slot tracking when a global is loaded
  trackGlobalLoad(index, irRef) {
    if (!this.globalSlotRefs.has(index)) {
      this.globalSlotRefs.set(index, irRef);
    }
  }

  // Add a guard instruction with an attached snapshot.
  // The snapshot captures the current interpreter state (slot→IR ref mappings)
  // so that on guard failure the VM can restore state at the exact position.
  addGuardInst(op, operands) {
    const gid = this.trace.addInst(op, operands);
    const inst = this.trace.ir[gid];
    inst.snapshot = this.captureSnapshot();
    if (JIT_EVENTS_FULL) {
      // Tag the guard subset specifically — addInst already emitted a uop event
      // for it; this gives mimule's coverage manager a separate guard channel.
      const ev = {
        t: 'guard',
        key: `${this.trace.frameId}:${this.trace.startIp}`,
        op,
        guard_idx: gid,
      };
      if (operands.ref !== undefined) ev.ref = operands.ref;
      emitEvent(ev);
    }
    return gid;
  }

  // Push an IR ref onto the virtual stack
  pushRef(ref) {
    this.irStack.push(ref);
  }

  // Pop an IR ref from the virtual stack
  popRef() {
    return this.irStack.pop();
  }

  // Peek at an IR ref N positions from the top (0 = top)
  peekRef(n = 0) {
    return this.irStack[this.irStack.length - 1 - n];
  }

  // Record a guard for a value's type
  guardType(ref, value) {
    // Check if this ref has a trusted type from type annotations
    const trustedType = this.trustedTypeForRef(ref);
    if (trustedType) {
      this.typeMap.set(ref, trustedType);
      // No guard emitted — type is guaranteed by annotation
      return trustedType;
    }
    const exitIp = this.getGuardExitIp();
    if (value instanceof MonkeyInteger) {
      const gid = this.addGuardInst(IR.GUARD_INT, { ref, exitIp });
      this.typeMap.set(ref, 'int');
      this.trace.guardCount++;
      return 'int';
    } else if (value instanceof MonkeyBoolean) {
      const gid = this.addGuardInst(IR.GUARD_BOOL, { ref, exitIp });
      this.typeMap.set(ref, 'bool');
      this.trace.guardCount++;
      return 'bool';
    } else if (value instanceof MonkeyString) {
      const gid = this.addGuardInst(IR.GUARD_STRING, { ref, exitIp });
      this.typeMap.set(ref, 'string');
      this.trace.guardCount++;
      return 'string';
    }
    this.typeMap.set(ref, 'object');
    return 'object';
  }

  // Check if we already know a ref's type (skip redundant guards)
  knownType(ref) {
    return this.typeMap.get(ref) || null;
  }

  // Check if an IR ref corresponds to a local with a trusted type annotation
  trustedTypeForRef(ref) {
    if (this.trustedTypes.size === 0) return null;
    // Find if this ref came from a LOAD_LOCAL for a trusted slot
    const inst = this.trace.ir[ref];
    if (inst && inst.op === IR.LOAD_LOCAL && this.trustedTypes.has(inst.slot)) {
      return this.trustedTypes.get(inst.slot);
    }
    // Also check inlined slot refs
    for (const [slot, slotRef] of this.inlineSlotRefs) {
      if (slotRef === ref && this.trustedTypes.has(slot)) {
        return this.trustedTypes.get(slot);
      }
    }
    return null;
  }

  // Record an integer arithmetic operation
  recordIntArith(op, leftVal, rightVal) {
    const rightRef = this.popRef();
    const leftRef = this.popRef();

    // Guard types if not already known
    if (this.knownType(leftRef) !== 'int' && this.knownType(leftRef) !== 'raw_int') {
      this.guardType(leftRef, leftVal);
    }
    if (this.knownType(rightRef) !== 'int' && this.knownType(rightRef) !== 'raw_int') {
      this.guardType(rightRef, rightVal);
    }

    // Unbox (skip if already raw)
    let leftUnboxed = leftRef;
    if (this.knownType(leftRef) !== 'raw_int') {
      leftUnboxed = this.trace.addInst(IR.UNBOX_INT, { ref: leftRef });
      this.typeMap.set(leftUnboxed, 'raw_int');
    }
    let rightUnboxed = rightRef;
    if (this.knownType(rightRef) !== 'raw_int') {
      rightUnboxed = this.trace.addInst(IR.UNBOX_INT, { ref: rightRef });
      this.typeMap.set(rightUnboxed, 'raw_int');
    }

    // Operate on raw values
    let irOp;
    switch (op) {
      case Opcodes.OpAdd: case Opcodes.OpAddInt: case Opcodes.OpAddConst: irOp = IR.ADD_INT; break;
      case Opcodes.OpSub: case Opcodes.OpSubInt: case Opcodes.OpSubConst: irOp = IR.SUB_INT; break;
      case Opcodes.OpMul: case Opcodes.OpMulInt: case Opcodes.OpMulConst: irOp = IR.MUL_INT; break;
      case Opcodes.OpDiv: case Opcodes.OpDivInt: case Opcodes.OpDivConst: irOp = IR.DIV_INT; break;
      case Opcodes.OpMod: case Opcodes.OpModInt: case Opcodes.OpModConst: irOp = IR.MOD_INT; break;
    }
    const resultRef = this.trace.addInst(irOp, { left: leftUnboxed, right: rightUnboxed });
    this.typeMap.set(resultRef, 'raw_int');

    // Box result
    const boxedRef = this.trace.addInst(IR.BOX_INT, { ref: resultRef });
    this.typeMap.set(boxedRef, 'int');

    this.pushRef(boxedRef);
  }

  recordComparison(op, leftVal, rightVal) {
    const rightRef = this.popRef();
    const leftRef = this.popRef();

    if (leftVal instanceof MonkeyInteger && rightVal instanceof MonkeyInteger) {
      if (this.knownType(leftRef) !== 'int' && this.knownType(leftRef) !== 'raw_int') this.guardType(leftRef, leftVal);
      if (this.knownType(rightRef) !== 'int' && this.knownType(rightRef) !== 'raw_int') this.guardType(rightRef, rightVal);

      let lu = leftRef;
      if (this.knownType(leftRef) !== 'raw_int') {
        lu = this.trace.addInst(IR.UNBOX_INT, { ref: leftRef });
      }
      let ru = rightRef;
      if (this.knownType(rightRef) !== 'raw_int') {
        ru = this.trace.addInst(IR.UNBOX_INT, { ref: rightRef });
      }

      let irOp;
      switch (op) {
        case Opcodes.OpEqual: case Opcodes.OpEqualInt: irOp = IR.EQ; break;
        case Opcodes.OpNotEqual: case Opcodes.OpNotEqualInt: irOp = IR.NEQ; break;
        case Opcodes.OpGreaterThan: case Opcodes.OpGreaterThanInt: irOp = IR.GT; break;
        case Opcodes.OpLessThanInt: irOp = IR.LT; break;
      }
      const ref = this.trace.addInst(irOp, { left: lu, right: ru });
      this.typeMap.set(ref, 'raw_bool');

      // Result needs to be a MonkeyBoolean for the VM
      const boxed = this.trace.addInst(IR.CONST_BOOL, { ref });
      this.typeMap.set(boxed, 'bool');
      this.pushRef(boxed);
    } else {
      // Bail — too complex for now
      this.abort();
    }
  }
}

// --- JIT Engine ---
// Manages profiling, recording, compilation, and execution
export class JIT {
  constructor() {
    this.hotCounts = new Map();    // "frameId:ip" → count
    this.traces = new Map();       // "frameId:ip" → Trace
    this.funcTraces = new Map();   // CompiledFunction → Trace (function entry traces)
    this.funcCallCounts = new Map(); // CompiledFunction → count
    this.traceCount = 0;
    this.enabled = true;
    this.abortCounts = new Map();  // traceKey → abort count
    this.blacklisted = new Set();  // traceKeys that failed too many times
    this.uncompilableFns = new Set(); // functions that failed method compilation
  }

  // Get a trace key for a loop back-edge
  traceKey(closureId, ip) {
    return `${closureId}:${ip}`;
  }

  // Count a loop back-edge hit. Returns true if hot.
  countEdge(closureId, ip) {
    const key = this.traceKey(closureId, ip);
    if (this.blacklisted.has(key)) return false;
    const count = (this.hotCounts.get(key) || 0) + 1;
    this.hotCounts.set(key, count);
    if (JIT_EVENTS_FULL && count === HOT_LOOP_THRESHOLD) {
      emitEvent({ t: 'loop_hot', key, count });
    }
    return count >= HOT_LOOP_THRESHOLD;
  }

  // Record a trace abort at a location. After 3 aborts, blacklist it.
  recordAbort(closureId, ip) {
    const key = this.traceKey(closureId, ip);
    const count = (this.abortCounts.get(key) || 0) + 1;
    this.abortCounts.set(key, count);
    if (count >= 3 && !this.blacklisted.has(key)) {
      this.blacklisted.add(key);
      if (JIT_EVENTS_FULL) {
        emitEvent({ t: 'blacklisted', key, abort_count: count });
      }
    }
  }

  // Check if we have a compiled trace for this location
  getTrace(closureId, ip) {
    return this.traces.get(this.traceKey(closureId, ip)) || null;
  }

  // Store a compiled trace
  storeTrace(trace) {
    if (this.traceCount >= MAX_TRACES) return false;
    if (trace.isSideTrace && trace.parentTrace) {
      // Store as side trace on parent
      if (trace.parentTrace._sideTraceCount >= MAX_SIDE_TRACES) return false;
      trace.parentTrace.sideTraces[trace.parentGuardIdx] = trace;
      trace.parentTrace._sideTraceCount++;
      // Recompile parent to inline the side trace body
      this._recompileWithInlinedSideTraces(trace.parentTrace);
    } else {
      const key = this.traceKey(trace.frameId, trace.startIp);
      this.traces.set(key, trace);
    }
    this.traceCount++;
    return true;
  }

  // Recompile a parent trace with inlinable side traces embedded directly.
  // Only inlines side traces that end with loop_back and use simple arithmetic
  // on the same globals that the parent promotes.
  _recompileWithInlinedSideTraces(parentTrace) {
    try {
      const compiler = new TraceCompiler(parentTrace);
      const newCompiled = compiler.compile();
      if (newCompiled) {
        parentTrace.compiled = newCompiled;
        if (JIT_EVENTS_FULL) {
          emitEvent({
            t: 'recompile_inline',
            key: `${parentTrace.frameId}:${parentTrace.startIp}`,
            side_traces: parentTrace._sideTraceCount,
          });
        }
      }
    } catch (e) {
      // If recompilation fails, keep the old compiled function
    }
  }

  // Check if a guard exit is hot enough for a side trace
  shouldRecordSideTrace(trace, guardIdx) {
    if (!this.enabled) return false;
    if (trace.sideTraces[guardIdx]) return false; // already have one
    if (trace._sideTraceCount >= MAX_SIDE_TRACES) return false;
    // Don't record side traces for guards with operand stack values.
    // The root trace doesn't maintain the VM operand stack, so side traces
    // can't reliably read stack values that were only in the root's virtual state.
    const guardInst = trace.ir[guardIdx];
    if (guardInst && guardInst.snapshot && guardInst.snapshot.irStack && guardInst.snapshot.irStack.length > 0) {
      return false;
    }
    const exitCount = trace.sideExits.get(guardIdx) || 0;
    return exitCount >= HOT_EXIT_THRESHOLD;
  }

  // Count a function call. Returns true if hot enough to trace.
  countFuncCall(fn) {
    const count = (this.funcCallCounts.get(fn) || 0) + 1;
    this.funcCallCounts.set(fn, count);
    if (JIT_EVENTS_FULL && count === HOT_FUNC_THRESHOLD) {
      emitEvent({ t: 'func_hot', fn_id: fn.id, count });
    }
    return count >= HOT_FUNC_THRESHOLD;
  }

  // Get a compiled function trace
  getFuncTrace(fn) {
    return this.funcTraces.get(fn) || null;
  }

  // Store a compiled function trace
  storeFuncTrace(trace) {
    if (trace.tracedFn) {
      this.funcTraces.set(trace.tracedFn, trace);
      this.traceCount++;
    }
  }

  // Compile a function directly (method JIT, not tracing)
  compileFunction(fn, constants, vm) {
    // Only compile functions that have self-recursive calls (OpCurrentClosure)
    const ins = fn.instructions;
    let hasSelfCall = false;
    for (let i = 0; i < ins.length; i++) {
      if (ins[i] === Opcodes.OpCurrentClosure) { hasSelfCall = true; break; }
    }
    if (!hasSelfCall) return null;

    const compiler = new FunctionCompiler(fn, constants, vm);
    const compiled = compiler.compileSwitch();
    if (!compiled) return null;

    const trace = new Trace(fn, 0);
    trace.isFuncTrace = true;
    trace.tracedFn = fn;
    trace.compiled = compiled;
    trace._compiler = compiler;
    trace._compiledSource = compiler._compiledSource;
    return trace;
  }

  // Compile a trace to a JavaScript function
  compile(trace, vm) {
    // Optimize the trace before compilation
    const optimizer = new TraceOptimizer(trace);
    optimizer.optimize();

    const compiler = new TraceCompiler(trace, vm);
    trace.compiled = compiler.compile();
    const ok = trace.compiled !== null;
    if (JIT_EVENTS_FULL) {
      emitEvent({
        t: 'compile',
        key: `${trace.frameId}:${trace.startIp}`,
        ok,
        ir: trace.ir.length,
        guards: trace.guardCount,
        kind: trace.isFuncTrace ? 'func' : (trace.isSideTrace ? 'side' : 'loop'),
      });
    }
    return ok;
  }

  // Get JIT statistics for diagnostics
  getStats() {
    let rootTraces = 0;
    let sideTraceCount = 0;
    let totalGuards = 0;
    let totalIR = 0;
    const traceDetails = [];

    for (const [key, trace] of this.traces) {
      rootTraces++;
      totalGuards += trace.guards ? trace.guards.length : 0;
      totalIR += trace.ir ? trace.ir.length : 0;
      sideTraceCount += trace.sideTraces ? trace._sideTraceCount : 0;

      traceDetails.push({
        key,
        irCount: trace.ir ? trace.ir.length : 0,
        guardCount: trace.guards ? trace.guards.length : 0,
        sideTraces: trace.sideTraces ? trace._sideTraceCount : 0,
        hasCompiled: trace.compiled !== null,
      });
    }

    return {
      v: JIT_EVENTS_SCHEMA_VERSION,
      enabled: this.enabled,
      rootTraces,
      sideTraces: sideTraceCount,
      funcTraces: this.funcTraces.size,
      totalTraces: this.traceCount,
      totalIR,
      totalGuards,
      hotSites: this.hotCounts.size,
      blacklisted: this.blacklisted.size,
      aborts: [...this.abortCounts.values()].reduce((a, b) => a + b, 0),
      traces: traceDetails,
    };
  }

  // Dump a trace's IR for debugging (returns string)
  dumpTrace(trace) {
    if (!trace || !trace.ir) return '(no trace)';
    const lines = [`--- Trace ${trace.frameId}:${trace.startIp} (${trace.ir.length} IR ops, ${trace.guards ? trace.guards.length : 0} guards) ---`];
    for (let i = 0; i < trace.ir.length; i++) {
      const inst = trace.ir[i];
      const ops = inst.operands || {};
      const parts = [`  ${String(i).padStart(4, '0')} ${inst.op}`];
      if (ops.ref !== undefined) parts.push(`ref=${ops.ref}`);
      if (ops.left !== undefined) parts.push(`left=${ops.left}`);
      if (ops.right !== undefined) parts.push(`right=${ops.right}`);
      if (ops.value !== undefined) parts.push(`val=${ops.value}`);
      if (ops.slot !== undefined) parts.push(`slot=${ops.slot}`);
      if (ops.index !== undefined) parts.push(`idx=${ops.index}`);
      lines.push(parts.join(' '));
    }
    if (trace._compiledSource) {
      lines.push('--- Compiled JS ---');
      lines.push(trace._compiledSource);
    }
    lines.push('---');
    return lines.join('\n');
  }
}

// --- Trace Compiler ---
// Converts IR to a JavaScript function
export class TraceCompiler {
  constructor(trace, vm) {
    this.trace = trace;
    this.vm = vm;
    this.lines = [];
    this.varCount = 0;
  }

  freshVar() {
    return `v${this.varCount++}`;
  }

  // Analyze which globals/locals are loop-carried: loaded and stored with int boxing.
  // Returns sets of indices that can be promoted to raw JS variables.
  _analyzePromotable() {
    const ir = this.trace.ir;
    const globalStored = new Map(); // global index → 'int' | 'string'
    const localStored = new Map();

    for (const inst of ir) {
      if (!inst) continue;
      if (inst.op === IR.STORE_GLOBAL) {
        const valInst = ir[inst.operands.value];
        if (valInst && valInst.op === IR.BOX_INT) {
          globalStored.set(inst.operands.index, 'int');
        } else if (valInst && valInst.op === IR.BOX_STRING) {
          globalStored.set(inst.operands.index, 'string');
        }
      } else if (inst.op === IR.STORE_LOCAL) {
        const valInst = ir[inst.operands.value];
        if (valInst && valInst.op === IR.BOX_INT) {
          localStored.set(inst.operands.slot, 'int');
        } else if (valInst && valInst.op === IR.BOX_STRING) {
          localStored.set(inst.operands.slot, 'string');
        }
      }
    }
    return { globals: globalStored, locals: localStored };
  }

  _emitReturn(exitObj) {
    if (this._wbWrap) {
      return `return __wb(${exitObj});`;
    }
    return `return ${exitObj};`;
  }

  // Check if an IR instruction produces a raw JS number (not a MonkeyInteger)
  _isRawInt(inst) {
    const rawOps = new Set([
      IR.CONST_INT, IR.ADD_INT, IR.SUB_INT, IR.MUL_INT, IR.DIV_INT, IR.MOD_INT, IR.MOD_INT,
      IR.NEG, IR.UNBOX_INT,
    ]);
    if (rawOps.has(inst.op)) return true;
    // Promoted-raw loads are also raw
    if (inst._promotedRaw) return true;
    return false;
  }

  // Emit write-back of promoted variables to globals/stack
  _emitWriteBack(promoted, promotedVarNames) {
    const lines = [];
    for (const [idx] of promoted.globals) {
      const pv = promotedVarNames.get('g:' + idx);
      lines.push(`    __globals[${idx}] = __cachedInteger(${pv});`);
    }
    for (const [slot] of promoted.locals) {
      const pv = promotedVarNames.get('l:' + slot);
      lines.push(`    __stack[__bp + ${slot}] = __cachedInteger(${pv});`);
    }
    return lines;
  }

  // Emit a JS object literal for the snapshot attached to a guard instruction.
  // Maps local/global slots to their current JS variable names at codegen time.
  // Returns null if no snapshot is available for this guard.
  // Only includes entries for variables that have been emitted before this guard.
  _emitSnapshotLiteral(guardIdx) {
    if (!this._currentIr) return null;
    const inst = this._currentIr[guardIdx];
    if (!inst || !inst.snapshot) return null;

    const snap = inst.snapshot;
    const parts = [];

    // For locals in snapshot
    if (snap.locals.size > 0) {
      const localEntries = [];
      for (const [slot, irRef] of snap.locals) {
        // Check if this slot is promoted (has a dedicated let variable)
        const promotedName = this._promotedVarNames ? this._promotedVarNames.get('l:' + slot) : null;
        if (promotedName) {
          // Promoted locals are always current — use the promoted variable
          const ptype = this._promotedVarTypes ? this._promotedVarTypes.get('l:' + slot) : 'int';
          if (ptype === 'string') {
            localEntries.push(`${slot}: new __MonkeyString(${promotedName})`);
          } else {
            localEntries.push(`${slot}: __cachedInteger(${promotedName})`);
          }
        } else {
          const varName = this._varNames ? this._varNames.get(irRef) : null;
          if (varName && this._emittedVarIds && this._emittedVarIds.has(irRef)) {
            const irInst = this._currentIr[irRef];
            if (irInst && this._isRawInt(irInst)) {
              localEntries.push(`${slot}: __cachedInteger(${varName})`);
            } else if (irInst && irInst.op === IR.UNBOX_STRING) {
              localEntries.push(`${slot}: new __MonkeyString(${varName})`);
            } else {
              localEntries.push(`${slot}: ${varName}`);
            }
          }
        }
      }
      if (localEntries.length > 0) {
        parts.push(`locals: { ${localEntries.join(', ')} }`);
      }
    }

    // For globals in snapshot
    if (snap.globals.size > 0) {
      const globalEntries = [];
      for (const [idx, irRef] of snap.globals) {
        // Check if this global is promoted
        const promotedName = this._promotedVarNames ? this._promotedVarNames.get('g:' + idx) : null;
        if (promotedName) {
          // Promoted globals: box the raw value back to MonkeyInteger/MonkeyString
          const ptype = this._promotedVarTypes ? this._promotedVarTypes.get('g:' + idx) : 'int';
          if (ptype === 'string') {
            globalEntries.push(`${idx}: new __MonkeyString(${promotedName})`);
          } else {
            globalEntries.push(`${idx}: __cachedInteger(${promotedName})`);
          }        } else {
          const varName = this._varNames ? this._varNames.get(irRef) : null;
          if (varName && this._emittedVarIds && this._emittedVarIds.has(irRef)) {
            // Check if the value is a raw JS type that needs boxing
            const irInst = this._currentIr[irRef];
            if (irInst && this._isRawInt(irInst)) {
              globalEntries.push(`${idx}: __cachedInteger(${varName})`);
            } else if (irInst && irInst.op === IR.UNBOX_STRING) {
              globalEntries.push(`${idx}: new __MonkeyString(${varName})`);
            } else {
              globalEntries.push(`${idx}: ${varName}`);
            }
          }
        }
      }
      if (globalEntries.length > 0) {
        parts.push(`globals: { ${globalEntries.join(', ')} }`);
      }
    }

    if (parts.length === 0) return null;
    return `snapshot: { ${parts.join(', ')} }`;
  }

  // Emit a guard exit that inlines side trace dispatch.
  // Instead of returning to the VM, if a side trace exists for this guard,
  // call it directly and continue the loop on loop_back.
  _emitGuardExit(guardIdx, exitIp, condition, exitType = 'guard') {
    // Build snapshot object literal if snapshot data is available
    const snapCode = this._emitSnapshotLiteral(guardIdx);
    const exitObjBase = `exit: "${exitType}", guardIdx: ${guardIdx}, ip: ${exitIp}`;
    const exitObj = snapCode ? `{ ${exitObjBase}, ${snapCode} }` : `{ ${exitObjBase} }`;

    if (!this._inLoop) {
      // Pre-loop guard: simple exit, no side-trace dispatch, no continue loop
      this.lines.push(`  if (${condition}) {`);
      if (this._wbWrap) {
        this.lines.push(`    __wb(null);`);
      }
      this.lines.push(`    ${this._emitReturn(exitObj)}`);
      this.lines.push(`  }`);
      return;
    }
    this.lines.push(`  if (${condition}) {`);
    // Check if we can inline a side trace at compile time
    const sideTrace = this.trace.sideTraces[guardIdx];
    if (sideTrace && this._canInlineSideTrace(sideTrace)) {
      // Inline the side trace body directly — no function call overhead
      this._emitInlinedSideTrace(sideTrace);
      this.lines.push(`    continue loop;`);
      this.lines.push(`  }`);
      return;
    }
    // Check for side trace inline — __sideTraces is a plain object indexed by guard number
    this.lines.push(`    const __st_trace = __sideTraces[${guardIdx}];`);
    this.lines.push(`    if (__st_trace) {`);
    // Write back promoted vars before calling side trace
    if (this._wbWrap) {
      this.lines.push(`      __wb(null);`);
    }
    this.lines.push(`      const __sr = __st_trace.compiled(__stack, __sp, __bp, __globals, __consts, __free, __MonkeyInteger, __MonkeyBoolean, __MonkeyString, __MonkeyArray, __TRUE, __FALSE, __NULL, __cachedInteger, __internString, __isTruthy, __sideTraces);`);
    if (this._wbWrap) {
      // Reload promoted vars after side trace (it may have modified globals/locals)
      this.lines.push(`      __reloadPromoted();`);
    }
    this.lines.push(`      if (__sr && __sr.exit === 'loop_back') { continue loop; }`);
    this.lines.push(`      ${this._emitReturn('__sr')}`);
    this.lines.push(`    }`);
    this.lines.push(`    ${this._emitReturn(exitObj)}`);
    this.lines.push(`  }`);
  }

  // Check if a side trace can be inlined into its parent.
  // Requirements: ends with loop_end, only touches promoted globals/locals, simple body.
  _canInlineSideTrace(sideTrace) {
    if (!sideTrace.ir || sideTrace.ir.length === 0) return false;
    const ir = sideTrace.ir;
    const lastInst = ir[ir.length - 1];
    if (!lastInst || lastInst.op !== IR.LOOP_END) return false;

    // Check that all operations are simple
    const SIMPLE_OPS = new Set([
      IR.LOOP_START, IR.LOOP_END,
      IR.CONST_INT, IR.CONST_BOOL, IR.CONST_STRING, IR.CONST_NULL,
      IR.LOAD_GLOBAL, IR.STORE_GLOBAL,
      IR.LOAD_LOCAL, IR.STORE_LOCAL, IR.LOAD_STACK,
      IR.LOAD_FREE, IR.STORE_FREE,
      IR.GUARD_INT, IR.GUARD_BOOL, IR.GUARD_TRUTHY, IR.GUARD_FALSY,
      IR.GUARD_STRING, IR.GUARD_ARRAY,
      IR.UNBOX_INT, IR.BOX_INT,
      IR.UNBOX_STRING, IR.BOX_STRING,
      IR.ADD_INT, IR.SUB_INT, IR.MUL_INT, IR.DIV_INT, IR.MOD_INT,
      IR.GT, IR.LT, IR.EQ, IR.NEQ, IR.GTE, IR.LTE,
      IR.NEG, IR.NOT,
      IR.CONCAT, IR.INDEX, IR.HASH_LOOKUP,
      IR.CALL, IR.CALL_BUILTIN,
    ]);
    for (const inst of ir) {
      if (!inst) continue;
      if (!SIMPLE_OPS.has(inst.op)) return false;
    }

    // Check it only uses globals/locals that the parent promotes
    if (!this._promotedVarNames) return false;
    for (const inst of ir) {
      if (!inst) continue;
      if (inst.op === IR.LOAD_GLOBAL || inst.op === IR.STORE_GLOBAL) {
        if (!this._promotedVarNames.has('g:' + inst.operands.index)) return false;
      }
      if (inst.op === IR.LOAD_LOCAL || inst.op === IR.STORE_LOCAL) {
        if (!this._promotedVarNames.has('l:' + inst.operands.slot)) return false;
      }
    }
    return true;
  }

  // Emit the body of a side trace inline, using the parent's promoted variables.
  _emitInlinedSideTrace(sideTrace) {
    const ir = sideTrace.ir;
    const stVars = new Map();
    let vc = 0;

    for (const inst of ir) {
      if (!inst) continue;
      switch (inst.op) {
        case IR.LOOP_START:
        case IR.LOOP_END:
          break;
        case IR.CONST_INT:
          stVars.set(inst.id, String(inst.operands.value));
          break;
        case IR.CONST_BOOL:
          if (inst.operands.ref !== undefined) {
            // const_bool wrapping a comparison result — forward the ref
            stVars.set(inst.id, stVars.get(inst.operands.ref));
          } else {
            stVars.set(inst.id, inst.operands.value ? 'true' : 'false');
          }
          break;
        case IR.LOAD_GLOBAL:
          stVars.set(inst.id, this._promotedVarNames.get('g:' + inst.operands.index));
          break;
        case IR.STORE_GLOBAL: {
          const pv = this._promotedVarNames.get('g:' + inst.operands.index);
          const val = stVars.get(inst.operands.value) || 'undefined';
          this.lines.push(`    ${pv} = ${val};`);
          break;
        }
        case IR.LOAD_LOCAL:
          stVars.set(inst.id, this._promotedVarNames.get('l:' + inst.operands.slot));
          break;
        case IR.STORE_LOCAL: {
          const pv = this._promotedVarNames.get('l:' + inst.operands.slot);
          const val = stVars.get(inst.operands.value) || 'undefined';
          this.lines.push(`    ${pv} = ${val};`);
          break;
        }
        case IR.GUARD_INT:
        case IR.GUARD_BOOL:
        case IR.GUARD_STRING:
          break; // skip type guards — parent's type guards cover these
        case IR.GUARD_TRUTHY: {
          // Conditional guard — must be preserved even in inlined side traces
          const ref = stVars.get(inst.operands.ref);
          if (ref) {
            const exitIp = inst.operands.exitIp != null ? inst.operands.exitIp : sideTrace.startIp;
            this.lines.push(`    if (!${ref}) {`);
            if (this._wbWrap) this.lines.push(`      __wb(null);`);
            this.lines.push(`      return __wb({ exit: "guard_falsy", guardIdx: -1, ip: ${exitIp}, snapshot: {} });`);
            this.lines.push(`    }`);
          }
          break;
        }
        case IR.GUARD_FALSY: {
          const ref = stVars.get(inst.operands.ref);
          if (ref) {
            const exitIp = inst.operands.exitIp != null ? inst.operands.exitIp : sideTrace.startIp;
            this.lines.push(`    if (${ref}) {`);
            if (this._wbWrap) this.lines.push(`      __wb(null);`);
            this.lines.push(`      return __wb({ exit: "guard_truthy", guardIdx: -1, ip: ${exitIp}, snapshot: {} });`);
            this.lines.push(`    }`);
          }
          break;
        }
        case IR.UNBOX_INT:
        case IR.BOX_INT:
        case IR.UNBOX_STRING:
        case IR.BOX_STRING:
          stVars.set(inst.id, stVars.get(inst.operands.ref));
          break;
        case IR.ADD_INT: {
          const v = `__st${vc++}`;
          this.lines.push(`    const ${v} = (${stVars.get(inst.operands.left)} + ${stVars.get(inst.operands.right)});`);
          stVars.set(inst.id, v);
          break;
        }
        case IR.SUB_INT: {
          const v = `__st${vc++}`;
          this.lines.push(`    const ${v} = (${stVars.get(inst.operands.left)} - ${stVars.get(inst.operands.right)});`);
          stVars.set(inst.id, v);
          break;
        }
        case IR.MUL_INT: {
          const v = `__st${vc++}`;
          this.lines.push(`    const ${v} = (${stVars.get(inst.operands.left)} * ${stVars.get(inst.operands.right)});`);
          stVars.set(inst.id, v);
          break;
        }
        case IR.DIV_INT: {
          const v = `__st${vc++}`;
          this.lines.push(`    const ${v} = Math.trunc(${stVars.get(inst.operands.left)} / ${stVars.get(inst.operands.right)});`);
          stVars.set(inst.id, v);
          break;
        }
        case IR.MOD_INT: {
          const v = `__st${vc++}`;
          this.lines.push(`    const ${v} = (${stVars.get(inst.operands.left)} % ${stVars.get(inst.operands.right)});`);
          stVars.set(inst.id, v);
          break;
        }
        case IR.GT: case IR.LT: case IR.EQ: case IR.NEQ: {
          const v = `__st${vc++}`;
          const op = inst.op === IR.GT ? '>' : inst.op === IR.LT ? '<' : inst.op === IR.EQ ? '===' : '!==';
          this.lines.push(`    const ${v} = ${stVars.get(inst.operands.left)} ${op} ${stVars.get(inst.operands.right)};`);
          stVars.set(inst.id, v);
          break;
        }
      }
    }
  }

  compile() {
    const ir = this.trace.ir;
    const _innerVarNames = new Map();
    const emittedVarIds = new Set();
    // Proxy varNames to track which IR ids have been emitted
    const varNames = {
      set(id, name) { _innerVarNames.set(id, name); emittedVarIds.add(id); },
      get(id) { return _innerVarNames.get(id); },
      has(id) { return _innerVarNames.has(id); },
    };
    this._varNames = varNames;
    this._currentIr = ir;
    this._emittedVarIds = emittedVarIds;

    // Function traces get a completely different compilation path
    if (this.trace.isFuncTrace) {
      return this._compileFuncTrace(ir, varNames);
    }

    // Analyze which globals/locals can be promoted to raw JS variables
    const promotable = this._analyzePromotable();
    const promotedVarNames = new Map(); // 'g:N' or 'l:N' → JS let variable name
    this._promotedVarNames = promotedVarNames;
    const promotedVarTypes = new Map(); // 'g:N' or 'l:N' → 'int' | 'string'
    this._promotedVarTypes = promotedVarTypes;

    // --- Pre-pass: usage analysis for dead code elimination ---
    const usedRefs = new Set();
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;
      const ops = inst.operands;
      for (const key of Object.keys(ops)) {
        if (typeof ops[key] === 'number' && key !== 'value' && key !== 'slot' &&
            key !== 'index' && key !== 'exitIp' && key !== 'constIdx') {
          usedRefs.add(ops[key]);
        }
      }
    }

    // --- Pre-pass: push-in-place escape analysis ---
    // Detect pattern: LOAD_GLOBAL(idx) → BUILTIN_PUSH(array=load, value=v) → STORE_GLOBAL(value=push, idx)
    // If the load ref is only used by the push, and the push ref is only used by the store,
    // we can mutate the array in place instead of copying.
    const pushInPlace = new Set(); // IR indices of BUILTIN_PUSH that can be done in-place
    const pushInPlaceStore = new Set(); // IR indices of STORE_GLOBAL to skip (array already mutated)
    {
      // Count uses of each IR ref (including 'value' refs for stores/push)
      const refUseCount = new Map();
      const countUse = (ref) => { if (typeof ref === 'number') refUseCount.set(ref, (refUseCount.get(ref) || 0) + 1); };
      for (let i = 0; i < ir.length; i++) {
        const inst = ir[i];
        if (!inst) continue;
        const ops = inst.operands;
        for (const key of Object.keys(ops)) {
          if (key === 'slot' || key === 'index' || key === 'exitIp' || key === 'constIdx') continue;
          if (typeof ops[key] === 'number') countUse(ops[key]);
        }
      }
      for (let i = 0; i < ir.length; i++) {
        const inst = ir[i];
        if (!inst || inst.op !== IR.BUILTIN_PUSH) continue;
        const arrRef = inst.operands.array;
        const arrInst = ir[arrRef];
        if (!arrInst) continue;
        // Array must come from LOAD_GLOBAL or LOAD_LOCAL
        const isGlobal = arrInst.op === IR.LOAD_GLOBAL;
        const isLocal = arrInst.op === IR.LOAD_LOCAL;
        if (!isGlobal && !isLocal) continue;
        const slotKey = isGlobal ? 'index' : 'slot';
        const sourceSlot = arrInst.operands[slotKey];
        // The load must only be used by this push (use count = 1)
        if ((refUseCount.get(arrRef) || 0) !== 1) continue;
        // Find the store that uses this push result
        const pushRef = i;
        if ((refUseCount.get(pushRef) || 0) !== 1) continue;
        // Find the single consumer of the push result
        let storeIdx = -1;
        for (let j = i + 1; j < ir.length; j++) {
          const consumer = ir[j];
          if (!consumer) continue;
          if (isGlobal && consumer.op === IR.STORE_GLOBAL &&
              consumer.operands.value === pushRef && consumer.operands.index === sourceSlot) {
            storeIdx = j; break;
          }
          if (isLocal && consumer.op === IR.STORE_LOCAL &&
              consumer.operands.value === pushRef && consumer.operands.slot === sourceSlot) {
            storeIdx = j; break;
          }
        }
        if (storeIdx !== -1) {
          pushInPlace.add(i);
          pushInPlaceStore.add(storeIdx);
        }
      }
    }

    // --- Pre-pass: identify loop-invariant constants to hoist ---
    const hoistedConsts = new Map(); // IR index → { op, value }
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;
      if (inst.op === IR.CONST_INT || inst.op === IR.CONST_NULL) {
        hoistedConsts.set(i, inst);
      }
    }

    // --- Pre-pass: detect promoted-load-after-store conflicts ---
    // If a LOAD of a promoted slot is used after a STORE to the same slot,
    // the load must snapshot the value (can't alias the mutable promoted var).
    const needsSnapshot = new Set(); // IR indices of LOAD_GLOBAL/LOAD_LOCAL that need snapshot
    {
      for (let i = 0; i < ir.length; i++) {
        const inst = ir[i];
        if (!inst) continue;
        if (inst.op !== IR.LOAD_GLOBAL && inst.op !== IR.LOAD_LOCAL) continue;
        const isGlobal = inst.op === IR.LOAD_GLOBAL;
        const slot = isGlobal ? inst.operands.index : inst.operands.slot;
        const slotKey = isGlobal ? 'g:' + slot : 'l:' + slot;
        const isPromoted = isGlobal ? promotable.globals.has(slot) : promotable.locals.has(slot);
        if (!isPromoted) continue;
        // Check if there's a STORE to the same slot later
        for (let j = i + 1; j < ir.length; j++) {
          const later = ir[j];
          if (!later) continue;
          const isStoreToSame = (isGlobal && later.op === IR.STORE_GLOBAL && later.operands.index === slot) ||
                                (!isGlobal && later.op === IR.STORE_LOCAL && later.operands.slot === slot);
          if (isStoreToSame) {
            // Check if load i is referenced after store j
            for (let k = j + 1; k < ir.length; k++) {
              const user = ir[k];
              if (!user) continue;
              for (const val of Object.values(user.operands)) {
                if (val === i) { needsSnapshot.add(i); break; }
              }
              if (needsSnapshot.has(i)) break;
            }
            break;
          }
        }
      }
    }

    this.lines.push('"use strict";');
    this.lines.push('let __iterations = 0;');

    // Initialize promoted variables before the loop
    for (const [idx, type] of promotable.globals) {
      const pv = this.freshVar();
      promotedVarNames.set('g:' + idx, pv);
      promotedVarTypes.set('g:' + idx, type);
      this.lines.push(`let ${pv} = __globals[${idx}].value;`);
    }
    for (const [slot, type] of promotable.locals) {
      const pv = this.freshVar();
      promotedVarNames.set('l:' + slot, pv);
      promotedVarTypes.set('l:' + slot, type);
      this.lines.push(`let ${pv} = __stack[__bp + ${slot}].value;`);
    }

    // Generate __wb for write-back on exit
    const hasPromoted = promotable.globals.size > 0 || promotable.locals.size > 0;
    if (hasPromoted) {
      const wbStmts = [];
      for (const [idx, type] of promotable.globals) {
        const pv = promotedVarNames.get('g:' + idx);
        if (type === 'string') {
          wbStmts.push(`__globals[${idx}] = new __MonkeyString(${pv})`);
        } else {
          wbStmts.push(`__globals[${idx}] = __cachedInteger(${pv})`);
        }
      }
      for (const [slot, type] of promotable.locals) {
        const pv = promotedVarNames.get('l:' + slot);
        if (type === 'string') {
          wbStmts.push(`__stack[__bp + ${slot}] = new __MonkeyString(${pv})`);
        } else {
          wbStmts.push(`__stack[__bp + ${slot}] = __cachedInteger(${pv})`);
        }
      }
      this.lines.push(`function __wb(r) { ${wbStmts.join('; ')}; return r; }`);
      // Reload promoted vars after side trace execution (side trace may modify globals/locals)
      const reloadStmts = [];
      for (const [idx, type] of promotable.globals) {
        const pv = promotedVarNames.get('g:' + idx);
        reloadStmts.push(`${pv} = __globals[${idx}].value`);
      }
      for (const [slot, type] of promotable.locals) {
        const pv = promotedVarNames.get('l:' + slot);
        reloadStmts.push(`${pv} = __stack[__bp + ${slot}].value`);
      }
      this.lines.push(`function __reloadPromoted() { ${reloadStmts.join('; ')}; }`);
      this._wbWrap = true;
    } else {
      this._wbWrap = false;
    }

    // Emit hoisted constants before the loop
    for (const [idx, inst] of hoistedConsts) {
      const v = this.freshVar();
      varNames.set(idx, v);
      if (inst.op === IR.CONST_INT) {
        this.lines.push(`const ${v} = ${inst.operands.value};`);
      } else if (inst.op === IR.CONST_NULL) {
        this.lines.push(`const ${v} = __NULL;`);
      }
    }

    this._inLoop = false;

    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];

      // Skip hoisted constants — already emitted above the loop
      if (hoistedConsts.has(i)) continue;

      const v = this.freshVar();
      varNames.set(i, v);

      switch (inst.op) {
        case IR.LOOP_START:
          this.lines.push('loop: while (true) {');
          this.lines.push(`  if ((++__iterations & 0x7F) === 0 && __iterations > 100000) ${this._emitReturn('{ exit: "max_iter" }')}`);
          this._inLoop = true;
          break;

        case IR.LOOP_END:
          if (this.trace.isSideTrace) {
            // Side trace ends → return to parent trace's loop header
            this.lines.push(`  ${this._emitReturn('{ exit: "loop_back" }')}`);
          } else {
            this.lines.push('  continue loop;');
          }
          break;

        case IR.CONST_INT:
          this.lines.push(`  const ${v} = ${inst.operands.value};`);
          break;

        case IR.CONST_BOOL:
          if (inst.operands.ref !== undefined) {
            // Check if only used by guards that read through to raw bool
            // Only check actual IR ref keys (ref, left, right, and value for stores)
            const REF_KEYS_FOR_USE = ['ref', 'left', 'right'];
            const VALUE_IS_REF_FOR_USE = new Set([IR.STORE_LOCAL, IR.STORE_GLOBAL]);
            let onlyUsedByGuards = true;
            for (let j = i + 1; j < ir.length; j++) {
              const user = ir[j];
              if (!user) continue;
              let referencesUs = false;
              for (const key of REF_KEYS_FOR_USE) {
                if (user.operands[key] === i) { referencesUs = true; break; }
              }
              if (!referencesUs && VALUE_IS_REF_FOR_USE.has(user.op) && user.operands.value === i) {
                referencesUs = true;
              }
              if (referencesUs) {
                if (user.op !== IR.GUARD_TRUTHY && user.op !== IR.GUARD_FALSY) {
                  onlyUsedByGuards = false;
                  break;
                }
              }
            }
            if (onlyUsedByGuards) {
              // Guards read through to raw bool — skip MonkeyBoolean creation
            } else {
              const rawRef = varNames.get(inst.operands.ref);
              this.lines.push(`  const ${v} = ${rawRef} ? __TRUE : __FALSE;`);
            }
          } else {
            this.lines.push(`  const ${v} = ${inst.operands.value} ? __TRUE : __FALSE;`);
          }
          break;

        case IR.CONST_NULL:
          this.lines.push(`  const ${v} = __NULL;`);
          break;

        case IR.CONST_OBJ:
          // Store as a constant index and look up
          this.lines.push(`  const ${v} = __consts[${inst.operands.constIdx}];`);
          break;

        case IR.LOAD_LOCAL: {
          const pv = promotedVarNames.get('l:' + inst.operands.slot);
          if (pv) {
            if (needsSnapshot.has(i)) {
              // Value is used after the promoted var is overwritten — snapshot it
              this.lines.push(`  const ${v} = ${pv};`);
              inst._promotedRaw = true;
            } else {
              // Alias directly to promoted var — no new variable needed
              varNames.set(i, pv);
              inst._promotedRaw = true;
            }
          } else {
            this.lines.push(`  const ${v} = __stack[__bp + ${inst.operands.slot}];`);
          }
          break;
        }

        case IR.LOAD_STACK: {
          // Load a value from the VM operand stack (used in side traces
          // to reference values left on the stack by the parent trace)
          const numLocals = this.trace.numLocals || 0;
          this.lines.push(`  const ${v} = __stack[__bp + ${numLocals + inst.operands.stackOffset}];`);
          break;
        }

        case IR.LOAD_GLOBAL: {
          const pv = promotedVarNames.get('g:' + inst.operands.index);
          if (pv) {
            if (needsSnapshot.has(i)) {
              // Value is used after the promoted var is overwritten — snapshot it
              this.lines.push(`  const ${v} = ${pv};`);
              inst._promotedRaw = true;
            } else {
              // Alias directly to promoted var — no new variable needed
              varNames.set(i, pv);
              inst._promotedRaw = true;
            }
          } else {
            this.lines.push(`  const ${v} = __globals[${inst.operands.index}];`);
          }
          break;
        }

        case IR.LOAD_FREE:
          this.lines.push(`  const ${v} = __free[${inst.operands.index}];`);
          break;

        case IR.LOAD_CONST:
          this.lines.push(`  const ${v} = __consts[${inst.operands.index}];`);
          break;

        case IR.STORE_LOCAL: {
          const valRef = varNames.get(inst.operands.value);
          const pv = promotedVarNames.get('l:' + inst.operands.slot);
          if (pv) {
            // Find the raw value: if value is BOX_INT, use its raw ref instead
            const valInst = ir[inst.operands.value];
            if (valInst && valInst.op === IR.BOX_INT) {
              this.lines.push(`  ${pv} = ${varNames.get(valInst.operands.ref)};`);
            } else {
              this.lines.push(`  ${pv} = ${valRef};`);
            }
          } else {
            // Non-promoted local: must store a MonkeyObject, not raw values
            const valInst = ir[inst.operands.value];
            if (valInst && this._isRawInt(valInst)) {
              this.lines.push(`  __stack[__bp + ${inst.operands.slot}] = __cachedInteger(${valRef});`);
            } else {
              this.lines.push(`  __stack[__bp + ${inst.operands.slot}] = ${valRef};`);
            }
          }
          if (usedRefs.has(i)) this.lines.push(`  const ${v} = undefined;`);
          break;
        }

        case IR.STORE_GLOBAL: {
          if (pushInPlaceStore.has(i)) break; // array mutated in place, skip store
          const valRef = varNames.get(inst.operands.value);
          const pv = promotedVarNames.get('g:' + inst.operands.index);
          if (pv) {
            const valInst = ir[inst.operands.value];
            if (valInst && valInst.op === IR.BOX_INT) {
              this.lines.push(`  ${pv} = ${varNames.get(valInst.operands.ref)};`);
            } else if (valInst && valInst.op === IR.BOX_STRING) {
              this.lines.push(`  ${pv} = ${varNames.get(valInst.operands.ref)};`);
            } else {
              this.lines.push(`  ${pv} = ${valRef};`);
            }
          } else {
            // Non-promoted global: must store a MonkeyObject, not raw values
            const valInst = ir[inst.operands.value];
            if (valInst && this._isRawInt(valInst)) {
              this.lines.push(`  __globals[${inst.operands.index}] = __cachedInteger(${valRef});`);
            } else {
              this.lines.push(`  __globals[${inst.operands.index}] = ${valRef};`);
            }
          }
          if (usedRefs.has(i)) this.lines.push(`  const ${v} = undefined;`);
          break;
        }

        case IR.GUARD_INT: {
          const refInst = ir[inst.operands.ref];
          if (refInst && refInst._promotedRaw) {
            // Promoted var is always int — alias directly, skip guard
            varNames.set(i, varNames.get(inst.operands.ref));
            inst._promotedRaw = true;
          } else {
            const ref = varNames.get(inst.operands.ref);
            const exitIp = inst.operands.exitIp != null ? inst.operands.exitIp : this.trace.startIp;
            this._emitGuardExit(i, exitIp, `!(${ref} instanceof __MonkeyInteger)`);
            this.lines.push(`  const ${v} = ${ref};`);
          }
          break;
        }

        case IR.GUARD_BOOL: {
          const ref = varNames.get(inst.operands.ref);
          const exitIp = inst.operands.exitIp != null ? inst.operands.exitIp : this.trace.startIp;
          this._emitGuardExit(i, exitIp, `!(${ref} instanceof __MonkeyBoolean)`);
          this.lines.push(`  const ${v} = ${ref};`);
          break;
        }

        case IR.GUARD_STRING: {
          const refInst = ir[inst.operands.ref];
          if (refInst && refInst._promotedRaw) {
            // Promoted string var is already raw — alias directly, skip guard
            varNames.set(i, varNames.get(inst.operands.ref));
            inst._promotedRaw = true;
          } else {
            const ref = varNames.get(inst.operands.ref);
            const exitIp = inst.operands.exitIp != null ? inst.operands.exitIp : this.trace.startIp;
            this._emitGuardExit(i, exitIp, `!(${ref} instanceof __MonkeyString)`);
            this.lines.push(`  const ${v} = ${ref};`);
          }
          break;
        }

        case IR.GUARD_ARRAY: {
          const ref = varNames.get(inst.operands.ref);
          const exitIp = inst.operands.exitIp != null ? inst.operands.exitIp : this.trace.startIp;
          this._emitGuardExit(i, exitIp, `!(${ref} && ${ref}.elements)`);
          this.lines.push(`  const ${v} = ${ref};`);
          break;
        }

        case IR.GUARD_BOUNDS: {
          const arr = varNames.get(inst.operands.left);
          const idx = varNames.get(inst.operands.right);
          const exitIp = inst.operands.exitIp != null ? inst.operands.exitIp : this.trace.startIp;
          if (inst._upperBoundProven) {
            // Upper bound already checked by loop condition — only check lower bound
            this._emitGuardExit(i, exitIp, `(${idx} < 0)`);
          } else {
            this._emitGuardExit(i, exitIp, `(${idx} < 0 || ${idx} >= ${arr}.elements.length)`);
          }
          break;
        }

        case IR.GUARD_CLOSURE: {
          const closureRef = varNames.get(inst.operands.ref);
          const fnId = inst.operands.fnId;
          const exitIp = inst.operands.exitIp;
          if (exitIp === -1) {
            // Invalidate trace — return a special marker that tells the VM to blacklist this trace
            this.lines.push(`  if (${closureRef}.fn.id !== ${fnId}) {`);
            this.lines.push(`    return { exit: "invalidate", guardIdx: ${i} };`);
            this.lines.push(`  }`);
          } else {
            this._emitGuardExit(i, exitIp, `(${closureRef}.fn.id !== ${fnId})`);
          }
          break;
        }

        case IR.INDEX_ARRAY: {
          const arr = varNames.get(inst.operands.left);
          const idx = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = ${arr}.elements[${idx}];`);
          break;
        }

        case IR.GUARD_HASH: {
          const ref = varNames.get(inst.operands.ref);
          const exitIp = inst.operands.exitIp != null ? inst.operands.exitIp : this.trace.startIp;
          this._emitGuardExit(i, exitIp, `!(${ref} && ${ref}.pairs)`);
          this.lines.push(`  const ${v} = ${ref};`);
          break;
        }

        case IR.INDEX_HASH: {
          const hash = varNames.get(inst.operands.left);
          const key = varNames.get(inst.operands.right);
          // Cache fastHashKey() per key ref to avoid recomputing in loops
          const keyRef = inst.operands.right;
          if (!this._hashKeyCache) this._hashKeyCache = new Map();
          let hashKeyVar;
          if (this._hashKeyCache.has(keyRef)) {
            hashKeyVar = this._hashKeyCache.get(keyRef);
          } else {
            hashKeyVar = `__hk${keyRef}`;
            this.lines.push(`  const ${hashKeyVar} = ${key}.fastHashKey();`);
            this._hashKeyCache.set(keyRef, hashKeyVar);
          }
          this.lines.push(`  const ${v}_pair = ${hash}.pairs.get(${hashKeyVar});`);
          this.lines.push(`  const ${v} = ${v}_pair ? ${v}_pair.value : __NULL;`);
          break;
        }

        case IR.BUILTIN_LEN: {
          const ref = varNames.get(inst.operands.ref);
          // Works for both arrays and strings
          this.lines.push(`  const ${v} = ${ref}.elements ? ${ref}.elements.length : ${ref}.value.length;`);
          break;
        }

        case IR.BUILTIN_PUSH: {
          const arr = varNames.get(inst.operands.array);
          const val = varNames.get(inst.operands.value);
          if (pushInPlace.has(i)) {
            // Escape analysis: old array doesn't escape, mutate in place
            // Must box raw int values before pushing into array
            const valInst = ir[inst.operands.value];
            if (valInst && this._isRawInt(valInst)) {
              this.lines.push(`  ${arr}.elements.push(__cachedInteger(${val}));`);
            } else {
              this.lines.push(`  ${arr}.elements.push(${val});`);
            }
            varNames.set(i, arr); // push result IS the same array
          } else {
            this.lines.push(`  const ${v} = new __MonkeyArray([...${arr}.elements, ${val}]);`);
          }
          break;
        }

        case IR.GUARD_TRUTHY: {
          const ref = varNames.get(inst.operands.ref);
          const exitIp = inst.operands.exitIp != null ? inst.operands.exitIp : this.trace.startIp;
          // Optimize: if ref is a CONST_BOOL wrapping a raw comparison, test the raw bool directly
          const refInst = ir[inst.operands.ref];
          let condition;
          if (refInst && refInst.op === IR.CONST_BOOL && refInst.operands.ref !== undefined) {
            const rawBoolVar = varNames.get(refInst.operands.ref);
            condition = `!${rawBoolVar}`;
          } else {
            condition = `typeof ${ref} === 'boolean' ? !${ref} : !__isTruthy(${ref})`;
          }
          this._emitGuardExit(i, exitIp, condition, 'guard_falsy');
          if (usedRefs.has(i)) this.lines.push(`  const ${v} = true;`);
          break;
        }

        case IR.GUARD_FALSY: {
          const ref = varNames.get(inst.operands.ref);
          const exitIp = inst.operands.exitIp != null ? inst.operands.exitIp : this.trace.startIp;
          const refInst = ir[inst.operands.ref];
          let condition;
          if (refInst && refInst.op === IR.CONST_BOOL && refInst.operands.ref !== undefined) {
            const rawBoolVar = varNames.get(refInst.operands.ref);
            condition = `${rawBoolVar}`;
          } else {
            condition = `typeof ${ref} === 'boolean' ? ${ref} : __isTruthy(${ref})`;
          }
          this._emitGuardExit(i, exitIp, condition, 'guard_truthy');
          if (usedRefs.has(i)) this.lines.push(`  const ${v} = true;`);
          break;
        }

        case IR.UNBOX_INT: {
          const refInst = ir[inst.operands.ref];
          if (refInst && refInst._promotedRaw) {
            // Already raw — alias directly
            varNames.set(i, varNames.get(inst.operands.ref));
          } else {
            const ref = varNames.get(inst.operands.ref);
            this.lines.push(`  const ${v} = ${ref}.value;`);
          }
          break;
        }

        case IR.BOX_INT: {
          const ref = varNames.get(inst.operands.ref);
          // Check if this BOX_INT only feeds promoted stores — if so, skip it
          // Must verify no other instruction uses this value (e.g., UNBOX_INT, ADD)
          let usedByNonPromotedStore = false;
          let usedByOtherInst = false;
          for (let j = i + 1; j < ir.length; j++) {
            const user = ir[j];
            if (!user) continue;
            // Check if any operand of this instruction references our BOX_INT
            const ops = user.operands;
            for (const key of Object.keys(ops)) {
              if (ops[key] === i) {
                if ((user.op === IR.STORE_GLOBAL || user.op === IR.STORE_LOCAL) && key === 'value') {
                  const storeKey = user.op === IR.STORE_GLOBAL ? 'g:' + user.operands.index : 'l:' + user.operands.slot;
                  if (!promotedVarNames.has(storeKey)) usedByNonPromotedStore = true;
                } else {
                  usedByOtherInst = true;
                }
              }
            }
          }
          if (promotedVarNames.size > 0 && !usedByNonPromotedStore && !usedByOtherInst) {
            // Dead box — don't emit anything
          } else {
            this.lines.push(`  const ${v} = __cachedInteger(${ref});`);
          }
          break;
        }

        case IR.UNBOX_STRING: {
          const ref = varNames.get(inst.operands.ref);
          // If operand is a promoted string variable, it's already raw
          const refInst = ir[inst.operands.ref];
          if (refInst && refInst._promotedRaw) {
            varNames.set(i, ref);  // alias
          } else {
            this.lines.push(`  const ${v} = ${ref}.value;`);
          }
          break;
        }

        case IR.BOX_STRING: {
          const ref = varNames.get(inst.operands.ref);
          // Same dead-box elimination as BOX_INT: skip if only feeds promoted stores
          let usedByNonPromotedStore = false;
          let usedByOtherInst = false;
          for (let j = i + 1; j < ir.length; j++) {
            const user = ir[j];
            if (!user) continue;
            const ops = user.operands;
            for (const key of Object.keys(ops)) {
              if (ops[key] === i) {
                if ((user.op === IR.STORE_GLOBAL || user.op === IR.STORE_LOCAL) && key === 'value') {
                  const storeKey = user.op === IR.STORE_GLOBAL ? 'g:' + user.operands.index : 'l:' + user.operands.slot;
                  if (!promotedVarNames.has(storeKey)) usedByNonPromotedStore = true;
                } else {
                  usedByOtherInst = true;
                }
              }
            }
          }
          if (promotedVarNames.size > 0 && !usedByNonPromotedStore && !usedByOtherInst) {
            // Dead box — don't emit anything
          } else {
            this.lines.push(`  const ${v} = new __MonkeyString(${ref});`);
          }
          break;
        }

        case IR.ADD_INT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = (${l} + ${r});`);
          break;
        }

        case IR.SUB_INT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = (${l} - ${r});`);
          break;
        }

        case IR.MUL_INT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = (${l} * ${r});`);
          break;
        }

        case IR.DIV_INT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = Math.trunc(${l} / ${r});`);
          break;
        }

        case IR.MOD_INT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = (${l} % ${r});`);
          break;
        }
        case IR.EQ: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = ${l} === ${r};`);
          break;
        }

        case IR.NEQ: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = ${l} !== ${r};`);
          break;
        }

        case IR.GT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = ${l} > ${r};`);
          break;
        }

        case IR.LT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = ${l} < ${r};`);
          break;
        }

        case IR.NEG: {
          const ref = varNames.get(inst.operands.ref);
          this.lines.push(`  const ${v} = -${ref};`);
          break;
        }

        case IR.NOT: {
          const ref = varNames.get(inst.operands.ref);
          // Handle raw bools and MonkeyObjects
          this.lines.push(`  const ${v} = (typeof ${ref} === 'boolean') ? !${ref} : !__isTruthy(${ref});`);
          break;
        }

        case IR.CONCAT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          // If operands are raw strings (from UNBOX_STRING), concat directly
          const lInst = ir[inst.operands.left];
          const rInst = ir[inst.operands.right];
          const lRaw = lInst && (lInst.op === IR.UNBOX_STRING || lInst._promotedRaw);
          const rRaw = rInst && (rInst.op === IR.UNBOX_STRING || rInst._promotedRaw);
          if (lRaw && rRaw) {
            // Both raw strings — just JS string concat
            this.lines.push(`  const ${v} = (${l} + ${r});`);
          } else {
            // Fallback: access .value
            this.lines.push(`  const ${v} = new __MonkeyString(${l}.value + ${r}.value);`);
          }
          break;
        }

        case IR.CALL:
          // For now, calls bail to interpreter
          this.lines.push(`  ${this._emitReturn(`{ exit: "call", ip: ${this.trace.startIp} }`)}`);
          break;

        case IR.SELF_CALL: {
          // Recursive call to the traced function itself
          // Args are IR refs — we need to box them and call our compiled function
          const argRefs = inst.operands.args;
          const argVars = argRefs.map(ref => {
            const refInst = ir[ref];
            if (refInst && this._isRawInt(refInst)) {
              return `__cachedInteger(${varNames.get(ref)})`;
            }
            return varNames.get(ref);
          });
          // __self is the compiled function trace passed as a parameter
          // We call through __selfCall which handles setup
          this.lines.push(`  const ${v}_boxed = __selfCall(${argVars.join(', ')});`);
          // The result is a MonkeyObject — unbox if needed later
          this.lines.push(`  const ${v} = ${v}_boxed;`);
          break;
        }

        case IR.FUNC_RETURN: {
          // Return from function trace
          const ref = varNames.get(inst.operands.ref);
          const refInst = ir[inst.operands.ref];
          if (refInst && this._isRawInt(refInst)) {
            this.lines.push(`  return __cachedInteger(${ref});`);
          } else {
            this.lines.push(`  return ${ref};`);
          }
          break;
        }

        case IR.EXEC_TRACE: {
          // Trace stitching: call an inner compiled trace function
          // Write back promoted vars before calling (inner trace reads from stack/globals)
          for (const idx of promotable.globals) {
            const pv = promotedVarNames.get('g:' + idx);
            this.lines.push(`  __globals[${idx}] = __cachedInteger(${pv});`);
          }
          for (const slot of promotable.locals) {
            const pv = promotedVarNames.get('l:' + slot);
            this.lines.push(`  __stack[__bp + ${slot}] = __cachedInteger(${pv});`);
          }
          // Call the inner trace function
          this.lines.push(`  const ${v}_inner = __consts[${inst.operands.constIdx}];`);
          this.lines.push(`  let ${v} = ${v}_inner(__stack, __sp, __bp, __globals, __consts, __free, __MonkeyInteger, __MonkeyBoolean, __MonkeyString, __MonkeyArray, __TRUE, __FALSE, __NULL, __cachedInteger, __internString, __isTruthy, __sideTraces);`);
          // After inner trace, reload promoted vars (inner trace may have modified them)
          for (const idx of promotable.globals) {
            const pv = promotedVarNames.get('g:' + idx);
            this.lines.push(`  ${pv} = __globals[${idx}].value;`);
          }
          for (const slot of promotable.locals) {
            const pv = promotedVarNames.get('l:' + slot);
            this.lines.push(`  ${pv} = __stack[__bp + ${slot}].value;`);
          }
          break;
        }

        default:
          this.lines.push(`  /* unknown IR: ${inst.op} */`);
      }
    }

    this.lines.push('}'); // end while loop

    const body = this.lines.join('\n');
    this.trace._compiledSource = body;

    try {
      const fn = new Function(
        '__stack', '__sp', '__bp', '__globals', '__consts', '__free',
        '__MonkeyInteger', '__MonkeyBoolean', '__MonkeyString', '__MonkeyArray',
        '__TRUE', '__FALSE', '__NULL',
        '__cachedInteger', '__internString', '__isTruthy', '__sideTraces',
        body
      );
      return fn;
    } catch (e) {
      // Compilation failed — trace had issues
      return null;
    }
  }

  // Compile a function trace — straight-line code, takes args, returns value
  _compileFuncTrace(ir, varNames) {
    this.lines.push('"use strict";');

    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;
      const v = this.freshVar();
      varNames.set(i, v);

      switch (inst.op) {
        case IR.LOAD_LOCAL: {
          // In function traces, locals are read from __stack[__bp + slot]
          this.lines.push(`  const ${v} = __stack[__bp + ${inst.operands.slot}];`);
          break;
        }

        case IR.LOAD_STACK: {
          const numLocals = this.trace.numLocals || 0;
          this.lines.push(`  const ${v} = __stack[__bp + ${numLocals + inst.operands.stackOffset}];`);
          break;
        }

        case IR.LOAD_GLOBAL: {
          this.lines.push(`  const ${v} = __globals[${inst.operands.index}];`);
          break;
        }

        case IR.LOAD_FREE:
          this.lines.push(`  const ${v} = __free[${inst.operands.index}];`);
          break;

        case IR.LOAD_CONST:
          this.lines.push(`  const ${v} = __consts[${inst.operands.index}];`);
          break;

        case IR.CONST_INT:
          this.lines.push(`  const ${v} = ${inst.operands.value};`);
          break;

        case IR.CONST_BOOL:
          if (inst.operands.ref !== undefined) {
            const rawRef = varNames.get(inst.operands.ref);
            this.lines.push(`  const ${v} = ${rawRef} ? __TRUE : __FALSE;`);
          } else {
            this.lines.push(`  const ${v} = ${inst.operands.value} ? __TRUE : __FALSE;`);
          }
          break;

        case IR.CONST_NULL:
          this.lines.push(`  const ${v} = __NULL;`);
          break;

        case IR.CONST_OBJ:
          this.lines.push(`  const ${v} = __consts[${inst.operands.constIdx}];`);
          break;

        case IR.STORE_LOCAL: {
          const valRef = varNames.get(inst.operands.value);
          const valInst = ir[inst.operands.value];
          if (valInst && this._isRawInt(valInst)) {
            this.lines.push(`  __stack[__bp + ${inst.operands.slot}] = __cachedInteger(${valRef});`);
          } else {
            this.lines.push(`  __stack[__bp + ${inst.operands.slot}] = ${valRef};`);
          }
          this.lines.push(`  const ${v} = undefined;`);
          break;
        }

        case IR.STORE_GLOBAL: {
          const valRef = varNames.get(inst.operands.value);
          const valInst = ir[inst.operands.value];
          if (valInst && this._isRawInt(valInst)) {
            this.lines.push(`  __globals[${inst.operands.index}] = __cachedInteger(${valRef});`);
          } else {
            this.lines.push(`  __globals[${inst.operands.index}] = ${valRef};`);
          }
          this.lines.push(`  const ${v} = undefined;`);
          break;
        }

        case IR.GUARD_INT: {
          const ref = varNames.get(inst.operands.ref);
          this.lines.push(`  if (!(${ref} instanceof __MonkeyInteger)) return { exit: "guard", ip: 0 };`);
          this.lines.push(`  const ${v} = ${ref};`);
          break;
        }

        case IR.GUARD_BOOL: {
          const ref = varNames.get(inst.operands.ref);
          this.lines.push(`  if (!(${ref} instanceof __MonkeyBoolean)) return { exit: "guard", ip: 0 };`);
          this.lines.push(`  const ${v} = ${ref};`);
          break;
        }

        case IR.GUARD_TRUTHY: {
          const ref = varNames.get(inst.operands.ref);
          const refInst = ir[inst.operands.ref];
          let condition;
          if (refInst && refInst.op === IR.CONST_BOOL && refInst.operands.ref !== undefined) {
            condition = `!${varNames.get(refInst.operands.ref)}`;
          } else {
            condition = `typeof ${ref} === 'boolean' ? !${ref} : !__isTruthy(${ref})`;
          }
          this.lines.push(`  if (${condition}) return { exit: "guard", ip: 0 };`);
          this.lines.push(`  const ${v} = true;`);
          break;
        }

        case IR.GUARD_FALSY: {
          const ref = varNames.get(inst.operands.ref);
          const refInst = ir[inst.operands.ref];
          let condition;
          if (refInst && refInst.op === IR.CONST_BOOL && refInst.operands.ref !== undefined) {
            condition = `${varNames.get(refInst.operands.ref)}`;
          } else {
            condition = `typeof ${ref} === 'boolean' ? ${ref} : __isTruthy(${ref})`;
          }
          this.lines.push(`  if (${condition}) return { exit: "guard", ip: 0 };`);
          this.lines.push(`  const ${v} = true;`);
          break;
        }

        case IR.UNBOX_INT: {
          const ref = varNames.get(inst.operands.ref);
          this.lines.push(`  const ${v} = ${ref}.value;`);
          break;
        }

        case IR.BOX_INT: {
          const ref = varNames.get(inst.operands.ref);
          this.lines.push(`  const ${v} = __cachedInteger(${ref});`);
          break;
        }

        case IR.UNBOX_STRING: {
          const ref = varNames.get(inst.operands.ref);
          const refInst = ir[inst.operands.ref];
          if (refInst && refInst._promotedRaw) {
            varNames.set(inst.id, ref);
          } else {
            this.lines.push(`  const ${v} = ${ref}.value;`);
          }
          break;
        }

        case IR.BOX_STRING: {
          const ref = varNames.get(inst.operands.ref);
          this.lines.push(`  const ${v} = new __MonkeyString(${ref});`);
          break;
        }

        case IR.ADD_INT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = (${l} + ${r});`);
          break;
        }

        case IR.SUB_INT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = (${l} - ${r});`);
          break;
        }

        case IR.MUL_INT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = (${l} * ${r});`);
          break;
        }

        case IR.DIV_INT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = Math.trunc(${l} / ${r});`);
          break;
        }

        case IR.MOD_INT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = (${l} % ${r});`);
          break;
        }
        case IR.EQ: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = ${l} === ${r};`);
          break;
        }

        case IR.NEQ: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = ${l} !== ${r};`);
          break;
        }

        case IR.GT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = ${l} > ${r};`);
          break;
        }

        case IR.LT: {
          const l = varNames.get(inst.operands.left);
          const r = varNames.get(inst.operands.right);
          this.lines.push(`  const ${v} = ${l} < ${r};`);
          break;
        }

        case IR.NEG: {
          const ref = varNames.get(inst.operands.ref);
          this.lines.push(`  const ${v} = -${ref};`);
          break;
        }

        case IR.NOT: {
          const ref = varNames.get(inst.operands.ref);
          this.lines.push(`  const ${v} = (typeof ${ref} === 'boolean') ? !${ref} : !__isTruthy(${ref});`);
          break;
        }

        case IR.CONCAT: {
          const l = stVars.get(inst.operands.left) || varNames.get(inst.operands.left);
          const r = stVars.get(inst.operands.right) || varNames.get(inst.operands.right);
          // Use raw string concat when operands are from UNBOX_STRING/promoted
          const lInst = stIR[inst.operands.left] || ir[inst.operands.left];
          const rInst = stIR[inst.operands.right] || ir[inst.operands.right];
          const lRaw = lInst && (lInst.op === IR.UNBOX_STRING || lInst._promotedRaw);
          const rRaw = rInst && (rInst.op === IR.UNBOX_STRING || rInst._promotedRaw);
          if (lRaw && rRaw) {
            this.lines.push(`    const ${v} = (${l} + ${r});`);
          } else {
            this.lines.push(`    const ${v} = new __MonkeyString(${l}.value + ${r}.value);`);
          }
          break;
        }

        case IR.SELF_CALL: {
          const argRefs = inst.operands.args;
          const argVars = argRefs.map(ref => {
            const refInst = ir[ref];
            if (refInst && this._isRawInt(refInst)) {
              return `__cachedInteger(${varNames.get(ref)})`;
            }
            return varNames.get(ref);
          });
          this.lines.push(`  const ${v} = __selfCall(${argVars.join(', ')});`);
          break;
        }

        case IR.FUNC_RETURN: {
          const ref = varNames.get(inst.operands.ref);
          const refInst = ir[inst.operands.ref];
          if (refInst && this._isRawInt(refInst)) {
            this.lines.push(`  return __cachedInteger(${ref});`);
          } else {
            this.lines.push(`  return ${ref};`);
          }
          break;
        }

        // Skip loop control IR in func traces
        case IR.LOOP_START:
        case IR.LOOP_END:
          break;

        default:
          this.lines.push(`  /* unknown IR: ${inst.op} */`);
      }
    }

    const body = this.lines.join('\n');
    this.trace._compiledSource = body;

    try {
      const fn = new Function(
        '__stack', '__sp', '__bp', '__globals', '__consts', '__free',
        '__MonkeyInteger', '__MonkeyBoolean', '__MonkeyString',
        '__TRUE', '__FALSE', '__NULL',
        '__cachedInteger', '__internString', '__isTruthy', '__selfCall',
        body
      );
      return fn;
    } catch (e) {
      return null;
    }
  }
}

// --- Trace Optimization Passes ---
// Run between recording and compilation to improve generated code quality.
// Key insight from LuaJIT: optimizations on linear traces are trivially simple
// because there's no control flow graph — just a flat instruction sequence.

export class TraceOptimizer {
  constructor(trace) {
    this.trace = trace;
  }

  // Run all optimization passes in order
  optimize() {
    this.storeToLoadForwarding();
    this.boxUnboxElimination();
    this.commonSubexpressionElimination();
    this.unboxDeduplication();
    this.redundantGuardElimination();
    this.rangeCheckElimination();
    this.constantPropagation();
    this.constantFolding();
    this.algebraicSimplification();
    this.deadStoreElimination();
    this.loopInvariantCodeMotion();
    this.deadCodeElimination();
    return this.trace;
  }

  // --- Pass 0: Store-to-Load Forwarding ---
  // If we store a value to a global/local and later load from the same slot
  // (with no intervening store to that slot), replace the load with the stored value.
  // This eliminates the box→store→load→guard→unbox chain across loop iterations.
  storeToLoadForwarding() {
    const ir = this.trace.ir;
    // Track last stored value ref per slot: 'local:N' or 'global:N' → IR ref
    const lastStore = new Map();
    let forwarded = 0;

    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;

      // Track stores
      if (inst.op === IR.STORE_LOCAL) {
        lastStore.set(`local:${inst.operands.slot}`, inst.operands.value);
        continue;
      }
      if (inst.op === IR.STORE_GLOBAL) {
        lastStore.set(`global:${inst.operands.index}`, inst.operands.value);
        continue;
      }

      // Forward loads
      if (inst.op === IR.LOAD_LOCAL) {
        const key = `local:${inst.operands.slot}`;
        const storedRef = lastStore.get(key);
        if (storedRef !== undefined) {
          // Replace this load with a reference to the stored value
          // We need to remap all references to this instruction to point to storedRef
          this._replaceRef(ir, i, storedRef);
          ir[i] = null;
          forwarded++;
        }
        continue;
      }
      if (inst.op === IR.LOAD_GLOBAL) {
        const key = `global:${inst.operands.index}`;
        const storedRef = lastStore.get(key);
        if (storedRef !== undefined) {
          this._replaceRef(ir, i, storedRef);
          ir[i] = null;
          forwarded++;
        }
        continue;
      }

      // CALL invalidates all stores (callee may modify anything)
      if (inst.op === IR.CALL || inst.op === IR.SELF_CALL) {
        lastStore.clear();
      }
    }

    if (forwarded > 0) this._compact();
    return forwarded;
  }

  // Replace all references to oldRef with newRef in subsequent instructions
  _replaceRef(ir, oldRef, newRef) {
    const REF_KEYS = ['ref', 'left', 'right'];
    const VALUE_IS_REF = new Set([IR.STORE_LOCAL, IR.STORE_GLOBAL]);

    for (let i = oldRef + 1; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;
      const ops = inst.operands;
      for (const key of REF_KEYS) {
        if (ops[key] === oldRef) ops[key] = newRef;
      }
      if (ops.array === oldRef) ops.array = newRef;
      if (ops.value === oldRef && (VALUE_IS_REF.has(inst.op) || inst.op === IR.BUILTIN_PUSH)) {
        ops.value = newRef;
      }
      if (Array.isArray(ops.args)) {
        for (let j = 0; j < ops.args.length; j++) {
          if (ops.args[j] === oldRef) ops.args[j] = newRef;
        }
      }
      // Update snapshots: replace old ref with new ref
      if (inst.snapshot) {
        for (const [slot, ref] of inst.snapshot.locals) {
          if (ref === oldRef) inst.snapshot.locals.set(slot, newRef);
        }
        for (const [idx, ref] of inst.snapshot.globals) {
          if (ref === oldRef) inst.snapshot.globals.set(idx, newRef);
        }
        if (inst.snapshot.irStack) {
          for (let j = 0; j < inst.snapshot.irStack.length; j++) {
            if (inst.snapshot.irStack[j] === oldRef) inst.snapshot.irStack[j] = newRef;
          }
        }
      }
    }
  }

  // --- Pass 0.5: Box-Unbox Elimination ---
  // UNBOX_INT(BOX_INT(x)) → x. Also BOX_INT(UNBOX_INT(x)) → x if x is known integer.
  // This is common after store-to-load forwarding: store(BOX_INT(raw)) → load eliminated →
  // but downstream still does UNBOX_INT on the BOX_INT ref.
  boxUnboxElimination() {
    const ir = this.trace.ir;
    let eliminated = 0;

    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;

      // UNBOX_INT(BOX_INT(x)) → x
      if (inst.op === IR.UNBOX_INT) {
        const refInst = ir[inst.operands.ref];
        if (refInst && refInst.op === IR.BOX_INT) {
          // Replace all refs to this UNBOX_INT with the raw value inside BOX_INT
          this._replaceRef(ir, i, refInst.operands.ref);
          ir[i] = null;
          eliminated++;
          continue;
        }
      }

      // BOX_INT(UNBOX_INT(x)) → x (if x is a boxed integer, this round-trips)
      if (inst.op === IR.BOX_INT) {
        const refInst = ir[inst.operands.ref];
        if (refInst && refInst.op === IR.UNBOX_INT) {
          // The original boxed value
          this._replaceRef(ir, i, refInst.operands.ref);
          ir[i] = null;
          eliminated++;
          continue;
        }
      }

      // UNBOX_STRING(BOX_STRING(x)) → x
      if (inst.op === IR.UNBOX_STRING) {
        const refInst = ir[inst.operands.ref];
        if (refInst && refInst.op === IR.BOX_STRING) {
          this._replaceRef(ir, i, refInst.operands.ref);
          ir[i] = null;
          eliminated++;
          continue;
        }
      }

      // BOX_STRING(UNBOX_STRING(x)) → x
      if (inst.op === IR.BOX_STRING) {
        const refInst = ir[inst.operands.ref];
        if (refInst && refInst.op === IR.UNBOX_STRING) {
          this._replaceRef(ir, i, refInst.operands.ref);
          ir[i] = null;
          eliminated++;
          continue;
        }
      }
    }

    if (eliminated > 0) this._compact();
    return eliminated;
  }

  // --- Pass 2.25: Algebraic Simplification (Strength Reduction) ---
  // Simplify arithmetic with identity/absorbing elements:
  //   x + 0 → x,  0 + x → x,  x - 0 → x
  //   x * 1 → x,  1 * x → x,  x * 0 → 0,  0 * x → 0
  //   x / 1 → x
  // Also: x - x → 0, x * 2 → x + x (cheaper on some architectures)
  algebraicSimplification() {
    const ir = this.trace.ir;
    // Build a map of known constant values (from CONST_INT instructions)
    const constVals = new Map();
    for (let i = 0; i < ir.length; i++) {
      if (ir[i] && ir[i].op === IR.CONST_INT) {
        constVals.set(i, ir[i].operands.value);
      }
    }

    let simplified = 0;
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;

      const { left, right } = inst.operands;
      const lv = constVals.get(left);
      const rv = constVals.get(right);

      switch (inst.op) {
        case IR.ADD_INT:
          if (rv === 0) { this._replaceRef(ir, i, left); ir[i] = null; simplified++; }
          else if (lv === 0) { this._replaceRef(ir, i, right); ir[i] = null; simplified++; }
          break;

        case IR.SUB_INT:
          if (rv === 0) { this._replaceRef(ir, i, left); ir[i] = null; simplified++; }
          else if (left === right) {
            // x - x → 0
            inst.op = IR.CONST_INT;
            inst.operands = { value: 0 };
            constVals.set(i, 0);
            simplified++;
          }
          break;

        case IR.MUL_INT:
          if (rv === 1) { this._replaceRef(ir, i, left); ir[i] = null; simplified++; }
          else if (lv === 1) { this._replaceRef(ir, i, right); ir[i] = null; simplified++; }
          else if (rv === 0 || lv === 0) {
            inst.op = IR.CONST_INT;
            inst.operands = { value: 0 };
            constVals.set(i, 0);
            simplified++;
          }
          else if (rv === 2) {
            // x * 2 → x + x
            inst.op = IR.ADD_INT;
            inst.operands = { left, right: left };
            simplified++;
          }
          else if (lv === 2) {
            inst.op = IR.ADD_INT;
            inst.operands = { left: right, right: right };
            simplified++;
          }
          break;

        case IR.DIV_INT:
          if (rv === 1) { this._replaceRef(ir, i, left); ir[i] = null; simplified++; }
          else if (left === right) {
            // x / x → 1 (assuming x != 0, safe for traced code)
            inst.op = IR.CONST_INT;
            inst.operands = { value: 1 };
            constVals.set(i, 1);
            simplified++;
          }
          break;

        case IR.MOD_INT:
          // x % 1 → 0
          if (rv === 1) {
            inst.op = IR.CONST_INT;
            inst.operands = { value: 0 };
            constVals.set(i, 0);
            simplified++;
          }
          break;

        case IR.NEG: {
          const { ref } = inst.operands;
          const refInst = ir[ref];
          if (refInst && refInst.op === IR.NEG) {
            // NEG(NEG(x)) → x
            this._replaceRef(ir, i, refInst.operands.ref);
            ir[i] = null;
            simplified++;
          } else if (constVals.has(ref)) {
            // NEG(const) → const
            inst.op = IR.CONST_INT;
            inst.operands = { value: -constVals.get(ref) };
            constVals.set(i, inst.operands.value);
            simplified++;
          }
          break;
        }
      }
    }

    if (simplified > 0) this._compact();
    return simplified;
  }

  // --- Pass 2.5: Dead Store Elimination ---
  // If slot X is stored twice with no intervening load of slot X, the first store is dead.
  // Also: if a store is to a slot that is never loaded in the trace, it may be dead
  // (but we keep it for safety — the interpreter may need it on trace exit via snapshots).
  deadStoreElimination() {
    const ir = this.trace.ir;
    // Track last store index per slot
    const lastStore = new Map(); // key → index in ir
    const deadStores = new Set();

    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;

      if (inst.op === IR.STORE_LOCAL) {
        const key = `local:${inst.operands.slot}`;
        if (lastStore.has(key)) {
          // Previous store to same slot is dead (overwritten before read)
          deadStores.add(lastStore.get(key));
        }
        lastStore.set(key, i);
        continue;
      }
      if (inst.op === IR.STORE_GLOBAL) {
        const key = `global:${inst.operands.index}`;
        if (lastStore.has(key)) {
          deadStores.add(lastStore.get(key));
        }
        lastStore.set(key, i);
        continue;
      }

      // A load invalidates the "last store" — that store is needed
      if (inst.op === IR.LOAD_LOCAL) {
        lastStore.delete(`local:${inst.operands.slot}`);
        continue;
      }
      if (inst.op === IR.LOAD_GLOBAL) {
        lastStore.delete(`global:${inst.operands.index}`);
        continue;
      }

      // CALL invalidates all — callee may read any global/local
      if (inst.op === IR.CALL || inst.op === IR.SELF_CALL) {
        lastStore.clear();
      }

      // LOOP_END: don't eliminate stores that are live across the back-edge
      // (they feed the next iteration's loads). Clear tracking.
      if (inst.op === IR.LOOP_END) {
        lastStore.clear();
      }
    }

    let eliminated = 0;
    for (const idx of deadStores) {
      ir[idx] = null;
      eliminated++;
    }

    if (eliminated > 0) this._compact();
    return eliminated;
  }

  // --- Pass 3.5: Loop-Invariant Code Motion ---
  // Move instructions that don't depend on loop-variant values above LOOP_START.
  // An instruction is loop-invariant if all its operand refs are defined before the loop
  // or are themselves loop-invariant, AND it has no side effects.
  loopInvariantCodeMotion() {
    const ir = this.trace.ir;

    // Find LOOP_START position
    let loopStart = -1;
    for (let i = 0; i < ir.length; i++) {
      if (ir[i] && ir[i].op === IR.LOOP_START) { loopStart = i; break; }
    }
    if (loopStart < 0) return 0; // no loop, nothing to hoist

    // Instructions before loop start are "pre-loop" — their refs are loop-invariant
    const preLoopRefs = new Set();
    for (let i = 0; i < loopStart; i++) {
      if (ir[i]) preLoopRefs.add(i);
    }

    // Side-effecting ops cannot be hoisted
    const SIDE_EFFECTS = new Set([
      IR.STORE_LOCAL, IR.STORE_GLOBAL, IR.CALL, IR.SELF_CALL,
      IR.LOOP_START, IR.LOOP_END, IR.EXEC_TRACE, IR.FUNC_RETURN,
      IR.INDEX_ARRAY,  // Can fail if bounds guard hasn't run; don't hoist
      IR.BUILTIN_PUSH  // Creates new array; side-effecting
    ]);

    // Guards CAN be hoisted if their operands are loop-invariant.
    // Pre-loop guards use simplified exit codegen (no side-trace dispatch).
    const HOISTABLE_GUARDS = new Set([
      IR.GUARD_INT, IR.GUARD_BOOL, IR.GUARD_STRING,
      IR.GUARD_ARRAY, IR.GUARD_HASH,
      IR.GUARD_TRUTHY, IR.GUARD_FALSY,
      IR.GUARD_BOUNDS, IR.GUARD_CLOSURE
    ]);

    // Iteratively find loop-invariant instructions
    const invariant = new Set();
    const REF_KEYS = ['ref', 'left', 'right'];
    const VALUE_IS_REF = new Set([IR.STORE_LOCAL, IR.STORE_GLOBAL]);

    // Collect which locals/globals are written inside the loop
    const writtenLocals = new Set();
    const writtenGlobals = new Set();
    for (let i = loopStart + 1; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;
      if (inst.op === IR.STORE_LOCAL) writtenLocals.add(inst.operands.slot);
      if (inst.op === IR.STORE_GLOBAL) writtenGlobals.add(inst.operands.index);
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (let i = loopStart + 1; i < ir.length; i++) {
        const inst = ir[i];
        if (!inst || invariant.has(i) || SIDE_EFFECTS.has(inst.op)) continue;

        // Loads from written locations are NOT loop-invariant
        if (inst.op === IR.LOAD_LOCAL && writtenLocals.has(inst.operands.slot)) continue;
        if (inst.op === IR.LOAD_GLOBAL && writtenGlobals.has(inst.operands.index)) continue;

        // Check all operand refs are pre-loop or invariant
        const ops = inst.operands;
        let allInvariant = true;
        for (const key of REF_KEYS) {
          if (typeof ops[key] === 'number') {
            if (!preLoopRefs.has(ops[key]) && !invariant.has(ops[key])) {
              allInvariant = false;
              break;
            }
          }
        }
        if (allInvariant && typeof ops.value === 'number' && VALUE_IS_REF.has(inst.op)) {
          if (!preLoopRefs.has(ops.value) && !invariant.has(ops.value)) {
            allInvariant = false;
          }
        }

        if (allInvariant) {
          invariant.add(i);
          changed = true;
        }
      }
    }

    if (invariant.size === 0) return 0;

    // Move invariant instructions before LOOP_START
    // Build new IR: [pre-loop] [hoisted invariant] [LOOP_START] [remaining loop body]
    const preLoop = [];
    const hoisted = [];
    const loopBody = [];

    for (let i = 0; i < ir.length; i++) {
      if (!ir[i]) continue;
      if (i < loopStart) {
        preLoop.push(ir[i]);
      } else if (i === loopStart) {
        // Insert hoisted instructions before LOOP_START
        // Collect them in order
        // (they'll be inserted after preLoop, before LOOP_START)
        loopBody.push(ir[i]); // LOOP_START itself
      } else if (invariant.has(i)) {
        hoisted.push(ir[i]);
      } else {
        loopBody.push(ir[i]);
      }
    }

    // Rebuild: preLoop + hoisted + loopBody (which starts with LOOP_START)
    const newIr = [...preLoop, ...hoisted, ...loopBody];

    // Remap all refs
    const remap = new Map();
    // Build old→new index mapping
    let newIdx = 0;
    for (let i = 0; i < ir.length; i++) {
      if (!ir[i]) continue;
      // Find where this instruction ended up in newIr
    }
    // Simpler: build remap from old positions
    // preLoop: indices 0..loopStart-1 (non-null) → 0..preLoop.length-1
    // hoisted: their old indices → preLoop.length .. preLoop.length+hoisted.length-1
    // loopBody: remaining → after hoisted
    const oldToNew = new Map();
    let pos = 0;
    for (let i = 0; i < ir.length; i++) {
      if (!ir[i]) continue;
      if (i < loopStart) {
        oldToNew.set(i, pos++);
      }
    }
    // hoisted (in original order)
    const hoistedOldIndices = [...invariant].sort((a, b) => a - b);
    for (const oldIdx of hoistedOldIndices) {
      oldToNew.set(oldIdx, pos++);
    }
    // LOOP_START
    oldToNew.set(loopStart, pos++);
    // remaining loop body (non-invariant, non-null, after loopStart)
    for (let i = loopStart + 1; i < ir.length; i++) {
      if (!ir[i] || invariant.has(i)) continue;
      oldToNew.set(i, pos++);
    }

    // Apply remap to all operand refs
    for (const inst of newIr) {
      inst.id = oldToNew.get(inst.id) !== undefined ? oldToNew.get(inst.id) : inst.id;
      const ops = inst.operands;
      for (const key of REF_KEYS) {
        if (typeof ops[key] === 'number' && oldToNew.has(ops[key])) {
          ops[key] = oldToNew.get(ops[key]);
        }
      }
      // 'array' key is an IR ref for builtin ops
      if (typeof ops.array === 'number' && oldToNew.has(ops.array)) {
        ops.array = oldToNew.get(ops.array);
      }
      if (typeof ops.value === 'number' && (VALUE_IS_REF.has(inst.op) || inst.op === IR.BUILTIN_PUSH) && oldToNew.has(ops.value)) {
        ops.value = oldToNew.get(ops.value);
      }
      if (Array.isArray(ops.args)) {
        ops.args = ops.args.map(ref => oldToNew.has(ref) ? oldToNew.get(ref) : ref);
      }
      // Remap snapshot refs for deoptimization
      if (inst.snapshot) {
        for (const [slot, ref] of inst.snapshot.locals) {
          if (oldToNew.has(ref)) inst.snapshot.locals.set(slot, oldToNew.get(ref));
        }
        for (const [idx, ref] of inst.snapshot.globals) {
          if (oldToNew.has(ref)) inst.snapshot.globals.set(idx, oldToNew.get(ref));
        }
        if (inst.snapshot.irStack) {
          for (let j = 0; j < inst.snapshot.irStack.length; j++) {
            if (oldToNew.has(inst.snapshot.irStack[j])) {
              inst.snapshot.irStack[j] = oldToNew.get(inst.snapshot.irStack[j]);
            }
          }
        }
      }
    }

    // Update ids
    for (let i = 0; i < newIr.length; i++) {
      newIr[i].id = i;
    }

    this.trace.ir = newIr;
    return invariant.size;
  }

  // --- Pass 1: Redundant Guard Elimination ---
  // If a value has already been guarded as a type, subsequent guards for the
  // same ref and type are redundant. Also, constants don't need guards at all.
  // This is the biggest win — recording often emits duplicate guards for values
  // that are loaded and used multiple times in a loop iteration.
  // --- Pass 1: Common Subexpression Elimination ---
  // If two instructions have the same opcode and operands, the second is redundant.
  // Works for pure ops (loads, arithmetic, unbox, constants) — not stores, guards, or control flow.
  // For loads: only valid if no intervening store to the same slot.
  //
  // IMPORTANT: We must NOT mutate operands during the scan (via _replaceRef) because
  // that changes keys of not-yet-processed instructions, causing false CSE matches.
  // Instead, we collect a remap table and apply it in a single pass afterward.
  commonSubexpressionElimination() {
    const ir = this.trace.ir;
    // Pure ops that can be CSE'd (no side effects, deterministic)
    const PURE_OPS = new Set([
      IR.CONST_INT, IR.CONST_BOOL, IR.CONST_NULL, IR.CONST_OBJ,
      IR.LOAD_LOCAL, IR.LOAD_GLOBAL, IR.LOAD_FREE, IR.LOAD_CONST,
      IR.ADD_INT, IR.SUB_INT, IR.MUL_INT, IR.DIV_INT, IR.MOD_INT,
      IR.CONCAT, IR.EQ, IR.NEQ, IR.GT, IR.LT,
      IR.NEG, IR.NOT, IR.UNBOX_INT, IR.BOX_INT,
      IR.UNBOX_STRING, IR.BOX_STRING,
    ]);

    // Build canonical key for an instruction (using ORIGINAL operands, not remapped)
    const key = (inst) => {
      const ops = inst.operands;
      if (inst.op === IR.CONST_INT) return `${inst.op}:${ops.value}`;
      if (inst.op === IR.CONST_BOOL && ops.value !== undefined) return `${inst.op}:${ops.value}`;
      if (inst.op === IR.CONST_NULL) return inst.op;
      if (inst.op === IR.LOAD_LOCAL) return `${inst.op}:${ops.slot}`;
      if (inst.op === IR.LOAD_GLOBAL) return `${inst.op}:${ops.index}`;
      if (inst.op === IR.LOAD_FREE) return `${inst.op}:${ops.index}`;
      if (inst.op === IR.LOAD_CONST) return `${inst.op}:${ops.index}`;
      if (ops.left !== undefined && ops.right !== undefined) return `${inst.op}:${ops.left}:${ops.right}`;
      if (ops.ref !== undefined) return `${inst.op}:${ops.ref}`;
      return null; // can't CSE
    };

    const seen = new Map(); // key → first IR index
    const toEliminate = new Map(); // index → replacement index
    let eliminated = 0;

    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;

      // Stores invalidate load CSE for that slot
      if (inst.op === IR.STORE_LOCAL) {
        seen.delete(`${IR.LOAD_LOCAL}:${inst.operands.slot}`);
        continue;
      }
      if (inst.op === IR.STORE_GLOBAL) {
        seen.delete(`${IR.LOAD_GLOBAL}:${inst.operands.index}`);
        continue;
      }

      // CALL invalidates all load CSE entries
      if (inst.op === IR.CALL || inst.op === IR.SELF_CALL) {
        for (const k of [...seen.keys()]) {
          if (k.startsWith(IR.LOAD_LOCAL) || k.startsWith(IR.LOAD_GLOBAL) ||
              k.startsWith(IR.LOAD_FREE)) {
            seen.delete(k);
          }
        }
        continue;
      }

      // LOOP_START / LOOP_END: clear load CSE (values may change across iterations)
      if (inst.op === IR.LOOP_START || inst.op === IR.LOOP_END) {
        for (const k of [...seen.keys()]) {
          if (k.startsWith(IR.LOAD_LOCAL) || k.startsWith(IR.LOAD_GLOBAL) ||
              k.startsWith(IR.LOAD_FREE)) {
            seen.delete(k);
          }
        }
        continue;
      }

      if (!PURE_OPS.has(inst.op)) continue;

      const k = key(inst);
      if (k === null) continue;

      if (seen.has(k)) {
        toEliminate.set(i, seen.get(k));
        eliminated++;
        // Don't add to seen — use the first occurrence
      } else {
        seen.set(k, i);
      }
    }

    // Apply all replacements
    if (eliminated > 0) {
      for (const [oldRef, newRef] of toEliminate) {
        this._replaceRef(ir, oldRef, newRef);
        ir[oldRef] = null;
      }
      this._compact();
    }
    return eliminated;
  }

  redundantGuardElimination() {
    const ir = this.trace.ir;
    const guardedTypes = new Map(); // ref → Set of guarded types

    // First, mark all constant refs — they never need guards
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;
      if (inst.op === IR.CONST_INT) guardedTypes.set(i, new Set(['int']));
      else if (inst.op === IR.CONST_BOOL) guardedTypes.set(i, new Set(['bool']));
      else if (inst.op === IR.CONST_NULL) guardedTypes.set(i, new Set(['null']));
    }

    // Also mark unboxed/boxed refs
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;
      if (inst.op === IR.UNBOX_INT || inst.op === IR.BOX_INT) {
        guardedTypes.set(i, new Set(['int']));
      }
      if (inst.op === IR.ADD_INT || inst.op === IR.SUB_INT ||
          inst.op === IR.MUL_INT || inst.op === IR.DIV_INT ||
          inst.op === IR.MOD_INT || inst.op === IR.NEG ||
          inst.op === IR.BUILTIN_LEN) {
        guardedTypes.set(i, new Set(['int']));
      }
      if (inst.op === IR.GT || inst.op === IR.LT ||
          inst.op === IR.EQ || inst.op === IR.NEQ) {
        guardedTypes.set(i, new Set(['bool']));
      }
      if (inst.op === IR.CONCAT || inst.op === IR.UNBOX_STRING || inst.op === IR.BOX_STRING) {
        guardedTypes.set(i, new Set(['string']));
      }
    }

    let eliminated = 0;
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;

      let guardType = null;
      if (inst.op === IR.GUARD_INT) guardType = 'int';
      else if (inst.op === IR.GUARD_BOOL) guardType = 'bool';
      else if (inst.op === IR.GUARD_STRING) guardType = 'string';
      else continue;

      const ref = inst.operands.ref;
      const known = guardedTypes.get(ref);
      if (known && known.has(guardType)) {
        // Already guarded or known type — eliminate
        ir[i] = null;
        eliminated++;
        this.trace.guardCount--;
      } else {
        // Record that this ref is now guarded
        if (!guardedTypes.has(ref)) guardedTypes.set(ref, new Set());
        guardedTypes.get(ref).add(guardType);
      }
    }

    // Compact: remove nulls and rebuild id mapping
    if (eliminated > 0) this._compact();
    return eliminated;
  }

  // --- Pass 1.2b: Unbox Deduplication ---
  // Eliminate duplicate UNBOX_INT/UNBOX_STRING of the same source ref.
  // CSE sometimes misses these due to compaction/reindexing.
  unboxDeduplication() {
    const ir = this.trace.ir;
    const UNBOX_OPS = new Set([IR.UNBOX_INT, IR.UNBOX_STRING]);
    // Map: "op:sourceRef" → first IR index
    const seen = new Map();
    let eliminated = 0;

    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst || !UNBOX_OPS.has(inst.op)) continue;

      const key = `${inst.op}:${inst.operands.ref}`;
      if (seen.has(key)) {
        // Replace all uses of this duplicate with the first occurrence
        this._replaceRef(ir, i, seen.get(key));
        ir[i] = null;
        eliminated++;
      } else {
        seen.set(key, i);
      }
    }

    if (eliminated > 0) this._compact();
    return eliminated;
  }

  // --- Pass 1.2c: Detect Induction Variables ---
  // Finds loop counter variables that start non-negative and increment by positive constants.
  // Returns a Set of UNBOX_INT IR indices that are provably non-negative.
  detectInductionVariables() {
    const ir = this.trace.ir;
    const nonNegativeUnboxRefs = new Set();
    
    // Find LOOP_START and LOOP_END boundaries
    let loopStart = -1, loopEnd = -1;
    for (let i = 0; i < ir.length; i++) {
      if (!ir[i]) continue;
      if (ir[i].op === IR.LOOP_START) loopStart = i;
      if (ir[i].op === IR.LOOP_END) loopEnd = i;
    }
    if (loopStart === -1 || loopEnd === -1) return nonNegativeUnboxRefs;
    
    // Find STORE_GLOBAL instructions in the loop body that store back to a global
    // Pattern: ADD_INT(unbox_ref, const_int) → BOX_INT → STORE_GLOBAL
    for (let i = loopStart; i < loopEnd; i++) {
      const inst = ir[i];
      if (!inst || inst.op !== IR.STORE_GLOBAL) continue;
      
      const globalIdx = inst.operands.index;
      const storedRef = inst.operands.value;
      const storedInst = ir[storedRef];
      if (!storedInst || storedInst.op !== IR.BOX_INT) continue;
      
      const addRef = storedInst.operands.ref;
      const addInst = ir[addRef];
      if (!addInst || addInst.op !== IR.ADD_INT) continue;
      
      // One operand should be an UNBOX_INT of a LOAD_GLOBAL with the same index,
      // the other should be a positive CONST_INT
      let unboxRef = null;
      let stepRef = null;
      
      const leftInst = ir[addInst.operands.left];
      const rightInst = ir[addInst.operands.right];
      
      if (leftInst?.op === IR.UNBOX_INT && rightInst?.op === IR.CONST_INT) {
        unboxRef = addInst.operands.left;
        stepRef = addInst.operands.right;
      } else if (rightInst?.op === IR.UNBOX_INT && leftInst?.op === IR.CONST_INT) {
        unboxRef = addInst.operands.right;
        stepRef = addInst.operands.left;
      }
      
      if (unboxRef === null) continue;
      
      const unboxInst = ir[unboxRef];
      const loadRef = unboxInst.operands.ref;
      const loadInst = ir[loadRef];
      if (!loadInst || loadInst.op !== IR.LOAD_GLOBAL || loadInst.operands.index !== globalIdx) continue;
      
      const stepInst = ir[stepRef];
      const step = stepInst.operands.value;
      if (step <= 0) continue; // Only positive steps
      
      // This is an induction variable! The UNBOX_INT ref is a loop counter
      // that increments by `step` each iteration.
      // 
      // To prove non-negativity: the loop condition (GT/GUARD_TRUTHY) ensures
      // the counter is bounded above by len(arr). Since the counter increments
      // by a positive value, it was previously checked as < len(arr). At the
      // beginning of each iteration, counter = old_counter + step.
      // If old_counter >= 0 (induction hypothesis) and step > 0, then counter >= step >= 1 > 0.
      // The base case: the very first iteration when the trace fires, the counter
      // equals its value from the interpreter. In typical patterns (for j = 0; j < len; j++),
      // this is non-negative.
      //
      // Conservative approach: mark the UNBOX_INT as non-negative. The generated
      // code's pre-loop type guards already ensure the initial value is a valid integer.
      // If the initial value were negative, the loop condition (j < len where len >= 0)
      // would pass, and the bounds check would catch it on the first iteration.
      // Since the trace was successfully recorded, we know the bounds check DID pass,
      // confirming the initial value was non-negative.
      nonNegativeUnboxRefs.add(unboxRef);
    }
    
    return nonNegativeUnboxRefs;
  }

  // --- Pass 1.3: Range Check Elimination ---
  // Eliminate redundant GUARD_BOUNDS when the loop condition already implies bounds safety.
  // Pattern: GT(BUILTIN_LEN(arr), idx) → GUARD_TRUTHY → ... → GUARD_BOUNDS(arr, idx)
  // If the loop condition already checks idx < len(arr), the upper bound check in GUARD_BOUNDS
  // is redundant. For the lower bound (idx >= 0), we verify the index traces back to a
  // non-negative source (CONST_INT >= 0, or arithmetic from non-negative operands).
  rangeCheckElimination() {
    const ir = this.trace.ir;
    
    // Detect induction variables (loop counters with positive step)
    const inductionVars = this.detectInductionVariables();
    
    // Step 1: Find BUILTIN_LEN results and what array they reference
    const lenToArr = new Map(); // IR idx of BUILTIN_LEN → array IR ref
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (inst && inst.op === IR.BUILTIN_LEN) {
        lenToArr.set(i, inst.operands.ref);
      }
    }
    if (lenToArr.size === 0) return 0;
    
    // Helper: normalize a ref through UNBOX_INT to find the underlying source
    const normalizeRef = (ref) => {
      const inst = ir[ref];
      if (inst && inst.op === IR.UNBOX_INT) return inst.operands.ref;
      return ref;
    };
    
    // Step 2: Find GT/LT comparisons that compare a LEN result with an index
    // GT(len_ref, idx_ref) means len > idx, i.e., idx < len
    // LT(idx_ref, len_ref) means idx < len
    // Normalize through UNBOX_INT so different unboxings of the same source match.
    const boundedSources = new Map(); // "arr_ref:source_ref" → true
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;
      
      let arrRef = null, idxRef = null;
      if (inst.op === IR.GT) {
        const leftArr = lenToArr.get(inst.operands.left);
        if (leftArr !== undefined) {
          arrRef = leftArr;
          idxRef = normalizeRef(inst.operands.right);
        }
      } else if (inst.op === IR.LT) {
        const rightArr = lenToArr.get(inst.operands.right);
        if (rightArr !== undefined) {
          arrRef = rightArr;
          idxRef = normalizeRef(inst.operands.left);
        }
      }
      
      if (arrRef !== null && idxRef !== null) {
        // Verify this comparison is actually guarded (followed by GUARD_TRUTHY)
        for (let j = i + 1; j < ir.length && j < i + 5; j++) {
          const next = ir[j];
          if (!next) continue;
          if (next.op === IR.CONST_BOOL && next.operands.ref === i) {
            for (let k = j + 1; k < ir.length && k < j + 3; k++) {
              const guard = ir[k];
              if (guard && guard.op === IR.GUARD_TRUTHY && guard.operands.ref === j) {
                boundedSources.set(`${arrRef}:${idxRef}`, true);
                break;
              }
            }
            break;
          }
          if (next.op === IR.GUARD_TRUTHY && next.operands.ref === i) {
            boundedSources.set(`${arrRef}:${idxRef}`, true);
            break;
          }
        }
      }
    }
    if (boundedSources.size === 0) return 0;
    
    // Step 3: Check if an IR ref is provably non-negative
    const isNonNegative = (ref, depth = 0) => {
      if (depth > 10) return false;
      const inst = ir[ref];
      if (!inst) return false;
      
      // Induction variables detected by IVA are non-negative
      if (inductionVars.has(ref)) return true;
      
      // Constants >= 0
      if (inst.op === IR.CONST_INT) return inst.operands.value >= 0;
      
      // UNBOX_INT of a promoted variable — the trace was recorded with this value,
      // and in Monkey, array indices in while(i < len(arr)) patterns start at 0.
      // We can't prove this statically in general, but we CAN check: if the unboxed
      // value feeds into ADD_INT with a non-negative constant, and the initial value
      // was non-negative, the result is non-negative.
      if (inst.op === IR.UNBOX_INT) return false; // Conservative: can't prove
      
      // ADD_INT(a, b) where both are non-negative
      if (inst.op === IR.ADD_INT) {
        return isNonNegative(inst.operands.left, depth + 1) && 
               isNonNegative(inst.operands.right, depth + 1);
      }
      
      // MUL_INT of two non-negatives
      if (inst.op === IR.MUL_INT) {
        return isNonNegative(inst.operands.left, depth + 1) && 
               isNonNegative(inst.operands.right, depth + 1);
      }
      
      // BUILTIN_LEN always returns >= 0
      if (inst.op === IR.BUILTIN_LEN) return true;
      
      return false;
    };
    
    // Step 4: Eliminate GUARD_BOUNDS where the upper bound is already checked
    // and the index is provably non-negative
    let eliminated = 0;
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst || inst.op !== IR.GUARD_BOUNDS) continue;
      
      const arrRef = inst.operands.left;
      const idxRef = inst.operands.right;
      // Normalize the index ref through UNBOX_INT to match what we stored
      const normalizedIdx = normalizeRef(idxRef);
      const key = `${arrRef}:${normalizedIdx}`;
      
      if (boundedSources.has(key)) {
        // Upper bound is checked by loop condition.
        // For lower bound: check if index is provably non-negative.
        if (isNonNegative(idxRef)) {
          // Both bounds proven — eliminate entirely
          ir[i] = null;
          eliminated++;
          this.trace.guardCount--;
        } else {
          // Upper bound proven but can't prove non-negative statically.
          // Replace GUARD_BOUNDS with a simpler lower-bound-only check.
          // We mark it so codegen emits just `if (idx < 0)` instead of the full check.
          inst._upperBoundProven = true;
          eliminated++; // Still counts as an optimization (simpler check)
        }
      }
    }
    
    if (eliminated > 0) this._compact();
    return eliminated;
  }

  // --- Pass 1.5: Constant Propagation ---
  // Track known constant values through the IR and replace references with constants.
  // If a STORE writes a BOX_INT(CONST_INT(v)), the slot has known value v.
  // If a subsequent LOAD reads that slot (not already eliminated by S2LF),
  // and an UNBOX_INT follows, we can replace the unbox with CONST_INT(v).
  // Also tracks values through arithmetic: ADD_INT(const, const) → known constant.
  // This enables more constant folding in the next pass.
  constantPropagation() {
    const ir = this.trace.ir;
    // Map: IR ref → known numeric value (raw int)
    const knownValues = new Map();
    // Map: slot key → known numeric value
    const slotValues = new Map();

    let propagated = 0;

    // First pass: discover all known constant values
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;

      if (inst.op === IR.CONST_INT) {
        knownValues.set(i, inst.operands.value);
        continue;
      }

      // Track values through arithmetic on known constants
      if (inst.op === IR.ADD_INT || inst.op === IR.SUB_INT ||
          inst.op === IR.MUL_INT || inst.op === IR.DIV_INT) {
        const lv = knownValues.get(inst.operands.left);
        const rv = knownValues.get(inst.operands.right);
        if (lv !== undefined && rv !== undefined) {
          let result;
          switch (inst.op) {
            case IR.ADD_INT: result = lv + rv; break;
            case IR.SUB_INT: result = lv - rv; break;
            case IR.MUL_INT: result = lv * rv; break;
            case IR.DIV_INT: result = Math.trunc(lv / rv); break;
            case IR.MOD_INT: result = rv !== 0 ? (lv % rv) : null; break;
          }
          knownValues.set(i, result);
        }
        continue;
      }

      // BOX_INT of a known value → known boxed constant
      if (inst.op === IR.BOX_INT) {
        const rv = knownValues.get(inst.operands.ref);
        if (rv !== undefined) knownValues.set(i, rv);
        continue;
      }

      // UNBOX_INT of a known boxed value → replace with CONST_INT
      if (inst.op === IR.UNBOX_INT) {
        const rv = knownValues.get(inst.operands.ref);
        if (rv !== undefined) {
          inst.op = IR.CONST_INT;
          inst.operands = { value: rv };
          knownValues.set(i, rv);
          propagated++;
          continue;
        }
      }

      // Track stores: if value has known constant, slot gets that value
      if (inst.op === IR.STORE_LOCAL) {
        const sv = knownValues.get(inst.operands.value);
        if (sv !== undefined) {
          slotValues.set(`local:${inst.operands.slot}`, sv);
        } else {
          slotValues.delete(`local:${inst.operands.slot}`);
        }
        continue;
      }
      if (inst.op === IR.STORE_GLOBAL) {
        const sv = knownValues.get(inst.operands.value);
        if (sv !== undefined) {
          slotValues.set(`global:${inst.operands.index}`, sv);
        } else {
          slotValues.delete(`global:${inst.operands.index}`);
        }
        continue;
      }

      // Loads from slots with known values
      if (inst.op === IR.LOAD_LOCAL) {
        const sv = slotValues.get(`local:${inst.operands.slot}`);
        if (sv !== undefined) knownValues.set(i, sv);
        continue;
      }
      if (inst.op === IR.LOAD_GLOBAL) {
        const sv = slotValues.get(`global:${inst.operands.index}`);
        if (sv !== undefined) knownValues.set(i, sv);
        continue;
      }

      // NEG of known value
      if (inst.op === IR.NEG) {
        const rv = knownValues.get(inst.operands.ref);
        if (rv !== undefined) {
          inst.op = IR.CONST_INT;
          inst.operands = { value: -rv };
          knownValues.set(i, -rv);
          propagated++;
        }
        continue;
      }

      // CALL invalidates all slot knowledge
      if (inst.op === IR.CALL || inst.op === IR.SELF_CALL) {
        slotValues.clear();
      }

      // LOOP_END: slot values may change on back-edge
      if (inst.op === IR.LOOP_END) {
        slotValues.clear();
      }
    }

    return propagated;
  }

  // --- Pass 2: Constant Folding ---
  // Fold arithmetic on two CONST_INT values into a single CONST_INT.
  // Also fold UNBOX_INT(CONST_INT) → same constant value, and
  // BOX_INT of a known constant → CONST_INT.
  constantFolding() {
    const ir = this.trace.ir;
    const constValues = new Map(); // ref → numeric value (for raw int constants)

    let folded = 0;
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;

      // Track constant values
      if (inst.op === IR.CONST_INT) {
        constValues.set(i, inst.operands.value);
        continue;
      }

      // UNBOX_INT of a CONST_INT → the constant's value is already raw
      if (inst.op === IR.UNBOX_INT) {
        const refInst = ir[inst.operands.ref];
        if (refInst && refInst.op === IR.CONST_INT) {
          // Replace with const_int (same value, it's already raw)
          inst.op = IR.CONST_INT;
          inst.operands = { value: refInst.operands.value };
          constValues.set(i, refInst.operands.value);
          folded++;
          continue;
        }
        // If the ref has a known constant value from folding
        if (constValues.has(inst.operands.ref)) {
          inst.op = IR.CONST_INT;
          inst.operands = { value: constValues.get(inst.operands.ref) };
          constValues.set(i, inst.operands.value);
          folded++;
          continue;
        }
      }

      // Fold arithmetic on two constants
      if (inst.op === IR.ADD_INT || inst.op === IR.SUB_INT ||
          inst.op === IR.MUL_INT || inst.op === IR.DIV_INT) {
        const leftVal = constValues.get(inst.operands.left);
        const rightVal = constValues.get(inst.operands.right);
        if (leftVal !== undefined && rightVal !== undefined) {
          let result;
          switch (inst.op) {
            case IR.ADD_INT: result = leftVal + rightVal; break;
            case IR.SUB_INT: result = leftVal - rightVal; break;
            case IR.MUL_INT: result = leftVal * rightVal; break;
            case IR.DIV_INT: result = Math.trunc(leftVal / rightVal); break;
            case IR.MOD_INT: result = rightVal !== 0 ? (leftVal % rightVal) : null; break;
          }
          inst.op = IR.CONST_INT;
          inst.operands = { value: result };
          constValues.set(i, result);
          folded++;
        }
      }

      // Fold comparisons on two constants
      if (inst.op === IR.EQ || inst.op === IR.NEQ ||
          inst.op === IR.GT || inst.op === IR.LT) {
        const leftVal = constValues.get(inst.operands.left);
        const rightVal = constValues.get(inst.operands.right);
        if (leftVal !== undefined && rightVal !== undefined) {
          let result;
          switch (inst.op) {
            case IR.EQ: result = leftVal === rightVal; break;
            case IR.NEQ: result = leftVal !== rightVal; break;
            case IR.GT: result = leftVal > rightVal; break;
            case IR.LT: result = leftVal < rightVal; break;
          }
          inst.op = IR.CONST_BOOL;
          inst.operands = { value: result };
          folded++;
        }
      }
    }
    return folded;
  }

  // --- Pass 3: Dead Code Elimination ---
  // Remove instructions whose results are never referenced by any live instruction.
  // Walk backwards marking live refs, then null out dead ones.
  deadCodeElimination() {
    const ir = this.trace.ir;
    const live = new Set();

    // All side-effecting instructions are always live
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst) continue;
      if (inst.op === IR.STORE_LOCAL || inst.op === IR.STORE_GLOBAL ||
          inst.op === IR.GUARD_INT || inst.op === IR.GUARD_BOOL ||
          inst.op === IR.GUARD_STRING || inst.op === IR.GUARD_ARRAY ||
          inst.op === IR.GUARD_HASH ||
          inst.op === IR.GUARD_BOUNDS || inst.op === IR.GUARD_TRUTHY ||
          inst.op === IR.GUARD_FALSY || inst.op === IR.GUARD_CLOSURE ||
          inst.op === IR.LOOP_START || inst.op === IR.LOOP_END ||
          inst.op === IR.CALL || inst.op === IR.EXEC_TRACE ||
          inst.op === IR.SELF_CALL || inst.op === IR.FUNC_RETURN ||
          inst.op === IR.BUILTIN_PUSH) {
        live.add(i);
      }
    }

    // Instructions referenced by snapshots are live (needed for deoptimization)
    for (let i = 0; i < ir.length; i++) {
      const inst = ir[i];
      if (!inst || !inst.snapshot) continue;
      for (const ref of inst.snapshot.locals.values()) {
        if (typeof ref === 'number' && ref >= 0 && ref < ir.length && ir[ref]) live.add(ref);
      }
      for (const ref of inst.snapshot.globals.values()) {
        if (typeof ref === 'number' && ref >= 0 && ref < ir.length && ir[ref]) live.add(ref);
      }
    }

    // BOX_INT that feeds a STORE is live (transitively)
    // Walk live set and mark operands as live (only follow IR ref keys)
    const VALUE_IS_REF = new Set([IR.STORE_LOCAL, IR.STORE_GLOBAL]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const idx of live) {
        const inst = ir[idx];
        if (!inst) continue;
        const ops = inst.operands;
        for (const key of Object.keys(ops)) {
          const val = ops[key];
          if (typeof val !== 'number' || val < 0 || val >= ir.length || !ir[val] || live.has(val)) continue;
          // Only follow keys that are IR references
          if (key === 'ref' || key === 'left' || key === 'right' || key === 'array' ||
              (key === 'value' && (VALUE_IS_REF.has(inst.op) || inst.op === IR.BUILTIN_PUSH))) {
            live.add(val);
            changed = true;
          }
          // Handle SELF_CALL args array
          if (key === 'args' && Array.isArray(ops[key])) {
            for (const argRef of ops[key]) {
              if (typeof argRef === 'number' && argRef >= 0 && argRef < ir.length && ir[argRef] && !live.has(argRef)) {
                live.add(argRef);
                changed = true;
              }
            }
          }
        }
      }
    }

    let eliminated = 0;
    for (let i = 0; i < ir.length; i++) {
      if (ir[i] && !live.has(i)) {
        ir[i] = null;
        eliminated++;
      }
    }

    if (eliminated > 0) this._compact();
    return eliminated;
  }

  // Compact the IR array: remove nulls, remap all references
  _compact() {
    const ir = this.trace.ir;
    const remap = new Map();
    const newIr = [];

    for (let i = 0; i < ir.length; i++) {
      if (ir[i] !== null) {
        remap.set(i, newIr.length);
        ir[i].id = newIr.length;
        newIr.push(ir[i]);
      }
    }

    // Only remap operand keys that are IR references (not value/slot/index/exitIp/constIdx/numArgs)
    const REF_KEYS = new Set(['ref', 'left', 'right', 'value']);
    // 'value' is a ref ONLY for STORE_LOCAL/STORE_GLOBAL — not for CONST_INT etc.
    const VALUE_IS_REF = new Set([IR.STORE_LOCAL, IR.STORE_GLOBAL]);

    for (const inst of newIr) {
      const ops = inst.operands;
      for (const key of Object.keys(ops)) {
        if (typeof ops[key] !== 'number') {
          // Handle args array (for SELF_CALL)
          if (key === 'args' && Array.isArray(ops[key])) {
            ops[key] = ops[key].map(ref => remap.has(ref) ? remap.get(ref) : ref);
          }
          continue;
        }
        // 'ref', 'left', 'right', 'array' are always IR references
        if (key === 'ref' || key === 'left' || key === 'right' || key === 'array') {
          if (remap.has(ops[key])) ops[key] = remap.get(ops[key]);
        }
        // 'value' is an IR ref only for stores and builtin_push
        if (key === 'value' && (VALUE_IS_REF.has(inst.op) || inst.op === IR.BUILTIN_PUSH)) {
          if (remap.has(ops[key])) ops[key] = remap.get(ops[key]);
        }
        // For CONST_BOOL with a 'ref' — already handled above
      }
      // Remap snapshot refs
      if (inst.snapshot) {
        for (const [slot, ref] of inst.snapshot.locals) {
          if (remap.has(ref)) inst.snapshot.locals.set(slot, remap.get(ref));
        }
        for (const [idx, ref] of inst.snapshot.globals) {
          if (remap.has(ref)) inst.snapshot.globals.set(idx, remap.get(ref));
        }
        // Remap irStack refs for operand stack restoration
        if (inst.snapshot.irStack) {
          for (let i = 0; i < inst.snapshot.irStack.length; i++) {
            if (remap.has(inst.snapshot.irStack[i])) {
              inst.snapshot.irStack[i] = remap.get(inst.snapshot.irStack[i]);
            }
          }
        }
      }
    }

    this.trace.ir = newIr;
  }
}

// --- Function Compiler ---
// Direct bytecode → JS compilation for hot recursive functions.
// Emits a flat JS function that interprets the bytecode without dispatch overhead.
// Each bytecode instruction becomes inline JS. Self-calls use the compiled function.

export class FunctionCompiler {
  constructor(fn, constants, vm) {
    this.fn = fn;
    this.constants = constants;
    this.vm = vm;
    this._compiledSource = null;
  }

  compile() {
    const ins = this.fn.instructions;
    const numLocals = this.fn.numLocals;

    // Build a set of jump targets (for label generation)
    const jumpTargets = new Set();
    let ip = 0;
    while (ip < ins.length) {
      const op = ins[ip];
      const def = lookup(op);
      const widths = def ? def.operandWidths : [];
      let offset = ip + 1;
      for (const w of widths) {
        if (w === 2) {
          const target = (ins[offset] << 8) | ins[offset + 1];
          if (op === Opcodes.OpJump || op === Opcodes.OpJumpNotTruthy) {
            jumpTargets.add(target);
          }
          offset += 2;
        } else {
          offset += 1;
        }
      }
      ip = offset;
    }

    const lines = [];
    lines.push('"use strict";');
    // Local variables (args are pre-loaded, rest are null)
    lines.push(`const __s = new Array(32);`); // operand stack
    lines.push(`let __sp = 0;`);
    for (let i = 0; i < numLocals; i++) {
      lines.push(`let __l${i} = __args[${i}] !== undefined ? __args[${i}] : __NULL;`);
    }

    // Walk bytecode and emit inline JS for each instruction
    ip = 0;
    while (ip < ins.length) {
      // Emit label if this is a jump target
      if (jumpTargets.has(ip)) {
        // We use a flat switch-based approach instead
      }

      const op = ins[ip];

      switch (op) {
        case Opcodes.OpConstant: {
          const constIdx = (ins[ip + 1] << 8) | ins[ip + 2];
          ip += 3;
          const constVal = this.constants[constIdx];
          if (constVal instanceof MonkeyInteger) {
            lines.push(`__s[__sp++] = __cachedInteger(${constVal.value});`);
          } else if (constVal instanceof MonkeyBoolean) {
            lines.push(`__s[__sp++] = ${constVal.value ? '__TRUE' : '__FALSE'};`);
          } else {
            lines.push(`__s[__sp++] = __consts[${constIdx}];`);
          }
          break;
        }

        case Opcodes.OpGetLocal: {
          const slot = ins[ip + 1];
          ip += 2;
          lines.push(`__s[__sp++] = __l${slot};`);
          break;
        }

        case Opcodes.OpSetLocal: {
          const slot = ins[ip + 1];
          ip += 2;
          lines.push(`__l${slot} = __s[--__sp];`);
          break;
        }

        case Opcodes.OpGetGlobal: {
          const idx = (ins[ip + 1] << 8) | ins[ip + 2];
          ip += 3;
          lines.push(`__s[__sp++] = __globals[${idx}];`);
          break;
        }

        case Opcodes.OpSetGlobal: {
          const idx = (ins[ip + 1] << 8) | ins[ip + 2];
          ip += 3;
          lines.push(`__globals[${idx}] = __s[--__sp];`);
          break;
        }

        case Opcodes.OpGetFree: {
          const idx = ins[ip + 1];
          ip += 2;
          lines.push(`__s[__sp++] = __free[${idx}];`);
          break;
        }

        case Opcodes.OpAdd:
          ip += 1;
          lines.push(`{ const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = __cachedInteger(l.value + r.value); }`);
          break;

        case Opcodes.OpSub:
          ip += 1;
          lines.push(`{ const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = __cachedInteger(l.value - r.value); }`);
          break;

        case Opcodes.OpMul:
          ip += 1;
          lines.push(`{ const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = __cachedInteger(l.value * r.value); }`);
          break;

        case Opcodes.OpDiv:
          ip += 1;
          lines.push(`{ const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = __cachedInteger(Math.trunc(l.value / r.value)); }`);
          break;

        case Opcodes.OpEqual:
          ip += 1;
          lines.push(`{ const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = l.value === r.value ? __TRUE : __FALSE; }`);
          break;

        case Opcodes.OpNotEqual:
          ip += 1;
          lines.push(`{ const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = l.value !== r.value ? __TRUE : __FALSE; }`);
          break;

        case Opcodes.OpGreaterThan:
          ip += 1;
          lines.push(`{ const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = l.value > r.value ? __TRUE : __FALSE; }`);
          break;

        case Opcodes.OpMinus:
          ip += 1;
          lines.push(`{ const v = __s[--__sp]; __s[__sp++] = __cachedInteger(-v.value); }`);
          break;

        case Opcodes.OpBang:
          ip += 1;
          lines.push(`{ const v = __s[--__sp]; __s[__sp++] = __isTruthy(v) ? __FALSE : __TRUE; }`);
          break;

        case Opcodes.OpTrue:
          ip += 1;
          lines.push(`__s[__sp++] = __TRUE;`);
          break;

        case Opcodes.OpFalse:
          ip += 1;
          lines.push(`__s[__sp++] = __FALSE;`);
          break;

        case Opcodes.OpNull:
          ip += 1;
          lines.push(`__s[__sp++] = __NULL;`);
          break;

        case Opcodes.OpPop:
          ip += 1;
          lines.push(`--__sp;`);
          break;

        case Opcodes.OpReturnValue:
          ip += 1;
          lines.push(`return __s[--__sp];`);
          break;

        case Opcodes.OpReturn:
          ip += 1;
          lines.push(`return __NULL;`);
          break;

        case Opcodes.OpCurrentClosure:
          ip += 1;
          // Push a sentinel — we'll handle this in OpCall
          lines.push(`__s[__sp++] = __SELF_MARKER;`);
          break;

        case Opcodes.OpCall: {
          const numArgs = ins[ip + 1];
          ip += 2;
          // Check if the callee is our self-marker (recursive call)
          const argExprs = [];
          for (let i = numArgs - 1; i >= 0; i--) {
            argExprs.unshift(`a${i}`);
          }
          lines.push(`{`);
          lines.push(`  const __callArgs = new Array(${numArgs});`);
          for (let i = numArgs - 1; i >= 0; i--) {
            lines.push(`  __callArgs[${i}] = __s[--__sp];`);
          }
          lines.push(`  const __callee = __s[--__sp];`);
          lines.push(`  if (__callee === __SELF_MARKER) {`);
          lines.push(`    __s[__sp++] = __self(__callArgs);`);
          lines.push(`  } else {`);
          // Non-self call — bail to indicate we can't handle this
          lines.push(`    return null; /* bail: non-self call */`);
          lines.push(`  }`);
          lines.push(`}`);
          break;
        }

        case Opcodes.OpJump: {
          const target = (ins[ip + 1] << 8) | ins[ip + 2];
          ip += 3;
          // For structured if/else, jumps go forward. We'll handle this
          // by noting it and continuing. The emitted code uses labels.
          // For now, emit a goto-like construct using a loop+switch pattern
          // Actually, for the common pattern (if/else), this jump skips the else.
          // We'll emit it as a block closing.
          lines.push(`/* jump to ${target} */`);
          break;
        }

        case Opcodes.OpJumpNotTruthy: {
          const target = (ins[ip + 1] << 8) | ins[ip + 2];
          ip += 3;
          lines.push(`if (!__isTruthy(__s[--__sp])) {`);
          lines.push(`  /* jump to ${target} — will be closed by jump/target */`);
          break;
        }

        // Superinstructions
        case Opcodes.OpGetLocalSubConst: {
          const slot = ins[ip + 1];
          const constIdx = (ins[ip + 2] << 8) | ins[ip + 3];
          ip += 4;
          const constVal = this.constants[constIdx];
          if (constVal instanceof MonkeyInteger) {
            lines.push(`__s[__sp++] = __cachedInteger(__l${slot}.value - ${constVal.value});`);
          } else {
            lines.push(`__s[__sp++] = __cachedInteger(__l${slot}.value - __consts[${constIdx}].value);`);
          }
          break;
        }

        default: {
          // Unknown op — bail
          ip += 1;
          const def = lookup(op);
          if (def && def.operandWidths) {
            for (const w of def.operandWidths) ip += w;
          }
          return null;
        }
      }
    }

    // This approach has a problem: the jump/branch structure is not properly
    // handled. We need to restructure the bytecode into structured control flow.
    // For the common if/else pattern in recursive functions, let me use a
    // different approach: a goto-simulation with a while+switch loop.

    return null; // The flat approach doesn't handle control flow well
  }

  // Compile using a while+switch interpreter (eliminates dispatch overhead via V8 JIT)
  // Uses raw JS numbers internally for integer-heavy functions (like fib)
  compileSwitch() {
    const ins = this.fn.instructions;
    const numLocals = this.fn.numLocals;

    // Analyze: can we use raw integers? Check if all arithmetic is integer-based
    // and there are no string ops or complex features that need boxed values.
    const canUseRawInts = this._canUseRawInts();

    if (canUseRawInts) {
      return this._compileSwitchRaw();
    }

    const lines = [];
    lines.push('"use strict";');
    lines.push(`const __s = [];`);
    lines.push(`let __sp = 0;`);
    for (let i = 0; i < numLocals; i++) {
      lines.push(`let __l${i} = ${i} < __args.length ? __args[${i}] : __NULL;`);
    }

    // Find all instruction boundaries
    const boundaries = new Set([0]);
    let ip = 0;
    while (ip < ins.length) {
      const op = ins[ip];
      const def = lookup(op);
      const widths = def ? def.operandWidths : [];
      let nextIp = ip + 1;
      for (const w of widths) nextIp += w;

      if (op === Opcodes.OpJump) {
        const target = (ins[ip + 1] << 8) | ins[ip + 2];
        boundaries.add(target);
        boundaries.add(nextIp);
      } else if (op === Opcodes.OpJumpNotTruthy) {
        const target = (ins[ip + 1] << 8) | ins[ip + 2];
        boundaries.add(target);
        boundaries.add(nextIp);
      } else if (op === Opcodes.OpReturnValue || op === Opcodes.OpReturn) {
        boundaries.add(nextIp);
      }
      ip = nextIp;
    }

    // Sort boundaries
    const blocks = [...boundaries].sort((a, b) => a - b);

    // Emit a switch-based interpreter
    lines.push(`let __pc = 0;`);
    lines.push(`while (true) {`);
    lines.push(`  switch (__pc) {`);

    for (let bi = 0; bi < blocks.length; bi++) {
      const blockStart = blocks[bi];
      const blockEnd = bi + 1 < blocks.length ? blocks[bi + 1] : ins.length;
      if (blockStart >= ins.length) continue;

      lines.push(`    case ${blockStart}: {`);

      ip = blockStart;
      while (ip < blockEnd && ip < ins.length) {
        const op = ins[ip];

        switch (op) {
          case Opcodes.OpConstant: {
            const constIdx = (ins[ip + 1] << 8) | ins[ip + 2];
            ip += 3;
            const constVal = this.constants[constIdx];
            if (constVal instanceof MonkeyInteger) {
              lines.push(`      __s[__sp++] = __cachedInteger(${constVal.value});`);
            } else if (constVal instanceof MonkeyBoolean) {
              lines.push(`      __s[__sp++] = ${constVal.value ? '__TRUE' : '__FALSE'};`);
            } else {
              lines.push(`      __s[__sp++] = __consts[${constIdx}];`);
            }
            break;
          }

          case Opcodes.OpGetLocal: {
            const slot = ins[ip + 1];
            ip += 2;
            lines.push(`      __s[__sp++] = __l${slot};`);
            break;
          }

          case Opcodes.OpSetLocal: {
            const slot = ins[ip + 1];
            ip += 2;
            lines.push(`      __l${slot} = __s[--__sp];`);
            break;
          }

          case Opcodes.OpGetGlobal: {
            const idx = (ins[ip + 1] << 8) | ins[ip + 2];
            ip += 3;
            lines.push(`      __s[__sp++] = __globals[${idx}];`);
            break;
          }

          case Opcodes.OpSetGlobal: {
            const idx = (ins[ip + 1] << 8) | ins[ip + 2];
            ip += 3;
            lines.push(`      __globals[${idx}] = __s[--__sp];`);
            break;
          }

          case Opcodes.OpGetFree: {
            const idx = ins[ip + 1];
            ip += 2;
            lines.push(`      __s[__sp++] = __free[${idx}];`);
            break;
          }

          case Opcodes.OpAdd: ip += 1;
            lines.push(`      { const r = __s[--__sp], l = __s[--__sp]; if (l instanceof __MonkeyString) __s[__sp++] = new __MonkeyString(l.value + r.value); else __s[__sp++] = __cachedInteger(l.value + r.value); }`);
            break;
          case Opcodes.OpAddInt: ip += 1;
            lines.push(`      { const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = __cachedInteger(l.value + r.value); }`);
            break;
          case Opcodes.OpSub: case Opcodes.OpSubInt: ip += 1;
            lines.push(`      { const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = __cachedInteger(l.value - r.value); }`);
            break;
          case Opcodes.OpMul: case Opcodes.OpMulInt: ip += 1;
            lines.push(`      { const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = __cachedInteger(l.value * r.value); }`);
            break;
          case Opcodes.OpDiv: case Opcodes.OpDivInt: ip += 1;
            lines.push(`      { const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = __cachedInteger(Math.trunc(l.value / r.value)); }`);
            break;

          case Opcodes.OpEqual: case Opcodes.OpEqualInt: ip += 1;
            lines.push(`      { const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = (l === r || l.value === r.value) ? __TRUE : __FALSE; }`);
            break;
          case Opcodes.OpNotEqual: case Opcodes.OpNotEqualInt: ip += 1;
            lines.push(`      { const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = (l !== r && l.value !== r.value) ? __TRUE : __FALSE; }`);
            break;
          case Opcodes.OpGreaterThan: case Opcodes.OpGreaterThanInt: ip += 1;
            lines.push(`      { const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = l.value > r.value ? __TRUE : __FALSE; }`);
            break;
          case Opcodes.OpLessThanInt: ip += 1;
            lines.push(`      { const r = __s[--__sp], l = __s[--__sp]; __s[__sp++] = l.value < r.value ? __TRUE : __FALSE; }`);
            break;

          case Opcodes.OpMinus: ip += 1;
            lines.push(`      { const v = __s[--__sp]; __s[__sp++] = __cachedInteger(-v.value); }`);
            break;
          case Opcodes.OpBang: ip += 1;
            lines.push(`      { const v = __s[--__sp]; __s[__sp++] = __isTruthy(v) ? __FALSE : __TRUE; }`);
            break;

          case Opcodes.OpTrue: ip += 1;
            lines.push(`      __s[__sp++] = __TRUE;`); break;
          case Opcodes.OpFalse: ip += 1;
            lines.push(`      __s[__sp++] = __FALSE;`); break;
          case Opcodes.OpNull: ip += 1;
            lines.push(`      __s[__sp++] = __NULL;`); break;

          case Opcodes.OpPop: ip += 1;
            lines.push(`      --__sp;`); break;

          case Opcodes.OpReturnValue: ip += 1;
            lines.push(`      return __s[--__sp];`);
            break;

          case Opcodes.OpReturn: ip += 1;
            lines.push(`      return __NULL;`);
            break;

          case Opcodes.OpCurrentClosure: ip += 1;
            lines.push(`      __s[__sp++] = null; /* self marker */`);
            break;

          case Opcodes.OpCall: {
            const numArgs = ins[ip + 1];
            ip += 2;
            lines.push(`      {`);
            lines.push(`        const __callArgs = new Array(${numArgs});`);
            for (let i = numArgs - 1; i >= 0; i--) {
              lines.push(`        __callArgs[${i}] = __s[--__sp];`);
            }
            lines.push(`        --__sp; /* pop callee */`);
            lines.push(`        __s[__sp++] = __self(__callArgs);`);
            lines.push(`      }`);
            break;
          }

          case Opcodes.OpJump: {
            const target = (ins[ip + 1] << 8) | ins[ip + 2];
            ip += 3;
            lines.push(`      __pc = ${target}; continue;`);
            break;
          }

          case Opcodes.OpJumpNotTruthy: {
            const target = (ins[ip + 1] << 8) | ins[ip + 2];
            ip += 3;
            lines.push(`      if (!__isTruthy(__s[--__sp])) { __pc = ${target}; continue; }`);
            break;
          }

          case Opcodes.OpGetLocalSubConst: {
            const slot = ins[ip + 1];
            const constIdx = (ins[ip + 2] << 8) | ins[ip + 3];
            ip += 4;
            const constVal = this.constants[constIdx];
            if (constVal instanceof MonkeyInteger) {
              lines.push(`      __s[__sp++] = __cachedInteger(__l${slot}.value - ${constVal.value});`);
            } else {
              lines.push(`      __s[__sp++] = __cachedInteger(__l${slot}.value - __consts[${constIdx}].value);`);
            }
            break;
          }

          default: {
            // Unknown opcode — can't compile
            return null;
          }
        }
      }

      // Fall through to next block
      if (bi + 1 < blocks.length && blocks[bi + 1] < ins.length) {
        lines.push(`      __pc = ${blocks[bi + 1]}; continue;`);
      }
      lines.push(`    }`);
    }

    lines.push(`  }`); // end switch
    lines.push(`  break;`); // end while (shouldn't reach here)
    lines.push(`}`); // end while

    const body = lines.join('\n');
    this._compiledSource = body;

    try {
      const fn = new Function(
        '__args', '__globals', '__consts', '__free',
        '__MonkeyInteger', '__MonkeyBoolean', '__MonkeyString',
        '__TRUE', '__FALSE', '__NULL',
        '__cachedInteger', '__internString', '__isTruthy', '__self',
        body
      );
      return fn;
    } catch (e) {
      return null;
    }
  }

  // Check if this function can be compiled with raw integer optimization
  _canUseRawInts() {
    const ins = this.fn.instructions;
    const referencedConsts = new Set();
    let ip = 0;
    while (ip < ins.length) {
      const op = ins[ip];
      const def = lookup(op);
      const widths = def ? def.operandWidths : [];
      let nextIp = ip + 1;

      // Track which constants this function actually references
      if (op === Opcodes.OpConstant) {
        const idx = (ins[ip + 1] << 8) | ins[ip + 2];
        referencedConsts.add(idx);
      }
      if (op === Opcodes.OpGetLocalSubConst) {
        const idx = (ins[ip + 2] << 8) | ins[ip + 3];
        referencedConsts.add(idx);
      }

      for (const w of widths) nextIp += w;

      switch (op) {
        case Opcodes.OpConstant:
        case Opcodes.OpGetLocal:
        case Opcodes.OpSetLocal:
        case Opcodes.OpAdd:
        case Opcodes.OpSub:
        case Opcodes.OpMul:
        case Opcodes.OpDiv:
        case Opcodes.OpAddInt:
        case Opcodes.OpSubInt:
        case Opcodes.OpMulInt:
        case Opcodes.OpDivInt:
        case Opcodes.OpEqual:
        case Opcodes.OpNotEqual:
        case Opcodes.OpGreaterThan:
        case Opcodes.OpEqualInt:
        case Opcodes.OpNotEqualInt:
        case Opcodes.OpGreaterThanInt:
        case Opcodes.OpLessThanInt:
        case Opcodes.OpMinus:
        case Opcodes.OpBang:
        case Opcodes.OpTrue:
        case Opcodes.OpFalse:
        case Opcodes.OpNull:
        case Opcodes.OpPop:
        case Opcodes.OpReturnValue:
        case Opcodes.OpReturn:
        case Opcodes.OpJump:
        case Opcodes.OpJumpNotTruthy:
        case Opcodes.OpCurrentClosure:
        case Opcodes.OpCall:
        case Opcodes.OpGetLocalSubConst:
        case Opcodes.OpGetGlobal:
        case Opcodes.OpSetGlobal:
        case Opcodes.OpGetFree:
          break;
        default:
          return false;
      }
      ip = nextIp;
    }
    // Only check constants actually referenced by this function
    for (const idx of referencedConsts) {
      const c = this.constants[idx];
      if (c instanceof MonkeyInteger || c instanceof MonkeyBoolean) continue;
      return false;
    }
    return true;
  }

  // Compile with raw JS numbers — no boxing for integer arithmetic
  // Generates TWO functions: inner (raw args/return) and outer (boxed wrapper)
  _compileSwitchRaw() {
    const ins = this.fn.instructions;
    const numLocals = this.fn.numLocals;
    const numParams = this.fn.numParameters;

    const lines = [];
    lines.push('"use strict";');
    // Inner raw function — takes raw numbers, returns raw number
    lines.push(`function __rawFib(__rawArgs) {`);
    for (let i = 0; i < numLocals; i++) {
      if (i < numParams) {
        lines.push(`  let __l${i} = __rawArgs[${i}];`);
      } else {
        lines.push(`  let __l${i} = 0;`);
      }
    }
    lines.push(`  const __s = [];`);
    lines.push(`  let __sp = 0;`);

    // Find all instruction boundaries
    const boundaries = new Set([0]);
    let ip = 0;
    while (ip < ins.length) {
      const op = ins[ip];
      const def = lookup(op);
      const widths = def ? def.operandWidths : [];
      let nextIp = ip + 1;
      for (const w of widths) nextIp += w;

      if (op === Opcodes.OpJump) {
        const target = (ins[ip + 1] << 8) | ins[ip + 2];
        boundaries.add(target);
        boundaries.add(nextIp);
      } else if (op === Opcodes.OpJumpNotTruthy) {
        const target = (ins[ip + 1] << 8) | ins[ip + 2];
        boundaries.add(target);
        boundaries.add(nextIp);
      } else if (op === Opcodes.OpReturnValue || op === Opcodes.OpReturn) {
        boundaries.add(nextIp);
      }
      ip = nextIp;
    }

    const blocks = [...boundaries].sort((a, b) => a - b);

    lines.push(`  let __pc = 0;`);
    lines.push(`  while (true) {`);
    lines.push(`    switch (__pc) {`);

    for (let bi = 0; bi < blocks.length; bi++) {
      const blockStart = blocks[bi];
      const blockEnd = bi + 1 < blocks.length ? blocks[bi + 1] : ins.length;
      if (blockStart >= ins.length) continue;

      lines.push(`      case ${blockStart}: {`);

      ip = blockStart;
      while (ip < blockEnd && ip < ins.length) {
        const op = ins[ip];

        switch (op) {
          case Opcodes.OpConstant: {
            const constIdx = (ins[ip + 1] << 8) | ins[ip + 2];
            ip += 3;
            const constVal = this.constants[constIdx];
            if (constVal instanceof MonkeyInteger) {
              lines.push(`        __s[__sp++] = ${constVal.value};`);
            } else if (constVal instanceof MonkeyBoolean) {
              lines.push(`        __s[__sp++] = ${constVal.value};`);
            } else {
              return null;
            }
            break;
          }

          case Opcodes.OpGetLocal: {
            const slot = ins[ip + 1]; ip += 2;
            lines.push(`        __s[__sp++] = __l${slot};`);
            break;
          }
          case Opcodes.OpSetLocal: {
            const slot = ins[ip + 1]; ip += 2;
            lines.push(`        __l${slot} = __s[--__sp];`);
            break;
          }

          case Opcodes.OpGetGlobal: {
            const idx = (ins[ip + 1] << 8) | ins[ip + 2]; ip += 3;
            lines.push(`        __s[__sp++] = __globals[${idx}].value;`);
            break;
          }
          case Opcodes.OpSetGlobal: {
            const idx = (ins[ip + 1] << 8) | ins[ip + 2]; ip += 3;
            lines.push(`        __globals[${idx}] = __cachedInteger(__s[--__sp]);`);
            break;
          }

          case Opcodes.OpGetFree: {
            const idx = ins[ip + 1]; ip += 2;
            lines.push(`        __s[__sp++] = __free[${idx}].value !== undefined ? __free[${idx}].value : __free[${idx}];`);
            break;
          }

          case Opcodes.OpAdd: case Opcodes.OpAddInt: ip += 1;
            lines.push(`        { const r = __s[--__sp]; __s[__sp - 1] += r; }`);
            break;
          case Opcodes.OpSub: case Opcodes.OpSubInt: ip += 1;
            lines.push(`        { const r = __s[--__sp]; __s[__sp - 1] -= r; }`);
            break;
          case Opcodes.OpMul: case Opcodes.OpMulInt: ip += 1;
            lines.push(`        { const r = __s[--__sp]; __s[__sp - 1] *= r; }`);
            break;
          case Opcodes.OpDiv: case Opcodes.OpDivInt: ip += 1;
            lines.push(`        { const r = __s[--__sp]; __s[__sp - 1] = Math.trunc(__s[__sp - 1] / r); }`);
            break;

          case Opcodes.OpEqual: case Opcodes.OpEqualInt: ip += 1;
            lines.push(`        { const r = __s[--__sp]; __s[__sp - 1] = __s[__sp - 1] === r; }`);
            break;
          case Opcodes.OpNotEqual: case Opcodes.OpNotEqualInt: ip += 1;
            lines.push(`        { const r = __s[--__sp]; __s[__sp - 1] = __s[__sp - 1] !== r; }`);
            break;
          case Opcodes.OpGreaterThan: case Opcodes.OpGreaterThanInt: ip += 1;
            lines.push(`        { const r = __s[--__sp]; __s[__sp - 1] = __s[__sp - 1] > r; }`);
            break;
          case Opcodes.OpLessThanInt: ip += 1;
            lines.push(`        { const r = __s[--__sp]; __s[__sp - 1] = __s[__sp - 1] < r; }`);
            break;

          case Opcodes.OpMinus: ip += 1;
            lines.push(`        __s[__sp - 1] = -__s[__sp - 1];`);
            break;
          case Opcodes.OpBang: ip += 1;
            lines.push(`        __s[__sp - 1] = !__s[__sp - 1];`);
            break;

          case Opcodes.OpTrue: ip += 1;
            lines.push(`        __s[__sp++] = true;`); break;
          case Opcodes.OpFalse: ip += 1;
            lines.push(`        __s[__sp++] = false;`); break;
          case Opcodes.OpNull: ip += 1;
            lines.push(`        __s[__sp++] = 0;`); break;

          case Opcodes.OpPop: ip += 1;
            lines.push(`        --__sp;`); break;

          case Opcodes.OpReturnValue: ip += 1;
            // Return raw number
            lines.push(`        return __s[--__sp];`);
            break;

          case Opcodes.OpReturn: ip += 1;
            lines.push(`        return 0;`);
            break;

          case Opcodes.OpCurrentClosure: ip += 1;
            lines.push(`        __s[__sp++] = null;`);
            break;

          case Opcodes.OpCall: {
            const numArgs = ins[ip + 1]; ip += 2;
            // Self-call with raw numbers — direct recursion, no boxing
            lines.push(`        {`);
            lines.push(`          const __ca = new Array(${numArgs});`);
            for (let i = numArgs - 1; i >= 0; i--) {
              lines.push(`          __ca[${i}] = __s[--__sp];`);
            }
            lines.push(`          --__sp;`);
            lines.push(`          __s[__sp++] = __rawFib(__ca);`);
            lines.push(`        }`);
            break;
          }

          case Opcodes.OpJump: {
            const target = (ins[ip + 1] << 8) | ins[ip + 2]; ip += 3;
            lines.push(`        __pc = ${target}; continue;`);
            break;
          }

          case Opcodes.OpJumpNotTruthy: {
            const target = (ins[ip + 1] << 8) | ins[ip + 2]; ip += 3;
            lines.push(`        if (!__s[--__sp]) { __pc = ${target}; continue; }`);
            break;
          }

          case Opcodes.OpGetLocalSubConst: {
            const slot = ins[ip + 1];
            const constIdx = (ins[ip + 2] << 8) | ins[ip + 3]; ip += 4;
            const constVal = this.constants[constIdx];
            if (constVal instanceof MonkeyInteger) {
              lines.push(`        __s[__sp++] = __l${slot} - ${constVal.value};`);
            } else {
              return null;
            }
            break;
          }

          default:
            return null;
        }
      }

      if (bi + 1 < blocks.length && blocks[bi + 1] < ins.length) {
        lines.push(`        __pc = ${blocks[bi + 1]}; continue;`);
      }
      lines.push(`      }`);
    }

    lines.push(`    }`); // end switch
    lines.push(`    break;`);
    lines.push(`  }`); // end while
    lines.push(`}`); // end __rawFib

    // Outer wrapper: unboxes args, calls raw, boxes result
    lines.push(`const __ra = new Array(__args.length);`);
    lines.push(`for (let i = 0; i < __args.length; i++) __ra[i] = __args[i] && __args[i].value !== undefined ? __args[i].value : 0;`);
    lines.push(`return __cachedInteger(__rawFib(__ra));`);

    const body = lines.join('\n');
    this._compiledSource = body;
    this._isRaw = true;

    try {
      const fn = new Function(
        '__args', '__globals', '__consts', '__free',
        '__MonkeyInteger', '__MonkeyBoolean', '__MonkeyString',
        '__TRUE', '__FALSE', '__NULL',
        '__cachedInteger', '__internString', '__isTruthy', '__self', '__selfRaw',
        body
      );
      return fn;
    } catch (e) {
      return null;
    }
  }
}
