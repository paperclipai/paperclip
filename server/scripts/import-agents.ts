import * as fs from 'fs';

const inputPath = process.argv[2] || '/tmp/converted.json';
const companyId = process.argv[3] || '84db1d00-c7ff-46a3-98b9-a50a041bd9a5';
const apiBase = process.env.PAPERCLIP_API_URL || 'http://localhost:3100/api';

async function createAgent(agent: any) {
  const payload = {
    name: agent.name,
    role: agent.role,
    title: agent.title,
    status: agent.status,
    adapterType: agent.adapter_type,
    adapterConfig: agent.adapter_config,
    capabilities: agent.description,
  };

  const response = await fetch(`${apiBase}/companies/${companyId}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (response.ok) {
    const data = await response.json();
    console.log(`CREATED: ${agent.name} (${data.id})`);
    return { success: true, id: data.id };
  } else {
    const error = await response.text();
    console.error(`FAILED: ${agent.name} - ${error}`);
    return { success: false, error };
  }
}

async function importAgents() {
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const agents = data.agents;

  console.log(`Importing ${agents.length} agents...\n`);

  let created = 0;
  let failed = 0;

  for (const agent of agents) {
    const result = await createAgent(agent);
    if (result.success) created++;
    else failed++;
    // Small delay to not overwhelm the API
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nDone: ${created} created, ${failed} failed`);
}

importAgents().catch(err => {
  console.error('Import error:', err);
  process.exit(1);
});
