import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useState, useEffect } from "react";
import { usePluginData, usePluginAction, useHostContext, usePluginStream, } from "@paperclipai/plugin-sdk/ui";
import { ACTION_KEYS, DATA_KEYS, STREAM_CHANNELS } from "../constants.js";
const styles = {
    overlay: {
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
    },
    dialog: {
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: "12px",
        padding: "24px",
        width: "480px",
        maxWidth: "90vw",
        maxHeight: "80vh",
        overflow: "auto",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        color: "var(--foreground)",
    },
    title: {
        margin: "0 0 16px",
        fontSize: "18px",
        fontWeight: 600,
        color: "var(--foreground)",
    },
    label: {
        display: "block",
        fontSize: "13px",
        fontWeight: 500,
        marginBottom: "6px",
        color: "var(--muted-foreground)",
    },
    select: {
        width: "100%",
        padding: "8px 12px",
        borderRadius: "6px",
        border: "1px solid var(--border)",
        fontSize: "14px",
        marginBottom: "16px",
        background: "var(--background)",
        color: "var(--foreground)",
    },
    textarea: {
        width: "100%",
        padding: "8px 12px",
        borderRadius: "6px",
        border: "1px solid var(--border)",
        fontSize: "14px",
        minHeight: "100px",
        resize: "vertical",
        fontFamily: "inherit",
        marginBottom: "16px",
        background: "var(--background)",
        color: "var(--foreground)",
    },
    actions: {
        display: "flex",
        gap: "8px",
        justifyContent: "flex-end",
    },
    btn: {
        padding: "8px 16px",
        borderRadius: "6px",
        border: "none",
        fontSize: "14px",
        fontWeight: 500,
        cursor: "pointer",
    },
    btnPrimary: {
        background: "var(--primary)",
        color: "var(--primary-foreground)",
    },
    btnSecondary: {
        background: "var(--secondary)",
        color: "var(--secondary-foreground)",
        border: "1px solid var(--border)",
    },
    statusBadge: (status) => ({
        display: "inline-block",
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        marginRight: "6px",
        background: status === "active"
            ? "#3fb950"
            : status === "idle"
                ? "#8b949e"
                : "#f85149",
    }),
    progress: {
        marginTop: "16px",
        padding: "12px",
        borderRadius: "6px",
        background: "var(--background)",
        border: "1px solid var(--border)",
        fontSize: "13px",
        color: "var(--foreground)",
    },
    stepRow: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "4px 0",
    },
};
export function DelegateDialog({ issueKey, issueTitle, ticketContext, onClose, }) {
    const context = useHostContext();
    const { data: agents, loading: agentsLoading } = usePluginData(DATA_KEYS.agents);
    const delegateAction = usePluginAction(ACTION_KEYS.delegateToAi);
    const stream = usePluginStream(STREAM_CHANNELS.delegation);
    const [agentId, setAgentId] = useState("");
    const [instructions, setInstructions] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState(null);
    useEffect(() => {
        if (agents?.length && !agentId) {
            const idle = agents.find((a) => a.status === "idle" || a.status === "active");
            if (idle)
                setAgentId(idle.id);
        }
    }, [agents, agentId]);
    const handleSubmit = async () => {
        if (!agentId || !context.companyId)
            return;
        setSubmitting(true);
        setResult(null);
        try {
            const res = await delegateAction({
                companyId: context.companyId,
                agentId,
                instructions,
                jiraKey: issueKey ?? context.entityId ?? "",
                jiraTitle: issueTitle ?? "",
                ticketContext: ticketContext ?? "",
            });
            setResult({
                ok: true,
                message: `Delegated to ${agents?.find((a) => a.id === agentId)?.name ?? "agent"}`,
            });
        }
        catch (err) {
            setResult({
                ok: false,
                message: err instanceof Error ? err.message : String(err),
            });
        }
        finally {
            setSubmitting(false);
        }
    };
    return (_jsxs("div", { style: styles.dialog, children: [_jsxs("h3", { style: styles.title, children: ["Delegate to AI", issueKey ? ` — ${issueKey}` : ""] }), issueTitle && (_jsx("p", { style: { margin: "0 0 16px", fontSize: "14px", color: "#8b949e" }, children: issueTitle })), _jsx("label", { style: styles.label, children: "Agent" }), agentsLoading ? (_jsx("div", { style: { ...styles.select, opacity: 0.5 }, children: "Loading agents\u2026" })) : (_jsxs("select", { style: styles.select, value: agentId, onChange: (e) => setAgentId(e.target.value), disabled: submitting, children: [_jsx("option", { value: "", children: "Select an agent\u2026" }), (agents ?? []).map((a) => (_jsxs("option", { value: a.id, children: [a.name, " (", a.status, ")"] }, a.id)))] })), _jsx("label", { style: styles.label, children: "Instructions (optional)" }), _jsx("textarea", { style: styles.textarea, value: instructions, onChange: (e) => setInstructions(e.target.value), placeholder: "e.g. Implement the acceptance criteria, write E2E tests, then create an MR", disabled: submitting }), stream.events.length > 0 && (_jsx("div", { style: styles.progress, children: stream.events.map((evt, i) => (_jsxs("div", { style: styles.stepRow, children: [_jsx("span", { children: evt.status === "done"
                                ? "✓"
                                : evt.status === "error"
                                    ? "✗"
                                    : "⏳" }), _jsx("span", { children: evt.step }), evt.detail && (_jsx("span", { style: { opacity: 0.6, fontSize: "12px" }, children: evt.detail }))] }, i))) })), result && (_jsxs("div", { style: {
                    ...styles.progress,
                    background: result.ok
                        ? "rgba(46,160,67,0.15)"
                        : "rgba(248,81,73,0.15)",
                    borderColor: result.ok ? "#238636" : "#f85149",
                }, children: [result.ok ? "✓" : "✗", " ", result.message] })), _jsxs("div", { style: styles.actions, children: [onClose && (_jsx("button", { type: "button", style: { ...styles.btn, ...styles.btnSecondary }, onClick: onClose, disabled: submitting, children: "Cancel" })), _jsx("button", { type: "button", style: {
                            ...styles.btn,
                            ...styles.btnPrimary,
                            opacity: !agentId || submitting ? 0.5 : 1,
                        }, onClick: handleSubmit, disabled: !agentId || submitting, children: submitting ? "Delegating…" : "Delegate" })] })] }));
}
//# sourceMappingURL=delegate-dialog.js.map