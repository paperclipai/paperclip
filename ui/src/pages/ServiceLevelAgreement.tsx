import { MarkdownBody } from "../components/MarkdownBody";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Clock } from "lucide-react";

const SERVICE_LEVEL_AGREEMENT = `
# Service Level Agreement

**Version:** v0.1 — pending legal review
**Effective Date:** April 1, 2026
**Last Updated:** April 1, 2026

This Service Level Agreement ("SLA") is part of the [Terms of Service](/terms) between you ("Client") and Steel Motion LLC ("Steel Motion," "we," "us," "our") for the IronWorks platform ("Service"). This SLA describes the uptime commitments, support response times, and remedies available to you.

## 1. Uptime Commitment

### 1.1 Uptime Target
Steel Motion commits to a monthly uptime target of **99.5%** for the IronWorks platform. Uptime is calculated as the percentage of total minutes in a calendar month during which the Service is available and operational.

### 1.2 Uptime Calculation
Monthly Uptime % = ((Total Minutes in Month - Downtime Minutes) / Total Minutes in Month) x 100

### 1.3 Availability Monitoring
Steel Motion monitors Service availability continuously using automated health checks. Uptime data is available to Enterprise tier clients upon request.

## 2. Planned Maintenance

### 2.1 Maintenance Windows
Planned maintenance will be scheduled during low-usage periods and will not exceed **4 hours** per maintenance window.

### 2.2 Advance Notice
Steel Motion will provide at least **48 hours** advance notice before any planned maintenance that may affect Service availability. Notice will be provided via email to account administrators and through in-app notifications.

### 2.3 Exclusion from Uptime
Planned maintenance windows that are properly communicated with the required advance notice are excluded from uptime calculations.

## 3. Support Response Times

Support response times vary by plan tier:

| Priority | Starter | Growth | Enterprise |
|---|---|---|---|
| P1 — Critical | 48 hours (email) | 12 hours (email) | 4 hours (dedicated) |
| P2 — High | 48 hours (email) | 24 hours (email) | 8 hours (dedicated) |
| P3 — Medium | 48 hours (email) | 24 hours (email) | 24 hours (email) |
| P4 — Low | 48 hours (email) | 48 hours (email) | 48 hours (email) |

### 3.1 Support Channels
- **Starter:** Email support at support@steelmotionllc.com
- **Growth:** Priority email support with faster response times
- **Enterprise:** Dedicated support contact with direct escalation path

### 3.2 Support Hours
- **Starter and Growth:** Business hours, Monday through Friday, 9:00 AM - 5:00 PM Central Time
- **Enterprise:** Extended hours, Monday through Friday, 7:00 AM - 9:00 PM Central Time; P1 issues monitored 24/7

## 4. Incident Severity Levels

### 4.1 P1 — Critical
**Definition:** The Service is completely unavailable or a core function is non-operational, affecting all users with no workaround available.

**Examples:** Platform-wide outage, authentication system failure, data loss event.

**Response commitment:** Immediate investigation upon detection. Status updates every 30 minutes until resolution. Post-incident report within 48 hours.

### 4.2 P2 — High
**Definition:** A major feature is significantly impaired, affecting multiple users, but the Service remains partially operational.

**Examples:** Agent execution failures, project management features unavailable, significant performance degradation.

**Response commitment:** Investigation begins within the response time for your tier. Status updates every 2 hours until resolution.

### 4.3 P3 — Medium
**Definition:** A feature is partially impaired with a workaround available, or a non-critical feature is unavailable.

**Examples:** Slow page loads, minor UI issues affecting workflow, export functionality delayed.

**Response commitment:** Investigation begins within the response time for your tier. Resolution targeted within 5 business days.

### 4.4 P4 — Low
**Definition:** A minor issue, cosmetic defect, or feature request that does not impact functionality.

**Examples:** Visual inconsistencies, documentation corrections, minor usability improvements.

**Response commitment:** Acknowledged within the response time for your tier. Prioritized for future releases.

## 5. Service Credits

### 5.1 Credit Eligibility
If the Service fails to meet the 99.5% monthly uptime target, you are eligible for service credits as described below.

### 5.2 Credit Calculation
Service credits are calculated as a percentage of the monthly subscription fee for the affected month:

| Monthly Uptime | Service Credit |
|---|---|
| 99.0% - 99.4% | 5% |
| 98.5% - 98.9% | 10% |
| 98.0% - 98.4% | 15% |
| 97.5% - 97.9% | 20% |
| 97.0% - 97.4% | 25% |
| Below 97.0% | 30% |

### 5.3 Maximum Credit
The maximum service credit for any single calendar month shall not exceed **30%** of the monthly subscription fee for that month.

### 5.4 Credit Request
To receive a service credit, you must submit a request to support@steelmotionllc.com within 30 days of the end of the affected month. Include the dates and times of the downtime experienced.

### 5.5 Credit Application
Service credits are applied as a credit against future invoices. Credits are not redeemable for cash and do not carry over if the account is terminated.

## 6. Exclusions

This SLA does not apply to downtime or performance issues caused by:

### 6.1 Force Majeure
Events beyond Steel Motion's reasonable control, including natural disasters, wars, pandemics, government actions, power outages, or internet infrastructure failures.

### 6.2 Client Infrastructure
Issues arising from the Client's own infrastructure, network connectivity, hardware, or software.

### 6.3 Third-Party Providers
Outages or performance issues from third-party AI model providers (Anthropic, OpenAI, Google, etc.) whose API keys the Client uses through the Service. Steel Motion is not responsible for third-party provider availability.

### 6.4 Client Actions
Downtime caused by the Client's misuse of the Service, violation of the [Acceptable Use Policy](/aup), or actions that overload or degrade the Service.

### 6.5 Beta Features
Features explicitly labeled as "beta," "experimental," or "preview" are not covered by this SLA.

### 6.6 Planned Maintenance
Properly communicated planned maintenance as described in Section 2.

## 7. Remedies

The service credits described in this SLA are the Client's sole and exclusive remedy for any failure by Steel Motion to meet the uptime commitment. This SLA does not modify or supersede the limitation of liability in the [Terms of Service](/terms).

## 8. SLA Review

Steel Motion reserves the right to review and update this SLA periodically. Changes to the SLA will be communicated with at least 30 days' notice. Material changes that reduce commitments will not apply to existing subscribers until the next subscription renewal.

## 9. Contact

For SLA-related inquiries, support requests, or service credit claims:

- **Email:** support@steelmotionllc.com
- **Company:** Steel Motion LLC
- **Website:** ironworksapp.ai

---

*This Service Level Agreement applies to the IronWorks platform operated by Steel Motion LLC.*
`;

export function ServiceLevelAgreement() {
  return (
    <div className="min-h-screen bg-background">
      <ScrollArea className="h-screen">
        <div className="max-w-3xl mx-auto px-6 py-12">
          <div className="flex items-center gap-2 mb-6">
            <Clock className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">IronWorks by Steel Motion LLC</span>
          </div>
          <MarkdownBody>{SERVICE_LEVEL_AGREEMENT}</MarkdownBody>
          <div className="mt-12 pt-6 border-t border-border text-xs text-muted-foreground">
            <p>Steel Motion LLC. All rights reserved.</p>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
