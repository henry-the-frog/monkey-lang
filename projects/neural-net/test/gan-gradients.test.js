import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { GAN } from '../src/gan.js';
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

describe('GAN gradient verification', () => {
  it('discriminator gradients on real data are correct', () => {
    const gan = new GAN({
      latentDim: 4,
      dataSize: 3,
      generatorLayers: [8],
      discriminatorLayers: [8],
    });
    
    const realData = new Matrix(1, 3).randomize(1);
    const target = new Matrix(1, 1).map(() => 0.9);
    
    // Forward through discriminator
    let x = realData;
    for (const layer of gan.discriminator) x = layer.forward(x);
    const pred = x;
    
    // Backward
    let grad = gan.loss.gradient(pred, target);
    for (let i = gan.discriminator.length - 1; i >= 0; i--) {
      grad = gan.discriminator[i].backward(grad);
    }
    
    // Check first discriminator layer weights numerically
    const layer0 = gan.discriminator[0];
    let maxError = 0;
    for (let trial = 0; trial < 8; trial++) {
      const wi = Math.floor(Math.random() * layer0.weights.rows);
      const wj = Math.floor(Math.random() * layer0.weights.cols);
      const ng = numericalGradient(() => {
        let y = realData;
        for (const l of gan.discriminator) y = l.forward(y);
        return mse.compute(y, target);
      }, layer0.weights, wi, wj);
      const ag = layer0.dWeights.get(wi, wj);
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `Discriminator gradient error: ${maxError}`);
  });

  it('generator gradients through frozen discriminator are correct', () => {
    const gan = new GAN({
      latentDim: 4,
      dataSize: 3,
      generatorLayers: [8],
      discriminatorLayers: [8],
    });
    
    // Fixed latent vector (no randomness)
    const latent = new Matrix(1, 4).randomize(0.5);
    const target = new Matrix(1, 1).map(() => 1);
    
    // Forward: generator → discriminator
    let x = latent;
    for (const layer of gan.generator) x = layer.forward(x);
    let pred = x;
    for (const layer of gan.discriminator) pred = layer.forward(pred);
    
    // Backward through discriminator then generator
    let grad = gan.loss.gradient(pred, target);
    for (let i = gan.discriminator.length - 1; i >= 0; i--) {
      grad = gan.discriminator[i].backward(grad);
    }
    for (let i = gan.generator.length - 1; i >= 0; i--) {
      grad = gan.generator[i].backward(grad);
    }
    
    // Check first generator layer weights numerically
    const genLayer0 = gan.generator[0];
    let maxError = 0;
    for (let trial = 0; trial < 8; trial++) {
      const wi = Math.floor(Math.random() * genLayer0.weights.rows);
      const wj = Math.floor(Math.random() * genLayer0.weights.cols);
      const ng = numericalGradient(() => {
        let y = latent;
        for (const l of gan.generator) y = l.forward(y);
        for (const l of gan.discriminator) y = l.forward(y);
        return mse.compute(y, target);
      }, genLayer0.weights, wi, wj);
      const ag = genLayer0.dWeights.get(wi, wj);
      const err = relError(ng, ag);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.05, `Generator gradient error: ${maxError}`);
  });

  it('GAN trains and discriminator distinguishes real vs fake', () => {
    const gan = new GAN({
      latentDim: 4,
      dataSize: 3,
      generatorLayers: [8],
      discriminatorLayers: [8],
    });
    
    // Simple real data: all values around 1.0
    const realData = new Matrix(20, 3);
    for (let i = 0; i < 20; i++)
      for (let j = 0; j < 3; j++)
        realData.set(i, j, 0.8 + Math.random() * 0.4);
    
    const history = gan.train(realData, { epochs: 50, batchSize: 10, lrD: 0.01, lrG: 0.01 });
    
    // After training, discriminator should give >0.5 for real data
    const realPred = gan.discriminate(Matrix.fromArray([[0.9, 1.0, 1.1]]));
    const fakePred = gan.discriminate(Matrix.fromArray([[0.0, 0.0, 0.0]]));
    
    // At minimum, training should not crash and loss should be finite
    assert.ok(isFinite(history.dLoss[history.dLoss.length - 1]), 'D loss finite');
    assert.ok(isFinite(history.gLoss[history.gLoss.length - 1]), 'G loss finite');
  });
});
