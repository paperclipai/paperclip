import { MarkdownBody } from "../components/MarkdownBody";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText } from "lucide-react";

const TERMS_OF_SERVICE = `
# Terms of Service

**Version:** v0.1 — pending legal review
**Effective Date:** April 1, 2026
**Last Updated:** April 1, 2026

These Terms of Service ("Terms") govern your access to and use of IronWorks, an AI workforce orchestration platform ("Service") operated by Steel Motion LLC ("Steel Motion," "we," "us," "our"). By accessing or using the Service, you agree to be bound by these Terms. If you do not agree, do not use the Service.

## 1. Service Description

IronWorks is a platform that enables businesses to deploy, manage, and orchestrate AI agents for business operations. The Service provides tools for agent management, task automation, project tracking, approval workflows, and related functionality.

Steel Motion provides the platform infrastructure only. You are responsible for configuring your AI agents and providing the necessary third-party API keys to power them.

## 2. Account Terms

### 2.1 Account Registration
To use the Service, you must create an account. You agree to provide accurate, current, and complete information during registration.

### 2.2 One Account Per Person
Each individual user must maintain only one account. Shared accounts are not permitted. Organizations may have multiple individual user accounts under a single company workspace.

### 2.3 Account Security
You are responsible for safeguarding your account credentials and for all activity that occurs under your account. You must notify us immediately at legal@steelmotionllc.com if you become aware of any unauthorized use of your account.

### 2.4 Age Requirement
You must be at least 18 years of age to use the Service. By using the Service, you represent and warrant that you meet this requirement.

## 3. Billing and Payment

### 3.1 Subscription Plans
The Service is offered on a subscription basis. Plan details, pricing, and feature availability are described on our pricing page and may be updated from time to time.

### 3.2 Payment Processing
All payments are processed securely through Stripe. By subscribing, you authorize Steel Motion to charge your payment method on file for recurring subscription fees.

### 3.3 Auto-Renewal
Subscriptions automatically renew at the end of each billing period unless you cancel before the renewal date. You will be charged the then-current rate for your plan at each renewal.

### 3.4 Refunds
Subscription fees are non-refundable except where required by applicable law. If you cancel mid-cycle, you retain access through the end of the current billing period.

### 3.5 Taxes
You are responsible for all applicable taxes. Subscription fees are exclusive of taxes unless otherwise stated.

## 4. Bring Your Own Key (BYOK)

### 4.1 Third-Party API Keys
The Service operates on a "Bring Your Own Key" (BYOK) model. You must provide your own API keys for third-party AI model providers (such as Anthropic, OpenAI, Google, and others) to power your AI agents.

### 4.2 Third-Party Charges
Steel Motion is not responsible for any charges, fees, or costs incurred from your use of third-party AI model providers. Your use of third-party services is governed by their respective terms of service and pricing.

### 4.3 Key Security
Your API keys are encrypted at rest using AES-256 encryption. Steel Motion does not access, read, or use your API keys for any purpose other than executing API calls on your behalf as directed by your agent configurations.

### 4.4 Platform Fee
Steel Motion charges a platform fee only for the use of IronWorks infrastructure, tooling, and orchestration capabilities. The platform fee is separate from and does not include any third-party provider costs.

## 5. Data Ownership

### 5.1 Your Data
You retain all ownership rights to data you upload, create, or generate through the Service ("Your Data"). Steel Motion does not claim ownership of Your Data.

### 5.2 Data Processing Role
Steel Motion acts as a data processor on your behalf. You are the data controller. We process Your Data only as necessary to provide the Service and as described in our [Privacy Policy](/privacy) and [Data Processing Agreement](/dpa).

### 5.3 Data Portability
You may export Your Data at any time through the export functionality provided in the Service.

## 6. Intellectual Property

### 6.1 Agent Output
You retain all intellectual property rights in any content, work product, or output created by your AI agents through the Service ("Agent Output"). Steel Motion claims no ownership of Agent Output.

### 6.2 Service IP
Steel Motion retains all rights, title, and interest in and to the Service, including all software, designs, documentation, and related intellectual property. These Terms do not grant you any rights to Steel Motion's intellectual property except the limited right to use the Service as described herein.

### 6.3 Feedback
If you provide feedback, suggestions, or ideas about the Service, you grant Steel Motion a non-exclusive, royalty-free, perpetual, irrevocable license to use that feedback for any purpose without obligation to you.

## 7. Acceptable Use

Your use of the Service is subject to our [Acceptable Use Policy](/aup). Violation of the AUP may result in immediate suspension or termination of your account.

## 8. Warranties Disclaimer

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY. STEEL MOTION DISCLAIMS ALL WARRANTIES, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, AND ANY WARRANTIES ARISING FROM COURSE OF DEALING OR USAGE OF TRADE.

STEEL MOTION DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE. WE DO NOT GUARANTEE THE ACCURACY, RELIABILITY, OR COMPLETENESS OF ANY AI-GENERATED OUTPUT.

## 9. Limitation of Liability

### 9.1 Liability Cap
TO THE MAXIMUM EXTENT PERMITTED BY LAW, STEEL MOTION'S TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE TOTAL AMOUNT OF FEES PAID BY YOU TO STEEL MOTION IN THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM.

### 9.2 Exclusion of Damages
IN NO EVENT SHALL STEEL MOTION BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, DATA, BUSINESS OPPORTUNITIES, OR GOODWILL, REGARDLESS OF THE CAUSE OF ACTION OR THE THEORY OF LIABILITY.

### 9.3 Third-Party Services
Steel Motion is not liable for any damages, costs, or losses arising from your use of third-party services, including AI model providers whose API keys you use with the Service.

## 10. Indemnification

You agree to indemnify and hold harmless Steel Motion, its officers, directors, employees, and agents from and against any claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising from: (a) your use of the Service; (b) your violation of these Terms or the AUP; (c) content created or generated by your AI agents; or (d) your violation of any third party's rights.

## 11. Termination

### 11.1 Termination by You
You may terminate your account at any time by providing 30 days' written notice to legal@steelmotionllc.com. You retain access through the end of the notice period.

### 11.2 Termination by Steel Motion
Steel Motion may terminate your account with 30 days' written notice. In the event of an AUP violation, Steel Motion reserves the right to suspend or terminate your account immediately without notice.

### 11.3 Effect of Termination
Upon termination, your right to use the Service ceases immediately (or at the end of the notice period, as applicable). You may export Your Data prior to termination. After termination, Your Data will be deleted in accordance with our [Privacy Policy](/privacy).

### 11.4 Survival
Sections relating to intellectual property, limitation of liability, indemnification, and governing law survive termination of these Terms.

## 12. Modifications to Terms

Steel Motion may modify these Terms at any time. We will provide at least 30 days' notice of material changes by email or through the Service. Your continued use of the Service after the effective date of any modification constitutes acceptance of the updated Terms.

## 13. Governing Law and Dispute Resolution

### 13.1 Governing Law
These Terms are governed by and construed in accordance with the laws of the State of Texas, United States, without regard to its conflict of law principles.

### 13.2 Dispute Resolution
Any disputes arising from these Terms or the Service shall first be attempted to be resolved through good-faith negotiation. If negotiation fails, disputes shall be resolved in the state or federal courts located in the State of Texas.

## 14. General Provisions

### 14.1 Entire Agreement
These Terms, together with the Privacy Policy, Acceptable Use Policy, Data Processing Agreement, and Service Level Agreement, constitute the entire agreement between you and Steel Motion regarding the Service.

### 14.2 Severability
If any provision of these Terms is held to be unenforceable, the remaining provisions continue in full force and effect.

### 14.3 Waiver
Failure to enforce any provision of these Terms does not constitute a waiver of that provision.

### 14.4 Assignment
You may not assign your rights under these Terms without Steel Motion's prior written consent. Steel Motion may assign its rights without restriction.

## 15. Contact

For questions about these Terms, contact us at:

- **Email:** legal@steelmotionllc.com
- **Company:** Steel Motion LLC
- **Website:** ironworksapp.ai

---

*These Terms of Service apply to the IronWorks platform operated by Steel Motion LLC.*
`;

export function TermsOfService() {
  return (
    <div className="min-h-[100dvh] bg-background">
      <ScrollArea className="h-[100dvh]">
        <div className="max-w-2xl mx-auto px-6 py-12">
          <div className="flex items-center gap-2 mb-6">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">IronWorks by Steel Motion LLC</span>
          </div>
          <MarkdownBody>{TERMS_OF_SERVICE}</MarkdownBody>
          <div className="mt-12 pt-6 border-t border-border text-xs text-muted-foreground">
            <p>Steel Motion LLC. All rights reserved.</p>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
