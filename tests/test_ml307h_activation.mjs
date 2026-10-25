import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareActivation, productCode} from '../renderer/upstream/ml307h/activation.mjs';

const enc = new TextEncoder(), dec = new TextDecoder();
function fixture({has3rd = false, failAPI = '', failCMD = 0, staleAPI = '', existing = false, diskFail = false} = {}) {
  const ops = [], snapshots = []; let valid = true;
  const replies = {
    'project-keys': {AES: 'AES-ABC', rsa_n: 'N-123', rsa_e: '010001'},
    'private-key': {rsa_d: 'D-789'},
    'activation-key': {cdkey: 'LICENSE-ABC', surplus: 99, has3rd},
    'third-party-key': {cdkey: 'LICENSE-EXTRA'}, 'activation-report': {reported: true},
  };
  const api = async (action, payload) => {
    ops.push(['api', action, {...payload}]);
    if (action === failAPI) throw Object.assign(Error('DO-NOT-LEAK'), {code: 'network_error'});
    if (action === staleAPI) valid = false;
    return replies[action];
  };
  const dl = {broken: false, transaction: async (cmd, bytes, options) => {
    ops.push(['device', cmd, bytes.slice(), options]);
    if (cmd === failCMD) {dl.broken = true; throw Error('timeout SECRET');}
    return {cmd: cmd === 0x47 ? 0x48 : 0x80, payload: cmd === 0x47 ? enc.encode('DEVICE-CODE\0') : new Uint8Array()};
  }};
  const store = {state: existing ? {activation: {status: 'unconfirmed'}} : {}, saveState: async () => {
    if (diskFail) throw Error('disk full'); snapshots.push(JSON.parse(JSON.stringify(store.state)));
  }};
  return {ops, snapshots, dl, store, options: {api, token: 'OFFICIAL-TOKEN', project: {project_id: 7, name: 'Project'}, isCurrent: () => valid}};
}

test('official activation sequence sends raw strings and reports after every device ACK', async () => {
  const f = fixture({has3rd: true}), run = await prepareActivation(f.options);
  assert.deepEqual(f.ops.map(op => op[1]), ['project-keys', 'private-key']);
  assert.equal(f.snapshots.length, 0);
  const result = await run.run(f.dl, f.store);
  assert.equal(result.surplus, 99);
  assert.deepEqual(f.ops.map(op => op[1]), ['project-keys', 'private-key', 0x42, 0x49, 0x43, 0x44, 0x45, 0x46, 0x47, 'activation-key', 0x4a, 'third-party-key', 0x4b, 'activation-report']);
  const devices = f.ops.filter(op => op[0] === 'device');
  assert.equal(devices[1][2].length, 32);
  assert.equal(dec.decode(devices[2][2]), 'AES-ABC');
  assert.equal(dec.decode(devices[4][2]), '010001', 'RSA string is not hex decoded');
  assert.equal(dec.decode(devices[7][2]), 'LICENSE-ABC');
  for (const op of devices) assert.equal(op[3].timeout, 3000);
  assert.deepEqual(devices.find(op => op[1] === 0x47)[3].ok, [0x48]);
  for (const op of f.ops.filter(op => op[0] === 'api' && ['activation-key', 'third-party-key', 'activation-report'].includes(op[1])))
    assert.deepEqual(op[2], {token: 'OFFICIAL-TOKEN', project_id: 7, cpucode: 'DEVICE-CODE'});
  assert.equal(f.store.state.activation.status, 'complete');
  const disk = JSON.stringify(f.snapshots);
  for (const secret of ['OFFICIAL-TOKEN', 'AES-ABC', 'N-123', 'D-789', 'LICENSE', 'DEVICE-CODE']) assert(!disk.includes(secret));
  const count = f.ops.length; await assert.rejects(run.run(f.dl, f.store), /重复/); assert.equal(f.ops.length, count);
});

test('without third-party license no extra claim or write occurs', async () => {
  const f = fixture(), run = await prepareActivation(f.options); await run.run(f.dl, f.store);
  assert(!f.ops.some(op => ['third-party-key', 0x4b].includes(op[1])));
});

test('key preparation rejects stale selection and failure before touching device', async () => {
  for (const changes of [{failAPI: 'project-keys'}, {failAPI: 'private-key'}, {staleAPI: 'project-keys'}, {staleAPI: 'private-key'}]) {
    const f = fixture(changes); await assert.rejects(prepareActivation(f.options)); assert(!f.ops.some(op => op[0] === 'device'));
  }
  const f = fixture(); await assert.rejects(prepareActivation({...f.options, token: ''})); assert.equal(f.ops.length, 0);
});

test('timeouts and lost license ACKs are not retried or leaked in errors', async () => {
  for (const changes of [{failAPI: 'activation-key'}, {failCMD: 0x4a}, {has3rd: true, failAPI: 'third-party-key'}, {has3rd: true, failCMD: 0x4b}]) {
    const f = fixture(changes), run = await prepareActivation(f.options);
    await assert.rejects(run.run(f.dl, f.store), error => /固件下载完成/.test(error.message) && !/SECRET|DO-NOT-LEAK/.test(error.message));
    assert.equal(f.store.state.activation.status, 'unconfirmed');
    assert.equal(f.ops.filter(op => op[1] === 'activation-key').length, 1);
    assert(!f.ops.some(op => op[1] === 'activation-report'));
    const count = f.ops.length; await assert.rejects(run.run(f.dl, f.store)); assert.equal(f.ops.length, count);
  }
});

test('report failure distinguishes device license written from server confirmation', async () => {
  const f = fixture({failAPI: 'activation-report'}), run = await prepareActivation(f.options);
  await assert.rejects(run.run(f.dl, f.store), /设备授权已写入.*上报未确认/);
  assert.equal(f.store.state.activation.status, 'device-complete-report-unconfirmed');
  assert.equal(f.store.state.activation.device_written, true);
  assert.equal(f.ops.filter(op => op[1] === 'activation-report').length, 1);
});

test('existing journal and disk failure stop before device commands', async () => {
  for (const changes of [{existing: true}, {diskFail: true}]) {
    const f = fixture(changes), run = await prepareActivation(f.options);
    await assert.rejects(run.run(f.dl, f.store)); assert(!f.ops.some(op => op[0] === 'device'));
  }
});

test('selection changing during device claim never writes returned license', async () => {
  const f = fixture({staleAPI: 'activation-key'}), run = await prepareActivation(f.options);
  await assert.rejects(run.run(f.dl, f.store)); assert(!f.ops.some(op => op[1] === 0x4a));
});

test('product identifier uses bounded ASCII with optional trailing NUL', () => {
  assert.equal(productCode(enc.encode('ABC+/=')), 'ABC+/=');
  assert.equal(productCode(enc.encode('ABC\0\0')), 'ABC');
  for (const value of [new Uint8Array(), enc.encode('A\0B'), Uint8Array.of(255), enc.encode('\n'), enc.encode('X'.repeat(4097))]) assert.throws(() => productCode(value));
});
