import { useEffect, useRef } from 'react';

/** Enable only for the topmost dialog. A hardware write may explain why it cannot close yet. */
export default function useEscapeDismiss({active=true,onDismiss,blocked=false,onBlocked}:{active?:boolean;onDismiss:()=>void|Promise<void>;blocked?:boolean;onBlocked?:()=>void}) {
  const latest=useRef({onDismiss,blocked,onBlocked});latest.current={onDismiss,blocked,onBlocked};
  useEffect(()=>{
    if(!active)return;
    const handle=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||event.defaultPrevented||event.isComposing||event.keyCode===229||event.ctrlKey||event.altKey||event.metaKey)return;
      event.preventDefault();event.stopPropagation();
      if(latest.current.blocked){latest.current.onBlocked?.();return;}
      void latest.current.onDismiss();
    };
    window.addEventListener('keydown',handle);
    return()=>window.removeEventListener('keydown',handle);
  },[active]);
}
