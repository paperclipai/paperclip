import { Shield } from "lucide-react";

export function SecurityPage() {
  return (
    <div className="min-h-screen bg-background px-4 py-16">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-center gap-3">
          <div className="rounded-md border border-border bg-muted/30 p-2">
            <Shield className="h-5 w-5 text-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Responsible Disclosure</h1>
            <p className="text-sm text-muted-foreground">3vo.ai security contact and policy</p>
          </div>
        </div>

        <div className="space-y-6 text-sm text-foreground">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 font-semibold">How to report a vulnerability</h2>
            <p className="text-muted-foreground">
              Send a detailed report to{" "}
              <a
                href="mailto:security@3vo.ai"
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                security@3vo.ai
              </a>
              . Email is the only accepted channel. Do not open public GitHub issues or social media
              posts for security vulnerabilities.
            </p>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 font-semibold">What to include</h2>
            <ul className="space-y-1.5 text-muted-foreground">
              <li className="flex gap-2">
                <span className="mt-0.5 text-foreground">—</span>
                <span>Description of the vulnerability and its potential impact</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-foreground">—</span>
                <span>Steps to reproduce, including affected URL or endpoint</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-foreground">—</span>
                <span>Proof-of-concept code or screenshots if applicable</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-foreground">—</span>
                <span>Your name or handle for acknowledgment (optional)</span>
              </li>
            </ul>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 font-semibold">What to expect</h2>
            <ul className="space-y-1.5 text-muted-foreground">
              <li className="flex gap-2">
                <span className="mt-0.5 text-foreground">—</span>
                <span>Acknowledgment within 24 hours</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-foreground">—</span>
                <span>Status update within 7 days confirming severity and next steps</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-foreground">—</span>
                <span>Fix target of 30 days for confirmed vulnerabilities</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-foreground">—</span>
                <span>
                  If a fix takes longer than 30 days, we will notify you and coordinate on public
                  disclosure timing
                </span>
              </li>
            </ul>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 font-semibold">Our commitment</h2>
            <ul className="space-y-1.5 text-muted-foreground">
              <li className="flex gap-2">
                <span className="mt-0.5 text-foreground">—</span>
                <span>We will not take legal action against researchers who act in good faith</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-foreground">—</span>
                <span>We will not publicly disclose your report without your consent</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-foreground">—</span>
                <span>
                  Please give us time to fix before disclosing publicly — coordinated disclosure
                  protects everyone
                </span>
              </li>
            </ul>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 font-semibold">Thank you</h2>
            <p className="text-muted-foreground">
              Security researchers who help keep 3vo.ai safe do real work that matters. We
              appreciate the time and skill it takes to find and responsibly report issues. If you
              want acknowledgment, we will include you on our acknowledgments page once a fix ships.
            </p>
          </section>

          <div className="rounded-md border border-border bg-muted/20 px-4 py-3 font-mono text-xs text-muted-foreground">
            <p>
              /.well-known/security.txt is available at{" "}
              <a
                href="/.well-known/security.txt"
                className="text-foreground underline-offset-4 hover:underline"
              >
                /.well-known/security.txt
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
