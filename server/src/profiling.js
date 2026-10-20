import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { nodeRecorder, epochNow, wireInfo } from '../../scripts/profile-common.mjs';

export function createServerProfiling(root) {
  let active;
  const hooked = new WeakSet();
  const record = event => active?.record(event);
  return {
    record,
    async start(room) {
      if (!root) throw Object.assign(new Error('Set LOAD_TEST_PROFILING_DIR on the test server'), { statusCode: 503 });
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(room)) throw Object.assign(new Error('Invalid profile room'), { statusCode: 400 });
      if (active) throw Object.assign(new Error('A profiling session is active'), { statusCode: 409 });
      active = await nodeRecorder(path.join(root, room), 'server');
      record({ type: 'profile-start', room, pid: process.pid });
      return { directory: path.join(root, room), pid: process.pid };
    },
    async stop() { const session = active; if (!session) return; await session.stop(); active = null; },
    socket(socket, request) {
      if (!root) return;
      const connection = randomUUID();
      const user = new URL(request.raw.url, 'http://test.local').searchParams.get('profileUser');
      const emit = socket.emit;
      socket.emit = function (event, ...args) {
        if (event !== 'message' || !active) return emit.call(this, event, ...args);
        const info = wireInfo(args[0]), start = epochNow();
        record({ type: 'ws-receive', connection, user, ...info, atEpochMs: start });
        try { return emit.call(this, event, ...args); }
        finally { record({ type: 'socket-dispatch', connection, user, durationMs: epochNow() - start, ...info }); }
      };
      const send = socket.send;
      socket.send = function (data, ...args) {
        if (!active) return send.call(this, data, ...args);
        const start = epochNow(), info = wireInfo(data);
        record({ type: 'ws-send', connection, user, bufferedAmount: this.bufferedAmount, ...info, atEpochMs: start });
        try { return send.call(this, data, ...args); }
        finally { record({ type: 'socket-send-enqueue', connection, user, durationMs: epochNow() - start, ...info }); }
      };
    },
    document(document) {
      if (!root || hooked.has(document)) return;
      hooked.add(document);
      const emit = document.emit;
      const transactions = new WeakMap();
      document.emit = function (event, args) {
        if (!active) return emit.call(this, event, args);
        if (event === 'beforeTransaction') transactions.set(args[0], epochNow());
        if (event === 'afterTransaction' && transactions.has(args[0])) {
          record({ type: 'yjs-transaction', document: this.name, durationMs: epochNow() - transactions.get(args[0]) });
          transactions.delete(args[0]);
        }
        if (event !== 'update') return emit.call(this, event, args);
        const start = epochNow(), updateHash = createHash('sha256').update(args[0]).digest('hex');
        try { return emit.call(this, event, args); }
        finally { record({ type: 'yjs-update-broadcast', document: this.name, updateHash, bytes: args[0].length, durationMs: epochNow() - start, atEpochMs: start }); }
      };
    },
  };
}
