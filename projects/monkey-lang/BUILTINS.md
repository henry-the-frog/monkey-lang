# Monkey Language Builtins Reference

## Array Operations

| Builtin | Description | Example |
|---------|-------------|---------|
| `len(arr)` | Array length | `len([1,2,3])` → `3` |
| `push(arr, val)` | Append element | `push([1,2], 3)` → `[1,2,3]` |
| `first(arr)` | First element | `first([1,2,3])` → `1` |
| `last(arr)` | Last element | `last([1,2,3])` → `3` |
| `rest(arr)` | All except first | `rest([1,2,3])` → `[2,3]` |
| `reverse(arr)` | Reverse order | `reverse([1,2,3])` → `[3,2,1]` |
| `sort(arr, cmp?)` | Sort (optional comparator) | `sort([3,1,2])` → `[1,2,3]` |
| `sortBy(arr, keyFn)` | Sort by key function | `sortBy([3,1,2], fn(x){x})` → `[1,2,3]` |
| `unique(arr)` | Remove duplicates | `unique([1,2,2,3])` → `[1,2,3]` |
| `flat(arr, depth?)` | Flatten nested arrays | `flat([[1,2],[3,4]])` → `[1,2,3,4]` |
| `take(arr, n)` | First n elements | `take([1,2,3,4], 2)` → `[1,2]` |
| `drop(arr, n)` | Skip first n | `drop([1,2,3,4], 2)` → `[3,4]` |
| `slice(arr, start, end?)` | Sub-array | `slice([1,2,3,4], 1, 3)` → `[2,3]` |
| `chunk(arr, size)` | Split into groups | `chunk([1,2,3,4,5], 2)` → `[[1,2],[3,4],[5]]` |
| `indexOf(arr, val)` | Find index (-1 if missing) | `indexOf([10,20,30], 20)` → `1` |
| `contains(arr, val)` | Check membership | `contains([1,2,3], 2)` → `true` |
| `enumerate(arr)` | Add indices | `enumerate(["a","b"])` → `[[0,"a"],[1,"b"]]` |
| `join(arr, sep)` | Join to string | `join(["a","b","c"], ",")` → `"a,b,c"` |
| `range(end)` / `range(start, end, step?)` | Generate sequence | `range(5)` → `[0,1,2,3,4]` |

## Functional Operations

| Builtin | Description | Example |
|---------|-------------|---------|
| `map(coll, fn)` | Transform elements | `map([1,2,3], fn(x){x*2})` → `[2,4,6]` |
| `filter(coll, fn)` | Keep matching | `filter([1,2,3,4], fn(x){x>2})` → `[3,4]` |
| `reduce(coll, fn, init?)` | Fold to single value | `reduce([1,2,3], fn(a,b){a+b}, 0)` → `6` |
| `flatMap(arr, fn)` | Map then flatten | `flatMap([1,2], fn(x){[x,x]})` → `[1,1,2,2]` |
| `find(coll, fn)` | First matching element | `find([1,2,3], fn(x){x>1})` → `2` |
| `any(coll, fn)` | Any match? | `any([1,2,3], fn(x){x>5})` → `false` |
| `all(coll, fn)` | All match? | `all([1,2,3], fn(x){x>0})` → `true` |
| `partition(coll, fn)` | Split by predicate | `partition([1,2,3,4], fn(x){x%2==0})` → `[[2,4],[1,3]]` |
| `groupBy(arr, fn)` | Group by key | `groupBy([1,2,3,4], fn(x){x%2})` → `{0:[2,4], 1:[1,3]}` |

## Math Operations

| Builtin | Description | Example |
|---------|-------------|---------|
| `sum(arr)` | Sum elements | `sum([1,2,3,4,5])` → `15` |
| `avg(arr)` | Average (rounded) | `avg([10,20,30])` → `20` |
| `min(arr)` | Minimum element | `min([3,1,4,1,5])` → `1` |
| `max(arr)` | Maximum element | `max([3,1,4,1,5])` → `9` |
| `abs(n)` | Absolute value | `abs(-42)` → `42` |

## Hash Map Operations

| Builtin | Description | Example |
|---------|-------------|---------|
| `len(hash)` | Entry count | `len({"a":1,"b":2})` → `2` |
| `has(hash, key)` | Key exists? | `has({"a":1}, "a")` → `true` |
| `delete(hash, key)` | Remove entry | `delete({"a":1,"b":2}, "a")` → `{"b":2}` |
| `merge(h1, h2)` | Combine (h2 wins) | `merge({"a":1}, {"b":2})` → `{"a":1,"b":2}` |
| `keys(hash)` | Key array | `keys({"a":1})` → `["a"]` |
| `values(hash)` | Value array | `values({"a":1})` → `[1]` |
| `entries(hash)` | [key,val] pairs | `entries({"a":1})` → `[["a",1]]` |
| `fromEntries(arr)` | Create from pairs | `fromEntries([["a",1]])` → `{"a":1}` |
| `zip(keys, vals)` | Parallel arrays→hash | `zip(["a","b"],[1,2])` → `{"a":1,"b":2}` |

## String Operations

| Builtin | Description | Example |
|---------|-------------|---------|
| `len(str)` | String length | `len("hello")` → `5` |
| `str(val)` | Convert to string | `str(42)` → `"42"` |
| `charAt(str, i)` | Character at index | `charAt("hello", 0)` → `"h"` |
| `split(str, sep)` | Split to array | `split("a,b,c", ",")` → `["a","b","c"]` |
| `join(arr, sep)` | Join array to string | `join(["a","b"], "-")` → `"a-b"` |

## Utility

| Builtin | Description | Example |
|---------|-------------|---------|
| `type(val)` | Runtime type name | `type(42)` → `"integer"` |
| `puts(val)` | Print to stdout | `puts("hello")` |

## Hash Map Iteration

```monkey
let h = {"a": 1, "b": 2, "c": 3};

// Direct for-in iterates keys
for (k in h) { puts(k + ": " + str(h[k])) }

// Functional operations take fn(key, value)
map(h, fn(k, v) { v * 2 })      // → {"a": 2, "b": 4, "c": 6}
filter(h, fn(k, v) { v > 1 })   // → {"b": 2, "c": 3}
reduce(h, fn(acc, k, v) { acc + v }, 0)  // → 6
```

## Pipeline Example

```monkey
let data = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
let result = take(reverse(sort(unique(data))), 3);
// → [9, 6, 5] (top 3 unique values)

let total = sum(map(range(10), fn(x) { x * x }));
// → 285 (sum of squares 0² through 9²)
```
