import type { Metadata } from "next";
import "./globals.css";
import Nav from "./components/Nav";
import ChunkErrorBanner from "./components/ChunkErrorBanner";

export const metadata: Metadata = {
  title: "Marketing Asset Library",
  description: "Review and approve marketing assets — Paperclip [review-and-ship] queue.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased bg-neutral-950 text-neutral-100 min-h-screen overflow-x-hidden">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
          <header className="mb-6">
            <h1 className="text-xl font-semibold tracking-tight text-white mb-1">
              OpenRunner · Marketing Asset Library
            </h1>
            <p className="text-xs text-neutral-500">
              Internal review surface — <a href="http://127.0.0.1:7700/" className="underline hover:text-neutral-300">http://127.0.0.1:7700/</a>
            </p>
          </header>
          <Nav />
          <ChunkErrorBanner />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
