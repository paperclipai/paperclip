# GA4 Implementation Guide — DJ Technologies

## Overview

Set up Google Analytics 4 across all 3 domains. No existing GA4 or GTM was detected.

---

## Step 1: Create GA4 Property

1. Go to https://analytics.google.com
2. Click **Admin → Create Property**
3. Property name: `DJ Technologies - All Domains`
4. Reporting time zone: `Asia/Kolkata` (or `Europe/London` for .uk)
5. Currency: `USD`
6. Click **Create**

## Step 2: Create Data Streams

Create one data stream per domain:

### Stream 1: djtechnologies.in
- Platform: **Web**
- Site URL: `https://djtechnologies.in`
- Stream name: `DJ Technologies India`
- Measurement ID: `G-XXXXXXXX` (generated)

### Stream 2: djtechnologies.uk
- Platform: **Web**
- Site URL: `https://djtechnologies.uk`
- Stream name: `DJ Technologies UK`

### Stream 3: djtechnologies.net
- Platform: **Web**
- Site URL: `https://djtechnologies.net`
- Stream name: `DJ Technologies Hosting`

## Step 3: GA4 Tracking Code (djtechnologies.in + .uk)

Inject this into the `<head>` of every page on both SPA sites:

```html
<!-- Google tag (gtag.js) - GA4 -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX', {
    send_page_view: true,
    cookie_domain: 'auto'
  });
</script>
```

For SPA page transitions, call `gtag('set', 'page_path', newPath); gtag('event', 'page_view');` on every route change.

## Step 4: GA4 + Facebook Pixel (djtechnologies.net)

Already has Facebook Pixel. Add GA4 alongside it in the `<head>`:

```html
<!-- Google tag (gtag.js) - GA4 -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-YYYYYYYYYY"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-YYYYYYYYYY');
</script>
```

## Step 5: Enhanced Measurement

Enable these in GA4 Admin → Data Streams → Enhanced Measurement:
- [x] Page views (on by default)
- [x] Scrolls
- [x] Outbound clicks
- [x] Site search
- [x] Video engagement
- [x] File downloads

## Step 6: Conversion Events to Track

Set these as conversions in GA4:

| Event | Trigger | Priority |
|---|---|---|
| `contact_form_submit` | Contact form submission | Critical |
| `schedule_consultation` | Calendly click / booking | Critical |
| `get_started_click` | "Get Started" CTA | High |
| `ai_demo_request` | AI demo form submission | High |
| `purchase_initiated` | Hosting checkout start | High |
| `phone_call_click` | Phone number tap (mobile) | Medium |
| `whatsapp_click` | WhatsApp button | Medium |
| `knowledge_base_search` | KB searches | Medium |
| `scroll_75` | 75% page scroll | Low |
| `video_start` | Video play | Low |

## Step 7: Google Search Console Linking

1. Go to GA4 Admin → **Product Links → Search Console Links**
2. Link each property
3. Verify domain ownership in Search Console
4. Enable Search Console reports in GA4

## Step 8: Tag Manager (Optional Upgrade)

For more complex tracking, set up Google Tag Manager:

```html
<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-XXXXXXX');</script>
<!-- End Google Tag Manager -->
```

## Step 9: Verify Tracking

- Use GA4 DebugView or Chrome GA4 Debugger extension
- Check Realtime report for active sessions
- Verify page_view events fire on initial load and SPA navigation

---

## Cross-Domain Tracking

Since .in and .uk serve the same content:
- Use `gtag('config', 'G-ID', { linker: { domains: ['djtechnologies.in', 'djtechnologies.uk', 'djtechnologies.net'] } })`
- This preserves the same user across domain transitions
