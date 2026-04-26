// Comprehensive monkey-lang feature demo

// === Functions & Closures ===
let make_accumulator = fn(initial) {
  let total = initial;
  fn(x) { set total = total + x; total; };
};

let acc = make_accumulator(100);
puts("Accumulator: " + str(acc(10)) + ", " + str(acc(20)) + ", " + str(acc(30)));

// === Classes & Inheritance ===
class Animal {
  init(self, name, sound) {
    set self.name = name;
    set self.sound = sound;
  }
  speak(self) {
    self.name + " says " + self.sound
  }
}

class Dog extends Animal {
  init(self, name) {
    super.init(self, name, "woof");
    set self.tricks = 0;
  }
  learn_trick(self) {
    set self.tricks = self.tricks + 1;
  }
  show_off(self) {
    self.name + " knows " + str(self.tricks) + " tricks"
  }
}

let rex = Dog("Rex");
learn_trick(rex);
learn_trick(rex);
learn_trick(rex);
puts(rex.speak());
puts(rex.show_off());

// === Higher-Order Functions ===
let numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
let evens = filter(numbers, fn(x) { x % 2 == 0; });
let doubled = map(evens, fn(x) { x * 2; });
let total = reduce(doubled, 0, fn(acc, x) { acc + x; });
puts("Sum of doubled evens: " + str(total));

// === Pattern Matching ===
enum Direction { North, South, East, West };

let opposite = fn(dir) {
  match dir {
    Direction.North => Direction.South,
    Direction.South => Direction.North,
    Direction.East => Direction.West,
    Direction.West => Direction.East
  }
};

// === Error Handling ===
let safe_sqrt = fn(x) {
  if (x < 0) { throw "cannot take sqrt of negative"; };
  let guess = x / 2;
  for (let i = 0; i < 10; set i = i + 1) {
    set guess = (guess + x / guess) / 2;
  };
  guess;
};

let result = try {
  safe_sqrt(25)
} catch (e) {
  -1
};
puts("sqrt(25) ≈ " + str(result));

// === Iterative Algorithms ===
let is_prime = fn(n) {
  if (n < 2) { return false; };
  let i = 2;
  while (i * i <= n) {
    if (n % i == 0) { return false; };
    set i = i + 1;
  };
  true;
};

let primes = filter(range(2, 50), is_prime);
puts("Primes < 50: " + join(map(primes, str), ", "));

puts("\nAll features working! ✓");
