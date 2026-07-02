import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COMPANY_ID = "11111111-2222-3333-4444-555555555555";
const REQUEST_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";

function pendingPayload() {
  return {
    actionRequests: [
      {
        request: {
          id: REQUEST_ID,
          companyId: COMPANY_ID,
          invocationId: "invocation-1",
          issueId: null,
          interactionId: null,
          approvalId: null,
          status: "pending",
          canonicalArgumentsHash: "hash-1",
          canonicalArgumentsSummary: { noteId: "n1", body: "reviewed body" },
          signedArguments: "signed-blob",
          previewMarkdown: "**Send to:** team@example.com\n\nBody: reviewed body",
          requestedByAgentId: "agent-1",
          requestedByUserId: null,
          resolvedByAgentId: null,
          resolvedByUserId: null,
          decidedByAgentId: null,
          decidedByUserId: null,
          decidedAt: null,
          expiresAt: null,
          resolvedAt: null,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date().toISOString(),
        },
        toolName: "mcp-notes:update_note",
        toolTitle: "Update note",
        connectionId: CONNECTION_ID,
        connectionName: "Notes",
        applicationName: "Notes",
        riskLevel: "write",
        requestedByAgentId: "agent-1",
      },
    ],
  };
}

const state = {
  approved: false,
  trustRuleCreated: false,
  callLog: [],
};

const mockApi = {
  name: "pap11227-mock-api",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url || "";

      // session
      if (url === "/api/auth/session") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          session: { userId: "user-1", id: "session-1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
          user: { id: "user-1", email: "qabot@paperclip.local", name: "QA Bot" },
        }));
      }

      // companies list
      if (url === "/api/companies") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify([{
          id: COMPANY_ID,
          name: "Paperclip QA",
          status: "active",
          memberRole: "owner",
        }]));
      }

      // pending action requests (filtered by status=pending)
      const listMatch = url.match(/^\/api\/companies\/([^/]+)\/tools\/action-requests\?status=pending/);
      if (listMatch) {
        res.setHeader("content-type", "application/json");
        const payload = state.approved ? { actionRequests: [] } : pendingPayload();
        return res.end(JSON.stringify(payload));
      }

      // approve (real API path: /api/tool-gateway/action-requests/:id/approve)
      const approveMatch = url.match(/^\/api\/tool-gateway\/action-requests\/([^/]+)\/approve/);
      if (approveMatch && req.method === "POST") {
        state.callLog.push("approve");
        state.approved = true;
        res.setHeader("content-type", "application/json");
        const req0 = pendingPayload().actionRequests[0].request;
        return res.end(JSON.stringify({ ...req0, status: "approved", resolvedAt: new Date().toISOString(), resolvedByUserId: "user-1" }));
      }

      // create trust rule from action request — assert approvalThreshold:1 to mimic server validation
      const trustMatch = url.match(/^\/api\/companies\/([^/]+)\/tools\/action-requests\/([^/]+)\/trust-rule/);
      if (trustMatch && req.method === "POST") {
        state.callLog.push("trust-rule");
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          let parsed;
          try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
          state.lastTrustRuleBody = parsed;
          // Simulate server-side requirement: source request must be approved first AND approvalThreshold present.
          if (!state.approved) {
            res.statusCode = 422;
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify({ error: "Trust rules can only be created from approved or executed action requests" }));
          }
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ id: "policy-1", name: "Trust mcp-notes:update_note", config: { trustRule: { approvalThreshold: parsed?.approvalThreshold ?? null } } }));
        });
        return;
      }

      // call log + reset endpoints
      if (url === "/api/__qa/log") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ ...state }));
      }
      if (url === "/api/__qa/reset" && req.method === "POST") {
        state.approved = false;
        state.trustRuleCreated = false;
        state.callLog = [];
        delete state.lastTrustRuleBody;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ ok: true }));
      }

      // tools trust rules (used by the alwaysAllow invalidate)
      const trustListMatch = url.match(/^\/api\/companies\/([^/]+)\/tools\/policies\?type=trust_rule/);
      if (trustListMatch) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ policies: [] }));
      }

      next();
    });
  },
};

export default defineConfig({
  plugins: [mockApi, react(), tailwindcss()],
  resolve: {
    alias: [
      // Stub CompanyContext so the harness doesn't try to fetch /companies.
      {
        find: /^@\/context\/CompanyContext$/,
        replacement: path.resolve(__dirname, "./src/pap11227-company-context-stub.tsx"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      { find: "lexical", replacement: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs") },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
  },
});
