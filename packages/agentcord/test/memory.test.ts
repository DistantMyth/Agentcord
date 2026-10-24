import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentMemoryStore } from "../src/memory";

describe("Agentcord Persistent Memory", () => {
	const testDir = path.resolve(process.cwd(), ".agentcord", "test-memory");

	afterAll(() => {
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	test("preserves memory, facts, decisions, Q&A, and test history on disk", () => {
		const store1 = new AgentMemoryStore(testDir);
		const agentId = "queen_alice_test_1";

		// Initialize
		const mem1 = store1.loadMemory(agentId, {
			agentName: "[Queen: Alice]",
			owner: "Alice",
			role: "queen",
			responsibility: "Authentication and JWT tokens",
		});

		expect(mem1.agentName).toBe("[Queen: Alice]");
		expect(mem1.responsibility).toBe("Authentication and JWT tokens");

		// Record facts and decisions
		store1.addFact(agentId, "JWT secret rotation policy is 24 hours");
		store1.addDecision(agentId, "Use RS256 for token signing", "Industry standard for public key validation");
		store1.addQA(
			agentId,
			"Should we allow refresh tokens?",
			"Yes, with 7 day expiry and rotation.",
			"[King: Bob]"
		);
		store1.addTestRecord(agentId, "JWT signature verification", true, "Verified with valid RS256 cert");
		store1.updateWorkingMemory(agentId, "Finalizing middleware implementation");

		const summary1 = store1.getMemorySummary(agentId);
		expect(summary1.factsCount).toBe(1);
		expect(summary1.decisionsCount).toBe(1);
		expect(summary1.qaCount).toBe(1);
		expect(summary1.testCount).toBe(1);
		expect(summary1.workingMemory).toBe("Finalizing middleware implementation");

		// Simulate restart / cold load in a fresh store instance
		const store2 = new AgentMemoryStore(testDir);
		const mem2 = store2.loadMemory(agentId, {
			agentName: "[Queen: Alice]",
			owner: "Alice",
			role: "queen",
			responsibility: "Old responsibility",
		});

		// Check all preserved items are recovered from disk
		expect(mem2.facts.length).toBe(1);
		expect(mem2.facts[0]).toBe("JWT secret rotation policy is 24 hours");
		expect(mem2.decisions.length).toBe(1);
		expect(mem2.decisions[0]!.decision).toBe("Use RS256 for token signing");
		expect(mem2.qaHistory.length).toBe(1);
		expect(mem2.qaHistory[0]!.peer).toBe("[King: Bob]");
		expect(mem2.testHistory.length).toBe(1);
		expect(mem2.testHistory[0]!.passed).toBe(true);
		expect(mem2.workingMemory).toBe("Finalizing middleware implementation");

		// Formatted prompt memory
		const promptContext = store2.formatPromptMemory(agentId);
		expect(promptContext).toContain("JWT secret rotation policy");
		expect(promptContext).toContain("RS256");
		expect(promptContext).toContain("[With [King: Bob]]");
	});
});
