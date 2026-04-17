import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { 
  ConstantLR, LinearWarmup, CosineAnnealing, StepDecay, 
  WarmupCosine, ExponentialDecay, CyclicLR, LinearDecay,
  createScheduler 
} from '../src/scheduler.js';

describe('Learning rate schedulers', () => {
  it('ConstantLR always returns base LR', () => {
    const sched = new ConstantLR(0.01);
    assert.equal(sched.getLR(0), 0.01);
    assert.equal(sched.getLR(100), 0.01);
    assert.equal(sched.getLR(999, 50), 0.01);
  });

  it('LinearWarmup ramps from 0 to base LR', () => {
    const sched = new LinearWarmup(0.01, 100);
    assert.equal(sched.getLR(0), 0);
    assert.ok(Math.abs(sched.getLR(50) - 0.005) < 1e-10);
    assert.equal(sched.getLR(100), 0.01);
    assert.equal(sched.getLR(200), 0.01); // stays at base after warmup
  });

  it('CosineAnnealing follows cosine curve', () => {
    const sched = new CosineAnnealing(0.01, 0.0001, 100);
    // epoch 0: maxLR
    assert.ok(Math.abs(sched.getLR(0, 0) - 0.01) < 1e-10);
    // epoch 50: midpoint
    const mid = 0.0001 + 0.5 * (0.01 - 0.0001) * (1 + Math.cos(Math.PI * 0.5));
    assert.ok(Math.abs(sched.getLR(0, 50) - mid) < 1e-10);
    // epoch 100: minLR
    assert.ok(Math.abs(sched.getLR(0, 100) - 0.0001) < 1e-10);
  });

  it('StepDecay reduces by factor every N epochs', () => {
    const sched = new StepDecay(0.01, 0.1, 30);
    assert.equal(sched.getLR(0, 0), 0.01);
    assert.equal(sched.getLR(0, 29), 0.01);
    assert.ok(Math.abs(sched.getLR(0, 30) - 0.001) < 1e-10);
    assert.ok(Math.abs(sched.getLR(0, 60) - 0.0001) < 1e-10);
  });

  it('WarmupCosine combines warmup then cosine', () => {
    const sched = new WarmupCosine(0.01, 0, 10, 100);
    // During warmup (step < 10)
    assert.equal(sched.getLR(0, 0), 0);
    assert.ok(Math.abs(sched.getLR(5, 0) - 0.005) < 1e-10);
    // After warmup: cosine
    const lr = sched.getLR(10, 0);
    assert.equal(lr, 0.01); // Start of cosine = maxLR
  });

  it('ExponentialDecay decreases exponentially', () => {
    const sched = new ExponentialDecay(0.01, 0.96, 1000);
    assert.equal(sched.getLR(0), 0.01);
    // After 1000 steps: 0.01 * 0.96 = 0.0096
    assert.ok(Math.abs(sched.getLR(1000) - 0.0096) < 1e-10);
    // After 2000 steps: 0.01 * 0.96^2 = 0.009216
    assert.ok(Math.abs(sched.getLR(2000) - 0.009216) < 1e-10);
  });

  it('CyclicLR oscillates between base and max', () => {
    const sched = new CyclicLR(0.001, 0.01, 100);
    const lr0 = sched.getLR(0);
    const lr50 = sched.getLR(50);
    const lr100 = sched.getLR(100);
    
    // Should oscillate — at some point reach max, at others reach base
    assert.ok(lr0 >= 0.001 && lr0 <= 0.01, `LR at 0: ${lr0}`);
    assert.ok(lr50 >= 0.001 && lr50 <= 0.01, `LR at 50: ${lr50}`);
    
    // After full cycle (200 steps), should be back to similar value
    const lr200 = sched.getLR(200);
    assert.ok(Math.abs(lr200 - lr0) < 0.005, `Cyclic should repeat: ${lr0} vs ${lr200}`);
  });

  it('LinearDecay interpolates linearly', () => {
    const sched = new LinearDecay(0.01, 0.001, 100);
    assert.equal(sched.getLR(0), 0.01);
    // Midpoint: t = 50/99 ≈ 0.505 (99 because totalEpochs-1 denominator)
    const t50 = 50 / 99;
    const expected50 = 0.01 + (0.001 - 0.01) * t50;
    assert.ok(Math.abs(sched.getLR(50) - expected50) < 1e-10, `Midpoint: ${sched.getLR(50)} vs ${expected50}`);
    // End
    assert.ok(Math.abs(sched.getLR(99) - 0.001) < 1e-10);
    // Should monotonically decrease
    let prev = sched.getLR(0);
    for (let i = 1; i < 100; i++) {
      const curr = sched.getLR(i);
      assert.ok(curr <= prev, `Should decrease: step ${i}`);
      prev = curr;
    }
  });

  it('createScheduler creates all types', () => {
    const types = ['constant', 'warmup', 'cosine', 'step', 'warmup_cosine', 'exponential', 'cyclic', 'linear'];
    for (const type of types) {
      const sched = createScheduler(type, { lr: 0.01, maxLR: 0.01, warmupSteps: 10, totalEpochs: 100 });
      const lr = sched.getLR(0, 0);
      assert.ok(isFinite(lr), `${type} scheduler should return finite LR, got ${lr}`);
    }
  });

  it('all schedulers produce non-negative LR', () => {
    const schedulers = [
      new ConstantLR(0.01),
      new LinearWarmup(0.01, 100),
      new CosineAnnealing(0.01, 0, 100),
      new StepDecay(0.01, 0.1, 30),
      new ExponentialDecay(0.01, 0.96, 1000),
      new CyclicLR(0.001, 0.01, 100),
      new LinearDecay(0.01, 0.001, 100),
    ];
    
    for (const sched of schedulers) {
      for (let step = 0; step < 200; step += 10) {
        const lr = sched.getLR(step, Math.floor(step / 10));
        assert.ok(lr >= 0, `${sched.constructor.name} step ${step}: LR should be >= 0, got ${lr}`);
      }
    }
  });
});
