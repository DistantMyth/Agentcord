import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMemory, AgentRole, MemoryDecision, MemoryQA, MemoryTestRecord } from "../types";

export class AgentMemoryStore {
	private readonly baseDir: string;
	private readonly memoryCache = new Map<string, AgentMemory>();

	constructor(baseDir?: string) {
		this.baseDir = baseDir || path.resolve(process.cwd(), ".agentcord", "memory");
		try {
			fs.mkdirSync(this.baseDir, { recursive: true });
		} catch {
			// ignore directory creation error if already exists
		}
	}

	private getFilePath(agentId: string): string {
		const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
		return path.join(this.baseDir, `${safeId}.json`);
	}

	/**
	 * Loads agent memory from disk or cache. If not found, initializes fresh preserved memory.
	 */
	loadMemory(
		agentId: string,
		defaults: {
			agentName: string;
			owner: string;
			role: AgentRole;
			responsibility: string;
		}
	): AgentMemory {
		if (this.memoryCache.has(agentId)) {
			return this.memoryCache.get(agentId)!;
		}

		const filePath = this.getFilePath(agentId);
		if (fs.existsSync(filePath)) {
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const loaded = JSON.parse(content) as AgentMemory;
				this.memoryCache.set(agentId, loaded);
				return loaded;
			} catch (err) {
				console.error(`Failed to parse memory for agent ${agentId}, re-initializing:`, err);
			}
		}

		const fresh: AgentMemory = {
			agentId,
			agentName: defaults.agentName,
			owner: defaults.owner,
			role: defaults.role,
			responsibility: defaults.responsibility,
			workingMemory: `Initialized with responsibility: ${defaults.responsibility}`,
			facts: [],
			decisions: [],
			qaHistory: [],
			testHistory: [],
			updatedAt: Date.now(),
		};

		this.saveMemory(fresh);
		return fresh;
	}

	/**
	 * Saves agent memory atomically to disk and memory cache.
	 */
	saveMemory(memory: AgentMemory): void {
		memory.updatedAt = Date.now();
		this.memoryCache.set(memory.agentId, memory);
		const filePath = this.getFilePath(memory.agentId);
		try {
			fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), "utf-8");
		} catch (err) {
			console.error(`Failed to save memory to ${filePath}:`, err);
		}
	}

	/**
	 * Adds a persistent fact to agent memory.
	 */
	addFact(agentId: string, fact: string): void {
		const mem = this.memoryCache.get(agentId);
		if (!mem) return;
		if (!mem.facts.includes(fact)) {
			mem.facts.push(fact);
			this.saveMemory(mem);
		}
	}

	/**
	 * Adds an explicit decision to agent memory.
	 */
	addDecision(agentId: string, decision: string, rationale: string): void {
		const mem = this.memoryCache.get(agentId);
		if (!mem) return;
		const entry: MemoryDecision = {
			id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			decision,
			rationale,
			timestamp: Date.now(),
		};
		mem.decisions.push(entry);
		this.saveMemory(mem);
	}

	/**
	 * Records a question & answer exchange in agent memory.
	 */
	addQA(agentId: string, question: string, answer: string, peer: string): void {
		const mem = this.memoryCache.get(agentId);
		if (!mem) return;
		const entry: MemoryQA = {
			question,
			answer,
			peer,
			timestamp: Date.now(),
		};
		mem.qaHistory.push(entry);
		this.saveMemory(mem);
	}

	/**
	 * Records a test result in agent memory.
	 */
	addTestRecord(agentId: string, testName: string, passed: boolean, output: string): void {
		const mem = this.memoryCache.get(agentId);
		if (!mem) return;
		const entry: MemoryTestRecord = {
			testName,
			passed,
			output,
			timestamp: Date.now(),
		};
		mem.testHistory.push(entry);
		this.saveMemory(mem);
	}

	/**
	 * Updates the current working memory / scratchpad.
	 */
	updateWorkingMemory(agentId: string, workingMemory: string): void {
		const mem = this.memoryCache.get(agentId);
		if (!mem) return;
		mem.workingMemory = workingMemory;
		this.saveMemory(mem);
	}

	/**
	 * Updates the agent's active responsibility.
	 */
	updateResponsibility(agentId: string, responsibility: string): void {
		const mem = this.memoryCache.get(agentId);
		if (!mem) return;
		mem.responsibility = responsibility;
		this.saveMemory(mem);
	}

	/**
	 * Summarizes memory metrics for UI or quick status.
	 */
	getMemorySummary(agentId: string) {
		const mem = this.memoryCache.get(agentId);
		if (!mem) {
			return {
				totalItems: 0,
				factsCount: 0,
				decisionsCount: 0,
				qaCount: 0,
				testCount: 0,
				workingMemory: "",
			};
		}
		const total = mem.facts.length + mem.decisions.length + mem.qaHistory.length + mem.testHistory.length;
		return {
			totalItems: total,
			factsCount: mem.facts.length,
			decisionsCount: mem.decisions.length,
			qaCount: mem.qaHistory.length,
			testCount: mem.testHistory.length,
			workingMemory: mem.workingMemory,
		};
	}

	/**
	 * Formats preserved memory for inclusion in agent prompt context.
	 */
	formatPromptMemory(agentId: string): string {
		const mem = this.memoryCache.get(agentId);
		if (!mem) return "";

		const lines: string[] = [
			`### Preserved Memory for ${mem.agentName}`,
			`- Current Responsibility: ${mem.responsibility}`,
			`- Working Scratchpad: ${mem.workingMemory}`,
		];

		if (mem.facts.length > 0) {
			lines.push(`\n#### Known Facts & Architectural Agreements:`);
			for (const fact of mem.facts.slice(-10)) {
				lines.push(`- ${fact}`);
			}
		}

		if (mem.decisions.length > 0) {
			lines.push(`\n#### Past Decisions:`);
			for (const dec of mem.decisions.slice(-5)) {
				lines.push(`- Decision: ${dec.decision} (Rationale: ${dec.rationale})`);
			}
		}

		if (mem.qaHistory.length > 0) {
			lines.push(`\n#### Relevant Q&A History:`);
			for (const qa of mem.qaHistory.slice(-5)) {
				lines.push(`- [With ${qa.peer}] Q: ${qa.question} -> A: ${qa.answer}`);
			}
		}

		if (mem.testHistory.length > 0) {
			const recentTests = mem.testHistory.slice(-5);
			lines.push(`\n#### Step Testing History:`);
			for (const t of recentTests) {
				lines.push(`- Test: ${t.testName} | Result: ${t.passed ? "PASSED" : "FAILED"}`);
			}
		}

		return lines.join("\n");
	}

	get(agentId: string): AgentMemory | undefined {
		return this.memoryCache.get(agentId);
	}
}
