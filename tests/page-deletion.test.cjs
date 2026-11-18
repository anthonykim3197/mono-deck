const {test}=require('node:test');
const assert=require('node:assert/strict');
const {removeProfile,previewProfileDeletion,resolveBindings,PageNavigation,ONBOARD_ID}=require('../src/main/pages.cjs');
const {validateConfig}=require('../src/main/config.cjs');
function fixture(){return validateConfig({version:1,activeProfile:'b',enabled:true,selectedLayer:2,profiles:['a','b','c'].map(id=>({id,name:id,bindings:{key1:{type:'shortcut',keys:['CTRL','C']}}}))});}

test('deletion preserves remaining pages, settings and common controls; active falls back to adjacent page',()=>{
  const before=fixture(),snapshot=structuredClone(before),after=removeProfile(before,'b');
  assert.deepEqual(before,snapshot);
  assert.deepEqual(after,{...before,activeProfile:'a',profiles:[before.profiles[0],before.profiles[2]]});
  assert.equal(after.profiles[0],before.profiles[0]);assert.equal(after.commonBindings,before.commonBindings);
  assert.deepEqual(validateConfig(after),after);
  assert.equal(removeProfile({...before,activeProfile:'c'},'c').activeProfile,'b');
  assert.equal(removeProfile({...before,activeProfile:'a'},'a').activeProfile,'b');
});
test('captured target is deleted even if the active page changed; zero mode is preserved',()=>{
  const before={...fixture(),activeProfile:'c',pageMode:'onboard'};
  const after=removeProfile(before,'b');assert.equal(after.activeProfile,'c');assert.equal(after.pageMode,'onboard');
  assert.deepEqual(after.profiles.map(p=>p.id),['a','c']);
});
test('fixed zero, missing target and last remaining PC page cannot be deleted',()=>{
  const c=fixture();assert.throws(()=>removeProfile(c,ONBOARD_ID),/0번/);
  assert.throws(()=>removeProfile(c,'missing'),/찾을 수/);
  assert.throws(()=>removeProfile({...c,activeProfile:'a',profiles:[c.profiles[0]]},'a'),/최소 1개/);
});
test('preview identifies common and nested references; reviewed deletion clears only matching nodes',()=>{
  for(const link of [{type:'profile',profileId:'b'},{type:'page',pageOperation:'select',profileId:'b'}]){
    for(const field of ['steps','thenSteps','elseSteps']){
      const c=fixture();c.profiles[0].layers[2].key2={type:'sequence',[field]:[{type:'repeat',steps:[link]}]};
      const saved=structuredClone(c),review=previewProfileDeletion(c,'b');
      assert.deepEqual(review.references.map(r=>[r.profileName,r.group,r.control,r.path]),[['a',2,'key2',[{field,index:0},{field:'steps',index:0}]]]);
      assert.throws(()=>removeProfile(c,'b'),/함께 해제/);
      const next=removeProfile(c,'b',{detachReferences:true,expectedHash:review.hash});
      assert.equal(next.profiles[0].layers[2].key2[field][0].steps[0].type,'none');
      assert.deepEqual(c,saved);assert.deepEqual(next.profiles[1],c.profiles[2]);
    }
    const c=fixture();c.commonBindings.key4=link;const review=previewProfileDeletion(c,'b');
    assert.equal(review.references[0].profileName,'공통 키');
    const next=removeProfile(c,'b',{detachReferences:true,expectedHash:review.hash});
    assert.equal(next.commonBindings.key4.type,'none');
    assert.deepEqual(next.commonBindings['knob2.cw'],c.commonBindings['knob2.cw']);
  }
});
test('direct page links become explicit empty slots, preventing common-key fallback or stale hotkeys',()=>{
  const c=fixture();c.commonBindings.key2={type:'shortcut',keys:['CTRL','V']};
  c.profiles[0].layers[3].key2={type:'page',pageOperation:'select',profileId:'b',hotkey:'Ctrl+Alt+K'};
  const next=removeProfile(c,'b',{detachReferences:true});
  assert.equal(next.profiles[0].bindings,next.profiles[0].layers[3]);
  assert.equal(resolveBindings(next,next.profiles[0],3).key2.type,'none');
  assert.equal(next.profiles[0].bindings.key2.hotkey,undefined);
  assert.deepEqual(next.commonBindings,c.commonBindings);
});
test('complex macro keeps all other steps, branches and repetition settings',()=>{
  const c=fixture(),delay={type:'delay',label:'대기',delayMs:300};
  c.profiles[0].layers[3].key2={type:'sequence',label:'혼합',repeatMode:'count',repeatCount:4,steps:[delay,{type:'condition',label:'창 확인',condition:'window',process:'notepad',thenSteps:[{type:'profile',label:'이동',profileId:'b'},delay],elseSteps:[{type:'page',label:'0번',pageOperation:'select',profileId:ONBOARD_ID}]},{type:'shortcut',label:'복사',keys:['CTRL','C']}]};
  const next=removeProfile(c,'b',{detachReferences:true}),macro=next.profiles[0].layers[3].key2,original=c.profiles[0].layers[3].key2;
  assert.equal(macro.repeatCount,4);assert.equal(macro.steps.length,3);
  assert.equal(macro.steps[0],original.steps[0]);assert.equal(macro.steps[2],original.steps[2]);
  assert.equal(macro.steps[1].thenSteps[0].type,'none');assert.equal(macro.steps[1].thenSteps[1],delay);
  assert.equal(macro.steps[1].elseSteps,original.steps[1].elseSteps);
  assert.doesNotThrow(()=>validateConfig(next));
});
test('review becomes stale when target or incoming links change; selection-only changes do not block deletion',()=>{
  const c=fixture(),review=previewProfileDeletion(c,'b');
  c.profiles[2].layers[1].key3={type:'profile',profileId:'b'};
  assert.throws(()=>removeProfile(c,'b',{detachReferences:true,expectedHash:review.hash}),/다시 확인/);
  const refreshed=previewProfileDeletion(c,'b');c.profiles[1].name='renamed';
  assert.throws(()=>removeProfile(c,'b',{detachReferences:true,expectedHash:refreshed.hash}),/다시 확인/);
  const current=previewProfileDeletion(c,'b');c.activeProfile='c';
  assert.equal(removeProfile(c,'b',{detachReferences:true,expectedHash:current.hash}).activeProfile,'c');
});
test('self-links on removed page do not block deletion; stale knob candidates cannot be selected',()=>{
  const c=fixture();c.profiles[1].layers[1].key1={type:'profile',profileId:'b'};
  const next=removeProfile(c,'b'),nav=new PageNavigation();nav.candidate='b';
  assert.equal(nav.apply(next,'confirm'),null);assert.equal(nav.candidate,null);
  assert.equal(nav.apply(next,'next'),'c');assert.equal(nav.apply(next,'previous'),'c');
});
