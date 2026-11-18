const {controls}=require('./protocol.cjs');
const {operations,defaultCommonBindings}=require('./pages.cjs');
const allowed=new Set(['none','shortcut','text','url','app','media','sequence','profile','delay','key','mouse','repeat','condition','wait','stop','page','obs']);
function validateAction(a,depth=0,budget={count:0}) {
  if(!a||typeof a!=='object'||Array.isArray(a)||!allowed.has(a.type)||depth>5||++budget.count>500) throw new Error('매크로는 최대 500단계, 중첩 5단계까지 지원합니다.');
  if(depth>0&&a.type==='sequence'&&a.repeatMode==='toggle')throw new Error('다시 누를 때까지 반복은 매크로 전체 실행 방식에서만 지정할 수 있습니다.');
  const out={type:a.type,label:String(a.label||'').slice(0,80),icon:String(a.icon||'').slice(0,40),color:/^#[0-9a-fA-F]{6}$/.test(a.color)?a.color:'#c4f46d'};
  for(const key of ['text','url','path','media','profileId','key','comment','hotkey','process','titleContains','monitorId','obsOperation','inputRole']) if(a[key]!==undefined) {
    const max=key==='text'?20000:key==='comment'?1000:2048;
    if(typeof a[key]!=='string'||a[key].length>max) throw new Error(`${key} 값이 너무 크거나 잘못되었습니다.`);out[key]=a[key];
  }
  for(const key of ['keys','args']) if(a[key]!==undefined) {if(!Array.isArray(a[key])||a[key].length>32||a[key].some(x=>typeof x!=='string'||x.length>2048)) throw new Error('동작 인수가 잘못되었습니다.');out[key]=a[key];}
  const ranges={delayMs:[0,3600000],jitterMs:[0,60000],x:[-100000,100000],y:[-100000,100000],delta:[-120000,120000],clicks:[1,2],count:[1,10000],repeatCount:[1,10000],intervalMs:[0,60000],tolerance:[0,255],timeoutMs:[1,3600000],pollMs:[20,5000]};
  for(const [key,[min,max]] of Object.entries(ranges))if(a[key]!==undefined){if(!Number.isInteger(a[key])||a[key]<min||a[key]>max)throw new Error(`${key}: ${min}~${max} 범위의 정수여야 합니다.`);out[key]=a[key];}
  if(a.playbackSpeed!==undefined){if(typeof a.playbackSpeed!=='number'||!Number.isFinite(a.playbackSpeed)||a.playbackSpeed<0.1||a.playbackSpeed>10)throw new Error('실행 속도는 0.1~10배입니다.');out.playbackSpeed=a.playbackSpeed;}
  for(const [key,values] of Object.entries({pageOperation:operations,state:['down','up'],mouseAction:['move','click','down','up','scroll'],button:['left','right','middle'],condition:['pixel','window'],repeatMode:['count','toggle'],coordinateSpace:['desktop','monitor']}))if(a[key]!==undefined){if(!values.includes(a[key]))throw new Error(`${key} 값이 올바르지 않습니다.`);out[key]=a[key];}
  for(const key of ['relative','disabled'])if(a[key]!==undefined){if(typeof a[key]!=='boolean')throw new Error(`${key} 값은 true/false여야 합니다.`);out[key]=a[key];}
  if(a.pixelColor!==undefined){if(typeof a.pixelColor!=='string'||!/^#[0-9a-fA-F]{6}$/.test(a.pixelColor))throw new Error('픽셀 색상은 #RRGGBB 형식입니다.');out.pixelColor=a.pixelColor.toLowerCase();}
  for(const field of ['steps','thenSteps','elseSteps'])if(a[field]!==undefined){if(!Array.isArray(a[field])||a[field].length>500)throw new Error('매크로 단계는 배열이어야 합니다.');out[field]=a[field].map(x=>validateAction(x,depth+1,budget));}
  if(['sequence','repeat'].includes(a.type)&&!out.steps)out.steps=[];
  if(a.type==='key'&&(!out.key||!out.state))throw new Error('키와 누름/뗌을 지정하세요.');
  if(a.type==='mouse'&&!out.mouseAction)throw new Error('마우스 동작을 지정하세요.');
  if(a.type==='mouse'&&out.mouseAction==='move'&&(!Number.isInteger(out.x)||!Number.isInteger(out.y)))throw new Error('마우스 이동 좌표를 지정하세요.');
  if(['condition','wait'].includes(a.type)){
    if(!out.condition)throw new Error('확인할 조건을 선택하세요.');
    if(out.condition==='pixel'&&(!out.pixelColor||!Number.isInteger(out.x)||!Number.isInteger(out.y)))throw new Error('픽셀 좌표와 색상을 지정하세요.');
    if(out.condition==='window'&&!out.process&&!out.titleContains)throw new Error('프로세스 이름 또는 창 제목을 지정하세요.');
  }
  if(a.type==='page'&&(!out.pageOperation||(out.pageOperation==='select'&&!out.profileId)))throw new Error('PC 페이지 이동 방식과 대상을 지정하세요.');
  if(a.type==='obs'){
    if(!['scenePrevious','sceneNext','sceneConfirm','sceneSelect','sourceSelect','sourcePrevious','sourceNext','sourceStatus','volumeUp','volumeDown','mute','unmute','toggleMute','startRecord','stopRecord','pauseRecord','resumeRecord','saveReplay','studioToggle'].includes(out.obsOperation))throw new Error('OBS 동작을 선택하세요.');
    if(a.sceneIndex!==undefined){if(!Number.isInteger(a.sceneIndex)||a.sceneIndex<0||a.sceneIndex>999)throw new Error('OBS 장면 번호가 잘못되었습니다.');out.sceneIndex=a.sceneIndex;}
    if(out.obsOperation==='sceneSelect'&&out.sceneIndex===undefined)throw new Error('OBS 장면 번호를 지정하세요.');
    if(out.inputRole&&!['volume','microphone','selected'].includes(out.inputRole))throw new Error('OBS 오디오 대상을 선택하세요.');
    if(a.audioIndex!==undefined){if(!Number.isInteger(a.audioIndex)||a.audioIndex<0||a.audioIndex>14)throw new Error('오디오 소스 번호는 1~15입니다.');out.audioIndex=a.audioIndex;}
    if(out.obsOperation==='sourceSelect'&&out.audioIndex===undefined)throw new Error('오디오 소스 번호를 지정하세요.');
    if(a.volumeStepDb!==undefined){if(![0.1,0.5,1,2].includes(a.volumeStepDb))throw new Error('볼륨 간격은 0.1 / 0.5 / 1 / 2 dB입니다.');out.volumeStepDb=a.volumeStepDb;}
  }
  return out;
}
function validateConfig(c){
  if(!c||c.version!==1||!Array.isArray(c.profiles)||c.profiles.length<1||c.profiles.length>50)throw new Error('지원하지 않는 프로필 파일입니다.');
  const seen=new Set();
  const profiles=c.profiles.map(p=>{
    if(typeof p.id!=='string'||p.id==='@onboard'||p.id.length>100||seen.has(p.id)||typeof p.name!=='string'||!p.name.trim())throw new Error('프로필 이름/ID가 잘못되었습니다.');seen.add(p.id);
    const layers={};
    for(const layer of [1,2,3]){const source=p.layers?.[layer]||(layer===3?p.bindings:{});const bindings={};for(const control of controls)if(source?.[control])bindings[control]=validateAction(source[control]);layers[layer]=bindings;}
    return {id:p.id,name:p.name.slice(0,50),matchProcess:String(p.matchProcess||'').slice(0,100),bindings:layers[3],layers,...(p.presetId?{presetId:String(p.presetId).slice(0,120)}:{}),...(p.description?{description:String(p.description).slice(0,2000)}:{})};
  });
  if(!seen.has(c.activeProfile)) throw new Error('선택한 프로필이 없습니다.');
  const knobOrder=Array.isArray(c.knobOrder)&&c.knobOrder.length===3&&[...c.knobOrder].sort().join(',')==='1,2,3'?[...c.knobOrder]:[1,2,3];
  const commonBindings={};
  const common=c.commonBindings===undefined?defaultCommonBindings(knobOrder[1]):c.commonBindings;
  if(!common||typeof common!=='object'||Array.isArray(common))throw new Error('공통 키 설정이 올바르지 않습니다.');
  for(const control of controls)if(common[control])commonBindings[control]=validateAction(common[control]);
  return {version:1,schemaRevision:3,commonBindings,pageMode:c.pageMode==='onboard'?'onboard':'pc',pageHotkeys:c.pageHotkeys!==false,selectedLayer:[1,2,3].includes(c.selectedLayer)?c.selectedLayer:3,activeProfile:c.activeProfile,enabled:c.enabled===true,startAtLogin:c.startAtLogin===true,knobOrder,knobDirection:Object.fromEntries([1,2,3].map(n=>[`knob${n}`,c.knobDirection?.[`knob${n}`]===true])),profiles};
}
const shortcut=(label,keys,icon='Keyboard',color='#c4f46d')=>({type:'shortcut',label,keys,icon,color});
const media=(label,key,icon)=>({type:'media',label,media:key,icon,color:'#a9b9ff'});
function defaults(){
  const result={version:1,activeProfile:'everyday',enabled:true,startAtLogin:false,profiles:[
    {id:'everyday',name:'Everyday',matchProcess:'',bindings:{
      key1:shortcut('복사',['CTRL','C'],'Copy'),key2:shortcut('붙여넣기',['CTRL','V'],'ClipboardPaste'),key3:shortcut('잘라내기',['CTRL','X'],'Scissors'),key4:shortcut('실행 취소',['CTRL','Z'],'Undo2'),key5:shortcut('다시 실행',['CTRL','Y'],'Redo2'),
      key6:shortcut('전체 선택',['CTRL','A'],'MousePointer2'),key7:shortcut('저장',['CTRL','S'],'Save'),key8:shortcut('검색',['CTRL','F'],'Search'),key9:shortcut('새 탭',['CTRL','T'],'Plus'),key10:shortcut('탭 닫기',['CTRL','W'],'X'),
      key11:shortcut('화면 캡처',['WIN','SHIFT','S'],'Scan'),key12:shortcut('작업 보기',['WIN','TAB'],'LayoutGrid'),key13:shortcut('이모지',['WIN','.'],'Smile'),key14:{type:'app',label:'탐색기',path:'explorer.exe',icon:'FolderOpen',color:'#f0c67a'},key15:{type:'profile',label:'Creative',profileId:'creative',icon:'Palette',color:'#e6b6ff'},
      'knob1.ccw':media('이전 곡','previous','SkipBack'),'knob1.press':media('재생 / 정지','playPause','Play'),'knob1.cw':media('다음 곡','next','SkipForward'),
      'knob2.ccw':shortcut('축소',['CTRL','-'],'ZoomOut'),'knob2.press':shortcut('100%',['CTRL','0'],'Maximize'),'knob2.cw':shortcut('확대',['CTRL','+'],'ZoomIn'),
      'knob3.ccw':media('볼륨 −','volumeDown','Volume1'),'knob3.press':media('음소거','mute','VolumeX'),'knob3.cw':media('볼륨 +','volumeUp','Volume2')
    }},
    {id:'creative',name:'Creative',matchProcess:'Photoshop',bindings:{key1:shortcut('브러시',['B'],'Paintbrush'),key2:shortcut('지우개',['E'],'Eraser'),key3:shortcut('이동',['V'],'Move'),key4:shortcut('실행 취소',['CTRL','Z'],'Undo2'),key5:shortcut('저장',['CTRL','S'],'Save'),key6:shortcut('새 레이어',['CTRL','SHIFT','N'],'Layers'),key7:shortcut('선택 해제',['CTRL','D'],'SquareDashed'),key15:{type:'profile',label:'Everyday',profileId:'everyday',icon:'Home',color:'#c4f46d'},'knob1.ccw':shortcut('브러시 작게',['['],'Minus'),'knob1.press':shortcut('색상 전환',['X'],'Palette'),'knob1.cw':shortcut('브러시 크게',[']'],'Plus'),'knob2.ccw':shortcut('축소',['CTRL','-'],'ZoomOut'),'knob2.press':shortcut('화면 맞춤',['CTRL','0'],'Maximize'),'knob2.cw':shortcut('확대',['CTRL','+'],'ZoomIn'),'knob3.ccw':media('볼륨 −','volumeDown','Volume1'),'knob3.press':media('음소거','mute','VolumeX'),'knob3.cw':media('볼륨 +','volumeUp','Volume2')}}
  ]};
  for(const p of result.profiles)for(const direction of ['ccw','cw','press'])delete p.bindings[`knob2.${direction}`];
  return result;
}
module.exports={validateAction,validateConfig,defaults};
