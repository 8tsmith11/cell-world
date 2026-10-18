// LAN relay: forwards messages between one host browser and its clients.
// It knows nothing about the game; the host's browser is authoritative.
//
// Every connection first sends a text hello:
//   {t:'hello', role:'host'}            -> {t:'welcome', id:0}
//   {t:'hello', role:'client', name}    -> {t:'welcome', id}, host gets {t:'peer-join', id, name}
// Then:
//   host text   {t:'send', to: id|null, msg} -> msg forwarded (as text) to one client or all
//   host binary [int32 LE target, -1 = all][payload] -> payload forwarded to target(s)
//   client text {t:'send', msg}          -> host gets {t:'from', id, msg}
// The relay also tells the host {t:'peer-leave', id}, and clients {t:'host-left'}.

import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { NETWORK } from '../src/config';

const wss = new WebSocketServer({ port: NETWORK.relayPort });
wss.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${NETWORK.relayPort} is already in use. Is another relay already running?`);
    process.exit(1);
  }
  throw err;
});
let host: WebSocket | null = null;
const clients = new Map<number, WebSocket>();
let nextId = 1;

const json = (ws: WebSocket, msg: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

// Heartbeat: a connection that dies without a clean close (sleeping laptop,
// dropped Wi-Fi, killed browser) is detected and dropped, which frees the host
// slot. Browsers answer pings automatically.
const alive = new WeakMap<WebSocket, boolean>();
setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, NETWORK.relayHeartbeatSec * 1000);

wss.on('connection', (ws) => {
  let role: 'host' | 'client' | null = null;
  let id = -1;
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));

  ws.on('message', (data, isBinary) => {
    if (role === null) {
      if (isBinary) return ws.close();
      const hello = JSON.parse(data.toString());
      if (hello.t !== 'hello') return ws.close();
      if (hello.role === 'host') {
        if (host) {
          json(ws, { t: 'error', reason: 'Someone is already hosting a game on this relay.' });
          return ws.close();
        }
        role = 'host';
        id = 0;
        host = ws;
        json(ws, { t: 'welcome', id });
        console.log('Host connected.');
      } else {
        if (!host) {
          json(ws, { t: 'error', reason: 'No game is being hosted at this address.' });
          return ws.close();
        }
        role = 'client';
        id = nextId++;
        clients.set(id, ws);
        json(ws, { t: 'welcome', id });
        json(host, { t: 'peer-join', id, name: String(hello.name ?? '').slice(0, 24) });
        console.log(`Player ${id} joined.`);
      }
      return;
    }

    if (role === 'host') {
      if (isBinary) {
        const buf = data as Buffer;
        const target = buf.readInt32LE(0);
        const payload = buf.subarray(4);
        if (target < 0) {
          for (const c of clients.values()) if (c.readyState === WebSocket.OPEN) c.send(payload);
        } else {
          const c = clients.get(target);
          if (c?.readyState === WebSocket.OPEN) c.send(payload);
        }
      } else {
        const msg = JSON.parse(data.toString());
        if (msg.t !== 'send') return;
        const text = JSON.stringify(msg.msg);
        if (msg.to === null || msg.to === undefined) {
          for (const c of clients.values()) if (c.readyState === WebSocket.OPEN) c.send(text);
        } else {
          const c = clients.get(msg.to);
          if (c?.readyState === WebSocket.OPEN) c.send(text);
        }
      }
    } else if (!isBinary && host) {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'send') json(host, { t: 'from', id, msg: msg.msg });
    }
  });

  ws.on('close', () => {
    if (role === 'host' && host === ws) {
      host = null;
      for (const c of clients.values()) json(c, { t: 'host-left' });
      console.log('Host left.');
    } else if (role === 'client') {
      clients.delete(id);
      if (host) json(host, { t: 'peer-leave', id });
      console.log(`Player ${id} left.`);
    }
  });
});

// Announce only once the port is actually bound.
wss.on('listening', () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);

  console.log(`Cell World relay listening on port ${NETWORK.relayPort}.`);
  if (addresses.length === 0) {
    console.log('No LAN address found; players on this machine can join at: localhost');
  } else {
    console.log('Players join with this address:');
    for (const a of addresses) console.log(`  ${a}`);
  }
});
