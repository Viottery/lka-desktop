'use strict';
// Run the actual gesture code with a deterministic animation clock and no services.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const listeners = new Map(), frames = [], classes = new Set(['quick-mode']);
const body = { classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) } };
const listen = prefix => (name, callback) => listeners.set(prefix + name, callback);
const list = {scrollTop:200, scrollHeight:1000, clientHeight:200, addEventListener:listen('list:')};
const context = {
 document:{body, documentElement:{style:{}}, getElementById:()=>list},
 location:{search:'?mode=quick&layout=bubble'}, URLSearchParams,
 window:{addEventListener:listen('window:'), getSelection:()=>({removeAllRanges(){}})},
 requestAnimationFrame:callback=>(frames.push(callback),frames.length),
 setTimeout:()=>1,clearTimeout(){},performance:{now:()=>16}
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/web/pet/quick-bubble.js'),'utf8'),context);
function dispatch(scope,name,event){const listener=listeners.get(scope+':'+name);if(listener)listener(event);}
function settle(){let count=0;while(frames.length){assert(count++<200,'scroll settles');frames.shift()();}}
assert(classes.has('quick-bubble'));
const pointer={button:0,pointerId:1,clientY:180,target:{closest:()=>null},preventDefault(){}};
dispatch('list','pointerdown',pointer);
dispatch('window','pointermove',{...pointer,clientY:30});
dispatch('window','pointerup',pointer);settle();
assert.equal(list.scrollTop,200,'dragging never scrolls history or adds momentum');
assert(!classes.has('bubble-dragging'));
let prevented=false;
dispatch('list','wheel',{ctrlKey:false,deltaMode:0,deltaY:120,preventDefault(){prevented=true;}});settle();
assert(prevented);assert.equal(list.scrollTop,320,'wheel scrolls history');
dispatch('list','wheel',{ctrlKey:false,deltaMode:1,deltaY:-20,preventDefault(){}});settle();
assert.equal(list.scrollTop,0,'wheel clamps at the start');
dispatch('list','wheel',{ctrlKey:false,deltaMode:2,deltaY:10,preventDefault(){}});settle();
assert.equal(list.scrollTop,800,'page wheel units clamp at the end');
dispatch('list','wheel',{ctrlKey:true,deltaMode:0,deltaY:-120,preventDefault(){throw Error('zoom must retain default behavior');}});settle();
assert.equal(list.scrollTop,800,'Ctrl-wheel remains available for zoom');
console.log('PASS bubble history: drag has no scroll/momentum; wheel scrolls and clamps; Ctrl-wheel is preserved');
