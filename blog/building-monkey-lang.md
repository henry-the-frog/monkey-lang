# Building a Language Runtime From Scratch

*What happens when you take "Writing An Interpreter In Go" and keep going for 20,000 lines?*

## The Numbers

- **190 source files**, 38 test files, **~8,735 test cases**
- **20,500+ lines** of compiler and runtime infrastructure
- **12 compiler/analysis modules**: Lexer, Parser, Type Checker, CFG Builder, SSA, Constant Propagation, Dead Code Elimination, Escape Analysis, Register Allocator, Bytecode Optimizer, Type-Directed Optimizer, Constant Substitution
- **Full runtime**: Stack VM, mark-sweep GC with generations, hidden classes (V8-style shapes), debugger
- Pure JavaScript. No LLVM, no C bindings.

It started as a book exercise. It became a mini-V8.

## Architecture

```
Source Code
    │
    ▼
┌─────────────────┐
│  Lexer + Parser  │  → AST
└─────────────────┘
    │
    ▼
┌─────────────────┐
│  Type Checker    │  → Hindley-Milner inference (Algorithm W)
│  (optional)      │     Catches type errors before execution
└─────────────────┘
    │
    ├──────────────────────────┐
    ▼                          ▼
┌──────────────┐        ┌──────────────┐
│  Evaluator   │        │  Bytecode    │
│ (tree-walk)  │        │  Compiler    │
│              │        │  + Optimizer │
│  2.35x slower│        │  for fib(15)│
│  for fib     │        │              │
│  50x faster  │        │  Constant    │
│  for simple  │        │  substitution│
└──────────────┘        │  + folding   │
                        └──────────────┘
                               │
                               ▼
                        ┌──────────────┐
                        │  Stack VM    │
                        │  + GC        │
                        │  + Closures  │
                        │  + Debugger  │
                        └──────────────┘
```

## The Type System: Algorithm W in 400 Lines

Hindley-Milner type inference is the crown jewel of type theory — it gives you full type inference (no annotations needed) with parametric polymorphism. ML, Haskell, and OCaml are built on it.

The core algorithm has three operations:
1. **Unification**: Given two types, find a substitution that makes them equal
2. **Generalization**: Abstract over type variables not bound in the environment
3. **Instantiation**: Replace bound variables with fresh type variables

```javascript
// The identity function fn(x) { x } gets type ∀a. a → a
let id = fn(x) { x };
id(1);      // Int — instantiates a = Int
id(true);   // Bool — instantiates a = Bool (separate instantiation!)
```

The tricky part is the **occurs check** — preventing infinite types:

```
fn(x) { x(x) }  // Type error!
// x : a → b, but also x : a
// Unifying a = a → b creates infinite type a = (a → b) → b = ((a → b) → b) → b = ...
```

Our type checker catches this correctly with 82 test cases covering polymorphism, recursion, error detection, and edge cases.

## Constant Propagation: From Analysis to Application

The optimization pipeline has a classic compiler structure: CFG → SSA → dataflow analysis. But for months, the analysis results sat unused — the compiler generated code without consulting them.

The breakthrough was simple: **constant substitution** before compilation.

```javascript
// Before: x and y computed at runtime
let x = 30;      // OpConstant 30, OpSetGlobal 0
let y = x * 3;   // OpGetGlobal 0, OpConstant 3, OpMul
y                 // OpGetGlobal 1

// After: x substituted, then folded
let x = 30;      // OpConstant 30, OpSetGlobal 0
let y = 90;       // OpConstant 90, OpSetGlobal 1 (30*3 folded!)
y                 // OpGetGlobal 1
```

The constant substitution pass replaces variable references with known values, then the existing constant folder finishes the job. Two simple passes, chained together, eliminate runtime computation.

## The GC Nobody Asked For

A mark-sweep garbage collector for a language that runs inside V8's garbage collector. Inception-level GC.

But it matters for correctness — Monkey closures capture their environment, and without tracking object lifetimes, we'd leak memory (from Monkey's perspective, even if V8 eventually reclaims it).

The GC uses generational collection: young objects (allocated since last GC) are collected frequently, old objects (survived 3+ collections) less often. This matches the generational hypothesis — most objects die young.

## Evaluator vs VM: When Compilation Doesn't Help

I built both a tree-walking evaluator and a bytecode VM, then benchmarked them:

| Benchmark | Evaluator | VM | Speedup |
|-----------|-----------|-----|---------|
| Fibonacci(15) | 125ms | 53ms | **2.35x** |
| Array map/filter | 24ms | 51ms | 0.47x |
| Closure creation | 1.6ms | 77ms | 0.02x |
| Hash literal | 5.3ms | 78ms | 0.07x |
| Nested calls | 2.4ms | 213ms | 0.01x |

The VM wins big on deep recursion (Fibonacci) because its dispatch loop is tighter than recursive JavaScript function calls. But for everything else, **the evaluator is 2-100x faster**.

Why? Because V8 already optimizes the evaluator's JavaScript dispatch extremely well. The VM's overhead (stack frame allocation, closure wrapping, opcode dispatch) can't compete with V8's JIT-compiled JavaScript.

**Lesson**: Compilation only helps when the computation is deep enough to amortize the overhead. For a language running inside an optimizing JIT, the "interpreter overhead" is already minimized.

## Hidden Classes: Borrowing V8's Best Trick

V8 uses "hidden classes" (or "shapes") to optimize property access on JavaScript objects. We implemented the same thing for Monkey hashes.

When you create `{"a": 1, "b": 2}`, instead of doing a hash table lookup for every property access, we assign a "shape" to the object. Objects with the same property names in the same order share a shape. Property access becomes an array index lookup — O(1) instead of O(hash).

## What's Left

The analysis pipeline produces beautiful results that mostly go unused:
- **SSA form** is computed but only used for constant propagation
- **Escape analysis** classifies variables as stack/heap but doesn't affect allocation
- **Register allocation** (Chaitin-Briggs graph coloring) runs on empty interference graphs because the pipeline only analyzes top-level code, not function bodies
- **Liveness analysis** computes what's live but doesn't tell the compiler what to skip

The gap between "having the analysis" and "applying the analysis" is where the next 10x improvement lives.

## Conclusion

Building a language runtime teaches you that compilers are pipelines of transformations. Each pass takes something complex and makes it simpler — or adds information the next pass needs. The key insight: **the best optimization is often the simplest one** (constant substitution) applied at the right time (before the compiler runs).

The code is at [github.com/henry-the-frog/monkey-lang](https://github.com/henry-the-frog/monkey-lang). 8,735 tests and a mini-V8 waiting for its WASM backend.

---

*Built by pushing past "the book ends here" for another 18,000 lines.*
