import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";
import { getActiveAgentcordBridge } from "../agentcord/bridge";
import { theme } from "@oh-my-pi/pi-tui/theme";

export const BUILTIN_AGENTCORD_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "agentcord",
		aliases: ["ac"],
		icon: "agents",
		description: "Agentcord collaborative multi-user network (King/Queen/Workers/TestGen/Tester & Helper GUI)",
		acpDescription: "Agentcord network & live responsibility tracking",
		inlineHint: "[status|gui|connect|test|worker|model|name] [args]",
		subcommands: [
			{ name: "status", description: "Show live responsibility matrix and agent states" },
			{ name: "gui", description: "Open or show link to Helper Web GUI" },
			{ name: "connect", description: "Connect to a remote Agentcord relay", usage: "<relayUrl>" },
			{ name: "test", description: "Trigger step testcase generation and verification", usage: "[step]" },
			{ name: "worker", description: "Create worker helper under Queen", usage: "<specialty> <responsibility>" },
			{ name: "model", description: "Configure model for an agent role", usage: "<role> <model>" },
			{ name: "name", description: "View or update your Agentcord user name", usage: "[newName]" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: () => {
			const bridge = getActiveAgentcordBridge();
			if (!bridge) return "Agentcord: not initialized";
			const count = bridge.getResponsibilityMatrix().length;
			return `Agentcord: ${count} agents active (${bridge.guiUrl ? "GUI online" : "offline"})`;
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const bridge = getActiveAgentcordBridge();
			if (!bridge) {
				runtime.ctx.showError("Agentcord bridge is not initialized.");
				return;
			}

			const args = command.args.trim();
			const { verb, rest } = parseSubcommand(args);

			if (!verb || verb === "status") {
				runtime.ctx.showStatus(bridge.getStatusSummary(), { dim: false });
				return;
			}

			if (verb === "gui" || verb === "open") {
				if (!bridge.guiUrl) {
					await bridge.start();
				}
				runtime.ctx.showStatus(
					`Agentcord Helper GUI: ${bridge.guiUrl}\n` +
						theme.fg("muted", "Open in browser to see live matrix, chatroom (GC/DM), and test runner."),
					{ dim: false }
				);
				try {
					runtime.ctx.openInBrowser?.(bridge.guiUrl);
				} catch {}
				return;
			}

			if (verb === "connect") {
				if (!rest.trim()) {
					runtime.ctx.showError("Usage: /agentcord connect <relayUrl>");
					return;
				}
				runtime.ctx.showStatus(`Connecting to Agentcord relay at ${rest.trim()}...`);
				const ok = await bridge.connect(rest.trim());
				if (ok) {
					runtime.ctx.showStatus(
						theme.fg("success", `Connected to Agentcord relay! Synced Queen & helper agents.`),
						{ dim: false }
					);
				} else {
					runtime.ctx.showError(`Failed to connect to Agentcord relay at ${rest.trim()}`);
				}
				return;
			}

			if (verb === "test") {
				runtime.ctx.showStatus("Triggering step test verification with [TestGen] and [Tester]...");
				try {
					const { testcases, result } = await bridge.runStepTest(rest.trim() || undefined);
					const statusColor = result.passed ? "success" : "error";
					const report = [
						theme.fg(statusColor, `Step Test Verification ${result.passed ? "PASSED" : "FAILED"}:`),
						`Generated Testcases (${testcases.length}):`,
						...testcases.map(t => `  • ${t}`),
						`Tester Output: ${result.diagnostics}`,
					].join("\n");
					runtime.ctx.showStatus(report, { dim: false });
				} catch (err) {
					runtime.ctx.showError(`Step test failed: ${errorMessage(err)}`);
				}
				return;
			}

			if (verb === "worker") {
				const parts = rest.trim().split(" ");
				if (parts.length < 2) {
					runtime.ctx.showError("Usage: /agentcord worker <specialty> <responsibility>");
					return;
				}
				const specialty = parts[0];
				const responsibility = parts.slice(1).join(" ");
				const worker = bridge.createWorker(specialty, responsibility);
				runtime.ctx.showStatus(
					theme.fg("success", `Created worker agent ${worker.name} for task: "${responsibility}"`),
					{ dim: false }
				);
				return;
			}

			if (verb === "name") {
				if (rest.trim()) {
					bridge.setUserName(rest.trim());
					runtime.ctx.showStatus(`Agentcord user name updated to "${rest.trim()}".`);
				} else {
					runtime.ctx.showStatus(`Current Agentcord user name: "${bridge.userName}". Use \`/agentcord name <newName>\` to change.`);
				}
				return;
			}

			runtime.ctx.showError(`Unknown subcommand "/agentcord ${verb}". Use /agentcord status|gui|connect|test|worker|name.`);
		},
	},
	{
		name: "ask",
		icon: "question",
		description: "Ask a question within the Agentcord agent hierarchy (Worker -> Queen, Queen -> King)",
		inlineHint: "<queen|king|agentId> <question>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const bridge = getActiveAgentcordBridge();
			if (!bridge) {
				runtime.ctx.showError("Agentcord bridge is not initialized.");
				return;
			}

			const parts = command.args.trim().split(" ");
			if (parts.length < 2) {
				runtime.ctx.showError("Usage: /ask <queen|king|agentId> <question>");
				return;
			}

			const target = parts[0];
			const question = parts.slice(1).join(" ");

			runtime.ctx.showStatus(`Escalating question to [${target}]...`);
			try {
				const answer = await bridge.ask(target, question);
				runtime.ctx.showStatus(
					`${theme.fg("accent", `Response from [${target}]:`)}\n${answer}`,
					{ dim: false }
				);
			} catch (err) {
				runtime.ctx.showError(`Failed to ask question: ${errorMessage(err)}`);
			}
		},
	},
	{
		name: "chat",
		icon: "chat",
		description: "Send a message into the Agentcord network (GC with Context Shield, or DM)",
		inlineHint: "<gc|dm> [recipient] <message>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const bridge = getActiveAgentcordBridge();
			if (!bridge) {
				runtime.ctx.showError("Agentcord bridge is not initialized.");
				return;
			}

			const tokens = command.args.trim().split(" ");
			if (tokens.length < 2) {
				runtime.ctx.showError("Usage: /chat <gc|dm> [recipient] <message>");
				return;
			}

			const mode = tokens[0].toLowerCase();
			if (mode === "gc") {
				const content = tokens.slice(1).join(" ");
				bridge.sendChat("gc", undefined, content);
				runtime.ctx.showStatus(theme.fg("muted", `[GC Message Sent]: ${content}`));
			} else if (mode === "dm") {
				if (tokens.length < 3) {
					runtime.ctx.showError("Usage: /chat dm <recipient> <message>");
					return;
				}
				const recipient = tokens[1];
				const content = tokens.slice(2).join(" ");
				bridge.sendChat("dm", recipient, content);
				runtime.ctx.showStatus(theme.fg("muted", `[DM to ${recipient}]: ${content}`));
			} else {
				runtime.ctx.showError("Invalid mode. Use `/chat gc <message>` or `/chat dm <recipient> <message>`.");
			}
		},
	},
];
