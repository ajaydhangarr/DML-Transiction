const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const parserPath = path.join(
  projectRoot,
  'force-app',
  'main',
  'default',
  'lwc',
  'dmlTransactionVisualizer',
  'dmlLogParser.js'
);
const workerPath = path.join(__dirname, 'dmlLogParserFrame', 'dmlLogWorker.js');
const staticWorkerPath = path.join(
  projectRoot,
  'force-app',
  'main',
  'default',
  'staticresources',
  'dmlLogWorker.js'
);

const parserSource = fs.readFileSync(parserPath, 'utf8')
  .replace(/^export\s+/gm, '')
  .replace(/^\s*\/\/ eslint-disable-next-line @lwc\/lwc\/no-async-operation\r?\n/gm, '')
  .replace(/^\s*\/\/ eslint-disable-next-line no-await-in-loop\r?\n/gm, '');
const existingWorker = fs.readFileSync(workerPath, 'utf8');
const runtimeStart = existingWorker.indexOf('const workerCancelledRequests = new Set();');
const scopeStart = existingWorker.indexOf('async function workerParseScope');
const debugHelpersStart = existingWorker.indexOf('function workerIsWithinDmlScope');

if (runtimeStart < 0 || scopeStart < 0) {
  throw new Error('Worker runtime markers were not found; refusing to overwrite the worker.');
}

const runtimeEnd = debugHelpersStart >= 0 ? debugHelpersStart : scopeStart;
const existingDebugAdapter = `async function workerParseDebugEvents(rawLog, dmlScope, requestId) {
  return parseDebugEvents(rawLog, dmlScope, { signal: workerSignal(requestId) });
}`;
let workerRuntimePrefix = existingWorker.slice(runtimeStart, runtimeEnd).replace(/\r\n|\r/g, '\n');
while (workerRuntimePrefix.includes(existingDebugAdapter)) {
  workerRuntimePrefix = workerRuntimePrefix.replace(existingDebugAdapter, '');
}
workerRuntimePrefix = workerRuntimePrefix.trim();
const workerRuntimeSuffix = existingWorker.slice(scopeStart).replace(/\r\n|\r/g, '\n').trim();
const workerDebugAdapter = `async function workerParseDebugEvents(rawLog, dmlScope, requestId) {
  return parseDebugEvents(rawLog, dmlScope, { signal: workerSignal(requestId) });
}`;

const output = [
  '/* global self */',
  'const WORKER_MAX_SCOPE_BYTES = 10000000;',
  parserSource.trim(),
  workerRuntimePrefix,
  workerDebugAdapter,
  workerRuntimeSuffix
].join('\n\n') + '\n';
const normalizedOutput = output.replace(/\r\n|\r/g, '\n').replace(/\n/g, '\r\n');

fs.writeFileSync(workerPath, normalizedOutput, 'utf8');
fs.writeFileSync(staticWorkerPath, normalizedOutput, 'utf8');
