# WASM Array Reallocation Design

## Current State
- Bump allocator: no free list, no reallocation
- Empty arrays: capacity 256 (can push up to 256 elements safely)
- Non-empty literal arrays: 2x their literal size
- Push beyond capacity: SILENT MEMORY CORRUPTION

## Design: Handle-Based Arrays

### Concept
Instead of raw memory pointers, arrays are represented as **handles** (indices into a handle table stored at a fixed memory location).

### Memory Layout
```
[0x0000 - 0x0FFF] Handle table (256 handles × 4 bytes = 1KB)
  handle[0] → ptr to array data A
  handle[1] → ptr to array data B
  ...

[0x1000 - ...]    Data segments + heap
  Array A: [len][cap][elem0][elem1]...
  Array B: [len][cap][elem0][elem1]...
```

### Operations
- `ArrayLiteral` → allocate data, allocate handle, store ptr in handle table
- `arr[i]` → load handle → load ptr from table → load element
- `push(arr, val)` → load handle → load ptr → check capacity:
  - If cap > len: write element, increment len
  - If cap == len: alloc new block (2x size), copy, free old (bump: can't), update handle table
- `set arr[i] = val` → load handle → load ptr → store element

### Overhead
- Extra indirection on every access: ~1-2 WASM instructions
- Handle allocation: one i32.store to the table
- Reallocation: O(n) copy but amortized O(1)

### Implementation Steps
1. Reserve 0x0000-0x0FFF for handle table (256 handles)
2. Add handle allocation global (next_handle)
3. Modify ArrayLiteral to create handle + data
4. Modify IndexExpression to go through handle table
5. Modify push to check capacity and reallocate

### Alternative: Just Grow Capacity
Simpler: increase default capacity to 4096 for empty arrays. Uses more memory but avoids the complexity. Most programs won't need more than 4096 elements in a single array.

With 64KB WASM memory (1 page), you can fit:
- 1 array of ~16K elements, or
- ~16 arrays of 1K elements each
- memory.grow adds 64KB per call

### Decision
For now: keep capacity-256 default. Add memory.grow when heap is exhausted. Save handle-based system for when we need proper GC.
