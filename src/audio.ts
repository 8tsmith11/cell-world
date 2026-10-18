import { AUDIO } from './config';

export const TRACKS = {
  lobby: '/audio/lobby-heavenly-loop.ogg',
  game: '/audio/game-underwater-ambient-pad.ogg',
} as const;

type Track = keyof typeof TRACKS;

/**
 * Looping background music with crossfades. Browsers block audio until the
 * user interacts with the page, so playback is retried on the first input.
 */
export class Music {
  private players = new Map<Track, HTMLAudioElement>();
  private current: Track | null = null;
  private fadeFrame = 0;

  constructor() {
    for (const [name, src] of Object.entries(TRACKS) as [Track, string][]) {
      const a = new Audio(src);
      a.loop = true;
      a.volume = 0;
      a.preload = 'auto';
      this.players.set(name, a);
    }
    const unlock = () => {
      if (this.current) this.players.get(this.current)!.play().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  /** Switches to a track, crossfading from whatever is playing. */
  play(track: Track, fadeSec = AUDIO.crossfadeSec): void {
    if (this.current === track) return;
    const from = this.current ? this.players.get(this.current)! : null;
    const to = this.players.get(track)!;
    this.current = track;
    to.play().catch(() => {});
    cancelAnimationFrame(this.fadeFrame);
    const start = performance.now();
    const fromStart = from?.volume ?? 0;
    const toStart = to.volume;
    const step = () => {
      const t = fadeSec > 0 ? Math.min(1, (performance.now() - start) / (fadeSec * 1000)) : 1;
      to.volume = toStart + (AUDIO.volume - toStart) * t;
      if (from) from.volume = fromStart * (1 - t);
      if (t < 1) this.fadeFrame = requestAnimationFrame(step);
      else from?.pause();
    };
    step();
  }
}
