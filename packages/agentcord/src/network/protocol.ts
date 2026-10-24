import type {
	AgentInfo,
	ChatMessage,
	QuestionEscalation,
	TestCase,
	TestRunResult,
	UserInfo,
} from "../types";

export type WireFrame =
	| {
			type: "hello";
			userName: string;
			queenModel?: string;
			workerModel?: string;
			testgenModel?: string;
			testerModel?: string;
	  }
	| {
			type: "welcome";
			roomId: string;
			hostUser: string;
			users: UserInfo[];
			agents: AgentInfo[];
			messages: ChatMessage[];
			questions: QuestionEscalation[];
			testCases: TestCase[];
			testRuns: TestRunResult[];
	  }
	| { type: "peer_joined"; user: UserInfo; agents: AgentInfo[] }
	| { type: "peer_left"; userName: string }
	| { type: "chat_message"; message: ChatMessage }
	| { type: "question_escalation"; question: QuestionEscalation }
	| { type: "agent_update"; agent: AgentInfo }
	| { type: "register_agent"; agent: AgentInfo }
	| { type: "model_update"; userName: string; agentId?: string; model: string; role?: string }
	| { type: "test_created"; testCase: TestCase }
	| { type: "test_run"; result: TestRunResult }
	| { type: "error"; message: string };

export function formatRoomJoinLink(hostUrl: string, roomId: string): string {
	const cleanHost = hostUrl.replace(/\/+$/, "");
	return `${cleanHost}/?room=${roomId}`;
}
