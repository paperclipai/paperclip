import { z } from "zod";

// Free-form multiline text fields are stored verbatim. JSON already encodes real
// line breaks via the "\n" string escape, which the JSON parser decodes before the
// value reaches this schema. We must NOT re-interpret literal backslash sequences
// here: replacing literal "\n"/"\r" with LF destroys legitimate data such as Windows
// paths (C:\new, \register, \repos, \node_modules). See RENA-14562.
export const multilineTextSchema = z.string();
