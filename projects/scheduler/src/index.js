// ===== Task Scheduler =====
// Priority queue-based scheduler with delayed and recurring tasks

// ===== Min-Heap Priority Queue =====

class MinHeap {
  constructor(comparator = (a, b) => a.priority - b.priority) {
    this.items = [];
    this.compare = comparator;
  }

  get size() { return this.items.length; }
  peek() { return this.items[0]; }

  push(item) {
    this.items.push(item);
    this._bubbleUp(this.items.length - 1);
  }

  pop() {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.items[i], this.items[parent]) >= 0) break;
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
      i = parent;
    }
  }

  _sinkDown(i) {
    while (true) {
      let smallest = i;
      const left = 2 * i + 1, right = 2 * i + 2;
      if (left < this.items.length && this.compare(this.items[left], this.items[smallest]) < 0) smallest = left;
      if (right < this.items.length && this.compare(this.items[right], this.items[smallest]) < 0) smallest = right;
      if (smallest === i) break;
      [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
      i = smallest;
    }
  }
}

// ===== Task =====

let taskId = 0;

class Task {
  constructor(fn, options = {}) {
    this.id = ++taskId;
    this.fn = fn;
    this.priority = options.priority ?? 0;
    this.runAt = options.runAt ?? Date.now();
    this.interval = options.interval ?? null;
    this.maxRuns = options.maxRuns ?? (options.interval ? Infinity : 1);
    this.name = options.name ?? `task-${this.id}`;
    this.runs = 0;
    this.cancelled = false;
    this.lastRun = null;
    this.lastResult = undefined;
    this.lastError = null;
  }
}

// ===== Scheduler =====

export class Scheduler {
  constructor() {
    this.queue = new MinHeap((a, b) => {
      if (a.runAt !== b.runAt) return a.runAt - b.runAt;
      return a.priority - b.priority;
    });
    this.tasks = new Map();
    this._timer = null;
    this._running = false;
    this._completed = [];
  }

  // Schedule a one-shot task
  schedule(fn, { delay = 0, priority = 0, name } = {}) {
    const task = new Task(fn, { priority, runAt: Date.now() + delay, name });
    this.tasks.set(task.id, task);
    this.queue.push(task);
    return task.id;
  }

  // Schedule a recurring task
  scheduleRecurring(fn, { interval, priority = 0, maxRuns = Infinity, name } = {}) {
    const task = new Task(fn, { priority, interval, maxRuns, runAt: Date.now(), name });
    this.tasks.set(task.id, task);
    this.queue.push(task);
    return task.id;
  }

  // Schedule at a specific time
  scheduleAt(fn, time, { priority = 0, name } = {}) {
    const runAt = time instanceof Date ? time.getTime() : time;
    const task = new Task(fn, { priority, runAt, name });
    this.tasks.set(task.id, task);
    this.queue.push(task);
    return task.id;
  }

  cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (task) { task.cancelled = true; return true; }
    return false;
  }

  // Run all due tasks synchronously (useful for testing)
  tick(now = Date.now()) {
    const executed = [];
    
    while (this.queue.size > 0 && this.queue.peek().runAt <= now) {
      const task = this.queue.pop();
      
      if (task.cancelled) continue;
      
      try {
        task.lastResult = task.fn();
        task.lastError = null;
      } catch (err) {
        task.lastError = err;
      }
      
      task.runs++;
      task.lastRun = now;
      executed.push(task);
      
      // Re-queue recurring tasks
      if (task.interval && task.runs < task.maxRuns && !task.cancelled) {
        task.runAt = now + task.interval;
        this.queue.push(task);
      } else if (!task.interval || task.runs >= task.maxRuns) {
        this._completed.push(task);
      }
    }
    
    return executed;
  }

  // Start the scheduler (real-time)
  start(intervalMs = 100) {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  get pendingCount() {
    return [...this.tasks.values()].filter(t => !t.cancelled && t.runs < (t.maxRuns ?? 1)).length;
  }

  getTask(id) { return this.tasks.get(id); }

  get completedTasks() { return this._completed; }

  get pending() { return this.pendingCount; }

  async runNext() {
    const task = this.queue.pop();
    if (!task) return null;
    if (task.cancelled) return this.runNext();
    try {
      const result = await task.fn();
      task.runs++;
      const entry = { id: task.id, result, status: 'completed' };
      this._completed.push(entry);
      return entry;
    } catch (e) {
      const entry = { id: task.id, error: e.message, status: 'failed' };
      this._completed.push(entry);
      return entry;
    }
  }

  async run() {
    const results = [];
    while (this.queue.size > 0) {
      const r = await this.runNext();
      if (r) results.push(r);
    }
    return results;
  }
}

export { MinHeap, Task };
