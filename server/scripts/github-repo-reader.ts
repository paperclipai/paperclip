import * as fs from 'fs';

const REPO = process.argv[2];
const GITHUB_TOKEN = process.env.GITHUB_API_TOKEN;

if (!REPO) {
  console.error('Usage: tsx github-repo-reader.ts <owner/repo>');
  process.exit(1);
}

async function githubFetch(path: string) {
  const url = `https://api.github.com/repos/${REPO}${path}`;
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'paperclip-agent-import'
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchAgents() {
  // Fetch README
  const readme = await githubFetch('/readme');
  const readmeContent = Buffer.from(readme.content, 'base64').toString('utf8');

  // Parse agent links from README
  const agents: any[] = [];
  const linkRegex = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  let match;
  while ((match = linkRegex.exec(readmeContent)) !== null) {
    const name = match[1].trim();
    const path = match[2].trim();
    agents.push({
      name,
      role: name,
      file_path: path,
      source_url: `https://github.com/${REPO}/blob/main/${path}`,
    });
  }

  // Fetch individual agent files
  for (const agent of agents) {
    try {
      const fileData = await githubFetch(`/contents/${agent.file_path}`);
      const content = Buffer.from(fileData.content, 'base64').toString('utf8');
      agent.file_content = content;
    } catch (e) {
      agent.file_content = null;
      agent.source_url = null;
    }
  }

  const result = { repo: REPO, total: agents.length, agents };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

fetchAgents().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
