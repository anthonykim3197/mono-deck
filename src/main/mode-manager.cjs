// Durable portable page-zero presets. Page navigation never calls the HID writer;
// activate/applyPreset are reserved for explicit device preparation or upload.
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {controls,mappingPacket,validateReports,fingerprint}=require('./protocol.cjs');
const {planOnboard,isAppManaged,decodeReports}=require('./onboard.cjs');
const {defaultCommonBindings}=require('./pages.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const equal=(a,b)=>a&&b&&Buffer.from(a).subarray(2).equals(Buffer.from(b).subarray(2));
const asRead=r=>{const value=[...r];value[1]=0xfa;return value;};
const matches=(actual,expected)=>expected.length===24&&expected.every(r=>equal(r,actual.find(a=>a[3]===r[3]&&a[2]===r[2])));
class ModeManager{
  constructor({keyboard,directory,getConfig,onChange=()=>{},beforeSwitch=async()=>{}}){
    Object.assign(this,{keyboard,directory,getConfig,onChange,beforeSwitch});
    this.groups={};this.transition=null;this.error=null;this.store=null;this.file=null;this.operation=null;
  }
  navControls(){return Object.keys(defaultCommonBindings(this.getConfig().knobOrder?.[1]||2));}
  navReports(layer){return this.navControls().map(control=>asRead(mappingPacket(controls.indexOf(control)+1,layer)));}
  withNavigation(reports,layer){const nav=this.navReports(layer);return reports.map(r=>nav.find(n=>n[2]===r[2])||(isAppManaged(r)?asRead(planOnboard([{layer,control:controls[r[2]-1],action:{type:'none'}}]).entries[0].report):r));}
  persist(){
    fs.mkdirSync(this.directory,{recursive:true});
    const data={...this.store};delete data.sha256;data.sha256=createHash('sha256').update(JSON.stringify(data)).digest('hex');
    fs.writeFileSync(this.file+'.tmp',JSON.stringify(data,null,2));fs.renameSync(this.file+'.tmp',this.file);
  }
  load(){
    const serial=this.keyboard.status.serial;if(!serial)throw new Error('기기 일련번호를 확인할 수 없습니다.');
    if(this.store?.serial===serial)return;
    this.store=null;
    this.file=path.join(this.directory,`onboard-${createHash('sha256').update(serial).digest('hex').slice(0,20)}.json`);
    if(fs.existsSync(this.file)){
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'));const hash=data.sha256;delete data.sha256;
      if(data.version!==1||data.serial!==serial||createHash('sha256').update(JSON.stringify(data)).digest('hex')!==hash)throw new Error('온보드 보관 파일 검증 실패. 원본 파일을 보존했습니다: '+this.file);
      for(const layer of [1,2,3])validateReports(data.banks[layer].reports,[layer]);
      this.store=data;
    }else{
      validateReports(this.keyboard.lastReports);
      const banks={};
      for(const layer of [1,2,3]){
        // App triggers are not portable actions. Save direct device bindings and
        // represent app-only slots as empty, keeping the common navigation knob.
        const reports=this.keyboard.lastReports.filter(r=>r[3]===layer).map(r=>isAppManaged(r)?asRead(planOnboard([{layer,control:controls[r[2]-1],action:{type:'none'}}]).entries[0].report):[...r]);
        banks[layer]={reports:this.withNavigation(reports,layer),source:'device',savedAt:new Date().toISOString()};
      }
      this.store={version:1,serial,banks,pending:null};this.persist();
    }
  }
  sync(){
    if(this.transition)return;
    if(!this.keyboard.status.connected||this.keyboard.status.error){this.groups={};return;}
    try{
      if(!this.keyboard.lastReports)return;
      this.load();
      const actual=this.keyboard.lastReports;
      // A crash after a successful device write but before the final save is
      // resolved by readback, never by an automatic replay of the write.
      const pending=this.store.pending;
      if(pending&&matches(actual,pending.expected)){
        if(pending.nextBank)this.store.banks[pending.layer]=pending.nextBank;
        this.store.pending=null;this.persist();
      }
      else if(pending)this.error='이전 모드 전환이 완료되지 않았습니다. 기기에 기록 또는 PC 연결 준비를 다시 실행해 복구하세요. 백업: '+pending.backupPath;
      this.groups=Object.fromEntries([1,2,3].map(layer=>{
        const bank=this.withNavigation(this.store.banks[layer].reports,layer);
        const pc=controls.map((_,i)=>asRead(mappingPacket(i+1,layer)));
        const mode=matches(actual,pc)?'pc':matches(actual,bank)?'onboard':'mixed';
        const portable=decodeReports(bank,[layer]).filter(row=>!row.appManaged&&!['empty','none'].includes(row.kind));
        return [layer,{mode,storedCount:portable.length,savedAt:this.store.banks[layer].savedAt}];
      }));
      if(!this.store.pending)this.error=null;
    }catch(error){this.error=error.message;this.groups={};}
  }
  state(){return {groups:clone(this.groups),transition:this.transition?{...this.transition}:null,error:this.error};}
  assertIdle(){if(this.transition||this.operation||this.keyboard.busy)throw new Error('기기 작업 또는 모드 전환 중입니다. 검증이 끝날 때까지 기다리세요.');}
  bank(layer){this.load();return this.withNavigation(clone(this.store.banks[layer].reports),layer);}
  presetBindings(layer){return Object.fromEntries(decodeReports(this.bank(layer),[layer]).filter(row=>!row.appManaged&&row.editable&&row.action).map(row=>[row.control,row.action]));}
  bankHash(layer){return createHash('sha256').update(JSON.stringify(this.bank(layer))).digest('hex');}
  preparePreset(entries,options){
    this.assertIdle();const plan=this.plan(entries);
    if(!plan.ok||!plan.entries.length)throw new Error('0번은 기기에서 실행 가능한 단축키·미디어·최대 18개 키 조합만 저장할 수 있습니다. '+plan.incompatible.map(e=>e.reason).join(' '));
    if(plan.hash!==options?.expectedHash)throw new Error('검토 내용이 바뀌었습니다. 다시 검토하세요.');
    const layers=[...new Set(entries.map(e=>e.layer))];if(layers.length!==1)throw new Error('0번 프리셋은 기기 그룹 하나씩 저장하세요.');
    const layer=layers[0];const reports=this.bank(layer).map(r=>asRead(plan.entries.find(e=>e.report[2]===r[2])?.report||r));
    return {layer,nextBank:{reports:this.withNavigation(reports,layer),source:'edited',savedAt:new Date().toISOString()}};
  }
  savePreset(entries,options){
    const {layer,nextBank}=this.preparePreset(entries,options);
    if(this.store.pending)throw new Error('이전 기기 기록을 먼저 복구하세요. 0번 원본을 유지했습니다.');
    const previous=this.store.banks[layer];this.store.banks[layer]=nextBank;
    try{this.persist();}catch(error){this.store.banks[layer]=previous;throw error;}
    this.sync();this.onChange();
    return {ok:true,message:`그룹 ${layer}의 0번 프리셋을 PC에 저장했습니다. 기기에는 기록하지 않았습니다.`};
  }
  applyPreset(layer,expectedHash){
    this.assertIdle();if(![1,2,3].includes(layer))throw new Error('기기 그룹을 선택하세요.');
    if(this.bankHash(layer)!==expectedHash)throw new Error('0번 내용이 바뀌었습니다. 다시 검토하세요.');
    return this.activate('onboard',layer);
  }
  async capturePreset(layer){
    this.assertIdle();if(![1,2,3].includes(layer))throw new Error('기기 그룹을 선택하세요.');
    await this.keyboard.readOnboard();this.sync();this.load();
    if(this.store.pending)throw new Error('이전 기기 기록을 먼저 복구하세요.');
    const actual=this.keyboard.lastReports.filter(r=>r[3]===layer);
    const nav=new Set(this.navReports(layer).map(r=>r[2]));
    const direct=actual.filter(r=>!nav.has(r[2])&&!isAppManaged(r));
    if(!direct.length)throw new Error('현재 기기에는 앱 연결 신호만 있습니다. 보관된 0번 내용을 유지했습니다.');
    const reports=this.bank(layer).map(r=>direct.find(a=>a[2]===r[2])||r);
    const previous=this.store.banks[layer];this.store.banks[layer]={reports,source:'device',savedAt:new Date().toISOString()};
    try{this.persist();}catch(error){this.store.banks[layer]=previous;throw error;}
    this.sync();this.onChange();return {ok:true,message:`기기 그룹 ${layer}의 직접 입력 ${direct.length}개를 0번에 가져왔습니다. 앱 연결 슬롯의 기존 0번 내용은 유지했습니다.`};
  }
  plan(entries){
    const plan=planOnboard(entries),reserved=new Set(this.navControls());
    const blocked=plan.entries.filter(e=>reserved.has(e.control));
    if(blocked.length){plan.entries=plan.entries.filter(e=>!reserved.has(e.control));plan.incompatible.push(...blocked.map(e=>({layer:e.layer,control:e.control,reason:'이 노브는 온보드 0과 모든 PC 페이지에서 공통 전환용으로 유지됩니다.'})));plan.ok=false;}
    return plan;
  }
  async saveOnboard(entries,options){
    const {layer,nextBank}=this.preparePreset(entries,options);
    return this.activate('onboard',layer,nextBank);
  }
  activate(mode,layer,nextBank){
    this.assertIdle();
    if(!['pc','onboard'].includes(mode)||![1,2,3].includes(layer))return Promise.reject(new Error('전환 노브를 한 번 돌려 기기 그룹을 먼저 확인하세요.'));
    if(!this.keyboard.status.connected)return Promise.reject(new Error('키보드를 연결하세요.'));
    this.load();
    if(!nextBank&&this.groups[layer]?.mode===mode)return Promise.resolve({ok:true,message:'이미 선택한 모드입니다.'});
    const expected=mode==='pc'?controls.map((_,i)=>asRead(mappingPacket(i+1,layer))):this.withNavigation(clone(nextBank?.reports||this.bank(layer)),layer);
    this.transition={layer,targetMode:mode,phase:'preparing',done:0,total:24,startedAt:new Date().toISOString()};this.error=null;this.onChange();
    this.operation=(async()=>{
      try{
        await this.beforeSwitch();
        const result=await this.keyboard.writeSelectedMappings(expected,mode==='pc'?'app':'onboard',{
          beforeWrite:({before,backupPath,serial})=>{
            if(serial!==this.store.serial)throw new Error('전환 중 기기가 바뀌었습니다.');
            const projected=before.map(r=>expected.find(e=>e[2]===r[2]&&e[3]===r[3])||r);
            const occurrences=new Map();
            for(const r of projected){if(r[4]!==1||r[10]>18)continue;for(let i=0;i<r[10];i++){const one=[...r];one[10]=1;one[11]=r[11+i*2];one[12]=r[12+i*2];const f=fingerprint(one);if(f)occurrences.set(f,(occurrences.get(f)||0)+1);}}
            if(this.navReports(layer).some(r=>occurrences.get(fingerprint(r))!==1))throw new Error('공통 전환 노브와 충돌하는 기기 입력이 있습니다. 충돌하는 키 설정을 먼저 변경하세요.');
            this.store.pending={layer,mode,expected,nextBank:nextBank||null,backupPath,startedAt:this.transition.startedAt};this.persist();
          },
          onProgress:progress=>{Object.assign(this.transition,progress);this.onChange();}
        });
        if(nextBank)this.store.banks[layer]=nextBank;
        this.store.pending=null;this.persist();
        return {...result,message:`기기 그룹 ${layer} · ${mode==='onboard'?'온보드 0':'PC 모드'} 전환 완료`};
      }catch(error){this.error=error.message;this.groups=Object.fromEntries([1,2,3].map(group=>[group,{...this.groups[group],mode:'unknown'}]));throw error;}
      finally{
        const error=this.error;this.transition=null;this.operation=null;
        if(!error)this.sync();this.onChange();
      }
    })();
    return this.operation;
  }
}
module.exports={ModeManager,matches};
