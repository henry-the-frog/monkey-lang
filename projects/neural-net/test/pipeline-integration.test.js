import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { Conv2D, Flatten } from '../src/conv.js';
import { Dense } from '../src/layer.js';
import { mse } from '../src/loss.js';

function numericalGradient(forwardFn, weightMatrix, i, j, eps = 1e-5) {
  const orig = weightMatrix.get(i, j);
  weightMatrix.set(i, j, orig + eps);
  const lossPlus = forwardFn();
  weightMatrix.set(i, j, orig - eps);
  const lossMinus = forwardFn();
  weightMatrix.set(i, j, orig);
  return (lossPlus - lossMinus) / (2 * eps);
}

function relError(a, b) {
  return Math.abs(a - b) / (Math.abs(a) + Math.abs(b) + 1e-8);
}

describe('Integration: Conv2D → Flatten → Dense pipeline', () => {
  it('end-to-end forward produces correct dimensions', () => {
    const conv = new Conv2D(4, 4, 1, 2, 2, 'relu');  // 4x4 → 3x3×2
    const flatten = new Flatten();
    const dense = new Dense(conv.outputSize, 3, 'softmax');
    
    const input = new Matrix(1, 16).randomize(0.5);
    let x = conv.forward(input);
    x = flatten.forward(x);
    x = dense.forward(x);
    
    assert.equal(x.rows, 1);
    assert.equal(x.cols, 3);
    
    // Softmax output should sum to ~1
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      sum += x.get(0, j);
      assert.ok(x.get(0, j) >= 0, 'Softmax output should be non-negative');
    }
    assert.ok(Math.abs(sum - 1) < 1e-5, `Softmax should sum to 1: ${sum}`);
  });

  it('end-to-end backward propagates gradients through all layers', () => {
    const conv = new Conv2D(4, 4, 1, 2, 2, 'relu');
    const flatten = new Flatten();
    const dense = new Dense(conv.outputSize, 2, 'sigmoid');
    
    const input = new Matrix(1, 16).randomize(0.5);
    const target = new Matrix(1, 2, new Float64Array([1, 0]));
    
    // Forward
    let x = conv.forward(input);
    x = flatten.forward(x);
    x = dense.forward(x);
    
    // Backward
    let grad = mse.gradient(x, target);
    grad = dense.backward(grad);
    grad = flatten.backward(grad);
    grad = conv.backward(grad);
    
    // Conv should have gradients
    let filterGradNorm = 0;
    for (const v of conv.dFilters.data) filterGradNorm += Math.abs(v);
    assert.ok(filterGradNorm > 0, 'Conv filter gradients should be non-zero');
    
    // Dense should have gradients
    let denseGradNorm = 0;
    for (const v of dense.dWeights.data) denseGradNorm += Math.abs(v);
    assert.ok(denseGradNorm > 0, 'Dense weight gradients should be non-zero');
  });

  it('Conv2D weight gradient matches numerical through full pipeline', () => {
    const conv = new Conv2D(4, 4, 1, 2, 2, 'relu');
    const flatten = new Flatten();
    const dense = new Dense(conv.outputSize, 2, 'sigmoid');
    
    const input = new Matrix(1, 16).randomize(0.5);
    const target = new Matrix(1, 2, new Float64Array([1, 0]));
    
    // Forward + backward
    let x = conv.forward(input);
    x = flatten.forward(x);
    x = dense.forward(x);
    let grad = mse.gradient(x, target);
    grad = dense.backward(grad);
    grad = flatten.backward(grad);
    conv.backward(grad);
    
    // Numerical gradient for conv filters
    const forwardAll = () => {
      let y = conv.forward(input);
      y = flatten.forward(y);
      y = dense.forward(y);
      return mse.compute(y, target);
    };
    
    let maxError = 0;
    for (let trial = 0; trial < 8; trial++) {
      const fi = Math.floor(Math.random() * conv.filters.rows);
      const fj = Math.floor(Math.random() * conv.filters.cols);
      const ng = numericalGradient(forwardAll, conv.filters, fi, fj);
      const ag = conv.dFilters.get(fi, fj);
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `Conv2D filter gradient through full pipeline: error ${maxError}`);
  });

  it('Dense weight gradient matches numerical through full pipeline', () => {
    const conv = new Conv2D(4, 4, 1, 2, 2, 'relu');
    const flatten = new Flatten();
    const dense = new Dense(conv.outputSize, 2, 'sigmoid');
    
    const input = new Matrix(1, 16).randomize(0.5);
    const target = new Matrix(1, 2, new Float64Array([1, 0]));
    
    let x = conv.forward(input);
    x = flatten.forward(x);
    x = dense.forward(x);
    let grad = mse.gradient(x, target);
    grad = dense.backward(grad);
    grad = flatten.backward(grad);
    conv.backward(grad);
    
    const forwardAll = () => {
      let y = conv.forward(input);
      y = flatten.forward(y);
      y = dense.forward(y);
      return mse.compute(y, target);
    };
    
    let maxError = 0;
    for (let trial = 0; trial < 8; trial++) {
      const wi = Math.floor(Math.random() * dense.weights.rows);
      const wj = Math.floor(Math.random() * dense.weights.cols);
      const ng = numericalGradient(forwardAll, dense.weights, wi, wj);
      const ag = dense.dWeights.get(wi, wj);
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `Dense gradient through full pipeline: error ${maxError}`);
  });

  it('pipeline trains and reduces loss', () => {
    const conv = new Conv2D(4, 4, 1, 2, 2, 'relu');
    const flatten = new Flatten();
    const dense = new Dense(conv.outputSize, 2, 'sigmoid');
    
    const input = new Matrix(1, 16).randomize(0.5);
    const target = new Matrix(1, 2, new Float64Array([1, 0]));
    
    const losses = [];
    for (let epoch = 0; epoch < 50; epoch++) {
      let x = conv.forward(input);
      x = flatten.forward(x);
      x = dense.forward(x);
      
      const loss = mse.compute(x, target);
      losses.push(loss);
      
      let grad = mse.gradient(x, target);
      grad = dense.backward(grad);
      grad = flatten.backward(grad);
      conv.backward(grad);
      
      conv.update(0.01);
      dense.update(0.01, 0, 'sgd');
    }
    
    assert.ok(losses[49] < losses[0], 
      `Loss should decrease: ${losses[0]} → ${losses[49]}`);
  });
});
