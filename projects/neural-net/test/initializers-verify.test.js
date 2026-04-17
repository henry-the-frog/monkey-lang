import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { xavierUniform, xavierNormal, heUniform, heNormal, lecunNormal, zeros, ones, createInitializer } from '../src/initializers.js';

function computeVariance(matrix) {
  const n = matrix.data.length;
  let sum = 0, sumSq = 0;
  for (const v of matrix.data) {
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

describe('Weight initializer verification', () => {
  // Use large matrices for statistical accuracy
  const N = 10000;
  const fanIn = 100, fanOut = 50;

  it('Xavier uniform variance ≈ 2/(fanIn+fanOut)', () => {
    const m = xavierUniform(N, 1, fanIn, fanOut);
    const variance = computeVariance(m);
    // Uniform[-a,a] has variance a²/3
    // a = sqrt(6/(fanIn+fanOut))
    // Var = 6/(fanIn+fanOut) / 3 = 2/(fanIn+fanOut)
    const expected = 2.0 / (fanIn + fanOut);
    const relErr = Math.abs(variance - expected) / expected;
    assert.ok(relErr < 0.15, `Xavier uniform variance: got ${variance.toFixed(6)}, expected ${expected.toFixed(6)}, error ${(relErr*100).toFixed(1)}%`);
  });

  it('Xavier normal variance ≈ 2/(fanIn+fanOut)', () => {
    const m = xavierNormal(N, 1, fanIn, fanOut);
    const variance = computeVariance(m);
    const expected = 2.0 / (fanIn + fanOut);
    const relErr = Math.abs(variance - expected) / expected;
    assert.ok(relErr < 0.15, `Xavier normal variance: got ${variance.toFixed(6)}, expected ${expected.toFixed(6)}, error ${(relErr*100).toFixed(1)}%`);
  });

  it('He uniform variance ≈ 2/fanIn', () => {
    const m = heUniform(N, 1, fanIn);
    const variance = computeVariance(m);
    const expected = 2.0 / fanIn;
    const relErr = Math.abs(variance - expected) / expected;
    assert.ok(relErr < 0.15, `He uniform variance: got ${variance.toFixed(6)}, expected ${expected.toFixed(6)}, error ${(relErr*100).toFixed(1)}%`);
  });

  it('He normal variance ≈ 2/fanIn', () => {
    const m = heNormal(N, 1, fanIn);
    const variance = computeVariance(m);
    const expected = 2.0 / fanIn;
    const relErr = Math.abs(variance - expected) / expected;
    assert.ok(relErr < 0.15, `He normal variance: got ${variance.toFixed(6)}, expected ${expected.toFixed(6)}, error ${(relErr*100).toFixed(1)}%`);
  });

  it('LeCun normal variance ≈ 1/fanIn', () => {
    const m = lecunNormal(N, 1, fanIn);
    const variance = computeVariance(m);
    const expected = 1.0 / fanIn;
    const relErr = Math.abs(variance - expected) / expected;
    assert.ok(relErr < 0.15, `LeCun variance: got ${variance.toFixed(6)}, expected ${expected.toFixed(6)}, error ${(relErr*100).toFixed(1)}%`);
  });

  it('zeros produces all zeros', () => {
    const m = zeros(5, 5);
    for (const v of m.data) assert.equal(v, 0);
  });

  it('ones produces all ones', () => {
    const m = ones(5, 5);
    for (const v of m.data) assert.equal(v, 1);
  });

  it('all initializers have zero mean', () => {
    const inits = [
      ['Xavier uniform', xavierUniform(N, 1, fanIn, fanOut)],
      ['Xavier normal', xavierNormal(N, 1, fanIn, fanOut)],
      ['He uniform', heUniform(N, 1, fanIn)],
      ['He normal', heNormal(N, 1, fanIn)],
      ['LeCun normal', lecunNormal(N, 1, fanIn)],
    ];
    
    for (const [name, m] of inits) {
      let mean = 0;
      for (const v of m.data) mean += v;
      mean /= m.data.length;
      assert.ok(Math.abs(mean) < 0.05, `${name} should have ~0 mean: ${mean.toFixed(4)}`);
    }
  });

  it('createInitializer returns all types', () => {
    const names = ['xavier_uniform', 'glorot_uniform', 'xavier_normal', 'glorot_normal',
                    'he_uniform', 'kaiming_uniform', 'he_normal', 'kaiming_normal',
                    'lecun', 'lecun_normal', 'zeros', 'ones'];
    for (const name of names) {
      assert.ok(createInitializer(name), `Should find: ${name}`);
    }
  });
});
