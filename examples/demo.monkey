// demo.monkey — Comprehensive demo of monkey-lang features (Session B, Apr 25)
// Run with: node src/repl.js demo.monkey

// == Comments ==
// Single-line comments with //
/* Multi-line
   block comments */

// == Variables and Types ==
let name = "Monkey";
let version = 2;
let pi = 3.14159;
let active = true;
let nothing = null;

// == Template Literals ==
puts(`Welcome to ${name}-lang v${version}!`);
puts(`Pi is approximately ${pi}`);

// == Functions and Closures ==
let greet = fn(who) {
  `Hello, ${who}!`;
};
puts(greet("World"));

// Counter factory using mutable closures
let makeCounter = fn() {
  let n = 0;
  fn() {
    set n = n + 1;
    n;
  };
};
let counter = makeCounter();
puts(`Counter: ${counter()}, ${counter()}, ${counter()}`);

// == Pattern Matching ==
let classify = fn(x) {
  match x {
    0 => "zero",
    1 => "one",
    2 => "two",
    _ => `other: ${x}`
  };
};
puts(`classify(0) = ${classify(0)}`);
puts(`classify(42) = ${classify(42)}`);

// == Destructuring ==
let [first, second, third] = [10, 20, 30];
puts(`Destructured: ${first}, ${second}, ${third}`);

// == For-in and Comprehensions ==
let squares = [n * n for n in range(1, 6)];
puts(`Squares: ${squares}`);

// == Spread and Rest ==
let arr = [1, 2, 3];
let extended = [0, ...arr, 4, 5];
puts(`Extended: ${extended}`);

let gather = fn(first, ...rest) {
  `First: ${first}, Rest: ${rest}`;
};
puts(gather(1, 2, 3, 4));

// == Math ==
puts(`sqrt(144) = ${sqrt(144)}`);
puts(`pow(2, 10) = ${pow(2, 10)}`);
puts(`floor(3.7) = ${floor(3.7)}, ceil(3.2) = ${ceil(3.2)}`);

// == String Operations ==
puts(`padStart("42", 5, "0") = ${padStart("42", 5, "0")}`);
puts(`char(65) = ${char(65)}, ord("A") = ${ord("A")}`);

// == Higher-Order Functions (from prelude) ==
// Note: run with --engine=vm for prelude support
// let doubled = map([1,2,3,4,5], fn(x) { x * 2; });
// let evens = filter(range(1, 10), fn(x) { x % 2 == 0; });
// let sum = reduce([1,2,3,4,5], 0, fn(a, b) { a + b; });

// == Modules ==
// import("math") works in the evaluator (use --engine=interpreter)
// let math = import("math");
// puts(`abs(-42) via module: ${math["abs"](-42)}`);

puts("Demo complete!");
