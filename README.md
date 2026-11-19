# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/KangGalon26/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/KangGalon26/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, written in TypeScript against the Node standard library only — no dependencies, no `git` binary, no network. It keeps its own git object store (SHA-1 addressed blobs, trees, commits and annotated tags, pack read/write with delta resolution) and serves four surfaces from that one store:

- **git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 (`ls-refs`, `fetch` with shallow/deepen) and v0 upload-pack/receive-pack, with per-ref report-status on push.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents backed by real commits, labels, issues and comments, pull requests with file diffs and squash/merge merges.
- **GraphQL v4** at `/api/graphql` — viewer, repository, issue and pull-request queries with cursor pagination, the five mutations (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment), `node(id:)` and the introspection `gh` feature-detects.
- **MCP** at `/mcp` — JSON-RPC over streamable HTTP speaking the 2026-07-28 revision (`server/discover`) and the handshake revisions before it, with six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) that read and write the same objects REST sees.

State is deterministic: timestamps come from a logical clock, so a trial's export is byte-identical across live and replay runs.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the harness env at `$MAKEFUN_ENV_URL`, and serves until the env says the trial is done. Node 22.18+ strips the TypeScript types natively; the flag only helps older local Nodes. For a standalone look, set `MAKEFUN_SHOP_TOKEN` to any value and call the surfaces with `Authorization: Bearer <that value>`; `/healthz` answers without one.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll `/done`, exit 0).
- `app.ts` — routing, auth and the wire contract for all four surfaces.
- `store.ts` — the in-memory store: users, repositories, the git object database and the deterministic clock.
- `git.ts` — pkt-lines, packfiles, advertisements, fetch planning (haves/shallow/depth) and receive-pack.
- `rest.ts` — the REST v3 resources and serializers.
- `graphql.ts` — a small GraphQL lexer/parser/executor over the store.
- `mcp.ts` — the MCP endpoint and its tools.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tcqak6kb&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
