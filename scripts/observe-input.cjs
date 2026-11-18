// Bounded, target-device-only diagnostic capture. Never records the main keyboard.
const {Bridge}=require('../src/main/bridge.cjs');
const path=require('node:path');
const b=new Bridge(path.resolve('native/bin/MacroBridge.exe'));
b.on('ready',()=>console.log('READY: press A73T controls on layer 3'));
b.on('diagnostic',m=>console.error(m));
b.on('message',e=>{if(e.type==='input')console.log(JSON.stringify({time:e.timestamp,code:e.code,modifiers:e.modifiers,fingerprint:e.fingerprint}));});
b.start();setTimeout(()=>{b.stop();},180000);
