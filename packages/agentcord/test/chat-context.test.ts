import { describe, expect, test } from "bun:test";
import { ContextFilter } from "../src/chat/context-filter";
import type { ChatMessage } from "../src/types";

describe("Agentcord Context Protection (GC vs DM)", () => {
	const messages: ChatMessage[] = [
		{
			id: "m1",
			type: "gc",
			from: "[User: Alice]",
			fromUser: "Alice",
			text: "Hey everyone, welcome to the project! Let's get started on the sprint.",
			timestamp: 1000,
		},
		{
			id: "m2",
			type: "gc",
			from: "[User: Bob]",
			fromUser: "Bob",
			text: "Sounds great. Grabbing some coffee right now.",
			timestamp: 1001,
		},
		{
			id: "m3",
			type: "gc",
			from: "[User: Alice]",
			fromUser: "Alice",
			text: "@King please prioritize the auth modules first.",
			timestamp: 1002,
		},
		{
			id: "m4",
			type: "dm",
			from: "[Worker: Bob - DBWorker]",
			fromUser: "Bob",
			to: "[Queen: Alice]",
			text: "Could you specify the schema for user session tokens?",
			timestamp: 1003,
		},
		{
			id: "m5",
			type: "dm",
			from: "[Queen: Alice]",
			fromUser: "Alice",
			to: "[Worker: Bob - DBWorker]",
			text: "Sessions should have id, userId, expiresAt, and refreshTokenHash.",
			timestamp: 1004,
		},
		{
			id: "m6",
			type: "dm",
			from: "[Queen: Bob]",
			fromUser: "Bob",
			to: "[King: Alice]",
			text: "Should we implement Redis caching for sessions?",
			timestamp: 1005,
		},
	];

	test("GC messages are NOT dumped over agents unless explicitly mentioned", () => {
		// Test for Queen Bob:
		// Queen Bob should NOT receive m1, m2 (general GC chatter), m3 (mentions @King, not Queen Bob),
		// nor m4/m5 (DM between DBWorker and Queen Alice).
		// Queen Bob should ONLY receive m6 (DM sent by Queen Bob to King Alice).
		const queenBobContext = ContextFilter.filterForAgent("[Queen: Bob]", "queen", messages);
		expect(queenBobContext.length).toBe(1);
		expect(queenBobContext[0]!.id).toBe("m6");

		// Test for King Alice:
		// King Alice should receive m3 (specifically mentions @King) and m6 (DM addressed to [King: Alice]).
		// King Alice should NOT receive m1, m2 (unmentioned GC), nor m4/m5 (DM between DBWorker and Queen Alice).
		const kingContext = ContextFilter.filterForAgent("[King: Alice]", "king", messages);
		expect(kingContext.length).toBe(2);
		expect(kingContext.map(m => m.id)).toEqual(["m3", "m6"]);
	});

	test("DM messages are isolated strictly to the sender and recipient agents", () => {
		// DBWorker only receives m4 and m5
		const workerContext = ContextFilter.filterForAgent(
			"[Worker: Bob - DBWorker]",
			"worker",
			messages
		);
		expect(workerContext.length).toBe(2);
		expect(workerContext[0]!.id).toBe("m4");
		expect(workerContext[1]!.id).toBe("m5");

		// Queen Alice receives m4 and m5
		const queenAliceContext = ContextFilter.filterForAgent("[Queen: Alice]", "queen", messages);
		expect(queenAliceContext.length).toBe(2);
		expect(queenAliceContext[0]!.id).toBe("m4");
		expect(queenAliceContext[1]!.id).toBe("m5");
	});

	test("formats prompt transcript cleanly with zero context leakage", () => {
		const workerContext = ContextFilter.filterForAgent(
			"[Worker: Bob - DBWorker]",
			"worker",
			messages
		);
		const transcript = ContextFilter.formatContextTranscript(workerContext);

		expect(transcript).toContain("[DM to [Queen: Alice]]");
		expect(transcript).toContain("schema for user session tokens");
		expect(transcript).toContain("refreshTokenHash");
		expect(transcript).not.toContain("Grabbing some coffee"); // NO unrelated chatter
		expect(transcript).not.toContain("Redis caching"); // NO other peer's private DM
	});
});
