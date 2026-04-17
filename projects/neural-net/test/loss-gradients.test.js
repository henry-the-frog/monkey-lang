import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { mse, crossEntropy, getLoss } from '../src/loss.js';

function numericalGradient(lossFn, pred, target, i, j, eps = 1e-5) {
  const orig = pred.get(i, j);
  pred.set(i, j, orig + eps);
  const lp = lossFn.compute(pred, target);
  pred.set(i, j, orig - eps);
  const lm = lossFn.compute(pred, target);
  pred.set(i, j, orig);
  return (lp - lm) / (2 * eps);
}

function relError(a, b) {
  return Math.abs(a - b) / (Math.abs(a) + Math.abs(b) + 1e-8);
}

describe('Loss function gradient verification', () => {
  describe('MSE', () => {
    it('gradient matches numerical', () => {
      const pred = new Matrix(1, 4).randomize(1);
      const target = new Matrix(1, 4).randomize(1);
      
      const grad = mse.gradient(pred, target);
      
      let maxError = 0;
      for (let j = 0; j < 4; j++) {
        const ng = numericalGradient(mse, pred, target, 0, j);
        const err = relError(ng, grad.get(0, j));
        maxError = Math.max(maxError, err);
      }
      assert.ok(maxError < 0.01, `MSE gradient error: ${maxError}`);
    });

    it('batch MSE gradient direction is correct', () => {
      const pred = new Matrix(3, 2).randomize(1);
      const target = new Matrix(3, 2).randomize(1);
      
      const grad = mse.gradient(pred, target);
      
      // Convention: gradient returns un-averaged (pred - target)
      // Loss function averages by batchSize
      // So analytical gradient = batchSize × numerical gradient
      const N = pred.rows;
      let maxError = 0;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 2; j++) {
          const ng = numericalGradient(mse, pred, target, i, j);
          const err = relError(ng, grad.get(i, j) / N);
          maxError = Math.max(maxError, err);
        }
      }
      assert.ok(maxError < 0.01, `Batch MSE gradient error (with N correction): ${maxError}`);
    });
  });

  describe('Cross-Entropy', () => {
    it('cross-entropy gradient = pred - target (softmax convention)', () => {
      // The cross-entropy gradient assumes softmax output layer
      // Combined softmax+CE gradient = pred - target
      const pred = new Matrix(1, 3);
      pred.set(0, 0, 0.7); pred.set(0, 1, 0.2); pred.set(0, 2, 0.1);
      
      const target = new Matrix(1, 3);
      target.set(0, 0, 1); target.set(0, 1, 0); target.set(0, 2, 0);
      
      const grad = crossEntropy.gradient(pred, target);
      
      // Should be pred - target = [-0.3, 0.2, 0.1]
      assert.ok(Math.abs(grad.get(0, 0) - (-0.3)) < 1e-10);
      assert.ok(Math.abs(grad.get(0, 1) - 0.2) < 1e-10);
      assert.ok(Math.abs(grad.get(0, 2) - 0.1) < 1e-10);
    });

    it('cross-entropy loss is higher for wrong predictions', () => {
      const target = new Matrix(1, 3);
      target.set(0, 0, 1); target.set(0, 1, 0); target.set(0, 2, 0);
      
      const correct = new Matrix(1, 3);
      correct.set(0, 0, 0.9); correct.set(0, 1, 0.05); correct.set(0, 2, 0.05);
      
      const wrong = new Matrix(1, 3);
      wrong.set(0, 0, 0.1); wrong.set(0, 1, 0.45); wrong.set(0, 2, 0.45);
      
      const correctLoss = crossEntropy.compute(correct, target);
      const wrongLoss = crossEntropy.compute(wrong, target);
      
      assert.ok(wrongLoss > correctLoss, 
        `Wrong prediction should have higher loss: ${wrongLoss} vs ${correctLoss}`);
    });
  });

  describe('getLoss factory', () => {
    it('returns MSE', () => {
      const loss = getLoss('mse');
      assert.ok(loss.compute);
      assert.ok(loss.gradient);
    });

    it('returns cross-entropy', () => {
      const loss = getLoss('crossEntropy') || getLoss('cross-entropy');
      assert.ok(loss, 'Should return cross-entropy loss');
    });
  });
});
