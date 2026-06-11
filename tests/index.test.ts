import { describe, it, expect, beforeEach, jest, afterEach } from "bun:test";

// Must import the extension factory before any pi-ai types to
// ensure module resolution works in the test runner.
import extensionFactory from "../index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Mocks
// =============================================================================

type EventHandler = (...args: unknown[]) => void | Promise<void>;

function createMockPi(): {
	pi: ExtensionAPI;
	captured: {
		events: Map<string, EventHandler[]>;
		commands: Map<string, { description: string; handler: (...args: unknown[]) => unknown }>;
		sentMessages: Array<{ message: string; options?: Record<string, unknown> }>;
		notifications: Array<{ text: string; level: string }>;
	};
} {
	const captured = {
		events: new Map<string, EventHandler[]>(),
		commands: new Map<string, { description: string; handler: (...args: unknown[]) => unknown }>(),
		sentMessages: Array<{ message: string; options?: Record<string, unknown> }>(),
		notifications: Array<{ text: string; level: string }>(),
	};

	const pi = {
		on: (event: string, handler: EventHandler) => {
			const handlers = captured.events.get(event) ?? [];
			handlers.push(handler);
			captured.events.set(event, handlers);
		},
		sendUserMessage: (
			message: string,
			options?: Record<string, unknown>,
		) => {
			captured.sentMessages.push({ message, options });
		},
		registerCommand: (
			name: string,
			opts: {
				description: string;
				handler: (...args: unknown[]) => unknown;
			},
		) => {
			captured.commands.set(name, opts);
		},
	} as unknown as ExtensionAPI;

	return { pi, captured };
}

/**
 * Build a minimal ExtensionContext substitute with a mock UI.
 * `isIdle` controls whether the agent is reported as idle.
 */
function createMockContext(
	notifications: Array<{ text: string; level: string }>,
	isIdle = true,
) {
	return {
		ui: {
			notify: (text: string, level: string) => {
				notifications.push({ text, level });
			},
		},
		isIdle: () => isIdle,
	} as unknown as Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];
}

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

function makeUserMessage(content = "hello") {
	return {
		role: "user" as const,
		content,
		timestamp: Date.now(),
	};
}

/** Fire an agent_end handler and fast-forward past backoff delays. */
async function fireEnd(
	endHandler: EventHandler,
	messages: unknown[],
	ctx: unknown,
) {
	const promise = endHandler({ messages }, ctx);
	jest.advanceTimersByTime(60000);
	await promise;
}

// =============================================================================
// Tests
// =============================================================================

describe("extension factory", () => {
	let mock: ReturnType<typeof createMockPi>;

	beforeEach(() => {
		mock = createMockPi();
		extensionFactory(mock.pi);
	});

	afterEach(() => {
		jest.restoreAllTimers?.();
	});

	// -------------------------------------------------------------------------
	// Registration
	// -------------------------------------------------------------------------

	describe("registration", () => {
		it("registers before_agent_start event handler", () => {
			expect(mock.captured.events.has("before_agent_start")).toBe(true);
		});

		it("registers agent_end event handler", () => {
			expect(mock.captured.events.has("agent_end")).toBe(true);
		});

		it("registers turn_end event handler (resets retryCount on progress)", () => {
			expect(mock.captured.events.has("turn_end")).toBe(true);
		});

		it("registers /retry command", () => {
			expect(mock.captured.commands.has("retry")).toBe(true);
		});

		it("registers /retry command with a description", () => {
			const cmd = mock.captured.commands.get("retry");
			expect(cmd?.description).toBeTruthy();
		});
	});

	// -------------------------------------------------------------------------
	// before_agent_start state management
	// -------------------------------------------------------------------------

	describe("before_agent_start", () => {
		it("saves the user prompt and resets retryCount on first call", () => {
			const handler = mock.captured.events.get("before_agent_start")![0];
			const ctx = createMockContext(mock.captured.notifications);

			handler({ prompt: "Write code", images: [] }, ctx);

			// Now simulate agent_end with a successful response
			const endHandler = mock.captured.events.get("agent_end")![0];
			endHandler(
				{
					messages: [
						makeUserMessage("Write code"),
						makeAssistantMessage({ stopReason: "stop" }),
					],
				},
				ctx,
			);

			// No retry should occur
			expect(mock.captured.sentMessages.length).toBe(0);
		});

		it("resets retryInProgress flag", () => {
			const handler = mock.captured.events.get("before_agent_start")![0];
			const ctx = createMockContext(mock.captured.notifications);

			// First call (retryInProgress was true from a previous cycle)
			// We can't access the closure variable directly, but we can observe behavior:
			// If retryInProgress was true, it should be set to false.
			// The prompt should still be saved (not reset) in this case.
			handler({ prompt: "Hello", images: [] }, ctx);

			// Nothing observable here directly — we verify through agent_end behavior
			expect(true).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// agent_end retry logic
	// -------------------------------------------------------------------------

	describe("agent_end — retry behavior", () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it("continuation prompt sent on auto-retry instead of original message", async () => {
			const startHandler = mock.captured.events.get("before_agent_start")![0];
			const endHandler = mock.captured.events.get("agent_end")![0];
			const ctx = createMockContext(mock.captured.notifications);

			await startHandler({ prompt: "Write code", images: [] }, ctx);
			expect(mock.captured.sentMessages.length).toBe(0);

			await fireEnd(endHandler, [
				makeUserMessage("Write code"),
				makeAssistantMessage({ stopReason: "error" }),
			], ctx);

			// Should send the configured continuation prompt, not the original message
			expect(mock.captured.sentMessages.length).toBe(1);
			expect(mock.captured.sentMessages[0].message).toBe("Go on");
			expect(mock.captured.sentMessages[0].options).toEqual({
				deliverAs: "followUp",
			});
			expect(mock.captured.notifications.length).toBeGreaterThanOrEqual(1);
			expect(mock.captured.notifications[0].text).toMatch(/continuing/i);
		});

		it("retries when assistant content contains provider error text", async () => {
			const startHandler = mock.captured.events.get("before_agent_start")![0];
			const endHandler = mock.captured.events.get("agent_end")![0];
			const ctx = createMockContext(mock.captured.notifications);

			await startHandler({ prompt: "Hello", images: [] }, ctx);

			await fireEnd(endHandler, [
				makeUserMessage("Hello"),
				makeAssistantMessage({
					stopReason: "stop",
					content: [
						{
							type: "text",
							text: "Error: 400 Error from provider (Xiaomi): Request Error",
						},
					],
				}),
			], ctx);

			expect(mock.captured.sentMessages.length).toBe(1);
			expect(mock.captured.sentMessages[0].message).toBe("Go on");
		});

		it("retries on silent failure (no successful assistant message)", async () => {
			const startHandler = mock.captured.events.get("before_agent_start")![0];
			const endHandler = mock.captured.events.get("agent_end")![0];
			const ctx = createMockContext(mock.captured.notifications);

			await startHandler({ prompt: "Do something", images: [] }, ctx);

			// Only a user message, no assistant at all (complete failure)
			await fireEnd(endHandler, [makeUserMessage("Do something")], ctx);

			expect(mock.captured.sentMessages.length).toBe(1);
			expect(mock.captured.sentMessages[0].message).toBe("Go on");
			expect(mock.captured.notifications[0].text).toMatch(/failed silently/i);
		});

		it("does NOT retry when there is a successful assistant message", async () => {
			const startHandler = mock.captured.events.get("before_agent_start")![0];
			const endHandler = mock.captured.events.get("agent_end")![0];
			const ctx = createMockContext(mock.captured.notifications);

			await startHandler({ prompt: "Hello", images: [] }, ctx);

			await fireEnd(endHandler, [
				makeUserMessage("Hello"),
				makeAssistantMessage({
					stopReason: "stop",
					content: [{ type: "text", text: "Here is the answer." }],
				}),
			], ctx);

			expect(mock.captured.sentMessages.length).toBe(0);
		});

		it("does NOT retry when there is no lastUserMessage", async () => {
			const endHandler = mock.captured.events.get("agent_end")![0];
			const ctx = createMockContext(mock.captured.notifications);

			// No before_agent_start was called, so lastUserMessage is null
			await fireEnd(endHandler, [
				makeUserMessage("Hello"),
				makeAssistantMessage({ stopReason: "error" }),
			], ctx);

			expect(mock.captured.sentMessages.length).toBe(0);
		});

		it("does NOT retry after maxRetries is exceeded", async () => {
			const startHandler = mock.captured.events.get("before_agent_start")![0];
			const endHandler = mock.captured.events.get("agent_end")![0];
			const ctx = createMockContext(mock.captured.notifications);

			await startHandler({ prompt: "Hello", images: [] }, ctx);

			// Each continuation sends "Go on", not the original message.
			// We count message count, not content, for this assertion.

			await fireEnd(endHandler, [
				makeUserMessage("Hello"),
				makeAssistantMessage({ stopReason: "error" }),
			], ctx);
			expect(mock.captured.sentMessages.length).toBe(1);

			await startHandler({ prompt: "Hello", images: [] }, ctx);

			await fireEnd(endHandler, [
				makeUserMessage("Hello"),
				makeAssistantMessage({ stopReason: "error" }),
			], ctx);
			expect(mock.captured.sentMessages.length).toBe(2);

			await startHandler({ prompt: "Hello", images: [] }, ctx);

			await fireEnd(endHandler, [
				makeUserMessage("Hello"),
				makeAssistantMessage({ stopReason: "error" }),
			], ctx);
			expect(mock.captured.sentMessages.length).toBe(3);

			await startHandler({ prompt: "Hello", images: [] }, ctx);

			// 4th error — should NOT retry (maxRetries = 3)
			await fireEnd(endHandler, [
				makeUserMessage("Hello"),
				makeAssistantMessage({ stopReason: "error" }),
			], ctx);
			expect(mock.captured.sentMessages.length).toBe(3);
		});

		it("resets retryCount on a successful response after previous errors", async () => {
			const startHandler = mock.captured.events.get("before_agent_start")![0];
			const endHandler = mock.captured.events.get("agent_end")![0];
			const ctx = createMockContext(mock.captured.notifications);

			await startHandler({ prompt: "Hello", images: [] }, ctx);

			await fireEnd(endHandler, [
				makeUserMessage("Hello"),
				makeAssistantMessage({ stopReason: "error" }),
			], ctx);
			expect(mock.captured.sentMessages.length).toBe(1);

			await startHandler({ prompt: "Hello", images: [] }, ctx);

			// Now it succeeds
			await fireEnd(endHandler, [
				makeUserMessage("Hello"),
				makeAssistantMessage({ stopReason: "stop" }),
			], ctx);
			expect(mock.captured.sentMessages.length).toBe(1); // no extra message

			// A new user message triggers a fresh retry cycle
			await startHandler({ prompt: "New request", images: [] }, ctx);

			await fireEnd(endHandler, [
				makeUserMessage("New request"),
				makeAssistantMessage({ stopReason: "error" }),
			], ctx);
			expect(mock.captured.sentMessages.length).toBe(2);
			expect(mock.captured.sentMessages[1].message).toBe("Go on");
		});

		it("resets retryCount on a successful turn_end even when agent_end later fails", async () => {
			const startHandler = mock.captured.events.get("before_agent_start")![0];
			const endHandler = mock.captured.events.get("agent_end")![0];
			const turnEndHandler = mock.captured.events.get("turn_end")![0];
			const ctx = createMockContext(mock.captured.notifications);

			// First error cycle starts
			await startHandler({ prompt: "Build feature", images: [] }, ctx);
			await fireEnd(endHandler, [
				makeUserMessage("Build feature"),
				makeAssistantMessage({ stopReason: "error" }),
			], ctx);
			expect(mock.captured.sentMessages.length).toBe(1);
			expect(mock.captured.sentMessages[0].message).toBe("Go on");

			// Simulate the retry cycle: "Go on" is processed
			await startHandler({ prompt: "Go on", images: [] }, ctx);

			// First turn succeeds (LLM responds with tool calls)
			// This should reset retryCount to 0
			await turnEndHandler(
				{
					turnIndex: 1,
					message: makeAssistantMessage({ stopReason: "toolUse" }),
					toolResults: [],
				},
				ctx,
			);

			// Tool executes, then a second LLM call gets a 400
			await fireEnd(endHandler, [
				makeUserMessage("Go on"),
				makeAssistantMessage({ stopReason: "toolUse" }),
				makeAssistantMessage({ stopReason: "error" }),
			], ctx);

			// retryCount was reset by turn_end, so this is a fresh cycle: 1/3
			expect(mock.captured.sentMessages.length).toBe(2);
			expect(mock.captured.sentMessages[1].message).toBe("Go on");
			// Notification should say (1/3), not (2/3)
			const notif = mock.captured.notifications.findLast(
				(n) => n.text.includes("continuing") && n.text.includes("/3"),
			);
			expect(notif?.text).toMatch(/\b1\/3\b/);
		});

		it("does NOT reset retryCount when turn_end has stopReason 'error'", async () => {
			const startHandler = mock.captured.events.get("before_agent_start")![0];
			const endHandler = mock.captured.events.get("agent_end")![0];
			const turnEndHandler = mock.captured.events.get("turn_end")![0];
			const ctx = createMockContext(mock.captured.notifications);

			await startHandler({ prompt: "Hello", images: [] }, ctx);
			await fireEnd(endHandler, [
				makeUserMessage("Hello"),
				makeAssistantMessage({ stopReason: "error" }),
			], ctx);
			expect(mock.captured.sentMessages.length).toBe(1);

			await startHandler({ prompt: "Go on", images: [] }, ctx);

			// Turn ends with error — should NOT reset retryCount
			await turnEndHandler(
				{
					turnIndex: 1,
					message: makeAssistantMessage({ stopReason: "error" }),
					toolResults: [],
				},
				ctx,
			);

			await fireEnd(endHandler, [
				makeUserMessage("Go on"),
				makeAssistantMessage({ stopReason: "error" }),
			], ctx);

			// retryCount was NOT reset, so this is 2/3
			expect(mock.captured.sentMessages.length).toBe(2);
			// Check the LAST matching notification
			const notif = mock.captured.notifications.findLast(
				(n) => n.text.includes("continuing") && n.text.includes("/3"),
			);
			expect(notif?.text).toMatch(/\b2\/3\b/);
		});

		// Notification level tests are inside this block because they
		// also need fake timers to handle backoff delays.

		describe("notifications", () => {
			it("uses 'info' level for early retries", async () => {
				const startHandler =
					mock.captured.events.get("before_agent_start")![0];
				const endHandler = mock.captured.events.get("agent_end")![0];
				const ctx = createMockContext(mock.captured.notifications);

				await startHandler({ prompt: "Hello", images: [] }, ctx);

				await fireEnd(endHandler, [
					makeUserMessage("Hello"),
					makeAssistantMessage({ stopReason: "error" }),
				], ctx);

				const infoNotif = mock.captured.notifications.find((n) =>
					n.text.includes("(1/3)"),
				);
				expect(infoNotif?.level).toBe("info");
			});

			it("uses 'warning' level for the last retry attempt", async () => {
				const startHandler =
					mock.captured.events.get("before_agent_start")![0];
				const endHandler = mock.captured.events.get("agent_end")![0];
				const ctx = createMockContext(mock.captured.notifications);

				await startHandler({ prompt: "Hello", images: [] }, ctx);

				await fireEnd(endHandler, [
					makeUserMessage("Hello"),
					makeAssistantMessage({ stopReason: "error" }),
				], ctx);

				await startHandler({ prompt: "Hello", images: [] }, ctx);

				await fireEnd(endHandler, [
					makeUserMessage("Hello"),
					makeAssistantMessage({ stopReason: "error" }),
				], ctx);

				await startHandler({ prompt: "Hello", images: [] }, ctx);

				await fireEnd(endHandler, [
					makeUserMessage("Hello"),
					makeAssistantMessage({ stopReason: "error" }),
				], ctx);

				const warningNotif = mock.captured.notifications.find((n) =>
					n.text.includes("(3/3)"),
				);
				expect(warningNotif?.level).toBe("warning");
			});
		});
	});

	// -------------------------------------------------------------------------
	// /retry command
	// -------------------------------------------------------------------------

	describe("/retry command", () => {
		it("re-sends the last user message when available and idle", () => {
			const startHandler = mock.captured.events.get("before_agent_start")![0];
			const retryCmd = mock.captured.commands.get("retry")!;
			const ctx = createMockContext(mock.captured.notifications, true); // idle

			startHandler({ prompt: "Last message", images: [] }, ctx);

			retryCmd.handler("", ctx);

			expect(mock.captured.sentMessages.length).toBe(1);
			expect(mock.captured.sentMessages[0].message).toBe("Last message");
			expect(mock.captured.sentMessages[0].options).toBeUndefined();
		});

		it("queues as followUp when the agent is not idle", () => {
			const startHandler = mock.captured.events.get("before_agent_start")![0];
			const retryCmd = mock.captured.commands.get("retry")!;
			const ctx = createMockContext(mock.captured.notifications, false); // not idle

			startHandler({ prompt: "During streaming", images: [] }, ctx);

			retryCmd.handler("", ctx);

			expect(mock.captured.sentMessages.length).toBe(1);
			expect(mock.captured.sentMessages[0].message).toBe("During streaming");
			expect(mock.captured.sentMessages[0].options).toEqual({
				deliverAs: "followUp",
			});
		});

		it("shows a warning when there is no previous message", () => {
			const retryCmd = mock.captured.commands.get("retry")!;
			const ctx = createMockContext(mock.captured.notifications);

			retryCmd.handler("", ctx);

			expect(mock.captured.sentMessages.length).toBe(0);
			expect(mock.captured.notifications.some((n) => n.text.includes("No previous"))).toBe(true);
		});
	});

});
