const HID = require('node-hid');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const VID = 0x1189, PID = 0x8840;
const controls = [...Array.from({ length: 15 }, (_, i) => `key${i + 1}`), ...[1,2,3].flatMap(i => [`knob${i}.ccw`, `knob${i}.press`, `knob${i}.cw`])];
const lightingModes = Object.freeze(['off','backlight','shock','shock2','press']);
const lightingColors = Object.freeze(['white','red','orange','yellow','green','cyan','blue','purple']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function packet(bytes) {
  if (bytes.length > 65 || bytes.some(x => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error('Invalid HID packet');
  const result = Buffer.alloc(65); Buffer.from(bytes).copy(result); return result;
}
function mappingPacket(id, layer = 3) {
  if (!Number.isInteger(id) || id < 1 || id > 24 || ![1,2,3].includes(layer)) throw new Error('Invalid control/layer');
  const modifiers = {1:1,2:5,3:0}[layer] | (id > 12 ? 2 : 0);
  return packet([3,0xfe,id,layer,1,0,0,0,0,0,1,modifiers,0x68 + ((id - 1) % 12)]);
}
function validateLayers(layers) {
  if (!Array.isArray(layers) || !layers.length || layers.some(layer => ![1,2,3].includes(layer)) || new Set(layers).size !== layers.length) throw new Error('레이어는 1, 2, 3 중 하나 이상을 중복 없이 선택하세요.');
  return [...layers].sort((a,b)=>a-b);
}
function lightingPacket(options) {
  if (!options || typeof options!=='object' || Array.isArray(options) || Object.keys(options).some(key=>!['layer','mode','color'].includes(key))) throw new Error('지원하는 조명 설정은 레이어, 패턴, 색상입니다.');
  const {layer,mode,color='cyan'}=options;
  if (![1,2,3].includes(layer) || !lightingModes.includes(mode) || !lightingColors.includes(color)) throw new Error('올바른 레이어, 조명 패턴과 색상을 선택하세요.');
  if (color==='white' && !['off','backlight'].includes(mode)) throw new Error('흰색은 상시 켜짐 패턴에서만 지원합니다.');
  const code=mode==='off'?0:mode==='backlight'&&color==='white'?5:(lightingColors.indexOf(color)<<4)|lightingModes.indexOf(mode);
  // 884x vendor FE B0 family; the code belongs at report offset 12.
  return packet([3,0xfe,0xb0,layer,8,0,0,0,0,0,1,0,code]);
}
function fingerprint(report) {
  if ((!Array.isArray(report) && !Buffer.isBuffer(report)) || report.length !== 65 || !Number.isInteger(report[11]) || report[11] < 0 || report[11] > 255 || !Number.isInteger(report[12])) return null;
  if (report[4] !== 1 || report[10] !== 1 || report[12] < 0x68 || report[12] > 0x73) return null;
  const m = report[11];
  const mods = []; if (m & 0x11) mods.push('CTRL'); if (m & 0x22) mods.push('SHIFT'); if (m & 0x44) mods.push('ALT'); if (m & 0x88) mods.push('WIN');
  return [...mods, `F${report[12] - 0x68 + 13}`].join('+');
}
function validateReports(reports, layers = [1,2,3]) {
  validateLayers(layers);
  if (!Array.isArray(reports) || reports.length !== 24 * layers.length) throw new Error('키·노브 응답 개수가 맞지 않습니다. 장치에는 쓰지 않았습니다.');
  const seen = new Set();
  for (const r of reports) {
    if (!Array.isArray(r) || r.length !== 65 || r.some(x => !Number.isInteger(x) || x < 0 || x > 255) || r[0] !== 3 || r[1] !== 0xfa || !layers.includes(r[3]) || r[2] < 1 || r[2] > 24) throw new Error('Invalid mapping report');
    const key = `${r[3]}:${r[2]}`; if (seen.has(key)) throw new Error('Duplicate mapping report'); seen.add(key);
  }
  return reports;
}
function checksum(reports) { return createHash('sha256').update(JSON.stringify(reports)).digest('hex'); }
class Keyboard {
  constructor(directory) { this.directory = directory; this.status = { connected:false, vid:'1189', pid:'8840', layer:3, layers:Object.fromEntries([1,2,3].map(layer=>[layer,{provisioned:false,mappedControls:0}])) }; this.inputMap = new Map(); this.busy = false; }
  async exclusive(work) {
    if (this.busy) throw new Error('장치 작업이 진행 중입니다. 잠시 후 다시 시도하세요.');
    this.busy = true;
    let handle;
    try {
      const candidates = (await HID.devicesAsync(VID,PID)).filter(d => d.usagePage === 0xff00 && d.usage === 1 && d.interface === 0);
      if (candidates.length !== 1) throw new Error(candidates.length ? '동일한 키보드가 여러 개 연결되어 있습니다. 하나만 연결하세요.' : '매크로 키보드가 연결되지 않았습니다.');
      const d = candidates[0]; handle = await HID.HIDAsync.open(d.path);
      const responses = await this.exchange(handle, [3,0xfb,0xfb,0xfb], 1);
      const info = responses.find(r => r[0] === 3 && r[1] === 0xfb);
      if (!info || info.length !== 65 || info[2] !== 15 || info[3] !== 3 || !Number.isInteger(info[4]) || info[4] < 0 || info[4] >= 10) throw new Error('지원하지 않는 장치/프로토콜입니다. 15키·3노브 구형 884x만 지원합니다.');
      this.status = { ...this.status, connected:true, product:'15-Key / 3-Knob Macro Pad', serial:d.serialNumber, path:d.path, firmware:`884x · kind ${info[4]}`, error:undefined };
      return await work(handle);
    } catch (e) { this.status.error = e.message; if (!handle) this.status.connected = false; throw e; }
    finally { try { if (handle) await handle.close(); } finally { this.busy = false; } }
  }
  async exchange(handle, bytes, count = 24) {
    const written=await handle.write(packet(bytes)); if(written!==65)throw new Error('HID 보고서를 완전히 보내지 못했습니다.'); const replies = [];
    const deadline = Date.now() + 2500;
    while (replies.length < count && Date.now() < deadline) {
      const data = await handle.read(replies.length ? 220 : 900);
      if (!data || !data.length) break;
      // Ignore acknowledgements left by a previous write.
      if (data[0] === 3 && data[1] === bytes[1]) replies.push([...data]);
    }
    return replies;
  }
  async read(handle, layers = [1,2,3]) {
    layers=validateLayers(layers);
    const reports = [];
    for (const layer of layers) reports.push(...await this.exchange(handle, [3,0xfa,15,3,layer]));
    validateReports(reports,layers); return reports.sort((a,b) => a[3]-b[3] || a[2]-b[2]);
  }
  updateMap(reports) {
    this.inputMap.clear(); const occurrences=new Map();
    // Raw Input identifies the emitted chord, not the originating slot. A
    // portable chord/sequence matching any reserved trigger makes it ambiguous.
    for (const r of reports) {
      if(r[4]!==1||r[10]>18)continue;
      for(let i=0;i<r[10];i++){
        const one=[...r];one[10]=1;one[11]=r[11+2*i];one[12]=r[12+2*i];
        const f=fingerprint(one);if(f)occurrences.set(f,(occurrences.get(f)||0)+1);
      }
    }
    for(const r of reports){
      const f=fingerprint(r);
      if(f&&occurrences.get(f)===1&&Buffer.from(r).subarray(2).equals(mappingPacket(r[2],r[3]).subarray(2)))this.inputMap.set(f,{control:controls[r[2]-1],layer:r[3]});
    }
    this.lastReports=reports.map(r=>[...r]);
    this.status.layers=Object.fromEntries([1,2,3].map(layer=>{
      const selected=reports.filter(r=>r[3]===layer);
      const mappedControls=[...this.inputMap.values()].filter(value=>value.layer===layer).length;
      const provisioned=selected.length===24 && mappedControls===24 && selected.every(r=>Buffer.from(r).subarray(2).equals(mappingPacket(r[2],layer).subarray(2)));
      return [layer,{provisioned,mappedControls}];
    }));
    this.status.totalMappedControls=this.inputMap.size;
    this.status.mappedControls=this.status.layers[3].mappedControls;
    this.status.provisioned=this.status.layers[3].provisioned;
  }
  async refresh() {
    try { await this.exclusive(async h=>this.updateMap(await this.read(h))); } catch {} return this.status;
  }
  saveBackup(reports) {
    validateReports(reports); fs.mkdirSync(this.directory,{recursive:true});
    const destination=path.join(this.directory,`mapping-${this.status.serial}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    const backup={format:'mono-deck-mapping',version:1,createdAt:new Date().toISOString(),device:{vid:VID,pid:PID,serial:this.status.serial},coverage:'Key/knob mappings only; timing, firmware and LEDs are not readable.',reports,sha256:checksum(reports)};
    fs.writeFileSync(destination,JSON.stringify(backup,null,2),{flag:'wx'}); return destination;
  }
  async backup() { return this.exclusive(async h=>({path:this.saveBackup(await this.read(h))})); }
  async readOnboard() {
    return this.exclusive(async handle=>{
      const reports=await this.read(handle);this.updateMap(reports);
      return {ok:true,slots:require('./onboard.cjs').decodeReports(reports),readAt:new Date().toISOString(),timingKnown:false,lightingKnown:false};
    });
  }
  async writeSelectedMappings(expected,mode,hooks={}) {
    // Only compiled mappings reach this helper; arbitrary raw reports are not a
    // public IPC contract. Every selected slot has its own exact verification.
    const {selection}=require('./onboard.cjs');
    selection(expected.map(r=>({layer:r[3],control:controls[r[2]-1]})));
    const chosen=new Set(expected.map(r=>`${r[3]}:${r[2]}`));
    return this.exclusive(async handle=>{
      hooks.onProgress?.({phase:'reading',done:0,total:expected.length});
      const before=await this.read(handle),backupPath=this.saveBackup(before);
      await hooks.beforeWrite?.({before,backupPath,serial:this.status.serial});
      // Do not dispatch stale app bindings while a slot changes ownership.
      for(const [key,value] of this.inputMap)if(chosen.has(`${value.layer}:${controls.indexOf(value.control)+1}`))this.inputMap.delete(key);
      try{
        const changed=expected.filter(r=>!Buffer.from(r).subarray(2).equals(Buffer.from(before.find(a=>a[3]===r[3]&&a[2]===r[2])).subarray(2)));
        await this.commit(handle,changed,(done,total)=>hooks.onProgress?.({phase:'writing',done,total}));
        hooks.onProgress?.({phase:'verifying',done:changed.length,total:changed.length});
        const after=await this.read(handle);this.updateMap(after);
        const observed=new Map(after.map(r=>[`${r[3]}:${r[2]}`,r]));
        const exact=expected.every(r=>{const a=observed.get(`${r[3]}:${r[2]}`);return a&&Buffer.from(r).subarray(2).equals(Buffer.from(a).subarray(2));});
        const unchanged=before.filter(r=>!chosen.has(`${r[3]}:${r[2]}`)).every(r=>JSON.stringify(r)===JSON.stringify(observed.get(`${r[3]}:${r[2]}`)));
        if(!exact||!unchanged)throw new Error('선택한 매핑 또는 나머지 슬롯의 읽기 검증이 실패했습니다.');
        return {ok:true,mode,path:backupPath,count:expected.length,slots:require('./onboard.cjs').decodeReports(after),status:this.status,message:`${expected.length}개 입력을 ${mode==='app'?'앱 연결':'기기 직접 실행'} 모드로 저장하고 72개 매핑을 검증했습니다.`};
      }catch(error){throw new Error(`${error.message} 매핑 백업: ${backupPath}. 자동 재시도하지 않습니다.`);}
    });
  }
  async uploadOnboard(entries,options={}) {
    const plan=require('./onboard.cjs').planOnboard(entries);
    if(!plan.ok)throw new Error(`기기에 저장할 수 없는 동작이 있습니다: ${plan.incompatible.map(e=>`${e.layer}/${e.control}: ${e.reason}`).join('; ')}`);
    if(typeof options.expectedHash!=='string'||options.expectedHash!==plan.hash)throw new Error('저장할 동작이 미리보기와 다릅니다. 다시 미리보기를 확인하세요.');
    return this.writeSelectedMappings(plan.entries.map(e=>e.report),'onboard');
  }
  async restoreAppSlots(entries) {
    const selected=require('./onboard.cjs').selection(entries);
    return this.writeSelectedMappings(selected.map(e=>[...mappingPacket(e.id,e.layer)]),'app');
  }
  async setLighting(options) {
    const bytes=lightingPacket(options); // Validate before any device access.
    const selection={layer:options.layer,mode:options.mode,color:options.mode==='off'?null:(options.color||'cyan')};
    return this.exclusive(async handle=>{
      // The same open session performs FB identity + FA reads before the LED write.
      // Those read commands are also the vendor's reported persistence preamble.
      const before=await this.read(handle), backupPath=this.saveBackup(before);
      for(const report of [bytes,packet([3,0xfd,0xfe,0xff])]) {
        if(await handle.write(report)!==65) throw new Error(`조명 보고서를 완전히 보내지 못했습니다. 키 매핑 백업: ${backupPath}`);
        await pause(30);
      }
      await pause(200);
      const after=await this.read(handle); this.updateMap(after);
      if(checksum(before)!==checksum(after)) throw new Error(`조명 설정 후 키 매핑이 달라졌습니다. 매핑 백업: ${backupPath}`);
      const lighting={...selection,code:bytes[12],sentAt:new Date().toISOString(),readbackVerified:false,persistenceVerified:false};
      this.status.lighting={...this.status.lighting,[selection.layer]:lighting};
      return {ok:true,path:backupPath,lighting,mappingsVerified:true,message:`${selection.layer}번 레이어 조명 명령을 전송했습니다. 키 매핑 72개는 유지되었습니다. 실제 조명은 기기에서 확인하세요.`};
    });
  }
  async commit(handle, reports,onProgress) {
    const send=async bytes=>{const count=await handle.write(packet(bytes));if(count!==65)throw new Error('HID 쓰기가 일부만 전달되었습니다. 백업에서 복원하세요.');};
    let completed=0;
    for (const report of reports) {
      const bytes=[...report]; bytes[1]=0xfe; await send(bytes); await pause(15);
      for (const end of [[3,0xaa,0xaa],[3,0xfd,0xfe,0xff],[3,0xaa,0xaa]]) { await send(end); await pause(30); }
      onProgress?.(++completed,reports.length);
    }
    await pause(120);
  }
  async provision(layers=[3]) {
    layers=validateLayers(layers);
    return this.exclusive(async handle=>{
      const original=await this.read(handle); const backupPath=this.saveBackup(original);
      const expected=layers.flatMap(layer=>controls.map((_,i)=>[...mappingPacket(i+1,layer)]));
      await this.commit(handle,expected);
      const after=await this.read(handle); this.updateMap(after);
      const unchanged=original.filter(r=>!layers.includes(r[3])).every(r=>JSON.stringify(r)===JSON.stringify(after.find(a=>a[3]===r[3]&&a[2]===r[2])));
      const exact=expected.every(r=>{const observed=after.find(a=>a[3]===r[3]&&a[2]===r[2]);return observed && Buffer.from(r).subarray(2).equals(Buffer.from(observed).subarray(2));});
      if (!exact || !unchanged) throw new Error(`장치 검증 실패. 매핑 백업: ${backupPath}. 자동 재시도하지 않습니다.`);
      return {ok:true,path:backupPath,layers,message:`${layers.join(', ')}번 레이어 ${expected.length}개 입력을 쓰고 다시 읽어 확인했습니다. 기기에서 사용할 레이어를 선택하세요.`};
    });
  }
  async restore(filePath,layers=[3]) {
    layers=validateLayers(layers);
    const backup=JSON.parse(fs.readFileSync(filePath,'utf8'));
    if (backup.format!=='mono-deck-mapping'||backup.version!==1||backup.device?.vid!==VID||backup.device?.pid!==PID) throw new Error('이 장치의 MONO DECK 매핑 백업이 아닙니다.');
    validateReports(backup.reports); if(checksum(backup.reports)!==backup.sha256) throw new Error('백업 무결성 검사 실패');
    return this.exclusive(async h=>{
      if(backup.device.serial!==this.status.serial) throw new Error('백업의 장치 일련번호가 다릅니다.');
      const current=await this.read(h); const safetyPath=this.saveBackup(current);
      const restored=backup.reports.filter(r=>layers.includes(r[3])); await this.commit(h,restored);
      const after=await this.read(h); this.updateMap(after);
      const unchanged=current.filter(r=>!layers.includes(r[3])).every(r=>JSON.stringify(r)===JSON.stringify(after.find(a=>a[3]===r[3]&&a[2]===r[2])));
      if(!unchanged || !restored.every(r=>JSON.stringify(r)===JSON.stringify(after.find(a=>a[3]===r[3]&&a[2]===r[2])))) throw new Error(`복원 후 읽기 검증 실패. 이전 매핑 백업: ${safetyPath}`);
      return {ok:true,path:safetyPath,layers,message:`${layers.join(', ')}번 레이어의 키·노브 매핑을 복원하고 검증했습니다.`};
    });
  }
}
module.exports={Keyboard,packet,mappingPacket,lightingPacket,lightingModes,lightingColors,controls,fingerprint,validateLayers,validateReports,checksum};
