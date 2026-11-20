// Pluggable state for the connectors: four async methods, so a real app can swap the JSON file
// for Redis, SQLite or Postgres without touching connector code.
//
//   get(key)          -> value | undefined
//   set(key, value)   -> value is JSON-serializable; persisted before the promise resolves
//   delete(key)
//   entries(prefix?)  -> [[key, value], ...] for keys starting with prefix
//
// The file store writes the whole map to a temp file and renames it over the old one, so a crash
// mid-write leaves the previous state intact. It is for one process; run one connector per file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export function createMemoryStateStore(initial = {}) {
  const map = new Map(Object.entries(clone(initial)));
  return {
    async get(key) {
      return clone(map.get(key));
    },
    async set(key, value) {
      map.set(key, clone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async entries(prefix = '') {
      return [...map].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, clone(v)]);
    },
  };
}

export function createFileStateStore(path) {
  const map = new Map(existsSync(path) ? Object.entries(JSON.parse(readFileSync(path, 'utf8') || '{}')) : []);
  let writing = Promise.resolve();
  const flush = () => {
    writing = writing.then(() => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(map), null, 1));
      renameSync(tmp, path);
    });
    return writing;
  };
  return {
    path,
    async get(key) {
      return clone(map.get(key));
    },
    async set(key, value) {
      map.set(key, clone(value));
      await flush();
    },
    async delete(key) {
      if (map.delete(key)) await flush();
    },
    async entries(prefix = '') {
      return [...map].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, clone(v)]);
    },
  };
}

/**
 * connector-kit's seen-event store (claim/release) on top of a StateStore, so a webhook
 * redelivered after a restart is still recognised as a duplicate (200 {"accepted":true,"duplicate":true}).
 */
export function seenEventsFrom(store, { now = () => Date.now() } = {}) {
  return {
    async claim(key, ttlSeconds) {
      const expiresAt = await store.get(`seen:${key}`);
      if (expiresAt !== undefined && expiresAt > now()) return false;
      await store.set(`seen:${key}`, now() + ttlSeconds * 1000);
      return true;
    },
    async release(key) {
      await store.delete(`seen:${key}`);
    },
  };
}
