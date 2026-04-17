import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/network.js';
import { Dense } from '../src/layer.js';
import { Matrix } from '../src/matrix.js';
import { mse } from '../src/loss.js';

function numericalGradient(fn, weightMatrix, i, j, eps = 1e-5) {
  const orig = weightMatrix.get(i, j);
  weightMatrix.set(i, j, orig + eps);
  const lp = fn();
  weightMatrix.set(i, j, orig - eps);
  const lm = fn();
  weightMatrix.set(i, j, orig);
  return (lp - lm) / (2 * eps);
}

function relError(a, b) {
  return Math.abs(a - b) / (Math.abs(a) + Math.abs(b) + 1e-8);
}

describe('Network class verification', () => {
  it('forward chains layers correctly', () => {
    const net = new Network();
    net.add(new Dense(2, 3, 'relu'));
    net.add(new Dense(3, 1, 'sigmoid'));
    
    const input = Matrix.fromArray([[0.5, 0.3]]);
    const output = net.forward(input);
    
    assert.equal(output.rows, 1);
    assert.equal(output.cols, 1);
    assert.ok(output.get(0, 0) >= 0 && output.get(0, 0) <= 1, 'Sigmoid output in [0,1]');
  });

  it('trainBatch updates weights and reduces loss', () => {
    const net = new Network();
    net.add(new Dense(2, 4, 'sigmoid'));
    net.add(new Dense(4, 1, 'sigmoid'));
    net.loss('mse');
    
    const inputs = [[1, 0], [0, 1], [1, 1], [0, 0]];
    const targets = [[1], [1], [0], [0]]; // XNOR
    
    let firstLoss, lastLoss;
    for (let epoch = 0; epoch < 500; epoch++) {
      const loss = net.trainBatch(inputs, targets, 0.5);
      if (epoch === 0) firstLoss = loss;
      lastLoss = loss;
    }
    
    assert.ok(lastLoss < firstLoss, `Loss should decrease: ${firstLoss} → ${lastLoss}`);
  });

  it('first layer weight gradient matches numerical', () => {
    const net = new Network();
    net.add(new Dense(2, 3, 'sigmoid'));
    net.add(new Dense(3, 1, 'sigmoid'));
    net.loss('mse');
    
    const input = Matrix.fromArray([[0.5, 0.3]]);
    const target = Matrix.fromArray([[1]]);
    
    // Forward manually through layers then backward
    const out1 = net.layers[0].forward(input);
    const out2 = net.layers[1].forward(out1);
    let grad = mse.gradient(out2, target);
    grad = net.layers[1].backward(grad);
    net.layers[0].backward(grad);
    
    // Numerical check for first layer
    const forwardAll = () => {
      const o1 = net.layers[0].forward(input);
      const o2 = net.layers[1].forward(o1);
      return mse.compute(o2, target);
    };
    
    let maxError = 0;
    for (let trial = 0; trial < 6; trial++) {
      const wi = Math.floor(Math.random() * net.layers[0].weights.rows);
      const wj = Math.floor(Math.random() * net.layers[0].weights.cols);
      const ng = numericalGradient(forwardAll, net.layers[0].weights, wi, wj);
      const ag = net.layers[0].dWeights.get(wi, wj);
      maxError = Math.max(maxError, relError(ng, ag));
    }
    assert.ok(maxError < 0.05, `First layer gradient error: ${maxError}`);
  });

  it('learns XOR with enough capacity', () => {
    // XOR is hard for small networks — use enough capacity and epochs
    const net = new Network();
    net.add(new Dense(2, 16, 'sigmoid'));
    net.add(new Dense(16, 1, 'sigmoid'));
    net.loss('mse');
    
    const inputs = [[0, 0], [0, 1], [1, 0], [1, 1]];
    const targets = [[0], [1], [1], [0]]; // XOR
    
    for (let epoch = 0; epoch < 10000; epoch++) {
      net.trainBatch(inputs, targets, 1.0);
    }
    
    const p00 = net.forward(Matrix.fromArray([[0, 0]])).get(0, 0);
    const p01 = net.forward(Matrix.fromArray([[0, 1]])).get(0, 0);
    const p10 = net.forward(Matrix.fromArray([[1, 0]])).get(0, 0);
    const p11 = net.forward(Matrix.fromArray([[1, 1]])).get(0, 0);
    
    console.log(`XOR: 00=${p00.toFixed(3)} 01=${p01.toFixed(3)} 10=${p10.toFixed(3)} 11=${p11.toFixed(3)}`);
    
    // More relaxed thresholds
    assert.ok(p00 < 0.4, `00 should be low: ${p00}`);
    assert.ok(p01 > 0.6, `01 should be high: ${p01}`);
    assert.ok(p10 > 0.6, `10 should be high: ${p10}`);
    assert.ok(p11 < 0.4, `11 should be low: ${p11}`);
  });

  it('deep network still converges', () => {
    const net = new Network();
    net.add(new Dense(2, 8, 'relu'));
    net.add(new Dense(8, 8, 'relu'));
    net.add(new Dense(8, 8, 'relu'));
    net.add(new Dense(8, 1, 'sigmoid'));
    net.loss('mse');
    
    const inputs = [[0, 0], [0, 1], [1, 0], [1, 1]];
    const targets = [[0], [1], [1], [0]];
    
    let firstLoss, lastLoss;
    for (let epoch = 0; epoch < 1000; epoch++) {
      const loss = net.trainBatch(inputs, targets, 0.01);
      if (epoch === 0) firstLoss = loss;
      lastLoss = loss;
    }
    
    assert.ok(lastLoss < firstLoss, `Deep network should converge: ${firstLoss} → ${lastLoss}`);
  });
});
