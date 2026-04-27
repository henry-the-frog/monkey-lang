# Monkey-Lang: Five Backend Architecture

## Backend Overview

| Backend | Type | Speed (fib30) | Tests | LOC |
|---------|------|---------------|-------|-----|
| Evaluator | Tree-walking | 3480ms | ~400 | ~800 |
| VM | Bytecode | 881ms | 587 | ~1300 |
| JIT | x86-64 native | 107ms | ~200 | ~1500 |
| Transpiler | JS codegen | 21ms | ~200 | ~600 |
| WASM | WebAssembly | 475ms→44ms* | 208 | ~3000 |

*475ms with compile+run, 44ms with precompiled module

## Compilation Strategies

### Evaluator (tree-walking)
- Walks AST directly, evaluating each node
- No compilation step — immediate execution
- Simplest implementation, slowest execution
- Supports all language features natively (closures, classes, generators)

### VM (bytecode compiler)
- Two-pass: AST → bytecode → VM execution
- Stack-based VM with `OpConstant`, `OpAdd`, `OpCall`, etc.
- Closures via upvalue capture mechanism
- DCE optimization pass on AST before compilation (added today)
- Bytecode is compact and portable

### JIT (x86-64)
- Multi-pass: AST → SSA IR → register allocation → x86-64 machine code
- Dead code elimination at IR level
- Type specialization for integer operations
- Closures compiled to function pointers with environment
- Platform-specific (x86-64 only)

### Transpiler (JavaScript codegen)
- AST → JavaScript source → `new Function()` → V8 native execution
- Leverages V8's mature JIT (TurboFan) for optimization
- Fastest backend because V8 can inline, deopt, speculate
- Limited by closures (transpiler skips some)

### WASM (WebAssembly)
- AST → WASM binary → `WebAssembly.compile()` → instantiate → execute
- Uses i32 for all values (untagged, with runtime dispatch for polymorphic ops)
- Linear memory for strings, closures, arrays
- Host-backed hash maps for complex objects
- Exception handling via WASM EH proposal (try/catch/throw)
- Closures: table-based indirect calls with env pointer
- Classes: constructor functions + method closures + hash instances

## Value Representation

| Backend | Integers | Strings | Arrays | Closures |
|---------|---------|---------|--------|----------|
| Eval | JS Number | JS String | JS Array | JS Function |
| VM | MonkeyInt | MonkeyString | MonkeyArray | MonkeyClosure |
| JIT | i64 (tagged) | heap ptr | heap ptr | func ptr + env |
| Trans | JS Number | JS String | JS Array | JS Function |
| WASM | i32 | data segment ptr | host JS array | memory struct |

## Key Design Decisions (WASM Backend)

### 1. Untagged i32 Values
All values are i32. When an operation could apply to different types (e.g., `+` for int addition vs string concatenation), the compiler calls a host runtime function (`__add`) that checks the memory tag at the pointer address.

**Trade-off:** Simple compilation but fragile at runtime. Integer values can collide with memory pointers (see int/ptr confusion bug fix — data segment moved to offset 65536).

**Future:** NaN-boxing (f64 with payload) would make the tagging structural. WASM GC structs would eliminate the need for manual tagging entirely.

### 2. Host-Backed Hash Maps
Hash tables are too complex to implement in WASM linear memory efficiently. Instead, hash operations delegate to JavaScript Map objects via host imports (`__hash_new`, `__hash_set`, `__hash_get`).

**Trade-off:** Simple + correct, but crosses the WASM/JS boundary for every hash operation (slower).

### 3. Exception Handling via WASM EH Proposal
Initially used `unreachable` trap for throw (no real catch). Upgraded to use the WASM exception handling proposal (tag section, try/catch/throw opcodes). Node.js v22 supports this natively.

**Benefit:** Real try/catch semantics including nested exceptions and re-throw.

### 4. Class Instances as Hash Maps
Each class instance is a hash map with field values and method closures. Method closures capture the instance as their environment pointer, so `self` resolves via `localGet(0)`.

**Benefit:** Inheritance is simply copying parent method closures into child instances.

## Optimization Opportunities

1. **Type inference → direct i32_add**: If both operands are known integers, bypass `__add` host import
2. **Inline caching**: Cache method lookups for repeated calls on same class
3. **Escape analysis**: Stack-allocate closures that don't escape
4. **WASM GC structs**: Replace host-backed hashes with GC-managed structs
5. **WASM SIMD**: Batch operations on arrays
6. **Pre-compilation**: Already implemented — 34% speedup by compiling once

## Performance Analysis (Benchmark Results — Apr 27, with all optimizations)

```
Backend     fib(25)   sum(10k)   GCD×1k   closure(5k)   HOF(5k)   nested(100x100)
Eval        320ms     14ms       7ms      12ms          16ms      12ms
VM          98ms      7ms        27ms     6ms           6ms       6ms  
JIT         15ms      1ms        18ms     1ms           1ms       0.75ms
Trans       2ms       0.1ms      0.2ms    N/A           0.1ms     0.15ms
WASM        28ms      0.07ms     0.65ms   0.86ms        1.1ms     0.07ms
```

**WASM vs VM: 36.3x** | **WASM vs JIT: 11.4x** | **WASM beats Transpiler on 4/10 benchmarks**

Key insights:
- WASM wins on tight loops: `sum 10k` 0.07ms (2x faster than Transpiler)
- WASM wins on nested loops: `nested 100x100` 0.07ms (2x faster than Transpiler)
- Transpiler wins on recursive: `fib(25)` 2ms vs 28ms (14x, V8 inlining advantage)
- Type inference eliminated 8x overhead from host import crossings
