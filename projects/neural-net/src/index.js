// ===== Neural Network from Scratch =====
// Barrel file — re-exports from modular system + unified Network class

// Core
export { Matrix } from './matrix.js';
import { Matrix } from './matrix.js';

// Activations (matrix-level forward/backward)
export { sigmoid, relu, leakyRelu, tanh, softmax, linear, gelu, swish, getActivation } from './activation.js';
import { sigmoid, relu, leakyRelu, tanh as tanhAct, softmax, linear, getActivation } from './activation.js';

// Layers
export { Dense } from './layer.js';
export { Conv2D, MaxPool2D, Flatten } from './conv.js';
export { RNN, LSTM, GRU } from './rnn.js';
export { SelfAttention, MultiHeadAttention } from './attention.js';
export { Embedding } from './embedding.js';
export { PositionalEncoding, LayerNorm, TransformerEncoderBlock } from './transformer.js';
export { Residual, Sequential } from './residual.js';
export { Dropout } from './dropout.js';
export { BatchNorm } from './batchnorm.js';

import { Dense } from './layer.js';

// High-level modules
export { Autoencoder, VAE } from './autoencoder.js';
export { GAN } from './gan.js';
export { MicroGPT, encodeText, decodeTokens, createSequences } from './microgpt.js';

// Augmentation
export { addNoise, randomFlipH, randomCrop, mixup, cutout, randomBrightnessContrast, compose } from './augmentation.js';

// Training utilities
export { EarlyStopping, LossHistory } from './callbacks.js';
export { createScheduler, ConstantLR, LinearWarmup, CosineAnnealing, StepDecay, WarmupCosine, ExponentialDecay, CyclicLR, LinearDecay } from './scheduler.js';
export { SGD, MomentumSGD, Adam, RMSProp, AdamW, createOptimizer } from './optimizer.js';
import { createScheduler } from './scheduler.js';

// ===== Activations object (for string lookup, supports both scalar and matrix) =====
function wrapActivation(act) {
  return {
    name: act.name,
    forward(x) {
      if (x instanceof Matrix) return act.forward(x);
      // Scalar
      const m = Matrix.fromArray([[x]]);
      return act.forward(m).get(0, 0);
    },
    backward(y) {
      if (y instanceof Matrix) return act.backward(y);
      const m = Matrix.fromArray([[y]]);
      return act.backward(m).get(0, 0);
    },
  };
}

export const activations = {
  sigmoid: wrapActivation(sigmoid),
  relu: wrapActivation(relu),
  leakyRelu: wrapActivation(leakyRelu),
  tanh: wrapActivation(tanhAct),
  softmax: wrapActivation(softmax),
  linear: wrapActivation(linear),
};

// ===== Loss functions =====
export const losses = {
  mse: {
    name: 'mse',
    forward(predicted, target) {
      let sum = 0;
      for (let i = 0; i < predicted.data.length; i++) {
        const d = predicted.data[i] - target.data[i];
        sum += d * d;
      }
      return sum / predicted.data.length;
    },
    backward(predicted, target) {
      // Return raw gradient (layer handles batch normalization)
      const result = new Matrix(predicted.rows, predicted.cols);
      for (let i = 0; i < predicted.data.length; i++) {
        result.data[i] = 2 * (predicted.data[i] - target.data[i]) / predicted.cols;
      }
      return result;
    },
  },
  crossEntropy: {
    name: 'crossEntropy',
    forward(predicted, target) {
      let sum = 0;
      const eps = 1e-15;
      for (let i = 0; i < predicted.data.length; i++) {
        const p = Math.max(eps, Math.min(1 - eps, predicted.data[i]));
        const t = target.data[i];
        sum -= t * Math.log(p) + (1 - t) * Math.log(1 - p);
      }
      return sum / predicted.rows;
    },
    backward(predicted, target) {
      const eps = 1e-15;
      const result = new Matrix(predicted.rows, predicted.cols);
      for (let i = 0; i < predicted.data.length; i++) {
        const p = Math.max(eps, Math.min(1 - eps, predicted.data[i]));
        const t = target.data[i];
        result.data[i] = (-t / p + (1 - t) / (1 - p));
      }
      return result;
    },
  },
};

// Add compute/gradient aliases and name variants
for (const key of Object.keys(losses)) {
  losses[key].compute = losses[key].forward;
  losses[key].gradient = losses[key].backward;
}
losses.cross_entropy = losses.crossEntropy;

export const mse = losses.mse;
export const crossEntropy = losses.crossEntropy;

// ===== DenseLayer (legacy, for backward compat) =====
export class DenseLayer {
  constructor(inputSize, outputSize, activation = 'sigmoid') {
    const act = activations[activation] || activations.sigmoid;
    this.weights = Matrix.xavier
      ? Matrix.xavier(inputSize, outputSize)
      : Matrix.random(inputSize, outputSize, Math.sqrt(2 / (inputSize + outputSize)));
    this.bias = Matrix.zeros(1, outputSize);
    this.activation = { forward: act.forward ? (x => typeof x === 'number' ? act.forward(new Matrix(1,1,new Float64Array([x]))).get(0,0) : act.forward(x)) : (x => x), backward: act.backward || (() => 1) };
    this.activationName = activation;
    this.input = null;
    this.z = null;
    this.output = null;
  }

  forward(input) {
    this.input = input;
    this.z = input.dot(this.weights).add(this.bias);
    this.output = this.z.map(v => {
      const m = new Matrix(1,1,new Float64Array([v]));
      const r = activations[this.activationName].forward(m);
      return r.get(0,0);
    });
    return this.output;
  }

  backward(gradOutput, learningRate) {
    const gradZ = gradOutput.mul(this.output.map(v => {
      const m = new Matrix(1,1,new Float64Array([v]));
      const r = activations[this.activationName].backward(m);
      return r.get(0,0);
    }));
    const gradWeights = this.input.transpose().dot(gradZ);
    const gradBias = gradZ.sumRows();
    const gradInput = gradZ.dot(this.weights.transpose());
    this.weights = this.weights.sub(gradWeights.mul(learningRate));
    this.bias = this.bias.sub(gradBias.mul(learningRate));
    return gradInput;
  }
}

// ===== Network (unified) =====
export class NeuralNetwork {
  constructor(layers = []) {
    this.layers = layers;
    this._lossObj = losses.mse;
    this._optimizerName = 'sgd';
    this._optimizerOpts = {};
    this._training = true;
  }

  // Add a layer instance (Dense, Conv2D, Flatten, etc.)
  add(layer) {
    this.layers.push(layer);
    return this;
  }

  // Legacy: add a Dense layer by dimensions
  addLayer(inputSize, outputSize, activation = 'sigmoid') {
    this.layers.push(new Dense(inputSize, outputSize, activation));
    return this;
  }

  // Alias
  dense(inputSize, outputSize, activation = 'sigmoid') {
    return this.addLayer(inputSize, outputSize, activation);
  }

  // Set loss function
  loss(name) {
    if (typeof name === 'string') this._lossObj = losses[name];
    else this._lossObj = name;
    return this;
  }

  setLoss(name) { return this.loss(name); }

  // Set optimizer
  optimizer(name, opts = {}) {
    this._optimizerName = name;
    this._optimizerOpts = opts;
    return this;
  }

  // Forward pass
  forward(input) {
    let output = input;
    for (const layer of this.layers) {
      if (layer.training !== undefined) layer.training = this._training;
      output = layer.forward(output);
    }
    return output;
  }

  // Backward pass
  backward(predicted, target, learningRate) {
    let grad = this._lossObj.backward(predicted, target);
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (layer.update) {
        // Modular layer (has separate backward + update)
        grad = layer.backward(grad);
        layer.update(learningRate, 0, this._optimizerName);
      } else if (layer.backward) {
        // Legacy DenseLayer or passthrough layers
        grad = layer.backward(grad, learningRate);
      }
      // Layers without backward (e.g., Flatten) are skipped
    }
  }

  // Train with flexible API
  train(inputsOrObj, targetsOrOpts, opts) {
    let inputs, targets, options;
    
    if (inputsOrObj && typeof inputsOrObj === 'object' && !(inputsOrObj instanceof Matrix) && !Array.isArray(inputsOrObj) && inputsOrObj.inputs) {
      // New API: train({ inputs, targets }, options)
      inputs = inputsOrObj.inputs;
      targets = inputsOrObj.targets;
      options = targetsOrOpts || {};
    } else {
      // Legacy API: train(inputs, targets, options)
      inputs = inputsOrObj;
      targets = targetsOrOpts;
      options = opts || {};
    }

    const {
      epochs = 1000,
      learningRate = 0.1,
      verbose = false,
      batchSize = null,
      callbacks = [],
      lrSchedule = null,
      onEpoch = null,
    } = options;

    const inputMatrix = inputs instanceof Matrix ? inputs : Matrix.fromArray(inputs);
    const targetMatrix = targets instanceof Matrix ? targets : Matrix.fromArray(targets);
    const history = [];
    this._training = true;
    
    let lr = this._optimizerOpts.lr || learningRate;

    // LR scheduler
    let scheduler = null;
    if (lrSchedule) {
      scheduler = typeof lrSchedule === 'string' 
        ? createScheduler(lrSchedule, { lr, baseLR: lr, maxLR: lr, totalEpochs: epochs })
        : lrSchedule;
    }

    for (let epoch = 0; epoch < epochs; epoch++) {
      const currentLR = scheduler ? scheduler.getLR(epoch) : lr;
      let epochLoss;

      if (batchSize && batchSize < inputMatrix.rows) {
        // Mini-batch training with shuffle
        const indices = Array.from({ length: inputMatrix.rows }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        let totalLoss = 0;
        let batchCount = 0;
        for (let start = 0; start < indices.length; start += batchSize) {
          const end = Math.min(start + batchSize, indices.length);
          const batchIndices = indices.slice(start, end);
          const batchInput = new Matrix(batchIndices.length, inputMatrix.cols);
          const batchTarget = new Matrix(batchIndices.length, targetMatrix.cols);
          for (let i = 0; i < batchIndices.length; i++) {
            for (let j = 0; j < inputMatrix.cols; j++) batchInput.set(i, j, inputMatrix.get(batchIndices[i], j));
            for (let j = 0; j < targetMatrix.cols; j++) batchTarget.set(i, j, targetMatrix.get(batchIndices[i], j));
          }
          const output = this.forward(batchInput);
          totalLoss += this._lossObj.forward(output, batchTarget);
          this.backward(output, batchTarget, currentLR);
          batchCount++;
        }
        epochLoss = totalLoss / batchCount;
      } else {
        const output = this.forward(inputMatrix);
        epochLoss = this._lossObj.forward(output, targetMatrix);
        this.backward(output, targetMatrix, currentLR);
      }

      history.push(epochLoss);

      if (verbose && epoch % Math.max(1, Math.floor(epochs / 10)) === 0) {
        console.log(`Epoch ${epoch}: loss = ${epochLoss.toFixed(6)}`);
      }

      // Callbacks
      if (onEpoch) onEpoch(epoch, epochLoss, currentLR);
      for (const cb of callbacks) {
        let stop = false;
        if (cb.onEpochEnd) {
          stop = cb.onEpochEnd(epoch, epochLoss, this);
        } else if (cb.onEpoch) {
          stop = cb.onEpoch({ epoch, loss: epochLoss, lr: currentLR, network: this });
        }
        if (stop === true) {
          this._training = false;
          return history;
        }
      }
    }

    this._training = false;
    return history;
  }

  // Train with gradient accumulation
  trainWithGradientAccumulation(inputsOrObj, targetsOrOpts, opts) {
    let inputs, targets, options;
    if (inputsOrObj && typeof inputsOrObj === 'object' && !(inputsOrObj instanceof Matrix) && !Array.isArray(inputsOrObj) && inputsOrObj.inputs) {
      inputs = inputsOrObj.inputs;
      targets = inputsOrObj.targets;
      options = targetsOrOpts || {};
    } else {
      inputs = inputsOrObj;
      targets = targetsOrOpts;
      options = opts || {};
    }

    const {
      epochs = 1000,
      learningRate = 0.1,
      accumSteps = 4,
      microBatchSize = null,
      verbose = false,
      onEpoch = null,
      lrSchedule = null,
      optimizer: optName = null,
      callbacks = [],
    } = options;

    // Override optimizer if specified
    if (optName) this._optimizerName = optName;

    const inputMatrix = inputs instanceof Matrix ? inputs : Matrix.fromArray(inputs);
    const targetMatrix = targets instanceof Matrix ? targets : Matrix.fromArray(targets);
    const history = [];
    this._training = true;

    let lr = this._optimizerOpts.lr || learningRate;
    let scheduler = null;
    if (lrSchedule) {
      scheduler = typeof lrSchedule === 'string'
        ? createScheduler(lrSchedule, { lr, baseLR: lr, maxLR: lr, totalEpochs: epochs })
        : lrSchedule;
    }

    // Calculate micro batch size
    const mbSize = microBatchSize || Math.ceil(inputMatrix.rows / accumSteps);

    for (let epoch = 0; epoch < epochs; epoch++) {
      const currentLR = scheduler ? scheduler.getLR(epoch) : lr;
      let totalLoss = 0;
      let steps = 0;

      // Shuffle indices
      const indices = Array.from({ length: inputMatrix.rows }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }

      for (let start = 0; start < indices.length; start += mbSize) {
        const end = Math.min(start + mbSize, indices.length);
        const batchIndices = indices.slice(start, end);
        const batchInput = new Matrix(batchIndices.length, inputMatrix.cols);
        const batchTarget = new Matrix(batchIndices.length, targetMatrix.cols);
        for (let bi = 0; bi < batchIndices.length; bi++) {
          for (let j = 0; j < inputMatrix.cols; j++) batchInput.set(bi, j, inputMatrix.get(batchIndices[bi], j));
          for (let j = 0; j < targetMatrix.cols; j++) batchTarget.set(bi, j, targetMatrix.get(batchIndices[bi], j));
        }
        const output = this.forward(batchInput);
        totalLoss += this._lossObj.forward(output, batchTarget);
        // Scale learning rate by accumulation steps
        this.backward(output, batchTarget, currentLR / accumSteps);
        steps++;
      }

      const epochLoss = totalLoss / steps;
      history.push(epochLoss);

      if (verbose && epoch % Math.max(1, Math.floor(epochs / 10)) === 0) {
        console.log(`Epoch ${epoch}: loss = ${epochLoss.toFixed(6)}`);
      }
      if (onEpoch) onEpoch(epoch, epochLoss, currentLR);
      for (const cb of callbacks) {
        let stop = false;
        if (cb.onEpochEnd) stop = cb.onEpochEnd(epoch, epochLoss, this);
        else if (cb.onEpoch) stop = cb.onEpoch({ epoch, loss: epochLoss, lr: currentLR, network: this });
        if (stop === true) { this._training = false; return history; }
      }
    }

    this._training = false;
    return history;
  }

  // Predict
  predict(input) {
    this._training = false;
    const inputMatrix = input instanceof Matrix ? input : Matrix.fromArray(
      Array.isArray(input[0]) ? input : [input]
    );
    return this.forward(inputMatrix);
  }

  // Evaluate accuracy
  evaluate(inputs, targets) {
    const inputMatrix = inputs instanceof Matrix ? inputs : Matrix.fromArray(inputs);
    const targetMatrix = targets instanceof Matrix ? targets : Matrix.fromArray(targets);
    this._training = false;
    const output = this.forward(inputMatrix);
    
    let correct = 0;
    for (let i = 0; i < output.rows; i++) {
      if (output.cols === 1) {
        // Binary
        const pred = output.get(i, 0) > 0.5 ? 1 : 0;
        const tgt = targetMatrix.get(i, 0) > 0.5 ? 1 : 0;
        if (pred === tgt) correct++;
      } else {
        // Multi-class: argmax
        let predMax = 0, tgtMax = 0;
        for (let j = 1; j < output.cols; j++) {
          if (output.get(i, j) > output.get(i, predMax)) predMax = j;
          if (targetMatrix.get(i, j) > targetMatrix.get(i, tgtMax)) tgtMax = j;
        }
        if (predMax === tgtMax) correct++;
      }
    }
    
    return { accuracy: correct / output.rows, loss: this._lossObj.forward(output, targetMatrix), total: output.rows };
  }

  // Summary
  summary() {
    const lines = ['Network Summary:', '─'.repeat(50)];
    let totalParams = 0;
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i];
      const name = l.constructor.name;
      const params = l.paramCount ? l.paramCount() : 0;
      totalParams += params;
      let shape = '';
      if (l.outputSize !== undefined) shape = ` → ${l.outputSize}`;
      if (l.inputSize !== undefined) shape = `${l.inputSize}${shape}`;
      const actName = l.activation?.name || l.activationName || '';
      lines.push(`  ${i}: ${name}(${shape}) ${actName ? `[${actName}]` : ''} ${params > 0 ? `[${params} params]` : ''}`);
    }
    lines.push('─'.repeat(50));
    lines.push(`Total parameters: ${totalParams}`);
    return lines.join('\n');
  }

  // Serialization
  toJSON() {
    return {
      layers: this.layers.map(l => {
        const obj = { type: l.constructor.name };
        if (l.weights) obj.weights = Array.from(l.weights.data);
        if (l.biases) obj.biases = Array.from(l.biases.data);
        if (l.bias) obj.biases = Array.from(l.bias.data);
        if (l.weights) { obj.rows = l.weights.rows; obj.cols = l.weights.cols; }
        if (l.inputSize !== undefined) obj.inputSize = l.inputSize;
        if (l.outputSize !== undefined) obj.outputSize = l.outputSize;
        if (l.activationName) obj.activation = l.activationName;
        if (l.activation && l.activation.name) obj.activation = l.activation.name;
        // Conv2D specific
        if (l.inputH !== undefined) obj.inputH = l.inputH;
        if (l.inputW !== undefined) obj.inputW = l.inputW;
        if (l.inputC !== undefined) obj.inputC = l.inputC;
        if (l.numFilters !== undefined) obj.numFilters = l.numFilters;
        if (l.filterSize !== undefined) obj.filterSize = l.filterSize;
        if (l.filters) obj.filters = Array.from(l.filters.data);
        return obj;
      }),
      loss: this._lossObj.name || 'mse',
    };
  }

  static fromJSON(json) {
    if (typeof json === 'string') json = JSON.parse(json);
    const net = new NeuralNetwork();
    for (const ld of json.layers) {
      if (ld.type === 'Dense' && ld.inputSize !== undefined) {
        const layer = new Dense(ld.inputSize, ld.outputSize, ld.activation || 'relu');
        if (ld.weights) layer.weights.data = Float64Array.from(ld.weights);
        if (ld.biases) layer.biases.data = Float64Array.from(ld.biases);
        net.layers.push(layer);
      } else if (ld.type === 'DenseLayer') {
        const layer = new DenseLayer(ld.rows, ld.cols, ld.activation);
        if (ld.weights) layer.weights.data = Float64Array.from(ld.weights);
        if (ld.biases) layer.bias.data = Float64Array.from(ld.biases);
        net.layers.push(layer);
      } else {
        // Generic fallback — try to reconstruct
        console.warn(`Cannot deserialize layer type: ${ld.type}`);
      }
    }
    if (json.loss) net.loss(json.loss);
    return net;
  }
}

// Alias
export const Network = NeuralNetwork;

// ===== Convenience builder =====
export function createNetwork(layerSizes, activationFn = 'sigmoid') {
  const net = new NeuralNetwork();
  for (let i = 0; i < layerSizes.length - 1; i++) {
    const act = i === layerSizes.length - 2 ? 'sigmoid' : activationFn;
    net.addLayer(layerSizes[i], layerSizes[i + 1], act);
  }
  return net;
}
