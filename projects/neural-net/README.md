# Neural Network Library (From Scratch in JavaScript)

A comprehensive neural network library built entirely from scratch in JavaScript — no dependencies on TensorFlow, PyTorch, or any ML framework. Every layer, optimizer, loss function, and backward pass is implemented by hand.

## 📊 Status

- **488 tests** (all passing)
- **35 source modules**
- **45 test files**
- **6 bugs found and fixed** via systematic numerical gradient verification

## 🧠 Core Layers

| Module | Forward | Backward | Gradient Verified |
|--------|---------|----------|-------------------|
| Dense (fully connected) | ✅ | ✅ | ✅ numerical (sigmoid, tanh, relu) |
| Conv1D | ✅ | ✅ | ✅ numerical (filter + input) |
| Conv2D | ✅ | ✅ | ✅ numerical (filter + input) |
| Embedding | ✅ | ✅ | ✅ numerical (weight + zero-grad) |
| Residual | ✅ | ✅ | ✅ numerical (input + inner) |
| Dropout | ✅ | ✅ | ✅ (mask passthrough) |
| Flatten | ✅ | ✅ | — (identity) |
| MaxPool2D | ✅ | ✅ | — |

## 🔄 Recurrent

| Module | Forward | Backward (BPTT) | Gradient Verified |
|--------|---------|-----------------|-------------------|
| SimpleRNN | ✅ | ✅ | ✅ Wih, Whh, input, returnSequences |
| LSTM | ✅ | ✅ | ✅ Wi, Wf, Wc, Wo (all 4 gates) + input + 5-step |
| GRU | ✅ | ✅ | ✅ Wz, Wr + input |

## 🎯 Attention & Transformers

| Module | Forward | Backward | Gradient Verified |
|--------|---------|----------|-------------------|
| SelfAttention | ✅ | ✅ | ✅ Wq, Wv, Wo, input, 4-pos Wk |
| MultiHeadAttention | ✅ | ✅ | ✅ Wq, Wk, Wo, input (1e-10 error) |
| TransformerEncoderBlock | ✅ | ✅ | ✅ (via MicroGPT E2E) |
| LayerNorm | ✅ | ✅ | ✅ numerical (full cross-term formula) |
| PositionalEncoding | ✅ | ✅ | ✅ (additive passthrough) |

## 🤖 Models

| Module | Training | Verified |
|--------|----------|----------|
| **MicroGPT** | ✅ Full encoder backprop | ✅ E2E: learns patterns, generates text, loss → 6.2e-8 |
| Network (MLP) | ✅ | ✅ |
| Autoencoder | ✅ | ✅ encode/decode preserves structure |
| VAE | ✅ Reparameterization trick | ✅ numerical (decoder + encoder mu) |
| GAN | ✅ | ✅ numerical (discriminator + generator through frozen D) |
| GNN (Graph) | ✅ | ✅ forward dims, aggregation, training |
| DQN | ✅ | ✅ replay buffer, target sync, GridWorld |
| REINFORCE | ✅ | ✅ action selection, simple env training |
| RBM | ✅ Contrastive Divergence | ✅ sampling dims, CD training, weight updates |
| Diffusion | ✅ | ✅ (uses Network.trainBatch) |
| PredictiveCoding | ✅ Local learning | — (no backprop) |
| ContrastiveLearner | ✅ Weight perturbation | — (no backprop) |

## 📉 Normalization

| Module | Forward | Backward | Gradient Verified |
|--------|---------|----------|-------------------|
| BatchNorm | ✅ | ✅ | ✅ gamma, beta, input (full formula) |
| LayerNorm | ✅ | ✅ | ✅ (full cross-term formula) |

## ⚡ Optimizers

| Optimizer | Implementation | Verified |
|-----------|---------------|----------|
| SGD | ✅ | ✅ direction + quadratic convergence |
| MomentumSGD | ✅ | ✅ velocity accumulation + faster convergence |
| Adam | ✅ | ✅ finite results + quadratic convergence |
| AdamW | ✅ | ✅ weight decay with zero gradient |
| RMSProp | ✅ | ✅ per-parameter adaptation + convergence |
| NaturalGradient | ✅ | ✅ (existing tests) |
| KFAC | ✅ | ✅ (existing tests) |

## 📅 Learning Rate Schedulers

All 8 verified: Constant, LinearWarmup, CosineAnnealing, StepDecay, WarmupCosine, ExponentialDecay, CyclicLR, LinearDecay.

## 🛡️ Utilities

- **Gradient Clipping**: clipByValue, clipByNorm, clipByGlobalNorm — all verified
- **Data Augmentation**: flip, rotate, noise, crop
- **Serialization**: save/load model weights
- **Early Stopping**: patience-based training termination
- **Weight Initializers**: Xavier, He, Lecun
- **Callbacks**: training hooks

## 🐛 Bugs Found (April 16, 2026)

Through systematic numerical gradient verification:

1. **SelfAttention input mutation** (CRITICAL) — `forward()` wrote output back into input matrix, corrupting all subsequent computations. Attention could never properly train.
2. **LayerNorm simplified backward** — Missing cross-terms in gradient formula. ~100% error on input gradients.
3. **MicroGPT partial backward** — Only trained output projection, not encoder blocks. Transformer layers were frozen.
4. **Adam/AdamW NaN on first update** — `t=0` caused bias correction division by zero.
5. **Conv1D/Conv2D double-division** — backward averaged gradients, update divided by batchSize again. Effective learning rate was batchSize² too small.

## Architecture

```
src/
├── matrix.js          # Matrix operations (dot, add, mul, transpose, etc.)
├── activation.js      # ReLU, sigmoid, tanh, softmax, GELU, etc.
├── loss.js            # MSE, cross-entropy, binary cross-entropy
├── layer.js           # Dense layer with forward/backward
├── network.js         # Sequential network container
├── optimizer.js       # SGD, Adam, AdamW, RMSProp, NaturalGradient, KFAC
├── attention.js       # SelfAttention, MultiHeadAttention
├── transformer.js     # TransformerEncoderBlock, LayerNorm, PositionalEncoding
├── microgpt.js        # Full GPT model (embedding → transformer → output)
├── rnn.js             # RNN, LSTM, GRU with BPTT
├── conv.js            # Conv2D, MaxPool2D, Flatten
├── conv1d.js          # Conv1D, GlobalAvgPool1D, MaxPool1D
├── embedding.js       # Token embedding layer
├── batchnorm.js       # Batch normalization
├── dropout.js         # Dropout regularization
├── residual.js        # Residual connections
├── vae.js             # Variational Autoencoder
├── autoencoder.js     # Standard Autoencoder
├── gan.js             # GAN (generator + discriminator)
├── gnn.js             # Graph Neural Network (GCN)
├── dqn.js             # Deep Q-Network
├── reinforce.js       # REINFORCE policy gradient
├── rbm.js             # Restricted Boltzmann Machine
├── diffusion.js       # Diffusion model
├── predictive-coding.js # Predictive coding network
├── contrastive.js     # Contrastive learning
├── gradient-clip.js   # Gradient clipping utilities
├── scheduler.js       # Learning rate schedulers
├── augmentation.js    # Data augmentation
├── initializers.js    # Weight initializers
├── serialize.js       # Model serialization
├── callbacks.js       # Training callbacks
└── index.js           # Main exports
```
