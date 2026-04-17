// attention.js — Self-Attention and Multi-Head Attention

import { Matrix } from './matrix.js';

/**
 * Scaled Dot-Product Attention
 * Attention(Q, K, V) = softmax(QK^T / sqrt(d_k)) V
 * 
 * Input: queries [batch, seq_len, d_model] (flattened as [batch, seq_len * d_model])
 * This implements single-head attention from "Attention Is All You Need" (Vaswani et al. 2017)
 */
export class SelfAttention {
  constructor(dModel, { dropout = 0, causal = false } = {}) {
    this.dModel = dModel;
    this.scale = 1 / Math.sqrt(dModel);
    this.dropoutRate = dropout;
    this.causal = causal;
    
    // Weight matrices for Q, K, V projections
    const scale = Math.sqrt(2 / (dModel + dModel));
    this.Wq = Matrix.random(dModel, dModel).mul(scale);
    this.Wk = Matrix.random(dModel, dModel).mul(scale);
    this.Wv = Matrix.random(dModel, dModel).mul(scale);
    this.Wo = Matrix.random(dModel, dModel).mul(scale); // Output projection
    
    // Biases
    this.bq = Matrix.zeros(1, dModel);
    this.bk = Matrix.zeros(1, dModel);
    this.bv = Matrix.zeros(1, dModel);
    this.bo = Matrix.zeros(1, dModel);
    
    this.outputSize = dModel;
    this.training = true;
    
    // Cache for backward
    this._cache = null;
    this.dWeights = null;
    this.dBiases = null;
  }
  
  /**
   * Forward pass
   * input: [batch, seqLen * dModel]
   * returns: [batch, seqLen * dModel]
   */
  forward(input) {
    const batchSize = input.rows;
    const seqLen = Math.floor(input.cols / this.dModel);
    
    // Reshape to process each position: extract per-position vectors
    // Q = input · Wq + bq, K = input · Wk + bk, V = input · Wv + bv
    // Process all positions at once per sample
    
    const allQ = [], allK = [], allV = [], allAttn = [], allCtx = [];
    
    // Save a copy of input for backward (don't store reference that could be mutated)
    const savedInput = new Matrix(batchSize, input.cols);
    for (let i = 0; i < batchSize; i++)
      for (let j = 0; j < input.cols; j++)
        savedInput.set(i, j, input.get(i, j));
    
    for (let b = 0; b < batchSize; b++) {
      // Extract sequence for this batch item: [seqLen, dModel]
      const seq = new Matrix(seqLen, this.dModel);
      for (let t = 0; t < seqLen; t++) {
        for (let d = 0; d < this.dModel; d++) {
          seq.set(t, d, input.get(b, t * this.dModel + d));
        }
      }
      
      // Linear projections: Q, K, V each [seqLen, dModel]
      const Q = seq.dot(this.Wq).add(this.bq);
      const K = seq.dot(this.Wk).add(this.bk);
      const V = seq.dot(this.Wv).add(this.bv);
      
      // Attention scores: QK^T / sqrt(d_k) → [seqLen, seqLen]
      const scores = Q.dot(K.T()).mul(this.scale);
      
      // Apply causal mask: positions can only attend to previous positions
      if (this.causal) {
        for (let i = 0; i < seqLen; i++) {
          for (let j = i + 1; j < seqLen; j++) {
            scores.set(i, j, -1e9); // -inf before softmax → 0 attention
          }
        }
      }
      
      // Softmax over last dimension (each row)
      const attnWeights = softmaxRows(scores);
      
      // Context: attn · V → [seqLen, dModel]
      const context = attnWeights.dot(V);
      
      allQ.push(Q); allK.push(K); allV.push(V);
      allAttn.push(attnWeights); allCtx.push(context);
    }
    
    this._cache = { input: savedInput, batchSize, seqLen, allQ, allK, allV, allAttn, allCtx };
    
    // Build output matrix with output projection
    const result = new Matrix(batchSize, seqLen * this.dModel);
    for (let b = 0; b < batchSize; b++) {
      const ctx = allCtx[b].dot(this.Wo).add(this.bo);
      for (let t = 0; t < seqLen; t++) {
        for (let d = 0; d < this.dModel; d++) {
          result.set(b, t * this.dModel + d, ctx.get(t, d));
        }
      }
    }
    
    return result;
  }
  
  backward(dOutput) {
    const { batchSize, seqLen, allQ, allK, allV, allAttn, allCtx } = this._cache;
    
    // Initialize gradient accumulators
    let dWq = Matrix.zeros(this.dModel, this.dModel);
    let dWk = Matrix.zeros(this.dModel, this.dModel);
    let dWv = Matrix.zeros(this.dModel, this.dModel);
    let dWo = Matrix.zeros(this.dModel, this.dModel);
    let dbq = Matrix.zeros(1, this.dModel);
    let dbk = Matrix.zeros(1, this.dModel);
    let dbv = Matrix.zeros(1, this.dModel);
    let dbo = Matrix.zeros(1, this.dModel);
    
    const dInput = new Matrix(batchSize, seqLen * this.dModel);
    
    for (let b = 0; b < batchSize; b++) {
      // Extract dOutput for this batch: [seqLen, dModel]
      const dOut = new Matrix(seqLen, this.dModel);
      for (let t = 0; t < seqLen; t++) {
        for (let d = 0; d < this.dModel; d++) {
          dOut.set(t, d, dOutput.get(b, t * this.dModel + d));
        }
      }
      
      // Backward through output projection
      dWo = dWo.add(allCtx[b].T().dot(dOut));
      dbo = dbo.add(dOut.sumAxis(0));
      const dContext = dOut.dot(this.Wo.T()); // [seqLen, dModel]
      
      // Backward through attention: context = attn · V
      const dAttn = dContext.dot(allV[b].T()); // [seqLen, seqLen]
      const dV = allAttn[b].T().dot(dContext);   // [seqLen, dModel]
      
      // Backward through softmax
      const dScores = softmaxBackward(allAttn[b], dAttn).mul(this.scale);
      
      // Backward through QK^T
      const dQ = dScores.dot(allK[b]);          // [seqLen, dModel]
      const dK = dScores.T().dot(allQ[b]);      // [seqLen, dModel]
      
      // Extract sequence for this batch
      const seq = new Matrix(seqLen, this.dModel);
      for (let t = 0; t < seqLen; t++) {
        for (let d = 0; d < this.dModel; d++) {
          seq.set(t, d, this._cache.input.get(b, t * this.dModel + d));
        }
      }
      
      // Accumulate weight gradients
      dWq = dWq.add(seq.T().dot(dQ));
      dWk = dWk.add(seq.T().dot(dK));
      dWv = dWv.add(seq.T().dot(dV));
      dbq = dbq.add(dQ.sumAxis(0));
      dbk = dbk.add(dK.sumAxis(0));
      dbv = dbv.add(dV.sumAxis(0));
      
      // Input gradient
      const dSeq = dQ.dot(this.Wq.T()).add(dK.dot(this.Wk.T())).add(dV.dot(this.Wv.T()));
      for (let t = 0; t < seqLen; t++) {
        for (let d = 0; d < this.dModel; d++) {
          dInput.set(b, t * this.dModel + d, dSeq.get(t, d));
        }
      }
    }
    
    // Average gradients
    const invB = 1 / batchSize;
    this._dWq = dWq.mul(invB); this._dWk = dWk.mul(invB);
    this._dWv = dWv.mul(invB); this._dWo = dWo.mul(invB);
    this._dbq = dbq.mul(invB); this._dbk = dbk.mul(invB);
    this._dbv = dbv.mul(invB); this._dbo = dbo.mul(invB);
    
    this.dWeights = this._dWq; // Primary alias for optimizer
    this.dBiases = this._dbq;
    
    return dInput;
  }
  
  update(learningRate) {
    this.Wq = this.Wq.sub(this._dWq.mul(learningRate));
    this.Wk = this.Wk.sub(this._dWk.mul(learningRate));
    this.Wv = this.Wv.sub(this._dWv.mul(learningRate));
    this.Wo = this.Wo.sub(this._dWo.mul(learningRate));
    this.bq = this.bq.sub(this._dbq.mul(learningRate));
    this.bk = this.bk.sub(this._dbk.mul(learningRate));
    this.bv = this.bv.sub(this._dbv.mul(learningRate));
    this.bo = this.bo.sub(this._dbo.mul(learningRate));
  }
  
  paramCount() {
    return 4 * (this.dModel * this.dModel + this.dModel); // Q, K, V, O weights + biases
  }
}

/**
 * Multi-Head Attention
 * Splits input into multiple heads, applies attention to each, concatenates
 */
export class MultiHeadAttention {
  constructor(dModel, numHeads, { dropout = 0 } = {}) {
    if (dModel % numHeads !== 0) throw new Error(`dModel (${dModel}) must be divisible by numHeads (${numHeads})`);
    this.dModel = dModel;
    this.numHeads = numHeads;
    this.headDim = dModel / numHeads;
    
    // One set of weights for all heads (more efficient)
    const scale = Math.sqrt(2 / (dModel + dModel));
    this.Wq = Matrix.random(dModel, dModel).mul(scale);
    this.Wk = Matrix.random(dModel, dModel).mul(scale);
    this.Wv = Matrix.random(dModel, dModel).mul(scale);
    this.Wo = Matrix.random(dModel, dModel).mul(scale);
    
    this.bq = Matrix.zeros(1, dModel);
    this.bk = Matrix.zeros(1, dModel);
    this.bv = Matrix.zeros(1, dModel);
    this.bo = Matrix.zeros(1, dModel);
    
    this.outputSize = dModel;
    this.training = true;
    this._cache = null;
    this.dWeights = null;
    this.dBiases = null;
  }
  
  forward(input) {
    const batchSize = input.rows;
    const seqLen = Math.floor(input.cols / this.dModel);
    const result = new Matrix(batchSize, seqLen * this.dModel);
    
    this._seqs = [];
    this._allHeadQ = [];
    this._allHeadK = [];
    this._allHeadV = [];
    this._allHeadAttn = [];
    this._batchSize = batchSize;
    this._seqLen = seqLen;
    
    for (let b = 0; b < batchSize; b++) {
      const seq = new Matrix(seqLen, this.dModel);
      for (let t = 0; t < seqLen; t++)
        for (let d = 0; d < this.dModel; d++)
          seq.set(t, d, input.get(b, t * this.dModel + d));
      
      this._seqs.push(seq);
      
      // Project Q, K, V: [seqLen, dModel]
      const Q = seq.dot(this.Wq).add(this.bq);
      const K = seq.dot(this.Wk).add(this.bk);
      const V = seq.dot(this.Wv).add(this.bv);
      
      // Split into heads and compute attention per head
      const headOutputs = [];
      const headQ = [], headK = [], headV = [], headAttn = [];
      
      for (let h = 0; h < this.numHeads; h++) {
        const offset = h * this.headDim;
        // Extract head slice: [seqLen, headDim]
        const Qh = extractCols(Q, offset, this.headDim);
        const Kh = extractCols(K, offset, this.headDim);
        const Vh = extractCols(V, offset, this.headDim);
        
        // Scaled dot-product attention
        const scores = Qh.dot(Kh.T()).mul(1 / Math.sqrt(this.headDim));
        const attn = softmaxRows(scores);
        const context = attn.dot(Vh);
        
        headQ.push(Qh); headK.push(Kh); headV.push(Vh); headAttn.push(attn);
        headOutputs.push(context);
      }
      
      this._allHeadQ.push(headQ);
      this._allHeadK.push(headK);
      this._allHeadV.push(headV);
      this._allHeadAttn.push(headAttn);
      
      // Concatenate heads: [seqLen, dModel]
      const concat = new Matrix(seqLen, this.dModel);
      for (let h = 0; h < this.numHeads; h++) {
        const offset = h * this.headDim;
        for (let t = 0; t < seqLen; t++)
          for (let d = 0; d < this.headDim; d++)
            concat.set(t, offset + d, headOutputs[h].get(t, d));
      }
      
      // Output projection
      const output = concat.dot(this.Wo).add(this.bo);
      
      for (let t = 0; t < seqLen; t++)
        for (let d = 0; d < this.dModel; d++)
          result.set(b, t * this.dModel + d, output.get(t, d));
    }
    
    return result;
  }
  
  backward(dOutput) {
    // Simplified backward — compute weight gradients
    const dInput = new Matrix(this._batchSize, this._seqLen * this.dModel);
    
    let dWq = Matrix.zeros(this.dModel, this.dModel);
    let dWk = Matrix.zeros(this.dModel, this.dModel);
    let dWv = Matrix.zeros(this.dModel, this.dModel);
    let dWo = Matrix.zeros(this.dModel, this.dModel);
    
    for (let b = 0; b < this._batchSize; b++) {
      const seq = this._seqs[b];
      const dOut = new Matrix(this._seqLen, this.dModel);
      for (let t = 0; t < this._seqLen; t++)
        for (let d = 0; d < this.dModel; d++)
          dOut.set(t, d, dOutput.get(b, t * this.dModel + d));
      
      // Through output projection
      const concat = new Matrix(this._seqLen, this.dModel);
      for (let h = 0; h < this.numHeads; h++) {
        const ctx = this._allHeadAttn[b][h].dot(this._allHeadV[b][h]);
        for (let t = 0; t < this._seqLen; t++)
          for (let d = 0; d < this.headDim; d++)
            concat.set(t, h * this.headDim + d, ctx.get(t, d));
      }
      
      dWo = dWo.add(concat.T().dot(dOut));
      const dConcat = dOut.dot(this.Wo.T());
      
      // Split gradient back to heads
      let dSeq = Matrix.zeros(this._seqLen, this.dModel);
      for (let h = 0; h < this.numHeads; h++) {
        const dCtx = extractCols(dConcat, h * this.headDim, this.headDim);
        const dAttn = dCtx.dot(this._allHeadV[b][h].T());
        const dV = this._allHeadAttn[b][h].T().dot(dCtx);
        
        const dScores = softmaxBackward(this._allHeadAttn[b][h], dAttn).mul(1/Math.sqrt(this.headDim));
        const dQ = dScores.dot(this._allHeadK[b][h]);
        const dK = dScores.T().dot(this._allHeadQ[b][h]);
        
        // Combine head gradients back into full gradient
        const dQfull = Matrix.zeros(this._seqLen, this.dModel);
        const dKfull = Matrix.zeros(this._seqLen, this.dModel);
        const dVfull = Matrix.zeros(this._seqLen, this.dModel);
        for (let t = 0; t < this._seqLen; t++) {
          for (let d = 0; d < this.headDim; d++) {
            dQfull.set(t, h*this.headDim+d, dQ.get(t, d));
            dKfull.set(t, h*this.headDim+d, dK.get(t, d));
            dVfull.set(t, h*this.headDim+d, dV.get(t, d));
          }
        }
        
        dSeq = dSeq.add(dQfull.dot(this.Wq.T()).add(dKfull.dot(this.Wk.T())).add(dVfull.dot(this.Wv.T())));
        dWq = dWq.add(seq.T().dot(dQfull));
        dWk = dWk.add(seq.T().dot(dKfull));
        dWv = dWv.add(seq.T().dot(dVfull));
      }
      
      for (let t = 0; t < this._seqLen; t++)
        for (let d = 0; d < this.dModel; d++)
          dInput.set(b, t * this.dModel + d, dSeq.get(t, d));
    }
    
    const invB = 1 / this._batchSize;
    this._dWq = dWq.mul(invB); this._dWk = dWk.mul(invB);
    this._dWv = dWv.mul(invB); this._dWo = dWo.mul(invB);
    this.dWeights = this._dWq;
    this.dBiases = Matrix.zeros(1, this.dModel);
    
    return dInput;
  }
  
  update(learningRate) {
    this.Wq = this.Wq.sub(this._dWq.mul(learningRate));
    this.Wk = this.Wk.sub(this._dWk.mul(learningRate));
    this.Wv = this.Wv.sub(this._dWv.mul(learningRate));
    this.Wo = this.Wo.sub(this._dWo.mul(learningRate));
  }
  
  paramCount() {
    return 4 * (this.dModel * this.dModel + this.dModel);
  }
}

// ==================== Helper Functions ====================

function softmaxRows(m) {
  const result = new Matrix(m.rows, m.cols);
  for (let i = 0; i < m.rows; i++) {
    let max = -Infinity;
    for (let j = 0; j < m.cols; j++) max = Math.max(max, m.get(i, j));
    let sum = 0;
    for (let j = 0; j < m.cols; j++) {
      const v = Math.exp(m.get(i, j) - max);
      result.set(i, j, v);
      sum += v;
    }
    for (let j = 0; j < m.cols; j++) result.set(i, j, result.get(i, j) / sum);
  }
  return result;
}

function softmaxBackward(softmaxOutput, dOutput) {
  // For each row: dS = S ⊙ (dO - sum(dO ⊙ S))
  const result = new Matrix(dOutput.rows, dOutput.cols);
  for (let i = 0; i < dOutput.rows; i++) {
    let dot = 0;
    for (let j = 0; j < dOutput.cols; j++) dot += dOutput.get(i, j) * softmaxOutput.get(i, j);
    for (let j = 0; j < dOutput.cols; j++) {
      result.set(i, j, softmaxOutput.get(i, j) * (dOutput.get(i, j) - dot));
    }
  }
  return result;
}

function extractCols(m, offset, count) {
  const result = new Matrix(m.rows, count);
  for (let i = 0; i < m.rows; i++)
    for (let j = 0; j < count; j++)
      result.set(i, j, m.get(i, offset + j));
  return result;
}
