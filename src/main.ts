import { Music } from './audio';
import { Game } from './game';
import type { GameSource } from './game-source';
import { ClientSession } from './net/client';
import { HostSession } from './net/host';
import { type Player, RelayConnection } from './net/relay';
import { Editor } from './ui/editor';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const startScreen = $('screen-start');
const lobbyScreen = $('screen-lobby');
const usernameInput = $<HTMLInputElement>('username');
const addressInput = $<HTMLInputElement>('address');
const hostBtn = $<HTMLButtonElement>('host-btn');
const joinBtn = $<HTMLButtonElement>('join-btn');
const startError = $('start-error');
const playersList = $('players');
const hostControls = $('host-controls');
const waiting = $('waiting');
const debugToggle = $<HTMLInputElement>('debug-toggle');
const startBtn = $<HTMLButtonElement>('start-btn');

const music = new Music();
music.play('lobby');

// Per-viewer conveniences; storage can be unavailable, so failures are ignored.
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

usernameInput.value = store.get('cellworld.username');
addressInput.value = store.get('cellworld.address') || (location.hostname === 'localhost' ? '' : location.hostname);
try {
  const reason = sessionStorage.getItem('cellworld.ended');
  if (reason) startError.textContent = reason;
  sessionStorage.removeItem('cellworld.ended');
} catch {
  /* ignore */
}

function username(): string | null {
  const name = usernameInput.value.trim();
  if (!name) {
    startError.textContent = 'Enter a username first.';
    usernameInput.focus();
    return null;
  }
  store.set('cellworld.username', name);
  return name;
}

/** Any disconnect returns everyone to the start screen with the reason shown. */
function end(reason: string): void {
  try {
    sessionStorage.setItem('cellworld.ended', reason);
  } catch {
    /* ignore */
  }
  location.reload();
}

function showLobby(isHost: boolean): void {
  startScreen.classList.add('hidden');
  lobbyScreen.classList.remove('hidden');
  hostControls.classList.toggle('hidden', !isHost);
  waiting.classList.toggle('hidden', isHost);
}

function renderPlayers(players: Player[], selfId: number): void {
  playersList.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    const color = `#${p.color.toString(16).padStart(6, '0')}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = color;
    dot.style.boxShadow = `0 0 8px ${color}`;
    const name = document.createElement('span');
    name.textContent = p.name;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = [p.id === 0 ? 'host' : '', p.id === selfId ? 'you' : ''].filter(Boolean).join(', ');
    li.append(dot, name, tag);
    playersList.appendChild(li);
  }
}

async function enterGame(source: GameSource): Promise<void> {
  startScreen.classList.add('hidden');
  lobbyScreen.classList.add('hidden');
  $('game').classList.remove('hidden');
  music.play('game');
  const game = await Game.create(source);
  // Each player has their own editor; saved designs are shared so the host can spawn them,
  // and listed in the release picker.
  const editor = new Editor();
  game.onSaveAsDesign = (design, name) => editor.saveAsNew(design, name);
  editor.onDesignsChanged = (designs) => {
    source.shareDesigns(designs);
    game.setDesigns(designs);
  };
  source.shareDesigns(editor.designs);
  game.setDesigns(editor.designs);
}

async function connect(hello: Parameters<typeof RelayConnection.connect>[1], address: string): Promise<RelayConnection | null> {
  startError.textContent = '';
  hostBtn.disabled = joinBtn.disabled = true;
  try {
    return await RelayConnection.connect(address, hello);
  } catch (e) {
    startError.textContent = (e as Error).message;
    return null;
  } finally {
    hostBtn.disabled = joinBtn.disabled = false;
  }
}

hostBtn.addEventListener('click', async () => {
  const name = username();
  if (!name) return;
  // The relay runs on the host's machine, where this page is served from.
  const conn = await connect({ role: 'host' }, location.hostname);
  if (!conn) return;
  const session = new HostSession(conn, name);
  session.onLobby = () => renderPlayers(session.players, 0);
  session.onEnd = end;
  showLobby(true);
  renderPlayers(session.players, 0);
  debugToggle.addEventListener('change', () => (session.debug = debugToggle.checked));
  startBtn.addEventListener('click', () => {
    session.debug = debugToggle.checked;
    session.start();
    void enterGame(session);
  });
});

async function join(): Promise<void> {
  const name = username();
  if (!name) return;
  const address = addressInput.value.trim();
  store.set('cellworld.address', address);
  const conn = await connect({ role: 'client', name }, address);
  if (!conn) return;
  const session = new ClientSession(conn);
  session.onLobby = () => renderPlayers(session.players, conn.id);
  session.onStart = () => void enterGame(session);
  session.onEnd = end;
  showLobby(false);
}
joinBtn.addEventListener('click', () => void join());
addressInput.addEventListener('keydown', (e) => e.key === 'Enter' && void join());
