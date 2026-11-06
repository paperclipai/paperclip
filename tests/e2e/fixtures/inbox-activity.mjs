const headers = {
  Authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`,
  "X-Paperclip-Run-Id": process.env.PAPERCLIP_RUN_ID,
  "Content-Type": "application/json",
};
const base = `${process.env.PAPERCLIP_API_URL}/api`;
const runResponse = await fetch(`${base}/heartbeat-runs/${process.env.PAPERCLIP_RUN_ID}`, { headers });
if (!runResponse.ok) throw new Error(`Run read failed: ${runResponse.status}`);
const run = await runResponse.json();
const response = await fetch(`${base}/issues/${run.contextSnapshot.issueId}/comments`, {
  method: "POST", headers, body: JSON.stringify({ body: "An update from another actor." }),
});
if (!response.ok) throw new Error(`Comment failed: ${response.status}`);
