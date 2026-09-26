# Zaraz Configuration

## Dashboard Setup

1. Domain → Zaraz → Start setup
2. Add tool (e.g., Google Analytics 4)
3. Enter credentials (GA4: `G-XXXXXXXXXX`)
4. Configure triggers
5. Save and Publish

## Triggers

| Type | When | Use Case |
|------|------|----------|
| Pageview | Page load | Track page views |
| Click | Element clicked | Button tracking |
| Form Submission | Form submitted | Lead capture |
| History Change | URL changes (SPA) | React/Vue routing |
| Variable Match | Custom condition | Conditional firing |

### History Change (SPA)

```
Type: History Change
Event: pageview
```

Fires on `pushState`, `replaceState`, hash changes. **No manual tracking needed.**

### Click Trigger

```
Type: Click
CSS Selector: .buy-button
Event: purchase_intent
Properties:
  button_text: {{system.clickElement.text}}
```

## Tool Configuration

**GA4:**
```
Measurement ID: G-XXXXXXXXXX
Events: page_view, purchase, user_engagement
```

**Facebook Pixel:**
```
Pixel ID: 1234567890123456
Events: PageView, Purchase, AddToCart
```

**Google Ads:**
```
Conversion ID: AW-XXXXXXXXX
Conversion Label: YYYYYYYYYY
```

## Consent Management

1. Settings → Consent → Create purposes (analytics, marketing)
2. Map tools to purposes
3. Set behavior: "Do not load until consent granted"

**Programmatic consent:**
```javascript
zaraz.consent.setAll({ analytics: true, marketing: true });
```

## Privacy Features

| Feature | Default |
|---------|---------|
| IP Anonymization | Enabled |
| Cookie Control | Via consent purposes |
| GDPR/CCPA | Consent modal |

## Testing

1. **Preview Mode** - test without publishing
2. **Debug Mode** - `zaraz.debug = true`
3. **Network tab** - filter "zaraz"

## Limits

| Resource | Limit |
|----------|-------|
| Event properties | 100KB |
| Consent purposes | 20 |
