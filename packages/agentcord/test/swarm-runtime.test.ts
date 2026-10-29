import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OmpTaskRuntime } from "../src/swarm/runner";
import type { Assignment } from "../src/swarm/types";

async function exercise(role: "worker" | "tester", command?: string) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentcord-runtime-"));
	if (!path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), "agentcord-runtime-")))
		throw new Error("Invalid fixture cleanup path");
	const agentDir = path.join(directory, "omp");
	let requests = 0,
		statusCalls = 0;
	const toolNames: string[] = [];
	const provider = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async request => {
			const body = (await request.json()) as { tools?: Array<{ function?: { name: string } }> };
			toolNames.push(...(body.tools ?? []).map(tool => tool.function?.name ?? "unknown"));
			const round = requests++;
			const delta =
				round < 2
					? {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: `call_${round}`,
									type: "function",
									function: {
										name: round === 0 ? "swarm" : command ? "bash" : "read",
										arguments: JSON.stringify(
											round === 0 ? { action: "status" } : command ? { command } : { path: "proof.txt" },
										),
									},
								},
							],
						}
					: { role: "assistant", content: "Verified the local fixture. Tests passed." };
			const chunk = (value: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: `completion_${round}`, object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
			return new Response(chunk(delta, null) + chunk({}, round < 2 ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
				headers: { "Content-Type": "text/event-stream" },
			});
		},
	});
	try {
		await Bun.write(
			path.join(agentDir, "models.yml"),
			JSON.stringify({
				providers: {
					fixture: {
						baseUrl: `http://127.0.0.1:${provider.port}/v1`,
						apiKey: "fixture-only",
						api: "openai-completions",
						models: [
							{
								id: "model",
								name: "Fixture",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 32000,
								maxTokens: 1000,
							},
						],
					},
				},
			}),
		);
		await Bun.write(path.join(directory, "proof.txt"), "agentcord-real-read-proof\n");
		const assignment: Assignment = {
			task: {
				id: "runtime",
				kind: "task",
				projectId: "fixture",
				agentId: "worker",
				title: "Inspect fixture",
				instructions: "Read proof.txt using the read tool",
				paths: ["proof.txt"],
				dependsOn: [],
				status: "running",
				attempt: 1,
				base: "a".repeat(40),
				branch: "fixture",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
			agent: { id: "worker", role, ownerId: "member", name: "Fixture agent", model: "fixture/model", online: true },
			project: {
				id: "fixture",
				name: "Fixture",
				repositoryUrl: "unused",
				baseRef: "HEAD",
				integrationBranch: "fixture",
				head: "a".repeat(40),
				status: "ready",
			},
			lease: "fixture-lease",
			instructions: "",
		};
		const runtime = new OmpTaskRuntime(path.join(directory, "sessions"), undefined, {
			PI_CODING_AGENT_DIR: agentDir,
			PI_NO_TITLE: "1",
			PI_DEBUG_STARTUP: "1",
		});
		const emitted: unknown[] = [];
		const result = await runtime.run(
			assignment,
			{ directory, finish: async () => "unused" },
			async action => {
				if (action === "status") statusCalls++;
				return { agents: [], tasks: [], projects: [] };
			},
			event => emitted.push(event),
			new AbortController().signal,
		);
		return { result, toolNames, statusCalls, emitted };
	} finally {
		provider.stop(true);
		await fs.rm(directory, { recursive: true, force: true });
	}
}

test("real OMP RPC exposes swarm tools, executes a local read, and streams its output to the room", async () => {
	const result = await exercise("worker");
	expect(result.result).toContain("Verified the local fixture");
	expect(result.toolNames).toContain("swarm");
	expect(result.statusCalls).toBe(1);
	expect(JSON.stringify(result.emitted)).toContain("agentcord-real-read-proof");
}, 120000);

test("a tester cannot claim a pass without running a verification command", async () => {
	await expect(exercise("tester")).rejects.toThrow("no verification command");
}, 120000);

test("a tester rejects a failed command even when the model claims it passed", async () => {
	await expect(exercise("tester", "exit 7")).rejects.toThrow("Verification command failed");
}, 120000);

test("a tester streams real successful verification command output", async () => {
	const result = await exercise("tester", "echo agentcord-command-proof");
	expect(JSON.stringify(result.emitted)).toContain("agentcord-command-proof");
}, 120000);
