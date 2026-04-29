// Monkey Language Standard Library Showcase
// Demonstrates the complete collection of builtins

// === Range & Mathematical Operations ===
let numbers = range(1, 11);
puts("Numbers: " + str(numbers));
puts("Sum(1-10): " + str(sum(numbers)));
puts("Avg(1-10): " + str(avg(numbers)));

// Sum of squares
let squares = map(numbers, fn(x) { x * x });
puts("Squares: " + str(squares));
puts("Sum of squares: " + str(sum(squares)));

// === Functional Array Operations ===
let data = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
puts("");
puts("Data: " + str(data));
puts("Unique: " + str(unique(data)));
puts("Sorted: " + str(sort(data)));
puts("Reversed: " + str(reverse(sort(data))));
puts("Top 3: " + str(take(reverse(sort(unique(data))), 3)));
puts("Even only: " + str(filter(data, fn(x) { x % 2 == 0 })));

// === FlatMap ===
let words = ["hello world", "foo bar"];
// (simulated split — just showing flatMap concept)
puts("");
puts("FlatMap: " + str(flatMap(range(3), fn(x) { [x, x * 10] })));

// === Hash Map Operations ===
let scores = {"alice": 95, "bob": 87, "carol": 92, "dave": 78, "eve": 99};
puts("");
puts("=== Scores ===");
puts("All: " + str(scores));
puts("Total: " + str(reduce(scores, fn(acc, k, v) { acc + v }, 0)));
puts("Top scorers: " + str(filter(scores, fn(k, v) { v >= 90 })));
puts("Doubled: " + str(map(scores, fn(k, v) { v * 2 })));
puts("Eve's score: " + str(scores["eve"]));
puts("Has dave? " + str(has(scores, "dave")));

// === Zip & Entries ===
let names = ["x", "y", "z"];
let vals = [10, 20, 30];
let zipped = zip(names, vals);
puts("");
puts("Zip: " + str(zipped));
puts("Entries: " + str(entries(zipped)));
puts("Roundtrip: " + str(fromEntries(entries(zipped))));

// === GroupBy ===
let people = range(1, 21);
let groups = groupBy(people, fn(n) { if (n % 3 == 0) { "fizz" } else { if (n % 5 == 0) { "buzz" } else { "other" } } });
puts("");
puts("FizzBuzz groups:");
for (k in groups) {
  puts("  " + k + ": " + str(len(groups[k])) + " items");
}

// === Enumerate ===
let letters = ["a", "b", "c", "d", "e"];
puts("");
puts("Enumerated: " + str(enumerate(letters)));

// === Merge ===
let defaults = {"color": "blue", "size": 10, "debug": 0};
let overrides = {"color": "red", "debug": 1};
let config = merge(defaults, overrides);
puts("");
puts("Config: " + str(config));

puts("");
puts("=== Monkey Standard Library Demo Complete ===");
