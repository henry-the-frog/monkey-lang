// Mark-Sweep Garbage Collector for WASM Linear Memory
//
// Design:
//   - GC runs on the JS side (can inspect WASM memory and globals)
//   - Objects have a mark bit in their tag (bit 31)
//   - Root set tracked via explicit registration (globals, locals pushed to shadow stack)
//   - Free list for allocation reuse after sweep
//
// Object layout (unchanged):
//   [tag:i32][length:i32][payload...]
//   Tag values: 1=STRING, 2=ARRAY, 3=CLOSURE
//   Mark bit: tag | 0x80000000

const TAG_STRING = 1;
const TAG_ARRAY = 2;
const TAG_CLOSURE = 3;
const MARK_BIT = 0x80000000;
const TAG_MASK = 0x7FFFFFFF;

export class WasmGC {
  constructor(memoryRef, options = {}) {
    this.memoryRef = memoryRef;
    this.heapStart = options.heapStart || 4096;
    this.roots = new Set();         // Set of heap pointers that are roots
    this.allocations = new Map();   // ptr → size (bytes) for all live allocations
    this.freeList = [];             // [{ptr, size}] sorted by ptr, for reuse
    this.heapPtr = this.heapStart;  // current bump pointer (for fresh allocations)
    
    // Stats
    this.stats = {
      collections: 0,
      totalAllocated: 0,
      totalFreed: 0,
      currentLive: 0,
      peakLive: 0,
    };
    
    // GC trigger threshold
    this.threshold = options.threshold || 64 * 1024; // 64KB default
    this.bytesAllocatedSinceGC = 0;
    this.enabled = options.enabled !== false;
  }

  get view() {
    const mem = this.memoryRef.memory;
    if (!mem) return null;
    return new DataView(mem.buffer);
  }

  // Register a pointer as a GC root (called when storing to globals/locals)
  addRoot(ptr) {
    if (ptr > 0 && this.allocations.has(ptr)) {
      this.roots.add(ptr);
    }
  }

  removeRoot(ptr) {
    this.roots.delete(ptr);
  }

  // Update roots from a set of "live" pointers (e.g., all WASM globals)
  updateRoots(livePointers) {
    this.roots.clear();
    for (const ptr of livePointers) {
      if (ptr > 0 && this.allocations.has(ptr)) {
        this.roots.add(ptr);
      }
    }
  }

  // Allocate memory, potentially triggering GC
  alloc(size) {
    // Align to 4 bytes
    size = (size + 3) & ~3;

    // Try GC if threshold exceeded
    if (this.enabled && this.bytesAllocatedSinceGC >= this.threshold) {
      this.collect();
    }

    // Try free list first (first-fit)
    for (let i = 0; i < this.freeList.length; i++) {
      const block = this.freeList[i];
      if (block.size >= size) {
        this.freeList.splice(i, 1);
        // If block is significantly larger, split it
        if (block.size >= size + 16) {
          const remainder = { ptr: block.ptr + size, size: block.size - size };
          this.freeList.push(remainder);
          this.freeList.sort((a, b) => a.ptr - b.ptr);
          this.allocations.set(block.ptr, size);
        } else {
          // Use entire block
          this.allocations.set(block.ptr, block.size);
          size = block.size;
        }
        this.stats.currentLive += size;
        if (this.stats.currentLive > this.stats.peakLive) {
          this.stats.peakLive = this.stats.currentLive;
        }
        return block.ptr;
      }
    }

    // Bump allocate
    const ptr = this.heapPtr;
    this.heapPtr += size;
    this.allocations.set(ptr, size);
    this.bytesAllocatedSinceGC += size;
    this.stats.totalAllocated += size;
    this.stats.currentLive += size;
    if (this.stats.currentLive > this.stats.peakLive) {
      this.stats.peakLive = this.stats.currentLive;
    }
    return ptr;
  }

  // Mark phase: recursively mark all reachable objects from roots
  mark() {
    const view = this.view;
    if (!view) return;

    const worklist = [...this.roots];

    while (worklist.length > 0) {
      const ptr = worklist.pop();
      if (ptr <= 0 || !this.allocations.has(ptr)) continue;

      const tag = view.getInt32(ptr, true);
      if (tag & MARK_BIT) continue; // already marked

      const rawTag = tag & TAG_MASK;
      if (rawTag !== TAG_STRING && rawTag !== TAG_ARRAY && rawTag !== TAG_CLOSURE) continue;

      // Set mark bit
      view.setInt32(ptr, tag | MARK_BIT, true);

      // Trace references
      if (rawTag === TAG_ARRAY) {
        const len = view.getInt32(ptr + 4, true);
        for (let i = 0; i < len; i++) {
          const elem = view.getInt32(ptr + 8 + i * 4, true);
          if (elem > 0 && this.allocations.has(elem)) {
            worklist.push(elem);
          }
        }
      } else if (rawTag === TAG_CLOSURE) {
        // Closure layout: [TAG_CLOSURE][table_index][env_ptr][...captured_vars]
        // env_ptr at offset 8
        const envPtr = view.getInt32(ptr + 8, true);
        if (envPtr > 0 && this.allocations.has(envPtr)) {
          worklist.push(envPtr);
        }
        // Captured variables stored after the header (size known from allocation)
        const allocSize = this.allocations.get(ptr);
        const numCaptures = (allocSize - 12) / 4; // 12 = tag + table_idx + env_ptr
        for (let i = 0; i < numCaptures; i++) {
          const capVal = view.getInt32(ptr + 12 + i * 4, true);
          if (capVal > 0 && this.allocations.has(capVal)) {
            worklist.push(capVal);
          }
        }
      }
      // Strings have no references to trace
    }
  }

  // Sweep phase: free unmarked objects, clear mark bits on survivors
  sweep() {
    const view = this.view;
    if (!view) return 0;

    let freed = 0;
    const toFree = [];

    for (const [ptr, size] of this.allocations) {
      const tag = view.getInt32(ptr, true);
      if (tag & MARK_BIT) {
        // Marked — clear the mark bit, keep alive
        view.setInt32(ptr, tag & TAG_MASK, true);
      } else {
        // Unmarked — schedule for freeing
        toFree.push({ ptr, size });
        freed += size;
      }
    }

    // Free unmarked allocations
    for (const { ptr, size } of toFree) {
      this.allocations.delete(ptr);
      this.freeList.push({ ptr, size });
      this.stats.currentLive -= size;
    }

    // Coalesce adjacent free blocks
    this.freeList.sort((a, b) => a.ptr - b.ptr);
    const coalesced = [];
    for (const block of this.freeList) {
      if (coalesced.length > 0) {
        const last = coalesced[coalesced.length - 1];
        if (last.ptr + last.size === block.ptr) {
          last.size += block.size;
          continue;
        }
      }
      coalesced.push({ ...block });
    }
    this.freeList = coalesced;

    this.stats.totalFreed += freed;
    return freed;
  }

  // Full GC cycle
  collect() {
    this.mark();
    const freed = this.sweep();
    this.stats.collections++;
    this.bytesAllocatedSinceGC = 0;
    return freed;
  }

  // Get allocation size for an object
  objectSize(ptr) {
    return this.allocations.get(ptr) || 0;
  }

  // Get GC statistics
  getStats() {
    return {
      ...this.stats,
      freeListBlocks: this.freeList.length,
      freeListBytes: this.freeList.reduce((s, b) => s + b.size, 0),
      liveObjects: this.allocations.size,
    };
  }
}

// Create a GC-enabled version of createWasmImports
// This wraps allocation and root tracking around the standard imports
export function createGCImports(gc, outputLines = [], memoryRef = { memory: null }) {
  // Helper to read string from WASM memory
  function readString(ptr) {
    const mem = memoryRef.memory;
    if (!mem || ptr <= 0) return '';
    const view = new DataView(mem.buffer);
    const tag = view.getInt32(ptr, true) & TAG_MASK;
    if (tag !== TAG_STRING) return String(ptr);
    const len = view.getInt32(ptr + 4, true);
    const bytes = new Uint8Array(mem.buffer, ptr + 8, len);
    return new TextDecoder().decode(bytes);
  }

  function writeString(str) {
    const mem = memoryRef.memory;
    if (!mem) return 0;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    const size = (8 + bytes.length + 3) & ~3; // align to 4
    const ptr = gc.alloc(size);
    const view = new DataView(mem.buffer);
    view.setInt32(ptr, TAG_STRING, true);
    view.setInt32(ptr + 4, bytes.length, true);
    new Uint8Array(mem.buffer).set(bytes, ptr + 8);
    return ptr;
  }

  // The hash maps are managed on JS side, don't need GC
  const hashMaps = new Map();
  let nextHashId = 1;

  return {
    env: {
      puts(value) {
        const mem = memoryRef.memory;
        if (mem) {
          const view = new DataView(mem.buffer);
          const tag = (value > 0 && value + 8 <= view.byteLength) ? view.getInt32(value, true) & TAG_MASK : 0;
          if (tag === TAG_STRING) {
            outputLines.push(readString(value));
          } else if (tag === TAG_ARRAY) {
            const len = view.getInt32(value + 4, true);
            const elems = [];
            for (let i = 0; i < len; i++) {
              const elem = view.getInt32(value + 8 + i * 4, true);
              elems.push(String(elem));
            }
            outputLines.push('[' + elems.join(', ') + ']');
          } else {
            outputLines.push(String(value));
          }
        } else {
          outputLines.push(String(value));
        }
      },
      str(value) {
        const mem = memoryRef.memory;
        if (!mem) return value;
        const view = new DataView(mem.buffer);
        let formatted;
        if (value > 0 && value + 8 <= view.byteLength) {
          const tag = view.getInt32(value, true) & TAG_MASK;
          if (tag === TAG_STRING) formatted = readString(value);
          else if (tag === TAG_ARRAY) formatted = '[array]';
          else formatted = String(value);
        } else {
          formatted = String(value);
        }
        return writeString(formatted);
      },
      __str_concat(ptr1, ptr2) {
        return writeString(readString(ptr1) + readString(ptr2));
      },
      __str_eq(ptr1, ptr2) {
        return readString(ptr1) === readString(ptr2) ? 1 : 0;
      },
      __str_cmp(ptr1, ptr2) {
        const s1 = readString(ptr1), s2 = readString(ptr2);
        return s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
      },
      __str_char_at(ptr, index) {
        const s = readString(ptr);
        if (index < 0 || index >= s.length) return 0;
        return writeString(s[index]);
      },
      __add(a, b) {
        const mem = memoryRef.memory;
        if (mem && a > 0 && b > 0) {
          const view = new DataView(mem.buffer);
          try {
            const tagA = view.getInt32(a, true) & TAG_MASK;
            const tagB = view.getInt32(b, true) & TAG_MASK;
            if (tagA === TAG_STRING || tagB === TAG_STRING) {
              const sA = tagA === TAG_STRING ? readString(a) : String(a);
              const sB = tagB === TAG_STRING ? readString(b) : String(b);
              return writeString(sA + sB);
            }
          } catch (e) {}
        }
        return a + b;
      },
      __eq(a, b) {
        if (a === b) return 1;
        const mem = memoryRef.memory;
        if (mem && a > 0 && b > 0) {
          const view = new DataView(mem.buffer);
          try {
            const tagA = view.getInt32(a, true) & TAG_MASK;
            const tagB = view.getInt32(b, true) & TAG_MASK;
            if (tagA === TAG_STRING && tagB === TAG_STRING) {
              return readString(a) === readString(b) ? 1 : 0;
            }
          } catch (e) {}
        }
        return 0;
      },
      __lt(a, b) {
        const mem = memoryRef.memory;
        if (mem && a > 0 && b > 0) {
          const view = new DataView(mem.buffer);
          try {
            const tagA = view.getInt32(a, true) & TAG_MASK;
            if (tagA === TAG_STRING) return readString(a) < readString(b) ? 1 : 0;
          } catch (e) {}
        }
        return a < b ? 1 : 0;
      },
      __gt(a, b) {
        const mem = memoryRef.memory;
        if (mem && a > 0 && b > 0) {
          const view = new DataView(mem.buffer);
          try {
            const tagA = view.getInt32(a, true) & TAG_MASK;
            if (tagA === TAG_STRING) return readString(a) > readString(b) ? 1 : 0;
          } catch (e) {}
        }
        return a > b ? 1 : 0;
      },
      __sub(a, b) { return a - b; },
      __mul(a, b) { return a * b; },
      __div(a, b) { return b !== 0 ? Math.trunc(a / b) : 0; },
      __mod(a, b) { return b !== 0 ? a % b : 0; },
      __neg(a) { return -a; },
      __abs(a) { return Math.abs(a); },
      __max(a, b) { return a > b ? a : b; },
      __min(a, b) { return a < b ? a : b; },
      __range(start, end) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const len = Math.max(0, end - start);
        const size = (8 + len * 4 + 3) & ~3;
        const ptr = gc.alloc(size);
        const view = new DataView(mem.buffer);
        view.setInt32(ptr, TAG_ARRAY, true);
        view.setInt32(ptr + 4, len, true);
        for (let i = 0; i < len; i++) view.setInt32(ptr + 8 + i * 4, start + i, true);
        return ptr;
      },
      __join(arrPtr, sepPtr) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return writeString('');
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(arrPtr, true) & TAG_MASK;
        if (tag !== TAG_ARRAY) return writeString('');
        const len = view.getInt32(arrPtr + 4, true);
        const sep = sepPtr > 0 ? readString(sepPtr) : ',';
        const parts = [];
        for (let i = 0; i < len; i++) parts.push(String(view.getInt32(arrPtr + 8 + i * 4, true)));
        return writeString(parts.join(sep));
      },
      __keys(hashId) { return 0; }, // stub
      __values(hashId) { return 0; }, // stub
      __contains(arrPtr, elem) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return 0;
        const view = new DataView(mem.buffer);
        if ((view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        for (let i = 0; i < len; i++) {
          if (view.getInt32(arrPtr + 8 + i * 4, true) === elem) return 1;
        }
        return 0;
      },
      __reverse(arrPtr) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return 0;
        const view = new DataView(mem.buffer);
        if ((view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const size = (8 + len * 4 + 3) & ~3;
        const ptr = gc.alloc(size);
        view.setInt32(ptr, TAG_ARRAY, true);
        view.setInt32(ptr + 4, len, true);
        for (let i = 0; i < len; i++) {
          view.setInt32(ptr + 8 + i * 4, view.getInt32(arrPtr + 8 + (len - 1 - i) * 4, true), true);
        }
        return ptr;
      },
      __float_new(hi, lo) { return 0; }, // stub
      __to_float(v) { return v; }, // stub
      __str_split(strPtr, sepPtr) { return 0; }, // stub
      __str_trim(strPtr) { return writeString(readString(strPtr).trim()); },
      __str_replace(strPtr, fromPtr, toPtr) { return writeString(readString(strPtr).replace(readString(fromPtr), readString(toPtr))); },
      __str_indexOf(strPtr, searchPtr) { return readString(strPtr).indexOf(readString(searchPtr)); },
      __str_startsWith(strPtr, prefixPtr) { return readString(strPtr).startsWith(readString(prefixPtr)) ? 1 : 0; },
      __str_endsWith(strPtr, suffixPtr) { return readString(strPtr).endsWith(readString(suffixPtr)) ? 1 : 0; },
      __str_toUpper(strPtr) { return writeString(readString(strPtr).toUpperCase()); },
      __str_toLower(strPtr) { return writeString(readString(strPtr).toLowerCase()); },
      __str_substring(strPtr, start, end) { return writeString(readString(strPtr).substring(start, end)); },
      // Higher-order function imports
      __map(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || (view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        const results = [];
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + 8 + i * 4, true);
          results.push(fn(envPtr, elem));
        }
        const size = (8 + results.length * 4 + 3) & ~3;
        const ptr = gc.alloc(size);
        view = new DataView(mem.buffer);
        view.setInt32(ptr, TAG_ARRAY, true);
        view.setInt32(ptr + 4, results.length, true);
        for (let i = 0; i < results.length; i++) view.setInt32(ptr + 8 + i * 4, results[i], true);
        return ptr;
      },
      __filter(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || (view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        const results = [];
        for (let i = 0; i < len; i++) {
          const elem = view.getInt32(arrPtr + 8 + i * 4, true);
          if (fn(envPtr, elem)) results.push(elem);
        }
        const size = (8 + results.length * 4 + 3) & ~3;
        const ptr = gc.alloc(size);
        view.setInt32(ptr, TAG_ARRAY, true);
        view.setInt32(ptr + 4, results.length, true);
        for (let i = 0; i < results.length; i++) view.setInt32(ptr + 8 + i * 4, results[i], true);
        return ptr;
      },
      __reduce(arrPtr, closurePtr, initValue) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || (view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        const sentinel = -2147483648;
        let acc = initValue !== sentinel ? initValue : (len > 0 ? view.getInt32(arrPtr + 8, true) : 0);
        const startIdx = initValue !== sentinel ? 0 : 1;
        for (let i = startIdx; i < len; i++) {
          view = new DataView(mem.buffer);
          acc = fn(envPtr, acc, view.getInt32(arrPtr + 8 + i * 4, true));
        }
        return acc;
      },
      __find(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || (view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          const elem = view.getInt32(arrPtr + 8 + i * 4, true);
          if (fn(envPtr, elem)) return elem;
        }
        return 0;
      },
      __any(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || (view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          if (fn(envPtr, view.getInt32(arrPtr + 8 + i * 4, true))) return 1;
        }
        return 0;
      },
      __every(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || (view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          if (!fn(envPtr, view.getInt32(arrPtr + 8 + i * 4, true))) return 0;
        }
        return 1;
      },
      __array_concat(arrA, arrB) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        const lenA = (arrA > 0 && (view.getInt32(arrA, true) & TAG_MASK) === TAG_ARRAY) ? view.getInt32(arrA + 4, true) : 0;
        const lenB = (arrB > 0 && (view.getInt32(arrB, true) & TAG_MASK) === TAG_ARRAY) ? view.getInt32(arrB + 4, true) : 0;
        const newLen = lenA + lenB;
        const size = (8 + newLen * 4 + 3) & ~3;
        const newPtr = gc.alloc(size);
        view.setInt32(newPtr, TAG_ARRAY, true);
        view.setInt32(newPtr + 4, newLen, true);
        for (let i = 0; i < lenA; i++) {
          view.setInt32(newPtr + 8 + i * 4, view.getInt32(arrA + 8 + i * 4, true), true);
        }
        for (let i = 0; i < lenB; i++) {
          view.setInt32(newPtr + 8 + (lenA + i) * 4, view.getInt32(arrB + 8 + i * 4, true), true);
        }
        return newPtr;
      },
      __rest(arrPtr) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return 0;
        const view = new DataView(mem.buffer);
        if ((view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        if (len <= 0) return 0;
        const newLen = len - 1;
        const size = (8 + newLen * 4 + 3) & ~3;
        const newPtr = gc.alloc(size);
        view.setInt32(newPtr, TAG_ARRAY, true);
        view.setInt32(newPtr + 4, newLen, true);
        for (let i = 0; i < newLen; i++) {
          view.setInt32(newPtr + 8 + i * 4, view.getInt32(arrPtr + 8 + (i + 1) * 4, true), true);
        }
        return newPtr;
      },
      __type(value) {
        const mem = memoryRef.memory;
        if (!mem) return writeString('unknown');
        const view = new DataView(mem.buffer);
        if (value > 0 && value + 8 <= view.byteLength) {
          try {
            const tag = view.getInt32(value, true) & TAG_MASK;
            if (tag === TAG_STRING) return writeString('STRING');
            if (tag === TAG_ARRAY) return writeString('ARRAY');
            if (tag === TAG_CLOSURE) return writeString('FUNCTION');
          } catch (e) {}
        }
        return writeString('INTEGER');
      },
      __int(value) {
        const mem = memoryRef.memory;
        if (!mem) return value;
        const view = new DataView(mem.buffer);
        if (value > 0 && value + 8 <= view.byteLength) {
          try {
            const tag = view.getInt32(value, true) & TAG_MASK;
            if (tag === TAG_STRING) {
              return parseInt(readString(value), 10) || 0;
            }
          } catch (e) {}
        }
        return value;
      },
      __slice(arrPtr, start, end) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return 0;
        const view = new DataView(mem.buffer);
        if ((view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        if (end <= 0) end = len;
        if (start < 0) start = 0;
        if (end > len) end = len;
        const newLen = Math.max(0, end - start);
        const size = (8 + newLen * 4 + 3) & ~3;
        const newPtr = gc.alloc(size);
        view.setInt32(newPtr, TAG_ARRAY, true);
        view.setInt32(newPtr + 4, newLen, true);
        for (let i = 0; i < newLen; i++) {
          view.setInt32(newPtr + 8 + i * 4, view.getInt32(arrPtr + 8 + (start + i) * 4, true), true);
        }
        return newPtr;
      },
      __hash_new() {
        const id = nextHashId++;
        hashMaps.set(id, new Map());
        return id;
      },
      __hash_set(hashId, key, value) {
        const map = hashMaps.get(hashId);
        if (!map) return hashId;
        let resolvedKey = key;
        const mem = memoryRef.memory;
        if (mem && key > 0) {
          const view = new DataView(mem.buffer);
          try {
            if ((view.getInt32(key, true) & TAG_MASK) === TAG_STRING) {
              resolvedKey = 's:' + readString(key);
            }
          } catch (e) {}
        }
        map.set(resolvedKey, value);
        return hashId;
      },
      __hash_get(hashId, key) {
        const map = hashMaps.get(hashId);
        if (!map) return 0;
        let resolvedKey = key;
        const mem = memoryRef.memory;
        if (mem && key > 0) {
          const view = new DataView(mem.buffer);
          try {
            if ((view.getInt32(key, true) & TAG_MASK) === TAG_STRING) {
              resolvedKey = 's:' + readString(key);
            }
          } catch (e) {}
        }
        return map.get(resolvedKey) || 0;
      },
      __index_get(obj, key) {
        if (hashMaps.has(obj)) {
          const map = hashMaps.get(obj);
          let resolvedKey = key;
          const mem = memoryRef.memory;
          if (mem && key > 0) {
            const view = new DataView(mem.buffer);
            try {
              if ((view.getInt32(key, true) & TAG_MASK) === TAG_STRING) {
                resolvedKey = 's:' + readString(key);
              }
            } catch (e) {}
          }
          return map.get(resolvedKey) || 0;
        }
        const mem = memoryRef.memory;
        if (!mem || obj <= 0) return 0;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(obj, true) & TAG_MASK;
        if (tag === TAG_STRING) {
          const str = readString(obj);
          if (key < 0 || key >= str.length) return 0;
          return writeString(str[key]);
        }
        if (tag !== TAG_ARRAY) return 0;
        const len = view.getInt32(obj + 4, true);
        if (key < 0 || key >= len) return 0;
        return view.getInt32(obj + 8 + key * 4, true);
      },
      __index_set(obj, key, value) {
        if (hashMaps.has(obj)) {
          const map = hashMaps.get(obj);
          let resolvedKey = key;
          const mem = memoryRef.memory;
          if (mem && key > 0) {
            const view = new DataView(mem.buffer);
            try {
              if ((view.getInt32(key, true) & TAG_MASK) === TAG_STRING) {
                resolvedKey = 's:' + readString(key);
              }
            } catch (e) {}
          }
          map.set(resolvedKey, value);
          return;
        }
        const mem = memoryRef.memory;
        if (!mem || obj <= 0) return;
        const view = new DataView(mem.buffer);
        if ((view.getInt32(obj, true) & TAG_MASK) !== TAG_ARRAY) return;
        const len = view.getInt32(obj + 4, true);
        if (key < 0 || key >= len) return;
        view.setInt32(obj + 8 + key * 4, value, true);
      },
      // GC control
      __gc_collect() {
        return gc.collect();
      },
      __gc_stats() {
        const stats = gc.getStats();
        return stats.currentLive;
      },
      __gc_alloc(size) {
        return gc.alloc(size);
      },
      __gc_register(ptr, size) {
        // Track WASM-internal allocations (from the bump allocator)
        gc.allocations.set(ptr, size);
        gc.stats.totalAllocated += size;
        gc.stats.currentLive += size;
        if (gc.stats.currentLive > gc.stats.peakLive) {
          gc.stats.peakLive = gc.stats.currentLive;
        }
        gc.bytesAllocatedSinceGC += size;
      },
      __gc_add_root(ptr) {
        gc.addRoot(ptr);
      },
      __gc_remove_root(ptr) {
        gc.removeRoot(ptr);
      },
    },
  };
}
