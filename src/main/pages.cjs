const operations=['next','previous','select','previewNext','previewPrevious','confirm','cancel'];
const ONBOARD_ID='@onboard';
function defaultCommonBindings(knob=2){
  return Object.fromEntries([['ccw','previewPrevious','이전 페이지 후보'],['cw','previewNext','다음 페이지 후보'],['press','confirm','페이지 선택 확정']].map(([direction,pageOperation,label])=>[`knob${knob}.${direction}`,{type:'page',pageOperation,label,icon:'layers',color:'#c4f46d'}]));
}
function resolveBindings(config,profile,layer){return {...config.commonBindings,...(profile?.layers?.[layer]||(layer===3?profile?.bindings:{}))};}
function deletionTarget(config,id){
  const index=config.profiles.findIndex(p=>p.id===id);
  if(id===ONBOARD_ID)throw new Error('0번 기기 프리셋은 삭제할 수 없습니다.');
  if(index<0)throw new Error('삭제할 PC 페이지를 찾을 수 없습니다.');
  if(config.profiles.length<2)throw new Error('PC 페이지는 최소 1개를 남겨두세요.');
  return {index,profile:config.profiles[index]};
}
const pointsToPage=(action,id)=>!!action&&(action.type==='profile'||(action.type==='page'&&action.pageOperation==='select'))&&action.profileId===id;
function previewProfileDeletion(config,id){
  const {profile}=deletionTarget(config,id);
  const references=[];
  const inspect=(bindings,owner)=>{
    const visit=(action,control,path=[])=>{
      if(pointsToPage(action,id))references.push({...owner,control,path,action});
      for(const field of ['steps','thenSteps','elseSteps'])for(const [index,step] of (action[field]||[]).entries())visit(step,control,[...path,{field,index}]);
    };
    for(const [control,action] of Object.entries(bindings||{}))visit(action,control);
  };
  inspect(config.commonBindings,{profileId:null,profileName:'공통 키',group:null});
  for(const p of config.profiles)if(p.id!==id)for(const group of [1,2,3])inspect(p.layers?.[group]||(group===3?p.bindings:{}),{profileId:p.id,profileName:p.name,group});
  const hash=require('node:crypto').createHash('sha256').update(JSON.stringify({profile,references})).digest('hex');
  return {id,name:profile.name,hash,references:references.map(({action,...reference})=>reference)};
}
function removeProfile(config,id,{detachReferences=false,expectedHash}={}){
  const {index,profile:target}=deletionTarget(config,id),review=previewProfileDeletion(config,id);
  if(expectedHash!==undefined&&expectedHash!==review.hash)throw new Error('삭제 대상이나 연결 설정이 변경되었습니다. 내용을 다시 확인해 주세요.');
  if(review.references.length&&!detachReferences)throw new Error('연결된 이동 액션을 확인한 뒤 함께 해제하고 삭제하세요.');
  // Replace only matching navigation nodes. Keep sibling macro steps, explicit
  // empty slots (which block common-key fallback), and unrelated objects intact.
  const cleanAction=action=>{
    if(pointsToPage(action,id))return {type:'none',label:'연결 해제됨',icon:'layers',color:action.color||'#c4f46d',comment:`삭제한 PC 페이지 ‘${target.name}’로 이동하던 액션입니다.`};
    let next=action;
    for(const field of ['steps','thenSteps','elseSteps'])if(action[field]){
      const steps=action[field].map(cleanAction);
      if(steps.some((step,i)=>step!==action[field][i]))next={...next,[field]:steps};
    }
    return next;
  };
  const cleanBindings=bindings=>{let next=bindings;for(const [control,action] of Object.entries(bindings||{})){const cleaned=cleanAction(action);if(cleaned!==action)next={...next,[control]:cleaned};}return next;};
  const profiles=config.profiles.filter(p=>p.id!==id).map(p=>{
    if(!p.layers){const bindings=cleanBindings(p.bindings);return bindings===p.bindings?p:{...p,bindings};}
    let layers=p.layers;
    for(const group of [1,2,3]){const before=p.layers[group]||(group===3?p.bindings:undefined),bindings=cleanBindings(before);if(bindings!==before)layers={...layers,[group]:bindings};}
    return layers===p.layers?p:{...p,layers,bindings:layers[3]};
  });
  return {...config,commonBindings:cleanBindings(config.commonBindings),profiles,activeProfile:config.activeProfile===id?profiles[Math.max(0,index-1)].id:config.activeProfile};
}
class PageNavigation {
  constructor(){this.candidate=null;}
  apply(config,operation,id){
    if(!operations.includes(operation))throw new Error('지원하지 않는 PC 페이지 이동입니다.');
    const ids=[...(config.includeOnboard?[ONBOARD_ID]:[]),...config.profiles.map(p=>p.id)];
    if(!ids.includes(this.candidate))this.candidate=null;
    if(operation==='cancel'){this.candidate=null;return null;}
    if(operation==='confirm'){const selected=this.candidate;this.candidate=null;return selected;}
    if(operation==='select'){if(!ids.includes(id))throw new Error('PC 페이지를 찾을 수 없습니다.');this.candidate=null;return id;}
    const preview=operation.startsWith('preview');
    const index=ids.indexOf(preview?(this.candidate||config.activeProfile):config.activeProfile);
    const next=ids[(index+(operation==='next'||operation==='previewNext'?1:-1)+ids.length)%ids.length];
    this.candidate=preview?next:null;return preview?null:next;
  }
  state(config,layer){return {activeId:config.activeProfile,candidateId:this.candidate,layer:layer||null,pages:config.profiles.map(p=>({id:p.id,name:p.name}))};}
}
module.exports={operations,defaultCommonBindings,resolveBindings,previewProfileDeletion,removeProfile,PageNavigation,ONBOARD_ID};
