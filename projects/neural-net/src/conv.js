// conv.js — 2D Convolutional layer

import { Matrix } from './matrix.js';
import { getActivation } from './activation.js';

/**
 * Conv2D layer — applies learned filters over 2D spatial input
 * Input shape: [batch, height * width * channels] (flattened)
 * We store the spatial dimensions for proper convolution
 */
export class Conv2D {
  constructor(inputH, inputW, inputC, numFilters, filterSize, activation = 'relu', { stride = 1, padding = 0 } = {}) {
    this.inputH = inputH;
    this.inputW = inputW;
    this.inputC = inputC; // Input channels
    this.numFilters = numFilters;
    this.filterSize = filterSize;
    this.stride = stride;
    this.padding = padding;
    this.activation = getActivation(activation);

    // Output dimensions
    this.outputH = Math.floor((inputH + 2 * padding - filterSize) / stride) + 1;
    this.outputW = Math.floor((inputW + 2 * padding - filterSize) / stride) + 1;

    // Input size (flattened) and output size (flattened)
    this.inputSize = inputH * inputW * inputC;
    this.outputSize = this.outputH * this.outputW * numFilters;

    // Filters: [numFilters, filterSize * filterSize * inputC]
    const fanIn = filterSize * filterSize * inputC;
    const fanOut = numFilters;
    const scale = Math.sqrt(2.0 / fanIn);
    this.filters = new Matrix(numFilters, fanIn).randomize(scale);
    this.biases = new Matrix(1, numFilters);

    // Cache
    this.input = null;
    this.cols = null; // im2col output
    this.z = null;
    this.a = null;
    this.training = true;

    // Gradients
    this.dFilters = null;
    this.dBiases = null;
  }

  // im2col: convert input patches to columns for efficient convolution
  _im2col(input, batchIdx) {
    const { inputH: H, inputW: W, inputC: C, filterSize: F, stride: S, padding: P, outputH: OH, outputW: OW } = this;
    const cols = new Matrix(OH * OW, F * F * C);

    for (let oh = 0; oh < OH; oh++) {
      for (let ow = 0; ow < OW; ow++) {
        const rowIdx = oh * OW + ow;
        let colIdx = 0;
        for (let c = 0; c < C; c++) {
          for (let fh = 0; fh < F; fh++) {
            for (let fw = 0; fw < F; fw++) {
              const ih = oh * S - P + fh;
              const iw = ow * S - P + fw;
              if (ih >= 0 && ih < H && iw >= 0 && iw < W) {
                cols.set(rowIdx, colIdx, input.get(batchIdx, (c * H + ih) * W + iw));
              }
              colIdx++;
            }
          }
        }
      }
    }
    return cols;
  }

  forward(input) {
    this.input = input;
    const batchSize = input.rows;
    const output = new Matrix(batchSize, this.outputSize);
    this.colsCache = []; // Cache im2col for backward

    for (let b = 0; b < batchSize; b++) {
      const cols = this._im2col(input, b);
      this.colsCache.push(cols);
      // Convolution = cols · filters^T + bias
      const conv = cols.dot(this.filters.T());
      // Add bias and apply activation
      for (let i = 0; i < conv.rows; i++) {
        for (let f = 0; f < this.numFilters; f++) {
          const val = conv.get(i, f) + this.biases.get(0, f);
          const outIdx = f * this.outputH * this.outputW + i;
          output.set(b, outIdx, val);
        }
      }
    }

    this.z = output;
    this.a = this.activation.forward(output);
    return this.a;
  }

  // col2im: distribute gradients back to input space
  _col2im(dCols, batchIdx, dInput) {
    const { inputH: H, inputW: W, inputC: C, filterSize: F, stride: S, padding: P, outputH: OH, outputW: OW } = this;

    for (let oh = 0; oh < OH; oh++) {
      for (let ow = 0; ow < OW; ow++) {
        const rowIdx = oh * OW + ow;
        let colIdx = 0;
        for (let c = 0; c < C; c++) {
          for (let fh = 0; fh < F; fh++) {
            for (let fw = 0; fw < F; fw++) {
              const ih = oh * S - P + fh;
              const iw = ow * S - P + fw;
              if (ih >= 0 && ih < H && iw >= 0 && iw < W) {
                const inputIdx = (c * H + ih) * W + iw;
                const prev = dInput.get(batchIdx, inputIdx);
                dInput.set(batchIdx, inputIdx, prev + dCols.get(rowIdx, colIdx));
              }
              colIdx++;
            }
          }
        }
      }
    }
  }

  backward(dOutput) {
    const activGrad = this.activation.backward(this.a);
    const dz = dOutput.mul(activGrad);
    const batchSize = this.input.rows;

    // Initialize gradient accumulators
    this.dFilters = Matrix.zeros(this.numFilters, this.filterSize * this.filterSize * this.inputC);
    this.dBiases = Matrix.zeros(1, this.numFilters);
    const dInput = new Matrix(batchSize, this.inputSize);

    for (let b = 0; b < batchSize; b++) {
      // Reshape dz for this sample: [outputH*outputW, numFilters]
      const dzSample = new Matrix(this.outputH * this.outputW, this.numFilters);
      for (let f = 0; f < this.numFilters; f++) {
        for (let i = 0; i < this.outputH * this.outputW; i++) {
          dzSample.set(i, f, dz.get(b, f * this.outputH * this.outputW + i));
        }
      }

      // dFilters += dzSample^T · cols  (each filter grad is sum over spatial positions)
      const cols = this.colsCache[b];
      const dF = dzSample.T().dot(cols);
      this.dFilters = this.dFilters.add(dF);

      // dBiases += sum over spatial positions
      for (let f = 0; f < this.numFilters; f++) {
        let sum = 0;
        for (let i = 0; i < dzSample.rows; i++) sum += dzSample.get(i, f);
        this.dBiases.set(0, f, this.dBiases.get(0, f) + sum);
      }

      // dCols = dzSample · filters, then col2im to get dInput
      const dCols = dzSample.dot(this.filters);
      this._col2im(dCols, b, dInput);
    }

    // Average over batch
    this.dFilters = this.dFilters.mul(1 / batchSize);
    this.dBiases = this.dBiases.mul(1 / batchSize);

    return dInput;
  }

  update(learningRate, momentum = 0, optimizer = 'sgd') {
    // backward() already averages gradients over batch, so don't divide again
    this.filters = this.filters.sub(this.dFilters.mul(learningRate));
    this.biases = this.biases.sub(this.dBiases.mul(learningRate));
  }

  paramCount() {
    return this.numFilters * this.filterSize * this.filterSize * this.inputC + this.numFilters;
  }
}

/**
 * MaxPool2D — downsamples by taking max of each pool window
 */
export class MaxPool2D {
  constructor(inputH, inputW, inputC, poolSize = 2) {
    this.inputH = inputH;
    this.inputW = inputW;
    this.inputC = inputC;
    this.poolSize = poolSize;

    this.outputH = Math.floor(inputH / poolSize);
    this.outputW = Math.floor(inputW / poolSize);
    this.inputSize = inputH * inputW * inputC;
    this.outputSize = this.outputH * this.outputW * inputC;

    this.input = null;
    this.maxIndices = null;
    this.training = true;
  }

  forward(input) {
    this.input = input;
    const batchSize = input.rows;
    const output = new Matrix(batchSize, this.outputSize);
    this.maxIndices = new Array(batchSize);

    for (let b = 0; b < batchSize; b++) {
      this.maxIndices[b] = new Int32Array(this.outputSize);
      for (let c = 0; c < this.inputC; c++) {
        for (let oh = 0; oh < this.outputH; oh++) {
          for (let ow = 0; ow < this.outputW; ow++) {
            let maxVal = -Infinity;
            let maxIdx = 0;
            for (let ph = 0; ph < this.poolSize; ph++) {
              for (let pw = 0; pw < this.poolSize; pw++) {
                const ih = oh * this.poolSize + ph;
                const iw = ow * this.poolSize + pw;
                const idx = (c * this.inputH + ih) * this.inputW + iw;
                const val = input.get(b, idx);
                if (val > maxVal) { maxVal = val; maxIdx = idx; }
              }
            }
            const outIdx = (c * this.outputH + oh) * this.outputW + ow;
            output.set(b, outIdx, maxVal);
            this.maxIndices[b][outIdx] = maxIdx;
          }
        }
      }
    }
    return output;
  }

  backward(dOutput) {
    const dInput = new Matrix(dOutput.rows, this.inputSize);
    for (let b = 0; b < dOutput.rows; b++) {
      for (let i = 0; i < this.outputSize; i++) {
        dInput.set(b, this.maxIndices[b][i], dOutput.get(b, i));
      }
    }
    return dInput;
  }

  update() {} // No learnable parameters
  paramCount() { return 0; }
}

// Flatten layer — reshapes for transition from conv to dense
export class Flatten {
  constructor() {
    this.inputShape = null;
    this.inputSize = 0;
    this.outputSize = 0;
    this.training = true;
  }

  forward(input) {
    this.inputSize = input.cols;
    this.outputSize = input.cols;
    return input; // Already flat in our representation
  }

  backward(dOutput) { return dOutput; }
  update() {}
  paramCount() { return 0; }
}
