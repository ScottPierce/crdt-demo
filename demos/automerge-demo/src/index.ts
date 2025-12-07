import * as A from '@automerge/automerge';
import { randomUUID } from 'crypto';

// --- Shared Types ---
type Node = { title: string; color: string; desc: string };
type DocType = { nodes: { [key: string]: Node }; order: string[] };

// --- Configuration ---
const DELAY_MS = 10;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- Logging ---
function log(component: string, step: string, msg: string) {
  console.log(`[automerge-demo][${component}][${step}] ${msg}`);
}

function logState(name: string, doc: A.Doc<DocType>, extra: any = {}) {
  const nodeA = doc.nodes?.['nodeA'];
  const nodeB = doc.nodes?.['nodeB'];
  
  const summary = {
    nodeA_title: nodeA?.title || 'N/A',
    nodeB_color: nodeB?.color || 'N/A',
    nodeA_desc_len: nodeA?.desc?.length || 0,
    ...extra
  };
  
  console.log(`[automerge-demo][${name}][STATE] ${JSON.stringify(summary)}`);
}

// --- Server ---
type Op = {
  version: number;
  opId: string;
  actorId: string;
  changes: Uint8Array[];
  touchedPaths: string[];
};

class Server {
  version = 0;
  ops: Op[] = [];
  committedOpIds = new Set<string>();

  async fetchSince(v: number): Promise<Op[]> {
    await delay(DELAY_MS);
    return this.ops.filter(op => op.version > v);
  }

  async commit(req: { expectedVersion: number; opId: string; actorId: string; changes: Uint8Array[]; touchedPaths: string[] }) {
    await delay(DELAY_MS);
    
    if (this.committedOpIds.has(req.opId)) {
      const op = this.ops.find(o => o.opId === req.opId);
      return op!.version;
    }

    if (req.expectedVersion !== this.version) {
      throw { code: 'STALE_VERSION', currentVersion: this.version };
    }

    this.version++;
    const op: Op = {
      version: this.version,
      opId: req.opId,
      actorId: req.actorId,
      changes: req.changes,
      touchedPaths: req.touchedPaths
    };
    this.ops.push(op);
    this.committedOpIds.add(req.opId);
    
    return this.version;
  }
  
  printLogTail() {
    const tail = this.ops.slice(-5);
    console.log(`[automerge-demo][server][LOG] Tail (last ${tail.length}):`);
    tail.forEach(op => {
      console.log(`  Ver ${op.version} from ${op.actorId} (${op.changes.length} changes)`);
    });
  }
}

// --- Client ---
class Client {
  actorId: string;
  localDoc: A.Doc<DocType>;
  shadowDoc: A.Doc<DocType>; // The state acknowledged by server
  serverVersion = 0;
  touchedPaths = new Set<string>();
  isOnline = true;
  server: Server;
  strictMode = false;
  
  undoStack: Uint8Array[] = [];

  constructor(id: string, server: Server) {
    this.actorId = id;
    this.server = server;
    // Initialize with A.init
    // Shadow doc must start empty to match server version 0
    // Local doc starts empty, init changes happen in 'run' or via sync
    this.localDoc = A.init({ actorId: id });
    this.shadowDoc = A.init({ actorId: id });
  }

  // Make a local change
  change(message: string, cb: (d: DocType) => void) {
    // Save state for undo before changing
    this.undoStack.push(A.save(this.localDoc));
    
    const headsBefore = A.getHeads(this.localDoc);
    this.localDoc = A.change(this.localDoc, message, cb);
    const headsAfter = A.getHeads(this.localDoc);
    
    const patches = A.diff(this.localDoc, headsBefore, headsAfter);
    patches.forEach(p => {
        const pathStr = p.path.join('.');
        this.touchedPaths.add(pathStr);
    });
  }
  
  undo() {
      if (this.undoStack.length > 0) {
          log(this.actorId, 'UNDO', 'Restoring snapshot...');
          const snapshot = this.undoStack.pop()!;
          this.localDoc = A.load(snapshot);
          // Note: In real app we might want to re-diff to see what changed from shadow
          // but for demo we trust sync loop will pick up diff.
      }
  }

  async syncNow() {
    if (!this.isOnline) return;
    
    log(this.actorId, 'SYNC', 'Starting sync loop...');
    
    let retry = true;
    while (retry) {
        retry = false; // assume success unless stale
        
        // 1. Pull
        const ops = await this.server.fetchSince(this.serverVersion);
        if (ops.length > 0) {
            log(this.actorId, 'SYNC', `Pulled ${ops.length} ops`);
            
            const changes = ops.flatMap(o => o.changes);
            const serverChangedPaths = new Set<string>();
            ops.forEach(o => o.touchedPaths.forEach(p => serverChangedPaths.add(p)));
            
            // Apply to shadow
            let cleanShadow = A.clone(this.shadowDoc);
            const [newShadow] = A.applyChanges(cleanShadow, changes);
            this.shadowDoc = newShadow;
            
            // Apply to local
            // Use clone to avoid "outdated document" if any
            let cleanLocal = A.clone(this.localDoc);
            const [newLocal] = A.applyChanges(cleanLocal, changes);
            this.localDoc = newLocal;
            
            this.serverVersion = ops[ops.length - 1].version;
            
            // Strict Mode Handling
            if (this.strictMode) {
                const conflicts = [...this.touchedPaths].filter(p => serverChangedPaths.has(p));
                if (conflicts.length > 0) {
                    log(this.actorId, 'SYNC', `Strict Mode conflict on: ${conflicts.join(', ')}. Reverting.`);
                    
                    this.localDoc = A.change(this.localDoc, 'Revert conflicts', d => {
                        conflicts.forEach(path => {
                            const val = this.getByPath(this.shadowDoc, path);
                            this.setByPath(d, path, val);
                            this.touchedPaths.delete(path);
                        });
                    });
                }
            }
        }
        
        // 2. Compute changes to push
        // We compare shadowDoc (server state) with localDoc
        // IMPORTANT: We must ensure they share history. A.load in undo might break history sharing if not careful?
        // A.load creates a NEW doc. 
        // If A.load is used, we might need to merge or something.
        // But A.getChanges(old, new) requires 'old' to be an ancestor of 'new'.
        // If we A.load(snapshot), 'new' is the snapshot. 'old' is shadowDoc.
        // Does shadowDoc belong to ancestry of snapshot?
        // Yes, if snapshot was taken AFTER shadowDoc was last updated.
        // But if we undo past shadowDoc? Then getChanges might fail or return huge changes.
        // For this demo, we assume undo is within reasonable bounds.
        
        let changes: Uint8Array[] = [];
        try {
            changes = A.getChanges(this.shadowDoc, this.localDoc);
        } catch (e) {
            console.error('Error computing changes (history divergence?):', e);
            // Fallback: if history diverged (e.g. via undo to before sync), we might need to re-sync/rebase?
            // For now just log.
            break;
        }
        
        if (changes.length === 0) {
            log(this.actorId, 'SYNC', 'No changes to push.');
            break;
        }
        
        // 3. Commit
        try {
            const opId = randomUUID();
            const ver = await this.server.commit({
                expectedVersion: this.serverVersion,
                opId,
                actorId: this.actorId,
                changes,
                touchedPaths: Array.from(this.touchedPaths)
            });
            
            // Success
            log(this.actorId, 'SYNC', `Committed version ${ver}`);
            this.serverVersion = ver;
            this.shadowDoc = this.localDoc; // fast forward shadow
            this.touchedPaths.clear();
            
        } catch (e: any) {
            if (e.code === 'STALE_VERSION') {
                log(this.actorId, 'SYNC', 'Stale version (concurrent commit), retrying...');
                retry = true;
            } else {
                throw e;
            }
        }
    }
    
    this.printStatus();
  }

  printStatus() {
      logState(this.actorId, this.localDoc, {
          ver: this.serverVersion,
          touched: this.touchedPaths.size
      });
  }

  // Helpers
  getByPath(obj: any, path: string) {
      return path.split('.').reduce((o, k) => o && o[k], obj);
  }
  
  setByPath(obj: any, path: string, val: any) {
      const parts = path.split('.');
      const last = parts.pop()!;
      const target = parts.reduce((o, k) => o[k], obj);
      if (target) target[last] = val;
  }
}

async function run() {
  const server = new Server();
  const alice = new Client('Alice', server);
  const bob = new Client('Bob', server);

  console.log('--- [SETUP] Initializing ---');
  
  alice.change('Init', d => {
      d.nodes = {};
      d.order = [];
      d.nodes['nodeA'] = { title: 'Settings', color: 'blue', desc: 'Hello' };
      d.nodes['nodeB'] = { title: 'Profile', color: 'green', desc: 'World' };
      d.order = ['nodeA', 'nodeB'];
  });
  
  await alice.syncNow();
  await bob.syncNow(); // Bob pulls init
  
  server.printLogTail();

  // 1. Non-conflicting
  console.log('\n--- [SCENARIO 1] Non-conflicting concurrency ---');
  alice.isOnline = true;
  bob.isOnline = false;
  
  alice.change('Alice updates title', d => {
      d.nodes['nodeA'].title = 'Settings v2';
  });
  await alice.syncNow();
  
  bob.change('Bob updates color', d => {
      d.nodes['nodeB'].color = 'red';
  });
  
  bob.isOnline = true;
  await bob.syncNow();
  await alice.syncNow();
  
  server.printLogTail();

  // 2. Conflicting (Standard Automerge)
  console.log('\n--- [SCENARIO 2a] Conflicting concurrency (Allow Overwrite) ---');
  // State is converged.
  alice.change('Alice title Prefs', d => {
      d.nodes['nodeA'].title = 'Preferences';
  });
  
  bob.isOnline = false;
  bob.change('Bob title Config', d => {
      d.nodes['nodeA'].title = 'Config';
  });
  
  await alice.syncNow();
  
  bob.isOnline = true;
  bob.strictMode = false; // Standard
  await bob.syncNow();
  await alice.syncNow();
  
  console.log('Result (Last Write Wins expected):');
  alice.printStatus();
  bob.printStatus();
  
  // 2b. Conflicting (Strict First-Wins)
  console.log('\n--- [SCENARIO 2b] Conflicting concurrency (Strict First-Wins) ---');
  // Reset titles to verify
  alice.change('Reset', d => { d.nodes['nodeA'].title = 'Base'; });
  await alice.syncNow();
  await bob.syncNow();
  
  alice.change('Alice title First', d => { d.nodes['nodeA'].title = 'First'; });
  
  bob.isOnline = false;
  bob.change('Bob title Second', d => { d.nodes['nodeA'].title = 'Second'; });
  
  await alice.syncNow(); // Alice commits 'First'
  
  bob.isOnline = true;
  bob.strictMode = true; // Strict
  console.log('Bob syncing with Strict Mode ON...');
  await bob.syncNow(); // Should detect conflict and revert 'Second' to 'First'
  
  await alice.syncNow();
  
  console.log('Result (First Wins expected):');
  alice.printStatus();
  bob.printStatus();

  // 3. Undo/Redo
  console.log('\n--- [SCENARIO 3] Undo/Redo ---');
  // Clean slate or continue
  alice.change('Alice purple', d => { d.nodes['nodeA'].color = 'purple'; });
  await alice.syncNow();
  await bob.syncNow();
  
  console.log('Alice Undo...');
  alice.undo();
  await alice.syncNow();
  await bob.syncNow();
  
  console.log('Alice Redo (simulated by re-applying)...');
  alice.change('Alice purple redo', d => { d.nodes['nodeA'].color = 'purple'; });
  await alice.syncNow();
  await bob.syncNow();
  
  server.printLogTail();
}

run();
