-- BLO-4141: per-agent staging slot for an image bump that was deferred
-- because the agent was in-flight when the auto-bump endpoint ran.
-- Set by /admin/agents/bump-agent-image; cleared by the heartbeat
-- run-completion hook in services/heartbeat.ts.
--
-- Nullable text. Holds a full image ref like
-- "harbor.blockcast.net/paperclip-agent/paperclip-agent:sha-XXXXXXX-k8s-vendored".
-- NULL means no pending bump. Last-write-wins on overlapping bumps.
ALTER TABLE "agents" ADD COLUMN "pending_image_bump" text;
