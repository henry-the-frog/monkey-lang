// showcase.monkey — Comprehensive demo of monkey-lang WASM compiler features
// This file exercises all major language features and compiles to WebAssembly

// === 1. Basic Arithmetic & Comparisons ===
let a = 42;
let b = a * 2 + 8;
puts("=== Basics ===");
puts(`Result: ${b}`);  // 92

// === 2. Strings & Template Literals ===
puts("\n=== Strings ===");
let name = "Monkey";
let version = 2;
puts(`Hello from ${name} v${version}!`);
puts(len(name));  // 6

// === 3. Arrays & Comprehensions ===
puts("\n=== Arrays ===");
let nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
let squares = [x * x for x in nums];
let evens = [x for x in nums if x % 2 == 0];
puts(`Squares: ${squares}`);
puts(`Evens: ${evens}`);

// === 4. Higher-Order Functions ===
puts("\n=== HOFs ===");
let doubled = map(nums, fn(x) { x * 2 });
let total = reduce(nums, fn(acc, x) { acc + x }, 0);
let big = filter(nums, fn(x) { x > 5 });
puts(`Doubled: ${doubled}`);
puts(`Sum: ${total}`);
puts(`Big: ${big}`);

// === 5. Closures & Mutable State ===
puts("\n=== Closures ===");
let makeCounter = fn(start) {
  let count = start;
  {
    "inc": fn() { count = count + 1; count },
    "dec": fn() { count = count - 1; count },
    "get": fn() { count }
  }
};
let counter = makeCounter(0);
counter["inc"]();
counter["inc"]();
counter["inc"]();
counter["dec"]();
puts(`Counter: ${counter["get"]()}`);  // 2

// === 6. Recursive Functions ===
puts("\n=== Recursion ===");
let fib = fn(n) {
  if (n <= 1) { n }
  else { fib(n - 1) + fib(n - 2) }
};
puts(`fib(20) = ${fib(20)}`);  // 6765

// === 7. Iterators (Closure Pattern) ===
puts("\n=== Iterator ===");
let makeIter = fn(arr) {
  let idx = 0;
  {
    "next": fn() {
      if (idx < len(arr)) {
        let val = arr[idx];
        idx = idx + 1;
        val
      } else { -1 }
    },
    "hasNext": fn() { idx < len(arr) }
  }
};
let iter = makeIter([10, 20, 30]);
let items = [];
while (iter["hasNext"]()) {
  items = push(items, iter["next"]())
};
puts(`Iterated: ${items}`);

// === 8. Memoization ===
puts("\n=== Memoization ===");
let memoFib = fn() {
  let cache = [0, 1];
  let compute = fn(n) {
    if (n < len(cache)) {
      cache[n]
    } else {
      let i = len(cache);
      while (i <= n) {
        cache = push(cache, cache[i-1] + cache[i-2]);
        i = i + 1
      };
      cache[n]
    }
  };
  compute
};
let fastFib = memoFib();
puts(`fib(30) = ${fastFib(30)}`);  // 832040

// === 9. Pattern Matching ===
puts("\n=== Match ===");
let classify = fn(n) {
  match (n % 3) {
    0 => "fizz",
    1 => "one",
    _ => "two"
  }
};
let results = [classify(i) for i in [0, 1, 2, 3, 4, 5]];
puts(`FizzBuzz-lite: ${results}`);

// === 10. Sorting & Array Operations ===
puts("\n=== Sorting ===");
let unsorted = [5, 3, 8, 1, 9, 2, 7, 4, 6];
let sorted = sort(unsorted, fn(a, b) { a - b });
puts(`Sorted: ${sorted}`);
puts(`Reversed: ${reverse(sorted)}`);
puts(`Slice [2:5]: ${sorted[2:5]}`);

puts("\n=== All features working! ===");
