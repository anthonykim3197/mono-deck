const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {ModeManager}=require('../src/main/mode-manager.cjs');
const {mappingPacket,checksum}=require('../src/main/protocol.cjs');
const {planOnboard}=require('../src/main/onboard.cjs');
const {PageNavigation,ONBOARD_ID}=require('../src/main/pages.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const read=r=>{const v=[...r];v[1]=0xfa;return v;};
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mono-deck-mode-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const config={knobOrder:[1,2,3]};
  const keyboard={status:{connected:true,serial:'TEST-NO-HARDWARE'},lastReports:[1,2,3].flatMap(layer=>Array.from({length:24},(_,i)=>read(mappingPacket(i+1,layer)))),writes:[],
    async writeSelectedMappings(reports,mode,hooks){
      hooks.onProgress({phase:'reading',done:0,total:reports.length});
      await hooks.beforeWrite({before:clone(this.lastReports),backupPath:'test-backup',serial:this.status.serial});
      if(this.block)await this.block;
      if(this.fail)throw new Error('simulated disconnect after backup');
      this.writes.push({reports:clone(reports),mode});
      for(let i=0;i<reports.length;i++){
        const report=read(reports[i]);this.lastReports[this.lastReports.findIndex(r=>r[2]===report[2]&&r[3]===report[3])]=report;
        hooks.onProgress({phase:'writing',done:i+1,total:reports.length});
      }
      hooks.onProgress({phase:'verifying',done:reports.length,total:reports.length});
      return {ok:true};
    }};
  const changes=[];
  const options={keyboard,directory,getConfig:()=>config,onChange:()=>changes.push(manager.state())};
  const manager=new ModeManager(options);manager.sync();
  return {manager,keyboard,config,changes,options};
}
test('portable zero saves on PC without touching mappings and remains executable after restart',t=>{
  const {manager,keyboard,options}=fixture(t),before=checksum(keyboard.lastReports);
  const entries=[{layer:3,control:'key1',action:{type:'sequence',steps:Array.from({length:18},()=>({type:'shortcut',keys:['CTRL','C']}))}}];
  manager.savePreset(entries,{expectedHash:manager.plan(entries).hash});
  assert.equal(manager.presetBindings(3).key1.steps.length,18);
  assert.equal(manager.groups[3].mode,'pc');assert.equal(keyboard.writes.length,0);assert.equal(checksum(keyboard.lastReports),before);
  const restarted=new ModeManager({...options,onChange(){}});restarted.sync();
  assert.equal(restarted.presetBindings(3).key1.steps.length,18);assert.equal(restarted.presetBindings(1).key1.type,'none');
  assert.equal(restarted.presetBindings(3)['knob2.cw'],undefined,'reserved navigation is not a portable action');
});
test('zero rejects advanced features and nineteen chords without modifying saved presets or hardware',t=>{
  const {manager,keyboard}=fixture(t),before=manager.bankHash(3);
  const invalid=[{type:'app',path:'demo.exe'},{type:'url',url:'https://example.com'},{type:'text',text:'x'},{type:'mouse',mouseAction:'click'},
    {type:'delay',delayMs:10},{type:'repeat',count:2,steps:[{type:'shortcut',keys:['A']}]},
    {type:'shortcut',keys:['A'],delayMs:1},{type:'shortcut',keys:['A'],repeatCount:2},
    {type:'sequence',repeatMode:'toggle',steps:[{type:'shortcut',keys:['A']}]},
    {type:'sequence',steps:Array.from({length:19},()=>({type:'shortcut',keys:['A']}))},
    {type:'sequence',steps:[{type:'shortcut',keys:['A']},{type:'delay',delayMs:1}]}];
  for(const action of invalid){const entries=[{layer:3,control:'key1',action}],plan=manager.plan(entries);assert.equal(plan.ok,false);assert.throws(()=>manager.savePreset(entries,{expectedHash:plan.hash}),/0번/);}
  assert.equal(manager.bankHash(3),before);assert.equal(keyboard.writes.length,0);
});
test('hardware upload is a separate reviewed operation and cannot apply a stale zero hash',async t=>{
  const {manager,keyboard}=fixture(t),stale=manager.bankHash(3);
  const entries=[{layer:3,control:'key1',action:{type:'shortcut',keys:['CTRL','C']}}];
  manager.savePreset(entries,{expectedHash:manager.plan(entries).hash});
  assert.throws(()=>manager.applyPreset(3,stale),/바뀌/);assert.equal(keyboard.writes.length,0);
  await manager.applyPreset(3,manager.bankHash(3));assert.equal(keyboard.writes.length,1);
  assert.equal(manager.groups[3].mode,'onboard');assert.deepEqual(keyboard.lastReports.find(r=>r[3]===3&&r[2]===1).slice(10,13),[1,1,6]);
});
test('refreshing zero from device preserves app-only slots and does not overwrite a bank with trigger signals',async t=>{
  const {manager,keyboard}=fixture(t);keyboard.readOnboard=async()=>({ok:true});
  const entries=[{layer:3,control:'key2',action:{type:'shortcut',keys:['CTRL','C']}}];
  manager.savePreset(entries,{expectedHash:manager.plan(entries).hash});const before=manager.bankHash(3);
  await assert.rejects(manager.capturePreset(3),/앱 연결 신호만/);assert.equal(manager.bankHash(3),before);
  const direct=read(planOnboard([{layer:3,control:'key1',action:{type:'shortcut',keys:['CTRL','V']}}]).entries[0].report);
  keyboard.lastReports=keyboard.lastReports.map(r=>r[3]===3&&r[2]===1?direct:r);
  await manager.capturePreset(3);
  assert.deepEqual(manager.presetBindings(3).key1.keys,['CTRL','V']);assert.deepEqual(manager.presetBindings(3).key2.keys,['CTRL','C']);
  assert.equal(keyboard.writes.length,0);
});
test('zero preserves portable bindings, empties app-only slots, and retains three common knob signals',async t=>{
  const {manager,keyboard}=fixture(t);
  const original=checksum(keyboard.lastReports);
  assert.equal(manager.groups[3].mode,'pc');assert.equal(manager.groups[3].storedCount,0);
  await manager.activate('onboard',3);
  assert.equal(manager.groups[3].mode,'onboard');
  const rows=keyboard.lastReports.filter(r=>r[3]===3);
  assert.equal(rows[0][10],0);
  for(const id of [19,20,21])assert.deepEqual(rows[id-1],read(mappingPacket(id,3)));
  assert.ok(keyboard.lastReports.filter(r=>r[3]!==3).every(r=>JSON.stringify(r)===JSON.stringify(read(mappingPacket(r[2],r[3])))));
  await manager.activate('pc',3);assert.equal(checksum(keyboard.lastReports),original);
  const writes=keyboard.writes.length;await manager.activate('pc',3);assert.equal(keyboard.writes.length,writes,'PC-to-PC navigation must not rewrite flash');
});
test('edited onboard zero survives PC mode, restart and reentry; other groups are independent',async t=>{
  const {manager,keyboard,options}=fixture(t);
  const input=[{layer:2,control:'key1',action:{type:'shortcut',keys:['CTRL','C']}}];
  await manager.saveOnboard(input,{expectedHash:manager.plan(input).hash});
  assert.equal(manager.groups[2].mode,'onboard');assert.equal(manager.groups[3].mode,'pc');
  assert.equal(manager.groups[2].storedCount,1);
  await manager.activate('pc',2);
  const restarted=new ModeManager({...options,onChange(){}});restarted.sync();
  await restarted.activate('onboard',2);
  assert.deepEqual(keyboard.lastReports.find(r=>r[3]===2&&r[2]===1).slice(10,13),[1,1,6]);
});
test('busy lock rejects overlapping writes; group is frozen and progress records verification',async t=>{
  const {manager,keyboard,changes}=fixture(t);
  let release;keyboard.block=new Promise(resolve=>release=resolve);
  const write=manager.activate('onboard',1);
  await Promise.resolve();assert.equal(manager.transition.layer,1);
  assert.throws(()=>manager.activate('pc',3),/전환 중/);
  release();await write;
  assert.equal(manager.groups[1].mode,'onboard');assert.equal(manager.groups[3].mode,'pc');
  assert.ok(changes.some(s=>s.transition?.phase==='verifying'));assert.equal(manager.transition,null);
});
test('failed write does not claim a completed mode; journal and original bank survive retry',async t=>{
  const {manager,keyboard}=fixture(t);keyboard.fail=true;
  await assert.rejects(manager.activate('onboard',3),/simulated/);
  assert.equal(manager.groups[3].mode,'unknown');assert.match(manager.error,/simulated/);
  assert.ok(JSON.parse(fs.readFileSync(manager.file)).pending);
  keyboard.fail=false;await manager.activate('onboard',3);
  assert.equal(manager.groups[3].mode,'onboard');assert.equal(manager.store.pending,null);
});
test('restart resolves a completed write journal using readback without issuing another write',async t=>{
  const {manager,keyboard,options}=fixture(t);
  const input=[{layer:1,control:'key1',action:{type:'shortcut',keys:['CTRL','V']}}];
  const expected=manager.bank(1).map(r=>r[2]===1?read(planOnboard(input).entries[0].report):r);
  const nextBank={reports:expected,savedAt:'test',source:'edited'};
  manager.store.pending={layer:1,expected,nextBank};manager.persist();
  keyboard.lastReports=keyboard.lastReports.map(r=>r[3]===1?expected.find(e=>e[2]===r[2]):r);
  const restarted=new ModeManager({...options,onChange(){}});restarted.sync();
  assert.equal(restarted.groups[1].mode,'onboard');assert.equal(restarted.groups[1].storedCount,1);
  assert.equal(restarted.store.pending,null);assert.equal(keyboard.writes.length,0);
});
test('invalid hashes, navigation knob overrides, unknown groups and corrupt banks cannot write',async t=>{
  const {manager,keyboard,options}=fixture(t);
  const input=[{layer:3,control:'key1',action:{type:'shortcut',keys:['A']}}];
  await assert.rejects(manager.saveOnboard(input,{expectedHash:'wrong'}));
  assert.equal(manager.plan([{...input[0],control:'knob2.cw'}]).ok,false);
  await assert.rejects(manager.activate('onboard',undefined),/그룹/);
  const bad=JSON.parse(fs.readFileSync(manager.file));bad.banks[3].reports[0][12]=4;fs.writeFileSync(manager.file,JSON.stringify(bad));
  const restarted=new ModeManager({...options,onChange(){}});restarted.sync();assert.match(restarted.error,/검증 실패/);
  assert.throws(()=>restarted.activate('onboard',3),/검증 실패/);assert.equal(keyboard.writes.length,0);
});
test('common knob can browse zero, tenth and later pages without committing a candidate',()=>{
  const nav=new PageNavigation(),config={includeOnboard:true,activeProfile:'p9',profiles:Array.from({length:12},(_,i)=>({id:`p${i+1}`}))};
  nav.apply(config,'previewNext');assert.equal(nav.candidate,'p10');assert.equal(config.activeProfile,'p9');
  nav.apply(config,'previewNext');assert.equal(nav.candidate,'p11');
  assert.equal(nav.apply(config,'confirm'),'p11');
  assert.equal(nav.apply({...config,activeProfile:'p12'},'next'),ONBOARD_ID);
  assert.equal(nav.apply({...config,activeProfile:ONBOARD_ID},'next'),'p1');
  assert.equal(nav.apply({...config,activeProfile:'p1'},'previous'),ONBOARD_ID);
});
