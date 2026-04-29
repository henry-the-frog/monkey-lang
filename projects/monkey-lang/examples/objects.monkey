// Object System — Functional OOP using hash maps and closures
// Hash maps hold methods (closures) and data (values)
// Factory functions create "objects" (hash maps with methods)

// === Immutable Person ===
let Person = fn(name, age) {
  {
    "name": name,
    "age": age,
    "greet": fn() { "Hello, I'm " + name + " and I'm " + str(age) },
    "older": fn() { Person(name, age + 1) },
    "rename": fn(new_name) { Person(new_name, age) }
  }
};

let alice = Person("Alice", 30);
puts(alice["greet"]());

let older_alice = alice["older"]();
puts(older_alice["greet"]());
puts("Original unchanged: " + alice["greet"]());

// === Point with distance ===
let Point = fn(x, y) {
  {
    "x": x,
    "y": y,
    "add": fn(other) { Point(x + other["x"], y + other["y"]) },
    "scale": fn(factor) { Point(x * factor, y * factor) },
    "manhattan": fn() { x + y }
  }
};

let p1 = Point(3, 4);
let p2 = Point(1, 2);
let p3 = p1["add"](p2);
puts("");
puts("P1: (" + str(p1["x"]) + ", " + str(p1["y"]) + ")");
puts("P2: (" + str(p2["x"]) + ", " + str(p2["y"]) + ")");
puts("P1 + P2: (" + str(p3["x"]) + ", " + str(p3["y"]) + ")");
puts("P1 scaled x3: " + str(p1["scale"](3)["x"]) + ", " + str(p1["scale"](3)["y"]));

// === Collection operations ===
let scores = {"alice": 95, "bob": 87, "carol": 92, "dave": 78};
let high_scorers = filter(scores, fn(name, score) { score >= 90 });
let doubled = map(scores, fn(name, score) { score * 2 });
let total = reduce(scores, fn(acc, name, score) { acc + score }, 0);

puts("");
puts("Scores: " + str(scores));
puts("High scorers (>=90): " + str(high_scorers));
puts("Total: " + str(total));
puts("Average: " + str(total / len(scores)));
