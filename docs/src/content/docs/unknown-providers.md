---
title: Add an unknown provider
slug: advanced/unknown-providers
---

# Add an unknown provider

Harnez can use a provider that is not built into its model catalog when the
provider exposes an OpenAI-compatible Chat Completions API.

## Add the provider

Add a named provider to `~/.config/harnez/settings.json`:

```json
{
  "providers": {
    "my-provider": {
      "type": "openai-compatible",
      "baseUrl": "https://llm.example.com/v1",
      "auth": "api-key",
      "models": ["my-coder-model", "my-chat-model"]
    }
  },
  "model": {
    "provider": "my-provider",
    "model": "my-coder-model"
  }
}
```

The provider name is your own stable ID. `models` contains the exact model IDs
accepted by the endpoint. Keep API keys out of this file.

Restart Harnez after editing the settings file:

```text
harnez server restart
```

## Authenticate and select a model

Open the provider's authentication flow:

```text
/login my-provider
```

Choose API-key authentication and enter the secret. Harnez stores it in
`~/.config/harnez/auth.json`, separately from other providers.

Select a configured model from the picker:

```text
/model my-provider
```

Or select it directly:

```text
/model my-provider my-coder-model
```

## Use a keyless local provider

For a local server that does not require authentication, use `auth: "none"`:

```json
{
  "providers": {
    "ollama": {
      "type": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "auth": "none",
      "models": ["qwen3-coder:30b"]
    }
  },
  "model": {
    "provider": "ollama",
    "model": "qwen3-coder:30b"
  }
}
```

No `/login` is required. Harnez sends the placeholder header
`Authorization: Bearer unused`, which the local server must tolerate.

## Compatibility requirements

The endpoint must support streaming `POST /v1/chat/completions`. It must also
support OpenAI-style tool calls for Harnez to use workspace tools. Responses
API endpoints and automatic model discovery are not currently supported.

See [Configuration](/docs/configuration) for project-level overrides,
validation rules, fast-cycle configuration, and credential locations.
