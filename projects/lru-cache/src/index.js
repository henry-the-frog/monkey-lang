// ===== LRU Cache =====
// O(1) get/put using doubly-linked list + hash map

class DLLNode {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.prev = null;
    this.next = null;
  }
}

export class LRUCache {
  constructor(capacity, options = {}) {
    if (capacity < 1) throw new Error('Capacity must be at least 1');
    this.capacity = capacity;
    this._onEvict = options.onEvict || null;
    this.map = new Map();
    
    // Sentinel nodes
    this.head = new DLLNode(null, null); // most recently used
    this.tail = new DLLNode(null, null); // least recently used
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  get size() { return this.map.size; }

  get(key) {
    const node = this.map.get(key);
    if (!node) return undefined;
    
    // Move to front (most recently used)
    this._remove(node);
    this._addToFront(node);
    
    return node.value;
  }

  put(key, value) {
    if (this.map.has(key)) {
      // Update existing
      const node = this.map.get(key);
      node.value = value;
      this._remove(node);
      this._addToFront(node);
      return;
    }

    // Add new
    const node = new DLLNode(key, value);
    this.map.set(key, node);
    this._addToFront(node);

    // Evict if over capacity
    if (this.map.size > this.capacity) {
      const evicted = this.tail.prev;
      this._remove(evicted);
      this.map.delete(evicted.key);
      if (this._onEvict) this._onEvict(evicted.key, evicted.value);
    }
  }

  has(key) { return this.map.has(key); }

  delete(key) {
    const node = this.map.get(key);
    if (!node) return false;
    this._remove(node);
    this.map.delete(key);
    return true;
  }

  clear() {
    this.map.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  // Get all keys in MRU→LRU order
  keys() {
    const result = [];
    let node = this.head.next;
    while (node !== this.tail) {
      result.push(node.key);
      node = node.next;
    }
    return result;
  }

  // Get all entries in MRU→LRU order
  entries() {
    const result = [];
    let node = this.head.next;
    while (node !== this.tail) {
      result.push([node.key, node.value]);
      node = node.next;
    }
    return result;
  }

  // Peek without updating access order
  peek(key) {
    const node = this.map.get(key);
    return node ? node.value : undefined;
  }

  // Get the least recently used key
  get lruKey() {
    return this.tail.prev !== this.head ? this.tail.prev.key : undefined;
  }

  // Get the most recently used key
  get mruKey() {
    return this.head.next !== this.tail ? this.head.next.key : undefined;
  }

  // Internal: remove node from list
  _remove(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  // Internal: add node right after head
  _addToFront(node) {
    node.next = this.head.next;
    node.prev = this.head;
    this.head.next.prev = node;
    this.head.next = node;
  }

  [Symbol.iterator]() {
    let node = this.head.next;
    const tail = this.tail;
    return {
      next() {
        if (node === tail) return { done: true };
        const result = { value: [node.key, node.value], done: false };
        node = node.next;
        return result;
      }
    };
  }

  set(key, value) {
    this.put(key, value);
    return this;
  }

  values() {
    const result = [];
    let node = this.head.next;
    while (node !== this.tail) {
      result.push(node.value);
      node = node.next;
    }
    return result;
  }

  forEach(fn) {
    let node = this.head.next;
    while (node !== this.tail) {
      fn(node.value, node.key, this);
      node = node.next;
    }
  }

  resize(newCapacity) {
    this.capacity = newCapacity;
    while (this.map.size > this.capacity) {
      const evicted = this.tail.prev;
      this._remove(evicted);
      this.map.delete(evicted.key);
      if (this._onEvict) this._onEvict(evicted.key, evicted.value);
    }
    return this;
  }
}

// ===== TTL-aware LRU Cache =====

export class TTLCache extends LRUCache {
  constructor(capacity, defaultTTL = Infinity) {
    super(capacity);
    this.defaultTTL = defaultTTL;
    this.expiry = new Map();
  }

  put(key, value, ttl = this.defaultTTL) {
    super.put(key, value);
    if (ttl !== Infinity) {
      this.expiry.set(key, Date.now() + ttl);
    }
  }

  get(key) {
    if (this.expiry.has(key) && Date.now() > this.expiry.get(key)) {
      this.delete(key);
      this.expiry.delete(key);
      return undefined;
    }
    return super.get(key);
  }

  has(key) {
    if (this.expiry.has(key) && Date.now() > this.expiry.get(key)) {
      this.delete(key);
      this.expiry.delete(key);
      return false;
    }
    return super.has(key);
  }

  delete(key) {
    this.expiry.delete(key);
    return super.delete(key);
  }

  clear() {
    this.expiry.clear();
    super.clear();
  }
}
