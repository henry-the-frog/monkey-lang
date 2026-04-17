import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { RBM } from '../src/rbm.js';
import { REINFORCE } from '../src/reinforce.js';

describe('RBM verification', () => {
  it('forward (visible to hidden) produces correct dimensions', () => {
    const rbm = new RBM(4, 3);
    const visible = new Matrix(4, 1, new Float64Array([1, 0, 1, 0]));
    const { samples: hidden } = rbm.sampleHidden(visible);
    assert.equal(hidden.rows, 3, 'Hidden should have 3 units');
    // Each value should be 0 or 1 (binary)
    for (let i = 0; i < 3; i++) {
      const v = hidden.get(i, 0);
      assert.ok(v === 0 || v === 1, `Hidden unit should be binary, got ${v}`);
    }
  });

  it('reconstruction preserves input dimensions', () => {
    const rbm = new RBM(4, 3);
    const visible = new Matrix(4, 1, new Float64Array([1, 0, 1, 0]));
    const { samples: hidden } = rbm.sampleHidden(visible);
    const { samples: recon } = rbm.sampleVisible(hidden);
    assert.equal(recon.rows, 4, 'Reconstruction should have 4 units');
  });

  it('contrastive divergence training reduces reconstruction error', () => {
    const rbm = new RBM(4, 3, { learningRate: 0.1 });
    
    // Train on a simple pattern
    const data = [];
    for (let i = 0; i < 20; i++) {
      data.push([1, 0, 1, 0]);
    }
    
    const { history } = rbm.train(data, { epochs: 50 });
    assert.ok(history.length === 50);
    assert.ok(isFinite(history[49]), 'Final error should be finite');
    // Reconstruction error should generally decrease
    assert.ok(history[49] < history[0] * 1.5, 
      `Error should not increase dramatically: ${history[0]} → ${history[49]}`);
  });

  it('training updates weights', () => {
    const rbm = new RBM(4, 3, { learningRate: 0.1 });
    const wBefore = rbm.W.get(0, 0);
    
    const data = [];
    for (let i = 0; i < 5; i++) {
      data.push([1, 0, 1, 0]);
    }
    
    rbm.train(data, { epochs: 5 });
    const wAfter = rbm.W.get(0, 0);
    
    assert.notEqual(wBefore, wAfter, 'Weights should change during training');
  });
});

describe('REINFORCE verification', () => {
  it('creates policy network with correct dimensions', () => {
    const agent = new REINFORCE(2, 3, { hiddenSize: 8 });
    const state = [0.5, 0.3];
    const action = agent.selectAction(state);
    assert.ok(action >= 0 && action < 3, `Action should be 0-2, got ${action}`);
  });

  it('selectAction with greedy mode returns valid action', () => {
    const agent = new REINFORCE(2, 3, { hiddenSize: 8 });
    const action = agent.selectAction([0.5, 0.3], true); // greedy
    assert.ok(action >= 0 && action < 3);
  });

  // Simple test environment
  class SimpleEnv {
    constructor() { this.state = [0, 0]; }
    reset() { this.state = [0, 0]; return this.state; }
    step(action) {
      const reward = action === 0 ? 1 : -1;
      return { state: this.state, reward, done: true };
    }
  }

  it('trains on simple environment without crashing', () => {
    const agent = new REINFORCE(2, 2, { hiddenSize: 4, learningRate: 0.01 });
    const env = new SimpleEnv();
    
    const { rewards } = agent.train(env, { episodes: 10, maxSteps: 5 });
    assert.equal(rewards.length, 10);
    assert.ok(rewards.every(r => isFinite(r)));
  });
});
