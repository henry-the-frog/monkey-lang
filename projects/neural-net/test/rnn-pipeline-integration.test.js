import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { Embedding } from '../src/embedding.js';
import { LSTM } from '../src/rnn.js';
import { Dense } from '../src/layer.js';
import { mse } from '../src/loss.js';

function relError(a, b) {
  return Math.abs(a - b) / (Math.abs(a) + Math.abs(b) + 1e-8);
}

describe('Integration: Embedding → LSTM → Dense pipeline', () => {
  it('forward produces correct dimensions', () => {
    const emb = new Embedding(10, 4); // vocab=10, dim=4
    const lstm = new LSTM(4, 6, false); // input=4, hidden=6
    const dense = new Dense(6, 3, 'softmax');
    
    // Input: batch=1, seqLen=3 (token IDs)
    const input = Matrix.fromArray([[2, 5, 7]]);
    
    let x = emb.forward(input);  // [1, 12] (3 positions × 4 dims)
    x = lstm.forward(x);         // [1, 6] (last hidden state)
    x = dense.forward(x);        // [1, 3]
    
    assert.equal(x.rows, 1);
    assert.equal(x.cols, 3);
  });

  it('backward propagates through full pipeline', () => {
    const emb = new Embedding(10, 4);
    const lstm = new LSTM(4, 6, false);
    const dense = new Dense(6, 3, 'sigmoid');
    
    const input = Matrix.fromArray([[2, 5, 7]]);
    const target = Matrix.fromArray([[1, 0, 0]]);
    
    // Forward
    let x = emb.forward(input);
    x = lstm.forward(x);
    x = dense.forward(x);
    
    // Backward
    let grad = mse.gradient(x, target);
    grad = dense.backward(grad);
    grad = lstm.backward(grad);
    emb.backward(grad);
    
    // Check gradients exist
    assert.ok(dense.dWeights, 'Dense should have gradients');
    let denseGradNorm = 0;
    for (const v of dense.dWeights.data) denseGradNorm += Math.abs(v);
    assert.ok(denseGradNorm > 0, 'Dense gradients should be non-zero');
    
    // LSTM should have gradients
    let lstmGradNorm = 0;
    for (const v of lstm._dWi.data) lstmGradNorm += Math.abs(v);
    assert.ok(lstmGradNorm > 0, 'LSTM Wi gradients should be non-zero');
    
    // Embedding should have gradients
    let embGradNorm = 0;
    for (const v of emb.dWeights.data) embGradNorm += Math.abs(v);
    assert.ok(embGradNorm > 0, 'Embedding gradients should be non-zero');
  });

  it('Dense gradient through pipeline matches numerical', () => {
    const emb = new Embedding(10, 4);
    const lstm = new LSTM(4, 6, false);
    const dense = new Dense(6, 2, 'sigmoid');
    
    const input = Matrix.fromArray([[1, 3]]);
    const target = Matrix.fromArray([[1, 0]]);
    
    // Forward + backward
    let x = emb.forward(input);
    x = lstm.forward(x);
    x = dense.forward(x);
    let grad = mse.gradient(x, target);
    grad = dense.backward(grad);
    lstm.backward(grad);
    
    // Numerical gradient for dense weights
    const eps = 1e-5;
    let maxError = 0;
    for (let trial = 0; trial < 6; trial++) {
      const wi = Math.floor(Math.random() * dense.weights.rows);
      const wj = Math.floor(Math.random() * dense.weights.cols);
      const orig = dense.weights.get(wi, wj);
      
      dense.weights.set(wi, wj, orig + eps);
      let y = emb.forward(input);
      y = lstm.forward(y);
      y = dense.forward(y);
      const lp = mse.compute(y, target);
      
      dense.weights.set(wi, wj, orig - eps);
      y = emb.forward(input);
      y = lstm.forward(y);
      y = dense.forward(y);
      const lm = mse.compute(y, target);
      
      dense.weights.set(wi, wj, orig);
      
      const ng = (lp - lm) / (2 * eps);
      const ag = dense.dWeights.get(wi, wj);
      maxError = Math.max(maxError, relError(ng, ag));
    }
    assert.ok(maxError < 0.05, `Dense gradient through Emb→LSTM→Dense: error ${maxError}`);
  });

  it('training reduces loss on sequence classification', () => {
    const emb = new Embedding(5, 4);
    const lstm = new LSTM(4, 8, false);
    const dense = new Dense(8, 2, 'sigmoid');
    
    // Train: sequences starting with 1 → class [1,0], starting with 2 → class [0,1]
    const data = [
      { input: [1, 3, 4], target: [1, 0] },
      { input: [1, 4, 3], target: [1, 0] },
      { input: [2, 3, 4], target: [0, 1] },
      { input: [2, 4, 3], target: [0, 1] },
    ];
    
    const losses = [];
    for (let epoch = 0; epoch < 100; epoch++) {
      let epochLoss = 0;
      for (const { input, target } of data) {
        const inp = Matrix.fromArray([input]);
        const tgt = Matrix.fromArray([target]);
        
        let x = emb.forward(inp);
        x = lstm.forward(x);
        x = dense.forward(x);
        
        epochLoss += mse.compute(x, tgt);
        
        let grad = mse.gradient(x, tgt);
        grad = dense.backward(grad);
        grad = lstm.backward(grad);
        emb.backward(grad);
        
        dense.update(0.01, 0, 'sgd');
        lstm.update(0.01);
        emb.update(0.01);
      }
      losses.push(epochLoss);
    }
    
    assert.ok(losses[99] < losses[0], 
      `Loss should decrease: ${losses[0].toFixed(4)} → ${losses[99].toFixed(4)}`);
  });
});
