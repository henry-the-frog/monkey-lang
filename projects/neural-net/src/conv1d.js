// conv1d.js — 1D Convolutional layer for sequence processing

import { Matrix } from './matrix.js';
import { getActivation } from './activation.js';

/**
 * Conv1D layer — applies learned filters over 1D sequences
 * Input shape: [batch, sequenceLength * inputChannels] (flattened)
 * Stores sequence dimensions for proper convolution.
 * 
 * Use cases: time series, audio, text (with embeddings), sensor data
 */
export class Conv1D {
  constructor(seqLen, inputChannels, numFilters, kernelSize, activation = 'relu', { stride = 1, padding = 0 } = {}) {
    this.seqLen = seqLen;
    this.inputChannels = inputChannels;
    this.numFilters = numFilters;
    this.kernelSize = kernelSize;
    this.stride = stride;
    this.padding = padding;
    this.activation = getActivation(activation);

    // Output length
    this.outputLen = Math.floor((seqLen + 2 * padding - kernelSize) / stride) + 1;

    // Input/output sizes (flattened)
    this.inputSize = seqLen * inputChannels;
    this.outputSize = this.outputLen * numFilters;

    // Filters: [numFilters, kernelSize * inputChannels]
    const fanIn = kernelSize * inputChannels;
    const scale = Math.sqrt(2.0 / fanIn);
    this.filters = new Matrix(numFilters, fanIn).randomize(scale);
    this.biases = new Matrix(1, numFilters);

    // Cache
    this.input = null;
    this.colsCache = null;
    this.z = null;
    this.a = null;
    this.training = true;

    // Gradients
    this.dFilters = null;
    this.dBiases = null;
  }

  /**
   * im2col for 1D: extract patches as rows
   * Each row corresponds to one output position, containing the flattened filter window
   */
  _im2col(input, batchIdx) {
    const { seqLen: L, inputChannels: C, kernelSize: K, stride: S, padding: P, outputLen: OL } = this;
    const cols = new Matrix(OL, K * C);

    for (let o = 0; o < OL; o++) {
      let colIdx = 0;
      for (let c = 0; c < C; c++) {
        for (let k = 0; k < K; k++) {
          const pos = o * S - P + k;
          if (pos >= 0 && pos < L) {
            cols.set(o, colIdx, input.get(batchIdx, c * L + pos));
          }
          // else: padding (already 0)
          colIdx++;
        }
      }
    }
    return cols;
  }

  /**
   * col2im for 1D: scatter gradients back to input space
   */
  _col2im(dCols, batchIdx, dInput) {
    const { seqLen: L, inputChannels: C, kernelSize: K, stride: S, padding: P, outputLen: OL } = this;

    for (let o = 0; o < OL; o++) {
      let colIdx = 0;
      for (let c = 0; c < C; c++) {
        for (let k = 0; k < K; k++) {
          const pos = o * S - P + k;
          if (pos >= 0 && pos < L) {
            const inputIdx = c * L + pos;
            const prev = dInput.get(batchIdx, inputIdx);
            dInput.set(batchIdx, inputIdx, prev + dCols.get(o, colIdx));
          }
          colIdx++;
        }
      }
    }
  }

  forward(input) {
    this.input = input;
    const batchSize = input.rows;
    const output = new Matrix(batchSize, this.outputSize);
    this.colsCache = [];

    for (let b = 0; b < batchSize; b++) {
      const cols = this._im2col(input, b);
      this.colsCache.push(cols);

      // conv = cols · filters^T
      const conv = cols.dot(this.filters.T());

      // Add bias and write to output [numFilters interleaved with outputLen]
      for (let f = 0; f < this.numFilters; f++) {
        for (let i = 0; i < this.outputLen; i++) {
          const val = conv.get(i, f) + this.biases.get(0, f);
          output.set(b, f * this.outputLen + i, val);
        }
      }
    }

    this.z = output;
    this.a = this.activation.forward(output);
    return this.a;
  }

  backward(dOutput) {
    const activGrad = this.activation.backward(this.a);
    const dz = dOutput.mul(activGrad);
    const batchSize = this.input.rows;

    this.dFilters = Matrix.zeros(this.numFilters, this.kernelSize * this.inputChannels);
    this.dBiases = Matrix.zeros(1, this.numFilters);
    const dInput = new Matrix(batchSize, this.inputSize);

    for (let b = 0; b < batchSize; b++) {
      // Reshape dz: [outputLen, numFilters]
      const dzSample = new Matrix(this.outputLen, this.numFilters);
      for (let f = 0; f < this.numFilters; f++) {
        for (let i = 0; i < this.outputLen; i++) {
          dzSample.set(i, f, dz.get(b, f * this.outputLen + i));
        }
      }

      // dFilters += dzSample^T · cols
      const cols = this.colsCache[b];
      const dF = dzSample.T().dot(cols);
      this.dFilters = this.dFilters.add(dF);

      // dBiases += sum over sequence positions
      for (let f = 0; f < this.numFilters; f++) {
        let sum = 0;
        for (let i = 0; i < this.outputLen; i++) sum += dzSample.get(i, f);
        this.dBiases.set(0, f, this.dBiases.get(0, f) + sum);
      }

      // dCols = dzSample · filters → col2im
      const dCols = dzSample.dot(this.filters);
      this._col2im(dCols, b, dInput);
    }

    this.dFilters = this.dFilters.mul(1 / batchSize);
    this.dBiases = this.dBiases.mul(1 / batchSize);

    return dInput;
  }

  update(learningRate) {
    // backward() already averages gradients over batch, so don't divide again
    this.filters = this.filters.sub(this.dFilters.mul(learningRate));
    this.biases = this.biases.sub(this.dBiases.mul(learningRate));
  }

  paramCount() {
    return this.numFilters * this.kernelSize * this.inputChannels + this.numFilters;
  }
}

/**
 * GlobalAvgPool1D — average over the sequence dimension
 * Input: [batch, outputLen * numFilters], Output: [batch, numFilters]
 */
export class GlobalAvgPool1D {
  constructor(seqLen, numChannels) {
    this.seqLen = seqLen;
    this.numChannels = numChannels;
    this.inputSize = seqLen * numChannels;
    this.outputSize = numChannels;
    this.training = true;
  }

  forward(input) {
    this.input = input;
    const batch = input.rows;
    const output = new Matrix(batch, this.numChannels);

    for (let b = 0; b < batch; b++) {
      for (let c = 0; c < this.numChannels; c++) {
        let sum = 0;
        for (let i = 0; i < this.seqLen; i++) {
          sum += input.get(b, c * this.seqLen + i);
        }
        output.set(b, c, sum / this.seqLen);
      }
    }
    return output;
  }

  backward(dOutput) {
    const batch = dOutput.rows;
    const dInput = new Matrix(batch, this.inputSize);

    for (let b = 0; b < batch; b++) {
      for (let c = 0; c < this.numChannels; c++) {
        const grad = dOutput.get(b, c) / this.seqLen;
        for (let i = 0; i < this.seqLen; i++) {
          dInput.set(b, c * this.seqLen + i, grad);
        }
      }
    }
    return dInput;
  }

  update() {}
  paramCount() { return 0; }
}

/**
 * MaxPool1D — downsamples by taking max over pool windows
 */
export class MaxPool1D {
  constructor(seqLen, numChannels, poolSize = 2) {
    this.seqLen = seqLen;
    this.numChannels = numChannels;
    this.poolSize = poolSize;
    this.outputLen = Math.floor(seqLen / poolSize);
    this.inputSize = seqLen * numChannels;
    this.outputSize = this.outputLen * numChannels;
    this.maxIndices = null;
    this.training = true;
  }

  forward(input) {
    this.input = input;
    const batch = input.rows;
    const output = new Matrix(batch, this.outputSize);
    this.maxIndices = new Array(batch);

    for (let b = 0; b < batch; b++) {
      this.maxIndices[b] = new Int32Array(this.outputSize);
      for (let c = 0; c < this.numChannels; c++) {
        for (let o = 0; o < this.outputLen; o++) {
          let maxVal = -Infinity;
          let maxIdx = 0;
          for (let p = 0; p < this.poolSize; p++) {
            const pos = o * this.poolSize + p;
            const idx = c * this.seqLen + pos;
            const val = input.get(b, idx);
            if (val > maxVal) { maxVal = val; maxIdx = idx; }
          }
          const outIdx = c * this.outputLen + o;
          output.set(b, outIdx, maxVal);
          this.maxIndices[b][outIdx] = maxIdx;
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

  update() {}
  paramCount() { return 0; }
}
