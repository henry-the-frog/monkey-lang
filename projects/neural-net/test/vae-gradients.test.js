import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { VAE } from '../src/vae.js';

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

describe('VAE gradient verification', () => {
  it('decoder gradients match numerical (reconstruction loss only)', () => {
    const vae = new VAE(4, 6, 2, { beta: 0, learningRate: 0.001 });
    
    // Fixed input
    const input = new Matrix(4, 1);
    for (let i = 0; i < 4; i++) input.data[i] = 0.3 + i * 0.1;
    
    // Forward to get z, then fix epsilon for reproducibility
    const fixedEpsilon = new Matrix(2, 1);
    fixedEpsilon.data[0] = 0.5;
    fixedEpsilon.data[1] = -0.3;
    
    // Monkey-patch reparameterize to use fixed epsilon
    const origReparam = vae.reparameterize.bind(vae);
    vae.reparameterize = function(mu, logVar) {
      const std = logVar.map(x => Math.exp(0.5 * x));
      const z = mu.add(std.map((s, i) => s * fixedEpsilon.data[i]));
      this._lastEpsilon = fixedEpsilon;
      return { z, epsilon: fixedEpsilon };
    };
    
    // Forward
    const { reconstruction, mu, logVar, z } = vae.forward(input);
    
    // Compute loss (reconstruction only since beta=0)
    const { total } = vae.computeLoss(input, reconstruction, mu, logVar);
    
    // Backward through decoder
    const dRecon = new Matrix(input.rows, 1);
    for (let i = 0; i < input.data.length; i++) {
      const r = Math.max(1e-8, Math.min(1 - 1e-8, reconstruction.data[i]));
      dRecon.data[i] = -(input.data[i] / r - (1 - input.data[i]) / (1 - r));
    }
    
    const dDecHidden = vae.decOutput.backward(dRecon);
    vae.decHidden.backward(dDecHidden);
    
    // Check decOutput weights numerically
    let maxError = 0;
    for (let trial = 0; trial < 8; trial++) {
      const wi = Math.floor(Math.random() * vae.decOutput.W.rows);
      const wj = Math.floor(Math.random() * vae.decOutput.W.cols);
      
      const ng = numericalGradient(() => {
        const result = vae.forward(input);
        return vae.computeLoss(input, result.reconstruction, result.mu, result.logVar).total;
      }, vae.decOutput.W, wi, wj);
      
      const ag = vae.decOutput.dW.get(wi, wj);
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `VAE decoder gradient error: ${maxError}`);
  });

  it('encoder mu gradients through reparameterization', () => {
    const vae = new VAE(4, 6, 2, { beta: 1.0, learningRate: 0.001 });
    
    const input = new Matrix(4, 1);
    for (let i = 0; i < 4; i++) input.data[i] = 0.3 + i * 0.1;
    
    // Fix epsilon
    const fixedEpsilon = new Matrix(2, 1);
    fixedEpsilon.data[0] = 0.5;
    fixedEpsilon.data[1] = -0.3;
    
    vae.reparameterize = function(mu, logVar) {
      const std = logVar.map(x => Math.exp(0.5 * x));
      const z = mu.add(std.map((s, i) => s * fixedEpsilon.data[i]));
      this._lastEpsilon = fixedEpsilon;
      return { z, epsilon: fixedEpsilon };
    };
    
    // Full forward + backward (using trainStep logic manually)
    const { reconstruction, mu, logVar, z } = vae.forward(input);
    
    const dRecon = new Matrix(input.rows, 1);
    for (let i = 0; i < input.data.length; i++) {
      const r = Math.max(1e-8, Math.min(1 - 1e-8, reconstruction.data[i]));
      dRecon.data[i] = -(input.data[i] / r - (1 - input.data[i]) / (1 - r));
    }
    
    const dDecHidden = vae.decOutput.backward(dRecon);
    const dZ = vae.decHidden.backward(dDecHidden);
    
    const dMu = new Matrix(mu.rows, 1);
    for (let i = 0; i < mu.data.length; i++) {
      dMu.data[i] = dZ.data[i] + vae.beta * mu.data[i];
    }
    
    const dEncMuH = vae.encMu.backward(dMu);
    
    // Check encMu weights numerically
    let maxError = 0;
    for (let trial = 0; trial < 8; trial++) {
      const wi = Math.floor(Math.random() * vae.encMu.W.rows);
      const wj = Math.floor(Math.random() * vae.encMu.W.cols);
      
      const ng = numericalGradient(() => {
        const result = vae.forward(input);
        return vae.computeLoss(input, result.reconstruction, result.mu, result.logVar).total;
      }, vae.encMu.W, wi, wj);
      
      const ag = vae.encMu.dW.get(wi, wj);
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `VAE encMu gradient error: ${maxError}`);
  });

  it('training reduces loss', () => {
    const vae = new VAE(4, 8, 2, { beta: 0.1, learningRate: 0.01 });
    
    // Simple data: all similar
    const data = [];
    for (let i = 0; i < 20; i++) {
      data.push([0.3, 0.5, 0.7, 0.4]);
    }
    
    const { history } = vae.train(data, { epochs: 30 });
    
    assert.ok(history.length === 30, 'Should have 30 epochs');
    assert.ok(isFinite(history[29].loss), 'Final loss should be finite');
    // Loss should generally decrease
    assert.ok(history[29].loss < history[0].loss, 
      `Loss should decrease: ${history[0].loss} → ${history[29].loss}`);
  });
});
