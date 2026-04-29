// Hash Map Examples
// Demonstrates string and integer key hash maps in Monkey language

// === Word Frequency Counter ===
let countWords = fn(words) {
  let freq = {};
  for (word in words) {
    if (has(freq, word)) {
      freq[word] = freq[word] + 1;
    } else {
      freq[word] = 1;
    }
  }
  freq
};

let words = ["hello", "world", "hello", "monkey", "world", "hello"];
let freq = countWords(words);
puts("Word frequencies:");
puts("  hello: " + str(freq["hello"]));
puts("  world: " + str(freq["world"]));
puts("  monkey: " + str(freq["monkey"]));

// === Lookup Table (Config) ===
let config = {
  "host": "localhost",
  "port": 8080,
  "debug": 1,
  "name": "MonkeyApp"
};

puts("");
puts("Config: " + config["name"] + " on " + config["host"] + ":" + str(config["port"]));

// === JSON-like Nested Objects ===
let user = {
  "name": "Alice",
  "age": 30,
  "active": 1
};

let greeting = fn(u) {
  "Hello, " + u["name"] + "! You are " + str(u["age"]) + " years old."
};
puts(greeting(user));

// === Hash Map Operations ===
puts("");
puts("=== Operations ===");
let h = {"a": 1, "b": 2, "c": 3, "d": 4, "e": 5};
puts("Size: " + str(len(h)));
puts("Keys: " + str(len(keys(h))));

// Delete
h = delete(h, "c");
puts("After delete 'c': size = " + str(len(h)));

// Iteration
let sum = 0;
for (k in h) {
  sum = sum + h[k];
}
puts("Sum of values: " + str(sum));

// === Integer Keys (Sparse Array) ===
puts("");
puts("=== Sparse Array ===");
let sparse = {};
sparse[0] = "zero";
sparse[10] = "ten";
sparse[100] = "hundred";
sparse[1000] = "thousand";
puts("sparse[10] = " + sparse[10]);
puts("sparse[1000] = " + sparse[1000]);
puts("Size: " + str(len(sparse)));

// === Building a Simple Cache ===
let makeCache = fn() {
  let store = {};
  let hits = 0;
  let misses = 0;
  
  let get = fn(key) {
    let val = store[key];
    if (val == 0) {
      misses = misses + 1;
      0
    } else {
      hits = hits + 1;
      val
    }
  };
  
  let set = fn(key, val) {
    store[key] = val;
  };
  
  {"get": get, "set": set, "hits": hits, "misses": misses}
};

puts("");
puts("=== Cache Demo ===");
// Note: closures over hash maps demonstrate the power of the system
let result = 0;
let cache = {};
cache["fib_10"] = 55;
cache["fib_20"] = 6765;
puts("Cached fib(10) = " + str(cache["fib_10"]));
puts("Cached fib(20) = " + str(cache["fib_20"]));
