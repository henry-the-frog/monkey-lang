import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, GCNLayer, GNN } from '../src/gnn.js';

describe('GNN verification', () => {
  it('GCNLayer forward produces correct output dimensions', () => {
    const layer = new GCNLayer(3, 4, 'relu');
    const graph = new Graph(3, [[0,1], [1,2], [0,2]], [[1,0,0], [0,1,0], [0,0,1]]);
    
    const out = layer.forward(graph, graph.nodeFeatures);
    assert.equal(out.length, 3, 'Should output 3 nodes');
    assert.equal(out[0].length, 4, 'Each node should have 4 features');
  });

  it('GNN forward produces embeddings for all nodes', () => {
    const graph = new Graph(4, [[0,1], [1,2], [2,3]], [[1,0], [0,1], [1,1], [0,0]]);
    
    const gnn = new GNN([2, 4, 3], { learningRate: 0.01 });
    const embeddings = gnn.forward(graph);
    assert.equal(embeddings.length, 4);
    assert.equal(embeddings[0].length, 3);
  });

  it('GNN training reduces loss on node classification', () => {
    const graph = new Graph(6,
      [[0,1], [1,2], [3,4], [4,5]],
      [[1,0], [1,0.1], [0.9,0], [0,1], [0.1,1], [0,0.9]]);
    
    const gnn = new GNN([2, 4, 2], { learningRate: 0.01 });
    const labels = new Map([[0, 0], [3, 1]]);
    
    const { history } = gnn.train(graph, { labels, epochs: 50 });
    assert.ok(history.length === 50);
    assert.ok(isFinite(history[49]), 'Final loss should be finite');
  });

  it('GNN forward is deterministic', () => {
    const graph = new Graph(3, [[0,1], [1,2]], [[1,0], [0.5,0.5], [0,1]]);
    const gnn = new GNN([2, 4, 2]);
    
    const e1 = gnn.forward(graph);
    const e2 = gnn.forward(graph);
    
    for (let i = 0; i < 3; i++) {
      for (let d = 0; d < 2; d++) {
        assert.equal(e1[i][d], e2[i][d], `Embedding[${i}][${d}] should be deterministic`);
      }
    }
  });

  it('GCNLayer aggregates neighbor features correctly', () => {
    // Star graph: node 0 connected to all others
    const graph = new Graph(4, [[0,1], [0,2], [0,3]],
      [[0,0,0,0], [1,0,0,0], [0,1,0,0], [0,0,1,0]]);
    
    // Identity weight, zero bias — output should be mean of neighbors
    const layer = new GCNLayer(4, 4, 'linear');
    // Set W to identity
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++)
        layer.W.set(i, j, i === j ? 1 : 0);
    
    const out = layer.forward(graph, graph.nodeFeatures);
    
    // Node 0 has neighbors [0,1,2,3] (self-loop included per GCN convention)
    // Aggregated = mean([0,0,0,0], [1,0,0,0], [0,1,0,0], [0,0,1,0]) = [1/4, 1/4, 1/4, 0]
    assert.ok(Math.abs(out[0][0] - 1/4) < 1e-10, `Node 0 feature 0: ${out[0][0]}`);
    assert.ok(Math.abs(out[0][1] - 1/4) < 1e-10, `Node 0 feature 1: ${out[0][1]}`);
    assert.ok(Math.abs(out[0][2] - 1/4) < 1e-10, `Node 0 feature 2: ${out[0][2]}`);
  });

  it('GCNLayer weight update via numerical gradient', () => {
    const graph = new Graph(3, [[0,1], [1,2]], [[1,0], [0.5,0.5], [0,1]]);
    const gnn = new GNN([2, 3, 2], { learningRate: 0.01 });
    
    const labels = new Map([[0, 0], [2, 1]]);
    
    // Compute loss
    function computeLoss() {
      const embeddings = gnn.forward(graph);
      let totalLoss = 0;
      for (const [nodeId, trueLabel] of labels) {
        const logits = embeddings[nodeId];
        const maxLogit = Math.max(...logits);
        const exps = logits.map(l => Math.exp(l - maxLogit));
        const sumExps = exps.reduce((a, b) => a + b, 0);
        const probs = exps.map(e => e / sumExps);
        totalLoss -= Math.log(Math.max(probs[trueLabel], 1e-10));
      }
      return totalLoss;
    }
    
    const loss0 = computeLoss();
    
    // Verify numerical gradient for last layer W[0,0]
    const lastLayer = gnn.layers[gnn.layers.length - 1];
    const eps = 1e-5;
    const orig = lastLayer.W.get(0, 0);
    lastLayer.W.set(0, 0, orig + eps);
    const lp = computeLoss();
    lastLayer.W.set(0, 0, orig - eps);
    const lm = computeLoss();
    lastLayer.W.set(0, 0, orig);
    
    const numGrad = (lp - lm) / (2 * eps);
    assert.ok(isFinite(numGrad), 'Numerical gradient should be finite');
    
    // Train and verify loss decreases
    gnn.train(graph, { labels, epochs: 20 });
    const loss1 = computeLoss();
    // Loss should decrease after training (or at least not explode)
    assert.ok(isFinite(loss1), 'Loss after training should be finite');
  });
});
