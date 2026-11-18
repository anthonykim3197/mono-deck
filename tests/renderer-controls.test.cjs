const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
function load(name){
  const source=fs.readFileSync(require('node:path').join(__dirname,'../src/renderer',name),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require});return module.exports;
}
const {advanceDialFeedback:advance,settleDialFeedback:settle}=load('dial-feedback.ts');
const {selectOnboardEntries:select}=load('onboard-selection.ts');
test('dial rotation is signed, accumulates beyond 360 and press never rotates',()=>{
  let state={};for(let i=0;i<21;i++)state=advance(state,'knob2.cw');
  assert.equal(state[2].angle,378);
  state=advance(state,'knob2.ccw');assert.equal(state[2].angle,360);assert.equal(state[2].motion,'ccw');
  state=advance(state,'knob2.press');assert.equal(state[2].angle,360);assert.equal(state[2].motion,'press');
  assert.equal(advance(state,'key1'),state);assert.equal(advance(state,'knob4.cw'),state);
});
test('independent dial activity and stale timers preserve newer detents and angle',()=>{
  let state=advance({},'knob1.ccw');const serial=state[1].serial;
  state=advance(state,'knob1.ccw');state=advance(state,'knob3.cw');
  assert.equal(settle(state,'1',serial),state);
  state=settle(state,'1',state[1].serial);
  assert.equal(state[1].angle,-36);assert.equal(state[1].motion,null);assert.equal(state[3].motion,'cw');
});
test('onboard source bindings remap only destination layer and explicit exclusions preserve PC actions',()=>{
  const bindings={key1:{type:'shortcut',keys:['A']},key2:{type:'none'},'knob2.cw':{type:'page',pageOperation:'previewNext'}};
  const before=JSON.stringify(bindings);
  let entries=select(bindings,1,'layer','key1');
  assert.equal(entries.length,2);assert.ok(entries.every(e=>e.layer===1));
  const {planOnboard}=require('../src/main/onboard.cjs');
  assert.equal(planOnboard(entries).ok,false,'PC-only navigation is not silently skipped');
  entries=select(bindings,1,'layer','key1',['knob2.cw']);
  const plan=planOnboard(entries);assert.equal(plan.ok,true);assert.equal(plan.entries[0].report[3],1);
  assert.notEqual(plan.hash,planOnboard(select(bindings,2,'layer','key1',['knob2.cw'])).hash);
  assert.equal(JSON.stringify(bindings),before);
});
test('single empty slot remains explicit clearing and invalid target layers fail',()=>{
  assert.equal(select({},3,'key','key1')[0].action.type,'none');
  assert.throws(()=>select({},8,'key','key1'));
  assert.equal(select({},1,'layer','key1').length,0);
});

function everydayReview(){
  const {defaults,validateConfig}=require('../src/main/config.cjs');
  const {resolveBindings}=require('../src/main/pages.cjs');
  const config=validateConfig(defaults());
  const bindings=resolveBindings(config,config.profiles[0],3);
  const input=select(bindings,1,'layer','key1');
  return {bindings,input,plan:require('../src/main/onboard.cjs').planOnboard(input)};
}

test('Everyday config 3 to device 1 keeps Ctrl+C valid and explicit exclusion prepares 19 portable slots',()=>{
  const {bindings,input,plan}=everydayReview();
  assert.equal(plan.ok,false);assert.equal(plan.entries.length,19);assert.equal(plan.incompatible.length,5);
  const copy=plan.entries.find(e=>e.control==='key1');
  assert.equal(copy.summary,'CTRL+C');assert.deepEqual(copy.report.slice(10,13),[1,1,6]);
  const before=JSON.stringify(bindings);
  const excluded=plan.incompatible.map(e=>e.control);
  const filtered=select(bindings,1,'layer','key1',excluded);
  const ready=require('../src/main/onboard.cjs').planOnboard(filtered);
  assert.equal(ready.ok,true);assert.equal(ready.entries.length,19);assert.equal(ready.incompatible.length,0);
  assert.ok(ready.entries.every(e=>e.layer===1&&!excluded.includes(e.control)));
  assert.equal(JSON.stringify(bindings),before,'the PC configuration is not edited by upload exclusion');
  assert.notEqual(JSON.stringify(input),JSON.stringify(filtered),'the old review signature must be invalidated');
  const manualExcluded=select(bindings,1,'layer','key1',['key2',...excluded]);
  assert.equal(manualExcluded.length,18);assert.ok(!manualExcluded.some(e=>e.control==='key2'));
});

test('mixed review renders Ctrl+C only in the supported section and offers exclusion, not upload',()=>{
  const React=require('react');
  const {renderToStaticMarkup}=require('react-dom/server');
  const Review=load('OnboardReview.tsx').default;
  const {plan}=everydayReview();
  const render=(p,extra={})=>renderToStaticMarkup(React.createElement(Review,{plan:p,targetLayer:1,canExclude:true,canUpload:true,busy:'',onExclude(){},onUpload(){},...extra}));
  const html=render(plan);
  assert.match(html,/불가능한 5개 제외하고 저장 준비/);
  assert.doesNotMatch(html,/0번 저장 후 기기에 기록/);
  const supported=html.match(/<details class="onboard-plan valid"[\s\S]*?<\/details>/)[0];
  const unsupported=html.match(/<details class="onboard-plan invalid"[\s\S]*?<\/details>/)[0];
  assert.match(supported,/CTRL\+C/);assert.match(supported,/저장 가능한 19개/);
  assert.doesNotMatch(unsupported,/CTRL\+C/);assert.match(unsupported,/PC 페이지 전환/);
  const ready={...plan,ok:true,incompatible:[]};
  assert.match(render(ready),/그룹 1 · 0번 저장 후 기기에 기록 \(19개\)/);
  assert.doesNotMatch(render(ready),/onboard-plan invalid/);
  const disconnected=render(ready,{canUpload:false});
  assert.match(disconnected,/<button class="secondary-button" disabled=""/);
  assert.doesNotMatch(render({...plan,entries:[]},{canExclude:false}),/제외하고 저장 준비|0번 저장 후 기기에 기록/);
});

test('zero editor offers only portable action types and clearly separates PC saving from device recording',()=>{
  const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const Zero=load('OnboardZeroView.tsx').default;
  const html=renderToStaticMarkup(React.createElement(Zero,{layer:3,connected:true,hardwareMode:'pc'}));
  const actionTypes=[...html.matchAll(/<option value="([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(actionTypes,['none','shortcut','media','sequence']);
  assert.match(html,/최대 18개/);assert.match(html,/0번 프리셋에 저장 · PC 보관/);assert.match(html,/기기에 쓰기 검토/);
});
