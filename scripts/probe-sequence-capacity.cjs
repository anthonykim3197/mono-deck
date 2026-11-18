// Explicit bench experiment, outside the production 18-chord compiler.
// Reads/backups all slots, changes one slot, restores it after every sample.
const fs=require('node:fs');
const path=require('node:path');
const {Keyboard,packet,checksum}=require('../src/main/protocol.cjs');
const out=path.resolve('.local/evidence/sequence-capacity.json');
const evidence={startedAt:new Date().toISOString(),scope:'readback only; no physical key execution',samples:[]};
const save=()=>fs.writeFileSync(out,JSON.stringify(evidence,null,2));
const keyboard=new Keyboard(path.resolve('.local/backups'));
(async()=>{
  await keyboard.exclusive(async h=>{
    const before=await keyboard.read(h);
    evidence.backup=keyboard.saveBackup(before);evidence.beforeHash=checksum(before);save();
    const original=before.find(r=>r[3]===1&&r[2]===15);
    for(let count=18;count<=27;count++){
      const report=packet([3,0xfe,15,1,1,0,0,0,0,0,count]);
      // Distinct non-modifier letters, then a digit. Never control shortcuts.
      for(let i=0;i<count;i++){report[11+2*i]=0;report[12+2*i]=i<26?4+i:30;}
      const sample={count};evidence.samples.push(sample);save();
      try{
        await keyboard.commit(h,[report]);
        const after=await keyboard.read(h),observed=after.find(r=>r[3]===1&&r[2]===15);
        sample.sent=[...report];sample.observed=observed;
        sample.exact=Buffer.from(observed).subarray(2).equals(report.subarray(2));
        sample.otherSlotsUnchanged=before.filter(r=>r!==original).every(r=>JSON.stringify(r)===JSON.stringify(after.find(a=>a[3]===r[3]&&a[2]===r[2])));
      }finally{
        // Restore changed records too if firmware unexpectedly touched neighbors.
        const current=await keyboard.read(h);
        const changed=before.filter(r=>JSON.stringify(r)!==JSON.stringify(current.find(a=>a[3]===r[3]&&a[2]===r[2])));
        if(changed.length)await keyboard.commit(h,changed);
        sample.restored=checksum(await keyboard.read(h))===evidence.beforeHash;
        save();
      }
      console.log(JSON.stringify({count,exact:sample.exact,otherSlotsUnchanged:sample.otherSlotsUnchanged,restored:sample.restored}));
      if(!sample.restored)throw new Error('Restoration mismatch: '+evidence.backup);
      if(!sample.exact||!sample.otherSlotsUnchanged)break;
    }
    evidence.finalHash=checksum(await keyboard.read(h));
  });
  evidence.finishedAt=new Date().toISOString();save();
})().catch(e=>{evidence.error=e.stack;save();console.error(e);process.exitCode=1;});
