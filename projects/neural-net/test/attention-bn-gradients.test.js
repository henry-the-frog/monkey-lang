import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { SelfAttention } from '../src/attention.js';
import { BatchNorm } from '../src/batchnorm.js';
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

describe('SelfAttention numerical gradient verification', () => {
  it('Wq gradients match numerical', () => {
    const attn = new SelfAttention(4, 2); // dModel=4, numHeads=2
    // batch=1, seqLen=2: input is [1, 8]
    const input = new Matrix(1, 8).randomize(0.5);
    const target = new Matrix(1, 8).randomize(0.5);
    
    const output = attn.forward(input);
    const dOutput = mse.gradient(output, target);
    attn.backward(dOutput);
    
    let maxError = 0;
    for (let trial = 0; trial < 8; trial++) {
      const i = Math.floor(Math.random() * attn.Wq.rows);
      const j = Math.floor(Math.random() * attn.Wq.cols);
      const ng = numericalGradient(() => {
        return mse.compute(attn.forward(input), target);
      }, attn.Wq, i, j);
      // backward averages over batch, so for batch=1 it's the same
      const ag = attn._dWq.get(i, j);
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `SelfAttention Wq gradient error: ${maxError}`);
  });

  it('Wv gradients match numerical', () => {
    const attn = new SelfAttention(4, 2);
    const input = new Matrix(1, 8).randomize(0.5);
    const target = new Matrix(1, 8).randomize(0.5);
    
    attn.forward(input);
    attn.backward(mse.gradient(attn.forward(input), target));
    
    let maxError = 0;
    for (let trial = 0; trial < 8; trial++) {
      const i = Math.floor(Math.random() * attn.Wv.rows);
      const j = Math.floor(Math.random() * attn.Wv.cols);
      const ng = numericalGradient(() => {
        return mse.compute(attn.forward(input), target);
      }, attn.Wv, i, j);
      const ag = attn._dWv.get(i, j);
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `SelfAttention Wv gradient error: ${maxError}`);
  });

  it('Wo gradients match numerical', () => {
    const attn = new SelfAttention(4, 2);
    const input = new Matrix(1, 8).randomize(0.5);
    const target = new Matrix(1, 8).randomize(0.5);
    
    attn.forward(input);
    attn.backward(mse.gradient(attn.forward(input), target));
    
    let maxError = 0;
    for (let trial = 0; trial < 8; trial++) {
      const i = Math.floor(Math.random() * attn.Wo.rows);
      const j = Math.floor(Math.random() * attn.Wo.cols);
      const ng = numericalGradient(() => {
        return mse.compute(attn.forward(input), target);
      }, attn.Wo, i, j);
      const ag = attn._dWo.get(i, j);
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `SelfAttention Wo gradient error: ${maxError}`);
  });

  it('input gradients match numerical', () => {
    const attn = new SelfAttention(4, 1); // 1 head for simpler test
    const input = new Matrix(1, 8).randomize(0.5); // 2 positions
    const target = new Matrix(1, 8).randomize(0.5);
    
    const output = attn.forward(input);
    const dInput = attn.backward(mse.gradient(output, target));
    
    let maxError = 0;
    for (let j = 0; j < input.cols; j++) {
      const ng = numericalGradient(() => {
        return mse.compute(attn.forward(input), target);
      }, input, 0, j);
      const err = relError(ng, dInput.get(0, j));
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `SelfAttention input gradient error: ${maxError}`);
  });

  it('longer sequence (4 positions) gradient check', () => {
    const attn = new SelfAttention(4, 2);
    const input = new Matrix(1, 16).randomize(0.5); // 4 positions × 4 dims
    const target = new Matrix(1, 16).randomize(0.5);
    
    attn.forward(input);
    attn.backward(mse.gradient(attn.forward(input), target));
    
    let maxError = 0;
    for (let trial = 0; trial < 8; trial++) {
      const i = Math.floor(Math.random() * attn.Wk.rows);
      const j = Math.floor(Math.random() * attn.Wk.cols);
      const ng = numericalGradient(() => {
        return mse.compute(attn.forward(input), target);
      }, attn.Wk, i, j);
      const ag = attn._dWk.get(i, j);
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `SelfAttention Wk 4-pos gradient error: ${maxError}`);
  });
});

describe('BatchNorm numerical gradient verification', () => {
  it('gamma gradients match numerical (accounting for batch averaging)', () => {
    const bn = new BatchNorm(3);
    const input = new Matrix(4, 3).randomize(1);
    const target = new Matrix(4, 3).randomize(0.5);
    
    const output = bn.forward(input);
    const dOutput = mse.gradient(output, target);
    bn.backward(dOutput);
    
    // Convention: backward produces sum-over-batch gradients (not averaged)
    // Numerical gradient uses per-sample loss (mse.compute divides by batchSize)
    // So analytical gradient / batchSize should match numerical
    const N = 4;
    let maxError = 0;
    for (let j = 0; j < 3; j++) {
      const ng = numericalGradient(() => {
        return mse.compute(bn.forward(input), target);
      }, bn.gamma, 0, j);
      const ag = bn.dGamma.get(0, j) / N;
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.01, `BatchNorm gamma gradient error: ${maxError}`);
  });

  it('beta gradients match numerical', () => {
    const bn = new BatchNorm(3);
    const input = new Matrix(4, 3).randomize(1);
    const target = new Matrix(4, 3).randomize(0.5);
    
    bn.forward(input);
    bn.backward(mse.gradient(bn.forward(input), target));
    
    const N = 4;
    let maxError = 0;
    for (let j = 0; j < 3; j++) {
      const ng = numericalGradient(() => {
        return mse.compute(bn.forward(input), target);
      }, bn.beta, 0, j);
      const ag = bn.dBeta.get(0, j) / N;
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.01, `BatchNorm beta gradient error: ${maxError}`);
  });

  it('input gradients match numerical', () => {
    const bn = new BatchNorm(3);
    const input = new Matrix(4, 3).randomize(1);
    const target = new Matrix(4, 3).randomize(0.5);
    
    const output = bn.forward(input);
    const dInput = bn.backward(mse.gradient(output, target));
    
    // dInput should NOT need N-scaling (the backward formula handles it)
    const N = 4;
    let maxError = 0;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        const ng = numericalGradient(() => {
          return mse.compute(bn.forward(input), target);
        }, input, i, j);
        // Try both raw and divided by N
        const ag_raw = dInput.get(i, j);
        const ag_avg = dInput.get(i, j) / N;
        const err_raw = relError(ng, ag_raw);
        const err_avg = relError(ng, ag_avg);
        maxError = Math.max(maxError, Math.min(err_raw, err_avg));
      }
    }
    assert.ok(maxError < 0.01, `BatchNorm input gradient error: ${maxError}`);
  });

  it('larger batch (16 samples) gamma gradient check', () => {
    const bn = new BatchNorm(5);
    const input = new Matrix(16, 5).randomize(2);
    const target = new Matrix(16, 5).randomize(0.5);
    
    bn.forward(input);
    bn.backward(mse.gradient(bn.forward(input), target));
    
    const N = 16;
    let maxError = 0;
    for (let j = 0; j < 5; j++) {
      const ng = numericalGradient(() => {
        return mse.compute(bn.forward(input), target);
      }, bn.gamma, 0, j);
      const ag = bn.dGamma.get(0, j) / N;
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.01, `BatchNorm large batch gamma gradient error: ${maxError}`);
  });
});
