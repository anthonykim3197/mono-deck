export type DialFeedback = { angle: number; motion: 'cw'|'ccw'|'press'|null; serial: number };
export type DialFeedbackMap = Record<string, DialFeedback>;
export function advanceDialFeedback(previous:DialFeedbackMap,control:string):DialFeedbackMap {
  const match=/^knob([1-3])\.(cw|ccw|press)$/.exec(control);
  if(!match)return previous;
  const id=match[1],motion=match[2] as NonNullable<DialFeedback['motion']>;
  const old=previous[id]||{angle:0,motion:null,serial:0};
  // Keep the angle unwrapped: 360 -> 378 must never animate backwards to 18.
  return {...previous,[id]:{angle:old.angle+(motion==='cw'?18:motion==='ccw'?-18:0),motion,serial:old.serial+1}};
}
export function settleDialFeedback(previous:DialFeedbackMap,id:string,serial:number):DialFeedbackMap {
  const old=previous[id];
  return !old||old.serial!==serial?previous:{...previous,[id]:{...old,motion:null}};
}
