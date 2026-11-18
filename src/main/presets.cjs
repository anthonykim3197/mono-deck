const {randomUUID}=require('node:crypto');
const {validateConfig}=require('./config.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const FORMAT='mono-deck-preset-pack';
function visit(action,fn){fn(action);for(const field of ['steps','thenSteps','elseSteps'])for(const step of action[field]||[])visit(step,fn);}
function parsePack(data){
  if(!data||typeof data!=='object'||(data.format!==FORMAT&&data.version!==1)||data.version!==1)throw new Error('MONO DECK 프리셋 또는 기존 설정 JSON 파일을 선택하세요.');
  if(data.format&&data.format!==FORMAT)throw new Error('지원하지 않는 프리셋 형식입니다.');
  const profiles=data.profiles;
  const normalized=validateConfig({version:1,profiles,activeProfile:profiles?.[0]?.id,knobOrder:data.knobOrder,commonBindings:{}});
  const origins=normalized.profiles.map(p=>p.presetId).filter(Boolean);if(new Set(origins).size!==origins.length)throw new Error('파일 안에 같은 프리셋 ID가 중복되어 있습니다.');
  return {format:FORMAT,version:1,name:String(data.name||'가져온 PC 페이지').slice(0,100),description:String(data.description||'').slice(0,3000),knobOrder:normalized.knobOrder,profiles:normalized.profiles};
}
function previewPack(pack,config){
  return {name:pack.name,description:pack.description,profiles:pack.profiles.map(p=>{
    const actions=Object.values(p.layers).flatMap(Object.values),warnings=new Set();
    for(const a of actions)visit(a,s=>{if(s.type==='app')warnings.add('프로그램 실행 포함');if(s.type==='url')warnings.add('웹사이트 열기 포함');if(s.type==='obs')warnings.add('OBS 연결 설정 필요');if(s.hotkey)warnings.add('전역 실행 단축키는 가져오지 않음');});
    return {id:p.id,name:p.name,description:p.description||'',alreadyInstalled:!!p.presetId&&config.profiles.some(old=>old.presetId===p.presetId),keys:Object.entries(p.layers[3]).filter(([key])=>/^key\d+$/.test(key)).map(([control,a])=>({control,label:a.label,type:a.type,detail:a.text||a.comment||a.keys?.join(' + ')||a.obsOperation||a.type})),knobs:[pack.knobOrder[0],pack.knobOrder[2]].map(n=>({position:n===pack.knobOrder[0]?'왼쪽 작은 노브':'아래 큰 노브',actions:['ccw','press','cw'].map(d=>p.layers[3][`knob${n}.${d}`]?.label||'비어 있음')})),warnings:[...warnings]};
  })};
}
function mergePack(config,pack,selectedIds,{newId=()=>`preset-${randomUUID()}`}={}){
  if(!Array.isArray(selectedIds)||!selectedIds.length||new Set(selectedIds).size!==selectedIds.length)throw new Error('추가할 PC 페이지를 선택하세요.');
  const selected=selectedIds.map(id=>{const p=pack.profiles.find(p=>p.id===id);if(!p)throw new Error('파일에 없는 페이지입니다.');return p;});
  const add=selected.filter(p=>!p.presetId||!config.profiles.some(old=>old.presetId===p.presetId));
  if(config.profiles.length+add.length>50)throw new Error('PC 페이지는 최대 50개까지 추가할 수 있습니다.');
  const existingIds=new Set(config.profiles.map(p=>p.id)),mapping=new Map();
  for(const p of selected){const old=p.presetId&&config.profiles.find(o=>o.presetId===p.presetId);if(old){mapping.set(p.id,old.id);continue;}const id=newId();if(existingIds.has(id))throw new Error('새 페이지 ID가 중복되었습니다.');existingIds.add(id);mapping.set(p.id,id);}
  const order=config.knobOrder||[1,2,3],source=pack.knobOrder;
  const imported=add.map(p=>{
    const next=clone(p);next.id=mapping.get(p.id);next.matchProcess='';
    for(const group of [1,2,3]){
      const bindings={};
      for(const [control,action] of Object.entries(next.layers[group])){
        let target=control;
        if(control.startsWith('knob')){const n=Number(control[4]),position=source.indexOf(n);if(position===1)continue;target=`knob${order[position]}.${control.split('.')[1]}`;}
        visit(action,a=>{delete a.hotkey;if(a.type==='profile'||(a.type==='page'&&a.pageOperation==='select')){if(a.profileId==='@onboard')return;const mapped=mapping.get(a.profileId);if(mapped)a.profileId=mapped;else throw new Error(`${p.name}: 이동 대상 페이지도 함께 선택하세요.`);}});
        bindings[target]=action;
      }
      next.layers[group]=bindings;
    }
    next.bindings=next.layers[3];return next;
  });
  // Validate the addition, then preserve every existing object and setting verbatim.
  validateConfig({...config,profiles:[...config.profiles,...imported]});
  return {config:{...config,profiles:[...config.profiles,...imported]},added:imported.map(p=>({id:p.id,name:p.name})),skipped:selected.length-imported.length};
}
function exportPack(config,ids){
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>!config.profiles.some(p=>p.id===id)))throw new Error('내보낼 페이지를 선택하세요.');
  return {format:FORMAT,version:1,name:'MONO DECK PC 프리셋',description:'기존 페이지 뒤에 추가됩니다. 오른쪽 위 노브는 대상 PC의 공통 페이지 전환을 따릅니다.',knobOrder:config.knobOrder||[1,2,3],profiles:clone(config.profiles.filter(p=>ids.includes(p.id)))};
}
module.exports={parsePack,previewPack,mergePack,exportPack,FORMAT};
