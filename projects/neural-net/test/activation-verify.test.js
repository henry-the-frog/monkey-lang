import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { sigmoid, relu, leakyRelu, tanh as tanhAct, softmax, linear, getActivation } from '../src/activation.js';

function numericalDerivative(fn, x, j, eps = 1e-5) {
  const orig = x.get(0, j);
  x.set(0, j, orig + eps);
  const fp = fn(x).get(0, j);
  x.set(0, j, orig - eps);
  const fm = fn(x).get(0, j);
  x.set(0, j, orig);
  return (fp - fm) / (2 * eps);
}

function relError(a, b) {
  return Math.abs(a - b) / (Math.abs(a) + Math.abs(b) + 1e-8);
}

describe('Activation function derivative verification', () => {
  
  it('sigmoid derivative matches numerical', () => {
    const x = new Matrix(1, 4, new Float64Array([-2, -0.5, 0.5, 2]));
    const output = sigmoid.forward(x);
    const derivative = sigmoid.backward(output);
    
    let maxError = 0;
    for (let j = 0; j < 4; j++) {
      const nd = numericalDerivative(x => sigmoid.forward(x), x, j);
      const err = relError(nd, derivative.get(0, j));
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.001, `Sigmoid derivative error: ${maxError}`);
  });

  it('relu derivative matches numerical', () => {
    const x = new Matrix(1, 4, new Float64Array([-1, -0.001, 0.001, 1]));
    const output = relu.forward(x);
    const derivative = relu.backward(output);
    
    // For ReLU: deriv = 1 if x > 0, 0 if x < 0 (undefined at 0)
    assert.equal(derivative.get(0, 0), 0, 'Negative input → 0');
    assert.equal(derivative.get(0, 3), 1, 'Positive input → 1');
  });

  it('leaky relu derivative matches numerical', () => {
    const x = new Matrix(1, 4, new Float64Array([-2, -0.5, 0.5, 2]));
    const output = leakyRelu.forward(x);
    const derivative = leakyRelu.backward(output);
    
    let maxError = 0;
    for (let j = 0; j < 4; j++) {
      const nd = numericalDerivative(x => leakyRelu.forward(x), x, j);
      const err = relError(nd, derivative.get(0, j));
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.01, `Leaky ReLU derivative error: ${maxError}`);
  });

  it('tanh derivative matches numerical', () => {
    const x = new Matrix(1, 4, new Float64Array([-2, -0.5, 0.5, 2]));
    const output = tanhAct.forward(x);
    const derivative = tanhAct.backward(output);
    
    let maxError = 0;
    for (let j = 0; j < 4; j++) {
      const nd = numericalDerivative(x => tanhAct.forward(x), x, j);
      const err = relError(nd, derivative.get(0, j));
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 0.001, `Tanh derivative error: ${maxError}`);
  });

  it('linear derivative is always 1', () => {
    const x = new Matrix(1, 3, new Float64Array([-5, 0, 5]));
    const output = linear.forward(x);
    const derivative = linear.backward(output);
    
    for (let j = 0; j < 3; j++) {
      assert.equal(derivative.get(0, j), 1, `Linear derivative should be 1 at j=${j}`);
    }
  });

  it('sigmoid output is between 0 and 1', () => {
    const x = new Matrix(1, 5, new Float64Array([-100, -1, 0, 1, 100]));
    const output = sigmoid.forward(x);
    
    for (let j = 0; j < 5; j++) {
      assert.ok(output.get(0, j) >= 0 && output.get(0, j) <= 1, 
        `Sigmoid output should be [0,1]: ${output.get(0, j)}`);
    }
    // Extremes
    assert.ok(output.get(0, 0) < 0.01, 'sigmoid(-100) ≈ 0');
    assert.ok(output.get(0, 4) > 0.99, 'sigmoid(100) ≈ 1');
    assert.ok(Math.abs(output.get(0, 2) - 0.5) < 0.01, 'sigmoid(0) ≈ 0.5');
  });

  it('softmax sums to 1', () => {
    const x = new Matrix(1, 4, new Float64Array([1, 2, 3, 4]));
    const output = softmax.forward(x);
    
    let sum = 0;
    for (let j = 0; j < 4; j++) {
      sum += output.get(0, j);
      assert.ok(output.get(0, j) > 0, 'Softmax output should be positive');
    }
    assert.ok(Math.abs(sum - 1) < 1e-10, `Softmax should sum to 1: ${sum}`);
  });

  it('softmax is numerically stable with large inputs', () => {
    const x = new Matrix(1, 3, new Float64Array([1000, 1001, 1002]));
    const output = softmax.forward(x);
    
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      assert.ok(isFinite(output.get(0, j)), `Softmax should be finite: ${output.get(0, j)}`);
      sum += output.get(0, j);
    }
    assert.ok(Math.abs(sum - 1) < 1e-10, `Should sum to 1 even with large inputs: ${sum}`);
  });

  it('getActivation returns all types', () => {
    const names = ['sigmoid', 'relu', 'tanh', 'linear', 'softmax'];
    for (const name of names) {
      const act = getActivation(name);
      assert.ok(act, `Should find activation: ${name}`);
      assert.ok(act.forward, `${name} should have forward`);
      assert.ok(act.backward, `${name} should have backward`);
    }
  });
});
