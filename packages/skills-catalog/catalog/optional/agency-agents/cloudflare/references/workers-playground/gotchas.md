# Workers Playground Gotchas

## Platform Limitations

| Limitation | Impact | Workaround |
|------------|--------|------------|
| Safari broken | Preview fails | Use Chrome/Firefox/Edge |
| TypeScript unsupported | TS syntax errors | Write plain JS or use JSDoc |
| No bindings | `env` always `{}` | Mock data or use external APIs |
| No env vars | Can't access secrets | Hardcode for testing |

## Common Runtime Errors

### "Response body already read"

```javascript
// ❌ Body consumed twice
const body = await request.text();
await fetch(url, { body: request.body }); // Error!

// ✅ Clone first
const clone = request.clone();
const body = await request.text();
await fetch(url, { body: clone.body });
```

### "Worker exceeded CPU time"

**Limit:** 10ms (free), 30s default / 5min max (paid)

```javascript
// ✅ Move slow work to background
ctx.waitUntil(fetch('https://analytics.example.com', {...}));
return new Response('OK'); // Return immediately
```

### "Too many subrequests"

**Limit:** 50 (free), 1000 (paid)

```javascript
// ❌ 100 individual fetches
// ✅ Batch into single API call
await fetch('https://api.example.com/batch', {
  body: JSON.stringify({ ids: [...] })
});
```

## Best Practices

```javascript
// Clone before caching
await cache.put(request, response.clone());
return response;

// Validate input early
if (request.method !== 'POST') return new Response('', { status: 405 });

// Handle errors
try { ... } catch (e) {
  return Response.json({ error: e.message }, { status: 500 });
}
```

## Limits

| Resource | Free | Paid |
|----------|------|------|
| CPU time | 10ms | 30s (default), 5min (max) |
| Memory | 128 MB | 128 MB |
| Subrequests | 50 | 10,000 |

## Browser Support

| Browser | Status |
|---------|--------|
| Chrome | ✅ Recommended |
| Firefox | ✅ Works |
| Edge | ✅ Works |
| Safari | ❌ Broken |

## Debugging

```javascript
console.log('URL:', request.url); // View in browser DevTools Console
```

**Note:** `console.log` works in playground. For production, use Logpush or Tail Workers.
