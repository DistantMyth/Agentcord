# Agentcord: a shared OMP swarm

Agentcord keeps oh-my-pi's model providers, authentication, tool harness, RPC client, and native Git APIs. It adds one persistent coordinator for multiple people's agents and a browser GUI for the whole team.

The default `agentcord` command runs real OMP sessions. Provider failures stay failures; it never substitutes a simulator or invents passing tests.

## Start

Prerequisites: Git, Bun 1.4.4 or newer, a shared Git remote that every participating runner can read and push to, and each member's own configured OMP provider. No additional server service or database installation is required.

```sh
git clone https://github.com/anujparwal/Agentcord.git
cd Agentcord
bun run agentcord:setup
```

Setup installs the pinned dependencies, downloads the exact matching published OMP native addon with SHA-512 verification, and generates OMP's existing tool-view assets. If that release has no published native addon for your platform, use the upstream `bun setup` source-build workflow. Setup does not globally replace your OMP installation.

Configure your provider using the native OMP interface (`bun dev`, then `/login` or `/models`), or your existing OMP settings and environment variables. API keys and OAuth credentials stay on each member's machine.

Host a room:

```sh
bun run agentcord --host --name Alice --repo /path/to/project --bind 0.0.0.0
```

Open the private owner link printed by the command. Use **Share invite** in the GUI for collaborators. Replace `127.0.0.1` in the shared URL with the host's reachable address. The host can attach further repositories using **Add project**; each project gets an independent integration branch and task graph.

On Windows, a short data path helps keep Git reference paths below platform limits:

```powershell
bun run agentcord --host --name Alice --repo C:\projects\app --data C:\ac\team --bind 0.0.0.0
```

The default bind address is loopback. For internet collaboration, use an existing private network such as Tailscale, or put the hub behind an HTTPS/WSS reverse proxy. Agentcord does not provide NAT traversal or hosted relay infrastructure. Members need access to both the hub and the shared Git remote.

Join in a browser with the invite link, choose a name, then copy **Connect my runner** and run that private command from this fork's checkout on your own machine. Alternatively:

```sh
bun run agentcord --join 'http://host:7466/#invite=INVITE_TOKEN' --name Bob
```

Quote the full invite URL. A member's saved token reconnects to their existing identity; repeating a display name cannot impersonate that identity. The CLI saves its member credential in the chosen data directory. Browser credentials are stored locally for that room. Keep owner links and member tokens private; they authorize access to shared conversations and commands.

Use `--omp-command '["omp"]'` to run an existing compatible OMP executable instead of this checkout's source CLI. The peer still needs this fork's matching native addon for Git operations.

## Roles and settings

**My roles** is the authoritative per-member configuration for this room. Set each role's model to an OMP `provider/model` ID or `default` to use that member's local OMP default. Add role instructions and choose 1–16 workers. Disable any optional role independently. An observer may disable every role.

| Role | Capacity and authority |
| --- | --- |
| King | Exactly one, owned by the host. Coordinates all members' agents. Has read-only repository tools and delegates implementation. |
| Queen | Optional per member. Coordinates the helpers assigned to it, including helpers owned by other members. Has read-only repository tools. |
| Worker | Optional, 1–16 per member. Implements scoped tasks with real OMP tools. |
| Test generation | Optional per member. Writes tests in its assigned task checkout. |
| Tester | Optional per member. Runs verification commands with read/search/shell tools. Any failed command, or no command at all, fails verification. |

Helpers prefer their owner's online queen. If that queen is disabled or offline, the hub distributes them among the available queens by load; the king is the fallback when no queens are online. Ownership and credentials remain with the contributing member. Settings survive restarts, and one member cannot change another member's models. Wait for active tasks before changing that member's roles.

From OMP, `/agentcord gui` explicitly starts the same hub and GUI. `/agentcord connect <invite-link>` joins an existing hub and contributes your runner. Opening OMP alone does not start another king. `/agentcord model`, `/agentcord assign`, `/agentcord worker`, `/ask`, and `/chat` use the same centralized state. The terminal bridge seeds new room models from OMP roles once; subsequent swarm settings live in the room rather than being repeatedly overwritten by a settings listener.

## How work is coordinated

Submit a goal to the king in the GUI. Real OMP sessions use the host-provided `swarm` tool to inspect capacity, delegate, ask questions, wait for results, answer queued questions, and send messages. Queens can delegate only to their assigned helpers; the king can use the whole swarm. Busy coordinators can answer a helper's question while waiting for that helper, avoiding a circular wait.

Tasks carry explicit path scopes and dependencies. The hub is the sole dispatcher: one execution per agent, parallel execution for disjoint paths, and queued execution for overlapping paths. An empty scope reserves the whole repository. Coordinators remain waiting until their delegated tasks settle; a failed child cannot produce a completed parent.

Each task receives a pinned integration revision, an isolated worktree, a unique branch, and a lease. The runner publishes its result branch; the hub verifies ancestry, the published commit, and changed paths before serially integrating its diff. Dependencies receive the updated integration revision. The source checkout and main branch are never automatically reset or merged. Merge the project integration branch through your normal review process when ready.

**Task completion means its execution and integration succeeded.** The tester role additionally requires a successful real command. Agentcord does not infer that the whole project is correct merely because an agent returned prose.

## Visibility and recovery

The GUI shows members, models, the hierarchy, task attempts and dependencies, integration revisions, conversations, tool arguments, commands, and outputs. The SQLite journal has monotonic event IDs, survives restarts, and can be loaded or exported. Group chat is visible to the room without automatically flooding agent contexts; addressed messages are forwarded to active recipients.

If a runner disconnects or misses heartbeats, its running tasks become interrupted and their previous leases cannot publish. Work is **not automatically duplicated on another runner**. Review the retained branch/workspace, then explicitly retry in a fresh attempt. Restarting the hub also interrupts unconfirmed executions.

Conflicts, failed pushes, and unexpected integration changes pause that project's dispatch. Failed worktrees and branches are retained. Resolve any uncommitted integration changes on the host, use **Reconcile & resume** to verify and publish its current branch without a force push, then retry the affected tasks. Failed dependencies interrupt downstream tasks with a visible reason.

The host data directory has an OS-backed exclusive lock, preventing two hub processes from scheduling the same room. The room database, credentials, runner clones/worktrees, and OMP session directories live under `.agentcord/` by default. Back up that directory. Choose `--data` to separate rooms or place data on a shorter path. Do not run the same data directory from multiple hosts over a network filesystem.

Worktrees prevent accidental shared-checkout edits; they are not an operating-system sandbox. Run only trusted collaborators on machines and repositories where they may execute commands. Conversations and tool output are shared with every room member; do not put secrets into them. Embedded HTTPS Git credentials are removed from the repository URL advertised to peers.

## Validation

```sh
bun run agentcord:test
bun --cwd packages/agentcord check
```

Tests cover optional roles and redistribution, authority boundaries, scoped scheduling, dependencies, leases, restart recovery, the real terminal/WebSocket path, real Git publication/integration/conflicts, and real OMP RPC execution against a deterministic local provider. No paid model requests are needed.

The old text-only agent classes remain exported for existing embedders; their simulators require an explicit `mock-sim-*` model and are not used by the CLI or GUI. Legacy text-only testers reject real models rather than claiming they executed code. Old `.agentcord/memory` files are preserved; v2 starts a new authoritative room and does not fabricate a migration from randomly identified legacy agents.
