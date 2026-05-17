import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface BlogPostFrontmatter {
  title: string;
  description: string;
  slug: string;
  tags: string[];
  keywords: string[];
  date: string;
  author: string;
  readingTime: string;
  canonical: string;
  ogImage: string;
}

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string;
  author: string;
  readingTime: string;
  tags: string[];
  keywords: string[];
  canonical: string;
  ogImage: string;
  html: string;
  wordCount: number;
}

function parseFrontmatter(raw: string): { frontmatter: BlogPostFrontmatter; content: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatterRaw = match[1];
  const content = match[2].trimStart();

  const lines = frontmatterRaw.split("\n");
  const fm: Record<string, unknown> = {};

  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value: unknown = line.slice(colonIndex + 1).trim();

    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    }

    if (typeof value === "string") {
      value = value.replace(/^["']|["']$/g, "");
    }

    fm[key] = value;
  }

  return {
    frontmatter: fm as unknown as BlogPostFrontmatter,
    content,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^---\s*$/.test(line)) {
      out.push('<hr class="my-8 border-slate-200" />');
      i++;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const cls = [
        "text-3xl font-bold text-slate-900 mt-10 mb-4",
        "text-2xl font-bold text-slate-900 mt-8 mb-3",
        "text-xl font-semibold text-slate-900 mt-6 mb-2",
        "text-lg font-semibold text-slate-900 mt-4 mb-2",
        "text-base font-semibold text-slate-900 mt-4 mb-1",
        "text-sm font-semibold text-slate-900 mt-4 mb-1",
      ][level - 1];
      const anchorId = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      out.push(`<h${level} id="${anchorId}" class="${cls}">${renderInline(text)}</h${level}>`);
      i++;
      continue;
    }

    if (/^```/.test(line)) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      out.push(`<pre class="bg-slate-900 text-slate-100 rounded-xl p-4 my-6 overflow-x-auto text-sm"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^>\s/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote class="border-l-4 border-brand-300 bg-brand-50 rounded-r-xl px-6 py-4 my-6 text-slate-700 italic"><p>${renderInline(quoteLines.join(" "))}</p></blockquote>`);
      continue;
    }

    if (/^[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s/, ""));
        i++;
      }
      out.push('<ul class="list-disc pl-6 my-4 text-slate-700 space-y-2">');
      for (const item of items) {
        out.push(`  <li>${renderInline(item)}</li>`);
      }
      out.push("</ul>");
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
      }
      out.push('<ol class="list-decimal pl-6 my-4 text-slate-700 space-y-2">');
      for (const item of items) {
        out.push(`  <li>${renderInline(item)}</li>`);
      }
      out.push("</ol>");
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^---\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s/.test(lines[i]) &&
      !/^[-*+]\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      out.push(`<p class="text-slate-700 leading-relaxed mb-4">${renderInline(paraLines.join(" "))}</p>`);
    }
  }

  return out.join("\n");
}

function renderInline(text: string): string {
  let result = escapeHtml(text);

  result = result.replace(/`([^`]+)`/g, '<code class="bg-slate-100 text-brand-700 px-1.5 py-0.5 rounded text-sm font-mono">$1</code>');

  result = result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  result = result.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-brand-600 underline hover:text-brand-700">$1</a>');

  return result;
}

function blogPageHtml(params: {
  title: string;
  description: string;
  canonical: string;
  ogTitle: string;
  ogDescription: string;
  ogUrl: string;
  body: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en" prefix="og: https://ogp.me/ns#">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(params.title)}</title>
<meta name="description" content="${escapeHtml(params.description)}" />
<link rel="canonical" href="${escapeHtml(params.canonical)}" />
<meta property="og:title" content="${escapeHtml(params.ogTitle)}" />
<meta property="og:description" content="${escapeHtml(params.ogDescription)}" />
<meta property="og:url" content="${escapeHtml(params.ogUrl)}" />
<meta property="og:type" content="website" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>✈️</text></svg>" />
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd',
          400: '#60a5fa', 500: '#2563eb', 600: '#1d4ed8', 700: '#1e40af',
          800: '#1e3a8a', 900: '#172554',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    }
  }
}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>
html { scroll-behavior: smooth; }
ul:not([class]) { list-style: disc; padding-left: 1.5rem; margin: 1rem 0; }
ol:not([class]) { list-style: decimal; padding-left: 1.5rem; margin: 1rem 0; }
</style>
</head>
<body class="bg-white text-slate-900 font-sans antialiased">

<nav class="fixed top-0 left-0 right-0 z-50 bg-white/90 backdrop-blur-md border-b border-slate-100">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="flex items-center justify-between h-16">
      <div class="flex items-center gap-2">
        <a href="/" class="text-xl font-bold text-brand-600">CrewBrief</a>
      </div>
      <div class="hidden md:flex items-center gap-8 text-sm font-medium text-slate-600">
        <a href="/" class="hover:text-brand-600 transition-colors">Home</a>
        <a href="/blog" class="text-brand-600 hover:text-brand-700 transition-colors">Blog</a>
        <a href="/" class="inline-flex items-center px-4 py-2 rounded-lg bg-brand-600 text-white font-semibold hover:bg-brand-700 transition-colors text-sm">Join Waitlist</a>
      </div>
    </div>
  </div>
</nav>

${params.body}

<footer class="bg-slate-900 text-slate-400 py-16">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="grid sm:grid-cols-4 gap-8 mb-12">
      <div>
        <h4 class="text-white font-semibold mb-4">Product</h4>
        <ul class="space-y-2 text-sm">
          <li><a href="/" class="hover:text-white transition-colors">Home</a></li>
          <li><a href="/faq" class="hover:text-white transition-colors">FAQ</a></li>
        </ul>
      </div>
      <div>
        <h4 class="text-white font-semibold mb-4">Company</h4>
        <ul class="space-y-2 text-sm">
          <li><a href="/" class="hover:text-white transition-colors">About</a></li>
          <li><a href="/blog" class="hover:text-white transition-colors">Blog</a></li>
        </ul>
      </div>
      <div>
        <h4 class="text-white font-semibold mb-4">Legal</h4>
        <ul class="space-y-2 text-sm">
          <li><a href="/privacy" class="hover:text-white transition-colors">Privacy Policy</a></li>
          <li><a href="/terms" class="hover:text-white transition-colors">Terms of Service</a></li>
        </ul>
      </div>
      <div>
        <h4 class="text-white font-semibold mb-4">Contact</h4>
        <ul class="space-y-2 text-sm">
          <li><a href="mailto:help@crewbrief.com" class="hover:text-white transition-colors">help@crewbrief.com</a></li>
          <li><a href="https://linkedin.com/company/crewbrief" class="hover:text-white transition-colors" target="_blank" rel="noopener">LinkedIn</a></li>
        </ul>
      </div>
    </div>
    <div class="border-t border-slate-800 pt-8 text-sm text-center">
      &copy; 2026 CrewBrief Operations
    </div>
  </div>
</footer>

</body>
</html>`;
}

export function createBlogService() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // Resolve relative to server/crewbrief-blog/ (works from both src/services/ and dist/services/)
  const blogDir = path.resolve(__dirname, "../../crewbrief-blog");

  let posts: BlogPost[] | null = null;

  function loadPosts(): BlogPost[] {
    if (posts) return posts;

    if (!fs.existsSync(blogDir)) {
      return [];
    }

    const files = fs.readdirSync(blogDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    posts = files.map((file) => {
      const raw = fs.readFileSync(path.join(blogDir, file), "utf-8");
      const parsed = parseFrontmatter(raw);

      if (!parsed) {
        const titleRaw = file.replace(/\.md$/, "").replace(/-/g, " ");
        const slug = file.replace(/\.md$/, "");
        return {
          slug,
          title: titleRaw.charAt(0).toUpperCase() + titleRaw.slice(1),
          description: "",
          date: "",
          author: "CrewBrief",
          readingTime: "",
          tags: [],
          keywords: [],
          canonical: `https://crewbrief.avva.aero/blog/${slug}`,
          ogImage: "",
          html: renderMarkdown(raw),
          wordCount: raw.split(/\s+/).length,
        };
      }

      const fm = parsed.frontmatter;
      const slug = fm.slug || file.replace(/\.md$/, "");

      return {
        slug,
        title: fm.title || slug.replace(/-/g, " "),
        description: fm.description || "",
        date: fm.date || "",
        author: fm.author || "CrewBrief",
        readingTime: fm.readingTime || "",
        tags: fm.tags || [],
        keywords: fm.keywords || [],
        canonical: fm.canonical || `https://crewbrief.avva.aero/blog/${slug}`,
        ogImage: fm.ogImage || "",
        html: renderMarkdown(parsed.content),
        wordCount: parsed.content.split(/\s+/).length,
      };
    });

    posts.sort((a, b) => {
      if (a.date && b.date) return new Date(b.date).getTime() - new Date(a.date).getTime();
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });

    return posts;
  }

  function getPost(slug: string): BlogPost | undefined {
    return loadPosts().find((p) => p.slug === slug);
  }

  function generateBlogIndexHtml(): string {
    const allPosts = loadPosts();

    const postsList = allPosts
      .map((post) => {
        const dateFormatted = post.date
          ? new Date(post.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
          : "";
        return `<article class="border-b border-slate-100 pb-8 mb-8">
  <div class="flex items-center gap-3 text-sm text-slate-500 mb-2">
    ${post.date ? `<time datetime="${post.date}">${dateFormatted}</time>` : ""}
    ${post.readingTime ? `<span>\u00b7 ${post.readingTime}</span>` : ""}
  </div>
  <h2 class="text-xl font-bold text-slate-900 mb-2">
    <a href="/blog/${post.slug}" class="hover:text-brand-600 transition-colors">${escapeHtml(post.title)}</a>
  </h2>
  <p class="text-slate-600 leading-relaxed mb-4">${escapeHtml(post.description)}</p>
  <a href="/blog/${post.slug}" class="text-brand-600 font-medium text-sm hover:text-brand-700 transition-colors">Read more \u2192</a>
</article>`;
      })
      .join("\n");

    return blogPageHtml({
      title: "CrewBrief Blog \u2014 Aviation Operations Insights",
      description:
        "Expert analysis on crew briefing automation, flight operations metrics, aviation compliance, and safety management systems for Part 91 and Part 135 operators.",
      canonical: "https://crewbrief.avva.aero/blog",
      ogTitle: "CrewBrief Blog \u2014 Aviation Operations Insights",
      ogDescription:
        "Expert analysis on crew briefing automation, flight operations metrics, and aviation safety.",
      ogUrl: "https://crewbrief.avva.aero/blog",
      body: `<section class="py-20 lg:py-28 bg-slate-50 min-h-screen">
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="mb-12 text-center">
      <h1 class="text-4xl sm:text-5xl font-extrabold text-slate-900 mb-4">CrewBrief Blog</h1>
      <p class="text-lg text-slate-600 max-w-2xl mx-auto">Aviation operations insights, compliance guides, and best practices for modern flight crews.</p>
    </div>
    <div class="max-w-3xl mx-auto">
      ${postsList || '<p class="text-slate-500 text-center py-12">No posts yet. Check back soon.</p>'}
    </div>
  </div>
</section>`,
    });
  }

  function generateBlogPostHtml(slug: string): string | null {
    const post = getPost(slug);
    if (!post) return null;

    const dateFormatted = post.date
      ? new Date(post.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
      : "";

    const tagHtml =
      post.tags.length > 0
        ? `<div class="flex flex-wrap gap-2 mb-6">${post.tags
            .map(
              (t) =>
                `<span class="px-3 py-1 bg-brand-50 text-brand-700 text-xs font-medium rounded-full">${escapeHtml(t)}</span>`,
            )
            .join("")}</div>`
        : "";

    const metaHtml = `<p class="text-sm text-slate-500 mb-6">${dateFormatted}${post.readingTime ? ` \u00b7 ${post.readingTime}` : ""}</p>`;

    const body = `<article class="py-20 lg:py-28 bg-white min-h-screen">
  <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="mb-6">
      <a href="/blog" class="text-brand-600 text-sm font-medium hover:text-brand-700 transition-colors">&larr; Back to Blog</a>
    </div>
    ${tagHtml}
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 leading-tight mb-6">${escapeHtml(post.title)}</h1>
    ${metaHtml}
    <div class="text-slate-700 leading-relaxed">
      ${post.html}
    </div>
    <hr class="my-12 border-slate-200" />
    <div class="bg-slate-50 rounded-2xl p-8 text-center">
      <h3 class="text-xl font-bold text-slate-900 mb-2">Ready to streamline your crew briefings?</h3>
      <p class="text-slate-600 mb-6">CrewBrief delivers polished, operationally complete briefings automatically before every duty.</p>
      <a href="/" class="inline-flex items-center px-6 py-3 rounded-xl bg-brand-600 text-white font-semibold hover:bg-brand-700 transition-colors">Get Early Access \u2192</a>
    </div>
  </div>
</article>`;

    return blogPageHtml({
      title: `${post.title} \u2014 CrewBrief Blog`,
      description: post.description,
      canonical: post.canonical,
      ogTitle: post.title,
      ogDescription: post.description,
      ogUrl: post.canonical,
      body,
    });
  }

  function generateBlogNotFoundHtml(): string {
    return blogPageHtml({
      title: "Blog Post Not Found \u2014 CrewBrief",
      description: "The requested blog post could not be found.",
      canonical: "https://crewbrief.avva.aero/blog",
      ogTitle: "Blog Post Not Found \u2014 CrewBrief",
      ogDescription: "The requested blog post could not be found.",
      ogUrl: "https://crewbrief.avva.aero/blog",
      body: `<section class="py-20 lg:py-28 bg-slate-50 min-h-screen flex items-center">
  <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
    <h1 class="text-4xl font-extrabold text-slate-900 mb-4">Post Not Found</h1>
    <p class="text-lg text-slate-600 mb-8">The blog post you're looking for doesn't exist or may have been moved.</p>
    <a href="/blog" class="inline-flex items-center px-6 py-3 rounded-xl bg-brand-600 text-white font-semibold hover:bg-brand-700 transition-colors">&larr; Back to Blog</a>
  </div>
</section>`,
    });
  }

  return {
    getAllPosts: loadPosts,
    getPost,
    generateBlogIndexHtml,
    generateBlogPostHtml,
    generateBlogNotFoundHtml,
  };
}

export type BlogService = ReturnType<typeof createBlogService>;
