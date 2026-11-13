# Hire review checklist

Check the hire's configuration before submitting. A short role paragraph or the
server default is sufficient; a full operating manual is not required.

- Name, role, title, and capabilities describe the requested responsibility.
- `reportsTo` resolves to an in-company agent when a reporting line is needed.
- The icon is allowed by this instance.
- Adapter, model, authentication, and workspace configuration match this
  instance's advertised configuration.
- Desired skills are available in the company library or installed before the
  hire. Do not claim tools or skills the runtime cannot provide.
- Grant only the permissions and skills the role needs. Explain settings or
  skills that expand external access, browser/network reach, filesystem scope,
  or secret-handling capability in the hire comment.
- Keep timer heartbeats off unless scheduled work is needed or requested. If
  enabled, explain the interval and purpose.
- Keep secrets out of instruction text and literal configuration values. Use
  this instance's supported credential bindings or environment injection.
- Preserve requester-supplied company or role instructions. Send custom text
  through `instructionsBundle` on adapters that support it, rather than legacy
  `promptTemplate` or `bootstrapPromptTemplate` fields.
- Replace any name, company, responsibility, or URL placeholders in custom text.
- Keep default role text short. Do not add generic execution or heartbeat rules,
  mandatory comments, fixed review routes, or domain-lens catalogs.
- For private advisories or sensitive disclosures, confirm a confidential
  workflow is available. Do not use normal issue threads for private details.
- Include source issue linkage when the hire comes from an issue. Follow the
  company's hiring permission and approval requirements.
