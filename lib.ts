import type { AgentMessage } from "@earendil-works/pi-coding-agent";

// --- Configuration -----------------------------------------------------------

export const DEFAULT_CONFIG = {
	/** Maximum number of automatic retries per user message. */
	maxRetries: 3,
	/** Base delay between retries in milliseconds (exponential backoff: delay * 2^attempt). */
	baseDelayMs: 2000,
	/** Maximum delay between retries. */
	maxDelayMs: 30000,
	/**
	 * Regex patterns that identify provider-level errors.
	 * Matched against assistant errorMessage, stopReason, and text content.
	 */
	errorPatterns: [
		/Error from provider/i,
		/\b4\d{2}\s+Error\b/,
		/\b5\d{2}\s+Error\b/,
		/Provider.*Error/i,
		/Request Error/i,
		/rate limit/i,
		/too many requests/i,
		/service unavailable/i,
		/bad gateway/i,
		/gateway timeout/i,
		/upstream connect error/i,
		/connection refused/i,
		/connection timeout/i,
		/internal server error/i,
	],
	/**
	 * When true, retries even when no assistant message was produced
	 * (the provider call failed entirely before generating any response).
	 */
	retryOnSilentFailure: true,
	/**
	 * Prompt sent on auto-retry instead of the original user message.
	 * Re-sending a message the user typed 15 minutes ago rarely makes sense
	 * mid-conversation — a simple continuation prompt works better.
	 */
	retryPrompt: "Go on",
} as const;

export type Config = typeof DEFAULT_CONFIG;

// --- Helpers -----------------------------------------------------------------

/**
 * Check if any pattern in the list matches the given text.
 */
export function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((p) => p.test(text));
}

/**
 * Determine whether an agent message indicates a provider-level error.
 *
 * Checks three signals:
 * 1. `stopReason === "error"` on assistant messages
 * 2. `errorMessage` field matching error patterns
 * 3. Assistant text content matching error patterns
 */
export function isProviderError(
	msg: AgentMessage,
	patterns: readonly RegExp[],
): boolean {
	if (msg.role !== "assistant") return false;

	// Check stopReason
	if (msg.stopReason === "error") return true;

	// Check errorMessage field
	if (msg.errorMessage && matchesAny(msg.errorMessage, patterns)) return true;

	// Check text content
	if (Array.isArray(msg.content)) {
		for (const part of msg.content) {
			if (part.type === "text" && matchesAny(part.text, patterns)) return true;
		}
	}

	return false;
}

/**
 * Check whether the conversation has at least one assistant message
 * that completed normally (stopReason !== "error").
 * Used to detect silent failures where a provider error prevented
 * any assistant response.
 */
export function hasSuccessfulAssistantMessage(
	messages: AgentMessage[],
): boolean {
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		if (msg.stopReason !== "error") return true;
	}
	return false;
}

/**
 * Compute the exponential backoff delay for a given attempt number.
 *
 * delay = min(baseDelayMs * 2^(attempt - 1), maxDelayMs)
 *
 * @param attempt - 1-based attempt counter
 * @param baseDelayMs - initial delay
 * @param maxDelayMs - maximum delay cap
 */
export function computeBackoffDelay(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
): number {
	return Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
}
