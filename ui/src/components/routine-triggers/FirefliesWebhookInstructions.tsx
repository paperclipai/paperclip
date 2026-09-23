export function FirefliesWebhookInstructions() {
  return (
    <div className="space-y-2 text-sm">
      <p>
        Open{" "}
        <a className="text-primary underline" href="https://app.fireflies.ai/integrations/api/webhook" target="_blank" rel="noreferrer">
          Fireflies Webhooks V2 settings
        </a>{" "}
        and add a webhook using the URL and Signing Secret below.
      </p>
      <p>
        Subscribe only to <strong>meeting.summarized</strong> (Summary ready), then
        save. Use this webhook’s signing secret, separate from your Fireflies API key.
      </p>
      <p className="text-muted-foreground">
        Fireflies sends events for meetings you own after their summaries are
        ready. The routine receives the meeting ID; give its assigned agent
        access to a Fireflies connection in Apps to read the transcript and summary.
      </p>
    </div>
  );
}
