// ===== URL Router =====

export class Router {
  constructor() {
    this._routes = [];
    this._middleware = [];
    this._notFoundHandler = null;
  }

  add(method, pattern, handler) {
    const { regex, paramNames } = compile(pattern);
    this._routes.push({ method: method.toUpperCase(), pattern, regex, paramNames, handler });
    return this;
  }

  get(pattern, handler) { return this.add('GET', pattern, handler); }
  post(pattern, handler) { return this.add('POST', pattern, handler); }
  put(pattern, handler) { return this.add('PUT', pattern, handler);  }
  delete(pattern, handler) { return this.add('DELETE', pattern, handler); }
  all(pattern, handler) { return this.add('*', pattern, handler); }

  use(pathOrHandler, handler) {
    if (typeof pathOrHandler === 'function') {
      this._middleware.push({ path: null, handler: pathOrHandler });
    } else if (pathOrHandler instanceof Router) {
      // Mount sub-router
      this._middleware.push({ path: null, router: pathOrHandler });
    } else if (handler instanceof Router) {
      // Mount sub-router at path
      this._middleware.push({ path: pathOrHandler, router: handler });
    } else {
      this._middleware.push({ path: pathOrHandler, handler });
    }
    return this;
  }

  notFound(handler) {
    this._notFoundHandler = handler;
    return this;
  }

  match(method, fullPath) {
    // Split path and query
    const [path, qs] = fullPath.split('?');
    const query = parseQuery(qs);

    for (const route of this._routes) {
      if (route.method !== '*' && route.method !== method.toUpperCase()) continue;
      const match = route.regex.exec(path);
      if (match) {
        const params = {};
        route.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
        return { handler: route.handler, params, pattern: route.pattern, query };
      }
    }
    return null;
  }

  async handle(method, fullPath) {
    const [path, qs] = fullPath.split('?');
    const query = parseQuery(qs);

    // Find matching route
    const matched = this.match(method, fullPath);

    // Check sub-routers in middleware
    for (const mw of this._middleware) {
      if (mw.router && mw.path && path.startsWith(mw.path)) {
        const subPath = path.slice(mw.path.length) || '/';
        const subResult = await mw.router.handle(method, subPath);
        if (subResult) return subResult;
      }
    }

    if (!matched) {
      if (this._notFoundHandler) return this._notFoundHandler({ method, path, query });
      return null;
    }

    const req = { method, path, params: matched.params, query };
    const res = {};

    // Run middleware
    const middlewares = this._middleware.filter(mw => {
      if (mw.router) return false;
      if (!mw.path) return true;
      return path.startsWith(mw.path);
    });

    let idx = 0;
    const next = () => {
      if (idx < middlewares.length) {
        const mw = middlewares[idx++];
        mw.handler(req, res, next);
      }
    };
    next();

    // Run route handler
    await matched.handler(req, res);
    return res;
  }

  resolve(method, path) {
    const matched = this.match(method, path);
    if (!matched) return null;
    return matched.handler(matched.params);
  }

  get routes() { return this._routes.map(r => ({ method: r.method, pattern: r.pattern })); }
}

function compile(pattern) {
  const paramNames = [];
  let regexStr = pattern
    .replace(/:([^/]+)/g, (_, name) => { paramNames.push(name); return '([^/]+)'; })
    .replace(/\*/g, '(.*)');
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

// ===== Nested Router =====

export class NestedRouter extends Router {
  constructor() { super(); this._children = []; }

  mount(prefix, router) {
    this._children.push({ prefix, router });
    return this;
  }

  match(method, path) {
    // Check own routes first
    const own = super.match(method, path);
    if (own) return own;

    // Check children
    for (const { prefix, router } of this._children) {
      if (path.startsWith(prefix)) {
        const subPath = path.slice(prefix.length) || '/';
        const result = router.match(method, subPath);
        if (result) return result;
      }
    }
    return null;
  }
}

export function parseQuery(qs) {
  if (!qs) return {};
  const result = {};
  for (const pair of qs.split('&')) {
    const [key, ...rest] = pair.split('=');
    if (key) result[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
  }
  return result;
}
