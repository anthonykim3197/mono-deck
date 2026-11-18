const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {parsePack,mergePack,exportPack,previewPack}=require('../src/main/presets.cjs');
const {validateConfig,defaults}=require('../src/main/config.cjs');
const starter=()=>parsePack(JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../assets/work-starter.monodeck.json'),'utf8')));
test('starter adds 6 pages with 15 keys in all groups and preserves original configuration',()=>{
  const config=validateConfig(defaults());config.pageMode='onboard';config.selectedLayer=2;config.enabled=false;config.commonBindings.key7={type:'text',label:'existing',text:'keep',icon:'',color:'#c4f46d'};
  const before=JSON.stringify(config),pack=starter(),result=mergePack(config,pack,pack.profiles.map(p=>p.id));
  assert.equal(result.added.length,6);assert.equal(JSON.stringify(config),before);assert.deepEqual(result.config.profiles.slice(0,2),config.profiles);
  assert.deepEqual({...result.config,profiles:[]},{...config,profiles:[]});
  for(const p of result.config.profiles.slice(2))for(const group of [1,2,3]){assert.equal(Object.keys(p.layers[group]).filter(k=>/^key/.test(k)).length,15);assert.equal(Object.keys(p.layers[group]).length,21);assert.equal(p.layers[group]['knob2.press'],undefined);assert.equal(p.matchProcess,'');}
  assert.deepEqual(validateConfig(result.config),result.config);
});
test('reimport is idempotent and never replaces edits in an installed preset',()=>{
  const pack=starter();let result=mergePack(validateConfig(defaults()),pack,['gpt']);result.config.profiles.at(-1).layers[1].key1.text='my text';
  const before=JSON.stringify(result.config);result=mergePack(result.config,pack,['gpt']);assert.equal(result.added.length,0);assert.equal(result.skipped,1);assert.equal(JSON.stringify(result.config),before);assert.equal(previewPack(pack,result.config).profiles[0].alreadyInstalled,true);
});
test('knob roles follow physical layout while right navigation and global keys stay untouched',()=>{
  const config=validateConfig({...defaults(),knobOrder:[3,1,2]});const result=mergePack(config,starter(),['whale']);const p=result.config.profiles.at(-1);
  assert.equal(p.layers[1]['knob1.cw'],undefined);assert.equal(p.layers[1]['knob3.cw'].label,'다음 탭');assert.equal(p.layers[1]['knob2.cw'].mouseAction,'scroll');assert.deepEqual(result.config.commonBindings,config.commonBindings);
});
test('legacy profile references remap to new IDs, hotkeys and auto activation are removed',()=>{
  const legacy=validateConfig(defaults());legacy.profiles[0].layers[1].key1={type:'sequence',steps:[{type:'profile',profileId:'creative',hotkey:'Ctrl+F1'}]};legacy.profiles[0].layers[1]['knob2.cw']={type:'shortcut',keys:['W']};
  const pack=parsePack(exportPack(legacy,['everyday','creative'])),result=mergePack(legacy,pack,['everyday','creative']);const added=result.config.profiles.slice(2);
  assert.equal(added[0].layers[1].key1.steps[0].profileId,added[1].id);assert.equal(added[0].layers[1].key1.steps[0].hotkey,undefined);assert.equal(added[0].layers[1]['knob2.cw'],undefined);assert.equal(added[1].matchProcess,'');
  assert.throws(()=>mergePack(legacy,pack,['everyday']),/함께 선택/);
});
test('partial selection and invalid or over-capacity files cannot modify existing pages',()=>{
  const config=validateConfig(defaults()),before=JSON.stringify(config),pack=starter();
  assert.equal(mergePack(config,pack,['gpt','lightroom5']).added.length,2);
  assert.throws(()=>mergePack(config,pack,['missing']));assert.throws(()=>parsePack({...pack,version:9}));assert.throws(()=>parsePack({...pack,profiles:[...pack.profiles,pack.profiles[0]]}));
  const full={...config,profiles:Array.from({length:50},(_,i)=>({...config.profiles[0],id:`p${i}`})),activeProfile:'p0'};assert.throws(()=>mergePack(full,pack,['gpt']),/50/);assert.equal(JSON.stringify(config),before);
});
test('GPT uses application functions while Claude/Hermes retain prompts and OBS is PC-only',()=>{
  const pack=starter(),gpt=pack.profiles.find(p=>p.id==='gpt');assert.equal(gpt.presetId,'monodeck.work.gpt.v2');
  for(const group of [1,2,3])for(let n=1;n<=15;n++){const a=gpt.layers[group][`key${n}`];assert.equal(a.type,'shortcut');assert.equal(a.text,undefined);assert.ok(a.keys.length>1);assert.ok(!a.keys.includes('ENTER'));}
  assert.deepEqual(gpt.layers[3].key3.keys,['CTRL','SHIFT','P']);assert.deepEqual(gpt.layers[3]['knob1.cw'].keys,['CTRL','TAB']);
  for(const p of pack.profiles.filter(p=>['claude','hermes'].includes(p.id)))for(let n=1;n<=15;n++){const a=p.layers[3][`key${n}`];assert.equal(a.type,'text');assert.ok(a.text.length>15);}
  const obs=pack.profiles.find(p=>p.id==='obs');const {planOnboard}=require('../src/main/onboard.cjs');assert.equal(planOnboard([{layer:1,control:'key1',action:obs.layers[1].key1}]).ok,false);
});
test('church mixer appends one page with 15 source selection keys and reserved navigation',()=>{
  const config=validateConfig(defaults()),pack=parsePack(JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../assets/obs-mixer.monodeck.json'),'utf8'))),result=mergePack(config,pack,[pack.profiles[0].id]);
  assert.equal(result.added.length,1);assert.deepEqual(result.config.profiles.slice(0,2),config.profiles);assert.deepEqual({...result.config,profiles:[]},{...config,profiles:[]});
  for(const group of [1,2,3]){const l=result.config.profiles.at(-1).layers[group];for(let i=0;i<15;i++){assert.equal(l[`key${i+1}`].obsOperation,'sourceSelect');assert.equal(l[`key${i+1}`].audioIndex,i);}assert.equal(l['knob3.cw'].inputRole,'selected');assert.equal(l['knob3.cw'].volumeStepDb,0.5);assert.equal(l['knob2.cw'],undefined);}
});
