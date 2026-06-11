# pi-retry

Auto-retry Pi extension — automatically recovers when provider errors occur mid-conversation, without requiring you to type anything.

When Pi encounters a transient provider error such as `Error: 400 Error from provider (Xiaomi): Request Error`, this extension sends a continuation prompt ("Go on") with exponential backoff instead of forcing you to notice the error and manually re-prompt.

## Install

```bash
cd ~/Programming/pi-retry
pi install .
```

Then run `/reload` inside Pi.

To verify it's installed, you should see `pi-retry` listed in your Pi packages (check `~/.pi/settings.json` under `"packages"`).

## How It Works

1. **Saves your prompt** when `before_agent_start` fires (used only for `/retry` command).
2. **Detects provider errors** in `agent_end` by checking three signals:
   - `stopReason: "error"` on assistant messages.
   - `errorMessage` field matching known error patterns.
   - Assistant text content matching patterns like `400 Error`, `Error from provider`, `rate limit`, `bad gateway`, etc.
3. **Handles silent failures** — if the agent ended without producing any successful assistant message (the call failed entirely), it retries too.
4. **Sends a continuation prompt** ("Go on") to nudge the agent forward. Re-sending the original message from many turns ago rarely makes sense mid-conversation.
5. **Exponential backoff:** 2s, 4s, 8s between attempts.

```
User sends message ──► before_agent_start (save prompt)
        │
        ▼
   agent processes (maybe 10+ turns)
        │
        ▼
   agent_end ──► Provider error? ──► wait ──► send "Go on"
       │                                │
       │                                ▼
       │                           attempt 1/3, 2/3, 3/3
       ▼
  No error ──► reset counter, idle
```

## Why "Go on" instead of the original message?

Provider errors often happen deep into a multi-turn conversation — after the agent has already processed your request across many tool calls. Re-sending "Write a feature that does X" from 15 minutes ago would restart from scratch and lose all context. A simple "Go on" tells the agent to continue where it left off.

## Configuration

Edit `lib.ts` — the `DEFAULT_CONFIG` object:

```typescript
const DEFAULT_CONFIG = {
  // Max automatic retry attempts per user message
  maxRetries: 3,

  // Base backoff delay (doubles each attempt: 2s, 4s, 8s...)
  baseDelayMs: 2000,

  // Ceiling for backoff delay
  maxDelayMs: 30000,

  // Regex patterns that identify provider-level errors
  errorPatterns: [
    /Error from provider/i,
    /\b4\d{2}\s+Error\b/,
    // ...
  ],

  // Retry when no assistant message was produced at all
  retryOnSilentFailure: true,

  // Prompt sent on auto-retry instead of the original user message
  retryPrompt: "Go on",
};
```

After changing config, run `/reload` to apply.

Note: to apply changes to `lib.ts`, you need to delete any cached copy that jiti may have stored. Run `/reload` after editing; if the change doesn't take effect, restart Pi entirely.

## Commands

| Command | Description |
|---------|-------------|
| `/retry` | Manually re-send the last user message. Unlike auto-retry, this sends the *original* prompt. Useful when you want to restart from a known point. |

## Notifications

During a recovery cycle, Pi shows:

- `Provider error detected, continuing (1/3)...` (info)
- `Provider error detected, continuing (2/3)...` (info)
- `Provider error detected, continuing (3/3)...` (warning — last attempt)

If all 3 attempts fail, the error response remains visible.

## Manual Retry

Type `/retry` at any point to re-send the last user prompt. Unlike auto-retry, this sends the original message, not "Go on".

## Requirements

- Pi v0.79+ (extension API supporting `before_agent_start` and `agent_end` events).
- No additional npm dependencies.

## Files

```
pi-retry/
  package.json    # Pi package manifest
  lib.ts          # Config, pure logic (matchesAny, isProviderError, ...)
  index.ts        # Extension factory (wires events and state)
  README.md       # This file
  LICENSE         # MIT
  tests/
    lib.test.ts   # Unit tests for pure functions (42 tests)
    index.test.ts # Integration tests for extension (19 tests)
```

## How It Differs From Built-in Behavior

Without this extension, when a provider returns a 400/5xx error mid-conversation, Pi displays the error and waits. You have to notice, copy/remember your original request, and type it again — which often doesn't make sense because the agent was already partway through the work. This extension sends a continuation prompt automatically.

## License

MIT
