'use client';

import Link from 'next/link';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Header */}
      <div className="border-b border-slate-700/50 bg-slate-900/50 backdrop-blur-sm">
        <div className="mx-auto max-w-3xl px-6 py-12">
          <h1 className="text-4xl font-bold text-white mb-2">Privacy Policy</h1>
          <p className="text-slate-400">
            Your privacy is important to us. Here's how we protect your data.
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="prose prose-invert max-w-none space-y-8">
          <div className="rounded-lg bg-slate-800 border border-slate-700 p-8 space-y-6">
            {/* Last Updated */}
            <p className="text-sm text-slate-400">
              Last updated: March 18, 2026
            </p>

            {/* Introduction */}
            <section>
              <h2 className="text-2xl font-bold text-white mb-4">Introduction</h2>
              <p className="text-slate-300 leading-relaxed">
                diybrand.app ("we," "us," "our," or "Company") respects your privacy and is committed to protecting your personal data. This privacy policy explains how we collect, use, and protect your information when you use our website and services.
              </p>
            </section>

            {/* Information We Collect */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Information We Collect</h2>

              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold text-white mb-2">Account Information</h3>
                  <p className="text-slate-300">
                    When you create an account, we collect your email address and any information you provide about yourself (business name, industry, etc.) to generate your brand kit.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-white mb-2">Payment Information</h3>
                  <p className="text-slate-300">
                    Payment is processed by Stripe. We do not store your credit card information. Stripe handles all payment data securely according to PCI-DSS standards.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-white mb-2">Feedback & Survey Data</h3>
                  <p className="text-slate-300">
                    If you submit feedback or participate in surveys, we collect your responses to improve our service. This data is associated with your account.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-white mb-2">Usage Data</h3>
                  <p className="text-slate-300">
                    We collect information about how you interact with our service, including pages visited, features used, and time spent. This helps us understand product usage and identify improvements.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-white mb-2">Device & Browser Information</h3>
                  <p className="text-slate-300">
                    We automatically collect information about your device (browser type, operating system, IP address) to optimize our service and diagnose technical issues.
                  </p>
                </div>
              </div>
            </section>

            {/* How We Use Your Information */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">How We Use Your Information</h2>
              <ul className="text-slate-300 space-y-2 list-disc list-inside">
                <li>To generate your custom brand kit</li>
                <li>To process your payment and send receipts</li>
                <li>To send transactional emails (purchase confirmation, support responses)</li>
                <li>To send onboarding and educational emails</li>
                <li>To respond to your support requests</li>
                <li>To improve our product and service based on usage patterns</li>
                <li>To comply with legal obligations</li>
              </ul>
            </section>

            {/* Data Protection */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Data Protection</h2>
              <p className="text-slate-300 leading-relaxed">
                We use industry-standard encryption (HTTPS/TLS) to protect your data in transit. Your questionnaire answers are stored securely so you can regenerate your brand anytime. We do not sell or share your personal data with third parties except as necessary to provide our service (e.g., Stripe for payments, Google Gemini API for logo generation).
              </p>
            </section>

            {/* Your Rights */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Your Rights</h2>
              <p className="text-slate-300 mb-4 leading-relaxed">
                You have the right to:
              </p>
              <ul className="text-slate-300 space-y-2 list-disc list-inside">
                <li>Access your personal data</li>
                <li>Request deletion of your data</li>
                <li>Opt out of marketing emails</li>
                <li>Request a copy of your data in portable format</li>
                <li>Request correction of inaccurate data</li>
              </ul>
              <p className="text-slate-300 mt-4 leading-relaxed">
                To exercise any of these rights, email us at <a href="mailto:privacy@diybrand.app" className="text-blue-400 hover:text-blue-300">privacy@diybrand.app</a>.
              </p>
            </section>

            {/* Cookies */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Cookies & Tracking</h2>
              <p className="text-slate-300 leading-relaxed">
                We use cookies and similar tracking technologies to enhance your experience, track usage patterns, and prevent fraud. You can disable cookies in your browser settings, but some features may not work properly.
              </p>
            </section>

            {/* Third-Party Services */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Third-Party Services</h2>
              <p className="text-slate-300 mb-4 leading-relaxed">
                We use the following third-party services:
              </p>
              <ul className="text-slate-300 space-y-2 list-disc list-inside">
                <li><strong>Stripe</strong> — Payment processing (PCI-DSS compliant)</li>
                <li><strong>Google Gemini API</strong> — Logo generation (your brand description is sent to generate your logo)</li>
                <li><strong>Vercel</strong> — Hosting and deployment</li>
                <li><strong>Analytics services</strong> — Usage tracking and error monitoring</li>
              </ul>
            </section>

            {/* Changes to Policy */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Changes to This Policy</h2>
              <p className="text-slate-300 leading-relaxed">
                We may update this privacy policy from time to time. We will notify you of any significant changes by posting the new policy on this page and updating the "Last updated" date. Your continued use of our service constitutes acceptance of the updated policy.
              </p>
            </section>

            {/* Contact */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Contact Us</h2>
              <p className="text-slate-300 leading-relaxed">
                If you have questions about this privacy policy or how we handle your data, contact us at:
              </p>
              <div className="mt-4 text-slate-300">
                <p>Email: <a href="mailto:privacy@diybrand.app" className="text-blue-400 hover:text-blue-300">privacy@diybrand.app</a></p>
              </div>
            </section>
          </div>

          {/* Footer Links */}
          <div className="flex gap-4 justify-center flex-wrap">
            <Link href="/terms" className="text-blue-400 hover:text-blue-300">
              Terms of Service
            </Link>
            <Link href="/faq" className="text-blue-400 hover:text-blue-300">
              FAQ
            </Link>
            <Link href="/" className="text-blue-400 hover:text-blue-300">
              Home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
