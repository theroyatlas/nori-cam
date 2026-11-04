// All engine randomness flows through this module. FNV-1a + mulberry32.
export function hash(...parts:(string|number)[]):number {
  let h=2166136261;
  for(const c of JSON.stringify(parts)){
    h^=c.charCodeAt(0);
    h=Math.imul(h,16777619);
  }
  return h>>>0;
}
export function rng(seed:number):()=>number {
  let a=seed>>>0;
  return ()=>{
    a=(a+0x6D2B79F5)>>>0;
    let t=a;
    t=Math.imul(t^(t>>>15),t|1);
    t^=t+Math.imul(t^(t>>>7),t|61);
    return ((t^(t>>>14))>>>0)/4294967296;
  };
}
export function random(...parts:(string|number)[]):number{
  return rng(hash(...parts))();
}
