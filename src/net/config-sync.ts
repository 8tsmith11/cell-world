import * as config from '../config';

/** The host's whole config, as plain data to send to clients. */
export function exportConfig(): Record<string, object> {
  return JSON.parse(JSON.stringify(config));
}

/** Overwrites local config sections with the host's values (before any world or renderer is built). */
export function applyConfig(remote: Record<string, object>): void {
  const local = config as unknown as Record<string, object>;
  for (const [section, values] of Object.entries(remote)) {
    if (section in local) Object.assign(local[section], values);
  }
}
