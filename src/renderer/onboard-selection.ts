import type {Action,OnboardEntry} from './types';
export const onboardControls=[...Array.from({length:15},(_,i)=>`key${i+1}`),...[1,2,3].flatMap(n=>['ccw','press','cw'].map(direction=>`knob${n}.${direction}`))];
export function selectOnboardEntries(bindings:Record<string,Action>,targetLayer:number,scope:'key'|'layer',control:string,excluded:string[]=[]):OnboardEntry[]{
  if(![1,2,3].includes(targetLayer))throw new Error('대상 기기 레이어는 1~3입니다.');
  const selected=scope==='key'?[control]:onboardControls.filter(id=>bindings[id]&&bindings[id].type!=='none'&&!excluded.includes(id));
  return selected.map(id=>({layer:targetLayer,control:id,action:bindings[id]||{type:'none',label:''}}));
}
