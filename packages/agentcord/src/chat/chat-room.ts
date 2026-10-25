import type { AgentRegistry } from "../agents";
import { parseFormattedName } from "../naming";
import type { ChatMessage, MessageType, QuestionEscalation } from "../types";
import { ContextFilter } from "./context-filter";

export type ChatListener = (message: ChatMessage) => void;
export type QuestionListener = (q: QuestionEscalation) => void;

export class ChatRoom {
	private readonly messages: ChatMessage[] = [];
	private readonly questions = new Map<string, QuestionEscalation>();
	private readonly messageListeners = new Set<ChatListener>();
	private readonly questionListeners = new Set<QuestionListener>();

	constructor(private readonly registry: AgentRegistry) {}

	/**
	 * Sends a message into the chatroom (either Group Chat 'gc' or Direct Message 'dm').
	 */
	async sendMessage(params: {
		type: MessageType;
		from: string;
		fromUser: string;
		to?: string;
		text: string;
		replyToId?: string;
		isQuestion?: boolean;
		questionId?: string;
	}): Promise<ChatMessage> {
		const message: ChatMessage = {
			id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			type: params.type,
			from: params.from,
			fromUser: params.fromUser,
			to: params.to,
			text: params.text,
			timestamp: Date.now(),
			replyToId: params.replyToId,
			isQuestion: params.isQuestion,
			questionId: params.questionId,
		};

		this.messages.push(message);
		this.notifyMessage(message);

		// If this is a DM addressed to an AI agent, trigger agent response asynchronously
		if (message.type === "dm" && message.to) {
			this.routeDmToAgent(message).catch(err => {
				console.error(`Error routing DM to agent ${message.to}:`, err);
			});
		}

		return message;
	}

	/**
	 * Submits a formal question escalation (Worker -> Queen or Queen -> King).
	 */
	async submitQuestion(
		fromAgent: string,
		toAgent: string,
		questionText: string
	): Promise<QuestionEscalation> {
		const parsedFrom = parseFormattedName(fromAgent);
		const parsedTo = parseFormattedName(toAgent);

		const qId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
		const q: QuestionEscalation = {
			id: qId,
			fromAgent,
			fromRole: parsedFrom.role || "worker",
			toAgent,
			toRole: parsedTo.role || "queen",
			question: questionText,
			status: "pending",
			createdAt: Date.now(),
		};

		this.questions.set(qId, q);
		this.notifyQuestion(q);

		// Also post the question as a DM
		await this.sendMessage({
			type: "dm",
			from: fromAgent,
			fromUser: parsedFrom.userName,
			to: toAgent,
			text: `[Question Escalation] ${questionText}`,
			isQuestion: true,
			questionId: qId,
		});

		return q;
	}

	/**
	 * Dispatches DM message to target agent with filtered, lean context.
	 */
	private async routeDmToAgent(dm: ChatMessage): Promise<void> {
		if (!dm.to) return;
		const targetAgent = this.registry.findAgentByName(dm.to);
		if (!targetAgent) return;

		// Extract lean context strictly for this target agent
		const agentContextMessages = ContextFilter.filterForAgent(
			targetAgent.name,
			targetAgent.role,
			this.messages
		);
		const contextTranscript = ContextFilter.formatContextTranscript(agentContextMessages);

		let replyText = "";
		if (targetAgent.role === "king") {
			const king = this.registry.getKing();
			if (king) {
				replyText = await king.answerQueenQuestion(dm.from, dm.text);
			}
		} else if (targetAgent.role === "queen") {
			const queen = targetAgent as any;
			if (typeof queen.answerWorkerQuestion === "function") {
				replyText = await queen.answerWorkerQuestion(dm.from, dm.text);
			}
		} else {
			// Worker or helper response
			replyText = `[${targetAgent.name}] Acknowledged: "${dm.text.slice(0, 50)}". Processing under ${targetAgent.responsibility}.`;
		}

		if (replyText) {
			// Update question escalation if matching
			if (dm.questionId && this.questions.has(dm.questionId)) {
				const q = this.questions.get(dm.questionId)!;
				q.answer = replyText;
				q.status = "answered";
				q.answeredAt = Date.now();
				this.notifyQuestion(q);
			}

			// Send answer back in DM
			const replyMsg: ChatMessage = {
				id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
				type: "dm",
				from: targetAgent.name,
				fromUser: targetAgent.owner,
				to: dm.from,
				text: replyText,
				timestamp: Date.now(),
				replyToId: dm.id,
				isAnswer: true,
				questionId: dm.questionId,
			};
			this.messages.push(replyMsg);
			this.notifyMessage(replyMsg);
		}
	}

	getMessages(type?: MessageType): ChatMessage[] {
		if (!type) return [...this.messages];
		return this.messages.filter(m => m.type === type);
	}

	getDmMessagesBetween(participantA: string, participantB: string): ChatMessage[] {
		const a = participantA.toLowerCase();
		const b = participantB.toLowerCase();
		return this.messages.filter(m => {
			if (m.type !== "dm") return false;
			const from = m.from.toLowerCase();
			const to = m.to?.toLowerCase();
			return (from === a && to === b) || (from === b && to === a);
		});
	}

	getQuestions(): QuestionEscalation[] {
		return Array.from(this.questions.values());
	}

	subscribeMessages(listener: ChatListener): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onMessage(listener: ChatListener): () => void {
		return this.subscribeMessages(listener);
	}

	postMessage(sender: string, content: string, kind: MessageType = "gc", recipient?: string): ChatMessage {
		const parsed = parseFormattedName(sender);
		const fromUser = parsed.userName || sender;
		const message: ChatMessage = {
			id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			type: kind,
			from: sender,
			fromUser,
			to: recipient,
			text: content,
			timestamp: Date.now(),
		};
		this.messages.push(message);
		this.notifyMessage(message);
		return message;
	}

	getContextForAgent(agentNameOrId: string, roleOrName?: string): string {
		let name = agentNameOrId;
		let role = roleOrName || "queen";
		if (agentNameOrId.startsWith("[")) {
			name = agentNameOrId;
		} else if (roleOrName && roleOrName.startsWith("[")) {
			name = roleOrName;
			role = agentNameOrId;
		}
		const relevant = ContextFilter.filterForAgent(name, role, this.messages);
		return ContextFilter.formatContextTranscript(relevant);
	}

	getResponsibilityMatrix() {
		return this.registry.getResponsibilityMatrix();
	}

	updateResponsibility(
		agentId: string,
		_agentName: string,
		_role: string,
		responsibility: string,
		status?: any
	): void {
		this.registry.updateResponsibility(agentId, responsibility);
		if (status) {
			this.registry.updateStatus(agentId, status);
		}
	}

	subscribeQuestions(listener: QuestionListener): () => void {
		this.questionListeners.add(listener);
		return () => this.questionListeners.delete(listener);
	}

	private notifyMessage(msg: ChatMessage): void {
		for (const l of this.messageListeners) {
			try {
				l(msg);
			} catch (err) {
				console.error("Error in message listener:", err);
			}
		}
	}

	private notifyQuestion(q: QuestionEscalation): void {
		for (const l of this.questionListeners) {
			try {
				l(q);
			} catch (err) {
				console.error("Error in question listener:", err);
			}
		}
	}
}
