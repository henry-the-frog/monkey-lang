import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { Conv2D, MaxPool2D, Flatten } from '../src/conv.js';
import { Autoencoder } from '../src/autoencoder.js';
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

describe('Conv2D gradient verification', () => {
  it('filter gradients match numerical', () => {
    // 4x4 input, 1 channel, 2 filters, 2x2 kernel
    const conv = new Conv2D(4, 4, 1, 2, 2, 'relu');
    const input = new Matrix(1, 16).randomize(0.5);
    const target = new Matrix(1, conv.outputSize).randomize(0.5);
    
    const output = conv.forward(input);
    const dOutput = mse.gradient(output, target);
    conv.backward(dOutput);
    
    let maxError = 0;
    for (let trial = 0; trial < 6; trial++) {
      const fi = Math.floor(Math.random() * conv.filters.rows);
      const fj = Math.floor(Math.random() * conv.filters.cols);
      const ng = numericalGradient(() => {
        return mse.compute(conv.forward(input), target);
      }, conv.filters, fi, fj);
      const ag = conv.dFilters.get(fi, fj);
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `Conv2D filter gradient error: ${maxError}`);
  });

  it('input gradients match numerical', () => {
    const conv = new Conv2D(4, 4, 1, 2, 2, 'relu');
    const input = new Matrix(1, 16).randomize(0.5);
    const target = new Matrix(1, conv.outputSize).randomize(0.5);
    
    const output = conv.forward(input);
    const dInput = conv.backward(mse.gradient(output, target));
    
    let maxError = 0;
    for (let trial = 0; trial < 8; trial++) {
      const j = Math.floor(Math.random() * 16);
      const ng = numericalGradient(() => {
        return mse.compute(conv.forward(input), target);
      }, input, 0, j);
      const err = relError(ng, dInput.get(0, j));
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `Conv2D input gradient error: ${maxError}`);
  });

  it('double-division bug is fixed', () => {
    const conv = new Conv2D(4, 4, 1, 1, 2, 'relu');
    const input = new Matrix(2, 16).randomize(0.5); // batch=2
    const target = new Matrix(2, conv.outputSize).randomize(0.5);
    
    conv.forward(input);
    conv.backward(mse.gradient(conv.forward(input), target));
    
    const gradBefore = conv.dFilters.get(0, 0);
    const weightBefore = conv.filters.get(0, 0);
    conv.update(0.01);
    const weightAfter = conv.filters.get(0, 0);
    
    // Expected: weight - lr * grad (NOT weight - lr * grad / batchSize)
    const expected = weightBefore - 0.01 * gradBefore;
    assert.ok(Math.abs(weightAfter - expected) < 1e-10,
      `Update should use grad directly: expected ${expected}, got ${weightAfter}`);
  });
});

describe('Autoencoder verification', () => {
  it('trains and reduces reconstruction loss', () => {
    const ae = new Autoencoder(4, 2, [3]);
    
    const data = new Matrix(50, 4);
    for (let i = 0; i < 50; i++) {
      data.set(i, 0, 0.1); data.set(i, 1, 0.9);
      data.set(i, 2, 0.2); data.set(i, 3, 0.8);
    }
    
    const history = ae.train(data, { epochs: 50, learningRate: 0.01 });
    assert.ok(history.length === 50);
    assert.ok(isFinite(history[49]));
    assert.ok(history[49] < history[0], 
      `Loss should decrease: ${history[0]} → ${history[49]}`);
  });

  it('encodes and decodes preserving structure', () => {
    const ae = new Autoencoder(4, 2);
    
    const data = new Matrix(100, 4);
    for (let i = 0; i < 100; i++) {
      data.set(i, 0, 0.1); data.set(i, 1, 0.9);
      data.set(i, 2, 0.2); data.set(i, 3, 0.8);
    }
    
    ae.train(data, { epochs: 200, learningRate: 0.01 });
    
    // Encode then decode
    const encoded = ae.encode(Matrix.fromArray([[0.1, 0.9, 0.2, 0.8]]));
    assert.equal(encoded.cols, 2, 'Encoded should be 2D');
    
    const decoded = ae.decode(encoded);
    assert.equal(decoded.cols, 4, 'Decoded should be 4D');
    
    // Reconstruction should be somewhat close to original
    const reconstructionError = Math.sqrt(
      Math.pow(decoded.get(0, 0) - 0.1, 2) +
      Math.pow(decoded.get(0, 1) - 0.9, 2) +
      Math.pow(decoded.get(0, 2) - 0.2, 2) +
      Math.pow(decoded.get(0, 3) - 0.8, 2)
    );
    assert.ok(reconstructionError < 0.5, 
      `Reconstruction error should be < 0.5, got ${reconstructionError}`);
  });
});
