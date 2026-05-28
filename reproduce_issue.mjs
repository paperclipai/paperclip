import fetch from 'node-fetch';

async function main() {
  const issueId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const url = `http://localhost:3000/api/issues/${issueId}/interactions`;

  const payload = {
    kind: "comment",
    payload: {
      version: 1,
      content: `This is a multi-paragraph markdown body.

- First bullet point
- Second bullet point

And here's another paragraph with **bold** and *italic* text.`
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log('Status:', response.status);
    console.log('Response:', await response.text());
  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
