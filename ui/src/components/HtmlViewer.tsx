import { useMemo } from "react";
import { cn } from "../lib/utils";

interface HtmlViewerProps {
  html: string;
  className?: string;
  title?: string;
}

export function HtmlViewer({ html, className, title }: HtmlViewerProps) {
  const srcDoc = useMemo(() => {
    return `
<!DOCTYPE html>
<html>
<head>
  <base target="_blank">
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      color: #e1e4ed;
      background: #0f1117;
      margin: 0;
      padding: 20px;
      font-size: 14px;
    }
    
    h1, h2, h3, h4, h5, h6 {
      color: #a29bfe;
      margin-top: 24px;
      margin-bottom: 12px;
      font-weight: 600;
    }
    h1 { font-size: 28px; border-bottom: 1px solid #2a2d3e; padding-bottom: 8px; }
    h2 { font-size: 22px; }
    h3 { font-size: 18px; }
    h4 { font-size: 16px; }
    
    p { margin: 0 0 12px 0; }
    
    a { color: #74b9ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    
    code {
      background: #1c1f2e;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 12px;
      color: #ff79c6;
    }
    
    pre {
      background: #1c1f2e;
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      border: 1px solid #2a2d3e;
      margin: 16px 0;
    }
    
    pre code {
      background: transparent;
      padding: 0;
      color: #e1e4ed;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
    }
    th, td {
      padding: 8px 12px;
      border: 1px solid #2a2d3e;
      text-align: left;
    }
    th {
      background: #161922;
      font-weight: 600;
    }
    tr:nth-child(even) { background: #161922; }
    
    blockquote {
      border-left: 3px solid #6c5ce7;
      margin: 16px 0;
      padding-left: 16px;
      color: #8b8fa3;
    }
    
    img { max-width: 100%; height: auto; }
    
    ul, ol {
      margin: 12px 0;
      padding-left: 24px;
    }
    
    li { margin: 4px 0; }
    
    hr {
      border: none;
      border-top: 1px solid #2a2d3e;
      margin: 24px 0;
    }
    
    svg { max-width: 100%; }
  </style>
</head>
<body>${html}</body>
</html>
    `.trim();
  }, [html]);

  return (
    <div className={cn("rounded-lg border border-border overflow-hidden bg-[#0f1117]", className)}>
      {title && (
        <div className="px-4 py-2 bg-secondary border-b border-border flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">{title}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30">HTML</span>
        </div>
      )}
      <iframe
        srcDoc={srcDoc}
        className="w-full min-h-[400px] bg-transparent"
        sandbox="allow-same-origin"
        title={title || "HTML Document"}
      />
    </div>
  );
}
