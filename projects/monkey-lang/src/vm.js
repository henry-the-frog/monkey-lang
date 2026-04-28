// Monkey Language Virtual Machine
// Stack-based VM that executes bytecode from the compiler

import { Opcodes, readOperands, lookup } from './code.js';
import { CompiledFunction } from './compiler.js';
import {
  MonkeyInteger, MonkeyFloat, MonkeyBoolean, MonkeyString, MonkeyNull,
  MonkeyArray, MonkeyHash, MonkeyBuiltin, MonkeyError,
  MonkeyResult, MonkeyEnum, MonkeyGenerator,
  MonkeyClass, MonkeyInstance, MonkeyBoundMethod,
  TRUE, FALSE, NULL, cachedInteger, internString,
} from './object.js';
import { IR, JIT, TraceRecorder, JIT_EVENTS_FULL } from './jit.js';

const STACK_SIZE = 2048;
const GLOBALS_SIZE = 65536;
const MAX_FRAMES = 1024;

// Adaptive quickening: specialize generic opcodes after seeing consistent types
const QUICKEN_THRESHOLD = 8; // executions before specializing
// Map from generic opcode → specialized integer opcode
const QUICKEN_MAP = {
  [Opcodes.OpAdd]: Opcodes.OpAddInt,
  [Opcodes.OpSub]: Opcodes.OpSubInt,
  [Opcodes.OpMul]: Opcodes.OpMulInt,
  [Opcodes.OpDiv]: Opcodes.OpDivInt,
  [Opcodes.OpMod]: Opcodes.OpModInt,
  [Opcodes.OpEqual]: Opcodes.OpEqualInt,
  [Opcodes.OpNotEqual]: Opcodes.OpNotEqualInt,
  [Opcodes.OpGreaterThan]: Opcodes.OpGreaterThanInt,
};
// Reverse map: specialized → generic (for deopt)
const DEOPT_MAP = {};
for (const [gen, spec] of Object.entries(QUICKEN_MAP)) {
  DEOPT_MAP[spec] = Number(gen);
}

// Closure wraps a compiled function with its free variables
export class Closure {
  constructor(fn, free = []) {
    this.fn = fn;       // CompiledFunction
    this.free = free;   // captured variables
  }
  type() { return 'CLOSURE'; }
  inspect() { return `Closure[${this.fn.instructions.length}]`; }
}

// Call frame
class Frame {
  constructor(closure, basePointer) {
    this.closure = closure;
    this.ip = -1;           // instruction pointer (within this frame)
    this.basePointer = basePointer;
  }
  instructions() {
    return this.closure.fn.instructions;
  }
}

// Builtin functions
const BUILTINS = [
  // len
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    const arg = args[0];
    if (arg instanceof MonkeyString) return new MonkeyInteger(arg.value.length);
    if (arg instanceof MonkeyArray) return new MonkeyInteger(arg.elements.length);
    if (arg instanceof MonkeyGenerator) return new MonkeyInteger(arg.values.length);
    return new MonkeyError(`argument to \`len\` not supported, got ${arg.type()}`);
  }),
  // puts
  new MonkeyBuiltin((...args) => {
    for (const a of args) console.log(a.inspect());
    return NULL;
  }),
  // first
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyArray)) return new MonkeyError(`argument to \`first\` must be ARRAY, got ${args[0].type()}`);
    return args[0].elements.length > 0 ? args[0].elements[0] : NULL;
  }),
  // last
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyArray)) return new MonkeyError(`argument to \`last\` must be ARRAY, got ${args[0].type()}`);
    const els = args[0].elements;
    return els.length > 0 ? els[els.length - 1] : NULL;
  }),
  // rest
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyArray)) return new MonkeyError(`argument to \`rest\` must be ARRAY, got ${args[0].type()}`);
    const els = args[0].elements;
    if (els.length === 0) return NULL;
    return new MonkeyArray(els.slice(1));
  }),
  // push
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=2`);
    if (!(args[0] instanceof MonkeyArray)) return new MonkeyError(`argument to \`push\` must be ARRAY, got ${args[0].type()}`);
    return new MonkeyArray([...args[0].elements, args[1]]);
  }),
  // split
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=2`);
    if (!(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyString))
      return new MonkeyError(`arguments to \`split\` must be STRING`);
    return new MonkeyArray(args[0].value.split(args[1].value).map(s => new MonkeyString(s)));
  }),
  // join
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=2`);
    if (!(args[0] instanceof MonkeyArray) || !(args[1] instanceof MonkeyString))
      return new MonkeyError(`arguments to \`join\` must be (ARRAY, STRING)`);
    return new MonkeyString(args[0].elements.map(e => e instanceof MonkeyString ? e.value : e.inspect()).join(args[1].value));
  }),
  // trim
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyString)) return new MonkeyError(`argument to \`trim\` must be STRING`);
    return new MonkeyString(args[0].value.trim());
  }),
  // str_contains
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=2`);
    if (!(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyString))
      return new MonkeyError(`arguments to \`str_contains\` must be STRING`);
    return args[0].value.includes(args[1].value) ? TRUE : FALSE;
  }),
  // substr
  new MonkeyBuiltin((...args) => {
    if (args.length < 2 || args.length > 3) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=2 or 3`);
    if (!(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyInteger))
      return new MonkeyError(`arguments to \`substr\` must be (STRING, INT[, INT])`);
    const str = args[0].value;
    const start = args[1].value;
    const end = args.length === 3 && args[2] instanceof MonkeyInteger ? args[2].value : str.length;
    return new MonkeyString(str.slice(start, end));
  }),
  // replace
  new MonkeyBuiltin((...args) => {
    if (args.length !== 3) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=3`);
    if (!(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyString) || !(args[2] instanceof MonkeyString))
      return new MonkeyError(`arguments to \`replace\` must be STRING`);
    return new MonkeyString(args[0].value.split(args[1].value).join(args[2].value));
  }),
  // int
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    if (args[0] instanceof MonkeyInteger) return args[0];
    if (args[0] instanceof MonkeyString) {
      const n = parseInt(args[0].value);
      if (isNaN(n)) return NULL;
      return new MonkeyInteger(n);
    }
    return new MonkeyError(`cannot convert ${args[0].type()} to INT`);
  }),
  // str
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    if (args[0] instanceof MonkeyString) return args[0];
    return new MonkeyString(args[0].inspect());
  }),
  // type
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    return new MonkeyString(args[0].type());
  }),
  // upper
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyString))
      return new MonkeyError(`argument to \`upper\` must be STRING`);
    return new MonkeyString(args[0].value.toUpperCase());
  }),
  // lower
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyString))
      return new MonkeyError(`argument to \`lower\` must be STRING`);
    return new MonkeyString(args[0].value.toLowerCase());
  }),
  // indexOf
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=2`);
    if (args[0] instanceof MonkeyString && args[1] instanceof MonkeyString) {
      return cachedInteger(args[0].value.indexOf(args[1].value));
    }
    if (args[0] instanceof MonkeyArray) {
      for (let i = 0; i < args[0].elements.length; i++) {
        if (args[0].elements[i].inspect() === args[1].inspect()) return cachedInteger(i);
      }
      return cachedInteger(-1);
    }
    return new MonkeyError(`first argument to \`indexOf\` must be STRING or ARRAY`);
  }),
  // startsWith
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || !(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyString))
      return new MonkeyError(`arguments to \`startsWith\` must be (STRING, STRING)`);
    return args[0].value.startsWith(args[1].value) ? TRUE : FALSE;
  }),
  // endsWith
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || !(args[0] instanceof MonkeyString) || !(args[1] instanceof MonkeyString))
      return new MonkeyError(`arguments to \`endsWith\` must be (STRING, STRING)`);
    return args[0].value.endsWith(args[1].value) ? TRUE : FALSE;
  }),
  // char — convert integer to single character
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyInteger))
      return new MonkeyError(`argument to \`char\` must be INTEGER`);
    return new MonkeyString(String.fromCharCode(args[0].value));
  }),
  // ord — convert single character to integer
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyString))
      return new MonkeyError(`argument to \`ord\` must be STRING`);
    return cachedInteger(args[0].value.charCodeAt(0));
  }),
  // keys — get hash keys as array
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyHash))
      return new MonkeyError(`argument to \`keys\` must be HASH`);
    const keys = [];
    for (const [, pair] of args[0].pairs) {
      keys.push(pair.key);
    }
    return new MonkeyArray(keys);
  }),
  // values — get hash values as array
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyHash))
      return new MonkeyError(`argument to \`values\` must be HASH`);
    const values = [];
    for (const [, pair] of args[0].pairs) {
      values.push(pair.value);
    }
    return new MonkeyArray(values);
  }),
  // abs — absolute value
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyInteger))
      return new MonkeyError(`argument to \`abs\` must be INTEGER`);
    return cachedInteger(Math.abs(args[0].value));
  }),
  // sort — sort an array (integers/strings)
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray))
      return new MonkeyError(`argument to \`sort\` must be ARRAY`);
    const sorted = [...args[0].elements].sort((a, b) => {
      if (a instanceof MonkeyInteger && b instanceof MonkeyInteger) return a.value - b.value;
      return a.inspect().localeCompare(b.inspect());
    });
    return new MonkeyArray(sorted);
  }),
  // reverse — reverse an array
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray))
      return new MonkeyError(`argument to \`reverse\` must be ARRAY`);
    return new MonkeyArray([...args[0].elements].reverse());
  }),
  // contains — check if array/string contains a value
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=2`);
    if (args[0] instanceof MonkeyArray) {
      return args[0].elements.some(el => el.inspect() === args[1].inspect()) ? TRUE : FALSE;
    }
    if (args[0] instanceof MonkeyString && args[1] instanceof MonkeyString) {
      return args[0].value.includes(args[1].value) ? TRUE : FALSE;
    }
    return new MonkeyError(`\`contains\` not supported for ${args[0].type()}`);
  }),
  // sum — sum an array of integers
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray))
      return new MonkeyError(`argument to \`sum\` must be ARRAY`);
    let total = 0;
    for (const el of args[0].elements) {
      if (el instanceof MonkeyInteger) total += el.value;
    }
    return cachedInteger(total);
  }),
  // max — maximum of array
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray))
      return new MonkeyError(`argument to \`max\` must be ARRAY`);
    let m = -Infinity;
    for (const el of args[0].elements) {
      if (el instanceof MonkeyInteger && el.value > m) m = el.value;
    }
    return m === -Infinity ? NULL : cachedInteger(m);
  }),
  // min — minimum of array
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray))
      return new MonkeyError(`argument to \`min\` must be ARRAY`);
    let m = Infinity;
    for (const el of args[0].elements) {
      if (el instanceof MonkeyInteger && el.value < m) m = el.value;
    }
    return m === Infinity ? NULL : cachedInteger(m);
  }),
  // range — range(n) or range(start, end) or range(start, end, step)
  new MonkeyBuiltin((...args) => {
    if (args.length < 1 || args.length > 3) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1-3`);
    let start = 0, end, step = 1;
    if (args.length === 1) {
      end = args[0].value;
    } else {
      start = args[0].value;
      end = args[1].value;
      if (args.length === 3) step = args[2].value;
    }
    const result = [];
    if (step > 0) {
      for (let i = start; i < end; i += step) result.push(cachedInteger(i));
    } else if (step < 0) {
      for (let i = start; i > end; i += step) result.push(cachedInteger(i));
    }
    return new MonkeyArray(result);
  }),
  // flat — flatten one level
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray))
      return new MonkeyError(`argument to \`flat\` must be ARRAY`);
    const result = [];
    for (const el of args[0].elements) {
      if (el instanceof MonkeyArray) result.push(...el.elements);
      else result.push(el);
    }
    return new MonkeyArray(result);
  }),
  // zip — zip two arrays into pairs
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2 || !(args[0] instanceof MonkeyArray) || !(args[1] instanceof MonkeyArray))
      return new MonkeyError(`zip requires two ARRAY arguments`);
    const len = Math.min(args[0].elements.length, args[1].elements.length);
    const result = [];
    for (let i = 0; i < len; i++) {
      result.push(new MonkeyArray([args[0].elements[i], args[1].elements[i]]));
    }
    return new MonkeyArray(result);
  }),
  // enumerate — returns [[0, el0], [1, el1], ...]
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1 || !(args[0] instanceof MonkeyArray))
      return new MonkeyError(`argument to \`enumerate\` must be ARRAY`);
    const result = [];
    for (let i = 0; i < args[0].elements.length; i++) {
      result.push(new MonkeyArray([cachedInteger(i), args[0].elements[i]]));
    }
    return new MonkeyArray(result);
  }),
  // Ok
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    return new MonkeyResult(true, args[0]);
  }),
  // Err
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    return new MonkeyResult(false, args[0]);
  }),
  // is_ok
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyResult)) return FALSE;
    return args[0].isOk ? TRUE : FALSE;
  }),
  // is_err
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyResult)) return FALSE;
    return args[0].isOk ? FALSE : TRUE;
  }),
  // unwrap
  new MonkeyBuiltin((...args) => {
    if (args.length !== 1) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=1`);
    if (!(args[0] instanceof MonkeyResult)) return new MonkeyError('unwrap requires a Result');
    if (!args[0].isOk) return new MonkeyError('unwrap called on Err: ' + args[0].value.inspect());
    return args[0].value;
  }),
  // unwrap_or: Result, default → value (Ok value or default)
  new MonkeyBuiltin((...args) => {
    if (args.length !== 2) return new MonkeyError(`wrong number of arguments. got=${args.length}, want=2`);
    if (!(args[0] instanceof MonkeyResult)) return args[0]; // not a Result, return as-is
    return args[0].isOk ? args[0].value : args[1];
  }),
];

export class VM {
  constructor(bytecode) {
    this.constants = bytecode.constants;
    this.globals = new Array(GLOBALS_SIZE);

    this.stack = new Array(STACK_SIZE);
    this.sp = 0; // stack pointer — always points to next free slot

    // Set up main frame
    const mainFn = new CompiledFunction(bytecode.instructions);
    const mainClosure = new Closure(mainFn);
    this.frames = new Array(MAX_FRAMES);
    this.frames[0] = new Frame(mainClosure, 0);
    this.framesIndex = 1;

    // JIT support
    this.jit = null;
    this.recorder = null;
    this._traceConsts = [];    // extra constants referenced by traces (closures, etc.)

    // Exception handling
    this.handlerStack = [];
  }

  enableJIT() {
    this.jit = new JIT();
    return this;
  }

  /** Create a VM that reuses an existing globals store (for REPL) */
  static withGlobals(bytecode, globals) {
    const vm = new VM(bytecode);
    vm.globals = globals;
    return vm;
  }

  currentFrame() {
    return this.frames[this.framesIndex - 1];
  }

  pushFrame(frame) {
    this.frames[this.framesIndex] = frame;
    this.framesIndex++;
  }

  popFrame() {
    this.framesIndex--;
    return this.frames[this.framesIndex];
  }

  stackTop() {
    if (this.sp === 0) return null;
    return this.stack[this.sp - 1];
  }

  lastPoppedStackElem() {
    return this.stack[this.sp];
  }

  push(obj) {
    if (this.sp >= STACK_SIZE) throw new Error('stack overflow');
    this.stack[this.sp] = obj;
    this.sp++;
  }

  pop() {
    const obj = this.stack[this.sp - 1];
    this.sp--;
    return obj;
  }

  run() {
    let ip, ins, op;
    let frame = this.currentFrame();
    const recording = () => this.recorder && this.recorder.recording && !(this.recorder._skipDepth > 0);

    while (frame.ip < frame.closure.fn.instructions.length - 1) {
      frame.ip++;
      ip = frame.ip;
      ins = frame.closure.fn.instructions;
      op = ins[ip];

      // Check if we've looped back to trace start (recording complete)
      if (recording() && this.recorder.instrCount > 0 && ip === this.recorder.startIp
          && this.framesIndex === this.recorder.startFrame
          && this.recorder.inlineDepth === 0) {
        const trace = this.recorder.stop();
        if (trace && this.jit && this.jit.compile(trace, this)) {
          this.jit.storeTrace(trace);
          // Execute the freshly compiled trace immediately
          if (!trace.isSideTrace) {
            try {
              this._executeTrace(trace);
            } catch (e) {
              // Fresh trace failed — delete it
              for (const [key, t] of this.jit.traces) {
                if (t === trace) { this.jit.traces.delete(key); break; }
              }
            }
          }
          this.recorder = null;
          continue; // ip changed by trace; restart loop
        }
        this.recorder = null;
      }

      // Check if side trace recording should stop (reached parent's loop header)
      if (recording() && this.recorder.instrCount > 0
          && this.recorder.shouldStopSideTrace(ip, this.framesIndex)) {
        const trace = this.recorder.stop();
        if (trace && this.jit && this.jit.compile(trace, this)) {
          this.jit.storeTrace(trace);
        }
        this.recorder = null;
        // Don't skip the instruction — we're at the parent loop header,
        // and the parent trace will pick it up on the next back-edge
      }

      // Abort recording on too many instructions
      if (recording() && ++this.recorder.instrCount > 200) {
        this._abortRecording('instr_count_max');
      }

      switch (op) {
        case Opcodes.OpConstant: {
          const constIdx = (ins[ip + 1] << 8) | ins[ip + 2];
          frame.ip += 2;
          const constVal = this.constants[constIdx];
          this.push(constVal);
          if (recording()) {
            this._recordPush(op, constVal, [constIdx]);
          }
          break;
        }

        case Opcodes.OpPop:
          this.pop();
          if (recording()) { this.recorder.popRef(); }
          break;

        case Opcodes.OpAdd:
        case Opcodes.OpSub:
        case Opcodes.OpMul:
        case Opcodes.OpDiv:
        case Opcodes.OpMod: {
          const right = this.pop();
          const left = this.pop();

          if (left instanceof MonkeyInteger && right instanceof MonkeyInteger) {
            if (recording()) {
              this.recorder.recordIntArith(op, left, right);
            }
            // Adaptive quickening: count consecutive integer observations
            const specOp = QUICKEN_MAP[op];
            if (specOp !== undefined) {
              const counters = this._getQuickenCounters(ins);
              const count = (counters[ip] || 0) + 1;
              counters[ip] = count;
              if (count >= QUICKEN_THRESHOLD) {
                ins[ip] = specOp; // Rewrite bytecode in place!
              }
            }
            let result;
            switch (op) {
              case Opcodes.OpAdd: result = left.value + right.value; break;
              case Opcodes.OpSub: result = left.value - right.value; break;
              case Opcodes.OpMul: result = left.value * right.value; break;
              case Opcodes.OpDiv: result = Math.trunc(left.value / right.value); break;
              case Opcodes.OpMod: result = left.value % right.value; break;
            }
            this.push(cachedInteger(result));
          } else if ((left instanceof MonkeyFloat || right instanceof MonkeyFloat) &&
                     (left instanceof MonkeyInteger || left instanceof MonkeyFloat) &&
                     (right instanceof MonkeyInteger || right instanceof MonkeyFloat)) {
            // Float arithmetic
            if (recording()) { this._abortRecording('float_arith'); }
            let result;
            switch (op) {
              case Opcodes.OpAdd: result = left.value + right.value; break;
              case Opcodes.OpSub: result = left.value - right.value; break;
              case Opcodes.OpMul: result = left.value * right.value; break;
              case Opcodes.OpDiv: result = left.value / right.value; break;
              case Opcodes.OpMod: result = left.value % right.value; break;
            }
            this.push(new MonkeyFloat(result));
          } else if (left instanceof MonkeyString && right instanceof MonkeyString && op === Opcodes.OpAdd) {
            if (recording()) {
              // Record string concatenation with unbox/box for promotion
              const rRef = this.recorder.popRef();
              const lRef = this.recorder.popRef();
              if (this.recorder.knownType(lRef) !== 'string' && this.recorder.knownType(lRef) !== 'raw_string') this.recorder.guardType(lRef, left);
              if (this.recorder.knownType(rRef) !== 'string' && this.recorder.knownType(rRef) !== 'raw_string') this.recorder.guardType(rRef, right);
              // Unbox to raw strings if needed
              let lRaw = lRef;
              if (this.recorder.knownType(lRef) !== 'raw_string') {
                lRaw = this.recorder.trace.addInst(IR.UNBOX_STRING, { ref: lRef });
                this.recorder.typeMap.set(lRaw, 'raw_string');
              }
              let rRaw = rRef;
              if (this.recorder.knownType(rRef) !== 'raw_string') {
                rRaw = this.recorder.trace.addInst(IR.UNBOX_STRING, { ref: rRef });
                this.recorder.typeMap.set(rRaw, 'raw_string');
              }
              const concatRef = this.recorder.trace.addInst(IR.CONCAT, { left: lRaw, right: rRaw });
              this.recorder.typeMap.set(concatRef, 'raw_string');
              // Box the result
              const boxedRef = this.recorder.trace.addInst(IR.BOX_STRING, { ref: concatRef });
              this.recorder.typeMap.set(boxedRef, 'string');
              this.recorder.pushRef(boxedRef);
            }
            this.push(new MonkeyString(left.value + right.value));
          } else if (left instanceof MonkeyString && right instanceof MonkeyInteger && op === Opcodes.OpMul) {
            // String repetition: "abc" * 3 => "abcabcabc"
            if (recording()) {
              this.recorder.popRef();
              this.recorder.popRef();
              this._abortRecording('string multiplication not JIT-compiled');
            }
            const n = right.value;
            this.push(new MonkeyString(n > 0 ? left.value.repeat(n) : ''));
          } else if (left instanceof MonkeyInteger && right instanceof MonkeyString && op === Opcodes.OpMul) {
            // Also support n * "abc"
            if (recording()) {
              this.recorder.popRef();
              this.recorder.popRef();
              this._abortRecording('string multiplication not JIT-compiled');
            }
            const n = left.value;
            this.push(new MonkeyString(n > 0 ? right.value.repeat(n) : ''));
          } else if (left instanceof MonkeyArray && right instanceof MonkeyArray && op === Opcodes.OpAdd) {
            // Array concatenation: [1,2] + [3,4] → [1,2,3,4]
            this.push(new MonkeyArray([...left.elements, ...right.elements]));
          } else {
            throw new Error(`unsupported types for ${op}: ${left.type()} and ${right.type()}`);
          }
          break;
        }

        case Opcodes.OpTrue:
          this.push(TRUE);
          if (recording()) { this._recordPush(op, TRUE, []); }
          break;

        case Opcodes.OpFalse:
          this.push(FALSE);
          if (recording()) { this._recordPush(op, FALSE, []); }
          break;

        case Opcodes.OpEqual:
        case Opcodes.OpNotEqual:
        case Opcodes.OpGreaterThan: {
          const right2 = this.pop();
          const left2 = this.pop();

          if (left2 instanceof MonkeyInteger && right2 instanceof MonkeyInteger) {
            if (recording()) {
              this.recorder.recordComparison(op, left2, right2);
            }
            // Adaptive quickening for comparisons
            const specOp2 = QUICKEN_MAP[op];
            if (specOp2 !== undefined) {
              const counters2 = this._getQuickenCounters(ins);
              const count2 = (counters2[ip] || 0) + 1;
              counters2[ip] = count2;
              if (count2 >= QUICKEN_THRESHOLD) {
                ins[ip] = specOp2;
              }
            }
            let result;
            switch (op) {
              case Opcodes.OpEqual: result = left2.value === right2.value; break;
              case Opcodes.OpNotEqual: result = left2.value !== right2.value; break;
              case Opcodes.OpGreaterThan: result = left2.value > right2.value; break;
            }
            this.push(result ? TRUE : FALSE);
          } else if (left2 instanceof MonkeyBoolean && right2 instanceof MonkeyBoolean) {
            if (recording()) { this._abortRecording('bool_compare'); }
            let result;
            switch (op) {
              case Opcodes.OpEqual: result = left2.value === right2.value; break;
              case Opcodes.OpNotEqual: result = left2.value !== right2.value; break;
              default: throw new Error(`unknown operator for booleans`);
            }
            this.push(result ? TRUE : FALSE);
          } else if ((left2 instanceof MonkeyFloat || right2 instanceof MonkeyFloat) &&
                     (left2 instanceof MonkeyInteger || left2 instanceof MonkeyFloat) &&
                     (right2 instanceof MonkeyInteger || right2 instanceof MonkeyFloat)) {
            if (recording()) { this._abortRecording('mixed_numeric_compare'); }
            let result;
            switch (op) {
              case Opcodes.OpEqual: result = left2.value === right2.value; break;
              case Opcodes.OpNotEqual: result = left2.value !== right2.value; break;
              case Opcodes.OpGreaterThan: result = left2.value > right2.value; break;
            }
            this.push(result ? TRUE : FALSE);
          } else if (left2 instanceof MonkeyString && right2 instanceof MonkeyString) {
            if (recording()) { this._abortRecording('string_compare'); }
            let result;
            switch (op) {
              case Opcodes.OpEqual: result = left2.value === right2.value; break;
              case Opcodes.OpNotEqual: result = left2.value !== right2.value; break;
              case Opcodes.OpGreaterThan: result = left2.value > right2.value; break;
            }
            this.push(result ? TRUE : FALSE);
          } else if (left2 === NULL || right2 === NULL) {
            // Null comparison: null == null is true, null == anything_else is false
            if (recording()) { this._abortRecording('null_compare'); }
            const result = op === Opcodes.OpEqual ? (left2 === right2) : (left2 !== right2);
            this.push(result ? TRUE : FALSE);
          } else if (left2 instanceof MonkeyEnum && right2 instanceof MonkeyEnum) {
            if (recording()) { this._abortRecording('enum_compare'); }
            const eq = left2.enumName === right2.enumName && left2.variant === right2.variant;
            const result = op === Opcodes.OpEqual ? eq : !eq;
            this.push(result ? TRUE : FALSE);
          } else {
            throw new Error(`unsupported comparison: ${left2.type()} and ${right2.type()}`);
          }
          break;
        }

        case Opcodes.OpMinus: {
          const operand = this.pop();
          if (operand instanceof MonkeyFloat) {
            if (recording()) { this._abortRecording('float_negate'); }
            this.push(new MonkeyFloat(-operand.value));
            break;
          }
          if (!(operand instanceof MonkeyInteger)) {
            throw new Error(`unsupported type for negation: ${operand.type()}`);
          }
          if (recording()) {
            const ref = this.recorder.popRef();
            if (this.recorder.knownType(ref) !== 'int') this.recorder.guardType(ref, operand);
            const unboxed = this.recorder.trace.addInst(IR.UNBOX_INT, { ref });
            const negRef = this.recorder.trace.addInst(IR.NEG, { ref: unboxed });
            const boxed = this.recorder.trace.addInst(IR.BOX_INT, { ref: negRef });
            this.recorder.typeMap.set(boxed, 'int');
            this.recorder.pushRef(boxed);
          }
          this.push(cachedInteger(-operand.value));
          break;
        }

        case Opcodes.OpBang: {
          const operand2 = this.pop();
          if (recording()) {
            const ref = this.recorder.popRef();
            const notRef = this.recorder.trace.addInst(IR.NOT, { ref });
            this.recorder.typeMap.set(notRef, 'raw_bool');
            // Box to MonkeyBoolean
            const boxed = this.recorder.trace.addInst(IR.CONST_BOOL, { ref: notRef });
            this.recorder.typeMap.set(boxed, 'bool');
            this.recorder.pushRef(boxed);
          }
          if (operand2 === TRUE) this.push(FALSE);
          else if (operand2 === FALSE) this.push(TRUE);
          else if (operand2 === NULL) this.push(TRUE);
          else this.push(FALSE);
          break;
        }

        case Opcodes.OpJumpNotTruthy: {
          const target = (ins[ip + 1] << 8) | ins[ip + 2];
          frame.ip += 2;
          const condition = this.pop();
          const truthy = this.isTruthy(condition);

          if (recording()) {
            const condRef = this.recorder.popRef();
            const overrideExitIp = this.recorder.getGuardExitIp();
            if (truthy) {
              // Took the fall-through path — guard that it stays truthy
              const exitIp = overrideExitIp !== null ? overrideExitIp : target;
              this.recorder.addGuardInst(IR.GUARD_TRUTHY, { ref: condRef, exitIp });
              this.recorder.trace.guardCount++;
            } else {
              // Took the jump path — guard that it stays falsy
              const exitIp = overrideExitIp !== null ? overrideExitIp : ip + 3;
              this.recorder.addGuardInst(IR.GUARD_FALSY, { ref: condRef, exitIp });
              this.recorder.trace.guardCount++;
            }
          }

          if (!truthy) {
            frame.ip = target - 1;
          }
          break;
        }

        case Opcodes.OpJump: {
          const target2 = (ins[ip + 1] << 8) | ins[ip + 2];

          // Backward jump = loop back-edge (only in non-inlined context)
          if (this.jit && target2 <= ip && !(recording() && this.recorder.inlineDepth > 0)) {
            const closureId = this._closureId();

            // Check for existing compiled trace
            const existingTrace = this.jit.getTrace(closureId, target2);
            if (existingTrace && existingTrace.compiled) {
              if (recording() && target2 !== this.recorder.startIp
                  && !(this.recorder.isSideTrace && existingTrace === this.recorder.parentTrace)) {
                // Trace stitching: we're recording an outer loop and hit an inner
                // loop that already has a compiled trace. Execute the inner trace
                // (to advance VM state) and emit EXEC_TRACE IR so the compiled
                // outer trace can call the inner trace at runtime.
                const constIdx = this._ensureTraceConst(existingTrace.compiled);
                this.recorder.trace.addInst(IR.EXEC_TRACE, { constIdx });
                // Execute the inner trace to advance state
                this._executeTrace(existingTrace);
                // Continue recording from wherever the inner trace left off
                break;
              } else if (!recording()) {
                const savedSp = this.sp;
                try {
                  this._executeTrace(existingTrace);
                } catch (e) {
                  this.sp = savedSp; // Restore sp on failure
                  for (const [key, t] of this.jit.traces) {
                    if (t === existingTrace) { this.jit.traces.delete(key); break; }
                  }
                  frame.ip = target2 - 1;
                }
                break;
              }
            }

            // Hot counting (only when not already recording)
            if (!recording() && this.jit.countEdge(closureId, target2)) {
              this._startRecording(target2);
            }
            
            // If we're recording an outer loop and hit an inner loop back-edge
            // that doesn't have a compiled trace yet, abort recording.
            // The inner loop will get its own trace, and trace stitching will
            // handle the combination. Without this, the outer trace inlines the
            // inner loop body with constant-folded values from the recording
            // iteration, producing incorrect results for subsequent iterations.
            if (recording() && target2 !== this.recorder.startIp &&
                target2 < this.recorder.startIp) {
              this._abortRecording('inner loop without compiled trace');
            }
          }

          frame.ip = target2 - 1;
          break;
        }

        case Opcodes.OpNull:
          this.push(NULL);
          if (recording()) { this._recordPush(op, NULL, []); }
          break;

        case Opcodes.OpSetGlobal: {
          const globalIdx = (ins[ip + 1] << 8) | ins[ip + 2];
          frame.ip += 2;
          const setGlobalVal = this.pop();
          this.globals[globalIdx] = setGlobalVal;
          if (recording()) {
            const valRef = this.recorder.popRef();
            this.recorder.trace.addInst(IR.STORE_GLOBAL, { index: globalIdx, value: valRef });
            this.recorder.trackGlobalStore(globalIdx, valRef);
          }
          break;
        }

        case Opcodes.OpGetGlobal: {
          const globalIdx2 = (ins[ip + 1] << 8) | ins[ip + 2];
          frame.ip += 2;
          const getGlobalVal = this.globals[globalIdx2];
          this.push(getGlobalVal);
          if (recording()) {
            const ref = this.recorder.trace.addInst(IR.LOAD_GLOBAL, { index: globalIdx2 });
            this.recorder.pushRef(ref);
            this.recorder.trackGlobalLoad(globalIdx2, ref);
          }
          break;
        }

        case Opcodes.OpSetLocal: {
          const localIdx = ins[ip + 1];
          frame.ip += 1;
          const setVal = this.pop();
          this.stack[frame.basePointer + localIdx] = setVal;
          if (recording()) {
            const valRef = this.recorder.popRef();
            const absSlot = this.recorder.currentBaseOffset() + localIdx;
            this.recorder.trace.addInst(IR.STORE_LOCAL, { slot: absSlot, value: valRef });
            this.recorder.trackLocalStore(absSlot, valRef);
          }
          break;
        }

        case Opcodes.OpGetLocal: {
          const localIdx2 = ins[ip + 1];
          frame.ip += 1;
          const localVal = this.stack[frame.basePointer + localIdx2];
          this.push(localVal);
          if (recording()) {
            const absSlot = this.recorder.currentBaseOffset() + localIdx2;
            // Check if this slot has a direct IR ref from inlined arg passing
            const inlineRef = this.recorder.inlineSlotRefs.get(absSlot);
            if (inlineRef !== undefined) {
              this.recorder.pushRef(inlineRef);
              this.recorder.trackLocalLoad(absSlot, inlineRef);
            } else {
              const ref = this.recorder.trace.addInst(IR.LOAD_LOCAL, { slot: absSlot });
              this.recorder.pushRef(ref);
              this.recorder.trackLocalLoad(absSlot, ref);
            }
          }
          break;
        }

        case Opcodes.OpArray: {
          if (recording()) { this._abortRecording('array_lit'); }
          const numElements = (ins[ip + 1] << 8) | ins[ip + 2];
          frame.ip += 2;
          const elements = this.stack.slice(this.sp - numElements, this.sp);
          this.sp -= numElements;
          this.push(new MonkeyArray([...elements]));
          break;
        }

        case Opcodes.OpHash: {
          if (recording()) { this._abortRecording('hash_lit'); }
          const numPairs = (ins[ip + 1] << 8) | ins[ip + 2];
          frame.ip += 2;
          const pairs = new Map();
          // Stack has key, value, key, value... from bottom to top
          const hashElems = this.stack.slice(this.sp - numPairs, this.sp);
          this.sp -= numPairs;
          for (let i = 0; i < hashElems.length; i += 2) {
            const key = hashElems[i];
            const value = hashElems[i + 1];
            if (!key.fastHashKey) throw new Error(`unusable as hash key: ${key.type()}`);
            pairs.set(key.fastHashKey(), { key, value });
          }
          this.push(new MonkeyHash(pairs));
          break;
        }

        case Opcodes.OpIndex: {
          const index = this.pop();
          const left3 = this.pop();
          if (recording()) {
            if (left3 instanceof MonkeyArray && index instanceof MonkeyInteger) {
              // Record array index access
              const idxRef = this.recorder.popRef();
              const arrRef = this.recorder.popRef();
              // Guard: left must be array
              if (this.recorder.knownType(arrRef) !== 'array') {
                const exitIp = this.recorder.getGuardExitIp();
                this.recorder.addGuardInst(IR.GUARD_ARRAY, { ref: arrRef, exitIp });
                this.recorder.typeMap.set(arrRef, 'array');
                this.recorder.trace.guardCount++;
              }
              // Guard: index must be int
              if (this.recorder.knownType(idxRef) !== 'int' && this.recorder.knownType(idxRef) !== 'raw_int') {
                this.recorder.guardType(idxRef, index);
              }
              // Unbox index
              let idxUnboxed = idxRef;
              if (this.recorder.knownType(idxRef) !== 'raw_int') {
                idxUnboxed = this.recorder.trace.addInst(IR.UNBOX_INT, { ref: idxRef });
                this.recorder.typeMap.set(idxUnboxed, 'raw_int');
              }
              // Bounds guard
              const exitIp2 = this.recorder.getGuardExitIp();
              this.recorder.addGuardInst(IR.GUARD_BOUNDS, { left: arrRef, right: idxUnboxed, exitIp: exitIp2 });
              this.recorder.trace.guardCount++;
              // Emit index_array
              const resultRef = this.recorder.trace.addInst(IR.INDEX_ARRAY, { left: arrRef, right: idxUnboxed });
              this.recorder.typeMap.set(resultRef, 'object');
              this.recorder.pushRef(resultRef);
            } else if (left3 instanceof MonkeyHash) {
              // Record hash index access
              const keyRef = this.recorder.popRef();
              const hashRef = this.recorder.popRef();
              // Guard: left must be hash
              const exitIpH = this.recorder.getGuardExitIp();
              this.recorder.addGuardInst(IR.GUARD_HASH, { ref: hashRef, exitIp: exitIpH });
              this.recorder.typeMap.set(hashRef, 'hash');
              this.recorder.trace.guardCount++;
              // Emit index_hash — key is a MonkeyObject with hashKey()
              const resultRef = this.recorder.trace.addInst(IR.INDEX_HASH, { left: hashRef, right: keyRef });
              this.recorder.typeMap.set(resultRef, 'object');
              this.recorder.pushRef(resultRef);
            } else {
              this._abortRecording('index_unsupported');
            }
          }
          if (left3 instanceof MonkeyArray && index instanceof MonkeyInteger) {
            let i = index.value;
            if (i < 0) i += left3.elements.length; // negative indexing
            if (i < 0 || i >= left3.elements.length) {
              this.push(NULL);
            } else {
              this.push(left3.elements[i]);
            }
          } else if (left3 instanceof MonkeyHash) {
            if (!index.fastHashKey) throw new Error(`unusable as hash key: ${index.type()}`);
            const hk = index.fastHashKey();
            const pair = left3.pairs.get(hk);
            this.push(pair ? pair.value : NULL);
          } else if (left3 instanceof MonkeyString && index instanceof MonkeyInteger) {
            let i = index.value;
            if (i < 0) i += left3.value.length; // negative indexing
            if (i < 0 || i >= left3.value.length) {
              this.push(NULL);
            } else {
              this.push(new MonkeyString(left3.value[i]));
            }
          } else if (left3 instanceof MonkeyString && index instanceof MonkeyString) {
            // String dot access: s.length
            switch (index.value) {
              case 'length': this.push(new MonkeyInteger(left3.value.length)); break;
              default: this.push(NULL); break;
            }
          } else if (left3 instanceof MonkeyArray && index instanceof MonkeyString) {
            // Array dot access: a.length
            switch (index.value) {
              case 'length': this.push(new MonkeyInteger(left3.elements.length)); break;
              default: this.push(NULL); break;
            }
          } else if (left3 instanceof MonkeyGenerator && index instanceof MonkeyInteger) {
            // Generator index access — treat like array
            let i = index.value;
            if (i < 0) i += left3.values.length;
            if (i < 0 || i >= left3.values.length) {
              this.push(NULL);
            } else {
              this.push(left3.values[i]);
            }
          } else if (left3 instanceof MonkeyInstance && index instanceof MonkeyString) {
            // Instance field/method access
            const fieldOrMethod = left3.get(index.value);
            if (fieldOrMethod instanceof Closure) {
              // Return bound method
              this.push(new MonkeyBoundMethod(left3, fieldOrMethod));
            } else {
              this.push(fieldOrMethod || NULL);
            }
          } else {
            throw new Error(`index operator not supported: ${left3.type()}`);
          }
          break;
        }

        case Opcodes.OpCall: {
          const numArgs = ins[ip + 1];
          frame.ip += 1;
          const callee = this.stack[this.sp - 1 - numArgs];

          if (callee instanceof Closure) {
            if (callee.fn.hasRestParam) {
              // Rest parameter: collect extra args into array
              const requiredParams = callee.fn.numParameters;
              const closurePos = this.sp - 1 - numArgs; // where the closure sits
              const bp = closurePos + 1; // locals start after closure
              
              if (numArgs < requiredParams) {
                // Fill missing regular params with null
                for (let i = numArgs; i < requiredParams; i++) {
                  this.stack[bp + i] = NULL;
                }
                // Set rest param to empty array
                this.stack[bp + requiredParams] = new MonkeyArray([]);
                this.sp = bp + requiredParams + 1;
              } else {
                // Collect extra args into rest array (args after requiredParams)
                const restElements = [];
                for (let i = requiredParams; i < numArgs; i++) {
                  restElements.push(this.stack[bp + i]);
                }
                // Place rest array after regular params
                this.stack[bp + requiredParams] = new MonkeyArray(restElements);
                this.sp = bp + requiredParams + 1;
              }
              
              const callFrame = new Frame(callee, bp);
              this.pushFrame(callFrame);
              this.sp = callFrame.basePointer + callee.fn.numLocals;
              frame = callFrame;
              break; // rest param handled — skip normal call setup
            } else if (numArgs > callee.fn.numParameters) {
              throw new Error(`wrong number of arguments: want=${callee.fn.numParameters}, got=${numArgs}`);
            }
            // Fill in missing arguments with NULL (for default parameters)
            const missingArgs = callee.fn.numParameters - numArgs;
            for (let ma = 0; ma < missingArgs; ma++) {
              this.push(NULL);
            }

            const effectiveNumArgs = numArgs + missingArgs;

            // Hot function detection (method JIT)
            if (this.jit && !recording()) {
              const funcTrace = this.jit.getFuncTrace(callee.fn);
              if (funcTrace && funcTrace.compiled) {
                try {
                  const result = this._executeFuncTrace(funcTrace, callee, effectiveNumArgs);
                  if (result && !result.exit) {
                    this.sp = this.sp - effectiveNumArgs - 1;
                    this.push(result);
                    break;
                  }
                } catch (e) {
                  this.jit.funcTraces.delete(callee.fn);
                }
              }
            }

            // If recording a function trace and this is a recursive call
            if (recording() && this.recorder.isFuncTrace &&
                callee.fn === this.recorder.tracedFn) {
              // Emit SELF_CALL IR — the compiled trace will call itself
              const argRefs = [];
              for (let i = 0; i < numArgs; i++) {
                argRefs.unshift(this.recorder.popRef());
              }
              this.recorder.popRef(); // pop the closure ref

              const ref = this.recorder.trace.addInst(IR.SELF_CALL, { args: argRefs });
              // Execute the call normally in the interpreter
              const callFrame = new Frame(callee, this.sp - numArgs);
              this.pushFrame(callFrame);
              this.sp = callFrame.basePointer + callee.fn.numLocals;
              frame = callFrame;
              // the compiled code will handle it via self-call
              this.recorder._skipDepth = (this.recorder._skipDepth || 0) + 1;
              this.recorder._skipReturnFrame = this.framesIndex; // return when we pop back to this
              // We'll push the ref when we return from this call
              this.recorder._pendingSelfCallRef = ref;
              break;
            }

            // If recording, try to inline the call into the trace
            if (recording()) {
              const rootBp = this.frames[this.recorder.startFrame - 1].basePointer;
              const calleeBp = this.sp - numArgs;
              const baseOffset = calleeBp - rootBp;

              // Guard that the callee is the same function we're about to inline
              // This prevents the trace from being used with a different closure
              const closureRef = this.recorder.peekRef(numArgs);
              if (closureRef !== undefined) {
                this.recorder.trace.addInst(IR.GUARD_CLOSURE, {
                  ref: closureRef,
                  fnId: callee.fn.id,
                  exitIp: -1, // Special: invalidate trace on mismatch
                });
                this.recorder.trace.guardCount++;
              }

              // Pop the arg refs and closure ref from IR stack — they're on the VM stack now
              // The callee will access them as locals via LOAD_LOCAL with the inlined baseOffset
              const argRefs = [];
              for (let i = 0; i < numArgs; i++) {
                argRefs.unshift(this.recorder.popRef());
              }
              this.recorder.popRef(); // pop the closure ref

              if (!this.recorder.enterInlineFrame(baseOffset, callee.fn.numLocals, ip)) {
                // Too deep — abort recording
                this._abortRecording('inline_too_deep');
              } else if (this._hasBackwardJump(callee.fn.instructions)) {
                // Function contains a loop — don't inline, too complex
                this.recorder.leaveInlineFrame();
                this._abortRecording('inline_callee_has_loop');
              } else {
                // Map the argument IR refs to the inlined frame's local slots
                // so that LOAD_LOCAL in the callee picks them up directly
                // (no STORE_LOCAL needed — avoids promotion analysis issues)
                for (let i = 0; i < numArgs; i++) {
                  this.recorder.inlineSlotRefs.set(baseOffset + i, argRefs[i]);
                }
              }
              // Continue recording into the callee — the VM pushes
              // the frame normally, and we keep recording with the new baseOffset
            }

            const callFrame = new Frame(callee, this.sp - effectiveNumArgs);
            // If this is a generator closure, set up yield collection
            if (callee._isGenerator) {
              callFrame._generatorValues = [];
            }
            this.pushFrame(callFrame);
            this.sp = callFrame.basePointer + callee.fn.numLocals;
            frame = callFrame;

            // Hot function detection — compile function directly (method JIT)
            if (this.jit && !recording() && !this.jit.getFuncTrace(callee.fn) && !this.jit.uncompilableFns.has(callee.fn)) {
              if (this.jit.countFuncCall(callee.fn)) {
                const trace = this.jit.compileFunction(callee.fn, this.constants, this);
                if (trace) {
                  this.jit.funcTraces.set(callee.fn, trace);
                  this.jit.traceCount++;
                } else {
                  // Mark as uncompilable to avoid repeated compilation attempts
                  this.jit.uncompilableFns.add(callee.fn);
                }
              }
            }
          } else if (callee instanceof MonkeyBoundMethod) {
            // Bound method call: set up closure call with self as first arg
            const args = this.stack.slice(this.sp - numArgs, this.sp);
            this.sp = this.sp - numArgs - 1; // pop args + callee
            this.push(callee.closure);        // push actual closure
            this.push(callee.instance);       // push self
            for (const arg of args) this.push(arg); // push original args
            
            const callFrame = new Frame(callee.closure, this.sp - numArgs - 1); // -1 for self
            this.pushFrame(callFrame);
            this.sp = callFrame.basePointer + callee.closure.fn.numLocals;
            frame = callFrame;
          } else if (callee instanceof MonkeyClass) {
            const instance = new MonkeyInstance(callee);
            // Initialize parent fields
            let parent = callee.superClass;
            while (parent) {
              for (const f of parent.fields) {
                if (!instance.fields.has(f)) instance.fields.set(f, NULL);
              }
              parent = parent.superClass;
            }
            
            // Find init method
            let initMethod = callee.methods.get('init');
            if (initMethod) {
              // Call init with self as first arg
              // Stack: [class, arg1, arg2, ...]
              // We need: [closure, self, arg1, arg2, ...]
              const args = this.stack.slice(this.sp - numArgs, this.sp);
              this.sp = this.sp - numArgs - 1; // pop args + class
              this.push(initMethod); // push closure
              this.push(instance);   // push self
              for (const arg of args) this.push(arg); // push original args
              
              // Call the init closure
              if (initMethod instanceof Closure) {
                const callFrame = new Frame(initMethod, this.sp - numArgs - 1); // -1 for self
                callFrame._classInstance = instance; // so OpReturn knows to return instance
                this.pushFrame(callFrame);
                this.sp = callFrame.basePointer + initMethod.fn.numLocals;
                frame = callFrame;
              }
            } else {
              // No init — just return instance
              this.sp = this.sp - numArgs - 1;
              this.push(instance);
            }
          } else if (callee instanceof MonkeyBuiltin) {
            // Identify which builtin this is
            const builtinIdx = BUILTINS.indexOf(callee);

            if (recording() && builtinIdx === 0 && numArgs === 1) {
              // len(x) — inline as BUILTIN_LEN
              const argRef = this.recorder.popRef();
              this.recorder.popRef(); // pop the builtin ref
              const ref = this.recorder.trace.addInst(IR.BUILTIN_LEN, { ref: argRef });
              this.recorder.typeMap.set(ref, 'raw_int');
              this.recorder.pushRef(ref);
              // Execute normally
              const args = this.stack.slice(this.sp - numArgs, this.sp);
              const result = callee.fn(...args);
              this.sp = this.sp - numArgs - 1;
              this.push(result !== undefined ? result : NULL);
            } else if (recording() && builtinIdx === 5 && numArgs === 2) {
              // push(arr, val) — inline as BUILTIN_PUSH
              const valRef = this.recorder.popRef();
              const arrRef = this.recorder.popRef();
              this.recorder.popRef(); // pop the builtin ref
              const ref = this.recorder.trace.addInst(IR.BUILTIN_PUSH, { array: arrRef, value: valRef });
              this.recorder.typeMap.set(ref, 'object');
              this.recorder.pushRef(ref);
              // Execute normally
              const args = this.stack.slice(this.sp - numArgs, this.sp);
              const result = callee.fn(...args);
              this.sp = this.sp - numArgs - 1;
              this.push(result !== undefined ? result : NULL);
            } else {
              if (recording()) { this._abortRecording('builtin_call'); }
              const args = this.stack.slice(this.sp - numArgs, this.sp);
              const result = callee.fn(...args);
              this.sp = this.sp - numArgs - 1;
              this.push(result !== undefined ? result : NULL);
            }
          } else {
            throw new Error(`calling non-function/non-builtin: got ${callee?.constructor?.name || typeof callee} (sp=${this.sp}, bp=${frame.basePointer})`);
          }
          break;
        }

        case Opcodes.OpReturnValue: {
          const returnValue = this.pop();

          // Handle return from skipped recursive call during function trace recording
          if (this.recorder && this.recorder.recording && this.recorder._skipDepth > 0) {
            const retFrame = this.popFrame();
            this.sp = retFrame.basePointer - 1;
            this.push(returnValue);
            frame = this.currentFrame();
            // Only resume recording when we've popped back to the right frame
            if (this.framesIndex < this.recorder._skipReturnFrame) {
              this.recorder._skipDepth--;
              if (this.recorder._skipDepth === 0 && this.recorder._pendingSelfCallRef !== undefined) {
                // Push the self-call ref as the result
                this.recorder.pushRef(this.recorder._pendingSelfCallRef);
                this.recorder._pendingSelfCallRef = undefined;
              }
            }
            break;
          }

          // Handle return from function trace recording (not inlined — at root frame)
          if (recording() && this.recorder.isFuncTrace &&
              this.recorder.inlineDepth === 0 &&
              this.framesIndex === this.recorder.startFrame) {
            // Emit FUNC_RETURN and stop recording
            const retRef = this.recorder.popRef();
            this.recorder.trace.addInst(IR.FUNC_RETURN, { ref: retRef });
            const trace = this.recorder.stop();
            if (trace && this.jit && this.jit.compile(trace, this)) {
              this.jit.storeFuncTrace(trace);
            }
            this.recorder = null;
            // Normal return
            const retFrame = this.popFrame();
            this.sp = retFrame.basePointer - 1;
            this.push(returnValue);
            frame = this.currentFrame();
            break;
          }

          if (recording() && this.recorder.inlineDepth > 0) {
            // Returning from an inlined function — don't stop recording
            const retRef = this.recorder.popRef();
            this.recorder.leaveInlineFrame();
            // Pop the frame, restore sp, push return value
            const retFrame = this.popFrame();
            this.sp = retFrame.basePointer - 1; // -1 to also pop the function itself
            this.push(returnValue);
            frame = this.currentFrame();
            // Push the return value's IR ref back for the caller to use
            this.recorder.pushRef(retRef);
            break;
          }

          const retFrame = this.popFrame();
          this.sp = retFrame.basePointer - 1; // -1 to also pop the function itself
          // If returning from a generator, push MonkeyGenerator instead of return value
          if (retFrame._generatorValues) {
            this.push(new MonkeyGenerator(retFrame._generatorValues));
          } else if (retFrame._classInstance) {
            // Returning from init — push the instance, not the return value
            this.push(retFrame._classInstance);
          } else {
            this.push(returnValue);
          }
          frame = this.currentFrame();
          break;
        }

        case Opcodes.OpReturn: {
          // Handle return from skipped recursive call (return NULL)
          if (this.recorder && this.recorder.recording && this.recorder._skipDepth > 0) {
            const frame2 = this.popFrame();
            this.sp = frame2.basePointer - 1;
            this.push(NULL);
            frame = this.currentFrame();
            if (this.framesIndex < this.recorder._skipReturnFrame) {
              this.recorder._skipDepth--;
              if (this.recorder._skipDepth === 0 && this.recorder._pendingSelfCallRef !== undefined) {
                this.recorder.pushRef(this.recorder._pendingSelfCallRef);
                this.recorder._pendingSelfCallRef = undefined;
              }
            }
            break;
          }

          // Handle return from function trace recording (return NULL)
          if (recording() && this.recorder.isFuncTrace &&
              this.recorder.inlineDepth === 0 &&
              this.framesIndex === this.recorder.startFrame) {
            const nullRef = this.recorder.trace.addInst(IR.CONST_NULL);
            this.recorder.trace.addInst(IR.FUNC_RETURN, { ref: nullRef });
            const trace = this.recorder.stop();
            if (trace && this.jit && this.jit.compile(trace, this)) {
              this.jit.storeFuncTrace(trace);
            }
            this.recorder = null;
            const frame2 = this.popFrame();
            this.sp = frame2.basePointer - 1;
            this.push(NULL);
            frame = this.currentFrame();
            break;
          }

          if (recording() && this.recorder.inlineDepth > 0) {
            // Returning NULL from an inlined function
            this.recorder.leaveInlineFrame();
            const frame2 = this.popFrame();
            this.sp = frame2.basePointer - 1;
            this.push(NULL);
            frame = this.currentFrame();
            const nullRef = this.recorder.trace.addInst(IR.CONST_NULL);
            this.recorder.typeMap.set(nullRef, 'null');
            this.recorder.pushRef(nullRef);
            break;
          }

          const frame2 = this.popFrame();
          this.sp = frame2.basePointer - 1;
          if (frame2._generatorValues) {
            this.push(new MonkeyGenerator(frame2._generatorValues));
          } else if (frame2._classInstance) {
            this.push(frame2._classInstance);
          } else {
            this.push(NULL);
          }
          frame = this.currentFrame();
          break;
        }

        case Opcodes.OpClosure: {
          const constIdx2 = (ins[ip + 1] << 8) | ins[ip + 2];
          const numFree = ins[ip + 3];
          frame.ip += 3;

          const fn = this.constants[constIdx2];
          const free = new Array(numFree);
          for (let i = 0; i < numFree; i++) {
            free[i] = this.stack[this.sp - numFree + i];
          }
          this.sp -= numFree;
          const closure = new Closure(fn, free);
          this.push(closure);

          if (recording()) {
            // Pop the free variable refs from IR stack
            for (let i = 0; i < numFree; i++) {
              this.recorder.popRef();
            }
            // Record the closure as a constant object
            const closureRef = this.recorder.trace.addInst(IR.CONST_OBJ, {
              constIdx: this._ensureTraceConst(closure)
            });
            this.recorder.typeMap.set(closureRef, 'object');
            this.recorder.pushRef(closureRef);
          }
          break;
        }

        case Opcodes.OpGetFree: {
          const freeIdx = ins[ip + 1];
          frame.ip += 1;
          const freeVal = frame.closure.free[freeIdx];
          this.push(freeVal);
          if (recording()) {
            if (this.recorder.inlineDepth > 0) {
              // Inside an inlined closure — free vars belong to the inlined closure,
              // not the root trace's closure. Emit the value as a constant since
              // Monkey closures capture by value (free vars don't change).
              this._recordPushAsConst(freeVal);
            } else {
              this._recordPush(op, freeVal, [freeIdx]);
            }
          }
          break;
        }

        case Opcodes.OpSetFree: {
          const freeIdx2 = ins[ip + 1];
          frame.ip += 1;
          frame.closure.free[freeIdx2] = this.pop();
          if (recording()) {
            this._abortRecording('OpSetFree not JIT-compiled');
          }
          break;
        }

        case Opcodes.OpSetIndex: {
          const val = this.pop();
          const index = this.pop();
          const obj = this.pop();
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
            obj.set(index.value, val);
          }
          this.push(val);
          if (recording()) {
            this._abortRecording('OpSetIndex not JIT-compiled');
          }
          break;
        }

        case Opcodes.OpSlice: {
          const end = this.pop();
          const start = this.pop();
          const obj = this.pop();
          if (obj instanceof MonkeyArray) {
            const len = obj.elements.length;
            let s = (start === NULL) ? 0 : start.value;
            let e = (end === NULL) ? len : end.value;
            if (s < 0) s += len;
            if (e < 0) e += len;
            if (s < 0) s = 0;
            if (e > len) e = len;
            this.push(new MonkeyArray(obj.elements.slice(s, e)));
          } else if (obj instanceof MonkeyString) {
            const len = obj.value.length;
            let s = (start === NULL) ? 0 : start.value;
            let e = (end === NULL) ? len : end.value;
            if (s < 0) s += len;
            if (e < 0) e += len;
            if (s < 0) s = 0;
            if (e > len) e = len;
            this.push(new MonkeyString(obj.value.slice(s, e)));
          } else {
            this.push(NULL);
          }
          if (recording()) {
            this._abortRecording('OpSlice not JIT-compiled');
          }
          break;
        }

        case Opcodes.OpTypeCheck: {
          const localIdx = ins[ip + 1];
          const typeIdx = (ins[ip + 2] << 8) | ins[ip + 3];
          frame.ip += 3;
          const val = this.stack[frame.basePointer + localIdx];
          const typeName = this.constants[typeIdx];
          let ok = false;
          switch (typeName) {
            case 'int': ok = val instanceof MonkeyInteger; break;
            case 'bool': ok = val instanceof MonkeyBoolean; break;
            case 'string': ok = val instanceof MonkeyString; break;
            case 'array': ok = val instanceof MonkeyArray; break;
            case 'hash': ok = val instanceof MonkeyHash; break;
            case 'fn': ok = val instanceof Closure || val instanceof MonkeyFunction || val instanceof MonkeyBuiltin; break;
            case 'null': ok = val === NULL; break;
            case 'Ok': ok = val instanceof MonkeyResult && val.isOk; break;
            case 'Err': ok = val instanceof MonkeyResult && !val.isOk; break;
            default: ok = true; // unknown type — skip check
          }
          if (!ok) {
            const actualType = val === NULL ? 'null' : val.constructor.name.replace('Monkey', '').toLowerCase();
            throw new Error(`Type error: expected ${typeName}, got ${actualType}`);
          }
          // JIT: type annotations mean we can skip guards for these params
          if (recording()) {
            // Register this slot as having a trusted type
            const absSlot = this.recorder.currentBaseOffset() + localIdx;
            this.recorder.trustedTypes.set(absSlot, typeName);
          }
          break;
        }

        case Opcodes.OpTypeIs: {
          const typeIdx8 = (ins[ip + 1] << 8) | ins[ip + 2];
          frame.ip += 2;
          const val8 = this.pop();
          const typeName8 = this.constants[typeIdx8];
          let ok8 = false;
          switch (typeName8) {
            case 'int': ok8 = val8 instanceof MonkeyInteger; break;
            case 'bool': ok8 = val8 instanceof MonkeyBoolean; break;
            case 'string': ok8 = val8 instanceof MonkeyString; break;
            case 'array': ok8 = val8 instanceof MonkeyArray; break;
            case 'hash': ok8 = val8 instanceof MonkeyHash; break;
            case 'fn': ok8 = val8 instanceof Closure || val8 instanceof MonkeyFunction || val8 instanceof MonkeyBuiltin; break;
            case 'null': ok8 = val8 === NULL; break;
            case 'Ok': ok8 = val8 instanceof MonkeyResult && val8.isOk; break;
            case 'Err': ok8 = val8 instanceof MonkeyResult && !val8.isOk; break;
            default: ok8 = false;
          }
          this.push(ok8 ? TRUE : FALSE);
          if (recording()) {
            this._abortRecording('OpTypeIs not JIT-compiled');
          }
          break;
        }

        case Opcodes.OpResultValue: {
          const rv = this.pop();
          if (rv instanceof MonkeyResult) {
            this.push(rv.value);
          } else {
            this.push(NULL);
          }
          break;
        }

        case Opcodes.OpTry: {
          const catchAddr = (ins[ip + 1] << 8) | ins[ip + 2];
          const finallyAddr = (ins[ip + 3] << 8) | ins[ip + 4];
          frame.ip += 4;
          // Push an exception handler onto the handler stack
          if (!this.handlerStack) this.handlerStack = [];
          this.handlerStack.push({
            frameIndex: this.framesIndex - 1,
            catchAddr,
            finallyAddr,
            sp: this.sp,
          });
          break;
        }

        case Opcodes.OpPopHandler: {
          if (this.handlerStack && this.handlerStack.length > 0) {
            this.handlerStack.pop();
          }
          break;
        }

        case Opcodes.OpThrow: {
          const thrownValue = this.pop();
          this._vmThrow(thrownValue);
          frame = this.frames[this.framesIndex - 1];
          break;
        }

        case Opcodes.OpYield: {
          // Pop value from stack and add to nearest generator frame's collection
          const yieldedValue = this.pop();
          // Walk up the frame stack to find the generator frame
          for (let fi = this.framesIndex - 1; fi >= 0; fi--) {
            if (this.frames[fi]._generatorValues) {
              this.frames[fi]._generatorValues.push(yieldedValue);
              break;
            }
          }
          this.push(NULL); // yield expression evaluates to null
          break;
        }

        case Opcodes.OpMakeGenerator: {
          // Pop closure from stack, mark it as a generator and push back
          const genClosure = this.pop();
          genClosure._isGenerator = true;
          this.push(genClosure);
          break;
        }

        case Opcodes.OpClass: {
          const numMethods = (ins[ip + 1] << 8) | ins[ip + 2];
          const numFields = (ins[ip + 3] << 8) | ins[ip + 4];
          frame.ip += 4;
          
          // Pop methods (name + closure pairs) in reverse
          const methods = new Map();
          for (let i = 0; i < numMethods; i++) {
            const closure = this.stack[this.sp - 1 - i * 2];
            const methodName = this.stack[this.sp - 2 - i * 2];
            methods.set(methodName.value, closure);
          }
          this.sp -= numMethods * 2;
          
          // Pop field names in reverse
          const fields = [];
          for (let i = 0; i < numFields; i++) {
            fields.unshift(this.stack[this.sp - 1 - i].value);
          }
          this.sp -= numFields;
          
          // Pop class name
          const className = this.pop();
          
          // Create MonkeyClass (no super class support in VM yet)
          const klass = new MonkeyClass(className.value, methods, fields, null, null);
          this.push(klass);
          break;
        }

        case Opcodes.OpCurrentClosure:
          this.push(frame.closure);
          if (recording()) {
            // Record the closure as an opaque constant object
            // The trace will just push the same closure value
            const closureRef = this.recorder.trace.addInst(IR.CONST_OBJ, {
              constIdx: this._ensureTraceConst(frame.closure)
            });
            this.recorder.typeMap.set(closureRef, 'object');
            this.recorder.pushRef(closureRef);
          }
          break;

        case Opcodes.OpGetBuiltin: {
          const builtinIdx = ins[ip + 1];
          frame.ip += 1;
          this.push(BUILTINS[builtinIdx]);
          if (recording()) {
            // Builtins are opaque objects — record as const
            const ref = this.recorder.trace.addInst(IR.CONST_OBJ, {
              constIdx: this._ensureTraceConst(BUILTINS[builtinIdx])
            });
            this.recorder.typeMap.set(ref, 'object');
            this.recorder.pushRef(ref);
          }
          break;
        }

        case Opcodes.OpAddConst:
        case Opcodes.OpSubConst:
        case Opcodes.OpMulConst:
        case Opcodes.OpModConst:
        case Opcodes.OpDivConst: {
          const constIdx3 = (ins[ip + 1] << 8) | ins[ip + 2];
          frame.ip += 2;
          const left4 = this.pop();
          const right4 = this.constants[constIdx3];

          if (left4 instanceof MonkeyInteger && right4 instanceof MonkeyInteger) {
            if (recording()) {
              // Left ref is already on IR stack from prior push opcode
              // Add const ref for right, then recordIntArith pops both
              const constRef = this.recorder.trace.addInst(IR.CONST_INT, { value: right4.value });
              this.recorder.typeMap.set(constRef, 'raw_int');
              this.recorder.pushRef(constRef);
              this.recorder.recordIntArith(op, left4, right4);
            }
            let result;
            switch (op) {
              case Opcodes.OpAddConst: result = left4.value + right4.value; break;
              case Opcodes.OpSubConst: result = left4.value - right4.value; break;
              case Opcodes.OpMulConst: result = left4.value * right4.value; break;
              case Opcodes.OpDivConst: result = Math.trunc(left4.value / right4.value); break;
              case Opcodes.OpModConst: result = left4.value % right4.value; break;
            }
            this.push(cachedInteger(result));
          } else if ((left4 instanceof MonkeyFloat || right4 instanceof MonkeyFloat) &&
                     (left4 instanceof MonkeyInteger || left4 instanceof MonkeyFloat) &&
                     (right4 instanceof MonkeyInteger || right4 instanceof MonkeyFloat)) {
            if (recording()) { this._abortRecording('float constant op'); }
            const lv = left4.value, rv = right4.value;
            let result;
            switch (op) {
              case Opcodes.OpAddConst: result = lv + rv; break;
              case Opcodes.OpSubConst: result = lv - rv; break;
              case Opcodes.OpMulConst: result = lv * rv; break;
              case Opcodes.OpDivConst: result = lv / rv; break;
              case Opcodes.OpModConst: result = lv % rv; break;
            }
            this.push(new MonkeyFloat(result));
          } else if (left4 instanceof MonkeyString && right4 instanceof MonkeyString && op === Opcodes.OpAddConst) {
            if (recording()) {
              // For OpAddConst, only left is on recorder stack. Push const for right first.
              const constRef = this.recorder.trace.addInst(IR.CONST_OBJ, { constIdx: constIdx3 });
              this.recorder.typeMap.set(constRef, 'string');
              // Now: recorder stack has [... leftRef]. We pop left and use constRef for right.
              const lRef = this.recorder.popRef();
              if (this.recorder.knownType(lRef) !== 'string' && this.recorder.knownType(lRef) !== 'raw_string') this.recorder.guardType(lRef, left4);
              // Unbox to raw strings
              let lRaw = lRef;
              if (this.recorder.knownType(lRef) !== 'raw_string') {
                lRaw = this.recorder.trace.addInst(IR.UNBOX_STRING, { ref: lRef });
                this.recorder.typeMap.set(lRaw, 'raw_string');
              }
              let rRaw = constRef;
              if (this.recorder.knownType(constRef) !== 'raw_string') {
                rRaw = this.recorder.trace.addInst(IR.UNBOX_STRING, { ref: constRef });
                this.recorder.typeMap.set(rRaw, 'raw_string');
              }
              const concatRef = this.recorder.trace.addInst(IR.CONCAT, { left: lRaw, right: rRaw });
              this.recorder.typeMap.set(concatRef, 'raw_string');
              const boxedRef = this.recorder.trace.addInst(IR.BOX_STRING, { ref: concatRef });
              this.recorder.typeMap.set(boxedRef, 'string');
              this.recorder.pushRef(boxedRef);
            }
            this.push(new MonkeyString(left4.value + right4.value));
          } else if (left4 instanceof MonkeyString && right4 instanceof MonkeyInteger && op === Opcodes.OpMulConst) {
            if (recording()) {
              this.recorder.popRef();
              this._abortRecording('string multiplication not JIT-compiled');
            }
            const n = right4.value;
            this.push(new MonkeyString(n > 0 ? left4.value.repeat(n) : ''));
          } else if (left4 instanceof MonkeyInteger && right4 instanceof MonkeyString && op === Opcodes.OpMulConst) {
            if (recording()) {
              this.recorder.popRef();
              this._abortRecording('string multiplication not JIT-compiled');
            }
            const n = left4.value;
            this.push(new MonkeyString(n > 0 ? right4.value.repeat(n) : ''));
          } else {
            throw new Error(`unsupported types for constant op: ${left4.type()} and ${right4.type()}`);
          }
          break;
        }

        // Superinstructions: fused OpGetLocal + Op*Const
        case Opcodes.OpGetLocalAddConst:
        case Opcodes.OpGetLocalSubConst:
        case Opcodes.OpGetLocalMulConst:
        case Opcodes.OpGetLocalDivConst: {
          const localIdx3 = ins[ip + 1];
          const constIdx4 = (ins[ip + 2] << 8) | ins[ip + 3];
          frame.ip += 3;
          const leftVal = this.stack[frame.basePointer + localIdx3];
          const rightVal = this.constants[constIdx4];

          if (leftVal instanceof MonkeyInteger && rightVal instanceof MonkeyInteger) {
            if (recording()) {
              // Decompose superinstruction into IR: load local, const, arith
              const absSlot = this.recorder.currentBaseOffset() + localIdx3;
              const inlineRef = this.recorder.inlineSlotRefs.get(absSlot);
              let localRef;
              if (inlineRef !== undefined) {
                localRef = inlineRef;
              } else {
                localRef = this.recorder.trace.addInst(IR.LOAD_LOCAL, { slot: absSlot });
              }
              this.recorder.trackLocalLoad(absSlot, localRef);
              this.recorder.pushRef(localRef);
              const constRef = this.recorder.trace.addInst(IR.CONST_INT, { value: rightVal.value });
              this.recorder.typeMap.set(constRef, 'raw_int');
              this.recorder.pushRef(constRef);
              // Map superinstruction to base arith opcode for recordIntArith
              const baseOp = op === Opcodes.OpGetLocalAddConst ? Opcodes.OpAdd
                : op === Opcodes.OpGetLocalSubConst ? Opcodes.OpSub
                : op === Opcodes.OpGetLocalMulConst ? Opcodes.OpMul
                : Opcodes.OpDiv;
              this.recorder.recordIntArith(baseOp, leftVal, rightVal);
            }
            let result;
            switch (op) {
              case Opcodes.OpGetLocalAddConst: result = leftVal.value + rightVal.value; break;
              case Opcodes.OpGetLocalSubConst: result = leftVal.value - rightVal.value; break;
              case Opcodes.OpGetLocalMulConst: result = leftVal.value * rightVal.value; break;
              case Opcodes.OpGetLocalDivConst: result = Math.trunc(leftVal.value / rightVal.value); break;
            }
            this.push(cachedInteger(result));
          } else if (leftVal instanceof MonkeyString && rightVal instanceof MonkeyString && op === Opcodes.OpGetLocalAddConst) {
            if (recording()) { this._abortRecording('string_concat_localconst'); }
            this.push(new MonkeyString(leftVal.value + rightVal.value));
          } else {
            throw new Error(`unsupported types for local+const op: ${leftVal.type()} and ${rightVal.type()}`);
          }
          break;
        }

        // Integer-specialized opcodes: skip instanceof checks for the fast path.
        // If quickened (not compiler-emitted), deopt back to generic on type mismatch.
        // Integer-specialized opcodes with inlined stack operations.
        // Direct stack[] access avoids this.pop()/this.push() method call overhead.
        case Opcodes.OpAddInt: {
          const r = this.stack[--this.sp];
          const l = this.stack[--this.sp];
          if (!(l instanceof MonkeyInteger) || !(r instanceof MonkeyInteger)) {
            ins[ip] = Opcodes.OpAdd;
            this.stack[this.sp++] = l; this.stack[this.sp++] = r;
            frame.ip--;
            break;
          }
          if (recording()) { this.recorder.recordIntArith(op, l, r); }
          this.stack[this.sp++] = cachedInteger(l.value + r.value);
          break;
        }

        case Opcodes.OpSubInt: {
          const r = this.stack[--this.sp];
          const l = this.stack[--this.sp];
          if (!(l instanceof MonkeyInteger) || !(r instanceof MonkeyInteger)) {
            ins[ip] = Opcodes.OpSub;
            this.stack[this.sp++] = l; this.stack[this.sp++] = r;
            frame.ip--;
            break;
          }
          if (recording()) { this.recorder.recordIntArith(op, l, r); }
          this.stack[this.sp++] = cachedInteger(l.value - r.value);
          break;
        }

        case Opcodes.OpMulInt: {
          const r = this.stack[--this.sp];
          const l = this.stack[--this.sp];
          if (!(l instanceof MonkeyInteger) || !(r instanceof MonkeyInteger)) {
            ins[ip] = Opcodes.OpMul;
            this.stack[this.sp++] = l; this.stack[this.sp++] = r;
            frame.ip--;
            break;
          }
          if (recording()) { this.recorder.recordIntArith(op, l, r); }
          this.stack[this.sp++] = cachedInteger(l.value * r.value);
          break;
        }

        case Opcodes.OpDivInt: {
          const r = this.stack[--this.sp];
          const l = this.stack[--this.sp];
          if (!(l instanceof MonkeyInteger) || !(r instanceof MonkeyInteger)) {
            ins[ip] = Opcodes.OpDiv;
            this.stack[this.sp++] = l; this.stack[this.sp++] = r;
            frame.ip--;
            break;
          }
          if (recording()) { this.recorder.recordIntArith(op, l, r); }
          this.stack[this.sp++] = cachedInteger(Math.trunc(l.value / r.value));
          break;
        }

        case Opcodes.OpModInt: {
          const r = this.stack[--this.sp];
          const l = this.stack[--this.sp];
          if (!(l instanceof MonkeyInteger) || !(r instanceof MonkeyInteger)) {
            ins[ip] = Opcodes.OpMod;
            this.stack[this.sp++] = l; this.stack[this.sp++] = r;
            frame.ip--;
            break;
          }
          if (recording()) { this.recorder.recordIntArith(op, l, r); }
          this.stack[this.sp++] = cachedInteger(l.value % r.value);
          break;
        }

        case Opcodes.OpGreaterThanInt: {
          const r = this.stack[--this.sp];
          const l = this.stack[--this.sp];
          if (!(l instanceof MonkeyInteger) || !(r instanceof MonkeyInteger)) {
            ins[ip] = Opcodes.OpGreaterThan;
            this.stack[this.sp++] = l; this.stack[this.sp++] = r;
            frame.ip--;
            break;
          }
          if (recording()) { this.recorder.recordComparison(op, l, r); }
          this.stack[this.sp++] = (l.value > r.value ? TRUE : FALSE);
          break;
        }

        case Opcodes.OpLessThanInt: {
          const r = this.stack[--this.sp];
          const l = this.stack[--this.sp];
          if (!(l instanceof MonkeyInteger) || !(r instanceof MonkeyInteger)) {
            throw new Error(`unsupported types for LessThanInt: ${l.type()} and ${r.type()}`);
          }
          if (recording()) { this.recorder.recordComparison(op, l, r); }
          this.stack[this.sp++] = (l.value < r.value ? TRUE : FALSE);
          break;
        }

        case Opcodes.OpEqualInt: {
          const r = this.stack[--this.sp];
          const l = this.stack[--this.sp];
          if (!(l instanceof MonkeyInteger) || !(r instanceof MonkeyInteger)) {
            ins[ip] = Opcodes.OpEqual;
            this.stack[this.sp++] = l; this.stack[this.sp++] = r;
            frame.ip--;
            break;
          }
          if (recording()) { this.recorder.recordComparison(op, l, r); }
          this.stack[this.sp++] = (l.value === r.value ? TRUE : FALSE);
          break;
        }

        case Opcodes.OpNotEqualInt: {
          const r = this.stack[--this.sp];
          const l = this.stack[--this.sp];
          if (!(l instanceof MonkeyInteger) || !(r instanceof MonkeyInteger)) {
            ins[ip] = Opcodes.OpNotEqual;
            this.stack[this.sp++] = l; this.stack[this.sp++] = r;
            frame.ip--;
            break;
          }
          if (recording()) { this.recorder.recordComparison(op, l, r); }
          this.stack[this.sp++] = (l.value !== r.value ? TRUE : FALSE);
          break;
        }

        case Opcodes.OpSetFree: {
          const fIdx = ins[ip + 1];
          frame.ip += 1;
          frame.closure.free[fIdx] = this.stack[--this.sp];
          break;
        }

        case Opcodes.OpSetIndex: {
          const val5 = this.stack[--this.sp];
          const idx5 = this.stack[--this.sp];
          const obj5 = this.stack[--this.sp];
          if (obj5 instanceof MonkeyArray && idx5 instanceof MonkeyInteger) {
            let i5 = idx5.value;
            if (i5 < 0) i5 += obj5.elements.length;
            if (i5 >= 0 && i5 < obj5.elements.length) obj5.elements[i5] = val5;
          } else if (obj5 instanceof MonkeyHash && idx5.fastHashKey) {
            obj5.pairs.set(idx5.fastHashKey(), { key: idx5, value: val5 });
          }
          this.stack[this.sp++] = val5;
          break;
        }

        case Opcodes.OpSlice: {
          const end5 = this.stack[--this.sp];
          const start5 = this.stack[--this.sp];
          const obj6 = this.stack[--this.sp];
          if (obj6 instanceof MonkeyArray) {
            const len5 = obj6.elements.length;
            let s5 = (start5 === NULL) ? 0 : start5.value;
            let e5 = (end5 === NULL) ? len5 : end5.value;
            if (s5 < 0) s5 += len5; if (e5 < 0) e5 += len5;
            if (s5 < 0) s5 = 0; if (e5 > len5) e5 = len5;
            this.stack[this.sp++] = new MonkeyArray(obj6.elements.slice(s5, e5));
          } else if (obj6 instanceof MonkeyString) {
            const len5 = obj6.value.length;
            let s5 = (start5 === NULL) ? 0 : start5.value;
            let e5 = (end5 === NULL) ? len5 : end5.value;
            if (s5 < 0) s5 += len5; if (e5 < 0) e5 += len5;
            if (s5 < 0) s5 = 0; if (e5 > len5) e5 = len5;
            this.stack[this.sp++] = new MonkeyString(obj6.value.slice(s5, e5));
          } else {
            this.stack[this.sp++] = NULL;
          }
          break;
        }

        case Opcodes.OpTypeCheck: {
          const localIdx7 = ins[ip + 1];
          const typeIdx7 = (ins[ip + 2] << 8) | ins[ip + 3];
          frame.ip += 3;
          const val7 = this.stack[frame.basePointer + localIdx7];
          const typeName7 = this.constants[typeIdx7];
          let ok7 = false;
          switch (typeName7) {
            case 'int': ok7 = val7 instanceof MonkeyInteger; break;
            case 'bool': ok7 = val7 instanceof MonkeyBoolean; break;
            case 'string': ok7 = val7 instanceof MonkeyString; break;
            case 'array': ok7 = val7 instanceof MonkeyArray; break;
            case 'hash': ok7 = val7 instanceof MonkeyHash; break;
            case 'fn': ok7 = val7 instanceof Closure || val7 instanceof MonkeyFunction || val7 instanceof MonkeyBuiltin; break;
            case 'null': ok7 = val7 === NULL; break;
            case 'Ok': ok7 = val7 instanceof MonkeyResult && val7.isOk; break;
            case 'Err': ok7 = val7 instanceof MonkeyResult && !val7.isOk; break;
            default: ok7 = true;
          }
          if (!ok7) {
            const actualType7 = val7 === NULL ? 'null' : val7.constructor.name.replace('Monkey', '').toLowerCase();
            throw new Error(`Type error: expected ${typeName7}, got ${actualType7}`);
          }
          break;
        }

        case Opcodes.OpTypeIs: {
          const typeIdx9 = (ins[ip + 1] << 8) | ins[ip + 2];
          frame.ip += 2;
          const val9 = this.stack[--this.sp];
          const typeName9 = this.constants[typeIdx9];
          let ok9 = false;
          switch (typeName9) {
            case 'int': ok9 = val9 instanceof MonkeyInteger; break;
            case 'bool': ok9 = val9 instanceof MonkeyBoolean; break;
            case 'string': ok9 = val9 instanceof MonkeyString; break;
            case 'array': ok9 = val9 instanceof MonkeyArray; break;
            case 'hash': ok9 = val9 instanceof MonkeyHash; break;
            case 'fn': ok9 = val9 instanceof Closure || val9 instanceof MonkeyFunction || val9 instanceof MonkeyBuiltin; break;
            case 'null': ok9 = val9 === NULL; break;
            case 'Ok': ok9 = val9 instanceof MonkeyResult && val9.isOk; break;
            case 'Err': ok9 = val9 instanceof MonkeyResult && !val9.isOk; break;
            default: ok9 = false;
          }
          this.stack[this.sp++] = ok9 ? TRUE : FALSE;
          break;
        }

        default:
          throw new Error(`unknown opcode: ${op}`);
      }
    }
  }

  isTruthy(obj) {
    if (obj instanceof MonkeyBoolean) return obj.value;
    if (obj === NULL) return false;
    return true;
  }

  // --- JIT Integration ---

  // Store a runtime object as a trace constant, returning its index
  // Used for closures and other objects that don't exist in the bytecode constant pool
  _ensureTraceConst(obj) {
    let idx = this._traceConsts.indexOf(obj);
    if (idx === -1) {
      idx = this._traceConsts.length;
      this._traceConsts.push(obj);
    }
    // Offset by constants.length so it doesn't collide with bytecode constants
    return this.constants.length + idx;
  }

  // Get a stable identity for the current closure (for trace keying)
  _hasBackwardJump(instructions) {
    // Quick scan for backward jumps (OpJump followed by target < current position)
    const OpJump = Opcodes.OpJump;
    for (let i = 0; i < instructions.length - 2; i++) {
      if (instructions[i] === OpJump) {
        const target = (instructions[i + 1] << 8) | instructions[i + 2];
        if (target <= i) return true;
        i += 2; // skip operand
      }
    }
    return false;
  }

  _closureId() {
    return this.currentFrame().closure.fn.id;
  }

  // Execute a compiled trace, returns true if trace ran (even if it exited)
  _executeTrace(trace) {
    const frame = this.currentFrame();
    const allConsts = this._traceConsts.length > 0
      ? [...this.constants, ...this._traceConsts]
      : this.constants;

    // Iterative loop: side trace → loop_back → re-enter parent
    let currentTrace = trace;
    for (;;) {
      const result = currentTrace.compiled(
        this.stack, this.sp, frame.basePointer,
        this.globals, allConsts, frame.closure.free,
        MonkeyInteger, MonkeyBoolean, MonkeyString, MonkeyArray,
        TRUE, FALSE, NULL,
        cachedInteger,
        internString,
        this.isTruthy,
        trace.sideTraces,
      );
      currentTrace.executionCount++;

      if (!result) return false;

      const traceKey = `${trace.frameId}:${trace.startIp}`;
      switch (result.exit) {
        case 'guard_falsy':
        case 'guard_truthy':
        case 'guard': {
          // Guard failed and no side trace was available inline
          // (side trace dispatch is now handled in compiled code)
          
          // Check if the guard's snapshot had operand stack entries.
          // The trace's __wb already wrote back promoted vars to globals/locals.
          // If there were stack values, the mid-trace exit IP requires correct
          // operand stack state which is hard to restore. Instead, restart from
          // the trace's loop header where the stack is always empty.
          const guardInst = trace.ir ? trace.ir[result.guardIdx] : null;
          const hasStackValues = guardInst && guardInst.snapshot && 
                                 guardInst.snapshot.irStack && guardInst.snapshot.irStack.length > 0;
          
          if (hasStackValues) {
            // Restart from trace start (loop header) — stack is empty there.
            // __wb already ensured globals reflect the state at the guard point.
            frame.ip = trace.startIp - 1;
            this.sp = frame.basePointer + frame.closure.fn.numLocals;
          } else {
            // No stack values — safe to resume at the guard's exit IP
            if (result.ip !== undefined) {
              frame.ip = result.ip - 1;
            }
            // Restore state from snapshot if available
            if (result.snapshot) {
              if (result.snapshot.globals) {
                for (const [idx, value] of Object.entries(result.snapshot.globals)) {
                  this.globals[Number(idx)] = value;
                }
              }
              if (result.snapshot.locals) {
                for (const [slot, value] of Object.entries(result.snapshot.locals)) {
                  this.stack[frame.basePointer + Number(slot)] = value;
                }
              }
            }
          }

          {
            const newCount = (trace.sideExits.get(result.guardIdx) || 0) + 1;
            trace.sideExits.set(result.guardIdx, newCount);
            if (JIT_EVENTS_FULL) {
              process.stderr.write(JSON.stringify({
                v: 1, t: 'trace_exit', key: traceKey, exit: result.exit,
                guard_idx: result.guardIdx, side_exit_count: newCount,
              }) + '\n');
            }
          }

          if (!hasStackValues && this.jit && !this.recorder && this.jit.shouldRecordSideTrace(trace, result.guardIdx)) {
            if (JIT_EVENTS_FULL) {
              process.stderr.write(JSON.stringify({
                v: 1, t: 'side_trace_promote', parent: traceKey, guard_idx: result.guardIdx,
              }) + '\n');
            }
            this._startSideTraceRecording(trace, result.guardIdx, result.ip);
          }
          return true;
        }
        case 'loop_back':
          if (JIT_EVENTS_FULL) {
            process.stderr.write(JSON.stringify({ v: 1, t: 'trace_exit', key: traceKey, exit: 'loop_back' }) + '\n');
          }
          return true;
        case 'invalidate':
          // Guard closure mismatch — delete this trace so a new one will be recorded
          // Compute the trace key to delete it from the trace map
          for (const [key, t] of this.jit.traces) {
            if (t === trace) { this.jit.traces.delete(key); break; }
          }
          frame.ip = trace.startIp - 1;
          if (JIT_EVENTS_FULL) {
            process.stderr.write(JSON.stringify({ v: 1, t: 'trace_invalidate', key: traceKey }) + '\n');
          }
          return true;
        case 'max_iter':
          frame.ip = trace.startIp - 1;
          if (JIT_EVENTS_FULL) {
            process.stderr.write(JSON.stringify({ v: 1, t: 'trace_exit', key: traceKey, exit: 'max_iter' }) + '\n');
          }
          return true;
        case 'call':
          frame.ip = trace.startIp - 1;
          if (JIT_EVENTS_FULL) {
            process.stderr.write(JSON.stringify({ v: 1, t: 'trace_exit', key: traceKey, exit: 'call' }) + '\n');
          }
          return true;
        default:
          return true;
      }
    }
  }

  // Start recording a trace at the current loop header
  _startRecording(ip) {
    this.recorder = new TraceRecorder(this);
    this.recorder.start(this._closureId(), ip);
  }

  _abortRecording(reason = 'unknown') {
    if (this.recorder && this.jit) {
      this.jit.recordAbort(this.recorder.trace?.frameId ?? this._closureId(), this.recorder.startIp);
    }
    if (this.recorder) this.recorder.abort(reason);
    this.recorder = null;
  }

  _handleThrow(thrownValue) {
    // Look for a handler on the handler stack
    if (this.handlerStack && this.handlerStack.length > 0) {
      const handler = this.handlerStack.pop();

      // Unwind call frames back to the handler's frame
      this.framesIndex = handler.frameIndex + 1;

      // Restore stack pointer
      this.sp = handler.sp;

      // Push the thrown value onto the stack (for the catch param)
      this.push(thrownValue);

      // Jump to catch handler
      const frame = this.frames[this.framesIndex - 1];
      frame.ip = handler.catchAddr - 1; // -1 because loop will increment
    } else {
      // No handler — convert to a runtime error
      const msg = thrownValue instanceof MonkeyString ? thrownValue.value
        : thrownValue instanceof MonkeyError ? thrownValue.message
        : (thrownValue && thrownValue.value !== undefined) ? String(thrownValue.value)
        : String(thrownValue);
      throw new Error(`Uncaught exception: ${msg}`);
    }
  }

  _vmThrow(thrownValue) {
    if (this.handlerStack && this.handlerStack.length > 0) {
      const handler = this.handlerStack.pop();
      this.framesIndex = handler.frameIndex + 1;
      this.sp = handler.sp;
      this.push(thrownValue);
      const f = this.frames[this.framesIndex - 1];
      f.ip = handler.catchAddr - 1;
    } else {
      const msg = thrownValue instanceof MonkeyString ? thrownValue.value
        : thrownValue instanceof MonkeyError ? thrownValue.message
        : (thrownValue && thrownValue.value !== undefined) ? String(thrownValue.value)
        : String(thrownValue);
      throw new Error(`Uncaught exception: ${msg}`);
    }
  }

  // Get or create quickening counters for a bytecode array.
  // Counters track consecutive same-type observations per instruction position.
  _getQuickenCounters(instructions) {
    if (!instructions._quickenCounters) {
      instructions._quickenCounters = {};
    }
    return instructions._quickenCounters;
  }

  // Start recording a side trace from a guard exit
  _startSideTraceRecording(parentTrace, guardIdx, exitIp) {
    this.recorder = new TraceRecorder(this);
    this.recorder.startSideTrace(parentTrace, guardIdx, exitIp, this._closureId());
  }

  // Execute a compiled function trace
  _executeFuncTrace(trace, closure, numArgs) {
    const bp = this.sp - numArgs;
    const allConsts = this._traceConsts.length > 0
      ? [...this.constants, ...this._traceConsts]
      : this.constants;

    // Collect args from the stack
    const args = new Array(numArgs);
    for (let i = 0; i < numArgs; i++) {
      args[i] = this.stack[bp + i];
    }

    const compiler = trace._compiler;
    const isRaw = compiler && compiler._isRaw;

    // Self-call: the compiled trace calls itself for recursion
    const self = (callArgs) => {
      return trace.compiled(
        callArgs, this.globals, allConsts, closure.free,
        MonkeyInteger, MonkeyBoolean, MonkeyString,
        TRUE, FALSE, NULL,
        cachedInteger,
        internString,
        this.isTruthy,
        self, selfRaw,
      );
    };

    // Raw self-call: takes raw numbers, returns raw number
    const selfRaw = isRaw ? (callArgs) => {
      // callArgs are already raw numbers from the raw-compiled code
      // We need to box them for the compiled function (which unboxes on entry)
      const boxedArgs = callArgs.map(v => cachedInteger(v));
      const result = trace.compiled(
        boxedArgs, this.globals, allConsts, closure.free,
        MonkeyInteger, MonkeyBoolean, MonkeyString,
        TRUE, FALSE, NULL,
        cachedInteger,
        internString,
        this.isTruthy,
        self, selfRaw,
      );
      // Result is a MonkeyInteger (boxed by the return statement) — unbox it
      return result && result.value !== undefined ? result.value : 0;
    } : undefined;

    const result = trace.compiled(
      args, this.globals, allConsts, closure.free,
      MonkeyInteger, MonkeyBoolean, MonkeyString,
      TRUE, FALSE, NULL,
      cachedInteger,
      internString,
      this.isTruthy,
      self, selfRaw,
    );
    trace.executionCount++;

    // null means guard failure
    if (result === null) {
      return { exit: 'guard', ip: 0 };
    }
    return result;
  }

  // Execute a compiled side trace
  _executeSideTrace(sideTrace, parentTrace, allConsts) {
    const frame = this.currentFrame();
    const emptySideTraces = new Map();
    const result = sideTrace.compiled(
      this.stack, this.sp, frame.basePointer,
      this.globals, allConsts, frame.closure.free,
      MonkeyInteger, MonkeyBoolean, MonkeyString, MonkeyArray,
      TRUE, FALSE, NULL,
      cachedInteger,
      internString,
      this.isTruthy,
      emptySideTraces,
    );
    sideTrace.executionCount++;
    return result;
  }

  // Record the current opcode into the trace (called after execution)
  _record(op, ip, ins) {
    if (!this.recorder || !this.recorder.recording) return;

    // Skip recording while inside recursive calls in function traces
    if (this.recorder._skipDepth > 0) return;

    // Check if we've looped back to the start (trace complete) — loop traces only
    if (!this.recorder.isFuncTrace && this.recorder.instrCount > 0 && ip === this.recorder.startIp) {
      const trace = this.recorder.stop();
      if (trace && this.jit.compile(trace, this)) {
        this.jit.storeTrace(trace);
      }
      this.recorder = null;
      return;
    }

    // Abort on too many instructions
    if (++this.recorder.instrCount > 200) {
      this._abortRecording('instr_count_max_func');
      return;
    }
  }

  // Record a value being pushed (maps VM push to IR ref tracking)
  _recordPush(op, value, operands) {
    if (!this.recorder || !this.recorder.recording) return;
    const r = this.recorder;
    const trace = r.trace;

    switch (op) {
      case Opcodes.OpConstant: {
        if (value instanceof MonkeyInteger) {
          const ref = trace.addInst(IR.CONST_INT, { value: value.value });
          r.typeMap.set(ref, 'raw_int');
          r.pushRef(ref);
        } else if (value instanceof MonkeyBoolean) {
          const ref = trace.addInst(IR.CONST_BOOL, { value: value.value });
          r.typeMap.set(ref, 'bool');
          r.pushRef(ref);
        } else if (value instanceof MonkeyString) {
          const ref = trace.addInst(IR.CONST_OBJ, { constIdx: operands[0] });
          r.typeMap.set(ref, 'string');
          r.pushRef(ref);
        } else {
          const ref = trace.addInst(IR.CONST_OBJ, { constIdx: operands[0] });
          r.typeMap.set(ref, 'object');
          r.pushRef(ref);
        }
        break;
      }

      case Opcodes.OpGetLocal: {
        const ref = trace.addInst(IR.LOAD_LOCAL, { slot: operands[0] });
        r.pushRef(ref);
        break;
      }

      case Opcodes.OpGetGlobal: {
        const ref = trace.addInst(IR.LOAD_GLOBAL, { index: operands[0] });
        r.pushRef(ref);
        break;
      }

      case Opcodes.OpGetFree: {
        const ref = trace.addInst(IR.LOAD_FREE, { index: operands[0] });
        r.pushRef(ref);
        break;
      }

      case Opcodes.OpTrue: {
        const ref = trace.addInst(IR.CONST_BOOL, { value: true });
        r.typeMap.set(ref, 'bool');
        r.pushRef(ref);
        break;
      }

      case Opcodes.OpFalse: {
        const ref = trace.addInst(IR.CONST_BOOL, { value: false });
        r.typeMap.set(ref, 'bool');
        r.pushRef(ref);
        break;
      }

      case Opcodes.OpNull: {
        const ref = trace.addInst(IR.CONST_NULL);
        r.typeMap.set(ref, 'null');
        r.pushRef(ref);
        break;
      }
    }
  }

  // Record a runtime value as a constant in the trace IR
  // Used for inlined closure free variables (captured by value, won't change)
  _recordPushAsConst(value) {
    if (!this.recorder || !this.recorder.recording) return;
    const r = this.recorder;
    const trace = r.trace;

    if (value instanceof MonkeyInteger) {
      const ref = trace.addInst(IR.CONST_INT, { value: value.value });
      r.typeMap.set(ref, 'raw_int');
      r.pushRef(ref);
    } else if (value instanceof MonkeyBoolean) {
      const ref = trace.addInst(IR.CONST_BOOL, { value: value.value });
      r.typeMap.set(ref, 'bool');
      r.pushRef(ref);
    } else if (value instanceof MonkeyString) {
      const idx = this._ensureTraceConst(value);
      const ref = trace.addInst(IR.CONST_OBJ, { constIdx: idx });
      r.typeMap.set(ref, 'string');
      r.pushRef(ref);
    } else {
      const idx = this._ensureTraceConst(value);
      const ref = trace.addInst(IR.CONST_OBJ, { constIdx: idx });
      r.typeMap.set(ref, 'object');
      r.pushRef(ref);
    }
  }
}
