import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DQN, ReplayBuffer, GridWorldEnv } from '../src/dqn.js';

describe('DQN verification', () => {
  it('ReplayBuffer stores and samples correctly', () => {
    const buf = new ReplayBuffer(100);
    
    for (let i = 0; i < 50; i++) {
      buf.push([i], i % 4, i, [i+1], false);
    }
    
    assert.equal(buf.size, 50);
    
    const sample = buf.sample(10);
    assert.equal(sample.length, 10);
    for (const s of sample) {
      assert.ok(s.state !== undefined);
      assert.ok(s.action !== undefined);
    }
  });

  it('ReplayBuffer respects capacity', () => {
    const buf = new ReplayBuffer(10);
    for (let i = 0; i < 20; i++) {
      buf.push([i], 0, 0, [0], false);
    }
    assert.equal(buf.size, 10);
  });

  it('DQN predicts Q-values', () => {
    const dqn = new DQN(4, 2, { hiddenSize: 8 });
    const qVals = dqn._predict(dqn.qNetwork, [1, 2, 3, 4]);
    assert.equal(qVals.length, 2);
    assert.ok(isFinite(qVals[0]));
    assert.ok(isFinite(qVals[1]));
  });

  it('DQN target network sync copies weights', () => {
    const dqn = new DQN(2, 2, { hiddenSize: 4 });
    dqn.qNetwork.layers[0].weights.set(0, 0, 999);
    assert.notEqual(dqn.targetNetwork.layers[0].weights.get(0, 0), 999);
    dqn._syncTargetNetwork();
    assert.equal(dqn.targetNetwork.layers[0].weights.get(0, 0), 999);
  });

  it('DQN trains on GridWorld without crashing', () => {
    const env = new GridWorldEnv();
    const dqn = new DQN(2, 4, {
      hiddenSize: 8,
      learningRate: 0.01,
      epsilon: 0.5,
      epsilonDecay: 0.99,
      batchSize: 8,
      bufferSize: 100,
    });
    
    const { rewards } = dqn.train(env, { episodes: 10, maxSteps: 30 });
    assert.equal(rewards.length, 10);
    assert.ok(rewards.every(r => isFinite(r)));
  });
});
