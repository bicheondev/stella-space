const epoch=1288834974657n;
export function postCreatedAt(post){
 // X Snowflakes carry the server-side creation timestamp in milliseconds.
 if(/^\d{15,20}$/.test(String(post?.id||''))){const ms=Number((BigInt(post.id)>>22n)+epoch);if(Number.isSafeInteger(ms)&&ms>0)return ms;}
 const fallback=Number(post?.created_timestamp)*1000;return Number.isFinite(fallback)&&fallback>0?fallback:null;
}
export function kstTimestamp(ms){if(!Number.isFinite(ms)||ms<=0)return '확인되지 않음';return new Date(ms+9*3600000).toISOString().slice(0,19).replace('T',' ')+' KST';}
export function observePostTiming(post,{source,observedAt,pushReceivedAt=null}){
 const postedAt=postCreatedAt(post),pushDetectedAt=source==='push-inbox'?observedAt:null;
 return{source,postedAt,observedAt,pushDetectedAt,pushReceivedAt:source==='push-inbox'?pushReceivedAt:null,postedAtKst:kstTimestamp(postedAt),detectedAtKst:kstTimestamp(observedAt),...(postedAt&&Number.isFinite(observedAt)?{durationMs:observedAt-postedAt}:{})};
}
export function timingLines(timing={}){
 return '게시물 작성: '+kstTimestamp(timing.postedAt)+'\n'+(timing.source==='push-inbox'?'푸시 경로 감지: '+kstTimestamp(timing.observedAt):timing.source==='fallback-inbox'?'정기 알림함 감지: '+kstTimestamp(timing.observedAt):'푸시 경로 감지: 확인되지 않음');
}
