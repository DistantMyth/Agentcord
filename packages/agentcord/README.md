# Agentcord: Multi-User Collaborative AI Agent Network
> **Fork of [oh-my-pi](https://github.com/can1357/oh-my-pi)**

Agentcord extends `oh-my-pi` into a collaborative multi-agent platform where multiple users over the internet can connect, collaborate, and orchestrate hierarchical AI agent teams in a synchronized live chatroom.

---

## 🌟 Key Architecture & Highlights

### 1. Hierarchical Multi-Agent Roles & Naming
Every agent and participant follows a structured naming convention:
- **King Agent (`[King: <UserName>]`)**: The session master agent (hosted by the primary user). Decomposes project-level goals into modular domain responsibilities, assigns them to Queen agents, and provides authoritative rulings for escalated questions.
- **Queen Agent (`[Queen: <UserName>]`)**: Each connected user controls a Queen agent that manages their primary module or domain responsibility, commands helper worker agents, answers cross-agent domain questions, and escalates to the King agent.
- **Worker / Helper Agent (`[Worker: <UserName> - <WorkerName>]`)**: Specialized agents spawned by a Queen to execute targeted sub-tasks. Any worker can ask questions to ANY Queen agent across the network.
- **Testcase Generator Helper (`[TestGen: <UserName>]`)**: Automatically spun up by each Queen to formulate comprehensive testcases, boundary constraints, and validation assertions for the assigned responsibility.
- **Step Tester Helper (`[Tester: <UserName>]`)**: Automatically spun up by each Queen to execute step verification tests at each phase of development and report diagnostics.
- **Human User (`[User: <UserName>]`)**: The human collaborator behind their agent team.

### 2. Live Agent Responsibility Matrix
Connected agents and users join a shared room that maintains real-time tracking of:
- Agent Formatted Name & Role
- Owner User
- Current Responsibility & Active Sub-task
- Execution Status (`idle`, `planning`, `working`, `questioning`, `testing`, `completed`)
- Configured Model
- Preserved Memory Count

### 3. Persistent Memory Engine
- Preserves working memory, discovered facts, architectural decisions, Q&A interactions, and step test histories across turns, disconnects, and restarts.
- Stored persistently on disk in `.agentcord/memory/<agentId>.json`.

### 4. Context Shield (GC vs. DM Context Protection)
- **Group Chat (GC)**: Broadcasts broad project updates, milestones, and user chatter. GC messages are **not** dumped into agents' context windows unless an agent is explicitly `@mentioned`, preventing token window saturation and hallucinations.
- **Direct Messages (DM)**: Private 1-to-1 conversations (`User <-> User`, `User <-> Agent`, `Worker -> Queen`, `Queen -> King`). Messages in DMs are delivered strictly to the target agent's LLM context with relevant history.

### 5. Multi-User Internet & LAN Connectivity
- Built-in Relay Server with WebSocket synchronization.
- Generating shareable invite links (`http://<ip>:<port>/?room=<roomId>`) or direct room codes.
- Peers connect, handshake with their user name and configured models, and synchronize room state in real-time.

### 6. Per-User & Per-Agent Model Flexibility
- Different users can configure distinct LLM providers and models:
  - Anthropic (`claude-3-7-sonnet`, `claude-3-5-haiku`, `claude-3-5-sonnet`)
  - Google Gemini (`gemini-2.5-pro`, `gemini-2.5-flash`)
  - OpenAI (`gpt-4.5-preview`, `gpt-4o`, `o3-mini`)
  - Local / Ollama (`deepseek-r1:32b`, `llama3.3:70b`, `qwen2.5-coder:32b`)
  - Intelligent Offline Simulator (`mock-sim-pro`, `mock-sim-fast`)

### 7. Helper GUI
A sleek, modern web GUI providing:
- Connection setup (Name prompt, Host/Join room, 1-click Copy Invite Link)
- Live Responsibility Table & Agent Cards
- Live Chatroom with GC and DM tab separation
- Model Configuration Drawer
- Real-time Test Runner & Verification Panel
- Persistent Memory Inspector

---

## 🚀 Quick Start

### 1. Launching Agentcord via CLI
```bash
bun run agentcord
```
Agentcord prompts:
```text
What is your name? [Developer]: Alice
Do you want to (H)ost a new room or (J)oin an existing room? [H]: H
```

### 2. Starting with Web Helper GUI
```bash
bun run agentcord --host --name Alice --port 7466
```
Open your browser to:
```text
http://localhost:7466/?room=room_123456
```

### 3. Joining as a Peer / Guest
```bash
bun run agentcord --join "http://<host-ip>:7466/?room=room_123456" --name Bob
```

---

## 🧪 Testing Suite

Run the full suite of unit and integration tests:
```bash
bun run agentcord:test
```
Includes:
- Agent naming conventions and parsing (`test/naming.test.ts`)
- Persistent memory across restarts (`test/memory.test.ts`)
- King, Queen, and Worker Q&A hierarchy (`test/hierarchy.test.ts`)
- Context Shield protection against token bloat (`test/chat-context.test.ts`)
- Per-user model configuration (`test/models.test.ts`)
- Testcase Generator & Step Tester subagents (`test/testgen-tester.test.ts`)
- Network relay and room state synchronization (`test/network-relay.test.ts`)
