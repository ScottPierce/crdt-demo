import * as Y from 'yjs';

// --- Shared Types ---
type Node = { title: string; color: string; desc: string };

// --- Configuration ---
const DELAY_MS = 10;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- Logging ---
function log(component: string, step: string, msg: string) {
  console.log(`[yjs-demo][${component}][${step}] ${msg}`);
}

function logState(name: string, doc: Y.Doc, extra: any = {}) {
  const nodes = doc.getMap('nodes');
  // const order = doc.getArray('order'); // Not strictly used in scenarios but part of model
  const nodeA = nodes.get('nodeA') as Y.Map<any> | undefined;
  const nodeB = nodes.get('nodeB') as Y.Map<any> | undefined;
  
  const summary = {
    nodeA_title: nodeA?.get('title') || 'N/A',
    nodeB_color: nodeB?.get('color') || 'N/A',
    nodeA_desc_len: (nodeA?.get('desc') as Y.Text)?.toString().length || 0,
    ...extra
  };
  
  console.log(`[yjs-demo][${name}][STATE] ${JSON.stringify(summary)}`);
}

// --- Server ---
class Server {
  log: { seq: number; from: string; update: Uint8Array }[] = [];
  listeners: ((update: Uint8Array, from: string, seq: number) => void)[] = [];

  async submit(from: string, update: Uint8Array) {
    await delay(DELAY_MS);
    const seq = this.log.length;
    this.log.push({ seq, from, update });
    this.notify(update, from, seq);
    return seq;
  }

  async fetchSince(cursor: number) {
    await delay(DELAY_MS);
    return this.log.slice(cursor);
  }

  subscribe(cb: (update: Uint8Array, from: string, seq: number) => void) {
    this.listeners.push(cb);
  }

  notify(update: Uint8Array, from: string, seq: number) {
    this.listeners.forEach(cb => cb(update, from, seq));
  }

  printLogTail() {
    const tail = this.log.slice(-5);
    console.log(`[yjs-demo][server][LOG] Tail (last ${tail.length}):`);
    tail.forEach(entry => {
      console.log(`  Seq ${entry.seq} from ${entry.from} (${entry.update.byteLength} bytes)`);
    });
  }
}

// --- Client ---
class Client {
  doc: Y.Doc;
  name: string;
  server: Server;
  isOnline: boolean = true;
  queue: Uint8Array[] = [];
  serverCursor: number = 0;
  undoManager: Y.UndoManager | null = null;

  constructor(name: string, server: Server) {
    this.name = name;
    this.server = server;
    this.doc = new Y.Doc();
    // For deterministic conflict resolution in Yjs, clientID matters.
    // We can set it manually if needed, but random is fine as long as we observe result.
    
    this.doc.on('update', (update: Uint8Array, origin: any) => {
      if (origin !== 'remote') {
        this.queueUpdate(update);
      }
    });

    this.server.subscribe(async (update, from, seq) => {
      if (!this.isOnline) return;
      if (seq >= this.serverCursor) {
          if (from !== this.name) {
            Y.applyUpdate(this.doc, update, 'remote');
          }
          this.serverCursor = seq + 1;
      }
    });
  }

  setupUndo() {
      const nodes = this.doc.getMap('nodes');
      // Track all types under nodes
      this.undoManager = new Y.UndoManager(nodes, {
          trackedOrigins: new Set([null, undefined, this.doc.clientID]),
          captureTimeout: 0 // Capture immediately for demo steps
      });
  }

  queueUpdate(update: Uint8Array) {
      this.queue.push(update);
      if (this.isOnline) {
          this.flush();
      }
  }

  async flush() {
      if (this.queue.length === 0) return;
      // Dedupe identical consecutive updates if any (simple optimization)
      const merged = Y.mergeUpdates(this.queue);
      this.queue = [];
      await this.server.submit(this.name, merged);
  }

  async syncNow() {
    log(this.name, 'SYNC', 'Starting sync...');
    // 1. Pull
    const missing = await this.server.fetchSince(this.serverCursor);
    for (const entry of missing) {
        if (entry.from !== this.name) {
             Y.applyUpdate(this.doc, entry.update, 'remote');
        }
        this.serverCursor = Math.max(this.serverCursor, entry.seq + 1);
    }
    // 2. Flush
    await this.flush();
    
    log(this.name, 'SYNC', 'Sync complete.');
    this.printStatus();
  }

  printStatus() {
      logState(this.name, this.doc, {
          serverCursor: this.serverCursor,
          queueLen: this.queue.length
      });
  }

  // -- Data Ops --
  
  initDoc() {
    this.doc.transact(() => {
        const nodes = this.doc.getMap('nodes');
        const order = this.doc.getArray('order');
        
        if (!nodes.has('nodeA')) {
            const na = new Y.Map();
            na.set('title', 'Settings');
            na.set('color', 'blue');
            const da = new Y.Text('Hello');
            na.set('desc', da);
            nodes.set('nodeA', na);
        }
        
        if (!nodes.has('nodeB')) {
            const nb = new Y.Map();
            nb.set('title', 'Profile');
            nb.set('color', 'green');
            const db = new Y.Text('World');
            nb.set('desc', db);
            nodes.set('nodeB', nb);
        }
        
        if (order.length === 0) {
            order.push(['nodeA', 'nodeB']);
        }
    });
  }

  updateTitle(nodeKey: string, val: string) {
      this.doc.transact(() => {
          const nodes = this.doc.getMap('nodes');
          const n = nodes.get(nodeKey) as Y.Map<any>;
          if (n) n.set('title', val);
      });
  }

  updateColor(nodeKey: string, val: string) {
      this.doc.transact(() => {
          const nodes = this.doc.getMap('nodes');
          const n = nodes.get(nodeKey) as Y.Map<any>;
          if (n) n.set('color', val);
      });
  }
  
  undo() {
      if (this.undoManager) this.undoManager.undo();
  }
  
  redo() {
      if (this.undoManager) this.undoManager.redo();
  }
}

async function run() {
  const server = new Server();
  const alice = new Client('Alice', server);
  const bob = new Client('Bob', server);

  console.log('--- [SETUP] Initializing ---');
  alice.initDoc();
  await alice.syncNow();
  await bob.syncNow();
  
  alice.setupUndo();
  // Bob doesn't strictly need undo for this demo but good to have
  bob.setupUndo();

  server.printLogTail();

  // 1. Non-conflicting
  console.log('\n--- [SCENARIO 1] Non-conflicting concurrency ---');
  alice.isOnline = true;
  bob.isOnline = false;

  console.log('Alice updating nodeA title...');
  alice.updateTitle('nodeA', 'Settings v2');
  await alice.syncNow();

  console.log('Bob (offline) updating nodeB color...');
  bob.updateColor('nodeB', 'red');
  
  console.log('Bob coming online and syncing...');
  bob.isOnline = true;
  await bob.syncNow();
  
  console.log('Alice syncing to get Bob changes...');
  await alice.syncNow();
  
  server.printLogTail();

  // 2. Conflicting
  console.log('\n--- [SCENARIO 2] Conflicting concurrency ---');
  console.log('Alice updating nodeA title to Preferences...');
  alice.updateTitle('nodeA', 'Preferences');
  
  bob.isOnline = false;
  console.log('Bob (offline) updating nodeA title to Config...');
  bob.updateTitle('nodeA', 'Config');
  
  await alice.syncNow();
  
  console.log('Bob coming online and syncing (Conflict)...');
  bob.isOnline = true;
  await bob.syncNow();
  await alice.syncNow(); // Converge
  
  console.log('Converged result:');
  alice.printStatus();
  bob.printStatus();
  server.printLogTail();

  // 3. Undo/Redo
  console.log('\n--- [SCENARIO 3] Undo/Redo propagation ---');
  console.log('Alice changing nodeA color to purple...');
  alice.updateColor('nodeA', 'purple');
  await alice.syncNow();
  await bob.syncNow();
  
  console.log('Alice Undoing...');
  alice.undo();
  await alice.syncNow();
  await bob.syncNow();
  
  console.log('Alice Redoing...');
  alice.redo();
  await alice.syncNow();
  await bob.syncNow();
  
  server.printLogTail();
}

run();
