// activation.js — Activation functions and their derivatives

import { Matrix } from './matrix.js';

// Sigmoid: 1 / (1 + e^-x)
export const sigmoid = {
  name: 'sigmoid',
  forward(x) {
    return x.map(v => 1 / (1 + Math.exp(-v)));
  },
  backward(output) {
    // derivative: σ(x) * (1 - σ(x)) — computed from output
    return output.mul(output.map(v => 1 - v));
  }
};

// ReLU: max(0, x)
export const relu = {
  name: 'relu',
  forward(x) {
    return x.map(v => Math.max(0, v));
  },
  backward(output) {
    return output.map(v => v > 0 ? 1 : 0);
  }
};

// Leaky ReLU: x > 0 ? x : 0.01x
export const leakyRelu = {
  name: 'leaky_relu',
  forward(x) {
    return x.map(v => v > 0 ? v : 0.01 * v);
  },
  backward(output) {
    return output.map(v => v > 0 ? 1 : 0.01);
  }
};

// Tanh
export const tanh = {
  name: 'tanh',
  forward(x) {
    return x.map(v => Math.tanh(v));
  },
  backward(output) {
    // derivative: 1 - tanh²(x)
    return output.map(v => 1 - v * v);
  }
};

// Softmax (applied per row)
export const softmax = {
  name: 'softmax',
  forward(x) {
    const result = new Matrix(x.rows, x.cols);
    for (let i = 0; i < x.rows; i++) {
      // Numerical stability: subtract max
      let maxVal = -Infinity;
      for (let j = 0; j < x.cols; j++) {
        const v = x.get(i, j);
        if (v > maxVal) maxVal = v;
      }
      let sumExp = 0;
      for (let j = 0; j < x.cols; j++) {
        sumExp += Math.exp(x.get(i, j) - maxVal);
      }
      for (let j = 0; j < x.cols; j++) {
        result.set(i, j, Math.exp(x.get(i, j) - maxVal) / sumExp);
      }
    }
    return result;
  },
  backward(output) {
    // For softmax + cross-entropy, the gradient is simplified
    // We'll handle this in the loss function
    return Matrix.ones(output.rows, output.cols);
  }
};

// Linear (identity) — no activation
/**
 * GELU activation: x * Φ(x) where Φ is the standard normal CDF
 * Used in BERT, GPT, and modern transformers.
 * Approximation: 0.5 * x * (1 + tanh(sqrt(2/π) * (x + 0.044715 * x³)))
 */
export const gelu = {
  forward(x) {
    const result = new Matrix(x.rows, x.cols);
    const c = Math.sqrt(2 / Math.PI);
    for (let i = 0; i < x.data.length; i++) {
      const v = x.data[i];
      const inner = c * (v + 0.044715 * v * v * v);
      result.data[i] = 0.5 * v * (1 + Math.tanh(inner));
    }
    // Cache input for backward
    result._geluInput = x;
    return result;
  },
  backward(output) {
    // Derivative of GELU approximation
    const x = output._geluInput || output;
    const result = new Matrix(x.rows, x.cols);
    const c = Math.sqrt(2 / Math.PI);
    for (let i = 0; i < x.data.length; i++) {
      const v = x.data[i];
      const inner = c * (v + 0.044715 * v * v * v);
      const tanhInner = Math.tanh(inner);
      const sech2 = 1 - tanhInner * tanhInner;
      const dInner = c * (1 + 3 * 0.044715 * v * v);
      // d/dx [0.5*x*(1+tanh(inner))] = 0.5*(1+tanh(inner)) + 0.5*x*sech²(inner)*dInner
      result.data[i] = 0.5 * (1 + tanhInner) + 0.5 * v * sech2 * dInner;
    }
    return result;
  }
};

/**
 * Swish/SiLU activation: x * sigmoid(x)
 * Used in EfficientNet, Llama, and other modern architectures.
 * Self-gated: smooth approximation of ReLU.
 */
export const swish = {
  forward(x) {
    const result = new Matrix(x.rows, x.cols);
    for (let i = 0; i < x.data.length; i++) {
      const v = x.data[i];
      const sig = 1 / (1 + Math.exp(-v));
      result.data[i] = v * sig;
    }
    result._swishInput = x;
    return result;
  },
  backward(output) {
    const x = output._swishInput || output;
    const result = new Matrix(x.rows, x.cols);
    for (let i = 0; i < x.data.length; i++) {
      const v = x.data[i];
      const sig = 1 / (1 + Math.exp(-v));
      // d/dx [x * sigmoid(x)] = sigmoid(x) + x * sigmoid(x) * (1 - sigmoid(x))
      //                        = sigmoid(x) * (1 + x * (1 - sigmoid(x)))
      result.data[i] = sig * (1 + v * (1 - sig));
    }
    return result;
  }
};

export const linear = {
  name: 'linear',
  forward(x) { return x.clone(); },
  backward(output) { return Matrix.ones(output.rows, output.cols); }
};

// Get activation by name
export function getActivation(name) {
  const activations = { sigmoid, relu, leaky_relu: leakyRelu, tanh, softmax, linear, gelu, swish, silu: swish };
  return activations[name] || linear;
}
