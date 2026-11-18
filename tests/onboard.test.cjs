const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const originalLoad=Module._load;
let protocol,onboard;
try{
  Module._load=function(name,...rest){if(name==='node-hid')return {devicesAsync:async()=>assert.fail('No hardware access in onboard tests'),HIDAsync:{open:async()=>assert.fail('No hardware access')}};return originalLoad.call(this,name,...rest);};
  protocol=require('../src/main/protocol.cjs');onboard=require('../src/main/onboard.cjs');
}finally{Module._load=originalLoad;}
const {Keyboard,mappingPacket,packet}=protocol;
const {planOnboard,decodeReports,compileAction,mediaUsages}=onboard;
const clone=x=>JSON.parse(JSON.stringify(x));
const asRead=r=>{const copy=[...r];copy[1]=0xfa;return copy;};
const original=()=>[1,2,3].flatMap(layer=>Array.from({length:24},(_,i)=>asRead(mappingPacket(i+1,layer))));
const entry=(action,layer=3,control='key1')=>({layer,control,action});
const shortcut=keys=>({type:'shortcut',keys});

test('portable keyboard uses standard HID usages and exact 884x long-header fields',()=>{
  const p=planOnboard([entry(shortcut(['CTRL','ALT','DELETE']),2,'key15')]);
  assert.equal(p.ok,true);assert.equal(p.entries[0].summary,'CTRL+ALT+DELETE');
  assert.deepEqual(p.entries[0].report.slice(0,13),[3,0xfe,15,2,1,0,0,0,0,0,1,5,0x4c]);
  assert.equal(p.entries[0].report.length,65);assert.ok(p.entries[0].report.slice(13).every(x=>x===0));
  const right=planOnboard([entry(shortcut(['RCTRL','RSHIFT','RALT','RWIN','A']))]);
  assert.equal(right.entries[0].report[11],0xf0);assert.equal(right.entries[0].report[12],4);
  assert.equal(planOnboard([entry(shortcut(['CTRL','+']))]).entries[0].report[12],0x2e);
});

test('every supported media command uses consumer usage rather than Windows virtual-key codes',()=>{
  for(const [media,usage] of Object.entries(mediaUsages)){
    const p=planOnboard([entry({type:'media',media},1,'knob3.press')]);
    assert.equal(p.ok,true);
    assert.deepEqual(p.entries[0].report.slice(0,13),[3,0xfe,23,1,2,0,0,0,0,0,0,usage&255,usage>>8]);
  }
  assert.equal(planOnboard([entry({type:'media',media:'unknown'})]).ok,false);
});

test('keyboard-only sequences preserve per-stroke modifiers and enforce the 18-stroke limit',()=>{
  const steps=Array.from({length:18},(_,i)=>shortcut(i%2?['SHIFT','B']:['CTRL','A']));
  const p=planOnboard([entry({type:'sequence',steps})]);
  assert.equal(p.ok,true);assert.equal(p.entries[0].report[10],18);
  assert.deepEqual(p.entries[0].report.slice(11,19),[1,4,2,5,1,4,2,5]);
  assert.equal(planOnboard([entry({type:'sequence',steps:[...steps,shortcut(['C'])]})]).ok,false);
  assert.equal(planOnboard([entry({type:'sequence',steps:[{type:'sequence',steps:[shortcut(['A'])]},shortcut(['B'])]})]).entries[0].report[10],2);
});

test('incompatible semantics are listed instead of silently flattening delay, hold or complex actions',()=>{
  const actions=[
    shortcut(['CTRL']),shortcut(['A','B']),shortcut(['VK_41']),
    {...shortcut(['A']),delayMs:1},{...shortcut(['A']),jitterMs:1},
    {...shortcut(['A']),disabled:true},{type:'sequence',repeatCount:2,steps:[shortcut(['A'])]},
    {type:'sequence',intervalMs:1,steps:[shortcut(['A'])]},
    {type:'sequence',playbackSpeed:2,steps:[shortcut(['A'])]},
    {type:'sequence',repeatMode:'toggle',steps:[shortcut(['A'])]},
    {type:'sequence',steps:[shortcut(['A']),{type:'delay',delayMs:0}]},
    {type:'key',key:'A',state:'down'},{type:'text',text:'한글'},
    {type:'mouse',mouseAction:'click'}, {type:'url',url:'https://example.com'},
    {type:'wait',condition:'window',process:'notepad'},
  ];
  for(const action of actions){const p=planOnboard([entry(action)]);assert.equal(p.ok,false,JSON.stringify(action));assert.equal(p.incompatible.length,1);assert.ok(p.incompatible[0].reason);}
  const mixed=planOnboard([entry(shortcut(['A'])),entry({type:'text',text:'x'},3,'key2')]);
  assert.equal(mixed.ok,false);assert.equal(mixed.entries.length,1);assert.equal(mixed.incompatible[0].control,'key2');
});

test('portable F13–F24 are rejected even when embedded in a sequence',()=>{
  for(const key of ['F13','F24']){
    assert.equal(planOnboard([entry(shortcut(['CTRL',key]))]).ok,false);
    assert.equal(planOnboard([entry({type:'sequence',steps:[shortcut(['A']),shortcut([key])]} )]).ok,false);
  }
});

test('preview has stable order/hash, does not mutate input and rejects invalid slot selections',()=>{
  const entries=[entry(shortcut(['B']),3,'key2'),entry(shortcut(['A']),1,'key1')],before=clone(entries);
  const p=planOnboard(entries),reverse=planOnboard([...entries].reverse());
  assert.deepEqual(entries,before);assert.equal(p.hash,reverse.hash);
  assert.equal(p.entries[0].layer,1);
  assert.notEqual(p.hash,planOnboard([entry(shortcut(['C']),1,'key1'),entries[0]]).hash);
  for(const bad of [[],null,[entry(shortcut(['A']),0)],[entry(shortcut(['A']),3,'key25')],[entries[0],entries[0]]])assert.throws(()=>planOnboard(bad));
});

test('read decodes keyboard, sequence and media into editable basic actions without claiming timing',()=>{
  const reports=original();
  const actions=[shortcut(['CTRL','C']),{type:'sequence',steps:[shortcut(['A']),shortcut(['SHIFT','B'])]},{type:'media',media:'playPause'},{type:'none'}];
  for(let i=0;i<actions.length;i++)reports[i]=asRead(compileAction(actions[i],i+1,1).report);
  const decoded=decodeReports(reports);
  assert.deepEqual(decoded[0].action,shortcut(['CTRL','C']));
  assert.deepEqual(decoded[1].action,actions[1]);assert.deepEqual(decoded[2].action,actions[2]);assert.deepEqual(decoded[3].action,actions[3]);
  assert.ok(decoded.slice(0,4).every(s=>s.editable&&s.timingKnown===false&&!s.appManaged));
  assert.equal(decoded[4].kind,'app');assert.equal(decoded[4].action,undefined);assert.equal(decoded[4].editable,false);
});

test('read preserves unknown usage, modifiers-only, opaque tail and mouse data without inventing editable actions',()=>{
  const reports=original();
  reports[0]=asRead(packet([3,0xfe,1,1,1,0,0,0,0,0,1,0,0xff]));
  reports[1]=asRead(packet([3,0xfe,2,1,1,0,0,0,0,0,0,1,0]));
  reports[2]=asRead(compileAction(shortcut(['A']),3,1).report);reports[2][64]=0x7f;
  reports[3]=asRead(packet([3,0xfe,4,1,3,0,0,0,0,0,5,0,0,0xfb,10]));
  const d=decodeReports(reports);
  assert.match(d[0].summary,/HID_0xff/);assert.equal(d[1].kind,'modifier');assert.match(d[2].summary,/추가 원본/);
  assert.deepEqual(d[3].details,{subtype:5,modifiers:0,buttons:0,dx:-5,dy:10});
  assert.ok(d.slice(0,4).every(s=>!s.editable&&s.action===undefined));
  assert.deepEqual(d[2].raw,reports[2]);d[2].raw[64]=0;assert.equal(reports[2][64],0x7f);
  assert.throws(()=>decodeReports(reports.slice(1)));
});

function transaction(entries,alterAfter){
  const plan=planOnboard(entries),before=original(),after=clone(before),trace=[];
  for(const e of plan.entries)after[(e.layer-1)*24+e.id-1]=asRead(e.report);
  if(alterAfter)alterAfter(after);
  const keyboard=new Keyboard('unused');keyboard.updateMap(before);
  const reads=[before,after];
  keyboard.exclusive=async work=>work({});
  keyboard.read=async()=>{trace.push('read');return reads.shift();};
  keyboard.saveBackup=reports=>{trace.push('backup');assert.equal(reports.length,72);assert.deepEqual(reports,before);return 'safe-before.json';};
  keyboard.commit=async(_,reports)=>{trace.push('commit');assert.deepEqual(reports,plan.entries.map(e=>e.report));assert.equal(keyboard.inputMap.has('F13'),false,'Selected old trigger is removed before writes');};
  return {keyboard,plan,trace,before,after};
}

test('selected-slot upload backs up 72, writes one slot, verifies all others and removes app dispatch',async()=>{
  const entries=[entry(shortcut(['CTRL','C']))],f=transaction(entries);
  const result=await f.keyboard.uploadOnboard(entries,{expectedHash:f.plan.hash});
  assert.equal(result.ok,true);assert.equal(result.count,1);assert.equal(result.path,'safe-before.json');
  assert.deepEqual(f.trace,['read','backup','commit','read']);assert.equal(f.keyboard.status.totalMappedControls,71);
  assert.equal(f.keyboard.inputMap.has('F13'),false);assert.equal(result.slots[48].summary,'CTRL+C');
});

test('upload refuses stale preview or any incompatible action before accessing hardware',async()=>{
  const keyboard=new Keyboard('unused');keyboard.exclusive=async()=>assert.fail('Must reject before device access');
  const entries=[entry(shortcut(['A']))],plan=planOnboard(entries);
  await assert.rejects(keyboard.uploadOnboard(entries),/미리보기/);
  await assert.rejects(keyboard.uploadOnboard([entry(shortcut(['B']))],{expectedHash:plan.hash}),/미리보기/);
  await assert.rejects(keyboard.uploadOnboard([entry({type:'text',text:'x'})],{expectedHash:plan.hash}),/저장할 수 없는/);
});

test('selected or unselected opaque-byte changes fail exact verification and expose recovery backup',async()=>{
  const entries=[entry(shortcut(['A']))];
  for(const index of [0,48]){
    const f=transaction(entries,reports=>reports[index][64]=1);
    await assert.rejects(f.keyboard.uploadOnboard(entries,{expectedHash:f.plan.hash}),/safe-before.json/);
  }
  const f=transaction(entries);f.keyboard.commit=async()=>{throw new Error('partial write');};
  await assert.rejects(f.keyboard.uploadOnboard(entries,{expectedHash:f.plan.hash}),/partial write.*safe-before.json/);
  assert.equal(f.keyboard.inputMap.has('F13'),false);
});

test('individual app-mode restore writes only requested reserved slots and verifies remaining records',async()=>{
  const keyboard=new Keyboard('unused'),before=original(),after=original(),trace=[];
  before[48]=asRead(compileAction(shortcut(['C']),1,3).report);
  keyboard.exclusive=async work=>work({});let reads=0;keyboard.read=async()=>{trace.push('read');return reads++?after:before;};
  keyboard.saveBackup=()=>{trace.push('backup');return 'restore-backup.json';};
  keyboard.commit=async(_,reports)=>{trace.push('commit');assert.deepEqual(reports,[[...mappingPacket(1,3)]]);};
  const result=await keyboard.restoreAppSlots([{layer:3,control:'key1'}]);
  assert.equal(result.mode,'app');assert.equal(keyboard.status.totalMappedControls,72);assert.deepEqual(trace,['read','backup','commit','read']);
});

test('readOnboard reads all layers and returns app signals without writing any mapping',async()=>{
  const keyboard=new Keyboard('unused');let reads=0;
  keyboard.exclusive=async work=>work({});keyboard.read=async()=>{reads++;return original();};
  keyboard.commit=async()=>assert.fail('Read must not write');keyboard.saveBackup=()=>assert.fail('Read does not need backup');
  const result=await keyboard.readOnboard();assert.equal(reads,1);assert.equal(result.slots.length,72);assert.equal(result.lightingKnown,false);
  assert.ok(result.slots.every(s=>s.appManaged&&!s.editable));
});

test('a factory keyboard sequence containing a reserved trigger disables ambiguous app dispatch',()=>{
  const reports=original(),keyboard=new Keyboard('unused');
  reports[0]=asRead(packet([3,0xfe,1,1,1,0,0,0,0,0,2,0,0x68,0,4]));
  keyboard.updateMap(reports);
  assert.equal(keyboard.inputMap.has('F13'),false);assert.equal(keyboard.inputMap.has('CTRL+F13'),false);
  assert.equal(keyboard.status.totalMappedControls,70);
  reports[0]=asRead(packet([3,0xfe,1,1,1,0,0,0,0,0,1,0,0x69]));keyboard.updateMap(reports);
  assert.equal(keyboard.inputMap.has('F14'),false,'A noncanonical slot must not take ownership of another slot trigger');
});
