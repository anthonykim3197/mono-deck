const {validateAction}=require('./config.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class Cancelled extends Error { constructor(message='매크로를 중지했습니다.'){super(message);this.name='Cancelled';} }
function describe(a){
  switch(a.type){
    case 'shortcut':return (a.keys||[]).join(' + ');
    case 'key':return `${a.key} ${a.state}`;
    case 'mouse':return `${a.mouseAction} ${a.button||''} ${a.x??''},${a.y??''}${a.relative?' 상대 이동':''}${a.monitorId?' · '+a.monitorId:''}`;
    case 'delay':return `${a.delayMs||0} ms${a.jitterMs?' ± '+a.jitterMs+' ms':''}`;
    case 'text':return `${(a.text||'').length}자 입력`;
    case 'sequence':return a.repeatMode==='toggle'?'다시 누르거나 긴급 중지할 때까지 반복':`${a.repeatCount||1}회 실행`;
    case 'repeat':return `${a.count||1}회 반복`;
    case 'condition':case 'wait':return a.condition==='pixel'?`픽셀 ${a.x},${a.y} ${a.pixelColor}`:`창 ${a.process||a.titleContains}`;
    default:return a.label||a.type;
  }
}
function buildPlan(action){
  const plan=[];
  const visit=(a,p)=>{if(a.disabled)return;plan.push({step:plan.length+1,path:p,type:a.type,label:a.label,summary:describe(a)});for(const [i,s] of (a.steps||[]).entries())visit(s,`${p}.${i+1}`);for(const [i,s] of (a.thenSteps||[]).entries())visit(s,`${p}.참.${i+1}`);for(const [i,s] of (a.elseSteps||[]).entries())visit(s,`${p}.거짓.${i+1}`);};
  visit(action,'1');return plan;
}
function colorMatches(actual,expected,tolerance=0){
  if(!/^#[0-9a-f]{6}$/i.test(actual||'')||!/^#[0-9a-f]{6}$/i.test(expected||''))return false;
  return [1,3,5].every(i=>Math.abs(parseInt(actual.slice(i,i+2),16)-parseInt(expected.slice(i,i+2),16))<=tolerance);
}
class MacroRunner {
  constructor({bridge,isEditorFocused=()=>false,executeExternal=async()=>{},onEvent=()=>{},now=()=>Date.now(),sleep=pause,random=Math.random,blockedPid=process.pid}){
    Object.assign(this,{bridge,isEditorFocused,executeExternal,onEvent,now,sleep,random,blockedPid});this.queue=[];this.current=null;this.serial=0;this.state={status:'idle',running:false,step:0,total:0,queued:0};
  }
  emit(status,job,extra={}){this.state={type:'macro',status,running:status==='running',label:job?.action.label||'',source:job?.source||'',step:job?.step||0,total:job?.plan.length||0,iteration:job?.iteration||0,dryRun:job?.dryRun||false,queued:this.queue.length,...extra};this.onEvent(this.state);}
  async stop(message='매크로를 중지했습니다.'){
    if(this.current){this.current.cancelled=true;this.current.cancelMessage=message;}
    for(const job of this.queue.splice(0))job.resolve({ok:false,cancelled:true,error:message});
    try{if(this.bridge.ready!==false)await this.bridge.request('releaseAll');}catch{}
    this.emit('stopped',this.current,{message});return {ok:true};
  }
  run(input,options={}){
    let action;try{action=validateAction(input);}catch(e){return Promise.resolve({ok:false,error:e.message});}
    // Planning never enters the live queue, resumes the native latch, or handles
    // stop/toggle controls; it remains side-effect free during a running macro.
    if(options.dryRun===true)return Promise.resolve({ok:true,plan:buildPlan(action),message:'입력을 보내지 않고 실행 계획만 확인했습니다.'});
    if(action.type==='stop')return this.stop();
    if(action.repeatMode==='toggle'&&options.source&&this.current?.source===options.source){return this.stop('같은 키를 다시 눌러 반복을 중지했습니다.');}
    if(this.current?.action.repeatMode==='toggle')return Promise.resolve({ok:false,error:'반복 매크로가 실행 중입니다. 먼저 중지하세요.'});
    if(this.queue.length>=32)return Promise.resolve({ok:false,error:'동작 대기열이 가득 찼습니다.'});
    return new Promise(resolve=>{this.queue.push({id:++this.serial,action,plan:buildPlan(action),source:options.source||'',allowEditor:options.allowEditor===true,outputGuard:options.outputGuard||{},targetAllowed:options.targetAllowed,dryRun:options.dryRun===true,delayBeforeMs:options.delayBeforeMs||0,resolve,cancelled:false,step:0,iteration:0,started:this.now(),speed:action.playbackSpeed||1});this.pump();});
  }
  async pump(){
    if(this.current)return;
    const job=this.queue.shift();if(!job)return;this.current=job;this.emit('running',job,{message:job.dryRun?'실행 계획 확인 중':'매크로 실행 중'});
    let result;
    try{
        if(job.delayBeforeMs)await this.delay(job.delayBeforeMs,job,true);
        this.check(job);await this.bridge.request('resume');this.check(job);
        await this.execute(job.action,job,'1');this.check(job);
        result={ok:true,message:'매크로 실행 완료'};
    }catch(e){result={ok:false,cancelled:e instanceof Cancelled,error:e.message};}
    finally{
      try{await this.bridge.request('releaseAll');}catch{}
      this.current=null;
      this.emit(result.ok?'completed':result.cancelled?'stopped':'error',job,{message:result.message||result.error});
      job.resolve(result);this.pump();
    }
  }
  check(job,ignoreFocus=false){
    if(job.cancelled)throw new Cancelled(job.cancelMessage);
    if(job.targetAllowed&&!job.targetAllowed())throw new Cancelled('테스트 창에서 포커스가 벗어나 실행을 중지했습니다.');
    if(!ignoreFocus&&!job.allowEditor&&this.isEditorFocused())throw new Cancelled('편집창으로 전환되어 동작을 중지했습니다.');
  }
  async delay(ms,job,ignoreFocus=false){const end=this.now()+ms;while(this.now()<end){this.check(job,ignoreFocus);await this.sleep(Math.min(25,end-this.now()));}this.check(job,ignoreFocus);}
  async point(a){
    if(a.coordinateSpace!=='monitor'||a.relative)return {x:a.x,y:a.y};
    if(!a.monitorId)throw new Error('대상 모니터를 선택하세요.');
    const {monitors}=await this.bridge.request('monitors');const monitor=monitors.find(m=>m.id===a.monitorId);
    if(!monitor)throw new Error(`모니터를 찾을 수 없습니다: ${a.monitorId}`);
    if(!Number.isInteger(a.x)||!Number.isInteger(a.y)||a.x<0||a.y<0||a.x>=monitor.width||a.y>=monitor.height)throw new Error('선택한 모니터의 범위를 벗어난 좌표입니다.');
    return {x:monitor.left+a.x,y:monitor.top+a.y};
  }
  async condition(a,job){
    this.check(job);
    if(a.condition==='window'){const f=await this.bridge.request('foreground');this.check(job);const normalize=s=>String(s||'').toLowerCase().replace(/\.exe$/,'');return (!a.process||normalize(f.process)===normalize(a.process))&&(!a.titleContains||String(f.title||'').toLowerCase().includes(a.titleContains.toLowerCase()));}
    const p=await this.point(a);this.check(job);const v=await this.bridge.request('pixel',p);this.check(job);return colorMatches(v.color,a.pixelColor,a.tolerance||0);
  }
  async execute(a,job,p){
    this.check(job);if(a.disabled)return;
    if(a.delayMs||a.jitterMs){const jitter=a.jitterMs?Math.round((this.random()*2-1)*a.jitterMs):0;await this.delay(Math.max(0,(a.delayMs||0)+jitter)/job.speed,job);}
    this.check(job);job.step++;this.emit('running',job,{path:p,message:`${a.label||a.type} · ${describe(a)}`});
    const guard={...(job.allowEditor?{}:{blockedForegroundPid:this.blockedPid}),...job.outputGuard};
    switch(a.type){
      case 'none':case 'delay':return;
      case 'stop':throw new Cancelled();
      case 'shortcut':return this.bridge.request('shortcut',{keys:a.keys||[],...guard});
      case 'text':return this.bridge.request('text',{text:a.text||'',...guard});
      case 'key':return this.bridge.request('key',{key:a.key,state:a.state,...guard});
      case 'media':return this.bridge.request('media',{key:a.media||'playPause',...guard});
      case 'mouse':{const point=Number.isInteger(a.x)&&Number.isInteger(a.y)?await this.point(a):{};this.check(job);return this.bridge.request('mouse',{action:a.mouseAction,...point,relative:a.relative===true,button:a.button||'left',clicks:a.clicks||1,delta:a.delta??120,...guard});}
      case 'wait':{const deadline=this.now()+(a.timeoutMs||10000);while(!(await this.condition(a,job))){if(this.now()>=deadline)throw new Error('조건 대기 시간이 초과되었습니다.');await this.delay(Math.min(a.pollMs||100,Math.max(1,deadline-this.now())),job);}return;}
      case 'condition':{const branch=await this.condition(a,job)?a.thenSteps:a.elseSteps;for(const [i,step] of (branch||[]).entries())await this.execute(step,job,`${p}.${i+1}`);return;}
      case 'sequence':case 'repeat':{
        const toggle=a.type==='sequence'&&a.repeatMode==='toggle';const count=a.type==='repeat'?(a.count||1):(a.repeatCount||1);
        for(let iteration=0;toggle||iteration<count;iteration++){
          this.check(job);job.iteration=iteration+1;
          for(const [i,step] of (a.steps||[]).entries())await this.execute(step,job,`${p}.${i+1}`);
          if(toggle||iteration+1<count)await this.delay(Math.max(toggle?20:1,a.intervalMs||0)/job.speed,job);
        }return;
      }
      default:return this.executeExternal(a,job);
    }
  }
}
module.exports={MacroRunner,Cancelled,buildPlan,colorMatches};
