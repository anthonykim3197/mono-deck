const test = require('node:test');
const assert = require('node:assert/strict');
const { MacroRunner, colorMatches } = require('../src/main/macro-engine.cjs');

// Fake transport and clock only: no native helper or device can be opened here.
const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  let time = 0, focused = false;
  const calls = [], events = [], sleeps = [], held = new Set();
  const monitors = options.monitors || [{ id:'left', left:-1920, top:-200, width:1920, height:1080 }];
  const bridge = {
    ready:true,
    async request(command, data={}) {
      calls.push({command,data:clone(data)});
      if(command==='releaseAll') held.clear();
      if(command==='key') data.state==='down'?held.add(data.key):held.delete(data.key);
      if(command==='mouse' && ['down','up'].includes(data.action)) data.action==='down'?held.add('mouse:'+data.button):held.delete('mouse:'+data.button);
      if(options.request) { const value=await options.request(command,data); if(value!==undefined)return value; }
      if(command==='monitors')return {monitors};
      if(command==='pixel')return {color:'#102030'};
      if(command==='foreground')return {process:'NOTEPAD.EXE',title:'Draft — Notes'};
      return {};
    }
  };
  const runner=new MacroRunner({
    bridge,blockedPid:1234,isEditorFocused:()=>focused,
    now:()=>time,random:()=>1,
    sleep:async ms=>{sleeps.push(ms);time+=ms;if(options.onSleep)await options.onSleep(ms,runner);},
    onEvent:event=>events.push(clone(event)),
    executeExternal:async action=>{calls.push({command:'external',data:clone(action)});}
  });
  return {runner,calls,events,sleeps,held,time:()=>time,focus:value=>{focused=value;}};
}
const shortcut=key=>({type:'shortcut',keys:[key]});
const sequence=steps=>({type:'sequence',steps});
const outputs=f=>f.calls.filter(c=>!['resume','releaseAll','monitors','pixel','foreground'].includes(c.command));
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('nested repeats execute in order and release held input on completion', async () => {
  const f=fixture();
  const result=await f.runner.run({
    type:'sequence',repeatCount:2,steps:[
      {type:'key',key:'CTRL',state:'down'},
      {type:'repeat',count:2,steps:[shortcut('C'),{type:'mouse',mouseAction:'click',button:'left'}]},
      {type:'key',key:'CTRL',state:'up'}
    ]
  });
  await flush();assert.equal(result.ok,true);
  const one=['key:down','shortcut:C','mouse:click','shortcut:C','mouse:click','key:up'];
  assert.deepEqual(outputs(f).map(c=>c.command+':'+(c.data.state||c.data.keys?.[0]||c.data.action)),[...one,...one]);
  assert.equal(f.held.size,0);assert.equal(f.calls.at(-1).command,'releaseAll');
  assert.ok(outputs(f).every(c=>c.data.blockedForegroundPid===1234));
});

test('bridge failure releases both keyboard and mouse holds and skips later steps', async () => {
  const f=fixture({request:command=>{if(command==='text')throw new Error('injection failed');}});
  const result=await f.runner.run(sequence([
    {type:'key',key:'CTRL',state:'down'},
    {type:'mouse',mouseAction:'down',button:'left'},
    {type:'text',text:'failure'},shortcut('X')
  ]));
  await flush();assert.equal(result.ok,false);assert.match(result.error,/injection failed/);
  assert.equal(f.held.size,0);assert.equal(f.calls.at(-1).command,'releaseAll');
  assert.equal(outputs(f).some(c=>c.command==='shortcut'),false);
  assert.equal(f.events.at(-1).status,'error');
});

test('cancellation interrupts an hour delay within one 25ms slice and releases holds', async () => {
  let stopped=false;
  const f=fixture({onSleep:async (_ms,runner)=>{if(!stopped){stopped=true;await runner.stop('test stop');}}});
  const result=await f.runner.run(sequence([
    {type:'key',key:'SHIFT',state:'down'},
    {type:'mouse',mouseAction:'down',button:'right'},
    {type:'delay',delayMs:3600000},shortcut('X')
  ]));
  await flush();assert.equal(result.cancelled,true);
  assert.equal(f.time(),25);assert.equal(f.held.size,0);
  assert.equal(outputs(f).some(c=>c.command==='shortcut'),false);
});

test('stop drains queued work and a later run can start cleanly', async () => {
  const entered=gate(),unblock=gate();
  let first=true;
  const f=fixture({onSleep:async()=>{if(first){first=false;entered.resolve();await unblock.promise;}}});
  const running=f.runner.run(sequence([{type:'delay',delayMs:1000},shortcut('A')]));
  const queued=f.runner.run(shortcut('B'));
  await entered.promise;await f.runner.stop();unblock.resolve();
  assert.equal((await running).cancelled,true);assert.equal((await queued).cancelled,true);
  await flush();assert.deepEqual(outputs(f),[]);
  assert.equal((await f.runner.run(shortcut('C'))).ok,true);await flush();
  assert.deepEqual(outputs(f).map(x=>x.data.keys),[['C']]);
});

test('pixel tolerance and window predicates choose only the matching branches', async () => {
  const f=fixture();
  const result=await f.runner.run(sequence([
    {type:'condition',condition:'pixel',x:-20,y:40,pixelColor:'#112131',tolerance:1,thenSteps:[shortcut('A')],elseSteps:[shortcut('B')]},
    {type:'condition',condition:'window',process:'notepad',titleContains:'draft',thenSteps:[shortcut('C')],elseSteps:[shortcut('D')]},
    {type:'condition',condition:'window',process:'notepad.exe',titleContains:'absent',thenSteps:[shortcut('E')],elseSteps:[shortcut('F')]}
  ]));
  await flush();assert.equal(result.ok,true);
  assert.deepEqual(outputs(f).map(x=>x.data.keys),[['A'],['C'],['F']]);
  assert.deepEqual(f.calls.find(x=>x.command==='pixel').data,{x:-20,y:40});
  assert.equal(colorMatches('#102030','#102032',1),false);
  assert.equal(colorMatches('invalid','#102030',255),false);
});

test('wait conditions poll until ready and time out without issuing later input', async () => {
  let probes=0;
  const ready=fixture({request:command=>command==='pixel'?{color:++probes>=3?'#00ff00':'#000000'}:undefined});
  const wait={type:'wait',condition:'pixel',x:0,y:0,pixelColor:'#00ff00',timeoutMs:500,pollMs:50};
  assert.equal((await ready.runner.run(sequence([wait,shortcut('A')]))).ok,true);await flush();
  assert.equal(ready.time(),100);assert.equal(probes,3);assert.equal(outputs(ready).length,1);
  const never=fixture({request:command=>command==='pixel'?{color:'#000000'}:undefined});
  const result=await never.runner.run(sequence([{...wait,timeoutMs:125},shortcut('X')]));
  await flush();assert.equal(result.ok,false);assert.match(result.error,/초과/);
  assert.equal(never.time(),125);assert.deepEqual(outputs(never),[]);assert.equal(never.calls.at(-1).command,'releaseAll');
});

test('dry run does not issue even resume, probes, external actions, or release commands', async () => {
  const f=fixture();f.focus(true);
  const result=await f.runner.run(sequence([
    {type:'key',key:'A',state:'down'},
    {type:'wait',condition:'pixel',x:1,y:1,pixelColor:'#ffffff',coordinateSpace:'monitor',monitorId:'missing'},
    {type:'condition',condition:'window',process:'anything',thenSteps:[shortcut('Y')],elseSteps:[shortcut('N')]},
    {type:'url',url:'https://example.com'},
    {type:'repeat',count:10000,steps:[shortcut('Z')]}
  ]),{dryRun:true});
  await flush();assert.equal(result.ok,true);assert.ok(result.plan.length>=8);
  assert.deepEqual(f.calls,[]);assert.equal(f.time(),0);
});

test('dry-run stop is a plan, not an emergency-stop command', async () => {
  const f=fixture();
  const result=await f.runner.run({type:'stop'},{dryRun:true});
  await flush();assert.equal(result.ok,true);
  assert.deepEqual(f.calls,[],'Previewing Stop must not send releaseAll');
  assert.deepEqual(result.plan.map(item=>item.type),['stop']);
});

test('previewing the running toggle from the same source does not stop it', async () => {
  const entered=gate(),unblock=gate();
  const f=fixture({onSleep:async()=>{entered.resolve();await unblock.promise;}});
  const action={type:'sequence',repeatMode:'toggle',steps:[shortcut('A')]};
  const pending=f.runner.run(action,{source:'layer3/key1'});
  await entered.promise;
  const callsBefore=f.calls.length;
  try {
    const preview=await f.runner.run(action,{source:'layer3/key1',dryRun:true});
    assert.equal(preview.ok,true);
    assert.equal(f.runner.current.cancelled,false,'Preview must not cancel the active toggle');
    assert.equal(f.calls.length,callsBefore,'Preview must not send releaseAll');
    assert.ok(preview.plan.length>0);
  } finally {
    await f.runner.stop();unblock.resolve();await pending;await flush();
  }
});

test('monitor-local coordinates translate into negative desktop coordinates for mouse and pixel', async () => {
  const f=fixture();
  const result=await f.runner.run(sequence([
    {type:'mouse',mouseAction:'move',coordinateSpace:'monitor',monitorId:'left',x:10,y:20},
    {type:'condition',condition:'pixel',coordinateSpace:'monitor',monitorId:'left',x:15,y:25,pixelColor:'#102030',thenSteps:[shortcut('A')]}
  ]));
  await flush();assert.equal(result.ok,true);
  const mouse=f.calls.find(x=>x.command==='mouse'),pixel=f.calls.find(x=>x.command==='pixel');
  assert.equal(mouse.data.x,-1910);assert.equal(mouse.data.y,-180);
  assert.deepEqual(pixel.data,{x:-1905,y:-175});
});

test('missing monitors and out-of-bounds local coordinates fail before mouse output', async () => {
  for(const point of [{monitorId:'missing',x:1,y:1},{monitorId:'left',x:-1,y:1},{monitorId:'left',x:1920,y:1}]) {
    const f=fixture();
    const result=await f.runner.run({type:'mouse',mouseAction:'move',coordinateSpace:'monitor',...point});
    await flush();assert.equal(result.ok,false);assert.deepEqual(outputs(f),[]);
  }
  const f=fixture();
  assert.equal((await f.runner.run({type:'mouse',mouseAction:'move',relative:true,coordinateSpace:'monitor',monitorId:'missing',x:-10,y:20})).ok,true);
  await flush();assert.equal(f.calls.some(x=>x.command==='monitors'),false);
  assert.equal(outputs(f)[0].data.x,-10);
});

test('same physical source stops toggle repetition and a different source is rejected', async () => {
  const entered=gate(),unblock=gate();
  const f=fixture({onSleep:async()=>{entered.resolve();await unblock.promise;}});
  const action={type:'sequence',repeatMode:'toggle',steps:[shortcut('A')]};
  const pending=f.runner.run(action,{source:'layer3/key1'});
  await entered.promise;
  const other=await f.runner.run(shortcut('B'),{source:'layer3/key2'});
  assert.equal(other.ok,false);
  assert.equal((await f.runner.run(action,{source:'layer3/key1'})).ok,true);
  unblock.resolve();assert.equal((await pending).cancelled,true);await flush();
  assert.deepEqual(outputs(f).map(x=>x.data.keys),[['A']]);
});

test('disabled steps skip their subtrees and timing; speed scales enabled delay and jitter', async () => {
  const f=fixture();
  const result=await f.runner.run({
    type:'sequence',playbackSpeed:2,steps:[
      {type:'repeat',disabled:true,delayMs:3600000,count:10000,steps:[shortcut('X')]},
      {type:'delay',delayMs:100,jitterMs:20},shortcut('A')
    ]
  });
  await flush();assert.equal(result.ok,true);assert.equal(f.time(),60);
  assert.deepEqual(outputs(f).map(x=>x.data.keys),[['A']]);
});

test('foreground changes detected after a probe cancel output and release keys', async () => {
  let f;
  f=fixture({request:command=>{if(command==='foreground'){f.focus(true);return {process:'notepad',title:'Draft'};}}});
  const result=await f.runner.run(sequence([
    {type:'key',key:'CTRL',state:'down'},
    {type:'condition',condition:'window',process:'notepad',thenSteps:[shortcut('C')]}
  ]));
  await flush();assert.equal(result.cancelled,true);assert.equal(f.held.size,0);
  assert.equal(outputs(f).some(x=>x.command==='shortcut'),false);
});

test('completion and the next queued job wait for held-input cleanup', async () => {
  const cleaning=gate(),finishCleanup=gate();
  let releases=0,firstResolved=false;
  const f=fixture({request:async command=>{
    if(command==='releaseAll'&&++releases===1){cleaning.resolve();await finishCleanup.promise;}
  }});
  const first=f.runner.run({type:'key',key:'CTRL',state:'down'}).then(result=>{firstResolved=true;return result;});
  const second=f.runner.run(shortcut('B'));
  await cleaning.promise;
  assert.equal(firstResolved,false,'A caller must not see completion while cleanup is pending');
  assert.deepEqual(outputs(f).map(x=>x.command),['key']);
  assert.equal(f.calls.filter(x=>x.command==='resume').length,1,'Queued input must not start during cleanup');
  finishCleanup.resolve();
  assert.equal((await first).ok,true);assert.equal((await second).ok,true);
  assert.deepEqual(outputs(f).map(x=>x.command),['key','shortcut']);
  assert.equal(f.held.size,0);
});

test('cancelling a pending monitor lookup prevents late mouse output', async () => {
  const querying=gate(),finishQuery=gate();
  const f=fixture({request:async command=>{
    if(command==='monitors'){querying.resolve();await finishQuery.promise;return {monitors:[{id:'left',left:-1920,top:0,width:1920,height:1080}]};}
  }});
  const pending=f.runner.run({type:'mouse',mouseAction:'move',coordinateSpace:'monitor',monitorId:'left',x:10,y:10});
  await querying.promise;await f.runner.stop();finishQuery.resolve();
  assert.equal((await pending).cancelled,true);
  assert.deepEqual(outputs(f),[]);assert.equal(f.calls.at(-1).command,'releaseAll');
});
