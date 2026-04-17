// optimizer.js — Optimizer implementations (SGD, SGD+Momentum, Adam, RMSProp)

import { Matrix } from './matrix.js';

/**
 * SGD optimizer (vanilla stochastic gradient descent)
 */
export class SGD {
  constructor(lr = 0.01, { weightDecay = 0 } = {}) {
    this.lr = lr;
    this.weightDecay = weightDecay;
    this.name = 'sgd';
  }

  init(layer) {}

  update(param, grad) {
    // L2 regularization: grad += wd * param
    const effGrad = this.weightDecay > 0 ? grad.add(param.mul(this.weightDecay)) : grad;
    return param.sub(effGrad.mul(this.lr));
  }
}

/**
 * SGD with momentum
 */
export class MomentumSGD {
  constructor(lr = 0.01, momentum = 0.9) {
    this.lr = lr;
    this.momentum = momentum;
    this.name = 'momentum';
    this._velocities = new Map();
  }

  init(layer) {}

  _getVelocity(key, grad) {
    if (!this._velocities.has(key)) {
      this._velocities.set(key, Matrix.zeros(grad.rows, grad.cols));
    }
    return this._velocities.get(key);
  }

  update(param, grad, key = '') {
    const v = this._getVelocity(key, grad);
    const newV = v.mul(this.momentum).add(grad.mul(this.lr));
    this._velocities.set(key, newV);
    return param.sub(newV);
  }
}

/**
 * Adam optimizer (Adaptive Moment Estimation)
 * Kingma & Ba, 2014
 */
export class Adam {
  constructor(lr = 0.001, beta1 = 0.9, beta2 = 0.999, epsilon = 1e-8, { weightDecay = 0 } = {}) {
    this.lr = lr;
    this.beta1 = beta1;
    this.beta2 = beta2;
    this.epsilon = epsilon;
    this.weightDecay = weightDecay;
    this.name = 'adam';
    this.t = 0;
    this._m = new Map(); // First moment (mean)
    this._v = new Map(); // Second moment (variance)
  }

  init(layer) {}

  _getState(key, grad) {
    if (!this._m.has(key)) {
      this._m.set(key, Matrix.zeros(grad.rows, grad.cols));
      this._v.set(key, Matrix.zeros(grad.rows, grad.cols));
    }
    return { m: this._m.get(key), v: this._v.get(key) };
  }

  step() {
    this.t++;
  }

  update(param, grad, key = '') {
    this.t++;  // Auto-increment t (step() is optional)
    const { m, v } = this._getState(key, grad);

    // Update biased first moment estimate
    const newM = m.mul(this.beta1).add(grad.mul(1 - this.beta1));
    // Update biased second raw moment estimate  
    const newV = v.mul(this.beta2).add(grad.mul(grad).mul(1 - this.beta2));
    
    this._m.set(key, newM);
    this._v.set(key, newV);

    // Compute bias-corrected first moment estimate
    const bc1 = 1 - Math.pow(this.beta1, this.t);
    const bc2 = 1 - Math.pow(this.beta2, this.t);
    const mHat = newM.mul(1.0 / bc1);
    const vHat = newV.mul(1.0 / bc2);

    // Update parameters (with optional L2 weight decay)
    const eps = this.epsilon;
    let result = param.sub(mHat.mul(this.lr).mul(vHat.map(x => 1.0 / (Math.sqrt(x) + eps))));
    if (this.weightDecay > 0) result = result.sub(param.mul(this.weightDecay * this.lr));
    return result;
  }
}

/**
 * RMSProp optimizer
 * Hinton, 2012
 */
export class RMSProp {
  constructor(lr = 0.001, decay = 0.99, epsilon = 1e-8) {
    this.lr = lr;
    this.decay = decay;
    this.epsilon = epsilon;
    this.name = 'rmsprop';
    this._cache = new Map();
  }

  init(layer) {}

  _getCache(key, grad) {
    if (!this._cache.has(key)) {
      this._cache.set(key, Matrix.zeros(grad.rows, grad.cols));
    }
    return this._cache.get(key);
  }

  step() {}

  update(param, grad, key = '') {
    const cache = this._getCache(key, grad);
    const newCache = cache.mul(this.decay).add(grad.mul(grad).mul(1 - this.decay));
    this._cache.set(key, newCache);
    const eps = this.epsilon;
    return param.sub(grad.mul(this.lr).mul(newCache.map(x => 1.0 / (Math.sqrt(x) + eps))));
  }
}

/**
 * AdamW optimizer (Decoupled Weight Decay)
 * Loshchilov & Hutter, 2017
 * Key difference from Adam: weight decay is applied directly to parameters,
 * not through gradient (decoupled from adaptive learning rate)
 */
export class AdamW {
  constructor(lr = 0.001, beta1 = 0.9, beta2 = 0.999, epsilon = 1e-8, weightDecay = 0.01) {
    this.lr = lr;
    this.beta1 = beta1;
    this.beta2 = beta2;
    this.epsilon = epsilon;
    this.weightDecay = weightDecay;
    this.name = 'adamw';
    this.t = 0;
    this._m = new Map();
    this._v = new Map();
  }

  init(layer) {}

  _getState(key, grad) {
    if (!this._m.has(key)) {
      this._m.set(key, Matrix.zeros(grad.rows, grad.cols));
      this._v.set(key, Matrix.zeros(grad.rows, grad.cols));
    }
    return { m: this._m.get(key), v: this._v.get(key) };
  }

  step() { this.t++; }

  update(param, grad, key = '') {
    this.t++;  // Auto-increment t
    const { m, v } = this._getState(key, grad);

    const newM = m.mul(this.beta1).add(grad.mul(1 - this.beta1));
    const newV = v.mul(this.beta2).add(grad.mul(grad).mul(1 - this.beta2));
    this._m.set(key, newM);
    this._v.set(key, newV);

    const bc1 = 1 - Math.pow(this.beta1, this.t);
    const bc2 = 1 - Math.pow(this.beta2, this.t);
    const mHat = newM.mul(1.0 / bc1);
    const vHat = newV.mul(1.0 / bc2);

    const eps = this.epsilon;
    // Adam update
    let result = param.sub(mHat.mul(this.lr).mul(vHat.map(x => 1.0 / (Math.sqrt(x) + eps))));
    // Decoupled weight decay: applied to param directly, not through grad
    result = result.sub(param.mul(this.weightDecay * this.lr));
    return result;
  }
}

/**
 * Create an optimizer by name
 */
export function createOptimizer(name, options = {}) {
  const wd = { weightDecay: options.weightDecay || 0 };
  switch (name) {
    case 'sgd': return new SGD(options.lr || 0.01, wd);
    case 'momentum': return new MomentumSGD(options.lr || 0.01, options.momentum || 0.9);
    case 'adam': return new Adam(options.lr || 0.001, options.beta1, options.beta2, options.epsilon, wd);
    case 'adamw': return new AdamW(options.lr || 0.001, options.beta1, options.beta2, options.epsilon, options.weightDecay || 0.01);
    case 'rmsprop': return new RMSProp(options.lr || 0.001, options.decay, options.epsilon);
    case 'natural': return new NaturalGradient(options.lr || 0.01, options.damping || 0.01, options.decay || 0.95);
    default: throw new Error(`Unknown optimizer: ${name}`);
  }
}

/**
 * Natural Gradient Descent — Diagonal Fisher Information Matrix approximation.
 * 
 * The natural gradient rescales the gradient by the inverse Fisher Information Matrix.
 * This makes updates invariant to parameterization and often converges faster.
 * 
 * The diagonal Fisher is approximated as a running average of squared gradients:
 *   F_diag ≈ E[∂log p(y|θ) / ∂θ]² ≈ decay · F_old + (1 - decay) · grad²
 * 
 * The natural gradient update:
 *   θ_new = θ - lr · F^{-1} · grad = θ - lr · grad / (F_diag + λ)
 * 
 * where λ is a damping term for numerical stability.
 * 
 * This is conceptually similar to Adam (which also uses running gradient statistics),
 * but:
 * - Uses the Fisher Information interpretation (information geometry)
 * - Single decay parameter (not separate β1, β2)
 * - No first moment (mean) estimate — just rescaling
 * - Explicit damping instead of ε
 * 
 * Based on: Amari (1998), "Natural Gradient Works Efficiently in Learning"
 */
export class NaturalGradient {
  /**
   * @param {number} lr - Learning rate
   * @param {number} damping - Damping term λ (prevents division by near-zero Fisher entries)
   * @param {number} decay - Exponential decay for Fisher estimate (0.9-0.999)
   */
  constructor(lr = 0.01, damping = 0.01, decay = 0.95) {
    this.lr = lr;
    this.damping = damping;
    this.decay = decay;
    this.name = 'natural';
    this._fisher = new Map(); // Diagonal Fisher estimates per parameter
    this.t = 0;
  }

  init(layer) {}

  step() { this.t++; }

  _getFisher(key, grad) {
    if (!this._fisher.has(key)) {
      this._fisher.set(key, Matrix.zeros(grad.rows, grad.cols));
    }
    return this._fisher.get(key);
  }

  /**
   * Update parameters using natural gradient.
   * @param {Matrix} param - Current parameter values
   * @param {Matrix} grad - Gradient
   * @param {string} key - Parameter identifier
   * @returns {Matrix} Updated parameters
   */
  update(param, grad, key = '') {
    const fisher = this._getFisher(key, grad);

    // Update diagonal Fisher estimate: F = decay * F + (1 - decay) * grad²
    const gradSq = grad.map(x => x * x);
    const newFisher = fisher.mul(this.decay).add(gradSq.mul(1 - this.decay));
    this._fisher.set(key, newFisher);

    // Natural gradient: param -= lr * grad / (sqrt(F) + λ)
    const damping = this.damping;
    const naturalGrad = grad.map((g, i) => {
      const f = newFisher.data[i];
      return g / (Math.sqrt(f) + damping);
    });

    return param.sub(naturalGrad.mul(this.lr));
  }

  /**
   * Get the Fisher information estimate for diagnostic purposes.
   * @param {string} key - Parameter identifier
   * @returns {Matrix|null}
   */
  getFisherEstimate(key) {
    return this._fisher.get(key) || null;
  }
}

/**
 * K-FAC Optimizer — Kronecker-Factored Approximate Curvature.
 * 
 * A more sophisticated natural gradient method that approximates the
 * Fisher Information Matrix using Kronecker products of layer-wise
 * activation and gradient statistics.
 * 
 * For each Dense layer:
 *   F_layer ≈ A ⊗ G
 * where:
 *   A = E[a · a^T] (input activation covariance)
 *   G = E[δ · δ^T] (output gradient covariance)
 * 
 * The inverse is then:
 *   F^{-1} ≈ A^{-1} ⊗ G^{-1}
 * 
 * This reduces the cost from O(n³) to O(n_in³ + n_out³) per layer.
 * 
 * Based on: Martens & Grosse (2015), "Optimizing Neural Networks with
 * Kronecker-factored Approximate Curvature"
 */
export class KFAC {
  /**
   * @param {number} lr - Learning rate
   * @param {number} damping - Tikhonov damping factor
   * @param {number} decay - Exponential decay for running averages
   * @param {number} updateFreq - How often to recompute inverse (steps)
   */
  constructor(lr = 0.01, damping = 0.01, decay = 0.95, updateFreq = 10) {
    this.lr = lr;
    this.damping = damping;
    this.decay = decay;
    this.updateFreq = updateFreq;
    this.name = 'kfac';
    this.t = 0;
    this._A = new Map();     // Input covariance per layer
    this._G = new Map();     // Output gradient covariance per layer
    this._Ainv = new Map();  // Cached inverse
    this._Ginv = new Map();  // Cached inverse
  }

  init(layer) {}
  step() { this.t++; }

  /**
   * Update Kronecker factors with new activations and gradients.
   * Call this during the forward/backward pass.
   * @param {string} layerKey - Layer identifier
   * @param {Matrix} activation - Layer input (n_in × 1 or batch)
   * @param {Matrix} gradient - Output gradient (n_out × 1 or batch)
   */
  updateFactors(layerKey, activation, gradient) {
    // A = E[a · a^T] (input activation auto-correlation)
    const a = activation;
    const aAT = a.dot(a.transpose()); // (n_in × n_in)

    if (!this._A.has(layerKey)) {
      this._A.set(layerKey, aAT);
    } else {
      const oldA = this._A.get(layerKey);
      this._A.set(layerKey, oldA.mul(this.decay).add(aAT.mul(1 - this.decay)));
    }

    // G = E[δ · δ^T] (output gradient auto-correlation)
    const g = gradient;
    const gGT = g.dot(g.transpose()); // (n_out × n_out)

    if (!this._G.has(layerKey)) {
      this._G.set(layerKey, gGT);
    } else {
      const oldG = this._G.get(layerKey);
      this._G.set(layerKey, oldG.mul(this.decay).add(gGT.mul(1 - this.decay)));
    }

    // Periodically recompute inverses
    if (this.t % this.updateFreq === 0) {
      this._computeInverses(layerKey);
    }
  }

  /**
   * Compute damped inverses of A and G.
   */
  _computeInverses(layerKey) {
    const A = this._A.get(layerKey);
    const G = this._G.get(layerKey);
    if (!A || !G) return;

    // Add damping: A + λI
    this._Ainv.set(layerKey, this._dampedInverse(A));
    this._Ginv.set(layerKey, this._dampedInverse(G));
  }

  /**
   * Compute (M + λI)^{-1} using simple matrix operations.
   * For small matrices (typical layer sizes < 100), this is fine.
   */
  _dampedInverse(M) {
    const n = M.rows;
    // Add damping
    const damped = new Matrix(n, n, new Float64Array(M.data));
    for (let i = 0; i < n; i++) {
      damped.data[i * n + i] += this.damping;
    }
    // Gauss-Jordan elimination
    return this._invert(damped);
  }

  /**
   * Matrix inversion via Gauss-Jordan elimination.
   */
  _invert(M) {
    const n = M.rows;
    // Augmented matrix [M | I]
    const aug = new Float64Array(n * 2 * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        aug[i * 2 * n + j] = M.data[i * n + j];
      }
      aug[i * 2 * n + n + i] = 1;
    }

    // Forward elimination
    for (let col = 0; col < n; col++) {
      // Partial pivoting
      let maxRow = col;
      let maxVal = Math.abs(aug[col * 2 * n + col]);
      for (let row = col + 1; row < n; row++) {
        const val = Math.abs(aug[row * 2 * n + col]);
        if (val > maxVal) { maxVal = val; maxRow = row; }
      }
      if (maxRow !== col) {
        for (let j = 0; j < 2 * n; j++) {
          const tmp = aug[col * 2 * n + j];
          aug[col * 2 * n + j] = aug[maxRow * 2 * n + j];
          aug[maxRow * 2 * n + j] = tmp;
        }
      }

      const pivot = aug[col * 2 * n + col];
      if (Math.abs(pivot) < 1e-12) continue; // Singular

      // Scale pivot row
      for (let j = 0; j < 2 * n; j++) aug[col * 2 * n + j] /= pivot;

      // Eliminate
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = aug[row * 2 * n + col];
        for (let j = 0; j < 2 * n; j++) {
          aug[row * 2 * n + j] -= factor * aug[col * 2 * n + j];
        }
      }
    }

    // Extract inverse
    const inv = new Matrix(n, n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        inv.data[i * n + j] = aug[i * 2 * n + n + j];
      }
    }
    return inv;
  }

  /**
   * Update parameters using K-FAC natural gradient.
   * Natural gradient of weight matrix W:
   *   Ã = A^{-1} · grad_W · G^{-1}
   *   W_new = W - lr · Ã
   * 
   * Falls back to standard gradient if factors aren't available.
   */
  update(param, grad, key = '') {
    const Ainv = this._Ainv.get(key);
    const Ginv = this._Ginv.get(key);

    if (!Ainv || !Ginv) {
      // Fallback to standard gradient descent
      return param.sub(grad.mul(this.lr));
    }

    // Natural gradient: Ginv · grad · Ainv
    // grad is (n_out × n_in), Ginv is (n_out × n_out), Ainv is (n_in × n_in)
    const naturalGrad = Ginv.dot(grad).dot(Ainv);
    return param.sub(naturalGrad.mul(this.lr));
  }

  /**
   * Check if factors have been initialized for a layer.
   */
  hasFactors(key) {
    return this._A.has(key) && this._G.has(key);
  }
}
