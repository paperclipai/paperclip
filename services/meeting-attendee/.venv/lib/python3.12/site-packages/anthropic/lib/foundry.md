# Anthropic Foundry

To use this library with Foundry, use the `AnthropicFoundry` class instead of the `Anthropic` class.


## Installation

```bash
pip install anthropic
```

## Usage

### Basic Usage with API Key

```python
from anthropic import AnthropicFoundry

client = AnthropicFoundry(
    api_key="...",  # defaults to ANTHROPIC_FOUNDRY_API_KEY environment variable
    resource="my-resource",  # your Foundry resource
)

message = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)

print(message.content[0].text)
```

### Using Azure AD Token Provider

For enhanced security, you can use Azure AD (Microsoft Entra) authentication instead of an API key:

```python
from anthropic import AnthropicFoundry
from azure.identity import DefaultAzureCredential
from azure.identity import get_bearer_token_provider

credential = DefaultAzureCredential()
token_provider = get_bearer_token_provider(
    credential, 
    "https://ai.azure.com/.default"
)

client = AnthropicFoundry(
    azure_ad_token_provider=token_provider,
    resource="my-resource",
)

message = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)

print(message.content[0].text)
```

## Examples

### Streaming Messages

```python
from anthropic import AnthropicFoundry

client = AnthropicFoundry(
    api_key="...",
    resource="my-resource",
)

with client.messages.stream(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a haiku about programming"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

### Async Usage

```python
from anthropic import AsyncAnthropicFoundry

async def main():
    client = AsyncAnthropicFoundry(
        api_key="...",
        resource="my-resource",
    )
    
    message = await client.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=1024,
        messages=[{"role": "user", "content": "Hello!"}],
    )
    
    print(message.content[0].text)

import asyncio
asyncio.run(main())
```

### Async Streaming

```python
from anthropic import AsyncAnthropicFoundry

async def main():
    client = AsyncAnthropicFoundry(
        api_key="...",
        resource="my-resource",
    )
    
    async with client.messages.stream(
        model="claude-3-5-sonnet-20241022",
        max_tokens=1024,
        messages=[{"role": "user", "content": "Write a haiku about programming"}],
    ) as stream:
        async for text in stream.text_stream:
            print(text, end="", flush=True)

import asyncio
asyncio.run(main())
```