// Shared helpers: turn a server-rendered deck HTML into (a) a self-contained
// single file (snaps + assets + reveal inlined) and (b) a static print HTML
// (one 1280x720 page per slide) for clean 16:9 PDF export.
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const attrEsc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp" };

let REVEAL_CSS = null, REVEAL_JS = null;
function reveal() {
  if (REVEAL_CSS) return;
  REVEAL_CSS = execSync(`curl -fsSL "https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css"`, { encoding: "utf8", maxBuffer: 1 << 26 });
  REVEAL_JS = execSync(`curl -fsSL "https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"`, { encoding: "utf8", maxBuffer: 1 << 26 });
}

// Inline snaps (iframe srcdoc) + /asset images (base64). Leaves reveal on CDN.
export function inlineAssets(html) {
  html = html.replace(/src="\/snaps\/([\w-]+\.html)"/g, (m, file) => {
    const p = join(root, "assets", "snaps", file);
    return existsSync(p) ? `srcdoc="${attrEsc(readFileSync(p, "utf8"))}"` : m;
  });
  html = html.replace(/\/asset\/([A-Za-z0-9_\-./]+\.(jpg|jpeg|png|svg|webp))/g, (m, rel, ext) => {
    const p = join(root, "assets", rel);
    if (!existsSync(p)) return m;
    return `data:${MIME[ext.toLowerCase()]};base64,${readFileSync(p).toString("base64")}`;
  });
  return html;
}

// Full self-contained file: assets + reveal css+js inlined (fonts stay CDN).
export function inlineHtml(html) {
  html = inlineAssets(html);
  reveal();
  html = html.replace(/<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net\/npm\/reveal\.js@5\/dist\/reveal\.css">/, `<style>\n${REVEAL_CSS}\n</style>`);
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/reveal\.js@5\/dist\/reveal\.js"><\/script>/, `<script>\n${REVEAL_JS}\n</script>`);
  return html;
}

// Static print layout: drop reveal js/css + its init script, lay each <section>
// as a fixed 1280x720 page. Pass already-inlined html so snaps/images render.
// Expects html with CDN reveal refs intact (pass inlineAssets output, NOT
// inlineHtml). Strips reveal entirely and lays each section as a fixed page.
export function buildPrintHtml(html) {
  html = html.replace(/<link rel="stylesheet" href="https:\/\/cdn[^"]*reveal[^"]*\.css">/g, "");
  html = html.replace(/<script src="https:\/\/cdn[^"]*reveal[^"]*\.js"><\/script>/g, "");
  // remove the Reveal.initialize bootstrap script block
  html = html.replace(/<script>[\s\S]*?Reveal\.initialize[\s\S]*?<\/script>/g, "");
  const printCss = `<style id="print-pages">
@page{ size:1280px 720px; margin:0; }
html,body{ margin:0; padding:0; background:#F6F3EC; }
.reveal{ font-size:24px; }
.reveal .slides{ width:1280px; transform:none!important; left:0!important; top:0!important; }
.reveal .slides section{ display:block!important; visibility:visible!important; opacity:1!important; width:1280px; height:720px; max-height:720px; box-sizing:border-box; overflow:hidden; position:relative!important; break-inside:avoid; page-break-inside:avoid; transform:none!important; }
.reveal .slides section:not(:last-child){ break-after:page; page-break-after:always; }
.reveal .controls,.reveal .progress,.reveal .slide-number{ display:none!important; }
.reveal aside.notes,.reveal .notes,aside.notes,.reveal .backgrounds{ display:none!important; }
</style>`;
  // Reveal+fit are stripped, so client decks (render.mjs) that rely on the
  // fit() auto-shrink would overflow. Re-run an equivalent statically.
  const fitScript = `<script>
(function(){
  function fit(){
    document.querySelectorAll(".reveal .slides section").forEach(function(sec){
      // render.mjs decks: scale the .fit wrapper(s)
      var fits = sec.querySelectorAll(".fit");
      if(fits.length){
        fits.forEach(function(f){
          f.style.setProperty("--fit-scale","1");
          var avail = sec.querySelector(".layout.full") ? 600 : 624;
          if(f.scrollHeight > avail) f.style.setProperty("--fit-scale", Math.max(0.45,(avail/f.scrollHeight)).toFixed(3));
        });
      }
      // universal safety: if the section's content still overflows the page,
      // scale the whole inner block down (covers any deck / any layout)
      var c = sec.firstElementChild;
      if(c && c.dataset.scaled !== "1"){
        var h = c.scrollHeight;
        if(h > 718){
          var s = Math.max(0.45, 716/h);
          c.style.transformOrigin = "top left";
          c.style.transform = "scale("+s.toFixed(3)+")";
          c.style.width = (100/s).toFixed(2)+"%";
          c.style.height = (100/s).toFixed(2)+"%";
          c.dataset.scaled = "1";
        }
      }
    });
  }
  function run(){ try{ fit(); }catch(e){} }
  // fonts change text height — fit AFTER they load, and re-run a couple times
  if(document.fonts && document.fonts.ready){ document.fonts.ready.then(function(){ run(); setTimeout(run,150); setTimeout(run,400); }); }
  window.addEventListener("load", function(){ run(); setTimeout(run,250); setTimeout(run,600); });
})();
</script>`;
  html = html.replace("</head>", printCss + "</head>");
  return html.replace("</body>", fitScript + "</body>");
}
