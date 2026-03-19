'use client';

import Link from 'next/link';

export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Header */}
      <div className="border-b border-slate-700/50 bg-slate-900/50 backdrop-blur-sm">
        <div className="mx-auto max-w-3xl px-6 py-12">
          <h1 className="text-4xl font-bold text-white mb-2">Terms of Service</h1>
          <p className="text-slate-400">
            Please read these terms carefully before using diybrand.app.
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

            {/* Agreement to Terms */}
            <section>
              <h2 className="text-2xl font-bold text-white mb-4">Agreement to Terms</h2>
              <p className="text-slate-300 leading-relaxed">
                By accessing and using diybrand.app, you accept and agree to be bound by the terms and provision of this agreement. If you do not agree to abide by the above, please do not use this service.
              </p>
            </section>

            {/* Use License */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Use License</h2>
              <p className="text-slate-300 leading-relaxed mb-4">
                Permission is granted to temporarily download one copy of the materials (information or software) on diybrand.app for personal, non-commercial transitory viewing only. This is the grant of a license, not a transfer of title, and under this license you may not:
              </p>
              <ul className="text-slate-300 space-y-2 list-disc list-inside">
                <li>Modifying or copying the materials</li>
                <li>Using the materials for any commercial purpose or for any public display</li>
                <li>Attempting to decompile or reverse engineer any software contained on the service</li>
                <li>Removing any copyright or other proprietary notations from the materials</li>
                <li>Transferring the materials to another person or "mirroring" the materials on any other server</li>
              </ul>
            </section>

            {/* Brand Kit Ownership */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Your Brand Kit</h2>
              <p className="text-slate-300 leading-relaxed mb-4">
                Upon purchase, you own all files in your downloaded brand kit (logos, colors, fonts, guidelines, templates). You can use them:
              </p>
              <ul className="text-slate-300 space-y-2 list-disc list-inside mb-4">
                <li>For commercial purposes (your business, client work, etc.)</li>
                <li>On your website, social media, and print materials</li>
                <li>Without any additional fees or royalties</li>
              </ul>
              <p className="text-slate-300 leading-relaxed">
                However, you may not resell, redistribute, or sublicense the brand kit as a product itself. The fonts are from Google Fonts and are licensed under open-source licenses.
              </p>
            </section>

            {/* Disclaimer of Warranties */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Disclaimer of Warranties</h2>
              <p className="text-slate-300 leading-relaxed">
                The materials on diybrand.app are provided on an "as is" basis. diybrand.app makes no warranties, expressed or implied, and hereby disclaims and negates all other warranties including, without limitation, implied warranties or conditions of merchantability, fitness for a particular purpose, or non-infringement of intellectual property or other violation of rights. Further, diybrand.app does not warrant or make any representations concerning the accuracy, likely results, or reliability of the use of the materials on its internet web site or otherwise relating to such materials or on any sites linked to this site.
              </p>
            </section>

            {/* Limitations of Liability */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Limitations of Liability</h2>
              <p className="text-slate-300 leading-relaxed">
                In no event shall diybrand.app or its suppliers be liable for any damages (including, without limitation, damages for loss of data or profit, or due to business interruption) arising out of the use or inability to use the materials on diybrand.app, even if diybrand.app or an authorized representative has been notified orally or in writing of the possibility of such damage.
              </p>
            </section>

            {/* Accuracy of Materials */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Accuracy of Materials</h2>
              <p className="text-slate-300 leading-relaxed">
                The materials appearing on diybrand.app could include technical, typographical, or photographic errors. diybrand.app does not warrant that any of the materials on its web site are accurate, complete, or current. diybrand.app may make changes to the materials contained on its web site at any time without notice.
              </p>
            </section>

            {/* Materials and Content */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Materials and Content</h2>
              <p className="text-slate-300 leading-relaxed mb-4">
                You are responsible for:
              </p>
              <ul className="text-slate-300 space-y-2 list-disc list-inside">
                <li>Not using diybrand.app for any unlawful purpose</li>
                <li>Not violating any laws in your jurisdiction</li>
                <li>Not harassing or causing distress or inconvenience to any person</li>
                <li>Not obscuring or changing any copyright, trademark or other proprietary notice</li>
              </ul>
            </section>

            {/* Limitations on Use */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Limitations on Use</h2>
              <p className="text-slate-300 leading-relaxed">
                You agree not to access or use diybrand.app for any purpose other than that for which diybrand.app makes the service available. The service may not be used in connection with any commercial endeavors except those specifically endorsed or approved by diybrand.app.
              </p>
            </section>

            {/* Refund Policy */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Refund Policy</h2>
              <p className="text-slate-300 leading-relaxed">
                We offer a 30-day money-back guarantee. If you're not satisfied with your brand kit, request a refund within 30 days of purchase and we'll process a full refund. See our <Link href="/refund-policy" className="text-blue-400 hover:text-blue-300">Refund Policy</Link> for details.
              </p>
            </section>

            {/* Limitation on Time */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Limitation on Time to File Claims</h2>
              <p className="text-slate-300 leading-relaxed">
                Any claim or cause of action arising out of or related to the use of diybrand.app or these terms must be filed within one (1) year after such claim or cause of action arose; otherwise, such claim or cause of action is permanently barred.
              </p>
            </section>

            {/* Governing Law */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Governing Law</h2>
              <p className="text-slate-300 leading-relaxed">
                These terms and conditions are governed by and construed in accordance with the laws of the United States, and you irrevocably submit to the exclusive jurisdiction of the courts in that location.
              </p>
            </section>

            {/* Modifications */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Modifications</h2>
              <p className="text-slate-300 leading-relaxed">
                diybrand.app may revise these terms of service for its web site at any time without notice. By using this web site, you are agreeing to be bound by the then current version of these terms of service.
              </p>
            </section>

            {/* Severability */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Severability</h2>
              <p className="text-slate-300 leading-relaxed">
                If any provision of these terms and conditions is found to be invalid or unenforceable by a court of competent jurisdiction, the invalidity or unenforceability of such provision shall not affect the validity or enforceability of any other provision of these terms and conditions, which shall remain in full force and effect.
              </p>
            </section>

            {/* Contact */}
            <section className="border-t border-slate-700 pt-6">
              <h2 className="text-2xl font-bold text-white mb-4">Contact Us</h2>
              <p className="text-slate-300 leading-relaxed">
                If you have questions about these terms, contact us at:
              </p>
              <div className="mt-4 text-slate-300">
                <p>Email: <a href="mailto:legal@diybrand.app" className="text-blue-400 hover:text-blue-300">legal@diybrand.app</a></p>
              </div>
            </section>
          </div>

          {/* Footer Links */}
          <div className="flex gap-4 justify-center flex-wrap">
            <Link href="/privacy" className="text-blue-400 hover:text-blue-300">
              Privacy Policy
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
