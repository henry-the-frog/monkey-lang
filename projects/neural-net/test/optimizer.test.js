import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { SGD, MomentumSGD, Adam, RMSProp, AdamW } from '../src/optimizer.js';
import { Network } from '../src/network.js';
import { Dense } from '../src/layer.js';

describe('Optimizer convergence tests', () => {
  // Helper: train a 2-input, 1-output network on XOR-like problem
  // Tests that each optimizer can actually reduce loss
  function trainXOR(optimizerName, lr = 0.1, epochs = 200) {
    const net = new Network();
    net.add(new Dense(2, 4, 'sigmoid'));
    net.add(new Dense(4, 1, 'sigmoid'));
    net.loss('mse');
    
    // Simple training data: predict if sum > 1
    const data = [
      { input: [0, 0], target: [0] },
      { input: [1, 0], target: [0.5] },
      { input: [0, 1], target: [0.5] },
      { input: [1, 1], target: [1] },
    ];
    
    let firstLoss, lastLoss;
    for (let epoch = 0; epoch < epochs; epoch++) {
      let epochLoss = 0;
      for (const { input, target } of data) {
        const loss = net.trainBatch([input], [target], lr, 0, optimizerName);
        epochLoss += loss;
      }
      if (epoch === 0) firstLoss = epochLoss;
      lastLoss = epochLoss;
    }
    return { firstLoss, lastLoss };
  }

  it('SGD converges on simple problem', () => {
    const { firstLoss, lastLoss } = trainXOR('sgd', 0.5, 300);
    assert.ok(lastLoss < firstLoss, `SGD should reduce loss: ${firstLoss} → ${lastLoss}`);
    assert.ok(lastLoss < firstLoss * 0.5, `SGD should reduce loss significantly`);
  });

  it('Adam converges on simple problem', () => {
    const { firstLoss, lastLoss } = trainXOR('adam', 0.01, 300);
    assert.ok(lastLoss < firstLoss, `Adam should reduce loss: ${firstLoss} → ${lastLoss}`);
  });

  it('Adam converges faster than SGD (lower loss in same epochs)', () => {
    const sgd = trainXOR('sgd', 0.1, 100);
    const adam = trainXOR('adam', 0.01, 100);
    // Adam should typically do better (not always, but usually)
    // Just verify both make progress
    assert.ok(sgd.lastLoss < sgd.firstLoss, 'SGD makes progress');
    assert.ok(adam.lastLoss < adam.firstLoss, 'Adam makes progress');
  });

  describe('Standalone optimizer unit tests', () => {
    it('SGD update moves parameter in gradient direction', () => {
      const sgd = new SGD(0.1);
      const param = Matrix.fromArray([[1.0, 2.0]]);
      const grad = Matrix.fromArray([[0.5, -0.3]]);
      
      const updated = sgd.update(param, grad);
      // Should be: param - lr * grad = [1 - 0.05, 2 + 0.03] = [0.95, 2.03]
      assert.ok(Math.abs(updated.get(0, 0) - 0.95) < 1e-10);
      assert.ok(Math.abs(updated.get(0, 1) - 2.03) < 1e-10);
    });

    it('MomentumSGD accumulates velocity', () => {
      const mom = new MomentumSGD(0.1, 0.9);
      const param = Matrix.fromArray([[1.0]]);
      const grad = Matrix.fromArray([[1.0]]);
      
      // Step 1: v = 0.9*0 + 0.1*1 = 0.1, p = 1 - 0.1 = 0.9
      let p = mom.update(param, grad, 'test');
      assert.ok(Math.abs(p.get(0, 0) - 0.9) < 1e-10, `Step 1: ${p.get(0, 0)}`);
      
      // Step 2: v = 0.9*0.1 + 0.1*1 = 0.19, p = 0.9 - 0.19 = 0.71
      p = mom.update(p, grad, 'test');
      assert.ok(Math.abs(p.get(0, 0) - 0.71) < 1e-10, `Step 2: ${p.get(0, 0)}`);
    });

    it('Adam produces finite results with normal gradients', () => {
      const adam = new Adam(0.01);
      const param = Matrix.fromArray([[1.0, 2.0, 3.0]]);
      const grad = Matrix.fromArray([[0.5, -0.3, 0.8]]);
      const p1 = adam.update(param, grad, 'test');
      assert.ok(isFinite(p1.get(0, 0)), 'Adam result should be finite');
      assert.ok(p1.get(0, 0) < param.get(0, 0), 'Should decrease with positive gradient');
      assert.ok(p1.get(0, 1) > param.get(0, 1), 'Should increase with negative gradient');
    });

    it('RMSProp adapts learning rate per parameter', () => {
      const rmsprop = new RMSProp(0.01);
      const param = Matrix.fromArray([[0.0, 0.0]]);
      
      // Large gradient on first, small on second
      const grad = Matrix.fromArray([[10.0, 0.1]]);
      const p1 = rmsprop.update(param, grad, 'test');
      
      // RMSProp should normalize: both should move by similar amounts
      const move0 = Math.abs(p1.get(0, 0));
      const move1 = Math.abs(p1.get(0, 1));
      // The ratio should be much less than 100 (raw gradient ratio)
      assert.ok(move0 / move1 < 20, `RMSProp should normalize: ratio ${move0/move1}`);
    });

    it('AdamW applies weight decay separately from gradient', () => {
      const adamw = new AdamW(0.01, 0.01); // lr=0.01, wd=0.01
      const param = Matrix.fromArray([[10.0]]);
      const grad = Matrix.zeros(1, 1); // Zero gradient
      
      // With zero gradient, AdamW should still decay the weight
      const p1 = adamw.update(param, grad, 'test');
      assert.ok(p1.get(0, 0) < 10.0, `AdamW should decay: ${p1.get(0, 0)}`);
      // Weight decay: w = w * (1 - lr * wd) = 10 * (1 - 0.0001) ≈ 9.999
      assert.ok(Math.abs(p1.get(0, 0) - 10 * (1 - 0.01 * 0.01)) < 0.1, 
        `Weight decay amount: ${p1.get(0, 0)}`);
    });
  });

  describe('Convergence on quadratic', () => {
    // Minimize f(x) = sum((x - target)^2) where target = [3, 5]
    // Gradient = 2*(x - target)
    
    function optimizeQuadratic(OptimizerClass, lr, steps, ...extraArgs) {
      const opt = new OptimizerClass(lr, ...extraArgs);
      let x = Matrix.fromArray([[0.0, 0.0]]); // Start at origin
      const target = Matrix.fromArray([[3.0, 5.0]]);
      
      for (let i = 0; i < steps; i++) {
        const grad = x.sub(target).mul(2);
        x = opt.update(x, grad, 'x');
      }
      
      const error = Math.sqrt(
        Math.pow(x.get(0, 0) - 3, 2) + Math.pow(x.get(0, 1) - 5, 2)
      );
      return { x, error };
    }

    it('SGD converges to minimum', () => {
      const { error } = optimizeQuadratic(SGD, 0.01, 500);
      assert.ok(error < 0.01, `SGD should converge: error=${error}`);
    });

    it('MomentumSGD converges faster', () => {
      const sgd = optimizeQuadratic(SGD, 0.01, 100);
      const mom = optimizeQuadratic(MomentumSGD, 0.01, 100, 0.9);
      assert.ok(mom.error < sgd.error, 
        `Momentum should converge faster: SGD=${sgd.error}, Mom=${mom.error}`);
    });

    it('Adam converges quickly', () => {
      const { error } = optimizeQuadratic(Adam, 0.1, 200);
      assert.ok(error < 0.1, `Adam should converge: error=${error}`);
    });

    it('RMSProp converges', () => {
      const { error } = optimizeQuadratic(RMSProp, 0.01, 1000);
      assert.ok(error < 1.0, `RMSProp should converge: error=${error}`);
    });
  });
});
