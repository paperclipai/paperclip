import { signIn, auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Sign In — Jaban Universe' };

// The JU mark: a bordered square with initials, text-only, no images.
function JabanMark() {
  return (
    <div className="flex flex-col items-center gap-4 select-none">
      {/* Text mark */}
      <div className="relative inline-flex items-center justify-center">
        <div
          className="
            w-16 h-16
            border-2 border-nova-500
            flex items-center justify-center
            text-nova-400 text-2xl font-bold tracking-tight
          "
          aria-hidden="true"
        >
          JU
        </div>
        {/* Corner accents */}
        <span className="absolute -top-[3px] -left-[3px] w-2 h-2 border-t-2 border-l-2 border-star-500" />
        <span className="absolute -top-[3px] -right-[3px] w-2 h-2 border-t-2 border-r-2 border-star-500" />
        <span className="absolute -bottom-[3px] -left-[3px] w-2 h-2 border-b-2 border-l-2 border-star-500" />
        <span className="absolute -bottom-[3px] -right-[3px] w-2 h-2 border-b-2 border-r-2 border-star-500" />
      </div>

      <div className="text-center">
        <p className="text-white tracking-[0.3em] uppercase text-sm font-semibold">
          Jaban Universe
        </p>
        <p className="text-void-800 text-xs tracking-widest uppercase mt-1 text-white/30">
          Operations Portal
        </p>
      </div>
    </div>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session?.user != null) {
    redirect('/launch');
  }

  const params = await searchParams;
  const hasError = params.error != null;

  return (
    <main className="min-h-full flex items-center justify-center px-4">
      {/* Ambient glow */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden"
        aria-hidden="true"
      >
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full bg-nova-600/10 blur-3xl animate-pulse-slow" />
        <div className="absolute bottom-1/4 left-1/3 w-64 h-64 rounded-full bg-star-500/5 blur-3xl animate-pulse-slow" />
      </div>

      <div className="relative z-10 w-full max-w-sm">
        {/* Card */}
        <div className="border border-white/10 bg-void-900/80 backdrop-blur-sm px-8 py-10 flex flex-col gap-8">
          <JabanMark />

          <div className="flex flex-col gap-3">
            {hasError && (
              <p className="text-center text-red-400 text-xs border border-red-500/30 bg-red-500/10 px-3 py-2">
                Authentication failed. Please try again.
              </p>
            )}

            {/* Sign-in form — uses Auth.js server action */}
            <form
              action={async () => {
                'use server';
                await signIn('zitadel', { redirectTo: '/launch' });
              }}
            >
              <button
                type="submit"
                className="
                  w-full
                  bg-nova-600 hover:bg-nova-500
                  text-white text-sm font-semibold tracking-wider uppercase
                  px-4 py-3
                  transition-colors duration-150
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-nova-400
                "
              >
                Sign In
              </button>
            </form>

            <p className="text-center text-white/30 text-xs tracking-wide">
              Multi-factor authentication required.
            </p>
          </div>

          <div className="border-t border-white/5 pt-4 text-center">
            <p className="text-white/20 text-[10px] tracking-widest uppercase">
              Authorized users only
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
