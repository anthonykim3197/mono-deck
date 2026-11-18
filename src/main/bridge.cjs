const {spawn}=require('node:child_process');
const {EventEmitter}=require('node:events');
const readline=require('node:readline');
class Bridge extends EventEmitter{
  constructor(executable){super();this.executable=executable;this.pending=new Map();this.serial=0;this.ready=false;this.disconnected=true;this.stopping=false;}
  rejectPending(error){for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();}
  disconnect(child,error){
    if(child!==this.child||this.disconnected)return;
    this.ready=false;this.disconnected=true;
    this.rejectPending(error||new Error('입력 서비스가 종료되었습니다.'));
    this.emit('disconnected');
  }
  start(){
    if(this.child&&!this.disconnected)return;
    this.ready=false;this.disconnected=false;this.stopping=false;
    const child=this.child=spawn(this.executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const reader=readline.createInterface({input:child.stdout});
    reader.on('line',line=>{
      if(child!==this.child||this.disconnected)return;
      try{const message=JSON.parse(line);if(message.type==='ready'){if(!this.stopping){this.ready=true;this.emit('ready',message);}}
        else if(message.type==='response'){const request=this.pending.get(message.id);if(request){clearTimeout(request.timer);this.pending.delete(message.id);message.ok?request.resolve(message.data):request.reject(new Error(message.error||'Native command failed'));}}
        else this.emit('message',message);
      }catch(e){this.emit('diagnostic',e.message);}
    });
    child.stderr.on('data',data=>this.emit('diagnostic',String(data)));
    // A callback on write() does not replace the stream's error listener.
    child.stdin.on('error',e=>{this.emit('diagnostic',e.message);this.disconnect(child,e);});
    child.on('error',e=>{this.emit('diagnostic',e.message);this.disconnect(child,e);});
    child.on('exit',()=>this.disconnect(child));
    child.on('close',()=>{reader.close();this.disconnect(child);});
  }
  request(command,data={}){
    const child=this.child;
    if(!this.ready||this.stopping||!child||child.stdin.destroyed||!child.stdin.writable||child.stdin.writableEnded)return Promise.reject(new Error('Windows 입력 서비스가 준비되지 않았습니다.'));
    return new Promise((resolve,reject)=>{
      const id=++this.serial;
      let line;try{line=JSON.stringify({...data,id,command})+'\n';}catch(e){reject(e);return;}
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Windows 입력 서비스 응답 시간 초과'));},5000);
      this.pending.set(id,{resolve,reject,timer});
      const failed=e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(e);}};
      try{child.stdin.write(line,failed);}catch(e){failed(e);}
    });
  }
  stop(){
    const child=this.child;
    this.ready=false;this.stopping=true;
    this.rejectPending(new Error('입력 서비스를 종료하는 중입니다.'));
    if(!child||child.killed||child.exitCode!==null||child.signalCode!==null)return;
    if(!child.stdin.destroyed&&child.stdin.writable&&!child.stdin.writableEnded){
      try{child.stdin.end(JSON.stringify({command:'exit'})+'\n',()=>{});}catch(e){this.emit('diagnostic',e.message);}
    }
    const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null&&!child.killed)child.kill();},700);
    timer.unref();child.once('close',()=>clearTimeout(timer));
  }
}
module.exports={Bridge};
