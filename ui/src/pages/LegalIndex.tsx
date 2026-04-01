import { ScrollArea } from "@/components/ui/scroll-area";
import { Link } from "@/lib/router";
import { Scale, FileText, ShieldAlert, Shield, Database, Clock } from "lucide-react";

interface LegalDocLink {
  title: string;
  description: string;
  href: string;
  icon: React.ReactNode;
}

const LEGAL_DOCUMENTS: LegalDocLink[] = [
  {
    title: "Terms of Service",
    description:
      "The agreement governing your use of the IronWorks platform, including account terms, billing, data ownership, liability, and termination.",
    href: "/terms",
    icon: <FileText className="h-5 w-5" />,
  },
  {
    title: "Privacy Policy",
    description:
      "How we collect, use, store, and protect your information. Covers data retention, your rights under GDPR and CCPA, and cookie policies.",
    href: "/privacy",
    icon: <Shield className="h-5 w-5" />,
  },
  {
    title: "Acceptable Use Policy",
    description:
      "Rules for permitted and prohibited uses of the platform. Covers content responsibility, prohibited activities, and enforcement.",
    href: "/aup",
    icon: <ShieldAlert className="h-5 w-5" />,
  },
  {
    title: "Data Processing Agreement",
    description:
      "GDPR-compliant agreement defining how Steel Motion processes personal data on your behalf, including sub-processors, security measures, and breach notification.",
    href: "/dpa",
    icon: <Database className="h-5 w-5" />,
  },
  {
    title: "Service Level Agreement",
    description:
      "Our uptime commitments, support response times by plan tier, incident severity levels, and service credit policies.",
    href: "/sla",
    icon: <Clock className="h-5 w-5" />,
  },
];

export function LegalIndex() {
  return (
    <div className="min-h-screen bg-background">
      <ScrollArea className="h-screen">
        <div className="max-w-3xl mx-auto px-6 py-12">
          <div className="flex items-center gap-2 mb-6">
            <Scale className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">IronWorks by Steel Motion LLC</span>
          </div>

          <h1 className="text-3xl font-bold tracking-tight mb-2">Legal</h1>
          <p className="text-muted-foreground mb-8">
            All legal documents governing the use of the IronWorks platform. All documents are
            currently v0.1 and pending legal review.
          </p>

          <div className="space-y-4">
            {LEGAL_DOCUMENTS.map((doc) => (
              <Link
                key={doc.href}
                to={doc.href}
                className="flex items-start gap-4 rounded-lg border border-border p-4 hover:bg-muted/50 transition-colors"
              >
                <div className="mt-0.5 text-muted-foreground shrink-0">{doc.icon}</div>
                <div>
                  <h2 className="text-base font-semibold">{doc.title}</h2>
                  <p className="text-sm text-muted-foreground mt-1">{doc.description}</p>
                </div>
              </Link>
            ))}
          </div>

          <div className="mt-12 pt-6 border-t border-border text-xs text-muted-foreground space-y-2">
            <p>
              For questions about any of these documents, contact us at{" "}
              <a href="mailto:legal@steelmotionllc.com" className="underline hover:text-foreground">
                legal@steelmotionllc.com
              </a>
            </p>
            <p>Steel Motion LLC. All rights reserved.</p>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
