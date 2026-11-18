const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateConfig,validateAction,defaults}=require('../src/main/config.cjs');
test('default config covers all 24 controls and survives validation',()=>{
 const c=validateConfig(defaults());assert.equal(Object.keys(c.profiles[0].bindings).length,21);assert.equal(c.activeProfile,'everyday');assert.deepEqual(c.knobOrder,[1,2,3]);
});
test('import rejects duplicate IDs, missing active profile, and schema v2 bounds',()=>{
 let c=defaults();c.profiles[1].id=c.profiles[0].id;assert.throws(()=>validateConfig(c));
 c=defaults();c.activeProfile='missing';assert.throws(()=>validateConfig(c));
 assert.throws(()=>validateAction({type:'sequence',steps:Array(500).fill({type:'none'})}));
 assert.throws(()=>validateAction({type:'delay',delayMs:3600001}));
 let nested={type:'none'};for(let i=0;i<6;i++)nested={type:'sequence',steps:[nested]};assert.throws(()=>validateAction(nested));
});

test('v1 bindings migrate to hardware layer 3 without populating layers 1 and 2',()=>{
 const legacy=defaults(),before=JSON.stringify(legacy);
 const migrated=validateConfig(legacy);
 assert.equal(migrated.version,1);assert.equal(migrated.schemaRevision,3);assert.equal(migrated.selectedLayer,3);
 assert.deepEqual(migrated.profiles[0].layers[1],{});assert.deepEqual(migrated.profiles[0].layers[2],{});
 assert.deepEqual(migrated.profiles[0].layers[3],migrated.profiles[0].bindings);
 assert.equal(JSON.stringify(legacy),before,'Migration must not modify the import object');
 assert.deepEqual(validateConfig(migrated),migrated,'Validated configuration must survive export/import');
});

test('explicit layer bindings remain separate and layer 3 is authoritative over legacy alias',()=>{
 const c=defaults();c.selectedLayer=1;
 c.profiles[0].layers={1:{key1:{type:'text',text:'one'}},2:{key1:{type:'text',text:'two'}},3:{}};
 const result=validateConfig(c);
 assert.equal(result.selectedLayer,1);assert.equal(result.profiles[0].layers[1].key1.text,'one');
 assert.equal(result.profiles[0].layers[2].key1.text,'two');assert.deepEqual(result.profiles[0].bindings,{});
 const partial=defaults();partial.profiles[0].layers={1:{key1:{type:'none'}}};
 assert.equal(Object.keys(validateConfig(partial).profiles[0].layers[3]).length,21,'Partial v2 layers retain legacy layer 3 during migration');
});

test('500-node and depth-5 limits include nested branches rather than only top-level arrays',()=>{
 const boundary={type:'sequence',steps:Array.from({length:499},()=>({type:'none'}))};
 assert.equal(validateAction(boundary).steps.length,499);
 assert.throws(()=>validateAction({...boundary,steps:[...boundary.steps,{type:'none'}]}));
 assert.throws(()=>validateAction({type:'condition',condition:'window',process:'notepad',thenSteps:Array(250).fill({type:'none'}),elseSteps:Array(250).fill({type:'none'})}));
 let nested={type:'none'};for(let i=0;i<5;i++)nested={type:'sequence',steps:[nested]};
 assert.doesNotThrow(()=>validateAction(nested));
 assert.throws(()=>validateAction({type:'sequence',steps:[nested]}));
});

test('extended timing, playback and repetition accept exact boundaries but reject nonfinite or invalid values',()=>{
 const action=validateAction({type:'sequence',delayMs:3600000,jitterMs:60000,repeatCount:10000,intervalMs:60000,playbackSpeed:0.1,steps:[]});
 assert.equal(action.delayMs,3600000);assert.equal(action.playbackSpeed,0.1);
 assert.equal(validateAction({type:'repeat',count:10000,playbackSpeed:10}).count,10000);
 for(const playbackSpeed of [0,0.09,10.1,NaN,Infinity,'1'])assert.throws(()=>validateAction({type:'sequence',playbackSpeed}));
 for(const count of [0,-1,10001,1.5])assert.throws(()=>validateAction({type:'repeat',count}));
 for(const delayMs of [-1,3600001,1.5,'100'])assert.throws(()=>validateAction({type:'delay',delayMs}));
});

test('recorded key and mouse actions, pixel/window conditions, and monitor coordinates survive sanitization',()=>{
 const macro={type:'sequence',steps:[
  {type:'key',key:'CTRL',state:'down'},
  {type:'mouse',mouseAction:'move',coordinateSpace:'desktop',x:-1910,y:-150},
  {type:'mouse',mouseAction:'click',coordinateSpace:'monitor',monitorId:'DISPLAY2',x:10,y:20,clicks:2},
  {type:'wait',condition:'pixel',pixelColor:'#ABCDEF',x:5,y:6,tolerance:255,timeoutMs:3600000,pollMs:20},
  {type:'condition',condition:'window',process:'notepad.exe',titleContains:'Draft',thenSteps:[{type:'key',key:'CTRL',state:'up'}],elseSteps:[{type:'stop'}]},
  {type:'delay',delayMs:10,disabled:true,comment:'keep note'}
 ]};
 const value=validateAction(macro);
 assert.equal(value.steps[1].x,-1910);assert.equal(value.steps[2].monitorId,'DISPLAY2');
 assert.equal(value.steps[3].pixelColor,'#abcdef');assert.equal(value.steps[4].thenSteps[0].state,'up');
 assert.equal(value.steps[5].disabled,true);assert.equal(value.steps[5].comment,'keep note');
});

test('invalid hold states, mouse coordinates, conditions and enums are rejected before execution',()=>{
 const bad=[
  {type:'key',key:'A'}, {type:'key',key:'A',state:'toggle'},
  {type:'mouse'}, {type:'mouse',mouseAction:'move',x:1}, {type:'mouse',mouseAction:'click',button:'back'},
  {type:'wait',condition:'pixel',x:0,y:0}, {type:'condition',condition:'window'},
  {type:'wait',condition:'pixel',x:0,y:0,pixelColor:'#fff'},
  {type:'sequence',repeatMode:'forever'}, {type:'sequence',disabled:'true'},
  {type:'mouse',mouseAction:'move',coordinateSpace:'window',x:1,y:1},
  {type:'wait',condition:'window',process:'notepad',timeoutMs:0},
 ];
 for(const action of bad)assert.throws(()=>validateAction(action),JSON.stringify(action));
});
test('toggle repetition is allowed only for the root sequence',()=>{
 assert.equal(validateAction({type:'sequence',repeatMode:'toggle',steps:[{type:'none'}]}).repeatMode,'toggle');
 assert.throws(()=>validateAction({type:'sequence',steps:[{type:'sequence',repeatMode:'toggle',steps:[{type:'none'}]}]}));
 assert.throws(()=>validateAction({type:'condition',condition:'window',process:'notepad',thenSteps:[{type:'sequence',repeatMode:'toggle'}]}));
 assert.doesNotThrow(()=>validateAction({type:'sequence',repeatMode:'toggle',steps:[{type:'repeat',count:2,steps:[{type:'none'}]}]}));
});
test('config only preserves known action fields and supports knob calibration',()=>{
 const c=defaults();c.knobOrder=[3,1,2];c.knobDirection={knob2:true};c.profiles[0].bindings.key1.arbitrary='drop';c.profiles[0].bindings.unknown={type:'none'};
 const result=validateConfig(c);assert.deepEqual(result.knobOrder,[3,1,2]);assert.equal(result.knobDirection.knob2,true);assert.equal(result.profiles[0].bindings.unknown,undefined);assert.equal(result.profiles[0].bindings.key1.arbitrary,undefined);
});
