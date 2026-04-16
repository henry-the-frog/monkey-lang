import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix } from '../src/matrix.js';
import { RNN, LSTM, GRU } from '../src/rnn.js';
import { mse } from '../src/loss.js';

function numericalGradient(forwardFn, weightMatrix, i, j, eps = 1e-5) {
  const orig = weightMatrix.get(i, j);
  weightMatrix.set(i, j, orig + eps);
  const lossPlus = forwardFn();
  weightMatrix.set(i, j, orig - eps);
  const lossMinus = forwardFn();
  weightMatrix.set(i, j, orig);
  return (lossPlus - lossMinus) / (2 * eps);
}

function relError(a, b) {
  return Math.abs(a - b) / (Math.abs(a) + Math.abs(b) + 1e-8);
}

describe('RNN/LSTM Numerical Gradient Verification', () => {
  
  describe('SimpleRNN BPTT', () => {
    it('Wih gradients match numerical (last output)', () => {
      const rnn = new RNN(2, 3, 'tanh', false);
      // 2 timesteps, inputSize=2: [batch=1, 4]
      const input = new Matrix(1, 4).randomize(0.5);
      const target = new Matrix(1, 3).randomize(0.5);
      
      const output = rnn.forward(input);
      const dOutput = mse.gradient(output, target);
      rnn.backward(dOutput);
      
      let maxError = 0;
      for (let i = 0; i < rnn.Wih.rows; i++) {
        for (let j = 0; j < rnn.Wih.cols; j++) {
          const ng = numericalGradient(() => {
            return mse.compute(rnn.forward(input), target);
          }, rnn.Wih, i, j);
          const ag = rnn.dWih.get(i, j);
          const err = relError(ng, ag);
          maxError = Math.max(maxError, err);
        }
      }
      assert.ok(maxError < 0.05, `RNN Wih gradient error: ${maxError}`);
    });

    it('Whh gradients match numerical (recurrent weights)', () => {
      const rnn = new RNN(2, 3, 'tanh', false);
      const input = new Matrix(1, 4).randomize(0.5);
      const target = new Matrix(1, 3).randomize(0.5);
      
      rnn.forward(input);
      rnn.backward(mse.gradient(rnn.forward(input), target));
      
      let maxError = 0;
      for (let i = 0; i < rnn.Whh.rows; i++) {
        for (let j = 0; j < rnn.Whh.cols; j++) {
          const ng = numericalGradient(() => {
            return mse.compute(rnn.forward(input), target);
          }, rnn.Whh, i, j);
          const ag = rnn.dWhh.get(i, j);
          const err = relError(ng, ag);
          maxError = Math.max(maxError, err);
        }
      }
      assert.ok(maxError < 0.05, `RNN Whh gradient error: ${maxError}`);
    });

    it('input gradients match numerical', () => {
      const rnn = new RNN(2, 3, 'tanh', false);
      const input = new Matrix(1, 4).randomize(0.5);
      const target = new Matrix(1, 3).randomize(0.5);
      
      const output = rnn.forward(input);
      const dInput = rnn.backward(mse.gradient(output, target));
      
      let maxError = 0;
      for (let j = 0; j < input.cols; j++) {
        const ng = numericalGradient(() => {
          return mse.compute(rnn.forward(input), target);
        }, input, 0, j);
        const err = relError(ng, dInput.get(0, j));
        maxError = Math.max(maxError, err);
      }
      assert.ok(maxError < 0.05, `RNN input gradient error: ${maxError}`);
    });

    it('returnSequences gradients match numerical', () => {
      const rnn = new RNN(2, 3, 'tanh', true);
      const input = new Matrix(1, 6).randomize(0.5); // 3 timesteps
      
      const output = rnn.forward(input);
      const target = new Matrix(1, output.cols).randomize(0.5);
      
      const dOutput = mse.gradient(output, target);
      rnn.backward(dOutput);
      
      // Check Wih
      let maxError = 0;
      for (let i = 0; i < rnn.Wih.rows; i++) {
        for (let j = 0; j < rnn.Wih.cols; j++) {
          const ng = numericalGradient(() => {
            return mse.compute(rnn.forward(input), target);
          }, rnn.Wih, i, j);
          const ag = rnn.dWih.get(i, j);
          const err = relError(ng, ag);
          maxError = Math.max(maxError, err);
        }
      }
      assert.ok(maxError < 0.05, `RNN returnSequences Wih gradient error: ${maxError}`);
    });
  });

  describe('LSTM BPTT', () => {
    it('Wi (input gate) gradients match numerical', () => {
      const lstm = new LSTM(2, 3, false);
      const input = new Matrix(1, 4).randomize(0.5); // 2 timesteps
      const target = new Matrix(1, 3).randomize(0.5);
      
      const output = lstm.forward(input);
      lstm.backward(mse.gradient(output, target));
      
      let maxError = 0;
      // Check a subset of Wi weights (combined [input+hidden, hidden])
      for (let trial = 0; trial < 8; trial++) {
        const i = Math.floor(Math.random() * lstm.Wi.rows);
        const j = Math.floor(Math.random() * lstm.Wi.cols);
        const ng = numericalGradient(() => {
          return mse.compute(lstm.forward(input), target);
        }, lstm.Wi, i, j);
        const ag = lstm._dWi.get(i, j);
        const err = relError(ng, ag);
        maxError = Math.max(maxError, err);
      }
      assert.ok(maxError < 0.05, `LSTM Wi gradient error: ${maxError}`);
    });

    it('Wf (forget gate) gradients match numerical', () => {
      const lstm = new LSTM(2, 3, false);
      const input = new Matrix(1, 4).randomize(0.5);
      const target = new Matrix(1, 3).randomize(0.5);
      
      lstm.forward(input);
      lstm.backward(mse.gradient(lstm.forward(input), target));
      
      let maxError = 0;
      for (let trial = 0; trial < 8; trial++) {
        const i = Math.floor(Math.random() * lstm.Wf.rows);
        const j = Math.floor(Math.random() * lstm.Wf.cols);
        const ng = numericalGradient(() => {
          return mse.compute(lstm.forward(input), target);
        }, lstm.Wf, i, j);
        const ag = lstm._dWf.get(i, j);
        const err = relError(ng, ag);
        maxError = Math.max(maxError, err);
      }
      assert.ok(maxError < 0.05, `LSTM Wf gradient error: ${maxError}`);
    });

    it('input gradients flow back correctly', () => {
      const lstm = new LSTM(2, 3, false);
      const input = new Matrix(1, 4).randomize(0.5);
      const target = new Matrix(1, 3).randomize(0.5);
      
      const output = lstm.forward(input);
      const dInput = lstm.backward(mse.gradient(output, target));
      
      let maxError = 0;
      for (let j = 0; j < input.cols; j++) {
        const ng = numericalGradient(() => {
          return mse.compute(lstm.forward(input), target);
        }, input, 0, j);
        const err = relError(ng, dInput.get(0, j));
        maxError = Math.max(maxError, err);
      }
      assert.ok(maxError < 0.05, `LSTM input gradient error: ${maxError}`);
    });

    it('longer sequences (5 timesteps) — Wc gradient check', () => {
      const lstm = new LSTM(2, 3, false);
      const input = new Matrix(1, 10).randomize(0.3); // 5 timesteps
      const target = new Matrix(1, 3).randomize(0.5);
      
      lstm.forward(input);
      lstm.backward(mse.gradient(lstm.forward(input), target));
      
      let maxError = 0;
      for (let trial = 0; trial < 8; trial++) {
        const i = Math.floor(Math.random() * lstm.Wc.rows);
        const j = Math.floor(Math.random() * lstm.Wc.cols);
        const ng = numericalGradient(() => {
          return mse.compute(lstm.forward(input), target);
        }, lstm.Wc, i, j);
        const ag = lstm._dWc.get(i, j);
        const err = relError(ng, ag);
        maxError = Math.max(maxError, err);
      }
      assert.ok(maxError < 0.05, `LSTM Wc 5-step gradient error: ${maxError}`);
    });

    it('Wo (output gate) gradient check', () => {
      const lstm = new LSTM(2, 3, false);
      const input = new Matrix(1, 4).randomize(0.5);
      const target = new Matrix(1, 3).randomize(0.5);
      
      lstm.forward(input);
      lstm.backward(mse.gradient(lstm.forward(input), target));
      
      let maxError = 0;
      for (let trial = 0; trial < 8; trial++) {
        const i = Math.floor(Math.random() * lstm.Wo.rows);
        const j = Math.floor(Math.random() * lstm.Wo.cols);
        const ng = numericalGradient(() => {
          return mse.compute(lstm.forward(input), target);
        }, lstm.Wo, i, j);
        const ag = lstm._dWo.get(i, j);
        const err = relError(ng, ag);
        maxError = Math.max(maxError, err);
      }
      assert.ok(maxError < 0.05, `LSTM Wo gradient error: ${maxError}`);
    });
  });

  describe('GRU BPTT', () => {
    it('Wz (update gate) gradients match numerical', () => {
      const gru = new GRU(2, 3, false);
      const input = new Matrix(1, 4).randomize(0.5);
      const target = new Matrix(1, 3).randomize(0.5);
      
      gru.forward(input);
      gru.backward(mse.gradient(gru.forward(input), target));
      
      let maxError = 0;
      for (let trial = 0; trial < 8; trial++) {
        const i = Math.floor(Math.random() * gru.Wz.rows);
        const j = Math.floor(Math.random() * gru.Wz.cols);
        const ng = numericalGradient(() => {
          return mse.compute(gru.forward(input), target);
        }, gru.Wz, i, j);
        const ag = gru._dWz.get(i, j);
        const err = relError(ng, ag);
        maxError = Math.max(maxError, err);
      }
      assert.ok(maxError < 0.05, `GRU Wz gradient error: ${maxError}`);
    });

    it('input gradients flow back', () => {
      const gru = new GRU(2, 3, false);
      const input = new Matrix(1, 4).randomize(0.5);
      const target = new Matrix(1, 3).randomize(0.5);
      
      const output = gru.forward(input);
      const dInput = gru.backward(mse.gradient(output, target));
      
      let maxError = 0;
      for (let j = 0; j < input.cols; j++) {
        const ng = numericalGradient(() => {
          return mse.compute(gru.forward(input), target);
        }, input, 0, j);
        const err = relError(ng, dInput.get(0, j));
        maxError = Math.max(maxError, err);
      }
      assert.ok(maxError < 0.05, `GRU input gradient error: ${maxError}`);
    });

    it('Wr (reset gate) gradients match numerical', () => {
      const gru = new GRU(2, 3, false);
      const input = new Matrix(1, 4).randomize(0.5);
      const target = new Matrix(1, 3).randomize(0.5);
      
      gru.forward(input);
      gru.backward(mse.gradient(gru.forward(input), target));
      
      let maxError = 0;
      for (let trial = 0; trial < 8; trial++) {
        const i = Math.floor(Math.random() * gru.Wr.rows);
        const j = Math.floor(Math.random() * gru.Wr.cols);
        const ng = numericalGradient(() => {
          return mse.compute(gru.forward(input), target);
        }, gru.Wr, i, j);
        const ag = gru._dWr.get(i, j);
        const err = relError(ng, ag);
        maxError = Math.max(maxError, err);
      }
      assert.ok(maxError < 0.05, `GRU Wr gradient error: ${maxError}`);
    });
  });
});
