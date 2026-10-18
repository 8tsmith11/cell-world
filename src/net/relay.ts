// Browser side of the relay connection (see server/relay.ts for the protocol).
import { NETWORK } from '../config';
import type { BoardEntry, SpeciesInfo } from '../game-source';
import type { Design } from '../sim/genome';
import type { CellInfo } from '../sim/protocol';

export interface Player {
  id: number;
  name: string;
  color: number;
}

/** JSON messages from host to clients. */
export type HostMsg =
  | { t: 'lobby'; players: Player[] }
  | { t: 'start'; seed: number; config: Record<string, object>; debug: boolean; players: Player[] }
  | { t: 'inspect'; cell: CellInfo | null }
  | { t: 'stats'; water: number; cells: number; paused: boolean }
  /** Sent to one player only: their own DNA and species. */
  | { t: 'me'; dna: number; species: SpeciesInfo[] }
  | { t: 'board'; entries: BoardEntry[] }
  | { t: 'event'; text: string; color: number }
  | { t: 'notice'; text: string };

/** JSON messages from a client to the host. */
export type ClientMsg =
  | { t: 'view'; x: number; y: number; w: number; h: number }
  | { t: 'inspect'; id: number }
  | { t: 'designs'; designs: Design[] }
  | { t: 'release'; design: Design; x: number; y: number };

/** Control messages from the relay itself. */
type RelayMsg =
  | { t: 'welcome'; id: number }
  | { t: 'error'; reason: string }
  | { t: 'peer-join'; id: number; name: string }
  | { t: 'peer-leave'; id: number }
  | { t: 'from'; id: number; msg: ClientMsg }
  | { t: 'host-left' };

/** Accepts "192.168.1.5", "192.168.1.5:8787", or a full ws:// URL. */
export function relayUrl(address: string): string {
  const a = address.trim() || location.hostname;
  if (/^wss?:\/\//.test(a)) return a;
  return /:\d+$/.test(a) ? `ws://${a}` : `ws://${a}:${NETWORK.relayPort}`;
}

export class RelayConnection {
  onJson: (msg: RelayMsg | HostMsg) => void = () => {};
  onBinary: (buf: ArrayBuffer) => void = () => {};
  onClose: (reason: string) => void = () => {};

  private constructor(
    private ws: WebSocket,
    readonly id: number,
  ) {
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') this.onJson(JSON.parse(e.data));
      else this.onBinary(e.data as ArrayBuffer);
    };
    ws.onclose = () => this.onClose('Connection to the relay closed.');
  }

  static connect(address: string, hello: { role: 'host' } | { role: 'client'; name: string }): Promise<RelayConnection> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl(address));
      } catch {
        reject(new Error('That address is not valid.'));
        return;
      }
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', ...hello }));
      ws.onerror = () => reject(new Error(`Could not reach a relay at ${relayUrl(address)}. Is "npm run relay" running?`));
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as RelayMsg;
        if (msg.t === 'welcome') resolve(new RelayConnection(ws, msg.id));
        else if (msg.t === 'error') reject(new Error(msg.reason));
      };
    });
  }

  // Host -> clients
  sendTo(to: number | null, msg: HostMsg): void {
    this.ws.send(JSON.stringify({ t: 'send', to, msg }));
  }

  sendBinaryTo(to: number | null, payload: ArrayBuffer): void {
    const out = new Uint8Array(4 + payload.byteLength);
    new DataView(out.buffer).setInt32(0, to ?? -1, true);
    out.set(new Uint8Array(payload), 4);
    this.ws.send(out);
  }

  // Client -> host
  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify({ t: 'send', msg }));
  }

  close(): void {
    this.ws.onclose = null;
    this.ws.close();
  }
}

export type { RelayMsg };
