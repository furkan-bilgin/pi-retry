/**
 * Auto-Retry Pi Package
 *
 * Automatically retries requests when provider errors are detected
 * (e.g., "Error: 400 Error from provider (Xiaomi): Request Error").
 * Retries without requiring user input.
 *
 * Also provides a /retry command for manual retry.
 *
 * Install:
 *   cd ~/Programming/pi-retry
 *   pi install .
 *   /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	DEFAULT_CONFIG,
	isProviderError,
	hasSuccessfulAssistantMessage,
	computeBackoffDelay,
	type Config,
} from "./lib.js";

const CONFIG: Config = DEFAULT_CONFIG;

// --- Extension ---------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// State ----------------------------------------------------------------

	/** The last user prompt sent to the agent (saved in before_agent_start). */
	let lastUserMessage: string | null = null;
	/** Current retry attempt count for the active message. */
	let retryCount = 0;
	/** True while an automatic retry is queued (suppresses retryCount reset). */
	let retryInProgress = false;

	// Helpers --------------------------------------------------------------

	/** Exponential backoff sleep. */
	async function backoff(attempt: number): Promise<void> {
		const delay = computeBackoffDelay(
			attempt,
			CONFIG.baseDelayMs,
			CONFIG.maxDelayMs,
		);
		await new Promise((resolve) => setTimeout(resolve, delay));
	}

	// Events ---------------------------------------------------------------

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!retryInProgress) {
			lastUserMessage = event.prompt;
			retryCount = 0;
		}
		retryInProgress = false;
	});

	/**
	 * Reset retryCount whenever a single turn completes successfully.
	 * This solves the case where a "Go on" retry triggers a multi-turn
	 * agent cycle: the first turn(s) might work fine (tool calls, partial
	 * responses) while a later turn in the same cycle gets a provider error.
	 * Without this, agent_end sees the final error and keeps incrementing
	 * retryCount, even though the retry clearly made progress.
	 */
	pi.on("turn_end", async (event, _ctx) => {
		if (
			event.message.role === "assistant" &&
			event.message.stopReason !== "error" &&
			event.message.stopReason !== "aborted"
		) {
			retryCount = 0;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!lastUserMessage) return;
		if (retryCount >= CONFIG.maxRetries) return;

		// Never retry when the user manually aborted (pressed Escape).
		// The stopReason is "aborted" on the assistant message, and the
		// errorMessage or text content may contain "aborted".
		const wasAborted = event.messages.some(
			(msg) =>
				(msg.role === "assistant" && msg.stopReason === "aborted") ||
				(msg as { errorMessage?: string }).errorMessage?.toLowerCase().includes("aborted"),
		);
		if (wasAborted) {
			retryCount = 0;
			return;
		}

		// Never retry on timeouts — Pi has its own built-in retry for those.
		const wasTimeout = event.messages.some(
			(msg) =>
				(msg as { errorMessage?: string }).errorMessage
					?.toLowerCase()
					.includes("timed out"),
		);
		if (wasTimeout) {
			retryCount = 0;
			return;
		}

		const patterns = CONFIG.errorPatterns;

		// Detect provider errors in assistant messages
		const explicitError = event.messages.some(
			(msg) => isProviderError(msg, patterns),
		);

		// Detect silent failure: no successful assistant message at all
		const silentFailure =
			CONFIG.retryOnSilentFailure &&
			!hasSuccessfulAssistantMessage(event.messages);

		if (!explicitError && !silentFailure) {
			retryCount = 0; // Reset on success
			return;
		}

		const reason = explicitError
			? "Provider error detected"
			: "Provider call failed silently";

		retryCount++;
		retryInProgress = true;

		ctx.ui.notify(
			`${reason}, continuing (${retryCount}/${CONFIG.maxRetries})...`,
			retryCount >= CONFIG.maxRetries - 1 ? "warning" : "info",
		);

		await backoff(retryCount);

		// Send a continuation prompt to nudge the agent forward.
		// Re-sending the original user message from many turns ago rarely
		// makes sense mid-conversation.
		// Use followUp so it queues after the current agent lifecycle settles.
		try {
			pi.sendUserMessage(CONFIG.retryPrompt, { deliverAs: "followUp" });
		} catch (e) {
			ctx.ui.notify(
				`Auto-retry failed: ${e instanceof Error ? e.message : e}`,
				"error",
			);
			retryInProgress = false;
		}
	});

	// Manual retry command -------------------------------------------------

	pi.registerCommand("retry", {
		description: "Re-send the last user message (manual retry)",
		handler: async (_args, ctx) => {
			if (!lastUserMessage) {
				ctx.ui.notify("No previous message to retry", "warning");
				return;
			}
			ctx.ui.notify("Retrying last message...", "info");
			retryInProgress = true;
			// If the agent is mid-stream, queue as a follow-up
			if (ctx.isIdle()) {
				pi.sendUserMessage(lastUserMessage);
			} else {
				pi.sendUserMessage(lastUserMessage, { deliverAs: "followUp" });
			}
		},
	});
}
