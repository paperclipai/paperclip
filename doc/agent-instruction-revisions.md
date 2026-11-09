# Legacy instruction revision compatibility

The revision-based design in the first version of PR #14325 has been superseded
by [persistent agent files](agent-files.md). Current managed files are authoritative;
new edits do not create revision or head rows.

Published migrations 0285 and 0286 and existing revision records are retained so
preview installations and saved sessions can upgrade safely. Old heads are
adopted once. Legacy collectors and UUID-based APIs compare their baseline bytes
against current files before writing. Read-only history and restore endpoints
remain for pre-upgrade records; they are not advertised as new agent capabilities
or shown as a history feature in the current file editor.

See the current document for directory layout, synchronization, conflicts,
authorization, recovery, and verification.
