#!/usr/bin/env bun
/**
 * Agentcord CLI Entrypoint
 *
 * Collaborative multi-user AI agent network fork of oh-my-pi
 */

import * as readline from "node:readline/promises";
import * as os from "node:os";
import { AgentRegistry, KingAgent, QueenAgent } from "./agents";
import { ChatRoom } from "./chat";
import { AgentMemoryStore } from "./memory";
import { ModelConfigManager } from "./models";
import { formatAgentName, formatUserName } from "./naming";
import { AgentcordPeerClient, AgentcordRelayServer } from "./network";

function parseArgs(args: string[]) {
	const parsed: Record<string, string | boolean> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			if (i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
				parsed[key] = args[i + 1]!;
				i++;
			} else {
				parsed[key] = true;
			}
		}
	}
	return parsed;
}

async function prompt(rl: readline.Interface, query: string, defaultVal = ""): Promise<string> {
	const answer = await rl.question(`${query} ${defaultVal ? `[${defaultVal}] ` : ""}: `);
	return answer.trim() || defaultVal;
}

export async function main() {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);

	console.log("\n========================================================");
	console.log("             AGENTCORD: COLLABORATIVE HUB               ");
	console.log("       Multi-User Agent Network Fork of oh-my-pi        ");
	console.log("========================================================\n");

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	// Requirement 2: "It asks the user's name."
	let userName = (args.name as string) || "";
	if (!userName) {
		const defaultName = os.userInfo().username || "Developer";
		userName = await prompt(rl, "What is your name?", defaultName);
	}
	userName = userName.trim();
	console.log(`\nWelcome, ${formatUserName(userName)}!`);

	// Mode: Host or Join
	let isHost = args.host as boolean;
	let joinLink = (args.join as string) || "";

	if (!isHost && !joinLink) {
		const choice = await prompt(rl, "Do you want to (H)ost a new room or (J)oin an existing room?", "H");
		if (choice.toUpperCase().startsWith("J")) {
			joinLink = await prompt(rl, "Enter room code or join link:");
			isHost = false;
		} else {
			isHost = true;
		}
	}

	const port = Number(args.port) || 7466;
	const memoryStore = new AgentMemoryStore();
	const modelManager = new ModelConfigManager();
	const registry = new AgentRegistry();
	const chatRoom = new ChatRoom(registry);

	// Model configurations
	if (args["queen-model"]) modelManager.setUserModels(userName, { queenModel: String(args["queen-model"]) });
	if (args["king-model"]) modelManager.setUserModels(userName, { kingModel: String(args["king-model"]) });
	if (args["worker-model"]) modelManager.setUserModels(userName, { workerModel: String(args["worker-model"]) });

	let kingAgent: KingAgent | null = null;
	let queenAgent: QueenAgent | null = null;
	let relayServer: AgentcordRelayServer | null = null;
	let peerClient: AgentcordPeerClient | null = null;
	let roomId = "";

	if (isHost) {
		roomId = (args.room as string) || `room_${Math.random().toString(36).slice(2, 8)}`;
		console.log(`\nInitializing Host Room: ${roomId}...`);

		// Host has the King Agent
		kingAgent = new KingAgent({
			owner: userName,
			responsibility: "Master coordination, goal decomposition, and architectural rulings across all users",
			model: modelManager.getUserModels(userName).kingModel,
			memoryStore,
			providerClient: new (await import("./models")).AgentProviderClient(),
		});
		registry.registerAgent(kingAgent);
		console.log(`👑 Registered Master Agent: ${kingAgent.name} (Model: ${kingAgent.model})`);

		// Host also has their own Queen Agent
		queenAgent = new QueenAgent({
			owner: userName,
			responsibility: "Host user core module implementation and oversight of helpers",
			model: modelManager.getUserModels(userName).queenModel,
			parentId: kingAgent.id,
			memoryStore,
			providerClient: new (await import("./models")).AgentProviderClient(),
		});
		registry.registerAgent(queenAgent);
		console.log(`👸 Registered User Queen: ${queenAgent.name} (Model: ${queenAgent.model})`);

		// Register Queen's automatically spun up helper subagents
		for (const sub of queenAgent.getAllSubagents()) {
			registry.registerAgent(sub);
			console.log(`   ↳ Spun up helper: ${sub.name} [${sub.role}] (Model: ${sub.model})`);
		}

		// Start relay & Web Helper GUI
		relayServer = new AgentcordRelayServer({
			port,
			roomId,
			hostUser: userName,
			registry,
			chatRoom,
			modelManager,
			memoryStore,
		});

		const srvInfo = relayServer.start();
		console.log(`\n🚀 Agentcord Helper GUI & Relay running at:`);
		console.log(`   URL: ${srvInfo.url}`);
		console.log(`   Room ID: ${srvInfo.roomId}`);
		console.log(`   Shareable Invite Link: ${srvInfo.url}/?room=${srvInfo.roomId}`);
	} else {
		// Guest Mode
		roomId = joinLink.includes("room=") ? new URL(joinLink).searchParams.get("room") || "room_default" : joinLink;
		const relayUrl = args["relay-url"] ? String(args["relay-url"]) : `http://localhost:${port}`;

		console.log(`\nConnecting to Room ${roomId} at ${relayUrl}...`);

		// Guest has their Queen Agent
		queenAgent = new QueenAgent({
			owner: userName,
			responsibility: "Peer user module implementation and helper orchestration",
			model: modelManager.getUserModels(userName).queenModel,
			memoryStore,
			providerClient: new (await import("./models")).AgentProviderClient(),
		});
		registry.registerAgent(queenAgent);
		console.log(`👸 Registered User Queen: ${queenAgent.name} (Model: ${queenAgent.model})`);

		for (const sub of queenAgent.getAllSubagents()) {
			registry.registerAgent(sub);
			console.log(`   ↳ Spun up helper: ${sub.name} [${sub.role}] (Model: ${sub.model})`);
		}

		peerClient = new AgentcordPeerClient({
			relayUrl,
			roomId,
			userName,
			queenModel: queenAgent.model,
			onMessage: msg => {
				const tag = msg.type === "dm" ? `[DM to ${msg.to}]` : `[GC]`;
				console.log(`\n${tag} ${msg.from}: ${msg.text}`);
			},
			onQuestion: q => {
				console.log(`\n[❓ Question from ${q.fromAgent} -> ${q.toAgent}]: ${q.question}`);
				if (q.answer) console.log(`   [💡 Answer]: ${q.answer}`);
			},
			onAgentUpdate: ag => {
				console.log(`\n[Agent Update] ${ag.name} -> Responsibility: "${ag.responsibility}" (${ag.status})`);
			},
		});

		try {
			await peerClient.connect();
			console.log(`✅ Connected successfully to room ${roomId}!`);
		} catch (err) {
			console.warn(`Could not connect immediately via WebSocket:`, err);
		}
	}

	console.log("\n========================================================");
	console.log("Commands available:");
	console.log("  /status             - Show live responsibility roster of all agents");
	console.log("  /gc <message>       - Send message to Group Chat (context-shielded)");
	console.log("  /dm <target> <msg>  - Send direct message to specific User or Agent");
	console.log("  /ask <target> <q>   - Worker asks Queen OR Queen asks King");
	console.log("  /spawn <name> <res> - Spawn a helper worker under your Queen");
	console.log("  /test [stepDesc]    - Run TestGen testcase generation & Step Tester");
	console.log("  /memory             - View preserved memory summary for your agents");
	console.log("  /models             - View or switch agent models");
	console.log("  /exit               - Quit");
	console.log("========================================================\n");

	if (args.daemon || args["serve-only"] || !process.stdin.isTTY) {
		console.log("Running in daemon mode. Press Ctrl+C or kill task to stop.");
		// Keep alive
		await new Promise(() => {});
		return;
	}

	// Interactive CLI loop
	while (true) {
		const line = await prompt(rl, `[${userName}] >`);
		if (!line) continue;

		const trimmed = line.trim();
		if (trimmed === "/exit") {
			console.log("Closing session. Preserved memories are saved in .agentcord/memory/.");
			relayServer?.stop();
			peerClient?.close();
			rl.close();
			process.exit(0);
		}

		if (trimmed === "/status") {
			console.log("\n--- LIVE AGENTS & RESPONSIBILITIES MATRIX ---");
			for (const a of registry.getSnapshots()) {
				console.log(`• ${a.name.padEnd(32)} | Role: ${a.role.toUpperCase().padEnd(7)} | Status: ${a.status.padEnd(10)} | Model: ${a.model}`);
				console.log(`  Responsibility: ${a.responsibility}`);
			}
			console.log("---------------------------------------------\n");
			continue;
		}

		if (trimmed === "/models" || trimmed === "/model" || trimmed.startsWith("/model ")) {
			const sub = trimmed.slice(6).trim();
			if (sub) {
				const parts = sub.split(" ");
				if (parts.length >= 2) {
					const role = parts[0]!.toLowerCase();
					const modelName = parts[1]!;
					modelManager.setUserModels(userName, {
						[`${role}Model`]: modelName,
					} as any);
					console.log(`\nUpdated model for ${role} to: ${modelName}\n`);
					continue;
				}
			}

			const userModels = modelManager.getUserModels(userName);
			console.log("\n--- AGENTCORD CONFIGURED MODELS ---");
			console.log(`• King Agent:    ${userModels.kingModel}`);
			console.log(`• Queen Agent:   ${userModels.queenModel}`);
			console.log(`• Worker Agent:  ${userModels.workerModel}`);
			console.log(`• TestGen Agent: ${userModels.testgenModel}`);
			console.log(`• Tester Agent:  ${userModels.testerModel}`);
			console.log("\nAvailable Catalog Models:");
			for (const m of modelManager.getAvailableModels()) {
				console.log(`  - ${m.id.padEnd(24)} [${m.provider}] - ${m.name}`);
			}
			console.log("\nUsage to change: /model <role> <modelId> (e.g., /model queen gpt-4o)");
			console.log("Tip: Launch `bun dev` to use omp's native interactive fuzzy-search /models picker.\n");
			continue;
		}

		if (trimmed === "/login" || trimmed.startsWith("/login ")) {
			console.log("\n--- AGENTCORD AUTHENTICATION & LOGIN ---");
			console.log("Environment API keys currently detected:");
			console.log(`• ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "CONFIGURED" : "NOT SET"}`);
			console.log(`• OPENAI_API_KEY:    ${process.env.OPENAI_API_KEY ? "CONFIGURED" : "NOT SET"}`);
			console.log(`• GEMINI_API_KEY:    ${process.env.GEMINI_API_KEY ? "CONFIGURED" : "NOT SET"}`);
			console.log(`• OLLAMA_HOST:       ${process.env.OLLAMA_HOST || "http://localhost:11434"}`);
			console.log("\nTo authenticate via interactive OAuth login dialog:");
			console.log("Run `bun dev` (native omp) and type `/login` to authenticate with Anthropic, OpenAI, or Google.\n");
			continue;
		}

		if (trimmed === "/memory") {
			console.log("\n--- PRESERVED MEMORY SUMMARY ---");
			for (const a of registry.getAgentsByOwner(userName)) {
				const sum = memoryStore.getMemorySummary(a.id);
				console.log(`• ${a.name}: ${sum.totalItems} items (${sum.factsCount} facts, ${sum.decisionsCount} decisions, ${sum.qaCount} Q&A, ${sum.testCount} tests)`);
				console.log(`  Scratchpad: ${sum.workingMemory}`);
			}
			console.log("--------------------------------\n");
			continue;
		}

		if (trimmed.startsWith("/spawn ")) {
			const parts = trimmed.slice(7).split(" ");
			const wName = parts[0] || "Worker";
			const wResp = parts.slice(1).join(" ") || "General implementation subtask";
			if (queenAgent) {
				const worker = queenAgent.spawnWorker(wName, wResp);
				registry.registerAgent(worker);
				console.log(`✨ Queen spawned worker: ${worker.name} with responsibility: "${wResp}"`);
			}
			continue;
		}

		if (trimmed.startsWith("/test")) {
			const stepDesc = trimmed.slice(5).trim() || "Development step verification";
			if (queenAgent) {
				console.log(`🧪 Running TestGen & Tester helper agents for "${stepDesc}"...`);
				const res = await queenAgent.runTestCycle(stepDesc);
				console.log(`✅ TestGen formulated ${res.testcases.length} testcases.`);
				for (const r of res.testResults) {
					console.log(`   ${r.passed ? "✔ PASS" : "✖ FAIL"}: ${r.testName}`);
				}
			}
			continue;
		}

		if (trimmed.startsWith("/ask ")) {
			const rest = trimmed.slice(5).trim();
			const firstSpace = rest.indexOf(" ");
			if (firstSpace === -1) {
				console.log("Usage: /ask <TargetAgentName> <Question>");
				continue;
			}
			const target = rest.slice(0, firstSpace).trim();
			const question = rest.slice(firstSpace + 1).trim();

			console.log(`❓ Asking ${target}: "${question}"...`);
			const targetAgent = registry.findAgentByName(target);
			if (!targetAgent) {
				console.log(`Agent "${target}" not found in registry.`);
				continue;
			}

			if (targetAgent.role === "king" && kingAgent) {
				const answer = await kingAgent.answerQueenQuestion(queenAgent?.name || userName, question);
				console.log(`💡 ${kingAgent.name} answered:\n${answer}\n`);
			} else if (targetAgent.role === "queen") {
				const answer = await (targetAgent as QueenAgent).answerWorkerQuestion(userName, question);
				console.log(`💡 ${targetAgent.name} answered:\n${answer}\n`);
			}
			continue;
		}

		if (trimmed.startsWith("/dm ")) {
			const rest = trimmed.slice(4).trim();
			const firstSpace = rest.indexOf(" ");
			if (firstSpace === -1) {
				console.log("Usage: /dm <Target> <Message>");
				continue;
			}
			const target = rest.slice(0, firstSpace).trim();
			const msgText = rest.slice(firstSpace + 1).trim();

			await chatRoom.sendMessage({
				type: "dm",
				from: formatUserName(userName),
				fromUser: userName,
				to: target,
				text: msgText,
			});
			console.log(`[DM to ${target}] Sent.`);
			continue;
		}

		if (trimmed.startsWith("/gc ")) {
			const msgText = trimmed.slice(4).trim();
			await chatRoom.sendMessage({
				type: "gc",
				from: formatUserName(userName),
				fromUser: userName,
				text: msgText,
			});
			continue;
		}

		// Default input sends to Group Chat
		await chatRoom.sendMessage({
			type: "gc",
			from: formatUserName(userName),
			fromUser: userName,
			text: trimmed,
		});
	}
}

if (import.meta.main) {
	main().catch(err => {
		console.error("Agentcord fatal error:", err);
		process.exit(1);
	});
}
