const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PageNavigation,resolveBindings,defaultCommonBindings}=require('../src/main/pages.cjs');
const {validateConfig,validateAction,defaults}=require('../src/main/config.cjs');
test('candidate selection wraps without changing the active page, commit/cancel clears candidate',()=>{
  const nav=new PageNavigation(),config={activeProfile:'b',profiles:['a','b','c'].map(id=>({id}))};
  assert.equal(nav.apply(config,'previewNext'),null);assert.equal(nav.candidate,'c');assert.equal(config.activeProfile,'b');
  nav.apply(config,'previewNext');assert.equal(nav.candidate,'a');
  assert.equal(nav.apply(config,'confirm'),'a');assert.equal(nav.candidate,null);
  nav.apply(config,'previewPrevious');nav.apply(config,'cancel');assert.equal(nav.apply(config,'confirm'),null);
  assert.equal(nav.apply(config,'previous'),'a');assert.equal(nav.apply(config,'next'),'c');
  assert.throws(()=>nav.apply(config,'select','missing'));
});
test('one-page wrap, deleted candidates and direct selection remain deterministic',()=>{
  const nav=new PageNavigation(),config={activeProfile:'a',profiles:[{id:'a'}]};
  nav.apply(config,'previewNext');assert.equal(nav.candidate,'a');
  nav.candidate='deleted';assert.equal(nav.apply(config,'confirm'),null);
  nav.apply(config,'previewNext');assert.equal(nav.apply(config,'select','a'),'a');assert.equal(nav.candidate,null);
});
test('common controls inherit across pages and all physical layers; explicit none blocks fallback',()=>{
  const c=validateConfig(defaults());
  for(const p of c.profiles)for(const layer of [1,2,3])assert.equal(resolveBindings(c,p,layer)['knob2.cw'].pageOperation,'previewNext');
  c.commonBindings.key3={type:'text',text:'shared'};
  const p=c.profiles[0];p.layers[1].key3={type:'none'};
  assert.equal(resolveBindings(c,p,1).key3.type,'none');assert.equal(resolveBindings(c,p,2).key3.text,'shared');
  p.layers[2]['knob2.cw']={type:'media',media:'volumeUp'};assert.equal(resolveBindings(c,p,2)['knob2.cw'].type,'media');
  assert.equal(resolveBindings(c,c.profiles[1],2)['knob2.cw'].type,'page');
});
test('page/common configuration round-trips and invalid operations are rejected',()=>{
  const c=validateConfig({...defaults(),commonBindings:defaultCommonBindings(1),pageHotkeys:false});
  assert.deepEqual(validateConfig(c),c);assert.equal(c.pageHotkeys,false);assert.ok(c.commonBindings['knob1.press']);
  assert.throws(()=>validateAction({type:'page',pageOperation:'arbitrary'}));
  assert.throws(()=>validateAction({type:'page',pageOperation:'select'}));
  assert.equal(validateAction({type:'page',pageOperation:'select',profileId:'creative'}).profileId,'creative');
});
