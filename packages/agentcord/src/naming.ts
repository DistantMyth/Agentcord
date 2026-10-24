import type { AgentRole } from "./types";

/**
 * Standard Agentcord Agent Name Formatter & Parser
 *
 * Ensures all chat messages and registry entries adhere to the uniform format:
 * - King: [King: <UserName>]
 * - Queen: [Queen: <UserName>]
 * - Worker: [Worker: <UserName> - <WorkerName>]
 * - TestGen: [TestGen: <UserName>]
 * - Tester: [Tester: <UserName>]
 * - User: [User: <UserName>]
 */

export function formatAgentName(role: AgentRole, userName: string, workerName?: string): string {
	const user = userName.trim();
	switch (role) {
		case "king":
			return `[King: ${user}]`;
		case "queen":
			return `[Queen: ${user}]`;
		case "worker": {
			const w = (workerName || "Worker").trim();
			return `[Worker: ${user} - ${w}]`;
		}
		case "testgen":
			return `[TestGen: ${user}]`;
		case "tester":
			return `[Tester: ${user}]`;
		default:
			return `[Agent: ${user}]`;
	}
}

export function formatUserName(userName: string): string {
	return `[User: ${userName.trim()}]`;
}

export interface ParsedName {
	type: "agent" | "user" | "unknown";
	role?: AgentRole;
	userName: string;
	workerName?: string;
	isValid: boolean;
	original: string;
}

const NAME_REGEX = /^\[(King|Queen|Worker|TestGen|Tester|User):\s*([^\]]+)\]$/i;

export function parseFormattedName(formatted: string): ParsedName {
	const match = NAME_REGEX.exec(formatted.trim());
	if (!match) {
		return {
			type: "unknown",
			userName: formatted.trim(),
			isValid: false,
			original: formatted,
		};
	}

	const roleTag = match[1]!.toLowerCase();
	const rest = match[2]!.trim();

	if (roleTag === "user") {
		return {
			type: "user",
			userName: rest,
			isValid: true,
			original: formatted,
		};
	}

	if (roleTag === "worker") {
		// Worker format is [Worker: <UserName> - <WorkerName>] or [Worker: <UserName>]
		const splitIdx = rest.indexOf(" - ");
		if (splitIdx !== -1) {
			const userName = rest.slice(0, splitIdx).trim();
			const workerName = rest.slice(splitIdx + 3).trim();
			return {
				type: "agent",
				role: "worker",
				userName,
				workerName,
				isValid: true,
				original: formatted,
			};
		}
		return {
			type: "agent",
			role: "worker",
			userName: rest,
			workerName: "Worker",
			isValid: true,
			original: formatted,
		};
	}

	const roleMap: Record<string, AgentRole> = {
		king: "king",
		queen: "queen",
		testgen: "testgen",
		tester: "tester",
	};

	const role = roleMap[roleTag];
	return {
		type: "agent",
		role,
		userName: rest,
		isValid: !!role,
		original: formatted,
	};
}

export function isKingName(name: string): boolean {
	const parsed = parseFormattedName(name);
	return parsed.isValid && parsed.role === "king";
}

export function isQueenName(name: string): boolean {
	const parsed = parseFormattedName(name);
	return parsed.isValid && parsed.role === "queen";
}

export function isWorkerName(name: string): boolean {
	const parsed = parseFormattedName(name);
	return parsed.isValid && parsed.role === "worker";
}
