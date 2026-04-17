import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { EarlyStopping, LossHistory } from '../src/callbacks.js';
import { addNoise, randomFlipH, mixup, compose } from '../src/augmentation.js';

describe('EarlyStopping', () => {
  it('stops after patience epochs without improvement', () => {
    const es = new EarlyStopping({ patience: 3 });
    
    es.onEpochEnd(0, 1.0);   assert.ok(!es.stopped, 'Epoch 0: first loss');
    es.onEpochEnd(1, 0.9);   assert.ok(!es.stopped, 'Epoch 1: improvement');
    es.onEpochEnd(2, 0.95);  assert.ok(!es.stopped, 'Epoch 2: wait=1');
    es.onEpochEnd(3, 0.96);  assert.ok(!es.stopped, 'Epoch 3: wait=2');
    es.onEpochEnd(4, 0.97);  assert.ok(es.stopped, 'Epoch 4: wait=3 >= patience=3, should stop');
  });

  it('resets counter on improvement', () => {
    const es = new EarlyStopping({ patience: 2 });
    
    es.onEpochEnd(0, 1.0);
    es.onEpochEnd(1, 1.1);  // Worse 1
    es.onEpochEnd(2, 0.5);  // Improvement! Resets wait
    assert.ok(!es.stopped, 'Should NOT stop: improvement just happened');
    es.onEpochEnd(3, 0.6);  // Worse 1 after improvement
    es.onEpochEnd(4, 0.7);  // Worse 2 after improvement
    assert.ok(es.stopped, 'Should stop: patience exceeded after improvement');
  });

  it('respects minDelta', () => {
    const es = new EarlyStopping({ patience: 2, minDelta: 0.1 });
    
    es.onEpochEnd(0, 1.0);
    es.onEpochEnd(1, 0.95);  // Better but < minDelta → counted as no improvement
    es.onEpochEnd(2, 0.94);  // Still < minDelta from best (1.0)... 
    // wait should be 2, so stopped
    assert.ok(es.stopped, 'Should stop: improvements < minDelta');
  });
});

describe('LossHistory', () => {
  it('records loss values', () => {
    const lh = new LossHistory();
    lh.onEpochEnd(0, 1.5);
    lh.onEpochEnd(1, 1.2);
    lh.onEpochEnd(2, 0.8);
    
    assert.deepEqual(lh.losses, [1.5, 1.2, 0.8]);
  });
});

describe('Data Augmentation', () => {
  it('addNoise changes values but preserves dimensions', () => {
    const data = new Matrix(2, 3);
    for (let i = 0; i < 6; i++) data.data[i] = 0.5;
    
    const noisy = addNoise(data, 0.1);
    assert.equal(noisy.rows, 2);
    assert.equal(noisy.cols, 3);
    
    // At least some values should have changed
    let changed = 0;
    for (let i = 0; i < 6; i++) {
      if (noisy.data[i] !== 0.5) changed++;
    }
    assert.ok(changed > 0, 'Noise should change some values');
  });

  it('randomFlipH preserves dimensions', () => {
    // 2x3 image, 1 channel → data is [1,2,3,4,5,6] (row-major 2×3)
    const data = new Matrix(1, 6, new Float64Array([1, 2, 3, 4, 5, 6]));
    const flipped = randomFlipH(data, 3, 2, 1);
    assert.equal(flipped.cols, 6, 'Should preserve dimensions');
  });

  it('mixup produces convex combination', () => {
    const inputs = Matrix.fromArray([[1, 0], [0, 1]]);
    const targets = Matrix.fromArray([[1], [0]]);
    
    const { inputs: mixedI, targets: mixedT } = mixup(inputs, targets, 0.5);
    
    // Mixed values should be between the original values
    for (let i = 0; i < mixedI.rows; i++) {
      for (let j = 0; j < mixedI.cols; j++) {
        const v = mixedI.get(i, j);
        assert.ok(v >= -0.1 && v <= 1.1, `Mixed input should be in [0,1] range: ${v}`);
      }
    }
  });

  it('compose chains augmentation functions', () => {
    let callCount = 0;
    const fn1 = (data) => { callCount++; return data; };
    const fn2 = (data) => { callCount++; return data; };
    
    const composed = compose(fn1, fn2);
    composed(new Matrix(1, 1));
    
    assert.equal(callCount, 2, 'Both functions should be called');
  });
});
