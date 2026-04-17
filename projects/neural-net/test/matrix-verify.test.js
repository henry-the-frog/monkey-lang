import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';

describe('Matrix operations edge cases', () => {
  describe('dot product', () => {
    it('2x3 dot 3x2 produces 2x2', () => {
      const a = Matrix.fromArray([[1, 2, 3], [4, 5, 6]]);
      const b = Matrix.fromArray([[7, 8], [9, 10], [11, 12]]);
      const c = a.dot(b);
      assert.equal(c.rows, 2);
      assert.equal(c.cols, 2);
      // [1,2,3]·[7,9,11] = 7+18+33 = 58
      assert.equal(c.get(0, 0), 58);
      // [1,2,3]·[8,10,12] = 8+20+36 = 64
      assert.equal(c.get(0, 1), 64);
      // [4,5,6]·[7,9,11] = 28+45+66 = 139
      assert.equal(c.get(1, 0), 139);
    });

    it('identity matrix preserves values', () => {
      const I = Matrix.fromArray([[1, 0], [0, 1]]);
      const A = Matrix.fromArray([[3, 7], [5, 2]]);
      const result = I.dot(A);
      assert.equal(result.get(0, 0), 3);
      assert.equal(result.get(0, 1), 7);
      assert.equal(result.get(1, 0), 5);
      assert.equal(result.get(1, 1), 2);
    });
  });

  describe('transpose', () => {
    it('transposes correctly', () => {
      const a = Matrix.fromArray([[1, 2, 3], [4, 5, 6]]);
      const t = a.T();
      assert.equal(t.rows, 3);
      assert.equal(t.cols, 2);
      assert.equal(t.get(0, 0), 1);
      assert.equal(t.get(0, 1), 4);
      assert.equal(t.get(2, 1), 6);
    });

    it('double transpose is identity', () => {
      const a = Matrix.fromArray([[1, 2], [3, 4], [5, 6]]);
      const tt = a.T().T();
      assert.equal(tt.rows, 3);
      assert.equal(tt.cols, 2);
      assert.equal(tt.get(2, 1), 6);
    });
  });

  describe('element-wise operations', () => {
    it('add matrices', () => {
      const a = Matrix.fromArray([[1, 2], [3, 4]]);
      const b = Matrix.fromArray([[5, 6], [7, 8]]);
      const c = a.add(b);
      assert.equal(c.get(0, 0), 6);
      assert.equal(c.get(1, 1), 12);
    });

    it('subtract matrices', () => {
      const a = Matrix.fromArray([[5, 6], [7, 8]]);
      const b = Matrix.fromArray([[1, 2], [3, 4]]);
      const c = a.sub(b);
      assert.equal(c.get(0, 0), 4);
      assert.equal(c.get(1, 1), 4);
    });

    it('scalar multiply', () => {
      const a = Matrix.fromArray([[1, 2], [3, 4]]);
      const c = a.mul(3);
      assert.equal(c.get(0, 0), 3);
      assert.equal(c.get(1, 1), 12);
    });

    it('map applies function', () => {
      const a = Matrix.fromArray([[1, 4], [9, 16]]);
      const c = a.map(Math.sqrt);
      assert.equal(c.get(0, 0), 1);
      assert.equal(c.get(0, 1), 2);
      assert.equal(c.get(1, 0), 3);
      assert.equal(c.get(1, 1), 4);
    });
  });

  describe('static constructors', () => {
    it('zeros creates zero matrix', () => {
      const z = Matrix.zeros(2, 3);
      assert.equal(z.rows, 2);
      assert.equal(z.cols, 3);
      assert.equal(z.get(1, 2), 0);
    });

    it('ones creates ones matrix', () => {
      const o = Matrix.ones(2, 2);
      assert.equal(o.get(0, 0), 1);
      assert.equal(o.get(1, 1), 1);
    });

    it('fromArray handles nested arrays', () => {
      const m = Matrix.fromArray([[1, 2, 3]]);
      assert.equal(m.rows, 1);
      assert.equal(m.cols, 3);
      assert.equal(m.get(0, 2), 3);
    });
  });

  describe('numerical edge cases', () => {
    it('handles very small values', () => {
      const a = new Matrix(1, 2, new Float64Array([1e-300, 1e-300]));
      const b = new Matrix(2, 1, new Float64Array([1e-300, 1e-300]));
      const c = a.dot(b);
      assert.ok(isFinite(c.get(0, 0)), 'Should handle small values');
    });

    it('handles very large values without NaN', () => {
      const a = new Matrix(1, 2, new Float64Array([1e150, 1e150]));
      const b = new Matrix(2, 1, new Float64Array([1e150, 1e150]));
      const c = a.dot(b);
      // 2 * 1e300 = Infinity, but should not be NaN
      assert.ok(!isNaN(c.get(0, 0)), 'Should not produce NaN');
    });

    it('randomize produces values in range', () => {
      const m = new Matrix(10, 10).randomize(2);
      for (let i = 0; i < 10; i++)
        for (let j = 0; j < 10; j++)
          assert.ok(Math.abs(m.get(i, j)) <= 2, 'Should be within range');
    });
  });
});
