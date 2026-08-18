// Smoke test: load the client bundle factory with a stubbed module loader.
const path = require('path');
const ws = '/home/dgadelha/HD_Externo/desenv/dsh-explorer-plugni';
global.window = { __ModuleLoader__: { load: (handoff) => { global.__loaded = handoff; } } };
global.document = undefined;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.navigator = { languages: ['en'] };
const reactPath = path.join(ws, '.pnpm-home/node_modules/react');
const React = require(reactPath);
global.require = (name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
};
require(path.join(ws, 'lib/client.js'));
const loaded = global.__loaded;
if (!loaded) throw new Error('loader.load never called');
if (loaded.id !== 'dsh-explorer-plugni') throw new Error('bad id: ' + loaded.id);
const out = loaded.factory(global.require);
if (typeof out.apply !== 'function') throw new Error('apply missing');
if (!Array.isArray(out.inject)) throw new Error('inject missing');
console.log('OK id=', loaded.id, 'inject=', JSON.stringify(out.inject));
