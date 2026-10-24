import type { ChatMessage } from "../types";

/**
 * Context Filter - Protects Agent Token Windows
 *
 * All messages are NOT dumped over all agents.
 * An agent's context is only populated with:
 * 1. DMs addressed to this agent
 * 2. DMs sent by this agent
 * 3. GC messages that explicitly @mention this agent's name or role tag
 */
export class ContextFilter {
	static filterForAgent(
		agentFormattedName: string,
		agentRole: string,
		messages: ChatMessage[]
	): ChatMessage[] {
		const targetName = agentFormattedName.toLowerCase();
		const roleMention = `@${agentRole.toLowerCase()}`;

		return messages.filter(msg => {
			// Direct Messages directed to or from this agent
			if (msg.type === "dm") {
				const toMatches = msg.to?.toLowerCase() === targetName;
				const fromMatches = msg.from.toLowerCase() === targetName;
				return toMatches || fromMatches;
			}

			// Group Chat (GC): Only include if specifically @mentioned
			if (msg.type === "gc") {
				const lowerText = msg.text.toLowerCase();
				const mentionsName = lowerText.includes(targetName);
				const mentionsRole = lowerText.includes(roleMention);
				return mentionsName || mentionsRole;
			}

			return false;
		});
	}

	/**
	 * Formats filtered messages into a prompt-ready transcript for the agent.
	 */
	static formatContextTranscript(filteredMessages: ChatMessage[]): string {
		if (filteredMessages.length === 0) return "";
		const lines = ["### Relevant Message History:"];
		for (const msg of filteredMessages.slice(-15)) {
			const typeTag = msg.type === "dm" ? `[DM to ${msg.to || "Unknown"}]` : `[GC]`;
			lines.push(`${typeTag} ${msg.from}: ${msg.text}`);
		}
		return lines.join("\n");
	}
}
