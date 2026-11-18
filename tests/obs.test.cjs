const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ObsClient,ObsController,authentication}=require('../src/main/obs.cjs');
const {validateAction}=require('../src/main/config.cjs');
function fakeClient(){let db=-12;const calls=[];let scene='A';const client={request:async(type,data)=>{calls.push({type,data});if(type==='GetSceneList')return {currentProgramSceneName:scene,scenes:[{sceneName:'C',sceneIndex:2,sceneUuid:'c'},{sceneName:'A',sceneIndex:0,sceneUuid:'a'},{sceneName:'B',sceneIndex:1,sceneUuid:'b'}]};if(type==='GetInputVolume')return {inputVolumeDb:db};if(type==='SetInputVolume')db=data.inputVolumeDb;if(type==='SetCurrentProgramScene')scene=data.sceneName;if(type==='ToggleInputMute')return {inputMuted:true};return {};}};return {client,calls,getDb:()=>db,setDb:v=>{db=v;}};}
test('scene rotation previews in display order without changing program until confirm',async()=>{
  const f=fakeClient(),feedback=[];let time=0;const o=new ObsController({client:f.client,onFeedback:v=>feedback.push(v),now:()=>time});
  await o.execute({obsOperation:'sceneNext'});assert.equal(feedback.at(-1).title,'B');assert.ok(!f.calls.some(c=>c.type.startsWith('Set')));
  await o.execute({obsOperation:'scenePrevious'});assert.equal(feedback.at(-1).title,'A');await o.execute({obsOperation:'scenePrevious'});assert.equal(feedback.at(-1).title,'C');
  await o.execute({obsOperation:'sceneConfirm'});assert.equal(f.calls.at(-1).type,'SetCurrentProgramScene');assert.equal(f.calls.at(-1).data.sceneName,'C');await assert.rejects(o.execute({obsOperation:'sceneConfirm'}));
  await o.execute({obsOperation:'sceneNext'});time=9000;await assert.rejects(o.execute({obsOperation:'sceneConfirm'}),/만료/);
  await assert.rejects(o.execute({obsOperation:'sceneSelect',sceneIndex:50}),/없습니다/);
});
test('volume changes selected OBS capture source by 1dB, clamps, and distinguishes microphone',async()=>{
  const f=fakeClient(),o=new ObsController({client:f.client,getTargets:()=>({volume:'Capture',microphone:'Mic'})});
  await o.execute({obsOperation:'volumeUp'});assert.equal(f.getDb(),-11);assert.equal(f.calls.at(-1).data.inputName,'Capture');await o.execute({obsOperation:'volumeDown'});assert.equal(f.getDb(),-12);
  f.setDb(-0.5);await o.execute({obsOperation:'volumeUp'});assert.equal(f.getDb(),0);f.setDb(-100);await o.execute({obsOperation:'volumeDown'});assert.equal(f.getDb(),-100);
  await o.execute({obsOperation:'mute',inputRole:'microphone'});assert.deepEqual(f.calls.at(-1),{type:'SetInputMute',data:{inputName:'Mic',inputMuted:true}});
  await assert.rejects(new ObsController({client:f.client}).execute({obsOperation:'volumeUp'}),/선택/);
});
test('cancelled macro after a read does not write volume or take a scene',async()=>{
  const f=fakeClient(),o=new ObsController({client:f.client,getTargets:()=>({volume:'Capture'})});const stop=()=>{throw new Error('cancelled');};
  await assert.rejects(o.execute({obsOperation:'volumeUp'},stop),/cancelled/);await assert.rejects(o.execute({obsOperation:'sceneSelect',sceneIndex:0},stop),/cancelled/);assert.ok(!f.calls.some(c=>c.type.startsWith('Set')));
});
class Socket extends EventTarget{
  static instances=[];
  constructor(url){super();this.url=url;this.sent=[];Socket.instances.push(this);queueMicrotask(()=>this.message({op:0,d:{rpcVersion:1,authentication:{salt:'salt',challenge:'challenge'}}}));}
  message(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
  send(raw){const value=JSON.parse(raw);this.sent.push(value);if(value.op===1)queueMicrotask(()=>this.message({op:2,d:{negotiatedRpcVersion:1}}));else if(value.d.requestType!=='NoResponse')queueMicrotask(()=>this.message({op:7,d:{requestId:value.d.requestId,requestStatus:{result:value.d.requestType!=='Bad',code:400,comment:'failed'},responseData:{ok:true}}}));}
  close(){this.dispatchEvent(new Event('close'));}
}
test('OBS 5 authenticated handshake sends no requests before identification and matches IDs',async()=>{
  const c=new ObsClient({getConnection:()=>({port:4455,password:'local password'}),WebSocketImpl:Socket,timeout:100});
  const [a,b]=await Promise.all([c.request('GetSceneList'),c.request('GetInputList')]);assert.deepEqual(a,{ok:true});assert.deepEqual(b,{ok:true});const s=Socket.instances.at(-1);
  assert.equal(s.url,'ws://127.0.0.1:4455');assert.equal(s.sent[0].op,1);assert.equal(s.sent[0].d.authentication,authentication('local password','salt','challenge'));assert.ok(!JSON.stringify(s.sent).includes('local password'));assert.equal(s.sent.filter(m=>m.op===1).length,1);
  await assert.rejects(c.request('Bad'),/failed/);c.disconnect();assert.equal(c.connected,false);
});
test('OBS request timeout does not automatically replay mutations and disconnect rejects pending work',async()=>{
  const c=new ObsClient({getConnection:()=>({port:4455}),WebSocketImpl:Socket,timeout:25});await assert.rejects(c.request('NoResponse'),/시간 초과/);assert.equal(Socket.instances.at(-1).sent.filter(m=>m.op===6).length,1);
  const pending=c.request('NoResponse');await Promise.resolve();c.disconnect();await assert.rejects(pending,/종료/);
});
test('OBS configuration validates operation, source role and scene index',()=>{
  assert.equal(validateAction({type:'obs',obsOperation:'volumeDown',inputRole:'volume'}).obsOperation,'volumeDown');
  for(const a of [{obsOperation:'ExecuteArbitrary'},{obsOperation:'volumeUp',inputRole:'unknown'},{obsOperation:'sceneSelect',sceneIndex:-1},{obsOperation:'sceneSelect'}])assert.throws(()=>validateAction({type:'obs',...a}));
});
function multiAudio(){
  const levels=new Map([['HDMI',-12],['Mixer USB',-8],['Desktop',-20]]),muted=new Set(['HDMI']),writes=[];
  const client={request:async(type,d={})=>{
    if(type==='GetSceneList')return {scenes:[],currentProgramSceneName:''};
    if(type==='GetInputList')return {inputs:[{inputName:'HDMI',inputKind:'capture'},{inputName:'Mixer USB',inputKind:'wasapi_input_capture'},{inputName:'Video only',inputKind:'image_source'}]};
    if(type==='GetSpecialInputs')return {desktop1:'Desktop',mic1:'Mixer USB',mic2:null};
    if(!levels.has(d.inputName))throw Error('Missing audio source');
    if(type==='GetInputVolume')return {inputVolumeDb:levels.get(d.inputName)};
    if(type==='GetInputMute')return {inputMuted:muted.has(d.inputName)};
    writes.push({type,...d});
    if(type==='SetInputVolume')levels.set(d.inputName,d.inputVolumeDb);
    if(type==='ToggleInputMute'){if(muted.has(d.inputName))muted.delete(d.inputName);else muted.add(d.inputName);return {inputMuted:muted.has(d.inputName)};}
    return {};
  }};
  const targets={volume:'HDMI',microphone:'Mixer USB',sources:['HDMI','','Mixer USB','Desktop']},feedback=[];
  const o=new ObsController({client,getTargets:()=>targets,onFeedback:v=>feedback.push(v)});
  return {o,targets,levels,muted,writes,feedback};
}
test('audio selection is read-only and fractional knob changes only the selected source',async()=>{
  const f=multiAudio();await f.o.execute({obsOperation:'sourceSelect',audioIndex:2});assert.equal(f.writes.length,0);assert.match(f.feedback.at(-1).title,/Mixer USB.*-8.0/);
  await f.o.execute({obsOperation:'volumeUp',inputRole:'selected',volumeStepDb:0.5});assert.equal(f.levels.get('Mixer USB'),-7.5);assert.equal(f.levels.get('HDMI'),-12);assert.equal(f.levels.get('Desktop'),-20);
  for(let i=0;i<10;i++)await f.o.execute({obsOperation:'volumeDown',inputRole:'selected',volumeStepDb:0.1});assert.equal(f.levels.get('Mixer USB'),-8.5);
  await f.o.execute({obsOperation:'toggleMute',inputRole:'selected'});assert.equal(f.muted.has('Mixer USB'),true);assert.equal(f.muted.has('HDMI'),true);
  await f.o.execute({obsOperation:'volumeDown',inputRole:'selected',volumeStepDb:0.5});assert.match(f.feedback.at(-1).title,/음소거/);
  await f.o.execute({obsOperation:'volumeUp',inputRole:'volume'});assert.equal(f.levels.get('HDMI'),-11);assert.equal(f.levels.get('Mixer USB'),-9);
});
test('source knob skips unassigned keys, wraps, and status never changes volume',async()=>{
  const f=multiAudio();await f.o.execute({obsOperation:'sourceNext'});assert.equal(f.o.selectedName(),'HDMI');await f.o.execute({obsOperation:'sourceNext'});assert.equal(f.o.selectedName(),'Mixer USB');await f.o.execute({obsOperation:'sourcePrevious'});assert.equal(f.o.selectedName(),'HDMI');await f.o.execute({obsOperation:'sourcePrevious'});assert.equal(f.o.selectedName(),'Desktop');await f.o.execute({obsOperation:'sourceStatus'});assert.equal(f.writes.length,0);
});
test('missing, remapped or cancelled selection cannot adjust the previously selected source',async()=>{
  const f=multiAudio();await assert.rejects(f.o.execute({obsOperation:'volumeUp',inputRole:'selected'}),/먼저/);
  await f.o.execute({obsOperation:'sourceSelect',audioIndex:0});await assert.rejects(f.o.execute({obsOperation:'sourceSelect',audioIndex:1}),/선택/);await assert.rejects(f.o.execute({obsOperation:'volumeUp',inputRole:'selected'}),/먼저/);
  await f.o.execute({obsOperation:'sourceSelect',audioIndex:0});f.targets.sources[0]='Desktop';await assert.rejects(f.o.execute({obsOperation:'volumeUp',inputRole:'selected'}),/먼저/);
  await f.o.execute({obsOperation:'sourceSelect',audioIndex:2});f.levels.delete('Mixer USB');await assert.rejects(f.o.execute({obsOperation:'volumeDown',inputRole:'selected'}),/Missing/);assert.equal(f.o.selectedName(),'');
  await assert.rejects(f.o.execute({obsOperation:'sourceSelect',audioIndex:0},()=>{throw Error('cancelled');}),/cancelled/);assert.equal(f.o.selectedName(),'');assert.equal(f.writes.length,0);
});
test('inventory includes special desktop audio once and excludes inputs with no volume',async()=>{
  const f=multiAudio(),inventory=await f.o.inspect();assert.deepEqual(inventory.audio.map(a=>a.inputName),['HDMI','Mixer USB','Desktop']);assert.equal(f.writes.length,0);
});
test('slot persistence accepts only current source names and enforces 15 slots',()=>{
  const {validateTargets}=require('../src/main/obs.cjs'),audio=['HDMI','Mixer USB','Desktop'].map(inputName=>({inputName}));
  const saved=validateTargets({volume:'HDMI',microphone:'Mixer USB',sources:['Desktop','','HDMI']},audio);assert.equal(saved.sources.length,15);assert.deepEqual(saved.sources.slice(0,4),['Desktop','','HDMI','']);
  for(const input of [null,{sources:['stale']},{sources:[5]},{sources:'HDMI'},{sources:Array(16).fill('')},{volume:{}}])assert.throws(()=>validateTargets(input,audio));
  assert.equal(validateTargets({volume:'HDMI'},audio).volume,'HDMI');
});
test('audio slot and step validation reject malformed actions while preserving portable settings',()=>{
  const a=validateAction({type:'obs',obsOperation:'sourceSelect',audioIndex:14});assert.equal(a.audioIndex,14);
  assert.equal(validateAction({type:'obs',obsOperation:'volumeUp',inputRole:'selected',volumeStepDb:0.5}).volumeStepDb,0.5);
  for(const extra of [{obsOperation:'sourceSelect'},{obsOperation:'sourceSelect',audioIndex:15},{obsOperation:'sourceSelect',audioIndex:-1},{obsOperation:'volumeUp',volumeStepDb:NaN},{obsOperation:'volumeUp',volumeStepDb:5}])assert.throws(()=>validateAction({type:'obs',...extra}));
});
