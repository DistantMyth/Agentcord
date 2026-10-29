# Changelog

## [Unreleased]

### Changed

- Run a shared persistent OMP swarm with one host king, optional per-member roles and models, cross-user delegation, and a unified browser and terminal interface.
- Execute tasks in isolated Git worktrees and publish verified results to a separate integration branch with scoped scheduling and dependency tracking.

### Added

- Shared command and conversation history, authenticated member identities, restart recovery, fenced task leases, and explicit conflict recovery.
- A setup command that reuses the matching published OMP native addon and verifies its integrity.

### Fixed

- Report provider failures and failed verification commands without substituting simulated success.
- Prevent opening OMP terminals from automatically starting competing kings and relays.
- Allow slow Windows OMP source launches to finish their startup handshake before reporting failure.
