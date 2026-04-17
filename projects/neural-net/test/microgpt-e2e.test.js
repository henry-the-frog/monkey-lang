import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MicroGPT, Matrix } from '../src/index.js';

describe('MicroGPT end-to-end learning', () => {
  it('learns to predict next token in a repeating sequence', () => {
    const gpt = new MicroGPT({
      vocabSize: 5,
      dModel: 16,
      numHeads: 2,
      numLayers: 1,
      maxSeqLen: 6,
    });
    
    // Pattern: 1, 2, 3, 1, 2, 3, ...
    // Train sequences: [1,2,3,1,2], [2,3,1,2,3], [3,1,2,3,1]
    const sequences = [];
    for (let start = 1; start <= 3; start++) {
      for (let rep = 0; rep < 20; rep++) {
        const seq = [];
        for (let i = 0; i < 5; i++) {
          seq.push(((start - 1 + i) % 3) + 1);
        }
        sequences.push(seq);
      }
    }
    
    const history = gpt.train(sequences, { epochs: 100, learningRate: 0.01 });
    
    // Loss should decrease significantly
    assert.ok(history[history.length - 1] < history[0] * 0.5,
      `Loss should decrease: ${history[0]} → ${history[history.length - 1]}`);
    
    // Test prediction: given [1, 2, 3], predict next = 1
    const input1 = Matrix.fromArray([[1, 2, 3]]);
    gpt.allLayers.forEach(l => l.training = false);
    const pred1 = gpt.forward(input1);
    console.log('After [1,2,3], raw output:', 
      Array.from(pred1.data).slice(0, 5).map((v,i) => `${i}:${v.toFixed(3)}`).join(' '));
    
    // The highest logit should be for token 1
    let maxIdx = 0;
    for (let i = 1; i < pred1.cols; i++) {
      if (pred1.get(0, i) > pred1.get(0, maxIdx)) maxIdx = i;
    }
    assert.equal(maxIdx, 1, `After [1,2,3], should predict 1, got ${maxIdx}`);
    
    // Test: given [2, 3, 1], predict next = 2
    const input2 = Matrix.fromArray([[2, 3, 1]]);
    const pred2 = gpt.forward(input2);
    let maxIdx2 = 0;
    for (let i = 1; i < pred2.cols; i++) {
      if (pred2.get(0, i) > pred2.get(0, maxIdx2)) maxIdx2 = i;
    }
    console.log('After [2,3,1], raw output:', 
      Array.from(pred2.data).slice(0, 5).map((v,i) => `${i}:${v.toFixed(3)}`).join(' '));
    assert.equal(maxIdx2, 2, `After [2,3,1], should predict 2, got ${maxIdx2}`);
  });

  it('generates text that follows learned pattern', () => {
    const gpt = new MicroGPT({
      vocabSize: 4,
      dModel: 16,
      numHeads: 2,
      numLayers: 1,
      maxSeqLen: 6,
    });
    
    // Pattern: always 1, 2, 3, 1, 2, 3, ...
    const sequences = [];
    for (let i = 0; i < 100; i++) {
      sequences.push([1, 2, 3, 1, 2, 3]);
    }
    
    gpt.train(sequences, { epochs: 200, learningRate: 0.01 });
    
    // Generate: start with [1, 2], generate 4 more tokens
    const generated = gpt.generate([1, 2], 4);
    console.log('Generated sequence:', generated);
    
    // Should be close to [1, 2, 3, 1, 2, 3]
    // At minimum, the pattern should be recognizable
    assert.ok(generated.length === 6, `Should generate 6 tokens total, got ${generated.length}`);
    
    // Count how many match the pattern
    const expected = [1, 2, 3, 1, 2, 3];
    let matches = 0;
    for (let i = 0; i < 6; i++) {
      if (generated[i] === expected[i]) matches++;
    }
    console.log(`Pattern match: ${matches}/6 (${generated} vs ${expected})`);
    // First 2 are given, so at least 4/6 should match
    assert.ok(matches >= 4, `At least 4/6 should match pattern, got ${matches}`);
  });

  it('loss converges to near-zero on deterministic pattern', () => {
    const gpt = new MicroGPT({
      vocabSize: 3,
      dModel: 8,
      numHeads: 2,
      numLayers: 1,
      maxSeqLen: 4,
    });
    
    // Trivially simple: always [1, 2, 1, 2]
    const sequences = [];
    for (let i = 0; i < 50; i++) sequences.push([1, 2, 1, 2]);
    
    const history = gpt.train(sequences, { epochs: 200, learningRate: 0.01 });
    
    const finalLoss = history[history.length - 1];
    console.log(`Final loss: ${finalLoss} (started at ${history[0]})`);
    
    // Loss should be low (cross-entropy near 0 when confident)
    assert.ok(finalLoss < 0.5, `Loss should converge below 0.5, got ${finalLoss}`);
  });
});
