export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 text-neutral-100 p-8">
      <div className="max-w-xl text-center space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">Marketing Asset Library</h1>
        <p className="text-neutral-400">
          Coming soon — review, approve, and ship marketing assets here.
        </p>
        <p className="text-xs text-neutral-600">
          Backing source: Paperclip <code>[review-and-ship]</code> issues.
        </p>
      </div>
    </main>
  );
}
