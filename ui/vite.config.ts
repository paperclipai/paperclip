import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  build: {
    chunkSizeWarningLimit: 2600, // Set to accommodate main bundle size after optimizations
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React libraries
          react: ["react", "react-dom"],
          // Lexical editor libraries  
          lexical: ["lexical", "@lexical/link"],
          // Large UI libraries
          ui: ["@mdxeditor/editor", "mermaid"],
          // Router and query libraries
          router: ["react-router-dom", "@tanstack/react-query"],
          // Utility libraries
          utils: ["clsx", "tailwind-merge", "class-variance-authority"],
          // Markdown and content libraries
          markdown: ["react-markdown", "remark-gfm"],
          // Paperclip adapter packages - split into separate chunk for code splitting
          adapters: [
            "@paperclipai/adapter-claude-local",
            "@paperclipai/adapter-codex-local", 
            "@paperclipai/adapter-cursor-local",
            "@paperclipai/adapter-gemini-local",
            "@paperclipai/adapter-openclaw-gateway",
            "@paperclipai/adapter-opencode-local",
            "@paperclipai/adapter-pi-local",
            "@paperclipai/adapter-utils",
            "hermes-paperclip-adapter"
          ],
          // DnD and other large UI component libraries
          dnd: ["@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities"],
          // Radix UI components
          radix: ["@radix-ui/react-slot", "radix-ui"],
          // Icon library
          icons: ["lucide-react"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
});
