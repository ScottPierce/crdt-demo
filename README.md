# CRDT Demo

*This repository was AI generated, to learn about CRDT libraries, how they work, and the differences between Yjs and Automerge.

This repo contains two side-by-side, script-based demos that illustrate collaborative editing and offline sync using CRDT libraries:

- **Yjs demo** (`/demos/yjs-demo`): update-based CRDT with built-in undo/redo.
- **Automerge 3 demo** (`/demos/automerge-demo`): change-based CRDT with a simulated “server version gate” and two conflict policies.

There is **no real server**. Each demo uses:
- an **in-memory append-only log** (the “server source of truth”),
- **async functions** with artificial latency to mimic network calls,
- an **online/offline toggle** to simulate connectivity loss,
- terminal logs to show what happens step-by-step.

---

## Repo layout

```
CRDT Demo/
  demos/
    yjs-demo/
      src/index.ts
    automerge-demo/
      src/index.ts
  README.md
  bunfig.toml
  package.json
```

---

## Requirements

- **Bun** (latest recommended)

---

## Install

From the repo root:

```bash
bun install
```

---

## Run

### Run the Yjs demo

```bash
bun run yjs
```

### Run the Automerge 3 demo

```bash
bun run am
```

### Run both sequentially

```bash
bun run all
```

---

## What the demos simulate

Both demos simulate two clients:
- **Alice**
- **Bob**

…and a “server” that:
- stores an **append-only log** of updates/ops,
- provides `fetchSince(cursor)` and `submit(...)`,
- broadcasts updates to subscribers (in-memory pub/sub),
- adds artificial latency to behave like a network.

Both demos run the same three scenarios:

1) **Non-conflicting concurrency**
   - Alice edits one part of the doc while online
   - Bob edits a different part while offline
   - Bob reconnects and syncs
   - Expected outcome: **both changes preserved**

2) **Conflicting concurrency**
   - Alice and Bob both edit the same field while starting from the same base
   - Bob reconnects and syncs
   - Expected outcome differs by library and policy:
     - Yjs: CRDT merge rules decide the result
     - Automerge: shows both (a) overwrite-after-rebase and (b) strict first-wins

3) **Undo/redo propagation**
   - Alice performs an edit, syncs
   - Alice undoes it, syncs (Bob sees the undo)
   - Alice redoes it, syncs (Bob sees the redo)

---

## Document model

Both demos operate on the same conceptual document:

```ts
type Node = { title: string; color: string; desc: string };
type Doc = { nodes: Record<string, Node>; order: string[] };
```

Initial state:
- `nodeA`: title `"Settings"`, color `"blue"`, desc `"Hello"`
- `nodeB`: title `"Profile"`,  color `"green"`, desc `"World"`
- `order`: `["nodeA", "nodeB"]`

---

## How to read the logs

Each printed line uses a consistent prefix:

- `[yjs][server] ...` or `[yjs][alice] ...`
- `[am][server] ...` or `[am][bob] ...`

The scripts repeatedly print:
- server cursor/version
- client cursor/version
- queued outbound updates/ops
- a small doc summary (e.g., `nodeA.title`, `nodeB.color`, `desc length`)
- the tail of the server log (last few entries)

The point is to make it obvious:
- what state is **local**,
- what state is **server-acknowledged**,
- what gets queued while offline,
- what gets pulled/pushed during resync.

---

## What the Yjs demo is demonstrating

- Clients maintain their own **`Y.Doc`**.
- Every local edit emits a binary update (`Uint8Array`) that is submitted to the server.
- The server appends the update to an ordered log and pushes it to other clients.
- On reconnect, a client calls `fetchSince(lastSeqApplied)` to pull **only missing updates**.
- Undo/redo uses **`Y.UndoManager`**, and undo/redo actions replicate like normal edits.

Key point: the server is mostly a **durable broadcaster**. Convergence comes from Yjs CRDT rules.

---

## What the Automerge 3 demo is demonstrating

Each client keeps two documents:
- **`shadowDoc`**: the last state confirmed by the server (what the server has accepted)
- **`localDoc`**: `shadowDoc` plus any local edits (including offline edits)

The server maintains:
- a monotonic **`version`**
- a log of `{ version, changes[] }`

Sync loop when online:
1) pull ops since `serverVersion` and apply to both docs
2) compute `pending = getChanges(shadowDoc, localDoc)`
3) attempt to commit with `expectedVersion = serverVersion`

### “First-to-server wins” via version gate

Only one commit can advance a version. If Bob tries to commit while stale, he gets `STALE_VERSION` and must pull/rebase/retry.

### Two conflict policies shown

- **Overwrite-after-rebase (strict OFF):**
  - Bob’s change can still be committed after he rebases, meaning later edits can overwrite earlier ones.

- **Strict first-wins (strict ON):**
  - The demo tracks “touched paths” for each commit (e.g., `nodes.nodeA.title`).
  - When Bob is stale, it compares his local touched paths against server-touched paths since his base.
  - Any overlapping paths are reverted to the server value before recomputing pending changes.
  - Result: **conflicting local edits are dropped**, but **non-conflicting local edits still commit**.

---

## Notes and limitations

- This repo is intentionally small and educational.
- The “server” is in-memory per script run (no persistence).
- The Automerge strict conflict policy uses **path tracking** to illustrate the concept; real systems may use richer domain operations and validation.

---

## Troubleshooting

- If `bun install` fails, update Bun to the latest version.
- If a script fails due to a dependency mismatch, ensure the dependencies are installed from the repo root and rerun.

---

## License

Add a license file if you plan to share this publicly.
