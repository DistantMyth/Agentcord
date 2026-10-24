import type { AgentInfo, ChatMessage, QuestionEscalation, TestCase, TestRunResult, UserInfo } from "../types";
import type { WireFrame } from "./protocol";

export interface PeerClientOptions {
	relayUrl: string;
	roomId: string;
	userName: string;
	queenModel?: string;
	workerModel?: string;
	testgenModel?: string;
	testerModel?: string;
	onStateUpdate?: (state: {
		roomId: string;
		hostUser: string;
		users: UserInfo[];
		agents: AgentInfo[];
		messages: ChatMessage[];
		questions: QuestionEscalation[];
		testCases: TestCase[];
		testRuns: TestRunResult[];
	}) => void;
	onMessage?: (msg: ChatMessage) => void;
	onQuestion?: (q: QuestionEscalation) => void;
	onAgentUpdate?: (agent: AgentInfo) => void;
}

export class AgentcordPeerClient {
	private ws: WebSocket | null = null;
	private readonly opts: PeerClientOptions;
	private isConnected = false;

	constructor(opts: PeerClientOptions) {
		this.opts = opts;
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const cleanUrl = this.opts.relayUrl.replace(/^http/, "ws").replace(/\/+$/, "");
			const wsUrl = `${cleanUrl}/ws?room=${this.opts.roomId}&user=${encodeURIComponent(this.opts.userName)}`;

			try {
				this.ws = new WebSocket(wsUrl);

				this.ws.onopen = () => {
					this.isConnected = true;
					// Send hello frame
					const hello: WireFrame = {
						type: "hello",
						userName: this.opts.userName,
						queenModel: this.opts.queenModel,
						workerModel: this.opts.workerModel,
						testgenModel: this.opts.testgenModel,
						testerModel: this.opts.testerModel,
					};
					this.send(hello);
					resolve();
				};

				this.ws.onmessage = event => {
					try {
						const raw = typeof event.data === "string" ? event.data : event.data.toString();
						const frame = JSON.parse(raw) as WireFrame;
						this.handleFrame(frame);
					} catch (err) {
						console.error("Error processing incoming frame:", err);
					}
				};

				this.ws.onerror = err => {
					if (!this.isConnected) {
						reject(err);
					}
				};

				this.ws.onclose = () => {
					this.isConnected = false;
				};
			} catch (err) {
				reject(err);
			}
		});
	}

	send(frame: WireFrame): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(frame));
		}
	}

	sendChatMessage(msg: ChatMessage): void {
		this.send({ type: "chat_message", message: msg });
	}

	submitQuestion(fromAgent: string, toAgent: string, question: string): void {
		this.send({
			type: "question_escalation",
			question: {
				id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
				fromAgent,
				fromRole: "worker",
				toAgent,
				toRole: "queen",
				question,
				status: "pending",
				createdAt: Date.now(),
			},
		});
	}

	updateModel(agentId: string, model: string): void {
		this.send({
			type: "model_update",
			userName: this.opts.userName,
			agentId,
			model,
		});
	}

	close(): void {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	private handleFrame(frame: WireFrame): void {
		switch (frame.type) {
			case "welcome":
				this.opts.onStateUpdate?.(frame);
				break;
			case "chat_message":
				this.opts.onMessage?.(frame.message);
				break;
			case "question_escalation":
				this.opts.onQuestion?.(frame.question);
				break;
			case "agent_update":
				this.opts.onAgentUpdate?.(frame.agent);
				break;
		}
	}
}
