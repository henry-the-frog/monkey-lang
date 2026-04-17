// ===== Trie (Prefix Tree) =====

class TrieNode {
  constructor() {
    this.children = new Map();
    this.isEnd = false;
    this.value = undefined;
    this.count = 0; // number of words through this node
  }
}

export class Trie {
  constructor() {
    this.root = new TrieNode();
    this._size = 0;
  }

  get size() { return this._size; }

  insert(word, value = true) {
    let node = this.root;
    for (const char of word) {
      if (!node.children.has(char)) {
        node.children.set(char, new TrieNode());
      }
      node = node.children.get(char);
      node.count++;
    }
    if (!node.isEnd) this._size++;
    node.isEnd = true;
    node.value = value;
    return this;
  }

  search(word) {
    const node = this._findNode(word);
    return node && node.isEnd ? node.value : undefined;
  }

  has(word) {
    const node = this._findNode(word);
    return node !== null && node.isEnd;
  }

  startsWith(prefix) {
    return this._findNode(prefix) !== null;
  }

  // Autocomplete: find all words with given prefix
  autocomplete(prefix, limit = Infinity) {
    const node = this._findNode(prefix);
    if (!node) return [];
    
    const results = [];
    this._collect(node, prefix, results, limit);
    return results;
  }

  delete(word) {
    const node = this._findNode(word);
    if (!node || !node.isEnd) return false;
    this._deleteHelper(this.root, word, 0);
    return true;
  }

  // Get all words in the trie
  words() {
    const result = [];
    this._collect(this.root, '', result, Infinity);
    return result;
  }

  // Count words with given prefix
  countPrefix(prefix) {
    const node = this._findNode(prefix);
    return node ? node.count : 0;
  }

  // Longest common prefix of all words
  longestCommonPrefix() {
    let prefix = '';
    let node = this.root;
    
    while (node.children.size === 1 && !node.isEnd) {
      const [char, child] = [...node.children][0];
      prefix += char;
      node = child;
    }
    
    return prefix;
  }

  // ===== Internal =====

  _findNode(prefix) {
    let node = this.root;
    for (const char of prefix) {
      if (!node.children.has(char)) return null;
      node = node.children.get(char);
    }
    return node;
  }

  _collect(node, prefix, results, limit) {
    if (results.length >= limit) return;
    if (node.isEnd) results.push(prefix);
    
    for (const [char, child] of node.children) {
      if (results.length >= limit) return;
      this._collect(child, prefix + char, results, limit);
    }
  }

  _deleteHelper(node, word, depth) {
    if (depth === word.length) {
      if (!node.isEnd) return false;
      node.isEnd = false;
      node.value = undefined;
      this._size--;
      return node.children.size === 0;
    }

    const char = word[depth];
    const child = node.children.get(char);
    if (!child) return false;

    child.count--;
    const shouldDelete = this._deleteHelper(child, word, depth + 1);

    if (shouldDelete) {
      node.children.delete(char);
      return !node.isEnd && node.children.size === 0;
    }

    return false;
  }

  clear() {
    this.root = new TrieNode();
    this._size = 0;
  }
}
