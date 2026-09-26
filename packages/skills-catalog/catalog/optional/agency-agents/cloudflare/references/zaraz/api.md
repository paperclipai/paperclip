# Zaraz Web API

Client-side JavaScript API for tracking events, setting properties, and managing consent.

## zaraz.track()

```javascript
zaraz.track('button_click');
zaraz.track('purchase', { value: 99.99, currency: 'USD', item_id: '12345' });
zaraz.track('pageview', { page_path: '/products', page_title: 'Products' }); // SPA
```

**Params:** `eventName` (string), `properties` (object, optional). Fire-and-forget.

## zaraz.set()

```javascript
zaraz.set('userId', 'user_12345');
zaraz.set({ email: '[email protected]', plan: 'premium', country: 'US' });
```

Properties persist for page session. Use for user identification and segmentation.

## zaraz.ecommerce()

```javascript
zaraz.ecommerce('Product Viewed', { product_id: 'SKU123', name: 'Widget', price: 49.99 });
zaraz.ecommerce('Product Added', { product_id: 'SKU123', quantity: 2, price: 49.99 });
zaraz.ecommerce('Order Completed', {
  order_id: 'ORD-789', total: 149.98, currency: 'USD',
  products: [{ product_id: 'SKU123', quantity: 2, price: 49.99 }]
});
```

**Events:** `Product Viewed`, `Product Added`, `Product Removed`, `Cart Viewed`, `Checkout Started`, `Order Completed`

Tools auto-map to GA4, Facebook CAPI, etc.

## System Properties (Triggers)

```
{{system.page.url}}   {{system.page.title}}   {{system.page.referrer}}
{{system.device.ip}}  {{system.device.userAgent}}  {{system.device.language}}
{{system.cookies.name}}  {{client.__zarazTrack.userId}}
```

## zaraz.consent

```javascript
// Check
const purposes = zaraz.consent.getAll(); // { analytics: true, marketing: false }

// Set
zaraz.consent.modal = true; // Show modal
zaraz.consent.setAll({ analytics: true, marketing: false });
zaraz.consent.set('marketing', true);

// Listen
zaraz.consent.addEventListener('consentChanged', () => {
  if (zaraz.consent.getAll().marketing) zaraz.track('marketing_consent_granted');
});
```

**Flow:** Configure purposes in dashboard → Map tools to purposes → Show modal/set programmatically → Tools fire when allowed

## zaraz.debug

```javascript
zaraz.debug = true;
zaraz.track('test_event');
console.log(zaraz.tools); // View loaded tools
```

## Cookie Methods

```javascript
zaraz.getCookie('session_id');  // Zaraz namespace
zaraz.readCookie('_ga');        // Any cookie
```

## Async Behavior

All methods fire-and-forget. Events batched and sent asynchronously:

```javascript
zaraz.track('event1');
zaraz.set('prop', 'value');
zaraz.track('event2'); // All batched
```

## TypeScript Types

```typescript
interface Zaraz {
  track(event: string, properties?: Record<string, unknown>): void;
  set(key: string, value: unknown): void;
  set(properties: Record<string, unknown>): void;
  ecommerce(event: string, properties: Record<string, unknown>): void;
  consent: {
    getAll(): Record<string, boolean>;
    setAll(purposes: Record<string, boolean>): void;
    set(purpose: string, value: boolean): void;
    addEventListener(event: 'consentChanged', callback: () => void): void;
    modal: boolean;
  };
  debug: boolean;
  tools?: string[];
  getCookie(name: string): string | undefined;
  readCookie(name: string): string | undefined;
}
declare global { interface Window { zaraz: Zaraz; } }
```
