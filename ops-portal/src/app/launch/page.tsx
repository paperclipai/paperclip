// This page is the post-login landing.  The middleware guarantees the user is
// authenticated and has the operator role before they get here.
//
// It immediately calls /api/session to mint the Caddy JWT and redirect to
// app.ops.binelek.io.  Using a meta refresh as a fallback in case JS is off.
export const metadata = { title: 'Launching — Jaban Universe' };

export default function LaunchPage() {
  return (
    <>
      {/* Instant redirect via meta refresh (no-JS fallback) */}
      <meta httpEquiv="refresh" content="0;url=/api/session" />

      <main className="min-h-full flex items-center justify-center">
        <div className="text-center flex flex-col gap-4">
          <p className="text-nova-400 text-sm tracking-widest uppercase animate-pulse">
            Launching
          </p>
          <p className="text-white/30 text-xs">
            Establishing secure session&hellip;
          </p>
          {/* JS redirect */}
          <script
            dangerouslySetInnerHTML={{
              __html: `window.location.href = '/api/session';`,
            }}
          />
        </div>
      </main>
    </>
  );
}
