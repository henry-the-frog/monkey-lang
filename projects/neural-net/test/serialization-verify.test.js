import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/network.js';
import { Dense } from '../src/layer.js';
import { Matrix } from '../src/matrix.js';
import { serializeWeights, deserializeWeights, saveToJSON, loadFromJSON, weightsChecksum } from '../src/serialize.js';

describe('Model serialization', () => {
  it('serialize then deserialize preserves weights', () => {
    const net = new Network();
    net.add(new Dense(3, 4, 'relu'));
    net.add(new Dense(4, 2, 'sigmoid'));
    
    // Set some specific weights
    net.layers[0].weights.set(0, 0, 42);
    net.layers[1].weights.set(1, 1, -7.5);
    
    const data = serializeWeights(net);
    
    // Create new network with same architecture
    const net2 = new Network();
    net2.add(new Dense(3, 4, 'relu'));
    net2.add(new Dense(4, 2, 'sigmoid'));
    
    deserializeWeights(net2, data);
    
    assert.equal(net2.layers[0].weights.get(0, 0), 42);
    assert.equal(net2.layers[1].weights.get(1, 1), -7.5);
  });

  it('JSON round-trip preserves predictions', () => {
    const net = new Network();
    net.add(new Dense(2, 3, 'relu'));
    net.add(new Dense(3, 1, 'sigmoid'));
    
    const input = Matrix.fromArray([[0.5, 0.3]]);
    const predBefore = net.forward(input);
    
    const json = saveToJSON(net);
    
    const net2 = new Network();
    net2.add(new Dense(2, 3, 'relu'));
    net2.add(new Dense(3, 1, 'sigmoid'));
    
    loadFromJSON(net2, json);
    
    const predAfter = net2.forward(input);
    
    // Should produce EXACTLY the same output
    assert.equal(predBefore.get(0, 0), predAfter.get(0, 0), 
      `Prediction should match: ${predBefore.get(0, 0)} vs ${predAfter.get(0, 0)}`);
  });

  it('trained model preserves predictions after save/load', () => {
    const net = new Network();
    net.add(new Dense(2, 4, 'sigmoid'));
    net.add(new Dense(4, 1, 'sigmoid'));
    net.loss('mse');
    
    // Train briefly
    for (let i = 0; i < 50; i++) {
      net.trainBatch([[1, 0]], [[1]], 0.1);
    }
    
    const input = Matrix.fromArray([[1, 0]]);
    const predBefore = net.forward(input);
    
    const json = saveToJSON(net);
    
    const net2 = new Network();
    net2.add(new Dense(2, 4, 'sigmoid'));
    net2.add(new Dense(4, 1, 'sigmoid'));
    
    loadFromJSON(net2, json);
    
    const predAfter = net2.forward(input);
    assert.equal(predBefore.get(0, 0), predAfter.get(0, 0));
  });

  it('weightsChecksum changes after training', () => {
    const net = new Network();
    net.add(new Dense(2, 3, 'relu'));
    net.add(new Dense(3, 1, 'sigmoid'));
    net.loss('mse');
    
    const csumBefore = weightsChecksum(net);
    
    net.trainBatch([[0.5, 0.3]], [[1]], 0.1);
    
    const csumAfter = weightsChecksum(net);
    assert.notEqual(csumBefore, csumAfter, 'Checksum should change after training');
  });

  it('weightsChecksum is deterministic', () => {
    const net = new Network();
    net.add(new Dense(2, 3, 'relu'));
    
    const csum1 = weightsChecksum(net);
    const csum2 = weightsChecksum(net);
    assert.equal(csum1, csum2, 'Same network should produce same checksum');
  });
});
