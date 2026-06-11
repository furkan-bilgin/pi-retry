import { describe, it, expect } from "bun:test";

import {
	matchesAny,
	isProviderError,
	hasSuccessfulAssistantMessage,
	computeBackoffDelay,
	DEFAULT_CONFIG,
	type Config,
} from "../lib.ts";

// --- Helpers -----------------------------------------------------------------

const patterns: readonly RegExp[] = DEFAULT_CONFIG.errorPatterns;

function makeAssistantMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "" }],
		api: "chat",
		provider: "test",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop" as const,
		timestamp: Date.now(),
		...overrides,
	};
}

function makeUserMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "user" as const,
		content: "hello",
		timestamp: Date.now(),
		...overrides,
	};
}

function makeToolResultMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "toolResult" as const,
		content: [{ type: "text" as const, text: "" }],
		toolCallId: "call_1",
		toolName: "test_tool",
		isError: false,
		...overrides,
	};
}

// =============================================================================
// matchesAny
// =============================================================================

describe("matchesAny", () => {
	it("returns true when a pattern matches", () => {
		expect(matchesAny("Error from provider (Xiaomi)", patterns)).toBe(true);
	});

	it("returns true for 400 Error", () => {
		expect(matchesAny("400 Error from provider", patterns)).toBe(true);
	});

	it("returns true for 502 Error", () => {
		expect(matchesAny("502 Error: Bad Gateway", patterns)).toBe(true);
	});

	it("returns true for rate limit", () => {
		expect(matchesAny("Rate limit exceeded", patterns)).toBe(true);
	});

	it("returns true for connection refused", () => {
		expect(matchesAny("Connection refused", patterns)).toBe(true);
	});

	it("returns true for service unavailable", () => {
		expect(matchesAny("Service Unavailable", patterns)).toBe(true);
	});

	it("returns true for internal server error", () => {
		expect(matchesAny("Internal Server Error", patterns)).toBe(true);
	});

	it("returns false for normal text", () => {
		expect(matchesAny("Here is the result you requested", patterns)).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(matchesAny("", patterns)).toBe(false);
	});

	it("matches case-insensitively", () => {
		expect(matchesAny("ERROR FROM PROVIDER", patterns)).toBe(true);
		expect(matchesAny("Rate LIMIT", patterns)).toBe(true);
	});

	it("does not match standalone numbers like 400 or 200", () => {
		expect(matchesAny("The status code was 200", patterns)).toBe(false);
		expect(matchesAny("Status: 200 OK", patterns)).toBe(false);
	});

	it("matches 400 without the word Error right after", () => {
		// The pattern is \b4\d{2}\s+Error\b so it needs "Error" after
		expect(matchesAny("Got 400 from API", patterns)).toBe(false);
	});

	it("returns false when no patterns are provided", () => {
		expect(matchesAny("Error from provider", [])).toBe(false);
	});
});

// =============================================================================
// isProviderError
// =============================================================================

describe("isProviderError", () => {
	it("returns true when stopReason is 'error'", () => {
		const msg = makeAssistantMessage({ stopReason: "error" });
		expect(isProviderError(msg, patterns)).toBe(true);
	});

	it("returns true when stopReason is 'error' even without errorMessage", () => {
		const msg = makeAssistantMessage({
			stopReason: "error",
			errorMessage: undefined,
		});
		expect(isProviderError(msg, patterns)).toBe(true);
	});

	it("returns true when errorMessage matches a pattern", () => {
		const msg = makeAssistantMessage({
			stopReason: "stop",
			errorMessage: "Error from provider: 400 Bad Request",
		});
		expect(isProviderError(msg, patterns)).toBe(true);
	});

	it("does NOT match when content merely mentions an error (only stopReason and errorMessage are reliable)", () => {
		// The assistant innocently describing an earlier error should not
		// trigger a retry — only stopReason "error" and errorMessage do.
		const msg = makeAssistantMessage({
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: "Error: 400 Error from provider (Xiaomi): Request Error",
				},
			],
		});
		expect(isProviderError(msg, patterns)).toBe(false);
	});

	it("returns false for a normal assistant message", () => {
		const msg = makeAssistantMessage({
			stopReason: "stop",
			content: [{ type: "text", text: "Here is the answer." }],
		});
		expect(isProviderError(msg, patterns)).toBe(false);
	});

	it("returns false for user messages regardless of content", () => {
		const msg = makeUserMessage({ content: "Error from provider" });
		expect(isProviderError(msg, patterns)).toBe(false);
	});

	it("returns false for tool result messages regardless of content", () => {
		const msg = makeToolResultMessage();
		expect(isProviderError(msg, patterns)).toBe(false);
	});

	it("returns false for assistant with stopReason 'stop' and no matching text", () => {
		const msg = makeAssistantMessage({
			stopReason: "stop",
			errorMessage: undefined,
			content: [{ type: "text", text: "All good here." }],
		});
		expect(isProviderError(msg, patterns)).toBe(false);
	});

	it("returns false for assistant with stopReason 'aborted' and no matching text", () => {
		const msg = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: undefined,
			content: [{ type: "text", text: "Request aborted by user" }],
		});
		expect(isProviderError(msg, patterns)).toBe(false);
	});

	it("returns false for assistant with stopReason 'toolUse' (normal tool calling)", () => {
		const msg = makeAssistantMessage({
			stopReason: "toolUse",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "bash",
					input: { command: "ls" },
				},
			],
		});
		expect(isProviderError(msg, patterns)).toBe(false);
	});

	it("does not match assistant content that merely mentions an error", () => {
		// The assistant talking about an earlier error should NOT trigger a
		// retry — only stopReason "error" and errorMessage are reliable signals.
		const msg = makeAssistantMessage({
			stopReason: "stop",
			content: [
				{ type: "text", text: "The 400 Error from provider was transient, fixed now." },
			],
		});
		expect(isProviderError(msg, patterns)).toBe(false);
	});

	it("handles messages with empty content array", () => {
		const msg = makeAssistantMessage({
			stopReason: "stop",
			content: [],
		});
		expect(isProviderError(msg, patterns)).toBe(false);
	});
});

// =============================================================================
// hasSuccessfulAssistantMessage
// =============================================================================

describe("hasSuccessfulAssistantMessage", () => {
	it("returns true when there is an assistant with stopReason 'stop'", () => {
		const msgs = [
			makeUserMessage(),
			makeAssistantMessage({ stopReason: "stop" }),
		];
		expect(hasSuccessfulAssistantMessage(msgs)).toBe(true);
	});

	it("returns true when there is an assistant with stopReason 'toolUse'", () => {
		const msgs = [
			makeUserMessage(),
			makeAssistantMessage({ stopReason: "toolUse" }),
		];
		expect(hasSuccessfulAssistantMessage(msgs)).toBe(true);
	});

	it("returns true when there is an assistant with stopReason 'length'", () => {
		const msgs = [
			makeUserMessage(),
			makeAssistantMessage({ stopReason: "length" }),
		];
		expect(hasSuccessfulAssistantMessage(msgs)).toBe(true);
	});

	it("returns false when the only assistant has stopReason 'error'", () => {
		const msgs = [
			makeUserMessage(),
			makeAssistantMessage({ stopReason: "error" }),
		];
		expect(hasSuccessfulAssistantMessage(msgs)).toBe(false);
	});

	it("returns false when there are no assistant messages at all", () => {
		const msgs = [makeUserMessage()];
		expect(hasSuccessfulAssistantMessage(msgs)).toBe(false);
	});

	it("returns false for an empty message array", () => {
		expect(hasSuccessfulAssistantMessage([])).toBe(false);
	});

	it("returns true when there is a mix of error and successful assistants", () => {
		const msgs = [
			makeUserMessage(),
			makeAssistantMessage({ stopReason: "error" }),
			makeAssistantMessage({ stopReason: "stop" }),
		];
		expect(hasSuccessfulAssistantMessage(msgs)).toBe(true);
	});

	it("ignores tool result and user messages when checking", () => {
		// Only assistant messages are considered
		const msgs = [
			makeUserMessage(),
			makeToolResultMessage(),
			makeAssistantMessage({ stopReason: "error" }),
		];
		expect(hasSuccessfulAssistantMessage(msgs)).toBe(false);
	});

	it("returns true when there are only tool results and a successful assistant", () => {
		const msgs = [
			makeToolResultMessage(),
			makeAssistantMessage({ stopReason: "stop" }),
		];
		expect(hasSuccessfulAssistantMessage(msgs)).toBe(true);
	});
});

// =============================================================================
// computeBackoffDelay
// =============================================================================

describe("computeBackoffDelay", () => {
	it("returns baseDelayMs for attempt 1", () => {
		expect(computeBackoffDelay(1, 2000, 30000)).toBe(2000);
	});

	it("doubles for attempt 2", () => {
		expect(computeBackoffDelay(2, 2000, 30000)).toBe(4000);
	});

	it("doubles again for attempt 3", () => {
		expect(computeBackoffDelay(3, 2000, 30000)).toBe(8000);
	});

	it("caps at maxDelayMs", () => {
		// 2000 * 2^4 = 32000, capped at 30000
		expect(computeBackoffDelay(5, 2000, 30000)).toBe(30000);
	});

	it("works with different base values", () => {
		expect(computeBackoffDelay(1, 1000, 10000)).toBe(1000);
		expect(computeBackoffDelay(2, 1000, 10000)).toBe(2000);
		expect(computeBackoffDelay(3, 1000, 10000)).toBe(4000);
		expect(computeBackoffDelay(4, 1000, 10000)).toBe(8000);
		expect(computeBackoffDelay(5, 1000, 10000)).toBe(10000); // capped
	});

	it("caps at maxDelayMs even for very large attempts", () => {
		expect(computeBackoffDelay(100, 2000, 30000)).toBe(30000);
	});

	it("returns baseDelayMs when maxDelayMs is smaller", () => {
		// When maxDelayMs is less than baseDelayMs, cap wins immediately
		expect(computeBackoffDelay(1, 5000, 3000)).toBe(3000);
	});

	it("handles attempt 0 gracefully (returns baseDelayMs)", () => {
		// 2^(-1) = 0.5, so baseDelayMs * 0.5
		expect(computeBackoffDelay(0, 2000, 30000)).toBe(1000);
	});
});

// =============================================================================
// DEFAULT_CONFIG
// =============================================================================

describe("DEFAULT_CONFIG", () => {
	it("has retryPrompt set to 'Go on'", () => {
		expect(DEFAULT_CONFIG.retryPrompt).toBe("Go on");
	});

	it("has maxRetries of 3", () => {
		expect(DEFAULT_CONFIG.maxRetries).toBe(3);
	});

	it("has retryOnSilentFailure set to true", () => {
		expect(DEFAULT_CONFIG.retryOnSilentFailure).toBe(true);
	});
});
