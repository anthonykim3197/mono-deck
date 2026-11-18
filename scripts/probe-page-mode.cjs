// Explicit hardware bench only; never imported by the app.
// observe: passive vendor/consumer reports + device-scoped Raw Input, with known FB queries.
// bench: reversible whole-layer writes, exact all-72-record validation and restoration.
const fs=require('node:fs');
const path=require('node:path');
const HID=require('node-hid');
const {Keyboard,packet,mappingPacket,checksum}=require('../src/main/protocol.cjs');
const {planOnboard}=require('../src/main/onboard.cjs');
const {Bridge}=require('../src/main/bridge.cjs');
const mode=process.argv[2];
if(!['observe','bench'].includes(mode))throw new Error('Usage: node scripts/probe-page-mode.cjs observe|bench');
const dir=path.resolve('.local/evidence');fs.mkdirSync(dir,{recursive:true});
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const out=path.join(dir,`page-mode-${mode}-${stamp}.json`);
const control=path.resolve('.local/page-mode-probe-control.json');
const evidence={mode,startedAt:new Date().toISOString(),coverage:'PID8840; readable key mappings only, no RGB/timing/power-cycle proof',stages:[]};
const save=()=>fs.writeFileSync(out,JSON.stringify(evidence,null,2));
const keyboard=new Keyboard(path.resolve('.local/backups'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const payloadEqual=(a,b)=>Buffer.from(a).subarray(2).equals(Buffer.from(b).subarray(2));

async function observe(){
  const logPath=out.replace(/\.json$/,'.ndjson');evidence.logPath=logPath;
  const record=(kind,data)=>fs.appendFileSync(logPath,JSON.stringify({at:new Date().toISOString(),kind,...data})+'\n');
  const bridge=new Bridge(path.resolve('native/bin/MacroBridge.exe'));
  bridge.on('message',message=>record('raw-input',message));
  bridge.on('diagnostic',message=>record('bridge-diagnostic',{message}));
  let consumer;
  await keyboard.exclusive(async handle=>{
    const before=await keyboard.read(handle);
    evidence.backup=keyboard.saveBackup(before);evidence.beforeHash=checksum(before);save();
    try{
      bridge.start();
      for(let i=0;!bridge.ready&&i<100;i++)await pause(50);
      if(!bridge.ready)throw new Error('Target keyboard Raw Input monitor failed to start');
      const consumerDevice=(await HID.devicesAsync(0x1189,0x8840)).find(d=>d.usagePage===12&&d.usage===1);
      if(consumerDevice){
        try{consumer=await HID.HIDAsync.open(consumerDevice.path);consumer.on('data',data=>record('consumer-report',{bytes:[...data]}));consumer.on('error',error=>record('consumer-error',{message:error.message}));evidence.consumerMonitoring=true;}
        catch(error){evidence.consumerMonitoring=false;evidence.consumerError=error.message;}
      }
      fs.writeFileSync(control,JSON.stringify({command:'observe'}));
      evidence.observationStartedAt=new Date().toISOString();save();
      console.log(JSON.stringify({ready:true,out,control,consumerMonitoring:evidence.consumerMonitoring}));
      let nextQuery=0,lastMark='';const deadline=Date.now()+15*60*1000;
      while(Date.now()<deadline){
        const command=JSON.parse(fs.readFileSync(control,'utf8'));
        if(command.mark&&command.mark!==lastMark){lastMark=command.mark;record('operator-mark',{mark:lastMark});}
        if(command.command==='stop')break;
        if(Date.now()>=nextQuery){
          const bytes=packet([3,0xfb,0xfb,0xfb]);
          if(await handle.write(bytes)!==65)throw new Error('Incomplete FB query');
          record('identity-query',{});nextQuery=Date.now()+1000;
        }
        const data=await handle.read(200);
        if(data?.length)record('vendor-report',{bytes:[...data]});
      }
      evidence.observationFinishedAt=new Date().toISOString();
      evidence.finalHash=checksum(await keyboard.read(handle));
      evidence.mappingsUnchanged=evidence.finalHash===evidence.beforeHash;
      if(!evidence.mappingsUnchanged)throw new Error('Mappings changed during read-only observation');
    }finally{
      bridge.stop();if(consumer)await consumer.close();
    }
  });
  const events=fs.readFileSync(logPath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  evidence.summary={identityQueries:events.filter(e=>e.kind==='identity-query').length,identityResponses:events.filter(e=>e.kind==='vendor-report'&&e.bytes[0]===3&&e.bytes[1]===0xfb).length,
    distinctIdentityResponses:[...new Set(events.filter(e=>e.kind==='vendor-report'&&e.bytes[0]===3&&e.bytes[1]===0xfb).map(e=>Buffer.from(e.bytes).toString('hex')))],
    otherVendorReports:events.filter(e=>e.kind==='vendor-report'&&e.bytes[1]!==0xfb),consumerReports:events.filter(e=>e.kind==='consumer-report'),rawInputEvents:events.filter(e=>e.kind==='raw-input'),marks:events.filter(e=>e.kind==='operator-mark')};
}

async function bench(){
  const layer=3;
  const physical=process.argv.includes('--physical');
  const bridge=physical?new Bridge(path.resolve('native/bin/MacroBridge.exe')):null;
  let waitingStage=null;
  bridge?.on('message',message=>{if(waitingStage&&message.type==='input'){waitingStage.inputs.push(message);save();console.log(JSON.stringify({physicalInput:message.fingerprint,stage:waitingStage.name}));}});
  try{
  if(bridge){bridge.start();for(let i=0;!bridge.ready&&i<100;i++)await pause(50);if(!bridge.ready)throw new Error('Bench input monitor not ready');}
  await keyboard.exclusive(async handle=>{
    const before=await keyboard.read(handle);
    evidence.layer=layer;evidence.backup=keyboard.saveBackup(before);evidence.beforeHash=checksum(before);save();
    const onboard=planOnboard(Array.from({length:24},(_,i)=>({layer,control:require('../src/main/protocol.cjs').controls[i],action:i===0?{type:'shortcut',keys:['CTRL','C']}:{type:'none'}})));
    if(!onboard.ok)throw new Error('Bench compilation failed');
    const app=Array.from({length:24},(_,i)=>[...mappingPacket(i+1,layer)]);
    try{
      for(const [name,reports] of [['onboard-zero',onboard.entries.map(e=>e.report)],['pc-trigger',app],['onboard-zero-again',onboard.entries.map(e=>e.report)]]){
        const stage={name,startedAt:new Date().toISOString(),count:reports.length};evidence.stages.push(stage);save();
        const start=performance.now();await keyboard.commit(handle,reports);stage.writeMs=Math.round(performance.now()-start);
        const after=await keyboard.read(handle);stage.writeAndVerifyMs=Math.round(performance.now()-start);
        stage.selectedExact=reports.every(r=>payloadEqual(r,after.find(a=>a[3]===r[3]&&a[2]===r[2])));
        stage.otherLayersUnchanged=before.filter(r=>r[3]!==layer).every(r=>JSON.stringify(r)===JSON.stringify(after.find(a=>a[3]===r[3]&&a[2]===r[2])));
        stage.key1=after.find(r=>r[3]===layer&&r[2]===1);save();console.log(JSON.stringify(stage));
        if(!stage.selectedExact||!stage.otherLayersUnchanged)throw new Error('Mode change readback mismatch');
        if(physical){
          stage.expectedInput=name==='pc-trigger'?'F13':'CTRL+C';stage.inputs=[];waitingStage=stage;
          fs.writeFileSync(control,JSON.stringify({command:'wait',stage:name}));save();
          console.log(JSON.stringify({waitingForPhysicalKey:true,stage:name,expected:stage.expectedInput,out,deadlineSeconds:180}));
          const deadline=Date.now()+180000;
          while(Date.now()<deadline){
            const command=JSON.parse(fs.readFileSync(control,'utf8'));
            if(command.command==='abort')throw new Error('Operator aborted; restoring original mappings');
            if(command.command==='advance'&&command.stage===name){
              stage.physicalInputVerified=stage.inputs.some(e=>e.fingerprint===stage.expectedInput);
              if(!stage.physicalInputVerified)throw new Error('Expected physical input was not observed');
              stage.operatorConfirmedAt=new Date().toISOString();break;
            }
            await pause(100);
          }
          waitingStage=null;save();
          if(!stage.physicalInputVerified)throw new Error('Physical test timeout; restoring original mappings');
        }
      }
    }finally{
      // Restore every changed record, including unexpected changes outside the test layer.
      const current=await keyboard.read(handle);
      const changed=before.filter(r=>JSON.stringify(r)!==JSON.stringify(current.find(a=>a[3]===r[3]&&a[2]===r[2])));
      evidence.restoreCount=changed.length;save();
      const start=performance.now();if(changed.length)await keyboard.commit(handle,changed);
      evidence.finalHash=checksum(await keyboard.read(handle));evidence.restoreAndVerifyMs=Math.round(performance.now()-start);
      evidence.restored=evidence.finalHash===evidence.beforeHash;save();
      if(!evidence.restored)throw new Error('Restore mismatch; recovery backup: '+evidence.backup);
    }
  });
  }finally{waitingStage=null;bridge?.stop();}
}

(async()=>{try{await (mode==='observe'?observe():bench());}catch(error){evidence.error=error.stack;process.exitCode=1;}finally{evidence.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({out,...evidence}));}})();
