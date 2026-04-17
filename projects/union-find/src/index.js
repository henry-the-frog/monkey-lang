// ===== Disjoint Set (Union-Find) =====
// With path compression and union by rank — nearly O(1) amortized

export class UnionFind {
  constructor(n = 0) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
    this.sizes = new Array(n).fill(1);
    this._componentCount = n;
  }

  // Make a new set
  makeSet(x = this.parent.length) {
    if (x >= this.parent.length) {
      while (this.parent.length <= x) {
        const id = this.parent.length;
        this.parent.push(id);
        this.rank.push(0);
        this.sizes.push(1);
        this._componentCount++;
      }
    }
    return x;
  }

  // Find with path compression
  find(x) {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }

  // Union by rank
  union(x, y) {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return false;

    if (this.rank[rx] < this.rank[ry]) {
      this.parent[rx] = ry;
      this.sizes[ry] += this.sizes[rx];
    } else if (this.rank[rx] > this.rank[ry]) {
      this.parent[ry] = rx;
      this.sizes[rx] += this.sizes[ry];
    } else {
      this.parent[ry] = rx;
      this.sizes[rx] += this.sizes[ry];
      this.rank[rx]++;
    }

    this._componentCount--;
    return true;
  }

  connected(x, y) { return this.find(x) === this.find(y); }
  componentSize(x) { return this.sizes[this.find(x)]; }
  get componentCount() { return this._componentCount; }
  get count() { return this._componentCount; }

  // Get all components as arrays
  components() {
    const groups = new Map();
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    }
    return [...groups.values()];
  }
}

// ===== Weighted Union-Find =====
// Each element has a weight relative to its root

export class WeightedUnionFind {
  constructor(n = 0) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
    this.weight = new Array(n).fill(0); // weight[x] = weight of x relative to parent
  }

  // weight[x] = weight of x relative to root
  // find(x) ensures weight[x] points to root

  find(x) {
    if (this.parent[x] === x) return x;
    const root = this.find(this.parent[x]);
    this.weight[x] += this.weight[this.parent[x]];
    this.parent[x] = root;
    return root;
  }

  // Union x and y: weight[x] - weight[y] = w
  union(x, y, w) {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return false;

    // weight[x] relative to rx is this.weight[x]
    // weight[y] relative to ry is this.weight[y]
    // We want: weight[rx] relative to ry = w + weight[y] - weight[x]
    const relativeWeight = w + this.weight[y] - this.weight[x];
    
    if (this.rank[rx] < this.rank[ry]) {
      this.parent[rx] = ry;
      this.weight[rx] = relativeWeight;
    } else {
      this.parent[ry] = rx;
      this.weight[ry] = -relativeWeight;
      if (this.rank[rx] === this.rank[ry]) this.rank[rx]++;
    }
    return true;
  }

  // diff(x, y) = weight[x] - weight[y]
  diff(x, y) {
    if (this.find(x) !== this.find(y)) return undefined;
    return this.weight[x] - this.weight[y];
  }

  connected(x, y) { return this.find(x) === this.find(y); }
}
