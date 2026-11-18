const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Substitute the transport at import time. No test can enumerate/open real HID.
const fakeHid = {
  devicesAsync: async () => { throw new Error('Unconfigured fake HID enumeration'); },
  HIDAsync: { open: async () => { throw new Error('Unconfigured fake HID handle'); } },
};
const originalLoad = Module._load;
let protocol;
try {
  Module._load = function(name, ...rest) {
    return name === 'node-hid' ? fakeHid : originalLoad.call(this, name, ...rest);
  };
  protocol = require('../src/main/protocol.cjs');
} finally { Module._load = originalLoad; }
const { Keyboard, packet, mappingPacket, lightingPacket, lightingModes, lightingColors, controls, fingerprint, validateLayers, validateReports, checksum } = protocol;
const clone = value => JSON.parse(JSON.stringify(value));
const response = (slot, layer, mods = 0, code = 0x04) => [...packet([3, 0xfa, slot, layer, 1, 0, 0, 0, 0, 0, 1, mods, code])];
const allReports = () => [1, 2, 3].flatMap(layer => Array.from({ length: 24 }, (_, i) => response(i + 1, layer)));
const bridgeReports = (layers=[3]) => layers.flatMap(layer=>controls.map((_, i) => { const r = [...mappingPacket(i + 1,layer)]; r[1] = 0xfa; return r; }));
const device = { vendorId: 0x1189, productId: 0x8840, usagePage: 0xff00, usage: 1, interface: 0, path: 'fake-device', serialNumber: 'TEST-SERIAL' };

function installTransport({ info = [...packet([3, 0xfb, 15, 3, 0])], candidates = [device], closeError } = {}) {
  const writes = [];
  let opens = 0, closes = 0;
  const handle = {
    write: async data => { writes.push([...data]); return data.length; },
    read: async () => info,
    close: async () => { closes++; if (closeError) throw closeError; },
  };
  fakeHid.devicesAsync = async () => candidates;
  fakeHid.HIDAsync.open = async value => { assert.equal(value, 'fake-device'); opens++; return handle; };
  return { handle, writes, counts: () => ({ opens, closes }) };
}

test('wire packets are 65 bytes including report ID, with strict byte values', () => {
  const result = packet([3, 0xfb, 0xfb, 0xfb]);
  assert.equal(result.length, 65);
  assert.deepEqual([...result.subarray(0, 4)], [3, 0xfb, 0xfb, 0xfb]);
  assert.ok(result.subarray(4).every(value => value === 0));
  for (const bad of [[256], [-1], [0.5], [NaN], ['3'], Array(66).fill(0)]) {
    assert.throws(() => packet(bad));
  }
});

test('24 bridge controls produce distinct reserved triggers and correct 884x fields', () => {
  assert.equal(controls.length, 24);
  assert.equal(new Set(controls).size, 24);
  assert.deepEqual(controls.slice(15), ['knob1.ccw', 'knob1.press', 'knob1.cw', 'knob2.ccw', 'knob2.press', 'knob2.cw', 'knob3.ccw', 'knob3.press', 'knob3.cw']);
  const triggers = [];
  for (let id = 1; id <= 24; id++) {
    const r = mappingPacket(id);
    assert.equal(r.length, 65);
    assert.deepEqual([...r.subarray(0, 5)], [3, 0xfe, id, 3, 1]);
    assert.equal(r[10], 1);
    assert.equal(r[11], id > 12 ? 2 : 0);
    assert.equal(r[12], 0x68 + ((id - 1) % 12));
    assert.ok(r.subarray(13).every(value => value === 0));
    triggers.push(fingerprint(r));
  }
  assert.equal(new Set(triggers).size, 24);
  assert.equal(triggers[0], 'F13');
  assert.equal(triggers[11], 'F24');
  assert.equal(triggers[12], 'SHIFT+F13');
  assert.equal(triggers[23], 'SHIFT+F24');
  for (const id of [0, 25, 1.5, NaN, '1']) assert.throws(() => mappingPacket(id));
  for (const layer of [0, 4, '3']) assert.throws(() => mappingPacket(1, layer));
});

test('read validator accepts unordered complete layers, preserves opaque bytes, rejects corruption', () => {
  const valid = allReports().reverse();
  valid[0][4] = 99; // Backup preservation is not restricted to known action kinds.
  valid[0][50] = 91;
  assert.equal(validateReports(valid), valid);
  const layer3 = valid.filter(r => r[3] === 3);
  assert.equal(validateReports(layer3, [3]), layer3);
  assert.throws(() => validateReports(valid.slice(1)));
  const mutations = [
    rs => { rs[0] = rs[0].slice(0, 64); },
    rs => { rs[0].push(0); },
    rs => { rs[0][0] = 0; },
    rs => { rs[0][1] = 0xfe; },
    rs => { rs[0][2] = 25; },
    rs => { rs[0][3] = 4; },
    rs => { rs[0][12] = 256; },
    rs => { rs[0][12] = 1.5; },
    rs => { rs[0] = [...rs[1]]; },
  ];
  for (const mutate of mutations) { const rs = clone(valid); mutate(rs); assert.throws(() => validateReports(rs)); }
});

test('fingerprints match non-sensitive summaries of the actual captured mappings', () => {
  // device-readback.json, observed 2026-11-16T05:22:46.535Z, kind 0.
  // These compact examples omit the user's complete configuration.
  assert.equal(fingerprint(response(1, 1, 0, 0x4c)), null); // Delete, not a bridge trigger.
  assert.equal(fingerprint(response(1, 2, 0, 0x04)), null); // A.
  assert.equal(fingerprint(response(1, 3, 0, 0x68)), 'F13');
  assert.equal(fingerprint(response(16, 3, 2, 0x6c)), 'SHIFT+F17');
  assert.equal(fingerprint(response(20, 3, 1, 0x04)), null); // Ctrl+A.
  const media = response(17, 1); media[4] = 2; media[11] = 0xcd; media[12] = 0;
  assert.equal(fingerprint(media), null);
  const macro = response(1, 3, 0, 0x68); macro[10] = 2;
  assert.equal(fingerprint(macro), null);
  assert.equal(fingerprint(response(1, 3, 0x20, 0x68)), 'SHIFT+F13');
  const short = [3, 0xfa, 1, 3, 1, 0, 0, 0, 0, 0, 1];
  assert.equal(fingerprint(short), null, 'Truncated records must not become FNaN triggers');
});

test('ambiguous device triggers are removed instead of running an arbitrary action', () => {
  const keyboard = new Keyboard('unused');
  const reports = bridgeReports();
  keyboard.updateMap(reports);
  assert.equal(keyboard.status.provisioned, true);
  assert.equal(keyboard.status.mappedControls, 24);
  assert.deepEqual(keyboard.inputMap.get('SHIFT+F24'), {control:'knob3.cw',layer:3});
  reports[1][11] = reports[0][11]; reports[1][12] = reports[0][12];
  keyboard.updateMap(reports);
  assert.equal(keyboard.inputMap.has('F13'), false);
  assert.equal(keyboard.status.mappedControls, 22);
  assert.equal(keyboard.status.provisioned, false);
});

test('read ignores acknowledgements and orders replies by layer and physical slot', async () => {
  const expected = bridgeReports();
  const queue = [[3, 0xaa, 0xaa], ...clone(expected).reverse()];
  const writes = [];
  const handle = { write: async data => { writes.push([...data]); return data.length; }, read: async () => queue.shift() || [] };
  const actual = await new Keyboard('unused').read(handle, [3]);
  assert.deepEqual(actual, expected);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].slice(0, 5), [3, 0xfa, 15, 3, 3]);
});

test('identity must be complete and supported before work is admitted', async () => {
  for (const info of [[3, 0xfb, 15, 3], [...packet([3, 0xfb, 15, 3, 10])], [...packet([3, 0xfb, 12, 3, 0])]]) {
    const transport = installTransport({ info });
    let called = false;
    const keyboard = new Keyboard('unused');
    await assert.rejects(keyboard.exclusive(async () => { called = true; }));
    assert.equal(called, false);
    assert.equal(keyboard.busy, false);
    assert.equal(transport.counts().closes, 1);
  }
  const transport = installTransport();
  const keyboard = new Keyboard('unused');
  assert.equal(await keyboard.exclusive(async () => 'accepted'), 'accepted');
  assert.equal(keyboard.status.serial, 'TEST-SERIAL');
  assert.deepEqual(transport.counts(), { opens: 1, closes: 1 });
});

test('multiple matching pads are rejected before opening either', async () => {
  const transport = installTransport({ candidates: [device, { ...device, path: 'second-device' }] });
  await assert.rejects(new Keyboard('unused').exclusive(async () => assert.fail('Must not run')));
  assert.equal(transport.counts().opens, 0);
});

test('handle-close errors release the busy lock so later recovery is possible', async () => {
  installTransport({ closeError: new Error('close failed') });
  const keyboard = new Keyboard('unused');
  await assert.rejects(keyboard.exclusive(async () => undefined), /close failed/);
  assert.equal(keyboard.busy, false);
  installTransport();
  await keyboard.exclusive(async () => undefined);
  assert.equal(keyboard.busy, false);
});

test('restore packets preserve all raw bytes except the command and use safe commit messages', async () => {
  const original = response(1, 3, 0, 0x68);
  original[45] = 0x5a; // Opaque captured state must survive round-trip encoding.
  const writes = [];
  await new Keyboard('unused').commit({ write: async data => { writes.push([...data]); return data.length; } }, [original]);
  assert.deepEqual(original, response(1, 3, 0, 0x68).map((v, i) => i === 45 ? 0x5a : v));
  const expected = [...original]; expected[1] = 0xfe;
  assert.deepEqual(writes[0], expected);
  assert.deepEqual(writes.slice(1).map(r => r.slice(0, 4)), [[3, 0xaa, 0xaa, 0], [3, 0xfd, 0xfe, 0xff], [3, 0xaa, 0xaa, 0]]);
  assert.ok(writes.every(r => r.length === 65 && ![0xef, 0xfc].includes(r[1])));
});

test('a short HID write aborts the transaction before more reports are sent', async () => {
  let writes = 0;
  await assert.rejects(new Keyboard('unused').commit({ write: async () => { writes++; return 64; } }, [response(1, 3), response(2, 3)]));
  assert.equal(writes, 1);
});

function transactionKeyboard(original, after, layers=[3]) {
  const keyboard = new Keyboard('unused');
  const trace = [];
  const reads = [clone(original), clone(after)];
  keyboard.exclusive = async work => work({});
  keyboard.read = async () => { trace.push('read'); return reads.shift(); };
  keyboard.saveBackup = reports => { trace.push('backup'); validateReports(reports); return 'fake-backup.json'; };
  keyboard.commit = async (_, reports) => { trace.push('commit'); assert.equal(reports.length, 24*layers.length); assert.ok(reports.every(r => layers.includes(r[3]))); };
  keyboard.status.serial = 'TEST-SERIAL';
  return { keyboard, trace };
}

test('provision backs up all 72 slots before writing only layer 3 and verifies untouched layers', async () => {
  const original = allReports();
  const after = [...original.filter(r => r[3] !== 3), ...bridgeReports()];
  const { keyboard, trace } = transactionKeyboard(original, after);
  const result = await keyboard.provision();
  assert.equal(result.ok, true);
  assert.equal(keyboard.status.provisioned, true);
  assert.deepEqual(trace, ['read', 'backup', 'commit', 'read']);
  const damaged = clone(after); damaged[0][12] = 0x05;
  await assert.rejects(transactionKeyboard(original, damaged).keyboard.provision());
});

test('72 triggers are unique across hardware layers while layer 3 remains compatible', () => {
  const reports=bridgeReports([1,2,3]);
  assert.equal(new Set(reports.map(fingerprint)).size,72);
  const keyboard=new Keyboard('unused'); keyboard.updateMap(reports);
  assert.deepEqual(keyboard.inputMap.get('CTRL+F13'),{control:'key1',layer:1});
  assert.deepEqual(keyboard.inputMap.get('CTRL+SHIFT+F24'),{control:'knob3.cw',layer:1});
  assert.deepEqual(keyboard.inputMap.get('CTRL+ALT+F13'),{control:'key1',layer:2});
  assert.deepEqual(keyboard.inputMap.get('CTRL+SHIFT+ALT+F24'),{control:'knob3.cw',layer:2});
  assert.deepEqual(keyboard.inputMap.get('F13'),{control:'key1',layer:3});
  assert.deepEqual(keyboard.status.layers,{1:{provisioned:true,mappedControls:24},2:{provisioned:true,mappedControls:24},3:{provisioned:true,mappedControls:24}});
  assert.equal(keyboard.status.totalMappedControls,72);
  assert.equal(keyboard.status.mappedControls,24);
  const collided=clone(reports); collided[0][11]=0;
  keyboard.updateMap(collided);
  assert.equal(keyboard.inputMap.has('F13'),false,'Cross-layer collision must never dispatch to an arbitrary layer');
  assert.equal(keyboard.status.layers[1].mappedControls,23);
  assert.equal(keyboard.status.layers[3].mappedControls,23);
});

test('layer selection rejects empty, duplicate and invalid sets before hardware access', async () => {
  for(const layers of [[],[1,1],[0],[4],['1'],[1,2,3,4],null,3]) {
    assert.throws(()=>validateLayers(layers));
    const keyboard=new Keyboard('unused'); keyboard.exclusive=async()=>assert.fail('Must validate before device access');
    await assert.rejects(keyboard.provision(layers));
    await assert.rejects(keyboard.restore('does-not-exist',layers));
  }
  const original=[3,1]; assert.deepEqual(validateLayers(original),[1,3]); assert.deepEqual(original,[3,1]);
});

test('selected layers provision together and exact tail-byte differences fail verification', async () => {
  const original=allReports(), after=[...bridgeReports([1,2]),...original.filter(r=>r[3]===3)];
  const {keyboard,trace}=transactionKeyboard(original,after,[1,2]);
  assert.deepEqual((await keyboard.provision([2,1])).layers,[1,2]);
  assert.deepEqual(trace,['read','backup','commit','read']);
  assert.equal(keyboard.status.layers[1].provisioned,true);
  assert.equal(keyboard.status.layers[2].provisioned,true);
  assert.equal(keyboard.status.layers[3].provisioned,false);
  const corrupted=clone(after); corrupted[0][64]=0x99;
  await assert.rejects(transactionKeyboard(original,corrupted,[1,2]).keyboard.provision([1,2]),/검증 실패/);
  const untouchedChanged=clone(after); untouchedChanged[48][12]=0x05;
  await assert.rejects(transactionKeyboard(original,untouchedChanged,[1,2]).keyboard.provision([1,2]),/검증 실패/);
});

test('refresh reads all three hardware layers and builds independent readiness', async () => {
  const keyboard=new Keyboard('unused'); let requested;
  keyboard.exclusive=async work=>work({});
  keyboard.read=async (_handle,layers=[1,2,3])=>{requested=layers;return bridgeReports([1,2,3]);};
  await keyboard.refresh(); assert.deepEqual(requested,[1,2,3]); assert.equal(keyboard.status.totalMappedControls,72);
});

test('restoring selected layers preserves the other layer and raw opaque bytes', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mono-deck-layers-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const original=allReports(); original[0][64]=0x59;
  const backup={format:'mono-deck-mapping',version:1,device:{vid:0x1189,pid:0x8840,serial:'TEST-SERIAL'},reports:original,sha256:checksum(original)};
  const file=path.join(directory,'mapping.json'); fs.writeFileSync(file,JSON.stringify(backup));
  const current=bridgeReports([1,2,3]);
  const after=[...original.filter(r=>r[3]!==2),...current.filter(r=>r[3]===2)];
  const {keyboard,trace}=transactionKeyboard(current,after,[1,3]);
  const result=await keyboard.restore(file,[3,1]); assert.deepEqual(result.layers,[1,3]);
  assert.deepEqual(trace,['read','backup','commit','read']);
  const damaged=clone(after); damaged[0][64]=0;
  await assert.rejects(transactionKeyboard(current,damaged,[1,3]).keyboard.restore(file,[1,3]),/검증 실패/);
});

test('RGB uses the vendor B0 slot, type 8, offset 12 and complete mode/color packing', () => {
  assert.deepEqual(lightingModes,['off','backlight','shock','shock2','press']);
  assert.deepEqual(lightingColors,['white','red','orange','yellow','green','cyan','blue','purple']);
  for(const layer of [1,2,3]) {
    for(const [mode,modeCode] of [['backlight',1],['shock',2],['shock2',3],['press',4]]) {
      for(let color=1;color<=7;color++) {
        const r=lightingPacket({layer,mode,color:lightingColors[color]});
        assert.deepEqual([...r.subarray(0,13)],[3,0xfe,0xb0,layer,8,0,0,0,0,0,1,0,(color<<4)|modeCode]);
        assert.equal(r.length,65); assert.ok(r.subarray(13).every(x=>x===0));
      }
    }
    assert.equal(lightingPacket({layer,mode:'backlight',color:'white'})[12],5);
    assert.equal(lightingPacket({layer,mode:'off',color:'purple'})[12],0);
  }
  assert.equal(lightingPacket({layer:3,mode:'press'})[12],0x54);
});

test('RGB rejects unsupported arbitrary RGB, per-key, speed and white reactive modes before opening HID', async () => {
  for(const options of [null,[],{}, {layer:0,mode:'off'}, {layer:'3',mode:'off'}, {layer:3,mode:'rainbow'}, {layer:3,mode:'press',color:'white'}, {layer:3,mode:'press',color:'#ff0000'}, {layer:3,mode:'off',speed:2}, {layer:3,mode:'press',key:1}]) {
    assert.throws(()=>lightingPacket(options));
    const keyboard=new Keyboard('unused'); keyboard.exclusive=async()=>assert.fail('Must validate before HID');
    await assert.rejects(keyboard.setLighting(options));
  }
});

function lightingKeyboard(after=allReports(), shortWrite=false) {
  const keyboard=new Keyboard('unused'), trace=[], writes=[], reads=[allReports(),clone(after)];
  keyboard.exclusive=async work=>work({write:async report=>{trace.push('write');writes.push([...report]);return shortWrite?64:65;}});
  keyboard.read=async()=>{trace.push('read');return reads.shift();};
  keyboard.saveBackup=reports=>{trace.push('backup');assert.equal(reports.length,72);return 'mapping-backup.json';};
  return {keyboard,trace,writes};
}

test('RGB transaction backs up/readies the session, commits once and checks all 72 mappings', async () => {
  const {keyboard,trace,writes}=lightingKeyboard();
  const result=await keyboard.setLighting({layer:2,mode:'press',color:'blue'});
  assert.deepEqual(trace,['read','backup','write','write','read']);
  assert.deepEqual(writes.map(r=>r.slice(0,4)),[[3,0xfe,0xb0,2],[3,0xfd,0xfe,0xff]]);
  assert.equal(writes[0][12],0x64); assert.ok(writes.every(r=>r.length===65));
  assert.equal(result.mappingsVerified,true);
  assert.equal(result.lighting.readbackVerified,false);
  assert.equal(result.lighting.persistenceVerified,false);
  assert.equal(keyboard.status.lighting[2].mode,'press');
});

test('RGB partial writes and unexpected mapping changes never report success', async () => {
  const short=lightingKeyboard(allReports(),true);
  await assert.rejects(short.keyboard.setLighting({layer:3,mode:'press'}),/완전히/);
  assert.equal(short.writes.length,1);
  const changed=allReports(); changed[0][64]=1;
  const unsafe=lightingKeyboard(changed);
  await assert.rejects(unsafe.keyboard.setLighting({layer:3,mode:'press'}),/달라졌습니다/);
  assert.equal(unsafe.keyboard.status.lighting,undefined);
});

test('restore refuses a false success when a supposedly untouched layer changes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-deck-protocol-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = allReports();
  const backup = { format: 'mono-deck-mapping', version: 1, device: { vid: 0x1189, pid: 0x8840, serial: 'TEST-SERIAL' }, reports: original, sha256: checksum(original) };
  const file = path.join(directory, 'mapping.json');
  fs.writeFileSync(file, JSON.stringify(backup));
  const current = [...original.filter(r => r[3] !== 3), ...bridgeReports()];
  const { keyboard, trace } = transactionKeyboard(current, original);
  assert.equal((await keyboard.restore(file)).ok, true);
  assert.deepEqual(trace, ['read', 'backup', 'commit', 'read']);
  const damaged = clone(original); damaged[0][12] = 0x05;
  await assert.rejects(transactionKeyboard(current, damaged).keyboard.restore(file));
  const tampered = clone(backup); tampered.reports[0][12] = 0x05;
  fs.writeFileSync(file, JSON.stringify(tampered));
  const blocked = new Keyboard('unused');
  blocked.exclusive = async () => assert.fail('Corrupted backup must fail before hardware access');
  await assert.rejects(blocked.restore(file));
});
