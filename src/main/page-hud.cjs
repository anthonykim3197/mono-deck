const {BrowserWindow,screen}=require('electron');
const path=require('node:path');
let window,timer,latest;
function hide(){clearTimeout(timer);if(window&&!window.isDestroyed())window.hide();}
function show(state){
  latest=state;clearTimeout(timer);
  if(!window||window.isDestroyed()){
    window=new BrowserWindow({width:400,height:130,show:false,frame:false,resizable:false,movable:false,focusable:false,skipTaskbar:true,alwaysOnTop:true,backgroundColor:'#171c16',webPreferences:{preload:path.join(__dirname,'page-hud-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    window.setIgnoreMouseEvents(true);
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',e=>e.preventDefault());
    window.webContents.on('did-finish-load',()=>window.webContents.send('page-state',latest));
    window.loadFile(path.join(__dirname,'page-hud.html'));
  }
  const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  window.setPosition(area.x+area.width-420,area.y+24);
  window.webContents.send('page-state',state);window.showInactive();
  if(!state.transition)timer=setTimeout(hide,state.candidateId||state.kind==='obs'?8000:2200);
}
module.exports={show,hide};
