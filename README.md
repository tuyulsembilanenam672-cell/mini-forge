# mini-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/tuyulsembilanenam672-cell/mini-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/tuyulsembilanenam672-cell/mini-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in Node.js (stdlib only): git smart HTTP (protocol v2 upload-pack, v0 upload-pack and receive-pack), REST v3, GraphQL, and MCP — all on one in-memory store, no git binary, no outside service.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 npm start
```

The entry binds an ephemeral port, registers it with the env, serves until the env says done, then exits 0.

## Layout

- `main.ts` — the entry lifecycle (bind, register, wait for done).
- `app.ts` — HTTP server and routing.
- `store.ts` — in-memory store and the git object model (SHA-1, packfiles).
- `service.ts` — domain operations shared by REST, GraphQL and MCP.
- `git.ts` — git smart HTTP (pkt-lines, v2/v0, sideband, shallow clones).
- `rest.ts` — GitHub REST v3.
- `graphql.ts` — a small GraphQL executor for the documented operations.
- `mcp.ts` — Model Context Protocol (Streamable HTTP, revision 2026-07-28).

---
<sub>Entered on [make.fun](https://make.fun/?ref=sq78y28z&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
