/* Safe text and media representations shared by history, evidence and context. */
(function () {
  'use strict';
  const labels={image:'图片',video:'视频',sticker:'表情包',face:'QQ 表情',custom_face:'收藏表情',mface:'表情包',record:'语音',audio:'语音',file:'文件',forward:'合并转发',json:'卡片消息',xml:'卡片消息',music:'音乐分享',poke:'戳一戳',unsupported:'非文本消息'};
  const aliases={at:'mention'};
  const paths={image:'M3 4h18v16H3z M3 16l6-6 4 4 3-3 5 5 M16 8h.01',video:'M3 5h13v14H3z M16 10l5-3v10l-5-3',face:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M8 14c2 3 6 3 8 0 M8 9h.01 M16 9h.01',file:'M6 3h8l4 4v14H6z M14 3v5h5 M9 12h6 M9 16h6'};
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;};
  function describe(item) {
    item=item||{};let text=typeof item.text==='string'?item.text:'';
    const attachments=Array.isArray(item.attachments)?item.attachments.filter(a=>a&&typeof a==='object'):[];
    const originalText=!!text.trim();
    let parts=Array.isArray(item.segments)&&item.segments.length?item.segments:Array.isArray(item.content_parts)?item.content_parts:[];
    const ui=Array.isArray(item.ui_content_parts)?item.ui_content_parts:[];
    if(ui.length){const covered=new Set();parts=parts.map((part,index)=>{const match=ui.find(u=>u.ordinal===(part.ordinal??index));if(match){covered.add(match.ordinal);return match;}return part;});parts=parts.concat(ui.filter(u=>!covered.has(u.ordinal)));}
    // CQ is interpreted only as a media type/number. Private URLs are never rendered.
    const cq=[];text=text.replace(/\[CQ:([a-z_]+)(?:,([^\]]*))?\]/gi,(_,kind,data)=>{const id=(data||'').match(/(?:^|,)id=(\d{1,10})(?:,|$)/);cq.push({type:kind,data:id?{id:id[1]}:{}});return '';});
    if(!parts.length)parts=cq;
    const media=attachments.map(a=>{const hint=ui.find(p=>Number.isInteger(a.ordinal)&&p.ordinal===a.ordinal);return {kind:hint&&labels[hint.kind]?hint.kind:labels[a.kind]?a.kind:'unsupported',attachment:a,name:a.file_name||''};});
    parts.forEach((part,index)=>{
      if(!part||typeof part!=='object')return;const kind=aliases[part.type||part.kind]||part.type||part.kind,data=part.data||{};
      if(kind==='text'){if(!originalText)text+=typeof part.text==='string'?part.text:typeof data.text==='string'?data.text:'';return;}
      if(kind==='reply')return;
      if(kind==='mention'){const target=part.mention?.kind==='all'?'所有人':part.mention?.user_id||data.qq; if(target)media.push({kind:'mention',name:target==='all'?'@所有人':'@'+String(target).slice(0,128)});return;}
      if(attachments.some(a=>Number.isInteger(a.ordinal)&&a.ordinal===(part.ordinal??index)))return;
      // Some local messages omit ordinals. Avoid repeating the same image/video label.
      if(['image','video'].includes(kind)&&media.some(m=>m.attachment&&m.kind===kind))return;
      const value={kind:labels[kind]?kind:'unsupported',name:''};
      if(value.kind==='face'&&/^[0-9]{1,10}$/.test(String(data.id??part.id??'')))value.name='编号 '+String(data.id??part.id);
      if(value.kind==='file')value.name=typeof data.name==='string'?data.name.slice(0,255):typeof part.file_name==='string'?part.file_name.slice(0,255):typeof part.name==='string'?part.name.slice(0,255):'';
      if(value.kind==='unsupported'&&media.some(m=>m.attachment)&&parts.length<=attachments.length)return;
      media.push(value);
    });
    if(!text.trim()&&!media.length)media.push({kind:labels[item.content_kind]?item.content_kind:'unsupported',name:''});
    return {text,media};
  }
  function renderCard(value,target) {
    const kind=value.kind||'unsupported',a=value.attachment,card=node('div',undefined,'mc-media-card'),icon=node('span',undefined,'mc-media-icon');
    const iconKind=['face','sticker','custom_face','mface'].includes(kind)?'face':kind==='video'?'video':kind==='image'?'image':'file';
    icon.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[iconKind]+'"/></svg>';
    const copy=node('div',undefined,'mc-media-copy');copy.append(node('strong',kind==='mention'?value.name:labels[kind]||labels.unsupported));if(value.name&&kind!=='mention')copy.append(node('span',value.name,'mc-media-filename'));
    if(kind!=='mention'){
      const explanation=a?({cached:'已缓存，可在这里查看',pending:'正在等待缓存；也可在 QQ 中查看',failed:'缓存失败，请在 QQ 中查看',expired:'缓存已过期，请在 QQ 中查看',unavailable:'仅保存了附件记录，请在 QQ 中查看'})[a.state]||'未缓存内容，请在 QQ 中查看':kind==='face'?'QQ 系统表情；当前记录未保存图像':kind==='unsupported'?'图片、视频或表情等内容未保留具体类型，请在 QQ 中查看':'未缓存内容，请在 QQ 中查看';
      copy.append(node('small',explanation));
    }
    card.append(icon,copy);target.append(card);
    if(a?.state==='cached'&&typeof a.attachment_id==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(a.attachment_id)&&['image','video'].includes(a.kind)){
      const action=node('button',kind==='video'?'播放':'查看','mc-quiet');action.type='button';card.append(action);
      action.addEventListener('click',()=>{
        let media=card.querySelector('img,video');if(media){media.hidden=!media.hidden;if(media.hidden&&kind==='video')media.pause();action.textContent=media.hidden?(kind==='video'?'播放':'查看'):'收起';return;}
        media=node(kind==='video'?'video':'img',undefined,'mc-media-preview');media.src=new URL('/plugins/message-reading/messages/attachments/'+encodeURIComponent(a.attachment_id)+'/content',window.location.href).href;
        if(kind==='video'){media.controls=true;media.preload='metadata';}else media.alt=value.name||'消息图片';
        media.onerror=()=>{media.replaceWith(node('p','内容已过期、权限已撤销或缓存不可访问，请在 QQ 中查看。','mc-media-error'));action.disabled=true;};
        card.append(media);action.textContent='收起';
      });
    }
    return card;
  }
  function render(item,target) {const value=describe(item);if(value.text.trim())target.append(node('p',value.text,'mc-message-text'));value.media.forEach(m=>renderCard(m,target));}
  window.LkaMessageContent={describe,render,renderAttachment:(attachment,target)=>renderCard({kind:attachment.kind,attachment,name:attachment.file_name||''},target)};
}());
