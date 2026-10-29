import * as path from "node:path";
import * as Handlebars from "@oh-my-pi/pi-utils/template";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { RpcClient, defineRpcClientTool } from "../../../coding-agent/src/modes/rpc/rpc-client";
import { GitTaskWorkspaces } from "./repository";
import type { TaskWorkspace } from "./repository";
import { errorText, isPlanner } from "./types";
import type { Activity, Assignment, ClientFrame, ServerFrame, SwarmState } from "./types";
import rolePrompt from "./prompts/role.md" with { type: "text" };
import taskPrompt from "./prompts/task.md" with { type: "text" };
import messagePrompt from "./prompts/message.md" with { type: "text" };

const renderRole = Handlebars.compile(rolePrompt, { noEscape: true });
const renderTask = Handlebars.compile(taskPrompt, { noEscape: true });
const renderMessage = Handlebars.compile(messagePrompt, { noEscape: true });

export interface TaskRuntime {
	run(
		assignment: Assignment,
		workspace: TaskWorkspace,
		action: (name: string, input: Record<string, unknown>) => Promise<unknown>,
		emit: (data: unknown) => void,
		signal: AbortSignal,
	): Promise<string>;
	message?(taskId: string, event: Activity): void;
}

/** Real tool-enabled OMP sessions; never falls back to simulated completions. */
export class OmpTaskRuntime implements TaskRuntime {
	#clients = new Map<string, RpcClient>();
	#command?: string[];
	#sessionRoot: string;
	#environment?: Record<string, string>;
	constructor(sessionRoot: string, command?: string[], environment?: Record<string, string>) {
		this.#sessionRoot = sessionRoot;
		this.#command = command;
		this.#environment = environment;
	}
	async run(
		assignment: Assignment,
		workspace: TaskWorkspace,
		action: (name: string, input: Record<string, unknown>) => Promise<unknown>,
		emit: (data: unknown) => void,
		signal: AbortSignal,
	): Promise<string> {
		const { task, agent } = assignment;
		const tool = defineRpcClientTool({
			name: "swarm",
			loadMode: "essential",
			description:
				"Inspect the shared swarm, delegate scoped tasks, ask a queen/king, wait for tasks, and send messages.",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["status", "delegate", "ask", "answer", "wait", "message"] },
					agentId: { type: "string" },
					title: { type: "string" },
					instructions: { type: "string" },
					paths: { type: "array", items: { type: "string" } },
					dependsOn: { type: "array", items: { type: "string" } },
					taskIds: { type: "array", items: { type: "string" } },
					questionTaskId: { type: "string" },
					to: { type: "string" },
					text: { type: "string" },
				},
				required: ["action"],
			},
			execute: async (params, context) => {
				const name = String(params.action);
				if (name !== "wait") return JSON.stringify(await action(name, params));
				if (
					!Array.isArray(params.taskIds) ||
					!params.taskIds.length ||
					params.taskIds.some(id => typeof id !== "string")
				)
					throw new Error("Provide taskIds to wait for");
				const taskIds = params.taskIds as string[];
				const deadline = Date.now() + 5000;
				while (!signal.aborted && !context.signal.aborted) {
					const state = (await action("status", {})) as SwarmState;
					const tasks = state.tasks.filter(item => taskIds.includes(item.id));
					if (tasks.length !== taskIds.length) throw new Error("Unknown task ID");
					if (tasks.every(item => !["queued", "running", "waiting", "integrating"].includes(item.status)))
						return JSON.stringify(tasks);
					if (Date.now() > deadline) return JSON.stringify({ waiting: tasks });
					await Bun.sleep(1500);
				}
				throw new Error("Task cancelled");
			},
		});
		const slash = agent.model.indexOf("/");
		if (agent.model !== "default" && slash < 1)
			throw new Error("Choose a provider/model ID (or default) in your role settings");
		const client = new RpcClient({
			startupTimeoutMs: 90_000,
			cliPath: path.resolve(import.meta.dir, "../../../coding-agent/src/cli.ts"),
			command: this.#command,
			env: this.#environment,
			cwd: workspace.directory,
			provider: slash > 0 ? agent.model.slice(0, slash) : undefined,
			model: slash > 0 ? agent.model.slice(slash + 1) : undefined,
			sessionDir: path.join(this.#sessionRoot, `${task.id}-${task.attempt}`),
			args: [
				"--no-extensions",
				"--no-skills",
				"--no-lsp",
				"--no-title",
				"--tools",
				isPlanner(agent.role)
					? "read,grep"
					: agent.role === "tester"
						? "read,grep,bash"
						: "read,grep,bash,write,edit",
				"--append-system-prompt",
				renderRole({ ...agent, instructions: assignment.instructions }),
			],
			customTools: [tool],
		});
		this.#clients.set(task.id, client);
		let verificationCommands = 0;
		let verificationFailed = false;
		let failure: string | undefined;
		const unsubscribe = client.onEvent(event => {
			// Streaming deltas and completed messages/results avoid persisting every growing snapshot.
			if (event.type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta.type === "text_delta" || delta.type === "thinking_delta")
					emit({ type: event.type, delta: delta.delta });
				return;
			}
			if (event.type === "tool_execution_end" && event.toolName === "bash") {
				verificationCommands++;
				if (event.isError) verificationFailed = true;
			}
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				(event.message.stopReason === "error" || event.message.stopReason === "aborted")
			)
				failure = event.message.errorMessage ?? event.message.stopReason;
			if (
				["message_end", "tool_execution_start", "tool_execution_end", "tool_execution_update"].includes(event.type)
			)
				emit(this.#boundedEvent(event));
		});
		const stop = () => {
			void client.stop();
		};
		signal.addEventListener("abort", stop, { once: true });
		try {
			if (signal.aborted) throw new Error("Runner disconnected");
			await client.start();
			await client.promptAndWait(
				renderTask({ ...assignment, scope: task.paths.join(", ") || "whole repository" }),
				undefined,
				60 * 60_000,
			);
			if (failure) throw new Error(failure);
			if (agent.role === "tester" && (!verificationCommands || verificationFailed))
				throw new Error(
					verificationFailed
						? "Verification command failed; inspect the shared command output"
						: "Tester ran no verification command; no test pass can be reported",
				);
			return (await client.getLastAssistantText()) ?? "";
		} finally {
			unsubscribe();
			signal.removeEventListener("abort", stop);
			this.#clients.delete(task.id);
			await client.stop();
		}
	}
	#boundedEvent(event: AgentEvent): unknown {
		const json = JSON.stringify(event);
		return json.length > 100000 ? { type: event.type, truncated: true, output: json.slice(0, 100000) } : event;
	}
	message(taskId: string, event: Activity): void {
		const client = this.#clients.get(taskId);
		if (client)
			void client
				.steer(renderMessage({ sender: event.agentId ?? event.memberId, text: event.text, data: event.data }))
				.catch(() => {});
	}
}

export interface SwarmRunnerOptions {
	url: string;
	token: string;
	directory: string;
	command?: string[];
	runtime?: TaskRuntime;
	workspaces?: { prepare: GitTaskWorkspaces["prepare"] };
	onError?: (message: string) => void;
	onState?: (state: SwarmState) => void;
}

export class SwarmRunner {
	#options: SwarmRunnerOptions;
	#socket?: WebSocket;
	#runtime: TaskRuntime;
	#workspaces: { prepare: GitTaskWorkspaces["prepare"] };
	#active = new Map<string, { assignment: Assignment; controller: AbortController; done: Promise<void> }>();
	#preparations: Promise<void> = Promise.resolve();
	#heartbeat?: NodeJS.Timeout;
	#reconnect?: NodeJS.Timeout;
	#stopped = false;
	#everConnected = false;
	#backoff = 1000;
	constructor(options: SwarmRunnerOptions) {
		this.#options = options;
		this.#runtime = options.runtime ?? new OmpTaskRuntime(path.join(options.directory, "s"), options.command);
		this.#workspaces = options.workspaces ?? new GitTaskWorkspaces(path.join(options.directory, "w"));
	}
	async start(): Promise<void> {
		this.#stopped = false;
		const url = new URL("/ws?kind=runner", this.#options.url);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(url, ["agentcord", this.#options.token]);
		this.#socket = socket;
		const ready = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			ready.reject(new Error("Runner handshake timed out"));
			socket.close();
		}, 15000);
		socket.onopen = () => {
			this.#backoff = 1000;
			this.#heartbeat = setInterval(() => this.#send({ type: "heartbeat" }), 10000);
		};
		socket.onmessage = event => {
			try {
				const frame = JSON.parse(String(event.data)) as ServerFrame;
				if (frame.type === "state") {
					this.#everConnected = true;
					this.#options.onState?.(frame.state);
					clearTimeout(timer);
					ready.resolve();
				}
				if (frame.type === "error") this.#options.onError?.(frame.message);
				if (frame.type === "assignment") this.#accept(frame.assignment);
				if (frame.type === "event" && frame.event.kind === "message" && frame.event.to) {
					for (const [id, entry] of this.#active)
						if (entry.assignment.agent.id === frame.event.to) this.#runtime.message?.(id, frame.event);
				}
			} catch (error) {
				this.#options.onError?.(errorText(error));
			}
		};
		socket.onerror = () => {
			clearTimeout(timer);
			ready.reject(new Error("Cannot connect to hub; check the URL and member token"));
		};
		socket.onclose = () => {
			clearTimeout(timer);
			clearInterval(this.#heartbeat);
			ready.reject(new Error("Hub connection closed before the handshake"));
			for (const entry of this.#active.values()) entry.controller.abort();
			if (!this.#stopped && this.#everConnected) {
				this.#options.onError?.("Hub disconnected. Running work is interrupted and preserved; reconnecting.");
				this.#reconnect = setTimeout(() => {
					void this.start().catch(error => this.#options.onError?.(errorText(error)));
				}, this.#backoff);
				this.#backoff = Math.min(this.#backoff * 2, 30000);
			}
		};
		await ready.promise;
	}
	#accept(assignment: Assignment): void {
		if (this.#active.has(assignment.task.id)) return;
		const controller = new AbortController();
		const done = this.#execute(assignment, controller.signal).finally(() => this.#active.delete(assignment.task.id));
		this.#active.set(assignment.task.id, { assignment, controller, done });
	}
	async #execute(assignment: Assignment, signal: AbortSignal): Promise<void> {
		const { task, lease } = assignment;
		const send = (frame: ClientFrame) => {
			if (!signal.aborted) this.#send(frame);
		};
		try {
			// Serialize clone/fetch/worktree creation per runner; actual OMP sessions execute concurrently.
			let workspace: TaskWorkspace | undefined;
			const prepare = this.#preparations.then(async () => {
				if (signal.aborted) throw new Error("Runner disconnected");
				workspace = await this.#workspaces.prepare(assignment.project, task);
			});
			this.#preparations = prepare.catch(() => {});
			await prepare;
			if (signal.aborted) throw new Error("Runner disconnected");
			const result = await this.#runtime.run(
				assignment,
				workspace!,
				(action, input) => this.#action(assignment, action, input, signal),
				data => send({ type: "activity", taskId: task.id, lease, data }),
				signal,
			);
			if (signal.aborted) return;
			const commit = isPlanner(assignment.agent.role) ? undefined : await workspace!.finish();
			send({ type: "result", taskId: task.id, lease, result, commit });
		} catch (error) {
			send({ type: "result", taskId: task.id, lease, error: errorText(error) });
		}
	}
	async #action(
		assignment: Assignment,
		action: string,
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		const response = await fetch(new URL("/api/agent", this.#options.url), {
			method: "POST",
			headers: { Authorization: `Bearer ${this.#options.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ taskId: assignment.task.id, lease: assignment.lease, action, input }),
			signal,
		});
		const result = (await response.json()) as { error?: string };
		if (!response.ok) throw new Error(result.error ?? `Hub returned ${response.status}`);
		return result;
	}
	#send(frame: ClientFrame): void {
		if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(frame));
	}
	async stop(): Promise<void> {
		this.#stopped = true;
		clearTimeout(this.#reconnect);
		clearInterval(this.#heartbeat);
		for (const entry of this.#active.values()) entry.controller.abort();
		this.#socket?.close();
		await Promise.allSettled([...this.#active.values()].map(entry => entry.done));
	}
}
