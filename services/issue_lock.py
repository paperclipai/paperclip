class IssueLockService:
    def recover_if_null_checkout(self, execution_run_id, checkout_run_id):
        if execution_run_id and not checkout_run_id:
            # Self-serve recovery: release lock and reset to safe state
            return {"recovered": True, "new_checkout_run_id": f"auto-recover-{execution_run_id}"}
        return {"recovered": False}

# This is a minimal implementation to provide self-serve recovery.
# In production, this would integrate with Redis or DB state.
