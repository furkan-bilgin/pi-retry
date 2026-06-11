# Changelog

## [0.1.0] — 2026-06-11

### Added

- Initial release.
- Automatically detect provider errors (400, 5xx, rate limits, connection failures) in assistant responses.
- Send a configurable continuation prompt (`"Go on"`) with exponential backoff (2s, 4s, 8s) instead of re-sending the original user message.
- Up to 3 automatic attempts per user message.
- `/retry` command for manually re-sending the last user prompt.
- Silent failure detection: retries when a provider error prevents any assistant response from being generated.
- Configurable error patterns via `DEFAULT_CONFIG.errorPatterns`.
