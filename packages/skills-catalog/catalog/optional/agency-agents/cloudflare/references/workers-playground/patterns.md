# Workers Playground Patterns

## JSON API

```javascript
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/hello') return Response.json({ message: 'Hello' });
    if (url.pathname === '/api/echo' && request.method === 'POST') {
      return Response.json({ received: await request.json() });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
};
```

## Router Pattern

```javascript
const routes = {
  '/': () => new Response('Home'),
  '/api/users': () => Response.json([{ id: 1, name: 'Alice' }])
};

export default {
  async fetch(request) {
    const handler = routes[new URL(request.url).pathname];
    return handler ? handler() : new Response('Not Found', { status: 404 });
  }
};
```

## Proxy Pattern

```javascript
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = 'api.example.com';
    return fetch(url.toString(), {
      method: request.method, headers: request.headers, body: request.body
    });
  }
};
```

## CORS Handling

```javascript
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }
    const response = await fetch('https://api.example.com', request);
    const modified = new Response(response.body, response);
    modified.headers.set('Access-Control-Allow-Origin', '*');
    return modified;
  }
};
```

## Caching

```javascript
export default {
  async fetch(request) {
    if (request.method !== 'GET') return fetch(request);
    const cache = caches.default;
    let response = await cache.match(request);
    if (!response) {
      response = await fetch('https://api.example.com');
      if (response.status === 200) await cache.put(request, response.clone());
    }
    return response;
  }
};
```

## Hono Framework

```javascript
import { Hono } from 'https://esm.sh/hono@3';
const app = new Hono();
app.get('/', (c) => c.text('Hello'));
app.get('/api/users/:id', (c) => c.json({ id: c.req.param('id') }));
app.notFound((c) => c.json({ error: 'Not found' }, 404));
export default app;
```

## Authentication

```javascript
export default {
  async fetch(request) {
    const auth = request.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const token = auth.substring(7);
    if (token !== 'secret-token') {
      return Response.json({ error: 'Invalid token' }, { status: 403 });
    }
    return Response.json({ message: 'Authenticated' });
  }
};
```

## Error Handling

```javascript
export default {
  async fetch(request) {
    try {
      const response = await fetch('https://api.example.com');
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      return response;
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }
};
```

**Note:** In-memory state (Maps, variables) resets on Worker cold start. Use Durable Objects or KV for persistence.
