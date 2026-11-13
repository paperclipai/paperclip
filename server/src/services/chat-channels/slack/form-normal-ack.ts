import type { Db } from "@paperclipai/db";
import type { PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";
import { stageSlackFormNormalAck, acceptSlackFormAckReceipt } from "./form-ack-work.js";
import { slackFormConnectorIdentity } from "./cloud-consumer.js";
import { SlackCloudReceiptError } from "./cloud-event.js";

export async function acknowledgeSlackFormDeliveries(db: Db, input: { connector: PaperclipCloudConnector;
  values: { subject: string; companyId: string; leaseId: string; deliveryIds: string[] }; companies: ReadonlyMap<string, string> }): Promise<void> {
      const formIds = input.values.deliveryIds.filter(id => /^slack_form_[a-f0-9]{64}$/.test(id));
      const values = input.values;
      if (!formIds.length) await input.connector.acknowledgeEvents(values);
      else {
        const identity = slackFormConnectorIdentity(input.connector), detailed = Reflect.get(input.connector, "acknowledgeEventsWithReceipts");
        if (!identity || typeof detailed !== "function") throw new SlackCloudReceiptError("form_ack_receipts_unsupported", "attention");
        for (const deliveryId of formIds) {
          const companyId = input.companies.get(deliveryId);
          if (!companyId) throw new SlackCloudReceiptError("form_ack_company_missing", "attention");
          await db.transaction(tx => stageSlackFormNormalAck(tx, { companyId, instanceId: identity.instanceId, leaseId: values.leaseId, deliveryIds: [deliveryId] }));
        }
        const response: unknown = await Reflect.apply(detailed, input.connector, [values]);
        if (!response || typeof response !== "object" || Array.isArray(response) || !Array.isArray(Reflect.get(response, "formReceipts")))
          throw new SlackCloudReceiptError("form_ack_receipts_invalid", "attention");
        const receipts: unknown = Reflect.get(response, "formReceipts");
        if (!Array.isArray(receipts) || receipts.length !== formIds.length) throw new SlackCloudReceiptError("form_ack_receipts_invalid", "attention");
        const seen = new Set<string>();
        for (const value of receipts) {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new SlackCloudReceiptError("form_ack_receipts_invalid", "attention");
          const deliveryId: unknown = Reflect.get(value, "deliveryId"), receiptJws: unknown = Reflect.get(value, "receiptJws");
          if (typeof deliveryId !== "string" || !formIds.includes(deliveryId) || seen.has(deliveryId) || typeof receiptJws !== "string")
            throw new SlackCloudReceiptError("form_ack_receipts_invalid", "attention");
          seen.add(deliveryId);
          const companyId = input.companies.get(deliveryId);
          if (!companyId) throw new SlackCloudReceiptError("form_ack_company_missing", "attention");
          await db.transaction(tx => acceptSlackFormAckReceipt(tx, { companyId, instanceId: identity.instanceId, leaseId: values.leaseId, receiptJws }));
        }
      }
}
