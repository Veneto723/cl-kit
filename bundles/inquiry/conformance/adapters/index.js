'use strict';

const claude = require('./claude');
const codex = require('./codex');

function createAdapterRegistry(entries) {
  const registry = new Map();
  for (const [name, adapter] of entries) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('inquiry conformance: adapter name must be non-empty');
    }
    if (!adapter || typeof adapter.toTrace !== 'function') {
      throw new Error(`inquiry conformance: adapter ${name} must expose toTrace`);
    }
    if (registry.has(name)) throw new Error(`inquiry conformance: duplicate adapter ${name}`);
    registry.set(name, adapter);
  }
  return {
    get(name) {
      const adapter = registry.get(name);
      if (!adapter) throw new Error(`inquiry conformance: unknown adapter ${name}`);
      return adapter;
    },
    names() {
      return Array.from(registry.keys());
    },
  };
}

const adapters = createAdapterRegistry([
  ['claude', claude],
  ['codex', codex],
]);

module.exports = {
  adapters,
  createAdapterRegistry,
};
