import { describe, expect, test } from "bun:test";
import {
	formatAgentName,
	formatUserName,
	isKingName,
	isQueenName,
	isWorkerName,
	parseFormattedName,
} from "../src/naming";

describe("Agentcord Naming Convention", () => {
	test("formats King agent name correctly", () => {
		const name = formatAgentName("king", "Alice");
		expect(name).toBe("[King: Alice]");
		expect(isKingName(name)).toBe(true);
		expect(isQueenName(name)).toBe(false);
	});

	test("formats Queen agent name correctly", () => {
		const name = formatAgentName("queen", "Bob");
		expect(name).toBe("[Queen: Bob]");
		expect(isQueenName(name)).toBe(true);
		expect(isKingName(name)).toBe(false);
	});

	test("formats Worker agent name with specialty", () => {
		const name = formatAgentName("worker", "Bob", "DBWorker");
		expect(name).toBe("[Worker: Bob - DBWorker]");
		expect(isWorkerName(name)).toBe(true);

		const parsed = parseFormattedName(name);
		expect(parsed.isValid).toBe(true);
		expect(parsed.role).toBe("worker");
		expect(parsed.userName).toBe("Bob");
		expect(parsed.workerName).toBe("DBWorker");
	});

	test("formats TestGen and Tester helper agents", () => {
		const testGen = formatAgentName("testgen", "Charlie");
		expect(testGen).toBe("[TestGen: Charlie]");
		const parsedGen = parseFormattedName(testGen);
		expect(parsedGen.role).toBe("testgen");
		expect(parsedGen.userName).toBe("Charlie");

		const tester = formatAgentName("tester", "Charlie");
		expect(tester).toBe("[Tester: Charlie]");
		const parsedTester = parseFormattedName(tester);
		expect(parsedTester.role).toBe("tester");
		expect(parsedTester.userName).toBe("Charlie");
	});

	test("formats Human User name", () => {
		const user = formatUserName("Alice");
		expect(user).toBe("[User: Alice]");
		const parsed = parseFormattedName(user);
		expect(parsed.type).toBe("user");
		expect(parsed.userName).toBe("Alice");
	});
});
