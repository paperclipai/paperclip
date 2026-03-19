import Link from "next/link";
import { HeroHeadline } from "@/components/HeroHeadline";
import { BrandMockup } from "@/components/BrandMockup";
import { ParticleField } from "@/components/ParticleField";
import { CursorSpotlight } from "@/components/CursorSpotlight";
import { LiveDemo } from "@/components/LiveDemo";
import { ScrollReveal } from "@/components/ScrollReveal";
import { WaitlistForm } from "@/components/WaitlistForm";
import { CompetitorComparison } from "@/components/CompetitorComparison";

/* ── Data ── */

const steps = [
  {
    number: "01",
    title: "Describe your vision",
    description:
      "Share your business name, industry, target audience, and brand vibe. 5-minute questionnaire, no design experience needed.",
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
      </svg>
    ),
  },
  {
    number: "02",
    title: "AI generates your brand",
    description:
      "AI generates logo concepts, color palettes, and typography pairs. Pick your favorites, regenerate until it feels right.",
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
      </svg>
    ),
  },
  {
    number: "03",
    title: "Download your kit",
    description:
      "Download SVG, PNG, PDF, CSS, JSON. Use on your website, social media, and print. All files are yours forever.",
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
    ),
  },
];

const features = [
  {
    title: "AI Logo Generator",
    description:
      "Logo that works everywhere. Get variations for dark mode, app icons, social media, and print — no designer needed.",
    highlight: true,
    color: "var(--primary)",
  },
  {
    title: "Color Palette",
    description:
      "Instant visual cohesion. Primary, secondary, and accent colors ready for web and print — no color theory required.",
    highlight: false,
    color: "var(--accent-pink)",
  },
  {
    title: "Typography",
    description: "Font pairings that set the right tone. Matched to your brand personality, ready to use in any design tool.",
    highlight: false,
    color: "var(--accent-cyan)",
  },
  {
    title: "Brand Guidelines",
    description:
      "Consistency across every touchpoint. Share one style guide with your team, clients, and contractors — everyone stays on brand.",
    highlight: false,
    color: "var(--accent-lime)",
  },
  {
    title: "Social Templates",
    description:
      "Post with confidence. Ready-to-use templates for Instagram, Twitter, LinkedIn — consistent with your new brand from day one.",
    highlight: false,
    color: "var(--primary)",
  },
  {
    title: "Export Everything",
    description:
      "Use immediately, no technical skills required. SVG for web, PNG for social, PDF for print — paste into your site, socials, or print vendor.",
    highlight: false,
    color: "var(--accent-pink)",
  },
];

const testimonials = [
  {
    quote:
      "I spent 6 weeks and $800 with a designer for my photography brand. diybrand gave me something better in 15 minutes for $49. My clients now think I hired an agency.",
    name: "Sarah Martinez",
    role: "Freelance Photographer",
    image: "/testimonials/sarah-martinez.svg",
  },
  {
    quote:
      "I was skeptical about AI branding, but the quality was undeniable. My Etsy shop rebranded with diybrand in one afternoon ($19). Sales jumped 20% the next month—actual numbers, not hype.",
    name: "James Kim",
    role: "Etsy Shop Owner",
    image: "/testimonials/james-kim.svg",
  },
  {
    quote:
      "As a founder and developer, I can't design. diybrand gave me a complete brand identity in one afternoon ($49). The color palette and typography made my landing page 10x more polished. Launched my SaaS with confidence.",
    name: "Priya Desai",
    role: "SaaS Founder",
    image: "/testimonials/priya-desai.svg",
  },
  {
    quote:
      "Launched my side project over a weekend. Normally that means no branding until month 3. diybrand's kit made everything look professional from day one—landing page, socials, pitch deck. Investors noticed.",
    name: "Alex Torres",
    role: "Indie Hacker",
    image: "/testimonials/alex-torres.svg",
  },
  {
    quote:
      "I spend 15+ hours a week on Instagram. The social templates save me hours every single week, and my brand looks intentional now instead of scattered. Best $49 I've ever spent on tools.",
    name: "Maria Lindgren",
    role: "Bakery Owner & Content Creator",
    image: "/testimonials/maria-lindgren.svg",
  },
  {
    quote:
      "Hired a designer once—took weeks and cost thousands. I tried DIY tools, nothing worked. Then diybrand. 10 minutes, $49, and I had a professional identity. My personal brand website went from 'side project' to 'real business' overnight.",
    name: "Chen Wei",
    role: "Consultant & Freelancer",
    image: "/testimonials/chen-wei.svg",
  },
];

const pricingTiers = [
  {
    name: "Basic",
    price: "$19",
    features: [
      "Logo files (PNG)",
      "Color palette (CSS, JSON, HTML)",
      "Typography guide",
    ],
  },
  {
    name: "Premium",
    price: "$49",
    popular: true,
    features: [
      "Everything in Basic",
      "SVG logo + variations",
      "Social media templates",
      "Business card mockup",
      "Brand guidelines PDF",
    ],
  },
];

const tickerBrands = [
  "Bloom & Root",
  "Vektora",
  "Maple & Co",
  "NovaPulse",
  "Zenith Labs",
  "Pixel & Grain",
  "Solaris",
  "Drift Studio",
  "Oakhaven",
  "Lucent",
];

/* ── Page ── */

export default function Home() {
  return (
    <main id="main-content" className="relative min-h-screen overflow-hidden">
      <ParticleField />
      <CursorSpotlight />

      {/* ─── Hero ─── */}
      <section className="aurora-bg relative z-10 flex min-h-screen flex-col items-center justify-center px-6 pt-20 pb-12 lg:flex-row lg:gap-16 lg:px-16">
        <div className="max-w-2xl text-center lg:text-left">
          <p className="mb-6 inline-block rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] px-4 py-1.5 font-[var(--font-mono)] text-sm text-[var(--accent-cyan)]">
            One-time payment — no subscriptions
          </p>
          <HeroHeadline />
          <p className="mt-6 max-w-xl text-lg text-[var(--text-muted)] sm:text-xl">
            Answer a short questionnaire. AI generates your logo, colors,
            typography, and guidelines. Own all files. One-time payment — no
            monthly subscriptions.
          </p>
          <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row lg:justify-start">
            <Link
              href="/questionnaire"
              className="cta-glow inline-flex items-center rounded-xl bg-[var(--primary)] px-8 py-4 text-base font-semibold text-white transition-all"
            >
              Get My Brand Kit
              <svg
                className="ml-2 h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"
                />
              </svg>
            </Link>
            <span className="text-sm text-[var(--text-muted)]">
              No credit card required
            </span>
          </div>
          <div className="mt-6 flex w-full justify-center lg:justify-start">
            <WaitlistForm />
          </div>
        </div>
        <div className="mt-12 lg:mt-0">
          <BrandMockup />
        </div>
      </section>

      {/* ─── Logo Ticker ─── */}
      <section className="relative z-10 border-y border-[var(--glass-border)] bg-[var(--bg-surface)] py-4 overflow-hidden">
        <div className="flex items-center gap-6">
          <div className="ticker-track flex shrink-0 items-center gap-6">
            {[...tickerBrands, ...tickerBrands].map((brand, i) => (
              <span
                key={`${brand}-${i}`}
                className="whitespace-nowrap font-[var(--font-space)] text-sm font-bold text-[var(--text-muted)]/40"
              >
                {brand}
              </span>
            ))}
          </div>
          <div className="ticker-track flex shrink-0 items-center gap-6" aria-hidden>
            {[...tickerBrands, ...tickerBrands].map((brand, i) => (
              <span
                key={`${brand}-dup-${i}`}
                className="whitespace-nowrap font-[var(--font-space)] text-sm font-bold text-[var(--text-muted)]/40"
              >
                {brand}
              </span>
            ))}
          </div>
        </div>
        <div className="absolute right-6 top-1/2 -translate-y-1/2">
          <span className="font-[var(--font-mono)] text-xs text-[var(--accent-cyan)]">
            2,847+ brands created
          </span>
        </div>
      </section>

      {/* ─── How It Works ─── */}
      <section className="relative z-10 px-6 py-24 sm:py-32">
        <ScrollReveal className="mx-auto max-w-4xl text-center">
          <h2 className="font-[var(--font-space)] text-3xl font-bold sm:text-4xl">
            How it works
          </h2>
          <p className="mt-4 text-lg text-[var(--text-muted)]">
            Three simple steps from idea to brand kit.
          </p>
        </ScrollReveal>
        <div className="mx-auto mt-16 grid max-w-5xl gap-6 sm:grid-cols-3">
          {steps.map((step, i) => (
            <ScrollReveal key={step.number} delay={i * 0.15}>
              <div className="glass neon-glow group relative flex flex-col items-center rounded-2xl p-8 text-center transition-all">
                <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--primary)]/20 text-[var(--primary)] transition-colors group-hover:bg-[var(--primary)]/30">
                  {step.icon}
                </div>
                <span className="mt-4 font-[var(--font-mono)] text-xs text-[var(--accent-cyan)]">
                  Step {step.number}
                </span>
                <h3 className="mt-2 text-lg font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm text-[var(--text-muted)]">
                  {step.description}
                </p>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </section>

      {/* ─── Features (Bento Grid) ─── */}
      <section className="relative z-10 bg-[var(--bg-surface)] px-6 py-24 sm:py-32">
        <ScrollReveal className="mx-auto max-w-4xl text-center">
          <h2 className="font-[var(--font-space)] text-3xl font-bold sm:text-4xl">
            Everything you need to launch
          </h2>
          <p className="mt-4 text-lg text-[var(--text-muted)]">
            A complete brand kit, generated in seconds.
          </p>
        </ScrollReveal>
        <div className="mx-auto mt-16 grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature, i) => (
            <ScrollReveal
              key={feature.title}
              delay={i * 0.08}
              className={feature.highlight ? "sm:col-span-2" : ""}
            >
              <div
                className={`glass neon-glow group h-full rounded-2xl p-6 transition-all ${
                  feature.highlight ? "border-[var(--primary)]/30" : ""
                }`}
              >
                <div
                  className="mb-3 h-1 w-10 rounded-full"
                  style={{ backgroundColor: feature.color }}
                />
                <h3 className="text-lg font-semibold">
                  {feature.title}
                  {feature.highlight && (
                    <span className="ml-2 rounded-md bg-[var(--primary)]/20 px-2 py-0.5 font-[var(--font-mono)] text-xs text-[var(--primary)]">
                      Popular
                    </span>
                  )}
                </h3>
                <p className="mt-2 text-sm text-[var(--text-muted)]">
                  {feature.description}
                </p>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </section>

      {/* ─── Live Demo ─── */}
      <section className="relative z-10 px-6 py-24 sm:py-32">
        <ScrollReveal className="mx-auto max-w-4xl text-center">
          <h2 className="font-[var(--font-space)] text-3xl font-bold sm:text-4xl">
            Try it <span className="gradient-text">right now</span>
          </h2>
          <p className="mt-4 text-lg text-[var(--text-muted)]">
            See it in 30 seconds. Type your business name and industry, and watch AI generate logo concepts and color palettes live.
          </p>
        </ScrollReveal>
        <div className="mt-16">
          <LiveDemo />
        </div>
      </section>

      {/* ─── Pricing ─── */}
      <section className="relative z-10 bg-[var(--bg-surface)] px-6 py-24 sm:py-32">
        <ScrollReveal className="mx-auto max-w-4xl text-center">
          <h2 className="font-[var(--font-space)] text-3xl font-bold sm:text-4xl">
            Early access pricing — lock in before we raise.
          </h2>
          <p className="mt-4 text-lg text-[var(--text-muted)]">
            All files are yours to keep — no subscriptions, no license restrictions. Today&apos;s price won&apos;t last.
          </p>
        </ScrollReveal>
        <div className="mx-auto mt-16 grid max-w-2xl gap-6 sm:grid-cols-2">
          {pricingTiers.map((tier, i) => (
            <ScrollReveal key={tier.name} delay={i * 0.15}>
              <div
                className={`glass neon-glow relative rounded-2xl p-8 transition-all ${
                  tier.popular
                    ? "border border-[var(--primary)]/50 shadow-[0_0_40px_#8b5cf620]"
                    : ""
                }`}
              >
                {tier.popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[var(--primary)] px-4 py-1 text-xs font-semibold text-white shadow-[0_0_20px_#8b5cf650]">
                    Most Popular
                  </span>
                )}
                <h3 className="text-lg font-bold">{tier.name}</h3>
                <p className="mt-3 text-4xl font-bold">
                  {tier.price}
                  <span className="text-sm font-normal text-[var(--text-muted)]">
                    {" "}
                    one-time
                  </span>
                </p>
                <ul className="mt-6 space-y-3">
                  {tier.features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-start gap-2 text-sm text-[var(--text-muted)]"
                    >
                      <svg
                        className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-lime)]"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={2}
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4.5 12.75l6 6 9-13.5"
                        />
                      </svg>
                      {feature}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/questionnaire"
                  className={`mt-6 block w-full rounded-xl py-3 text-center text-sm font-semibold transition-all ${
                    tier.popular
                      ? "cta-glow bg-[var(--primary)] text-white"
                      : "glass text-[var(--text-primary)] hover:bg-white/10"
                  }`}
                >
                  Get started
                </Link>
              </div>
            </ScrollReveal>
          ))}
        </div>
        <div className="mx-auto mt-10 flex flex-col items-center gap-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--accent-lime)]/30 bg-[var(--accent-lime)]/10 px-5 py-2">
            <svg className="h-5 w-5 text-[var(--accent-lime)]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
            <span className="text-sm font-semibold text-[var(--accent-lime)]">
              30-day money-back guarantee. No questions asked.
            </span>
          </div>
          <p className="text-center text-sm text-[var(--text-muted)]">
            Review your brand kit for free. Only pay if you love it.
          </p>
        </div>
      </section>

      {/* ─── Competitor Comparison ─── */}
      <section className="relative z-10 px-6 py-24 sm:py-32">
        <ScrollReveal className="mx-auto max-w-4xl text-center">
          <h2 className="font-[var(--font-space)] text-3xl font-bold sm:text-4xl">
            Why pay monthly when you can{" "}
            <span className="gradient-text">own it forever?</span>
          </h2>
          <p className="mt-4 text-lg text-[var(--text-muted)]">
            Compare the cost of DIYBrand to alternatives. One payment, all files yours to keep.
          </p>
        </ScrollReveal>
        <div className="mt-16">
          <ScrollReveal delay={0.2}>
            <CompetitorComparison />
          </ScrollReveal>
        </div>
      </section>

      {/* ─── Testimonials ─── */}
      <section className="relative z-10 overflow-hidden px-6 py-24 sm:py-32">
        <ScrollReveal className="mx-auto max-w-4xl text-center">
          <h2 className="font-[var(--font-space)] text-3xl font-bold sm:text-4xl">
            Loved by small business owners
          </h2>
          <p className="mt-4 text-lg text-[var(--text-muted)]">
            Join thousands of founders who built their brand with diybrand.app.
          </p>
        </ScrollReveal>
        <div className="mt-16 overflow-hidden">
          <div className="testimonial-scroll flex gap-6">
            {[...testimonials, ...testimonials].map((t, i) => (
              <div
                key={`${t.name}-${i}`}
                className="glass neon-glow w-80 shrink-0 rounded-2xl p-6"
              >
                {/* Star rating */}
                <div className="star-neon flex gap-0.5" aria-label="5 out of 5 stars">
                  {Array.from({ length: 5 }).map((_, j) => (
                    <svg
                      key={j}
                      className="h-5 w-5"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                  ))}
                </div>
                <blockquote className="mt-4 text-sm text-[var(--text-muted)]">
                  &ldquo;{t.quote}&rdquo;
                </blockquote>
                <div className="mt-4 flex items-center gap-3 border-t border-[var(--glass-border)] pt-4">
                  {t.image && (
                    <img
                      src={t.image}
                      alt={t.name}
                      className="h-10 w-10 rounded-full object-cover"
                    />
                  )}
                  <div>
                    <p className="font-semibold text-[var(--text-primary)]">
                      {t.name}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">{t.role}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Final CTA ─── */}
      <section className="aurora-bg relative z-10 px-6 py-24 text-center sm:py-32">
        <ScrollReveal>
          <h2 className="font-[var(--font-space)] text-3xl font-bold sm:text-5xl">
            Stop looking for a designer. Start your brand today.
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-lg text-[var(--text-muted)]">
            Answer a questionnaire, pick your favorites, download and keep. Early
            access pricing, all yours. No design skills needed.
          </p>
          <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Link
              href="/questionnaire"
              className="cta-glow inline-flex items-center rounded-xl bg-[var(--primary)] px-8 py-4 text-base font-semibold text-white transition-all"
            >
              Get My Brand Kit
              <svg
                className="ml-2 h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"
                />
              </svg>
            </Link>
            <span className="text-sm text-[var(--text-muted)]">or</span>
            <WaitlistForm />
          </div>
        </ScrollReveal>
      </section>

      {/* ─── Footer ─── */}
      <footer className="relative z-10 border-t border-[var(--glass-border)] px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <div className="mb-8 grid grid-cols-3 gap-8 text-sm text-[var(--text-muted)]">
            <div>
              <h4 className="font-semibold text-white mb-3">Help</h4>
              <ul className="space-y-2">
                <li><Link href="/faq" className="hover:text-white transition-colors">FAQ</Link></li>
                <li><Link href="/guides" className="hover:text-white transition-colors">How-To Guides</Link></li>
                <li><a href="mailto:support@diybrand.app" className="hover:text-white transition-colors">Email Support</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-white mb-3">Product</h4>
              <ul className="space-y-2">
                <li><a href="#how-it-works" className="hover:text-white transition-colors">How It Works</a></li>
                <li><a href="#features" className="hover:text-white transition-colors">Features</a></li>
                <li><a href="#pricing" className="hover:text-white transition-colors">Pricing</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-white mb-3">Company</h4>
              <ul className="space-y-2">
                <li><Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link></li>
                <li><Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link></li>
                <li><Link href="/refund-policy" className="hover:text-white transition-colors">Refund Policy</Link></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-[var(--glass-border)] pt-8 text-center text-sm text-[var(--text-muted)]">
            &copy; {new Date().getFullYear()} diybrand.app. All rights reserved. Built with love for solopreneurs.
          </div>
        </div>
      </footer>
    </main>
  );
}
