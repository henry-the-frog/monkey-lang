// Class syntax demo

class Shape {
  init(self, type) {
    set self.type = type;
  }
  describe(self) {
    "I am a " + self.type
  }
}

class Circle extends Shape {
  init(self, radius) {
    super.init(self, "circle");
    set self.radius = radius;
  }
  describe(self) {
    "Circle with radius " + str(self.radius)
  }
  area(self) {
    3 * self.radius * self.radius
  }
}

class Rectangle extends Shape {
  init(self, width, height) {
    super.init(self, "rectangle");
    set self.width = width;
    set self.height = height;
  }
  describe(self) {
    str(self.width) + "x" + str(self.height) + " rectangle"
  }
  area(self) {
    self.width * self.height
  }
}

let c = Circle(5);
let r = Rectangle(3, 4);

puts(c.describe());
puts("Area: " + str(c.area()));
puts(r.describe());
puts("Area: " + str(r.area()));
