# @furkanbilgin/pi-retry

Auto-retry Pi extension — automatically recovers when provider errors occur mid-conversation (e.g. `Error: 400 Error from provider (Xiaomi): Request Error`). Sends `"Go on"` with exponential backoff instead of forcing you to notice the error and re-prompt.

## Install

```bash
pi install npm:@furkanbilgin/pi-retry
/reload
```

## How it works

When the agent hits a transient provider error, the extension sends `"Go on"` as a follow-up message (2s, 4s, 8s backoff, up to 3 attempts). It re-sends the original prompt only on manual `/retry` — re-sending old prompts mid-conversation rarely makes sense.

## Configuration

Edit `retryPrompt` or `maxRetries` etc. in `lib.ts` → `DEFAULT_CONFIG`, then run `/reload`.

## Commands

| Command | Description |
|---------|-------------|
| `/retry` | Re-send the last user message (sends the original prompt, not "Go on") |

## Requirements

- Pi v0.79+
- No additional npm dependencies

## License

MIT
