// ===== Interval Tree =====
// Augmented BST for efficient interval overlap queries

class ITNode {
  constructor(lo, hi, data = null) {
    this.lo = lo;
    this.hi = hi;
    this.data = data;
    this.max = hi;
    this.left = null;
    this.right = null;
  }
}

export class IntervalTree {
  constructor() { this.root = null; this._size = 0; }
  get size() { return this._size; }

  insert(lo, hi, data = null) {
    this.root = this._insert(this.root, lo, hi, data);
    this._size++;
  }

  _insert(node, lo, hi, data) {
    if (!node) return new ITNode(lo, hi, data);
    
    if (lo < node.lo) node.left = this._insert(node.left, lo, hi, data);
    else node.right = this._insert(node.right, lo, hi, data);
    
    node.max = Math.max(node.max, hi);
    return node;
  }

  // Find all intervals overlapping [lo, hi]
  search(lo, hi) {
    const results = [];
    this._search(this.root, lo, hi, results);
    return results;
  }

  _search(node, lo, hi, results) {
    if (!node) return;
    
    // Check if this interval overlaps query
    if (node.lo <= hi && lo <= node.hi) {
      results.push({ lo: node.lo, hi: node.hi, data: node.data });
    }
    
    // If left child's max >= lo, there might be overlaps in left subtree
    if (node.left && node.left.max >= lo) {
      this._search(node.left, lo, hi, results);
    }
    
    // Always check right if current interval start <= hi
    if (node.right) {
      this._search(node.right, lo, hi, results);
    }
  }

  // Find all intervals containing a point
  queryPoint(point) {
    return this.search(point, point);
  }

  // Check if any interval overlaps [lo, hi]
  hasOverlap(lo, hi) {
    return this._hasOverlap(this.root, lo, hi);
  }

  _hasOverlap(node, lo, hi) {
    if (!node) return false;
    if (node.lo <= hi && lo <= node.hi) return true;
    if (node.left && node.left.max >= lo && this._hasOverlap(node.left, lo, hi)) return true;
    return this._hasOverlap(node.right, lo, hi);
  }

  // Get all intervals
  all() {
    const results = [];
    this._inOrder(this.root, results);
    return results;
  }

  _inOrder(node, results) {
    if (!node) return;
    this._inOrder(node.left, results);
    results.push({ lo: node.lo, hi: node.hi, data: node.data });
    this._inOrder(node.right, results);
  }

  // Find the interval with the minimum low endpoint
  min() {
    let node = this.root;
    if (!node) return null;
    while (node.left) node = node.left;
    return { lo: node.lo, hi: node.hi, data: node.data };
  }
}

IntervalTree.prototype.contains = function(point) { return this.queryPoint(point); };
IntervalTree.prototype.toArray = function() { return this.all(); };
