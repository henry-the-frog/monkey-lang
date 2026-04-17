/**
 * Tiny Graph Database
 * 
 * Property graph with query language:
 * - Nodes with labels and properties
 * - Edges with types and properties
 * - Cypher-like queries
 * - Traversals: BFS, DFS, shortest path
 * - Pattern matching
 * - Aggregation
 */

class GraphDB {
  constructor() {
    this.nodes = new Map(); // id -> {id, labels, props}
    this.edges = new Map(); // id -> {id, from, to, type, props}
    this.nextNodeId = 1;
    this.nextEdgeId = 1;
    this.outEdges = new Map(); // nodeId -> [edgeId]
    this.inEdges = new Map();  // nodeId -> [edgeId]
  }

  addNode(labels = [], props = {}) {
    const id = this.nextNodeId++;
    labels = Array.isArray(labels) ? labels : [labels];
    this.nodes.set(id, { id, labels, props: { ...props } });
    this.outEdges.set(id, []);
    this.inEdges.set(id, []);
    return id;
  }

  addEdge(from, to, type, props = {}) {
    const id = this.nextEdgeId++;
    this.edges.set(id, { id, from, to, type, props: { ...props } });
    this.outEdges.get(from).push(id);
    this.inEdges.get(to).push(id);
    return id;
  }

  getNode(id) { return this.nodes.get(id); }
  getEdge(id) { return this.edges.get(id); }

  deleteNode(id) {
    // Remove all connected edges
    for (const eid of [...(this.outEdges.get(id) || []), ...(this.inEdges.get(id) || [])]) {
      this.deleteEdge(eid);
    }
    this.nodes.delete(id);
    this.outEdges.delete(id);
    this.inEdges.delete(id);
  }

  deleteEdge(id) {
    const edge = this.edges.get(id);
    if (!edge) return;
    const out = this.outEdges.get(edge.from);
    if (out) this.outEdges.set(edge.from, out.filter(e => e !== id));
    const inn = this.inEdges.get(edge.to);
    if (inn) this.inEdges.set(edge.to, inn.filter(e => e !== id));
    this.edges.delete(id);
  }

  // Query: find nodes by label and/or properties
  findNodes(label = null, props = {}) {
    const results = [];
    for (const node of this.nodes.values()) {
      if (label && !node.labels.includes(label)) continue;
      let match = true;
      for (const [k, v] of Object.entries(props)) {
        if (node.props[k] !== v) { match = false; break; }
      }
      if (match) results.push(node);
    }
    return results;
  }

  // Get neighbors
  neighbors(nodeId, direction = 'out', type = null) {
    const edgeIds = direction === 'out' ? this.outEdges.get(nodeId) :
                    direction === 'in' ? this.inEdges.get(nodeId) :
                    [...(this.outEdges.get(nodeId) || []), ...(this.inEdges.get(nodeId) || [])];
    
    const results = [];
    for (const eid of edgeIds || []) {
      const edge = this.edges.get(eid);
      if (type && edge.type !== type) continue;
      const neighborId = edge.from === nodeId ? edge.to : edge.from;
      results.push({ node: this.nodes.get(neighborId), edge });
    }
    return results;
  }

  // Traversals
  bfs(startId, opts = {}) {
    const visited = new Set();
    const queue = [startId];
    const result = [];
    const maxDepth = opts.maxDepth || Infinity;
    const depths = new Map([[startId, 0]]);

    while (queue.length > 0) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      const depth = depths.get(id);
      result.push({ node: this.nodes.get(id), depth });
      
      if (depth < maxDepth) {
        for (const { node } of this.neighbors(id, opts.direction || 'both', opts.type)) {
          if (!visited.has(node.id)) {
            queue.push(node.id);
            if (!depths.has(node.id)) depths.set(node.id, depth + 1);
          }
        }
      }
    }
    return result;
  }

  shortestPath(fromId, toId) {
    const visited = new Set();
    const queue = [[fromId, [fromId]]];
    visited.add(fromId);

    while (queue.length > 0) {
      const [current, path] = queue.shift();
      if (current === toId) return path.map(id => this.nodes.get(id));
      
      for (const { node } of this.neighbors(current, 'both')) {
        if (!visited.has(node.id)) {
          visited.add(node.id);
          queue.push([node.id, [...path, node.id]]);
        }
      }
    }
    return null;
  }

  // Pattern match: (node1)-[type]->(node2)
  match(pattern) {
    // Simple edge type match: { type: 'KNOWS' }
    if (pattern.type && !pattern.from && !pattern.to) {
      const results = [];
      for (const edge of this.edges.values()) {
        if (edge.type === pattern.type) results.push(edge);
      }
      return results;
    }
    
    const { from, edge: edgeType, to } = pattern;
    const results = [];
    
    const fromNodes = from.label ? this.findNodes(from.label, from.props || {}) : [...this.nodes.values()];
    
    for (const fromNode of fromNodes) {
      for (const { node: toNode, edge } of this.neighbors(fromNode.id, 'out', edgeType)) {
        if (to.label && !toNode.labels.includes(to.label)) continue;
        let match = true;
        for (const [k, v] of Object.entries(to.props || {})) {
          if (toNode.props[k] !== v) { match = false; break; }
        }
        if (match) results.push({ from: fromNode, edge, to: toNode });
      }
    }
    return results;
  }

  get nodeCount() { return this.nodes.size; }
  get edgeCount() { return this.edges.size; }
}

module.exports = GraphDB;
module.exports.GraphDB = GraphDB;
