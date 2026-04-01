import { MarkdownBody } from "../components/MarkdownBody";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Database } from "lucide-react";

const DATA_PROCESSING_AGREEMENT = `
# Data Processing Agreement

**Version:** v0.1 — pending legal review
**Effective Date:** April 1, 2026
**Last Updated:** April 1, 2026

This Data Processing Agreement ("DPA") forms part of the [Terms of Service](/terms) between you ("Client," "Controller") and Steel Motion LLC ("Steel Motion," "Processor," "we," "us," "our") for the use of the IronWorks platform ("Service").

This DPA sets out the terms under which Steel Motion processes personal data on behalf of the Client in connection with the Service, in compliance with the General Data Protection Regulation (EU) 2016/679 ("GDPR"), the California Consumer Privacy Act ("CCPA"), and other applicable data protection laws.

## 1. Definitions

For the purposes of this DPA:

- **"Controller"** means the Client, who determines the purposes and means of processing personal data through the Service.
- **"Processor"** means Steel Motion LLC, who processes personal data on behalf of the Controller in connection with providing the Service.
- **"Data Subject"** means an identified or identifiable natural person whose personal data is processed.
- **"Personal Data"** means any information relating to a Data Subject, as defined by applicable data protection law.
- **"Processing"** means any operation performed on personal data, including collection, storage, use, disclosure, and deletion.
- **"Sub-processor"** means a third party engaged by Steel Motion to process personal data on behalf of the Controller.
- **"Data Breach"** means a breach of security leading to the accidental or unlawful destruction, loss, alteration, unauthorized disclosure of, or access to personal data.

## 2. Scope and Purpose of Processing

### 2.1 Scope
Steel Motion processes personal data only to the extent necessary to provide the Service as described in the Terms of Service and as instructed by the Client.

### 2.2 Purpose
The purpose of processing is limited to:
- Hosting and operating the IronWorks platform as instructed by the Client
- Authenticating and managing user accounts
- Executing AI agent tasks as configured by the Client
- Maintaining audit logs and activity records
- Processing billing and subscription payments
- Providing technical support

### 2.3 Types of Personal Data
Personal data processed may include:
- Names and email addresses of Client's users
- IP addresses and session data
- Content created or uploaded by Client's users and AI agents
- Usage and activity data

### 2.4 Categories of Data Subjects
Data subjects may include:
- Client's employees and contractors
- Client's end users (where applicable)
- Individuals whose data is processed by Client's AI agents

## 3. Steel Motion's Obligations as Processor

Steel Motion shall:

### 3.1 Process on Instructions
Process personal data only on documented instructions from the Client, including with respect to transfers of personal data outside the European Economic Area, unless required by applicable law.

### 3.2 Confidentiality
Ensure that all persons authorized to process personal data have committed themselves to confidentiality or are under an appropriate statutory obligation of confidentiality.

### 3.3 Security Measures
Implement and maintain appropriate technical and organizational measures to ensure a level of security appropriate to the risk, including:

- **Encryption at rest:** All data stored in PostgreSQL with filesystem-level encryption; API keys and secrets encrypted with AES-256
- **Encryption in transit:** All communications secured with TLS 1.2 or higher
- **Access controls:** Role-based access control, company-level data isolation, org-chart-based ACL enforcement
- **Authentication:** Secure session tokens with expiration, SHA-256 hashed API key storage
- **Input validation:** SVG sanitization, path traversal protection, SQL injection prevention
- **Monitoring:** Audit logging of administrative actions and data access
- **Backup:** Regular encrypted backups with defined retention periods

### 3.4 Sub-processor Management
Not engage another processor (sub-processor) without prior written authorization from the Controller, subject to Section 5 of this DPA.

### 3.5 Assistance with Data Subject Rights
Assist the Controller, by appropriate technical and organizational measures, in fulfilling the Controller's obligation to respond to Data Subject requests to exercise their rights under applicable data protection law.

### 3.6 Assistance with Compliance
Assist the Controller in ensuring compliance with obligations related to security, breach notification, data protection impact assessments, and prior consultation with supervisory authorities.

### 3.7 Deletion and Return
At the choice of the Controller, delete or return all personal data to the Controller after the end of the provision of the Service, and delete existing copies unless applicable law requires storage of the personal data.

### 3.8 Audit and Compliance Evidence
Make available to the Controller all information necessary to demonstrate compliance with this DPA and allow for and contribute to audits and inspections, as described in Section 7.

## 4. Client's Obligations as Controller

The Client shall:

### 4.1 Lawful Basis
Ensure that there is a lawful basis for the processing of personal data in connection with the Service, including obtaining any necessary consents from Data Subjects.

### 4.2 Data Accuracy
Ensure that personal data provided to Steel Motion is accurate and up to date.

### 4.3 Instructions
Provide documented processing instructions to Steel Motion that comply with applicable data protection law.

### 4.4 Agent Configuration
Ensure that AI agents are configured with appropriate safeguards to prevent the unauthorized processing of personal data.

### 4.5 Compliance
Comply with all applicable data protection laws in connection with the Client's use of the Service.

## 5. Sub-processors

### 5.1 Authorized Sub-processors
The Client hereby authorizes Steel Motion to engage the following sub-processors:

| Sub-processor | Purpose | Location |
|---|---|---|
| Contabo GmbH | Infrastructure hosting (VPS) | Germany / United States |
| Stripe, Inc. | Payment processing and billing | United States |

### 5.2 Change Notification
Steel Motion will notify the Client at least 30 days in advance before engaging a new sub-processor or replacing an existing one. Notification will be provided via email to the Client's registered account email address.

### 5.3 Objection Right
The Client may object to the appointment of a new sub-processor within 14 days of receiving notification. If the Client objects and the parties cannot reach a resolution, the Client may terminate the affected Service by providing written notice.

### 5.4 Sub-processor Obligations
Steel Motion will ensure that each sub-processor is bound by data protection obligations no less protective than those set out in this DPA.

## 6. Data Breach Notification

### 6.1 Notification Timeline
Steel Motion will notify the Client without undue delay, and in any event within 72 hours, after becoming aware of a Data Breach affecting the Client's personal data.

### 6.2 Notification Content
The notification will include, to the extent available:
- A description of the nature of the Data Breach, including categories and approximate number of Data Subjects and records affected
- The name and contact details of Steel Motion's point of contact
- A description of the likely consequences of the Data Breach
- A description of the measures taken or proposed to address the Data Breach, including measures to mitigate its possible adverse effects

### 6.3 Cooperation
Steel Motion will cooperate with the Client and take reasonable steps to assist in the investigation, mitigation, and remediation of the Data Breach.

## 7. Audit Rights

### 7.1 Compliance Evidence
Upon reasonable request and no more than once per calendar year, Steel Motion will provide the Client with evidence of compliance with this DPA. This may include:
- Summaries of security measures in place
- Results of third-party security audits or certifications (when available)
- Responses to reasonable data protection questionnaires

### 7.2 On-Site Audit
If the Controller reasonably determines that the information provided under Section 7.1 is insufficient, the Controller may conduct or commission an audit of Steel Motion's processing activities, subject to:
- At least 30 days' prior written notice
- Reasonable scope and duration
- Confidentiality obligations regarding any proprietary information
- The Controller bearing the costs of the audit

## 8. International Data Transfers

### 8.1 Transfer Mechanisms
If personal data is transferred outside the European Economic Area or the United Kingdom, Steel Motion will ensure that appropriate safeguards are in place, including:
- Standard Contractual Clauses (SCCs) as approved by the European Commission
- Any other transfer mechanism recognized under applicable data protection law

### 8.2 Data Localization
The Client may request information about the geographic location of their data storage. Steel Motion will provide this information upon request.

## 9. Data Deletion on Termination

### 9.1 Deletion Timeline
Upon termination of the Service:
- Active account data will be deleted within 30 days of termination
- Backup copies will be deleted within 90 days of termination

### 9.2 Data Export
The Client may export their data prior to termination using the export functionality provided in the Service.

### 9.3 Certification
Upon request, Steel Motion will provide written confirmation that personal data has been deleted in accordance with this DPA.

## 10. Duration and Termination

### 10.1 Duration
This DPA remains in effect for the duration of the Client's use of the Service and until all personal data has been deleted or returned.

### 10.2 Termination
This DPA terminates automatically when the Terms of Service between the parties are terminated, subject to Section 9 regarding data deletion.

## 11. Governing Law

This DPA is governed by the same governing law as the Terms of Service (State of Texas, United States), except where applicable data protection law requires otherwise.

## 12. Contact

For questions about this DPA, contact us at:

- **Email:** legal@steelmotionllc.com
- **Company:** Steel Motion LLC
- **Website:** ironworksapp.ai

---

*This Data Processing Agreement applies to the IronWorks platform operated by Steel Motion LLC.*
`;

export function DataProcessingAgreement() {
  return (
    <div className="min-h-screen bg-background">
      <ScrollArea className="h-screen">
        <div className="max-w-3xl mx-auto px-6 py-12">
          <div className="flex items-center gap-2 mb-6">
            <Database className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">IronWorks by Steel Motion LLC</span>
          </div>
          <MarkdownBody>{DATA_PROCESSING_AGREEMENT}</MarkdownBody>
          <div className="mt-12 pt-6 border-t border-border text-xs text-muted-foreground">
            <p>Steel Motion LLC. All rights reserved.</p>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
