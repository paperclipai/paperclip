// Fetch a client's logo from their website (server-side) and cache it under
// assets/client-logos/. Strategy: scrape og:image / apple-touch-icon / <link
// rel=icon> from the homepage, then fall back to Google's favicon service.
// Returns a /asset-rooted URL the deck can embed, or null on any failure.
// Fully keyless — no third-party logo vendor.
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const DIR = join(root, "assets", "client-logos");
const UA = "Mozilla/5.0 (compatible; finn-pitch/1.0)";
const EXTS = ["svg", "png", "jpg", "webp", "ico", "gif"];

function domainOf(url = "") {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url.trim()}`);
    return u.hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch { return null; }
}

const abs = (base, href) => { try { return new URL(href, base).href; } catch { return null; } };

function extFromCT(ct = "") {
  if (/svg/i.test(ct)) return "svg";
  if (/png/i.test(ct)) return "png";
  if (/jpe?g/i.test(ct)) return "jpg";
  if (/webp/i.test(ct)) return "webp";
  if (/icon|\.ico/i.test(ct)) return "ico";
  if (/gif/i.test(ct)) return "gif";
  return "png";
}

async function getText(url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "user-agent": UA } });
    return r.ok ? await r.text() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

async function getImage(url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "user-agent": UA } });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!/image\//i.test(ct)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 200) return null; // too tiny to be a usable logo
    return { buf, ext: extFromCT(ct) };
  } catch { return null; } finally { clearTimeout(t); }
}

// Pull candidate logo URLs out of homepage HTML, best-quality first.
function candidatesFromHtml(html, base) {
  const out = [];
  const metaC = (key) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, "i");
    const m = html.match(re) || html.match(re2);
    return m ? m[1] : null;
  };
  const linkC = (relWord) => {
    const re = new RegExp(`<link[^>]+rel=["'][^"']*${relWord}[^"']*["'][^>]*href=["']([^"']+)["']`, "i");
    const re2 = new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*${relWord}[^"']*["']`, "i");
    const m = html.match(re) || html.match(re2);
    return m ? m[1] : null;
  };
  // square brand marks first — og/twitter images are often marketing banners
  // with text, which look wrong in a logo lockup, so they come later.
  out.push(linkC("apple-touch-icon"), linkC("icon"));
  out.push(metaC("og:image:secure_url"), metaC("og:image"), metaC("twitter:image"));
  return out.filter(Boolean).map((h) => abs(base, h)).filter(Boolean);
}

export async function fetchClientLogo(website = "") {
  const domain = domainOf(website);
  if (!domain) return null;
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

  // already cached
  for (const ext of EXTS) {
    if (existsSync(join(DIR, `${domain}.${ext}`))) return `/asset/client-logos/${domain}.${ext}`;
  }

  const base = `https://${domain}/`;
  const html = await getText(base);
  const candidates = html ? candidatesFromHtml(html, base) : [];
  candidates.push(`https://www.google.com/s2/favicons?domain=${domain}&sz=128`); // keyless fallback

  for (const url of candidates) {
    const img = await getImage(url);
    if (!img) continue;
    const file = `${domain}.${img.ext}`;
    writeFileSync(join(DIR, file), img.buf);
    return `/asset/client-logos/${file}`;
  }
  return null;
}
