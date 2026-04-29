// hashmap-playground.monkey — Hash map showcase for the monkey-lang playground
// Demonstrates: hash literals, hash indexing, mutation, iteration, patterns
//
// Run: node src/repl.js examples/hashmap-playground.monkey --engine=vm

// == Basic Hash Maps ==
let person = {"name": "Alice", "age": 30, "city": "Denver"};
puts(`Person: ${person}`);
puts(`Name: ${person["name"]}, Age: ${person["age"]}`);

// == Hash Mutation ==
set person["age"] = 31;
set person["hobby"] = "climbing";
puts(`Updated: ${person}`);

// == Integer and Boolean Keys ==
let codes = {1: "one", 2: "two", 3: "three", true: "yes", false: "no"};
puts(`codes[2] = ${codes[2]}, codes[true] = ${codes[true]}`);

// == Word Frequency Counter ==
// Split a sentence and count word occurrences
let sentence = "the quick brown fox jumps over the lazy dog the fox";
let words = split(sentence, " ");
let freq = {};

for (word in words) {
  let count = freq[word];
  if (count == null) {
    set freq[word] = 1;
  } else {
    set freq[word] = count + 1;
  };
};

puts("\n📊 Word Frequencies:");
let wordKeys = keys(freq);
for (k in wordKeys) {
  let bar = repeat("█", freq[k]);
  puts(`  ${padEnd(k, 6, " ")} ${bar} (${freq[k]})`);
};

// == Fibonacci Memo Table ==
// Memoized fibonacci using a hash map as cache
let memo = {0: 0, 1: 1};
let fib = fn(n) {
  let cached = memo[n];
  if (cached != null) {
    cached;
  } else {
    let result = fib(n - 1) + fib(n - 2);
    set memo[n] = result;
    result;
  };
};

puts("\n🔢 Fibonacci (memoized):");
let fibs = [fib(i) for i in range(0, 16)];
puts(`  fib(0..15) = ${fibs}`);
puts(`  Cache size: ${len(keys(memo))} entries`);

// == Simple Key-Value Store ==
// Factory pattern: encapsulate state behind a function API
let makeKV = fn() {
  let store = {};

  {
    "put": fn(k, v) {
      set store[k] = v;
      v;
    },
    "get": fn(k) {
      store[k];
    },
    "has": fn(k) {
      store[k] != null;
    },
    "keys": fn() {
      keys(store);
    }
  };
};

let kv = makeKV();
kv["put"]("x", 42);
kv["put"]("y", 99);
kv["put"]("z", 7);

puts("\n🗄️  Key-Value Store:");
puts(`  x = ${kv["get"]("x")}`);
puts(`  y = ${kv["get"]("y")}`);
puts(`  keys = ${kv["keys"]()}`);
puts(`  has z? = ${kv["has"]("z")}`);
// == Hash Merge ==
let defaults = {"theme": "dark", "font": 14, "lang": "en"};
let user_prefs = {"font": 18, "lang": "jp"};
let config = merge(defaults, user_prefs);
puts("\n⚙️  Config (merged):");
puts(`  ${config}`);

// == Enum-like Pattern with Hashes ==
let Color = {
  "RED": 0, "GREEN": 1, "BLUE": 2,
  "name": fn(code) {
    match code {
      0 => "Red",
      1 => "Green",
      2 => "Blue",
      _ => "Unknown"
    };
  }
};

puts("\n🎨 Colors:");
puts(`  GREEN = ${Color["GREEN"]}`);
puts(`  name(2) = ${Color["name"](Color["BLUE"])}`);

puts("\n✅ Hash map playground complete!");
