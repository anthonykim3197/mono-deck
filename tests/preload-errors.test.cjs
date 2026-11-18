const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
test('IPC errors retain actionable messages without Electron remote-method wrappers',async()=>{
  let api,message;
  const electron={contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}},ipcRenderer:{invoke:async()=>{throw new Error(message);}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/main/preload.cjs'),'utf8'),{require:()=>electron});
  for(const value of ["Error invoking remote method 'deck:deleteProfile': Error: 연결 설정이 변경되었습니다.","Error invoking remote method 'deck:deleteProfile': 연결 설정이 변경되었습니다.",'연결 설정이 변경되었습니다.']){
    message=value;await assert.rejects(api.deleteProfile('b','hash'),error=>error.message==='연결 설정이 변경되었습니다.');
  }
});
