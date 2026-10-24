/**
 * Domain types for Agentcord: Multi-user collaborative agent network
 */

export type AgentRole = "king" | "queen" | "worker" | "testgen" | "tester";

export type AgentStatus =
	| "idle"
	| "planning"
	| "working"
	| "questioning"
	| "testing"
	| "completed"
	| "error";

export interface AgentInfo {
	id: string;
	/** Formatted name, e.g. `[King: Alice]`, `[Queen: Bob]`, `[Worker: Bob - DBWorker]` */
	name: string;
	/** Short unformatted identifier, e.g. "DBWorker", "Alice" */
	rawName: string;
	/** Owner user's name, e.g. "Alice", "Bob" */
	owner: string;
	/** Hierarchy role */
	role: AgentRole;
	/** Current assigned task or responsibility */
	responsibility: string;
	/** Live activity state */
	status: AgentStatus;
	/** Configured model identifier, e.g. "gemini-2.5-pro", "claude-3-7-sonnet" */
	model: string;
	/** ID of parent agent (King for Queens, Queen for Workers/Testers) */
	parentId?: string;
	/** Creation timestamp */
	createdAt: number;
	/** Last active timestamp */
	lastActiveAt: number;
	/** Summary count of preserved memory items */
	memoryCount?: number;
}

export interface UserInfo {
	name: string;
	isHost: boolean;
	connectedAt: number;
	queenModel?: string;
	workerModel?: string;
	testgenModel?: string;
	testerModel?: string;
	kingModel?: string;
}

export type MessageType = "gc" | "dm";

export interface ChatMessage {
	id: string;
	/** GC (Group Chat) or DM (Direct Message) */
	type: MessageType;
	/** Formatted sender name, e.g. `[User: Alice]` or `[Queen: Bob]` */
	from: string;
	/** The human user behind this message or agent */
	fromUser: string;
	/** For DM: formatted target name, e.g. `[Queen: Alice]` or `[King: Alice]` */
	to?: string;
	/** Message text body */
	text: string;
	/** Unix timestamp */
	timestamp: number;
	/** Optional question escalation id */
	questionId?: string;
	/** Whether this message represents a question from worker/queen */
	isQuestion?: boolean;
	/** Whether this message represents an answer to a question */
	isAnswer?: boolean;
	/** ID of message being replied to */
	replyToId?: string;
}

export interface QuestionEscalation {
	id: string;
	fromAgent: string;
	fromRole: AgentRole;
	toAgent: string;
	toRole: AgentRole;
	question: string;
	answer?: string;
	status: "pending" | "answered" | "rejected";
	createdAt: number;
	answeredAt?: number;
}

export interface TestCase {
	id: string;
	name: string;
	description: string;
	responsibility: string;
	code?: string;
	expected: string;
	createdAt: number;
}

export interface TestRunResult {
	id: string;
	testId: string;
	testName: string;
	passed: boolean;
	step: number;
	output: string;
	error?: string;
	executedAt: number;
}

export interface MemoryDecision {
	id: string;
	decision: string;
	rationale: string;
	timestamp: number;
}

export interface MemoryQA {
	question: string;
	answer: string;
	peer: string;
	timestamp: number;
}

export interface MemoryTestRecord {
	testName: string;
	passed: boolean;
	output: string;
	timestamp: number;
}

export interface AgentMemory {
	agentId: string;
	agentName: string;
	owner: string;
	role: AgentRole;
	responsibility: string;
	workingMemory: string;
	facts: string[];
	decisions: MemoryDecision[];
	qaHistory: MemoryQA[];
	testHistory: MemoryTestRecord[];
	updatedAt: number;
}

export interface RoomState {
	roomId: string;
	hostUser: string;
	users: UserInfo[];
	agents: AgentInfo[];
	messages: ChatMessage[];
	questions: QuestionEscalation[];
	testCases: TestCase[];
	testRuns: TestRunResult[];
}
