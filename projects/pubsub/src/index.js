// ===== Pub/Sub Message Broker =====

let msgId = 0;

class Message {
  constructor(topic, data) {
    this.id = ++msgId;
    this.topic = topic;
    this.data = data;
    this.timestamp = Date.now();
    this.acked = false;
  }
}

class Subscription {
  constructor(id, topic, handler, { group, filter, maxRetries = 3, once = false } = {}) {
    this.id = id;
    this.topic = topic;
    this.handler = handler;
    this.group = group;
    this.filter = filter;
    this.maxRetries = maxRetries;
    this.once = once;
    this.pending = [];
    this.delivered = 0;
    this.failed = 0;
  }
}

export class Broker {
  constructor() {
    this.topics = new Map();         // topic → [messages]
    this.subscriptions = new Map();  // subId → Subscription
    this.topicSubs = new Map();      // topic → Set of subIds
    this._nextSubId = 1;
    this.deadLetter = [];
    this._history = new Map();       // topic → [data]
    this._middleware = [];
    this._deadLetterHandler = null;
  }

  createTopic(name) {
    if (!this.topics.has(name)) {
      this.topics.set(name, []);
      this.topicSubs.set(name, new Set());
    }
    return this;
  }

  subscribe(topic, handler, options = {}) {
    this.createTopic(topic);
    const id = this._nextSubId++;
    const sub = new Subscription(id, topic, handler, options);
    this.subscriptions.set(id, sub);
    this.topicSubs.get(topic).add(id);
    
    // Replay history if requested
    if (options.replay) {
      const history = this._history.get(topic) || [];
      const items = history.slice(-options.replay);
      for (const data of items) {
        handler(data, topic);
      }
    }
    
    // Return unsubscribe function
    const unsub = () => this.unsubscribe(id);
    unsub.id = id;
    return unsub;
  }

  subscribeOnce(topic, handler) {
    return this.subscribe(topic, handler, { once: true });
  }

  unsubscribe(subIdOrFn) {
    const subId = typeof subIdOrFn === 'function' ? subIdOrFn.id : subIdOrFn;
    const sub = this.subscriptions.get(subId);
    if (!sub) return false;
    this.topicSubs.get(sub.topic)?.delete(subId);
    this.subscriptions.delete(subId);
    return true;
  }

  publish(topic, data) {
    // Apply middleware
    for (const mw of this._middleware) {
      data = mw(topic, data);
      if (data === undefined) return 0;
    }
    
    this.createTopic(topic);
    const msg = new Message(topic, data);
    this.topics.get(topic).push(msg);
    
    // Store in history
    if (!this._history.has(topic)) this._history.set(topic, []);
    this._history.get(topic).push(data);
    
    let deliveryCount = 0;
    
    // Find matching subscriptions (exact + wildcard)
    for (const [subTopic, subs] of this.topicSubs) {
      if (!this._topicMatch(subTopic, topic)) continue;
      
      const groups = new Map();
      const ungrouped = [];
      const toRemove = [];
      
      for (const subId of subs) {
        const sub = this.subscriptions.get(subId);
        if (!sub) continue;
        if (sub.filter && !sub.filter(msg)) continue;
        
        if (sub.group) {
          if (!groups.has(sub.group)) groups.set(sub.group, []);
          groups.get(sub.group).push(sub);
        } else {
          ungrouped.push(sub);
        }
      }

      for (const sub of ungrouped) {
        this._deliverSimple(sub, data, topic);
        deliveryCount++;
        if (sub.once) toRemove.push(sub.id);
      }

      for (const [, members] of groups) {
        const target = members.reduce((a, b) => 
          a.pending.length <= b.pending.length ? a : b
        );
        this._deliverSimple(target, data, topic);
        deliveryCount++;
        if (target.once) toRemove.push(target.id);
      }
      
      for (const id of toRemove) this.unsubscribe(id);
    }
    
    // Dead letter handling
    if (deliveryCount === 0 && this._deadLetterHandler) {
      this._deadLetterHandler(data, topic);
    }
    
    return deliveryCount;
  }

  _deliverSimple(sub, data, topic) {
    try {
      sub.handler(data, topic);
      sub.delivered++;
    } catch (err) {
      sub.failed++;
      this.deadLetter.push({ data, error: err.message, subId: sub.id });
    }
  }

  _topicMatch(pattern, topic) {
    if (pattern === topic) return true;
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$');
      return regex.test(topic);
    }
    if (pattern.endsWith('#')) {
      const prefix = pattern.slice(0, -1);
      return topic.startsWith(prefix);
    }
    return false;
  }

  getHistory(topic, n) {
    const history = this._history.get(topic) || [];
    if (n !== undefined) return history.slice(-n);
    return [...history];
  }

  use(fn) {
    this._middleware.push(fn);
    return this;
  }

  onDeadLetter(handler) {
    this._deadLetterHandler = handler;
    return this;
  }

  subscriberCount(topic) {
    return this.topicSubs.get(topic)?.size ?? 0;
  }

  activeTopics() {
    const topics = [];
    for (const [topic, subs] of this.topicSubs) {
      if (subs.size > 0) topics.push(topic);
    }
    return topics;
  }

  clear() {
    this.topics.clear();
    this.subscriptions.clear();
    this.topicSubs.clear();
    this._history.clear();
    this._middleware = [];
    this._deadLetterHandler = null;
    this.deadLetter = [];
    this._nextSubId = 1;
  }

  async request(topic, payload, timeout = 5000) {
    const replyTo = `__reply_${++msgId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Request timeout')), timeout);
      this.subscribeOnce(replyTo, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.publish(topic, { payload, replyTo });
    });
  }

  stats(topic) {
    return {
      messages: this.topics.get(topic)?.length ?? 0,
      subscribers: this.topicSubs.get(topic)?.size ?? 0,
      deadLetterCount: this.deadLetter.length,
    };
  }

  getTopics() { return [...this.topics.keys()]; }
}
