# Changelog

## [0.1.2] — 2026-06-13

### Changed

- Narrowed error patterns to only match errors Pi doesn't retry natively (`Error from provider`, `Provider Error`, `Request Error`, 4xx excluding 429). Removed patterns for rate limits, 5xx, service unavailable, bad gateway, gateway timeout, upstream connect errors, connection refused/timeout, and internal server error — Pi already handles these.
- Skip retries on timeouts since Pi has its own built-in retry for those.

## [0.1.0] — 2026-06-11

### Added

- Initial release.
- Automatically detect provider errors (400, 5xx, rate limits, connection failures) in assistant responses.
- Send a configurable continuation prompt (`"Go on"`) with exponential backoff (2s, 4s, 8s) instead of re-sending the original user message.
- Up to 3 automatic attempts per user message.
- `/retry` command for manually re-sending the last user prompt.
- Silent failure detection: retries when a provider error prevents any assistant response from being generated.
- Configurable error patterns via `DEFAULT_CONFIG.errorPatterns`.
