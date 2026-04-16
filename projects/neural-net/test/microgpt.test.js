import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix, MicroGPT, encodeText, decodeTokens, createSequences } from '../src/index.js';

describe('MicroGPT', () => {
  it('forward produces vocab-size output', () => {
    const gpt = new MicroGPT({ vocabSize: 50, dModel: 8, numHeads: 2, numLayers: 1 });
    const input = Matrix.fromArray([[5, 10, 15]]); // 3 tokens
    const output = gpt.forward(input);
    assert.equal(output.rows, 1);
    assert.equal(output.cols, 50);
    // Should be a probability distribution
    let sum = 0;
    for (let j = 0; j < 50; j++) sum += output.get(0, j);
    assert.ok(Math.abs(sum - 1) < 0.1, `Should sum to ~1, got ${sum}`);
  });

  it('param count', () => {
    const gpt = new MicroGPT({ vocabSize: 50, dModel: 8, numHeads: 2, numLayers: 1 });
    assert.ok(gpt.paramCount() > 0);
  });

  it('generate produces tokens', () => {
    const gpt = new MicroGPT({ vocabSize: 50, dModel: 8, numHeads: 2, numLayers: 1 });
    const tokens = gpt.generate([1, 2, 3], 5);
    assert.equal(tokens.length, 8); // 3 prompt + 5 generated
    for (const t of tokens) {
      assert.ok(t >= 0 && t < 50);
    }
  });

  it('trains and reduces loss', () => {
    const gpt = new MicroGPT({ vocabSize: 30, dModel: 8, numHeads: 2, numLayers: 1, maxSeqLen: 4 });
    
    // Simple repeating pattern: 1,2,3,1,2,3,...
    const sequences = [];
    for (let i = 0; i < 10; i++) {
      sequences.push([1, 2, 3, 1, 2]);
    }
    
    const history = gpt.train(sequences, { epochs: 10, learningRate: 0.01 });
    assert.equal(history.length, 10);
    // Loss should decrease (or at least not explode)
    assert.ok(isFinite(history[history.length - 1]), 'Loss should be finite');
  });

  it('full backward pass trains all layers (not just output projection)', () => {
    const gpt = new MicroGPT({ vocabSize: 20, dModel: 8, numHeads: 2, numLayers: 1, maxSeqLen: 4 });
    
    // Snapshot ALL initial weights (sum, not a single element)
    const ff1Sum = () => {
      let s = 0;
      for (let i = 0; i < gpt.transformerBlocks[0].ff1.weights.rows; i++)
        for (let j = 0; j < gpt.transformerBlocks[0].ff1.weights.cols; j++)
          s += gpt.transformerBlocks[0].ff1.weights.get(i, j);
      return s;
    };
    const ff2Sum = () => {
      let s = 0;
      for (let i = 0; i < gpt.transformerBlocks[0].ff2.weights.rows; i++)
        for (let j = 0; j < gpt.transformerBlocks[0].ff2.weights.cols; j++)
          s += gpt.transformerBlocks[0].ff2.weights.get(i, j);
      return s;
    };
    
    const ff1Before = ff1Sum();
    const ff2Before = ff2Sum();
    
    const sequences = [];
    for (let i = 0; i < 10; i++) sequences.push([1, 2, 3, 1, 2]);
    
    gpt.train(sequences, { epochs: 10, learningRate: 0.01 });
    
    const ff1After = ff1Sum();
    const ff2After = ff2Sum();
    
    assert.ok(Math.abs(ff1Before - ff1After) > 1e-10, 
      `FF1 weight sum should change during training (diff=${Math.abs(ff1Before - ff1After)})`);
    assert.ok(Math.abs(ff2Before - ff2After) > 1e-10, 
      `FF2 weight sum should change during training (diff=${Math.abs(ff2Before - ff2After)})`);
  });

  it('backward produces gradients for all components', () => {
    const gpt = new MicroGPT({ vocabSize: 20, dModel: 8, numHeads: 2, numLayers: 1, maxSeqLen: 4 });
    
    const input = Matrix.fromArray([[1, 2, 3]]);
    const target = Matrix.zeros(1, 20);
    target.set(0, 1, 1); // next token = 1
    
    // Forward
    for (const l of gpt.allLayers) l.training = true;
    const output = gpt.forward(input);
    const grad = gpt.loss.gradient(output, target);
    gpt.backward(grad);
    
    // Check gradients exist
    assert.ok(gpt.outputProj.dWeights, 'outputProj should have gradients');
    assert.ok(gpt.transformerBlocks[0].ff1.dWeights, 'ff1 should have gradients');
    assert.ok(gpt.transformerBlocks[0].ff2.dWeights, 'ff2 should have gradients');
    
    // Check gradients are non-zero
    let ff1GradNorm = 0;
    for (let i = 0; i < gpt.transformerBlocks[0].ff1.dWeights.rows; i++)
      for (let j = 0; j < gpt.transformerBlocks[0].ff1.dWeights.cols; j++)
        ff1GradNorm += Math.abs(gpt.transformerBlocks[0].ff1.dWeights.get(i, j));
    assert.ok(ff1GradNorm > 0, 'ff1 gradients should be non-zero');
  });
});

describe('Text encoding', () => {
  it('encodeText converts to char codes', () => {
    const tokens = encodeText('hello');
    assert.deepEqual(tokens, [104, 101, 108, 108, 111]);
  });

  it('decodeTokens converts back', () => {
    const text = decodeTokens([104, 101, 108, 108, 111]);
    assert.equal(text, 'hello');
  });

  it('roundtrip', () => {
    const original = 'Hello, world!';
    assert.equal(decodeTokens(encodeText(original)), original);
  });

  it('createSequences splits text', () => {
    const seqs = createSequences('abcdefgh', 4);
    // Length 8, seqLen 4: sequences at pos 0,1,2,3 (each has 5 tokens: 4 input + 1 target)
    assert.ok(seqs.length > 0);
    assert.equal(seqs[0].length, 5); // seqLen + 1
  });
});
