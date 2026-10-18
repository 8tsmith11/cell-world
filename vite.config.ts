import { defineConfig } from 'vite';

export default defineConfig({
  // Listen on the LAN so other players can load the game from the host's machine.
  server: { host: true },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
