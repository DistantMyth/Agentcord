export const ROLES = ["king", "queen", "worker", "testgen", "tester"] as const;
export type Role = (typeof ROLES)[number];

export interface RoleSettings {
	enabled: boolean;
	/** OMP provider/model ID, or "default" to use this member's OMP default. */
	model: string;
	count: number;
	instructions: string;
}
export type MemberSettings = Record<Role, RoleSettings>;

export interface Member {
	id: string;
	name: string;
	isHost: boolean;
	online: boolean;
	settings: MemberSettings;
}

export interface SwarmAgent {
	id: string;
	ownerId: string;
	name: string;
	role: Role;
	model: string;
	parentId?: string;
	online: boolean;
}

export interface Project {
	id: string;
	name: string;
	repositoryUrl: string;
	baseRef: string;
	integrationBranch: string;
	head: string;
	status: "ready" | "error";
	error?: string;
}

export type TaskStatus =
	| "queued"
	| "running"
	| "waiting"
	| "integrating"
	| "completed"
	| "failed"
	| "interrupted"
	| "conflict"
	| "cancelled";
export interface SwarmTask {
	id: string;
	kind: "task" | "question";
	projectId: string;
	agentId: string;
	parentTaskId?: string;
	title: string;
	instructions: string;
	/** Repository-relative directories/files. An empty list means the whole repository. */
	paths: string[];
	dependsOn: string[];
	status: TaskStatus;
	attempt: number;
	base?: string;
	branch?: string;
	commit?: string;
	result?: string;
	error?: string;
	createdAt: number;
	updatedAt: number;
}

export interface Activity {
	seq: number;
	time: number;
	kind: "room" | "task" | "message" | "agent_event" | "repository" | "error";
	memberId?: string;
	agentId?: string;
	taskId?: string;
	projectId?: string;
	to?: string;
	text?: string;
	data?: unknown;
}

export interface SwarmState {
	version: 2;
	roomId: string;
	hostId: string;
	members: Member[];
	agents: SwarmAgent[];
	projects: Project[];
	tasks: SwarmTask[];
}

export interface TaskInput {
	projectId: string;
	agentId: string;
	parentTaskId?: string;
	title: string;
	instructions: string;
	paths?: string[];
	dependsOn?: string[];
}

export interface Assignment {
	task: SwarmTask;
	agent: SwarmAgent;
	project: Project;
	lease: string;
	instructions: string;
}

export type ClientFrame =
	| { type: "heartbeat" }
	| { type: "activity"; taskId: string; lease: string; data: unknown }
	| { type: "result"; taskId: string; lease: string; commit?: string; result?: string; error?: string };
export type ServerFrame =
	| { type: "state"; state: SwarmState; events: Activity[] }
	| { type: "event"; event: Activity }
	| { type: "assignment"; assignment: Assignment }
	| { type: "error"; message: string };

export function defaultSettings(isHost = false): MemberSettings {
	return Object.fromEntries(
		ROLES.map(role => [
			role,
			{
				enabled: role !== "king" || isHost,
				model: "default",
				count: 1,
				instructions: "",
			},
		]),
	) as MemberSettings;
}

export function isPlanner(role: Role): boolean {
	return role === "king" || role === "queen";
}

export function normalizePaths(paths: string[]): string[] {
	return [
		...new Set(
			paths.map(value => {
				const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
				if (!normalized || normalized === ".") return "";
				if (
					normalized.startsWith("/") ||
					normalized.includes(":") ||
					normalized.split("/").some(part => !part || part === ".." || part === "." || part === ".git")
				) {
					throw new Error("Task paths must be repository-relative files or directories without traversal or .git");
				}
				return normalized;
			}),
		),
	].filter(Boolean);
}

export function pathsOverlap(left: string[], right: string[]): boolean {
	if (!left.length || !right.length) return true;
	return left.some(a =>
		right.some(
			b =>
				a.toLowerCase() === b.toLowerCase() ||
				a.toLowerCase().startsWith(`${b.toLowerCase()}/`) ||
				b.toLowerCase().startsWith(`${a.toLowerCase()}/`),
		),
	);
}

export function pathInScope(file: string, scope: string[]): boolean {
	return scope.length === 0 || scope.some(prefix => file === prefix || file.startsWith(`${prefix}/`));
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Compact persistent IDs keep native Git ref paths within Windows path limits. */
export function swarmId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}
