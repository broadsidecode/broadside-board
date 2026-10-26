// Loaded before every test file (node --import ./tests/setup.mjs --test). It gives the worker the fuller set of
// names the ported tests were written against: extra connectors, workers, lanes and a GitHub organization.
// The shipped config.js is deliberately smaller (one owner, one agent, no GitHub organization).
globalThis.__BOARD_CONFIG__ = {
  owner: { name: 'Owner' },
  agent: { label: 'Agent' },
  agents: [{ id: 'agent3', label: 'Agent3' }, { id: 'agent2', label: 'Agent2' }, { id: 'worker', label: 'Worker' }],
  workers: ['lane1', 'cloud-worker', 'runner', 'github-actions'],
  scopedWorkers: ['cloud-worker', 'github-actions'],
  admins: ['worker'],
  mentionNames: ['worker', 'lane1', 'lane2', 'lane3', 'agent'],
  lanes: ['lane1', 'lane2', 'lane3', 'worker'],
  roles: ['reviewer', 'builder', 'lane1', 'lane2', 'lane3', 'deployer', 'designer'],
  githubOrgs: ['example-org'],
  modules: { start: true, github: true, production: true, generate: true, tabs: true },
};

// Lets worker/src/index.js import HANDBOOK.md as text under Node (hooks live in md-loader.mjs).
import { register } from 'node:module';
register(`data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(new URL('./md-loader.mjs', import.meta.url).href)};`)}`);
