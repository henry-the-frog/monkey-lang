// microgpt.js — Tiny character-level language model using transformer blocks
// Demonstrates: Embedding → PositionalEncoding → TransformerEncoder → Dense → Softmax

import { Matrix } from './matrix.js';
import { Dense } from './layer.js';
import { clipByGlobalNorm } from './gradient-clip.js';
import { Embedding } from './embedding.js';
import { PositionalEncoding, LayerNorm, TransformerEncoderBlock } from './transformer.js';
import { getLoss } from './loss.js';

/**
 * MicroGPT — character-level language model
 * Architecture: Embedding → PE → N × TransformerEncoder → Dense → Softmax
 */
export class MicroGPT {
  /**
   * Create a MicroGPT model.
   * 
   * Pre-built configs available via MicroGPT.fromConfig():
   * - 'tiny':  vocabSize=128, dModel=32, numHeads=2, numLayers=2   (for testing)
   * - 'small': vocabSize=256, dModel=64, numHeads=4, numLayers=4   (toy tasks)
   * - 'medium': vocabSize=512, dModel=128, numHeads=8, numLayers=6  (small-scale learning)
   */
  constructor({
    vocabSize = 128,
    dModel = 32,
    numHeads = 2,
    numLayers = 1,
    maxSeqLen = 32,
    dFF = null,
  }) {
    this.vocabSize = vocabSize;
    this.dModel = dModel;
    this.maxSeqLen = maxSeqLen;
    
    // Build model
    this.embedding = new Embedding(vocabSize, dModel);
    this.pe = new PositionalEncoding(dModel, maxSeqLen);
    
    this.transformerBlocks = [];
    for (let i = 0; i < numLayers; i++) {
      this.transformerBlocks.push(new TransformerEncoderBlock(dModel, numHeads, dFF || dModel * 2, { causal: true }));
    }
    
    this.outputNorm = new LayerNorm(dModel);
    // Output projection: takes last position's embedding → vocab logits
    this.outputProj = new Dense(dModel, vocabSize, 'softmax');
    
    this.loss = getLoss('crossEntropy');
    
    this.allLayers = [this.embedding, this.pe, ...this.transformerBlocks, this.outputNorm, this.outputProj];
  }
  
  /**
   * Forward pass
   * input: [batch, seqLen] — token IDs
   * returns: [batch, vocabSize] — next token probabilities
   */
  forward(input) {
    const seqLen = input.cols;
    this._lastSeqLen = seqLen;
    this._lastBatchSize = input.rows;
    this._lastNormOutCols = seqLen * this.dModel;
    
    // Embedding + positional encoding
    let x = this.embedding.forward(input);
    x = this.pe.forward(x);
    
    // Transformer blocks
    for (const block of this.transformerBlocks) {
      x = block.forward(x);
    }
    
    // Layer norm
    x = this.outputNorm.forward(x);
    
    // Take last position's output: [batch, dModel]
    const lastPos = new Matrix(input.rows, this.dModel);
    for (let b = 0; b < input.rows; b++) {
      const offset = (seqLen - 1) * this.dModel;
      for (let d = 0; d < this.dModel; d++) {
        lastPos.set(b, d, x.get(b, offset + d));
      }
    }
    
    // Project to vocab
    return this.outputProj.forward(lastPos);
  }
  
  /**
   * Full backward pass through entire model
   * dOutput: gradient from loss [batch, vocabSize]
   * Returns gradient w.r.t. input (usually not needed)
   */
  backward(dOutput) {
    const seqLen = this._lastSeqLen;
    const batchSize = this._lastBatchSize;
    
    // Backward through output projection: [batch, vocabSize] → [batch, dModel]
    let grad = this.outputProj.backward(dOutput);
    
    // Scatter gradient back to last position: [batch, dModel] → [batch, seqLen * dModel]
    const dNormOut = Matrix.zeros(batchSize, this._lastNormOutCols);
    for (let b = 0; b < batchSize; b++) {
      const offset = (seqLen - 1) * this.dModel;
      for (let d = 0; d < this.dModel; d++) {
        dNormOut.set(b, offset + d, grad.get(b, d));
      }
    }
    
    // Backward through layer norm
    grad = this.outputNorm.backward(dNormOut);
    
    // Backward through transformer blocks (reverse order)
    for (let i = this.transformerBlocks.length - 1; i >= 0; i--) {
      grad = this.transformerBlocks[i].backward(grad);
    }
    
    // Backward through PE (gradient passes through — PE is additive constant)
    grad = this.pe.backward(grad);
    
    // Backward through embedding
    this.embedding.backward(grad);
    
    return grad;
  }
  
  /**
   * Train on sequence data
   * sequences: array of token ID arrays (each is a training sequence)
   */
  train(sequences, { epochs = 10, learningRate = 0.001, verbose = false, warmupSteps = 0, minLR = 0, maxGradNorm = 0 } = {}) {
    const history = [];
    let globalStep = 0;
    const totalSteps = epochs * sequences.length;
    
    for (const l of this.allLayers) l.training = true;
    
    for (let epoch = 0; epoch < epochs; epoch++) {
      let epochLoss = 0;
      let batches = 0;
      
      // Shuffle sequences
      const shuffled = [...sequences];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      
      for (const seq of shuffled) {
        if (seq.length < 2) continue;
        
        // Learning rate schedule: warmup then cosine decay
        let lr = learningRate;
        if (warmupSteps > 0 && globalStep < warmupSteps) {
          // Linear warmup
          lr = learningRate * (globalStep + 1) / warmupSteps;
        } else if (warmupSteps > 0) {
          // Cosine decay after warmup
          const decaySteps = totalSteps - warmupSteps;
          const progress = Math.min(1, (globalStep - warmupSteps) / decaySteps);
          lr = minLR + (learningRate - minLR) * 0.5 * (1 + Math.cos(Math.PI * progress));
        }
        globalStep++;
        
        // Create input-target pairs: predict next token
        const seqLen = Math.min(seq.length - 1, this.maxSeqLen);
        const input = new Matrix(1, seqLen);
        for (let t = 0; t < seqLen; t++) input.set(0, t, seq[t]);
        
        // Target: one-hot of next token
        const targetToken = seq[seqLen];
        const target = Matrix.zeros(1, this.vocabSize);
        target.set(0, targetToken, 1);
        
        // Forward
        const output = this.forward(input);
        const loss = this.loss.compute(output, target);
        epochLoss += loss;
        
        // Backward through entire model (not just output projection)
        let grad = this.loss.gradient(output, target);
        this.backward(grad);
        
        // Gradient clipping (prevents exploding gradients in transformers)
        if (maxGradNorm > 0) {
          const allGrads = [];
          for (const block of this.transformerBlocks) {
            if (block.ff1.dWeights) allGrads.push(block.ff1.dWeights);
            if (block.ff2.dWeights) allGrads.push(block.ff2.dWeights);
          }
          if (this.outputProj.dWeights) allGrads.push(this.outputProj.dWeights);
          if (allGrads.length > 0) {
            const { grads: clipped } = clipByGlobalNorm(allGrads, maxGradNorm);
            let gi = 0;
            for (const block of this.transformerBlocks) {
              if (block.ff1.dWeights) block.ff1.dWeights = clipped[gi++];
              if (block.ff2.dWeights) block.ff2.dWeights = clipped[gi++];
            }
            if (this.outputProj.dWeights) this.outputProj.dWeights = clipped[gi++];
          }
        }
        
        // Update all layers
        for (const block of this.transformerBlocks) {
          block.update(lr);
        }
        this.outputNorm.update(lr);
        this.outputProj.update(lr, 0, 'sgd');
        if (this.embedding.dWeights) this.embedding.update(lr);
        
        batches++;
      }
      
      const avgLoss = epochLoss / Math.max(batches, 1);
      history.push(avgLoss);
      
      if (verbose && epoch % Math.max(1, Math.floor(epochs / 10)) === 0) {
        console.log(`Epoch ${epoch + 1}/${epochs} — Loss: ${avgLoss.toFixed(4)}`);
      }
    }
    
    for (const l of this.allLayers) l.training = false;
    return history;
  }
  
  /**
   * Generate text character by character
   */
  generate(prompt, length = 50, temperature = 1.0) {
    const tokens = [...prompt];
    
    for (let i = 0; i < length; i++) {
      const contextLen = Math.min(tokens.length, this.maxSeqLen);
      const context = tokens.slice(-contextLen);
      
      const input = new Matrix(1, context.length);
      for (let t = 0; t < context.length; t++) {
        input.set(0, t, context[t]);
      }
      
      const probs = this.forward(input);
      
      // Temperature sampling
      const logits = [];
      for (let v = 0; v < this.vocabSize; v++) {
        logits.push(Math.log(Math.max(probs.get(0, v), 1e-10)) / temperature);
      }
      
      // Softmax
      const maxLogit = Math.max(...logits);
      const exps = logits.map(l => Math.exp(l - maxLogit));
      const sum = exps.reduce((a, b) => a + b);
      const dist = exps.map(e => e / sum);
      
      // Sample
      let r = Math.random(), cumulative = 0;
      let nextToken = 0;
      for (let v = 0; v < this.vocabSize; v++) {
        cumulative += dist[v];
        if (r < cumulative) { nextToken = v; break; }
      }
      
      tokens.push(nextToken);
    }
    
    return tokens;
  }
  
  paramCount() {
    return this.allLayers.reduce((s, l) => s + (l.paramCount ? l.paramCount() : 0), 0);
  }
}

/**
 * Helper: encode string to token IDs (character-level)
 */
export function encodeText(text) {
  return [...text].map(c => c.charCodeAt(0));
}

/**
 * Helper: decode token IDs to string
 */
export function decodeTokens(tokens) {
  return tokens.map(t => String.fromCharCode(Math.max(0, Math.min(127, t)))).join('');
}

/**
 * Helper: create training sequences from text
 */
export function createSequences(text, seqLen = 16) {
  const tokens = encodeText(text);
  const sequences = [];
  for (let i = 0; i <= tokens.length - seqLen - 1; i++) {
    sequences.push(tokens.slice(i, i + seqLen + 1));
  }
  return sequences;
}

/**
 * Factory for common MicroGPT configurations
 */
MicroGPT.fromConfig = function(name, overrides = {}) {
  const configs = {
    tiny: { vocabSize: 128, dModel: 32, numHeads: 2, numLayers: 2, maxSeqLen: 32 },
    small: { vocabSize: 256, dModel: 64, numHeads: 4, numLayers: 4, maxSeqLen: 64 },
    medium: { vocabSize: 512, dModel: 128, numHeads: 8, numLayers: 6, maxSeqLen: 128 },
  };
  
  if (!configs[name]) throw new Error(`Unknown config: ${name}. Available: ${Object.keys(configs).join(', ')}`);
  return new MicroGPT({ ...configs[name], ...overrides });
};
