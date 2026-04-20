# RFP Intake Folder

Drop each RFP into its own subfolder:

```
rfps/
  001-orange-county-erp/
    rfp.pdf              ← the RFP document (PDF or DOCX)
    meta.yaml            ← agency name, scope, deadline
  002-texas-hhs-cyber/
    rfp.pdf
    meta.yaml
    amendment-1.pdf      ← optional: Q&A docs, amendments
```

## meta.yaml format

```yaml
agency: "Orange County, CA"
scope: "ERP System Replacement"
rfp_number: "RFP-2026-0142"       # optional
deadline: "2026-04-15"             # optional
budget: "$2.5M"                    # optional, if known
notes: "Incumbent is Deloitte"     # optional, any context
```

If you don't have a meta.yaml, just name the folder clearly — the system will extract agency/scope from the PDF.
