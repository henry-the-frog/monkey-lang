# WASM GC Backend Design for monkey-lang

## Status: Feasibility Confirmed (Apr 28, 2026)
- WASM GC struct types compile + instantiate in Node.js v22 (no flags)
- struct.new returns opaque JS object managed by V8 GC

## Type Mapping

### Current (linear memory)
- All values are i32 (tagged pointers)
- Heap objects: [TAG|length|payload...]
- Manual mark-sweep GC in wasm-gc.js

### Proposed (WASM GC)
```wasm
;; Tagged value union (eqref-based)
(type $Value (struct
  (field $tag i32)       ;; 0=null, 1=int, 2=bool, 3=string, 4=array, 5=closure
  (field $i32val i32)    ;; int/bool value
  (field $refval (ref null any))  ;; reference for complex types
))

;; String: use JS interop (externref) for now
;; Array: (array (mut (ref $Value)))
;; Closure: (struct (field $funcIndex i32) (field $captures (ref $CaptureArray)))
;; Hash: JS Map via externref
```

## Advantages
1. No manual GC (V8 handles lifetimes)
2. No heap fragmentation
3. Natural JS interop for strings/hashes
4. V8 can optimize struct access

## Challenges  
1. No native sum types → runtime tag checks
2. Hash maps need JS interop
3. String ops need JS interop
4. Closure calling convention through funcref table
5. Performance unknown vs linear memory

## Implementation Plan (phased)
1. **Phase 1**: Integers + arithmetic (struct-based values)
2. **Phase 2**: Strings via externref
3. **Phase 3**: Arrays via WASM GC arrays
4. **Phase 4**: Functions + closures
5. **Phase 5**: Hash maps via JS Map
6. **Phase 6**: Full language parity + benchmarks

## Key Unknowns
- struct.get performance vs i32.load from linear memory
- funcref indirect_call overhead vs table-based calls
- V8 GC pause behavior with many WASM GC objects
